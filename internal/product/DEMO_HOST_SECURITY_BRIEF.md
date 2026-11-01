# Demo host security brief (ADR-0228)

For the security reviewers of the Monday 2026-11-02 demo. This document describes the AWS host that runs the
RegulAIt demo stack. It is a **demo environment, not production**: synthetic data, single instance, torn down after
the demo. Every control below is defined in Terraform under `infra/environments/demo-host/` (or stated as an operator
step in `internal/product/DEMO_RUNBOOK.md` §8). Next to each control is a read-only CLI command that proves it on the
running system. This document contains no account ids, hostnames, addresses or secrets. `<host>` stands for the
public hostname, and `H` for the CLI profile of the demo-host account.

## 1. Architecture and data-flow boundary

```
 Browser (presenter, security team)
   │ HTTPS (TLS 1.2+, Cloudflare edge certificate)
   ▼
 Cloudflare edge ── Access (SSO / allow-list) ── rate limit ── TLS 1.2+ to browsers (Full (strict) set; see E2)
   │ outbound-only tunnel, initiated by the host (7844 QUIC or HTTP/2)
   ▼
 ┌──────────────── AWS member account "regulait-demo-host" (Organization member) ───────────────┐
 │  VPC (dedicated) ─ private subnet ─ EC2 (no public IPv4, 0 ingress rules, IMDSv2 hop 1)      │
 │      │  docker compose: cloudflared → caddy-tunnel → gateway → postgres / object store       │
 │      │  egress SG: 443/tcp, 7844/tcp+udp only ─► NAT gateway (public subnet) ─► internet       │
 │      └─ VPC endpoints (ssm, ssmmessages, ec2messages, kms, logs, sts; S3 gateway): AWS control     │
 │         traffic stays on the AWS network                                                      │
 │  KMS CMK (rotation on): EBS root + data, SSM SecureStrings, session data, logs, backups       │
 │  CloudWatch Logs (KMS): containers, SSM session transcripts, Run Command output, flow logs    │
 │  S3 (KMS, versioned, TLS-only, public access blocked): source bundle, nightly pg_dump,       │
 │     audit-chain anchors (Object Lock COMPLIANCE)                                              │
 └───────────────────────────────────────────────────────────────────────────────────────────────┘
 Organization (management account): CloudTrail all regions + log-file validation (KMS, TLS-only bucket),
 GuardDuty, Security Hub (FSBP + CIS), AWS Config + aggregator, SCPs (region allow-list, no leaving the
 Organization, no stopping CloudTrail), budgets.
 Operator: IAM Identity Center user with MFA → least-privilege permission set → Terraform; SSM Session Manager.
```

**What crosses which boundary:**

| Flow | Carries | Protection |
| --- | --- | --- |
| Browser ↔ Cloudflare | demo UI traffic, synthetic data | TLS; Access sign-in; rate limit |
| Cloudflare ↔ host | the same, decrypted at Cloudflare's edge | tunnel (TLS, host-initiated); no inbound port anywhere |
| Host → internet (via NAT) | package and image pulls at build; calls to the model provider and demo integrations | 443 only; provider keys are demo-scoped |
| Host → AWS APIs | SSM, KMS, Logs, S3, STS (the anchor role's assume-role) | private VPC endpoints; IAM role, least privilege |
| Operator → host | shell and scripted commands | SSM only, two channels. Session Manager is IAM-authenticated, KMS-encrypted, transcribed to CloudWatch and has an idle timeout. Run Command (`send-command`) is IAM-authenticated, its output goes to a KMS-encrypted log group, and CloudTrail records every call |
| AWS / Azure sandbox → host | the federation issuer's JWKS (public keys only) | the one public path besides the webhooks, bypassing Access by design (§3) |

**Data boundary, stated plainly:** Cloudflare's edge sees demo traffic in the clear (ADR-0203). The demo uses
synthetic data only. No customer data enters this environment.

## 2. Control table

Run each proof with `--profile H` (the demo-host account) unless it says management, or on the host where marked.

| # | Control | Enforced by | Proof |
| --- | --- | --- | --- |
| N1 | No public IPv4 on the instance | `host/main.tf` `associate_public_ip_address = false`; private subnet (`network.tf`) | `aws ec2 describe-instances --instance-ids <i> --query 'Reservations[0].Instances[0].PublicIpAddress'` → `null` |
| N2 | Zero inbound rules | `modules/app-instance` `ingress_enabled = false` | `aws ec2 describe-security-groups --filters Name=group-name,Values=regulait-demo-host-app --query 'SecurityGroups[0].IpPermissions'` → `[]` |
| N3 | Egress 443/tcp and 7844/tcp+udp only | `host/main.tf` `local.egress_rules` | same call, `IpPermissionsEgress` → three rules |
| N4 | Default security group has no rules | `network.tf` `manage_default_security_group` | `aws ec2 describe-security-groups --filters Name=group-name,Values=default Name=vpc-id,Values=<vpc>` → no permissions |
| N5 | AWS control traffic on private endpoints | `network.tf` `module.endpoints` | `aws ec2 describe-vpc-endpoints --query 'VpcEndpoints[].[ServiceName,State]'` |
| N6 | VPC Flow Logs, all traffic, KMS-encrypted | `network.tf` `enable_flow_log`, `flow_log_cloudwatch_log_group_kms_key_id` | `aws ec2 describe-flow-logs`; `aws logs describe-log-groups --log-group-name-prefix /regulait/demo-host/flow-logs --query 'logGroups[].kmsKeyId'` |
| I1 | IMDSv2 required, hop limit 1 | `modules/app-instance` `metadata_options` | `aws ec2 describe-instances ... --query '...MetadataOptions.[HttpTokens,HttpPutResponseHopLimit]'` → `required 1` |
| I2 | No key pair | no `key_name` anywhere | `... --query '...KeyName'` → `null` |
| I3 | Latest AL2023 from the SSM public parameter | `modules/app-instance` `data.aws_ssm_parameter.al2023_ami` | `aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value` equals the instance's `ImageId` at apply |
| I4 | EBS root and data encrypted with the CMK; key rotation on | `modules/app-instance` (`encrypted = true`, `kms_key_id`); `host/main.tf` `enable_key_rotation` | `aws ec2 describe-volumes --filters Name=attachment.instance-id,Values=<i> --query 'Volumes[].[Encrypted,KmsKeyId]'`; `aws kms get-key-rotation-status --key-id alias/regulait-demo-host` |
| I5 | Termination protection off (demo; one-step teardown) | `disable_api_termination = false` | `aws ec2 describe-instance-attribute --instance-id <i> --attribute disableApiTermination` → `false` |
| I6 | Patching | `detection.tf` patch baseline, daily Scan association; Install run by the operator (§8.4) | `aws ssm describe-instance-patch-states --instance-ids <i>` → `MissingCount 0` |
| A1 | SSM is the only access: Session Manager (interactive) and Run Command (`send-command`, the runbook's scripted steps). No SSH, no inbound port | N2, I2; `AmazonSSMManagedInstanceCore` | `aws ssm describe-instance-information` → `Online` |
| A2 | Every session logged and encrypted; idle timeout. Sessions run as `ssm-user`, which on Amazon Linux has **passwordless sudo**: any operator allowed `ssm:StartSession` is effectively root on the host, and the runbook uses `sudo -i`. The transcript records what is done as root | `access.tf` `SSM-SessionManagerRunShell` (CloudWatch streaming, KMS, `idleSessionTimeout` 20 min, 240 min maximum, no run-as) | `aws ssm get-document --name SSM-SessionManagerRunShell --query Content` |
| A2b | Every Run Command **the runbook issues** has its output logged and encrypted; CloudTrail records **every** `SendCommand` and its caller, flagged or not. AWS offers no account default or IAM condition that forces output logging, so a `send-command` made outside the runbook without the flag is recorded by CloudTrail but its output is not (residual 12) | `access.tf` `aws_cloudwatch_log_group.run_command` (KMS); the instance role may write to it only; the runbook helper `Invoke-DemoHost` / `demo_host`, the patch install (§8.4) and `infra/scripts/install-pg-backup.sh` with `REGULAIT_RUN_COMMAND_LOG_GROUP` (§8.6) all pass `--cloud-watch-output-config` | `aws logs describe-log-groups --log-group-name-prefix /regulait/demo-host/run-command --query 'logGroups[].kmsKeyId'`; `aws logs describe-log-streams --log-group-name /regulait/demo-host/run-command` → one stream per command |
| A3 | Instance role, least privilege | `host/main.tf` `data.aws_iam_policy_document.host`; core; backup write-only | `aws iam list-attached-role-policies --role-name regulait-demo-host-instance`; `aws iam get-role-policy --role-name regulait-demo-host-instance --policy-name demo-host-runtime` |
| A4 | **Two privilege levels, stated plainly.** (1) The **management-account bootstrap** (state backend, member account, baseline: Organizations, organization trail, GuardDuty, Security Hub and Config delegation, SCPs, budget-action role; and the deployer's permission set) is a **one-time privileged action under break-glass, with MFA, recorded by CloudTrail. It is not least-privilege and does not pretend to be.** (2) The **recurring deploy** runs as `RegulAItDemoDeployer`, which is **assigned only in the demo-host account and has no access to the management account**, which is why it can be least-privilege. Its state backend lives in the host account. It may create only `regulait-demo-host-*` roles, and only with the `regulait-demo-host-boundary` permissions boundary, which the break-glass baseline creates and the deployer cannot change. The boundary denies every deployed role IAM, Organizations, any role assumption except the anchor role, CloudTrail, Config, GuardDuty and Security Hub writes, KMS key administration, and evidence weakening or erasure. The deployer cannot update any trust policy, cannot assume a role outside the host account, cannot touch the management account's trail, Config or state buckets, and cannot delete host evidence (backups, anchors, logs, keys, snapshots), so teardown is break-glass. No IAM users or access keys anywhere | DEMO_RUNBOOK.md §8.2 e, §8.4 steps 1–4; `demo-host/baseline/host-foundation.tf` (boundary, host state backend); every role in `demo-host/host` sets `permissions_boundary`; ADR-0004 | §8.4 step 3: `simulate-custom-policy` proofs P1–P4 (a role named `regulait-x-budget-action`, `UpdateAssumeRolePolicy` on `regulait-config-recorder`, `CreatePolicyVersion` on the boundary, Config- and CloudTrail-bucket deletion, `AssumeRole` into the management account, key deletion, detection muting) → denied; P5 (create a role with the boundary) → allowed; `list-accounts-for-provisioned-permission-set` → the host account only. §8.4 step 4: `get-role` → every `regulait-demo-host-*` role carries the boundary; `simulate-principal-policy` on the instance role → only the anchor role is assumable |
| D1 | CloudTrail, all regions, log-file validation, KMS, TLS-only bucket with public access blocked | `modules/aws-security-baseline` (`is_multi_region_trail`, `enable_log_file_validation`, `kms_key_id`, bucket policy `aws:SecureTransport`) | management: `aws cloudtrail describe-trails --query 'trailList[].[IsMultiRegionTrail,LogFileValidationEnabled,KmsKeyId]'`; `aws cloudtrail validate-logs ...` |
| D2 | GuardDuty | baseline (organization-wide auto-enable) | `aws guardduty list-detectors` |
| D3 | Security Hub, FSBP and CIS | baseline | `aws securityhub get-enabled-standards` |
| D4 | AWS Config, both accounts, aggregated | baseline | `aws configservice describe-configuration-recorder-status` |
| D5 | IAM Access Analyzer (account) | `detection.tf` | `aws accessanalyzer list-analyzers --type ACCOUNT` |
| D6 | Amazon Inspector, EC2 and ECR | `detection.tf` | `aws inspector2 batch-get-account-status` |
| D7 | Budgets alarm | `demo-host/account` (and the baseline's org budget) | management: `aws budgets describe-budgets --account-id <id>` |
| D9 | Audit-chain anchors in S3 Object Lock **COMPLIANCE** mode (beat G8): versioned, Block Public Access, SSE-KMS with the host key, TLS-only; default retention 7 days; the gateway writes through a dedicated role that cannot delete, bypass or weaken, using 1-hour credentials refreshed by the host (IMDS stays at hop limit 1) | `host/anchor.tf` (reuses `modules/audit-anchor-worm-s3`); `infra/scripts/demo-host-anchor-creds.sh`; existing `REGULAIT_AUDIT_ANCHOR_S3_*` variables | `aws s3api get-object-lock-configuration --bucket <anchor bucket>` → `Enabled COMPLIANCE 7`; on the host `GET /v1/audit/anchors` → `sink.mode compliance`, `tamperResistant true` |
| D8 | Encrypted snapshots (DLM, daily, 7 kept) and nightly verified `pg_dump` (KMS, versioned, writer cannot read or delete) | `detection.tf`; `module.db_backup`; `infra/scripts/pg-backup.sh` | `aws dlm get-lifecycle-policies`; on the host `/usr/local/sbin/regulait-pg-backup.sh --check`; `aws cloudwatch describe-alarms --alarm-name-prefix regulait-demo-host` |
| S1 | Secrets only in SSM SecureString (CMK); the tunnel token is read at a hidden prompt and the other three are generated; each value reaches SSM through a temporary file in the operator's own temp folder, uploaded with `--value file://` and deleted straight after, never on a command line; no secret in Terraform state, user-data, shell history or logs | §8.5; `infra/scripts/demo-host-env.sh` (no tracing, never prints a value) | `aws ssm get-parameters-by-path --path /regulait/demo-host --query 'Parameters[].[Name,Type]'` (no decryption) → four SecureString and four String; `terraform state list \| grep aws_ssm_parameter` → **four** lines: the three non-secret String parameters `anchor_bucket`, `anchor_role_arn`, `anchor_retention_days` (bucket name, role ARN, retention days), plus `module.app.data.aws_ssm_parameter.al2023_ami`, the data source that reads AWS's public AMI id (not a secret) |
| S2 | Secrets fetched at boot into tmpfs | `demo-host-env.sh write` and `install-boot` (`/run/regulait/env`, 0600; `.env` is a symlink) | on the host: `stat -f -c %T /run` → `tmpfs`; `readlink /opt/app/.env` |
| S3 | Tunnel token never written by **us** to a file: it is not in the env file, the override, user-data or state; `demo-host-env.sh compose` passes it to the one `docker compose` process. **Docker itself** keeps it as `TUNNEL_TOKEN` in the `cloudflared` container's config on the KMS-encrypted data volume, root-readable, for as long as the container exists (residual 5) | `infra/scripts/demo-host-env.sh` | on the host: `grep -c REGULAIT_CF_TUNNEL_TOKEN /run/regulait/env` → `0` |
| S4 | Rotation and revocation: demo password, tunnel token, model API key (dedicated, spend-limited, revoked after) | §8.13 | the steps' own checks |
| E1 | Cloudflare Access in front of the hostname; only the inbound machine paths bypass it, scoped with a trailing slash or a wildcard (`/federation/`, `/mcp/`, `/v1/pm/webhooks/`, `/v1/chatops/*/events`, `/v1/chatops/*/interactions`), so `/mcp/` does not match `/mcp-registries` and chat-ops admin routes stay behind Access | §8.7 b | `curl -s -o /dev/null -w '%{http_code}' https://<host>/ui` and `.../v1/org/posture` from outside → `302` to Access both |
| E2 | Browser to Cloudflare: TLS 1.2 minimum. The zone's SSL mode is set to Full (strict), but that setting governs Cloudflare-to-origin connections over the public internet, and **it does not govern the tunnel leg**: Cloudflare to `cloudflared` is the tunnel's own authenticated, encrypted connection, which the host dials out. Inside the host, `cloudflared` → `caddy-tunnel` → gateway is plain HTTP on private Docker networks | §8.7 b; `docker-compose.yml` (`tunnel` profile) | Cloudflare API `GET /zones/<zone>/settings/ssl` → `strict` |
| E3 | Rate limit, **optional**: set only if the zone's plan accepts it and the zone has no other rate-limiting rule (the API call replaces the whole rate-limit ruleset); on a Free zone the rule matches by URI path with a 10-second period. If it is not set, the brief records it as not set; Access is the edge control the demo relies on | §8.7 b | Cloudflare API `GET /zones/<zone>/rulesets/phases/http_ratelimit/entrypoint` |
| C1 | Images pinned by digest | `docker-compose.yml` (every third-party image `@sha256:`) | `grep -n 'image:' docker-compose.yml` |
| C2 | Container hardening, **per service, as it is**: `cloudflared`, the engines and the sandbox executor run non-root with a read-only root filesystem, no-new-privileges and all capabilities dropped (`docker-compose.yml`); **`caddy-tunnel` runs as root** (the `caddy` image's default; no `user:` is set), read-only, with no-new-privileges and all capabilities dropped except `NET_BIND_SERVICE`; the host override (`demo-host-env.sh`) adds no-new-privileges and dropped capabilities to `gateway` (non-root `node`) and `db` (postgres keeps the five it needs to drop to its own user), and no-new-privileges to the object store; `gateway`, `db` and the object store are not read-only (residual 6) | `docker-compose.yml`; `infra/scripts/demo-host-env.sh` | on the host: `docker inspect --format '{{.Name}} user={{.Config.User}} ro={{.HostConfig.ReadonlyRootfs}} {{.HostConfig.SecurityOpt}} {{.HostConfig.CapDrop}}' $(docker ps -q)`: an empty `user=` means root (`caddy-tunnel`, `db` before it drops privileges, the object store) |
| P1 | App posture before go-live: step-up required, admin MFA, synthetic data, demo password rotated, strict CSP and CORS, one dedicated spend-limited model key, the laptop's old model key revoked | §8.9 a (rows 10 and 11 for the keys) | the checklist's commands |
| G1 | No production designation | the account module refuses a prod/production tag | `aws ec2 describe-instances --query '...Tags'` → `Environment=demo` |

## 3. Threat model (STRIDE)

| Threat | Example against this host | Mitigation | Residual |
| --- | --- | --- | --- |
| **Spoofing** | Someone reaches the UI pretending to be a reviewer; a forged federation token | Cloudflare Access in front; app sign-in with admin MFA and step-up; federation tokens signed by the host's key and verified by the clouds against its JWKS | Machine paths (`/federation`, `/mcp`, webhooks) bypass Access and rely on the app's own authentication and signatures |
| **Tampering** | Altering the instance, its images, or the audit trail | No inbound path; digest-pinned images; IMDS hop limit 1; CloudTrail with log-file validation; the app's tamper-evident audit chain, its head anchored in S3 Object Lock COMPLIANCE mode, so a recomputed chain diverges from an anchor nobody can rewrite; versioned backups the host cannot delete; the deployer cannot delete host evidence or administer its key | Root on the host can alter the live database between anchors, and can append forged lines to the session and Run Command log groups (the instance role must write there for SSM to log at all). Locked anchors cannot be rewritten or deleted before retention, but break-glass can **crypto-shred** them: disabling or scheduling deletion of the host key makes them unreadable (residual 15). After retention the anchor bucket can be destroyed wholesale, and verification then reports the anchor missing |
| **Repudiation** | An operator denies a change, or erases the record of it | Identity Center sign-in with MFA; the organization CloudTrail trail, Config bucket (versioned) and SCPs live in the management account, which the deployer cannot reach at all; inside the host account the deployer cannot mute GuardDuty, Security Hub, Config or Access Analyzer, delete flow logs, change the Session Manager logging preferences, or delete the host's log groups; every SSM session transcribed and the runbook's Run Commands' output logged, both to KMS-encrypted log groups; app audit log | The transcript records only what the session shows. **Break-glass** (management account, and `OrganizationAccountAccessRole` in the host account) can still change or erase any of it, and CloudTrail records that it did; for a change to the trail itself, that is the last event the trail records about itself. The deployer may still shorten a log group's retention (`PutRetentionPolicy` is needed to create one). A `send-command` without the output flag is in CloudTrail without its output |
| **Information disclosure** | Secrets or data leaking via logs, state, disks, or the edge | SecureStrings with a CMK; never in Terraform state or user-data; tmpfs env file; KMS on every volume, log group and bucket; TLS-only buckets; synthetic data only | Cloudflare's edge decrypts traffic; Docker keeps container environment in its config on the encrypted data volume; `AmazonSSMManagedInstanceCore` grants `ssm:GetParameter` on `*` (the account holds only this host's parameters) |
| **Denial of service** | Flooding the hostname; the host sleeping or being stopped | Cloudflare rate limit and edge; power schedule off; budget alerts; laptop rollback in 2 minutes | Single instance, single AZ, single NAT gateway: no HA before the demo |
| **Elevation of privilege** | A compromised container takes the instance role or escapes | IMDS hop limit 1 (containers cannot reach the role's credentials); non-root and dropped capabilities where hardened; least-privilege role; no-new-privileges; SCPs at the root | Postgres and the object store keep some capabilities; the operator acts as `OrganizationAccountAccessRole` (administrator) inside the member account |

## 4. Residual risks (accepted for a one-day demo)

1. **Cloudflare sees plaintext** at its edge. This is accepted for synthetic data only (ADR-0203).
2. **No high availability.** There is one instance, one AZ and one NAT gateway. The mitigation is the laptop rollback
   (§8.10) and nightly backups plus DLM snapshots. Fargate, RDS, WAF and HA come after the demo (ADR-0013 successor).
3. **The bootstrap is privileged by design.** The management-account bootstrap and teardown run as break-glass,
   with administrator rights, MFA and CloudTrail. `OrganizationAccountAccessRole` (administrator) still exists in
   the host account, but only break-glass can reach it. The recurring deployer has neither.
4. **`AmazonSSMManagedInstanceCore` includes `ssm:GetParameter(s)` on `*`.** In this dedicated account the only
   parameters are the host's own. Every SecureString also needs `kms:Decrypt` on the one key, which the role holds
   only for that key.
5. **Container environment at rest.** Docker stores each container's environment in its config on the KMS-encrypted
   data volume, root-readable. That includes the tunnel token (`TUNNEL_TOKEN` in `cloudflared`) and the gateway's
   data key and bootstrap token. The secrets are therefore not only in tmpfs while containers exist.
6. **Container hardening is partial and untested on the host.** Read-only root filesystems are not added for
   `gateway`, `db` or the object store. The added capability drops have a documented fallback (`--no-harden`).
7. **Bypassed paths.** `/federation/`, `/mcp/`, `/v1/pm/webhooks/` and chat-ops' `/events` and `/interactions`
   reach the app without Access. Each is authenticated by the app (public keys only, API keys, signed webhooks).
8. **The bootstrap token** is a full-admin credential, held in SSM until teardown or removal (§8.13).
9. **Egress to any destination on 443.** Package registries, the model provider and the integrations have no stable
   address list, so there is no domain-level egress filter before the demo.
10. **Short anchor retention.** Anchors are kept 7 days (a demo setting). After that they can be deleted, so the
    proof covers the demo window, not a production retention period.
11. **The laptop holds a live copy of the tunnel token.** The same token runs the laptop's connector, which is kept for
    the 2-minute rollback (§8.10). Anyone who takes the laptop or its password manager can join the tunnel and receive
    a share of the traffic. Mitigation: the laptop's connector stays stopped, and after the demo the token is refreshed
    or the tunnel deleted (§8.13), which kills both copies.
12. **Run Command output logging is a convention, not an enforced control.** Every runbook call passes the flag; a
    call made outside the runbook without it is in CloudTrail (who, when, which document, which instance) but its
    output is not stored.
13. **Operator is root on the host.** `ssm-user` has passwordless sudo, so anyone allowed to start a session is root.
    Only the owner holds `ssm:StartSession` on this account, and every session is transcribed.
14. **Root on the host can forge log lines.** The instance role must be able to write to the session-transcript and
    Run Command log groups for SSM to log at all, so root on the host can append forged entries there. It cannot
    delete or rewrite earlier ones: the boundary denies log deletion and retention changes.
15. **Break-glass can crypto-shred the evidence.** Break-glass, meaning administrator rights in the host account
    through `OrganizationAccountAccessRole`, can delete the host's log groups, change their retention, or disable or
    schedule deletion of the host key. Disabling the key makes the locked anchors and the backups unreadable, though
    they cannot be rewritten. There is no SCP on the host account that forbids it before the demo; CloudTrail
    records it.
16. **The budgets and their alerts** live in the management account, which the deployer cannot reach; break-glass
    can change them.
17. **Not yet executed.** Nothing here has been applied. The controls are proven only once the owner applies them
    and runs the checks in §8.4 and §8.9 a.

## 5. Teardown plan

After the demo (DEMO_RUNBOOK.md §8.11 and §8.13), in this order:

1. Revoke the model API key in the provider's console and delete the credential in the UI.
2. Delete the Cloudflare Access apps and policies, and the tunnel. That revokes the tunnel token.
3. Take a final verified backup.
4. **Break-glass**: run `terraform destroy` on `demo-host/host`. This terminates the instance and deletes the volumes,
   VPC, endpoints and NAT gateway. **Decide first whether the backups and anchors must stay readable.** Both buckets
   are encrypted with the host key. If the destroy deletes the key, it enters a 30-day window, and after that every
   kept backup and anchor is permanently unreadable. To keep them readable, the buckets, **the key and its alias** are
   taken out of Terraform state before the destroy (DEMO_RUNBOOK.md §8.11 step 2a). They then keep every bucket-level
   control: policy, public-access block, encryption and lifecycle.
   Without step 2a, the destroy stops on the two buckets, after it has already removed their bucket-level controls
   (the TLS-only and anchor-writer policies, the public-access block, the default encryption and the lifecycle rule).
   Only object-level protection remains: versions, and the anchors' COMPLIANCE retention. The **audit-anchor bucket
   cannot be emptied until its retention ends**, up to 7 days, because no principal, root included, can delete a
   locked anchor.
5. Delete the SSM parameters.
6. Keep `demo-host/baseline` (the organization's audit trail) until its successor exists.
7. Close the account with `terraform destroy` on `demo-host/account`. AWS suspends it for 90 days and then deletes it
   with everything inside, including the locked anchor bucket. If the anchors must stay readable for the reviewers,
   keep the account until their retention ends, delete the buckets by hand, and close it then (DEMO_RUNBOOK.md §8.11
   step 5).

**Proof:** `aws ec2 describe-instances` shows the instance `terminated`, and `aws ssm get-parameters-by-path --path
/regulait/demo-host` returns none.
