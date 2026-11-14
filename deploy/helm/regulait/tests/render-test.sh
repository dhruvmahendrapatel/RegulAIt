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
refuse "operator without a digest"         --set operator.enabled=true

# The chart's copies of the operator's generated files.
cmp -s files/crd.yaml ../../operator/config/crd/deploy.regulait.ai_regulaitinstallations.yaml \
  && ok "files/crd.yaml matches the operator" || bad "files/crd.yaml differs from deploy/operator/config/crd"
cmp -s files/role.yaml ../../operator/config/rbac/role.yaml \
  && ok "files/role.yaml matches the operator" || bad "files/role.yaml differs from deploy/operator/config/rbac"

exit "$fail"
