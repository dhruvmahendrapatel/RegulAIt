/**
 * SPEND BY AGENT AND BY CONNECTOR COVER THE WHOLE WINDOW.
 *
 * The Spend page used to sum its by-agent and by-connector bars in the browser
 * from the newest 200 rows of `/v1/usage-events`, so a busy user's breakdown
 * silently under-counted. `GET /v1/usage-events/summary` aggregates in the
 * database over a stated window, with the same scoping as `/v1/usage-events`.
 *
 * Proved here, on this file's own users (a non-admin's scope is exactly their
 * own events, so sums are exact in a shared database):
 *   - the summary equals the sum over EVERY event in the window (more than one
 *     page of the raw ledger), and excludes events outside it;
 *   - agent and connector rows never mix;
 *   - a non-admin naming another user's id still gets only their own figures;
 *     an admin may name a user;
 *   - a bad `groupBy` or an inverted window is a 400.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, inArray, runMigrations, usageEvents, users, type Db } from "@regulait/db";
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

const BOOT = "usage-summary-bootstrap";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DAY = 86_400_000;

let db: Db;
let app: ReturnType<typeof buildApp>;
let dana: { id: string; auth: { authorization: string } };
let eli: { id: string; auth: { authorization: string } };
const userIds: string[] = [];

const AGENT_A = randomUUID();
const AGENT_B = randomUUID();
const CONNECTOR = randomUUID();
// usage_events.project_id carries no FK, so synthetic ids keep this file self-contained
const PROJECT_1 = randomUUID();
const PROJECT_2 = randomUUID();

type Ev = { userId: string; objectType: string; agentId?: string; connectorId?: string; operation?: string; projectId?: string | null; costUsd: number; at: Date };
const inserted: Ev[] = [];

const makeUser = async (label: string) => {
  const res = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `usum-${label}-${randomUUID()}@spend.example`, displayName: `USUM ${label}` },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().id as string;
  userIds.push(id);
  const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "usum" } });
  return { id, auth: { authorization: `Bearer ${key.json().token}` } };
};

const get = async (auth: { authorization: string }, query: string) =>
  app.inject({ method: "GET", url: `/v1/usage-events/summary${query}`, headers: auth });

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-6);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  dana = await makeUser("dana");
  eli = await makeUser("eli");

  const now = Date.now();
  const evs: Ev[] = [];
  // 260 agent events inside the last 30 days — more than the old 200-row page
  for (let i = 0; i < 260; i++) {
    evs.push({
      userId: dana.id,
      objectType: "agent",
      agentId: i % 3 === 0 ? AGENT_B : AGENT_A,
      projectId: i % 4 === 0 ? null : i % 4 === 1 ? PROJECT_1 : PROJECT_2,
      costUsd: 0.01 + (i % 7) * 0.001,
      at: new Date(now - (i % 25) * DAY - 60_000),
    });
  }
  // 30 connector events inside the window, two operations
  for (let i = 0; i < 30; i++) {
    evs.push({
      userId: dana.id,
      objectType: "connector",
      connectorId: CONNECTOR,
      operation: i % 2 ? "search" : "fetch",
      costUsd: 0.002,
      at: new Date(now - (i % 10) * DAY - 60_000),
    });
  }
  // outside the default window: must not count
  evs.push({ userId: dana.id, objectType: "agent", agentId: AGENT_A, costUsd: 5, at: new Date(now - 45 * DAY) });
  // an MCP tool call: neither an agent nor a connector row
  evs.push({ userId: dana.id, objectType: "mcp_tool", operation: "lookup", projectId: PROJECT_1, costUsd: 3, at: new Date(now - DAY) });
  evs.push({ userId: dana.id, objectType: "mcp_tool", operation: "search_docs", costUsd: 0.5, at: new Date(now - 2 * DAY) });
  // a ledger object type no typed breakdown names: it must land in `ledger.other`, never vanish
  evs.push({ userId: dana.id, objectType: "training_job", costUsd: 11, at: new Date(now - 3 * DAY) });
  // Eli's own spend on the same agent: must never reach Dana, nor Dana's reach Eli
  evs.push({ userId: eli.id, objectType: "agent", agentId: AGENT_A, costUsd: 7, at: new Date(now - DAY) });
  await db.insert(usageEvents).values(evs);
  inserted.push(...evs);
}, 120_000);

afterAll(async () => {
  if (userIds.length) {
    await db.delete(usageEvents).where(inArray(usageEvents.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
  }
  await app.close();
  await db.$client.end();
});

/** the expected sums, straight from what this file inserted (`objectType` null = every object type) */
const expected = (userId: string, objectType: string | null, from: number, to: number, keyOf?: (e: Ev) => string) => {
  const m = new Map<string, { costUsd: number; events: number }>();
  for (const e of inserted) {
    if (e.userId !== userId || (objectType !== null && e.objectType !== objectType) || e.at.getTime() < from || e.at.getTime() >= to) continue;
    const k = keyOf ? keyOf(e) : objectType === "agent" ? (e.agentId ?? "") : `${e.connectorId}:${e.operation}`;
    const cur = m.get(k) ?? { costUsd: 0, events: 0 };
    m.set(k, { costUsd: cur.costUsd + e.costUsd, events: cur.events + 1 });
  }
  return m;
};

describe("GET /v1/usage-events/summary", () => {
  it("groupBy=agent equals the sum over every agent event in the default 30-day window", async () => {
    const res = await get(dana.auth, "?groupBy=agent");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const to = Date.parse(body.window.to);
    const from = Date.parse(body.window.from);
    expect(body.window.defaulted).toBe(true);
    expect(to - from).toBe(30 * DAY);
    const want = expected(dana.id, "agent", from, to);
    expect(body.groups).toHaveLength(want.size);
    for (const g of body.groups as Array<{ agentId: string; costUsd: number; events: number }>) {
      expect(g.events).toBe(want.get(g.agentId)!.events);
      near(g.costUsd, want.get(g.agentId)!.costUsd);
    }
    // all 260 in-window events, not a 200-row page, and not the 45-day-old one
    expect(body.totals.events).toBe(260);
    near(body.totals.costUsd, [...want.values()].reduce((a, w) => a + w.costUsd, 0));
    // sorted by cost, largest first
    const costs = (body.groups as Array<{ costUsd: number }>).map((g) => g.costUsd);
    expect(costs).toEqual([...costs].sort((a, b) => b - a));
  });

  it("groupBy=connector sums connector rows only, per connector and operation", async () => {
    const res = await get(dana.auth, "?groupBy=connector");
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const want = expected(dana.id, "connector", Date.parse(body.window.from), Date.parse(body.window.to));
    expect(body.groups).toHaveLength(2);
    for (const g of body.groups as Array<{ connectorId: string; operation: string; costUsd: number; events: number }>) {
      const w = want.get(`${g.connectorId}:${g.operation}`)!;
      expect(g.events).toBe(w.events);
      near(g.costUsd, w.costUsd);
    }
    expect(body.totals.events).toBe(30);
  });

  it("an explicit window is honoured, half-open", async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 60 * DAY);
    const res = await get(dana.auth, `?groupBy=agent&from=${from.toISOString()}&to=${to.toISOString()}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.window.defaulted).toBe(false);
    // the 45-day-old event is now inside
    expect(body.totals.events).toBe(261);
    const want = expected(dana.id, "agent", from.getTime(), to.getTime());
    near(body.totals.costUsd, [...want.values()].reduce((a, w) => a + w.costUsd, 0));
  });

  it("a non-admin naming another user still gets only their own figures", async () => {
    const res = await get(eli.auth, `?groupBy=agent&userId=${dana.id}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.userId).toBe(eli.id);
    expect(body.totals.events).toBe(1);
    near(body.totals.costUsd, 7);
    const danaSelf = await get(dana.auth, `?groupBy=agent&userId=${eli.id}`);
    expect(danaSelf.json().userId).toBe(dana.id);
    expect(danaSelf.json().totals.events).toBe(260);
  });

  it("an admin may read one named user's summary", async () => {
    const res = await get(AUTH, `?groupBy=agent&userId=${eli.id}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().totals.events).toBe(1);
  });

  const sumAll = (m: Map<string, { costUsd: number; events: number }>) =>
    [...m.values()].reduce((a, w) => ({ costUsd: a.costUsd + w.costUsd, events: a.events + w.events }), { costUsd: 0, events: 0 });

  it("groupBy=project covers every event of every object type in the window, unattributed included", async () => {
    const body = (await get(dana.auth, "?groupBy=project")).json();
    const from = Date.parse(body.window.from);
    const to = Date.parse(body.window.to);
    const want = expected(dana.id, null, from, to, (e) => e.projectId ?? "");
    expect(body.groups).toHaveLength(want.size);
    for (const g of body.groups as Array<{ projectId: string | null; costUsd: number; events: number }>) {
      const w = want.get(g.projectId ?? "")!;
      expect(g.events).toBe(w.events);
      near(g.costUsd, w.costUsd);
    }
    // 260 agent + 30 connector + 2 MCP + 1 training job: far more than the old 200-row page
    expect(body.totals.events).toBe(293);
    near(body.totals.costUsd, sumAll(want).costUsd);
    expect(body.groups.some((g: { projectId: string | null }) => g.projectId === null)).toBe(true);
  });

  it("groupBy=day is a daily UTC series whose days sum to the window", async () => {
    const to = new Date();
    const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) - 29 * DAY);
    const body = (await get(dana.auth, `?groupBy=day&from=${from.toISOString()}&to=${to.toISOString()}`)).json();
    const want = expected(dana.id, null, from.getTime(), to.getTime(), (e) => e.at.toISOString().slice(0, 10));
    const days = (body.groups as Array<{ day: string }>).map((g) => g.day);
    expect(days).toEqual([...want.keys()].sort());
    for (const g of body.groups as Array<{ day: string; costUsd: number; events: number }>) {
      expect(g.events).toBe(want.get(g.day)!.events);
      near(g.costUsd, want.get(g.day)!.costUsd);
    }
    expect(body.totals.events).toBe(sumAll(want).events);
    expect(body.totals.events).toBeGreaterThan(200);
  });

  it("groupBy=mcp_tool names MCP tool spend, which carries no agent", async () => {
    const body = (await get(dana.auth, "?groupBy=mcp_tool")).json();
    const byTool = new Map((body.groups as Array<{ toolName: string; costUsd: number }>).map((g) => [g.toolName, g.costUsd]));
    near(byTool.get("lookup")!, 3);
    near(byTool.get("search_docs")!, 0.5);
    expect(body.totals.events).toBe(2);
  });

  it("agent + connector + MCP tool + other add up to the whole window's ledger", async () => {
    const [agent, connector, mcp] = await Promise.all(
      ["agent", "connector", "mcp_tool"].map(async (g) => (await get(dana.auth, `?groupBy=${g}`)).json()),
    );
    const ledger = agent.ledger;
    const want = sumAll(expected(dana.id, null, Date.parse(agent.window.from), Date.parse(agent.window.to), () => "all"));
    expect(ledger.events).toBe(want.events);
    near(ledger.costUsd, want.costUsd);
    // the training job is the only thing no typed breakdown names
    expect(ledger.other.events).toBe(1);
    near(ledger.other.costUsd, 11);
    expect(agent.totals.events + connector.totals.events + mcp.totals.events + ledger.other.events).toBe(ledger.events);
    near(agent.totals.costUsd + connector.totals.costUsd + mcp.totals.costUsd + ledger.other.costUsd, ledger.costUsd);
  });

  it("refuses a bad groupBy, a missing groupBy and an inverted window", async () => {
    const to = new Date();
    const from = new Date(to.getTime() + DAY);
    for (const q of ["?groupBy=model", "", `?groupBy=agent&from=${from.toISOString()}&to=${to.toISOString()}`]) {
      const res = await get(dana.auth, q);
      expect(res.statusCode, q).toBe(400);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/usage-events/summary?groupBy=agent" });
    expect(res.statusCode).toBe(401);
  });
});
