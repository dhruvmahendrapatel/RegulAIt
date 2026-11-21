# ADR-0363: Classification interop (customer sensitivity labels, customer classifiers) and risk attributes for AI apps

- **Status**: Accepted (lane E44 brief, 2026-11-17: the confirmed direction; owner questions are listed at the end)
- **Date**: 2026-11-17
- **Index**: **Classification interop and an AI app risk catalogue (lane E44): Purview sensitivity labels read from files and Graph decide allow, redact or block at the gateway and feed the compliance cascade; customer regex, dictionary and hashed exact-data-match classifiers run inside the existing guardrail pipeline, versioned and approved before they publish; every AI app gets sourced, dated risk attributes and a score that shows its factors**
- **Backlog item**: `GAP_ANALYSIS_FORCEPOINT_2026-11.md` §3 gaps 3 and 4 (F×S 42 each), owner decision 2026-11-17
- **Built in**: lane E44, three PRs (1: this ADR and slice 1, labels; 2: customer classifiers; 3: AI app risk attributes)
- **Migration**: `sensitivity_labels` (slice 1); slices 2 and 3 add their own pending files
- **Related**: [ADR-0042](0042-guardrail-engine.md) (guardrail engine), [ADR-0140](0140-validated-pii-redaction-foundation.md) (shared PII detectors),
  [ADR-0176](0176-open-source-first.md), [ADR-0180](0180-continuous-assurance-strict-by-default.md), [ADR-0186](0186-batch4-approvals-receipts-detection.md) (vendored detection content on `re2js`),
  [ADR-0195](0195-shadow-ai-active-discovery.md) (discovery sources and credentials), [ADR-0158](0158-regulatory-intelligence-impact.md) (curated feed),
  [ADR-0208](0208-compliance-infra-library-lifecycle.md) (approve-before-effect), [ADR-0235](0235-wider-discovery-sources.md) (`idp_entra` scanner), ADR-0252 (merge-time numbering)

## Context

A buyer who already classifies data in Microsoft Purview expects an AI control point to honour those labels: a file
marked "Highly Confidential" should not reach an external model because a user attached it to a chat. Forcepoint sells
exactly that ("zero reclassification"). We had no label reader, no customer-defined classifier beyond the admin term
lists in `guardrail_configs.custom_terms`, no hashed exact-value matching, and an AI app catalogue
(`shadow-catalog-v3.ts`, `ai_endpoint_signatures`) that holds detection data only, not risk attributes.

What exists and is reused (repo search, 2026-11-17):

- **Files at the gateway.** Native dispatch attachments, Anthropic `document` blocks and OpenAI image parts all become
  neutral `image`/`document` content blocks (`ModelContentBlock`, base64) and every path funnels through
  `executeGovernedDispatch` → `dispatchAttempt`. One gate there covers all of them.
- **Graph.** The only Graph client is the `idp_entra` discovery scanner (ADR-0235), which already holds the credential
  (static or federated), the throttle, the guarded fetch (SSRF), the read-only write-scope refusal and the run audit.
  No E18 entitlement-graph code has merged, so the label read rides this scanner.
- **The cascade.** `complianceProfilesForTags` → `effectiveCompliancePolicy` (PII mode, guardrail floor) is the one
  funnel, versioned (ADR-0073). `resolveGuardrailPolicy` composes the floor from the project's tags.
- **Detectors.** `evaluateGuardrails` (shared) runs the detector registry with admin terms; `re2js` (RE2, linear time)
  is already pinned for vendored rules (ADR-0186). Presidio is **not** in the repo (the brief guessed it might be).
- **Approve-before-effect.** `config_versions` (ADR-0048) plus the compliance-profile lifecycle (ADR-0208): a draft
  version goes into the one approvals queue, self-approval is refused, activation happens inside the decide
  transaction.
- **Rotation-stable keyed hashing.** The discovery pseudonym key (`discovery_pseudonym_keys`, a random key stored
  under the data key, HMAC-SHA256) survives data-key rotation; `subjectDigest` does not.

## Open-source comparison (ADR-0176, owner rule of 2026-11-17)

| Need | Option | Licence | Fit | Verdict |
|---|---|---|---|---|
| Read Purview labels | Microsoft Information Protection SDK | Microsoft software licence (not MIT/Apache/BSD/ISC); native binaries; C++/.NET/Java | Full fidelity, also decrypts | **Rejected**: licence outside ADR-0176; no Node binding |
| | Parse the documented clear-text metadata (MS-OFFCRYPTO LabelInfo, `MSIP_Label_*` custom properties, `MSIP_Labels` header) with `fflate` 0.8.3 (MIT) and `fast-xml-parser` 5.12.1 (MIT) | MIT, both already pinned | Microsoft documents the metadata as clear text "so third-party apps can read it" | **Chosen**; no new package |
| Graph label definitions | `@microsoft/microsoft-graph-client` (MIT) | MIT | A client, but it would bypass our guarded fetch and token handling | **Rejected**: the `idp_entra` scanner already reads Graph through the guarded fetch |
| Custom classifiers | Microsoft Presidio (MIT) | MIT | Python service: regex `PatternRecognizer` and deny lists, no hashed exact-data-match; a second process and a second pipeline | **Rejected for slice 2**: not in the repo, and the brief forbids a second pipeline |
| | `re2js` 2.8.8 (MIT, pinned) for regex; `node:crypto` HMAC-SHA256 for exact-data-match; dictionary as a normalised token set | MIT / built in | Linear-time regex already used by ADR-0186; runs in the existing guardrail evaluator; air-gapped | **Chosen** |
| Google labels later | Drive Labels API (`drive.labels`) via the same guarded fetch | — | A second `LabelProvider` | Follow-up, interface ready |

## Decision

### Slice 1 — customer sensitivity labels (this PR)

1. **A vendor-neutral label provider.** `packages/shared/src/sensitivity-labels.ts` defines `LabelProvider` (an id, a
   reader of labels embedded in content, a reader of message headers) and `LabelDefinition`. Purview is the first
   provider. It reads `docMetadata/LabelInfo.xml` (authoritative when present), else `docProps/custom.xml`, the PDF
   info/XMP keys and the `MSIP_Labels` email header. Only enabled, not-removed labels count. An OLE compound file
   (an encrypted Office file) is `protected`. Legacy binary Office files (`.doc`, `.xls`, `.ppt`) are OLE compound
   files too, so they are also `protected` and decided by `protected_action` (block by default), labelled or not:
   safe, but an admin who sees them refused should know why. A corrupt zip or an oversized label part is
   `unreadable`. Bounds: only the two XML parts are inflated, each at most 1 MiB by declared size. The PDF scan reads
   the whole buffer (already in memory and bounded by the request body limit) with a literal search, not a regex over
   the content; head and tail windows alone failed open on a label written mid-file by an incremental save (review of
   #973). A PDF with compressed object streams (`/ObjStm`, PDF 1.5+) in which no label key is visible is `unreadable`
   (block by default), because a label inside a compressed stream cannot be seen by a literal scan.
   Relaxations (step-up, audited as relaxations) include removing a rule while `unmapped_action` is looser than it,
   and dropping or swapping a rule's compliance profile (review of #973).
2. **Definitions are read-only, through the `idp_entra` scan.** When the app's own token carries
   `InformationProtectionPolicy.Read.All`, the scan reads
   `GET /beta/security/informationProtection/sensitivityLabels` (the only Graph listing of labels; beta). It commits the complete
   list with the run, in the run's fenced transaction (`sensitivity_label_definitions`). Without the role the read is
   `skipped`, with a reason that says what to grant. A listing cut short is not kept, because a partial list would
   deactivate labels that were not read. A label the provider stops listing is marked inactive, never deleted. The
   credential stays where it is (encrypted in `discovery_credentials`, server side); no label route accepts or
   returns a secret.
3. **One decision, strict by default.** An admin maps a label to `allow | redact | block`, a data sensitivity
   (`public … restricted`) and optionally a compliance profile. The decision is the strictest action over every file
   and label. Defaults (ADR-0180): an **unmapped** label blocks; a label from a tenant we never synced is unmapped,
   because trusted tenants are exactly the synced ones; an **encrypted** file blocks; an **unreadable** file blocks. Each
   fallback can be relaxed only with a `settings_relax` step-up, and the relaxation is audited
   (`sensitivity-label-settings-relaxed`, `sensitivity-label-rule-relaxed`). Removing a mapping that falls to a looser
   fallback is a relaxation too.
4. **Where it applies.** `labelDispatchGate` runs in `dispatchAttempt` before the PII rung and before any provider
   work. It covers the native invoke, `/v1/messages`, `/v1/chat/completions`, `/v1/responses` and every fallback hop.
   A call without a file block reads nothing. `block` returns 403 `sensitivity_label_blocked`. `redact` replaces the
   file with a text marker, and drops any semantic-cache hit, because that answer was made from the unredacted file.
   One audit row is written per call that carried a label or an unreadable file. It holds label ids, actions and
   sources only, never content.
5. **Labels feed the compliance cascade.** A label mapped to a compliance profile pulls that profile into this call:
   its PII mode is composed with the project's mode (strictest wins, `stricterPiiMode`), and its guardrail floor is
   composed through `resolveGuardrailPolicy({ extraComplianceTags })`. Both go through the versioned
   `complianceProfilesForTags` funnel. A label can only add profiles, so it can only raise a floor. Example: "PHI"
   mapped to the `hipaa` profile makes a call carrying that file subject to `hipaa`'s `piiMode: block`, even in an
   untagged project.

### Slice 2 — customer classifiers (PR 2)

6. Kinds: **regex** (RE2 through `re2js`, compiled once, refused if RE2 cannot compile it, length-capped), **keyword**
   and **dictionary** (normalised, whole-word, case-folded), and **exact-data-match**: an uploaded column of values
   (employee ids, account numbers) is normalised and HMAC-SHA256'd under a rotation-stable random key stored under
   the data key (the pseudonym-key pattern). Only digests are stored. Plaintext values are never stored, logged or
   returned. At scan time, candidate tokens and n-grams of the text are hashed and looked up.
7. They run **inside the existing pipeline**: classifier findings are guardrail findings, evaluated by
   `evaluateGuardrails`, composed and audited by the engine's own modes and audit rows. Redaction uses the ADR-0140
   span-union redactor. There is no second pipeline and no second audit format.
8. Each classifier is **versioned**. *Amended as built:* versions live in their own table,
   `custom_classifier_versions`, not `config_versions`: an EDM version owns a digest set (a child table keyed by the
   version), which a `config_versions` document cannot hold under 3NF. The lifecycle is the declared ADR-0348 machine
   `CLASSIFIER_VERSION_MACHINE` (draft, pending_approval, published, rejected, superseded, retired); every status write
   is guarded by `whereFrom` and `.returning()`, so a lost race is a 409. A version takes effect only after an
   approval in the one approvals queue (the ADR-0208 pattern: no self-approval; activation inside the decide
   transaction; every step audited).
8a. **Loosening is a step-up** (ADR-0180, the ADR-0186 decision 29 precedent). Submitting a version looser than the
   published one (a weaker mode, a dropped phase, a changed pattern, a removed term or protected value, a weaker EDM
   normalisation, fewer EDM tokens, another kind) needs the author's `settings_relax` step-up, bound to both version
   ids. Retiring a published classifier needs one too.
8b. **Matching and cost bounds.** Text and values are tokenised by one function, and a token starts and ends with a
   letter or digit, so a value at the end of a sentence still matches. A dictionary word or EDM value the scan could
   never match (`O'Brien`, more tokens than `maxTokens`) is refused at save, by position only. Text past 1M characters,
   or an EDM scan past 20,000 tokens, is `unavailable` (a hit, fail closed). At most 50 classifiers, 5 of them EDM, are
   live (published or in review) at once.
8c. **Every guardrail site** runs the classifiers, including the training-corpus scan (whatever a classifier's phases:
   a corpus row is prompt and completion alike) and the cost-import text scan.

### Slice 3 — AI app risk attributes (PR 3)

9. A **curated dataset**, data not code, keyed by the catalogue's `provider`. It records data retention, training on
   customer data, hosting regions, certifications, SSO support and sub-processors. **Each value carries its source URL
   and the date it was checked**, the ADR-0158 rule. The dataset is deep-frozen and pinned by count and hash, the
   catalogue v2/v3 rule, so "scored against risk dataset v1" always means the same thing. A value we do not know is
   `unknown`, and `unknown` scores as risk (secure default).
10. **The score shows its factors**: one row per attribute with the points it added, so the score is never a bare
    number. It ranks the shadow-AI inventory and suggests site rules, and never applies one.
11. **Signing.** The compiled-in dataset's integrity is its hash pin and code review. Out-of-band updates use Codex
    lane C2's signed, offline-installable feed (proposed in #935, not built). Slice 3 defines the dataset as a feed
    payload that C2's loader can carry. It does not build a second signing path.

## Consequences

- Existing Purview labelling carries over to the gateway, with no reclassification, the moment the Entra app is
  granted one read-only permission.
- **Strict-default impact:** after this merges, any labelled, encrypted or unreadable attachment is refused until an
  admin maps labels. That is the ADR-0180 posture; text-only calls are unaffected and cost nothing.
- Labels on MCP tool results, browser uploads and endpoint hooks are not read yet (follow-up, PENDING fragment). Those
  paths reuse `readEmbeddedLabels` and `decideLabels` unchanged.
- Without lane E43 (text extraction) a label is read from metadata only. Its content is scanned only where it is text
  today.
- Four new admin routes are API-only. They are known UI gaps on #453.

## Owner questions (built with the secure default; recorded in the PR body)

1. Unmapped labels **block** by default. Would the owner rather default an unmapped label by its Purview rank (for
   example rank ≥ the tenant's "Confidential" blocks, below allows)? This needs a rank threshold per tenant.
2. Slice 3's signed update path waits for Codex lane C2. Should it be built in E44 if C2 slips?

## As built

- Slice 1: `packages/shared/src/sensitivity-labels.ts` (+ test), `apps/gateway/src/sensitivity-labels.ts` (gate,
  policy load, definition upsert, four admin routes), the `idp_entra` read in `discovery-wider-scanners.ts`, the
  commit in `discovery-worker.ts` (`inCommit`), `stricterPiiMode` in `projects.ts`, `extraComplianceTags` in
  `guardrails.ts`, migration `sensitivity_labels`. Tests: `sensitivity-labels.test.ts` (shared),
  `zz-adr0363-sensitivity-labels.test.ts`, and a case in `discovery-wider-scanners.test.ts`.
- Slice 2: `packages/shared/src/custom-classifiers.ts` (+ test), `CLASSIFIER_VERSION_MACHINE` in
  `packages/shared/src/state-machines.ts`, `apps/gateway/src/custom-classifiers.ts` (loader, six admin routes, the
  decide hooks), the `classifiers` argument at every `evaluateGuardrails` site (`guardrails.ts`, `regulait-llm.ts`,
  `cost-import.ts`), migration `custom_classifiers`. Tests: `custom-classifiers.test.ts` (shared),
  `zz-adr0363-custom-classifiers.test.ts`, and the CHECK equality in `adr0348-state-machines.test.ts`.
- Slice 3: `packages/shared/src/ai-app-risk.ts` (attributes, the factor score) and `ai-app-risk-data.ts` (the curated
  dataset v1, deep-frozen and pinned by count and hash), with `ai-app-risk.test.ts`; `apps/gateway/src/ai-app-risk.ts`
  (two read-only routes: the dataset, and the risk-ranked shadow-AI inventory with suggested, never applied, site
  rules). Test: `zz-adr0363-ai-app-risk.test.ts`. UI gaps: `scripts/known-ui-gaps/adr-0363-e44-ai-app-risk.json`.
