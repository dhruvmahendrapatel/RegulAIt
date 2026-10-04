# ADR-0175: Build-now items from the October 2026 document study, and a corrected NIST AI RMF pack

- **Status**: Accepted (owner, 2026-10-04: "study attached documents and see what can we build, anything we cannot build now
  goes into pathforward, we need to make our tool as comprehensive and perfect as possible")
- **Date**: 2026-10-04
- **Builds on**: ADR-0058/0087/0150 (compliance packs and immutable versions), ADR-0097/0100 (MCP admission and re-scan),
  ADR-0157 (governance monitor), ADR-0161 (deploy gate), ADR-0168/0170 (use-case review, conditions, separation of duties),
  ADR-0172/0173 (agent builder)

## Context

The owner shared six documents: NIST AI 100-1 (AI RMF 1.0), an identity-governance vendor's agent ebook, an AI
application security-posture whitepaper, a code-security platform's self-description, and two product teardowns (a
scanner-to-controls platform and an AI observability platform). The vendor documents are pattern sources only. No vendor
is named in this repository, and no marketing figure is adopted as a fact or a target. Text in one document that was
addressed to AI assistants was treated as data, which is itself a live example of indirect prompt injection in uploaded
documents.

The study, done against the code, found three things to act on:

1. **The NIST AI RMF pack cites wrong subcategory IDs.** "Accountability structures" is mapped to GOVERN 1.2; per AI 100-1
   that is "characteristics of trustworthy AI integrated into policies", and accountability is GOVERN 2.1. "Supersede,
   disengage or deactivate" is mapped to MANAGE 2.2 (sustaining value of deployed systems); the correct ID is MANAGE 2.4.
   The same errors spread to intake-assist suggested controls (bias also points to MEASURE 2.7, security and resilience,
   instead of MEASURE 2.11, fairness and bias), the demo scenario library and fixtures, and the demo model card. The pack
   covers 7 of the 72 subcategories.
2. **Builder skills are an unscanned prompt-injection surface.** A skill's body flows into agent instructions, but import
   and sharing check only frontmatter and length. This is the class ADR-0097 closes for MCP tool descriptions.
3. Some teardown scope (findings aggregation, trust center, a governance MCP server, ERP tooling) may belong to another
   suite module and needs a `CAPABILITY_MAP.md` check before any build.

## Decision

Build these, in this order. Each batch gets its own review, gate and push. Migrations come after 0139 in this order.

**Batch D1: now (no migration)**
- **A1 NIST AI RMF pack v3.** Publish `nist-ai-rmf@3` as a new immutable version (v1/v2 and their evaluations unchanged;
  the version diff explains the correction). Re-key to GOVERN 2.1 and MANAGE 2.4; map GOVERN 1.2 to the trust dimensions;
  add the subcategories existing collectors already evidence (inventory GOVERN 1.6, retirement GOVERN 1.7, recertification
  GOVERN 1.5, deploy gate MANAGE 1.1, residual risk MANAGE 1.4, vendor registry GOVERN 6.1 / MANAGE 3.1, monitoring MEASURE
  2.4 / 3.1, and so on); mark organisational subcategories attestation-required. Fix the intake-assist refs, the demo
  scenarios and fixtures, and the demo model card. A guard test checks every `nist-ai-rmf:*` reference in the codebase
  against a checked-in list of the 72 IDs, so this class cannot recur. The pack view shows coverage (controls with
  evidence ÷ mapped) beside the pass rate (passing ÷ with evidence).

**Batch D2: after ADR-0173 batch 2a lands (it owns the builder files)**
- **A6 Skill admission.** Run the ADR-0097 admission scanner on skill create, import and update; store a content digest
  and version; refuse or hold on findings; require admin approval when visibility widens beyond private; re-scan on the
  ADR-0100 schedule; record the digest of each skill used in a turn.
- **A5 Release-age cooldown.** An org setting (off by default, 7 days recommended) holds new MCP servers, changed admitted
  manifests, registry imports and new skill versions in quarantine until they are old enough and admitted, unless an admin
  overrides with a reason (audited).
- **A4 Served-model record.** Store the model the provider reports it served on every usage event, and add a monitor rule
  for when it differs from the configured model or the approved model card.
- **A9 Unregistered AI traffic.** A monitor rule lists projects and keys with model or MCP spend that no approved use case
  covers, with a "register as use case" remediation. It only observes and never blocks.
- **A7 Non-human credential inventory.** One read-only view over every stored credential (API and virtual keys, connector
  tokens, provider keys, MCP auth, SCIM tokens, signing secrets, deploy roles): owner, scope, created, last used, expiry,
  rotation age. Flags (never expires, unused, owner deactivated, over-scoped) feed access recommendations and the monitor.
  Secret material is never shown.
- **A15 Energy estimate.** A per-project and per-use-case estimate from ledger tokens × configurable per-model factors ×
  grid intensity, always labelled an estimate with its factor source, and shown as unknown (never zero) when no factor
  exists.

**Batch D3: continuous assurance**
- **A2 Measurable conditions.** A condition may carry a metric, operator, threshold, window and cadence, evaluated from
  existing ledgers (trace-evaluation flag rate, guardrail mode and hits, red-team success rate, eval scores, spend, error
  rate, "control evidenced in pack"). A blocking pre-go-live condition closes only when evidence passes. A post-go-live
  breach raises a monitor alert and can reopen review.
- **A3 Required AI test classes per risk tier** (OWASP LLM / agentic taxonomy). They attach as A2 conditions, are satisfied
  only by a fresh passing red-team or eval run against the approved stack, and are enforced by the deploy gate.
- **A8 Agent autonomy class.** Declared by the steward and derived from observed facts (schedules, sub-agents, write tools
  without Ask-first, inbound channels, delegation). Each class sets a control floor checked at approval and by the monitor,
  which also flags declared autonomy lower than observed.
- **A10 Risk tolerance and time-boxed acceptance.** An org tolerance per category or tier; risk acceptance with expiry,
  compensating controls and response type; expired acceptances reopen; residual risk above tolerance with no valid
  acceptance alerts and holds the deploy gate.

**Batch D4: accountability records**
- **A11 Decision regression suite.** Decisions and screening results cite the review-policy, template and screening-rule
  versions. A golden set of intake answers with expected outcomes runs in CI and before any template or screening change
  is activated, showing a diff of changed outcomes.
- **A12 AI incident register.** Severity, links, detection source, timeline, containment, root cause, corrective actions,
  notifications, lessons learned, and per-framework notification clocks (deadlines verified against the regulation text
  before coding).
- **A13 End-user feedback and appeal** per use case, routed to the owner with an SLA. It feeds a metric and can open an
  incident.
- **A14 AI literacy and acceptable-use acknowledgements**, with expiry. An optional ABAC attribute lets a grant require
  current training.
- **Pull-forwards:** alert owner, SLA and an optional ticket per alert episode (PF-14); threshold rules that *propose* a
  halt through remediation, never trip it (PF-03); the ISACA pack (ROADMAP I2).

Everything else goes into `PathForward.md`: extensions to PF-02..PF-14 and new items PF-15..PF-22.

## Consequences

- Wording rules hold: every agent call is bound to an entitled human identity (we don't claim "least privilege for
  agents"); detectors are called detectors; energy figures are estimates. Standard IDs are checked against the source
  before committing.
- Batches D1–D4 interleave with ADR-0173 batch 2c. A1 runs now because it corrects published evidence.

## Amendment — batch D1 built (2026-10-04)

- `nist-ai-rmf@3`: 31 controls, 25 evidenced by existing collectors (every audit filter checked against a rule id the
  gateway really writes) and 6 attestation-required (GOVERN 1.1, 2.2, 2.3, 3.1, 4.1, and MEASURE 2.4 until a
  trace-evaluation collector exists). v1/v2 are pinned by content hash in a test. MEASURE 2.7 now counts red-team runs,
  not evaluation runs. MAP 2.2 is left out until model-card sign-off requires the limitations field. The remaining
  subcategories are not mapped yet, because every mapped control counts as applicable on the trust dashboard.
- Corrected refs in intake suggestions (bias → MEASURE 2.11, tool misuse → MANAGE 2.4, over-permissioning → GOVERN 2.1,
  hallucination → MEASURE 2.5, shadow AI → GOVERN 1.6), the demo scenario library, fixtures, regulatory updates, the demo
  model card and the runbook. A guard test checks every NIST AI RMF reference against the 72 IDs.
- The pack scorecard shows coverage (controls checked ÷ mapped) beside the pass rate (passing ÷ checked). With nothing
  checked, the pass rate reads "unknown".
- Owner decision (2026-10-04): ship v3 before the 2026-10-05 demo and update the demo script's trust-dashboard figures.
