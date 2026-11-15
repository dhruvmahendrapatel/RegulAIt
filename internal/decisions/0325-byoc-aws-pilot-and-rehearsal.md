# ADR-0325: BYOC on AWS for the pilot: a customer-run Terraform stack, rehearsed in regulait-dev through a GitHub OIDC role

- **Status**: Accepted (owner direction 2026-11-15, lane E10 brief)
- **Date**: 2026-11-15
- **Index**: **BYOC on AWS (pillar 3): a customer-run Terraform module installs RegulAIt into the customer's own account, and every change is rehearsed in regulait-dev by a GitHub Actions job that assumes an OIDC role pinned to this repository's `rehearsal` environment.** Two boundaries (`aws-byoc-deployer-policy`) do the limiting. The deployer's boundary allows IAM writes only under `regulait-rehearsal-*`, and only to create roles that carry the workload boundary; it allows no trust edits, users or keys. Roles the deployer creates carry the workload boundary: no IAM write, nothing in a federated session, and data and changes only on the stack's own resources. Those are identified by name where the ARN has one and by the `purpose=rehearsal` tag where it does not. Every create carries that tag, and anything tagged as production is denied. The owner applies the role once; the rehearsal always destroys what it built.
- **Built in**: lane E10, three PRs (1: the rehearsal role; 2: the BYOC AWS module and preflight; 3: the customer runbook and the `byoc-rehearsal` workflow)
- **Migration**: none
- **Related**: [ADR-0002](0002-two-account-aws-foundation.md) and [ADR-0004](0004-iam-identity-center-no-long-lived-keys.md) (no long-lived keys), [ADR-0003](0003-terraform-over-cloudformation.md) (Terraform authoritative),
  [ADR-0015](0015-byoc-deploy-modes-data-boundary.md) and [ADR-0041](0041-byoc-primary-motion.md) (BYOC modes, data boundary),
  [ADR-0062](0062-mode-scoped-egress.md) (mode-scoped egress), [ADR-0304](0304-kubernetes-operator-and-helm-chart.md)
  (operator and Helm chart), ADR-0176 (open source first), ADR-0180 (secure by default)

## Context

The owner has a pilot with a large engineering organisation in about two weeks (direction 2026-11-15). It runs BYOC in
the customer's AWS account, all pilot data stays in that account, and the customer's own team installs it from our
runbook in under a day. We have never applied the BYOC stack to a real AWS account, so the runbook needs a rehearsal
that we can repeat on every change, without anyone holding an AWS key.

The owner authorised (2026-11-15, exact scope) `terraform apply` into **our dev account regulait-dev only**:
non-production, every resource tagged `purpose=rehearsal`, torn down after each rehearsal, every apply logged in the
PR, through a GitHub Actions OIDC role with a tight permissions boundary that the owner applies once. Nothing may be
named, tagged or designated production.

## Decision

### PR 1: the rehearsal role

- **`infra/modules/github-oidc-role`** gains *environment roles*: a role whose trust is
  `StringEquals` on `aud = sts.amazonaws.com` and `sub = repo:<owner>/<repo>:environment:<name>`. GitHub issues that
  subject only to a job that runs in that environment, so the environment's protection rules (required reviewers)
  gate every assumption. A wildcard environment name is refused. The provider can be reused
  (`create_oidc_provider = false`) and the original plan/deploy branch roles can be turned off; the defaults keep the
  old behaviour.
- **`infra/modules/aws-byoc-deployer-policy`** is new and project-agnostic. It produces three documents. They were
  revised after the security and code reviews of #854 (below).
  - **The deployer boundary** applies to the deployer role.
    - It allows the stack's services. IAM writes are allowed only on `<prefix>-*` roles, policies and instance
      profiles and on EKS OIDC providers.
    - Explicit denies:
      - `CreateRole` and `PutRolePermissionsBoundary` unless the boundary is the **workload** boundary;
      - `AttachRolePolicy` unless the policy is one of the listed AWS-managed ones or `<prefix>-*`;
      - every role change, and `PassRole`, outside `<prefix>-*`;
      - `UpdateAssumeRolePolicy`, everywhere;
      - OIDC providers other than EKS ones;
      - IAM users, access keys, login profiles and SAML providers;
      - boundary removal;
      - policy versions outside `<prefix>-*`.
    - Both boundaries and the deployer role are immutable.
    - Region lock. Production-tagged resources and requests are denied.
  - **The workload boundary** applies to every role the deployer creates: the EKS cluster and nodes, VPC CNI, EBS CSI,
    the load balancer controller, the gateway, RDS monitoring and flow logs.
    - **It allows no IAM write except service-linked roles**, and it does not reach Secrets Manager, RDS or Network
      Firewall. A stack role therefore cannot make or widen a role, so the escalation path the review found (a stack
      role with inline IAM passed to EC2) is closed.
    - **Any web-identity session is denied** (`aws:FederatedProvider` present). A role left behind with a GitHub trust
      therefore gets nothing, and the environment's reviewers cannot be skipped through it. Stack roles are only ever
      assumed by AWS services.
    - KMS keys and EC2 structure changes (instances, volumes, snapshots, routes, subnets, VPCs, gateways, endpoints)
      are allowed only when the resource is scope-tagged. The scope tag cannot be added to an existing EC2 resource.
    - S3, CloudWatch Logs and ECR writes are allowed only on `<prefix>` names.
    - Region lock, and production is denied.
  - **The deployer policy** is the deployer's own inline grant, made immutable by its boundary.
    - It holds the scoped IAM grants.
    - Data and mutation are limited to the stack's own resources:
      - by name where the ARN carries one: RDS (clusters included), Secrets Manager (RDS-managed secrets recognised by
        their `aws:rds:primaryDBInstanceArn` tag), Logs, EKS, Network Firewall, S3 and ECR;
      - by the scope tag where it does not: KMS and EC2, and security groups as well for the deployer.
    - Every create that supports tag-on-create must carry the scope tag, IAM roles included, so the rehearsal sweep
      finds anything left behind.
  - **What IAM cannot express** is recorded rather than claimed:
    - **Trust-policy content.** The controls are: no trust edits; roles only under the prefix and only tagged; the
      workload boundary (no IAM, no federated sessions); and CloudTrail, which records every `CreateRole` with its
      trust.
    - **Security groups and network interfaces that EKS, the VPC CNI and the load balancer controller create
      untagged.** Only the deployer's own changes to them are tag-limited.
  - The same module is offered to the customer for their own installer role (PR 3 runbook).
- **`infra/environments/regulait-dev-rehearsal-role`** composes the two for regulait-dev: prefix
  `regulait-rehearsal`, scope tag `purpose=rehearsal`, environment `rehearsal`, sessions up to three hours. Its
  providers set `allowed_account_ids` to the one workload account, so Terraform refuses any other account whatever
  the profile resolves to. No account ID, repository owner or email is committed: they live in the owner's
  git-ignored `terraform.tfvars` and in the GitHub environment's `REHEARSAL_ROLE_ARN` variable.
- **Optional repository-ID pin.** With `github_repository_id` set, and the repository's OIDC subject template
  customised, the trust is `repository_id:<id>:environment:rehearsal`. A renamed or re-created repository cannot
  inherit it. The fork-reachable branch roles of `github-oidc-role` are now off by default (ADR-0180).
- **The owner applies it once**, from their own machine with an Identity Center session
  ([docs/ops/BYOC_REHEARSAL_ROLE.md](../../docs/ops/BYOC_REHEARSAL_ROLE.md)). No builder session applies it.
- **CI**: `infra-terraform.yml` runs `fmt`, each root's `validate`, and the modules' offline `terraform test`
  (plan-only, fake credentials, account lookups overridden). The tests render the three policy documents and assert
  each guard above. That includes a test that fails if either boundary allows creating a role without the workload
  boundary, and the managed-policy size limits. Terraform is installed by `infra/scripts/install-terraform.sh`, pinned to
  1.16.7 (terraform-aws-modules/rds 7.x needs 1.11 or later) with its SHA-256 committed.

### Open source first (ADR-0176)

Searched: `terraform-aws-modules/iam` (Apache-2.0) has `iam-github-oidc-provider` and `iam-github-oidc-role`
submodules. Its role submodule matches `sub` with `StringLike` and attaches managed policy ARNs; it does not take an
inline boundary-scoped policy or refuse a wildcard subject. Our module already existed and is ~100 lines, so it is
extended rather than replaced; the boundary and deployer policy are RegulAIt's governance semantics (what an
installer may do), which ADR-0176 §4 keeps in house. `terraform-aws-modules` is the first choice for PR 2's VPC, EKS
and RDS.

### Review of #854 (2026-11-15)

Both reviews returned REQUEST CHANGES at `920608be`. Each finding is addressed in the revision above.

- **Blocking: boundary escape to admin.** The boundary allowed `iam:*` on `*`. Fixed with two boundaries, scoped
  IAM, explicit denies, and a workload boundary with no IAM writes.
- **Blocking: reviewer gate bypass through a leftover role.** Fixed with no `UpdateAssumeRolePolicy`, the workload
  boundary's federated deny, tagged roles, and a sweep that finds them.
- **Blocking: account-wide data access.** Fixed with name and tag guards on Secrets Manager, KMS, RDS, Logs, EKS,
  Network Firewall, S3, ECR and EC2, and tag-on-create for every create.
- **Non-blocking items, all done:**
  - repository-ID pin;
  - branch roles off by default;
  - provider upper bounds;
  - the existing provider ARN checked against the account;
  - a pending fragment;
  - the apply log kept as a redacted plan and apply record;
  - "Prevent self-review" guidance;
  - the runbook and the index line corrected.
- **Not done: a separate IAM policy-analysis tool in CI.** The rendered-policy tests cover the same ground. Checkov's
  generic IAM checks do not express these guards.

## Consequences

- A rehearsal can run without anyone holding an AWS credential, and only after a required reviewer approves the
  `rehearsal` environment deployment.
- The boundary is deliberately tight, so the first rehearsal may hit an `AccessDenied` the stack needs. Each such snag
  is recorded in the PR and fixed in the module; the owner re-applies the role (the same one command).
- Workload roles the stack creates carry the same boundary, so they too can never touch a production-tagged resource
  or leave the region.
- Follow-ups are in PRs 2 and 3: the BYOC module (VPC, EKS, RDS, KMS, S3 Object Lock, Bedrock, the ADR-0062 egress
  allow-list), the preflight checker, the customer runbook, and the `byoc-rehearsal` workflow that always destroys.
