/**
 * ADR-0173 §1 — governed tool use in builder agents.
 *
 * The model is the keyless mock provider: a message containing
 * `<<use-tool:NAME>>` makes it ask for NAME once (and quote the tool result in
 * its final answer), `<<use-tool-loop:NAME>>` makes it ask on every step. The
 * tools live on a REAL local MCP server (the same harness shape as the
 * mcp-proxy / orchestration-tools suites), and every tool counts its own
 * invocations — the only honest proof that a call did or did not run.
 *
 * Every rule is asserted with its positive control beside it.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  and,
  approvals,
  auditLog,
  builderAgents,
  builderThreads,
  builderToolSteps,
  eq,
  mcpTools,
  sql,
  usageEvents,
} from "@regulait/db";
import { resolveModelProvider, type MockModelProvider } from "@regulait/model-provider";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { resolveToolbox, runGovernedTool } from "./builder-tools.js";
import { onBuilderTurnResumed } from "./builder-runtime.js";

let k: BuilderKit;
let owner: Person;
let colleague: Person;
let approver: Person;
let model = "";
let limitedModel = "";
let serverId = "";
let upstreamClose: () => Promise<void> = async () => {};
const mock = resolveModelProvider({ provider: "mock" }) as MockModelProvider;

/** invocations per tool, counted by the upstream itself */
const hits: Record<string, number> = {};
const TOOLS = ["get_time", "ask_first", "needs_approval", "early_approval", "flip_halt", "priced", "looper"] as const;
type ToolName = (typeof TOOLS)[number];
const toolIds: Partial<Record<ToolName, string>> = {};
const toolGrants: Partial<Record<ToolName, string>> = {};
let serverName = "";
/** the name the model sees: `server__tool` */
const modelName = (t: ToolName) => `${serverName}__${t}`;

function buildUpstream(): McpServer {
  const server = new McpServer({ name: "builder-tools-upstream", version: "0.0.1" });
  for (const name of TOOLS) {
    server.registerTool(name, { description: `test tool ${name}`, inputSchema: {}, annotations: { readOnlyHint: true } }, async () => {
      hits[name] = (hits[name] ?? 0) + 1;
      if (name === "flip_halt") {
        // the kill switch is thrown WHILE the loop is mid-turn
        const r = await k.req("PUT", "/v1/execution/mode", k.BOOT, { mode: "halted", reason: "builder-tools test: halt mid-loop" });
        if (r.statusCode >= 300) throw new Error(`halt failed: ${r.body}`);
      }
      return { content: [{ type: "text", text: name === "get_time" ? "12:00" : `${name} ran` }] };
    });
  }
  return server;
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = buildUpstream();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

const grantTool = async (userId: string, toolName: ToolName) => {
  const r = await k.req("POST", "/v1/grants/tools", k.BOOT, { userId, serverId, toolName });
  expect(r.statusCode, r.body).toBeLessThan(300);
  return r.json().id as string;
};

const newAgent = async (who: Person, tools: Array<{ tool: ToolName; askFirst?: boolean }>, extra: Record<string, unknown> = {}) => {
  const r = await k.req("POST", "/v1/builder/agents", who.auth, {
    name: `Tool agent ${Math.random().toString(36).slice(2, 7)}`,
    connectionFormat: "shared",
    computerUse: false,
    modelAgentId: model,
    projectId: who.projectId,
  });
  expect(r.statusCode, r.body).toBe(201);
  const agent = r.json().agent as Record<string, any>;
  if (Object.keys(extra).length) {
    const p = await k.req("PATCH", `/v1/builder/agents/${agent.id}`, who.auth, extra);
    expect(p.statusCode, p.body).toBe(200);
  }
  if (tools.length) {
    const t = await k.req("PUT", `/v1/builder/agents/${agent.id}/tools`, who.auth, {
      tools: tools.map((x) => ({ kind: "mcp_tool", refId: toolIds[x.tool], requiresApproval: !!x.askFirst })),
    });
    expect(t.statusCode, t.body).toBe(200);
  }
  return agent;
};

const chat = (who: Person, agentId: string, message: string, threadId?: string) =>
  k.req("POST", `/v1/builder/agents/${agentId}/chat`, who.auth, { message, ...(threadId ? { threadId } : {}) });
const thread = async (who: Person, id: string) => {
  const r = await k.req("GET", `/v1/builder/threads/${id}`, who.auth);
  expect(r.statusCode, r.body).toBe(200);
  return r.json();
};
const toolUsage = async (userId: string) =>
  (await k.db.select({ id: usageEvents.id }).from(usageEvents).where(and(eq(usageEvents.userId, userId), eq(usageEvents.objectType, "mcp_tool")))).length;
const allSteps = (detail: { messages: Array<{ steps: any[] }> }) => detail.messages.flatMap((m) => m.steps);

beforeAll(async () => {
  k = await builderKit("bld-tools");
  owner = await k.person("owner");
  colleague = await k.person("colleague");
  approver = await k.person("approver");
  model = await k.model("tools", { price: 1 });
  limitedModel = model;
  await k.grantModel(owner.id, model);
  await k.grantModel(colleague.id, model);
  // the colleague may bill the owner's project (shared agents bill there)
  const member = await k.req("POST", `/v1/projects/${owner.projectId}/members`, k.BOOT, { userId: colleague.id, role: "contributor" });
  expect(member.statusCode, member.body).toBeLessThan(300);
  const up = await startUpstream();
  upstreamClose = up.close;
  serverName = `bt${k.RUN}`;
  const s = await k.req("POST", "/v1/servers", k.BOOT, { name: serverName, url: up.url });
  expect(s.statusCode, s.body).toBeLessThan(300);
  serverId = s.json().id;
  for (const t of TOOLS) {
    const r = await k.req("POST", `/v1/servers/${serverId}/tools`, k.BOOT, { name: t, kind: "read", description: `test tool ${t}` });
    expect(r.statusCode, r.body).toBe(201);
    toolIds[t] = r.json().id;
    toolGrants[t] = await grantTool(owner.id, t);
  }
  await k.db.update(mcpTools).set({ pricePerCallUsd: 1 }).where(eq(mcpTools.id, toolIds.priced!));
}, 120_000);

afterAll(async () => {
  await k.req("PUT", "/v1/execution/mode", k.BOOT, { mode: "normal", reason: "builder-tools test: cleanup" });
  await upstreamClose();
  await k.close();
});

describe("the loop runs a granted tool through the governed path", () => {
  it("calls the tool as the person, feeds the result back, and records the step with its audit row", async () => {
    const a = await newAgent(owner, [{ tool: "get_time" }]);
    const before = hits.get_time ?? 0;
    const beforeUsage = await toolUsage(owner.id);
    const mark = mock.dispatches.length;
    const r = await chat(owner, a.id, `What time is it? <<use-tool:${modelName("get_time")}>>`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.pending).toBeNull();
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(["user", "agent"]);
    const reply = body.messages[1];
    // the final answer quotes what the tool actually returned
    expect(reply.content).toContain("12:00");
    expect(reply.steps).toHaveLength(1);
    expect(reply.steps[0]).toMatchObject({
      kind: "mcp_tool",
      name: modelName("get_time"),
      displayName: `${serverName} / get_time`,
      status: "done",
      resultPreview: "12:00",
      requiresConfirmation: false,
    });
    expect(reply.steps[0].argumentsDigest).toMatch(/^[0-9a-f]{64}$/);
    // POSITIVE: the upstream ran exactly once, metered as the person
    expect(hits.get_time).toBe(before + 1);
    expect(await toolUsage(owner.id)).toBe(beforeUsage + 1);
    // the governed call's own audit row carries the step id, and the step links it
    const [auditRow] = await k.db.select().from(auditLog).where(eq(auditLog.id, reply.steps[0].auditLogId));
    expect(auditRow).toMatchObject({ userId: owner.id, serverId, toolName: "get_time", effect: "allow" });
    expect((auditRow!.detail as Record<string, unknown>)["builderStepId"]).toBe(reply.steps[0].id);
    // the model was offered the toolbox as tool definitions, then given the result
    const sent = mock.dispatches.slice(mark);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.tools?.map((t) => t.name)).toEqual([modelName("get_time")]);
    expect(JSON.stringify(sent[1]!.messages)).toContain("tool_result");
    // the thread detail shows the same steps
    const detail = await thread(owner, body.thread.id);
    expect(allSteps(detail)).toHaveLength(1);
    expect(detail.pending).toBeNull();
  });

  it("a tool revoked mid-conversation is no longer offered, and a call to it is refused without running", async () => {
    const a = await newAgent(owner, [{ tool: "looper" }]);
    const first = await chat(owner, a.id, `go <<use-tool:${modelName("looper")}>>`);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().messages[1].steps[0].status).toBe("done");
    const ran = hits.looper ?? 0;

    expect((await k.req("DELETE", `/v1/grants/tools/${toolGrants.looper}`, k.BOOT)).statusCode).toBeLessThan(300);
    try {
      const mark = mock.dispatches.length;
      // the earlier user turn still carries the sentinel, so the model asks again
      const second = await chat(owner, a.id, "and again", first.json().thread.id);
      expect(second.statusCode, second.body).toBe(200);
      const step = second.json().messages.find((m: { role: string }) => m.role === "agent").steps[0];
      expect(step).toMatchObject({ status: "refused", outcomeCode: "tool_not_available", kind: "unknown" });
      expect(hits.looper ?? 0).toBe(ran);
      // the revoked tool is not in the definitions the model was given
      expect(mock.dispatches.slice(mark)[0]!.tools ?? []).toEqual([]);
    } finally {
      toolGrants.looper = await grantTool(owner.id, "looper");
    }
  });

  it("adds no authority: a shared agent's tool the user lacks is refused, never run as the owner", async () => {
    const a = await newAgent(owner, [{ tool: "get_time" }], { sharing: "workspace" });
    const before = hits.get_time ?? 0;
    const [ownerUsage, colleagueUsage] = [await toolUsage(owner.id), await toolUsage(colleague.id)];
    const mark = mock.dispatches.length;
    const r = await chat(colleague, a.id, `time please <<use-tool:${modelName("get_time")}>>`);
    expect(r.statusCode, r.body).toBe(200);
    const step = r.json().messages[1].steps[0];
    expect(step).toMatchObject({ status: "refused", outcomeCode: "tool_not_available" });
    expect(hits.get_time ?? 0).toBe(before);
    expect(await toolUsage(owner.id)).toBe(ownerUsage);
    expect(await toolUsage(colleague.id)).toBe(colleagueUsage);
    // the colleague's model step never saw the owner's tool
    expect(mock.dispatches.slice(mark)[0]!.tools ?? []).toEqual([]);
    // positive control: the owner's own turn on the same agent runs it
    const mine = await chat(owner, a.id, `time please <<use-tool:${modelName("get_time")}>>`);
    expect(mine.json().messages[1].steps[0].status).toBe("done");
    expect(hits.get_time).toBe(before + 1);
  });
});

describe("Ask first: a confirmation in the thread, not an approval", () => {
  it("pauses with the exact call, runs it on approve, and resumes the turn", async () => {
    const a = await newAgent(owner, [{ tool: "ask_first", askFirst: true }]);
    const before = hits.ask_first ?? 0;
    const r = await chat(owner, a.id, `please <<use-tool:${modelName("ask_first")}>>`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.pending).toMatchObject({ status: "pending_confirmation", toolName: modelName("ask_first"), approvalId: null });
    expect(body.thread.status).toBe("needs_attention");
    expect(body.thread.pendingStep).toMatchObject({ status: "pending_confirmation" });
    const step = body.messages[1].steps[0];
    expect(step).toMatchObject({ status: "pending_confirmation", requiresConfirmation: true, arguments: {} });
    // the pause carries the step itself, so the card can show the exact call
    expect(body.pending.step).toMatchObject({ id: step.id, arguments: {}, argumentsDigest: step.argumentsDigest });
    expect(hits.ask_first ?? 0).toBe(before); // nothing ran yet
    // no approvals-queue row: a confirmation is not an approval
    expect(await k.db.select().from(approvals).where(and(eq(approvals.userId, owner.id), eq(approvals.toolName, "ask_first")))).toHaveLength(0);
    // the thread takes no new message while it waits
    const blocked = await chat(owner, a.id, "hello?", body.thread.id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe("thread_waiting_on_tool_step");
    // only the thread's person may answer it
    expect((await k.req("POST", `/v1/builder/threads/${body.thread.id}/steps/${step.id}/confirm`, colleague.auth, { decision: "approve" })).statusCode).toBe(404);

    const ok = await k.req("POST", `/v1/builder/threads/${body.thread.id}/steps/${step.id}/confirm`, owner.auth, { decision: "approve" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(hits.ask_first).toBe(before + 1);
    const done = ok.json();
    expect(done.pending).toBeNull();
    expect(done.thread.status).toBe("active");
    const agentMsg = done.messages.find((m: { role: string }) => m.role === "agent");
    expect(agentMsg.steps[0]).toMatchObject({ id: step.id, status: "done", resultPreview: "ask_first ran" });
    expect(agentMsg.content).toContain("ask_first ran");
    const [t] = await k.db.select().from(builderThreads).where(eq(builderThreads.id, body.thread.id));
    expect(t!.pendingTurnCiphertext).toBeNull();
    // answering twice is refused
    const again = await k.req("POST", `/v1/builder/threads/${body.thread.id}/steps/${step.id}/confirm`, owner.auth, { decision: "approve" });
    expect(again.statusCode).toBe(409);
    expect(hits.ask_first).toBe(before + 1);
  });

  it("observers hear about a resumed turn (inbound channels post the final reply)", async () => {
    const heard: Array<{ threadId: string; ok: boolean }> = [];
    const off = onBuilderTurnResumed((e) => {
      heard.push({ threadId: e.threadId, ok: e.outcome.ok });
    });
    try {
      const a = await newAgent(owner, [{ tool: "ask_first", askFirst: true }]);
      const { thread: t, messages } = (await chat(owner, a.id, `please <<use-tool:${modelName("ask_first")}>>`)).json();
      expect(heard).toEqual([]);
      await k.req("POST", `/v1/builder/threads/${t.id}/steps/${messages[1].steps[0].id}/confirm`, owner.auth, { decision: "approve" });
      expect(heard).toEqual([{ threadId: t.id, ok: true }]);
    } finally {
      off();
    }
  });

  it("deny records the refusal, tells the model, and never runs the tool", async () => {
    const a = await newAgent(owner, [{ tool: "ask_first", askFirst: true }]);
    const before = hits.ask_first ?? 0;
    const r = await chat(owner, a.id, `please <<use-tool:${modelName("ask_first")}>>`);
    const { thread: t, messages } = r.json();
    const no = await k.req("POST", `/v1/builder/threads/${t.id}/steps/${messages[1].steps[0].id}/confirm`, owner.auth, { decision: "deny" });
    expect(no.statusCode, no.body).toBe(200);
    const agentMsg = no.json().messages.find((m: { role: string }) => m.role === "agent");
    expect(agentMsg.steps[0]).toMatchObject({ status: "denied", outcomeCode: "declined_by_user" });
    expect(agentMsg.content).toContain("declined");
    expect(hits.ask_first ?? 0).toBe(before);
  });
});

describe("an organisation approval rule pauses in the approvals queue and resumes from the decision", () => {
  beforeAll(async () => {
    const r = await k.req("POST", "/v1/rules/approvals", k.BOOT, {
      userId: owner.id,
      serverId,
      toolName: "needs_approval",
      approverUserId: approver.id,
    });
    expect(r.statusCode, r.body).toBe(201);
  });

  it("approved -> the identical call runs (the bound approval is consumed) and the turn finishes", async () => {
    const a = await newAgent(owner, [{ tool: "needs_approval" }]);
    const before = hits.needs_approval ?? 0;
    const r = await chat(owner, a.id, `please <<use-tool:${modelName("needs_approval")}>>`);
    expect(r.statusCode, r.body).toBe(200);
    const body = r.json();
    expect(body.pending).toMatchObject({ status: "pending_approval", approverName: `approver ${k.RUN}` });
    const approvalId = body.pending.approvalId as string;
    expect(body.messages[1].steps[0]).toMatchObject({ status: "pending_approval", approvalId });
    expect(hits.needs_approval ?? 0).toBe(before);
    // the confirm route cannot answer an organisation approval
    const wrong = await k.req("POST", `/v1/builder/threads/${body.thread.id}/steps/${body.pending.stepId}/confirm`, owner.auth, { decision: "approve" });
    expect(wrong.statusCode).toBe(409);
    expect(hits.needs_approval ?? 0).toBe(before);

    const d = await k.req("POST", `/v1/approvals/${approvalId}/decide`, approver.auth, { decision: "approved" });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().executionError).toBeUndefined();
    expect(hits.needs_approval).toBe(before + 1);
    const detail = await thread(owner, body.thread.id);
    expect(detail.pending).toBeNull();
    const step = allSteps(detail)[0];
    expect(step).toMatchObject({ status: "done", approvalId, resultPreview: "needs_approval ran" });
    const [row] = await k.db.select().from(approvals).where(eq(approvals.id, approvalId));
    expect(row!.status).toBe("consumed");
    expect(detail.thread.status).toBe("active");
  });

  it("denied -> the model is told who denied it and why, and the tool never runs", async () => {
    const a = await newAgent(owner, [{ tool: "needs_approval" }]);
    const before = hits.needs_approval ?? 0;
    const body = (await chat(owner, a.id, `again <<use-tool:${modelName("needs_approval")}>>`)).json();
    const d = await k.req("POST", `/v1/approvals/${body.pending.approvalId}/decide`, approver.auth, { decision: "denied", reason: "not this week" });
    expect(d.statusCode, d.body).toBe(200);
    const detail = await thread(owner, body.thread.id);
    const step = allSteps(detail)[0];
    expect(step).toMatchObject({ status: "denied", outcomeCode: "approval_denied" });
    expect(step.outcomeDetail).toBe(`denied by approver ${k.RUN}: not this week`);
    expect(detail.messages.find((m: { role: string }) => m.role === "agent").content).toContain("not this week");
    expect(hits.needs_approval ?? 0).toBe(before);
  });

  it("an approval decided before the pause was stored is carried on, not left waiting", async () => {
    const r = await k.req("POST", "/v1/rules/approvals", k.BOOT, { userId: owner.id, serverId, toolName: "early_approval", approverUserId: approver.id });
    expect(r.statusCode, r.body).toBe(201);
    // the approver decides INSTANTLY: the queue row is born approved, i.e. before
    // the builder has written its pending step (the hook finds nothing to resume)
    const fn = `bt_early_${k.RUN}`;
    await k.db.execute(sql.raw(`CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$ BEGIN
      IF NEW.server_id = '${serverId}' AND NEW.tool_name = 'early_approval' THEN
        NEW.status := 'approved'; NEW.decided_by := '${approver.id}'; NEW.decided_at := now();
      END IF; RETURN NEW; END $$ LANGUAGE plpgsql`));
    await k.db.execute(sql.raw(`CREATE TRIGGER ${fn} BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION ${fn}()`));
    try {
      const a = await newAgent(owner, [{ tool: "early_approval" }]);
      const before = hits.early_approval ?? 0;
      const res = await chat(owner, a.id, `go <<use-tool:${modelName("early_approval")}>>`);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().pending).toBeNull();
      const step = res.json().messages[1].steps[0];
      expect(step).toMatchObject({ status: "done", resultPreview: "early_approval ran" });
      expect(hits.early_approval).toBe(before + 1);
      const [row] = await k.db.select().from(approvals).where(eq(approvals.id, step.approvalId));
      expect(row!.status).toBe("consumed");
    } finally {
      await k.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${fn} ON approvals`));
      await k.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${fn}()`));
    }
  });

  it("an approval that no longer binds to the call is refused on resume, not run", async () => {
    const a = await newAgent(owner, [{ tool: "needs_approval" }]);
    const before = hits.needs_approval ?? 0;
    const body = (await chat(owner, a.id, `third <<use-tool:${modelName("needs_approval")}>>`)).json();
    // the consent's payload fingerprint is changed under it (a different call's approval)
    await k.db.update(approvals).set({ argumentsDigest: "0".repeat(64) }).where(eq(approvals.id, body.pending.approvalId));
    const d = await k.req("POST", `/v1/approvals/${body.pending.approvalId}/decide`, approver.auth, { decision: "approved" });
    expect(d.statusCode, d.body).toBe(200);
    const detail = await thread(owner, body.thread.id);
    expect(detail.pending).toBeNull();
    expect(allSteps(detail)[0]).toMatchObject({ status: "refused", outcomeCode: "approval_binding_mismatch" });
    expect(hits.needs_approval ?? 0).toBe(before);
  });
});

describe("limits", () => {
  it("stops at the org's step limit with a note", async () => {
    const a = await newAgent(owner, [{ tool: "looper" }]);
    const mark = mock.dispatches.length;
    const r = await chat(owner, a.id, `loop <<use-tool-loop:${modelName("looper")}>>`);
    expect(r.statusCode, r.body).toBe(200);
    const steps = mock.dispatches.length - mark;
    // the shipped org default (defaultWorkerMaxTurns) is 6
    expect(steps).toBe(6);
    const msgs = r.json().messages;
    expect(msgs.map((m: { role: string }) => m.role)).toEqual(["user", "agent", "system"]);
    expect(msgs[1].steps).toHaveLength(6);
    expect(msgs[2].content).toContain("Stopped after 6 steps");
    expect(r.json().thread.status).toBe("needs_attention");
  });

  it("makes at most 12 tool calls in one turn, then the model must answer", async () => {
    const put = (n: number) => k.req("PUT", "/v1/org/settings", k.BOOT, { defaultWorkerMaxTurns: n });
    const before = (await k.req("GET", "/v1/org/settings", k.BOOT)).json().settings.defaultWorkerMaxTurns as number;
    // a singleton: read it, prove we read it, and restore it in finally
    expect(typeof before).toBe("number");
    expect((await put(20)).statusCode).toBeLessThan(300);
    try {
      const a = await newAgent(owner, [{ tool: "looper" }]);
      const ran = hits.looper ?? 0;
      const mark = mock.dispatches.length;
      const r = await chat(owner, a.id, `loop <<use-tool-loop:${modelName("looper")}>>`);
      expect(r.statusCode, r.body).toBe(200);
      expect(hits.looper).toBe(ran + 12);
      const sent = mock.dispatches.slice(mark);
      expect(sent).toHaveLength(13);
      // the last step is told tools are off
      expect(sent[12]!.toolChoice).toBe("none");
      const reply = r.json().messages.find((m: { role: string }) => m.role === "agent");
      expect(reply.steps).toHaveLength(12);
      expect(reply.content).toContain("Tool call complete");
    } finally {
      expect((await put(before)).statusCode).toBeLessThan(300);
      expect((await k.req("GET", "/v1/org/settings", k.BOOT)).json().settings.defaultWorkerMaxTurns).toBe(before);
    }
  });

  it("the kill switch thrown mid-loop stops the next step", async () => {
    const a = await newAgent(owner, [{ tool: "flip_halt" }]);
    const mark = mock.dispatches.length;
    try {
      const r = await chat(owner, a.id, `halt <<use-tool:${modelName("flip_halt")}>>`);
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error).toBe("agent_denied");
      // one step dispatched; the tool ran (and threw the switch); no second step
      expect(mock.dispatches.length - mark).toBe(1);
      const detail = await thread(owner, r.json().threadId);
      expect(detail.messages.map((m: { role: string }) => m.role)).toEqual(["user", "agent", "system"]);
      expect(allSteps(detail)[0].status).toBe("done");
      expect(detail.messages[2].content).toContain("agent_denied");
    } finally {
      await k.req("PUT", "/v1/execution/mode", k.BOOT, { mode: "normal", reason: "builder-tools test: resume" });
    }
  });

  it("the monthly limit mid-loop stops with 402, with the tool's cost counted", async () => {
    const a = await newAgent(owner, [{ tool: "priced" }], { monthlyLimitUsd: 0.5 });
    expect(a.id).toBeTruthy();
    const ran = hits.priced ?? 0;
    const mark = mock.dispatches.length;
    const r = await chat(owner, a.id, `spend <<use-tool:${modelName("priced")}>>`);
    expect(r.statusCode, r.body).toBe(402);
    expect(r.json().error).toBe("agent_spend_limit_reached");
    expect(hits.priced).toBe(ran + 1);
    expect(mock.dispatches.length - mark).toBe(1);
    const detail = await thread(owner, r.json().threadId);
    expect(allSteps(detail)[0]).toMatchObject({ status: "done", costUsd: 1 });
    const agent = (await k.req("GET", `/v1/builder/agents/${a.id}`, owner.auth)).json().agent;
    expect(agent.spentThisMonthUsd).toBeGreaterThanOrEqual(1);
    const denied = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, a.id), eq(auditLog.ruleId, "builder-agent-spend-limit-reached")));
    expect(denied).toHaveLength(1);
    // usage shows the tool spend
    const usage = (await k.req("GET", "/v1/builder/usage?days=7", owner.auth)).json();
    expect(usage.byAgent.find((x: { agentId: string }) => x.agentId === a.id).spendUsd).toBeGreaterThanOrEqual(1);
    expect(limitedModel).toBe(model);
  });
});

describe("connectors in the toolbox", () => {
  it("run through the extracted governed connector call as the person, and a malformed call is refused unrun", async () => {
    const c = await k.req("POST", "/v1/connectors", k.BOOT, { name: `bt-mock-${k.RUN}`, kind: "test", providerKind: "mock", pricePerCallUsd: 0.25 });
    expect(c.statusCode, c.body).toBeLessThan(300);
    const connectorId = c.json().id as string;
    const g = await k.req("POST", "/v1/grants/connectors", k.BOOT, { userId: owner.id, connectorId, mode: "read" });
    expect(g.statusCode, g.body).toBeLessThan(300);
    const a = await newAgent(owner, []);
    const put = await k.req("PUT", `/v1/builder/agents/${a.id}/tools`, owner.auth, { tools: [{ kind: "connector", refId: connectorId, requiresApproval: false }] });
    expect(put.statusCode, put.body).toBe(200);
    const [agentRow] = await k.db.select().from(builderAgents).where(eq(builderAgents.id, a.id));
    const box = await resolveToolbox(k.db, agentRow!, owner.id);
    expect(box.entries).toHaveLength(1);
    const entry = box.entries[0]!;
    expect(entry.name).toBe(`connector__bt-mock-${k.RUN}`);
    const ctx = { userId: owner.id, isAdmin: false, projectId: null, trace: null, toolCallId: "t1", detail: { builderStepId: "x" } };
    const read = await runGovernedTool(k.db, "a".repeat(64), entry, { operation: "read", object: "customers" }, ctx);
    expect(read).toMatchObject({ status: "done", costUsd: 0.25, isError: false });
    // the grant is read-only: a write is the kernel's deny, audited on the connector
    const write = await runGovernedTool(k.db, "a".repeat(64), entry, { operation: "write", object: "customers", payload: { x: 1 } }, ctx);
    expect(write.status).toBe("denied");
    // and the colleague, with no grant at all, is not even offered it
    expect((await resolveToolbox(k.db, agentRow!, colleague.id)).entries).toHaveLength(0);

    // through the loop: the mock asks with no arguments -> refused before any call
    const decisionsBefore = (await k.db.select().from(auditLog).where(and(eq(auditLog.objectType, "connector"), eq(auditLog.objectId, connectorId)))).length;
    const r = await chat(owner, a.id, `use it <<use-tool:${entry.name}>>`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().messages[1].steps[0]).toMatchObject({ kind: "connector", status: "refused", outcomeCode: "invalid_arguments" });
    const decisionsAfter = (await k.db.select().from(auditLog).where(and(eq(auditLog.objectType, "connector"), eq(auditLog.objectId, connectorId)))).length;
    expect(decisionsAfter).toBe(decisionsBefore);
  });
});

describe("storage", () => {
  it("keeps a paused turn encrypted and the step arguments redacted", async () => {
    const a = await newAgent(owner, [{ tool: "ask_first", askFirst: true }]);
    const r = await chat(owner, a.id, `please <<use-tool:${modelName("ask_first")}>>`);
    const [t] = await k.db.select().from(builderThreads).where(eq(builderThreads.id, r.json().thread.id));
    expect(t!.pendingTurnCiphertext).toMatch(/^[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+\.[0-9a-f]+$/);
    expect(t!.pendingTurnCiphertext).not.toContain("tool_use");
    const [s] = await k.db.select().from(builderToolSteps).where(eq(builderToolSteps.threadId, t!.id));
    expect(s!.status).toBe("pending_confirmation");
    // tidy: deny it so the thread is not left waiting
    await k.req("POST", `/v1/builder/threads/${t!.id}/steps/${s!.id}/confirm`, owner.auth, { decision: "deny" });
  });
});
