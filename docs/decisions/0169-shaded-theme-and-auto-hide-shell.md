# ADR-0169: A shaded colour theme and an auto-hiding navigation shell

- **Status**: Accepted (owner, 2026-10-03)
- **Date**: 2026-10-03

## Context

After the calm pass (decluttering) and the ADR-0168 governance flow, the owner judged the layout
right but the colour flat: a solid near-black navigation rail beside grey canvases. Reference
pages the owner supplied (kept out of this public repository) share one trait: backgrounds that are
never a single flat colour — soft gradients of related hues (blue→violet, green→teal glows) behind
crisp, readable foreground surfaces.

## Decision

1. **One shaded theme per page, both modes.** The app canvas carries a low-contrast, multi-hue
   gradient field built from the brand palette (radial and linear blends of related hues), the same
   field running behind the navigation rail so the page reads as one surface. Light mode uses pale
   tints; dark mode uses deep blues/violets with soft glows. No photographic or busy imagery.
2. **Legibility is not negotiable.** Text never sits directly on the gradient where contrast could
   drop: content sits on cards and panels with near-opaque surfaces; headings placed on the canvas
   are checked against the darkest/lightest point of the gradient. Every themed screen stays
   axe-clean (WCAG AA contrast) in both modes; `prefers-reduced-motion` disables any animated glow.
3. **Auto-hiding navigation with a pin.** The left rail collapses to a slim icon strip and expands
   on hover or keyboard focus; a pin control keeps it open, remembered per browser. Keyboard and
   screen-reader users reach every destination without hover. Contextual elements (filters, record
   actions) appear where they are needed rather than in the rail.
4. **Tokens, not one-off colours.** The gradient, glass and accent values are design tokens in the
   theme layer, so pages inherit the theme and severity colours keep their meaning (colour for
   exceptions, ADR calm-pass rules stand).

## Consequences

- Shell and theme files change (one owner per file during the build); page-level CSS mostly
  inherits. Screenshot-based demo assets are regenerated.
- A rail that hides by default changes muscle memory; the pin keeps the old behaviour one click
  away.
- Gradient backgrounds cost a little paint performance on low-end machines; they are static CSS
  (no canvas/WebGL) and respect reduced motion.

## Implementation (2026-10-03)

Built on `wt-g2-theme` and merged into the integration branch at `516280b`: `a88134e` (theme field,
glass surfaces, auto-hiding rail), `39df218` (the suite glyph in the rail takes ink, not Signal);
`2c6b92d` adds the review-policy glyph to the collapsed rail. Files: `apps/web/src/theme/tokens.css`,
`global.css`, `apps/web/src/shell/AppShell.tsx`, `shell.module.css`, `navIcons.tsx`. Full gate
on <sha>: see commit message. The Decision above is unchanged; three deliberate deviations from the pre-ADR token set:

- **Light `--rg-ink-muted` is one notch darker** — `#5d6064` (6.3:1 on white) instead of
  Graphite 500, so muted copy that sits on the shaded canvas itself (breadcrumbs, page subtitles)
  keeps AA at the field's worst point, not only on a white card. Dark `--rg-ink-muted` is
  `#9a9fa8`.
- **The `--rg-dark-*` stack is navy, not graphite** (`#0d1326` / `#182039` / `#283252`, muted
  `#949bab`), so the always-dark pieces (the record header band, the review banner) belong to the
  same field; the dark-theme grounds moved to matching navies.
- **The rail is themed, not always dark.** It used to be the one surface painted near-black in both
  modes; it is now translucent over the same field, with ink that follows the theme
  (`--rg-rail-*` tokens), and near-opaque (`--rg-rail-bg-overlay`) when it opens over content.

**How the rail behaves.** It rests as an icon strip; hover opens it as an overlay, keyboard focus
opens it with the content making room; **Pin navigation** (a toggle with `aria-pressed`) keeps it
open, remembered per browser, and the page still works when storage is blocked. At phone width it
is a drawer. The field is static CSS (no animation), so `prefers-reduced-motion` has nothing to
stop.

**Evidence.** `apps/web/e2e/theme-shell.mock.spec.ts` (9 tests): strip, hover, focus, pin,
storage-blocked and phone drawer; axe clean in both themes; and a pixel-measured worst-point
contrast check — axe cannot judge text over a gradient, so the test hides every foreground
element, screenshots the bare field (rail pinned and unpinned), takes the lightest and darkest
pixel under the canvas and under the rail (every third pixel), and requires 4.5:1 for muted ink and
link ink on the canvas and for rail ink and muted rail ink on the rail. Worst-point
muted ink on the canvas measured **4.81:1 light / 5.47:1 dark**. `--rg-canvas` is set to the
field's worst-point colour so the brand-contract token checks measure against the real ground.
The web unit suite (156/156) and the mocked UI suite (86/86) ran green on the integrated tree.

**Honest limits.** The light field's tints are kept pale on purpose: muted text on the canvas
clears AA with 0.31 to spare (4.81 vs 4.5), so any stronger tint, or a muted token one notch
lighter, would fail the worst-point check — the shading is gentler in light mode than in the
reference pages. Contrast is measured at one viewport size; the radial glows are sized in
`vw`/`vh`, so other sizes shift where the worst point falls and are not measured. Screenshot-based demo assets (the fallback deck) must be regenerated
from a fresh run before the demo.
