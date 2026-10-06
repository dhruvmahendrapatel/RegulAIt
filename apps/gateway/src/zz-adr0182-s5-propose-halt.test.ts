/**
 * ADR-0182 (ADR-0175 batch D4) S5 — PF-03: a KRI breach SUGGESTS a halt
 * (owner decision 4, 2026-10-06: suggest only — never auto-file, never trip).
 *
 * On a real database, through the real KRI routes, monitor, remediation route
 * and the ONE approvals decide path:
 *  - `propose_halt` is refused on a fleet or project KRI (422), on create and
 *    on a scope change; allowed on an agent KRI;
 *  - a breach of an agent KRI set to `propose_halt` raises an episode that
 *    CARRIES `suggestedAction` and files NOTHING: no proposal, no approval,
 *    and the agent keeps running;
 *  - a person's "Propose halt" files exactly ONE proposal for the episode,
 *    with that person as proposer; a second click (by anyone) returns it;
 *  - the proposer cannot approve it; until a DIFFERENT admin approves, the
 *    agent is not halted; the approval halts it through `haltAgentInTx`.
 *
 * Global state (M-068): the KRIs and the agent this file creates are removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  and,
  approvals,
  auditLog,
  createDb,
  eq,
  governanceAlerts,
  inArray,
  kris,
  remediationProposals,
  runMigrations,
  type Db,
} from "@regulait/db";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { buildApp } from "./app.js";
import { runGovernanceMonitor } from "./governance-monitor.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `s5-halt-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
const u = {} as Record<"proposer" | "approver" | "member", { id: string; auth: { authorization: string } }>;
const made = { kris: [] as string[], agents: [] as string[] };
let agentId = "";
let projectId = "";

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

let restoreMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["proposer", true], ["approver", true], ["member", false]] as const) {
    const r = await inject("POST", "/v1/users", AUTH, { email: `s5h-${k}-${RUN}@example.com`, displayName: `s5h ${k} ${RUN}`, isAdmin });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    u[k] = { id, auth: { authorization: `Bearer ${(await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "s5h" })).json().token as string}` } };
  }
  const [a] = await db.insert(agents).values({ name: `s5h-agent-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
  agentId = a!.id;
  made.agents.push(agentId);
  const p = await inject("POST", "/v1/projects", AUTH, { name: `s5h-project-${RUN}` });
  expect([200, 201]).toContain(p.statusCode);
  projectId = p.json().id as string;
}, 120_000);

afterAll(async () => {
  try {
    if (made.kris.length) {
      await db.delete(governanceAlerts).where(inArray(governanceAlerts.subjectKey, made.kris.map((k) => `kri:${k}`)));
      await db.delete(kris).where(inArray(kris.id, made.kris));
    }
    if (made.agents.length) await db.delete(agents).where(inArray(agents.id, made.agents));
    await restoreMfa?.();
  } finally {
    await app?.close();
    await db?.$client.end();
  }
});

/** a KRI that breaches with no traffic at all: trace volume below 1 over the
 * window is a window total, so zero traces is a measurement of 0, not "too
 * little data" */
const breachingKri = (over: Record<string, unknown>) => ({
  name: `s5h kri ${RUN} ${Math.random().toString(36).slice(2, 6)}`,
  metric: "trace_volume",
  comparator: "below",
  threshold: 1,
  windowDays: 1,
  severity: "high",
  ...over,
});

describe("PF-03 propose_halt is an agent-scoped KRI's option only", () => {
  it("422 on a fleet or project KRI, on create and on a scope change; 201 on an agent KRI", async () => {
    const fleet = await inject("POST", "/v1/kris", u.proposer.auth, breachingKri({ onBreach: "propose_halt" }));
    expect(fleet.statusCode, fleet.body).toBe(422);
    expect(fleet.json().error).toBe("propose_halt_requires_agent_scope");
    const project = await inject("POST", "/v1/kris", u.proposer.auth, breachingKri({ scope: "project", scopeId: projectId, onBreach: "propose_halt" }));
    expect(project.statusCode, project.body).toBe(422);

    const ok = await inject("POST", "/v1/kris", u.proposer.auth, breachingKri({ scope: "agent", scopeId: agentId, onBreach: "propose_halt", enabled: false }));
    expect(ok.statusCode, ok.body).toBe(201);
    made.kris.push(ok.json().id);
    expect(ok.json().onBreach).toBe("propose_halt");
    const moved = await inject("PATCH", `/v1/kris/${ok.json().id}`, u.proposer.auth, { scope: "project", scopeId: projectId });
    expect(moved.statusCode, moved.body).toBe(422);
    const [row] = await db.select().from(kris).where(eq(kris.id, ok.json().id));
    expect(row).toMatchObject({ scope: "agent", onBreach: "propose_halt" });
    // the default stays `alert`
    const plain = await inject("POST", "/v1/kris", u.proposer.auth, breachingKri({ scope: "agent", scopeId: agentId, enabled: false }));
    made.kris.push(plain.json().id);
    expect(plain.json().onBreach).toBe("alert");
  });
});

describe("PF-03 a breach suggests; a person proposes; a different person approves", () => {
  let kriId = "";
  let alertId = "";
  const proposalsFor = () => db.select().from(remediationProposals).where(eq(remediationProposals.alertId, alertId));
  const halted = async () => (await db.select({ h: agents.haltedAt }).from(agents).where(eq(agents.id, agentId)))[0]!.h;

  it("the breach episode carries the suggestion and NOTHING is filed or halted on its own", async () => {
    const k = await inject("POST", "/v1/kris", u.proposer.auth, breachingKri({ scope: "agent", scopeId: agentId, onBreach: "propose_halt" }));
    expect(k.statusCode, k.body).toBe(201);
    kriId = k.json().id;
    made.kris.push(kriId);
    const approvalsBefore = (await db.select({ id: approvals.id }).from(approvals)).length;
    await runGovernanceMonitor(db, { actorUserId: u.proposer.id });
    await runGovernanceMonitor(db, { actorUserId: null }); // a second (scheduler-like) pass files nothing either
    const [alert] = await db
      .select()
      .from(governanceAlerts)
      .where(and(eq(governanceAlerts.ruleId, "kri_threshold_breached"), eq(governanceAlerts.subjectKey, `kri:${kriId}`)));
    expect(alert, "the breach raised an episode").toBeDefined();
    alertId = alert!.id;
    expect(alert!.status).toBe("open");
    expect(alert!.detail.suggestedAction).toEqual({ kind: "halt_agent", agentId });
    expect(await proposalsFor()).toEqual([]);
    expect((await db.select({ id: approvals.id }).from(approvals)).length).toBe(approvalsBefore);
    expect(await halted()).toBeNull();
    // the episode is the agent's steward's to own; this agent has none, so it is unowned
    expect(alert!.ownerUserId).toBeNull();
  });

  it("the planner offers 'Propose halt'; one click files ONE proposal with the clicker as proposer; a second click returns it", async () => {
    const plan = await inject("GET", `/v1/governance/alerts/${alertId}/remediation`, u.proposer.auth);
    expect(plan.statusCode, plan.body).toBe(200);
    const cand = plan.json().candidates.find((c: { kind: string }) => c.kind === "halt_agent");
    expect(cand).toMatchObject({ executable: true, params: { agentId }, title: `Propose halting s5h-agent-${RUN}` });

    const body = { kind: "halt_agent", params: { agentId }, approverUserId: u.approver.id };
    const first = await inject("POST", `/v1/governance/alerts/${alertId}/remediation`, u.proposer.auth, body);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toMatchObject({ kind: "halt_agent", status: "pending_approval", proposedByUserId: u.proposer.id });
    const again = await inject("POST", `/v1/governance/alerts/${alertId}/remediation`, u.approver.auth, { ...body, approverUserId: u.proposer.id });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ id: first.json().id, idempotent: true, proposedByUserId: u.proposer.id });
    expect(await proposalsFor()).toHaveLength(1);
    expect(await halted()).toBeNull();
    // a non-admin cannot reach the route at all (admin-only by default)
    expect((await inject("POST", `/v1/governance/alerts/${alertId}/remediation`, u.member.auth, body)).statusCode).toBe(403);
  });

  it("the proposer's own approval is refused and nothing halts; a different admin's approval halts through haltAgentInTx", async () => {
    const [p] = await proposalsFor();
    const decide = (who: { auth: { authorization: string } }) =>
      inject("POST", `/v1/approvals/${p!.approvalId}/decide`, who.auth, { decision: "approved", reason: "error budget exhausted on the agent" });
    const own = await decide(u.proposer);
    expect(own.statusCode, own.body).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_remediation");
    expect(await halted()).toBeNull();

    const ok = await decide(u.approver);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await halted()).not.toBeNull();
    const [after] = await proposalsFor();
    expect(after).toMatchObject({ status: "applied", decidedByUserId: u.approver.id });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "execution-agent-halted"), eq(auditLog.objectId, agentId)));
    expect(audit!.userId).toBe(u.approver.id);
    expect(audit!.detail).toMatchObject({ remediationId: p!.id, proposedByUserId: u.proposer.id, alertId });
    // still ONE proposal for the episode, even once applied
    const third = await inject("POST", `/v1/governance/alerts/${alertId}/remediation`, u.proposer.auth, { kind: "halt_agent", params: { agentId }, approverUserId: u.approver.id });
    expect([200, 409]).toContain(third.statusCode);
    expect(await proposalsFor()).toHaveLength(1);
  });
});
