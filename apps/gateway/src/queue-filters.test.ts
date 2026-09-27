/**
 * B9b — THE ONE QUEUE'S FILTERS, AND THE THING A FILTER MUST NEVER BE.
 *
 * `GET /v1/approvals` is fleet-wide and returns at most 100 rows, ordered by
 * `requested_at DESC`. With `status` as the only filter, "the copilot proposals
 * waiting on Dana" could not be asked for — and on a busy deployment the rows
 * wanted may not be IN the response at all, which makes the cap a correctness
 * problem rather than a paging inconvenience. `objectType` and `approverUserId`
 * close that.
 *
 * WHAT THIS FILE IS REALLY FOR: `approverUserId` is a filter over a queue whose
 * visibility rules are ADR-0022 delegation widening and ADR-0046 routing. A
 * filter implemented as a REPLACEMENT for that scope condition rather than an
 * INTERSECTION with it would be a privilege escalation wearing the clothes of a
 * dropdown — ask for somebody else's id and receive their queue. So the
 * assertions that matter here are the negative ones:
 *
 *   - a non-admin filtering by an id that is not theirs gets NOTHING, not that
 *     person's rows;
 *   - a non-admin filtering by their OWN id still gets their rows, so the test
 *     above cannot pass merely because the filter broke;
 *   - an unknown `objectType` is a 400, so a typo is a refusal and never a
 *     silently unfiltered queue.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, eq, runMigrations, approvals, users, type Db } from "@regulait/db";
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

const BOOT = "queue-filters-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
/** two ordinary users, each the named approver of rows of their own */
let danaId: string;
let danaAuth: { authorization: string };
let eliId: string;
let eliAuth: { authorization: string };
/** the ids this file created, so every assertion is a filter over ITS OWN rows
 *  (M-008: never an absolute org-wide count in a shared database) */
const mine = new Set<string>();

const makeUser = async (label: string) => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `qf-${label}-${randomUUID()}@queue.example`, displayName: `QF ${label}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "qf" } });
  return { id, auth: { authorization: `Bearer ${key.json().token}` } };
};

const addApproval = async (approverUserId: string, objectType: string, status: string) => {
  const [row] = await db
    .insert(approvals)
    .values({ userId: approverUserId, objectType: objectType as "mcp_tool", approverUserId, status: status as "pending" })
    .returning({ id: approvals.id });
  mine.add(row!.id);
  return row!.id;
};

const list = async (auth: { authorization: string }, query: string) => {
  const res = await app.inject({ method: "GET", url: `/v1/approvals${query}`, headers: auth });
  expect(res.statusCode, res.body).toBe(200);
  // narrowed to this file's own rows before anything is counted
  return (res.json().approvals as Array<{ id: string; objectType: string; approverUserId: string; status: string }>).filter(
    (r) => mine.has(r.id),
  );
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });

  const dana = await makeUser("dana");
  danaId = dana.id;
  danaAuth = dana.auth;
  const eli = await makeUser("eli");
  eliId = eli.id;
  eliAuth = eli.auth;

  // Dana: 2 pending copilot proposals, 1 pending workflow, 1 approved proposal
  await addApproval(danaId, "copilot_proposal", "pending");
  await addApproval(danaId, "copilot_proposal", "pending");
  await addApproval(danaId, "workflow", "pending");
  await addApproval(danaId, "copilot_proposal", "approved");
  // Eli: 1 pending copilot proposal — the row a bad filter would leak to Dana
  await addApproval(eliId, "copilot_proposal", "pending");
}, 120_000);

afterAll(async () => {
  for (const id of mine) await db.delete(approvals).where(eq(approvals.id, id));
  await db.delete(users).where(eq(users.id, danaId));
  await db.delete(users).where(eq(users.id, eliId));
  await app.close();
  await db.$client.end();
});

describe("B9b — the queue narrows on kind and approver, in the endpoint", () => {
  it("filters by objectType", async () => {
    const rows = await list(AUTH, "?objectType=copilot_proposal");
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.objectType === "copilot_proposal")).toBe(true);
  });

  it("combines with status rather than replacing it", async () => {
    // 4 copilot proposals exist, 3 of them pending — a filter that dropped
    // `status` on the floor would return 4 here
    const rows = await list(AUTH, "?objectType=copilot_proposal&status=pending");
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("filters by approver", async () => {
    const rows = await list(AUTH, `?approverUserId=${danaId}`);
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.approverUserId === danaId)).toBe(true);
  });

  it("all three together", async () => {
    const rows = await list(AUTH, `?approverUserId=${danaId}&objectType=copilot_proposal&status=pending`);
    expect(rows.length).toBe(2);
  });

  it("REFUSES an unknown objectType instead of ignoring it", async () => {
    // a typo must not silently return the whole queue — the caller would read
    // an unfiltered list as a filtered one
    const res = await app.inject({ method: "GET", url: "/v1/approvals?objectType=not_a_kind", headers: AUTH });
    expect(res.statusCode).toBe(400);
  });

  it("REFUSES a non-uuid approverUserId", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/approvals?approverUserId=dana", headers: AUTH });
    expect(res.statusCode).toBe(400);
  });
});

describe("B9b — `approverUserId` is a DISPLAY filter and never a widening", () => {
  it("THE CONTROL: a non-admin filtering by their own id sees their own rows", async () => {
    // Without this, the next test could pass because the filter returns nothing
    // for everyone — which would be safe and also useless.
    const rows = await list(danaAuth, `?approverUserId=${danaId}&status=pending`);
    expect(rows.length).toBe(3);
  });

  it("THE ATTACK: a non-admin filtering by SOMEONE ELSE'S id sees nothing", async () => {
    // Eli really has a pending copilot proposal. If the filter were substituted
    // for the scope condition instead of ANDed with it, Dana would receive it.
    const rows = await list(danaAuth, `?approverUserId=${eliId}`);
    expect(rows.length).toBe(0);
  });

  it("and Eli sees that row themselves, so it was there to be leaked", async () => {
    // M-024's shape: the guard is proved to fire DESPITE the data existing.
    const rows = await list(eliAuth, `?approverUserId=${eliId}`);
    expect(rows.length).toBe(1);
    expect(rows[0]!.objectType).toBe("copilot_proposal");
  });
});
