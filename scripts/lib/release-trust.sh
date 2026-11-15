# shellcheck shell=bash
# =============================================================================
# RegulAIt release trust: keyring statement and provenance (ADR-0324)
#
# Sourced by scripts/verify-release.sh (the customer's offline verifier) and
# scripts/release-ceremony.sh (the key ceremony tool). Nothing here makes a
# network call; it needs bash, coreutils and openssl only.
#
# The keyring statement (infra/release-keys/keyring.json) is the one document
# the offline ROOT keys sign. It names:
#   * the root keys and how many of them must sign the NEXT statement (threshold)
#   * the release signing keys, what each may sign, and until when
#   * the CI workflow whose provenance a release must carry (builder)
#   * every revoked key id
#
# ONE READING ONLY. The parser reads the fields, then re-renders the statement
# in its canonical form and requires the bytes to be identical. A statement
# with a duplicated field, a reordered list, extra whitespace or anything this
# renderer would not have written is refused, so the bytes the roots signed
# cannot mean two different things to two different readers.
# =============================================================================

KR_SCHEMA="regulait.release-keyring/1"
KR_ID_RE='^[A-Za-z0-9._-]{1,64}$'
KR_PURPOSES_ALLOWED="update-bundle provenance license"

kr_sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else openssl dgst -sha256 | awk '{print $NF}'; fi
}
kr_sha256_file() { kr_sha256_stdin <"$1"; }

# SHA-256 of the DER SubjectPublicKeyInfo: the same fingerprint
# infra/release-keys/README.md has always published.
kr_fingerprint() { openssl pkey -pubin -in "$1" -outform DER 2>/dev/null | kr_sha256_stdin; }

kr_is_ed25519_pub() { openssl pkey -pubin -in "$1" -noout -text 2>/dev/null | grep -q '^ED25519 Public-Key'; }

# kr_verify_sig <pub.pem> <message-file> <base64-signature-file>
kr_verify_sig() {
  local pub="$1" msg="$2" sigb64="$3" bin
  [ -f "$sigb64" ] || return 1
  bin="$(mktemp)"
  if ! openssl base64 -d -A -in "$sigb64" -out "$bin" 2>/dev/null; then rm -f "$bin"; return 1; fi
  if openssl pkeyutl -verify -pubin -inkey "$pub" -rawin -in "$msg" -sigfile "$bin" >/dev/null 2>&1; then
    rm -f "$bin"; return 0
  fi
  rm -f "$bin"; return 1
}

kr_reset() {
  KR_SERIAL=""; KR_ISSUED=""; KR_THRESHOLD=""; KR_BUILDER=""
  KR_ROOT_IDS=(); KR_ROOT_FPS=()
  KR_KEY_IDS=(); KR_KEY_FPS=(); KR_KEY_NOTAFTER=(); KR_KEY_PURPOSES=()
  KR_REVOKED=()
  KR_ERR=""
}

# Prints the canonical statement for the current KR_* values.
kr_render() {
  local i n
  printf '{\n'
  printf '  "schema": "%s",\n' "$KR_SCHEMA"
  printf '  "serial": %s,\n' "$KR_SERIAL"
  printf '  "issuedAt": "%s",\n' "$KR_ISSUED"
  printf '  "threshold": %s,\n' "$KR_THRESHOLD"
  printf '  "builder": "%s",\n' "$KR_BUILDER"
  printf '  "roots": [\n'
  n=${#KR_ROOT_IDS[@]}
  for ((i = 0; i < n; i++)); do
    printf '    { "id": "%s", "sha256": "%s" }' "${KR_ROOT_IDS[$i]}" "${KR_ROOT_FPS[$i]}"
    if [ "$i" -lt $((n - 1)) ]; then printf ',\n'; else printf '\n'; fi
  done
  printf '  ],\n'
  printf '  "keys": [\n'
  n=${#KR_KEY_IDS[@]}
  for ((i = 0; i < n; i++)); do
    printf '    { "id": "%s", "sha256": "%s", "notAfter": "%s", "purposes": "%s" }' \
      "${KR_KEY_IDS[$i]}" "${KR_KEY_FPS[$i]}" "${KR_KEY_NOTAFTER[$i]}" "${KR_KEY_PURPOSES[$i]}"
    if [ "$i" -lt $((n - 1)) ]; then printf ',\n'; else printf '\n'; fi
  done
  printf '  ],\n'
  if [ "${#KR_REVOKED[@]}" -eq 0 ]; then
    printf '  "revoked": []\n'
  else
    printf '  "revoked": ['
    n=${#KR_REVOKED[@]}
    for ((i = 0; i < n; i++)); do
      printf ' "%s"' "${KR_REVOKED[$i]}"
      if [ "$i" -lt $((n - 1)) ]; then printf ','; fi
    done
    printf ' ]\n'
  fi
  printf '}\n'
}

# Semantic checks on the current KR_* values. Sets KR_ERR and returns 1 on the first problem.
kr_check() {
  local i j p seen
  [[ "$KR_SERIAL" =~ ^[1-9][0-9]{0,8}$ ]] || { KR_ERR="serial must be a positive integer"; return 1; }
  [[ "$KR_ISSUED" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { KR_ERR="issuedAt must be an RFC 3339 UTC time"; return 1; }
  [[ "$KR_THRESHOLD" =~ ^[1-9]$ ]] || { KR_ERR="threshold must be 1-9"; return 1; }
  [[ "$KR_BUILDER" =~ ^https://[A-Za-z0-9._/-]+\.ya?ml$ ]] || { KR_ERR="builder must be the https URL of a workflow file (no @ref)"; return 1; }
  [ "${#KR_ROOT_IDS[@]}" -ge 1 ] || { KR_ERR="a keyring needs at least one root key"; return 1; }
  [ "$KR_THRESHOLD" -le "${#KR_ROOT_IDS[@]}" ] || { KR_ERR="threshold $KR_THRESHOLD is more than the ${#KR_ROOT_IDS[@]} root key(s)"; return 1; }
  for ((i = 0; i < ${#KR_ROOT_IDS[@]}; i++)); do
    [[ "${KR_ROOT_IDS[$i]}" =~ $KR_ID_RE ]] || { KR_ERR="bad root id '${KR_ROOT_IDS[$i]}'"; return 1; }
    [[ "${KR_ROOT_FPS[$i]}" =~ ^[0-9a-f]{64}$ ]] || { KR_ERR="bad root fingerprint for ${KR_ROOT_IDS[$i]}"; return 1; }
    for ((j = 0; j < i; j++)); do
      [ "${KR_ROOT_IDS[$i]}" != "${KR_ROOT_IDS[$j]}" ] || { KR_ERR="root id listed twice: ${KR_ROOT_IDS[$i]}"; return 1; }
      [ "${KR_ROOT_FPS[$i]}" != "${KR_ROOT_FPS[$j]}" ] || { KR_ERR="the same root key is listed twice under two ids"; return 1; }
    done
  done
  for ((i = 0; i < ${#KR_KEY_IDS[@]}; i++)); do
    [[ "${KR_KEY_IDS[$i]}" =~ $KR_ID_RE ]] || { KR_ERR="bad signing key id '${KR_KEY_IDS[$i]}'"; return 1; }
    [[ "${KR_KEY_FPS[$i]}" =~ ^[0-9a-f]{64}$ ]] || { KR_ERR="bad fingerprint for ${KR_KEY_IDS[$i]}"; return 1; }
    [[ "${KR_KEY_NOTAFTER[$i]}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || { KR_ERR="bad notAfter for ${KR_KEY_IDS[$i]}"; return 1; }
    [[ "${KR_KEY_PURPOSES[$i]}" =~ ^[a-z-]+(,[a-z-]+)*$ ]] || { KR_ERR="bad purposes for ${KR_KEY_IDS[$i]}"; return 1; }
    for p in ${KR_KEY_PURPOSES[$i]//,/ }; do
      case " $KR_PURPOSES_ALLOWED " in *" $p "*) ;; *) KR_ERR="unknown purpose '$p' on ${KR_KEY_IDS[$i]}"; return 1 ;; esac
    done
    for ((j = 0; j < ${#KR_ROOT_IDS[@]}; j++)); do
      [ "${KR_KEY_IDS[$i]}" != "${KR_ROOT_IDS[$j]}" ] || { KR_ERR="${KR_KEY_IDS[$i]} is both a root and a signing key"; return 1; }
      [ "${KR_KEY_FPS[$i]}" != "${KR_ROOT_FPS[$j]}" ] || { KR_ERR="a root key is also listed as a signing key: roots never sign releases"; return 1; }
    done
    for ((j = 0; j < i; j++)); do
      [ "${KR_KEY_IDS[$i]}" != "${KR_KEY_IDS[$j]}" ] || { KR_ERR="signing key id listed twice: ${KR_KEY_IDS[$i]}"; return 1; }
    done
  done
  for seen in "${KR_REVOKED[@]}"; do
    [[ "$seen" =~ $KR_ID_RE ]] || { KR_ERR="bad revoked id '$seen'"; return 1; }
    for ((j = 0; j < ${#KR_KEY_IDS[@]}; j++)); do
      [ "$seen" != "${KR_KEY_IDS[$j]}" ] || { KR_ERR="$seen is listed as both active and revoked"; return 1; }
    done
    for ((j = 0; j < ${#KR_ROOT_IDS[@]}; j++)); do
      [ "$seen" != "${KR_ROOT_IDS[$j]}" ] || { KR_ERR="$seen is listed as both a root and revoked"; return 1; }
    done
  done
  return 0
}

# kr_parse <keyring.json>: fills KR_*; returns 1 with KR_ERR on anything not canonical.
kr_parse() {
  local file="$1" line rendered rid
  kr_reset
  [ -f "$file" ] || { KR_ERR="not found: $file"; return 1; }
  grep -qx "  \"schema\": \"$KR_SCHEMA\"," "$file" || { KR_ERR="not a $KR_SCHEMA statement"; return 1; }
  KR_SERIAL="$(sed -nE 's/^  "serial": ([0-9]+),$/\1/p' "$file" | head -1)"
  KR_ISSUED="$(sed -nE 's/^  "issuedAt": "([^"]*)",$/\1/p' "$file" | head -1)"
  KR_THRESHOLD="$(sed -nE 's/^  "threshold": ([0-9]+),$/\1/p' "$file" | head -1)"
  KR_BUILDER="$(sed -nE 's/^  "builder": "([^"]*)",$/\1/p' "$file" | head -1)"
  while IFS= read -r line; do
    if [[ "$line" =~ ^\ \ \ \ \{\ \"id\":\ \"([^\"]+)\",\ \"sha256\":\ \"([^\"]+)\"\ \},?$ ]]; then
      KR_ROOT_IDS+=("${BASH_REMATCH[1]}"); KR_ROOT_FPS+=("${BASH_REMATCH[2]}")
    elif [[ "$line" =~ ^\ \ \ \ \{\ \"id\":\ \"([^\"]+)\",\ \"sha256\":\ \"([^\"]+)\",\ \"notAfter\":\ \"([^\"]+)\",\ \"purposes\":\ \"([^\"]+)\"\ \},?$ ]]; then
      KR_KEY_IDS+=("${BASH_REMATCH[1]}"); KR_KEY_FPS+=("${BASH_REMATCH[2]}")
      KR_KEY_NOTAFTER+=("${BASH_REMATCH[3]}"); KR_KEY_PURPOSES+=("${BASH_REMATCH[4]}")
    fi
  done <"$file"
  line="$(grep -m1 -E '^  "revoked": \[' "$file" || true)"
  if [ -n "$line" ]; then
    while IFS= read -r rid; do [ -n "$rid" ] && KR_REVOKED+=("$rid"); done \
      < <(printf '%s' "${line#*[}" | grep -oE '"[^"]*"' | tr -d '"')
  fi
  kr_check || return 1
  rendered="$(mktemp)"
  kr_render >"$rendered"
  if ! cmp -s "$rendered" "$file"; then
    rm -f "$rendered"
    KR_ERR="the statement is not in canonical form (a duplicated or reordered field, extra whitespace, or a hand edit)"
    return 1
  fi
  rm -f "$rendered"
  return 0
}

# Copy the parsed statement into T_* (the trusted, installed one).
kr_save_as_trust() {
  T_SERIAL="$KR_SERIAL"; T_THRESHOLD="$KR_THRESHOLD"; T_BUILDER="$KR_BUILDER"
  T_ROOT_IDS=("${KR_ROOT_IDS[@]}"); T_ROOT_FPS=("${KR_ROOT_FPS[@]}")
  T_REVOKED=("${KR_REVOKED[@]}")
}

# kr_count_sigs <statement> <root-pub-dir> <ids-array-name> <fps-array-name>
# Counts distinct roots (from the named arrays) whose signature
# <statement>.sig.<id> verifies under <root-pub-dir>/<id>.pub, where that
# file's fingerprint must equal the listed one. Prints the count.
kr_count_sigs() {
  local stmt="$1" pubdir="$2" idsname="$3" fpsname="$4" i count=0 id fp pub
  local -n _ids="$idsname"
  local -n _fps="$fpsname"
  for ((i = 0; i < ${#_ids[@]}; i++)); do
    id="${_ids[$i]}"; fp="${_fps[$i]}"; pub="$pubdir/$id.pub"
    [ -f "$pub" ] || continue
    [ "$(kr_fingerprint "$pub")" = "$fp" ] || continue
    kr_is_ed25519_pub "$pub" || continue
    if kr_verify_sig "$pub" "$stmt" "$stmt.sig.$id"; then count=$((count + 1)); fi
  done
  printf '%s\n' "$count"
}

# kr_root_files_match <keyring-dir>: every listed root has root/<id>.pub with the listed fingerprint,
# and root/ holds no other key.
kr_root_files_match() {
  local dir="$1" i f base listed
  for ((i = 0; i < ${#KR_ROOT_IDS[@]}; i++)); do
    f="$dir/root/${KR_ROOT_IDS[$i]}.pub"
    [ -f "$f" ] || { KR_ERR="root key file missing: root/${KR_ROOT_IDS[$i]}.pub"; return 1; }
    [ "$(kr_fingerprint "$f")" = "${KR_ROOT_FPS[$i]}" ] || { KR_ERR="root/${KR_ROOT_IDS[$i]}.pub does not match its listed fingerprint"; return 1; }
    kr_is_ed25519_pub "$f" || { KR_ERR="root/${KR_ROOT_IDS[$i]}.pub is not an Ed25519 public key"; return 1; }
  done
  for f in "$dir"/root/*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    listed=0
    for ((i = 0; i < ${#KR_ROOT_IDS[@]}; i++)); do [ "$base" = "${KR_ROOT_IDS[$i]}.pub" ] && listed=1; done
    [ "$listed" = "1" ] || { KR_ERR="root/$base is not a root the statement lists"; return 1; }
  done
  return 0
}

# kr_signing_files_match <keyring-dir>: every top-level *.pub is an active signing key with the listed
# fingerprint (the flat keyring the older verifiers read must never hold a key the roots did not authorise).
kr_signing_files_match() {
  local dir="$1" f id i found
  for f in "$dir"/*.pub; do
    [ -e "$f" ] || continue
    id="$(basename "$f" .pub)"
    found=-1
    for ((i = 0; i < ${#KR_KEY_IDS[@]}; i++)); do [ "${KR_KEY_IDS[$i]}" = "$id" ] && found=$i; done
    [ "$found" -ge 0 ] || { KR_ERR="$id.pub is in the keyring directory but the statement does not authorise it (remove it, or list it at a ceremony)"; return 1; }
    [ "$(kr_fingerprint "$f")" = "${KR_KEY_FPS[$found]}" ] || { KR_ERR="$id.pub does not match its listed fingerprint"; return 1; }
    kr_is_ed25519_pub "$f" || { KR_ERR="$id.pub is not an Ed25519 public key"; return 1; }
  done
  for ((i = 0; i < ${#KR_KEY_IDS[@]}; i++)); do
    [ -f "$dir/${KR_KEY_IDS[$i]}.pub" ] || { KR_ERR="the statement lists ${KR_KEY_IDS[$i]} but ${KR_KEY_IDS[$i]}.pub is missing"; return 1; }
  done
  return 0
}

# kr_verify_dir <keyring-dir>: the statement in <dir> is canonical, its root files match, it is signed by
# at least <threshold> of its OWN roots, and the flat .pub files are exactly its signing keys.
kr_verify_dir() {
  local dir="$1" n
  kr_parse "$dir/keyring.json" || return 1
  kr_root_files_match "$dir" || return 1
  n="$(kr_count_sigs "$dir/keyring.json" "$dir/root" KR_ROOT_IDS KR_ROOT_FPS)"
  [ "$n" -ge "$KR_THRESHOLD" ] || { KR_ERR="signed by $n of its roots; its threshold is $KR_THRESHOLD"; return 1; }
  kr_signing_files_match "$dir" || return 1
  return 0
}

# -----------------------------------------------------------------------------
# Provenance: an in-toto v1 statement with an SLSA v1 predicate, in ONE fixed
# shape. Its single subject is the bundle's manifest.json (which names every
# payload file by digest, so the provenance covers the payload transitively).
# Written by scripts/release-provenance.sh; read back the same way as the
# keyring: extract, re-render, compare bytes.
# -----------------------------------------------------------------------------
PV_BUILD_TYPE="https://actions.github.io/buildtypes/workflow/v1"

pv_reset() { PV_SUBJECT=""; PV_REPO=""; PV_PATH=""; PV_REF=""; PV_COMMIT=""; PV_BUILDER=""; PV_INVOCATION=""; PV_STARTED=""; PV_ERR=""; }

pv_render() {
  printf '{\n'
  printf '  "_type": "https://in-toto.io/Statement/v1",\n'
  printf '  "subject": [\n'
  printf '    { "name": "manifest.json", "digest": { "sha256": "%s" } }\n' "$PV_SUBJECT"
  printf '  ],\n'
  printf '  "predicateType": "https://slsa.dev/provenance/v1",\n'
  printf '  "predicate": {\n'
  printf '    "buildDefinition": {\n'
  printf '      "buildType": "%s",\n' "$PV_BUILD_TYPE"
  printf '      "externalParameters": {\n'
  printf '        "workflow": {\n'
  printf '          "ref": "%s",\n' "$PV_REF"
  printf '          "repository": "%s",\n' "$PV_REPO"
  printf '          "path": "%s"\n' "$PV_PATH"
  printf '        }\n'
  printf '      },\n'
  printf '      "resolvedDependencies": [\n'
  printf '        { "uri": "git+%s@%s", "digest": { "gitCommit": "%s" } }\n' "$PV_REPO" "$PV_REF" "$PV_COMMIT"
  printf '      ]\n'
  printf '    },\n'
  printf '    "runDetails": {\n'
  printf '      "builder": {\n'
  printf '        "id": "%s"\n' "$PV_BUILDER"
  printf '      },\n'
  printf '      "metadata": {\n'
  printf '        "invocationId": "%s",\n' "$PV_INVOCATION"
  printf '        "startedOn": "%s"\n' "$PV_STARTED"
  printf '      }\n'
  printf '    }\n'
  printf '  }\n'
  printf '}\n'
}

pv_check() {
  [[ "$PV_SUBJECT" =~ ^[0-9a-f]{64}$ ]] || { PV_ERR="subject digest is not a SHA-256"; return 1; }
  [[ "$PV_REPO" =~ ^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { PV_ERR="repository is not a GitHub repository URL"; return 1; }
  [[ "$PV_PATH" =~ ^\.github/workflows/[A-Za-z0-9_.-]+\.ya?ml$ ]] || { PV_ERR="path is not a workflow file"; return 1; }
  [[ "$PV_REF" =~ ^refs/tags/v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { PV_ERR="ref is not a release tag (refs/tags/vX.Y.Z)"; return 1; }
  [[ "$PV_COMMIT" =~ ^[0-9a-f]{40}$ ]] || { PV_ERR="commit is not a 40-character SHA"; return 1; }
  [ "$PV_BUILDER" = "$PV_REPO/$PV_PATH" ] || { PV_ERR="builder id is not repository/path"; return 1; }
  [[ "$PV_INVOCATION" =~ ^https://[A-Za-z0-9._/-]+$ ]] || { PV_ERR="invocationId is not an https URL"; return 1; }
  [[ "$PV_STARTED" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { PV_ERR="startedOn is not an RFC 3339 UTC time"; return 1; }
  return 0
}

pv_parse() {
  local file="$1" rendered
  pv_reset
  [ -f "$file" ] || { PV_ERR="not found: $file"; return 1; }
  PV_SUBJECT="$(sed -nE 's/^    \{ "name": "manifest.json", "digest": \{ "sha256": "([^"]*)" \} \}$/\1/p' "$file" | head -1)"
  PV_REF="$(sed -nE 's/^          "ref": "([^"]*)",$/\1/p' "$file" | head -1)"
  PV_REPO="$(sed -nE 's/^          "repository": "([^"]*)",$/\1/p' "$file" | head -1)"
  PV_PATH="$(sed -nE 's/^          "path": "([^"]*)"$/\1/p' "$file" | head -1)"
  PV_COMMIT="$(sed -nE 's/^        \{ "uri": "[^"]*", "digest": \{ "gitCommit": "([^"]*)" \} \}$/\1/p' "$file" | head -1)"
  PV_BUILDER="$(sed -nE 's/^        "id": "([^"]*)"$/\1/p' "$file" | head -1)"
  PV_INVOCATION="$(sed -nE 's/^        "invocationId": "([^"]*)",$/\1/p' "$file" | head -1)"
  PV_STARTED="$(sed -nE 's/^        "startedOn": "([^"]*)"$/\1/p' "$file" | head -1)"
  pv_check || return 1
  rendered="$(mktemp)"
  pv_render >"$rendered"
  if ! cmp -s "$rendered" "$file"; then
    rm -f "$rendered"
    PV_ERR="the provenance is not in canonical form (a duplicated or reordered field, or a hand edit)"
    return 1
  fi
  rm -f "$rendered"
  return 0
}
