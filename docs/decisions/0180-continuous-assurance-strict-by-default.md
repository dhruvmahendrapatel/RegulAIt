# ADR-0180: Continuous assurance (ADR-0175 batch D3), and secure-by-default as a standing rule

- **Status:** Accepted
- **Date:** 2026-10-05
- **Deciders:** owner
- **Builds on:** ADR-0175 (batch D3: A2, A3, A8, A10), ADR-0173 batch 2c (KRIs, monitor), ADR-0097/ADR-0100 (red team)

## Context

ADR-0175 batch D3 adds continuous assurance. It covers four items:
- **A2:** measurable conditions;
- **A3:** required AI test classes per risk tier;
- **A8:** agent autonomy class;
- **A10:** risk tolerance and time-boxed acceptance.

A code map showed what each item builds on:
- **Conditions:** today they are free text and closed by hand.
- **KRI registry:** it measures error rate, latency, trace cost and feedback score. Red-team runs, eval runs and the OWASP
  taxonomy already exist.
- **Deploy gate:** one route, which `demo:gate` also calls.
- **Builder agents:** they already record schedules, sub-agents, write tools, Ask-first and inbound channels, but nothing
  derives an autonomy class from them.
- **Risk acceptance:** it has no expiry, no compensating controls and no tolerance setting.

The product is not live yet. The only deployment is the owner's local demo copy.

## Decision

### 1. Standing rule: secure by default (owner, 2026-10-05)

Every new setting defaults to its strict, secure value, and an admin can relax or turn it off. Turning it off is a
deliberate, audited choice. Because nothing is live, features are built as for a first load: no grandfathering of existing
records and no warn-only introduction period, unless an ADR records a specific reason. This rule is added to `CLAUDE.md`.
Existing defaults that are not strict are listed in an audit and fixed in a follow-up batch.

### 2. Enforcement

- A new org setting, `assurance_gate_mode`, takes `off`, `warn` or `enforce` and **defaults to `enforce`**.
- It governs every D3 check at the deploy gate:
  - failing measurable conditions;
  - missing, stale or failing required tests;
  - unmet autonomy floors;
  - residual risk above tolerance.
- The checks run live against every use case. They are not attached only at new sign-offs.
- `warn` reports the checks without holding. `off` skips them, and the gate response says they were skipped.
- Changing the mode is admin-only and audited.

### 3. Measurable conditions (A2)

- A condition may carry a metric, an operator, a threshold, a window, a minimum sample size and a cadence. It is evaluated
  from the existing ledgers:
  - trace-evaluation flag rate;
  - guardrail mode and hits;
  - red-team attack-success rate;
  - eval scores;
  - spend, from the usage ledger;
  - error rate;
  - control evidenced in a pack.
- **Only passing evidence closes a metric condition.** A reviewer cannot mark one met by hand (422).
- An admin can **waive** a condition with a reason. The waiver is audited and shows as a gate warning, never as a pass.
- Too few samples reads `insufficient`, never `pass`.
- After go-live, a breach raises a monitor alert. A breach reopens review only when the condition says
  `on_breach = reopen_review` **and** two consecutive evaluations have breached.

### 4. Required AI test classes per risk tier (A3)

- Each review-policy tier lists its required test classes, keyed by OWASP LLM or agentic id. Defaults are strict for the
  higher tiers.
- A required test is satisfied only when all of these hold:
  - a completed red-team or eval run exists for every agent in the use case's stack;
  - the run used the stack's current configuration hash;
  - the class was measured, not reported as not-run;
  - its result is within the threshold;
  - the run is fresh: by default **at most 30 days old**. An admin may set up to 90.
- An OWASP id that no test class can measure (for example supply chain or data poisoning) cannot be made a required test.
  The setting refuses it rather than leaving it permanently unsatisfiable.
- The deploy gate checks required tests live, with the reasons `required_test_missing`, `required_test_stale` and
  `required_test_failing`.

### 5. Agent autonomy class (A8)

- The autonomy class is derived from observed facts:
  - schedules;
  - sub-agents and delegation;
  - write tools without Ask-first;
  - inbound channels;
  - computer use.
- A steward may also declare a class. A declared class lower than the observed one is flagged.
- When nothing is declared, the observed class applies.
- Each class sets a control floor. Approval and the deploy gate check it, and the monitor watches it.
- Builder agents count toward a use case through their shared project, the same join the unregistered-traffic monitor
  uses. The UI states this limit.

### 6. Risk tolerance and time-boxed acceptance (A10)

- Each risk category or tier has an org tolerance. **By default it is strict:** any residual risk above `medium` needs a
  valid acceptance.
- An acceptance records:
  - a response type;
  - an expiry, at most **6 months** for high or critical residual risk and **12 months** otherwise;
  - a rationale;
  - its compensating controls.
- Acceptances keep their history. An expired acceptance reopens its risk.
- Residual risk above tolerance with no valid acceptance raises an alert and holds the gate (`residual_above_tolerance`).
- The existing `use_case_inherited_high_risk` alert is unchanged.

### 7. Demo

- The local demo must still prepare cleanly.
- Its story is updated so the new checks show truthfully:
  - the seeded evidence satisfies them where the story says the use case is ready;
  - the blocked production gate gains the D3 reasons that are really true of the seeded data.

## Consequences

- The deploy gate now holds on missing evidence, not only on missing approvals. This is the intended strict posture, and an
  admin can turn it off.
- New metrics read existing ledgers. Guardrail hits need a partial index on `audit_log`.
- Migration **0155** onward.

## Implementation (2026-10-05)

Built from five branches:
- **P0, the foundation:** migration **0155**, the shared contract in `assurance.ts`, the monitor rules, the
  `assurance_gate_mode` setting and route stubs.
- **A2:** measurable conditions.
- **A3:** required tests, the gate composition and the demo.
- **A8:** autonomy class.
- **A10:** risk tolerance.

Two security reviews followed, with three fix rounds. No migration besides 0155 was needed, and the next migration is
**0156**.

- **Gate.**
  - `assurance_gate_mode` is enforce by default. It is written only by the audited, admin-only
    `PUT /v1/org/settings/assurance-gate-mode`.
  - Each of the four checks runs inside an error guard. A check that throws or was not gathered gives
    `assurance_check_unavailable`, which blocks under enforce. Only a `satisfied` required-test state passes
    (allow-list).
  - `off` skips only the D3 reasons, and the response says so.
  - Alerts from the six assurance monitor rules are not re-read as `open_high_alert`, because their live checks
    govern them.
- **Measurable conditions (A2).**
  - Nine metrics are read from the existing ledgers. Spend reads `usage_events`.
  - Red-team and eval metrics are judged on the **weakest agent** in the stack, never pooled.
  - Too few samples, or an agent whose newest run measured nothing, reads `insufficient`.
  - Only the evaluator closes a measured condition; a manual `/met` returns 422. An admin waiver is audited and shows
    as a warning.
  - Each cadence window counts once toward the breach streak.
  - `reopen_review` reopens review once the streak reaches 2 or more while the use case is approved, then resets the
    streak. A skipped reopen is audited.
  - The monitor reads stored evaluations.
- **Required tests (A3).**
  - Every tier requires LLM01. The high, prohibited and unscreened tiers also require LLM02, LLM06 and every agentic
    class a red-team class measures (ASI01, ASI02, ASI06, ASI10), at 0% attack success and 30 days fresh. Eval-only
    classes default to a minimum mean score of 0.8.
  - An OWASP id is measurable only if the evaluator catalog cites it; otherwise the policy refuses it.
  - Evidence must meet a fixed bar that admins cannot relax (`REQUIRED_TEST_EVIDENCE_BAR`):
    - at least 3 trials per probe and a measured-quality label;
    - every attack class mapped to the id covered, by trials that **reached the agent** (probes the platform held,
      for example for budget or entitlement, never count);
    - at least 5 results per mapped eval scorer.
  - The newest run that meets the bar decides. Runs whose configuration hash was adopted by the legacy-pin sweep are
    not evidence.
- **Autonomy (A8).**
  - Nine derivation rules set the class.
  - The floors are cumulative:
    - supervised: prompt-injection and jailbreak guardrails at warn or above;
    - delegated: both at block, an approved model card, and the agentic red-team classes measured within 30 days;
    - autonomous: a monthly spend limit, those classes passing, and Ask-first on every write tool.
  - The floor follows the stricter of the declared and observed class. Builder agents count toward a use case by
    project.
- **Risk tolerance (A10).**
  - The residual band is the register's 3×3 rating. A risk's tolerance is the stricter of its category's and its
    tier's, and a scope with no configured row counts at the strict default (medium), so relaxing one scope never
    relaxes another.
  - Acceptances are recorded by an admin or a named acceptor, never the use case's owner. Every acceptance path,
    including sign-off, writes a time-boxed row: 6 months for high or critical residual risk, 12 months otherwise.
  - Compensating controls must name a real pack control.
  - An expiry sweep reopens the risk. It audits as the system and records any admin who started it as `requestedBy`.
- **Load order.** An import cycle (`inventory → … → risk-tolerance → governance-monitor → autonomy → mrm → … →
  inventory`) crashed `demo:prepare`. `risk-tolerance.ts` now loads `review-policy` and `governance-monitor` lazily,
  and `adr0180-load-order.test.ts` imports each built module first to keep it fixed.
- **Demo.**
  - `demo:prepare` passes 18/18.
  - The seeded *Demo assurance suite* runs meet the evidence bar.
  - Fraud Detection carries a seeded six-month `mitigate_partially` acceptance with two compensating controls.
  - The production `demo:gate` still blocks on its two HIGH alerts.
