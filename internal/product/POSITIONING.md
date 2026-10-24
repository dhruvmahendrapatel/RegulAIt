# RegulAIt — Positioning & Placement (2026-08-15)

Owner directive: build what we lack against the GRC tier, **and** present and place better than
they do. This document is the placement half. It is derived from
[MARKET_ANALYSIS_2026-08.md](MARKET_ANALYSIS_2026-08.md) and
[GAP_ANALYSIS_CREDO_AI_2026-08.md](GAP_ANALYSIS_CREDO_AI_2026-08.md); every proof point cites a
shipped ADR, because our positioning discipline is the product's own discipline: **no claim
without evidence behind it.**

## 1. The category claim (one sentence)

> **RegulAIt is AI governance that enforces itself** — the policy pack, the approval, and the
> budget are not documents about your AI; they are the control plane your AI actually runs
> through.

Why this framing wins the two-front war the market analysis mapped:
- The **GRC tier** (Credo, Holistic, watsonx.governance, ServiceNow) governs *records* of AI.
  Credo's own runtime story is post-hoc trace review; inline enforcement is on their roadmap.
  They cannot say "this control is enforced" — we can, per control, with a query as evidence.
- The **gateway tier** (LiteLLM, Portkey-in-PaloAlto, Cloudflare) enforces calls but has no
  compliance vocabulary — no packs, no cascade, no audit-ready evidence. They cannot say "this
  enforcement satisfies EU-AI-Act art. 12" — we can, with the ledger row that proves it.

The claim in negative space, which is just as important: **we do not sell attestation.** A
control in RegulAIt goes green only when a SELECT over our own ledgers says so (ADR-0058:
"evidence is a query, never a tick-box"). Competitors' tick-boxes are our best demo moment.

## 2. Message map by audience

| Audience | Their pain | Our line | Proof (shipped) |
|---|---|---|---|
| **CISO / platform owner** | Agents and copilots are running; nothing stands between them and data/spend | "Default-deny gateway on every model, tool and connector call — per-user, per-action, pre-call. Not trace review after the fact." | Pillars 1/3; PII floor (ADR-0021 am.); guardrails (0042); egress guard (0043); MCP per-action permissions |
| **GRC / compliance lead** | Evidence collection is manual; governance tools don't touch runtime | "One tag cascades into enforcement — required stages, PII mode, retention — and every pack control is evidenced by a query, not a questionnaire." | Cascade (§8.3, demo-seeded per ADR-0077); packs (0058); tamper-evident audit + WORM anchor (0060) |
| **Eng lead / AI platform team** | Governance tools slow builders down and can't see cost | "Plan-gated, PR-shaped delivery with per-project spend attribution and automatic token optimization — governance that ships code, not tickets." | Workflow engine (pillar 2, plan-only ADR-0079); cost plane (0069/0076); optimizer (pillar 6); PM sync (pillar 8) |
| **Regulated / sovereign buyer** | Cloud governance SaaS can't enter the building | "Air-gapped and BYOC first: signed offline updates, self-hosted WORM audit, no phone-home." | ADR-0041/0062/0063; MinIO Object Lock in compose (0060 am.); offline license (0052) |

## 3. Against each competitor class, one honest line each

- **vs Credo AI**: "Credo tells you what your policy says. RegulAIt is where your policy runs."
  (Their intake/registry/risk vocabulary is real and we are building it — L1/L2 in flight — on
  top of enforcement they do not have.)
- **vs Holistic / watsonx / ServiceNow**: "Governance platforms added agents to their
  inventory. We built the inventory into the gateway the agents already call through."
- **vs LiteLLM / Portkey / Cloudflare AI Gateway**: "A gateway with a compliance spine: packs,
  cascade, evidence, WORM audit — the parts a proxy cannot retrofit."
- **vs GitHub / Microsoft agent controls**: "Their controls end at their platform's edge. Ours
  are vendor-neutral by construction — any model, any cloud, any git host, any PM tool."
- **vs building it in-house**: "Every hole we closed is a test that stays: 2,100+ enforcement
  tests, adversarial by method, mistakes ledger public in the repo."

## 4. The honesty thread IS the brand

The repo's discipline — refuse rather than fake, disclose residual windows, observed-not-
configured tamper resistance, `mistakes.md` in the open — is not internal hygiene; it is the
most differentiated marketing asset we have in a category drowning in attestation. Placement
rule: **every public claim links to the ADR and the test that pins it.** A prospect who diffs
our claims against our repo finds MORE than we said, never less. No competitor in either tier
can copy this without rebuilding their culture.

## 5. Placement plan (where we show up, in order)

1. **The demo IS the placement.** `docker compose up` → the cascade headline (ADR-0077): a tag
   forcing a sign-off, blocking an SSN live, flooring retention — in two minutes, no cloud
   account, no sales call. GRC vendors demo dashboards; we demo enforcement. Keep investing
   here first; it is the cheapest distribution we own.
2. **README / landing as the shop window** — leads with the category claim and the 2-minute
   proof, not a feature list. (Updated this pass.)
3. **Comparison content** — "RegulAIt vs the GRC tier" and "vs the gateway tier" pages built
   from the two analysis docs, each claim ADR-linked. Search intent to own: *"AI governance
   enforcement"*, *"EU AI Act runtime enforcement"*, *"Credo AI alternative with enforcement"*,
   *"LLM gateway with compliance packs"*, *"air-gapped AI governance"*.
4. **In-product presentation** — the exec posture one-pager (L8, queued) so a champion can put
   OUR screen in front of THEIR board; today that slot belongs to the GRC tier by default.
5. **Proof artifacts** — the delegation conformance table (ADR-0078), the pack scorecards, and
   the audit-verify disclosure are publishable as-is; they read like documentation and work
   like sales collateral.

## 6. What we will NOT claim (standing)

No SOC 2 / ISO certification (none held); no "AI-powered governance assistant" while the model
credential is parked (L6); no live-instrument claims for judge/probe/OTLP paths until one real
provider is connected; nothing "production" without the owner's explicit sign-off (CLAUDE.md
guardrail). The absence list is part of the positioning: buyers in this category are audited on
their vendors' claims, and we are the vendor whose claims audit clean.
