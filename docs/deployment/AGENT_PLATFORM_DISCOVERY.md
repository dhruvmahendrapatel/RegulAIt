# Agent platform sources: agents built in Copilot Studio, Agentforce, OpenAI and n8n

These source kinds find AI agents that people build in low-code agent platforms and stage each one, with what it uses
(models, tools, MCP servers, connected apps, knowledge), in the agent registry importer (ADR-0336). They sit in the
**agent registry** family, so two switches stand in front of each one:

1. **The agent registry family switch** (Discovery sources → Settings). Off by default; turning it on asks the admin
   to confirm it is them.
2. **The source** itself, off until enabled.

Nothing is imported automatically. A staged agent is a proposal: an admin imports it one at a time, and the imported
agent starts disabled, lifecycle `proposed`, with no grant of any kind.

RegulAIt only reads. Every adapter is held to a fixed list of (method, path) pairs in code, on top of the egress
allow list, and any other request is refused before it leaves. No adapter reads an agent's instructions, prompts,
conversation starters, topic bodies or knowledge-file content, and none calls an endpoint that returns credential
material. People appear only as pseudonyms.

**Plaintext credentials in an agent's configuration.** For OpenAI GPTs and n8n agent workflows, RegulAIt also looks
for credentials written into the agent itself: an API key pasted into a GPT's instructions or a custom action's schema,
or a token typed into an n8n node's parameters. The text is checked in memory, with the same credential rules RegulAIt
uses elsewhere, and dropped straight after. A hit becomes a **critical** discovery finding that says only where the
credential is: the agent, the field (for example `gpts/<id>/configs/<id>/instructions` or
`workflows/<id>/nodes/<node id>/parameters/headerValue`) and the kind of credential (the rule id). The credential
itself, any excerpt of the text and any position in it are never stored, shown or logged, so rotate the credential and
move it into the platform's own credential store.

Every call goes through the egress allow list: add the hosts named below before the first run.

## Copilot Studio — `agent_registry_copilot_studio`

Target: `tenantId` (the Entra tenant), `orgUrls` (1 to 20 environment URLs, `https://<org>.crm<N>.dynamics.com`).
Credential: an Entra app registration (federated by default) added as an application user in each environment, with a
security role that grants Read privileges only. Every run checks the user's privileges first and refuses a credential
that holds any privilege that is not a read. Hosts: `login.microsoftonline.com` and each environment's host.

## Salesforce Agentforce — `agent_registry_agentforce`

Target: `myDomain`, `environment` (`production` or `sandbox`), `apiVersion` (default 67.0). Credential: static, the
connected app's consumer key and integration user in the public config, its RSA private key (at least 2048 bits) as the
secret. Every run checks the integration user's system and object permissions first and refuses any write. Host: the
org's My Domain host.

## OpenAI ChatGPT custom GPTs — `agent_registry_openai`

Reads the workspace's live custom GPTs through the ChatGPT Enterprise Compliance API: name, owner (as a pseudonym),
sharing visibility, tools (browsing, code interpreter, image generation, memory), custom actions (by domain and sign-in
type) and knowledge files (by id and name). Draft GPTs and third-party GPTs are not in the Compliance API's listing, so
they are not seen.

Target: `workspaceId` (the ChatGPT workspace's id, a UUID). Scope: organisation level, or a list of GPT ids (`g-…`).

Credential: static only (OpenAI accepts no external OIDC token). Create an **admin key** for the workspace in the OpenAI
admin console (Credentials → Admin keys), choose the **Custom** preset and grant only
`chatgpt.enterprise.compliance_export: read`.

**How broad this key is, stated plainly.** A Compliance API key is one of the most powerful keys a ChatGPT workspace
has:

- its read scope opens the workspace's other compliance exports too (users, projects and files), not only the GPT
  listing, and the conversation scope, if granted, opens every conversation in the workspace;
- a key made with the **All** preset can also **delete** GPTs, GPT files and conversations;
- OpenAI offers no API that shows a key's own scopes, so RegulAIt **cannot check** what the stored key can do.

RegulAIt calls exactly one endpoint with it, `GET /v1/compliance/workspaces/<workspaceId>/gpts` on
`api.chatgpt.com`, and refuses any other path or method in code before a request is sent. Because the scope cannot be
checked, storing and enabling the key are recorded as a **relaxation**: each step-up names
`credentialScope: "unverified"`, so do confirm it, the audit rows carry the same field, the source's API representation
shows `credentialScope: "unverified"`, and every run reports the credential as `unverified`. Store the key only if
your organisation accepts that RegulAIt holds it (encrypted, never returned, rotatable by replacing it).

Host: `api.chatgpt.com`. OpenAI's Compliance API allows 100 requests a minute per workspace; RegulAIt reads 20 GPTs a
page.

## n8n AI agent workflows — `agent_registry_n8n`

Reads the instance's workflows through the n8n public API, with pinned data excluded at the source, and stages every
workflow that holds an AI agent (any node fed by a chat model), with the models, tools, MCP servers (by scheme, host and
port only), vector stores and credential references (credential type, id and name; never the credential) its agents
use.

Target: `baseUrl`, the instance's https address, for example `https://<name>.app.n8n.cloud` or a self-hosted
`https://n8n.example.com/automation`. A self-hosted instance on a private address is reachable only if its host is on
the egress allow list. Scope: organisation level, or a list of workflow ids.

Credential: static only, an n8n API key (Settings → n8n API). Give it only the `workflow:list` and `workflow:read`
scopes.

- **n8n 2.14 and later:** every run first asks the instance which scopes the key holds (`GET /api/v1/discover`). Any
  scope other than a `:read` or `:list` scope refuses the key, nothing is read and the source cannot run until the key
  is replaced. Only read scopes record the key `read_only`.
- **Before 2.14:** scopes exist only on Enterprise plans, and a key on any other plan carries **full scope**, able to
  change, activate or delete workflows. The instance cannot report a key's scopes either, so the run reports
  `unverified`.

RegulAIt calls only `GET /api/v1/discover` and `GET /api/v1/workflows`, and refuses any other path or method in code
(it never calls `/credentials`, and never activates or deactivates anything). Because an older instance cannot report
the key's scope, storing and enabling any n8n key are recorded as a relaxation, as for OpenAI above
(`credentialScope: "unverified"` in the step-up, the audit rows and the source's API representation).

Host: the instance's host.
