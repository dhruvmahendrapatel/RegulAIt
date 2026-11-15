#!/usr/bin/env bash
# =============================================================================
# RegulAIt release-key CEREMONY tool (ADR-0324)
#
# The step-by-step runbook is docs/ops/RELEASE_KEY_CEREMONY.md. This tool does
# the cryptography for each step so nobody types an openssl command by hand on
# the day. It needs bash 4.4+, coreutils, tar and openssl 3, and makes no
# network call. Every private key stays where you put it: the tool never
# copies, prints or logs one, and refuses to write one inside a git checkout.
#
# Subcommands (each takes --log <witness-log> to append a hash-chained entry):
#   keygen        --role root|signing --id <id> --out <dir> [--pass <src>]
#   keyring       --out-dir <dir> --serial <n> --threshold <m> --builder <url>
#                 --root <id>=<pub> ... [--key <id>=<pub>:<purposes>:<notAfter> ...]
#                 [--revoke <id> ...] [--previous <old keyring dir>] [--allow-single-root]
#   sign-keyring  --dir <keyring dir> --root-id <id> --root-key <pem|pkcs11:URI> [--pass <src>]
#   sign-release  --candidate <unsigned.tar.gz> --key <pem|pkcs11:URI> --out <signed.tar.gz>
#                 [--trust <keyring dir>] [--pass <src>]
#   current-signing-key --keyring <dir>     (prints the key id CI must name in a candidate)
#   fingerprint   <pub.pem>
#   log-verify    <witness-log>
#   dry-run       [--keep]                  (the whole ceremony with throwaway keys; see below)
#
# --pass takes an openssl pass source (pass:<x> for the dry run only, file:<path>,
# env:<VAR>, or omit it to be prompted). Private keys are written encrypted with
# AES-256 (PKCS#8) unless --pass is "none", which only the dry run uses.
#
# Hardware token: give --key / --root-key a PKCS#11 URI (pkcs11:token=...;object=...)
# and install pkcs11-provider (Apache-2.0) for openssl 3. The key never leaves the token.
# This path is written to openssl's documented provider interface but has NOT been run
# against a physical token in this repository (ADR-0324, "What is not proven").
# =============================================================================
set -euo pipefail

if [ -z "${BASH_VERSINFO:-}" ] || [ "${BASH_VERSINFO[0]}" -lt 4 ] || { [ "${BASH_VERSINFO[0]}" -eq 4 ] && [ "${BASH_VERSINFO[1]}" -lt 4 ]; }; then
  echo "[FATAL] bash 4.4 or newer is required (this is ${BASH_VERSION:-unknown})" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib/release-trust.sh
. "$SCRIPT_DIR/lib/release-trust.sh"

die() { printf '\n[FATAL] %s\n\n' "$*" >&2; exit 1; }
ok()  { printf '  [ok]   %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
command -v openssl >/dev/null 2>&1 || die "openssl is required"

LOG=""
PASS_SRC=""

# --- witness log ---------------------------------------------------------------
# One line per event: "<UTC time> | <event> | prev=<sha256 of the previous line>".
# Changing, removing or reordering a line breaks every later prev=. Only public
# facts go in: key ids, fingerprints, file digests. Never a secret, never a name.
log_event() {
  [ -n "$LOG" ] || return 0
  local prev="0000000000000000000000000000000000000000000000000000000000000000"
  [ -s "$LOG" ] && prev="$(tail -n 1 "$LOG" | tr -d '\n' | kr_sha256_stdin)"
  printf '%s | %s | prev=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" "$prev" >>"$LOG"
}
log_verify() {
  local file="$1" prev="0000000000000000000000000000000000000000000000000000000000000000" line n=0
  [ -f "$file" ] || die "no such log: $file"
  while IFS= read -r line; do
    n=$((n + 1))
    [ "${line##* | prev=}" = "$prev" ] || die "witness log BROKEN at line $n: it does not follow line $((n - 1))"
    prev="$(printf '%s' "$line" | kr_sha256_stdin)"
  done <"$file"
  ok "witness log intact: $n entr$([ "$n" = 1 ] && echo y || echo ies), last hash $prev"
}

# --- safety checks -----------------------------------------------------------
in_git_checkout() { git -C "$1" rev-parse --is-inside-work-tree >/dev/null 2>&1; }
network_up() {
  local d st
  for d in /sys/class/net/*; do
    [ -e "$d" ] || continue
    [ "$(basename "$d")" = "lo" ] && continue
    st="$(cat "$d/operstate" 2>/dev/null || echo unknown)"
    [ "$st" = "up" ] && return 0
  done
  return 1
}
pass_args() { # prints -passin/-pass flags for the configured pass source
  if [ -n "$PASS_SRC" ] && [ "$PASS_SRC" != "none" ]; then printf '%s\n%s\n' "$1" "$PASS_SRC"; fi
}

# --- signing primitives ----------------------------------------------------------
pub_of_key() { # <pem|pkcs11:URI> -> public key PEM on stdout
  local key="$1"
  local -a pa
  mapfile -t pa < <(pass_args -passin)
  case "$key" in
    pkcs11:*) openssl pkey -provider pkcs11 -provider default -in "$key" -pubout ;;
    *)        openssl pkey -in "$key" "${pa[@]}" -pubout ;;
  esac
}
sign_file() { # <pem|pkcs11:URI> <message> <out.sig (base64)>
  local key="$1" msg="$2" out="$3" bin
  local -a pa
  mapfile -t pa < <(pass_args -passin)
  bin="$(mktemp)"
  case "$key" in
    pkcs11:*) openssl pkeyutl -sign -provider pkcs11 -provider default -inkey "$key" -rawin -in "$msg" -out "$bin" ;;
    *)        openssl pkeyutl -sign -inkey "$key" "${pa[@]}" -rawin -in "$msg" -out "$bin" ;;
  esac || { rm -f "$bin"; die "signing failed (wrong passphrase, or not an Ed25519 key?)"; }
  openssl base64 -A -in "$bin" -out "$out"
  rm -f "$bin"
}

# --- keygen ----------------------------------------------------------------------
cmd_keygen() {
  local role="" id="" out="" allow_net=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --role) role="${2:-}"; shift 2 ;;
      --id) id="${2:-}"; shift 2 ;;
      --out) out="${2:-}"; shift 2 ;;
      --pass) PASS_SRC="${2:-}"; shift 2 ;;
      --log) LOG="${2:-}"; shift 2 ;;
      --allow-network) allow_net=1; shift ;;
      *) die "keygen: unknown option $1" ;;
    esac
  done
  case "$role" in root|signing) ;; *) die "keygen: --role root|signing" ;; esac
  [[ "$id" =~ $KR_ID_RE ]] || die "keygen: --id must match $KR_ID_RE"
  [ -n "$out" ] || die "keygen: --out <dir> (removable media for a root key)"
  mkdir -p "$out"
  out="$(cd -- "$out" && pwd)"
  in_git_checkout "$out" && die "refusing to write a private key inside a git checkout ($out)"
  if [ "$allow_net" = "0" ] && network_up; then
    die "a network interface is up. Generate keys on an air-gapped machine (runbook part 2)." \
        "Unplug the cable and turn Wi-Fi off, then run this again."
  fi
  [ ! -e "$out/$id.pem" ] || die "$out/$id.pem already exists; a key is never overwritten"
  local -a pa=()
  mapfile -t pa < <(pass_args -pass)
  if [ "$PASS_SRC" = "none" ]; then
    (umask 077; openssl genpkey -algorithm ed25519 -out "$out/$id.pem")
  elif [ -n "$PASS_SRC" ]; then
    (umask 077; openssl genpkey -algorithm ed25519 -aes-256-cbc "${pa[@]}" -out "$out/$id.pem")
  else
    info "choose a passphrase for $id (you will be asked twice); write it on the custody card"
    (umask 077; openssl genpkey -algorithm ed25519 -aes-256-cbc -out "$out/$id.pem")
  fi
  chmod 400 "$out/$id.pem"
  pub_of_key "$out/$id.pem" >"$out/$id.pub"
  local fp
  fp="$(kr_fingerprint "$out/$id.pub")"
  ok "$role key $id: private half $out/$id.pem (encrypted unless the dry run), public half $out/$id.pub"
  info "fingerprint sha256:$fp   <- read this aloud; the witness writes it down"
  log_event "keygen role=$role id=$id sha256=$fp"
}

# --- keyring statement -------------------------------------------------------------
cmd_keyring() {
  local outdir="" previous="" single=0 spec id rest pub purposes notafter i
  local -a roots=() keys=() revoke=()
  kr_reset
  while [ $# -gt 0 ]; do
    case "$1" in
      --out-dir) outdir="${2:-}"; shift 2 ;;
      --serial) KR_SERIAL="${2:-}"; shift 2 ;;
      --threshold) KR_THRESHOLD="${2:-}"; shift 2 ;;
      --builder) KR_BUILDER="${2:-}"; shift 2 ;;
      --root) roots+=("${2:-}"); shift 2 ;;
      --key) keys+=("${2:-}"); shift 2 ;;
      --revoke) revoke+=("${2:-}"); shift 2 ;;
      --previous) previous="${2:-}"; shift 2 ;;
      --allow-single-root) single=1; shift ;;
      --log) LOG="${2:-}"; shift 2 ;;
      *) die "keyring: unknown option $1" ;;
    esac
  done
  [ -n "$outdir" ] || die "keyring: --out-dir <dir>"
  [ ! -e "$outdir/keyring.json" ] || die "$outdir/keyring.json exists; write each new statement to a new directory"
  if [ "$single" = "0" ] && [ "${KR_THRESHOLD:-0}" -lt 2 ] 2>/dev/null; then
    die "threshold below 2: one lost or stolen root would then decide alone." \
        "The default is 2 of 3 (runbook part 1). --allow-single-root relaxes it, and the witness log records that."
  fi
  KR_ISSUED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  mkdir -p "$outdir/root"
  for spec in "${roots[@]}"; do
    id="${spec%%=*}"; pub="${spec#*=}"
    [ -f "$pub" ] || die "root public key not found: $pub"
    kr_is_ed25519_pub "$pub" || die "$pub is not an Ed25519 public key"
    KR_ROOT_IDS+=("$id"); KR_ROOT_FPS+=("$(kr_fingerprint "$pub")")
    cp "$pub" "$outdir/root/$id.pub"
  done
  for spec in "${keys[@]}"; do
    id="${spec%%=*}"; rest="${spec#*=}"
    pub="${rest%%:*}"; rest="${rest#*:}"
    purposes="${rest%%:*}"; notafter="${rest#*:}"
    [ -f "$pub" ] || die "signing public key not found: $pub"
    kr_is_ed25519_pub "$pub" || die "$pub is not an Ed25519 public key"
    KR_KEY_IDS+=("$id"); KR_KEY_FPS+=("$(kr_fingerprint "$pub")")
    KR_KEY_PURPOSES+=("$purposes"); KR_KEY_NOTAFTER+=("$notafter")
    cp "$pub" "$outdir/$id.pub"
  done
  KR_REVOKED=("${revoke[@]}")
  if [ -n "$previous" ]; then
    # A new statement carries every earlier revocation forward and takes a higher serial.
    local -a cur_roots=("${KR_ROOT_IDS[@]}") cur_rfps=("${KR_ROOT_FPS[@]}") cur_keys=("${KR_KEY_IDS[@]}")
    local -a cur_kfps=("${KR_KEY_FPS[@]}") cur_np=("${KR_KEY_NOTAFTER[@]}") cur_pu=("${KR_KEY_PURPOSES[@]}")
    local -a cur_rev=("${KR_REVOKED[@]}")
    local cur_serial="$KR_SERIAL" cur_thr="$KR_THRESHOLD" cur_b="$KR_BUILDER" cur_iss="$KR_ISSUED"
    kr_parse "$previous/keyring.json" || die "--previous: $KR_ERR"
    [ "$cur_serial" -gt "$KR_SERIAL" ] 2>/dev/null || die "serial must be higher than the previous $KR_SERIAL"
    local -a prev_rev=("${KR_REVOKED[@]}")
    KR_SERIAL="$cur_serial"; KR_THRESHOLD="$cur_thr"; KR_BUILDER="$cur_b"; KR_ISSUED="$cur_iss"
    KR_ROOT_IDS=("${cur_roots[@]}"); KR_ROOT_FPS=("${cur_rfps[@]}")
    KR_KEY_IDS=("${cur_keys[@]}"); KR_KEY_FPS=("${cur_kfps[@]}"); KR_KEY_NOTAFTER=("${cur_np[@]}"); KR_KEY_PURPOSES=("${cur_pu[@]}")
    KR_REVOKED=("${cur_rev[@]}")
    for id in "${prev_rev[@]}"; do
      case " ${KR_REVOKED[*]} " in *" $id "*) ;; *) KR_REVOKED+=("$id") ;; esac
    done
  fi
  kr_check || die "keyring: $KR_ERR"
  kr_render >"$outdir/keyring.json"
  kr_parse "$outdir/keyring.json" || die "self-check failed: $KR_ERR"
  ok "keyring statement serial $KR_SERIAL: ${#KR_ROOT_IDS[@]} root(s), threshold $KR_THRESHOLD, ${#KR_KEY_IDS[@]} signing key(s), ${#KR_REVOKED[@]} revoked"
  info "statement sha256:$(kr_sha256_file "$outdir/keyring.json")   <- the witness writes this down"
  log_event "keyring serial=$KR_SERIAL threshold=$KR_THRESHOLD roots=${KR_ROOT_IDS[*]} keys=${KR_KEY_IDS[*]:-} revoked=${KR_REVOKED[*]:-} single_root_allowed=$single sha256=$(kr_sha256_file "$outdir/keyring.json")"
}

cmd_sign_keyring() {
  local dir="" rid="" rkey=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) dir="${2:-}"; shift 2 ;;
      --root-id) rid="${2:-}"; shift 2 ;;
      --root-key) rkey="${2:-}"; shift 2 ;;
      --pass) PASS_SRC="${2:-}"; shift 2 ;;
      --log) LOG="${2:-}"; shift 2 ;;
      *) die "sign-keyring: unknown option $1" ;;
    esac
  done
  [ -f "$dir/keyring.json" ] || die "sign-keyring: --dir must hold keyring.json"
  [ -f "$dir/root/$rid.pub" ] || die "sign-keyring: $rid is not a root in this statement"
  kr_parse "$dir/keyring.json" || die "the statement does not parse: $KR_ERR"
  # Sign only with the key the statement names: compare the private key's public half first.
  local mine
  mine="$(mktemp)"
  pub_of_key "$rkey" >"$mine" || { rm -f "$mine"; die "cannot read the root key (wrong passphrase?)"; }
  [ "$(kr_fingerprint "$mine")" = "$(kr_fingerprint "$dir/root/$rid.pub")" ] || { rm -f "$mine"; die "this private key is not root $rid"; }
  rm -f "$mine"
  sign_file "$rkey" "$dir/keyring.json" "$dir/keyring.json.sig.$rid"
  ok "root $rid signed keyring serial $KR_SERIAL"
  log_event "sign-keyring serial=$KR_SERIAL root=$rid statement_sha256=$(kr_sha256_file "$dir/keyring.json")"
}

cmd_sign_release() {
  local cand="" key="" out="" trust=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --candidate) cand="${2:-}"; shift 2 ;;
      --key) key="${2:-}"; shift 2 ;;
      --out) out="${2:-}"; shift 2 ;;
      --trust) trust="${2:-}"; shift 2 ;;
      --pass) PASS_SRC="${2:-}"; shift 2 ;;
      --log) LOG="${2:-}"; shift 2 ;;
      *) die "sign-release: unknown option $1" ;;
    esac
  done
  [ -f "$cand" ] && [ -n "$key" ] && [ -n "$out" ] || die "sign-release: --candidate, --key and --out are required"
  [ ! -e "$out" ] || die "$out exists"
  local -a targs=()
  [ -z "$trust" ] || targs=(--trust "$trust")
  # Never sign what does not check out: the same offline checks a customer runs, minus the signature.
  bash "$SCRIPT_DIR/verify-release.sh" --candidate "$cand" "${targs[@]}" --quiet \
    || die "the candidate does not pass the pre-sign check; NOT signing it"
  local stage root keyid mine
  stage="$(mktemp -d)"
  tar -xzf "$cand" -C "$stage"
  root="$(find "$stage" -mindepth 1 -maxdepth 1 -type d | head -1)"
  keyid="$(grep -m1 -oE '"signingKeyId"[[:space:]]*:[[:space:]]*"[^"]*"' "$root/manifest.json" | sed -E 's/.*"([^"]*)"$/\1/')"
  mine="$(mktemp)"
  pub_of_key "$key" >"$mine" || { rm -rf "$stage" "$mine"; die "cannot read the signing key (wrong passphrase?)"; }
  [ "$(kr_fingerprint "$mine")" = "$(kr_fingerprint "$root/payload/infra/release-keys/$keyid.pub")" ] \
    || { rm -rf "$stage" "$mine"; die "this private key is not $keyid, the key the candidate names"; }
  rm -f "$mine"
  sign_file "$key" "$root/manifest.json" "$root/manifest.json.sig"
  sign_file "$key" "$root/provenance.intoto.json" "$root/provenance.intoto.json.sig"
  tar -C "$stage" -czf "$out" "$(basename "$root")"
  local msha
  msha="$(kr_sha256_file "$root/manifest.json")"
  rm -rf "$stage"
  bash "$SCRIPT_DIR/verify-release.sh" "$out" "${targs[@]}" --quiet || die "the signed release does not verify; do not publish it"
  ok "signed: $out (key $keyid, manifest sha256:$msha); it verifies"
  log_event "sign-release key=$keyid manifest_sha256=$msha bundle_sha256=$(kr_sha256_file "$out")"
}

cmd_current_signing_key() {
  local dir="" i best="" bestdate=""
  while [ $# -gt 0 ]; do
    case "$1" in --keyring) dir="${2:-}"; shift 2 ;; *) die "unknown option $1" ;; esac
  done
  [ -f "$dir/keyring.json" ] || die "no root-signed keyring in $dir: run the release-key ceremony first (ADR-0324)"
  kr_verify_dir "$dir" || die "the keyring does not verify: $KR_ERR"
  for ((i = 0; i < ${#KR_KEY_IDS[@]}; i++)); do
    case ",${KR_KEY_PURPOSES[$i]}," in *,update-bundle,*) ;; *) continue ;; esac
    if [ -z "$best" ] || [[ "${KR_KEY_NOTAFTER[$i]}" > "$bestdate" ]]; then best="${KR_KEY_IDS[$i]}"; bestdate="${KR_KEY_NOTAFTER[$i]}"; fi
  done
  [ -n "$best" ] || die "the keyring authorises no update-bundle signing key"
  printf '%s\n' "$best"
}

# =============================================================================
# DRY RUN: the whole ceremony, end to end, with throwaway keys in a temp dir.
# Proves that a correctly signed release verifies and that each attack the
# design exists for is refused, with the right reason. The temp dir (and every
# throwaway private key in it) is deleted on exit unless --keep.
# =============================================================================
cmd_dry_run() {
  local keep=0
  [ "${1:-}" = "--keep" ] && keep=1
  DRY_W="$(mktemp -d "${TMPDIR:-/tmp}/regulait-ceremony-dryrun.XXXXXX")"
  if [ "$keep" = "0" ]; then trap 'rm -rf "$DRY_W"' EXIT; fi
  local W="$DRY_W"
  local T="$SCRIPT_DIR/release-ceremony.sh" V="$SCRIPT_DIR/verify-release.sh" B="$SCRIPT_DIR/build-update-bundle.sh"
  local P="$SCRIPT_DIR/release-provenance.sh"
  local REPO="https://github.com/example/regulait" WF=".github/workflows/release.yml"
  local BUILDER="$REPO/$WF" PW="pass:dry-run-throwaway-not-a-secret"
  local OFF="$W/offline" passes=0 fails=0
  LOG="$W/witness.log"
  mkdir -p "$OFF"
  printf '\n==> DRY RUN in %s (throwaway keys; deleted afterwards%s)\n' "$W" "$([ "$keep" = 1 ] && echo ': NO, --keep')"

  q() { "$@" >"$W/last.out" 2>&1; }
  expect_pass() {
    local what="$1"; shift
    if q "$@"; then passes=$((passes + 1)); printf '  [pass]    %s\n' "$what"
    else fails=$((fails + 1)); printf '  [FAILED]  %s (expected success)\n' "$what"; sed 's/^/            | /' "$W/last.out"; fi
  }
  expect_refuse() {
    local what="$1" want="$2"; shift 2
    if q "$@"; then fails=$((fails + 1)); printf '  [FAILED]  %s (expected a refusal, it was ACCEPTED)\n' "$what"
    elif grep -qF -- "$want" "$W/last.out"; then passes=$((passes + 1)); printf '  [refused] %s\n' "$what"
    else fails=$((fails + 1)); printf '  [FAILED]  %s (refused, but not with "%s")\n' "$what" "$want"; sed 's/^/            | /' "$W/last.out"; fi
  }
  keygen() { q bash "$T" keygen --role "$1" --id "$2" --out "$OFF" --pass "$PW" --log "$LOG" --allow-network || { cat "$W/last.out"; die "dry run: keygen $2 failed"; }; }
  keyring() { q bash "$T" keyring --log "$LOG" "$@" || { cat "$W/last.out"; die "dry run: keyring failed"; }; }
  rootsign() { local d="$1"; shift; for r in "$@"; do q bash "$T" sign-keyring --dir "$d" --root-id "$r" --root-key "$OFF/$r.pem" --pass "$PW" --log "$LOG" || { cat "$W/last.out"; die "dry run: sign-keyring $r failed"; }; done; }
  # candidate <version> <key-id> <keyring dir> <out> [--no-sbom] [--workflow <path>]
  candidate() {
    local ver="$1" kid="$2" kdir="$3" out="$4" sbom=1 wf="$WF" src
    shift 4
    while [ $# -gt 0 ]; do case "$1" in --no-sbom) sbom=0; shift ;; --workflow) wf="$2"; shift 2 ;; esac; done
    src="$(mktemp -d "$W/src.XXXXXX")"
    printf 'services: {}\n# regulait %s (dry run)\n' "$ver" >"$src/docker-compose.yml"
    mkdir -p "$src/infra"
    cp -R "$kdir" "$src/infra/release-keys"
    local -a inc=(--include docker-compose.yml --include infra/release-keys)
    if [ "$sbom" = "1" ]; then
      mkdir -p "$src/sbom"
      printf '{\n  "bomFormat": "CycloneDX",\n  "specVersion": "1.6",\n  "components": []\n}\n' >"$src/sbom/regulait-workspace.cdx.json"
      inc+=(--include sbom)
    fi
    q bash "$B" --version "$ver" --unsigned --key-id "$kid" --source "$src" "${inc[@]}" --out "$out" || { cat "$W/last.out"; die "dry run: build failed"; }
    q bash "$P" --candidate "$out" --repository "$REPO" --workflow "$wf" --ref "refs/tags/v$ver" \
      --commit "$(printf '%s' "$ver" | kr_sha256_stdin | cut -c1-40)" \
      --invocation "$REPO/actions/runs/1/attempts/1" || { cat "$W/last.out"; die "dry run: provenance failed"; }
  }
  sign() { q bash "$T" sign-release --candidate "$1" --key "$OFF/$2.pem" --pass "$PW" --trust "$3" --out "$4" --log "$LOG" || { cat "$W/last.out"; die "dry run: sign-release failed"; }; }
  retar() { # retar <bundle> <out> <command run inside the extracted bundle dir>
    local x; x="$(mktemp -d "$W/x.XXXXXX")"
    tar -xzf "$1" -C "$x"
    (cd "$x"/*/ && eval "$3")
    tar -C "$x" -czf "$2" "$(basename "$(find "$x" -mindepth 1 -maxdepth 1 -type d)")"
  }

  printf '\n-- part 1-3: three root keys, one release signing key, a 2-of-3 keyring\n'
  keygen root root-a; keygen root root-b; keygen root root-c; keygen signing release-s1
  keyring --out-dir "$W/kr1" --serial 1 --threshold 2 --builder "$BUILDER" \
    --root "root-a=$OFF/root-a.pub" --root "root-b=$OFF/root-b.pub" --root "root-c=$OFF/root-c.pub" \
    --key "release-s1=$OFF/release-s1.pub:update-bundle,provenance,license:2099-12-31"
  expect_refuse "a keyring signed by ONE of three roots (threshold 2)" "signed by 1 of its roots" \
    bash -c "bash '$T' sign-keyring --dir '$W/kr1' --root-id root-a --root-key '$OFF/root-a.pem' --pass '$PW' >/dev/null && bash '$V' --keyring-only '$W/kr1'"
  rootsign "$W/kr1" root-b
  expect_pass "the keyring verifies with two of three root signatures" bash "$V" --keyring-only "$W/kr1"
  expect_refuse "a threshold of 1 needs --allow-single-root" "threshold below 2" \
    bash "$T" keyring --out-dir "$W/kr-single" --serial 1 --threshold 1 --builder "$BUILDER" --root "root-a=$OFF/root-a.pub"
  cp -R "$W/kr1" "$W/kr1-planted"; cp "$OFF/root-c.pub" "$W/kr1-planted/planted.pub"
  expect_refuse "a .pub dropped into the keyring directory is not trust" "does not authorise it" bash "$V" --keyring-only "$W/kr1-planted"
  cp -R "$W/kr1" "$W/kr1-edited"; sed -i 's/"threshold": 2/"threshold": 1/' "$W/kr1-edited/keyring.json"
  expect_refuse "a hand-edited keyring (threshold lowered) fails its root signatures" "signed by 0 of its roots" bash "$V" --keyring-only "$W/kr1-edited"

  printf '\n-- part 5: build, check, sign and verify release 1.0.0\n'
  candidate 1.0.0 release-s1 "$W/kr1" "$W/c100.tar.gz"
  expect_pass "the unsigned candidate passes the signer's pre-sign check" bash "$V" --candidate "$W/c100.tar.gz" --trust "$W/kr1"
  expect_refuse "an UNSIGNED candidate is not a release" "UNSIGNED" bash "$V" "$W/c100.tar.gz" --trust "$W/kr1"
  sign "$W/c100.tar.gz" release-s1 "$W/kr1" "$W/r100.tar.gz"
  expect_pass "the signed release 1.0.0 verifies: signature, SBOM, provenance" bash "$V" "$W/r100.tar.gz" --trust "$W/kr1"

  printf '\n-- tampering: each must be refused, for the right reason\n'
  retar "$W/r100.tar.gz" "$W/t-payload.tar.gz" 'printf "evil\n" >> payload/docker-compose.yml'
  expect_refuse "a payload file changed after signing" "do not match their signed digest" bash "$V" "$W/t-payload.tar.gz" --trust "$W/kr1"
  retar "$W/r100.tar.gz" "$W/t-manifest.tar.gz" 'sed -i "s/\"minInstalledVersion\": \"0.0.0\"/\"minInstalledVersion\": \"0.0.1\"/" manifest.json'
  expect_refuse "the manifest changed after signing" "SIGNATURE DOES NOT VERIFY" bash "$V" "$W/t-manifest.tar.gz" --trust "$W/kr1"
  retar "$W/r100.tar.gz" "$W/t-extra.tar.gz" 'printf "#!/bin/sh\n" > postinstall.sh'
  expect_refuse "an extra file at the bundle root" "unexpected file at the bundle root" bash "$V" "$W/t-extra.tar.gz" --trust "$W/kr1"
  retar "$W/r100.tar.gz" "$W/t-unsigned-prov.tar.gz" 'printf "x" > provenance.intoto.json.sig'
  expect_refuse "provenance whose signature was replaced" "PROVENANCE SIGNATURE" bash "$V" "$W/t-unsigned-prov.tar.gz" --trust "$W/kr1"
  candidate 1.0.0 release-s1 "$W/kr1" "$W/c100-evil.tar.gz" --workflow .github/workflows/evil.yml
  expect_refuse "the signer refuses a candidate built by another workflow" "pre-sign check" \
    bash "$T" sign-release --candidate "$W/c100-evil.tar.gz" --key "$OFF/release-s1.pem" --pass "$PW" --trust "$W/kr1" --out "$W/never.tar.gz"
  candidate 1.0.1 release-s1 "$W/kr1" "$W/c101.tar.gz"
  retar "$W/r100.tar.gz" "$W/t-prov-swap.tar.gz" "tar -xzf '$W/c101.tar.gz' -O --wildcards '*/provenance.intoto.json' > provenance.intoto.json"
  expect_refuse "provenance of a different build swapped in" "PROVENANCE MISMATCH" bash "$V" "$W/t-prov-swap.tar.gz" --trust "$W/kr1"
  candidate 1.0.2 release-s1 "$W/kr1" "$W/c102-nosbom.tar.gz" --no-sbom
  expect_refuse "the signer refuses a candidate with no SBOM" "pre-sign check" \
    bash "$T" sign-release --candidate "$W/c102-nosbom.tar.gz" --key "$OFF/release-s1.pem" --pass "$PW" --trust "$W/kr1" --out "$W/never.tar.gz"
  expect_refuse "a candidate with no SBOM fails verification" "NO SBOM" bash "$V" --candidate "$W/c102-nosbom.tar.gz" --trust "$W/kr1"

  printf '\n-- an attacker with their own keys (the LiteLLM case: a pipeline that signs whatever it is given)\n'
  keygen root evil-root; keygen signing evil-s
  keyring --out-dir "$W/kr-evil" --serial 9 --threshold 1 --allow-single-root --builder "$BUILDER" \
    --root "evil-root=$OFF/evil-root.pub" --key "evil-s=$OFF/evil-s.pub:update-bundle,provenance:2099-12-31"
  rootsign "$W/kr-evil" evil-root
  candidate 6.6.6 evil-s "$W/kr-evil" "$W/c-evil.tar.gz"
  sign "$W/c-evil.tar.gz" evil-s "$W/kr-evil" "$W/r-evil.tar.gz"
  expect_refuse "a validly signed release under an attacker's own root" "TRUSTED root key(s)" bash "$V" "$W/r-evil.tar.gz" --trust "$W/kr1"
  keyring --out-dir "$W/kr-1root" --serial 2 --threshold 2 --builder "$BUILDER" \
    --root "root-a=$OFF/root-a.pub" --root "root-b=$OFF/root-b.pub" --root "root-c=$OFF/root-c.pub" \
    --key "release-s1=$OFF/release-s1.pub:update-bundle,provenance,license:2099-12-31" \
    --key "evil-s=$OFF/evil-s.pub:update-bundle,provenance:2099-12-31"
  rootsign "$W/kr-1root" root-a
  candidate 1.1.0 evil-s "$W/kr-1root" "$W/c-1root.tar.gz"
  expect_refuse "a new signing key endorsed by only one stolen root" "signed by 1 of the 2 required" \
    bash "$V" --candidate "$W/c-1root.tar.gz" --trust "$W/kr1"

  printf '\n-- part 7 compromise drill: release-s1 is stolen; revoke it and rotate in one release\n'
  keygen signing release-s2
  keyring --out-dir "$W/kr2" --previous "$W/kr1" --serial 2 --threshold 2 --builder "$BUILDER" \
    --root "root-a=$OFF/root-a.pub" --root "root-b=$OFF/root-b.pub" --root "root-c=$OFF/root-c.pub" \
    --key "release-s2=$OFF/release-s2.pub:update-bundle,provenance,license:2099-12-31" --revoke release-s1
  rootsign "$W/kr2" root-a root-c
  candidate 1.1.0 release-s2 "$W/kr2" "$W/c110.tar.gz"
  sign "$W/c110.tar.gz" release-s2 "$W/kr1" "$W/r110.tar.gz"
  expect_pass "release 1.1.0, signed by the NEW key, verifies on a deployment that trusts only serial 1" bash "$V" "$W/r110.tar.gz" --trust "$W/kr1"
  expect_pass "the rotated keyring (serial 2, roots a and c) verifies on its own" bash "$V" --keyring-only "$W/kr2"
  candidate 1.2.0 release-s1 "$W/kr2" "$W/c120-stolen.tar.gz"
  local x; x="$(mktemp -d "$W/x.XXXXXX")"; tar -xzf "$W/c120-stolen.tar.gz" -C "$x"
  PASS_SRC="$PW" sign_file "$OFF/release-s1.pem" "$x/regulait-update-1.2.0/manifest.json" "$x/regulait-update-1.2.0/manifest.json.sig"
  tar -C "$x" -czf "$W/r120-stolen.tar.gz" regulait-update-1.2.0
  expect_refuse "after the rotation, the STOLEN key's new release is refused" "SIGNING KEY REVOKED" bash "$V" "$W/r120-stolen.tar.gz" --trust "$W/kr2"
  candidate 1.2.1 release-s1 "$W/kr1" "$W/c121-replay.tar.gz"
  sign "$W/c121-replay.tar.gz" release-s1 "$W/kr1" "$W/r121-replay.tar.gz"
  expect_refuse "the stolen key replaying the OLD keyring (serial 1) to un-revoke itself" "KEYRING ROLLBACK" bash "$V" "$W/r121-replay.tar.gz" --trust "$W/kr2"

  printf '\n-- part 6 rotation: root-c is lost; replace it with root-d\n'
  keygen root root-d
  keyring --out-dir "$W/kr3" --previous "$W/kr2" --serial 3 --threshold 2 --builder "$BUILDER" \
    --root "root-a=$OFF/root-a.pub" --root "root-b=$OFF/root-b.pub" --root "root-d=$OFF/root-d.pub" \
    --key "release-s2=$OFF/release-s2.pub:update-bundle,provenance,license:2099-12-31"
  rootsign "$W/kr3" root-a root-b
  candidate 1.3.0 release-s2 "$W/kr3" "$W/c130.tar.gz"
  sign "$W/c130.tar.gz" release-s2 "$W/kr2" "$W/r130.tar.gz"
  expect_pass "release 1.3.0 installs the new root set, endorsed by two roots of the old set" bash "$V" "$W/r130.tar.gz" --trust "$W/kr2"
  expect_pass "the new keyring (serial 3) verifies with revocations carried forward" bash -c "bash '$V' --keyring-only '$W/kr3' && grep -q '\"revoked\": \\[ \"release-s1\" \\]' '$W/kr3/keyring.json'"

  printf '\n-- expiry: a signing key past its notAfter\n'
  keygen signing release-old
  keyring --out-dir "$W/kr4" --previous "$W/kr3" --serial 4 --threshold 2 --builder "$BUILDER" \
    --root "root-a=$OFF/root-a.pub" --root "root-b=$OFF/root-b.pub" --root "root-d=$OFF/root-d.pub" \
    --key "release-s2=$OFF/release-s2.pub:update-bundle,provenance,license:2099-12-31" \
    --key "release-old=$OFF/release-old.pub:update-bundle,provenance:2000-01-01"
  rootsign "$W/kr4" root-b root-d
  candidate 1.4.0 release-old "$W/kr4" "$W/c140.tar.gz"
  expect_refuse "a candidate naming an expired signing key" "expired on 2000-01-01" bash "$V" --candidate "$W/c140.tar.gz" --trust "$W/kr3"

  printf '\n-- witness log\n'
  expect_pass "the witness log's hash chain is intact" bash "$T" log-verify "$LOG"
  cp "$LOG" "$W/witness-edited.log"; sed -i '3s/role=root/role=signing/' "$W/witness-edited.log"
  expect_refuse "an edited witness log is detected" "witness log BROKEN" bash "$T" log-verify "$W/witness-edited.log"
  if grep -q "PRIVATE KEY" "$LOG"; then fails=$((fails + 1)); echo "  [FAILED]  the witness log holds private key material"; else passes=$((passes + 1)); echo "  [pass]    the witness log holds no private key material"; fi

  printf '\n'
  if [ "$fails" -eq 0 ]; then
    printf 'DRY RUN PASSED: %s/%s checks. Signing verifies; every tampering, stolen-key and rollback case is refused.\n' "$passes" "$passes"
    [ "$keep" = "1" ] && printf 'Kept (throwaway keys, delete it yourself): %s\n' "$W"
    return 0
  fi
  printf 'DRY RUN FAILED: %s of %s checks failed.\n' "$fails" "$((passes + fails))"
  return 1
}

sub="${1:-}"
[ $# -gt 0 ] && shift
case "$sub" in
  keygen) cmd_keygen "$@" ;;
  keyring) cmd_keyring "$@" ;;
  sign-keyring) cmd_sign_keyring "$@" ;;
  sign-release) cmd_sign_release "$@" ;;
  current-signing-key) cmd_current_signing_key "$@" ;;
  fingerprint) [ -f "${1:-}" ] || die "fingerprint <pub.pem>"; printf 'sha256:%s\n' "$(kr_fingerprint "$1")" ;;
  log-verify) log_verify "${1:-}" ;;
  dry-run) cmd_dry_run "$@" ;;
  -h|--help|"") sed -n '2,32p' "$0" ;;
  *) die "unknown subcommand: $sub (see --help)" ;;
esac
