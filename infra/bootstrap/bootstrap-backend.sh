#!/usr/bin/env bash
# One-time bootstrap of the Terraform remote state backend for RegulAIt.
# Deliberately NOT Terraform (ADR-0003): Terraform needs this backend to
# exist before it can manage anything, including the backend itself.
#
# Target: the company AWS account, after the owner has enabled AWS
# Organizations in it (so it is the management account) and IAM Identity
# Center with an admin permission set (ADR-0004: no IAM user, no access key).
# Run it from Git Bash or any bash, after `aws sso login --profile <profile>`:
#
#   AWS_PROFILE=<profile> AWS_REGION=<region> EXPECTED_ACCOUNT_ID=<12 digits> \
#     infra/bootstrap/bootstrap-backend.sh [--preflight-only | --write-backend-config]
#
# Fails closed before creating anything when:
# - the profile resolves to any account other than EXPECTED_ACCOUNT_ID;
# - the caller is not an Identity Center (AWSReservedSSO_*) role session;
# - the account is not the management account of an all-features Organization;
# - the state bucket, lock table or KMS alias already exists (no re-use of a
#   half-built or foreign backend; this is a rare, deliberate, human action).
# --preflight-only runs those checks and the SCP policy-type check, then stops.
# --write-backend-config (ADR-0228) is for a backend that ALREADY exists (an
#   earlier run): same account and session checks, then it requires the bucket,
#   table and alias to exist, creates nothing in AWS, and writes only the
#   missing backend.hcl files.
set -euo pipefail

PREFLIGHT_ONLY=false
WRITE_CONFIG_ONLY=false
case "${1:-}" in
  "") ;;
  --preflight-only) PREFLIGHT_ONLY=true ;;
  --write-backend-config) WRITE_CONFIG_ONLY=true ;;
  *) echo "Usage: $0 [--preflight-only | --write-backend-config]" >&2; exit 2 ;;
esac

# Every stack whose backend.hcl this script writes (never overwritten).
STACKS=(demo-sandbox/account demo-sandbox/aws demo-host/account demo-host/baseline demo-host/host)

write_backend_files() {
  local env_root target
  env_root="$(cd "$(dirname "$0")/../environments" && pwd)"
  for STACK in "${STACKS[@]}"; do
    target="${env_root}/${STACK}/backend.hcl"
    if [ -e "${target}" ]; then
      echo "Kept existing ${target}; check it matches the values below."
      continue
    fi
    cat > "${target}" <<BACKEND
bucket         = "${BUCKET_NAME}"
key            = "${STACK}/terraform.tfstate"
dynamodb_table = "${TABLE_NAME}"
kms_key_id     = "${KEY_ID}"
region         = "${AWS_REGION}"
encrypt        = true
profile        = "${AWS_PROFILE}"
BACKEND
    echo "Wrote ${target}"
  done
}

fail() { echo "REFUSED: $*" >&2; exit 1; }
# Text output of the Windows aws.exe under Git Bash ends lines in CR.
awsq() { aws "$@" | tr -d '\r'; }

: "${AWS_PROFILE:?Set AWS_PROFILE to the Identity Center profile of the company (management) account}"
: "${AWS_REGION:?Set AWS_REGION, e.g. us-east-1}"
: "${EXPECTED_ACCOUNT_ID:?Set EXPECTED_ACCOUNT_ID to the company account id (12 digits)}"
export AWS_PROFILE AWS_REGION

[[ "${EXPECTED_ACCOUNT_ID}" =~ ^[0-9]{12}$ ]] || fail "EXPECTED_ACCOUNT_ID must be 12 digits."

# --- 0. Preflight: right account, right kind of session, right Organization ---

ACCOUNT_ID=$(awsq sts get-caller-identity --query Account --output text) \
  || fail "no valid session for profile ${AWS_PROFILE}; run: aws sso login --profile ${AWS_PROFILE}"
CALLER_ARN=$(awsq sts get-caller-identity --query Arn --output text)

[ "${ACCOUNT_ID}" = "${EXPECTED_ACCOUNT_ID}" ] \
  || fail "profile ${AWS_PROFILE} resolves to account ${ACCOUNT_ID}, not EXPECTED_ACCOUNT_ID ${EXPECTED_ACCOUNT_ID}."

[[ "${CALLER_ARN}" == arn:aws:sts::"${ACCOUNT_ID}":assumed-role/AWSReservedSSO_* ]] \
  || fail "caller ${CALLER_ARN} is not an Identity Center role session; long-lived IAM users and root are not used (ADR-0004)."

ORG_MASTER=$(awsq organizations describe-organization --query Organization.MasterAccountId --output text) \
  || fail "AWS Organizations is not enabled in account ${ACCOUNT_ID}; enable it first (runbook step 1)."
ORG_FEATURES=$(awsq organizations describe-organization --query Organization.FeatureSet --output text)
[ "${ORG_MASTER}" = "${ACCOUNT_ID}" ] \
  || fail "account ${ACCOUNT_ID} is not the Organization's management account (${ORG_MASTER})."
[ "${ORG_FEATURES}" = "ALL" ] \
  || fail "the Organization has feature set ${ORG_FEATURES}; SCPs and budget actions need ALL."

BUCKET_NAME="regulait-terraform-state-${ACCOUNT_ID}"
TABLE_NAME="regulait-terraform-locks"
KMS_ALIAS="alias/regulait-terraform-state"

if [ "${WRITE_CONFIG_ONLY}" = true ]; then
  aws s3api head-bucket --bucket "${BUCKET_NAME}" >/dev/null 2>&1 \
    || fail "bucket ${BUCKET_NAME} does not exist; run without --write-backend-config first."
  aws dynamodb describe-table --table-name "${TABLE_NAME}" >/dev/null 2>&1 \
    || fail "table ${TABLE_NAME} does not exist in ${AWS_REGION}."
  KEY_ID=$(awsq kms describe-key --key-id "${KMS_ALIAS}" --query KeyMetadata.KeyId --output text) \
    || fail "KMS alias ${KMS_ALIAS} does not exist in ${AWS_REGION}."
  write_backend_files
  echo "Backend config written for account ${ACCOUNT_ID}; nothing created in AWS."
  exit 0
fi

if aws s3api head-bucket --bucket "${BUCKET_NAME}" >/dev/null 2>&1; then
  fail "bucket ${BUCKET_NAME} already exists (use --write-backend-config for the backend.hcl files)."
fi
if aws dynamodb describe-table --table-name "${TABLE_NAME}" >/dev/null 2>&1; then
  fail "table ${TABLE_NAME} already exists in ${AWS_REGION}."
fi
EXISTING_ALIAS=$(awsq kms list-aliases --query "Aliases[?AliasName=='${KMS_ALIAS}'].AliasName" --output text)
[ -z "${EXISTING_ALIAS}" ] || fail "KMS alias ${KMS_ALIAS} already exists in ${AWS_REGION}."

ROOT_ID=$(awsq organizations list-roots --query 'Roots[0].Id' --output text)
SCP_STATUS=$(awsq organizations list-roots \
  --query "Roots[0].PolicyTypes[?Type=='SERVICE_CONTROL_POLICY'].Status" --output text)

echo "Account: ${ACCOUNT_ID} (management account, caller ${CALLER_ARN})"
echo "Region:  ${AWS_REGION}"
echo "Bucket:  ${BUCKET_NAME}"
echo "Table:   ${TABLE_NAME}"
echo "KMS:     ${KMS_ALIAS}"
echo "SCPs:    ${SCP_STATUS:-not enabled} on root ${ROOT_ID}"
echo

if [ "${PREFLIGHT_ONLY}" = true ]; then
  echo "Preflight passed; nothing created (--preflight-only)."
  exit 0
fi

# --- 1. Organization policy type the sandbox stacks rely on --------------------
# The sandbox account's guardrail SCP and its budget spend cap are both SCPs.
if [ "${SCP_STATUS}" != "ENABLED" ]; then
  aws organizations enable-policy-type --root-id "${ROOT_ID}" --policy-type SERVICE_CONTROL_POLICY
fi

# --- 2. Dedicated KMS CMK for state encryption ---------------------------------
# Not the AWS-managed aws/s3 key, so the key policy can be scoped to only the
# principals that should ever read/write Terraform state.
KEY_ID=$(awsq kms create-key \
  --description "RegulAIt Terraform state encryption key" \
  --query 'KeyMetadata.KeyId' --output text)
aws kms create-alias --alias-name "${KMS_ALIAS}" --target-key-id "${KEY_ID}"
aws kms enable-key-rotation --key-id "${KEY_ID}"

# --- 3. State bucket: versioned, KMS-encrypted, no public access, TLS-only ------
if [ "${AWS_REGION}" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "${BUCKET_NAME}" --region "${AWS_REGION}"
else
  aws s3api create-bucket --bucket "${BUCKET_NAME}" --region "${AWS_REGION}" \
    --create-bucket-configuration LocationConstraint="${AWS_REGION}"
fi

aws s3api put-bucket-versioning --bucket "${BUCKET_NAME}" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption --bucket "${BUCKET_NAME}" \
  --server-side-encryption-configuration "{\"Rules\":[{\"ApplyServerSideEncryptionByDefault\":{\"SSEAlgorithm\":\"aws:kms\",\"KMSMasterKeyID\":\"${KEY_ID}\"},\"BucketKeyEnabled\":true}]}"

aws s3api put-public-access-block --bucket "${BUCKET_NAME}" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# Written next to this script (not /tmp) — on Git Bash, /tmp lives in a
# separate filesystem namespace the native Windows aws.exe can't see.
POLICY_FILE="$(dirname "$0")/.state-bucket-policy.json"
cat > "${POLICY_FILE}" <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DenyInsecureTransport",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": ["arn:aws:s3:::${BUCKET_NAME}", "arn:aws:s3:::${BUCKET_NAME}/*"],
      "Condition": { "Bool": { "aws:SecureTransport": "false" } }
    }
  ]
}
POLICY
aws s3api put-bucket-policy --bucket "${BUCKET_NAME}" --policy "file://${POLICY_FILE}"
rm -f "${POLICY_FILE}"

# --- 4. DynamoDB lock table ------------------------------------------------------
aws dynamodb create-table \
  --table-name "${TABLE_NAME}" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --sse-specification Enabled=true,SSEType=KMS,KMSMasterKeyId="${KEY_ID}"

# --- 5. backend.hcl per environment (git-ignored; never overwritten) -------------
write_backend_files

cat <<DONE

Backend ready in account ${ACCOUNT_ID}. For any other stack, a backend.hcl
(git-ignored) with its own key:

  bucket         = "${BUCKET_NAME}"
  key            = "<stack path>/terraform.tfstate"
  dynamodb_table = "${TABLE_NAME}"
  kms_key_id     = "${KEY_ID}"
  region         = "${AWS_REGION}"
  encrypt        = true
  profile        = "${AWS_PROFILE}"
DONE
