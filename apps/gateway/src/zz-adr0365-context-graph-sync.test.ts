/**
 * ADR-0365 slice 2 (lane E46): the context graph's scheduled sync and its work-item-to-run edges, on a real database.
 *
 *  - both jobs are registered (hourly incremental, daily full) and run under the scheduler's `system_task` scope, so
 *    the policies of `shared_context_graph_runs` are exercised as the app role, not the owner;
 *  - a live `pm_links` row (a `run`, or a `run_node` of that run) for a bound work item becomes one run node and one
 *    `tracks` edge; a link created later is picked up by the next incremental pass;
 *  - a run node is visible to its initiator (a project member) and admins only: another member of the same project
 *    sees neither the run node nor the edge to it, gets a 404 for it, and walks past it in a neighbourhood;
 *  - an orphaned link keeps its edge until the daily full pass, which removes the edge and the run node left alone;
 *  - each source's sync writes its audit row in the scheduler's name.
 *
 * Global state (M-068): connections, projects, runs and users this file creates are deleted in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  contextGraphEdges,
  contextGraphNodeUserScopes,
  contextGraphNodes,
  createDb,
  eq,
  inArray,
  orchestrationRuns,
  pmConnections,
  pmImportedWorkItems,
  pmLinks,
  projectMembers,
  projects,
  runMigrations,
  runWithRlsSystem,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { CONTEXT_GRAPH_FULL_SYNC_JOB_NAME, CONTEXT_GRAPH_SYNC_JOB_NAME } from "./context-graph.js";
import { SCHEDULER_JOB_NAMES, schedulerJobRegistry } from "./scheduler-jobs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(4).toString("hex");
const BOOT = `e46sync-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e46sync-data-key-${RUN}`).digest("hex");
const NIL = "00000000-0000-0000-0000-000000000000";

let db: Db;
let app: ReturnType<typeof buildApp>;
const created = { connections: [] as string[], projects: [] as string[], users: [] as string[], runs: [] as string[] };
const key: Record<string, { authorization: string }> = {};
const uid: Record<string, string> = {};

async function mkUser(label: string) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e46sync-${label}-${RUN}@example.com`, displayName: `e46 ${label}` } });
  expect(u.statusCode, u.body).toBe(201);
  uid[label] = u.json().id as string;
  created.users.push(uid[label]!);
  const k = await app.inject({ method: "POST", url: `/v1/users/${uid[label]}/keys`, headers: AUTH, payload: { name: "k" } });
  key[label] = { authorization: `Bearer ${k.json().token}` };
}
const job = (name: string) => {
  const def = schedulerJobRegistry().get(name);
  if (!def) throw new Error(`job ${name} is not registered`);
  return () => runWithRlsSystem("system_task", `test.${name}`, () => def.run({ db, actorUserId: null, now: new Date(), runId: NIL }));
};
const nodesAs = async (who: string, sourceId: string) => {
  const r = await app.inject({ method: "GET", url: `/v1/context-graph/nodes?limit=200&sourceId=${sourceId}`, headers: key[who] ?? AUTH });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items as { id: string; kind: string; label: string }[];
};
const neighbours = async (who: string, nodeId: string) => {
  const r = await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${nodeId}/neighbours`, headers: key[who] ?? AUTH });
  expect(r.statusCode, r.body).toBe(200);
  const j = r.json() as { nodes: { kind: string; label: string }[]; edges: { kind: string }[] };
  return { kinds: j.nodes.map((n) => n.kind).sort(), edges: j.edges.map((e) => e.kind).sort() };
};

let projectId: string;
let connectionId: string;
let sourceId: string;
let runId: string;
let itemIds: Record<string, string>;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  for (const l of ["alice", "bob"]) await mkUser(l);
  const [p] = await db.insert(projects).values({ name: `e46sync-${RUN}` }).returning({ id: projects.id });
  projectId = p!.id;
  created.projects.push(projectId);
  await db.insert(projectMembers).values([
    { projectId, userId: uid.alice!, role: "viewer" },
    { projectId, userId: uid.bob!, role: "viewer" },
  ]);
  const [c] = await db.insert(pmConnections).values({ name: `e46sync-${RUN}`, provider: "mock", project: "PM-sync", tokenCiphertext: "x" }).returning({ id: pmConnections.id });
  connectionId = c!.id;
  created.connections.push(connectionId);
  const items = await db
    .insert(pmImportedWorkItems)
    .values(["S-1", "S-2", "S-3"].map((e) => ({ connectionId, externalId: e, externalUrl: `https://pm.example/${e}`, itemType: "Story" })))
    .returning({ id: pmImportedWorkItems.id, ext: pmImportedWorkItems.externalId });
  itemIds = Object.fromEntries(items.map((i) => [i.ext, i.id]));
  const [r] = await db
    .insert(orchestrationRuns)
    .values({ name: `alice-run-${RUN}`, initiatingUserId: uid.alice!, graph: { nodes: [] }, state: { nodeStatuses: {} } } as typeof orchestrationRuns.$inferInsert)
    .returning({ id: orchestrationRuns.id });
  runId = r!.id;
  created.runs.push(runId);
  // S-1 tracks the run; S-2 tracks one of its nodes (the same run); S-3 has no link
  await db.insert(pmLinks).values([
    { connectionId, objectType: "run", objectId: runId, nodeId: null, externalId: "S-1", externalUrl: "https://pm.example/S-1" },
    { connectionId, objectType: "run_node", objectId: runId, nodeId: "n1", externalId: "S-2", externalUrl: "https://pm.example/S-2" },
  ]);
  const b = await app.inject({ method: "POST", url: "/v1/context-graph/sources", headers: AUTH, payload: { pmConnectionId: connectionId, projectId } });
  expect(b.statusCode, b.body).toBe(201);
  sourceId = b.json().id as string;
}, 120_000);

afterAll(async () => {
  if (created.connections.length) await db.delete(pmConnections).where(inArray(pmConnections.id, created.connections));
  if (created.runs.length) await db.delete(orchestrationRuns).where(inArray(orchestrationRuns.id, created.runs));
  if (created.projects.length) await db.delete(projects).where(inArray(projects.id, created.projects));
  if (created.users.length) await db.delete(users).where(inArray(users.id, created.users));
  await app?.close();
});

const runNode = async () =>
  (await db.select().from(contextGraphNodes).where(and(eq(contextGraphNodes.sourceId, sourceId), eq(contextGraphNodes.kind, "orchestration_run"))))[0];
const itemNode = async (ext: string) =>
  (await db.select().from(contextGraphNodes).where(eq(contextGraphNodes.pmImportedWorkItemId, itemIds[ext]!)))[0]!;
const tracksCount = async () =>
  (await db
    .select({ id: contextGraphEdges.id })
    .from(contextGraphEdges)
    .innerJoin(contextGraphNodes, eq(contextGraphNodes.id, contextGraphEdges.fromNodeId))
    .where(and(eq(contextGraphNodes.sourceId, sourceId), eq(contextGraphEdges.kind, "tracks")))).length;

describe("ADR-0365 slice 2: the scheduled sync", () => {
  it("both jobs are registered under ADR-0365: hourly incremental and daily full", () => {
    const reg = schedulerJobRegistry();
    expect(SCHEDULER_JOB_NAMES.contextGraphSync).toBe(CONTEXT_GRAPH_SYNC_JOB_NAME);
    expect(SCHEDULER_JOB_NAMES.contextGraphFullSync).toBe(CONTEXT_GRAPH_FULL_SYNC_JOB_NAME);
    expect([reg.get(CONTEXT_GRAPH_SYNC_JOB_NAME)?.adr, reg.get(CONTEXT_GRAPH_SYNC_JOB_NAME)?.defaultIntervalSeconds]).toEqual(["ADR-0365", 3600]);
    expect([reg.get(CONTEXT_GRAPH_FULL_SYNC_JOB_NAME)?.adr, reg.get(CONTEXT_GRAPH_FULL_SYNC_JOB_NAME)?.defaultIntervalSeconds]).toEqual(["ADR-0365", 86400]);
  });

  it("the incremental job (as system_task) projects the items, one run node and a tracks edge per linked item", async () => {
    const out = (await job(CONTEXT_GRAPH_SYNC_JOB_NAME)()) as { detail: { synced: number; failed: unknown[] } };
    expect(out.detail.failed).toEqual([]);
    expect(out.detail.synced).toBeGreaterThanOrEqual(1);
    const rn = await runNode();
    expect(rn?.orchestrationRunId).toBe(runId);
    expect(await tracksCount()).toBe(2);
    // the run node's user scope is the run's initiator
    expect((await db.select().from(contextGraphNodeUserScopes).where(eq(contextGraphNodeUserScopes.nodeId, rn!.id))).map((s) => s.userId)).toEqual([uid.alice]);
    // audited in the scheduler's name
    const rows = await db
      .select({ ruleId: auditLog.ruleId, userId: auditLog.userId })
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "context_graph_source"), eq(auditLog.objectId, sourceId), eq(auditLog.ruleId, "context-graph-synced")));
    expect(rows.map((r) => r.userId)).toEqual([NIL]);
    // a second pass creates nothing new
    await job(CONTEXT_GRAPH_SYNC_JOB_NAME)();
    expect(await tracksCount()).toBe(2);
  });

  it("a run is visible to its initiator only: another member sees neither the run node nor the edge to it", async () => {
    const rn = (await runNode())!;
    expect((await nodesAs("alice", sourceId)).filter((n) => n.kind === "orchestration_run").map((n) => n.label)).toEqual([`alice-run-${RUN}`]);
    expect((await nodesAs("bob", sourceId)).map((n) => n.kind).sort()).toEqual(["pm_project", "pm_work_item", "pm_work_item", "pm_work_item"]);
    const hidden = await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${rn.id}`, headers: key.bob! });
    expect([hidden.statusCode, hidden.json().error]).toEqual([404, "node_not_found"]);
    const s1 = await itemNode("S-1");
    expect(await neighbours("alice", s1.id)).toEqual({ kinds: ["orchestration_run", "pm_project"], edges: ["contains", "tracks"] });
    expect(await neighbours("bob", s1.id)).toEqual({ kinds: ["pm_project"], edges: ["contains"] });
    // an admin sees it too
    expect((await nodesAs("admin", sourceId)).some((n) => n.kind === "orchestration_run")).toBe(true);
  });

  it("a link created after the last pass is picked up by the next incremental pass", async () => {
    await db.insert(pmLinks).values({ connectionId, objectType: "run_node", objectId: runId, nodeId: "n3", externalId: "S-3", externalUrl: "https://pm.example/S-3" });
    await job(CONTEXT_GRAPH_SYNC_JOB_NAME)();
    expect(await tracksCount()).toBe(3);
  });

  it("an orphaned link keeps its edge until the full pass, which removes it and a run node left with no edge", async () => {
    await db.update(pmLinks).set({ orphanedAt: new Date() }).where(and(eq(pmLinks.connectionId, connectionId), eq(pmLinks.externalId, "S-3")));
    await job(CONTEXT_GRAPH_SYNC_JOB_NAME)();
    expect(await tracksCount()).toBe(3);
    await job(CONTEXT_GRAPH_FULL_SYNC_JOB_NAME)();
    expect(await tracksCount()).toBe(2);
    expect(await runNode()).toBeTruthy();
    await db.update(pmLinks).set({ orphanedAt: new Date() }).where(eq(pmLinks.connectionId, connectionId));
    await job(CONTEXT_GRAPH_FULL_SYNC_JOB_NAME)();
    expect(await tracksCount()).toBe(0);
    expect(await runNode()).toBeUndefined();
  });
});
