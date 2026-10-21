# Mockup: wide tables fit their cards (F6 / F20 / F21 / F25)

For owner approval on #453. **Mockup only: no product code is merged from this branch.**

Rendered with the real components (origin/main `5784b4f` plus a throwaway local diff), mocked API data and Playwright
(`playwright.demo-mock.config.ts`), the same way the repo's `*.mock.spec.ts` specs render. Each image is BEFORE (main, left)
and AFTER (mockup, right). Mock data uses made-up provider names. For the capture only, the sticky top bar is made static so it
doesn't paint over the middle of a tall full-page clip.

## How it works (one kit change, used by all four tables)

- **`Column.fold`** (kit `Table`): a column can say "below this table width, show my value inside column X".
  - Steps: `md` = table narrower than 1000 px (a laptop, or the page beside the drawer); `sm` = narrower than 600 px (a phone).
  - The step is read from **the table's own width**, so opening the drawer folds the table even on a wide window.
  - A folded value appears in the host cell as a labelled line ("Seen 6 times"). Its header and (i) join the host header ("Subject · Evidence (i) · Seen"), so no help is lost.
  - Empty values move without their label.
- **`Card.caption`**: the caption sits under the title, outside the scroll box, so it is never scrolled away or clipped.
- The horizontal scroll stays only as a last resort. Measured overflow after the change is **0 px** for every table at 1440, 1024 and 390, with the drawer open at 1440 and 1024. Before the change it was 12–895 px.

## Per table

| Table | Before | After |
|---|---|---|
| Shadow AI **Inventory** (F6, F21) | 8 columns. At 1440 it is 105 px too wide. With the drawer open, the box scrolls sideways and the caption reads "…ow is a lead…". | **Where seen** joins **Evidence** (badges, then the "▶ N places" disclosure). Below 1000 px, Evidence and Seen move into Subject and Confidence moves under Severity. On a phone the row is one labelled column. The caption is outside the scroll box. |
| Discovery sources **Recent runs** (F20) | A half-width card next to Reveal a pseudonym. Source names wrap one word per line, and Findings, Catalogue gaps and Reads are cut off. | **Full-width card.** Reveal a pseudonym moves to its own row below it, unchanged. Below 1000 px, Queued moves under Source, Observed/matched under Findings, and Reads under Status. On a phone, Findings and Gaps also move under Source. |
| Audit log **Entries** (F25, G8) | The Event column doesn't wrap, so **Evidence** is cut to "Evidenc" at 1440. At 1024 it is 228 px too wide. | The object type is a faint line above the event, so Event wraps. Below 1000 px, User moves under At and Deploy mode under Effect. On a phone every value is a labelled line under Event. On a phone the card header wraps instead of squeezing the title to one word per line. |
| Use-case audit trail (F25, G1d) | The same table, filtered: 160 px too wide at 1024. | The same fix. The "Showing the audit trail of one AI use case" status line is unchanged and stays visible. |

## Secure by default (ADR-0180)

- Nothing that warns, refuses or decides is hidden by a fold. Folded values are moved, not removed: Seen again, Blocked, require approval, could not read, and the row actions are all still shown.
- The "Seen again" callout above the Inventory is unchanged.
- No new scroll box. KEEP_VISIBLE is unchanged.

## Accessibility

- **Keyboard:** the tab order is unchanged; a folded control keeps its place in the row. With no sideways scroll, focus no longer scrolls the table out from under the caption (F21).
- **Screen reader:** each folded value is labelled with its column name. The host header names the folded columns, and their (i) buttons stay reachable once, in the header. Folded columns are not rendered twice, so there are no duplicate ids or names.
- **Touch:** buttons keep their size, and the row actions keep the X7 slots.
- **Reduced motion:** no animation is added.
- **Themes:** `dark-*.png` shows the after state in the dark theme.

## Estimated code change (HOLD PR from main, after approval)

| Area | Files | Size |
|---|---|---|
| Kit: `Column.fold`, `Card.caption` | `ui/kit.tsx`, `ui/kit.module.css` | ~105 lines |
| Pages: fold settings and merged cells | `ShadowAiPage.tsx`, `DiscoverySourcesPage.tsx`, `AuditLogPage.tsx` | ~50 lines |
| Tests | kit unit test (fold, chain, empty value); one mock spec asserting no overflow past the card at 1440, 1024 and 390, and with the drawer open; small updates to `designer-shadow-ai`, `designer-audit-log` and `demo-screens` (the Where seen column, the half-width Recent runs) | ~150 lines |

About 300 lines in total, presentation only, no backend, no migration. After it merges, the demo screenshots get one more refresh.

Open-source check: no library is needed for this, because the browser's own layout and ResizeObserver are enough. The table libraries already in the ecosystem hide columns but don't move their values into another cell.
