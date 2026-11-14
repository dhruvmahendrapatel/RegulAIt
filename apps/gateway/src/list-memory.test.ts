/**
 * ADR-0226 (P2 batch D) — `list-memory.ts`, the list contract over an array: the same validated sort, offset
 * paging, totals, column checks, row ceiling and audit row as the SQL path. No database: the audit insert and the
 * reply are recorded by small fakes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Db } from "@regulait/db";
import { ZodError } from "zod";
import { COUNT_ESTIMATE_CAP, ListQueryError, exportCapNotice, type ListResult } from "./list-contract.js";
import { exportInMemory, pageInMemory, type MemoryListSpec } from "./list-memory.js";

interface Row {
  id: string;
  name: string;
  score: number | null;
  at: Date | null;
}
const SPEC: MemoryListSpec<Row> = {
  id: "memory-sample",
  sorts: {
    name: { value: (r) => r.name.toLowerCase() },
    score: { value: (r) => r.score },
    at: { value: (r) => r.at },
  },
  columns: {
    name: { label: "Name", value: (r) => r.name },
    score: { label: "Score", value: (r) => r.score },
    at: { label: "At", value: (r) => r.at },
  },
  filters: [],
  defaultSort: { col: "name", dir: "asc" },
  idOf: (r) => r.id,
};
const ROWS: Row[] = Array.from({ length: 23 }, (_, i) => ({
  id: `id-${String(i).padStart(2, "0")}`,
  name: ["Ada Admin", "avery approver", "Morgan Reyes", "Dana Developer", "Jordan Owner"][i % 5]!,
  score: i % 4 === 0 ? null : (i * 37) % 11,
  at: i % 6 === 0 ? null : new Date(Date.UTC(2026, 0, 1 + i)),
}));

/** every row, walked page by page through nextOffset */
function walk(query: Record<string, string>): Row[] {
  const out: Row[] = [];
  let offset: number | null = 0;
  for (let guard = 0; offset !== null && guard < 50; guard++) {
    const page: ListResult<Row> = pageInMemory(ROWS, { ...query, ...(offset ? { offset: String(offset) } : {}) }, SPEC);
    expect(page.nextCursor).toBeNull();
    out.push(...page.items);
    offset = page.nextOffset;
  }
  return out;
}

describe("pageInMemory: paging and sort", () => {
  it("pages every row exactly once, in the requested order, with the id as tie-breaker", () => {
    const rows = walk({ limit: "10", sort: "name", dir: "asc" });
    expect(rows).toHaveLength(ROWS.length);
    expect(new Set(rows.map((r) => r.id)).size).toBe(ROWS.length);
    const keys = rows.map((r) => `${r.name.toLowerCase()}|${r.id}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("sorts descending with nulls last in either direction", () => {
    for (const dir of ["asc", "desc"] as const) {
      const rows = walk({ limit: "10", sort: "score", dir });
      const scores = rows.map((r) => r.score);
      const firstNull = scores.indexOf(null);
      expect(scores.slice(firstNull).every((s) => s === null)).toBe(true);
      const known = scores.slice(0, firstNull) as number[];
      expect(known).toEqual([...known].sort((a, b) => (dir === "asc" ? a - b : b - a)));
    }
    const dates = walk({ limit: "50", sort: "at", dir: "desc" }).map((r) => r.at?.getTime() ?? null);
    expect(dates.slice(0, dates.indexOf(null))).toEqual([...dates.slice(0, dates.indexOf(null))].sort((a, b) => b! - a!));
  });

  it("uses the default sort when none is sent, and a sort without dir starts ascending", () => {
    const first = pageInMemory(ROWS, { limit: "10", count: "exact" }, SPEC);
    expect(first.items[0]!.name.toLowerCase()).toBe("ada admin");
    const byScore = pageInMemory(ROWS, { limit: "10", sort: "score" }, SPEC);
    expect(byScore.items[0]!.score).toBe(0);
  });

  it("answers totals as the SQL path does: null without count, exact, and the bounded estimate", () => {
    expect(pageInMemory(ROWS, { limit: "10", sort: "name" }, SPEC).total).toBeNull();
    expect(pageInMemory(ROWS, { limit: "10", count: "exact" }, SPEC)).toMatchObject({ total: 23, totalIsEstimate: false, nextOffset: 10 });
    const many = Array.from({ length: COUNT_ESTIMATE_CAP + 3 }, (_, i) => ({ ...ROWS[0]!, id: `m-${i}` }));
    expect(pageInMemory(many, { limit: "10", count: "estimate" }, SPEC)).toMatchObject({ total: COUNT_ESTIMATE_CAP, totalIsEstimate: true });
    expect(pageInMemory(ROWS, { limit: "10", count: "estimate" }, SPEC)).toMatchObject({ total: 23, totalIsEstimate: false });
    const last = pageInMemory(ROWS, { limit: "10", offset: "20", count: "exact" }, SPEC);
    expect(last.items).toHaveLength(3);
    expect(last.nextOffset).toBeNull();
  });

  it("refuses what the SQL path refuses: an unknown or prototype sort, a cursor, a bad limit, dir or offset", () => {
    const code = (q: Record<string, unknown>) => {
      try {
        pageInMemory(ROWS, q, SPEC);
        return "ok";
      } catch (e) {
        if (e instanceof ListQueryError) return e.code;
        if (e instanceof ZodError) return "zod";
        throw e;
      }
    };
    expect(code({ sort: "nope" })).toBe("unknown_sort_column");
    expect(code({ sort: "__proto__" })).toBe("unknown_sort_column");
    expect(code({ sort: "constructor" })).toBe("unknown_sort_column");
    expect(code({ sort: "name; drop table users" })).toBe("unknown_sort_column");
    expect(code({ sort: "name", cursor: "abc" })).toBe("cursor_not_supported");
    expect(code({ cursor: "abc", offset: "10" })).toBe("cursor_and_offset");
    expect(code({ limit: "7" })).toBe("zod");
    expect(code({ limit: "1000" })).toBe("zod");
    expect(code({ dir: "sideways" })).toBe("zod");
    expect(code({ offset: "-1" })).toBe("zod");
    expect(code({ offset: "1000001" })).toBe("zod");
    expect(code({ limit: "500" })).toBe("ok");
  });

  it("never changes the array it is given", () => {
    const copy = ROWS.map((r) => r.id);
    walk({ limit: "10", sort: "score", dir: "desc" });
    expect(ROWS.map((r) => r.id)).toEqual(copy);
  });
});

// ---- export ------------------------------------------------------------------

function fakes(userId: string | null = "11111111-1111-1111-1111-111111111111") {
  const audits: Array<Record<string, unknown>> = [];
  const sent: { headers: Record<string, string>; body: Buffer | null } = { headers: {}, body: null };
  const db = { insert: () => ({ values: async (v: Record<string, unknown>) => void audits.push(v) }) } as unknown as Db;
  const req = { authCtx: { userId, isAdmin: true } } as unknown as FastifyRequest;
  const reply = {
    headers(h: Record<string, string>) {
      Object.assign(sent.headers, h);
      return this;
    },
    send(b: Buffer) {
      sent.body = b;
      return this;
    },
  } as unknown as FastifyReply;
  return { db, req, reply, audits, sent };
}

function sheetRows(buf: Buffer): string[][] {
  const files = unzipSync(new Uint8Array(buf));
  const shared = files["xl/sharedStrings.xml"]
    ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>(.*?)<\/si>/gs)].map((m) => [...m[1]!.matchAll(/<t(?:\s[^>]*)?>(.*?)<\/t>/gs)].map((t) => t[1]!).join(""))
    : [];
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
  return [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((row) =>
    [...row[1]!.matchAll(/<c r="[A-Z]+\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)].map((c) => {
      const v = /<v>(.*?)<\/v>/s.exec(c[2] ?? "")?.[1] ?? "";
      return /t="s"/.test(c[1]!) ? shared[Number(v)]! : v;
    }),
  );
}

describe("exportInMemory: the audited Excel file", () => {
  const saved = process.env.REGULAIT_XLSX_MAX_ROWS;
  afterEach(() => {
    if (saved === undefined) delete process.env.REGULAIT_XLSX_MAX_ROWS;
    else process.env.REGULAIT_XLSX_MAX_ROWS = saved;
  });

  it("holds exactly the requested columns in order, every row in the requested sort, and writes the audit row", async () => {
    const f = fakes();
    const out = await exportInMemory(f.db, f.req, f.reply, ROWS, { columns: "score,name", sort: "name", dir: "desc" }, SPEC, { source: "override" });
    expect(out).toEqual({ rows: 23, truncated: false });
    const rows = sheetRows(f.sent.body!);
    expect(rows[0]).toEqual(["Score", "Name"]);
    expect(rows).toHaveLength(24);
    expect(rows[1]![1]!.toLowerCase()).toBe("morgan reyes");
    expect(f.sent.headers["content-disposition"]).toMatch(/^attachment; filename="memory-sample-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(f.sent.headers["x-regulait-export-truncated"]).toBe("0");
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]).toMatchObject({
      objectType: "audit_export",
      ruleId: "list-export-xlsx",
      effect: "allow",
      userId: "11111111-1111-1111-1111-111111111111",
      detail: { listId: "memory-sample", filters: { source: "override" }, sort: "name", dir: "desc", columns: ["score", "name"], rows: 23, truncated: false },
    });
  });

  it("stops at the row ceiling, says so in the last row, the headers and the audit row", async () => {
    process.env.REGULAIT_XLSX_MAX_ROWS = "5";
    const f = fakes(null);
    const out = await exportInMemory(f.db, f.req, f.reply, ROWS, { columns: "name" }, SPEC, {});
    expect(out).toEqual({ rows: 5, truncated: true });
    const rows = sheetRows(f.sent.body!);
    expect(rows).toHaveLength(1 + 5 + 1);
    expect(rows.at(-1)![0]).toBe(exportCapNotice(5));
    expect(f.sent.headers["x-regulait-export-truncated"]).toBe("1");
    expect(f.sent.headers["x-regulait-export-row-limit"]).toBe("5");
    expect(f.audits[0]).toMatchObject({ userId: "00000000-0000-0000-0000-000000000000", detail: { rows: 5, truncated: true, maxRows: 5 } });
  });

  it("refuses an unknown, repeated or missing column and an unknown sort before anything is audited or sent", async () => {
    for (const q of [{ columns: "name,nope" }, { columns: "name,name" }, {}, { columns: "name", sort: "__proto__" }]) {
      const f = fakes();
      await expect(exportInMemory(f.db, f.req, f.reply, ROWS, q, SPEC, {})).rejects.toBeTruthy();
      expect(f.audits).toHaveLength(0);
      expect(f.sent.body).toBeNull();
    }
  });

  it("an empty list is still an audited file with its header row", async () => {
    const f = fakes();
    expect(await exportInMemory(f.db, f.req, f.reply, [], { columns: "name,at" }, SPEC, {})).toEqual({ rows: 0, truncated: false });
    expect(sheetRows(f.sent.body!)).toEqual([["Name", "At"]]);
    expect(f.audits).toHaveLength(1);
  });
});
