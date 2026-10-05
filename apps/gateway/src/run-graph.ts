/**
 * ADR-0173 batch 2b — THE RUN GRAPH: a read-only decision-path graph of one run.
 *
 *   GET /v1/run-graph/builder-turn/:threadId/:turn   one turn of a builder thread
 *   GET /v1/run-graph/orchestration/:runId           an orchestration run's task graph
 *   GET /v1/run-graph/use-case/:useCaseId            a use case's path to its decision
 *
 * Composition only, over records the platform already keeps (the same rule as
 * ADR-0156's dependency graph). Nothing is stored; every read rebuilds the graph
 * from the ledgers, so it cannot drift from them:
 *  - builder turn: `builder_messages`, `builder_tool_steps`, the approvals the
 *    steps waited on, the turn's trace spans and the per-step audit rows;
 *  - orchestration: the run's task graph and state, its `run_node` spans (cost
 *    is the sum of each node span's subtree), its audit rows and approvals;
 *  - use case: registration, an open resubmission draft (the viewer's own
 *    only), classification, EU AI Act screening, questionnaire versions,
 *    review rounds and decisions, conditions and the approval's lifetime.
 *
 * Every node carries status, actor, time, cost where known, and references to
 * its audit row and trace span when they exist.
 *
 * WHO MAY READ. Exactly who may open the underlying object:
 *  - a builder turn: the thread's person, or an admin. Anyone else gets the
 *    thread route's answer (404 `unknown_thread`), so existence is not
 *    disclosed. An admin reading another person's turn is audited, because the
 *    thread route itself does not open other people's threads;
 *  - an orchestration run: admins, the initiator, and the named approver of a
 *    PENDING approval on the run (`GET /v1/runs/:runId`'s rule; 404 otherwise);
 *  - a use case: `canReadUseCase` (owner, admins, the intake's reviewers; 403).
 * Every refusal of an object that exists is audited.
 *
 * WHAT IS NEVER SHOWN. No message text, no tool arguments, no span previews.
 * A tool result appears only as the thread shows it: its truncated preview,
 * and never when the call's result was withheld by PII/guardrail policy. A
 * resubmission draft is shown only to the person whose draft it is, and then
 * only that it exists.
 *
 * Non-admin route (NON_ADMIN_ROUTES); the gate is in the handler.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  aiUseCases,
  and,
  approvals,
  asc,
  auditLog,
  builderAgents,
  builderMessages,
  builderThreads,
  builderToolSteps,
  eq,
  gte,
  inArray,
  lt,
  or,
  orchestrationRuns,
  sql,
  traceSpans,
  traces,
  useCaseConditions,
  useCaseDrafts,
  users,
  workflowArtifacts,
  type Db,
  type TraceSpanRow,
} from "@regulait/db";
import type { RunState, TaskGraph } from "@regulait/orchestration-kernel";
import { canReadUseCase, USE_CASE_QUESTIONNAIRE_OUTPUT } from "./use-cases.js";

// ---------------------------------------------------------------------------
// The response vocabulary
// ---------------------------------------------------------------------------

export type RunGraphKind = "builder_turn" | "orchestration" | "use_case";
export type RunGraphStatus =
  | "done"
  | "active"
  | "waiting"
  | "denied"
  | "error"
  | "not_started"
  | "stopped"
  | "expired"
  | "skipped";

export interface RunGraphActor {
  kind: "person" | "agent" | "model" | "system";
  id: string | null;
  name: string | null;
}

export interface RunGraphNode {
  id: string;
  type: string;
  label: string;
  status: RunGraphStatus;
  /** the status in the source table's own vocabulary */
  rawStatus: string | null;
  /** why: a refusal reason, an outcome code, a last error */
  statusDetail: string | null;
  actor: RunGraphActor | null;
  at: string | null;
  endedAt: string | null;
  costUsd: number | null;
  links: { auditLogId: string | null; traceId: string | null; spanId: string | null; approvalId: string | null };
  facts: Array<{ label: string; value: string }>;
}

export interface RunGraphEdge {
  from: string;
  to: string;
  kind: string;
}

export interface RunGraphResponse {
  kind: RunGraphKind;
  subject: { id: string; label: string };
  generatedAt: string;
  /** in decision-path order: the order the text alternative lists them in */
  nodes: RunGraphNode[];
  edges: RunGraphEdge[];
  summary: { nodes: number; costUsd: number | null; denied: number; waiting: number; errors: number };
  notes: string[];
}

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const RUN_GRAPH_RULE_IDS = {
  refused: "run-graph-read-refused",
  crossUser: "run-graph-read-cross-user",
} as const;

const PREVIEW_MAX = 500;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const clip = (s: string | null | undefined, n = PREVIEW_MAX) =>
  s == null ? null : s.length > n ? `${s.slice(0, n - 1)}…` : s;

function node(n: Partial<RunGraphNode> & Pick<RunGraphNode, "id" | "type" | "label" | "status">): RunGraphNode {
  return {
    rawStatus: null,
    statusDetail: null,
    actor: null,
    at: null,
    endedAt: null,
    costUsd: null,
    facts: [],
    ...n,
    links: { auditLogId: null, traceId: null, spanId: null, approvalId: null, ...(n.links ?? {}) },
  };
}

function summarise(kind: RunGraphKind, subject: RunGraphResponse["subject"], nodes: RunGraphNode[], edges: RunGraphEdge[], notes: string[]): RunGraphResponse {
  const costs = nodes.map((n) => n.costUsd).filter((c): c is number => c != null);
  return {
    kind,
    subject,
    generatedAt: new Date().toISOString(),
    nodes,
    edges,
    summary: {
      nodes: nodes.length,
      costUsd: costs.length ? Number(costs.reduce((a, b) => a + b, 0).toFixed(8)) : null,
      denied: nodes.filter((n) => n.status === "denied").length,
      waiting: nodes.filter((n) => n.status === "waiting").length,
      errors: nodes.filter((n) => n.status === "error").length,
    },
    notes,
  };
}

const spanStatus = (s: string | null | undefined): RunGraphStatus =>
  s === "ok" ? "done" : s === "error" ? "error" : s === "denied" ? "denied" : s === "running" ? "active" : "done";

const approvalStatus = (s: string): RunGraphStatus =>
  s === "pending"
    ? "waiting"
    : s === "approved" || s === "consumed"
      ? "done"
      : s === "superseded"
        ? "skipped"
        : "denied"; // denied, returned

async function userNames(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x && x !== NIL_UUID))];
  if (!want.length) return new Map();
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, want));
  return new Map(rows.map((u) => [u.id, u.displayName || u.email]));
}

async function agentNames(db: Db, ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map();
  const rows = await db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, want));
  return new Map(rows.map((a) => [a.id, a.name]));
}

const person = (id: string | null | undefined, names: Map<string, string>): RunGraphActor | null =>
  id ? { kind: "person", id, name: names.get(id) ?? null } : null;

/** the newest audit row per approval id among `rows` (rows carry
 * detail.approvalId). A condition being marked met names the approval that
 * imposed it, but it is not a record OF that approval: it is skipped. */
function auditByApproval(rows: Array<{ id: string; detail: unknown; ruleId?: string | null }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.ruleId === "use-case-condition-met") continue;
    const a = (r.detail as Record<string, unknown> | null)?.approvalId;
    if (typeof a === "string") out.set(a, r.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Builder turn
// ---------------------------------------------------------------------------

type Refusal = { status: 403 | 404; error: string; detail?: string; audit?: { objectType: "builder_agent" | "run" | "ai_use_case"; objectId: string } };
type Outcome = { ok: true; graph: RunGraphResponse; crossUser?: { objectType: "builder_agent"; objectId: string; detail: Record<string, unknown> } } | ({ ok: false } & Refusal);

interface Viewer {
  userId: string | null;
  isAdmin: boolean;
}

export async function builderTurnGraph(db: Db, viewer: Viewer, threadId: string, turn: number): Promise<Outcome> {
  const [thread] = await db.select().from(builderThreads).where(eq(builderThreads.id, threadId));
  if (!thread) return { ok: false, status: 404, error: "unknown_thread" };
  if (!viewer.isAdmin && viewer.userId !== thread.userId) {
    // threads are personal: someone else's reads as unknown (the thread route's answer)
    return {
      ok: false,
      status: 404,
      error: "unknown_thread",
      audit: { objectType: "builder_agent", objectId: thread.agentId },
    };
  }

  const msgs = await db
    .select()
    .from(builderMessages)
    .where(eq(builderMessages.threadId, thread.id))
    .orderBy(asc(builderMessages.createdAt), asc(builderMessages.id));
  const userMsgs = msgs.filter((m) => m.role === "user");
  const userMsg = userMsgs[turn - 1];
  if (!userMsg) return { ok: false, status: 404, error: "unknown_turn", detail: `this thread has ${userMsgs.length} turn(s)` };
  const start = userMsg.createdAt;
  const end = userMsgs[turn]?.createdAt ?? null;
  const inWindow = (d: Date) => d.getTime() >= start.getTime() && (!end || d.getTime() < end.getTime());
  const turnMsgs = msgs.filter((m) => m.id !== userMsg.id && inWindow(m.createdAt));
  const agentMsgIds = turnMsgs.filter((m) => m.role === "agent").map((m) => m.id);

  const [builder] = await db.select({ id: builderAgents.id, name: builderAgents.name }).from(builderAgents).where(eq(builderAgents.id, thread.agentId));
  const steps = agentMsgIds.length
    ? await db
        .select()
        .from(builderToolSteps)
        .where(inArray(builderToolSteps.messageId, agentMsgIds))
        .orderBy(asc(builderToolSteps.turn), asc(builderToolSteps.seq), asc(builderToolSteps.createdAt))
    : [];
  // the per-step decision rows the loop writes (userId+at is indexed)
  const auditRows = await db
    .select({ id: auditLog.id, at: auditLog.at, objectId: auditLog.objectId, effect: auditLog.effect, reason: auditLog.reason, detail: auditLog.detail })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, thread.userId),
        gte(auditLog.at, start),
        ...(end ? [lt(auditLog.at, end)] : []),
        eq(auditLog.objectType, "agent"),
        sql`${auditLog.detail}->>'builderThreadId' = ${thread.id}`,
      ),
    )
    .orderBy(asc(auditLog.at), asc(auditLog.id));

  const traceRows = await db
    .select({ id: traces.id })
    .from(traces)
    .where(
      and(
        eq(traces.sessionId, `builder:${thread.id}`),
        gte(traces.startedAt, start),
        ...(end ? [lt(traces.startedAt, end)] : []),
      ),
    );
  const traceIds = [...new Set([...traceRows.map((t) => t.id), ...steps.map((s) => s.traceId).filter((x): x is string => !!x)])];
  const spans: TraceSpanRow[] = traceIds.length
    ? await db.select().from(traceSpans).where(inArray(traceSpans.traceId, traceIds)).orderBy(asc(traceSpans.startedAt), asc(traceSpans.seq))
    : [];

  const approvalIds = [...new Set(steps.map((s) => s.approvalId).filter((x): x is string => !!x))];
  const approvalRows = approvalIds.length ? await db.select().from(approvals).where(inArray(approvals.id, approvalIds)) : [];
  const approvalById = new Map(approvalRows.map((a) => [a.id, a]));
  const names = await userNames(db, [thread.userId, ...steps.map((s) => s.decidedByUserId), ...approvalRows.flatMap((a) => [a.approverUserId, a.decidedBy])]);
  const models = await agentNames(db, auditRows.map((r) => r.objectId));

  const nodes: RunGraphNode[] = [];
  const edges: RunGraphEdge[] = [];
  const thePerson = person(thread.userId, names);

  nodes.push(
    node({
      id: "input",
      type: "input",
      label: "Person's message",
      status: "done",
      actor: thePerson,
      at: iso(userMsg.createdAt),
      facts: [{ label: "Turn", value: String(turn) }, { label: "Source", value: thread.source }],
    }),
  );

  // the spine: model steps and entitlement refusals, in the order they happened
  const spine: RunGraphNode[] = [];
  const modelByStep = new Map<number, RunGraphNode>();
  const usedSpans = new Set<string>();
  for (const r of auditRows) {
    const d = (r.detail ?? {}) as Record<string, unknown>;
    const step = Number(d.step);
    const modelName = r.objectId ? (models.get(r.objectId) ?? null) : null;
    const actor: RunGraphActor = { kind: "model", id: r.objectId, name: modelName };
    if (r.effect !== "allow") {
      const span = spans.find((s) => s.auditLogId === r.id) ?? null;
      spine.push(
        node({
          id: `policy:${r.id}`,
          type: "policy",
          label: `Entitlement check before step ${Number.isFinite(step) ? step : "?"}`,
          status: "denied",
          rawStatus: r.effect,
          statusDetail: r.reason,
          actor,
          at: iso(r.at),
          links: { auditLogId: r.id, traceId: span?.traceId ?? null, spanId: span?.id ?? null, approvalId: null },
        }),
      );
      continue;
    }
    const span =
      spans.find((s) => s.kind === "llm" && !usedSpans.has(s.id) && s.name.startsWith(`step ${step}:`)) ?? null;
    if (span) usedSpans.add(span.id);
    const dispatch = (d.dispatch ?? {}) as Record<string, unknown>;
    const failed = typeof dispatch.error === "string";
    const facts: RunGraphNode["facts"] = [];
    if (span?.provider || span?.model) facts.push({ label: "Model", value: [span.provider, span.model].filter(Boolean).join(" / ") });
    if (span?.inputTokens != null) facts.push({ label: "Tokens in", value: String(span.inputTokens) });
    if (span?.outputTokens != null) facts.push({ label: "Tokens out", value: String(span.outputTokens) });
    if (typeof dispatch.toolCalls === "number") facts.push({ label: "Tool calls asked for", value: String(dispatch.toolCalls) });
    if (span?.durationMs != null) facts.push({ label: "Duration", value: `${span.durationMs} ms` });
    if (span?.contentWithheld) facts.push({ label: "Content", value: "withheld by policy" });
    const n = node({
      id: modelByStep.has(step) ? `model:${step}:${r.id}` : `model:${step}`,
      type: "model_step",
      label: `Model step ${Number.isFinite(step) ? step : "?"}`,
      status: span ? spanStatus(span.status) : failed ? "error" : "done",
      rawStatus: span?.status ?? null,
      statusDetail: failed ? String(dispatch.error) : (span?.statusReason ?? null),
      actor,
      at: iso(span?.startedAt ?? r.at),
      endedAt: iso(span?.endedAt),
      costUsd: span?.costUsd ?? null,
      links: { auditLogId: r.id, traceId: span?.traceId ?? null, spanId: span?.id ?? null, approvalId: null },
      facts,
    });
    spine.push(n);
    if (Number.isFinite(step)) modelByStep.set(step, n);
    // fallback hops hang from the attempt that failed over
    if (span) {
      for (const hop of spans.filter((s) => s.kind === "fallback_hop" && s.parentSpanId === span.id)) {
        const h = node({
          id: `fallback:${hop.id}`,
          type: "fallback_hop",
          label: hop.name,
          status: spanStatus(hop.status),
          rawStatus: hop.status,
          statusDetail: hop.statusReason,
          actor: { kind: "model", id: hop.agentId, name: [hop.provider, hop.model].filter(Boolean).join(" / ") || null },
          at: iso(hop.startedAt),
          endedAt: iso(hop.endedAt),
          costUsd: hop.costUsd,
          links: { auditLogId: hop.auditLogId, traceId: hop.traceId, spanId: hop.id, approvalId: null },
        });
        nodes.push(h); // ordered right after its attempt below
        edges.push({ from: n.id, to: h.id, kind: "fallback" });
      }
    }
  }

  // tool calls, each with the pauses it went through
  const toolsByModel = new Map<string, Array<{ first: string; last: string; chain: RunGraphNode[] }>>();
  for (const st of steps) {
    const chain: RunGraphNode[] = [];
    if (st.requiresConfirmation) {
      chain.push(
        node({
          id: `confirm:${st.id}`,
          type: "confirmation",
          label: `Ask first: ${st.displayName}`,
          status:
            st.status === "pending_confirmation"
              ? "waiting"
              : st.outcomeCode === "declined_by_user"
                ? "denied"
                : st.outcomeCode === "cancelled_by_user" || st.outcomeCode === "cancelled_by_admin"
                  ? "skipped"
                  : "done",
          rawStatus: st.status === "pending_confirmation" ? "pending_confirmation" : null,
          actor: thePerson,
          at: iso(st.createdAt),
        }),
      );
    }
    const ap = st.approvalId ? approvalById.get(st.approvalId) : undefined;
    if (ap) {
      chain.push(
        node({
          id: `approval:${ap.id}`,
          type: "approval",
          label: "Organisation approval",
          status: approvalStatus(ap.status),
          rawStatus: ap.status,
          actor: person(ap.decidedBy ?? ap.approverUserId, names),
          at: iso(ap.decidedAt ?? ap.requestedAt),
          links: { auditLogId: null, traceId: null, spanId: null, approvalId: ap.id },
          facts: [{ label: "Requested", value: ap.requestedAt.toISOString() }],
        }),
      );
    }
    const span = st.auditLogId ? (spans.find((s) => s.auditLogId === st.auditLogId) ?? null) : null;
    const facts: RunGraphNode["facts"] = [
      { label: "Kind", value: st.kind === "mcp_tool" ? "MCP tool" : st.kind },
    ];
    if (st.provider) facts.push({ label: "Provider", value: st.provider });
    if (st.latencyMs != null) facts.push({ label: "Latency", value: `${st.latencyMs} ms` });
    // the thread's own rule: a withheld result is never shown, only that it was withheld
    if (st.resultWithheld) facts.push({ label: "Result", value: "withheld by policy" });
    else if (st.resultPreview) facts.push({ label: "Result preview", value: clip(st.resultPreview)! });
    chain.push(
      node({
        id: `tool:${st.id}`,
        type: "tool_call",
        label: st.displayName,
        status:
          st.status === "done"
            ? "done"
            : st.status === "running"
              ? "active"
              : st.status === "pending_confirmation" || st.status === "pending_approval"
                ? "waiting"
                : st.status === "error"
                  ? "error"
                  : "denied",
        rawStatus: st.status,
        statusDetail: [st.outcomeCode, st.outcomeDetail].filter(Boolean).join(": ") || null,
        actor: thePerson,
        at: iso(st.createdAt),
        endedAt: iso(st.finishedAt),
        costUsd: st.costUsd,
        links: { auditLogId: st.auditLogId, traceId: st.traceId ?? span?.traceId ?? null, spanId: span?.id ?? null, approvalId: st.approvalId },
        facts,
      }),
    );
    for (let i = 1; i < chain.length; i++) edges.push({ from: chain[i - 1]!.id, to: chain[i]!.id, kind: "then" });
    const owner = modelByStep.get(st.turn) ?? spine[spine.length - 1];
    const key = owner?.id ?? "input";
    toolsByModel.set(key, [...(toolsByModel.get(key) ?? []), { first: chain[0]!.id, last: chain[chain.length - 1]!.id, chain }]);
  }

  // stitch: input → spine[0] → (its tool calls) → spine[1] → … → the turn's end
  let prevEnds = ["input"];
  const ordered: RunGraphNode[] = [];
  const fallbacks = nodes.splice(1); // fallback hops pushed above; re-ordered after their attempt
  for (const sp of spine) {
    for (const p of prevEnds) edges.push({ from: p, to: sp.id, kind: "next" });
    ordered.push(sp, ...fallbacks.filter((f) => edges.some((e) => e.from === sp.id && e.to === f.id)));
    const tools = toolsByModel.get(sp.id) ?? [];
    for (const t of tools) {
      edges.push({ from: sp.id, to: t.first, kind: "tool_call" });
      ordered.push(...t.chain);
    }
    prevEnds = tools.length ? tools.map((t) => t.last) : [sp.id];
  }
  // tool steps whose model step left no audit row (should not happen): hang them off the input
  for (const t of toolsByModel.get("input") ?? []) {
    edges.push({ from: "input", to: t.first, kind: "tool_call" });
    ordered.push(...t.chain);
    prevEnds = [t.last];
  }

  const ends: RunGraphNode[] = [];
  for (const m of turnMsgs) {
    if (m.role === "system") {
      ends.push(
        node({
          id: `note:${m.id}`,
          type: "note",
          label: "Note",
          status: "done",
          statusDetail: clip(m.content, 300),
          actor: { kind: "system", id: null, name: null },
          at: iso(m.createdAt),
        }),
      );
    }
  }
  const agentMsg = turnMsgs.find((m) => m.role === "agent");
  const waiting = steps.some((s) => s.status === "pending_confirmation" || s.status === "pending_approval");
  if (agentMsg && agentMsg.content && !waiting) {
    ends.push(
      node({
        id: `reply:${agentMsg.id}`,
        type: "reply",
        label: "Reply",
        status: "done",
        actor: { kind: "agent", id: thread.agentId, name: builder?.name ?? null },
        at: iso(agentMsg.createdAt),
        // the model cost already sits on the model steps; repeating it here would double-count
        facts: [
          ...(agentMsg.costUsd != null ? [{ label: "Turn model cost (USD)", value: agentMsg.costUsd.toFixed(6) }] : []),
          ...(agentMsg.latencyMs != null ? [{ label: "Turn latency", value: `${agentMsg.latencyMs} ms` }] : []),
        ],
      }),
    );
  }
  for (const e of ends) for (const p of prevEnds) edges.push({ from: p, to: e.id, kind: "next" });

  const all = [nodes[0]!, ...ordered, ...ends];
  return {
    ok: true,
    graph: summarise(
      "builder_turn",
      // never the thread title: it is the person's first message, cut to 80 characters
      { id: thread.id, label: `${builder?.name ?? "Agent"} · turn ${turn}` },
      all,
      edges,
      [
        "Message text and tool arguments are not shown here; open the thread to read them.",
        "A tool result withheld by policy stays withheld.",
        "Cost is the measured cost of each model step and tool call; a blank cost was not priced.",
      ],
    ),
    ...(viewer.userId !== thread.userId
      ? { crossUser: { objectType: "builder_agent" as const, objectId: thread.agentId, detail: { builderThreadId: thread.id, turn, threadUserId: thread.userId } } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Orchestration run
// ---------------------------------------------------------------------------

const NODE_STATUS: Record<string, RunGraphStatus> = {
  not_started: "not_started",
  in_progress: "active",
  blocked: "error",
  in_review: "waiting",
  done: "done",
};
const RUN_STATUS: Record<string, RunGraphStatus> = {
  planned: "not_started",
  running: "active",
  completed: "done",
  aborted: "stopped",
};

/** GET /v1/runs/:runId's rule: admin, initiator, or the named approver of a
 * PENDING approval on the run. Everything else reads as unknown. */
async function canViewRun(db: Db, viewer: Viewer, run: { id: string; initiatingUserId: string }): Promise<boolean> {
  if (viewer.isAdmin || viewer.userId === run.initiatingUserId) return true;
  if (!viewer.userId) return false;
  const [naming] = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.runId, run.id), eq(approvals.approverUserId, viewer.userId), eq(approvals.status, "pending")))
    .limit(1);
  return !!naming;
}

export async function orchestrationGraph(db: Db, viewer: Viewer, runId: string): Promise<Outcome> {
  const [run] = await db.select().from(orchestrationRuns).where(eq(orchestrationRuns.id, runId));
  if (!run) return { ok: false, status: 404, error: "unknown_run" };
  if (!(await canViewRun(db, viewer, run))) {
    return { ok: false, status: 404, error: "unknown_run", audit: { objectType: "run", objectId: run.id } };
  }
  const graph = run.graph as TaskGraph;
  const state = run.state as RunState;

  const nodeSpans = await db.select().from(traceSpans).where(eq(traceSpans.runId, run.id)).orderBy(asc(traceSpans.startedAt), asc(traceSpans.seq));
  const traceIds = [...new Set(nodeSpans.map((s) => s.traceId))];
  const allSpans: TraceSpanRow[] = traceIds.length ? await db.select().from(traceSpans).where(inArray(traceSpans.traceId, traceIds)) : [];
  const children = new Map<string, TraceSpanRow[]>();
  for (const s of allSpans) if (s.parentSpanId) children.set(s.parentSpanId, [...(children.get(s.parentSpanId) ?? []), s]);
  const subtreeCost = (id: string): number | null => {
    let total: number | null = null;
    const stack = [...(children.get(id) ?? [])];
    while (stack.length) {
      const s = stack.pop()!;
      if (s.costUsd != null) total = (total ?? 0) + s.costUsd;
      stack.push(...(children.get(s.id) ?? []));
    }
    return total;
  };

  const auditRows = await db
    .select({ id: auditLog.id, at: auditLog.at, detail: auditLog.detail })
    .from(auditLog)
    .where(and(eq(auditLog.objectType, "run"), eq(auditLog.objectId, run.id)))
    .orderBy(asc(auditLog.at), asc(auditLog.id));
  const auditByNode = new Map<string, string>();
  for (const r of auditRows) {
    const n = (r.detail as Record<string, unknown> | null)?.nodeId;
    if (typeof n === "string") auditByNode.set(n, r.id);
  }
  const approvalRows = await db.select().from(approvals).where(eq(approvals.runId, run.id)).orderBy(asc(approvals.requestedAt));
  const approvalAudit = auditByApproval(
    approvalRows.length
      ? await db
          .select({ id: auditLog.id, detail: auditLog.detail })
          .from(auditLog)
          .where(and(eq(auditLog.objectId, run.id), inArray(sql`${auditLog.detail}->>'approvalId'`, approvalRows.map((a) => a.id))))
          .orderBy(asc(auditLog.at), asc(auditLog.id))
      : [],
  );
  const owners = state.owners ?? {};
  const agentName = await agentNames(db, [...graph.nodes.map((n) => owners[n.id] ?? n.ownerAgentId)]);
  const names = await userNames(db, [run.initiatingUserId, ...approvalRows.flatMap((a) => [a.approverUserId, a.decidedBy])]);

  const nodes: RunGraphNode[] = [];
  const edges: RunGraphEdge[] = [];
  const runSpan = nodeSpans.find((s) => s.kind === "run") ?? null;
  nodes.push(
    node({
      id: "run",
      type: "run",
      label: "Run planned",
      status: RUN_STATUS[run.status] ?? "done",
      rawStatus: run.status,
      actor: person(run.initiatingUserId, names),
      at: iso(run.createdAt),
      links: { auditLogId: null, traceId: runSpan?.traceId ?? null, spanId: runSpan?.id ?? null, approvalId: null },
      facts: [
        { label: "Task nodes", value: String(graph.nodes.length) },
        ...(run.projectId ? [{ label: "Project", value: run.projectId }] : []),
      ],
    }),
  );

  // topological order (stable on the graph's own order) for the text alternative
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const placed = new Set<string>();
  const topo: typeof graph.nodes = [];
  while (topo.length < graph.nodes.length) {
    const next = graph.nodes.find((n) => !placed.has(n.id) && n.dependsOn.every((d) => placed.has(d) || !byId.has(d)));
    if (!next) {
      topo.push(...graph.nodes.filter((n) => !placed.has(n.id))); // a validated graph has no cycle; never loop
      break;
    }
    placed.add(next.id);
    topo.push(next);
  }

  const approvalsByNode = new Map<string, typeof approvalRows>();
  for (const a of approvalRows) {
    const target = (a.stageId ?? "").replace(/^__(?:node)?budget__:/, "");
    approvalsByNode.set(target, [...(approvalsByNode.get(target) ?? []), a]);
  }

  for (const t of topo) {
    const spansOf = nodeSpans.filter((s) => s.kind === "run_node" && s.nodeId === t.id);
    const latest = spansOf[spansOf.length - 1] ?? null;
    const costs = spansOf.map((s) => subtreeCost(s.id)).filter((c): c is number => c != null);
    const ownerId = owners[t.id] ?? t.ownerAgentId;
    const raw = state.nodeStatuses?.[t.id] ?? "not_started";
    const facts: RunGraphNode["facts"] = [
      { label: "Mode", value: t.mode },
      { label: "Attempts", value: String(state.attempts?.[t.id] ?? 0) },
      { label: "Runs in parallel", value: t.parallelizable ? "yes" : "no" },
    ];
    if (t.leadNodeId) facts.push({ label: "Lead", value: byId.get(t.leadNodeId)?.title ?? t.leadNodeId });
    if (t.budgetCapUsd != null) facts.push({ label: "Node budget cap (USD)", value: String(t.budgetCapUsd) });
    nodes.push(
      node({
        id: `task:${t.id}`,
        type: "task",
        label: t.title,
        status: NODE_STATUS[raw] ?? "not_started",
        rawStatus: raw,
        statusDetail: state.lastError?.[t.id] ? clip(state.lastError[t.id], 300) : (latest?.statusReason ?? null),
        actor: { kind: "agent", id: ownerId, name: agentName.get(ownerId) ?? null },
        at: iso(spansOf[0]?.startedAt),
        endedAt: iso(latest?.endedAt),
        costUsd: costs.length ? Number(costs.reduce((a, b) => a + b, 0).toFixed(8)) : null,
        links: { auditLogId: auditByNode.get(t.id) ?? null, traceId: latest?.traceId ?? null, spanId: latest?.id ?? null, approvalId: null },
        facts,
      }),
    );
    const deps = t.dependsOn.filter((d) => byId.has(d));
    if (!deps.length) edges.push({ from: "run", to: `task:${t.id}`, kind: "starts" });
    for (const d of deps) edges.push({ from: `task:${d}`, to: `task:${t.id}`, kind: "depends_on" });
    if (t.leadNodeId && byId.has(t.leadNodeId)) edges.push({ from: `task:${t.leadNodeId}`, to: `task:${t.id}`, kind: "leads" });

    for (const a of approvalsByNode.get(t.id) ?? []) {
      const stage = a.stageId ?? "";
      nodes.push(
        node({
          id: `approval:${a.id}`,
          type: "approval",
          label: stage.startsWith("__budget__:")
            ? "Budget overage approval"
            : stage.startsWith("__nodebudget__:")
              ? "Node budget approval"
              : "Escalation approval",
          status: approvalStatus(a.status),
          rawStatus: a.status,
          actor: person(a.decidedBy ?? a.approverUserId, names),
          at: iso(a.decidedAt ?? a.requestedAt),
          links: { auditLogId: approvalAudit.get(a.id) ?? null, traceId: null, spanId: null, approvalId: a.id },
          facts: [{ label: "Requested", value: a.requestedAt.toISOString() }],
        }),
      );
      edges.push({ from: `task:${t.id}`, to: `approval:${a.id}`, kind: "escalated" });
    }
  }
  // approvals naming no node of this graph still belong to the run
  for (const [target, rows] of approvalsByNode) {
    if (byId.has(target)) continue;
    for (const a of rows) {
      nodes.push(
        node({
          id: `approval:${a.id}`,
          type: "approval",
          label: "Run approval",
          status: approvalStatus(a.status),
          rawStatus: a.status,
          actor: person(a.decidedBy ?? a.approverUserId, names),
          at: iso(a.decidedAt ?? a.requestedAt),
          links: { auditLogId: approvalAudit.get(a.id) ?? null, traceId: null, spanId: null, approvalId: a.id },
        }),
      );
      edges.push({ from: "run", to: `approval:${a.id}`, kind: "escalated" });
    }
  }

  return {
    ok: true,
    graph: summarise("orchestration", { id: run.id, label: run.name }, nodes, edges, [
      "Edges follow the task graph's dependencies; a dashed edge is a lead delegating to a worker.",
      "A task's cost is the measured cost of every model turn and tool call under its node spans, across attempts.",
    ]),
  };
}

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export async function useCaseGraph(db: Db, viewer: Viewer, useCaseId: string): Promise<Outcome> {
  const [uc] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
  if (!uc) return { ok: false, status: 404, error: "not_found" };
  if (!(await canReadUseCase(db, uc, viewer))) {
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      detail: "a use case is visible to its owner, its reviewers and admins",
      audit: { objectType: "ai_use_case", objectId: uc.id },
    };
  }
  const now = new Date();

  const auditRows = await db
    .select({ id: auditLog.id, at: auditLog.at, ruleId: auditLog.ruleId, detail: auditLog.detail, userId: auditLog.userId })
    .from(auditLog)
    .where(
      or(
        and(eq(auditLog.objectType, "ai_use_case"), eq(auditLog.objectId, uc.id)),
        ...(uc.workflowInstanceId ? [and(eq(auditLog.objectType, "workflow"), eq(auditLog.objectId, uc.workflowInstanceId))] : []),
      ),
    )
    .orderBy(asc(auditLog.at), asc(auditLog.id));
  const latestRule = (pred: (ruleId: string | null) => boolean) => [...auditRows].reverse().find((r) => pred(r.ruleId)) ?? null;

  const artifacts = uc.workflowInstanceId
    ? await db
        .select({ id: workflowArtifacts.id, version: workflowArtifacts.version, createdAt: workflowArtifacts.createdAt, createdBy: workflowArtifacts.createdBy })
        .from(workflowArtifacts)
        .where(and(eq(workflowArtifacts.instanceId, uc.workflowInstanceId), eq(workflowArtifacts.output, USE_CASE_QUESTIONNAIRE_OUTPUT)))
        .orderBy(asc(workflowArtifacts.version))
    : [];
  const approvalRows = uc.workflowInstanceId
    ? await db
        .select()
        .from(approvals)
        .where(eq(approvals.instanceId, uc.workflowInstanceId))
        .orderBy(asc(approvals.requestedAt), asc(approvals.id))
    : [];
  const conditions = await db
    .select()
    .from(useCaseConditions)
    .where(eq(useCaseConditions.useCaseId, uc.id))
    .orderBy(asc(useCaseConditions.dueAt), asc(useCaseConditions.createdAt), asc(useCaseConditions.id));
  // a resubmission draft is personal: shown only to the person whose draft it is
  const [draft] = viewer.userId
    ? await db
        .select({ id: useCaseDrafts.id, updatedAt: useCaseDrafts.updatedAt })
        .from(useCaseDrafts)
        .where(and(eq(useCaseDrafts.userId, viewer.userId), eq(useCaseDrafts.scope, uc.id)))
    : [];
  const names = await userNames(db, [
    uc.ownerUserId,
    ...artifacts.map((a) => a.createdBy),
    ...approvalRows.flatMap((a) => [a.approverUserId, a.decidedBy]),
    ...conditions.flatMap((c) => [c.ownerUserId, c.metByUserId]),
  ]);
  const approvalAudit = auditByApproval(auditRows);
  // a review round opened lists its approval ids
  for (const r of auditRows) {
    if (r.ruleId !== "use-case-review-round-opened") continue;
    const ids = (r.detail as Record<string, unknown> | null)?.approvalIds;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string" && !approvalAudit.has(id)) approvalAudit.set(id, r.id);
  }

  const stages: RunGraphNode[][] = [];
  const proposed = latestRule((r) => r === "use-case-proposed");
  stages.push([
    node({
      id: "intake",
      type: "intake",
      label: "Registered",
      status: "done",
      actor: person(uc.ownerUserId, names),
      at: iso(uc.createdAt),
      links: { auditLogId: proposed?.id ?? null, traceId: null, spanId: null, approvalId: null },
      facts: [{ label: "Name", value: uc.name }],
    }),
  ]);
  stages.push([
    node({
      id: "classification",
      type: "classification",
      label: "Classification",
      status: "done",
      actor: person(uc.ownerUserId, names),
      at: iso(uc.createdAt),
      facts: [
        { label: "Data sensitivity", value: uc.dataSensitivity },
        { label: "Compliance tags", value: (uc.complianceTags ?? []).join(", ") || "none" },
      ],
    }),
  ]);
  const screeningAudit = latestRule((r) => r === "use-case-eu-tier");
  stages.push([
    node({
      id: "screening",
      type: "screening",
      label: uc.euAiActTier ? `EU AI Act screening: ${uc.euAiActTier}` : "EU AI Act screening",
      status: uc.euAiActTier ? "done" : "not_started",
      rawStatus: uc.euAiActTier,
      statusDetail: uc.euAiActTier ? null : "not screened",
      actor: { kind: "system", id: null, name: "Screening rule set" },
      at: iso(screeningAudit?.at),
      links: { auditLogId: screeningAudit?.id ?? null, traceId: null, spanId: null, approvalId: null },
      facts: [
        ...(uc.euAiActRulesetVersion != null ? [{ label: "Rule set", value: `v${uc.euAiActRulesetVersion}` }] : []),
        ...(uc.euAiActReasons?.length ? [{ label: "Rules fired", value: uc.euAiActReasons.map((r) => r.ruleId).join(", ") }] : []),
        ...((uc.screeningUnsure ?? []).length ? [{ label: "Answered “not sure”", value: String(uc.screeningUnsure.length) }] : []),
      ],
    }),
  ]);

  // questionnaire versions, each followed by the reviews requested after it
  // A submission writes its artifact and requests the sign-off in one request,
  // and the approval row can carry the earlier of the two timestamps (a few ms
  // before the artifact's). A resubmission comes from a person, seconds or days
  // later, so a small tolerance attributes each sign-off to its own version.
  const SAME_SUBMISSION_MS = 2_000;
  const versionFor = (at: Date) => {
    let v: (typeof artifacts)[number] | null = null;
    for (const a of artifacts) if (a.createdAt.getTime() <= at.getTime() + SAME_SUBMISSION_MS) v = a;
    return v;
  };
  const unattached = approvalRows.filter((a) => !versionFor(a.requestedAt));
  if (unattached.length) stages.push(unattached.map((a) => reviewNode(a)));
  for (const art of artifacts) {
    stages.push([
      node({
        id: `questionnaire:${art.id}`,
        type: "questionnaire",
        label: `Questionnaire v${art.version}`,
        status: "done",
        actor: person(art.createdBy, names),
        at: iso(art.createdAt),
      }),
    ]);
    const rows = approvalRows.filter((a) => versionFor(a.requestedAt)?.id === art.id);
    if (rows.length) stages.push(rows.map((a) => reviewNode(a)));
  }
  function reviewNode(a: (typeof approvalRows)[number]): RunGraphNode {
    return node({
      id: `review:${a.id}`,
      type: "review",
      label: a.reviewRoleName ? `Review: ${a.reviewRoleName}${a.reviewRound ? ` (round ${a.reviewRound})` : ""}` : "Sign-off",
      status: approvalStatus(a.status),
      rawStatus: a.status,
      statusDetail: a.status === "returned" ? "sent back for information" : null,
      actor: person(a.decidedBy ?? a.approverUserId, names),
      at: iso(a.decidedAt ?? a.requestedAt),
      links: { auditLogId: approvalAudit.get(a.id) ?? null, traceId: null, spanId: null, approvalId: a.id },
      facts: [{ label: "Requested", value: a.requestedAt.toISOString() }],
    });
  }

  if (draft) {
    stages.push([
      node({
        id: "draft",
        type: "draft",
        label: "Your resubmission draft",
        status: "waiting",
        actor: person(viewer.userId, names),
        at: iso(draft.updatedAt),
      }),
    ]);
  }

  const decided = uc.status === "approved" || uc.status === "rejected" || uc.status === "retired" || uc.decidedAt != null;
  const decisionAudit = latestRule((r) => r === "use-case-approved" || r === "use-case-rejected");
  stages.push([
    node({
      id: "decision",
      type: "decision",
      label: decided ? `Decision: ${uc.status === "retired" ? "retired" : (decisionAudit?.ruleId ?? `use-case-${uc.status}`).replace("use-case-", "")}` : "Decision",
      status:
        uc.status === "approved"
          ? "done"
          : uc.status === "rejected"
            ? "denied"
            : uc.status === "retired"
              ? "stopped"
              : uc.status === "needs_info"
                ? "waiting"
                : uc.status === "under_review"
                  ? "waiting"
                  : "not_started",
      rawStatus: uc.status,
      statusDetail: uc.status === "retired" ? clip(uc.retiredReason, 300) : uc.recertification ? "back in review for recertification" : null,
      actor: decisionAudit ? person(decisionAudit.userId, names) : null,
      at: iso(uc.decidedAt ?? uc.retiredAt ?? decisionAudit?.at),
      links: { auditLogId: decisionAudit?.id ?? null, traceId: null, spanId: null, approvalId: null },
    }),
  ]);

  const tail: RunGraphNode[] = [];
  const conditionsAudit = latestRule((r) => r === "use-case-conditions-imposed");
  const condMet = new Map<string, string>();
  for (const r of auditRows) {
    const cid = (r.detail as Record<string, unknown> | null)?.conditionId;
    if (r.ruleId === "use-case-condition-met" && typeof cid === "string") condMet.set(cid, r.id);
  }
  for (const c of conditions) {
    const overdue = c.status === "open" && c.dueAt.getTime() < now.getTime();
    tail.push(
      node({
        id: `condition:${c.id}`,
        type: "condition",
        label: `Condition: ${clip(c.text, 80)}`,
        status: c.status === "open" ? (overdue ? "expired" : "waiting") : c.status === "met" ? "done" : "skipped",
        rawStatus: c.status,
        statusDetail: overdue ? "overdue" : null,
        actor: person(c.status === "open" ? c.ownerUserId : (c.metByUserId ?? c.ownerUserId), names),
        at: iso(c.metAt ?? c.createdAt),
        links: { auditLogId: condMet.get(c.id) ?? conditionsAudit?.id ?? null, traceId: null, spanId: null, approvalId: c.approvalId },
        facts: [
          { label: "Text", value: c.text },
          { label: "When", value: c.blocking ? "before go-live (blocks deployment)" : "after go-live" },
          { label: "Due", value: c.dueAt.toISOString() },
        ],
      }),
    );
  }
  if (uc.approvedUntil) {
    const expired = uc.approvedUntil.getTime() <= now.getTime();
    const recert = latestRule((r) => r === "use-case-recertification-started");
    tail.push(
      node({
        id: "expiry",
        type: "expiry",
        label: expired ? "Approval expired" : "Approval valid",
        status: expired ? "expired" : "done",
        statusDetail: uc.recertification ? "recertification in progress" : null,
        actor: { kind: "system", id: null, name: "Approval lifetime" },
        at: iso(uc.approvedUntil),
        links: { auditLogId: recert?.id ?? null, traceId: null, spanId: null, approvalId: null },
        facts: [
          ...(uc.approvedAt ? [{ label: "Approved", value: uc.approvedAt.toISOString() }] : []),
          { label: "Valid until", value: uc.approvedUntil.toISOString() },
        ],
      }),
    );
  }
  if (tail.length) stages.push(tail);

  const edges: RunGraphEdge[] = [];
  for (let i = 1; i < stages.length; i++) {
    for (const to of stages[i]!) {
      // a condition hangs from the sign-off that imposed it when that sign-off is on the graph
      const imposedBy = to.type === "condition" && to.links.approvalId ? `review:${to.links.approvalId}` : null;
      if (imposedBy && stages.some((s) => s.some((n) => n.id === imposedBy))) {
        edges.push({ from: "decision", to: to.id, kind: "next" });
        edges.push({ from: imposedBy, to: to.id, kind: "imposed" });
        continue;
      }
      for (const from of stages[i - 1]!) edges.push({ from: from.id, to: to.id, kind: "next" });
    }
  }
  return {
    ok: true,
    graph: summarise("use_case", { id: uc.id, label: uc.name }, stages.flat(), edges, [
      "Questionnaire answers are not shown here; open the use case to read them.",
      "Reviews are grouped under the questionnaire version they followed.",
    ]),
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const turnParams = z.object({ threadId: z.string().uuid(), turn: z.coerce.number().int().min(1).max(100_000) });
const runParams = z.object({ runId: z.string().uuid() });
const useCaseParams = z.object({ useCaseId: z.string().uuid() });

export function registerRunGraphRoutes(app: FastifyInstance, db: Db): void {
  const send = async (
    req: { authCtx: { userId: string | null; isAdmin: boolean } },
    reply: { status: (n: number) => { send: (b: unknown) => unknown } },
    kind: RunGraphKind,
    out: Outcome,
  ) => {
    const userId = req.authCtx.userId ?? NIL_UUID;
    if (!out.ok) {
      if (out.audit) {
        await db.insert(auditLog).values({
          userId,
          objectType: out.audit.objectType,
          objectId: out.audit.objectId,
          detail: { surface: "run_graph", kind, error: out.error },
          effect: "deny",
          ruleId: RUN_GRAPH_RULE_IDS.refused,
          ruleChain: [],
          reason: `refused a run-graph read of a ${kind.replace("_", " ")} the caller may not open`,
        });
      }
      return reply.status(out.status).send({ error: out.error, ...(out.detail ? { detail: out.detail } : {}) });
    }
    if (out.crossUser) {
      await db.insert(auditLog).values({
        userId,
        objectType: out.crossUser.objectType,
        objectId: out.crossUser.objectId,
        detail: { surface: "run_graph", kind, ...out.crossUser.detail },
        effect: "allow",
        ruleId: RUN_GRAPH_RULE_IDS.crossUser,
        ruleChain: [],
        reason: "an admin read the run graph of another person's builder turn",
      });
    }
    return out.graph;
  };

  app.get("/v1/run-graph/builder-turn/:threadId/:turn", async (req, reply) => {
    const { threadId, turn } = turnParams.parse(req.params);
    return send(req, reply, "builder_turn", await builderTurnGraph(db, req.authCtx, threadId, turn));
  });
  app.get("/v1/run-graph/orchestration/:runId", async (req, reply) => {
    const { runId } = runParams.parse(req.params);
    return send(req, reply, "orchestration", await orchestrationGraph(db, req.authCtx, runId));
  });
  app.get("/v1/run-graph/use-case/:useCaseId", async (req, reply) => {
    const { useCaseId } = useCaseParams.parse(req.params);
    return send(req, reply, "use_case", await useCaseGraph(db, req.authCtx, useCaseId));
  });
}
