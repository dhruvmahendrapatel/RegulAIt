# ADR-0058: Compliance Packs — pre-built control mappings and evidence collectors per framework

- **Status**: Proposed
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
