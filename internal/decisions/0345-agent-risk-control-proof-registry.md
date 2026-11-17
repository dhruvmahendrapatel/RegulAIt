# ADR-0345: Agent risk register with controls and continuous proofs

- **Status**: Accepted (slice 1 implemented)
- **Date**: 2026-11-17
- **Lane**: E26
- **Related**: ADR-0057/0068 (continuous red-team, its statistics), ADR-0058 (compliance packs), ADR-0060 (hash-chained
  audit), ADR-0064 (scheduler), ADR-0078 (tighten-only conformance), ADR-0081/0147 (AI risk register), ADR-0104/0105
  (approval binding, single use, expiry), ADR-0116 (signed exports), ADR-0124 (execution modes, kill switch), ADR-0157
  (governance alerts), ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0193 (content trust), ADR-0214
  (posture score), ADR-0243 (OWASP packs), ADR-0246 (MCP definition pins), ADR-0252 (merge-time numbering)
- **Migrations**: `pending/agent_risk_proofs.sql` (numbered at merge)

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
   - the control settings that mitigate it, each with its secure value (ADR-0180);
   - one or more proofs, each run by an existing engine. This is the ADR-0081 `RISK_CATEGORY_EVIDENCE` pattern: the
     mapping is versioned code (`AGENT_RISK_CATALOG_VERSION`), so no admin can edit a row to make a risk look proven.
2. **No new test runner (ADR-0176).** A proof is one of three kinds:
   - `redteam_suite`: `runRedTeamSuite` (ADR-0057) over the named attack classes, judged by its own gating floor and
     ADR-0068 statistics;
   - `gateway_probe`: one sandboxed governed call against the tenant's own gateway whose refusal is the pass. The
     probes are: a hidden instruction in a returned document, a replayed approval, an expired approval, an
     out-of-scope tool argument, a seeded loop against the turn cap, a dispatch under `halted`, a tool definition
     changed after approval, and an untrusted write into shared context;
   - `ledger_check`: a read-only check over an existing ledger: audit chain verification (ADR-0060), register hygiene
     (owner, scope, review window), and the groundedness floor (ADR-0067).
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
   transaction as its audit row. The audit row is hash-chained automatically by `withAuditChain` (ADR-0060). The
   result row is append-only (`regulait_refuse_mutation`, TRUNCATE refused). Its `content_hash` is SHA-256 of
   ADR-0060's canonical JSON. When the ADR-0116 export key is configured, `signature` holds the Ed25519 signature over
   that hash; the CHECK requires both the signature and its key id, or neither. `error` (could not run) is its own
   outcome and never reads as a pass.
6. **A failure is raised, not filed.** A `fail` or `error` raises a governance alert (ADR-0157, through its existing
   alert insert and `afterAlertsRaised`) and an approvals-queue item for the control's owner to acknowledge. Both are
   linked to the result in `agent_risk_proof_followups`.
7. **Feeds what exists.** The latest result per proof becomes evidence for the cited pack controls (through a
   collector in `runCollector`, ADR-0058). It also becomes an input to the ADR-0214 posture score's adversarial and
   control objectives, and to the trust dashboard, without a second scoring scheme.
8. **Slices.**
   - Slice 1 (this PR): this ADR, the catalogue with its invariants, and the schema.
   - Slice 2: the proof scheduler job, the three engines' adapters, evidence writing, and alerts and approvals on
     failure.
   - Slice 3: the read and settings APIs for the view. The UI belongs to a design builder and is a `KNOWN_UI_GAPS`
     entry tracked on #453.

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

- Searched the repo for an existing risk-to-test mapping or continuous control testing ("proof", "control test",
  "continuous control"). Nothing exists. The nearest pieces (ADR-0081 resolvers, ADR-0058 collectors) are read-only
  and are reused.
- Test runners: garak, promptfoo and spikee are already integrated and are reused through the red-team and engine
  paths. No new runner is added.
- Catalogues: the OWASP LLM, MCP and Agentic Top 10 are reused through the ADR-0243 packs and the vendored promptfoo
  mapping (MIT). OWASP licenses its lists CC BY-SA, and only ids and our own titles are cited. No new dependency is
  added, so `THIRD_PARTY.md` does not change.

## Owner questions (open)

- Should a numeric range or schema bound on tool arguments become a control? Today the tool-misuse proof covers the
  allow-list only.
- Should a failed proof also block promotion through the ADR-0057 `automated_check` gate, or only alert and queue?
  The default is alert and queue.
- Should the governance-gap review window default to 90 days?
