# ADR-0322: Opt-in, per-tenant read-only pull of vendor usage and cost data

- **Status**: Accepted
- **Date**: 2026-11-15
- **Amends**: [ADR-0069](0069-cross-vendor-cost-consolidation.md) (its no-credential, no-outbound scope and "Why not a
  scheduled re-import"), [ADR-0076](0076-cost-reconciliation-roster-ingest.md) (its "Still no polling" line)
- **Driver**: `internal/product/MARKET_ANALYSIS_2026-11.md` §3a gap G1 (PR #844)
- **Builds on**: [ADR-0034](0034-custom-llm-providers-egress-guard.md) and its pinned-egress amendment (the guarded
  fetch), [ADR-0062](0062-mode-scoped-egress.md) (mode-scoped egress), [ADR-0063](0063-data-key-custody.md) (the data
  key), [ADR-0064](0064-in-process-scheduler.md) (the job contract), [ADR-0195](0195-shadow-ai-active-discovery.md)
  (the read-only credential precedent), [ADR-0180](0180-continuous-assurance-strict-by-default.md) (secure by default)

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
recorded fixture in CI; a live tenant run is owner-gated. Google (Vertex/Gemini) is not in this table yet: it is the
optional last slice.

| vendor | endpoints (all GET unless stated) | credential and scope | identity for mapping | notes |
|---|---|---|---|---|
| Anthropic | `/v1/organizations/analytics/usage` and `/analytics/cost` (beta header `analytics-usage-cost-2026-08-24`); legacy `/v1/organizations/usage_report/messages`, `/cost_report`; `/v1/organizations/usage_report/claude_code` | Admin key (`x-api-key`) or an OAuth token with `org:admin`; **no read-only scope is documented** | `actor` (user id, service account id), `api_key_id`, `workspace_id`; Claude Code: `actor.email_address`, `api_key_name` | `page`/`next_page`/`has_more`; about one poll a minute; ranges of at most 31 days |
| OpenAI | `/v1/organization/usage/{completions, embeddings, images, audio_*, moderations, vector_stores, code_interpreter_sessions}`, `/v1/organization/costs` | Admin key (Bearer); read-only restriction **not documented** in the official guide | `project_id`, `user_id`, `api_key_id`, `model` | `page`/`next_page`/`has_more`; costs in 1-day buckets only |
| OpenAI Codex | the ChatGPT Enterprise Daily Usage Analytics API (ChatGPT, Codex and Work usage) | workspace-scoped Admin key with `enterprise.analytics.usage.read` | per workspace; per-user fields **unverified** | exact paths are checked against the vendor's API reference in slice 4; the older `/v1/analytics/codex` route is reported as retiring on 2026-12-15 and is not used |
| GitHub Copilot | `/orgs/{org}/copilot/metrics/reports/*` and `/enterprises/{e}/copilot/metrics/reports/*` (signed download links), `/orgs/{org}/copilot/billing/seats`, `/enterprises/{e}/settings/billing/cost-centers`, `/enterprises/{e}/settings/billing/{usage, usage/summary, premium_request/usage, ai_credit/usage}` (and the org equivalents) | fine-grained token or GitHub App with "View Copilot Metrics" and enterprise billing read; the token's permissions are checked before the first pull | login and user id (email nullable), cost centre, organization, repository | `X-GitHub-Api-Version: 2026-03-10`; the legacy `/copilot/metrics` routes closed on 2026-04-02 and are not used; download links are fetched through the guarded fetch too |
| Cursor | `/teams/members`, POST `/teams/daily-usage-data`, POST `/teams/spend`, POST `/teams/filtered-usage-events`, `/v2/teams/billing-items` | Basic auth with an Admin API key; `read:*` keys get 401 on writes, so a `read:*` key is required | `user_...` id, email, service account id | 20 to 60 requests a minute by endpoint; 429 with `Retry-After` |
| AWS CUR 2.0 | S3 `ListObjectsV2` and `GetObject` on the Data Exports prefix, reading the manifest first (Parquet or CSV.gz chunks) | ADR-0195 federated `AssumeRole`; policy limited to `s3:ListBucket`, `s3:GetObject` and `kms:Decrypt` on that prefix (minimal policy inferred, not documented by AWS) | `line_item_iam_principal` (opt-in "caller identity" data, for Bedrock), `iamPrincipal/*` tags, account id | refreshed at least daily; the previous month can be restated for two weeks, so the pull re-reads it and ADR-0076 reconciliation handles the restatement |

Sources: platform.claude.com (usage-cost-api, usage-cost-analytics-api, claude-code-analytics-api);
developers.openai.com (admin usage reference, admin-apis guide); learn.chatgpt.com (enterprise analytics-api);
docs.github.com (copilot-usage-metrics, copilot-user-management, billing cost-centers and usage);
cursor.com/docs (teams admin-api); docs.aws.amazon.com (iam-principal-cost-allocation, dataexports-export-delivery).

**Where the vendor offers no read-only scope (Anthropic, and OpenAI until verified).** The credential the vendor
issues can also change the organisation (manage keys, users, workspaces). Following ADR-0180, such a connector cannot
be enabled by default. Storing such a key is an extra, separately audited step-up acknowledgement ("this key can
write; RegulAIt will only call the listed read endpoints"), the posture read shows `write_capable`, and the connector
only ever calls the read endpoints in this table.

> Owner answer (2026-11-15, relayed by the master on #845): allow Anthropic/OpenAI Admin keys with the audited step-up
> acknowledgement and the write_capable posture flag, calling only read endpoints (as built).

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

Ordered for a pilot with a large tech/SaaS org in about two weeks (owner direction, 2026-11-15, relayed by the master).
Its coding tools are Copilot, Cursor, Claude Code and Codex; its model providers are Anthropic, OpenAI, AWS Bedrock and
Google Gemini/Vertex.

1. This ADR (documentation only).
2. Foundation, plus the Anthropic (API and Claude Code) and OpenAI connectors: the setting, the credential and run
   tables (migration `pending/vendor_usage_pull.sql`), the admin routes with step-up and audit, the posture read, the
   scheduler job, the pull engine and the metered-overlap exclusion.
3. GitHub Copilot (usage metrics and cost centres) and Cursor connectors.
4. AWS (Bedrock spend through CUR 2.0, `line_item_iam_principal`), then OpenAI Codex analytics.
5. If time allows: Google (the Cloud Billing export to BigQuery for Vertex/Gemini spend), verified against Google's
   documentation before it is built.

Every slice is tested against fake servers. Live tests use the owner's low-limit test keys through lane E11 once
those exist.

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

## Owner decisions for slice 4a, AWS Bedrock spend (2026-11-20, answered in lane E7)

Asked by the lane E7 builder before building the `aws_cur` connector; the owner answered each question directly.

1. **Credentials**: the federated role (the customer's role trusts RegulAIt's federation issuer,
   `AssumeRoleWithWebIdentity`, audience `sts.amazonaws.com`) and a static access-key pair, the latter as an audited
   relaxation with its own acknowledgement. The "RegulAIt principal plus external id" mode is left to a later PR.
2. **Restatement**: a pull **replaces the connector's lines for each billing month it re-reads**. A line that is no
   longer in AWS's restated file is withdrawn, not kept stale.
3. **Money**: `line_item_unblended_cost`, matching the ADR-0069 CUR file import. Every line item type is kept (usage,
   credits, refunds, tax), with the type recorded on the line.
4. **Identity**: an IAM principal maps to a person only through an admin alias. An email-shaped role session name is
   never resolved automatically, because the caller chooses it.

Defaults the builder chose, recorded for review: the connector expects a dedicated Bedrock-only CUR 2.0 export (a
whole-estate export at a large organisation exceeds the per-run bounds), and failures reuse the existing run error
codes (`no_credential` when federation is off, `bad_response` for a Parquet export), so no migration is needed.

## As built — slice 2 (2026-11-15): foundation, Anthropic and OpenAI

Migration `pending/vendor_usage_pull.sql` (numbered at merge); code in `apps/gateway/src/vendor-usage-pull.ts` and
`packages/shared/src/vendor-usage.ts`; proof in `zz-adr0322-vendor-usage-pull.test.ts` (fake vendors only).

- **The policy is its own singleton table** (`vendor_usage_pull_policy`) rather than an `org_settings` column, so it
  can only be changed through its own route with a required reason, and the generic settings route cannot turn it on.
- **Credentials** follow ADR-0195's `discovery_credentials` shape: compare-and-set rotation (`replacesCredentialId`),
  revoke nulls the ciphertext and disables the connector. Both vendors' Admin keys are `write_capable`; storing one
  without `acknowledgeWriteCapable: true` is a 409.
- **Step-up** reuses the `settings_relax` kind with distinct facts (policy on, connector enabled, credential stored),
  as discovery does; no new step-up kind.
- **Anthropic**: `GET /v1/organizations/cost_report` grouped by `workspace_id` and `description`, called with the
  guarded fetch (`anthropic-version: 2023-06-01`). Amounts are decimal strings in cents and are converted by moving
  the decimal point, not by float division. The report has no person or key dimension, so a line resolves to a
  person only through an admin alias for its workspace, and the metered overlap matches on workspace ids.
- **OpenAI**: `GET /v1/organization/costs` grouped by `project_id`, `line_item` and `api_key_id`, through the
  official SDK (`client.admin.organization.usage.costs`). The overlap matches on API key ids and project ids.
- **Window**: the first pull reads `backfillDays` (default 7, at most 31); later pulls resume at the last pulled day
  minus two days, which both vendors restate, and never ask for more than 31 days.
- **Upsert key**: sha-256 of the vendor's own fact identity, unique per connector, so a re-pull updates amounts in
  place. The fact identity of the Anthropic report includes every grouping field the vendor returns.
- **Run errors** are one of a fixed set of codes (CHECK) plus a sentence RegulAIt wrote; no vendor body is stored.
- **Consolidated read**: `overlaps_metered` lines are excluded from the imported side and disclosed as
  `meteredOverlap` (count and amount by currency). Changing a connector's gateway-id lists re-marks its stored lines.
- **Review round (#861)**:
  - **Row-level security** (§7, ADR-0234): the four new tables are ENABLED and FORCED. Only an active admin
    principal, the scheduled sweep (`system_task`) and `migration` reach them. A plain app connection and every
    request-only reason see and write nothing, which the suite proves for `public_ingest`, `credential_request` and a
    non-admin principal. `imported_cost_lines` and `cost_import_batches` are not under RLS yet; they belong to the
    ADR-0069 import surface and are a tracked follow-up (fragment), not part of this table set.
  - **Audit with the change**: every state change and its audit row share one transaction (policy, connector create,
    config with its re-marking, enable, credential store/replace and revoke). A pull's outcome and audit row commit
    with its batch, so a pull is never recorded as succeeded without its lines, or the reverse.
  - **Batches keep their lines**: a re-pulled line keeps the batch that first brought it in. Each pull batch records
    `newLines` and `restatedLines`. Revoking a pull batch withdraws only the lines it introduced, and rewinds the
    connector's `pulled_through` to the batch's first day, so the next pull fetches those days again.
  - **One pull per connector at a time**: opening a run takes a per-connector advisory lock. A run still `running`
    inside a 30-minute lease refuses a second one (`in_progress`) without calling the vendor. A row stuck past the lease
    is treated as a crashed process and stops blocking.
  - **Failure handling**: an error in the batch write rolls the batch back and closes the run as `internal` with
    RegulAIt's own sentence. A connector that throws does not stop the sweep for the others. A fact key the vendor
    returns twice in one pull is one fact.
  - **Bounds**: a vendor that repeats a page cursor is refused (`bad_response`) instead of looping to the 40-page cap.
    Re-marking reads in keyset pages of 1000 and updates per page. The runs list is keyset-paginated (`before`, 50 per
    page).
- **Review round 2 (#861)**:
  - **Run lifecycle on the ADR-0348 machine**: `vendor_usage_pull_runs.status` is `VENDOR_USAGE_PULL_RUN_MACHINE` in
    `@regulait/shared` (registered in `STATE_MACHINES`, listed in `internal/product/STATE_MACHINES.md`). A run opens
    `running`, or is written already `refused` when another pull holds the lease; the finish step moves it with the
    events succeed, fail and refuse through `whereFrom`. The outcome CHECK is written as two comparisons so the one
    value-list CHECK on the column is the machine's, which the ADR-0348 test holds equal.
  - **Revoke is atomic and serialised with pulls**: revoking an import batch runs in one transaction (reinstate,
    withdraw, batch status, connector rewind, audit). A pulled batch takes its connector's pull lock and is refused
    (409 `pull_in_progress`) while a pull holds the lease, so a running pull cannot overwrite the rewound day.
- **Differences from §3 and §5**:
  - **No per-vendor rate limit yet**: each scheduled pass makes at most one run per connector, of at most 40 requests.
  - **A 429 fails the run** as `rate_limited` instead of backing off inside it. The next pass resumes from
    `pulled_through` (minus the two restated days), which is the stored cursor. Nothing is lost, only delayed.
  - **Not built**: the in-run backoff, and the §5 variance report (vendor-reported spend against metered spend for the
    same keys and window). Both are tracked in the pending fragment.
- **API-only routes (lane brief)**: the nine routes are in the route census as `KNOWN_UI_GAPS` entries pointing at
  #453. That is the lane brief's own instruction for new routes ("new routes go in the route census plus a
  KNOWN_UI_GAPS entry pointing at #453 (no screens)"), and the cap moves by nine.
- **Not built in this slice**: Claude Code per-user cost (the Claude Code report's API-billed cost is already inside
  the cost report, so pulling it as spend would double count; it needs an attribution-only design); Anthropic's newer
  Analytics API (`/v1/organizations/analytics/cost`, beta); the settings screen (#453); live-tenant tests (lane E11).

## As built — slice 3 (2026-11-19): GitHub Copilot and Cursor

Code in `packages/shared/src/vendor-usage.ts` (catalogue, config and response schemas, normalisers) and
`apps/gateway/src/vendor-usage-pull.ts` (the two fetchers); proof in `zz-adr0322-vendor-usage-pull.test.ts` and
`vendor-usage.test.ts` (fake vendors only). No new route, no migration: `vendor_usage_connectors_vendor_check` already
allowed `github_copilot` and `cursor`, and the nine slice 2 routes take the new vendors through the same schemas.

Endpoint shapes re-checked against docs.github.com (billing usage, Copilot user management) and cursor.com/docs (teams
Admin API) on 2026-11-19.

- **GitHub Copilot**: `GET /organizations/{org}/settings/billing/usage` or `/enterprises/{enterprise}/...` with `year`,
  `month` and `day`, one request per day of the window (the report has no pagination and no range parameter), header
  `X-GitHub-Api-Version: 2026-03-10`. Only items whose `product` names Copilot are kept; `netAmount` is the amount.
  The configuration names the account kind and the organisation or enterprise slug, validated as a GitHub login so the
  path segment cannot be steered.
  - **Identity**: the report has no person dimension, so a line is billed to its organisation (the repository is in
    the line's detail and in the fact identity) and resolves to a person only through an admin alias.
  - **Currency**: GitHub does not state it; the lines are recorded as USD, the currency GitHub bills in, and the
    catalogue says so.
  - **Scope posture `unverified`**: GitHub documents read permissions for both reports, but a fine-grained token can
    also carry write permissions and GitHub does not report them back, so RegulAIt cannot verify the scope.
  - **Not built**: per-user premium-request usage (`/premium_request/usage?user=`, one request per user), cost-centre
    names (only on the enterprise premium-request and AI-credit responses), and the Copilot seats list.
- **Cursor**: `POST https://api.cursor.com/teams/filtered-usage-events` with `startDate` and `endDate` (epoch ms, both
  inclusive), 1000 events a page, Basic auth with the key as the user name. Events are summed per UTC day, user email
  (or service account), model, kind and product from each event's `chargedCents`, which Cursor names as the figure
  that reconciles with team spend. Cents are summed as integer micro-cents. A user resolves to a person by email.
  - **Difference from §6**: Cursor's docs now require an `admin:*` key for the Admin API, not a `read:*` key, so the
    credential is `write_capable` and needs the slice 2 acknowledgement, like the Anthropic and OpenAI Admin keys.
  - **Bounds**: a window of more than 40 pages (40,000 events) stops with `page_limit`; the admin lowers
    `backfillDays` (at most 30, Cursor's stated range for its other usage endpoints). A page number other than the one
    asked for is refused as `bad_response`.
- **Review round (#1069)**:
  - **An unverified scope needs an attestation** (S4 finding 1, ADR-0180): storing a credential whose posture is
    `unverified` is refused (409 `unverified_scope_acknowledgement_required`) unless the admin sends
    `acknowledgeUnverifiedScope: true`, attesting that the token carries read permissions only. The acknowledgement
    time is recorded on the credential (the existing `write_capable_acknowledged_at` column now holds the
    acknowledgement of any posture other than `read_only`; no migration). The attestation is in the audit row and on
    the posture read (`scopeAcknowledgedAt`, `scopeAttestation`).
  - **Same-key Copilot items are summed** (R4 finding 1): two items with the same day, product, SKU, organisation and
    repository (for example around a price change) are one fact whose net amount, quantity, gross and discount are
    summed in integer micro-units. Before this, the pull kept only the last one and dropped the rest of the spend.
  - **Disclosure** (S4 finding 2): the Cursor catalogue limits state that the user's email is stored as each line's
    account reference.
  - **Tracked, not changed**: a Cursor window can reach 32 days after a long gap (R4 finding 2, triage-low #1083).
- **No metered overlap**: the gateway meters neither Copilot nor Cursor, so neither connector declares gateway ids and
  the posture read says so instead of the "nothing declared" warning.
- **Open source first (ADR-0176)**: `@octokit/request` (MIT, maintained) was compared with the guarded fetch already
  used for Anthropic. It was not added: it is a new dependency whose fetch would have to be replaced by the guarded one
  anyway, for one unpaginated GET per day. Cursor publishes no SDK for its Admin API.

## As built — slice 4a (2026-11-20): AWS Bedrock spend from CUR 2.0

Built to the owner decisions above. Code: `packages/cloud-discovery/src/aws-cur.ts` (the S3 reader),
`packages/shared/src/vendor-usage.ts` (catalogue, config and secret schemas, `normalizeAwsCurCsv`,
`awsCurBillingPeriods`) and `apps/gateway/src/vendor-usage-pull.ts` (`fetchAwsCur`, month replacement). Proof:
`aws-cur.test.ts` (fake S3 and STS behind the injected fetch), `vendor-usage.test.ts` and
`zz-adr0322-vendor-usage-pull.test.ts`. No new route, no migration, no new dependency: `@aws-sdk/client-s3` is already
pinned in `@regulait/cloud-discovery` (its THIRD_PARTY row now names this use).

- **Credentials**:
  - **Federated** (the default to offer): the connector's config names the customer's role; the pull presents a
    RegulAIt federation token (`sub` = `regulait:vendor-usage-connector:<id>`, `aud` = `sts.amazonaws.com`) to
    `AssumeRoleWithWebIdentity`, through `awsCredentialProvider`. The customer's trust policy pins both. The stored
    credential is a marker (`{"mode":"federated"}`), so storing, attesting and revoking it is still the switch. While
    federation is off or its issuer is unset the run is refused as `no_credential` and AWS is not called.
  - **Static**: `{"mode":"static","accessKeyId","secretAccessKey"}`, stored only with `acknowledgeStaticAwsKey: true`,
    recorded in the step-up facts and the audit row (`staticAwsKeyAcknowledged`).
  - Both are `unverified` (RegulAIt cannot read the IAM policy without wider access) and need the
    `acknowledgeUnverifiedScope` attestation; the catalogue names the minimal policy (`s3:ListBucket`, `s3:GetObject`
    on the export prefix, `kms:Decrypt` for a KMS bucket). A secret that does not match the connector's mode is a 400.
- **Transport**: STS and S3 run on one guarded fetch (`guardedAwsRequestHandler`, pinned endpoints, virtual-hosted
  addressing, no accelerate or ARN-region endpoints), sized for CUR objects. The hosts the admin allow-lists are
  `<bucket>.s3.<region>.amazonaws.com` and, for federated mode, `sts.<region>.amazonaws.com`. The bucket name may not
  contain dots, so virtual-hosted TLS always works.
- **Read path**: per billing period, the manifest at `<prefix>/<exportName>/metadata/BILLING_PERIOD=YYYY-MM/`
  (`Manifest.json` or `<exportName>-Manifest.json`; the latest if AWS left several). Every data file it names must lie
  under the period's `data/` folder in the same bucket, checked before the first read. Only `.csv.gz` is read; a
  Parquet export fails as `bad_response` with "this export is Parquet; recreate it as gzip-compressed CSV". Bounds: 20
  data files a period, 32 MB an object (declared length and a running cap), 128 MB inflated (a gzip bomb is refused),
  one million rows a run (`page_limit`). A period with no manifest yet is skipped, not an error.
- **Normalisation**: only the named `line_item_*` columns are read; tags, resource ids and the free-text description
  are discarded at parse. Lines with a product code in `productCodes` (default `AmazonBedrock`; Marketplace model codes
  unverified) are summed per UTC day, account, IAM principal, product code, usage type, line item type and currency.
  The amount is `line_item_unblended_cost` in integer micro-units (a decimal string is never divided as a float); every
  line item type is kept and recorded. A line dated outside its billing period, a malformed account id or a principal
  that is not an ARN fails the run rather than being moved or guessed.
- **Identity**: `line_item_iam_principal` when the export carries it (`accountKind` `iam_principal`), else
  `aws account <id>`. Resolution is admin aliases only: the email and domain-rule paths are switched off for this
  vendor, because a role session name is caller-chosen.
- **Months, not days**: `awsCurBillingPeriods` replaces the daily window. The first pull reads the current month and
  `backfillMonths - 1` before it (at most 3); later pulls resume at the month of `pulled_through`. The previous month
  is re-read while the day of the month is at most 15 (AWS restates for about two weeks). At most four months a run.
- **Month replacement**: after the upsert, in the same transaction, the connector's stored lines for each delivered
  month whose fact key AWS no longer reports are withdrawn (deleted, as a batch revoke withdraws). The batch summary
  records `replacedPeriods` and `withdrawnLines`. Revoking that batch afterwards withdraws what it introduced and
  rewinds `pulled_through` as before; lines it withdrew come back on the next pull only if AWS still reports them.
- **No metered overlap**: the gateway has no Bedrock provider, so no line is excluded as already metered.
- **Not built**: the RegulAIt-principal mode with an external id; Parquet (hyparquet, MIT, to be compared under
  ADR-0176 first); live-tenant tests (lane E11); the settings screen (#453); OpenAI Codex analytics (slice 4b).
