# ADR-0019 — Per-user agent/connector revocation, and one attributed + PII-enforced ledger across every governed entry point

- **Status:** Accepted
- **Date:** 2026-07-30
- **Supersedes / amends:** amends [ADR-0014](0014-role-bundled-agent-connector-grants.md) (which
  deferred per-user revocation of role-bundled grants) and [ADR-0018](0018-six-dimension-assignment-matching.md)
  (which deferred the 6th assignment dimension). Records the honest assessment of
  [ADR-0015](0015-byoc-deploy-modes-data-boundary.md)'s deferred item **A4**.

## Context

Four holes, each undercutting a stated P0 claim rather than merely being unfinished work.

1. **Pillar 1 promises "role builder + per-user override".** The `revocations` table is
   **MCP-only**. ADR-0014 made role-bundled *agent* and *connector* grants compose additively
   (UNION-MAX), on the reasoning that a role grant can never exceed a direct grant — true, but it
   left **no subtractive operator at all** for those two object types. An admin who needed to take
   one agent away from one user could only unassign the whole role, changing that user's access to
   everything else the role confers. "Per-user override" was therefore only two-thirds true.

2. **A documented known limit in `STATE.md`:** on a `block`-mode PII project the SSE path could
   *transiently flash raw model output* before the `result` event overwrote it with the withheld
   marker. The output PII check can only run once the full text exists; by then the deltas are
   already on the wire and out of the server's control. Bytes that reached the client cannot be
   un-sent, so this was a real §8.4 leak, not a cosmetic one.

3. **Pillar 5 claims spend is attributed "at the point of every gateway call".** The MCP proxy was
   the one governed entry point with **no `projectId`** — so MCP tool calls were neither
   cost-attributed nor PII-enforced, while the model and connector paths were both. Two of three
   entry points held the contract.

4. **ADR-0018 wired 5 of 6 assignment dimensions**, deferring `data_sensitivity` because "there is
   no per-change data-sensitivity signal to match on". That reasoning does not survive contact with
   the compliance cascade: a change attributed to a project inherits that project's classification
   tags, and those tags are exactly what `effectiveCompliancePolicy` already cascades from.

## Decision

### 1. Agent and connector revocations are separate per-object tables, and a revocation can only deny

Migration `0036` adds `agent_revocations (user_id, agent_id, reason)` and
`connector_revocations (user_id, connector_id, reason)`, each `UNIQUE(user_id, object_id)` with
`ON DELETE cascade` on both FKs — mirroring the existing `revocations` table's conventions.
Separate per-object tables rather than one polymorphic table, because that is what the MCP
precedent does and because a typed FK per object type is what makes cascade-on-delete correct.

**A revocation is TOTAL** for its `(user, object)` — no partial/`mode` column. Narrowing an
entitlement is what *editing the grant* is for; a revocation must be an unambiguous, auditable
"this user may not use this object at all". A `mode` column would create a second, weaker way to
express something grants already express, and two overlapping mechanisms for the same thing is how
governance systems drift.

**A revocation beats BOTH the direct and the role grant** — unlike the MCP `revocations` table,
which suppresses role-derived entitlements only. The MCP rule is right *for MCP*, where a direct
grant is itself the explicit per-user override, so the two must not fight. For agents and
connectors, entitlement composes as **UNION-MAX** (ADR-0014): if a revocation spared direct grants,
an admin still could not subtract one object from one user whenever a direct grant also existed.
The subtractive operator has to bound the whole union or it does not close the hole.

**THE INVARIANT — a revocation can only turn an allow into a deny.** The kernel consults
revocations **strictly on the allow path**, after a grant has been found:

- `evaluateAgent` checks `agentRevocations` immediately after the direct/role grant is established
  and *after* the `!grant` default-deny return, so an ungranted agent is default-denied first and
  the revocation is never even read. Denies with `ruleId: "agent-revoked"` and a trace entry
  carrying the **revocation id** (not a grant id).
- `evaluateConnector` checks `connectorRevocations` after the candidate union is found non-empty
  and before mode/object-scope. Denies with `ruleId: "connector-revoked"`.

This is the same precedence shape as the existing lead-ceiling (`ceilingTools`/`ceilingAgentIds`),
which likewise only ever narrows. Absent revocation input is **byte-identical** to the pre-0019
evaluation. Both properties are unit-tested, including the load-bearing negative: a revocation with
**no grant** still denies with the **original** `default-deny` ruleId and an unchanged rule chain —
it is never "rescued" and never even re-labelled.

**Threaded into EVERY evaluation site.** `loadAgentRevocations` / `loadConnectorRevocations` travel
beside `loadRoleAgentGrants` / `loadRoleConnectorGrants` at all six call sites: agent invoke, the
routing candidate roster, connector invoke, `decompose`, orchestration's `evaluateNodeOwner`
(dispatch/reassign), and orchestration's plan-time per-node envelope check. A revocation honoured at
direct invoke but not in orchestration would be a security hole — the same user would reach the same
agent by asking a lead to delegate to it — so the e2e proves all three paths.

Endpoints are **admin-only** (deliberately *not* in `NON_ADMIN_ROUTES`): `POST`/`GET`/`DELETE`
`/v1/users/:userId/revocations/{agents,connectors}`. The existing per-user entitlement views
(`GET /v1/users/:userId/agents` and `/connectors`) now carry `revoked` + `revocationId` +
`revocationReason`, so a deviation from role defaults reads as **"granted via role X, REVOKED"**
rather than silently vanishing — §5's visible-override discipline. Deleting the row reverses it.

### 2. Block-mode PII projects get no delta stream at all

When a request is attributed to a project whose effective PII mode is `block`, the gateway does not
open the SSE stream: the identical governed dispatch runs **fully buffered** and returns the
ordinary JSON payload, with the output check applied before a single byte leaves. There is no
partial-output window to leak through, because there is no partial output.

This is **disclosed, not silent degradation**: `streamingSuppressed: true` rides the response body
*and* the audit detail, and `/app` renders a plain-language note explaining that the project's
classification forces buffered delivery. Input-block is unchanged — still pre-call, no dispatch, no
cost. The mode is resolved only when the caller actually asked to stream, so the non-streaming path
takes no extra query, and a non-`block` project streams exactly as before.

### 3. The MCP proxy becomes project-attributable — one ledger, one PII path

**Attribution rides an HTTP header, `x-regulait-project-id`, not the JSON-RPC body.** The body is
MCP's own protocol envelope; smuggling a RegulAIt field into `params` would make the proxy a
non-conformant MCP server and would have to be re-injected at every client call site, per tool call.
`StreamableHTTPClientTransport` accepts `requestInit.headers`, so a client sets it **once** when
constructing the transport and every `tools/call` on that session is attributed — which matches how
a session belongs to a project. It also keeps attribution at the same layer as authorization (the
API key is already a header), so both are validated **before the reply is hijacked** into the MCP
transport: a malformed id is a plain `400`, a project the caller may not bill to is a plain `403`,
never a confusing JSON-RPC error.

**Metering.** An allowed, executed, attributed tool call writes exactly **one** `usage_events` row
with `object_type = 'mcp_tool'`, `operation = <toolName>`, and the server's flat
`mcp_servers.price_per_call_usd` (migration 0036) — the MCP twin of `connectors.price_per_call_usd`.
A tool call is a discrete governed unit of work, so it is priced **per call**; token costs are not
invented for it. An unpriced server yields `costUsd: null`, never a fabricated figure. Denied calls
and upstream failures bill nothing, exactly like the model and connector paths. Because
`measured`/`byUser` in the project cost rollup already span every object type, MCP spend rolls up
with no new reporting path; a `byMcpTool` breakdown is added so it is *named* rather than showing up
as an unexplained gap between the total and agent + connector.

**PII (§8.4).** `detectPII` runs on the tool **arguments** (input) and the tool **result** (output)
under the project's effective mode, with the same semantics as the other two paths: block-on-input
denies pre-call — before the approval is consumed and before the upstream is contacted, so nothing
executes, no approval is burned and nothing is billed; block-on-output **bills-and-withholds**
(honest usage row, content replaced by the withheld marker); warn proceeds with a `pii-warned` allow
audit; log records category counts in the usage detail. **Counts only, never matched substrings** —
asserted in the e2e against the audit detail, the usage detail and the reason string.

**Unattributed calls are byte-identical to before**: no usage row, no PII enforcement (there is no
project policy to enforce). That back-compat is a required, passing test.

The orchestration worker loop also passes the run's `projectId`, so a worker's tool calls land on
the same ledger as its model dispatches. This is a deliberate, visible behaviour change: a run's
project total now includes its tool calls, and `orchestration-tools.test.ts` was updated to assert
the third row explicitly rather than to hide it.

### 4. `data_sensitivity` — the 6th dimension, server-resolved

A nullable `data_sensitivity` column on `workflow_assignment_rules` (migration 0036), an ANDed
condition in `matchTemplates`, and `dataSensitivities?: string[]` on `ChangeDescriptor`. The gateway
resolves it **server-side from the attributed project's compliance classification tags** — the same
source `effectiveCompliancePolicy` cascades from — exactly as `initiatorRole` is derived from the
authenticated user's roles. `changeDescriptorSchema` does **not** accept it, so a client cannot
assert a sensitivity to route itself onto (or away from) a stricter template. No project, or a
project with no classifications, matches as **absent** — never an invented sensitivity. The
"all-null rule matches nothing" guard is extended to include it. See the ADR-0018 addendum.

### 5. ADR-0015 **A4** (per-mode policy + mode-aware audit retention) — assessed, deliberately NOT implemented

Re-examined fresh in this batch, including the cheap-looking option the brief suggested (deriving a
mode at prune time). It does not hold up, for three reasons:

- **There is still no mode dimension to derive from.** `audit_log` records
  `userId/serverId/toolName/objectType/objectId/detail/effect/ruleId/ruleChain/reason` — no mode.
  The deploy executor writes the target's mode into the **workflow instance's `context`**, not into
  any audit row, so a prune-time derivation would have to join every audit row back to a workflow
  instance. Worse, it would be *undefined for almost every row*: MCP tool calls, agent invokes,
  connector calls, approvals and membership changes have no deployment mode at all. "Mode-aware
  retention" over a table where >99% of rows have no mode is not a policy, it is a special case.

- **The only safe composition is a no-op.** Composing a per-mode floor like the compliance cascade
  means either MAX or MIN. **MIN would shorten retention** for some rows — deleting audit evidence
  earlier than a framework requires, the direct opposite of pillar 1's "full audit logging" — so it
  is not an option at any price. **MAX (longest-floor-wins)** is safe but adds nothing an admin
  cannot already achieve by raising the global floor, which is what the current implementation is.
  So the cheap version of A4 is unsafe in one direction and pointless in the other.

- **A4's real value is the other half.** Per-mode *policy* (e.g. air-gapped forbidding certain
  connector/MCP data scopes) is a change to the **policy model**, not to retention: it belongs with
  pillar 1's rule-scoping (`scope: user | role | team | fleet`), which would gain a mode-derived
  scope and a way for a rule to bind to the deploy target a change lands on. That is a dedicated
  slice with its own ADR, not a rider on a revocation/attribution batch.

**Decision: A4 stays deferred, with this sharper reasoning replacing the original "needs a schema
change" note.** Picking it up means (a) a populated mode/`deploy_context` dimension on `audit_log`
(with an honest story for pre-existing rows, which have no mode to backfill), (b) a MAX-only
per-mode retention override so retention can never be shortened, and (c) mode-scoped restriction
rules in the pillar-1 rule model. Not hacked in here.

## Consequences

- **Positive.** Pillar 1's "per-user override" is now true for all three object types, and the
  subtractive operator is provably deny-only and applies at every evaluation site — including
  orchestration, where a partial fix would have been a security hole. The §8.4 streaming leak is
  closed by construction rather than by racing the renderer, and the degradation is disclosed. All
  three governed entry points (model, connector, MCP tool) now ride **one** usage ledger and **one**
  PII enforcement path, so pillar 5's "every gateway call" and §8.4's coverage are literally true.
  The assignment matrix is complete at 6/6, with both derived dims server-authoritative.

- **Negative / trade-offs.**
  - Revocations are total; an admin who wants "read-only from now on" must edit the grant, not
    revoke. Deliberate (see above), but it is a real ergonomic cost.
  - `initiatorRole` and `dataSensitivity` both match on **names/tags**, so renaming a role or a
    compliance tag requires updating the rules that reference it — the price of keeping the kernel
    subject-free.
  - MCP pricing is flat per call and lives on the **server**, not per tool. A server whose tools
    have wildly different real costs cannot express that yet; a per-tool price would be an additive
    column when a customer needs it.
  - Attributed MCP calls in orchestration runs increase a project's measured event count. Correct,
    but it changes an existing number, so it is called out here and asserted in the tests.
  - Unattributed MCP calls remain unmetered and unenforced. That is the honest floor — there is no
    project to bill or to take a policy from — but it does mean pillar 5's coverage claim is
    precisely "every *attributed* gateway call", and the docs should say so.
  - ADR-0015 A4 remains open; the reasoning above is the record of why, and what it would take.
