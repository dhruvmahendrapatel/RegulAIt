# ADR-0051 — Metering & billing: meter at the gateway, bill through a provider-agnostic adapter

- **Status**: Proposed
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
