#!/usr/bin/env bash
# =============================================================================
# ENG-IMG — build ONE engine image (and optionally push it), the way the
# engine-images workflows do. ADR-0190 "As built: engine task images".
#
#   scripts/build-engine-image.sh <promptfoo|modelscan|garak> build
#   scripts/build-engine-image.sh <promptfoo|modelscan|garak> push <ghcr.io/owner/regulait-engine-x> <out.json>
#
# `build` builds the image for linux/amd64 and keeps it only in the build cache
# (nothing is loaded, tagged or pushed): the pull_request check.
#
# `push` builds and pushes it as `<repository>:sha-<commit>` and writes
# <out.json>: {"engine","repository","manifestDigest","imageId"}, read from
# BuildKit's own metadata file, not from the local image store (on Docker's
# containerd image store `.Id` is the manifest digest, not the config digest
# the executor runs by, so it would be the wrong value to record):
#   - manifestDigest = containerimage.digest (what was pushed; the runner's
#     REGULAIT_ENGINE_IMAGE_DIGEST and the gateway manifest's imageDigest);
#   - imageId = containerimage.config.digest (the manifest's taskImage).
# Provenance and SBOM attestations are off, so the pushed object is ONE
# single-platform image manifest (no index) and a pull of the manifest digest
# yields exactly that config.
#
# Needs: docker with the buildx plugin (present on GitHub's ubuntu runners),
# and for `push` a `docker login ghcr.io` done by the caller.
# =============================================================================
set -euo pipefail

engine="${1:-}"
mode="${2:-}"
case "$engine" in promptfoo | modelscan | garak) ;; *)
  echo "usage: $0 <promptfoo|modelscan|garak> build | push <repository> <out.json>" >&2
  exit 2
  ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dockerfile="$root/engines/$engine/Dockerfile"
common=(--platform linux/amd64 --provenance=false --sbom=false -f "$dockerfile")

case "$mode" in
build)
  docker buildx build "${common[@]}" "$root"
  ;;
push)
  repo="${3:-}"
  out="${4:-}"
  if ! printf '%s' "$repo" | grep -Eq "^ghcr\.io/[a-z0-9][a-z0-9-]{0,38}/regulait-engine-${engine}\$"; then
    echo "the repository must be ghcr.io/<lowercase owner>/regulait-engine-${engine}" >&2
    exit 2
  fi
  [ -n "$out" ] || { echo "push needs an output file" >&2; exit 2; }
  commit="$(git -C "$root" rev-parse HEAD)"
  meta="$(mktemp)"
  docker buildx build "${common[@]}" \
    --label "org.opencontainers.image.revision=${commit}" \
    --tag "${repo}:sha-${commit}" \
    --metadata-file "$meta" \
    --push "$root"
  node -e '
    const fs = require("node:fs");
    const [meta, engine, repo, out] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(meta, "utf8"));
    const manifestDigest = m["containerimage.digest"];
    const imageId = m["containerimage.config.digest"];
    const re = /^sha256:[0-9a-f]{64}$/;
    if (!re.test(manifestDigest ?? "") || !re.test(imageId ?? "")) {
      console.error("buildx metadata names no manifest or config digest");
      process.exit(1);
    }
    fs.writeFileSync(out, JSON.stringify({ engine, repository: repo, manifestDigest, imageId }) + "\n");
    console.log(`${engine}: ${repo}@${manifestDigest} (image id ${imageId})`);
  ' "$meta" "$engine" "$repo" "$out"
  rm -f "$meta"
  ;;
*)
  echo "usage: $0 <promptfoo|modelscan|garak> build | push <repository> <out.json>" >&2
  exit 2
  ;;
esac
