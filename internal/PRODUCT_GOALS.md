# RegulAIt — product goals

One page on where the product is going. It links the source documents rather than copying them; when a source changes,
the source wins. Lines marked **(inferred)** are this page's reading of the sources, not a statement found in them.

Last checked against the sources: 2026-10-24.

## Mission

**AI governance that enforces itself.** The policy pack, the approval and the budget are not documents about a
customer's AI; they are the control plane that AI actually runs through ([POSITIONING §1](product/POSITIONING.md)).
The eight pillars are first-class, non-optional architecture, not enterprise upsells, and every feature runs through
them ([VISION](product/VISION.md), [ADR-0008](decisions/0008-eight-p0-pillars.md)).

In one line **(inferred)**: a provider-agnostic control plane through which every AI agent, model, connector and MCP
call runs, governed per user, routed through approved workflows, attributed to a project's budget and evidenced in
one audit trail.

The product never hard-locks to one vendor: any model, AWS/Azure/GCP or on-prem, four git providers, six PM-tool
adapters ([CLAUDE.md](../CLAUDE.md), "Provider-agnostic by design").

## The eight pillars and where each stands

All eight have a working, deployed slice, which "does not mean the pillars are complete"; the deployment is dev-grade
([ROADMAP §1](product/ROADMAP.md), [ADR-0013](decisions/0013-dev-app-deploy-single-ec2-compose.md)). EPIC-01 to EPIC-06
are complete ([STATE](memory/STATE.md), epics table).

| # | Pillar | Status today |
|---|---|---|
| 1 | Per-user governance and access control | MVP shipped (EPIC-02) with strict defaults ([ADR-0181](decisions/0181-strict-defaults.md)); IDE interception shipped. Model dispatch in the demo runs on a mock because no live model key is connected ([PENDING](product/PENDING.md) P1). |
| 2 | Multi-stage workflow engine | MVP shipped (EPIC-03): declarative templates, stage machine, executable git/build/check/deploy/rollback stages, six-dimension assignment; all four git providers verified. |
| 3 | Infra ops, compliance cascade, BYOC/air-gapped | Spine shipped; air-gap egress is enforced in code ([ADR-0062](decisions/0062-mode-scoped-egress.md)). Live infra and deploy clients exist but are flag-gated off and default to dry run ([ROADMAP](product/ROADMAP.md) Batch C, "partial"). |
| 4 | Shared Projects with cross-team context | Shipped in the EPIC-02 MVP. No pillar-specific open item found **(inferred)**. |
| 5 | Cost-per-project dashboard | Shipped in the EPIC-02 MVP; measured and estimated spend are kept apart. Invoice import and reconciled billing are open, and pillar-6 savings semantics wait on an owner decision ([PENDING](product/PENDING.md) §6). |
| 6 | Token and cost optimisation | MVP shipped (EPIC-04): all seven techniques live plus a batching estimator; savings measured. |
| 7 | Multi-agent orchestration | MVP shipped (EPIC-05): task DAG, governed worker dispatch, transitive entitlement and budget ceilings; delegated workload identity is live ([ADR-0188](decisions/0188-batch6-agent-workload-identity.md)). |
| 8 | PM-tool integration | MVP shipped (EPIC-06): full adapter matrix, approval mirroring, decision records, inbound sync. Proven against fake servers only; the work-item importer is not built ([PENDING](product/PENDING.md)). |

Across the pillars, shadow-AI active discovery is built and merged
([ADR-0195](decisions/0195-shadow-ai-active-discovery.md)); the endpoint agent cannot run live until a signed collection
pack exists ([DEMO_SCRIPT](product/DEMO_SCRIPT_2026-11-01.md), "Rules").

## Near-term goal: the demo (2026-11-01 and 2026-11-03)

Source of truth: [ADR-0197](decisions/0197-demo-2026-11-01-plan-and-owner-decisions.md),
[DEMO_SCRIPT_2026-11-01](product/DEMO_SCRIPT_2026-11-01.md), [DEMO_RUNBOOK](product/DEMO_RUNBOOK.md),
[DEMO_TALK_TRACK_2026-11-01](product/DEMO_TALK_TRACK_2026-11-01.md),
[DEMO_PRESENTER_NOTES_2026-11-01](product/DEMO_PRESENTER_NOTES_2026-11-01.md),
[DEMO_QA_2026-11-01](product/DEMO_QA_2026-11-01.md) and
[DEMO_SCREENS_QA_2026-11-01](product/DEMO_SCREENS_QA_2026-11-01.md).

- **Dates:** code freeze Thu 2026-10-29 (only demo-blocker fixes merge after it); internal run-through Sun 11-01;
  external demo Tue 11-03.
- **Audience:** a security-led enterprise buyer (CISO, CRO, head of AI governance, platform security)
  ([DEMO_QA](product/DEMO_QA_2026-11-01.md)). No organisation is named **(inferred: a prospect)**.
- **Shape:** about 25 minutes plus 10 of questions, one journey in three acts: *find it → bring it in → govern it*.
  Beats run from discovery (S1–S4) through use-case record, independent review, a simulated enforcement decision, the
  deploy gate, trust dashboard, alerts, regulatory intelligence and evidence (G1–G8). S3 and G2 (separation of duties)
  are never cut.
- **Live and fallback:** 11-03 runs on the hosted dev instance against real, read-only sandbox accounts; 11-01 runs its
  state-changing beats on the `demo:prepare` laptop stack. The close says unprompted that the model is a mock, the
  usage was planted and the replays were recorded.
- **Readiness work:** the full feedback scan and design lanes are merged; lane U1 was in its last recheck on 10-24
  ([STATE](memory/STATE.md), top paragraph; [session record](memory/sessions/2026-10-24-session-02.md)).
- **Owner actions before the demo:** required checks on main for the freeze (FS-21), supply the suite rules (FS-26),
  rebuild both demo hosts, set the laptop to the pinned Node, the 10-29 freeze dispatches, and no infrastructure apply
  to the dev host before 11-03 ([STATE](memory/STATE.md); [DEMO_RUNBOOK §7](product/DEMO_RUNBOOK.md)).

## Next goals after the demo

In rough order **(inferred from the sources' own ordering)**:

1. **Tear down and unfreeze.** Remove the demo sandbox accounts and the freeze branch rule, restore the power schedule
   and backup timer ([DEMO_RUNBOOK](product/DEMO_RUNBOOK.md), "After 11-03";
   [DEMO_TEARDOWN](../docs/deployment/DEMO_TEARDOWN.md)); revert the freeze-week CI caps
   ([ADR-0198](decisions/0198-freeze-week-ci-settings.md)).
2. **Clear the held dependency work.** The Dependabot queue (#515–#543), the framework major upgrades (#506, #507), and
   the emergency-patch follow-ups: engine closure audits on every PR, removing the temporary overrides
   ([ADR-0199](decisions/0199-emergency-patching-2026-10-23.md), "Follow-ups").
3. **Finish the design-scan follow-ups.** Shared visually-hidden utility, kit header announcement, focus handling in
   the action hook, consistent audit-effect casing, sidebar naming, a wider vendor-name guard, and theme saved to the
   account with an org default and lock ([session record](memory/sessions/2026-10-24-session-02.md), "Open";
   [STATE](memory/STATE.md), known follow-ups).
4. **Make the product real for a first pilot.** Connect a live model provider (highest impact per minute), sign the
   endpoint collection pack, verify PM adapters against a live instance, then real BYOC execution once a named customer
   account exists ([PENDING](product/PENDING.md), "Suggested order for a first pilot"; [ROADMAP](product/ROADMAP.md)
   Batches C and G).
5. **Enterprise readiness.** High availability, certification evidence (SOC 2, ISO 27001, ISO 42001), the release-key
   ceremony, content-column secret scrub, pen test and the other owner-gated items
   ([PENDING](product/PENDING.md) P2, P3, S3, S6; [DELIVERY_PLAN](product/DELIVERY_PLAN_2026-10-06.md), "Owner-gated").
   The remaining tails of the ADR-0183 delivery batches belong here; the ledger should be reconciled first, because
   STATE records most of those batches as merged **(inferred)**.
6. **Breadth.** PM work-item importer ([ADR-0054](decisions/0054-onboarding-migration.md)), SDKs beyond TypeScript
   ([ADR-0053](decisions/0053-public-api-sdks.md)), bias measurement ([ADR-0045](decisions/0045-model-risk-management.md)),
   the remaining governance-parity "partial" rows ([ROADMAP §9](product/ROADMAP.md)), marketplace listings, a docs
   portal and in-product support ([PENDING](product/PENDING.md) §6).

## Explicitly not goals

- **No production without sign-off.** Nothing is designated or deployed as production without the owner's explicit
  sign-off in that session ([CLAUDE.md](../CLAUDE.md), standing guardrail; [ROADMAP](product/ROADMAP.md) Batch F).
- **Our AWS-only dev infra is not a product constraint.** It is build tooling, not a gap
  ([ADR-0002](decisions/0002-two-account-aws-foundation.md), [ADR-0003](decisions/0003-terraform-over-cloudformation.md)).
- **We do not sell attestation** ([POSITIONING §1](product/POSITIONING.md)).
- **Deliberate refusals**, reopened only on the owner's pull ([PENDING](product/PENDING.md), "Deliberate refusals"):
  identity fabric and IGA discovery (we integrate with IGA, we do not compete with it), vendor-named shadow-AI
  scrapers, a regulatory-intelligence feed business, non-gateway ML monitoring and explainability, and a classical-ML
  bias-audit business.
- **No traffic sniffing for shadow AI**, no claim of automatic remediation and no claim of a complete inventory
  ([ADR-0195](decisions/0195-shadow-ai-active-discovery.md); [DEMO_SCRIPT](product/DEMO_SCRIPT_2026-11-01.md),
  "What is mock vs. live").
- **Multi-tenancy in one deployment** waits until a second customer needs it
  ([DELIVERY_PLAN](product/DELIVERY_PLAN_2026-10-06.md), batch 6.4) **(inferred as a non-goal for now)**.
- **No refactoring before the demo** only to meet the engineering guidelines
  ([ADR-0200](decisions/0200-engineering-best-practice-guidelines.md)).
- **No re-solving solved problems** and no copyleft or source-available licences in shipped code
  ([ADR-0176](decisions/0176-open-source-first.md)); nothing ships insecure by default
  ([ADR-0180](decisions/0180-continuous-assurance-strict-by-default.md)).
