# ADR-0051 — Metering & billing: meter at the gateway, bill through a provider-agnostic adapter

- **Status**: Accepted
- **Date**: 2026-08-01
- **Relates to**: ADR-0019 (per-user revocation + full attribution, the one usage ledger),
  ADR-0024 (metering is unconditional; attribution decides where the row lands), ADR-0041
  (BYOC / air-gapped as the primary motion), ADR-0052 (licensing & seats — the seat count this
  ADR bills against), the standing **provider-agnostic** principle in CLAUDE.md
- **Anchors (already built)**: every governed agent/model, connector, and MCP tool call already
  writes a **measured** row to `usage_events` (real token/call counts) and an **estimated** row to
  `cost_events` (provider list price) at the point of the call (pillars 5/6). This ADR does not
  add metering — it decides how that existing ledger becomes money.

## Context

RegulAIt already meters. ADR-0019 and ADR-0024 established that the gateway's policy-evaluation
step emits, as a mandatory side effect, a `usage_events` row (measured: the real token or call
counts the provider reported) and a `cost_events` row (estimated: provider list price applied to
those counts). Coverage is total — every gateway call is metered; attribution only decides whether
the row lands on a project or in the visible **Unattributed** bucket.

What does **not** exist is the commercial half: turning that ledger into invoices a customer pays,
and into chargeback/showback exports a customer's finance team can allocate internally. Today the
data stops at the cost dashboard. There is no billing system integration, no invoice, no
seat-based line, no reconciliation against what the model providers actually charged us.

Three forces shape the decision:

1. **We must not re-instrument.** The gateway ledger is the single point where cost is captured
   accurately, at the moment of the call. Any billing path that reconstructs usage from a second
   source (provider invoices, log scraping) reintroduces exactly the attribution inaccuracy pillar
   5 exists to eliminate. The meter of record already exists; billing must read from it.

2. **We must not hard-lock a billing vendor.** CLAUDE.md's standing principle is that RegulAIt
   never hard-locks one vendor at any layer — model, cloud, git-provider, PM-tool. A billing
   backend is another such layer. Metronome, Orb, and Stripe Billing are interchangeable
   usage-metering/invoicing backends; enterprise buyers frequently already run one. Wiring the
   ledger straight into the Stripe SDK would repeat the mistake ADR-0034 called out for model
   providers (a closed enum with no door) one layer up in the commercial stack.

3. **We must be honest about accuracy.** `usage_events` is measured and authoritative — those are
   the real counts. `cost_events` is an **estimate** (list price), and list price is not what a
   customer with a negotiated provider contract, or a self-hosted/unpriced model (ADR-0034 leaves
   `costUsd` null on purpose), actually owes. A billing system that presents estimated cost as an
   invoice total is quietly wrong. The split has to survive into billing, not be flattened away.

## Decision

**Meter at the gateway (already done); export the existing ledger to a billing system through a
provider-agnostic `BillingProvider` adapter, supporting usage-based and seat-based pricing, with
estimated and reconciled rating modes kept explicitly distinct.**

### 1. The gateway ledger is the meter of record; billing is a read-side consumer

Billing never instruments a dispatch. It reads `usage_events` (measured) and `cost_events`
(estimated), the same rows the cost dashboard reads. A new `billing_exports` ledger records what
was shipped to the billing backend and when, so an export is idempotent and re-runnable and a
double-bill is structurally impossible (each `usage_events` row is exported at most once per
billing period, keyed by row id).

### 2. `BillingProvider` — the provider-agnostic adapter (the load-bearing choice)

A `packages/billing-provider` package mirrors `packages/model-provider` and the PM/git adapter
pattern exactly: one interface, interchangeable backends, no backend named anywhere above the
adapter boundary.

```
interface BillingProvider {
  pushUsage(events: MeteredUsage[]): Promise<PushResult>   // usage-based
  syncSeats(tenant, seatCount, tier): Promise<void>        // seat-based (ADR-0052)
  fetchInvoice(period): Promise<Invoice | null>            // read back for display
  capabilities(): BillingCapabilities                      // not every backend does everything
}
```

Backends: `MetronomeBilling`, `OrbBilling`, `StripeBilling`, plus a `NoopBilling` (export to
CSV/API only, no external billing system — the BYOC/air-gap default, §6). Which backend is active
is an admin-configured org setting, exactly like the active model provider or PM adapter. **Stripe
is one option, not the substrate.** `capabilities()` exists because the backends genuinely differ
(Metronome and Orb are usage-native; Stripe Billing needs usage pushed onto metered
subscription items) — the adapter reports what it can do rather than the core assuming a shape.

### 3. Usage-based AND seat-based, from two different sources

- **Usage-based** rates the measured `usage_events` for the period and pushes them to the backend.
  Rating uses a `rate_cards` table (per model/agent, per connector, per MCP tool) so the *billed*
  rate is a commercial decision independent of the *estimated* provider list price in
  `cost_events` — a customer's negotiated markup lives here, not in the metering path.
- **Seat-based** bills a flat per-seat charge from the entitled-user count, which is the licensed
  seat cap and active-user count owned by ADR-0052. `syncSeats` pushes that count; the two models
  compose (a plan can be seats + usage overage).

### 4. Invoicing, chargeback, and showback are separate outputs

- **Invoicing** (money out, to the customer) is delegated to the backend via `fetchInvoice`; we
  render it, the backend is system-of-record for the dunning/payment lifecycle. We do not build a
  payments stack.
- **Chargeback/showback** (internal allocation, no external money) reuses pillar 5's existing
  cost-export surface (§10.3, JSON/CSV by project/team/cost-center) — it needs no billing backend
  at all and works in `NoopBilling`. This is the common enterprise ask and must not require
  standing up Stripe.

### 5. Estimated vs reconciled — the honesty rung, kept in the schema

Every billed amount carries a `rating_mode ∈ {estimated, reconciled}`:

- **estimated** — rated from `cost_events` list price (or the rate card). Available day one, for
  every priced model. Labeled as an estimate wherever shown. Unpriced/self-hosted models
  (ADR-0034, `costUsd: null`) contribute **measured usage with no estimated cost** — they can be
  billed on a rate card (per-token markup we set) but never on a fabricated provider price.
- **reconciled** — the estimate is replaced by actuals imported from the provider's own invoice
  (an optional per-provider reconciliation import), for enterprises that require billing-grade
  accuracy. This is opt-in and per-provider; absent it, billing stays honestly estimated.

The dashboard and any invoice preview state which mode a line is in. We never present an estimate
as a reconciled actual.

### 6. BYOC / air-gapped: meter locally, export on sync

In BYOC and air-gapped deployments (ADR-0041, the primary motion) the ledger is written inside the
customer's boundary and there may be no outbound path to a hosted billing backend. `NoopBilling`
is the default there: usage is metered and buffered locally exactly as audit events are (§8.5), and
billing is settled by an **exported, signed usage statement** the customer transmits on their own
schedule — the same offline-first posture ADR-0052's license file assumes. No raw prompt/document
content ever rides a billing export; only the measured counts and their attribution tags, matching
the §8.4 data-boundary disclosure.

## Consequences

### Easier

- The commercial motion is finally connected to the metering that already exists, without a second
  instrumentation pass or a FinOps bolt-on.
- Swapping Metronome ↔ Orb ↔ Stripe, or running with no external billing system at all, is an
  adapter/config change — no change to the gateway or the ledger.
- Chargeback/showback ships without a payments dependency, which is what most first deployments
  actually want.

### Harder / given up

- Rate cards are a real new surface to maintain, and getting billed-rate policy wrong is a money
  bug, not a display bug. It is deliberately kept out of the metering path so a rating error can
  never corrupt the measured ledger.
- `capabilities()` means the core must handle backends that can't do everything (e.g. a backend
  with no native usage metering), rather than assuming one rich backend. That is the cost of not
  hard-locking one.
- Reconciliation is per-provider and optional; until a customer imports actuals, their invoice is
  an honest estimate, not a guaranteed match to provider charges. Stated plainly rather than
  papered over.

### Follow-up

- The `rate_cards` and `billing_exports` schema, and the `BillingProvider` interface, are a
  migration + package this ADR specifies but does not build.
- Seat counting is owned by ADR-0052; this ADR consumes it and must not fork a second definition
  of "an active seat".
- Tax, currency, and multi-entity billing are explicitly out of scope here and belong to whichever
  billing backend is configured.

## Implementation amendment — 2026-08-02 (migration 0063)

Accepted and built. What follows is the honest record of what billing derives from, what it
refuses to claim, and what is modelled but not exercised.

### THE SCOPE SENTENCE — read this before anything else

**No payment processor is integrated. Nothing in this slice charges anyone.**

There is no Stripe, no Metronome, no Orb, and no network call of any kind on any billing path. What
shipped is **metering-derived statement generation**: a rate card, a billing period, an append-only
statement rated from the existing `usage_events` ledger, a CSV/JSON export, and a re-derivation
check. `BillingProvider` is the port §2 specifies; `NoopBilling` — export-only, §6's BYOC/air-gapped
default — is the only implementation, and `capabilities().requiresNetwork` is `false` and asserted.

`GET /v1/billing/overview` returns `paymentProcessorIntegrated: false` and the admin page renders it
as a badge, so the boundary is visible in the product rather than only in this document.

### What shipped

**Pure half — `packages/shared/src/billing.ts` (+ 23 unit tests):** the rate-card vocabulary, the
exact-beats-wildcard `rateFor`, the deterministic `rateUsage` (order-independent and stateless — the
property a re-derivation depends on, asserted directly), `seatLine`, `buildStatement`,
`reconcileStatement`, the chargeback/showback CSV round trip, and the `BillingProvider` port with
`NoopBilling`.

**Gateway half — `apps/gateway/src/billing.ts` (+ 19 integration tests):** `countActiveSeats` (the
ONE seat definition, see below), the pricing-snapshot load, `deriveStatement` over `usage_events`,
`cutStatement` (access decision → derivation → append-only version → audit), and the routes:
rate-card create/list/read, period open/list/close, statement cut/list/read/issue/reconcile/export,
and the admin overview.

**Migration 0063:** `rate_cards`, `rate_card_entries`, `billing_periods`, `billing_statements`,
`billing_exports`.

**Admin SPA:** `/admin/billing`, under **Cost & Optimization** next to the Cost dashboard and the
spend forecast — deliberately, because billing is a *read* of the cost data beside it, and a
statement that disagreed with the Cost dashboard would be the bug that placement makes obvious.

### The four structural decisions

1. **Billing is a READ-SIDE consumer of the one ledger.** Nothing was instrumented. `deriveStatement`
   SELECTs `usage_events` for the window and hands the rows to the pure rating function. There is no
   billing counter, no rollup table and nothing incremented at dispatch time, so a billing figure
   *cannot* drift from the cost dashboard or from ADR-0047's reports. `billing_statements.payload` is
   the artifact of a derivation and is never read back as an input to another computation.

2. **Materialization is defensible only because it is reproducible, and that is TESTED.** An issued
   invoice must not move when a price changes, which is a real reason to freeze a document. So a
   statement carries `pricing_snapshot` — the exact rate-card entries used, copied at cut time — plus
   `derived_through_at`, the cut instant that also closes the ledger window. `POST
   /v1/billing/statements/:id/reconcile` replays *that snapshot* over *that window* and compares. The
   test cuts, issues, then creates a rate-card version at **ten times** the price and asserts the
   issued row's money is byte-identical *and* still reconciles.

3. **Append-only, never edited (the ADR-0040/0048 precedent).** Rate cards are immutable `(name,
   version)` rows with no UPDATE path for entries. Statements are `(period_id, version)` rows; a
   re-cut appends N+1 and marks prior drafts `superseded`. Issuing is a one-way door: a second issue
   is a 409, and a DB CHECK ties `issued` to the presence of `issued_at` so "issued" is a fact rather
   than a label.

4. **Entitlement scoping is ADR-0047's function CALLED, not a third copy.** `cutStatement` resolves
   scope through ADR-0049's `resolveSpendAccess` adapter over `evaluateReportAccess`, and every
   `usage_events` query is built with `inArray(project_id, thoseIds)` at QUERY CONSTRUCTION. An
   invoice is exactly the shape in which one team's spend leaks. Additionally: a caller who can see
   only *part* of a period's scope gets a version stamped `covers_full_scope: false`, which is
   refused at issue time with `statement_partial_scope` — an understated document must never be able
   to claim to be the period's invoice.

### One definition of "an active seat"

ADR-0052 §3 owns the definition; this ADR consumes it. `countActiveSeats` in
`apps/gateway/src/billing.ts` is the single implementation and `licensing.ts` (ADR-0052) imports it
rather than counting again. It respects ADR-0022 (deactivate ≠ delete): a disabled user keeps every
FK and audit row and consumes **no** seat, because they cannot authenticate and cannot dispatch.
Billing a suspended employee would be a real overcharge.

### The estimated/reconciled split survived into the money

`usage_events.cost_usd` is provider **list price** and is `null` on purpose for self-hosted models
(ADR-0034). A rate card is a separate **commercial** number. Every statement line carries **both**
(`billedUsd` and `ledgerEstimatedUsd`) and the statement carries `ledger_estimated_cost_usd` beside
the billed total, so the two can never be mistaken for each other. A test asserts they are different
numbers, and that a `cost_usd: null` row is still measured usage billable on our own card.

**An event the rate card does not price is `UNPRICED` with a `null` amount — never zero.** A zero
would be a silent under-bill that reads on an invoice as "we used it and it was free". The count
rides the statement, the CSV and the admin page.

### Deviations from the proposal above

1. **`packages/billing-provider` was NOT created as a separate package.** The `BillingProvider`
   interface and `NoopBilling` live in `packages/shared/src/billing.ts`. §2 specifies a package
   mirroring `packages/model-provider`; a package with exactly one implementation and no second
   backend to keep honest is ceremony rather than a boundary. The *interface* is real and no backend
   name appears above it. Extracting the package is a follow-up for whenever a second backend exists.
2. **`MetronomeBilling` / `OrbBilling` / `StripeBilling` do NOT exist**, not even as stubs. Each
   would be a network client, and this slice makes no network call. They are absent rather than
   present-and-throwing.
3. **`rating_mode` is never `reconciled`.** The column, the vocabulary and the labelling are in
   place, and `reconciledRatingAvailable: false` is on the overview. §5's provider-invoice importer
   does not exist, so billing is honestly estimated and says so on every artifact.
4. **The export idempotency grain is `(period, backend)`, not `(usage_events row, backend)`.** §1
   says "each `usage_events` row is exported at most once per billing period, keyed by row id". A
   statement covers a period's row set by construction, so shipping the period once *is* shipping
   each of its rows once — the same guarantee without a table carrying one row per metered call
   forever. Enforced by a unique index, so a double-bill is structurally impossible; the second
   export is recognised and audited as `billing-statement-export-deduped`.
5. **`fetchInvoice` returns `null` always.** There is no external system of record, so there is no
   invoice to read back. Synthesising one would collapse §4's split between "money out, delegated"
   and "internal allocation, ours".
6. **Period close is an ENDPOINT, not a schedule.** There is no in-process scheduler in this codebase
   (ADRs 0044–0049 all landed the same way). `POST /v1/billing/periods/:id/close` is what an operator
   or an external cron drives; it is idempotent, and `closedAt` staying null is how a deployment that
   never wires the cron sees that. Both the API note and the admin page say so in those words.
7. **No tax, currency conversion, dunning or multi-entity billing.** Explicitly out of scope in the
   ADR; absent rather than half-present. `currency` is recorded on a rate card and never converted.
8. **A statement's period label is a date range, not a calendar name.** Periods are arbitrary
   half-open windows rather than an enum of month/quarter, so the label is derived from the window.

### What is genuinely verified vs. structural only

**Genuinely verified end to end (19 gateway integration tests over real Postgres, 23 unit tests):**

- **A statement's usage total EQUALS an independent sum of the ledger.** The test re-queries
  `usage_events` and applies the rate card *by hand in the test* — deliberately not by calling the
  shared rating function, so a bug there cannot make both sides wrong in the same direction.
- **An issued invoice does not move when pricing changes**, asserted from the DB row after a 10×
  rate-card version, including that it still reconciles.
- **Re-issue is refused (409); re-cutting appends a version and leaves the issued row untouched**,
  including its `issued_at`.
- **A non-privileged caller cannot see another team's billing**: the org period 403s, a team lead's
  view is asserted to be arithmetically smaller than the unscoped number and to contain the other
  project's id nowhere in the payload or in the persisted `effective_project_ids`, and read/export/
  reconcile of an admin org statement all 403 while the statement is absent from their list.
- **Issuing a partial-scope version is refused.**
- **Period close is idempotent** — second call reports `alreadyClosed`, returns the same statement
  id, does not move `closedAt`, and creates no second version. Opening the same period twice returns
  the existing row.
- **Export dedupe**: a second export of the same period creates no second shipment row.
- **Admin gating** on rate-card/period/close/overview, and **audit rows with stable ruleIds**:
  `billing-rate-card-created`, `billing-period-opened`, `billing-period-closed`,
  `billing-statement-cut`, `billing-statement-issued`, `billing-statement-exported`,
  `billing-statement-export-deduped`, `billing-statement-reconciled`,
  `billing-statement-reconcile-drift`, `billing-scope-denied`, `billing-statement-read-denied`,
  `billing-statement-export-denied`, `billing-statement-issue-refused-partial`.
- **Unpriced ≠ zero**, and a null-`cost_usd` self-hosted row billable on our own card.

**Structural only — the shape exists and is honest, but nothing exercises it end to end:**

- **`rating_mode: 'reconciled'`** — column, vocabulary and labelling exist; no importer writes it.
- **`mcp_tool` as a billing dimension** — it is in the vocabulary, the DDL and `billingKeyFor`, and
  a unit test covers the routing, but no gateway path writes `usage_events.object_type = 'mcp_tool'`
  today, so no real statement has ever carried an MCP line.
- **`syncSeats`** — implemented as a no-op on the only backend; the seat count reaches the statement,
  not an external system.
- **Multi-currency** — `currency` is recorded and never used in arithmetic.

### Follow-ups this slice leaves open

- A provider-invoice importer, to make `rating_mode: 'reconciled'` real per §5.
- Extracting `packages/billing-provider` once a second backend justifies the boundary.
- Emitting `usage_events` rows for MCP tool calls so the `mcp_tool` billing dimension carries data.
- Initiative-scoped periods (`scopeKind: 'initiative'` is in the DDL and resolves, but no test or UI
  path exercises it).
- Wiring the cost-center/chargeback grouping already on `projects`/`initiatives` into the statement
  lines, so a finance team gets allocation directly rather than by joining the CSV themselves.
