#!/bin/bash
# hosted-config.sh — which hostname the on-box TLS front serves (ADR-0202 lane H).
#
#   hosted-config.sh want-host <path/to/.env>
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
set -uo pipefail

usage() {
  echo "usage: $0 want-host <env-file>" >&2
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

[ "$#" -eq 2 ] || usage
case "$1" in
  want-host) want_host "$2" ;;
  *) usage ;;
esac
