# Live pilot-path tests (ADR-0326)

`apps/gateway/live/` holds tests that call real vendor APIs with **test** tenants and **low-limit test** keys. They
run only in `.github/workflows/live-tests.yml`, on manual dispatch and nightly at 04:17 UTC. They never run on pull
requests. Each group skips itself when its credentials are empty, so a run with nothing configured passes and calls
nothing.

## What the owner sets up, once

1. In the repository settings, go to **Environments** and create an environment named **`live-tests`**:
   - **Required reviewers:** yourself. A dispatched run waits for your approval before any secret is released.
   - **Deployment branches:** `main` only.
2. Add the following **environment secrets** and **environment variables**. Use test resources only. The repository
   is public, so never put a tenant name, org URL or ID in a file. The workflow masks the variables below in its
   logs.

| Group | Kind | Name | What it is |
|---|---|---|---|
| Anthropic | secret | `LIVE_ANTHROPIC_API_KEY` | an API key with a low monthly spend limit, in a workspace used only for tests |
| OpenAI | secret | `LIVE_OPENAI_API_KEY` | a project key with a low budget, used only for tests |
| Gemini | secret | `LIVE_GEMINI_API_KEY` | an AI Studio key in a test Google Cloud project |
| Azure DevOps | variable | `LIVE_ADO_ORG`, `LIVE_ADO_PROJECT`, `LIVE_ADO_REPO` | a test organization, project and repository (the repository needs a `main` branch) |
| Azure DevOps | secret | `LIVE_ADO_PAT` | a PAT scoped to that organization only: **Work Items (Read & Write)** and **Code (Read & Write)**, 30-day expiry |
| Entra ID | variable | `LIVE_ENTRA_TENANT_ID`, `LIVE_ENTRA_CLIENT_ID` | a test tenant and an app registration in it ([ENTRA_ID.md](ENTRA_ID.md) step 1) |
| Entra ID | secret | `LIVE_ENTRA_CLIENT_SECRET` | that app registration's client secret, with the shortest expiry you accept |

The Entra client secret and the ADO PAT cannot be supplied by a proxy that injects headers. The Entra secret is
sent in a token request body. The PAT is base64-encoded into the request by the adapter under test. Both therefore go
in the environment above and nowhere else.

**Bedrock and Vertex** have no native route in the product yet (PILOT_READINESS G2-1, G2-2). Their groups are
declared in `live-env.ts`, and the tests are `todo` until a route lands. When one does, Bedrock runs with GitHub OIDC
federation to a read-only `bedrock:InvokeModel` role in `regulait-dev`, never with access keys.

## What each group checks

- **Models (`models-cost-budget.live.test.ts`):** one short call per provider through the surface a coding tool uses.
  The test asserts:
  - a priced `usage_events` row for that user and that project
  - the developer's own summary shows the spend
  - a budget signal fires (the threshold alert, or the Approvals Queue escalation followed by a refused next call)
- **Azure DevOps (`ado-boards-repos.live.test.ts`):** a work item, a branch, one commit, a PR that links the work
  item, its statuses, and a comment back on the work item. Everything is removed afterwards: the PR is abandoned, the
  branch deleted and the work item deleted.
- **Entra (`entra-sso-scim.live.test.ts`):** discovery and JWKS, the app secret (client credentials), and the gateway
  accepting the provider. Entra's SCIM request shapes always run in process, with no tenant needed.

## Running locally

Run these from `apps/gateway`, with a local Postgres and the workspace built (`pnpm --filter "@regulait/gateway..."
build`):

```sh
DATABASE_URL=postgres://regulait:regulait@localhost:5432/regulait_test REGULAIT_DATABASE_SSL=disable \
REGULAIT_MIGRATIONS_UNASSIGNED=apply pnpm exec vitest run --config live/vitest.config.ts
```

Export only the groups you want to run. Values are never printed: assertion messages go through `redact()`.
