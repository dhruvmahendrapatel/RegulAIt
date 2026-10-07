# ADR-0186: Batch 4 — dual control, step-up and passkey-signed approvals, signed receipts, RFC 3161 timestamps, vendored detection content, monitor rules

- **Status:** Accepted
- **Date:** 2026-10-07
- **Deciders:** owner (four decisions and the Claude/Codex split, 2026-10-07); the rest follows ADR-0180 (secure by
  default) and ADR-0176 (open source first)
- **Builds on:** ADR-0183 batch 4 (DELIVERY_PLAN_2026-10-06 §Batch 4), ADR-0182 (approvals, evidence hold, monitor),
  ADR-0104 (approval binding digests), ADR-0060 (audit anchors), ADR-0177 and its clean-room amendment (vendored
  content), ADR-0185 (format, migration convention)

## Context

Facts found on `main` @ f5bb473 (design pass, 2026-10-07):
- An approval rule names exactly one approver (`approval_rules.approverUserId`). A quorum column exists on
  assignments but nothing counts it for tool calls; only workflow stages have all/any.
- Step-up exists only at login. There is no WebAuthn. A chat-tap decision is already "not re-authenticated".
- There are no decision receipts. The audit chain is SHA-256 linked; export bundles are Ed25519 signed from an env key.
- Audit anchors carry no trusted timestamp.
- Credential rules are derived from gitleaks, not vendored; injection rules match literal English only.
- **The trace-standards item is already done** (2b80111, 2026-10-05: all six gaps closed, OpenInference profile,
  semconv 1.43.0 pinned). Only a small residual remains (item T).

## Decision

### Owner decisions (2026-10-07)
1. **Tool-call approvals are passkey-signed** (`approval_signature_mode = passkey`). Each approver signs the exact call;
   the gateway re-verifies every signature against the call actually run. An admin may relax to `step_up` or `off`
   (audited, and itself needs a step-up).
2. **Dual control on sensitive data:** `tool_approval_sensitive_quorum = 2` for calls attributed to projects carrying an
   in-app-only data classification. The caller cannot approve their own call; a delegator and delegate count once.
3. **SSO-only organisations step up with a fresh SSO login**: OIDC re-authentication (`max_age=0`, `prompt=login`, the
   ID token's `auth_time` checked against the challenge) and SAML `ForceAuthn="true"` (the assertion's `AuthnInstant`
   checked). Passkey and TOTP remain available step-up methods for everyone.
4. **Receipts cover governed-call decisions and approval decisions.** Admin configuration rows stay on the hash chain.

### Work split (owner direction, 2026-10-07): Claude and Codex build equal halves and review each other
This changes AgentCoordination ground rule 2 for this batch: Codex owns full vertical slices (gateway + web + tests),
not only `apps/web`.
- **Claude (≈5 units):** the foundation (migration 0170, `schema.ts`, shared zod/constants, settings, route/openapi
  registration with 501 stubs for Codex's routes, seams, every new dependency and the lockfile); **A** dual control and
  step-up including the fresh SSO login; **B** passkey-signed approvals; **T** the trace residual.
- **Codex (≈5 units):** **R** signed decision receipts and the offline verifier; **S** RFC 3161 timestamps on audit
  anchors; **V** vendored detection content; **M** four monitor rules.
- **Cross-review:** each side reviews the other's PR against this ADR and AgentCoordination §4.9 before `b4-int`
  merges. Findings as `ID | severity (blocker/major/minor/nit) | file:line | exploit or failure | fix`, IDs `B4X-NN`
  (raised by Codex) and `B4C-NN` (raised by Claude). The author fixes their own findings; every blocker/major fix
  carries a red proof and its SHA; the reviewer closes it. No merge with an open blocker; a minor may be deferred only
  as an ADR residual. Deepest review: A+B (by Codex: approval bypass, replay, quorum via delegation, the execution
  recheck, SSO re-auth freshness) and V (by Claude: ReDoS, missed redaction on the audit path, licence/provenance);
  R and S reviewed by Claude for key handling, chain integrity, SSRF and trust-chain validation.
- **Hot files:** `app.ts`, `route-classes.ts`, `openapi-registry.ts`, the lockfile, `schema.ts`, migrations and shared
  zod are Claude's; Codex asks for one-line changes under "To Claude". `App.tsx`, `api/client.ts` (after the
  foundation) and `views/admin/settings/**` are Codex's; Claude asks under "To Codex".

### Libraries (npm, 2026-10-07; pinned exactly; THIRD_PARTY rows)
`@simplewebauthn/server` 14.0.3 (MIT), `@simplewebauthn/browser` 14.0.0 (MIT), `pkijs` 3.4.1 + `asn1js` 3.0.10
(BSD-3), `canonicalize` 5.1.0 (Apache-2.0, RFC 8785). All work air-gapped. `re2js` (already locked) runs every
vendored rule. `canonicalize` is admitted only if a corpus test proves it byte-identical to our `canonicalJson` for
receipt payloads; otherwise the existing canonicaliser stays (written exception). YARA engines are not added (no
maintained pure-JS engine); NeMo YARA rules are converted to data.

### Migration 0170 (`0170_batch4_approvals_receipts_detection.sql`, journal `when` 1785105000000)
- `webauthn_credentials` (per user; COSE public key, counter, transports, aaguid, backed_up, label, revoke fields).
- `webauthn_challenges` (purpose `register | step_up | approval_sign`; session-bound; action digest; ≤ 5 min;
  single use via `UPDATE … WHERE used_at IS NULL AND expires_at > now() RETURNING`).
- `step_up_grants` (`rgsu_` token stored as sha256; session-bound; method `passkey | totp | sso`; action kind and
  digest; single use; expiry).
- `sso_reauth_requests` (state, nonce, session, action digest, provider, requested_at, used_at; ≤ 5 min).
- `approval_decisions` (append-only by trigger; one row per approving principal: decider, principal, decision, reason,
  step-up method, credential id, signed payload, signed digest, assertion, counter_before; UNIQUE(approval, principal)).
- `approval_rules` + `quorum` (1–5) + `approver_role_id`; `approvals` + snapshotted `quorum` and `signature_mode`.
- `decision_receipts` (append-only; seq, audit id/seq, payload, payload hash, prev hash, signature, key id) and
  `receipt_signing_keys` (public keys only).
- `audit_anchors` + `tsa_status` (`not_configured | pending | granted | failed`, default `not_configured`) and the
  token fields (url, DER token, gen time, serial, policy OID, imprint, attempts, last error).
- `org_settings`, all strict: `approval_signature_mode` passkey; `step_up_mode` required; `step_up_max_age_seconds` 120
  (30–900); `step_up_actions` = approval_decide, settings_relax, evidence_hold_override, break_glass, passkey_manage,
  owner_change (removing one is a relaxation); `tool_approval_sensitive_quorum` 2; `decision_receipts_mode` on;
  `audit_anchor_timestamp_mode` required; `vendored_detection_packs` all four; `monitor_mcp_baseline_days` 14;
  `monitor_jailbreak_threshold` 3; `monitor_jailbreak_window_hours` 24. Every relaxation is audited through
  `org-settings-updated` with `detail.transitions` and needs a `settings_relax` step-up.

### A — dual control and step-up (Claude)
Required quorum = max(matched rule quorums, the sensitive-project quorum), snapshotted at queue time. Eligible pool:
the named approver plus active members of `approver_role_id`; the caller is never eligible; delegation counts once.
Any deny vetoes; approval only when distinct approving principals reach the quorum, under `SELECT … FOR UPDATE`. A
rule whose pool can never reach its quorum is 422 `quorum_unsatisfiable`; at queue time the call is denied and
audited. Step-up grants are single use, session-bound and bound to `action_digest = sha256(canonical{v:
"regulait.step-up.v1", kind, request facts})` recomputed by the server. API keys, chat taps and bulk decide cannot
step up. Fresh SSO login: the gateway starts an OIDC flow with `max_age=0`/`prompt=login` (or SAML `ForceAuthn`), and
the grant is issued only if the returned identity is the session's user and `auth_time`/`AuthnInstant` is after the
request. Refusals: 403 `step_up_required` (with `methods`, `actionKind`), 422 `step_up_unavailable`, 403
`duplicate_approver`, 422 `quorum_unsatisfiable`, 409 `approval_requires_individual_signature`, 403
`chatops_step_up_required`, 409 `sso_reauth_stale`, 403 `sso_reauth_identity_mismatch`.

### B — passkey-signed approvals (Claude)
Challenge = base64url(sha256(canonical{v:"regulait.approval-sign.v1", approvalId, decision, argumentsDigest,
contextDigest, serverId|connectorId, toolName, nonce})), userVerification required. The decision stores the assertion,
payload and counter. At execution `consumeBoundApproval` re-verifies every approving signature against digests
recomputed from the call actually run; any mismatch supersedes the approval, refuses the call and audits
`approval-signature-recheck-failed`. WebAuthn RP ID = hostname of `REGULAIT_PUBLIC_URL`; unset → 409
`passkey_rp_unconfigured` and passkey-mode approvals fail closed (posture finding). Refusals: 403
`passkey_signature_required`, 422 `passkey_signature_invalid`, 409 `passkey_challenge_expired`, 409
`passkey_challenge_used`, 409 `approval_action_changed`.

### R — signed decision receipts and offline verifier (Codex)
A one-writer sweep (`decision-receipt-sign-sweep`, advisory lock, audit-seq order, idempotent) signs receipts with
Ed25519 over the canonical payload `{v:"regulait.receipt.v1", receiptSeq, audit:{id, seq, rowHash, contentHash},
decision:{at, userId, objectType, objectId, serverId, toolName, effect, ruleId}, prev, keyId}` — no reason or detail
text. Key from `REGULAIT_RECEIPT_SIGNING_KEY` (PKCS8 PEM path) and `_KEY_ID`; unset → status `no_key`, posture
"unsigned"; a key whose public key differs from the recorded one for its id is refused. A pure verifier
(`packages/shared/src/receipts/verify.ts` + `scripts/verify-receipts.mjs`) reports `valid`, `invalid` or
`unverifiable`, and states what a pass cannot prove (omission after the last receipt, correctness, signing time
unless an anchor timestamp covers it).

### S — RFC 3161 timestamps on audit anchors (Codex)
`REGULAIT_TSA_URL` (egress allow-listed, pinned fetch), `REGULAIT_TSA_TRUST_BUNDLE`, optional
`REGULAIT_TSA_POLICY_OID`; no default public TSA. Air-gapped: an internal TSA, or unset → honestly "not timestamped".
After an anchor flushes, a pkijs `TimeStampReq` (sha256 of the anchor's canonical bytes, nonce, certReq) is sent; the
response must be granted with matching imprint and nonce, the ESS signing-certificate binding, a chain to the trust
bundle and the timeStamping EKU. Failures retry with backoff (`anchor-timestamp-sweep`).

### V — vendored detection content (Codex; owner decision: redact on match)
`packages/shared/src/detection-content/vendor/{pipelock,nemo,agt}/` with `PROVENANCE.json` (repo, commit, path, file
sha256, SPDX, retrievedAt) and the upstream LICENSE/NOTICE; a test re-hashes every file; nothing from `enterprise/` or
`ee/`. Converted to data by `scripts/vendor/*.mjs`; every rule runs on `re2js`; non-RE2 rules are listed
`not_imported` with a reason. Packs: `pipelock-secrets` (redacts on the audit path, audited by rule id and count only;
credential-audience hosts enforced on outbound), `pipelock-normalise` (before injection rules),
`nemo-yara-injection` (`any`/`N of them` conditions only), `agt-mcp-heuristics` (admission findings). Codex fills the
foundation's `VENDORED_*` and `normaliseForInjection` seams with data and does not edit `guardrails.ts`,
`audit-scrub.ts` or `mcp-admission.ts`.

### M — four monitor rules (Codex)
`mcp_server_baseline_drift` (an agent calls a server it did not call in the baseline window), `sharing_scope_widened`,
`instructions_changed_after_approval` (active system-prompt version differs from the one active at the use case's last
approving decision; not evaluated without history), `jailbreak_correlation` (threshold findings for one user in the
window, followed by an allowed tool call). Loader `apps/gateway/src/monitor-detection-rules.ts` feeds
`MonitorInput.detection`.

### T — trace residual (Claude)
An OTLP ingest-shape fixture test for the two open tracing UIs ADR-0177 names, `schema_url` stamped from the pinned
semconv version, and a written end date for the `gen_ai.system` transition window.

The HTTP contracts are in AgentCoordination.md §4.9.

### Foundation notes (2026-10-07, commits e256fdc and 7a5df2f)
- **Passkey attestation (binding on A).** Verifying a certificate-bearing attestation makes `@simplewebauthn/server`
  fetch revocation-list URLs named in the presented certificate, outside the egress guard. Registration requests
  `attestationType: "none"`, refuses any other attestation format before verification, and never initialises the
  library's metadata service.
- **`canonicalize` admitted.** It is byte-identical to `canonicalJson` on 304 receipt-shaped payloads, edge values and
  2,000 seeded random values. It differs only by throwing on NaN, ±Infinity and lone surrogates, none of which a
  receipt payload can contain (numbers are integers or digests, strings are ids and hex).
- **Secret redaction on the audit path is unconditional.** The ledger write reads no settings, so the
  `pipelock-secrets` pack always redacts there; `vendored_detection_packs` governs the other surfaces only. Removing it
  from the audit path would be a relaxation that this ADR does not offer.
- **Approval rules path.** The rules live at `/v1/rules/approvals` (not `/v1/approval-rules`); A extends that route
  with `quorum` and `approverRoleId`. §4.9 is corrected to match.
- **Ranges the ADR left open, chosen strict:** `monitor_mcp_baseline_days` 1–90, `monitor_jailbreak_threshold` 1–100,
  `monitor_jailbreak_window_hours` 1–168; `step_up_mode` and `audit_anchor_timestamp_mode` are `required | off`,
  `decision_receipts_mode` is `on | off`.
- New free-text columns `approval_decisions.reason` and `webauthn_credentials.revoke_reason` (and the passkey label)
  are registered with the prose scrub.

## Consequences
- Approvals become provable: who approved exactly which call, re-checked when it runs; two people for sensitive data.
- Decisions get offline-verifiable receipts, and anchors a third-party time, without pretending when unconfigured.
- Detection improves with pinned, licensed, linear-time vendored content.
- Every approver must enrol a passkey before approving (demo:prepare enrols soft passkeys).
- Codex works on gateway code for the first time; the cross-review and the foundation's fixed contracts contain that.
