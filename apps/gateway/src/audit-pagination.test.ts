/**
 * ADR-0031 item 2 — cursor pagination on the audit read surface.
 *
 * The endpoint was hard-capped at `.limit(100)` with a single `userId` filter,
 * so on a compliance product no admin could ever reach row 101. These tests
 * pin: the unchanged default for callers that pass nothing, a complete walk
 * over more rows than one page holds (with no loss and no duplication, even
 * across rows sharing one instant), the documented page ceiling, the new
 * filters, and a 400 on a tampered cursor rather than a silent restart.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp, AUDIT_MAX_PAGE_SIZE } from "./app.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "audit-page-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;

const TOTAL = 250;
/** every fixture row shares ONE instant, so the walk is forced through the
 * (at, id) tiebreaker rather than getting a free ride from distinct timestamps */
const SHARED_AT = new Date(Date.UTC(2026, 5, 1, 9, 0, 0));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `audit-page-${randomUUID()}@example.com`, displayName: "Audit Pager" },
  });
  expect(u.statusCode).toBe(201);
  userId = u.json().id;

  // A4 (ADR-0027): a spread of deploy modes INCLUDING nulls, so the shared-WHERE
  // equivalence and the bucket-partition assertions have something to bite on.
  const MODES = ["hosted", "byoc", "air_gapped", null] as const;
  await db.insert(auditLog).values(
    Array.from({ length: TOTAL }, (_, i) => ({
      userId,
      objectType: (i % 2 === 0 ? "mcp_tool" : "agent") as "mcp_tool",
      effect: (i % 5 === 0 ? "deny" : "allow") as "allow",
      ruleId: `page-fixture-${i}`,
      ruleChain: [],
      reason: `row ${i}`,
      deployMode: MODES[i % MODES.length] as "hosted" | null,
      at: SHARED_AT,
    })),
  );
  // one row far in the past, for the from/to filters
  await db.insert(auditLog).values({
    userId,
    objectType: "mcp_tool",
    effect: "allow",
    ruleId: "page-fixture-ancient",
    ruleChain: [],
    reason: "ancient",
    at: new Date(Date.UTC(2020, 0, 1)),
  });
});

afterAll(async () => {
  await app.close();
});

async function get(url: string) {
  const res = await app.inject({ method: "GET", headers: AUTH, url });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("ADR-0031: /v1/audit cursor pagination", () => {
  it("keeps the old default for a caller that passes nothing", async () => {
    const body = await get(`/v1/audit?userId=${userId}`);
    expect(body.entries.length).toBe(100);
    expect(body.pageSize).toBe(100);
    expect(body.maxPageSize).toBe(AUDIT_MAX_PAGE_SIZE);
    expect(body.hasMore).toBe(true);
    expect(typeof body.nextCursor).toBe("string");
    // the row contract is unchanged — no cursor-derivation field leaks out
    expect(body.entries[0]).not.toHaveProperty("atText");
    expect(body.entries[0]).toHaveProperty("ruleChain");
  });

  it("walks past row 100 to the end with no loss and no duplication", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body: {
        entries: Array<{ id: string }>;
        nextCursor: string | null;
        hasMore: boolean;
      } = await get(`/v1/audit?userId=${userId}&limit=60${cursor ? `&cursor=${cursor}` : ""}`);
      pages++;
      for (const e of body.entries) seen.push(e.id);
      cursor = body.nextCursor;
      expect(pages).toBeLessThan(20); // no infinite walk
    } while (cursor);

    expect(seen.length).toBe(TOTAL + 1);
    expect(new Set(seen).size).toBe(TOTAL + 1); // no duplicates
    expect(pages).toBeGreaterThan(4); // genuinely paged
  });

  it("caps the page size and rejects a page size above the documented ceiling", async () => {
    const ok = await get(`/v1/audit?userId=${userId}&limit=${AUDIT_MAX_PAGE_SIZE}`);
    expect(ok.entries.length).toBe(TOTAL + 1);
    expect(ok.hasMore).toBe(false);
    expect(ok.nextCursor).toBe(null);

    const tooBig = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit?userId=${userId}&limit=${AUDIT_MAX_PAGE_SIZE + 1}`,
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it("filters on from/to, objectType and effect alongside userId", async () => {
    const recent = await get(
      `/v1/audit?userId=${userId}&limit=1000&from=${new Date(Date.UTC(2026, 0, 1)).toISOString()}`,
    );
    expect(recent.entries.length).toBe(TOTAL);
    expect(recent.entries.some((e: { reason: string }) => e.reason === "ancient")).toBe(false);

    const ancient = await get(
      `/v1/audit?userId=${userId}&to=${new Date(Date.UTC(2021, 0, 1)).toISOString()}`,
    );
    expect(ancient.entries.length).toBe(1);
    expect(ancient.entries[0].reason).toBe("ancient");

    const denies = await get(`/v1/audit?userId=${userId}&effect=deny&limit=1000`);
    expect(denies.entries.length).toBe(TOTAL / 5);
    for (const e of denies.entries) expect(e.effect).toBe("deny");

    const agents = await get(`/v1/audit?userId=${userId}&objectType=agent&limit=1000`);
    expect(agents.entries.length).toBe(TOTAL / 2);
    for (const e of agents.entries) expect(e.objectType).toBe("agent");
  });

  it("400s on a tampered cursor instead of silently restarting the walk", async () => {
    for (const bad of ["not-base64!!", Buffer.from("nope").toString("base64url")]) {
      const res = await app.inject({
        method: "GET",
        headers: AUTH,
        url: `/v1/audit?userId=${userId}&cursor=${encodeURIComponent(bad)}`,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_cursor");
    }
  });

  it("stays admin-only", async () => {
    const anon = await app.inject({ method: "GET", url: "/v1/audit" });
    expect(anon.statusCode).toBe(401);
  });
});

/**
 * The screen and the download must never diverge (PR #79's shared-WHERE
 * requirement, now covering ADR-0031's filters too). Both endpoints parse the
 * same zod object and build their predicate with the same `auditFilters()`;
 * this walks a matrix of filter combinations and asserts the two surfaces
 * select the SAME rows — the regression that would otherwise show up as an
 * auditor's export quietly ignoring a filter the admin applied.
 */
describe("ADR-0031 + PR #79: /v1/audit and /v1/audit.csv select identical rows", () => {
  /** the ids the screen returns for a filter (paging all the way through) */
  async function screenIds(query: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const body: { entries: Array<{ id: string }>; nextCursor: string | null } = await get(
        `/v1/audit?${query}&limit=${AUDIT_MAX_PAGE_SIZE}${cursor ? `&cursor=${cursor}` : ""}`,
      );
      for (const e of body.entries) ids.push(e.id);
      cursor = body.nextCursor;
    } while (cursor);
    return ids;
  }

  /** the (at,ruleId) pairs the export writes — the CSV has no id column, so
   * the comparison rides the two fields that identify a fixture row */
  async function exportKeys(query: string): Promise<string[]> {
    const res = await app.inject({ method: "GET", headers: AUTH, url: `/v1/audit.csv?${query}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain("# REGULAIT EXPORT NOTICE");
    const [header, ...rows] = res.body.trimEnd().split("\n");
    const cols = header!.split(",");
    const atIdx = cols.indexOf("at");
    const ruleIdx = cols.indexOf("ruleId");
    const modeIdx = cols.indexOf("deployMode");
    expect(atIdx).toBe(0);
    expect(ruleIdx).toBeGreaterThan(0);
    expect(modeIdx).toBe(ruleIdx + 1);
    return rows.map((r) => {
      const cells = r.split(",");
      return `${cells[atIdx]}|${cells[ruleIdx]}|${cells[modeIdx]}`;
    });
  }

  async function screenKeys(query: string): Promise<string[]> {
    const body: { entries: Array<{ at: string; ruleId: string; deployMode: string | null }> } =
      await get(`/v1/audit?${query}&limit=${AUDIT_MAX_PAGE_SIZE}`);
    return body.entries.map((e) => `${e.at}|${e.ruleId}|${e.deployMode ?? "unknown"}`);
  }

  // a wide window so the export's default 90-day lookback never clips, which
  // would be a legitimate difference rather than a filter divergence
  const WIDE = `from=${new Date(Date.UTC(2000, 0, 1)).toISOString()}`;

  const MATRIX = [
    `userId=__UID__`,
    `userId=__UID__&effect=deny`,
    `userId=__UID__&objectType=agent`,
    `userId=__UID__&deployMode=unknown`,
    `userId=__UID__&deployMode=hosted`,
    `userId=__UID__&deployMode=byoc`,
    `userId=__UID__&effect=allow&objectType=mcp_tool`,
    `userId=__UID__&effect=deny&deployMode=unknown`,
  ];

  it("agree row-for-row across every filter combination, including deployMode", async () => {
    for (const template of MATRIX) {
      const q = `${template.replace(/__UID__/g, userId)}&${WIDE}`;
      const fromScreen = await screenKeys(q);
      const fromExport = await exportKeys(q);
      expect(fromExport, `filter: ${q}`).toEqual(fromScreen);
    }
  });

  it("the deployMode buckets partition the trail with no row lost or double-counted", async () => {
    const all = await screenIds(`userId=${userId}&${WIDE}`);
    const buckets = await Promise.all(
      (["hosted", "byoc", "air_gapped", "unknown"] as const).map((m) =>
        screenIds(`userId=${userId}&deployMode=${m}&${WIDE}`),
      ),
    );
    const union = buckets.flat();
    expect(new Set(union).size).toBe(union.length); // no row in two buckets
    expect(new Set(union)).toEqual(new Set(all)); // and none missing
    // `unknown` is NULL-only, never an "other" that swallows named modes
    expect(buckets[3]!.length).toBeGreaterThan(0);
  });

  it("the export applies the date window identically to the screen", async () => {
    const cut = new Date(Date.UTC(2023, 0, 1)).toISOString();
    const q = `userId=${userId}&from=${cut}`;
    expect(await exportKeys(q)).toEqual(await screenKeys(q));
    // and the ancient row is excluded from BOTH
    expect((await exportKeys(q)).some((k) => k.includes("page-fixture-ancient"))).toBe(false);
    expect((await screenKeys(q)).some((k) => k.includes("page-fixture-ancient"))).toBe(false);
  });

  it("rejects an unknown deployMode on both surfaces rather than ignoring it", async () => {
    for (const url of ["/v1/audit", "/v1/audit.csv"]) {
      const res = await app.inject({
        method: "GET",
        headers: AUTH,
        url: `${url}?deployMode=on_prem`,
      });
      expect(res.statusCode, url).toBe(400);
    }
  });
});
