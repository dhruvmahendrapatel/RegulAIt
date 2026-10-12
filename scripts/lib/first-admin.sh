# shellcheck shell=bash
# =============================================================================
# ADR-0194 — the installer asks for the first admin. Sourced by
# scripts/install.sh (and by its tests, with a stub runner).
#
# The caller defines ONE function before using these:
#
#   first_admin_exec <args...>   runs apps/gateway/dist/first-admin.js inside
#                                the gateway container; the password, when
#                                there is one, arrives on ITS STDIN.
#
# Exit codes of that runner (apps/gateway/src/first-admin-lib.ts):
#   0 created (or --status: no admin yet) · 1 refused by a rule · 2 setup
#   problem · 3 an active admin already exists · 4 password refused by the
#   org policy · 5 username/email invalid or taken.
#
# THE PASSWORD NEVER LEAVES THIS PROCESS EXCEPT ON A PIPE. It is read with
# `read -rs` (no echo), compared with its repetition, and handed to the runner
# with the `printf` BUILTIN on a pipe — so it is never an argument of any
# process (ps, /proc/*/cmdline), never in an environment, a file, .env or the
# installer's output. A non-interactive install names a 0600 file instead
# (REGULAIT_FIRST_ADMIN_PASSWORD_FILE), which is redirected to the runner's
# stdin and never read into a shell variable.
# =============================================================================

# the shared USERNAME_PATTERN (packages/shared/src/index.ts); the gateway is the authority, this is only
# the early, friendlier refusal
FA_USERNAME_RE='^[a-z0-9][a-z0-9._-]{1,62}$'
FA_EMAIL_RE='^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
FA_MAX_ATTEMPTS="${FA_MAX_ATTEMPTS:-5}"

FA_USERNAME=""
FA_EMAIL=""
FA_PASSWORD=""
FA_OUTPUT=""

fa_say() { printf '  %s\n' "$*" >&2; }

# Why the file named by REGULAIT_FIRST_ADMIN_PASSWORD_FILE cannot be used, or nothing. Never reads it into
# a variable and never prints its content.
fa_password_file_problem() {
  local f="$1" perm
  [ -n "$f" ] || { echo "no file named"; return 0; }
  [ -e "$f" ] || { echo "$f does not exist"; return 0; }
  [ -f "$f" ] || { echo "$f is not a regular file"; return 0; }
  [ -r "$f" ] || { echo "$f is not readable by this user"; return 0; }
  [ -s "$f" ] || { echo "$f is empty"; return 0; }
  perm="$(stat -L -c '%a' "$f" 2>/dev/null || stat -L -f '%Lp' "$f" 2>/dev/null || true)"
  if [ -z "$perm" ]; then echo "the mode of $f could not be read"; return 0; fi
  if [[ ! "$perm" =~ ^[0-7]?[0-7]00$ ]]; then
    echo "$f has mode $perm: it must be 0600 or stricter (no group or other access) — chmod 600 $f"
    return 0
  fi
  return 0
}

fa_username_problem() {
  [[ "$1" =~ $FA_USERNAME_RE ]] && return 0
  echo "a username is 2-63 characters, starts with a letter or digit, and may contain letters, digits, '.', '_' and '-' (no '@', no spaces)"
}

fa_email_problem() {
  [[ "$1" =~ $FA_EMAIL_RE ]] && return 0
  echo "that does not look like an email address"
}

# Ask for the username (default admin) and the email until both pass the early checks.
fa_prompt_identity() {
  local u e problem
  while :; do
    IFS= read -r -p "  First admin username [admin]: " u || return 1
    u="$(printf '%s' "${u:-admin}" | tr '[:upper:]' '[:lower:]')"
    u="${u#"${u%%[![:space:]]*}"}"; u="${u%"${u##*[![:space:]]}"}"
    problem="$(fa_username_problem "$u")"
    if [ -n "$problem" ]; then fa_say "$problem"; continue; fi
    break
  done
  while :; do
    IFS= read -r -p "  First admin email: " e || return 1
    e="${e#"${e%%[![:space:]]*}"}"; e="${e%"${e##*[![:space:]]}"}"
    problem="$(fa_email_problem "$e")"
    if [ -n "$problem" ]; then fa_say "$problem"; continue; fi
    break
  done
  FA_USERNAME="$u"
  FA_EMAIL="$e"
}

# Ask for the password twice, without echo, until the two entries match.
fa_prompt_password() {
  local a="" b=""
  while :; do
    IFS= read -rs -p "  Password for '$FA_USERNAME' (not shown): " a || return 1
    printf '\n' >&2
    if [ -z "$a" ]; then fa_say "a password is required"; continue; fi
    IFS= read -rs -p "  Repeat the password: " b || return 1
    printf '\n' >&2
    if [ "$a" != "$b" ]; then fa_say "the two entries do not match — try again"; a=""; b=""; continue; fi
    FA_PASSWORD="$a"
    a=""; b=""
    return 0
  done
}

# Hand the password to the runner on a pipe (the printf builtin: no argv, no environment). Sets FA_OUTPUT
# (the runner's lines, which never carry the password) and returns the runner's exit code.
fa_create() {
  local rc=0
  FA_OUTPUT="$(printf '%s' "$FA_PASSWORD" | first_admin_exec --username "$FA_USERNAME" --email "$FA_EMAIL" 2>&1)" || rc=$?
  FA_PASSWORD=""
  return "$rc"
}

# The interactive loop: identity, password (twice), create. A password the org policy refuses (4) asks for
# the password again; a username/email the gateway refuses (5) asks for those again. Returns 0 created,
# 3 an admin already exists, anything else = not created (the caller falls back to the manual path).
first_admin_interactive() {
  local rc attempts=0 need_identity=1
  while [ "$attempts" -lt "$FA_MAX_ATTEMPTS" ]; do
    attempts=$((attempts + 1))
    if [ "$need_identity" = "1" ]; then
      fa_prompt_identity || return 1
      need_identity=0
    fi
    fa_prompt_password || return 1
    rc=0
    fa_create || rc=$?
    [ -z "$FA_OUTPUT" ] || printf '%s\n' "$FA_OUTPUT" | sed 's/^/  /' >&2
    case "$rc" in
      0|3) return "$rc" ;;
      4) fa_say "choose another password" ;;
      5) fa_say "choose another username or email"; need_identity=1 ;;
      *) return "$rc" ;;
    esac
  done
  fa_say "giving up after $FA_MAX_ATTEMPTS attempts"
  return 1
}

# Non-interactive: the password file is redirected to the runner's stdin (it is never read into a
# variable). The runner strips one trailing newline.
first_admin_from_file() {
  local f="$1" rc=0
  FA_OUTPUT="$(first_admin_exec --username "$FA_USERNAME" --email "$FA_EMAIL" <"$f" 2>&1)" || rc=$?
  return "$rc"
}
