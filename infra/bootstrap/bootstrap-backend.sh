#!/usr/bin/env bash
# One-time bootstrap of the Terraform remote state backend for RegulAIt.
# Deliberately NOT Terraform (ADR-0003): Terraform needs this backend to
# exist before it can manage anything, including the backend itself.
#
# Run once, manually, after `aws sso login` under the Admin-BreakGlass
# permission set, against the Management account. Re-running is not
# idempotent by design — this is a rare, deliberate, human-invoked action.
set -euo pipefail

: "${AWS_PROFILE:?Set AWS_PROFILE to the SSO profile authenticated against the Management account}"
: "${AWS_REGION:?Set AWS_REGION, e.g. us-east-1}"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET_NAME="regulait-terraform-state-${ACCOUNT_ID}"
TABLE_NAME="regulait-terraform-locks"
KMS_ALIAS="alias/regulait-terraform-state"

echo "Account: ${ACCOUNT_ID}"
echo "Bucket:  ${BUCKET_NAME}"
echo "Table:   ${TABLE_NAME}"
echo "KMS:     ${KMS_ALIAS}"
echo

# 1. Dedicated KMS CMK for state encryption — not the AWS-managed aws/s3 key,
#    so the key policy can be scoped to only the principals that should ever
#    read/write Terraform state.
KEY_ID=$(aws kms create-key \
  --description "RegulAIt Terraform state encryption key" \
  --query 'KeyMetadata.KeyId' --output text)
aws kms create-alias --alias-name "${KMS_ALIAS}" --target-key-id "${KEY_ID}"
aws kms enable-key-rotation --key-id "${KEY_ID}"

# 2. State bucket: versioned, KMS-encrypted, fully blocked from public access,
#    TLS-only.
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

POLICY_FILE=$(mktemp)
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

# 3. DynamoDB lock table.
aws dynamodb create-table \
  --table-name "${TABLE_NAME}" \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --sse-specification Enabled=true,SSEType=KMS,KMSMasterKeyId="${KEY_ID}"

cat <<DONE

Backend ready. Set these in infra/environments/regulait-dev/backend.tf:

  bucket         = "${BUCKET_NAME}"
  dynamodb_table = "${TABLE_NAME}"
  kms_key_id     = "${KEY_ID}"
  region         = "${AWS_REGION}"
DONE
