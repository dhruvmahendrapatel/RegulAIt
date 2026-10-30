# ADR-0196: The enterprise UI harness: four bars as ratchets

- **Status**: Accepted
- **Date**: 2026-10-17
- **Number**: may be renumbered at merge if another ADR takes 0196 first.

## Context

The owner set an "enterprise grade" bar for the web app and chose all four parts of it:

1. **WCAG 2.2 AA plus keyboard.** axe on every screen, light and dark; keyboard paths through the primary
   journeys (sign-in, intake, approvals, the settings step-up); contrast and target size (2.5.8); serious and
   critical violations fail.
2. **Responsive plus browsers.** Chromium, Firefox and WebKit; desktop 1280, 1440 and 1920; tablet 768 and 1024.
3. **Visual consistency.** A screenshot pack (screen x viewport x theme) the owner can scan, plus automated checks:
   no hard-coded colour or spacing outside the design tokens, consistent loading and error states, one table density.
4. **Performance budgets.** LCP and INP per screen; JS bundle-size ceilings per entry, enforced in CI.

The full audit runs later, once the feature baseline lands. This ADR covers the harness, which runs today and
records today's violations as a baseline. It does not fix existing violations: other work is fixing UI issues in
parallel, and the harness must not block it.

## Decision

### The model: a ratchet, as in the import-cycle job (#387)

Every check reports **findings**: counts per key, for example `/admin/users|dark` -> `{ "color-contrast": 3 }`.
Today's findings are committed as baselines. A finding above its baseline count fails CI. A count at or below the
baseline passes, so fixing a violation never breaks the build. CI refuses any baseline file that **grows** against
the base branch (`scripts/ui-enterprise-baseline.mjs --guard`). Fixing something and then running `--update`
shrinks the file.

- Browser baselines: `apps/web/e2e/enterprise/baselines/<category>.json` (axe, keyboard, responsive, states,
  density, perf). A lower count than the baseline is printed as stale and does not fail the run, because a browser
  check can find fewer through timing.
- The design-token baseline (`scripts/ui-tokens.baseline.json`) is static and deterministic. It is strict both
  ways, like the import-cycle baseline: a stale entry fails until it is shrunk.

### What is checked

- **Screens** come from a new SPA route census, `scripts/ui-spa-routes.mjs`. It lists every `<Route path>` in
  `apps/web/src/App.tsx`, leaving out catch-alls and `<Navigate>` redirects; `:params` get a fixture id. A screen
  added to App.tsx is audited automatically. The existing `preflight-ui-route-census.mjs` lists gateway routes,
  not screens, so the harness needs this second list.
- **API**: `e2e/enterprise/mock-api.ts` signs in an admin and answers every other call 503 by default. Each screen
  therefore renders its error state, with no invented data. Per-screen fixtures (populated tables and charts) belong
  to the feature-baseline audit; until then the content of a populated screen is not covered.
- **Bar 1**: `a11y-routes.ent.spec.ts` runs axe (`wcag2a/aa`, `wcag21a/aa`, `wcag22aa`, which includes
  `color-contrast` and `target-size`) on every screen in both themes. Serious and critical violations are gated;
  moderate and minor ones are annotations. `keyboard.ent.spec.ts` covers the four journeys in all three browsers:
  the skip link (first Tab, visible, lands in `<main>`), a Tab walk (a focus indicator on every stop, no lost or
  stuck focus, no positive tabindex), reading order on the sign-in form, and dialogs opened from the keyboard
  (focus moves in, Tab and Shift+Tab stay in, Escape closes, focus returns to the trigger). The step-up dialog is
  reached through `e2e/step-up-harness.ts`. WebKit walks with Alt+Tab, Safari's key for reaching links.
- **Bar 2**: `responsive.ent.spec.ts` loads every screen once per browser and resizes it to the five widths. Each
  width must have no sideways page scroll, a visible `<main>`, and no page error.
- **Bar 3**: `screenshots.ent.spec.ts` (project `screenshots`) writes the pack, and `scripts/ui-screenshot-index.mjs`
  writes a static `index.html` for it. CI uploads both as the `ui-screenshot-pack` artifact. `states.ent.spec.ts`
  holds every call open and checks that the screen announces loading (`role="status"` or `aria-busy`). It then
  fails every call and checks for an alert (`role="alert"`). It also measures every table's cell padding and font
  size against a probe styled like the kit's `Table`. Empty states need per-screen data and come with the
  feature-baseline fixtures. `scripts/preflight-ui-tokens.mjs` parses the CSS with postcss and applies four
  rules named after stylelint's built-ins (`color-no-hex`, `color-named`, colour functions, px/rem/em on padding,
  margin and gap) and scans TS/TSX for colour
  literals and literal inline spacing. `tokens.css`, `fonts.css` and test files are left out.
- **Bar 4**: `perf.ent.spec.ts` injects web-vitals into the page and measures LCP and INP on every screen in
  Chromium. INP comes from one click on the screen's heading. The budgets are web-vitals' "good" thresholds,
  LCP 2500 ms and INP 200 ms; a screen over a budget is a finding. The measured values are uploaded per run.
  `apps/web/.size-limit.json` sets gzip ceilings for the entry JS, entry CSS, the two lazy chunks and all JS, at
  today's size plus about 3 %. Raising a ceiling is a reviewed diff to that file.
- Everything runs against the **production build** (`vite build` + `vite preview` on :4180), not the dev server.

### Open-source search (ADR-0176)

- **Bundle size**: `size-limit` + `@size-limit/file` 14.2.0 (MIT) was chosen over a hand-written gzip script. Its
  `file` plugin only reads built files, so it needs no bundler and no network.
- **Web vitals**: `web-vitals` 6.2.3 (Apache-2.0), the reference implementation. Lighthouse CI was not chosen: it
  needs its own Chrome flow per URL and cannot drive the mocked API.
- **CSS lint**: `stylelint` 17.16.0 (MIT, built-in rules only) was the first choice and was dropped. Its globbing
  dependencies bring in `braces` 3.0.3, which has a high advisory (GHSA-vfj7-8cjw-p6xm) with no fixed release, and
  the dependency audit gate refused it. Allow-listing it was rejected (ADR-0180: the strict default). The scan now
  uses `postcss` 8.5.28 (MIT), the CSS parser vite already ships, pinned as a direct dev dependency. Over the same
  source it reproduces stylelint's counts exactly (739). The rule logic, about 30 lines, is a written exception: no
  maintained package that needs no glob dependency provides these four checks. TSX inline styles are covered by
  neither tool, so the TSX scan is a second narrow exception. It is a regex over string literals and style objects; a known false positive is a
  `#412`-shaped issue number in copy, which the ratchet tolerates.
- **Accessibility**: the existing `@axe-core/playwright` (test-only, MPL-2.0 exception already recorded).
- **Ratchet and baseline merge**: no package fits these per-key counts compared with git history; the script is
  about 150 lines, like `preflight-import-cycles.mjs`.

All four are dev dependencies of `apps/web`, pinned exactly and listed in `apps/web/THIRD_PARTY.md`. None is
bundled, and none needs the network at run time.

### Running it locally

From the repository root, after `pnpm install`:

```
node scripts/preflight-ui-tokens.mjs                      # design tokens (--update to shrink the baseline)
pnpm --filter @regulait/web build && pnpm --filter @regulait/web exec size-limit
cd apps/web
npx playwright test -c playwright.enterprise.config.ts --project=chromium      # every browser check
npx playwright test -c playwright.enterprise.config.ts --project=screenshots   # the pack
node ../../scripts/ui-screenshot-index.mjs                # -> test-results/screenshot-pack/index.html
node ../../scripts/ui-enterprise-baseline.mjs --update    # after fixing violations: shrink the baselines
```

`ENTERPRISE_RECORD=1` records without failing; it is how a baseline is first written. On a dev box, Chromium
comes from `PLAYWRIGHT_BROWSERS_PATH`. Never run `playwright install` there. Firefox and WebKit run in CI, where
`.github/workflows/ui-enterprise.yml` installs them with the pinned Playwright version.

## Consequences

- A new screen, journey regression, overflow, token literal or bundle growth fails CI on the PR that causes it.
  Existing ones are visible as counts and can only go down.
- The harness covers each screen's chrome, error and loading states, not its populated content. The populated audit
  needs per-screen fixtures in `FIXTURES` (mock-api.ts); that is the feature-baseline follow-up.
- About 20 minutes of Chromium in CI, plus Firefox, WebKit and the screenshot job running in parallel.
- Performance numbers come from a CI runner with a mocked API, so they measure the client's own cost. They are not
  field data.

## As built

Baseline at commit time, from one Chromium run of all 112 screens (450 tests passed, 2 skipped: the two public
screens in the states check):

- axe, serious or critical, both themes: 0. A planted check (low-contrast text, an unnamed button, an image without
  alt) was caught, so the zero is a real reading of the error-state screens.
- keyboard (Chromium): 1, `dialog-focus-not-restored` on the settings step-up (Escape on the step-up dialog leaves
  focus on `<body>`).
- responsive (Chromium, five widths): 0.
- states: 29 on 23 screens: 22 `loading-not-announced` and 7 `error-not-shown`.
- table density: 0. perf: 0 over budget (highest LCP 1396 ms, highest INP 16 ms, on this container).
- design tokens: 739 findings in 98 files: 370 px/rem/em spacing in CSS, 298 literal inline spacing in TSX,
  47 colour literals in TSX, 22 hex colours and 2 colour functions in CSS.
- bundle (gzip): entry JS 792.7 kB, entry CSS 28.6 kB, SeriesLineChart 106.1 kB, RunGraphCanvas 75.9 kB, all JS
  989.2 kB.

The Firefox and WebKit baselines are written from their first CI run, because those browsers are not installed on
the build container.

### As built: review fixes (PR #410 independent review)

These change what the Decision above says; where they differ, this section is what ships.

1. **Bundle ceilings are a ratchet, not a reviewed diff.** `ui-enterprise-baseline.mjs --guard` also compares
   `apps/web/.size-limit.json` with the base branch, entry by entry keyed by `name`. A raised `limit`, a removed entry,
   or a changed `path`, `gzip` or other option fails the guard; a new entry is allowed. Limits are read the way
   size-limit 14.2.0 reads them (B/kB/MB in powers of 1000, KiB/MiB in 1024; its `parseBytes` is not exported, so
   the 10-line function is mirrored and pinned by tests). A ceiling may rise only through an exception recorded in
   an ADR and landed by the owner (master decision, 2026-10-17).
2. **Public screens are audited signed out.** The census marks each screen `public` when it is outside every
   signed-in layout (`<Route element={<Protected />}>`); today that is `/login` and `/f/:token`. Every per-screen
   spec opens them with `mockApi(page, { signedOut: true })`, so `/login` is audited instead of the shell it used to
   redirect to. `openRoute` now asserts the final pathname is the route's own URL, so a future redirect fails
   instead of auditing another screen under the route's name.
3. **The census parses App.tsx with the TypeScript compiler API** (ADR-0176: `typescript` is already a dependency)
   instead of a regex. Attribute order and `path="x"`, `path={"x"}` or a template literal all read the same; a
   computed path, a spread on `<Route>` or an index route fails the census rather than dropping a screen. Relative
   paths resolve against the enclosing route (the admin `<Routes>` under `/admin/*`), so the `/admin/` prefix is no
   longer hard-coded. The real App.tsx gives the same list as before.
4. **A focus cycle outside a dialog is a finding.** The Tab walk records its first stop; coming back to any other
   stop before `<body>` or that first stop is `focus-trapped`. A repeat on the same control still counts toward
   `focus-stuck`.
5. **Record mode is refused in CI.** `ratchet.ts` throws when `CI` and `ENTERPRISE_RECORD` are both set, unless the
   run is a manual `workflow_dispatch` with `ENTERPRISE_RECORD=update` (a run that rewrites the baselines). The
   harness, its baselines, the census, the token ratchet, `.size-limit.json` and the workflow have CODEOWNERS
   entries, so loosening a constant (`GATED`, `TAGS`, `LCP_BUDGET_MS`, `VIEWPORTS`) needs the owner.
6. **CI and journey nits.** The screenshot job's index and upload steps run on failure (`!cancelled()`), so a
   failing spec keeps the pack. The workflow header names the postcss scan, not stylelint. The settings step-up
   journey reaches the Reason field and the submit button by Tab from the dialog's own focus (`tabTo` with
   `fromStart: false`); either one not reachable is `dialog-control-unreachable`.

### As built: review fixes, round 2 (PR #410 recheck)

These add to the subsection above; where they differ, this one ships.

1. **The bundle ceilings can only be read from `.size-limit.json`.** size-limit 14.2.0 searches `package.json` before
   `.size-limit.json`, so a `size-limit` key there (or a second `.size-limit.js`/`.cjs`) bypassed the guarded file.
   The `size` script and the static job now run `size-limit --config .size-limit.json`, and `--guard` fails, on HEAD
   alone, when `apps/web/package.json` has a `size-limit` key, any other `apps/web/.size-limit*` file exists, or the
   `size` script is anything but that pinned command. `apps/web/package.json` and the harness test have CODEOWNERS
   entries. The copied `parseBytes` now carries its MIT notice (size-limit 14.2.0 `bytes.js`, (c) Andrey Sitnik), is
   listed in `apps/web/THIRD_PARTY.md`, and a drift test compares it with the installed size-limit's own function
   over a value table (the ADR-0176 §4 exception: `bytes` reads kB as 1024, so no importable module matches).
2. **A trap on one control is caught (`focus-stuck`).** Item 4 above said a repeat on the same control still counted
   toward `focus-stuck`; it could not (the walk stopped on the first repeat). The walk now keeps the last Tab keydown,
   caught on `window` in the capture phase so a handler that stops propagation cannot hide it, and reads its
   `defaultPrevented` after the key: focus that stays put on a swallowed Tab is `focus-stuck`; on a Tab the page did
   not swallow it is Tab leaving the page for the browser's UI (Chromium keeps the active element), the normal end
   of the walk. The walk lives in `e2e/enterprise/keyboard-walk.ts`, and `keyboard-selftest.ent.spec.ts` plants
   traps in a fixture page (test-only HTML) in all three browsers: a control that swallows Tab, the same with
   `stopPropagation`, and an A→B→A cycle each fire, and a page with no trap fires neither. The journeys' baselines
   hold no `focus-stuck` or `focus-trapped`, so a false positive on `approvals` or any other journey fails the run.
3. **Record mode is tested.** `recordMode()` moved to `e2e/enterprise/record-mode.ts`, which has no
   `@playwright/test` import (re-exported from `ratchet.ts`); `scripts/ui-enterprise-harness.test.mjs` covers its
   five branches (unset or `0`; local `1`; CI with `1` throws; CI `update` on `pull_request` throws; CI `update` on
   `workflow_dispatch` is allowed).
4. **Census gaps closed.** An index route is tested to throw. A splat route (`path="/x/*"`) whose element renders no
   inline `<Routes>` now throws, because its screens would live in a file the census never reads; the top-level
   catch-all and a splat `<Navigate>` redirect are exempt.

### As built: lane U1, accessibility and keyboard fixes

The first fix lane against the bar 1 baselines. Nothing in the harness changed: no constant, gate, tag list or budget.
Fixes went into the shared kit and the global styles, so each fix covers every screen that uses them.

1. **A dialog hands focus back to a trigger that is busy** (`dialog-focus-not-restored`, all three browsers, settings
   step-up). A dialog's confirm usually starts work that disables the control which opened it (a page's `busy`), and
   a disabled control cannot take focus, so `Modal` dropped focus on `<body>`. The step-up dialog, opened by that
   same work, then recorded `<body>` as its trigger. `Modal` now parks focus on the trigger's `<main>` (the skip-link
   target, `tabindex="-1"`) and hands it back to the trigger once the trigger is enabled, which it watches with a
   `MutationObserver` on `disabled`. The hand-back is dropped if focus moves anywhere else first, or after 60 s. A
   dialog opened while focus is parked returns focus to the original trigger. Checked in Chromium: after Escape on the
   step-up, focus is on the page's Resume button.
2. **`<select>`, checkbox, radio and date fields show an outline ring on `:focus`** (`focus-not-visible`, WebKit: 7
   on approvals, 1 on intake, 4 on the step-up journey; all of them selects plus one non-text input). WebKit does not
   match `:focus-visible` on these controls when they are reached with Option+Tab. It also drops `box-shadow` on a
   control drawn with its native appearance: a first fix that only switched them to `:focus` with the box-shadow
   ring still read `none` in the WebKit run, so that is inferred from the result. `global.css` therefore gives
   `select:focus` and the non-text input types `outline: 2px solid var(--rg-signal-ring)` with `box-shadow: none`,
   so Chromium and Firefox do not draw two rings. The kit's `.select` keeps only its border colour on focus, and the
   three tiles that draw the ring for an inner input (`.providerTile`, `.outcome`, `.choice`) use `:focus`. Text
   fields keep the box-shadow ring. A mouse-focused select or checkbox now also shows the ring, which is acceptable
   under WCAG 2.4.7 and 2.4.11.
3. **axe stays at 0** serious or critical on every screen in both themes. Its baseline was already empty, so U1
   had nothing there to shrink.

Open-source search (ADR-0176): `focus-trap` and `focus-trap-react` (MIT) manage focus inside a container. Their
`returnFocusOnDeactivate` focuses the saved element or skips it when it is disabled; neither waits for the element to
be enabled again. Native `<dialog>` (already used) restores focus to the previously focused element and does the same.
No package covers "hand back once enabled", so the hand-back is about 40 lines in `kit.tsx`. The `:focus-visible`
polyfill (W3C/WICG, MIT) changes how `:focus-visible` matches with a class, not which controls it covers, so it would
not fix the WebKit gap. A plain CSS selector does.

Result: the keyboard baseline went from 15 findings in 5 keys to 0. The counts came from CI runs at a24c234 (Chromium,
Firefox, WebKit), applied with `ui-enterprise-baseline.mjs --update`, and the `--guard` against main passes. Before:
`dialog-focus-not-restored` 1 on the settings step-up in each browser, and WebKit `focus-not-visible` 7 on approvals,
1 on intake and 4 on the step-up. The axe baseline stays empty.

Not in U1: the 29 `states` findings (loading and error announcements) and the design-token ratchet belong to bar 3,
and responsive belongs to U2.

### As built: U2, responsive and state fixes (lane U2)

What the U2 lane found and changed against the harness. The harness itself (specs, constants, `VIEWPORTS`, gates,
census) is unchanged.

1. **Responsive (bar 2) was already at zero in all three browsers.** `baselines/responsive.json` was empty on main and
   the harness's CI run on #410 passed Chromium, Firefox and WebKit against it, so no layout finding at 1280, 1440,
   1920, 1024 or 768 existed to shrink. A wider probe (not committed) looked for more than sideways page scroll at the
   five widths in Chromium: any visible element past the viewport edge with no scrolling ancestor, and any
   `overflow: hidden`/`clip` box whose content is cut off without an ellipsis or line clamp. It found nothing on any of
   the 113 screens in the census. The kit's `Table` already scrolls inside its own `tableWrap` (`overflow-x: auto`), and the shell's
   nav becomes a drawer at 960 px and below. **Caveat:** like the harness, the probe saw each screen's error state
   (every call answers 503). Populated tables, charts and long values are not covered until the feature-baseline
   fixtures land in `mock-api.ts`; that is where a real responsive defect would most likely show.
2. **States (bar 3): 29 findings down to 2** (Chromium, the only browser the states spec runs in).
   - `loading-not-announced` on 17 screens had one cause: the kit's `Table` drew skeleton rows with no busy state.
     The `<table>` now carries `aria-busy="true"` while `loading`, the same signal `SkeletonBlock` gives with
     `role="status"`.
   - A failed read shown as an empty one (the UXJ-01 pattern) on five screens:
     - `/chat` said "No conversations yet" and "No agents are granted to your account" on a 503. It now shows
       `ErrorState` for each, and the composer stays disabled while the agent list has failed.
     - `/admin/custom-providers` said "An empty allow-list is the default-deny posture, not a problem" when the
       allow-list read failed. Both of its tables now get `error` and `onRetry`.
     - `/admin/teams` said "No teams yet" (and showed nothing while loading). It now shows a skeleton, then
       `ErrorState`.
     - `/admin/prompt-versions` showed an empty agent picker and "Pick an agent" when the agent list failed. It now
       shows a skeleton, then `ErrorState` above the picker.
     - `/feedback/:useCaseId`: the use case's name is optional (anyone may report), so a 403 or 404 stays quiet.
       Any other failure now shows a one-line alert that the report can still be sent, and the lookup is announced
       while it runs.
   - `/builder/playground`: the model list now announces its loading and shows an alert when it fails, beside the
     picker (the shared `ModelPicker` is unchanged).
   - `/admin/governance/intake`: the similar-use-cases rail's summary is `role="status"` (it was `aria-live`
     only, which the states check does not read), and a failed registry read is `role="alert"`.
3. **The 2 that stay** are `error-not-shown` on `/builder/playground` and `/admin/governance/intake`. Both screens do
   show their alert, about 1.1 s after load: the app's query client retries a 503 once after the default 1 s backoff
   (`App.tsx`), and on these two screens nothing else is in flight during that second, so Playwright's
   `networkidle` (500 ms quiet) fires inside the retry gap and the check counts before the retry lands. A run that
   waited for the alert saw it on both by 1.5 s. Making the check wait for the alert (as the loading check already
   waits up to `LOADING_MS`) is a harness change, so it is left to the owner; the baseline keeps both at 1.

### As built: U4 performance (route-level code splitting)

Bar 4 says "JS bundle-size ceilings per entry, enforced in CI". U4 shrinks what the entry loads and then lowers the
ceilings to the new sizes. No ceiling was raised and no harness constant or gate changed.

- **Screens load on demand.** `apps/web/src/App.tsx` declares every screen with `React.lazy`. The router is the
  repo's own (react-router 7, `createBrowserRouter`), so no dependency was added (ADR-0176). Its default wraps every
  navigation in a React transition, so the screen being left stays up until the next one has loaded, and focus does
  not move. The router's own `lazy` route property was not used: the screens are declared as JSX `<Route>`s, and the
  route census (`scripts/ui-spa-routes.mjs`) reads them there.
- **One chunk per console section, not per screen.** `apps/web/src/screens/*.ts` re-export the screens of one admin
  section (the groups in `shell/suites.tsx`) or one workspace area. Each module is the dynamic-import target for its
  screens, so a section's shared code ships once, and code shared between sections stays in the entry or in a shared
  chunk. A chunk per screen (174 files) measured 1,144.8 kB on the "all JS" entry, over its 1,020 kB ceiling. Gzip
  loses its dictionary at each file boundary, and that entry adds up per-file sizes. One chunk per source directory
  measured 1,000.7 kB, but its governance chunk was 201 kB. The section grouping measures 1,010.1 kB, and its largest
  screen chunk is 86.7 kB (AI Governance). A single-screen area (home, chat, models, spend, account, the two
  single-file admin areas) imports its file directly.
- **Loading fallback.** `apps/web/src/shell/RouteFallback.tsx` renders only on a first load. It sits in the same box as
  the auth probe's skeleton in `Protected`, so nothing moves when one hands over to the other. It announces "Loading
  page" through `RouteLoadingAnnouncer`, a polite `aria-live` region that is always mounted beside the router (outside
  `<main>`) and only changes its text while a fallback is up, because many screen readers say nothing for a region
  that is inserted together with its text. Its skeleton bars are hidden from assistive technology. It
  deliberately has no `role="status"` and no `aria-busy`. Those are what the states check reads as the screen
  announcing its own data loading. A first run with a `role="status"` fallback cleared 21 of the 22 `loading-not-announced`
  findings that the screens had not fixed, because the fallback was in `<main>` while the chunk loaded. That would
  have loosened the gate. It takes no focus. Signed-in screens suspend inside `AppShell` (a boundary around `<Outlet />`), so the shell and the
  skip link stay mounted. The screens outside the shell (sign-in, the public feedback link, the forced gates) suspend
  to a boundary around the router element.
- **Failed chunks (review fix).** A chunk that fails to load (a tab opened before a gateway upgrade asks for an old
  hash and gets a 404; a dropped link) used to replace the app with the router's developer page, stack trace and
  asset URLs included. `apps/web/src/shell/RouteError.tsx` now shows a `role="alert"` panel instead: "This page
  failed to load" for a failed import (recognised by the Chromium, Firefox and WebKit messages), "Something went
  wrong on this page" for a screen that threw. It offers **Reload** and a link home, and never shows the error's
  message or stack (they go to the console). Reload is the recovery because React caches a lazy screen's rejected
  import, so re-rendering cannot fetch it again. Signed-in screens get the panel inside the shell
  (`ShellRouteBoundary`, around the `Suspense` in `Protected`), so the shell and skip link stay mounted; it resets
  when the path changes rather than remounting, so a later navigation still runs in the transition. The rest get it
  from the root route's `errorElement` (react-router's `useRouteError`). The in-shell boundary is
  `react-error-boundary` 6.1.6 (MIT, no dependencies, released 2026-09-20), chosen under ADR-0176 over a
  hand-written class: its `resetKeys` is exactly the reset-on-navigation rule. It does not reload by itself on vite's
  `vite:preloadError`: a failed client navigation would then throw away the screen the person is on, with anything
  typed into it. `e2e/enterprise/route-chunks.ent.spec.ts` aborts the chunk on a direct load, on a client
  navigation and outside the shell, and holds it to check the fallback; each case failed with the fix removed.
- **Logos are files, not script.** `vite.config.ts` sets `assetsInlineLimit` so `.svg` files are never inlined. The
  72 vendored logos (`src/ui/logos/svg`, loaded by `Logo.tsx` with `?url`) had been inlined into a shared chunk as
  `data:` URIs (43.8 kB gzip of script). They are now hashed files under `/ui/assets`. The gateway already serves
  `.svg` as `image/svg+xml` with immutable caching, and they stay air-gapped. A screen fetches only the marks it
  draws.
- **Heavy libraries.** recharts (`SeriesLineChart`) and @xyflow/dagre (`RunGraphCanvas`) were already lazy, behind
  their own boundaries. They stay separate chunks, so the two `lazy:` entries keep matching their files. The
  react-router package exports only its development build. Its production build has the same size, so aliasing it
  was not worth a resolver override.

Bundle (gzip, size-limit 14.2.0, `pnpm --filter @regulait/web size`), main at 71d0aff and then this branch:

| entry | before | after | ceiling before | ceiling after |
|---|---|---|---|---|
| entry JS (index) | 804.1 kB | 133.4 kB | 817 kB | 137.5 kB |
| entry CSS (index) | 28.6 kB | 10.2 kB | 30 kB | 10.6 kB |
| lazy: SeriesLineChart | 106.1 kB | 106.1 kB | 110 kB | 109 kB |
| lazy: RunGraphCanvas | 75.9 kB | 75.9 kB | 79 kB | 78 kB |
| all JS | 1,001.3 kB | 1,010.1 kB | 1,020 kB | 1,020 kB (unchanged) |

The new ceilings are the measured size plus about 3 %, the margin the harness first set. Entry CSS gets about 4 %
(10.6 kB), because lane U1 (#423) adds a focus-ring rule of about 0.6 kB raw to `global.css`. "All JS" stays at 1,020 kB:
it grew by 8.8 kB (the per-file gzip cost of 64 files instead of 7), and 1,020 kB is already within 1 % of it. A
first visit now downloads the entry plus one section chunk instead of all 804 kB. After the failed-chunk fix (and
a merge of main), entry JS measures 134.6 kB (2.1 % under 137.5 kB) and all JS 1,012.2 kB (0.8 % under 1,020 kB);
no ceiling moved.

Performance (`perf.ent.spec.ts`, Chromium, all 113 screens, this container, mocked API): LCP median 1,248 to
1,180 ms, p90 1,312 to 1,248 ms, highest 1,368 to 1,300 ms; highest INP 16 ms both times. No screen was over a budget
before or after, so `baselines/perf.json` stays empty: `--update` rewrote it with 0 keys and no diff.

## Exception — "all JS" ceiling 1,020 kB → 1,035 kB (owner, 2026-10-19)

The owner approved this exception in the Governed - Designer session on 2026-10-19 (issue #453). It is the
ADR-recorded exception that the `--guard` rule above requires before a ceiling may rise.

- **Why.** On main at c5b921a, "all JS" measured 1,019,950 B against 1,020,000 B, leaving 50 bytes. The owner has
  approved UI items for the 2026-11-01 demo, and together they need about 10–15 kB of gzip JS:
  - the InfoTip (i) pattern and the 45 (i) explanations;
  - contained sections with an expanded view;
  - row-action alignment;
  - the Shadow AI, Inbox, alert, trust and audit screen changes;
  - the shared detail drawer, Shadow AI tabs, designed empty states and use-case tab grouping.
  None of them adds a library. Batch 1 alone, the kit, measured +870 B.
- **What moves.** Only `all JS`, from `1020 kB` to `1035 kB`. Entry JS (137.5 kB) and entry CSS (10.6 kB) are
  unchanged, and the work must fit them. Batch 1 measured entry JS 135.6 kB and entry CSS 10,575 B of 10,600 B.
  Kit CSS is therefore near its limit, so new screen styles go in each view's lazy CSS module, not in `kit.module.css`.
- **Landing.** `ui-enterprise-baseline.mjs --guard` fails on this diff by design. Per this ADR the owner lands it.

## Addendum / As built (2026-10-21) — entry JS 137.5 → 137.9 kB and all JS 1,035 → 1,036 kB

The owner decided this raise on 2026-10-21 in the master session:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6320179102>. It is the ADR-recorded exception
that the `--guard` rule above requires.

- **What moves.** In `apps/web/.size-limit.json`, `entry JS (index)` goes from `137.5 kB` to `137.9 kB` (+0.4 kB) and
  `all JS` from `1035 kB` to `1036 kB` (+1 kB). Entry CSS and the two lazy chunks are unchanged.
- **Why.** #477 (wide tables fit their cards) merged with #474 (X6b foldable cards) is over both ceilings. Gzip bytes,
  size-limit 14.2.0:

  | | entry JS | all JS |
  |---|---|---|
  | main with #474 (`3ab5f6c`) | 137,441 | 1,034,224 |
  | #477 + #474, fold code still in the entry | 138,224 | 1,035,113 |
  | #477 + #474 as built, fold code in its own lazy chunk (`FoldTable`, `ui/fold.tsx`) | 137,628 | 1,035,606 |
  | old ceiling | 137,500 | 1,035,000 |
  | new ceiling | 137,900 | 1,036,000 |

  The fold code stays in its lazy chunk, as the owner decided. A separate chunk saves 603 B of entry JS but costs
  all-JS bytes (it compresses alone, and the entry lists its file name), which is why both ceilings move.
- **How the guard accepts it.** `ui-enterprise-baseline.mjs` has a `CEILING_EXCEPTIONS` list. A row allows exactly one
  raise: that entry, from that limit, to that limit (compared in bytes). It must carry a date and a link to the owner's
  decision comment, and `--guard` fails when this ADR does not contain that link. Any other raise (no row, another
  target, another entry, another starting value) still fails; the tests in `ui-enterprise-harness.test.mjs` prove each
  case. Once the raise is on main a row matches nothing, so it may be deleted.
- **Follow-up commitment.** A separate held PR switches react-router to its production build (the entry ships its
  development build today, about 32.8 kB gzip). Once that PR merges, both ceilings are lowered back **below** the
  pre-raise values (entry JS under 137.5 kB, all JS under 1,035 kB), so the ratchet ends up stricter than before
  this exception.

## Addendum — the routing library's production build; entry JS ceiling lowered (2026-10-21)

The owner decided on 2026-10-21 (issue #453, comment 6320179102) that a separate held PR switches the routing
library to its production build, and that once it merges the ceilings are lowered below their values that day, so
the "only shrink" rule ends up stricter than before. This addendum records that PR. The decision text above is
unchanged.

- **Root cause.** `react-router` 7.18.4 names only `dist/development` in its package exports, under every condition
  (`node`, `module`, `import`, `default`, and `react-server`), so `vite build` bundled the development build. The
  production build ships beside it in `dist/production`. The two differ by one line, `ENABLE_DEV_WARNINGS = true`
  against `false`; with `false` the minifier drops the dev warnings (for example "No routes matched location"). React,
  React DOM and the other libraries branch on `process.env.NODE_ENV`, which `vite build` already sets to
  `production`; their bundles carried no development code.
- **Fix (configuration only; no dependency, version, lockfile or patch change).** A build-only resolver in
  `apps/web/vite.config.ts` (`routerProductionBuild`) resolves `react-router` and `react-router/dom` as before and
  swaps `dist/development` for `dist/production`. It fails the build if the resolved path is not under
  `dist/development`, so an upgrade that moves the files cannot silently ship the development build again. The dev
  server, the unit tests and the mocked suite keep the development build and its warnings. No open-source plugin
  does this one swap; Vite's own resolver hook is used.
- **Guard.** `scripts/preflight-ui-prod-bundle.mjs` scans `apps/web/dist/assets/*.js` for text only a development
  build leaves behind (the routing library's "No routes matched location"; React's "Download the React DevTools"
  and the list-key warning), and runs in the static job after size-limit. Its test pins each marker against the
  installed libraries' own two builds, and fails when the routing library starts naming a production build in its
  exports (the swap can then go).
- **Size.** The development build was not 32.8 kB of extra code: that figure is the whole routing library in the
  entry. The dev warnings were about 0.6 kB gzip. Measured locally, main at 44c55fd and then this change: entry JS
  137,448 → 136,848 B, all JS 1,034,202 → 1,033,635 B, entry CSS 10,587 B unchanged.
- **Final ceilings, after #477 and this PR (owner decision 2026-10-21,
  <https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6323236553>).** #477 merged first and raised
  entry JS to 137.9 kB and all JS to 1036 kB. Measured on this branch with main (#477 included) merged in, gzip bytes,
  size-limit 14.2.0: entry JS 137,031, entry CSS 10,594, all JS 1,035,090; the prod-bundle guard finds no development
  build. The owner set:
  - entry JS `137.9 kB` → **`137.3 kB`**, below the pre-raise 137.5 kB (269 B headroom). Its #477 exception row is
    removed: the ceiling is now below the value it was raised from, so no raise needs excusing;
  - `all JS` stays at `1036 kB`: the owner keeps #477's raise from `1035 kB` to `1036 kB` as a recorded exception
    (about 0.9 kB headroom for freeze-week fixes). Its `CEILING_EXCEPTIONS` row stays and now cites this decision;
  - entry CSS (10.6 kB) and the two lazy chunks are unchanged.
  This decision supersedes item 2 of the earlier decision ("lowered back below today's values") for all JS only. The
  values in "Size" above, measured before #477 merged, are kept as the record of what this change alone saved.

## Addendum / As built (2026-10-21) — all JS 1,036 → 1,038 kB (T1 themes, Phase 1)

The owner decided this raise on 2026-10-21 in the Governed - Designer session:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6328260537>. It is the ADR-recorded exception
that the `--guard` rule above requires, and it has one `CEILING_EXCEPTIONS` row.

- **What moves.** In `apps/web/.size-limit.json`, only `all JS` goes from `1036 kB` to `1038 kB` (+2 kB). Entry JS
  stays at main's 137.3 kB (set by the routing-library addendum above; it is not raised), and entry CSS (10.6 kB) and
  the two lazy chunks are unchanged.
- **Why.** T1 Phase 1 (user-selectable palettes) adds lazy JavaScript only: the palette module (`theme/palette.ts`,
  its own chunk) and the Appearance card on the Account page. The palette tokens are a lazy stylesheet
  (`theme/palettes.css`), loaded only once a palette other than Aurora is chosen. Gzip bytes, size-limit 14.2.0:

  | | entry JS | entry CSS | all JS |
  |---|---|---|---|
  | main (`f8ea023`) | 137,613 | 10,594 | 1,035,614 |
  | with T1 Phase 1 | 137,753 | 10,594 | 1,037,336 |
  | old ceiling | 137,900 | 10,600 | 1,036,000 |
  | new ceiling | 137,900 | 10,600 | 1,038,000 |

  The table above was measured before the routing-library production build merged, when the entry JS ceiling was
  still 137.9 kB. With main (that change included) merged into this branch, gzip bytes, size-limit 14.2.0: entry JS
  137,176 against the 137.3 kB ceiling (124 B headroom), entry CSS 10,594, all JS 1,036,518 against `1038 kB`
  (1,482 B headroom). The `all JS` row from `1035 kB` to `1036 kB` stays; this addendum adds its own row.


  Fix round 2 (review of #490): `theme/palettes.css` now loads through a `<link>` (`palettes.css?url`) rather than
  `import()`, so a failed load can be retried in the same visit; the stylesheet stays lazy and its tiny JS wrapper
  chunk is gone. Gzip bytes, size-limit 14.2.0, after the change: entry JS 137,179 against 137.3 kB, all JS 1,036,507
  against `1038 kB`. The `1035 kB` to `1036 kB` row named in the sentence above was dropped after all: main already
  carries `1036 kB`, so it matched nothing, and `--guard origin/main` still exits 0 without it.

## Addendum / As built (2026-10-24) — entry JS 137.3 → 137.7 kB and entry CSS 10.6 → 10.7 kB

The owner decided this raise on 2026-10-24, when accepting the full feedback scan's entry-bundle allowance (at most
+1 kB entry JS and +0.3 kB entry CSS, within ADR-0198 §2):
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6385378784>. It is the ADR-recorded exception
that the `--guard` rule above requires, and it has two `CEILING_EXCEPTIONS` rows. It is for #552 (FS-4 sortable-header
buttons, FS-15 toast placement and the two shell keyboard/count fixes).

- `entry JS (index)` from `137.3 kB` to `137.7 kB` (gzip, measured 137,272 → 137,607 B).
- `entry CSS (index)` from `10.6 kB` to `10.7 kB` (gzip, measured 10,594 → 10,652 B).
- Used: +0.4 kB of the +1 kB JS allowance and +0.1 kB of the +0.3 kB CSS allowance. `all JS` and the lazy chunks are
  unchanged.

## Addendum / As built (2026-10-24) — all JS 1,038 → 1,040 kB (full-scan lanes combined)

The owner decided this raise on 2026-10-24:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6388659678>. It is the ADR-recorded exception
the `--guard` rule requires, with one `CEILING_EXCEPTIONS` row.

- `all JS` from `1038 kB` to `1040 kB` (+2 kB). The entry JS and entry CSS ceilings and the two lazy chunks are unchanged.
- Why: the five full-scan UI lanes (#552, #553, #554, #556 and the merged #551) each fitted the ceilings on their own,
  but together they bring total gzipped JS on main to 1,038,335 B (size-limit 14.2.0), 335 B over. The added bytes are
  lazy page chunks (state, error and accessibility fixes); #555 (Shadow AI) adds a little more, so the raise leaves
  headroom for it and no more.

## Addendum / As built (2026-10-25) — entry JS 137.7 → 137.9 kB and all JS 1,040 → 1,041 kB (design-scan batches E1 to E4)

The owner decided this raise on 2026-10-25:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6393701751>. It supersedes a 137.8 kB raise agreed earlier the same day
from per-batch estimates, and it is the ADR-recorded exception the `--guard` rule requires, with two
`CEILING_EXCEPTIONS` rows.

- `entry JS (index)` from `137.7 kB` to `137.9 kB` (+0.2 kB).
- `all JS` from `1040 kB` to `1041 kB` (+1 kB). Entry CSS and the lazy chunks are unchanged.
- Why: the second design-scan run's owner-approved batches E1 (Shadow AI and S3 wording), E2 (governance beats), E3
  (kit accessibility) and E4 (copy consistency) each fit on their own, but built together on main c1d5a19e they put
  entry JS near 137,824 B (main 137,598 B) and all JS near 1,039,911 B before E4 (main 1,039,012 B). Entry bytes come
  mostly from the kit: error toasts that carry a visible "Error:" and stay until cleared, an "Actions" name on empty
  action headers, an IdChip name that starts with the visible short id, an optional tablist label and focusable
  scrolling code blocks (E3), and the workflow status words and the "shadow-AI" casing rule (E1). E2's "newest N"
  note lives in the lazy fold module, not the entry-bundled adminKit. E4's "for example" placeholders add lazy bytes.

## Addendum / As built (2026-10-25) — all JS 1,041 → 1,043 kB (design-scan E1 to E4 plus the ADR-0202 lanes)

The owner decided this raise on 2026-10-25:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6396960492>. It extends the 1,041 kB raise above
(which covered E1 to E4 only) to the ADR-0202 live-demo lanes, and it is the ADR-recorded exception the `--guard` rule
requires, with one `CEILING_EXCEPTIONS` row.

- `all JS` from `1041 kB` to `1043 kB` (+2 kB). Entry JS stays at 137.9 kB; entry CSS and the lazy chunks are unchanged.
- Why: estimated on main `c1d5a19` (1,039,012 B), E1 to E3 add about 899 B, E4 about 62 B, lane E (#568) 276 B and lane
  L (#572) about 782 B, about 1,041,031 B in all, just over 1,041 kB. Lane F (#573) adds no UI. Lane L's bytes are the
  lazy demo-beats card on Execution control, which the presenter uses to switch a beat to its simulated fallback. The
  remaining ~2 kB is margin for review fixes. The combined total on main is measured after these merge and recorded in
  the next As built note.

## Addendum / As built (2026-10-25) — entry JS 137.9 → 138.5 kB

The owner decided this raise on 2026-10-25:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6402364303>. It is the ADR-recorded exception
the `--guard` rule requires, with one `CEILING_EXCEPTIONS` row.

- `entry JS (index)` from `137.9 kB` to `138.5 kB` (+0.6 kB). All JS stays at 1,043 kB; entry CSS and the lazy chunks
  are unchanged.
- Why: with design-scan E1 (#565) on top of main, entry JS measures about 137,815 B, 85 B under the 137.9 kB ceiling
  (#565 review finding 1), so the next change touching the entry chunk would fail. The raise lands before the
  2026-10-29 freeze, so ADR-0198's freeze-week allowance (at most +1 kB of entry raises) is untouched.

## Addendum / As built (2026-10-29) — all JS 1,043 → 1,046 kB (batch I-1, the (i) pass)

The owner decided this raise on 2026-10-29:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6494584993>. It is the ADR-recorded exception
the `--guard` rule requires, with one `CEILING_EXCEPTIONS` row.

- `all JS` from `1043 kB` to `1046 kB` (+3 kB). Entry JS stays at 138.5 kB (measured 137,765 B) and entry CSS at
  10.7 kB (measured 10,493 B); the lazy chunk ceilings are unchanged.
- Why: batch I-1 moves long explanatory prose on about 80 pages behind the kit's InfoButton. Merged on main `f4cb1dc4`,
  total JS measures 1,044,565 B, about 1.6 kB over; the bytes are InfoButton markup in lazy page chunks. The remaining
  ~1.4 kB is margin for review fixes.
- Freeze week: ADR-0198 §2 covers entry raises only; this total-JS raise rests on the owner decision above, not on that
  allowance. ADR-0198's post-demo reset applies to it.

## Addendum / As built (2026-10-29) — all JS to 1,048 kB (G2 and G11, add and delete on their own screens)

The owner decided this raise on 2026-10-29:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6498510014>. It is the ADR-recorded exception the `--guard` rule requires, with two `CEILING_EXCEPTIONS` rows:
one from `1043 kB` if this lands before batch I-1 (#597), one from `1046 kB` if it lands after.

- `all JS` from `1043 kB` to `1048 kB` (before #597), or `all JS` from `1046 kB` to `1048 kB` (after it). Entry JS stays at 138.5 kB (measured 137,832 B on its own, 137,781 B with #597) and entry
  CSS at 10.7 kB; the lazy chunk ceilings are unchanged.
- Why: G2 (New project on Projects, Settings on the project page) and G11 (Retire, Close, Revoke and Abort as list row
  actions) reuse existing forms and confirmations, moved into shared modules; the bytes are the new buttons, dialogs
  and one new Abort confirmation in lazy page chunks. On main alone total JS measures 1,044,099 B; on a trial merge
  with #597 it measures 1,047,532 B, against #597's 1,046 kB.
- Freeze week: ADR-0198 §2 covers entry raises only; this total-JS raise rests on the owner decision above, not on that
  allowance. ADR-0198's post-demo reset applies to it.

## Addendum / As built (2026-10-30) — all JS 1,046 → 1,048 kB on batch I-1 (#597)

The owner approved a 1,048 kB all-JS ceiling on 2026-10-29:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6498510014>. PR #599 (G2 and G11) carries the
same figure. #597 now needs it too, so it carries the same two dated `CEILING_EXCEPTIONS` rows as #599: from `1043 kB`
(what `--guard origin/main` compares against while main is at 1,043 kB) and from `1046 kB`.

- `all JS` from `1046 kB` to `1048 kB` (+2 kB) on this branch; against main as it stands, `all JS` from `1043 kB` to `1048 kB`.
  Entry JS stays at 138.5 kB and entry CSS at 10.7 kB; the lazy chunk ceilings are unchanged.
- Why: with main merged in, #597 measured 1,046,359 B against 1,046,000 B in CI, before the review fixes. Those fixes
  add visible requirement lines and a chip on the SSO, MCP and Data key pages (ADR-0180).
- Freeze week: ADR-0198 §2 covers entry raises only; this raise rests on the owner decision above. ADR-0198's post-demo
  reset applies to it.

## Addendum / As built (2026-10-30) — all JS 1,048 → 1,050 kB (G2 and G11 with batch I-1 merged in)

The owner decided this raise on 2026-10-30:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6515493026>. It is the ADR-recorded exception
the `--guard` rule requires, with one `CEILING_EXCEPTIONS` row.

- `all JS` from `1048 kB` to `1050 kB` (+2 kB). Entry JS stays at 138.5 kB and entry CSS at 10.7 kB; the lazy chunk
  ceilings are unchanged.
- Why: with main (#597 and #607) merged into #599, total JS measures 1,049,109 B, over the 1,048 kB ceiling both PRs
  carried on their own.
- Freeze week: ADR-0198 §2 covers entry raises only; this raise rests on the owner decision above. ADR-0198's post-demo
  reset applies to it.

## Addendum / As built (2026-10-30) — all JS 1,050 → 1,060 kB (post-demo backlog lanes)

The owner decided this raise on 2026-10-30, together with unparking the G-lanes and starting the backlog lanes:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6522492997>. It is the ADR-recorded exception the `--guard` rule requires, with one `CEILING_EXCEPTIONS` row.

- `all JS` from `1050 kB` to `1060 kB` (+10 kB), one shared ceiling for every lane in flight. Entry JS stays at 138.5 kB
  and entry CSS at 10.7 kB; the lazy chunk ceilings are unchanged, and new screens are lazy-loaded.
- Why: one lane alone measures 1,049,965 B against the 1,050,000 B ceiling, which leaves no room for the other lanes.
  Raising the ceiling once on main stops each lane from editing the same line.
- A lane that would take total JS over 1,060 kB stops and goes back to the owner.

## Addendum / As built (2026-10-30) — all JS 1,060 → 1,071 kB (P3 long-page split, operations and cost)

The owner capped total JS at 1,075 kB across every lane in flight on 2026-10-30:
<https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-6529802888>. This is the ADR-recorded exception the
`--guard` rule requires, with one `CEILING_EXCEPTIONS` row, and it stays inside that cap.

- `all JS` from `1060 kB` to `1071 kB` (+11 kB), the smallest whole kB over what the branch measures. Entry JS stays at
  138.5 kB and entry CSS at 10.7 kB; the lazy chunk ceilings are unchanged.
- Why: the long cost-consolidation, Engines, MCP servers, cost and Infrastructure pages keep a five-row preview of each
  record list and move the full list to its own page. Those pages are new lazy chunks (one per parent page), and the
  modules they share with their parent (the isolation panel, the registries panel, the infrastructure ledgers) are split
  into their own chunks so a list page never loads its whole parent. Measured with the same lockfile: 1,058,266 B on the P2 batch C base, 1,070,513 B on this branch.
- Main has since raised the shared ceiling to 1,150 kB (comment 6531626139); when this branch meets main, main's ceiling
  and row stand and this row is dropped.
