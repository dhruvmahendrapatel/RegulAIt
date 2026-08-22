# ADR-0096: Entity-aware copilot planning — resolve a question's subject, then filter on it or refuse

- **Status**: Accepted
- **Date**: 2026-08-22

## Context

[ADR-0056](0056-ai-governance-copilot.md)'s **L6d amendment** closed one hole and named the one
it could not: the copilot's NL-to-query step is keyword-based, so **an entity named in a question
that matches no keyword rule is silently IGNORED rather than narrowing the query**.

The defect that produced that amendment, found live:

```
{"question":"Summarise the Zorblatt Quantum Compliance Widget approvals from last week"}
```

There is no Zorblatt Quantum Compliance Widget. The planner matched only `"approval"` and
`"last week"`, ran `listApprovals` **with no entity filter**, retrieved **eight real, unrelated,
org-wide approvals**, and the live model narrated them as being *"for the Zorblatt Quantum
Compliance Widget"* — with `modelNarrationVerified: true`, because every figure and every id it
cited really had been retrieved.

L6d's fix was to make the answer **say** it had not filtered on the subject:
`subjectFiltered: false` plus a deterministic `unfilteredSubjectCaveat`, a `FILTERS:` block in the
narration prompt, and a hard rule forbidding subject attribution. That is honest. It is also
**unhelpful**, and it is a stopgap by its own admission: the amendment's honest-limits section
says so outright and defers the real fix to "a separate, larger slice". This is that slice.

The forces that shape it:

1. **A model must never assert that an entity exists.** The failure mode is a language model
   confidently naming a governed object. Asking a model "which entities does this question name?"
   invites exactly that answer — plausible, fluent, and unbacked. Whatever proposes candidates,
   the **database** must be the only thing that decides an object exists.
2. **Resolution is a new read surface, and every read surface is a leak risk.** The copilot's
   entire security model is "it can never see more than the human who invoked it"
   (ADR-0056 §1). A resolver that answers "yes, that exists, you just can't read it" turns the
   copilot into an **existence oracle** for other teams' objects — a smaller leak than reading
   their rows, and still a leak.
3. **Not every ledger can be narrowed by every kind.** `approvals` has no agent column. There is
   no join from any of the three ledgers to `ai_vendors`. Pretending otherwise, or quietly running
   broad where a filter is impossible, reproduces the original defect with extra steps.
4. **The ordinary questions must not regress.** "Who accessed PII last quarter?" is the question
   ADR-0056 exists to answer. Any extraction aggressive enough to refuse it has broken the product
   to fix a hallucination.

## Decision

**Entity-aware planning in two halves that never blur: a DETERMINISTIC EXTRACTOR that proposes
strings, and an ENTITLEMENT-SCOPED DATABASE LOOKUP that decides what exists.** A question naming a
subject then takes exactly one of four paths, three of which end in a named refusal *before any
retrieval runs*.

### 1. Extraction proposes; it never asserts

`extractEntityCandidates(question)` (`packages/shared/src/copilot.ts`) is pure, deterministic and
model-free. It reads three conservative signals, most reliable first:

| Signal | Example | Why it is safe |
|---|---|---|
| Quoted spans | `denials for "night-shift ops" last week` | an explicit "I mean this exact thing" |
| UUIDs | `spend for 7de8b1f1-…` | an object named by its primary key |
| Capitalised runs | `the Zorblatt Quantum Compliance Widget` | two or more consecutive capitals, or one capital/acronym that is **not** the first word of its sentence |

It then **drops** every phrase the planner itself consumes (`RULES`, `TIMEFRAME_PHRASES`,
`OBJECT_TYPE_PHRASES`, the approval-state words) plus a short stop-list of question words,
grammar, platform nouns and formats; strips a sentence-initial ordinary word off the front of a
run (`Show Acme denials` → `Acme`); normalises possessives and whitespace; and caps the result at
`COPILOT_MAX_ENTITY_CANDIDATES = 4`.

The committed suite pins the outcome on the questions that matter:

```
"Who accessed PII last quarter?"                                       => []
"Which denied MCP tool calls spiked this week?"                        => []
"how much have we spent this month on tokens?"                         => []
"What governance denials happened recently and why?"                   => []
"Summarise the Zorblatt Quantum Compliance Widget approvals last week" => ["Zorblatt Quantum Compliance Widget"]
```

**A model may propose, but only propose.** The option of a model-assisted extraction pass was
considered and is not taken in this build — not because a model could not propose better strings,
but because there is no supervision budget for a second model call on every question and no
evidence it would beat the three signals above. If one is ever added, the contract stated here
binds it: the model may return **candidate strings only**, and those strings go through the same
`lookupEntityCandidate` as any other. **A model must never be the thing that says an object
exists**, because a governance product whose subject line is a model's recall is the exact
failure ADR-0056 was built to refuse.

### 2. Resolution is a real query, and every kind's visibility rule is a RE-USE

`resolveCopilotEntities` (`apps/gateway/src/copilot.ts`) looks every candidate up by
case-insensitive **exact** name (never a prefix or fuzzy match — "Payments" must not silently
become "Payments Platform") or by id. Six kinds are resolvable, and **no kind gets a visibility
rule invented for this feature**:

| Kind | Table | Matched on | "In your scope" means — and the existing rule it re-uses |
|---|---|---|---|
| `project` | `projects` | name, id | `scope.projectIds` — the very list every copilot retrieval is already narrowed to (ADR-0047 `callerProjectIds`) |
| `user` | `users` | email, username, display name, id | `scope.memberIds` — the members of those projects, the list the approvals retrieval already scopes on |
| `team` | `teams` | name, id | the caller's own `team_members` rows |
| `agent` | `agents` | name, id | the kernel's own `evaluateAgent(...).effect === "allow"` — the exact call an ordinary invoke makes, not a hand-rolled join over grant tables that could drift from the enforcing path |
| `connector` | `connectors` | name, id | the kernel's own `evaluateConnector(..., operation: "read")` |
| `vendor` | `ai_vendors` | name, id | `owner_user_id = caller` — byte-identical to `GET /v1/vendors`' own non-admin rule |

An admin is org-wide for all six, exactly as `resolveCopilotScope` already makes them org-wide for
every ledger.

**Excluded, and why.** MCP servers and MCP tools are *not* resolvable in this build even though
`audit_log` and `approvals` both carry `server_id`/`tool_name` and would filter beautifully: MCP
visibility is a per-`(user, server)` tool-level computation (`loadEntitlements` + `visibleTools`),
and `mcp_tools.name` is unique only per server, so a bare tool name cannot be resolved without a
server qualifier the extractor cannot reliably supply. Compliance packs, AI use cases, AI risks,
workflow templates and initiatives are excluded for the same reason in a weaker form — each needs
its own visibility predicate, and **shipping a kind whose visibility rule has not been proved with
a two-user test would be exactly the existence leak this ADR exists to close**. They are named in
Limits, not smuggled in.

**`vendor` is resolvable even though nothing can filter by it.** That looks perverse and is the
point: without it, a question naming a *real* vendor the caller owns would be refused with "no …
named X in your scope", which is **false**. Resolving it and then refusing on the tool/kind gate
says something true instead.

### 3. Four outcomes, each explicit

| Outcome | HTTP | `error` | Audit rule id |
|---|---|---|---|
| **No subject named** | 201 | — | `copilot-question-answered` (unchanged) |
| **Resolved and filterable** | 201 | — | `copilot-question-answered` + `entity` on the detail |
| **Unresolved** | 422 | `copilot_entity_unresolved` | `copilot-refused-unresolved-entity` |
| **Ambiguous** (>1 object) | 422 | `copilot_entity_ambiguous` | `copilot-refused-ambiguous-entity` |
| **Resolved, tool cannot filter that kind** | 422 | `copilot_tool_cannot_filter_entity` | `copilot-refused-entity-not-filterable` |

Every refusal happens **before any retrieval runs**: no rows are read, no `copilot_queries` row is
written, no narrator is called. Each carries its own sentence, and the three sentences share no
opening phrase with each other or with `COPILOT_GROUNDED_REFUSAL`, so a caller can always tell
*"you named something I cannot find"* from *"your query legitimately matched nothing"* from
*"this tool has no such filter"*.

**Ambiguity is never resolved by a tiebreak**, including the case where a question names *two*
different real objects: filtering on one and dropping the other is the same lie as filtering on
neither and labelling the answer with both. The refusal lists every match with its kind, name and
id and asks.

### 4. The filterable tool × kind table, read off the schema

`COPILOT_ENTITY_FILTER_MATRIX`. A pair is present only where the ledger genuinely narrows.

| Kind | `queryAuditDecisions` (`audit_log`) | `listAnomalies` (`audit_log` + `approvals`) | `listApprovals` (`approvals`) | `summarizeUsage` (`usage_events`) |
|---|---|---|---|---|
| `project` | ✅ `detail->>'projectId'` | ✅ both halves | ✅ `project_id` **OR** member expansion | ✅ `project_id` |
| `team` | ✅ `user_id IN` members | ✅ both halves | ✅ `user_id IN` members | ✅ `user_id IN` members |
| `user` | ✅ `user_id` | ✅ both halves | ✅ `user_id` | ✅ `user_id` |
| `agent` | ✅ `object_type='agent' AND object_id` | ❌ approvals half cannot | ❌ **no agent column** | ✅ `agent_id` **OR** `requested_agent_id` |
| `connector` | ✅ `object_type='connector' AND object_id` | ❌ approvals half cannot | ❌ **no connector column** | ✅ `connector_id` |
| `vendor` | ❌ | ❌ | ❌ | ❌ **no join exists anywhere** |

Four notes the table cannot carry:

- **`listAnomalies` supports only the INTERSECTION** of what both its ledgers can filter. A
  half-narrowed anomaly report — one lead about your subject, the other about everything — would
  be worse than a refusal, so the pair is unreachable rather than merely discouraged. An
  agent-named anomalies question is refused with `queryAuditDecisions` named as the tool that can
  answer it.
- **A `project` filter on `approvals` is an OR**: `project_id` (set on pillar-5 budget
  escalations) **or** "raised by a member of that project", which is how the tool's own
  entitlement scope already reads this ledger. Either alone would drop real rows.
- **`summarizeUsage` on an agent covers BOTH columns.** ADR-0095 right-sizing makes `agent_id` the
  *served* agent and `requested_agent_id` the one the caller asked for; "spend on agent X" honestly
  means both.
- **An `agent`/`connector` entity REPLACES any keyword-derived `objectType`.** A question naming an
  agent is about that agent whatever other class word it contains; ANDing the two would silently
  return zero rows instead of an answer.

### 5. The scope-honesty rule, and how it is proved

> An object the caller may not see must resolve as **unresolved**, and the wording must be
> *"no … named X in your scope"* — **never** *"X does not exist"*.

The refusal enumerates the resolvable kinds ("no project, team, user, agent, connector or AI
vendor by that name is visible in your scope"), states in its own text that it is
*"deliberately worded identically whether the object does not exist or exists somewhere you may
not read"*, and is a pure function of **the caller's own words** — nothing about any object
enters it. This is [ADR-0050](0050-data-lineage-provenance.md)'s idiom (an invisible node's 404 is
byte-identical to a nonexistent one's) applied to prose.

Proved two ways, not asserted:

- **Committed test, two users, one real project** — resolved and filtered for the member; 422 for
  the non-member; and the non-member's whole 422 body is asserted **byte-identical**, after
  substituting only the caller's own words, to the body a name that exists nowhere produces. The
  hidden project's id is asserted absent. The same pair is proved for an **agent** the caller has
  no grant for, with the granted member resolving the very same agent as the control.
- **Live, on a seeded instance** — an admin-created project `Meridian Vault` that Dana is not a
  member of: admin resolves it; Dana's refusal for it and her refusal for `Meridian Nowhere` are
  byte-identical JSON after the substitution, with no id anywhere in either.

### 6. What `subjectFiltered` means now

Unchanged mechanically — `true` iff the executed plan applied at least one filter — but its
**meaning narrows**, and that is the honest way to record it:

- Before, ADR-0056 L6d had to say `subjectFiltered: true` means "the query narrowed by
  *something*", explicitly *not* "narrowed to your subject", because the param vocabulary
  (`effect`/`objectType`/`status`) contained no entity filter at all.
- Now, `plan.entity` is a real entity filter, and it is **the only way an answer about a named
  subject can be produced**: a question naming a subject either resolves it and filters on it, or
  is refused before retrieval. So **`true` means "narrowed to your subject" whenever a subject was
  named**, and keeps its older, weaker meaning on questions that name none.

`unfilteredSubjectCaveat` and the caveat machinery are **kept, not deleted**. Their scope narrows
to the case ADR-0096 does not touch: a question that names no subject at all, whose broad answer
must still say it is about nothing in particular. The caveat's wording is unchanged.
`modelNarrationVerified` is likewise unchanged and still means only "this narration's figures and
ids were cross-checked against this retrieval" — ADR-0056 L6d's reasoning for keeping that
meaning narrow stands.

The narration prompt gains a `SUBJECT:` line on exactly the resolved case, stating that the rows
below were retrieved with the resolved object as a SQL filter and that the model **may** describe
them as being about that object — the one case in which attributing findings to the question's
subject is correct, stated as explicitly as hard rule 6 forbids the other one.

## Consequences

### Non-vacuity (M-002 — every count MEASURED by running the probe, then reverted by exact Edit reversal, M-016)

- **Resolution always succeeds** (`unresolved` replaced with a fabricated project match):
  **3 gateway tests redden** — the unresolved refusal, the cross-user scope-honesty pair, and the
  ungranted-agent case. The resolved-and-filtered, ambiguity, mismatch and no-entity tests stay
  green, which is what makes them controls.
- **The entity filter made a NO-OP in SQL while still being reported** (every ledger's entity
  predicate replaced with `[]`, `plan.entity` and therefore `describeCopilotFilters` untouched):
  **3 gateway tests redden**, each with the diagnostic that matters — `expected 8 to be 3`,
  `expected 8 to be 3`, `expected 8 to be 5`. The broad row count came back where the narrowed one
  was asserted, with the filter still announced in the answer text, the note and the audit row.
  **This is the probe that matters most**: a reported filter that changes nothing is exactly the
  class of lie this feature exists to end, and the suite catches it on the counts rather than on
  the prose.
- **The unresolved reason collapsed into the empty-retrieval reason**
  (`copilotEntityUnresolvedRefusal` returns `COPILOT_GROUNDED_REFUSAL`): **1 shared + 2 gateway
  tests redden**. Recorded honestly: two tests stay green under this probe and should be read as
  weaker than they look — the shared "depends only on the caller's own words" assertion is
  trivially satisfied by a constant string (it is a scope-honesty control, not an anti-collapse
  guard), and the ungranted-agent gateway test compares against the function's own output, so it
  is self-consistent under any collapse. The anti-collapse guard is the separate assertion that
  the two refusals share no opening phrase.

### Live verification (2026-08-22 UTC, real Gemini backend, scratch DB `regulait_live_0096`, scratch gateway on :3117, key in process env only)

**(a) The old defect — must now refuse, not answer-with-caveat.** `POST /v1/copilot/ask`, admin,
live narrator, the L6d question verbatim → **HTTP 422**, `error: copilot_entity_unresolved`,
`candidates: ["Zorblatt Quantum Compliance Widget"]`, `plan.entity: null`, no answer, no evidence,
**no model call at all** (the refusal precedes the narrator). The M-024 control, run beside it:
the broad question `"summarise the approvals from last week"` returns **HTTP 201, 8 approvals,
4 approved / 4 pending** — the exact real rows the original defect relabelled. The guard fires
*despite* plausible real data, which is the only case that proves anything.

**(b) A real entity — must narrow and say so.** `How much have we spent this month on
"demo-project"?`, live narrator:

- unfiltered baseline (`how much have we spent this month?`): **19** rows, split 15 / 4 across the
  two seeded projects.
- filtered: `plan.entity = {kind: "project", id: 7de8b1f1-…, name: "demo-project", matchedOn:
  "demo-project"}`, **`rowsExamined: 15`** — the row count genuinely differs.
- `subjectFiltered: true`, `unfilteredSubjectCaveat: null`, `generation: "model"`,
  `modelNarrationVerified: true`, no `narrationDiscarded`.
- grounded text: `Filters applied: project='demo-project'(7de8b1f1-…).` /
  `Narrowed to the project 'demo-project' (7de8b1f1-…), resolved from "demo-project" in your
  question. Every figure below is about that object and nothing else.`
- the live narration, verbatim: *"This response is scoped to the caller's own entitlements. Based
  on the 'summarizeUsage' tool executed for the current month with filter
  project='demo-project'(7de8b1f1-…), there were 15 measured model/tool calls, all 15 of which are
  attributed to project 7de8b1f1-…. No direct cost or monetary spending figure was provided in the
  retrieved records."*
- and the filter **tracks the subject**: the same question naming `"hipaa-project"` resolves to the
  other id and returns **4**.

**(c) The control — unchanged useful answer.** `What governance denials happened recently and
why?` → HTTP 201, `entityCandidates: []`, `entity: null`, `queryAuditDecisions` /
`params: {effect: "deny"}`, 5 rows, `generation: "model"`, `modelNarrationVerified: true`, no
"Narrowed to" line and no "SUBJECT RESOLVED" note. Its own count breakdown includes
`denials from rule 'copilot-refused-unresolved-entity': 1` — case (a)'s refusal is a first-class
audit record the copilot reads back like any other.

**Also live:** the mismatch (`which approvals are waiting for "gemini-pro"?` → 422
`copilot_tool_cannot_filter_entity`, `toolsThatCanFilter: ["queryAuditDecisions",
"summarizeUsage"]`), the ambiguity (a project and a team both named `Meridian Twin` → 422
`copilot_entity_ambiguous` listing both with ids), and the scope-honesty pair in §5.

The scratch gateway and database were torn down afterwards and the workspace grep-verified clean
of key material.

### What becomes easier

- The copilot can now **answer** a question about a named project, team, user, agent or connector
  instead of answering a different question and disclaiming it.
- "Was that answer actually about the thing I asked?" is answerable **from the ledger alone**: the
  `copilot-question-answered` audit row carries `entity: {kind, id, matchedOn}` and the rendered
  filter string, long after the prose is gone.
- Three refusals with three rule ids make the copilot's *non*-answers greppable — an operator can
  count how often subjects fail to resolve, which is the signal that the extractor or the
  resolvable-kind set needs widening.

### Honest limits

1. **Extraction is conservative, and a miss is possible.** A subject phrased without capitals,
   quotes or an id — "denials for the payments platform last week" — is not seen, and the question
   falls through to the pre-existing L6d behaviour: a broad query carrying the
   unfiltered-subject caveat. That is the safer direction (an honest broad answer, not a wrong
   narrow one), but it is a miss, not a guarantee. The workaround is in the refusal text and the
   page: quote the name, or give the id.
2. **Resolution is exact-match only.** "Payments" does not resolve "Payments Platform", by design —
   a prefix or fuzzy match is guessing, and guessing at the subject is what this ADR forbids. A
   near-miss therefore surfaces as `copilot_entity_unresolved`, not as a helpful suggestion.
3. **Object kinds left unresolvable**: MCP servers, MCP tools, compliance packs, AI use cases,
   AI risks, workflow templates, initiatives, roles, virtual keys. A question naming one of these
   is refused as unresolved — and the refusal is *true*, because it enumerates the six kinds that
   ARE resolvable rather than claiming nothing by that name exists. MCP server/tool resolution is
   the most valuable of these and the most likely next slice; its blocker is the per-`(user,
   server)` visibility predicate and the non-global uniqueness of tool names, both named above.
4. **`vendor` resolves but nothing can filter by it**, so a vendor question can only ever end in
   the tool/kind refusal. Making vendor spend answerable needs an attribution column or join that
   does not exist today — ADR-0069's `vendor_account_aliases` is about imported cost lines, not
   about the three ledgers the copilot reads.
5. **The filter is one entity, never a conjunction.** "Denials for Aurora and Basalt" is ambiguity,
   not an AND. Multi-subject questions are refused; supporting them means deciding whether two
   subjects mean union or intersection, which is a product question nobody has asked yet.
6. **A refused question writes no `copilot_queries` row.** The audit trail records the refusal, but
   the query history the SPA lists shows only answered questions. An operator wanting refusal
   history reads the audit log.
7. **Nothing here verifies the narration's prose**, only that the retrieval was narrowed and the
   figures and ids are real — ADR-0056's standing limit, unchanged. The live narration in (b)
   attributed the findings correctly; that is evidence about this model on this question, not a
   guarantee.
8. ADR-0056's limits 1–6 (L6a/L6b) and L6d limits 3–4 stand unchanged. L6d limit 1 (the residual
   this ADR closes) and limit 2 (`subjectFiltered` is not "narrowed to your subject") are
   superseded by §6 above.

### Migration

**None.** No schema change: the entity rides the plan JSON already stored on `copilot_queries`,
and the audit detail is a `jsonb` column. Every pre-0096 row keeps its exact meaning — a stored
plan with no `entity`/`entityCandidates` key renders byte-identically to one whose `entity` is
`null`, which the shared suite pins.
