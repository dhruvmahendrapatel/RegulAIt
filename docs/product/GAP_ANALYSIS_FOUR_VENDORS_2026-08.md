# RegulAIt vs Holistic AI / watsonx.governance / Fiddler / OneTrust — where we are lacking (2026-08-20)

Owner-directed four-subject pass (2026-08-20), companion to
[GAP_ANALYSIS_CREDO_AI_2026-08.md](GAP_ANALYSIS_CREDO_AI_2026-08.md) (whose method and format
this follows, and whose L-numbering this **continues** — lacks below start at L9 so that L1–L8
keep meaning what ADR-0080–0083 already cite) and to
[MARKET_ANALYSIS_2026-08.md](MARKET_ANALYSIS_2026-08.md) §1.3 (one paragraph each on Holistic
and watsonx, re-tested here) and [POSITIONING.md](POSITIONING.md) (whose §3 one-liners this
extends per vendor).

**Sourcing honesty.** All four vendors' own sites are **egress-blocked from this workspace**
(fetches to holisticai.com, fiddler.ai, ibm.com and onetrust.com each returned
`EGRESS_BLOCKED` on 2026-08-20 — same as credo.ai and atlasapp.ai in earlier passes; the
third-party review site appsecsanta.com was blocked too). Every vendor-side claim below is
therefore from **search-index snippets retrieved 2026-08-20**, of three grades:

- *Vendor-primary via index*: snippets of the vendors' own pages (holisticai.com product/blog
  pages and the `holistic-ai/holisticai` GitHub repo; fiddler.ai trust-service/llmops/
  government pages and Carahsoft's Fiddler listing; ibm.com watsonx.governance product/docs
  pages; onetrust.com solutions/news pages and the 2026-03-09 SiliconANGLE report of
  OneTrust's agent-oversight release). Strongest grade available here; still not a live read.
- *Third-party comparisons, dated 2026*: Kovrr's platform comparison, Kosmoy's alternatives
  pages (one per vendor), modulos.ai and secureprivacy.ai buyer's guides, exceeds.ai feature
  writeups (watsonx, OneTrust), atonementlicensing.com (IBM pricing — pricing figures are
  repriceable, treat as indicative), G2 / Gartner Peer Insights / Capterra review snippets.
- *Adversarial but specific*: pages by competitors or sellers-of-alternatives — deepinspect.ai
  on watsonx ("monitors … but does not enforce"), co-aims.com and sprinto.com and enzuzo.com
  on OneTrust, respan.ai on Fiddler, kosmoy.com throughout. Their limitation claims are used
  the way the Credo doc used getagentid.com: as pointed hypotheses, only asserted below where
  a second source or the vendor's own indexed copy agrees.

Facts already verified live on 2026-08-15 in the market analysis (Holistic Guardian Agents;
watsonx Q1-2026 Agent Monitoring & Insights and the June-2026 Gartner Leader position) are
reused without re-verification. RegulAIt's side is from this repo, by ADR and by grep — every
"we have / we lack" line below was checked against `packages/` and `apps/` on 2026-08-20.

**Category note.** The four subjects are not one tier. Holistic, watsonx and OneTrust are the
GRC/lifecycle tier (registry, assessment, monitoring, boardroom) approaching runtime from
above; Fiddler is the observability tier (metrics, scoring, guardrails) approaching governance
from below. None of the four is an entitlement gateway: none does per-user default-deny at the
call plane, none has a cost plane, none has an SDLC workflow. The gaps below are what each has
refined that we have not; the balance section holds the other direction.

---

## Per-vendor

### 1. Holistic AI — the audit-and-assessment specialist growing teeth

**What it is.** AI governance platform with a bias-audit heritage (a recognized NYC Local Law
144 independent auditor), grown into inventory + risk management + assessments + regulatory
readiness. Gartner **Challenger** in the June-2026 AI-governance MQ; Representative Vendor in
the Feb-2026 Guardian-Agents market guide (buyer's-guide coverage, 2026-08-20).

**What it ships** (indexed vendor pages + 2026 guides): AI inventory with shadow-AI discovery
(scanning cloud platforms, code repos and SaaS); **100+ automated tests** for bias,
hallucination, red-teaming and EU-AI-Act/ISO-42001 compliance; an **EU AI Act risk calculator**
classifying systems by the Act's risk tiers plus an automated readiness assessment; framework
selection (EU AI Act, NIST AI RMF, ISO 42001) with policy-as-code rules; the 2026 runtime
additions — AI Safeguard input/output filtering and **Guardian Agents** (Sentinel observe +
Operative block/quarantine/revoke/kill); and the **open-source `holisticai` library** (bias
metrics — disparate impact, equal opportunity — and mitigation techniques), which makes their
testing methodology public. Buyers: HR-tech/compliance-driven enterprises, EU-exposure buyers.

**Their strongest claim against us:** *measured, accredited fairness.* They can hand a
regulator a statistical bias audit with a published open-source methodology behind it, and a
risk-tier classification of every system against the EU AI Act's own vocabulary. Our model
cards say, in their own disclaimer, that RegulAIt "does not measure bias or fairness"
(`packages/shared/src/mrm.ts`) — we record *declarations* and probe adversarially, we do not
compute a disparate-impact number.

**Our strongest claim against them:** *enforcement is where they are newest and we are
oldest.* Their runtime layer is 2026-new with no public GA date for Guardian Agents; two
independent 2026 guides record **no inline gateway, no PII detection/redaction of prompts, no
multi-provider API layer, no cost/FinOps plane, and vague VPC/BYOC/air-gap documentation**.
Every one of those is a shipped, tested surface here: default-deny per-user kernel (pillar 1),
PII floor + layered guardrails (ADR-0021 am./0042), egress guard (ADR-0043), cost plane
(ADR-0069/0076), code-enforced air-gap posture (ADR-0062), tamper-evident audit (ADR-0060).
One-liner: **"Holistic audits your AI; RegulAIt is the thing standing in front of it."**

### 2. IBM watsonx.governance — the lifecycle incumbent with the Leader badge

**What it is.** Platform-agnostic model/AI lifecycle governance: factsheets, model risk
governance inherited from OpenPages (the SR 11-7 bank-model-risk lineage), evaluation and
monitoring, agent governance (AI Agent object types + Risk Atlas since 2025-07; **Agent
Monitoring & Insights Q1 2026**), Guardium AI-security integration. Gartner AI-governance
**Leader**, June 2026 (verified 2026-08-15).

**What it ships** (indexed ibm.com pages + 2026 comparisons): **factsheets that
auto-collect model metadata across the lifecycle** (performance, fairness, explainability,
compliance status); model risk workflows aligned to SR 11-7 and NIST AI RMF; monitors for
**fairness (disparate-impact metrics), quality, and drift — including embedding drift** on
production traffic with threshold alerts; compliance accelerators for EU AI Act / ISO 42001 /
NIST AI RMF; deployment as SaaS, on-prem via Cloud Pak for Data, **air-gapped installs, and
FedRAMP Moderate**. Pricing: free/Essentials/Standard, ~$0.60/resource-unit metered, real
contracts quote-based, roughly $5k–25k/month in third-party guides (repriceable). Buyers:
regulated enterprises, banks with existing OpenPages/IBM estates.

**Their strongest claim against us:** *lifecycle evidence maturity plus enterprise trust.* A
factsheet that fills itself from the lifecycle, fairness/drift monitors on live traffic, a
bank-grade model-risk workflow vocabulary two decades old, sovereign deployment options with
FedRAMP paper, and the Leader badge that gets them into every RFP we are not invited to.

**Our strongest claim against them:** the deepinspect.ai formulation, which matches every
other source: watsonx.governance **"monitors, evaluates and alerts, but it does not enforce —
no inline gateway, no native input/output blocking, no agent sandboxing."** Plus fragmentation:
the story spans watsonx.governance + OpenPages + Guardium + Orchestrate, separately licensed;
and there is no per-project AI spend plane and no PR-shaped SDLC governance. Our controls act
at the call (pillar 1), our evidence is a query over ledgers the enforcement itself writes
(ADR-0058), and it is one product. One-liner: **"watsonx writes the factsheet; RegulAIt is the
policy the call actually hits."**

### 3. Fiddler AI — the instrument-maker

**What it is.** ML/LLM observability and "AI Control Plane": monitoring, explainability,
guardrails, evaluations — the deepest *measurement* stack of the four, repositioned in 2026
around agentic observability. Buyers: enterprise ML/platform teams and **government**
(Carahsoft distribution, NVIDIA AI Factory for Government, IL6-ready architecture).

**What it ships** (indexed fiddler.ai pages + reviews): **Centor models** (ex-Trust models) —
purpose-trained, task-specific scoring models powering guardrails at **<100ms** (free tier
quotes <80ms) for hallucination, toxicity, PII/PHI, prompt injection and jailbreak; **50+
out-of-the-box LLM metrics** plus custom metrics via an enrichment pipeline; drift detection
and **embedding visualization**; explainability — SHAP, Fiddler-SHAP, Integrated Gradients,
what-if simulations, image/text explanations; dashboards and alerting at petabyte scale;
deployment **SaaS, VPC, on-prem and air-gapped**. Pricing: free guardrails tier, Developer at
$0.002/trace, Enterprise custom — but **no self-serve path; every tier routes through a demo
request** (review coverage, 2026-08-20).

**Their strongest claim against us:** *instrument quality, proven live.* Their guardrail
verdicts come from purpose-trained models with published latency numbers on real production
traffic; ours are heuristic detectors that our own ADR calls "a defence-in-depth layer, not a
proof of safety" (`packages/shared/src/guardrails.ts`), and our judge-backed scoring paths are
credential-blocked until a live provider is connected (PENDING P1). Where we overlap Fiddler,
they hold the measurements and we hold the mechanism.

**Our strongest claim against them:** *scoring is not governing.* Fiddler has no per-user
entitlement model, no default-deny, no approvals queue, no budgets that block, no compliance
packs or cascade, no SDLC workflow, no PM sync, no tamper-evident audit chain, no cost
attribution at the point of call — a Fiddler deployment still needs something like us to
*decide* anything. And their air-gap story means we must NOT claim air-gap as unique against
the observability tier (see §Positioning). One-liner: **"Fiddler tells you the score; RegulAIt
decides whether the call happens at all."**

### 4. OneTrust AI Governance — the GRC suite's AI module

**What it is.** The AI module of the dominant privacy/GRC suite: AI inventory and registration
intake, assessment automation against frameworks, deep data-privacy integration, third-party
risk heritage, policy workflows. The 2026 release (SiliconANGLE, 2026-03-09) added **AI agent
detection and inventory**, a standards-aligned AI policy manager, and "real-time AI guardrail
enforcement" claims across generative and traditional ML.

**What it ships** (indexed onetrust.com pages + reviews): AI inventory of models, datasets,
agents and third-party AI tools mapped to EU AI Act / NIST AI RMF / ISO 42001 / OECD;
**assessment automation** — PIA/DPIA/conformity-assessment templates whose answers
**auto-populate RoPA and data-mapping records**, with AI-suggested reassessment responses
("AI Inventory Analysis"); **regulatory intelligence** feeding compliance workflows and
auto-generated control mitigations; **third-party AI risk** through the Third-Party Management
product — thousands of pre-built vendor Trust Profiles plus continuous feeds (SecurityScorecard,
RiskRecon, HackNotice); Databricks-framework integration. Pricing $50k–150k+ first-year in
third-party guides; $10k floor; renewal-increase complaints recur across reviews.

**Their strongest claim against us:** *the intake front-door at enterprise scale, wired into
privacy.* Where our ADR-0080 intake is one questionnaire template, theirs is a mature
assessment factory: template library, AI-suggested answers, RoPA/DPIA auto-population, a
regulatory-intelligence feed keeping it current, and a vendor-risk machine attached — sold to
a buyer (the privacy office) who already owns their suite.

**Our strongest claim against them:** the review consensus, three sources deep: OneTrust's
runtime is thin where ours is the product — **"no evals, no gateway, no self-hosted option"**,
bias handling "documentation-based, rather than automated detection", "critical gaps in
code-level analysis and engineering workflow integration", weeks of configuration, opaque
pricing. We are self-hosted/air-gapped by primary motion (ADR-0041/0062), our assessments
terminate in a cascade that *enforces* (§8.3, ADR-0077), our evidence is a query (ADR-0058),
and `docker compose up` is our sales call. One-liner: **"OneTrust registers your AI in the
privacy suite; RegulAIt is the gateway the AI actually calls through."**

---

## Where we are lacking, ranked (L9–L19, continuing the Credo doc's series)

Each entry: which vendor(s) hold it → what the repo already has (grep-verified) → effort →
defensibility ("is this our fight?") → disposition.

### L9 — Quantitative bias/fairness measurement
**Holistic (bias audits + OSS library), watsonx (disparate-impact monitors), Fiddler
(fairness metrics).** Three of four ship a *number*; we ship a *declaration and a probe*.
In-repo: model cards carry `biasFairness` slots that are explicitly declared-not-measured —
the code's own disclaimer says "RegulAIt does not measure bias or fairness"
(`packages/shared/src/mrm.ts`, ADR-0045); the red-team corpus has a `bias` attack class
(`packages/shared/src/redteam.ts`, ADR-0057/0068) — adversarial elicitation, not statistical
fairness. **Effort:** medium for the LLM-shaped half — bias eval datasets + scorers ride the
existing ADR-0044/0067 harness rails; the classical-ML half (disparate impact over
predictions × protected attributes × outcomes) needs data that never crosses our gateway.
**Defensibility:** split. LLM-output bias evals are our fight (same rails, same evidence-is-
a-query story). Accredited classical-ML fairness auditing is Holistic's licensed-auditor
franchise and not ours. **Disposition: build later** (LLM bias eval pack on harness rails,
after PENDING P1 unblocks judge scorers); **deliberately refuse** the classical-ML audit
business, and say so on the comparison page.

### L10 — EU AI Act risk-tier classification and readiness scoring
**Holistic (risk calculator + automated readiness assessment), OneTrust (conformity
assessments).** In-repo: the eu-ai-act pack maps *high-risk obligations* to enforced controls
with `cascadeTag: "eu-ai-act-high-risk"` (`packages/shared/src/compliance-packs.ts`,
ADR-0058), and the ADR-0080 intake questionnaire asks about compliance tags — but **nothing
classifies a use case into the Act's own tiers** (prohibited / high / limited / minimal): no
questionnaire section, no derived field, no readiness percentage. Our `AI_RISK_LEVELS` are
generic low/medium/high (`packages/shared/src/risks.ts`, ADR-0081). **Effort: small** — a
tier-classification section in the ADR-0080 questionnaire plus a derived field that
*recommends the cascade tag*, which is the move nobody else can make: their classifier ends
in a report, ours would end in enforcement. **Defensibility: yes, squarely our fight**, and
deadline-driven (high-risk obligations apply from August 2026 — the sources' own framing).
**Disposition: build next.** Highest leverage-to-effort of this pass.

### L11 — Live-traffic drift monitoring (including embedding drift)
**watsonx (embedding drift + threshold alerts on production), Fiddler (drift + embedding
visualization).** In-repo: ADR-0044 drift *sweeps* compare scheduled eval runs against a
baseline (driven by the ADR-0064 scheduler) — dataset-anchored, not traffic-anchored; ADR-0049
detects *spend-shape* anomalies on `usage_events`. Nothing watches output distributions of
live traffic, and there are no embeddings anywhere to drift. **Effort:** medium, and
**instrument-gated** — meaningless before a live provider flows real traffic (PENDING P1),
same credential wall as L6. **Defensibility:** partially ours — drift *gating promotion* is
already our shape (ADR-0044's workflow check); competing with Fiddler on drift analytics
depth is not. **Disposition: build later**, scoped to "drift signal → existing alerting +
promotion gate", explicitly not a drift-analytics workbench.

### L12 — Auto-collected factsheets (card auto-fill from lifecycle)
**watsonx (factsheets auto-collect metadata, performance, fairness, compliance status across
the lifecycle).** In-repo: ADR-0045 model cards can *attach* measured evidence — an eval-run
FK with RESTRICT so cited evidence cannot be deleted (`apps/gateway/src/mrm.ts`) — and
ADR-0048 stamps config versions onto every dispatch. But attachment is manual; nothing fills
a card from the ledgers we already write (eval runs, red-team ASR, usage, guardrail verdicts,
audit denials). **Effort: small-medium** — a read-time aggregation in the ADR-0082 idiom
("granted vs observed", no new tables), surfaced as a card "measured" panel. **Defensibility:
yes** — our version is *better-grounded* than a factsheet (every figure a query), it is
presentation over data we hold. **Disposition: build next** (second after L10; pairs with the
exec posture view ADR-0082 already shipped).

### L13 — Assessment breadth and AI-assisted pre-fill
**OneTrust (template library, AI-suggested responses, reassessment automation), Holistic
(automated readiness assessments), and Credo's GAIA (gap L6, unchanged).** In-repo: ADR-0080
ships exactly one questionnaire template, and its deliberate stance is the inverse of the
market's: *"Nothing below is pre-filled by a model — the answers are yours, and they are what
the approver approves"* (`apps/gateway/src/use-cases.ts`). Breadth (DPIA-shaped, conformity-
assessment-shaped, vendor-intake-shaped templates) is content work on shipped rails
(ADR-0077 gallery + ADR-0080 pattern). Pre-fill is credential-blocked (same wall as Credo L6)
**and** collides with a stated design position. **Effort:** breadth small-per-template;
pre-fill medium + credential. **Defensibility:** breadth yes; pre-fill contested.
**Disposition: needs owner decision** — does the "answers are yours" stance stand as a
differentiator (it demos as honesty) or does the auto-fill race (OneTrust, Credo GAIA) make
assisted-with-citations table stakes? Template breadth can proceed either way.

### L14 — Purpose-trained low-latency guardrail scoring models
**Fiddler (Centor, <100ms, task-specific), and Lakera/Check Point beyond this pass.**
In-repo: ADR-0042's five detectors (prompt-injection, jailbreak, toxicity, semantic-DLP, PII
— `packages/shared/src/guardrails.ts`) are heuristic and self-describedly defence-in-depth.
The market analysis §4.8 already made the call: guardrail-model breadth is **"a partnership
or an adapter, not a build."** This pass re-confirms it — training scoring models is a
different company. **Effort:** adapter small (ADR-0042's layer is pluggable; an
external-scorer adapter slot fits it); building models: out of scope. **Defensibility:** the
adapter yes, the models no. **Disposition: stand by the deliberate refusal to build models;
build the external-scorer guardrail adapter later** so a customer can bring Fiddler/Lakera
verdicts *into* our block/warn/log modes — turning their instrument into our enforcement.

### L15 — Regulatory tracking / horizon scanning
**Holistic (regulatory tracking), OneTrust (regulatory intelligence feeding workflows),
watsonx (IBM-maintained accelerators).** In-repo: nothing — grep finds no
regulatory-feed-shaped code; ADR-0058 packs are versioned static seeds with a legal
disclaimer, and the Credo doc's L3 verdict ("content/partnership problem more than an
engineering one") stands. The one engineering sliver we lack that IS ours: when a pack gets a
new version, nothing surfaces *what changed and which enforced controls it touches*.
**Effort:** feed = ongoing content ops, not a build; pack-diff surface = small.
**Defensibility:** the feed business is not our fight (regulatory-affairs staffing is the
moat); the pack-diff-to-enforcement view is. **Disposition: deliberately refuse the feed;
build the pack-version diff surface later.**

### L16 — Vendor / third-party AI risk (now two vendors deep)
**OneTrust (Trust Profiles at thousands-scale + SecurityScorecard/RiskRecon feeds), and
Credo's Vendor Portal (gap L5, deferred then).** In-repo: unchanged — our vendor story is
cost (ADR-0069/0076 imports), not risk; no vendor-assessment object exists. **Effort:**
medium-to-large, and the data moat (pre-built profiles, monitoring feeds) is theirs.
**Defensibility:** still procurement GRC, still far from the call plane. **Disposition:
defer, unchanged from L5 — but record the demand signal**: two of the last five subjects
analyzed hold this; a third occurrence should trigger the owner conversation.

### L17 — Governing AI that never calls through a gateway (classical/predictive ML)
**watsonx and Fiddler both govern/monitor tabular and predictive models; Holistic audits
them.** Structural: a bank's credit-scoring model makes no API call we can intercept — our
enforcement premise does not reach it. In-repo, partial cover on the *registry* side: an
ADR-0080 use case and ADR-0081 risks can name and govern-as-objects systems that never touch
the gateway, and ADR-0083 can classify their footprints in operator-supplied evidence. What
we cannot do is measure or gate them. **Effort:** to do it properly = become watsonx; no.
**Defensibility: not our fight** — enforcement-at-the-call is the identity, per VISION.md.
**Disposition: deliberately refuse the monitoring; document the registry-side partial** (an
honest comparison-page row: "non-gateway ML: registered and risk-tracked, not measured").

### L18 — Feature-attribution explainability (SHAP/IG, embedding views)
**Fiddler (SHAP, Integrated Gradients, what-ifs), watsonx (explainability in factsheets).**
In-repo: our "why did this happen" story is traces + lineage + the audit chain (ADR-0070,
ADR-0050, ADR-0060) — decision-level explainability, not feature-level. We do not host
models, see logits, or hold features; SHAP over a third-party hosted LLM is not ours to
compute. **Disposition: deliberately refuse**, and position deliberately: for governed LLM
calls, span-level lineage of *what the model was shown and what it did* is the auditable
explanation; feature attribution is the model host's duty. Effort saved is the point.

### L19 — Analyst-quadrant and accreditation presence
**watsonx (Gartner Leader, FedRAMP Moderate), Holistic (Challenger + LL144 accreditation),
OneTrust (Gartner presence + suite incumbency), Fiddler (IL6-ready, Carahsoft).** Not a
feature and not buildable in the repo — recorded because it decides RFP shortlists the way
no feature does, and POSITIONING.md §6 already commits us to claiming no certification we do
not hold. **Disposition: needs owner decision** on when compliance-certification spend
(SOC 2 first) starts; until then the §6 absence list stands.

---

## Positioning implications

1. **Retire the implied "GRC has no runtime" line.** Holistic (Guardian Agents), OneTrust
   ("real-time guardrail enforcement", agent detection) and watsonx (Agent Monitoring) all
   now market runtime words. The defensible narrowing, per POSITIONING §1: none of them is
   **inline, per-user, default-deny at the call plane with query-backed evidence** — say
   exactly that, never the broader version.
2. **Stop treating air-gap as a tier discriminator against observability vendors.** Fiddler
   ships SaaS/VPC/on-prem/air-gapped and IL6 positioning; watsonx has air-gapped installs +
   FedRAMP. Air-gap remains a discriminator against OneTrust (no self-hosted option per 2026
   reviews) and Holistic (vague deployment docs) — per-vendor rows, not a blanket claim.
3. **New comparison-page rows this pass earns:** "Is the control enforced at call time, or
   monitored after?" · "Is evidence a query or an attestation?" · "Per-project AI cost plane"
   (none of the four) · "SDLC/PR-shaped workflow" (none of the four) · "Self-serve proof"
   (`docker compose up` vs Fiddler's demo-gated free tier and OneTrust's sales cycle) ·
   "Non-gateway ML" (them: measured; us: registered-not-measured — publish the honest row
   ourselves before a competitor does).
4. **Adopt the four one-liners** from the per-vendor sections above into POSITIONING §3,
   replacing the single grouped "vs Holistic / watsonx / ServiceNow" line with per-vendor
   lines now that we have per-vendor evidence.
5. **Do not claim against Fiddler on instrument quality** until PENDING P1 lands and our
   judge/probe paths run against a live provider — their latency and detection numbers are
   published; ours would be mechanism-without-measurement. This is the M-003 discipline
   applied to marketing.

## Already covered — near-misses caught (the method's proof section)

Candidate gaps drafted during research and **struck (or narrowed) after in-repo
verification**, per the standing rule that every lack is grep-checked before it ships:

- **"No compliance packs / EU AI Act mapping"** (assumed by multiple comparison pages for
  gateway-tier products) — struck: ADR-0058 ships eu-ai-act, nist-ai-rmf, iso-42001, hipaa,
  pci-dss, finra with query-backed evidence and cascade wiring. Same near-miss the Credo pass
  caught; it recurred and was caught again. What survives of it is only L10 (tier
  classification) and L15 (curation/feed).
- **"No AI inventory / registration intake"** (OneTrust's and watsonx's headline) — struck:
  ADR-0080 use-case registry with approval-creates-the-object, ADR-0082 standing agent
  inventory (granted vs observed).
- **"No risk register / Risk Atlas equivalent"** (watsonx Risk Atlas) — struck: ADR-0081,
  with the fixed category→resolver evidence mapping watsonx's atlas does not have.
- **"No agent/shadow discovery"** (OneTrust agent detection, Holistic shadow-AI scanning) —
  struck as absolute, survives as posture difference: ADR-0055/0071/0083 ship evidence
  ingest + a compiled 81-signature first-party classifier, deliberately no scraper — their
  continuous environment-scanning remains different in kind, by our own ADR-0083 choice.
- **"No hallucination detection"** (Fiddler, Holistic) — struck as absolute: ADR-0067
  groundedness/faithfulness scoring exists with claim-level machinery; survives only inside
  L14/L9 as the honesty note that judge-backed paths are credential-blocked (PENDING P1).
- **"No drift monitoring"** — narrowed, not struck: ADR-0044 drift sweeps + ADR-0064
  scheduler exist and gate promotion; the true lack is live-traffic/embedding drift only
  (L11 as written).
- **"No board reporting"** — struck: ADR-0047 exec reporting + ADR-0082 posture report
  (this was Credo L8, since built — the Credo doc's queue worked).
- **"No guardrails for injection/jailbreak/toxicity/PII"** (Fiddler's free-tier list) —
  struck: ADR-0042's detector set is exactly that list (`GUARDRAIL_DETECTOR_IDS`); the
  honest residue is instrument grade (L14), not absence.
- **"No automated testing / red-teaming"** (vs Holistic's "100+ tests") — struck: ADR-0057/
  0068 versioned frozen corpus, ASR with Wilson intervals (`redteam-stats.ts`), scheduled
  sweeps, MRM gating.
- **"No spend alerting/anomaly"** — struck: ADR-0049 forecasting + shape-of-spend anomaly
  signals into the Approvals Queue.

One process note for the record: the tasking referenced ADRs "0080–0084"; the repo's ADR
series ends at **0083** as of this writing (`docs/decisions/`), and nothing above cites an
ADR-0084.

## What to do about it (recommended, not started)

1. **L10 — EU-AI-Act tier classifier in the ADR-0080 intake**, deriving a recommended
   cascade tag: small, deadline-adjacent, and terminates in enforcement no competitor has.
2. **L12 — model-card auto-fill from ledgers** (ADR-0082 read-time idiom): the factsheet
   answer, better grounded than the incumbent's.
3. **L14 adapter half — external-scorer guardrail adapter**, so Fiddler/Lakera-class
   verdicts can drive our block/warn/log: turns the instrument-quality gap into an
   integration story.
4. **L9 LLM-half and L11** queue behind PENDING P1 (live provider) — both are
   measurement-shaped and would be mechanism-without-instrument today.
5. **Owner decisions needed:** L13 (does "answers are yours" survive the auto-fill race?),
   L16 (vendor-risk demand signal now at two), L19 (when does certification spend start?).
6. **Standing refusals reaffirmed:** classical-ML fairness auditing (L9 half), the
   regulatory-feed business (L15), non-gateway ML monitoring (L17), feature-attribution
   explainability (L18), training our own guardrail models (L14 half).
