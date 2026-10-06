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
#     up --build` pulls node:22-slim and runs `pnpm install` against the npm
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
  --admin-token <tok>              REGULAIT_BOOTSTRAP_TOKEN used to create the
                                   first admin. Generated if absent.
  --db-password <pw>               Postgres password. Generated on a first
                                   install; preserved on every re-run.

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
DB_PASSWORD="${REGULAIT_DB_PASSWORD:-}"
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
    --oidc-issuer)   OIDC_ISSUER="${2:-}"; shift 2 ;;
    --seed-demo)     SEED_DEMO=1; shift ;;
    --no-seed-demo)  SEED_DEMO=0; shift ;;
    --version)       VERSION="${2:-}"; shift 2 ;;
    --hsts)          HSTS="${2:-}"; shift 2 ;;
    --saml-entity-id)  SAML_ENTITY_ID="${2:-}"; shift 2 ;;
    --saml-clock-skew) SAML_CLOCK_SKEW="${2:-}"; shift 2 ;;
    --data-key)      DATA_KEY="${2:-}"; shift 2 ;;
    --admin-token)   ADMIN_TOKEN="${2:-}"; shift 2 ;;
    --db-password)   DB_PASSWORD="${2:-}"; shift 2 ;;
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

image_present() {
  docker_up || return 1
  docker image inspect "$1" >/dev/null 2>&1
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
  [ -n "$DATA_KEY" ]     || DATA_KEY="$(env_get "$ENV_FILE" REGULAIT_DATA_KEY)"
  [ -n "$ADMIN_TOKEN" ]  || ADMIN_TOKEN="$(env_get "$ENV_FILE" REGULAIT_BOOTSTRAP_TOKEN)"
  [ -n "$DB_PASSWORD" ]  || DB_PASSWORD="$(env_get "$ENV_FILE" REGULAIT_DB_PASSWORD)"
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

[ -n "$ADMIN_TOKEN" ] || { ADMIN_TOKEN="$(rand_token)"; GENERATED_ADMIN_TOKEN=1; }
if [ "$ADMIN_TOKEN" = "dev-bootstrap" ]; then
  die "REGULAIT_BOOTSTRAP_TOKEN is the published dev default 'dev-bootstrap'. That token authenticates as a full admin with no user identity (apps/gateway/src/auth.ts). Pass --admin-token, or drop it and one will be generated."
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
    for img in "$GATEWAY_IMAGE" postgres:16 caddy:2-alpine; do
      image_present "$img" || missing="$missing $img"
    done
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
   node:22-slim and runs \`pnpm install\` against the npm registry. That is
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
# Authenticates as a full admin with no user identity. Used ONCE to create the
# first real admin, then should be removed from this file and the stack
# restarted.
REGULAIT_BOOTSTRAP_TOKEN=$ADMIN_TOKEN
REGULAIT_DB_PASSWORD=$DB_PASSWORD
REGULAIT_DATABASE_URL=postgres://regulait:$DB_PASSWORD@db:5432/regulait

# ---- application -----------------------------------------------------------
SEED_DEMO=$SEED_DEMO
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
  if [ "$MODE" = "air_gapped" ]; then
    cat <<YML
    # AIR-GAPPED: run the pre-seeded image, never pull, never build.
    image: $GATEWAY_IMAGE
    pull_policy: never
  db:
    pull_policy: never
  caddy:
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
  exit 0
fi

# ===========================================================================
# 5. BRING UP
# ===========================================================================
if [ -n "$IMAGE_BUNDLE" ]; then
  step "Loading pre-seeded images (air-gapped path — nothing is pulled)"
  docker load -i "$IMAGE_BUNDLE"
  ok "images loaded"
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

cat <<SUMMARY

  ${C_BLD}FIRST ADMIN${C_RST}
    The bootstrap token authenticates as an admin with no user identity. Use it
    exactly once to create your first real admin, then delete
    REGULAIT_BOOTSTRAP_TOKEN from $ENV_FILE and restart:

      curl -sS $API/v1/users \\
        -H "Authorization: Bearer $ADMIN_TOKEN" \\
        -H 'Content-Type: application/json' \\
        -d '{"username":"admin","email":"admin@your.org","isAdmin":true}'

      # then, to retire the bootstrap door:
      sed -i '/^REGULAIT_BOOTSTRAP_TOKEN=/d' $ENV_FILE
      docker compose -p $PROJECT up -d
SUMMARY

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
cat <<SUMMARY
    * REGULAIT_BOOTSTRAP_TOKEN — until you have created the first admin.
    * REGULAIT_DB_PASSWORD — it is only settable at first initdb.

  ${C_BLD}BACK UP${C_RST}
    * The Postgres data (docker volume ${PROJECT}_pgdata) — see
      docs/deployment/BACKUP_RESTORE.md and ADR-0035 for the verified
      nightly pg_dump.
    * $ENV_FILE (it holds the data key).
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
