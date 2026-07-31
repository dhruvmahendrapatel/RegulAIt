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
