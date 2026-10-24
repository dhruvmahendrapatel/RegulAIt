# ADR-0099 — Scrub credentials out of `audit_log` at the write path, before the row is hashed

- **Status**: Accepted
- **Date**: 2026-09-06
- **Relates to**: [ADR-0060](0060-audit-tamper-evidence.md) (the hash chain, and the
  `createDb` interception point this reuses — the ordering constraint below is entirely about
  not breaking it), [ADR-0042](0042-guardrail-engine.md) (the `dlp.secret.*` credential-material
  rules, which are the detector this borrows rather than a second copy),
  [ADR-0055](0055-shadow-ai-discovery.md) (`redactKeyFragment` — "a finding is a pointer to a
  secret, never a copy of one", the bargain this generalizes),
  [ADR-0061](0061-chatops.md) (the ChatOps sensitivity fence — the other place this codebase
  decides what may leave a record), [ADR-0021](0021-org-settings-configurability-layer.md)
  (`redactSettings`, the OTLP-header precedent), [ADR-0019](0019-pii-handling.md) (PII stored as
  counts, never as matched substrings — the same counts-only discipline)
- **Migration**: none. This changes what is written into existing columns; no DDL.

## Context

`audit_log` is this product's evidence substrate. Pillar 1's whole promise — every agent, model,
connector and MCP tool call is recorded — is that table, and ADR-0060 spent a whole migration
making it tamper-evident.

**Nothing stopped a credential from being written into it.**

The structural avoidance around it is genuinely good, and this ADR is not a claim that it is not:
every secret this product holds is encrypted at rest under `REGULAIT_DATA_KEY`, no endpoint
returns one, `redactSettings` masks OTLP headers on read, `redactKeyFragment` truncates a shadow-AI
key fragment before a finding is stored, and PII lands in MCP audit detail as counts.

But `detail` (jsonb) and `reason` (text) are **free-form**, and they are written **by hand**. At the
time of writing there are thirty-odd audit call sites behind roughly ten separate module-local
`audit()` helpers — `licensing.ts`, `billing.ts`, `reporting.ts`, `custom-providers.ts`,
`lineage.ts`, `compliance-packs.ts`, `risks.ts` and more — plus a long tail of raw
`db.insert(auditLog).values(…)` calls that go through no helper at all. Every one of them
interpolates strings. Some of those strings come from a request body. Correctness rested entirely
on convention, and **no test asserted that a secret could not land in an audit row.**

Two properties make this worse than an ordinary logging leak:

1. **The ledger is append-only by design and hash-chained by ADR-0060.** Deleting a secret out of a
   row after the fact is not a cleanup; it is an edit, and verification reports it as
   `content_mismatch` — indistinguishable from the tampering the chain exists to catch. There is no
   after. **The write is the only chance.**
2. **The ledger is the thing you hand an auditor.** A credential in it does not sit in a log file
   nobody reads; it sits in the export, the compliance pack and the retention window.

## Decision

**Scrub at the lowest level — the single chained-insert path — before the row is hashed.**

### 1. Where it is sited, and why that is the whole point

ADR-0060 already solved "there is no single audit-insert path" by *making* one: `withAuditChain`
wraps the handle returned by `createDb`, so `insert(auditLog)` is a genuine chokepoint that every
call site passes through without knowing it exists. The scrub goes **inside that chokepoint**, in
`appendChainedAuditRows` (`packages/db/src/audit-chain.ts`):

```ts
const fields = scrubAuditRow(resolveDefaults(raw));
const contentHash = auditContentHash(fields);
```

The alternative — a `scrubbedAudit()` helper the ten local `audit()` helpers are refactored onto —
was rejected for the same reason ADR-0060 rejected rewriting 158 call sites: **it makes the control
a convention.** The next call site, written next month by someone who has not read this ADR, is a
raw `db.insert(auditLog)` and silently escapes it. Siting it here means the escape is not possible
from application code at all, and the e2e suite proves it the only way that claim can be proven:
by driving a raw `db.insert(auditLog)` — no helper, no route — and by driving one inside a caller's
own `transaction()`, and SELECTing both rows back.

### 2. The ordering constraint, which is load-bearing

**Scrub, then hash. In that order.** `content_hash` is taken over the row's immutable facts, which
include `detail` and `reason`. If the scrub ran after the hash, the row that was hashed and the row
that was stored would differ, and ADR-0060's verification would report **every redacted row as
`content_mismatch`** — that is, the control that exists to make tampering visible would flag the
control that exists to keep secrets out, on rows nobody touched. That is not a cosmetic bug; it is
the fastest possible way to make an integrity report get ignored.

Because the scrub returns the object that is then both hashed and inserted, the two cannot drift.
The proof is a test that SELECTs each redacted row's stored columns, recomputes
`auditContentHash` over them and compares to the stored `content_hash`, plus a bounded
`verifyAuditChain` over exactly the seq range the suite wrote, asserting `status: "ok"` and
`firstBreak: null`.

### 3. Detection: ADR-0042's rules, extended once, never copied

The credential-material rules already exist in `packages/shared/src/guardrails.ts` as the
`dlp.secret.*` family: `aws_key`, `private_key`, `jwt`, `assignment`, `provider_token`. This ADR
does **not** write a second set. It exports the subset as a **filter of the same array**:

```ts
export const CREDENTIAL_MATERIAL_RULES = DLP_RULES.filter((r) => r.category === "credential_material");
```

so adding a shape extends both the guardrail detector and the scrubber, and there is no way to add
one to only one of them. A test asserts the two lists are identical.

One rule is **added**, in `guardrails.ts` where it belongs: `dlp.secret.regulait_token`, covering
the credential shapes this product actually mints — `rgl_` (ADR-0025 API key), `rglv_` (ADR-0066
virtual key), `rgls_` (session) and `rglscim_` (SCIM bearer). That this product minted four
credential formats and its own DLP detector recognised none of them was its own small gap; the
guardrail engine now catches them too, at its shipped `log` posture.

### 4. Detection: field names, for the credentials that have no shape

A regex cannot help with the bootstrap token (deploy-time config, no format), `REGULAIT_DATA_KEY`
(base64 of 32 random bytes — indistinguishable from any other base64) or a connector/model
credential (whatever the third party issues). What those **do** have is a name.

So a string value whose **key** is one of a fixed list — `token`, `apiKey`, `secret`,
`clientSecret`, `password`, `privateKey`, `bootstrapToken`, `dataKey`, `credentials`,
`refreshToken`, `authorization`, … — is redacted whole, at any depth, through arrays.

Two guards keep this from eating the ledger, and both are the reason it is safe:

- **Exact match on the normalized key, never substring.** `token` and `tokens` are one keystroke
  apart in this codebase, and every cost row in it carries `tokensIn`/`tokensOut`. A substring rule
  would have redacted the entire cost ledger. `tokensIn`, `tokenCount`, `totalTokens`, `apiKeyId`,
  `scimTokenName` and `secretsScanned` all survive, and a test names each one.
- **String values only.** A `token` field holding `1200` is a count, and counts stay counts.

### 5. The replacement, and why it is not `[redacted]`

`redactSettings` can afford a bare marker because it redacts a **read** of a row that still exists.
This redacts the **record**. A marker that erased which kind of credential was involved, or that
collapsed two different secrets into identical text, would damage the ledger in the course of
protecting it: an investigator could no longer tell *"the same key turned up in both incidents"*
from *"two unrelated keys did"*.

**The rule, stated:**

```
[redacted:<rules>:<length>:<fingerprint>]
```

| part | what it preserves |
| --- | --- |
| `<rules>` | the `dlp.secret.*` rule id(s) that matched, short form (`aws_key`, `jwt`, `regulait_token`, `assignment+jwt` when a run matched both), or `field` when the field NAME drove it — **which kind** of credential |
| `<length>` | characters removed — **how much** |
| `<fingerprint>` | first 12 hex of SHA-256 over the removed text — **which one**, without saying what it was |

Three further rules of the same kind:

- **Only the matched run is replaced.** `"rotating after AKIA… was found in the connector config"`
  keeps the verb, the object and the word order. The sentence is the evidence; the twenty
  characters in the middle are not.
- **An assignment keeps its field name.** `dlp.secret.assignment` matches the whole
  `api_key = "…"` phrase. Redacting all of it would erase exactly the fact most worth having, and
  make `password = x` and `client_secret = y` identical in the ledger — so the span is **narrowed**
  to start after the `:`/`=`. The name is not the secret.
- **A PEM block is taken whole.** The shared `private_key` rule matches the BEGIN **header line**
  only, which is enough to *count* a hit and useless to *remove* one — replacing the header would
  leave the entire base64 body sitting in the row. The span is **extended** to just past the
  matching `-----END …-----`, or to the end of the string if the block is truncated. Extending or
  narrowing a span the shared rule found is not a second copy of the rule; there is still exactly
  one definition of "this looks like a private key".

This is `redactKeyFragment`'s bargain — keep enough to correlate, lose enough to be useless — with
the kept part moved from a **prefix** to a **hash**, because an audit-log secret has no bounded
length to hide behind the way a 12-character evidence fragment does.

### 6. The over-scrub guard, treated as a first-class requirement

An audit ledger whose legitimate content gets mangled is a **worse** outcome than the risk being
closed. So the negative case is asserted as hard as the positive one, and in the strongest available
form: **identity, not equality.** A string with no credential in it is returned as the same string;
an unchanged subtree is returned as the same object; an unchanged row is returned as the same row —
the common path does not rebuild anything, so it cannot accidentally change anything. And
`scrubAuditRow` only ever **overwrites** a field, never introduces one, because "absent" and
"present and undefined" are different inputs to ADR-0060's canonicalizer (rule 4).

Pinned by test, in Postgres and by SELECT: uuids, emails, model names (`claude-opus-4-20260101`),
rule ids (`mcp.allow.default`), costs, token counts, ISO timestamps, a sha256 digest, prose about
secrets (*"we store secrets in the encrypted vault, never in git"*) and the empty string all come
back byte-identical.

## What this deliberately does NOT do

- **It does not block, warn or refuse.** A caller that writes a credential still gets an audit row;
  it just gets a redacted one. Refusing the write would mean losing the audit record entirely,
  which is the wrong trade for an evidence substrate.
- **It does not alert.** Nothing today counts redactions or raises a finding when one happens, even
  though a redaction is by definition a bug at some call site. The marker prefix makes
  `reason LIKE '%[redacted:%'` a one-line query, but no dashboard runs it.
- **It does not touch `rule_id` or `rule_chain`.** Those are a controlled vocabulary of policy
  identifiers that queries, reports and the compliance packs group by. Scrubbing them would risk
  breaking real aggregation to defend a field nobody interpolates user input into.
- **It does not retroactively clean existing rows.** It cannot: rewriting a chained row is exactly
  the tampering ADR-0060 detects. Rows written before this change are what they are.
- **It does not encrypt, tokenize or vault the removed value.** The value is gone. The fingerprint
  is a correlation handle, not a recoverable reference — there is no "unredact".
- **It is not a second guardrail posture.** The org-settings guardrail modes do not gate it and
  there is no dial to turn it off. A control that an admin can disable on the audit ledger is not a
  control.

## Honest limits — what a determined caller can still get into the ledger

This is a **shape and field-name** filter, and it inherits every limitation ADR-0042 already states
about its heuristic tier. Specifically:

- **An unshaped secret in an unnamed field passes.** `detail: { note: "the value is hunter2" }` is
  invisible to both halves. A determined or careless caller can always defeat a pattern matcher;
  encoding a credential in base64, splitting it across two fields, or putting it in a field called
  `misc` all work.
- **`rule_id`, `rule_chain` and `object_id` are unscrubbed** by the deliberate choice above. A
  caller who puts a secret in `ruleId` gets it stored.
- **The fingerprint is unsalted, truncated SHA-256.** For a high-entropy credential — which every
  credential this product mints is — that is one-way. For a **low-entropy** one a caller shoved
  into a reason string (`password = hunter2`), an attacker holding the ledger can confirm a guess.
  It is strictly better than storing the value and strictly worse than a keyed MAC; a per-install
  salt is a recorded follow-up.
- **It binds code that goes through `createDb`, and nothing else** — the same honest limit ADR-0060
  records for the chain itself. A `psql` session or a future module that builds its own `pg.Pool`
  writes whatever it likes. Unlike the chain, this failure is **silent**: an un-scrubbed row is
  reported as `missing_hash` by chain verification only if it is also un-chained, and a module that
  bypasses `createDb` fails both at once. A PL/pgSQL trigger remains the strictly stronger option
  and remains unbuilt, for the reason ADR-0060 gives — it would need a second canonicalizer.
- **Depth is bounded at 24.** `detail` is caller-supplied JSON inside a transaction; a pathological
  nesting must not blow the stack and take the audit row down with it. Past the limit the subtree
  passes through **unscrubbed** rather than being dropped, because losing evidence is the worse
  failure. Nothing in this product nests audit detail anywhere near that deep.
- **It costs one pass over every audit write.** Six regexes over `reason` plus a walk of `detail`,
  on a path that already takes an advisory lock and a round trip. Not measured; believed
  irrelevant next to `pg_advisory_xact_lock`, and said here rather than claimed as free.
- **It cannot un-ring a bell rung before it shipped.** Every row written before this change is
  outside it, permanently.

## Non-vacuity (M-002, measured)

`marker()` neutralised to return the removed text unchanged — a true no-op scrub, with no
unreachable code for the compiler to reject.

**19 tests reddened.** Gateway (6 of 9): the AWS-key-through-a-real-route case, the
product-minted-shapes/PEM case, the cross-row correlation case, the raw-`db.insert` case, the
raw-insert-inside-a-transaction case, and the content-hash recompute (which failed by finding zero
redacted rows — the correct signal). Shared (13 of 26): the marker grammar, correlate, discriminate,
all six shape cases, the PEM extension and truncation cases, the assignment-name case, the
overlapping-rules case, all three field-name cases, and the never-introduces-a-column case.

**The three tests that correctly stayed GREEN are the point of the exercise**: both over-scrub
guards (ordinary reason and ordinary detail stored byte-identical) and the bounded
`verifyAuditChain`. A no-op scrub *must* leave ordinary content alone and *must* still produce a
valid chain — a guard that reddened under a no-op would have been asserting the wrong thing.
The probe was reverted exactly; `git status` clean before the ADR was written.
