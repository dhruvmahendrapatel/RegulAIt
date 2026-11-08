# regulAIt — modern UI direction (design proposal)

**Status:** proposal for owner review; documentation and illustrative mockups only. **No application implementation is authorised by this PR.**  
**Date:** 7 November 2026  
**Scope:** Midnight Aurora dark mode, Indigo & Emerald light mode, one coherent design system, three screen concepts, and a phased implementation plan.

## 1. Decision requested

Approve a *direction*, not a wholesale replacement of the shipped interface:
- **Dark:** Midnight Aurora, a restrained near-black operations workspace with cyan as the sole interactive accent.
- **Light:** Indigo & Emerald, a warm lavender-neutral canvas with indigo as the sole interactive accent. Emerald is **reserved for semantic success/positive evidence**, not a second competing call-to-action accent.
- **One design system:** shared density, hierarchy, components, navigation, interactions, content language, responsive behaviour and accessibility.
- **Three reference journeys:** executive command centre, My actions, AI use-case decision summary.

**Important existing-product reconciliation:** Aurora, Harbor, Evergreen, Graphite, Orchid and High contrast already exist in `apps/web/src/theme/palette.ts` and `palettes.css`, and the product already has light/dark modes. The proposed names are **art direction concepts**, not a request to create two competing palette systems or replace existing choices. First map the concepts to existing tokens, test contrast and obtain explicit approval for any new token or palette.

## 2. Visual tokens (illustrative, not approved production CSS)

| Role | Midnight Aurora / dark | Indigo & Emerald / light |
| --- | --- | --- |
| Canvas | `#090F1A` | `#F3F0FF` |
| Raised surface | `#172433` | `#FFFFFF` |
| Primary ink | `#F8FAFC` | `#211E45` |
| Interactive signal | `#22D3EE` | `#4F46E5` |
| Secondary decorative tone | `#A78BFA` (non-interactive) | `#DDD6FE` (non-interactive) |
| Positive semantic state | use existing product success token | `#059669` (illustrative; preserve product success token) |
| Warning semantic state | existing warning token | existing warning token |
| Danger semantic state | existing danger token | existing danger token |

**Do not recolour the wordmark or product AI node.** Existing brand identity in `internal/DESIGN_GUIDELINES.md` and ADR-0075 takes precedence. The sample images generated in the design discussion are exploratory and **not** evidence of the exact production brand treatment. Do not use a cyan/violet gradient on every button, or make colour the only state cue. Verify all pairings at WCAG 2.2 AA before implementation.

### Typography and shape
- Keep self-hosted **Gantari** for headings, **Figtree** for body/UI and **IBM Plex Mono** for technical IDs, per current brand rules.
- Emphasise large but concise metric numerals; supporting labels must state scope, units, time window and measurement state.
- Use existing spacing tokens, near-opaque cards, restrained radii, consistent fixed-slot row actions and one primary action per view.
- Support density appropriate to complex enterprise tables. Avoid glass-heavy translucent text surfaces and decorative glow behind important content.
- Motion: subtle hover/focus/selection feedback, reduced-motion support, never animation as the sole status indication.

## 3. Reference mockups

These are **schematic SVG design mockups** in this PR, not rendered screenshots or functioning UI. All numbers, records, deadlines and statuses are **fictional illustrative data**.

1. [Executive command centre](mockups/executive-command-centre.svg): persona-aware orientation, four actionable metrics, prioritised work and evidence context. Preserve existing `PosturePage.tsx` and `TrustDashboardPage.tsx` as authoritative drill-down surfaces.
2. [My actions](mockups/my-actions.svg): single discoverable entry point across permitted human work; filters by kind/urgency; source-of-truth records remain in the existing inbox and workbench.
3. [AI use-case review](mockups/use-case-review.svg): above-the-fold decision readiness, inherent versus residual risk, evidence gaps and explicit next action; preserve the existing 12 detailed tabs.

### What exists today (avoid duplicate development)
- `apps/web/src/views/admin/governance/PosturePage.tsx` already provides a board-shaped one-pager sourced from `GET /v1/reports/posture`, with explicit unmeasured-data honesty.
- `apps/web/src/views/admin/governance/TrustDashboardPage.tsx` already provides trust/evidence reporting.
- `apps/web/src/views/inbox/InboxPage.tsx` already aggregates personal approval work; `apps/web/src/views/admin/governance/ReviewWorkbenchPage.tsx` already adds routing, SLAs and reviewer workload over the **same** approvals ledger (ADR-0046).
- `apps/web/src/views/admin/governance/UseCaseOverviewPage.tsx` already includes 12 tabs and decision records.
- `apps/web/src/ui/DataList.tsx` already has sorting, filters, pagination, export and column preferences. ADR-0046 specifies saved views; verify current persistence before adding anything.
- `apps/web/src/shell/AppShell.tsx` and `suites.tsx` already implement grouped navigation and search; `CommandPalette.tsx` supports keyboard navigation.
- Enterprise responsive and keyboard Playwright tests exist in `apps/web/e2e/enterprise/`. **No tests were run as part of this design-only proposal.**

## 4. Proposed experience contracts

### Executive command centre
- Role-appropriate default landing, without hiding authorised routes or changing access controls.
- Each KPI links to a source-filtered record list; display the source, refresh timestamp, period and denominator where applicable.
- Distinguish **unmeasured**, **zero**, **loading**, **partial**, **error** and **not authorised**; never fabricate a reassuring value.
- Separate evidence coverage from compliance certification and estimated from measured spend.

### My actions
- One visible entry point; reuse `approvals` rows and existing decision endpoints, not a second queue or audit trail.
- Group by assigned to me, overdue, due soon and other genuinely actionable records where authoritative status exists.
- Permissions are enforced server-side; routing is not authorisation; escalation never auto-approves.
- Preserve step-up, refusal, quorum, per-item audit and high-sensitivity bulk restrictions.

### Use-case decision summary
- Top row: decision state, inherent risk, residual risk, evidence readiness, open conditions and owner.
- One contextual next action with direct links to the relevant existing tab or review flow.
- Explain whether a condition is a hard blocker or a post-decision obligation; never imply accepted risk was eliminated.
- Preserve existing approval authority, decision records, evidence, audit and deep-linkable tabs.

## 5. Unified design-system rules

- Semantic token families: canvas/surface/ink, **one** interactive signal, focus, borders, severity, confidence, evidence and measurement states. Palette changes must not change severity semantics.
- Shared building blocks: KPI card, evidence meter, status badge with accessible text, decision-readiness banner, priority row, filter chips, table empty/loading/error states and drawer action footer.
- Consistent layout: collapsible suite navigation, global search, clear breadcrumbs, stable page headings, purposeful whitespace, responsive table folding and a compact mobile action view.
- Follow `internal/DESIGN_GUIDELINES.md` as binding: wordmark, British English, sentence case, accessible targets, tokenised spacing, no raw enum labels, no invented success values.
- Meet WCAG 2.2 AA in both themes; keyboard focus, skip links, screen reader labels, contrast, 320–390px phones, 200%/400% zoom, reduced motion and no horizontal page overflow.

## 6. Phased implementation plan — requires separate approval

| Phase | Proposed work | Candidate files | Exit / acceptance evidence | Rough effort |
| --- | --- | --- | --- | --- |
| 0. Baseline | Inventory current tokens, role routing, screens, existing saved views and active designer PR conflicts; capture screenshots and test failures | `theme/palette.ts`, `theme/palettes.css`, `theme/tokens.css`, `shell/AppShell.tsx`, `ui/DataList.tsx`, `e2e/enterprise/*` | Owner reviews real screenshots, confirmed gaps and no-duplicate plan | 3–5 engineer-days |
| 1. Tokens & kit | Prototype both themes **within** current palette architecture; harmonise KPI, status, priority and decision-readiness components | `theme/*`, `ui/kit.tsx`, `ui/Brand.tsx` (review only; protect logo), `shell/shell.module.css` | AA contrast, unchanged brand, light/dark visual snapshots, keyboard focus | 6–10 days |
| 2. Executive entry | Improve hierarchy of existing posture/trust reporting, add authorised persona shortcuts and source-linked metrics | `views/admin/governance/PosturePage.tsx`, `TrustDashboardPage.tsx`, `shell/suites.tsx` | Accurate KPIs, deep links, honest empty/unmeasured states, role tests | 8–14 days |
| 3. My actions | Enhance existing personal inbox and workbench discoverability; only add other action kinds after source and permissions verified | `views/inbox/InboxPage.tsx`, `views/admin/governance/ReviewWorkbenchPage.tsx`, `api/approvalQueue*` | No duplicate decision path, preserved step-up/quorum, correct counts, role-isolated E2E | 8–14 days |
| 4. Decision summary | Add a concise, source-backed decision-readiness summary above existing tabs | `views/admin/governance/UseCaseOverviewPage.tsx`, existing lifecycle helpers | Accurate blockers, condition semantics, audit/deep links intact | 5–9 days |
| 5. Harden & roll out | Responsive, accessibility, visual regression, feature flags and opt-in rollout plan | `apps/web/e2e/enterprise/*`, existing tests, tokens | WCAG 2.2 AA, keyboard/mobile acceptance, no regression in enforcement | 6–10 days |

**Total preliminary effort:** ~36–62 engineer-days, subject to phase-0 verification and design approval. This is a **revised, reuse-first estimate**, not a commitment. Do not add a new endpoint or persistence table without proving existing facilities insufficient.

### Test and rollout gates
1. Baseline visual comparison in both themes, desktop/tablet/mobile, including loading, error, no data, denied and unmeasured states.
2. Existing `typecheck`, unit, build, Playwright enterprise keyboard/responsive/a11y suites and theme/token tests; add focused tests only for changed behaviour.
3. Verify no tenant data leakage, permission widening, second approval store, changed severity semantics or bypass of step-up controls.
4. Independent owner sign-off before **any** implementation PR, merge, deployment or production designation.

## 7. Out of scope and ownership

This PR does **not** change application code, CSS, runtime themes, data, APIs, CI, deployment, existing designer branches or existing PRs. It does **not** close, retire, overwrite or merge the existing designer's work. Existing designer PRs, including held UI changes, must be reconciled during phase 0 before any implementation.

**Owner decision needed:** approve/revise the visual direction, screen hierarchy and phased scope. **No implementation is authorised by approving or merging this documentation PR.**
