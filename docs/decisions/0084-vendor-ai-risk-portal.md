# ADR-0084: A vendor AI-risk registry whose answers are attestations, never evidence (gap L5)

- **Status**: Accepted
- **Date**: 2026-08-20
- **Migration**: `0088_ai_vendors.sql` — one table (`ai_vendors`), plus `ai_risks.vendor_id` and
  the `third_party_ai` risk category. `ai_vendor` joins the audit objectType vocabulary
  (plain-text column, no DDL).
- **Driver**: [GAP_ANALYSIS_CREDO_AI_2026-08.md](../product/GAP_ANALYSIS_CREDO_AI_2026-08.md)
  gap **L5** — *"Credo's Vendor Portal collects AI-risk evidence from vendors, tracks
  third-party AI in the registry, and applies policy packs to them. RegulAIt has nothing
  vendor-risk-shaped — our vendor story is COST, not risk."*
- **The overriding call**: the gap doc graded L5 *"defer unless a buyer says otherwise"*. The
  **owner directed building it (2026-08-20)** — same pattern as ADR-0083's L4 call, recorded
  here as the decision that supersedes the defer note.
- **Extends**: [ADR-0080](0080-ai-use-case-registry.md) (the governed-object-on-pillar-2-rails
  idiom this ADR copies wholesale), [ADR-0081](0081-ai-risk-register.md) (the register the new
  `third_party_ai` category joins), [ADR-0058](0058-compliance-packs.md) (the pack data model
  the attested checklist reads — read-only, see §3), [ADR-0077](0077-cascade-demo-headline-template-gallery.md)
  (the gallery the assessment shape joins).

## Context

Our vendor story was cost attribution (ADR-0069/0076 imports). Credo's differentiator here is a
*vendor portal*: collect AI-risk evidence from vendors, register third-party AI, apply policy
packs to it. The honest problem with imitating that: **almost everything a vendor supplies is a
claim.** A platform that renders "vendor satisfies CC9.2" because somebody pasted the vendor's
questionnaire answer has fabricated evidence — exactly the tick-box theater ADR-0058 was built
to refuse. The design question was therefore not "how do we collect vendor evidence" but "how
do we record vendor *claims* without ever letting them impersonate evidence".

## Decision

### 1. The object: `ai_vendors`, the ADR-0080 idiom verbatim

One table: name, description, a small honest category (`model_provider | ai_feature_vendor |
data_processor | integration` — chosen by *how the vendor's AI touches us*), owner, optional
linkage (`linked_custom_provider_ids`, validated against ADR-0034's registered endpoints;
`linked_agent_providers`, free-text provider keys as they appear on `agents.provider`), a
status lifecycle (`proposed → under_assessment → approved/rejected`, plus `retired`, all
CHECK-constrained like 0086), and the link to the governing workflow instance.

`approved`/`rejected` are reachable **only** through the linked assessment instance's terminal
decision on the one approvals queue (`syncVendorForInstance`, called from the decide path
inside the decision's transaction and from the driving routes via the same
`onInstanceTransition` callback ADR-0080 wired — the callback now runs both syncs). A `PATCH`
naming `status` is refused by name (`status_is_decided_not_patched`, 422); retirement is its
own audited, admin-only, reason-required endpoint; decided and retired are terminal against
the sync. Non-vacuity was proven the M-002 way: no-op the decide-path sync → the approve e2e,
the deny e2e, the decided-frozen test, and the risk-evidence delta test all fail (4 tests);
drop the attestation attribution → the attribution test and the checklist-labelling test fail
(2 tests). Both probes reverted by reversing the exact edit.

### 2. The assessment: a pillar-2 template, not a parallel intake engine

`vendor-ai-assessment` (trigger → ADR-0079 resting plan → `vendor_assessment_questionnaire`
artifact → human sign-off), published as an ADR-0077 gallery shape and resolved
find-or-create-by-name, so an admin can route vendor assessments to a named risk owner. The
questionnaire is an **honest blank form** — what AI the vendor runs, data shared,
subprocessors, certifications *claimed*, incident contacts, exit controls — that the assessor
fills with the vendor's own answers; the form says on its face that every answer is a vendor
attestation and nothing is pre-filled by a model. **An approval approves the assessment, not
the vendor's claims** — the lifecycle audit row and the API say so verbatim wherever an
approved status appears.

### 3. Pack vocabulary applied honestly: attestations with attribution, in the vendor's own row

A vendor detail can render a compliance-pack control checklist for any framework with an
**active** pack — the ADR-0058 data model (`compliance_packs`/`compliance_pack_controls`) read
**read-only**. Each vendor answer is recorded through an audited endpoint
(`POST /v1/vendors/:vendorId/attestations`) as `{framework, packId, packVersion, controlRef,
statement, evidenceRef, recordedByUserId, recordedAt, questionnaireVersion}` into the vendor's
own `pack_attestations` jsonb column, and only after the questionnaire artifact exists (the
attribution names the version the answer came from). The recorder must be a named user — the
bootstrap token is refused (`attribution_requires_identity`), because a claim without a
recorder is not a record.

**Deliberately NOT `compliance_pack_attestations` rows.** Those are the org's *own* statements
and feed `assessPackControl`'s `attested` status on the org's scorecards — reusing them would
conflate a vendor's claim with the org's attestation and let a vendor answer flip an org
control to `attested`. The suite pins the boundary from both sides: recording a vendor
attestation leaves `compliance_pack_attestations` at delta 0, **and** an org pack evaluation
run after the vendor attestation still reports the attestation-required control
`attestation_required`, never `attested`. `AI_VENDOR_ATTESTATION_DISCLAIMER` rides as a field
on the checklist, the list, the detail, and every attestation write response.

### 4. The risk-register join: `third_party_ai`, real from day one

ADR-0081's vocabulary had **no vendor-shaped category** (the only attestation-only category,
`scope_drift`, is about purpose drift) — so there was no resolver to *graduate*; instead the
category is **added** with a real resolver from its first day: `third_party_ai →
["vendor_assessments"]`, a SELECT over `ai_vendors` counting vendors by assessment state plus
assessments decided in the window, scoped to `ai_risks.vendor_id` when the risk names one
(the same narrowing `agent_id` does for red-team/eval evidence — this is why `vendor_id` is a
real column and the one place the join is load-bearing; `ai_use_cases` gets no vendor column
because nothing in its read path queries by vendor). The delta test proves the evidence is a
query: proposing a vendor moves `total`/`proposed` by exactly 1, deciding it moves
`approved`/`decidedInWindow` by exactly 1. The resolver's payload states its own limit: the
counts are lifecycle records (sign-offs on the one queue); the assessment *content* stays
vendor-attested. A ninth `DEFAULT_RISK_LIBRARY` entry seeds the scenario with the same honest
grading.

### 5. The SOC 2 CC9.2 decision: leave seeded v1, record the graduation path

ADR-0058's SOC 2 pack marks CC9.2 (vendor risk) attestation-required, with an ownerNote naming
this deferred gap. **The seeded v1 pack is left byte-identical** — rewriting its content under
the same `framework@version` would make two deployments disagree about what "soc-2 v1" says,
which is precisely the drift the one-active-version-per-framework discipline exists to prevent.
The graduation path, recorded here instead of shipped: a **soc-2 v2** pack (authored through
the existing pack API, or a future seed increment activated through the normal
activate-retires-v1 flow) could update CC9.2's ownerNote to point at this registry — but CC9.2
**stays attestation-required even then**, because (a) this registry covers the AI vendors
someone chose to record, not the vendor population a SOC 2 audit scopes, and (b) the underlying
assessment answers are vendor claims; a collector that counted vendor assessments as
`satisfied` evidence for CC9.2 would launder attestations into evidence through one level of
indirection. The stale half of v1's ownerNote ("deliberately deferred") is now historical
rather than current — this ADR is the correction of record.

### 6. Surfaces

- Gateway: `POST/GET /v1/vendors`, `GET/PATCH /v1/vendors/:vendorId`,
  `POST /v1/vendors/:vendorId/attestations` (all non-admin route class, owner-or-admin
  in-handler — the ADR-0080 scoping), `POST /v1/vendors/:vendorId/retire` (admin, audited).
  All writes audit as objectType `ai_vendor`; routes tagged `vendors` in the ADR-0053 registry.
- Web: an admin "Vendors" page (governance group, beside Use cases) — propose form, badged
  registry, detail driving the assessment through the ordinary workflow endpoints, the
  attested checklist labelled "vendor-attested — not verified by this platform", retire. No
  status control anywhere (the e2e spec asserts the absence structurally).

## Honest limits

- **Attestations are claims, not verification.** Nothing here verifies a vendor's SOC 2
  report, its subprocessor list, or its data handling — the platform records who said what,
  when, from which questionnaire. An approved vendor is a *decided assessment*, not a safe
  vendor.
- **No vendor-facing portal.** Credo's version lets the vendor log in and upload; this is an
  internal record of vendor-supplied answers, and **no external auth surface was added** —
  deliberately, because a vendor-facing surface is an attack surface and nothing here needs
  one yet.
- **No automated vendor discovery.** ADR-0083's classifier findings may NAME a vendor in a
  finding; nothing auto-creates an `ai_vendors` row from one. Every vendor was proposed by a
  person.
- **No SLA/renewal scheduler.** Re-assessment cadence (annual reviews, cert expiry) is the
  customer's own process; the registry records `decided_at` so the customer can query
  staleness, but nothing fires on it.
- **Approval gates nothing.** As with use cases (ADR-0080), an approved/rejected vendor
  changes no enforcement — a rejected vendor's linked provider still dispatches if entitlement
  allows. Naming that gate ("dispatch to a provider requires an approved vendor") is the
  obvious next step, named here rather than implied as shipped.
- **The checklist needs an active pack.** A framework with no active `compliance_packs` row
  renders an honest empty checklist, not an error and not a built-in fallback.
