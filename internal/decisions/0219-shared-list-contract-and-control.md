# ADR-0219: One list contract and one list control for growing lists

- **Status**: Accepted (owner, #453 comment 6527514889, approving the list-control sample)
- **Date**: 2026-10-30
- **Builds on**: REL-10 (`apps/gateway/src/list-limit.ts`), ADR-0031 (keyset pagination and streamed exports,
  `pagination.ts`, `csv-export.ts`), ADR-0176 (open source first), ADR-0180 (secure by default), ADR-0196 (UI
  budgets), ADR-0200 (paginate large lists; logic out of components)

## Context

The lists that grow without bound read a silent first page: `/v1/runs` and `/v1/incidents` stopped at 200 rows and
`/v1/users` at 1,000, with no way to see the rest, no total, and sorting done in the browser on whatever page had
arrived. A sort that only orders the rows on screen answers a different question from the one the header asks, and a
list that quietly stops at 200 reads as the whole history. Each list also needed an export, and there were already two
paging patterns in the gateway (the REL-10 bound and the keyset cursor) that a third ad hoc one would have joined.

## Decision

1. **One gateway contract, opt-in per request** (`apps/gateway/src/list-contract.ts`, beside `list-limit.ts` and
   `pagination.ts`). A list route declares a `ListSpec`: its sortable columns as an allow-list of column id → SQL
   expression, its exportable columns (id → screen label and cell value), its filter fields and its default sort.
   The route keeps its own WHERE (object-level authorisation and filters), and the page, the count and the export all
   read through that one predicate.
   - Query: `limit` = 10, 50, 100 or 500 (500 only for "All" chunks; never above 500); `cursor` (keyset, the existing
     `encodeCursor`/`decodeCursor`) on a not-null timestamp sort, or `offset` for any other sort, never both;
     `sort=<colId>` and `dir=asc|desc`; `count=exact|estimate`.
   - Response: `{ items, nextCursor, nextOffset, total, totalIsEstimate }`. `nextOffset` is the one addition to the
     approved shape: it tells an offset-paged reader where the next page starts, as `nextCursor` does for a keyset one.
     Both are null on the last page, decided by reading one row past the page.
   - An unknown sort column is a 400 (`unknown_sort_column`), checked as an own property of the allow-list, so a
     column id is never interpolated; the direction picks one of two constant SQL fragments. Nulls sort last, and the
     row id breaks ties in the same direction, so paging returns every row exactly once.
   - `count=estimate` is a bounded count: it stops at 1,001 rows and past 1,000 answers `total: 1000,
     totalIsEstimate: true`, which the UI shows as "of 1,000+". It never invents a number.
   - A caller that sends none of `sort`, `dir`, `cursor`, `offset` or `count` gets the route's old response, rows and
     limits unchanged (the Home previews keep their small reads).
2. **The Excel export is built by the gateway**: `GET <list route>/export.xlsx?<same filters>&sort&dir&columns=a,b,c`.
   The columns are checked against the list's allow-list (unknown or repeated is a 400), the file holds every row
   matching the filters and sort, only the requested columns in that order, with the screen's labels. It answers with
   the list route's own authorisation: a non-admin's runs export holds only their runs, the incidents export only
   what the caller may see, and `/v1/users/export.xlsx` is admin-only through the default gate. It is capped at the
   CSV exports' ceiling (`REGULAIT_CSV_MAX_ROWS`, 500,000 by default); when that stops it, the file's last row and the
   `x-regulait-export-truncated` header say so and the UI repeats it. Each export writes one audit row (`audit_export`,
   rule `list-export-xlsx`, with the list id, filter summary, sort, column ids and row count) right after the query and
   before the first byte, so a failed audit write fails the export.
3. **The library**: `write-excel-file` 4.1.1 (MIT, released 2026-06-08, one dependency, `fflate` 0.8.3, MIT; no native
   code, no install script, no network), pinned exactly and listed in `apps/gateway/THIRD_PARTY.md`. Rejected: ExcelJS
   (no release since 2023-10), SheetJS (the npm package is 0.18.5; current builds ship only from the vendor's CDN, which
   breaks the pin and air-gap rules) and `xlsx-populate` (a reader and editor on jszip and lodash). It writes text as
   text cells, never formulas. It builds the sheet in memory rather than row by row; the cap above bounds that.
4. **One UI control** (`apps/web/src/ui/DataList.tsx`, its CSS module and `listState.ts`), built on the kit `Table`
   through one optional, isolated prop (`sort`, a server sort the table does not redo):
   - Rows per page 10, 50, 100 or All, starting at 10 and remembered per list in this browser
     (`regulait.list.<listId>.size`); where you are ("11–20 of 1,284", "of 1,000+", "Loaded 1,000 of 1,284"); Previous
     and Next; All loads 500 rows at a time as the end of the list scrolls into view, with a visible "Load next 500"
     button as the fallback.
   - Refresh (an icon button named "Refresh runs"), the column picker (a gear opening the kit `Modal`, with show/hide
     checkboxes and Up/Down; focus returns to the gear), and Download Excel (a plain authenticated download).
   - Each list declares 5–7 main columns; the rest start hidden. Status and warning columns are `required`: their
     checkbox is shown disabled with the reason. The choice and order are remembered per list in this browser
     (`regulait.list.<listId>.columns`). Every storage access is wrapped; nothing stored is a credential.
   - A column the server cannot sort says so in its (i) and in the picker; nothing is sorted in the browser.
   - The icon buttons are named by a tip that shows on hover and on keyboard focus and is dismissed with Escape.
   - Filters and search run on the server (the users search is debounced and matches `%` and `_` literally).
5. **Pilot lists**: `/runs`, `/incidents` and `/admin/users`, and no others in this change.

## Consequences

- One pattern for every later list: declare a `ListSpec`, pass the route's WHERE, render `DataList`.
- The last-admin guard on Users now counts active admins on the server (`role=admin&status=active&count=exact`),
  not from the page on screen.
- Sorting a large table by an arbitrary column walks an OFFSET; the default sorts seek on a timestamp. No index was
  added in this change (no migrations). Indexes worth adding once the tables grow, for the default sorts and the
  non-admin runs scope: `orchestration_runs (initiating_user_id, created_at desc, id desc)` and
  `(created_at desc, id desc)`; `ai_incidents (created_at desc, id desc)`; `users (created_at, id)`. The incident sorts
  by next clock, open actions and owner name are correlated subqueries per row.
- The export holds its rows in memory up to the 500,000-row ceiling. A streamed xlsx writer that meets ADR-0176 would
  remove that; none was found.
- All JS grows by about 6 kB gzip, within the owner's shared 1,060 kB cap (ADR-0196 addendum of 2026-10-30). The entry
  ceilings do not move.
