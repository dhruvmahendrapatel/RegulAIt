# ADR-0345: Agent risk register with controls and continuous proofs

- **Status**: Accepted (slices 1, 2a, 2b and 2c implemented)
- **Date**: 2026-11-17
- **Lane**: E26
- **Related**: ADR-0085 (EU AI Act tier screening), ADR-0158 (regulatory intelligence feed), ADR-0180 (continuous assurance: A2 measurable conditions, `MEASUREMENT_STATES`), ADR-0057/0068 (continuous red-team, its statistics), ADR-0058 (compliance packs), ADR-0060 (hash-chained
  audit), ADR-0064 (scheduler), ADR-0078 (tighten-only conformance), ADR-0081/0147 (AI risk register), ADR-0104/0105
  (approval binding, single use, expiry), ADR-0116 (signed exports), ADR-0124 (execution modes, kill switch), ADR-0157
  (governance alerts), ADR-0176 (open source first), ADR-0193 (content trust), ADR-0214
  (posture score), ADR-0243 (OWASP packs), ADR-0246 (MCP definition pins), ADR-0252 (merge-time numbering)
- **Migrations**: `pending/agent_risk_proofs.sql`, `pending/agent_risk_proofs_jurisdictions.sql` (numbered at merge)

## Context

Owner request (2026-11-17): for every AI-agent risk, show the control that is on, a test that continuously proves it
works, and the latest result as dated evidence. "A risk with no control and no test is just a heading."

What exists already:

- The ADR-0081 register (`ai_risks`) holds a tenant's risks by category and computes evidence at read time from
  ledgers. It answers "what do the ledgers show"; it does not run anything to prove a control holds.
- The ADR-0057 red-team runs probes through the governed surface on a schedule (`runRedTeamSuite`,
  `runScheduledRedTeamSweep`), tagged `redteam`. The engine sidecars (garak, promptfoo, spikee; ADR-0187/0245) run
  through run-scoped virtual keys.
- The ADR-0243 packs give the OWASP LLM Top 10 (2025 as `@1`, 2026 as `@2`) and the OWASP MCP Top 10 as pack
  controls. The OWASP Agentic Top 10 (ASI01..ASI10) exists only as reference names (`OWASP_AGENTIC_NAMES`).
- The ADR-0078 conformance suite is test-only (vitest), not callable at run time.
- The ADR-0180 continuous-assurance contract (`assurance.ts`, `condition-metrics.ts`) already measures conditions from
  ledgers on a cadence: `measureAssuranceMetric` reads red-team ASR, guardrail mode, evaluation pass rate and
  others, `measurementStateFor` is the one place a state is decided, and its vocabulary is `MEASUREMENT_STATES`
  (`pass | fail | insufficient | not_run`). Only `pass` passes.
- Controls exist for each risk the owner named except two gaps: there is no numeric range control on tool arguments
  (`data_scope_rules` is an allow-list of values), and no memory-poisoning detector (ADR-0193 content trust tiers gate
  who may write into shared context).

## Decision

1. **A code catalogue, not tenant rows.** `AGENT_RISKS` in `@regulait/shared` (`agent-risk-proofs.ts`) lists ten
   agent risks: prompt injection, data leakage, tool misuse, hallucination, access-control failure (expired or reused
   approval), autonomous overreach (loop, spend, kill switch), supply chain (unvetted or changed plug-in or MCP
   server), memory and context exploits, infrastructure baseline, governance gaps. Each names:
   - its OWASP items as ADR-0243 pack `controlRef`s (LLM, MCP) plus the ASI name as a reference;
   - the ADR-0081 register categories it evidences, so a tenant's `ai_risks` row reaches its proofs by category;
   - the controls that mitigate it, each bound to something real. A `setting` control names a real `table.column`
     and its strict value, and the gateway suite checks the column exists in the migrated database. A
     `policy_table` control names a policy table (`data_scope_rules`, `abac_policies`). A `behaviour` control names
     a built-in behaviour that has no switch, such as single-use approvals or the audit chain, by its ADR, and is
     never shown as a setting;
   - one or more proofs, each run by an existing engine. This is the ADR-0081 `RISK_CATEGORY_EVIDENCE` pattern: the
     mapping is versioned code (`AGENT_RISK_CATALOG_VERSION`), so no admin can edit a row to make a risk look proven.
2. **Built on ADR-0180, no new test runner (ADR-0176).** A proof is one of three kinds:
   - `assurance_metric`: an ADR-0180 `MetricSpec` (red-team ASR per attack class, guardrail mode at block, evaluation
     pass rate), measured by `measureAssuranceMetric` and judged by `measurementStateFor`. The catalogue validates
     each spec with `metricSpecSchema` and `validateMetricParams`. The red-team runs themselves stay ADR-0057's
     scheduled sweep;
   - `gateway_probe`: one sandboxed governed call against the tenant's own gateway whose refusal is the pass. The
     probes are: a hidden instruction in a returned document, a replayed approval, an expired approval, an
     out-of-scope tool argument, a seeded loop against the turn cap, a dispatch under `halted`, a tool definition
     changed after approval, and an untrusted write into shared context;
   - `ledger_check`: a read-only check over a ledger that no ADR-0180 metric measures: audit chain verification
     (ADR-0060) and register hygiene (owner, scope, review window).

   The gateway probes and ledger checks are outside ADR-0180 for a stated reason. Its metrics read ledgers, but
   whether a replayed approval is refused is behaviour that no ledger records until something tries it. Every proof
   result, of any kind, is a `MeasurementState`; there is no second vocabulary.
   The catalogue's invariants are a function (`agentRiskCatalogProblems`) that a test pins to empty. A risk with no
   proof, an unknown pack control, an unknown attack class or a proof without its engine's input fails the build.
3. **Scheduled on the ADR-0064 scheduler, strict by default.** Every proof is on, daily. An admin may disable a proof
   or lengthen its interval (1 to 168 hours) through an audited route, stored in `agent_risk_proof_settings`. No row
   means the secure default.
4. **Sandboxed, tagged, read-only toward the tenant.** Proof traffic carries `AGENT_RISK_PROOF_ORIGIN_TAG`
   (`risk-proof`) in the same `purpose` slot the red-team tag uses, so it is metered and audited but never counted as
   real usage. A gateway probe uses run-scoped fixtures it creates and retires (a sandbox agent, tool and approval).
   It never reads or changes tenant records, and never calls a real tool's side effect.
5. **Results are signed, hash-chained evidence.** Each run writes one `agent_risk_proof_results` row in the same
   transaction as its audit row. The audit row is hash-chained automatically by `withAuditChain` (ADR-0060), and
   its `detail` carries the same `content_hash`. The result row is append-only (`regulait_refuse_mutation`, TRUNCATE
   refused). Its `content_hash` is SHA-256 of ADR-0060's canonical JSON. When the ADR-0116 export key is configured,
   `signature` holds the Ed25519 signature over that hash; the CHECK requires both the signature and its key id, or
   neither.
   - **No principal can write evidence.** Results and follow-ups are readable by an admin, but only the proof runner
     (system reason `system_task`) or a migration may insert them. An admin cannot fabricate a pass (#904 security
     review). Settings stay admin-writable, and their relaxation route carries the `settings_relax` step-up.
   - **A result counts as evidence only when its chain row agrees.** The read API and the verifier treat a result as
     evidence only when its audit row is still in the chain and carries the same hash. A pruned audit row reads as
     `unverifiable`. An unsigned result is labelled `unsigned`, never shown as if it were signed.
   - A proof that could not run is `not_run`, and one with too little data is `insufficient`. Neither is a pass.
6. **A failure is raised, not filed.** A `fail`, `insufficient` or `not_run` raises a governance alert (ADR-0157, through its existing
   alert insert and `afterAlertsRaised`) and an approvals-queue item for the control's owner to acknowledge. Both are
   linked to the result in `agent_risk_proof_followups`.
7. **Feeds what exists.** The latest result per proof becomes evidence for the cited pack controls (through a
   collector in `runCollector`, ADR-0058). It also becomes an input to the ADR-0214 posture score's adversarial and
   control objectives, and to the trust dashboard, without a second scoring scheme.
8. **Slices.**
   - Slice 1 (this PR): this ADR, the catalogue with its invariants, and the schema.
   - Slice 2a: the proof scheduler job (`agent-risk-proof-sweep`, hourly; each proof runs when its interval has
     elapsed), the `assurance_metric` and `ledger_check` engines, evidence writing, and alerts and approvals on
     failure (`apps/gateway/src/agent-risk-proof-runner.ts`). Until 2b, each gateway probe is recorded as `not_run`
     (reason `probe_harness_not_built`), so it shows as a raised alert, never as a pass.
     - The metric engine measures every registered agent (an empty scope is `not_run`).
     - The chain check (`verifyAuditChain`) fails a broken chain or a disagreeing anchor. It passes only a full scan
       of an intact chain whose tamper-resistant anchor was checked and matched. Without that anchor (or on a
       partial scan) it is `insufficient`: anyone who can write the database could re-hash the chain consistently
       (#1039 security review). An empty chain is `not_run`.
     - Register hygiene fails a live risk with an inactive owner, no scope, or no change inside 90 days.
       `ai_risks` has no review-date column, so its `updated_at` stands for the last review (owner question below).
     - The signature (ADR-0116 export key) covers the hex content hash, base64-encoded.
     - An engine that throws is `not_run`, and the row keeps only the error class.
     - The result, its audit row and its follow-ups commit in one transaction, so a recorded failure always has its
       alert. A transaction-scoped advisory lock per proof stops two replicas recording the same run twice.
     - The alert is deduped per proof while open. A repeat failure refreshes it, reuses the pending acknowledgement
       (`agent_risk_proof` approval, stage `agent-risk-proof:<key>`) and links the new result. A pass resolves the
       alert and supersedes the acknowledgement.
     - Attribution uses the shared ADR-0107 helper (`system-attribution.ts`): audit rows name the oldest active
       admin, else the all-zero system id. The acknowledgement's requester must be a real user (foreign key), and
       its approver is someone else wherever the deployment has a second admin or an alert owner.
     - One proof that cannot be recorded is audited (`agent-risk-proof-run-failed`); the sweep goes on to the others.
   - Slice 2b: reading results as evidence (`apps/gateway/src/agent-risk-proof-evidence.ts`).
     - Each result is labelled. `verified` means the hash recomputes, the audit row is still in the chain with the
       same hash, and the signature verifies against the export key it names. `unsigned` means the same but with no
       signature. `unverifiable` comes with a reason: audit row missing or broken, hash mismatch, a key this
       deployment no longer holds, or a bad signature.
     - Only a passing result that is not `unverifiable` counts as evidence anywhere.
     - The ADR-0058 collector `agent_risk_proofs` counts those results for the proofs whose risk cites the control
       being evaluated (org-scoped reports only). No shipped pack version names it yet: adopting it in an OWASP pack
       is a new pack version for the ADR-0243 owner (owner question below).
     - The ADR-0214 posture document gains a `riskProofs` section, shown as inputs to the adversarial objective. It
       does not change the published weights or any score (owner question below).
   - Slice 2c: the gateway-probe harness (`apps/gateway/src/agent-risk-proof-probes.ts`).
     - A probe makes one governed decision through the enforcing function the live path calls, and passes only on
       the refusal its assertion names. Nothing is a new runner or a second copy of a rule.
     - Part 1 builds five probes:
       - `hidden_instruction_in_document`: the org guardrail policy (`resolveGuardrailPolicy`) and the MCP output
         phase's deterministic detectors (`runGuardrails`) on a document with a hidden instruction. It passes only
         when `prompt_injection` blocks it. The async trained-detector path is not called, so a probe meters nothing.
       - `tool_out_of_scope_argument` and `kill_switch_halted`: the policy kernel's `evaluate` on a synthetic granted
         write call. Pass means a deny by the fixture data-scope rule, or by `execution-halted`. These two read no
         tenant state: they prove the shipped kernel, so a modified build fails them.
       - `mcp_definition_drift`: `definitionPinRefusal` against a sandbox server with a drifted pin. The fixture is
         created inside a transaction that is always rolled back, so it is never visible or left behind, and its URL
         is on the reserved `.invalid` TLD. It reads the org pin mode, so `warn` fails the probe.
       - `untrusted_context_write`: the org write floor (`contentTrustWriteFloor`) through `evaluateContentTrust` on
         untrusted content.
     - The floor gates write tool calls. The shared-context write route (`POST /v1/projects/:projectId/context`) is
       not gated by it. Catalogue v2 rewords the proof's assertion to what is enforced, so a pass does not overclaim.
       The route gap is tracked as an issue for the ADR-0193 owner.
     - Part 2 builds the other three:
       - `approval_replay`: `consumeApprovalOrRetire` (ADR-0104/0105), the consuming half of the live path, spends a
         sandbox approval and is then presented with it again. It passes only when the first presentation is spent
         and the second comes back `approval_consumed_race`.
       - `approval_expired`: the same function on a sandbox approval past its expiry. It passes only on
         `approval_expired`.
       - `loop_turn_cap`: `workerTurnCap` (ADR-0021), now the one function that bounds the dispatch loop in
         `dispatchRunNodeInner`, on the org's worker dials. A worker seeded to loop (it declares more turns than
         any ceiling) must be clamped to the org ceiling and to the settings schema's 20-turn wall.
         `org_settings.max_worker_turns` has no database CHECK, so a value written around the settings route fails
         the probe.
     - The approval fixture is a sandbox server, its registered tool, one approved approval and one approving
       decision, all built in the always-rolled-back transaction.
       - RLS refuses the runner's inserts into `users`, as it should. So the fixture references the deployment's
         own admins (ADR-0107 attribution): the oldest active admin requests and the next one approves.
       - An approver pool never contains the requester. A deployment with fewer than two active admins therefore
         records these two probes as `not_run` (`needs_two_active_admins`). That is never a pass, and never a
         self-approval.
       - `signature_mode` is `off` so the probe stays on single use and expiry. The ADR-0186 passkey recheck has its
         own tests.
     - The audit chain allocates `seq` as `max(seq)+1` under its advisory lock. So the audit rows the enforcing code
       writes inside the rolled-back transaction (a consume, a supersede) leave no hole in the chain. No probe makes a
       network call, so the transaction never waits on a second connection.
     - Tagged traffic: the red-team `purpose` tag is a label only, and nothing excludes it from metering. No probe
       makes a metered call.
   - Slice 3: the read and settings APIs for the view. The UI belongs to a design builder and is a `KNOWN_UI_GAPS`
     entry tracked on #453.
9. **Geography is a factor in risk tiering.** Owner, 2026-11-17, from the competitor gap audit (C5). The
   jurisdictions a use case is deployed or used in decide which obligations apply in this register, and they may
   raise its tier. All three parts are data, not code: seeded by migration and admin-editable.
   - `jurisdictions` holds a code (the ADR-0158 feed's spelling: `EU`, `US`, `US-CO`, `US-NYC`, `International`), a
     name, an enclosing `parent_code` and a `global` flag. A child brings in its parent's obligations, and a global
     jurisdiction applies everywhere.
   - `jurisdiction_obligations` maps a jurisdiction to a sourced ADR-0158 regulatory-feed instrument, to the agent
     risk whose controls and proofs answer it, and optionally to a `tier_floor`. The seed covers exactly the feed's
     in-force, upcoming and published entries. A test checks that each row's feed key exists, is not withdrawn and
     names the same jurisdiction. The mapping routes evidence; it is not a legal determination, the same position
     ADR-0158 takes.
   - `ai_use_case_jurisdictions` is a join table recording where a use case is deployed or used.
   - `resolveGeography` (shared) resolves the declared codes plus their ancestors and the global jurisdictions into
     the obligations in scope and the strictest floor. An unknown code is reported, not dropped. **A use case that
     declares no jurisdiction is in scope of every jurisdiction** (strict default; "none declared" never reads as
     "nothing applies").
   - `effectiveRiskTier` returns the stricter of the screened tier (ADR-0085) and the floor. An unscreened use case
     stays `unscreened`: a floor never stands in for the screening.
   - No seeded obligation sets a floor, because a floor is a legal judgement for an admin to record.
   - The floor reuses the ADR-0085 screening ladder (`EU_AI_ACT_TIERS`, ranked by `EU_AI_ACT_TIER_RANK`); the
     `tier_floor` CHECK repeats the four values and a test pins it to that constant (#1019 code review).
   - **The write routes (slice 3) treat a narrowing as a relaxation.** Deleting an obligation, lowering or clearing a
     `tier_floor`, removing a declared jurisdiction from a use case, or deleting a jurisdiction (which narrows scope
     for every undeclared use case) carries the `settings_relax` step-up and is audited in the same transaction. The
     same routes refuse a `regulatory_update_key` that is not in the ADR-0158 feed (#1019 security review).
   - The review-policy routing (`tierKeyFor`, owned outside this lane) still reads the screened tier. Switching it
     to the effective tier is an owner question below, because it changes who signs existing use cases.

## Consequences

- Every risk on the page has a named control, a named proof and, after slice 2, a dated, verifiable result. A risk
  added to the catalogue without a proof cannot merge.
- The catalogue is global, not per tenant. A tenant's own risks join it by category; a tenant cannot add a custom
  proof. That is deliberate: a proof is code that runs against the gateway, and arbitrary tenant-authored probes would
  be a new runner.
- Two gaps are named rather than papered over:
  - The tool-misuse proof tests the data-scope allow-list. A numeric range on a tool argument is not a control
    today.
  - The memory proof tests the content trust write floor. No detector inspects what is written.
- ASI items are references, not pack controls, until an OWASP Agentic pack exists.

## Open-source search (ADR-0176)

- In the repo: the first search ("proof", "control test", "continuous control") missed the ADR-0180
  continuous-assurance contract, which the #904 code review pointed out. The catalogue is now built on it
  (decision 2). Also reused: the ADR-0081 resolvers and the ADR-0058 collectors.
- GitHub, compared on 2026-11-17:
  - CISO Assistant (a full GRC application with a register, controls and evidence) is licensed AGPL-3.0, which
    ADR-0176 bars. It is also a separate service that runs no proofs against a gateway.
  - compliance-trestle (NIST OSCAL; Apache-2.0, active) models catalogues and assessment results. It is Python and
    runs no tests, so it does not replace the runner. OSCAL assessment results remain a candidate export format for
    the signed results.
  - No other candidate had a licence, releases and users.
- Test runners: garak, promptfoo and spikee are already integrated and are reused through the red-team and engine
  paths. No new runner is added.
- Catalogues: the OWASP LLM, MCP and Agentic Top 10 are reused through the ADR-0243 packs and the vendored promptfoo
  mapping (MIT). OWASP licenses its lists CC BY-SA, and only ids and our own titles are cited. No new dependency is
  added, so `THIRD_PARTY.md` does not change.

## Owner questions (open)

- Should the next OWASP LLM / MCP pack versions name the `agent_risk_proofs` collector for the controls a proof
  covers? Then a passing, evidenced proof satisfies them automatically.
- Should the proofs carry weight in the posture estimate, for example as part of the adversarial objective? Today
  they are shown as inputs only, so the published weights stay as they are.

- Should review routing (`tierKeyFor`) read the effective tier (screened tier plus jurisdiction floor)? Doing so
  changes the required reviewers for existing use cases. Which tier floors should the seeded jurisdictions carry? None
  is seeded today.

- Should a numeric range or schema bound on tool arguments become a control? Today the tool-misuse proof covers the
  allow-list only.
- Should a failed proof also block promotion through the ADR-0057 `automated_check` gate, or only alert and queue?
  The default is alert and queue.
- Should the governance-gap review window default to 90 days?
- Should the ADR-0193 trust floor also gate the shared-context write route? Today it gates write tool calls only, and
  the memory proof's assertion (catalogue v2) says so.
