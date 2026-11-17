#!/usr/bin/env bash
# BYOC AWS support bundle (ADR-0325). Collects what we need to help with an
# install, into one tar.gz you review and then send. Read-only.
#
#   support-bundle.sh [--tf-dir <dir>] [--namespace <ns>] [--out <file>]
#
# What it collects: Terraform outputs (minus nothing secret: the stack outputs
# no secret), resource summaries (EKS, node group, RDS, firewall, VPC
# endpoints), Kubernetes state of the gateway namespace (pods, events,
# NetworkPolicies, the last 500 log lines per container), node conditions, and
# the last hour of Network Firewall alerts.
# What it never collects: Secret values, the database password, Terraform state,
# prompts or audit rows. Every file is plain text: read it before sending.
set -uo pipefail

tf_dir="." ns="regulait" out="regulait-support-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
while [ $# -gt 0 ]; do
  case "$1" in
    --tf-dir) tf_dir="$2"; shift 2 ;;
    --namespace) ns="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
d="$work/bundle"; mkdir -p "$d"
cap() { local f="$1"; shift; "$@" >"$d/$f" 2>&1 || echo "(exit $?)" >>"$d/$f"; }

out_json="$(terraform -chdir="$tf_dir" output -json 2>/dev/null || echo '{}')"
jq 'with_entries(.value = .value.value)' <<<"$out_json" >"$d/terraform-outputs.json"
region="$(jq -r '.region // empty' "$d/terraform-outputs.json")"
cluster="$(jq -r '.cluster_name // empty' "$d/terraform-outputs.json")"
export AWS_REGION="${region:-${AWS_REGION:-}}" AWS_PAGER=""

cap versions.txt sh -c 'aws --version; terraform version; kubectl version --client; helm version 2>/dev/null'
cap caller.json aws sts get-caller-identity
if [ -n "$cluster" ]; then
  cap eks-cluster.json aws eks describe-cluster --name "$cluster" --query 'cluster.{status:status,version:version,endpoint:resourcesVpcConfig,logging:logging,health:health}'
  cap eks-nodegroups.json sh -c "for n in \$(aws eks list-nodegroups --cluster-name '$cluster' --query 'nodegroups[]' --output text); do aws eks describe-nodegroup --cluster-name '$cluster' --nodegroup-name \"\$n\" --query 'nodegroup.{name:nodegroupName,status:status,health:health,scaling:scalingConfig,instanceTypes:instanceTypes}'; done"
  cap eks-addons.json sh -c "for a in \$(aws eks list-addons --cluster-name '$cluster' --query 'addons[]' --output text); do aws eks describe-addon --cluster-name '$cluster' --addon-name \"\$a\" --query 'addon.{name:addonName,version:addonVersion,status:status,health:health}'; done"
  cap pod-identity.json aws eks list-pod-identity-associations --cluster-name "$cluster"
fi
prefix="${cluster%-eks}"
cap rds.json aws rds describe-db-instances --db-instance-identifier "$prefix-pg" --query 'DBInstances[0].{status:DBInstanceStatus,class:DBInstanceClass,engine:EngineVersion,multiAZ:MultiAZ,encrypted:StorageEncrypted,backupRetention:BackupRetentionPeriod,pendingModifications:PendingModifiedValues}'
cap firewall.json aws network-firewall describe-firewall --firewall-name "$prefix-egress" --query '{status:FirewallStatus.Status,config:FirewallStatus.ConfigurationSyncStateSummary}'
cap firewall-alerts-last-hour.json aws logs filter-log-events --log-group-name "/$prefix/network-firewall/alert" --start-time "$(( ($(date +%s) - 3600) * 1000 ))" --limit 200 --query 'events[].message'
cap vpc-endpoints.json aws ec2 describe-vpc-endpoints --filters "Name=vpc-id,Values=$(jq -r '.vpc_id // "none"' "$d/terraform-outputs.json")" --query 'VpcEndpoints[].{service:ServiceName,state:State}'

cap k8s-nodes.txt kubectl get nodes -o wide
cap k8s-node-conditions.json kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.conditions[?(@.status=="True")].type}{"\n"}{end}'
cap k8s-namespace.txt kubectl -n "$ns" get all,networkpolicy,pvc,serviceaccount,ingress -o wide
cap k8s-events.txt kubectl -n "$ns" get events --sort-by=.lastTimestamp
cap k8s-pods-describe.txt kubectl -n "$ns" describe pods
cap k8s-system-pods.txt kubectl -n kube-system get pods -o wide
for p in $(kubectl -n "$ns" get pods -o name 2>/dev/null); do
  cap "logs-${p#pod/}.txt" kubectl -n "$ns" logs "$p" --all-containers --tail=500 --timestamps
done

# Belt and braces: drop any line that looks like a credential.
grep -rlE '(password|secret|token)["=: ]+[A-Za-z0-9/+]{16,}' "$d" 2>/dev/null | while read -r f; do
  sed -i -E 's/((password|secret|token)["=: ]+)[A-Za-z0-9/+=]{16,}/\1<redacted>/gI' "$f"
done

tar -C "$work" -czf "$out" bundle
echo "Wrote $out. Read it before you send it: tar -xzf $out && less bundle/*"
