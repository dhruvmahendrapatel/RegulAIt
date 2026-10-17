# Cloud AI discovery: permissions you grant (AWS, GCP, Azure)

ADR-0195 slice SD2. RegulAIt can list the AI services in your AWS accounts, GCP projects and Azure subscriptions and
read their audit logs, to find AI use that is not governed yet. This page lists the read-only permissions each
scanner needs and gives Terraform you apply in your own account. **RegulAIt never creates IAM in your account**
(ADR-0195 decision 17); you decide what it can read.

> **Status: pending real-cloud execution (M-041).** The scanners are tested against the real cloud SDKs with a fake
> network, not against a live AWS, GCP or Azure account. The Terraform files in
> [`cloud-discovery/`](cloud-discovery/) have not been run through `terraform validate` or applied. The federation
> token itself (RegulAIt's ADR-0188 issuer minting an RS256 token for these audiences) is not built yet: a source
> with a federated credential fails its run with that reason, and only the static-credential relaxation runs end
> to end.
>
> Source fields (one `key=value` per line on the Discovery sources page): AWS target `accountId`, optional
> `stsRegion`, `trailBucket`, `trailBucketRegion`, `trailPrefix`; scope = regions. GCP target `projectId` or
> `assetScope`; scope = projects. Azure target `tenantId`, optional `managementGroupId`, `logAnalyticsWorkspaceIds`
> (comma-separated); scope = subscriptions; credential public config `clientId`. Static secrets: AWS a JSON object
> `{"accessKeyId": ..., "secretAccessKey": ...}`, GCP the key file JSON, Azure the client secret. Treat every step below as pending execution.

## What every scanner does and does not do

- **Read only.** No scanner writes to, changes or deletes anything. The permission sets below contain only `List`,
  `Get`, `Describe`, `Lookup`, `Search` and `read` actions. None can read a model's input or output, a prompt, an API
  key or a secret. On Azure, `listKeys` is deliberately absent.
- **Off until enabled.** A source is enabled by an admin with a step-up; widening its scope is the same step-up.
- **Egress allow list.** Every call goes through RegulAIt's egress guard. No cloud host is pre-allowed: when you
  enable a source, an admin adds that cloud's API hosts (each addition is a step-up). A host that is not allowed is
  reported as `unreachable`, never as "found nothing".
- **Honest reporting.** Each run lists every read it attempted and whether it worked: `read`, `denied` (a
  permission below is missing), `not_enabled` (the data source is off in your account), `unreachable`, `skipped`
  or `error`.
- **People are pseudonymous.** Calling principals (roles, service accounts, users) are shown as a keyed hash; the
  name is stored encrypted and revealing it is a step-up (ADR-0195 rule 20).

## Credentials

Federated, short-lived credentials are the default. RegulAIt presents an OIDC token from its own workload identity
issuer (ADR-0188) to your cloud's token exchange, so RegulAIt holds no long-lived key:

| Cloud | Federated (default) | Static (admin relaxation, step-up) |
|---|---|---|
| AWS | `AssumeRoleWithWebIdentity` into your role (token audience `sts.amazonaws.com`), or `AssumeRole` with an external id RegulAIt generates per source where RegulAIt already runs as an AWS principal | access key |
| GCP | workload identity federation (STS token exchange), optionally impersonating a service account | service-account key file |
| Azure | federated credential on an app registration (audience `api://AzureADTokenExchange`) | client secret |

Every federation token RegulAIt mints for a source has the subject `regulait:discovery-source:<source id>`. Bind your
trust policy to that exact subject so a token for one source cannot be used for another.

Federation tokens are signed with RS256, the one algorithm all three clouds accept (Entra supports only RS256).
Your cloud must be able to reach RegulAIt's issuer discovery document and keys (AWS and Azure fetch them over the
internet; GCP can also take an uploaded key set of up to 8 keys). An air-gapped install has no reachable issuer: use the static
relaxation through your private endpoints, or leave cloud discovery off (ADR-0195 decision 10).

Instance-metadata credentials (the AWS default chain, Azure managed identity, the GCP metadata server) are not
supported: the egress guard refuses the metadata address unconditionally, and a source must always say which
principal it runs as.

## AWS

**Hosts to allow-list** (per enabled region `<r>`): `sts.<sts region>.amazonaws.com`, `account.us-east-1.amazonaws.com`,
`bedrock.<r>.amazonaws.com`, `bedrock-agent.<r>.amazonaws.com`, `api.sagemaker.<r>.amazonaws.com`,
`cloudtrail.<r>.amazonaws.com`, and for the optional trail bucket `<bucket>.s3.<bucket region>.amazonaws.com`.

| Permission | Why |
|---|---|
| `account:ListRegions` | enumerate enabled regions |
| `bedrock:ListCustomModels`, `bedrock:ListImportedModels`, `bedrock:ListProvisionedModelThroughputs`, `bedrock:ListGuardrails`, `bedrock:GetModelInvocationLoggingConfiguration` | Bedrock inventory and whether invocation logging is on |
| `bedrock:ListAgents`, `bedrock:ListKnowledgeBases` | Bedrock agents and knowledge bases |
| `sagemaker:ListEndpoints`, `sagemaker:ListModels` | SageMaker inventory |
| `cloudtrail:LookupEvents` | `InvokeModel`, `InvokeModelWithResponseStream`, `Converse`, `ConverseStream` calls, grouped by caller |
| optional: `s3:ListBucket` and `s3:GetObject` on `AWSLogs/<account>/CloudTrail/*` of your trail bucket (and `kms:Decrypt` if the trail is KMS-encrypted) | agent and knowledge-base calls (`InvokeAgent`, `Retrieve`, `RetrieveAndGenerate`) are data events, which `LookupEvents` never returns |

Limits you should know: `LookupEvents` returns management events only, and at most the last 90 days. Data events
appear only if your trail has data-event selectors for Bedrock and you grant the bucket read above; otherwise the
scan reports `not_enabled` for them. Terraform: [`cloud-discovery/aws.tf`](cloud-discovery/aws.tf).

## GCP

**Hosts to allow-list:** `sts.googleapis.com`, `iamcredentials.googleapis.com` (only with impersonation),
`serviceusage.googleapis.com`, `cloudasset.googleapis.com`, `cloudresourcemanager.googleapis.com`,
`logging.googleapis.com`.

| Permission | Why |
|---|---|
| `serviceusage.services.get` | is `aiplatform.googleapis.com` or `generativelanguage.googleapis.com` enabled |
| `cloudasset.assets.searchAllResources` | Vertex AI endpoints, models and index endpoints (grant at organization or folder level for an organisation-wide scope) |
| `resourcemanager.projects.getIamPolicy` | read the project's audit configuration only, to say whether Data Access logs are on |
| `logging.logEntries.list` | Admin Activity audit logs for both services |
| optional: `logging.privateLogEntries.list` | Data Access audit logs, where Vertex prediction calls appear |

Data Access audit logs are off by default. When they are off the scan says so ("not enabled") instead of reporting
zero predictions. Terraform: [`cloud-discovery/gcp.tf`](cloud-discovery/gcp.tf).

## Azure

**Hosts to allow-list:** `login.microsoftonline.com` (or your sovereign cloud's authority host),
`management.azure.com`, and `api.loganalytics.io` only if you give it a Log Analytics workspace.

| Permission | Why |
|---|---|
| `Microsoft.CognitiveServices/accounts/read` | Cognitive Services accounts of kind `OpenAI` and `AIServices` (via Resource Graph) |
| `Microsoft.CognitiveServices/accounts/deployments/read` | their deployments |
| `Microsoft.MachineLearningServices/workspaces/read` | Azure Machine Learning and AI Foundry hub and project workspaces |
| `Microsoft.Insights/eventtypes/values/read` | the activity log, grouped by caller |
| optional: `Microsoft.OperationalInsights/workspaces/read`, `Microsoft.OperationalInsights/workspaces/query/read` on a workspace | Cognitive Services diagnostic logs, only if you route them to that workspace (counts per resource and operation; never content) |

Resource Graph returns only resources the principal can read, so the role's read actions are what scope it.
Terraform: [`cloud-discovery/azure.tf`](cloud-discovery/azure.tf).
