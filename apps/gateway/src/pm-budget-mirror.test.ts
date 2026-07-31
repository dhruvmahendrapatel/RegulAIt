import { beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditLog, createDb, desc, eq, runMigrations, type Db } from "@regulait/db";
import { resolvePmProvider } from "@regulait/pm-provider";
import { buildApp } from "./app.js";

/**
 * O8 (ADR-0027) — budget-cap escalation approvals mirror to the PM tool as
 * first-class linked records, like sign-offs already do, on the RUN-LEVEL
 * PARENT work item (which exists for exactly this). Always a COMMENT (a
 * spend sanction is not a stage outcome — no transition ever), both
 * directions (approved AND denied) — decide-hook parity. Shares one DB
 * (fileParallelism off); prefix o8-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "o8-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let benId: string;
let benAuth: { authorization: string };
let approverId: string;
let approverAuth: { authorization: string };
let worker: string;

async function makeUser(email: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "o8" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

const mkNode = (id: string) => ({
  id, title: `task ${id}`, ownerAgentId: worker, mode: "execute",
  estimate: { in: 100_000, out: 100_000 }, // $3 under the priced worker
});

async function escalatedRun(name: string): Promise<{ runId: string; approvalId: string; parentExternalId: string }> {
  const created = await app.inject({
    method: "POST", headers: benAuth, url: "/v1/runs",
    payload: { graph: { run: name, escalationApproverUserId: approverId, nodes: [mkNode("n1")] } },
  });
  expect(created.statusCode).toBe(201);
  const runId = created.json().id as string;
  const sync = await app.inject({
    method: "POST", headers: benAuth, url: `/v1/runs/${runId}/pm-sync`,
    payload: { connectionName: "o8-pm" },
  });
  expect(sync.statusCode).toBe(201);
  const ev = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", headers: benAuth, url: `/v1/runs/${runId}/events`, payload });
  await ev({ kind: "start" });
  // the $1 RUN budget trips under the $3 node estimate → __budget__ escalation
  const started = await ev({ kind: "node_started", nodeId: "n1" });
  expect(started.statusCode).toBe(409);
  const inbox = await app.inject({ method: "GET", headers: approverAuth, url: "/v1/approvals?status=pending" });
  const entry = inbox.json().approvals.find(
    (a: { runId: string | null; stageId: string | null }) => a.runId === runId && a.stageId?.startsWith("__budget__"),
  );
  expect(entry).toBeTruthy();
  const links = await app.inject({ method: "GET", headers: benAuth, url: `/v1/pm/links?runId=${runId}` });
  const parent = links.json().links.find((l: { objectType: string }) => l.objectType === "run");
  expect(parent).toBeTruthy(); // the run-level parent work item exists for exactly this
  return { runId, approvalId: entry.id, parentExternalId: parent.externalId };
}

async function workItem(externalId: string) {
  const mock = resolvePmProvider({ provider: "mock", token: "" });
  return mock.getWorkItem("O8-PROJ", externalId);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  const ben = await makeUser("o8-ben@example.com");
  benId = ben.id;
  benAuth = ben.auth;
  const ap = await makeUser("o8-approver@example.com");
  approverId = ap.id;
  approverAuth = ap.auth;
  const a = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents",
    payload: { name: "o8-worker", provider: "mock", tier: 1, costPerMTokIn: 5, costPerMTokOut: 25, model: "mock-1" } });
  worker = a.json().id;
  await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: benId, agentId: worker } });
  // a $1 run budget with breach → approve (the escalation path)
  await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${benId}/agent-policy`,
    payload: { runBudgetUsd: 1, runBudgetBreachAction: "approve" } });
  const conn = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/pm/connections",
    payload: { name: "o8-pm", provider: "mock", project: "O8-PROJ", token: "mock-token" },
  });
  expect(conn.statusCode).toBe(201);
});

describe("budget-cap escalation decisions mirror onto the run-level parent item", () => {
  it("an APPROVED sanction lands as a comment (never a transition), audited", async () => {
    const { approvalId, parentExternalId } = await escalatedRun("o8-approve");
    const decided = await app.inject({
      method: "POST", headers: approverAuth, url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "approved", reason: "one more attempt is sanctioned" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().pmMirror).toEqual({ ok: true, action: "comment" });
    const item = await workItem(parentExternalId);
    expect(item.comments.some((c) => c.includes("budget-cap escalation") && c.includes("SANCTIONED"))).toBe(true);
    expect(item.comments.some((c) => c.includes("one more attempt is sanctioned"))).toBe(true);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "pm-budget-decision-mirrored"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(audit).toBeTruthy();
    expect(audit!.reason).toContain("parent work item");
  });

  it("a DENIED sanction mirrors too — decide-hook parity both directions", async () => {
    const { approvalId, parentExternalId } = await escalatedRun("o8-deny");
    const decided = await app.inject({
      method: "POST", headers: approverAuth, url: `/v1/approvals/${approvalId}/decide`,
      payload: { decision: "denied", reason: "spend not justified" },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json().pmMirror).toEqual({ ok: true, action: "comment" });
    const item = await workItem(parentExternalId);
    expect(item.comments.some((c) => c.includes("DENIED") && c.includes("spend not justified"))).toBe(true);
  });
});
