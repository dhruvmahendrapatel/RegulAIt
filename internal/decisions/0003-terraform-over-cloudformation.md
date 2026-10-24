# ADR-0003: Terraform as the authoritative IaC tool

- **Status**: Accepted
- **Date**: 2026-07-21

## Context
CloudFormation/CDK was the initial default recommendation (no state-file bootstrapping problem —
AWS manages state server-side; native drift detection and StackSets for future multi-account
rollout; one fewer binary to install/secure on a no-admin machine). The user explicitly requested
Terraform instead, specifically so the same modules can be reused to deploy other, unrelated
infrastructure later — a goal CloudFormation doesn't serve well since it has no meaningful
existence outside AWS.

Adopting Terraform reopens a problem CloudFormation avoids for free: Terraform needs a place to
put its state before it can manage anything, including — awkwardly — the resources that would
hold that state.

## Decision
Terraform is the authoritative IaC tool for RegulAIt's infrastructure, both AWS and (later) any
non-AWS resources. The state-backend chicken-and-egg problem is resolved by bootstrapping the
backend (an S3 bucket + a DynamoDB lock table) with three plain `aws` CLI commands in
`infra/bootstrap/` — not Terraform — once, in the Management account. This keeps state fully
inside the user's own AWS account rather than introducing a third-party SaaS trust boundary
(e.g. Terraform Cloud), consistent with the "fort-level security, no compromises" bar. Everything
else is real Terraform: `infra/modules/` holds reusable, project-agnostic modules;
`infra/environments/<name>/` composes them into an actual deployed stack per project.

## Consequences
Every future infra change is written once, in Terraform, reviewed via PR before `terraform
apply` — no CloudFormation stacks to keep in sync. The `infra/modules/` directory is directly
reusable by future, unrelated projects (just add a new `environments/<name>/`), which was the
explicit reason for this choice. Trade-off accepted: an extra one-time manual/CLI bootstrap step
for the state backend, and one more binary (Terraform itself) to install, verify (checksum +
GPG signature against HashiCorp's published key), and keep patched on a no-admin machine.
