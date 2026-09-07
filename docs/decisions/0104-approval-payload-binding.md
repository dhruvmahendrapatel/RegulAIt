# ADR-0104 — An approval is bound to the arguments it was approved for

- **Status**: Accepted
- **Date**: 2026-09-07
- **Relates to**: [ADR-0060](0060-audit-log-hash-chain.md) (`canonicalJson` — the one canonicalization,
  reused here rather than re-implemented), [ADR-0099](0099-audit-log-credential-scrub.md) and
  [ADR-0102](0102-operator-prose-credential-scrub.md) (`scrubAuditDetail` — the one redactor, reused
  for the approver-facing preview), [ADR-0040](0040-abac-policy-layer.md) (the ABAC route into the
  same queue — see the honest limits), [ADR-0073](0073-config-versions-canary.md) (rule bodies
  resolve through `config_versions`, so an older body carrying no scope has to read as the strict
  one), [ADR-0022](0022-approval-delegation.md) / [ADR-0046](0046-approvals-workbench.md) (the one
  queue and its inbox, whose row shape carries the new fields with no route change),
  [ADR-0103](0103-mcp-path-project-budget-gate.md) (the budget gate sited immediately above the
  queueing block this ADR changes)
- **Migration**: `0106_approval_payload_binding` — `approvals.arguments_digest`,
  `approvals.arguments_preview`, `approval_rules.approval_scope`.

## Context

Pillar 1's Approvals Queue is the mechanism by which a human takes responsibility for a call the
policy would otherwise refuse. Everything downstream — the audit trail, separation of duties, the
delegation window, the workbench — is built on the premise that the row an approver signs
*identifies the thing they agreed to*.

**It did not.** An `approvals` row for a governed MCP tool call carried the user, the server, the
tool and a status. It carried **no arguments at all**, and four independent places said so:

| where | what it said about the payload |
| --- | --- |
| `packages/db/src/schema.ts` — the `approvals` table | nothing; there was no column |
| `apps/gateway/src/governed-evaluate.ts` — the approved-approval lookup | keyed on `userId`, `serverId`, `toolName`, `status = 'approved'`, and nothing else |
| `apps/gateway/src/mcp-proxy.ts` — the queueing block | inserted user/server/tool/rule/approver; the arguments were in scope and were not written |
| `apps/gateway/src/mcp-proxy.ts` — the tool-call audit row | recorded effect, rule, chain and reason; no payload |

So the guarantee the queue actually provided was **"user X may call tool T on server Y once"**. An
approver signed off on that sentence with no way to see what the call would do, and the caller could
then execute the tool with **entirely different arguments** — a `write_note` approved for a benign
note, spent on an exfiltration payload. And because the audit row was equally silent, there was
afterwards **no forensic record of which arguments actually ran**. Both halves of the failure matter,
and they are independent: one is about consent, the other is about evidence.

### What was already true, and is not being re-litigated

Two compensating controls existed and are deliberately untouched:

1. **Consumption is atomic and single-use.** The approval is spent by a conditional `UPDATE ... SET
   status = 'consumed' WHERE id = ? AND status = 'approved'`, and the loser of a race is told so.
   That bounded the exposure to **one** argument swap per approval cycle rather than unlimited
   reuse — real mitigation, and not a fix.
2. **`data_scope_rules` already constrain argument VALUES** (`argPath` / `allowedValues`,
   `packages/policy-kernel/src/index.ts`), evaluated *before* approval satisfaction and failing
   closed on a missing or non-scalar value.

**`data_scope_rules` is complementary, not redundant, and the distinction is the whole point.** It
answers *"which values may this user ever put in this field?"* — a standing, operator-authored
restriction that exists whether or not anyone is approving anything. The digest introduced here
answers a different question: *"is THIS consent, granted by THIS named human at THIS moment, consent
for THIS call?"* A data-scope rule permitting `region ∈ {eu-west-1, us-east-1}` does not tell you
which of the two Carol signed for, and it says nothing at all about the fields nobody wrote a rule
about — which, on a real deployment, is most of them. Neither control substitutes for the other:
the rule bounds the space of permissible calls, the digest pins the one call a signature covers.

The real defect was therefore not only the missing column. **No ADR stated the intended semantics
of an approval at all**, so there was nothing for the implementation to be wrong against.

## Decision

**Consent is ACTION-SCOPED by default: an approval is bound to the exact call arguments (and
project) it was granted for. `tool` scope is an explicit, per-rule escape hatch an operator must
ask for by name.**

### 1. Why action-scoped is the default, and not the option

Pillar 1 is default-deny, and this codebase's established idiom for composing restrictions is
strictest-wins — a widened rule set composes to the INTERSECTION of allow-lists, a widened rate
limit keeps its own per-subject count, a mode-scoped rule that cannot resolve its context does not
match. Making payload binding opt-*in* would have inverted that everywhere it mattered: every
existing rule, and every rule written by someone who had not read this ADR, would keep the loose
reading. The decisive argument is simpler still: **an approver who cannot see the arguments is
deciding blind**, and the narrow reading is the only one that matches what a human believes they are
signing. `approval_rules.approval_scope` is therefore `NOT NULL DEFAULT 'action'`, so every rule that
existed when migration 0106 ran became payload-bound.

Strictest-wins applies across rules too: if **any** approval rule matching a call is action-scoped,
the call's consent is action-scoped, whatever the others say. A rule body that carries no scope at
all — an older `config_versions` version body, say — reads as `action`. An absent value is never the
loose one.

### 2. The fingerprint

`sha256` hex over a versioned, **canonical** JSON encoding of `{ projectId, arguments }`.

- **Canonical means ADR-0060's `canonicalJson`, called — not a second implementation.** That
  function already pins recursive key sorting, array-order-is-data, the `undefined`-is-absent rule
  and the number rule, against exactly the `jsonb` round trip this digest has to survive. `{a:1,b:2}`
  and `{b:2,a:1}` are one call and produce one digest. Two canonicalizers that could drift is the
  bug this feature is trying to fix, in a new place.
- **Computed on the RAW arguments, before any scrubbing.** Redaction changes what a human reads; it
  must never be able to change what the consent is *for*. A digest taken after scrubbing would make
  two different secrets look like the same call, and would make a future edit to the redactor a
  silent edit to consent identity.
- **Absent, `undefined` and `null` arguments normalize to the same empty bag.** The MCP surface
  treats a missing arguments object and an empty one as the same call, so consent must not be able
  to distinguish them. An explicit `null` *value* at a key stays distinct from an absent key, because
  `jsonb` preserves that distinction and ADR-0060 already respects it.
- **`projectId` is in the fingerprint.** The same tool with the same arguments reaches different
  data, bills a different pillar-5 ledger, and may sit under a different compliance cascade in
  another project. An approval granted in project A is not spendable in project B.
- **The user, server and tool are NOT in the fingerprint**, because they are already the lookup key.
  Hashing them twice would only make the digest opaque about which dimension failed to match.
- **It is versioned** (`regulait.approval-binding.v1`). If the field set or the canonicalization
  ever changes, the tag changes with it, and every pre-existing digest stops matching — a re-queue,
  never an accidental match.

### 3. The preview

`approvals.arguments_preview` is the payload as ADR-0099's `scrubAuditDetail` renders it — **the one
redactor in this repo, called**, not a second one. ADR-0099 and ADR-0102 exist precisely so there is
one place a new scrub rule has to be added; this is a new consumer of it and inherits every rule it
has and every rule it gains.

The approver reads the preview; the machine matches the digest. They are derived from the same raw
value in that order, so a secret can be hidden from a human without the consent it represents moving
at all.

`GET /v1/approvals` selects the whole row, so **no route change and no `apps/web` change was needed**
— the columns reach the inbox on their own.

### 4. Matching, and what a legacy row satisfies

The approved-approval lookup now loads the candidate rows with their digests (ordered by
`requested_at`, oldest first — it used to be a `LIMIT 1` with no `ORDER BY`, which under Postgres is
an arbitrary row) and picks:

- an **exact digest match** satisfies under either scope;
- under **`tool`** scope, any approved row satisfies — including one carrying a different payload's
  digest, and including a legacy row with none. That is what the escape hatch means;
- under **`action`** scope, nothing else satisfies.

### 5. Queueing — the dedup key had to change too

The queueing block reused an existing pending entry "rather than piling up duplicates", keyed on
user/server/tool/pending. Under a payload-bound consent that is **the same hole in a new place**: a
second call with a completely different payload would collapse into the first call's pending row,
the approver would read the first payload, sign it, and the second payload would ride along on that
signature. Under action scope the dedup therefore also keys on the digest. Under `tool` scope it
deliberately does not — one pending entry standing for a tool regardless of arguments is exactly
what that scope means.

The new row stores the digest and the scrubbed preview under **either** scope: a tool-scoped
approval still deserves to show a human what raised it.

### 6. Audit — unconditional, and independent of the consent decision

The executed digest goes on **every** governed tool-call audit row, whatever the governing rules'
scope, and whatever the effect. The record of what ran is not a consequence of the consent
semantics; it is owed either way. It is the **digest**, never the arguments — the audit log is not a
place to put a payload that may carry a secret, and the scrubbed rendering already lives on the
queue row.

## What this deliberately does NOT do

- **It does not remove or duplicate the compensating controls.** Atomic single-use consumption is
  untouched and re-pinned; `data_scope_rules` is untouched and still runs first, still fails closed.
- **It does not put arguments in the audit log.** Only the digest.
- **It does not add an org-level switch.** A global "bind payloads" toggle would be a second place
  the answer lives, and an operator who wants the loose reading for one tool would have to loosen it
  for everything. The scope is per rule, on the record, where the approver requirement itself is.
- **It does not re-key the other object types.** `workflow`, `run`, `project`, `infra_operation`,
  `model_card`, `copilot_proposal`, `training_job`, `grant_certification` and `sod_override` rows
  ride the same one queue and are unaffected: they are not looked up by user/server/tool, and their
  subject is already a specific identified object.
- **It does not attempt an upgrade backfill.** See below.

## Honest limits

- **Legacy rows change behaviour on upgrade day, deliberately.** An approval that was already
  `approved` when migration 0106 ran has `arguments_digest IS NULL`. Under the default action scope
  it does **not** satisfy a call: the call re-queues, and the re-queued row is born with a digest, so
  the population heals itself within one approval cycle. This is fail-closed and self-healing, and
  it is a real, visible change — an operator with signatures in flight at upgrade time will see them
  ask to be re-signed. Backfilling a digest was rejected outright: any value we invented would be
  manufacturing a consent record that no human gave, which is worse than admitting the row predates
  the feature.
- **An ABAC-driven pause is still tool-scoped.** When ADR-0040's Cedar layer returns
  `require_approval` and **no** `approval_rules` row also matches, there is no rule to carry an
  `approval_scope`, so the strictest-wins computation falls to its default of `action` only when a
  matching rule exists; a pure-ABAC pause with no matching rule takes the default too — but the
  scope is not configurable per policy, because `abac_policies` has no such column. Giving ABAC
  policies their own scope dial is out of scope here and is a genuine residue.
- **The digest binds the arguments, not the world they act on.** Two identical calls a week apart
  have the same fingerprint. If the state the tool reads or writes changed in between, the approval
  is still spendable on the later one. Binding to state would require a reservation, not a hash.
- **It does not bind the CALLER's intent beyond the payload.** Everything the governed layer knows
  about the call is in the fingerprint; anything the tool derives server-side (a clock, a cursor, an
  upstream default) is not, and cannot be.
- **A tool-scoped rule is a real loosening and is recorded as one.** It restores exactly the
  pre-ADR-0104 semantics for the rules that carry it. It is legitimate where the arguments genuinely
  do not change what it means to approve — a parameterless health check, a read whose only argument
  is a page cursor — and it is the wrong answer everywhere else.
- **The audit row is not transactional with the call**, as elsewhere in this codebase.

## Non-vacuity (M-002, measured)

The match was neutralised in place — `approvedApprovalId` restored to the pre-ADR-0104
`approvedRows[0]?.id ?? null`, and the digest dropped from the pending-entry dedup key, with the
columns and the digest computation left in place so nothing was unreachable — and the suite re-run
against a freshly created database.

**7 of the 10 new gateway tests reddened, and the negative control reddened in exactly the right
way**: `expected 'allowed' to be 'approval_required'` — under the neutralised match, an approval
signed for `{text:"safe"}` **executed** `{text:"exfiltrate"}`. That is the finding, reproduced.

**The 3 that correctly stayed GREEN are the point of the exercise**: both `tool`-scoped tests (the
escape hatch must behave identically with or without the binding — that is what "escape hatch"
means) and "the matching payload executes exactly once, and the second identical call re-queues"
(which asserts the *unchanged* single-use property, so a neutralised match must leave it passing).

The probe was reverted exactly; `git diff` clean against the committed tree before this ADR was
written.
