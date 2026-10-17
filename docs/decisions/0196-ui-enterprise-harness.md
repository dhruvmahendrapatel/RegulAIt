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
  feature-baseline fixtures. `scripts/preflight-ui-tokens.mjs` runs stylelint's built-in rules over the CSS
  (`color-no-hex`, `color-named`, colour functions, px/rem/em on padding, margin and gap) and scans TS/TSX for colour
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
- **CSS lint**: `stylelint` 17.16.0 (MIT), built-in rules only. The `stylelint-declaration-strict-value` plugin
  was considered and is not needed for these rules. stylelint does not read inline styles in TSX, so the TSX scan is
  a narrow written exception. It is a regex over string literals and style objects; a known false positive is a
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

- Baseline counts at commit time (Chromium; Firefox and WebKit baselines are written from their first CI run):
  see the PR's builder report.
