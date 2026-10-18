# Demo real accounts: AWS sandbox, Azure, GitLab (owner runbook)

ADR-0197 decisions 1-8. This page sets up real-account Shadow AI discovery for the 2026-11-01 demo: a third AWS account
with planted Bedrock activity, a small Azure OpenAI deployment with planted activity, and a GitLab demo group, all read
by RegulAIt through keyless federation (AWS, Azure) or a read-only token (GitLab).

> **Status: pending execution (M-041).** No step below has been run against a real account. What was executed is
> listed under [What has been run](#what-has-been-run). Every other step is marked **pending execution**: its commands
> are the standard Terraform and CLI forms, written down but never run here, and no expected output is quoted. The owner
> runs or approves every apply (ADR-0197 decision 6).

## What gets built

| Stack | Directory | Creates | Expected cost |
|---|---|---|---|
| Sandbox account | `infra/environments/demo-sandbox/account` | A member account in the Organization (tagged `Environment=sandbox`, `Purpose=demo`; nothing production), a USD 50 total budget from 2026-10-01 with an alert at 80% and a forecast alert at 100%, and an automatic spend cap: at 100% AWS Budgets attaches an SCP denying Bedrock invocation and Lambda invocation to the account | none |
| Sandbox workload | `infra/environments/demo-sandbox/aws` | A CloudTrail trail (management events, private bucket, 30-day expiry); the role `regulait-ai-discovery` trusting RegulAIt's federation issuer for one discovery source; two scheduled Bedrock generators (`larkfield-support-reply-bot`, `larkfield-invoice-summariser`); one Bedrock guardrail | under USD 1 per month (worked figure in the stack's `main.tf`) |
| Azure | `infra/environments/demo-sandbox/azure` | Resource group `rg-larkfield-ai-demo` with one Azure OpenAI account (key authentication off) and one pay-per-token deployment, a Logic App calling it every 3 hours with its managed identity, diagnostic logs to a capped Log Analytics workspace, a budget alerting at 80%; an Entra app registration with a federated credential for RegulAIt's issuer, Reader on the resource group and an activity-log-only role on the subscription | under USD 1 per month |
| GitLab | `infra/environments/demo-sandbox/gitlab` | Four private projects in the owner's demo group, seeded from `infra/demo-fixtures/gitlab/` (fictional company Larkfield Outfitters), and a group access token with `read_api` and `read_repository` only | none (needs a Premium or Ultimate group for the token, see step 6) |

Modules (project-agnostic): `aws-sandbox-account`, `aws-oidc-federated-role`, `aws-cloudtrail-trail`,
`aws-bedrock-activity-generator`, `azure-federated-reader`, `azure-openai-activity`, `gitlab-seeded-projects`.

Spend ceiling. The AWS budget is USD 50 (the ADR-0197 ceiling) and the Azure budget defaults to 10 in the billing
currency, so together the alarms allow more than USD 50. Expected spend is under USD 2 per month in total. To make the
ceiling strict, set `budget_limit_usd = 40` in the account stack.

No AI model identifier is committed. The Bedrock model id and the Azure OpenAI model name and version are variables set
in each stack's `terraform.tfvars` (git-ignored): pick the lowest-priced text model offered in the region.

## Owner actions before starting

1. **AWS.** An Identity Center session on the management account that may create accounts, budgets, SCPs and IAM roles
   (the `Admin-BreakGlass` permission set). The new account counts against the Organization's account quota.
2. **Azure.** In the tenant, the right to register applications and create service principals. On the subscription,
   Owner (or Contributor plus User Access Administrator). Quota for the chosen model and deployment type in the region.
3. **GitLab.** A top-level demo group on gitlab.com created in the UI, with a fictional name. A group access token needs
   the group on a Premium or Ultimate subscription; trials do not include it. Without that, see the fallback in step 6.
4. **Budget recipients.** The addresses for budget alerts, set only in `terraform.tfvars`.
5. **Keep the dev instance up for the demo.** The demo is on Sunday 2026-11-01. The dev box's power schedule (ADR-0032)
   keeps it off from 20:00 to 08:00 on weekdays and all weekend, and while it is off no cloud can fetch the issuer and
   no scan runs. Set `power_schedule_enabled = false` in `infra/environments/regulait-dev-app` for the demo weekend and
   for every rehearsal outside the window, then set it back after the demo.

## Step 1: make the federation issuer publicly reachable (pending execution)

The clouds verify RegulAIt's federation tokens by fetching, over public HTTPS:

- `https://<demo-host>/federation/.well-known/openid-configuration`
- `https://<demo-host>/federation/.well-known/jwks.json`

Both routes are served by the gateway (`apps/gateway/src/federation-routes.ts`, ADR-0195 SD2b) and are public. Caddy
(`infra/caddy/Caddyfile`) already proxies every path to the gateway over the Let's Encrypt certificate, and ports 80 and
443 are open (`infra/environments/regulait-dev-app`). What was missing is the issuer itself: it is
`<REGULAIT_PUBLIC_URL>/federation`, and the dev box never set `REGULAIT_PUBLIC_URL`, so compose fell back to
`http://localhost:3000` and the discovery document cannot name a public issuer.

This change fixes it for every new instance: `infra/modules/app-instance/user-data.sh.tftpl` now writes
`REGULAIT_PUBLIC_URL=https://<sslip host>` to `/opt/app/.env`, which compose interpolates into the gateway and the
engine runners. `terraform output federation_issuer_url` in `infra/environments/regulait-dev-app` prints the issuer.

Two things to know about the running box:

- User data runs only on an instance's first boot, so the **running** box needs the value set by hand once (1b).
- The next `terraform apply` of `infra/environments/regulait-dev-app` sees the changed user data. The AWS provider
  applies a user-data change by stopping and starting the instance (the Elastic IP keeps the address; the database
  volume is kept). Apply it outside demo and rehearsal hours.

**1a. Keep the box on** (owner action 5): pending execution.

**1b. Set the public URL on the running box** (pending execution). Open an SSM session to the instance
(`terraform output instance_id` in `infra/environments/regulait-dev-app`), then in `/opt/app`:

```bash
# pending execution
echo "REGULAIT_PUBLIC_URL=https://<sslip host>" | sudo tee -a /opt/app/.env
cd /opt/app && sudo docker compose --profile tls up -d
```

The value must be exactly the origin users reach (`terraform output app_url`), with no trailing slash. The gateway
refuses to boot on an invalid value (ADR-0121), so check the gateway logs after the restart.

**1c. Turn federation on in RegulAIt** (pending execution). Admin, **Shadow AI > Discovery sources**
(`/admin/shadow-ai/discovery-sources`), **Cloud federation** card: generate a key, then turn federation on (a
`settings_relax` step-up). The card shows the issuer, the subject format and the audiences.

**1d. Check from outside the box** (pending execution), from any machine:

```bash
# pending execution
curl -fsS https://<demo-host>/federation/.well-known/openid-configuration
curl -fsS https://<demo-host>/federation/.well-known/jwks.json
```

The first document's `issuer` must equal `https://<demo-host>/federation` and its `jwks_uri` must be the second URL;
the key set must hold one `RSA` key with `alg` `RS256`. A 404 with `federation_issuer_unset` means 1b did not take.

## Step 2: create the three discovery sources in RegulAIt (pending execution)

Each trust policy names its source's id (subject `regulait:discovery-source:<source id>`), so create the sources first
and leave them disabled. On **Shadow AI > Discovery sources** (`/admin/shadow-ai/discovery-sources`), choose a kind and
save:

- kind `cloud_aws`, name e.g. "Demo AWS sandbox";
- kind `cloud_azure`, name e.g. "Demo Azure";
- kind `repo_gitlab`, name e.g. "Demo GitLab group".

Copy each source's id for the stacks below.

## Step 3: the sandbox account (pending execution)

```bash
# pending execution, in infra/environments/demo-sandbox/account
cp backend.hcl.example backend.hcl            # fill in the state bucket, as for regulait-dev
cp terraform.tfvars.example terraform.tfvars # fill in the profile, root email, alert recipients
aws sso login --profile <management-sso-profile-name>
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
terraform output sandbox_account_id
```

The account lands at the Organization root by default, so the baseline SCPs apply to it: the region allow-list and
the "deny disable guardrails" SCP. The second one denies `cloudtrail:UpdateTrail` and `cloudtrail:DeleteTrail`, so the
trail created in step 4 cannot be changed or destroyed from inside the account; teardown closes the account instead.

## Step 4: the sandbox workload (pending execution)

Before applying, check in the Bedrock console of the sandbox account (region `us-east-1`, Model catalog) that the
chosen text model can be invoked on demand, and put its id in `bedrock_model_id`. If it is only offered through a
cross-region inference profile, add the profile ARN and its regional model ARNs through the generator module's
`extra_invoke_resource_arns`.

```bash
# pending execution, in infra/environments/demo-sandbox/aws
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars # account id from step 3, issuer from step 1, source id from step 2, model id
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
terraform output
```

IAM fetches the issuer's discovery document when it creates the OIDC provider, so step 1 must be complete first.
The generators run on weekdays hourly from 09:17 to 17:17 and daily at 10:43 and 14:43 (America/New_York) and stop
for good after 2026-11-30. Set `activity_enabled = false` to pause them.

## Step 5: Azure (pending execution)

```bash
# pending execution, in infra/environments/demo-sandbox/azure
az login --tenant <tenant-id>
cp backend.hcl.example backend.hcl            # the same S3 state bucket; needs the AWS SSO session too
cp terraform.tfvars.example terraform.tfvars # tenant, subscription, issuer, source id, model name and version, recipients
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
terraform output
```

`grant_activity_log_read` (default true) adds a custom role holding only `Microsoft.Insights/eventtypes/values/read`
on the subscription. The scanner reads the activity log per subscription, which Reader on the resource group does not
cover; with it off, that read is reported as `denied`. The planted calls themselves are data-plane calls, which appear
in the diagnostic logs (Log Analytics), not in the activity log.

## Step 6: GitLab (pending execution)

1. Create the demo group in the gitlab.com UI (owner action 3).
2. Create a personal access token for your own account with scope `api` and an expiry of a day or two. It is used only
   by this apply. Set it in your shell as `GITLAB_TOKEN`; never in a file in this repository.
3. Apply:

```bash
# pending execution, in infra/environments/demo-sandbox/gitlab
export GITLAB_TOKEN=<your short-lived personal access token>
cp backend.hcl.example backend.hcl
cp terraform.tfvars.example terraform.tfvars # the group's full path
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
```

4. Copy the scanner token straight to the clipboard, never to the terminal or a file:
   `terraform output -raw scanner_token`, piped to your clipboard tool (pending execution). The token lives only in the
   encrypted state and, after step 7, encrypted in RegulAIt.
5. Revoke the personal access token from item 2.

**Fallback without Premium or Ultimate** (pending execution): set `create_group_access_token = false`, then create a
dedicated GitLab account for the demo, add it to the group as Reporter, and give it a personal access token with
scopes `read_api` and `read_repository` only and an expiry shortly after the demo. RegulAIt's repo scanner accepts any
read-only token.

## Step 7: complete and enable the sources (pending execution)

On **Shadow AI > Discovery sources**, for each source enter the values from the stack outputs. Field names follow
[CLOUD_DISCOVERY.md](CLOUD_DISCOVERY.md) (one `key=value` per line).

| Source | Target | Scope | Credential |
|---|---|---|---|
| `cloud_aws` | `accountId`, `stsRegion`, `trailBucket`, `trailBucketRegion` from `terraform output regulait_source_target` | regions: `us-east-1` | federated, `roleArn` = `terraform output discovery_role_arn` |
| `cloud_azure` | `tenantId`, `logAnalyticsWorkspaceIds` from `terraform output regulait_source_target` | subscriptions: the subscription id | federated, `tenantId` and `clientId` from `terraform output regulait_credential_public_config` |
| `repo_gitlab` | `namespace` = the group's full path | organisation-level (the group), or the four `group/project` paths | static token from step 6 (stored encrypted) |

Add each cloud's API hosts to the egress allow-list (each addition is a step-up):

- AWS: `sts.us-east-1.amazonaws.com`, `account.us-east-1.amazonaws.com`, `bedrock.us-east-1.amazonaws.com`,
  `bedrock-agent.us-east-1.amazonaws.com`, `api.sagemaker.us-east-1.amazonaws.com`, `cloudtrail.us-east-1.amazonaws.com`,
  and `<trail bucket>.s3.us-east-1.amazonaws.com`;
- Azure: `login.microsoftonline.com`, `management.azure.com`, `api.loganalytics.io`;
- GitLab: `gitlab.com`.

Then enable each source (a `settings_relax` step-up).

## Step 8: verify a first real scan (pending execution)

Run each source with **Run now** at least a day after step 4, so the generators have run and CloudTrail and Log
Analytics hold events. On the run, every read is listed with an outcome:

- **AWS.** `aws.sts.caller_identity` read for the sandbox account; Bedrock inventory read, with the guardrail listed;
  `aws.bedrock.invocation_logging` reports not enabled (deliberate); CloudTrail `Converse` events grouped under the two
  generator roles (pseudonymised); the trail bucket read.
- **Azure.** The OpenAI account and its deployment from Resource Graph; the activity log read; diagnostic counts from
  the Log Analytics workspace, attributed to the account.
- **GitLab.** The four projects read; sightings for the Python and npm AI SDKs, the provider hosts, the MCP config,
  the IDE extension recommendations, and env-variable presence signatures (ids only; names and values are never stored).

Reading the outcomes: `denied` names a missing permission (compare with the stack's policy); `unreachable` means a host
is missing from the egress allow-list; an AWS `credential_unusable` or an STS error usually means the issuer was not
reachable, the source id in the trust policy is wrong, or federation is off.

Record the first successful scan of each source on screen (ADR-0197 decision 7).

## Teardown after the demo (pending execution)

Tracked follow-up (ADR-0197). In this order:

1. In RegulAIt: disable the three sources and delete their credentials. Turn federation off if nothing else uses it.
2. GitLab: `terraform destroy` in `demo-sandbox/gitlab` (revokes the group token and deletes the projects), then delete
   the group in the UI.
3. Azure: `terraform destroy` in `demo-sandbox/azure`.
4. AWS: `terraform destroy` in `demo-sandbox/account` closes the sandbox account (`close_on_deletion = true`), which
   stops everything in it from billing. The workload stack is not destroyed first: its trail cannot be deleted under
   the baseline SCP. After the account is closed, remove the workload stack's state object from the state bucket.
   A closed account stays suspended for 90 days and counts against the Organization's close-account quota.
5. Set `power_schedule_enabled` back to true in `infra/environments/regulait-dev-app`.

## What has been run

On 2026-10-18, in the build session, with Terraform 1.9.8 and no cloud credentials:

- `terraform fmt -check -recursive` over `infra/modules` and `infra/environments/demo-sandbox`: no changes needed.
- `terraform init -backend=false` and `terraform validate` in each of the four stacks: valid.
- `terraform console` evaluation of `fileset` over the fixture directories: dotfiles such as `.env.example` and
  `.mcp.json` are included.
- The fixtures were run through RegulAIt's own repo analyser (`analyseRepo` in `packages/shared`) to confirm they
  produce sightings.

Nothing was planned or applied against AWS, Azure or GitLab.
