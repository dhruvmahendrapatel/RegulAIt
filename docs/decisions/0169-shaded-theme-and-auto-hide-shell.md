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
