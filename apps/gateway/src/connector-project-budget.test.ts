import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  approvals,
  auditLog,
  createDb,
  desc,
  egressAllowHosts,
  eq,
  projects,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

/**
 * F02 (connector path) / ADR-0103 amendment 2026-10-03 — the pillar-5 PROJECT
 * budget on POST /v1/connectors/:connectorId/invoke.
 *
 * The connector invoke was priced and attributed (`usage_events` with
 * `projectId`, `connectors.price_per_call_usd`) but never gated: an attributed
 * invoke against an exhausted project still executed upstream and billed. The
 * gate is now the SAME `preDispatchProjectGate` the model and MCP paths use,
 * placed after the entitlement decision and before any credential, PII,
 * guardrail, egress or provider work.
 *
 * The acceptance criterion is strict: a blocked call must never have CONTACTED
 * the upstream. The fake receiver below counts every HTTP request it sees, and
 * every block asserts a zero delta on it AND on the connector's usage rows.
 *
 * Shares one DB (fileParallelism off) — every assertion is a DELTA, never an
 * absolute count. Prefix f02c-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);
const BOOT = "f02c-bootstrap-token";
const RUN = Math.random().toString(36).slice(2, 8);
const AUTH = { authorization: `Bearer ${BOOT}` };
const PROFILE_TAG = `f02c-finreg-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let receiver: http.Server;
let receiverHits = 0;
let userId: string;
let userAuth: { authorization: string };
let approverId: string;
let connectorId: string;
let allowHostId: string;

async function mkUser(email: string): Promise<{ id: string; auth: { authorization: string } }> {
  const r = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  const id = r.json().id as string;
  const k = await app.inject({
    method: "POST", headers: AUTH, url: `/v1/users/${id}/keys`, payload: { name: "f02c-key" },
  });
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}
async function mkProject(payload: Record<string, unknown>): Promise<string> {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
}
/** Seed measured spend the same way the model path would have left it. */
async function spend(projectId: string, costUsd: number) {
  await db.insert(usageEvents).values({ userId, objectType: "agent", projectId, costUsd });
}
async function connectorUsageCount(projectId: string | null): Promise<number> {
  const rows = await db
    .select({ id: usageEvents.id })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.objectType, "connector"),
        eq(usageEvents.connectorId, connectorId),
        ...(projectId ? [eq(usageEvents.projectId, projectId)] : []),
      ),
    );
  return rows.length;
}
const invoke = (projectId: string | null) =>
  app.inject({
    method: "POST",
    headers: userAuth,
    url: `/v1/connectors/${connectorId}/invoke`,
    payload: {
      operation: "write",
      object: "customer-records",
      payload: { note: `f02c-${RUN}` },
      ...(projectId ? { projectId } : {}),
    },
  });
async function setEnforcement(value: "block" | "warn_only"): Promise<"block" | "warn_only"> {
  const current = await app.inject({ method: "GET", headers: AUTH, url: "/v1/org/settings" });
  const previous = (current.json().budgetEnforcement ?? "block") as "block" | "warn_only";
  await app.inject({
    method: "PUT", headers: AUTH, url: "/v1/org/settings", payload: { budgetEnforcement: value },
  });
  return previous;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });

  receiver = http.createServer((req, res) => {
    receiverHits++;
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    });
  });
  await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
  const port = (receiver.address() as { port: number }).port;

  const allowed = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts",
    payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: `f02c-${RUN}` },
  });
  expect(allowed.statusCode).toBe(201);
  allowHostId = allowed.json().id as string;

  const u = await mkUser(`f02c-uma-${RUN}@example.com`);
  userId = u.id;
  userAuth = u.auth;
  approverId = (await mkUser(`f02c-approver-${RUN}@example.com`)).id;

  const created = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/connectors",
    payload: {
      name: `f02c-webhook-${RUN}`, kind: "notifications", providerKind: "webhook",
      baseUrl: `http://127.0.0.1:${port}/collect`, pricePerCallUsd: 0.01,
    },
  });
  expect(created.statusCode).toBe(201);
  connectorId = created.json().id as string;
  await app.inject({
    method: "POST", headers: AUTH, url: "/v1/grants/connectors",
    payload: { userId, connectorId, mode: "readwrite" },
  });

  const profile = await app.inject({
    method: "POST", headers: AUTH, url: "/v1/compliance/profiles",
    payload: { tag: PROFILE_TAG, budgetEnforcement: "block", piiMode: "log" },
  });
  expect(profile.statusCode).toBe(201);
});

afterAll(async () => {
  await db.delete(egressAllowHosts).where(eq(egressAllowHosts.id, allowHostId));
  receiver.closeAllConnections();
  await new Promise<void>((r) => receiver.close(() => r()));
  await app.close();
});

describe("the exhausted project blocks a connector invoke BEFORE the upstream is contacted", () => {
  it("returns 409 project_budget_exceeded, contacts nothing, bills nothing, audits one deny row", async () => {
    const projectId = await mkProject({
      name: `f02c-exhausted-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
    });
    await spend(projectId, 0.5);
    const hitsBefore = receiverHits;
    const usageBefore = await connectorUsageCount(projectId);

    const res = await invoke(projectId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("project_budget_exceeded");
    expect(res.json().detail).toContain("hard-block threshold");
    // the entitlement decision is still reported — the budget gate sits AFTER it
    expect(res.json().decision?.effect).toBe("allow");

    // THE acceptance criterion: the receiver was never spoken to...
    expect(receiverHits).toBe(hitsBefore);
    // ...and nothing was billed for it.
    expect(await connectorUsageCount(projectId)).toBe(usageBefore);

    // the block is one audited deny row naming the project-budget rule on the connector
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "project-budget-cap"), eq(auditLog.objectId, connectorId), eq(auditLog.effect, "deny")))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(row).toBeDefined();
    expect(row!.objectType).toBe("connector");
    expect(row!.userId).toBe(userId);
    expect(row!.detail).toMatchObject({ phase: "project-budget", projectId, operation: "write" });
    expect(row!.reason).toContain("project_budget_exceeded");
  });

  it("a project still UNDER its budget runs and bills normally", async () => {
    const projectId = await mkProject({
      name: `f02c-healthy-${RUN}`, budgetUsd: 10, budgetApproverUserId: approverId,
    });
    const hitsBefore = receiverHits;
    const usageBefore = await connectorUsageCount(projectId);
    const res = await invoke(projectId);
    expect(res.statusCode).toBe(200);
    expect(receiverHits).toBe(hitsBefore + 1);
    expect(await connectorUsageCount(projectId)).toBe(usageBefore + 1);
  });

  it("an UNATTRIBUTED invoke is unaffected — it runs and lands in the null-project bucket", async () => {
    const hitsBefore = receiverHits;
    const usageBefore = await connectorUsageCount(null);
    const res = await invoke(null);
    expect(res.statusCode).toBe(200);
    expect(receiverHits).toBe(hitsBefore + 1);
    expect(await connectorUsageCount(null)).toBe(usageBefore + 1);
  });
});

describe("the gate's other verdicts carry over unchanged", () => {
  it("a SANCTIONED overage lets the invoke through and bills it", async () => {
    const projectId = await mkProject({
      name: `f02c-overage-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
    });
    await spend(projectId, 0.5);
    // what the named approver's decision on the __project_budget__ row writes
    await db.update(projects).set({ overageApproved: true, overageApprovedPeriod: null }).where(eq(projects.id, projectId));
    const hitsBefore = receiverHits;
    const usageBefore = await connectorUsageCount(projectId);
    const res = await invoke(projectId);
    expect(res.statusCode).toBe(200);
    expect(receiverHits).toBe(hitsBefore + 1);
    expect(await connectorUsageCount(projectId)).toBe(usageBefore + 1);
  });

  it("warn_only lets the invoke through, still bills it, and still escalates + audits the crossing", async () => {
    const restore = await setEnforcement("warn_only");
    try {
      const projectId = await mkProject({
        name: `f02c-warn-only-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
      });
      await spend(projectId, 0.5);
      const hitsBefore = receiverHits;
      const usageBefore = await connectorUsageCount(projectId);
      const res = await invoke(projectId);
      expect(res.statusCode).toBe(200);
      expect(receiverHits).toBe(hitsBefore + 1);
      expect(await connectorUsageCount(projectId)).toBe(usageBefore + 1);
      const queued = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.projectId, projectId), eq(approvals.stageId, "__project_budget__")));
      expect(queued).toHaveLength(1);
    } finally {
      await setEnforcement(restore);
    }
  });

  it("a compliance profile's budgetEnforcement 'block' overrides org warn_only (strictest wins) — blocked, untouched, unbilled", async () => {
    const restore = await setEnforcement("warn_only");
    try {
      const projectId = await mkProject({
        name: `f02c-compliance-block-${RUN}`, budgetUsd: 0.01, budgetApproverUserId: approverId,
        classifications: [PROFILE_TAG],
      });
      await spend(projectId, 0.5);
      const hitsBefore = receiverHits;
      const usageBefore = await connectorUsageCount(projectId);
      const res = await invoke(projectId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("project_budget_exceeded");
      expect(res.json().detail).toContain("blocking forced by the compliance cascade");
      expect(receiverHits).toBe(hitsBefore);
      expect(await connectorUsageCount(projectId)).toBe(usageBefore);
    } finally {
      await setEnforcement(restore);
    }
  });
});
