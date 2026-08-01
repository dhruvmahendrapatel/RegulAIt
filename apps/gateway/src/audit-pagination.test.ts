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

  await db.insert(auditLog).values(
    Array.from({ length: TOTAL }, (_, i) => ({
      userId,
      objectType: (i % 2 === 0 ? "mcp_tool" : "agent") as "mcp_tool",
      effect: (i % 5 === 0 ? "deny" : "allow") as "allow",
      ruleId: `page-fixture-${i}`,
      ruleChain: [],
      reason: `row ${i}`,
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
