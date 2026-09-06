# ADR-0101 — Federated MCP registries: a governed catalogue, and an import that grants nobody anything

- **Status**: Accepted
- **Date**: 2026-09-06
- **Relates to**: ADR-0097 (the MCP admission scanner — federation is the population it was
  built for, and this ADR adds no bypass), ADR-0100 (the scheduled re-scan, whose sweep shape
  this copies), ADR-0043 (the fail-closed MCP egress guard — the pull is its surface), ADR-0034
  (the egress guard proper: default-deny on a destination, DNS-pinned, redirect-refusing),
  ADR-0062 (mode-scoped egress / air-gapped mode — extended here, deliberately, beyond what it
  itself enforces), ADR-0064 (the in-process scheduler: off by default, bounded per pass, one
  audited fact), ADR-0023 (`mcpMode`, the MCP proxy), ADR-0021 (the org-settings ceiling model
  and its "a fresh install changes nothing" invariant), ADR-0053 (the published API contract and
  its drift suite)
- **Migration**: 0105 (`0105_mcp_registry_federation`)

## Context

### The shape mismatch, which is the whole design constraint

`mcp_servers` in this codebase is a row with a **URL**. `connectUpstream` opens a
`StreamableHTTPClientTransport` at that URL through ADR-0043's guard. There is no stdio transport
anywhere in this gateway, and adding one would be a different ADR about running third-party
processes inside a control plane.

A public MCP registry is not a list of URLs. Verified against the official v0.1 OpenAPI document
(`GET /v0.1/servers`, **no authentication required**, API frozen at v0.1), a listing page is a
`ServerListResponse`: a `servers[]` array of `{ server, _meta }` pairs plus a `metadata` object
carrying `count` and an **opaque** `nextCursor`. The required fields of the inner `ServerJSON` are
`$schema`, `name`, `description` and `version` — **`packages` is not required, and neither is
`remotes`**. An entry may carry both, either or neither.

What it mostly carries is `packages[]`: an npm/PyPI/OCI/NuGet/MCPB coordinate you install and run
**locally, over stdio**, on the machine that wants the tools. There is no endpoint in such an
entry. There is a `remotes[]` array — an array of `Transport` objects `{ type, url?, headers?,
variables? }` — and that is where a real endpoint lives when one exists at all.

So the first decision this ADR has to take is what happens to the majority of a registry, and the
one thing that was never on the table was inventing a URL for it.

### The governance position we are deliberately not copying

The reference implementation reviewed for this slice, `agentic-community/mcp-gateway-registry`,
gives a federated entry **the same access as a locally-registered one, with no approval step**.
In a default-deny product that is not a shortcut, it is the opposite policy: it lets a third
party decide what exists inside the estate, and it makes "we imported a directory" and "we
granted an unknown upstream to our users" the same act.

That is the specific thing this ADR is built to make impossible, and every structural choice
below follows from it.

## Decision

**Sync writes a catalogue and nothing else. Import is a separate, explicit, audited operator act
that creates one `mcp_servers` row which is `federated`, `unscanned`, and usable by nobody.**

### 1. Remote vs package: only `remotes[]` can become a server, and no URL is ever invented

An entry is classified `remote` iff its `remotes[]` contains a `streamable-http` or `sse`
transport whose `url` is **absolute, http(s), free of userinfo, and free of an unfilled
`{placeholder}`**. `streamable-http` wins over `sse`; ties break on document order, which is the
publisher's own preference.

Everything else is **`catalogue_only`**, with the reason recorded on the row so an operator who
asks "why can't I import this one?" gets an answer rather than a shrug: `packages_only`,
`stdio_only`, `remote_url_unusable` (templated, relative, malformed, wrong scheme),
`no_distribution`.

Two sub-decisions inside that rule, both deliberate:

- **A package's own `transport.url` is NOT an endpoint.** The spec permits a `Package` to carry a
  `transport` object which itself has a `url`, and in practice that url is a loopback address —
  it describes how a client talks to the process *after starting it locally*. Dialling it from
  this gateway would either fail or, far worse on a shared box, reach whatever else happens to
  be listening on that port. It is ignored, and the suite asserts it is ignored.
- **A templated remote is catalogue-only, not a guess.** `https://{region}.example.com/mcp` with
  a `variables` map is a real published shape. Substituting a value would be inventing a URL;
  importing the literal string would put a hostname with a brace in it into `mcp_servers`. Both
  are worse than saying "this one is catalogue-only".

**Why store the un-importable ones at all rather than skipping them?** Because the operator
question federation exists to answer is "what does this registry publish", and a view that
silently omitted 90% of it would be a lie of omission about our own coverage — an operator would
conclude the registry was empty, or that we had failed to sync. A catalogue-only row is
**structurally inert**: it has no `mcp_servers` row, therefore no `/mcp/:serverId` route, no tool
inventory, and no grant that could name it. It cannot be called because there is nothing to call,
not because a policy says no.

### 2. The name rule, and dedupe

**The local `mcp_servers.name` is the upstream reverse-DNS name, verbatim.** Registry names
(`io.github.user/weather`) are already the most collision-resistant identifier available and are
the only string an operator can paste back upstream to see what they imported. Mangling — a
registry-slug prefix, slugifying the slash — would buy automatic de-collision at the cost of that
lookup, and would quietly create two local rows for one upstream server the day an operator adds
a second registry mirroring the first.

`mcp_servers.name` is globally unique, so the idempotency key that makes re-sync safe is **not**
the server name: it is `(registry_id, upstream_name)` on the catalogue table. Running the sweep
twice updates rows; it never inserts a second one.

### 3. Never clobber a local row

A collision on **name** or on **url** with a server row this catalogue entry does not already own
is recorded as a `conflict` (`name_taken` / `url_taken`, with the colliding server's id) and the
import is refused `409`, audited. It is re-checked against the live table at import time rather
than trusted from the last sync. Nothing is overwritten, merged or renamed: a local row is the
operator's own decision, and "the registry won" is not a resolution anybody signed for.

The same rule applies **after** an import. If an upstream moves an already-imported server's
endpoint, the new url is recorded as `remote_url_drift` on the catalogue row and
**`mcp_servers.url` is left alone**. A registry that can silently repoint a server an operator
already trusts, and has already granted people access to, is the entire federation attack in one
field. Version provenance *does* advance, because that is a fact rather than a redirect.

### 4. A federated entry arrives usable by NOBODY

The import creates exactly one row: `origin='federated'`, its url, its provenance. It creates
**zero `tool_grants`, zero `server_grants` and zero `mcp_tools`**. There is no federation branch
in the policy gate, the proxy route, the admission gate or the egress guard — the imported server
is an ordinary `mcp_servers` row in every respect except its provenance columns — so an ordinary
user calling it is refused by the same code, with the same message, as an ungranted
hand-registered server. The suite proves that by canonicalising the two refusals and comparing
them, then granting one tool to show the refusal was not vacuous.

### 5. It is `unscanned`, and ADR-0097 applies with no bypass

Migration 0103's `grandfathered` default exists for rows that predate the admission scanner and
are trusted *because they already were*. A server that arrived from a public directory five
seconds ago has no such history. The import path therefore writes `unscanned` **explicitly**,
exactly as `POST /v1/servers` does, and the first connect runs `recordManifestScan` like any
other. Under `enforce` a poisoned manifest is held and the server is then refused before any
outbound attempt. Federation is precisely the population that gate was built for; it gets no
door of its own.

### 6. Egress, and the air-gapped rule

The pull is an outbound call to an **admin-typed** URL, so it is ADR-0043's surface exactly:
`checkEgress` at write time (an honest 400 the moment somebody configures an unreachable
destination, audited) and `createGuardedFetch` on every page — re-validated per request,
DNS-pinned, redirects refused. A public registry host needs an `egress_allow_hosts` entry like
every other public destination; default-deny is not relaxed for this feature, and the unconditional
IMDS/link-local carve-out applies here as everywhere.

**On an air-gapped deployment federation refuses outright — before DNS, before any socket, and
regardless of the allow-list.** This is stronger than ADR-0062 itself enforces, and it is chosen
rather than inherited: ADR-0062 adjudicates a *compiled vendor default* and leaves admin-typed
URLs to the allow-list, which would mean an air-gapped operator who allow-listed a host for some
other reason ends up pulling a public directory into a disconnected enclave. The promise
air-gapped mode makes is that nothing leaves; "except the thing that goes and asks the internet
what servers exist" is not a footnote that promise survives. The refusal is audited under
`mcp-registry-sync-refused` and surfaced on `GET /v1/mcp-registries` as
`federationRefused: true`, so an operator never has to infer it from a run of failed syncs.

### 7. The sweep (ADR-0064), and deletions

`mcp-registry-sync-sweep`, six-hourly by default, the twelfth job on the existing scheduler,
calling the same `syncRegistry` the manual door calls. **Triply opt-in**: the scheduler is off by
default, a fresh install has zero registry rows, and a registry row is `enabled = false` until an
operator flips it.

Bounded: **5 pages × 100 entries per registry per pass** (100 is the upstream's own `limit`
maximum), **5 registries per pass**, least-recently-synced first, a 10s per-request timeout and a
4 MiB body cap. One audited fact per pass — `mcp-registry-swept`, `effect: allow`, carrying real
counts including `serversCreated: 0` and `grantsCreated: 0` — plus one `mcp-registry-synced` row
per registry. `effect: allow` on the sweep row deliberately: each refused registry already filed
its own deny row, and duplicating it would double-count a refusal on an admin's filtered view.
Manual doors: `POST /v1/mcp-registries/:id/sync` for one registry, and ADR-0064's
`POST /v1/scheduler/jobs/:name/run` for the whole pass.

**Deletions never propagate.** We never send `include_deleted`, and we never send `updated_since`
either — the spec says `include_deleted` is *forced true* whenever `updated_since` is present, so
an "incremental" sync would silently start ingesting tombstones. An entry that disappears from a
listing gets `missing_since` set, and **only when that listing was complete**: a pass truncated by
the page bound marks nothing, because "beyond the page cap" and "gone" are different facts. The
local `mcp_servers` row is never deleted, disabled, or un-granted. A public directory losing an
entry — a publisher unpublishing, or somebody taking over an abandoned name — is not authority to
remove a governed object from an operator's estate. It is information, and the operator acts on it.

### 8. Provenance

`mcp_servers` carries `origin`, `registry_id`, `registry_entry_name`, `registry_version`,
`registry_first_seen_at`, `registry_last_synced_at` — on the **server row**, because "where did
this come from" is asked while looking at the server. The catalogue row keeps the fuller record
(title, description, repository, website, upstream lifecycle status, publication times, kind and
reason, conflict, drift, missing-since). `registry_id` is `ON DELETE SET NULL`: removing a
registry configuration must never cascade into deleting servers an operator relies on.

## What this deliberately does NOT do

- **It does not auto-import.** A sync never creates a governed object. That is the whole
  difference between this and the design it declined to copy, and it is also the honest cost:
  federation here is a discovery aid, not a provisioning pipeline.
- **It does not import stdio/package servers, and it never will under this ADR.** Running a
  third-party npm package inside the control plane is a different decision with a different
  threat model, and it needs its own ADR rather than a fallback branch in this one.
- **It does not rewrite a local server's url, name, price, private-range flag or grants — ever.**
  Post-import, the only fields a sync touches on `mcp_servers` are `registry_version` and
  `registry_last_synced_at`.
- **It does not publish.** Read-only federation. There is no `POST /v0.1/publish` path, no token
  exchange, no DNS/GitHub OIDC auth against a registry.
- **It does not version-track.** We pin `version=latest` on the listing and keep one catalogue row
  per `(registry, name)`. Version history, pinning an imported server to a specific published
  version, and re-import-on-new-version are all out of scope.
- **It does not scan on import.** The manifest scan happens on the first connect, exactly like a
  hand-registered server, because that is the only moment a manifest exists to scan.
- **It adds no org-settings knob.** The posture is the registry row itself: no rows, no
  federation. A knob would be a second thing to get wrong and a fresh install already changes
  nothing.
- **It ships no SPA surface.** Admin API only (`apps/web/**` belongs to another session).

## Honest limits

- **A registry is a DIRECTORY, not a trust anchor.** This is the most important sentence in the
  ADR. The v0.1 read API requires no authentication and performs no publisher identity
  verification that reaches us: nothing in a listing proves that `io.github.acme/tools` is
  operated by Acme, and reverse-DNS namespacing is a naming convention, not an attestation we
  validate. **Name-squatting and typosquatting are possible and undetectable from a listing.** An
  operator importing an entry is trusting the publisher, not the registry — the registry only
  told them the publisher exists. Every downstream control (per-user grants, admission scanning,
  the egress guard, approvals) assumes exactly that and none of them is weakened by it, but no
  reader should mistake "it was in the registry" for "somebody checked".
- **Registry-supplied text is untrusted display data.** `title`/`description`/`repository`/
  `website` are publisher-controlled strings from an unauthenticated source, capped and stored for
  an admin screen. They are never handed to a model as authority. The only upstream text a model
  ever sees is the **tool manifest**, which arrives through ADR-0097's scanner.
- **`_meta.status` is the registry's statement, not a verification.** A `deprecated` or `deleted`
  status is recorded and shown; it does not disable anything, for the same reason
  `missing_since` does not.
- **Bounded means partial.** A registry with more than 500 entries is swept 500 at a time, and
  while a pass is truncated **no disappearance can be detected at all** — a deliberate
  false-negative in favour of never marking a live entry gone.
- **Air-gapped means no federation, full stop.** An air-gapped install running its *own* registry
  mirror on the LAN cannot use this feature either, and registers servers by hand. A carve-out for
  "private-looking" registry URLs would make a per-request DNS answer decide whether a governance
  promise applies; the promise is worth more than the convenience. Stated so nobody discovers it
  in a deployment.
- **Conflict detection is a point-in-time check.** Two concurrent imports of two entries that
  collide with each other could both pass the check and then fail on the unique index. That is a
  crash, not a clobber — `mcp_servers.name`'s unique constraint is the real backstop — but the
  error a caller sees in that race is a 500, not the tidy 409.
- **Only `streamable-http` really works.** An `sse`-only remote imports and records its transport
  honestly, and then fails at connect against ADR-0043's pinned streamable-HTTP transport. The
  failure is honest and visible rather than hidden behind a refusal to import, but it is a
  failure.
- **`updated_since` is unused, so every pass is a full listing.** Cheap for a small registry,
  wasteful for a large one. The alternative forces tombstone ingestion (see §7) and was declined.
- **Non-vacuity (M-002, measured).** Neutralising the import into the reference implementation's
  posture — no conflict check, `grandfathered` instead of `unscanned`, and a read-only-all grant
  minted for every user — reddens **6 of 41**. Neutralising the remote-vs-package rule so a
  package's own `transport.url` counts as an endpoint reddens **4 of 41**. The tests that stay
  green under each probe assert the *other* half (pagination and cursor round-trip, egress and
  air-gap, sweep bounds, audit counts, admin-only routing), which is what one would want, but it
  does mean no single probe reddens the file.
