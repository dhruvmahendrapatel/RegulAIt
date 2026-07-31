import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, desc, eq, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * O7 (ADR-0027, migration 0045) — PM drift AUTO-RESOLUTION. Per-connection
 * policy drift_resolution: manual (default = today's detect-only) |
 * prefer_regulait (push the expected state back to the PM tool) | prefer_pm
 * (adopt the PM tool's state on the link — the run state machine is never
 * driven from outside). Audited with before/after; unresolvable conflicts
 * stay surfaced. Shares one DB (fileParallelism off); prefix o7-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "o7-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userAuth: { authorization: string };
let userId: string;
let approverId: string;
let agentId: string;

async function mkConnection(name: string, driftResolution?: string) {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/pm/connections",
    payload: {
      name, provider: "mock", project: "O7-DEMO", token: "mock-token",
      ...(driftResolution ? { driftResolution } : {}),
    },
  });
  expect(r.statusCode).toBe(201);
  return { name, secret: r.json().webhookSecret as string };
}

/** start a run with one node, pm-sync it, start the node (status in_progress
 * — maps to "Doing" in the default mock mapping) and return the external id */
async function mkLinkedRun(name: string, connectionName: string) {
  const run = await app.inject({
    method: "POST", headers: userAuth, url: "/v1/runs",
    payload: { graph: {
      run: name,
      escalationApproverUserId: approverId,
      nodes: [{ id: "n1", title: "o7 watched work", ownerAgentId: agentId, mode: "execute" }],
    } },
  });
  expect(run.statusCode).toBe(201);
  const runId = run.json().id as string;
  const sync = await app.inject({
    method: "POST", headers: userAuth, url: `/v1/runs/${runId}/pm-sync`,
    payload: { connectionName },
  });
  expect(sync.statusCode).toBe(201);
  const externalId = sync.json().created.find((c: { nodeId: string }) => c.nodeId === "n1").externalId as string;
  const ev = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", headers: userAuth, url: `/v1/runs/${runId}/events`, payload });
  await ev({ kind: "start" });
  await ev({ kind: "node_started", nodeId: "n1" });
  return { runId, externalId };
}

async function webhook(connection: { name: string; secret: string }, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST", url: `/v1/pm/webhooks/${connection.name}`,
    headers: { "x-regulait-webhook-secret": connection.secret },
    payload,
  });
}

async function linkFor(runId: string, nodeId: string) {
  const links = await app.inject({ method: "GET", headers: userAuth, url: `/v1/pm/links?runId=${runId}` });
  return links.json().links.find((l: { nodeId: string }) => l.nodeId === nodeId);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  const mkUser = async (email: string) => {
    const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
    const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "o7" } });
    return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
  };
  const user = await mkUser("o7-user@example.com");
  userId = user.id;
  userAuth = user.auth;
  approverId = (await mkUser("o7-approver@example.com")).id;
  const agent = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/agents",
    payload: { name: "o7-worker", provider: "anthropic", tier: 1, modes: ["execute"] },
  });
  agentId = agent.json().id;
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId, agentId } });
});

describe("manual (default) — byte-identical detect-only", () => {
  it("a new connection defaults to manual and drift only surfaces", async () => {
    const conn = await mkConnection("o7-manual");
    const { runId, externalId } = await mkLinkedRun("o7-manual-run", "o7-manual");
    const r = await webhook(conn, { externalId, event: "updated", state: "Done" });
    expect(r.json()).toEqual({ matched: true, drift: true });
    const link = await linkFor(runId, "n1");
    expect(link.drift).toBe(true);
    expect(link.adoptedState ?? null).toBeNull();
  });
});

describe("prefer_regulait — the expected state is pushed back to the PM tool", () => {
  it("drift resolves by transitioning the work item back; audited with before/after", async () => {
    const conn = await mkConnection("o7-pref-rg", "prefer_regulait");
    const { runId, externalId } = await mkLinkedRun("o7-rg-run", "o7-pref-rg");
    const r = await webhook(conn, { externalId, event: "updated", state: "Done" });
    expect(r.json()).toEqual({ matched: true, drift: false }); // resolved, not surfaced as drift
    const link = await linkFor(runId, "n1");
    expect(link.lastSyncedAt).toBeTruthy(); // the push-back happened
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "pm-drift-auto-resolved"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(audit).toBeTruthy();
    expect(audit!.detail).toMatchObject({ resolution: "prefer_regulait", before: "Done", after: "Doing" });
    // the run state machine was never driven from outside
    const view = await app.inject({ method: "GET", headers: userAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.state.nodeStatuses.n1).toBe("in_progress");
  });
});

describe("prefer_pm — the PM state is adopted on the link, the state machine untouched", () => {
  it("drift resolves by adoption; re-reports of the adopted state stay quiet; the run is untouched", async () => {
    const conn = await mkConnection("o7-pref-pm", "prefer_pm");
    const { runId, externalId } = await mkLinkedRun("o7-pm-run", "o7-pref-pm");
    const r = await webhook(conn, { externalId, event: "updated", state: "Done" });
    expect(r.json()).toEqual({ matched: true, drift: false });
    const link = await linkFor(runId, "n1");
    expect(link.adoptedState).toBe("Done");
    expect(link.drift).toBe(false); // the adopted state no longer counts as drift
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "pm-drift-auto-resolved"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(audit!.detail).toMatchObject({ resolution: "prefer_pm", before: "Doing", after: "Done" });
    // re-report of the same adopted state: quiet, no new drift
    const again = await webhook(conn, { externalId, event: "updated", state: "Done" });
    expect(again.json()).toEqual({ matched: true, drift: false });
    // a DIFFERENT diverging state is a fresh drift → adopted anew (declared direction)
    const other = await webhook(conn, { externalId, event: "updated", state: "To Do" });
    expect(other.json()).toEqual({ matched: true, drift: false });
    expect((await linkFor(runId, "n1")).adoptedState).toBe("To Do");
    // the run state machine stayed RegulAIt's throughout
    const view = await app.inject({ method: "GET", headers: userAuth, url: `/v1/runs/${runId}` });
    expect(view.json().run.state.nodeStatuses.n1).toBe("in_progress");
  });

  it("a DELETED work item is not safely auto-resolvable in any mode — the orphan stays surfaced", async () => {
    const conn = await mkConnection("o7-pm-del", "prefer_pm");
    const { runId, externalId } = await mkLinkedRun("o7-del-run", "o7-pm-del");
    const r = await webhook(conn, { externalId, event: "deleted" });
    expect(r.json()).toEqual({ matched: true, drift: false });
    const link = await linkFor(runId, "n1");
    expect(link.orphanedAt).toBeTruthy(); // surfaced exactly as before
  });
});
