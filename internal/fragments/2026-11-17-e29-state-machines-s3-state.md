<!-- fold: state-recap -->
**2026-11-17 - lane E29, declared state machines slice 3 ([ADR-0348](../decisions/0348-declared-state-machines.md)).**
Eight lifecycles are declared in `@regulait/shared` (`STATE_MACHINES`) and readable by agents at
`GET /v1/state-machines`. This slice guarded use cases (return, retire, review re-open), approvals (review-round
supersede), red-team library publish, shadow-AI dispositions, the four infra proposals, the skill re-scan and the
billing close; each race it closes has a test that fails on the old code. Every machine with F×S ≥ 5 in
[STATE_MACHINES.md](../product/STATE_MACHINES.md) is now done; the follow-ups wait on other lanes' files or on a CHECK
migration batch. No migration.
