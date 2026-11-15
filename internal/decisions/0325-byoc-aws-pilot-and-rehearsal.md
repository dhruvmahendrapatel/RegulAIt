# ADR-0325: BYOC on AWS for the pilot: a customer-run Terraform stack, rehearsed in regulait-dev through a GitHub OIDC role

- **Status**: Accepted (owner direction 2026-11-15, lane E10 brief)
- **Date**: 2026-11-15
- **Index**: **BYOC on AWS (pillar 3): a customer-run Terraform module installs RegulAIt into the customer's own account, and every change is rehearsed in regulait-dev by a GitHub Actions job that assumes an OIDC role pinned to this repository's `rehearsal` environment.** The role's boundary (`aws-byoc-deployer-policy`) allows only the stack's services, in one region, on resources named `regulait-rehearsal-*` and tagged `purpose=rehearsal`, and denies self-escalation and anything tagged as production. The owner applies the role once; the rehearsal always destroys what it built.
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
- **`infra/modules/aws-byoc-deployer-policy`** (new, project-agnostic) produces two documents:
  - the **boundary**, attached to the deployer and, by condition, to every role the deployer creates: only the
    stack's services (EC2/VPC, EKS, RDS, KMS, S3, CloudWatch Logs, Secrets Manager, ELB, Auto Scaling, Network
    Firewall, ACM, ECR, Bedrock invoke and read, Service Quotas read, IAM); a region lock (IAM and STS exempt);
    no IAM users, access keys, login profiles or boundary removal, and no policy versions outside the stack's own
    `<prefix>-*` policies; the boundary policy and the deployer role are immutable; no Organizations, account, SSO or billing action; and any action on a resource, or
    a request, tagged `environment`/`env`/`stage`/`purpose` matching `prod`, `prod-*`, `*-prod`, `production` or
    `*production*` is denied.
  - the **deployer policy**, narrower: IAM roles and instance profiles only named `<prefix>-*`, created only with the
    boundary; managed policies only `<prefix>-*` (modules such as the EKS one create their own) or listed AWS-managed
    ones (EKS, ECR read, SSM core, EBS CSI, RDS monitoring); `PassRole` only to EKS, EC2, RDS monitoring, EKS Pod
    Identity and VPC Flow Logs; S3 only on `<prefix>-*` buckets; ECR only on `<prefix>*` repositories and their
    pull-through cache rules; the stack's
    root resources (VPC, EKS cluster, RDS instance, KMS key, Network Firewall) created only with the scope tag and
    deleted only if they carry it.
  The same module is offered to the customer for their own installer role (PR 3 runbook).
- **`infra/environments/regulait-dev-rehearsal-role`** composes the two for regulait-dev: prefix
  `regulait-rehearsal`, scope tag `purpose=rehearsal`, environment `rehearsal`, sessions up to three hours. Its
  providers set `allowed_account_ids` to the one workload account, so Terraform refuses any other account whatever
  the profile resolves to. No account ID, repository owner or email is committed: they live in the owner's
  git-ignored `terraform.tfvars` and in the GitHub environment's `REHEARSAL_ROLE_ARN` variable.
- **The owner applies it once**, from their own machine with an Identity Center session
  ([docs/ops/BYOC_REHEARSAL_ROLE.md](../../docs/ops/BYOC_REHEARSAL_ROLE.md)). No builder session applies it.
- **CI**: `infra-terraform.yml` runs `fmt`, `validate` and the modules' offline `terraform test` (plan-only, fake
  credentials, account lookups overridden). Terraform is installed by `infra/scripts/install-terraform.sh`, pinned to
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

## Consequences

- A rehearsal can run without anyone holding an AWS credential, and only after a required reviewer approves the
  `rehearsal` environment deployment.
- The boundary is deliberately tight, so the first rehearsal may hit an `AccessDenied` the stack needs. Each such snag
  is recorded in the PR and fixed in the module; the owner re-applies the role (the same one command).
- Workload roles the stack creates carry the same boundary, so they too can never touch a production-tagged resource
  or leave the region.
- Follow-ups are in PRs 2 and 3: the BYOC module (VPC, EKS, RDS, KMS, S3 Object Lock, Bedrock, the ADR-0062 egress
  allow-list), the preflight checker, the customer runbook, and the `byoc-rehearsal` workflow that always destroys.
