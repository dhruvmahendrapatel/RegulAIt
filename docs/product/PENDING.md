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
| **S4** | Deferred by owner decision, still open: SAST/SCA/secret-scanning in CI (D3), third-party pen test (D4), WAF/DDoS at the edge (D5), HSM/FIPS option (D7). **2026-10-02 ([ADR-0167](../decisions/0167-security-review-batch.md), SEC-02/CFG-05):** `@xmldom/xmldom` is pinned to 0.8.15 by a root `pnpm.overrides` entry — the ONE runtime-reachable HIGH advisory in `pnpm audit` (9 open advisories on 0.8.13, incl. quadratic parsing, under the auth-exempt SAML ACS); node-saml 5.1.0 / xml-crypto 6.1.2 declare `^0.8.10`, so the pin is in range. Remove the override once they raise their own floor. The remaining HIGHs (fastify schema/URL, drizzle identifier escaping, fast-uri, ip-address, js-yaml, react-router) were each traced to an unreachable or dev-only path; the `pnpm audit --audit-level=high` CI gate stays deferred with D3 until that upgrade batch lands, because it would fail today on advisories that do not apply. | ENTERPRISE_READINESS_PLAN Bucket 3 |

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

- **S20 — chat-to-dispatch: let a Teams/Slack message BE a governed agent turn. QUEUED, and it
  needs an authorisation decision before any code (opened 2026-09-19).** ChatOps today mirrors
  **approvals** and accepts **decisions**; it does not let a user converse with an agent from chat.
  The plumbing to do so largely exists — ADR-0061 already solved the two hard parts (**admin-managed
  identity binding**, because a chat user id is an *assertion* and a self-serve claim would let
  anyone bind to anyone; and **signature-verified inbound**, which already works for Teams) — and
  `conversations` already carries `projectId`, so a dispatch from chat would inherit that project's
  budget gate, PII cascade, compliance tags and cost attribution for free.

  **What must be decided first, not discovered later.** ADR-0061's fence exists because *a chat tap
  is not a re-authenticated session*; that reasoning binds harder here. Approving from chat is
  bounded by an approval that already exists and was already scoped. **Dispatching from chat spends
  real project budget and reaches real tools from a client we do not control.** Questions owed an
  answer: is chat dispatch opt-in per workspace (mirroring `allowFencedDecide`)? Is it refused
  outright for `block`-mode projects? Which agent does a bare message reach, and who chose it? Does
  a chat turn inherit the full entitlement set of the bound user, or a narrower one? Until those are
  answered this stays queued — building it first would decide them by accident.

- **S17 — GitHub Copilot is invisible to shadow-AI discovery (opened 2026-09-19).** Measured:
  `packages/shared/src/shadow-discovery.ts` carries **37 endpoint signatures**, and the only Copilot
  entry is `ep-microsoft-copilot-web` → `copilot.microsoft.com`, annotated in our own code as
  *"Browser usage, not an API integration."* **There is no GitHub Copilot signature at all**, so the
  IDE case — the one an enterprise actually cares about — is neither governed nor even *detected*.
  Small and cheap: add the signature(s) so it becomes visible on the Shadow-AI surface.
  **Do NOT take the hostnames from this entry — there are none here on purpose.** Whoever builds it
  must verify GitHub Copilot's real endpoints against current documentation or observed traffic
  rather than inheriting a guess; a wrong signature is worse than none, because it reports clean.
  Detection only — it does not make Copilot governable (see S18 and the enforcement ladder).

- **S18 — document the Copilot-via-MCP path in `IDE_INTEGRATION.md` as a supported configuration
  (opened 2026-09-19).** **No new code — this is documenting a capability that already ships.**
  `POST /mcp/:serverId` is a standard streamable-HTTP MCP endpoint, and GitHub Copilot supports MCP
  servers; pointing its MCP config at our proxy puts every tool call it makes through entitlement
  checks, data scope, approvals (ADR-0104/0105), project budget (ADR-0103), PII/guardrails and the
  audit trail. That governs what Copilot **does**, which is the strongest honest claim we have here.
  The write-up must keep `IDE_INTEGRATION.md`'s existing framing rather than soften it:
  - **It governs actions, not completions.** Copilot's model calls still go to GitHub's backend.
  - **`key_custody` — our cheapest non-bypassable rung — does NOT apply to Copilot.** That rung
    works by withholding raw provider keys; Copilot's credential is a **GitHub entitlement**, not a
    vendor API key the org issues, and it does not speak to an OpenAI-compatible endpoint that could
    be repointed. Only the `network` rung closes the completion path, and that is infrastructure at
    the customer's boundary, never product code.
  - A developer can remove the MCP server from their own config, so on the ladder this is
    `managed`/`voluntary` for the tools too unless the MCP servers themselves are only reachable
    through us.

- ~~**S14 — conversations hold a pasted credential verbatim**~~ **CLOSED 2026-09-19 by
  [ADR-0112](../decisions/0112-conversation-presentation-scrub.md)** — owner chose **option (c)**:
  stored faithfully, redacted at the presentation boundary. Three residuals carried forward:
  **(1) AT REST IS UNPROTECTED — the operator procedure for "someone pasted a key into chat" is
  still ROTATE IT.** A `pg_dump`, a restored backup or a `psql` session reads it in the clear; (c)
  stopped the API echoing it, it did not contain it. **(2)** `eval_results.output_text` — named by ADR-0111, not taken by ADR-0112 — was assessed
  and closed as **S22** by ADR-0115 (scrubbed at the API boundary; at-rest exposure retained, as for
  conversations).
  **(3)** the live `POST /v1/agents/:id/invoke` response echoes the current turn unscrubbed, by
  deliberate decision — it is the caller's own answer travelling back to the caller who just typed
  the input, persisting nothing and reaching no third party. Recorded alongside ADR-0111's 5b/5c so
  it is not re-found.

- **S22 — the eval surface held the credential. CLOSED 2026-09-19 by
  [ADR-0115](../decisions/0115-eval-result-credential-surface.md), no migration.** Probed with a
  synthetic key through a real eval run and a real red-team run. `output_text` held it verbatim and
  `detail` held it in the judge's verdicts — **both left faithful at rest** and redacted at the
  presentation boundary, because a red-team probe's purpose can be to prove the agent disclosed a
  secret and deleting the disclosure destroys the evidence. **`error` splits from them and is
  scrubbed at WRITE time**: an exception message can carry the credential that caused it and is
  never evidence of anything. Six read routes across three files were covered, including the
  `output_snippet` copies in `redteam_findings`/`redteam_probe_trials` and the model-card re-derivation.

- **S14 (original entry, superseded above) — conversations hold a pasted credential verbatim. OWNER DECISION (opened 2026-09-17,
  ADR-0111).** Proven with a row: `conversation_messages.content` (both the user turn and the
  assistant turn), `conversations.title` via `autoTitle`, and the compaction summary. **Deliberately
  not fixed** — scrubbing user chat content is a different contract from scrubbing operator prose,
  and getting it wrong is silent data loss where the product promises fidelity. ADR-0111's interim
  position scrubs **the observability copy, not the record**, which closes the egress path today at
  the stated cost that the two records of one turn now disagree. **The four options as recorded**:
  (a) leave it; (b) scrub like any other column, accepting fidelity loss; (c) scrub the read/export
  surfaces while storing faithfully; (d) detect-and-warn at intake without altering what is stored.

- **S15 — two error echoes, proven and ACCEPTED rather than closed (2026-09-17, ADR-0111).** zod
  `invalid_enum_value` returns the caller their own rejected value in `received`; a 409 `detail`
  interpolates a stored `name` the same caller can `GET`. Nothing persists either and no third party
  sees them, and the fix would put a scrub on every 400 in the product. Neither is claimed *safe* —
  they are recorded so the next reviewer does not spend the afternoon re-finding them.

- **S16 — no backfill, and no scrub-on-read (2026-09-17, ADR-0111).** Trace rows written before
  today still hold unscrubbed payloads, and the OTLP exporter will export them. Deliberate: the
  write is the chance, and rewriting historical observability data is a worse precedent than leaving
  it. An operator who needs the old rows gone must decide that themselves.

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

- ~~**S11 — `backup_runs` re-opens a miss while a restore is pending**~~ **CLOSED 2026-09-12
  ([ADR-0110](../decisions/0110-backup-rescan-reopen-and-preflight-gate.md), migration 0109)** —
  owner decided a re-scan **should** re-open. One row per finding; `missed`/`restore_proposed`
  re-open with the superseded proposal audited, `restored` does not; the constraint ADR-0109 refused
  is now added and proven to bite.

- ~~**S12 — the duplicate pre-flight is wired into nothing**~~ **CLOSED 2026-09-12** — one CI step
  after the suite, 10 checks enforced. **Residue: the step has never actually executed**, because
  GitHub Actions is exhausted for this repo; it was verified locally in all three exit states
  (clean 0 / blocked 1 / unreachable 2). Building it also found a defect in the script itself:
  `console.log` + `process.exit()` means Node's async stdout on a pipe could drop the output, so a
  blocked pre-flight could have failed CI with **no reason printed**. Fixed to `fs.writeSync`.
  **Correction 2026-10-03 (F01/F08 — a stale claim)**: "GitHub Actions is exhausted for this repo"
  and "the step has never actually executed" are no longer true and are withdrawn as present-tense
  statements. The `pull_request` workflow runs again: `.github/workflows/ci.yml`'s budget header was
  re-measured on 2026-10-02 from runs 37050080219 / 37045578961 / 37042881890, and run 37036782298
  at exact head `21b3094` executed the whole `build-and-test` job — this pre-flight step included —
  green (`codexInputs.md` F01). The 09-12 text above stands as the record of that day.

- **S13 — a re-scan re-opened the ledger row but never the FINDING. CLOSED 2026-09-19 by
  [ADR-0114](../decisions/0114-rescan-reopens-a-contradicted-finding.md), no migration.** A re-scan
  that observes the **same signature** now re-opens a finding whose status claims the problem is
  resolved (`remediated`, `auto_remediated`), audits the contradiction as `infra-finding-reopened`
  with what was CLAIMED and what was OBSERVED, and leaves `accepted_risk` and `remediation_proposed`
  alone with a stated reason for each. **The entry's own premise was wrong and is recorded as
  M-036**: this was filed as *pre-existing ADR-0017 behaviour ("a re-scan never resets a finding's
  status")*, and **ADR-0017 contains no such claim** — its only idempotency statement is that a
  re-scan never duplicates a LEDGER row. The rule was an inline comment at `infra.ts:883`, and the
  ADR citation is precisely what kept it from being revisited for a week. Flapping is **bounded,
  not eliminated** (fires at most once per false close; no findings-scan scheduler exists today) —
  see the ADR's Honest limits before adding one.

- **S11 (original entry, superseded above) — `backup_runs` re-opens a miss while a restore is pending (found 2026-09-09).** The
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

- ~~**S8 — a FOURTH intermittent, order-dependent test failure. OPEN, and NOT diagnosed (2026-09-08).**~~
  **REPRODUCED, DIAGNOSED AND FIXED TEST-SIDE 2026-10-03 (F01).** Reproduced on a fresh database
  on the **second of three ordered attempts**, each file in its own `vitest run` so the order is the
  order written: (1) `compat-longtail` alone — 30/30; (2) `mcp-proxy.test.ts` then
  `compat-longtail` — **"THE ASYMMETRY, provider side" returns 500, expected 409**, every time;
  (3) `env-fallback` → `setup-status` → `compat-longtail` — 30/30, `model_credentials` empty. With
  `DEBUG_ERRORS=1` the 500 is `Error: Unsupported state or unable to authenticate data` thrown by
  `decryptSecret` (`secrets.ts:109`) from `dispatchAttempt` (`agents-connectors.ts:1748`) — not a
  `ModelProviderError`, so the dispatch core rethrows and the app-level handler answers `500
  internal`. **Cause**: `mcp-proxy.test.ts` upserts a PLATFORM credential for `anthropic` (and
  `openai`, `google`, `xai`), each pointing at a loopback fake it closes on the way out and each
  encrypted under *its* data key (`"a"×64`), and deleted none of them; `compat-longtail` boots with
  `"d"×64`, finds a stored anthropic credential, cannot decrypt it, and never reaches the
  no-credential 409. **Why intermittent**: four files wipe the anthropic slot (`env-fallback`,
  `setup-status`, `mock-shadowing-rosters`, `routing-mock-honesty`), and whether one of them lands
  between the pair depends on vitest's sequencer — failed-first, then slowest-first from the local
  results cache, largest-file-first without one — so the order moves from run to run and box to
  box. **The 09-09 forensics were right and could not have found it**: `model_credentials` *is*
  empty at end-state in every run because a later file always wipes it; the leak lives between two
  files, not in the end state. The 09-20 model-string hypothesis is **eliminated by reading**: only
  this file registers model `clt-claude`, so the tie-break never selects a foreign agent. **Fix**
  (test-side only, no product code): `mcp-proxy.test.ts`'s `afterAll` now deletes exactly the four
  platform slots it wrote, the discipline `env-fallback` already follows. Verified in the failing
  order on a fresh database: fixed file 30/30 with zero rows left; HEAD file restored → the same
  single test fails 500≠409; fixed file restored byte-for-byte (`cmp`). **Honest limit**: the
  property is now held by one file's cleanup, not enforced — a future file that writes a platform
  credential under its own key and forgets to delete it reopens this exact shape. The full-suite
  "N repeated clean runs" F01 asks for are not recorded here; this closes the one named intermittent.
  Original entry retained below.

- **S8 (original entry, superseded above) — a FOURTH intermittent, order-dependent test failure. OPEN, and NOT diagnosed (2026-09-08).**
  `compat-longtail.test.ts` — *"THE ASYMMETRY, provider side"* — asserts that a dispatch to an
  `anthropic`-provider agent with no credential configured returns **409 `no_model_credential`**.
  On one full-suite run it returned **500**. Observed **once in four** post-ADR-0106 runs
  (`n1w1` exit 1; `n1w2`, `diag1`, `diag2` all exit 0 at 2688 passed). It passes **3/3 in
  isolation** on a fresh database, so it is order/state-dependent inside the shared database, not a
  defect of that file in itself. A temporary probe was added to capture the 500 body and the suite
  re-run twice more; **it did not reproduce**, so the probe was reverted and no diagnosis was
  reached. Recorded rather than guessed at.

  **A THIRD HYPOTHESIS, opened 2026-09-20 by M-037 — untested, and stated as a hypothesis.**
  ADR-0117 found that `POST /v1/messages` resolves its agent by the MODEL STRING, and that in the
  shared suite database ADR-0020's tie-break legitimately selects another file's agent carrying the
  same model. S8 is a **compat-path** test (`compat-longtail.test.ts`) that got a 500 where it
  expected 409 `no_model_credential`, is order-dependent, and passes 3/3 in isolation — the same
  shape and the same surface. If that file also resolves by model string, the agent it actually
  reached may not be the one whose credential absence it is asserting about. **This has NOT been
  checked**; it is recorded so the next session starts here rather than re-deriving it.

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
| ~~**L6 governance copilot**~~ (Credo gap; GAIA-equivalent) | **CLOSED 2026-08-22** ([ADR-0056 amendment](../decisions/0056-ai-governance-copilot.md#amendment--2026-08-22-the-copilot-goes-live-l6al6b-migration-0100), migration 0100). L6a: answers are grounded in RETRIEVED OBJECT IDS with a named grounded-refusal shape when the retrieval finds nothing, narration rides the governed dispatch (live Gemini, metered, cross-checked), and `modelNarrationVerified` became an honest per-answer flag. L6b: an APPROVED proposal is applied by an admin through the same public choke points an admin would use (`applyRuleEdit`; the one-per-kind grant removal) — ~~`rule_to_approval` and `budget_adjustment` stay **unapplied and named**~~ — **applied 2026-08-23 (batch B8c, ADR-0056 amendment)**: both ride PRE-EXISTING public routes through extracted shared implementations (`POST /v1/rules/approvals` via `createApprovalRuleRow`; `PATCH /v1/projects/:id` via `applyProjectPatch`, honestly scoped to project budgets), the applier runs each route's OWN zod with issues surfaced verbatim, and all refusal legs are pinned (pending, second-apply, target-gone, schema-refused, smuggled-field) — retested live end-to-end. **Hardened 2026-09-27 (AER-035, ADR-0056 amendment ×5):** the applier was not transactional and not concurrency-safe — twenty simultaneous applies of one approved proposal created TEN approval rules from one human's consent, measured; it is now ONE transaction over a `SELECT … FOR UPDATE` proposal row, with the mutation, the applied marker and the audit row committing together or not at all, and refusals audited after the rollback so a refused apply is still on the record. **And 2026-09-27 (batch B9a):** a malformed diff is refused BEFORE any approval is opened (it used to be recorded, consented to by a named human, and only then refused), and the propose half finally has a UI — it had none, so the product's single most governed write was unreachable without curl. Still open from this line: enrolment in ADR-0057 red-teaming with a promotion-blocking gate; and the approval row is read inside the applier's transaction but not locked, so a `decide` that denies it can commit in a narrow window before the mutation (stated in the amendment's limits — closing it means choosing a lock order and testing for deadlock). |
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
| **Dev/CI object store after MinIO (opened 2026-10-03)** | MinIO archived its community edition and removed its images from Docker Hub (September 2026); anonymous Quay pulls failed from 2026-10-02. CI and the compose quickstart now pin `bitnamilegacy/minio:2025.7.23-debian-12-r5`, a frozen, unmaintained build that will receive no CVE fixes. It is a dev/CI stand-in only — a customer install anchors to AWS S3 or their own Object-Lock store (ADR-0060). Decide whether to move the stand-in to a maintained S3-compatible store with Object Lock (candidates to evaluate: Garage, SeaweedFS, RustFS) before any shared or customer-facing environment runs the compose stack. |
| **L1 — `automated_check` stages pass on silence (opened 2026-10-03, review lead, CONFIRMED high)** | `apps/gateway/src/workflows.ts` (the check executor, ~line 720): a named check with no reported result falls back to a deterministic offline auto-pass, and `workflow-checks.test.ts` pins that as the contract ("with NO reported results a check stage auto-passes"). Re-proven end to end on 2026-10-02: a template with `unit_tests` + `security_scan`, the gate approved before any CI posted, the stage evaluated every check `passed` and advanced; a `failed` security_scan reported afterwards was refused as a late report. ADR-0167 AUTHZ-06 stamps self-reports but says nothing about absence. The fix is a one-line policy change — a check nobody reported is `failed` (or `pending`, parking the instance until CI posts) — but it breaks every existing template that relies on sailing through, including the demo's. Decide: (a) keep auto-pass and DISCLOSE it in the stage rail and the approval view ("no result was reported for N checks"), or (b) make silence a failure with a per-template opt-in `offlineAutoPass: true` that the demo template sets. Recommendation: (b) after the demo, (a)'s disclosure line now. |
| **L3 — bodies are parsed before the credential check (opened 2026-10-03, review lead, low–medium)** | The auth gate is a `preHandler` hook, so an unauthenticated request's JSON body (up to the 1 MiB `bodyLimit`) is parsed before any credential is looked at — CPU amplification per junk request. The pre-auth IP-keyed limiter (ADR-0167 §1) caps how many such requests one address gets, which is why this verified low–medium rather than high. Moving the gate to `onRequest` changes hook ordering for every route (the interception gate at ~line 883 already runs there) and is a wide, demo-adjacent change. Decide whether it goes in the post-demo hardening batch or waits for a measured need. |

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
| **F02** — budget not enforced on MCP path | **TRUE** | ~~**CLOSED** — [ADR-0103](../decisions/0103-mcp-path-project-budget-gate.md)~~ **Correction 2026-10-03**: the 09-07 closure covered the MCP and model paths only; `POST /v1/connectors/:connectorId/invoke` still executed and billed on an exhausted project (Codex F02 recheck). **CLOSED 2026-10-03** — the same `preDispatchProjectGate` now sits on the connector invoke ahead of credential/PII/guardrail/egress/provider work ([ADR-0103 amendment 2026-10-03](../decisions/0103-mcp-path-project-budget-gate.md), `connector-project-budget.test.ts`). F03's first-crossing semantics still apply on all three paths. |
| **F03** — cap semantics under concurrency | **TRUE**, design question not defect | **OPEN** — named honestly in ADR-0103's limits |
| **F04** — secrets outside `audit_log` | **STALE** — S5 closed 2026-09-06 by ADR-0102 | ~~Its *extension* is new and open: exports, backups, traces, conversations were never assessed~~ **Correction 2026-10-03: the extension is CLOSED, and has been since 2026-09-17/18** — every named surface was assessed one at a time with a synthetic secret: [ADR-0111](../decisions/0111-trace-preview-credential-scrub.md) (traces leaked *and were exported*: fixed at ADR-0102's chokepoint; exports, backups and anchors proven clean), [ADR-0112](../decisions/0112-conversation-presentation-scrub.md) (conversations: the owner's option (c), redact at the presentation boundary) and [ADR-0115](../decisions/0115-eval-result-credential-surface.md) (`eval_results`, column by column). The Codex ledger carries F04 as CLOSED; this row simply never caught up. Declared residuals stand: S6 content columns (owner), S15, S16. |
| **F05** — approval not bound to payload | **PARTLY TRUE** | **CLOSED** — [ADR-0104](../decisions/0104-approval-payload-binding.md), migration 0106 |
| **F06** — prove end-to-end journeys | verification programme, not a finding | **OPEN**, largely owner-gated |
| **F07** — install/upgrade/recovery | verification programme, not a finding | **OPEN**, largely owner-gated |
| **F08** — documentation contradictions | 4 of 5 **TRUE**, 1 overstated by *me* | Partly closed below |

### Addendum 2026-10-03 — the F table as it stands today (HANDOFF)

The table above is the 09-07 record pinned to HEAD `2c90396` and stays as written (two of its cells
carry dated corrections of their own). These are the same eight rows on 2026-10-03, each with where
its status is proven. Every SHA and ADR below was checked against the tree; what could not be
checked from here is said in the row. `469b192` and `9869264` are SHAs on the gates-docs worktree
branch — if integration rewrites them, their subjects begin `test(f01): S8 diagnosed` and
`ci(f01): gate the phase1/phase2 SPA journeys`.

| # | Status 2026-10-03 | Evidence, and what is still unmet |
| --- | --- | --- |
| **F01** — untrustworthy test gate | **PARTIAL** | [ADR-0106](../decisions/0106-mock-socket-net-contract.md) (the suite's exit code made deterministic); [ADR-0107](../decisions/0107-unordered-single-row-reads.md) / [ADR-0108](../decisions/0108-test-side-unordered-reads.md) (unordered single-row reads swept, production side then test side); the 10-02 order-independence fixes `0fba74c` and `1515f23`. **Today**: S8 reproduced on a fresh database (`mcp-proxy.test.ts` then `compat-longtail.test.ts`, one `vitest run` each — 500 ≠ 409 every time), diagnosed to four platform credentials that file left behind under its own data key, and fixed test-side in its `afterAll` with a negative control (`469b192`; §5, S8); the stale "Actions exhausted" claims withdrawn (`4e13d79`; the two ROADMAP.md Track-0 rows that one missed, struck 2026-10-03 after review); `phase1.spec.ts` and `phase2.spec.ts` gated by the new `spa-journeys` job in `ci.yml` (`9869264`), whose first local run found phase2 assertions left stale by `cb55473` and repaired them — 39/39 locally; the job has not yet executed on a GitHub runner. **Unmet**: N repeated clean full-suite runs recorded against one head — left to the dispatcher's integration gate, not run in this change. |
| **F02** — budget not enforced on MCP path (and, found 10-03, the connector path) | **CLOSED 2026-10-03** | The MCP path since 09-07 ([ADR-0103](../decisions/0103-mcp-path-project-budget-gate.md)). The connector path the 09-07 closure missed: `4229704` (local branch `wt-sec2`, no longer on any ref here) landed on `dhruv/active` as `aa233bd` — the identical patch (same `git patch-id --stable`) — putting `preDispatchProjectGate` on `POST /v1/connectors/:connectorId/invoke` ahead of credential/PII/guardrail/egress/provider work, with `connector-project-budget.test.ts`; that commit also carries ADR-0103's 2026-10-03 amendment and the dated correction in the F02 row above. Ledger close: `0be5e93`. `3dc13d2` is batch C's review follow-up on `dhruv/active`, but its diff (one anchor sink per process, credential-name scrub, a preflight comment) does not touch the connector gate, so it is **not** confirmed here as an F02 follow-up. F03's first-crossing semantics apply on all three paths. |
| **F03** — cap semantics under concurrency | **PARTIAL — owner decision** | ADR-0103's honest limits (measured spend, first crossing allowed); [ADR-0125](../decisions/0125-shared-enforcement-counters.md) (run charges posted as a delta under `FOR UPDATE`, `shared-budget-charge.test.ts`). **Unmet**: the owner's choice between a documented threshold and a hard reservation (hold ledger); the permitted overshoot per cap (project, run/node, virtual key) is undefined; no concurrent near-boundary test of `preDispatchProjectGate`. |
| **F04** — secrets outside `audit_log` | **CLOSED** | [ADR-0102](../decisions/0102-operator-prose-credential-scrub.md) (S5), then the extension surface by surface: [ADR-0111](../decisions/0111-trace-preview-credential-scrub.md) (traces leaked and were exported — fixed; exports, backups, anchors proven clean), [ADR-0112](../decisions/0112-conversation-presentation-scrub.md) (conversations — the owner's option (c)), [ADR-0115](../decisions/0115-eval-result-credential-surface.md) (`eval_results`). The row above said "open" until `4e13d79` corrected it today. Declared residuals S6 (owner), S15, S16 stand. |
| **F05** — approval not bound to payload | **CLOSED, extended three times** | [ADR-0104](../decisions/0104-approval-payload-binding.md) (payload binding, migration 0106); [ADR-0105](../decisions/0105-consent-context-binding-and-expiry.md) (consent bound to the policy that demanded it, with expiry — AER-004); [ADR-0144](../decisions/0144-approver-action-review.md) (the approver reviews the effective action; the five browser journeys in demo.yml's `approval-review` job); [ADR-0166](../decisions/0166-consent-bound-to-mcp-target.md) (consent bound to the MCP target — AER-039, `749ee75`, `297d0b9`). |
| **F06** — prove end-to-end journeys | **PARTIAL — owner decisions first** | Real seeded-database journeys through `global-setup.ts`; `demo-intake.spec.ts` and `mcp-action-review.spec.ts` gated in demo.yml; phase1/phase2 gated today (`9869264`). **Unmet**: a cost-bounded real-provider journey (needs the owner's credential and spend), a browser-driven staged workflow (plan → sign-off → build → checks), restart / provider-loss / expired-credential recovery, and the plan-only no-instance boundary (`plan-only.test.ts:301`, the owner's to decide). |
| **F07** — install/upgrade/recovery | **PARTIAL — owner decisions** | ADR-0063 key custody and re-encryption tests, ADR-0062 mode-scoped egress, `setup-status.ts`, backup verification, the ADR-0110 pre-flight in CI, the 09-26 D01/D02 fixes, `demo:prepare` from an empty database. **Unmet**: an upgrade-from-prior-version proof, a restore drill since ADR-0035, a release keyring anyone can sign with (`infra/release-keys/README.md`), air-gapped egress validation on a real deployment; `docs/ops/DEPLOYMENT_READINESS_CHECKLIST.md` parked by the owner's 2026-08-01 decision. |
| **F08** — documentation contradictions | **All five named items closed; awaiting Codex confirmation** | `1b9d6cb` (10-02) cleared the AER-002/004/005 texts. `4e13d79` (today): `boot.ts` prints `/ui` (and README's "now 404" corrected), the F04 row above corrected, the "Actions exhausted" claims withdrawn (S12 here, CONTRIBUTING_PARALLEL_SESSIONS §4.7, and, after review found them missed, ROADMAP.md's "Re-enable CI" and "While CI is paused" rows; ADR-0110's "CI DID NOT EXERCISE THE NEW STEP" bullet remains a dated record in an ADR), and the guardrail and training capability claims assessed against the source (both hold — §F08 below). The F02 row's false closure was corrected by `aa233bd`. The structural point in §F08 stands: a supersession disclaimer did not stop a reader being misled, so this addendum states what is true now beside what was true then. |

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
  probing it. **CLOSED 2026-10-03**: the banner now prints the one surface, `UI: <address>/ui`;
  `/app` and `/admin` stay as 302s into it (`app.ts`, kept for SSO's `returnTo` whitelist and old
  bookmarks) and are no longer advertised. README's quickstart blockquote, which said those paths
  "now 404", was wrong the other way and is corrected in the same change.
- ~~**Not assessed**: the marketing-claim items (guardrails as heuristics, training-provider as
  retrieval + classical classification rather than local transformer training). Both look right on
  their face and neither is a code defect.~~ **ASSESSED 2026-10-03 — both claims hold at the
  source, and neither overclaims.** (1) *Guardrails are heuristics*: `packages/shared/src/guardrails.ts`
  says so at the point of implementation (lines 10–36): every shipped detector is a deterministic,
  local regex/term-list rule set carrying `tier: 'heuristic'`; no model-backed or external tier is
  registered (the `tier` field exists so one can be, behind the same interface); the file lists
  what the rules miss (obfuscation, non-English, novel framings) and why the shipped posture is
  `log`, not `block`. The gateway half (`apps/gateway/src/guardrails.ts`) only resolves modes and
  writes audit rows — it adds no detection. (2) *Training is retrieval + classical classification,
  not local transformer training*: `packages/training-provider/src/index.ts` (lines 1–60) is built
  around exactly that sentence — the `local` backend's methods are `retrieval_index` (a TF-IDF
  inverted index; no weights updated anywhere) and `text_classifier` (multinomial logistic
  regression by gradient descent over bag-of-words); the three LLM fine-tuning methods (`lora_sft`,
  `full_sft`, `dpo`) are reachable only through the four credentialed remote adapters, which refuse
  with `credential_required` when nothing is configured and are stated in the file to have never
  spoken to a live service. The admin screen (`RegulAItLlmPage.tsx`) renders each backend's own
  `limits` string next to the picker, including `local`'s "IT DOES NOT FINE-TUNE A LANGUAGE
  MODEL". Verdict: accurate capability claims, no code defect, nothing to change.

---

# Addendum — found while walking the demo runbook on a docker-less box (2026-09-26)

## ~~D01 — a malformed `REGULAIT_DATA_KEY` boots clean and fails later as a bare `500`~~ — **CLOSED 2026-09-26, and the original write-up was WRONG**

**Correcting myself first.** The heading above is what I wrote before testing it, from reading
code rather than running it. **The gateway does not boot clean.** `keyBytes` throws, so
`verifyDataKeyOnBoot` → `fingerprintOrNull` → `dataKeyFingerprint` → `keyBytes` raises before
anything starts. Verified by booting with a base64 key: exit 1, nothing listening. I asserted the
stronger, more alarming claim without probing it — the same error as F08's last bullet, and the
second time in one day that I wrote down a conclusion I had not executed.

**What was actually wrong** turned out to be two narrower things, both now fixed:

1. **The refusal was right and the message was not.** `keyBytes` threw a plain `Error`, and
   `main.ts` only converts `DataKeyBootError` into the operator sentence — everything else it
   re-raises. So the one place in this product written to be read at 3am mid-restore printed a
   stack trace from three frames down instead. There is now a `malformed_key` code, decided
   **first** in `decideDataKeyBoot` (ahead of every custody question — with a recorded fingerprint
   present the old ordering would have reported `key_missing`, sending an operator hunting a lost
   key rather than fixing a typo), filed to the ledger under `data-key-malformed`, and thrown as a
   `DataKeyBootError`.
2. **The seeder had no gate at all, and that is where the `500` came from.** `seed.ts` calls
   `buildApp` directly rather than `startGateway`, deliberately — constructing an app is not
   putting a deployment into service. But the seeder is usually the *first* thing run on a new
   deployment, so it is the first place the key can be wrong; it sailed through migrations and
   most of the seed and failed at `POST /v1/git/connections` as `500 {"error":"internal"}`. It now
   checks the value's **shape** up front and exits 1 saying so. Shape only: continuity is a
   question about a database in service, and the seeder's job is to populate one that is not.

**A real bug was found while fixing it.** The `switch` in `verifyDataKeyOnBoot` is what stops a
boot — `decision.ok === false` stops nothing, the `throw` does. It had no exhaustiveness check, so
adding `malformed_key` without a case would have made the gateway **come up on a key it had just
refused**. There is now a `never` default. That is the more dangerous defect of the two and it
existed only for as long as it took to add a code.

**Root cause of my own error, worth keeping:** `secrets.ts` said hex, `audit-scrub.ts` said base64,
and the format was only truly knowable from `Buffer.from(x, "hex")`. There is now one exported
authority, `dataKeyFormatError`, which `keyBytes` itself uses — so the validator cannot be more
lenient than the parser — and a test asserts exactly that.

## D02 — the runbook's first command does not run without docker

`docker compose up -d db minio minio-init` is step 1 and there is no container runtime on every box
this gets demoed from. Closed by **DEMO_RUNBOOK §1.1** (native Postgres 16, three env vars, steps
2–5 unchanged). The only real loss is MinIO and therefore the WORM anchor: without an Object Lock
bucket `resolveAnchorSink` (`apps/gateway/src/audit-chain.ts:601-606`) falls through to the **local
buffer**, not to `off`, so the posture ceiling is **6 of 7** with the anchor row reading
`tamperResistant: false`. §2 now argues that row is worth showing rather than apologising for.

## D03 — a branch outside `main` holds 2,751 lines, including SAP

`claude/authorized-foundation` is the one branch in this repository whose pull request (**#82**) was
**closed without being merged**. Every other branch's PR carries a `merged_at`. It holds two commits
and about **2,751 insertions** that are on no other branch:

- `packages/db/src/authorized/` — the "regulAIt Authorized" schema, including **`sap.ts` (508
  lines)** and `risk.ts`
- `scripts/gen-authorized-schema.py`
- an ADR that was renumbered 0031 → 0032 on that branch

Tip: `462591fc93bea1f02bab326a4aafb8361fec8bab`.

**Why this is recorded rather than left to be found.** The demo runbook tells whoever drives a demo
*"do not promise SAP — there is no code."* That is **true of the product** and stays true: nothing
here is on `main`, built, tested, migrated or reachable. But it is **not true of the repository**,
and somebody told the stronger version who then goes looking will find half a thousand lines of SAP
schema and reasonably conclude they were misled about something else too. The runbook states the
narrower, exact claim and points here.

**What this is not.** Not a feature, a roadmap item, or a commitment. It is dead code on a branch,
disclosed because an honest "we do not have this" has to survive somebody checking.

**If it is ever picked up**, treat it as a fresh design decision rather than a resumption: it
predates ADRs 0032–0127, the schema has moved a long way underneath it, and the ADR number it claims
is taken.

*(History, because it is short and the branch nearly went: excluded from the 2026-09-26 branch
cleanup for the reason above, deleted anyway in the sweep that followed, then restored the same day
from the SHA recorded here. Intact and verified against that SHA.)*

