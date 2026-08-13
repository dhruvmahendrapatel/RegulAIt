# ADR-0075 — Adopt the regulAIt brand package and the regulAIt UI Structures contract in the SPA

- **Status**: Accepted
- **Date**: 2026-08-13
- **Migration**: **none** — this is a presentation-layer decision. No schema, no API, no
  governance semantics change.
- **Supersedes**: the ad-hoc indigo/Inter palette that `apps/web/src/theme/tokens.css` carried
  since the SPA rewrite (ADR-0033). That palette was invented here and had no external authority;
  it is replaced rather than amended.

---

## 1. Context — two standards arrived, and they appeared to conflict

The owner supplied two artefacts:

1. **regulAIt Brand Guidelines v1.0** (August 2026) — the node mark, the wordmark, Signal Cyan,
   the Graphite ramp, the Gantari/Figtree/IBM Plex Mono type stack, the four product accents,
   the four-step severity scale, motion, and an explicit Do/Don't list.
2. **regulAIt UI Structures** — structural patterns measured from a working sibling app
   (regulAIt Authorized, 131 views): the app shell, the token-name contract, the list-page and
   drawer patterns, the label-vs-caption distinction, an accessibility contract "to assert in CI",
   and a Traps section of failures that each cost real time.

A third artefact shipped inside the same zip: an **"Organic" design system** — cream ground,
terracotta and sage accents, Caprasimo display, 16px radii growing to pills. It is visually
incompatible with the brand package on every axis.

**It does not govern this app, and the evidence is decisive rather than a judgement call.** The
Organic bundle is a generic design-system export (it ships its own `theme.json`, `templates/` and
component pages, and describes no product). The UI Structures document, by contrast, is titled
"UI structures for **regulAIt apps**", says outright that "the brand package gives you colour, type
and the mark", and renders itself in Gantari/Figtree/IBM Plex Mono over Graphite and Signal Cyan —
i.e. it is built out of the brand package it points at. The two regulAIt artefacts agree with each
other and disagree with Organic. Organic is treated as unrelated material that travelled in the
same archive.

## 2. Precedence, which the documents settle themselves

The UI Structures document states its own subordination, and we adopt it verbatim:

> **Precedence when they disagree:** the brand package wins on colour, type and the mark. This
> document wins on structure and markup contracts.

So: **values come from the Brand Guidelines; names and structure come from UI Structures.** Where
this repo's prior conventions disagree with either, they lose — except where a deviation is
recorded in §5 below.

## 3. Decision

### 3.1 The token contract is the API

`apps/web/src/theme/tokens.css` is rewritten around the `--rg-*` names the UI Structures document
specifies, because that document is explicit that the names *are* the interface:

> "Names are the API. Values come from the brand package — a second app should redefine the values
> and keep the names, so shared components carry over untouched."

Every value is taken from the Brand Guidelines: the twelve-step Graphite ramp, the light stack
(bg 50 / surface white / stroke 100 / muted 500 / ink 900), the dark stack (bg 950 / surface 900 /
raised 800 / stroke 700 / muted 400 / ink 50), Signal Cyan with its 400/700 steps, the four product
accents, and the four-step severity scale with its `-deep` text variants.

**The SPA's original token names are kept as one-directional aliases** (`--surface-1: var(--rg-surface)`)
rather than being renamed at ~500 call sites in one commit. This was the deciding factor in scoping:
a survey found **zero hardcoded hex outside `src/theme/`** — every colour in every CSS module
already flowed through a token — so swapping the values propagated the entire brand with no
component edits and no risk to the 86 existing Playwright assertions. New CSS uses `--rg-*`;
aliases never point the other way.

### 3.2 The dark rail is the only dark surface

Per the shell contract, the sidebar reads from `--rg-dark-*`, which holds the same values in both
themes — the rail does not invert with the theme toggle. Its active/hover indicator is a Signal
left edge rather than a filled pill, since Signal means *interactive* and nothing else in the rail
is coloured.

### 3.3 The mark, the wordmark, and the spelling

`apps/web/src/ui/Brand.tsx` is the single place the mark's rules live: four Graphite anchor nodes,
edges at stroke weight 1/16 of mark height with round caps, and the AI node — the only coloured
element — always Signal Cyan.

The brand's Don't list forbids writing "Regulait", "regulait" or "RegulAIt". The wordmark is
**`regulAIt`**. This is not cosmetic: the app had shipped "RegulAIt" in user-visible copy on every
screen, including the admin nav entry "RegulAIt-LLM". That copy is corrected, and the rule is now
enforced mechanically (§4).

### 3.4 Type

Gantari (display), Figtree (body/UI), IBM Plex Mono (data) are **self-hosted**, as the token
contract requires — "no CDN, no network dependency". Gantari and Figtree are variable fonts, so one
woff2 each covers the full weight range; the four files total ~90KB and are imported through Vite so
they are fingerprinted and resolved against `base`. Self-hosting is not only a brand rule here: an
off-origin font request would break the air-gapped deployment mode (ADR-0062).

Headings take Gantari at 600–800; body and UI copy take Figtree at 13–16px; control IDs, hashes,
timestamps and kickers take IBM Plex Mono with tabular figures. "Never set body copy in Gantari or
the mono" is asserted, not merely documented.

### 3.5 Structure

Adopted from UI Structures: the skip link as the first focusable element; `main#rgMain` with
`tabindex="-1"` as its target; breadcrumb-as-kicker page headers where only the last item carries
`aria-current="page"`; the `.rg-mono` / `.rg-truncate` / `.rg-kicker` / `.rg-caption` utilities; and
the label-vs-caption distinction, which the source document reports was the single most common
defect in its own codebase (252 of 303 `<label>` elements had no control).

## 4. The accessibility contract is executable

UI Structures lists seven invariants and asks for them to be asserted in CI. They now are, in
`apps/web/e2e/brand-contract.spec.ts`, **driven in a real browser rather than checked against the
stylesheet**. That choice is the whole point: the document's own Traps section records a page that
returned HTTP 200 while rendering its full markup into a zero-height container. A CSS assertion
would have passed. So the spec asserts `main#rgMain` *resolves to a non-zero box*, and asserts the
skip link is genuinely the first tab stop by pressing Tab — not that the element exists.

Two things this spec taught us while being written, both recorded because they generalise:

- **A priming click invalidates a focus test.** The first draft clicked the page before pressing
  Tab. Clicking sets the document's *sequential focus navigation starting point*, so Tab resumed
  past the sidebar and skipped the link. The spec failed against correct markup, and the first fix
  attempted was a CSS change to the skip link. The CSS was not the bug. A fresh navigation leaves
  no starting point, which is also the state a real keyboard user is in.
- **A green contract can be green for the wrong reason.** The wordmark check passed on its first
  run. It was passing because the route list did not cover the pages carrying the offending copy,
  and because a word-boundary regex let "RegulAIt-LLM" through on a trailing hyphen. Tightening
  both made it fail on 14 of 15 routes — which is what a non-vacuous assertion looks like. This is
  the same lesson as the three scoring inversions in ADR-0072: *check that the test can fail.*

## 5. Documented deviations

The Traps section is explicit that when the brand is silent, the call must be made openly and
written down, because "an undocumented improvisation becomes precedent the next person can't
question." Three:

1. **Success/positive hue.** The brand defines none. We borrow the **regulAIt Governed** ramp
   (`#45bf82` / deep `#006e40` / tint `#d9f3e2`), which is the same remedy — and the same source
   family — the sibling app chose. Severity supplies the reds and ambers; Signal stays interactive;
   green means "passed".
2. **Radii and spacing.** The brand is silent on both. The radius scale (`--rg-r-*`) and the 8px
   spacing scale (`--s0`…`--s8`) are ours; the spacing scale predates the brand package and is
   unchanged.

   **2b. `--rg-medium-deep` is darkened from the brand's `#86700a` to `#7f6a09`.** The brand asserts
   that each `-deep` step "passes AA as text on light grounds", and separately specifies severity
   pills as "16% accent tint fill, 700-step text". Measured, `#86700a` clears AA on white (4.84:1)
   but lands at **4.44:1 on its own tint** and **4.38:1 on the canvas** — it misses the floor in
   both of the places the brand actually puts it. This is the brand's own claim not holding for one
   of its four severity steps, not a disagreement with it, so the value moves one step darker in the
   same hue and clears all three grounds (4.85 / 5.29 / 4.79). This is the only brand-supplied value
   this ADR changes.
3. **Product accent.** `--rg-product-*` carries the regulAIt Governed accent, because this app's
   own shell has described itself as "governed" since before the brand package existed — an
   existing choice, not a new one. It is identity chrome only: it paints the lockup descriptor and
   nothing else, never an action and never a severity. It therefore currently shares its value with
   `--rg-positive-*`; the two stay separate tokens because they answer different questions and a
   sub-product rebrand must be able to move one without moving the other.

## 6. Consequences

- The entire SPA — ~65 routes — changes appearance from one file, with no component edits, because
  the pre-existing token discipline held.
- `--rg-*` and the legacy alias names coexist. That is a deliberate, bounded duplication with a
  stated direction of travel; the risk is that new CSS reaches for a legacy name out of habit.
- The wordmark rule is now enforced on 15 routes. Copy added to an unvisited route can still drift;
  widening the route list is the remedy, and the list is the honest limit of the guarantee.
- Nothing about governance, entitlement, audit or cost semantics is touched by this ADR.

## 7. What is NOT done

- **The `--rg-*` migration is not finished.** Legacy aliases remain at ~500 call sites. They are
  correct, not wrong — but the contract's promise ("redefine the values, keep the names, and shared
  components carry over untouched") is only fully realised once components name `--rg-*` directly.
- **The list-page / drawer / table conventions are adopted as utilities and page-header structure,
  not as a wholesale re-layout.** UI Structures describes a Bootstrap/DashForge DOM (`off-canvas`,
  `table-responsive`, `card-header` toolbars); this SPA is React with CSS modules. The *contracts*
  port; the class names do not. Re-cutting every list page onto the one-card-with-toolbar pattern is
  a separate, larger piece of work.
- **Contrast beyond the token pairs is not swept.** The 22 token pairs that carry text are measured
  in the browser (§4) and every one clears its floor, but no sweep walks *rendered* text against the
  ground it actually landed on — a component that puts `--rg-ink-faint` on a tint would not be
  caught. The first version of those ratios lived only in hand-written comments and **was wrong in
  eight of thirteen places, including one overclaim**, which is why they are now measured and why
  the test asserts a floor rather than a value.
- **The Organic design system is unused.** If the owner intended it to govern instead, this ADR is
  the thing to supersede — the token indirection means the change is values-only.
