/**
 * ADR-0312 — cost per outcome: the recorder, the metered spend join, the roll-ups, and row-level security.
 *
 * Fixtures are written straight to the tables (workflow instances, runs, PM links and metered usage rows) under this
 * run's ids; other files' outcomes may be recorded by the same pass and are never asserted on.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  costOutcomes,
  createDb,
  eq,
  importedCostLines,
  costImportBatches,
  inArray,
  orchestrationRuns,
  pmConnections,
  pmLinks,
  projects,
  runMigrations,
  sql,
  usageEvents,
  withPrincipal,
  withSystemContext,
  workflowInstances,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { COST_OUTCOME_BASIS_STATEMENT, recordCostOutcomes, resolveOutcomeWindow } from "./cost-outcomes.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0312-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();

let db: Db;
let app: ReturnType<typeof buildApp>;
const restores: Array<() => Promise<void>> = [];
let alice: string; // initiates the workflows
let bob: string; // initiates nothing
let aliceKey: { authorization: string };
let bobKey: { authorization: string };
const projectId = randomUUID();
const cc = `CC-0312-${RUN}`;
const ids = {
  merged: randomUUID(), // completed, merged: merged_pr + workflow_run + accepted_change
  aborted: randomUUID(), // aborted: workflow_run only
  running: randomUUID(), // still running: nothing
  runA: randomUUID(),
  runB: randomUUID(),
  runC: randomUUID(), // a standalone run with a PM link per node
  conn: randomUUID(),
  linkInstance: randomUUID(),
  linkNodeDone: randomUUID(),
  linkNodeOpen: randomUUID(),
};

async function mkUser(tag: string): Promise<{ id: string; key: { authorization: string } }> {
  const created = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `adr0312-${tag}-${RUN}@example.com`, displayName: `adr0312 ${tag}`, isAdmin: false },
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  const key = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "adr0312" } });
  return { id, key: { authorization: `Bearer ${key.json().token}` } };
}

const instance = (id: string, status: string, context: Record<string, unknown>) => ({
  id,
  templateIds: ["adr0312"],
  definition: {},
  initiatorUserId: alice,
  change: {},
  state: { status },
  status,
  context,
  projectId,
});

const run = (id: string, instanceId: string | null, status: "completed" | "aborted" | "running", nodeStatuses: Record<string, string> = {}) => ({
  id,
  name: `adr0312 ${id}`,
  initiatingUserId: alice,
  workflowInstanceId: instanceId,
  graph: { nodes: [] },
  state: { status, nodeStatuses, attempts: {}, owners: {}, lastError: {} },
  status,
  projectId,
});

const usage = (runId: string, costUsd: number | null, nodeId?: string) => ({
  userId: alice,
  objectType: "agent",
  costUsd,
  projectId,
  detail: { runId, ...(nodeId ? { nodeId } : {}), adr0312: RUN },
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT });
  const a = await mkUser("alice");
  const b = await mkUser("bob");
  alice = a.id;
  bob = b.id;
  aliceKey = a.key;
  bobKey = b.key;
  await db.insert(projects).values({ id: projectId, name: `adr0312-project-${RUN}`, costCenter: cc });
  await db.insert(workflowInstances).values([
    instance(ids.merged, "completed", { prId: "17", mergeSha: "a".repeat(40) }),
    instance(ids.aborted, "aborted", {}),
    instance(ids.running, "running", { prId: "18" }),
  ]);
  await db.insert(orchestrationRuns).values([
    run(ids.runA, ids.merged, "completed"),
    run(ids.runB, ids.aborted, "aborted"),
    run(ids.runC, null, "running", { n1: "done", n2: "in_progress" }),
  ]);
  await db.insert(usageEvents).values([
    usage(ids.runA, 1.25),
    usage(ids.runA, 0.75),
    usage(ids.runA, null), // unpriced: counted, adds nothing
    usage(ids.runB, 0.5),
    usage(ids.runC, 2, "n1"),
    usage(ids.runC, 3, "n2"),
  ]);
  await db.insert(pmConnections).values({
    id: ids.conn,
    name: `adr0312-pm-${RUN}`,
    provider: "mock",
    project: "REG",
    tokenCiphertext: "unused",
    webhookSecretHash: "unused",
  });
  await db.insert(pmLinks).values([
    { id: ids.linkInstance, connectionId: ids.conn, objectType: "workflow_instance", objectId: ids.merged, externalId: `E-${RUN}-1`, externalUrl: "https://pm.example.com/1" },
    { id: ids.linkNodeDone, connectionId: ids.conn, objectType: "run_node", objectId: ids.runC, nodeId: "n1", externalId: `E-${RUN}-2`, externalUrl: "https://pm.example.com/2" },
    { id: ids.linkNodeOpen, connectionId: ids.conn, objectType: "run_node", objectId: ids.runC, nodeId: "n2", externalId: `E-${RUN}-3`, externalUrl: "https://pm.example.com/3" },
  ]);
});

afterAll(async () => {
  for (const r of restores.reverse()) await r();
  await app?.close();
});

const mine = async () =>
  db
    .select()
    .from(costOutcomes)
    .where(inArray(costOutcomes.workflowInstanceId, [ids.merged, ids.aborted, ids.running]));

describe("ADR-0312 the recorder", () => {
  it("records each outcome once, from the instance, run and PM link state", async () => {
    await withSystemContext(db, "system_task", "test.adr0312", async (tx) => {
      await recordCostOutcomes(tx as unknown as Db, "schedule");
    });
    // a second pass (and a manual one) adds nothing for these subjects
    await withSystemContext(db, "system_task", "test.adr0312", async (tx) => {
      await recordCostOutcomes(tx as unknown as Db, "schedule");
    });
    const refresh = await app.inject({ method: "POST", url: "/v1/cost-outcomes/refresh", headers: AUTH });
    expect(refresh.statusCode, refresh.body).toBe(200);

    const rows = await mine();
    const kinds = (id: string) => rows.filter((r) => r.workflowInstanceId === id && r.kind !== "completed_work_item").map((r) => r.kind).sort();
    expect(kinds(ids.merged)).toEqual(["accepted_change", "merged_pr", "workflow_run"]);
    expect(kinds(ids.aborted)).toEqual(["workflow_run"]);
    expect(kinds(ids.running)).toEqual([]);
    const merged = rows.find((r) => r.kind === "merged_pr")!;
    expect(merged).toMatchObject({ mergeSha: "a".repeat(40), projectId, initiatorUserId: alice, subjectStatus: "completed" });

    const items = await db.select().from(costOutcomes).where(inArray(costOutcomes.pmLinkId, [ids.linkInstance, ids.linkNodeDone, ids.linkNodeOpen]));
    expect(items.map((r) => r.pmLinkId).sort()).toEqual([ids.linkInstance, ids.linkNodeDone].sort());
    expect(items.find((r) => r.pmLinkId === ids.linkNodeDone)).toMatchObject({ orchestrationRunId: ids.runC, nodeId: "n1" });
  });

  it("is append-only for the app role", async () => {
    const [row] = await mine();
    await expect(
      withSystemContext(db, "system_task", "test.adr0312", (tx) => tx.update(costOutcomes).set({ subjectStatus: "x" }).where(eq(costOutcomes.id, row!.id))),
    ).rejects.toMatchObject({ cause: { code: "42501", message: expect.stringMatching(/permission denied/) } });
    await expect(
      withSystemContext(db, "system_task", "test.adr0312", (tx) => tx.delete(costOutcomes).where(eq(costOutcomes.id, row!.id))),
    ).rejects.toMatchObject({ cause: { code: "42501", message: expect.stringMatching(/permission denied/) } });
  });
});

describe("ADR-0312 row-level security", () => {
  it("a principal reads only outcomes of workflows it initiated, and cannot insert", async () => {
    const asBob = await withPrincipal(db, { userId: bob }, (tx) => tx.select().from(costOutcomes).where(eq(costOutcomes.projectId, projectId)));
    expect(asBob).toEqual([]);
    const asAlice = await withPrincipal(db, { userId: alice }, (tx) => tx.select().from(costOutcomes).where(eq(costOutcomes.projectId, projectId)));
    expect(asAlice.length).toBe(6);
    await expect(
      withPrincipal(db, { userId: alice }, (tx) =>
        tx.insert(costOutcomes).values({ kind: "workflow_run", workflowInstanceId: ids.running, subjectStatus: "running", trigger: "manual" }),
      ),
    ).rejects.toMatchObject({ cause: { code: "42501", message: expect.stringMatching(/row-level security/) } });
  });

  it("no principal and no system context sees zero rows", async () => {
    const r = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('role', 'regulait_app', true)`);
      return tx.execute<{ n: number }>(sql`select count(*)::int as n from cost_outcomes`);
    });
    expect(r.rows[0]!.n).toBe(0);
  });
});

describe("ADR-0312 the list", () => {
  const q = `kind=merged_pr&projectId=${projectId}&limit=10`;

  it("joins the metered spend of the outcome's runs, counting unpriced calls", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/cost-outcomes?${q}`, headers: AUTH });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.basis).toBe("metered");
    expect(body.basisStatement).toBe(COST_OUTCOME_BASIS_STATEMENT);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ kind: "merged_pr", meteredUsd: 2, calls: 3, unpricedCalls: 1, projectName: `adr0312-project-${RUN}` });
  });

  it("a node's work item carries only that node's spend", async () => {
    const res = await app.inject({ method: "GET", url: `/v1/cost-outcomes?kind=completed_work_item&projectId=${projectId}&limit=10`, headers: AUTH });
    expect(res.statusCode, res.body).toBe(200);
    const byLink = new Map(res.json().items.map((i: { pmLinkId: string; meteredUsd: number }) => [i.pmLinkId, i.meteredUsd]));
    expect(byLink.get(ids.linkNodeDone)).toBe(2);
    expect(byLink.get(ids.linkInstance)).toBe(2); // the instance's run: 1.25 + 0.75
  });

  it("a non-admin sees their own outcomes and nobody else's", async () => {
    const asAlice = await app.inject({ method: "GET", url: `/v1/cost-outcomes?projectId=${projectId}&limit=10`, headers: aliceKey });
    expect(asAlice.statusCode, asAlice.body).toBe(200);
    expect(asAlice.json().items).toHaveLength(6);
    const asBob = await app.inject({ method: "GET", url: `/v1/cost-outcomes?projectId=${projectId}&limit=10`, headers: bobKey });
    expect(asBob.statusCode, asBob.body).toBe(200);
    expect(asBob.json().items).toEqual([]);
  });

  it("refuses a bad window and unknown parameters", async () => {
    const back = await app.inject({ method: "GET", url: `/v1/cost-outcomes?from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z`, headers: AUTH });
    expect(back.statusCode).toBe(400);
    const wide = await app.inject({ method: "GET", url: `/v1/cost-outcomes?from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`, headers: AUTH });
    expect(wide.statusCode).toBe(400);
    const odd = await app.inject({ method: "GET", url: `/v1/cost-outcomes?userId=${bob}`, headers: AUTH });
    expect(odd.statusCode).toBe(400);
  });

  it("pages under the list contract", async () => {
    const first = await app.inject({ method: "GET", url: `/v1/cost-outcomes?projectId=${projectId}&limit=10&count=exact`, headers: AUTH });
    expect(first.json().total).toBe(6);
  });
});

describe("ADR-0312 the roll-up (admin)", () => {
  it("is admin-only", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/cost-outcomes/summary", headers: aliceKey });
    expect(res.statusCode).toBe(403);
    const refresh = await app.inject({ method: "POST", url: "/v1/cost-outcomes/refresh", headers: aliceKey });
    expect(refresh.statusCode).toBe(403);
  });

  it("per project: outcomes, metered spend and cost per outcome by kind", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/cost-outcomes/summary?by=project&limit=500", headers: AUTH });
    expect(res.statusCode, res.body).toBe(200);
    const g = res.json().groups.find((x: { key: string }) => x.key === projectId);
    expect(g.label).toBe(`adr0312-project-${RUN}`);
    expect(g.imported).toBeNull();
    expect(g.metered.merged_pr).toEqual({ outcomes: 1, meteredUsd: 2, calls: 3, unpricedCalls: 1, meteredPerOutcomeUsd: 2 });
    // two runs: 2.00 (merged) + 0.50 (aborted) over two outcomes
    expect(g.metered.workflow_run).toMatchObject({ outcomes: 2, meteredUsd: 2.5, meteredPerOutcomeUsd: 1.25 });
    expect(g.metered.accepted_change).toMatchObject({ outcomes: 1, meteredUsd: 2 });
    expect(g.metered.completed_work_item).toMatchObject({ outcomes: 2, meteredUsd: 4 });
  });

  it("per cost centre: imported spend beside the metered figure, never combined", async () => {
    const batch = randomUUID();
    await db.insert(costImportBatches).values({
      id: batch,
      adapter: "generic_csv",
      vendor: "adr0312",
      format: "csv",
      mode: "apply",
      status: "applied",
      payloadSha256: `adr0312-${RUN}`,
      rowsParsed: 1,
      rowsAccepted: 1,
      refusals: [],
      summary: {},
      ruleId: "adr0312",
      reason: "adr0312 fixture",
    });
    const now = Date.now();
    await db.insert(importedCostLines).values({
      batchId: batch,
      vendor: "adr0312",
      adapter: "generic_csv",
      sourceRow: 1,
      accountRef: "x",
      accountKey: "x",
      resolutionMethod: "unresolved",
      resolutionDetail: "fixture",
      costCenter: cc,
      periodStart: new Date(now - 5 * 86_400_000),
      periodEnd: new Date(now - 4 * 86_400_000),
      amount: 40,
      billingKind: "seat",
    });
    const res = await app.inject({ method: "GET", url: "/v1/cost-outcomes/summary?by=cost_center&limit=500", headers: AUTH });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    const g = body.groups.find((x: { key: string }) => x.key === cc);
    expect(g.imported).toEqual({ basis: "imported", usd: 40, lines: 1, nonUsdLines: 0 });
    expect(g.metered.merged_pr.meteredUsd).toBe(2);
    expect(JSON.stringify(g)).not.toMatch(/combined|total/i);
    expect(body.note).toMatch(/no combined/);
  });

  it("pages groups by offset", async () => {
    const one = await app.inject({ method: "GET", url: "/v1/cost-outcomes/summary?by=project&limit=1", headers: AUTH });
    expect(one.statusCode).toBe(200);
    expect(one.json().groups).toHaveLength(1);
    expect(one.json().totalGroups).toBeGreaterThanOrEqual(1);
    const bad = await app.inject({ method: "GET", url: "/v1/cost-outcomes/summary?limit=501", headers: AUTH });
    expect(bad.statusCode).toBe(400);
  });
});

describe("ADR-0312 windows", () => {
  it("defaults to 30 days and refuses more than 366", () => {
    const now = new Date("2026-11-15T00:00:00Z");
    const w = resolveOutcomeWindow({}, now);
    expect(w.to).toEqual(now);
    expect(now.getTime() - w.from.getTime()).toBe(30 * 86_400_000);
    expect(() => resolveOutcomeWindow({ from: "2025-01-01T00:00:00Z", to: "2026-11-15T00:00:00Z" })).toThrow(/366/);
  });
});

