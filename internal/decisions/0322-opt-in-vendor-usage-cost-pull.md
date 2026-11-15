# ADR-0322: Opt-in, per-tenant read-only pull of vendor usage and cost data

- **Status**: Accepted
- **Date**: 2026-11-15
- **Amends**: [ADR-0069](0069-cross-vendor-cost-consolidation.md) (its no-credential, no-outbound scope and "Why not a
  scheduled re-import"), [ADR-0076](0076-cost-reconciliation-roster-ingest.md) (its "Still no polling" line)
- **Driver**: `internal/product/MARKET_ANALYSIS_2026-11.md` §3a gap G1 (PR #844)
- **Builds on**: [ADR-0034](0034-custom-llm-providers-egress-guard.md) and its pinned-egress amendment (the guarded
  fetch), [ADR-0062](0062-mode-scoped-egress.md) (mode-scoped egress), [ADR-0063](0063-data-key-custody.md) (the data
  key), [ADR-0064](0064-in-process-scheduler.md) (the job contract), [ADR-0195](0195-shadow-ai-active-discovery.md)
  (the read-only credential precedent), [ADR-0180](0180-secure-by-default.md) (secure by default)

## Owner decision (2026-11-15, recorded by the master)

> Gap G1 approved as "opt-in per tenant": amend ADR-0069/ADR-0076 so a tenant admin can add a read-only vendor
> usage/cost credential; off by default; file import stays.

## Context

ADR-0069 consolidates a person's spend across vendors from files an administrator uploads. It deliberately held no
vendor credential and made no outbound request, and its "Why not a scheduled re-import" section named the three
decisions a pull would need: an egress decision (ADR-0034/0062), a credential-custody decision (ADR-0063) and a
per-vendor API-shape decision. ADR-0076 kept that posture ("Still no polling").

An enterprise buyer reads the file-only posture as a gap: the figures are as fresh as the last upload, and every
upload is a manual monthly task. Every vendor in scope now ships a documented, read-only usage or cost API. The owner
has decided to close the gap as an opt-in, per-tenant feature. This ADR makes the three deferred decisions.

## Decision

**A tenant admin may register a read-only vendor usage/cost credential. A scheduled job pulls that vendor's usage and
cost through the guarded fetch and writes the result into ADR-0069's imported ledger, as `basis = 'imported'` and
never blended with metered spend. The feature is off for every tenant until an admin turns it on, it is refused
outright in air-gapped mode, and file import is unchanged.**

### 1. Off by default, per tenant, refused under `air_gapped`

- "Tenant" here is the one org of a deployment (single-tenant per install, ADR-0041). An org-level setting,
  `org_settings.vendor_usage_pull`, defaults to `off`. Until an admin sets it to `on` (MFA step-up, a
  required reason, audited), no credential can be stored and no pull runs. Turning it off stops every pull at once and
  leaves stored credentials in place but unusable; revoking them is a separate, explicit step.
- Each connector is also `enabled = false` when created, and each vendor host must also appear in the tenant's egress
  allow-list (ADR-0034). Three switches must be on before one byte leaves.
- Under `REGULAIT_DEPLOY_MODE=air_gapped` the setting cannot be turned on, a stored connector never runs, and the
  posture read says why. Air-gapped installs keep file import only. This is a refusal in code, not a reliance on the
  network having no route (ADR-0062).
- The scheduler job is registered in the ADR-0064 registry and runs only where the scheduler is on, which is off by
  default everywhere. A "pull now" route runs the identical function.

### 2. The credential: read-only, encrypted, rotatable, never returned or logged

- A new `vendor_usage_credentials` table on the `discovery_credentials` pattern (ADR-0195 decision 7): the secret is a
  data-key envelope (`secrets.ts`, AES-256-GCM, ADR-0063 rotation walk), listed in the ciphertext-column census,
  never returned by any route, never written to a log or an audit row, and destroyed (set to NULL) on revoke.
- Only the scope the vendor documents as read-only for usage and cost is accepted. Where a vendor offers a probe that
  reveals the scope (a fine-grained token's permissions, an IAM simulation), the connector verifies the credential is
  read-only before its first pull and refuses a credential that can write. Where a vendor offers no such probe, the
  posture read says the scope is `unverified` and names what the admin attested.
- AWS uses the ADR-0195 federated `AssumeRole` path (external ID generated per source) by default. A static AWS key is
  an audited step-up relaxation, as in ADR-0195.
- Storing, replacing (rotating) and revoking a credential are admin-only, MFA step-up, a required reason, audited.
  Rotation replaces the envelope in place and keeps the connector's history. Revoking is free of step-up, because
  removing access must never be harder than granting it.
- Every outbound request goes through `scrub-secrets` on the error path, so a vendor error that echoes the key does
  not reach a log, a run row or a response.

### 3. Egress: the guarded fetch, bounded, rate-limited, idempotent

- Every request goes through the pinned, SSRF-guarded fetch (ADR-0034 amendment 3), to the vendor's documented host
  only. A connector cannot point at an arbitrary URL; a test-only base-URL override exists for fake servers and is
  refused unless the deployment is a test build.
- Official SDKs are used where they expose the endpoint and accept an injected `fetch` (ADR-0176: `openai`
  Apache-2.0, `@anthropic-ai/sdk` MIT, `@octokit/rest` MIT, `@aws-sdk/*` Apache-2.0), with the guarded fetch passed
  in. An endpoint an SDK does not cover is called with the guarded fetch directly, and the commit says so.
- Responses are size-bounded and schema-validated before use. Pagination is bounded per run. Each vendor has a
  per-tenant rate limit set below its documented limit, and a 429 backs off and resumes from the stored cursor.
- Writes are idempotent upserts keyed on the vendor's own fact identity (vendor, account, bucket start and end,
  model or SKU, line kind). A re-pull of the same window replaces its own rows, so a retried run never doubles a
  figure. Each pull writes a `vendor_usage_pull_runs` ledger row (open-first, like `scheduler_runs`) and an audit row.

### 4. What stays the same

- **`basis = 'imported'`.** Pulled lines are imported lines. They land in `imported_cost_lines` under a batch whose
  source is `pull` (file batches are `file`), and the existing CHECK still admits only `'imported'`. `consolidate()`
  still has no field for metered plus imported, and the existing tests that walk every response body still apply.
- **ADR-0051 billing statements stay metered-only.** A vendor's restated figure is not billable by us.
- **Identity resolution is ADR-0069's.** A pulled account (an email, a vendor user id, an API-key id, a workspace or
  project id, an IAM principal ARN) goes through the same alias, exact-email, domain-rule, unresolved precedence. A
  vendor user id or key id resolves only through an admin alias or the ADR-0076 roster; nothing is guessed. Project
  and cost-centre mapping uses the existing aliases, so a vendor workspace or project can map to a RegulAIt project.
- **Reconciliation is ADR-0076's.** Exact-tuple supersession, newest restatement wins, ambiguity is reported and left
  alone. A file import and a pull of the same vendor fact are reconciled by the same sweep.
- **File import stays**, for every vendor and in every mode.

### 5. No double counting against metered gateway spend

Some vendor-reported spend is traffic that went through the gateway and is already in `usage_events`: the vendor
bills the API key the gateway itself uses. Adding it to imported spend would count it twice in any view that shows
both sides.

- A pulled line whose vendor key, workspace or project matches a credential the gateway holds (`model_credentials`,
  `user_model_credentials`) is marked `overlaps_metered` when it is written. It is kept, it is excluded from the
  imported side, and the exclusion is disclosed with its count and amount, on ADR-0076's "a number that quietly got
  smaller" rule.
- A reconciliation report compares the vendor's figure for those gateway keys with the metered figure for the same
  window and shows the variance. It never sums them. A variance above a threshold is a warning for the admin, not a
  correction to either side.
- Where a vendor reports no key-level breakdown, its lines cannot be matched to gateway keys, and the posture read
  says that double counting against metered spend cannot be excluded for that vendor.

### 6. Vendors and endpoints

Verified against each vendor's own documentation on 2026-11-15. Each connector re-checks its endpoint shape against a
recorded fixture in CI; a live tenant run is owner-gated.

<!-- VENDOR_TABLE -->

### 7. Threat model

| threat | control |
|---|---|
| A stored vendor key is stolen from the database | data-key envelope (ADR-0063); key held outside the database; read-only scope limits what a thief gains |
| A key is exfiltrated through logs, errors or audit | never logged; `scrub-secrets` on every error path; audit records the credential id and fingerprint only |
| A key with write or admin scope is registered | read-only scope required; verified where the vendor allows; otherwise marked `unverified` on the posture read |
| An insider registers a key or turns the feature on to exfiltrate | admin-only, MFA step-up, required reason, audited; feature off by default |
| SSRF through a vendor base URL | documented vendor host only; guarded, pinned fetch; base-URL override refused outside test builds |
| A hostile or compromised vendor response | size bounds, schema validation, bounded pagination, free text truncated and scanned on the ADR-0042 posture |
| Pulled data reaches a user who may not see it | admin-only reads, as ADR-0069; the self-view stays the only non-admin read; new tables under ADR-0234 row-level security; no cache crosses users |
| Double counting makes a chargeback wrong | `basis = 'imported'`; `overlaps_metered` exclusion disclosed; ADR-0076 reconciliation; no summed field |
| A retried or overlapping pull doubles a figure | idempotent upsert on the vendor fact identity; run ledger |
| Vendor rate limits or bans the tenant | per-tenant rate limit below the vendor's; backoff on 429; resume from cursor |
| An air-gapped install leaks | the setting cannot be turned on under `air_gapped`; refused in code (ADR-0062) |
| PII beyond the identity key | only identity join keys and money are kept; other vendor fields are discarded at parse (ADR-0076 posture) |

### 8. Slices

1. This ADR (documentation only).
2. Foundation: the setting, the credential and run tables (migration `pending/vendor_usage_pull.sql`), the admin
   routes with step-up and audit, the posture read, the scheduler job and the pull engine, with the Anthropic and
   OpenAI connectors against fake servers.
3. GitHub Copilot (usage metrics and cost centres) and Cursor connectors.
4. OpenAI Codex analytics and AWS CUR 2.0 (`line_item_iam_principal`), plus the metered-overlap reconciliation report.

The routes are API only; screens are tracked on #453.

## Alternatives rejected

- **Keep file import only.** Rejected by the owner decision above.
- **On by default for hosted tenants.** Rejected by ADR-0180: an outbound credential is a new class of secret, and the
  strict default is off.
- **A separate `pulled` ledger or a new basis value.** Rejected. A pulled figure is a restated vendor document like an
  uploaded one, and a second basis would invite the metered-plus-imported sum this design exists to prevent.
- **Accept any vendor key and rely on the admin to pick a read-only one.** Rejected where the vendor lets us check;
  disclosed as `unverified` where it does not.

## Consequences

- RegulAIt can now hold vendor usage/cost credentials. They are read-only, but they are a new class of secret and
  are covered by the same custody, rotation and revocation rules as ADR-0195's scanner credentials.
- Imported figures can be as fresh as the pull cadence rather than the last upload.
- Each vendor API change can break a connector. A connector that meets an unexpected shape fails its run with a
  stated reason and writes nothing; it never maps a field it does not recognise.
- ADR-0069's "there is no vendor billing-API client in this repository" and ADR-0076's "Still no polling" are no
  longer true for tenants that opt in. Both ADRs' status lines point here.
