<!-- fold: state-recap -->

**2026-11-15 - E12 slice 2: rule-like step scan and suggestions ([ADR-0327](../decisions/0327-rule-like-ai-step-to-deterministic-rule.md), builder lane E12, migration `rule_step_detection` (numbered at merge)).**
Off by default; enabling or lowering a threshold is a step-up. `POST /v1/rule-steps/scan` reads recent model spans per
step, keeps JSON-object inputs with complete outputs, and stores suggestions with a readable rule, history test cases
and a projected monthly saving; nothing changes routing. Five admin routes are known UI gaps for UI-D. Next: shadow
mode, then the approval switch and one-action revert.
