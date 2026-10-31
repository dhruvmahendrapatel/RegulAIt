/**
 * ADR-0226 — the shared list contract on its three pilot routes
 * (`/v1/runs`, `/v1/incidents`, `/v1/users`) and their Excel exports.
 *
 *  - limit + cursor (keyset) and limit + offset paging return every row
 *    exactly once, in the requested order;
 *  - the sort allow-list: an unknown column (or an injection attempt) is a
 *    400 and never reaches SQL;
 *  - `count=exact` and `count=estimate` (bounded, "1,000+");
 *  - the export: exactly the requested columns in order, every matching row,
 *    audited, the list's own authorisation (a non-admin gets only their runs;
 *    `/v1/users/export.xlsx` is admin-only), and the disclosed row ceiling;
 *  - callers that send none of the new params get the response they always got.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { strFromU8, unzipSync } from "fflate";
import { auditLog, createDb, desc, eq, inArray, orchestrationRuns, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { COUNT_ESTIMATE_CAP, exportCapNotice, listExportMaxRows, wantsListContract } from "./list-contract.js";
import { likeLiteral } from "./users-list.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `lc-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let restoreMfa: () => Promise<void>;
let restoreStepUp: () => Promise<void>;
const who = {} as Record<"a" | "b" | "c", { id: string; auth: { authorization: string } }>;
const runIds = { a: [] as string[], b: [] as string[], c: [] as string[] };
const A_RUNS = 37;
const C_RUNS = COUNT_ESTIMATE_CAP + 5;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = (url: string, headers: Record<string, string> = AUTH) => app.inject({ method: "GET", url, headers });

/** the first sheet of an .xlsx as rows of cell text (shared strings resolved, numbers as numbers) */
function readXlsx(buf: Buffer): Array<Array<string | number | null>> {
  const files = unzipSync(new Uint8Array(buf));
  const shared = files["xl/sharedStrings.xml"] ? [...strFromU8(files["xl/sharedStrings.xml"]).matchAll(/<si>(.*?)<\/si>/gs)].map((m) => decodeXml([...m[1]!.matchAll(/<t(?:\s[^>]*)?>(.*?)<\/t>/gs)].map((t) => t[1]!).join(""))) : [];
  const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
  return [...sheet.matchAll(/<row[^>]*>(.*?)<\/row>/gs)].map((row) => {
    const out: Array<string | number | null> = [];
    for (const c of row[1]!.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(.*?)<\/c>)/gs)) {
      const col = c[1]!.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
      const v = /<v>(.*?)<\/v>/s.exec(c[3] ?? "")?.[1];
      while (out.length < col) out.push(null);
      out[col] = v === undefined ? null : /t="s"/.test(c[2]!) ? shared[Number(v)]! : Number(v);
    }
    return out;
  });
}
const decodeXml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

async function walk(url: string, headers: Record<string, string>, mode: "cursor" | "offset"): Promise<Json[]> {
  const out: Json[] = [];
  let next: string | null = "";
  for (let guard = 0; guard < 200; guard++) {
    const res = await get(`${url}${next ?? ""}`, headers);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Json;
    out.push(...body.items);
    if (mode === "cursor") {
      expect(body.nextOffset).toBeNull();
      if (!body.nextCursor) return out;
      next = `&cursor=${encodeURIComponent(body.nextCursor)}`;
    } else {
      expect(body.nextCursor).toBeNull();
      if (body.nextOffset === null) return out;
      next = `&offset=${body.nextOffset}`;
    }
  }
  throw new Error("paging did not end");
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });
  for (const k of ["a", "b", "c"] as const) {
    const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `lc-${k}-${RUN}@example.com`, displayName: `lc ${k} ${RUN}` } });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "lc" } });
    expect(key.statusCode, key.body).toBe(201);
    who[k] = { id, auth: { authorization: `Bearer ${key.json().token}` } };
  }
  const base = Date.parse("2026-01-01T00:00:00Z");
  const row = (k: "a" | "b" | "c", i: number, at: number) => ({
    name: `lc-${k}-${RUN}-${String((i * 7919) % 1000).padStart(3, "0")}`,
    initiatingUserId: who[k].id,
    graph: { run: "lc", nodes: [] },
    state: { nodeStatuses: { n1: i % 2 ? "done" : "pending", n2: "done" } },
    budget: { measuredSpentUsd: (i % 5) * 0.25, ...(i % 3 ? { capUsd: i } : {}) },
    status: (["planned", "running", "completed", "aborted"] as const)[i % 4]!,
    // three runs share one instant, so the id tie-breaker carries the order
    createdAt: new Date(base + (i < 3 ? 0 : i) * 60_000 + 0.5),
  });
  const ins = async (k: "a" | "b" | "c", rows: ReturnType<typeof row>[]) => {
    for (let i = 0; i < rows.length; i += 500) {
      const got = await db.insert(orchestrationRuns).values(rows.slice(i, i + 500)).returning({ id: orchestrationRuns.id });
      runIds[k].push(...got.map((g) => g.id));
    }
  };
  await ins("a", Array.from({ length: A_RUNS }, (_, i) => row("a", i, i)));
  await ins("b", Array.from({ length: 5 }, (_, i) => row("b", i, i)));
  await ins("c", Array.from({ length: C_RUNS }, (_, i) => row("c", i, i)));
}, 120_000);

afterAll(async () => {
  const all = [...runIds.a, ...runIds.b, ...runIds.c];
  for (let i = 0; i < all.length; i += 500) await db.delete(orchestrationRuns).where(inArray(orchestrationRuns.id, all.slice(i, i + 500)));
  await restoreStepUp?.();
  await restoreMfa?.();
});

describe("ADR-0226: paging returns every row exactly once", () => {
  it("keyset (cursor) paging on the default sort, newest first with the id as tie-breaker", async () => {
    const items = await walk("/v1/runs?limit=10&count=exact", who.a.auth, "cursor");
    expect(items).toHaveLength(A_RUNS);
    expect(new Set(items.map((r) => r.id))).toEqual(new Set(runIds.a));
    const order = await db
      .select({ id: orchestrationRuns.id })
      .from(orchestrationRuns)
      .where(eq(orchestrationRuns.initiatingUserId, who.a.id))
      .orderBy(desc(orchestrationRuns.createdAt), desc(orchestrationRuns.id));
    expect(items.map((r) => r.id)).toEqual(order.map((r) => r.id));
  });

  it("keyset paging ascending, and a 500 'All' chunk holds the whole list in one page", async () => {
    const asc = await walk("/v1/runs?limit=10&sort=created&dir=asc", who.a.auth, "cursor");
    expect(asc).toHaveLength(A_RUNS);
    const desc_ = await walk("/v1/runs?limit=10&sort=created&dir=desc", who.a.auth, "cursor");
    expect(asc.map((r) => r.id)).toEqual([...desc_.map((r) => r.id)].reverse());
    const all = await get("/v1/runs?limit=500&count=exact", who.a.auth);
    expect(all.json().items).toHaveLength(A_RUNS);
    expect(all.json().nextCursor).toBeNull();
  });

  it("offset paging on any other sort; the order is the server's, across all rows", async () => {
    for (const size of [10, 50, 100]) {
      const items = await walk(`/v1/runs?limit=${size}&sort=name&dir=asc`, who.a.auth, "offset");
      expect(items).toHaveLength(A_RUNS);
      expect(new Set(items.map((r) => r.id)).size).toBe(A_RUNS);
      const names = items.map((r) => String(r.name).toLowerCase());
      expect(names).toEqual([...names].sort());
    }
    const spend = await walk("/v1/runs?limit=10&sort=spend&dir=desc", who.a.auth, "offset");
    const values = spend.map((r) => r.budget.measuredSpentUsd as number);
    expect(values).toEqual([...values].sort((x, y) => y - x));
    // nulls last in either direction
    const cap = await walk("/v1/runs?limit=10&sort=cap&dir=asc", who.a.auth, "offset");
    const caps = cap.map((r) => (r.budget.capUsd ?? null) as number | null);
    const firstNull = caps.indexOf(null);
    expect(caps.slice(firstNull).every((c) => c === null)).toBe(true);
    expect(caps.slice(0, firstNull)).toEqual([...caps.slice(0, firstNull)].sort((x, y) => x! - y!));
  });

  it("a non-admin sees only their own runs; the admin sees everyone's", async () => {
    const b = await walk("/v1/runs?limit=10&sort=created", who.b.auth, "cursor");
    expect(new Set(b.map((r) => r.id))).toEqual(new Set(runIds.b));
    const admin = await get("/v1/runs?limit=10&count=exact");
    expect(admin.json().total).toBeGreaterThanOrEqual(A_RUNS + 5 + C_RUNS);
  });

  it("users and incidents page the same way", async () => {
    const users = await walk(`/v1/users?limit=10&sort=email&dir=asc&q=${encodeURIComponent(`-${RUN}@`)}`, AUTH, "offset");
    expect(users.map((u) => u.email)).toEqual([`lc-a-${RUN}@example.com`, `lc-b-${RUN}@example.com`, `lc-c-${RUN}@example.com`]);
    expect(users.every((u) => !("passwordHash" in u))).toBe(true);
    const inc: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({ method: "POST", url: "/v1/incidents", headers: who.a.auth, payload: { title: `lc incident ${RUN} ${i}`, severity: (["low", "medium", "high", "critical"] as const)[i % 4], detectionSource: "manual" } });
      expect(r.statusCode, r.body).toBe(201);
      inc.push(r.json().incident.id);
    }
    const mine = await walk("/v1/incidents?limit=10&status=active&count=exact", who.a.auth, "cursor");
    expect(new Set(mine.map((r) => r.id))).toEqual(new Set(inc));
    expect(mine[0]).toHaveProperty("clocks");
    const bySev = await walk("/v1/incidents?limit=10&sort=sev&dir=desc", who.a.auth, "offset");
    const rank = { critical: 4, high: 3, medium: 2, low: 1 } as Record<string, number>;
    expect(bySev.map((r) => rank[r.severity])).toEqual([...bySev.map((r) => rank[r.severity])].sort((x, y) => y! - x!));
    // another user who owns none of them sees none
    expect((await get("/v1/incidents?limit=10&count=exact", who.b.auth)).json()).toMatchObject({ items: [], total: 0, scope: "visible" });
  });
});

describe("ADR-0226: the sort allow-list", () => {
  it.each([
    ["an unknown column", "sort=nope"],
    ["an injection attempt", `sort=${encodeURIComponent("name; drop table users; --")}`],
    ["a quoted expression", `sort=${encodeURIComponent('"name" desc, (select 1)')}`],
    ["an inherited property", "sort=__proto__"],
    ["a constructor", "sort=constructor"],
  ])("%s is a 400 and runs no SQL", async (_label, q) => {
    const res = await get(`/v1/runs?limit=10&${q}`, who.a.auth);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_sort_column");
    expect((await get(`/v1/users?limit=10&${q}`)).statusCode).toBe(400);
    expect((await get(`/v1/incidents?limit=10&${q}`, who.a.auth)).statusCode).toBe(400);
  });

  it("a bad direction, page size, cursor or offset is a 400 too", async () => {
    for (const q of ["dir=sideways", "limit=25&sort=name", "limit=501&sort=name", "limit=1000&count=exact", "cursor=abc", "sort=name&cursor=" + "x".repeat(10), "offset=-1&sort=name", "offset=1&cursor=abc"]) {
      expect((await get(`/v1/runs?${q}`, who.a.auth)).statusCode, q).toBe(400);
    }
    // a cursor pages only a date sort
    const first = (await get("/v1/runs?limit=10&count=exact", who.a.auth)).json();
    expect(first.nextCursor).toEqual(expect.any(String));
    const res = await get(`/v1/runs?limit=10&sort=name&cursor=${encodeURIComponent(first.nextCursor)}`, who.a.auth);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cursor_not_supported");
  });

  it("the search is a literal match: % and _ are not wildcards", () => {
    expect(likeLiteral("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
});

describe("ADR-0226: totals", () => {
  it("count=exact is the true total; no count means total null", async () => {
    const exact = (await get("/v1/runs?limit=10&count=exact", who.c.auth)).json();
    expect(exact).toMatchObject({ total: C_RUNS, totalIsEstimate: false });
    expect(exact.items).toHaveLength(10);
    const none = (await get("/v1/runs?limit=10&sort=created", who.c.auth)).json();
    expect(none).toMatchObject({ total: null, totalIsEstimate: false });
  });

  it("count=estimate stops at the cap and says so; under the cap it is exact", async () => {
    expect((await get("/v1/runs?limit=10&count=estimate", who.c.auth)).json()).toMatchObject({ total: COUNT_ESTIMATE_CAP, totalIsEstimate: true });
    expect((await get("/v1/runs?limit=10&count=estimate", who.a.auth)).json()).toMatchObject({ total: A_RUNS, totalIsEstimate: false });
    expect((await get("/v1/runs?limit=10&count=estimate&status=planned", who.a.auth)).json()).toMatchObject({ total: 10, totalIsEstimate: false });
  });
});

describe("ADR-0226: the Excel export", () => {
  const latestExportAudit = async () =>
    (await db.select().from(auditLog).where(eq(auditLog.ruleId, "list-export-xlsx")).orderBy(desc(auditLog.at)).limit(1))[0]!;

  it("has exactly the requested columns, in order, with screen labels, for every matching row, and is audited", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/runs/export.xlsx?status=completed&sort=name&dir=desc&columns=status,name,spend,created", headers: who.a.auth });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="runs-\d{4}-\d{2}-\d{2}\.xlsx"$/);
    expect(res.headers["x-regulait-export-truncated"]).toBe("0");
    const rows = readXlsx(res.rawPayload);
    expect(rows[0]).toEqual(["Status", "Run", "Measured spend", "Created"]);
    const want = await db
      .select({ name: orchestrationRuns.name })
      .from(orchestrationRuns)
      .where(sql`${orchestrationRuns.initiatingUserId} = ${who.a.id} and ${orchestrationRuns.status} = 'completed'`)
      .orderBy(sql`lower(${orchestrationRuns.name}) desc`, desc(orchestrationRuns.id));
    expect(rows.slice(1).map((r) => r[1])).toEqual(want.map((w) => w.name));
    expect(rows.slice(1).every((r) => r[0] === "completed" && r.length === 4 && typeof r[2] === "number" && typeof r[3] === "number")).toBe(true);
    const a = await latestExportAudit();
    expect(a.userId).toBe(who.a.id);
    expect(a.objectType).toBe("audit_export");
    expect(a.detail).toMatchObject({ listId: "runs", filters: { status: "completed" }, columns: ["status", "name", "spend", "created"], rows: want.length, truncated: false, sort: "name", dir: "desc" });
  });

  it("is more than one page: every run, not just the first 10", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/runs/export.xlsx?columns=id", headers: who.c.auth });
    expect(res.statusCode).toBe(200);
    const ids = readXlsx(res.rawPayload).slice(1).map((r) => r[0]);
    expect(new Set(ids)).toEqual(new Set(runIds.c));
    expect(ids).toHaveLength(C_RUNS);
    expect((await latestExportAudit()).detail).toMatchObject({ rows: C_RUNS });
  });

  it("respects the list's authorisation: a non-admin's runs only, and the users export is admin-only", async () => {
    const b = await app.inject({ method: "GET", url: "/v1/runs/export.xlsx?columns=id,name", headers: who.b.auth });
    expect(new Set(readXlsx(b.rawPayload).slice(1).map((r) => r[0]))).toEqual(new Set(runIds.b));
    const refused = await app.inject({ method: "GET", url: "/v1/users/export.xlsx?columns=email", headers: who.a.auth });
    expect(refused.statusCode).toBe(403);
    const users = await app.inject({ method: "GET", url: `/v1/users/export.xlsx?columns=email,status,name&sort=email&q=${encodeURIComponent(`-${RUN}@`)}`, headers: AUTH });
    expect(users.statusCode).toBe(200);
    expect(readXlsx(users.rawPayload)).toEqual([
      ["Email", "Status", "Name"],
      [`lc-a-${RUN}@example.com`, "active", `lc a ${RUN}`],
      [`lc-b-${RUN}@example.com`, "active", `lc b ${RUN}`],
      [`lc-c-${RUN}@example.com`, "active", `lc c ${RUN}`],
    ]);
    const inc = await app.inject({ method: "GET", url: "/v1/incidents/export.xlsx?columns=ref,status", headers: who.b.auth });
    expect(inc.statusCode).toBe(200);
    expect(readXlsx(inc.rawPayload)).toEqual([["Incident", "Status"]]);
  });

  it("refuses an unknown, duplicated or missing column, and an unknown sort", async () => {
    for (const q of ["columns=name,passwordHash", "columns=name,name", "", "columns=name&sort=nope", `columns=${encodeURIComponent("name,(select 1)")}`]) {
      expect((await app.inject({ method: "GET", url: `/v1/runs/export.xlsx?${q}`, headers: who.a.auth })).statusCode, q).toBe(400);
    }
  });

  it("caps Excel at 100,000 rows by default, its own setting, and never above the CSV ceiling", () => {
    const prev = { x: process.env.REGULAIT_XLSX_MAX_ROWS, c: process.env.REGULAIT_CSV_MAX_ROWS };
    try {
      delete process.env.REGULAIT_XLSX_MAX_ROWS;
      delete process.env.REGULAIT_CSV_MAX_ROWS;
      expect(listExportMaxRows()).toBe(100_000);
      process.env.REGULAIT_XLSX_MAX_ROWS = "250";
      expect(listExportMaxRows()).toBe(250);
      process.env.REGULAIT_CSV_MAX_ROWS = "40";
      expect(listExportMaxRows()).toBe(40);
      process.env.REGULAIT_XLSX_MAX_ROWS = "nonsense";
      expect(listExportMaxRows()).toBe(40);
    } finally {
      for (const [k, v] of [["REGULAIT_XLSX_MAX_ROWS", prev.x], ["REGULAIT_CSV_MAX_ROWS", prev.c]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("stops at the CSV exports' row ceiling and says so in the last row and the headers", async () => {
    const prev = process.env.REGULAIT_CSV_MAX_ROWS;
    process.env.REGULAIT_CSV_MAX_ROWS = "20";
    try {
      const res = await app.inject({ method: "GET", url: "/v1/runs/export.xlsx?columns=name", headers: who.a.auth });
      expect(res.headers["x-regulait-export-truncated"]).toBe("1");
      expect(res.headers["x-regulait-export-row-limit"]).toBe("20");
      const rows = readXlsx(res.rawPayload);
      expect(rows).toHaveLength(1 + 20 + 1);
      expect(rows.at(-1)).toEqual([exportCapNotice(20)]);
      expect((await latestExportAudit()).detail).toMatchObject({ rows: 20, truncated: true, maxRows: 20 });
    } finally {
      if (prev === undefined) delete process.env.REGULAIT_CSV_MAX_ROWS;
      else process.env.REGULAIT_CSV_MAX_ROWS = prev;
    }
  });

  it("writes a cell that looks like a formula as text", async () => {
    const [r] = await db.insert(orchestrationRuns).values({ name: "=HYPERLINK(\"http://x\")", initiatingUserId: who.b.id, graph: {}, state: {}, status: "planned" }).returning({ id: orchestrationRuns.id });
    runIds.b.push(r!.id);
    const res = await app.inject({ method: "GET", url: "/v1/runs/export.xlsx?columns=name&sort=created&dir=desc", headers: who.b.auth });
    const files = unzipSync(new Uint8Array(res.rawPayload));
    expect(strFromU8(files["xl/worksheets/sheet1.xml"]!)).not.toContain("<f>");
    expect(readXlsx(res.rawPayload)[1]).toEqual(['=HYPERLINK("http://x")']);
  });
});

describe("ADR-0226: existing callers are unchanged", () => {
  it("only the new params switch a route to the contract", () => {
    expect(wantsListContract({})).toBe(false);
    expect(wantsListContract({ limit: "10", status: "running" })).toBe(false);
    for (const k of ["sort", "dir", "cursor", "offset", "count"]) expect(wantsListContract({ [k]: "x" })).toBe(true);
  });

  it("/v1/runs, /v1/users and /v1/incidents answer their old shape and rows", async () => {
    const runs = await get("/v1/runs", who.a.auth);
    expect(Object.keys(runs.json())).toEqual(["runs"]);
    expect(new Set(runs.json().runs.map((r: Json) => r.id))).toEqual(new Set(runIds.a));
    const two = await get("/v1/runs?limit=2&status=planned", who.a.auth);
    expect(Object.keys(two.json())).toEqual(["runs"]);
    expect(two.json().runs).toHaveLength(2);
    expect((await get("/v1/runs?limit=1000", who.a.auth)).statusCode).toBe(200);
    const users = await get("/v1/users");
    expect(Object.keys(users.json())).toEqual(["users"]);
    expect(Object.keys(users.json().users[0]).sort()).toEqual(["createdAt", "disabledAt", "displayName", "email", "hasPassword", "id", "isAdmin", "mustChangePassword", "totpEnabled", "username"]);
    const inc = await get("/v1/incidents", who.a.auth);
    expect(Object.keys(inc.json()).sort()).toEqual(["disclaimer", "incidents", "scope"]);
    expect(inc.json().incidents[0]).not.toHaveProperty("_cursorAt");
    // the legacy incidents schema is still strict
    expect((await get("/v1/incidents?bogus=1", who.a.auth)).statusCode).toBe(400);
    expect((await get("/v1/incidents?limit=10&count=exact&bogus=1", who.a.auth)).statusCode).toBe(400);
  });
});
