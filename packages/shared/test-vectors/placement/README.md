# ADR-0190 placement-decision specification vectors

Adopted from Codex X50 (PR #319, branch `codex/x50`) under ADR-0191, and reviewed against the **current** ADR-0190
text on `origin/b6-isolation-i3` @ `cee8a67c` (ADR blob `60329ec2`), which adds amendments K to W after slice I3
and its review. Written from ADR text only; no shared source, product test, contract or implementation was read.
These are semantic requests and expected decision projections, not HTTP DTOs. `placement_eligible` means only that the
isolation constraint can be met; it never authorizes a sponsor, actor, grant or upstream call.

Counts: 131 vectors = 82 from X50 (13 of them re-pinned by owner decisions A and B, see below), 7 revised, 42 new.
48 carry `"pendingBranch": "b6-isolation-i3@cee8a67c…"`: every vector that cites an
amendment from K to W, whose text is not yet on `main` (the checker enforces this marker both ways). Find them with
`grep -n pendingBranch placement-semantic-corpus.json`.

## Changed X50 vectors, and why

- `refusal-executor_quarantined`: Citation of amendment P added.
- `customer-declared-unmapped`: Citation of amendment P added; reason still a gap.
- `attestation-missing`: Amendment P: attestation_stale needs an attestation that exists; with none, the most specific reason is no_executor (was gap missing_failing_report_reason).
- `attestation-failing`: Amendments N and P: a latest fail withdraws the class; an attestation exists but none is fresh, so attestation_stale (literal reading, flagged as a gap).
- `profile-mismatch-offer`: Amendment P selects on the latest attestation for the profile; an executor attested only for another profile has none, so no_executor (was gap profile_match_reason). requiredClass is L2 (default floors).
- `freshness-boundary`: Clock and limit now specified by amendment N; only equality remains open.
- `placement-report-mismatch`: Amendment O names the alert, its severity and offer withdrawal.
- Checker: `byoc_worker` no longer gets an invented L2 kind floor (decision 3 gives it none: "the class the placement
  requires"); expected classes are unchanged because every sensitivity floor is at least L2. The frozen-blob
  `git hash-object` check was removed: the text the vectors follow is on a branch, and the tests must not depend on git.

## Owner-decided changes (ADR-0190 owner decisions A and B, accepted 2026-10-11)

These are vector changes decided by the owner, not corrections. Each changed vector carries a `decidedBy` field.

- **A. `warn` is retired.** `isolation_enforcement` has one value, `enforce`. `warn-shortfall` is kept and pinned as
  a refusal: a stored `warn` reads as `enforce` (`enforcementRead`), a request that sets it is a `400`
  (`settingWriteStatus`), and the regulated L3 call with only an L2 executor is refused `class_below_required`. The
  checker now refuses any vector whose request names a mode other than `enforce` unless it pins exactly that.
- **B. An unresolved policy fact answers `409 execution_profile_unavailable`**, rule `execution-profile`, with the
  sixth fixed reason `policy_unresolved`, decided before any offer (`offersMade: 0`) and audited `execution-refused`.
  All 12 `unknown-*` vectors are pinned to it (they were `fail_closed_pending_contract`). New vector
  `refusal-policy_unresolved` (an unresolved sensitivity-floor lookup) gives the sixth reason its own `refusal-*`
  case. The checker derives the unresolved fact from the request and requires one for every `policy_unresolved`,
  and none for any vector that projects a class.

## New vectors (amendments K-W)

- `precedence-*`, `select-fewest-open-offers`, `profile-minclass-raises-requirement`, `offer-*`: amendment P (most
  specific reason, unknown digest is `profile_retired`, fewest open offers, declined or expired offers are refusals).
- `reenable-*`, `selftest-while-quarantined`: amendment T (only attestations with `observed_at > reenabled_at` count;
  self-test answers `409 executor_quarantined` while quarantined). `reenable-needs-step-up`, `revoked-executor-proof`,
  `quarantine-concurrent-mismatch`: amendment O.
- `report-*`, `profile-schema-*`: amendment U (`runtime_identity` always; `runtime_config` for gVisor or a
  `user_space_kernel` claim; whatever the profile lists).
- `executor-url-*`: amendment V (https only; plain http only for loopback or with the flag set to `1`).
- `channel-*`: amendments K and W (60 s / 5 s proof window, `bh`, one-use `jti` in `executor_channel`, no body read
  before the proof header is verified, one audit row per refusal). Proof ids contain `CANARY`.

## Spec gaps found (ADR-0190 @ b6-isolation-i3)

Each gap now points to ADR-0190 "Amendments from the conformance-vector gaps (2026-10-10)". The item number is given
for each. The vector expectations are unchanged. A vector that still says `gap`, `contract_gap` or
`fail_closed_pending_contract` can now pin the outcome its item names, except where the item leaves the choice to the
owner (open items A and B).

- **`offer_expired`** is not in the ADR text. Amendment P says a declined or expired offer is refused with
  `no_executor` "or the executor's reason", and amendment S mentions five decline codes without listing them
  (`offer-*`, gap `offer_expired_code`). **Closed by items 1 and 2:** an expired offer is `no_executor`, and
  `offer_expired` is only the channel's `409` to the executor. The five decline codes and their mapping are listed.
- Which fixed reason a latest **failing** self-test gives: read literally from P as `attestation_stale`
  (`attestation-failing`, gap `failing_latest_reason_reading`). **Closed by item 3:** `attestation_stale`, as the
  vector reads it.
- Freshness equality at exactly `observed_at + limit` (N fixes the clock and the min rule, not the boundary).
  **Closed by item 4:** stale at equality.
- Values of `REGULAIT_EXECUTOR_ALLOW_INSECURE_HTTP` other than `1`; whether `[::1]` and other IPv6 loopback spellings
  (`::ffff:127.0.0.1`) count. **Closed by items 5 and 6:** only `1` turns the flag on. `[::1]` counts, and so does any
  spelling the URL parser normalises to it; `[::ffff:127.0.0.1]` does not.
- Whether a `bh` mismatch after a valid proof header consumes the `jti` (W orders the steps, not the claim outcome).
  **Closed by item 7:** it does not.
- Reason for an unmapped `customer_declared` plane; refusal envelopes for unknown facts, `delegation-isolation`,
  the live-chain refusal and the OpenShell refusal; the HTTP status of `execution_profile_mismatch`. **Closed by
  item 8** (`class_below_required`), **item 11** (`invalid_grant` / `delegation_isolation`), **item 12**
  (`actor-chain-invalid`), **item 13** (both ends refuse) and **item 10** (`409`). For unknown facts, **item 15**
  fixes the fail-closed rule. **Closed by owner decision B:** the envelope is `409 execution_profile_unavailable`
  with reason `policy_unresolved`; the `unknown-*` vectors are pinned to it.
- **`warn` versus "never fall back"** (decision 11 table and test strategy) (`warn-shortfall`). **Item 14** set the
  interim rule (the invariant wins). **Closed by owner decision A:** `warn` is retired and can no longer be
  configured; `warn-shortfall` is pinned as a `class_below_required` refusal.
- Tie-break between eligible executors with equal open offers. **Closed by item 9:** unspecified on purpose, so a
  test must not pin one.

## Checks

`node packages/shared/test-vectors/placement/check-placement-corpus.mjs` (also run by
`packages/shared/src/spec-vectors-0188-0190.test.ts`) recomputes every required class (decision 7 MAX), re-derives
every refusal reason and selection with amendment P's precedence, checks the T predicate, the V URL rule, the K window,
the U probe rule, the pending markers, the unresolved fact behind each `policy_unresolved` (owner decision B) and
that no vector uses a retired enforcement mode (owner decision A), then proves it rejects 19 deliberate corruptions.
Self-consistency only;
not I2 conformance or runtime attestation.

## Vector map (id → ADR-0190 paragraph)

| Vector | Text on | ADR-0190 section | Origin |
|---|---|---|---|
| `floor-mcp_stdio-public` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-mcp_stdio-internal` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-mcp_stdio-confidential` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-mcp_stdio-regulated` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-code_exec-public` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-code_exec-internal` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-code_exec-confidential` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-code_exec-regulated` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-engine_worker-public` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-engine_worker-internal` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-engine_worker-confidential` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-engine_worker-regulated` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-byoc_worker-public` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-byoc_worker-internal` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-byoc_worker-confidential` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `floor-byoc_worker-regulated` | main | Decision 3; Decision 7 items 1–2 | X50 |
| `compliance-L1` | main | Decision 7 item 3 | X50 |
| `compliance-L2` | main | Decision 7 item 3 | X50 |
| `compliance-L3` | main | Decision 7 item 3 | X50 |
| `compliance-list-19` | main | Decision 7 item 3; Decision 14 | X50 |
| `compliance-list-20` | main | Decision 7 item 3; Decision 14 | X50 |
| `compliance-list-21` | main | Decision 7 item 3; Decision 14 | X50 |
| `compliance-list-22` | main | Decision 7 item 3; Decision 14 | X50 |
| `compliance-list-23` | main | Decision 7 item 3; Decision 14 | X50 |
| `autonomyFloor-L1` | main | Decision 7 items 4–6 | X50 |
| `autonomyFloor-L2` | main | Decision 7 items 4–6 | X50 |
| `autonomyFloor-L3` | main | Decision 7 items 4–6 | X50 |
| `ownProfileFloor-L1` | main | Decision 7 items 4–6 | X50 |
| `ownProfileFloor-L2` | main | Decision 7 items 4–6 | X50 |
| `ownProfileFloor-L3` | main | Decision 7 items 4–6 | X50 |
| `parentRequiredClass-L1` | main | Decision 7 items 4–6 | X50 |
| `parentRequiredClass-L2` | main | Decision 7 items 4–6 | X50 |
| `parentRequiredClass-L3` | main | Decision 7 items 4–6 | X50 |
| `assurance-unknown` | main | Decision 7 item 5; Decision 2 | X50 |
| `assurance-no_identity` | main | Decision 7 item 5; Decision 2 | X50 |
| `assurance-observed_autonomy_above_declared` | main | Decision 7 item 5; Decision 2 | X50 |
| `l3-satisfies-l2` | main | Decision 1; Decision 7 | X50 |
| `refusal-no_executor` | main | Decision 7 first Then bullet; Decision 6 | X50 |
| `refusal-attestation_stale` | main | Decision 7 first Then bullet; Decision 6 | X50 |
| `refusal-class_below_required` | main | Decision 7 first Then bullet; Decision 6 | X50 |
| `refusal-executor_quarantined` | **pending** | Decision 7 first Then bullet; Decision 6; Amendment P | X50-revised |
| `refusal-profile_retired` | main | Decision 7 first Then bullet; Decision 6 | X50 |
| `refusal-policy_unresolved` | main | Decision 7; Test strategy: Fail closed; owner decision B | claude-new |
| `no-fallback-initial` | main | Decision 7 first Then bullet; Decision 11 invariants; Test strategy: No fallback | X50 |
| `no-fallback-retry` | main | Decision 7 first Then bullet; Decision 11 invariants; Test strategy: No fallback | X50 |
| `no-fallback-queued_retry` | main | Decision 7 first Then bullet; Decision 11 invariants; Test strategy: No fallback | X50 |
| `no-fallback-restart` | main | Decision 7 first Then bullet; Decision 11 invariants; Test strategy: No fallback | X50 |
| `engine-not-run` | main | Decision 7 first Then bullet | X50 |
| `stdio-below-floor-L0` | main | Decision 3; Decision 7; Decision 11 invariants | X50 |
| `stdio-below-floor-L1` | main | Decision 3; Decision 7; Decision 11 invariants | X50 |
| `customer-declared-mapped-L2` | main | Decision 1; Decision 7 final bullet; Decision 11 customer_declared mapping | X50 |
| `customer-declared-mapped-L3` | main | Decision 1; Decision 7 final bullet; Decision 11 customer_declared mapping | X50 |
| `customer-declared-unmapped` | **pending** | Decision 7 final bullet; Amendment P | X50-revised |
| `non-isolable-model_call` | main | Decision 3 | X50 |
| `non-isolable-connector_call` | main | Decision 3 | X50 |
| `non-isolable-remote_mcp` | main | Decision 3 | X50 |
| `delegation-L1-L1` | main | Decision 8 second bullet; Decision 11 child invariant | X50 |
| `delegation-L1-L2` | main | Decision 8 second bullet; Decision 11 child invariant | X50 |
| `delegation-L1-L3` | main | Decision 8 second bullet; Decision 11 child invariant | X50 |
| `delegation-L2-L1` | main | Decision 8 second bullet; Decision 11 child invariant | X50 |
| `delegation-L2-L2` | main | Decision 8 second bullet; Decision 11 child invariant | X50 |
| `delegation-L2-L3` | main | Decision 8 second bullet; Decision 11 child invariant | X50 |
| `delegation-L3-L1` | main | Decision 8 second bullet; Decision 11 child invariant | X50 |
| `delegation-L3-L2` | main | Decision 8 second bullet; Decision 11 child invariant | X50 |
| `delegation-L3-L3` | main | Decision 8 second bullet; Decision 11 child invariant | X50 |
| `middle-actor-executor-inactive` | main | Decision 8 third bullet; Test strategy: Delegation | X50 |
| `middle-actor-executor-quarantined` | main | Decision 8 third bullet; Test strategy: Delegation | X50 |
| `middle-actor-executor-stale` | main | Decision 8 third bullet; Test strategy: Delegation | X50 |
| `sponsor-not-floor-override` | main | Decision 7 items 1–6; Decision 8 | X50 |
| `unknown-workloadKind` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `unknown-sensitivity` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `unknown-complianceFloors` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `unknown-autonomyFloor` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `unknown-ownProfileFloor` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `unknown-parentRequiredClass` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `attestation-missing` | **pending** | Decision 6 executor self-test; Decision 7; Amendment P | X50-revised |
| `attestation-failing` | **pending** | Decision 6 executor self-test; Decision 7; Amendment N; Amendment P | X50-revised |
| `profile-mismatch-offer` | **pending** | Decision 4 pull model; Decision 7 first Then bullet; Amendment P | X50-revised |
| `freshness-boundary` | **pending** | Decision 6 executor self-test; Decision 11 attestation age; Amendment N | X50-revised |
| `warn-shortfall` | main | Decision 11 isolation_enforcement; Decision 11 falling-back invariant; Test strategy: Fail closed; owner decision A | X50 |
| `audited-l1-floors-still-profile-l2` | main | Decision 7 items 1–5; Decision 11 floors | X50 |
| `audited-l1-all-inputs` | main | Decision 7; Decision 11 floors; Decision 2 profile relaxations | X50 |
| `placement-report-mismatch` | **pending** | Decision 6 per-placement report; Amendment O | X50-revised |
| `openshell-gvisor-refused` | main | Amendment F | X50 |
| `unknown-missing-workloadKind` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `unknown-missing-sensitivity` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `unknown-missing-autonomyFloor` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `unknown-missing-ownProfileFloor` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `unknown-missing-complianceFloors` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `unknown-missing-parentRequiredClass` | main | Decision 7; Test strategy: Fail closed; owner decision B | X50 |
| `precedence-quarantined-and-stale` | **pending** | Amendment P | claude-new |
| `precedence-all-quarantined` | **pending** | Amendment P | claude-new |
| `precedence-retired-over-no-executor` | **pending** | Amendment P | claude-new |
| `precedence-fresh-below-and-stale-above` | **pending** | Amendment P | claude-new |
| `precedence-unknown-profile-digest` | **pending** | Amendment P | claude-new |
| `select-fewest-open-offers` | **pending** | Amendment P | claude-new |
| `profile-minclass-raises-requirement` | **pending** | Amendment P; Decision 7 item 5 | claude-new |
| `offer-declined-attestation-expired` | **pending** | Amendment N; Amendment P | claude-new |
| `offer-expired` | **pending** | Amendment P | claude-new |
| `reenable-old-pass-not-counted` | **pending** | Amendment T | claude-new |
| `reenable-pass-during-quarantine` | **pending** | Amendment T | claude-new |
| `reenable-pass-at-reenable-instant` | **pending** | Amendment T | claude-new |
| `reenable-new-pass` | **pending** | Amendment T | claude-new |
| `selftest-while-quarantined` | **pending** | Amendment T | claude-new |
| `reenable-needs-step-up` | **pending** | Amendment O | claude-new |
| `revoked-executor-proof` | **pending** | Amendment O | claude-new |
| `quarantine-concurrent-mismatch` | **pending** | Amendment O | claude-new |
| `report-missing-runtime_identity` | **pending** | Amendment U | claude-new |
| `report-gvisor-missing-runtime_config` | **pending** | Amendment U; Amendment A | claude-new |
| `report-l2-claim-missing-runtime_config` | **pending** | Amendment U | claude-new |
| `report-kata-l3-runtime_identity-only` | **pending** | Amendment U | claude-new |
| `profile-schema-omits-runtime_identity` | **pending** | Amendment U | claude-new |
| `profile-schema-omits-runtime_config` | **pending** | Amendment U | claude-new |
| `executor-url-https` | **pending** | Amendment V | claude-new |
| `executor-url-http-remote` | **pending** | Amendment V | claude-new |
| `executor-url-http-private-ip` | **pending** | Amendment V | claude-new |
| `executor-url-http-localhost` | **pending** | Amendment V | claude-new |
| `executor-url-http-loopback-127-0-0-5` | **pending** | Amendment V | claude-new |
| `executor-url-http-ipv6-loopback` | **pending** | Amendment V | claude-new |
| `executor-url-http-localhost-suffix-host` | **pending** | Amendment V | claude-new |
| `executor-url-http-127-prefix-host` | **pending** | Amendment V | claude-new |
| `executor-url-http-remote-insecure-flag` | **pending** | Amendment V | claude-new |
| `executor-url-flag-not-1` | **pending** | Amendment V | claude-new |
| `channel-proof-iat-60` | **pending** | Amendment K | claude-new |
| `channel-proof-iat-61` | **pending** | Amendment K | claude-new |
| `channel-proof-future-5` | **pending** | Amendment K | claude-new |
| `channel-proof-future-6` | **pending** | Amendment K | claude-new |
| `channel-proof-body-hash-mismatch` | **pending** | Amendment K | claude-new |
| `channel-proof-jti-replay` | **pending** | Amendment K | claude-new |
| `channel-unproven-large-body` | **pending** | Amendment W | claude-new |
| `channel-proven-header-then-bad-body-hash` | **pending** | Amendment W; Amendment K | claude-new |

## History

No `codexInputs.md` entry for X50 exists on `codex/x50` or any other branch. The PR #319 description and the X50
README are kept verbatim as the draft's record.

### PR #319 description (verbatim)

> ADR0190 I2 needs independent placement expectations before its implementation is built. Add 89 synthetic semantic vectors derived only from the frozen ADR text, covering class floors, fixed refusals, no fallback, parent inheritance, live-chain executor constraints and unresolved facts, with exact section citations.
>
> The fixtures are semantic requests and decision projections, not invented placement HTTP DTOs or product-test results. The README records the ownership exception and unresolved wire details, including the warning-mode shortfall conflict. Product code, shared contract, other vector work and review ledger were not read or edited.
>
> Validation: corpus integrity 89 vectors and 8 deliberately corrupt controls; filename guard 2/2; basename guard 4/4 and collision script; web tsc and build all passed. No I2 conformance/runtime attestation claim. Frozen ADR Git blob e359ffd660f0b023659ae28ded5a4a36cbc443b3, base main 2276739bb1ca3d5cddfcf03cbef186d59e1966a7.

### X50 README (verbatim)

> # Placement decision specification vectors (X50)
>
> Explicit ownership exception: AgentCoordination.md at
> `2536ab4b4ca5ad54efd6741534f91c720770a302`, task **X50**, assigns Codex
> `packages/shared/test-vectors/placement/` despite the general shared-package
> ownership rule. No shared source, product test, contract or implementation was read.
> The only normative source is ADR-0190 text at base commit
> `2276739bb1ca3d5cddfcf03cbef186d59e1966a7`, Git blob
> `e359ffd660f0b023659ae28ded5a4a36cbc443b3`.
>
> `placement-semantic-corpus.json` contains 89 synthetic semantic requests and
> expected decision projections. These are specification inputs, **not HTTP DTOs**,
> profiles, runnable executor reports, measured outcomes or completed product tests.
> Every vector carries its exact ADR section reference. Fields such as
> `sensitivityFloor`, `autonomyFloor` and `executors` describe already resolved policy
> facts, not proposed API keys. `placement_eligible` means only that the isolation
> constraint can be met; it never authorizes a sponsor, actor, grant or upstream call.
>
> I2's owner should write an adapter from actual authenticated policy facts to these
> semantic requests, execute I2, and compare only the defined projection fields.
> Do not import a second policy implementation as the test oracle. The owner must
> also exercise real app refusals with upstream counters at zero (ADR **Test
> strategy**, opening paragraph). No such app execution is claimed here.
>
> | Vector family | Exact ADR section | Requirement |
> |---|---|---|
> | `floor-*`, `l3-satisfies-l2` | Decision **1**, **3**, **7 items 1–2** | Ordered classes, strict workload/sensitivity floors; Decision 3 explicitly requires L3 for confidential `code_exec` |
> | `compliance-*` | Decision **7 item 3**, **14** | MAX of all mapped tags; nullable unmapped tag never lowers a floor |
> | `autonomyFloor-*`, `ownProfileFloor-*`, `parentRequiredClass-*` | Decision **7 items 4–6** | Every floor independently raises the result; low configured values cannot override other floors |
> | `assurance-*` | Decision **7 item 5**, **2** | Missing identity or observed autonomy above declared uses most restrictive shipped profile (L3) |
> | `refusal-*`, `no-fallback-*`, `engine-not-run` | Decision **7 first Then bullet**, **6**, **11 invariants**; Test strategy **No fallback** | Five fixed reasons, `409 execution_profile_unavailable`, rule `execution-profile`, no upstream contact, no lower retry/queue/restart; unavailable engine is `not_run/isolation_unavailable` |
> | `customer-declared-*` | Decision **1**, **7 final bullet**, **11 customer_declared mapping** | Unmapped satisfies nothing; named admin mapping must be audited and stepped up; evidence remains `declared` |
> | `non-isolable-*` | Decision **3** | Model/connector L0 and remote MCP `external`; no local sandbox label or invented isolation floor for remote upstream |
> | `delegation-*`, `middle-actor-executor-*` | Decision **8 second/third bullets**, **11 child invariant**; Test strategy **Delegation** | Child class at least parent; invalid middle placement refuses leaf's next use |
> | `sponsor-not-floor-override` | Decision **7 items 1–6**, **8** | Sponsor preference cannot lower project requirement; ADR0190 defines no separate sponsor-class input |
> | `unknown-*`, `attestation-*`, `profile-mismatch-offer` | Decision **7**, **6**, **4 pull model**; Test strategy **Fail closed** | Unresolved facts never become an eligible selection; missing/failing reports remove class; offer must match profile |
> | `audited-l1-*` | Decision **11 floors**, **2 profile relaxations**, **7** | Authorized relaxations affect their own inputs only, never erase another floor or move third-party code into gateway |
> | `placement-report-mismatch` | Decision **6 per-placement report** | Before first input byte: refuse, kill, quarantine and alert |
> | `openshell-gvisor-refused` | **Amendment F** | OpenShell gVisor placement refused; supersedes Decision 1's original OpenShell L2 clause |
>
> The ADR requires identity authorization separately. It does not specify sponsor
> or every actor's own isolation profile as additional Decision 7 MAX operands;
> these fixtures do not invent those operands or reconstruct ADR0188 from memory.
> They do cover parent inheritance and the executor checks on the live chain
> explicitly required by Decision 8. An unknown agent invokes the explicit L3
> fallback profile; unknown sensitivity/class/policy facts have no such default.
> Null compliance floor is the explicitly nullable, resolved lack of a mapping,
> not a missing policy lookup. L0/L1 are never labelled a sandbox.
>
> Contract gaps are represented explicitly, with no fabricated HTTP code, reason
> or successful wire example:
>
> - `warn_conflict`: Decision 11 says `warn` means **“place at what is available,
>   record the shortfall as a gate warning”**; the same table says **“Falling back
>   to a lower class than required”** is **“never”**, **“not relaxable”**.
>   Test strategy **Fail closed** also says warn is placed. Resolve this before
>   accepting a shortfall positive. The fixture retains the required selectable
>   floor and forbids fallback while leaving warning-mode behavior unresolved.
> - `missing_fact_refusal`: unknown workload, sensitivity or resolved class is
>   fail closed, but the ADR gives no exact error envelope for these invalid facts.
> - `unmapped_reason`, `missing_failing_report_reason`, `profile_match_reason`:
>   `execution_profile_unavailable` is specified, but reason selection for unmapped
>   BYOC, missing/failing reports and wrong-profile offers is not explicit.
> - `delegation_refusal_http`, `live_chain_refusal_envelope`,
>   `mismatch_http_status`, `openshell_refusal_envelope`: the described refusal is
>   required; the missing transport details are deliberately absent.
> - `freshness_boundary`: exact 2 h equality, future timestamps and clock choice
>   are unspecified; no boundary success is invented. Fixtures otherwise use
>   resolved fresh/stale verdicts, not timestamps.
> - Placement HTTP route/DTO, reason precedence across multiple failed executors,
>   executor selection among multiple eligible offers, the full autonomy-class
>   floor table, and `code_exec` confidential-floor relaxation are not specified.
>   Each fixed-reason fixture isolates one fault. Autonomy floors are resolved
>   semantic inputs; no unprovided autonomy mapping is asserted.
>
> Run corpus integrity (Node built-ins only):
>
> ```sh
> node packages/shared/test-vectors/placement/check-placement-corpus.mjs
> ```
>
> It checks the frozen ADR blob, IDs, citations, complete workload/sensitivity and
> parent/child matrices, the MAX projections, refusal coverage and no-fallback
> constraints. Deliberate in-memory corruptions must fail, proving the checker
> can detect wrong floors, lost refusal rules, invalid fallback, missing matrix
> rows, swapped delegation outcomes, invented unknown-fact success, and removed
> engine `not_run` behavior. This is corpus integrity, not I2 conformance or actual
> runtime attestation. Synthetic identifiers contain no user or workload content.
