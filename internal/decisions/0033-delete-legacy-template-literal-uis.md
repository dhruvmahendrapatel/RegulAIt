# ADR-0033 — Delete the two legacy template-literal UIs; parity means a mechanically-enforced capability diff

- **Status**: Accepted
- **Date**: 2026-08-01
- **Relates to**: ADR-0012 (the single-file UIs being deleted), ADR-0026 (the SPA that replaces
  them), ADR-0031 (CSP)

## Context

ADR-0012 shipped the product's first two UIs as single-file, dependency-free, template-literal
HTML strings inside the gateway: `apps/gateway/src/admin-portal.ts` (admin console) and
`apps/gateway/src/app-ui.ts` (end-user app), sharing `apps/gateway/src/ui-theme.ts`. ADR-0026
replaced them with a real React SPA (`apps/web`, served at `/ui`), and its phase-2 amendment
swapped the default surface: `/`, `/app` and `/admin` became 302s to `/ui`, and the two shells
were parked at `/legacy/app` and `/legacy/admin` "for one release".

**That removal was attempted once and reverted** (`eb4883d` deleted, `95a3bc1` reverted). The
revert is the whole reason this ADR exists, so it is stated plainly:

> ADR-0026's phase-2 amendment asserted the SPA had reached "parity, zero gaps". The evidence
> offered was "the Playwright journeys are green". **A green journey proves the views that exist
> behave; it can never prove a view is not missing.** Capabilities that were still legacy-only
> were therefore deleted along with the only UI that exposed them.

**Eleven legacy-only capabilities were eventually found, across two separate audits:**

- **Audit 1 — five** (ADR-0026's phase-3 correction and its two follow-on amendments): goal
  decomposition `POST /v1/runs/decompose` (pillar 7's headline), PM work-item link visibility
  `GET /v1/pm/links` (pillar 8), the decision ledger `GET`/`POST /v1/decisions` (pillar 4), the
  shared context store `/v1/projects/:id/context*` (pillar 4's headline — a stateful editor with
  base-revision conflict detection, rebase/escalate and a version graph), and the end-user
  self-service residuals (`/v1/users/:id/model-credentials`, the non-admin connector-spend read).
- **Audit 2 — six more** (PR #89, `a8d2ce9`), found only once the diff was made *mechanical*:
  rule deploy-mode scoping `PATCH /v1/rules/:kind/:ruleId/deploy-mode`; revocation narrowing
  `PATCH /v1/revocations/:kind/:revocationId/scope`; and a four-part hole in the run-detail
  operator console — manual streaming node dispatch
  `POST /v1/runs/:runId/nodes/:nodeId/dispatch`, the `reassign_node` event, the `node_submitted`
  event, and the per-node instruction override that rides the `/auto` `inputs` map. Together
  these meant the SPA could drive a run only in fully-automatic mode: `app-ui.ts` was the only UI
  that could rescue a stranded node.

Both sets are now closed. Audit 2 also promoted its extractor into the repo as
`scripts/parity-diff.mjs`, enforced by `apps/gateway/src/legacy-ui-parity.test.ts` under
`pnpm -r test`.

## Decision

### 1. The corrected definition of parity — the one that must be used from now on

**Parity is a capability diff across three dimensions, computed mechanically from source, not a
nav walkthrough and not a naive grep.** All three are required, because each catches a class the
others miss:

| # | Dimension | The hole it catches |
| --- | --- | --- |
| 1 | **Endpoint shapes** — `METHOD /path/:p`, resolved through string concatenation, template literals and ternaries | A whole missing view |
| 2 | **Run event kinds POSTed** to `/v1/runs/:p/events` — keyed on `kind: "x"` as a *posted property*, never on `ev.kind === "x"` (a timeline *read*) | A UI that can call the endpoint and still not perform the verb (`reassign_node`) |
| 3 | **Request-body keys**, per endpoint, on the run-driving surfaces | A payload-level hole — same endpoint, missing capability (`/auto`'s per-node `inputs` map) |

Two rules make the result trustworthy rather than reassuring:

- **A "silent zero" must fail.** A broken extractor reports parity by finding nothing at all, so
  both inventories carry a floor assertion.
- **Every inference is printed, never hidden.** A path reaching the API client through a variable
  or a local helper cannot be resolved at its call site. Those are credited to the SPA by an
  orphan-literal fallback that runs on the coverage side ONLY — so it can only ever *remove* a
  reported gap, never invent one — and each is listed with `~` for hand audit.

Explicitly retired as parity tests: "the Playwright journeys are green" (phase 2's standard —
cannot detect a missing view) and `grep`-for-the-path (misses dimensions 2 and 3 entirely, and
misses concatenated paths in dimension 1).

### 2. The evidence, at the moment of deletion

`node scripts/parity-diff.mjs` on `origin/main` at `a8d2ce9`, immediately before the deletion:

```
legacy: 161 endpoint shapes, 7 run event kinds
spa:    183 endpoint shapes, 7 run event kinds

LEGACY-ONLY ENDPOINTS (0):            (empty)
LEGACY-ONLY RUN EVENT KINDS (0):      (empty)
LEGACY-ONLY REQUEST BODY KEYS (0):    (empty)

SPA COVERAGE CREDITED BY INFERENCE, NOT A RESOLVED CALL (3) —
  ~ POST /v1/infra/findings/:p/remediate  [InfrastructurePage.tsx:265]
  ~ POST /v1/runs/:p/pm-sync              [PmAndDecisions.tsx:81]
  ~ POST /v1/workflows/instances/:p/pm-sync [PmAndDecisions.tsx:82]

PARITY: the SPA covers every capability the legacy UIs expose.
```

Exit status 0. Both event-kind inventories are the same seven:
`abort, escalate_node, node_accepted, node_submitted, reassign_node, retry_node, start`.

**All three inferred entries were verified by hand** and are real POSTs whose path literal is
built into a local variable before reaching the client — `InfrastructurePage.tsx`'s
`propose(title, body, path)` helper, and `PmAndDecisions.tsx`'s `syncNow()`, which picks the run
or workflow-instance path into `const path` before `api.post(path, …)`. None is a false credit.

Browser evidence on top of the static diff: all 53 Playwright journeys green against a real
seeded gateway serving the real built bundle, including `phase4-operator-parity.spec.ts`, which
drives all six audit-2 capabilities in Chromium and asserts the request body **on the wire**.

### 3. What is deleted

| Path | Lines |
| --- | --- |
| `apps/gateway/src/app-ui.ts` | 2,841 |
| `apps/gateway/src/admin-portal.ts` | 2,583 |
| `apps/gateway/src/ui-theme.ts` | 927 |
| `scripts/parity-diff.mjs` | 514 |
| `scripts/check-ui-syntax.mjs` | 40 |
| `apps/gateway/src/legacy-ui-parity.test.ts` | 77 |

Plus the `/legacy/admin` and `/legacy/app` routes and their auth-exempt / admin-exempt
registrations in `app.ts`, the deprecation-banner injection, the two `legacy ↗` footer bridges in
`AppShell.tsx`, the `check-ui-syntax.mjs` step in `.github/workflows/ci.yml`, and the tests that
existed only to assert the deleted shells. **7,125 deletions against 101 insertions.**

`check-ui-syntax.mjs` goes because it existed solely to `node --check` the inline `<script>`
blocks of template-literal HTML that `tsc` never parsed. The SPA is real TypeScript that
`pnpm -r build` typechecks and Vite parses, so a UI typo can no longer ship behind a green build
— the guard is now structural rather than a bolt-on.

### 4. `/legacy/*` becomes *not a route*, not a redirect

`/legacy/app` and `/legacy/admin` register nothing at all. They behave exactly like any other
removed path: 401 unauthenticated (the auth hook answers first), 404 with a credential, never
HTML. A redirect was considered and rejected — a redirect implies the URL is still part of the
contract, and the point of this ADR is that it is not. `/`, `/app` and `/admin` keep their 302 to
`/ui`, because SSO's server-side `returnTo` whitelist names `/app` and `/admin`, and because
bookmarks outlive releases. The SPA's own admin console is a client route at `/ui/admin/*`.

### 5. The parity gate is deleted *with* the thing it guarded

`scripts/parity-diff.mjs` and `legacy-ui-parity.test.ts` compare the SPA against files that no
longer exist. Both are deleted rather than frozen against a snapshot. The reasoning, deliberately:
a gate whose demand side is a snapshot of a deleted file is a gate against history, and it would
have gone green forever regardless of what the SPA did — worse than no gate, because it *looks*
like protection. Its actual job — proving parity at the moment of deletion — is done, and its
output is preserved above as this ADR's evidence. **The method it encodes is what survives, in
§1**; if a second UI surface is ever introduced, the script is recoverable from git history at
`a8d2ce9` and the method is written down here.

### 6. CSP: nothing weakened

`app.ts` hashes inline scripts at boot from the exact bytes it will serve. That machinery is
**shared** — `registerSpaInlineScripts()` reads the built `apps/web/dist/index.html`, which
carries the theme pre-paint script and genuinely needs its hash. Only the two
`registerInlineScripts(LEGACY_*_HTML)` calls are removed; `script-src` stays `'self'` + hashes,
with no `'unsafe-inline'` and no `'unsafe-eval'`.

`style-src 'unsafe-inline'` is **deliberately left as-is**. ADR-0031 disclosed it as a relaxation
forced by the legacy shells' large inline `<style>` blocks and noted it could tighten to `'self'`
"the release the `/legacy/*` shells are removed". That blocker is now gone — but tightening it is
a behaviour change to every served document, and a wrongly-tightened `style-src` renders an
unstyled page rather than raising an error, so it needs its own browser verification and does not
belong inside a deletion PR. Carried forward as the ADR-0031 follow-up, now unblocked.

## Consequences

**Easier.** One UI, one language, one build. A change to a governed surface now has exactly one
place to land instead of two that could drift — which is what produced eleven gaps in the first
place. `apps/gateway` loses ~6,350 lines of HTML-in-TypeScript and a bespoke CI lint step; the
`style-src` tightening is unblocked.

**Harder / given up.** There is no fallback UI when `apps/web/dist` is absent: `/ui` answers a
503 that says so honestly and names the build command, and `/v1` is the only surface until the
bundle exists. The gateway's Docker image and any deploy path must build the web bundle. Anyone
still bookmarking `/legacy/*` gets a 404 — accepted deliberately, per §4.

**Follow-ups created.**

1. Tighten `style-src` to `'self'` with browser verification (ADR-0031's item, now unblocked).
2. The four `/ui`-serving invariants (SPA fallback, never shadowing `/v1`, path-traversal
   containment, honest 503) are now the *only* thing between a user and no UI at all —
   `web-serving.test.ts` is load-bearing and should be treated as such.

## Verification

- `pnpm -r build` clean (gateway `tsc`; web `tsc --noEmit` + `vite build`).
- `pnpm -r test` green on a freshly dropped and recreated `regulait_test`:
  **1592 → 1585 workspace tests; gateway 888/70 files → 881/69 files.** Every one of the seven is
  a deleted legacy test, accounted for individually:
  - `legacy-ui-parity.test.ts` — the whole file, 5 tests, −1 file;
  - `mcp-proxy.test.ts` — `GET /legacy/admin serves the shell…` and the `/legacy/app` end-user
    shell test, 2 tests. The surrounding describe's *endpoint* assertions are the durable part
    and stay.
  - No non-legacy test was lost. `web-serving.test.ts` stays at 12 and `security-headers.test.ts`
    at 7: each had exactly one legacy-shell test **replaced**, not removed — `/legacy/*` is now
    asserted to be *gone* (401/404, never HTML), and the document-CSP shape is asserted against
    `documentCsp()` directly so it stays covered even with no bundle present. Every other package
    is byte-identical in count.
- **Chromium/Playwright, real gateway + real seeded database + real built bundle**: all 53
  journeys green, zero console errors. `phase4-operator-parity.spec.ts` re-drives all six
  audit-2 capabilities — deploy-mode scoping (set and cleared), revocation narrowing (narrowed
  and restored), manual streaming dispatch, reassign, submit-for-review, and the per-node
  instruction override as the `/auto` `inputs` map.
- **Route sweep** (temporary spec, not committed): every one of the 32 SPA routes — 9 end-user +
  23 `/ui/admin/*` — loaded 200 as a signed-in admin with a non-empty `#root`, **zero console
  errors, zero pageerrors and zero 404 responses of any kind**. `/`, `/app` and `/admin` each
  302 to `/ui`; `/ui` serves the document; `/legacy/app` and `/legacy/admin` 401 unauthenticated
  with no HTML in the body. No route that used to work 404s.
