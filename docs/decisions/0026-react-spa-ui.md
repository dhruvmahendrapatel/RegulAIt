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

---

## Amendment (2026-08-01) — the shared context store is native; the fourth legacy-only gap is closed

- **Status of this amendment**: Accepted
- **Scope**: pillar 4's shared context store only. This amendment deliberately does **not**
  re-assert overall parity — see "What is still legacy-only" below.

### Why this amendment exists

Phase 2's swap decision said "Playwright proved parity on every group". That claim was about the
**admin groups**, and it was read afterwards as a claim about the whole product. It was not:
phase 1's own text (§3) had already listed five capabilities as deliberately legacy-only, phase 2
closed exactly one of them (the admin console), and the remaining four were never tracked
anywhere the swap decision could see them. Two successive amendments then asserted parity without
enumerating anything. Asserting parity is not evidence of parity.

### The capability-diff method (used here, and required from now on)

A parity claim is only admissible with the diff attached. The method:

1. **Enumerate the legacy side mechanically, not from memory** — the shell's own page list
   (`PAGES` in `app-ui.ts`, the tab list in `admin-portal.ts`), then, within the page under
   review, every rendered control and every endpoint call site in its source.
2. **Map each item to a concrete SPA route + control** that a user could reach, or record it as a
   residual. "The SPA can do that somewhere" is not a mapping; a route and a control is.
3. **Publish the residual list**, including items outside the scope of the change being made.
   A change may close residuals; it may never quietly drop them from the list.
4. **Prove the mapped items by execution**, not inspection: a Playwright journey that drives the
   real control against a real gateway, including the failure paths.

### Diff 1 — the shared context store (`app-ui.ts` §"projects" + §"context graph")

Every legacy control, and where it now lives. SPA routes: `/ui/context` (workspace index),
`/ui/projects/:id/context` (the store), `/ui/projects/:id/context/graph` (the version graph).

| Legacy control (`app-ui.ts`) | SPA equivalent | Status |
| --- | --- | --- |
| per-key row: key, `rev N`, `from artifact`, `N awaiting arbiter`, provenance (user · team · age), collapsible current text | entry row on `/projects/:id/context` | closed |
| `history` drawer → `GET ?key=&history=true`, per-revision accepted / awaiting-arbiter / rejected, base revision, author, team, text | history drawer, same endpoint, same three states | closed |
| pending banner "N revisions awaiting arbiter" + arbiter name + Inbox link | "Conflicting revisions awaiting a decision" card, one row per retained revision | closed, richer |
| `+ add context` — new-key editor (key input, textarea, base-revision explanation) | "Add context" modal | closed |
| `✎` edit — **fetches the current revision before opening** | "Edit" — same read-before-write on open | closed |
| submit-time re-read; both-texts conflict card when the key moved | conflict view with labelled *yours* / *theirs* panels and an explicit "How this resolves" panel | closed, clearer |
| `Rebase on rev N and submit` | `Rebase on rev N & save` | closed |
| `Submit against my stale base` (→ arbiter) | `Escalate to <arbiter name>`; disabled with the reason when the project has no arbiter (legacy surfaced a raw `422 no_arbiter` after the fact) | closed, safer |
| `409 base_revision_required` recovery into the same conflict view | identical recovery path | closed |
| toast distinguishing an accepted revision from a conflicting one | persistent outcome banner (accepted vs "retained, NOT current, with <arbiter>") plus the toast | closed, harder to miss |
| `Promote to shared context` on a completed instance's artifact; initiator-only; `403 not_the_artifact_owner` message | promote card + consequence modal; the button is disabled with the initiator's name when it isn't yours; the 403 still messaged | closed, richer |
| Context Graph: project picker, one column per key, revisions top→bottom, lineage edges, conflict side-lane, legend, keyboard-focusable nodes, detail panel, `#/context-graph/<id>` deep link | `/projects/:id/context/graph` (deep link is the route itself), `/ui/context` is the picker; fork edges now detour around intervening rows instead of drawing a straight line that reads as a chain; "rejected by the arbiter" is a distinct state from "awaiting the arbiter" | closed, more honest |

**Residual for the context store: none.** One deliberate navigation difference: legacy stacked
every project's store on one Projects page; the SPA scopes one store per project and puts the
cross-project view at `/ui/context`. Same capability, fewer things on screen at once.

### Diff 2 — the shell level, as observed on this branch

`PAGES` in `app-ui.ts` vs the SPA's Workspace nav:

| Legacy page | SPA | Status |
| --- | --- | --- |
| Playground | `/ui/chat` | closed (phase 1) |
| Runs | `/ui/runs`, `/ui/runs/:id` | closed (phase 1) except goal-decomposition + per-node tuning |
| Workflows | `/ui/workflows`, `/ui/workflows/:id` | closed (phase 1) |
| Inbox | `/ui/inbox` | closed (phase 1) |
| Projects | `/ui/projects`, `/ui/projects/:id` | closed (phase 1) |
| **Context Graph** | `/ui/projects/:id/context/graph` | **closed by this amendment** |
| Spend & savings | — | **residual** |
| Settings (end-user BYO model keys) | — | **residual** |

### What is still legacy-only (do not delete `/legacy/*` yet)

Phase 1 §3 named five deliberately-legacy-only capabilities. Four remain tracked; this change
closes one of them:

1. the admin console — **closed in phase 2**;
2. shared-context editing + the context version graph — **closed here**;
3. spend analytics beyond the dashboard cards (the end-user "Spend & savings" page: their own
   usage-event and cost-event ledgers, per-project drill-down) — **still legacy-only on this
   branch**; no SPA route calls `/v1/usage-events` or `/v1/cost-events` outside the admin-only
   Optimization page;
4. run goal-decomposition + per-node tuning — **still legacy-only on this branch**; nothing under
   `apps/web/src` references the decompose endpoints;
5. BYO model keys for an end user — **still legacy-only on this branch**; the only credential
   surface in the SPA is the admin-only Model credentials page.

Items 3–5 are being closed on a parallel branch. **Legacy removal is unblocked for the context
store specifically, and for the product only once that branch has landed beside this one and the
Diff-2 table has no residual rows.** This branch alone does not license deleting `app-ui.ts`,
`admin-portal.ts` or the `/legacy/*` routes. Whoever removes them must re-run Diff 2 on the
merged tree and paste the result — an empty residual list is the precondition, not a formality.

### Verification (this amendment)

Everything below was executed on this branch against its own scratch database
(`regulait_wt_context`, dropped and recreated), not inferred:

- `pnpm install --frozen-lockfile` clean; `pnpm -r build` green; **zero new dependencies**.
- Gateway suite: **826 passed / 826**, on a virgin database. No gateway, package, migration or
  infra file was touched by this change, so the count is unchanged by construction.
- Playwright: **41 journeys green**, zero console errors on every page, light + dark screenshots.
  32 were the pre-existing phase-1/phase-2 journeys; 9 are new and drive the store end to end as
  the seeded **contributor** persona (not an admin, so §9.2's role gate is genuinely exercised):
  read + provenance + history; edit-and-save; **a literal `409 base_revision_required` returned by
  the gateway** — forced by stubbing exactly one pre-read so the client believes a key it is about
  to create does not exist, with the 409 asserted on the wire rather than inferred from the UI —
  **resolved by rebase**; a second, independent conflict where a real out-of-band revision lands
  under an open edit so the submit-time re-read catches it and sends nothing, **resolved by
  escalation to the named arbiter**, asserting afterwards that the store did *not* move and the
  retained revision is queued for the arbiter; artifact promotion, asserting the reported words
  match the outcome object the gateway returned (`accepted` / `conflict`), not merely that the
  call did not throw; and the version graph, selecting the escalated revision and checking it
  reports "based on rev 2 · awaiting the arbiter".
- Two pre-existing Playwright assertions were made unambiguous (`getByText("Members")` and
  `getByText("Budget vs actual")` became strict-mode-safe once a project tab strip and a rollup
  section shared those words). No behaviour changed.

Two operational notes for whoever re-runs this:

- The gateway suite must be pointed at a **virgin** database. Most files share `DATABASE_URL`
  directly, so pointing it at a database that has already been seeded (the Playwright scratch
  database, for instance) fails hundreds of tests for reasons that have nothing to do with the
  change under test.
- A handful of test files create fixed-name scratch databases (`regulait_seed_test`,
  `regulait_wt_stream`, …) and drop them `WITH (FORCE)`. Two agents running the gateway suite
  against the same Postgres at the same time therefore terminate each other's connections. A
  failure in exactly those files, that passes when the file is re-run alone, is that collision —
  not a regression.
