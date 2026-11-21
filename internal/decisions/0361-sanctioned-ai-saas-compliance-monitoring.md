# ADR-0361: Monitor sanctioned AI SaaS through the vendors' compliance APIs

- **Status**: Accepted (owner decision 2026-11-17, Forcepoint review, gap 1; built by builder lane E42)
- **Date**: 2026-11-17
- **Index**: Read-only monitoring of conversations in sanctioned AI SaaS (M365 Copilot, ChatGPT Enterprise, Claude Enterprise) through vendor compliance APIs
- **Driver**: `internal/product/GAP_ANALYSIS_FORCEPOINT_2026-11.md` §2 row 1 (PR #935)
- **Migration**: `pending/ai_saas_monitoring.sql` (numbered at merge, ADR-0252)
- **Builds on**: [ADR-0034](0034-custom-llm-providers-egress-guard.md) (the guarded fetch),
  [ADR-0062](0062-mode-scoped-egress.md) (mode-scoped egress), [ADR-0063](0063-data-key-custody.md) (the data key),
  [ADR-0064](0064-in-process-scheduler.md) (the job contract), [ADR-0195](0195-shadow-ai-active-discovery.md)
  (read-only credentials and the Entra token path), [ADR-0042](0042-guardrail-engine.md) and
  [ADR-0140](0140-validated-pii-redaction-foundation.md) (the detectors), [ADR-0021](0021-org-settings-configurability-layer.md) and
  [ADR-0302](0302-p37-evidence-retention-and-otlp-intake.md) (the evidence retention floor),
  [ADR-0180](0180-continuous-assurance-strict-by-default.md) (secure by default),
  [ADR-0322](0322-opt-in-vendor-usage-cost-pull.md) (the opt-in vendor-credential pattern this mirrors)

## Owner decision (2026-11-17, relayed by the master in the lane E42 brief)

> Today we govern traffic that passes through our gateway. Conversations inside company AI tools (M365 Copilot,
> ChatGPT Enterprise, Claude Enterprise, Gemini for Workspace) are invisible to us.
> (1) ADR-0361, plus a vendor-neutral connector interface and the first connector, the Microsoft Purview / Graph
> Copilot interaction export. Read-only. Least-privilege scopes. Credentials held server side and rotatable. All calls
> through the guarded fetch. Interactions are ingested as evidence into the audit trail, then run through the existing
> guardrails and PII detection (ADR-0042, ADR-0140) to produce findings. Retention follows the compliance-tag cascade.
> (2) Connectors for the ChatGPT Enterprise Compliance API and the Anthropic Claude Enterprise compliance/audit API,
> using the vendors' documented APIs only.
> (3) Optional remediation: delete or quarantine a conversation through the vendor API. Off by default. Needs approval
> with step-up. Audited. Narrowing only. The action lifecycle is a declared transition table: reuse #881's (E19)
> pattern, do not copy it.
> This is not pooled telemetry: everything stays in the customer's install.

## Context

The gateway sees what is routed through it (pillar 1). A user who opens Microsoft 365 Copilot, ChatGPT Enterprise or
Claude Enterprise in a browser talks to the vendor directly, so a prompt that pastes a customer list into Copilot is
invisible to us. Each of these vendors now publishes a read-only export of its own conversations for compliance tools.
Forcepoint (and others) read them to apply their DLP policy after the fact. The gap analysis (row 1) records that we
do not.

What we already have and reuse:

- the **guarded fetch** (`egress-guard.ts`, ADR-0034): allow-listed hosts, DNS pinning, no redirects, a response cap;
- the **data-key envelope** (`secrets.ts`, ADR-0063) and its rotation census (`CIPHERTEXT_COLUMNS`);
- the **Entra token path** (`@regulait/cloud-discovery` `azureCredential`, on `@azure/identity`) and the read-only
  role check on the issued token (`entraWriteScope`, ADR-0195 decision 7), both already used by the `idp_entra`
  discovery source;
- the per-source **rate limiter** and `Retry-After` reader of the discovery worker (`spacingRateLimiter`,
  `retryAfterMs`);
- the **detectors**: the ADR-0042 guardrail registry (`runGuardrails` with the org policy from
  `resolveGuardrailPolicy`) and the ADR-0140 validated PII detector (`detectPII`, with the deployment's
  `piiInternationalCategories`), both counts-only;
- the **compliance cascade** (`effectiveCompliancePolicy` over `complianceProfilesForTags`), and the audit retention
  floor (`retentionFloor`) that ADR-0302 applies to third-party evidence;
- `requireStepUp` (`settings_relax`) and the audit log.

E17 (#880) reads agent definitions from vendor platforms and explicitly stores no prompts. The ADR-0195
scanner contract forbids a scanner to read or return prompts or responses. Neither framework can carry this feature
without breaking its own promise, so this is its own surface with its own connector contract, built from the same
primitives.

## Decision

**An admin may register a read-only connector to a sanctioned AI SaaS tenant's compliance export. A scheduled or manual
run reads the tenant's interactions through the guarded fetch, records each as append-only evidence, scans its text
with the existing guardrail and PII detectors, and writes a finding (counts only) plus an audit row for each
interaction that matched. Raw text is not kept by default. Everything stays in the customer's install. The feature is
off until an admin turns it on, and refused outright when air-gapped.**

### 1. Three switches, all off (ADR-0180)

1. The org policy (`ai_saas_monitor_policy.enabled`, default `false`). Turning it on is a `settings_relax` step-up with
   a required reason, audited, and refused under `REGULAIT_DEPLOY_MODE=air_gapped` in code (ADR-0062).
2. Each connector (`enabled`, default `false`). Enabling needs a live credential and a step-up.
3. The vendor hosts in the egress allow-list (ADR-0034), enforced by the guarded fetch on every request, the token
   request included.

Turning the policy off stops every run at once. Stored credentials stay but cannot be used; revoking is its own step.

### 2. The vendor-neutral connector contract

A connector (`ai-saas-connectors.ts`) implements one interface:

- `validateConfig(config)` — a zod schema for its public configuration (tenant ids, the users in scope, filters);
- `authorise(ctx)` — obtains a short-lived token from the stored credential, registers it for scrubbing, and reports
  what the vendor says the credential may do: `read_only`, `unverified` (the vendor offers no probe), or `write`
  (refused: the run stops before reading anything, and the credential is marked `refused` and never used again);
- `listInteractions(ctx, window)` — an async iterator of pages of normalised interactions within a time window.

It receives only the guarded fetch, the rate-limit hooks, a secret sink, an abort signal and the decrypted credential.
It never writes to the database and never decides a finding. A normalised interaction carries the vendor's own id, the
conversation id, whether it is a prompt or a response, the time, the vendor's actor id, the app it came from, and its
text. The text exists only in memory, for the scan.

### 3. The first connector: Microsoft 365 Copilot interaction export (Graph)

Verified against Microsoft Learn on 2026-11-17 (`aiInteractionHistory: getAllEnterpriseInteractions`, v1.0):

| item | value |
|---|---|
| endpoint | `GET https://graph.microsoft.com/v1.0/copilot/users/{id}/interactionHistory/getAllEnterpriseInteractions` |
| filter | `$filter=createdDateTime gt <start> and createdDateTime lt <end>` (both bounds, as documented); `$top=100` |
| paging | `@odata.nextLink`, same origin only |
| permission | application `AiEnterpriseInteraction.Read.All` (the only one; delegated is not supported) |
| users in scope | an explicit list of Entra user object ids, or all users through `GET /v1.0/users?$select=id` with `User.Read.All` |
| token | client credentials or federated assertion on `login.microsoftonline.com` (`azureCredential`, as `idp_entra`) |
| limits | Teams export throttling; `Retry-After` honoured; delta is not supported; Copilot Studio agents are not included |

Least privilege: the issued token's `roles` claim must include `AiEnterpriseInteraction.Read.All`, and every role must
be a `.Read.All` permission (`entraWriteScope`). Any write role refuses the credential. "Purview" in the brief is the
Copilot interaction export this API serves; Purview's own audit search is a separate API and is not used.

### 4. Evidence, findings and the audit trail

- **Evidence row** (`ai_saas_interactions`), one per vendor interaction, idempotent on `(connector, vendor id)`,
  append-only (a guard trigger refuses UPDATE, DELETE and TRUNCATE; only the retention sweep may delete a row past its
  floor, the ADR-0302 pattern). It holds the metadata above, the SHA-256 and length of the scanned text, and the
  detector counts.
- **Raw text is not stored by default.** The policy's `content_capture` is `none`. An admin may set it to `redacted`
  (a `settings_relax` step-up, audited): the text is then stored after ADR-0140 redaction, sealed under the data key,
  and returned only to an admin. Redaction removes PII but not secrets, so an interaction with any blocking guardrail
  finding (a credential, an injection) is never captured, even redacted.
- **Findings** (`ai_saas_interaction_findings`): one row per (interaction, detector, category) with a hit count and the
  action the org's mode gives it (`block`, `warn`, `log`). They are counts only, never the matched text. The guardrail
  detectors run with the org guardrail policy; PII runs with the deployment's international categories, and its action
  follows the connector's compliance-cascade PII mode. The ADR-0220 trained detectors are not run here (they are
  network calls with their own cost attribution); that is a follow-up.
- **Audit**: each interaction with at least one finding writes an audit row (`ai_saas_interaction`, counts only,
  hash-chained like every other row), and each run writes one summary row. So the findings are in the same single
  audit trail as pillar 1.

### 5. Retention follows the compliance-tag cascade

A connector carries compliance tags (a join table to `compliance_profiles.tag`). The retention sweep keeps an
interaction for the longest of: the composed audit floor (`retentionFloor`, with the per-mode overrides), and the
`auditRetentionDays` of the connector's tags. With no floor configured nothing is deleted. The cutoff is the database
clock's (M-075), and the guard trigger re-checks it. One audit row per deleting pass.

### 6. The credential

A new `ai_saas_monitor_credentials` table on the `discovery_credentials` / ADR-0322 pattern: a data-key envelope,
listed in `CIPHERTEXT_COLUMNS`, never returned or logged, destroyed on revoke. Store and rotate are admin-only with a
step-up and a reason; revoking needs no step-up (removing access is never harder than granting it) and disables the
connector. Every error a run stores is a fixed code plus a sentence RegulAIt wrote, never vendor text.

### 7. Runs

An open-first run ledger (`ai_saas_monitor_runs`): `running` → `succeeded` | `failed` | `refused`, a declared transition
table in `@regulait/shared`. At most one live run per connector (a partial unique index; a run left `running` past its
lease is treated as a crashed process). The window starts where the last successful run ended (or the configured
backfill, at most 30 days) and ends five minutes before now; a failed run leaves the cursor where it was, and the
idempotent evidence key makes the retry safe. Bounds per run: users, pages per user, interactions, text per
interaction. A cap reached fails the run without advancing the cursor.

### 8. Vendors and slices

| vendor | API (documented) | slice |
|---|---|---|
| Microsoft 365 Copilot | Graph `getAllEnterpriseInteractions` (§3) | 1 (this PR) |
| ChatGPT Enterprise | the Enterprise Compliance API (`api.chatgpt.com`, `conversation_message` log files per workspace, an Enterprise Compliance API key); routes and schemas verified against OpenAI's Admin API reference when built | 2 |
| Claude Enterprise | Anthropic's documented compliance API for Claude Enterprise (organization-scoped compliance key); routes verified against Anthropic's documentation when built | 2 |
| Gemini for Workspace | not in this ADR: Google exposes Gemini activity only through the Workspace audit and Vault APIs, which need their own review | later |

Slice 3 adds optional remediation (delete or quarantine a conversation through the vendor API): off by default, each
action an approval with step-up, audited, narrowing only, with its lifecycle a declared transition table reusing
lane E19's (#881) pattern. A vendor whose API offers no such action (the Graph export is read-only) says so on the
posture read instead of pretending.

### 9. Threat model

| threat | control |
|---|---|
| a stored vendor credential is stolen from the database | data-key envelope (ADR-0063); key outside the database; read-only scope limits a thief |
| the credential can write to the tenant | the issued token's roles are checked before any read; a write role refuses and marks it `refused` |
| a key or token reaches a log, run row or response | never logged; short-lived tokens registered for scrubbing; run errors are fixed codes and our own sentences |
| SSRF through a vendor URL or a `nextLink` | documented vendor hosts only, guarded and pinned fetch, `nextLink` must be same origin |
| conversation text is kept and leaks | not stored by default; opt-in copy is redacted and sealed; admin-only reads; RLS admin/system only |
| an insider turns monitoring on to read colleagues' chats | admin-only, step-up, required reason, audited; content capture is a second, separately audited step-up |
| a hostile vendor response | size cap, schema validation, bounded paging and text, counts-only findings |
| evidence is altered or deleted | append-only guard trigger, TRUNCATE refused, retention delete only past the database-clock cutoff |
| an air-gapped install leaks | refused in code under `air_gapped` |
| pooled telemetry | none: nothing leaves the install except the read requests to the customer's own vendor tenant |

## Alternatives rejected

- **Add a discovery source kind.** The ADR-0195 scanner contract forbids reading prompts, and its runs discard raw
  output. Bending it would weaken a promise other sources rely on.
- **Store every conversation verbatim.** Rejected by ADR-0180: the evidence needed for a finding is the counts, the
  hash and the metadata. A redacted copy is an opt-in.
- **`@microsoft/microsoft-graph-client` or `@microsoft/msgraph-sdk`.** Compared under ADR-0176 (record in the PR body):
  the first needs a custom HTTP handler to use the guarded fetch and adds nothing for one GET with `nextLink` paging;
  the second is a preview release. The repository already calls Graph with the guarded fetch for `idp_entra`, so this
  follows that, and the token comes from `@azure/identity` through `azureCredential`.
- **Purview audit search (`/security/auditLog/queries`).** It needs `AuditLogsQuery.Read.All`, is asynchronous, and
  returns audit metadata rather than the prompt and response, so it cannot be scanned.

## Consequences

- RegulAIt can now hold a credential that reads every Copilot conversation in a tenant. It is read-only and
  admin-gated, but it is the most sensitive read credential we hold, which is why every switch is off and content is
  not kept by default.
- Findings are after the fact: this observes and records, it does not block. Inline blocking stays the gateway's and
  the browser extension's (lane E16, #867).
- Each vendor API change can break a connector; a shape it does not recognise fails the run with a stated reason and
  writes nothing for that page.
- The routes are API only; screens are tracked on #453.

## As built (slice 1)

- **Files.** `packages/shared/src/ai-saas-monitor.ts` (catalogue, per-vendor config schemas, the Graph response schema,
  the normaliser, linear text extraction); `AI_SAAS_MONITOR_RUN_MACHINE` in `state-machines.ts` (ADR-0348, registered in
  `STATE_MACHINES`; initial `running` or `refused`); `apps/gateway/src/ai-saas-connectors.ts` (the
  connector contract and the Microsoft 365 Copilot connector); `apps/gateway/src/ai-saas-monitor.ts` (the run, the two
  scheduler jobs, retention, ten admin routes); migration `pending/ai_saas_monitoring.sql`.
- **Reused, not copied:** `azureCredential` (`@regulait/cloud-discovery`), `entraWriteScope`, `scannerFetch` and
  `dedupedSecretSink` (discovery), `spacingRateLimiter` and `retryAfterMs` (discovery worker), `createGuardedFetch`,
  `encryptSecret`/`decryptSecret`, `requireStepUp`, `resolveGuardrailPolicy` + `runGuardrails`, `detectPII` +
  `redactPII`, `piiInternationalCategories`, `complianceProfilesForTags` + `effectiveCompliancePolicy`, `retentionFloor`.
- **PII mode** of a connector resolves exactly as `projectPiiMode` does for a project: the strictest of its tags'
  profiles, else the org default (`block` by default, ADR-0181). It sets the finding's action; `redact` counts as `warn`.
- **Step-ups** (`settings_relax`): turning the policy on, turning content capture to `redacted` (separately), storing or
  rotating a credential, enabling a connector, and widening an enabled connector's configuration (more users, every
  user, fewer app-class filters, more backfill), and on any connector a tag change that shortens the tags' retention or
  makes the PII action less strict (both values are audited). Revoking a credential and every narrowing need none.
- **Data-key rotation.** Both ciphertext columns are in `CIPHERTEXT_COLUMNS`. The evidence guard lets the re-encryption
  walk rewrite `content_ciphertext` alone (the 0142 `regulait.secret_reencrypt` flag, every other column unchanged).
- **Window.** A run resumes exactly where the last success ended and spans at most one day (cap 50,000 interactions),
  so a large tenant, a 30-day backfill or a connector that was off for months catches up over successive hourly runs
  and never skips a gap. A run that still hits a per-run bound (the interaction cap, or the per-user page cap) fails
  without advancing, as §7 says, and records the window it asked for; each such failure since the last success halves
  the next window, down to a 15-minute floor, and a success resets it. A window that overflows even at the floor fails
  with that bound's code and says so.
- **Reads of captured text** are audited: one row per page that returned any redacted text (who, which connector,
  which interaction ids, never the text). Manual runs are limited to six a minute per admin (`SharedRateLimitStore`,
  503 when the limit cannot be checked).
- **Not built in slice 1:** the ADR-0220 trained detectors on monitored text; a federated (client-assertion) Entra
  credential (the secret path only, the same `azureCredential` supports both); ChatGPT Enterprise and Claude Enterprise
  (slice 2); remediation (slice 3).
- **Routes:** `GET /v1/ai-saas-monitoring`, `PUT …/policy`, `POST …/connectors`, `PUT …/connectors/:id/config`,
  `PUT|DELETE …/connectors/:id/credential`, `PUT …/connectors/:id/enabled`, `POST|GET …/connectors/:id/runs`,
  `GET …/connectors/:id/interactions`. All admin-only, all KNOWN_UI_GAPS on #453.
