# ADR-0053 — Public API: an OpenAPI 3 spec generated from the gateway routes, a deprecation policy, and generated Python/TS/Java SDKs

- **Status**: Proposed
- **Date**: 2026-08-01
- **Relates to**: ADR-0009 (TypeScript/Fastify stack — the routes this spec is generated from),
  ADR-0020 / ADR-0024 (the provider-shaped compat surfaces — a public contract customers already
  build against), ADR-0025 (API-key auth — the auth this API uses unchanged), ADR-0012
  (single-file API client / dependency-scrutiny posture), the standing **provider-agnostic**
  principle in CLAUDE.md
- **Anchors (already built)**: the gateway already exposes versioned `/v1` routes with per-route
  schemas; API keys are already a first-class credential (`Authorization: Bearer`, ADR-0025); the
  Anthropic/OpenAI-shaped interception surfaces (ADR-0020/0024) are *already* a public contract
  third-party IDEs and SDKs bind to.

## Context

RegulAIt's gateway already has a large, versioned HTTP surface, and parts of it are already public
in the strongest sense: ADR-0020/0024's provider-compatibility endpoints exist specifically so that
off-the-shelf Anthropic and OpenAI client SDKs — code we do not own — can point at the gateway and
work. That is a public API contract whether we call it one or not. Every enterprise buyer will also
want to automate RegulAIt itself (provision users, read the cost ledger, drive workflows, pull the
audit log) from their own systems.

What is missing is the *contract as a first-class, versioned, documented artifact*:

- there is no published OpenAPI spec, so integrators reverse-engineer routes from behavior;
- there is no deprecation policy, so any route change is a silent breaking change for whoever built
  against it;
- there are no supported client SDKs, so every integrator hand-rolls an HTTP client and its bugs.

The forces:

1. **The spec must not drift from the code.** A hand-maintained OpenAPI document is wrong the day
   after it is written. Fastify routes already carry schemas; the spec must be *generated* from
   them, so the code is the single source of truth.
2. **Auth is already solved.** ADR-0025 made API keys first-class for programmatic access. The
   public API introduces **no new auth** — it documents the existing one.
3. **Not every route is public.** The gateway has admin-only and internal routes (`NON_ADMIN_ROUTES`
   is an existing related concept). Publishing all of them as a stable, SDK-backed contract would
   freeze internal surfaces we need to change freely.
4. **SDK generation must not become a vendor lock or a supply-chain liability** — consistent with
   the provider-agnostic principle and ADR-0012's dependency scrutiny.

## Decision

**Generate an OpenAPI 3 spec from the Fastify route schemas, mark an explicit public/stable subset,
publish a deprecation policy on it, and generate Python / TypeScript / Java SDKs from that spec —
all authenticated by the existing API keys.**

### 1. OpenAPI 3 spec generated from the routes (single source of truth)

The gateway's routes already declare request/response schemas. A build step emits an OpenAPI 3
document from those schemas (via the Fastify swagger/OpenAPI integration over the existing schema
objects), so the spec is a *derivation* of the code, not a parallel document that can disagree with
it. The spec is produced in CI and checked in as a build artifact; a route whose schema changes
changes the spec in the same commit, which makes a breaking change *visible in review* rather than
discovered by an integrator.

### 2. A marked public/stable subset — not the whole surface

Each route carries a stability tag: `public-stable`, `public-beta`, or `internal`. Only
`public-stable` and `public-beta` appear in the published spec and the SDKs; `internal` (and the
admin-only routes that already exist) are excluded from the public artifact and carry **no
compatibility guarantee**. This lets internal surfaces keep moving while the published contract
stays stable. The tag lives next to the route so it is reviewed with the route, not in a separate
registry that drifts.

### 3. Versioning and deprecation policy

- **Major version in the path.** `/v1` already exists; a breaking change to a `public-stable` route
  requires a new major (`/v2`), never a silent change to `/v1`. Both run side by side during the
  window.
- **Additive changes stay in-major.** New optional fields and new routes are non-breaking and ship
  within a major.
- **Deprecation window.** A route or field marked deprecated emits an RFC-8594 `Deprecation` and
  `Sunset` header and is listed in a machine-readable deprecation section of the spec, for a
  published minimum window (proposed: **12 months** for `public-stable`) before removal. `public-beta`
  carries a shorter, clearly labeled window and may change with notice.
- **Changelog.** Every spec release carries a diff-derived changelog, generated from the two spec
  versions rather than written by hand, so no deprecation is undocumented.

### 4. Auth: the existing API keys, unchanged

The public API authenticates with the ADR-0025 API keys (`Authorization: Bearer <key>`). No new
credential type, no separate OAuth app model for the API itself. Every call through the public API
is still a governed gateway call — it passes the same policy kernel, metering (`usage_events` /
`cost_events`), and audit path as any other request. **The public API is a documented front door to
the governed gateway, not a bypass around it.** This is the critical invariant: exposing a route in
the spec grants nothing that entitlement did not already grant (the same "exposure ≠ entitlement"
principle ADR-0024 pinned for the compat surfaces).

### 5. Generated Python / TypeScript / Java SDKs

SDKs are **generated from the OpenAPI spec** (via openapi-generator or an equivalent), not
hand-written, so they track the spec by construction and adding a language is a generator target,
not a rewrite. Python and TypeScript cover the two dominant integration ecosystems; Java covers the
enterprise/JVM buyer. Each SDK is versioned to the spec version it was generated from and republished
per release. The generator and its output are pinned and reviewed under ADR-0012's dependency
posture — generated client code in an integrator's environment is a smaller surface than a bespoke
runtime dependency, and choosing generation over a hand-rolled client keeps us off any one HTTP-client
ecosystem, consistent with the provider-agnostic principle.

### 6. The compat surfaces are acknowledged, not re-specified

ADR-0020/0024's Anthropic/OpenAI-shaped endpoints already conform to *those vendors'* published
schemas by design — that is the whole point of interception compatibility. They are documented in
the public spec as compatibility surfaces with a pointer to the upstream schema they mirror, rather
than re-specified here. RegulAIt's *own* management API (users, roles, projects, costs, workflows,
audit) is the net-new public surface this ADR primarily governs.

## Consequences

### Easier

- Integrators get a real contract, real SDKs, and a real deprecation guarantee, instead of
  reverse-engineering behavior — a direct time-to-integrate improvement for the enterprise buyer.
- The spec cannot silently drift from the gateway, because it is generated from the same schemas
  the gateway serves; a breaking change is visible in the diff at review time.
- Adding an SDK language is a generator target, not a hand-written client.

### Harder / given up

- The stability tag is a commitment: once a route is `public-stable`, the 12-month deprecation
  window applies, so tagging is a decision reviewers must take seriously rather than a default.
- We take on SDK release plumbing (three languages, versioned, per release) and the generated-code
  quality that comes with openapi-generator — occasionally worse ergonomics than a hand-written
  client, accepted in exchange for zero drift.
- The generated spec is only as good as the route schemas; any route with a loose or missing schema
  produces a weak spec entry, which turns "tighten the schemas" into a prerequisite rather than a
  nice-to-have.

### Follow-up

- The stability-tag mechanism, the CI spec-generation + changelog step, and the SDK release pipeline
  are specified here but not built.
- An audit of existing `/v1` routes to assign stability tags (and to tighten any under-specified
  schemas) is a prerequisite to publishing.
- Rate limiting and quota semantics for the public API compose with the existing gateway limits and
  the pillar-5 budget enforcement; documenting them in the spec is follow-up.
