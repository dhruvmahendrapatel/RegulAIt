# RegulAIt — design guidelines

The product's UI rules in one place. Each rule is one imperative line with its source. The source wins when the two
disagree; fix this page in the same PR that changes the source.

Sources, in short form:

| Short | Source |
|---|---|
| ADR-0026 | [React SPA](decisions/0026-react-spa-ui.md) |
| ADR-0075 | [Brand identity and UI structure](decisions/0075-brand-identity-and-ui-structure-adoption.md) |
| ADR-0168 | [Governance-flow registry and lifecycle review](decisions/0168-governance-flow-registry-lifecycle-review.md): item 9 (one accent, sentence case) and its later note on one primary action |
| ADR-0169 | [Shaded theme and auto-hide shell](decisions/0169-shaded-theme-and-auto-hide-shell.md) |
| ADR-0196 | [UI enterprise harness](decisions/0196-ui-enterprise-harness.md) |
| ADR-0198 | [Freeze-week CI settings](decisions/0198-freeze-week-ci-settings.md) |
| ADR-0200 | [Engineering best-practice guidelines](decisions/0200-engineering-best-practice-guidelines.md) |
| Scan | The 2026-10-24 design scan: lane PRs #552 (U5, kit and shell), #553 (U3), #554 (U2), #555 (U1, Shadow AI) and #556 (U4); owner triage on #453 (comment 6385378784); [session record](memory/sessions/2026-10-24-session-02.md) |
| X7 | Owner rule of 2026-10-19 on row actions, recorded at `RowActions` in [kit.tsx](../apps/web/src/ui/kit.tsx) |
| UX-26 | Owner rule of 2026-10-29: the UX best practices are the default for every screen unless the owner asks otherwise ([ADR-0200 addendum](decisions/0200-engineering-best-practice-guidelines.md)). Read from three owner-shared articles: uxpilot.ai "10 UX Best Practices to Follow in 2026", upslidedesignstudio.com "12 Principles for Better UX", and the LinkedIn Pulse "Designing for the User" |

"Enforced by" names the test or script that fails when the rule is broken. Where it says **review**, nothing automated
enforces the rule yet; reviewers check it by hand.

## Brand

- Spell the wordmark exactly `regulAIt`; never "Regulait", "regulait" or "RegulAIt". *ADR-0075. Enforced by
  [brand-contract.spec.ts](../apps/web/e2e/brand-contract.spec.ts) (about 15 routes) and the seed-text pin in
  `packages/shared/src/demo-intake/regulatory-updates.test.ts`.*
- Use the `WORDMARK` constant and the `Wordmark`/`Lockup`/`NodeMark` components from
  [Brand.tsx](../apps/web/src/ui/Brand.tsx); never retype the mark. *ADR-0075.*
- Never recolour, rotate, glow or outline the mark; its AI node is the only coloured element and is always Signal.
  *ADR-0075.*
- Use Gantari for headings, Figtree for body and UI text, IBM Plex Mono for ids, hashes, timestamps and kickers; never
  set body copy in the display or mono face. *ADR-0075.*
- Self-host every font; never load one from a CDN (air-gapped mode). *ADR-0075, [fonts.css](../apps/web/src/theme/fonts.css).*

## Copy

- Write British English ("organisation", "recognise", "analyse"). *Scan (#553 D4-11, #554 D2-10, #555). Review.*
- Format dates and times as en-GB through `fmtDateTime`, `fmtDay` or `fmtAt` in
  [format.ts](../apps/web/src/api/format.ts); never the browser's locale or a 12-hour clock. *Scan (#554 D2-01, #555).
  Pinned per screen; no lint.*
- Write sentence case; never `text-transform: capitalize` and never capitals for emphasis. *ADR-0168, Scan (#553 D4-10,
  #555). Review.*
- Never show a raw code or enum as a label; map it with `humanize` or a words table (`providerLabel`, `evidenceLabel`,
  `approvalStageLabel`), and show the code only as secondary mono text. *Scan (#553 D3-03, #554 D2-02, #555, #556).
  Pinned per screen.*
- Write real plurals with `plural(n, one, many)`; never "thing(s)", and make the verb agree. *Scan (#553 D3-09, #555,
  #556), [format.ts](../apps/web/src/api/format.ts). Review; some older specs still pin "(s)" strings.*
- Never put internal paths, script commands, slice ids or ADR numbers in admin-facing copy; say what the user does.
  *Scan (#555 shadow-ai-06 and FS-43, #554 D2-19). Enforced for one gateway string by
  [shadow-ai-copy.test.ts](../apps/gateway/src/shadow-ai-copy.test.ts); otherwise review.*
- Never name an AI vendor, model id or model family in copy, placeholders or help text; use fictional examples such as
  `acme-llm-sdk`. *Owner decisions F31 and F34, Scan (#555 shadow-ai-12). Enforced by
  [copy-vendor-names.mjs](../scripts/copy-vendor-names.mjs) in CI; a ternary inside a `placeholder` is not scanned yet.*
- Make help text match the shipped default. *Scan (#556 FS-53, guarded by `ssoDefaultsCopy.test.ts`).*
- Make link text say what the link does ("Report an incident from this alert"), and make breadcrumb and nav names match
  the page title. *Scan (#553 D3-02).*
- When changing copy, grep every distinctive prefix and substring of the old text before saying all pins are updated.
  *[mistakes.md](memory/mistakes.md) M-095.*

## Layout

- Keep one primary action per view and one accent. *ADR-0168.*
- Put content on near-opaque cards; never set text directly on the page gradient. *ADR-0169.*
- Lay out row actions in fixed slots with `RowActions`, so every row's primary button starts at the same x; keep an
  empty primary slot, use one `slot` value per table, and never move a destructive action into the primary slot.
  *X7, Scan (#555 shadow-ai-17/19, FS-42).*
- Give the row-action column a visually hidden "Actions" header, and give each row button an accessible name that
  starts with its visible label. *Scan (FS-42 in #553, #555, #556).*
- Fold wide tables with `FoldTable` (`fold: { md, sm }`) or pair values in one cell; fold moves values and never removes
  them, and no page scrolls sideways at 390, 1024 or 1440 px. *Scan (#556 runs-projects-19, #555 shadow-ai-16). Enforced
  by `apps/web/e2e/wide-tables.mock.spec.ts` and ADR-0196 `responsive.ent.spec.ts` (768–1920 px).*
- Make every navigation destination reachable without hover; the rail opens on focus and becomes a drawer at phone
  width. *ADR-0169. Enforced by `apps/web/e2e/theme-shell.mock.spec.ts`.*
- Pin decision and step-up rows in a drawer with `DrawerActions`, so they never scroll out of view.
  *[DetailDrawer.tsx](../apps/web/src/ui/DetailDrawer.tsx).*
- Use the spacing scale (`--s0` 4 px to `--s8` 64 px, with `--s-half`, `--s0-5`, `--s1-5`, `--s2-5`); never a literal
  px/rem value for padding, margin or gap. *ADR-0196. Enforced by the token ratchet below.*

## States

- Show a failed read as an error with Retry (`QueryGate`, `ErrorState`, `Table` `error`/`onRetry`, `RecordError`);
  never as an empty state, a zero or "off". *ADR-0200 #5, Scan (#553 D3-01, #554 D2-07, #555 shadow-ai-01/02, #556
  FS-45). Enforced by ADR-0196 `states.ent.spec.ts` (`role="alert"` on failure, every screen).*
- Show "—" or a skeleton while loading; never a zero that reads as a real value. *Scan (designer leads: KPI strip
  "0 Open" while loading).*
- Make loading announce itself: `SkeletonBlock` or `QueryGate` (`role="status"`), or `aria-busy` on the region.
  *Scan (#553 D4-01, #554 D2-17, #555 shadow-ai-03). Enforced by `states.ent.spec.ts` ("loading-not-announced").*
- Show a refusal inline with `RefusalNotice` and a next step; never only in a toast. *[RefusalNotice.tsx](../apps/web/src/ui/RefusalNotice.tsx).*
- Show "No such X" without Retry for a 404 or 400, an access message for a 403, and Retry for anything else; use
  `RecordError`. *[kit.tsx](../apps/web/src/ui/kit.tsx).*
- Wrap a card that can fail independently in `CardBoundary`. *[CardBoundary.tsx](../apps/web/src/ui/CardBoundary.tsx).*
- Never let a presentation change remove a warning, a step-up or a refusal. *Scan (owner triage, #453).*
- Never pre-select the permissive outcome; a decision drawer opens with no default that records a sanctioning choice.
  *Scan (#555 shadow-ai-13), [ADR-0180](decisions/0180-continuous-assurance-strict-by-default.md).*

## Accessibility

- Meet WCAG 2.2 AA on every screen in light and dark. *ADR-0196. Enforced by `a11y-routes.ent.spec.ts` (axe `wcag2a/aa`,
  `wcag21a/aa`, `wcag22aa`; serious and critical fail the build).*
- Make every target at least 24 × 24 px. *ADR-0196 (WCAG 2.5.8), Scan (#554 D2-09). Enforced by axe `target-size`.*
- Show a focus ring on every focusable element with `box-shadow: var(--focus-ring)` (never wrapped in another value),
  or a 2 px `--rg-signal-ring` outline on native form controls. *Scan (#552 FS-3, #553 FS-41). Enforced by
  `zz-kit-entry-a11y.mock.spec.ts` and the ADR-0196 keyboard walk.*
- Keep the four keyboard journeys working (sign-in, intake, approvals, settings step-up): skip link first, no lost,
  stuck or trapped focus, no positive `tabindex`, dialogs trap focus, close on Esc and return focus to the trigger.
  *ADR-0196. Enforced by `keyboard.ent.spec.ts` in three browser engines.*
- Never carry meaning only on hover: no explanatory `title=`; use `Badge info`, `Card info`, `Column info`
  (`InfoButton`) or visible text. *ADR-0169, Scan (#553 D3-05, #554 D2-04, #555 shadow-ai-07, #556 D5-18). Enforced
  per screen (`designer-audit-log.mock.spec.ts`, `ui-defects.mock.spec.ts`); `IdChip`, `StatusDot` and
  `SeverityBadge` still accept `title`.*
- Never use colour as the only cue; name the band or state in text. *Scan (#556 D5-04), ADR-0075 (Signal means
  interactive only).*
- Make sortable headers `<button>`s, navigation `<Link>`s (never `<div onClick>`), and let Enter and Space both
  activate. *Scan (#552 FS-4, FS-44, D5-11).*
- Use `aria-disabled` plus a guard, not `disabled`, on a busy button so focus stays. *Scan (#553 FS-19).*
- Pair `Tabs` (`idPrefix`) with a `role="tabpanel"` wrapper. *Scan (FS-46).*
- Put a count in a link's accessible name and mark the visual badge `aria-hidden`. *Scan (#552).*
- Respect `prefers-reduced-motion`; no smooth scrolling under it. *ADR-0169, Scan (#555 shadow-ai-05).*
- Keep the skip link as the first focusable element, `main#rgMain` focusable with `tabindex="-1"`, and no orphan
  labels or duplicate ids. *ADR-0075. Enforced by `brand-contract.spec.ts`.*
- Keep text tokens at their AA floor on their ground; `--rg-ink-faint` is decorative only. *ADR-0075, ADR-0169.
  Enforced by `brand-contract.spec.ts` and the worst-point check in `theme-shell.mock.spec.ts`.*

## Components

Use the kit before writing a one-off (ADR-0200 #7). The kit lives in [apps/web/src/ui](../apps/web/src/ui); the admin
helpers and formatters live next to it.

| Use | For | Where |
|---|---|---|
| `QueryGate` | Wrap a query: skeleton while loading, error with Retry on failure | [adminKit.tsx](../apps/web/src/views/admin/adminKit.tsx) |
| `ErrorState` | A failed read, `role="alert"` with Retry | [kit.tsx](../apps/web/src/ui/kit.tsx) |
| `RecordError` | A missing, refused or failed record | kit.tsx |
| `Table` | Every table; pass `error` and `onRetry` | kit.tsx |
| `FoldTable` | A table wider than its container | [fold.tsx](../apps/web/src/ui/fold.tsx) (lazy, kept out of the entry bundle) |
| `RowActions` | Fixed primary/secondary/rest slots per row | kit.tsx |
| `Badge` with `info` | A status with an explanation, via an `InfoButton` | kit.tsx |
| `SeverityBadge`, `statusTone` | The one severity vocabulary and the one status-to-tone map | kit.tsx |
| `IdChip` | Any id: eight characters, click to copy; never a raw UUID | kit.tsx |
| `Modal`, `ConfirmModal` | Every confirmation; never native `confirm()` | kit.tsx (ADR-0026) |
| `SkeletonBlock`, `EmptyState` | Loading and genuinely empty | kit.tsx |
| `DetailDrawer`, `DrawerActions` | Record detail; modal at 900 px and below | [DetailDrawer.tsx](../apps/web/src/ui/DetailDrawer.tsx) |
| `RefusalNotice` | A governed refusal with its next step | [RefusalNotice.tsx](../apps/web/src/ui/RefusalNotice.tsx) |
| `useToast` | Transient success only (`aria-live="polite"`) | [toast.tsx](../apps/web/src/ui/toast.tsx) |
| `focusFirst` | Moving focus after a change (WCAG 2.4.3) | [focus.ts](../apps/web/src/ui/focus.ts) |
| `plural`, `humanize`, `fmtDateTime`, `fmtDay`, `ago` | Plurals, code-to-words, en-GB dates | [format.ts](../apps/web/src/api/format.ts) |
| `PageHeader` | Breadcrumb-as-kicker header; last crumb `aria-current="page"` | [AppShell.tsx](../apps/web/src/shell/AppShell.tsx) |

Known kit gaps (fix in the kit, not per screen): `StatusBadge` prints the code with underscores replaced rather than
humanised; `IdChip` puts the full id only in `title`; the table header cells read as `cell`, not `columnheader`; there
is no shared visually-hidden utility yet; `providerLabel` is duplicated in `views/models/modelBindings.ts`. *Scan
follow-ups, [session record](memory/sessions/2026-10-24-session-02.md).*

## Theme and tokens

- Use `--rg-*` tokens from [tokens.css](../apps/web/src/theme/tokens.css) in new CSS; legacy aliases point one way only
  (`--surface-1: var(--rg-surface)`). *ADR-0075.*
- Never write a hex, named or functional colour, or a literal spacing value, in CSS or TSX. *ADR-0196. Enforced by
  [preflight-ui-tokens.mjs](../scripts/preflight-ui-tokens.mjs) against `scripts/ui-tokens.baseline.json`; findings may
  only shrink.*
- Use Signal (cyan) for interactive elements only; use the severity scale (`--rg-critical/high/medium/low-*`) for
  severity, the positive ramp for success, and `--rg-product-*` for identity chrome only. *ADR-0075.*
- Build dark mode as a token swap only: `:root[data-theme="dark"]` for an explicit choice, the
  `prefers-color-scheme` block for "system". *ADR-0026, ADR-0169; [mode.ts](../apps/web/src/theme/mode.ts).*
- Let a palette redefine only Signal, the field and the canvas, never ink or severity. *T1 palettes,
  [palettes.css](../apps/web/src/theme/palettes.css), checked for AA by `palette.test.ts`.*
- Read stored preferences inside `try`/`catch`, and keep the UI working when storage is blocked. *ADR-0169.*

## Performance

- Stay inside the bundle ceilings in [.size-limit.json](../apps/web/.size-limit.json) (gzip): entry JS 137.7 kB, entry
  CSS 10.7 kB, lazy `SeriesLineChart` 109 kB, lazy `RunGraphCanvas` 78 kB, all JS 1,040 kB. Raise a ceiling only through
  an ADR-recorded exception. *ADR-0196. Enforced in [ui-enterprise.yml](../.github/workflows/ui-enterprise.yml).*
- During freeze week (2026-10-29 to 11-03), raise entry JS plus CSS by at most 1 kB in total, and only for a
  demo blocker recorded in the PR body and in an ADR note. *ADR-0198.*
- Put heavy code in lazy, section-level chunks; never in the entry bundle. *ADR-0196 (U4 code splitting).*
- Keep LCP at or under 2,500 ms and INP at or under 200 ms on every screen. *ADR-0196. Enforced by `perf.ent.spec.ts`.*
- Keep logic in hooks and services; components only render. *ADR-0200 #2.*
- Keep server state in the query cache, and never cache across users, tenants or an authorisation decision.
  *ADR-0026, ADR-0200 #8, #13.*
- Debounce search, filter and typeahead input; paginate large lists; avoid unnecessary re-renders. *ADR-0200 #16–#18.*
- Compress images, minify, defer non-critical scripts, remove unused dependencies, and show loading skeletons.
  *ADR-0200 #11, #14, #19–#21.*
- Run Lighthouse locally against the production build of the main screens. *ADR-0200 #27.*

## UX best practices (owner, 2026-10-29)

These are the default on every screen. Depart from one only when the owner asks, and name the owner's comment in the
PR body. Secure by default (ADR-0180), the freeze (ADR-0198) and the bundle ceilings (ADR-0196) still win. New and
touched UI follows these now; existing screens are audited in a post-demo batch. Most rules extend one above, so the
rule above still applies. *UX-26 unless marked; "(our reading)" marks a detail the articles do not state, chosen by
the master session. Review, unless an enforcement is named.*

**Know the user and the task**
- Learn what users need before building: talk to people in the target roles and watch them work (interviews,
  observation), not only assumptions; record what you learned in the PR or session record.
- Design each screen around the task its user came to do (the demo personas are examples: Ada the admin, Avery the
  governance reviewer, Dana the developer, Morgan the security lead); state that task in the PR body for new screens.
- Ask for only what the task needs; every form field earns its place (an optional field says so, our reading).
- Cut steps: fewer clicks to the goal, save progress on long forms (a draft), and keyboard shortcuts for frequent
  actions (only where they do not conflict with assistive technology, our reading).

**Feedback and system status**
- Respond to every action at once: the control changes state (hover, pressed, busy) before the result arrives
  (within about 100 ms, our reading).
- Match the indicator to the wait: under 1 s nothing extra; 1–3 s a spinner or busy state; 3–10 s a progress bar or
  step count; over 10 s an estimate, and let the user leave and come back (a background run with a status the user
  can find again). A skeleton that matches the final layout beats a spinner for a page or card load.
- Confirm every outcome where the user is looking: success in a toast, a refusal inline (`RefusalNotice`), an error
  with what went wrong and the next step. Never leave a click with no visible result.

**Prevent errors before they happen**
- Constrain instead of rejecting: offer only valid choices (a date picker that greys out impossible dates, a select
  instead of free text for a known set); saying why a choice is unavailable is our reading.
- Validate inline, next to the field, in plain words (on blur rather than on every keystroke, and keeping what the user
  typed, our reading).
- Prefill likely values (the current project, the user's own team, the last-used filter), but never pre-select a
  permissive, sanctioning or relaxing outcome (ADR-0180; see States).
- Offer undo where the action can be reversed, and a confirmation for what cannot (preferring undo where both work is
  our reading); keep `ConfirmModal` for the irreversible (naming the object and the consequence in it is our reading) ("Delete connection live-jira? Its inbound secret stops working.").

**Recognition over recall**
- Show options rather than asking users to remember them: selects, typeahead with suggestions, recent items, and
  copyable ids (`IdChip`).
- Reveal complexity progressively: the common path first, advanced settings behind a clearly labelled disclosure (one
  that remembers its state, our reading).
- Use the conventions users already know (a trash icon deletes, Esc closes, a link navigates, a breadcrumb goes up);
  never repurpose one.

**Simplicity, hierarchy and space**
- For every element ask "does this help the task?"; then remove, hide until needed, shrink, or organise, in that order.
- Give each view one clear visual hierarchy: one heading, one primary action (Layout), using size, colour, spacing and contrast
  (size and weight before colour is our reading).
- Use whitespace from the spacing scale to group and separate; never fill space for its own sake.

**Navigation**
- Always show where the user is (the current nav item and the breadcrumb's last crumb marked current), where they can
  go, and how to get back; keep labels descriptive and menus short.
- Offer search or a filter where a list can grow past one screen (our reading).

**Readable type and calls to action**
- Keep UI text at `--text-md` or larger and page prose at `--rg-body-size`, with comfortable line height and a line length
  of about 60–80 characters on reading surfaces (our reading); use the type scale `--text-xs` to `--text-2xl`, never
  ad-hoc sizes, and keep to the three brand faces (Brand) with few weights.
- Write every button as a clear action that says what happens ("Approve request", "Run scan now"), and make the primary
  one stand out; avoiding "OK", "Submit" and "Click here", and reusing the verb in the result ("Scan started"), is our
  reading.

**Touch and small screens**
- Make primary and frequent controls at least 44 × 44 px under a coarse pointer, with room between them; 24 × 24 px
  (Accessibility) stays the floor everywhere. Keep primary actions within reach at phone width.
- Design the phone layout first for any new screen, then enhance for wide screens; test on a real device, plus the
  390 px and 768 px harness widths.

**Accessibility, beyond the rules above**
- Give every meaningful image or icon-only control a text alternative; mark decorative ones hidden.
- Test new screens with a screen reader as well as axe (NVDA or VoiceOver, our reading), and give time-limited
  interactions a way to extend.

**Personal, but private**
- Remember per-user working state where it saves effort (last filter, folded sections, the last-used project), in the
  user's own storage or profile; never a credential, never across users, and always resettable. Say what is
  remembered and offer a clear way to turn it off.

**Test with people**
- Usability-test every new or redesigned core flow with about five people in the target roles before calling it
  done, and record what changed as a result in the PR or session record. Hallway tests count; no third-party tracker,
  heatmap or analytics script is added to the product (air-gapped, ADR-0176).

## Security in the UI

- Never render raw untrusted HTML; keep the strict CSP. *ADR-0200 security checklist,
  [ADR-0031](decisions/0031-p0-hardening-streaming-exports-proxy-trust-rate-limits-csp.md).*
- Never hold a credential in the SPA: session in an HttpOnly cookie, nothing in local storage, no API secret in the
  bundle, no source maps in production. *ADR-0026, ADR-0200.*
- Send the CSRF header (`x-regulait-csrf: 1`) on every mutation through the API client. *ADR-0026.*
- Hide only what the server already refuses; enforce every permission server side. *ADR-0200.*
