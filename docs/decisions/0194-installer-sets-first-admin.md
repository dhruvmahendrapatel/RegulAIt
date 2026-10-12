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
