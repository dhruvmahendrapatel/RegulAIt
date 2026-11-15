# One-time setup: the BYOC rehearsal role in regulait-dev

- **Who does this**: the owner, once, from their own computer. No builder session or CI job applies it.
- **Decision**: [ADR-0325](../../internal/decisions/0325-byoc-aws-pilot-and-rehearsal.md)
- **Time**: about 20 minutes.
- **What it creates** (in regulait-dev only, every resource tagged `purpose=rehearsal`):
  - the GitHub OIDC identity provider (skipped if the account already has one),
  - one IAM role, `gh-actions-regulait-rehearsal`, which only a GitHub Actions job running in this repository's
    `rehearsal` environment can use,
  - one permissions boundary, `regulait-rehearsal-byoc-boundary`, which limits that role and every role it creates.
- **What it does not do**: it creates no network, server or database, and it costs nothing to keep. It never
  touches the management account or any other account.

## What the role can and cannot do

It can build and destroy the BYOC test stack in one region: network, Kubernetes (EKS), Postgres (RDS), encryption
keys, the audit bucket, the egress firewall, a private container registry, and calls to Bedrock. IAM roles,
IAM policies, S3 buckets and registry repositories must be named
`regulait-rehearsal-…`; the network, cluster, database, key and firewall must carry the tag `purpose=rehearsal` to be
created or deleted.

It cannot create users or access keys, remove its own limits, change its own role, act outside the chosen region,
change Organizations, SSO or billing, or touch anything tagged as production.

## Before you start

You need:

1. The AWS CLI v2 and Terraform 1.9 or later on your computer.
2. Your normal Identity Center sign-in to the **regulait-dev** account with the Deploy-Builder permission set, and the
   management-account profile you already use for Terraform state.
3. Admin access to the GitHub repository's settings.

## Step 1: create the GitHub environment (5 minutes)

In the repository on GitHub: **Settings → Environments → New environment**.

1. Name it exactly `rehearsal`.
2. Tick **Required reviewers** and add yourself. Every rehearsal run then waits for your approval before it can reach
   AWS.
3. Tick **Prevent self-review** if anyone else can start workflows.
4. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main` and `builder/*`.
5. Save. Leave the page open; you come back in step 4.

## Step 2: sign in to AWS (2 minutes)

```bash
aws sso login --profile <your-regulait-dev-profile>
aws sts get-caller-identity --profile <your-regulait-dev-profile>
```

Check that the account number shown is regulait-dev. If it is any other account, stop.

Check whether the account already has the GitHub provider:

```bash
aws iam list-open-id-connect-providers --profile <your-regulait-dev-profile>
```

If the list contains `token.actions.githubusercontent.com`, note its ARN for step 3.

## Step 3: apply (10 minutes)

```bash
cd infra/environments/regulait-dev-rehearsal-role
cp terraform.tfvars.example terraform.tfvars      # git-ignored; fill in the five values
cp backend.hcl.example backend.hcl                # same values as your other environments, this key
terraform init -backend-config=backend.hcl
terraform plan -out rehearsal-role.plan
```

Read the plan. It should **add 3 or 4 resources** (provider if new, boundary policy, role, inline policy) and change
or destroy nothing. If it shows anything else, stop and ask.

```bash
terraform apply rehearsal-role.plan
terraform output rehearsal_role_arn
```

Terraform refuses to run if your profile points at any account other than the `workload_account_id` you entered.

## Step 4: give the role to the environment (2 minutes)

Back in **Settings → Environments → rehearsal**, under **Environment variables**, add:

| Name | Value |
|---|---|
| `REHEARSAL_ROLE_ARN` | the `rehearsal_role_arn` output |
| `REHEARSAL_AWS_REGION` | the region you chose |

These are variables, not secrets: the role ARN alone gives nothing to anyone who is not a job in this environment.
Do not commit them; the repository is public.

## Step 5: tell the lane

Reply on the PR: "rehearsal role applied". The builder then runs the `byoc-rehearsal` workflow; each run waits for
your approval in step 1's environment.

## Changing or removing it

- **A rehearsal hits `AccessDenied`**: the builder changes `infra/modules/aws-byoc-deployer-policy` in a PR. After it
  merges, repeat step 3 (`plan`, check, `apply`).
- **Remove everything**: `terraform destroy` in the same folder, then delete the `rehearsal` environment on GitHub.
  First check that no rehearsal stack is left: `aws resourcegroupstaggingapi get-resources --tag-filters
  Key=purpose,Values=rehearsal --profile <your-regulait-dev-profile>` should list only the boundary, role and provider.
