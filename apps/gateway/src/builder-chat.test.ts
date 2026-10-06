/**
 * ADR-0172 — builder chat through the governed dispatch core, the spend limit,
 * threads/inbox, usage aggregation, and the schedule sweep.
 *
 * The model is the keyless mock provider bound in the agent registry, priced
 * so every reply has a measurable cost. Each refusal is asserted with its
 * positive control beside it (the same call succeeding when the rule allows).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, auditLog, builderAgentSchedules, builderMessages, builderThreads, eq, usageEvents } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { schedulerJobRegistry, SCHEDULER_JOB_NAMES } from "./scheduler-jobs.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

let k: BuilderKit;
let owner: Person;
let colleague: Person;
let pricedModel = "";
let undispatchable = "";

const newAgent = async (who: Person, extra: Record<string, unknown> = {}) => {
  const r = await k.req("POST", "/v1/builder/agents", who.auth, {
    name: `Chat agent ${Math.random().toString(36).slice(2, 7)}`,
    connectionFormat: "shared",
    computerUse: false,
    projectId: who.projectId,
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().agent as Record<string, any>;
};
const usageCount = async (userId: string) =>
  (await k.db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.userId, userId))).length;

beforeAll(async () => {
  k = await builderKit("bld-chat");
  restoreSb2Gates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false, dispatchAttributionRequired: false });
  owner = await k.person("owner");
  colleague = await k.person("colleague");
  // $100k per million tokens: any reply costs well over a cent
  pricedModel = await k.model("priced", { price: 100_000 });
  // the colleague uses the owner's shared agents, which bill to the owner's
  // project: a non-member is refused (not_a_project_member) before the model
  const member = await k.req("POST", `/v1/projects/${owner.projectId}/members`, k.BOOT, { userId: colleague.id, role: "contributor" });
  expect(member.statusCode, member.body).toBeLessThan(300);
  undispatchable = await k.model("no-model-id", { model: null });
  await k.grantModel(owner.id, pricedModel);
  await k.grantModel(owner.id, undispatchable);
}, 120_000);

afterAll(async () => {
  await restoreSb2Gates();
  await k.close();
});

describe("chat through the governed core", () => {
  it("dispatches as the caller, records both messages with model and cost, and continues a thread", async () => {
    const a = await newAgent(owner, { modelAgentId: pricedModel });
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { instructions: "# Be brief" });
    await k.req("POST", `/v1/builder/agents/${a.id}/memory`, owner.auth, { content: "the team is called Northwind" });
    const before = await usageCount(owner.id);
    const r = await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { message: "Summarise our AI policy" });
    expect(r.statusCode, r.body).toBe(200);
    const { thread, messages } = r.json();
    expect(thread).toMatchObject({ agentId: a.id, agentName: a.name, status: "active", source: "chat", title: "Summarise our AI policy" });
    expect(messages.map((m: { role: string }) => m.role)).toEqual(["user", "agent"]);
    const reply = messages[1];
    expect(reply.model).toBe("mock-balanced");
    expect(reply.costUsd).toBeGreaterThan(0.01);
    expect(reply.latencyMs).toBeGreaterThanOrEqual(0);
    expect(reply.content.length).toBeGreaterThan(0);
    // POSITIVE CONTROL that the governed core really ran: it metered the call
    expect(await usageCount(owner.id)).toBe(before + 1);
    // the decision row carries the builder ids
    const decisions = await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, owner.id), eq(auditLog.objectType, "agent"), eq(auditLog.objectId, pricedModel)));
    expect(decisions.some((d) => (d.detail as Record<string, unknown>)?.["builderThreadId"] === thread.id)).toBe(true);

    const second = await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { threadId: thread.id, message: "Shorter" });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().thread.id).toBe(thread.id);
    const full = await k.req("GET", `/v1/builder/threads/${thread.id}`, owner.auth);
    expect(full.json().messages).toHaveLength(4);
    expect((await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).json().agent.spentThisMonthUsd).toBeGreaterThan(0.02);
  });

  it("returns a core refusal with its status and code unchanged, and leaves a system note in the thread", async () => {
    const a = await newAgent(owner, { modelAgentId: undispatchable });
    const r = await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { message: "hello" });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("agent_not_dispatchable");
    const t = await k.req("GET", `/v1/builder/threads/${r.json().threadId}`, owner.auth);
    expect(t.json().thread.status).toBe("needs_attention");
    expect(t.json().messages.map((m: { role: string }) => m.role)).toEqual(["user", "system"]);
    expect(t.json().messages[1].content).toContain("agent_not_dispatchable");
  });

  it("a shared agent runs with the CALLER's entitlements: a colleague without the model grant is refused (agent_denied)", async () => {
    const a = await newAgent(owner, { modelAgentId: pricedModel });
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { sharing: "workspace" });
    const before = await usageCount(colleague.id);
    const r = await k.req("POST", `/v1/builder/agents/${a.id}/chat`, colleague.auth, { message: "use your owner's model for me" });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("agent_denied");
    expect(await usageCount(colleague.id)).toBe(before);
    // positive control: once the colleague holds the grant, the same call runs — billed to them
    const grantId = await k.grantModel(colleague.id, pricedModel);
    const ok = await k.req("POST", `/v1/builder/agents/${a.id}/chat`, colleague.auth, { message: "now?" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await usageCount(colleague.id)).toBe(before + 1);
    expect((await k.req("DELETE", `/v1/grants/agents/${grantId}`, k.BOOT)).statusCode).toBeLessThan(300);
  });

  it("an invisible agent is a 404; another person's thread cannot be continued", async () => {
    const a = await newAgent(owner, { modelAgentId: pricedModel });
    expect((await k.req("POST", `/v1/builder/agents/${a.id}/chat`, colleague.auth, { message: "hi" })).statusCode).toBe(404);
    const mine = await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { message: "mine" });
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { sharing: "workspace" });
    const steal = await k.req("POST", `/v1/builder/agents/${a.id}/chat`, colleague.auth, { threadId: mine.json().thread.id, message: "x" });
    expect(steal.statusCode).toBe(403);
    expect((await k.req("GET", `/v1/builder/threads/${mine.json().thread.id}`, colleague.auth)).statusCode).toBe(404);
  });
});

describe("the monthly spend limit", () => {
  it("refuses with 402 agent_spend_limit_reached once recorded spend reaches the limit — before any dispatch", async () => {
    const a = await newAgent(owner, { modelAgentId: pricedModel });
    const first = await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { message: "spend something" });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().messages[1].costUsd).toBeGreaterThan(0.01);
    // positive control: a limit above the spend still allows the call
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { monthlyLimitUsd: 100_000 });
    expect((await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { message: "still fine" })).statusCode).toBe(200);

    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { monthlyLimitUsd: 0.01 });
    const before = await usageCount(owner.id);
    const r = await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { message: "one more" });
    expect(r.statusCode).toBe(402);
    expect(r.json().error).toBe("agent_spend_limit_reached");
    expect(await usageCount(owner.id)).toBe(before);
    const denied = await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, a.id), eq(auditLog.ruleId, "builder-agent-spend-limit-reached")));
    expect(denied).toHaveLength(1);
    // clearing the limit restores service
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { monthlyLimitUsd: null });
    expect((await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { message: "ok again" })).statusCode).toBe(200);
  });
});

describe("threads and inbox", () => {
  it("filters by status and agent, and PATCH moves a thread between tabs", async () => {
    const a = await newAgent(owner, { modelAgentId: pricedModel });
    const b = await newAgent(owner, { modelAgentId: undispatchable });
    const okThread = (await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { message: "first thread" })).json().thread;
    const badThreadId = (await k.req("POST", `/v1/builder/agents/${b.id}/chat`, owner.auth, { message: "refused thread" })).json().threadId;

    const list = async (q: string) =>
      ((await k.req("GET", `/v1/builder/threads${q}`, owner.auth)).json().threads as Array<{ id: string; status: string }>).map((t) => t.id);
    expect(await list(`?agentId=${a.id}`)).toEqual([okThread.id]);
    expect(await list("?status=needs_attention")).toContain(badThreadId);
    expect(await list("?status=needs_attention")).not.toContain(okThread.id);
    expect(await list("?status=completed")).not.toContain(okThread.id);

    const patched = await k.req("PATCH", `/v1/builder/threads/${okThread.id}`, owner.auth, { status: "completed" });
    expect(patched.json().thread.status).toBe("completed");
    expect(await list("?status=completed")).toContain(okThread.id);
    const all = (await k.req("GET", "/v1/builder/threads?status=all", owner.auth)).json().threads as Array<Record<string, unknown>>;
    const row = all.find((t) => t["id"] === okThread.id)!;
    expect(row["lastMessagePreview"]).toBeTruthy();
    expect(row["agentColor"]).toMatch(/^#/);
    // colleague sees none of these
    expect(((await k.req("GET", "/v1/builder/threads", colleague.auth)).json().threads as Array<{ id: string }>).some((t) => t.id === okThread.id)).toBe(false);
  });
});

describe("usage", () => {
  it("aggregates spend and replies by agent, user, model and day; non-admins see their agents and their own use", async () => {
    const a = await newAgent(owner, { modelAgentId: pricedModel });
    await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { message: "usage one" });
    await k.req("POST", `/v1/builder/agents/${a.id}/chat`, owner.auth, { message: "usage two" });
    const recorded = await k.db.select().from(builderMessages).where(and(eq(builderMessages.agentId, a.id), eq(builderMessages.role, "agent")));
    const expected = recorded.reduce((s, m) => s + (m.costUsd ?? 0), 0);

    const r = await k.req("GET", "/v1/builder/usage?days=7", owner.auth);
    expect(r.statusCode, r.body).toBe(200);
    const u = r.json();
    expect(u.daily).toHaveLength(7);
    expect(u.daily[6].date).toBe(new Date().toISOString().slice(0, 10));
    const row = u.byAgent.find((x: { agentId: string }) => x.agentId === a.id);
    expect(row.messages).toBe(2);
    expect(row.spendUsd).toBeCloseTo(expected, 5);
    expect(u.byModel.some((m: { provider: string; model: string }) => m.provider === "mock" && m.model === "mock-balanced")).toBe(true);
    expect(u.byUser.find((x: { userId: string }) => x.userId === owner.id).name).toBe(`owner ${k.RUN}`);
    expect(u.totals.spendUsd).toBeGreaterThanOrEqual(expected - 1e-6);
    expect(u.daily.reduce((s: number, d: { messages: number }) => s + d.messages, 0)).toBe(u.totals.messages);

    // the colleague owns no agent here and has not chatted on this one
    const theirs = (await k.req("GET", "/v1/builder/usage?days=30", colleague.auth)).json();
    expect(theirs.byAgent.some((x: { agentId: string }) => x.agentId === a.id)).toBe(false);
    expect((await k.req("GET", "/v1/builder/usage?days=9", owner.auth)).statusCode).toBe(400);
  });
});

describe("the schedule sweep", () => {
  it("runs a due schedule AS THE OWNER into a needs-attention schedule thread, once (idempotent)", async () => {
    const a = await newAgent(owner, { modelAgentId: pricedModel });
    await k.req("PATCH", `/v1/builder/agents/${a.id}`, owner.auth, { sharing: "workspace" });
    const s = (
      await k.req("POST", `/v1/builder/agents/${a.id}/schedules`, owner.auth, {
        name: "Digest", cadence: "daily", timeUtc: "06:00", prompt: "Write the digest", enabled: true,
      })
    ).json();
    const due = new Date(Date.now() - 60_000);
    await k.db.update(builderAgentSchedules).set({ nextRunAt: due }).where(eq(builderAgentSchedules.id, s.id));
    const usageBefore = await usageCount(owner.id);

    // the sweep route is an operator act: a non-admin is refused by the default gate
    expect((await k.req("POST", "/v1/builder/schedules/sweep", owner.auth)).statusCode).toBe(403);
    const first = await k.req("POST", "/v1/builder/schedules/sweep", k.BOOT);
    expect(first.statusCode, first.body).toBe(200);
    const threads = await k.db.select().from(builderThreads).where(eq(builderThreads.scheduleId, s.id));
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ userId: owner.id, source: "schedule", status: "needs_attention", agentId: a.id });
    expect(first.json().threadIds).toContain(threads[0]!.id);
    // billed to the OWNER — the identity it ran as
    expect(await usageCount(owner.id)).toBe(usageBefore + 1);
    const msgs = await k.db.select().from(builderMessages).where(eq(builderMessages.threadId, threads[0]!.id));
    expect(msgs.map((m) => m.role).sort()).toEqual(["agent", "user"]);
    const [after] = await k.db.select().from(builderAgentSchedules).where(eq(builderAgentSchedules.id, s.id));
    expect(after!.lastRunAt).not.toBeNull();
    expect(after!.nextRunAt!.getTime()).toBeGreaterThan(Date.now());

    // idempotent: a second sweep finds nothing due for this schedule
    const second = await k.req("POST", "/v1/builder/schedules/sweep", k.BOOT);
    expect(second.statusCode).toBe(200);
    expect(await k.db.select().from(builderThreads).where(eq(builderThreads.scheduleId, s.id))).toHaveLength(1);
    expect(await usageCount(owner.id)).toBe(usageBefore + 1);

    // it lands in the owner's inbox, not the colleague's
    const inbox = (await k.req("GET", "/v1/builder/threads?status=needs_attention", owner.auth)).json().threads as Array<{ id: string; source: string }>;
    expect(inbox.find((t) => t.id === threads[0]!.id)?.source).toBe("schedule");
    expect(((await k.req("GET", "/v1/builder/threads", colleague.auth)).json().threads as Array<{ id: string }>).some((t) => t.id === threads[0]!.id)).toBe(false);
  });

  it("a disabled schedule never runs", async () => {
    const a = await newAgent(owner, { modelAgentId: pricedModel });
    const s = (
      await k.req("POST", `/v1/builder/agents/${a.id}/schedules`, owner.auth, {
        name: "Off", cadence: "hourly", timeUtc: "00:05", prompt: "x", enabled: false,
      })
    ).json();
    await k.db.update(builderAgentSchedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(builderAgentSchedules.id, s.id));
    await k.req("POST", "/v1/builder/schedules/sweep", k.BOOT);
    expect(await k.db.select().from(builderThreads).where(eq(builderThreads.scheduleId, s.id))).toHaveLength(0);
  });

  it("is registered as the scheduler job builder-agent-schedules", () => {
    const job = schedulerJobRegistry().get(SCHEDULER_JOB_NAMES.builderAgentSchedules);
    expect(job?.name).toBe("builder-agent-schedules");
    expect(job?.adr).toBe("ADR-0172");
  });
});
