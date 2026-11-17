# One-time setup: the BYOC rehearsal role in regulait-dev

- **Who does this**: the owner, once, from their own computer. No builder session or CI job applies it.
- **Decision**: [ADR-0325](../../internal/decisions/0325-byoc-aws-pilot-and-rehearsal.md)
- **Time**: about 20 minutes.
- **What it creates** (in regulait-dev only, every resource tagged `purpose=rehearsal`):
  - the GitHub OIDC identity provider (skipped if the account already has one),
  - one IAM role, `gh-actions-regulait-rehearsal`, which only a GitHub Actions job running in this repository's
    `rehearsal` environment can use,
  - two permissions boundaries: `regulait-rehearsal-byoc-boundary` limits that role, and
    `regulait-rehearsal-byoc-workload-boundary` limits every role it creates.
- **What it does not do**: it creates no network, server or database, and it costs nothing to keep. It never
  touches the management account or any other account.

## What the role can and cannot do

It can build and destroy the BYOC test stack in one region:

- network;
- Kubernetes (EKS);
- Postgres (RDS);
- encryption keys;
- the audit bucket;
- the egress firewall;
- a private container registry;
- calls to Bedrock.

**Limited by name** (`regulait-rehearsal-…`): IAM roles, policies and instance profiles, RDS, Secrets Manager
secrets, CloudWatch log groups, EKS clusters, Network Firewall, S3 buckets and registry repositories. It cannot
read, change or delete any of these that do not carry the name. That includes another stack's secrets, databases
and log groups.

**Limited by tag** (`purpose=rehearsal`): KMS keys, and EC2 instances, volumes, snapshots, routes, subnets, VPCs,
gateways and endpoints. Security groups are limited the same way for the role itself. It cannot add that tag to
something that does not already have it.

**Every create must carry the tag**, and that includes IAM roles. The clean-up check after each rehearsal therefore
finds anything left behind.

**Roles it creates are weaker than it is.** They carry the workload boundary, under which:

- no IAM change is possible at all;
- they cannot touch Secrets Manager, RDS or Network Firewall;
- they get nothing in an OIDC (web-identity) session. A role left behind with a GitHub trust is useless, so it cannot
  be used to skip the reviewers.

**It cannot:**

- create IAM users or access keys;
- edit any role's trust policy;
- remove or change either boundary;
- change its own role;
- act outside the chosen region;
- change Organizations, SSO or billing;
- touch anything tagged as production (`environment` or `env` containing "prod").

**What IAM cannot express**, and how it is covered:

- **Trust policy content.** Nothing can check what a new role trusts. The controls are:
  - roles only under the prefix and only tagged;
  - no trust edits;
  - the workload boundary;
  - CloudTrail, which records every `CreateRole` with its trust.
- **Security groups and network interfaces made by EKS and the load balancer controller.** They are untagged, so the
  workload boundary leaves them to those services (ADR-0325).

## Before you start

You need:

1. The AWS CLI v2 and Terraform 1.11 or later on your computer (the repository pins 1.16.7).
2. Your normal Identity Center sign-in to the **regulait-dev** account with the Deploy-Builder permission set, and the
   management-account profile you already use for Terraform state.
3. Admin access to the GitHub repository's settings.

## Step 1: create the GitHub environment (5 minutes)

In the repository on GitHub: **Settings → Environments → New environment**.

1. Name it exactly `rehearsal`.
2. Tick **Required reviewers** and add yourself. Every rehearsal run then waits for your approval before it can reach
   AWS.
3. **Prevent self-review.** Tick it whenever a second person can approve. With it on, the person who starts a run
   cannot approve it.
   - The lane's sessions start runs under your GitHub account. Ticking it while you are the only reviewer would block
     every run.
   - While you are the only reviewer, required reviewers is the gate: you approve each run yourself, after reading what
     it will apply. Add a second reviewer and tick this box as soon as you can.
4. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main` and `builder/*`.
5. Save. Leave the page open; you come back in step 4.

### Step 1b (recommended): pin the repository by its ID

By default the role trusts the repository's owner and name. To make it trust the repository's numeric ID instead, so
that a renamed, transferred or re-created repository cannot inherit the trust:

```bash
gh api repos/<owner>/<repo> --jq .id                       # note the number
gh api -X PUT repos/<owner>/<repo>/actions/oidc/customization/sub \
  -F use_default=false -f 'include_claim_keys[]=repository_id' -f 'include_claim_keys[]=environment'
```

Then set `github_repository_id = <the number>` in step 3's `terraform.tfvars`. Do both or neither: if only one is
done, the role cannot be assumed.

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

### Step 2b: give the account its alias (once, 1 minute)

The `byoc-rehearsal` workflow refuses any account whose IAM account alias is not exactly `regulait-dev`
(`EXPECTED_ACCOUNT_ALIAS` in `.github/workflows/byoc-rehearsal.yml`). The role ARN it is given proves nothing on its
own, because a role with the same name could exist in another account. Check the alias:

```bash
aws iam list-account-aliases --profile <your-regulait-dev-profile>
```

If the list is empty, set it:

```bash
aws iam create-account-alias --account-alias regulait-dev --profile <your-regulait-dev-profile>
```

Aliases are unique across all of AWS. If `regulait-dev` is taken, choose another name. Change
`EXPECTED_ACCOUNT_ALIAS` to match in a reviewed PR before the first run. Never give another account this alias.

## Step 3: apply (10 minutes)

```bash
cd infra/environments/regulait-dev-rehearsal-role
cp terraform.tfvars.example terraform.tfvars      # git-ignored; fill in the five values
cp backend.hcl.example backend.hcl                # same values as your other environments, this key
terraform init -backend-config=backend.hcl
terraform plan -out rehearsal-role.plan
```

Read the plan:

- It should **add 4 or 5 resources**: the provider (if new), the two boundary policies, the role and its inline
  policy. It should change or destroy nothing.
- In the role's `assume_role_policy`, check that the `sub` is exactly
  `repo:<owner>/<repo>:environment:rehearsal`, or `repository_id:<id>:environment:rehearsal` with step 1b, and that
  the `aud` is `sts.amazonaws.com`.

If it shows anything else, stop and ask.

```bash
terraform show -no-color rehearsal-role.plan > rehearsal-role-plan.txt
terraform apply -no-color rehearsal-role.plan | tee rehearsal-role-apply.txt
terraform output rehearsal_role_arn
```

**Keep the record.** In both text files, replace the 12-digit account number with `<account>`. Then attach both to
the PR (or the ceremony record) with the date and your name. That is the log of this apply. Every later rehearsal
writes its own record to its run summary.

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
