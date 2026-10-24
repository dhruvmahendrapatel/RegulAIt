# ADR-0069: Cross-vendor cost consolidation — imported spend, restated, never blended with metered spend

- **Status**: Accepted
- **Date**: 2026-08-07
- **Migration**: 0081
- **Slice**: [COMPETITIVE_PARITY_PLAN.md](../product/COMPETITIVE_PARITY_PLAN.md) §1 Slice C
- **Parity target**: none. Session 07's research found this genuinely unserved by any incumbent.
- **Extends**: [ADR-0049](0049-cost-forecasting-anomaly.md) / [ADR-0051](0051-metering-billing.md)
  (the metered ledger), [ADR-0055](0055-shadow-ai-discovery.md) (the import idiom this reuses),
  [ADR-0042](0042-guardrail-engine.md) / [ADR-0065](0065-regulait-llm.md) (the ingest PII posture)

## Scope, stated before anything else

This slice ingests **a customer's own export of their own vendor spend, uploaded by their own
administrator**. It makes no outbound request of any kind — there is no vendor billing-API client
in this repository and no credential for one. Nothing here observes anything. It reads a file
somebody posted and writes rows.

## Context

### The gap, and why the incumbents skip it

Every AI gateway attributes the spend **that flows through it**. LiteLLM, Portkey, Helicone,
Langfuse and Cloudflare all do per-key/per-user attribution at the call, and RegulAIt has done the
same since `usage_events` landed with real model dispatch (migration 0016), with
[ADR-0051](0051-metering-billing.md) turning it into rated statements — a row for every dispatch we
intercepted, entitled and priced from a rate card.

Nobody consolidates one human's spend across a Claude Code seat + a Copilot seat + a raw OpenAI key
somebody uses outside the gateway + a Bedrock line on a cloud bill, into a single per-person figure
an FP&A team can charge back. The reason is structural and is worth naming plainly: **per-seat SaaS
spend is invoice-side, not call-side.** No amount of better metering can ever see it, because that
traffic does not pass through anyone's gateway. A gateway vendor who wanted to close this gap would
have to start restating documents it cannot verify, which is a different and much less comfortable
kind of claim than "we counted the tokens".

That discomfort is the whole design problem. It is easy to build an importer. It is easy to add the
imported number to the metered number and print a big total. It is that total that would be the
lie.

### The verified starting position

A pre-slice grep confirmed: no invoice/usage-export importer anywhere; no vendor-account →
RegulAIt-user identity resolution anywhere; and **no `metered` vs `imported` distinction anywhere in
the cost model** — every figure in the product was implicitly metered, with nothing to say so.

`projects.cost_center` (migration 0018) and `initiatives.cost_center` (migration 0029) existed, so
metered spend
already rolled up to a chargeback code through the governed unit of work. There was no
person-level equivalent, and a Copilot seat is not a project.

### The failure mode this ADR is organised around

> Import the invoice. Match the emails. Add it to metered spend. Show one number per person.

That produces a figure whose provenance nobody can reconstruct, in which an unmatched account has
silently disappeared, a malformed row has silently reduced the total, and a seat price somebody
typed in by hand is indistinguishable from a token count we measured. Every one of those is
invisible in the number and fatal in a chargeback dispute.

So the rule this ADR is built around, and the one the tests attack:

> **A consolidated figure states its split. `metered` was observed; `imported` was restated. They
> are never added, and there is no field anywhere in the API that adds them.**

## Decision

**Add an invoice/usage-export importer with a provider-agnostic adapter registry, an admin-authored
identity-resolution layer onto RegulAIt users, and a consolidated per-person / per-cost-centre view
that reports metered and imported spend beside each other — with the blended total absent by
construction rather than by policy.**

### 1. `metered` vs `imported` is a schema property, not a convention

Imported money lives in `imported_cost_lines`, a different table from `usage_events`, and
`imported_cost_lines.basis` carries a CHECK admitting the single value `'imported'`. There is no
row anywhere in this schema that could be read as metered when it was not — not by a buggy join,
not by a future writer, not by an operator with psql. The suite asserts the constraint by trying to
insert the lie and requiring the insert to throw.

`consolidate()` in `packages/shared/src/cost-import.ts` returns `{metered: MeteredSide, imported:
ImportedSide}` per subject. **Its return type has no field for their sum**, so producing one would
require adding a field, which `cost-import-is-real.test.ts` and `cost-import.test.ts` both fail on:
each walks the entire response body — every number, at every depth, including numbers spelled
inside sentences — and asserts that metered+imported appears nowhere. The fixture numbers are
chosen so a collision is arithmetically impossible (61.11 + 146.30 = 207.41, and 207.41 arises no
other way).

`ADR-0051`'s billing statements are deliberately **left metered-only**. An invoice must bill what
we observed; a restated document is not billable. Nothing in migration 0081 touches `usage_events`,
so no existing statement, forecast, budget check or exec report moves by a cent.

### 2. The adapter registry — a new vendor is a new adapter, not a new code path

Mirrors `packages/model-provider` / `packages/infra-provider`: a registry, declared
`capabilities`, and an **honest `limits` string returned by the API** (a capability list that only
says yes is marketing; the suite asserts every adapter's `limits` is non-trivial and contains a
negation). Five ship:

| adapter | what it is | the important limit |
|---|---|---|
| `generic_mapped` | explicit column mapping over any CSV **or** JSON export, plus header inference | inference **refuses on ambiguity** — an export with both `cost` and `total` needs an explicit mapping rather than a guess |
| `openai_console` | fixed mapping for the declared OpenAI usage-export headers | built against a DECLARED header set, not a live export verified against the console |
| `anthropic_console` | ditto, with a start/end window and input tokens as quantity | seat charges are not in this export at all — use `seat_roster` |
| `aws_cur` | AWS Cost and Usage Report columns | the account identifier is an **AWS account id, not a person**; every line lands unattributed until an admin maps it |
| `seat_roster` | the wedge case: Claude Code / Copilot / Cursor seats | **the price is asserted by the operator**, not read from the file; one price applied to every row |

`generic_mapped` is the one deliberately made good, because the long tail of vendors is longer than
any preset list and it is what will actually get used.

The presets are **not** stubs. Each carries a real, fixed mapping and does real work; when a vendor
renames a column the adapter **refuses the file naming the missing column** rather than mapping the
wrong one, and points at `generic_mapped` as the escape hatch. A refusal that says which column is
missing is a better product than a silent mis-parse, and it is also the honest response to the fact
that we have not run these against live consoles (see the gaps section).

### 3. Never trust the file

- Bytes bounded (4 MB) **before anything is walked**; rows bounded (20,000); columns bounded (200);
  free-text cells truncated at 300 characters.
- **Character-scanned parsers, no regex over imported text.** This is ADR-0055's "NO REGEX FROM
  DATA" rule applied verbatim — an admin-influenced pattern evaluated over untrusted strings is a
  ReDoS primitive. `parseAmountCell` and `parseDateCell` are hand-written scanners.
- **An ambiguous date is refused, not guessed.** `07/08/2026` could be July or August depending on
  whose export it is, and a wrong guess silently moves spend between reporting periods — precisely
  the error an FP&A team discovers only in a dispute. Only year-first spellings are accepted.
- **An empty amount is refused.** An absent measurement is not zero.
- **A line over $1bn is refused.** A cents-as-dollars units error is far more common than a real
  charge that size, and a units error that lands silently poisons every rollup it touches.
- **Unmapped columns are DISCARDED, not retained.** Keeping the rest of a vendor export "just in
  case" is how an invoice importer becomes a PII store.
- **Nothing is silently dropped.** `rows_parsed = rows_accepted + rows_refused` is a **DB CHECK**,
  every refusal carries the **1-based file line number** plus a reason and the offending column, and
  the suite parses the same file twice — clean, then with one amount corrupted — asserting the
  corrupt parse does not simply return less money.

The CSV reader itself is the existing `parseCsv` from `onboarding.ts`; this slice added
`parseCsvRecords` beneath it (line numbers preserved, blank records not dropped) and redefined
`parseCsv` in terms of it, so there is still exactly **one** CSV parser in the codebase.

### 4. Identity resolution, and its honesty

Precedence: **admin alias → exact email → domain rule → unresolved.**

- The alias wins over an exact match deliberately: otherwise an administrator's correction would
  not be a correction.
- A **domain rule** rewrites `local@from` to `local@to` and then requires an exact match on the
  result — the multi-domain-company case. Two rules producing two different people produce **no
  match at all**; ambiguity is never broken by guessing.
- **`unresolved` is a first-class outcome.** The line is retained, appears in the consolidated view
  as an unattributed subject with its own money, sorts last so it cannot be mistaken for a person,
  and is **never spread across the people who did match**. The suite asserts 10/90 stays 10 and 90,
  not 100 and not 55.
- **Every attributed line records HOW.** `resolution_method` is NOT NULL and is paired with
  `resolved_user_id` by a CHECK, and `resolution_detail` is a sentence a disputed chargeback can be
  argued from ("an administrator asserted…", "domain rule d1 rewrote…").
- **A correction restates history.** Creating or deleting an alias or a domain rule re-resolves
  every stored line and reports how many moved; the audit row states the reason the admin gave and
  the blast radius.
- Normalisation is `trim + lowercase` and **nothing else**. Plus-address stripping, dot-folding and
  unicode confusable folding are all guesses about a vendor's identity semantics, and a wrong guess
  attributes one person's spend to another.
- Deleting a user **un-attributes** their imported spend rather than deleting it (`ON DELETE SET
  NULL` plus a trigger that stamps the method back to `unresolved`). The money was real whether or
  not the person is still on the roster; a chargeback report that silently shrinks when somebody
  leaves is broken.

### 5. Default-deny, on both sides

Importing is admin-only through app.ts's existing default-deny gate — **none** of the import,
mapping, revocation or fleet-wide routes appears in `NON_ADMIN_ROUTES`. Uploading a file that
restates a named colleague's spend, and asserting that a vendor account is a particular human, are
operator authority.

The **one** non-admin route is `GET /v1/users/:userId/cost-consolidated`, which refuses in-handler
unless the caller **is** that user. The suite asserts a non-admin cannot import, cannot assert a
mapping, cannot read the fleet-wide view, can read their own, cannot read a colleague's, and that
their own view mentions no other user's id anywhere in the body.

### 6. The double-count guard

Re-applying identical bytes is the single easiest way to turn this feature into a lie: the operator
sees "imported successfully" twice and every figure doubles. A **partial unique index** on
`payload_sha256` over live applied batches makes the second apply a real 409 naming the earlier
batch. The honest re-import path is `DELETE /v1/cost-imports/:id` — which withdraws the lines but
**keeps the batch row, marked `revoked`**, because "somebody imported and then withdrew July's
invoice" is exactly what an auditor asks about later.

### 7. PII, and the exemption stated out loud

Ingest goes through the **same** ADR-0042 posture as the training-corpus ingest (ADR-0065): the
same `detectPII`, the same `evaluateGuardrails`, the same `effectiveIngestMode` MAX composition,
counts only and never a matched substring. Because an import is not project-scoped, the floor is
the strictest `piiMode` anywhere in the deployment — the same global-floor pattern
`retentionFloor()` already uses for `audit_log`, which has the same problem for the same reason.
The default when nothing is requested is `block`.

**And then the exemption, which is real and is disclosed rather than hidden:** the vendor **account
column is exempt from the PII gate by construction.** A vendor export is a list of employee email
addresses; that is not incidental PII, it is the entire point, because the email *is* the identity
join key. A `block`-mode scan over it would make cross-vendor consolidation impossible rather than
safe. The exemption is stated in `COST_IMPORT_PII_POSTURE`, returned on every import response and
on the adapter registry, and asserted in the suite from both directions: an SSN/email in a
*description* column blocks the import at `block` mode, and an email in the *account* column does
not.

### 8. What feeds what

The consolidated view reuses the existing machinery rather than a parallel one: metered spend comes
from `usage_events` and takes its cost centre from the attributed project's `cost_center`, falling
back to its initiative's — the existing pillar-5 chain, unchanged. Migration 0081 adds the missing
person-level key, `users.cost_center`, because a seat charge belongs to a human and there was
nowhere to put it. A person with no code rolls up under "(no cost centre)" rather than having one
inferred from their memberships, which stops being well-defined the moment they belong to two
projects.

## Why not a scheduled re-import

[ADR-0064](0064-in-process-scheduler.md) exists and every other periodic sweep uses it, so the
absence needs justifying rather than assuming.

**There is nothing to poll.** RegulAIt holds no vendor billing-API credential for any vendor, and
minting one is not a scheduling decision — it is an egress decision (ADR-0034/0062: a new outbound
destination on an allow-list, refused outright under `air_gapped`), a credential-custody decision
(ADR-0063), and a per-vendor API-shape decision, each of which is larger than this slice. A
scheduled job whose only possible action is "re-read a file nobody uploaded" is a job that reports
success while doing nothing, which is the exact shape of dishonesty this slice exists to avoid.

What ships instead is **staleness reporting**: the consolidated view returns per-vendor
`lastImportedAt`, `appliedBatches` and `daysSinceLastImport`, with a note saying why there is no
job. An operator can see that nobody has uploaded a Copilot invoice since March. That mirrors
ADR-0055's coverage scorecard, which solved the same "the honest number is the one that admits what
it doesn't cover" problem.

## Alternatives rejected

**Add an `imported` column to `usage_events` and keep one ledger.** Rejected. It would have been
less code and it is the wrong shape: every existing query, statement, forecast, budget check and
exec report reads that table and none of them would have learned to filter. One missed `WHERE` and
an unverifiable restated figure is inside a customer's invoice. A separate table plus a CHECK makes
the mistake impossible instead of merely unlikely.

**Emit a `totalUsd` alongside the split, "for convenience".** Rejected, and this is the central
decision of the ADR. A convenience total is the only field anybody would ever read; the split would
become decoration. Refusing to compute it forces a consumer that wants one number to decide, in the
open, which basis it is willing to assert.

**Convert currencies so a mixed-currency file yields one number.** Rejected. There is no rate we
could use that would not be a guess about the date, the source and the customer's own accounting
policy, and a guessed rate is a wrong invoice. Mixed-currency subjects report `usd: null` with a
stated reason plus a `byCurrency` breakdown.

**Fuzzy-match unresolved accounts (nickname, plus-address, edit distance).** Rejected. Every
heuristic that raises the match rate also raises the rate at which one person is billed for
another's spend, and the second error is invisible while the first is loud. Unresolved stays
unresolved until an administrator says otherwise, on the record, with a reason.

**Spread unattributed spend pro-rata across matched users.** Rejected outright. It is the most
requested chargeback feature and it manufactures a number for every person on the list.

**Build a network/CASB collector to observe the spend directly.** Rejected — same reasoning as
ADR-0055 §"there is no collector": we do not hold that position, and a governance product that
started sniffing traffic would be the thing it exists to prevent.

## What this explicitly does NOT give you

Read this before citing any figure this slice produces.

- **The vendor presets are built against DECLARED header sets, not live exports verified against
  the vendors' consoles by this project.** `openai_console`, `anthropic_console` and `aws_cur`
  encode the column names as documented/expected; none has been run against a real download by
  anyone here. They refuse loudly on a mismatch rather than mis-parsing, and `generic_mapped` is
  the escape hatch, but a first-time user of a preset should expect to check. This is the largest
  honest gap in the slice.
- **`seat_roster`'s money is an operator assertion.** The roster is a list of people; the price
  lives on an invoice the roster does not contain. Every line it produces is stamped
  `derivedFrom: "operator-asserted seat price"`, one price is applied to every row (a mixed-tier
  roster overstates the cheap seats), and there is no proration for a seat added or removed
  mid-period and no detection of a paid-for seat nobody used.
- **`aws_cur` reads `lineItem/UnblendedCost` only.** Amortised, blended and net-amortised columns
  are ignored, so a Savings-Plan- or RI-heavy account will **not** reconcile to the invoice. There
  is no cost-allocation-tag aggregation, no manifest handling, no Parquet, and no filtering to AI
  services — point it at a whole-estate CUR and you import the whole estate.
- **No reconciliation against a vendor invoice total.** Nothing checks that the sum of imported
  lines equals what the vendor actually billed. ADR-0051's `rating_mode: 'reconciled'` rung is
  still modelled and still never written.
- **Imported figures never enter billing statements, budgets, forecasts, the optimizer or any
  enforcement path.** They are reporting-only. A person over their imported seat budget triggers
  nothing; the pillar-5 project-budget enforcement still sees metered spend only. That is deliberate — we
  will not block someone's work on a number we cannot verify — but it means "budget" and
  "consolidated spend" answer different questions.
- **There is no SPA page.** API-only, exactly as ADR-0066 shipped. The CSV export is the FP&A
  hand-off.
- **`ImportedSide.usd` is null for any mixed-currency subject**, so a report that only reads `usd`
  will show a blank rather than a number for those rows. That is intended, and `usdNote` says why,
  but a consumer must render the note.
- **Identity resolution cannot see a shared account.** An AWS account or a team seat used by five
  people maps to at most one RegulAIt user; there is no split-attribution model.
- **`users.cost_center` is a single flat code with no history.** Changing it restates every past
  imported figure for that person rather than versioning the assignment. A cost centre that changed
  mid-year cannot be reported correctly for both halves.
- **Changing a mapping re-resolves EVERY stored line, one UPDATE at a time.** Correctness over
  speed: an alias change must restate history, and doing it incrementally would need a reverse index
  from account key to line that is one more thing to keep in step. At the row bounds this slice
  accepts it is fine; at ten million lines it would not be, and that is a real ceiling.
- **The row and byte bounds mean a large CUR must be chunked by the operator**, and there is no
  chunk-assembly or cross-chunk dedup: two overlapping chunks of the same CUR are two batches with
  different fingerprints and will double-count. The fingerprint guard catches identical bytes only.

## Consequences

- A per-person, per-cost-centre spend figure spanning gateway traffic and off-gateway vendor spend
  exists for the first time, and states its own provenance everywhere it appears.
- Nothing that existed moved. `usage_events` is untouched, migration 0081 adds four tables and one
  nullable column, and the gateway baseline grew only by this slice's own tests.
- A new vendor is a new adapter in `packages/shared/src/cost-import.ts` plus a registry entry —
  provider-agnostic per `CLAUDE.md`'s standing principle, at a layer that principle had not yet
  reached.
- The follow-up the owner should weigh first is **verifying the three vendor presets against real
  exports**; the second is deciding whether imported spend should ever inform a budget, which is a
  policy question this ADR deliberately did not answer.

---

## Amendment — 2026-08-09: the SPA page exists

*This section is appended. Nothing above it has been edited; the Accepted decision stands
unchanged, and this records only that one of its stated gaps has been closed.*

The disclosure **"There is no SPA page. API-only, exactly as ADR-0066 shipped"** is now obsolete.
`/admin/cost-consolidation` ships in the React SPA (nav: **Cost & Optimization**, directly under
*Cost dashboard*), built entirely on the routes this ADR already specified. **No contract changed
and no migration was written.** The CSV export remains, as the FP&A hand-off, on the page itself.

**§1's honesty rule survived into the layout, which was the only way this page could be worth
shipping.** `metered` and `imported` are rendered in two separately-ruled columns, each printing
its own basis word and what that word MEANS, with the subject's `coverage` sentence underneath.
There is no cell for a combined figure because there is no field for one — and the e2e spec
**computes** each subject's `metered.usd + imported.usd` from the API's own answer and asserts that
number appears nowhere in the rendered document, so the guarantee cannot quietly stop being tested
if the seeded metered spend moves.

The other three things the page had to carry:

- **Each adapter's `limits` string is printed verbatim** where it is chosen, read from the registry
  rather than restated in the UI — the spec asserts that switching adapter switches the sentence.
  §"the three vendor presets are built against DECLARED header sets never verified against a live
  console" is a thing an operator must read **before** trusting a parse.
- **Refusals name their file line.** The dry run shows parsed / accepted / refused and a table of
  every refusal with its 1-based line number; the spec imports a file whose third line carries
  `07/08/2026` and asserts the screen names line 3 and the ambiguity.
- **Unattributed spend is its own visible subject**, never hidden and never spread; mapping the
  account moves the money to a person, and the page proves the row disappears only because it moved.

**Still not closed by this amendment**: everything else in *What this explicitly does NOT give you*
stands as written — the unverified vendor presets remain the biggest gap, imported figures still
enter no budget/forecast/enforcement path, there is still no FX conversion, no invoice
reconciliation, and no scheduled re-import (the page renders per-vendor staleness instead).

Evidence: `apps/web/src/views/admin/cost/CostConsolidationPage.tsx`, driven in Chromium by
`apps/web/e2e/phase6-parity-ui.spec.ts` (six tests, zero console errors, screenshots
`phase6-06`…`phase6-11`).
