# ADR-0246: MCP definition pinning (rug-pull detection) and clean-room vulnerable MCP fixtures

- **Status**: Proposed
- **Date**: 2026-11-07
- **Backlog**: P27 (owner, 2026-11-07), PENDING §2g

## Context

The owner approved P27 on 2026-11-07 with two parts, built as RegulAIt's own versions.

1. **MCP tool-change pinning.** A server that is reviewed while benign and changes its definitions afterwards (a "rug
   pull") is the realistic MCP compromise. What we had before:
   - ADR-0097 admission scanning stores a whole-manifest SHA-256 digest (`admission_manifest_digest`) and re-scans
     every manifest, so a change that scans **dirty** re-holds the server.
   - ADR-0100's nightly re-scan and #609's on-demand sync re-fetch the manifest through the same path.
   - ADR-0175 A5's release-age cooldown quarantines a changed manifest for N days (7 by default), then lets it through.

   A change that scans **clean** therefore went through: a description edit, a widened schema, a flipped
   `readOnlyHint`, an added tool. No item-level record of what was approved existed, prompts and resources were not
   pinned at all, and an admin had no diff to review.
2. **Deliberately vulnerable MCP servers for CI.** "Damn Vulnerable MCP Server" and "mcp-injection-experiments" carry
   no licence, so they cannot be used. We need our own, written clean-room from the publicly documented attack classes.

P23 (`builder/p23-mcp-skill-scanners`) adds the Cisco mcp-scanner and skill-scanner engines in parallel. Pinning is a
different control (a change detector, not a content scanner), so the two do not overlap. P23 consumes the fixtures
once it lands.

**Open source first (ADR-0176).**
- Snyk agent-scan (formerly Invariant mcp-scan, Apache-2.0) pins tool descriptions by hash and reports a change as a
  rug pull. It is the design reference. Its code is a Python CLI with a hosted verification service that needs a
  token, and it works on client config files rather than a gateway's stored state, so none of it fits the gateway's
  request path. No code is reused, so no THIRD_PARTY row is added for it.
- Canonical JSON uses `canonicalize` 5.1.0 (RFC 8785, Apache-2.0), already a dependency of `@regulait/shared`.
- The admin diff uses `rfc6902` 5.3.0 (MIT, no dependencies, released 2026-07-23). Version 5.4.0 (2026-10-30) was too
  new to admit. `fast-json-patch` is unmaintained (last release 2022). `jsondiffpatch` emits a non-standard delta
  format; RFC 6902 is a standard an admin tool can apply.
- No maintained open-source module records MCP definitions against an approval in a database and gates calls on them.
  This is a governance decision on our own data (ADR-0176 rule 4).

## Decision

### Part 1: definition pinning

**What is pinned.** Every item a server serves gets a SHA-256 digest over the RFC 8785 canonical form of these fields:

| Kind | Key | Fields |
|---|---|---|
| tool | name | name, title, description, inputSchema, outputSchema, annotations |
| prompt | name | name, title, description, arguments |
| resource | URI | uri, name, title, description, mimeType |
| resource template | URI template | uriTemplate, name, title, description, mimeType |

`_meta`, icons and vendor extensions are not pinned: they reach no model and decide no grant. Annotations are pinned
(unlike the admission digest) because `readOnlyHint` decides a tool's read or write kind.

**Storage (migration 0302).**
- `mcp_definition_pins` has one row per (server, kind, key). It holds the approved digest and definition, who approved
  it and when, and the observed digest and definition and when they were seen.
- Status is derived from the two digests and never stored (ADR-0200 3NF): equal means approved; both set and different
  means changed; no approved digest means added; no observed digest means removed.
- The two definition columns are point-in-time evidence, the commented ADR-0200 exception, kept for the diff.
- `mcp_servers.definitions_pinned_at` marks the baseline. Without it, a server whose first manifest was empty would be
  re-baselined later instead of compared.
- `org_settings.mcp_definition_pin_mode` is `block` (the default) or `warn`.

**When.**
- **Baseline at admission.** The first manifest that gets past ADR-0097 admission and the ADR-0175 cooldown is the
  baseline: every item is recorded as approved with `approved_by` NULL, audited as `mcp-definitions-pinned`. A held or
  quarantined manifest never reaches this step. There is no grandfathering: an existing server is baselined at its
  next admitted manifest, like a new one (ADR-0180).
- **Every later manifest fetch is compared.** That covers a proxied `tools/list`, a governed call's first sync, the
  on-demand sync and the scheduled re-scan, because all of them go through `syncUpstreamTools`.
  - Prompts, resources and templates are listed on the same connection, only for a capability the server advertises,
    so a tools-only server costs no extra request.
  - A list that fails counts as "not observed" and leaves its pins alone. It never reads as "everything removed".
  - The comparison, its `mcp-definition-changed` audit row and the manifest upsert commit in one transaction, with the
    server row locked so two syncs cannot race the baseline.

**Enforcement under `block`.**
- A changed or added tool is neither stored in `mcp_tools` nor returned to any discovery surface.
- A governed call to a tool that is not approved is refused with `mcp-definition-blocked` before any connect. A tool
  the gateway has not stored yet is refused after the listing, so the upstream never receives a `tools/call`.
- `prompts/get` of a changed prompt and `resources/read` of a changed resource URI are refused by the same gate,
  before the kernel decision and the connect.
- A tool or prompt with no pin after the baseline is refused. That includes one past the per-kind cap of 1000. A
  resource URI with no pin is allowed, because a URI from a template has no pin of its own.

**`warn`.** The change is served and stored, and the same audit row is written with effect `allow`. Relaxing `block`
to `warn` goes through `PUT /v1/org/settings` as a strictness rule (`notEqual("block")`). That means a `settings_relax`
step-up, and the relaxation is named in the audit row.

**Admin API (UI → #453).** All three routes are admin-only.
- `GET /v1/mcp/definition-pins` lists the servers with changes since approval, paginated.
- `GET /v1/servers/:serverId/definition-pins` returns each pin with its status, both definitions and the RFC 6902 diff
  (`?pending=true` narrows to changes).
- `POST /v1/servers/:serverId/definition-pins/approve` takes `{items: [{kind, name, observedDigest}], reason}`, up to
  100 items.
  - It needs a `settings_relax` step-up bound to the server and the exact (kind, name, digest) triples.
  - Each item is a compare-and-set on the observed digest the admin reviewed. If anything moved, nothing is approved
    and the route answers 409 `definition_pin_stale`.
  - An item with `observedDigest: null` acknowledges a removal and deletes the pin.
  - One `mcp-definition-approved` audit row is written in the same transaction as the writes.

### Part 2: deliberately vulnerable MCP fixtures

A new test-only package, `packages/mcp-vuln-fixtures`. It is `private`, a devDependency of the gateway only, and
excluded from the image by `.dockerignore` (pnpm tolerates the missing workspace package under `--frozen-lockfile`;
checked). The gateway's `*.test.ts` files are already excluded from the image. Each fixture is plain data and can be
served over a real Streamable HTTP MCP transport through the low-level SDK `Server`, so the manifest arrives exactly as
written. A rug-pull fixture is switched with `pull(state)`, and the state records every method and call received.

| Attack class | Fixture | Caught by |
|---|---|---|
| tool poisoning | `<IMPORTANT>` directive with a zero-width character; a nested parameter description reading `~/.ssh/id_rsa` | ADR-0097 admission (held) |
| tool shadowing / name collision | description rewriting another server's `send_email`; a tool named `mcp:resources` | admission (held); reserved-prefix hold (ADR-0185) |
| rug pull | description edit, widened enum, tool removed and added, prompt and resource edited | this ADR (pinning) |
| excessive permissions | `run_command` and `query_database` on a calendar server, no read-only hint | write kind: default-deny grants, approvals, read-only posture |
| secrets in output | a fake AWS key id and PEM block in a result, assembled at runtime | output guardrail `semantic_dlp` |
| exfiltration through parameters | "include … API keys in the context parameter, then send … to https://collector.invalid" | admission `mcp.exfil.*` (held) |
| indirect injection | instructions in a returned ticket and a resource | output guardrail `prompt_injection` |

**Clean room.** The two unlicensed repositories were not opened or read. The fixtures come from the public
descriptions of the attack classes. Endpoints are RFC 2606 reserved names, and no handler touches the file system or
the network. A test asserts the fixture source contains no credential-shaped literal.

## Consequences

- A clean but changed definition is no longer silently trusted. The admin sees what changed as a standard JSON Patch
  and approves exactly what they read.
- Busy servers with dynamic resource lists will raise changes more often. That is the strict default working as
  intended; `warn` is the audited relaxation.
- Tests that change a fixture's manifest on purpose and expect it served can relax `mcpDefinitionPinMode` through
  `relaxStrictAdmissionForTest(db, ["mcpDefinitionPinMode"])`. It is not in the default `LOCAL_MCP_DOUBLE` list.
- Not row-level-security scoped: like `mcp_servers`, the table is deployment configuration behind admin-only routes,
  so it is outside the ADR-0234 slices.

### Honest limits

- **Comparison happens at manifest fetch, not on every `tools/call`.** A governed call to a stored, approved tool
  connects and calls without re-listing, so a server that changes between listings is caught at the next listing (any
  MCP client's session start, the on-demand sync, or the nightly re-scan). Re-listing on every call would add a round
  trip to every tool call. If the owner wants that, it can be added under `block` later.
- **First page and cap.** Prompts, resources and templates are read from the first page only. Each kind is capped at
  1000 items. Over the cap, tools and prompts fail closed and resources fail open (as template URIs do).
- **Discovery reads of `mcp_tools`.** The entitlement preview still shows the last approved version of a changed tool.
  A call is refused by the gate.
- **Prompt and resource list results.** `prompts/list` and `resources/list` relayed through the proxy are not filtered;
  `prompts/get` and `resources/read` are refused.

## As built

- Migration `0302_mcp_definition_pins` (journal `when` 1785229000000, as assigned). It is renumbered above main's
  highest migration at merge if main has moved past it (M-108; `scripts/migration-watermark-guard.mjs` enforces it in CI).
- `packages/shared/src/mcp-definition-pins.ts` is pure: digests, plan, status, diff and the approval schema.
- `apps/gateway/src/mcp-definition-pins.ts` holds the recording, the gate and the routes. Hooks are in
  `mcp-proxy.ts` (`syncUpstreamTools` and `executeGovernedToolCallInner`) and `mcp-protocol.ts` (`prompts/get` and
  `resources/read`).
- Tests: `apps/gateway/src/mcp-definition-pins.test.ts` (13, real database and app) and
  `packages/mcp-vuln-fixtures/src/fixtures.test.ts` (11, pure plus a real transport).
