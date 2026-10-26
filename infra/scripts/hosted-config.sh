#!/bin/bash
# hosted-config.sh — which hostname the on-box TLS front serves (ADR-0202 lane H),
# and whether the laptop's Cloudflare Tunnel front is configured (ADR-0203 lane T).
#
#   hosted-config.sh want-host <path/to/.env>
#   hosted-config.sh tunnel-check <path/to/.env> [--sso]
#
# Prints the hostname Caddy must serve, or nothing:
#
#   * REGULAIT_PUBLIC_HOST unset or empty  -> prints nothing, exit 0. The box stays
#     on the address-derived name (ADR-0029); boot-resync.sh computes that one.
#   * REGULAIT_PUBLIC_HOST set and valid   -> prints the host, exit 0 (the hosted
#     demo: a name the owner registered with one DNS A record).
#   * REGULAIT_PUBLIC_HOST set but invalid, or inconsistent with
#     REGULAIT_PUBLIC_URL / REGULAIT_KC_HOSTNAME -> the reason on stderr, exit 2.
#     The caller must then leave the stack untouched: it must NOT fall back to the
#     address-derived name, because that would silently move the deployment off
#     the name its DNS record, its certificate and its OAuth callbacks point at.
#
# The .env file is PARSED, never sourced: it is operator-written and must not run.
# Only lines of the form NAME=value are read; surrounding quotes are stripped.
#
# Consistency rules (fail closed):
#   - REGULAIT_PUBLIC_HOST is a lowercase DNS name with at least two labels; not an
#     IP literal, not localhost, no port, no path, not under .invalid/.localhost.
#   - REGULAIT_PUBLIC_URL must be exactly https://<host> (a trailing / is allowed).
#     It is the origin every outbound link, OAuth callback and the Keycloak
#     redirect URI is built from, so a second spelling is a second origin.
#   - REGULAIT_KC_HOSTNAME, when set, must be exactly https://<host>/idp: the
#     sign-in service is published on the same name under /idp (one DNS record,
#     one certificate; infra/caddy/Caddyfile).
#
# tunnel-check (the `tunnel` compose profile, docs/deployment/TUNNEL.md) exits 0
# and prints one "ok" line only when the stack is safe to start; otherwise it
# prints every reason on stderr and exits 2. Run it before
# `docker compose --profile tunnel up -d`. Values are resolved the way compose
# resolves them: a variable set in the calling environment wins over .env.
#   - REGULAIT_PUBLIC_HOST must be set and valid (the rules above). Unlike
#     want-host there is no fallback name: the tunnel has no address-derived one.
#   - REGULAIT_PUBLIC_URL must be exactly https://<host> (a trailing / allowed).
#   - REGULAIT_CF_TUNNEL_TOKEN must be set, one token with no whitespace. Its
#     value is never printed.
#   - REGULAIT_TRUSTED_PROXIES and REGULAIT_KC_TRUSTED_PROXIES, when set, must be
#     exactly 172.28.0.2 (the front's fixed address, ADR-0031): anything else
#     either loses the Secure cookie flag and the client IP, or trusts more than
#     the front.
#   - COMPOSE_PROFILES must not also name `hosted` or `tls` (one public door).
#   - With --sso, or `sso` in COMPOSE_PROFILES: REGULAIT_KC_HOSTNAME must be
#     exactly https://<host>/idp and REGULAIT_KC_RELATIVE_PATH exactly /idp.
#     Without them, REGULAIT_KC_HOSTNAME, when set, must still be that value.
set -uo pipefail

usage() {
  echo "usage: $0 want-host <env-file>" >&2
  echo "       $0 tunnel-check <env-file> [--sso]" >&2
  exit 64
}

# env_value FILE NAME — the last NAME=value assignment in FILE, quotes stripped.
env_value() {
  local file="$1" name="$2" line value=""
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in
      "$name="*) value="${line#"$name="}" ;;
      "export $name="*) value="${line#"export $name="}" ;;
    esac
  done < "$file"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

# resolved_value FILE NAME — what compose would use: the calling environment's
# value when NAME is set there (even to empty), else the .env file's.
resolved_value() {
  local file="$1" name="$2"
  if [ -n "${!name+x}" ]; then
    printf '%s' "${!name}"
  else
    env_value "$file" "$name"
  fi
}

fail() {
  echo "hosted-config: $*" >&2
  exit 2
}

valid_dns_name() {
  local host="$1" label
  [ "${#host}" -le 253 ] || return 1
  # lowercase letters, digits, hyphens and dots only; at least one dot
  [[ "$host" =~ ^[a-z0-9.-]+$ ]] || return 1
  [[ "$host" == *.* ]] || return 1
  [[ "$host" == .* || "$host" == *. || "$host" == *..* ]] && return 1
  # not an IPv4 literal (the address-derived mode exists for that)
  [[ "$host" =~ ^[0-9.]+$ ]] && return 1
  case "$host" in
    localhost | *.localhost | *.invalid | *.local) return 1 ;;
  esac
  IFS='.' read -r -a labels <<< "$host"
  [ "${#labels[@]}" -ge 2 ] || return 1
  for label in "${labels[@]}"; do
    [ -n "$label" ] && [ "${#label}" -le 63 ] || return 1
    [[ "$label" == -* || "$label" == *- ]] && return 1
  done
  return 0
}

want_host() {
  local file="$1" host url kc
  [ -f "$file" ] || fail "env file $file not found"
  host="$(env_value "$file" REGULAIT_PUBLIC_HOST)"
  if [ -z "$host" ]; then
    return 0
  fi
  valid_dns_name "$host" ||
    fail "REGULAIT_PUBLIC_HOST=\"$host\" is not a lowercase DNS name (no scheme, port, path, IP literal or localhost)"

  url="$(env_value "$file" REGULAIT_PUBLIC_URL)"
  url="${url%/}"
  [ "$url" = "https://$host" ] ||
    fail "REGULAIT_PUBLIC_URL must be https://$host when REGULAIT_PUBLIC_HOST is set (got \"${url:-<unset>}\")"

  kc="$(env_value "$file" REGULAIT_KC_HOSTNAME)"
  if [ -n "$kc" ]; then
    kc="${kc%/}"
    [ "$kc" = "https://$host/idp" ] ||
      fail "REGULAIT_KC_HOSTNAME must be https://$host/idp when REGULAIT_PUBLIC_HOST is set (got \"$kc\")"
  fi

  printf '%s\n' "$host"
}

# The front's fixed address on the compose network (docker-compose.yml, ADR-0031).
FRONT_ADDR="172.28.0.2"

tunnel_check() {
  local file="$1" sso="$2" host url kc kc_path token profiles name value
  local -a problems=()
  [ -f "$file" ] || fail "env file $file not found"

  profiles=",$(resolved_value "$file" COMPOSE_PROFILES | tr -d ' '),"
  [[ "$profiles" == *,sso,* ]] && sso=1
  [[ "$profiles" == *,hosted,* || "$profiles" == *,tls,* ]] &&
    problems+=("COMPOSE_PROFILES names hosted or tls: the tunnel front replaces the TLS front, run one of them")

  host="$(resolved_value "$file" REGULAIT_PUBLIC_HOST)"
  if [ -z "$host" ]; then
    problems+=("REGULAIT_PUBLIC_HOST is not set: the tunnel serves exactly one public name")
  elif ! valid_dns_name "$host"; then
    problems+=("REGULAIT_PUBLIC_HOST=\"$host\" is not a lowercase DNS name (no scheme, port, path, IP literal or localhost)")
    host=""
  fi

  if [ -n "$host" ]; then
    url="$(resolved_value "$file" REGULAIT_PUBLIC_URL)"
    url="${url%/}"
    [ "$url" = "https://$host" ] ||
      problems+=("REGULAIT_PUBLIC_URL must be https://$host (got \"${url:-<unset>}\")")

    kc="$(resolved_value "$file" REGULAIT_KC_HOSTNAME)"
    kc="${kc%/}"
    if [ -n "$sso" ] || [ -n "$kc" ]; then
      [ "$kc" = "https://$host/idp" ] ||
        problems+=("REGULAIT_KC_HOSTNAME must be https://$host/idp (got \"${kc:-<unset>}\")")
    fi
  fi
  if [ -n "$sso" ]; then
    kc_path="$(resolved_value "$file" REGULAIT_KC_RELATIVE_PATH)"
    [ "${kc_path%/}" = "/idp" ] ||
      problems+=("REGULAIT_KC_RELATIVE_PATH must be /idp with the sso profile (got \"${kc_path:-<unset>}\")")
  fi

  # The token's value is never printed, only whether it is usable.
  token="$(resolved_value "$file" REGULAIT_CF_TUNNEL_TOKEN)"
  if [ -z "$token" ]; then
    problems+=("REGULAIT_CF_TUNNEL_TOKEN is not set (the tunnel's token, from the Cloudflare dashboard)")
  elif [[ "$token" =~ [[:space:]] ]]; then
    problems+=("REGULAIT_CF_TUNNEL_TOKEN contains whitespace (paste the token alone, not the whole install command)")
  fi
  token=""

  for name in REGULAIT_TRUSTED_PROXIES REGULAIT_KC_TRUSTED_PROXIES; do
    value="$(resolved_value "$file" "$name" | tr -d ' ')"
    if [ -n "$value" ] && [ "$value" != "$FRONT_ADDR" ]; then
      problems+=("$name must be unset or exactly $FRONT_ADDR, the tunnel front's address (got \"$value\")")
    fi
  done

  if [ "${#problems[@]}" -gt 0 ]; then
    printf 'hosted-config: tunnel-check: %s\n' "${problems[@]}" >&2
    exit 2
  fi
  printf 'tunnel config ok: https://%s%s\n' "$host" "${sso:+ (with sign-in under /idp)}"
}

case "${1:-}" in
  want-host)
    [ "$#" -eq 2 ] || usage
    want_host "$2"
    ;;
  tunnel-check)
    [ "$#" -eq 2 ] || { [ "$#" -eq 3 ] && [ "$3" = "--sso" ]; } || usage
    tunnel_check "$2" "${3:+1}"
    ;;
  *) usage ;;
esac
