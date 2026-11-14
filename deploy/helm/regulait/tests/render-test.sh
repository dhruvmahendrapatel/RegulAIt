#!/usr/bin/env bash
# ADR-0304: render-time tests for the RegulAIt chart. Never talks to a cluster.
#
#   1. helm lint and helm template pass for the byoc and air_gapped example values;
#   2. every rendered pod is restricted (non-root, read-only root fs, ALL capabilities dropped, RuntimeDefault seccomp,
#      no privilege escalation), uses an image by digest, and reads secrets only through secretKeyRef;
#   3. insecure or incomplete values are refused at render time;
#   4. files/crd.yaml and files/role.yaml match the operator's generated copies.
#
# Usage: tests/render-test.sh [path/to/helm]   (kubeconform runs when KUBECONFORM is set to its path)
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
HELM="${1:-helm}"
cd "$here"
fail=0
ok() { printf '  ok   %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*" >&2; fail=1; }

for v in ci/byoc-values.yaml ci/air-gapped-values.yaml; do
  "$HELM" lint . -f "$v" --strict >/dev/null && ok "lint $v" || bad "lint $v"
  out="$(mktemp)"
  "$HELM" template t . -f "$v" >"$out" || { bad "template $v"; continue; }
  if [ -n "${KUBECONFORM:-}" ]; then
    "$KUBECONFORM" -strict -summary -ignore-missing-schemas -kubernetes-version 1.33.0 "$out" >/dev/null \
      && ok "kubeconform $v" || bad "kubeconform $v"
  fi
  # Pod-level checks: a line scan of the rendered YAML (no PyYAML needed; the chart renders fixed shapes).
  python3 - "$out" "$v" <<'PY' || fail=1
import re, sys
text = open(sys.argv[1]).read()
docs = [d for d in text.split("\n---") if "kind:" in d]
problems = []
for d in docs:
    kind = re.search(r"^kind: (\S+)", d, re.M).group(1)
    if kind not in ("Deployment", "Job"):
        continue
    name = re.search(r"^  name: (\S+)", d, re.M).group(1)
    for needle in ("runAsNonRoot: true", "readOnlyRootFilesystem: true", "allowPrivilegeEscalation: false",
                   'drop: ["ALL"]', "type: RuntimeDefault"):
        if needle not in d:
            problems.append(f"{kind}/{name}: missing {needle}")
    # Only the operator talks to the API server; every other pod runs without a token.
    if "component: operator" not in d and "automountServiceAccountToken: false" not in d:
        problems.append(f"{kind}/{name}: service account token is mounted")
    for img in re.findall(r"image: (\S+)", d):
        if not re.search(r"@sha256:[0-9a-f]{64}$", img):
            problems.append(f"{kind}/{name}: image {img} is not pinned by digest")
    for var in ("REGULAIT_DATA_KEY", "REGULAIT_BOOTSTRAP_TOKEN", "DATABASE_URL"):
        m = re.search(rf"- name: {var}\n(\s+)(\S+)", d)
        if m and m.group(2) != "valueFrom:":
            problems.append(f"{kind}/{name}: {var} is not read from a Secret")
if "k8s-app: kube-dns" not in text:
    problems.append("DNS egress is not limited to the cluster DNS pods")
if "169.254.0.0/16" not in text and "allowPublicEgress: true" in open(sys.argv[2]).read():
    problems.append("public egress does not exclude the instance metadata range")
policies = {re.search(r"^  name: (\S+)", d, re.M).group(1): d for d in docs if re.search(r"^kind: NetworkPolicy", d, re.M)}
# The release's policies are ordinary resources: an upgrade must never delete them from under the running gateway.
for want in ("t-baseline", "t-gateway", "t-database-clients"):
    if want not in policies:
        problems.append(f"missing NetworkPolicy {want}")
    elif "helm.sh/hook" in policies[want]:
        problems.append(f"{want} is a hook; hook policies are deleted and recreated on every upgrade")
# The hook copy covers the migration Job before the release's policies exist (first install), and is cleaned up.
hk = policies.get("t-hook-database-clients", "")
if not hk:
    problems.append("missing NetworkPolicy t-hook-database-clients")
elif 'helm.sh/hook-weight: "-10"' not in hk or "hook-succeeded" not in hk or "pre-install" not in hk:
    problems.append("t-hook-database-clients is not a pre-install hook at weight -10 deleted on success")
elif hk.split("spec:", 1)[1] != policies.get("t-database-clients", "").split("spec:", 1)[-1]:
    problems.append("t-hook-database-clients differs from t-database-clients")
if "t-baseline" in policies and "podSelector: {}" not in policies["t-baseline"]:
    problems.append("the baseline policy must select every pod in the namespace")
dbc = policies.get("t-database-clients", "")
if "443" in dbc or "0.0.0.0/0" in dbc or "172.20.0.0/16" in dbc or "ingress: []" not in dbc:
    problems.append("database-clients policy opens more than DNS and the database")
job = next((d for d in docs if re.search(r"^kind: Job", d, re.M)), "")
if "- name: verify-bundle" not in job or job.index("initContainers:") > job.index("containers:\n        - name: migrate"):
    problems.append("the migration Job does not verify the signed bundle in an init container before migrating")
if "--version=1.0.0" not in job:
    problems.append("verify-bundle is not pinned to .Values.version")
if "policyTypes: [Ingress, Egress]" not in text:
    problems.append("no default-deny NetworkPolicy")
for p in problems:
    print("  FAIL " + p, file=sys.stderr)
if not problems:
    print(f"  ok   restricted pods, digests, secretKeyRef, default-deny ({sys.argv[2]})")
sys.exit(1 if problems else 0)
PY
  rm -f "$out"
done

# Refusals: each override must make `helm template` fail.
refuse() {
  local why="$1"; shift
  if "$HELM" template t . -f ci/byoc-values.yaml "$@" >/dev/null 2>&1; then bad "not refused: $why"; else ok "refused: $why"; fi
}
refuse "no values at all"                 -f /dev/null --set mode= --set version= --set image.repository= --set image.digest= --set secrets.name=
refuse "hosted mode"                       --set mode=hosted
refuse "image by tag"                      --set image.digest=latest
refuse "unknown key (a secret value)"      --set secrets.dataKey=0123
refuse "registry not allowed"              --set image.repository=docker.io/library/gateway
refuse "air_gapped with public egress"     --set mode=air_gapped
refuse "air_gapped with a public CIDR"     -f ci/air-gapped-values.yaml --set egress.allowPublicEgress=false --set 'egress.allowedCIDRs={8.8.8.0/24}'
refuse "air_gapped with a private-looking supernet" -f ci/air-gapped-values.yaml --set egress.allowPublicEgress=false --set 'egress.databaseCIDRs={10.0.0.0/7}'
refuse "operator image without a digest"   --set operator.image.digest=
refuse "no bundle ConfigMap"               --set bundle.configMapName=
refuse "operator image outside registries" --set operator.image.repository=docker.io/regulait/operator
refuse "air_gapped with a public DNS CIDR" -f ci/air-gapped-values.yaml --set egress.allowPublicEgress=false --set 'egress.dns.cidrs={8.8.8.8/32}'
refuse "upgrade with no known installed version" --is-upgrade
refuse "malformed installed version"       --set bundle.installedVersion=latest

# An upgrade with bundle.installedVersion renders the downgrade check against it.
if "$HELM" template t . -f ci/byoc-values.yaml --is-upgrade --set bundle.installedVersion=0.9.0 2>/dev/null \
    | grep -q -- "--installed-version=0.9.0"; then ok "upgrade checks the downgrade against bundle.installedVersion"
else bad "upgrade does not pass bundle.installedVersion to verify-bundle"; fi

# The chart's copies of the operator's generated files.
cmp -s files/crd.yaml ../../operator/config/crd/deploy.regulait.ai_regulaitinstallations.yaml \
  && ok "files/crd.yaml matches the operator" || bad "files/crd.yaml differs from deploy/operator/config/crd"
cmp -s files/role.yaml ../../operator/config/rbac/role.yaml \
  && ok "files/role.yaml matches the operator" || bad "files/role.yaml differs from deploy/operator/config/rbac"

exit "$fail"
