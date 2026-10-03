/**
 * REL-10 — the whole-table list routes are bounded.
 *
 * `GET /v1/runs` (every row carrying its full graph + state JSON), `/v1/agents`
 * and `/v1/users` returned the entire table on every open of the pages that
 * show them. Each now takes `limit` with a default and a hard maximum, and
 * refuses an out-of-range value rather than clamping it silently.
 */
import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT } from "./list-limit.js";
import { RUNS_LIST_DEFAULT_LIMIT, RUNS_LIST_MAX_LIMIT } from "./orchestration.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const BOOT = "ll-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userAuth: { authorization: string };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "l".repeat(64) });
  for (const n of [1, 2, 3]) {
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `ll-${n}@example.com`, displayName: `ll ${n}` } });
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload: { name: `ll-agent-${n}`, provider: "mock", tier: 0, model: "mock-ll" } });
  }
  const u = await app.inject({ method: "GET", headers: AUTH, url: "/v1/users" });
  const me = u.json().users.find((x: { email: string }) => x.email === "ll-1@example.com");
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${me.id}/keys`, payload: { name: "ll" } });
  userAuth = { authorization: `Bearer ${k.json().token}` };
  const agents = await app.inject({ method: "GET", headers: AUTH, url: "/v1/agents" });
  const agent = agents.json().agents.find((a: { name: string }) => a.name === "ll-agent-1");
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: me.id, agentId: agent.id } });
  for (const n of [1, 2, 3]) {
    const r = await app.inject({
      method: "POST",
      headers: userAuth,
      url: "/v1/runs",
      payload: {
        graph: { run: `ll-run-${n}`, escalationApproverUserId: me.id, nodes: [{ id: "n1", title: "t", ownerAgentId: agent.id, mode: "execute" }] },
      },
    });
    expect(r.statusCode, r.body).toBe(201);
  }
});

describe("REL-10: bounded list routes", () => {
  it("the defaults and maxima are what the routes document", () => {
    expect(LIST_DEFAULT_LIMIT).toBe(1_000);
    expect(LIST_MAX_LIMIT).toBe(5_000);
    expect(RUNS_LIST_DEFAULT_LIMIT).toBe(200);
    expect(RUNS_LIST_MAX_LIMIT).toBe(1_000);
  });

  it.each([
    ["/v1/users", "users", LIST_MAX_LIMIT],
    ["/v1/agents", "agents", LIST_MAX_LIMIT],
    ["/v1/runs", "runs", RUNS_LIST_MAX_LIMIT],
  ])("%s honours `limit`, and refuses 0 or above the max instead of clamping", async (url, key, max) => {
    const one = await app.inject({ method: "GET", headers: AUTH, url: `${url}?limit=1` });
    expect(one.statusCode).toBe(200);
    expect(one.json()[key]).toHaveLength(1);
    const two = await app.inject({ method: "GET", headers: AUTH, url: `${url}?limit=2` });
    expect(two.json()[key]).toHaveLength(2);
    const all = await app.inject({ method: "GET", headers: AUTH, url });
    expect(all.json()[key].length).toBeGreaterThanOrEqual(3);
    expect((await app.inject({ method: "GET", headers: AUTH, url: `${url}?limit=0` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", headers: AUTH, url: `${url}?limit=${max + 1}` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", headers: AUTH, url: `${url}?limit=${max}` })).statusCode).toBe(200);
  });

  it("/v1/runs stays newest first under the cap, and the non-admin scope is applied before it", async () => {
    const mine = await app.inject({ method: "GET", headers: userAuth, url: "/v1/runs?limit=2" });
    expect(mine.statusCode).toBe(200);
    const names = mine.json().runs.map((r: { graph: { run: string } }) => r.graph.run);
    expect(names).toEqual(["ll-run-3", "ll-run-2"]);
  });
});
