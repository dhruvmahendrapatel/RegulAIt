/**
 * ADR-0339 — THE AGENT RISK SCORE: the gateway side (gather, score, snapshot, serve).
 *
 * The scoring rules are pure and live in `@regulait/shared` (agent-risk-score.ts). This module:
 *
 *  - GATHERS each agent's facts from the ledgers, reusing the existing readers rather than re-deriving them: the
 *    ADR-0180 A8 floor evidence (`loadFloorEvidence`: effective guardrail modes, the model-card gate read as enforced,
 *    the newest fresh run per agentic red-team class), the A8 autonomy facts and class (`loadAutonomyFacts`,
 *    `deriveAutonomyClass`), the ADR-0089 ownership flag (`ownershipFlagFor`) and the ADR-0091 SoD check
 *    (`checkSodFootprint`, with a holder that holds nothing, so only a rule whose every side the agent's own
 *    capability set holds can match: the "bundle-internal" case).
 *  - RECOMPUTES ON EVERY CHANGE. Database triggers (migration `agent_risk_scores`) mark the agent in
 *    `agent_risk_recompute_requests` inside the transaction of the change itself, on every write path. The sweep
 *    (`runAgentRiskRecomputeSweep`, scheduled every minute and runnable by an admin) scores each marked agent and, in
 *    ONE transaction, appends the assessment, writes its audit row and deletes exactly the requests it read (a request
 *    re-marked while it was scoring keeps its newer timestamp and is scored again).
 *  - SERVES the live score (recomputed on every read, so a change of evidence shows at once), the newest stored
 *    assessment and the history, to an admin or the agent's own steward/owner (object-level authorisation on every
 *    request, `private, no-store`), and a ranked list to an admin.
 *
 * Read-only toward everything it scores: it changes no agent, grant or setting.
 */
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agentGrants,
  agentRiskAssessments,
  agentRiskRecomputeRequests,
  agents,
  aiUseCases,
  and,
  asc,
  auditLog,
  builderAgentShares,
  builderAgentSkills,
  builderAgentSubagents,
  builderAgentTools,
  builderAgents,
  builderSkills,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  mcpTools,
  notInArray,
  or,
  roleAgentGrants,
  roleAssignments,
  sql,
  users,
  type Db,
} from "@regulait/db";
import {
  AGENT_RISK_METHOD_VERSION,
  AGENT_RISK_SUBJECT_KINDS,
  NO_AUTONOMY_FACTS,
  NO_AUTONOMY_OBSERVATION,
  canonicalJson,
  declaredBelowObserved,
  deriveAutonomyClass,
  effectiveAutonomyClass,
  scoreAgentRisk,
  type AgentRiskAssessment,
  type AgentRiskInput,
  type AgentRiskSubjectKind,
  type AgentRiskTrigger,
  type AutonomyClass,
} from "@regulait/shared";
import { loadAutonomyFacts, loadFloorEvidence } from "./autonomy.js";
import { ownershipFlagFor } from "./inventory.js";
import { checkSodFootprint, type Capability } from "./sod.js";
import { databaseNow } from "./db-clock.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

export const AGENT_RISK_SWEEP_JOB_NAME = "agent-risk-recompute-sweep";
/** agents scored per sweep pass; the rest wait for the next pass (bounded work per tick) */
export const AGENT_RISK_SWEEP_BATCH = 50;
export const AGENT_RISK_LIST_MAX_LIMIT = 100;
const AGENT_RISK_LIST_DEFAULT_LIMIT = 50;
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";
/** a holder id nobody is: the SoD check then reports only rules the agent's own capabilities satisfy */
const NOBODY = "00000000-0000-0000-0000-000000000000";
/** builder skills admitted for use (anything else is held, refused or never scanned) */
const ADMITTED_SKILL_STATES = ["clean", "admitted"] as const;

export interface AgentRiskSubject {
  kind: AgentRiskSubjectKind;
  id: string;
}

const emptyFacts = () => ({ ...NO_AUTONOMY_FACTS, ...NO_AUTONOMY_OBSERVATION });

// ---------------------------------------------------------------------------
// Gather
// ---------------------------------------------------------------------------

async function disabledUsers(db: Db, ids: Array<string | null>): Promise<Set<string>> {
  const want = [...new Set(ids.filter((i): i is string => !!i))];
  if (!want.length) return new Set();
  const rows = await db.select({ id: users.id }).from(users).where(and(inArray(users.id, want), isNotNull(users.disabledAt)));
  return new Set(rows.map((r) => r.id));
}

async function sodRuleHeldBy(db: Db, capabilities: Capability[]): Promise<{ id: string; name: string } | null> {
  if (!capabilities.length) return null;
  const conflict = await checkSodFootprint(db, { capabilities, userIds: [NOBODY] });
  return conflict ? { id: conflict.rule.id, name: conflict.rule.name } : null;
}

/** the people a registry agent reaches: active users with a direct grant or a role that grants it */
async function registryReach(db: Db, agentId: string) {
  const [direct] = await db
    .select({ n: sql<number>`count(DISTINCT ${agentGrants.userId})` })
    .from(agentGrants)
    .innerJoin(users, eq(users.id, agentGrants.userId))
    .where(and(eq(agentGrants.agentId, agentId), isNull(users.disabledAt)));
  const [viaRole] = await db
    .select({ n: sql<number>`count(DISTINCT ${roleAssignments.userId})` })
    .from(roleAgentGrants)
    .innerJoin(roleAssignments, eq(roleAssignments.roleId, roleAgentGrants.roleId))
    .innerJoin(users, eq(users.id, roleAssignments.userId))
    .where(and(eq(roleAgentGrants.agentId, agentId), isNull(users.disabledAt)));
  const [bound] = await db
    .select({ n: count() })
    .from(builderAgents)
    .where(and(eq(builderAgents.modelAgentId, agentId), isNull(builderAgents.archivedAt)));
  const [useCases] = await db
    .select({ n: count() })
    .from(aiUseCases)
    .where(sql`${aiUseCases.intendedAgentIds} @> ${JSON.stringify([agentId])}::jsonb`);
  // a user holding both a direct and a role grant is counted twice at most; the band is coarse on purpose
  const people = Number(direct?.n ?? 0) + Number(viaRole?.n ?? 0);
  const dependents = Number(bound?.n ?? 0) + Number(useCases?.n ?? 0);
  return {
    people,
    dependents,
    detail: `${Number(direct?.n ?? 0)} with a direct grant, ${Number(viaRole?.n ?? 0)} through a role; ${Number(bound?.n ?? 0)} builder agents bound to it, ${Number(useCases?.n ?? 0)} use cases intend it`,
  };
}

export async function registryAgentInput(db: Db, agentId: string, now: Date): Promise<AgentRiskInput | null> {
  const [a] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!a) return null;
  const disabled = await disabledUsers(db, [a.ownerUserId]);
  const evidence = await loadFloorEvidence(db, { projectId: null, modelAgentId: a.id, monthlyLimitUsd: null }, emptyFacts(), now);
  const reach = await registryReach(db, a.id);
  return {
    kind: "agent",
    id: a.id,
    name: a.name,
    ownership: ownershipFlagFor(a.ownerUserId, !!a.ownerUserId && disabled.has(a.ownerUserId)),
    guardrailModes: evidence.guardrailModes,
    modelBound: !!a.model,
    modelCardApproved: evidence.modelCardApproved,
    agenticTests: evidence.agenticTests,
    testFreshnessDays: evidence.testFreshnessDays,
    customEndpoint: a.provider === "custom",
    servedModelRelaxed: a.expectedServedModel !== null && a.expectedServedModel !== a.model,
    reach,
    sodRule: await sodRuleHeldBy(db, [{ kind: "agent", objectId: a.id, toolName: null, mode: null }]),
  };
}

export async function builderAgentInput(db: Db, agentId: string, now: Date): Promise<AgentRiskInput | null> {
  const [b] = await db.select().from(builderAgents).where(and(eq(builderAgents.id, agentId), isNull(builderAgents.archivedAt)));
  if (!b) return null;
  const facts = (await loadAutonomyFacts(db, [b], now)).get(b.id) ?? { ...emptyFacts(), computerUse: b.computerUse };
  const evidence = await loadFloorEvidence(db, b, facts, now);
  const derived = deriveAutonomyClass(facts);
  const declared = (b.declaredAutonomyClass ?? null) as AutonomyClass | null;
  const [model] = b.modelAgentId
    ? await db
        .select({ id: agents.id, model: agents.model, provider: agents.provider, expectedServedModel: agents.expectedServedModel })
        .from(agents)
        .where(eq(agents.id, b.modelAgentId))
    : [];
  const disabled = await disabledUsers(db, [b.ownerUserId]);

  const [skills] = await db
    .select({ n: count() })
    .from(builderAgentSkills)
    .innerJoin(builderSkills, eq(builderSkills.id, builderAgentSkills.skillId))
    .where(and(eq(builderAgentSkills.agentId, b.id), notInArray(builderSkills.admissionState, [...ADMITTED_SKILL_STATES])));

  const [shares] = await db.select({ n: count() }).from(builderAgentShares).where(eq(builderAgentShares.agentId, b.id));
  const [workspace] =
    b.sharing === "workspace" ? await db.select({ n: count() }).from(users).where(isNull(users.disabledAt)) : [{ n: 0 }];
  const [parents] = await db.select({ n: count() }).from(builderAgentSubagents).where(eq(builderAgentSubagents.childId, b.id));
  const people = b.sharing === "workspace" ? Number(workspace?.n ?? 0) : 1 + (b.sharing === "people" ? Number(shares?.n ?? 0) : 0);

  // the agent's own capability set for the SoD check: its tools and its model
  const tools = await db.select({ kind: builderAgentTools.kind, refId: builderAgentTools.refId }).from(builderAgentTools).where(eq(builderAgentTools.agentId, b.id));
  const mcpIds = tools.filter((t) => t.kind === "mcp_tool").map((t) => t.refId);
  const mcp = mcpIds.length ? await db.select({ id: mcpTools.id, serverId: mcpTools.serverId, name: mcpTools.name }).from(mcpTools).where(inArray(mcpTools.id, mcpIds)) : [];
  const capabilities: Capability[] = [
    ...tools.filter((t) => t.kind === "connector").map((t) => ({ kind: "connector" as const, objectId: t.refId, toolName: null, mode: "readwrite" as const })),
    ...mcp.map((m) => ({ kind: "mcp_tool" as const, objectId: m.serverId, toolName: m.name, mode: null })),
    ...(b.modelAgentId ? [{ kind: "agent" as const, objectId: b.modelAgentId, toolName: null, mode: null }] : []),
  ];

  return {
    kind: "builder_agent",
    id: b.id,
    name: b.name,
    ownership: ownershipFlagFor(b.ownerUserId, disabled.has(b.ownerUserId)),
    guardrailModes: evidence.guardrailModes,
    modelBound: !!model?.model,
    modelCardApproved: evidence.modelCardApproved,
    agenticTests: evidence.agenticTests,
    testFreshnessDays: evidence.testFreshnessDays,
    customEndpoint: model?.provider === "custom",
    servedModelRelaxed: !!model && model.expectedServedModel !== null && model.expectedServedModel !== model.model,
    builder: {
      facts,
      effectiveClass: effectiveAutonomyClass(derived, declared),
      declaredBelowObserved: declaredBelowObserved(declared, derived),
      monthlyLimitUsd: b.monthlyLimitUsd,
      unadmittedSkills: Number(skills?.n ?? 0),
    },
    reach: {
      people,
      dependents: Number(parents?.n ?? 0),
      detail: `sharing '${b.sharing}': ${people} people can use it; ${Number(parents?.n ?? 0)} agents use it as a sub-agent`,
    },
    sodRule: await sodRuleHeldBy(db, capabilities),
  };
}

/** the live assessment of one agent, or null when it does not exist (or, for a builder agent, is archived) */
export async function assessAgentRisk(db: Db, subject: AgentRiskSubject, now?: Date): Promise<AgentRiskAssessment | null> {
  const at = now ?? (await databaseNow(db));
  const input = subject.kind === "agent" ? await registryAgentInput(db, subject.id, at) : await builderAgentInput(db, subject.id, at);
  return input ? scoreAgentRisk(input) : null;
}

export function assessmentDigest(a: AgentRiskAssessment): string {
  return createHash("sha256").update(canonicalJson(a)).digest("hex");
}

// ---------------------------------------------------------------------------
// The sweep (scheduled, and the admin's "recompute now": one code path)
// ---------------------------------------------------------------------------

const subjectCol = (kind: AgentRiskSubjectKind) => (kind === "agent" ? agentRiskRecomputeRequests.agentId : agentRiskRecomputeRequests.builderAgentId);
const assessmentCol = (kind: AgentRiskSubjectKind) => (kind === "agent" ? agentRiskAssessments.agentId : agentRiskAssessments.builderAgentId);

export interface AgentRiskSweepResult {
  scored: number;
  dropped: number;
  failed: number;
  changed: number;
}

/** queue a recompute by hand (an admin's request); the triggers cover every change */
export async function markAgentRisk(db: Db, subject: AgentRiskSubject, trigger: AgentRiskTrigger): Promise<void> {
  await db.execute(
    sql`SELECT public.regulait_agent_risk_mark(${subject.kind === "agent" ? subject.id : null}::uuid, ${subject.kind === "builder_agent" ? subject.id : null}::uuid, ${trigger})`,
  );
}

export async function runAgentRiskRecomputeSweep(
  db: Db,
  opts: { now?: Date; limit?: number; actorUserId?: string | null; only?: AgentRiskSubject } = {},
): Promise<AgentRiskSweepResult> {
  const limit = Math.min(Math.max(1, opts.limit ?? AGENT_RISK_SWEEP_BATCH), 500);
  const out: AgentRiskSweepResult = { scored: 0, dropped: 0, failed: 0, changed: 0 };
  // the oldest-marked agents first, one row per agent
  const only = opts.only
    ? opts.only.kind === "agent"
      ? sql`WHERE agent_id = ${opts.only.id}::uuid`
      : sql`WHERE builder_agent_id = ${opts.only.id}::uuid`
    : sql``;
  const pending = await db.execute<{ agent_id: string | null; builder_agent_id: string | null }>(sql`
    SELECT agent_id, builder_agent_id FROM agent_risk_recompute_requests ${only}
    GROUP BY agent_id, builder_agent_id ORDER BY min(requested_at) LIMIT ${limit}`);
  for (const p of pending.rows) {
    const subject: AgentRiskSubject = p.agent_id ? { kind: "agent", id: p.agent_id } : { kind: "builder_agent", id: p.builder_agent_id! };
    // the exact requests this pass answers, read BEFORE scoring: a request re-marked meanwhile has a newer timestamp
    const requests = await db
      // the timestamp as Postgres' microsecond text, never a millisecond Date, so the compare below is exact
      .select({ id: agentRiskRecomputeRequests.id, trigger: agentRiskRecomputeRequests.trigger, requestedAt: sql<string>`${agentRiskRecomputeRequests.requestedAt}::text` })
      .from(agentRiskRecomputeRequests)
      .where(eq(subjectCol(subject.kind), subject.id));
    if (!requests.length) continue;
    const drained = or(...requests.map((r) => and(eq(agentRiskRecomputeRequests.id, r.id), sql`${agentRiskRecomputeRequests.requestedAt} = ${r.requestedAt}::timestamptz`)));
    try {
      const assessment = await assessAgentRisk(db, subject, opts.now);
      await db.transaction(async (tx) => {
        if (!assessment) {
          // gone or archived: nothing to score; the request is answered
          await tx.delete(agentRiskRecomputeRequests).where(drained);
          return;
        }
        const [prev] = await tx
          .select({ score: agentRiskAssessments.score, digest: agentRiskAssessments.assessmentDigest })
          .from(agentRiskAssessments)
          .where(eq(assessmentCol(subject.kind), subject.id))
          .orderBy(desc(agentRiskAssessments.computedAt), desc(agentRiskAssessments.id))
          .limit(1);
        const digest = assessmentDigest(assessment);
        const triggers = [...new Set(requests.map((r) => r.trigger))].sort();
        const [row] = await tx
          .insert(agentRiskAssessments)
          .values({
            agentId: subject.kind === "agent" ? subject.id : null,
            builderAgentId: subject.kind === "builder_agent" ? subject.id : null,
            methodVersion: AGENT_RISK_METHOD_VERSION,
            score: assessment.score,
            band: assessment.band,
            triggers,
            assessment,
            assessmentDigest: digest,
          })
          .returning({ id: agentRiskAssessments.id });
        await tx.insert(auditLog).values({
          userId: opts.actorUserId ?? SYSTEM_ACTOR,
          objectType: subject.kind === "agent" ? "agent" : "builder_agent",
          objectId: subject.id,
          detail: {
            phase: "agent-risk-recomputed",
            assessmentId: row!.id,
            methodVersion: AGENT_RISK_METHOD_VERSION,
            score: assessment.score,
            band: assessment.band,
            previousScore: prev?.score ?? null,
            unchanged: prev?.digest === digest,
            triggers,
            topFixes: assessment.fixes.slice(0, 3).map((f) => ({ source: f.source, points: f.points })),
            receiptClass: "configuration",
          },
          effect: "allow",
          ruleId: "agent-risk-recomputed",
          ruleChain: [],
          reason: `risk score of ${subject.kind === "agent" ? "agent" : "builder agent"} '${assessment.subject.name}' recomputed: ${assessment.score} (${assessment.band})${prev ? `, was ${prev.score}` : ""}`,
        });
        await tx.delete(agentRiskRecomputeRequests).where(drained);
        if (prev?.digest !== digest) out.changed++;
      });
      if (assessment) out.scored++;
      else out.dropped++;
    } catch (err) {
      // the agent was deleted while it was being scored (its cascade removed the requests): nothing to record
      const code = (err as { code?: string; cause?: { code?: string } })?.code ?? (err as { cause?: { code?: string } })?.cause?.code;
      if (code === "23503") out.dropped++;
      else {
        out.failed++;
        // left queued; the next pass retries it. Never silently swallowed: the job result reports the count.
      }
    }
  }
  return out;
}

export function agentRiskJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: AGENT_RISK_SWEEP_JOB_NAME,
      description:
        "Score every agent marked by a change (created, modified, published, access changed) and append its risk " +
        `assessment with an audit row, up to ${AGENT_RISK_SWEEP_BATCH} agents a pass. The live score on read does not ` +
        "depend on it; the stored assessments are the history.",
      adr: "ADR-0339",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runAgentRiskRecomputeSweep(ctx.db, { now: ctx.now });
        return { itemsProcessed: out.scored, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const subjectParams = z.object({ kind: z.enum(AGENT_RISK_SUBJECT_KINDS), subjectId: z.string().uuid() });
const pageQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(AGENT_RISK_LIST_MAX_LIMIT).default(AGENT_RISK_LIST_DEFAULT_LIMIT),
    cursor: z.string().max(512).optional(),
  })
  .strict();
const listQuery = pageQuery.extend({ kind: z.enum(AGENT_RISK_SUBJECT_KINDS).default("agent") }).strict();
const recomputeBody = z
  .object({ kind: z.enum(AGENT_RISK_SUBJECT_KINDS).optional(), subjectId: z.string().uuid().optional() })
  .strict()
  .refine((b) => (b.kind === undefined) === (b.subjectId === undefined), { message: "kind and subjectId go together" });

const historyCursor = z.object({ t: z.string().max(64), i: z.string().uuid() }).strict();
const listCursor = z.object({ s: z.number().int().min(0).max(100), i: z.string().uuid() }).strict();
const enc = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
function dec<T>(schema: z.ZodType<T>, raw: string): T | null {
  try {
    const p = schema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

function privateNoStore(reply: FastifyReply) {
  // computed per caller from an authorisation check made on this request: never shared, never reused
  reply.header("cache-control", "private, no-store");
}

/** may the caller read this agent's score? An admin, or the agent's steward (registry) or owner (builder). */
async function mayRead(db: Db, req: FastifyRequest, subject: AgentRiskSubject): Promise<boolean | null> {
  const owner =
    subject.kind === "agent"
      ? (await db.select({ o: agents.ownerUserId }).from(agents).where(eq(agents.id, subject.id)))[0]
      : (await db.select({ o: builderAgents.ownerUserId }).from(builderAgents).where(eq(builderAgents.id, subject.id)))[0];
  if (!owner) return null;
  if (req.authCtx.isAdmin) return true;
  return !!req.authCtx.userId && owner.o === req.authCtx.userId;
}

const notFound = (reply: FastifyReply) => reply.status(404).send({ error: "not_found" });

export function registerAgentRiskRoutes(app: FastifyInstance, db: Db): void {
  /**
   * One agent's risk score, computed now from current records, with the newest stored assessment and whether a
   * recompute is pending. An admin or the agent's own steward/owner; anyone else gets the 404 a missing agent gets.
   */
  app.get("/v1/agent-risk/:kind/:subjectId", async (req, reply) => {
    privateNoStore(reply);
    const p = subjectParams.safeParse(req.params);
    if (!p.success) return notFound(reply);
    const subject: AgentRiskSubject = { kind: p.data.kind, id: p.data.subjectId };
    if (!(await mayRead(db, req, subject))) return notFound(reply);
    const live = await assessAgentRisk(db, subject);
    if (!live) return notFound(reply);
    const [latest] = await db
      .select({ id: agentRiskAssessments.id, score: agentRiskAssessments.score, band: agentRiskAssessments.band, computedAt: agentRiskAssessments.computedAt, triggers: agentRiskAssessments.triggers, methodVersion: agentRiskAssessments.methodVersion })
      .from(agentRiskAssessments)
      .where(eq(assessmentCol(subject.kind), subject.id))
      .orderBy(desc(agentRiskAssessments.computedAt), desc(agentRiskAssessments.id))
      .limit(1);
    const [pending] = await db.select({ n: count() }).from(agentRiskRecomputeRequests).where(eq(subjectCol(subject.kind), subject.id));
    return { ...live, latestAssessment: latest ?? null, recomputePending: Number(pending?.n ?? 0) > 0 };
  });

  /** The stored assessments of one agent, newest first (keyset on computed_at, id). Same authorisation as above. */
  app.get("/v1/agent-risk/:kind/:subjectId/history", async (req, reply) => {
    privateNoStore(reply);
    const p = subjectParams.safeParse(req.params);
    if (!p.success) return notFound(reply);
    const q = pageQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: "invalid_query", issues: q.error.issues.map((i) => ({ path: i.path, message: i.message })) });
    const subject: AgentRiskSubject = { kind: p.data.kind, id: p.data.subjectId };
    if (!(await mayRead(db, req, subject))) return notFound(reply);
    const after = q.data.cursor === undefined ? null : dec(historyCursor, q.data.cursor);
    if (q.data.cursor !== undefined && !after) return reply.status(400).send({ error: "invalid_cursor" });
    const conds = [eq(assessmentCol(subject.kind), subject.id)];
    if (after) {
      const t = sql`${after.t}::timestamptz`;
      conds.push(or(lt(agentRiskAssessments.computedAt, t), and(eq(agentRiskAssessments.computedAt, t), lt(agentRiskAssessments.id, after.i)))!);
    }
    const rows = await db
      .select({
        id: agentRiskAssessments.id,
        score: agentRiskAssessments.score,
        band: agentRiskAssessments.band,
        triggers: agentRiskAssessments.triggers,
        methodVersion: agentRiskAssessments.methodVersion,
        assessment: agentRiskAssessments.assessment,
        computedAt: agentRiskAssessments.computedAt,
        // the cursor carries Postgres' microsecond timestamp, never the millisecond Date (the #855 lesson)
        cursorAt: sql<string>`to_char(${agentRiskAssessments.computedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(agentRiskAssessments)
      .where(and(...conds))
      .orderBy(desc(agentRiskAssessments.computedAt), desc(agentRiskAssessments.id))
      .limit(q.data.limit + 1);
    const page = rows.slice(0, q.data.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ cursorAt: _c, ...r }) => r),
      nextCursor: rows.length > q.data.limit && last ? enc({ t: last.cursorAt, i: last.id }) : null,
      limit: q.data.limit,
    };
  });

  /**
   * Admin: every agent of one kind ranked by its newest stored score, highest first (keyset on score, id). Agents not
   * yet scored are not listed; `unscored` counts them, so a gap is visible rather than read as "low risk".
   */
  app.get("/v1/agent-risk", async (req, reply) => {
    privateNoStore(reply);
    const q = listQuery.safeParse(req.query);
    if (!q.success) return reply.status(400).send({ error: "invalid_query", issues: q.error.issues.map((i) => ({ path: i.path, message: i.message })) });
    const after = q.data.cursor === undefined ? null : dec(listCursor, q.data.cursor);
    if (q.data.cursor !== undefined && !after) return reply.status(400).send({ error: "invalid_cursor" });
    const col = q.data.kind === "agent" ? sql`agent_id` : sql`builder_agent_id`;
    const nameJoin =
      q.data.kind === "agent"
        ? sql`JOIN agents s ON s.id = l.subject_id`
        : sql`JOIN builder_agents s ON s.id = l.subject_id AND s.archived_at IS NULL`;
    const cursorCond = after ? sql`AND (l.score < ${after.s} OR (l.score = ${after.s} AND l.subject_id > ${after.i}::uuid))` : sql``;
    const rows = await db.execute<{ subject_id: string; name: string; score: number; band: string; computed_at: string; assessment_id: string }>(sql`
      WITH l AS (
        SELECT DISTINCT ON (${col}) ${col} AS subject_id, id AS assessment_id, score, band, computed_at
        FROM agent_risk_assessments WHERE ${col} IS NOT NULL
        ORDER BY ${col}, computed_at DESC, id DESC
      )
      SELECT l.subject_id, s.name, l.score, l.band, l.computed_at, l.assessment_id FROM l ${nameJoin}
      WHERE true ${cursorCond}
      ORDER BY l.score DESC, l.subject_id ASC
      LIMIT ${q.data.limit + 1}`);
    const unscored = await db.execute<{ n: number }>(
      q.data.kind === "agent"
        ? sql`SELECT count(*)::int AS n FROM agents a WHERE NOT EXISTS (SELECT 1 FROM agent_risk_assessments r WHERE r.agent_id = a.id)`
        : sql`SELECT count(*)::int AS n FROM builder_agents b WHERE b.archived_at IS NULL AND NOT EXISTS (SELECT 1 FROM agent_risk_assessments r WHERE r.builder_agent_id = b.id)`,
    );
    const page = rows.rows.slice(0, q.data.limit);
    const last = page[page.length - 1];
    return {
      kind: q.data.kind,
      items: page.map((r) => ({ id: r.subject_id, name: r.name, score: Number(r.score), band: r.band, computedAt: r.computed_at, assessmentId: r.assessment_id })),
      unscored: Number(unscored.rows[0]?.n ?? 0),
      nextCursor: rows.rows.length > q.data.limit && last ? enc({ s: Number(last.score), i: last.subject_id }) : null,
      limit: q.data.limit,
      methodVersion: AGENT_RISK_METHOD_VERSION,
    };
  });

  /**
   * Admin: run the sweep now (the scheduled job's own function), optionally marking one agent first. Audited per
   * assessment by the sweep, as the admin who asked.
   */
  app.post("/v1/agent-risk/recompute", async (req, reply) => {
    const b = recomputeBody.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_body", issues: b.error.issues.map((i) => ({ path: i.path, message: i.message })) });
    if (b.data.kind && b.data.subjectId) {
      const subject: AgentRiskSubject = { kind: b.data.kind, id: b.data.subjectId };
      if ((await mayRead(db, req, subject)) === null) return notFound(reply);
      await markAgentRisk(db, subject, "manual");
      return runAgentRiskRecomputeSweep(db, { actorUserId: req.authCtx.userId ?? null, only: subject });
    }
    return runAgentRiskRecomputeSweep(db, { actorUserId: req.authCtx.userId ?? null });
  });
}

/** for tests: the subjects of the pending requests */
export async function pendingAgentRiskSubjects(db: Db): Promise<AgentRiskSubject[]> {
  const rows = await db
    .select({ agentId: agentRiskRecomputeRequests.agentId, builderAgentId: agentRiskRecomputeRequests.builderAgentId })
    .from(agentRiskRecomputeRequests)
    .orderBy(asc(agentRiskRecomputeRequests.requestedAt));
  return rows.map((r) => (r.agentId ? { kind: "agent" as const, id: r.agentId } : { kind: "builder_agent" as const, id: r.builderAgentId! }));
}
