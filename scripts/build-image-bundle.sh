#!/usr/bin/env bash
# =============================================================================
# RegulAIt offline image bundle (ADR-0041, air-gapped path)
#
# Run this on a CONNECTED host. It builds the gateway image and saves it,
# together with the two upstream images the stack needs, into one tarball you
# can carry across an air gap on removable media.
#
#   scripts/build-image-bundle.sh --version 0.1.0 --out regulait-images-0.1.0.tar
#
# Then, on the air-gapped host:
#
#   scripts/install.sh --mode air_gapped --domain regulait.corp.local \
#                      --tls internal --image-bundle regulait-images-0.1.0.tar
#
# WHY THIS EXISTS
# `docker compose up --build` pulls node:22-trixie-slim from Docker Hub and runs
# `pnpm install --frozen-lockfile` against the npm registry. Both are outbound
# internet. An air-gapped host therefore cannot build; it can only RUN images
# that were built somewhere else and loaded from a file. That is the whole
# reason the air-gapped install path refuses to build and passes --no-build.
#
# Caddy serves two roles: the public TLS front (`tls` profile) and the
# sandbox executor's internal TLS front and CA copy (`isolation` profile,
# ADR-0190 I4 follow-ups). Every Caddy service names ONE reference, pinned by
# digest (docker-compose.yml `x-caddy-image`), and CADDY_IMAGE below must be
# that same string, so one saved image covers both. The bundle saves the image
# under the digest reference AND the plain tag (CADDY_TAG): on Docker's classic
# image store a digest reference does not survive save/load, so the air-gapped
# install runs the tag and checks the loaded image id against CADDY_IMAGE_IDS
# (scripts/install.sh says where the ids come from). Re-pin
# docker-compose.yml, this file and scripts/install.sh together.
#
# ENGINE IMAGES (opt-in, ENG-IMG): `--with-engines` also saves the three engine
# images the lock records (engines/images.lock.json), pulled from GHCR by their
# manifest digest. The packages are private: `docker login ghcr.io` first, with a
# token that can read them. Each image's id is checked against the lock before
# saving (the config digest on the classic image store, the manifest digest on
# the containerd store), and each is saved under its digest reference AND the
# fixed tag `regulait/engine-<engine>:bundled`, which the air-gapped install
# runs (a digest reference does not survive save/load on the classic store,
# the same reason as Caddy). `docker load` keeps each image's id, the config
# digest the executor starts a task by (the manifest's `taskImage`). An engine
# the lock has no published image for stops the bundle (nothing is guessed), and
# so does one whose keyless signature (engines/signatures/) does not verify.
#
# The tag matters: install.sh pins the gateway to `regulait/gateway:<version>`
# with `pull_policy: never`, so the tag written here and the --version passed
# to the installer must be the same string.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

die()  { printf '\n[FATAL] %s\n\n' "$*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }
ok()   { printf '  [ok]   %s\n' "$*"; }

VERSION=""
OUT=""
SKIP_BUILD=0
WITH_ENGINES=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version)    VERSION="${2:-}"; shift 2 ;;
    --out)        OUT="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --with-engines) WITH_ENGINES=1; shift ;;
    -h|--help)
      printf 'Usage: scripts/build-image-bundle.sh --version <v> [--out <tar>] [--skip-build] [--with-engines]\n'
      exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
done

if [ -z "$VERSION" ]; then
  VERSION="$(grep -m1 '"version"' "$REPO_ROOT/package.json" | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
fi
[ -n "$VERSION" ] || die "--version is required (and package.json had none)"
OUT="${OUT:-$REPO_ROOT/dist/regulait-images-$VERSION.tar}"

command -v docker >/dev/null 2>&1 || die "docker is required"
docker info >/dev/null 2>&1 || die "the docker daemon is not reachable"

GATEWAY_IMAGE="regulait/gateway:$VERSION"
CADDY_IMAGE="caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f"
CADDY_TAG="caddy:2.11.7-alpine"
CADDY_IMAGE_IDS="sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77 sha256:f6a2207268b0f0914df9d3569e1824d6adcfa7b59fbffe0f3cbc5d2d60423f71 sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229 sha256:84058f1a0e5beb97664a9b79dcfd267b594c033d5bb88d8463cdfb59c0779197"

if [ "$SKIP_BUILD" = "0" ]; then
  step "Building $GATEWAY_IMAGE (this pulls node:22-trixie-slim and runs pnpm install — internet required)"
  docker build -t "$GATEWAY_IMAGE" "$REPO_ROOT"
  ok "built $GATEWAY_IMAGE"
fi

step "Fetching the upstream images the compose stack uses"
for img in postgres:16 "$CADDY_IMAGE"; do
  docker image inspect "$img" >/dev/null 2>&1 || docker pull "$img"
  ok "$img"
done
# the plain tag on the digest-pulled image, checked against the pinned ids (see scripts/install.sh)
docker tag "$CADDY_IMAGE" "$CADDY_TAG"
CADDY_ID="$(docker image inspect --format '{{.Id}}' "$CADDY_TAG")"
case " $CADDY_IMAGE_IDS " in
  *" $CADDY_ID "*) ok "$CADDY_TAG is the pinned image ($CADDY_ID)" ;;
  *) die "$CADDY_TAG has image id $CADDY_ID, which is not pinned (allowed: $CADDY_IMAGE_IDS)" ;;
esac

ENGINE_REFS=()
if [ "$WITH_ENGINES" = "1" ]; then
  step "Fetching the engine images the lock records (engines/images.lock.json)"
  command -v node >/dev/null 2>&1 || die "--with-engines needs node to read engines/images.lock.json"
  for engine in promptfoo modelscan garak; do
    # one line: <repository> <manifestDigest> <imageId>, or nothing when the engine was never published
    entry="$(node -e '
      const l = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
      const e = l.engines[process.argv[2]];
      if (e && e.repository && e.manifestDigest && e.imageId) console.log(`${e.repository} ${e.manifestDigest} ${e.imageId}`);
    ' "$REPO_ROOT/engines/images.lock.json" "$engine")"
    [ -n "$entry" ] || die "engine $engine has no published image in engines/images.lock.json: publish it (the engine-images workflow) and record it first"
    read -r repo digest image_id <<<"$entry"
    ref="${repo}@${digest}"
    tag="regulait/engine-${engine}:bundled"
    docker image inspect "$ref" >/dev/null 2>&1 || docker pull "$ref" || die "could not pull $ref (the package is private: docker login ghcr.io first)"
    docker tag "$ref" "$tag"
    id="$(docker image inspect --format '{{.Id}}' "$tag")"
    case "$id" in
      "$image_id" | "$digest") ok "$tag is $ref (image id $id)" ;;
      *) die "$tag has image id $id, which is neither the lock's image id ($image_id) nor its manifest digest ($digest)" ;;
    esac
    # ADR-0197 Q2: only a signed image is bundled (the same offline check the air-gapped install runs on arrival)
    node "$REPO_ROOT/scripts/engine-images-lock-verify.mjs" --engine "$engine" || die "$ref has no keyless signature from the publish workflow on main that verifies (cosign v3.1.3 on PATH or in COSIGN)"
    ENGINE_REFS+=("$ref" "$tag")
  done
fi

step "Saving the bundle"
mkdir -p "$(dirname "$OUT")"
docker save -o "$OUT" "$GATEWAY_IMAGE" postgres:16 "$CADDY_IMAGE" "$CADDY_TAG" ${ENGINE_REFS[@]+"${ENGINE_REFS[@]}"}
ok "$OUT ($(du -h "$OUT" | cut -f1))"

cat <<NEXT

  Carry $(basename "$OUT") across the air gap, then:

    scripts/install.sh --mode air_gapped --domain <your-host> --tls internal \\
                       --version $VERSION --image-bundle /path/to/$(basename "$OUT")

  Integrity across the gap: the image tarball is NOT self-verifying. Either
  ship it INSIDE a signed update bundle
  (scripts/build-update-bundle.sh --include dist/$(basename "$OUT")), or record
  its digest here and check it on arrival:

    sha256sum $OUT

NEXT
