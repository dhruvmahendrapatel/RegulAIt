# ADR-0325: BYOC on AWS as a durable product path: a customer-run Terraform stack, rehearsed in regulait-dev through a GitHub OIDC role

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

The first direction (2026-11-15, morning) was a two-week pilot: BYOC in the customer's AWS account, with all data
staying there, installed by the customer's own team from our runbook in under a day. The owner revised it the same
day: **the pilot is no longer the driver.** It is handled separately and not in this lane, and no pilot branch is
created here. This ADR builds the durable product path. It has three parts:

- reusable, project-agnostic Terraform modules in `infra/modules/`;
- a repeatable install and teardown that any customer can run in their own account, within a working day;
- the regulait-dev rehearsal as the automated test of that path, repeatable on every change, without anyone holding
  an AWS key.

We have never applied the BYOC stack to a real AWS account, so the rehearsal comes first.

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

### PR 2: the BYOC AWS module

- **`infra/modules/byoc-aws`** builds what the Helm chart runs on, inside the customer's account (details in its
  README): a VPC over two zones; egress `allow_list` (default: AWS Network Firewall, strict rule order, TLS SNI allow-list
  of `egress_allowed_domains`, default only `login.microsoftonline.com`, everything else dropped and logged) or `none`;
  VPC endpoints for every AWS API the stack uses, so AWS traffic never crosses the firewall; EKS (private API
  endpoint by default, `0.0.0.0/0` refused, access entries only, KMS envelope encryption, control-plane audit logs,
  IMDSv2 hop limit 1, VPC CNI with NetworkPolicy enforcement on, EBS CSI and Pod Identity add-ons); RDS PostgreSQL 16
  (stack key, TLS forced, Multi-AZ, 14-day PITR, final snapshot, deletion protection, RDS-managed master secret); one
  rotating KMS key; the audit-anchor Object Lock bucket in COMPLIANCE mode through `audit-anchor-worm-s3`; a gateway
  Pod Identity role that may invoke only the listed Bedrock models and write anchors; private ECR repositories
  (immutable, scanned) and a `public.ecr.aws` pull-through cache.
- **`infra/environments/byoc-aws`** is the root the customer applies; the rehearsal applies the same root with
  `rehearsal.tfvars.example`, so the rehearsal exercises the customer's exact path.
- **Data boundary**: both the control plane and the agent-execution plane run in the customer's account, and nothing
  goes to the vendor. The product has no channel to us (DATA_BOUNDARY.md §1) and the stack opens none. The brief's
  "metadata only to our control plane" has no counterpart in the product today. Adding one would be a new, opt-in data
  path that needs its own ADR, so it is not built (owner note).
- **Egress posture (ADR-0062)**: strict on both layers by default. At the network layer, the firewall allow-list
  passes only the listed hosts. At the app layer, the org setting `egressCompiledDefaultPolicy` defaults to `strict`
  (since ADR-0180), so a `byoc` install also checks compiled vendor endpoints against `egress_allow_hosts`. The
  runbook has the installer confirm it and add the same hosts there.
- **Preflight** `infra/modules/byoc-aws/preflight/preflight.sh` (read-only): tools, signed-in account, region and
  zones, quotas, Network Firewall and endpoint availability, Bedrock model access, and free names.

### PR 3: the install runbook and the rehearsal workflow

- **[docs/deployment/BYOC_AWS_INSTALL.md](../../docs/deployment/BYOC_AWS_INSTALL.md)** is written for a platform
  team that does not know RegulAIt. It runs about two hours hands-on plus about 45 minutes of waiting, and covers
  prerequisites, quotas and Bedrock access, bundle verification, preflight, one `terraform apply`, the chart install
  (images mirrored into the customer's ECR, secrets generated in place, the data-key warning), the internal ALB, the
  first admin, Entra ID OIDC, the smoke test, upgrade and rollback, uninstall (the COMPLIANCE bucket is kept as
  evidence), the support bundle, the data boundary and the known gaps.
- **`infra/modules/byoc-aws/smoke/smoke-test.sh`** runs its checks from short-lived pods under the gateway's own
  namespace and service account, using images by digest through the ECR pull-through cache. It checks that:
  - nodes are Ready;
  - the pod gets the gateway role through Pod Identity;
  - the bucket has Object Lock, and (optionally) a delete of a probe object is refused;
  - one Bedrock Converse call works;
  - the database accepts TLS and refuses plain connections;
  - an allow-listed host is reachable and `example.com` is not;
  - default-deny NetworkPolicy is enforced.

  **`support-bundle.sh`** collects statuses, events and the last 500 log lines, with no secret values and no state,
  and the installer reviews it before sending.
- **`.github/workflows/byoc-rehearsal.yml`** runs on manual dispatch, in the `rehearsal` environment, so a reviewer
  must approve each run. It:
  - exchanges the job's OIDC token for a three-hour session of the rehearsal role with the AWS CLI (no third-party
    action);
  - refuses any account but the one in the role ARN, and masks that account ID in the public logs;
  - runs the preflight, applies the customer root with `rehearsal.tfvars.example` (Kubernetes API open to the
    runner's /32 only), and runs the smoke test with the WORM probe;
  - **always** destroys, after `infra/scripts/byoc-rehearsal-sweep.sh` empties the GOVERNANCE-mode rehearsal bucket
    and the cache repositories (the sweep refuses any prefix that is not `regulait-rehearsal*`, and any bucket in
    COMPLIANCE mode);
  - lists anything still tagged `purpose=rehearsal`, and writes every step's start, duration and result to the run
    summary, which the lane copies into its PR.

### Open source first (ADR-0176)

Searched: `terraform-aws-modules/iam` (Apache-2.0) has `iam-github-oidc-provider` and `iam-github-oidc-role`
submodules. Its role submodule matches `sub` with `StringLike` and attaches managed policy ARNs; it does not take an
inline boundary-scoped policy or refuse a wildcard subject. Our module already existed and is ~100 lines, so it is
extended rather than replaced; the boundary and deployer policy are RegulAIt's governance semantics (what an
installer may do), which ADR-0176 §4 keeps in house. PR 2 uses `terraform-aws-modules` vpc 6.7.3, eks 21.29.0 and rds 7.2.2 (Apache-2.0) rather than hand-written
network, cluster and database code. The firewall routing, Pod Identity roles and Bedrock grant are a few resources
with no maintained module that fits the strict allow-list, so they are written here.

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
