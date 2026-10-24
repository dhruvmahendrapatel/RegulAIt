# ADR-0063: `REGULAIT_DATA_KEY` custody — a non-secret fingerprint, refuse-on-mismatch at boot, and an audited custody attestation

- **Status**: Accepted
- **Date**: 2026-08-03
- **Relates to**: [ADR-0035](0035-nightly-pg-dump-to-s3.md) (the verified nightly `pg_dump`, and the
  deliberate exclusion of the key from the backup — that decision **stands unchanged**),
  [ADR-0025](0025-secure-human-auth.md) and [ADR-0036](0036-saml-sso.md) (TOTP secrets, OIDC client
  secrets, SAML SP keys — three of the twelve ciphertext columns),
  [ADR-0041](0041-byoc-primary-motion.md) and [`scripts/install.sh`](../../scripts/install.sh) (the
  custody banner printed when the installer generates a key),
  [ADR-0029](0029-zero-cost-tls-caddy-sslip-letsencrypt.md) HSTS amendment and
  [ADR-0062](0062-mode-scoped-egress.md) (the house precedent: deployment-shape facts are
  env-derived, printed in the boot log, and fail loudly rather than degrading),
  [ADR-0060](0060-tamper-evident-audit.md) (every event here lands in the one hash-chained trail)

## Context

### The finding, and what is *not* wrong

`REGULAIT_DATA_KEY` is the AES-256-GCM envelope key over **every stored secret in the product**.
Twelve columns, enumerated in `CIPHERTEXT_COLUMNS` and asserted complete by a test that greps the
schema:

| table | column | what is lost |
| --- | --- | --- |
| `users` | `totp_secret_ciphertext` | every MFA enrolment |
| `oidc_providers` | `client_secret_ciphertext` | SSO via OIDC |
| `saml_providers` | `sp_private_key_ciphertext` | SSO via SAML |
| `model_credentials` | `key_ciphertext` | platform model API keys |
| `user_model_credentials` | `key_ciphertext` | every per-user model key |
| `custom_model_providers` | `key_ciphertext` | self-hosted/custom provider keys |
| `connector_credentials` | `token_ciphertext` | every connector token |
| `git_connections` | `token_ciphertext` | every git provider token |
| `pm_connections` | `token_ciphertext` | every PM tool token |
| `pm_connections` | `webhook_secret_ciphertext` | inbound PM webhook verification |
| `deploy_targets` | `credential_ciphertext` | every deploy credential |
| `chatops_connections` | `signing_secret_ciphertext` | inbound ChatOps verification |

ADR-0035 deliberately does **not** put that key in the S3 backup, and says why: a key stored beside
the ciphertext it protects is not an envelope, it is a filename. **That decision is correct and
this ADR does not touch it.**

What ADR-0035 also recorded — as the sharpest edge in the stack, and left open — is the
consequence:

> Restoring that backup onto a NEW machine WITHOUT this key recovers every user, every audit row,
> every project — and leaves every connector token, model API key and TOTP secret **permanently
> undecryptable**. There is no recovery path, no support escalation, no reset.

The envelope split is deliberate. The **missing custody procedure around it was not**. Before this
change:

1. **Nothing anywhere told an operator whether the key they held was the right one.** Not the
   installer, not the boot log, not the backup artifact, not the admin portal. The first signal was
   a decryption failure in production.
2. **A backup artifact could not say which key restores it.** The manifest recorded row counts, a
   SHA-256 and a server version — everything except the one fact that decides whether the dump is
   usable at all.
3. **A restore onto a new box produced a gateway that came up perfectly and was silently broken.**
   Every user could log in. Every list of connectors and model credentials rendered in full. The
   fault surfaced hours or days later as a generic error on an unrelated screen, by which time the
   source box — the only place the correct key existed — might be gone.
4. **"Record the key out of band" was advice with no artifact.** `install.sh` printed a good banner
   at generation time and nothing ever checked, recorded, or reported whether anyone had acted on
   it.

### The constraint that shapes everything below

**We cannot verify custody.** Nothing running on this box can reach into a password manager, a KMS
in someone else's account, or a safe. Any design that claims otherwise is lying. So the honest
question is not *"how do we guarantee the operator has the key"* — it is *"what can the product
actually know, and what can it refuse to do while it does not know it."*

## Decision

**Derive a non-secret fingerprint of the data key, record it in the database, refuse to start when
the running key disagrees with the recorded one, write the fingerprint into every backup artifact,
and make the absence of an audited out-of-band custody attestation visible everywhere the key
matters.**

### 1. The fingerprint derivation

```
fingerprint = "dk1:" + hex( HMAC-SHA256( key = <the 32 raw key bytes>,
                                         msg = "regulait/data-key-fingerprint/v1" )[0..16) )
```

e.g. `dk1:3f2a9c11d0be47e5a8c6210fb47d9e02`.

Three properties, each load-bearing:

- **It reveals nothing about the key.** HMAC-SHA256 is a PRF under its key; recovering the key from
  one output is a 2^256 preimage search, and truncating to 128 bits removes information rather than
  adding any. There is no encoding, no prefix and no substring of the key in the output. The test
  asserts this adversarially — it searches the fingerprint for *every* 8-character run of the key,
  in both directions, and checks a one-nibble key change rewrites the whole value — rather than
  trusting the word "HMAC" in a comment.
- **It is domain-separated.** The fixed message string means this value can never collide with some
  other HMAC computed under the same key later.
- **It is versioned.** `dk1:` names the derivation, so a future scheme coexists with recorded values
  instead of silently comparing unlike things.

Because it is safe to publish, it goes where it is useful: the boot log beside the
proxy/HSTS/egress posture lines, a column in this deployment's own database (which **is** inside the
backup), the backup manifest, the S3 object metadata, the `RESULT=` line, the status file and the
admin portal. **That is the point of choosing a non-invertible identifier**: a backup artifact must
be able to say which key restores it without carrying that key.

### 2. Persist it (migration 0075) and gate the boot on it

`data_key_state` is a singleton: `fingerprint`, `recorded_at`, `last_verified_at`, and
`rotated_from` / `rotated_at` for a declared rotation. The gate runs **after migrations and before
the server listens**:

| recorded | running key | ciphertext probe | outcome |
| --- | --- | --- | --- |
| none | none | — | `no_key_configured` — nothing to check. Secret *writes* are already refused without a key; this adds no new opinion. |
| none | present | no ciphertext exists | `recorded` — first boot. |
| none | present | ciphertext, ≥1 decrypts | `recorded` — first boot after upgrade, **with proof**. |
| none | present | ciphertext, **none** decrypts | **REFUSE** `undecryptable`. |
| matches | present | — | `verified` — normal boot, `last_verified_at` bumped, fingerprint printed in the posture block. |
| **mismatch** | present | — | **REFUSE** `mismatch` — the restore-onto-a-new-box case. |
| mismatch | present | — (rotation declared, §4) | `rotation_accepted`. |
| recorded | none | — | **REFUSE** `key_missing`. |

Two rows deserve comment.

**The ciphertext probe.** On a first boot after upgrade we do not merely assume the running key is
correct — if the database already holds ciphertext, the gate samples up to two values from each of
the twelve columns and tries to decrypt them. A GCM tag failure across *all* of them means this is
the wrong key, and recording it would launder the wrong answer into the permanent record. That
closes the one window where the whole mechanism could have been seeded with a lie. A **partial**
decrypt is accepted (and reported), because that state can only arise mid-way through an
out-of-band re-encryption, and refusing there would remove the operator's only tool for finishing.

**`key_missing`.** A recorded fingerprint proves this deployment had a key. Booting without one is
the same accident with the evidence removed, so it refuses too.

Every one of these outcomes — including all three refusals — writes an `audit_log` row
(`objectType: "data_key"`, stable ruleIds), **before** the throw. The reason a deployment would not
come up survives the console nobody was watching.

### 3. Why refusing to start beats booting

The alternative — log a warning and come up — was weighed and rejected on four grounds:

1. **A gateway with the wrong key is not degraded, it is misleading.** Every user logs in. Every
   page renders. Every credential list is fully populated, because the *rows* are all there. The
   failure appears only when someone *uses* one, as a generic error on an unrelated screen, hours or
   days later. By then the restore is "done" and the source box may be gone.
2. **It corrupts on write.** Nothing stops an admin re-entering a credential under the new key while
   the old ciphertext sits beside it. The database ends up holding rows under two different keys
   with no marker saying which is which — a state *neither* key can fully read, produced by an
   operator trying to fix the problem.
3. **The refusal is the diagnosis, delivered at the only moment it can still help.** The failure
   mode this exists for is an operator who does not yet know they have the wrong key. A start-up
   refusal naming both fingerprints, printed while they are performing the restore, is the one
   signal that arrives while the correct key may still be recoverable from the source box.
4. **The cost of a false positive is bounded and the operator holds the remedy.** There is exactly
   one legitimate mismatch — a deliberate rotation — and it has an explicit, documented, audited
   override.

This is the same reasoning `resolveHsts` (ADR-0029) and `resolveDeployMode` (ADR-0062) use for
throwing on a malformed value, one level up. A security control whose quiet failure mode is *"the
operator believes they are protected"* fails loudly instead.

**Where the gate lives, and why not in `buildApp`.** Constructing a Fastify app is not the act that
puts a deployment into service, `buildApp` is synchronous, and roughly a hundred test files
construct apps against databases whose recorded fingerprint they know nothing about. A control that
fired on construction would be a control every fixture had to work around — which is how controls
end up disabled. So the boot sequence moved out of `main.ts` into `boot.ts` (`startGateway`), the
gate sits between `runMigrations` and `app.listen`, and a test drives that real function. Two tests
assert the converse directly: `buildApp` with a deliberately mismatched key — and with no key at
all — still constructs and serves.

### 4. Rotation: the legitimate mismatch, and what is deliberately NOT built

```
REGULAIT_DATA_KEY_ROTATED_FROM=<the fingerprint being left behind>
```

Deliberately **not a boolean**. A boolean set once sits in an env file forever, blessing every
future mismatch including the accidental one this ADR exists to catch. Naming the *old* fingerprint
means the operator must have read the refusal to write the value; the declaration is single-use by
construction (it matches exactly one recorded value); and a stale one is inert rather than
dangerous — asserted by a test that leaves a wrong declaration in place and watches the boot refuse
anyway.

**Full re-encryption is NOT implemented, and this is a deliberate scope decision rather than an
oversight.** Doing it properly means: a resumable, transactional walk over twelve ciphertext columns
in eleven tables, holding both keys simultaneously, with a per-row marker of which key each value is
under so an interrupted run can be resumed rather than restarted, refusal of concurrent writes to
those tables while it runs, and a test per column proving every row round-trips and none is left
behind. That is a slice of its own. Half-building it — a best-effort loop with no resumption marker
— would be strictly worse than not building it, because it would fail in the middle and leave
exactly the two-keys-in-one-database state §3.2 identifies as the worst outcome.

So the override does what it says and no more: it **re-records the fingerprint**, audited with both
values, and its own message states plainly that *nothing has been re-encrypted* and that any
ciphertext still under the old key is now unreadable. It is for an operator who has already
re-encrypted out of band, or who is knowingly abandoning the old ciphertext and re-entering
credentials by hand.

**Named follow-up scope**: `POST /v1/security/data-key/rotate` — a resumable, transactional,
per-column re-encryption over `CIPHERTEXT_COLUMNS` (which exists in code precisely as that work
list), gated by an Approvals-Queue entry, with a per-row key-generation marker and a test asserting
every column round-trips and zero rows remain under the old key.

### 5. The custody attestation, and its honest limits

`data_key_attestations` is append-only: `fingerprint`, `attested_by_user_id` (nullable, `ON DELETE
SET NULL`, so deleting a user cannot erase the record), `attested_by_label` captured as text at
attestation time, `method` (`password_manager | kms | escrow | offline | other`), a **non-secret**
`location_hint`, a note and a timestamp. Recording one requires an explicit
`confirmRecordedOutOfBand: true` and writes an audit row naming the actor and the fingerprint.

**Say plainly what this is: it records a human's CLAIM. It does not verify custody, and it never
will.** What it changes is the converse — *"nobody has ever said they hold this key"* stops being
invisible:

- the gateway boot line reads `NO CUSTODY ATTESTATION ON FILE` next to the fingerprint;
- `GET /v1/security/data-key` returns `attested: false` with a warning saying, in words, that a
  backup of this deployment may not be restorable;
- the admin portal's **Data key custody** page renders it as an alarm, not a hint;
- **every backup run logs it, puts it in the manifest, the S3 object metadata, the `RESULT=` line
  and the status file, and publishes a separate `DataKeyAttested` 1/0 CloudWatch datapoint** —
  deliberately not folded into `BackupSuccess`, because a dump can be perfectly verified *and*
  unrestorable, and conflating those either masks a real dump failure or fails a run that genuinely
  succeeded.

The `location_hint` field refuses any value containing 64 hex characters. Somebody pasting the key
into the field that asks where they put the key would write it in plaintext into the database and
therefore into the backup — the exact failure this whole ADR exists to prevent.

### 6. What an operator must actually do

1. **At install**, `scripts/install.sh` prints the generated key and its custody banner. Record it
   out of band — a password manager, an SSM `SecureString` under a *different* KMS key, an offline
   safe. Anywhere whose failure is independent of this host's disk.
2. **After the first boot**, read the `data key:` line in the gateway log, or open
   **Admin → Settings → Data key custody**, and confirm the fingerprint.
3. **Attest it** — `POST /v1/security/data-key/attestations` or the portal button. This is the step
   that makes the record exist.
4. **Before any restore**, compare the fingerprint in the dump's `manifest.json`
   (`data_key_fingerprint`) — or in the S3 object metadata, readable with `head-object` without
   downloading the dump — against the key you are about to configure. If they differ, you do not
   have the right key, and you know it *before* you restore rather than after.
5. **Periodically**, `pg-backup.sh --check` prints the live custody state, and
   `--verify-restore` reads the fingerprint back **out of the restored copy**, proving the answer
   survives the round trip.

## Consequences

**Easier**

- The restore-onto-a-new-box failure is now **loud and immediate** instead of silent and delayed,
  and it fails at the one moment the correct key may still be recoverable.
- A backup artifact **says which key restores it**, answerable from `aws s3api head-object` without
  downloading or restoring anything.
- "Has anyone recorded the key?" is a query, a metric and a portal state rather than a hope.
- The full ciphertext inventory is enumerated in code, drift-tested against the schema, and doubles
  as the work list for the rotation follow-up. A thirteenth column added later fails the build
  rather than quietly escaping the probe.
- The boot sequence is now a testable function (`startGateway`), so *"the gateway refuses to start"*
  is provable by exercising the start rather than by re-implementing it in a test.

**Harder / given up**

- **One more way for a boot to fail.** A deployment whose env is mis-set now refuses instead of
  coming up wrong. That is the intended trade, and it is still a trade: an operator who rotates a
  key without reading this document gets a refusal they must resolve.
- **Rotation is declared, not performed.** The override re-records the fingerprint and does not
  re-encrypt. Stated in the message, in the ADR and in the runbook — and named as follow-up scope
  rather than half-built.
- **One more environment variable** (`REGULAIT_DATA_KEY_ROTATED_FROM`), which should be removed
  after it is consumed. A stale value is inert, but it is litter.

**The honest residual, stated plainly**

1. **The attestation records a claim, not custody.** A dishonest or mistaken operator can attest a
   key they do not hold, and the product cannot tell. What it buys is that the *absence* of a claim
   is now impossible to overlook, and that a claim has a named author, a timestamp and an audit row.
2. **A first boot on an empty database records whatever key is present.** With no ciphertext there
   is nothing to verify against, so the fingerprint is a record of what was used, not a proof it was
   the intended key. This is unavoidable — there is no prior state to compare with — and the boot
   line says so in the same breath (`this deployment has no stored ciphertext yet, so there was
   nothing to verify against`).
3. **This detects a wrong key; it does not recover a lost one.** If the key is genuinely gone, every
   credential must be re-entered by hand. The mechanism makes that discovery immediate and
   unambiguous; it does not make it painless.
4. **The gate binds the gateway process only.** A `psql` session, the seeder, or any future process
   that opens its own connection is outside it — the same application-layer limit ADR-0060 records
   for the audit chain. The fingerprint in the database is evidence, not an access control.
5. **Nothing here changes the backup's contents.** The key is still not in the dump, on purpose. The
   only new bytes in the artifact are the fingerprint and the custody state.

**Where it lives**

- `packages/db/migrations/0075_data_key_custody.sql` — `data_key_state` (singleton, CHECK-enforced)
  and `data_key_attestations`; `packages/db/src/schema.ts` adds both tables and the `data_key`
  audit `objectType`.
- `apps/gateway/src/data-key.ts` — `dataKeyFingerprint`, `probeCiphertext`, `CIPHERTEXT_COLUMNS`,
  the pure `decideDataKeyBoot` matrix, `verifyDataKeyOnBoot`, `describeDataKey`, `dataKeyPosture`,
  `recordAttestation`, and the three admin routes.
- `apps/gateway/src/boot.ts` — `startGateway`: the boot sequence extracted from `main.ts` so the
  gate sits between migrations and `listen`, and so a test can drive the real start.
- `apps/gateway/src/main.ts` — five lines, and a `DataKeyBootError` handler that prints the message
  rather than a stack trace and exits 1.
- `infra/scripts/pg-backup.sh` — `read_data_key_custody`, the manifest fields, the S3 object
  metadata, the extended `RESULT=` line, the status file, the `DataKeyAttested` metric, the
  `--check` section, and the rehearsal reading the fingerprint back out of the restored copy.
- `apps/web/src/views/admin/settings/DataKeyPage.tsx` (+ route and nav entry).
- Docs: `docs/ops/DB_BACKUP.md`, `docs/deployment/BACKUP_RESTORE.md`, `docs/deployment/README.md`,
  `docs/deployment/INSTALL.md`, `scripts/install.sh`.
- Tests: `apps/gateway/src/data-key-custody.test.ts` (39) — the fingerprint's
  stability/discrimination/non-leakage, the full boot matrix as a pure function, the **real restore
  end to end** (boot under key A, write a real encrypted credential through the real route, restart
  under key B, assert the boot rejects *and* that a TCP connect to the port is refused), the
  declared and stale rotation paths, the first-boot-after-upgrade probe on a second scratch
  database, the attestation lifecycle and its audit row, the key-material refusal, and the two
  assertions that `buildApp` is untouched by any of it.

**Still not production.** Nothing here changes the deployment's status, and the standing guardrail
in `CLAUDE.md` is untouched.

## Amendment (2026-08-22, batch B4) — §4's named follow-up built: the resumable, transactional re-encryption walk (migration 0099)

§4 said full re-encryption "is a slice of its own" and named its shape exactly. This is that
slice, built to that shape: **with both keys present, every ciphertext row is genuinely
re-encrypted under the new key — in bounded batches, each batch one transaction, restartable
after a crash, and refusing to lie about progress.**

**Invocation — a CLI, deliberately not an HTTP mutation.**

```
REGULAIT_DATA_KEY=<new key> REGULAIT_DATA_KEY_OLD=<old key> \
  pnpm --filter @regulait/gateway reencrypt
```

The walk visits every row of thirteen ciphertext columns while holding two live keys; inside an
HTTP request that invites a proxy/client timeout mid-walk and an operator "retry" racing the
first attempt. So HTTP gets a **status-only** endpoint (`GET /v1/security/data-key/reencryption`,
admin, internal) and the walk runs only as a foreground CLI (the seed-script idiom). Note the env
contract: `REGULAIT_DATA_KEY_ROTATED_FROM` holds the old key's **fingerprint** — a PRF output,
which cannot decrypt anything — so the walk takes a new variable, **`REGULAIT_DATA_KEY_OLD`**,
holding the old key's full 64 hex chars. It refuses to start without both keys, and exits 0 with
"nothing to do" when the recorded fingerprint already names the new key and zero rows remain
outside it.

**Resumability: the watermark IS the transaction.** Progress lives in
`data_key_reencryption_runs` / `_progress` / `_failures` (migration 0099): one watermark row per
(run, table, column), committed **in the same transaction** as that batch's rewritten rows — so
"these rows are under the new key" and "the walk is past them" are one atomic fact. A kill at any
instant leaves the run `running`; the next invocation with the same two keys resumes from the
exact watermark. Proven by aborting after N committed batches in-test, resuming, and asserting
**byte-identical ciphertext** for already-settled rows (a second encryption would mint a fresh
IV) plus a zero re-read count — no double-processing, no missed rows.

**Which key is a row under?** The stored envelope did not say — `iv.tag.ciphertext` carried no
key identity — so `encryptSecret` now appends the encrypting key's fingerprint as a **fourth
segment** on every NEW write. It is a claim, not a proof (the GCM tag still decides; a test
plants a lying marker and watches decryption refuse); its job is to let the walk skip
already-settled rows idempotently without trial decryption. **Legacy three-segment rows** — every
value written before this change — are resolved by try-old-then-new trial decryption and
rewritten with the marker either way.

**Fail closed on registry drift.** `CIPHERTEXT_COLUMNS` stays the single work list, and before
touching anything the walk asks `information_schema` for every `*_ciphertext` column in the live
database, refusing to start if the two disagree in either direction — a column silently left
under the old key is exactly the two-keys-in-one-database state §3.2 calls the worst outcome.
(The custody test pins the list against `schema.ts`; this check pins it against the actual
database about to be modified.)

**Honesty.** A row that decrypts under NEITHER key is recorded (table + id, in
`data_key_reencryption_failures`) and the walk **continues** — one corrupt row must not brick a
rotation — but the run's final status is **`completed_with_failures`, never `completed`**, the
CLI exits nonzero (2), and the audited completion record names every failed row alongside
per-table counts and duration. The fingerprint IS still re-recorded to the new key even then:
the failed rows decrypt under neither key, so keeping the old fingerprint would not make them
readable — it would only force the next boot to declare a rotation the walk has in fact
performed. The failure record, not the fingerprint, is what says those rows are lost.

**The boot gate knows about the walk.** After a completed walk, a boot under the new key alone
is an ordinary `verified` — no rotation declaration needed. An INCOMPLETE walk adds itself to
the boot line, the posture warnings, and (when the pending run's keys explain the mismatch) the
refusal message itself, which now names the exact resume command instead of sending the operator
down the abandon-the-old-ciphertext path.

**Key custody consequence.** The OLD key must remain available until the walk reports
`completed` — destroy it before that and every not-yet-walked row becomes a `failures` entry.
After completion the old key should be destroyed per the custody runbook
(`docs/ops/DB_BACKUP.md`), `REGULAIT_DATA_KEY_OLD` removed from the environment, and the new key
attested.

Non-vacuity the M-002 way, all three reverted by reversing the exact edit: no-op the write-back
(decrypt/encrypt but skip the UPDATE) → 4 tests redden, led by the both-directions proof; break
resume (restart from zero) → the no-double-processing assertion reddens (4 settled rows re-read);
count a neither-key row as success → the `completed_with_failures` test reddens to `completed`.

**Where it lives**: `packages/db/migrations/0099_data_key_reencryption.sql` (+ `schema.ts`);
`apps/gateway/src/data-key-reencrypt.ts` (the walk, the status read, the route);
`apps/gateway/src/reencrypt.ts` (the CLI); `apps/gateway/src/secrets.ts` (the fingerprint
segment — the derivation moved here from `data-key.ts`, surface unchanged);
`apps/gateway/src/data-key.ts` (boot-time pending-walk awareness);
`apps/gateway/src/data-key-reencrypt.test.ts` (12 tests, own scratch database).

**Honest residual**: the walk takes no table locks beyond each batch's `FOR UPDATE`, so a
credential **written under the new key during the walk** is simply skipped by its marker — fine —
but a concurrent write under the OLD key (impossible through the gateway, which only ever holds
the new key; conceivable from a rogue `psql`) after the watermark has passed that row would be
missed until a later walk. §4's "refusal of concurrent writes" clause was deliberately narrowed
to this: the gateway process cannot produce old-key writes, and the walk is idempotently
re-runnable, which is the honest remedy.
