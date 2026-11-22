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
 *   - ADR-0180 addendum (2026-11-21, lane E51): `autonomyDispatchGate`, run by
 *     the builder agent gate before every turn, resume and scheduled or channel
 *     run, so before the governed core is asked about any model call. A
 *     `delegated` or `autonomous` agent with an unmet floor is refused (403
 *     `autonomy_floor_unmet`, audited) unless an admin relaxed the gate for it
 *     (PUT .../autonomy/enforcement: admin, step-up to relax, audited, the
 *     transitions in AUTONOMY_ENFORCEMENT_MACHINE). An error checking the
 *     floors refuses the run (503 `autonomy_floor_unverifiable`): fail closed.
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
  AUTONOMY_DISPATCH_ERRORS,
  AUTONOMY_DISPATCH_RULE_IDS,
  AUTONOMY_ENFORCEMENT_MACHINE,
  autonomyDispatchVerdict,
  autonomyEnforcementChangeSchema,
  autonomyEnforcementView,
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
import { agentEvidenceHoldRefused, EVIDENCE_HOLD_REFUSED, withAgentEvidenceHold } from "./agent-evidence-hold.js"; // D4 DFX2 (D4G-05): Art. 73(6) evidence hold
import { connectorOperations } from "./builder-tools.js";
import { resolveGuardrailPolicy } from "./guardrails.js";
import { loadCardsForSubject } from "./mrm.js";
import { errMessage } from "./err-serializer.js";
import { requireStepUp } from "./step-up.js";

const DAY_MS = 86_400_000;
/** chat providers whose incoming message can start an agent (outlook and email are send-only, ADR-0121) */
const INBOUND_PROVIDERS = ["slack", "teams"] as const;
/** use cases the autonomy floor no longer watches */
const CLOSED_USE_CASE_STATUSES = ["rejected", "retired"] as const;

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** a Postgres CHECK violation (23514) of `constraint`, raw or wrapped by the
 * driver. Local on purpose: importing risk-tolerance's twin would add an edge
 * to the governance-monitor import cycle. */
const isCheckViolation = (e: unknown, constraint: string): boolean => {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return (err?.code ?? err?.cause?.code) === "23514" && (err?.constraint ?? err?.cause?.constraint) === constraint;
};

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
// Enforcement at dispatch (ADR-0180 addendum, lane E51)
// ---------------------------------------------------------------------------

export interface AutonomyGateRefusal {
  ok: false;
  status: 403 | 503;
  error: (typeof AUTONOMY_DISPATCH_ERRORS)[keyof typeof AUTONOMY_DISPATCH_ERRORS];
  detail: string;
}

/**
 * The oversight gate on a builder agent's run, decided from a FRESH read of the agent (a relaxation or a new
 * tool added mid-conversation counts). Returns null to proceed, or an audited refusal:
 *   - 403 `autonomy_floor_unmet`: the agent is delegated or autonomous and a floor is unmet, with the gate enforced;
 *   - 503 `autonomy_floor_unverifiable`: the floors could not be checked (fail closed).
 * A run allowed only because an admin relaxed the gate is audited as an allow with the unmet floors.
 * Assist and supervised agents are never refused here (their unmet floors stay conditions and monitor findings).
 */
export async function autonomyDispatchGate(
  db: Db,
  agent: Pick<BuilderAgentRow, "id" | "name">,
  userId: string,
  source: string,
): Promise<AutonomyGateRefusal | null> {
  const audit = (effect: "allow" | "deny", ruleId: string, reason: string, detail: Record<string, unknown>) =>
    db.insert(auditLog).values({
      userId,
      objectType: "builder_agent",
      objectId: agent.id,
      detail: { phase: "autonomy-gate", source, ...detail, receiptClass: "decision" },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  let verdict: ReturnType<typeof autonomyDispatchVerdict>;
  let effective: AutonomyClass;
  try {
    const [fresh] = await db.select().from(builderAgents).where(eq(builderAgents.id, agent.id));
    if (!fresh) throw new Error("the builder agent no longer exists");
    const now = new Date();
    const facts = (await loadAutonomyFacts(db, [fresh], now)).get(fresh.id)!;
    const a = await agentAutonomy(db, fresh, facts, now);
    effective = a.effective;
    verdict = autonomyDispatchVerdict({ agentName: fresh.name, effective, floors: a.floors, enforcement: fresh.autonomyEnforcement });
  } catch (err) {
    const detail = `the autonomy floors of builder agent '${agent.name}' could not be checked, so the run is refused`;
    try {
      await audit("deny", AUTONOMY_DISPATCH_RULE_IDS.unverifiable, detail, { error: errMessage(err) });
    } catch {
      // the refusal stands even if its audit row cannot be written
    }
    return { ok: false, status: 503, error: AUTONOMY_DISPATCH_ERRORS.unverifiable, detail };
  }
  if (verdict.kind === "allow") return null;
  const unmetFloors = verdict.unmet.map((f) => f.id);
  if (verdict.kind === "allow_relaxed") {
    await audit(
      "allow",
      AUTONOMY_DISPATCH_RULE_IDS.relaxed,
      `builder agent '${agent.name}' (${effective}) ran with ${unmetFloors.length} autonomy floor control(s) unmet, because an admin relaxed its gate`,
      { autonomyClass: effective, unmetFloors, enforcement: "relaxed" },
    );
    return null;
  }
  await audit("deny", AUTONOMY_DISPATCH_RULE_IDS.blocked, verdict.detail, { autonomyClass: effective, unmetFloors, enforcement: "enforced" });
  return { ok: false, status: 403, error: AUTONOMY_DISPATCH_ERRORS.blocked, detail: verdict.detail };
}

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

async function autonomyView(db: Db, agent: BuilderAgentRow, now: Date, viewer: Viewer): Promise<BuilderAgentAutonomyView> {
  const facts = (await loadAutonomyFacts(db, [agent], now)).get(agent.id)!;
  const a = await agentAutonomy(db, agent, facts, now);
  const userName = async (id: string | null) =>
    id ? (await db.select({ id: users.id, name: users.displayName }).from(users).where(eq(users.id, id)))[0] : undefined;
  const declarer = await userName(agent.autonomyDeclaredBy);
  const relaxer = await userName(agent.autonomyRelaxedBy);
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
    enforcement: autonomyEnforcementView({
      state: agent.autonomyEnforcement,
      effective: a.effective,
      floors: a.floors,
      relaxedBy: relaxer ? { id: relaxer.id, name: relaxer.name } : null,
      relaxedAt: agent.autonomyRelaxedAt,
      reason: agent.autonomyEnforcementReason,
      viewerIsAdmin: viewer.isAdmin,
    }),
  };
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A8 block):
 *   GET /v1/builder/agents/:id/autonomy  non-admin class; the steward (owner) or an admin, in-handler
 *   PUT /v1/builder/agents/:id/autonomy  non-admin class; the steward (owner) or an admin, in-handler; audited
 *   PUT /v1/builder/agents/:id/autonomy/enforcement  ADMIN class (the default gate); relax needs a step-up; audited
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
    return { autonomy: await autonomyView(db, agent, new Date(), viewer) };
  });

  // ADR-0180 addendum (E51): relax or restore the oversight gate. Admin only (the route is not in NON_ADMIN_ROUTES);
  // relaxing loosens a strict default, so it also takes a `settings_relax` step-up bound to this agent. The state
  // change is a guarded UPDATE from the machine's source states, committed with its audit row.
  app.put("/v1/builder/agents/:id/autonomy/enforcement", async (req, reply) => {
    const got = await stewardAgent(db, req, reply);
    if (!got) return;
    const { agent, viewer } = got;
    const parsed = autonomyEnforcementChangeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_autonomy_enforcement_change", detail: parsed.error.issues.map((i) => i.message).join("; ") });
    }
    const { event, reason } = parsed.data;
    const from = agent.autonomyEnforcement;
    if (!AUTONOMY_ENFORCEMENT_MACHINE.can(from, event)) {
      return reply.status(409).send({
        error: "illegal_transition",
        detail: AUTONOMY_ENFORCEMENT_MACHINE.describe(from).transitions.find((t) => t.event === event)!.reason,
        lifecycle: AUTONOMY_ENFORCEMENT_MACHINE.describe(from),
      });
    }
    if (event === "relax") {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { builderAgentId: agent.id, values: { autonomyEnforcement: "relaxed" } } });
      if (!su.ok) return reply;
    }
    const to = AUTONOMY_ENFORCEMENT_MACHINE.next(from, event);
    const now = new Date();
    let view: BuilderAgentAutonomyView | null;
    try {
      view = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(builderAgents)
          .set({
            autonomyEnforcement: to,
            autonomyRelaxedBy: to === "relaxed" ? viewer.userId : null,
            autonomyRelaxedAt: to === "relaxed" ? now : null,
            autonomyEnforcementReason: reason,
            updatedAt: now,
          })
          // a concurrent change matches no row and is reported, never overwritten
          .where(and(eq(builderAgents.id, agent.id), inArray(builderAgents.autonomyEnforcement, [...AUTONOMY_ENFORCEMENT_MACHINE.sourcesOf(event)])))
          .returning();
        if (!updated) return null;
        await tx.insert(auditLog).values({
          userId: viewer.userId,
          objectType: "builder_agent",
          objectId: agent.id,
          // the stored (scrubbed) reason, never the raw request text
          detail: { event, from, to, reason: updated.autonomyEnforcementReason },
          effect: "allow",
          ruleId: AUTONOMY_DISPATCH_RULE_IDS.changed,
          ruleChain: [],
          reason:
            event === "relax"
              ? `admin relaxed the autonomy gate of builder agent '${agent.name}': unmet floors no longer block its runs (each run is audited)`
              : `admin restored the autonomy gate of builder agent '${agent.name}': unmet floors block its delegated or autonomous runs again`,
        });
        return autonomyView(tx as unknown as Db, updated, now, viewer);
      });
    } catch (e) {
      if (isCheckViolation(e, "builder_agents_autonomy_relaxed_ck")) {
        return reply.status(422).send({
          error: "autonomy_reason_too_long",
          detail: "the reason is longer than 2000 characters once credentials in it are redacted; shorten it",
        });
      }
      throw e;
    }
    if (!view) {
      return reply.status(409).send({ error: "autonomy_enforcement_changed", detail: "someone changed this agent's autonomy gate meanwhile; reload and try again" });
    }
    return { autonomy: view };
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
    // D4 DFX2 (D4G-05): the declared autonomy class is part of the agent's
    // configuration under investigation (it decides its oversight floors)
    if (await agentEvidenceHoldRefused(db, req, reply, agent.id, "declared autonomy class")) return reply;
    const now = new Date();
    const declaring = body.class !== null;
    // the declaration and its audit row commit together or not at all
    let view: BuilderAgentAutonomyView;
    try {
      // X15-H01: the hold is re-checked inside the declaration's transaction (this one nests as a savepoint)
      const got = await withAgentEvidenceHold(db, req, reply, agent.id, "declared autonomy class", (db) => db.transaction(async (tx) => {
        const [updated] = await tx
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
        const v = await autonomyView(tx as unknown as Db, updated!, now, viewer);
        await tx.insert(auditLog).values({
          userId: viewer.userId,
          objectType: "builder_agent",
          objectId: agent.id,
          detail: {
            // the stored (scrubbed) note, never the raw request text
            from: { class: agent.declaredAutonomyClass ?? null, note: agent.autonomyNote ?? null },
            to: { class: body.class, note: updated!.autonomyNote ?? null },
            observed: v.observed.class,
            declaredBelowObserved: v.declaredBelowObserved,
          },
          effect: "allow",
          ruleId: AUTONOMY_DECLARED_RULE_ID,
          ruleChain: [],
          reason: declaring
            ? `autonomy class of builder agent '${agent.name}' declared ${body.class} (was ${agent.declaredAutonomyClass ?? "undeclared"}; observed ${v.observed.class})`
            : `autonomy declaration of builder agent '${agent.name}' withdrawn (was ${agent.declaredAutonomyClass ?? "undeclared"}; observed ${v.observed.class} applies)`,
        });
        return v;
      }));
      if (got === EVIDENCE_HOLD_REFUSED) return reply;
      view = got;
    } catch (e) {
      // the credential scrub can lengthen a note past the store's limit
      if (isCheckViolation(e, "builder_agents_autonomy_declared_ck")) {
        return reply.status(422).send({
          error: "autonomy_note_too_long",
          detail: "the note is longer than 2000 characters once credentials in it are redacted; shorten it",
        });
      }
      throw e;
    }
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
