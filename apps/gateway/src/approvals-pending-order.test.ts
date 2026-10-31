/**
 * THE PENDING QUEUE KEEPS EVERY PENDING APPROVAL.
 *
 * `GET /v1/approvals` answers at most 100 rows, newest first. The Inbox and the
 * Review workbench used to read it unfiltered and keep the pending rows in the
 * browser, so once 100 NEWER rows of any status existed, older pending
 * approvals vanished from the page. The fix asks the server for
 * `status=pending&order=asc` and reads `total` / `hasMore` for the true size.
 *
 * What this file proves, all on its own rows (a non-admin's visibility is
 * exactly the rows naming them, so counts are exact in a shared database):
 *   - pending rows older than 100 newer decided rows are still returned;
 *   - `order=asc` is oldest first and the default stays newest first;
 *   - `total` matches the rows the same filters and visibility match, and
 *     `hasMore` reports a capped page;
 *   - a comma-separated `status` list filters to exactly those statuses;
 *   - a non-admin never sees another user's rows, filter or no filter, and
 *     `total` does not leak their count either.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, inArray, runMigrations, approvals, users, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import path from "node:path";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "approvals-pending-order-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let dana: { id: string; auth: { authorization: string } };
let eli: { id: string; auth: { authorization: string } };
let fran: { id: string; auth: { authorization: string } };
const userIds: string[] = [];
const created: string[] = [];

interface Page {
  approvals: Array<{ id: string; status: string; requestedAt: string; approverUserId: string }>;
  total: number;
  hasMore: boolean;
  limit: number;
}

const makeUser = async (label: string) => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `apo-${label}-${randomUUID()}@queue.example`, displayName: `APO ${label}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  userIds.push(id);
  const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "apo" } });
  return { id, auth: { authorization: `Bearer ${key.json().token}` } };
};

/** `n` rows for one approver, requested `startMinutesAgo`, one minute apart, getting newer */
const addRows = async (approverUserId: string, status: string, n: number, startMinutesAgo: number) => {
  const now = Date.now();
  const rows = await db
    .insert(approvals)
    .values(
      Array.from({ length: n }, (_, i) => ({
        userId: approverUserId,
        objectType: "mcp_tool" as const,
        approverUserId,
        status: status as "pending",
        requestedAt: new Date(now - (startMinutesAgo - i) * 60_000),
      })),
    )
    .returning({ id: approvals.id });
  created.push(...rows.map((r) => r.id));
  return rows.map((r) => r.id);
};

const page = async (auth: { authorization: string }, query: string): Promise<Page> => {
  const res = await app.inject({ method: "GET", url: `/v1/approvals${query}`, headers: auth });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Page;
};

let danaOldPending: string[];
let franPending: string[];

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  dana = await makeUser("dana");
  eli = await makeUser("eli");
  fran = await makeUser("fran");

  // Dana: 3 pending approvals requested days ago, then 120 NEWER decided ones —
  // more than a page, so an unfiltered newest-first read cannot contain the 3
  danaOldPending = await addRows(dana.id, "pending", 3, 5_000);
  await addRows(dana.id, "approved", 80, 1_000);
  await addRows(dana.id, "denied", 40, 500);
  // Fran: 105 pending — more pending than one page holds
  franPending = await addRows(fran.id, "pending", 105, 2_000);
  // Eli: 2 pending of his own, the rows a widened read would leak to Dana
  await addRows(eli.id, "pending", 2, 3_000);
}, 120_000);

afterAll(async () => {
  if (created.length) await db.delete(approvals).where(inArray(approvals.id, created));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  await app.close();
  await db.$client.end();
});

describe("the pending queue", () => {
  it("reproduces the bug: the unfiltered newest-first page hides older pending rows", async () => {
    const p = await page(dana.auth, "");
    expect(p.approvals).toHaveLength(100);
    expect(p.approvals.some((r) => danaOldPending.includes(r.id))).toBe(false);
    // ...and total says how many there really are
    expect(p.total).toBe(123);
    expect(p.hasMore).toBe(true);
    expect(p.limit).toBe(100);
  });

  it("returns pending rows older than 100 newer decided rows when asked for status=pending", async () => {
    const p = await page(dana.auth, "?status=pending&order=asc");
    expect(p.approvals.map((r) => r.id)).toEqual(danaOldPending);
    expect(p.total).toBe(3);
    expect(p.hasMore).toBe(false);
  });

  it("order=asc is oldest first; the default stays newest first", async () => {
    const asc = await page(dana.auth, "?status=pending&order=asc");
    const desc = await page(dana.auth, "?status=pending");
    const times = (p: Page) => p.approvals.map((r) => Date.parse(r.requestedAt));
    expect(times(asc)).toEqual([...times(asc)].sort((a, b) => a - b));
    expect(times(desc)).toEqual([...times(desc)].sort((a, b) => b - a));
    expect(desc.approvals.map((r) => r.id)).toEqual([...danaOldPending].reverse());
  });

  it("caps at 100, returns the OLDEST 100 with order=asc, and total counts all 105", async () => {
    const p = await page(fran.auth, "?status=pending&order=asc");
    expect(p.approvals).toHaveLength(100);
    expect(p.approvals.map((r) => r.id)).toEqual(franPending.slice(0, 100));
    expect(p.total).toBe(105);
    expect(p.hasMore).toBe(true);
  });

  it("total matches the same filters for an admin (narrowed by approver)", async () => {
    const p = await page(AUTH, `?status=pending&order=asc&approverUserId=${fran.id}`);
    expect(p.total).toBe(105);
    expect(p.approvals[0]!.id).toBe(franPending[0]);
    expect(p.approvals.every((r) => r.approverUserId === fran.id && r.status === "pending")).toBe(true);
  });

  it("a comma-separated status list is the decided query, and only those statuses", async () => {
    const p = await page(dana.auth, "?status=approved,denied,returned,consumed,superseded");
    expect(p.total).toBe(120);
    expect(p.approvals).toHaveLength(100);
    expect(p.approvals.every((r) => r.status === "approved" || r.status === "denied")).toBe(true);
  });

  it("refuses an unknown status or order instead of ignoring it", async () => {
    for (const q of ["?status=pending,bogus", "?order=sideways", "?status="]) {
      const res = await app.inject({ method: "GET", url: `/v1/approvals${q}`, headers: dana.auth });
      expect(res.statusCode, q).toBe(400);
    }
  });

  it("a non-admin never sees another user's rows, and total does not count them", async () => {
    const own = await page(eli.auth, "?status=pending&order=asc");
    expect(own.total).toBe(2);
    expect(own.approvals.every((r) => r.approverUserId === eli.id)).toBe(true);
    // naming Dana is a display filter intersected with Eli's scope, never a widening
    const other = await page(eli.auth, `?status=pending&order=asc&approverUserId=${dana.id}`);
    expect(other.approvals).toHaveLength(0);
    expect(other.total).toBe(0);
    expect(other.hasMore).toBe(false);
    const all = await page(eli.auth, "");
    expect(all.approvals.every((r) => r.approverUserId === eli.id)).toBe(true);
    expect(all.total).toBe(2);
  });
});
