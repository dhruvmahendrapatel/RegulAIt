# ADR-0002: Two-account AWS Organization for the foundation phase

- **Status**: Accepted
- **Date**: 2026-07-21

## Context
RegulAIt will eventually host governance/audit/PII-adjacent data for its own platform. A single
bare AWS account would commingle billing/Organizations/Identity-Center administration with
day-to-day build/deploy activity in the same account — the wrong blast radius for that kind of
data. A full Control Tower multi-OU landing zone, on the other hand, is built to automate
guardrails across *many* accounts/OUs; with exactly one workload account and no production tier
yet, that automation has nothing to manage and is pure overhead for day one.

## Decision
Use a two-account AWS Organization: a **Management** account (billing, Organizations, IAM
Identity Center, the org CloudTrail trail's log bucket — no compute, no app resources) and a
**Workload** account (`regulait-dev`, non-prod by construction) where all actual build/deploy
happens for now.

## Consequences
The audit trail lives somewhere the workload account's own admins — or a compromised deploy
role — cannot delete, at low setup cost. This structure is a strict subset of a future Control
Tower landing zone (e.g. once a second workload account or a prod tier is added), so there's no
rework later, only addition. No production account or environment is created as part of this
decision — that requires separate, explicit sign-off per the standing guardrail in
[CLAUDE.md](../../CLAUDE.md).
