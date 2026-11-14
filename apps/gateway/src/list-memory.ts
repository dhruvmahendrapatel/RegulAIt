/**
 * ADR-0226 — the list contract for a list built in memory (P2 batch D: the golden cases and the access
 * recommendations' findings per rule). Beside `list-contract.ts`, whose `MemoryListSpec`, `runMemoryListPage` and
 * `sendMemoryListExport` it wraps, so a route answers the same params with the same validation, caps and audit as a
 * SQL list in one call each:
 *
 *   pageInMemory(rows, query, spec)        → { items, nextCursor: null, nextOffset, total, totalIsEstimate }
 *   exportInMemory(db, req, reply, rows, query, spec, summary)  → the audited .xlsx
 *
 * The rows are whatever the route has already computed under its own authorisation: this module never widens what
 * a caller sees, it only sorts, pages and exports the array it is given. A sort column id is looked up as an own
 * property of the spec's allow-list (unknown → 400 `unknown_sort_column`); paging is by offset, so a cursor is a 400
 * (`cursor_not_supported`) exactly as for any non-date SQL sort; `limit` is 10, 50, 100 or 500 and `offset` at most
 * LIST_MAX_OFFSET. The export holds at most `listExportMaxRows()` rows (100,000 by default), says so when it stops,
 * and writes the `list-export-xlsx` audit row before the first byte, through the same code as the SQL exports.
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@regulait/db";
import {
  parseListExport,
  parseListPage,
  runMemoryListPage,
  sendMemoryListExport,
  type ExportOutcome,
  type ListResult,
  type MemoryListSpec,
} from "./list-contract.js";

export {
  filterParams,
  sendListError,
  wantsListContract,
  type ExportColumn,
  type MemoryListSpec,
  type MemorySortValue,
} from "./list-contract.js";

/** one page of `rows` under the contract; throws ListQueryError or a ZodError (both answered as a 400) */
export function pageInMemory<Row>(rows: readonly Row[], query: unknown, spec: MemoryListSpec<Row>): ListResult<Row> {
  return runMemoryListPage(spec, rows, parseListPage(spec, asQuery(query)));
}

/** the audited Excel file of every row in `rows`, in the requested sort, with exactly the requested columns */
export async function exportInMemory<Row>(
  db: Db,
  req: FastifyRequest,
  reply: FastifyReply,
  rows: readonly Row[],
  query: unknown,
  spec: MemoryListSpec<Row>,
  filterSummary: Record<string, unknown>,
): Promise<ExportOutcome> {
  return sendMemoryListExport(db, req, reply, spec, rows, parseListExport(spec, asQuery(query)), filterSummary);
}

function asQuery(query: unknown): Record<string, unknown> {
  return (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
}
