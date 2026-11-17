#!/usr/bin/env bash
# BYOC AWS smoke test (ADR-0325). Run after `terraform apply`, from the root you
# applied (infra/environments/byoc-aws), with kubectl pointed at the cluster.
#
#   smoke-test.sh [--model <bedrock id>] [--write-anchor-probe] [--tf-dir <dir>]
#
# Checks, each from a short-lived pod under the gateway's own namespace and
# service account (so it uses the same Pod Identity binding the gateway will):
#   nodes       every node is Ready
#   identity    the pod gets the gateway role through EKS Pod Identity
#   audit       the audit bucket reports Object Lock; with --write-anchor-probe,
#               a probe object is written and deleting it is refused (WORM).
#               The probe stays locked for the bucket's retention, so use it
#               on a rehearsal or once at install, not routinely.
#   bedrock     with --model, one Converse call (5 output tokens) succeeds
#   database    TLS connection works and a non-TLS one is refused
#   egress      an allow-listed host is reachable, any other host is not
#   netpol      a pod under a default-deny NetworkPolicy cannot reach anything
# Pods and the temporary Secret are deleted at the end, pass or fail.
# Exit status: 0 = every check passed.
set -uo pipefail

tf_dir="." model="" probe=0
while [ $# -gt 0 ]; do
  case "$1" in
    --model) model="$2"; shift 2 ;;
    --write-anchor-probe) probe=1; shift ;;
    --tf-dir) tf_dir="$2"; shift 2 ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

out="$(terraform -chdir="$tf_dir" output -json)" || { echo "cannot read terraform outputs in $tf_dir" >&2; exit 2; }
o() { jq -r "$1" <<<"$out"; }
region="$(o .region.value)"
bucket="$(o .audit_bucket.value)"
cache="$(o '.ecr_public_cache_prefix.value // empty')"
db_host="$(o .db_endpoint.value)"
db_secret="$(o .db_master_secret_arn.value)"
role="$(o .gateway_role_arn.value)"
mode="$(o .egress.value.mode)"
allowed="$(o '.egress.value.allowed_domains[0] // empty')"
ns="${SMOKE_NAMESPACE:-regulait}"
sa="${SMOKE_SERVICE_ACCOUNT:-regulait-gateway}"
export AWS_REGION="$region" AWS_DEFAULT_REGION="$region" AWS_PAGER=""

[ -n "$cache" ] || { echo "the stack has no public.ecr.aws pull-through cache (ecr_pull_through_ecr_public = false); the smoke test needs it" >&2; exit 2; }
AWSCLI="$cache/aws-cli/aws-cli@sha256:87b9da7e8fd3600143149dbc0e95270072f1c3f0ff7017bf8442314f1552e6ea"     # 2.31.20
PG="$cache/docker/library/postgres@sha256:f377d590e5474681d4d7838635031a2b50647923b7abfa803ce9b5ff35d5c663"   # 16-alpine
PY="$cache/docker/library/python@sha256:c5ba3deef00c7758561a0f03c26f44f10589263d40e732b8748e0d1f38f6dd89"     # 3.12-alpine

fails=0
pass() { printf 'PASS  %s\n' "$*"; }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }
label="regulait.ai/smoke=true"

cleanup() {
  kubectl -n "$ns" delete pod,secret,networkpolicy -l "$label" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

# run <name> <image> <script> [extra pod-spec JSON merged into spec]: runs a
# pod to completion and prints its log; returns the container's exit code.
run() {
  local name="smoke-$1" image="$2" script="$3" extra="${4:-}"
  [ -n "$extra" ] || extra='{}'
  local spec
  spec="$(jq -n --arg n "$name" --arg ns "$ns" --arg sa "$sa" --arg img "$image" --arg s "$script" --argjson extra "$extra" '{
    apiVersion: "v1", kind: "Pod",
    metadata: {name: $n, namespace: $ns, labels: {"regulait.ai/smoke": "true", "regulait.ai/smoke-pod": $n}},
    spec: ({
      serviceAccountName: $sa, automountServiceAccountToken: false, restartPolicy: "Never",
      securityContext: {runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: {type: "RuntimeDefault"}},
      containers: [{
        name: "c", image: $img, command: ["/bin/sh", "-c", $s],
        env: [{name: "HOME", value: "/tmp"}],
        securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}},
        resources: {requests: {cpu: "50m", memory: "64Mi"}, limits: {cpu: "500m", memory: "256Mi"}}
      }]
    } * $extra)
  }')"
  kubectl -n "$ns" delete pod "$name" --ignore-not-found >/dev/null 2>&1
  kubectl apply -f - <<<"$spec" >/dev/null || return 99
  local phase=""
  for _ in $(seq 1 90); do
    phase="$(kubectl -n "$ns" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null)"
    case "$phase" in Succeeded|Failed) break ;; esac
    sleep 4
  done
  kubectl -n "$ns" logs "$name" 2>/dev/null | sed 's/^/      /'
  [ "$phase" = "Succeeded" ] || { [ "$phase" = "Failed" ] && return 1; echo "      (pod did not finish: phase=${phase:-unknown})"; return 98; }
}

echo "== nodes"
if kubectl wait --for=condition=Ready nodes --all --timeout=600s >/dev/null; then pass "all $(kubectl get nodes --no-headers | wc -l | tr -d ' ') nodes Ready"; else fail "nodes not Ready"; fi

kubectl get namespace "$ns" >/dev/null 2>&1 || kubectl create namespace "$ns" >/dev/null
kubectl -n "$ns" get serviceaccount "$sa" >/dev/null 2>&1 || kubectl -n "$ns" create serviceaccount "$sa" >/dev/null
kubectl -n "$ns" patch serviceaccount "$sa" -p '{"automountServiceAccountToken": false}' >/dev/null

echo "== identity (EKS Pod Identity)"
if got="$(run identity "$AWSCLI" 'aws sts get-caller-identity --query Arn --output text')" && grep -q "assumed-role/${role##*/}/" <<<"$got"; then
  pass "pod runs as ${role##*/}"
else
  printf '%s\n' "$got"; fail "pod did not get the gateway role"
fi

echo "== audit bucket"
if got="$(run audit-lock "$AWSCLI" "aws s3api get-object-lock-configuration --bucket $bucket --query ObjectLockConfiguration.Rule.DefaultRetention.Mode --output text")"; then
  pass "Object Lock on $bucket: $(tr -d ' ' <<<"$got" | tail -1)"
else
  printf '%s\n' "$got"; fail "cannot read Object Lock configuration of $bucket"
fi
if [ "$probe" = 1 ]; then
  key="audit-anchors/smoke/probe-$(date +%s)"
  script="set -e
v=\$(aws s3api put-object --bucket $bucket --key $key --body /etc/hostname --query VersionId --output text)
echo written \$v
if aws s3api delete-object --bucket $bucket --key $key --version-id \$v 2>/tmp/err; then echo DELETED; exit 1; fi
grep -q AccessDenied /tmp/err && echo delete-refused"
  if got="$(run audit-worm "$AWSCLI" "$script")" && grep -q delete-refused <<<"$got"; then
    pass "anchor written; deleting it was refused (WORM)"
  else
    printf '%s\n' "$got"; fail "WORM probe"
  fi
fi

echo "== bedrock"
if [ -n "$model" ]; then
  script="aws bedrock-runtime converse --model-id '$model' --messages '[{\"role\":\"user\",\"content\":[{\"text\":\"Reply with the single word OK.\"}]}]' --inference-config maxTokens=5 --query 'output.message.content[0].text' --output text"
  if got="$(run bedrock "$AWSCLI" "$script")"; then pass "Converse on $model: $(tail -1 <<<"$got" | tr -d ' ')"; else printf '%s\n' "$got"; fail "Bedrock Converse on $model"; fi
else
  echo "SKIP  no --model given"
fi

echo "== database"
secret="$(aws secretsmanager get-secret-value --secret-id "$db_secret" --query SecretString --output text)" || { fail "cannot read the database secret"; secret=""; }
if [ -n "$secret" ]; then
  kubectl -n "$ns" delete secret smoke-db --ignore-not-found >/dev/null
  kubectl -n "$ns" create secret generic smoke-db \
    --from-literal=PGUSER="$(jq -r .username <<<"$secret")" \
    --from-literal=PGPASSWORD="$(jq -r .password <<<"$secret")" >/dev/null
  kubectl -n "$ns" label secret smoke-db regulait.ai/smoke=true >/dev/null
  unset secret
  # The extra spec replaces the container list, adding the database
  # environment and the credentials Secret.
  dbrun() {
    local name="$1" sql_script="$2" extra
    extra="$(jq -n --arg img "$PG" --arg s "$sql_script" --arg host "$db_host" '{containers: [{
      name: "c", image: $img, command: ["/bin/sh", "-c", $s],
      env: [{name: "HOME", value: "/tmp"}, {name: "PGHOST", value: $host}, {name: "PGDATABASE", value: "regulait"}, {name: "PGCONNECT_TIMEOUT", value: "10"}],
      envFrom: [{secretRef: {name: "smoke-db"}}],
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"]}},
      resources: {requests: {cpu: "50m", memory: "64Mi"}, limits: {cpu: "500m", memory: "256Mi"}}
    }]}')"
    run "$name" "$PG" "$sql_script" "$extra"
  }
  if got="$(dbrun db-tls "PGSSLMODE=require psql -Atc 'select current_setting(\$\$ssl\$\$), version()'")" && grep -q 'on|PostgreSQL' <<<"$got"; then
    pass "TLS connection: $(grep -o 'PostgreSQL [0-9.]*' <<<"$got" | head -1)"
  else
    printf '%s\n' "$got"; fail "TLS connection to $db_host"
  fi
  if got="$(dbrun db-plain "PGSSLMODE=disable psql -Atc 'select 1' && echo CONNECTED")"; grep -q CONNECTED <<<"$got"; then
    fail "a non-TLS connection was accepted"
  else
    pass "non-TLS connection refused"
  fi
fi

echo "== egress ($mode)"
probe_py='import socket,ssl,sys
h=sys.argv[1]
try:
    s=socket.create_connection((h,443),timeout=8); t=ssl.create_default_context().wrap_socket(s,server_hostname=h); t.close(); print("REACHED",h)
except Exception as e:
    print("BLOCKED",h,type(e).__name__)'
if [ "$mode" = "allow_list" ] && [ -n "$allowed" ]; then
  h="${allowed#.}"
  if got="$(run egress-allowed "$PY" "python3 -c '$probe_py' $h")" && grep -q REACHED <<<"$got"; then pass "allow-listed $h reachable"; else printf '%s\n' "$got"; fail "allow-listed $h not reachable"; fi
fi
if got="$(run egress-denied "$PY" "python3 -c '$probe_py' example.com")" && grep -q BLOCKED <<<"$got"; then pass "example.com blocked"; else printf '%s\n' "$got"; fail "example.com was reachable"; fi

echo "== NetworkPolicy enforcement"
kubectl apply -f - >/dev/null <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: smoke-deny-all
  namespace: $ns
  labels: { regulait.ai/smoke: "true" }
spec:
  podSelector:
    matchLabels: { regulait.ai/smoke-pod: smoke-netpol }
  policyTypes: [Ingress, Egress]
YAML
sleep 5
if got="$(run netpol "$PY" "python3 -c '$probe_py' sts.$region.amazonaws.com")" && grep -q BLOCKED <<<"$got"; then
  pass "default-deny NetworkPolicy is enforced"
else
  printf '%s\n' "$got"; fail "NetworkPolicy not enforced (VPC CNI enableNetworkPolicy)"
fi

echo
echo "Smoke test: $fails failed."
[ "$fails" -eq 0 ]
