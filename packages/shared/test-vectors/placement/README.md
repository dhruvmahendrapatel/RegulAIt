# Placement decision specification vectors (X50)

Explicit ownership exception: AgentCoordination.md at
`2536ab4b4ca5ad54efd6741534f91c720770a302`, task **X50**, assigns Codex
`packages/shared/test-vectors/placement/` despite the general shared-package
ownership rule. No shared source, product test, contract or implementation was read.
The only normative source is ADR-0190 text at base commit
`2276739bb1ca3d5cddfcf03cbef186d59e1966a7`, Git blob
`e359ffd660f0b023659ae28ded5a4a36cbc443b3`.

`placement-semantic-corpus.json` contains 89 synthetic semantic requests and
expected decision projections. These are specification inputs, **not HTTP DTOs**,
profiles, runnable executor reports, measured outcomes or completed product tests.
Every vector carries its exact ADR section reference. Fields such as
`sensitivityFloor`, `autonomyFloor` and `executors` describe already resolved policy
facts, not proposed API keys. `placement_eligible` means only that the isolation
constraint can be met; it never authorizes a sponsor, actor, grant or upstream call.

I2's owner should write an adapter from actual authenticated policy facts to these
semantic requests, execute I2, and compare only the defined projection fields.
Do not import a second policy implementation as the test oracle. The owner must
also exercise real app refusals with upstream counters at zero (ADR **Test
strategy**, opening paragraph). No such app execution is claimed here.

| Vector family | Exact ADR section | Requirement |
|---|---|---|
| `floor-*`, `l3-satisfies-l2` | Decision **1**, **3**, **7 items 1–2** | Ordered classes, strict workload/sensitivity floors; Decision 3 explicitly requires L3 for confidential `code_exec` |
| `compliance-*` | Decision **7 item 3**, **14** | MAX of all mapped tags; nullable unmapped tag never lowers a floor |
| `autonomyFloor-*`, `ownProfileFloor-*`, `parentRequiredClass-*` | Decision **7 items 4–6** | Every floor independently raises the result; low configured values cannot override other floors |
| `assurance-*` | Decision **7 item 5**, **2** | Missing identity or observed autonomy above declared uses most restrictive shipped profile (L3) |
| `refusal-*`, `no-fallback-*`, `engine-not-run` | Decision **7 first Then bullet**, **6**, **11 invariants**; Test strategy **No fallback** | Five fixed reasons, `409 execution_profile_unavailable`, rule `execution-profile`, no upstream contact, no lower retry/queue/restart; unavailable engine is `not_run/isolation_unavailable` |
| `customer-declared-*` | Decision **1**, **7 final bullet**, **11 customer_declared mapping** | Unmapped satisfies nothing; named admin mapping must be audited and stepped up; evidence remains `declared` |
| `non-isolable-*` | Decision **3** | Model/connector L0 and remote MCP `external`; no local sandbox label or invented isolation floor for remote upstream |
| `delegation-*`, `middle-actor-executor-*` | Decision **8 second/third bullets**, **11 child invariant**; Test strategy **Delegation** | Child class at least parent; invalid middle placement refuses leaf's next use |
| `sponsor-not-floor-override` | Decision **7 items 1–6**, **8** | Sponsor preference cannot lower project requirement; ADR0190 defines no separate sponsor-class input |
| `unknown-*`, `attestation-*`, `profile-mismatch-offer` | Decision **7**, **6**, **4 pull model**; Test strategy **Fail closed** | Unresolved facts never become an eligible selection; missing/failing reports remove class; offer must match profile |
| `audited-l1-*` | Decision **11 floors**, **2 profile relaxations**, **7** | Authorized relaxations affect their own inputs only, never erase another floor or move third-party code into gateway |
| `placement-report-mismatch` | Decision **6 per-placement report** | Before first input byte: refuse, kill, quarantine and alert |
| `openshell-gvisor-refused` | **Amendment F** | OpenShell gVisor placement refused; supersedes Decision 1's original OpenShell L2 clause |

The ADR requires identity authorization separately. It does not specify sponsor
or every actor's own isolation profile as additional Decision 7 MAX operands;
these fixtures do not invent those operands or reconstruct ADR0188 from memory.
They do cover parent inheritance and the executor checks on the live chain
explicitly required by Decision 8. An unknown agent invokes the explicit L3
fallback profile; unknown sensitivity/class/policy facts have no such default.
Null compliance floor is the explicitly nullable, resolved lack of a mapping,
not a missing policy lookup. L0/L1 are never labelled a sandbox.

Contract gaps are represented explicitly, with no fabricated HTTP code, reason
or successful wire example:

- `warn_conflict`: Decision 11 says `warn` means **“place at what is available,
  record the shortfall as a gate warning”**; the same table says **“Falling back
  to a lower class than required”** is **“never”**, **“not relaxable”**.
  Test strategy **Fail closed** also says warn is placed. Resolve this before
  accepting a shortfall positive. The fixture retains the required selectable
  floor and forbids fallback while leaving warning-mode behavior unresolved.
- `missing_fact_refusal`: unknown workload, sensitivity or resolved class is
  fail closed, but the ADR gives no exact error envelope for these invalid facts.
- `unmapped_reason`, `missing_failing_report_reason`, `profile_match_reason`:
  `execution_profile_unavailable` is specified, but reason selection for unmapped
  BYOC, missing/failing reports and wrong-profile offers is not explicit.
- `delegation_refusal_http`, `live_chain_refusal_envelope`,
  `mismatch_http_status`, `openshell_refusal_envelope`: the described refusal is
  required; the missing transport details are deliberately absent.
- `freshness_boundary`: exact 2 h equality, future timestamps and clock choice
  are unspecified; no boundary success is invented. Fixtures otherwise use
  resolved fresh/stale verdicts, not timestamps.
- Placement HTTP route/DTO, reason precedence across multiple failed executors,
  executor selection among multiple eligible offers, the full autonomy-class
  floor table, and `code_exec` confidential-floor relaxation are not specified.
  Each fixed-reason fixture isolates one fault. Autonomy floors are resolved
  semantic inputs; no unprovided autonomy mapping is asserted.

Run corpus integrity (Node built-ins only):

```sh
node packages/shared/test-vectors/placement/check-placement-corpus.mjs
```

It checks the frozen ADR blob, IDs, citations, complete workload/sensitivity and
parent/child matrices, the MAX projections, refusal coverage and no-fallback
constraints. Deliberate in-memory corruptions must fail, proving the checker
can detect wrong floors, lost refusal rules, invalid fallback, missing matrix
rows, swapped delegation outcomes, invented unknown-fact success, and removed
engine `not_run` behavior. This is corpus integrity, not I2 conformance or actual
runtime attestation. Synthetic identifiers contain no user or workload content.
