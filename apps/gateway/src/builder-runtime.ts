/**
 * ADR-0172 / ADR-0173 — the builder agent RUNTIME: one turn (a bounded,
 * governed tool loop), its resumption after a pause, and the schedule sweep.
 *
 * A turn runs AS THE PERSON USING THE AGENT (a schedule runs as the agent's
 * owner; a channel turn as the linked platform user):
 *
 *   1. the builder agent's monthly limit is checked FIRST, from the cost the
 *      governed core measured on earlier turns AND the cost of the governed
 *      tool calls they made (402 agent_spend_limit_reached). For a LIMITED
 *      agent the turn runs under a per-agent lease (renewed while a long loop
 *      runs), so concurrent turns cannot both pass the check, and every binding
 *      that could serve it must be priced (409 agent_limit_needs_priced_model);
 *   2. then a LOOP of model steps, at most the org's `defaultWorkerMaxTurns`
 *      (capped by `maxWorkerTurns`) and at most BUILDER_LIMITS.toolCallsPerTurn
 *      tool calls. BEFORE EVERY STEP the caller's entitlement to the model
 *      binding is re-decided by the copilot's `agentDecision` (so a kill
 *      switch or a revoked grant stops the loop between steps, 403
 *      agent_denied) and the monthly limit is re-checked (402) — before every
 *      tool call too, since tool calls cost money;
 *   3. each step is ONE `executeGovernedDispatch` (virtual key, budget, kill
 *      switch, lifecycle, MRM, PII, guardrails, egress, credentials, usage,
 *      trace) with the agent's toolbox as tool definitions — the toolbox
 *      RE-CHECKED for the person (builder-tools.ts), so a shared agent never
 *      offers a tool its user lacks. Any refusal is returned with its status
 *      and code UNCHANGED;
 *   4. each tool call the model asks for runs through the governed path for
 *      its kind (MCP: executeGovernedToolCall; connectors:
 *      executeGovernedConnectorCall) AS THAT PERSON, and is recorded as a
 *      `builder_tool_steps` row on the turn's agent message. Its result goes
 *      back to the model as a tool_result.
 *
 * TWO PAUSES, NEVER CONFLATED. A tool marked "Ask first" pauses for the person
 * in the thread (`pending_confirmation`; POST …/steps/:stepId/confirm) — a
 * confirmation, not an approval. An organisation approval rule pauses in the
 * approvals queue (`pending_approval`, the approval id on the step, under the
 * existing argument-digest binding); deciding it resumes the turn from the
 * decide path's post-commit hook: approved -> the IDENTICAL call is made again
 * (the governed path consumes the bound approval), denied -> the model is told
 * who denied it and why and continues. A paused turn's model conversation is
 * kept encrypted on the thread (it holds the raw arguments the resume must
 * replay byte-for-byte) and cleared when the turn finishes.
 *
 * Spend: an agent message's `cost_usd` is the model cost of its turn; each
 * tool step carries its own measured cost; the monthly limit sums both.
 */
import { randomUUID } from "node:crypto";
import {
  agentFallbacks,
  agents,
  and,
  approvals,
  asc,
  auditLog,
  builderAgentMemory,
  builderAgentSchedules,
  builderAgentSkills,
  builderAgents,
  builderMessages,
  builderSkills,
  builderThreads,
  builderToolSteps,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  users,
  type BuilderAgentRow,
  type BuilderMessageRow,
  type BuilderThreadRow,
  type BuilderToolStepRow,
  type Db,
} from "@regulait/db";
import type { ModelChatMessage, ModelContentBlock } from "@regulait/model-provider";
import { BUILDER_LIMITS, nextScheduleRun, type BuilderCadenceValue } from "@regulait/shared";
import { executeGovernedDispatch, type AgentRow } from "./agents-connectors.js";
import { agentDecision } from "./copilot.js";
import { BUILDER_MODEL_FEATURE, loadVisibleAgent, skillVisible } from "./builder-access.js";
import { MODEL_NOT_ALLOWED_FOR_FEATURE } from "./model-policy.js";
import {
  argumentsDigestFor,
  redactedArguments,
  resolveToolbox,
  runGovernedTool,
  toolboxPrompt,
  type ToolEntry,
  type Toolbox,
  type ToolRun,
} from "./builder-tools.js";
import { loadOrgSettings } from "./org-settings.js";
import { assertProjectAttribution, piiInternationalCategories, projectPiiMode } from "./projects.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { beginTrace, childContext, finishTrace, recordSpan, type TraceContext } from "./tracing.js";
import type { VirtualKeyContext } from "./virtual-keys.js";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
/** how much prior conversation a turn replays to the model */
const HISTORY_LIMIT = 40;

export function monthStartUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** spend recorded on this builder agent since `since`: the model cost on its
 * messages plus the measured cost of the governed tool calls its turns made */
export async function builderAgentSpend(db: Db, agentId: string, since: Date): Promise<number> {
  const [[m], [t]] = await Promise.all([
    db
      .select({ total: sql<number>`coalesce(sum(${builderMessages.costUsd}), 0)::float8` })
      .from(builderMessages)
      .where(and(eq(builderMessages.agentId, agentId), gte(builderMessages.createdAt, since))),
    db
      .select({ total: sql<number>`coalesce(sum(${builderToolSteps.costUsd}), 0)::float8` })
      .from(builderToolSteps)
      .where(and(eq(builderToolSteps.agentId, agentId), gte(builderToolSteps.createdAt, since))),
  ]);
  return Number(m?.total ?? 0) + Number(t?.total ?? 0);
}

/** a tool step as the API shows it — the redacted argument preview, never the
 * raw payload; the result preview is null when it was withheld */
export function stepView(s: BuilderToolStepRow) {
  return {
    id: s.id,
    messageId: s.messageId,
    turn: s.turn,
    seq: s.seq,
    kind: s.kind,
    refId: s.refId,
    name: s.name,
    displayName: s.displayName,
    provider: s.provider,
    arguments: s.arguments ?? null,
    argumentsDigest: s.argumentsDigest,
    requiresConfirmation: s.requiresConfirmation,
    status: s.status,
    approvalId: s.approvalId,
    resultPreview: s.resultWithheld ? null : s.resultPreview,
    resultWithheld: s.resultWithheld,
    outcomeCode: s.outcomeCode,
    outcomeDetail: s.outcomeDetail,
    costUsd: s.costUsd,
    latencyMs: s.latencyMs,
    auditLogId: s.auditLogId,
    traceId: s.traceId,
    createdAt: s.createdAt.toISOString(),
    finishedAt: s.finishedAt ? s.finishedAt.toISOString() : null,
  };
}
export type BuilderStepView = ReturnType<typeof stepView>;

export function messageView(m: BuilderMessageRow, steps: BuilderToolStepRow[] = []) {
  return {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model,
    costUsd: m.costUsd,
    latencyMs: m.latencyMs,
    createdAt: m.createdAt.toISOString(),
    steps: steps.filter((s) => s.messageId === m.id).sort((a, b) => a.seq - b.seq).map(stepView),
  };
}

/** every tool step of a thread (for the detail and chat responses) */
export async function threadSteps(db: Db, threadId: string): Promise<BuilderToolStepRow[]> {
  return db.select().from(builderToolSteps).where(eq(builderToolSteps.threadId, threadId)).orderBy(asc(builderToolSteps.createdAt));
}

/**
 * The skills an agent carries AT RUN TIME: the body PINNED when it was attached
 * (so an edit by the skill's owner never silently changes this agent), and only
 * skills the agent's OWNER can still see — a shared skill its author has since
 * made private, or archived, drops out instead of travelling on in a snapshot.
 */
export async function pinnedSkillsForRun(
  db: Db,
  agent: BuilderAgentRow,
): Promise<Array<{ skillId: string; name: string; body: string }>> {
  const [rows, [owner]] = await Promise.all([
    db
      .select({ skill: builderSkills, body: builderAgentSkills.bodySnapshot })
      .from(builderAgentSkills)
      .innerJoin(builderSkills, eq(builderAgentSkills.skillId, builderSkills.id))
      .where(eq(builderAgentSkills.agentId, agent.id))
      .orderBy(asc(builderSkills.name)),
    db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, agent.ownerUserId)),
  ]);
  const ownerViewer = { userId: agent.ownerUserId, isAdmin: !!owner?.isAdmin };
  return rows.filter((r) => skillVisible(r.skill, ownerViewer)).map((r) => ({ skillId: r.skill.id, name: r.skill.name, body: r.body }));
}

/** the configured part of the system prompt — instructions + pinned skills */
export function configuredPrompt(agent: Pick<BuilderAgentRow, "instructions" | "name" | "description">, skills: Array<{ name: string; body: string }>): string {
  const parts: string[] = [agent.instructions.trim() || `You are ${agent.name}. ${agent.description}`.trim()];
  for (const sk of skills) parts.push(`## Skill: ${sk.name}\n\n${sk.body.trim()}`);
  return parts.join("\n\n");
}

/** null when the configured prompt fits BUILDER_LIMITS.systemPromptBytes, else
 * the named 422 body the attach / save routes return */
export function promptTooLarge(prompt: string): { error: string; detail: string; bytes: number; limitBytes: number } | null {
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes <= BUILDER_LIMITS.systemPromptBytes) return null;
  return {
    error: "system_prompt_too_large",
    detail:
      `the agent's instructions and skills come to ${Math.ceil(bytes / 1024)} KB; the limit is ` +
      `${BUILDER_LIMITS.systemPromptBytes / 1024} KB — shorten the instructions or remove a skill`,
    bytes,
    limitBytes: BUILDER_LIMITS.systemPromptBytes,
  };
}

/** the system prompt: instructions + pinned skills + memory + the toolbox as
 * the person may use it (callable tools named, unavailable ones flagged) */
export async function buildSystemPrompt(db: Db, agent: BuilderAgentRow, userId: string, box?: Toolbox): Promise<string> {
  const [skills, memory, toolbox] = await Promise.all([
    pinnedSkillsForRun(db, agent),
    db
      .select({ content: builderAgentMemory.content })
      .from(builderAgentMemory)
      .where(eq(builderAgentMemory.agentId, agent.id))
      .orderBy(desc(builderAgentMemory.createdAt))
      .limit(20),
    box ? Promise.resolve(box) : resolveToolbox(db, agent, userId),
  ]);
  const parts: string[] = [configuredPrompt(agent, skills)];
  if (memory.length) parts.push(`## Memory (newest first)\n${memory.map((m) => `- ${m.content}`).join("\n")}`);
  const tools = toolboxPrompt(toolbox);
  if (tools) parts.push(tools);
  return parts.join("\n\n");
}

/** a turn that stopped on a tool step and is waiting for someone */
export interface TurnPending {
  stepId: string;
  status: "pending_confirmation" | "pending_approval";
  toolName: string;
  displayName: string;
  approvalId: string | null;
  /** pending_approval: who the approvals queue is waiting on */
  approverName: string | null;
}

export type TurnOutcome =
  | {
      ok: true;
      thread: BuilderThreadRow;
      /** this turn's messages (the person's, the agent's, any system note) */
      messages: BuilderMessageRow[];
      /** the tool steps attached to those messages */
      steps?: BuilderToolStepRow[];
      /** set when the turn is paused on a tool step */
      pending?: TurnPending;
      /** a RESUMED segment: only the agent text it added (the agent message
       * holds the whole turn, including what was said before the pause) */
      resumedText?: string;
    }
  | { ok: false; status: number; error: string; detail?: string; threadId?: string };

export interface TurnArgs {
  agent: BuilderAgentRow;
  /** the human the dispatch runs as */
  userId: string;
  /** whether that human is an admin (project attribution re-check) */
  isAdmin?: boolean | undefined;
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

// ---------------------------------------------------------------------------
// the monthly-limit lease
// ---------------------------------------------------------------------------

/** a lease outlives any sane model call, and expires so a crashed holder
 * never wedges the agent; a tool loop RENEWS it after every step */
const LIMIT_LEASE_TTL_SECONDS = 600;
/** how long a turn waits for another in-flight turn of the same limited agent */
const LIMIT_LEASE_WAIT_MS = 120_000;

/**
 * Take the per-agent lease that serialises check -> dispatch -> record for an
 * agent WITH a monthly limit, so two concurrent turns (two people, a chat and
 * a sweep) cannot both read "under the limit" and both spend. A compare-and-
 * swap on the agent row, retried while another turn holds it — it holds NO
 * database connection while waiting (an advisory lock held across the model
 * call would pin a pool connection per waiter, and enough waiters would starve
 * the holder of the connections its own dispatch needs). null = timed out.
 */
export async function acquireLimitLease(db: Db, agentId: string, waitMs = LIMIT_LEASE_WAIT_MS): Promise<string | null> {
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const got = await db
      .update(builderAgents)
      .set({ limitLeaseToken: token, limitLeaseUntil: sql`now() + make_interval(secs => ${LIMIT_LEASE_TTL_SECONDS})` })
      .where(
        and(
          eq(builderAgents.id, agentId),
          or(isNull(builderAgents.limitLeaseUntil), lt(builderAgents.limitLeaseUntil, sql`now()`)),
        ),
      )
      .returning({ id: builderAgents.id });
    if (got.length) return token;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50)));
  }
}

export async function releaseLimitLease(db: Db, agentId: string, token: string): Promise<void> {
  await db
    .update(builderAgents)
    .set({ limitLeaseToken: null, limitLeaseUntil: null })
    .where(and(eq(builderAgents.id, agentId), eq(builderAgents.limitLeaseToken, token)));
}

/** push a held lease's expiry out again (a long tool loop must not outlive it) */
async function renewLimitLease(db: Db, agentId: string, token: string): Promise<void> {
  await db
    .update(builderAgents)
    .set({ limitLeaseUntil: sql`now() + make_interval(secs => ${LIMIT_LEASE_TTL_SECONDS})` })
    .where(and(eq(builderAgents.id, agentId), eq(builderAgents.limitLeaseToken, token)));
}

/** every binding a dispatch of `model` could be served by (it and its
 * fallback chain) carries a list price, so a limited agent's spend is real */
async function unpricedBindings(db: Db, model: { id: string; name: string; costPerMTokIn: number | null; costPerMTokOut: number | null }): Promise<string[]> {
  const chain = await db
    .select({ id: agentFallbacks.fallbackAgentId })
    .from(agentFallbacks)
    .where(eq(agentFallbacks.agentId, model.id));
  const others = chain.length
    ? await db
        .select({ id: agents.id, name: agents.name, costPerMTokIn: agents.costPerMTokIn, costPerMTokOut: agents.costPerMTokOut })
        .from(agents)
        .where(inArray(agents.id, chain.map((c) => c.id)))
    : [];
  return [model, ...others].filter((m) => m.costPerMTokIn == null || m.costPerMTokOut == null).map((m) => m.name);
}

type ModelRow = typeof agents.$inferSelect;
type Refusal = Extract<TurnOutcome, { ok: false }>;

/** the limit as it stands NOW, or null when the agent is under it */
async function limitRefusal(db: Db, agent: BuilderAgentRow, userId: string, source: string, extra: Record<string, unknown> = {}) {
  const [fresh] = await db
    .select({ monthlyLimitUsd: builderAgents.monthlyLimitUsd })
    .from(builderAgents)
    .where(eq(builderAgents.id, agent.id));
  const limit = fresh?.monthlyLimitUsd ?? null;
  if (limit == null) return null;
  const spent = await builderAgentSpend(db, agent.id, monthStartUtc());
  if (spent < limit) return null;
  const detail =
    `builder agent '${agent.name}' has spent $${spent.toFixed(4)} of its $${limit.toFixed(2)} ` +
    `monthly limit; the owner can raise the limit or wait for next month`;
  await audit(db, userId, agent.id, "builder-agent-spend-limit-reached", detail, {
    spentUsd: spent,
    limitUsd: limit,
    source,
    ...extra,
  }, "deny");
  return { ok: false as const, status: 402, error: "agent_spend_limit_reached", detail };
}

/**
 * The agent-level gate every turn and every resume passes: the project
 * re-check, the priced-model rule and the lease for a limited agent, and the
 * limit itself under the lease. `body` runs with the lease token (null for an
 * unlimited agent) and the lease is always released.
 */
async function withAgentGate(
  db: Db,
  agent: BuilderAgentRow,
  userId: string,
  isAdmin: boolean,
  source: string,
  body: (model: ModelRow, lease: string | null) => Promise<TurnOutcome>,
): Promise<TurnOutcome> {
  // owner rule (2026-10-04): every builder agent bills to a project. A legacy
  // agent created before the rule is refused before anything is dispatched.
  if (!agent.projectId) {
    return { ok: false, status: 409, error: "builder_agent_needs_project", detail: "choose a project in Configure → Advanced" };
  }
  if (!agent.modelAgentId) {
    return { ok: false, status: 409, error: "builder_agent_has_no_model", detail: "choose a model for this agent first" };
  }
  const [model] = await db.select().from(agents).where(eq(agents.id, agent.modelAgentId));
  if (!model) return { ok: false, status: 409, error: "builder_agent_has_no_model", detail: "the agent's model no longer exists" };

  // pillar 5: the agent's project, re-checked for the person it runs as
  if (agent.projectId) {
    const attr = await assertProjectAttribution(db, agent.projectId, userId, isAdmin);
    if (!attr.ok) {
      return {
        ok: false,
        status: attr.status === 400 ? 409 : attr.status,
        error: attr.error === "invalid_reference" ? "builder_agent_project_missing" : attr.error,
        detail:
          attr.error === "invalid_reference"
            ? "this agent's project no longer exists; choose another in Configure → Advanced"
            : "this agent bills its spend to a project you are not a member of",
      };
    }
  }

  if (agent.monthlyLimitUsd == null) return body(model, null);

  // A LIMITED agent: its spend must be measurable, and its turns serialised.
  const unpriced = await unpricedBindings(db, model);
  if (unpriced.length) {
    const detail =
      `builder agent '${agent.name}' has a monthly limit, but ${unpriced.map((n) => `'${n}'`).join(", ")} ` +
      `has no list price, so its spend cannot be counted against the limit; choose a priced model or remove the limit`;
    await audit(db, userId, agent.id, "builder-agent-limit-needs-priced-model", detail, { unpriced, source }, "deny");
    return { ok: false, status: 409, error: "agent_limit_needs_priced_model", detail };
  }
  const lease = await acquireLimitLease(db, agent.id);
  if (!lease) {
    return {
      ok: false,
      status: 409,
      error: "agent_limit_busy",
      detail: "another conversation with this agent is still being answered; try again in a moment",
    };
  }
  try {
    // the limit as it stands NOW (it may have changed while this turn waited)
    const refused = await limitRefusal(db, agent, userId, source);
    if (refused) return refused;
    return await body(model, lease);
  } finally {
    await releaseLimitLease(db, agent.id, lease);
  }
}

export async function runBuilderTurn(db: Db, dataKey: string | undefined, args: TurnArgs): Promise<TurnOutcome> {
  const { agent, userId } = args;

  // the thread first (so an unknown/foreign thread is refused before anything)
  if (args.threadId) {
    const [t] = await db.select().from(builderThreads).where(eq(builderThreads.id, args.threadId));
    if (!t || t.agentId !== agent.id) return { ok: false, status: 404, error: "unknown_thread" };
    if (t.userId !== userId) return { ok: false, status: 403, error: "not_your_thread" };
    // a pause on an approval that lapsed ends here rather than blocking the thread
    if (t.pendingTurnCiphertext && (await settleLapsedApprovalPause(db, t))) t.pendingTurnCiphertext = null;
    if (t.pendingTurnCiphertext) {
      return {
        ok: false,
        status: 409,
        error: "thread_waiting_on_tool_step",
        detail: "this conversation is waiting on a tool call; confirm or deny it, wait for its approver, or cancel it first",
        threadId: t.id,
      };
    }
  }
  return withAgentGate(db, agent, userId, !!args.isAdmin, args.source, (model, lease) =>
    turnBody(db, dataKey, args, model, lease),
  );
}

// ---------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------

interface QueuedCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** WHICH tool the model named, pinned when it asked (kind + id), so a
   * resume never runs a different tool that has since taken the same name.
   * null = the name matched nothing in the toolbox the model was offered. */
  target?: { kind: ToolEntry["kind"]; refId: string } | null;
  /** the step row already written for this call (a paused call) */
  stepId?: string;
  /** the governed call was already counted against the per-turn cap */
  counted?: boolean;
  /** how a pause on this call was answered */
  resolution?:
    | { kind: "confirmed" }
    | { kind: "declined" }
    | { kind: "approved" }
    | { kind: "approval_denied"; approverName: string; reason: string | null };
}

/** a turn's loop state — what a pause persists (encrypted) and a resume reloads */
interface LoopState {
  v: 1;
  /** the model conversation of this turn, replayed history included */
  messages: ModelChatMessage[];
  /** tool_result blocks already produced for the newest assistant tool_use turn */
  results: ModelContentBlock[];
  /** tool calls of the newest assistant turn not yet answered (a paused one first) */
  queue: QueuedCall[];
  modelSteps: number;
  toolCalls: number;
  texts: string[];
  userMessageId: string;
  agentMessageId: string | null;
  modelCostUsd: number | null;
  latencyMs: number;
  stepSeq: number;
}

interface Segment {
  db: Db;
  dataKey: string | undefined;
  agent: BuilderAgentRow;
  userId: string;
  isAdmin: boolean;
  source: TurnArgs["source"];
  virtualKey: VirtualKeyContext | null;
  model: ModelRow;
  thread: BuilderThreadRow;
  lease: string | null;
  maxSteps: number;
  trace: TraceContext | null;
  baseDetail: Record<string, unknown>;
  piiMode: Awaited<ReturnType<typeof projectPiiMode>>;
  piiIntl: Awaited<ReturnType<typeof piiInternationalCategories>>;
  /** whether this segment resumed a paused turn (the thread goes back to active) */
  resumed: boolean;
  /** how many of the turn's texts were written before this segment (a resumed
   * segment reports only what it added) */
  textStart: number;
  /** every message row this segment wrote or touched, for the response */
  touched: Set<string>;
  /** the newest model step's span — the tool calls it asked for hang from it */
  stepSpanId: string | null;
  /** the newest step's entitlement decision (the dispatch row repeats it) */
  decision: { effect: string; ruleId: string; ruleChain: unknown; reason: string } | null;
}

/** the model turn history a new turn replays: text only (system notes and
 * empty interim replies left out), consecutive same-role turns merged */
function historyMessages(rows: BuilderMessageRow[]): ModelChatMessage[] {
  const out: ModelChatMessage[] = [];
  for (const m of rows) {
    if (m.role === "system" || !m.content.trim()) continue;
    const role = m.role === "agent" ? ("assistant" as const) : ("user" as const);
    const prev = out[out.length - 1];
    if (prev && prev.role === role && typeof prev.content === "string") prev.content = `${prev.content}\n\n${m.content}`;
    else out.push({ role, content: m.content });
  }
  // a replay must open with the person, never with a stray agent reply
  while (out[0]?.role === "assistant") out.shift();
  return out;
}

async function maxStepsFor(db: Db): Promise<number> {
  const org = await loadOrgSettings(db);
  return Math.min(Math.max(org.defaultWorkerMaxTurns, 1), org.maxWorkerTurns);
}

async function openSegment(
  db: Db,
  dataKey: string | undefined,
  base: Omit<Segment, "db" | "dataKey" | "maxSteps" | "trace" | "baseDetail" | "piiMode" | "piiIntl" | "touched" | "stepSpanId" | "decision" | "textStart">,
): Promise<Segment> {
  const [maxSteps, piiMode, piiIntl] = await Promise.all([
    maxStepsFor(db),
    projectPiiMode(db, base.agent.projectId ?? null),
    piiInternationalCategories(db),
  ]);
  const trace = await beginTrace(db, {
    kind: "conversation",
    name: `builder: ${base.agent.name}`,
    userId: base.userId,
    projectId: base.agent.projectId ?? null,
    sessionId: `builder:${base.thread.id}`,
    rootRefId: base.thread.id,
  });
  return {
    ...base,
    db,
    dataKey,
    maxSteps,
    trace,
    piiMode,
    piiIntl,
    touched: new Set(),
    stepSpanId: null,
    decision: null,
    textStart: 0,
    baseDetail: {
      surface: "builder",
      builderAgentId: base.agent.id,
      builderAgentName: base.agent.name,
      source: base.source,
      builderThreadId: base.thread.id,
    },
  };
}

/** the turn after the agent gate: thread, the person's message, the loop */
async function turnBody(
  db: Db,
  dataKey: string | undefined,
  args: TurnArgs,
  model: ModelRow,
  lease: string | null,
): Promise<TurnOutcome> {
  const { agent, userId, message } = args;
  let thread: BuilderThreadRow;
  if (args.threadId) {
    const [t] = await db.select().from(builderThreads).where(eq(builderThreads.id, args.threadId));
    thread = t!;
  } else {
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
  }

  const history = await db
    .select()
    .from(builderMessages)
    .where(eq(builderMessages.threadId, thread.id))
    .orderBy(desc(builderMessages.createdAt))
    .limit(HISTORY_LIMIT);
  const messages = historyMessages(history.reverse());
  messages.push({ role: "user", content: message });
  const [userMsg] = await db
    .insert(builderMessages)
    .values({ threadId: thread.id, agentId: agent.id, userId, role: "user", content: message })
    .returning();

  const seg = await openSegment(db, dataKey, {
    agent,
    userId,
    isAdmin: !!args.isAdmin,
    source: args.source,
    virtualKey: args.virtualKey ?? null,
    model,
    thread,
    lease,
    resumed: false,
  });
  seg.touched.add(userMsg!.id);
  const state: LoopState = {
    v: 1,
    messages,
    results: [],
    queue: [],
    modelSteps: 0,
    toolCalls: 0,
    texts: [],
    userMessageId: userMsg!.id,
    agentMessageId: null,
    modelCostUsd: null,
    latencyMs: 0,
    stepSeq: 0,
  };
  return runLoop(seg, state);
}

/** a system note in the thread (never replayed to a model) */
async function systemNote(seg: Segment, content: string, status: "needs_attention" | null = "needs_attention") {
  const [row] = await seg.db
    .insert(builderMessages)
    .values({ threadId: seg.thread.id, agentId: seg.agent.id, userId: seg.userId, role: "system", content })
    .returning({ id: builderMessages.id });
  seg.touched.add(row!.id);
  await seg.db
    .update(builderThreads)
    .set({ updatedAt: new Date(), ...(status ? { status } : {}) })
    .where(eq(builderThreads.id, seg.thread.id));
}

/** end a segment with a refusal: a system note, the paused state cleared, the
 * trace closed. Everything already spent this turn stays recorded. */
async function stopWithRefusal(seg: Segment, state: LoopState, refusal: Refusal, traceStatus: "denied" | "error" = "denied"): Promise<TurnOutcome> {
  await writeAgentMessage(seg, state);
  await systemNote(seg, `Refused (${refusal.error})${refusal.detail ? `: ${refusal.detail}` : ""}`);
  await seg.db.update(builderThreads).set({ pendingTurnCiphertext: null }).where(eq(builderThreads.id, seg.thread.id));
  await finishTrace(seg.db, seg.trace, traceStatus);
  return { ...refusal, threadId: seg.thread.id };
}

/** the agent message's text and cost as the turn stands */
async function writeAgentMessage(seg: Segment, state: LoopState) {
  if (!state.agentMessageId) return;
  await seg.db
    .update(builderMessages)
    .set({ content: state.texts.join("\n\n"), costUsd: state.modelCostUsd, latencyMs: state.latencyMs })
    .where(eq(builderMessages.id, state.agentMessageId));
}

/**
 * BEFORE EVERY STEP: the person's entitlement to the model binding (a FRESH
 * read of it, so a per-agent halt applied mid-loop counts) through the
 * copilot's `agentDecision` — the kill switch, a revoked grant, a lifecycle
 * change — and the agent's monthly limit. A denial is audited and traced like
 * the compat path's.
 */
async function stepGate(seg: Segment, state: LoopState, phase: "step" | "tool"): Promise<Refusal | null> {
  const { db, userId } = seg;
  if (phase === "step") {
    const [fresh] = await db.select().from(agents).where(eq(agents.id, seg.model.id));
    const model = (fresh ?? seg.model) as AgentRow;
    const decision = await agentDecision(db, userId, model, BUILDER_MODEL_FEATURE);
    if (decision.effect !== "allow") {
      const [row] = await db
        .insert(auditLog)
        .values({
          userId,
          objectType: "agent",
          objectId: model.id,
          detail: { ...seg.baseDetail, mode: "chat", step: state.modelSteps + 1 },
          effect: decision.effect,
          ruleId: decision.ruleId,
          ruleChain: decision.ruleChain,
          reason: decision.reason,
        })
        .returning({ id: auditLog.id });
      const at = new Date();
      await recordSpan(db, seg.trace, {
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
        attributes: { ...seg.baseDetail, ruleId: decision.ruleId, effect: decision.effect, step: state.modelSteps + 1 },
      });
      const error = decision.ruleId === MODEL_NOT_ALLOWED_FOR_FEATURE ? MODEL_NOT_ALLOWED_FOR_FEATURE : "agent_denied";
      return { ok: false, status: 403, error, detail: decision.reason };
    }
    seg.decision = { effect: decision.effect, ruleId: decision.ruleId, ruleChain: decision.ruleChain, reason: decision.reason };
  }
  return limitRefusal(db, seg.agent, userId, seg.source, {
    builderThreadId: seg.thread.id,
    step: state.modelSteps,
    toolCalls: state.toolCalls,
    phase,
  });
}

async function runLoop(seg: Segment, state: LoopState): Promise<TurnOutcome> {
  const { db } = seg;
  let box: Toolbox | null = null;
  for (;;) {
    // 1. answer every queued tool call of the newest assistant turn
    if (state.queue.length) {
      box ??= await resolveToolbox(db, seg.agent, seg.userId);
      const q = await runQueue(seg, state, box);
      if (q) return q; // paused, or stopped
      state.messages.push({ role: "user", content: state.results });
      state.results = [];
    }

    // 2. the step bound (org worker-turn settings)
    if (state.modelSteps >= seg.maxSteps) {
      return finishTurn(
        seg,
        state,
        "ok",
        `Stopped after ${state.modelSteps} step${state.modelSteps === 1 ? "" : "s"} — the organisation's limit for one turn. ` +
          `Send a follow-up to continue.`,
      );
    }

    // 3. the per-step re-checks: entitlement (kill switch) and the monthly limit
    const gate = await stepGate(seg, state, "step");
    if (gate) return stopWithRefusal(seg, state, gate);

    // 4. one governed model step, with the toolbox as the person may use it
    box = await resolveToolbox(db, seg.agent, seg.userId);
    const system = await buildSystemPrompt(db, seg.agent, seg.userId, box);
    const toolsOff = state.toolCalls >= BUILDER_LIMITS.toolCallsPerTurn;
    const defs = box.entries.map((e) => e.def);
    const step = state.modelSteps + 1;
    const started = Date.now();
    const lastUser = [...state.messages].reverse().find((m) => m.role === "user");
    const outcome = await executeGovernedDispatch(db, seg.dataKey, {
      userId: seg.userId,
      served: seg.model as AgentRow,
      requestedAgentId: seg.model.id,
      baseline: null,
      input: typeof lastUser?.content === "string" ? lastUser.content : "",
      messages: state.messages,
      system,
      ...(defs.length ? { tools: defs } : {}),
      ...(defs.length && toolsOff ? { toolChoice: "none" as const } : {}),
      projectId: seg.agent.projectId ?? null,
      modelFeature: BUILDER_MODEL_FEATURE,
      virtualKey: seg.virtualKey,
      mode: "chat",
      trace: seg.trace,
      traceSpanName: `step ${step}: ${seg.model.name}`,
      detail: { ...seg.baseDetail, step },
    });
    const latencyMs = Date.now() - started;

    // the decision row the invoke route writes for every governed call
    await db.insert(auditLog).values({
      userId: seg.userId,
      objectType: "agent",
      objectId: seg.model.id,
      detail: {
        ...seg.baseDetail,
        mode: "chat",
        step,
        dispatch: outcome.ok
          ? { model: outcome.result.model, stopReason: outcome.result.stopReason, refusal: outcome.result.refusal, toolCalls: outcome.result.toolCalls?.length ?? 0 }
          : { error: outcome.error },
      },
      effect: "allow",
      ruleId: seg.decision?.ruleId ?? "builder-step-dispatched",
      ruleChain: (seg.decision?.ruleChain ?? []) as typeof auditLog.$inferInsert.ruleChain,
      reason: seg.decision?.reason ?? `builder agent '${seg.agent.name}' step ${step} dispatched as the person using it`,
    });

    if (!outcome.ok) {
      // the attribution mandate refuses an agent with no project: say where the
      // person fixes it, not only what the core decided
      const detail =
        outcome.error === "attribution_required" && !seg.agent.projectId
          ? `${outcome.detail ? `${outcome.detail} — ` : ""}choose a project for this agent in Configure → Advanced`
          : (outcome.detail ?? undefined);
      return stopWithRefusal(
        seg,
        state,
        { ok: false, status: outcome.status, error: outcome.error, ...(detail ? { detail } : {}) },
        outcome.status >= 500 ? "error" : "denied",
      );
    }

    state.modelSteps = step;
    state.latencyMs += latencyMs;
    const cost = outcome.result.costUsd;
    if (cost != null) state.modelCostUsd = Number(((state.modelCostUsd ?? 0) + cost).toFixed(8));
    if (seg.agent.monthlyLimitUsd != null && cost == null) {
      // unreachable while every binding is priced (checked before the lease);
      // if it ever happens, it is said, never silently counted as zero
      await audit(db, seg.userId, seg.agent.id, "builder-agent-unpriced-spend",
        `builder agent '${seg.agent.name}' has a monthly limit but this reply reported no cost`,
        { builderThreadId: seg.thread.id, servedAgentId: outcome.result.servedAgentId }, "deny");
    }
    if (outcome.result.outputText) state.texts.push(outcome.result.outputText);
    if (!state.agentMessageId) {
      const servedId = outcome.result.servedAgentId;
      const [served] = servedId === seg.model.id ? [seg.model] : await db.select().from(agents).where(eq(agents.id, servedId));
      const [row] = await db
        .insert(builderMessages)
        .values({
          threadId: seg.thread.id,
          agentId: seg.agent.id,
          userId: seg.userId,
          role: "agent",
          content: state.texts.join("\n\n"),
          modelAgentId: servedId,
          provider: served?.provider ?? seg.model.provider,
          model: outcome.result.model,
          costUsd: state.modelCostUsd,
          latencyMs: state.latencyMs,
        })
        .returning({ id: builderMessages.id });
      state.agentMessageId = row!.id;
    } else {
      await writeAgentMessage(seg, state);
    }
    seg.touched.add(state.agentMessageId);
    if (seg.lease) await renewLimitLease(db, seg.agent.id, seg.lease);

    const calls = outcome.result.stopReason === "tool_use" ? (outcome.result.toolCalls ?? []) : [];
    if (!calls.length) return finishTurn(seg, state, "ok");

    const blocks: ModelContentBlock[] = [];
    if (outcome.result.outputText) blocks.push({ type: "text", text: outcome.result.outputText });
    for (const c of calls) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} });
    state.messages.push({ role: "assistant", content: blocks });
    state.queue = calls.map((c) => {
      const named = box!.byName.get(c.name);
      return {
        id: c.id,
        name: c.name,
        arguments: (c.arguments && typeof c.arguments === "object" && !Array.isArray(c.arguments) ? c.arguments : {}) as Record<string, unknown>,
        target: named ? { kind: named.kind, refId: named.refId } : null,
      };
    });
    // the tool calls hang from this step's span
    seg.stepSpanId = outcome.trace?.spanId ?? null;
  }
}

/**
 * Answer the queued tool calls in order. Returns null when every call has a
 * tool_result (the loop dispatches again), or the outcome when the turn paused
 * or stopped.
 */
async function runQueue(seg: Segment, state: LoopState, box: Toolbox): Promise<TurnOutcome | null> {
  const { db } = seg;
  while (state.queue.length) {
    const call = state.queue[0]!;
    const named = box.byName.get(call.name) ?? null;
    // the name resolves to a tool only while it still names THE tool the model
    // asked for (pinned when it asked): never re-routed to another one
    const target = call.target ?? null;
    const entry = named && target && named.kind === target.kind && named.refId === target.refId ? named : null;

    // a denied pause first: nothing runs, whatever the tool's name names now.
    // The person declined an "Ask first" call...
    if (call.resolution?.kind === "declined") {
      await answer(seg, state, call, entry, {
        status: "denied",
        code: "declined_by_user",
        detail: "the person declined this call",
        modelText: "the person declined this tool call; do not retry it unless they ask you to",
        isError: true,
      });
      continue;
    }
    // ...or an approver denied the organisation approval this call waited on
    if (call.resolution?.kind === "approval_denied") {
      const r = call.resolution;
      const detail = `denied by ${r.approverName}${r.reason ? `: ${r.reason}` : ""}`;
      await answer(seg, state, call, entry, {
        status: "denied",
        code: "approval_denied",
        detail,
        modelText: `this tool call was ${detail}`,
        isError: true,
      });
      continue;
    }

    // a call over the per-turn cap is refused without running
    if (!call.counted && state.toolCalls >= BUILDER_LIMITS.toolCallsPerTurn) {
      await answer(seg, state, call, entry, {
        status: "refused",
        code: "tool_call_limit",
        detail: `this turn has made ${BUILDER_LIMITS.toolCallsPerTurn} tool calls, the most one turn may make`,
        modelText: `refused: the limit of ${BUILDER_LIMITS.toolCallsPerTurn} tool calls for this turn is reached; answer with what you have`,
        isError: true,
      });
      continue;
    }
    // the tool the model asked for (and the person may have confirmed) is not
    // the one that name resolves to now, or is gone: refused, nothing runs
    if (!entry && target) {
      const changed = !!named;
      const detail = changed
        ? `'${call.name}' now names a different tool than the one asked for, so nothing was run`
        : `the tool asked for as '${call.name}' is no longer in this agent's toolbox for you, so nothing was run`;
      await answer(seg, state, call, null, {
        status: "refused",
        code: changed ? "tool_changed_since_requested" : "tool_no_longer_available",
        detail,
        modelText: `refused: ${detail}`,
        isError: true,
      });
      continue;
    }
    // a tool not in the toolbox AS THIS PERSON MAY USE IT is never called
    if (!entry) {
      await answer(seg, state, call, null, {
        status: "refused",
        code: "tool_not_available",
        detail: `'${call.name}' is not in this agent's toolbox for you`,
        modelText: `refused: the tool '${call.name}' is not available to this person`,
        isError: true,
      });
      continue;
    }

    // the monthly limit before a call that may cost money
    const gate = await stepGate(seg, state, "tool");
    if (gate) {
      if (call.stepId) {
        await db
          .update(builderToolSteps)
          .set({ status: "refused", outcomeCode: gate.error, outcomeDetail: gate.detail ?? null, updatedAt: new Date(), finishedAt: new Date() })
          .where(eq(builderToolSteps.id, call.stepId));
      }
      return stopWithRefusal(seg, state, gate);
    }

    // the agent's own "Ask first": pause for the person, exact arguments shown
    if (entry.requiresApproval && !call.resolution) {
      const paused = await pause(seg, state, call, entry, "pending_confirmation", null);
      if (paused) return paused;
      continue;
    }

    // run it, governed, as the person
    const stepId = call.stepId ?? (await newStep(seg, state, call, entry, "running")).id;
    call.stepId = stepId;
    if (!call.counted) {
      state.toolCalls++;
      call.counted = true;
    }
    const started = Date.now();
    const run = await runGovernedTool(db, seg.dataKey, entry, call.arguments, {
      userId: seg.userId,
      isAdmin: seg.isAdmin,
      projectId: seg.agent.projectId ?? null,
      trace: childContext(seg.trace, seg.stepSpanId),
      toolCallId: call.id,
      detail: { ...seg.baseDetail, builderStepId: stepId },
    });
    const latencyMs = Date.now() - started;
    if (run.approvalId) {
      if (call.resolution?.kind === "approved") {
        // RESUMED after the approval was granted, and the identical call still
        // wants an approval: the consent did not bind to this call (its
        // arguments, its policy context or its expiry moved). Refused — never
        // run, never silently re-queued in a loop.
        await answer(seg, state, call, entry, {
          ...run,
          status: "refused",
          code: "approval_binding_mismatch",
          detail: `the approval no longer matches this call (${run.code}: ${run.detail})`,
          modelText: "refused: the approval granted for this call no longer matches it, so the call was not made",
          latencyMs,
        });
        continue;
      }
      const paused = await pause(seg, state, call, entry, "pending_approval", run.approvalId, { latencyMs, code: run.code, detail: run.detail });
      if (paused) return paused;
      continue;
    }
    await answer(seg, state, call, entry, { ...run, latencyMs });
  }
  return null;
}

/** write (or reuse) the step row for a call */
async function newStep(
  seg: Segment,
  state: LoopState,
  call: QueuedCall,
  entry: ToolEntry | null,
  status: BuilderToolStepRow["status"],
): Promise<BuilderToolStepRow> {
  const projectId = seg.agent.projectId ?? null;
  const [row] = await seg.db
    .insert(builderToolSteps)
    .values({
      threadId: seg.thread.id,
      messageId: state.agentMessageId!,
      agentId: seg.agent.id,
      userId: seg.userId,
      turn: state.modelSteps,
      seq: ++state.stepSeq,
      kind: entry?.kind ?? "unknown",
      refId: entry?.refId ?? null,
      name: call.name.slice(0, 200),
      displayName: (entry?.displayName ?? call.name).slice(0, 300),
      provider: entry?.provider ?? null,
      toolCallId: call.id.slice(0, 200),
      arguments: redactedArguments(call.arguments, seg.piiMode, seg.piiIntl) as Record<string, unknown>,
      argumentsDigest: argumentsDigestFor(projectId, call.arguments),
      requiresConfirmation: !!entry?.requiresApproval,
      status,
      traceId: seg.trace?.traceId ?? null,
      parentSpanId: seg.stepSpanId,
    })
    .returning();
  return row!;
}

/** record a call's outcome on its step and queue its tool_result */
async function answer(
  seg: Segment,
  state: LoopState,
  call: QueuedCall,
  entry: ToolEntry | null,
  run: Partial<ToolRun> & Pick<ToolRun, "status" | "code" | "detail" | "modelText" | "isError"> & { latencyMs?: number },
) {
  const stepId = call.stepId ?? (await newStep(seg, state, call, entry, run.status)).id;
  // the governed call's own decision row carries the step id (narrowed by the
  // person and the step's lifetime so the lookup stays on indexed columns)
  const [stepRow] = await seg.db.select({ createdAt: builderToolSteps.createdAt }).from(builderToolSteps).where(eq(builderToolSteps.id, stepId));
  const [auditRow] = await seg.db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.userId, seg.userId),
        gte(auditLog.at, new Date((stepRow?.createdAt ?? new Date()).getTime() - 1000)),
        sql`${auditLog.detail}->>'builderStepId' = ${stepId}`,
      ),
    )
    .orderBy(asc(auditLog.at))
    .limit(1);
  const now = new Date();
  await seg.db
    .update(builderToolSteps)
    .set({
      status: run.status,
      outcomeCode: run.code,
      outcomeDetail: run.detail ? run.detail.slice(0, 1000) : null,
      resultPreview: run.withheld ? null : (run.preview ?? null),
      resultWithheld: !!run.withheld,
      ...(run.argumentsRefused ? { arguments: null } : {}),
      costUsd: run.costUsd ?? null,
      ...(run.latencyMs !== undefined ? { latencyMs: run.latencyMs } : {}),
      auditLogId: auditRow?.id ?? null,
      updatedAt: now,
      finishedAt: now,
    })
    .where(eq(builderToolSteps.id, stepId));
  state.results.push({ type: "tool_result", toolUseId: call.id, content: run.modelText, ...(run.isError ? { isError: true } : {}) });
  state.queue.shift();
}

/**
 * Stop the turn on a tool step until someone answers it. The loop state —
 * including the RAW arguments the resume must replay identically — is stored
 * encrypted on the thread; without a data key it cannot be kept safely, so the
 * call is refused instead of paused.
 */
async function pause(
  seg: Segment,
  state: LoopState,
  call: QueuedCall,
  entry: ToolEntry,
  status: "pending_confirmation" | "pending_approval",
  approvalId: string | null,
  extra: { latencyMs?: number; code?: string | null; detail?: string | null } = {},
): Promise<TurnOutcome | null> {
  const { db } = seg;
  if (!seg.dataKey) {
    await answer(seg, state, call, entry, {
      status: "refused",
      code: "cannot_pause_without_data_key",
      detail: "this gateway has no data key, so a paused call cannot be kept safely",
      modelText: "refused: this call needs a confirmation or an approval, which this deployment cannot hold",
      isError: true,
    });
    return null;
  }
  // a NEW step is born `running`: it becomes pending only together with the
  // paused state below, never before it
  const stepRow = call.stepId
    ? (await db.select().from(builderToolSteps).where(eq(builderToolSteps.id, call.stepId)))[0]!
    : await newStep(seg, state, call, entry, "running");
  call.stepId = stepRow.id;
  // the resolution of an earlier pause on this call is spent
  delete call.resolution;
  await writeAgentMessage(seg, state);
  // ATOMIC: the paused state and the pending step commit together, the state
  // first. Whoever can see the step waiting (the approvals decide hook, the
  // confirm route, a cancel) can therefore always restore the turn it belongs
  // to — a hook firing between two separate writes would have read a pending
  // step with no paused turn and abandoned it.
  const ciphertext = encryptSecret(seg.dataKey, JSON.stringify(state));
  const thread = await db.transaction(async (tx) => {
    const [t] = await tx
      .update(builderThreads)
      .set({ pendingTurnCiphertext: ciphertext, status: "needs_attention", updatedAt: new Date() })
      .where(eq(builderThreads.id, seg.thread.id))
      .returning();
    await tx
      .update(builderToolSteps)
      .set({
        status,
        approvalId,
        outcomeCode: extra.code ?? null,
        outcomeDetail: extra.detail ?? null,
        ...(extra.latencyMs !== undefined ? { latencyMs: extra.latencyMs } : {}),
        updatedAt: new Date(),
      })
      .where(eq(builderToolSteps.id, stepRow.id));
    return t;
  });
  seg.thread = thread ?? seg.thread;
  if (approvalId) {
    // The approvals queue may have decided this approval in the moment between
    // the governed path queueing it and the step above being written — the
    // decide hook would then have found no waiting step. Re-read it now that
    // the pause is durable: if it is already decided and the step is still
    // ours to claim, carry the decision on inline instead of waiting forever.
    const [ap] = await db
      .select({ status: approvals.status, decidedBy: approvals.decidedBy, reason: approvals.decisionReason })
      .from(approvals)
      .where(eq(approvals.id, approvalId));
    if (ap && (ap.status === "approved" || ap.status === "denied" || ap.status === "returned")) {
      const claimed = await db
        .update(builderToolSteps)
        .set({ status: "running", decidedByUserId: ap.decidedBy, updatedAt: new Date() })
        .where(and(eq(builderToolSteps.id, stepRow.id), eq(builderToolSteps.status, "pending_approval")))
        .returning({ id: builderToolSteps.id });
      if (claimed.length) {
        await db
          .update(builderThreads)
          .set({ pendingTurnCiphertext: null, status: seg.thread.status === "needs_attention" && seg.source !== "schedule" ? "active" : seg.thread.status })
          .where(eq(builderThreads.id, seg.thread.id));
        let decider = "an approver";
        if (ap.decidedBy) {
          const [d] = await db.select({ name: users.displayName, email: users.email }).from(users).where(eq(users.id, ap.decidedBy));
          decider = d ? d.name || d.email : decider;
        }
        call.resolution =
          ap.status === "approved" ? { kind: "approved" } : { kind: "approval_denied", approverName: decider, reason: ap.reason };
        return null;
      }
    }
  }
  await finishTrace(db, seg.trace, "ok");
  let approverName: string | null = null;
  if (approvalId) approverName = await approverNameFor(db, approvalId);
  const out = await segmentOutcome(seg, state);
  return {
    ...out,
    pending: {
      stepId: stepRow.id,
      status,
      toolName: entry.name,
      displayName: entry.displayName,
      approvalId,
      approverName,
    },
  };
}

async function approverNameFor(db: Db, approvalId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: users.displayName, email: users.email })
    .from(approvals)
    .innerJoin(users, eq(approvals.approverUserId, users.id))
    .where(eq(approvals.id, approvalId));
  return row ? row.name || row.email : null;
}

/** the turn's rows as the response returns them */
async function segmentOutcome(seg: Segment, state: LoopState): Promise<Extract<TurnOutcome, { ok: true }>> {
  const { db } = seg;
  const ids = [...seg.touched];
  const [rows, steps, [thread]] = await Promise.all([
    ids.length ? db.select().from(builderMessages).where(inArray(builderMessages.id, ids)) : Promise.resolve([]),
    ids.length ? db.select().from(builderToolSteps).where(inArray(builderToolSteps.messageId, ids)) : Promise.resolve([]),
    db.select().from(builderThreads).where(eq(builderThreads.id, seg.thread.id)),
  ]);
  return {
    ok: true,
    thread: thread ?? seg.thread,
    messages: rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
    steps: steps.sort((a, b) => a.seq - b.seq),
    ...(seg.resumed ? { resumedText: state.texts.slice(seg.textStart).join("\n\n") } : {}),
  };
}

/** the turn is done: the agent message's final text and cost, the paused state
 * cleared, the thread status (a schedule thread always wants attention; a
 * resumed chat goes back to active) */
async function finishTurn(seg: Segment, state: LoopState, traceStatus: "ok" | "denied" | "error", note?: string): Promise<TurnOutcome> {
  const { db } = seg;
  await writeAgentMessage(seg, state);
  await db
    .update(builderThreads)
    .set({
      pendingTurnCiphertext: null,
      updatedAt: new Date(),
      ...(seg.source === "schedule" ? { status: "needs_attention" as const } : seg.resumed ? { status: "active" as const } : {}),
    })
    .where(eq(builderThreads.id, seg.thread.id));
  // a stopped turn wants the person's attention (after the status above)
  if (note) await systemNote(seg, note);
  await finishTrace(db, seg.trace, traceStatus);
  return segmentOutcome(seg, state);
}

// ---------------------------------------------------------------------------
// resuming a paused turn
// ---------------------------------------------------------------------------

export interface ResumeArgs {
  threadId: string;
  stepId: string;
  /** confirmation: the thread owner answered "Ask first"; approval: the
   * approvals queue decided the organisation approval the step waited on */
  via: "confirmation" | "approval";
  decision: "approve" | "deny";
  deciderUserId: string;
  /** approval denials: what the model is told */
  reason?: string | null;
}

/**
 * Answer a turn paused on `stepId`. Runs as the THREAD'S person, never as the
 * decider.
 *
 *  - DENY ALWAYS GOES THROUGH. It runs nothing, so it needs no agent gate: the
 *    step is claimed (pending_* -> denied) and finished first. Only then does
 *    the agent CONTINUE — told of the denial — and only if the agent gate a new
 *    turn passes allows it; if it does not (the person left the project, the
 *    limit is reached, the model was deleted…), the paused turn is ended with
 *    a note instead of being left waiting.
 *  - APPROVE passes the agent gate (visibility, project, priced model, lease,
 *    limit) and then CLAIMS the step (pending_* -> running), so a double click,
 *    two approvers or a retry resume it once (409 step_not_pending for the
 *    rest). A gate refusal ABANDONS the step and clears the paused turn with a
 *    note: an answered pause never stays pending.
 *  - The call that runs must still be THE tool the step names (kind + id); the
 *    loop refuses it otherwise (runQueue).
 *  - An exception in the resumed run puts the step in `error` and clears the
 *    paused turn (never a thread stuck on a step nobody can answer).
 */
export async function resumeBuilderStep(db: Db, dataKey: string | undefined, args: ResumeArgs): Promise<TurnOutcome> {
  const [thread] = await db.select().from(builderThreads).where(eq(builderThreads.id, args.threadId));
  if (!thread) return { ok: false, status: 404, error: "unknown_thread" };
  const [step] = await db.select().from(builderToolSteps).where(eq(builderToolSteps.id, args.stepId));
  if (!step || step.threadId !== thread.id) return { ok: false, status: 404, error: "unknown_step" };
  const expected = args.via === "confirmation" ? "pending_confirmation" : "pending_approval";
  if (step.status !== expected) {
    return { ok: false, status: 409, error: "step_not_pending", detail: `this step is ${step.status.replace("_", " ")}`, threadId: thread.id };
  }
  let approverName = "an approver";
  if (args.via === "approval") {
    const [d] = await db.select({ name: users.displayName, email: users.email }).from(users).where(eq(users.id, args.deciderUserId));
    approverName = d ? d.name || d.email : approverName;
  }
  const deny = args.decision === "deny";
  const decisionAudit = () =>
    audit(
      db,
      args.deciderUserId,
      thread.agentId,
      args.via === "confirmation" ? "builder-tool-step-confirmed" : "builder-tool-step-approval-decided",
      `tool step '${step.displayName}' ${deny ? "denied" : "approved"} ` +
        `(${args.via === "confirmation" ? "Ask first, by the person in the thread" : `organisation approval, by ${approverName}`}); the turn resumes`,
      { builderThreadId: thread.id, builderStepId: step.id, via: args.via, decision: args.decision, approvalId: step.approvalId },
      deny ? "deny" : "allow",
    );

  if (deny) {
    const code = args.via === "confirmation" ? "declined_by_user" : "approval_denied";
    const detail =
      args.via === "confirmation" ? "the person declined this call" : `denied by ${approverName}${args.reason ? `: ${args.reason}` : ""}`;
    const now = new Date();
    const claimed = await db
      .update(builderToolSteps)
      .set({ status: "denied", outcomeCode: code, outcomeDetail: detail.slice(0, 1000), decidedByUserId: args.deciderUserId, updatedAt: now, finishedAt: now })
      .where(and(eq(builderToolSteps.id, step.id), eq(builderToolSteps.status, expected)))
      .returning({ id: builderToolSteps.id });
    if (!claimed.length) return { ok: false, status: 409, error: "step_not_pending", threadId: thread.id };
    await decisionAudit();
    const gate = await resumeUnderGate(db, dataKey, thread, step, args, approverName, false);
    let out: TurnOutcome = gate;
    if (!gate.ok) {
      // the denial stands; only the agent's continuation was refused
      const [note] = await db
        .insert(builderMessages)
        .values({
          threadId: thread.id,
          agentId: thread.agentId,
          userId: thread.userId,
          role: "system",
          content:
            `'${step.displayName}' was ${args.via === "confirmation" ? "declined" : "denied"} and did not run. ` +
            `The agent could not continue (${gate.error})${gate.detail ? `: ${gate.detail}` : ""}.`,
        })
        .returning();
      const [t] = await db
        .update(builderThreads)
        .set({ pendingTurnCiphertext: null, status: "needs_attention", updatedAt: new Date() })
        .where(eq(builderThreads.id, thread.id))
        .returning();
      const [s] = await db.select().from(builderToolSteps).where(eq(builderToolSteps.id, step.id));
      out = { ok: true, thread: t ?? thread, messages: note ? [note] : [], steps: s ? [s] : [] };
    }
    await notifyResumed(db, thread.id, thread.source, out);
    return out;
  }

  const out = await resumeUnderGate(db, dataKey, thread, step, args, approverName, true, decisionAudit);
  if (!out.ok) {
    // a refusal BEFORE the step was claimed (the agent gate): the pause was
    // answered and will not be answered again, so it ends here, visibly
    await endPausedStep(db, thread, step.id, {
      from: [expected],
      status: "refused",
      code: out.error,
      detail: out.detail ?? "the turn could not resume",
      note: `Stopped (${out.error}): ${out.detail ?? "the turn could not resume"}. '${step.displayName}' did not run.`,
      decidedByUserId: args.deciderUserId,
    });
  }
  if (out.ok || out.status !== 409 || out.error !== "step_not_pending") await notifyResumed(db, thread.id, thread.source, out);
  return out;
}

/** the agent gate, then (approve: claim the step) the restored loop */
async function resumeUnderGate(
  db: Db,
  dataKey: string | undefined,
  thread: BuilderThreadRow,
  step: BuilderToolStepRow,
  args: ResumeArgs,
  approverName: string,
  claim: boolean,
  onClaimed?: () => Promise<void>,
): Promise<TurnOutcome> {
  const expected = args.via === "confirmation" ? "pending_confirmation" : "pending_approval";
  const [agent] = await db.select().from(builderAgents).where(eq(builderAgents.id, thread.agentId));
  const [person] = await db.select({ isAdmin: users.isAdmin, disabledAt: users.disabledAt }).from(users).where(eq(users.id, thread.userId));
  const visible = agent && person && !person.disabledAt ? await loadVisibleAgent(db, agent.id, { userId: thread.userId, isAdmin: person.isAdmin }) : null;
  if (!visible) {
    return { ok: false, status: 409, error: "agent_unavailable", detail: "this agent is no longer available to you", threadId: thread.id };
  }
  return withAgentGate(db, visible, thread.userId, person!.isAdmin, thread.source, async (model, lease) => {
    if (claim) {
      const claimed = await db
        .update(builderToolSteps)
        .set({ status: "running", decidedByUserId: args.deciderUserId, updatedAt: new Date() })
        .where(and(eq(builderToolSteps.id, step.id), eq(builderToolSteps.status, expected)))
        .returning({ id: builderToolSteps.id });
      if (!claimed.length) return { ok: false, status: 409, error: "step_not_pending", threadId: thread.id };
      if (onClaimed) await onClaimed();
    }
    let seg: Segment | null = null;
    try {
      const [fresh] = await db.select().from(builderThreads).where(eq(builderThreads.id, thread.id));
      let state: LoopState | null = null;
      try {
        state = fresh?.pendingTurnCiphertext && dataKey ? (JSON.parse(decryptSecret(dataKey, fresh.pendingTurnCiphertext)) as LoopState) : null;
      } catch {
        state = null;
      }
      const call = state?.queue[0];
      if (!state || state.v !== 1 || !call || call.stepId !== step.id) {
        // (a denied step keeps its denial; only the turn is ended)
        await endPausedStep(db, thread, step.id, {
          from: claim ? ["running"] : null,
          status: "refused",
          code: "paused_turn_unreadable",
          detail: "the paused turn could not be restored (a data-key change, or it was already resumed)",
          note: "Stopped (paused_turn_unreadable): the paused turn could not be restored (a data-key change, or it was already resumed).",
        });
        return { ok: false, status: 409, error: "paused_turn_unreadable", threadId: thread.id };
      }
      // the step row is the record of WHICH tool was asked for: a state saved
      // before calls were pinned takes its pin from there
      if (call.target === undefined) {
        call.target = step.kind !== "unknown" && step.refId ? { kind: step.kind, refId: step.refId } : null;
      }
      call.resolution =
        args.via === "confirmation"
          ? { kind: args.decision === "approve" ? "confirmed" : "declined" }
          : args.decision === "approve"
            ? { kind: "approved" }
            : { kind: "approval_denied", approverName, reason: args.reason ?? null };
      seg = await openSegment(db, dataKey, {
        agent: visible,
        userId: thread.userId,
        isAdmin: person!.isAdmin,
        source: thread.source,
        virtualKey: null,
        model,
        thread: fresh ?? thread,
        lease,
        resumed: true,
      });
      seg.textStart = state.texts.length;
      if (state.agentMessageId) seg.touched.add(state.agentMessageId);
      return await runLoop(seg, state);
    } catch (err) {
      // never a thread stuck on a step nobody can answer: the step (and any
      // call of this turn still marked running) goes to error, the paused
      // state is cleared, the failure is audited
      const msg = err instanceof Error ? err.message : String(err);
      const now = new Date();
      await db
        .update(builderToolSteps)
        .set({ status: "error", outcomeCode: "resume_failed", outcomeDetail: msg.slice(0, 300), updatedAt: now, finishedAt: now })
        .where(and(eq(builderToolSteps.threadId, thread.id), inArray(builderToolSteps.status, ["running", "pending_confirmation", "pending_approval"])));
      await db
        .update(builderThreads)
        .set({ pendingTurnCiphertext: null, status: "needs_attention", updatedAt: now })
        .where(eq(builderThreads.id, thread.id));
      await db.insert(builderMessages).values({
        threadId: thread.id,
        agentId: thread.agentId,
        userId: thread.userId,
        role: "system",
        content: "Stopped (resume_failed): the conversation could not continue after the tool step. Send a message to try again.",
      });
      await audit(db, thread.userId, thread.agentId, "builder-tool-step-resume-failed",
        `the paused turn of thread ${thread.id} failed while resuming: ${msg.slice(0, 300)}`,
        { builderThreadId: thread.id, builderStepId: step.id, via: args.via, decision: args.decision }, "deny");
      if (seg) await finishTrace(db, seg.trace, "error");
      return { ok: false, status: 500, error: "resume_failed", detail: "the conversation could not continue after the tool step", threadId: thread.id };
    }
  });
}

/**
 * End a paused turn on one step: the step moves (only from `from` — a claim,
 * so a concurrent resume or cancel ends it once), the paused state is cleared
 * and a system note says what happened, in ONE transaction. `from: null`
 * leaves the step as it is (a denial already recorded) and ends only the
 * turn. Returns the note when this call ended it, else null.
 */
async function endPausedStep(
  db: Db,
  thread: Pick<BuilderThreadRow, "id" | "agentId" | "userId">,
  stepId: string,
  opts: {
    from: BuilderToolStepRow["status"][] | null;
    status: "refused" | "denied" | "error";
    code: string;
    detail: string;
    note: string;
    decidedByUserId?: string | null;
  },
): Promise<BuilderMessageRow | null> {
  const now = new Date();
  return db.transaction(async (tx) => {
    const moved = opts.from === null ? [{ id: stepId }] : await tx
      .update(builderToolSteps)
      .set({
        status: opts.status,
        outcomeCode: opts.code,
        outcomeDetail: opts.detail.slice(0, 1000),
        ...(opts.decidedByUserId !== undefined ? { decidedByUserId: opts.decidedByUserId } : {}),
        updatedAt: now,
        finishedAt: now,
      })
      .where(and(eq(builderToolSteps.id, stepId), inArray(builderToolSteps.status, opts.from)))
      .returning({ id: builderToolSteps.id });
    if (!moved.length) return null;
    await tx
      .update(builderThreads)
      .set({ pendingTurnCiphertext: null, status: "needs_attention", updatedAt: now })
      .where(eq(builderThreads.id, thread.id));
    const [note] = await tx
      .insert(builderMessages)
      .values({ threadId: thread.id, agentId: thread.agentId, userId: thread.userId, role: "system", content: opts.note })
      .returning();
    return note ?? null;
  });
}

/**
 * ADR-0173 review — the way out of a pause nobody will answer (an approval
 * never decided, a confirmation the person no longer wants): the thread's
 * person or an admin CANCELS the pending step. Nothing runs; the step is
 * refused, the paused turn cleared, a system note written and the act audited.
 * A pending organisation approval the step waited on is superseded, so it
 * leaves the approver's queue and can never be spent by a later identical call.
 */
export async function cancelBuilderStep(
  db: Db,
  args: { threadId: string; stepId: string; actorUserId: string; actorIsAdmin: boolean },
): Promise<TurnOutcome> {
  const [thread] = await db.select().from(builderThreads).where(eq(builderThreads.id, args.threadId));
  if (!thread) return { ok: false, status: 404, error: "unknown_thread" };
  const byOwner = thread.userId === args.actorUserId;
  if (!byOwner && !args.actorIsAdmin) return { ok: false, status: 404, error: "unknown_thread" };
  const [step] = await db.select().from(builderToolSteps).where(eq(builderToolSteps.id, args.stepId));
  if (!step || step.threadId !== thread.id) return { ok: false, status: 404, error: "unknown_step" };
  if (step.status !== "pending_confirmation" && step.status !== "pending_approval") {
    return { ok: false, status: 409, error: "step_not_pending", detail: `this step is ${step.status.replace("_", " ")}`, threadId: thread.id };
  }
  const code = byOwner ? "cancelled_by_user" : "cancelled_by_admin";
  const who = byOwner ? "you" : "an admin";
  const note = await endPausedStep(db, thread, step.id, {
    from: ["pending_confirmation", "pending_approval"],
    status: "refused",
    code,
    detail: `cancelled by ${byOwner ? "the person in the thread" : "an admin"}; the tool did not run`,
    note: `Cancelled by ${who}: '${step.displayName}' did not run. Send a message to continue.`,
    decidedByUserId: args.actorUserId,
  });
  if (!note) return { ok: false, status: 409, error: "step_not_pending", threadId: thread.id };
  let supersededApprovalId: string | null = null;
  if (step.approvalId) {
    const moved = await db
      .update(approvals)
      .set({ status: "superseded", decisionReason: "superseded: the builder conversation waiting on this approval was cancelled" })
      .where(and(eq(approvals.id, step.approvalId), eq(approvals.status, "pending")))
      .returning({ id: approvals.id });
    supersededApprovalId = moved[0]?.id ?? null;
  }
  await audit(
    db,
    args.actorUserId,
    thread.agentId,
    "builder-tool-step-cancelled",
    `tool step '${step.displayName}' (${step.status.replace("_", " ")}) cancelled by ${byOwner ? "the thread's person" : "an admin"}; nothing ran`,
    { builderThreadId: thread.id, builderStepId: step.id, from: step.status, approvalId: step.approvalId, supersededApprovalId, byAdmin: !byOwner },
    "deny",
  );
  const [[t], [s]] = await Promise.all([
    db.select().from(builderThreads).where(eq(builderThreads.id, thread.id)),
    db.select().from(builderToolSteps).where(eq(builderToolSteps.id, step.id)),
  ]);
  const out: TurnOutcome = { ok: true, thread: t ?? thread, messages: [note], steps: s ? [s] : [] };
  await notifyResumed(db, thread.id, thread.source, out);
  return out;
}

/**
 * A pause on an organisation approval that can no longer be answered — its
 * approval passed `expires_at` (the org's TTL dial, stamped at queue time), was
 * superseded, or is gone — is ended lazily, when the thread is next read or
 * written to. A pending approval with NO expiry (the TTL dial off) never
 * lapses by itself: the cancel action is the way out. Returns whether a pause
 * was ended.
 */
export async function settleLapsedApprovalPause(db: Db, thread: BuilderThreadRow): Promise<boolean> {
  if (!thread.pendingTurnCiphertext) return false;
  const waiting = await db
    .select({ step: builderToolSteps, apStatus: approvals.status, apExpiresAt: approvals.expiresAt })
    .from(builderToolSteps)
    .leftJoin(approvals, eq(builderToolSteps.approvalId, approvals.id))
    .where(and(eq(builderToolSteps.threadId, thread.id), eq(builderToolSteps.status, "pending_approval")));
  let ended = false;
  for (const w of waiting) {
    const now = Date.now();
    const lapsed =
      w.apStatus == null
        ? "gone"
        : w.apStatus === "superseded"
          ? "superseded"
          : (w.apStatus === "pending" || w.apStatus === "approved") && w.apExpiresAt && w.apExpiresAt.getTime() <= now
            ? "expired"
            : null;
    if (!lapsed) continue;
    const detail =
      lapsed === "expired"
        ? "the approval this call waited on expired before it was used"
        : lapsed === "superseded"
          ? "the approval this call waited on was superseded"
          : "the approval this call waited on no longer exists";
    const note = await endPausedStep(db, thread, w.step.id, {
      from: ["pending_approval"],
      status: "refused",
      code: lapsed === "expired" ? "approval_expired" : "approval_withdrawn",
      detail,
      note: `Stopped: ${detail}, so '${w.step.displayName}' did not run. Send a message to continue.`,
    });
    if (!note) continue;
    ended = true;
    // an expired approval still PENDING is dead (it can never be spent) but the
    // governed path would hand the same row to the next identical call, which
    // would pause on it again: retire it visibly, so the next call raises a
    // fresh one (the ADR-0105 discipline for consent that lapsed)
    let supersededApprovalId: string | null = null;
    if (lapsed === "expired" && w.apStatus === "pending" && w.step.approvalId) {
      const moved = await db
        .update(approvals)
        .set({ status: "superseded", decisionReason: "superseded: this approval passed its expiry before it was decided" })
        .where(and(eq(approvals.id, w.step.approvalId), eq(approvals.status, "pending")))
        .returning({ id: approvals.id });
      supersededApprovalId = moved[0]?.id ?? null;
    }
    await audit(db, thread.userId, thread.agentId, "builder-tool-step-approval-lapsed",
      `tool step '${w.step.displayName}' ended: ${detail}`,
      { builderThreadId: thread.id, builderStepId: w.step.id, approvalId: w.step.approvalId, lapsed, supersededApprovalId }, "deny");
    await notifyResumed(db, thread.id, thread.source, {
      ok: true,
      thread: { ...thread, pendingTurnCiphertext: null, status: "needs_attention" },
      messages: [note],
      steps: [],
    });
  }
  return ended;
}

/** what a resumed (or cancelled, or lapsed) paused turn produced, for
 * observers — inbound channels post the agent's reply back into the platform
 * thread. `db` names the database the turn ran on, so an app only acts on its
 * own turns. */
export type BuilderTurnResumedListener = (event: {
  db: Db;
  threadId: string;
  source: BuilderThreadRow["source"];
  outcome: TurnOutcome;
}) => void | Promise<void>;
const resumedListeners = new Set<BuilderTurnResumedListener>();
/** subscribe to resumed turns; returns the unsubscribe. A listener's failure
 * never affects the turn (it is caught and dropped). */
export function onBuilderTurnResumed(listener: BuilderTurnResumedListener): () => void {
  resumedListeners.add(listener);
  return () => resumedListeners.delete(listener);
}
async function notifyResumed(db: Db, threadId: string, source: BuilderThreadRow["source"], outcome: TurnOutcome) {
  for (const l of resumedListeners) {
    try {
      await l({ db, threadId, source, outcome });
    } catch {
      /* an observer never fails a turn */
    }
  }
}

/** builder tool steps waiting on this approvals-queue row (the decide hook) */
export async function builderStepsAwaitingApproval(db: Db, approvalId: string): Promise<BuilderToolStepRow[]> {
  return db
    .select()
    .from(builderToolSteps)
    .where(and(eq(builderToolSteps.approvalId, approvalId), eq(builderToolSteps.status, "pending_approval")));
}

/**
 * The approvals-queue post-commit hook (app.ts decideOneApproval): an approval
 * a builder tool step waits on was decided, so its turn resumes — approved ->
 * the identical call, denied -> the model is told who denied it and why. Only
 * a step whose person is the approval's requester is resumed. Never throws for
 * a refusal (the decision is already durable); the outcome is audited.
 */
export async function resumeBuilderAfterApproval(
  db: Db,
  dataKey: string | undefined,
  approval: { id: string; userId: string; decisionReason: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  const steps = await builderStepsAwaitingApproval(db, approval.id);
  for (const s of steps) {
    if (s.userId !== approval.userId) continue;
    await resumeBuilderStep(db, dataKey, {
      threadId: s.threadId,
      stepId: s.id,
      via: "approval",
      decision: decision === "approved" ? "approve" : "deny",
      deciderUserId,
      reason: approval.decisionReason,
    });
  }
}

// ---------------------------------------------------------------------------
// the schedule sweep
// ---------------------------------------------------------------------------

export interface BuilderScheduleSweepResult {
  due: number;
  ran: number;
  refused: number;
  skipped: Array<{ scheduleId: string; reason: string }>;
  /** due schedules left for the next pass because their owner reached
   * BUILDER_LIMITS.sweepRunsPerOwner in this one (fairness, not failure) */
  deferred: number;
  /** agents with due schedules skipped because they bill to no project */
  skippedNeedsProject: number;
  threadIds: string[];
}

/**
 * Run every schedule whose `next_run_at` has passed and that the agent's OWNER
 * turned on, AS THAT OWNER (never as an admin, never as the scheduler — it has
 * no identity). A schedule someone else created or edited is saved off and
 * waits for the owner (it would spend as them). Each due schedule is CLAIMED
 * by a compare-and-swap on `next_run_at` before it runs, so two concurrent
 * sweeps (or a manual sweep racing the timer) run it once, and a re-run at the
 * same instant finds nothing due: idempotent. One owner gets at most
 * BUILDER_LIMITS.sweepRunsPerOwner runs per pass; the rest stay due (unclaimed)
 * for the next pass, so one person's many schedules cannot starve everyone's.
 */
export async function runBuilderScheduleSweep(
  db: Db,
  dataKey: string | undefined,
  opts: { now?: Date } = {},
): Promise<BuilderScheduleSweepResult> {
  const now = opts.now ?? new Date();
  const out: BuilderScheduleSweepResult = { due: 0, ran: 0, refused: 0, skipped: [], deferred: 0, skippedNeedsProject: 0, threadIds: [] };
  const due = await db
    .select({ s: builderAgentSchedules, ownerUserId: builderAgents.ownerUserId })
    .from(builderAgentSchedules)
    .innerJoin(builderAgents, eq(builderAgentSchedules.agentId, builderAgents.id))
    .where(
      and(
        eq(builderAgentSchedules.enabled, true),
        eq(builderAgentSchedules.enabledByUserId, builderAgents.ownerUserId),
        lte(builderAgentSchedules.nextRunAt, now),
        // owner rule: an agent with no project never runs. Filtered HERE, not
        // after the LIMIT, so legacy schedules cannot starve the rest.
        isNotNull(builderAgents.projectId),
      ),
    )
    .orderBy(asc(builderAgentSchedules.nextRunAt))
    .limit(200);
  out.due = due.length;
  // ...and said once per pass, not once per schedule
  const projectless = await db
    .select({ agentId: builderAgents.id, scheduleId: builderAgentSchedules.id })
    .from(builderAgentSchedules)
    .innerJoin(builderAgents, eq(builderAgentSchedules.agentId, builderAgents.id))
    .where(
      and(
        eq(builderAgentSchedules.enabled, true),
        lte(builderAgentSchedules.nextRunAt, now),
        isNull(builderAgents.projectId),
        isNull(builderAgents.archivedAt),
      ),
    )
    .limit(500);
  if (projectless.length) {
    const agentIds = [...new Set(projectless.map((p) => p.agentId))];
    out.skippedNeedsProject = agentIds.length;
    await audit(
      db,
      ZERO_UUID,
      ZERO_UUID,
      "builder-agent-schedule-needs-project",
      `${projectless.length} due schedule(s) on ${agentIds.length} agent(s) skipped: every agent must bill to a project (choose one in Configure → Advanced)`,
      { agentIds: agentIds.slice(0, 100), schedules: projectless.length },
      "deny",
    );
  }
  const perOwner = new Map<string, number>();
  for (const { s, ownerUserId } of due) {
    const n = perOwner.get(ownerUserId) ?? 0;
    if (n >= BUILDER_LIMITS.sweepRunsPerOwner) {
      out.deferred++;
      continue; // left unclaimed: still due on the next pass
    }
    perOwner.set(ownerUserId, n + 1);
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
    const [owner] = await db
      .select({ disabledAt: users.disabledAt, isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, agent.ownerUserId));
    if (!owner || owner.disabledAt) {
      out.skipped.push({ scheduleId: s.id, reason: "agent owner is deactivated" });
      await audit(db, ZERO_UUID, agent.id, "builder-agent-schedule-skipped", `schedule '${s.name}' skipped: the agent owner is deactivated`, { scheduleId: s.id }, "deny");
      continue;
    }
    const turn = await runBuilderTurn(db, dataKey, {
      agent,
      userId: agent.ownerUserId,
      isAdmin: owner.isAdmin,
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
