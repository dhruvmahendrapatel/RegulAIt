# ADR-0100 — A scheduled MCP admission re-scan, so a server nobody calls is still adjudicated

- **Status**: Accepted
- **Date**: 2026-09-06
- **Relates to**: [ADR-0097](0097-mcp-admission-scanning-and-auth-discovery.md) (the admission gate whose own
  disclosed residue this closes — its scanner, its states, its digest, its threshold, its audit
  rows), [ADR-0064](0064-in-process-scheduler.md) (the in-process scheduler this job registers on,
  and its off-by-default posture, its lease, its per-job error isolation and its
  extract-don't-duplicate rule), [ADR-0043](0043-mcp-oidc-egress-guard.md) (the fail-closed egress guard
  every connect this job makes still goes through), [ADR-0062](0062-mode-scoped-egress.md)
  (air-gapped mode — the reason "unreachable" may never mean "held"),
  [ADR-0042](0042-guardrail-engine.md) (the detector tiers and the counts-only finding contract the
  scan inherits), [ADR-0041](0041-byoc-primary-motion.md) (why the driver is in-process and not a
  cron somebody else owns)
- **Migration**: none. ADR-0097's migration 0103 already carries every column this needs, and
  ADR-0064's jobs register themselves in code.

## Context

ADR-0097 built the tool-poisoning gate, and then wrote down where it does not reach. Twice, in its
own words:

> **It does not re-scan on a schedule.** Adjudication happens on manifest sync. A server nobody
> touches is never re-examined, and a compromised server that is never called is never caught. A
> periodic re-scan job is a follow-up, and it is deliberately not smuggled in here.

> **The upgrade boundary is deliberately soft.** Grandfathered servers are trusted until their next
> sync. On a deployment where a server is registered and never re-synced, that is indefinite.

Those are one hole described from two sides, and the hole is precisely where an attacker would
choose to sit. ADR-0097's own §5 argues that the realistic compromise is not the server that was
always malicious but the one that **turned** — and the gate that catches a turned server is
`recordManifestScan`, which only ever runs when something triggers a manifest sync. So the control
is strongest on the servers people use constantly and weakest on the server that is registered,
forgotten, and quietly re-pointed; and it is entirely absent on any row still carrying migration
0103's `grandfathered` default, which on a real deployment can be every server the customer had
before they upgraded.

"Somebody will call it eventually" is not a control. Neither is "an admin will notice the review
queue is empty".

## Decision

**Register one more job on ADR-0064's scheduler — `mcp-admission-rescan-sweep` — that re-fetches
the tool manifest of every MCP server in an eligible admission state and drives THE LIVE PATH over
it. It computes no verdict of its own.**

### 1. One adjudication, not two — and this is the whole design

The failure mode a job like this invites is that it grows its own copy of "is this manifest
admissible": its own threshold, its own idea of what a clearance covers, its own state table. Two
implementations of one control drift, and the drift is found by whoever was relying on the wrong
one. ADR-0064 §7 already made this rule for the six sweeps it shipped; this job obeys it literally.

A pass over one server is, in full:

```ts
const client = await connectUpstream(db, row);          // ADR-0097 gate, then ADR-0043 guard
await syncUpstreamTools(db, row.id, client, "rescan");  // → recordManifestScan(...)
```

`syncUpstreamTools` was made exported for this (it was already the single manifest-sync funnel for
the MCP proxy route, the governed tool call and pillar 7's worker-node tool resolution).
`recordManifestScan` — unchanged in every respect that decides anything — owns the scan, the hold
threshold `MCP_ADMISSION_HOLD_AT`, the digest, the state transition (`nextAdmissionState`), the
clearance-wipe on re-hold, and the audit row. `apps/gateway/src/mcp-admission-rescan.ts` decides
only **which** servers get looked at, in **what** order, and **how many** per pass. It contains no
threshold, no digest comparison and no state rule, and the suite proves that by consequence rather
than by inspection: the hold this sweep makes files the same `mcp-admission-held` row, keeps the
poisoned description out of `mcp_tools` by the same scan-before-upsert ordering, and is enforced by
the ordinary connect gate on the very next call.

The one addition to the shared function is a `trigger` label — `"sync" | "rescan"` — that lands in
the audit `detail` and in the reason text. It changes no threshold, no state rule and no order of
operations. It exists so an operator reading a hold can tell **"held by a call"** from **"held by
the sweep"** off the row itself, instead of correlating timestamps against the scheduler ledger.

### 2. It fetches a fresh manifest, and the alternative was not merely weaker

Re-scanning the **stored** manifest would make no outbound call at all, which is genuinely
attractive for the primary BYOC/air-gapped buyer. It was rejected on a fact, not a preference:
`mcp_tools` stores `name`, `kind` and `description` **and nothing else** — the `inputSchema` is not
persisted anywhere in this codebase. ADR-0097's headline finding is that the payload does not live
in the tool's own description, where a reviewer skimming a tool list would see it, but in the
**nested per-property description inside that input schema**. A stored re-scan is therefore
structurally blind to the exact class of poisoning this gate exists for: it would report `clean` on
a manifest the live path holds. That is the second-implementation defect, arrived at by accident
rather than on purpose — and it would be worse than the accidental kind, because it would look like
coverage.

It would also catch nothing. Same bytes, same deterministic scanner, same verdict; unless
`MCP_ADMISSION_SCANNER_VERSION` moved, a stored re-scan is a loop that recomputes what is already in
the column.

**So the sweep connects, and the honest cost is stated here rather than discovered:** one
`tools/list` per examined server per pass, on a timer, from a deployment nobody is otherwise using.
That is a new outbound behaviour for this product and it is why the job is daily by default (the
cadence the other two outbound-ish jobs got) and bounded per pass. Every connect goes through
`connectUpstream`, so ADR-0043's egress guard adjudicates the destination exactly as it does for a
human's call — the sweep gets no privileged route out of the box, and ADR-0062's air-gapped mode
needs no special case here because the guard already refuses what it must.

**A connect that fails is `unreachable`, and `unreachable` is NOT a verdict.** The admission columns
are left byte-identical. A gate that held on unreachability would take an entire air-gapped install
— or any install during a network blip — offline for a control nobody opted into, which is ADR-0097's
own argument for why the migration grandfathers instead of holding. ADR-0097 holds on a scan verdict
and nothing else; so does this.

### 3. Eligibility, ordering, and the operator-fighting guard

Four states are eligible, swept **worst-known-provenance first**, so a bounded pass spends its
budget on the blind spot rather than on the servers already best understood:

| # | state | why it is eligible |
| --- | --- | --- |
| 1 | `grandfathered` | trusted only because it was already trusted. Nobody has ever looked at this manifest — the ADR-0097 upgrade boundary, and the indefinite one. |
| 2 | `unscanned` | registered, never synced. Also never looked at, for a different reason; the review queue already shows the two apart, and so does this order. |
| 3 | `clean` | looked at once. This is where the server that **turns** turns. |
| 4 | `cleared` | an admin signed for a **specific** manifest. |

Within a state: least-recently-scanned first, never-scanned first of all, so a capped pass rotates
through the estate instead of re-reading the same servers every night.

**`cleared` is the interesting case, and the rule is not this job's to invent.** ADR-0097 §5 already
pins a clearance to `admission_manifest_digest`, and `nextAdmissionState` already implements it. By
driving that function the sweep inherits both halves rather than re-deciding either:

- **Same manifest ⇒ same digest ⇒ the server stays `cleared`.** The sweep does **not** re-hold a
  server on the manifest an admin already accepted. Re-holding there would be the job fighting the
  operator, and an operator who has to re-clear the same server every night is an operator who turns
  the mode back to `off` — the exact failure ADR-0097 designed its `log` posture to avoid.
- **A changed manifest is precisely what the clearance did not cover**, so it is adjudicated from
  scratch, can re-hold, wipes the stale clearance columns, and files the same
  `mcp-admission-drift-reheld` row the live path files.

**`held` is deliberately NOT eligible.** It is already at the adverse terminal state and already in
the review queue; under `enforce` the gate inside `connectUpstream` would refuse the sweep's own
connect anyway. More importantly, the only thing re-scanning a held server could *achieve* is
**auto-un-holding** it the night its upstream happens to serve something clean — and ADR-0097 §6 is
explicit that **nothing auto-clears, in either direction**. A timer that silently readmits a server
an admin was in the middle of reviewing is that decision taken by the back door. Coming back from
`held` stays a signed act with a reason on it.

### 4. Bounded work, and one audited fact per pass

`MCP_RESCAN_MAX_PER_PASS = 25`. Every sweep in ADR-0064 is bounded; this one has a sharper reason
than most, because each examined server costs a real outbound MCP session and an estate of five
hundred servers must not turn one tick into a five-hundred-connection burst. The remainder is not
dropped: the ordering is least-recently-scanned-first, so the next pass resumes where this one
stopped, and `capped` plus the eligible/examined counts are on the run row.

Every pass that adjudicates writes exactly one `mcp-admission-rescan-swept` audit row, in the shape
B7c's `canary-observations-pruned` established: mode, eligible, examined, capped, limit,
adjudicated, held, reheld, clean, clearedUnchanged, unreachable, the held and unreachable server
ids, and the eligible state list. Its `effect` is `allow` **deliberately** — each individual hold
already filed its own `mcp-admission-held` / `mcp-admission-drift-reheld` row carrying the real
effect, and duplicating that deny on the summary would double-count one refusal on the admin's
filtered "things that did not go through" view.

### 5. Posture — two knobs, and both must say yes

1. **ADR-0064's scheduler is off by default**, inherited whole. A fresh install runs no pass at all
   until an operator sets `REGULAIT_SCHEDULER=on`, and under vitest the resolver forces it off
   regardless of the environment.
2. **`org_settings.mcp_admission_mode` is `off` by default, and with it off this job adjudicates
   nothing** — it returns before a single row is read, before any socket is opened, before any
   column is written and before any admission audit row exists. That is the only coherent reading of
   the knob: a setting that says *do not scan manifests* cannot mean *except on a timer*. It also
   keeps ADR-0097's `off` guarantee exactly as strong as that ADR asserts it, rather than adding a
   second door through which a scan could happen anyway.

   The pass still **happens**, and ADR-0064's own `scheduler-job-succeeded` row carries
   `skipped: true`, the mode and the reason — so *"it ran and did nothing on purpose"* is never
   confused with *"nothing ran"*, which is the failure ADR-0064 was written about.

### 6. No new API surface

ADR-0064 §10 already gives every job a manual door: `POST /v1/scheduler/jobs/mcp-admission-rescan-
sweep/run`, through the same claim and the same lease, admin-only. A second endpoint would be a
second door onto the same function for no gain, plus an ADR-0053 contract entry and a regenerated
client. The review queue that shows the *result* — `GET /v1/mcp/admission` — already exists and
needed no change, because the sweep writes the same states that surface already renders.

### Alternatives considered

**Leave it to manifest sync (the status quo) — rejected.** It is what ADR-0097 shipped and what
ADR-0097 disclosed as insufficient. Its coverage is a function of how often a server is used, which
is inversely correlated with how likely it is to be the compromised one.

**Hold every `grandfathered` row on upgrade instead of sweeping — rejected**, and rejected for the
reason ADR-0097 already gave when it chose to grandfather: taking a working deployment offline for a
control nobody opted into is how a security feature gets switched off permanently. A sweep converts
the same rows into real verdicts without a single outage.

**Re-scan the stored manifest — rejected on a fact.** See §2: the `inputSchema` is not stored, so
that scan cannot see the attack.

**A hosted/cron-driven re-scan — rejected**, on ADR-0064's own argument. ADR-0041 makes
BYOC/air-gapped the primary motion; a control that depends on infrastructure we cannot reach does
not run for the customer who cares most.

## What this deliberately does NOT do

- **It does not make the manifest safe, and it changes no verdict.** Every limit in ADR-0097's
  scanner header applies verbatim — literal English, no base64/homoglyph/leetspeak/translation
  handling, and false positives on manifests that legitimately discuss credentials or paths. This
  ADR changes *when* that scanner runs and *nothing* about what it concludes. The hold threshold is
  still the one constant in `MCP_ADMISSION_HOLD_AT`.
- **It does not un-hold anything, ever.** `held` is not eligible; nothing auto-clears; the only way
  back is the audited, reason-required admin clear ADR-0097 §6 built.
- **It does not re-hold a cleared server on the manifest the admin signed for.** That is not a
  loophole — the clearance is pinned to the digest, and a changed manifest is judged from scratch.
- **It does not introduce a second state machine, threshold, or audit vocabulary.** The only new
  ruleId is the per-pass summary `mcp-admission-rescan-swept`; every transition rides ADR-0097's
  existing rows.
- **It does not add an SPA surface.** ADR-0097 left the admission review queue API-only and called
  the admin console page a follow-up; that is still true, and the sweep makes it more worth
  building, not less. Handed off rather than built here.
- **It does not verify the upstream's identity.** No manifest signing, no publisher attestation. A
  re-scanned server is still identified only by the URL an admin typed. Unchanged from ADR-0097.

## Honest limits

- **It makes outbound calls on a timer.** This is the real cost of the design and it is not hidden:
  an operator who enables both knobs is enabling a daily `tools/list` to every eligible upstream.
  Bounded at 25 per pass, daily by default, every call through ADR-0043's guard — but an upstream
  operator will see traffic from a deployment with no users on it, and a deployment on metered
  egress will see the bytes.
- **On an air-gapped or tightly allow-listed install it examines only what it can reach.** Everything
  else is `unreachable`, its state untouched, and ADR-0097's blind spot persists for those servers.
  The sweep does not make an air-gapped install *worse*; it simply does not make it much better, and
  the run row says how many it could not reach rather than reporting a clean pass.
- **Timeliness is bounded by everything ADR-0064's is bounded by** — the tick interval, the box
  being up (ADR-0032 powers the dev infrastructure off nightly), and the operator having turned the
  scheduler on at all. A daily job on a machine that sleeps runs once, late.
- **A time-of-check/time-of-use gap remains, and is inherent.** The sweep adjudicates the manifest
  the upstream served *at that moment*. A server that serves a clean manifest to the 03:00 sweep and
  a poisoned one to the 09:00 caller is caught by the live path's own re-scan on that sync — which
  is why the live path was never removed — but the sweep's verdict is a fact about 03:00 and nothing
  more. It narrows the window; it does not close it.
- **The sweep's verdict is only as fresh as its cadence, and the cap makes that non-uniform.** With
  more than 25 eligible servers, a given server is examined every ⌈n/25⌉ passes, not every pass. The
  ordering makes that fair rather than arbitrary, and the counts make it visible, but "swept daily"
  is a property of the *job*, not of any one server.
- **`log` mode is still a verdict, not an effect.** A sweep pass under `log` will move servers into
  state `held` while they keep serving, exactly as a live sync does. The API surface says
  `enforcing: false`; this ADR does not change that vocabulary, and an operator who turns the
  scheduler on while in `log` should expect the review queue to fill up without anything being
  refused.
- **Non-vacuity (M-002, measured).** Neutralising the sweep's adjudication — the
  `syncUpstreamTools(..., "rescan")` call replaced with a no-op, everything else untouched —
  reddened **7 of the 16** tests in `mcp-admission-rescan.test.ts`: the three core "held by the
  sweep" assertions, the three eligibility/clearance guards, and the job-body pass. The 9 that
  correctly stayed green are the registration/posture facts, the `off`-knob assertions, the
  bound, the unreachable-is-not-a-verdict case and the per-pass fact — none of which asserts an
  adjudication, so a test that reddened there would have been asserting the wrong thing.
