# ADR-0083: First-party shadow-AI discovery — a compiled classifier over the operator's own files, still no scraper

- **Status**: Accepted
- **Date**: 2026-08-20
- **Migration**: **none.** The classifier writes through ADR-0055's existing tables
  (`shadow_ai_imports`, `shadow_ai_findings`) and its tags ride the existing `summary` jsonb —
  the same reasoning ADR-0071 §6 gave for declining its budgeted migration.
- **Driver**: [GAP_ANALYSIS_CREDO_AI_2026-08.md](../product/GAP_ANALYSIS_CREDO_AI_2026-08.md)
  gap **L4** — *"we cannot answer 'what AI is running here that never touched the gateway?'
  without a third-party feed."* The gap doc said *"revisit only with a concrete customer pull"*;
  **the owner directed building L4 on 2026-08-20, overriding that defer note** — recorded here
  so the decision trail does not read as drift.
- **Extends**: [ADR-0055](0055-shadow-ai-discovery.md) (the evidence pipeline, the admin
  catalogue, severity/confidence — all unchanged and still the ONLY path to a finding),
  [ADR-0071](0071-shadow-ai-format-adapters.md) (the adapter posture this EXTENDS AND DOES NOT
  REVERSE — see §1), [ADR-0068](0068-redteam-depth.md) (the compiled-in, versioned, frozen
  corpus pattern the catalogue copies deliberately).

## 1. Extension, not reversal — state it before anything else

ADR-0071 refused vendor-named scrapers and shipped format adapters instead, because RegulAIt
sits on no network path, holds no CASB credential, and a governance product that quietly
sniffed a customer's traffic would be the thing it exists to prevent. **Every word of that
stands.** This slice ships:

- **No scraper.** There is still no vendor-named integration and no code that fetches anything.
- **No collector.** Nothing runs continuously, on a schedule, or on anyone's endpoint.
- **No phone-home.** The catalogue is compiled into the build; classification is a pure
  function; no inventory of a customer's AI usage can leave the box (BYOC/air-gap intact).

What is new is **first-party classification**: previously, turning a DNS log or a
`package.json` into evidence required the operator to know which lines mattered. Now RegulAIt
answers *"which of these names are AI providers, and which of those does my own gateway already
front?"* — over text the operator pastes, on the operator's initiative, and nothing else.

## 2. The compiled catalogue (`SHADOW_AI_CATALOG_V1`) — the ADR-0068 corpus pattern

`packages/shared/src/shadow-discovery.ts` ships **81 frozen signatures** (37 endpoint, 44
SDK/package): provider API endpoints (api.openai.com, api.anthropic.com,
generativelanguage.googleapis.com, `bedrock*.amazonaws.com`, `*.openai.azure.com`,
openrouter.ai, api.groq.com, api.together.xyz, …), consumer web apps (chatgpt.com, claude.ai,
gemini.google.com, …), and SDK names across npm/PyPI/Go modules (openai, `@anthropic-ai/sdk`,
`@langchain/*`, `langchain-*`, litellm, llama-index, transformers,
github.com/sashabaranov/go-openai, …). Each entry: stable `id`, `kind` (endpoint|sdk),
`pattern`, `provider`, `notes`.

- **Versioned and frozen** exactly like the red-team corpus: `SHADOW_AI_CATALOG_VERSION = 1`,
  the array deep-frozen, and the shared suite pins the **entry count AND a SHA-256 content
  hash** — any edit fails a test loudly. A result tagged `catalog v1` means the same thing
  forever; extending detection is a v2 alongside v1, never an edit.
- **No regex from data** (ADR-0055's rule, applied to the catalogue too): matching is
  character comparison — exact, dot-boundary suffix (`openai.com` matches `api.openai.com`,
  never `notopenai.com`, and nothing matches `api.openai.com.evil.net`), or ONE literal `*`
  split into a startsWith/endsWith pair. Most-specific-wins deterministically, so
  `api.perplexity.ai` reports the API entry and not the consumer-web zone.
- **Compiled from this project's own knowledge**, not scraped, and the honesty is in the
  schema: every response carries the sentence that the catalogue is *inherently incomplete and
  dated* — it names the providers its authors knew of on its freeze date.

## 3. Two catalogues, two jobs — the load-bearing distinction

ADR-0055's `ai_endpoint_signatures` table stays the deployment's ONLY detection surface:
**"detection is data" is untouched, and remains tested** — empty that table and nothing is
found, through this route too. The compiled catalogue does a different job: it **triages**
operator input (which lines even name an AI provider) and **suggests**. A compiled hit the
admin catalogue does not know ingests as an **unmatched observation producing NO finding**, and
comes back named in `deploymentCatalogueGaps` with the row that would close it — suggestion,
never promotion. The gateway suite proves it end-to-end with api.groq.com (in compiled v1, not
in the admin seed): shadow-classified, forwarded, unmatched, zero findings, named as a gap.

## 4. The routes — a third front door on THE ONE PIPELINE

The routes live in `apps/gateway/src/shadow-ai.ts` rather than a new module, **because that is
where ADR-0071 put the pipeline**: `processEvidenceImport` is one closure with (previously) two
front doors, and a third front door in a separate file would have meant either exporting the
pipeline or duplicating it. Both new routes are admin-only through the default-deny gate and
registered in the ADR-0053 registry.

- **`GET /v1/shadow-ai/discovery/catalog`** — the frozen v1 entries, plus **this deployment's
  governed hosts with reasons**, plus the posture and limits sentences verbatim.
- **`POST /v1/shadow-ai/discovery`** `{sourceKind, content, subject?, mode}` —
  `dns_log` / `proxy_log` (generic line scanning: every dotted, lettered, non-IP token is a
  host candidate; attribution deliberately NOT guessed) and `package_json` /
  `requirements_txt` / `go_mod` (real manifest parsers; a non-JSON package.json refuses the
  whole input with a `refused` ledger row and an audit deny, ADR-0071's posture). Every
  candidate classifies as **`shadow`** (compiled hit the gateway does not front),
  **`governed_via_gateway`**, or **`unmatched`** (counted and sampled, never ingested, never
  listed in full). On `apply`, ONLY shadow candidates become evidence rows — `egress_log` rows
  (host + aggregated occurrence count + the operator's optional `subject` label as
  sourceIdentity) or `code_scan` rows (`subject` required: a finding without a repo points at
  nothing) — and go through `processEvidenceImport` unchanged: same escalation screen
  semantics, same dry-run/apply split, same rule ids, same audit. The discovery tags
  (`catalogVersion`, `sourceKind`, matched signature ids, the governed list) ride the import
  row's `summary.firstPartyDiscovery` and the audit detail; `source` is
  `first_party_discovery:v1:<sourceKind>`.
- **Retention**: the pasted content is **never persisted** — only its SHA-256 fingerprint, the
  bounded classification summary and any evidence rows survive the request, and the response
  says so (`rawContentStored: false` + a retention sentence). The suite asserts the import
  row's summary does not contain the raw log text.
- **Bounds**: `EVIDENCE_MAX_BYTES` on the text, `EVIDENCE_MAX_ROWS` on forwarded rows
  (aggregation per distinct host/package makes the practical bound the catalogue size), all
  response lists bounded. Fastify's own 1 MB body limit sits in FRONT of the 2 MB route wall —
  which makes the route wall defence-in-depth, the same pre-existing situation as
  ADR-0055/0071's own walls (and the transport 413 surfaces as a 500 through the app's generic
  error handler today; pre-existing, gateway-wide, not changed from inside this slice).

## 5. `governed_via_gateway` — the honest core, and exactly what it claims

Filing a hit on api.anthropic.com as a shadow finding, in a deployment whose own gateway
dispatches to api.anthropic.com all day, would **manufacture findings** — the sanctioned
traffic IS what the log shows. So the classifier computes, per request and from live
configuration only, the hosts this gateway legitimately fronts:

- stored **platform model credentials** (their `baseUrl` override, or the provider's compiled
  default endpoint from ADR-0062's `defaultBaseUrlFor`, including the same env-var base-URL
  reads the SDK makes);
- **users' BYO credentials** (same computation per provider);
- the **env-var credential fallback** where org settings allow it and the key is present;
- **enabled custom providers** (which also lets an in-house vLLM host the compiled catalogue
  has never heard of classify as governed — the deployment's own configuration recognises it).

Deliberately NOT consulted: `egress_allow_hosts`. That table answers "may this box reach X"
for connectors/git/Slack; using it here would launder ordinary egress permissions into
"governed AI".

**The label is deliberately a weaker claim than it sounds, and the reason strings say so**: it
means *this deployment is configured to reach this host, so the hit cannot be assumed shadow* —
a log line cannot tell gateway traffic from a rogue laptop's. And an **SDK is never labelled
governed**: a manifest cannot say whether the dependency points at the gateway's compat
endpoint or straight at the vendor, so the undecidable case stays shadow rather than being
guessed away.

## 6. SPA

`ShadowAiPage.tsx` gains a **"First-party discovery (classify what you already hold)"** card
between the ADR-0071 raw-import card and the row-shaped import: source-kind select, subject,
paste box → **Classify (writes nothing)** → the three-way split as stat tiles + tables (shadow
hits with their signature ids; governed hosts with the configuration that fronts each; the
bounded unmatched sample) → **Confirm ingest of shadow rows** (disabled until a classification
exists and shadow > 0) → ingest summary. The posture, limits and retention sentences are
printed verbatim from the API, and the catalogue-gap warning renders with the hosts it names.

## Alternatives rejected

- **A scraper/collector after all ("just poll the firewall API").** Rejected — reverses
  ADR-0071 for the exact reasons it gave; breaks BYOC/air-gap; puts RegulAIt on a network
  position it disclaims.
- **Let the compiled catalogue mint findings directly.** Rejected — it would break ADR-0055's
  tested "detection is data" invariant and make an un-editable, release-bound list the
  detection surface. Compiled hits suggest; the admin catalogue decides.
- **Seed the compiled entries into the admin catalogue instead of a second list.** Rejected —
  ADR-0055's seed is editable/deletable data, which is its point; a finding tagged with a
  signature that an admin can rewrite afterwards is not a stable provenance claim. The frozen
  catalogue exists precisely to be citable (`catalog v1`, hash-pinned).
- **Ingest governed hits too, labelled.** Rejected — a governed hit is not evidence of shadow
  AI, and rows in a shadow-findings ledger get read as findings whatever the label says. The
  classification response is where the governed list lives.
- **Guess source identity / timestamps out of generic log lines.** Rejected — ADR-0071 refuses
  exactly this; a generic scanner that guessed the source column would silently invent egress
  from a machine that made none. Attribution is an operator-asserted `subject` or nothing, and
  the real grammars (with per-row identity and timestamps) remain the adapters' job.
- **A new gateway module for the routes.** Rejected — the pipeline is a closure in
  `shadow-ai.ts` and ADR-0071's structural claim is "front doors on ONE pipeline"; a new
  module would need to export or duplicate it.

## Honest limits — read before citing

1. **The catalogue is inherently incomplete and dated.** 81 entries, frozen 2026-08-20, from
   this project's own knowledge; a provider founded next week — or simply not thought of — is
   invisible to this classifier. The admin catalogue (data, no release needed) is the
   correction path, and `deploymentCatalogueGaps` exists to feed it.
2. **A hit proves an artifact MENTIONED a provider** — a resolved name, a declared dependency —
   never that traffic flowed, how much, or who sent it. An SDK hit is a capability
   (ADR-0055's `low` tier), not an act.
3. **Only the generic shapes are read**: DNS/proxy log LINES and three manifest formats. No
   CASB export, no SSO report, no lockfiles (package-lock.json, poetry.lock, go.sum), no
   Cargo.toml/Gemfile/pom.xml/csproj, no boto3-based Bedrock usage (indistinguishable from any
   other AWS dependency). The line scanner reads no timestamps and attributes nothing — real
   grammars belong to the ADR-0071 adapters.
4. **Encrypted and DoH traffic is invisible**, as is anything that never crossed the exported
   log. Coverage remains exactly what the operator pasted.
5. **`governed_via_gateway` is a configuration claim, not a traffic claim** (§5). It cannot
   prove the observed hit went through the gateway; conversely a governed-host hit from a
   machine that bypasses the gateway is real shadow usage this feature will not flag.
6. **Nothing runs continuously.** Operator-initiated only; there is no scheduler, no watch
   mode, no delta between two pastes.
7. **The classifier inherits ADR-0055's pipeline behaviours**, including re-import doubling
   `observationCount` (ADR-0071 disclosure 6) — pasting the same log twice inflates the count
   on the same finding.
8. **Non-vacuity was proven the M-002 way, both halves**: governed check forced constant-true
   → exactly the shadow/governed split tests reddened (3 shared + 3 gateway); matcher forced
   everything-unmatched → 14 shared + 5 gateway reddened. Both probes reverted by reversing
   the exact edit.

## Consequences

- **Files**: `packages/shared/src/shadow-discovery.ts` (+ unit suite, 28 tests),
  `apps/gateway/src/shadow-ai.ts` (governed-host loader + two routes),
  `apps/gateway/src/shadow-discovery.test.ts` (11 tests),
  `apps/gateway/src/openapi-registry.ts`,
  `apps/web/src/views/admin/governance/ShadowAiPage.tsx`.
- **Migration**: none. The next available migration number remains **0088**.
- Nothing here takes a `prod`/`production` designation.
