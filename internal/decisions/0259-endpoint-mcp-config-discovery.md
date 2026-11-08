# ADR-0259: Endpoint MCP client-config discovery through the read-only endpoint agent

- **Status**: Accepted (owner-approved backlog item P35, 2026-11-07)
- **Date**: 2026-11-07
- **Builds on**: ADR-0195 (shadow-AI active discovery: SD0 framework, SD4 endpoint agent), ADR-0122 (MCP discovery and
  the registry diff), ADR-0235 (default-off org switches for discovery), ADR-0233 (content-column credential guard).
- **Overlaps**: P23 (`builder/p23-mcp-skill-scanners`, the Cisco mcp-scanner) scans MCP **servers**. This item finds
  where MCP is **configured** on employee machines. Coordinated on #453.

## Context

ADR-0195's endpoint agent already reports that an MCP host's config file exists (`assistant_config`) and whether a
key-shaped value sits in it. It does not say which MCP servers the file names, what they run, whether they carry
embedded secrets, which tools are auto-approved, or whether a server is one this deployment governs. Those are the
questions a security team asks first about MCP: a stdio server running `npx some-package` with a token in its env
block, or a remote server that is not in the registry, is ungoverned tool access on a work machine.

The owner approved P35 on 2026-11-07. The task asks for discovery of MCP client configs (Claude Desktop, Cursor,
VS Code and other hosts) that flags the servers each machine uses, embedded secrets (as a fact and a type only, never
the value), risky tools and unapproved servers. The results go through the existing shadow-AI finding lifecycle, and
an admin can register a finding or link it to an approved server.

## Decision

### 1. Maintenance check (ADR-0176): `apisec-inc/mcp-audit` — none fits

Checked on 2026-11-07 from a clone of `https://github.com/apisec-inc/mcp-audit` (head `6ae4e1f`):

- **Licence:** `LICENSE` is MIT (Copyright 2024 APIsec). It passes ADR-0176's licence rule.
- **Release activity:** one tag, `v1.0.0` (2026-01-15). The `v1.1` source-scan work (2026-05-12) is untagged. The last
  commit is 2026-08-18, with three commits since May. Almost all commits are from one maintainer. The repository's
  issues page could not be read from the build environment (HTTP 403), so issue responsiveness is **unverified**.
- **Offline:** the core scanners make no network calls. Some outputs link to hosted pages, and its PDF report imports
  a Google Fonts stylesheet.
- **Fit:** it is a Python CLI. Running it as a "sidecar" on employee machines would put a Python runtime and a second
  collector on every device through MDM. That breaks ADR-0195 decision 19 (one signed, static, read-only agent that
  collects a fixed fact set) and would change the endpoint's permissions and trust boundary. Vendoring its rule set
  does not work either: its secret patterns are Python regexes. ADR-0195 decision 11 and the agent's
  `internal/secrets` package allow only the shared, RE2-compiled `dlp.secret.*` rules. Its per-host paths are data
  the signed collection manifest already carries (from ADR-0195's imported registry). The cadence fails "actively
  maintained" too: one tagged release and an untagged minor.

**None fits, because:** the only maintained distribution is a Python CLI that cannot run inside the static Go agent.
A sidecar would widen the endpoint's trust boundary. Its detection rules are not RE2-compatible data, and with one
tagged release it does not meet the maintenance rule. Config-path discovery is therefore **implemented natively in
the existing endpoint agent**. mcp-audit is cited as **design reference only**: its host list, its secret categories
(env values, header values, URL credentials) and its risk categories (shell launchers, unpinned packages,
privileged containers) informed the compiled checks below. No code or data was copied. Re-check when the project
publishes tagged releases and a data-only rule format.

JSONC and TOML: no Go JSONC parser passes ADR-0176 (`tailscale/hujson` has no tagged release, only pseudo-versions;
the last commit was 2026-07-27), as the repo scanner already found for Node (`packages/shared/THIRD_PARTY.md`). A
config that is not plain JSON is reported as the gap `mcp_config_unparsed`. This covers a VS Code `settings.json`
with comments, Zed settings and Codex's `config.toml`. Re-check when a maintained parser exists.

### 2. The agent's `mcp_config` collector (read-only)

A new signature kind, `mcp_config`, in `agents/endpoint/internal/collect/mcp.go`:

- **Detection is data.** The signed collection manifest names the config files per OS (a `files` locator list, as
  for `assistant_config`). The agent holds only format knowledge, that is, where each host keeps its server map:
  `mcpServers` (Claude Desktop, Cursor, Windsurf, Cline, Gemini CLI, a project `.mcp.json`), `servers` (VS Code
  `mcp.json`), `mcp.servers` (VS Code `settings.json`), `context_servers` (Zed) and `projects.*.mcpServers` (Claude
  Code). It never keeps a project key, which is a path.
- **Read-only, never execute.** A config is read as bytes through the same `os.Root`-bounded, size-capped reader as
  every collector, parsed as plain JSON and dropped. No configured server is started, contacted or resolved. No
  command is looked up on `PATH`. Nothing is written.
- **One fact per server** (`matchedOn: "mcpServer"`, `server: MCPServer`), carrying only values that pass a shape
  check on the device:
  - the entry name, or `(unnamed)`;
  - the transport;
  - the command's base name, never its arguments;
  - the package or image that `npx`, `bunx`, `pnpm dlx`, `uvx`, `uv tool run`, `pipx run`, `docker run` or
    `podman run` runs, with its exact version when pinned;
  - a remote server's host, never its URL path, query or credentials;
  - a disabled flag;
  - risk flag names;
  - risky auto-approved tool names and a count of all auto-approved tools;
  - key presence as `{keyName, ruleId, present}`.
- **Embedded secrets** are found on the device and reported as a type only:
  - a compiled `dlp.secret.*` match in an env value, a header value, an argument or the URL;
  - a literal under a secret-named env key (`mcp.secret.named_literal`);
  - a literal `Authorization` header (`mcp.secret.authorization_header`);
  - URL user info (`mcp.secret.url_userinfo`);
  - a key-shaped URL query value (`mcp.secret.url_key`).

  References (`${VAR}`, `${input:…}`, `op://…`, …) are not secrets.
- **Risk flags**, a closed compiled set:
  - `shell_launcher`;
  - `container_privileged`;
  - `host_root_mount`;
  - `unpinned_package`;
  - `secret_in_args`;
  - `plaintext_remote` (http to a non-loopback host);
  - `auto_approve_all` (`"*"`, `autoApprove: true`, Gemini `trust: true`);
  - `risky_tool_auto_approved`: an `alwaysAllow` or `autoApprove` tool whose name contains a write, run or delete
    verb as a whole word.
- **Default off on the device too.** `mcp_config` is an *opt-in kind* (`contract.OptInKinds`). The agent collects
  it only when the org policy the gateway serves names it in the new `enabledOptInKinds` field. A signed manifest
  that lists it is not enough. A policy that omits the field, or an older gateway, keeps it off. Local
  `disabledKinds` still narrows it.
- **Endpoint agent permissions are unchanged.** The collector reads files under roots the agent already reads (the
  user's home, `%APPDATA%`, `%LOCALAPPDATA%`), as the logged-in user, through the same bounded reader. It adds no OS
  permission, entitlement, service, network destination or privilege. It links no new Go module.

### 3. The org switch (ADR-0180, secure by default)

`discovery_settings.endpoint_mcp_config_enabled`, default **false** (pending migration `endpoint_mcp_config_discovery`). `PUT /v1/discovery/settings
{endpointMcpConfig: true}` is a `settings_relax` step-up bound to that change
(`DISCOVERY_STEP_UP_KEYS.endpointMcpConfig`) and is audited as `discovery-settings-relaxed`. Turning it off is free.
While it is off:

- the gateway's org policy names no opt-in kind (`endpointOrgPolicy`, for the agent config route once the pack is
  signed);
- a report's mcp_config facts are **refused**: they are counted in `endpoint_agent_reports.facts_mcp_refused`,
  never stored and never matched.

### 4. Into the existing shadow-AI lifecycle

While the switch is on:

- each mcp_config fact is a catalogue sighting of its host's config file (`matchedOn: mcpServer` maps to SD3's
  `config_path` match type, with the manifest path as the value). So the device's shadow-AI finding for that MCP
  host is created or updated through SD0's ordinary merge, with dispositions, the risk-register feed and remediation
  unchanged. "Register a finding" is that finding's existing disposition route;
- each server is stored in `endpoint_mcp_servers`, one row per device, config file, entry name and identity (the
  package, else the host, else the command). Rows are evidence from a signed report: an older report never
  overwrites a newer row, and a newer report that observed mcp_config completely (no mcp_config gap) prunes the
  servers it no longer lists. The endpoint retention (ADR-0195 decision 20, 90 days) deletes rows not seen within
  it. A secret is stored only as its type (the rule id, or `listed_name`), never its key name or value. An
  identifier that is still credential-shaped after the device's shape check is stored as `(unnamed)`. The column
  `server_name` is ADR-0233 `ingested`.

### 5. Unapproved servers: the registry diff (ADR-0122) and links

`GET /v1/discovery/endpoint-mcp-servers` (admin-only, keyset-paginated, at most 200 a page) returns each row with:

- its device pseudonym and host app;
- its registry status:
  - `linked`: an admin linked its identity to an approved `mcp_servers` row;
  - `registered`: a remote server whose host equals a registered server's URL host, normalised on both sides;
  - `unregistered`: neither;
- a verdict sentence;
- the id of the shadow-AI finding the same report fed.

It filters by `status`, `risky`, `secrets` and `deviceId`.

`POST /v1/discovery/endpoint-mcp-server-links {identityKind, identity, mcpServerId}` links an identity (package,
host or command) to an approved server, and `POST …/remove` unlinks it. Both are admin-only and audited
(`endpoint-mcp-server-linked` / `-unlinked`, object type `mcp_server`). A link is a statement about the identity,
so it applies on every device. Unlinking uses POST so the route needs no DELETE UI affordance before the UI exists.

### 6. UI

Backend and agent only. The UI needs (the switch on the Discovery sources settings, the inventory list with its
filters and verdicts, link and unlink) are posted on #453.

### 7. Design reference: giggsoinc/PatronAI (owner-approved, 2026-11-07)

PatronAI is Apache-2.0 and written in Python; it was checked at commit `79bdcc8` (2026-06-02). It is used as a
**design reference only**: nothing is copied and it is not a dependency. It is AWS-centric, downloads a model of
about 750 MB on first start, and its login is weak. ADR-0195 already pins its provider and detector data files for
SD1 and SD2. The owner asked for three comparisons:

1. **MCP-registration detection** (`agent/install/scan_mcp_configs.py.frag`, `src/ingestor/pipeline_mcp_change.py`).
   - Its endpoint scan reads only `mcpServers` from four hosts (Claude Desktop, Cursor, Continue, Cline).
   - It keeps the argument flags and env key **names**, and drops values.
   - It raises a high-severity event when a config file's SHA-256 changes.

   This collector already covers more hosts and server-map keys, and it reports packages, hosts, secret types and
   risk flags. It keeps no env names, because ADR-0195 lane A6 forbids storing them. One idea was taken and
   re-implemented natively. When a server is newly configured on a device that already had MCP servers, the gateway
   audits `endpoint-mcp-servers-added`, naming the new identities. Row identity is used rather than a file hash,
   which would also fire on an unrelated settings edit. Two of its paths go into the collection manifest's data,
   not code, when the pack is built (ADR-0195 SD4): Continue (`.continue/config.json`) and Cline
   (`.config/Cline/mcp_settings.json`).
2. **AI provider endpoints and domains** (`config/providers.yaml`, `config/unauthorized.csv`): 87 hosts.
   - Compared with the hostnames in the shipped catalogues, about 60 entries do not match exactly.
   - Leaving out generic hosting platforms (Vercel, Render, Railway, Fly, `amazonaws.com`), which are not AI signals
     on their own, the missing providers include:
     - Together AI, AI21, Dify, n8n Cloud, Flowise, Langflow, Modal, Banana, Beam, Lepton;
     - Anyscale endpoints, Pinecone, Chroma Cloud, Weights & Biases, Comet, Scale;
     - LangChain Hub, xAI Grok, NVIDIA API catalog, Google AI Studio, NotebookLM, Opal, Vertex AI;
     - v0, Manus, Suno, Stack AI, BuildShip, Sim, GPT4All.
   - `SHADOW_AI_CATALOG_V1` is frozen and V2 is pinned by entry count and hash (ADR-0195 decision 15), so adding them
     is a catalogue change: a new pinned version or admin seed rows, each endpoint checked against vendor
     documentation. That is a separate catalogue PR, not part of P35. It is recorded as a follow-up.
3. **Endpoint checklist** (`scan_packages`, `scan_processes`, `scan_ide_plugins`, `scan_browsers`,
   `scan_shell_history`, `scan_containers`, `scan_vector_dbs`).
   - Already covered by the agent: running AI processes and listening ports (`local_runtime`), IDE plugins
     (`ide_extension`), browser extensions, AI CLIs and desktop apps.
   - Missing **read-only** checks that fit ADR-0195 decision 19: globally installed AI language packages (pip
     site-packages, npm global), local AI container images, and local vector databases. They are recorded as
     follow-ups for the SD4 fact set; each needs the employee notice updated.
   - **Not built, needs an owner decision:** browser history and shell history markers. ADR-0195 decision 19 lists
     browsing history as an explicit non-goal of the agent, and shell history holds the commands people typed. A
     marker check would read that content on the device even if only a fact left it. That reverses an accepted
     owner decision, so it is escalated on #453 rather than built here.

## Consequences

- MCP use on endpoints becomes an answerable question per device: which servers, what they run, which carry secrets,
  which are risky, which are not governed here. It costs nothing until an admin turns it on with a step-up.
- What leaves the device grows by one closed, shape-checked structure per server. The employee notice template gains
  one optional line (`docs/deployment/ENDPOINT_EMPLOYEE_NOTICE_TEMPLATE.md`).
- JSONC and TOML configs (VS Code `settings.json` with comments, Zed, Codex) are a reported gap until a maintained
  parser passes ADR-0176.
- Command identities (`node`, `python`) are coarse: linking one approves every server that command launches. The
  package and host identities are the precise ones.
- The agent config route still serves no pack (ADR-0195 SD4: the pack signer is pending). `endpointOrgPolicy` is
  what that route will serve; until then no agent collects mcp_config, which is the secure default.
- Follow-ups: the PatronAI-derived catalogue additions and the read-only package, container and vector-DB checks
  (section 7); the owner's call on history markers; the UI (on #453); P23's server scanner can take the `unregistered` inventory as its queue; re-check
  mcp-audit and a JSONC/TOML parser at the next ADR-0176 review.

## Numbering

ADR 0259 was assigned by the master session for P35. The migration was first claimed as 0312; under ADR-0252 it is
the pending file `packages/db/migrations/pending/endpoint_mcp_config_discovery.sql`, numbered after the merge. The
PENDING row and the STATE entry are fragments under `internal/fragments/`.
