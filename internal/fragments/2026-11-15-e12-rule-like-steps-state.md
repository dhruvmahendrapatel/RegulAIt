<!-- fold: state-recap -->

**2026-11-15 - E12 slice 1: rule-like AI step detector ([ADR-0327](../decisions/0327-rule-like-ai-step-to-deterministic-rule.md), builder lane E12).**
`induceStepRule` in `@regulait/optimizer-kernel` finds the smallest set of input fields whose exact-match table
reproduces an AI step's enumerated output, with agreement measured on held-out folds and strict, org-tightenable
thresholds (200 runs, 0.99 agreement, 0.9 coverage; floors 50, 0.95, 0.5). Pure and read-only: no route, no migration.
Next slices: suggestion with savings, shadow mode, approval switch and one-action revert.
