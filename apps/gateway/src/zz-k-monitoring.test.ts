/**
 * ADR-0173 batch 2c (K) — monitoring KRIs, series and dashboards through the
 * real routes and the real governance monitor, against a real Postgres:
 *
 *  1. KRI, series and dashboard routes are ADMIN-ONLY (403 for a non-admin).
 *  2. A KRI's metric, scope and window are enums; the window is at most 90 days.
 *  3. Percentiles come from SQL `percentile_cont`, checked against
 *     simple-statistics (`quantile`, linear interpolation) on a fixture.
 *  4. The monitor raises `kri_threshold_breached` for a breached KRI; below
 *     `minSamples` a KRI neither breaches nor resolves; deleting a KRI
 *     resolves its episode (audited).
 *  5. A series has at most 500 buckets and shows the top 20 groups plus
 *     "other"; no query here selects a content column.
 *  6. A dashboard has at most 24 panels, each validated.
 *
 * Every fixture trace carries a project id unique to this run, so the KRIs
 * and series measure only this file's traces. Global state (KRIs, alerts,
 * dashboards, traces, users) is removed in afterAll (M-068).
 */
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quantile } from "simple-statistics";
import {
  and,
  auditLog,
  createDb,
  eq,
  governanceAlerts,
  inArray,
  kris,
  monitoringDashboards,
  ne,
  runMigrations,
  traceSpans,
  traces,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { runGovernanceMonitor } from "./governance-monitor.js";
import { kriFeedbackQuery, kriTraceQuery, measureKri, seriesFeedbackQuery, seriesTraceQuery } from "./kri.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const RUN = crypto.randomBytes(3).toString("hex");
const BOOT = "k-mon-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
type Auth = { authorization: string };

let db: Db;
let app: ReturnType<typeof buildApp>;
let admin: { id: string; auth: Auth };
let member: { id: string; auth: Auth };
const createdUserIds: string[] = [];
const PROJECT = crypto.randomUUID();
const PROJECT_GROUPS = crypto.randomUUID();
const createdKriIds: string[] = [];
const createdDashboardIds: string[] = [];
const DURATIONS = [120, 340, 560, 90, 1000, 2500, 75, 430, 810, 1200, 66, 3000];
const ERRORS = 3;

async function makeUser(name: string, isAdmin = false) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `${name}-${RUN}@example.com`, displayName: name, isAdmin },
  });
  expect(u.statusCode, JSON.stringify(u.json())).toBe(201);
  const id = u.json().id as string;
  createdUserIds.push(id);
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "k" } });
  expect(k.statusCode).toBe(201);
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  await app.ready();
  admin = await makeUser("k-mon-admin", true);
  member = await makeUser("k-mon-member");
  // the KRI fixture: 12 finished traces, 3 of them errors, with known durations
  await db.insert(traces).values(
    DURATIONS.map((d, i) => ({
      kind: "dispatch" as const,
      name: `k-mon ${RUN} ${i}`,
      userId: member.id,
      projectId: PROJECT,
      status: i < ERRORS ? ("error" as const) : ("ok" as const),
      startedAt: minutesAgo(60 + i),
      endedAt: minutesAgo(59 + i),
      durationMs: d,
      costUsd: 0.01,
    })),
  );
  // the series fixture: 22 agents, agent i on (i + 1) traces
  const groupTraces = [];
  for (let a = 0; a < 22; a++) for (let j = 0; j <= a; j++) groupTraces.push({ a, j });
  const ids = await db
    .insert(traces)
    .values(
      groupTraces.map(({ a, j }) => ({
        kind: "dispatch" as const,
        name: `k-series ${RUN} ${a}.${j}`,
        userId: member.id,
        projectId: PROJECT_GROUPS,
        status: "ok" as const,
        startedAt: minutesAgo(30),
        endedAt: minutesAgo(29),
        durationMs: 100,
      })),
    )
    .returning({ id: traces.id });
  const agentIds = Array.from({ length: 22 }, () => crypto.randomUUID());
  await db.insert(traceSpans).values(
    groupTraces.map(({ a }, i) => ({
      traceId: ids[i]!.id,
      seq: 1,
      kind: "llm" as const,
      name: "call",
      status: "ok" as const,
      startedAt: minutesAgo(30),
      agentId: agentIds[a]!,
      inputPreview: "SECRET-CONTENT",
    })),
  );
}, 120_000);

afterAll(async () => {
  if (createdKriIds.length) {
    await db
      .delete(governanceAlerts)
      .where(inArray(governanceAlerts.subjectKey, createdKriIds.map((id) => `kri:${id}`)));
    await db.delete(kris).where(inArray(kris.id, createdKriIds));
  }
  if (createdDashboardIds.length) await db.delete(monitoringDashboards).where(inArray(monitoringDashboards.id, createdDashboardIds));
  await db.delete(traces).where(inArray(traces.projectId, [PROJECT, PROJECT_GROUPS]));
  if (createdUserIds.length) {
    await db.delete(traces).where(inArray(traces.userId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  app.server.closeAllConnections();
  await app.close();
});

async function createKri(payload: Record<string, unknown>, auth: Auth = admin.auth) {
  const r = await app.inject({ method: "POST", url: "/v1/kris", headers: auth, payload });
  if (r.statusCode === 201) createdKriIds.push(r.json().id);
  return r;
}

async function activeAlert(kriId: string) {
  const [a] = await db
    .select()
    .from(governanceAlerts)
    .where(and(eq(governanceAlerts.subjectKey, `kri:${kriId}`), ne(governanceAlerts.status, "resolved")));
  return a ?? null;
}

describe("K1: admin-only", () => {
  it("a non-admin gets 403 on every KRI, series and dashboard route", async () => {
    const from = minutesAgo(600).toISOString();
    const to = new Date().toISOString();
    for (const [method, url, payload] of [
      ["GET", "/v1/kris", undefined],
      ["POST", "/v1/kris", { name: "x", metric: "trace_volume", threshold: 1 }],
      ["PATCH", `/v1/kris/${crypto.randomUUID()}`, { threshold: 2 }],
      ["DELETE", `/v1/kris/${crypto.randomUUID()}`, undefined],
      ["GET", `/v1/monitoring/series?metric=trace_volume&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, undefined],
      ["GET", "/v1/monitoring/dashboards", undefined],
      ["POST", "/v1/monitoring/dashboards", { name: "x", panels: [] }],
    ] as const) {
      const r = await app.inject({ method, url, headers: member.auth, ...(payload ? { payload } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
  });
});

describe("K2: KRI enums and the 90-day window", () => {
  it("refuses an unknown metric or scope and a window over 90 days", async () => {
    expect((await createKri({ name: "bad", metric: "latency_p95", threshold: 1 })).statusCode).toBe(400);
    expect((await createKri({ name: "bad", metric: "trace_volume", scope: "team", scopeId: PROJECT, threshold: 1 })).statusCode).toBe(400);
    expect((await createKri({ name: "bad", metric: "trace_volume", windowDays: 91, threshold: 1 })).statusCode).toBe(400);
    const ok = await createKri({ name: `k-mon window ${RUN}`, metric: "trace_volume", windowDays: 90, threshold: 1e9, enabled: false });
    expect(ok.statusCode).toBe(201);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, ok.json().id), eq(auditLog.ruleId, "kri-created")));
    expect(audit?.userId).toBe(admin.id);
  });
});

describe("K3: percentiles are percentile_cont, checked against simple-statistics", () => {
  it("p50 and p99 over the fixture match simple-statistics' quantile", async () => {
    const now = new Date();
    const scope = { scope: "project" as const, scopeId: PROJECT, windowDays: 1, scoreName: null };
    const p50 = await measureKri(db, { ...scope, metric: "latency_p50" }, now);
    const p99 = await measureKri(db, { ...scope, metric: "latency_p99" }, now);
    expect(p50.samples).toBe(DURATIONS.length);
    expect(p50.value).toBeCloseTo(quantile(DURATIONS, 0.5), 6);
    expect(p99.value).toBeCloseTo(quantile(DURATIONS, 0.99), 6);
    const err = await measureKri(db, { ...scope, metric: "error_rate" }, now);
    expect(err).toEqual({ value: (ERRORS / DURATIONS.length) * 100, samples: DURATIONS.length });
  });
});

describe("K4: KRI episodes through the governance monitor", () => {
  it("raises on breach; below minSamples neither raises nor resolves; deleting resolves", async () => {
    const created = await createKri({
      name: `k-mon errors ${RUN}`,
      metric: "error_rate",
      scope: "project",
      scopeId: PROJECT,
      windowDays: 1,
      comparator: "above",
      threshold: 10,
      minSamples: 5,
      severity: "high",
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;
    // a twin that is breached but has too few samples never raises
    const quiet = await createKri({
      name: `k-mon quiet ${RUN}`,
      metric: "error_rate",
      scope: "project",
      scopeId: PROJECT,
      windowDays: 1,
      threshold: 10,
      minSamples: 50,
    });
    const quietId = quiet.json().id as string;

    await runGovernanceMonitor(db, { actorUserId: admin.id });
    const raised = await activeAlert(id);
    expect(raised?.ruleId).toBe("kri_threshold_breached");
    expect(raised?.severity).toBe("high");
    expect(raised?.detail).toMatchObject({ value: 25, samples: 12, threshold: 10 });
    expect(await activeAlert(quietId)).toBeNull();

    // too few samples now: the open episode is HELD — not refreshed, not resolved
    expect((await app.inject({ method: "PATCH", url: `/v1/kris/${id}`, headers: admin.auth, payload: { minSamples: 50, threshold: 90 } })).statusCode).toBe(200);
    await runGovernanceMonitor(db, { actorUserId: admin.id });
    const held = await activeAlert(id);
    expect(held?.id).toBe(raised!.id);
    expect(held?.lastDetectedAt.getTime()).toBe(raised!.lastDetectedAt.getTime());

    // enough samples and under the threshold: resolves
    await app.inject({ method: "PATCH", url: `/v1/kris/${id}`, headers: admin.auth, payload: { minSamples: 5 } });
    await runGovernanceMonitor(db, { actorUserId: admin.id });
    expect(await activeAlert(id)).toBeNull();

    // breached again: a new episode; deleting the KRI resolves it, audited
    await app.inject({ method: "PATCH", url: `/v1/kris/${id}`, headers: admin.auth, payload: { threshold: 10 } });
    await runGovernanceMonitor(db, { actorUserId: admin.id });
    const again = await activeAlert(id);
    expect(again).not.toBeNull();
    const list = await app.inject({ method: "GET", url: "/v1/kris", headers: admin.auth });
    const mine = list.json().kris.find((k: { id: string }) => k.id === id);
    expect(mine.measurement).toMatchObject({ state: "breached", samples: 12 });
    expect(mine.alert).toMatchObject({ id: again!.id });
    const del = await app.inject({ method: "DELETE", url: `/v1/kris/${id}`, headers: admin.auth });
    expect(del.json()).toEqual({ deleted: true, resolvedEpisodes: 1 });
    const [row] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, again!.id));
    expect(row?.status).toBe("resolved");
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, again!.id), eq(auditLog.ruleId, "governance-alert-resolved")));
    expect(audit?.userId).toBe(admin.id);
  });
});

describe("K5: series", () => {
  const enc = (d: Date) => encodeURIComponent(d.toISOString());
  it("at most 500 buckets", async () => {
    const to = new Date("2026-09-30T00:00:00Z");
    const ok = await app.inject({
      method: "GET",
      url: `/v1/monitoring/series?metric=trace_volume&bucket=hour&from=${enc(new Date(to.getTime() - 500 * 3_600_000))}&to=${enc(to)}`,
      headers: admin.auth,
    });
    expect(ok.statusCode).toBe(200);
    const tooMany = await app.inject({
      method: "GET",
      url: `/v1/monitoring/series?metric=trace_volume&bucket=hour&from=${enc(new Date(to.getTime() - 501 * 3_600_000))}&to=${enc(to)}`,
      headers: admin.auth,
    });
    expect(tooMany.statusCode).toBe(400);
  });

  it("shows the top 20 groups plus 'other'", async () => {
    const r = await app.inject({
      method: "GET",
      url: `/v1/monitoring/series?metric=trace_volume&bucket=day&groupBy=agent&projectId=${PROJECT_GROUPS}&from=${enc(minutesAgo(24 * 60))}&to=${enc(new Date())}`,
      headers: admin.auth,
    });
    expect(r.statusCode, r.body).toBe(200);
    const s = r.json();
    expect(s.groups).toHaveLength(21);
    expect(s.groups.at(-1)).toEqual({ key: "other", label: "Other" });
    expect(s.folded).toBe(2);
    const total = (s.points as Array<{ group: string; value: number }>).reduce((n, p) => n + p.value, 0);
    expect(total).toBe((22 * 23) / 2); // every trace counted once, folded or not
    expect((s.points as Array<{ group: string; value: number }>).find((p) => p.group === "other")?.value).toBe(1 + 2);
    expect(JSON.stringify(s)).not.toContain("SECRET-CONTENT");
  });

  it("no measurement or series query selects a content column", () => {
    const content = /input_preview|output_preview|"attributes"|status_reason|"comment"|"label"/;
    const since = minutesAgo(60);
    const now = new Date();
    const q = { metric: "trace_volume" as const, from: since.toISOString(), to: now.toISOString(), bucket: "day" as const };
    const sqls = [
      kriTraceQuery(db, { scope: "agent", scopeId: PROJECT }, since, now).toSQL().sql,
      kriFeedbackQuery(db, { scope: "project", scopeId: PROJECT }, since, now, "helpfulness").toSQL().sql,
      ...(["none", "agent", "project"] as const).flatMap((groupBy) => [
        seriesTraceQuery(db, { ...q, groupBy }).toSQL().sql,
        seriesFeedbackQuery(db, { ...q, metric: "feedback_score", groupBy }).toSQL().sql,
      ]),
    ];
    for (const s of sqls) expect(s).not.toMatch(content);
  });
});

describe("K6: dashboards", () => {
  it("at most 24 panels, each validated; writes are audited", async () => {
    const panel = { kind: "series", title: "Volume", metric: "trace_volume" };
    const tooMany = await app.inject({ method: "POST", url: "/v1/monitoring/dashboards", headers: admin.auth, payload: { name: "x", panels: Array(25).fill(panel) } });
    expect(tooMany.statusCode).toBe(400);
    const bad = await app.inject({
      method: "POST",
      url: "/v1/monitoring/dashboards",
      headers: admin.auth,
      payload: { name: "x", panels: [{ ...panel, metric: "output_preview" }] },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: "/v1/monitoring/dashboards",
      headers: admin.auth,
      payload: { name: `k-mon ${RUN}`, panels: Array(24).fill(panel) },
    });
    expect(ok.statusCode).toBe(201);
    createdDashboardIds.push(ok.json().id);
    expect(ok.json().panels).toHaveLength(24);
    expect(ok.json().panels[0]).toEqual({ ...panel, groupBy: "none", bucket: "day", rangeDays: 7 });
    const patch = await app.inject({
      method: "PATCH",
      url: `/v1/monitoring/dashboards/${ok.json().id}`,
      headers: admin.auth,
      payload: { panels: Array(25).fill(panel) },
    });
    expect(patch.statusCode).toBe(400);
    const audits = await db.select().from(auditLog).where(eq(auditLog.objectId, ok.json().id));
    expect(audits.map((a) => a.ruleId)).toContain("monitoring-dashboard-created");
  });
});
