/**
 * The one list control (ADR-0226, owner-approved on #453): page size (10, 50, 100 or All, remembered per list in this
 * browser), where you are ("11–20 of 1,284"), Previous and Next, Refresh, server-side sort on every column the server
 * can sort, a column picker, and an Excel download built by the gateway. Built on the kit `Table`; pages pass the
 * columns, the endpoint and their filters, and keep their own cards, filters and actions.
 *
 * Everything that changes rows runs on the server: sort, filters and search apply to all rows, never just the page on
 * screen, and the download holds every matching row with the columns on screen, in screen order. A column the server
 * cannot sort says so in its (i) rather than being sorted in the browser.
 *
 * Its own module, loaded only with the screens that use it: the entry bundle does not grow.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQuery, keepPreviousData } from "@tanstack/react-query";
import { api } from "../api/client";
import { downloadCsv } from "../views/admin/adminKit";
import { Button, Modal, Select, Table, type Column, type TableProps, type TableSort } from "./kit";
import { useToast } from "./toast";
import {
  ALL_CHUNK,
  PAGE_SIZES,
  exportUrl,
  loadColumnPrefs,
  loadPageSize,
  loadedText,
  moveColumn,
  nextSort,
  normalisePage,
  pageUrl,
  prefsOf,
  rangeText,
  resolveColumns,
  saveColumnPrefs,
  savePageSize,
  toggleColumn,
  type ColumnLayout,
  type Filters,
  type ListPageBody,
  type ListSort,
  type PageSize,
} from "./listState";
import d from "./DataList.module.css";

export interface DataColumn<T> extends Omit<Column<T>, "sort"> {
  /** the server can sort by this column (its id is on the route's allow-list) */
  sortable?: boolean;
  /** one of the list's 5–7 main columns, shown until the reader chooses otherwise */
  main?: boolean;
  /** why this status or warning column is always shown; set means it cannot be hidden */
  required?: string;
  /** a row-action column: always shown, last, never in the picker or the download */
  action?: boolean;
}

export interface DataListProps<T> {
  /** names the remembered choices (`regulait.list.<listId>.*`) */
  listId: string;
  /** plural, lower case, for "Refresh runs" and "No runs match" */
  noun: string;
  /** the list route, e.g. `/v1/runs` */
  endpoint: string;
  /** the gateway's Excel export of the same list, e.g. `/v1/runs/export.xlsx` */
  exportPath: string;
  /** the query-cache prefix, so a page's existing invalidation refreshes the list */
  queryKey: readonly unknown[];
  /** the route's older response key (`runs`, `incidents`, `users`) */
  legacyKey: string;
  columns: Array<DataColumn<T>>;
  defaultSort: ListSort;
  filters?: Filters;
  /** `estimate` where an exact count is costly: past the cap it reads "of 1,000+" */
  count?: "exact" | "estimate";
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowLabel?: (row: T) => string;
  empty?: ReactNode;
  /** the table to render: the kit Table, or FoldTable where columns fold on narrow widths */
  table?: (props: TableProps<T>) => ReactNode;
  /** each time rows arrive: the rows on screen and the last response body (for a page's own extras) */
  onRows?: (rows: T[], raw: Record<string, unknown>) => void;
}

const SERVER_SORT = () => 0;
const nameOf = <T,>(c: DataColumn<T>) => (typeof c.header === "string" && c.header ? c.header : c.srHeader ?? c.key);

/** an icon-only button whose name is also a visible tip on hover and on keyboard focus, dismissed by Escape */
function IconButton(props: { label: string; onClick: () => void; busy?: boolean; children: ReactNode; id?: string }) {
  const tip = useId();
  const [quiet, setQuiet] = useState(false);
  return (
    <span className={`${d.tipWrap} ${quiet ? d.tipQuiet : ""}`} onMouseLeave={() => setQuiet(false)} onBlur={() => setQuiet(false)}>
      <button
        type="button"
        id={props.id}
        className={d.iconBtn}
        aria-labelledby={tip}
        aria-busy={props.busy || undefined}
        onClick={props.onClick}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !quiet) {
            // WCAG 1.4.13: the tip can be dismissed without moving focus; the Escape is spent here
            e.stopPropagation();
            setQuiet(true);
          }
        }}
      >
        {props.children}
      </button>
      <span role="tooltip" id={tip} className={d.tip}>
        {props.label}
      </span>
    </span>
  );
}

const RefreshIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" strokeWidth="1.6" strokeLinecap="round" />
    <path d="M12.4 1.8v2.6H9.8" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const GearIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <circle cx="8" cy="8" r="2.2" fill="none" strokeWidth="1.5" />
    <path
      d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"
      fill="none"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  </svg>
);

/** the column picker: show or hide each optional column and change the order; status and warning columns stay */
function ColumnPicker<T>(props: {
  open: boolean;
  noun: string;
  columns: Array<DataColumn<T>>;
  layout: ColumnLayout;
  onChange: (next: ColumnLayout) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const byKey = new Map(props.columns.map((c) => [c.key, c]));
  const base = useId();
  const list = useRef<HTMLOListElement>(null);
  const move = (key: string, by: -1 | 1, which: "up" | "down") => {
    props.onChange(moveColumn(props.layout, key, by));
    // the moved row keeps focus on the same control, so repeated presses keep moving it
    requestAnimationFrame(() => list.current?.querySelector<HTMLButtonElement>(`[data-move="${which}-${key}"]`)?.focus());
  };
  return (
    <Modal
      open={props.open}
      title={`Columns for ${props.noun}`}
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onReset}>Reset columns</Button>
          <Button variant="primary" onClick={props.onClose}>
            Done
          </Button>
        </>
      }
    >
      <p className={d.pickerNote}>Choose the columns to show and their order. This browser remembers your choice.</p>
      <ol className={d.pickerList} ref={list}>
        {props.layout.order.map((key, i) => {
          const c = byKey.get(key)!;
          const name = nameOf(c);
          const id = `${base}-${key}`;
          const first = i === 0;
          const last = i === props.layout.order.length - 1;
          return (
            <li key={key} className={d.pickerRow}>
              <input
                type="checkbox"
                id={id}
                className={d.pickerBox}
                checked={props.layout.visible.includes(key)}
                disabled={Boolean(c.required)}
                aria-describedby={c.required ? `${id}-why` : undefined}
                onChange={() => props.onChange(toggleColumn(props.columns, props.layout, key))}
              />
              <label htmlFor={id} className={d.pickerLabel}>
                {name}
                {c.required && (
                  <span id={`${id}-why`} className={d.pickerWhy}>
                    {c.required}
                  </span>
                )}
                {!c.sortable && <span className={d.pickerWhy}>Can&apos;t be sorted</span>}
              </label>
              <Button
                size="sm"
                variant="ghost"
                data-move={`up-${key}`}
                aria-label={`Move ${name} up`}
                aria-disabled={first || undefined}
                onClick={() => !first && move(key, -1, "up")}
              >
                Up
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-move={`down-${key}`}
                aria-label={`Move ${name} down`}
                aria-disabled={last || undefined}
                onClick={() => !last && move(key, 1, "down")}
              >
                Down
              </Button>
            </li>
          );
        })}
      </ol>
    </Modal>
  );
}

export function DataList<T>(props: DataListProps<T>) {
  const { listId, endpoint, legacyKey } = props;
  const { toast } = useToast();
  const count = props.count ?? "exact";
  const filters = useMemo(() => props.filters ?? {}, [props.filters]);
  const filterKey = JSON.stringify(Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== false && v !== ""));

  const [size, setSizeState] = useState<PageSize>(() => loadPageSize(listId));
  const [sort, setSort] = useState<ListSort>(props.defaultSort);
  const [layout, setLayout] = useState<ColumnLayout>(() => resolveColumns(props.columns, loadColumnPrefs(listId)));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [page, setPage] = useState(0);
  /** the cursor or offset that reads page i, learnt from page i-1 */
  const [starts, setStarts] = useState<Record<number, { cursor?: string; offset?: number }>>({});
  const [exporting, setExporting] = useState(false);
  const [capNote, setCapNote] = useState<string | null>(null);
  const all = size === "all";
  const limit = all ? ALL_CHUNK : Number(size);

  // a new size, sort or filter starts again at the first page (set while rendering, so no stale page is fetched)
  const resetKey = `${size}|${sort.key}|${sort.dir}|${filterKey}`;
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setPage(0);
    setStarts({});
  }

  const fetchPage = (start: { cursor?: string | null; offset?: number | null }) =>
    api.get<unknown>(pageUrl(endpoint, { limit, sort, filters, count, ...start })).then((b) => normalisePage<T>(b, legacyKey));

  const start = starts[page] ?? {};
  const paged = useQuery({
    queryKey: [...props.queryKey, "page", { filters: filterKey, sort, limit, page, start }],
    queryFn: () => fetchPage(page === 0 ? {} : { cursor: start.cursor ?? null, offset: start.cursor ? null : (start.offset ?? page * limit) }),
    enabled: !all,
    placeholderData: keepPreviousData,
  });
  const infinite = useInfiniteQuery({
    queryKey: [...props.queryKey, "all", { filters: filterKey, sort }],
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: {} as { cursor?: string | null; offset?: number | null },
    getNextPageParam: (last: ListPageBody<T>) =>
      last.nextCursor ? { cursor: last.nextCursor } : last.nextOffset !== null ? { offset: last.nextOffset } : undefined,
    enabled: all,
  });

  // learn where the next page starts
  const pagedData = paged.data;
  useEffect(() => {
    if (all || !pagedData || paged.isPlaceholderData) return;
    setStarts((s) => ({
      ...s,
      [page + 1]: pagedData.nextCursor ? { cursor: pagedData.nextCursor } : pagedData.nextOffset !== null ? { offset: pagedData.nextOffset } : {},
    }));
  }, [all, pagedData, page, paged.isPlaceholderData]);

  const rows: T[] | undefined = all ? infinite.data?.pages.flatMap((p) => p.items) : pagedData?.items;
  const lastBody = all ? infinite.data?.pages.at(-1) : pagedData;
  const firstBody = all ? infinite.data?.pages[0] : pagedData;
  const more = all ? Boolean(infinite.hasNextPage) : Boolean(pagedData && (pagedData.nextCursor || pagedData.nextOffset !== null));
  // on the last page the total is known exactly, whatever the count said
  const end = rows ? (all ? rows.length : page * limit + rows.length) : 0;
  const settled = Boolean(rows) && !more && !(all ? infinite.isFetching : paged.isPlaceholderData);
  const total = settled ? end : (firstBody?.total ?? null);
  const estimate = settled ? false : (firstBody?.totalIsEstimate ?? false);

  const onRows = props.onRows;
  const source = all ? infinite.data : pagedData;
  useEffect(() => {
    if (rows && lastBody) onRows?.(rows, lastBody.raw);
    // rows and lastBody are derived from `source`, which is what changes
  }, [source]); // eslint-disable-line react-hooks/exhaustive-deps

  // "All": the next 500 load as the end of the list scrolls into view; the button below is the fallback
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = infinite;
  useEffect(() => {
    const el = sentinel.current;
    if (!all || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting) && hasNextPage && !isFetchingNextPage) void fetchNextPage();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [all, hasNextPage, isFetchingNextPage, fetchNextPage]);

  const setSize = (next: PageSize) => {
    savePageSize(listId, next);
    setSizeState(next);
  };
  const changeLayout = (next: ColumnLayout) => {
    setLayout(next);
    saveColumnPrefs(listId, prefsOf(next));
  };
  const resetLayout = () => {
    saveColumnPrefs(listId, null);
    setLayout(resolveColumns(props.columns, null));
  };

  const byKey = new Map(props.columns.map((c) => [c.key, c]));
  const shown: Array<Column<T>> = [
    ...layout.visible.map((k) => byKey.get(k)!),
    ...props.columns.filter((c) => c.action),
  ].map(({ sortable, main: _main, required: _required, action, ...c }) => ({
    ...c,
    ...(sortable ? { sort: SERVER_SORT } : {}),
    ...(!sortable && !action && !c.info
      ? { info: <p>This column can&apos;t be sorted: the server has no order for it.</p>, infoLabel: `the ${nameOf(c as DataColumn<T>)} column` }
      : {}),
  }));
  const tableSort: TableSort = { key: sort.key, dir: sort.dir === "asc" ? 1 : -1, by: (key) => setSort((s) => nextSort(s, key)) };

  const q = all ? infinite : paged;
  const refresh = () => void q.refetch();
  const download = async () => {
    if (exporting) return;
    setExporting(true);
    setCapNote(null);
    const columns = layout.visible.filter((k) => !byKey.get(k)?.action);
    const day = new Date().toISOString().slice(0, 10);
    const ok = await downloadCsv(
      exportUrl(props.exportPath, sort, filters, columns),
      `${listId}-${day}.xlsx`,
      (msg) => toast(msg, "error"),
      undefined,
      (res) => {
        if (res.headers.get("x-regulait-export-truncated") === "1") {
          const max = Number(res.headers.get("x-regulait-export-row-limit") ?? "0");
          setCapNote(`The file stopped at the ${max.toLocaleString("en-GB")}-row limit and is not the complete list. Narrow the filters to download the rest.`);
        }
      },
    );
    setExporting(false);
    if (ok) toast("Excel file downloaded", "success");
  };

  const shownCount = rows?.length ?? 0;
  const status = !rows
    ? ""
    : all
      ? loadedText(shownCount, total, estimate)
      : rangeText(page * limit, shownCount, total, estimate, more);
  const Tbl = props.table ?? Table;

  return (
    <div className={d.list} data-list={listId}>
      <div className={d.toolbar}>
        <label className={d.sizeLabel}>
          <span>Rows per page</span>
          <Select className={d.sizeSelect} value={size} onChange={(e) => setSize(e.target.value as PageSize)}>
            {PAGE_SIZES.map((s) => (
              <option key={s} value={s}>
                {s === "all" ? "All" : s}
              </option>
            ))}
          </Select>
        </label>
        <p className={d.status} role="status" aria-live="polite" data-testid="list-status">
          {status}
        </p>
        <span className={d.grow} />
        <IconButton label={`Refresh ${props.noun}`} onClick={refresh} busy={q.isFetching}>
          <RefreshIcon />
        </IconButton>
        <IconButton label={`Choose columns for ${props.noun}`} onClick={() => setPickerOpen(true)}>
          <GearIcon />
        </IconButton>
        <Button size="sm" onClick={() => void download()} aria-disabled={exporting || undefined}>
          {exporting ? "Preparing Excel…" : "Download Excel"}
        </Button>
      </div>
      {capNote && (
        <p className={d.capNote} role="alert">
          {capNote}
        </p>
      )}
      <Tbl
        columns={shown}
        rows={rows}
        rowKey={props.rowKey}
        loading={q.isLoading}
        error={q.error}
        onRetry={refresh}
        onRowClick={props.onRowClick}
        rowLabel={props.rowLabel}
        empty={props.empty}
        sort={tableSort}
      />
      {all ? (
        <div className={d.pager} ref={sentinel}>
          {hasNextPage && (
            <Button size="sm" onClick={() => void fetchNextPage()} aria-disabled={isFetchingNextPage || undefined}>
              {isFetchingNextPage ? "Loading…" : `Load next ${ALL_CHUNK}`}
            </Button>
          )}
        </div>
      ) : (
        <div className={d.pager}>
          <Button size="sm" aria-disabled={page === 0 || undefined} onClick={() => page > 0 && setPage((p) => p - 1)}>
            Previous
          </Button>
          <Button size="sm" aria-disabled={!more || paged.isPlaceholderData || undefined} onClick={() => more && !paged.isPlaceholderData && setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      )}
      <ColumnPicker
        open={pickerOpen}
        noun={props.noun}
        columns={props.columns.filter((c) => !c.action)}
        layout={layout}
        onChange={changeLayout}
        onReset={resetLayout}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
