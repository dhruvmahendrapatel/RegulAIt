# ADR-0055: Shadow-AI Discovery — inventory ungoverned LLM usage and pull it into governance

- **Status**: Accepted
- **Date**: 2026-08-01

## Context

Everything RegulAIt governs today assumes the AI call already came *to us* — through
`executeGovernedDispatch`, the compat surfaces (ADR-0020), or the MCP proxy (ADR-0024). That is
the correct enforcement boundary, but it has a blind spot that is also the single biggest reason
an enterprise buys a governance layer at all: **the AI usage that never touches our gateway.** A
developer pip-installs `openai` and hard-codes a key. A team wires a SaaS tool with a built-in
"AI assistant" that calls a model provider directly. Someone pastes a customer record into a
consumer chatbot in the browser. None of that appears in `audit_log`, none of it is metered in
`usage_events`, and none of it is subject to a single per-user rule from
GOVERNANCE_LAYER_SPEC §2–§4. A governance product that can only see the traffic already routed
through it is preaching to the converted.

This is also our commercial wedge. "You have ungoverned AI you cannot see, here is the inventory,
here is the one-click path to bring it under RegulAIt" is a **land-and-expand** motion: discovery
is the land, the per-user policy kernel is the expand. It is a fundamentally different sale from
"adopt our gateway for new projects" — it starts from the customer's existing sprawl and quantifies
it. So discovery must exist as launch-blocking scope, not a phase-2 report.

The forces in tension:

- **Coverage vs. honesty.** No discovery method sees everything. Network signals miss anything
  that egresses through a channel we do not observe; code scanning miss keys that never land in a
  scanned repo; SaaS/browser telemetry depends on an agent or integration the customer chooses to
  deploy. Overclaiming "complete AI visibility" would be the kind of dishonesty ADR-0034 and
  ADR-0035 deliberately avoid. We must ship a **coverage model**, not a coverage *claim*.
- **Privacy of the scan itself.** Reading an enterprise's repos, DNS logs, and browser telemetry
  to find AI usage is itself a high-trust, high-blast-radius data access. The discovery engine
  must be governed by the very kernel it feeds — it cannot be a privileged side-channel that reads
  everything with no audit trail. That would reproduce exactly the ungoverned-access problem it
  exists to solve.
- **Provider-agnosticism under churn.** The set of "known model-API endpoints" and model-SDK
  import fingerprints changes every month as providers launch and rename. A hard-coded endpoint
  list rots. The catalog must be a first-class, updatable, provider-neutral artifact — the same
  design posture the model-endpoint catalog already takes (ADR-0034: four wire protocols +
  admin-registered custom providers, no vendor hard-lock).

## Decision

Build **Shadow-AI Discovery** as a governed subsystem that ingests three independent signal
classes, correlates them into a deduplicated **AI-usage inventory**, and drives a **"pull into
governance" workflow** built on the existing workflow engine (pillar 2). Explicitly a
detection-and-remediation product, honest about its coverage envelope.

**1. A provider-agnostic, updatable Model-Endpoint Signature Catalog.** A new versioned catalog
(sibling in spirit to ADR-0034's endpoint catalog, sharing its no-hard-lock posture) mapping each
known model provider to: its API hostnames/domains (for DNS/egress matching), its SDK package
fingerprints (`openai`, `@anthropic-ai/sdk`, `google-generativeai`, `mistralai`, `cohere`,
`ollama`, plus the wire-protocol families ADR-0034 already models), and its API-key formats (for
leaked-secret detection). The catalog is versioned, admin-editable, and carries a provenance/
`last_updated` field per entry so a customer can see how fresh their detection surface is and add
a private/in-house endpoint. It is **data, not code** — updating detection for a new provider is a
catalog row, never a deploy.

**2. Three signal collectors, each governed.**

- **Network egress / DNS.** Reuse the egress primitives from ADR-0034 (`checkEgress`, the resolved-
  address discipline) *in reverse*: instead of blocking outbound calls to disallowed hosts, an
  optional collector ingests the customer's DNS-resolver logs, firewall/proxy egress logs, or a
  SIEM export and flags resolutions/connections to catalog hostnames. This sees *that* a host
  called a model API and roughly how often; it generally does **not** see prompt content, which we
  state plainly as both a limitation and a privacy feature.
- **Code scanning via the git-provider integration.** The `git-provider` package already reads
  repos across GitHub/GitLab/Bitbucket/Azure DevOps under the customer's own credentials. A
  read-only scanner walks connected repos for (a) model-SDK imports/dependencies matched against
  the catalog fingerprints and (b) **leaked/hard-coded API keys** matched against catalog key
  formats. A hit means "this codebase can call a model outside our gateway" — the strongest
  signal, because it names the repo, the file, and often the provider. Leaked-key findings route
  to remediation with elevated severity.
- **SaaS / browser telemetry.** An optional collector ingests signals from SaaS admin APIs (OAuth
  app grants to AI vendors, marketplace-installed AI add-ons) and, where a customer deploys it, a
  managed browser extension / endpoint agent reporting visits to known AI web apps. This is the
  lowest-coverage, highest-privacy-cost source, so it is **opt-in per source** and off by default.

**3. Correlation into one inventory.** Signals dedupe into inventory rows keyed by (team/owner,
system/repo/host, provider, first-seen, last-seen, signal-sources, estimated-volume,
governed?=false). One real usage can produce a DNS hit *and* a code hit; the inventory correlates
them rather than double-counting, and marks each row with which collectors corroborate it (a
higher-confidence row has more independent sources).

**4. The "pull into governance" workflow.** Each ungoverned inventory row gets a remediation
action that instantiates a **workflow template** (pillar 2) rather than a bespoke flow: e.g.
*rotate the leaked key → register the endpoint in the model catalog (ADR-0034) → route the app
through the compat surface (ADR-0020) → assign the owner a per-user entitlement → confirm the
next call appears in `audit_log`/`usage_events`*. The final "confirm governed" check is a real
`automated_check` stage that only passes once the traffic actually shows up on our ledgers —
closing the loop mechanically instead of on assertion.

**5. The discovery engine is itself governed.** Every scan run, every repo read, every log ingest
is a governed action written to the one `audit_log` with a `rule_id`, subject to the compliance
cascade (pillar-3 §8.3) of the Initiative it runs under, and constrained by the scanning
principal's own entitlements. There is no privileged discovery identity that reads everything
outside the kernel. Findings that contain sensitive fragments (a leaked key, a code snippet)
inherit the PII/sensitive-handling mode of their compliance classification.

**6. A confidence and severity model, not a flat alert stream.** Each inventory row carries a
confidence derived from how many independent collectors corroborate it (a leaked *and* live-called
key beats a lone vendored SDK import) and a severity derived from what the signal implies: a
hard-coded, catalog-matched **API key** is the top severity (it is both an ungoverned-usage signal
and a live credential-exposure incident, so it also routes to the git-provider's existing secret-
handling path), a confirmed DNS/egress pattern to a model host is next, and a mere SDK dependency
with no observed call is a low-severity capability flag. This ordering is what makes the inventory
actionable — a customer works the leaked-key rows first — rather than a wall of undifferentiated
hits. Severity thresholds for what auto-opens a remediation workflow vs. what waits for triage are
an `org_settings` dial (ADR-0021), under the compliance cascade's ceiling.

## Consequences

**Easier.** The product gains a concrete, quantified answer to "what AI am I not governing?" —
the highest-leverage question in the category and the wedge that turns a new-projects sale into a
whole-estate sale. Because collectors reuse existing primitives (egress guard, git-provider,
audit/usage ledgers), most of the build is correlation + catalog + workflow wiring, not net-new
infrastructure. The remediation path lands on the workflow engine, so "found it" and "fixed it"
share one audit trail.

**Harder / explicitly given up.**

- **Coverage is bounded and we say so.** Network signals need the customer to pipe us logs;
  code scanning only covers *connected* repos and misses keys injected at runtime or stored in a
  secrets manager we do not read; browser/SaaS telemetry needs an agent the customer must choose
  to deploy. We ship a per-tenant **coverage scorecard** ("N repos scanned of M connected; DNS
  ingest: on; browser agent: off") so the gaps are visible, never papered over. Discovery reduces
  shadow AI; it does not prove its absence.
- **Detection is signal, not proof of misuse.** A model-SDK import is a *capability*, not evidence
  of a policy violation; a DNS hit to a model host may be a sanctioned integration. Every finding
  is a lead for human triage, not an automatic verdict. False positives (a vendored SDK never
  called, a test fixture key) are expected; the inventory carries a disposition state
  (confirmed / sanctioned / false-positive / remediated) rather than a binary alarm.
- **The scan is a real data-access surface.** Reading repos and logs to hunt AI usage is
  privileged and could itself leak (a leaked-key finding literally contains a secret). Governing
  the engine through its own kernel mitigates but does not eliminate this; the honest posture is
  that discovery trades some scanning-surface risk for far larger shadow-usage-visibility gain,
  and both sides of that trade are audited.
- **The catalog will lag reality.** A brand-new provider is invisible until its catalog entry
  exists. Making the catalog admin-editable data (not code) minimizes the lag but cannot erase
  it; the `last_updated`/provenance fields make the staleness legible instead of hidden.

**Follow-up work.** The signature catalog format and its update/distribution mechanism (shared
with, or forked from, ADR-0034's endpoint catalog). Collector adapters as optional, individually-
gated ingestors (DNS/egress-log, git-repo-scan, SaaS/browser) so a customer runs only what they
consent to. The inventory schema and correlation/dedup keys. A "pull into governance" workflow
template shipped as a default (composing with the compliance packs, ADR-0058). The coverage
scorecard surface. And a decision on retention of raw scan findings (especially leaked-key
fragments), which should default to the shortest retention the compliance cascade permits.

---

## Amendment — 2026-08-02: implemented as an IMPORTER + ANALYZER, with no collector (migration 0068)

Implemented and accepted. What follows is the honest split between what this
release genuinely enforces and what is structural — and, most importantly,
**exactly what a customer must supply**, because the single largest gap between
this ADR as written and this ADR as shipped is that **no collector ships.**

### The correction this amendment makes to the ADR

§2 describes "three signal collectors". **RegulAIt ships none of them, and this
deployment cannot.** The control plane does not sit on a customer's network, does
not hold their DNS resolver, does not run on their endpoints, and has no browser
extension. A governance product that quietly began sniffing traffic would be the
very thing it exists to prevent — so the collectors are not merely deferred, they
are the customer's own systems by design.

What ships is the rest of the ADR: the **catalogue**, the **importer**, the
**analyzer**, the **correlation**, the **severity/confidence model**, the
**coverage scorecard** and the **inventory + disposition workflow**.

**What a customer must feed it, precisely.** `POST /v1/shadow-ai/imports` accepts
four evidence classes, each a strict, bounded row schema:

| kind | who produces it | required fields per row |
| --- | --- | --- |
| `egress_log` | their forward proxy, firewall, DNS resolver or SIEM export | `destinationHost` (host or URL); optional `sourceIdentity`, `requestCount`, `observedAt` |
| `code_scan` | their own CI repo scan (a RegulAIt scanner over `packages/git-provider` is follow-up work) | `repo` plus at least one of `packageName` / `keyFragment`; optional `path`, `keyLength`, `observedAt` |
| `saas_export` | their SaaS admin console's installed/OAuth-granted app export | `appName`, `vendorHost`; optional `grantedBy`, `installCount` |
| `self_reported` | a human | `owner`, `system`, `provider`; optional `note` |

Nothing else is accepted, and no route anywhere reaches out to fetch evidence.

### Genuinely enforced (proved by test, not asserted)

- **An evidence file cannot mint governance.** Structural, then screened, then
  schema'd: the only tables the import path writes are `shadow_ai_imports` and
  `shadow_ai_findings`; a pre-parse screen refuses any payload carrying a
  governance-shaped key at any depth (`isAdmin`, `grants`, `roleId`, …) with a
  422, an audited deny under `shadow-ai-import-privilege-refused` and a `refused`
  row; and every row schema is `.strict()` with no privilege field to parse into.
  The suite asserts all three attacks are refused **and that the user and role
  counts are unchanged** — a silent strip would fail.
- **Bounded untrusted input.** 2 MB per payload (checked on the raw bytes before
  anything walks the document), 5 000 rows per import, every string
  length-capped, a key fragment capped at 12 characters and redacted to 8 before
  storage. A full credential is refused outright rather than accepted "for
  analysis".
- **True positives AND true negatives.** In one import, `api.openai.com` is
  flagged while `github.com`, `registry.npmjs.org` and `notopenai.com` are not;
  `openai` matches and `openai-mock` does not; `sk-ant-…` at 64 characters is
  critical while `sk-test` at 7 is nothing. Host matching is exact-or-
  dot-boundary-suffix, so `api.openai.com.evil.net` never matches. An analyzer
  that flagged everything fails this suite.
- **The catalogue really is data.** Emptying `ai_endpoint_signatures` makes the
  same evidence match **nothing**; registering one row for a private, in-house
  hostname makes it match; deleting that row stops it again. The matcher contains
  no provider name. **How it is updated:** `POST /v1/shadow-ai/catalogue/seed`
  installs (and re-installs, idempotently) the shipped seed, refreshing only rows
  still marked `regulait-seed` so an admin's edit is never clobbered;
  `POST /v1/shadow-ai/catalogue` adds or edits one row — including a private
  endpoint we could never know about; `DELETE` removes one. No release is
  involved in any of them. `provenance` + `lastUpdatedAt` are on every row, and
  `GET /v1/shadow-ai/catalogue` reports `oldestEntryAt`, so staleness is legible.
- **No regex ever comes from data.** ADR-0034's argument about admin-settable
  `baseUrl` applies verbatim to an admin-settable pattern: it would be a ReDoS
  primitive with an admin-shaped trigger. Key detection is prefix + minimum
  length (a DB CHECK refuses a prefix with no bound); host detection is exact or
  dot-boundary suffix. Both linear. **Most-specific-wins** ordering is enforced so
  `sk-ant-` beats `sk-` and an exact host beats a suffix — a first-match matcher
  would have made the verdict depend on row insertion order.
- **Correlation, not double-counting.** A unique index on
  `(subject_kind, lower(subject), lower(provider))` means a second import
  re-observing the same usage widens `signal_sources`, extends the window, adds
  to `observation_count` and raises confidence — never a second row. Confidence
  is the count of **distinct** sources, so the same source twice is not
  corroboration.
- **Findings are actionable.** `replacement_agent_id` links a finding to the
  governed agent in the registry that would replace it — resolved from the
  **catalogue**, never from the uploaded file — and is surfaced on
  `GET /v1/shadow-ai/findings` and in the remediation plan.
- **Coverage is a model, not a claim.** `GET /v1/shadow-ai/findings` returns the
  scorecard with a per-source "what it sees / what it misses" and a statement
  that RegulAIt ships no collector and that discovery "reduces shadow AI — it
  does not prove its absence". The console renders it above the numbers.
- **The engine is governed by the kernel it feeds (§5).** Every route is
  admin-only (none appears in `NON_ADMIN_ROUTES`); every catalogue change,
  import — including refusals — and disposition writes an `audit_log` row with a
  stable `rule_id` through the ordinary audit path. There is no privileged
  discovery identity.
- **No egress.** Discovery makes no outbound request of any kind, so there is
  nothing here for the ADR-0034 guard to guard. That is deliberate: a discovery
  engine that phoned home with an inventory of a customer's AI usage would be the
  worst possible shape for this feature.

### Structural only — named plainly

- **No collector, as above.** The `code_scan` path is an importer for scan
  results; the repo walk over `packages/git-provider` described in §2 is **not
  built**. Nothing schedules, triggers or performs a scan.
- **Remediation does not start a workflow.** `GET …/remediation-plan` composes
  the §4 step sequence and hands back the request body for the existing
  `POST /v1/workflows/instances`; `POST …/remediate` links an instance that route
  created. This is deliberate — a second instantiation path would be a second set
  of assignment rules, compliance-cascade merges and quorum checks to keep in
  step — but it does mean the "pull into governance" flow is two calls, not one
  button, and **the shipped default workflow template of §4 does not exist yet.**
- **The "confirm governed" automated check is not wired.** The plan *names* the
  step ("confirm the next call appears in `audit_log`/`usage_events`") but no
  `automated_check` stage yet reads the ledgers and passes on its own.
- **Severity thresholds are not an `org_settings` dial.** §6's "what
  auto-opens a remediation workflow vs. what waits for triage" is not
  configurable; every finding lands as `open` for triage.
- **Retention of raw findings is not yet under the compliance cascade.** The
  mitigation actually in place is stronger than a retention policy for the worst
  case — we never store a usable credential, only an 8-character redacted prefix
  plus the observed length — but the §"follow-up" retention decision is still
  open.
- **A finding re-observed after a human closed it is surfaced, not reopened.**
  `dispositionStale` is reported; nothing auto-reverts a judgement.

### Migration

`0068_shadow_ai_discovery.sql` — three tables: `ai_endpoint_signatures` (the
catalogue), `shadow_ai_imports` (every evidence file, including the refused ones)
and `shadow_ai_findings` (the correlated inventory). `audit_log.object_type`
gains `ai_endpoint_signature`, `shadow_ai_import` and `shadow_ai_finding` as a
TS-only widening — the column has no DB CHECK, so there is no DDL for it.
