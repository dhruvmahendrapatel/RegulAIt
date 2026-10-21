#!/usr/bin/env bash
# =============================================================================
# ENG-IMG — build ONE engine image (and optionally push it), the way the
# engine-images workflows do. ADR-0190 "As built: engine task images";
# reproducible builds: ADR-0187 addendum 2026-10-21.
#
#   scripts/build-engine-image.sh <promptfoo|modelscan|garak> build
#   scripts/build-engine-image.sh <promptfoo|modelscan|garak> repro <out.json>
#   scripts/build-engine-image.sh <promptfoo|modelscan|garak> push <ghcr.io/owner/regulait-engine-x> <out.json>
#
# `build` builds the working tree for linux/amd64 and keeps it only in the
# build cache (nothing is loaded, tagged or pushed): a quick local check. It
# is NOT reproducible (uncommitted files, the generated lock module as is).
#
# `repro` and `push` build REPRODUCIBLY, the same way:
#   - the input commit is the last commit that touched the engine's inputs
#     (scripts/engine-images-gate.mjs --input); the context is `git archive`
#     of exactly that commit, never the working tree, with the generated lock
#     module in its all-null form (engine-images-normalise.mjs `lock`);
#   - SOURCE_DATE_EPOCH is that commit's committer time, passed as a build arg
#     (the image config's `created`, the history and the in-build normalising)
#     and with buildx `rewrite-timestamp=true` (every file the build writes is
#     clamped to it);
#   - the label org.opencontainers.image.revision is that commit, not HEAD;
#   - a fresh, empty docker-container builder on the pinned BuildKit image
#     (BUILDKIT_IMAGE below), removed afterwards: no cache, no runner drift;
#   - OCI media types and gzip, named explicitly, so the defaults of a later
#     BuildKit cannot move the digest.
# `repro` keeps the image in the builder and writes <out.json>:
# {"engine","inputCommit","sourceDateEpoch","manifestDigest","imageId"} (the
# double-build check in engine-images-build.yml compares two of them).
# `push` pushes it as `<repository>:sha-<HEAD>` and writes <out.json>:
# {"engine","repository","manifestDigest","imageId","inputCommit","sourceDateEpoch"},
# read from BuildKit's own metadata file, not from the local image store (on
# Docker's containerd image store `.Id` is the manifest digest, not the
# config digest the executor runs by, so it would be the wrong value to record):
#   - manifestDigest = containerimage.digest (what was pushed; the runner's
#     REGULAIT_ENGINE_IMAGE_DIGEST and the gateway manifest's imageDigest);
#   - imageId = containerimage.config.digest (the manifest's taskImage).
# Provenance and SBOM attestations are off, so the pushed object is ONE
# single-platform image manifest (no index) and a pull of the manifest digest
# yields exactly that config.
#
# Needs: git, node, docker with the buildx plugin (present on GitHub's ubuntu
# runners), a full clone (the input commit is found in the history), and for
# `push` a `docker login ghcr.io` done by the caller.
# =============================================================================
set -euo pipefail

engine="${1:-}"
mode="${2:-}"
case "$engine" in promptfoo | modelscan | garak) ;; *)
  echo "usage: $0 <promptfoo|modelscan|garak> build | repro <out.json> | push <repository> <out.json>" >&2
  exit 2
  ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dockerfile="$root/engines/$engine/Dockerfile"
common=(--platform linux/amd64 --provenance=false --sbom=false)
# moby/buildkit v0.25.1, the multi-platform index digest (read from Docker Hub 2026-10-21). An auditor rebuilds
# with this same image: a different BuildKit may write the same files into different bytes.
BUILDKIT_IMAGE="moby/buildkit:v0.25.1@sha256:79cc6476ab1a3371c9afd8b44e7c55610057c43e18d9b39b68e2b0c2475cc1b6"

# reproducible build of the input commit: repro_build <output attrs> <out.json> <extra json fields (a node object literal)>
repro_build() {
  local output="$1" out="$2" extra="$3"
  local input epoch ctx meta builder
  read -r input epoch < <(node "$root/scripts/engine-images-gate.mjs" --input "$engine")
  [ -n "$input" ] && [ -n "$epoch" ] || { echo "no input commit for ${engine}" >&2; exit 1; }
  ctx="$(mktemp -d)"
  meta="$(mktemp)"
  builder="regulait-${engine}-$$"
  # shellcheck disable=SC2064 # expand now: these are this call's own paths
  trap "docker buildx rm --force '${builder}' >/dev/null 2>&1 || true; rm -rf '${ctx}' '${meta}'" EXIT
  git -C "$root" archive --format=tar "$input" | tar -x -C "$ctx"
  node "$ctx/scripts/engine-images-normalise.mjs" lock "$ctx/packages/shared/src/engines/images-lock.ts"
  docker buildx create --name "$builder" --driver docker-container --driver-opt "image=${BUILDKIT_IMAGE}" --bootstrap >/dev/null
  echo "${engine}: building input commit ${input} (SOURCE_DATE_EPOCH=${epoch}) in a fresh builder"
  docker buildx build --builder "$builder" "${common[@]}" -f "$ctx/engines/$engine/Dockerfile" \
    --build-arg "SOURCE_DATE_EPOCH=${epoch}" \
    --label "org.opencontainers.image.revision=${input}" \
    --metadata-file "$meta" \
    --output "${output},rewrite-timestamp=true,oci-mediatypes=true,compression=gzip" \
    "$ctx"
  node -e '
    const fs = require("node:fs");
    const [meta, engine, input, epoch, out, extra] = process.argv.slice(1);
    const m = JSON.parse(fs.readFileSync(meta, "utf8"));
    const manifestDigest = m["containerimage.digest"];
    const imageId = m["containerimage.config.digest"];
    const re = /^sha256:[0-9a-f]{64}$/;
    if (!re.test(manifestDigest ?? "") || !re.test(imageId ?? "")) {
      console.error("buildx metadata names no manifest or config digest");
      process.exit(1);
    }
    const record = { engine, ...JSON.parse(extra), manifestDigest, imageId, inputCommit: input, sourceDateEpoch: Number(epoch) };
    fs.writeFileSync(out, JSON.stringify(record) + "\n");
    console.log(`${engine}: ${record.repository ? record.repository + "@" : ""}${manifestDigest} (image id ${imageId}, input commit ${input})`);
  ' "$meta" "$engine" "$input" "$epoch" "$out" "$extra"
}

case "$mode" in
build)
  docker buildx build "${common[@]}" -f "$dockerfile" "$root"
  ;;
repro)
  out="${3:-}"
  [ -n "$out" ] || { echo "repro needs an output file" >&2; exit 2; }
  repro_build "type=image,name=regulait-engine-${engine}:repro,push=false" "$out" "{}"
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
  repro_build "type=image,name=${repo}:sha-${commit},push=true" "$out" "{\"repository\":\"${repo}\"}"
  ;;
*)
  echo "usage: $0 <promptfoo|modelscan|garak> build | repro <out.json> | push <repository> <out.json>" >&2
  exit 2
  ;;
esac
