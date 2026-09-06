# ADR-0102 — Scrub credentials out of operator reason/note columns at the database handle

- **Status**: Accepted
- **Date**: 2026-09-06
- **Relates to**: [ADR-0099](0099-audit-log-credential-scrub.md) (the `audit_log` scrub this
  extends — same detector, same marker grammar, deliberately not a second implementation),
  [ADR-0060](0060-audit-tamper-evidence.md) (the `createDb` Proxy this reuses; the reason a
  chokepoint exists at all), [ADR-0042](0042-guardrail-engine.md) (`CREDENTIAL_MATERIAL_RULES`,
  the one detector), [ADR-0055](0055-shadow-ai-discovery.md) (`redactKeyFragment` — a record is a
  pointer to a secret, never a copy of one), [ADR-0021](0021-org-settings-configurability-layer.md)
  (`redactSettings`, redaction on READ, the other half of the picture)
- **Migration**: none. This changes what is written into existing columns; no DDL.

## Context

[ADR-0099](0099-audit-log-credential-scrub.md) closed a real hole: a credential pasted into a
free-form audit field is unremovable afterwards, because the row is hash-chained, so the write is
the only chance. It sited the scrub at ADR-0060's chained-insert path and it works.

**It covers `audit_log` and nothing else, and the boundary is invisible from outside.** The
retest that found this (PENDING S5) did not have to construct a scenario. One request was enough:

```
POST /v1/servers/:id/admission/clear   { "reason": "… AKIAIOSFODNN7EXAMPLE …" }

audit_log.reason                      → "… [redacted:aws_key:20:1a5d44a2dca1] …"
mcp_servers.admission_clear_reason    → "… AKIAIOSFODNN7EXAMPLE …"
```

Same handler, same string, two records of one event that **disagree about whether the secret was
contained**. An operator who has been told "reasons are scrubbed" reads the ledger and concludes
the key never landed anywhere. It landed in the row next door, unencrypted, exported by every
`select *`, and it will outlive the incident.

This is not a failure of ADR-0099 against its stated scope. It is a failure of that scope to
match what a reader assumes, and ADR-0099's honest-limits list did not name it.

A schema sweep found **53** free-form `reason` / `note` / `rationale` / `explanation` text columns
outside `audit_log`. **47** of them hold prose a human types while explaining why they did
something — `approvals.decision_reason`, `agents.lifecycle_reason`,
`config_activation_events.reason`, `agent_revocations.reason`, `connector_revocations.reason`,
`eval_runs.gate_reason`, `model_card_approvals.decision_reason`,
`mcp_servers.admission_clear_reason`, and thirty-nine more. Every one is a box that says "why?",
and "why?" is exactly where a paste lands. **Nothing asserted anything about any of them.**

## Decision

### 1. The briefed plan does not survive contact with the code, and this says so

The plan carried into this slice was to make the **shared zod reason schemas** scrub, so coverage
happens at parse time for every route that uses them. It is the right instinct — it is the closest
analogue to what made ADR-0099 sound — and it is **not implementable here, because there are no
shared reason schemas.**

Measured, not assumed: **~104** reason/note/rationale field declarations across
`apps/gateway/src` and `packages/shared/src`, and **every one of them is an ad-hoc inline
`z.string().min(1).max(N)`** written at its own endpoint —
`packages/shared/src/mrm.ts:124`, `packages/shared/src/risks.ts:212`,
`apps/gateway/src/sod.ts:1109`, and a hundred more. There is no `reasonText()` helper, no
`proseSchema`, nothing for them to have been built on. **The shared-schema layer covers zero of
the 47 columns**, because it does not exist.

So "make the shared schema scrub" would have meant editing 104 declarations and then depending on
the 105th to remember — **the per-call-site convention ADR-0099 explicitly rejected**, wearing a
zod costume. Executing the brief literally would have produced a worse control and a dishonest
ADR.

### 2. What the code does support: the same chokepoint, one level up

ADR-0099 is sound because ADR-0060 had already *manufactured* a single write path. Re-reading why:
`createDb` is the ONE place a database handle is constructed in this repo — server, seeder, every
test — and ADR-0060 put a `Proxy` there. **That Proxy is not audit-specific.** It is a handle
interceptor that currently only inspects `insert(auditLog)`. The same interception point sees
**every insert and every update to every table**.

The structural property was already there. Nothing had to be invented.

`packages/db/src/prose-scrub.ts` adds a second, composed wrapper:

```ts
export function createDb(connectionString: string) {
  const pool = new pg.Pool({ connectionString });
  return withProseScrub(withAuditChain(drizzle(pool, { schema })));
}
```

`withProseScrub` intercepts three write shapes for tables in an explicit registry —
`insert(t).values(…)`, `insert(t).onConflictDoUpdate({ set })` and `update(t).set(…)` — and scrubs
exactly the declared string columns. `transaction()` re-wraps the handle drizzle hands the
callback, which is not optional: `POST /v1/approvals/:id/decide` writes `decision_reason` inside
its own transaction, and a wrapper that forgot to propagate would have missed the single most
important column in the list while every top-level test still passed.

Two smaller choices, both load-bearing:

- **A separate wrapper, not more branches inside `withAuditChain`.** The audit chain has a
  correctness argument about hashing order that this does not share. Composing keeps each
  wrapper's argument intact and independently readable.
- **Prose scrub OUTSIDE, audit chain INSIDE.** `insert(auditLog)` must reach the chained builder,
  and it does: `audit_log` is deliberately not in the prose registry, so the outer wrapper passes
  it straight through untouched. The other order would also work; this one keeps
  `withAuditChain`'s behaviour observably unchanged.

The consequence is the property worth having: a route written next month that does a raw
`db.update(approvals).set({ decisionReason })` is covered **without its author knowing this file
exists**, and the e2e suite proves that claim the only way it can be proven — by driving a raw
`db.update()` and a raw `db.insert()` with no route and no helper anywhere in the call stack, and
SELECTing the rows back.

### 3. One detector, and the same marker — which is the actual defect S5 records

The scrub applied to a prose column is `scrubAuditText` — **the same exported function**, over
ADR-0042's same `CREDENTIAL_MATERIAL_RULES`. `PROSE_SCRUB` is a reference to it, not a copy, and a
test asserts `PROSE_SCRUB === scrubAuditText` by identity.

This is not code-reuse tidiness. S5's specific defect is that **two records of one event
disagreed**. A second detector, or a second marker grammar, would have replaced "one record says
redacted, the other says the key" with "both records say redacted, differently" — still
uncorrelatable, still an investigator unable to tell whether it was the same secret. So the
proof obligation in the test is not "the column is redacted", it is:

```ts
expect(markerIn(server.admission_clear_reason)).toBe(markerIn(audit.reason));
```

One secret, one `[redacted:aws_key:20:1a5d44a2dca1]`, in both rows. That is what makes the two
records corroborate each other.

### 4. Posture: unconditional, no knob — matching ADR-0099

ADR-0099 scrubs `audit_log` with no configuration switch, and this matches it deliberately. A
knob here would be a knob that turns credential retention **on**, in a governance product, and the
only honest label for its "off" position is "store secrets in plain text". There is no
defensible reason for an admin to want it, and its existence would be the first thing an auditor
asked about. The one dial that does exist is the registry itself, which is code review.

### 5. The over-scrub guard is a first-class requirement, not a courtesy

The overwhelming majority of reasons are ordinary sentences, and a governance product whose
reason fields quietly mangle what an operator wrote is worse than the leak it prevents — the
operator stops trusting the field, and then stops writing anything useful in it.

`scrubOne` returns the **same object** when nothing matched, and `scrubAuditText` returns the
**same string**, so the common path does not rebuild anything and therefore cannot alter it. The
suite pins it on the bytes Postgres holds, through three different routes, with a fixture built
out of exactly what a naive detector eats: an underscore identifier, a uuid, an email, a model
name, `tokensIn 1200`, and the word "token" itself.

## What this deliberately does NOT do

- **It does not scrub `name`, `title`, `description`, `summary` or `body` columns.** There are
  ~34 more free-text columns of that kind. They are a different argument: a description is
  *content*, sometimes the whole point of the record, and this control's safety case rests
  entirely on being applied to a narrow enumerated set where prose loses nothing. Widening it is a
  decision, not an extension.
- **It does not scrub reads, responses or in-flight request bodies.** A credential typed into a
  reason still crosses the process and may appear in a 4xx echo or an error message. This is about
  what is **persisted**.
- **It does not retroactively clean existing rows.** No migration, by choice: a data migration
  that rewrites historical reasons is an edit to the record, and for the columns that feed
  compliance exports that is a worse property than the leak. Rows written before this ADR keep
  whatever they hold.
- **It does not detect anything new.** The rule list is ADR-0042's, unchanged. A credential shape
  no rule matches is not caught here either.

## Honest limits

**Coverage — the enumeration, asserted by test (`proseScrubInventory()`), not claimed here.**
**51 columns covered**: all 47 operator-prose columns S5 named, plus four machine-written
free-text columns that quote an error verbatim (`trace_spans.status_reason`, which takes
`(err as Error).message` at several dispatch sites, and `config_canary_observations`'
`served_reason` / `candidate_reason` / `failure_reason`).

```
agent_revocations.reason                       eval_runs.gate_reason
agents.lifecycle_reason                        eval_runs.note
ai_endpoint_signatures.replacement_note        imported_cost_lines.superseded_reason
ai_risks.acceptance_note                       interception_scope_rules.note
ai_use_cases.retired_reason                    license_verifications.reason
ai_vendors.retired_reason                      mcp_registry_entries.catalogue_reason
approval_delegations.reason                    mcp_servers.admission_clear_reason
approvals.decision_reason                      model_card_approvals.decision_reason
billing_statements.issue_reason                model_card_evidence.note
cert_rotations.reason                          model_cards.note
compliance_pack_controls.owner_note            onboarding_imports.reason
config_activation_events.reason                policy_simulations.note
config_canary_observations.candidate_reason    redteam_libraries.note
config_canary_observations.failure_reason      redteam_probes.note
config_canary_observations.served_reason       redteam_runs.gate_reason
connector_revocations.reason                   redteam_runs.note
copilot_proposals.rationale                    shadow_ai_findings.disposition_reason
cost_import_batches.reason                     shadow_ai_findings.replacement_note
data_key_attestations.note                     shadow_ai_imports.reason
decisions.rationale                            sod_rules.reason
egress_allow_hosts.note                        spend_anomalies.decision_reason
eval_datasets.note                             spend_anomalies.explanation
eval_results.judge_rationale                   spend_scheduled_changes.reason
                                               trace_spans.status_reason
                                               training_datasets.note
                                               vendor_account_aliases.reason
                                               vendor_domain_rules.reason
                                               workflow_templates.retired_reason
```

**NOT covered, and why — three columns, named rather than merely absent** (`PROSE_SCRUB_EXCLUSIONS`,
also asserted by test):

| Column | Why not |
|---|---|
| `audit_log.reason` | ADR-0099 owns it, at the chained-insert path, before the row is hashed. Scrubbing it twice would be worse than redundant: the marker text itself (`aws_key:20:…`) is `key: value` shaped, so `dlp.secret.assignment` would match it and nest a marker inside a marker. One column, one owner. |
| `mcp_registry_entries.conflict_reason` | Drizzle-typed `{ enum: ["name_taken", "url_taken"] }`. A credential cannot appear in a two-member enum. |
| `usage_events.stop_reason` | The model provider's finish-reason vocabulary (`end_turn`, `max_tokens`, `cached`) — not free text — on the highest-volume write path in the schema. Excluded on both grounds. |

A test asks **Postgres** (`information_schema`, not the TypeScript) for every `text`/`varchar`
column whose name contains `reason`, `note`, `rationale` or `explanation`, and fails if any is
neither covered nor explicitly excluded. A column added by a future hand-authored migration
cannot slip past the registry silently.

**The residues, plainly:**

1. **~34 `name`/`title`/`description`/`summary`/`body` columns are still verbatim.** This is the
   largest one. A secret pasted into a workflow-template description or an agent name is stored as
   typed. Closing it is a wider judgement about content columns that this ADR does not make.
2. **Application-layer only**, exactly like ADR-0060 and ADR-0099. A `psql` session, a raw `pg`
   client, or a future module that builds its own `Pool` bypasses it entirely. A trigger would be
   strictly stronger and is recorded as the same follow-up ADR-0060 already records.
3. **Detection is shape-based**, so it inherits ADR-0042's blind spots. A shapeless credential
   pasted into a reason — a bootstrap token, a base64 data key — is *not* caught. ADR-0099's
   field-name path cannot help: it keys off a JSON key named `token`/`secret`, and a prose column
   is named `reason`. Redacting a whole reason because it *might* contain a shapeless secret would
   destroy the record to protect it.
4. **The fingerprint is unsalted truncated SHA-256**, inherited from ADR-0099 unchanged. One-way
   for a high-entropy credential; for a low-entropy one (`password = hunter2`) a holder of the
   database can confirm a guess. It is a correlation handle, not encryption, and it is strictly
   better than storing the value.
5. **Historical rows are untouched**, per the no-migration choice above.
6. **`.values()` on a registered table allocates a shallow copy when — and only when — something
   matched.** The unmatched path is identity-returning and adds one `Set` lookup plus a regex pass
   per registered column per write. `usage_events` was kept out of the registry partly so the
   hottest write path in the schema does not acquire even that.
