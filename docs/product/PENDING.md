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
| ~~**S2**~~ | ~~**`REGULAIT_DATA_KEY` is not recorded out-of-band.**~~ **CLOSED by [ADR-0063](../decisions/0063-data-key-custody.md) (migration 0075).** The envelope split still stands (the key is not in the backup, on purpose); what was added is the custody procedure. A non-secret key fingerprint is recorded, printed at boot, written into every backup artifact, and the gateway **refuses to start** when the running key is not the one this deployment's ciphertext was written under. Custody is an audited attestation whose absence is reported on the boot line, in the portal and in every backup run. | **Residual, still open**: full **re-encryption** under a new key is not built — `REGULAIT_DATA_KEY_ROTATED_FROM` re-records the fingerprint and says outright that it re-encrypted nothing. A resumable, transactional walk over all twelve `CIPHERTEXT_COLUMNS` is named follow-up scope in ADR-0063 §4. And the attestation records a *claim*: the product cannot verify custody. |
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
| **0049** | The inline pre-dispatch acceleration gate is **not built**; the framework cost floor is unit-tested but the gateway passes `null`; per-user baselines are modelled but the evaluator computes project-level only. |
| **0050** | Content-level lineage has **no cascade switch** (metadata only). Several node subtypes exist but nothing writes them. No rebuild-from-ledgers command. |
| **0052** | Only **2 of the §4 enforcement points** are wired (`enforcementPointsWired` is on the status API). Tier flags are correct and reported but **no feature reads them yet**. `deploymentMode` is recorded, not enforced. |
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

- **`seed.test.ts` uses a fixed-name scratch database** (`regulait_seed_test`) and
  `DROP DATABASE … WITH (FORCE)` in `beforeAll`. Two concurrent suite runs on one host destroy each
  other's database. This caused spurious failures repeatedly during the build wave and is a real
  hazard for any parallel CI.
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
accounts — seed refresh + an admin agent-model edit route queued (batch B1.5). **L6 and
L24's model-judged half are now buildable** and queued behind the B-batches.

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
| **L6 governance copilot** (Credo gap; GAIA-equivalent) | Governed copilot over the governance objects — task was #143. Also converts every "mechanism-proven, instrument-unverified" claim (P1 above): judge grading (0044/0067), probe grading (0057/0068), model guardrail tiers (0042), remote training adapters (0065). |
| **L24 model-judged half** (ADR-0092) | Recommendation intelligence beyond the six deterministic rules — explicitly unapproximated today. |
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
Use-case approval does not yet GATE dispatch (0080); SoD pattern/N-way selectors (0091);
campaign scheduler/notifications + review delegation (0090); drift-forces-recertification
(0086); guardrail-path external scoring (0088 boundary); ~~pack v2 auto-profile creation
residuals (0058); `agent_config` canary still inert + rule-CRUD does not mint versions
(0073 residuals)~~ — **all three closed 2026-08-22 (batch B1: ADR-0058 + ADR-0073
amendments, migrations 0095/0096)**; what remains of those two ADRs' residual lists:
read-time-only compliance-profile shadow, no ADR-0059 blast-radius feed, no observation
pruning, the FK-cascade delete-orphan trigger, pack red-team gating presets;
key re-encryption walk (0063); `hosted`/`byoc` egress strict-by-default
(0062 residual); intent-capture flow for alignment where no use case records intent (0089);
mock-shadowing for the compaction-summarizer and decompose-worker rosters (0095 narrowed
ROUTING selection only — a mock summarizer/worker can still be picked when live agents
exist, same disease class, deliberately its own call).

## Enterprise-deal gates unchanged from §1
**P1** (credential — see above) · **P2** (HA/SLA — build when there is a customer to serve)
· **P3** (certification — L19 decision).
