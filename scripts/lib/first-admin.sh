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

# 0 (true) when stdin is NOT valid UTF-8: a truncated or stray continuation byte, an overlong form, a UTF-16
# surrogate, or a code point above U+10FFFF. Bytes go through od and awk only, never into a shell variable.
fa_utf8_invalid() {
  od -An -v -tu1 | awk '
    { for (i = 1; i <= NF; i++) {
        b = $i + 0
        if (need == 0) {
          if (b < 128) continue
          if (b >= 194 && b <= 223) { need = 1; lo = 128; hi = 191 }
          else if (b >= 224 && b <= 239) { need = 2; lo = (b == 224) ? 160 : 128; hi = (b == 237) ? 159 : 191 }
          else if (b >= 240 && b <= 244) { need = 3; lo = (b == 240) ? 144 : 128; hi = (b == 244) ? 143 : 191 }
          else { bad = 1; exit }
        } else {
          if (b < lo || b > hi) { bad = 1; exit }
          lo = 128; hi = 191; need--
        }
    } }
    END { exit (bad || need) ? 0 : 1 }'
}

# Why the file named by REGULAIT_FIRST_ADMIN_PASSWORD_FILE cannot be used, or nothing. Never reads it into
# a variable and never prints its content. Refuses: a symbolic link (the target can be swapped), a parent
# directory that is not owned by this user or root or that anyone else can write to (the file, or a FIFO in
# its place, could be swapped in between the checks and the open), a file owned by anyone but this user or
# root, group/other access, an empty password, a leading UTF-8 byte-order
# mark, bytes that are not valid UTF-8, and any control character other than ONE trailing newline (\n or
# \r\n), which the gateway strips.
#
# With a second argument, a file descriptor the caller has ALREADY opened on the file: every check then
# reads that open file (through /dev/fd, which on Linux re-opens the same file at offset 0, leaving the
# caller's descriptor where it was), and the path must still name it. Checking the path and then opening
# it again would leave a window in which the file can be swapped.
#
# The descriptor form relies on Linux `/dev/fd` semantics. Elsewhere (macOS, BSD) `/dev/fd/N` duplicates
# the descriptor and shares its offset, so the checks would consume the password before the runner reads it;
# first_admin_from_file (and install.sh, up front) refuse a password file there. A FIFO swapped in between the
# path check and the open would block the open; it needs write access to the file's directory, which the
# directory check refuses to anyone but the owner. Only the immediate parent is checked: someone who can write
# to a grandparent (without the sticky bit) can rename the parent and put their own directory in its place. That
# costs the same as a FIFO (a hang or a refusal), never a leak, because every check still runs on what is opened.
fa_password_file_problem() {
  local f="$1" fd="${2:-}" src="$1" follow="" perm owner me size ctl tail2 bom at_path at_fd dir dperm downer
  [ -n "$f" ] || { echo "no file named"; return 0; }
  [ ! -L "$f" ] || { echo "$f is a symbolic link: name the file itself"; return 0; }
  dir="$(dirname -- "$f")"
  dperm="$(stat -L -c '%a' "$dir" 2>/dev/null || stat -L -f '%Lp' "$dir" 2>/dev/null || true)"
  downer="$(stat -L -c '%u' "$dir" 2>/dev/null || stat -L -f '%u' "$dir" 2>/dev/null || true)"
  if [ -z "$dperm" ] || [ -z "$downer" ]; then echo "the mode or owner of the directory $dir could not be read"; return 0; fi
  if [ "$downer" != "$(id -u)" ] && [ "$downer" != "0" ]; then
    echo "the directory $dir is owned by uid $downer: it must be owned by you (uid $(id -u)) or root"
    return 0
  fi
  if (( (8#$dperm & 8#022) != 0 )); then
    echo "the directory $dir has mode $dperm: no one but its owner may write to it (the file could be swapped) — chmod go-w $dir"
    return 0
  fi
  if [ -n "$fd" ]; then
    src="/dev/fd/$fd"
    follow="-L"
    at_path="$(stat -c '%d:%i' "$f" 2>/dev/null || stat -f '%d:%i' "$f" 2>/dev/null || true)"
    at_fd="$(stat -L -c '%d:%i' "$src" 2>/dev/null || stat -L -f '%d:%i' "$src" 2>/dev/null || true)"
    if [ -z "$at_fd" ] || [ "$at_path" != "$at_fd" ]; then
      echo "$f changed while it was being opened: check it and re-run"
      return 0
    fi
  fi
  [ -e "$src" ] || { echo "$f does not exist"; return 0; }
  [ -f "$src" ] || { echo "$f is not a regular file"; return 0; }
  [ -r "$src" ] || { echo "$f is not readable by this user"; return 0; }
  [ -s "$src" ] || { echo "$f is empty"; return 0; }
  perm="$(stat ${follow:+"$follow"} -c '%a' "$src" 2>/dev/null || stat ${follow:+"$follow"} -f '%Lp' "$src" 2>/dev/null || true)"
  owner="$(stat ${follow:+"$follow"} -c '%u' "$src" 2>/dev/null || stat ${follow:+"$follow"} -f '%u' "$src" 2>/dev/null || true)"
  if [ -z "$perm" ] || [ -z "$owner" ]; then echo "the mode or owner of $f could not be read"; return 0; fi
  if [[ ! "$perm" =~ ^[0-7]?[0-7]00$ ]]; then
    echo "$f has mode $perm: it must be 0600 or stricter (no group or other access) — chmod 600 $f"
    return 0
  fi
  me="$(id -u)"
  if [ "$owner" != "$me" ] && [ "$owner" != "0" ]; then
    echo "$f is owned by uid $owner: it must be owned by you (uid $me) or root"
    return 0
  fi
  bom="$(head -c 3 "$src" | od -An -tx1 | tr -d ' \n')"
  if [ "$bom" = "efbbbf" ]; then
    echo "$f starts with a UTF-8 byte-order mark: save it without one"
    return 0
  fi
  if fa_utf8_invalid <"$src"; then
    echo "$f is not valid UTF-8: save the password as UTF-8 text"
    return 0
  fi
  size="$(wc -c <"$src" | tr -d ' ')"
  ctl="$(LC_ALL=C tr -cd '\000-\037\177' <"$src" | wc -c | tr -d ' ')"
  tail2="$(tail -c 2 "$src" | od -An -tx1 | tr -d ' \n')"
  case "$ctl" in
    0) ;;
    1) if [ "${tail2: -2}" != "0a" ]; then echo "$f contains a control character: only one trailing newline is allowed"; return 0; fi
       size=$((size - 1)) ;;
    2) if [ "$tail2" != "0d0a" ]; then echo "$f contains control characters: only one trailing newline is allowed"; return 0; fi
       size=$((size - 2)) ;;
    *) echo "$f contains control characters (a password is one line; only one trailing newline is allowed)"; return 0 ;;
  esac
  [ "$size" -gt 0 ] || { echo "$f is empty"; return 0; }
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
#
# The file is opened ONCE, on descriptor 9, re-checked through that descriptor, and that same descriptor is
# the runner's stdin, so what was checked is what is sent (no check-then-reopen race). The first, path-only
# check gives the friendly refusals (missing, mode, owner) before anything is opened.
#
# Linux only: the re-check depends on /dev/fd re-opening the file at offset 0. Elsewhere (macOS, BSD)
# /dev/fd duplicates the descriptor and shares its offset, so the checks would consume the password before
# the runner reads it. There the password file is refused and the interactive prompt is the way in.
first_admin_from_file() {
  local f="$1" rc=0 problem
  if [ "$(uname -s)" != "Linux" ]; then
    FA_OUTPUT="password file refused: a password file is supported on Linux only; run the installer interactively"
    return 2
  fi
  problem="$(fa_password_file_problem "$f")"
  if [ -n "$problem" ]; then FA_OUTPUT="password file refused: $problem"; return 2; fi
  if ! { exec 9<"$f"; } 2>/dev/null; then FA_OUTPUT="password file refused: $f could not be opened"; return 2; fi
  problem="$(fa_password_file_problem "$f" 9)"
  if [ -n "$problem" ]; then exec 9<&-; FA_OUTPUT="password file refused: $problem"; return 2; fi
  FA_OUTPUT="$(first_admin_exec --username "$FA_USERNAME" --email "$FA_EMAIL" <&9 9<&- 2>&1)" || rc=$?
  exec 9<&-
  return "$rc"
}
