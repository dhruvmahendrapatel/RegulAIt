# ADR-0123 — A use case mapped to any shipped framework, and the refusal that becomes its own evidence

- **Status**: Accepted
- **Date**: 2026-09-25
- **Relates to**: [ADR-0058](0058-compliance-packs.md) (compliance packs: evidence is a computed
  count from a real ledger, never a stored verdict — the posture this ADR inherits and does not
  loosen), [ADR-0047](0047-executive-compliance-reporting.md) (report entitlement, reused verbatim
  so a preview can never widen), [ADR-0080](0080-ai-use-case-registry.md) (the AI use-case registry),
  [ADR-0085](0085-eu-ai-act-tier-screening.md) (the EU AI Act tier screening this route
  deliberately leaves alone)
- **Migration**: **none.** One new read route, and two existing audit writes gain a field they
  should always have carried.

## Context

PoC acceptance criterion (d) is *"map a use case to NIST AI RMF with evidence"*. Our own gap
analysis rated it **"YES, with a seam to narrate"** and told the demo driver to walk around it. The
seam had two halves, and the second was worse than a missing feature.

### The framework was a constant

`euAiActScreeningFor` cited compliance packs only as a consequence of an EU screening reaching a
`high` or `prohibited` tier, and it filtered packs with the literal string `"eu-ai-act"`. So:

- every other pack we ship — **NIST AI RMF included, and it has shipped since ADR-0058** — was
  unreachable from a use case;
- NIST AI RMF has no tier concept at all, so even fixing the literal would not have made it
  reachable through a gate that only opens on an EU risk tier.

### A project-attributed refusal was not countable

This is the half that matters. A pack's `audit_decisions` collector scopes by
`detail->>'projectId'` — that is its only route to a tool decision. The governed **decision** rows
on the MCP tool path and the connector invoke path did not carry it. The **PII-block** rows on
those same two paths did.

The consequence: a project-scoped evaluation of `nist-ai-rmf:MANAGE-2.2` — whose entire claim is
*"mechanisms are in place to supersede, disengage or deactivate an AI system"*, and whose own
`ownerNote` says it is *"evidenced by refusals actually occurring"* — **counted zero**, while the
refusals sat in the ledger, correct, hash-chained and invisible to the report.

That is not a gap in capability. It is the product telling an auditor that evidence does not exist
when it does, which is the specific failure ADR-0058 was written to avoid.

## Decision

### 1. `GET /v1/use-cases/:useCaseId/frameworks` — a mapping, not a widened screening

A screening and a mapping are different questions. The EU screening stays exactly as it is: a
questionnaire, a tier, and a refusal reason, all three specific to the Act. Widening it to other
frameworks would have meant inventing a tier for frameworks that do not have one.

The new route iterates **every active pack** (optionally filtered by `?framework=`), and returns
each pack's control vocabulary with its coverage class. That is the mapping half, and it is
available for a use case in any state.

### 2. Two audit writes carry the project they were already attributed to

`detail.projectId` is added to the governed decision row on the MCP tool path and the connector
invoke path — `null` when the call was unattributed, exactly as the `usage_events` row for the same
call already was. The two records now agree about the same event.

**An unattributed refusal is still not counted, and that is correct**: it is not evidence about any
project. The demo driver has to make the refused call with the project header, and that is the
honest behaviour rather than a trick.

### 3. The remaining seam is named on every response, not narrated around

Evidence is collected **per project**. This route does not change that, and does not pretend to:

- `evidenceScope.note` says, on every call, that the counts describe everything governed in that
  project rather than this use case alone;
- a use case with **no project** returns `evidenceScope.kind: "no_project"` and every control's
  `status` and `evidenceCount` as **null** — *not measured* and *measured as none* are different
  claims, and a mapping that borrowed numbers from elsewhere would be worse than one that admits it
  has none;
- the entitlement decision is ADR-0047's own `evaluateReportAccess`, taken against the use case's
  project, so a preview can never show more than a report would;
- and **the route persists nothing**. `POST /v1/compliance/packs/:id/evaluate` writes a report row
  because that call *is* the artifact; a page view that minted one each time would bury the real
  reports in noise.

### 4. Disabling an agent becomes an audited act

Found while auditing this product against ISACA's *"log prompts, tool calls, decisions and
approvals"* item. `POST /v1/agents/:agentId/enabled` wrote **nothing** to the ledger and took no
reason — three lines above a comment promising *"audited acts — never silent PATCH writes"*.

`enabled = false` is enforced in the policy kernel and refuses **every** caller platform-wide
regardless of grant. It is also the closest thing this product currently has to an emergency stop.
"When did this agent stop answering, and who stopped it?" had no answer in the ledger. It now
writes distinct rule ids per direction (`agent-disabled` / `agent-enabled`), with the effect
following the consequence — turning it off starts refusing, so it records as a `deny` — and a
no-op write mints no row.

## Consequences

**Easier.** Criterion (d) is one call, for any shipped framework, with live numbers. And it pairs
with criterion (b) on the same screen: the refusal just demonstrated moves `MANAGE-2.2` from
`unsatisfied` to `satisfied`, because the deny it produced is the evidence. A control going green
in front of the customer *because of the thing they just watched* is a materially better answer
than a two-hop narration.

**What we did not do.** No use-case-scoped evidence. A use case is not a scope the collectors
understand, and inventing one would have meant either a second copy of the collector logic keyed on
something else, or filtering a project-scoped count down by a heuristic. Both are how a compliance
number stops meaning anything. The scope stays the project and the response says so.

**No first-class use-case↔control link.** A use case still cannot attest to a control the way an
`ai_vendor` can (`aiVendors.packAttestations`). That pattern exists and could be lifted, but it
records **claims**, and ADR-0058's whole posture is that a human statement must never be counted as
satisfied. Worth doing only alongside this, labelled the way the vendor page labels it.

**`modelCards.standardRefs` is still display-only.** It looks like a join to `controlRef` and is
not one — nothing reads it for lookup, and the values seeded for the demo are prose that does not
even share the `nist-ai-rmf:GOVERN-1.2` format. That is now a known, stated non-feature rather than
an implied one.

**Follow-up this creates.**

- The `?framework=` parameter has no UI. The use-cases page still renders only the EU screening.
- `agent-disabled` is an audited act but still not an *emergency* control: there is no global or
  per-tool kill switch, and no read-only/safe mode. See the ISACA roadmap section.
- The vendor-style attestation pattern for use cases, if a customer needs to carry a control the
  platform cannot evidence.
