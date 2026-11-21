/**
 * ADR-0359 §7 (lane E40) — goal alignment (OWASP ASI01), shadow mode: the pure check and its steering table (in
 * ADR-0354's vocabulary), the sweep against a real Postgres (scratch database, audit v2 actor columns), and the admin
 * API (declare a purpose, widening is a step-up relaxation, findings, the declared status lifecycle).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  agents,
  auditLog,
  behaviourBaselineSettings,
  connectors,
  createDb,
  eq,
  goalAlignmentFindings,
  mcpServers,
  mcpTools,
  runAuditV2Cutover,
  runMigrations,
  sql,
  users,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import { AGENT_RESPONSES } from "@regulait/policy-kernel";
import { dropScratchDatabase } from "./testing/scratch-db.js";
import { buildApp } from "./app.js";
import { backdated } from "./testing/backdated-audit.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { GOAL_DIVERGENCE_REASONS, GOAL_STEERING, evaluateGoalAlignment, type DeclaredPurpose, type GoalCall } from "./goal-alignment/check.js";
import { GOAL_ALIGNMENT_RULE_IDS, runGoalAlignmentSweep } from "./goal-alignment/sweep.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const RUN = Date.now();

const READ: GoalCall = { targetKind: "mcp_tool", targetId: "t-read", targetName: "read_file", writes: false, destructive: false, openWorld: false };
const purpose = (over: Partial<DeclaredPurpose> = {}): DeclaredPurpose => ({
  statement: "triage support tickets",
  allowWrite: false,
  allowDestructive: false,
  allowOpenWorld: false,
  tools: ["mcp_tool:t-read"],
  ...over,
});

describe("ADR-0359 §7 check: a call against the declared purpose", () => {
  it("fits a declared read, and makes no claim beyond advise without a purpose", () => {
    expect(evaluateGoalAlignment(purpose(), READ)).toMatchObject({ aligned: true, reasons: [], suggestedResponse: null });
    const none = evaluateGoalAlignment(null, READ);
    expect(none).toMatchObject({ aligned: false, primary: "no_declared_purpose", suggestedResponse: "advise" });
  });

  it("names every divergence and suggests the strictest response", () => {
    const write = { ...READ, targetId: "t-del", targetName: "delete_repo", writes: true, destructive: true, openWorld: true };
    const v = evaluateGoalAlignment(purpose(), write);
    expect(v.reasons).toEqual(["tool_not_declared", "write_not_declared", "open_world_not_declared", "destructive_not_declared"]);
    expect(v).toMatchObject({ primary: "destructive_not_declared", suggestedResponse: "block_session" });
    expect(v.explanation).toContain("DIVERGES");
    expect(v.explanation).toContain("shadow: not applied");
    const undeclared = evaluateGoalAlignment(purpose(), { ...READ, targetId: "t-other" });
    expect(undeclared).toMatchObject({ reasons: ["tool_not_declared"], suggestedResponse: "correct" });
    const allowed = evaluateGoalAlignment(purpose({ allowWrite: true, tools: ["mcp_tool:t-w"] }), { ...READ, targetId: "t-w", writes: true });
    expect(allowed.aligned).toBe(true);
  });

  it("keeps the steering table inside ADR-0354's vocabulary and the database CHECKs equal to the code", () => {
    for (const r of Object.values(GOAL_STEERING)) expect(AGENT_RESPONSES).toContain(r);
    const ddl = fs.readFileSync(path.resolve(here, "../../../packages/db/migrations/pending/goal_alignment.sql"), "utf8");
    const reasons = ddl.match(/"divergence" IN \(([^)]*)\)/)![1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(reasons).toEqual([...GOAL_DIVERGENCE_REASONS]);
    const responses = ddl.match(/"suggested_response" IN \(([^)]*)\)/)![1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    expect(responses.sort()).toEqual([...new Set(Object.values(GOAL_STEERING))].sort());
  });
});

async function makeAgentIdentity(d: Db, owner: string): Promise<string> {
  const [a] = await d.insert(agents).values({ name: `adr0359-ga-${randomUUID()}`, provider: "anthropic", tier: 1 }).returning({ id: agents.id });
  const [w] = await d
    .insert(workloadIdentities)
    .values({ kind: "agent", agentId: a!.id, identifier: `spiffe://regulait.test/regulait/agent/${a!.id}`, sponsorUserIds: [owner] })
    .returning({ id: workloadIdentities.id });
  return w!.id;
}

describe("ADR-0359 §7 sweep: agent tool calls judged against their purpose (scratch database, audit v2)", () => {
  it("starts at the head, records shadow findings once with their suggested response, and skips when off", async () => {
    // actor columns can be written only after the audit v2 cutover, which must not run on the shared database
    const admin = createDb(DATABASE_URL!);
    const name = `adr0359_ga_${process.pid}_${RUN}`;
    await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    await admin.execute(sql.raw(`CREATE DATABASE ${name}`));
    const u = new URL(DATABASE_URL!);
    u.pathname = `/${name}`;
    const sdb = createDb(u.toString());
    try {
      await runMigrations(sdb, migrationsFolder);
      await runAuditV2Cutover(sdb, { setBy: null });
      const [owner] = await sdb.insert(users).values({ email: `ga-owner-${RUN}@example.com`, displayName: "owner" }).returning({ id: users.id });
      const declaredAgent = await makeAgentIdentity(sdb, owner!.id);
      const undeclaredAgent = await makeAgentIdentity(sdb, owner!.id);
      const [srv] = await sdb.insert(mcpServers).values({ name: `ga-${RUN}`, url: "http://127.0.0.1:9/" }).returning({ id: mcpServers.id });
      const [readTool] = await sdb.insert(mcpTools).values({ serverId: srv!.id, name: "read_ticket", kind: "read" }).returning({ id: mcpTools.id });
      await sdb.insert(mcpTools).values({ serverId: srv!.id, name: "delete_repo", kind: "write" });
      const [conn] = await sdb.insert(connectors).values({ name: `ga-crm-${RUN}`, kind: "crm", baseUrl: "https://crm.test/api" }).returning({ id: connectors.id });
      await sdb.execute(sql`INSERT INTO agent_purpose_declarations (identity_id, statement, allow_open_world) VALUES (${declaredAgent}::uuid, 'triage support tickets', true)`);
      await sdb.execute(sql`INSERT INTO agent_purpose_tools (identity_id, target_kind, ref_id) VALUES
                              (${declaredAgent}::uuid, 'mcp_tool', ${readTool!.id}::uuid), (${declaredAgent}::uuid, 'connector', ${conn!.id}::uuid)`);

      const call = (identity: string, over: Partial<typeof auditLog.$inferInsert>): typeof auditLog.$inferInsert => ({
        userId: owner!.id,
        at: new Date(),
        objectType: "mcp_tool",
        effect: "allow",
        ruleId: "allow-list",
        ruleChain: [],
        reason: "adr0359 goal fixture",
        actorIdentityId: identity,
        delegationGrantId: randomUUID(),
        actorChain: [identity],
        ...over,
      });
      // a row before the first pass is never judged
      await backdated(sdb).insert(auditLog).values(call(declaredAgent, { serverId: srv!.id, toolName: "delete_repo" }));
      const first = await runGoalAlignmentSweep(sdb);
      expect(first).toMatchObject({ ran: true, started: true, findings: 0 });

      await backdated(sdb).insert(auditLog).values([
        // fits (an unannotated MCP tool reaches the open world, fail closed, so the purpose declares that)
        call(declaredAgent, { serverId: srv!.id, toolName: "read_ticket" }),
        call(declaredAgent, { objectType: "connector", objectId: conn!.id, toolName: "read" }), // fits
        call(declaredAgent, { objectType: "connector", objectId: conn!.id, toolName: "write" }), // write not declared
        call(declaredAgent, { serverId: srv!.id, toolName: "delete_repo" }), // destructive, undeclared tool
        call(declaredAgent, { serverId: srv!.id, toolName: "delete_repo" }),
        call(declaredAgent, { serverId: srv!.id, toolName: "not_in_registry" }), // fails closed
        call(undeclaredAgent, { serverId: srv!.id, toolName: "read_ticket" }), // no purpose: advise
        { ...call(declaredAgent, {}), actorIdentityId: null, delegationGrantId: null, actorChain: null, serverId: srv!.id, toolName: "delete_repo" }, // a person, not an agent
      ]);
      const out = await runGoalAlignmentSweep(sdb);
      expect(out).toMatchObject({ ran: true, mode: "shadow", findings: 4 });

      const found = await sdb.select().from(goalAlignmentFindings);
      const by = Object.fromEntries(found.map((f) => [`${f.identityId === declaredAgent ? "declared" : "undeclared"}:${f.targetName}`, f]));
      expect(Object.keys(by).sort()).toEqual(["declared:delete_repo", `declared:ga-crm-${RUN}`, "declared:not_in_registry", "undeclared:read_ticket"].sort());
      expect(by["declared:delete_repo"]).toMatchObject({
        divergence: "destructive_not_declared",
        divergences: ["tool_not_declared", "write_not_declared", "destructive_not_declared"],
        suggestedResponse: "block_session",
        callCount: 2,
        observedWrite: true,
        observedDestructive: true,
        status: "open",
      });
      expect(by["declared:delete_repo"]!.declared).toMatchObject({ version: 1, statement: "triage support tickets", allowWrite: false, allowOpenWorld: true });
      expect(by[`declared:ga-crm-${RUN}`]).toMatchObject({ divergence: "write_not_declared", suggestedResponse: "correct", observedWrite: true });
      expect(by["declared:not_in_registry"]).toMatchObject({ divergence: "destructive_not_declared", targetKey: `unregistered:${srv!.id}:not_in_registry` });
      expect(by["undeclared:read_ticket"]).toMatchObject({ divergence: "no_declared_purpose", suggestedResponse: "advise", declared: null });

      const audits = await sdb.select().from(auditLog).where(eq(auditLog.ruleId, GOAL_ALIGNMENT_RULE_IDS.observed));
      expect(audits).toHaveLength(4);
      expect(audits.every((a) => a.objectType === "goal_alignment" && (a.detail as { mode?: string }).mode === "shadow")).toBe(true);

      // a later divergent call on the same day adds to the finding, with no new audit row
      await backdated(sdb).insert(auditLog).values(call(declaredAgent, { serverId: srv!.id, toolName: "delete_repo" }));
      expect((await runGoalAlignmentSweep(sdb)).findings).toBe(0);
      const [again] = await sdb.select().from(goalAlignmentFindings).where(eq(goalAlignmentFindings.id, by["declared:delete_repo"]!.id));
      expect(again!.callCount).toBe(3);
      expect(await sdb.select().from(auditLog).where(eq(auditLog.ruleId, GOAL_ALIGNMENT_RULE_IDS.observed))).toHaveLength(4);

      // off (the behaviour engine's one switch) moves to the head without judging
      await sdb.insert(behaviourBaselineSettings).values({ id: 1, mode: "off" });
      await backdated(sdb).insert(auditLog).values(call(undeclaredAgent, { serverId: srv!.id, toolName: "delete_repo" }));
      expect(await runGoalAlignmentSweep(sdb)).toMatchObject({ ran: true, mode: "off", findings: 0 });
      await sdb.delete(behaviourBaselineSettings);
      expect((await runGoalAlignmentSweep(sdb)).findings).toBe(0);
      expect(await sdb.select().from(goalAlignmentFindings)).toHaveLength(4);
    } finally {
      await dropScratchDatabase(admin, name);
    }
  });
});

describe("ADR-0359 §7 API: declared purposes and findings", () => {
  const BOOT = "adr0359-ga-bootstrap-token";
  const AUTH = { authorization: `Bearer ${BOOT}` };
  let db: Db;
  let app: ReturnType<typeof buildApp>;
  let adminId: string;
  let KEY: { authorization: string };
  let identity: string;
  let toolA: string;
  let toolB: string;
  const restores: Array<() => Promise<void>> = [];
  const asSession = async () => sessionRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { unrelated: true } }));
  const asSteppedUp = async (facts: Record<string, unknown>) =>
    stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));

  beforeAll(async () => {
    db = createDb(DATABASE_URL!);
    await runMigrations(db, migrationsFolder);
    restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
    app = buildApp(db, { bootstrapToken: BOOT });
    const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0359-ga-admin-${RUN}@example.com`, displayName: "goal admin", isAdmin: true } });
    expect(created.statusCode, created.body).toBe(201);
    adminId = created.json().id;
    const key = await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0359-ga" } });
    KEY = { authorization: `Bearer ${key.json().token}` };
    identity = await makeAgentIdentity(db, adminId);
    const [srv] = await db.insert(mcpServers).values({ name: `ga-api-${RUN}`, url: "http://127.0.0.1:9/" }).returning({ id: mcpServers.id });
    const made = await db
      .insert(mcpTools)
      .values([
        { serverId: srv!.id, name: "read_ticket", kind: "read" },
        { serverId: srv!.id, name: "close_ticket", kind: "write" },
      ])
      .returning({ id: mcpTools.id, name: mcpTools.name });
    toolA = made.find((t) => t.name === "read_ticket")!.id;
    toolB = made.find((t) => t.name === "close_ticket")!.id;
  });

  afterAll(async () => {
    for (const restore of restores.reverse()) await restore();
    await app.close();
  });

  it("declares a purpose (narrowing, no step-up), reads it back, and refuses bad input", async () => {
    const none = await app.inject({ method: "GET", url: `/v1/goal-alignment/purposes/${identity}`, headers: KEY });
    expect(none.json()).toMatchObject({ purpose: null, mode: "shadow", enforcement: "none" });
    const put = await app.inject({ method: "PUT", url: `/v1/goal-alignment/purposes/${identity}`, headers: KEY, payload: { statement: "triage support tickets", tools: [{ kind: "mcp_tool", id: toolA }] } });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({ identityId: identity, version: 1, relaxed: false });
    const got = await app.inject({ method: "GET", url: `/v1/goal-alignment/purposes/${identity}`, headers: KEY });
    expect(got.json().purpose).toMatchObject({ version: 1, allowWrite: false, tools: [`mcp_tool:${toolA}`] });

    const markup = await app.inject({ method: "PUT", url: `/v1/goal-alignment/purposes/${identity}`, headers: KEY, payload: { statement: "<b>x</b>" } });
    expect(markup.statusCode).toBe(422);
    const unknown = await app.inject({ method: "PUT", url: `/v1/goal-alignment/purposes/${identity}`, headers: KEY, payload: { statement: "x", tools: [{ kind: "connector", id: randomUUID() }] } });
    expect(unknown.json().error).toBe("unknown_tool");
    const destructiveOnly = await app.inject({ method: "PUT", url: `/v1/goal-alignment/purposes/${identity}`, headers: KEY, payload: { statement: "x", allowDestructive: true } });
    expect(destructiveOnly.statusCode).toBe(400);
    const missing = await app.inject({ method: "PUT", url: `/v1/goal-alignment/purposes/${randomUUID()}`, headers: KEY, payload: { statement: "x" } });
    expect(missing.statusCode).toBe(404);
  });

  it("treats widening as a step-up relaxation and records it; narrowing needs none", async () => {
    const payload = { statement: "triage and close support tickets", allowWrite: true, tools: [{ kind: "mcp_tool", id: toolA }, { kind: "mcp_tool", id: toolB }] };
    const refused = await app.inject({ method: "PUT", url: `/v1/goal-alignment/purposes/${identity}`, ...(await asSession()), payload });
    expect([403, 422], refused.body).toContain(refused.statusCode);
    const facts = { goalAlignment: "purpose", identityId: identity, fromVersion: 1, addedTools: `mcp_tool:${toolB}`, allowWrite: true, allowDestructive: false, allowOpenWorld: false };
    const ok = await app.inject({ method: "PUT", url: `/v1/goal-alignment/purposes/${identity}`, ...(await asSteppedUp(facts)), payload });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toEqual({ identityId: identity, version: 2, relaxed: true });
    const narrow = await app.inject({ method: "PUT", url: `/v1/goal-alignment/purposes/${identity}`, headers: KEY, payload: { statement: "triage support tickets", tools: [{ kind: "mcp_tool", id: toolA }] } });
    expect(narrow.json()).toEqual({ identityId: identity, version: 3, relaxed: false });
    const rows = await db.select().from(auditLog).where(eq(auditLog.objectId, identity));
    const declared = rows.filter((r) => r.ruleId === GOAL_ALIGNMENT_RULE_IDS.declared).map((r) => (r.detail as { relaxation: boolean; version: number }));
    expect(declared.map((d) => [d.version, d.relaxation]).sort()).toEqual([[1, false], [2, true], [3, false]]);
  });

  it("lists findings and walks the declared status lifecycle", async () => {
    const [f] = await db
      .insert(goalAlignmentFindings)
      .values({
        day: "2026-11-20",
        identityId: identity,
        divergence: "tool_not_declared",
        divergences: ["tool_not_declared"],
        suggestedResponse: "correct",
        targetKind: "mcp_tool",
        targetKey: toolB,
        targetName: "close_ticket",
        observedWrite: true,
        observedDestructive: false,
        observedOpenWorld: false,
        declared: null,
        firstSeq: 1,
        lastSeq: 1,
        explanation: "fixture",
      })
      .returning({ id: goalAlignmentFindings.id });
    const list = await app.inject({ method: "GET", url: `/v1/goal-alignment/findings?identityId=${identity}`, headers: KEY });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({ mode: "shadow", enforcement: "none", next: null });
    expect(list.json().findings[0]).toMatchObject({ id: f!.id, status: "open", allowedNext: ["acknowledged", "dismissed"] });
    const ack = await app.inject({ method: "PUT", url: `/v1/goal-alignment/findings/${f!.id}/status`, headers: KEY, payload: { status: "acknowledged" } });
    expect(ack.json()).toEqual({ id: f!.id, status: "acknowledged" });
    const back = await app.inject({ method: "PUT", url: `/v1/goal-alignment/findings/${f!.id}/status`, headers: KEY, payload: { status: "acknowledged" } });
    expect(back.statusCode).toBe(409);
    const dismiss = await app.inject({ method: "PUT", url: `/v1/goal-alignment/findings/${f!.id}/status`, headers: KEY, payload: { status: "dismissed" } });
    expect(dismiss.json().status).toBe("dismissed");
    const nf = await app.inject({ method: "PUT", url: `/v1/goal-alignment/findings/${randomUUID()}/status`, headers: KEY, payload: { status: "dismissed" } });
    expect(nf.statusCode).toBe(404);
  });
});
