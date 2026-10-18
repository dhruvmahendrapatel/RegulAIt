# Repo discovery: git-provider credentials (GitHub, GitLab, Bitbucket, Azure DevOps)

ADR-0195 lane A5. The repo scanners (`repo_github`, `repo_gitlab`, `repo_bitbucket`, `repo_azure_devops`) read your
repositories read-only. This page says how each provider is reached and what you configure on the provider side.

> **Status: pending execution (M-041).** The federated paths are tested against fake provider APIs and the real
> Entra credential library, not against a live GitHub App installation or a live Azure DevOps organisation. Every
> provider-side step below is **pending execution** until it is run against a real account and this note is updated.
> The static-token path is the one SD1 already shipped; it is unchanged.

## Which credential each provider takes

Federated is the default wherever the provider supports it (secure by default, ADR-0180). Omitting `mode` when you
store a credential picks it. A stored token (static mode) is a relaxation: storing one is a `settings_relax` step-up,
it is encrypted at rest, never returned, and its age is warned about after 90 days.

| Provider | Default | How the scanner gets a token | Stored per-source secret |
|---|---|---|---|
| Azure DevOps | federated | Entra workload identity federation: a RegulAIt federation token (5 min) is exchanged at Entra for an Azure DevOps access token | none |
| GitHub | federated | The deployment's GitHub App signs a JWT (≤ 10 min), exchanged for a 1-hour installation token requested with `contents: read` and `metadata: read` only | none (the App key is a deploy-time file) |
| GitLab | static | No inbound federation exists; a group or project access token with `read_api` and `read_repository` | the token |
| Bitbucket Cloud | static | No inbound federation exists; a repository, project or workspace access token with read scopes | the token |

Checked against the providers' documentation on 2026-10-18 (citations in ADR-0195, "As built: A5"). GitHub, GitLab
and Bitbucket accept no third-party OIDC token for their APIs; Azure DevOps accepts Entra tokens, and Entra accepts
RegulAIt's federation tokens through a federated identity credential. A federated credential for GitLab or Bitbucket
is refused when you save it.

Short-lived tokens are exchanged again before they expire, so a run that lasts longer than a token still finishes.
Every exchange goes through the egress guard; every token, JWT and assertion is scrubbed from anything stored.

## Azure DevOps (federated, keyless) — pending execution

Prerequisites on the RegulAIt side: `REGULAIT_PUBLIC_URL` is a publicly reachable https origin, a data key is
configured, and federation is turned on (Discovery sources → Cloud federation: generate a key, then activate it).

1. In Entra, create an app registration (or reuse one) for RegulAIt's repo scanner. Note its tenant id and client
   (application) id.
2. Add a **federated credential** to it ("Other issuer"):
   - Issuer: `<REGULAIT_PUBLIC_URL>/federation` exactly (not the root URL).
   - Subject: `regulait:discovery-source:<source id>` (shown on the source).
   - Audience: `api://AzureADTokenExchange`.
   Entra can take a few minutes to accept a new federated credential; create it before the first run.
3. In Azure DevOps, Organization settings → Users: add the app's service principal to the organisation and give it
   read access to Repos only (the **Readers** group of the projects to scan). An Entra token carries no Azure DevOps
   scopes, so RegulAIt cannot check this: the source's posture shows "write scope unverified".
4. In RegulAIt, on the source: target `baseUrl` = your organisation URL (`https://dev.azure.com/<organization>`).
   Credential: federated, public config `tenantId` and `clientId`.
5. Allow-list `login.microsoftonline.com` and `dev.azure.com` (each addition is a step-up).

## GitHub (federated through the deployment's GitHub App) — pending execution

GitHub accepts no external OIDC token, so RegulAIt authenticates as a GitHub App. The App's private key is a
deploy-time file the operator provides, like the identity issuer key: it is never stored in the database and never
returned by a route. Each run signs a short JWT with it and exchanges it for an installation token scoped to the
repositories the App is installed on, requested read-only. If GitHub grants anything beyond read, the credential is
refused as write scope.

Operator (once per deployment):

1. Create a GitHub App (on github.com, or on your GitHub Enterprise Server) with **Repository permissions →
   Contents: Read-only** and **Metadata: Read-only**, and nothing else. No webhook is needed.
2. Generate a private key for it and put the PEM file where the gateway can read it (mode 0600).
3. Set `REGULAIT_GITHUB_APP_ID` (the numeric App id) and `REGULAIT_GITHUB_APP_PRIVATE_KEY_FILE` (the path) for the
   gateway. Setting one without the other, or a file that is not an RSA key of 2048 bits or more, refuses every
   federated GitHub run.

Customer admin (per organisation):

4. Install the App on the organisation, on all repositories or selected ones. Note the installation id (in the
   installation's settings URL).
5. In RegulAIt, on the source: credential federated, public config `appId` (must be the deployment's App id) and
   `installationId`. For GitHub Enterprise Server, set the target `baseUrl` to the API base (`https://<host>/api/v3`).
6. Allow-list `api.github.com` (or your server's host).

Fallback: a fine-grained personal access token with read-only Contents and Metadata, in static mode (a relaxation).

## GitLab (static token) — the demo path

GitLab has no inbound workload identity federation (2026-10-18). Use a **group access token** (or a project access
token) with the `read_api` and `read_repository` scopes only, stored in static mode. RegulAIt asks GitLab for the
token's scopes and refuses a token that can write. On gitlab.com, group access tokens need a Premium or Ultimate
group. This is the path the 2026-11-01 demo uses (ADR-0197 decision 5); A5 does not change it.

Allow-list `gitlab.com` (or your self-managed host; set the target `baseUrl` to its `/api/v4` base).

## Bitbucket Cloud (static token)

Bitbucket has no inbound federation (2026-10-18). Use a repository, project or workspace **access token** with read
scopes (`repository`), stored in static mode; it is sent as a Bearer token. App passwords are being retired by
Atlassian; do not use one. Allow-list `api.bitbucket.org`.

## Revocation

Revoking a source's credential (free) stops new runs at once. A token already exchanged lives to its expiry
(federation token 5 minutes, Entra and GitHub installation tokens about an hour). Revoke the federated credential in
Entra, or uninstall the GitHub App, to stop the provider side.
