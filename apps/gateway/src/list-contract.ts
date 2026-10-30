/**
 * ADR-0219 — the one list contract: page size, server sort, honest counts and
 * the Excel export, shared by every growing list (pilot: /v1/runs,
 * /v1/incidents, /v1/users).
 *
 * It sits next to `list-limit.ts` (the REL-10 bound) and `pagination.ts` (the
 * keyset cursor) and reuses both rather than adding a third pattern. A route
 * declares a `ListSpec`: its sortable columns as an allow-list of column id →
 * SQL expression, its exportable columns (id → screen label and cell value),
 * its filter fields and its default sort. The route keeps its own WHERE (the
 * object-level authorisation and the filters), so the list, the count and the
 * export all read through the same predicate and cannot disagree.
 *
 * The contract is opt-in per request. A caller that sends none of `sort`,
 * `dir`, `cursor`, `offset` or `count` gets the route's legacy response,
 * unchanged (`wantsListContract`). With any of them:
 *
 *   ?limit=10|50|100|500  (500 only for "All" chunks; never above 500)
 *   &cursor=<keyset>      (the default-style sort on a not-null timestamp column)
 *   &offset=<n>           (any other sort; never both)
 *   &sort=<colId>&dir=asc|desc   (colId from the allow-list; unknown → 400)
 *   &count=exact|estimate
 *
 *   → { items, nextCursor, nextOffset, total, totalIsEstimate }
 *
 * `nextOffset` is the offset of the next page when the page was read by offset
 * (keyset pages answer `nextCursor`); both are null on the last page. A sort
 * column id is never interpolated: it selects an expression from the route's
 * own map, and the direction selects one of two constant SQL fragments.
 *
 * `count=estimate` is a bounded count: it stops at COUNT_ESTIMATE_CAP + 1 rows,
 * and past the cap answers `total: COUNT_ESTIMATE_CAP, totalIsEstimate: true`,
 * which the UI shows as "of 1,000+". It never invents a number.
 *
 * Open source first: the xlsx file is written by `write-excel-file` 4.1.1 (MIT,
 * one dependency, `fflate`, MIT; no native code, no network). ExcelJS was
 * rejected (no release since 2023-10), SheetJS (`xlsx` on npm is 0.18.5 from
 * 2022; newer builds ship only from the vendor's CDN, which breaks the pinned,
 * air-gapped rule), and `xlsx-populate` (a reader/editor built on jszip and
 * lodash, far more than a writer needs). See THIRD_PARTY.md.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import writeXlsxFile from "write-excel-file/node";
import { auditLog, sql, type Db, type PgColumn, type SQL } from "@regulait/db";
import { atTextSql, decodeCursor, encodeCursor, type KeysetCursor } from "./pagination.js";
import { csvMaxRows } from "./csv-export.js";

/** the page sizes the control offers; 500 is the "All" chunk */
export const LIST_PAGE_SIZES = [10, 50, 100, 500] as const;
export const LIST_CONTRACT_MAX_LIMIT = 500;
/** where `count=estimate` stops counting */
export const COUNT_ESTIMATE_CAP = 1_000;
/** the deepest offset a page may ask for (offset pages walk what they skip) */
export const LIST_MAX_OFFSET = 1_000_000;
/** rows read per round trip while building an export */
export const EXPORT_BATCH_ROWS = 500;

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** the request params that switch a list route to this contract */
const CONTRACT_PARAMS = ["sort", "dir", "cursor", "offset", "count"] as const;

export function wantsListContract(query: unknown): boolean {
  if (!query || typeof query !== "object") return false;
  const q = query as Record<string, unknown>;
  return CONTRACT_PARAMS.some((k) => q[k] !== undefined);
}

export type SortDir = "asc" | "desc";

export interface SortColumn {
  /** the ORDER BY expression; nulls always sort last */
  expr: SQL | PgColumn;
  /** a NOT NULL timestamptz column the keyset cursor can seek on (`expr` must be this column) */
  keysetAt?: PgColumn;
}

export type XlsxCell = string | number | boolean | Date | null;

export interface ExportColumn<Row> {
  /** the screen's header label, used as the file's header row */
  label: string;
  value: (row: Row) => XlsxCell;
}

export interface ListSpec<Row> {
  /** the list id: the UI's `listId`, the audit row's `listId`, the file name */
  id: string;
  sorts: Record<string, SortColumn>;
  /** every column the export may name, in no particular order */
  columns: Record<string, ExportColumn<Row>>;
  filters: readonly string[];
  defaultSort: { col: string; dir: SortDir };
  /** the stable tie-breaker (a unique uuid column) */
  idCol: PgColumn;
}

export class ListQueryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const limitSchema = z.coerce
  .number()
  .int()
  .refine((n) => (LIST_PAGE_SIZES as readonly number[]).includes(n), { message: "limit must be 10, 50, 100 or 500" });

const pageSchema = z.object({
  limit: limitSchema.default(10),
  cursor: z.string().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).max(LIST_MAX_OFFSET).optional(),
  sort: z.string().min(1).max(64).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  count: z.enum(["exact", "estimate"]).optional(),
});

/** the contract's own params, for a route whose filter schema is `.strict()` */
export const LIST_CONTRACT_KEYS = ["limit", ...CONTRACT_PARAMS] as const;

export interface ListPage {
  limit: number;
  cursor: KeysetCursor | null;
  offset: number;
  sort: string;
  dir: SortDir;
  count: "exact" | "estimate" | null;
}

function resolveSort<Row>(spec: ListSpec<Row>, sort: string | undefined, dir: SortDir | undefined) {
  const col = sort ?? spec.defaultSort.col;
  // an own-property check, so `__proto__` or `constructor` is an unknown column too
  if (!Object.prototype.hasOwnProperty.call(spec.sorts, col)) {
    throw new ListQueryError("unknown_sort_column", `the ${spec.id} list cannot be sorted by "${col.slice(0, 64)}"`);
  }
  return { sort: col, dir: dir ?? (sort === undefined ? spec.defaultSort.dir : "asc") };
}

/** parse the paging and sort params; throws ListQueryError (→ 400) or a ZodError (→ 400) */
export function parseListPage<Row>(spec: ListSpec<Row>, query: Record<string, unknown>): ListPage {
  const p = pageSchema.parse(pick(query, LIST_CONTRACT_KEYS));
  if (p.cursor !== undefined && p.offset !== undefined) {
    throw new ListQueryError("cursor_and_offset", "send either cursor or offset, not both");
  }
  const { sort, dir } = resolveSort(spec, p.sort, p.dir);
  let cursor: KeysetCursor | null = null;
  if (p.cursor !== undefined) {
    if (!spec.sorts[sort]!.keysetAt) {
      throw new ListQueryError("cursor_not_supported", `a cursor pages only a date sort; use offset for "${sort}"`);
    }
    cursor = decodeCursor(p.cursor);
    if (!cursor) throw new ListQueryError("bad_cursor", "the cursor is malformed");
  }
  return { limit: p.limit, cursor, offset: p.offset ?? 0, sort, dir, count: p.count ?? null };
}

/** the filter params only, with the contract's own keys taken out (for a `.strict()` filter schema) */
export function filterParams(query: unknown): Record<string, unknown> {
  const q = (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(q)) {
    if (!(LIST_CONTRACT_KEYS as readonly string[]).includes(k) && k !== "columns") out[k] = v;
  }
  return out;
}

function pick(q: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (q[k] !== undefined) out[k] = q[k];
  return out;
}

const ASC = sql`asc`;
const DESC = sql`desc`;

/** ORDER BY for this page: the chosen expression (nulls last), then the id in the same direction */
export function orderByFor<Row>(spec: ListSpec<Row>, page: Pick<ListPage, "sort" | "dir">): SQL[] {
  const d = page.dir === "asc" ? ASC : DESC;
  return [sql`${spec.sorts[page.sort]!.expr} ${d} nulls last`, sql`${spec.idCol} ${d}`];
}

/** "strictly after this cursor" for a keyset sort in either direction */
function afterCursor(at: PgColumn, id: PgColumn, c: KeysetCursor, dir: SortDir): SQL {
  return dir === "desc"
    ? sql`(${at}, ${id}) < (${c.at}::timestamptz, ${c.id}::uuid)`
    : sql`(${at}, ${id}) > (${c.at}::timestamptz, ${c.id}::uuid)`;
}

/** what a route's page reader is given: run your SELECT with exactly these */
export interface PageQuery {
  where: SQL | undefined;
  orderBy: SQL[];
  limit: number;
  offset: number;
  /** select this as `_cursorAt` (it is the keyset column's microsecond text, or null) */
  cursorAt: SQL<string | null>;
}

/** a SELECT the count wraps: the route's FROM + joins + WHERE, selecting anything */
export interface CountableQuery {
  as(alias: string): unknown;
  limit(n: number): { as(alias: string): unknown };
}

export interface ListReader<Row> {
  fetch(q: PageQuery): Promise<Array<Row & { _cursorAt?: string | null }>>;
  /** the same FROM/joins with `where` applied, for the count */
  countable(where: SQL | undefined): CountableQuery;
  idOf(row: Row): string;
}

export interface ListResult<Row> {
  items: Row[];
  nextCursor: string | null;
  nextOffset: number | null;
  total: number | null;
  totalIsEstimate: boolean;
}

function and2(a: SQL | undefined, b: SQL): SQL {
  return a ? sql`(${a}) and (${b})` : b;
}

async function readPage<Row>(
  spec: ListSpec<Row>,
  reader: ListReader<Row>,
  where: SQL | undefined,
  page: ListPage,
): Promise<{ items: Row[]; nextCursor: string | null; nextOffset: number | null }> {
  const sortCol = spec.sorts[page.sort]!;
  const keyset = sortCol.keysetAt && page.offset === 0 ? sortCol.keysetAt : null;
  const pageWhere = keyset && page.cursor ? and2(where, afterCursor(keyset, spec.idCol, page.cursor, page.dir)) : where;
  // one row past the page decides "is there a next page" without a count
  const rows = await reader.fetch({
    where: pageWhere,
    orderBy: orderByFor(spec, page),
    limit: page.limit + 1,
    offset: keyset ? 0 : page.offset,
    cursorAt: keyset ? (atTextSql(keyset) as SQL<string | null>) : sql<string | null>`null`,
  });
  const more = rows.length > page.limit;
  const shown = rows.slice(0, page.limit);
  const items = shown.map((r) => {
    const { _cursorAt: _drop, ...rest } = r as Row & { _cursorAt?: string | null };
    return rest as Row;
  });
  if (!more) return { items, nextCursor: null, nextOffset: null };
  if (keyset) {
    const last = shown[shown.length - 1]!;
    return { items, nextCursor: encodeCursor({ at: last._cursorAt!, id: reader.idOf(last) }), nextOffset: null };
  }
  return { items, nextCursor: null, nextOffset: page.offset + page.limit };
}

async function countRows(db: Db, q: CountableQuery, cap: number | null): Promise<number> {
  const sub = (cap === null ? q.as("list_count") : q.limit(cap + 1).as("list_count")) as Parameters<ReturnType<Db["select"]>["from"]>[0];
  const [row] = (await db.select({ n: sql<number>`count(*)::int` }).from(sub)) as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

/** one page of a list under the contract */
export async function runListPage<Row>(
  db: Db,
  spec: ListSpec<Row>,
  reader: ListReader<Row>,
  where: SQL | undefined,
  page: ListPage,
): Promise<ListResult<Row>> {
  const [pageOut, total] = await Promise.all([
    readPage(spec, reader, where, page),
    page.count === null
      ? Promise.resolve(null)
      : countRows(db, reader.countable(where), page.count === "estimate" ? COUNT_ESTIMATE_CAP : null),
  ]);
  const estimate = page.count === "estimate" && total !== null && total > COUNT_ESTIMATE_CAP;
  return {
    ...pageOut,
    total: total === null ? null : estimate ? COUNT_ESTIMATE_CAP : total,
    totalIsEstimate: estimate,
  };
}

/** answer a ListQueryError as a 400, and anything else by rethrowing */
export function sendListError(reply: FastifyReply, e: unknown) {
  if (e instanceof ListQueryError) return reply.status(400).send({ error: e.code, detail: e.message });
  throw e;
}

// ---- export ------------------------------------------------------------------

/** the hard ceiling on one export: the same one the CSV exports use */
export function listExportMaxRows(): number {
  return csvMaxRows();
}

const exportSchema = z.object({
  columns: z.string().min(1).max(2_000),
  sort: z.string().min(1).max(64).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
});

export interface ExportRequest {
  columns: string[];
  sort: string;
  dir: SortDir;
}

export function parseListExport<Row>(spec: ListSpec<Row>, query: Record<string, unknown>): ExportRequest {
  const p = exportSchema.parse(pick(query, ["columns", "sort", "dir"]));
  const columns = p.columns.split(",").map((c) => c.trim());
  if (columns.length > 64) throw new ListQueryError("too_many_columns", "at most 64 columns");
  const seen = new Set<string>();
  for (const c of columns) {
    if (!Object.prototype.hasOwnProperty.call(spec.columns, c)) {
      throw new ListQueryError("unknown_column", `the ${spec.id} list has no column "${c.slice(0, 64)}"`);
    }
    if (seen.has(c)) throw new ListQueryError("duplicate_column", `column "${c}" is named twice`);
    seen.add(c);
  }
  const { sort, dir } = resolveSort(spec, p.sort, p.dir);
  return { columns, sort, dir };
}

/** the line written as the file's last row when the ceiling stopped the export */
export function exportCapNotice(max: number): string {
  return `This file stopped at the ${max.toLocaleString("en-GB")}-row export limit and is not the complete list. Narrow the filters to export the rest.`;
}

export interface ExportOutcome {
  rows: number;
  truncated: boolean;
}

/**
 * Build the .xlsx for every row matching `where` in the requested sort, with
 * exactly the requested columns in order, audit it, and send it. The audit row
 * is written right after the query and before the first byte: a failed audit
 * write fails the export, so no file leaves without its record.
 */
export async function sendListExport<Row>(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  spec: ListSpec<Row>,
  reader: ListReader<Row>,
  where: SQL | undefined,
  ex: ExportRequest,
  filterSummary: Record<string, unknown>,
): Promise<ExportOutcome> {
  const max = listExportMaxRows();
  const rows: Row[] = [];
  let page: ListPage = { limit: EXPORT_BATCH_ROWS, cursor: null, offset: 0, sort: ex.sort, dir: ex.dir, count: null };
  let truncated = false;
  for (;;) {
    const remaining = max - rows.length;
    const limit = Math.min(EXPORT_BATCH_ROWS, remaining);
    const out = await readPage(spec, reader, where, { ...page, limit });
    rows.push(...out.items);
    if (!out.nextCursor && out.nextOffset === null) break;
    if (rows.length >= max) {
      truncated = true;
      break;
    }
    page = out.nextCursor
      ? { ...page, cursor: decodeCursor(out.nextCursor), offset: 0 }
      : { ...page, cursor: null, offset: out.nextOffset! };
  }

  await db.insert(auditLog).values({
    userId: req.authCtx.userId ?? NIL_USER,
    objectType: "audit_export",
    objectId: null,
    effect: "allow",
    ruleId: "list-export-xlsx",
    ruleChain: [],
    reason:
      `exported the ${spec.id} list as an Excel file: ${rows.length} row(s), ${ex.columns.length} column(s)` +
      `${truncated ? `, stopped at the ${max}-row export limit` : ""}`,
    detail: {
      listId: spec.id,
      filters: filterSummary,
      sort: ex.sort,
      dir: ex.dir,
      columns: ex.columns,
      rows: rows.length,
      truncated,
      maxRows: max,
    },
  });

  const cols = ex.columns.map((id) => spec.columns[id]!);
  const sheet: Array<Array<{ value: XlsxCell; type?: unknown; format?: string; fontWeight?: "bold" } | null>> = [
    cols.map((c) => ({ value: c.label, fontWeight: "bold" as const })),
  ];
  for (const r of rows) sheet.push(cols.map((c) => cell(c.value(r))));
  if (truncated) sheet.push([{ value: exportCapNotice(max) }]);
  const buffer = await writeXlsxFile(sheet as never, { sheet: sheetName(spec.id), stickyRowsCount: 1 }).toBuffer();

  const day = new Date().toISOString().slice(0, 10);
  void reply
    .headers({
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="${spec.id}-${day}.xlsx"`,
      "cache-control": "no-store",
      "x-regulait-export-rows": String(rows.length),
      "x-regulait-export-row-limit": String(max),
      "x-regulait-export-truncated": truncated ? "1" : "0",
    })
    .send(buffer);
  return { rows: rows.length, truncated };
}

function cell(v: XlsxCell) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return { value: v, type: Date, format: "yyyy-mm-dd hh:mm:ss" };
  if (typeof v === "number") return { value: v, type: Number };
  if (typeof v === "boolean") return { value: v ? "Yes" : "No" };
  return { value: v };
}

function sheetName(id: string): string {
  const s = id.replace(/[^A-Za-z0-9 _-]/g, " ").trim();
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 31) || "List";
}
