# RegulAIt vs Saviynt — where we are lacking (2026-08-20)

Owner-directed single-subject pass (2026-08-20), companion to
[GAP_ANALYSIS_CREDO_AI_2026-08.md](GAP_ANALYSIS_CREDO_AI_2026-08.md) and
[GAP_ANALYSIS_FOUR_VENDORS_2026-08.md](GAP_ANALYSIS_FOUR_VENDORS_2026-08.md), whose method and
format this follows and whose L-numbering this **continues** (that doc ended at L19; lacks
below start at **L20**). Extends [POSITIONING.md](POSITIONING.md) §3 with a Saviynt one-liner.

Saviynt is the first subject of these passes that is **not** an AI-governance vendor at all —
it is an identity-security incumbent (IGA) whose 2025–2026 AI story treats agents as
*identities*. That makes this the first comparison where the other side's newest product
(their Agent Access Gateway, 2026-03) genuinely stands at the **call plane** — our plane — so
the overlap rows below are graded more carefully than in any prior pass.

**Sourcing honesty.** saviynt.com is **egress-blocked from this workspace** (a direct fetch of
`saviynt.com/products/identity-security-for-agentic-ai` returned `EGRESS_BLOCKED` on
2026-08-20 — same wall as credo.ai, holisticai.com, fiddler.ai, ibm.com, onetrust.com and
atlasapp.ai in earlier passes). Every vendor-side claim below is therefore from **search-index
snippets retrieved 2026-08-20**, of three grades:

- *Vendor-primary via index*: snippets of Saviynt's own pages — the 2026-03-24 press release
  ("Industry's First Identity Control Plane for AI Agents", mirrored on GlobeNewswire), the
  2025-10-15 AI-capabilities release, the Identity Security for AI product page, the Agent
  Access Gateway / "Closing AI Agent Authorization Gaps" / runtime-guardrails / zero-standing-
  privilege / agent-lifecycle blog posts, the Intelligence Suite + Savi Copilot launch
  (2024-09), the SoD and machine-identity solution pages, and the sovereign-cloud blog.
  Strongest grade available here; still not a live read.
- *Third-party trade coverage, dated 2025–2026*: securitybrief.com.au, thepaypers.com,
  fintech.global, enterprisesecuritytech.com, itsecurityguru.org, helpnetsecurity.com,
  windowsforum.com, cybermagazine.com — all substantially restating the press releases
  (treat as amplification, not independent verification).
- *Independent/structural*: the FedRAMP Marketplace listings for Saviynt Enterprise Identity
  Cloud (Moderate ATO) and the "High Security Identity Platform" (IL5 support per indexed
  copy), AWS Marketplace GovCloud listing, Gartner Peer Insights snippets (4.8/5 across 249
  IGA reviews as of 2026-01; five consecutive Customers' Choice awards), and nhimg.org
  analyses of their NHI/agent announcements.

**Two honesty flags specific to this pass.** (1) The tasking mentioned an "EAGLE" agentic-AI
announcement; **no Saviynt product or announcement named "EAGLE" surfaced anywhere in the
index** (searched directly, 2026-08-20). The 2025-10-15 "AI-native platform" release is the
closest match by date and content; nothing below relies on the EAGLE name. (2) **No
adversarial or independent source on Agent Access Gateway limitations was found** — the
product is 2026-03-new and the index only carries Saviynt's own copy plus restatements. Every
"their gateway does not do X" statement below is therefore an **inference from absence in
their indexed copy**, marked as such, never asserted as verified fact — the M-010 discipline
applied to competitor claims.

RegulAIt's side is from this repo, by ADR and by grep — every "we have / we lack" line below
was checked against `packages/` and `apps/` on 2026-08-20. Since the four-vendor pass, the
ADR series has grown to **0086**: ADR-0084 (vendor AI-risk registry, gap L5/L16), ADR-0085
(EU-AI-Act tier screening, gap L10) and ADR-0086 (model-card autofill, gap L12) are now
shipped and are cited below where they change a verdict.

**Category note.** Saviynt is not in the GRC tier or the observability tier — it is the
**identity fabric tier**: it governs WHO an actor is across the enterprise (accounts,
entitlements in hundreds of connected SaaS/infra systems, certification campaigns, SoD,
joiner/mover/leaver). We govern WHAT a call may do at the AI gateway (per-user tool/model/
connector entitlements enforced inline, budgets, PII, tamper-evident audit). Their AI story
extends the identity fabric to agents; ours extends enforcement to everything an agent
touches through us. The planes intersect exactly once — their new Agent Access Gateway —
and that intersection is examined first.

---

## What Saviynt is, and what it ships for AI governance

**What it is.** Converged identity-security platform ("Identity Cloud"): IGA, application
access governance, cloud PAM, external-identity management, and a machine-identity module
(keys, x509 certificates, service accounts, RPA bots, workloads). SaaS-native; FedRAMP
Moderate ATO since 2019 with an IL5-supporting high-security platform and purpose-built
sovereign/air-gapped clouds for defense and intelligence customers (FedRAMP Marketplace +
sovereign-cloud blog, indexed 2026-08-20). Gartner Peer Insights **Customers' Choice for IGA,
five consecutive times, 4.8/5 over 249 reviews** (2026-01 snapshot via index). Buyers:
enterprise IAM/security organizations, regulated and public-sector, SAP/ERP-heavy shops
(their SoD franchise's home turf).

**The AI story — "Identity Security for AI"** (2025-10-15 platform release; full launch
2026-03-24 as "the industry's first Identity Control Plane for AI Agents"; expanded with
"Intent-Aware Runtime Authorization", all via indexed press/blog copy). Their framing number:
machine and AI identities outnumber humans **82:1**. Three components:

1. **ISPM for AI** — continuous discovery of all AI components (agents, MCP servers, tools),
   authorized or not, across "infrastructure and intelligence layers"; surfaces shadow AI,
   over-privileged access, and posture risks; prioritized risk insights.
2. **Identity Lifecycle Management for agents** — every agent registered (programmatically at
   build time, with platform, model, owner and criticality metadata), **assigned a human
   owner**, governed joiner/mover/leaver-style from registration to decommissioning. At
   registration they analyze the agent's *declared goals*, map goals to required tools/
   permissions, and **compare intended access against granted access**, flagging misalignment
   and excess privilege. Zero-standing-privilege posture: just-in-time, short-lived scoped
   tokens instead of standing credentials.
3. **Agent Access Gateway (AAG)** — the call-plane piece: **sits between agent clients and
   the MCP servers fronting applications**, receives tool-call requests, evaluates them
   against policy, forwards or rejects **before they reach the application**; covers
   agent-to-agent and agent-to-application; "Intent-Aware Runtime Authorization" (IARA) runs
   three checks — intent analysis (what is the agent trying to accomplish), context
   evaluation (does the action match the approved mission scope), policy enforcement
   (least-privilege + risk thresholds) — blocks out-of-boundary actions and emits an audit
   event; validates an unexpired user bearer token on inbound requests and forwards it so
   the application's own authorization still applies; issues short-lived scoped tokens when
   agents invoke other services.

**The classic IGA machinery their AI story inherits** (solution pages via index): intelligent
certification campaigns and continuous micro-certifications (application / entitlement-owner
/ service-account / role-owner certifications); **preventive + detective SoD** — a preventive
engine blocking conflicting access at request time, detective sweeps flagging existing
violations, cross-application; machine-identity lifecycle for keys/certs/bots; orphaned- and
stale-account cleanup. Plus their own embedded AI: the **Intelligence Suite** (2024-09 —
Intelligent Recommendations: dynamic roles, peer-analytics access recommendations, a
multi-dimensional weighted trust score) and **Savi Copilot**, a natural-language assistant
over certifications, requests, reports and onboarding — their certification copilot claims
up to 75% improvement in revokes of sensitive access (vendor-primary via index; treat the
number as marketing).

**Their strongest claim against us.** *An identity incumbent now standing at our plane, with
paper we do not have.* The AAG means the "runtime authorization gateway for AI agents" pitch
now comes from a vendor with FedRAMP Moderate + IL5, sovereign air-gapped clouds, a five-time
Customers' Choice badge, an installed base of exactly the CISO/IAM buyers we court, and the
procurement-familiar vocabulary those buyers already audit against — ownership, certification
campaigns, SoD, lifecycle. Where every prior subject governed *records* or *scores*, Saviynt
can now say "we block the tool call" — and their agent-registration story (declared intent →
granted access → misalignment surfaced) is a genuinely good design we only partially have.

**Our strongest claim against them.** *Their gateway authorizes an identity; ours governs the
call.* On the indexed copy, AAG's decision inputs are identity, policy, context and inferred
intent — **nothing in their materials shows the gateway reading or redacting content (PII),
metering tokens, attributing spend, enforcing budgets, routing or optimizing models, running
evals/red-team, or producing compliance-pack evidence** (inference from absence, flagged
above). All of that is shipped, tested surface here, at one interception point: per-user
default-deny kernel with tool-level MCP permissions (pillar 1), PII floor + guardrails
(ADR-0021 am./0042), per-project cost attribution + budget enforcement (ADR-0069/0076,
pillar 5), token optimization (pillar 6), tighten-only delegation ceilings older than their
gateway (ADR-0016/0078, conformance-suite-pinned), eval/red-team evidence (ADR-0044/0057/
0067/0068), query-backed compliance packs (ADR-0058), tamper-evident audit + WORM (ADR-0060),
and an SDLC workflow engine (pillar 2) their platform has no equivalent of. Also structural:
their model wires an agent's access into hundreds of enterprise apps via the identity fabric;
ours never hands the agent a credential at all — model/connector credentials stay in gateway
custody (ADR-0023/0024), so the token-leak problem their short-lived tokens mitigate mostly
does not exist inside our boundary. One-liner in §Positioning.

---

## Where we are lacking, ranked (L20–L26, continuing the series)

Each entry: what Saviynt holds → what the repo already has (grep-verified 2026-08-20) →
effort → defensibility ("is this our fight?") → disposition.

### L20 — Agent ownership, lifecycle states, and orphaned-agent detection
**Saviynt:** every agent has a registered human owner and a lifecycle (registration →
decommissioning); ownership is the accountability spine of their whole AI story. In-repo:
the `agents` registry row (`packages/db/src/schema.ts`, `export const agents`) has **no
`ownerUserId`, no lifecycle status beyond an `enabled` boolean, and no decommissioned state**;
grep for owner columns finds them on `ai_use_cases`, `ai_vendors` and `ai_risks`
(ADR-0080/0084/0081) but not on `agents`. Ownership is therefore only *indirect*: an approved
use case has an owner and `intendedAgentIds`, and the ADR-0082 inventory joins the two
(`apps/gateway/src/inventory.ts` counts use cases per agent). Nothing detects the orphan
case: when SCIM deactivates a user (ADR-0037 — deactivate-never-delete, sessions revoked),
no signal fires for agents/use-cases/risks that person owned — the approver-vacancy
equivalent (ADR-0022 delegation windows) exists for approvals only. **Effort: small** —
`owner_user_id` + a CHECK-constrained lifecycle on `agents` in the 0084 idiom, plus one
inventory/posture query flagging objects whose owner is disabled. **Defensibility: squarely
our fight** — accountability metadata on registry rows we already govern; no identity-fabric
machinery needed. **Disposition: build next.** Cheapest credible answer to the first question
a Saviynt-conditioned buyer asks ("who owns this agent?").

### L21 — Intended-vs-granted alignment surfaced automatically
**Saviynt:** at registration they map an agent's declared goals to required permissions and
flag where granted access exceeds intent. In-repo, both halves exist but the comparison does
not: ADR-0080 use cases carry `intendedAgentIds` (validated against the registry —
`apps/gateway/src/use-cases.ts`), and ADR-0082's inventory keeps **granted vs observed**
rigorously separate precisely so "unused permission" is answerable
(`apps/gateway/src/inventory.ts` header: granted and observed "never blend"). But no view
answers *intended vs granted*: "agent X is granted to 14 users, yet appears in no approved
use case" or "use case Y intends agents it has no granted path to run". **Effort: small** —
a read-time SELECT in the ADR-0082 idiom (no new tables), two flags on the existing
inventory payload. **Defensibility: ours** — it terminates in our own grant/revocation
machinery, which their flag cannot. **Disposition: build next** (pairs with L20; together
they are the "agent accountability" story).

### L22 — Access certification/attestation campaigns over grants
**Saviynt:** certification campaigns are their core loop — periodic, owner-driven review of
entitlements with attest/revoke decisions, micro-certifications on trigger events, campaign
progress and audit trail. In-repo: grep for campaign machinery finds **none** (`campaign`
matches nothing in `packages/`/`apps/` source). What exists is adjacent, and the delta must
be stated precisely: ADR-0045 model-card sign-offs ARE time-bounded recertifications — a
`validUntil` the dispatch gate evaluates, lapse blocks dispatch, recertification is a new
chained row (`packages/shared/src/mrm.ts`, `apps/gateway/src/mrm.ts`) — but that certifies
*model risk sign-off*, not *who holds which grant*. ADR-0082 provides the evidence a
campaign would review (granted vs observed per agent/tool/connector); ADR-0019 provides the
revocation instrument; the ADR-0064 scheduler provides the clock. Nothing convenes them:
no "review these 40 grants by March 1, non-response auto-revokes" object, no reviewer
assignment, no campaign audit trail. **Effort: medium** — a campaign object on pillar-2
workflow rails (intake → per-reviewer decisions → revocations applied), reading ADR-0082's
inventory as its worksheet. **Defensibility: yes for OUR grants** (in-gateway entitlements —
and our version ends in enforced revocation with query evidence, not an attestation export);
**no for cross-SaaS entitlements** — certifying Salesforce/SAP access is their fabric, not
ours. **Disposition: build later**, scoped to gateway grants only, after L20/L21 give
campaigns their ownership spine.

### L23 — Segregation-of-duties over access combinations
**Saviynt:** preventive + detective SoD rulesets, cross-application ("requester cannot hold
A and B"), the ERP-audit franchise. In-repo: SoD exists **only as decision separation** —
requester-cannot-approve-own-request guards on the decide path, the deploy-handoff SoD rule,
and a strict-SoD org mode (`apps/gateway/src/app.ts` separation-of-duties guards,
`apps/gateway/src/workflows.ts`, `packages/db/src/schema.ts` §separation-of-duties comments;
grep-verified). There is **no access-combination SoD**: nothing can declare that two grants
conflict — e.g. "no single user (and therefore no agent run inheriting from them, per
ADR-0078's tighten-only lattice) may hold both the payment-initiation MCP tool and the
vendor-master-edit tool". What an SoD rule between AI capabilities means at our plane is
exactly that: **toxic tool/connector combinations within one entitlement set**, evaluated
preventively at grant time and detectively over existing grants. **Effort: medium** — a
conflict-pair ruleset evaluated at the grant-write choke point (ADR-0074's read-model/write-
choke idiom fits) plus a detective sweep into the Approvals Queue. **Defensibility: split** —
toxic-combination rules over OUR grants are our fight (agentic SoD is a real and marketable
control no gateway-tier competitor has); replicating ERP-grade cross-application SoD
rulesets is Saviynt's decades-deep franchise and **not our fight**. **Disposition: build
later** (the in-gateway half); **deliberately refuse** the ERP/cross-app half, and say so on
the comparison page.

### L24 — Access-recommendation intelligence and an embedded copilot that ships
**Saviynt:** Intelligence Suite (peer-analytics access recommendations, dynamic roles,
weighted trust scoring) + Savi Copilot embedded across certification/request/reporting flows
— their AI works *for the governor*. In-repo: the raw signal for recommendations exists
(ADR-0082's granted-vs-observed is the "peers don't use this" input) but no recommendation
engine ranks or proposes; and our governance copilot (ADR-0056) plus judge-backed paths
remain **credential-blocked** (PENDING P1 — same wall as Credo L6 and the four-vendor pass's
L13/L14 notes; POSITIONING §6 forbids claiming it meanwhile). **Effort:** recommendations
medium (analytics over ledgers we hold); copilot blocked, not effort-bound.
**Defensibility:** recommendations over our own grant/usage ledgers, yes; matching their
trust-scoring breadth across an identity fabric, no. **Disposition: later** (both halves;
the copilot stays behind the credential wall and the honesty stance stands).

### L25 — Machine-identity/service-account discovery across connected systems
**Saviynt:** ISPM discovers agents, MCP servers, service accounts, keys and certificates by
connecting to the systems themselves — continuous, connector-driven, "authorized or not".
In-repo: ADR-0055/0071/0083 ship evidence ingest + format adapters + a compiled 81-signature
first-party classifier over operator-supplied artifacts — **deliberately no scraper, no
standing connectors into customer systems** (the ADR-0083 posture, re-affirmed in the
four-vendor pass). These are different planes: they enumerate accounts that exist in systems;
we classify AI usage in artifacts and govern what crosses the gateway. Their version answers
"what service accounts live in my estate" — a question our architecture cannot and should
not answer. **Effort:** to do it their way = build an identity-connector fleet; no.
**Defensibility: not our fight.** **Disposition: refuse, unchanged** — and keep the honest
comparison row: continuous fabric-wide discovery is theirs; artifact/evidence-based AI
discovery plus in-gateway observation is ours.

### L26 — The identity fabric itself (outbound provisioning, PAM, external identities, JML)
**Saviynt:** the actual product — provisioning into hundreds of target systems, human
joiner/mover/leaver, privileged-access management, external-identity governance, credential
vaulting for infrastructure. In-repo: we sit on the *consuming* side of the fabric, by
design: SAML SSO in (ADR-0036), SCIM provisioning in (ADR-0037 — create/update/deactivate
with sessions revoked), IdP-group→role mapping (ADR-0038), session/device management
(ADR-0039), ABAC policy-as-code over our own decisions (ADR-0040). We never provision
outward and hold no PAM. **Effort:** becoming an IGA = becoming Saviynt; no.
**Defensibility: not our fight — and the integration is already built from their side's
perspective**: because ADR-0036/0037 exist, a Saviynt shop can *today* govern RegulAIt as a
target application — provision users into us, deactivate leavers, map groups to our roles —
while our kernel governs what those users' agents may do per call. **Disposition: refuse the
category; document the "governable by your IGA" row** (this is a partnership-shaped fact,
not a gap).

---

## Positioning implications

1. **The one-liner** (POSITIONING §3 addition): **"Saviynt governs who your agent is in the
   identity fabric; RegulAIt governs what your agent's every call may do — which model,
   which tool, whose data, how many dollars."** Complement framing available when useful:
   their SCIM provisions our users; our kernel governs those users' calls.
2. **We should NOT claim IGA** — no certification campaigns (L22), no access-combination SoD
   (L23), no provisioning fabric (L26), and a Customers'-Choice incumbent owns the
   vocabulary. Claim instead: *governable by your IGA* (ADR-0036/0037/0038, shipped) — the
   honest row that turns their strength into our integration story.
3. **Retire, permanently, any "identity vendors have no runtime story" line** — AAG sits
   inline between agent and MCP server and blocks. The defensible narrowing, per the
   inference-from-absence flag above: *their runtime check authorizes an identity's action;
   nothing in their public copy shows content inspection/PII redaction, token metering,
   budget enforcement, spend attribution, model routing, eval/red-team evidence, or
   compliance-pack evidence at the call.* Say exactly that, never the broader version — and
   re-verify against their copy before publishing, since AAG is 2026-03-new and moving.
4. **Air-gap is NOT a discriminator against Saviynt** (FedRAMP Moderate since 2019, IL5,
   purpose-built sovereign/air-gapped clouds) — same correction the four-vendor pass made
   for Fiddler and watsonx. Our air-gap row vs Saviynt is *parity with a difference*:
   theirs is a vendor-operated sovereign cloud; ours is `docker compose up` in the
   customer's own room (ADR-0041/0062/0063).
5. **New comparison-page rows this pass earns:** "Does the gateway read the prompt, or only
   the identity?" · "Is the block decision evidenced by a query over the enforcing system's
   own ledgers?" (ADR-0058/0060 — nothing in their copy claims tamper-evident evidence) ·
   "Cost/budget at the point of call" (absent from their story) · "Agent holds a credential
   at all?" (their short-lived tokens vs our gateway custody, ADR-0023/0024) · "Governable
   by your IGA" (us: yes, SCIM/SAML in).
6. **Watch item:** Saviynt's intent-aware framing (mission scope, intent analysis) is the
   marketing high ground for agent authorization. Our factual counter today is ADR-0080
   use-case purpose + L21 once built; do not imitate the "intent analysis" language until
   something enforces it — that would be attestation-shaped, which POSITIONING §4 forbids.

## Already covered — near-misses caught (the method's proof section)

Candidate gaps drafted during research and **struck (or narrowed) after in-repo
verification**, per the standing rule that every lack is grep-checked before it ships:

- **"No runtime authorization for AI agents"** (the AAG pitch read back at us) — struck,
  emphatically: per-user default-deny at tool/model/connector level IS the product
  (pillar 1), with tighten-only delegation ceilings named and conformance-tested
  (ADR-0016/0078, `apps/gateway/src/delegation-conformance.test.ts`) — shipped and pinned
  before their 2026-03 gateway existed.
- **"No agent registry / no registration front-door"** — struck: ADR-0080 approval-creates-
  the-object intake with `intendedAgentIds` validated against the registry
  (`apps/gateway/src/use-cases.ts`), ADR-0082 standing inventory. Survives only as L20/L21
  (ownership column, lifecycle states, intended-vs-granted view).
- **"No over-privilege detection"** — struck as absolute: granted-vs-observed separation is
  the stated purpose of ADR-0082's inventory (`apps/gateway/src/inventory.ts` — "cannot tell
  an unused permission from a used one" is the exact question it exists to answer). Survives
  only as the campaign machinery that would act on it (L22).
- **"No SoD"** — narrowed, not struck: decision-SoD is enforced at the decide path, the
  deploy handoff, and a strict-SoD org mode (grep hits across `app.ts`/`workflows.ts`/
  `schema.ts`); the true lack is access-combination SoD only (L23 as written).
- **"No leaver handling / no deprovisioning"** — struck: ADR-0037 SCIM deactivate-never-
  delete revokes sessions and stops keys immediately (`apps/gateway/src/scim.ts`);
  ADR-0022 delegation windows cover approver vacancy. Survives only as the owner-orphan
  signal inside L20.
- **"No recertification"** — narrowed: ADR-0045 sign-off recertification exists with real
  teeth (lapse blocks dispatch, chained supersession — `packages/shared/src/mrm.ts`); the
  lack is grant-level campaigns (L22), not recertification per se.
- **"No shadow-AI discovery"** — narrowed as in both prior passes: ADR-0055/0071/0083 ship
  the evidence-ingest + first-party-classifier posture; fabric-connected account discovery
  remains different in kind, by our own choice (L25, refused).
- **"No short-lived credentials / standing-privilege risk"** — struck as mostly
  inapplicable: agents never hold model/connector credentials here — custody stays in the
  gateway (ADR-0023/0024), egress is default-deny (ADR-0034/0043/0062) — so the leak class
  their short-lived tokens mitigate largely cannot occur inside our boundary. The honest
  residue: we do not broker tokens into *third-party* apps on an agent's behalf — that is
  L26 territory, refused.
- **"No third-party AI vendor governance"** — struck since the four-vendor pass: ADR-0084
  now ships the vendor registry (attestations-never-evidence). Likewise EU-AI-Act tier
  screening (ADR-0085) and model-card autofill (ADR-0086) landed since that doc's process
  note recorded the series ending at 0083 — the queue worked; the note is superseded.

## What to do about it (recommended, not started)

1. **L20 — agent ownership + lifecycle + owner-orphan signal**: small, build next; the
   accountability answer every identity-conditioned buyer asks for first.
2. **L21 — intended-vs-granted flags on the ADR-0082 inventory**: small, build next; pairs
   with L20.
3. **L22 — grant certification campaigns on pillar-2 rails**, scoped to gateway grants,
   ending in enforced revocation: build later, after L20/L21.
4. **L23 — toxic tool-combination SoD** at the grant-write choke point: build later;
   refuse ERP cross-application SoD explicitly.
5. **L24** recommendations later; copilot stays credential-blocked (PENDING P1), stance
   unchanged.
6. **Standing refusals this pass adds:** fabric-wide machine-identity discovery (L25),
   the identity-fabric category itself (L26) — countered by the shipped "governable by
   your IGA" integration row (ADR-0036/0037/0038).
