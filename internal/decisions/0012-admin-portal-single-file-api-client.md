# 0012 — Admin portal MVP: a dependency-free single-file web app, strictly an API client

Date: 2026-07-25
Status: Accepted

## Context

GOVERNANCE_LAYER_SPEC §6 names eight functional admin-portal surfaces (Users & Roles, Agent /
Connector / MCP governance, Policy & Rules, Audit, Approvals Queue, Simulation), §10.4 makes
the cost dashboard a first-class portal surface, and §5's policy-as-code rule requires every
governance object to be readable/writable via API — the UI can never be the sole writer. The
repo is TypeScript/Fastify with zero frontend toolchain; every capability the portal needs
already exists as a REST endpoint (a handful of admin list endpoints were missing and are
added alongside this ADR).

## Decision

1. The portal MVP is **one dependency-free HTML+JS file served by the gateway** at
   `GET /admin` (auth-exempt static shell, zero data inside). No framework, no build step, no
   new package.
2. The portal is **strictly a client of the public REST API**: the admin pastes an API key
   (held in memory only, never persisted), and every read/write goes through the same
   endpoints any script would use. No portal-only routes that mutate state.
3. Gaps found while building the portal are fixed as **API endpoints first** (e.g.
   `GET /v1/users`, `GET /v1/servers`, rules list endpoints), keeping API parity by
   construction.
4. A framework-based SPA (and SCIM status, SIEM export, previews of unsaved policy, bulk
   actions) is deferred until the portal outgrows a single file — the API surface it would
   sit on is the part that must stay stable.

## Consequences

- §5's API-parity requirement holds by construction; the portal can be deleted without losing
  any capability.
- The single file trades polish for zero toolchain: no React/Vite dependency tree to govern
  in a governance product's own supply chain (a deliberate bootstrap-phase choice, mirroring
  ADR-0009's hand-rolled-kernel bias).
- Deferred surfaces are listed in STATE.md; the §6 panel names are used verbatim as tab names
  so coverage gaps stay visible.
