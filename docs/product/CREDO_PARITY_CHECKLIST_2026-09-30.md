# Credo capability and workflow checklist

Evidence date: 2026-09-30. Owner direction: continue toward current Credo
capability and workflow parity, not merely a similarly named module list.
The owner's supplied diagram is a workflow reference: agents, models, LLMs
and applications enter Discover -> Assess -> Govern. Outcomes and counts
must be computed from scoped records, never copied from illustrative metrics.

## Evidence rules

Public pages establish advertised scope, not verified behavior inside Credo.
No authenticated Credo tenant was inspected. A local module or passing unit
test is not proof of comparable end-to-end usability, integration coverage,
detection quality or regulatory assurance. Historic L1-L8 completion labels
remain historical; they do not close this checklist. Earlier recommendations
to defer discovery or vendor collaboration do not override the owner's current
authorization to build parity. Production deployment still needs explicit signoff.

Official references checked:

- [Platform](https://www.credo.ai/product): registry, discovery, dependencies,
  contextual risk/controls, policy inheritance, monitoring, evidence and
  business reporting. Its CI/CD, CASB and API-gateway enforcement integrations
  are explicitly described as planned, not confirmed delivered features.
- [GAIA](https://www.credo.ai/govern-ai-agents): context-assisted registration,
  questionnaire suggestions with confidence/citations/reasoning, and human
  review of recommended risks, controls and compliance mappings.
- [Vendor compliance](https://www.credo.ai/solutions/vendor-compliance):
  register vendors' systems, apply requirements, invite vendors to submit
  evidence, and report on that evidence.
- [Regulations and standards](https://www.credo.ai/solutions/regulations-and-standards):
  regulatory templates and a maintained governance information hub. Marketing
  summaries are not authoritative legal interpretations or certification.

## Open acceptance checklist

Existing files below are implementation starting points, not completion claims.
Each row stays open until an operator journey, authorization tests and evidence
of relevant live integrations are recorded. The latest P1/P2/P3 order remains
the immediate implementation sequence.

| Area | Existing starting point | Remaining acceptance work |
|---|---|---|
| Discover and register | `apps/gateway/src/use-cases.ts`, `shadow-ai.ts`; shared evidence adapters | Prove discovery source coverage, repeatable imports, deduplication, ownership and promotion into a governed inventory. Separate imported evidence from autonomous discovery. |
| Connected inventory | `apps/gateway/src/lineage.ts`, agent/model/MCP registries | Verify typed dependencies, stale/deleted entities, policy inheritance and risk propagation across agent, model, tool, data and vendor relationships. |
| Assess risks and controls | `apps/gateway/src/risks.ts`, `packages/shared/src/risks.ts` | Compare contextual risk/control coverage, scoring and review lifecycle; validate recommendations against a reviewed benchmark rather than count library entries. |
| Govern and collect evidence | `apps/gateway/src/compliance-packs.ts`, workflows and approvals | Trace applicable requirement -> control -> owner -> evidence -> review. Close P1 consent/isolation/crash tests; add maintained applicability and change-impact workflows. |
| Assisted intake | `apps/gateway/src/copilot.ts` | Verify uploaded-context suggestions, usable citations/confidence, human edits, exact approved application and recovery; measure quality with adversarial and unsupported cases. |
| Vendor collaboration | `apps/gateway/src/vendors.ts` | Revalidate the internal registry; design and build scoped vendor invitations, submissions, reviewer feedback, expiration/revocation and cross-vendor isolation. Do not equate an internal registry with a vendor-facing portal. |
| Runtime oversight | `apps/gateway/src/tracing.ts`, `evals.ts`, `redteam.ts` | Verify continuous operation, drift/quality baselines, incident escalation and remediation controls; disclose scheduler-disabled, mock and live states. |
| Data protection | `packages/shared/src/pii.ts`, gateway dispatch/MCP | Finish ADR-0137 in-flight redaction, structured payloads, effective-action binding and no-unscanned-output tests. ADR-0140 is the text foundation only. |
| Integration delivery | Evidence adapters, PM adapters and ADR-0135 | Build an integration-by-integration verification matrix; evaluate SIEM delivery failures, replay/deduplication and secret-detector quality before enabling outbound blocking. |
| Report and decide | `apps/gateway/src/reporting.ts` | Verify scoped executive metrics, denominators, freshness and evidence drilldown. Show unknown/unassessed explicitly; never infer compliance from a missing finding. |

## Immediate implementation ledger

- P1: cache-hit gates and enumerated external-write emergency gates landed
  (ADR-0138/0139). Native cache identity, paused-call adapter coverage,
  explicit negative controls and OS crash/recovery still require work.
- P2: ISO 27001 partial evidence mapping landed (ADR-0134), not certification
  or a complete Statement of Applicability. Content/domain review remains.
- P2: validated text/decoded-JSON transformations and frozen original/effective
  consent preparation pass 1,085 shared tests (ADR-0140/0141). Gateway redaction
  is not publicly enabled. ADR-0143 now wires the MCP queue/consume/send path,
  strict destination-schema validation, original/effective data-scope checks,
  final admission generation checks, safe trace capture and result redaction.
  297 gateway tests passed (39 new). ADR-0144 now presents the effective action
  in Inbox, Queue and Workbench, records preview provenance/scope, preserves
  project attribution and invalidates local bulk review on binding changes.
  85 focused tests and five real browser journeys passed, including approval
  to actual MCP delivery and mobile layout/keyboard checks. This is not a
  server guarantee of human attention. ADR-0145 integrates frozen connector
  payloads, final-send admission checks and policy-change output withholding,
  including transitions from non-redact modes. 287 focused gateway tests pass,
  including 23 connector boundary tests using real loopback HTTP/webhook calls.
  This is not live-vendor coverage. Model integration, MCP mid-call transitions,
  complete final-output policy checks and bounded provider/schema handling
  remain release gates; the full feature is not done.
- Model-output blocking now covers thinking/tool-call content and callbacks,
  with 204 gateway regressions and a four-case negative control (ADR-0142).
  This closes enumerated leaks in existing block mode, not all redaction gates.
- P3: delivery/detection contract and synthetic baseline exist (ADR-0135).
  No live SIEM adapter or outbound secret-blocking deployment is claimed.

Completion requires working journeys and verified evidence for all accepted
requirements, not a marketing comparison percentage. Clarify undocumented
vendor features when primary documentation cannot establish their behavior;
continue independent implementation rather than inventing that behavior.
