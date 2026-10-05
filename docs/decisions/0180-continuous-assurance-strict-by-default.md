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
