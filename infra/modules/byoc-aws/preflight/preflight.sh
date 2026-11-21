#!/usr/bin/env bash
# BYOC AWS preflight (ADR-0325). Read-only: it creates, changes and deletes
# nothing. Run it with the same AWS profile you will run Terraform with.
#
#   preflight.sh --account <12-digit id> --region <region> [options]
#
# Options:
#   --prefix <name>          name_prefix you will use (default: regulait)
#   --az-count <n>           availability zones (default: 2)
#   --node-count <n>         EKS nodes (default: 2)
#   --node-vcpus <n>         vCPUs per node (default: 2, for m7i.large)
#   --model <id>             a Bedrock model or inference-profile id (repeatable)
#   --egress-mode <mode>     allow_list (default) or none
#   --allow-existing         do not fail when the stack's names already exist (re-run of an install)
#
# Exit status: 0 = every check passed or only warned; 1 = at least one FAIL.
set -uo pipefail

account="" region="" prefix="regulait" az_count=2 node_count=2 node_vcpus=2 egress_mode="allow_list" allow_existing=0
models=()
while [ $# -gt 0 ]; do
  case "$1" in
    --account) account="$2"; shift 2 ;;
    --region) region="$2"; shift 2 ;;
    --prefix) prefix="$2"; shift 2 ;;
    --az-count) az_count="$2"; shift 2 ;;
    --node-count) node_count="$2"; shift 2 ;;
    --node-vcpus) node_vcpus="$2"; shift 2 ;;
    --model) models+=("$2"); shift 2 ;;
    --egress-mode) egress_mode="$2"; shift 2 ;;
    --allow-existing) allow_existing=1; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

fails=0 warns=0
pass() { printf 'PASS  %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; warns=$((warns + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }
need() { command -v "$1" >/dev/null 2>&1; }

[[ "$account" =~ ^[0-9]{12}$ ]] || { echo "--account must be a 12-digit AWS account id" >&2; exit 2; }
[ -n "$region" ] || { echo "--region is required" >&2; exit 2; }
export AWS_REGION="$region" AWS_DEFAULT_REGION="$region" AWS_PAGER=""

echo "== Tools"
if need aws && aws --version 2>&1 | grep -q '^aws-cli/2'; then pass "AWS CLI v2 ($(aws --version 2>&1 | cut -d' ' -f1))"; else fail "AWS CLI v2 is required"; fi
if need terraform; then
  tfv="$(terraform version -json 2>/dev/null | sed -n 's/.*"terraform_version": *"\([0-9.]*\)".*/\1/p')"
  if [ -n "$tfv" ] && [ "$(printf '%s\n1.11.1\n' "$tfv" | sort -V | head -1)" = "1.11.1" ]; then pass "Terraform $tfv"; else fail "Terraform 1.11.1 or later is required (found ${tfv:-none})"; fi
else fail "Terraform 1.11.1 or later is required"; fi
if need kubectl; then pass "kubectl"; else fail "kubectl is required (install step)"; fi
if need helm; then pass "helm"; else warn "helm not found: needed to install the chart (runbook step 6)"; fi
if need jq; then pass "jq"; else fail "jq is required"; fi
if ! need aws || ! need jq; then echo; echo "Fix the tools above and run again."; exit 1; fi

echo "== Identity"
if ident="$(aws sts get-caller-identity --output json 2>/dev/null)"; then
  got="$(jq -r .Account <<<"$ident")"; arn="$(jq -r .Arn <<<"$ident")"
  if [ "$got" = "$account" ]; then pass "signed in to account $got as $arn"; else fail "signed in to account $got, expected $account: switch profile"; fi
  case "$arn" in *":root") fail "signed in as the account root user: use an SSO role" ;; *":user/"*) warn "signed in as an IAM user (long-lived keys); an SSO role is preferred" ;; esac
else
  fail "no AWS credentials (run: aws sso login --profile <profile>)"; echo; exit 1
fi

echo "== Region"
if aws ec2 describe-regions --region-names "$region" --output text >/dev/null 2>&1; then pass "region $region is enabled"; else fail "region $region is not enabled for this account"; fi
azs="$(aws ec2 describe-availability-zones --filters Name=opt-in-status,Values=opt-in-not-required Name=state,Values=available --query 'length(AvailabilityZones)' --output text 2>/dev/null || echo 0)"
if [ "${azs:-0}" -ge "$az_count" ]; then pass "$azs availability zones (need $az_count)"; else fail "only ${azs:-0} availability zones, need $az_count"; fi

echo "== Quotas"
quota() { aws service-quotas get-service-quota --service-code "$1" --quota-code "$2" --query 'Quota.Value' --output text 2>/dev/null | cut -d. -f1; }
check_quota() { # service code name need used
  local q; q="$(quota "$1" "$2")"
  if [ -z "$q" ] || [ "$q" = "None" ]; then warn "$3: could not read the quota (servicequotas:GetServiceQuota); need $4 more"; return; fi
  if [ $(( q - $5 )) -ge "$4" ]; then pass "$3: quota $q, in use $5, need $4"; else fail "$3: quota $q, in use $5, need $4: request an increase in Service Quotas"; fi
}
vpcs="$(aws ec2 describe-vpcs --query 'length(Vpcs)' --output text 2>/dev/null || echo 0)"
eips="$(aws ec2 describe-addresses --query 'length(Addresses)' --output text 2>/dev/null || echo 0)"
eks_n="$(aws eks list-clusters --query 'length(clusters)' --output text 2>/dev/null || echo 0)"
rds_n="$(aws rds describe-db-instances --query 'length(DBInstances)' --output text 2>/dev/null || echo 0)"
check_quota vpc L-F678F1CE "VPCs per region" 1 "$vpcs"
if [ "$egress_mode" = "allow_list" ]; then
  check_quota ec2 L-0263D0A3 "Elastic IPs" "$az_count" "$eips"
fi
check_quota eks L-1194D53C "EKS clusters" 1 "$eks_n"
check_quota rds L-7B6409FD "RDS DB instances" 1 "$rds_n"
check_quota ec2 L-1216C47A "On-Demand Standard vCPUs (running instances not counted)" $(( (node_count + 1) * node_vcpus )) 0

echo "== Services"
if [ "$egress_mode" = "allow_list" ]; then
  if aws network-firewall list-firewalls --max-results 1 >/dev/null 2>&1; then pass "AWS Network Firewall is available"; else fail "AWS Network Firewall is not available or not permitted in $region"; fi
fi
if aws ec2 describe-vpc-endpoint-services --service-names "com.amazonaws.$region.bedrock-runtime" >/dev/null 2>&1; then pass "Bedrock runtime VPC endpoint is offered in $region"; else fail "no Bedrock runtime VPC endpoint in $region"; fi
if aws ec2 describe-vpc-endpoint-services --service-names "com.amazonaws.$region.eks-auth" >/dev/null 2>&1; then pass "EKS Pod Identity endpoint is offered in $region"; else fail "no eks-auth VPC endpoint in $region"; fi

echo "== Bedrock models"
if [ "${#models[@]}" -eq 0 ]; then warn "no --model given: the gateway will have no Bedrock access"; fi
for m in "${models[@]}"; do
  base="$(sed -E 's/^(us|eu|apac|us-gov|global)\.//' <<<"$m")"
  if [ "$base" != "$m" ]; then
    if aws bedrock get-inference-profile --inference-profile-identifier "$m" >/dev/null 2>&1; then pass "inference profile $m exists"; else fail "inference profile $m not found in $region"; fi
  fi
  if ! aws bedrock get-foundation-model --model-identifier "$base" >/dev/null 2>&1; then fail "model $base not offered in $region"; continue; fi
  avail="$(aws bedrock get-foundation-model-availability --model-id "$base" --output json 2>/dev/null || true)"
  if [ -z "$avail" ]; then warn "model $base: could not read access status; confirm in the Bedrock console (Model access)"; continue; fi
  auth="$(jq -r '.authorizationStatus // empty' <<<"$avail")"; ent="$(jq -r '.entitlementAvailability // empty' <<<"$avail")"
  if [ "$auth" = "AUTHORIZED" ] && [ "$ent" = "AVAILABLE" ]; then pass "model $base: access granted"; else fail "model $base: access not granted (authorization=$auth, entitlement=$ent): request it in the Bedrock console"; fi
done

echo "== Names are free"
exists() {
  if [ "$allow_existing" = 1 ]; then warn "$1 already exists (allowed by --allow-existing)"; else fail "$1 already exists: pick another --prefix or remove it"; fi
}
bucket="$prefix-audit-anchors-$account"
if aws s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then exists "S3 bucket $bucket"; else pass "S3 bucket $bucket is free"; fi
if aws eks describe-cluster --name "$prefix-eks" >/dev/null 2>&1; then exists "EKS cluster $prefix-eks"; else pass "EKS cluster $prefix-eks is free"; fi
if aws rds describe-db-instances --db-instance-identifier "$prefix-pg" >/dev/null 2>&1; then exists "RDS instance $prefix-pg"; else pass "RDS instance $prefix-pg is free"; fi
if aws kms describe-key --key-id "alias/$prefix-data" >/dev/null 2>&1; then exists "KMS alias alias/$prefix-data"; else pass "KMS alias alias/$prefix-data is free"; fi

echo
echo "Preflight: $fails failed, $warns warnings."
[ "$fails" -eq 0 ]
