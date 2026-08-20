# ADR-0058: Compliance Packs — pre-built control mappings and evidence collectors per framework

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

The regulatory tailwind is the strongest force pulling this category forward. The EU AI Act is
phasing in obligations for high-risk AI systems; NIST AI RMF and ISO/IEC 42001 are becoming the
default enterprise AI-governance frameworks; and existing regimes — HIPAA, PCI-DSS, FINRA — now
have to be answered *for AI usage specifically*, not just for the underlying data systems. Every
regulated enterprise evaluating an AI-governance platform arrives with the same question: "which of
my controls does this satisfy, and can it produce the evidence?" Today, RegulAIt has all the raw
material to answer that — the compliance-classification cascade (GOVERNANCE_LAYER_SPEC §8.3) already
turns a single tag into required workflow stages, MCP/connector data-scope defaults, audit-log
retention, and PII mode; the append-only `audit_log` and measured `usage_events` already hold the
evidence; the reporting layer (ADR-0047) already knows how to render it — but a customer has to
assemble the mapping from framework control → RegulAIt configuration → evidence query *by hand*,
per framework. That assembly is exactly the expensive, expertise-heavy work that stalls a
regulated-industry sale.

The tension:

- **Acceleration vs. false assurance.** A pre-built pack that maps ISO 42001 controls onto platform
  configuration is enormously valuable *and* dangerous if it is mistaken for a compliance
  guarantee. RegulAIt is a control-and-evidence platform, not a law firm and not an auditor. The
  packs must be framed, in-product and unmistakably, as **accelerators** — the customer and their
  counsel/auditor own the final determination. Overclaiming "HIPAA compliant out of the box" is both
  false and the kind of dishonesty this project has refused everywhere (ADR-0034/0035); worse here,
  because the overclaim is *legal*.
- **Build on the cascade, don't fork it.** The cascade (§8.3) is already the single mechanism that
  translates a classification into enforced controls. Packs must be *presets that drive the
  existing cascade*, not a parallel compliance engine. One tag, one cascade, one audit trail — a
  pack is a curated bundle of what the cascade should apply for a given framework, plus the queries
  that evidence it.
- **Frameworks overlap and conflict.** A workload can be both HIPAA and PCI. The cascade already has
  conflict-resolution posture (ADR-0027: MIN budget ceiling, block-beats-warn floor, cascade-style
  conflict surfacing). Packs must slot into that, not invent a second reconciliation rule.
- **Provider/framework-agnostic and updatable.** Regulations change; control catalogs get revised.
  A pack must be versioned, updatable data, and the framework set must be extensible (a customer's
  internal control framework is a first-class pack too), mirroring the catalog-as-data posture of
  ADR-0034/0055/0057.

## Decision

Ship **Compliance Packs** — versioned, framework-specific bundles that configure and evidence the
existing compliance cascade — for launch with **EU AI Act, NIST AI RMF, ISO/IEC 42001, HIPAA,
PCI-DSS, and FINRA**, plus a template for customer-defined internal frameworks. A pack is data
composed of four parts, all built on primitives that already exist.

**1. Control mappings + policy templates.** For each framework, a versioned mapping from its control
catalog (e.g. an EU AI Act obligation, a NIST AI RMF function, an ISO 42001 clause) to the concrete
RegulAIt configuration that addresses it: policy-as-code templates (GOVERNANCE_LAYER_SPEC §5),
per-user/role entitlement defaults, MCP/connector data-scope defaults, and PII-handling mode. Each
mapping entry states *which* control it addresses and *how* the configuration addresses it — and,
honestly, where a control is **only partially** addressable by platform config and needs an
out-of-band organizational process (packs distinguish "enforced by RegulAIt" from "documented,
owner's responsibility").

**2. Required-workflow-stage presets built ON the §8.3 cascade.** A pack declares the workflow
stages a classified Initiative must carry — e.g. EU AI Act high-risk work forces a design/
architecture sign-off stage and a red-team gate (ADR-0057); HIPAA forces stricter PII mode and
retention. These are **cascade presets**: tagging an Initiative with a pack's classification drives
the *existing* cascade (§8.3) to apply them, reusing ADR-0027's additive-reapply and conflict-
surfacing behavior when multiple packs apply. Packs also ship the red-team **gating presets**
ADR-0057 consumes (which attack classes block promotion for this framework) and the cost-governance
policy ADR-0027 attaches per framework. Nothing new enforces these — the cascade does.

**3. Audit-evidence queries feeding the reporting layer.** For each control, a parameterized,
entitlement-filtered query over `audit_log` / `usage_events` / workflow events that produces the
evidence an auditor asks for: "all PII-access decisions in scope, with approver and rule" (HIPAA),
"model-change promotions with their red-team gate results" (EU AI Act / NIST), "every write-tool
call to a cardholder-data connector with its approval" (PCI). These are **not a new query path** —
they are curated inputs to the reporting layer (ADR-0047) and can be run/drafted by the governance
copilot (ADR-0056), which turns "produce the ISO 42001 evidence pack" into a governed, human-signed
draft rather than an engineering ticket. Evidence queries respect the caller's entitlement scope, so
a pack never becomes a backdoor to the whole audit log.

**4. A coverage scorecard.** Per framework, per Initiative, a scorecard showing which controls are
**enforced** (cascade actively applies the config), which are **evidenced** (a passing evidence
query exists and returns data), which are **partial/owner-responsibility**, and which are
**unaddressed**. This is the honest heart of the feature: it tells a customer exactly how far the
platform gets them and exactly what remains theirs — the same coverage-not-claim posture as the
shadow-AI scorecard (ADR-0055) and red-team coverage reporting (ADR-0057). The scorecard is the
sellable artifact *and* the guardrail against overclaim: it never renders "compliant," only
"N of M controls enforced/evidenced here, K owner-responsibility, J unaddressed."

**5. Versioned, extensible, agnostic.** Every pack is versioned data with provenance, so a framework
revision is a pack update (not a redeploy) and a report records which pack version evidenced it. A
customer-defined internal framework is authored as a pack using the same schema. Packs compose with
Shared Projects (a Shared Project's classification, §9.3, drives its packs) and with each other via
the existing conflict-resolution rules.

Worked example (EU AI Act high-risk): tagging an Initiative with the pack's `eu-ai-act-high-risk`
classification cascades (§8.3) into a forced design/architecture sign-off stage and a required
red-team gate (ADR-0057) tuned to gate jailbreak, PII-leak, and bias; sets connector/MCP data-scope
defaults tighter and PII mode to block; and lengthens audit retention. The pack's evidence queries
then answer the Act's own asks — a record-keeping query enumerating every model-promotion with its
red-team result, a human-oversight query showing which stages required a named approver — rendered
through the reporting layer (ADR-0047) or drafted by the copilot (ADR-0056) for human sign-off. The
scorecard shows, say, "logging/record-keeping: enforced+evidenced; human oversight: enforced;
risk-management-system documentation: partial (owner-authored); post-market monitoring:
owner-responsibility" — an honest map of exactly how far the platform gets them.

## Consequences

**Easier.** The expensive, expertise-heavy "map the framework onto the tool" work ships in the box,
collapsing a regulated-industry sales cycle from a services engagement to a classification tag. A
compliance officer gets framework-shaped reports and a coverage scorecard from primitives that
already exist — the packs are curation and mapping, not a new engine. Because packs drive the one
cascade and feed the one reporting layer, "configure for HIPAA" and "evidence HIPAA" share the same
audit trail as everything else, and the regulatory tailwind (EU AI Act, ISO 42001) becomes a
concrete, demonstrable capability rather than a marketing adjective.

**Harder / explicitly given up.**

- **Packs are accelerators, not legal advice — stated everywhere, not once.** This is the load-
  bearing honesty of the whole ADR. A pack maps controls to configuration; it does not certify
  compliance, does not substitute for an auditor or counsel, and does not shift legal
  responsibility onto RegulAIt. The customer plus their qualified advisors own the final
  determination. The product must state this at the point of use (on every pack, every scorecard,
  every generated report), and the scorecard must never emit a "compliant" verdict — only
  enforced/evidenced/partial/unaddressed counts. Building the honest framing *into* the artifact is
  the mitigation; a disclaimer buried in a ToS is not.
- **A mapping can be wrong or stale.** A control interpretation may be contested, and a framework
  revision can invalidate a mapping until the pack is updated. Versioning + provenance make the
  staleness legible (a report says which pack version it used); they cannot make the mapping
  authoritative. Packs are a well-informed starting point subject to the customer's own review.
- **Partial coverage is the norm, and the scorecard must not hide it.** Many controls are
  organizational (training, governance committees, incident response) and only *partially*
  touchable by platform config. If the scorecard let those read as "enforced," it would manufacture
  exactly the false assurance we are trying to avoid — so the enforced / evidenced / partial /
  unaddressed distinction is a hard requirement, not a nicety.
- **Framework overlap adds real conflict cases.** HIPAA + PCI on one workload can pull controls in
  different directions; packs inherit ADR-0027's MIN-ceiling / block-beats-warn / surface-the-
  conflict rules rather than resolving conflicts silently, and some conflicts will need admin
  adjudication — accepted, and surfaced, rather than auto-resolved.

**Follow-up work.** The pack schema (control mapping + cascade preset + evidence query + scorecard
definition), versioned with provenance. The six launch packs authored against current framework
catalogs, each reviewed with appropriate domain input. The scorecard surface and its
enforced/evidenced/partial/unaddressed model. Wiring evidence queries into the reporting layer
(ADR-0047) and the copilot (ADR-0056), and gating presets into red-teaming (ADR-0057). An
internal-framework authoring path so a customer's own control set is a first-class pack. And a
standing review cadence to update packs as frameworks change — with every generated report stamped
with the pack version that produced it.

## Amendment — 2026-08-02: implemented as VERSIONED DATA over REAL LEDGER QUERIES, with no certification claim (migration 0073)

Implemented and accepted. What follows is the honest split between what this
release genuinely enforces and what is structural — and, before either, the
correction that matters most.

### The correction this amendment makes, before anything else

**A compliance pack produces a CONTROL-MAPPING REPORT. It does not produce
compliance, and it certifies nothing.** Generating an EU AI Act pack report is
not being compliant with the EU AI Act; generating a HIPAA pack report is not a
Security Rule attestation; generating an ISO/IEC 42001 pack report is not a
certification and is not an audit. RegulAIt maps a framework's controls onto
platform configuration and counts the evidence its own ledgers hold. The
customer plus their qualified advisors — counsel, a QSA, a certification body —
own the final determination, and nothing in this release changes that.

This is not left to a ToS. `COMPLIANCE_PACK_DISCLAIMER` is a **field on every
scorecard object**, on every stored `compliance_pack_reports` row, on the pack
list response and on the pack-backed `controls` section of an ADR-0047 report.
The scorecard type has **no verdict field at all** — no `compliant`, no
`passed`, no grade — so there is nothing for a console to render as one, and the
unit suite asserts those properties are absent rather than merely unset.

### Genuinely enforced by this release

- **Evidence is a query, never a tick-box.** Migration 0073 contains **no
  `satisfied` column, no control status, no `marked_met_by`.** There is nowhere
  in the schema for a human to record that a control is met. `runCollector` is
  the only path to a number and every branch of it is a `SELECT` against a
  ledger that already exists — `audit_log`, `approvals`, `model_card_approvals`,
  `eval_runs`, `guardrail_configs`, `abac_policies`, `lineage_edges`,
  `usage_events`, `compliance_profiles`. The suite seeds evidence into the
  period and asserts a control goes **satisfied**, deletes it and asserts the
  same control goes **unsatisfied** again, with no other change: a control that
  is always green fails that test.
- **The threshold is compared, not ignored.** A control with
  `min_evidence_count: 10000` is asserted unsatisfied on the same three rows
  that satisfy a `min_evidence_count: 1` control in the same evaluation.
- **An organisational control can never be auto-satisfied.** `attestation_required`
  is checked in `assessPackControl` **before any count is consulted** and returns
  there, so no path — not even a mis-authored control carrying both the flag and
  a collector — reaches `satisfied`. A DB CHECK enforces the pairing
  (`attestation_required = false OR collector = 'none'`) so the mis-authored row
  cannot even be stored. Such controls report `attestation_required`, or
  `attested` once a **named human** records a statement — a status deliberately
  distinct from `satisfied` and counted separately on the scorecard. An expired
  attestation falls back to `attestation_required` rather than standing forever.
  The inverse attack is refused too: attesting to an **auto-evidenced** control
  returns 409 and writes an audited `deny`, because a human statement must never
  stand in for ledger evidence.
- **Packs are data, and the suite proves it by moving the data.** A framework
  that appears nowhere in this repository's source
  (`acme-internal-ai-standard`) is POSTed, activated and evaluated against the
  real ledgers with no code change. `framework` is free text precisely so a
  customer's internal control set is a first-class pack without an enum
  migration.
- **Entitlement scoping is ADR-0047's, verbatim.** `evaluateReportAccess` is
  reused rather than copied — one decision function, one set of refusals — and
  every scoped collector builds its `WHERE` clause **from the returned project-id
  list at query construction**, never as a filter over an already-computed
  aggregate. The suite seeds 2 evidence rows in team A's project and 7 in team
  B's, and asserts a team-A lead's scorecard counts **exactly 2** while the
  admin's org-scoped run counts 9. A non-admin asking for org scope gets 403 with
  an audited deny, and cannot read an artifact generated at a wider scope.
- **Versioning is a database fact.** A partial unique index enforces at most one
  `active` version per framework; activating v2 retires v1 in the same request.
  `compliance_pack_reports.pack_version` stamps every artifact, and the suite
  asserts a v1 report still reads v1 after v2 activates — a framework revision
  never rewrites a report an auditor was already handed.
- **ADR-0047's placeholder catalogue is retired.** `report_definitions.pack_id`
  routes the `controls` section through the pack's real, ledger-evidenced
  assessment (`catalogueSource: "pack"`, stamped with the pack version). A
  definition naming no pack keeps the built-in set, whose note now says plainly
  that it **is a fallback and not a framework mapping**.
- **Every act is audited** with a stable `rule_id` through the ordinary audit
  path: authoring, seeding, activating (and the retirement it causes), attesting,
  evaluating — and the two refusals that matter, the unentitled evaluation and
  the attestation on an auto-evidenced control.

### How a pack is updated without a release

A pack is rows, not a build artifact. A framework revision is a **new
`compliance_packs` row** with the same `framework` and a higher `version`, its
controls posted alongside it, then activated — which retires the previous version
in the same request. Reports keep the version that produced them. A framework
nobody shipped is the same POST with a new `framework` string.
`DEFAULT_COMPLIANCE_PACKS` is a **seed** that `POST /v1/compliance/packs/seed`
inserts as ordinary rows (idempotent per `framework@version`); the evaluator
reads rows and nothing else, so emptying the tables makes it evaluate nothing.

**The one boundary, stated rather than discovered.** A pack cannot add a new
evidence *source*. `collector` names one of a fixed, parameterised vocabulary
over ledgers that already exist — a pack is analyst-authored data, and one that
could carry SQL would be an injection primitive wearing a control mapping's
clothes. A control needing a ledger RegulAIt does not keep **must** be marked
attestation-required; it is never silently reported as satisfied. That boundary
is shipped as `COMPLIANCE_PACK_UPDATE_POLICY`, returned on the pack list and
rendered on the console page.

### Structural only — named plainly

- **The six launch packs are a well-informed starting point, not a reviewed
  mapping.** Every one carries `provenance.reviewedBy: null`, and the unit suite
  asserts it stays null — the packs were authored from public framework
  catalogues without domain review, and a pack that claimed a counsel review it
  never had would be the exact overclaim this ADR refuses. §"Follow-up work"'s
  "each reviewed with appropriate domain input" is **not done**. Control
  selection is partial by construction: these map the controls this control plane
  can speak to, not the frameworks in full.
- **Packs do not drive the §8.3 cascade yet.** `cascade_tag` is recorded and
  surfaced, and the ADR's design is that tagging an Initiative with it drives the
  *existing* cascade — but this release wires **no automatic creation of a
  `compliance_profiles` row from a pack**. An admin must still author the
  profile. The evidence and scorecard half of §2/§3 ships; the **preset half of
  §2 does not**, and a pack therefore currently enforces nothing by itself.
- **No red-team gating presets.** §2's "packs also ship the red-team gating
  presets ADR-0057 consumes" is not built here.
- **No multi-pack conflict surfacing.** §"Framework overlap" inherits ADR-0027's
  rules through the cascade, but nothing in this release evaluates two packs
  together or surfaces a HIPAA-vs-PCI conflict; each pack is evaluated
  independently.
- **`coverage` is the mapping author's claim, not a verified property.** The
  enforced/evidenced/partial/unaddressed class is what the pack author declared.
  The *computed* status (satisfied / unsatisfied / attested / attestation-required
  / unaddressed) is the part derived from the ledgers, and they are reported as
  separate fields precisely so the declared claim cannot be mistaken for a
  measurement.
- **Configuration-shaped collectors count configuration, not operation.**
  `guardrail_configs`, `abac_policies_active`, `model_cards_approved` and
  `compliance_profile_cascade` evidence that a control is *configured* — a quiet
  period is not proof a runtime control exists. Presence of evidence is never an
  assertion that a control is operating effectively; an auditor judges
  effectiveness, this counts rows.
- **No CSV/PDF export of a scorecard.** JSON only, and the pack-backed ADR-0047
  `controls` section rides that ADR's existing CSV. Same PDF posture as ADR-0047.

### Migration

`0073_compliance_packs.sql` — four tables: `compliance_packs` (versioned pack
identity with provenance and a partial unique index enforcing one active version
per framework), `compliance_pack_controls` (the mapping, with the DB CHECK that
an attestation-required control carries no collector),
`compliance_pack_attestations` (the one human-recordable input, and it is
`attested`, never `satisfied`) and `compliance_pack_reports` (the immutable
artifact, stamped with pack version and effective project ids). Plus
`report_definitions.pack_id`, which retires ADR-0047's placeholder catalogue.
`audit_log.object_type` gains `compliance_pack` as a TS-only widening — the
column has no DB CHECK, so there is no DDL for it.

---

## Amendment (2026-08-20) — seventh seed pack: SOC 2 (Security / Common Criteria)

The Credo AI gap analysis (`docs/product/GAP_ANALYSIS_CREDO_AI_2026-08.md`, item
L3) named pack-curation breadth as a real gap even though the *mechanism* above
already existed. First curation increment: a **SOC 2 — Security (Common
Criteria)** pack is appended to `DEFAULT_COMPLIANCE_PACKS`, taking the seed set
from six frameworks to seven (`soc-2` added to `COMPLIANCE_PACK_FRAMEWORKS`).

Scope and honesty posture, consistent with everything above:

- **Security (common criteria) only.** No Availability, Processing Integrity,
  Confidentiality, or Privacy category controls are mapped; the pack title says
  so. Provenance records that the mapping was authored from the public AICPA
  Trust Services Criteria (2017, rev. 2022) and has **not been reviewed by a CPA
  firm** — `reviewedBy` stays null, which the shared test suite pins for every
  pack.
- **Ten controls, honestly graded.** Three are `enforced` and evidenced by
  queries over real ledgers (CC6.1 logical-access denials via `audit_decisions`
  with `effect: "deny"`; CC6.6 boundary/egress denials via the `egress` rule-id
  prefix; CC8.1 change authorization via approved workflow `approvals`). Three
  are `evidenced` (CC6.2 user provisioning/deprovisioning audit rows; CC6.7
  semantic-DLP guardrail configuration; CC7.2 prompt-injection detection at
  `block`). CC6.3 is `partial` — the rows exist but the review cadence is an
  organisational process. CC7.4 (incident response), CC9.2 (vendor risk — the
  owner note names the deliberately deferred L5 vendor portal), and CC1.4
  (competence/HR) are attestation-required: they are organisational controls the
  platform cannot query, and pretending otherwise would be exactly the tick-box
  this ADR exists to refuse.
- **`cascadeTag` is null.** SOC 2 is an attestation framework about the service
  organisation, not a data-sensitivity regime like HIPAA/PCI; it forces no
  cascade profile.
- The shared enumeration test now pins seven frameworks, and every generic pack
  invariant (parses under the API schema, at least one attestation-required
  control, no claimed counsel review) applies to it unchanged.
