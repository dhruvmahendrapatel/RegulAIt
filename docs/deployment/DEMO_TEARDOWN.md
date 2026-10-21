# Demo sandbox teardown (post-demo, owner-executed)

ADR-0197 consequences: "Teardown of the sandbox resources after the demo is a tracked follow-up." This page is that
follow-up. It undoes everything [DEMO_REAL_ACCOUNTS.md](DEMO_REAL_ACCOUNTS.md) sets up, and the endpoint-agent
enrolment of [DEMO_RUNBOOK.md §7.2](../product/DEMO_RUNBOOK.md#72-discovery-sources-on-the-live-instance-pending-execution).
Each step names the setup step it reverses, so nothing is missed.

> **Status: pending execution — post-demo, owner (M-041).** Nothing on this page has been run. Do not start before the
> demo on 2026-11-01 is over. The owner runs every step; no builder or agent session runs any of it. Commands are the
> standard Terraform, AWS CLI, Azure CLI and GitLab forms, written down but never run here, and no expected output is
> quoted beyond what a check is looking for. Real account, tenant, subscription, client and group identifiers are
> placeholders in angle brackets; they live in the owner's notes and the stacks' state, never in this repository.

## Order

Reverse of setup. Revoke trust and credentials first, so nothing can authenticate while the rest comes down; delete
resources next; close the account last; then check that each item is gone.

| # | Teardown step | Reverses (setup section) | Status |
|---|---|---|---|
| T1 | RegulAIt: disable the four sources, delete their credentials, revoke the endpoint enrolment | DEMO_REAL_ACCOUNTS step 7; step 2; DEMO_RUNBOOK §7.2 (`endpoint_agent` row) | pending execution — post-demo, owner |
| T2 | RegulAIt: remove the egress allow-list entries | DEMO_REAL_ACCOUNTS step 7 ("Add each cloud's API hosts") | pending execution — post-demo, owner |
| T3 | RegulAIt: turn cloud federation off and retire its key | DEMO_REAL_ACCOUNTS step 1c; DEMO_RUNBOOK §7.2 (Cloud federation card) | pending execution — post-demo, owner |
| T4 | GitLab: revoke the scanner token, delete the projects and the group | DEMO_REAL_ACCOUNTS step 6 | pending execution — post-demo, owner |
| T5 | Azure: federated credential, app registration, role assignments, custom role, AI services account, Logic App, Log Analytics, budget, resource group | DEMO_REAL_ACCOUNTS step 5 | pending execution — post-demo, owner |
| T6 | AWS workload: the discovery role and its OIDC provider, the generators, the guardrail (trail excluded) | DEMO_REAL_ACCOUNTS step 4 | pending execution — post-demo, owner |
| T7 | AWS account: budget, budget action and its role, spend-cap SCP, then account closure | DEMO_REAL_ACCOUNTS step 3 | pending execution — post-demo, owner |
| T8 | Dev instance: power schedule back on; decide on `REGULAIT_PUBLIC_URL` | DEMO_REAL_ACCOUNTS owner action 5, step 1a, step 1b | pending execution — post-demo, owner |
| T9 | Local files and state objects | DEMO_REAL_ACCOUNTS steps 3-6 (`backend.hcl`, `terraform.tfvars`, `tfplan`) | pending execution — post-demo, owner |
| T10 | Verification sweep | all of the above | pending execution — post-demo, owner |
| T11 | Closure decisions and records | ADR-0197 decision 2 (third account), owner actions | pending execution — post-demo, owner |

## T1. RegulAIt: sources, credentials, endpoint enrolment (pending execution — post-demo, owner)

Reverses DEMO_REAL_ACCOUNTS step 7 (credentials entered, sources enabled) and step 2 (sources created), and the
`endpoint_agent` row of DEMO_RUNBOOK §7.2.

On the live instance, **Shadow AI > Discovery sources** (`/ui/admin/shadow-ai/discovery-sources`):

1. For each of the four sources (`cloud_aws`, `cloud_azure`, `repo_gitlab`, `endpoint_agent`): **Disable**, then
   delete its credential. The GitLab source's static token is the one stored secret; deleting the credential removes
   RegulAIt's encrypted copy (the token itself is revoked at GitLab in T4).
2. **Endpoint agent enrolment**: revoke the enrolment token, and in the revoke dialog also choose "revoke the devices
   it enrolled" (owner decision Q14). On the device, uninstall the agent and remove its enrolment file
   (`agents/endpoint/README.md`).
3. Keep the sources' runs and findings: the audit trail is append-only, and the findings are the demo's record. Delete
   the sources themselves only if the owner decides to (T11).

Verify: the sources list shows all four disabled, each with no credential; the enrolment token reads revoked and its
device list is empty or revoked.

## T2. RegulAIt: egress allow-list (pending execution — post-demo, owner)

Reverses the egress additions of DEMO_REAL_ACCOUNTS step 7. Remove each entry that was added only for the demo:

- AWS: `sts.us-east-1.amazonaws.com`, `account.us-east-1.amazonaws.com`, `bedrock.us-east-1.amazonaws.com`,
  `bedrock-agent.us-east-1.amazonaws.com`, `api.sagemaker.us-east-1.amazonaws.com`,
  `cloudtrail.us-east-1.amazonaws.com`, `<trail bucket>.s3.us-east-1.amazonaws.com`;
- Azure: `login.microsoftonline.com`, `management.azure.com`, `api.loganalytics.io`;
- GitLab: `gitlab.com`.

Before removing a host, check that no other source or connector on the instance uses it. Removing an entry tightens
the posture; adding one back later is a step-up again.

Verify: the egress allow-list holds none of the hosts above that were demo-only.

## T3. RegulAIt: cloud federation (pending execution — post-demo, owner)

Reverses DEMO_REAL_ACCOUNTS step 1c. On the **Cloud federation** card: turn federation off, unless another source on
the instance still uses it. If the card offers to retire the key it generated, retire it; whether it does is not
checked here (pending execution).

Verify from any machine (pending execution):

```bash
# pending execution — post-demo, owner
curl -sS -o /dev/null -w '%{http_code}\n' https://<demo-host>/federation/.well-known/openid-configuration
```

The check is that the answer is no longer a discovery document. Read the status code it prints; this page does not
predict it.

## T4. GitLab (pending execution — post-demo, owner)

Reverses DEMO_REAL_ACCOUNTS step 6.

The destroy needs GitLab provider credentials again. As in setup step 6.2, create a personal access token for your
own account with scope `api` and an expiry of a day, set it only in your shell, and revoke it at the end of this step.

```bash
# pending execution — post-demo, owner, in infra/environments/demo-sandbox/gitlab
export GITLAB_TOKEN=<short-lived personal access token>
terraform init -backend-config=backend.hcl
terraform plan -destroy -out=destroy.tfplan
terraform apply destroy.tfplan
unset GITLAB_TOKEN
```

The destroy revokes the group access token `regulait-ai-discovery-read-only`, deletes the four projects and their
seeded files, and drops the token's plaintext copy from the state (setup step 6.4).

Then, in the gitlab.com UI:

1. Delete the demo group (setup step 6.1, owner action 3).
2. Revoke the short-lived personal access token used for this destroy.
3. Check that the setup token of step 6.2 is revoked (setup step 6.5 revoked it; confirm it is not listed as active).
4. **If the fallback was used** (no Premium or Ultimate): revoke the demo account's personal access token
   (`read_api`, `read_repository`), remove the account from the group, then delete the demo account.
5. **If the group was on a paid plan only for this demo** (setup owner action 3): cancel or downgrade that plan
   (decision in T11).

Verify (pending execution): your account's access-token list has no active token from the demo; the group no longer
appears under your groups, or shows as pending deletion (then check again after the deletion date it shows); with a
fresh short-lived token, `curl -sS -H "PRIVATE-TOKEN: $GITLAB_TOKEN" "https://gitlab.com/api/v4/groups/<group full path, URL-encoded>"`
no longer returns the group (read the status code; it is not predicted here), then revoke that token too.

## T5. Azure (pending execution — post-demo, owner)

Reverses DEMO_REAL_ACCOUNTS step 5 (and owner action 2). One stack holds every Azure item: the resource group
`rg-<slug>-ai-demo` with the AI services account (`azurerm_cognitive_account`), its `store-assistant` deployment, the Logic App generator and its role
assignment, the Log Analytics workspace and diagnostic setting, and the resource-group budget; and the Entra app
registration `regulait-ai-discovery-demo` with its service principal, federated credential, Reader assignment on the
resource group, and the custom activity-log role and its assignment on the subscription.

```bash
# pending execution — post-demo, owner, in infra/environments/demo-sandbox/azure
az login --tenant <tenant-id>
aws sso login --profile <management-sso-profile-name>   # the state bucket, as in setup
terraform init -backend-config=backend.hcl
terraform plan -destroy -out=destroy.tfplan
terraform apply destroy.tfplan
```

Read the destroy plan before applying: it must list the federated credential, the app registration, the service
principal, both role assignments, the custom role definition, and everything in the resource group, and nothing
outside them.

Soft-deleted leftovers. Azure keeps some deleted objects recoverable for a while. Check each, and purge where it is
listed (pending execution):

```bash
# pending execution — post-demo, owner
# Entra: a deleted app registration goes to deleted items first
az rest --method GET --url "https://graph.microsoft.com/v1.0/directory/deletedItems/microsoft.graph.application" \
  --query "value[?displayName=='regulait-ai-discovery-demo'].{id:id,name:displayName}"
#   if listed: az rest --method DELETE --url "https://graph.microsoft.com/v1.0/directory/deletedItems/<id>"

# the AI services (Cognitive Services) account
az cognitiveservices account list-deleted
#   if listed: az cognitiveservices account purge --location <region> --resource-group <rg> --name <account name>

# Log Analytics workspace
az monitor log-analytics workspace list-deleted-workspaces
#   if listed: az monitor log-analytics workspace delete --resource-group <rg> --workspace-name <name> --force true --yes
```

The `az monitor log-analytics workspace delete --force` form needs the resource group to exist; if the group is already
gone, note the workspace and let its recovery window expire, or recreate the group with the same name to purge it.

Verify (pending execution):

```bash
# pending execution — post-demo, owner
az group exists --name rg-<slug>-ai-demo                                   # looking for: false
az ad app list --display-name regulait-ai-discovery-demo --query "[].appId" # looking for: empty
az ad sp list --display-name regulait-ai-discovery-demo --query "[].id"    # looking for: empty
az role assignment list --assignee <client-id> --all                       # looking for: empty, or an error that the principal does not exist
az role definition list --custom-role-only true --scope /subscriptions/<subscription-id> \
  --query "[?contains(roleName,'activity log reader')].roleName"          # looking for: empty
az consumption budget list --query "[].name"                               # looking for: no demo budget
```

Then, in the portal, check **Cost Management** for the subscription a few days later: no further charges from the
demo resource group.

Subscription closure is a decision, not a step here (T11).

## T6. AWS workload: trust first (pending execution — post-demo, owner)

Reverses DEMO_REAL_ACCOUNTS step 4, except the trail.

The setup teardown closes the account rather than destroying the workload stack, because the baseline "deny disable
guardrails" SCP denies `cloudtrail:DeleteTrail` inside the account (setup step 3). Closing the account alone leaves the
discovery role's trust and its OIDC provider in place inside a suspended account for 90 days, and an account reopened
within that window comes back with them. So remove the trust and stop the generators first, with a targeted destroy
that leaves the trail (`module.trail`) alone:

```bash
# pending execution — post-demo, owner, in infra/environments/demo-sandbox/aws
aws sso login --profile <management-sso-profile-name>
terraform init -backend-config=backend.hcl
terraform plan -destroy -out=trust.tfplan \
  -target=module.discovery_role \
  -target=module.generator_support \
  -target=module.generator_invoices \
  -target=aws_bedrock_guardrail.planted
terraform apply trust.tfplan
```

Read the plan before applying: it must list the OIDC provider, the role `regulait-ai-discovery` and its inline policy,
both generator Lambdas with their roles, log groups and schedules, and the guardrail, and nothing from `module.trail`.
If the plan includes any trail resource, stop: do not apply it. Terraform warns that `-target` is for exceptional
cases; this is one, and the account closure in T7 removes the rest.

This targeted destroy is an addition to the setup runbook's teardown, which goes straight to closure. It needs the
owner's agreement (T11 item 8); without it, skip T6 and rely on T7.

Verify (pending execution), with a session in the sandbox account:

```bash
# pending execution — post-demo, owner
aws iam get-role --role-name regulait-ai-discovery            # looking for: NoSuchEntity
aws iam list-open-id-connect-providers                         # looking for: no provider for <demo-host>/federation
aws scheduler list-schedules --region us-east-1                # looking for: no generator schedules
aws lambda list-functions --region us-east-1 --query "Functions[].FunctionName"   # looking for: no generators
aws bedrock list-guardrails --region us-east-1                 # looking for: no planted guardrail
```

## T7. AWS account: budget, spend cap, closure (pending execution — post-demo, owner)

Reverses DEMO_REAL_ACCOUNTS step 3 (and owner actions 1 and 4).

```bash
# pending execution — post-demo, owner, in infra/environments/demo-sandbox/account
aws sso login --profile <management-sso-profile-name>
terraform init -backend-config=backend.hcl
terraform plan -destroy -out=destroy.tfplan
terraform apply destroy.tfplan
```

The plan must list the member account (closed because `close_on_deletion = true`), the budget
`regulait-demo-sandbox-total` with its 80% and forecast alerts, the budget action, its role
`regulait-demo-sandbox-budget-action` and policy, and the SCP `regulait-demo-sandbox-spend-cap`. If the budget action
attached the SCP (spend reached 100%), that attachment was made by AWS Budgets, not by Terraform, so it is not in the
plan. Check before applying, and detach it if it is attached (pending execution):

```bash
# pending execution — post-demo, owner
aws organizations list-targets-for-policy --policy-id <spend-cap policy id>
#   if the sandbox account is listed:
aws organizations detach-policy --policy-id <spend-cap policy id> --target-id <sandbox-account-id>
```

Closure facts from setup step 3 and the module: the account stays suspended for 90 days, counts against the
Organization's close-account quota, and stops billing for what is inside it. After the closure, delete the workload
stack's state object (`demo-sandbox/aws`) from the state bucket; its remaining resources (the trail and its bucket)
go with the account.

Verify (pending execution), from the management account:

```bash
# pending execution — post-demo, owner
aws organizations describe-account --account-id <sandbox-account-id> \
  --query "Account.[Status,State]"                       # looking for: a closing or closed state, not ACTIVE
aws budgets describe-budgets --account-id <management-account-id> \
  --query "Budgets[].BudgetName"                         # looking for: no regulait-demo-sandbox-total
aws organizations list-policies --filter SERVICE_CONTROL_POLICY \
  --query "Policies[].Name"                              # looking for: no regulait-demo-sandbox-spend-cap
aws iam get-role --role-name regulait-demo-sandbox-budget-action   # looking for: NoSuchEntity
```

Billing: check Cost Explorer for the sandbox account a few days later, filtered to it: no new charges after the
closure date.

## T8. Dev instance (pending execution — post-demo, owner)

Reverses DEMO_REAL_ACCOUNTS owner action 5, step 1a and step 1b.

1. Set `power_schedule_enabled` back to `true` in `infra/environments/regulait-dev-app`, then plan and apply there
   (owner approval, as for every apply).
2. `REGULAIT_PUBLIC_URL` (step 1b) stays by default: new instances already write it from user data, and passkeys,
   step-up, SAML and Keycloak now use it as their origin, so removing it changes more than federation. Removing it is a
   decision (T11), and step 1b's rollback (delete the line, `docker compose --profile tls up -d`) is the way to do it.

## T9. Local files and state (pending execution — post-demo, owner)

Reverses the local files of DEMO_REAL_ACCOUNTS steps 3-6.

1. After each destroy succeeds, delete that stack's local `terraform.tfvars` (it holds the root email, tenant,
   subscription, source ids and alert recipients), `backend.hcl`, any `*.tfplan`, and `.terraform/`. All are
   git-ignored; check `git status` shows none of them as tracked.
2. Delete the four stacks' state objects from the state bucket once each stack is empty (the `aws` one after T7). The
   GitLab state held the scanner token until its destroy (setup step 6.4); if the bucket keeps object versions, delete
   that state object's earlier versions too, since they still hold the token in plaintext.
3. Clipboard: setup step 6.4 copied the scanner token to the clipboard; it is revoked in T4, so no further action is
   needed beyond the revocation.

## T10. Verification sweep (pending execution — post-demo, owner)

| Item | Created in (setup section) | Removed in | Check |
|---|---|---|---|
| Four discovery sources enabled, three credentials (GitLab token encrypted) | DEMO_REAL_ACCOUNTS steps 2 and 7; DEMO_RUNBOOK §7.2 | T1 | sources disabled, no credentials |
| Endpoint enrolment token and enrolled device | DEMO_RUNBOOK §7.2 (`endpoint_agent` row) | T1 | token and devices revoked; agent uninstalled |
| Egress allow-list entries (AWS, Azure, GitLab hosts) | DEMO_REAL_ACCOUNTS step 7 | T2 | entries gone |
| Federation on, signing key | DEMO_REAL_ACCOUNTS step 1c | T3 | federation off; issuer documents no longer served |
| Personal access token (`api`, setup only) | DEMO_REAL_ACCOUNTS step 6.2 | revoked at setup 6.5; checked in T4 | not active |
| Group access token `regulait-ai-discovery-read-only` (`read_api`, `read_repository`) | DEMO_REAL_ACCOUNTS step 6.3 | T4 (destroy) | not active |
| Four seeded GitLab projects | DEMO_REAL_ACCOUNTS step 6.3 | T4 (destroy) | gone |
| GitLab demo group | DEMO_REAL_ACCOUNTS owner action 3, step 6.1 | T4 (UI) | gone or pending deletion |
| Fallback demo GitLab account and its token | DEMO_REAL_ACCOUNTS step 6, fallback | T4 item 4 | token revoked, account deleted |
| Entra app registration, service principal, federated credential | DEMO_REAL_ACCOUNTS step 5 | T5 | not listed; not in deleted items |
| Reader on the resource group; custom activity-log role and its assignment | DEMO_REAL_ACCOUNTS step 5 | T5 | no assignments; no custom role |
| AI services account and its deployment | DEMO_REAL_ACCOUNTS step 5 | T5 | not listed; not in deleted accounts |
| Logic App generator and its managed-identity role assignment | DEMO_REAL_ACCOUNTS step 5 | T5 | resource group gone |
| Log Analytics workspace and diagnostic setting | DEMO_REAL_ACCOUNTS step 5 | T5 | not listed; not in deleted workspaces |
| Azure budget (USD 10, alert at 80%) | DEMO_REAL_ACCOUNTS step 5 | T5 | not listed |
| AWS OIDC provider and role `regulait-ai-discovery` | DEMO_REAL_ACCOUNTS step 4 | T6 (or T7 by closure) | not found |
| Two Bedrock generators (Lambdas, roles, schedules, log groups) | DEMO_REAL_ACCOUNTS step 4 | T6 (or T7 by closure) | not found |
| Bedrock guardrail | DEMO_REAL_ACCOUNTS step 4 | T6 (or T7 by closure) | not found |
| CloudTrail trail and its bucket | DEMO_REAL_ACCOUNTS step 4 | T7 (account closure) | account closed |
| AWS budget (USD 40), budget action, its role, spend-cap SCP | DEMO_REAL_ACCOUNTS step 3 | T7 | not found |
| Sandbox member account | DEMO_REAL_ACCOUNTS step 3 | T7 | closing or closed |
| Power schedule off; `REGULAIT_PUBLIC_URL` on the box | DEMO_REAL_ACCOUNTS owner action 5, steps 1a, 1b | T8 | schedule on; URL kept or removed by decision |
| Local tfvars, backend files, plans; state objects (GitLab state held the token) | DEMO_REAL_ACCOUNTS steps 3-6 | T9 | deleted, older versions included |

## T11. Closure decisions and records (pending execution — post-demo, owner)

These are the owner's decisions; this page does not make them.

1. **AWS account.** T7 closes it. ADR-0197 decision 2 amended ADR-0002 and ADR-0004 from two accounts to three; after
   the closure, record it as an As-built addendum to ADR-0197 and update `STATE.md` (the Organization is back to two
   active accounts).
2. **Azure subscription.** DEMO_REAL_ACCOUNTS uses an existing subscription and tenant. If the subscription was created
   only for the demo, decide whether to cancel it after T5; if not, it stays.
3. **GitLab plan.** If the group was upgraded to Premium or Ultimate only for the group token, cancel or downgrade.
4. **AWS budget owner action.** ADR-0197 lists "raise the AWS budget from USD 5/month for the sandbox". If an existing
   budget outside the account stack was raised, decide whether to set it back.
5. **The discovery sources in RegulAIt.** Keep them disabled (default, T1) or delete them.
6. **`REGULAIT_PUBLIC_URL` on the dev box** (T8).
7. **The screen recording** of a real scan (ADR-0197 decision 7, DEMO_RUNBOOK §7.1) on the presenting laptop: keep or
   delete. It shows pseudonymised data and fictional names only (decision 8).
8. **The targeted trust removal of T6**, since it adds to the setup runbook's teardown.

When teardown is done, record what was run, by whom and when under DEMO_REAL_ACCOUNTS "What has been run", and mark
the "After" row of DEMO_RUNBOOK §7.3 done.

## Gaps: ADR-0197 owner actions with no runbook step

Checked on 2026-10-21 against ADR-0197's owner-action list, DEMO_REAL_ACCOUNTS.md and DEMO_RUNBOOK §7:

| Owner action (ADR-0197) | Runbook step | Gap |
|---|---|---|
| Approve the Terraform applies | DEMO_REAL_ACCOUNTS steps 3-6; teardown T4-T7 | none |
| Create or approve the gitlab.com demo group and its token | DEMO_REAL_ACCOUNTS owner action 3, step 6; teardown T4 | none |
| Grant the Azure tenant access the apply needs | DEMO_REAL_ACCOUNTS owner action 2 (prerequisite only) | no check that the access is in place before step 5; the apply's own errors are the first signal |
| Protect the `release` environment (Q4) | none. Only a comment in `.github/workflows/engine-images.yml` says the owner protects it | no step, and no record in the repository of whether it is done |
| Raise the AWS budget from USD 5/month for the sandbox | DEMO_REAL_ACCOUNTS step 3 creates a separate USD 40 sandbox budget | no step says whether an existing USD 5/month budget is raised, left, or superseded by the sandbox budget; teardown T11 item 4 asks the same question in reverse |
| Decision 10: after the demo, a separate agent identity without merge rights | none | no runbook |
| Decision 7: a screen recording of a real scan | DEMO_RUNBOOK §7.3 (T-24h row) | a checklist row only; no capture procedure |
