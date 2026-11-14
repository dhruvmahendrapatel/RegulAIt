<!-- fold: pending -->

**P8a — Remove the hand-written approval-rule matcher (ADR-0239 slice 2 follow-up, 2026-11-14, lane L1).** MCP
approval rules are matched on Cedar in the gateway since slice 2; the kernel keeps `matchingApprovalRules` as its
default (and `demo-relax-e-lib.ts` reads it) for one release. Next release: delete it as decision 4 did for rate
limits (no evaluator = refuse), keeping a transcription as the differential oracle. Data scope (slice 3) still waits
for a typed argument model.
