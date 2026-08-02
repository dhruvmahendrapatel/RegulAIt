# ADR-0043 — Bring `mcp_servers.url` and `oidc_providers.issuerUrl` inside the egress guard

- **Status**: Proposed
- **Date**: 2026-08-01
- **Relates to**: ADR-0034 (custom LLM providers behind the default-deny egress guard, and its
  three amendments — this ADR resolves the two surfaces those amendments deliberately left open),
  ADR-0025/0028/0030 (auth — the OIDC login path), ADR-0023 (`mcpMode`, MCP proxy), ADR-0024
  (interception depth), ADR-0041 (BYOC/air-gapped single-tenant motion — the reason internal MCP
  servers are the *ordinary* case, not the exotic one)
- **Migration**: proposed — one nullable per-server flag on `mcp_servers`
  (`allow_private_ranges`, default **true** — see below) and reuse of the existing
  `egress_allow_hosts` table. No new allow-list mechanism.

## Context

ADR-0034 built a default-deny SSRF/egress guard (`apps/gateway/src/egress-guard.ts`) and, across
three amendments, brought every admin-typed outbound URL behind it — custom model providers,
credential `baseUrl` overrides, and the connector / git / PM connection `baseUrl`s — all through
one `egress_allow_hosts` table and one `createGuardedFetch`. The final amendment also closed the
https DNS-rebind TOCTOU with a pinned-lookup transport (`apps/gateway/src/pinned-fetch.ts`), with
no new dependency.

Two admin-typed URLs were **explicitly and repeatedly left exposed**, each time with a recorded
reason:

- **`mcp_servers.url`** — fetched by `connectUpstream(serverRow.url)` in `mcp-proxy.ts` on four
  paths. Left out because "an internal/self-hosted MCP server is a **legitimate and common**
  deployment — that is the entire point of a self-hosted tool server — so a blanket default-deny
  host allow-list here would break the *ordinary* case rather than an exotic one. It needs a
  decision about what the default posture is … not a one-line call bolted on. **Do not add the same
  check without that decision.**"
- **`oidc_providers.issuerUrl`** — fetched during OIDC discovery in `auth.ts`
  (`new URL(provider.issuerUrl)`, and `allowInsecureRequests` is enabled for `http://` issuers).
  Left out as "narrower (fires on the login path, response is parsed as OIDC discovery metadata
  rather than returned raw)" but with the recorded opinion that "**it should follow the same
  pattern**, since a self-hosted Keycloak/Authentik is the same air-gapped shape as a self-hosted
  model endpoint".

This ADR takes the posture decision ADR-0034 demanded before either could be guarded. ADR-0041's
BYOC/air-gapped-primary motion sharpens it: for our target buyer, the MCP server and the OIDC
issuer are almost always **inside their own network**. A posture that treats private ranges as
default-deny would make the guard fire on the normal case for the customer we are built for.

## Decision

**Bring both surfaces inside the SAME guard and the SAME `egress_allow_hosts` table — no second
mechanism — but with a per-surface posture that reflects how each is actually deployed. Both
inherit ADR-0034's pinned-fetch rebind fix for free.**

### 1. `mcp_servers` — a per-server private-range flag, private ranges permitted BY DEFAULT

The blanket default-deny that is correct for model/credential/connector egress is **wrong** here,
because the legitimate common case *is* a private-range address (`http://mcp.internal:9000`,
`http://localhost:3000`). Three options were considered:

- **(a) Reuse `egress_allow_hosts` as-is (default-deny host list).** Rejected as the sole
  mechanism: it makes the *ordinary* self-hosted MCP deployment require a manual allow-list entry
  per server, turning the guard into friction on the normal path — exactly what ADR-0034 warned
  against.
- **(b) A separate MCP-scoped allow-list.** Rejected: it violates ADR-0034's hard-won "one egress
  policy, one place to reason about it" invariant and doubles the audit surface.
- **(c) A per-server flag on `mcp_servers`, with private ranges permitted by default, plus an org
  toggle to flip the default to strict.** **Chosen.**

Concretely:

- **`mcp_servers.allow_private_ranges` (nullable boolean).** When it (or the org default) permits
  private ranges, that server's URL may resolve into RFC-1918 / link-local-**except-IMDS** private
  space. **`169.254.0.0/16` link-local is NEVER permitted by this flag** — the IMDS address is
  carved out unconditionally, because "reach my internal tool server" is never "reach the instance
  metadata endpoint". Every other blocked range (multicast, reserved, `0.0.0.0/8`, CGNAT) also
  stays blocked; the flag opens *ordinary private LAN ranges only*.
- **The default posture is permissive for private ranges, strict for the public internet.** A
  self-hosted MCP server on a private address Just Works; an MCP server pointed at a **public**
  internet host must be allow-listed in `egress_allow_hosts` exactly like any other outbound
  destination — because a public-internet MCP URL an admin was phished into adding is the genuine
  SSRF/exfil risk, and the private-LAN case is not.
- **An org toggle inverts the default** (`org_settings.mcp_private_ranges_default`, the singleton
  row) so a hardened deployment can require the explicit per-server flag even for private ranges —
  the same "capability off-switch above a default-deny substrate" pattern
  `custom_model_providers_enabled` uses. Off/strict is available for the buyer who wants it; the
  default respects the common deployment.
- **The guard runs at both moments**, per ADR-0034's established rule: at **write time**
  (`POST`/`PATCH` of an MCP server — a bad URL is a 400, not a surprise at first tool call) and on
  **every `connectUpstream`** (a write-time verdict is not a fact about the future — DNS moves, the
  toggle can flip, rows written before this guard exist are in the live DB). A refused connect is
  an audited failure with nothing leaving the box, surfaced on the MCP proxy's existing error
  shape.
- **`plaintext http`** stays honest: an MCP server on `http://` in a private range is normal
  (internal service, no public CA), so plaintext to a private-range MCP host is permitted under the
  flag — one deliberate opt-in, audited — while plaintext http to a **public** host still requires
  the `egress_allow_hosts` plaintext opt-in like everywhere else.

### 2. `oidc_providers.issuerUrl` — guarded at write-time + discovery-time, same table

OIDC is narrower and the recorded opinion already pointed at the answer: **apply the ADR-0034
pattern.** A self-hosted Keycloak/Authentik is the same air-gapped shape as a self-hosted model
endpoint, and `egress_allow_hosts` already expresses "this internal host is allowed" exactly.

- **Write time** — `POST`/`PATCH` of an OIDC provider runs the issuer URL through `checkEgress`;
  a non-permitted destination is a 400 `egress_blocked`, audited, before the row is stored.
- **Discovery time** — the OIDC discovery fetch (and JWKS fetch) in `auth.ts` go through
  `createGuardedFetch` against the same table, so a stored issuer that is later re-pointed, or a
  pre-existing row, is re-validated on the login path with nothing leaving the box on refusal.
- **Posture: default-deny host list (like model/connector egress), NOT the MCP private-ranges-open
  default.** The asymmetry is deliberate and worth stating: an OIDC issuer is configured **once, by
  an admin, at setup**, so requiring one `egress_allow_hosts` entry for a self-hosted issuer is
  a one-time act, not per-call friction — whereas MCP servers are added routinely and would feel
  the friction. So OIDC uses the ordinary allow-list; a self-hosted issuer (public or private) gets
  one audited host entry with the private-range / plaintext opt-in as needed.
- **`allowInsecureRequests` for `http://` issuers is now gated on the allow-list.** Today `auth.ts`
  enables it unconditionally for any `http://` issuer. Under this decision, plaintext http to an
  issuer requires the same `egress_allow_hosts.allow_plaintext_http` opt-in every other surface
  uses — so `allowInsecureRequests` is only ever set for a host an admin explicitly marked
  plaintext-ok, not for any `http://` string that was typed.

### 3. Both inherit the pinned-fetch rebind fix for free

ADR-0034's final amendment already noted: "when they do come inside the guard they inherit this
pinning for free." Because both surfaces route through `createGuardedFetch` →
`apps/gateway/src/pinned-fetch.ts`, the https DNS-rebind TOCTOU is closed on both the MCP connect
path and the OIDC discovery path without any additional work — same single transport, same
validated-address pin, same SNI/cert-verification-preserved behaviour.

## Consequences

### Easier

- The last two `EXPOSED` rows in ADR-0034's outbound-surface enumeration are closed. Every
  admin-typed URL this gateway fetches — model, credential, connector, git, PM, **MCP, OIDC** — now
  goes through one guard, one table, one transport.
- The common self-hosted-MCP deployment keeps working with **zero ceremony** on private addresses,
  which is exactly what ADR-0041's BYOC/air-gapped buyer needs — the guard fires on the risky
  public-internet case, not the ordinary internal one.
- OIDC discovery stops being an unauthenticated-plaintext-to-anything path; `allowInsecureRequests`
  becomes a deliberate per-host decision.

### Harder / given up — stated honestly

- **The MCP posture is deliberately more permissive than every other guarded surface**, and that
  is a real, named trade-off: a private-range MCP URL is reachable by default, so an admin who is
  phished into adding an *internal* MCP server pointed at a sensitive internal service (not IMDS —
  that stays blocked — but, say, an internal admin API) is not stopped by default. The mitigations
  are the IMDS carve-out, the audited write, the org strict-mode toggle, and that this is the
  *documented* posture rather than an accident. A deployment that cannot accept it flips the toggle.
- **Ports and paths remain unconstrained** on a permitted host — unchanged from ADR-0034 and
  inherited here.
- **An admin who can edit `egress_allow_hosts` or set `allow_private_ranges` is still the trust
  root** — inherent, same as ADR-0034; the value is that the act is explicit, per-server/per-host,
  and audited.
- **Response content is still not inspected** — the guard governs the destination. An MCP server's
  returned tool output and an issuer's returned metadata are out of scope here (guardrails per
  ADR-0042, and OIDC metadata is at least parsed as structured discovery rather than returned raw).
- **This ADR decides the posture; the migration and wiring are follow-up.** The `mcp_servers`
  column, the org toggle, the write-time and connect-time hooks, and the OIDC discovery-time hook
  are named but unbuilt. What is decided now is the posture question ADR-0034 blocked on:
  MCP = private-ranges-open-by-default with an IMDS carve-out and a strict toggle; OIDC = ordinary
  default-deny allow-list at write + discovery time; both inherit pinned-fetch.
