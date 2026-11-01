# ADR-0228: The demo runs on one hardened EC2 host in the company AWS Organization; Fargate comes after

- **Status**: Accepted (owner decision 2026-11-01, master session; the owner runs every plan and apply)
- **Date**: 2026-11-01
- **Amends**: [ADR-0203](0203-demo-hosting-after-aws-org-loss.md) decision 1 (laptop hosting), and brings forward
  part of its decision 3 (AWS hosting of the control plane)
- **Related**: ADR-0002, ADR-0003, ADR-0004, [ADR-0013](0013-dev-app-deploy-single-ec2-compose.md), ADR-0035,
  ADR-0197, ADR-0202

## Context

ADR-0203 moved the demo onto the owner's laptop behind a Cloudflare Tunnel, after the July AWS Organization was
deleted. The demo then depends on the laptop being on, awake and online. The owner asked:

> "For the demo, should we deploy this on AWS instead? with AWS Fargate and all the security features enabled? This is
> to ensure nothing depends on my laptop"

Offered the choice, the owner chose **"EC2 now, Fargate after"**. Later the same day the owner said "let us do all the
steps using the CLI" and chose **"Terminal only, keep Terraform"**. The owner also set the demo date: **Monday morning,
2026-11-02**. That supersedes the 2026-10-31 date in ADR-0203's addendum and every earlier 11-03 date for this
environment.

## Decision

1. **Before the demo, the same Docker Compose stack runs on one hardened EC2 instance** in the company AWS
   Organization. It is a **demo environment with no production designation** (CLAUDE.md standing guardrail). No
   account, tag or role is named `prod` or `production`; the account module refuses such a tag.
2. **Its own member account.** "The company AWS account" is the Organization whose management account is the company
   account (ADR-0203). Workloads do not run in the management account (ADR-0002), so the host runs in a new member
   account, `regulait-demo-host`, created with `modules/aws-sandbox-account` exactly as the demo sandbox was. Every
   Terraform call uses the management account's short-lived IAM Identity Center session and assumes the role
   Organizations created in the member account (ADR-0004; the `demo-sandbox` pattern). No IAM user, no access key.
3. **The security baseline** is `modules/aws-security-baseline`, unchanged, with the demo-host account as its
   workload account: an organization CloudTrail trail with KMS and log-file validation, GuardDuty and Security Hub
   organization-wide, AWS Config in both accounts with an aggregator, account S3 public access blocks, a budget, and
   the root SCPs. It has its own state (`demo-host/baseline`), so tearing the host down leaves the audit trail.
4. **The host** (`infra/environments/demo-host/host`, reusing `modules/app-instance`, `backup-target-s3` and
   `scheduled-power`):
   - no SSH key and **no inbound security-group rule**; access is SSM Session Manager only;
   - IMDSv2 required with a hop limit of 1, so containers cannot take the instance role's credentials;
   - the root volume and a separate data volume (every Docker volume, Postgres included) are encrypted with the
     stack's customer-managed KMS key; the data volume is its own resource and survives an instance replacement;
   - a least-privilege role: SSM core, read its own source bundle, read `/regulait/demo-host/*` parameters (decrypt
     through SSM only), write container logs to one KMS-encrypted log group, and write but never read or delete its
     own backup prefix;
   - nightly verified `pg_dump` backups (`infra/scripts/pg-backup.sh`, ADR-0035) to a versioned, KMS-encrypted bucket
     with a one-day freshness alarm;
   - the power schedule is present but **off by default**, so the host cannot sleep through the demo.
5. **The Cloudflare Tunnel stays the front door.** It is outbound only and Cloudflare terminates TLS. The **same
   tunnel and the same public hostname move from the laptop to the host**: the laptop's `cloudflared` is stopped and
   the host's is started with the same token. Rollback is the reverse and takes about a minute.
6. **Secrets never enter Terraform, user-data or the repository.** The tunnel token and the stack's secrets are
   SecureString parameters, encrypted with the stack's key, that the owner creates by hand. On the host,
   `infra/scripts/demo-host-env.sh` builds `.env` (0600) from them; the tunnel token is passed to the one compose
   process that needs it and is never written to a file (as `docs/deployment/TUNNEL.md` requires on the laptop).
7. **Freeze exception.** This is an owner-approved exception to the ADR-0202 freeze, for infrastructure only. It
   changes no product code.
8. **Terminal only, Terraform kept.** Every owner step in DEMO_RUNBOOK §8 is a copy-paste terminal command, given in
   PowerShell for the owner's Windows laptop, with bash where the shell matters. Each step has a success line and a
   check command. Terraform still builds everything (ADR-0003 unchanged). The one exception is enabling the
   IAM Identity Center **organization** instance, which AWS offers no CLI or API for. That step and setting the first
   Identity Center password are short console fallbacks. Commands that run before any Identity Center session exists
   use AWS CloudShell, which uses the sign-in's short-lived credentials, so no access key is created (ADR-0004).
9. **Schedule.** The owner runs every step on Sunday 2026-11-01: apply, deploy, move the tunnel, live prepare, then
   rehearse on the instance. Sunday evening is buffer. The demo is on the host on Monday 2026-11-02, with the laptop
   rollback ready.
10. **After the demo**, Fargate, RDS, WAF and high availability are built as the ADR-0013 successor, as a separate
   decision. They are not built now.

## The issuer URL and the Shadow AI sandbox trust (verified against the code)

The federation issuer is `REGULAIT_PUBLIC_URL` plus `/federation` (`apps/gateway/src/federation-signing-keys.ts:90-93`).
On the host, `demo-host-env.sh` sets `REGULAIT_PUBLIC_URL=https://<public-host>` from the same `public-host`
parameter the laptop's `.env` holds, and compose passes it to the gateway (`docker-compose.yml:343`). The AWS IAM OIDC
provider and role trust are keyed on that issuer (`infra/environments/demo-sandbox/aws/main.tf:98`), as is the Azure
federated credential (`infra/environments/demo-sandbox/azure/main.tf:78`). IAM fetches the signing keys from the
issuer's JWKS each time, and no thumbprint is pinned (`infra/modules/aws-oidc-federated-role/main.tf:6`). So **the
issuer, the OIDC provider and the key trust need no re-pointing.**

**What does change.** Each trust also pins one subject, `regulait:discovery-source:<source id>`
(`demo-sandbox/aws/main.tf:100`, `demo-sandbox/azure/main.tf:79`). The source id is a database row id. A host
prepared on a fresh database (the plan in DEMO_RUNBOOK §8.8) gets new source ids and a new federation signing key. The
new key needs nothing (JWKS is fetched live). The new source ids do: `demo-sandbox/aws` and `demo-sandbox/azure` are
re-applied with `aws_discovery_source_id` and `azure_discovery_source_id` changed, which edits only the role trust
subject and the federated credential subject. This is the existing "Once only" rule (DEMO_RUNBOOK §7.1). The
alternative, restoring the laptop's live database and its data key onto the host, keeps the ids and needs no
re-apply; it is listed in §8.9 as an owner choice and is not scripted here.

## Consequences

- **The laptop is needed only as the browser used to present.** The stack, the database, the tunnel connector and
  the backups run in AWS.
- **Owner steps** are in DEMO_RUNBOOK.md §8 (terminal only, PowerShell first): about 5 to 7 hours on Sunday
  2026-11-01 including the rehearsal, most of it waiting on account creation, the baseline apply and the first build.
- **Cost.** About USD 7 to 8 a day (DEMO_RUNBOOK §8.12). That is a `t3.xlarge` (about USD 120 a month), EBS, one NAT
  gateway (about USD 35), five interface endpoints (about USD 37), and a few dollars each of KMS, logs, flow logs,
  Inspector, snapshots, Config and Security Hub. The demo-host account's budget alert defaults to USD 100. The sandbox keeps ADR-0197's USD 50 cap, which this ADR does not change.
- **Accepted for the demo:** one instance in one AZ, behind one NAT gateway, with no WAF, no HA, and Postgres in a
  container (see the security addendum for the network). The demo data passes
  through Cloudflare's edge, as under ADR-0203.
- **Module changes.** `modules/app-instance` gains `ingress_enabled` (default **false**, ADR-0180), `boot_mode
  = host_only`, KMS encryption of the root volume (now always encrypted) and the source bucket, an optional data
  volume, container logs to CloudWatch, a TLS-only source-bucket policy, a checksum-pinned compose plugin in host-only
  mode, and an IMDS hop limit of 1 by default. `regulait-dev-app` sets `ingress_enabled = true` explicitly. Its stack
  is not applied anywhere (ADR-0203), so the forced replacement of an unencrypted root volume affects nothing live.
- **`infra/bootstrap/bootstrap-backend.sh`** writes `backend.hcl` for the three new stacks, and its new
  `--write-backend-config` mode serves a backend an earlier run already created.
- **Not verified without AWS access:** `terraform plan` against any account, the user-data on a real instance, the SSM
  parameter read, the data-volume mount by NVMe serial, the awslogs driver, and the end-to-end tunnel switch.

## Addendum: 2026-11-01, security-team hardening (owner request, relayed by the master session)

The Monday audience is the company Security Team, and the demo is how they decide whether to approve. The owner asked
for the host to be as secure as possible. Added in the same PR:

- **Network.** A dedicated VPC (`terraform-aws-modules/vpc` 6.7.3, Apache-2.0). The instance sits in a private subnet
  with **no public IPv4** and **zero ingress rules**, and its egress is **443/tcp and 7844/tcp+udp only**, through one
  NAT gateway. Interface endpoints for ssm, ssmmessages, ec2messages, kms and logs, plus an S3 gateway endpoint, keep
  AWS control traffic private. VPC Flow Logs capture all traffic to a KMS-encrypted log group. The default security
  group is taken over with no rules.
- **Instance.** IMDSv2 with hop limit 1 and no key pair (both already in place). The latest AL2023 is resolved through
  the SSM public parameter, and pinning it after the first apply is optional. EBS uses the CMK, with rotation on.
  Termination protection is explicitly off.
- **Access.** The account's Session Manager preferences stream every session to a KMS-encrypted log group, encrypt
  session data with the CMK, set a 20-minute idle timeout and a 240-minute maximum, and disable run-as. The instance
  role is `AmazonSSMManagedInstanceCore`, `ssm:GetParameter(s)` on `/regulait/demo-host/*`, and `kms:Decrypt` on the
  one key. **Deviation, stated:** the role also writes to its two log groups (containers and sessions; the agent
  needs `logs:DescribeLogGroups` to stream), reads its own source bundle, and writes but never reads backups. Each is
  scoped to one resource.
- **Detection.** The baseline already provided CloudTrail across all regions with validation and KMS on a TLS-only,
  public-access-blocked bucket, plus GuardDuty, Security Hub (FSBP and CIS), Config and budgets. The host account adds
  an account IAM Access Analyzer, Inspector for EC2 and ECR, an AL2023 patch baseline with a daily scan (install is an
  owner step, so nothing reboots during the demo), and DLM daily encrypted snapshots kept for 7 days.
- **Secrets.** Every secret is a hand-made SecureString. The host rebuilds its env file into **tmpfs**
  (`/run/regulait`) at every boot, through a systemd unit, before Docker starts. §8.13 gives rotation and revocation
  for the demo password, the tunnel token and the model API key. The model key is a dedicated key with a spend limit,
  entered only in the RegulAIt UI (stored encrypted with the data key), never in SSM, and revoked after the demo.
- **Edge.** §8.7 b covers Cloudflare Access (an allow-list or SSO), TLS Full (strict), TLS 1.2 minimum and a rate
  limit, all through the Cloudflare API from PowerShell. The federation issuer, MCP and webhook paths **bypass**
  Access; without that, live discovery and the agent beats fail. Each bypassed path is authenticated by the app.
- **Containers.** Third-party images were already pinned by digest. The host override adds no-new-privileges and
  dropped capabilities to `gateway` (non-root) and `db`, and no-new-privileges to the object store. There is a
  `--no-harden` fallback. **Deferred:** read-only root filesystems for `gateway`, `db` and the object store. They
  cannot be tested before Monday, and a wrong guess breaks the demo.
- **Operator.** The owner applies as a least-privilege Identity Center permission set (`RegulAItDemoDeployer`, policy
  in §8.2 e), with MFA required. MFA settings have no API, so that is a console fallback. Inside the member account,
  Terraform still acts as `OrganizationAccountAccessRole`; a scoped deploy role comes after the demo.
- **Evidence.** [`DEMO_HOST_SECURITY_BRIEF.md`](../product/DEMO_HOST_SECURITY_BRIEF.md) has the architecture and
  data-flow boundary, the control table with a CLI proof per control, a one-page STRIDE model, residual risks and the
  teardown plan. §8.9 a is the app posture checklist: step-up required, admin MFA, synthetic data, demo password
  rotated, strict CSP and CORS.

## Addendum 2: 2026-11-01, audit-chain anchor in S3 Object Lock COMPLIANCE mode

The security team will see beat G8 (Verify chain, anchor grade). The gateway grades its anchor store by the store's
own answer, and only COMPLIANCE mode counts as tamper-resistant (`apps/gateway/src/audit-chain.ts`,
`S3ObjectLockSink.observe` and `resolveAnchorSink`). On the host:

- **The bucket** is `modules/audit-anchor-worm-s3` with `object_lock_mode = "COMPLIANCE"` and
  `anchor_retention_days` (default 7, limited to 1–30). It is versioned, blocks public access, uses SSE-KMS with the
  host key, and is TLS-only (`infra/environments/demo-host/host/anchor.tf`).
- **The wiring** uses only the app's existing variables (`REGULAIT_AUDIT_ANCHOR_S3_BUCKET`, `_REGION`, `_PREFIX`,
  `_RETENTION_DAYS`, `_ENDPOINT` empty for AWS, and the access-key pair empty so the SDK's provider chain applies),
  set in the host-only compose override by `demo-host-env.sh`.
- **Credentials. Deviation, stated:** the brief asked to grant the instance role the anchor calls. The gateway runs in
  a container, and IMDS hop limit 1 deliberately keeps containers away from the instance role. So the grant is on a
  **dedicated anchor role**. The instance role may only assume it, and a host timer
  (`infra/scripts/demo-host-anchor-creds.sh`) hands its 1-hour credentials to the gateway through a tmpfs file read
  by `credential_process`. The gateway therefore holds the anchor permissions and nothing else, and no long-lived key
  exists.
- **Permissions. Deviation, stated:** besides PutObject, GetObject, GetObjectRetention and HeadBucket (`s3:ListBucket`),
  the role needs every call the sink makes, or the grade reads "could not read" and is NOT tamper-resistant:
  `s3:PutObjectRetention` (a PUT with ObjectLockMode needs it; in COMPLIANCE mode retention can only be extended),
  `s3:GetObjectVersion` and `s3:ListBucketVersions` (it reads its anchor back by version), and
  `s3:GetBucketObjectLockConfiguration` (the grade). It also has KMS GenerateDataKey and Decrypt through S3 only. It
  carries an explicit Deny on delete, bypass and every lock-, versioning-, lifecycle- and policy-weakening call.
  **Superseded 2026-11-01:** the module's writer grant now matches the sink (ADR-0060 amendment 2026-11-01, PR #653),
  so `anchor.tf` passes `writer_role_names = [aws_iam_role.anchor.name]` and its own role policy is gone. The Deny
  moves to the bucket policy, where no later identity-policy Allow can override it. It also refuses a PUT whose lock
  mode is weaker than COMPLIANCE or whose retention is shorter than `anchor_retention_days − 1`. HeadBucket is not
  granted: the sink never calls it, and the list grant is limited to the `audit-anchors/` prefix.
- **An STS interface endpoint** is added, so the assume-role call stays on the AWS network.
- **The runbook** gains §8.8 step 8 (the G8 grade must read COMPLIANCE before the rehearsal), a posture-checklist row,
  and a teardown note: COMPLIANCE objects cannot be deleted by anyone until their retention ends, so the anchor
  bucket outlives the stack by up to `anchor_retention_days`.
