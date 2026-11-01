# demo-host (ADR-0228)

The demo stack on ONE hardened EC2 instance, in its own member account of the company AWS Organization. A demo
environment, never production (CLAUDE.md standing guardrail). Fargate, RDS, WAF and HA come after the demo as the
ADR-0013 successor.

| Stack | Account | What it holds |
| --- | --- | --- |
| `account/` | company (management) | the `regulait-demo-host` member account, its budget alert and guardrail SCP |
| `baseline/` | management + demo-host | `modules/aws-security-baseline`: org CloudTrail, GuardDuty, Security Hub, Config, SCPs, budget |
| `host/` | demo-host | the instance (no SSH key, no ingress, IMDSv2, KMS-encrypted root and data volumes), its least-privilege role, container logs, nightly encrypted pg_dump backups, an optional power schedule (off) |

Apply order, owner steps and rollback: `internal/product/DEMO_RUNBOOK.md` §8. Every credential is a short-lived IAM
Identity Center session (ADR-0004); the member account is reached by assuming the role Organizations created in it,
exactly as `demo-sandbox/` does. Nothing here holds an account id: they come from git-ignored `terraform.tfvars`.
