# RegulAIt vs Credo AI — where we are lacking (2026-08-15)

Owner asked: *"can we see where we are lacking from this tool"* (credo.ai).
Companion to [MARKET_ANALYSIS_2026-08.md](MARKET_ANALYSIS_2026-08.md) §1.3, which carried one
paragraph on Credo; this goes feature-by-feature in their direction.

**Sourcing honesty.** credo.ai is egress-blocked from this workspace (same as atlasapp.ai in the
market pass), so Credo's side is built from search-indexed copies of their own pages and dated
third-party comparisons, all retrieved 2026-08-15: Arthur's 2026 governance-platform guide,
Kovrr's 2026 comparison, Kosmoy's alternatives page, the AgentID-vs-Credo comparison
(getagentid.com — a competitor of theirs; treat its limitation claims as adversarial but
specific), Gartner Peer Insights, and Credo's blog posts on GAIA GA and their Gartner/Forrester
mentions. Nothing below is from a live read of credo.ai itself. RegulAIt's side is from this
repo, by ADR.

**Category note first, because it frames every row.** Credo is GRC-first: registry, risk,
policy, evidence, boardroom. Their runtime story (public preview since 2025-09, expanded 2026)
is **post-hoc trace evaluation** — "evaluates agent traces and applies policy after behavior is
observed, not at connection time … no inline MCP gateway … no per-action permissions inside
tools; CI/CD and API-gateway enforcement is on the public roadmap" (AgentID comparison,
2026-08-15). RegulAIt is the inverse: enforcement-first, GRC-thin. The gaps below are the
GRC-shaped half we lack; the enforcement half they lack is listed at the end for balance.

## Where we are lacking, ranked

### L1 — A pre-build use-case intake and approval front-door
Credo's governance starts BEFORE anything runs: propose an AI use case, GAIA pre-fills the
intake questionnaire from uploaded context (with confidence levels and citations), risk
scenarios and controls get recommended, and the use case is approved into the registry.
RegulAIt starts governing at the first call or the first change workflow — there is no "propose
an AI use case" object, no intake questionnaire, no approval that *creates* the governed thing.
Our workflow engine (pillar 2) could host exactly this as a template — intake → artifact
(questionnaire) → sign-off is literally our §2 shape — but nothing ships it. **Buildable now,
on existing rails; the highest-leverage Credo-shaped gap.**

### L2 — A risk register with a named risk/control library
Credo carries a curated agentic risk library (tool misuse, scope drift, inter-agent risk),
org-specific risk scenarios, and control mappings refined over four years. We MEASURE
relentlessly — red-team ASR (ADR-0068), evals (ADR-0067), guardrail verdicts (ADR-0042), model
cards (ADR-0045) — but there is no RISK object: nothing links a measurement to a named risk
scenario, a mitigating control, an owner, and a residual-risk acceptance. Our evidence is
stronger than theirs (query-backed, ADR-0058); our vocabulary for talking about it as *risk* is
absent. **Buildable; medium effort; makes the evidence legible to a GRC buyer.**

### L3 — Pack breadth and curation depth
We already have what most comparisons assume we lack: ADR-0058 regulatory compliance packs —
eu-ai-act, nist-ai-rmf, iso-42001, hipaa, pci-dss, finra — where **evidence is a query, never a
tick-box** (every control is a SELECT over ledgers this deployment writes; seed the evidence
and the control goes green, delete it and it goes red), packs cascade-wired via `cascadeTag`,
and a stated legal disclaimer. What Credo has that we lack: four years of curated control
libraries, a Governance Knowledge Graph crosswalking regulation ↔ business context ↔ config, a
SOC 2 pack, and a regulatory-affairs brand that makes their mappings credible to auditors. Our
lack here is **breadth and curation, not mechanism** — our seeded packs are examples with a
disclaimer, not maintained regulatory products.

### L4 — Shadow-AI *discovery* (we only ingest evidence)
Credo auto-discovers AI systems, agents and shadow AI across the enterprise and classifies
them. ADR-0071 deliberately ships format ADAPTERS (ingest someone else's discovery evidence)
and refuses vendor-named scrapers. That posture is coherent with BYOC/air-gap, but the lack is
real: we cannot answer "what AI is running here that never touched the gateway?" without a
third-party feed. **Partly deliberate; revisit only with a concrete customer pull.**

### L5 — Vendor / third-party AI risk portal
Credo's Vendor Portal collects AI-risk evidence from vendors, tracks third-party AI in the
registry, and applies policy packs to them. RegulAIt has nothing vendor-risk-shaped — our
vendor story is COST (ADR-0069/0076 imports), not risk. **Honest lack; questionable fight for
us** — it is procurement GRC, far from the call plane where we win. Defer unless a buyer says
otherwise.

### L6 — A governance copilot (their GAIA)
GAIA is GA: reads context, pre-fills governance artifacts, recommends risks/controls/mappings,
now with remediation agents and a previewed MCP server. We have ChatOps and a Copilot page, but
no assistant over OUR OWN governance data (packs, risks, audit, cascade). Also
**credential-blocked**: shipping this honestly requires the live model provider the owner keeps
parked — it would be mechanism-without-instrument today.

### L7 — Standing agent dependency graph as inventory
Credo maps dependency graphs across multi-agent systems as a registry view. Our DAGs are
per-run, and lineage (ADR-0070 spans + lineage edges) is per-trace; there is no standing
"agent X uses tools Y,Z and feeds agent W" inventory view. **Small-to-medium; our data already
contains it** — it is an aggregation over grants + run history, not new collection.

### L8 — Boardroom posture reporting
Credo's output is board-ready governance reports. We have scorecards, the report ledger, CSV
exports, dashboards — operator-shaped, not board-shaped. A one-page executive posture view
(packs %, open risks, ASR trend, spend vs budget, incidents) is presentation work over data we
already hold.

## Where they are lacking (the other direction, for balance)
Everything the market analysis already recorded, sharpened by their own comparison field:
**no inline enforcement** (post-hoc traces; no connection-time decisions; no per-action tool
permissions; CI/CD + gateway enforcement roadmap-only), **no cost plane** (no per-project spend
attribution, budgets, or optimization), **no SDLC** (no PR-shaped workflow, no plan-only gate,
no deploy/rollback governance), **no air-gap/BYOC self-hosted runtime posture** of our kind,
and their audit trail is not tamper-evident in the ADR-0060 sense as far as any source shows.
A Credo customer still needs something like us at the call plane; we still look thin to their
buyer. The overlap point — where deals will actually collide — is the **compliance cascade +
packs**: we are the only side whose pack controls are enforced and query-evidenced rather than
attested.

## What to do about it (recommended, not started)
1. **Use-case intake template + registry object (L1)** — pillar-2 rails, no new kernel.
2. **Risk register linking existing measurements to named risks/controls (L2).**
3. **Agent dependency inventory view (L7)** — cheap, demo-visible.
4. **Exec posture report (L8)** — presentation over existing data.
5. Defer L4/L5 without customer pull; L6 waits on a model credential; L3's curation is a
   content/partnership problem more than an engineering one.
