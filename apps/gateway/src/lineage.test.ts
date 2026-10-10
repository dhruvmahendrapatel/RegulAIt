import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectsWithGrants } from "./testing/agent-own-grants.js";
import { autoGrantCreatedAgentsForTest } from "./testing/agent-own-grants.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  createDb,
  eq,
  inArray,
  lineageEdges,
  lineageNodes,
  projects,
  runMigrations,
  type Db,
} from "@regulait/db";
import { lineageNaturalKey } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

/**
 * ADR-0050 — the DATA-LINEAGE / PROVENANCE GRAPH, proved by attack.
 *
 * The scenario is the ADR's own cross-run chain, built entirely through REAL
 * governed endpoints — no direct row inserts anywhere, because a graph that
 * only exists when a test writes it is not a capture mechanism:
 *
 *   1. run A dispatches node `a`, which is SUPPLIED the shared-context item
 *      `spec` v1 (a real `POST /v1/projects/:id/context` write).
 *   2. run A's node writes its finding back as `findings` v1, declaring the
 *      run that produced it.
 *   3. run B dispatches node `b`, SUPPLIED `findings` v1.
 *   4. a human revises `findings` to v2 on top of v1.
 *
 * The assertions then answer the question the ADR exists for — "where did this
 * output's inputs come from" — by TRAVERSING, not by re-reading what the test
 * wrote.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. A GRAPH THAT ONLY DESCRIBES ITSELF. Every node and edge below is created
 *     as a side effect of a governed context write or a governed dispatch.
 *     Nothing in this file inserts a lineage row.
 *  2. LINEAGE RECORDING AN INPUT THE WORKER NEVER RECEIVED. The supplied
 *     context is asserted to appear in the worker's ACTUAL OUTPUT (the mock
 *     model echoes what it was given), and the same list is what produced the
 *     `flowed_into` edge. If capture ever drifted from injection, one of those
 *     two assertions fails.
 *  3. LINEAGE AS AN ENTITLEMENT SIDE CHANNEL. An outsider must not see another
 *     project's node — not its content, not its label, NOT ITS ID, and not the
 *     fact that it exists. The 404 for an invisible node is asserted to be
 *     byte-identical to the 404 for a nonexistent one.
 *  4. A TRAVERSAL THAT RUNS AWAY. A cycle is built through the real API (a
 *     context revision produced by a run that consumed an earlier revision of
 *     the same key) and the traversal is asserted to terminate.
 *
 * SHARED-STATE DISCIPLINE: everything is `lin-` prefixed and `afterAll` deletes
 * the projects it created — lineage nodes and edges cascade with them.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "lin-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let ownerId: string;
let ownerAuth: { authorization: string };
let outsiderId: string;
let outsiderAuth: { authorization: string };
let approverId: string;
let approverAuth: { authorization: string };
let workerAgentId: string;
let projectId: string;
let secretProjectId: string;
let runAId: string;
let runBId: string;

async function mkUser(email: string) {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0]! },
  });
  expect(r.statusCode).toBe(201);
  const id = r.json().id as string;
  const k = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${id}/keys`,
    payload: { name: "lin" },
  });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

const mkNode = (id: string, agentId: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `task ${id}`,
  ownerAgentId: agentId,
  mode: "execute",
  estimate: { in: 1, out: 1 },
  ...extra,
});

/** create a run, start it, start the node, dispatch it — the manual path, so
 * `contextKeys` can be supplied explicitly */
async function runOneNode(
  name: string,
  nodeId: string,
  body: Record<string, unknown>,
): Promise<{ runId: string; outputText: string }> {
  const created = await app.inject({
    method: "POST",
    headers: ownerAuth,
    url: "/v1/runs",
    payload: {
      projectId,
      graph: { run: name, escalationApproverUserId: approverId, nodes: [mkNode(nodeId, workerAgentId)] },
    },
  });
  expect(created.statusCode, `create ${name}`).toBe(201);
  const runId = created.json().id as string;
  await app.inject({ method: "POST", headers: ownerAuth, url: `/v1/runs/${runId}/events`, payload: { kind: "start" } });
  await app.inject({
    method: "POST",
    headers: ownerAuth,
    url: `/v1/runs/${runId}/events`,
    payload: { kind: "node_started", nodeId },
  });
  const res = await app.inject({
    method: "POST",
    headers: ownerAuth,
    url: `/v1/runs/${runId}/nodes/${nodeId}/dispatch`,
    payload: body,
  });
  expect(res.statusCode, `dispatch ${name}`).toBe(200);
  return { runId, outputText: res.json().dispatch.outputText as string };
}

async function writeContext(
  pid: string,
  payload: Record<string, unknown>,
  auth = ownerAuth,
): Promise<Record<string, unknown>> {
  const res = await app.inject({ method: "POST", headers: auth, url: `/v1/projects/${pid}/context`, payload });
  expect(res.statusCode, `context write ${JSON.stringify(payload.key)}`).toBe(201);
  return res.json();
}

/** resolve a node id from its DERIVED natural key — the same derivation the
 * gateway used, so a fork in the graph would show up as a missing node here */
async function nodeIdFor(pid: string, key: string): Promise<string> {
  const [row] = await db
    .select({ id: lineageNodes.id })
    .from(lineageNodes)
    .where(and(eq(lineageNodes.projectId, pid), eq(lineageNodes.naturalKey, key)));
  expect(row, `no lineage node for ${key}`).toBeTruthy();
  return row!.id;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  // ADR-0188 S4: agents created here act under the strict `own_grants` default with grants of their own
  autoGrantCreatedAgentsForTest(app, db, { mirrorTools: true });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });

  const o = await mkUser("lin-owner@example.com");
  ownerId = o.id;
  ownerAuth = o.auth;
  const x = await mkUser("lin-outsider@example.com");
  outsiderId = x.id;
  outsiderAuth = x.auth;
  const ap = await mkUser("lin-approver@example.com");
  approverId = ap.id;
  approverAuth = ap.auth;

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: {
      name: "lin-worker",
      provider: "mock",
      tier: 0,
      modes: ["execute"],
      costPerMTokIn: 1,
      costPerMTokOut: 5,
      model: "mock-worker",
    },
  });
  workerAgentId = agent.json().id;
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/grants/agents",
    payload: { userId: ownerId, agentId: workerAgentId },
  });

  for (const name of ["lin-shared", "lin-secret"]) {
    const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name } });
    expect(p.statusCode).toBe(201);
    if (name === "lin-shared") projectId = p.json().id;
    else secretProjectId = p.json().id;
  }
  // the owner is on the shared project ONLY; the outsider is on NEITHER
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/projects/${projectId}/members`,
    payload: { userId: ownerId, role: "owner" },
  });
  // the secret project has a member who is neither the owner nor the outsider,
  // so it is genuinely invisible to both non-admin callers
  await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/projects/${secretProjectId}/members`,
    payload: { userId: approverId, role: "owner" },
  });

  // ---- 1. the seed source: `spec` v1 -------------------------------------
  await writeContext(projectId, { key: "spec", content: "SPEC-ALPHA: the widget must be blue." });

  // ---- 2. run A consumes `spec` v1 ---------------------------------------
  const a = await runOneNode("lin-run-a", "a", {
    input: "summarise the supplied spec",
    contextKeys: ["spec"],
  });
  runAId = a.runId;
  // THE CAPTURE-MATCHES-INJECTION CHECK: the worker echoes the first line of
  // the system prompt it was actually given, and that line is the supplied-item
  // MANIFEST — the same list the `flowed_into` edges are built from. So the
  // exact key AND VERSION lineage will claim was supplied is observable in the
  // real dispatch output. If injection and capture ever diverged, this fails
  // before any graph assertion does.
  expect(a.outputText).toContain("spec v1");

  // ---- 3. run A's finding is written back, DECLARING the producing run ----
  await writeContext(projectId, {
    key: "findings",
    content: "FINDINGS-1: blue confirmed.",
    producedByRunId: runAId,
    producedByNodeId: "a",
  });

  // ---- 4. run B consumes `findings` v1 -----------------------------------
  const b = await runOneNode("lin-run-b", "b", {
    input: "act on the supplied findings",
    contextKeys: ["findings"],
  });
  runBId = b.runId;
  expect(b.outputText).toContain("findings v1");

  // ---- 5. a human revises findings to v2, on top of v1 --------------------
  await writeContext(projectId, {
    key: "findings",
    content: "FINDINGS-2: blue confirmed, and round.",
    baseRevision: 1,
  });

  // ---- a node in the SECRET project the outsider must never learn about ---
  // written by the secret project's OWN member (the bootstrap token has no
  // identity and cannot contribute context, by design)
  await writeContext(
    secretProjectId,
    { key: "lin-classified", content: "CLASSIFIED-PAYLOAD" },
    approverAuth,
  );
});

afterAll(async () => {
  app.server.closeAllConnections();
  await restoreSb2Gates();
  await app.close();
  // lineage nodes/edges cascade with the project
  // ADR-0188 S4: a project an agent acted in is named by never-deleted delegation grants; it stays
  const held = await projectsWithGrants(db, [projectId, secretProjectId].filter(Boolean));
  const ids = [projectId, secretProjectId].filter((id) => id && !held.has(id));
  if (ids.length) await db.delete(projects).where(inArray(projects.id, ids));
});

// ---------------------------------------------------------------------------

describe("ADR-0050 — capture rides the paths that already exist", () => {
  it("a governed context write becomes a versioned lineage node, not a parallel record", async () => {
    const specV1 = await nodeIdFor(projectId, lineageNaturalKey({ subtype: "context_item", refKey: "spec", version: 1 }));
    const [row] = await db.select().from(lineageNodes).where(eq(lineageNodes.id, specV1));
    expect(row!.kind).toBe("source");
    expect(row!.subtype).toBe("context_item");
    expect(row!.refKey).toBe("spec");
    expect(row!.version).toBe(1);
    // METADATA BY DEFAULT (GOVERNANCE §8.4): the content is NOT copied in
    expect(row!.contentRecorded).toBe(false);
    expect(row!.content).toBeNull();
  });

  it("a revision chains to its predecessor, stored in the direction data flows", async () => {
    const v1 = await nodeIdFor(projectId, lineageNaturalKey({ subtype: "context_item", refKey: "findings", version: 1 }));
    const v2 = await nodeIdFor(projectId, lineageNaturalKey({ subtype: "context_item", refKey: "findings", version: 2 }));
    const [edge] = await db
      .select()
      .from(lineageEdges)
      .where(and(eq(lineageEdges.fromNodeId, v1), eq(lineageEdges.toNodeId, v2)));
    expect(edge!.kind).toBe("derived_from");
  });

  it("a dispatch produces a run node, its supplied inputs and its output", async () => {
    const runNode = await nodeIdFor(projectId, lineageNaturalKey({ subtype: "run_node", refId: runAId, refKey: "a" }));
    const edges = await db.select().from(lineageEdges).where(eq(lineageEdges.runId, runAId));
    expect(edges.some((e) => e.kind === "flowed_into" && e.toNodeId === runNode)).toBe(true);
    expect(edges.some((e) => e.kind === "produced" && e.fromNodeId === runNode)).toBe(true);
  });

  it("is idempotent: re-dispatching the same node does not multiply edges", async () => {
    const before = await db.select().from(lineageEdges).where(eq(lineageEdges.runId, runAId));
    const res = await app.inject({
      method: "POST",
      headers: ownerAuth,
      url: `/v1/runs/${runAId}/nodes/a/dispatch`,
      payload: { input: "again", contextKeys: ["spec"] },
    });
    expect(res.statusCode).toBe(200);
    const after = await db.select().from(lineageEdges).where(eq(lineageEdges.runId, runAId));
    expect(after.length).toBe(before.length);
  });
});

describe("ADR-0050 — a real query answers 'where did this output's inputs come from'", () => {
  it("the per-run view returns the ACTUAL supplied inputs and produced outputs", async () => {
    const res = await app.inject({ method: "GET", headers: ownerAuth, url: `/v1/lineage/runs/${runBId}` });
    expect(res.statusCode).toBe(200);
    const [dispatch] = res.json().dispatches;
    expect(dispatch.node.refKey).toBe("b");
    // exactly the context item that was supplied — at the version supplied,
    // NOT the later v2 that exists by the time this query runs
    expect(dispatch.suppliedInputs).toHaveLength(1);
    expect(dispatch.suppliedInputs[0].refKey).toBe("findings");
    expect(dispatch.suppliedInputs[0].version).toBe(1);
    expect(dispatch.producedOutputs).toHaveLength(1);
    expect(dispatch.producedOutputs[0].subtype).toBe("dispatch_output");
    expect(res.json().note).toMatch(/SUPPLIED-INPUTS PROVENANCE, not intra-model attribution/);
  });

  it("a BACKWARD traversal from run B's output reaches run A and the original spec", async () => {
    const outB = lineageNaturalKey({ subtype: "dispatch_output", refId: runBId, refKey: "b" });
    const res = await app.inject({
      method: "GET",
      headers: ownerAuth,
      url: `/v1/lineage?projectId=${projectId}&naturalKey=${encodeURIComponent(outB)}&direction=backward&maxDepth=8`,
    });
    expect(res.statusCode).toBe(200);
    const keys = (res.json().nodes as Array<{ naturalKey: string }>).map((n) => n.naturalKey);
    // the whole chain, walked — not re-read from what the test wrote
    expect(keys).toContain(lineageNaturalKey({ subtype: "run_node", refId: runBId, refKey: "b" }));
    expect(keys).toContain(lineageNaturalKey({ subtype: "context_item", refKey: "findings", version: 1 }));
    expect(keys).toContain(lineageNaturalKey({ subtype: "run_node", refId: runAId, refKey: "a" }));
    expect(keys).toContain(lineageNaturalKey({ subtype: "context_item", refKey: "spec", version: 1 }));
    expect(res.json().truncated).toBe(false);
    expect(res.json().withheldEdges).toBe(0);
    expect(res.json().note).toMatch(/gateway visibility/);
  });

  it("a FORWARD traversal from the original spec reaches everything it eventually fed", async () => {
    const specV1 = lineageNaturalKey({ subtype: "context_item", refKey: "spec", version: 1 });
    const res = await app.inject({
      method: "GET",
      headers: ownerAuth,
      url: `/v1/lineage?projectId=${projectId}&naturalKey=${encodeURIComponent(specV1)}&direction=forward&maxDepth=8`,
    });
    const keys = (res.json().nodes as Array<{ naturalKey: string }>).map((n) => n.naturalKey);
    expect(keys).toContain(lineageNaturalKey({ subtype: "run_node", refId: runAId, refKey: "a" }));
    expect(keys).toContain(lineageNaturalKey({ subtype: "context_item", refKey: "findings", version: 1 }));
    // ...and onward through the version chain into run B's dispatch
    expect(keys).toContain(lineageNaturalKey({ subtype: "run_node", refId: runBId, refKey: "b" }));
  });

  it("a bounded traversal SAYS the answer is partial rather than implying completeness", async () => {
    const outB = lineageNaturalKey({ subtype: "dispatch_output", refId: runBId, refKey: "b" });
    const res = await app.inject({
      method: "GET",
      headers: ownerAuth,
      url: `/v1/lineage?projectId=${projectId}&naturalKey=${encodeURIComponent(outB)}&direction=backward&maxDepth=1`,
    });
    expect(res.json().truncated).toBe(true);
    expect(res.json().nodes).toHaveLength(2); // the output and its run, nothing more
  });
});

describe("ADR-0050 — cycles and deep chains terminate against the real store", () => {
  it("a context revision produced by a run that consumed an earlier revision does not loop", async () => {
    // build the cycle THROUGH THE API: run C consumes `findings` v2 and writes
    // `findings` v3, so run C is both downstream and upstream of the same key.
    const c = await runOneNode("lin-run-c", "c", { input: "revise", contextKeys: ["findings"] });
    await writeContext(projectId, {
      key: "findings",
      content: "FINDINGS-3: revised by the run that read v2.",
      baseRevision: 2,
      producedByRunId: c.runId,
      producedByNodeId: "c",
    });

    const v2 = lineageNaturalKey({ subtype: "context_item", refKey: "findings", version: 2 });
    const res = await app.inject({
      method: "GET",
      headers: ownerAuth,
      url: `/v1/lineage?projectId=${projectId}&naturalKey=${encodeURIComponent(v2)}&direction=both&maxDepth=12`,
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().nodes as Array<{ id: string }>).map((n) => n.id);
    // terminates, and visits every node exactly once
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(3);
  });
});

describe("ADR-0050 — lineage never reveals context the caller cannot access", () => {
  it("an outsider cannot list another project's lineage nodes", async () => {
    const res = await app.inject({ method: "GET", headers: outsiderAuth, url: "/v1/lineage/nodes" });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes).toEqual([]);
  });

  it("an invisible node 404s IDENTICALLY to a nonexistent one — existence is itself the disclosure", async () => {
    const classified = lineageNaturalKey({ subtype: "context_item", refKey: "lin-classified", version: 1 });
    const real = await app.inject({
      method: "GET",
      headers: outsiderAuth,
      url: `/v1/lineage?projectId=${secretProjectId}&naturalKey=${encodeURIComponent(classified)}&direction=both`,
    });
    const fictional = await app.inject({
      method: "GET",
      headers: outsiderAuth,
      url: `/v1/lineage?projectId=${secretProjectId}&naturalKey=${encodeURIComponent("context_item:does-not-exist:v1")}&direction=both`,
    });
    expect(real.statusCode).toBe(404);
    expect(fictional.statusCode).toBe(404);
    expect(real.body).toBe(fictional.body);
    // and the classified node really does exist — the 404 is a refusal, not an absence
    const [row] = await db
      .select()
      .from(lineageNodes)
      .where(and(eq(lineageNodes.projectId, secretProjectId), eq(lineageNodes.naturalKey, classified)));
    expect(row).toBeTruthy();
  });

  it("an outsider's per-run lineage query for a run in a project they are not on 404s", async () => {
    const res = await app.inject({ method: "GET", headers: outsiderAuth, url: `/v1/lineage/runs/${runBId}` });
    expect(res.statusCode).toBe(404);
  });

  it("no id, label or content of an invisible node appears ANYWHERE in an outsider's payloads", async () => {
    const classified = lineageNaturalKey({ subtype: "context_item", refKey: "lin-classified", version: 1 });
    const [secret] = await db
      .select()
      .from(lineageNodes)
      .where(and(eq(lineageNodes.projectId, secretProjectId), eq(lineageNodes.naturalKey, classified)));
    for (const url of [
      "/v1/lineage/nodes",
      `/v1/lineage/nodes?projectId=${secretProjectId}`,
      `/v1/lineage/runs/${runAId}`,
    ]) {
      const res = await app.inject({ method: "GET", headers: outsiderAuth, url });
      expect(res.body, url).not.toContain(secret!.id);
      expect(res.body, url).not.toContain("lin-classified");
      expect(res.body, url).not.toContain("CLASSIFIED-PAYLOAD");
    }
  });

  it("the org-wide census is ADMIN-ONLY — a per-project provenance volume is not public", async () => {
    const asOutsider = await app.inject({ method: "GET", headers: outsiderAuth, url: "/v1/lineage/overview" });
    expect(asOutsider.statusCode).toBe(403);
    const asAdmin = await app.inject({ method: "GET", headers: AUTH, url: "/v1/lineage/overview" });
    expect(asAdmin.statusCode).toBe(200);
    expect(asAdmin.json().contentLevelLineageEnabled).toBe(false);
    expect(asAdmin.json().captureNote).toMatch(/produce no lineage today/);
  });

  it("audits a refused traversal with a stable ruleId", async () => {
    const rows = await db
      .select()
      .from(lineageNodes)
      .where(eq(lineageNodes.projectId, secretProjectId));
    expect(rows.length).toBeGreaterThan(0);
    const audit = await app.inject({
      method: "GET",
      headers: AUTH,
      url: `/v1/audit?userId=${outsiderId}`,
    });
    const denied = (audit.json().entries as Array<{ ruleId: string; effect: string }>).filter(
      (e) => e.ruleId === "lineage-node-not-visible",
    );
    expect(denied.length).toBeGreaterThan(0);
    expect(denied.every((d) => d.effect === "deny")).toBe(true);
  });
});

describe("ADR-0050 — a dispatch with no declared context is unchanged", () => {
  it("supplies nothing, records no flowed_into edge, and still produces an output", async () => {
    const d = await runOneNode("lin-run-plain", "p", { input: "no context at all" });
    const runNode = await nodeIdFor(projectId, lineageNaturalKey({ subtype: "run_node", refId: d.runId, refKey: "p" }));
    const edges = await db.select().from(lineageEdges).where(eq(lineageEdges.runId, d.runId));
    expect(edges.some((e) => e.kind === "flowed_into")).toBe(false);
    expect(edges.some((e) => e.kind === "produced" && e.fromNodeId === runNode)).toBe(true);
    expect(d.outputText).not.toContain("Shared project context supplied");
  });
});
