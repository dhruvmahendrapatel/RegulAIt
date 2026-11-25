# `byoc-aws`: RegulAIt BYOC in your own AWS account

The customer-run Terraform module for a BYOC install
([ADR-0325](../../../internal/decisions/0325-byoc-aws-pilot-and-rehearsal.md)). It builds the AWS infrastructure the
RegulAIt Helm chart (`deploy/helm/regulait`, ADR-0304) runs on, entirely inside your account. Apply it from
[`infra/environments/byoc-aws`](../../environments/byoc-aws); the step-by-step install is
[docs/deployment/BYOC_AWS_INSTALL.md](../../../docs/deployment/BYOC_AWS_INSTALL.md).

## What it creates

| Part | What | Secure default |
|---|---|---|
| Network | A new VPC over 2 zones: node, database, endpoint and (allow_list) firewall and NAT subnets. Flow logs to CloudWatch. | Default security group has no rules. Database subnets have no route out. |
| Egress | `allow_list` (default): AWS Network Firewall passes TLS only to `egress_allowed_domains` (default: Entra ID sign-in) and drops and logs the rest. `none`: no internet path. | AWS services through VPC endpoints (STS, ECR, EC2, Pod Identity, Logs, KMS, Secrets Manager, Bedrock, S3), never through the firewall. |
| Kubernetes | EKS, one managed node group, add-ons (VPC CNI with NetworkPolicy enforcement, CoreDNS, kube-proxy, Pod Identity agent, EBS CSI). | Private API endpoint. Access entries only. Secrets envelope-encrypted with the stack key. Control-plane audit logs. IMDSv2 with one hop, so pods cannot use the node role. |
| Database | RDS PostgreSQL 16. | Encrypted with the stack key. TLS forced. Multi-AZ. 14 days of point-in-time backups. Final snapshot. Deletion protection. Password generated and held by RDS in Secrets Manager. Reachable only from the nodes. |
| Keys | One customer-managed KMS key for data at rest. | Yearly rotation. The vendor has no grant on it. |
| Audit | S3 Object Lock bucket for audit-chain anchors (`audit-anchor-worm-s3`). | COMPLIANCE mode, 7 years. The gateway can write but never delete or shorten a lock. |
| Backups | S3 bucket for the operator's `pg_dump` uploads (`backup-target-s3`, `kubernetes_job` profile), and a Pod Identity role bound to `<installation>-backup` (ADR-0305 §2). `operator_backups`, on by default. | Versioned, SSE-KMS with the stack key, TLS only, never force-deleted, lifecycle expiry (30 days). The role may only put objects under `pg/` and use the key via S3 for this bucket: no read, list or delete. |
| Models | The gateway's Pod Identity role may invoke only `bedrock_model_ids`. | No model when the list is empty. |
| Images | Private ECR repositories for the gateway and operator images, plus a pull-through cache for `public.ecr.aws`. | Immutable tags. Scan on push. KMS. |

Built from `terraform-aws-modules` (vpc, eks, rds, eks-pod-identity, kms, ecr, network-firewall; exact versions and licences in `infra/THIRD_PARTY.md`) and the repo's `audit-anchor-worm-s3` and `backup-target-s3`. Only the NAT gateways and the routes through the firewall endpoint are written here (ADR-0325).

## Data boundary

**Both planes run in your account.** In RegulAIt's terms, the *control plane* (the governance gateway, policies,
approvals, audit) and the *agent-execution plane* (model, connector and MCP calls made on your users' behalf) are both
on this EKS cluster. All data, from prompts and completions to connector payloads, audit rows, keys and backups, is
stored in this account's RDS, S3 and KMS.

**Nothing goes to RegulAIt (the vendor).** The product makes no telemetry, licence or update call
([DATA_BOUNDARY.md](../../../docs/deployment/DATA_BOUNDARY.md) §1), and this stack opens no network path to a RegulAIt
endpoint. Updates come to you as signed bundles, which you mirror into your ECR. The `data_boundary` output prints this
statement with your resource names in it.

**What does leave the VPC:** Bedrock calls go through the Bedrock VPC endpoint, so they stay inside AWS in your
account and region. Cross-region inference profiles route inside AWS too. HTTPS also goes to each host in
`egress_allowed_domains`, and nowhere else.

## Use with a scoped installer role

If your installer role is limited by [`aws-byoc-deployer-policy`](../aws-byoc-deployer-policy), use the same
`name_prefix` and pass `iam_permissions_boundary_arn = <its workload_boundary_policy_arn>`. Every role this stack
creates then carries the workload boundary (no IAM writes, nothing in a federated session).

## Preflight

`preflight/preflight.sh --account <id> --region <region> --model <id>` checks the following, read-only: your tools, that
you are signed in to the right account, the region and zones, quotas, Network Firewall, Bedrock endpoint availability,
model access, and that the stack's names are free. Run it before `terraform apply`.
