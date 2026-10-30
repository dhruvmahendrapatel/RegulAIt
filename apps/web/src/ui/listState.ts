/**
 * The shared list control's state, without React (ADR-0219): the remembered page size and column choice, which
 * columns show and in what order, the next sort, the request URLs and the "11–20 of 1,284" wording. DataList.tsx
 * renders it; listState.test.ts pins it.
 *
 * Only this browser remembers the choices, under `regulait.list.<listId>.size` and `regulait.list.<listId>.columns`.
 * Every storage access is wrapped, so a blocked or full storage leaves the defaults working. Nothing stored here is
 * a credential or another person's data.
 */

export const PAGE_SIZES = ["10", "50", "100", "all"] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
/** rows per request in "All", loaded as the reader scrolls */
export const ALL_CHUNK = 500;
export const DEFAULT_SIZE: PageSize = "10";

export type SortDir = "asc" | "desc";
export interface ListSort {
  key: string;
  dir: SortDir;
}

const sizeKey = (listId: string) => `regulait.list.${listId}.size`;
const columnsKey = (listId: string) => `regulait.list.${listId}.columns`;

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage blocked or full: the choice lasts for this visit only
  }
}

export function loadPageSize(listId: string): PageSize {
  const v = read(sizeKey(listId));
  return (PAGE_SIZES as readonly string[]).includes(v ?? "") ? (v as PageSize) : DEFAULT_SIZE;
}
export function savePageSize(listId: string, size: PageSize): void {
  write(sizeKey(listId), size);
}

export interface ColumnPrefs {
  order: string[];
  hidden: string[];
}
export function loadColumnPrefs(listId: string): ColumnPrefs | null {
  const raw = read(columnsKey(listId));
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return null;
    const { order, hidden } = v as Record<string, unknown>;
    const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string").slice(0, 100) : []);
    return { order: strings(order), hidden: strings(hidden) };
  } catch {
    return null;
  }
}
export function saveColumnPrefs(listId: string, prefs: ColumnPrefs | null): void {
  write(columnsKey(listId), prefs ? JSON.stringify(prefs) : null);
}

/** what the column logic needs to know about a column */
export interface ColumnMeta {
  key: string;
  /** shown until the reader chooses otherwise; the rest start hidden */
  main?: boolean;
  /** why it is always shown (status and warning columns); set means it cannot be hidden */
  required?: string;
  /** a row-action column: always shown, last, never in the picker or the export */
  action?: boolean;
}

export interface ColumnLayout {
  /** the pickable columns in the reader's order */
  order: string[];
  /** the pickable columns shown, in that order */
  visible: string[];
}

/** the order and visibility of the pickable columns, from the declaration and what this browser remembered */
export function resolveColumns(cols: readonly ColumnMeta[], prefs: ColumnPrefs | null): ColumnLayout {
  const pickable = cols.filter((c) => !c.action);
  const byKey = new Map(pickable.map((c) => [c.key, c]));
  const known = prefs ? prefs.order.filter((k, i) => byKey.has(k) && prefs.order.indexOf(k) === i) : [];
  // a column added since the choice was saved joins at its declared place's end, shown only if it is a main one
  const order = [...known, ...pickable.map((c) => c.key).filter((k) => !known.includes(k))];
  const hidden = (k: string) => {
    const c = byKey.get(k)!;
    if (c.required) return false;
    if (prefs && known.includes(k)) return prefs.hidden.includes(k);
    return !c.main;
  };
  return { order, visible: order.filter((k) => !hidden(k)) };
}

/** the choice to remember after the reader changed one */
export function prefsOf(layout: ColumnLayout): ColumnPrefs {
  return { order: layout.order, hidden: layout.order.filter((k) => !layout.visible.includes(k)) };
}

export function toggleColumn(cols: readonly ColumnMeta[], layout: ColumnLayout, key: string): ColumnLayout {
  const c = cols.find((x) => x.key === key);
  if (!c || c.required || c.action) return layout;
  const shown = new Set(layout.visible);
  if (shown.has(key)) shown.delete(key);
  else shown.add(key);
  return { order: layout.order, visible: layout.order.filter((k) => shown.has(k)) };
}

export function moveColumn(layout: ColumnLayout, key: string, by: -1 | 1): ColumnLayout {
  const i = layout.order.indexOf(key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= layout.order.length) return layout;
  const order = [...layout.order];
  [order[i], order[j]] = [order[j]!, order[i]!];
  const shown = new Set(layout.visible);
  return { order, visible: order.filter((k) => shown.has(k)) };
}

/** a header click: the same column flips direction, another column starts ascending */
export function nextSort(current: ListSort, key: string): ListSort {
  return current.key === key ? { key, dir: current.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
}

export type Filters = Record<string, string | undefined | null | false>;

function filterParams(filters: Filters): URLSearchParams {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))) {
    if (v !== undefined && v !== null && v !== false && v !== "") qs.set(k, v);
  }
  return qs;
}

export interface PageRequest {
  limit: number;
  sort: ListSort;
  filters: Filters;
  count: "exact" | "estimate";
  cursor?: string | null;
  offset?: number | null;
}

/** one page under the list contract */
export function pageUrl(endpoint: string, r: PageRequest): string {
  const qs = filterParams(r.filters);
  qs.set("limit", String(r.limit));
  qs.set("sort", r.sort.key);
  qs.set("dir", r.sort.dir);
  qs.set("count", r.count);
  if (r.cursor) qs.set("cursor", r.cursor);
  else if (r.offset) qs.set("offset", String(r.offset));
  return `${endpoint}?${qs.toString()}`;
}

/** the Excel download: the same filters and sort, the columns on screen in screen order */
export function exportUrl(exportPath: string, sort: ListSort, filters: Filters, columns: readonly string[]): string {
  const qs = filterParams(filters);
  qs.set("sort", sort.key);
  qs.set("dir", sort.dir);
  qs.set("columns", columns.join(","));
  return `${exportPath}?${qs.toString()}`;
}

export interface ListPageBody<T> {
  items: T[];
  nextCursor: string | null;
  nextOffset: number | null;
  total: number | null;
  totalIsEstimate: boolean;
  raw: Record<string, unknown>;
}

/** read a page; a gateway that answered the older shape (`{ runs: [...] }`) still renders, with no total */
export function normalisePage<T>(body: unknown, legacyKey: string): ListPageBody<T> {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const items = Array.isArray(raw.items) ? raw.items : Array.isArray(raw[legacyKey]) ? (raw[legacyKey] as unknown[]) : [];
  return {
    items: items as T[],
    nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : null,
    nextOffset: typeof raw.nextOffset === "number" ? raw.nextOffset : null,
    total: typeof raw.total === "number" ? raw.total : null,
    totalIsEstimate: raw.totalIsEstimate === true,
    raw,
  };
}

const n = (x: number) => x.toLocaleString("en-GB");
function totalText(total: number | null, estimate: boolean): string | null {
  if (total === null) return null;
  return estimate ? `${n(total)}+` : n(total);
}

/** "11–20 of 1,284", "11–20 of 1,000+", or "11–20" when the total is not known and more pages follow */
export function rangeText(start: number, shown: number, total: number | null, estimate: boolean, more: boolean): string {
  if (shown === 0) return "";
  const of = totalText(total, estimate) ?? (more ? null : n(start + shown));
  return `${n(start + 1)}–${n(start + shown)}${of ? ` of ${of}` : ""}`;
}

/** "Loaded 1,000 of 1,284" */
export function loadedText(loaded: number, total: number | null, estimate: boolean): string {
  const of = totalText(total, estimate);
  return `Loaded ${n(loaded)}${of ? ` of ${of}` : ""}`;
}
