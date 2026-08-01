/**
 * ADR-0031 item 1 — streamed, bounded, DISCLOSED CSV exports.
 *
 * These tests prove the fix empirically rather than by inspection:
 *  - batching is proven by COUNTING the SQL round trips the route makes: with
 *    a batch size of 2 the same export costs strictly more queries than with a
 *    batch big enough to hold everything;
 *  - the keyset walk is proven correct against rows sharing one microsecond-
 *    identical `at` (the case an `at < $1` cursor built from a millisecond JS
 *    Date silently drops);
 *  - the row ceiling and the default date window are proven to be disclosed in
 *    the file, never silently applied;
 *  - the column shape of a complete export is proven byte-identical to the
 *    pre-streaming implementation.
 */
import { afterAll, beforeAll, afterEach, describe, expect, it } from "vitest";
import { auditLog, createDb, desc, eq, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { USAGE_CSV_HEADER, usageEventsCsv } from "./projects.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "csv-stream-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const AUDIT_HEADER =
  "at,userId,userName,objectType,objectId,serverId,toolName,effect,ruleId,reason,detail";

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let projectId: string;

/** Count the SQL round trips a route makes by intercepting db.select(). */
async function withQueryCount<T>(fn: () => Promise<T>): Promise<{ value: T; queries: number }> {
  const original = db.select.bind(db);
  let queries = 0;
  (db as unknown as { select: unknown }).select = (...args: unknown[]) => {
    queries++;
    return (original as (...a: unknown[]) => unknown)(...args);
  };
  try {
    return { value: await fn(), queries };
  } finally {
    (db as unknown as { select: unknown }).select = original;
  }
}

function auditRow(at: Date) {
  return {
    userId,
    objectType: "mcp_tool" as const,
    objectId: null,
    serverId: null,
    toolName: "query_database",
    effect: "allow" as const,
    ruleId: "csv-stream-test",
    ruleChain: [],
    reason: "streamed export fixture",
    at,
  };
}

const ENV_KEYS = ["REGULAIT_CSV_BATCH_ROWS", "REGULAIT_CSV_MAX_ROWS", "REGULAIT_CSV_WINDOW_DAYS"];
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

  const u = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: `csvstream-${randomUUID()}@example.com`, displayName: "Csv Streamer" },
  });
  expect(u.statusCode).toBe(201);
  userId = u.json().id;

  const p = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/projects",
    payload: { name: `csv-stream-project-${randomUUID().slice(0, 8)}` },
  });
  expect(p.statusCode).toBe(201);
  projectId = p.json().id;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

afterAll(async () => {
  await app.close();
});

describe("ADR-0031: /v1/audit.csv streams in keyset batches", () => {
  it("costs strictly more round trips at batch size 2 than at one big batch, and returns the same rows", async () => {
    const base = Date.now();
    await db.insert(auditLog).values(
      Array.from({ length: 9 }, (_, i) => auditRow(new Date(base - i * 1000))),
    );

    process.env.REGULAIT_CSV_BATCH_ROWS = "2";
    const small = await withQueryCount(() =>
      app.inject({ method: "GET", headers: AUTH, url: `/v1/audit.csv?userId=${userId}` }),
    );
    process.env.REGULAIT_CSV_BATCH_ROWS = "1000";
    const big = await withQueryCount(() =>
      app.inject({ method: "GET", headers: AUTH, url: `/v1/audit.csv?userId=${userId}` }),
    );

    expect(small.value.statusCode).toBe(200);
    expect(big.value.statusCode).toBe(200);
    // 9 rows / 2 per batch = 5 page queries minimum; one batch covers all 9.
    expect(small.queries).toBeGreaterThanOrEqual(5);
    expect(small.queries).toBeGreaterThan(big.queries);
    // ...and batching changes nothing about the answer
    expect(small.value.body).toBe(big.value.body);
    const lines = small.value.body.trimEnd().split("\n");
    expect(lines[0]).toBe(AUDIT_HEADER);
    expect(lines.length).toBe(1 + 9);
  });

  it("walks rows that share one microsecond-identical timestamp without loss or duplication", async () => {
    // the exact case a cursor built from a millisecond-truncated JS Date drops
    const at = new Date(Date.UTC(2026, 6, 15, 12, 0, 0));
    await db.insert(auditLog).values(Array.from({ length: 5 }, () => auditRow(at)));

    process.env.REGULAIT_CSV_BATCH_ROWS = "2";
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit.csv?userId=${userId}&from=2026-07-15T11:00:00Z&to=2026-07-15T13:00:00Z`,
    });
    expect(res.statusCode).toBe(200);
    const rows = res.body.trimEnd().split("\n").slice(1);
    expect(rows.length).toBe(5);
    expect(new Set(rows.map((r) => r.split(",")[0])).size).toBe(1); // same instant
  });

  it("discloses the row ceiling in a header AND a trailing comment row", async () => {
    process.env.REGULAIT_CSV_MAX_ROWS = "3";
    process.env.REGULAIT_CSV_BATCH_ROWS = "2";
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit.csv?userId=${userId}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-regulait-export-row-limit"]).toBe("3");
    const lines = res.body.trimEnd().split("\n");
    expect(lines[0]).toBe(AUDIT_HEADER);
    expect(lines.length).toBe(1 + 3 + 1); // header + ceiling rows + the notice
    const notice = lines[lines.length - 1]!;
    expect(notice).toContain("# REGULAIT EXPORT NOTICE:");
    expect(notice).toContain("3-row export ceiling");
    expect(notice).toContain("NOT the complete trail");
    // the notice is ONE rfc-4180 field, so the data columns above are untouched
    expect(notice.startsWith('"')).toBe(true);
    expect(notice.endsWith('"')).toBe(true);
  });

  it("applies a default date window, discloses it when it actually clips rows, and honours explicit bounds", async () => {
    const old = new Date(Date.now() - 200 * 86_400_000);
    await db.insert(auditLog).values([auditRow(old)]);

    const defaulted = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit.csv?userId=${userId}`,
    });
    expect(defaulted.statusCode).toBe(200);
    expect(defaulted.headers["x-regulait-export-window-source"]).toBe("default");
    expect(defaulted.headers["x-regulait-export-window-from"]).toBeTruthy();
    expect(defaulted.body).not.toContain(old.toISOString());
    const tail = defaulted.body.trimEnd().split("\n").pop()!;
    expect(tail).toContain("# REGULAIT EXPORT NOTICE:");
    expect(tail).toContain("older matching rows exist");

    const explicit = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit.csv?userId=${userId}&from=${new Date(Date.now() - 400 * 86_400_000).toISOString()}`,
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.headers["x-regulait-export-window-source"]).toBe("caller");
    expect(explicit.body).toContain(old.toISOString());
    expect(explicit.body).not.toContain("# REGULAIT EXPORT NOTICE:");
  });

  it("a complete, unclipped export carries no notice row and keeps the exact legacy column shape", async () => {
    process.env.REGULAIT_CSV_WINDOW_DAYS = "0"; // no default window at all
    const res = await app.inject({ method: "GET", headers: AUTH, url: "/v1/audit.csv" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-regulait-export-window-source"]).toBe("unbounded");
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.headers["content-disposition"]).toContain("audit-log.csv");
    expect(res.body).not.toContain("# REGULAIT EXPORT");
    expect(res.body.split("\n")[0]).toBe(AUDIT_HEADER);
    expect(res.body.endsWith("\n")).toBe(true);
  });

  it("stays admin-only", async () => {
    const anon = await app.inject({ method: "GET", url: "/v1/audit.csv" });
    expect(anon.statusCode).toBe(401);
  });
});

describe("ADR-0031: usage_events exports stream too", () => {
  it("costs.csv batches, keeps CRLF and the legacy header, and matches the non-streamed renderer", async () => {
    await db.insert(usageEvents).values(
      Array.from({ length: 7 }, (_, i) => ({
        userId,
        projectId,
        objectType: "agent",
        model: i === 0 ? 'a,b"c' : `m-${i}`,
        inputTokens: i,
        outputTokens: i,
        costUsd: 0.01,
        at: new Date(Date.now() - i * 1000),
      })),
    );

    process.env.REGULAIT_CSV_BATCH_ROWS = "2";
    const small = await withQueryCount(() =>
      app.inject({ method: "GET", headers: AUTH, url: `/v1/projects/${projectId}/costs.csv` }),
    );
    process.env.REGULAIT_CSV_BATCH_ROWS = "1000";
    const big = await withQueryCount(() =>
      app.inject({ method: "GET", headers: AUTH, url: `/v1/projects/${projectId}/costs.csv` }),
    );

    expect(small.value.statusCode).toBe(200);
    expect(small.queries).toBeGreaterThan(big.queries);
    expect(small.value.body).toBe(big.value.body);
    expect(small.value.body.split("\r\n")[0]).toBe(USAGE_CSV_HEADER.join(","));
    expect(small.value.body).toContain('"a,b""c"'); // escaping preserved
    expect(small.value.body.endsWith("\r\n")).toBe(true);

    // byte-identical to the pre-streaming renderer over the same rows
    const rows = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.projectId, projectId))
      .orderBy(desc(usageEvents.at));
    expect(small.value.body).toBe(usageEventsCsv(rows));
  });

  it("/v1/usage-events?format=csv discloses when its `limit` ceiling cuts the export short", async () => {
    const res = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/usage-events?format=csv&userId=${userId}&limit=2`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-regulait-export-row-limit"]).toBe("2");
    const lines = res.body.trimEnd().split("\r\n");
    expect(lines[0]).toBe(USAGE_CSV_HEADER.join(","));
    expect(lines.length).toBe(1 + 2 + 1);
    expect(lines[lines.length - 1]).toContain("# REGULAIT EXPORT NOTICE:");
  });
});
