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
bundle and the timeStamping EKU. Failures retry with backoff (`anchor-timestamp-sweep`). The chain check does no
network revocation checking (no CRL or OCSP fetch); see Residuals.

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

### Implementation decisions (Batch 4 integration, 2026-10-07/08; `b4-int` @ e315845)
Slices A (step-up), A2+B (dual control and passkey-signed approvals) and T are merged on `b4-int`, followed by the
security-review fixes B4S-01 to B4S-09 and gaps G1/G2. The code is the authority; paths are under `apps/gateway/src/`
unless stated.

**A and B: dual control, step-up and passkey-signed approvals**
1. **New refusal codes.** Beyond the §A/§B lists: 403 `caller_cannot_approve` (the caller, or someone delegation-linked
   to them, decides their own call), 409 `approval_not_signable` (signing options for an approval that is not a
   passkey-mode tool-call approval), 422 `unknown_role` (a rule names a role that does not exist), 403
   `approval_quorum_unsatisfiable` (a connector write denied at queue time because no pool can approve it), 403
   `approval_signature_recheck_failed` (a connector write whose approval failed the execution recheck); these five are
   in `APPROVAL_REFUSALS` (`packages/shared/src/batch4.ts`). The ceremonies add 403 `browser_session_required`, 403
   `fresh_sign_in_required`, 422 `passkey_attestation_refused`, 409 `passkey_already_registered`, 404
   `unknown_challenge`, 404 `unknown_step_up` and 413 `step_up_action_too_large`. B4S-02 adds 403
   `approver_not_eligible`. Rationale: each names a different thing the person must do next.
2. **First passkey.** An account that already has a passkey, or can already step up (authenticator app or linked SSO),
   adds a passkey only with a `passkey_manage` step-up. With no way to step up (or `passkey_manage` relaxed), the
   session must come from a human sign-in (password, OIDC or SAML) less than 10 minutes old; a session exchanged from
   an API key or the bootstrap credential never counts (`passkeys.ts`). Rationale: a stolen session or key must not
   mint the account's first step-up credential.
3. **Attestation `none` only**, as the foundation note binds: any other format is refused 422 before the library
   verifies it, so no URL named in a presented certificate is ever fetched. Rationale: no egress outside the guard.
4. **Relying party** = hostname of `REGULAIT_PUBLIC_URL`, never the request's Host; unset → 409
   `passkey_rp_unconfigured`, passkey-mode approvals fail closed, and `GET /v1/org/posture` reports
   `approvalSigning.failClosed`. Rationale: a forged Host must not choose the origin a passkey is bound to.
5. **`quorum` and `approverRoleId` are versioned rule fields.** PATCH accepts them; on a versioned rule an edit mints
   and activates a version, which moves the consent context, so approvals queued under the old version go stale
   (ADR-0105). The satisfiability guard (`assertApprovalRuleWritable`) runs on every writer: create, the copilot
   applier, the edit choke point, and version mint, activation, rollback and canary promotion. Rationale: who may
   release a call is enforcing, so it must be versioned like the rest of the rule.
6. **Approver pool** = the approver named by the rule the approval records (`approvals.rule_id`) plus the active
   members of that rule's `approver_role_id`. Other matched rules do not add people; they can only raise the quorum
   (quorum = max of matched rule quorums and the sensitive quorum). Rationale: one rule decides who, any rule can ask
   for more.
7. **Tool-call approvals only.** Quorum, signatures and the `approval_decide` step-up apply to `mcp_tool` and
   `connector_call` approvals (`decideToolCallApproval`); every other approval kind decides as before. Chat taps and
   bulk decide can never sign. In `step_up` mode the decide needs an `approval_decide` step-up; `off` records method
   `none`.
8. **Queue time.** A pool that cannot reach the quorum denies the call and audits it (MCP: a deny decision; connector:
   403 `approval_quorum_unsatisfiable`) rather than queuing an approval nobody can release.
9. **Two step-ups on one request** (for example a settings write that relaxes a value and changes the break-glass
   admins) send both tokens in `x-regulait-step-up`, comma-separated; `requireStepUps` checks all before spending any.
   There is no `/sso/start` route: `/options` returns `sso.redirectUrl`.
10. **Step-up coverage** (which writes need which kind):
    - `settings_relax`: `PUT /v1/org/settings` for every key the strictness registry marks looser than its strict
      default (decision 16); the dedicated setting routes (assurance gate mode, `POST /v1/mrm/enforcement`,
      `PUT /v1/interception/settings`, `PUT /v1/policy-simulations/settings`, `PUT /v1/guardrails/config`); lowering
      a per-scope guardrail or opening an assurance window; lifting the execution mode (any move to a less
      restrictive mode, or between `read_only` and `require_approval`), agent and tool unhalt; leaving `suspended`
      for a dispatching lifecycle status; adding an Outlook recipient; narrowing the deploy modes a rule applies to;
      narrowing a revocation from `full` to `read_only`; lifting any revocation; deleting any governance rule;
      approval-rule writes that loosen dual control (decision 11); granting admin; assigning an approver role (directly,
      by group-role mapping, or by onboarding group-role import); adding a member to an approval team;
      `POST /v1/delegations`; set-initial-password and MFA clear for another user; routing rules and SLA policies that
      reassign or add an assignee.
    - `owner_change`: changing the owner of a server, connector or agent, and an agent's steward.
    - `break_glass`: changing `localSignIn` or `breakGlassUserIds`.
    - `evidence_hold_override`: overriding an agent evidence hold, and `POST /v1/retention-holds/release`.
    - `passkey_manage`: adding a passkey (decision 2), revoking one's own, and an admin revoking another user's.
    - `approval_decide`: deciding a tool-call approval in `step_up` signature mode.

**Loosening an approval rule needs a step-up**
11. An approval-rule write that lowers the quorum, widens the eligible pool (anyone new in it, or more principals),
    deletes the rule, or activates a version (including rollback) that does any of these needs a `settings_relax`
    step-up bound to `{ruleId, values}` (`assertApprovalRuleLooseningStepUp`). Raising the quorum or narrowing the pool
    needs none. Replacing the named approver with someone outside the current pool counts as widening. A writer with no
    request to step up (the copilot applier) is refused 403 `step_up_required` whenever the stored policy requires the
    step-up. Rationale: ADR-0180, no silent loosening by any path.

**Security-review fixes (B4S, as implemented)**
12. **Eligibility is fixed at queue time (B4S-02, B4S-09).** A decider counts only if the account was created before
    the approval's `requested_at` and is active now; a role member only through a role assignment created before then;
    a passkey only if enrolled before then; a delegation only if created before then and live now. The comparison runs
    in SQL against `requested_at`. The named approver is the one named at queue time (`snapshotNamedApprover`): the
    stored approver if never re-pointed, else the approver recorded before the first routing or claim; when that cannot
    be established nobody has the named approver's standing (strictest fallback). New refusal 403
    `approver_not_eligible`. Rationale: dual control must not be satisfiable by people or links created after the call
    was queued.
13. **Routing does not grant decide on tool calls.** A team claim or routing re-point moves where a tool-call approval
    shows, not who may decide it; the approver named at queue time still can. Claims still re-point the approver for
    every other kind (G2).
14. **Execution recheck of every decider (B4S-09).** In every signature mode, `consumeBoundApproval` re-applies the
    decision-12 predicate to every approving decision (and, in passkey mode, re-verifies each signature). Any failure
    supersedes the approval, refuses the call and audits the reason.
15. **Sensitivity is decided by the server (B4S-03).** A call needs the sensitive quorum when its attributed project
    carries an in-app-only classification, or when the calling person is a member of any such project. The
    `x-regulait-project-id` header can only raise this, never lower it.
16. **One strictness registry (B4S-04).** `org-setting-strictness.ts` is typed over every key `PUT /v1/org/settings`
    can write (a missing key does not compile); `relaxedOrgSettingKeys` derives from it. It covers the strict identity
    defaults, `approvalTtlHours`, the API-key lifetimes, `infraApproverUserId` and `defaultAuditRetentionDays`.
    Exemptions carry a written reason: optimisation dials, capacity ceilings, the opt-in IP envelope, `tracingEnabled`,
    the prune schedule, reporting-only keys, keys that only tighten, and keys whose change has its own step-up
    (`localSignIn`, `breakGlassUserIds`).
17. **Rule deletes and revocation lifts (B4S-05)**: listed in decision 10.
18. **Bootstrap credential (B4S-06).** It passes a step-up only while no active admin has a usable method (authenticator
    app, unrevoked passkey with a relying party configured, or a link to an enabled SSO provider). After that a
    protected action from it gets 403 `step_up_required` with `methods: []` and `credential: "bootstrap"`, and
    `GET /v1/org/posture` reports `bootstrap.findings` `bootstrap_token_configured` while the token is still set.
    `demo:prepare` makes its protected writes during first-admin setup. Rationale: the credential has no identity to
    prove, but a fresh install must still be configurable.
19. **SSO step-up only over https (B4S-07)**, direct or at a trusted proxy; otherwise `sso` is neither listed nor
    started. Rationale: the binding cookie cannot be `Secure` and the state would cross in the clear.
20. **Owner changes (B4S-01):** a stewardship steward change uses the same `owner_change` step-up as an owner change.
    **Execution mode (B4S-08):** the `require_approval` step-up facts include `approverUserId`.
21. **PR #198 review fixes (2026-10-08).** Six findings from the automated review, each with a real-DB test that failed
    first (`zz-b4c-review-fixes.test.ts`):
    - Lifting an agent or tool halt decides the step-up again on the locked row, so a halt that lands between the
      first read and the lock is never lifted without one.
    - Delegation links are followed through the whole chain (caller → B → C → approver counts as one person) for
      both self-approval and quorum.
    - The copilot's `rule_to_approval` keeps `quorum` and `approverRoleId`: they are part of the shared create schema.
    - The approver role is snapshotted on the approval at queue time (`approvals.approver_role_id`, migration 0171;
      Batch 5 moves to 0172). Eligibility and queue visibility read the snapshot, never the rule's current role.
    - An active delegate of an approver-role member sees the approval in the queue. Visibility is a little wider
      than eligibility (it does not check queue-time ages); deciding still checks everything.
    - The two step-up ceremony routes ride the strict credential tier (10 per 5 minutes), per IP and per user, in
      buckets separate from sign-in. That caps a person at about five step-ups per five minutes; a deployment that
      needs more raises `REGULAIT_AUTH_RATE_LIMIT_MAX` (which also moves the sign-in tier). Secure by default.
22. **PR #198 review fixes, round 2 (2026-10-08)** (`zz-b4c2-review-fixes.test.ts`, each red first):
    - The execution recheck recounts approving principals against the quorum in every signature mode, not only
      passkey, so approvers who become delegation-linked after quorum no longer release a quorum-2 call.
    - The queue-time named approver is one SQL expression (`namedApproverSnapshotSql`) read by eligibility, the
      recheck and queue visibility, so a routing rule that re-points a pending row cannot strand it.
    - An unversioned rule's `quorum` and `approverRoleId` are part of the consent context digest
      (`ApprovalRuleVersionRef.dualControl`); raising either retires older consents. Versioned rules and the pinned
      digest vectors keep their shape.
    - **A security decision is never taken on an unlocked read and then written blind.** The org-settings PUT decides
      break-glass and relax step-ups on the row it holds locked. Nine other step-up writes (assurance gate mode,
      interception settings, MRM enforcement, the policy-simulation dial, org guardrail defaults, revocation scope,
      server and connector owner, agent steward, Outlook recipients) re-read under a lock or compare-and-set and
      answer **409 `changed_concurrently`** when the value moved since the decision. Org guardrail defaults take
      advisory lock `6_000_000_186`.
    - OIDC `auth_time` is compared at its own (whole-second) precision, so a fresh re-login in the same second as
      the request is no longer stale; an earlier second still is.
    - Test fixtures that approved tool calls with a raw row update now also write the `approval_decisions` row the
      real decide path writes, on their own scratch databases.
23. **PR #198 review fixes, round 3 (2026-10-08)** (`zz-b4c3-review-fixes.test.ts`, each red first on 33d009c):
    - The org-wide `approval_signature_mode` and `tool_approval_sensitive_quorum` are part of the consent context of
      MCP and connector calls (`ApprovalContextRef.orgDualControl`); tightening either retires consents approved under
      the looser setting (re-queued as `approval_context_stale`). Every live consent digest moved once with this
      change, which re-queues approvals pending or approved before it (fail closed). The shared pinned vectors do not
      name the field and keep their shape.
    - `POST /v1/agents/:agentId/owner` compare-and-sets the owner (and successor) it read: **409
      `changed_concurrently`** instead of reverting a concurrent owner change without `owner_change`.
    - **Approver-pool membership and approval-rule writes serialise on the role row** (`FOR UPDATE`): a role
      assignment, a group mapping and an onboarding group import re-decide `isApproverRole` under the lock
      (`lockApproverRoles`) and answer 409 `changed_concurrently` if the role became an approver role meanwhile;
      every approval-rule write that names a role locks it in the satisfiability guard
      (`approvalRuleQuorumRefusal`) inside its transaction, so its loosening step-up sees committed members. Team
      membership needs no lock: routing rules and SLA escalations that make a team an approval team always need a
      step-up, so any interleaving equals a legitimate serial order.
    - `PATCH /v1/rules/:kind/:ruleId/deploy-mode` re-reads the scope under the rule's row lock (409 on a move).
    - **409 `changed_concurrently`** (`CHANGED_CONCURRENTLY`, step-up.ts) means: the state a step-up decision rested
      on moved before the write took its lock, so nothing was written. The client reloads and repeats the change,
      which is decided again and may now ask for a step-up.

**Two notes on B4S-09 (no code change)**
- **Tool-scoped approvals in passkey mode.** The recheck rebuilds the signed payload from the arguments of the call
  actually run. A tool-scoped approval (ADR-0104) still matches a call with other arguments at the database lookup, but
  the signature then fails to verify: the approval is superseded and that call refused. In passkey mode a tool-scoped
  approval therefore releases only the exact call that was signed.
- **MCP opens the upstream session before the recheck.** `executeGovernedToolCall` connects to the upstream (the MCP
  `initialize`; for stdio, the process start) before it consumes the approval. A failed recheck refuses the call before
  `tools/call` and the session is closed, so the tool never runs, but the upstream sees a connection.

**T:** an open tracing UI that accepts only protobuf over OTLP/HTTP needs an OpenTelemetry Collector between it and our
JSON exporter (`docs/deployment/DATA_BOUNDARY.md`).

### Residuals (2026-10-08)
- **First-passkey enrolment race.** Two concurrent "first" enrolments from one fresh session can both succeed. Low:
  that session may enrol a first passkey anyway. Closing it needs the register ceremony to record how it was admitted
  (a column on `webauthn_challenges`, whose shape CHECK allows no action fields for `register`): a migration.
- **409 `changed_concurrently` in the web client** is shown through the generic error display; a dedicated
  "this changed while you were deciding, reload" message is a follow-up.
- **V, NeMo: zero eligible rules.** The NeMo rules that fit the pack are code, SQL and XSS output-injection rules, which
  need position semantics that `any`/`N of them` conditions cannot express. Importing them would need a hand-written
  evaluator, which ADR-0176 bars. The pack stays empty; revisit only through a new ADR.
- **V, credential audience.** Outbound enforcement of `pipelock-secrets` audience hosts is not wired yet (no
  `credential_audience_violation` in the code); Claude owns it.
- **S:** no network revocation checking on the TSA chain (no CRL or OCSP fetch, which suits air-gapped installs).
- **M:** `mcp_server_baseline_drift` sees only calls attributed to a builder agent.
- **B4S-03 target binding.** No table binds a server or connector to a project, so the target of a call cannot make it
  sensitive. Follow-up needing a migration.
- **Recheck in `step_up`/`off` mode** (corrected in round 3): since round 2 the recheck recounts principals in every
  mode, so an approved row with no recorded decisions fails it (`below_quorum`) in every signature mode.
- **Test fixtures.** 22 gateway suites that do not test step-up relax it with `relaxStepUpForTest` (17 from slice A;
  5 added in the security round: `auth`, `adr0174-enterprise-sign-in`, `release-age`, `prompt-registry`,
  `zz-adr0175-credential-inventory`).
- **Round 3 (landed 2026-10-08, b08f291):** creating a user with `isAdmin: true` (`POST /v1/users`) now needs a
  `settings_relax` step-up bound to the email (the account has no id yet); the non-CI e2e specs step up the real way
  (Ada with TOTP) instead of the bootstrap credential; the credential-inventory page-total test walks every page
  instead of assuming one; `approver_not_eligible` and the seven ceremony codes are in the shared refusal list (27
  codes) with a web drift guard. Still open: `enrolAdminTotp` (demo-identity.ts) reads only the first page of
  `GET /v1/users`, the same root cause as the missing user search/cursor route.

### Codex slices (status 2026-10-08)
- **R, receipts (X21, #182):** in review, merge after fixes. Majors R21-01 (online verify trusts the bundle's keys),
  R21-02 (an empty or over-long audit tool name stalls signing), R21-03 (foundation test expectations); minors R21-04
  (admin configuration rows selected), R21-05 (list route unaudited); nit R21-06.
- **S, timestamps (X22, #184):** changes requested. Highs R22-01 (retry imprint differs from the WORM record) and R22-02
  (anchors list ships raw tokens, no timestamp field); mediums R22-03 (backdated `genTime` accepted) and R22-04; lows
  R22-05 to R22-08; info R22-09.
- **V, vendored detection (X23, #185):** changes requested; adjudication on `review/x23-adjudication`. The NeMo and
  credential-audience residuals above come from it.
- **M, monitor rules (X24, #187):** in review.
Codex pushed revisions to X21 to X23 before the review was posted; which findings they address is not yet checked.

## Consequences
- Approvals become provable: who approved exactly which call, re-checked when it runs; two people for sensitive data.
- Decisions get offline-verifiable receipts, and anchors a third-party time, without pretending when unconfigured.
- Detection improves with pinned, licensed, linear-time vendored content.
- Every approver must enrol a passkey before approving (demo:prepare enrols soft passkeys).
- Codex works on gateway code for the first time; the cross-review and the foundation's fixed contracts contain that.
