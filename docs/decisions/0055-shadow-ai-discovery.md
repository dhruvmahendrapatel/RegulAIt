# ADR-0055: Shadow-AI Discovery — inventory ungoverned LLM usage and pull it into governance

- **Status**: Proposed
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
