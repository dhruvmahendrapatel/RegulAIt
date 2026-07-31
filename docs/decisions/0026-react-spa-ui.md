# ADR-0026 — React SPA rewrite of the product UI, phase 1 (apps/web, served at /ui)

- **Status**: Accepted
- **Date**: 2026-07-31
- **Relates to**: ADR-0012 (UIs as strict API clients — the principle survives, the
  implementation is superseded for the end-user surface), ADR-0025 (session/CSRF contract the
  SPA rides), pillar 1 (per-user governance shapes every view)

## Context

The owner's verdict on the two single-file UIs (/app, /admin): they "look random" — developers
will live in this tool daily and expect a user-friendly, well-organized, truly enterprise
product. The dependency-free single-file approach (ADR-0012) was the right bootstrap call: it
kept the UI honest (strictly an API client) and shipped eight pillars of surface with zero build
tooling. But it has hit its ceiling: no componentization, no type safety across 5k+ lines of
string-templated DOM, no design system, and every view re-renders the world.

**Decision: a full React SPA rewrite, phased.** Phase 1 (this ADR) = foundation + the complete
end-user (developer) surface at production quality. Phase 2 = the admin surface migrates into
the same shell. Until then the legacy /app and /admin remain served, untouched, as the honest
bridge.

## Decisions

### 1. Stack: React 18 + TypeScript + Vite + react-router + TanStack Query — and nothing else

- **React 18 + Vite**: the boring, auditable default; fast builds, no framework lock-in.
- **TanStack Query** for server state (caching, retries, invalidation — worth the dependency);
  **plain React context** for session state. **No redux** — the server is the source of truth
  for everything the UI shows (ADR-0012's principle, kept).
- **No Tailwind, no component library.** Styling is a hand-rolled design system: CSS custom
  properties as tokens + CSS modules. The artifact stays self-contained and reviewable, and the
  product owns its look: an 8px spacing scale, one neutral surface ramp + one primary (indigo) +
  ok/warn/danger/info semantic hues, Inter-or-system font stack, consistent radii/shadows,
  light AND dark themes that are token swaps only, WCAG AA contrast throughout. The owned kit:
  Button, Input/Select/Textarea/Field, Card, Table (sort/empty/loading), Badge, StatusDot,
  Toast, Modal/ConfirmModal (no native confirm() anywhere), Tabs, Skeleton, EmptyState,
  ErrorState, CodeBlock, IdChip (no raw UUIDs — 8-char chip, click-to-copy), Meter.

### 2. Serving model: gateway-served at /ui, dependency-free static layer

`vite build` → `apps/web/dist`; the gateway serves it at **/ui** via
`apps/gateway/src/web-serving.ts` (registered from app.ts beside the legacy shells):

- GET /ui + /ui/* only — the API surface (/v1, /auth, /mcp) can never be shadowed; the
  web-serving test proves both directions (serving works AND /v1//auth still 401).
- Hashed /ui/assets/* → immutable caching; index.html → no-cache; SPA fallback for client
  routes; path-traversal containment (resolution must stay inside dist).
- **dist absent → explicit 503 `web_bundle_not_built`** with the fix in the detail — never a
  broken blank page. Checked per-request so a build landing mid-flight starts serving.
- Same-origin API calls with `credentials: "include"` + the `x-regulait-csrf: 1` header on
  every mutation — exactly ADR-0025's contract; the SPA never holds a credential (HttpOnly
  session cookie only). A 401 mid-app routes to /ui/login with a return-to.
- Hand-rolled (~120 lines) instead of @fastify/static: a fixed small file tree doesn't justify
  a dependency, and containment/503 semantics stay fully owned and tested.
- The Docker build stage (`pnpm -r build`) now carries the web bundle, so the image serves /ui.

### 3. Phase-1 / phase-2 boundary and the legacy bridge

Phase 1 ships the developer surface at parity with the legacy /app on the SAME endpoints:
auth screens (login, TOTP step, forced password change, forced MFA enrollment, SSO buttons,
API-key exchange), app shell (grouped nav, "/" nav filter, theme toggle, user menu), Home
dashboard (role-aware), Chat (SSE streaming, routing/savings/PII/compaction badges,
attachments, thread rail), Runs (list/detail, DAG, per-node live streaming envelope,
accept/auto-advance), Workflows (intake with live route resolution, stage rail, checks, PR
links, dry-run honesty), Inbox (merge-gate evidence, delegated items, conflict arbitration,
reasons), Projects (budget/spend detail, membership), Account security.

**The honest bridge**: admins see placeholder nav groups (Identity & Access, Governance,
Integrations, Cost & Optimization, Compliance & Infra, Settings) that open the matching legacy
/admin tab, labelled "classic ↗" — never a dead end, never a pretend page. Deliberately still
legacy-only in phase 1 (each linked where it lives): the admin console, shared-context
editing + the context version graph, spend analytics beyond the dashboard cards, run
goal-decomposition + per-node tuning, BYO model keys. OIDC's `returnTo` whitelist is
server-side (`/app`, `/admin`) — phase 2 adds `/ui`; the session cookie is set either way, so
SSO users land signed-in and /ui works immediately.

### 4. Verification bar

Phase-1 quality is enforced by three layers: the gateway web-serving integration test
(serving + no-auth-bypass), the full existing gateway suite (unchanged behaviour), and a
Playwright journey against a REAL seeded gateway — sign in with the printed one-time password,
forced password change, then drive Chat (streamed mock reply), Runs, Workflows, Inbox
(a real arbitration decision), Projects, with **zero console errors asserted on every page**
and a screenshot per view.

## Consequences

- Two UI stacks coexist until phase 2 retires /app's developer surface and /admin; the SPA and
  legacy read the same API, so drift is impossible at the data layer and purely visual above it.
- apps/web introduces the repo's first bundler + UI dependencies (react, react-dom,
  react-router-dom, @tanstack/react-query; dev: vite, @vitejs/plugin-react, typescript,
  @playwright/test). Accepted deliberately for a surface developers live in.
- ADR-0012 remains accepted for what it decided then; its "single-file, dependency-free"
  implementation detail is superseded for surfaces the SPA has absorbed.

---

## Phase-2 amendment (2026-07-31) — the admin surface is native; the default swaps to /ui

- **Status of this amendment**: Accepted (phase 2 complete)

### What phase 2 shipped

Every admin group is now a set of REAL routes inside the same shell, same kit, same tokens —
the "classic ↗" bridges are gone from the nav:

- **Identity & Access**: Users (full ADR-0022/0025 lifecycle: create, rename, deactivate/
  reactivate with last-admin guards, promote/demote, one-time password issue/reset with
  one-time reveal, MFA clear with audited reason, live sessions list + revoke-all, API keys
  issue/revoke with one-time reveal, per-user MCP/agent/connector revocations), Roles (CRUD,
  holders, all four grant kinds, 409 `role_held` → force-delete with reason), Teams (members,
  409 `team_owns_shared_context` → force-delete with reason), Client access (posture form with
  honest rung labels, ADR-0024 scope rules CRUD + live effective preview, per-client config
  generator with copy, honest coverage matrix), SSO & sessions (OIDC CRUD secrets-write-only +
  the sign-in/session policy — the "five sections" of Organization stay five because sign-in
  policy lives here, beside the identity surface it governs).
- **Governance**: Rules engine (approval/data-scope/rate-limit rules across user/role/team/
  fleet × server/all with discriminant-safe forms), Simulation (the flagship precedence-chain
  visualizer: effect banner, numbered chain with outcome badges, the deciding step highlighted,
  per-rule plain-language gloss, raw JSON), Approvals queue (fleet-wide decide with reasons,
  self-review + override guards, delegation windows CRUD), Audit log (filter, full-trail CSV,
  §8.4 retention + governed prune), Workflow templates (starters, retire-with-reason,
  six-dimension assignment rules).
- **Integrations**: Agents (create with provider/tier/model/pricing, enable/disable, ADR-0023
  base system prompt, grants, per-user policy + entitlement view), Model credentials
  (write-only platform credentials, provider/env presence, waiting agents, BYO keys), Connectors
  (create with providerKind + per-call price, Snowflake's structured multi-field credential
  assembled client-side and shape-validated server-side, grants, entitlement view), MCP servers
  (registry, tool inventory, tool/server grants), Git connections (per-provider credential
  hints), PM connections (webhook secret one-time reveal), Deploy targets (per-provider fields).
- **Cost & Optimization**: the cost dashboard (fleet meters, per-project rollup with forecast +
  showback SVG charts + CSV, the explicit Unattributed bucket, initiatives, project
  create/edit), Optimization (savings-by-technique, cost + usage event ledgers, usage CSV).
- **Compliance & Infra**: Compliance profiles (upsert-by-tag CRUD, live cascade preview with
  honest enforcement labels and multi-profile composition notes, governed reclassification with
  the pending diff), Infrastructure (posture, resources with cascade floors, policies, findings
  with owned confirm modals + the persisted org approver, cert/patch/backup ledgers).
- **Settings**: Organization (the org_settings singleton in five sections, each a partial PUT,
  plain-language help), Getting started (the live checklist moved here with deep links to the
  new views; the dashboard card stays and now links here instead of the legacy console).

Charting stayed owned: the same hand-rolled SVG bar charts the legacy portal used, tokenized
for both themes. **Zero new dependencies** in phase 2.

### The swap decision

Playwright proved parity on every group (25 phase-2 journeys + the 7 phase-1 journeys, one
seeded real gateway, zero console errors per page), so the default swapped:

- `GET /`, `GET /app`, `GET /admin` → **302 `/ui`**.
- The legacy shells stay served for **one release** at **`/legacy/app`** and
  **`/legacy/admin`**, each carrying a visible "Deprecated … the product now lives at /ui"
  banner; the SPA footer links them. OIDC's server-side `returnTo` whitelist (`/app`, `/admin`)
  is untouched — both targets now bounce to /ui, so SSO users land signed-in in the SPA.
- **Removal plan**: next release deletes `/legacy/*`, `admin-portal.ts`, `app-ui.ts` and the
  `ui-theme.ts` blocks only they consume, plus the legacy-shell tests; ADR-0012's
  implementation is then fully superseded (the "UIs are strict API clients" principle lives on
  in the SPA).

### Verification (phase 2)

`pnpm -r build` green; frozen lockfile clean; gateway suite green including the new redirect +
/legacy alias tests; 32 Playwright journeys green with zero console errors and light + dark
screenshots of every admin view.
