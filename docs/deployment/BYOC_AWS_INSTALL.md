# Installing RegulAIt in your own AWS account (BYOC)

- **Who this is for**: your cloud or platform team. You do not need to know RegulAIt; you need to be comfortable
  running commands in a terminal and signing in to AWS.
- **Time**: under a day. About 2 hours of hands-on work, plus roughly 45 minutes of waiting while AWS builds things.
- **Where your data goes**: nowhere but your account. See [What stays in your account](#what-stays-in-your-account).
- **Decision record**: [ADR-0325](../../internal/decisions/0325-byoc-aws-pilot-and-rehearsal.md). The Terraform is in
  [`infra/environments/byoc-aws`](../../infra/environments/byoc-aws) and
  [`infra/modules/byoc-aws`](../../infra/modules/byoc-aws).

| Step | What | Hands-on | Waiting |
|---|---|---|---|
| 1 | [Prerequisites](#1-prerequisites) | 30 min | - |
| 2 | [Quotas and Bedrock model access](#2-quotas-and-bedrock-model-access) | 10 min | up to a day for a quota increase (ask early) |
| 3 | [Get and verify the release](#3-get-and-verify-the-release) | 15 min | - |
| 4 | [Preflight](#4-preflight) | 5 min | - |
| 5 | [Build the AWS side (one command)](#5-build-the-aws-side-one-command) | 5 min | ~40 min |
| 6 | [Install RegulAIt on the cluster](#6-install-regulait-on-the-cluster) | 30 min | ~5 min |
| 7 | [Sign-in with Microsoft Entra ID](#7-sign-in-with-microsoft-entra-id) | 20 min | - |
| 8 | [Smoke test](#8-smoke-test) | 5 min | ~5 min |

Keep a terminal open in the repository's root for every step. Commands that need values from you show them as
`<like-this>`.

---

## 1. Prerequisites

**People and access**

- An AWS account for RegulAIt (a new, empty account is best). Sign in with an IAM Identity Center (SSO) role that can
  create networks, EKS, RDS, KMS, S3 and IAM roles. To limit that role to exactly what this install needs, attach
  [`infra/modules/aws-byoc-deployer-policy`](../../infra/modules/aws-byoc-deployer-policy) to it. It refuses
  everything else and makes every role the install creates carry the same limit.
- Someone who can register an application in your **Microsoft Entra ID** tenant (step 7).
- A **hostname** for RegulAIt, for example `regulait.your-company.example`, with a TLS certificate for it in **AWS
  Certificate Manager** in the same region. Users reach RegulAIt over your internal network (VPN or Direct Connect),
  so an internal DNS name works.

**Tools on the machine you install from**

| Tool | Version | Check with |
|---|---|---|
| AWS CLI | 2.x | `aws --version` |
| Terraform | 1.11.1 or later (we test 1.16.7) | `terraform version` |
| kubectl | within one minor version of the cluster (1.34) | `kubectl version --client` |
| Helm | 3.x | `helm version` |
| jq | any | `jq --version` |

**Sign in**

```bash
aws sso login --profile <your-profile>
export AWS_PROFILE=<your-profile> AWS_REGION=<region>
aws sts get-caller-identity          # check this is the account you mean
```

**Fill in your settings**

```bash
cd infra/environments/byoc-aws
cp customer.tfvars.example customer.tfvars
```

Open `customer.tfvars` and fill in each `<...>`. Everything you leave out takes its secure default. The settings
you must think about:

- `cluster_admin_principal_arns`: your SSO admin role ARNs. They get admin rights on the Kubernetes cluster.
- `cluster_endpoint_public_access_cidrs`: leave this empty for a private Kubernetes API. Then you run steps 6 and 8
  from a machine inside the VPC or on your VPN. Or list your VPN's public egress CIDRs. `0.0.0.0/0` is refused.
- `egress_allowed_domains`: the only internet hosts RegulAIt may reach. The default is Entra ID sign-in. Add your
  PM tool and Git host, for example `dev.azure.com`, `.atlassian.net` and `github.com`.
- `ingress_hostname`, `ingress_certificate_arn`, `ingress_allowed_cidrs`: where users reach RegulAIt.
- `bedrock_model_ids`: the models RegulAIt may call (step 2).

## 2. Quotas and Bedrock model access

In the AWS console, go to **Amazon Bedrock → Model access** and request access to the models you listed. Access to
most models is granted within minutes.

The install needs, in the region:

- 1 VPC;
- 2 Elastic IPs;
- 1 EKS cluster;
- 1 RDS instance;
- 6 or more On-Demand Standard vCPUs.

Step 4 checks these quotas. If one is short, request an increase in **Service Quotas** now, because some take a day.

## 3. Get and verify the release

RegulAIt ships as a signed update bundle. Verify it before you use anything in it:

```bash
./scripts/verify-update-bundle.sh regulait-update-<version>.tar.gz
```

It must print a pass for the signature and for every file ([UPGRADE.md](UPGRADE.md) explains each check). Note the
gateway and operator image digests in the bundle's `manifest.json`. You push the images into your own registry in
step 6, so your cluster never pulls from outside your account.

## 4. Preflight

```bash
../../modules/byoc-aws/preflight/preflight.sh --account <account-id> --region <region> \
  --model <model-id>          # repeat --model for each model
```

Every line should say `PASS`. A `FAIL` tells you what to fix. The preflight only reads and changes nothing, so run it
as often as you like.

## 5. Build the AWS side (one command)

```bash
terraform init
terraform apply -var-file=customer.tfvars
```

Terraform shows what it will create, about 150 resources, and asks you to type `yes`. It then takes about 40 minutes.
Most of that is EKS and RDS. If it stops on an error, fix the cause and run the same command again. It picks up
where it left off.

When it finishes:

```bash
terraform output data_boundary        # read this: it is what you are agreeing to
$(terraform output -raw kubeconfig_command)
kubectl get nodes                     # two nodes, STATUS Ready
```

**Keep Terraform's state safe.** By default it is in `terraform.tfstate` in this folder. It holds no passwords,
because RDS keeps the database password in Secrets Manager. You still need the file to change or remove the install.
To keep state in your own S3 bucket, see `backend.tf.example`.

## 6. Install RegulAIt on the cluster

**6.1 Push the images into your registry** (from the verified bundle):

```bash
REG=$(terraform output -json ecr_repository_urls | jq -r .gateway | cut -d/ -f1)
aws ecr get-login-password | docker login --username AWS --password-stdin "$REG"
docker load -i <bundle>/images/gateway.tar
docker tag <loaded-image> "$(terraform output -json ecr_repository_urls | jq -r .gateway):<version>"
docker push "$(terraform output -json ecr_repository_urls | jq -r .gateway):<version>"
```

The digest that `docker push` prints must equal the one in the bundle's `manifest.json`. Do the same for the
operator image.

Every command in 6.2 to 6.5 is safe to run again: re-running a step after a failure, or the whole section, changes
nothing that is already right and never replaces a key.

**6.2 Storage, load balancer controller, namespace**

```bash
terraform output -raw storage_class_manifest | kubectl apply -f -
kubectl create namespace regulait --dry-run=client -o yaml | kubectl apply -f -

helm repo add eks https://aws.github.io/eks-charts --force-update
terraform output -raw lb_controller_helm_values > lbc-values.yaml
helm upgrade --install aws-load-balancer-controller eks/aws-load-balancer-controller \
  --version 3.6.3 -n kube-system -f lbc-values.yaml
```

**6.3 The secrets** (generated here, never typed into a file in the repository). **This step creates the data key
once and never again.** If the `regulait` Secret already exists, it is kept as it is: a second data key would leave
everything encrypted under the first one unreadable.

```bash
if kubectl -n regulait get secret regulait >/dev/null 2>&1; then
  echo "secret regulait exists: kept, data key unchanged"
  BOOTSTRAP_TOKEN=$(kubectl -n regulait get secret regulait -o jsonpath='{.data.bootstrap-token}' | base64 -d)
else
  DB=$(aws secretsmanager get-secret-value --secret-id "$(terraform output -raw db_master_secret_arn)" \
    --query SecretString --output text)
  DB_URL="postgres://$(jq -r .username <<<"$DB"):$(jq -rn --arg p "$(jq -r .password <<<"$DB")" '$p|@uri')@$(terraform output -raw db_endpoint):5432/regulait?sslmode=verify-full"
  DATA_KEY=$(openssl rand -hex 32)
  BOOTSTRAP_TOKEN=$(openssl rand -hex 32)      # keep this shell open: step 7 uses it once
  kubectl -n regulait create secret generic regulait \
    --from-literal=data-key="$DATA_KEY" \
    --from-literal=database-url="$DB_URL" \
    --from-literal=bootstrap-token="$BOOTSTRAP_TOKEN"
  unset DB DB_URL
  echo "secret regulait created: record DATA_KEY now (below), then unset DATA_KEY"
fi
```

> **Record `DATA_KEY` now** in your password manager or vault, then `unset DATA_KEY`. Every stored credential
> in RegulAIt is encrypted under it, and **if it is lost, those credentials cannot be recovered**
> ([INSTALL.md](INSTALL.md#before-you-start-the-one-thing-that-cannot-be-recovered)). Do not store it next to the
> database backups. To change the database password later, edit only the `database-url` key of the Secret; never
> recreate the Secret.

**6.4 The signed bundle manifest**

```bash
kubectl -n regulait create configmap regulait-bundle-<version> \
  --from-file=<bundle>/manifest.json --from-file=<bundle>/manifest.json.sig \
  --dry-run=client -o yaml | kubectl apply -f -
```

**6.5 Install the chart**

```bash
terraform output -raw helm_values > stack-values.yaml
cat > release-values.yaml <<EOF
version: "<version>"
image:
  repository: "$(terraform output -json ecr_repository_urls | jq -r .gateway)"
  digest: "<gateway digest from manifest.json>"
  allowedRegistries: ["$REG"]
secrets:
  name: regulait
bundle:
  configMapName: regulait-bundle-<version>
operator:
  image:
    repository: "$(terraform output -json ecr_repository_urls | jq -r .operator)"
    digest: "<operator digest from manifest.json>"
EOF
helm upgrade --install regulait deploy/helm/regulait -n regulait -f stack-values.yaml -f release-values.yaml
kubectl -n regulait rollout status deploy/regulait-gateway --timeout=10m
```

The chart runs the database migration first and starts the gateway only if it succeeds.

**6.6 HTTPS for users**

```bash
terraform output -raw ingress_manifest | kubectl -n regulait apply -f -
kubectl -n regulait get ingress regulait     # ADDRESS is the internal load balancer
```

Point your internal DNS name (`ingress_hostname`) at that address with a CNAME.

**6.7 The first admin**

```bash
read -rs PW; printf '%s' "$PW" | kubectl -n regulait exec -i deploy/regulait-gateway -- \
  node apps/gateway/dist/first-admin.js --username admin --email <you@your-company.example>; unset PW
```

Sign in at `https://<ingress_hostname>` with that username and password.

**6.8 Check the app's own egress is strict.** The network already blocks everything except your allow-list. The
gateway also checks each built-in vendor endpoint against its own allow-list, and refuses anything not on it with an
audit row. That check is on by default. Confirm it under **Admin → Settings → Organization → Compiled vendor
endpoints: strict** (ADR-0062, ADR-0180), and add each allow-listed host there or through `/v1/egress/hosts` (step 7
shows the call).

**6.9 Scheduled database dumps to S3** (when you install with the operator, ADR-0305). RDS point-in-time recovery
(below) is on in every install. If you run RegulAIt through the operator (`operator.enabled: true` and a
`RegulaitInstallation`), its nightly `pg_dump` can also go to the backup bucket this stack created:

- the bucket is versioned, encrypted with your stack key and never force-deleted;
- dumps expire after `backup_retention_days` (30);
- the backup Job's role can only add objects under `pg/`. It cannot read, list or delete a backup.

```bash
terraform output -raw backup_spec     # paste under spec.backup in the RegulaitInstallation
```

Add `uploaderImage` (an AWS CLI image, by digest, from your registry) and the `pg_dump` `image` to that block, and
keep `metadata.name` equal to `backup_installation_name` (default `regulait`): the role is bound to the
ServiceAccount `<name>-backup` in the `regulait` namespace and to no other. Then prove a real-size upload once, before
go-live. A dump over 8 MiB is uploaded in parts, which is the path most likely to fail on permissions:

```bash
kubectl -n regulait create job --from=cronjob/regulait-backup backup-check
kubectl -n regulait wait --for=condition=complete job/backup-check --timeout=30m
aws s3api list-object-versions --bucket "$(terraform output -raw backup_bucket)" --prefix pg/ \
  --query 'reverse(sort_by(Versions,&LastModified))[0].[Key,VersionId,Size]'   # admin credentials, not the Job's
```

Then prove that the upload can be read back, with the same admin credentials. Download the key and version printed
above and check it as in **6.9.1** step 3:

```bash
aws s3api get-object --bucket "$(terraform output -raw backup_bucket)" --key <Key> --version-id <VersionId> check.dump
pg_restore --list check.dump | grep -c 'TABLE DATA'   # must be at least 1
pg_restore -f /dev/null check.dump                    # must exit 0
rm -f check.dump
```

An upload that cannot be read back is not a backup. Do this once before go-live, and again after any change to the
key, the bucket or the backup image.

The data key is not in these dumps' bucket and must not be: a dump is useless without it (ADR-0035).

**6.9.1 Restoring a dump from S3** (ADR-0305: manual, `aws s3` then `pg_restore`). Use it when the database must go
back to the night of a dump. For a recent point in time, RDS point-in-time recovery (under *Upgrades and rollback*)
is faster and loses less.

1. **Credentials.** The backup Job's role cannot read the bucket, by design. Use your own admin credentials, for
   example your SSO administrator role. They need:
   - `s3:ListBucketVersions` on the bucket;
   - `s3:GetObject` and `s3:GetObjectVersion` on `<bucket>/pg/*`;
   - `kms:Decrypt` on the stack key (`terraform output -raw kms_key_arn`). The key policy lets the account's IAM
     grant it.
2. **Choose the object version.** Each night writes a new key, `pg/regulait-<UTC timestamp>.dump`. Pick the key for
   the night you need, then its version:

   ```bash
   BUCKET=$(terraform output -raw backup_bucket)
   aws s3api list-object-versions --bucket "$BUCKET" --prefix pg/ \
     --query 'Versions[].[LastModified,Key,VersionId,IsLatest,Size]' --output table
   ```

   - The bucket is versioned, so a key normally has one version. If it has several, something wrote that key
     again: an operator re-running a Job, or a compromised backup pod overwriting it. Do not trust the latest
     version on sight. Take the newest version written **before** the incident, and check its size against the
     nights around it.
   - Noncurrent versions are kept for `backup_noncurrent_version_retention_days` (7) only, so act within that window.

   Download that exact version to your workstation:

   ```bash
   aws s3api get-object --bucket "$BUCKET" --key pg/regulait-<timestamp>.dump \
     --version-id <VersionId> regulait.dump
   ```

3. **Check the dump before using it.** A `--list` alone is not enough: a dump cut short still lists its contents,
   but holds no data (see `BACKUP_RESTORE.md`). Both checks run in a one-off pod (step 4), or anywhere with
   `pg_restore` 16:

   ```bash
   pg_restore --list regulait.dump | grep -c 'TABLE DATA'   # must be at least 1
   pg_restore -f /dev/null regulait.dump                    # must exit 0: reads the whole file
   ```

4. **Restore from inside the cluster.** RDS is reachable only from the nodes, so `pg_restore` runs in a one-off pod.
   Give it the labels of the operator's database clients, so the namespace's NetworkPolicy lets it reach DNS and the
   database and nothing else. Use the same `pg_dump` image as `spec.backup.image`, by digest. The pod reads the
   database URL from the `regulait` Secret (6.3).

   That URL was built from the RDS master password, which RDS keeps in Secrets Manager. If the Secret is gone or the
   password has been rotated, rebuild `database-url` from
   `aws secretsmanager get-secret-value --secret-id "$(terraform output -raw db_master_secret_arn)"`, exactly as in
   6.3.

   The URL asks for `sslmode=verify-full`, so the pod also needs the RDS CA bundle. Download it on your workstation
   from `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` and give it to the pod as a ConfigMap:

   ```bash
   kubectl -n regulait create configmap rds-ca --from-file=global-bundle.pem
   kubectl -n regulait apply -f - <<'EOF'
   apiVersion: v1
   kind: Pod
   metadata:
     name: db-restore
     labels:
       app.kubernetes.io/name: regulait
       app.kubernetes.io/instance: regulait
       app.kubernetes.io/component: migrate   # DNS and the database only (the operator's database-clients policy)
   spec:
     restartPolicy: Never
     automountServiceAccountToken: false
     securityContext: { runAsNonRoot: true, runAsUser: 999, seccompProfile: { type: RuntimeDefault } }
     containers:
       - name: restore
         image: <the pg_dump image from spec.backup.image, by digest>
         command: ["sleep", "3600"]
         env:
           - { name: DATABASE_URL, valueFrom: { secretKeyRef: { name: regulait, key: database-url } } }
           - { name: PGSSLROOTCERT, value: /ca/global-bundle.pem }
         securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
         volumeMounts:
           - { name: work, mountPath: /work }
           - { name: ca, mountPath: /ca, readOnly: true }
     volumes:
       - { name: work, emptyDir: { sizeLimit: 20Gi } }
       - { name: ca, configMap: { name: rds-ca } }
   EOF
   kubectl -n regulait wait --for=condition=Ready pod/db-restore --timeout=5m   # the first image pull can be slow
   kubectl -n regulait cp regulait.dump db-restore:/work/regulait.dump
   ```

   Run step 3's checks in the pod (`kubectl -n regulait exec db-restore -- pg_restore --list /work/regulait.dump`
   and so on). Then stop the gateway, so nothing writes while the data is replaced, and restore.

   Stop it through the installation, not the Deployment. The operator owns the gateway Deployment and resets its
   replica count from `spec.replicas` on every reconcile, so `kubectl scale` would bring the gateway back during the
   restore. Use your installation's name if it is not `regulait`:

   ```bash
   kubectl -n regulait patch regulaitinstallation regulait --type=merge -p '{"spec":{"replicas":0}}'
   kubectl -n regulait wait --for=delete pod \
     -l app.kubernetes.io/instance=regulait,app.kubernetes.io/component=gateway --timeout=5m
   kubectl -n regulait exec db-restore -- sh -c \
     'pg_restore --clean --if-exists --no-owner --single-transaction -d "$DATABASE_URL" /work/regulait.dump'
   ```

   - **Same version.** Restore with the RegulAIt version that took the dump. `--clean` drops only the objects in the
     dump, so tables that a later migration added would stay behind while the migration history goes back. If the
     dump is older than the running release, roll the release back first (*Upgrades and rollback*).
   - **The nightly backup.** If the backup CronJob fires during the restore, it dumps the database as it was before
     the restore, because the restore runs in one transaction. That is harmless, but restoring outside the
     schedule (`17 2 * * *` UTC by default) keeps the bucket's history easy to read.

   `--single-transaction` means a failed restore changes nothing. To rehearse first, restore into a scratch database
   on the same instance (`createdb` one, put its name in the URL, drop it afterwards) and leave the gateway running.
5. **The data key must match (ADR-0035).** Every stored credential in the dump is encrypted under the data key that
   was in the `regulait` Secret when the dump was taken. If the Secret still holds that key, change nothing. If it
   was recreated, put the recorded `DATA_KEY` (6.3) back under `data-key` before the gateway starts. Under a
   different key the gateway starts, but no stored credential decrypts, and they cannot be recovered.
6. **Start and clean up.** Start the gateway again through the installation, check sign-in and one stored
   connector, then delete the pod, the ConfigMap and the local copy of the dump:

   ```bash
   kubectl -n regulait patch regulaitinstallation regulait --type=merge -p '{"spec":{"replicas":1}}'
   kubectl -n regulait rollout status deploy/regulait-gateway --timeout=10m
   kubectl -n regulait delete pod db-restore && kubectl -n regulait delete configmap rds-ca
   shred -u regulait.dump 2>/dev/null || rm -f regulait.dump
   ```

   The dump holds the whole database. Keep it on your workstation only as long as the restore takes.

## 7. Sign-in with Microsoft Entra ID

1. In the **Entra admin center**, go to **App registrations → New registration**:
   - Name: `RegulAIt`. Supported accounts: **this organizational directory only**.
   - Redirect URI (Web): `https://<ingress_hostname>/auth/oidc/callback`.
2. On the app's **Certificates & secrets** page, create a client secret and copy its value.
3. On **Token configuration**, add the optional claim `email`.
4. Allow the issuer in RegulAIt, then add the provider. These calls use the bootstrap token from step 6.3, which
   RegulAIt admits as an admin ([INSTALL.md](INSTALL.md#2-wire-your-idp) shows the same calls). Type the client
   secret at the prompt, so it stays out of your shell history:

```bash
URL=https://<ingress_hostname>
read -rs CLIENT_SECRET
curl -sS "$URL/v1/egress/hosts" -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' \
  -d '{"host":"login.microsoftonline.com","note":"Entra ID"}'
curl -sS "$URL/v1/auth/oidc/providers" -H "Authorization: Bearer $BOOTSTRAP_TOKEN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg s "$CLIENT_SECRET" '{issuerUrl:"https://login.microsoftonline.com/<tenant-id>/v2.0",clientId:"<application-id>",clientSecret:$s}')"
unset CLIENT_SECRET BOOTSTRAP_TOKEN
```

   You can also add the provider on the SSO page (`/ui/admin/sso`).

5. Sign out, then sign in with **Microsoft**. Require MFA through an Entra Conditional Access policy on the app.
   RegulAIt reads the `amr` claim, and a sign-in without MFA is recorded as such.

> Not yet verified end to end against a live Entra tenant (the Keycloak broker path is, see
> [SSO_KEYCLOAK.md](SSO_KEYCLOAK.md)). Report anything unexpected with the support bundle (below).

## 8. Smoke test

```bash
../../modules/byoc-aws/smoke/smoke-test.sh --model <model-id>
```

Each check runs in a short-lived pod under the gateway's own identity. The test checks that:

- nodes are ready;
- the gateway role arrives through EKS Pod Identity;
- the audit bucket is locked;
- one tiny Bedrock call works;
- the database accepts TLS and refuses plain connections;
- an allow-listed host is reachable and `example.com` is not;
- NetworkPolicy is enforced.

Every line must say `PASS`. It cleans up after itself.

Add `--write-anchor-probe` once at install to prove that the audit bucket refuses deletes. The probe object stays
locked for the full retention (7 years by default). It is a few bytes, but it cannot be removed.

---

## Upgrades and rollback

- **RegulAIt version**: verify the new bundle (step 3), push its images (6.1), create its ConfigMap (6.4), then run
  `helm upgrade regulait deploy/helm/regulait -n regulait -f stack-values.yaml -f release-values.yaml` with the new
  version and digests. If the migration fails, the old version keeps running. To go back to the previous release
  (only if the new one did not migrate the database), run `helm rollback regulait -n regulait`. A version that has
  migrated cannot be rolled back that way: restore the database to its pre-upgrade point instead (below).
- **The AWS side**: change `customer.tfvars`, then run `terraform apply -var-file=customer.tfvars`. Read the plan:
  anything shown as *destroy* or *replace* on the database or the audit bucket is a stop-and-ask.
- **Database restore**: RDS keeps point-in-time backups for 14 days. Restore to a new instance in the RDS console,
  then update `database-url` in the `regulait` Secret and restart the gateway.

## Uninstall

Do these in order. Each step keeps something on purpose; the list after them says what is left and why.

1. `kubectl -n regulait delete ingress regulait` (this removes the load balancer), then
   `helm uninstall regulait -n regulait` and `helm uninstall aws-load-balancer-controller -n kube-system`.
   Wait until `aws elbv2 describe-load-balancers` no longer lists it: a load balancer left behind keeps the VPC from
   being deleted.
2. The install-secrets volume is kept on purpose (`Retain`): it holds the receipt and identity keys. Delete the PVC,
   PV and EBS volume only once you are sure.
3. Turn the two protections off in `customer.tfvars` and apply once, so the plan shows only those two changes:
   `db_deletion_protection = false` and `firewall_delete_protection = false`.
4. Empty the image repositories you mirrored (`aws ecr batch-delete-image`, or delete them in the console). They are
   never force-deleted, so `terraform destroy` stops on a repository that still has images in it.
5. Decide about the database dumps in the backup bucket. To keep them, run
   `terraform state rm 'module.byoc.module.backup_target[0]'` before destroying. To delete them, empty the bucket
   first (every version: `aws s3api list-object-versions`, then `delete-objects`). The bucket is never
   force-deleted, so `terraform destroy` stops on it while it holds anything.
6. Run `terraform destroy -var-file=customer.tfvars`. RDS takes a final snapshot unless you set
   `db_skip_final_snapshot`.
7. **The audit bucket cannot be deleted** until every anchor's lock has expired. That is what COMPLIANCE mode means.
   `terraform destroy` stops on it. Run `terraform state rm module.byoc.module.audit_anchors`, then destroy again.

**What is left behind, on purpose:**

| What | Why | When it goes |
|---|---|---|
| The final RDS snapshot | Your last copy of the database. | When you delete it (RDS console, Snapshots). |
| The audit-anchor bucket and its objects | Evidence: COMPLIANCE-mode locks cannot be shortened by anyone. Costs cents a year. | When the last lock expires (`audit_retention_days` after its write); then delete the bucket. |
| The KMS key | AWS keeps a deleted key for a 30-day waiting period, and the snapshot and anchors are encrypted with it. | 30 days after destroy, unless you cancel the deletion to keep reading the snapshot. Cancel it if you keep the snapshot. |
| The backup bucket, if you kept it (step 5) | Your `pg_dump` history, encrypted with the stack key. | When you empty and delete it. Keep the KMS key while you keep it. |
| The install-secrets EBS volume | Holds the receipt and identity keys (`Retain`). | When you delete it (step 2). |
| Log groups the add-ons created themselves | Created outside Terraform by EKS. | Delete `/aws/eks/<prefix>*` in CloudWatch if you do not need them. |

## Support bundle

```bash
../../modules/byoc-aws/smoke/support-bundle.sh --tf-dir . --namespace regulait
```

This writes `regulait-support-<time>.tar.gz`. It contains no secret values, no Terraform state, no prompts and no
audit rows. It does hold resource names, statuses, Kubernetes events and the last 500 log lines per container. **Read
it before you send it** (`tar -xzf` it and look).

## What stays in your account

`terraform output data_boundary` prints this with your resource names in it.

- **Both planes run in your account.** The governance control plane (policies, approvals, audit) and the
  agent-execution plane (model, connector and MCP calls on your users' behalf) both run on your EKS cluster.
  Prompts, completions, connector payloads, audit rows, keys and backups are stored in your RDS, S3 and KMS.
- **Nothing goes to RegulAIt (the vendor).** No telemetry, licence check or update call exists
  ([DATA_BOUNDARY.md](DATA_BOUNDARY.md) §1), and the network has no route to us. Updates come as signed bundles you
  bring in yourself.
- **What leaves the VPC:** Bedrock calls go through a private VPC endpoint and stay in AWS, in your account. HTTPS
  goes to the hosts in `egress_allowed_domains`, and nowhere else. Every other connection is dropped and logged in
  `/<prefix>/network-firewall/alert`.

## Known gaps (being fixed)

- The Helm chart's NetworkPolicy has no way to admit the load balancer (`ingressFrom` takes no `ipBlock`). Until it
  does, step 6.6 needs a chart change (tracked with the chart, ADR-0304).
- The Helm chart cannot yet pass the S3 audit-anchor settings (`terraform output gateway_environment`) to the
  gateway. Until it can, anchors go to the local volume only.
- The database URL asks for `sslmode=verify-full`, so the certificate and host name are checked. RDS certificates
  chain to the Amazon RDS CA, which Node.js does not ship, and the chart cannot yet mount the RDS CA bundle
  (`NODE_EXTRA_CA_CERTS`). Until it can, the gateway cannot verify the database and will not connect. Weakening
  the check is not the fix (ADR-0180). Tracked with the chart (ADR-0304).
- The chart's default-deny egress may block the EKS Pod Identity agent (`169.254.170.23:80`). If the gateway logs
  "could not load credentials", that is the cause.
