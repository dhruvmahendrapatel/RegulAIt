/**
 * ADR-0172 — the builder agent RUNTIME: one chat turn, and the schedule sweep.
 *
 * A turn is an ordinary governed dispatch made AS THE PERSON USING THE AGENT:
 *
 *   1. the builder agent's monthly limit is checked FIRST, from the cost the
 *      governed core measured on earlier turns (402 agent_spend_limit_reached);
 *   2. the caller's entitlement to the agent's model binding is decided by
 *      the copilot's `agentDecision` — the same `evaluateAgent` inputs the
 *      invoke route loads — and a denial is audited and traced exactly like the
 *      compat path's (403 agent_denied);
 *   3. `executeGovernedDispatch` — the one core every dispatch surface shares —
 *      applies the virtual-key allow-list and budget, kill switch, lifecycle,
 *      MRM, PII, guardrails, egress and credentials, writes the usage/cost
 *      rows and the trace. Any refusal from it is returned with its status and
 *      code UNCHANGED.
 *
 * The core has no builder attribution tag, so builder spend is computed from
 * `builder_messages.cost_usd` (the core's own measured `costUsd`), and the
 * dispatch's audit row carries the builder agent and thread ids in `detail`.
 *
 * Phase 1 honesty: the toolbox is DESCRIBED to the model (and re-checked for
 * the person at run time: a tool they no longer hold is listed as
 * unavailable), but no tool is executed.
 */
import {
  agents,
  and,
  asc,
  auditLog,
  builderAgentMemory,
  builderAgentSchedules,
  builderAgentSkills,
  builderAgentTools,
  builderAgents,
  builderMessages,
  builderSkills,
  builderThreads,
  desc,
  eq,
  gte,
  isNull,
  lte,
  sql,
  users,
  type BuilderAgentRow,
  type BuilderMessageRow,
  type BuilderThreadRow,
  type Db,
} from "@regulait/db";
import type { ModelChatMessage } from "@regulait/model-provider";
import { nextScheduleRun, type BuilderCadenceValue } from "@regulait/shared";
import { executeGovernedDispatch, type AgentRow } from "./agents-connectors.js";
import { agentDecision } from "./copilot.js";
import {
  entitledConnectorIds,
  entitledMcpToolIds,
  loadConnectorsById,
  loadMcpTools,
} from "./builder-access.js";
import { beginTrace, finishTrace, recordSpan } from "./tracing.js";
import type { VirtualKeyContext } from "./virtual-keys.js";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
/** how much prior conversation a turn replays to the model */
const HISTORY_LIMIT = 40;

export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** spend recorded on this builder agent's messages since `since` */
export async function builderAgentSpend(db: Db, agentId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${builderMessages.costUsd}), 0)::float8` })
    .from(builderMessages)
    .where(and(eq(builderMessages.agentId, agentId), gte(builderMessages.createdAt, since)));
  return Number(row?.total ?? 0);
}

export function messageView(m: BuilderMessageRow) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model,
    costUsd: m.costUsd,
    latencyMs: m.latencyMs,
    createdAt: m.createdAt.toISOString(),
  };
}

/** the system prompt: instructions + skills + memory + a described toolbox */
export async function buildSystemPrompt(db: Db, agent: BuilderAgentRow, userId: string): Promise<string> {
  const [skills, memory, tools] = await Promise.all([
    db
      .select({ name: builderSkills.name, body: builderSkills.body })
      .from(builderAgentSkills)
      .innerJoin(builderSkills, eq(builderAgentSkills.skillId, builderSkills.id))
      .where(and(eq(builderAgentSkills.agentId, agent.id), isNull(builderSkills.archivedAt)))
      .orderBy(asc(builderSkills.name)),
    db
      .select({ content: builderAgentMemory.content })
      .from(builderAgentMemory)
      .where(eq(builderAgentMemory.agentId, agent.id))
      .orderBy(desc(builderAgentMemory.createdAt))
      .limit(20),
    db.select().from(builderAgentTools).where(eq(builderAgentTools.agentId, agent.id)),
  ]);
  const parts: string[] = [];
  parts.push(agent.instructions.trim() || `You are ${agent.name}. ${agent.description}`.trim());
  for (const s of skills) parts.push(`## Skill: ${s.name}\n\n${s.body.trim()}`);
  if (memory.length) parts.push(`## Memory (newest first)\n${memory.map((m) => `- ${m.content}`).join("\n")}`);

  if (tools.length) {
    const connectorRows = await loadConnectorsById(
      db,
      tools.filter((t) => t.kind === "connector").map((t) => t.refId),
    );
    const mcpRows = await loadMcpTools(
      db,
      tools.filter((t) => t.kind === "mcp_tool").map((t) => t.refId),
    );
    const [okConnectors, okTools] = await Promise.all([
      entitledConnectorIds(db, userId),
      entitledMcpToolIds(db, userId, mcpRows),
    ]);
    const lines: string[] = [];
    for (const t of tools) {
      if (t.kind === "connector") {
        const c = connectorRows.find((r) => r.id === t.refId);
        if (!c) continue;
        lines.push(`- ${c.name} (connector${t.requiresApproval ? ", needs approval" : ""})${okConnectors.has(c.id) ? "" : " — not available to this user"}`);
      } else {
        const m = mcpRows.find((r) => r.id === t.refId);
        if (!m) continue;
        lines.push(`- ${m.serverName}/${m.name} (MCP tool${t.requiresApproval ? ", needs approval" : ""})${okTools.has(m.id) ? "" : " — not available to this user"}`);
      }
    }
    if (lines.length) {
      parts.push(
        `## Toolbox (described for planning; tools are not executed in this release — ask the person to run them)\n${lines.join("\n")}`,
      );
    }
  }
  return parts.join("\n\n");
}

export type TurnOutcome =
  | { ok: true; thread: BuilderThreadRow; messages: BuilderMessageRow[] }
  | { ok: false; status: number; error: string; detail?: string; threadId?: string };

export interface TurnArgs {
  agent: BuilderAgentRow;
  /** the human the dispatch runs as */
  userId: string;
  message: string;
  threadId?: string | undefined;
  source: "chat" | "schedule" | "channel";
  scheduleId?: string | null;
  virtualKey?: VirtualKeyContext | null;
}

async function audit(
  db: Db,
  userId: string,
  objectId: string,
  ruleId: string,
  reason: string,
  detail: Record<string, unknown>,
  effect: "allow" | "deny" = "allow",
) {
  await db.insert(auditLog).values({
    userId,
    objectType: "builder_agent",
    objectId,
    detail,
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

export async function runBuilderTurn(db: Db, dataKey: string | undefined, args: TurnArgs): Promise<TurnOutcome> {
  const { agent, userId, message } = args;

  // the thread first (so an unknown/foreign thread is refused before anything)
  let thread: BuilderThreadRow | null = null;
  if (args.threadId) {
    const [t] = await db.select().from(builderThreads).where(eq(builderThreads.id, args.threadId));
    if (!t || t.agentId !== agent.id) return { ok: false, status: 404, error: "unknown_thread" };
    if (t.userId !== userId) return { ok: false, status: 403, error: "not_your_thread" };
    thread = t;
  }

  // 1. THE MONTHLY LIMIT, before any dispatch work.
  if (agent.monthlyLimitUsd != null) {
    const spent = await builderAgentSpend(db, agent.id, monthStartUtc());
    if (spent >= agent.monthlyLimitUsd) {
      const detail =
        `builder agent '${agent.name}' has spent $${spent.toFixed(4)} of its $${agent.monthlyLimitUsd.toFixed(2)} ` +
        `monthly limit; the owner can raise the limit or wait for next month`;
      await audit(db, userId, agent.id, "builder-agent-spend-limit-reached", detail, {
        spentUsd: spent,
        limitUsd: agent.monthlyLimitUsd,
        source: args.source,
      }, "deny");
      return { ok: false, status: 402, error: "agent_spend_limit_reached", detail };
    }
  }

  if (!agent.modelAgentId) {
    return { ok: false, status: 409, error: "builder_agent_has_no_model", detail: "choose a model for this agent first" };
  }
  const [model] = await db.select().from(agents).where(eq(agents.id, agent.modelAgentId));
  if (!model) return { ok: false, status: 409, error: "builder_agent_has_no_model", detail: "the agent's model no longer exists" };

  const ensureThread = async (): Promise<BuilderThreadRow> => {
    if (thread) return thread;
    const title = message.replace(/\s+/g, " ").trim().slice(0, 80) || agent.name;
    const [t] = await db
      .insert(builderThreads)
      .values({
        agentId: agent.id,
        userId,
        title,
        source: args.source,
        scheduleId: args.scheduleId ?? null,
        status: args.source === "schedule" ? "needs_attention" : "active",
      })
      .returning();
    thread = t!;
    return thread;
  };
  const baseDetail = {
    surface: "builder",
    builderAgentId: agent.id,
    builderAgentName: agent.name,
    source: args.source,
  };

  // 2. THE CALLER'S ENTITLEMENT to the model binding.
  const decision = await agentDecision(db, userId, model as AgentRow);
  if (decision.effect !== "allow") {
    const [row] = await db
      .insert(auditLog)
      .values({
        userId,
        objectType: "agent",
        objectId: model.id,
        detail: { ...baseDetail, mode: "chat" },
        effect: decision.effect,
        ruleId: decision.ruleId,
        ruleChain: decision.ruleChain,
        reason: decision.reason,
      })
      .returning({ id: auditLog.id });
    const denyTrace = await beginTrace(db, { kind: "dispatch", name: `denied: ${model.name}`, userId, projectId: null });
    if (denyTrace) {
      const at = new Date();
      await recordSpan(db, denyTrace, {
        kind: "policy",
        name: `entitlement: ${model.name}`,
        status: "denied",
        statusReason: decision.reason,
        startedAt: at,
        endedAt: at,
        agentId: model.id,
        auditLogId: row?.id ?? null,
        provider: model.provider,
        model: model.model,
        attributes: { ...baseDetail, ruleId: decision.ruleId, effect: decision.effect },
      });
      await finishTrace(db, denyTrace, "denied", at);
    }
    const t = await ensureThread();
    await recordRefusal(db, t, agent.id, userId, message, "agent_denied", decision.reason);
    return { ok: false, status: 403, error: "agent_denied", detail: decision.reason, threadId: t.id };
  }

  // 3. THE GOVERNED CORE.
  const t = await ensureThread();
  const history = await db
    .select()
    .from(builderMessages)
    .where(eq(builderMessages.threadId, t.id))
    .orderBy(desc(builderMessages.createdAt))
    .limit(HISTORY_LIMIT);
  const messages: ModelChatMessage[] = history
    .reverse()
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "agent" ? ("assistant" as const) : ("user" as const), content: m.content }));
  messages.push({ role: "user", content: message });
  const system = await buildSystemPrompt(db, agent, userId);
  const started = Date.now();
  const outcome = await executeGovernedDispatch(db, dataKey, {
    userId,
    served: model as AgentRow,
    requestedAgentId: model.id,
    baseline: null,
    input: message,
    messages,
    system,
    projectId: null,
    virtualKey: args.virtualKey ?? null,
    mode: "chat",
    detail: { ...baseDetail, builderThreadId: t.id },
  });
  const latencyMs = Date.now() - started;

  // the decision row the invoke route writes for every governed call
  await db.insert(auditLog).values({
    userId,
    objectType: "agent",
    objectId: model.id,
    detail: {
      ...baseDetail,
      mode: "chat",
      builderThreadId: t.id,
      dispatch: outcome.ok
        ? { model: outcome.result.model, stopReason: outcome.result.stopReason, refusal: outcome.result.refusal }
        : { error: outcome.error },
    },
    effect: decision.effect,
    ruleId: decision.ruleId,
    ruleChain: decision.ruleChain,
    reason: decision.reason,
  });

  if (!outcome.ok) {
    await recordRefusal(db, t, agent.id, userId, message, outcome.error, outcome.detail ?? null);
    return {
      ok: false,
      status: outcome.status,
      error: outcome.error,
      ...(outcome.detail ? { detail: outcome.detail } : {}),
      threadId: t.id,
    };
  }

  const servedId = outcome.result.servedAgentId;
  const [served] = servedId === model.id ? [model] : await db.select().from(agents).where(eq(agents.id, servedId));
  const now = new Date();
  const inserted = await db
    .insert(builderMessages)
    .values([
      { threadId: t.id, agentId: agent.id, userId, role: "user", content: message, createdAt: new Date(now.getTime() - 1) },
      {
        threadId: t.id,
        agentId: agent.id,
        userId,
        role: "agent",
        content: outcome.result.outputText,
        modelAgentId: servedId,
        provider: served?.provider ?? model.provider,
        model: outcome.result.model,
        costUsd: outcome.result.costUsd,
        latencyMs,
        createdAt: now,
      },
    ])
    .returning();
  const [updated] = await db
    .update(builderThreads)
    .set({ updatedAt: now, ...(args.source === "schedule" ? { status: "needs_attention" as const } : {}) })
    .where(eq(builderThreads.id, t.id))
    .returning();
  return { ok: true, thread: updated ?? t, messages: inserted.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()) };
}

/** a refused turn leaves an honest trace in the thread: the person's message
 * and a system note naming the refusal (never replayed to a model) */
async function recordRefusal(
  db: Db,
  thread: BuilderThreadRow,
  agentId: string,
  userId: string,
  message: string,
  code: string,
  detail: string | null,
) {
  const now = new Date();
  await db.insert(builderMessages).values([
    { threadId: thread.id, agentId, userId, role: "user", content: message, createdAt: new Date(now.getTime() - 1) },
    {
      threadId: thread.id,
      agentId,
      userId,
      role: "system",
      content: `Refused (${code})${detail ? `: ${detail}` : ""}`,
      createdAt: now,
    },
  ]);
  await db
    .update(builderThreads)
    .set({ updatedAt: now, status: "needs_attention" })
    .where(eq(builderThreads.id, thread.id));
}

// ---------------------------------------------------------------------------
// the schedule sweep
// ---------------------------------------------------------------------------

export interface BuilderScheduleSweepResult {
  due: number;
  ran: number;
  refused: number;
  skipped: Array<{ scheduleId: string; reason: string }>;
  threadIds: string[];
}

/**
 * Run every enabled schedule whose `next_run_at` has passed, AS THE AGENT'S
 * OWNER (never as an admin, never as the scheduler — it has no identity). Each
 * due schedule is CLAIMED by a compare-and-swap on `next_run_at` before it
 * runs, so two concurrent sweeps (or a manual sweep racing the timer) run it
 * once, and a re-run at the same instant finds nothing due: idempotent.
 */
export async function runBuilderScheduleSweep(
  db: Db,
  dataKey: string | undefined,
  opts: { now?: Date } = {},
): Promise<BuilderScheduleSweepResult> {
  const now = opts.now ?? new Date();
  const out: BuilderScheduleSweepResult = { due: 0, ran: 0, refused: 0, skipped: [], threadIds: [] };
  const due = await db
    .select()
    .from(builderAgentSchedules)
    .where(and(eq(builderAgentSchedules.enabled, true), lte(builderAgentSchedules.nextRunAt, now)))
    .orderBy(asc(builderAgentSchedules.nextRunAt))
    .limit(200);
  out.due = due.length;
  for (const s of due) {
    const next = nextScheduleRun(s.cadence as BuilderCadenceValue, s.timeUtc, now, s.createdAt);
    const claimed = await db
      .update(builderAgentSchedules)
      .set({ nextRunAt: next, lastRunAt: now, updatedAt: now })
      .where(and(eq(builderAgentSchedules.id, s.id), eq(builderAgentSchedules.nextRunAt, s.nextRunAt!)))
      .returning({ id: builderAgentSchedules.id });
    if (!claimed.length) continue; // another sweep took it
    const [agent] = await db.select().from(builderAgents).where(eq(builderAgents.id, s.agentId));
    if (!agent || agent.archivedAt) {
      out.skipped.push({ scheduleId: s.id, reason: "agent archived" });
      continue;
    }
    const [owner] = await db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, agent.ownerUserId));
    if (!owner || owner.disabledAt) {
      out.skipped.push({ scheduleId: s.id, reason: "agent owner is deactivated" });
      await audit(db, ZERO_UUID, agent.id, "builder-agent-schedule-skipped", `schedule '${s.name}' skipped: the agent owner is deactivated`, { scheduleId: s.id }, "deny");
      continue;
    }
    const turn = await runBuilderTurn(db, dataKey, {
      agent,
      userId: agent.ownerUserId,
      message: s.prompt,
      source: "schedule",
      scheduleId: s.id,
    });
    if (turn.ok) {
      out.ran++;
      out.threadIds.push(turn.thread.id);
    } else {
      out.refused++;
      if (turn.threadId) out.threadIds.push(turn.threadId);
      else out.skipped.push({ scheduleId: s.id, reason: turn.error });
    }
    await audit(
      db,
      agent.ownerUserId,
      agent.id,
      "builder-agent-schedule-ran",
      `schedule '${s.name}' ran as the agent owner: ${turn.ok ? "answered" : `refused (${turn.error})`}`,
      { scheduleId: s.id, outcome: turn.ok ? "answered" : turn.error, nextRunAt: next.toISOString() },
      turn.ok ? "allow" : "deny",
    );
  }
  return out;
}
