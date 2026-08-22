# ADR-0094 — Suite-scoped navigation: the home launcher and the one-suite-at-a-time sidebar

- **Status**: Accepted
- **Date**: 2026-08-22
- **Migration**: none — presentation layer only. Every route path, entry label, API call and
  contract-language string is byte-identical; bookmarks, deep links and existing Playwright
  locators that address routes survive unchanged.
- **Subordinate to**: [ADR-0075](0075-brand-identity-and-ui-structure-adoption.md) (tokens, type,
  the mark, the sidebar as the only dark surface — all untouched and still browser-asserted).
- **Amends the presentation of**: [ADR-0093](0093-console-information-architecture.md) — its
  groupings, labels, orderings and breadcrumb derivation all stand; what changes is that the
  eleven sections are no longer all on screen at once.

---

## 1. Context — a correct IA that still put every product in front of every person

ADR-0093 organized ~50 admin destinations into eleven sections by the question each answers, and
that structure is right. But it renders as ONE rail: a person working the access-review loop
scrolls past cost tooling, integrations plumbing and installation settings on every glance at the
nav. The owner's direction is verbatim: *"We need to move each product on its own pages, that can
be navigated from the home page / Dashboard Tiles. Eg. someone working in governance suite, i do
not see a reason to confuse them with all the other options. It would be better to put it in its
own page."*

## 2. Decision

### 2.1 One source of truth: the suite layer over ADR-0093's sections

`apps/web/src/shell/suites.tsx` now holds the nav data (moved from `AppShell.tsx` verbatim, every
ADR adjacency comment intact) plus a `SUITES` array: each **product suite** is a named set of
ADR-0093 sections, referenced **by section name** — membership is never re-listed, so the launcher,
the sidebar and the switcher cannot drift from each other or from 0093's judgement. A section no
suite claims is appended as its own suite at module load: adding a nav group can never strand its
entries. The suites, in launcher order:

Workspace · AI Governance · Access Reviews · Approvals & Audit · Policies & Gates ·
Quality & Security · Compliance & Infra · Cost & Optimization · Identity & Access ·
Integrations · Settings

The one coalescence: **Overview (Posture · Reports · Governance copilot) presents under the
AI Governance suite.** "Where do we stand?" is the read side of the governance question, and a
three-entry suite of read-only projections did not earn its own tile. The Overview *section
heading* survives inside the suite's sidebar, and `GROUP_OF_PATH` — hence every breadcrumb — is
untouched, so pages still say `OVERVIEW / POSTURE`.

### 2.2 Home is the product launcher

After the first-run orientation and the at-a-glance stats (which stay exactly where the
2026-08-22 rework put them — numbers always on, prose collapsible), the admin home renders one
tile per suite from that same array: an SVG glyph in the kit's icon discipline, the suite name,
a one-line purpose, and a live number **only where a query the page already runs can supply
one** — approvals pending (Approvals & Audit), run count (Workspace), attributed spend
(Cost & Optimization), setup progress (Settings). Deduped by query key; zero per-tile fetches; a
suite without a cheap number shows none rather than inventing one. The dashboard cards below the
tiles are unchanged. Non-admins hold one suite, so they get no launcher and no switcher — their
sidebar is the same Workspace list as before.

### 2.3 The sidebar shows one suite, plus two constant affordances

Inside any route the rail renders: **Home** (back to the launcher), a compact **suite identity
header** naming the scope, a **suite switcher** — a native `<select>` restyled onto the dark
stack: keyboard-accessible for free, compact at phone widths, listing every suite — and then only
the active suite's own sections and entries. The active suite is derived by longest-prefix route
match, so detail routes (`/runs/:id`, `/projects/:id/context`) scope through their list entry.

### 2.4 The `/` filter stays cross-suite — the anti-stranding invariant

The nav filter searches **every destination in every visible suite**, exactly as before, and its
results render grouped under their ADR-0093 section headings. This is stated as an invariant, not
an implementation detail: with the sidebar scoped, the filter is the escape hatch, and scoping it
to the current suite would strand users inside whatever tile they clicked first. Selecting a
result navigates, clears the filter, and re-scopes the sidebar to the destination's suite. Every
destination is therefore reachable three ways: its suite's tile, the switcher, and the filter —
`zz-zz-zz-suite-navigation.spec.ts` asserts the full suite-by-suite matrix, and the deliberate
breakage record (switcher rendered as nothing; filter scoped to the current suite) reddened the
specs that guard each affordance before this shipped.

## 3. Spec accounting — what changed and why it is equal strength

phase2's "all eleven section headings visible" became: every suite present in BOTH the launcher
tile grid and the switcher (with exact counts — no surprise extras), plus a scoping proof (the AI
Governance suite renders its own entries and no other suite's). Same property — every ADR-0093
group visible-by-affordance and reachable — restated for the IA that replaced always-on headings.
phase2's `nav()` helper and phase4/5/6's cross-suite sidebar clicks now travel through the
filter, so every admin journey exercises the escape hatch it depends on. Nothing was weakened:
121 baseline tests still pass, plus six new ones.

## 4. Honest limits

- **Suite membership is ADR-0093's judgement, re-presented.** No new placement arguments were
  made; if a section's grouping is wrong, fix it in the sections and the suites follow.
- **The Overview coalescence is this ADR's one judgement call** — made for tile economy, not from
  usage data, and reversible by giving Overview its own suite entry in one array.
- **No per-user tile customization, no telemetry-driven ordering.** Every admin sees the same
  tiles in the same hand-chosen order; the live tile numbers are the same reads the home cards
  already make and inherit those endpoints' semantics (spend remains a list-price estimate where
  ADR-0047/0051 say so).
- **The switcher is a native select** — robust and accessible, but it renders the OS popup, not a
  branded menu. A richer menu is a purely visual upgrade later; the contract (keyboard-accessible,
  lists all suites, switches scope) is what the specs pin.
- **One extra click to cross suites by mouse** (Home or switcher or filter, instead of a long
  scroll). That is the trade the owner asked for; the filter keeps the fast path at one keystroke.
