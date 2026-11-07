# ADR-0255: A governed connector catalogue from Activepieces community pieces (clean-room adapter)

- **Status**: Accepted (builder, 2026-11-07; owner-approved backlog item P31)
- **Date**: 2026-11-07

## Context

The owner approved backlog item P31 on 2026-11-07: build a governed connector catalogue from Activepieces' community
"pieces". Activepieces publishes about 790 pieces to npm as `@activepieces/piece-<name>`, each from
`packages/pieces/community/<name>` of its repository.

**Licensing.** The repository's root `LICENSE` is MIT ("MIT Expat"), except two directories under a proprietary
Enterprise licence: `packages/ee/` and `packages/server/api/src/app/ee`. We checked the root file on 2026-11-07. The npm
`license` field is missing on every curated piece we checked (`piece-slack` 0.23.1, `piece-jira-cloud` 0.6.4,
`piece-github` 0.11.1, `piece-google-sheets` 0.19.5, `piece-gmail` 0.18.6, `piece-smtp` 0.5.1). So the MIT terms
follow from the root file and the community path, not from package metadata.

Hard requirements from the brief:

1. Every piece's outbound HTTP goes through our guarded fetch (SSRF, ADR-0034; mode-scoped egress, ADR-0062).
   Air-gapped deployments refuse it.
2. Default-deny per-user entitlement, cost attribution and audit on every action, at the same interception point as
   connectors today.
3. Credentials live in our secret store, never in the piece's own storage.
4. No piece runs arbitrary user code.
5. Start with a small curated set. The catalogue lists the rest as "available, not enabled", and enabling one is an
   audited admin action.
6. No EE code: a lint or CI check fails on any import or vendored file from an `ee` path.

We had two options:

- **(a)** adopt `@activepieces/pieces-framework` and selected pieces, and run them behind the gateway;
- **(b)** write a clean-room adapter that reads the pieces' action and property schemas and runs them in our own
  connector runtime.

We inspected the published packages before choosing.

- `@activepieces/pieces-common` 0.12.5 makes HTTP calls through `axios` 1.15.2, with `axios-retry`, `http-proxy-agent`
  and `https-proxy-agent`. Pieces also call vendor SDKs directly. Neither takes an injected fetch, so their requests
  cannot be routed through the egress-guarded fetch.
- `@activepieces/pieces-framework` 0.32.0 depends on `ai` 6.0.0 and `@activepieces/shared`. A piece gets its
  credential as `context.auth` and keeps state in the engine's `context.store`.
- Each piece ships one minified bundle with the framework inlined, so running "only the action" means running the
  bundle.

## Decision

**We chose option (b): a clean-room adapter. No Activepieces code is a dependency or runs anywhere in RegulAIt.**

1. **Vocabulary, not code.** Each curated piece is re-implemented in
   `packages/connector-provider/src/pieces.ts` (`CURATED_PIECES`) against the vendor's public REST API. From the
   upstream piece we take its key, its action names and display names, and their read/write classification, so the
   catalogue matches the Activepieces names an admin already knows. We read these from the pinned npm tarball of each
   piece without running it. Each entry records `upstream: {npm, version, path}`, and `path` is always
   `packages/pieces/community/<key>`.
2. **The curated set.** Five pieces are curated:
   - Slack: `send_channel_message`, `send_direct_message`, `find_user_by_email`.
   - Jira Cloud: `get_issue`, `get_issue_transitions`, `add_comment`, `transition_issue`.
   - GitHub: `get_repository`, `get_pull_request`, `github_create_issue`, `create_issue_comment_ai`.
   - Google Sheets: `sheets_get_spreadsheet`, `sheets_get_values`, `sheets_append_values`.
   - Gmail (the email piece): `gmail_get_profile`, `gmail_get_message`, `gmail_send_email`.

   We chose Gmail, not SMTP, because SMTP is not HTTP and cannot go through the guarded fetch.
3. **One connector kind per piece.** The provider kinds are `piece_slack`, `piece_jira_cloud`, `piece_github`,
   `piece_google_sheets` and `piece_gmail`. A piece connector is an ordinary `connectors` row, so it takes the same
   interception point as every connector: `executeGovernedConnectorCall`. That gives it, unchanged:
   - the entitlement kernel, with its default deny;
   - per-user grants, where the grant's `allowedObjects` lists the **actions** a person may run;
   - the kill switch, the decision audit row, the pillar-5 project budget and the price-per-call usage row;
   - the approvals hold for writes;
   - §8.4 PII handling, guardrails and the egress guard.

   `object` is the action name and `payload` is its props.
4. **Guarded fetch, always.**
   - All five kinds join `CREDENTIAL_HOST_CONNECTOR_KINDS`, so they always take the ADR-0167 guarded-fetch branch, even
     on a compiled vendor host. The compiled-default branch would hand a permissive posture the global fetch.
   - `connectorCredentialHosts` names each piece's hosts. The vendor's compiled hosts follow the posture: `slack.com`,
     `api.github.com`, `sheets.googleapis.com` or `gmail.googleapis.com`, plus `oauth2.googleapis.com` for Google.
     Jira's site is a **typed** host, because it comes from the credential, so the allow-list decides it under every
     posture.
   - The adapter refuses to build without an injected fetch. Every request, including the Google token exchange, goes
     through it.
5. **No arbitrary code or request.**
   - Each action is a fixed, declarative request builder.
   - The props schema is strict: unknown keys are refused, every string is bounded, and path values are single
     encoded segments.
   - The operation must equal the action's classification.
   - We do not carry the upstream "custom API call" actions. The `http`, `http-oauth2`, `graphql`, `anyhook-graphql`
     and `webhook` pieces are excluded as `arbitrary_request`.
   - The non-HTTP pieces are excluded as `non_http_transport`: `smtp`, `imap`, `sftp`, `mysql`, `postgres`, `mongodb`,
     `microsoft-sql-server`, `apache-kafka` and `rabbitmq`.
   - The Activepieces platform pieces are excluded as `platform_internal`: `activepieces`, `subflows`, `store`,
     `tables`, `connections`, `approval`, `delay`, `schedule`, `manual-task`, `manual-trigger`, `forms` and `ai`.
6. **Credentials** are set through the existing `POST /v1/connectors/:id/credential`. They are stored in
   `connector_credentials` (AES-256-GCM under `REGULAIT_DATA_KEY`) and decrypted per call. The adapter keeps nothing.
   - Slack and GitHub take a token.
   - Jira Cloud takes `{siteUrl, email, apiToken}`. `siteUrl` must be `https://<site>.atlassian.net`: one label, and
     nothing after the host.
   - Sheets and Gmail take `{clientId, clientSecret, refreshToken}`, exchanged for an access token on each call.

   The credential's shape is checked when it is written. Upstream error text is scrubbed of every secret form before
   it is surfaced.
7. **Enablement is secure by default (ADR-0180).**
   - Migration 0310 adds `connector_piece_enablements`. A row means the piece is enabled, and a fresh install has no
     rows. A CHECK repeats the five curated keys, so a row cannot name a piece without an adapter.
   - `POST /v1/connector-catalogue/:pieceKey/enablement` with `{enabled, reason}` is admin-only through the default
     gate. Enabling is a `settings_relax` step-up.
   - Both enabling and disabling write an audit row in the same transaction, with `objectType` `connector_piece`,
     ruleId `connector-catalogue-enablement-changed`, the transition and the reason.
   - A listed piece with no adapter answers `409 piece_has_no_adapter`.
8. **The gate.** `refusePieceConnector` is the one shared predicate (M-075). It refuses a piece connector when:
   - its piece is not enabled (`403 piece_not_enabled`);
   - the deployment is air-gapped (`REGULAIT_DEPLOY_MODE=air_gapped`, `403 piece_air_gapped`), whatever the
     allow-list says;
   - it carries a `baseUrl` (`409 piece_base_url_refused`).

   It runs when a connector is created, and on every invoke after the entitlement decision, where it writes a deny row
   (ruleId `connector-piece-gate`). It can only refuse; it never stands in for a grant. Enabling is also refused
   air-gapped.
9. **The catalogue read.** `GET /v1/connector-catalogue` (admin) returns:
   - the deployment mode, and whether anything can run here;
   - the curated pieces, with their status, actions and upstream;
   - the rest of the community catalogue as `available_not_enabled`, paginated (`limit` up to 200, `offset`) with a
     plain-substring `q` filter.

   That list, `AVAILABLE_PIECES` (755 entries on 2026-11-07), is names and versions only. It is generated at dev time by
   `scripts/connector-catalogue-refresh.mjs` from the npm registry search API. The product never fetches it, so it
   works air-gapped.
10. **No EE code, enforced.** `scripts/activepieces-ee-guard.mjs` fails on:
    - a tracked file under an Activepieces `ee` path;
    - an import, export-from, dynamic import or require of an `@activepieces/*` package other than `piece-*`,
      `pieces-framework`, `pieces-common` or `shared`, or of any Activepieces `ee` path;
    - a lockfile entry for such a package;
    - a curated `upstream.path` outside `packages/pieces/community/`.

    It runs in CI through its test (`vitest run --dir scripts`).

## Consequences

- Adding a piece means writing its adapter entry, adding its kind to the four kind lists (connector-provider, shared,
  `CREDENTIAL_HOST_CONNECTOR_KINDS`, the CHECK), and a migration that widens the CHECK. This is deliberate: a new
  outbound vendor is a reviewed change, not a toggle.
- We re-implement each action, so a piece's upstream fixes do not reach us automatically. The upstream version on each
  entry tells a reviewer what the vocabulary was read from. Triggers (webhook and polling) are out of scope.
- Google credentials are exchanged on every call, which is one extra request through the guarded fetch. Caching the
  access token is a follow-up, and the cache must never cross connectors.
- **UI.** The brief is API and backend only, and the catalogue screen goes to the Governed Designer, requested on #453.
  The route census forbids a new UI gap (`KNOWN_UI_GAPS_MAX` = 0). We list the two routes there and raise the ratchet to
  2, visibly in the census and its test, with this ADR as the reason. The Designer's screen deletes both entries and
  returns the ratchet to 0. This departs from the census rule ("build the screen instead"), so it is flagged for the
  master in the PR.
- Open source first (ADR-0176): `@activepieces/pieces-framework` and the pieces were checked and are not used, for the
  unmet requirements above: no injected fetch, credentials in the piece's own context, and an engine runtime. Re-check
  if the framework gains an injectable HTTP client and an externally supplied credential. Recorded in
  `packages/connector-provider/THIRD_PARTY.md`.
- Migration 0310 (`when` 1785237000000) is renumbered above main's highest migration at merge, as
  CONTRIBUTING_PARALLEL_SESSIONS §4.1 requires.
