/**
 * Codex review cards CXR-REV-002 and CXR-REV-003.
 *
 * CXR-REV-002 (owner decision 2026-11-22, ADR-0047 addendum): a report definition is ARCHIVED, never deleted. The
 * runs it generated are evidence ("one immutable row per generation"), so archiving must keep them readable, hide the
 * definition from the default list, stop its schedules from firing (disabled at archive, and skipped by the sweep even
 * if something re-enables one), refuse new generations, be audited, be final, and stay admin-only. On the old code the
 * archive route does not exist and DELETE cascades the runs away, so every case below fails there.
 *
 * CXR-REV-003: the risk register paginates under ADR-0226 (cursor, total, export) instead of stopping at 200 with
 * nothing said; the older response keeps its shape and now says when it was cut.
 *
 * Every object is `cxr-` prefixed and removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  aiRisks,
  auditLog,
  createDb,
  eq,
  inArray,
  reportDefinitions,
  reportRuns,
  reportSchedules,
  runMigrations,
  type Db,
} from "@regulait/db";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "cxr-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = randomUUID().slice(0, 8);

let db: Db;
let app: ReturnType<typeof buildApp>;
const defIds: string[] = [];
const riskIds: string[] = [];
let member: { id: string; auth: { authorization: string } };
let other: { id: string; auth: { authorization: string } };

async function makeUser(tag: string) {
  const email = `cxr-${tag}-${RUN}@example.com`;
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email, displayName: `cxr ${tag}` } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "cxr" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function makeDefinition(name: string) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/reports/definitions",
    headers: AUTH,
    payload: { name: `cxr-${name}-${RUN}`, kind: "exec_summary", scopeKind: "org", entitlementScope: "org", period: "current_month" },
  });
  expect(res.statusCode).toBe(201);
  const id = res.json().definition.id as string;
  defIds.push(id);
  return id;
}

const generate = (id: string) =>
  app.inject({ method: "POST", url: `/v1/reports/definitions/${id}/generate`, headers: AUTH, payload: {} });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  member = await makeUser("member");
  other = await makeUser("other");
});

afterAll(async () => {
  if (riskIds.length) await db.delete(aiRisks).where(inArray(aiRisks.id, riskIds));
  if (defIds.length) await db.delete(reportDefinitions).where(inArray(reportDefinitions.id, defIds));
  await app?.close();
});

describe("CXR-REV-002 — archive instead of delete", () => {
  let defId: string;
  let scheduleId: string;
  const runIds: string[] = [];

  beforeAll(async () => {
    defId = await makeDefinition("archive");
    for (let i = 0; i < 2; i++) {
      const g = await generate(defId);
      expect(g.statusCode).toBe(201);
      runIds.push(g.json().run.id);
    }
    const s = await app.inject({ method: "POST", url: `/v1/reports/definitions/${defId}/schedules`, headers: AUTH, payload: { cadence: "daily" } });
    expect(s.statusCode).toBe(201);
    scheduleId = s.json().schedule.id;
  });

  it("refuses a non-admin, by the archive route and by DELETE, and changes nothing", async () => {
    for (const [method, url] of [
      ["POST", `/v1/reports/definitions/${defId}/archive`],
      ["DELETE", `/v1/reports/definitions/${defId}`],
    ] as const) {
      const res = await app.inject({ method, url, headers: member.auth, payload: method === "POST" ? {} : undefined });
      expect(res.statusCode).toBe(403);
    }
    const [row] = await db.select().from(reportDefinitions).where(eq(reportDefinitions.id, defId));
    expect(row!.status).toBe("active");
  });

  it("archives: the definition is kept and hidden, its runs are kept and readable, its schedule is disabled", async () => {
    const res = await app.inject({ method: "POST", url: `/v1/reports/definitions/${defId}/archive`, headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ archived: true, deleted: false, runsKept: 2, schedulesDisabled: 1 });
    expect(body.definition.status).toBe("archived");
    expect(body.definition.archivedAt).toBeTruthy();
    expect(body.lifecycle.machine).toBe("report_definition");
    expect(body.lifecycle.terminal).toBe(true);

    // the runs survive and stay readable
    const runs = await db.select().from(reportRuns).where(eq(reportRuns.definitionId, defId));
    expect(runs.map((r) => r.id).sort()).toEqual([...runIds].sort());
    const read = await app.inject({ method: "GET", url: `/v1/reports/runs/${runIds[0]}`, headers: AUTH });
    expect(read.statusCode).toBe(200);
    const exported = await app.inject({ method: "GET", url: `/v1/reports/runs/${runIds[0]}/export?format=json`, headers: AUTH });
    expect(exported.statusCode).toBe(200);

    // hidden from the default list and the overview, shown on request
    const list = await app.inject({ method: "GET", url: "/v1/reports/definitions", headers: AUTH });
    expect(list.json().definitions.map((d: { id: string }) => d.id)).not.toContain(defId);
    const overview = await app.inject({ method: "GET", url: "/v1/reports/overview", headers: AUTH });
    expect(overview.json().definitions.map((d: { id: string }) => d.id)).not.toContain(defId);
    const all = await app.inject({ method: "GET", url: "/v1/reports/definitions?include=archived", headers: AUTH });
    const shown = all.json().definitions.find((d: { id: string }) => d.id === defId);
    expect(shown.status).toBe("archived");
    const detail = await app.inject({ method: "GET", url: `/v1/reports/definitions/${defId}`, headers: AUTH });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().lifecycle.state).toBe("archived");

    const [sched] = await db.select().from(reportSchedules).where(eq(reportSchedules.id, scheduleId));
    expect(sched!.enabled).toBe(false);
  });

  it("is audited with what it disabled and what it kept", async () => {
    const rows = await db.select().from(auditLog).where(eq(auditLog.objectId, defId));
    const archived = rows.filter((r) => r.ruleId === "report-definition-archived");
    expect(archived).toHaveLength(1);
    expect(archived[0]!.detail).toMatchObject({ from: "active", to: "archived", runsKept: 2, schedulesDisabled: [scheduleId] });
    expect(rows.some((r) => r.ruleId === "report-definition-deleted")).toBe(false);
  });

  it("its schedule never fires, even when re-enabled underneath the API", async () => {
    await db.update(reportSchedules).set({ enabled: true, lastGeneratedAt: null }).where(eq(reportSchedules.id, scheduleId));
    const sweep = await app.inject({ method: "POST", url: "/v1/reports/schedules/run-due", headers: AUTH, payload: {} });
    expect(sweep.statusCode).toBe(200);
    expect(sweep.json().generated.map((g: { scheduleId: string }) => g.scheduleId)).not.toContain(scheduleId);
    const runs = await db.select().from(reportRuns).where(eq(reportRuns.definitionId, defId));
    expect(runs).toHaveLength(2);
    await db.update(reportSchedules).set({ enabled: false }).where(eq(reportSchedules.id, scheduleId));
  });

  it("refuses a new generation, a new schedule, re-enabling a schedule, and a second archive", async () => {
    const g = await generate(defId);
    expect(g.statusCode).toBe(409);
    expect(g.json().error).toBe("report_definition_archived");
    const s = await app.inject({ method: "POST", url: `/v1/reports/definitions/${defId}/schedules`, headers: AUTH, payload: { cadence: "weekly" } });
    expect(s.statusCode).toBe(409);
    const p = await app.inject({ method: "PATCH", url: `/v1/reports/schedules/${scheduleId}`, headers: AUTH, payload: { enabled: true } });
    expect(p.statusCode).toBe(409);
    const again = await app.inject({ method: "POST", url: `/v1/reports/definitions/${defId}/archive`, headers: AUTH, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("report_definition_already_archived");
  });

  it("DELETE from an older client archives too: nothing is deleted", async () => {
    const id = await makeDefinition("legacy-delete");
    const g = await generate(id);
    expect(g.statusCode).toBe(201);
    const res = await app.inject({ method: "DELETE", url: `/v1/reports/definitions/${id}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ archived: true, deleted: false, runsKept: 1 });
    const [row] = await db.select().from(reportDefinitions).where(eq(reportDefinitions.id, id));
    expect(row!.status).toBe("archived");
    expect(await db.select().from(reportRuns).where(eq(reportRuns.definitionId, id))).toHaveLength(1);
  });

  it("the database refuses an archived row without its stamp", async () => {
    const id = await makeDefinition("check");
    await expect(db.update(reportDefinitions).set({ status: "archived" }).where(eq(reportDefinitions.id, id))).rejects.toThrow();
  });

  it("the machine is published with the others", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/state-machines", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain("report_definitions.status");
  });

  it("the schedule list's note states this deployment's scheduler, not a fixed sentence", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/reports/schedules", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().schedulerPresent).toBe("boolean");
    expect(res.json().note).not.toContain("Nothing in this codebase fires these");
  });
});

describe("CXR-REV-003 — the risk register paginates", () => {
  beforeAll(async () => {
    for (let i = 0; i < 12; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/v1/risks",
        headers: member.auth,
        payload: { title: `cxr risk ${i} ${RUN}`, description: "paging", category: "tool_misuse", likelihood: "low", impact: "medium" },
      });
      expect(r.statusCode).toBe(201);
      riskIds.push(r.json().id);
    }
    const o = await app.inject({
      method: "POST",
      url: "/v1/risks",
      headers: other.auth,
      payload: { title: `cxr other ${RUN}`, description: "not yours", category: "tool_misuse", likelihood: "low", impact: "low" },
    });
    expect(o.statusCode).toBe(201);
    riskIds.push(o.json().id);
  });

  it("pages under the list contract with a total and a cursor, scoped to the caller's own risks", async () => {
    const first = await app.inject({ method: "GET", url: "/v1/risks?limit=10&count=exact&sort=created&dir=desc", headers: member.auth });
    expect(first.statusCode).toBe(200);
    const p1 = first.json();
    expect(p1.items).toHaveLength(10);
    expect(p1.total).toBe(12);
    expect(p1.nextCursor).toBeTruthy();
    expect(p1.disclaimer).toBeTruthy();
    expect(p1.items[0].ownerName).toBe("cxr member");
    expect(Array.isArray(p1.items[0].controls)).toBe(true);
    const second = await app.inject({
      method: "GET",
      url: `/v1/risks?limit=10&sort=created&dir=desc&cursor=${encodeURIComponent(p1.nextCursor)}`,
      headers: member.auth,
    });
    const p2 = second.json();
    expect(p2.items).toHaveLength(2);
    expect(p2.nextCursor).toBeNull();
    const seen = [...p1.items, ...p2.items].map((r: { id: string }) => r.id);
    expect(new Set(seen).size).toBe(12);
    expect(seen).not.toContain(riskIds[riskIds.length - 1]);
  });

  it("sorts on the server and refuses an unknown column", async () => {
    const ok = await app.inject({ method: "GET", url: "/v1/risks?limit=10&sort=title&dir=asc", headers: member.auth });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: "GET", url: "/v1/risks?limit=10&sort=nope", headers: member.auth });
    expect(bad.statusCode).toBe(400);
  });

  it("the older response keeps its shape and says when its cap cut the list", async () => {
    const cut = await app.inject({ method: "GET", url: "/v1/risks?limit=5", headers: member.auth });
    expect(cut.statusCode).toBe(200);
    expect(cut.json().risks).toHaveLength(5);
    expect(cut.json().truncated).toBe(true);
    const whole = await app.inject({ method: "GET", url: "/v1/risks", headers: member.auth });
    expect(whole.json().risks).toHaveLength(12);
    expect(whole.json().truncated).toBe(false);
    expect(whole.json().disclaimer).toBeTruthy();
  });

  it("exports the same list as Excel", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/risks/export.xlsx?columns=title,status,owner", headers: member.auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheet");
  });
});
