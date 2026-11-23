<!-- fold: state-recap -->
**2026-11-17 - lane E44 slice 3: risk attributes for AI apps ([ADR-0363](../decisions/0363-classification-interop-and-ai-app-risk.md), no migration).**
A curated, frozen and hash-pinned dataset (v1, 10 providers) records training on customer data, retention, hosting
regions, certifications, SSO and the sub-processor list, each value with the vendor page it was read from and the date
(2026-11-17); every value not stated on the vendor's own page is `unknown`, and `unknown` scores as risk. The score is
the sum of its shown factors. `GET /v1/shadow-ai/risk` ranks the inventory and suggests (never applies) a site rule;
`GET /v1/ai-app-risk` serves the dataset with its canonical digest for Codex lane C2's signed feed. API-only (#453).
