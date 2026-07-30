# ADR-0014: Role-bundled agent + connector grants (UNION-MAX, additive)

- **Status**: Accepted
- **Date**: 2026-07-27

## Context

Pillar 1's role layer (§5) already lets an admin bundle **MCP tools/servers** onto a role
(`roleToolGrants` / `roleServerGrants`) so that assigning the role confers a baseline of
entitlements, with per-user direct grants layering on top and per-user revocations subtracting
role-derived access. But the two other governed object types — **agents/models** (`agentGrants`)
and **connectors** (`connectorGrants`) — could only ever be granted directly, per user. A role
therefore could not fully express "an analyst can use these agents and these connectors,"
forcing per-user fan-out of exactly the entitlements a role exists to standardize.

The MCP role branches use a **boolean, direct-first** model: a direct grant short-circuits, and a
role grant is an alternate path to the same yes/no answer. Connectors are not boolean — a grant
carries a **mode** (read / readwrite) and an optional **object scope**. That raises a question the
tool model never had to answer: if a user has a *narrow* direct connector grant (read-only) and is
*also* assigned a role whose grant is *broader* (readwrite), what is the effective entitlement?

## Decision

Roles bundle **agents and connectors** in addition to MCP tools/servers, via two new tables
(`role_agent_grants`, `role_connector_grants`) that are **shape-identical to their per-user twins**
(`agentGrants.allowedModes`; `connectorGrants.mode` / `allowedObjects`), so a role grant can never
express *more* than a direct grant could. The kernel gains `RoleAgentGrant` / `RoleConnectorGrant`
inputs to `evaluateAgent` / `evaluateConnector`, and the gateway loads and passes them at **every**
evaluation site (direct invoke, routing-candidate roster, connector invoke, decompose, and both
orchestration plan/dispatch paths) — a role-granted agent works everywhere a directly granted one
does.

Role grants are **purely additive**, and connector entitlement is resolved **UNION-MAX**, not
direct-first:

- **evaluateAgent** consults a role grant only when no direct grant exists, but the per-user
  **tier ceiling** and the grant's **allowedModes** still narrow it — a role grant is never a way
  to exceed a direct grant or the ceiling.
- **evaluateConnector** takes the **union** of the user's direct and role-derived grants for the
  connector and allows if **any single candidate** satisfies **both** the mode and the object
  scope. A narrow direct grant can therefore **never mask** a broader role grant: a read-only
  direct grant plus a readwrite-granting role yields readwrite — the expected meaning of assigning
  a readwrite role, and consistent with default-deny (assigning a role only ever adds reach). When
  no role grants are passed there is exactly one candidate and the evaluation is **byte-identical**
  to the pre-§5 direct-only path.

**Per-user revocation of role-derived agent/connector grants is deferred.** The `revocations`
table is MCP-only today, and `evaluateAgent`/`evaluateConnector` have no revocation input, so role
grants override nothing and "revocations win" holds vacuously. Subtractive per-user override of a
role-derived agent/connector grant is future work.

## Consequences

- **Easier**: the role builder / access-preview can express a complete entitlement bundle across
  all three governed object types; assigning one role replaces per-user agent + connector fan-out.
  The roster endpoints (`GET /v1/users/:id/agents` and `/connectors`) now tag each row
  `source: "direct" | "role"` with role provenance, so Simulation shows *why* a user has access.
- **Harder / given up**: connector resolution deliberately **diverges** from the boolean MCP
  kernel (UNION-MAX vs. direct-first short-circuit). This is intentional — a direct grant must not
  be able to *reduce* what a role confers — but it means the two entitlement paths no longer read
  identically, and a future reviewer must not "unify" them without re-checking the masking
  property. The additivity guard is locked by a kernel test.
- **Follow-up**: per-user revocation of role-derived agent/connector grants (subtractive override)
  when the product needs to carve a single user out of a role's agent/connector bundle without
  unassigning the whole role.

---

## Addendum — 2026-07-30 (per-user revocation is no longer deferred)

This ADR's deferral of per-user revocation for role-bundled agent/connector grants is closed by
[ADR-0019](0019-per-user-revocation-and-full-attribution.md). `agent_revocations` and
`connector_revocations` (migration 0036) give the additive UNION-MAX composition described above a
**subtractive bound**: one agent or connector can now be taken away from one user without touching
their roles.

The one place ADR-0019 deviates from the MCP `revocations` precedent is deliberate and worth
restating here, because it is a direct consequence of THIS ADR's union semantics: an MCP revocation
suppresses **role-derived entitlements only** (a direct MCP grant is itself the per-user override,
so the two must not fight), whereas an agent/connector revocation beats **both** the direct and the
role grant. Under UNION-MAX, a revocation that spared direct grants would leave an admin unable to
subtract an object from a user whenever a direct grant also existed — it has to bound the whole
union or it does not close the hole. The invariant is unchanged in spirit: a revocation is consulted
strictly on the allow path and can only ever turn an allow into a deny.
