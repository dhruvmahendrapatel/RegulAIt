/**
 * Keyset ("seek") pagination primitives shared by the audit read surface and
 * every CSV export (ADR-0031).
 *
 * Why keyset and not OFFSET: an OFFSET page N scan still walks the N*pageSize
 * rows it skips, so a compliance table that grows a row per governed call
 * degrades linearly with how deep you page. A keyset predicate on the sort key
 * is a single index seek regardless of depth.
 *
 * Why the cursor carries a MICROSECOND-exact timestamp string rather than a JS
 * Date: `timestamptz` stores microseconds, but node-postgres hands JavaScript a
 * `Date`, which only has milliseconds. Round-tripping the truncated value into
 * the next page's `at < $1` predicate would silently DROP every row whose
 * sub-millisecond component put it between the truncated and the true value.
 * We therefore render the exact value in SQL (`to_char(... 'US')`) and compare
 * against that same text, cast back to `timestamptz`.
 */
import { sql, type PgColumn, type SQL } from "@regulait/db";

export interface KeysetCursor {
  /** microsecond-exact UTC instant, e.g. "2026-08-01T12:34:56.123456Z" */
  at: string;
  id: string;
}

/** Microsecond-exact UTC text rendering of a `timestamptz` column. */
export function atTextSql(col: PgColumn): SQL<string> {
  return sql<string>`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque to callers by construction: base64url of "<at>|<id>". */
export function encodeCursor(c: KeysetCursor): string {
  return Buffer.from(`${c.at}|${c.id}`, "utf8").toString("base64url");
}

/** null = malformed/tampered. Callers answer 400 rather than silently ignoring
 * it — a dropped cursor would quietly restart the page walk from the top. */
export function decodeCursor(raw: string): KeysetCursor | null {
  let decoded: string;
  try {
    decoded = Buffer.from(raw, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const bar = decoded.indexOf("|");
  if (bar < 0) return null;
  const at = decoded.slice(0, bar);
  const id = decoded.slice(bar + 1);
  if (!AT_RE.test(at) || !UUID_RE.test(id)) return null;
  return { at, id };
}

/**
 * "strictly after this cursor" under a stable `(at DESC, id DESC)` sort.
 * Row-wise comparison so Postgres can drive it from a composite index.
 */
export function afterCursorDesc(atCol: PgColumn, idCol: PgColumn, c: KeysetCursor): SQL {
  return sql`(${atCol}, ${idCol}) < (${c.at}::timestamptz, ${c.id}::uuid)`;
}
