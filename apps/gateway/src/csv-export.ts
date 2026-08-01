/**
 * Streaming CSV export (ADR-0031).
 *
 * The three CSV endpoints used to `select()` a whole table, materialise every
 * row into a JS array, build one giant string, and hand that string to Fastify.
 * `audit_log` grows a row per governed call and the auto-prune ships OFF by
 * default, so that shape is a straight line to an OOM of the gateway container.
 *
 * This module replaces it with:
 *   - keyset (NOT offset) batching over `(at DESC, id DESC)`, so page depth is
 *     an index seek and peak memory is one batch;
 *   - a write to `reply.raw` per batch, with real backpressure, so the response
 *     is streamed rather than buffered;
 *   - a defaulted date window and a hard row ceiling, both DISCLOSED — in
 *     response headers always, and in a trailing comment row whenever the
 *     export is not provably the complete answer. A compliance export must
 *     never be silently short.
 *
 * The column shape (header row, field order, escaping, line terminator) is
 * unchanged from the pre-streaming implementation: a complete, untruncated
 * export is byte-identical to what the old code produced.
 */
import type { FastifyReply } from "fastify";
import type { ServerResponse } from "node:http";
import { securityHeaders } from "./security-headers.js";
import type { KeysetCursor } from "./pagination.js";

// --- tunables ---------------------------------------------------------------
// Read from the environment on every call (not captured at module load) so a
// test can dial the batch size down to 2 and prove batching actually happens.

function envInt(name: string, dflt: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** rows fetched (and written) per round trip */
export function csvBatchRows(): number {
  return envInt("REGULAIT_CSV_BATCH_ROWS", 2000, 1, 100_000);
}

/** hard ceiling on a single export; disclosed in the response when hit */
export function csvMaxRows(): number {
  return envInt("REGULAIT_CSV_MAX_ROWS", 500_000, 1, 50_000_000);
}

/** the window applied when the caller names neither `from` nor `to`.
 * 0 disables the default window (export everything up to the row ceiling). */
export function csvDefaultWindowDays(): number {
  return envInt("REGULAIT_CSV_WINDOW_DAYS", 90, 0, 36_500);
}

// --- window resolution ------------------------------------------------------

export interface CsvWindow {
  from: Date | null;
  to: Date | null;
  /** "caller" = at least one bound came from the request; "default" = we
   * applied the default lookback; "unbounded" = no bound at all. */
  source: "caller" | "default" | "unbounded";
}

export function resolveCsvWindow(
  from: Date | undefined,
  to: Date | undefined,
  now: Date = new Date(),
): CsvWindow {
  if (from || to) return { from: from ?? null, to: to ?? null, source: "caller" };
  const days = csvDefaultWindowDays();
  if (days <= 0) return { from: null, to: null, source: "unbounded" };
  return { from: new Date(now.getTime() - days * 86_400_000), to: null, source: "default" };
}

// --- the stream -------------------------------------------------------------

export interface CsvStreamSpec<R> {
  filename: string;
  /** the column names, joined with "," to form the header row */
  header: readonly string[];
  /** "\n" (audit export) or "\r\n" (usage exports) — preserved per endpoint */
  eol: string;
  batchSize: number;
  maxRows: number;
  window: CsvWindow;
  /** one keyset page, newest first, strictly older than `after` */
  fetchPage(after: KeysetCursor | null, limit: number): Promise<R[]>;
  cursorOf(row: R): KeysetCursor;
  /** the already-escaped, comma-joined data line for one row (no terminator) */
  renderRow(row: R): string;
  /** optional probe: are there rows the applied default window excluded?
   * Only consulted when the window was defaulted rather than requested. */
  hasRowsOutsideWindow?(): Promise<boolean>;
}

export interface CsvStreamResult {
  rows: number;
  truncated: boolean;
  /** a disclosure row was appended */
  disclosed: boolean;
  batches: number;
}

const NOTICE_PREFIX = "# REGULAIT EXPORT NOTICE:";
const ERROR_PREFIX = "# REGULAIT EXPORT ERROR:";

/** one CSV field, RFC-4180 quoted, so the notice occupies a single column and
 * never disturbs the column shape of the data rows above it */
function noticeRow(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

async function write(raw: ServerResponse, chunk: string): Promise<void> {
  if (raw.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const done = () => {
      raw.off("drain", done);
      raw.off("close", done);
      raw.off("error", fail);
      resolve();
    };
    const fail = (err: Error) => {
      raw.off("drain", done);
      raw.off("close", done);
      raw.off("error", fail);
      reject(err);
    };
    raw.once("drain", done);
    raw.once("close", done);
    raw.once("error", fail);
  });
}

export async function streamCsv<R>(
  reply: FastifyReply,
  spec: CsvStreamSpec<R>,
): Promise<CsvStreamResult> {
  const { window: win } = spec;
  // Headers must go out before the first byte of body, so the truncation flag
  // itself cannot live here — the window and ceiling that PRODUCE it can, and
  // the trailing notice row reports what actually happened.
  const headers: Record<string, string> = {
    // reply.hijack() skips the onSend hook, so the streaming path sets the
    // ADR-0031 security headers itself rather than losing them.
    ...securityHeaders("text/csv"),
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${spec.filename}"`,
    "cache-control": "no-store",
    "x-regulait-export-row-limit": String(spec.maxRows),
    "x-regulait-export-window-source": win.source,
    ...(win.from ? { "x-regulait-export-window-from": win.from.toISOString() } : {}),
    ...(win.to ? { "x-regulait-export-window-to": win.to.toISOString() } : {}),
  };

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, headers);

  let rows = 0;
  let batches = 0;
  let truncated = false;
  let disclosed = false;
  let oldestExported: string | null = null;

  try {
    await write(raw, spec.header.join(",") + spec.eol);

    let after: KeysetCursor | null = null;
    for (;;) {
      const remaining = spec.maxRows - rows;
      if (remaining <= 0) {
        // At the ceiling: one 1-row probe decides truncated-vs-exactly-full,
        // so we never claim truncation we cannot see.
        batches++;
        truncated = (await spec.fetchPage(after, 1)).length > 0;
        break;
      }
      const limit = Math.min(spec.batchSize, remaining);
      batches++;
      const page = await spec.fetchPage(after, limit);
      if (page.length === 0) break;

      let chunk = "";
      for (const row of page) chunk += spec.renderRow(row) + spec.eol;
      await write(raw, chunk);

      rows += page.length;
      after = spec.cursorOf(page[page.length - 1]!);
      oldestExported = after.at;
      if (page.length < limit) break;
    }

    const windowClipped =
      !truncated && win.source === "default" && (await spec.hasRowsOutsideWindow?.()) === true;

    if (truncated || windowClipped) {
      disclosed = true;
      const parts: string[] = [];
      if (truncated) {
        parts.push(
          `stopped at the ${spec.maxRows}-row export ceiling — this file is NOT the complete trail`,
        );
      }
      if (windowClipped) {
        parts.push(
          `a default ${csvDefaultWindowDays()}-day window was applied because the request named no from/to bound, and older matching rows exist`,
        );
      }
      parts.push(
        `window=[${win.from ? win.from.toISOString() : "-inf"}, ${win.to ? win.to.toISOString() : "now"}]`,
      );
      parts.push(`rows=${rows}`);
      if (oldestExported) parts.push(`oldest row exported at ${oldestExported}`);
      parts.push("re-request with narrower from/to bounds to export the remainder");
      await write(raw, noticeRow(`${NOTICE_PREFIX} ${parts.join("; ")}`) + spec.eol);
    }
  } catch (err) {
    // The status line is already on the wire, so the only honest thing left is
    // to say so IN the file rather than hand back a silently short export.
    disclosed = true;
    const msg = err instanceof Error ? err.message : String(err);
    try {
      await write(
        raw,
        noticeRow(`${ERROR_PREFIX} export aborted after ${rows} row(s): ${msg}`) + spec.eol,
      );
    } catch {
      /* the socket is gone; nothing further to say */
    }
  }

  // `end(cb)` is not honoured by light-my-request's mock response, so wait on
  // the stream events instead — that works identically on a real socket.
  await new Promise<void>((resolve) => {
    const done = () => {
      raw.off("finish", done);
      raw.off("close", done);
      resolve();
    };
    raw.once("finish", done);
    raw.once("close", done);
    raw.end();
  });
  return { rows, truncated, disclosed, batches };
}
