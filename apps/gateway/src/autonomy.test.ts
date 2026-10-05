/**
 * ADR-0180 §5 (A8) — the agent autonomy class, against the real schema:
 * every derivation rule read from its own table, the access check, the audited
 * declaration, the project join and the floors as unmet conditions, and the
 * monitor loader. Each rule is asserted on both sides (the fact present lifts
 * the class; absent, or the near-miss row, does not).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiUseCases,
  and,
  auditLog,
  builderAgentChannels,
  builderAgentSchedules,
  builderAgentSubagents,
  builderAgentTools,
  builderAgents,
  builderMessages,
  builderThreads,
  builderToolSteps,
  chatopsConnections,
  connectors,
  eq,
  evalDatasets,
  evalRuns,
  guardrailConfigs,
  inArray,
  mcpServers,
  mcpTools,
  modelCardApprovals,
  modelCards,
  redteamLibraries,
  redteamRuns,
  sql,
} from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { AUTONOMY_DECLARED_RULE_ID, AUTONOMY_READ_RULE_ID, autonomyFloorFor, autonomyMonitorInput } from "./autonomy.js";

/** an autonomy floor is always a measured condition; the union also admits manual ones */
const paramsOf = (c: { kind: string }): Record<string, unknown> =>
  "params" in c ? ((c as { params: Record<string, unknown> }).params ?? {}) : {};

let k: BuilderKit;
let owner: Person;
let colleague: Person;
let admin: Person;
let model = "";
let writeTool = "";
let readTool = "";
let connectorId = "";
let chatId = "";
let serverId = "";
const useCaseIds: string[] = [];

const newAgent = async (who: Person, extra: Record<string, unknown> = {}) => {
  const r = await k.req("POST", "/v1/builder/agents", who.auth, {
    name: `Auto ${Math.random().toString(36).slice(2, 7)}`,
    connectionFormat: "shared",
    computerUse: false,
    projectId: who.projectId,
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().agent as { id: string; name: string };
};
const get = (id: string, who: Person) => k.req("GET", `/v1/builder/agents/${id}/autonomy`, who.auth);
const observed = async (id: string) => {
  const r = await get(id, owner);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().autonomy.observed.class as string;
};
const addTool = (agentId: string, kind: "mcp_tool" | "connector", refId: string, requiresApproval: boolean) =>
  k.db.insert(builderAgentTools).values({ agentId, kind, refId, requiresApproval });
const newUseCase = async (projectId: string | null, status: "proposed" | "rejected" = "proposed") => {
  const [u] = await k.db
    .insert(aiUseCases)
    .values({
      name: `uc-${k.RUN}-${Math.random().toString(36).slice(2, 6)}`,
      description: "d",
      ownerUserId: owner.id,
      businessContext: "b",
      dataSensitivity: "internal",
      projectId,
      status,
    })
    .returning();
  useCaseIds.push(u!.id);
  return u!;
};
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000);
/** a chat thread with one agent message, for tool steps */
async function turn(agentId: string, source: "chat" | "schedule" | "channel" = "chat", updatedAt = new Date()) {
  const [th] = await k.db.insert(builderThreads).values({ agentId, userId: owner.id, title: "t", source, updatedAt }).returning();
  const [msg] = await k.db.insert(builderMessages).values({ threadId: th!.id, agentId, userId: owner.id, role: "agent", content: "x" }).returning();
  return { threadId: th!.id, messageId: msg!.id };
}
let seq = 0;
const step = (agentId: string, t: { threadId: string; messageId: string }, over: Partial<typeof builderToolSteps.$inferInsert>) =>
  k.db.insert(builderToolSteps).values({
    threadId: t.threadId,
    messageId: t.messageId,
    agentId,
    userId: owner.id,
    turn: 1,
    seq: ++seq,
    kind: "mcp_tool",
    refId: writeTool,
    name: "docs__write",
    displayName: "write",
    argumentsDigest: "d",
    status: "done",
    ...over,
  });

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  k = await builderKit("a8-auto");
  // ADR-0181: the shipped guardrail posture now meets the warn/block floors. This file
  // pins each floor coming back as unmet, so it starts from the pre-strict all-log posture.
  restoreSb1Posture = await relaxDataPostureForTest(k.db, { org: false, interception: false });
  [owner, colleague] = await Promise.all([k.person("owner"), k.person("colleague")]);
  admin = await k.person("admin", { admin: true });
  model = await k.model("m");
  await k.grantModel(owner.id, model);
  const [server] = await k.db.insert(mcpServers).values({ name: `a8-mcp-${k.RUN}`, url: "https://mcp.example.com/a8" }).returning();
  serverId = server!.id;
  const tools = await k.db
    .insert(mcpTools)
    .values([
      { serverId, name: "search", kind: "read" },
      { serverId, name: "write_page", kind: "write" },
    ])
    .returning();
  readTool = tools.find((t) => t.kind === "read")!.id;
  writeTool = tools.find((t) => t.kind === "write")!.id;
  const [conn] = await k.db.insert(connectors).values({ name: `a8-slack-${k.RUN}`, kind: "slack", providerKind: "slack" }).returning();
  connectorId = conn!.id;
  // DISABLED, so it can never become another suite's default destination (M-068); removed in afterAll
  const [chat] = await k.db
    .insert(chatopsConnections)
    .values({ name: `a8-slack-${k.RUN}`, provider: "slack", connectorId, defaultChannel: "#a8", enabled: false, signingSecretCiphertext: "synthetic-not-a-secret" })
    .returning();
  chatId = chat!.id;
}, 120_000);

afterAll(async () => {
  await restoreSb1Posture?.();
  if (useCaseIds.length) await k.db.delete(aiUseCases).where(inArray(aiUseCases.id, useCaseIds));
  if (chatId) {
    await k.db.delete(builderAgentChannels).where(eq(builderAgentChannels.chatopsConnectionId, chatId));
    await k.db.delete(chatopsConnections).where(eq(chatopsConnections.id, chatId));
  }
  if (model) await k.db.delete(guardrailConfigs).where(and(eq(guardrailConfigs.scope, "agent"), eq(guardrailConfigs.scopeId, model)));
  await k.close();
});

describe("derivation from the builder tables (one rule each, both sides)", () => {
  it("a fresh agent with nothing is assist, and says why in plain language", async () => {
    const a = await newAgent(owner);
    const r = (await get(a.id, owner)).json().autonomy;
    expect(r.observed.class).toBe("assist");
    expect(r.observed.reasons).toEqual([]);
    expect(r.declared).toBeNull();
    expect(r.effective).toBe("assist");
    expect(r.floors).toEqual([]);
    expect(r.scope).toMatch(/^Agents linked by project/);
  });

  it("R1: an ENABLED schedule makes it autonomous; a disabled one does not", async () => {
    const a = await newAgent(owner);
    await k.db.insert(builderAgentSchedules).values({ agentId: a.id, name: "s", cadence: "daily", timeUtc: "09:00", prompt: "p", enabled: false });
    expect(await observed(a.id)).toBe("assist");
    await k.db.insert(builderAgentSchedules).values({ agentId: a.id, name: "s2", cadence: "daily", timeUtc: "09:00", prompt: "p", enabled: true });
    expect(await observed(a.id)).toBe("autonomous");
  });

  it("R2: a Slack channel bound to a connection makes it autonomous; an unbound or send-only one does not", async () => {
    const a = await newAgent(owner);
    await k.db.insert(builderAgentChannels).values({ agentId: a.id, provider: "slack" });
    await k.db.insert(builderAgentChannels).values({ agentId: a.id, provider: "outlook", chatopsConnectionId: chatId });
    expect(await observed(a.id)).toBe("assist");
    await k.db.insert(builderAgentChannels).values({ agentId: a.id, provider: "slack", chatopsConnectionId: chatId });
    expect(await observed(a.id)).toBe("autonomous");
  });

  it("R3: an observed unattended run in the window makes it autonomous; a chat or an old run does not", async () => {
    const a = await newAgent(owner);
    await turn(a.id, "chat");
    await turn(a.id, "schedule", daysAgo(45));
    expect(await observed(a.id)).toBe("assist");
    await turn(a.id, "channel");
    expect(await observed(a.id)).toBe("autonomous");
  });

  it("R4: a live sub-agent makes it delegated; an archived child does not", async () => {
    const a = await newAgent(owner);
    const child = await newAgent(owner);
    await k.db.insert(builderAgentSubagents).values({ parentId: a.id, childId: child.id, name: "c" });
    expect(await observed(a.id)).toBe("delegated");
    await k.db.update(builderAgents).set({ archivedAt: new Date() }).where(eq(builderAgents.id, child.id));
    expect(await observed(a.id)).toBe("assist");
  });

  it("R5/R8: a write tool without Ask-first is delegated; with Ask-first, or a read tool, it is supervised", async () => {
    const a = await newAgent(owner);
    await addTool(a.id, "mcp_tool", readTool, false);
    await addTool(a.id, "mcp_tool", writeTool, true);
    expect(await observed(a.id)).toBe("supervised");
    await k.db.update(builderAgentTools).set({ requiresApproval: false }).where(eq(builderAgentTools.agentId, a.id));
    expect(await observed(a.id)).toBe("delegated");
  });

  it("R5: every connector can write, so a connector without Ask-first is delegated", async () => {
    const a = await newAgent(owner);
    await addTool(a.id, "connector", connectorId, true);
    expect(await observed(a.id)).toBe("supervised");
    await k.db.update(builderAgentTools).set({ requiresApproval: false }).where(eq(builderAgentTools.agentId, a.id));
    expect(await observed(a.id)).toBe("delegated");
  });

  it("R5: a dangling tool reference cannot run and counts for nothing", async () => {
    const a = await newAgent(owner);
    await addTool(a.id, "mcp_tool", "00000000-0000-4000-8000-00000000dead", false);
    expect(await observed(a.id)).toBe("assist");
  });

  it("R6: computer use makes it delegated", async () => {
    const a = await newAgent(owner, { computerUse: true });
    expect(await observed(a.id)).toBe("delegated");
  });

  it("R7/R9: an observed unconfirmed write is delegated; a confirmed or approved one, or a read, is supervised", async () => {
    const a = await newAgent(owner);
    const t = await turn(a.id);
    await step(a.id, t, { requiresConfirmation: true });
    await step(a.id, t, { refId: readTool });
    await step(a.id, t, { kind: "connector", refId: connectorId, arguments: { operation: "read" } });
    await step(a.id, t, { status: "denied" });
    expect(await observed(a.id)).toBe("supervised");
    await step(a.id, t, {});
    expect(await observed(a.id)).toBe("delegated");
    const b = await newAgent(owner);
    await step(b.id, await turn(b.id), { kind: "connector", refId: connectorId, arguments: { withheld: "x" } });
    expect(await observed(b.id)).toBe("delegated");
  });
});

describe("access: the agent's owner or an admin", () => {
  it("an outsider gets 404 (no probing), a viewer of a shared agent 403, the owner and an admin 200", async () => {
    const a = await newAgent(owner);
    expect((await get(a.id, colleague)).statusCode).toBe(404);
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { sharing: "workspace" });
    const g = await get(a.id, colleague);
    expect(g.statusCode).toBe(403);
    expect(g.json().error).toBe("not_agent_steward");
    const p = await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, colleague.auth, { class: "assist", note: "mine now" });
    expect(p.statusCode).toBe(403);
    expect((await k.db.select().from(builderAgents).where(eq(builderAgents.id, a.id)))[0]!.declaredAutonomyClass).toBeNull();
    expect((await get(a.id, owner)).statusCode).toBe(200);
    expect((await get(a.id, admin)).statusCode).toBe(200);
    // an admin reading another person's agent is audited; the owner's own read is not
    const reads = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, a.id), eq(auditLog.ruleId, AUTONOMY_READ_RULE_ID)));
    expect(reads.map((r) => r.userId)).toEqual([admin.id]);
  });

  it("an identity-less token is refused by name", async () => {
    const a = await newAgent(owner);
    const r = await k.req("GET", `/v1/builder/agents/${a.id}/autonomy`, k.BOOT);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("builder_requires_identity");
  });
});

describe("the declaration (PUT)", () => {
  it("declaring below observed is allowed, flagged, audited old→new, and never lowers the floor", async () => {
    const a = await newAgent(owner);
    await k.db.insert(builderAgentSchedules).values({ agentId: a.id, name: "s", cadence: "daily", timeUtc: "09:00", prompt: "p", enabled: true });
    const r = await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, owner.auth, { class: "supervised", note: "only runs reports" });
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.flag.code).toBe("declared_below_observed");
    expect(body.autonomy).toMatchObject({ declaredBelowObserved: true, effective: "autonomous", observed: { class: "autonomous" } });
    expect(body.autonomy.declared).toMatchObject({ class: "supervised", note: "only runs reports", declaredBy: { id: owner.id } });
    expect(body.autonomy.floors.map((f: { id: string }) => f.id)).toContain("monthly_limit_set");

    const second = await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, admin.auth, { class: "autonomous", note: "it runs on a timer" });
    expect(second.json().flag).toBeUndefined();
    expect(second.json().autonomy.declaredBelowObserved).toBe(false);
    const withdraw = await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, owner.auth, { class: null });
    expect(withdraw.json().autonomy.declared).toBeNull();

    const rows = await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, a.id), eq(auditLog.ruleId, AUTONOMY_DECLARED_RULE_ID)))
      .orderBy(auditLog.at);
    expect(rows.map((x) => [x.userId, (x.detail as any).from.class, (x.detail as any).to.class, (x.detail as any).declaredBelowObserved])).toEqual([
      [owner.id, null, "supervised", true],
      [admin.id, "supervised", "autonomous", false],
      [owner.id, "autonomous", null, false],
    ]);
  });

  it("declaring above observed applies the stricter floor", async () => {
    const a = await newAgent(owner);
    const r = await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, owner.auth, { class: "delegated", note: "will get tools soon" });
    expect(r.json().autonomy).toMatchObject({ effective: "delegated", observed: { class: "assist" }, declaredBelowObserved: false });
    expect(r.json().autonomy.floors.map((f: { id: string }) => f.id)).toEqual([
      "guardrails_warn",
      "guardrails_block",
      "model_card_approved",
      "agentic_redteam_measured",
    ]);
  });

  it("a class needs a note; an unknown class is refused; the note is credential-scrubbed", async () => {
    const a = await newAgent(owner);
    expect((await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, owner.auth, { class: "assist" })).statusCode).toBe(400);
    expect((await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, owner.auth, { class: "rogue", note: "x" })).statusCode).toBe(400);
    const r = await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, owner.auth, { class: "assist", note: "key AKIAIOSFODNN7EXAMPLE pasted" });
    expect(r.statusCode).toBe(200);
    const [row] = await k.db.select().from(builderAgents).where(eq(builderAgents.id, a.id));
    expect(row!.autonomyNote).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(row!.autonomyNote).toContain("[redacted:");
  });

  it("FA10 finding 7b: a note the scrub lengthens past the limit is a 422, not a 500, and nothing changes", async () => {
    const a = await newAgent(owner);
    // 2000 characters as typed; the redaction marker is longer than the key it replaces
    const note = `${"x".repeat(1979)} AKIAIOSFODNN7EXAMPLE`;
    expect(note).toHaveLength(2000);
    const r = await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, owner.auth, { class: "assist", note });
    expect(r.statusCode, r.body).toBe(422);
    expect(r.json().error).toBe("autonomy_note_too_long");
    const [row] = await k.db.select().from(builderAgents).where(eq(builderAgents.id, a.id));
    expect(row!.declaredAutonomyClass).toBeNull();
    const audits = await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, a.id), eq(auditLog.ruleId, AUTONOMY_DECLARED_RULE_ID)));
    expect(audits).toHaveLength(0);
  });

  it("FA10 finding 7b: the declaration and its audit row commit together (a failed audit leaves no declaration)", async () => {
    const a = await newAgent(owner);
    await k.db.execute(sql.raw(`
      CREATE OR REPLACE FUNCTION fa10_test_reject_autonomy_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.rule_id = '${AUTONOMY_DECLARED_RULE_ID}' AND NEW.object_id = '${a.id}' THEN
          RAISE EXCEPTION 'fa10 injected audit failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fa10_test_reject_autonomy_audit BEFORE INSERT ON audit_log
      FOR EACH ROW EXECUTE FUNCTION fa10_test_reject_autonomy_audit();
    `));
    try {
      const r = await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, owner.auth, { class: "supervised", note: "unaudited?" });
      expect(r.statusCode).toBe(500);
    } finally {
      await k.db.execute(sql.raw("DROP TRIGGER IF EXISTS fa10_test_reject_autonomy_audit ON audit_log"));
      await k.db.execute(sql.raw("DROP FUNCTION IF EXISTS fa10_test_reject_autonomy_audit()"));
    }
    const [row] = await k.db.select().from(builderAgents).where(eq(builderAgents.id, a.id));
    expect(row).toMatchObject({ declaredAutonomyClass: null, autonomyNote: null, autonomyDeclaredAt: null });
  });
});

describe("autonomyFloorFor: the project join and the floors", () => {
  it("counts only live agents billing to the use case's project, and states the limit", async () => {
    const a = await newAgent(owner);
    await k.db.insert(builderAgentSchedules).values({ agentId: a.id, name: "s", cadence: "daily", timeUtc: "09:00", prompt: "p", enabled: true });
    const linked = await newUseCase(owner.projectId);
    const other = await newUseCase(colleague.projectId);
    const loose = await newUseCase(null);

    const r = await autonomyFloorFor(k.db, linked);
    expect(r.scope).toBe("agents linked by project");
    expect(r.agents.map((x) => x.agentId)).toContain(a.id);
    expect(r.derived).toBe("autonomous");
    expect(r.facts.schedules).toBeGreaterThanOrEqual(1);
    expect(r.unmet.every((c) => c.kind === "autonomy_floor" && c.blocking)).toBe(true);
    expect(r.unmet.filter((c) => paramsOf(c)["builderAgentId"] === a.id).map((c) => paramsOf(c)["floor"])).toEqual(
      expect.arrayContaining(["guardrails_warn", "guardrails_block", "model_card_approved", "agentic_redteam_measured", "monthly_limit_set", "agentic_redteam_passing"]),
    );

    const none = await autonomyFloorFor(k.db, other);
    expect(none.agents.map((x) => x.agentId)).not.toContain(a.id);
    expect(await autonomyFloorFor(k.db, loose)).toMatchObject({ derived: null, declared: null, unmet: [], agents: [] });

    await k.db.update(builderAgents).set({ archivedAt: new Date() }).where(eq(builderAgents.id, a.id));
    expect((await autonomyFloorFor(k.db, linked)).agents.map((x) => x.agentId)).not.toContain(a.id);
  });

  it("an autonomous agent meeting every floor leaves nothing unmet; each control removed comes back as unmet", async () => {
    // a person with a project of their own, so no other agent shares it
    const solo = await k.person("solo");
    await k.grantModel(solo.id, model);
    const a = await newAgent(solo, { modelAgentId: model });
    await k.db.insert(builderAgentSchedules).values({ agentId: a.id, name: "s", cadence: "daily", timeUtc: "09:00", prompt: "p", enabled: true });
    await addTool(a.id, "mcp_tool", writeTool, true);
    const uc = await newUseCase(solo.projectId);
    const unmet = async () => [...new Set((await autonomyFloorFor(k.db, uc)).unmet.map((c) => paramsOf(c)["floor"]))].sort();
    expect(await unmet()).toEqual(
      ["agentic_redteam_measured", "agentic_redteam_passing", "guardrails_block", "guardrails_warn", "model_card_approved", "monthly_limit_set"].sort(),
    );

    await k.db.insert(guardrailConfigs).values({ scope: "agent", scopeId: model, promptInjectionMode: "block", jailbreakMode: "block" });
    const [card] = await k.db.insert(modelCards).values({ agentId: model, intendedUse: `a8 ${k.RUN}` }).returning();
    await k.db.insert(modelCardApprovals).values({
      cardId: card!.id,
      status: "approved",
      approverUserId: admin.id,
      decidedBy: admin.id,
      decidedAt: new Date(),
      validUntil: new Date(Date.now() + 90 * 86_400_000),
    });
    const [lib] = await k.db.insert(redteamLibraries).values({ name: `a8-lib-${k.RUN}` }).returning();
    const [ds] = await k.db.insert(evalDatasets).values({ name: `a8-ds-${k.RUN}` }).returning();
    const classes = (defeated: number) =>
      ["indirect_prompt_injection", "tool_abuse", "excessive_agency"].map((attackClass) => ({ attackClass, probes: 4, resisted: 4 - defeated, defeated }));
    const run = async (defeated: number, finishedAt: Date) => {
      const [ev] = await k.db
        .insert(evalRuns)
        .values({ datasetId: ds!.id, datasetVersion: 1, agentId: model, agentName: "m", trigger: "manual" })
        .returning();
      await k.db.insert(redteamRuns).values({
        libraryId: lib!.id,
        libraryName: lib!.name,
        libraryVersion: 1,
        evalRunId: ev!.id,
        agentId: model,
        agentName: "m",
        classSummary: classes(defeated),
        finishedAt,
      });
    };
    await run(0, daysAgo(40)); // too old: does not count
    expect(await unmet()).toContain("agentic_redteam_measured");
    await run(1, daysAgo(2)); // measured, but an attack succeeded
    expect(await unmet()).toEqual(["agentic_redteam_passing", "monthly_limit_set"]);
    await run(0, daysAgo(1)); // newest run passes
    expect(await unmet()).toEqual(["monthly_limit_set"]);
    await k.db.update(builderAgents).set({ monthlyLimitUsd: 25 }).where(eq(builderAgents.id, a.id));
    expect(await unmet()).toEqual([]);

    await k.db.update(builderAgentTools).set({ requiresApproval: false }).where(eq(builderAgentTools.agentId, a.id));
    expect(await unmet()).toEqual(["writes_ask_first_when_unattended"]);
  });
});

describe("the monitor loader", () => {
  it("reports declared-below-observed per agent and unmet floors per open use case and agent", async () => {
    const solo = await k.person("mon");
    const a = await newAgent(solo);
    await k.db.insert(builderAgentSchedules).values({ agentId: a.id, name: "s", cadence: "daily", timeUtc: "09:00", prompt: "p", enabled: true });
    await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, solo.auth, { class: "assist", note: "just a helper" });
    const open = await newUseCase(solo.projectId);
    const closed = await newUseCase(solo.projectId, "rejected");

    const out = await autonomyMonitorInput(k.db, new Date());
    const below = out.autonomy_declared_below_observed!.breaches.filter((b) => b.subjectKey === `builder_agent:${a.id}`);
    expect(below).toHaveLength(1);
    expect(below[0]!.detail).toMatchObject({ declared: "assist", observed: "autonomous", reasons: ["enabled_schedule"] });
    const floors = out.autonomy_floor_unmet!.breaches.filter((b) => b.subjectKey.endsWith(`builder_agent:${a.id}`));
    expect(floors.map((b) => b.subjectKey)).toEqual([`use_case:${open.id}>builder_agent:${a.id}`]);
    expect(floors[0]!.detail).toMatchObject({ autonomyClass: "autonomous", scope: "agents linked by project" });
    expect(out.autonomy_floor_unmet!.breaches.some((b) => b.subjectKey.startsWith(`use_case:${closed.id}`))).toBe(false);

    await k.req("PUT", `/v1/builder/agents/${a.id}/autonomy`, solo.auth, { class: "autonomous", note: "it runs on a timer" });
    const after = await autonomyMonitorInput(k.db, new Date());
    expect(after.autonomy_declared_below_observed!.breaches.some((b) => b.subjectKey === `builder_agent:${a.id}`)).toBe(false);
  });
});
