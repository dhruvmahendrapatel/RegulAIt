# Demo real accounts: AWS sandbox, Azure, GitLab, and the live integrations (owner runbook)

ADR-0197 decisions 1-8. This page sets up real-account Shadow AI discovery for the 2026-11-01 internal run-through
and the 2026-11-03 external demo (owner, 2026-10-23): a third AWS account
with planted Bedrock activity, a small Azure OpenAI deployment with planted activity, and a GitLab demo group, all read
by RegulAIt through keyless federation (AWS, Azure) or a read-only token (GitLab). The live endpoint is agentless:
an inventory export of a demo laptop we own, imported through an `endpoint_inventory` source (owner, 2026-10-24,
full-scan FS-1; ADR-0197 addendum of that date). The endpoint agent is not used on the live instance: the gateway
serves no signed collection pack yet (`GET /v1/endpoint-agent/config` answers 503), so a real agent cannot report.
ADR-0202 adds the live GitHub, Jira Cloud, Azure DevOps and Slack accounts: see
[Live integrations](#live-integrations-github-jira-cloud-azure-devops-slack-adr-0202-pending-execution).

> **Status: pending execution (M-041).** No step below has been run against a real account. What was executed is
> listed under [What has been run](#what-has-been-run). Every other step is marked **pending execution**: its commands
> are the standard Terraform and CLI forms, written down but never run here, and no expected output is quoted. The owner
> runs or approves every apply (ADR-0197 decision 6).

## What gets built

| Stack | Directory | Creates | Expected cost |
|---|---|---|---|
| Sandbox account | `infra/environments/demo-sandbox/account` | A member account in the company account's Organization (tagged `Environment=sandbox`, `Purpose=demo`; nothing production), a USD 40 total budget from 2026-10-01 with an alert at 80% and a forecast alert at 100%, and an automatic spend cap: at 100% AWS Budgets attaches an SCP denying Bedrock invocation and Lambda invocation to the account; a guardrail SCP on the account (region allow-list, no leaving the Organization, no stopping or deleting the trail) | none |
| Sandbox workload | `infra/environments/demo-sandbox/aws` | A CloudTrail trail (management events, private bucket, 30-day expiry); the role `regulait-ai-discovery` trusting RegulAIt's federation issuer for one discovery source; two scheduled Bedrock generators (`larkfield-support-reply-bot`, `larkfield-invoice-summariser`); one Bedrock guardrail | under USD 1 per month (worked figure in the stack's `main.tf`) |
| Azure | `infra/environments/demo-sandbox/azure` | Resource group `rg-larkfield-ai-demo` with one Azure OpenAI account (key authentication off) and one pay-per-token deployment, a Logic App calling it every 3 hours with its managed identity, diagnostic logs to a capped Log Analytics workspace, a budget alerting at 80%; an Entra app registration with a federated credential for RegulAIt's issuer, Reader on the resource group and an activity-log-only role on the subscription | under USD 1 per month |
| GitLab | `infra/environments/demo-sandbox/gitlab` | Four private projects in the owner's demo group, seeded from `infra/demo-fixtures/gitlab/` (fictional company Larkfield Outfitters), and a group access token with `read_api` and `read_repository` only | none (needs a Premium or Ultimate group for the token, see step 6) |

Modules (project-agnostic): `aws-sandbox-account`, `aws-oidc-federated-role`, `aws-cloudtrail-trail`,
`aws-bedrock-activity-generator`, `azure-federated-reader`, `azure-openai-activity`, `gitlab-seeded-projects`.

Spend ceiling. ADR-0197 caps the demo at USD 50 in total, AWS and Azure together, through November. The defaults split
it: `budget_limit_usd = 40` in the account stack and `budget_amount = 10` in the azure stack. Both alert at 80% of
actual spend (USD 32 and 8), and at 100% AWS also applies the automatic spend cap. The Azure budget is in the subscription's
billing currency: if that is not USD, set `budget_amount` to the equivalent of USD 10 or less. Expected spend is under USD
2 per month in total. Raising either value relaxes the ceiling and needs the owner's sign-off, since the two budgets
together would then exceed USD 50.

No AI model identifier is committed. The Bedrock model id and the Azure OpenAI model name and version are variables set
in each stack's `terraform.tfvars` (git-ignored): pick the lowest-priced text model offered in the region.

## Owner actions before starting

1. **AWS.** The company AWS account, with Organizations and IAM Identity Center enabled and an admin permission set
   (step 3a-3c); an Identity Center session in it creates accounts, budgets, SCPs and IAM roles. The July Organization is
   deleted and nothing here depends on it. The sandbox counts against the new Organization's account quota.
2. **Azure.** In the tenant, the right to register applications and create service principals. On the subscription,
   Owner (or Contributor plus User Access Administrator). Quota for the chosen model and deployment type in the region.
3. **GitLab.** A top-level demo group on gitlab.com created in the UI, with a fictional name. A group access token needs
   the group on a Premium or Ultimate subscription; trials do not include it. Without that, see the fallback in step 6.
4. **Budget recipients.** The addresses for budget alerts, set only in `terraform.tfvars`.
5. **Keep the dev instance up for the demo.** The internal run-through is on Sunday 2026-11-01 and the external demo
   on Tuesday 2026-11-03. The dev box's power schedule (ADR-0032) keeps it off from 20:00 to 08:00 ET on weekdays and
   all weekend, and while it is off no cloud can fetch the issuer and no scan runs. Before Sunday 2026-10-25, set
   `power_schedule_enabled = false` in `infra/environments/regulait-dev-app`, apply, and confirm both EventBridge
   schedules read DISABLED; set it back after 11-03 (owner decision, #453; commands in
   [DEMO_RUNBOOK.md §7.6](DEMO_RUNBOOK.md#76-live-host-recipes-pending-execution)).

## Step 1: make the federation issuer publicly reachable (pending execution)

The issuer is served from the owner's laptop through a named Cloudflare Tunnel at `https://regulait.<domain>` (owner
decision on #453; lane T of ADR-0203 owns the tunnel, `docker-compose.yml` and Caddy, and its runbook section has the
tunnel commands). This step only states what the AWS stacks need from it. The clouds verify RegulAIt's federation
tokens by fetching, over public HTTPS:

- `https://regulait.<domain>/federation/.well-known/openid-configuration`
- `https://regulait.<domain>/federation/.well-known/jwks.json`

Both routes are served by the gateway (`apps/gateway/src/federation-routes.ts`, ADR-0195 SD2b). The issuer is
`<REGULAIT_PUBLIC_URL>/federation`, so the laptop's `REGULAIT_PUBLIC_URL` must be exactly `https://regulait.<domain>`,
with no trailing slash. The `aws` stack refuses an issuer that is plain `http://`, does not end in `/federation`, or
uses `localhost`, an IP address or a `trycloudflare.com` quick-tunnel name (those names change on every restart, and the
IAM trust is keyed on the exact host).

**1a. Keep the laptop and the tunnel up** (pending execution) whenever a cloud must reach the issuer: when IAM creates
the OIDC provider (step 4), and at every scan.

**1b. Turn federation on in RegulAIt** (pending execution). Admin, **Shadow AI > Discovery sources**
(`/admin/shadow-ai/discovery-sources`), **Cloud federation** card: generate a key, then turn federation on (a
`settings_relax` step-up). The card must show the issuer `https://regulait.<domain>/federation`.

**1c. Check from outside the laptop** (pending execution), for example from a phone hotspot, in PowerShell:

```powershell
# pending execution
curl.exe -fsS https://regulait.<domain>/federation/.well-known/openid-configuration
curl.exe -fsS https://regulait.<domain>/federation/.well-known/jwks.json
```

The first document's `issuer` must equal `https://regulait.<domain>/federation` and its `jwks_uri` must be the second
URL; the key set must hold one `RSA` key with `alg` `RS256`. A 404 with `federation_issuer_unset` means
`REGULAIT_PUBLIC_URL` is not set on the laptop.

## Step 2: create the four discovery sources in RegulAIt (pending execution)

Each trust policy names its source's id (subject `regulait:discovery-source:<source id>`), so create the sources first
and leave them disabled. **Prepare the live database before this step, once** (`demo:prepare --live`,
[DEMO_RUNBOOK.md §7.1](DEMO_RUNBOOK.md#71-what-runs-where)): re-preparing afterwards makes new source ids,
and every federated run then fails until both stacks are re-applied. Never run `docker compose down -v` on the live
host. On **Shadow AI > Discovery sources** (`/admin/shadow-ai/discovery-sources`), choose a kind and
save:

- kind `cloud_aws`, name e.g. "Demo AWS sandbox";
- kind `cloud_azure`, name e.g. "Demo Azure";
- kind `repo_gitlab`, name e.g. "Demo GitLab group";
- kind `endpoint_inventory`, name e.g. "Demo laptop inventory" (no stack needs its id: it trusts nothing and fetches
  nothing; it is fed by an import, step 7).

Copy each cloud and GitLab source's id for the stacks below. Do not add an `endpoint_agent` source on the live
instance.

## Step 3: the company account and the sandbox account (pending execution)

The July Organization (management account plus `regulait-dev`) is deleted. Everything here runs in the new company
AWS account, which becomes the management account of a new Organization; the sandbox is a member account inside it.
No IAM user and no access key is created at any point (ADR-0004).

**3a. Organizations** (pending execution, console, signed in to the company account). AWS Organizations > Create an
organization, with all features. The company account becomes the management account.

**3b. IAM Identity Center** (pending execution, console). IAM Identity Center > Enable (an organization instance, in
the region you will use, e.g. `us-east-1`). Create your user, create a permission set based on `AdministratorAccess`
(any name, e.g. `<admin-permission-set>`), and assign it to your user on the company account. Use it only for these
stacks and the bootstrap. Note the AWS access portal URL.

**3c. The CLI profile** (pending execution, PowerShell):

```powershell
# pending execution
aws configure sso --profile <company-account-sso-profile-name>   # portal URL from 3b, region, the admin permission set
aws sso login --profile <company-account-sso-profile-name>
aws sts get-caller-identity --profile <company-account-sso-profile-name>   # Account = the company account, Arn = ...AWSReservedSSO_...
```

**3d. The state backend** (pending execution). `infra/bootstrap/bootstrap-backend.sh` creates the KMS key, the state
bucket and the lock table in the company account, enables the SCP policy type on the Organization root (the sandbox
guardrails and the spend cap are SCPs), and writes a git-ignored `backend.hcl` into `demo-sandbox/account` and
`demo-sandbox/aws`. It refuses to run, before creating anything, if the profile resolves to any account other than
`EXPECTED_ACCOUNT_ID`, if the session is not an Identity Center role, if the account is not the management account of
an all-features Organization, or if the bucket, table or key alias already exists. Run it from Git Bash in the repo
root, preflight first:

```bash
# pending execution, Git Bash, repo root
export AWS_PROFILE=<company-account-sso-profile-name> AWS_REGION=us-east-1 EXPECTED_ACCOUNT_ID=<12-digit-company-account-id>
infra/bootstrap/bootstrap-backend.sh --preflight-only
infra/bootstrap/bootstrap-backend.sh
```

**3e. The sandbox account** (pending execution, PowerShell). The plan creates the member account, its USD 40 budget
and spend cap, and a guardrail SCP attached to the sandbox account only: a region allow-list (`allowed_regions`,
default `us-east-1` and `us-east-2`), no `organizations:LeaveOrganization`, and no `cloudtrail:StopLogging` or
`cloudtrail:DeleteTrail`. The provider refuses any account other than `management_account_id`. Review the plan before
applying it.

```powershell
# pending execution, in infra/environments/demo-sandbox/account
Copy-Item terraform.tfvars.example terraform.tfvars   # profile, company account id, root email, alert recipients
# backend.hcl was written by 3d; otherwise copy backend.hcl.example and fill it in from the bootstrap output
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
# review the plan: one aws_organizations_account, the budget, the spend-cap SCP and its role, the guardrail SCP and its attachment
terraform apply tfplan
terraform output sandbox_account_id
```

The account lands at the Organization root by default. The new Organization has no baseline SCPs; the guardrail SCP
above is what limits the sandbox. Because it denies `cloudtrail:DeleteTrail`, the trail created in step 4 cannot be
destroyed from inside the account; teardown closes the account instead.

## Step 4: the sandbox workload (pending execution)

Before applying, check in the Bedrock console of the sandbox account (switch role into
`OrganizationAccountAccessRole` of the new account from the company account; region `us-east-1`, Model catalog) that
the chosen text model can be invoked on demand **in that region**, and put its id in `bedrock_model_id`. This keeps
every call inside the guardrail SCP's region allow-list, and it is the default: the stack rejects an inference-profile
id (`us.`, `eu.`, `global.` and similar prefixes) unless `allow_cross_region_inference = true`.

Cross-region inference profiles route a call to other regions, and the guardrail SCP denies any region outside
`allowed_regions` of the account stack. A profile that also routes to, say, `us-west-2` fails with an access-denied
error there. Use one only if no suitable model is invocable on demand in-region, and then:

1. add every region the profile routes to into `allowed_regions` in `demo-sandbox/account` (plan, review, apply), and
   set the same list as `bedrock_allowed_regions` here;
2. set `allow_cross_region_inference = true`, `bedrock_model_id` to the profile id, and `bedrock_extra_invoke_arns` to
   the profile ARN and the regional model ARNs behind it. The stack rejects any ARN outside `bedrock_allowed_regions`.

Each generator Lambda reserves a concurrency of 1, so runs never overlap, and neither the schedule nor Lambda retries
a failed run. A new account's Lambda concurrency quota can be as low as 10, and AWS keeps 10 unreserved, so the apply
can fail with "decreases account's UnreservedConcurrentExecution below its minimum value". In that case either request a
quota increase or set `generator_reserved_concurrency = -1` (no reservation). The retry limits still apply, so a run
still makes at most `calls_per_run` calls.

IAM fetches the issuer's discovery document when it creates the OIDC provider, so step 1 must be complete and the
tunnel up while you apply.

```powershell
# pending execution, in infra/environments/demo-sandbox/aws
Copy-Item terraform.tfvars.example terraform.tfvars   # account id from 3e, issuer https://regulait.<domain>/federation, source id from step 2, model id
aws sso login --profile <company-account-sso-profile-name>
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
# review the plan: the OIDC provider for the issuer, role regulait-ai-discovery (trust: aud sts.amazonaws.com,
# sub regulait:discovery-source:<id>, StringEquals), the trail and its bucket, two generators, one guardrail
terraform apply tfplan
terraform output
```

The generators run on weekdays hourly from 09:17 to 17:17 and daily at 10:43 and 14:43 (America/New_York) and stop
for good after 2026-11-30. Set `activity_enabled = false` to pause them.

**Teardown note (company account).** `terraform destroy` in `demo-sandbox/account` closes the sandbox account
(`close_on_deletion = true`) and removes its budget and SCPs; do not destroy `demo-sandbox/aws` first (its trail
cannot be deleted under the guardrail SCP). Afterwards remove the `demo-sandbox/aws` state object from the state
bucket. The state bucket, lock table and KMS key in the company account are kept unless the owner deletes them by
hand (the key with a pending-deletion window). The Organization and Identity Center stay. Full sequence:
[DEMO_TEARDOWN.md](DEMO_TEARDOWN.md).

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
   `terraform output -raw scanner_token`, piped to your clipboard tool (pending execution). After step 7 RegulAIt
   stores it encrypted. **The Terraform state also holds it in plaintext**, as a value in the state JSON.
   `sensitive` only hides it from terminal output. The state backend encrypts the object at rest, but anyone who has
   `s3:GetObject` on the state key and `kms:Decrypt` on its key can read the token, and it stays in state until
   `terraform destroy`. Keep this stack on an encrypted remote backend with access limited to the owner (the
   `backend.hcl` from step 6.3), never on local state. Revoke or rotate the token right after the demo (Teardown).
   The fallback below keeps the token out of state entirely.
5. Revoke the personal access token from item 2.

**Fallback without Premium or Ultimate** (pending execution): set `create_group_access_token = false`, then create a
dedicated GitLab account for the demo, add it to the group as Reporter, and give it a personal access token with
scopes `read_api` and `read_repository` only and an expiry shortly after the demo. RegulAIt's repo scanner accepts any
read-only token.

## Step 7: complete and enable the sources (pending execution)

On **Shadow AI > Discovery sources**, for each source enter the values from the stack outputs. Field names follow
[CLOUD_DISCOVERY.md](../../docs/deployment/CLOUD_DISCOVERY.md) (one `key=value` per line).

| Source | Target | Scope | Credential |
|---|---|---|---|
| `cloud_aws` | `accountId`, `stsRegion`, `trailBucket`, `trailBucketRegion` from `terraform output regulait_source_target` | regions: `us-east-1` | federated, `roleArn` = `terraform output discovery_role_arn` |
| `cloud_azure` | `tenantId`, `logAnalyticsWorkspaceIds` from `terraform output regulait_source_target` | subscriptions: the subscription id | federated, `tenantId` and `clientId` from `terraform output regulait_credential_public_config` |
| `repo_gitlab` | `namespace` = the group's full path | organisation-level (the group), or the four `group/project` paths | static token from step 6 (stored encrypted) |
| `endpoint_inventory` | none (leave empty) | organisation-level | none; no egress entry |

Add each cloud's API hosts to the egress allow-list (each addition is a step-up):

- AWS: `sts.us-east-1.amazonaws.com`, `account.us-east-1.amazonaws.com`, `bedrock.us-east-1.amazonaws.com`,
  `bedrock-agent.us-east-1.amazonaws.com`, `api.sagemaker.us-east-1.amazonaws.com`, `cloudtrail.us-east-1.amazonaws.com`,
  and `<trail bucket>.s3.us-east-1.amazonaws.com`;
- Azure: `login.microsoftonline.com`, `management.azure.com`, `api.loganalytics.io`;
- GitLab: `gitlab.com`.

Then enable each source (a `settings_relax` step-up).

**The device inventory import (pending execution).** Export the demo laptop's installed software, from the MDM that
manages it if one does, otherwise from the laptop's own installed-software list, as CSV or JSON with at least a
device column and an application-name column, with the AI desktop apps planted on it included. On **Import endpoint
evidence**, choose the `endpoint_inventory` source and the file, press **Dry run**, check that the planted apps match
and nothing unexpected is refused, then **Import**. The file and the fields are described in
[DEMO_RUNBOOK.md §7.2](DEMO_RUNBOOK.md#72-discovery-sources-on-the-live-instance-pending-execution). Never
import the fallback's dataset here: `demo:check --live` FAILs on any of its markers.

## Step 8: verify a first real scan (pending execution)

Run each source with **Run now** at least a day after step 4, so the generators have run and CloudTrail and Log
Analytics hold events. On the run, every read is listed with an outcome:

- **AWS.** `aws.sts.caller_identity` read for the sandbox account; Bedrock inventory read, with the guardrail listed;
  `aws.bedrock.invocation_logging` reports not enabled (deliberate); CloudTrail `Converse` events grouped under the two
  generator roles (pseudonymised); the trail bucket read, which is expected to return **no records**. The scanner reads
  the trail bucket for Bedrock *data* events (`InvokeAgent`, `Retrieve`). This trail logs management events only, and
  the planted calls are `Converse` management events, which `cloudtrail:LookupEvents` reports above. An empty bucket
  read is not a fault. The bucket stays in the source target so that the read path and its permissions are exercised.
- **Azure.** The OpenAI account and its deployment from Resource Graph; the activity log read; diagnostic counts from
  the Log Analytics workspace, attributed to the account.
- **GitLab.** The four projects read; sightings for the Python and npm AI SDKs, the provider hosts, the MCP config,
  the IDE extension recommendations, and env-variable presence signatures (ids only; names and values are never stored).
- **Device inventory.** The import's run reads *succeeded* in **Recent runs**, and each planted AI app is a finding
  with the evidence *Endpoint inventory*, its device and user as pseudonyms.

Reading the outcomes: `denied` names a missing permission (compare with the stack's policy); `unreachable` means a host
is missing from the egress allow-list; an AWS `credential_unusable` or an STS error usually means the issuer was not
reachable, the source id in the trust policy is wrong, or federation is off.

Record the first successful scan of each source on screen (ADR-0197 decision 7).

## Live integrations: GitHub, Jira Cloud, Azure DevOps, Slack (ADR-0202, pending execution)

ADR-0202 decision 1 connects the 11-03 demo to real GitHub, Jira Cloud, Azure DevOps and Slack accounts. Every
section below is **pending execution**: none of it has been run against a real account. Placeholders: the public URL
is `https://demo.example.com` (the real one is `REGULAIT_PUBLIC_URL` on the host, never in the repo), the Jira site is
`regulait-demo.atlassian.net`, and the Azure DevOps organisation is `regulait-demo`.

**Credentials never pass through chat or the repo (ADR-0202 decision 5).** `demo:live-setup` asks for each one at a
hidden prompt. Alternatively, put them in a JSON file **outside the checkout**, run `chmod 600` on it, and set
`REGULAIT_DEMO_LIVE_SECRETS_FILE` to its absolute path. The script refuses a file inside the repository or readable by
group or others. The file holds only these keys:
`githubToken`, `jiraApiToken`, `adoPat`, `slackBotToken`, `slackSigningSecret`. Nothing is echoed or logged, and
every message the script prints is scrubbed of the values. Delete the file after setup.

### Order of operations (pending execution)

1. Create the four accounts and their credentials, as described in the sections below.
2. On the host, set the non-secret settings:

   | Variable | Example |
   |---|---|
   | `REGULAIT_DEMO_PROFILE` | `live` |
   | `REGULAIT_DEMO_GITHUB_REPO` | `regulait-demo/payments-api` |
   | `REGULAIT_DEMO_JIRA_SITE` | `regulait-demo.atlassian.net` |
   | `REGULAIT_DEMO_JIRA_PROJECT` | `DEMO` |
   | `REGULAIT_DEMO_JIRA_EMAIL` | the token owner's email |
   | `REGULAIT_DEMO_ADO_ORG` | `regulait-demo` |
   | `REGULAIT_DEMO_ADO_PROJECT` | `Payments` |
   | `REGULAIT_DEMO_SLACK_CHANNEL` | the channel id, `C…` |
   | `REGULAIT_DEMO_SLACK_TEAM_ID` | the workspace id, `T…` (optional; it pins inbound callbacks to that workspace) |

   Also set `REGULAIT_PUBLIC_URL`, `DATABASE_URL`, `REGULAIT_BOOTSTRAP_TOKEN` and `REGULAIT_DATA_KEY`, as for every
   demo script.
3. Run the seed (`pnpm --filter @regulait/gateway seed`) with `REGULAIT_DEMO_PROFILE=live`. This adds the live egress
   entries during first-admin setup, before Ada enrols her authenticator. The mock seed, without the variable, adds
   none.
4. Run `pnpm --filter @regulait/gateway demo:live-setup`. It re-checks the egress entries, then creates `live-github`,
   `live-jira`, `live-azure-devops`, the `live-slack` connector (with the bot token) and the `live-slack` ChatOps
   workspace. Re-running it is safe: existing connections are kept, and the Slack bot token is re-stored.
   - The product mints one **inbound secret** per PM connection. With `REGULAIT_DEMO_LIVE_INBOUND_FILE` (an absolute
     path outside the checkout), the secrets are written there with mode 0600. Otherwise they are printed once.
     Register them as described under Jira and Azure DevOps below.
   - To replace a GitHub, Jira or Azure DevOps token, delete that connection in the admin UI and re-run. The API has
     no route that replaces those tokens in place.
5. Run `pnpm --filter @regulait/gateway demo:check -- --live-connections`. This makes one read-only call per
   connection through the egress guard and reports PASS, WARN or FAIL per beat. No credential is printed.

**Egress entries** (exact hosts; the guard supports no wildcards, by design):

| Host | Used for |
|---|---|
| `api.github.com` | the git provider's only host (REST; there is no git-over-https push) |
| the one Jira site, `regulait-demo.atlassian.net` | Jira; never `*.atlassian.net` |
| `dev.azure.com` | Azure DevOps |
| `slack.com` | the Web API |
| `api.resend.com` | lane E's email channel |

If the seed ran after Ada enrolled, an admin adds any missing host under **Custom LLM providers > Egress allow-list**,
with a step-up. `demo:live-setup` names any missing host.

**Fallback (ADR-0202 decision 4).** Each beat is live by default. An admin can switch one beat back to its simulated
path from the admin console (Execution control › Demo beats) or with `PUT /v1/demo/beats/<beat> { "simulated": true, "reason": "…" }`,
sent with an admin's API key (`curl -X PUT https://demo.example.com/v1/demo/beats/pm-sync -H "authorization: Bearer $REGULAIT_ADMIN_API_KEY"
-H "content-type: application/json" -d '{"simulated":true,"reason":"vendor outage"}'`); `GET /v1/demo/beats` lists every
beat's mode. Every switch is
audited under the rule `demo-beat-fallback-changed`. The beats are `shadow-ai-discovery`, `enforce-it`, `pm-sync`,
`git-pr`, `chatops-approval` and `email-notify`. Switch a beat back when the vendor recovers.

### GitHub (git-pr beat, pending execution)

1. Create a GitHub organisation for the demo, for example `regulait-demo`, and one private repository in it, for
   example `payments-api`, with a `main` branch and one commit. Use fictional content only.
2. Create a **fine-grained personal access token**:
   - Resource owner: the demo organisation.
   - Repository access: **only** the demo repository.
   - Expiry: 2026-11-10.
   - Repository permissions:
     - **Contents**: read and write (branch and commit).
     - **Pull requests**: read and write (open and merge).
     - **Checks**: read (check runs on the PR head).
     - **Commit statuses**: read.
     - **Metadata**: read (always on).
   - Grant nothing at organisation level.
   - Confirm at setup that these permissions cover the beat: the git provider calls `git/refs`, `pulls`,
     `pulls/:n/merge`, `commits/:sha/check-runs`, `contents` and `git/trees`.
3. Enter it at the `GitHub fine-grained token` prompt.
4. There is no inbound webhook: PR and check state is polled.

### Jira Cloud (pm-sync beat, pending execution)

1. Create a free Jira Cloud site, for example `regulait-demo.atlassian.net`, with one Scrum or Kanban project whose key
   is `DEMO`.
2. Create a demo user who can browse, create, edit and transition issues in that project, and nothing else. As that
   user, create an **API token** at id.atlassian.com > Security > API tokens. RegulAIt sends it as basic auth in the
   form `email:token`; set `REGULAIT_DEMO_JIRA_EMAIL` to the user's email.
3. Enter the token at the `Jira Cloud API token` prompt.
4. Register the inbound webhook under Jira settings > System > WebHooks > Create:
   - URL: `https://demo.example.com/v1/pm/webhooks/live-jira?token=<the inbound secret for live-jira>`. The token is
     compared in constant time.
   - Events: Issue created, updated and deleted, and Comment created.
   - JQL: `project = DEMO`.

### Azure DevOps (pm-sync beat, pending execution)

1. Create a free Azure DevOps organisation, for example `regulait-demo`, and one project, for example `Payments`, with
   the Agile or Basic process.
2. Create a **personal access token** under User settings > Personal access tokens:
   - Organisation: the demo organisation only.
   - Expiry: 2026-11-10.
   - Custom scopes:
     - **Work Items**: read and write.
     - **Project and Team**: read (the health check reads the project).
     - **Code**: read and write, only if the demo also uses an Azure DevOps repository. The live profile does not by
       default.
3. Enter it at the `Azure DevOps personal access token` prompt.
4. Register the inbound service hook under Project settings > Service hooks > + > **Web Hooks**:
   - Events: **Work item created** and **Work item updated**, one subscription each.
   - URL: `https://demo.example.com/v1/pm/webhooks/live-azure-devops`.
   - Basic authentication: any username; the password is the inbound secret for `live-azure-devops`. It is compared in
     constant time.

### Slack (chatops-approval beat, pending execution)

1. Create a free Slack workspace for the demo and a public channel, for example `#regulait-approvals`. Note the
   channel id (`C…`, under channel details) and the workspace id (`T…`).
2. Create the app from the committed manifest,
   [`infra/demo-fixtures/slack/regulait-demo-app.manifest.yaml`](../../infra/demo-fixtures/slack/regulait-demo-app.manifest.yaml).
   Replace `demo.example.com` with the real public host before pasting it. The manifest sets:
   - bot scopes `chat:write`, `users:read`, `users:read.email`, `channels:read`, `channels:history` and
     `app_mentions:read`;
   - the interactivity URL `/v1/chatops/live-slack/interactions`;
   - the events URL `/v1/chatops/live-slack/events`, with the `app_mention` event.
3. Install the app to the workspace and invite the bot to the channel (`/invite @regulait-demo`).
4. Enter the two credentials at their prompts:
   - **Bot User OAuth Token** (OAuth & Permissions; it starts `xoxb-`) at `Slack bot token`.
   - **Signing Secret** (Basic Information > App Credentials) at `Slack signing secret`. Inbound callbacks are
     HMAC-verified against it with a 300-second replay window.
5. After `demo:live-setup` has created the `live-slack` workspace, save the events URL in the app settings again.
   Slack's `url_verification` handshake is answered only once the workspace exists.
6. Link each approver's Slack user to their RegulAIt user under **ChatOps > Identity links**. Approvals decided in
   Slack are recorded against the linked person, never the bot.

### Teardown (pending execution)

Add these steps after the demo:
- Revoke the GitHub token and the Azure DevOps PAT.
- Revoke the Jira API token, and delete the Jira webhook and the Azure DevOps service hooks.
- Uninstall the Slack app.
- Delete the `live-*` connections in RegulAIt.
- Delete the secrets file and the inbound file.

## Teardown after the demo (pending execution)

Tracked follow-up (ADR-0197). The full post-demo runbook, which mirrors every setup step above in reverse with
verification checks, is [DEMO_TEARDOWN.md](DEMO_TEARDOWN.md) (pending execution — post-demo, owner). The summary below
is kept for reference. In this order:

1. In RegulAIt: disable the four sources (three scanners and the device inventory source) and delete the scanners'
   credentials. Turn federation off if nothing else uses it.
2. GitLab: `terraform destroy` in `demo-sandbox/gitlab` (revokes the group token and deletes the projects), then delete
   the group in the UI. If the fallback was used, revoke the demo account's personal access token instead. Either way,
   no scanner token from the demo stays valid, and the destroy also removes the token's plaintext copy from state.
3. Azure: `terraform destroy` in `demo-sandbox/azure`.
4. AWS: `terraform destroy` in `demo-sandbox/account` closes the sandbox account (`close_on_deletion = true`), which
   stops everything in it from billing. The workload stack is not destroyed first: its trail cannot be deleted under
   the sandbox guardrail SCP. After the account is closed, remove the workload stack's state object from the state bucket.
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
- In the review fix round (same day), `fmt` and `validate` again in all four stacks. The `aws` stack's new variable
  checks were run with `terraform plan` on a provider-free copy of those variables. An in-region model id passes. An
  inference-profile id fails unless `allow_cross_region_inference = true`. Extra ARNs fail unless that flag is set, and
  an ARN in `us-west-2` fails against the default `bedrock_allowed_regions`.

Nothing was planned or applied against AWS, Azure or GitLab.

On 2026-10-26, lane S (company-account sandbox), with Terraform 1.9.8 and no cloud credentials:

- `terraform fmt -check -recursive` over `infra/environments/demo-sandbox` and `infra/modules/aws-sandbox-account`:
  exit 0.
- `terraform init -backend=false` and `terraform validate` in `demo-sandbox/account`, `demo-sandbox/aws` and the
  `aws-sandbox-account` module: valid, exit 0 each.
- The issuer variable checked with `terraform plan` on a provider-free copy of the `aws` stack's variables:
  `https://regulait.example.com/federation` passes; plain `http://`, `localhost`, `127.0.0.1`, an IP address, a
  `trycloudflare.com` name and a URL without `/federation` are refused. The module's `allowed_regions` check refuses an
  empty list and a malformed region.
- `bootstrap-backend.sh` run against a stub `aws` command (no AWS call): it refuses, with exit 1 and before creating
  anything, a wrong account, an IAM-user caller, no Organization, a non-management account, a consolidated-billing-only
  Organization, an existing bucket and a malformed or missing `EXPECTED_ACCOUNT_ID`; `--preflight-only` creates nothing;
  a full stub run writes both `backend.hcl` files and a second run keeps them. `shellcheck` 0.10.0: clean.

Nothing was planned or applied against AWS.
