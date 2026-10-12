# ADR-0194: The installer asks for the first admin's password

- **Status**: Accepted (owner, 2026-10-12)
- **Date**: 2026-10-12

## Context

Today a fresh install creates its first admin in a manual step. `scripts/install.sh` prints a `curl` command that
uses the identity-less `REGULAIT_BOOTSTRAP_TOKEN` to `POST /v1/users`. The operator then issues a one-time
password, deletes the token from `.env` and restarts (docs/deployment/INSTALL.md). This works, but the operator has
to leave the installer, run commands and remember to retire the token.

The owner asked for a default sign-in, `Admin` with a set password, as one of the initial install steps, which the
admin can disable later. A password shipped in the product would be the same on every install and published in
this repository. That contradicts ADR-0174 §6 (a password never comes from the repository or seed data) and
ADR-0180 (secure by default), and a known default administrator credential is a standard audit finding
(CWE-1392, CWE-1393). Two options were put to the owner on 2026-10-12:
- **The installer asks for the password.** The owner chose this one.
- A fixed default password, changed at first sign-in.

## Decision

1. **The installer asks for the first admin.** During `scripts/install.sh`, the operator gives a username (default
   suggestion `admin`), an email and a password. The password is read without echo and asked for twice. It is
   never written to `.env`, compose files, logs, shell history or audit detail. A non-interactive install reads it
   from a file named by an environment variable (`REGULAIT_FIRST_ADMIN_PASSWORD_FILE`, mode 0600), never from a
   command-line argument.
2. **The org password policy is checked before anything is created** (the same `checkPasswordPolicy` that sign-in
   uses: at least 12 characters and 3 character classes by default). A weak password is refused, and the installer
   asks again.
3. **The account is created through the gateway, not by writing the database directly.** It goes through the same
   path as `POST /v1/users` plus a password set, so the usual audit rows are written. The password is the
   operator's own choice, so it is not flagged must-change. The ADR-0181 rule still applies: an admin enrols TOTP
   at first sign-in.
4. **The bootstrap token is retired by the installer** once the first admin exists: it is removed from `.env` and
   the gateway is restarted. The gateway already refuses `dev-bootstrap`; this closes the door without a manual
   step.
5. **Nothing ships with a password.** There is no default credential in code, images, seed data or docs. If the
   installer step is skipped, there is no admin, and the manual bootstrap path in INSTALL.md still works.
6. **The admin can turn it off later.** Existing controls cover this, with no new setting:
   - deactivate the account (`POST /v1/users/:id/deactivate`, with the last-active-admin guard);
   - or, once SSO is set up, make email sign-in `break_glass_only` or `sso_only` in Admin → SSO.
   Each change is audited.
7. **Re-running the installer** on a deployment that already has an admin skips this step and changes nothing.

## Consequences

- A first install ends with a usable admin sign-in, with no `curl` step and no live bootstrap token left behind.
- Local demos are unchanged. A demo still sets persona passwords with `demo:set-passwords` from env or a 0600 file
  (ADR-0174 §6).
- The installer gains an interactive step, and a file-based input for automation. Tests must cover:
  - the policy refusal;
  - the mismatch re-prompt;
  - the password never appearing in output or `.env`;
  - token retirement;
  - the skip on re-run.
- INSTALL.md and the installer summary are rewritten around the new step. The manual bootstrap path stays as the
  documented fallback.

## As built (2026-10-12)

1. **Where the account is created.** The installer runs a small command-line tool inside the gateway container,
   `dist/first-admin.js`, built from `first-admin.ts` and `first-admin-lib.ts`, rather than calling the gateway over
   HTTP. No route is added.
   - The password reaches the tool on stdin only: `printf | docker compose exec -T`, or a redirect from the 0600
     file. It never appears in any process's arguments and is never read into a shell variable.
   - The tool validates the username and email with the same shared schemas and seat gate as `POST /v1/users`.
   - It writes the user, the password hash and the audit rows in one transaction: `username-set`,
     `initial-password-set` and a new `first-admin-created`. None of these rows carries the password or the hash.
   - It checks again for an existing admin under the sign-in lock, so two concurrent runs create one admin.
2. **Retiring the token needs more than removing it from `.env` (refines decision 4).** `docker-compose.yml`
   defaults the token to `dev-bootstrap`, and the gateway refuses that value on a deployed box. So the installer
   also:
   - pins `REGULAIT_BOOTSTRAP_TOKEN: ""` in `compose.install.yml`;
   - writes `REGULAIT_BOOTSTRAP_RETIRED=1` to `.env`, so that re-runs do not generate a new token;
   - restarts the gateway with `up -d --no-build`.
   The manual fallback in INSTALL.md now ends with "re-run the installer to retire the token" instead of the old
   `sed` instruction, which would have hit that refusal.
3. **Break-glass.** An explicit `--admin-token` re-opens a token only after it has been retired, for recovery. On a
   first install, the flag only sets the token's value, and the token is retired once the admin exists. The next
   installer run without the flag retires it again. A token that is only exported in the shell is ignored. If the
   gateway restart that completes retirement fails, the installer stops and says that the running gateway still
   accepts the old token. If the token is retired and no admin is active, the summary does not print a manual `curl`.
   It points to re-running the installer or re-opening the token.
4. **Unattended installs.** `REGULAIT_FIRST_ADMIN_PASSWORD_FILE` must be a regular, non-empty file with mode 0600 or
   stricter, and `REGULAIT_FIRST_ADMIN_EMAIL` is required with it. Both are checked before anything is rendered.
   The file must hold one line. It must not be a symlink, it must be owned by the installing user or root, and it
   must have no UTF-8 byte-order mark and no control characters other than one trailing newline. It is checked again
   immediately before use. Without the file, a non-interactive run skips the step and prints the manual path.
5. **Errors never echo secrets.** If the account creation fails, the tool prints only the error type and the
   Postgres error code, never the driver message, which can carry the email and password hash. A duplicate username
   or email exits 5.
6. **Demo seed (`--seed-demo`).** The demo personas count as the existing admin, so the step is skipped and the
   summary says so. The token is still retired, so the seed that re-runs at each gateway start can no longer
   authenticate. It logs a failure and the loaded data stays. This is the stricter choice, and it was kept.
