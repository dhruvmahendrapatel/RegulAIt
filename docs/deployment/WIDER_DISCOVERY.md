# Wider discovery sources: SaaS app inventories, identity-provider app consents, standalone ML platforms

These source kinds extend active discovery (see `CLOUD_DISCOVERY.md` and `GIT_DISCOVERY_CREDENTIALS.md`). Every one is
read-only, and two switches stand in front of it:

1. **The family switch** (Discovery sources → Settings → Wider discovery sources). Off by default. Turning it on asks
   the admin to confirm it is them; turning it off is free and stops every scan of that family at once.
2. **The source** itself, off until enabled, as for every discovery source.

Every call goes through the egress allow list: add the API hosts named below before the first run.

## SaaS app inventory (JSON API) — `saas_inventory_api`

For an inventory your SaaS-management, CASB or in-house tool exposes as JSON.

Target (one `key=value` per line):

| Key | Required | Meaning |
|---|---|---|
| `url` | yes | `https://` URL of the list. No credentials in it; query parameters such as `limit=500` are fine, a token is not. |
| `itemsPath` | no | dotted path to the list in the body (`data.apps`); empty when the body is the list |
| `nameField` | no | field holding the app's name (default `name`) |
| `domainField` | no | field holding the app's domain or URL (default `domain`) |
| `usersField` | no | field holding the number of users |
| `nextField` | no | dotted path to the next page's URL; followed only on the same origin as `url` |

Scope: organisation level for every app, or a list of app domains (or names) to keep.

Credential: static only. The secret is a read-only API token. It is sent as `Authorization: Bearer <token>`, or as is in
the header named by the public config field `authHeader` (for example `authHeader=X-Api-Key`). RegulAIt cannot check a
generic API's token scope, so issue a read-only token.

Egress: the `url` host.

## Microsoft Entra ID app consents — `idp_entra`

Reads the apps people or admins consented to (delegated permission grants) and the permissions they granted.

Target: `tenantId` (the tenant's GUID). Scope: organisation level, or a list of client application ids.

Credential (public config `tenantId`, `clientId`):

- **Federated (default, no stored secret).** An app registration with a federated credential trusting RegulAIt's
  federation issuer, audience `api://AzureADTokenExchange`, subject `regulait:discovery-source:<source id>`.
- **Static (a relaxation).** The app registration's client secret.

Application permissions to grant (admin consent), and nothing else: `Application.Read.All` and
`DelegatedPermissionGrant.Read.All` (or `Directory.Read.All`). Every run reads the token's permissions; any permission
that is not `*.Read.All` or `*.ReadBasic.All` refuses the credential before anything is read.

Egress: `login.microsoftonline.com` and `graph.microsoft.com`.

A consenting user is shown only as a pseudonym; an admin reveals the name with a step-up.

## MLflow-compatible ML platform — `ml_mlflow`

For a model registry and serving layer outside your cloud accounts that serves the MLflow REST API.

Target: `baseUrl` (the `https://` root, no query). Scope: organisation level, or a list of model and endpoint names.

Reads `GET /api/2.0/mlflow/registered-models/search` and, where the platform serves it,
`GET /api/2.0/serving-endpoints` (a plain MLflow server answers 404, reported as "not enabled"). A serving endpoint that
forwards to an external model provider is reported once more for each provider.

Credential: static only, a read-only token, sent as for the SaaS inventory (`authHeader` optional).

Egress: the `baseUrl` host.
