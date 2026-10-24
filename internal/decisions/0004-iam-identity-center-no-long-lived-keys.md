# ADR-0004: IAM Identity Center only, no long-lived IAM keys

- **Status**: Accepted
- **Date**: 2026-07-21

## Context
The user set an explicit, non-negotiable security bar ("fort when it comes to security, no
compromises") for this project. Long-lived IAM access keys are a standing credential-leak risk —
if they end up in a repo, a log, or an agent's context by accident, they're valid until manually
rotated or revoked, with no natural expiry.

## Decision
All human and agent access to AWS goes through IAM Identity Center (SSO): short-lived, browser-
MFA'd STS credentials only. No IAM user access keys are created for this project, ever. Three
minimal permission sets — `Admin-BreakGlass`, `Deploy-Builder` (used for routine agent/CLI work,
explicitly denied from touching Organizations/SSO-admin/guardrail services or escalating its own
privilege), `ReadOnly-Audit` — with no self-escalation path between them. Future CI/CD
(GitHub Actions) authenticates via OIDC federation into a scoped IAM role, never static keys in
GitHub secrets.

## Consequences
Every session's AWS access requires a human to complete a browser + MFA step
(`aws sso login`) before agent-driven CLI/Terraform work can proceed — a recurring, unavoidable
touchpoint, not a one-time setup cost. In exchange, there is no long-lived secret anywhere in
this project that a leaked file, log, or context window could turn into standing AWS access.
