/**
 * ADR-0173 batch 2b — the run graph (`GET /v1/run-graph/...`).
 *
 * Pinned, per graph:
 *  - builder turn: built from a REAL governed turn (mock provider) — its audit
 *    rows and trace spans — plus tool steps and an approval attached to it;
 *    a turn holds only its own steps; message text never appears; a result
 *    withheld by policy stays withheld (the visible preview of another call
 *    does appear, so the withholding is the rule, not an accident); the
 *    thread's person and admins may read, an admin's read of someone else's
 *    turn is audited, everyone else gets the thread route's 404 (audited);
 *  - orchestration: dependency and lead edges, the escalation approval, the
 *    node cost summed over the node span's subtree; the run's viewers (admin,
 *    initiator, pending approver) may read, a stranger and a former approver
 *    get 404 (audited);
 *  - use case: the path from registration through screening, questionnaire,
 *    sign-off, decision, conditions (hung from the sign-off) and the approval
 *    lifetime; the owner's resubmission draft is shown to the owner and to
 *    nobody else; a stranger gets 403 (audited).
 * Scoped to ids this file creates (M-008); writes no global state.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aiUseCases,
  and,
  approvals,
  asc,
  auditLog,
  builderMessages,
  builderToolSteps,
  eq,
  orchestrationRuns,
  traceSpans,
  traces,
  useCaseDrafts,
} from "@regulait/db";
import { renderEuAiActAnswersBlock, type EuAiActAnswers } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { RUN_GRAPH_RULE_IDS } from "./run-graph.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};

let k: BuilderKit;
let owner: Person;
let stranger: Person;
let admin: Person;
let approver: Person;
let model = "";

type GraphNode = {
  id: string;
  type: string;
  label: string;
  status: string;
  statusDetail: string | null;
  actor: { kind: string; id: string | null; name: string | null } | null;
  costUsd: number | null;
  links: { auditLogId: string | null; traceId: string | null; spanId: string | null; approvalId: string | null };
  facts: Array<{ label: string; value: string }>;
};
type Graph = { nodes: GraphNode[]; edges: Array<{ from: string; to: string; kind: string }>; summary: { costUsd: number | null; waiting: number } };

const graph = (url: string, who: { authorization: string }) => k.req("GET", url, who);
const refusals = (userId: string, objectId: string) =>
  k.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.userId, userId), eq(auditLog.objectId, objectId), eq(auditLog.ruleId, RUN_GRAPH_RULE_IDS.refused)));

beforeAll(async () => {
  k = await builderKit("rgraph");
  restoreSb2Gates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off" });
  owner = await k.person("owner");
  stranger = await k.person("stranger");
  admin = await k.person("admin", { admin: true });
  approver = await k.person("approver");
  model = await k.model("priced", { price: 100_000 });
  await k.grantModel(owner.id, model);
}, 120_000);

afterAll(async () => {
  await restoreSb2Gates();
  await k.close();
});

describe("builder turn graph", () => {
  let threadId = "";
  let agentId = "";
  const SECRET_MSG = `person-secret-${Math.random().toString(36).slice(2)}`;
  const WITHHELD = `withheld-result-${Math.random().toString(36).slice(2)}`;
  const VISIBLE = `visible-result-${Math.random().toString(36).slice(2)}`;
  const NOTE_TEXT = `system-note-${Math.random().toString(36).slice(2)}`;
  let approvalId = "";

  beforeAll(async () => {
    const a = await k.req("POST", "/v1/builder/agents", owner.auth, {
      name: `Graph agent ${Math.random().toString(36).slice(2, 7)}`,
      connectionFormat: "shared",
      computerUse: false,
      projectId: owner.projectId,
      modelAgentId: model,
    });
    expect(a.statusCode, a.body).toBe(201);
    agentId = a.json().agent.id;
    const t1 = await k.req("POST", `/v1/builder/agents/${agentId}/chat`, owner.auth, { message: SECRET_MSG });
    expect(t1.statusCode, t1.body).toBe(200);
    threadId = t1.json().thread.id;
    const agentMsg = t1.json().messages.find((m: { role: string }) => m.role === "agent");

    // two tool calls the first model step asked for: one whose result policy
    // withheld, one ask-first call waiting on an organisation approval
    const [ap] = await k.db
      .insert(approvals)
      .values({ userId: owner.id, objectType: "mcp_tool", toolName: "send", approverUserId: approver.id })
      .returning();
    approvalId = ap!.id;
    const [auditRow] = await k.db
      .insert(auditLog)
      .values({ userId: owner.id, objectType: "mcp_tool", detail: { surface: "builder" }, effect: "allow", ruleId: "rgraph-synthetic", ruleChain: [], reason: "synthetic tool call" })
      .returning({ id: auditLog.id });
    await k.db.insert(builderToolSteps).values([
      {
        threadId, messageId: agentMsg.id, agentId, userId: owner.id, turn: 1, seq: 1, kind: "mcp_tool", name: "srv__lookup",
        displayName: "Lookup", argumentsDigest: "d1", status: "done", resultPreview: WITHHELD, resultWithheld: true,
        costUsd: 0.25, auditLogId: auditRow!.id, finishedAt: new Date(),
      },
      {
        threadId, messageId: agentMsg.id, agentId, userId: owner.id, turn: 1, seq: 2, kind: "mcp_tool", name: "srv__read",
        displayName: "Read", argumentsDigest: "d2", status: "done", resultPreview: VISIBLE, resultWithheld: false,
        costUsd: 0.5, finishedAt: new Date(),
      },
      {
        threadId, messageId: agentMsg.id, agentId, userId: owner.id, turn: 1, seq: 3, kind: "mcp_tool", name: "srv__send",
        displayName: "Send", argumentsDigest: "d3", requiresConfirmation: true, status: "pending_approval", approvalId,
      },
    ]);
    // a system note in turn 1 (the loop writes these, e.g. a stop notice)
    await k.db.insert(builderMessages).values({
      threadId, agentId, userId: owner.id, role: "system", content: NOTE_TEXT, createdAt: new Date(new Date(agentMsg.createdAt).getTime() + 1),
    });
    // a second turn, so the window of turn 1 is closed
    const t2 = await k.req("POST", `/v1/builder/agents/${agentId}/chat`, owner.auth, { message: "second turn", threadId });
    expect(t2.statusCode, t2.body).toBe(200);
  }, 60_000);

  it("draws the turn from its real audit rows and spans, with tool calls, pauses and the approval", async () => {
    const r = await graph(`/v1/run-graph/builder-turn/${threadId}/1`, owner.auth);
    expect(r.statusCode, r.body).toBe(200);
    const g = r.json() as Graph;
    const ids = g.nodes.map((n) => n.id);
    expect(ids[0]).toBe("input");
    const step = g.nodes.find((n) => n.id === "model:1")!;
    expect(step).toMatchObject({ type: "model_step", status: "done", actor: { kind: "model", id: model } });
    expect(step.costUsd).toBeGreaterThan(0.01);
    // links: the decision row the loop wrote, and the span the dispatch recorded
    expect(step.links.auditLogId).toBeTruthy();
    expect(step.links.spanId).toBeTruthy();
    const [span] = await k.db.select().from(traceSpans).where(eq(traceSpans.id, step.links.spanId!));
    expect(span!.name.startsWith("step 1:")).toBe(true);
    const [tr] = await k.db.select().from(traces).where(eq(traces.id, span!.traceId));
    expect(tr!.sessionId).toBe(`builder:${threadId}`);

    const tools = g.nodes.filter((n) => n.type === "tool_call");
    expect(tools.map((t) => t.label)).toEqual(["Lookup", "Read", "Send"]);
    expect(g.edges).toEqual(expect.arrayContaining([
      { from: "input", to: "model:1", kind: "next" },
      { from: "model:1", to: tools[0]!.id, kind: "tool_call" },
    ]));
    // the ask-first call: confirmation → approval → the call, waiting on the approver
    const send = tools[2]!;
    const confirm = g.nodes.find((n) => n.type === "confirmation")!;
    const appr = g.nodes.find((n) => n.type === "approval")!;
    expect(appr).toMatchObject({ status: "waiting", actor: { kind: "person", id: approver.id }, links: { approvalId } });
    expect(g.edges).toEqual(expect.arrayContaining([
      { from: "model:1", to: confirm.id, kind: "tool_call" },
      { from: confirm.id, to: appr.id, kind: "then" },
      { from: appr.id, to: send.id, kind: "then" },
    ]));
    expect(send.status).toBe("waiting");
    expect(tools[0]!.links.auditLogId).toBeTruthy();
    expect(g.summary.costUsd).toBeCloseTo(step.costUsd! + 0.75, 6);
    expect(g.summary.waiting).toBeGreaterThanOrEqual(2);
  });

  it("never shows message text or a result withheld by policy", async () => {
    const r = await graph(`/v1/run-graph/builder-turn/${threadId}/1`, owner.auth);
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(SECRET_MSG);
    expect(r.body).not.toContain(WITHHELD);
    const g = r.json() as Graph;
    const lookup = g.nodes.find((n) => n.label === "Lookup")!;
    expect(lookup.facts).toContainEqual({ label: "Result", value: "withheld by policy" });
    // positive control: a result the thread shows is shown here too
    const read = g.nodes.find((n) => n.label === "Read")!;
    expect(read.facts).toContainEqual({ label: "Result preview", value: VISIBLE });
    expect(g.nodes.find((n) => n.type === "note")?.statusDetail).toBe(NOTE_TEXT);
  });

  it("shows an admin reading someone else's turn the path, never a result preview or note text", async () => {
    const r = await graph(`/v1/run-graph/builder-turn/${threadId}/1`, admin.auth);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.body).not.toContain(VISIBLE);
    expect(r.body).not.toContain(NOTE_TEXT);
    expect(r.body).not.toContain(WITHHELD);
    const g = r.json() as Graph;
    // the structure is all there
    expect(g.nodes.filter((n) => n.type === "tool_call").map((t) => t.label)).toEqual(["Lookup", "Read", "Send"]);
    const read = g.nodes.find((n) => n.label === "Read")!;
    expect(read.facts).toContainEqual({ label: "Result", value: "shown only to the person whose thread this is" });
    const note = g.nodes.find((n) => n.type === "note")!;
    expect(note.statusDetail).toBeNull();
  });

  it("holds only its own turn", async () => {
    const r = await graph(`/v1/run-graph/builder-turn/${threadId}/2`, owner.auth);
    expect(r.statusCode, r.body).toBe(200);
    const g = r.json() as Graph;
    expect(g.nodes.filter((n) => n.type === "tool_call")).toHaveLength(0);
    expect(g.nodes.filter((n) => n.type === "model_step")).toHaveLength(1);
    expect(g.nodes.some((n) => n.type === "reply")).toBe(true);
    const turn3 = await graph(`/v1/run-graph/builder-turn/${threadId}/3`, owner.auth);
    expect(turn3.statusCode).toBe(404);
    expect(turn3.json().error).toBe("unknown_turn");
  });

  it("refuses everyone but the thread's person and admins, and audits", async () => {
    const before = (await refusals(stranger.id, agentId)).length;
    const r = await graph(`/v1/run-graph/builder-turn/${threadId}/1`, stranger.auth);
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("unknown_thread");
    expect(r.body).not.toContain("Lookup");
    expect((await refusals(stranger.id, agentId)).length).toBe(before + 1);

    const unknown = await graph(`/v1/run-graph/builder-turn/00000000-0000-0000-0000-000000000000/1`, owner.auth);
    expect(unknown.statusCode).toBe(404);

    const crossReads = () =>
      k.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, admin.id), eq(auditLog.objectId, agentId), eq(auditLog.ruleId, RUN_GRAPH_RULE_IDS.crossUser)));
    const crossBefore = (await crossReads()).length;
    const asAdmin = await graph(`/v1/run-graph/builder-turn/${threadId}/1`, admin.auth);
    expect(asAdmin.statusCode, asAdmin.body).toBe(200);
    // each cross-user read is one audit row (an earlier test in this file read once already)
    expect(await crossReads()).toHaveLength(crossBefore + 1);
    // the person reading their own turn is not a cross-user read
    const own = await k.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.userId, owner.id), eq(auditLog.ruleId, RUN_GRAPH_RULE_IDS.crossUser)));
    expect(own).toHaveLength(0);
  });
});

describe("orchestration run graph", () => {
  let runId = "";
  let approvalId = "";
  beforeAll(async () => {
    const graphDef = {
      run: "rgraph run",
      escalationApproverUserId: approver.id,
      nodes: [
        { id: "plan", title: "Plan the work", ownerAgentId: model, mode: "chat", dependsOn: [], parallelizable: true },
        { id: "build", title: "Build it", ownerAgentId: model, mode: "chat", dependsOn: ["plan"], parallelizable: true },
        { id: "check", title: "Check it", ownerAgentId: model, mode: "chat", dependsOn: ["plan"], parallelizable: true, leadNodeId: "plan" },
      ],
    };
    const [run] = await k.db
      .insert(orchestrationRuns)
      .values({
        name: "rgraph run",
        initiatingUserId: owner.id,
        graph: graphDef,
        state: {
          status: "running",
          nodeStatuses: { plan: "done", build: "blocked", check: "not_started" },
          attempts: { plan: 1, build: 2, check: 0 },
          owners: { plan: model, build: model, check: model },
          lastError: { build: "worker failed twice" },
        },
        status: "running",
      })
      .returning();
    runId = run!.id;
    const [ap] = await k.db
      .insert(approvals)
      .values({ userId: owner.id, objectType: "run", runId, stageId: "build", approverUserId: approver.id })
      .returning();
    approvalId = ap!.id;
    const [tr] = await k.db.insert(traces).values({ kind: "run", name: "rgraph run", userId: owner.id, sessionId: runId, rootRefId: runId }).returning();
    const now = new Date();
    const [runSpan] = await k.db.insert(traceSpans).values({ traceId: tr!.id, seq: 1, kind: "run", name: "rgraph run", status: "running", startedAt: now, runId }).returning();
    const [nodeSpan] = await k.db
      .insert(traceSpans)
      .values({ traceId: tr!.id, parentSpanId: runSpan!.id, seq: 2, kind: "run_node", name: "plan", status: "ok", startedAt: now, endedAt: now, runId, nodeId: "plan" })
      .returning();
    const [turn] = await k.db
      .insert(traceSpans)
      .values({ traceId: tr!.id, parentSpanId: nodeSpan!.id, seq: 3, kind: "llm", name: "turn 1", status: "ok", startedAt: now, costUsd: 0.02 })
      .returning();
    await k.db.insert(traceSpans).values({ traceId: tr!.id, parentSpanId: turn!.id, seq: 4, kind: "tool", name: "tool", status: "ok", startedAt: now, costUsd: 0.01 });
  });

  it("draws the task DAG with lead edges, the escalation, and node cost from the span subtree", async () => {
    const r = await graph(`/v1/run-graph/orchestration/${runId}`, owner.auth);
    expect(r.statusCode, r.body).toBe(200);
    const g = r.json() as Graph;
    expect(g.nodes.map((n) => n.id)).toEqual(["run", "task:plan", "task:build", `approval:${approvalId}`, "task:check"]);
    expect(g.edges).toEqual(expect.arrayContaining([
      { from: "run", to: "task:plan", kind: "starts" },
      { from: "task:plan", to: "task:build", kind: "depends_on" },
      { from: "task:plan", to: "task:check", kind: "leads" },
      { from: "task:build", to: `approval:${approvalId}`, kind: "escalated" },
    ]));
    const plan = g.nodes.find((n) => n.id === "task:plan")!;
    expect(plan.status).toBe("done");
    expect(plan.costUsd).toBeCloseTo(0.03, 8);
    expect(plan.links.spanId).toBeTruthy();
    const build = g.nodes.find((n) => n.id === "task:build")!;
    expect(build).toMatchObject({ status: "error", actor: { kind: "agent", id: model } });
    expect(g.nodes.find((n) => n.id === `approval:${approvalId}`)).toMatchObject({ status: "waiting", actor: { id: approver.id } });
  });

  it("is readable by the run's viewers only, and refusals are audited", async () => {
    expect((await graph(`/v1/run-graph/orchestration/${runId}`, admin.auth)).statusCode).toBe(200);
    // the named approver of a PENDING approval may read what they are deciding
    expect((await graph(`/v1/run-graph/orchestration/${runId}`, approver.auth)).statusCode).toBe(200);
    const before = (await refusals(stranger.id, runId)).length;
    const s = await graph(`/v1/run-graph/orchestration/${runId}`, stranger.auth);
    expect(s.statusCode).toBe(404);
    expect(s.body).not.toContain("Plan the work");
    expect((await refusals(stranger.id, runId)).length).toBe(before + 1);
    // once decided, the approver is no longer a viewer
    await k.db.update(approvals).set({ status: "approved", decidedBy: approver.id, decidedAt: new Date() }).where(eq(approvals.id, approvalId));
    expect((await graph(`/v1/run-graph/orchestration/${runId}`, approver.auth)).statusCode).toBe(404);
    expect((await graph(`/v1/run-graph/orchestration/00000000-0000-0000-0000-000000000000`, owner.auth)).statusCode).toBe(404);
  });
});

describe("use-case graph", () => {
  const answers: EuAiActAnswers = {
    purposeDomain: "employment-hr",
    affectedPersons: [],
    decisionAutonomy: "fully-automated",
    biometricUse: "none",
    emotionRecognition: false,
    socialScoring: false,
    manipulativeTechniques: false,
    profilesNaturalPersons: false,
    safetyComponent: false,
    interactsWithHumans: false,
    generatesSyntheticContent: false,
  };
  let useCaseId = "";
  let signoffId = "";

  beforeAll(async () => {
    const p = await k.req("POST", "/v1/use-cases", owner.auth, {
      name: `rgraph use case ${k.RUN}`,
      description: "synthetic run-graph fixture",
      businessContext: "graph",
      dataSensitivity: "internal",
    });
    expect(p.statusCode, p.body).toBe(201);
    useCaseId = p.json().id;
    const instanceId = p.json().instance.id as string;
    expect((await k.req("POST", `/v1/workflows/instances/${instanceId}/advance`, owner.auth, { stageId: "plan" })).statusCode).toBe(200);
    const art = await k.req("POST", `/v1/workflows/instances/${instanceId}/artifacts`, owner.auth, {
      stageId: "questionnaire",
      content: `# AI use-case intake questionnaire\n\n## 1. Purpose\nrgraph\n\n## 9. EU AI Act risk screening\n\n${renderEuAiActAnswersBlock(answers)}`,
    });
    expect(art.statusCode, art.body).toBe(201);
    const [pending] = await k.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.instanceId, instanceId), eq(approvals.status, "pending")))
      .orderBy(asc(approvals.requestedAt));
    signoffId = pending!.id;
    const d = await k.req("POST", `/v1/approvals/${signoffId}/decide`, admin.auth, {
      decision: "approved",
      reason: "approved with a condition (rgraph)",
      conditions: [{ text: "DPIA signed", dueAt: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), blocking: true }],
    });
    expect(d.statusCode, d.body).toBe(200);
    // the owner has a resubmission draft open
    await k.db.insert(useCaseDrafts).values({ userId: owner.id, scope: useCaseId, state: { step: 1 } });
  }, 60_000);

  it("draws registration → screening → questionnaire → sign-off → decision → condition and lifetime", async () => {
    const r = await graph(`/v1/run-graph/use-case/${useCaseId}`, owner.auth);
    expect(r.statusCode, r.body).toBe(200);
    const g = r.json() as Graph;
    const types = g.nodes.map((n) => n.type);
    expect(types.slice(0, 4)).toEqual(["intake", "classification", "screening", "questionnaire"]);
    expect(g.nodes.find((n) => n.type === "screening")!.label).toBe("EU AI Act screening: high");
    const review = g.nodes.find((n) => n.id === `review:${signoffId}`)!;
    expect(review.status).toBe("done");
    expect(g.nodes.find((n) => n.type === "decision")).toMatchObject({ status: "done", label: "Decision: approved" });
    const cond = g.nodes.find((n) => n.type === "condition")!;
    expect(cond).toMatchObject({ status: "waiting", links: { approvalId: signoffId } });
    expect(g.edges).toContainEqual({ from: `review:${signoffId}`, to: cond.id, kind: "imposed" });
    expect(g.nodes.find((n) => n.type === "expiry")).toMatchObject({ status: "done", label: "Approval valid" });
    expect(g.nodes.find((n) => n.type === "intake")!.links.auditLogId).toBeTruthy();
    expect(g.nodes.some((n) => n.type === "draft")).toBe(true);

    // an expired approval reads as expired
    await k.db.update(aiUseCases).set({ approvedUntil: new Date(Date.now() - 86_400_000) }).where(eq(aiUseCases.id, useCaseId));
    const later = (await graph(`/v1/run-graph/use-case/${useCaseId}`, owner.auth)).json() as Graph;
    expect(later.nodes.find((n) => n.type === "expiry")).toMatchObject({ status: "expired", label: "Approval expired" });
  });

  it("shows a resubmission draft only to the person whose draft it is", async () => {
    const r = await graph(`/v1/run-graph/use-case/${useCaseId}`, admin.auth);
    expect(r.statusCode, r.body).toBe(200);
    expect((r.json() as Graph).nodes.some((n) => n.type === "draft")).toBe(false);
  });

  it("refuses a stranger with the detail route's 403, audited", async () => {
    const before = (await refusals(stranger.id, useCaseId)).length;
    const s = await graph(`/v1/run-graph/use-case/${useCaseId}`, stranger.auth);
    expect(s.statusCode).toBe(403);
    expect(s.body).not.toContain("DPIA");
    expect((await refusals(stranger.id, useCaseId)).length).toBe(before + 1);
    expect((await graph(`/v1/run-graph/use-case/00000000-0000-0000-0000-000000000000`, owner.auth)).statusCode).toBe(404);
  });
});
