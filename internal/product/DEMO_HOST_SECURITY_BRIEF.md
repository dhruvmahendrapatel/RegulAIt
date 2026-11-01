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
 Cloudflare edge ── Access (SSO / allow-list) ── rate limit ── Full (strict) TLS
   │ outbound-only tunnel, initiated by the host (7844 QUIC or HTTP/2)
   ▼
 ┌──────────────── AWS member account "regulait-demo-host" (Organization member) ───────────────┐
 │  VPC (dedicated) ─ private subnet ─ EC2 (no public IPv4, 0 ingress rules, IMDSv2 hop 1)      │
 │      │  docker compose: cloudflared → caddy-tunnel → gateway → postgres / object store       │
 │      │  egress SG: 443/tcp, 7844/tcp+udp only ─► NAT gateway (public subnet) ─► internet       │
 │      └─ VPC endpoints (ssm, ssmmessages, ec2messages, kms, logs, sts; S3 gateway): AWS control     │
 │         traffic stays on the AWS network                                                      │
 │  KMS CMK (rotation on): EBS root + data, SSM SecureStrings, session data, logs, backups       │
 │  CloudWatch Logs (KMS): containers, SSM session transcripts, VPC flow logs                    │
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
| Host → AWS APIs | SSM, KMS, Logs, S3 | private VPC endpoints; IAM role, least privilege |
| Operator → host | shell | SSM Session Manager only: IAM-authenticated, KMS-encrypted, transcribed to CloudWatch, idle timeout |
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
| A1 | Session Manager is the only access | N2, I2; `AmazonSSMManagedInstanceCore` | `aws ssm describe-instance-information` → `Online` |
| A2 | Every session logged and encrypted; idle timeout | `access.tf` `SSM-SessionManagerRunShell` (CloudWatch streaming, KMS, `idleSessionTimeout` 20 min, 240 min maximum, no run-as) | `aws ssm get-document --name SSM-SessionManagerRunShell --query Content` |
| A3 | Instance role, least privilege | `host/main.tf` `data.aws_iam_policy_document.host`; core; backup write-only | `aws iam list-attached-role-policies --role-name regulait-demo-host-instance`; `aws iam get-role-policy --role-name regulait-demo-host-instance --policy-name demo-host-runtime` |
| A4 | Operator: Identity Center, MFA, least-privilege permission set, no IAM users or keys | §8.2 e; ADR-0004; `DenyHumanCredentials` in the permission set | management: `aws sso-admin describe-permission-set ...`; `aws iam list-users` → empty |
| D1 | CloudTrail, all regions, log-file validation, KMS, TLS-only bucket with public access blocked | `modules/aws-security-baseline` (`is_multi_region_trail`, `enable_log_file_validation`, `kms_key_id`, bucket policy `aws:SecureTransport`) | management: `aws cloudtrail describe-trails --query 'trailList[].[IsMultiRegionTrail,LogFileValidationEnabled,KmsKeyId]'`; `aws cloudtrail validate-logs ...` |
| D2 | GuardDuty | baseline (organization-wide auto-enable) | `aws guardduty list-detectors` |
| D3 | Security Hub, FSBP and CIS | baseline | `aws securityhub get-enabled-standards` |
| D4 | AWS Config, both accounts, aggregated | baseline | `aws configservice describe-configuration-recorder-status` |
| D5 | IAM Access Analyzer (account) | `detection.tf` | `aws accessanalyzer list-analyzers --type ACCOUNT` |
| D6 | Amazon Inspector, EC2 and ECR | `detection.tf` | `aws inspector2 batch-get-account-status` |
| D7 | Budgets alarm | `demo-host/account` (and the baseline's org budget) | management: `aws budgets describe-budgets --account-id <id>` |
| D9 | Audit-chain anchors in S3 Object Lock **COMPLIANCE** mode (beat G8): versioned, Block Public Access, SSE-KMS with the host key, TLS-only; default retention 7 days; the gateway writes through a dedicated role that cannot delete, bypass or weaken, using 1-hour credentials refreshed by the host (IMDS stays at hop limit 1) | `host/anchor.tf` (reuses `modules/audit-anchor-worm-s3`); `infra/scripts/demo-host-anchor-creds.sh`; existing `REGULAIT_AUDIT_ANCHOR_S3_*` variables | `aws s3api get-object-lock-configuration --bucket <anchor bucket>` → `Enabled COMPLIANCE 7`; on the host `GET /v1/audit/anchors` → `sink.mode compliance`, `tamperResistant true` |
| D8 | Encrypted snapshots (DLM, daily, 7 kept) and nightly verified `pg_dump` (KMS, versioned, writer cannot read or delete) | `detection.tf`; `module.db_backup`; `infra/scripts/pg-backup.sh` | `aws dlm get-lifecycle-policies`; on the host `/usr/local/sbin/regulait-pg-backup.sh --check`; `aws cloudwatch describe-alarms --alarm-name-prefix regulait-demo-host` |
| S1 | Secrets only in SSM SecureString (CMK); created at a hidden prompt; never in state, user-data, history or logs | §8.5; `infra/scripts/demo-host-env.sh` (no tracing, never prints a value) | `aws ssm get-parameters-by-path --path /regulait/demo-host --query 'Parameters[].[Name,Type]'` (no decryption); `terraform state list` holds no `aws_ssm_parameter` |
| S2 | Secrets fetched at boot into tmpfs | `demo-host-env.sh write` and `install-boot` (`/run/regulait/env`, 0600; `.env` is a symlink) | on the host: `stat -f -c %T /run` → `tmpfs`; `readlink /opt/app/.env` |
| S3 | Tunnel token never written to a file | `demo-host-env.sh compose` passes it to one process | on the host: `grep -c REGULAIT_CF_TUNNEL_TOKEN /run/regulait/env` → `0` |
| S4 | Rotation and revocation: demo password, tunnel token, model API key (dedicated, spend-limited, revoked after) | §8.13 | the steps' own checks |
| E1 | Cloudflare Access in front of the hostname; machine paths bypassed | §8.7 b | `curl -sI https://<host>/ui` → `302` to Access |
| E2 | TLS Full (strict), TLS 1.2 minimum | §8.7 b | Cloudflare API `GET /zones/<zone>/settings/ssl` → `strict` |
| E3 | Rate limit | §8.7 b | Cloudflare API `GET /zones/<zone>/rulesets/phases/http_ratelimit/entrypoint` |
| C1 | Images pinned by digest | `docker-compose.yml` (every third-party image `@sha256:`) | `grep -n 'image:' docker-compose.yml` |
| C2 | Non-root, read-only root filesystem, no-new-privileges, dropped capabilities | `docker-compose.yml` for `cloudflared`, `caddy-tunnel`, the engines and the sandbox executor; the host override (`demo-host-env.sh`) adds no-new-privileges and dropped capabilities for `gateway` (non-root `node`) and `db`, and no-new-privileges for the object store | on the host: `docker inspect --format '{{.Name}} {{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.SecurityOpt}} {{.HostConfig.CapDrop}}' $(docker ps -q)` |
| P1 | App posture before go-live: step-up required, admin MFA, synthetic data, demo password rotated, strict CSP and CORS | §8.9 a | the checklist's commands |
| G1 | No production designation | the account module refuses a prod/production tag | `aws ec2 describe-instances --query '...Tags'` → `Environment=demo` |

## 3. Threat model (STRIDE)

| Threat | Example against this host | Mitigation | Residual |
| --- | --- | --- | --- |
| **Spoofing** | Someone reaches the UI pretending to be a reviewer; a forged federation token | Cloudflare Access in front; app sign-in with admin MFA and step-up; federation tokens signed by the host's key and verified by the clouds against its JWKS | Machine paths (`/federation`, `/mcp`, webhooks) bypass Access and rely on the app's own authentication and signatures |
| **Tampering** | Altering the instance, its images, or the audit trail | No inbound path; digest-pinned images; IMDS hop limit 1; CloudTrail with log-file validation; the app's tamper-evident audit chain, its head anchored in S3 Object Lock COMPLIANCE mode, so a recomputed chain diverges from an anchor nobody can rewrite; versioned backups the host cannot delete | Root on the host can alter the live database between anchors; the anchor bucket can be destroyed wholesale only after retention, and verification then reports the anchor missing |
| **Repudiation** | An operator denies a change | Identity Center sign-in with MFA; CloudTrail; every SSM session transcribed to a KMS-encrypted log group; app audit log | The transcript records only what the session shows |
| **Information disclosure** | Secrets or data leaking via logs, state, disks, or the edge | SecureStrings with a CMK; never in Terraform state or user-data; tmpfs env file; KMS on every volume, log group and bucket; TLS-only buckets; synthetic data only | Cloudflare's edge decrypts traffic; Docker keeps container environment in its config on the encrypted data volume; `AmazonSSMManagedInstanceCore` grants `ssm:GetParameter` on `*` (the account holds only this host's parameters) |
| **Denial of service** | Flooding the hostname; the host sleeping or being stopped | Cloudflare rate limit and edge; power schedule off; budget alerts; laptop rollback in 2 minutes | Single instance, single AZ, single NAT gateway: no HA before the demo |
| **Elevation of privilege** | A compromised container takes the instance role or escapes | IMDS hop limit 1 (containers cannot reach the role's credentials); non-root and dropped capabilities where hardened; least-privilege role; no-new-privileges; SCPs at the root | Postgres and the object store keep some capabilities; the operator acts as `OrganizationAccountAccessRole` (administrator) inside the member account |

## 4. Residual risks (accepted for a one-day demo)

1. **Cloudflare sees plaintext** at its edge. This is accepted for synthetic data only (ADR-0203).
2. **No high availability.** There is one instance, one AZ and one NAT gateway. The mitigation is the laptop rollback
   (§8.10) and nightly backups plus DLM snapshots. Fargate, RDS, WAF and HA come after the demo (ADR-0013 successor).
3. **Administrator rights inside the member account.** Terraform reaches the account through
   `OrganizationAccountAccessRole`, which has administrator rights. The operator's own permission set is scoped, and
   a scoped deploy role is a post-demo item.
4. **`AmazonSSMManagedInstanceCore` includes `ssm:GetParameter(s)` on `*`.** In this dedicated account the only
   parameters are the host's own. Every SecureString also needs `kms:Decrypt` on the one key, which the role holds
   only for that key.
5. **Container environment at rest.** Docker stores each container's environment in its config on the KMS-encrypted
   data volume, root-readable. The secrets are therefore not only in tmpfs while containers exist.
6. **Container hardening is partial and untested on the host.** Read-only root filesystems are not added for
   `gateway`, `db` or the object store. The added capability drops have a documented fallback (`--no-harden`).
7. **Bypassed paths.** `/federation`, `/mcp`, `/v1/pm/webhooks` and `/v1/chatops` reach the app without Access. Each
   is authenticated by the app (public keys only, API keys, signed webhooks).
8. **The bootstrap token** is a full-admin credential, held in SSM until teardown or removal (§8.13).
9. **Egress to any destination on 443.** Package registries, the model provider and the integrations have no stable
   address list, so there is no domain-level egress filter before the demo.
10. **Short anchor retention.** Anchors are kept 7 days (a demo setting). After that they can be deleted, so the
    proof covers the demo window, not a production retention period.
11. **Not yet executed.** Nothing here has been applied. The controls are proven only once the owner applies them
    and runs the checks in §8.4 and §8.9 a.

## 5. Teardown plan

After the demo (DEMO_RUNBOOK.md §8.11 and §8.13), in this order:

1. Revoke the model API key in the provider's console and delete the credential in the UI.
2. Delete the Cloudflare Access apps and policies, and the tunnel. That revokes the tunnel token.
3. Take a final verified backup.
4. Run `terraform destroy` on `demo-host/host`. This terminates the instance and deletes the volumes, VPC, endpoints
   and NAT gateway. The KMS key enters a 30-day deletion window. The backup bucket refuses deletion while it holds
   backups. The **audit-anchor bucket cannot be emptied until its COMPLIANCE retention ends**, which is up to 7 days:
   no principal, root included, can delete a locked anchor. It is removed from state, outlives the stack by up to the
   retention period, and is deleted by hand afterwards (DEMO_RUNBOOK.md §8.11).
5. Delete the SSM parameters.
6. Keep `demo-host/baseline` (the organization's audit trail) until its successor exists.
7. Run `terraform destroy` on `demo-host/account`. This closes the account, and AWS keeps it suspended for 90 days.

**Proof:** `aws ec2 describe-instances` shows the instance `terminated`, and `aws ssm get-parameters-by-path --path
/regulait/demo-host` returns none.
