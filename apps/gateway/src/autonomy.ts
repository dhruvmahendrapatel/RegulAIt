/**
 * ADR-0180 §5 (A8) — AGENT AUTONOMY CLASS: the gateway side.
 *
 * The rules and floors are pure and live in `@regulait/shared` (autonomy.ts);
 * this module gathers their inputs from the ledgers and serves them:
 *
 *   - FACTS per builder agent: enabled schedules, live sub-agents, write tools
 *     without Ask-first (an MCP tool of kind `write`, or any connector: every
 *     connector kind can write, `connectorOperations`), inbound Slack/Teams
 *     channels bound to a chat connection, computer use, and what it was SEEN
 *     doing in the observation window (runs a schedule or an inbound message
 *     started; tool calls; write calls nobody confirmed or approved).
 *   - FLOOR EVIDENCE per agent: the effective guardrail modes for its model and
 *     project (`resolveGuardrailPolicy`, the call path's own resolver), a live
 *     model-card sign-off (`evaluateMrmGate`, the dispatch gate's own rule, read
 *     as if enforced), the newest fresh red-team run on its model per agentic
 *     class, its monthly limit and its unasked write tools.
 *   - `autonomyFloorFor(db, useCase)`: builder agents count toward a use case
 *     through their shared project (`builder_agents.project_id =
 *     ai_use_cases.project_id`, the join the unregistered-traffic monitor uses).
 *     Every unmet floor of every linked agent becomes an `autonomy_floor`
 *     condition. The limit is stated: "agents linked by project".
 *   - routes GET/PUT `/v1/builder/agents/:id/autonomy`: the agent's steward
 *     (owner) or an admin; 404 when the agent is invisible to the caller, 403
 *     when visible but not theirs. The PUT declares (or withdraws) a class with
 *     a note (prose-scrubbed by the db handle), is audited with the old and new
 *     value, and flags a declaration below the observed class. An admin reading
 *     another person's agent is audited as well.
 *   - the monitor loader for `autonomy_declared_below_observed` (per agent) and
 *     `autonomy_floor_unmet` (per use case and agent).
 *
 * Open-source check (ADR-0176): none fits, because this is governance logic
 * over our own schema; the statistics it needs are counts.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  builderAgentChannels,
  builderAgentSchedules,
  builderAgentSubagents,
  builderAgentTools,
  builderAgents,
  builderThreads,
  builderToolSteps,
  connectors,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  mcpTools,
  ne,
  notInArray,
  redteamRuns,
  sql,
  users,
  type BuilderAgentRow,
  type Db,
} from "@regulait/db";
import {
  ASSURANCE_DEFAULTS,
  AUTONOMY_AGENTIC_TEST_CLASSES,
  AUTONOMY_GUARDRAIL_DETECTORS,
  AUTONOMY_OBSERVATION_WINDOW_DAYS,
  AUTONOMY_SCOPE_NOTE,
  NO_AUTONOMY_FACTS,
  NO_AUTONOMY_OBSERVATION,
  autonomyLevel,
  autonomyReasons,
  checkAutonomyFloors,
  declareAutonomySchema,
  declaredBelowObserved,
  deriveAutonomyClass,
  effectiveAutonomyClass,
  evaluateMrmGate,
  floorConditions,
  mergeAutonomyFacts,
  type AssuranceMonitorRuleId,
  type AutonomyClass,
  type AutonomyFloorCheck,
  type AutonomyFloorEvidence,
  type AutonomyFloorForFn,
  type AutonomyFloorResult,
  type AutonomyObservedFacts,
  type BuilderAgentAutonomyView,
  type MeasuredConditionInput,
  type MonitorAssuranceInput,
  type MonitorAssuranceSubject,
} from "@regulait/shared";
import { canEditAgent, loadVisibleAgent, type Viewer } from "./builder-access.js";
import { connectorOperations } from "./builder-tools.js";
import { resolveGuardrailPolicy } from "./guardrails.js";
import { loadCardsForSubject } from "./mrm.js";

const DAY_MS = 86_400_000;
/** chat providers whose incoming message can start an agent (outlook and email are send-only, ADR-0121) */
const INBOUND_PROVIDERS = ["slack", "teams"] as const;
/** use cases the autonomy floor no longer watches */
const CLOSED_USE_CASE_STATUSES = ["rejected", "retired"] as const;

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

const zeroFacts = (): AutonomyObservedFacts => ({ ...NO_AUTONOMY_FACTS, ...NO_AUTONOMY_OBSERVATION });

/** the facts of each agent, by id (every id gets an entry) */
export async function loadAutonomyFacts(
  db: Db,
  agentRows: ReadonlyArray<Pick<BuilderAgentRow, "id" | "computerUse">>,
  now: Date,
): Promise<Map<string, AutonomyObservedFacts>> {
  const out = new Map<string, AutonomyObservedFacts>(agentRows.map((a) => [a.id, { ...zeroFacts(), computerUse: a.computerUse }]));
  const ids = agentRows.map((a) => a.id);
  if (!ids.length) return out;
  const since = new Date(now.getTime() - AUTONOMY_OBSERVATION_WINDOW_DAYS * DAY_MS);
  const [schedules, subs, tools, channels, threads, steps] = await Promise.all([
    db
      .select({ agentId: builderAgentSchedules.agentId, n: count() })
      .from(builderAgentSchedules)
      .where(and(inArray(builderAgentSchedules.agentId, ids), eq(builderAgentSchedules.enabled, true)))
      .groupBy(builderAgentSchedules.agentId),
    // a sub-agent counts while the child agent is live (an archived child is unlinked and cannot run)
    db
      .select({ agentId: builderAgentSubagents.parentId, n: count() })
      .from(builderAgentSubagents)
      .innerJoin(builderAgents, eq(builderAgentSubagents.childId, builderAgents.id))
      .where(and(inArray(builderAgentSubagents.parentId, ids), isNull(builderAgents.archivedAt)))
      .groupBy(builderAgentSubagents.parentId),
    db
      .select({
        agentId: builderAgentTools.agentId,
        kind: builderAgentTools.kind,
        requiresApproval: builderAgentTools.requiresApproval,
        mcpKind: mcpTools.kind,
        mcpId: mcpTools.id,
        connectorId: connectors.id,
        providerKind: connectors.providerKind,
      })
      .from(builderAgentTools)
      .leftJoin(mcpTools, and(eq(builderAgentTools.kind, "mcp_tool"), eq(mcpTools.id, builderAgentTools.refId)))
      .leftJoin(connectors, and(eq(builderAgentTools.kind, "connector"), eq(connectors.id, builderAgentTools.refId)))
      .where(inArray(builderAgentTools.agentId, ids)),
    db
      .select({ agentId: builderAgentChannels.agentId, n: count() })
      .from(builderAgentChannels)
      .where(
        and(
          inArray(builderAgentChannels.agentId, ids),
          inArray(builderAgentChannels.provider, [...INBOUND_PROVIDERS]),
          isNotNull(builderAgentChannels.chatopsConnectionId),
        ),
      )
      .groupBy(builderAgentChannels.agentId),
    db
      .select({ agentId: builderThreads.agentId, n: count() })
      .from(builderThreads)
      .where(and(inArray(builderThreads.agentId, ids), ne(builderThreads.source, "chat"), gte(builderThreads.updatedAt, since)))
      .groupBy(builderThreads.agentId),
    db
      .select({
        agentId: builderToolSteps.agentId,
        calls: count(),
        // a write that finished with no confirmation and no approval: an MCP
        // tool of kind write, or a connector call that was not a read (an
        // unreadable preview counts as a write: never under-count)
        unconfirmedWrites: sql<number>`count(*) filter (where ${builderToolSteps.status} = 'done'
          and ${builderToolSteps.requiresConfirmation} = false
          and ${builderToolSteps.approvalId} is null
          and ${builderToolSteps.decidedByUserId} is null
          and ((${builderToolSteps.kind} = 'mcp_tool' and ${mcpTools.kind} = 'write')
            or (${builderToolSteps.kind} = 'connector' and coalesce(${builderToolSteps.arguments} ->> 'operation', 'write') <> 'read')))`,
      })
      .from(builderToolSteps)
      .leftJoin(mcpTools, and(eq(builderToolSteps.kind, "mcp_tool"), eq(mcpTools.id, builderToolSteps.refId)))
      .where(and(inArray(builderToolSteps.agentId, ids), gte(builderToolSteps.createdAt, since)))
      .groupBy(builderToolSteps.agentId),
  ]);

  const at = (id: string) => out.get(id)!;
  for (const r of schedules) at(r.agentId).schedules = Number(r.n);
  for (const r of subs) at(r.agentId).subAgents = Number(r.n);
  for (const r of channels) at(r.agentId).inboundChannels = Number(r.n);
  for (const r of threads) at(r.agentId).unattendedRuns = Number(r.n);
  for (const r of steps) {
    at(r.agentId).toolCalls = Number(r.calls);
    at(r.agentId).unconfirmedWrites = Number(r.unconfirmedWrites);
  }
  for (const t of tools) {
    // a dangling reference renders as an unavailable tool and cannot run
    const exists = t.kind === "connector" ? !!t.connectorId : !!t.mcpId;
    if (!exists) continue;
    const f = at(t.agentId);
    f.tools += 1;
    const writes = t.kind === "connector" ? connectorOperations(t.providerKind).includes("write") : t.mcpKind === "write";
    if (writes && !t.requiresApproval) f.writeToolsWithoutAskFirst += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Floor evidence
// ---------------------------------------------------------------------------

interface ClassSummaryRow {
  attackClass?: string;
  probes?: number;
  defeated?: number;
}

/** what the floors are checked against, for one agent */
export async function loadFloorEvidence(
  db: Db,
  agent: Pick<BuilderAgentRow, "projectId" | "modelAgentId" | "monthlyLimitUsd">,
  facts: AutonomyObservedFacts,
  now: Date,
): Promise<AutonomyFloorEvidence> {
  const freshnessDays = ASSURANCE_DEFAULTS.requiredTestFreshnessDays;
  const policy = await resolveGuardrailPolicy(db, { projectId: agent.projectId, agentId: agent.modelAgentId });
  const guardrailModes = Object.fromEntries(AUTONOMY_GUARDRAIL_DETECTORS.map((d) => [d, policy.modes[d]])) as AutonomyFloorEvidence["guardrailModes"];

  const agenticTests = Object.fromEntries(
    AUTONOMY_AGENTIC_TEST_CLASSES.map((c) => [c, { runId: null, finishedAt: null, probes: 0, defeated: 0 }]),
  ) as AutonomyFloorEvidence["agenticTests"];
  let modelCardApproved = false;

  if (agent.modelAgentId) {
    const [model] = await db
      .select({ id: agents.id, customProviderId: agents.customProviderId })
      .from(agents)
      .where(eq(agents.id, agent.modelAgentId));
    if (model) {
      const cards = [
        ...(await loadCardsForSubject(db, { agentId: model.id })),
        ...(model.customProviderId ? await loadCardsForSubject(db, { customProviderId: model.customProviderId }) : []),
      ];
      // the dispatch gate's own rule, read as if enforced: is there a live sign-off?
      modelCardApproved = evaluateMrmGate({ enforced: true, cards, now }).allowed;
    }
    // the newest finished run that measured each agentic class, within freshness
    const runs = await db
      .select({ id: redteamRuns.id, finishedAt: redteamRuns.finishedAt, classSummary: redteamRuns.classSummary })
      .from(redteamRuns)
      .where(
        and(
          eq(redteamRuns.agentId, agent.modelAgentId),
          isNotNull(redteamRuns.finishedAt),
          gte(redteamRuns.finishedAt, new Date(now.getTime() - freshnessDays * DAY_MS)),
        ),
      )
      .orderBy(desc(redteamRuns.finishedAt))
      .limit(50);
    for (const c of AUTONOMY_AGENTIC_TEST_CLASSES) {
      for (const run of runs) {
        const row = (run.classSummary as ClassSummaryRow[]).find((x) => x?.attackClass === c);
        if (!row || !(Number(row.probes) > 0)) continue;
        agenticTests[c] = {
          runId: run.id,
          finishedAt: run.finishedAt!.toISOString(),
          probes: Number(row.probes),
          defeated: Number(row.defeated ?? 0),
        };
        break;
      }
    }
  }
  return {
    guardrailModes,
    modelCardApproved,
    agenticTests,
    testFreshnessDays: freshnessDays,
    monthlyLimitUsd: agent.monthlyLimitUsd,
    writeToolsWithoutAskFirst: facts.writeToolsWithoutAskFirst,
  };
}

// ---------------------------------------------------------------------------
// One agent's autonomy
// ---------------------------------------------------------------------------

export interface AgentAutonomy {
  agentId: string;
  agentName: string;
  facts: AutonomyObservedFacts;
  derived: AutonomyClass;
  declared: AutonomyClass | null;
  effective: AutonomyClass;
  declaredBelowObserved: boolean;
  floors: AutonomyFloorCheck[];
  unmet: MeasuredConditionInput[];
}

export async function agentAutonomy(
  db: Db,
  agent: BuilderAgentRow,
  facts: AutonomyObservedFacts,
  now: Date,
): Promise<AgentAutonomy> {
  const derived = deriveAutonomyClass(facts);
  const declared = (agent.declaredAutonomyClass ?? null) as AutonomyClass | null;
  const effective = effectiveAutonomyClass(derived, declared);
  const floors = checkAutonomyFloors(effective, await loadFloorEvidence(db, agent, facts, now));
  return {
    agentId: agent.id,
    agentName: agent.name,
    facts,
    derived,
    declared,
    effective,
    declaredBelowObserved: declaredBelowObserved(declared, derived),
    floors,
    unmet: floors.filter((c) => !c.met).flatMap((c) => floorConditions(c, { id: agent.id, name: agent.name }, effective)),
  };
}

/** live builder agents billing to these projects */
async function agentsInProjects(db: Db, projectIds: string[]): Promise<BuilderAgentRow[]> {
  if (!projectIds.length) return [];
  return db
    .select()
    .from(builderAgents)
    .where(and(inArray(builderAgents.projectId, projectIds), isNull(builderAgents.archivedAt)))
    .orderBy(builderAgents.name, builderAgents.id);
}

// ---------------------------------------------------------------------------
// The use case's floor (the gate's input)
// ---------------------------------------------------------------------------

export interface UseCaseAutonomy extends AutonomyFloorResult {
  facts: AutonomyObservedFacts;
  /** the agent the derived class belongs to (the most autonomous); null = none linked */
  mostAutonomousAgentId: string | null;
  agents: AgentAutonomy[];
  /** the limit, stated */
  scope: "agents linked by project";
  scopeNote: string;
}

/**
 * A use case's autonomy: builder agents count toward it through their shared
 * project. `derived` is the class of the most autonomous agent and `declared`
 * that agent's declaration; `unmet` holds every linked agent's unmet floors.
 */
export async function autonomyFloorFor(
  db: Db,
  useCase: { id: string; projectId: string | null },
  now: Date = new Date(),
): Promise<UseCaseAutonomy> {
  const rows = useCase.projectId ? await agentsInProjects(db, [useCase.projectId]) : [];
  const facts = await loadAutonomyFacts(db, rows, now);
  const each: AgentAutonomy[] = [];
  for (const a of rows) each.push(await agentAutonomy(db, a, facts.get(a.id)!, now));
  let top: AgentAutonomy | null = null;
  for (const a of each) if (!top || autonomyLevel(a.derived) > autonomyLevel(top.derived)) top = a;
  return {
    facts: mergeAutonomyFacts(each.map((a) => a.facts)),
    derived: top?.derived ?? null,
    declared: top?.declared ?? null,
    unmet: each.flatMap((a) => a.unmet),
    mostAutonomousAgentId: top?.agentId ?? null,
    agents: each,
    scope: "agents linked by project",
    scopeNote: AUTONOMY_SCOPE_NOTE,
  };
}
// the shared contract's signature (A3 calls it through this type)
const _autonomyFloorForContract: AutonomyFloorForFn<Db> = autonomyFloorFor;
void _autonomyFloorForContract;

// ---------------------------------------------------------------------------
// The monitor
// ---------------------------------------------------------------------------

/** The monitor's loader for `autonomy_declared_below_observed` (one subject per
 * agent) and `autonomy_floor_unmet` (one per open use case and linked agent). */
export async function autonomyMonitorInput(
  db: Db,
  now: Date,
): Promise<Partial<Record<AssuranceMonitorRuleId, MonitorAssuranceInput>>> {
  const all = await db.select().from(builderAgents).where(isNull(builderAgents.archivedAt)).orderBy(builderAgents.id);
  const facts = await loadAutonomyFacts(db, all, now);

  const below: MonitorAssuranceSubject[] = [];
  for (const a of all) {
    const derived = deriveAutonomyClass(facts.get(a.id)!);
    const declared = (a.declaredAutonomyClass ?? null) as AutonomyClass | null;
    if (!declaredBelowObserved(declared, derived)) continue;
    below.push({
      subjectKey: `builder_agent:${a.id}`,
      title: `Builder agent '${a.name}' is declared ${declared}, observed ${derived}`,
      detail: {
        agentId: a.id,
        agentName: a.name,
        declared,
        observed: derived,
        reasons: autonomyReasons(facts.get(a.id)!).map((r) => r.ruleId),
      },
    });
  }

  const useCases = await db
    .select({ id: aiUseCases.id, name: aiUseCases.name, projectId: aiUseCases.projectId })
    .from(aiUseCases)
    .where(and(isNotNull(aiUseCases.projectId), notInArray(aiUseCases.status, [...CLOSED_USE_CASE_STATUSES])))
    .orderBy(aiUseCases.id);
  const linked = new Set(useCases.map((u) => u.projectId!));
  const byAgent = new Map<string, AgentAutonomy>();
  for (const a of all) {
    if (!a.projectId || !linked.has(a.projectId)) continue;
    byAgent.set(a.id, await agentAutonomy(db, a, facts.get(a.id)!, now));
  }
  const floorUnmet: MonitorAssuranceSubject[] = [];
  for (const u of useCases) {
    for (const a of all) {
      if (a.projectId !== u.projectId) continue;
      const aa = byAgent.get(a.id)!;
      const unmet = aa.floors.filter((c) => !c.met);
      if (!unmet.length) continue;
      floorUnmet.push({
        subjectKey: `use_case:${u.id}>builder_agent:${a.id}`,
        title: `Use case '${u.name}': builder agent '${a.name}' (${aa.effective}) misses ${unmet.length} autonomy floor control(s)`,
        detail: {
          useCaseId: u.id,
          agentId: a.id,
          autonomyClass: aa.effective,
          unmetFloors: unmet.map((c) => c.id),
          scope: "agents linked by project",
        },
      });
    }
  }
  return {
    autonomy_declared_below_observed: { breaches: below },
    autonomy_floor_unmet: { breaches: floorUnmet },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const idParam = z.object({ id: z.string().uuid() });
export const AUTONOMY_DECLARED_RULE_ID = "builder-agent-autonomy-declared";
export const AUTONOMY_READ_RULE_ID = "builder-agent-autonomy-read";

/** owner or admin; 404 when the agent is invisible (ids cannot be probed), 403 when visible but not theirs */
async function stewardAgent(db: Db, req: FastifyRequest, reply: FastifyReply): Promise<{ agent: BuilderAgentRow; viewer: Viewer } | null> {
  const userId = req.authCtx.userId;
  if (!userId) {
    void reply.status(403).send({
      error: "builder_requires_identity",
      detail: "A builder agent runs with the entitlements of the person using it. A token with no user identity has none to lend it.",
    });
    return null;
  }
  const viewer: Viewer = { userId, isAdmin: req.authCtx.isAdmin };
  const { id } = idParam.parse(req.params);
  const agent = await loadVisibleAgent(db, id, viewer);
  if (!agent) {
    void reply.status(404).send({ error: "unknown_builder_agent" });
    return null;
  }
  if (!canEditAgent(agent, viewer)) {
    void reply.status(403).send({
      error: "not_agent_steward",
      detail: "only the agent's owner or an admin can see and declare its autonomy class",
    });
    return null;
  }
  return { agent, viewer };
}

async function autonomyView(db: Db, agent: BuilderAgentRow, now: Date): Promise<BuilderAgentAutonomyView> {
  const facts = (await loadAutonomyFacts(db, [agent], now)).get(agent.id)!;
  const a = await agentAutonomy(db, agent, facts, now);
  const [declarer] = agent.autonomyDeclaredBy
    ? await db.select({ id: users.id, name: users.displayName }).from(users).where(eq(users.id, agent.autonomyDeclaredBy))
    : [];
  const useCases = agent.projectId
    ? await db
        .select({ id: aiUseCases.id, name: aiUseCases.name, status: aiUseCases.status })
        .from(aiUseCases)
        .where(and(eq(aiUseCases.projectId, agent.projectId), notInArray(aiUseCases.status, [...CLOSED_USE_CASE_STATUSES])))
        .orderBy(aiUseCases.name)
    : [];
  return {
    agentId: agent.id,
    observed: { class: a.derived, reasons: autonomyReasons(facts), facts, windowDays: AUTONOMY_OBSERVATION_WINDOW_DAYS },
    declared: a.declared
      ? {
          class: a.declared,
          note: agent.autonomyNote,
          declaredBy: declarer ? { id: declarer.id, name: declarer.name } : null,
          declaredAt: agent.autonomyDeclaredAt!.toISOString(),
        }
      : null,
    effective: a.effective,
    declaredBelowObserved: a.declaredBelowObserved,
    floors: a.floors,
    useCases,
    scope: AUTONOMY_SCOPE_NOTE,
  };
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A8 block):
 *   GET /v1/builder/agents/:id/autonomy  non-admin class; the steward (owner) or an admin, in-handler
 *   PUT /v1/builder/agents/:id/autonomy  non-admin class; the steward (owner) or an admin, in-handler; audited
 */
export function registerAutonomyRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/builder/agents/:id/autonomy", async (req, reply) => {
    const got = await stewardAgent(db, req, reply);
    if (!got) return;
    const { agent, viewer } = got;
    // an admin reading another person's agent reads someone else's content
    if (agent.ownerUserId !== viewer.userId) {
      await db.insert(auditLog).values({
        userId: viewer.userId,
        objectType: "builder_agent",
        objectId: agent.id,
        detail: { ownerUserId: agent.ownerUserId },
        effect: "allow",
        ruleId: AUTONOMY_READ_RULE_ID,
        ruleChain: [],
        reason: `admin read the autonomy class of builder agent '${agent.name}'`,
      });
    }
    return { autonomy: await autonomyView(db, agent, new Date()) };
  });

  app.put("/v1/builder/agents/:id/autonomy", async (req, reply) => {
    const got = await stewardAgent(db, req, reply);
    if (!got) return;
    const { agent, viewer } = got;
    const parsed = declareAutonomySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_autonomy_declaration", detail: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const body = parsed.data;
    const now = new Date();
    const declaring = body.class !== null;
    const [updated] = await db
      .update(builderAgents)
      .set({
        declaredAutonomyClass: body.class,
        autonomyDeclaredBy: declaring ? viewer.userId : null,
        autonomyDeclaredAt: declaring ? now : null,
        autonomyNote: declaring ? body.note! : null,
        updatedAt: now,
      })
      .where(eq(builderAgents.id, agent.id))
      .returning();
    const view = await autonomyView(db, updated!, now);
    await db.insert(auditLog).values({
      userId: viewer.userId,
      objectType: "builder_agent",
      objectId: agent.id,
      detail: {
        from: { class: agent.declaredAutonomyClass ?? null, note: agent.autonomyNote ?? null },
        to: { class: body.class, note: declaring ? body.note! : null },
        observed: view.observed.class,
        declaredBelowObserved: view.declaredBelowObserved,
      },
      effect: "allow",
      ruleId: AUTONOMY_DECLARED_RULE_ID,
      ruleChain: [],
      reason: declaring
        ? `autonomy class of builder agent '${agent.name}' declared ${body.class} (was ${agent.declaredAutonomyClass ?? "undeclared"}; observed ${view.observed.class})`
        : `autonomy declaration of builder agent '${agent.name}' withdrawn (was ${agent.declaredAutonomyClass ?? "undeclared"}; observed ${view.observed.class} applies)`,
    });
    return {
      autonomy: view,
      ...(view.declaredBelowObserved
        ? {
            flag: {
              code: "declared_below_observed",
              detail:
                `declared ${view.declared!.class}, but the agent is set up or seen acting as ${view.observed.class}; ` +
                `the ${view.effective} floor still applies and the monitor reports the gap`,
            },
          }
        : {}),
    };
  });
}
