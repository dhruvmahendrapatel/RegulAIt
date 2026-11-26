/**
 * ADR-0365 (lane E46): the context graph's row-level security, on a scratch database migrated to the head, with NO
 * application filter. These prove the policy alone keeps a user from a node they cannot access:
 *   - the four tables have row-level security ENABLED and FORCED;
 *   - a principal reads exactly the nodes whose every scope project they belong to (a node with no scope: none), and
 *     only edges whose two ends they may read; never a scope row, never a source;
 *   - a disabled member reads nothing; a non-admin principal writes nothing;
 *   - `context_graph_read` (a principal step) opens, for READ only, just the joined facts a node the principal may read
 *     refers to (its source, its PM connection, its imported item), never an unbound connection or an unreadable item,
 *     and does not widen the nodes or edges; an admin reaches every table;
 *   - the SQL registry of system reasons equals RLS_SYSTEM_REASONS.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  RLS_SYSTEM_REASONS,
  contextGraphEdges,
  contextGraphNodeUserScopes,
  orchestrationRuns,
  contextGraphNodeScopes,
  contextGraphNodes,
  contextGraphSources,
  createDb,
  eq,
  pmConnections,
  pmImportedWorkItems,
  projectMembers,
  projects,
  runMigrations,
  runWithRlsPrincipal,
  runWithRlsPrincipalStep,
  runWithRlsSystem,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const SCRATCH_DB = `rls0365cg_${process.pid}_${Date.now()}`;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};
const TABLES = ["context_graph_sources", "context_graph_nodes", "context_graph_edges", "context_graph_node_scopes"] as const;

let admin: Db;
let db: Db;
const id = {
  alice: randomUUID(), // member of A
  carol: randomUUID(), // member of A and B
  dave: randomUUID(), // member of A, disabled
  bob: randomUUID(), // no membership
  root: randomUUID(), // admin
  projA: randomUUID(),
  projB: randomUUID(),
  conn: randomUUID(),
  connUnbound: randomUUID(), // never bound to the graph
  iUnbound: randomUUID(),
  src: randomUUID(),
  pNode: randomUUID(),
  n1: randomUUID(), // scope A
  n2: randomUUID(), // scope A and B
  n3: randomUUID(), // no scope
  i1: randomUUID(),
  i2: randomUUID(),
  i3: randomUUID(),
};

async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as { message?: string; cause?: { message?: string } };
    return err.cause?.message ?? err.message ?? String(e);
  }
  return "(no error)";
}
const ids = async (table: string) =>
  (await db.execute<{ id: string }>(sql.raw(`select ${table === "context_graph_node_scopes" ? "node_id" : "id"}::text as id from ${table} order by 1`))).rows.map((r) => r.id);
const count = async (table: string) => (await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]!.n;
const as = <T>(who: string, fn: () => Promise<T>) => runWithRlsPrincipal({ userId: who }, fn);

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH_DB} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH_DB}`));
  db = createDb(urlFor(SCRATCH_DB));
  await runMigrations(db, migrationsFolder);
  // seeded outside any scope (the scratch login is the owner/superuser, as the migrator is)
  await db.insert(users).values([
    { id: id.alice, email: `alice-${id.alice}@rls.test`, displayName: "Alice" },
    { id: id.carol, email: `carol-${id.carol}@rls.test`, displayName: "Carol" },
    { id: id.dave, email: `dave-${id.dave}@rls.test`, displayName: "Dave", disabledAt: new Date() },
    { id: id.bob, email: `bob-${id.bob}@rls.test`, displayName: "Bob" },
    { id: id.root, email: `root-${id.root}@rls.test`, displayName: "Root", isAdmin: true },
  ]);
  await db.insert(projects).values([
    { id: id.projA, name: `cg-a-${id.projA}` },
    { id: id.projB, name: `cg-b-${id.projB}` },
  ]);
  await db.insert(projectMembers).values([
    { projectId: id.projA, userId: id.alice, role: "viewer" },
    { projectId: id.projA, userId: id.carol, role: "viewer" },
    { projectId: id.projB, userId: id.carol, role: "viewer" },
    { projectId: id.projA, userId: id.dave, role: "viewer" },
  ]);
  await db.insert(pmConnections).values([
    { id: id.conn, name: `cg-${id.conn}`, provider: "mock", project: "P", tokenCiphertext: "x" },
    { id: id.connUnbound, name: `cg-${id.connUnbound}`, provider: "mock", project: "Q", tokenCiphertext: "secret" },
  ]);
  await db.insert(pmImportedWorkItems).values([
    { id: id.i1, connectionId: id.conn, externalId: "1", externalUrl: "https://pm.example/1", itemType: "Task" },
    { id: id.i2, connectionId: id.conn, externalId: "2", externalUrl: "https://pm.example/2", itemType: "Task" },
    { id: id.i3, connectionId: id.conn, externalId: "3", externalUrl: "https://pm.example/3", itemType: "Task" },
    { id: id.iUnbound, connectionId: id.connUnbound, externalId: "9", externalUrl: "https://pm.example/9", itemType: "Task" },
  ]);
  await db.insert(contextGraphSources).values({ id: id.src, pmConnectionId: id.conn, projectId: id.projA });
  await db.insert(contextGraphNodes).values([
    { id: id.pNode, sourceId: id.src, kind: "pm_project" },
    { id: id.n1, sourceId: id.src, kind: "pm_work_item", pmImportedWorkItemId: id.i1 },
    { id: id.n2, sourceId: id.src, kind: "pm_work_item", pmImportedWorkItemId: id.i2 },
    { id: id.n3, sourceId: id.src, kind: "pm_work_item", pmImportedWorkItemId: id.i3 },
  ]);
  await db.insert(contextGraphNodeScopes).values([
    { nodeId: id.pNode, projectId: id.projA },
    { nodeId: id.n1, projectId: id.projA },
    { nodeId: id.n2, projectId: id.projA },
    { nodeId: id.n2, projectId: id.projB },
  ]);
  await db.insert(contextGraphEdges).values([
    { fromNodeId: id.pNode, toNodeId: id.n1, kind: "contains" },
    { fromNodeId: id.pNode, toNodeId: id.n2, kind: "contains" },
    { fromNodeId: id.pNode, toNodeId: id.n3, kind: "contains" },
  ]);
}, 180_000);

afterAll(async () => {
  await db?.$client.end().catch(() => undefined);
  if (admin) {
    await dropScratchDatabase(admin, SCRATCH_DB);
    await admin.$client.end().catch(() => undefined);
  }
});

describe("ADR-0365 the context graph is under forced row-level security", () => {
  it("every context graph table has row-level security ENABLED and FORCED", async () => {
    const r = await db.execute<{ relname: string; on: boolean; forced: boolean }>(sql`
      select relname, relrowsecurity as on, relforcerowsecurity as forced from pg_class
      where relname in ('context_graph_sources', 'context_graph_nodes', 'context_graph_edges', 'context_graph_node_scopes') order by relname`);
    expect(r.rows).toEqual([...TABLES].sort().map((relname) => ({ relname, on: true, forced: true })));
  });

  it("the SQL registry of system reasons equals RLS_SYSTEM_REASONS", async () => {
    for (const reason of RLS_SYSTEM_REASONS) {
      const r = await db.execute<{ r: string }>(sql`select set_config('regulait.system_context', ${reason}, true), regulait_rls_system_reason() as r`);
      expect(r.rows[0]!.r).toBe(reason);
    }
    expect(await pgError(db.execute(sql`select set_config('regulait.system_context', 'context_graph_write', true), regulait_rls_system_reason()`))).toMatch(/unknown row-level security system context/);
  });

  it("a principal reads exactly the nodes whose every scope it belongs to, and only edges between them", async () => {
    const edgeTargets = async () => (await db.select({ to: contextGraphEdges.toNodeId }).from(contextGraphEdges)).map((e) => e.to).sort();
    expect(await as(id.alice, () => ids("context_graph_nodes"))).toEqual([id.pNode, id.n1].sort());
    expect(await as(id.alice, edgeTargets)).toEqual([id.n1]);
    expect(await as(id.carol, () => ids("context_graph_nodes"))).toEqual([id.pNode, id.n1, id.n2].sort());
    expect(await as(id.carol, edgeTargets)).toEqual([id.n1, id.n2].sort());
    for (const who of [id.bob, id.dave]) {
      expect(await as(who, () => ids("context_graph_nodes"))).toEqual([]);
      expect(await as(who, () => count("context_graph_edges"))).toBe(0);
    }
    // never a scope row or a source, and nothing of the PM linkage without the read step
    for (const t of ["context_graph_node_scopes", "context_graph_sources", "pm_connections", "pm_imported_work_items"]) {
      expect([t, await as(id.carol, () => count(t))]).toEqual([t, 0]);
    }
  });

  it("a non-admin principal writes nothing in any context graph table", async () => {
    const tries: [string, () => Promise<unknown>][] = [
      ["source", () => db.insert(contextGraphSources).values({ pmConnectionId: id.conn, projectId: id.projB })],
      ["node", () => db.insert(contextGraphNodes).values({ sourceId: id.src, kind: "pm_project" })],
      ["scope", () => db.insert(contextGraphNodeScopes).values({ nodeId: id.n3, projectId: id.projA })],
      ["edge", () => db.insert(contextGraphEdges).values({ fromNodeId: id.n1, toNodeId: id.n2, kind: "contains" })],
    ];
    for (const [label, run] of tries) expect([label, await as(id.carol, () => pgError(run()))]).toEqual([label, expect.stringMatching(/row-level security/)]);
    // updates and deletes match no row
    const del = await as(id.carol, () => db.delete(contextGraphNodes).where(eq(contextGraphNodes.id, id.n1)).returning());
    expect(del).toEqual([]);
    expect(await count("context_graph_nodes")).toBe(4);
  });

  it("context_graph_read opens only the joined facts a readable node refers to, for READ only, and does not widen nodes or edges", async () => {
    const step = <T>(who: string, fn: () => Promise<T>) => runWithRlsPrincipalStep({ userId: who }, "context_graph_read", "test/context-graph", fn);
    const rows = async (t: string, col: string) => (await db.execute<{ v: string }>(sql.raw(`select ${col}::text as v from ${t} order by 1`))).rows.map((r) => r.v);
    expect(await step(id.alice, () => ids("context_graph_nodes"))).toEqual([id.pNode, id.n1].sort());
    expect(await step(id.alice, () => count("context_graph_edges"))).toBe(1);
    // scope rows of the principal's own projects only (alice: A), never n2's project-B row
    expect(await step(id.alice, () => rows("context_graph_node_scopes", "project_id"))).toEqual([id.projA, id.projA, id.projA]);
    expect(await step(id.alice, () => count("context_graph_sources"))).toBe(1);
    // security review S4 finding 1: the bound connection only (never the unbound one or its ciphertext), and only the
    // imported items a readable node refers to
    expect(await step(id.alice, () => rows("pm_connections", "id"))).toEqual([id.conn]);
    expect(await step(id.alice, () => rows("pm_imported_work_items", "id"))).toEqual([id.i1]);
    expect(await step(id.carol, () => rows("pm_imported_work_items", "id"))).toEqual([id.i1, id.i2].sort());
    for (const t of ["context_graph_sources", "pm_connections", "pm_imported_work_items", "context_graph_node_scopes"]) {
      expect([t, await step(id.bob, () => count(t))]).toEqual([t, 0]);
      expect([t, await step(id.dave, () => count(t))]).toEqual([t, 0]);
    }
    expect(await step(id.bob, () => ids("context_graph_nodes"))).toEqual([]);
    expect(await step(id.alice, () => pgError(db.update(pmImportedWorkItems).set({ itemType: "Bug" }).where(eq(pmImportedWorkItems.id, id.i1)).returning().then((r) => {
      if (r.length) throw new Error("updated a row under context_graph_read");
    })))).toBe("(no error)");
    expect(await step(id.alice, () => pgError(db.insert(contextGraphSources).values({ pmConnectionId: id.conn, projectId: id.projB })))).toMatch(/row-level security/);
    const [i1] = await db.select({ t: pmImportedWorkItems.itemType }).from(pmImportedWorkItems).where(eq(pmImportedWorkItems.id, id.i1));
    expect(i1!.t).toBe("Task");
  });

  it("an admin principal reaches every context graph table", async () => {
    for (const t of TABLES) expect([t, await as(id.root, () => count(t))]).toEqual([t, { context_graph_sources: 1, context_graph_nodes: 4, context_graph_edges: 3, context_graph_node_scopes: 4 }[t]]);
  });
});

describe("ADR-0365 slice 2: run nodes, user scopes and the scheduler's system_task", () => {
  const run = randomUUID();
  const rNode = randomUUID();
  beforeAll(async () => {
    // alice's run, linked from n1 (scope A) by a tracks edge; the run node carries scope A and the user scope alice
    await db.insert(orchestrationRuns).values({ id: run, name: "alice run", initiatingUserId: id.alice, graph: { nodes: [] }, state: { nodeStatuses: {} } } as typeof orchestrationRuns.$inferInsert);
    await db.insert(contextGraphNodes).values({ id: rNode, sourceId: id.src, kind: "orchestration_run", orchestrationRunId: run });
    await db.insert(contextGraphNodeScopes).values({ nodeId: rNode, projectId: id.projA });
    await db.insert(contextGraphNodeUserScopes).values({ nodeId: rNode, userId: id.alice });
    await db.insert(contextGraphEdges).values({ fromNodeId: id.n1, toNodeId: rNode, kind: "tracks" });
  });

  it("the user-scope table has row-level security ENABLED and FORCED", async () => {
    const r = await db.execute<{ on: boolean; forced: boolean }>(sql`
      select relrowsecurity as on, relforcerowsecurity as forced from pg_class where relname = 'context_graph_node_user_scopes'`);
    expect(r.rows).toEqual([{ on: true, forced: true }]);
  });

  it("a run node is read by its initiator only: another member of every scope project sees neither it nor its edge", async () => {
    const tracks = async () => (await db.select({ id: contextGraphEdges.id }).from(contextGraphEdges).where(eq(contextGraphEdges.kind, "tracks"))).length;
    expect(await as(id.alice, () => ids("context_graph_nodes"))).toContain(rNode);
    expect(await as(id.alice, tracks)).toBe(1);
    expect(await as(id.carol, () => ids("context_graph_nodes"))).not.toContain(rNode);
    expect(await as(id.carol, tracks)).toBe(0);
    expect(await as(id.carol, () => count("context_graph_node_user_scopes"))).toBe(0);
    expect(await as(id.root, () => ids("context_graph_nodes"))).toContain(rNode);
  });

  it("system_task (the scheduled sync) writes the graph tables and only reads the imported items", async () => {
    await runWithRlsSystem("system_task", "test.context-graph-sync", async () => {
      expect(await count("context_graph_nodes")).toBe(5);
      expect(await count("pm_imported_work_items")).toBe(4);
      const [n] = await db.insert(contextGraphNodes).values({ sourceId: id.src, kind: "pm_work_item", pmImportedWorkItemId: id.iUnbound }).returning({ id: contextGraphNodes.id });
      await db.insert(contextGraphNodeScopes).values({ nodeId: n!.id, projectId: id.projA });
      await db.insert(contextGraphNodeUserScopes).values({ nodeId: n!.id, userId: id.alice });
      await db.delete(contextGraphNodes).where(eq(contextGraphNodes.id, n!.id));
      const upd = await db.update(pmImportedWorkItems).set({ itemType: "Bug" }).where(eq(pmImportedWorkItems.id, id.i1)).returning({ id: pmImportedWorkItems.id });
      expect(upd).toEqual([]);
      expect(await pgError(db.insert(pmImportedWorkItems).values({ connectionId: id.conn, externalId: "x", externalUrl: "u", itemType: "T" }))).toMatch(/row-level security/);
    });
  });

  it("a request reason (context_graph_read) never writes the user scopes", async () => {
    await runWithRlsPrincipalStep({ userId: id.alice }, "context_graph_read", "test/context-graph", async () => {
      expect(await pgError(db.insert(contextGraphNodeUserScopes).values({ nodeId: id.n1, userId: id.alice }))).toMatch(/row-level security/);
    });
  });
});
