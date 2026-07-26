import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * Slice 4 of 4 — Initiatives (pillar 5 cross-team rollup). An Initiative is a
 * flat, reporting-only grouping of projects for chargeback/showback above the
 * single-project level: no initiative-level budget or enforcement, admin-only
 * by the default gate. Covers create/list, the child-count + rolled-up spend
 * rollup, the admin-only gate, delete-orphans-children (never deletes the
 * project), and the /costs byTeam breakdown.
 *
 * Shares one database with the other gateway suites (fileParallelism off), so
 * every object here is name-prefixed ini-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "ini-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let memberAuth: { authorization: string }; // a non-admin — must never see /v1/initiatives

const mkUser = async (email: string, name: string): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: name },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
};
const authFor = async (userId: string): Promise<{ authorization: string }> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${userId}/keys`, payload: { name: "ini" },
  });
  return { authorization: `Bearer ${r.json().token}` };
};
const mkProject = async (name: string, initiativeId?: string): Promise<string> => {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/projects",
    payload: { name, ...(initiativeId ? { initiativeId } : {}) },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
};
// direct-to-ledger spend, exactly as the neighbouring cost suites seed it
const spend = (userId: string, projectId: string, costUsd: number) =>
  db.insert(usageEvents).values({
    userId, projectId, objectType: "agent",
    agentId: null, model: "mock-ini", inputTokens: 1, outputTokens: 1, costUsd,
  });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  const memberId = await mkUser("ini-member@example.com", "Ini Member");
  memberAuth = await authFor(memberId);
});

describe("slice 4: Initiatives — create, list, and the cross-team rollup", () => {
  it("POST creates an initiative and GET lists it with a zero rollup", async () => {
    const created = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/initiatives",
      payload: { name: "ini-alpha", costCenter: "CC-INI-A" },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().name).toBe("ini-alpha");
    expect(created.json().costCenter).toBe("CC-INI-A");
    const id = created.json().id;

    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/initiatives" });
    expect(list.statusCode).toBe(200);
    const row = list.json().initiatives.find((i: { id: string }) => i.id === id);
    expect(row).toBeTruthy();
    expect(row.projectCount).toBe(0);
    expect(row.spentUsd).toBe(0);
  });

  it("rolls up spend and child count across two projects under one initiative", async () => {
    const ini = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/initiatives", payload: { name: "ini-rollup" },
    });
    const iniId = ini.json().id;
    const userId = await mkUser("ini-spender@example.com", "Ini Spender");
    const projA = await mkProject("ini-child-a", iniId);
    const projB = await mkProject("ini-child-b", iniId);
    await spend(userId, projA, 2);
    await spend(userId, projA, 1);
    await spend(userId, projB, 4);

    const single = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/initiatives/${iniId}`,
    });
    expect(single.statusCode).toBe(200);
    const body = single.json();
    expect(body.projectCount).toBe(2);
    expect(body.spentUsd).toBeCloseTo(7, 6);
    const a = body.projects.find((p: { id: string }) => p.id === projA);
    const b = body.projects.find((p: { id: string }) => p.id === projB);
    expect(a.spentUsd).toBeCloseTo(3, 6);
    expect(b.spentUsd).toBeCloseTo(4, 6);

    // and the list view reports the same rollup
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/initiatives" });
    const listed = list.json().initiatives.find((i: { id: string }) => i.id === iniId);
    expect(listed.projectCount).toBe(2);
    expect(listed.spentUsd).toBeCloseTo(7, 6);
  });

  it("404s an unknown initiative", async () => {
    const res = await app.inject({
      method: "GET", headers: AUTH, url: "/v1/initiatives/00000000-0000-4000-8000-000000000000",
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unknown_initiative");
  });
});

describe("slice 4: Initiatives stay admin-only (a rollup spans non-member projects)", () => {
  it("403s a non-admin on list, create, and single", async () => {
    const list = await app.inject({ method: "GET", headers: memberAuth, url: "/v1/initiatives" });
    expect(list.statusCode).toBe(403);
    expect(list.json().error).toBe("admin_only");

    const create = await app.inject({
      method: "POST", headers: memberAuth, url: "/v1/initiatives", payload: { name: "ini-nope" },
    });
    expect(create.statusCode).toBe(403);
  });
});

describe("slice 4: deleting an initiative orphans its children, never deletes them", () => {
  it("sets each child's initiativeId to null but keeps the project rows", async () => {
    const ini = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/initiatives", payload: { name: "ini-doomed" },
    });
    const iniId = ini.json().id;
    const projId = await mkProject("ini-orphan-me", iniId);

    const del = await app.inject({
      method: "DELETE", headers: AUTH, url: `/v1/initiatives/${iniId}`,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json()).toMatchObject({ ok: true });

    // the initiative is gone
    const gone = await app.inject({ method: "GET", headers: AUTH, url: `/v1/initiatives/${iniId}` });
    expect(gone.statusCode).toBe(404);

    // the project survives, now ungrouped
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/projects" });
    const proj = list.json().projects.find((p: { id: string }) => p.id === projId);
    expect(proj).toBeTruthy();
    expect(proj.initiativeId).toBeNull();
  });

  it("404s deleting an unknown initiative", async () => {
    const res = await app.inject({
      method: "DELETE", headers: AUTH, url: "/v1/initiatives/00000000-0000-4000-8000-000000000000",
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("slice 4: /costs byTeam groups a project's spend by contributing team", () => {
  it("attributes each spending member's cost to the team they contribute under here", async () => {
    // two teams, two members, one project — each member contributes under a
    // different team, so their spend must split by team in the byTeam rollup.
    const teamA = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: "ini-team-a" },
    });
    const teamB = await app.inject({
      method: "POST", headers: AUTH, url: "/v1/teams", payload: { name: "ini-team-b" },
    });
    const teamAId = teamA.json().id;
    const teamBId = teamB.json().id;
    const userA = await mkUser("ini-team-a@example.com", "Ini A");
    const userB = await mkUser("ini-team-b@example.com", "Ini B");
    const projId = await mkProject("ini-byteam");
    for (const [uid, tid, role] of [
      [userA, teamAId, "owner"],
      [userB, teamBId, "contributor"],
    ] as const) {
      // provenance team must really be one of the member's teams, so join first
      const jt = await app.inject({
        method: "POST", headers: AUTH, url: `/v1/teams/${tid}/members`,
        payload: { userId: uid },
      });
      expect(jt.statusCode).toBe(201);
      const r = await app.inject({
        method: "POST", headers: AUTH, url: `/v1/projects/${projId}/members`,
        payload: { userId: uid, role, teamId: tid },
      });
      expect(r.statusCode).toBe(201);
    }
    await spend(userA, projId, 3);
    await spend(userB, projId, 5);
    await spend(userB, projId, 2);

    const costs = await app.inject({
      method: "GET", headers: AUTH, url: `/v1/projects/${projId}/costs`,
    });
    expect(costs.statusCode).toBe(200);
    const byTeam: Array<{ teamId: string | null; name: string | null; costUsd: number }> =
      costs.json().byTeam;
    const a = byTeam.find((r) => r.teamId === teamAId);
    const b = byTeam.find((r) => r.teamId === teamBId);
    expect(a?.name).toBe("ini-team-a");
    expect(a?.costUsd).toBeCloseTo(3, 6);
    expect(b?.name).toBe("ini-team-b");
    expect(b?.costUsd).toBeCloseTo(7, 6);
  });
});
