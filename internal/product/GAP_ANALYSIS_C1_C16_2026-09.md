# RegulAIt vs the C1–C16 capability taxonomy (2026-09-24)

Source: a prospect-supplied vendor inventory scoring 16 competitors against a 16-capability
taxonomy. **Its §6 profiles a different buyer (GameStop); the taxonomy is generic and is what we
hold ourselves to here.** Complements
[GAP_ANALYSIS_FOUR_VENDORS_2026-08.md](GAP_ANALYSIS_FOUR_VENDORS_2026-08.md) (Holistic AI, IBM,
Fiddler, OneTrust) and [GAP_ANALYSIS_CREDO_AI_2026-08.md](GAP_ANALYSIS_CREDO_AI_2026-08.md) — five
of the sixteen vendors were already analysed in August, and the L9–L19 gap series there is still
the live vocabulary (`PENDING.md` tracks L6, L9, L11, L13, L17, L18, L19, L24–L26 as open).

**What is new in that document is the RUNTIME tier** — Airia, Runlayer, MintMCP, TrueFoundry,
Kosmoy. That is our tier, and C11/C12 are the columns that decide it.

## The matrix, in the document's own legend

| # | Capability | Verdict | The honest one-liner |
|---|---|---|---|
| C1 | Discovery / shadow AI | **P** | Evidence-ingest only. Our own payload says "nothing runs continuously, nothing is scraped, no network call is made". **MCP-blind** — zero `mcp` hits in the discovery surface. |
| C2 | Inventory / registry | **Y** | Every object type the bar names. A registry of what was REGISTERED here, not of what was discovered. No CMDB sync. |
| C3 | Agent registry | **Y** | Granted-vs-observed, never blended. Structurally stronger than the agent-card claims in the document. |
| C4 | Intake & approval | **Y** | Declarative templates, 5-dimension assignment, forced plan-only, re-review on reclassification. |
| C5 | Risk assessment & tiering | **P** | EU-AI-Act tier calculator + risk register with live evidence. No composite score (refused on purpose), no geography dimension. |
| C6 | Framework mapping | **P** | 7 packs, evidence is real SQL. But ADR-0087 **refuses** regulatory-change tracking, and every pack ships `reviewedBy: null`. Credo/IBM beat us. |
| C7 | Evidence & audit | **Y** | Hash-chained, WORM grade **read from the bucket**, offline-verifiable signed bundles. Our strongest row after C11/C12. |
| C8 | Technical testing | **P** | 13 scorers incl. groundedness and judges. **Bias/fairness is a declared slot, not a measurement**; no explainability. Holistic AI beats us. |
| C9 | Red teaming | **P** | 10 attack classes, ASR with Wilson intervals, live-verified. Grading needs a live credential; the sweep is scheduler-gated (off). |
| C10 | Runtime monitoring | **P** | Traces, cost, OTLP with no default endpoint. **The alerting half is scheduler-gated and off by default.** |
| C11 | **Inline enforcement** | **P (strong)** | ~16 refusal classes live on a fresh install; ~9 ship off. See below. |
| C12 | **MCP governance** | **P (strong)** | Per-tool authZ + audit on by default. Admission scanning off by default. **No credential brokering to upstream MCP servers at all.** |
| C13 | Vendor AI risk | **P** | Real registry with non-strippable disclaimers. No vendor-facing portal, no questionnaires, no embedded-AI-in-SaaS tracking. |
| C14 | Privacy | **P** | Detection real and enforced on every path (10 jurisdictions, ADR-0117). **DSAR / data mapping / consent linkage: zero hits repo-wide.** |
| C15 | Deployment | **Y** | Hosted/BYOC/air-gapped, air-gap code-enforced. Caveats: hosted+byoc are permissive by default; **no HA**. |
| C16 | Value / cost | **P** | Token spend is the deepest row in the product. **ROI and adoption analytics absent** — one-and-a-half of the bar's three things. |

## The four PoC acceptance criteria

| | Criterion | Live on Monday? |
|---|---|---|
| (a) | Discover an unregistered MCP server | **NO.** Discovery is MCP-blind. The registry sync pulls a public directory's catalogue — what a directory *says exists*, not what is running unregistered. **Do not let this be presented as (a).** |
| (b) | Block a policy-violating tool call | **YES** — via `POST /v1/connectors/:id/invoke`. Avery has no grant on the keyless mock `snowflake-analytics`; default-deny, audited, nothing outbound. |
| (c) | Audit record of that block | **YES** — `effect`/`ruleId`/`ruleChain`/reason, hash-chained, anchored to a real MinIO Object-Lock COMPLIANCE bucket from `docker compose up`, plus a signed export verifiable with `sha256sum`. |
| (d) | Map a use case to NIST AI RMF with evidence | **YES, with a seam to narrate.** Pack evaluation is scoped by PROJECT, not by use case; the use-case→pack preview is hard-wired to EU AI Act. Two-hop story — narrate it rather than be caught at it. |

## The demo landmine

**Do not demo anything through `/mcp/:serverId` against the seeded servers.** They point at
`http://127.0.0.1:9/` — the discard port — deliberately, and the route connects upstream at the top
of the handler *before* any tool call. It fails at connect and looks like the gateway is broken.
Stay on the connector path, or stand up a real MCP server on loopback first.

## Where we win, and where we are plainly behind

**Win:** C11 **depth** — our refusals are *bound* (to the exact arguments approved, to the policy
version signed under, to a project budget, through one shared primitive so a delegated worker cannot
bypass what a direct caller cannot). **No vendor profile in that document documents payload-bound
consent.** Also C7 evidence integrity, C16 cost-at-the-interception-point, C3 granted-vs-observed,
and C15 air-gap-by-enum.

**Behind:** C1 discovery (not close — concede and propose pairing); C12 credential brokering
(MintMCP/Runlayer/Airia); C8/C9 bias, fairness, explainability (Holistic AI, IBM); C6 pack content
and review; C13 vendor portal; C14 everything but detection. Company-level: no analyst placement, no
certifications, no HA, no reference customers.

## Ranked gaps for a security-led buyer

1. **SAP — zero code.** One incidental comment in a migration header is the only hit repo-wide.
2. **Autonomous discovery, and shadow MCP-server discovery specifically.**
3. **Credential brokering to upstream MCP servers.** `mcp_servers` has no credential column at all
   (`id`, `name`, `url`, `price_per_call_usd`, `allow_private_ranges`, admission fields — that is the
   whole table). For a buyer whose prior findings were hardcoded credentials, this is the live one.
4. Endpoint/browser/MDM visibility — nothing.
5. Our own SOC 2 / ISO — procurement gate.
6. No HA/DR for the control plane.
