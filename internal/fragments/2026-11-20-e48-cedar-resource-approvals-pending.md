<!-- fold: pending -->

**P8b — Remove the hand-written resource approval-rule matcher (ADR-0239 slice 2b follow-up, 2026-11-20, lane E48).**
The gateway has matched model, connector and A2A approval rules on Cedar since slice 2b. The kernel keeps
`matchingResourceApprovalRules` as `composeResourceDecision`'s default for one release. In the next release, together
with P8a: refuse when no evaluator is given, and keep a transcription as the differential oracle. Resource rate
limits are still hand-written, and they move into the same request if a third rule type joins.
