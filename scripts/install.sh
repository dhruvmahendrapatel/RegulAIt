#!/usr/bin/env bash
# =============================================================================
# RegulAIt one-command installer (ADR-0041)
#
# Brings up the ADR-0013 compose stack — gateway + Postgres + Caddy TLS
# (ADR-0029) — into a customer's own cloud account (BYOC) or onto an
# air-gapped host, parameterised by their REGULAIT_DATA_KEY, domain and OIDC
# issuer. No hand-assembly of env vars, no engineer in the room.
#
#   ./scripts/install.sh --mode byoc --domain regulait.acme.example --tls letsencrypt
#   ./scripts/install.sh --mode air_gapped --domain regulait.corp.local --tls internal \
#                        --image-bundle /media/usb/regulait-images-0.1.0.tar
#   ./scripts/install.sh --check --mode byoc --domain x.example --dir /tmp/plan
#
# DESIGN NOTES THAT ARE NOT OBVIOUS
#
#  1. THE DATA KEY IS THE WHOLE BALLGAME. Connector tokens, model API keys and
#     TOTP secrets are AES-256-GCM ciphertext under REGULAIT_DATA_KEY
#     (apps/gateway/src/secrets.ts). A restore onto a NEW box without that key
#     recovers every row and decrypts NONE of the credentials — permanently.
#     ADR-0035 names this the sharpest edge in the stack. So this installer
#     refuses to proceed on a missing-or-weak key, generates one only with a
#     loud out-of-band-custody warning, and never writes it anywhere except the
#     .env it renders.
#
#  2. RE-RUNNING CONVERGES, IT NEVER DESTROYS. Every secret already present in
#     the target .env is PRESERVED rather than regenerated (regenerating the
#     data key on an upgrade would brick every stored credential; regenerating
#     the Postgres password would lock the gateway out of its own database,
#     because POSTGRES_PASSWORD is only honoured on FIRST initdb and the volume
#     already exists). Rendering is byte-deterministic — there is deliberately
#     no timestamp in the output — so `render twice` produces an identical file
#     and idempotency is checkable with `diff`.
#
#  3. AIR-GAPPED MEANS NO OUTBOUND, INCLUDING AT BUILD TIME. `docker compose
#     up --build` pulls node:22-trixie-slim and runs `pnpm install` against the npm
#     registry; that is internet, so the air-gapped path never builds. It
#     requires pre-seeded images (`scripts/build-image-bundle.sh` on a
#     connected host, `--image-bundle` here) and refuses Let's Encrypt, whose
#     ACME challenge is an outbound call by construction.
#
#  4. THE INSTALL DIRECTORY IS CONFIG ONLY. All state lives in Docker named
#     volumes (pgdata, caddy_data, caddy_config). --dir holds .env, the
#     generated compose override and .regulait-version, nothing else — which is
#     why `--check --dir /tmp/anything` is safe and is the dry-run path.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$REPO_ROOT/docker-compose.yml"
PROJECT="regulait"

# --- output helpers ---------------------------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'; C_YEL=$'\033[33m'; C_GRN=$'\033[32m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=''; C_YEL=''; C_GRN=''; C_BLD=''; C_RST=''
fi
info() { printf '  %s\n' "$*"; }
step() { printf '\n%s==>%s %s\n' "$C_BLD" "$C_RST" "$*"; }
ok()   { printf '  %s[ok]%s   %s\n' "$C_GRN" "$C_RST" "$*"; }
warn() { printf '  %s[warn]%s %s\n' "$C_YEL" "$C_RST" "$*" >&2; }
die()  { printf '\n%s[FATAL]%s %s\n\n' "$C_RED" "$C_RST" "$*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
RegulAIt installer — one command to a running, TLS-terminated control plane.

Usage: scripts/install.sh [options]

Deployment
  --mode <hosted|byoc|air_gapped>  Deployment mode (default: byoc).
  --domain <host>                  Public hostname this deployment serves.
  --tls <letsencrypt|internal|none>
                                   TLS posture. Default: letsencrypt for
                                   hosted/byoc, internal for air_gapped.
                                   air_gapped REFUSES letsencrypt (ACME is an
                                   outbound call).
  --acme-email <addr>              Optional ACME account contact (letsencrypt only).
  --public-url <url>               ADR-0188 S7: this deployment's public origin
                                   (REGULAIT_PUBLIC_URL), the issuer engine
                                   runners and PDP clients take tokens from.
                                   Default: https://<domain> behind Caddy, else
                                   the value already in .env. Needed when you
                                   terminate TLS yourself (--tls none).
  --oidc-issuer <url>              Recorded for the post-install summary and
                                   printed as the exact admin call to make.
                                   NOTE: no gateway code reads this env var —
                                   OIDC providers are DB rows (see below).
  --seed-demo                      Load the demo dataset. Default OFF in every
                                   mode (ADR-0181). The seed refuses a database
                                   that already has a real admin.
  --hsts <value>                   Strict-Transport-Security value, or "off".
                                   OMITTED unless you pass it — and omitted is
                                   NOT the same as empty, which means "off".
  --saml-entity-id <url>           ADR-0036, optional. Pin the SP entity id.
  --saml-clock-skew <minutes>      ADR-0036, optional. Default 2, clamped to 9.
  --version <v>                    Version label to record (default: package.json).

Secrets
  --data-key <hex64>               REGULAIT_DATA_KEY. Also read from the
                                   environment or from an existing .env.
                                   Generated (and printed once) if absent.
  --admin-token <tok>              REGULAIT_BOOTSTRAP_TOKEN, the identity-less
                                   break-glass admin credential. Generated if
                                   absent, and RETIRED by the installer once the
                                   first admin exists (ADR-0194), also when you
                                   pass it on a first install. Passing it AFTER
                                   it was retired re-opens that door on purpose
                                   (break-glass) until a run without it.
  --db-password <pw>               Postgres password. Generated on a first
                                   install; preserved on every re-run.
  --receipt-key-file <host path>   ADR-0189 R25: a receipt signing key YOU
  --receipt-key-id <id>            manage (PKCS#8 Ed25519 PEM, readable by uid
                                   1000) and its key id; both or neither.
                                   Mounted read-only into the gateway and
                                   preserved on every re-run. Omitted: the
                                   install generates its own key (see
                                   docs/deployment/INSTALL.md).

First admin (ADR-0194)
  An interactive install asks for the first admin's username (default
  "admin"), email and password (twice, not echoed) once the stack is up. The
  org password policy is checked before anything is created. The password is
  never written to .env, a compose file, a log, shell history or audit detail.
  Non-interactive (--yes, or no terminal): set these in the environment.
    REGULAIT_FIRST_ADMIN_PASSWORD_FILE  a file holding the password, mode 0600
                                        or stricter (never a command argument)
    REGULAIT_FIRST_ADMIN_EMAIL          required with the file
    REGULAIT_FIRST_ADMIN_USERNAME       default: admin
  Without the file a non-interactive install skips the step; see the summary
  for the manual path. A deployment that already has an admin skips it too.

Air-gapped
  --image-bundle <path.tar>        `docker load` this image bundle before
                                   bringing the stack up. Required on an
                                   air-gapped host with no images present.

Placement / behaviour
  --dir <path>                     Where .env and the generated override are
                                   written (default: the repo root).
  --check, --dry-run               Run the FULL preflight + render path and
                                   stop before touching containers.
  --yes, -y                        Non-interactive; never prompt.
  --show-secrets                   Print generated secrets in the summary
                                   (implied when they are newly generated).
  --min-disk-gb <n>                Free-space floor (default: 5).
  -h, --help                       This text.

Exit codes: 0 ok, 1 fatal (preflight or render refusal).
USAGE
}

# --- defaults ---------------------------------------------------------------
MODE=""
DOMAIN=""
# ADR-0188 S7: the gateway's issuer (REGULAIT_PUBLIC_URL). Kept from a prior install; else
# https://<domain> when Caddy terminates TLS; else unset (see the warning below).
PUBLIC_URL=""
TLS=""
ACME_EMAIL=""
OIDC_ISSUER=""
SEED_DEMO=""
VERSION=""
# Three variables whose UNSET state is meaningfully different from their EMPTY
# state, so they are only ever written when an operator actually chose a value.
HSTS="${REGULAIT_HSTS-}"
SAML_ENTITY_ID="${REGULAIT_SAML_ENTITY_ID-}"
SAML_CLOCK_SKEW="${REGULAIT_SAML_CLOCK_SKEW_MINUTES-}"
DATA_KEY="${REGULAIT_DATA_KEY:-}"
ADMIN_TOKEN="${REGULAIT_BOOTSTRAP_TOKEN:-}"
ADMIN_TOKEN_FLAG=0
# ADR-0194: 1 once the installer has retired the bootstrap token (recorded in .env, read back on re-runs)
BOOTSTRAP_RETIRED=0
# 1 only when --admin-token re-opens a token an earlier run retired (break-glass); never on a first install
TOKEN_REOPENED=0
FIRST_ADMIN_PASSWORD_FILE="${REGULAIT_FIRST_ADMIN_PASSWORD_FILE:-}"
FIRST_ADMIN_USERNAME="${REGULAIT_FIRST_ADMIN_USERNAME:-}"
FIRST_ADMIN_EMAIL="${REGULAIT_FIRST_ADMIN_EMAIL:-}"
DB_PASSWORD="${REGULAIT_DB_PASSWORD:-}"
# ADR-0189 R25 item 12: an operator-managed receipt key (host path + key id). Empty = install-generated.
RECEIPT_KEY_FILE="${REGULAIT_RECEIPT_KEY_HOST_FILE:-}"
RECEIPT_KEY_ID="${REGULAIT_RECEIPT_KEY_HOST_ID:-}"
RECEIPT_KEY_CONTAINER_PATH="/run/secrets/regulait-receipt-signing-key"
IMAGE_BUNDLE=""
INSTALL_DIR=""
CHECK_ONLY=0
ASSUME_YES=0
SHOW_SECRETS=0
MIN_DISK_GB=5

GENERATED_DATA_KEY=0
GENERATED_ADMIN_TOKEN=0
GENERATED_DB_PASSWORD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)          MODE="${2:-}"; shift 2 ;;
    --domain)        DOMAIN="${2:-}"; shift 2 ;;
    --tls)           TLS="${2:-}"; shift 2 ;;
    --acme-email)    ACME_EMAIL="${2:-}"; shift 2 ;;
    --public-url)    PUBLIC_URL="${2:-}"; shift 2 ;;
    --oidc-issuer)   OIDC_ISSUER="${2:-}"; shift 2 ;;
    --seed-demo)     SEED_DEMO=1; shift ;;
    --no-seed-demo)  SEED_DEMO=0; shift ;;
    --version)       VERSION="${2:-}"; shift 2 ;;
    --hsts)          HSTS="${2:-}"; shift 2 ;;
    --saml-entity-id)  SAML_ENTITY_ID="${2:-}"; shift 2 ;;
    --saml-clock-skew) SAML_CLOCK_SKEW="${2:-}"; shift 2 ;;
    --data-key)      DATA_KEY="${2:-}"; shift 2 ;;
    --admin-token)   ADMIN_TOKEN="${2:-}"; ADMIN_TOKEN_FLAG=1; shift 2 ;;
    --db-password)   DB_PASSWORD="${2:-}"; shift 2 ;;
    --receipt-key-file) RECEIPT_KEY_FILE="${2:-}"; shift 2 ;;
    --receipt-key-id)   RECEIPT_KEY_ID="${2:-}"; shift 2 ;;
    --image-bundle)  IMAGE_BUNDLE="${2:-}"; shift 2 ;;
    --dir)           INSTALL_DIR="${2:-}"; shift 2 ;;
    --check|--dry-run) CHECK_ONLY=1; shift ;;
    --yes|-y)        ASSUME_YES=1; shift ;;
    --show-secrets)  SHOW_SECRETS=1; shift ;;
    --min-disk-gb)   MIN_DISK_GB="${2:-}"; shift 2 ;;
    -h|--help)       usage; exit 0 ;;
    *)               usage >&2; die "unknown option: $1" ;;
  esac
done

INSTALL_DIR="${INSTALL_DIR:-$REPO_ROOT}"
ENV_FILE="$INSTALL_DIR/.env"
OVERRIDE_FILE="$INSTALL_DIR/compose.install.yml"
VERSION_FILE="$INSTALL_DIR/.regulait-version"

# --- tiny utilities ---------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }

# Read a KEY=value out of an existing rendered .env. Deliberately naive — this
# installer is the only writer of that file and never quotes values.
env_get() {
  local file="$1" key="$2" line
  [ -f "$file" ] || return 0
  line="$(grep -m1 -E "^${key}=" "$file" 2>/dev/null || true)"
  [ -n "$line" ] || return 0
  printf '%s' "${line#*=}"
}

rand_hex32() { openssl rand -hex 32; }
rand_token() { openssl rand -hex 24; }

prompt() { # prompt VAR "question" "default"
  local __var="$1" __q="$2" __def="${3:-}" __ans=""
  if [ "$ASSUME_YES" = "1" ] || [ ! -t 0 ]; then
    printf -v "$__var" '%s' "$__def"
    return 0
  fi
  if [ -n "$__def" ]; then
    read -r -p "  $__q [$__def]: " __ans || true
  else
    read -r -p "  $__q: " __ans || true
  fi
  printf -v "$__var" '%s' "${__ans:-$__def}"
}

# ---------------------------------------------------------------------------
# THE DATA-KEY STRENGTH GATE
#
# A 64-hex-char string is not automatically a key. The compose file ships
# `aaaa…aaaa` as an explicitly dev-grade default and it has been copy-pasted
# into more than one deployment in this project's own history. Refuse:
#   * anything that is not exactly 64 hex characters (secrets.ts throws anyway,
#     but at first credential write, i.e. long after the operator left);
#   * the shipped dev default;
#   * fewer than 8 distinct hex characters (catches aaaa…, 0101…, deadbeef…);
#   * any string that is a short block repeated to length (period <= 16).
# ---------------------------------------------------------------------------
DEV_DEFAULT_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

data_key_problem() {
  local k="$1" lower distinct period block
  [ -n "$k" ] || { echo "missing"; return 0; }
  lower="$(printf '%s' "$k" | tr 'A-F' 'a-f')"
  # `[[ =~ ]]`, NOT `grep -qE '^…$'`. grep anchors per LINE, so a multi-line
  # value where any single line happens to be 64 hex chars would pass — and a
  # multi-line value is exactly what you get from a careless
  # `grep REGULAIT_DATA_KEY .env | cut -d= -f2` that also matched a comment.
  # That is not hypothetical: it happened while testing this script, and the
  # rendered .env came out with a comment embedded in the key.
  if [[ ! "$lower" =~ ^[0-9a-f]{64}$ ]]; then
    echo "not exactly 64 hex characters with no whitespace (AES-256 needs exactly 32 bytes; apps/gateway/src/secrets.ts throws otherwise)"
    return 0
  fi
  if [ "$lower" = "$DEV_DEFAULT_KEY" ]; then
    echo "this is the docker-compose.yml DEV DEFAULT key — it is published in this repo"
    return 0
  fi
  distinct="$(printf '%s' "$lower" | fold -w1 | sort -u | wc -l | tr -d ' ')"
  if [ "$distinct" -lt 8 ]; then
    echo "only $distinct distinct hex characters — not random"
    return 0
  fi
  for period in 1 2 4 8 16; do
    block="${lower:0:$period}"
    rep="$(printf "${block}%.0s" $(seq 1 $((64 / period))))"
    if [ "$lower" = "$rep" ]; then
      echo "a ${period}-character block repeated to length — not random"
      return 0
    fi
  done
  return 0
}

# ---------------------------------------------------------------------------
# ADR-0063 — the key's NON-SECRET fingerprint, computed identically to
# apps/gateway/src/data-key.ts:
#
#   "dk1:" + first 16 bytes of HMAC-SHA256(key = the raw key bytes,
#                                          msg = "regulait/data-key-fingerprint/v1")
#
# The installer prints this beside the key so an operator records BOTH: the
# secret, and the string that lets them later prove they have the right one
# without revealing it. `-macopt hexkey:` is what makes openssl treat the value
# as 32 raw bytes rather than 64 ASCII characters — get that wrong and this
# prints a plausible-looking value the gateway will never agree with.
# ---------------------------------------------------------------------------
DATA_KEY_FINGERPRINT_DOMAIN="regulait/data-key-fingerprint/v1"

data_key_fingerprint() {
  local k fp
  k="$(printf '%s' "$1" | tr 'A-F' 'a-f')"
  have openssl || { echo "(openssl unavailable — read it from the gateway boot log)"; return 0; }
  fp="$(printf '%s' "$DATA_KEY_FINGERPRINT_DOMAIN" \
        | openssl dgst -sha256 -mac HMAC -macopt "hexkey:${k}" 2>/dev/null \
        | sed 's/.*= //' | tr -d '\r\n' | cut -c1-32)"
  if [ ${#fp} -ne 32 ]; then
    echo "(could not compute — read it from the gateway boot log)"
  else
    echo "dk1:${fp}"
  fi
}

# 0 = listening, 1 = free, 2 = could not tell.
# Three probes, in decreasing fidelity. The last is bash's /dev/tcp, which only
# proves something ACCEPTS a connection on loopback — weaker than reading the
# listen table (it cannot see a listener bound to a different interface), but
# minimal container images routinely ship neither ss nor netstat and silently
# skipping the whole check is worse.
port_in_use() {
  local p="$1"
  if have ss; then
    if ss -ltnH "sport = :$p" 2>/dev/null | grep -q .; then return 0; else return 1; fi
  elif have netstat; then
    if netstat -ltn 2>/dev/null | grep -qE "[:.]$p[[:space:]]"; then return 0; else return 1; fi
  else
    if (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then return 0; else return 1; fi
  fi
}

docker_up() { docker info >/dev/null 2>&1; }

stack_running() {
  docker_up || return 1
  [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$PROJECT" 2>/dev/null)" ]
}

volume_exists() {
  docker_up || return 1
  docker volume inspect "${PROJECT}_$1" >/dev/null 2>&1
}

# ADR-0190 I5 follow-up: the Caddy image. ONLINE, compose runs docker-compose.yml's `x-caddy-image`, this digest
# reference. AIR-GAPPED, a digest reference does not survive `docker save`/`docker load` on Docker's classic image
# store (the image arrives untagged, with no repository digest), so the bundle also carries the plain tag, the
# air-gapped override runs the tag, and the loaded image's id must be one of CADDY_IMAGE_IDS. The ids, read from the
# Docker Hub registry API on 2026-10-17 for the index below: on the classic store an image's id is its platform's
# config digest (linux/amd64 sha256:f77f856a..., linux/arm64 sha256:f6a22072...); on the containerd image store it
# is the index digest (sha256:d8542f48...), or the platform manifest digest when only one platform was pulled
# (linux/amd64 sha256:173b2630..., linux/arm64 sha256:84058f1a...). Re-pin with docker-compose.yml and
# scripts/build-image-bundle.sh together.
CADDY_IMAGE="caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f"
CADDY_TAG="caddy:2.11.7-alpine"
CADDY_IMAGE_IDS="sha256:f77f856a30f0004200b36b322d61da17fade31e24875699d77fb968399b9eb77 sha256:f6a2207268b0f0914df9d3569e1824d6adcfa7b59fbffe0f3cbc5d2d60423f71 sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f sha256:173b26306d711395accaeba8b67afcaad2a085ccb1e6bf26010bfe8c095a5229 sha256:84058f1a0e5beb97664a9b79dcfd267b594c033d5bb88d8463cdfb59c0779197"

image_present() {
  docker_up || return 1
  docker image inspect "$1" >/dev/null 2>&1
}

# the loaded Caddy tag is the pinned image (air-gapped: the tag is what runs)
caddy_image_id_ok() {
  local id
  docker_up || return 1
  id="$(docker image inspect --format '{{.Id}}' "$CADDY_TAG" 2>/dev/null)" || return 1
  case " $CADDY_IMAGE_IDS " in *" $id "*) return 0 ;; esac
  return 1
}

# ENG-IMG: an engine image a bundle carries (`build-image-bundle.sh --with-engines`) runs air-gapped as the fixed tag
# regulait/engine-<engine>:bundled. Its id must be the one engines/images.lock.json records for that engine (the
# config digest on the classic image store, the manifest digest on the containerd store). The lock is written one
# field per line by scripts/engine-images-lock.mjs, so the engine's block is the 8 lines after its name.
ENGINE_IDS="promptfoo modelscan garak"
engine_bundled_id_ok() { # engine
  local id entry
  docker_up || return 1
  id="$(docker image inspect --format '{{.Id}}' "regulait/engine-$1:bundled" 2>/dev/null)" || return 1
  printf '%s' "$id" | grep -Eq '^sha256:[0-9a-f]{64}$' || return 1
  # the lock read as JSON (as build-image-bundle.sh does), never by line layout. No node: the check fails closed.
  have node || { warn "node is needed to read engines/images.lock.json and check the bundled engine images"; return 1; }
  # one line: <manifestDigest> <imageId>, or nothing when the engine was never published
  entry="$(node -e '
    const l = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const e = l.engines[process.argv[2]];
    if (e && e.manifestDigest && e.imageId) console.log(`${e.manifestDigest} ${e.imageId}`);
  ' "$SCRIPT_DIR/../engines/images.lock.json" "$1" 2>/dev/null)" || return 1
  [ -n "$entry" ] || return 1
  case " $entry " in
    *" $id "*) return 0 ;;
    *) return 1 ;;
  esac
}

# ADR-0197 Q2: the locked engine image is also the one the publish workflow signed keylessly. Verified OFFLINE, before
# the image is used, against the Sigstore bundle and trusted root the checkout carries (engines/signatures/, written by
# `engine-images-lock.mjs --apply`): cosign v3.1.3, pinned by SHA-256, checks the Fulcio chain, the Rekor inclusion
# proof, the certificate identity (engine-images.yml on refs/heads/main of this repository), the GitHub OIDC issuer,
# and that the signed statement names exactly the lock's manifest digest, image id and source commit. No cosign, no
# node, no bundle or any refusal: the check fails closed. COSIGN names the binary when it is not on PATH.
engine_signature_ok() { # engine
  have node || { warn "node is needed to verify the bundled engine images' signatures"; return 1; }
  node "$SCRIPT_DIR/engine-images-lock-verify.mjs" --engine "$1"
}

# ===========================================================================
# 1. RESOLVE CONFIGURATION (flags > environment > existing .env > prompt)
# ===========================================================================
step "RegulAIt installer — resolving configuration"

if [ -f "$ENV_FILE" ]; then
  ok "found an existing install at $ENV_FILE — re-running converges it, nothing is destroyed"
  PRIOR_MODE="$(env_get "$ENV_FILE" REGULAIT_DEPLOY_MODE)"
  PRIOR_DOMAIN="$(env_get "$ENV_FILE" REGULAIT_TLS_HOST)"
  PRIOR_ISSUER="$(env_get "$ENV_FILE" REGULAIT_TLS_ISSUER)"
  PRIOR_EMAIL="$(env_get "$ENV_FILE" REGULAIT_TLS_EMAIL_DIRECTIVE)"
  PRIOR_OIDC="$(env_get "$ENV_FILE" REGULAIT_OIDC_ISSUER)"
  PRIOR_SEED="$(env_get "$ENV_FILE" SEED_DEMO)"
  [ -n "$PUBLIC_URL" ] || PUBLIC_URL="$(env_get "$ENV_FILE" REGULAIT_PUBLIC_URL)"
  [ -n "$DATA_KEY" ]     || DATA_KEY="$(env_get "$ENV_FILE" REGULAIT_DATA_KEY)"
  [ -n "$ADMIN_TOKEN" ]  || ADMIN_TOKEN="$(env_get "$ENV_FILE" REGULAIT_BOOTSTRAP_TOKEN)"
  PRIOR_RETIRED="$(env_get "$ENV_FILE" REGULAIT_BOOTSTRAP_RETIRED)"
  [ -n "$DB_PASSWORD" ]  || DB_PASSWORD="$(env_get "$ENV_FILE" REGULAIT_DB_PASSWORD)"
  if [ -z "$RECEIPT_KEY_FILE" ] && [ -z "$RECEIPT_KEY_ID" ]; then
    RECEIPT_KEY_FILE="$(env_get "$ENV_FILE" REGULAIT_RECEIPT_KEY_HOST_FILE)"
    RECEIPT_KEY_ID="$(env_get "$ENV_FILE" REGULAIT_RECEIPT_KEY_HOST_ID)"
  fi
  [ -n "$MODE" ]         || MODE="$PRIOR_MODE"
  [ -n "$DOMAIN" ]       || DOMAIN="$PRIOR_DOMAIN"
  [ -n "$OIDC_ISSUER" ]  || OIDC_ISSUER="$PRIOR_OIDC"
  # ADR-0181 FX3: a prior SEED_DEMO=1 is NOT carried over (it was the old hosted
  # default, not necessarily a choice); re-running keeps the demo only with --seed-demo
  if [ -z "$SEED_DEMO" ] && [ "$PRIOR_SEED" = "1" ]; then
    warn "the previous $ENV_FILE had SEED_DEMO=1; the demo dataset is now off unless you pass --seed-demo"
  fi
  [ -n "$HSTS" ]            || HSTS="$(env_get "$ENV_FILE" REGULAIT_HSTS)"
  [ -n "$SAML_ENTITY_ID" ]  || SAML_ENTITY_ID="$(env_get "$ENV_FILE" REGULAIT_SAML_ENTITY_ID)"
  [ -n "$SAML_CLOCK_SKEW" ] || SAML_CLOCK_SKEW="$(env_get "$ENV_FILE" REGULAIT_SAML_CLOCK_SKEW_MINUTES)"
  if [ -z "$TLS" ]; then
    case "$PRIOR_ISSUER" in
      "tls internal") TLS=internal ;;
      "") [ -n "$PRIOR_DOMAIN" ] && TLS=letsencrypt || TLS=none ;;
    esac
  fi
  [ -n "$ACME_EMAIL" ] || ACME_EMAIL="${PRIOR_EMAIL#email }"
fi

# ADR-0174 amendment: REGULAIT_DEMO_LICENSE=1 is the laptop demo's switch for
# an EPHEMERAL, self-minted demo licence. It has no place on an installed
# deployment, so it is refused here (from the environment or a demo .env this
# installer would otherwise overwrite), and the rendered override below pins it
# to "0" so a stray shell export cannot turn it on later either.
DEMO_LICENSE_ENV="${REGULAIT_DEMO_LICENSE:-}"
DEMO_LICENSE_PRIOR="$(env_get "$ENV_FILE" REGULAIT_DEMO_LICENSE)"
if { [ -n "$DEMO_LICENSE_ENV" ] && [ "$DEMO_LICENSE_ENV" != "0" ]; } \
  || { [ -n "$DEMO_LICENSE_PRIOR" ] && [ "$DEMO_LICENSE_PRIOR" != "0" ]; }; then
  die "REGULAIT_DEMO_LICENSE is set (environment or $ENV_FILE). That switch is for the laptop demo only (it mints a self-signed, NOT-production demo licence) and is never used on an install. Unset it — and remove it from that .env — then re-run."
fi

[ -n "$MODE" ] || prompt MODE "Deployment mode (hosted|byoc|air_gapped)" "byoc"
case "$MODE" in
  hosted|byoc|air_gapped) ;;
  *) die "--mode must be one of hosted|byoc|air_gapped (got '$MODE'). These are ADR-0015's three modes; there is no fourth." ;;
esac

[ -n "$DOMAIN" ] || prompt DOMAIN "Public hostname this deployment serves" ""

if [ -z "$TLS" ]; then
  case "$MODE" in
    air_gapped) TLS=internal ;;
    *) [ -n "$DOMAIN" ] && TLS=letsencrypt || TLS=none ;;
  esac
fi
case "$TLS" in
  letsencrypt|internal|none) ;;
  *) die "--tls must be one of letsencrypt|internal|none (got '$TLS')" ;;
esac

# ADR-0181 FX3: the demo dataset is OFF by default in EVERY mode, hosted
# included. Only an explicit --seed-demo turns it on (and the seed itself still
# refuses a database that has a real admin).
[ -n "$SEED_DEMO" ] || SEED_DEMO=0
case "$SEED_DEMO" in 0|1) ;; *) SEED_DEMO=0 ;; esac

if [ -z "$VERSION" ]; then
  VERSION="$(grep -m1 '"version"' "$REPO_ROOT/package.json" 2>/dev/null | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')"
  VERSION="${VERSION:-0.0.0}"
fi

info "mode:      $MODE"
info "domain:    ${DOMAIN:-<none — loopback only>}"
info "tls:       $TLS"
info "seed demo: $SEED_DEMO"
info "version:   $VERSION"
info "dir:       $INSTALL_DIR"

# --- mode-specific refusals -------------------------------------------------
if [ "$MODE" = "air_gapped" ]; then
  [ "$TLS" != "letsencrypt" ] || die \
"air_gapped + --tls letsencrypt is a contradiction: ACME issuance is an outbound
  call to Let's Encrypt and an inbound HTTP-01 challenge from the public
  internet. Use --tls internal (Caddy's own local CA — you distribute its root
  to clients) or --tls none (terminate TLS on your own proxy)."
  [ -z "$ACME_EMAIL" ] || die "air_gapped cannot use --acme-email; there is no ACME account to contact."
fi
if [ "$TLS" != "letsencrypt" ] && [ -n "$ACME_EMAIL" ]; then
  warn "--acme-email is only meaningful with --tls letsencrypt; ignoring it."
  ACME_EMAIL=""
fi
if [ "$TLS" != "none" ] && [ -z "$DOMAIN" ]; then
  die "--tls $TLS needs a --domain: Caddy's site address is the hostname it serves and (for letsencrypt) issues for."
fi
# ADR-0188 S7: engine runners and PDP clients take DPoP-bound self tokens whose issuer is
# REGULAIT_PUBLIC_URL; with it unset the token endpoint refuses (503) and none of them can
# authenticate. Behind Caddy the public origin is known; behind your own terminator only you
# know it, so it is left for you to set rather than guessed.
if [ -z "$PUBLIC_URL" ] && [ "$TLS" != "none" ] && [ -n "$DOMAIN" ]; then
  PUBLIC_URL="https://$DOMAIN"
fi
if [ -n "$PUBLIC_URL" ]; then
  # written into .env and compose: only an http(s) origin (optionally a plain base path) of safe characters.
  # The gateway applies the full rules at boot (https, or http on loopback only) and refuses anything else.
  # One trailing slash is normalised away (the gateway and the runners drop it too: parsePublicUrl).
  PUBLIC_URL="${PUBLIC_URL%/}"
  url_re='^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$'
  [[ "$PUBLIC_URL" =~ $url_re ]] || die "--public-url must be an http(s) origin with an optional plain base path (e.g. https://regulait.acme.example), got $(printf '%q' "$PUBLIC_URL")"
  url_host="${PUBLIC_URL#*://}"; url_host="${url_host%%/*}"; url_host="${url_host%%:*}"
  # a trailing-dot host names the same host under another origin string; the gateway refuses it at boot
  case "$url_host" in *.) die "--public-url must not end its host with a dot: $(printf '%q' "$PUBLIC_URL")" ;; esac
  # '.' and '..' path segments are refused as written, never normalised away (as the gateway does)
  url_rest="${PUBLIC_URL#*://}"; url_path=""
  case "$url_rest" in */*) url_path="/${url_rest#*/}" ;; esac
  case "$url_path/" in */./*|*/../*) die "--public-url must not contain '.' or '..' path segments: $(printf '%q' "$PUBLIC_URL")" ;; esac
fi
if [ -z "$PUBLIC_URL" ]; then
  warn "REGULAIT_PUBLIC_URL is not set: engine runners and PDP clients (the Kong adapter) cannot authenticate until it names this deployment's https origin. Add REGULAIT_PUBLIC_URL=https://<your host> to $ENV_FILE and re-run."
fi
if [ "$MODE" != "hosted" ] && [ "$SEED_DEMO" = "1" ]; then
  warn "SEED_DEMO=1 on a $MODE deployment will create demo users (dana/avery/admin) and demo API keys in a CUSTOMER database. This is almost never what you want."
fi

# ===========================================================================
# 2. THE DATA KEY — refuse to proceed on missing or weak
# ===========================================================================
step "REGULAIT_DATA_KEY"

if [ -n "$DATA_KEY" ]; then
  problem="$(data_key_problem "$DATA_KEY")"
  [ -z "$problem" ] || die \
"REGULAIT_DATA_KEY is unusable: $problem

  This key encrypts every stored credential (connector tokens, model API keys,
  TOTP secrets) with AES-256-GCM. A weak key is not a smaller problem than no
  key — it is the same problem with a false sense of coverage.

  Generate one with:  openssl rand -hex 32
  then pass it as --data-key, or unset it and let this installer generate one."
  DATA_KEY="$(printf '%s' "$DATA_KEY" | tr 'A-F' 'a-f')"
  ok "supplied key accepted (64 hex chars, passes the strength gate)"
else
  have openssl || die "no key supplied and openssl is not installed, so one cannot be generated. Install openssl, or pass --data-key \"\$(openssl rand -hex 32)\"."
  DATA_KEY="$(rand_hex32)"
  GENERATED_DATA_KEY=1
  SHOW_SECRETS=1
  cat <<BANNER

  ${C_YEL}${C_BLD}A NEW REGULAIT_DATA_KEY HAS BEEN GENERATED.${C_RST}

    ${C_BLD}$DATA_KEY${C_RST}

  ${C_YEL}RECORD THIS OUT-OF-BAND, NOW, SOMEWHERE THAT IS NOT THIS MACHINE.${C_RST}
  A password manager, an SSM Parameter Store SecureString under a different KMS
  key, an offline safe — anywhere whose failure is independent of this host's
  disk.

  Why it matters, precisely (ADR-0035 calls this the sharpest edge in the
  stack): your database backup contains every credential as ciphertext under
  this key and nothing else. Restoring that backup onto a NEW machine WITHOUT
  this key recovers every user, every audit row, every project — and leaves
  every connector token, model API key and TOTP secret PERMANENTLY
  undecryptable. There is no recovery path, no support escalation, no reset.
  They must all be re-entered by hand.

  The key is written to $ENV_FILE and nowhere else. That file is on the same
  disk as the database it protects, which is exactly why an out-of-band copy is
  not optional.

  ${C_BLD}Its fingerprint (ADR-0063) is:${C_RST}

    ${C_BLD}$(data_key_fingerprint "$DATA_KEY")${C_RST}

  That string is NOT secret — it is a truncated HMAC that identifies the key and
  reveals nothing about it. Record it beside the key. The gateway prints the same
  value at every boot, writes it into every backup's metadata, and REFUSES TO
  START if the key it is given does not match the one this deployment's data was
  encrypted under. So a restore onto a new box tells you immediately that you
  have the wrong key, instead of coming up healthy and failing every decryption
  a week later.

  Once you have stored the key somewhere that is not this machine, say so:
    Admin -> Settings -> Data key custody, or
    POST /v1/security/data-key/attestations

  Until somebody does, every backup run reports custody=UNATTESTED — because an
  unattested backup is a backup that may not be restorable.

BANNER
  if [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
    ack=""
    while [ "$ack" != "recorded" ]; do
      read -r -p "  Type 'recorded' once you have stored it out-of-band: " ack || die "aborted before the key was recorded"
    done
  else
    warn "non-interactive: the acknowledgement prompt was skipped. The key above is still yours to record."
  fi
fi

# ADR-0194: once the installer has retired the bootstrap token (the first admin exists), a re-run keeps it
# retired: no token is generated and none is written. Only an explicit --admin-token re-opens the door (a
# break-glass recovery the operator chose); a token merely exported in the shell is ignored.
if [ "${PRIOR_RETIRED:-}" = "1" ]; then
  if [ "$ADMIN_TOKEN_FLAG" = "1" ] && [ -n "$ADMIN_TOKEN" ]; then
    TOKEN_REOPENED=1
    warn "--admin-token re-opens the retired bootstrap token: a full-admin credential with no user identity. Retire it again by re-running this installer without --admin-token once you are done."
  else
    if [ -n "$ADMIN_TOKEN" ]; then
      warn "REGULAIT_BOOTSTRAP_TOKEN is set in the environment but this install retired the bootstrap token (ADR-0194); it is ignored. Pass --admin-token to re-open it on purpose."
    fi
    ADMIN_TOKEN=""
    BOOTSTRAP_RETIRED=1
  fi
fi
if [ "$BOOTSTRAP_RETIRED" = "1" ]; then
  ok "bootstrap token: retired (the first admin exists; ADR-0194)"
else
  [ -n "$ADMIN_TOKEN" ] || { ADMIN_TOKEN="$(rand_token)"; GENERATED_ADMIN_TOKEN=1; }
  if [ "$ADMIN_TOKEN" = "dev-bootstrap" ]; then
    die "REGULAIT_BOOTSTRAP_TOKEN is the published dev default 'dev-bootstrap'. That token authenticates as a full admin with no user identity (apps/gateway/src/auth.ts). Pass --admin-token, or drop it and one will be generated."
  fi
fi

# ADR-0194 — the first admin, non-interactive half: validated here so --check proves it.
# shellcheck source-path=SCRIPTDIR source=lib/first-admin.sh
. "$SCRIPT_DIR/lib/first-admin.sh"
FIRST_ADMIN_USERNAME="$(printf '%s' "${FIRST_ADMIN_USERNAME:-admin}" | tr '[:upper:]' '[:lower:]')"
if [ -n "$FIRST_ADMIN_PASSWORD_FILE" ]; then
  [ "$(uname -s)" = "Linux" ] || die "REGULAIT_FIRST_ADMIN_PASSWORD_FILE is supported on Linux only: run the installer interactively for the first admin."
  problem="$(fa_password_file_problem "$FIRST_ADMIN_PASSWORD_FILE")"
  [ -z "$problem" ] || die "REGULAIT_FIRST_ADMIN_PASSWORD_FILE: $problem"
  [ -n "$FIRST_ADMIN_EMAIL" ] || die "REGULAIT_FIRST_ADMIN_PASSWORD_FILE is set but REGULAIT_FIRST_ADMIN_EMAIL is not: the first admin needs an email."
  problem="$(fa_username_problem "$FIRST_ADMIN_USERNAME")"
  [ -z "$problem" ] || die "REGULAIT_FIRST_ADMIN_USERNAME: $problem"
  problem="$(fa_email_problem "$FIRST_ADMIN_EMAIL")"
  [ -z "$problem" ] || die "REGULAIT_FIRST_ADMIN_EMAIL: $problem"
  ok "first admin: from REGULAIT_FIRST_ADMIN_PASSWORD_FILE (mode checked; the password is never printed), username '$FIRST_ADMIN_USERNAME'"
elif [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
  ok "first admin: asked for interactively once the stack is up"
else
  info "first admin: non-interactive and no REGULAIT_FIRST_ADMIN_PASSWORD_FILE — the step will be skipped (manual path in the summary)"
fi

# The Postgres password is only honoured on FIRST initdb. If the volume already
# exists we must not invent a new one, or the gateway locks itself out of its
# own database on the next boot.
if [ -z "$DB_PASSWORD" ]; then
  if volume_exists pgdata; then
    DB_PASSWORD="regulait"
    warn "the ${PROJECT}_pgdata volume already exists and no password is recorded in .env, so the compose default ('regulait') is assumed. POSTGRES_PASSWORD only takes effect on first initdb — changing it now would lock the gateway out. To rotate it, ALTER USER inside the running database and then re-run with --db-password."
  else
    DB_PASSWORD="$(rand_token)"
    GENERATED_DB_PASSWORD=1
  fi
fi

# ADR-0189 R25 item 12 — THE RECEIPT SIGNING KEY. Without a key every sign-off is
# refused (409 bom_signing_unavailable). By default the install generates its own
# (the gateway's first boot, and the step after "Bringing the stack up"), on the
# install_secrets volume, mode 0600, never overwritten. --receipt-key-file /
# --receipt-key-id switch to a key the operator manages; the key itself is never
# read into this script, printed or copied — only mounted read-only.
step "Receipt signing key"
if [ -n "$RECEIPT_KEY_FILE" ] || [ -n "$RECEIPT_KEY_ID" ]; then
  [ -n "$RECEIPT_KEY_FILE" ] && [ -n "$RECEIPT_KEY_ID" ] || die "--receipt-key-file and --receipt-key-id go together: pass both (a key you manage) or neither (the install generates one)."
  # ALLOWLISTS, matched by bash on the WHOLE value (grep is line-based, so a value with an embedded
  # newline would pass on its first line). The path is written into a compose volume entry, where `$`
  # is interpolated and `:`, `#`, quotes, backslashes and newlines change the meaning; the key id is
  # written into the override's environment map.
  path_re='^/[A-Za-z0-9._/@+-]+$'
  [[ "$RECEIPT_KEY_FILE" =~ $path_re ]] || die "--receipt-key-file must be an absolute host path of A-Z a-z 0-9 . _ / @ + - only (it is written into a compose volume entry, where \$, :, #, quotes, backslashes, spaces and newlines are not safe): $(printf '%q' "$RECEIPT_KEY_FILE")"
  id_re='^[A-Za-z0-9._:-]{1,128}$'
  [[ "$RECEIPT_KEY_ID" =~ $id_re ]] || die "--receipt-key-id must be 1-128 characters of A-Z a-z 0-9 . _ : - (the gateway refuses anything else)."
  [ -f "$RECEIPT_KEY_FILE" ] || die "--receipt-key-file $RECEIPT_KEY_FILE is not a regular file on this host."
  if have openssl; then
    openssl pkey -in "$RECEIPT_KEY_FILE" -noout -text_pub 2>/dev/null | grep -q 'ED25519' \
      || die "--receipt-key-file $RECEIPT_KEY_FILE is not a readable PKCS#8 Ed25519 private key. Make one OFF this host with: openssl genpkey -algorithm ed25519 -out receipt-signing-key.pem"
  fi
  perm="$(stat -c '%a' "$RECEIPT_KEY_FILE" 2>/dev/null || true)"
  case "$perm" in
    ""|?00|600|400) ;;
    *) warn "$RECEIPT_KEY_FILE has mode $perm; a signing key should be 0600 (or 0400), owned by uid 1000 so the gateway's node user can read it" ;;
  esac
  owner="$(stat -c '%u' "$RECEIPT_KEY_FILE" 2>/dev/null || true)"
  if [ -n "$owner" ] && [ "$owner" != "1000" ]; then
    warn "$RECEIPT_KEY_FILE is owned by uid $owner, not 1000 (the gateway container's node user): at mode 0600 the gateway cannot read it, and the post-install check will fail. Fix: chown 1000:1000 $RECEIPT_KEY_FILE"
  fi
  ok "operator-managed receipt key: $RECEIPT_KEY_FILE (key id $RECEIPT_KEY_ID), mounted read-only at $RECEIPT_KEY_CONTAINER_PATH"
else
  ok "install-generated: the gateway creates one on first boot in the ${PROJECT}_install_secrets volume (never overwritten)"
fi

# ===========================================================================
# 3. PREFLIGHT
# ===========================================================================
step "Preflight"

have docker || die "docker is not on PATH. Install Docker Engine (or Docker Desktop) and re-run."
ok "docker: $(docker --version 2>/dev/null | head -1)"

if docker compose version >/dev/null 2>&1; then
  ok "compose: $(docker compose version --short 2>/dev/null || docker compose version | head -1)"
else
  die "\`docker compose\` (the v2 plugin) is not available. \`docker-compose\` v1 is NOT supported: this stack uses compose profiles, ipam ip_range pinning and \`pull_policy\`, none of which v1 understands."
fi

have openssl || warn "openssl is not installed — key generation and update-bundle verification both need it."

DAEMON_OK=0
if docker_up; then DAEMON_OK=1; ok "docker daemon reachable"; else
  if [ "$CHECK_ONLY" = "1" ]; then
    warn "docker daemon is NOT reachable — check mode continues (preflight + render only)"
  else
    die "the docker daemon is not reachable (\`docker info\` failed). Start it, or add this user to the docker group, and re-run. Re-run with --check to validate configuration without it."
  fi
fi

[ -f "$COMPOSE_FILE" ] || die "compose file not found at $COMPOSE_FILE — run this from a RegulAIt checkout (or an unpacked update bundle)."
ok "compose file: $COMPOSE_FILE"

# --- ports ------------------------------------------------------------------
PORTS="3000"
if [ "$TLS" != "none" ]; then PORTS="$PORTS 80 443"; fi
if stack_running; then
  info "the '$PROJECT' stack is already running; ports it already holds are not a conflict"
else
  probe_failed=0
  for p in $PORTS; do
    rc=0
    port_in_use "$p" || rc=$?
    case "$rc" in
      0) die "port $p is already in use by something that is not this stack. Free it, or move the conflicting service, and re-run." ;;
      2) probe_failed=1; break ;;
    esac
  done
  if [ "$probe_failed" = "1" ]; then
    warn "neither ss nor netstat is available — port availability was NOT checked"
  else
    ok "ports free: $PORTS"
  fi
fi

# --- disk -------------------------------------------------------------------
DISK_TARGET="$INSTALL_DIR"
if [ "$DAEMON_OK" = "1" ]; then
  d="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  if [ -n "$d" ] && [ -d "$d" ]; then DISK_TARGET="$d"; fi
fi
mkdir -p "$INSTALL_DIR"
AVAIL_KB="$(df -Pk "$DISK_TARGET" 2>/dev/null | awk 'NR==2 {print $4}')"
if [ -n "$AVAIL_KB" ]; then
  AVAIL_GB=$((AVAIL_KB / 1024 / 1024))
  if [ "$AVAIL_GB" -lt "$MIN_DISK_GB" ]; then
    die "only ${AVAIL_GB}GiB free on $DISK_TARGET; ${MIN_DISK_GB}GiB is the floor (image layers + the Postgres volume + a pg_dump working copy). Free space, or lower the bar with --min-disk-gb."
  fi
  ok "disk: ${AVAIL_GB}GiB free on $DISK_TARGET (floor ${MIN_DISK_GB}GiB)"
else
  warn "could not measure free space on $DISK_TARGET"
fi

# --- air-gapped image preflight --------------------------------------------
GATEWAY_IMAGE=""
if [ "$MODE" = "air_gapped" ]; then
  GATEWAY_IMAGE="regulait/gateway:$VERSION"
  if [ -n "$IMAGE_BUNDLE" ]; then
    [ -f "$IMAGE_BUNDLE" ] || die "--image-bundle $IMAGE_BUNDLE does not exist"
    ok "image bundle: $IMAGE_BUNDLE ($(du -h "$IMAGE_BUNDLE" 2>/dev/null | cut -f1))"
  fi
  if [ "$DAEMON_OK" = "1" ] && [ -z "$IMAGE_BUNDLE" ]; then
    missing=""
    # air-gapped runs the Caddy TAG (see CADDY_IMAGE_IDS), and only when its image id is a pinned one
    for img in "$GATEWAY_IMAGE" postgres:16 "$CADDY_TAG"; do
      image_present "$img" || missing="$missing $img"
    done
    if image_present "$CADDY_TAG" && ! caddy_image_id_ok; then
      missing="$missing $CADDY_TAG(image-id-not-pinned)"
    fi
    # In --check mode this is a finding, not a refusal: the point of check mode
    # is to exercise preflight + render, and an operator planning an air-gapped
    # install on a connected workstation legitimately has no images yet.
    if [ -n "$missing" ] && [ "$CHECK_ONLY" = "1" ]; then
      warn "air_gapped: these images are NOT present locally and would make a real install fail:$missing"
      warn "build them on a connected host with scripts/build-image-bundle.sh --version $VERSION"
      missing=""
      IMAGES_INCOMPLETE=1
    fi
    [ -z "$missing" ] || die \
"air_gapped mode cannot pull or build. Missing local images:$missing

  On a CONNECTED host run:
      scripts/build-image-bundle.sh --version $VERSION --out regulait-images-$VERSION.tar
  carry the tarball across the boundary, then re-run this installer with:
      --image-bundle /path/to/regulait-images-$VERSION.tar

  (\`docker compose up --build\` is not an option here: the build pulls
   node:22-trixie-slim and runs \`pnpm install\` against the npm registry. That is
   internet, and this mode does not have any.)"
    if [ "${IMAGES_INCOMPLETE:-0}" = "0" ]; then ok "all required images present locally"; fi
  fi
fi

# ===========================================================================
# 4. RENDER
#
# Deterministic by construction — no timestamps, no ordering surprises — so
# `install.sh --check` twice and `diff` is a real idempotency proof.
# ===========================================================================
step "Render"

case "$TLS" in
  letsencrypt) TLS_ISSUER="" ;;
  internal)    TLS_ISSUER="tls internal" ;;
  none)        TLS_ISSUER="" ;;
esac
TLS_EMAIL_DIRECTIVE=""
if [ -n "$ACME_EMAIL" ]; then TLS_EMAIL_DIRECTIVE="email $ACME_EMAIL"; fi

render_env() {
  cat <<ENV
# RegulAIt deployment configuration — RENDERED by scripts/install.sh (ADR-0041).
#
# Re-running the installer regenerates this file deterministically and
# PRESERVES every secret already in it. Hand-edits survive only if you also
# pass the matching flag on the next run, so prefer flags.
#
# Compose loads this file automatically from the project directory.

# ---- deployment identity ---------------------------------------------------
# REGULAIT_DEPLOY_MODE records what this host was installed as, and since
# ADR-0062 (2026-08-03) THE GATEWAY READS IT. (It used to be installer-level
# metadata only, and this comment used to say so.)
#
# It is distinct from ADR-0015's per-target mode, which stays a column on the
# deploy_targets ROW: that is "where does THIS deploy land", this is "what shape
# is THIS INSTALLATION". On `air_gapped` the gateway refuses any model,
# connector, git or PM adapter that would run on its COMPILED vendor endpoint
# unless that host is in the egress allow-list; `hosted` and `byoc` keep the
# pre-0062 behaviour. org_settings may tighten this and can never loosen it.
# A malformed value throws at boot rather than degrading to `hosted`, and the
# effective posture is printed in the boot log.
REGULAIT_DEPLOY_MODE=$MODE
REGULAIT_VERSION=$VERSION
COMPOSE_PROJECT_NAME=$PROJECT

# ---- secrets (treat this whole file as a secret) ---------------------------
# REGULAIT_DATA_KEY: AES-256-GCM key for every stored credential. Losing it
# makes every credential ciphertext permanently undecryptable — see
# docs/deployment/BACKUP_RESTORE.md. KEEP AN OUT-OF-BAND COPY.
# ADR-0063: its non-secret fingerprint is $(data_key_fingerprint "$DATA_KEY").
# The gateway records that value and REFUSES TO START under a different key.
# A deliberate rotation is declared with REGULAIT_DATA_KEY_ROTATED_FROM=<old fp>
# (single-use; remove it once consumed). Nothing re-encrypts existing ciphertext.
REGULAIT_DATA_KEY=$DATA_KEY
ENV
  if [ "$BOOTSTRAP_RETIRED" = "1" ]; then
    cat <<'ENV'
# REGULAIT_BOOTSTRAP_TOKEN was RETIRED by the installer once the first admin
# existed (ADR-0194). compose.install.yml pins it to the empty string (absent
# here, docker-compose.yml would fall back to its published dev default, which
# the gateway refuses). Re-open it deliberately with --admin-token.
REGULAIT_BOOTSTRAP_RETIRED=1
ENV
  else
    cat <<ENV
# Authenticates as a full admin with no user identity. It exists to create the
# first real admin; the installer retires it (removes it from this file and
# restarts the gateway) as soon as an admin exists (ADR-0194).
REGULAIT_BOOTSTRAP_TOKEN=$ADMIN_TOKEN
ENV
  fi
  cat <<ENV
REGULAIT_DB_PASSWORD=$DB_PASSWORD
REGULAIT_DATABASE_URL=postgres://regulait:$DB_PASSWORD@db:5432/regulait
ENV
  # ADR-0189 R25 item 12: the receipt signing key. Absent = install-generated
  # (the gateway creates it in the install_secrets volume on first boot).
  if [ -n "$RECEIPT_KEY_FILE" ]; then
    cat <<ENV

# ---- receipt signing key: OPERATOR-MANAGED (ADR-0189 R25) ------------------
# Installer settings, read back on every re-run. compose.install.yml mounts the
# host file read-only at $RECEIPT_KEY_CONTAINER_PATH and sets
# REGULAIT_RECEIPT_SIGNING_KEY / _ID for the gateway. Remove these two lines
# and re-run without --receipt-key-file to go back to the install-generated key.
REGULAIT_RECEIPT_KEY_HOST_FILE=$RECEIPT_KEY_FILE
REGULAIT_RECEIPT_KEY_HOST_ID=$RECEIPT_KEY_ID
ENV
  fi
  cat <<ENV

# ---- application -----------------------------------------------------------
SEED_DEMO=$SEED_DEMO
ENV
  # ADR-0188 S7: the issuer of every workload self token (and the passkey relying party,
  # ADR-0121); written only when known, because an empty value is not a URL
  if [ -n "$PUBLIC_URL" ]; then
    printf 'REGULAIT_PUBLIC_URL=%s\n' "$PUBLIC_URL"
  fi
  cat <<ENV
# ADR-0031: the ONLY peer allowed to speak for the client via X-Forwarded-*.
# This is Caddy's pinned compose address and nothing else. If you terminate TLS
# on your own proxy instead, set this to that proxy's address — and never to a
# range that includes anything else.
REGULAIT_TRUSTED_PROXIES=172.28.0.2

# ---- TLS (ADR-0029) --------------------------------------------------------
# REGULAIT_TLS_ISSUER empty  => Caddy's automatic HTTPS (Let's Encrypt).
# REGULAIT_TLS_ISSUER="tls internal" => Caddy's own local CA, zero outbound.
REGULAIT_TLS_HOST=$DOMAIN
REGULAIT_TLS_ISSUER=$TLS_ISSUER
REGULAIT_TLS_EMAIL_DIRECTIVE=$TLS_EMAIL_DIRECTIVE
REGULAIT_TLS_UPSTREAM=gateway:3000

# ---- identity --------------------------------------------------------------
# INFORMATIONAL ONLY — no gateway code reads this. OIDC/SAML providers are
# database rows created through the admin API; the post-install summary prints
# the exact call. Recorded here so an operator can see what this deployment was
# installed against.
REGULAIT_OIDC_ISSUER=$OIDC_ISSUER
ENV

  # ---- the three "unset != empty" variables -------------------------------
  # These are written ONLY when an operator chose a value, and they are fed to
  # the container through a MAP-form override entry rather than a list-form
  # pass-through, because for each of them the empty string is a real, distinct
  # setting that must never be reached by accident:
  #   REGULAIT_HSTS=""                  -> NO HSTS header at all (hsts.ts),
  #                                        whereas unset -> max-age=86400.
  #   REGULAIT_SAML_CLOCK_SKEW_MINUTES  -> "" is not 2.
  # Getting that backwards would silently turn a security header off.
  if [ -n "$HSTS" ] || [ -n "$SAML_ENTITY_ID" ] || [ -n "$SAML_CLOCK_SKEW" ]; then
    printf '\n# ---- explicitly chosen (absent = the gateway default) ----------------------\n'
    [ -z "$HSTS" ]            || printf 'REGULAIT_HSTS=%s\n' "$HSTS"
    [ -z "$SAML_ENTITY_ID" ]  || printf 'REGULAIT_SAML_ENTITY_ID=%s\n' "$SAML_ENTITY_ID"
    [ -z "$SAML_CLOCK_SKEW" ] || printf 'REGULAIT_SAML_CLOCK_SKEW_MINUTES=%s\n' "$SAML_CLOCK_SKEW"
  fi
}

render_override() {
  cat <<'YML'
# GENERATED by scripts/install.sh — compose override for a productised install.
# Regenerated on every run; edit the .env or re-run the installer, not this.
#
# It carries exactly two things the base docker-compose.yml cannot:
#
#  (a) VARIABLES WHOSE UNSET STATE MATTERS. `${VAR:-}` in the base file would
#      set the variable to the EMPTY STRING, and for REGULAIT_HSTS the empty
#      string means "send no HSTS header at all" while unset means the
#      gateway's bounded max-age=86400 default (apps/gateway/src/hsts.ts).
#      Those are different deployments. So each such variable is written here
#      as an explicit map entry ONLY when the operator chose a value, and is
#      absent from this file entirely otherwise.
#
#  (b) Air-gapped image pinning.
#
# Provider API keys, by contrast, are `${VAR:-}` pass-throughs: every place
# they are read tests `v && v.length > 0` (agents-connectors.ts `firstSet`,
# org-settings.ts `envKeyPresence`), so an empty string is indistinguishable
# from absent and the operator can export them at run time without
# re-rendering. That equivalence was checked, not assumed.
#
# READ docs/deployment/DATA_BOUNDARY.md §4 before setting any of them on an
# air-gapped deployment: a built-in provider with no baseUrl override is not
# behind the egress guard.
#
# REGULAIT_DEMO_LICENSE is pinned to "0": the laptop demo's self-minted licence
# (ADR-0174 amendment) is never switched on for an installed deployment, not
# even by a stray shell export at `docker compose up` time.
services:
  gateway:
    environment:
      REGULAIT_DEMO_LICENSE: "0"
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      ANTHROPIC_BASE_URL: ${ANTHROPIC_BASE_URL:-}
      OPENAI_API_KEY: ${OPENAI_API_KEY:-}
      OPENAI_BASE_URL: ${OPENAI_BASE_URL:-}
      GOOGLE_API_KEY: ${GOOGLE_API_KEY:-}
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
      XAI_API_KEY: ${XAI_API_KEY:-}
YML
  [ -z "$HSTS" ]            || printf '      REGULAIT_HSTS: "%s"\n' "$HSTS"
  [ -z "$SAML_ENTITY_ID" ]  || printf '      REGULAIT_SAML_ENTITY_ID: "%s"\n' "$SAML_ENTITY_ID"
  [ -z "$SAML_CLOCK_SKEW" ] || printf '      REGULAIT_SAML_CLOCK_SKEW_MINUTES: "%s"\n' "$SAML_CLOCK_SKEW"
  if [ "$BOOTSTRAP_RETIRED" = "1" ]; then
    # ADR-0194: the retired bootstrap token is pinned EMPTY (= no bootstrap credential). Leaving it unset
    # would let docker-compose.yml's `${REGULAIT_BOOTSTRAP_TOKEN:-dev-bootstrap}` default back in.
    printf '      REGULAIT_BOOTSTRAP_TOKEN: ""\n'
  fi
  if [ -n "$RECEIPT_KEY_FILE" ]; then
    # ADR-0189 R25 item 12: the operator-managed receipt key, read-only. Both values passed the
    # allowlists above, so neither can break out of its quotes or be interpolated by compose.
    printf '      REGULAIT_RECEIPT_SIGNING_KEY: "%s"\n' "$RECEIPT_KEY_CONTAINER_PATH"
    printf '      REGULAIT_RECEIPT_SIGNING_KEY_ID: "%s"\n' "$RECEIPT_KEY_ID"
    printf '    volumes:\n      - "%s:%s:ro"\n' "$RECEIPT_KEY_FILE" "$RECEIPT_KEY_CONTAINER_PATH"
  fi
  if [ "$MODE" = "air_gapped" ]; then
    cat <<YML
    # AIR-GAPPED: run the pre-seeded image, never pull, never build.
    image: $GATEWAY_IMAGE
    pull_policy: never
  # the bundle's plain tag: docker-compose.yml's digest reference does not survive docker save/load
  db:
    image: postgres:16
    pull_policy: never
  caddy:
    image: $CADDY_TAG
    pull_policy: never
  executor-front:
    image: $CADDY_TAG
    pull_policy: never
  executor-front-ca:
    image: $CADDY_TAG
    pull_policy: never
  # ENG-IMG: the engine runners (profile engines) run the bundle's fixed tags; the task images are the same images,
  # which the executor starts by image id. Without a bundle that carries them (--with-engines), nothing is found.
  engine-promptfoo:
    image: regulait/engine-promptfoo:bundled
    pull_policy: never
  engine-modelscan:
    image: regulait/engine-modelscan:bundled
    pull_policy: never
  engine-garak:
    image: regulait/engine-garak:bundled
    pull_policy: never
YML
  fi
}

write_if_changed() { # path, content-on-stdin
  local path="$1" tmp
  tmp="$(mktemp "${path}.XXXXXX")"
  cat >"$tmp"
  if [ -f "$path" ] && cmp -s "$tmp" "$path"; then
    rm -f "$tmp"
    ok "$(basename "$path") unchanged"
  else
    chmod 600 "$tmp"
    mv -f "$tmp" "$path"
    ok "$(basename "$path") written"
  fi
}

render_env      | write_if_changed "$ENV_FILE"
render_override | write_if_changed "$OVERRIDE_FILE"
chmod 644 "$OVERRIDE_FILE"
printf '%s\n' "$VERSION" | write_if_changed "$VERSION_FILE"
chmod 644 "$VERSION_FILE"

COMPOSE_ARGS=(-p "$PROJECT" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" --env-file "$ENV_FILE" --project-directory "$REPO_ROOT")
if [ "$TLS" != "none" ]; then COMPOSE_ARGS+=(--profile tls); fi

if [ "$DAEMON_OK" = "1" ]; then
  if docker compose "${COMPOSE_ARGS[@]}" config >/dev/null 2>"$INSTALL_DIR/.compose-config.err"; then
    ok "compose configuration validates"
  else
    warn "compose config reported: $(head -3 "$INSTALL_DIR/.compose-config.err" | tr '\n' ' ')"
  fi
  rm -f "$INSTALL_DIR/.compose-config.err"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  step "CHECK MODE — preflight and render completed, no containers touched"
  info "rendered: $ENV_FILE"
  info "rendered: $OVERRIDE_FILE"
  info "rendered: $VERSION_FILE"
  info "would run: docker compose ${COMPOSE_ARGS[*]} up -d"
  info "then: the first-admin step (ADR-0194), and retire the bootstrap token once an admin exists"
  exit 0
fi

# ===========================================================================
# 5. BRING UP
# ===========================================================================
if [ -n "$IMAGE_BUNDLE" ]; then
  step "Loading pre-seeded images (air-gapped path — nothing is pulled)"
  docker load -i "$IMAGE_BUNDLE"
  ok "images loaded"
  if [ "$MODE" = "air_gapped" ]; then
    caddy_image_id_ok || die "the bundle's $CADDY_TAG is missing or is not the pinned image (allowed ids: $CADDY_IMAGE_IDS)"
    ok "$CADDY_TAG is the pinned image"
    for engine in $ENGINE_IDS; do
      image_present "regulait/engine-$engine:bundled" || continue
      engine_bundled_id_ok "$engine" || die "the bundle's regulait/engine-$engine:bundled is not the image engines/images.lock.json records for $engine"
      engine_signature_ok "$engine" || die "regulait/engine-$engine:bundled has no signature that verifies (engines/signatures/$engine.sigstore.json, cosign v3.1.3 on PATH or in COSIGN): an unsigned or unverified engine image is never run"
      ok "regulait/engine-$engine:bundled is the locked image, signed by the publish workflow on main"
    done
  fi
fi

step "Bringing the stack up"
if [ "$MODE" = "air_gapped" ]; then
  # No --build and no --pull: both reach the internet.
  docker compose "${COMPOSE_ARGS[@]}" up -d --no-build
else
  docker compose "${COMPOSE_ARGS[@]}" up -d --build
fi
ok "compose up completed"

step "Waiting for the gateway to answer"
if have curl; then
  HEALTH_OK=0
  for _ in $(seq 1 60); do
    if curl -sf -m 3 "http://127.0.0.1:3000/health" >/dev/null 2>&1 \
       || curl -s -m 3 -o /dev/null "http://127.0.0.1:3000/" 2>/dev/null; then
      HEALTH_OK=1; break
    fi
    sleep 2
  done
  if [ "$HEALTH_OK" = "1" ]; then
    ok "gateway is answering on 127.0.0.1:3000"
  else
    warn "the gateway did not answer within 120s. Check: docker compose -p $PROJECT logs gateway"
  fi
else
  warn "curl is not installed — skipping the readiness probe. Check: docker compose -p $PROJECT ps"
fi

# ADR-0189 R25 item 12: the installer's half of the install-generated receipt key.
# The gateway's first boot normally made it already; this runs the SAME idempotent,
# create-exclusive generator (it reuses an existing key, never overwrites one, and
# does nothing for an operator-managed key) and prints the key id and public-key
# fingerprint only, never the key.
step "Receipt signing key (install-generated unless you passed --receipt-key-file)"
RECEIPT_KEY_LINE=""
RECEIPT_KEY_RC=0
RECEIPT_KEY_LINE="$(docker compose "${COMPOSE_ARGS[@]}" exec -T gateway node apps/gateway/dist/receipt-key-init.js 2>&1)" || RECEIPT_KEY_RC=$?
case "$RECEIPT_KEY_RC:$RECEIPT_KEY_LINE" in
  0:*) ok "$RECEIPT_KEY_LINE" ;;
  1:*"receipt signing key: "*)
    # the gateway resolved the key exactly as a signer does and cannot use it: every sign-off would
    # answer 503 receipt_signing_key_invalid (an operator key it cannot read, a wrong path, half a
    # configuration) or 409 (generation failed). Refuse to call this install finished.
    die "$RECEIPT_KEY_LINE

  Every sign-off is refused until this is fixed. For an operator-managed key: the file must be a
  PKCS#8 Ed25519 key readable by uid 1000 inside the container (chown 1000:1000, chmod 600), and
  --receipt-key-file / --receipt-key-id go together. Then re-run this installer." ;;
  2:*"receipt signing key: "*)
    # #353 follow-up: exit 2 = the gateway has no REGULAIT_INSTALL_SECRETS_DIR and no operator key, so there
    # is nowhere to keep an install-generated key and every sign-off would be refused. The compose files an
    # install runs always set that directory, so this is a broken install, not a choice: refuse it.
    die "$RECEIPT_KEY_LINE

  The gateway container has no install secrets directory (REGULAIT_INSTALL_SECRETS_DIR) and no
  operator-managed key, so no receipt signing key can exist and every sign-off is refused. Check that
  the compose files this installer wrote are the ones in use, or pass --receipt-key-file and
  --receipt-key-id. Then re-run this installer." ;;
  *)
    warn "${RECEIPT_KEY_LINE:-the gateway could not be reached to check the receipt key}"
    warn "until a usable receipt signing key exists every sign-off is refused. Check: docker compose -p $PROJECT logs gateway | grep 'receipt key'" ;;
esac

# ADR-0188 S7: the installer's half of the install-generated identity ISSUER key, the
# receipt key's twin. Engine runners and PDP clients authenticate with DPoP-bound self
# tokens the issuer signs (their bearer tokens are retired), so with no issuer key none
# of them could ever authenticate. Same generator as the gateway's first boot: it reuses
# an existing key, never overwrites one, does nothing for an operator-managed
# REGULAIT_IDENTITY_SIGNING_KEY, and prints key ids (public thumbprints) only.
step "Identity issuer key (install-generated unless REGULAIT_IDENTITY_SIGNING_KEY is set)"
IDENTITY_KEY_LINE=""
IDENTITY_KEY_RC=0
IDENTITY_KEY_LINE="$(docker compose "${COMPOSE_ARGS[@]}" exec -T gateway node apps/gateway/dist/identity-key-init.js 2>&1)" || IDENTITY_KEY_RC=$?
case "$IDENTITY_KEY_RC:$IDENTITY_KEY_LINE" in
  0:*) ok "$IDENTITY_KEY_LINE" ;;
  [12]:*"identity issuer key: "*)
    die "$IDENTITY_KEY_LINE

  No workload token can be issued until this is fixed: engine runners and PDP clients cannot
  authenticate. The install-generated key lives in the install secrets volume (mode 0600, owned
  by uid 1000) and is never overwritten. Then re-run this installer." ;;
  *)
    warn "${IDENTITY_KEY_LINE:-the gateway could not be reached to check the issuer key}"
    warn "until a usable issuer key exists no engine runner or PDP client can authenticate. Check: docker compose -p $PROJECT logs gateway | grep 'issuer key'" ;;
esac

# ===========================================================================
# 5b. THE FIRST ADMIN, THEN THE BOOTSTRAP TOKEN IS RETIRED (ADR-0194)
#
# Created THROUGH THE GATEWAY (first-admin.js in its container: the same
# validators, policy check, seat gate and audit rows as the HTTP path), with
# the password on the runner's stdin only. Re-running on a deployment that
# already has an admin changes nothing here, and retires a token still live.
# ===========================================================================
step "First admin (ADR-0194)"
first_admin_exec() {
  docker compose "${COMPOSE_ARGS[@]}" exec -T gateway node apps/gateway/dist/first-admin.js "$@"
}
FIRST_ADMIN_STATE="skipped"   # created | exists | skipped | failed
FIRST_ADMIN_NAME=""
FIRST_ADMIN_DEMO_ONLY=0       # 1 when every admin is a demo seed persona (first-admin.js --status says so)
FA_STATUS_RC=0
FA_STATUS_LINE="$(first_admin_exec --status </dev/null 2>&1)" || FA_STATUS_RC=$?
case "$FA_STATUS_RC" in
  3)
    ok "an active admin already exists — skipped, nothing changed"
    case "$FA_STATUS_LINE" in *"only the demo seed's personas are admins"*) FIRST_ADMIN_DEMO_ONLY=1 ;; esac
    FIRST_ADMIN_STATE="exists" ;;
  0)
    if [ -n "$FIRST_ADMIN_PASSWORD_FILE" ]; then
      FA_USERNAME="$FIRST_ADMIN_USERNAME"
      FA_EMAIL="$FIRST_ADMIN_EMAIL"
      FA_RC=0
      first_admin_from_file "$FIRST_ADMIN_PASSWORD_FILE" || FA_RC=$?
      case "$FA_RC" in
        0) ok "$FA_OUTPUT"; FIRST_ADMIN_STATE="created"; FIRST_ADMIN_NAME="$FA_USERNAME" ;;
        3) ok "$FA_OUTPUT"; FIRST_ADMIN_STATE="exists" ;;
        *) die "the first admin was NOT created (exit $FA_RC):
  $FA_OUTPUT

  Nothing was changed and the bootstrap token is still in $ENV_FILE. Fix the
  input (REGULAIT_FIRST_ADMIN_PASSWORD_FILE / _USERNAME / _EMAIL) and re-run." ;;
      esac
    elif [ "$ASSUME_YES" != "1" ] && [ -t 0 ]; then
      create_now=""
      read -r -p "  Create the first admin now? [Y/n]: " create_now || create_now="n"
      case "$create_now" in
        n|N|no|NO) info "skipped at your request — the manual path is in the summary below" ;;
        *)
          info "the password is checked against the org policy (12+ characters, 3 of: lowercase, uppercase, digits, symbols, by default)"
          FA_RC=0
          first_admin_interactive || FA_RC=$?
          case "$FA_RC" in
            0) FIRST_ADMIN_STATE="created"; FIRST_ADMIN_NAME="$FA_USERNAME" ;;
            3) FIRST_ADMIN_STATE="exists" ;;
            *) warn "the first admin was not created; the bootstrap token stays until one exists (manual path in the summary)"
               FIRST_ADMIN_STATE="failed" ;;
          esac ;;
      esac
    else
      info "non-interactive and no REGULAIT_FIRST_ADMIN_PASSWORD_FILE — skipped (manual path in the summary)"
    fi ;;
  *)
    warn "${FA_STATUS_LINE:-the gateway could not be reached to check for an admin}"
    warn "the first-admin step did not run; the bootstrap token stays until an admin exists (manual path in the summary)"
    FIRST_ADMIN_STATE="failed" ;;
esac

# Retire the bootstrap token once an admin exists — unless the operator re-opened it on purpose this run.
TOKEN_RETIRED_NOW=0
if { [ "$FIRST_ADMIN_STATE" = "created" ] || [ "$FIRST_ADMIN_STATE" = "exists" ]; } \
   && [ "$BOOTSTRAP_RETIRED" != "1" ] && [ "$TOKEN_REOPENED" != "1" ]; then
  BOOTSTRAP_RETIRED=1
  ADMIN_TOKEN=""
  render_env      | write_if_changed "$ENV_FILE"
  render_override | write_if_changed "$OVERRIDE_FILE"
  chmod 644 "$OVERRIDE_FILE"
  docker compose "${COMPOSE_ARGS[@]}" up -d --no-build || die "restarting the gateway to retire the bootstrap token FAILED.
  $ENV_FILE and $OVERRIDE_FILE already say the token is retired, but the RUNNING
  gateway still accepts the old token. Fix the cause (docker compose -p $PROJECT logs gateway)
  and re-run this installer: it converges and restarts the gateway."
  TOKEN_RETIRED_NOW=1
  ok "bootstrap token retired: removed from $(basename "$ENV_FILE"), pinned empty in $(basename "$OVERRIDE_FILE"), gateway restarted"
fi

# ===========================================================================
# 6. POST-INSTALL SUMMARY
# ===========================================================================
if [ "$TLS" = "none" ]; then
  URL="http://127.0.0.1:3000/ui   (loopback only — put your own TLS terminator in front)"
  API="http://127.0.0.1:3000"
else
  URL="https://$DOMAIN/ui"
  API="https://$DOMAIN"
fi

cat <<SUMMARY

${C_BLD}=============================================================================
 RegulAIt is installed — $MODE, version $VERSION
=============================================================================${C_RST}

  ${C_BLD}URL${C_RST}          $URL
SUMMARY
if [ "$TLS" = "internal" ]; then cat <<'SUMMARY'
               TLS is served from Caddy's OWN local CA. Browsers will warn
               until you distribute that root certificate to your clients:
                 docker compose -p regulait cp caddy:/data/caddy/pki/authorities/local/root.crt ./regulait-root.crt
SUMMARY
fi

case "$FIRST_ADMIN_STATE" in
  created|exists)
    if [ "$FIRST_ADMIN_STATE" = "created" ]; then
      FA_HEADLINE="Created: '$FIRST_ADMIN_NAME'. Sign in at the URL above with the password you chose.
    The first sign-in enrols an authenticator app (MFA is required for admins)."
    elif [ "$SEED_DEMO" = "1" ] && [ "$FIRST_ADMIN_DEMO_ONLY" = "1" ]; then
      # --seed-demo: the demo seed made its personas first, so the demo admin IS the existing admin
      FA_HEADLINE="The demo dataset is loaded (--seed-demo), so its personas are the admins
    (admin@regulait.local) and you were not asked for one. Their one-time passwords are
    printed once in the gateway log (docker compose -p $PROJECT logs gateway). To use your
    own account, sign in as the demo admin, create your admin under Admin -> Users, then
    deactivate the demo personas. With the token retired, the demo seed that re-runs at
    each gateway start can no longer act and logs a failure; the loaded data stays."
    elif [ "$SEED_DEMO" = "1" ]; then
      # a real admin existed, so the demo seed's guard (seed-demo-guard.ts) refused: nothing was loaded
      FA_HEADLINE="An admin of your own already exists, so --seed-demo loaded nothing: the demo seed
    never touches a database with a real admin (the refusal is in docker compose -p $PROJECT logs gateway).
    This run did not change any account."
    else
      FA_HEADLINE="An admin already exists; this run did not change any account."
    fi
    # created|exists always retires the token above (or dies trying) unless --admin-token re-opened it
    if [ "$TOKEN_REOPENED" = "1" ]; then
      FA_TOKEN_LINE="The bootstrap token is OPEN: you re-opened it with --admin-token. Re-run without
    --admin-token to retire it again."
    elif [ "$TOKEN_RETIRED_NOW" = "1" ]; then
      FA_TOKEN_LINE="The bootstrap token is retired: removed from $ENV_FILE, gateway restarted."
    else
      FA_TOKEN_LINE="The bootstrap token is retired."
    fi
    cat <<SUMMARY

  ${C_BLD}FIRST ADMIN${C_RST}
    $FA_HEADLINE
    $FA_TOKEN_LINE
    To turn this account off later: deactivate it once another admin exists, or
    after SSO is set up make email sign-in break_glass_only or sso_only (Admin -> SSO).
SUMMARY
    ;;
  *)
    if [ "$BOOTSTRAP_RETIRED" = "1" ]; then
      # retired earlier, yet no active admin now: there is no live token to print
      cat <<SUMMARY

  ${C_BLD}FIRST ADMIN${C_RST} — none active, and the bootstrap token is retired
    Re-run this installer in a terminal to be asked for an admin, or
    non-interactively with REGULAIT_FIRST_ADMIN_PASSWORD_FILE (a 0600 file) and
    REGULAIT_FIRST_ADMIN_EMAIL set. To use the manual path instead, re-open the
    token on purpose: re-run with --admin-token "\$(openssl rand -hex 24)".
SUMMARY
    else
    cat <<SUMMARY

  ${C_BLD}FIRST ADMIN${C_RST} — not created by this run
    Re-run this installer in a terminal to be asked for it, or non-interactively
    with REGULAIT_FIRST_ADMIN_PASSWORD_FILE (a 0600 file) and
    REGULAIT_FIRST_ADMIN_EMAIL set. The manual fallback, with the bootstrap
    token (an admin with no user identity):

      curl -sS $API/v1/users \\
        -H "Authorization: Bearer $ADMIN_TOKEN" \\
        -H 'Content-Type: application/json' \\
        -d '{"email":"admin@your.org","displayName":"Admin","isAdmin":true}'

    then issue that user a one-time password (POST /v1/users/<id>/set-initial-password)
    and RE-RUN THIS INSTALLER: it sees the admin and retires the bootstrap token.
SUMMARY
    fi
    ;;
esac

if [ -n "$OIDC_ISSUER" ]; then
cat <<SUMMARY

  ${C_BLD}OIDC${C_RST}
    Your issuer was recorded but NOT auto-configured — providers are database
    rows, and ADR-0043 puts the issuer URL behind the egress guard, so the host
    needs an allow-list entry FIRST or discovery is refused (that refusal is the
    guard working, not a bug):

      curl -sS $API/v1/egress/hosts -H "Authorization: Bearer <admin key>" \\
        -H 'Content-Type: application/json' \\
        -d '{"host":"$(printf '%s' "$OIDC_ISSUER" | sed -E 's#^[a-z]+://##; s#[:/].*##')","note":"OIDC issuer"}'
      curl -sS $API/v1/auth/oidc/providers -H "Authorization: Bearer <admin key>" \\
        -H 'Content-Type: application/json' \\
        -d '{"issuerUrl":"$OIDC_ISSUER","clientId":"...","clientSecret":"..."}'
SUMMARY
fi

cat <<SUMMARY

  ${C_BLD}RECORD OUT-OF-BAND (not on this machine)${C_RST}
    * REGULAIT_DATA_KEY  — without it a restore onto a new host leaves EVERY
                           stored credential permanently undecryptable.
                           Fingerprint (not secret, record it alongside):
                           $(data_key_fingerprint "$DATA_KEY")
                           Then attest it: Admin -> Settings -> Data key custody.
SUMMARY
if [ "$SHOW_SECRETS" = "1" ]; then printf '                           %s\n' "$DATA_KEY"; fi
if [ "$BOOTSTRAP_RETIRED" != "1" ]; then
  printf '    * REGULAIT_BOOTSTRAP_TOKEN — until the first admin exists (the installer then retires it).\n'
fi
cat <<SUMMARY
    * REGULAIT_DB_PASSWORD — it is only settable at first initdb.

  ${C_BLD}BACK UP${C_RST}
    * The Postgres data (docker volume ${PROJECT}_pgdata) — see
      docs/deployment/BACKUP_RESTORE.md and ADR-0035 for the verified
      nightly pg_dump.
    * $ENV_FILE (it holds the data key).
    * The ${PROJECT}_install_secrets volume: the install-generated receipt
      signing key. Losing it is recoverable (the next boot makes a new key
      under a new key id; signed receipts stay verifiable through
      GET /v1/receipts/keys), but back it up with pgdata.
    * NOT backed up by anything today: the ${PROJECT}_caddy_data volume, which
      holds the ACME account key and issued certificates. Losing it re-issues,
      which is cheap but rate-limited.

  ${C_BLD}WHAT LEAVES THIS BOX${C_RST}
    Read docs/deployment/DATA_BOUNDARY.md. In air_gapped mode, with no model
    provider, connector, MCP server or OIDC issuer configured, the answer is
    nothing.

  ${C_BLD}OPERATE${C_RST}
    logs      docker compose -p $PROJECT logs -f gateway
    stop      docker compose -p $PROJECT stop
    upgrade   scripts/verify-update-bundle.sh <bundle> && scripts/apply-update-bundle.sh <bundle>
    reconfig  re-run this installer with new flags; it converges, it never destroys.

SUMMARY
