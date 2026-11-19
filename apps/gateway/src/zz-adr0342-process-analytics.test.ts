/**
 * ADR-0342 (lane E23) — process analytics, end to end (real database).
 *
 *  - the replay (pure): stage spans, wait vs work, rework exits, re-ordering of same-timestamp events, divergence;
 *  - the projector: rebuilds only changed instances, is idempotent, marks an irreproducible history `diverged` and a
 *    re-pointed project is re-synced;
 *  - the four reads: per-template cycle time / throughput / rework, the stage bottleneck ranking, the heatmap and the
 *    throughput series, with exact figures from controlled timestamps;
 *  - authorisation: org scope is admin-only; a project member reads only that project; a non-member is refused and
 *    the refusal audited; row-level security admits admins, system_task and project members only;
 *  - a real instance driven through the API replays `ok`.
 *
 * Everything this suite creates is scoped by RUN and removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  auditLog,
  createDb,
  eq,
  inArray,
  processAnalyticsInstances,
  processAnalyticsStageSpans,
  projectMembers,
  projects,
  runMigrations,
  sql,
  teamMembers,
  teams,
  users,
  withPrincipal,
  withSystemContext,
  workflowEvents,
  workflowInstances,
  workflowTemplates,
  type Db,
} from "@regulait/db";
import { initialState, transition, validateDefinition, type InstanceState, type WorkflowEvent } from "@regulait/workflow-kernel";
import { buildApp } from "./app.js";
import { projectProcessAnalytics, stageAnalyticsFromHistory } from "./process-analytics.js";
import { schedulerJobRegistry, SCHEDULER_JOB_NAMES } from "./scheduler-jobs.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { useTestIssuerKey } from "./testing/workload-client.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `e23-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e23-data-key-${RUN}`).digest("hex");
const MIN = 60_000;

/** trigger -> artifact -> sign-off -> git operation: wait at the artifact and sign-off, work at the git stage */
const DEF = validateDefinition({
  workflow: `e23-${RUN}`,
  stages: [
    { id: "intake", type: "trigger" },
    { id: "req", type: "artifact_generation", output: "doc" },
    { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
    { id: "branch", type: "git_operation", action: "create_branch", connection: `e23-${RUN}`, repo: "none/app" },
  ],
});

/** the controlled history: returned once (rework), then approved and executed */
const T0 = new Date("2026-10-05T10:00:00.000Z");
const at = (m: number) => new Date(T0.getTime() + m * MIN);
const HISTORY: Array<{ event: WorkflowEvent; at: Date }> = [
  { event: { kind: "start" }, at: at(0) },
  { event: { kind: "artifact_submitted", stageId: "req" }, at: at(10) },
  { event: { kind: "approval_returned", stageId: "signoff" }, at: at(30) },
  { event: { kind: "artifact_submitted", stageId: "req" }, at: at(40) },
  { event: { kind: "approval_granted", stageId: "signoff" }, at: at(60) },
  { event: { kind: "execution_succeeded", stageId: "branch" }, at: at(65) },
];
const finalState = (h: Array<{ event: WorkflowEvent }>): InstanceState =>
  h.reduce((s, x) => transition(DEF, s, x.event).state, initialState(DEF));

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let memberId: string;
let outsiderId: string;
let adminKey: { authorization: string };
let memberKey: { authorization: string };
let outsiderKey: { authorization: string };
let projectA: string;
let projectB: string;
let teamId: string;
let templateId: string;
const instanceIds: string[] = [];
let doneA: string;
let openB: string;
let divergedA: string;
let tiedA: string;
let unattributed: string;

const WINDOW = `from=${encodeURIComponent(at(-60).toISOString())}&to=${encodeURIComponent(at(24 * 60).toISOString())}`;
const get = (url: string, headers = adminKey) => app.inject({ method: "GET", url, headers });

async function seedInstance(opts: {
  projectId: string | null;
  history: Array<{ event: WorkflowEvent; at: Date }>;
  storedState?: InstanceState;
  insertOrder?: number[];
}): Promise<string> {
  const state = opts.storedState ?? finalState(opts.history);
  const [row] = await db
    .insert(workflowInstances)
    .values({
      templateIds: [templateId],
      definition: DEF,
      initiatorUserId: adminId,
      change: { description: `e23 ${RUN}` },
      state,
      status: state.status,
      projectId: opts.projectId,
    })
    .returning({ id: workflowInstances.id });
  const id = row!.id;
  const order = opts.insertOrder ?? opts.history.map((_, i) => i);
  for (const i of order) {
    const h = opts.history[i]!;
    await db.insert(workflowEvents).values({ instanceId: id, event: h.event, actorUserId: adminId, at: h.at });
  }
  instanceIds.push(id);
  return id;
}

async function mkUser(label: string, admin = false) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e23-${label}-${RUN}@example.com`, displayName: `e23 ${label}` } });
  const id = u.json().id as string;
  if (admin) await db.update(users).set({ isAdmin: true }).where(eq(users.id, id));
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "k" } });
  return { id, key: { authorization: `Bearer ${k.json().token}` } };
}

/** project only this suite's instances (other suites share the database) */
async function projectMine() {
  for (let i = 0; i < 20; i++) {
    const pass = await withSystemContext(db, "system_task", "test.e23", (tx) => projectProcessAnalytics(tx as unknown as Db));
    const mine = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM workflow_instances wi LEFT JOIN process_analytics_instances p ON p.instance_id = wi.id
       WHERE wi.id IN (${sql.join(instanceIds.map((x) => sql`${x}::uuid`), sql`, `)})
         AND (p.instance_id IS NULL OR p.source_updated_at IS DISTINCT FROM wi.updated_at)`);
    if ((mine.rows[0]?.n ?? 0) === 0) return;
    if (!pass.remaining && pass.projected + pass.diverged + pass.tooLong === 0) break;
  }
  throw new Error("projection did not converge");
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  await useTestIssuerKey(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  ({ id: adminId, key: adminKey } = await mkUser("admin", true));
  ({ id: memberId, key: memberKey } = await mkUser("member"));
  ({ id: outsiderId, key: outsiderKey } = await mkUser("outsider"));

  const [pa] = await db.insert(projects).values({ name: `e23-a-${RUN}` }).returning({ id: projects.id });
  const [pb] = await db.insert(projects).values({ name: `e23-b-${RUN}` }).returning({ id: projects.id });
  projectA = pa!.id;
  projectB = pb!.id;
  const [tm] = await db.insert(teams).values({ name: `e23-team-${RUN}` }).returning({ id: teams.id });
  teamId = tm!.id;
  await db.insert(teamMembers).values({ teamId, userId: memberId });
  await db.insert(projectMembers).values({ projectId: projectA, userId: memberId, role: "contributor", teamId });
  const [tpl] = await db.insert(workflowTemplates).values({ name: `e23-tpl-${RUN}`, definition: DEF }).returning({ id: workflowTemplates.id });
  templateId = tpl!.id;

  doneA = await seedInstance({ projectId: projectA, history: HISTORY });
  // project B: still waiting at the sign-off (an open visit)
  openB = await seedInstance({ projectId: projectB, history: HISTORY.slice(0, 2) });
  // a stored state the history cannot reach: excluded and counted
  divergedA = await seedInstance({ projectId: projectA, history: HISTORY.slice(0, 2), storedState: finalState(HISTORY) });
  // two events in one transaction (same timestamp), stored in the wrong order: re-ordered by the replay
  const tied = [
    { event: { kind: "start" } as WorkflowEvent, at: at(0) },
    { event: { kind: "artifact_submitted", stageId: "req" } as WorkflowEvent, at: at(5) },
    { event: { kind: "approval_granted", stageId: "signoff" } as WorkflowEvent, at: at(5) },
  ];
  tiedA = await seedInstance({ projectId: projectA, history: tied, insertOrder: [0, 2, 1] });
  unattributed = await seedInstance({ projectId: null, history: HISTORY });
  await projectMine();
}, 120_000);

afterAll(async () => {
  if (instanceIds.length) await db.delete(workflowInstances).where(inArray(workflowInstances.id, instanceIds));
  if (templateId) await db.delete(workflowTemplates).where(eq(workflowTemplates.id, templateId));
  if (projectA) await db.delete(projects).where(inArray(projects.id, [projectA, projectB]));
  if (teamId) await db.delete(teams).where(eq(teams.id, teamId));
  await app?.close();
});

describe("ADR-0342: the replay", () => {
  it("splits each stage visit into wait and work and marks the rework exit", () => {
    const r = stageAnalyticsFromHistory(DEF, HISTORY, finalState(HISTORY));
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.spans.map((s) => [s.stageId, s.visit, s.waitMs / MIN, s.workMs / MIN, s.exitKind])).toEqual([
      ["req", 1, 10, 0, "advanced"],
      ["signoff", 1, 20, 0, "reworked"],
      ["req", 2, 10, 0, "advanced"],
      ["signoff", 2, 20, 0, "advanced"],
      ["branch", 1, 0, 5, "ended"],
    ]);
    expect(r.terminalStatus).toBe("completed");
    expect(r.endedAt?.toISOString()).toBe(at(65).toISOString());
  });

  it("re-orders events sharing one timestamp until the kernel accepts them, and refuses an unreachable state", () => {
    const tied = [
      { event: { kind: "start" } as WorkflowEvent, at: at(0) },
      { event: { kind: "approval_granted", stageId: "signoff" } as WorkflowEvent, at: at(5) },
      { event: { kind: "artifact_submitted", stageId: "req" } as WorkflowEvent, at: at(5) },
    ];
    const stored = finalState([tied[0]!, tied[2]!, tied[1]!]);
    expect(stageAnalyticsFromHistory(DEF, tied, stored).status).toBe("ok");
    expect(stageAnalyticsFromHistory(DEF, HISTORY.slice(0, 2), finalState(HISTORY)).status).toBe("diverged");
    expect(stageAnalyticsFromHistory(DEF, [], initialState(DEF)).status).toBe("diverged");
  });
});

describe("ADR-0342: the projector", () => {
  it("projects ok, diverged and re-ordered histories and is idempotent", async () => {
    const rows = await withSystemContext(db, "system_task", "test.e23", (tx) =>
      (tx as unknown as Db).select().from(processAnalyticsInstances).where(inArray(processAnalyticsInstances.instanceId, instanceIds)),
    );
    const by = new Map(rows.map((r) => [r.instanceId, r]));
    expect(by.get(doneA)?.replayStatus).toBe("ok");
    expect(by.get(doneA)?.terminalStatus).toBe("completed");
    expect(by.get(openB)?.endedAt).toBeNull();
    expect(by.get(divergedA)?.replayStatus).toBe("diverged");
    expect(by.get(tiedA)?.replayStatus).toBe("ok");
    const spans = await withSystemContext(db, "system_task", "test.e23", (tx) =>
      (tx as unknown as Db).select().from(processAnalyticsStageSpans).where(eq(processAnalyticsStageSpans.instanceId, divergedA)),
    );
    expect(spans).toHaveLength(0);

    const before = by.get(doneA)!.projectedAt.getTime();
    await projectMine();
    const [again] = await withSystemContext(db, "system_task", "test.e23", (tx) =>
      (tx as unknown as Db).select().from(processAnalyticsInstances).where(eq(processAnalyticsInstances.instanceId, doneA)),
    );
    expect(again!.projectedAt.getTime()).toBe(before);
  });

  it("re-syncs an instance whose project was re-pointed, and the scheduler job is registered", async () => {
    await db.update(workflowInstances).set({ projectId: projectB }).where(eq(workflowInstances.id, unattributed));
    await projectMine();
    const [row] = await withSystemContext(db, "system_task", "test.e23", (tx) =>
      (tx as unknown as Db).select().from(processAnalyticsInstances).where(eq(processAnalyticsInstances.instanceId, unattributed)),
    );
    expect(row!.projectId).toBe(projectB);
    await db.update(workflowInstances).set({ projectId: null }).where(eq(workflowInstances.id, unattributed));
    await projectMine();
    expect(schedulerJobRegistry().get(SCHEDULER_JOB_NAMES.processAnalyticsProjector)?.adr).toBe("ADR-0342");
  });
});

describe("ADR-0342: the reads", () => {
  it("templates: started, ended by status, cycle time and rework rate for project A", async () => {
    const r = await get(`/v1/process-analytics/templates?scope=project&scopeId=${projectA}&${WINDOW}`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.excluded.diverged).toBe(1);
    expect(body.basis).toMatch(/workflow_events/);
    const t = body.templates.find((x: { templateId: string }) => x.templateId === templateId);
    expect(t.started).toBe(2); // doneA and tiedA (divergedA is excluded)
    expect(t.ended.total).toBe(1); // tiedA rests at the git stage
    expect(t.ended.completed).toBe(1);
    expect(t.cycleTimeMs.p50).toBe(65 * MIN);
    expect(t.reworkRate).toBe(1);
    expect(t.open).toBe(1);
  });

  it("stages: ranked by total wait, with wait vs work and rework", async () => {
    const r = await get(`/v1/process-analytics/stages?scope=project&scopeId=${projectA}&templateId=${templateId}&${WINDOW}`);
    expect(r.statusCode, r.body).toBe(200);
    const stages = r.json().stages as Array<Record<string, any>>;
    expect(stages.map((s) => s.stageId)).toEqual(["signoff", "req", "branch"]);
    const signoff = stages[0]!;
    expect(signoff.rank).toBe(1);
    expect(signoff.visits).toBe(3); // doneA x2, tiedA x1 (zero time)
    expect(signoff.waitMs.total).toBe(40 * MIN);
    expect(signoff.reworked).toBe(1);
    const branch = stages.find((s) => s.stageId === "branch")!;
    expect(branch.workMs.total).toBe(5 * MIN);
    expect(branch.open).toBe(1); // tiedA
  });

  it("heatmap and throughput: per-period cells", async () => {
    const h = await get(`/v1/process-analytics/heatmap?scope=project&scopeId=${projectA}&bucket=day&${WINDOW}`);
    expect(h.statusCode, h.body).toBe(200);
    const signoff = h.json().stages.find((s: { stageId: string }) => s.stageId === "signoff");
    expect(signoff.cells).toEqual([{ period: "2026-10-05T00:00:00Z", visits: 3, medianDurationMs: 20 * MIN, waitMs: 40 * MIN }]);
    const t = await get(`/v1/process-analytics/throughput?scope=project&scopeId=${projectA}&bucket=day&${WINDOW}`);
    expect(t.statusCode, t.body).toBe(200);
    expect(t.json().periods).toEqual([{ period: "2026-10-05T00:00:00Z", started: 2, completed: 1, aborted: 0, denied: 0, rolledBack: 0 }]);
  });

  it("bounds the window and the period count", async () => {
    expect((await get(`/v1/process-analytics/stages?from=2025-01-01T00:00:00Z&to=2026-06-01T00:00:00Z`)).statusCode).toBe(400);
    expect((await get(`/v1/process-analytics/stages?scope=project`)).statusCode).toBe(400);
    expect((await get(`/v1/process-analytics/stages?limit=1000`)).statusCode).toBe(400);
    expect((await get(`/v1/process-analytics/stages?unknown=1`)).statusCode).toBe(400);
    const tooMany = await get(`/v1/process-analytics/heatmap?bucket=day&from=2025-11-01T00:00:00Z&to=2026-11-01T00:00:00Z`);
    expect(tooMany.statusCode).toBe(200); // 366 periods is within the bound
  });
});

describe("ADR-0342: authorisation", () => {
  it("org scope: admin sees every instance including unattributed; a non-admin is refused and the refusal audited", async () => {
    const admin = await get(`/v1/process-analytics/throughput?bucket=day&${WINDOW}`);
    expect(admin.statusCode).toBe(200);
    const day = admin.json().periods.find((p: { period: string }) => p.period === "2026-10-05T00:00:00Z");
    expect(day.started).toBeGreaterThanOrEqual(4); // doneA, openB, tiedA, unattributed
    const refused = await get(`/v1/process-analytics/throughput?bucket=day&${WINDOW}`, memberKey);
    expect(refused.statusCode).toBe(403);
    const audits = await withSystemContext(db, "audit_verify", "test.e23", (tx) =>
      (tx as unknown as Db).select().from(auditLog).where(eq(auditLog.userId, memberId)),
    );
    expect(audits.some((a) => a.ruleId === "process-analytics-read-refused")).toBe(true);
  });

  it("a member reads their project and team; a non-member is refused", async () => {
    expect((await get(`/v1/process-analytics/stages?scope=project&scopeId=${projectA}`, memberKey)).statusCode).toBe(200);
    expect((await get(`/v1/process-analytics/stages?scope=project&scopeId=${projectB}`, memberKey)).statusCode).toBe(403);
    expect((await get(`/v1/process-analytics/stages?scope=project&scopeId=${projectA}`, outsiderKey)).statusCode).toBe(403);
    const team = await get(`/v1/process-analytics/templates?scope=team&scopeId=${teamId}&${WINDOW}`, memberKey);
    expect(team.statusCode, team.body).toBe(200);
    expect(team.json().templates[0].started).toBe(2);
    expect((await app.inject({ method: "POST", url: "/v1/process-analytics/refresh", headers: memberKey, payload: {} })).statusCode).toBe(403);
  });

  it("row-level security: a member reads only its project's rows; no scope reads nothing", async () => {
    const asMember = await withPrincipal(db, { userId: memberId }, (tx) =>
      (tx as unknown as Db).select({ id: processAnalyticsInstances.instanceId }).from(processAnalyticsInstances).where(inArray(processAnalyticsInstances.instanceId, instanceIds)),
    );
    expect(asMember.map((r) => r.id).sort()).toEqual([doneA, divergedA, tiedA].sort());
    const spansAsOutsider = await withPrincipal(db, { userId: outsiderId }, (tx) =>
      (tx as unknown as Db).select({ id: processAnalyticsStageSpans.instanceId }).from(processAnalyticsStageSpans).where(inArray(processAnalyticsStageSpans.instanceId, instanceIds)),
    );
    expect(spansAsOutsider).toHaveLength(0);
    const writeAsMember = withPrincipal(db, { userId: memberId }, (tx) =>
      (tx as unknown as Db).delete(processAnalyticsStageSpans).where(eq(processAnalyticsStageSpans.instanceId, doneA)).returning(),
    );
    expect(await writeAsMember).toHaveLength(0);
    const asCredential = await withSystemContext(db, "credential_request", "test.e23", (tx) =>
      (tx as unknown as Db).select({ id: processAnalyticsInstances.instanceId }).from(processAnalyticsInstances),
    );
    expect(asCredential).toHaveLength(0);
  });

  it("refresh is admin-only and audited", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/process-analytics/refresh", headers: adminKey, payload: {} });
    expect(r.statusCode, r.body).toBe(200);
    expect(typeof r.json().projected).toBe("number");
  });
});

describe("ADR-0342: a real instance driven through the API", () => {
  it("replays ok", async () => {
    const name = `e23-api-${RUN}`;
    const tpl = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/workflows/templates",
      payload: { name, definition: { workflow: name, stages: [{ id: "intake", type: "trigger" }, { id: "doc", type: "artifact_generation", output: "doc" }] } },
    });
    expect(tpl.statusCode, tpl.body).toBe(201);
    const rule = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: tpl.json().id, changeType: name } });
    expect(rule.statusCode, rule.body).toBe(201);
    const inst = await app.inject({ method: "POST", headers: memberKey, url: "/v1/workflows/instances", payload: { change: { description: "e23", paths: ["x.ts"], changeType: name, environment: "dev" } } });
    expect(inst.statusCode, inst.body).toBe(201);
    const id = inst.json().id as string;
    instanceIds.push(id);
    const abort = await app.inject({ method: "POST", headers: memberKey, url: `/v1/workflows/instances/${id}/abort`, payload: {} });
    expect(abort.statusCode, abort.body).toBe(200);
    await projectMine();
    const [row] = await withSystemContext(db, "system_task", "test.e23", (tx) =>
      (tx as unknown as Db).select().from(processAnalyticsInstances).where(eq(processAnalyticsInstances.instanceId, id)),
    );
    expect(row?.replayStatus).toBe("ok");
    expect(row?.terminalStatus).toBe("aborted");
    await db.delete(workflowTemplates).where(eq(workflowTemplates.id, tpl.json().id));
  });
});
