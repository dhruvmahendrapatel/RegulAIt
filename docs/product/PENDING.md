# RegulAIt — What Is Not Built

**Status:** current as of 2026-08-03 (after PR #105, all 26 ADRs 0036–0061 built and deployed)

Every ADR 0001–0061 is **Accepted**. That means the *decision* is made and a real implementation
exists — it does **not** mean every clause of every ADR shipped. This file is the honest inventory
of what remains, so no one reads "26/26 Accepted" as "nothing left to do".

Ordered by what actually blocks a sale, not by ADR number.

---

## 1. The three that gate an enterprise deal

| # | Gap | Why it blocks | Where it's recorded |
|---|---|---|---|
| **P1** | **No LLM provider is connected.** The owner's key is parked by standing instruction. Dispatch runs against a mock. | Every model-dependent feature is *mechanism-proven, judgment-unverified*: LLM-as-judge (0044), the copilot's narration (0056), red-team probe grading (0057), model-backed guardrail tiers (0042). The governance, cost attribution and audit trail around them are real; the model behaviour is not exercised. | Each ADR's amendment |
| **P2** | **Single point of failure.** One EC2 box, Postgres in a container volume. Nightly verified `pg_dump` to S3 exists (0035) but HA does not. | No SLA is offerable. | [DEPLOYMENT_READINESS_CHECKLIST.md](../ops/DEPLOYMENT_READINESS_CHECKLIST.md) |
| **P3** | **No compliance attestation** (SOC 2 / ISO 27001 / ISO 42001). Deferred by owner decision. Note the customer-facing compliance *packs* (0058) are built — selling "EU AI Act mapping" does not require us to be certified. | Procurement gate at most regulated buyers. | [ENTERPRISE_READINESS_PLAN.md](ENTERPRISE_READINESS_PLAN.md) Bucket 3 |

---

## 2. Security gaps found during this build — fix before a customer install

| # | Gap | Detail |
|---|---|---|
| ~~**S1**~~ | ~~**Air-gapped is not code-enforced.**~~ **CLOSED by [ADR-0062](../decisions/0062-mode-scoped-egress.md) (migration 0074).** A deployment-wide posture is derived from `REGULAIT_DEPLOY_MODE` (server-derived, following ADR-0029's reasoning that deployment shape is not an admin toggle); `org_settings` may tighten via an enum with **no loosening member**, so the ceiling holds by construction. Under `air_gapped`, a dispatch whose adapter would use its **compiled vendor default** is refused before the adapter is constructed — enforced at model dispatch, connector invoke, git stage and PM sync, proven by a willing fetch spy recording **zero** invocations. Allow-listing the vendor host in the existing `egress_allow_hosts` table lets the same call proceed, so it is a guard and not a ban. `ANTHROPIC_BASE_URL`-style SDK overrides are now adjudicated too (they would previously have let the SDK go somewhere the guard never saw). | **Residual, still open**: `hosted` and `byoc` remain **permissive by default** — BYOC reaches real endpoints on purpose ([DATA_BOUNDARY.md](../deployment/DATA_BOUNDARY.md) §5), so strict-by-default would break existing installs; both are opt-in via the org dial. An adapter whose default base URL is not statically knowable (e.g. `snowflake`) is *refused* under strict rather than adjudicated — fails closed but coarser. Process-level egress (image pulls, ACME, cloud SDKs) is outside this guard; the network remains the stronger control. |
| ~~**S2**~~ | ~~**`REGULAIT_DATA_KEY` is not recorded out-of-band.**~~ **CLOSED by [ADR-0063](../decisions/0063-data-key-custody.md) (migration 0075).** The envelope split still stands (the key is not in the backup, on purpose); what was added is the custody procedure. A non-secret key fingerprint is recorded, printed at boot, written into every backup artifact, and the gateway **refuses to start** when the running key is not the one this deployment's ciphertext was written under. Custody is an audited attestation whose absence is reported on the boot line, in the portal and in every backup run. | **Residual**: ~~full **re-encryption** under a new key is not built~~ **CLOSED 2026-08-22 (batch B4, ADR-0063 amendment, migration 0099)** — a resumable, transactional walk over all `CIPHERTEXT_COLUMNS` (CLI: `pnpm --filter @regulait/gateway reencrypt`, with `REGULAIT_DATA_KEY_OLD` holding the old key's full hex; status-only over HTTP): per-(table,column) watermark committed in the same transaction as each batch, kill-and-resume proven with byte-identical settled rows, neither-key rows recorded and walked past with final status `completed_with_failures` never `completed`, fail-closed on any `*_ciphertext` column the registry does not name. **Still open**: the attestation records a *claim* — the product cannot verify custody. |
| **S3** | **No real release keypair.** ADR-0041's update-bundle verifier and ADR-0052's license verifier both pin a **dev** public key whose private half was not retained. | Generate offline, rotate per `infra/release-keys/` runbook, retire the dev key. |
| **S4** | Deferred by owner decision, still open: SAST/SCA/secret-scanning in CI (D3), third-party pen test (D4), WAF/DDoS at the edge (D5), HSM/FIPS option (D7). | ENTERPRISE_READINESS_PLAN Bucket 3 |

---

## 3. Structural gaps — the ADR shipped, a named half did not

These are cases where an ADR is Accepted and genuinely working, but a specific clause is
**wired-but-inert** or **absent**. Each is stated in that ADR's own amendment.

| ADR | What is structural rather than behavioural |
|---|---|
| ~~**0048**~~ | ~~**Largest single gap.** Rule and compliance-profile *versions* store, activate and roll back — but the kernels still read their own tables, so the **shadow canary for rules evaluates nothing**.~~ **CLOSED by [ADR-0073](../decisions/0073-rules-engine-versioning.md) (migration 0084), 2026-08-09.** `governedEvaluate` overlays the **ACTIVE** version of every loaded `approval_rule`/`rate_limit`/`data_scope_rule` onto its row before the kernel is called, and `profilesForTags` does the same for `compliance_profile` — so activating and **rolling back** a rule version genuinely changes evaluation, proved end to end through the kernel. The **shadow canary genuinely evaluates**: the candidate runs through the kernel a second time and each sampled comparison is stored in `config_canary_observations` with both sides' effect/ruleId/full reason. Resolution is ONE indexed query per evaluation; an artifact with versions but no active one **fails closed** (`config-version-unresolvable` deny, or a real 409 in the compliance path). **`canaryIsLive` stays FALSE for rules on purpose** — it means "the canary SERVES", and flipping it would enforce a candidate deny on a share of real work; `canaryIsEvaluated` is the new predicate and is now true for all four rule types. **Residual, still open**: ~~`agent_config` is **still vocabulary-only**~~ **CLOSED 2026-08-22 (batch B1, ADR-0073 amendment, migration 0095)** — agent_config resolves at the dispatch core (model + list price) with a genuine SHADOW canary writing `config_canary_observations`, reported `shadow` everywhere; ~~the **ordinary rule-CRUD routes do NOT mint a version**~~ **CLOSED 2026-08-22 (same amendment)** — the ADR-0074 correction established no body-edit route ever existed, and batch B1 BUILT the surface honest-first: `PATCH /v1/rules/:kind/:ruleId` mints + activates through `applyRuleEdit` on a versioned rule (plain write on an unversioned one), and `DELETE /v1/rules/:kind/:ruleId` keeps the version history while demoting active/canary pointers to `retired` with `artifact_deleted` ledger entries. **Still open**: the compliance-profile shadow is computed at READ time over the first 50 tagged projects and is never stored historically; the divergence is not yet fed to ADR-0059's blast-radius preview; there is still **no pruning** — `config_canary_observations` joins `config_versions` in growing monotonically; the FK-cascade rule-delete path (deleting a rule's subject) still orphans pointers, disclosed via `artifactDeleted` (the AFTER DELETE trigger is its own slice); and `usage_events` stamps only the PROMPT version, not the agent_config version that served. |
| **0042** | All four detectors are **heuristic rule sets, not classifiers**. Model-based and external tiers are interface-only and unwired. `semantic_dlp` sees declared markers and secret *shapes*, not scored sensitivity. Ships at `log` by default for exactly this reason. |
| **0045** | Bias/fairness is a **declared, evidenced slot — not a measurement** (needs a provider). Per-project MRM enforcement via the §8.3 cascade did not ship. |
| **0049** | The inline pre-dispatch acceleration gate is **not built**; ~~the framework cost floor is unit-tested but the gateway passes `null`~~ **CLOSED 2026-08-22 (batch B5, ADR-0049 amendment)** — `decideEnforcement` now receives the genuine ADR-0027 §9 floor, sourced per project from the SAME `complianceProfilesForTags` funnel the dispatch gate reads (`budgetEnforcement` block→'block', warn_only→'warn', none→null; untagged resolves with no query, byte-identical), proven by a block-tagged project whose `alert` policy is raised to `require_approval` on the real approvals queue with ruleId `spend-anomaly-enforced-framework-floor` while untagged and profile-less-tag controls stay alert-only; per-user baselines remain modelled-only (the evaluator computes project-level baselines — a separable, larger slice, left deliberately). |
| **0050** | Content-level lineage has **no cascade switch** (metadata only). Several node subtypes exist but nothing writes them. No rebuild-from-ledgers command. |
| **0052** | ~~Tier flags are correct and reported but **no feature reads them yet**~~ **PARTLY CLOSED 2026-08-22 (batch B5, ADR-0052 amendment)** — `sso_saml` and `scim_provisioning` are now ENFORCED at their enabling acts (`POST /v1/auth/saml-providers`, `POST /v1/scim/tokens`): 403 naming feature + tier + the flag reader's ruleId, audited deny, via `refuseIfFeatureNotLicensed` reading the same `featureEnabled` the status API reports — including the ABSENT state, which now refuses per the posture table ("every tier feature is closed") where it previously succeeded silently. Still reported-only: `compliance_packs`, `advanced_orchestration`, `airgapped_mode`, `custom_model_providers`; still unwired expansion points: connector/MCP-server/model-provider/PM-connection creation (`enforcementPointsWired` on the status API lists the four live points). `deploymentMode` is **still recorded, not enforced** — cross-checking it against the running mode is its own decision (what does a mismatched install DO?), named in the amendment rather than smuggled in. |
| **0053** | **One SDK language.** TypeScript only — Python/Go/Java are not built and not claimed. Route responses declare no schemas, so client response types are `unknown`. |
| **0054** | The **PM project/work-item importer is not built**. |
| **0055/0056/0057/0058** | Shadow-AI ingests **customer-supplied evidence only** (no traffic sniffing). The copilot's approved proposals are **not applied by anything** (no diff-applier). Red-team probes run once, not over repeated trials, and per-class gating presets aren't driven by the cascade. ~~Compliance packs don't auto-create a `compliance_profiles` row, so the §8.3 preset half is unwired~~ **CLOSED 2026-08-22 (batch B1, ADR-0058 amendment, migration 0096)**: a pack carries a `cascadePreset` as data and activation find-or-creates the profile — never overwriting an existing one — with the cascade proven enforcing end-to-end; red-team gating presets are still NOT shipped by packs, and the launch packs still carry `provenance.reviewedBy: null` — **no domain review**. |
| **0059** | Candidate is an **ABAC policy version only** — no `approval_rules`, `rate_limits` or role-grant deltas. |
| **0060** | S3 Object-Lock sink is **built but not wired** (`tamperResistant: false` is reported honestly). Measured ceiling: ~300–350 rows/s on the tip lock; concurrency does not help. |

---

## 4. One cross-cutting absence — CLOSED by ADR-0064 (2026-08-03)

**There is now an in-process scheduler.** [ADR-0064](../decisions/0064-in-process-scheduler.md)
replaced the six ad-hoc "an operator or cron must call this endpoint" disclosures with one
decision (migration 0076). All six are registered as jobs that **call the functions their
endpoints already call** — four sweeps were extracted out of their Fastify handlers rather than
duplicated, so there is exactly one implementation per sweep and the endpoints remain the
manual/on-demand door:

- ADR-0044 eval drift sweeps · ADR-0045 MRM expiry sweep · ADR-0046 SLA breach detection ·
  ADR-0047 report schedules · ADR-0049 spend evaluation · ADR-0057 red-team runs

External cron was rejected because ADR-0041 makes air-gapped the primary motion; a queue/worker
service was rejected for the second process to operate inside a single-tenant BYOC install. The
claim is a three-statement transaction taking `SELECT … FOR UPDATE` on the job's own row, so two
instances on one database cannot double-fire — proven with two schedulers, independent pools, a
counter reading exactly 1, and the loser recording a `skipped` run.

**What remains, and must be understood rather than fixed:**

- **It is OFF by default in every environment** (`REGULAIT_SCHEDULER=on` to enable). A fresh
  install still runs no sweeps until an operator opts in. The boot line, the admin page and every
  sweep endpoint's own response say so out loud, but an operator who reads none of them has the
  pre-ADR-0064 behaviour.
- **Timeliness is bounded by the box being up.** ADR-0032's nightly power-off means a sweep due
  inside the off-window simply does not run — it is picked up once, late, on the first tick after
  power-on. Catch-up policy is "once, late", deliberately.
- **It is not a job queue.** No fan-out, retry policy or per-item durability; a job that must
  outlive a deploy or run for hours needs a different mechanism, not a longer lease.
- **Two of the six cost money.** `eval-drift-sweep` and `redteam-sweep` dispatch models on every
  pass (hence a daily default, and scoped to pairs a human already chose). They run under the
  entitlements of the human who pinned the baseline / last ran the probe, and skip with a stated
  reason when that human is gone.
- **Two capabilities deliberately got NO job**: billing-period close (ADR-0051) and licence
  re-verification (ADR-0052). Cutting a period is a commercial act with an invoice on the other
  side of it. Their disclosures now say *why* rather than claiming no scheduler exists.
- **Escalation still notifies nobody** (ADR-0046's own gap, §3) — the SLA sweep detects a breach
  on time now; pushing it anywhere is still ADR-0061 territory.

The invariant that made all six survivable is unchanged and is now itself a test: MRM still
refuses a lapsed card at dispatch with the scheduler disabled entirely, and SLA breach is still
caught on read. **The sweeps buy timeliness, never correctness.**

---

## 5. Test-infrastructure debt

- ~~**`seed.test.ts` uses a fixed-name scratch database** (`regulait_seed_test`) and
  `DROP DATABASE … WITH (FORCE)` in `beforeAll`. Two concurrent suite runs on one host destroy each
  other's database. This caused spurious failures repeatedly during the build wave and is a real
  hazard for any parallel CI.~~ **CLOSED 2026-08-22 (batch B5)** — every scratch-DB suite now
  derives a per-RUN unique name (`_${pid}_${timestamp}` suffix) and drops it in `afterAll`. The
  sweep found and fixed the same disease in five more files: `audit-chain`, `data-key-custody`
  (two databases), `scheduler`, `data-key-reencrypt`, and `worker-streaming` (whose
  URL-derived name was still shared by two runs pointed at the same `DATABASE_URL`);
  `onboarding`'s drift section was already pid-suffixed. Proven both directions: two concurrent
  `seed.test.ts` runs on one `DATABASE_URL` both pass with the fix, and with the fixed name
  restored both fail (duplicate `CREATE DATABASE` in one, `database does not exist` mid-suite in
  the other). A run killed hard enough to skip `afterAll` leaves a uniquely-named orphan an
  operator can drop cold, which is the accepted residue.
- A general rule earned the hard way: **any test mutating the `ORG_SETTINGS_ID` singleton must
  restore it**, because vitest orders files by cached previous-run duration, so adding any test file
  reshuffles the order and can surface a latent leak.

---

## 6. Commercial, deferred by owner decision

- **G5** AWS/Azure/GCP Marketplace listings · **G6** in-product support, docs portal, admin guide.
- Provider-invoice importer for genuine `reconciled` billing; extract `packages/billing-provider`
  when a second backend exists.

---

## Suggested order, if the goal is a first pilot

1. **S1 + S2** — the two that make an install genuinely defensible (air-gap enforcement, key custody).
2. **P1** — connect a provider; it converts a dozen "mechanism-proven" claims into verified ones.
3. **The scheduler decision** (§4) — one ADR unblocks six features' last mile.
4. **0048's rules half** — the largest single structural gap in a shipped ADR.
5. **P2** — HA, when there is a customer to serve. Not before.

---

# Addendum — pending as of 2026-08-21 (after the competitive queue, ADRs 0062–0092)

Everything above this line is the 2026-08-03 inventory; several of its items have since
CLOSED (S1/S2 by ADR-0062/0063, §4 by ADR-0064, 0048's rules half by ADR-0073, 0057's
trials/gating by ADR-0068, 0058's cascade preset by ADR-0077-era work, 0060's sink wired +
observed by the review wave). This addendum is the complete pending set NOW — each item
states **what information or decision unblocks it**, so any future session can proceed the
moment that arrives. Recorded here because in-repo docs are the only ledger that survives
harness resets (proven twice on 2026-08-21).

## ~~Blocked on the owner's model credential~~ — UNPARKED 2026-08-21 (Google/Gemini key)
Live-instrument verification ran the same day: **V1–V7 all PASS**
([LIVE_VERIFICATION_2026-08.md](LIVE_VERIFICATION_2026-08.md), ~$0.007 total spend) — live
governed dispatch with real metering, streaming, PII-cascade-precedes-dispatch proven against
a live backend, groundedness judges (`method: model-judged`) with the keyless 422 still
holding, llm_as_judge, live-graded red-team trials with a real-denominator Wilson interval,
and routing treating the live provider as a credentialed candidate. P1's
"mechanism-proven, instrument-unverified" disclosures for the GOOGLE adapter and
judge/probe grading are now VERIFIED (other providers' adapters remain fake-server-proven).
Environmental finding: the seeded `gemini-2.5-pro` model id is retired for new Google
accounts — seed refresh + an admin agent-model edit route queued (batch B1.5). ~~**L6 and
L24's model-judged half are now buildable** and queued behind the B-batches.~~ — **both BUILT
and live-verified 2026-08-22** (see the two closed rows below). Second environmental finding
from that run, recorded here because it will recur: `gemini-3.6-flash` is a REASONING model,
so an output ceiling sized for the answer alone is a ceiling the reply never reaches — the
copilot's 1024-token narration budget produced `finishReason: MAX_TOKENS` after 981 thought
tokens and 39 tokens of JSON, and the gateway (correctly) discarded the truncated reply. Any
future internal-dispatch budget must be sized for thoughts + answer, not answer alone.

**B1.5 follow-ups CLOSED 2026-08-22** ([ADR-0095](../decisions/0095-mock-routing-honesty-and-agent-model-edit.md)):

- **F1 (owner-experienced mock-routing defect)** — a mock-provider agent is no longer a
  routing candidate while a credentialed live agent in the caller's entitled roster can
  serve (disclosed as `mock_shadowed_by_live` in `skippedCandidates`); direct mock
  invocation and the keyless demo are untouched, and `measured_cost_saved_usd` is never
  recorded where a mock served against a non-mock baseline. One residue stays open, named
  in the follow-ups section below: the compaction-summarizer and decompose-worker rosters
  are not mock-narrowed.
- **F2 (retired seed id + missing edit affordance)** — seed's google agent now pins
  `gemini-3.6-flash` (fresh installs only: the seed never mutates existing rows, stated in
  the seed), and `PATCH /v1/agents/:agentId` edits model + list prices through the
  ADR-0073/0074 versioned `agent_config` path (mint + activate for versioned agents, plain
  row write for unversioned), with a Model & pricing card on the Agents admin page.

### The table below is retained for history (written while the credential was parked)
| Item | What gets built when a credential arrives |
|---|---|
| ~~**L6 governance copilot**~~ (Credo gap; GAIA-equivalent) | **CLOSED 2026-08-22** ([ADR-0056 amendment](../decisions/0056-ai-governance-copilot.md#amendment--2026-08-22-the-copilot-goes-live-l6al6b-migration-0100), migration 0100). L6a: answers are grounded in RETRIEVED OBJECT IDS with a named grounded-refusal shape when the retrieval finds nothing, narration rides the governed dispatch (live Gemini, metered, cross-checked), and `modelNarrationVerified` became an honest per-answer flag. L6b: an APPROVED proposal is applied by an admin through the same public choke points an admin would use (`applyRuleEdit`; the one-per-kind grant removal) — `rule_to_approval` and `budget_adjustment` stay **unapplied and named**, each with the endpoint that must exist first. Still open from this line: enrolment in ADR-0057 red-teaming with a promotion-blocking gate. |
| ~~**L24 model-judged half**~~ (ADR-0092) | **CLOSED 2026-08-22** ([ADR-0092 amendment](../decisions/0092-access-recommendations.md#amendment--2026-08-22-the-model-judged-half-as-an-annotation-and-nothing-else-l6c-migration-0100), migration 0100). Opt-in, default-off org knob; when on AND a judge is dispatchable (ADR-0067's own `judgeAvailabilityFor`) each DETERMINISTIC finding may carry a `method: "model-judged"` annotation that can neither create a finding nor touch its evidence/severity — asserted byte-identical against the knob-off report. Judge unreachable → report unchanged + `judged: unavailable`. The campaign feed (the only action path) never consults the judge. |
| **L9 LLM-half bias/fairness** (four-vendor doc) | Measured bias/fairness for LLM outputs; classical-ML audit business stays refused. |
| **L13 AI pre-fill of assessments** | ALSO needs the owner decision below — credential alone is not consent. |

## Blocked on an explicit owner decision (a sentence from the owner unblocks)
| Item | The decision needed |
|---|---|
| **L13 assessment AI pre-fill** (four-vendor L13) | Whether pre-filling questionnaires is acceptable at all — it collides with ADR-0080's deliberate "the answers are yours" stance. |
| **L19 certification spend** | Whether to pursue SOC 2 / ISO 27001/42001 for RegulAIt itself (P3 above; money + auditor, not code). |
| **PII floor default** | `defaultPiiMode` ships `none` (behaviour-preserving); one PUT flips deployment-wide. Recommend `block` for any shared install. |
| **Pillar-6 savings semantics** (two questions, STATE.md Open Questions) | How optimizer savings are counted/attributed in edge cases. |
| **Session-narrowing issuance scope; mirror-failure persistence** | Recorded in STATE.md open decisions since the review wave. |

## Blocked on a live instrument/integration (credentials or a real endpoint)
| Item | What unblocks |
|---|---|
| **L11 live-traffic/embedding drift** (four-vendor) | A live provider plus real traffic; ADR-0044/0064 sweeps stay dataset-anchored until then. |
| **Live Jira/PM verification** (market queue #5) | Customer/PM-tool credentials — adapters are fake-server-proven. |
| **External-scorer live verification** (ADR-0088) | A real scoring endpoint; contract + governance proven against a local fake. |
| **S3 (real release keypair)** | Offline key ceremony per `infra/release-keys/` runbook; dev key still pinned. |

## Deliberate refusals — re-open only on explicit owner pull (all recorded with reasons)
Fabric-wide identity/service-account discovery and the identity fabric itself (Saviynt
L25/L26 — "we integrate with your IGA, we do not compete for it", ADR-0089ff); vendor-named
shadow-AI scrapers (ADR-0071/0083); the regulatory-intelligence feed business (ADR-0087);
non-gateway ML monitoring and SHAP-style explainability (four-vendor L17/L18); classical-ML
bias-audit business (L9 note).

## Named follow-ups riding shipped ADRs (buildable anytime, none blocking)
~~Use-case approval does not yet GATE dispatch (0080)~~ — **closed 2026-08-22 (batch B3a,
ADR-0080 amendment, migration 0098)**: org opt-in `use_case_gate_mode` (off|warn|enforce,
default off = byte-identical); enforce refuses a governed dispatch attributed to a
use-case-LINKED project (the honest optional `project_id` join — unlinked/unattributed
dispatch untouched in every mode) with a named 409 before any provider work; warn records the
refusal-shaped fact without blocking; ~~**still open from that line**: nothing mandates that a
dispatch be attributed to a linked project at all — attribution stays the pillar-5 opt-in, so
the gate cannot see a call naming no project~~ — **closed 2026-08-22 (batch B6b, ADR-0080
amendment, migration 0101)**: org opt-in `dispatch_attribution_required` (default off =
byte-identical) refuses a governed dispatch naming NO `projectId` with a named 409
`attribution_required`, audited, before any provider work; the two knobs are INDEPENDENT by
construction (this acts only where projectId IS NULL, the use-case gate only where it is NOT,
so there is no precedence rule) and all four combinations are a committed test; the compat
shims' `require_project_attribution` (ADR-0020) and the MCP proxy's `require_mcp_attribution`
(ADR-0024 O11) are neither replaced nor duplicated — three distinct error names for three
distinct edges; **remaining**: it refuses a MISSING project, never a WRONG one, and a project
no use case links is still untouched in every mode (ADR-0080's honest join, unchanged); ~~SoD pattern/N-way selectors (0091)~~
— **closed 2026-08-22 (batch B2c, ADR-0091 amendment, migration 0097)**: N-way sets (2..8,
refused only on the FULL set — any N-1 subset allowed) plus pattern selectors over exactly
three enumerable dimensions (agent lifecycle status, agent provider kind, connector mode;
no free-regex, resolved at check time against current objects); ~~campaign
scheduler/notifications + review delegation (0090)~~ — **the scheduler and reassignment
halves closed 2026-08-22 (batch B2a/B2b, ADR-0090 amendment)**: an off-by-default ADR-0064
job records one audited `campaign-expired-incomplete` fact per past-due campaign (it decides
NOTHING — expiry stays breach-on-read), and admin item reassignment exists (audited,
reason-required, riding ADR-0046's one approver-moving write, never to the grant's holder);
**still open from that line**: notifications (nobody is emailed at a deadline) and periodic
auto-campaigns (deliberately refused in the ADR), while review DELEGATION was always ADR-0022's
existing mechanism, unchanged; ~~drift-forces-recertification
(0086)~~ — **closed 2026-08-22 (batch B3b, ADR-0086 amendment, migration 0098)**: org opt-in
`mrm_staleness_recert_enabled`/`_threshold` (default off/1) deepening the ADR-0045 dispatch
gate — a live-certified card whose `computeCardStaleness` drift count reaches the threshold
refuses on the expiry gate's own 409 path with the evidence named, recertification resets the
clock, and with `mrm_enforced` off the knob gates nothing (it creates no gate of its own);
guardrail-path external scoring (0088 boundary); ~~pack v2 auto-profile creation
residuals (0058); `agent_config` canary still inert + rule-CRUD does not mint versions
(0073 residuals)~~ — **all three closed 2026-08-22 (batch B1: ADR-0058 + ADR-0073
amendments, migrations 0095/0096)**; what remains of those two ADRs' residual lists:
read-time-only compliance-profile shadow, no ADR-0059 blast-radius feed, no observation
pruning, the FK-cascade delete-orphan trigger, pack red-team gating presets;
~~key re-encryption walk (0063)~~ — **closed 2026-08-22 (batch B4, ADR-0063 amendment,
migration 0099)**: resumable transactional walk over `CIPHERTEXT_COLUMNS` as a CLI with
per-batch watermark, honest `completed_with_failures`, fail-closed registry check, and
boot-time incomplete-walk awareness; `hosted`/`byoc` egress strict-by-default
(0062 residual); ~~intent-capture flow for alignment where no use case records intent
(0089)~~ — **closed 2026-08-22 (batch B3c, ADR-0089 amendment)**: intended agents are captured
through the existing PATCH + the use-case detail's new field, feeding the ONE
`intendedAgentIds` column the alignment reads, editable only pre-decision (post-decision
intent edits refused by name — changing intent after approval is a NEW use case), proven
end-to-end propose → capture → approve → aligned/undershoot on the inventory;
~~mock-shadowing for the compaction-summarizer and decompose-worker rosters (0095 narrowed
ROUTING selection only — a mock summarizer/worker can still be picked when live agents
exist, same disease class, deliberately its own call)~~ — **closed 2026-08-22 (batch B6a,
ADR-0095 amendment, no migration)**: the rule is now ONE reused predicate
(`mockShadowedByLive`) consumed by all three rosters, so a mock can no longer summarize a
conversation or plan a task graph while a credentialed live agent in the same roster can
serve; the keyless demo is byte-identical (nothing is shadowed unless a non-mock member of
the SAME roster is dispatchable), an explicit choice is still honoured (routing's requested
agent, ADR-0021's `summarizerSelection: 'fixed_agent'`, decompose's `leadAgentId`), the skip
is disclosed as `mock_shadowed_by_live` on both new audit rows, and neutralising the one
predicate reddens ADR-0095's own routing test alongside the three new ones — which is what
proves the reuse; **remaining**: offline-only proof (stubbed adapter, as F1), and a
decision-only invoke still previews mocks (it executes nothing);
~~**ENTITY-AWARE COPILOT PLANNING (0056 L6d residual, added 2026-08-22)** — the copilot's
NL-to-query step is keyword-based, so an entity named in a question that matches no keyword
rule is silently IGNORED rather than narrowing the query.~~ **CLOSED 2026-08-22
([ADR-0096](../decisions/0096-entity-aware-copilot-planning.md), no migration)**: candidate
subjects are extracted DETERMINISTICALLY (quoted spans, uuids, conservative capitalised runs —
never a model call, because a model must never assert that an entity exists) and resolved by a
real, exact-match, entitlement-scoped lookup over six kinds whose visibility rules are all
re-uses of predicates the product already enforces. A named subject is now either **filtered
on** (the plan carries the object, the SQL genuinely narrows — proved by row-count difference,
not by a reported filter) or **refused by name** in one of three distinguishable shapes:
unresolved, ambiguous (candidates listed, never a tiebreak), or resolved-but-this-tool-cannot
-filter-that-kind. The scope-honesty rule — an invisible object refuses byte-identically to a
nonexistent one — is proved with two users. `subjectFiltered`'s meaning narrows to "narrowed to
your subject" whenever a subject was named; the L6d caveat is KEPT for questions that name none.
**What is still open**: extraction is conservative, so a subject with no capitals, quotes or id
is still missed and falls through to L6d's caveated broad answer; resolution is exact-match, so
a near-miss refuses rather than suggests; and **MCP servers/tools, compliance packs, AI use
cases, AI risks, workflow templates, initiatives and roles remain UNRESOLVABLE** — MCP is the
most valuable next slice and is blocked on the per-(user, server) tool-level visibility
predicate plus the non-global uniqueness of `mcp_tools.name`. Vendors resolve but no ledger can
filter by them, so a vendor question can only end in the tool/kind refusal; there is no
attribution column or join to add one today.

## Enterprise-deal gates unchanged from §1
**P1** (credential — see above) · **P2** (HA/SLA — build when there is a customer to serve)
· **P3** (certification — L19 decision).
