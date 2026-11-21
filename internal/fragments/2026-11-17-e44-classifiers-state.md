<!-- fold: state-recap -->
**2026-11-17 - lane E44 slice 2: customer classifiers inside the guardrail pipeline ([ADR-0363](../decisions/0363-classification-interop-and-ai-app-risk.md), migration `custom_classifiers` (pending, numbered at merge)).**
Admins define regex (RE2), keyword, dictionary and exact-data-match classifiers. EDM values are normalised and
HMAC-SHA256'd under a random deployment key (enveloped under the data key) on the write request; only digests are
stored. A version publishes only when a named reviewer who is not its author approves it in the one approvals queue
(`custom_classifier`); the lifecycle is one declared table (`CLASSIFIER_VERSION_TRANSITIONS`). Published classifiers run
in `evaluateGuardrails` at every guardrail site with their own mode; an EDM classifier without its key fails closed.
Retiring is a step-up. Six admin routes are API-only (#453).
