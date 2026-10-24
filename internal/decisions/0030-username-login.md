# ADR-0030 — Login by username (migration 0047): a second identifier namespace that cannot collide with the first

- **Status:** Accepted
- **Date:** 2026-08-01
- **Amends:** ADR-0025 (real human authentication) — `POST /auth/login` and the `users` identity
  columns. Follows ADR-0021's org-configurability conventions for the self-service dial.
  Migration **0047**. Closes ROADMAP §6 row 17.

## Context

The owner asked to sign in as `dhruv`. They could not: sign-in has been **email-keyed** since
ADR-0025, and `loginSchema` validated `email` with `z.string().email()` — so a non-email
identifier was a **400 from zod before any authentication logic ran**. The item was recorded as
explicitly deferred (ROADMAP §6 row 17) with three named reasons: a second unique identity
column, a second uniqueness/collision story, and a question about which identifier OIDC maps
onto. They have now asked for it, so all three need answers rather than a deferral.

The hard part is not "add a column". It is that sign-in is a **security surface with two live
invariants** that a second namespace could quietly break:

1. **The uniform-error invariant (ADR-0025).** Unknown account and wrong password must be
   indistinguishable in status, body *and* timing — the endpoint must not be an
   account-existence oracle. A naive username lookup that returns early on a miss re-introduces
   a timing oracle in the new namespace only.
2. **Identifier collision.** One login field now resolves two namespaces. If a username could
   ever *look like* an email, one user could claim a string that resolves to another user's
   email address — an impersonation path created by the resolution rule itself.

## Decision

### 1. `users.username` — nullable, unique, shape-constrained (migration 0047)

```sql
ALTER TABLE "users" ADD COLUMN "username" text;
ALTER TABLE "users" ADD CONSTRAINT "users_username_shape_ck"
  CHECK ("username" IS NULL OR "username" ~ '^[a-z0-9][a-z0-9._-]{1,62}$');
CREATE UNIQUE INDEX "users_username_uq" ON "users" ("username");
ALTER TABLE "org_settings" ADD COLUMN "username_self_service" boolean DEFAULT false NOT NULL;
```

**NULLABLE** because every existing user has no username and must keep signing in exactly as
before; Postgres treats NULLs as distinct in a unique index, so any number of users may have
none. **UNIQUE** because it is an identifier. The **shape** is 2–63 characters, starting
alphanumeric, then letters/digits/`.`/`_`/`-`.

### 2. The collision rule: a username can never contain `@`

`@` is what makes an identifier an email address, so `@` is exactly what the username shape
forbids — at the **database CHECK**, not only in zod. The two namespaces are therefore
**provably disjoint**: no string is a valid member of both. That makes the resolution rule total
and unambiguous:

> **An identifier containing `@` is an EMAIL. Anything else is a USERNAME.**

and it makes the impersonation question unanswerable-by-construction: a username can never
resolve to, or be mistaken for, another user's email address. The rule reads the **value**, not
the field name, so it behaves identically no matter which client shape delivered it.

### 3. Case folding: normalize-on-write, not a functional index

Usernames are **trimmed and lowercased on every write and every lookup**, and the CHECK admits
lowercase only. The alternative — store as typed, add `CREATE UNIQUE INDEX ON users
(lower(username))` — was rejected: it leaves two representations of the same name in the
database (`Dhruv` and `dhruv` are one identity but two strings), which means every future query,
join, log line and export has to remember to fold, and any one that forgets is a bug that only
shows up as a duplicate-looking identity.

With normalize-on-write plus the lowercase-only CHECK, **a plain unique index IS case-insensitive
uniqueness**: `Dhruv` cannot coexist with `dhruv` because `Dhruv` cannot be stored at all — not
by the API, not by a hand-written `UPDATE` behind it. The guarantee is a property of the
**storage**, not of a code path. (Tested both ways: `Dhruv` through the API is folded and then
409s against the existing `dhruv`; `Dhruv` written directly with drizzle is refused by the
CHECK, and a duplicate by the index.)

### 4. Login accepts either — and stays backward compatible

`POST /auth/login` takes `{ identifier, password }`, and **keeps accepting the pre-0047
`{ email, password }`** as an alias (exactly one of the two must be present; the parse normalizes
to `identifier`). Every shipped client — the legacy `/app` and `/admin` shells, older SPA builds,
anyone's script, and the existing test suite — keeps working byte-for-byte.

The zod `.email()` format check on the `email` field is **deliberately relaxed** to a bounded
string. A client that only knows the `email` field must be able to carry a username in it — that
is precisely the owner typing `dhruv` into a shell we no longer edit. Nothing is weakened: the
server never trusts the field name, it applies the resolution rule to the value, and a
non-existent identifier gets the same uniform 401 as a wrong password. Relaxing it converts a
**400 before authentication** into that uniform 401, which is *less* of an oracle than before,
not more.

### 5. The uniform-error invariant is preserved, including cost

The username lookup returns `null` on a miss and then walks the **identical** failure path the
email miss already walked: `verifyPassword(password, null)` — the deliberate dummy scrypt burn —
followed by the same audit write and the same `401 invalid_credentials`. There is no early return
and no second failure branch.

The 401 body is **unchanged from ADR-0025**, wording and all (`"email or password is
incorrect"`). Changing it per namespace is precisely how a uniform error decays into an oracle,
and a shared body also means no client that matched on it breaks. The SPA shows its own
"Email/username or password is incorrect." — one message for every failure mode, mirroring the
server.

Which namespace was tried is recorded **only in the audit log** (`identifierKind`, and
`why: unknown_username` vs `unknown_email`), never in the response. Lockout counts against the
**account**, not the identifier: five failures split across username and email lock the same user,
and the correct password then fails through both.

### 6. Admin-managed by default; self-service is an org choice

Two surfaces, **one writer** (same validator, same uniqueness check, same audit shape):

| route | who | gate |
|---|---|---|
| `PUT /v1/users/:userId/username` | admin | admin-only via app.ts's default gate |
| `POST /auth/username` | the user, on themselves | `org_settings.username_self_service` |

`username_self_service` defaults to **false** — admin-managed only. This follows ADR-0021's
conventions (behaviour-preserving default, org as ceiling) and matches how every other identity
anchor already works: a user cannot change their own email or admin flag either. **Reading** one's
own username is never gated (`/auth/me` always carries it, plus the `usernameSelfService` flag so
the UI can show the value read-only instead of offering an edit that would 403).

A uniqueness violation is a clean **409 `username_taken`**, never a raw constraint error — from a
pre-check *and* from a catch on the unique-index violation, so a race between two admins still
answers 409. The 409 **names the conflict** on the admin surface (the holder's email +
`conflictUserId`, which an admin can act on) and deliberately **does not** on the self-service
surface, where naming the holder would turn the route into a directory of who owns which name.

Every write is audited under its own rule id — `username-set` / `username-changed` /
`username-cleared` (plus `username-self-service-denied` for a refused self-service attempt) —
with `from`, `to` and `via` (`admin` | `self`) in the detail.

**Creation does not take a username.** `POST /v1/users` is unchanged; a username arrives only
through the dedicated audited route. One writer means one place where uniqueness, folding, the
409 and the audit row are guaranteed.

### 7. OIDC still maps on email (the third deferred question)

The OIDC callback continues to map the IdP's **verified email** claim onto `users.email`,
unchanged. A username is a **local** login convenience, never an SSO identity: IdPs assert email
(and `sub`), an admin controls usernames, and mapping SSO onto a locally-editable string would
let a username change silently re-point an SSO identity. Recorded here so the question is
answered rather than left open.

### 8. Seeding

The seeded personas get `admin`, `dana`, `avery` through the real admin route (so the seed path
exercises the same validation, uniqueness and audit a human admin produces), and the seeder's
summary prints the username column alongside the email. The owner can sign in as `admin`
immediately.

## Consequences

- Sign-in now has two identifier namespaces and one resolution rule. Because the namespaces are
  disjoint by CHECK, the rule needs no tie-breaker and can never become ambiguous.
- The relaxed `email` field means a malformed email now reaches the uniform 401 instead of a 400.
  That is intended (see §4) and is a *reduction* in what the endpoint discloses.
- Usernames are lowercase-only. Display names remain the place for human capitalization.
- **Not built, deliberately:** a reserved-name list (`admin`, `root`, `support`…). Usernames
  today grant nothing on their own — authorization is entirely the pillar-1 entitlement model —
  so a reserved name buys no security, only a policy opinion. If a customer wants one it belongs
  in `org_settings` next to `username_self_service`, not hard-coded.
- **Not built:** username history / cooldown on re-use. A cleared username is immediately
  available to another user, which is the right default for a small-org product but would need
  revisiting if usernames ever appear in external-facing URLs.
- Rate limiting, MFA, the must-change-password gate, deactivation and lockout are all untouched
  and all tested through the username path — the identifier decides *which row is loaded*, and
  nothing else in the auth pipeline knows or cares which namespace it came from.

## Tests

21 e2e cases in `apps/gateway/src/auth.test.ts` (`ADR-0030 — login by username`) plus one in
`seed.test.ts`: login by username; email login regression (both body shapes); a legacy client
posting a username in the `email` field; unknown-username vs wrong-password identical in status
**and** body, with the scrypt burn measured; `@` refused at write; case folding and shape
enforcement; `Dhruv` vs `dhruv` collision → 409; the database refusing both violations directly;
set/change/clear audited; self-service off (403, audited) and on (200, quieter 409); MFA,
must-change, lockout and deactivation entered by username; seeded personas carrying usernames
that actually sign in.
