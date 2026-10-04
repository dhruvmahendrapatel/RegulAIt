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

## Amendment — batch D2 built, and its review fixes (2026-10-04)

**What D2 shipped** (migrations 0140 and 0141). A7 and A15 are not part of this batch.
- **A6 skill admission.** Every skill save (create, SKILL.md import, update, template seed, bundle import) runs the
  ADR-0097 rules through `scanAdmissionUnits`, plus look-alike-letter and exfiltration-URL detectors. A high finding
  refuses the save (422 `skill_admission_refused`, counts-only findings); a medium finding holds the skill until an admin
  admits it with a reason. A held skill can't be attached, and a held pinned copy is kept out of the prompt. A
  non-admin's widening to the workspace is a request an admin decides on the Admission review page. The ADR-0100 sweep
  re-scans library rows and pinned copies. Each builder step records the digests of the skills it carried.
- **A5 release-age cooldown.** `min_release_age_days` (0 = off, 7 recommended) holds new MCP servers, changed
  manifests, registry imports and new skill versions until they are old enough by this deployment's own first sighting,
  or an admin overrides one item with a reason (audited).
- **A4 served-model record.** `usage_events.served_model` stores what the provider reported (never guessed), and the
  `served_model_drift` rule compares it with the configured model using version-suffix matching.
- **A9 unregistered AI traffic.** `unregistered_ai_traffic` reports model or MCP spend that no approved use case covers.
  It only observes and never blocks.

**Rules added by the review**
1. **A skill's prompt text is its name plus its body.** `skillPromptSection(name, body)` is the one definition the
   prompt, the scan and the digest all use. The attachment pins `snapshot_name` with the body, and the prompt heading is
   the pinned name, never the live one. A rename is a content change: it is re-scanned, the version goes up, and agents
   see "update available". A name may not contain line breaks, control characters or invisible formatting characters
   (422 `skill_name_invalid`).
2. **The phrase detectors read three copies of each text:** the raw text, a normalised copy (NFKC, invisible characters
   removed, whitespace collapsed) and a copy folded through a small, documented map of Cyrillic and Greek look-alike
   letters. A newline, a full-width spelling, or a look-alike spelling of an injection phrase is refused like the plain
   phrase. A skill is also scanned as the prompt shows it, so a phrase split between the name and the body is caught.
   The fix is in `scanAdmissionUnits`, so MCP manifests get it too (scanner versions `mcp-admission/2` and
   `skill-admission/2`). These are still detectors: encodings and paraphrase still get past them.
3. **A skill save is conditional.** A PATCH applies only if the row still has the digest and `updated_at` it was read
   with (409 `skill_changed_concurrently` otherwise). Admission columns are written only when scanned text changes, and
   the digest is of exactly the text stored. A builder step's trace records the digest of the bytes sent to the model.
4. **Sharing an agent never widens a private skill's audience.** A turn carries a skill only if the person running it
   may open that skill (its owner, an admin, or anyone once it is shared with the workspace). Everyone else runs the
   agent without it. We chose this over turning the agent share into a pending request: it is the least disruptive
   option that is still safe, because sharing keeps working, nothing private leaks, and the existing approval of a
   skill's widening is the one way to include it. The editor marks such a skill "Only its owner".
5. **Admins approve what they were shown.** Skill admit and release-age override require the digest (or `registration`)
   the page displayed, and the write is conditional on it. If the item has changed since, the request gets a 409
   (`skill_changed` or `release_changed`).
6. **A9 coverage matches the use-case gate.** A use case covers its project only while it is approved and its
   `approved_until` is null or in the future. A lapsed approval is listed on the finding.
7. **A first manifest is aged by the later of two times:** the registration (or registry entry) sighting, and the first
   sighting of that manifest's digest. A manifest nobody has seen before counts as seen when the server was registered.
   So an ordinary registration waits once, but importing an old registry entry whose upstream now serves an unseen
   manifest still waits.
8. **Skills from before 0140 are scanned lazily:** on attach, on re-attach, and when a turn loads an `unscanned` (or
   digest-mismatched) library row or pinned copy. The verdict is stored and applied, and a held skill is withheld. This
   is idempotent.
9. **A pin is an exact version.** A model card's `pinned_model_version` must match the binding's base model (its
   expected served model if set, otherwise its configured model). A floating alias such as `latest` gets a 422. A
   pinned-version drift raises a **high** alert, and an open high alert on an agent **blocks the deploy gate** for every
   use case that depends on it, until someone acknowledges or resolves it. A binding may set
   `agents.expected_served_model` (`PUT /v1/agents/:id/expected-served-model`, admin, audited) so that an endpoint
   named after a deployment doesn't raise drift on every call.
10. **A skill's release clock is its own:** sightings are keyed by (skill, digest). Manifests and registry entries are
    still keyed by digest alone.
11. **The pinned-copy re-scan rotates.** Copies are re-scanned least-recently-scanned first (`snapshot_scanned_at`),
    so the per-pass cap no longer re-reads the same rows. An admission belongs to its digest: a copy admitted at an
    older digest keeps its admission when it is re-scanned.
12. **A9 has an index on `usage_events (object_type, at)`, and its alert titles contain no personal data.** Titles
    reach ChatOps channels, so a caller is shown as "A user (id …)". The display name stays in the admin-only detail.
