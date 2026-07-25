# 0013 — Dev app deployment: one EC2 box running docker compose, SSM-only, separate Terraform state

Date: 2026-07-25
Status: Accepted

## Context

The product became locally runnable (`docker compose up --build`, PR #23) but the user cannot
run it locally and asked for an AWS deployment to test look-and-feel. EPIC-01's foundation
(two-account org, Identity Center, security baseline) exists, but no compute has ever been
deployed. This is a throwaway demo stack, not the product's own hosted/BYOC deployment model
(pillar 3) — and per the standing guardrail it is explicitly **not** production.

## Decision

1. **Reuse the compose file as the unit of deployment.** A new project-agnostic module
   `infra/modules/app-instance` boots a single AL2023 EC2 instance that downloads a source
   tarball from a module-owned private S3 bucket and runs `docker compose up -d --build`
   on-instance. What the user would run locally is exactly what runs in AWS — no second
   deployment path to maintain.
2. **Separate state.** The stack lives in `infra/environments/regulait-dev-app` with its own
   state key (`regulait-dev-app/terraform.tfstate`) in the same bootstrap backend, so an app
   deploy can never re-plan the org/security-baseline stack in `regulait-dev`.
3. **No SSH.** Operator access is SSM Session Manager only (no keypair exists); the instance
   role carries `AmazonSSMManagedInstanceCore` plus read-only access to the source bucket.
   IMDSv2 is required.
4. **Per-deploy runtime config.** User-data generates a fresh `REGULAIT_DATA_KEY` and
   `REGULAIT_BOOTSTRAP_TOKEN` on every boot via a compose override file — the checked-in dev
   defaults never run in AWS.
5. **Accepted dev-grade tradeoffs**, revisited only if the stack outlives demo use: HTTP only
   (no TLS/domain), port 3000 open to 0.0.0.0/0 (all APIs are key-gated; secrets are
   per-deploy random), single instance with no ALB/ASG/RDS, demo seed data, and instance cost
   (~$15–30/month) that will trip the $5 foundation budget alert while it runs.

## Consequences

- Teardown is `terraform destroy` in `regulait-dev-app` (bucket has `force_destroy`).
- The module is reusable for future single-box demo stacks of any compose-based project.
- Anything beyond demo use (TLS, managed Postgres, autoscaling, a production designation)
  requires a new decision and, per the standing guardrail, explicit user sign-off.
