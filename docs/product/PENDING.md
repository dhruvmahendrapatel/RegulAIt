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
| ~~**S5**~~ | ~~Operator free text is scrubbed in `audit_log` and stored VERBATIM in 47 other columns.~~ **CLOSED 2026-09-06 ([ADR-0102](../decisions/0102-operator-prose-credential-scrub.md), no migration).** The briefed fix (a zod refinement on shared reason schemas) was **measured and rejected**: there are **0 shared reason schemas against 63 ad-hoc inline `z.string()` declarations**, so it would have been the per-call-site convention ADR-0099 rejected, in a zod costume. Sited instead in the `createDb` Proxy ADR-0060 already installed — which is not audit-specific — composing OUTSIDE `withAuditChain` and intercepting `insert().values()`, `onConflictDoUpdate({set})` and `update().set()`, with `transaction()` re-wrapped (load-bearing: `approvals.decision_reason` is written inside the decide route's own transaction). **51 columns covered, 3 excluded by name** (`audit_log.reason` — ADR-0099 owns it pre-hash and double-scrubbing would nest a marker inside a marker; `mcp_registry_entries.conflict_reason` — a two-member enum; `usage_events.stop_reason` — provider vocabulary on the hottest write path). Retested live: the exact S5 case inverted — the AWS key is now `[redacted:aws_key:20:1a5d44a2dca1]` in `mcp_servers.admission_clear_reason` **and the marker is character-identical to the audit row's**, which is the defect S5 actually named; `approvals.decision_reason` scrubbed inside its transaction; ordinary prose (uuid, ticket id, "1200 tokensIn") byte-identical. | Coverage is **structural, not a snapshot**: a test asks `information_schema` — not the TypeScript — for every matching column and fails if any is neither covered nor excluded, so a hand-authored migration cannot slip past. Guard widened `c90a403` to the same patterns as the sweep that FOUND S5 (`%justification%`, `%comment%`), and proven non-vacuous by adding `approvals.override_justification` to a fresh schema. |
| **S6** | **~34 content columns still store operator text verbatim** — `name`, `title`, `description`, `summary`, `body` across templates, agents, projects and packs. ADR-0102 covers *justification prose* (reason/note/rationale/explanation); it deliberately does not cover *content*. A secret pasted into a template description or an agent name is stored exactly as typed. Disclosed by ADR-0102 itself; recorded here so it does not disappear inside S5's closure. | A decision, not an extension. The safety case for ADR-0102 is that prose loses nothing to redaction; a `description` is content a user may legitimately need byte-exact, so widening the same mechanism there needs its own judgement about what is being protected and what is being damaged. Three further limits inherited unchanged and worth stating together: it is **application-layer only** (a raw `psql` or an independent `Pool` bypasses it — a DB trigger remains strictly stronger, the same follow-up ADR-0060 records), detection is **shape-based** so a shapeless pasted secret is not caught, and **historical rows are deliberately not migrated** because rewriting a stored reason is an edit to the record. |
| **S3** | **No real release keypair.** ADR-0041's update-bundle verifier and ADR-0052's license verifier both pin a **dev** public key whose private half was not retained. | Generate offline, rotate per `infra/release-keys/` runbook, retire the dev key. |
| **S4** | Deferred by owner decision, still open: SAST/SCA/secret-scanning in CI (D3), third-party pen test (D4), WAF/DDoS at the edge (D5), HSM/FIPS option (D7). | ENTERPRISE_READINESS_PLAN Bucket 3 |

---

## 3. Structural gaps — the ADR shipped, a named half did not

These are cases where an ADR is Accepted and genuinely working, but a specific clause is
**wired-but-inert** or **absent**. Each is stated in that ADR's own amendment.

| ADR | What is structural rather than behavioural |
|---|---|
| ~~**0048**~~ | ~~**Largest single gap.** Rule and compliance-profile *versions* store, activate and roll back — but the kernels still read their own tables, so the **shadow canary for rules evaluates nothing**.~~ **CLOSED by [ADR-0073](../decisions/0073-rules-engine-versioning.md) (migration 0084), 2026-08-09.** `governedEvaluate` overlays the **ACTIVE** version of every loaded `approval_rule`/`rate_limit`/`data_scope_rule` onto its row before the kernel is called, and `profilesForTags` does the same for `compliance_profile` — so activating and **rolling back** a rule version genuinely changes evaluation, proved end to end through the kernel. The **shadow canary genuinely evaluates**: the candidate runs through the kernel a second time and each sampled comparison is stored in `config_canary_observations` with both sides' effect/ruleId/full reason. Resolution is ONE indexed query per evaluation; an artifact with versions but no active one **fails closed** (`config-version-unresolvable` deny, or a real 409 in the compliance path). **`canaryIsLive` stays FALSE for rules on purpose** — it means "the canary SERVES", and flipping it would enforce a candidate deny on a share of real work; `canaryIsEvaluated` is the new predicate and is now true for all four rule types. **Residual, still open**: ~~`agent_config` is **still vocabulary-only**~~ **CLOSED 2026-08-22 (batch B1, ADR-0073 amendment, migration 0095)** — agent_config resolves at the dispatch core (model + list price) with a genuine SHADOW canary writing `config_canary_observations`, reported `shadow` everywhere; ~~the **ordinary rule-CRUD routes do NOT mint a version**~~ **CLOSED 2026-08-22 (same amendment)** — the ADR-0074 correction established no body-edit route ever existed, and batch B1 BUILT the surface honest-first: `PATCH /v1/rules/:kind/:ruleId` mints + activates through `applyRuleEdit` on a versioned rule (plain write on an unversioned one), and `DELETE /v1/rules/:kind/:ruleId` keeps the version history while demoting active/canary pointers to `retired` with `artifact_deleted` ledger entries. ~~**Still open**: the compliance-profile shadow is computed at READ time over the first 50 tagged projects and is never stored historically; the divergence is not yet fed to ADR-0059's blast-radius preview~~ — **both CLOSED 2026-08-23 (batch B8b, ADR-0073 amendment, no migration)**: the divergence read now WRITES THROUGH into `config_canary_observations` (dedup key = candidate × project × sha256 fingerprint of both effective bodies; re-reads write nothing — retested live; the 50-project cap stands, now visible in each row's detail; B7c's prune covers these rows with the live-canary guard unchanged), and `POST /v1/policy-simulations` + its GET surface recorded profile divergence as the named read-only field `complianceProfileCanaryDivergence` (byte-absent without recorded divergence — both legs retested live). Still open from this pair: the RULE canary's per-decision divergence is not on the preview (its own aggregation slice); ~~there is still **no pruning**; the FK-cascade rule-delete path still orphans pointers; and `usage_events` stamps only the PROMPT version~~ — **all three CLOSED 2026-08-22 (batch B7c, ADR-0073 amendment, migration 0102)**: `canary-observation-prune-sweep` (10th ADR-0064 job + manual door + org knob `canaryObservationRetentionDays`, default 90d) prunes OBSERVATIONS ONLY — `config_versions` are never pruned and a live canary's evidence is kept regardless of age (retested live: pruned=1, keptLiveCanary=1, versions intact, audited fact); `config_versions_retire_on_subject_delete()` AFTER DELETE triggers on the four rule tables + `agents` give raw-SQL/cascade deletes the exact route semantics, writing the activation ledger (deliberately not the hash-chained audit_log), retested live with a trigger-authored `artifact_deleted` entry; and `usage_events.agent_config_version_id`+`_version` stamp what SERVED (FK-free like the prompt stamp, NULL for unversioned, never the shadow candidate), retested live across a v3→v4 activation flip. New disclosed residue: pruning is age+canary-protection only — no per-artifact row cap. |
| **0042** | All four detectors are **heuristic rule sets, not classifiers**. Model-based and external tiers are interface-only and unwired. `semantic_dlp` sees declared markers and secret *shapes*, not scored sensitivity. Ships at `log` by default for exactly this reason. |
| **0045** | Bias/fairness is a **declared, evidenced slot — not a measurement** (needs a provider). Per-project MRM enforcement via the §8.3 cascade did not ship. |
| **0049** | The inline pre-dispatch acceleration gate is **not built**; ~~the framework cost floor is unit-tested but the gateway passes `null`~~ **CLOSED 2026-08-22 (batch B5, ADR-0049 amendment)** — `decideEnforcement` now receives the genuine ADR-0027 §9 floor, sourced per project from the SAME `complianceProfilesForTags` funnel the dispatch gate reads (`budgetEnforcement` block→'block', warn_only→'warn', none→null; untagged resolves with no query, byte-identical), proven by a block-tagged project whose `alert` policy is raised to `require_approval` on the real approvals queue with ruleId `spend-anomaly-enforced-framework-floor` while untagged and profile-less-tag controls stay alert-only; per-user baselines remain modelled-only (the evaluator computes project-level baselines — a separable, larger slice, left deliberately). |
| **0050** | Content-level lineage has **no cascade switch** (metadata only). Several node subtypes exist but nothing writes them. No rebuild-from-ledgers command. |
| **0052** | ~~Tier flags are correct and reported but **no feature reads them yet**~~ **PARTLY CLOSED 2026-08-22 (batch B5, ADR-0052 amendment)** — `sso_saml` and `scim_provisioning` are now ENFORCED at their enabling acts (`POST /v1/auth/saml-providers`, `POST /v1/scim/tokens`): 403 naming feature + tier + the flag reader's ruleId, audited deny, via `refuseIfFeatureNotLicensed` reading the same `featureEnabled` the status API reports — including the ABSENT state, which now refuses per the posture table ("every tier feature is closed") where it previously succeeded silently. ~~Still reported-only: `compliance_packs`, `advanced_orchestration`, `airgapped_mode`, `custom_model_providers`; still unwired expansion points: connector/MCP-server/model-provider/PM-connection creation (`enforcementPointsWired` on the status API lists the four live points).~~ **CLOSED 2026-08-22 (batch B7b, ADR-0052 amendment)** — all four flags enforce at their enabling acts (pack ACTIVATION / `POST /v1/runs/decompose` / air-gapped deploy-target creation / custom-provider creation; pack authoring and basic hand-authored runs stay open) and connector/MCP-server/model-provider/PM-connection creation are wired expansion-class; `enforcementPointsWired` reports **11** points. Retested live on an ABSENT license: four 403s naming feature + `license-absent-feature-closed`, audited; pack seeding and a basic run still succeed. Honest non-close recorded in the amendment: no §4 flag exists for connector/MCP/PM creation (adding tier-matrix features is a licensing-schema decision) `deploymentMode` is **still recorded, not enforced** — cross-checking it against the running mode is its own decision (what does a mismatched install DO?), named in the amendment rather than smuggled in. |
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

- ~~**S9 — 103 at-risk TEST sites still unswept, plus two unswept syntactic shapes**~~ **CLOSED
  2026-09-09 ([ADR-0108](../decisions/0108-test-side-unordered-reads.md)).** The "103" was a count of
  syntactic candidates, not of defects: instrumenting 145 of 148 sites and measuring them under the
  real shared-database condition showed **only nine can match more than one row**, six of which
  assert something true of every matching row. **Three fixed, all pinned rather than ordered.**
  **The finding that outranks the sweep**: two of those three tests were **vacuous, not flaky** —
  they pass while reading the wrong row (`credentials-keys` asserts `not.toContain(...)`, which a
  foreign row satisfies trivially). Original scope note retained below for the record.

- **S9 (original framing, superseded above) — 103 at-risk TEST sites, plus two unswept syntactic
  shapes (opened 2026-09-09, ADR-0107).** N2 swept production (19 fixed, 11 deferred to constraints) but deliberately stopped
  there. The remaining test sites cluster in `cost-import.test.ts` (9), `spend-monitor.test.ts` (8),
  `data-key-custody.test.ts` (7), `shadow-ai-adapters.test.ts` (7), and by table over `audit_log`
  (15), `shadow_ai_findings` (12), `imported_cost_lines` (11). Each is a latent intermittent of
  exactly the shape that has now bitten four times. **Separately**, the scan matched only
  `const [x] = await db.select()` and `.limit(1)`; **`.at(-1)`, `rows[0]`, `sql.raw` and
  `Promise.all` destructuring are unmatched** — and the `use-cases-eu-tier` flake was an `.at(-1)`,
  so that class is known real and known unswept. A follow-up batch owes both.

- ~~**S10 — eleven production sites want a UNIQUE CONSTRAINT**~~ **CLOSED 2026-09-09
  ([ADR-0109](../decisions/0109-deferred-unique-constraints.md), migration 0108)** — **nine added,
  two refused on evidence.** `data_key_state` needed nothing: ADR-0107's "singleton by convention
  only" was factually wrong, as migration 0075 already gives it a PK plus `CHECK (id='singleton')`.
  `backup_runs` was **refused because the constraint would break a governance decision** — see S11.
  Original entry retained below.

- **S11 — `backup_runs` re-opens a miss while a restore is pending (found 2026-09-09).** The
  idempotency read matches only `status='missed'` (`infra.ts:198`); proposing a restore sets
  `restore_proposed` (`:1397`); denying sets it back to `missed` (`:734`). So a re-scan between
  propose and deny inserts a SECOND `missed` row, and with a unique constraint the **deny would fail
  with 23505 — an operator could not refuse a restore.** The constraint was therefore not added.
  The fix is to widen the idempotency read to `status IN ('missed','restore_proposed')`, but that is
  a behaviour change owed a product answer: **should a re-scan re-open a miss while a restore is
  pending?** Until then the duplicate is visible through the advisory pre-flight.

- **S12 — the duplicate pre-flight is wired into nothing (found 2026-09-09).** ADR-0109 ships
  `deferred-unique-preflight.ts` and `scripts/preflight-unique-constraints.mjs` so an operator can
  see what would block migration 0108, but no CI job or deploy step runs it, and today it depends on
  someone reading the migration header. **A check nobody runs is worth nothing.** Small, and it is
  the natural companion to F01/PF-04's "one pinned verification command".

- **S10 (original entry, superseded above) — eleven production sites want a UNIQUE CONSTRAINT, not an ORDER BY (opened 2026-09-09).**
  Deferred out of ADR-0107 because a schema change deserves its own decision. The reasoning is
  worth keeping: an `ORDER BY` *accommodates* a second row, a constraint *states and enforces* that
  there should not be one. Sites: `approval_id` on `grant_certification_items`,
  `model_card_approvals`, `training_jobs`, `sod_override_requests`; `workflow_instance_id` on
  `ai_use_cases`, `ai_vendors`; `cert_inventory(resource_id, common_name)`; `backup_runs`;
  `trace_spans(trace_id, run_id) WHERE kind='run'`; `data_key_state` (a singleton by convention
  only); and **`users(lower(email))`** — the most valuable, and the real fix behind the case-folded
  login lookup that ADR-0107 could only make deterministic.

- **S8 — a FOURTH intermittent, order-dependent test failure. OPEN, and NOT diagnosed (2026-09-08).**
  `compat-longtail.test.ts` — *"THE ASYMMETRY, provider side"* — asserts that a dispatch to an
  `anthropic`-provider agent with no credential configured returns **409 `no_model_credential`**.
  On one full-suite run it returned **500**. Observed **once in four** post-ADR-0106 runs
  (`n1w1` exit 1; `n1w2`, `diag1`, `diag2` all exit 0 at 2688 passed). It passes **3/3 in
  isolation** on a fresh database, so it is order/state-dependent inside the shared database, not a
  defect of that file in itself. A temporary probe was added to capture the 500 body and the suite
  re-run twice more; **it did not reproduce**, so the probe was reverted and no diagnosis was
  reached. Recorded rather than guessed at.

  **Investigated 2026-09-09 — two hypotheses ELIMINATED with evidence, cause still unknown.**
  The 409 requires three simultaneous absences (`agents-connectors.ts:1636`): no user credential,
  no platform credential, and no env-key fallback. So a 500 means one of them was present.
  - **A leaked PLATFORM credential — eliminated.** `model_credentials` is **empty** in the failing
    run's surviving database *and* in a passing one. Both files that write an anthropic platform
    credential (`env-fallback`, `setup-status`) delete it in `afterAll`.
  - **An unrestored `ANTHROPIC_API_KEY` — eliminated for the two files that set it.**
    `env-fallback.test.ts` and `setup-status.test.ts` both `clearEnv()` *first* in `afterAll` and
    then restore only originally-defined vars, so a var that started unset ends unset;
    `setup-status` also clears inline immediately after use. Neither leaks.
  - **Confirmed and relevant**: `org_settings.env_key_fallback_enabled` is `true` with `anthropic`
    allow-listed at end-state in **every** run, failing and passing alike. That is the shared
    singleton which makes the 409 depend entirely on whether `process.env.ANTHROPIC_API_KEY` is set
    at that instant — so the remaining suspect is a *transient* process-env or timing condition,
    not stored state.

  **Why the forensics stopped there, stated honestly**: the state that would settle it —
  `process.env` at that moment — is not persisted, so comparing end-state databases cannot reach
  it, and the failure did not reproduce under instrumentation. What remains is a stress/repeat
  approach or per-file env assertions, not more reading. **No further guess is recorded here**;
  the previous entry's hypothesis is withdrawn as eliminated, not carried forward.

  **Consequence for F01**: the `socket.destroySoon` half is closed and proven (0 occurrences in 4
  runs), but F01's acceptance criterion — *repeated runs complete with no unhandled errors AND
  consistent exit status* — is **not yet met**, because this unrelated intermittent still moves the
  exit code. ADR-0106 closed a cause; it did not make the suite deterministic on its own. **F01
  stays OPEN.**

- **S7 — TWO ADJACENT VOCABULARIES FOR ONE CONCEPT (found 2026-09-08).** `audit_log.effect` and the
  kernel's `DecisionEffect` spell it **`require_approval`**; `GovernedToolCallOutcome.kind` spells
  it **`approval_required`**. Both are correct inside their own domain, and neither is worth the
  wide, risky rename — but the pair is a live hazard, because an assertion or a switch that reaches
  for the wrong one is silently almost-always right. It has already caused one defect:
  `zz-zz-copilot-live.test.ts` asserted audit-row labels against the OUTCOME vocabulary, so a cited
  `require_approval` row could never satisfy it, and the test passed for as long as its scoped
  retrieval happened to sample none (fixed `d8aa906`). Recorded as a **cause**, not an instance:
  any future assertion over either surface can repeat it. A cheap mitigation, if one is ever
  wanted, is to export the enum from `@regulait/db` and assert against the constant rather than a
  hand-typed literal.

- **The gateway suite's EXIT CODE is not trustworthy (found 2026-09-06).** Two unhandled
  `TypeError: socket.destroySoon is not a function` exceptions escape while
  `apps/gateway/src/mcp-admission-auth.test.ts` runs (ADR-0097's own e2e file, which starts real
  local HTTP upstreams). All tests pass — 166 files / 2583 + 9 skips — but `vitest` exited **0 on
  one run and 1 on the next with the identical two errors**, so the exit code is a coin flip.
  Two reasons this is not cosmetic: (a) **local verification is this project's only quality gate**
  (CI is Actions-cap-blocked), so a non-deterministic exit code trains readers to judge by the
  summary line and ignore the status — precisely the habit that lets a real failure through; and
  (b) vitest itself warns *"This might cause false positive tests"*, which means the suite's
  verdict is not fully sound while these are unresolved. Not attributable to any slice after
  B9 — present in every post-ADR-0097 run checked.

  **ATTRIBUTION CORRECTED 2026-09-07 (B13a retest).** An earlier revision of this entry said the
  `@hono/node-server` attribution was a misattribution because "that package is not in this repo
  at all". **That correction was itself wrong, and is withdrawn.** The package IS present, as a
  TRANSITIVE dependency of `@modelcontextprotocol/sdk@1.29.0` (`pnpm-lock.yaml:4223`) — which is
  why it appears in no workspace `package.json` and why a direct-dependency check missed it. The
  stack frame is unambiguous:
  `Timeout.forceClose (@hono/node-server@1.19.15/dist/index.mjs:390:14)` ← `listOnTimeout`. So the
  fix is NOT ours to make inside the test file alone: a timer inside the MCP SDK's bundled HTTP
  server fires after the socket has already been torn down. Mitigations available to us: await the
  upstream servers' close before the transport's, or keep the socket alive until the SDK transport
  is done with it.

  **Intermittency measured 2026-09-07** — three full runs of the IDENTICAL commit (`9aea2ae`):
  run A 2663 passed / 1 failed with the unhandled error present, exit 1; run B 2664 passed /
  0 failed with **zero** unhandled errors, exit 0; the agent's own run matched B. So the
  `destroySoon` error is itself intermittent, not a constant that only sometimes changes the exit
  code — which is a different and slightly better-behaved bug than this entry previously described.

- **A SECOND, independent non-determinism source — found and fixed 2026-09-07 (B13a retest).**
  Run A's single failure was `use-cases-eu-tier.test.ts:260`, and it was NOT the `destroySoon`
  issue and NOT caused by B13a. `screeningAudits` selected from `audit_log` with a WHERE and **no
  `ORDER BY`**, then the v2-recompute assertion indexed the result with `.at(-1)`. Postgres
  guarantees no row order without `ORDER BY`, so that read heap order — usually insertion order,
  occasionally not. Fixed in `0ebfabe` by ordering on `at`. Recorded here because it establishes
  that the suite had **two** unrelated flake sources, and the exit-code entry above was absorbing
  the blame for both.

- **OPEN — the same defect class is probably not isolated.** `.at(-1)` appears **86 times** across
  the gateway tests. Most index API-response arrays, which carry the route's own ordering, so this
  is NOT 86 bugs — but every one that indexes a raw `db.select()` without an `ORDER BY` is the same
  latent flake. A sweep belongs with F01's "make the quality gate dependable" work; it was
  deliberately not widened into B13a.

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

**Quota status 2026-08-22 (evening):** the key hit its Google quota ceiling during the B6
live retest ("You exceeded your current quota" — provider-side 502s on otherwise-passing
calls). Every gate, refusal, disclosure, and row-delta in that retest was proven before or
despite the ceiling; what is parked until the owner refreshes quota (or supplies another
key) is further *narration-content* live work — new live copilot answers, live judge
annotations, live-graded red-team runs. Everything committed still passes keyless.

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
| ~~**L6 governance copilot**~~ (Credo gap; GAIA-equivalent) | **CLOSED 2026-08-22** ([ADR-0056 amendment](../decisions/0056-ai-governance-copilot.md#amendment--2026-08-22-the-copilot-goes-live-l6al6b-migration-0100), migration 0100). L6a: answers are grounded in RETRIEVED OBJECT IDS with a named grounded-refusal shape when the retrieval finds nothing, narration rides the governed dispatch (live Gemini, metered, cross-checked), and `modelNarrationVerified` became an honest per-answer flag. L6b: an APPROVED proposal is applied by an admin through the same public choke points an admin would use (`applyRuleEdit`; the one-per-kind grant removal) — ~~`rule_to_approval` and `budget_adjustment` stay **unapplied and named**~~ — **applied 2026-08-23 (batch B8c, ADR-0056 amendment)**: both ride PRE-EXISTING public routes through extracted shared implementations (`POST /v1/rules/approvals` via `createApprovalRuleRow`; `PATCH /v1/projects/:id` via `applyProjectPatch`, honestly scoped to project budgets), the applier runs each route's OWN zod with issues surfaced verbatim, and all refusal legs are pinned (pending, second-apply, target-gone, schema-refused, smuggled-field) — retested live end-to-end. Still open from this line: enrolment in ADR-0057 red-teaming with a promotion-blocking gate. |
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
a near-miss refuses rather than suggests; ~~and **MCP servers/tools**, compliance packs, AI use
cases, AI risks, workflow templates, initiatives and roles remain UNRESOLVABLE — MCP is the
most valuable next slice and is blocked on the per-(user, server) tool-level visibility
predicate plus the non-global uniqueness of `mcp_tools.name`~~ — **MCP closed 2026-08-22 (batch
B6c, ADR-0096 amendment, no migration)**: both named blockers solved — visibility RE-USES the
kernel's own `loadEntitlements` + `visibleTools` pair (the one the MCP proxy enforces per call),
proved tool-level by a one-tool grantee who resolves `Docs/lookup` and gets the ordinary
unresolved refusal for `Docs/digest` on the SAME server; and non-global uniqueness is solved by
REFUSING — a bare tool name on two servers is the existing ambiguous outcome, listing both
candidates server-qualified and never tie-breaking, while `server/tool` resolves uniquely
because `mcp_servers.name` is globally unique. Both MCP kinds filter on all FOUR read tools
(`audit_log`/`approvals` carry first-class `server_id`+`tool_name`; `usage_events` narrows via
`object_type`+`operation`+`detail->>'serverId'`), so `listApprovals` gains a kind for the first
time and no fourth outcome was added — the tool/kind refusal is simply unreachable for MCP. The
mandatory no-op-filter probe reddens 5 tests (`expected 12 to be 3` …). ~~**Still unresolvable**:
compliance packs, AI use cases, AI risks, workflow templates, initiatives, roles, virtual
keys~~ — **all seven closed 2026-08-22 (batch B7a, ADR-0096 amendment)**: initiative and
virtual_key filter across multiple ledgers with row-delta proofs (initiative via its project
set on all four tools; virtual_key via first-class `usage_events.virtual_key_id` + audit
`object_type`), the other five are audit-filterable via `object_type` values the gateway
already writes (every other tool refuses with `copilot_tool_cannot_filter_entity` naming the
kind), each reusing its own list endpoint's visibility (admin-only kinds resolve only for
admins — real ≡ nonexistent for everyone else, proved byte-identically). Live-retested
2026-08-22: usage 19→15 on a named initiative, role two-user proof with negative control,
pack × spend refusal naming kind+tool. MCP tool names still usually need QUOTING to be
extracted (unchanged honest limit). ~~**Vendor note updated**: a vendor audit-filter is now BUILDABLE — named in the B7a
amendment as the next candidate, alongside two deferred approvals joins~~ — **all three
closed 2026-08-22/23 (batch B8a, ADR-0096 amendment)**: vendor × audit filters via
`object_type='ai_vendor'` (retested live 94→3 on product-written rows; spend still refuses),
ai_use_case × approvals via its own `workflow_instance_id` (9→1 live), workflow_template ×
approvals via `template_ids @>` containment (9→1 live, a composed instance counting for every
template that composed it). Remaining honest limits: `listAnomalies` is now technically
satisfiable for use cases/templates but deliberately unwired (its own row-delta slice);
non-admin vendor narrowing honestly yields zero rows (ADR-0084 rows carry no project
attribution); vendor spend remains unanswerable.

## Enterprise-deal gates unchanged from §1
**P1** (credential — see above) · **P2** (HA/SLA — build when there is a customer to serve)
· **P3** (certification — L19 decision).

---

# Addendum — gap review against agentic-community/mcp-gateway-registry (2026-09-05)

The owner asked whether anything in [mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)
(Apache-2.0, FastAPI + nginx + MongoDB, Compose/ECS/EKS) is worth taking. It converges on the
same control-plane/data-plane split as pillar 1, so most of it is parallel work — but eleven
capabilities were checked against our tree at HEAD `d809f9e` (96 ADRs, verified before reading;
an earlier pass answered from a rolled-back snapshot — see M-028). Recorded here because a
finding that lives only in a chat session does not survive it.

**CLOSED 2026-09-05 (batch B9, [ADR-0097](../decisions/0097-mcp-admission-scanning-and-auth-discovery.md), migration 0103)** — both built, independently verified (164 files / 2560 passed + 9 MinIO skips on a fresh DB) and live-retested keyless; see the session log for the A/B/C evidence table:
1. ~~**MCP tool-description admission scanning.**~~ **DONE** — a local, deterministic,
   zero-network scanner (reusing ADR-0042's `prompt_injection` + `semantic_dlp` detectors and
   adding `mcp.tool_order` / `mcp.local_path` / `mcp.exfil` / `mcp.hidden_unicode`) runs over
   tool names, descriptions and the whole input schema **including each nested property
   description**. Org knob `mcpAdmissionMode` = `off` (default, byte-identical) | `log` |
   `enforce`; enforcement sits at the first statement of `connectUpstream` and inside
   `syncUpstreamTools` before the upsert, so a dirty manifest is never stored. Drift re-holds an
   approved server. **Still open**: the FIRST sync of a new server necessarily connects (nothing
   dirty is stored or returned); grandfathered rows stay trusted until re-synced; ~~no scheduled
   re-scan~~ **CLOSED 2026-09-06 ([ADR-0100](../decisions/0100-scheduled-mcp-admission-rescan.md))** — an
   off-by-default ADR-0064 sweep re-adjudicates through the SAME live path (`connectUpstream` →
   `syncUpstreamTools` → `recordManifestScan`), so there is no second threshold; `held` is
   deliberately ineligible (nothing auto-un-holds) and a `cleared` server on its unchanged digest
   is left alone. Retested live: a server nobody called went `clean` → `held` on the sweep; no manifest signing or
   publisher attestation; no SPA surface — the review queue and clear are API-only.
2. ~~**MCP spec auth discovery.**~~ **DONE** — RFC 9728 metadata at the default and
   resource-scoped paths plus an RFC 6750 `WWW-Authenticate` challenge on every 401 of the MCP
   route. `authorization_servers` is omitted unconditionally and on the record, because no code
   path validates an IdP-issued access token; DCR and an authorization-server surface are
   documented out of scope. **Still open**: if RegulAIt ever accepts IdP-issued tokens, this
   document must gain `authorization_servers` in the same change — the omission is load-bearing.

**Verified gaps NOT being built — each with what unblocks it:**
| Gap | State in our tree | What it would take |
|---|---|---|
| **Semantic/NL tool discovery across the catalog** | PARTIAL — an *entitlement-filtered* intent ranker exists (`mcp-proxy.ts` → `selectTools`), but ranking is stopword-stripped term overlap, single-server, and needs `?intent=`. **No embeddings anywhere**; ADR-0044 and ADR-0067 both declined embedding similarity deliberately | An embedding store + a cross-catalog route. Reversing a stated ADR decision — an **owner call**, not a default. Note our version would beat theirs: their design never specifies entitlement-filtering of discovery results |
| ~~**External registry federation**~~ | **CLOSED 2026-09-06 ([ADR-0101](../decisions/0101-federated-mcp-registry.md), migration 0105)** — built against the REAL v0.1 API (`GET /v0.1/servers`, opaque `metadata.nextCursor`, unauthenticated reads). **The condition this row carried was met**: a federated entry arrives usable by nobody. A sync writes only the catalogue; import is a separate audited operator act creating one `origin='federated'` row that is `unscanned` (never `grandfathered`) with **zero grants** — retested live as a table delta (`tool_grants` 3→3, `server_grants` 0→0), with the ungranted refusal proven non-vacuous (a matching grant moves the identical call from "no grant matches" to "Approval required"). It is still subject to ADR-0097 admission with no bypass (retested: `held|critical`, refused, upstream dead). Local rows are never clobbered — `name_taken`/`url_taken` recorded and refused 409, local row byte-identical in SQL. Only a `remotes[]` streamable-http/sse entry with an absolute untemplated URL becomes a server; everything else is inert `catalogue_only` and **no URL is ever invented** (a package's own loopback `transport.url` is deliberately ignored). Air-gapped refuses outright, before DNS. | Residues: no auto-import, no publisher identity (a registry is a directory, not a trust anchor — name-squatting undetectable), no version pinning, no SPA surface; a truncated pass detects no disappearance; `sse`-only remotes import then fail honestly at connect. |
| **Virtual MCP servers** (one endpoint composing several backends) | NONE — `/mcp/:serverId` is hard-bound to one backend; `mcp_tools` is unique per `(serverId, name)` only | New composition entity + member table + alias/collision policy + a new endpoint shape. Plays directly into role-bundle provisioning. Their own doc notes virtual servers drop streaming |
| **Per-user egress auth brokering** (OAuth 3LO / OBO / PAT vault) | NONE — connector and model credentials are org-wide singletons; `mcp_servers` carries no auth field at all and the proxy sends no caller credential upstream | Authorization-code flow, per-user token vault, refresh/rotation, upstream auth injection. Large, and high value for real enterprise MCP use (users' own Jira/GitHub tokens) |
| **A2A interop** | NONE — `DELEGATION_CONFORMANCE.md` §110-132 already says so outright | Inbound agent card + outbound client + task/artifact mapping. An ecosystem bet; **owner decision** |
| **Skills as a governed asset type** | NONE — no table, route, or ADR; "skills" appears only as a competitor capability in VISION.md | Whole asset type: registration, entitlement, versioning, audit. Timely product bet; **owner decision** |
| **Runtime quarantine of an abusive identity** | PARTIAL — identity-keyed buckets exist but exceeding one only 429s; auto-suspension exists solely for failed logins (ADR-0025) | **Conflicts with a stated principle**: ADR-0092 says there is no auto-revoke anywhere. Needs an ADR reconciling that before any code |
| **OpenTelemetry metrics** | Traces are DONE (ADR-0070: OTLP/HTTP, GenAI semconv, egress-guarded). **Metrics signal absent** | A metrics exporter beside the trace one; several declared-but-unwritten span kinds also remain |
| **Helm chart / k8s install for RegulAIt itself** | NONE — we ship Compose on one EC2 host (ADR-0013); `deploy-k8s-client.ts` deploys *customer* workloads, not us | A chart + manifests + migration Job + the replica story. Natural vehicle for **P2 HA**, still open |
| ~~**Gateway-issued token TTL**~~ | **CLOSED 2026-09-06 ([ADR-0098](../decisions/0098-api-key-expiry.md), migration 0104)** — `api_keys.expires_at` plus org dials `apiKeyDefaultTtlDays` and `apiKeyMaxTtlDays`, enforced in `authenticate()` (the one place a bearer token becomes an identity, so there is no second path). Both dials ship NULL so an upgrade invalidates nothing. Expired and revoked are distinct 401s with distinct audit rule ids; the ceiling **refuses rather than clamps**, including refusing an explicit never-expires request. Retested live: enforced on two surfaces with a control, and an expired key at the MCP proxy gets ADR-0097's RFC 6750 challenge while the ledger still records `api-key-refused-expired`. | Residue: expiry cannot be extended, by design — a key past its date is reissued, not renewed. |
| ~~**Credential scrubbing over audit rows**~~ | **CLOSED 2026-09-06 ([ADR-0099](../decisions/0099-audit-log-credential-scrub.md), no migration)** — sited at ADR-0060's existing audit-chain chokepoint (`appendChainedAuditRows`), so raw `db.insert(auditLog)` calls and future call sites are covered by construction rather than by convention; proven on a raw insert and one inside a caller's own transaction. Redaction preserves correlation (`[redacted:<rule>:<len>:<fingerprint>]`), and scrubbing precedes hashing so ADR-0060 verification still passes — retested live, `status: ok` with a redacted row in range. | ~~But see S5~~ — **the 47 columns were closed 2026-09-06 by [ADR-0102](../decisions/0102-operator-prose-credential-scrub.md)**, which reuses this scrubber by reference (a test pins `PROSE_SCRUB === scrubAuditText`) so the two paths cannot drift. What remains is **S6** (content columns), not audit prose. |

**One discipline worth adopting outright, no code**: their invariant that every configuration
parameter must be expressible with identical semantics on every deployment surface, and a
feature is not done until all of them support it. Our BYOC and air-gapped modes are exactly
where that drifts.

**Two of their choices we deliberately refuse**: federated entries inheriting local access
without approval, and discovery results that are not entitlement-filtered.

---

# Addendum — external review by Codex (2026-09-07), findings F01–F08

> **Sequenced version lives in the build plan.** This section records the *findings*; the bucketed,
> sequenced treatment of them — together with the second review document (`PathForward.md`,
> PF-01…PF-14) and the automated block AER-001…003 — is in
> [ENTERPRISE_READINESS_PLAN.md](ENTERPRISE_READINESS_PLAN.md) §Addendum (2026-09-07). Two items
> from that intake are corrections to **our own** records rather than new gaps:
> **AER-002** — the enforced contract is a **project dispatch freeze on exhaustion**: an attributed
> tool priced `null` or `0` is blocked too. **Partly over-accepted on intake and corrected
> 2026-09-07**: AER-002 places the narrow wording in "the ADR title", which is false — ADR-0103 is
> titled *"Gate the MCP tool-call path on the project budget"* and already carries an explicit
> *"It does not gate on the price of this call"* section, and checklist row 58 already spells out
> the unpriced case. The only genuinely narrow artifacts were the **commit subject** (immutable
> history) and `STATE.md`'s headline. **R1** was therefore smaller than filed and is now done.
> **AER-003** — the reviewer's host violated the declared package manager; **this repo pins it
> correctly** (`packageManager: pnpm@10.33.0`, CI installs `--frozen-lockfile` via an action that
> reads that field). The real residue is that `README.md:69` documents no pinned clean-checkout
> command; tracked as **R2**.

The owner had another agent (Codex) review the project and hand over recommendations. Its own
caveat is accurate and worth preserving: it read source but did **not** start the application, run
tests, call providers, or inspect a deployment. Every finding below was therefore rechecked against
the tree at HEAD `2c90396` (102 ADRs) before being acted on. **7 of the 8 held**; the eighth was
stale by one day.

| # | Verdict on recheck | State |
| --- | --- | --- |
| **F01** — untrustworthy test gate | **TRUE**, already ours (§5 above) | **OPEN**, and now better understood — see §5's correction |
| **F02** — budget not enforced on MCP path | **TRUE** | **CLOSED** — [ADR-0103](../decisions/0103-mcp-path-project-budget-gate.md) |
| **F03** — cap semantics under concurrency | **TRUE**, design question not defect | **OPEN** — named honestly in ADR-0103's limits |
| **F04** — secrets outside `audit_log` | **STALE** — S5 closed 2026-09-06 by ADR-0102 | Its *extension* is new and open: exports, backups, traces, conversations were never assessed |
| **F05** — approval not bound to payload | **PARTLY TRUE** | **CLOSED** — [ADR-0104](../decisions/0104-approval-payload-binding.md), migration 0106 |
| **F06** — prove end-to-end journeys | verification programme, not a finding | **OPEN**, largely owner-gated |
| **F07** — install/upgrade/recovery | verification programme, not a finding | **OPEN**, largely owner-gated |
| **F08** — documentation contradictions | 4 of 5 **TRUE**, 1 overstated by *me* | Partly closed below |

## F02 — closed 2026-09-07 (ADR-0103, no migration)

`preDispatchProjectGate` had **exactly one production call site** (`agents-connectors.ts`, the
model/connector dispatch). MCP tool calls were priced (`mcp_tools.price_per_call_usd ??
mcp_servers.price_per_call_usd`) and attributed (a `usage_events` row carrying `projectId`, which
`projectSpendUsd` reads) — **metered and attributed, but never gated**. Two properties made it
worse than a plain missing check: the overspend surfaced later as a 409 on the *model* path, so the
path that overspent was the one path that never complained; and nothing in the repo asserted it.

Fixed in the one shared primitive both entry points funnel through, so the direct proxy route and
pillar 7's delegated worker inherit it structurally. Proof is stronger than an error code: the test
upstream counts **both** HTTP requests and tool-handler invocations and every blocked case asserts a
zero delta on both. Non-vacuity measured — 5 of 8 tests redden under a neutralised gate, and the 3
that correctly stay green are the ones asserting *unchanged* behaviour.

**Residue, stated not hidden**: this is a measured-spend, **first-crossing-allowed** gate, not a
reservation — that is F03, and it needs a hold ledger rather than another call site.

## F05 — closed 2026-09-07 (ADR-0104, migration 0106)

Approval lookup keys only on user/server/tool/status (`governed-evaluate.ts:201-212`); `approvals`
has no arguments column (`schema.ts:1148-1220`); queueing and the audit row both omit the payload.
An approver signs off on "may call `write_note`" and the caller may execute it with entirely
different arguments.

**One claim in an earlier revision of this entry was wrong and is withdrawn**: I wrote that
`mcp-proxy.test.ts` "currently passes while doing exactly that". It does not. That test queued its
approval with `{text:"hi"}` and executed with `{text:"hi"}` — matching arguments — and its retry
with `{text:"again"}` was refused by **single-use consumption**, not by any payload check. So the
existing suite never exercised the hole in either direction. The hole is nonetheless real: a
neutralised-binding control showed an approval signed for `{text:"safe"}` executing
`{text:"exfiltrate"}`. I asserted a test's behaviour from its shape instead of reading what it
passed in — the same error as M-030, one file over.

**Two compensating controls the review missed**, which bound the exposure to a one-shot swap per
approval cycle rather than unlimited reuse: consumption is atomic and single-use, and
`data_scope_rules` (`argPath`/`allowedValues`) constrain permissible values **before** approval
satisfaction and fail closed. The real defect is that **no ADR states the intended semantics**, and
neither the queue row nor the audit row records the payload — so the approver decides blind and
there is no forensic record of the arguments actually executed.

**Built as decided**: action-scoped consent by default with an explicit `tool` escape hatch; consent
is a sha256 over canonical `{projectId, arguments}` reusing **ADR-0060's `canonicalJson`** and
**ADR-0099's `scrubAuditDetail`** rather than adding a second canonicalizer or a second redactor;
the approver reads a scrubbed preview; the executed digest lands on the audit row under either
scope, closing the forensic half independently of the consent half. Both traps were handled: the
pending-entry dedup keys on the digest under action scope (and deliberately not under `tool`), and
strictest-wins runs over the rules that *actually matched*, using the kernel's own predicate.

Verified by the rows rather than by status codes: a call signed for `{text:"safe"}` attempting
`{text:"exfiltrate"}` sits **pending**, not consumed; two identical calls share a digest and the
second still re-queues; the same arguments under a different project carry a **different** digest;
a payload with a synthetic secret stores `[redacted:…]` in the preview while the call still
executes — the digest is pre-scrub, so redaction cannot move consent identity.

**Residue, stated not hidden.** (a) Legacy `approved` rows with a NULL digest do not satisfy an
action-scoped call — they re-queue, self-healing within one cycle. Backfilling was rejected as
manufacturing a consent no human gave. (b) **NEW — an ABAC-driven pause has no configurable
scope**: with no matching `approval_rules` row the strictest-wins default `action` applies
(fail-closed, correct), but `abac_policies` has no scope column, so an operator who legitimately
wants the `tool` reading for a policy-driven pause must author a parallel approval rule. (c) The
digest binds the arguments, not the state they act on.

## F08 — documentation, partly closed

- **CLOSED**: PENDING's stale rows on the S3 Object-Lock sink ("built but not wired" — contradicted
  by `audit-chain.ts`) and the copilot diff-applier ("nothing applies proposals" — contradicted by
  B8c). Both sat inside a dated inventory that *does* carry a supersession disclaimer, and an
  external reviewer was misled anyway. **That is the finding**: the disclaimer is not working.
- **CLOSED**: `STATE.md` front matter was `2026-08-13` against a narrative current to `2026-09-06`.
- **CORRECTED, and the correction is mine to own**: I reported that `boot.ts` prints `/app` and
  `/admin` which "now 404". **They do not** — both 302 to `/ui` and resolve 200. The item is real
  but cosmetic: a stale boot banner, not a broken link. I asserted the stronger claim without
  probing it.
- **Not assessed**: the marketing-claim items (guardrails as heuristics, training-provider as
  retrieval + classical classification rather than local transformer training). Both look right on
  their face and neither is a code defect.
