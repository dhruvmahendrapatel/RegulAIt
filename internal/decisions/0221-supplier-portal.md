# ADR-0221: A supplier portal: scoped, expiring supplier sign-in that feeds the ADR-0084 attestations

- **Status**: Accepted (builder slice; held for the master's separate security review)
- **Date**: 2026-10-30
- **Driver**: [PENDING.md](../product/PENDING.md) §2c item **P4**, started by the owner on 2026-10-30 (#453 c6527158879;
  common backlog rules c6522850568). UI placement note: #453 c6527271704.
- **Migrations**: `0241_supplier_portal_access.sql` (the setting, questionnaires, grants, links, sessions),
  `0242_supplier_submissions.sql` (answers and evidence files).
- **Extends**: [ADR-0084](0084-vendor-ai-risk-portal.md) (the vendor registry, the assessment and its attestations),
  [ADR-0180](0180-continuous-assurance-strict-by-default.md) (default-off), [ADR-0186](0186-batch4-approvals-receipts-detection.md) (step-up),
  [ADR-0102](0102-operator-prose-credential-scrub.md) (prose scrub), [ADR-0182](0182-accountability-records-d4.md) A13
  (the public signed feedback link, whose route pattern this copies).

## Context

ADR-0084 runs a versioned assessment per vendor and records the vendor's answers as attributed attestations against
the controls of an active compliance pack. Because no external sign-in surface existed, a platform user typed in what
the supplier sent. P4 asks for a portal where the supplier signs in and submits evidence against the applied framework
directly, plus a builder for custom questionnaires, with the results flowing into the existing attestations and
approvals. It is the product's first sign-in surface for someone who is not a platform user, so it is built strict
and gets a separate security review.

## Decision

1. **Default off.** `org_settings.supplier_portal_enabled` ships `false` (migration 0241 records the strict value in
   the migration outbox). Off, every supplier route answers the same 404 body as a route that does not exist, and no
   access can be granted. Turning it on is a relaxation: a `settings_relax` step-up bound to the new value, audited
   with `detail.relaxed`. Turning it off revokes every live supplier session and unused link in the same transaction,
   so a later re-enable does not wake an old one. It has its own endpoint (`/v1/supplier-portal/settings`), not a key
   on `PUT /v1/org/settings`.
2. **One grant = one supplier contact, one vendor, one assessment, one framework.** `supplier_access` binds the
   supplier's e-mail address to the vendor, the vendor's assessment workflow instance and the framework whose active
   pack is applied, plus an optional custom questionnaire version. It expires (1–30 days, default 14; a database CHECK
   caps it at 30) and can be revoked. Granting needs the portal on, an open assessment (`proposed` or
   `under_assessment`), an active pack for the framework and a live questionnaire version.
3. **Sign-in is a single-use link (a magic link), never a password.** A link is `rglsi_` + 32 random bytes; only its
   sha256 is stored (the existing `hashToken` scheme). It is shown once in the grant or re-issue response, works once,
   lives 1–72 hours (default 24; CHECK-capped at 72) and never past its grant; issuing a new link revokes the grant's
   unused ones. The link carries the token in the URL fragment (`/ui/supplier#…`), so it never reaches a server log or
   a `Referer`; the page sends it in a POST body and removes it from the address bar. Every refused link (unknown,
   malformed, used, revoked, expired, grant revoked or expired, vendor retired) gets one body and one status, and a
   known-but-dead link is audited as a denial.
4. **The session.** A spent link becomes a `rglss_` session token, stored as sha256, in a cookie that is `HttpOnly`,
   `SameSite=Strict`, `Secure` over TLS and scoped to `Path=/supplier/v1`. A session lives at most 8 hours
   (CHECK-capped) and never past its grant, ends after 30 idle minutes, and is revoked with its grant. Every check is
   on the database clock.
5. **Separation from the platform.** The four supplier routes are auth-exempt and non-admin for the platform hooks
   (`route-classes.ts`), so a platform session or key is never read on them, and they authenticate in-route on the
   supplier cookie only. A supplier cookie opens no platform route. Every supplier query is keyed by the grant's
   vendor, instance and framework, never by a request field, so a supplier cannot name another vendor, assessment or
   answer. State-changing supplier requests need the `x-regulait-csrf: 1` header on top of the SameSite cookie.
6. **Uploads.** One file per answer, JSON base64 within a route body limit, at most 2 MiB decoded. The type comes from
   the bytes (PDF, PNG and JPEG signatures; strict UTF-8 text with no control characters for text and CSV) and must
   match the file name's extension; anything else is refused. A scan hook (`supplierFileScanner` on `buildApp`) may
   refuse a file; with none configured the file is stored as `not_scanned` and every view says so. The bytes are a
   data-key envelope (`file_ciphertext`, registered in `CIPHERTEXT_COLUMNS`) and are downloaded only by an admin, as an
   attachment with `nosniff`, a sandbox CSP and `no-store`; each download is audited.
7. **Results flow into ADR-0084, through the same write.** A supplier answer is held as `submitted`. A reviewer
   accepts or rejects it (a rejection needs a reason, which the supplier sees). Accepting an answer to a control, or to
   a questionnaire question mapped to a control, records an attestation through `recordVendorAttestation`, the one
   helper the platform attestation route now also uses: the control must be in the framework's active pack and the
   assessment questionnaire must already be submitted, or the decision is rolled back. The attestation carries
   `submittedBySupplier` (grant, e-mail, submission, time) beside `recordedByUserId` (the reviewer): the supplier
   made the claim, the reviewer recorded it. The assessment's sign-off stays on the one approvals queue; nothing here
   changes it, and an approval still approves the assessment, not the claims.
8. **Custom questionnaires** are versioned rows: a row is one version, editing publishes the next, and a grant and
   each answer name the exact version. A question may allow a file and may map to a control. Retiring a version stops
   new grants from using it.
9. **Admin only, with step-up, audited.** Every admin route goes through the default admin gate. Granting, issuing a
   link and revoking need an `identity_manage` step-up (identity administration for an external identity; no new
   step-up kind). Every write on either side writes its audit row in the same transaction; supplier actions are
   audited with the null identity and `actor: "supplier"`. New audit object types: `supplier_access`,
   `supplier_submission`, `supplier_questionnaire`. The supplier's statement and the reviewer's reason are registered
   with the ADR-0102 prose scrub.
10. **Rate limits.** 60 requests per address per 15 minutes across the supplier routes, and 30 submissions per grant
    per 15 minutes, on the gateway's existing `@fastify/rate-limit` buckets (the gateway-wide limiter still applies).

### Threat model (short)

| Threat | Mitigation |
|---|---|
| Guessing or enumerating links | 256-bit tokens, hash-only storage, uniform refusal body and status, address rate limit, denial audited |
| A forwarded or leaked link | single use, 24 h default and 72 h cap, re-issue revokes older links, revoke on demand; the session it became is bounded too |
| Token leakage through URLs | the token sits in the fragment, is POSTed, and is removed from history; session token only in an `HttpOnly` cookie |
| Session theft or fixation | new random token per sign-in, hashed; `SameSite=Strict`; idle 30 min, absolute 8 h; revocable; cleared on refusal |
| CSRF / login CSRF | custom header required on every supplier POST, including link redemption |
| Horizontal access to another vendor or tenant data | grant-keyed queries only; supplier routes cannot read platform credentials and platform routes ignore the supplier cookie; single tenant per deployment (see limits) |
| Malicious file upload | byte-signature allow-list matched to extension, size cap, scan hook, envelope at rest, admin-only attachment download with `nosniff` and sandbox CSP |
| A supplier's claim mistaken for evidence | held for review; accepted only through the ADR-0084 write; labelled as a supplier attestation everywhere |
| Insider misuse of grants | admin-only, step-up, audited in the same transaction; disabling the portal revokes everything live |
| Secrets pasted into answers | prose scrub on the statement and reason; audit-chain scrub on audit text |

## Open source first (ADR-0176)

Searched: no new dependency. Reused what the gateway already ships: Node `crypto` for tokens and hashes and the
existing `hashToken` scheme (no hand-rolled cryptography), `@fastify/rate-limit` for the buckets, the data-key envelope
in `secrets.ts`, the custom-header CSRF pattern and the step-up module. Considered and not used: `@fastify/multipart`
(MIT), because the JSON-base64 upload already has a precedent (engine raw reports) and avoids a new parser on an
external surface; `file-type` (MIT), because it does not identify plain text or CSV and our allow-list is three byte
signatures plus a strict UTF-8 check, so the dependency would add a streaming tokenizer chain for no coverage we need;
`@fastify/csrf-protection` (MIT), because the repo's header-plus-SameSite pattern is already the reviewed CSRF
defence. No magic-link library fits a Fastify gateway with our own session tables and air-gapped operation.

## Honest limits and follow-ups

- **No e-mail.** The admin copies the link and sends it; a supplier whose session ended asks for a new link. A
  self-serve "send me a link" flow (shorter links, sent through the product e-mail channel) is the follow-up.
- **No supplier MFA.** The single-use link is the factor; a TOTP or passkey step for suppliers is a follow-up.
- **No scanner ships.** The hook is a seam; wiring a scanner (for example an ICAP or ClamAV service reached through the
  guarded fetch) is a follow-up. Until then files say "Not scanned".
- **Row-level security.** Each deployment is single-tenant ([ADR-0041](0041-byoc-primary-motion.md)) and no migration
  enables RLS yet ([ARCHITECTURE.md](../ARCHITECTURE.md) §known gaps, ADR-0060 follow-up). Supplier isolation is
  enforced by the separate route class and grant-keyed queries, not by Postgres policies.
- **Answers do not compile into the questionnaire artifact.** The assessor still submits the questionnaire artifact
  (ADR-0084 requires it before any attestation); accepting an answer before that is refused and rolled back.
- **Retention.** Supplier rows and files follow the vendor (cascade on vendor deletion); a retention sweep for
  evidence files is a follow-up.

## Addendum 2026-10-31: functional and security review fixes (#629)

- **Concurrent attestations.** `recordVendorAttestation` now appends in SQL (`pack_attestations || $new`), so the
  platform route and a supplier accept recorded at the same moment both survive. Before this, each wrote back the
  snapshot its caller had read.
- **A revoked grant's answers.** Revoking a grant rejects its pending answers in the same transaction, with reason
  "Access revoked: …". Accepting an answer from a revoked grant is refused (`access_revoked`). An expired grant's
  answers can still be accepted, because expiry is the planned end of access. The review list shows each grant's
  state.
- **Unscanned files (ADR-0180).** A second default-off setting, `supplier_portal_accept_unscanned_files`, is added to
  migration 0241, still unapplied, in place.
  - With no scanner configured, evidence files are refused. Statement-only answers still work.
  - Accepting unscanned files is a `settings_relax` step-up and is audited as a relaxation.
  - Downloading an unscanned file needs an explicit `acknowledgeUnscanned=1`, which the audit row records.
  - A CSV downloads as plain text (`.txt`), so a spreadsheet application never evaluates its cells.
- **Storage.**
  - Each grant holds at most one pending answer per item. A newer answer withdraws the older one, which keeps no file
    (status `withdrawn`, added to 0242 in place).
  - Each grant is capped at 50 MiB of held file bytes and 500 answers, checked under the grant's row lock.
  - The data-key envelope stays the shared hex format. The custody probe and the re-encryption walk handle every
    `CIPHERTEXT_COLUMNS` entry through that one format, and a second, compact format would fork them. The per-grant
    budget bounds the stored size instead: worst case about 2.7 × 50 MiB per grant. A binary envelope is a follow-up
    for the data-key module, not for this lane.
- **Smaller fixes.**
  - The step-up digest now covers every field that shapes a grant and a link (`questionnaireId`, `inviteHours`).
  - A forged session cookie is refused by a database lookup before the body is read.
  - A questionnaire linked to controls outside the grant's framework cannot be granted.
  - A duplicate questionnaire name answers 409 instead of 500.
- **Not done, recorded.**
  - Supplier reads (`GET /supplier/v1/assessment`) are not audited. Sign-in, every write and every refusal are.
  - The shared step-up copy for `identity_manage` still reads "changing an agent identity". That wording belongs to
    the step-up module and its pinned tests.
- **Entry bundle (2026-10-31, the owner's entry ceiling of 138.5 kB does not move).** Main left 130 B of headroom, and
  this lane added about 205 B, mostly hashed chunk names in the preload table. Three changes bring it under the
  ceiling, at 138,471 B:
  - The admin side no longer imports values from the supplier page's module, so no third shared chunk is created.
  - "Supplier questionnaires" is reached from a link in the Vendors page header (with a link back), instead of its
    own entry in the navigation rail. It keeps its route.
  - The supplier page no longer skips the app-wide sign-in check. It makes one `GET /auth/me`, as the other public
    pages do. That call carries no supplier data and gets a 401 for someone with no platform account.
