#!/usr/bin/env bash
# =============================================================================
# RegulAIt signed-export VERIFIER (ADR-0116)
#
# Runs on an AUDITOR's machine. No database, no gateway, no RegulAIt install,
# no network call of any kind. openssl, sha256sum (or shasum), tar and a POSIX
# shell are the entire dependency set.
#
# THE TRUST ROOT IS NOT IN THE BUNDLE, AND THIS SCRIPT WILL NOT PRETEND IT IS.
# A bundle carries a copy of its own public key for convenience. Trusting that
# copy would make verification meaningless: anyone can doctor a bundle, sign it
# with a fresh key, drop the new public key in, and "pass". So this script
# REFUSES to run unless you supply the trust root yourself:
#
#   --fingerprint sha256:<64 hex>   the value your customer's operator gave you
#                                   ONCE, out of band (admin console, install
#                                   printout, signed engagement letter).
#   --keyring <dir>                 a directory of pinned <keyId>.pub files.
#
# Every one of these is a refusal, not a warning:
#
#   * no trust root was supplied
#   * the manifest, its signature, or the payload is missing
#   * any entry in the bundle is neither a regular file nor a directory — a
#     symlink, FIFO or device (NON-REGULAR ENTRY IN BUNDLE), checked before
#     any name is read or any listing is compared
#   * the manifest schema or product is not one this verifier understands
#   * the signing key's fingerprint is not the one you pinned
#   * the manifest declares a fingerprint that is not the key's real one
#   * the signature does not verify under that key
#   * a file listed in the signed manifest is missing, altered, or unlisted
#   * a file under audit/rows is named anything but <seq>.payload, with <seq>
#     spelled exactly as chain.tsv spells it (AUDIT PAYLOAD NAME MALFORMED)
#   * an audit payload the signed chain lists is absent, or one is present
#     that it does not list
#   * an audit row's bytes do not hash to its recorded content_hash
#   * the audit chain's linkage, sequence or row_hash does not hold
#   * the chain segment does not end at the head the manifest signed
#
# There is deliberately no --force.
#
# Usage:
#   scripts/verify-export-bundle.sh bundle.tar.gz --fingerprint sha256:ab12...
#   scripts/verify-export-bundle.sh bundle.tar.gz --keyring /etc/regulait/export-keys
#
# Exit codes: 0 verified. 1 refused (reason printed). 2 usage error.
# =============================================================================
set -euo pipefail

KEYRING=""
EXPECT_FPR=""
BUNDLE=""
QUIET=0
EXTRACT_TO=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_RED=$'\033[31m'; C_GRN=$'\033[32m'; C_BLD=$'\033[1m'; C_RST=$'\033[0m'
else
  C_RED=''; C_GRN=''; C_BLD=''; C_RST=''
fi

pass() { [ "$QUIET" = "1" ] || printf '  %s[pass]%s %s\n' "$C_GRN" "$C_RST" "$*"; }
note() { [ "$QUIET" = "1" ] || printf '  %s\n' "$*"; }
refuse() {
  printf '\n%s[REFUSED]%s %s\n' "$C_RED" "$C_RST" "$1" >&2
  shift
  for l in "$@"; do printf '           %s\n' "$l" >&2; done
  printf '\n' >&2
  exit 1
}

usage() {
  cat <<'USAGE'
Usage: scripts/verify-export-bundle.sh <bundle.tar.gz> (--fingerprint F | --keyring DIR) [options]

  --fingerprint sha256:<hex> The signing key fingerprint you obtained OUT OF
                             BAND from the operator of the deployment that
                             produced this bundle. Repeatable.
  --keyring <dir>            Directory of pinned <keyId>.pub files. The key
                             named by the manifest must be present there, and
                             that pinned copy — not the bundled one — is what
                             the signature is checked against.
  --extract-to <dir>         On success, extract the VERIFIED bundle here.
  --quiet                    Only print on refusal.
  -h, --help

At least one of --fingerprint / --keyring is REQUIRED. A bundle cannot
establish its own trust root; see this script's header.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --keyring)     KEYRING="${2:-}"; shift 2 ;;
    --fingerprint) EXPECT_FPR="${EXPECT_FPR}${EXPECT_FPR:+ }${2:-}"; shift 2 ;;
    --extract-to)  EXTRACT_TO="${2:-}"; shift 2 ;;
    --quiet)       QUIET=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    -*)            usage >&2; exit 2 ;;
    *)             BUNDLE="$1"; shift ;;
  esac
done

[ -n "$BUNDLE" ] || { usage >&2; exit 2; }
[ -f "$BUNDLE" ] || refuse "bundle not found: $BUNDLE"
command -v openssl >/dev/null 2>&1 || refuse "openssl is not installed" \
  "Verification is the one step that cannot be skipped, so a missing verifier" \
  "is a refusal rather than a warning."

# --- 0. THE TRUST ROOT, before anything else -------------------------------
if [ -z "$EXPECT_FPR" ] && [ -z "$KEYRING" ]; then
  refuse "NO TRUST ROOT SUPPLIED — refusing to verify" \
    "This bundle contains a copy of the public key that signed it. Checking a" \
    "signature against a key the same bundle supplied proves only that the" \
    "bundle is internally consistent: anyone can alter the content, sign it" \
    "with a key they generated a moment ago, and replace the bundled public" \
    "key to match." \
    "" \
    "Obtain the signing key fingerprint ONCE, out of band, from the" \
    "organisation that operates the deployment — their admin console reports" \
    "it at GET /v1/exports/signing-key, and the install prints it. Then:" \
    "" \
    "    $0 $BUNDLE --fingerprint sha256:<hex>" \
    "" \
    "Do NOT take the fingerprint from this bundle's README.txt or manifest;" \
    "both are written by whoever produced the bundle. The vendor does not" \
    "hold this key and cannot supply it."
fi

BUNDLE="$(cd -- "$(dirname -- "$BUNDLE")" && pwd)/$(basename -- "$BUNDLE")"
[ "$QUIET" = "1" ] || printf '\n%s==> Verifying %s%s\n' "$C_BLD" "$BUNDLE" "$C_RST"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

# Every name and listing check below reads the TREE, and a tree can hold
# entries whose bytes are not their own: a symlink is whatever it points at on
# the machine doing the verifying, a FIFO or a device has no fixed bytes at all.
# None of them can be what a manifest or a chain signed, and each slips past a
# `find -type f` enumeration while `[ -f ]` and sha256sum follow it. So the
# refusal is categorical, made on the extracted tree before any name is read,
# and shared by every later check that meets one.
refuse_nonregular() {
  refuse "NON-REGULAR ENTRY IN BUNDLE ($1 found): an entry that is neither a regular file nor a directory" \
    "A symlink, FIFO or device node has no bytes of its own that a signature" \
    "could cover. A symlink in particular reads as whatever it points at on" \
    "the machine running this check, and --extract-to would carry the link" \
    "itself into the 'verified' tree. An export bundle is regular files in" \
    "directories and nothing else."
}

# --- 1. extract ------------------------------------------------------------
tar -xzf "$BUNDLE" -C "$WORK" 2>/dev/null \
  || refuse "the bundle is not a readable gzip tarball" \
            "Truncated download, or not a RegulAIt export bundle."

NONREGULAR=0
while IFS= read -r -d '' f; do
  printf '  %s[non-regular]%s %q\n' "$C_RED" "$C_RST" "${f#"$WORK"/}" >&2
  NONREGULAR=$((NONREGULAR + 1))
done < <(find "$WORK" -mindepth 1 ! -type f ! -type d -print0)
[ "$NONREGULAR" = "0" ] || refuse_nonregular "$NONREGULAR"

ROOT="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -n "$ROOT" ] || refuse "the bundle has no top-level directory" \
  "Expected regulait-export-<kind>-<id>/ containing manifest.json."

MANIFEST="$ROOT/manifest.json"
SIGFILE="$ROOT/manifest.json.sig"

[ -f "$MANIFEST" ] || refuse "manifest.json is missing" \
  "An export bundle without a manifest cannot be verified at all."
[ -f "$SIGFILE" ] || refuse "manifest.json.sig is missing" \
  "The signature is what makes this evidence rather than a tarball someone" \
  "sent you. Stripping it is exactly the attack this check exists for."
pass "structure: manifest and signature present"

# --- 2. manifest fields ----------------------------------------------------
# Regex over JSON, not a JSON parser: this must run on an auditor's machine
# with nothing but coreutils. The manifest is canonical JSON with sorted keys
# and a fixed shape, and the AUTHORITY is the signature over the exact bytes,
# not the parse.
jfield() { grep -m1 -oE "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" "$MANIFEST" | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/'; }

SCHEMA="$(jfield schema || true)"
PRODUCT="$(jfield product || true)"
KEY_ID="$(jfield signingKeyId || true)"
DECLARED_FPR="$(jfield signingKeyFingerprint || true)"
EXPORTED_AT="$(jfield exportedAt || true)"
INSTALL_ID="$(jfield installId || true)"
SUBJECT_KIND="$(jfield kind || true)"
PAYLOAD_SCOPE="$(jfield payloadScope || true)"

[ "$SCHEMA" = "regulait.export-bundle/1" ] || [ "$SCHEMA" = "regulait.export-bundle/2" ] || refuse \
  "unknown manifest schema: '${SCHEMA:-<none>}'" \
  "This verifier understands regulait.export-bundle/1 and /2 only."
if [ "$SCHEMA" = "regulait.export-bundle/2" ]; then
  [ "$PAYLOAD_SCOPE" = "subject" ] || refuse "schema /2 requires audit payloadScope=subject"
else
  [ -z "$PAYLOAD_SCOPE" ] || [ "$PAYLOAD_SCOPE" = "full" ] || refuse "schema /1 requires full audit payloads"
fi
[ "$PRODUCT" = "regulait" ] || refuse "manifest is not a RegulAIt export bundle (product='${PRODUCT:-<none>}')"
[ -n "$KEY_ID" ] || refuse "manifest declares no signingKeyId"
printf '%s' "$KEY_ID" | grep -qE '^[A-Za-z0-9._-]+$' || refuse \
  "signingKeyId contains characters that are not permitted in a key id: '$KEY_ID'" \
  "Key ids name a file in a pinned keyring; only [A-Za-z0-9._-] is allowed."
pass "manifest: $SCHEMA, subject '${SUBJECT_KIND:-?}', signed by key id '$KEY_ID'"

# --- 3. the key, and where it came from ------------------------------------
# Precedence is deliberate: a --keyring entry is a key the auditor already
# holds, so it is used AS the verification key. A --fingerprint pins the
# bundled copy without requiring the auditor to carry the key bytes around.
PUBKEY=""
if [ -n "$KEYRING" ]; then
  [ -d "$KEYRING" ] || refuse "keyring directory not found: $KEYRING"
  if [ ! -f "$KEYRING/$KEY_ID.pub" ]; then
    known="$(find "$KEYRING" -maxdepth 1 -name '*.pub' -exec basename {} .pub \; 2>/dev/null | LC_ALL=C sort | tr '\n' ' ')"
    refuse "UNKNOWN SIGNING KEY: '$KEY_ID'" \
      "Your keyring pins: ${known:-<none>}" \
      "A bundle signed by a key you were never given is refused even if its" \
      "signature is internally valid — that is what pinning means. If the" \
      "deployment rotated its export key, the NEW public key must reach you" \
      "through the same out-of-band channel as the old one. Bundles signed by" \
      "the OLD key stay verifiable for as long as you keep the old .pub."
  fi
  PUBKEY="$KEYRING/$KEY_ID.pub"
  pass "signing key is pinned in your keyring: $PUBKEY"
else
  [ -f "$ROOT/signing-key.pub" ] || refuse "signing-key.pub is missing from the bundle" \
    "Without --keyring there is no other copy of the public key to check the" \
    "fingerprint of, so there is nothing to verify."
  PUBKEY="$ROOT/signing-key.pub"
fi

# The fingerprint is computed from the DER SubjectPublicKeyInfo, which is what
# makes it reproducible with stock tooling and independent of PEM whitespace.
openssl pkey -pubin -in "$PUBKEY" -outform DER -out "$WORK/key.der" 2>/dev/null \
  || refuse "the public key is not a readable public key: $PUBKEY"
ACTUAL_FPR="sha256:$(sha256_of "$WORK/key.der")"

if [ -n "$DECLARED_FPR" ] && [ "$DECLARED_FPR" != "$ACTUAL_FPR" ]; then
  refuse "MANIFEST FINGERPRINT DOES NOT DESCRIBE THE KEY IT SHIPPED WITH" \
    "manifest signingKeyFingerprint: $DECLARED_FPR" \
    "actual fingerprint of the key:  $ACTUAL_FPR" \
    "The manifest names one key and a different key is present. Refuse."
fi

if [ -n "$EXPECT_FPR" ]; then
  MATCHED=0
  for f in $EXPECT_FPR; do
    [ "$f" = "$ACTUAL_FPR" ] && MATCHED=1
  done
  if [ "$MATCHED" != "1" ]; then
    refuse "UNKNOWN SIGNING KEY — fingerprint is not one you pinned" \
      "bundle's signing key: $ACTUAL_FPR" \
      "you supplied:         $EXPECT_FPR" \
      "This bundle was signed by a key you have never been given. That is the" \
      "case a self-contained bundle cannot distinguish from a genuine one, and" \
      "it is exactly why the fingerprint has to come from outside the bundle." \
      "Do not accept it. Ask the deployment's operator whether they rotated" \
      "their export signing key, through the channel you already trust."
  fi
  pass "signing key fingerprint matches the one you pinned: $ACTUAL_FPR"
else
  pass "signing key fingerprint: $ACTUAL_FPR"
fi

# --- 4. the signature ------------------------------------------------------
openssl base64 -d -A -in "$SIGFILE" -out "$WORK/sig.bin" 2>/dev/null \
  || refuse "the signature file is not valid base64"

SIG_OK=0
if openssl pkeyutl -verify -pubin -inkey "$PUBKEY" -rawin \
     -in "$MANIFEST" -sigfile "$WORK/sig.bin" >/dev/null 2>&1; then
  SIG_OK=1
elif openssl dgst -sha256 -verify "$PUBKEY" -signature "$WORK/sig.bin" "$MANIFEST" >/dev/null 2>&1; then
  SIG_OK=1
fi
[ "$SIG_OK" = "1" ] || refuse "SIGNATURE DOES NOT VERIFY under $KEY_ID" \
  "Either manifest.json was modified after signing, or it was signed by a" \
  "different private key than the one being checked against. Both mean the" \
  "same thing operationally: this is not evidence. Re-obtain the bundle over" \
  "the channel you trust."
pass "signature verifies over manifest.json's exact bytes"

# --- 5. every listed file, exactly -----------------------------------------
# The manifest is now trusted — it is what the signature covers — so from here
# on the manifest is the authority and the payload is the suspect.
LISTED="$WORK/listed.txt"
grep -oE '"path"[[:space:]]*:[[:space:]]*"[^"]*"[[:space:]]*,[[:space:]]*"sha256"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$MANIFEST" \
  | sed -E 's/.*"path"[[:space:]]*:[[:space:]]*"([^"]*)".*"sha256"[[:space:]]*:[[:space:]]*"([0-9a-f]{64})".*/\2  \1/' \
  >"$LISTED" || true
[ -s "$LISTED" ] || refuse "the signed manifest lists no files" \
  "A manifest that names nothing signs nothing."

MISSING=0; MODIFIED=0
while IFS= read -r line; do
  [ -n "$line" ] || continue
  digest="${line%%  *}"
  relpath="${line#*  }"
  if [ ! -f "$ROOT/$relpath" ]; then
    printf '  %s[missing]%s %s\n' "$C_RED" "$C_RST" "$relpath" >&2
    MISSING=$((MISSING + 1)); continue
  fi
  actual="$(sha256_of "$ROOT/$relpath")"
  if [ "$actual" != "$digest" ]; then
    printf '  %s[modified]%s %s\n' "$C_RED" "$C_RST" "$relpath" >&2
    printf '             signed digest %s\n             actual digest %s\n' "$digest" "$actual" >&2
    MODIFIED=$((MODIFIED + 1))
  fi
done <"$LISTED"

[ "$MISSING" = "0" ] || refuse "$MISSING file(s) listed in the signed manifest are MISSING from the bundle" \
  "A partial export is not a smaller export; it is an export with the" \
  "inconvenient parts removed."
[ "$MODIFIED" = "0" ] || refuse "CONTENT DIGEST MISMATCH: $MODIFIED file(s) do not match their signed digest" \
  "The manifest's signature is intact, so the alteration is in the file, not" \
  "the manifest. Whatever that file says, it is not what was signed."

LISTED_COUNT="$(wc -l <"$LISTED" | tr -d ' ')"
pass "all $LISTED_COUNT signed files match their SHA-256"

# --- 6. nothing EXTRA --------------------------------------------------
# audit/rows/*.payload are excluded here on purpose: their digests ARE the
# content hashes in audit/chain.tsv, which is itself listed and signed, and
# section 7 checks every one of them. Listing them twice would let the two
# lists disagree about the same bytes.
ACTUAL_LIST="$WORK/actual.txt"
(cd "$ROOT" && find . ! -type d -print | sed 's|^\./||') \
  | grep -v '^manifest\.json$' | grep -v '^manifest\.json\.sig$' \
  | grep -v '^audit/rows/' | LC_ALL=C sort >"$ACTUAL_LIST"
EXPECTED_LIST="$WORK/expected.txt"
sed -E 's/^[0-9a-f]{64}  //' "$LISTED" | LC_ALL=C sort >"$EXPECTED_LIST"
EXTRA="$(comm -23 "$ACTUAL_LIST" "$EXPECTED_LIST" || true)"
if [ -n "$EXTRA" ]; then
  printf '%s\n' "$EXTRA" | while IFS= read -r f; do
    printf '  %s[unlisted]%s %s\n' "$C_RED" "$C_RST" "$f" >&2
  done
  refuse "the bundle contains file(s) the signed manifest does not list" \
    "Everything in an evidence bundle must be named in what was signed, or the" \
    "signature covers less than the bundle does."
fi
pass "bundle contains nothing the manifest does not list"

# --- 7. the audit chain ----------------------------------------------------
CHAIN="$ROOT/audit/chain.tsv"
[ -f "$CHAIN" ] || refuse "audit/chain.tsv is missing" \
  "The chain is what ties this export to a tamper-evident record. Without it" \
  "the signature covers a file nobody can place in a history."

HEAD_SEQ="$(grep -m1 -oE '"seq"[[:space:]]*:[[:space:]]*[0-9]+' "$MANIFEST" | grep -oE '[0-9]+' || true)"
HEAD_ROWHASH="$(grep -m1 -oE '"rowHash"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$MANIFEST" | grep -oE '[0-9a-f]{64}' || true)"
GENESIS_PREV="$(grep -m1 -oE '"genesisPrevHash"[[:space:]]*:[[:space:]]*"[0-9a-f]{64}"' "$MANIFEST" | grep -oE '[0-9a-f]{64}' || true)"
SEG_FROM="$(grep -m1 -oE '"segmentFromSeq"[[:space:]]*:[[:space:]]*[0-9]+' "$MANIFEST" | grep -oE '[0-9]+' || true)"
TRUNCATED="$(grep -m1 -oE '"segmentTruncated"[[:space:]]*:[[:space:]]*(true|false)' "$MANIFEST" | grep -oE '(true|false)' || true)"
EXPECTED_PAYLOADS="$WORK/expected-payloads.txt"
: >"$EXPECTED_PAYLOADS"

if [ ! -s "$CHAIN" ]; then
  if [ -n "$HEAD_ROWHASH" ]; then
    refuse "CHAIN SEGMENT IS EMPTY but the signed manifest records a chain head" \
      "The manifest says the deployment's audit chain reaches seq ${HEAD_SEQ:-?}," \
      "and the bundle carries no rows to show for it. The rows were removed."
  fi
  note "the manifest records NO chain head: this deployment's audit log was never chained."
  note "the content is signed, but nothing here ties it to a tamper-evident record."
else
  ROWS=0; PREV=""; EXPECT_SEQ=""
  LAST_SEQ=""; LAST_ROWHASH=""
  while IFS=$'\t' read -r seq chash phash rhash disclosure; do
    [ -n "${seq:-}" ] || continue
    printf '%s' "$seq" | grep -qE '^[0-9]+$' || refuse "invalid audit sequence in chain.tsv"
    if [ "$SCHEMA" = "regulait.export-bundle/2" ]; then
      [ "$disclosure" = "payload" ] || [ "$disclosure" = "commitment" ] || refuse "invalid audit disclosure at seq $seq"
    else
      [ -z "${disclosure:-}" ] || refuse "unexpected audit disclosure at seq $seq"
      disclosure="payload"
    fi
    PFILE="$ROOT/audit/rows/$seq.payload"
    # `[ -f ]`, `[ -e ]` and sha256sum all FOLLOW a symlink, so the link is
    # tested for first: a listed payload that is a link is refused as one,
    # never hashed through to whatever it names.
    [ ! -L "$PFILE" ] || refuse_nonregular 1
    if [ "$disclosure" = "payload" ]; then
      printf 'audit/rows/%s.payload\n' "$seq" >>"$EXPECTED_PAYLOADS"
      [ -f "$PFILE" ] || refuse "AUDIT ROW MISSING: audit/rows/$seq.payload" \
        "chain.tsv marks seq $seq disclosed but its bytes are absent."
    elif [ -e "$PFILE" ]; then
      refuse "AUDIT ROW DISCLOSED WITHOUT AUTHORITY at seq $seq" \
        "chain.tsv marks this row as a commitment only."
    fi

    # The four checks run in ADR-0060's own order — ORDER, LINKAGE, CONTENT,
    # then the linked value — so that the FIRST thing reported is the closest
    # description of what was actually done. A deleted row shows up as a gap
    # rather than as whatever downstream hash the deletion happened to break.

    # (a) ORDER. A deletion shows up here first.
    if [ -n "$PREV" ] && [ "$seq" != "$EXPECT_SEQ" ]; then
      refuse "CHAIN BROKEN — sequence gap: expected seq $EXPECT_SEQ, found $seq" \
        "$((seq - EXPECT_SEQ)) row(s) were deleted or renumbered between them." \
        "Rows are consecutive by construction; a hole is a removal."
    fi

    # (b) LINKAGE. Reordering and predecessor-replacement land here.
    if [ -n "$PREV" ] && [ "$phash" != "$PREV" ]; then
      refuse "CHAIN BROKEN at seq $seq — prev_hash does not name the preceding row's row_hash" \
        "expected prev_hash: $PREV" \
        "recorded prev_hash: $phash" \
        "A row was moved, replaced or removed, or a segment from a different" \
        "deployment's log was spliced in here."
    fi

    # (c) CONTENT. Does the row's own text hash to the content_hash it claims?
    if [ "$disclosure" = "payload" ]; then
      ACTUAL_C="$(sha256_of "$PFILE")"
      if [ "$ACTUAL_C" != "$chash" ]; then
        refuse "AUDIT ROW TAMPERED at seq $seq — content_hash does not cover its bytes" \
          "recorded content_hash: $chash" \
          "hash of the row bytes: $ACTUAL_C" \
          "The audit record in audit/rows/$seq.payload was edited after it was" \
          "written. Read that file: its text is the record that was changed."
      fi
    fi

    # (d) THE LINKED VALUE itself.
    ACTUAL_R="$(printf '%s%s' "$phash" "$chash" | { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi } | awk '{print $1}')"
    if [ "$ACTUAL_R" != "$rhash" ]; then
      refuse "CHAIN BROKEN at seq $seq — row_hash does not follow from prev_hash and content_hash" \
        "recorded row_hash:   $rhash" \
        "recomputed row_hash: $ACTUAL_R" \
        "row_hash must equal SHA-256(prev_hash || content_hash). The stored" \
        "linked value was edited directly."
    fi

    if [ -z "$PREV" ]; then
      if [ -n "$SEG_FROM" ] && [ "$seq" != "$SEG_FROM" ]; then
        refuse "CHAIN BROKEN — the segment does not start where the signed manifest says" \
          "manifest segmentFromSeq: $SEG_FROM" \
          "first row in chain.tsv:  $seq" \
          "Rows were removed from the front of the segment."
      fi
      if [ "$seq" = "1" ] && [ -n "$GENESIS_PREV" ] && [ "$phash" != "$GENESIS_PREV" ]; then
        refuse "CHAIN BROKEN at the genesis row — prev_hash is not the genesis value" \
          "expected: $GENESIS_PREV" \
          "found:    $phash"
      fi
    fi

    PREV="$rhash"; EXPECT_SEQ=$((seq + 1)); ROWS=$((ROWS + 1))
    LAST_SEQ="$seq"; LAST_ROWHASH="$rhash"
  done <"$CHAIN"

  # (d) does the segment end at the head the manifest SIGNED?
  if [ -n "$HEAD_ROWHASH" ]; then
    if [ "$LAST_ROWHASH" != "$HEAD_ROWHASH" ] || [ "$LAST_SEQ" != "$HEAD_SEQ" ]; then
      refuse "CHAIN HEAD MISMATCH — the segment does not end at the head the manifest signed" \
        "manifest head:     seq $HEAD_SEQ  $HEAD_ROWHASH" \
        "segment ends at:   seq ${LAST_SEQ:-<none>}  ${LAST_ROWHASH:-<none>}" \
        "The rows in this bundle are not the rows the signed head commits to —" \
        "a different chain, or a different point in the same chain, was" \
        "substituted. If you retained an anchored head of your own, compare it" \
        "to the manifest head before you conclude which side moved."
    fi
    pass "audit chain: $ROWS rows verify and end at the signed head (seq $HEAD_SEQ)"
  else
    pass "audit chain: $ROWS rows verify internally (the manifest records no head)"
  fi

  if [ "$TRUNCATED" = "true" ]; then
    note "DISCLOSED: the chain segment is TRUNCATED — it does not reach the genesis row,"
    note "so this bundle alone does not prove the chain is intact before seq ${SEG_FROM:-?}."
  elif [ "$SEG_FROM" != "1" ]; then
    note "the segment starts at seq ${SEG_FROM:-?}, not at the genesis row: this bundle"
    note "alone does not prove the chain is intact before that point."
  fi
  if [ "$SCHEMA" = "regulait.export-bundle/2" ]; then
    note "subject-scoped audit proof: undisclosed rows have signed hash commitments only;"
    note "their source bytes cannot be independently rehashed from this bundle."
  fi
fi
# A disclosed payload is named by its decimal sequence number and NOTHING
# else: audit/rows/<seq>.payload, written exactly as chain.tsv writes <seq> —
# no leading zero, no sign, no suffix, no subdirectory. The shape is checked
# by name, NUL-delimited, BEFORE the line-oriented set comparison below, so a
# name that only LOOKS listed — a leading zero a numeric comparison would fold
# onto a real row, a stray character, a newline that a line-oriented pass
# would split and then swallow as a blank line — is refused here, by name.
PAYLOAD_NAME_RE='^(0|[1-9][0-9]*)\.payload$'
MALFORMED=0
while IFS= read -r -d '' f; do
  if ! [[ "${f#audit/rows/}" =~ $PAYLOAD_NAME_RE ]]; then
    printf '  %s[malformed]%s %q\n' "$C_RED" "$C_RST" "$f" >&2
    MALFORMED=$((MALFORMED + 1))
  fi
done < <(cd "$ROOT" && find audit/rows ! -type d -print0 2>/dev/null || true)
[ "$MALFORMED" = "0" ] || refuse \
  "AUDIT PAYLOAD NAME MALFORMED: $MALFORMED file(s) under audit/rows are not named by a sequence number" \
  "A disclosed row is audit/rows/<seq>.payload with <seq> spelled exactly as" \
  "chain.tsv spells it. Any other spelling of the same number is a file the" \
  "chain never named, and nothing in this bundle vouches for its bytes."
ACTUAL_PAYLOADS="$WORK/actual-payloads.txt"
(cd "$ROOT" && find audit/rows ! -type d -print 2>/dev/null || true) | LC_ALL=C sort >"$ACTUAL_PAYLOADS"
LC_ALL=C sort -o "$EXPECTED_PAYLOADS" "$EXPECTED_PAYLOADS"
EXTRA_PAYLOADS="$(comm -23 "$ACTUAL_PAYLOADS" "$EXPECTED_PAYLOADS" || true)"
if [ -n "$EXTRA_PAYLOADS" ]; then
  printf '%s\n' "$EXTRA_PAYLOADS" | while IFS= read -r f; do
    printf '  %s[unlisted]%s %s\n' "$C_RED" "$C_RST" "$f" >&2
  done
  refuse "the bundle contains unlisted audit payloads" \
    "Every disclosed audit payload must be named by the signed chain."
fi

# --- 8. optional: place the verified bundle --------------------------------
if [ -n "$EXTRACT_TO" ]; then
  if [ -e "$EXTRACT_TO" ] && [ -n "$(ls -A "$EXTRACT_TO" 2>/dev/null || true)" ]; then
    refuse "--extract-to $EXTRACT_TO is not empty" \
      "Refusing to overlay a verified bundle onto an unknown tree."
  fi
  mkdir -p "$EXTRACT_TO"
  (cd "$ROOT" && tar -cf - .) | (cd "$EXTRACT_TO" && tar -xf -)
  pass "verified bundle extracted to $EXTRACT_TO"
fi

if [ "$QUIET" != "1" ]; then
  printf '\n%s[VERIFIED]%s regulait export — subject %s, install %s\n' \
    "$C_GRN" "$C_RST" "${SUBJECT_KIND:-?}" "${INSTALL_ID:-<none recorded>}"
  printf '           exported %s (database clock), signed by %s\n' "${EXPORTED_AT:-?}" "$KEY_ID"
  printf '           %s\n\n' "$ACTUAL_FPR"
fi
exit 0
