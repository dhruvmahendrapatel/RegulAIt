/**
 * ADR-0365 (lane E46, slice 1): the live context graph, on a real database through the real routes.
 *
 *  - strict by default: no binding, no nodes, for anyone but an admin; binding is admin-only, audited, refused for an
 *    archived project or a second binding of the same connection;
 *  - the sync is incremental and idempotent: it creates the project node, one node, scope row and `contains` edge per
 *    imported item, re-running creates nothing, an item imported later appears on the next sync, and the cursor
 *    survives a capped call (`more`);
 *  - a user never sees a node they cannot access: a non-member gets an empty list and a 404 for a node and its
 *    neighbourhood (the same as a missing id); a node with an extra scope is hidden from a member of only one of its
 *    projects, together with every edge to it, and a node with no scope is hidden from everyone but an admin;
 *  - rebinding re-scopes at once (the old project's members lose sight in the same transaction); unbinding removes the
 *    nodes; a missing item reads `missing: true` from the join, and nothing PM-authoritative is returned.
 *
 * Global state (M-068): every row this file creates is deleted in afterAll (connections and projects cascade).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  and,
  asc,
  auditLog,
  contextGraphEdges,
  contextGraphNodeScopes,
  contextGraphNodes,
  contextGraphSources,
  createDb,
  eq,
  inArray,
  pmConnections,
  pmImportedWorkItems,
  projectMembers,
  projects,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { syncContextGraphSource } from "./context-graph.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(4).toString("hex");
const BOOT = `e46cg-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = createHash("sha256").update(`e46cg-data-key-${RUN}`).digest("hex");

let db: Db;
let app: ReturnType<typeof buildApp>;
const createdConnections: string[] = [];
const createdProjects: string[] = [];
const createdUsers: string[] = [];
const key: Record<string, { authorization: string }> = {};
const uid: Record<string, string> = {};

async function mkUser(label: string) {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `e46cg-${label}-${RUN}@example.com`, displayName: `e46 ${label}` } });
  expect(u.statusCode, u.body).toBe(201);
  const id = u.json().id as string;
  createdUsers.push(id);
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "k" } });
  uid[label] = id;
  key[label] = { authorization: `Bearer ${k.json().token}` };
}
async function mkProject(label: string, archived = false) {
  const [p] = await db
    .insert(projects)
    .values({ name: `e46cg-${label}-${RUN}`, ...(archived ? { archivedAt: new Date(), archivedReason: "archived for the e46 test", archivedByUserId: uid.alice! } : {}) })
    .returning({ id: projects.id });
  createdProjects.push(p!.id);
  return p!.id;
}
const member = (projectId: string, label: string) => db.insert(projectMembers).values({ projectId, userId: uid[label]!, role: "viewer" });
async function mkConnection(label: string) {
  const [c] = await db.insert(pmConnections).values({ name: `e46cg-${label}-${RUN}`, provider: "mock", project: `PM-${label}`, tokenCiphertext: "x" }).returning({ id: pmConnections.id });
  createdConnections.push(c!.id);
  return c!.id;
}
const importItems = async (connectionId: string, ext: string[], firstSeenAt?: Date) =>
  (
    await db
      .insert(pmImportedWorkItems)
      .values(ext.map((e) => ({ connectionId, externalId: e, externalUrl: `https://pm.example/${e}`, itemType: "Story", ...(firstSeenAt ? { firstSeenAt } : {}) })))
      .returning({ id: pmImportedWorkItems.id })
  ).map((r) => r.id);
const bind = (pmConnectionId: string, projectId: string, headers = AUTH) =>
  app.inject({ method: "POST", url: "/v1/context-graph/sources", headers, payload: { pmConnectionId, projectId } });
const sync = (sourceId: string, full = false) => app.inject({ method: "POST", url: `/v1/context-graph/sources/${sourceId}/sync`, headers: AUTH, payload: { full } });
const nodesAs = async (who: string, qs = "") => {
  const r = await app.inject({ method: "GET", url: `/v1/context-graph/nodes?limit=200${qs}`, headers: key[who]! });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().items as { id: string; kind: string; label: string; missing: boolean; externalUrl: string | null; sourceId: string }[];
};
const auditRules = async (sourceId: string) =>
  (await db.select({ ruleId: auditLog.ruleId }).from(auditLog).where(and(eq(auditLog.objectType, "context_graph_source"), eq(auditLog.objectId, sourceId))).orderBy(asc(auditLog.seq))).map((r) => r.ruleId);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  for (const l of ["alice", "bob", "carol"]) await mkUser(l);
}, 120_000);

afterAll(async () => {
  if (createdConnections.length) await db.delete(pmConnections).where(inArray(pmConnections.id, createdConnections));
  if (createdProjects.length) await db.delete(projects).where(inArray(projects.id, createdProjects));
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await app?.close();
});

describe("ADR-0365 binding is strict by default", () => {
  it("imported work items reach no one until an admin binds the connection; a member cannot bind", async () => {
    const projectId = await mkProject("unbound");
    await member(projectId, "alice");
    const conn = await mkConnection("unbound");
    await importItems(conn, ["U-1", "U-2"]);
    expect((await nodesAs("alice")).filter((n) => n.label.startsWith("U-"))).toEqual([]);
    const r = await bind(conn, projectId, key.alice!);
    expect(r.statusCode).toBe(403);
    expect(await db.select().from(contextGraphSources).where(eq(contextGraphSources.pmConnectionId, conn))).toEqual([]);
  });

  it("binding is audited; an archived project, an unknown connection and a second binding are refused", async () => {
    const projectId = await mkProject("bind");
    const archived = await mkProject("archived", true);
    const conn = await mkConnection("bind");
    expect((await bind(conn, archived)).statusCode).toBe(409);
    expect((await bind("00000000-0000-4000-8000-00000000e460", projectId)).statusCode).toBe(404);
    const ok = await bind(conn, projectId);
    expect(ok.statusCode, ok.body).toBe(201);
    expect((await bind(conn, projectId)).statusCode).toBe(409);
    expect(await auditRules(ok.json().id)).toEqual(["context-graph-source-bound"]);
    // the binding route is admin-only and refuses a body with extra fields
    const extra = await app.inject({ method: "POST", url: "/v1/context-graph/sources", headers: AUTH, payload: { pmConnectionId: conn, projectId, scope: "all" } });
    expect(extra.statusCode).toBe(400);
  });
});

describe("ADR-0365 sync is incremental and idempotent", () => {
  it("creates the project node and one node, scope row and edge per item; a re-run creates nothing; a later item appears", async () => {
    const projectId = await mkProject("sync");
    const conn = await mkConnection("sync");
    const items = await importItems(conn, ["S-1", "S-2", "S-3"]);
    const src = (await bind(conn, projectId)).json().id as string;
    const first = await sync(src);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toMatchObject({ scanned: 3, created: { nodes: 4, edges: 3, scopes: 4 }, more: false });
    const again = (await sync(src)).json();
    expect(again.created).toEqual({ nodes: 0, edges: 0, scopes: 0 });
    // the overlap window re-reads recent items harmlessly
    expect(again.scanned).toBe(3);
    const later = await importItems(conn, ["S-4"]);
    const third = (await sync(src)).json();
    expect(third.created).toEqual({ nodes: 1, edges: 1, scopes: 1 });
    const nodes = await db.select().from(contextGraphNodes).where(eq(contextGraphNodes.sourceId, src));
    expect(nodes.filter((n) => n.kind === "pm_work_item").map((n) => n.pmImportedWorkItemId).sort()).toEqual([...items, ...later].sort());
    expect(await auditRules(src)).toEqual(["context-graph-source-bound", "context-graph-synced", "context-graph-synced", "context-graph-synced"]);
  });

  it("an item older than the overlap behind the cursor is not re-read; a full pass reads everything", async () => {
    const projectId = await mkProject("cursor");
    const conn = await mkConnection("cursor");
    await importItems(conn, ["C-1"], new Date(Date.now() - 3 * 3_600_000));
    await importItems(conn, ["C-2"]);
    const src = (await bind(conn, projectId)).json().id as string;
    expect((await sync(src)).json().scanned).toBe(2);
    // the cursor is C-2 (now): C-1 lies hours behind it, outside the overlap, and is not read again
    expect((await sync(src)).json().scanned).toBe(1);
    await importItems(conn, ["C-3"]);
    const inc = (await sync(src)).json();
    expect([inc.scanned, inc.created.nodes]).toEqual([2, 1]);
    expect((await sync(src, true)).json().scanned).toBe(3);
  });

  it("a capped call stops with more=true and keeps its place; the next call finishes", async () => {
    const projectId = await mkProject("cap");
    const conn = await mkConnection("cap");
    await importItems(conn, Array.from({ length: 7 }, (_, i) => `K-${i}`));
    const src = (await bind(conn, projectId)).json().id as string;
    const capped = await db.transaction((tx) => syncContextGraphSource(tx as unknown as Db, { sourceId: src, actorUserId: uid.alice!, pageSize: 3, maxItems: 3 }));
    expect(capped).toMatchObject({ ok: true, scanned: 3, more: true, created: { nodes: 4 } });
    // the same cap again: all seven share one timestamp, so the resume re-reads the overlap, yet still progresses
    const second = await db.transaction((tx) => syncContextGraphSource(tx as unknown as Db, { sourceId: src, actorUserId: uid.alice!, pageSize: 3, maxItems: 3 }));
    expect(second, JSON.stringify(second)).toMatchObject({ ok: true, more: true, created: { nodes: 3 } });
    const rest = await db.transaction((tx) => syncContextGraphSource(tx as unknown as Db, { sourceId: src, actorUserId: uid.alice!, pageSize: 3, maxItems: 3 }));
    expect(rest, JSON.stringify(rest)).toMatchObject({ ok: true, more: false, created: { nodes: 1 } });
    expect((await db.select().from(contextGraphNodes).where(eq(contextGraphNodes.sourceId, src))).length).toBe(8);
  });

  it("an unknown source is a 404", async () => {
    expect((await sync("00000000-0000-4000-8000-00000000e461")).statusCode).toBe(404);
  });
});

describe("ADR-0365 a user never sees a node they cannot access", () => {
  let projA: string;
  let projB: string;
  let src: string;
  let projectNode: string;
  let itemNodes: Record<string, string>;

  beforeAll(async () => {
    projA = await mkProject("read-a");
    projB = await mkProject("read-b");
    await member(projA, "alice"); // A only
    await member(projA, "carol"); // A and B
    await member(projB, "carol");
    // bob: no membership
    const conn = await mkConnection("read");
    await importItems(conn, ["R-1", "R-2", "R-3"]);
    src = (await bind(conn, projA)).json().id as string;
    expect((await sync(src)).statusCode).toBe(200);
    const nodes = await db
      .select({ id: contextGraphNodes.id, kind: contextGraphNodes.kind, ext: pmImportedWorkItems.externalId })
      .from(contextGraphNodes)
      .leftJoin(pmImportedWorkItems, eq(pmImportedWorkItems.id, contextGraphNodes.pmImportedWorkItemId))
      .where(eq(contextGraphNodes.sourceId, src));
    projectNode = nodes.find((n) => n.kind === "pm_project")!.id;
    itemNodes = Object.fromEntries(nodes.filter((n) => n.ext).map((n) => [n.ext!, n.id]));
    // R-2 also needs project B (conjunctive); R-3 loses every scope (fail closed)
    await db.insert(contextGraphNodeScopes).values({ nodeId: itemNodes["R-2"]!, projectId: projB });
    await db.delete(contextGraphNodeScopes).where(eq(contextGraphNodeScopes.nodeId, itemNodes["R-3"]!));
  });

  const mine = async (who: string) => (await nodesAs(who, `&sourceId=${src}`)).map((n) => n.label).sort();

  it("lists only readable nodes, with joined facts and nothing PM-authoritative", async () => {
    expect(await mine("alice")).toEqual(["PM-read", "R-1"]);
    expect(await mine("carol")).toEqual(["PM-read", "R-1", "R-2"]);
    expect(await mine("bob")).toEqual([]);
    const r1 = (await nodesAs("alice", `&sourceId=${src}&kind=pm_work_item`))[0]!;
    expect(Object.keys(r1).sort()).toEqual(["createdAt", "externalUrl", "id", "itemType", "kind", "label", "missing", "provider", "sourceId"]);
    expect(r1).toMatchObject({ label: "R-1", externalUrl: "https://pm.example/R-1", missing: false });
    // an admin reads every node, the scope-less one included
    const adm = await app.inject({ method: "GET", url: `/v1/context-graph/nodes?sourceId=${src}&limit=200`, headers: AUTH });
    expect((adm.json().items as { label: string }[]).map((n) => n.label).sort()).toEqual(["PM-read", "R-1", "R-2", "R-3"]);
  });

  it("a node the caller cannot read is a 404, exactly like a missing one", async () => {
    for (const [who, ext] of [["alice", "R-2"], ["alice", "R-3"], ["carol", "R-3"], ["bob", "R-1"]] as const) {
      const one = await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${itemNodes[ext]}`, headers: key[who]! });
      expect([who, ext, one.statusCode]).toEqual([who, ext, 404]);
      const nb = await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${itemNodes[ext]}/neighbours`, headers: key[who]! });
      expect(nb.statusCode).toBe(404);
    }
    const missing = await app.inject({ method: "GET", url: "/v1/context-graph/nodes/00000000-0000-4000-8000-00000000e462", headers: key.alice! });
    expect([missing.statusCode, missing.json()]).toEqual([404, { error: "node_not_found", detail: "no such node" }]);
    expect((await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${itemNodes["R-1"]}`, headers: key.alice! })).statusCode).toBe(200);
  });

  it("a neighbourhood holds only readable nodes and edges whose two ends are readable", async () => {
    const view = async (who: string, depth = 1, start = projectNode) => {
      const r = await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${start}/neighbours?depth=${depth}`, headers: key[who]! });
      expect(r.statusCode, r.body).toBe(200);
      const j = r.json() as { nodes: { id: string; label: string }[]; edges: { fromNodeId: string; toNodeId: string }[] };
      return { labels: j.nodes.map((n) => n.label).sort(), edgeTargets: j.edges.map((e) => e.toNodeId).sort() };
    };
    expect(await view("alice")).toEqual({ labels: ["R-1"], edgeTargets: [itemNodes["R-1"]] });
    expect(await view("carol")).toEqual({ labels: ["R-1", "R-2"], edgeTargets: [itemNodes["R-1"], itemNodes["R-2"]].sort() });
    // depth 2 from an item walks back through the project node, never through a hidden node
    expect((await view("alice", 2, itemNodes["R-1"]!)).labels).toEqual(["PM-read"]);
    expect((await view("carol", 2, itemNodes["R-1"]!)).labels).toEqual(["PM-read", "R-2"]);
    const bad = await app.inject({ method: "GET", url: `/v1/context-graph/nodes/${projectNode}/neighbours?depth=3`, headers: key.alice! });
    expect(bad.statusCode).toBe(400);
  });

  it("a non-admin cannot list, rebind, unbind or sync sources", async () => {
    for (const [method, url] of [
      ["GET", "/v1/context-graph/sources"],
      ["PATCH", `/v1/context-graph/sources/${src}`],
      ["DELETE", `/v1/context-graph/sources/${src}`],
      ["POST", `/v1/context-graph/sources/${src}/sync`],
    ] as const) {
      const r = await app.inject({ method, url, headers: key.carol!, payload: method === "PATCH" ? { projectId: projB } : method === "POST" ? {} : undefined });
      expect([method, url, r.statusCode]).toEqual([method, url, 403]);
    }
  });
});

describe("ADR-0365 rebinding, missing items and unbinding", () => {
  it("rebinding re-scopes at once; a missing item reads missing from the join; unbinding removes the nodes", async () => {
    const projOld = await mkProject("old");
    const projNew = await mkProject("new");
    await member(projOld, "alice");
    await member(projNew, "bob");
    const conn = await mkConnection("move");
    const [itemId] = await importItems(conn, ["M-1"]);
    const src = (await bind(conn, projOld)).json().id as string;
    await sync(src);
    const labels = async (who: string) => (await nodesAs(who, `&sourceId=${src}`)).map((n) => n.label).sort();
    expect([await labels("alice"), await labels("bob")]).toEqual([["M-1", "PM-move"], []]);

    await db.update(pmImportedWorkItems).set({ missingSince: new Date() }).where(eq(pmImportedWorkItems.id, itemId!));
    expect((await nodesAs("alice", `&sourceId=${src}&kind=pm_work_item`))[0]!.missing).toBe(true);

    const moved = await app.inject({ method: "PATCH", url: `/v1/context-graph/sources/${src}`, headers: AUTH, payload: { projectId: projNew } });
    expect(moved.statusCode, moved.body).toBe(200);
    expect([await labels("alice"), await labels("bob")]).toEqual([[], ["M-1", "PM-move"]]);
    const scopes = await db
      .select({ projectId: contextGraphNodeScopes.projectId })
      .from(contextGraphNodeScopes)
      .innerJoin(contextGraphNodes, eq(contextGraphNodes.id, contextGraphNodeScopes.nodeId))
      .where(eq(contextGraphNodes.sourceId, src));
    expect(new Set(scopes.map((s) => s.projectId))).toEqual(new Set([projNew]));

    const gone = await app.inject({ method: "DELETE", url: `/v1/context-graph/sources/${src}`, headers: AUTH });
    expect(gone.statusCode).toBe(204);
    expect(await db.select().from(contextGraphNodes).where(eq(contextGraphNodes.sourceId, src))).toEqual([]);
    expect((await db.execute<{ n: number }>(sql`select count(*)::int as n from context_graph_edges e where not exists (select 1 from context_graph_nodes n where n.id = e.from_node_id)`)).rows[0]!.n).toBe(0);
    expect(await auditRules(src)).toEqual(["context-graph-source-bound", "context-graph-synced", "context-graph-source-rebound", "context-graph-source-unbound"]);
    void contextGraphEdges;
  });
});
