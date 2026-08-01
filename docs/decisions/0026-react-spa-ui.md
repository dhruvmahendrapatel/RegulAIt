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

> **⚠ CORRECTION (2026-08-01): the parity claim in this amendment was WRONG.** See the phase-3
> correction below before relying on anything above. In particular, "Playwright proved parity on
> every group" was not true — the Playwright suite proved that the views the SPA *had* worked, not
> that the SPA had every view. The **removal plan above is suspended**; `/legacy/*`,
> `admin-portal.ts`, `app-ui.ts`, `ui-theme.ts` and `check-ui-syntax.mjs` all stay.

---

## Phase-3 correction (2026-08-01) — the phase-2 parity claim was false; removal is halted

- **Status of this amendment**: Accepted (correction + partial closure)

### The correction, stated plainly

**The phase-2 amendment claimed parity with zero gaps. That claim was false.** It was made on the
strength of "25 phase-2 journeys + the 7 phase-1 journeys … green", but a green journey only
proves the views that exist behave; it can never prove a view is not missing. No one diffed the
capability surface of `app-ui.ts` against the SPA, and the SPA's own source contained two
comments admitting the gap that the amendment contradicted — `RunsPage.tsx` ("Goal-driven
decomposition and per-node tuning stay available in the classic app for now") and
`ProjectDetailPage.tsx` ("they migrate into this shell in phase 2", written *about* a phase 2
that then shipped without them).

**Three P0-pillar-headline capabilities existed ONLY in the legacy shell:**

| Capability | Endpoint | Pillar |
| --- | --- | --- |
| Run goal decomposition (goal → task graph) | `POST /v1/runs/decompose` | 7 — the headline of dynamic multi-agent orchestration |
| PM work-item link visibility | `GET /v1/pm/links` | 8 — "the PM tool is the source of truth" |
| The decision ledger (read **and** write) | `GET`/`POST /v1/decisions` | 4 — decisions as first-class linked records |

Deleting `app-ui.ts` on the strength of the phase-2 claim — which is exactly what the removal
plan instructed the next release to do, and what was in flight when this was caught — would have
**deleted the only working UI for three pillar-headline features**. That is the concrete cost of
the false claim, and it is why this correction is recorded loudly rather than folded into a
changelog line.

**Consequently: the legacy removal is HALTED.** `/legacy/app`, `/legacy/admin`,
`admin-portal.ts`, `app-ui.ts`, `ui-theme.ts`, `scripts/check-ui-syntax.mjs` and its CI step all
stay, and the "one release" stay of execution in the phase-2 amendment is void — the shells stay
until every gap below is closed, not until a release boundary passes.

### What this correction shipped (three of four gaps closed)

All three named gaps now have real SPA surfaces on the same endpoints, in the same kit and
tokens, indistinguishable from the rest of phase 2:

1. **Goal decomposition** (`RunsPage`) — "Describe the goal" + lead-agent pick →
   `POST /v1/runs/decompose` → the draft lands in a review editor. The response is a **proposal
   only**, so the surface states that nothing runs until *Plan run*, which is the same unchanged
   `POST /v1/runs` the template path uses — §3's distinct, reviewable human step preserved. The
   lead dispatch is real metered spend, so cost / model / tokens are shown up front (a null cost
   renders "unpriced", never `$0`), with a "retried once" badge when the first draft failed
   validation. **§5.1 "a lead can suggest, never grant" is load-bearing**: every place the
   gateway swapped an ungranted owner agent or dropped an un-entitled agent/tool/server from a
   delegation ceiling gets its own line naming what was asked for and what happened. Title and
   owner are editable per node; instructions and the DAG stay as drafted (the kernel validates on
   submit) and every already-narrowed ceiling field is carried through untouched — **the UI never
   widens what the backend narrowed**.
2. **PM work items** (`GET /v1/pm/links`, on run detail *and* workflow detail) — the card says
   RegulAIt stores the **link, not a copy**, and offers `?live=true` as an explicit act that
   resolves the PM-authoritative fields right now; a per-link `liveError` renders as
   "unreachable" rather than being swallowed. Drift and orphaned items are surfaced and
   explicitly never auto-fixed here. A **Sync now** action drives `pm-sync` through the
   connection name carried on an existing link (the backend's documented route for a non-admin);
   because that name only exists once a link does, the **first** link still cannot be created
   here and the button is disabled saying exactly that.
3. **Decision ledger** (`GET`/`POST /v1/decisions`, same two hosts) — recorded locally **always**,
   with the PM mirror best-effort on top. The four real outcomes are reported distinctly: no link
   at all, mirrored as a named work item, mirrored as a comment (no Decision type mapped), or
   mirror **failed** with the provider's error. (The first implementation of this reported
   "mirrored" whenever `pmMirror` was truthy — but `POST` returns the mirror *outcome*
   `{ok, action?, externalId?, error?}` while `GET` returns the resulting *link*, so a failed
   mirror is truthy. That would have claimed the customer's tool held a record it did not; it is
   fixed and called out here because it is the same class of error as the parity claim itself.)

PM links and decisions are **one pair of components** used by both detail pages: the backend is
one pair of endpoints over the only two parent types, so a second implementation could only drift.

The two false in-code comments are deleted. `ProjectDetailPage`'s replacement no longer says
"migrates in phase 2" — it states that shared-context editing is a **still-open gap** keeping the
legacy shell alive.

### STOPPED, not shipped — a FOURTH gap found while auditing

Auditing the rest of the surface (endpoint-by-endpoint diff of both legacy shells against
`apps/web/src`, including string-concatenated paths the naive diff misses) turned up **one more
legacy-only capability, which this correction did NOT build**:

- **Pillar 4's shared context store** — `GET`/`POST /v1/projects/:id/context`,
  `GET /v1/projects/:id/context/graph`, `POST /v1/projects/:id/context/promote`. The legacy
  editor implements read-before-write, base-revision conflict detection, a both-texts conflict
  view, rebase-vs-send-to-arbiter, the `409 base_revision_required` recovery path, artifact
  promotion, and the version graph. That is pillar 4's headline (versioned conflict resolution
  with provenance) and it is materially larger than the three above — it is a stateful editor,
  not a card. It was outside the three items this correction was scoped to, so it is reported
  rather than half-built.

Everything else diffs clean: no other endpoint or path fragment reachable from `app-ui.ts` /
`admin-portal.ts` is missing from the SPA. One legacy-only *action* was found and closed in
passing (run `pm-sync`, above); `POST /v1/runs/:id/nodes/:nodeId/dispatch` (dispatch a single
node) remains legacy-only but is a convenience over `/auto`, which the SPA has, so it is noted
rather than counted as a gap.

### What "parity" means from now on

The phase-2 standard — "the Playwright journeys are green" — is retired as a parity test,
because it cannot detect a missing view. **Parity is a capability diff, not a passing suite.**
Before any future session proposes deleting the legacy shells again, it must:

1. enumerate every endpoint and path fragment referenced by `app-ui.ts` and `admin-portal.ts`,
   **including string-concatenated ones** (`grep -ohE '\+ *"/[a-z0-9._/-]+'`), and diff that set
   against `apps/web/src`;
2. show that the remaining gap list is **empty** — today it is exactly one entry, the shared
   context store;
3. only then delete, and record the diff in the ADR.

A green e2e run is necessary and not sufficient. This paragraph exists so the next session
inherits the method, not the claim.

### Verification (this correction)

- `pnpm -r build` green (gateway `tsc`; web `tsc --noEmit` + `vite build`).
- `node scripts/check-ui-syntax.mjs` green — it is **retained**, because the template-literal
  shells it guards are retained.
- Gateway suite **801 → 804**, 63 files, all green. The +3 are the audit-filter and
  per-tool-pricing tests below; **no test was removed** (the two legacy-shell assertions deleted
  in the halted removal are restored).
- Playwright **32 → 36 journeys**, all green, zero console errors — decomposition
  draft → review → edit → accept (asserting the created run carries the human's edit, not the
  lead's wording, and that a too-short goal is refused before any request is made), PM links +
  sync + live read + a decision recorded on run detail, and both cards present on workflow
  detail.

### Also in this correction: the two phase-2 debts that were genuinely just degraded

Independent of the parity failure, the two views phase 2 shipped gracefully degraded (because
their backends landed the same hour) are now wired:

- **Audit log — A4's deploy-mode dimension.** `audit_log.deploy_mode` (ADR-0027 §2a) was written
  by the deploy/rollback executors and target-pinned infra mutations but had **no query
  surface**: `GET /v1/audit` accepted only `userId`. Added
  `?deployMode=hosted|byoc|air_gapped|unknown` to `/v1/audit` and `/v1/audit.csv` (one shared
  WHERE, so the export always matches the screen) plus a `deployMode` CSV column.
  **The honesty requirement is the design**: `unknown` maps to `deploy_mode IS NULL` and is an
  explicit, equal option — never an "other", never a default-to-hosted. ADR-0027 states those
  rows are un-backfillable by design (two real things: actions that were never deploy-scoped, and
  every row written before migration 0044), so nothing infers a mode. The table renders them as a
  plain "unknown" with a tooltip naming both possibilities; the card states in prose that unknown
  is not a fourth mode and not a synonym for "hosted", and repeats ADR-0027's disclosed limit
  that per-mode retention only differentiates post-0044 rows; the CSV writes the literal word
  `unknown` rather than an empty cell an auditor could misread; and filtering to a mode with no
  rows says *why* rather than implying the trail is broken.
- **MCP servers — O10 per-tool pricing.** The backend existed exactly as ADR-0027 §7 describes
  (`PATCH /v1/servers/:serverId/tools/:toolName/price`, `{ pricePerCallUsd: number | null }`, on
  the inventory row, audited, resolved tool-first with the server flat price as fallback). The
  tool table now names which of the three states each row is in — **override / inherited /
  unpriced** — and takes an in-place edit, where a blank field clears the override back to
  inheritance rather than pricing the tool at zero. The **server flat rate is read-only**:
  `createServerSchema` takes `name` + `url` only, so no API sets it and the UI does not pretend
  otherwise.

## Phase-4 amendment (2026-08-01) — the two END-USER residuals, closed

The phase-3 correction ended with a method rather than a claim: **parity is a capability diff,
not a passing suite.** Running that diff again — this time verb-aware, because a path-only diff
cannot tell a surface that only *reads* an endpoint from one that *manages* it — turned up two
residuals the phase-3 pass had not counted, and both were **end-user (non-admin) surfaces**. In
a product whose pillar 5 is per-project cost attribution and whose pillar 6 is token
optimization, neither omission is cosmetic: the developer who *generates* the spend could not see
any of it, and the developer whose key ADR-0024 is written about could not manage that key.

| Residual | What the SPA had | What was missing |
| --- | --- | --- |
| Own spend & savings | `cost-events` / `usage-events` referenced only from the ADMIN `OptimizationPage` | any non-admin surface at all |
| BYO model keys | `ChatPage` READ `/v1/users/:id/model-credentials` for its "your key vs platform" badge | add / replace / remove — management existed only in the admin `ModelCredentialsPage`, which even told users to "add their own keys from the workspace → Account", a page that did not exist |

### 1. `/ui/spend` — Spend & savings, self-scoped by construction

A Workspace route (nav, after Projects) and the destination of Home's non-admin "My spend" card.

**The governance question was settled from the endpoints, not assumed.** `GET /v1/cost-events`
and `GET /v1/usage-events` are both in `NON_ADMIN_ROUTES`, and both compute
`userId = req.authCtx.isAdmin ? q.userId : req.authCtx.userId` — a non-admin's `?userId=` is
**not trusted**, it is overwritten with self, and a bootstrap session with no user identity is
refused outright (`bootstrap_has_no_cost_history`). So the per-user filtering the page needs
already existed and is enforced server-side; no backend change was required and none was made.

The case that needed care was the **admin**, for whom those same endpoints default to
**org-wide**. The page therefore always sends `?userId=<me>` and says on the page that the
organisation-wide rollup is the admin Cost dashboard, elsewhere. A "My spend" page that quietly
showed an admin the whole org would be the same class of dishonesty this ADR keeps correcting.

What it shows: measured spend / tokens / measured savings / estimated savings; spend over the
last 14 days (days with no call render **empty rather than dropped** — a quiet day is a real
day); spend by project (rows link to that project's budget, forecast and showback), by agent, by
connector; the recent-invocations table; and a Savings tab with per-technique totals and an
explicit **estimated-vs-measured** explanation so the two numbers are never added together.
Unpriced calls render `unpriced`, never `$0`. Unattributed spend is its own named bucket.

One addition over the legacy page: a **"Key used"** column reading `detail.credentialSource`
off the ledger row — which credential *actually* served each call (`your key` / `platform` /
`none`). It is measured, never inferred from which keys happen to be stored. That column turns
out to matter for the second surface.

Name lookups come from the caller's OWN grants (`/v1/users/:id/agents`,
`/v1/users/:id/connectors`) — the admin catalogs are 403 for a developer and are never touched.

### 2. `/ui/account` → Your model keys — self-service BYO credentials

List your stored per-provider credentials, add or rotate one, remove one. It shares ChatPage's
`["my-credentials", userId]` query key, so that badge updates without a reload.

**A stored secret is never displayed or echoed.** The backend keeps AES-256-GCM ciphertext and
no endpoint returns plaintext, so the card shows provider + presence + endpoint + when it was
set, and nothing else; the input is cleared the moment the write succeeds.

**Key custody is stated, not discovered by failing.** With ADR-0024's `key_custody_enforced` on,
`POST /v1/users/:id/model-credentials` answers **409** and dispatch skips stored user rows
entirely. When custody is known to be on, the add control is **withdrawn rather than offered and
broken**, an explanation states the ADR's exact semantics (org holds the vendor keys; existing
rows are *kept, not deleted, and inert*; they come back exactly as stored if an admin lifts it),
and stored rows are badged `stored · inert` — never "in use".

**The honest limitation, recorded rather than papered over.** `GET /v1/interception/settings` is
**admin-only, deliberately** (writing the posture is not a developer's business), so an admin
reads the flag up front while a **developer cannot** — they can only learn it from the 409. The
card therefore does two things instead of guessing: it never tells a developer their stored key
*is being used* (presence reads as "stored", not "active"), and it points at the one honest
answer available to them — the per-call `Key used` column on Spend & savings, which is measured.
On the 409 the card flips into the same explained state an admin sees, so the refusal teaches
rather than erroring. **A one-line backend change would remove the asymmetry** — surfacing
`keyCustodyEnforced` (a boolean the developer is already subject to, and which leaks no
configuration) on `GET /v1/me` beside the existing size ceilings. That was out of this change's
territory and is left as a named, deliberate follow-up, not a silent gap.

`ChatPage`'s own "your key" badge has the same blind spot for the same reason and is **not**
fixed here — recorded so the next session finds it named rather than rediscovering it.

### 3. Found by the same diff, closed in passing: connector + MCP-tool project spend

`GET /v1/projects/:id/costs` returns `byConnector` and `byMcpTool` — both were **typed** in
`apps/web/src/api/types.ts` and **rendered by neither** `ProjectDetailPage` nor the admin cost
rollup, though the legacy drill-down showed both. Because ADR-0019/0024 put connector and
MCP-tool spend on the *same* ledger, that spend was already inside every measured total while
the visible breakdown only accounted for agents — the "unexplained gap between provider invoices
and project totals" ADR-0024 §1 exists to prevent. Both rollups now name them. An endpoint-level
diff cannot see this class of gap (same endpoint, ignored fields); it was found by reading the
legacy drill-down against the SPA's.

### The residual list, measured — NOT empty

Re-running the diff on this branch (`grep` every quoted/backticked path fragment out of
`app-ui.ts` + `admin-portal.ts`, normalise interpolations to `:x`, pair each with the verb of
its `get`/`post`/`patch`/`put`/`del` helper, and diff against every `api.*` / `fetch` /
`ssePost` / `downloadCsv` call in `apps/web/src`) gives **148 legacy capabilities vs 174 SPA
capabilities**, with:

- **Tier 1 — path referenced nowhere in `apps/web/src` (4, one capability):**
  `GET`/`POST /v1/projects/:id/context`, `GET /v1/projects/:id/context/graph`,
  `POST /v1/projects/:id/context/promote` — **pillar 4's shared context store**, unchanged from
  the phase-3 correction's fourth gap. Still the reason the legacy shells stay.
- **Tier 2 — path present but that verb not seen via `api.*` (1):**
  `POST /v1/infra/findings/:id/remediate`, verified **by hand** to be a false positive — the SPA
  reaches it through `InfrastructurePage`'s `propose(title, body, path)` helper, which hides the
  verb from the regex. Recorded because the tier exists precisely so this class is checked
  rather than assumed.
- The two residuals this amendment closed (`GET /v1/users/:id/connectors` for a non-admin, and
  `POST /v1/users/:id/model-credentials`) no longer appear.

**So: parity is still NOT reached, and the legacy shells still stay.** The remaining gap is one
capability — the shared context store — and it is the same one phase 3 named. This paragraph
says so explicitly because three previous passes claimed parity they had not measured.

The diff also has a known blind spot, now demonstrated by item 3 above: it compares *endpoints*,
so a capability that is a **field of a response the SPA already fetches** is invisible to it. The
next session should treat "same endpoint, unrendered field" as a category to check by reading,
not by grepping.

### Verification (this amendment)

- `pnpm -r build` green (gateway `tsc`; web `tsc --noEmit` + `vite build`).
- Playwright **36 → 39 journeys**, all green, **zero console errors**, own scratch database
  (`regulait_wt_enduser`). The three new journeys drive the NON-ADMIN persona: her own Spend &
  savings (including the *negative* assertions that a non-admin sees no org-wide note and no
  Cost dashboard link); model keys add → listed as present-but-never-revealed (asserting the
  secret appears nowhere in `page.content()` and the field is cleared) → removed; and, from the
  admin journey, key custody flipped on with **both** readers proven — the admin from the
  proactive settings read, a real non-admin (avery, second browser context) from the 409 alone,
  with her rejected key never echoed. The toggle is restored at the end.
- One **pre-existing flaky assertion** was found and fixed while doing this: after opening the
  cost rollup, phase2 asserted an unscoped `getByText("Budget vs actual")`, which was matching
  the **fleet table's column header** while the rollup query was still in flight. It passed only
  by winning that race; any change to bundle size or timing turns it into a strict-mode
  violation. It is now scoped to the rollup card, which is what it always meant to assert. A
  baseline run at `d711a98` (36/36 green) confirmed the flake was pre-existing and not caused by
  this change.
- Gateway suite **unchanged** — no file under `apps/gateway/src` was touched by this amendment.
