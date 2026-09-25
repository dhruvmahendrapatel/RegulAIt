/**
 * PILLAR 7 headline — agent-driven task decomposition (EPIC-05,
 * MULTI_AGENT_ORCHESTRATION_SPEC §2/§3). POST /v1/runs/decompose has a LEAD
 * agent draft a task graph from a plain-language goal; it never creates the
 * run. The human reviews/edits the proposal in the New Run editor and submits
 * through the normal POST /v1/runs — §3's "distinct, reviewable step" stays a
 * human gate, exactly like the product's forced Plan-mode-before-build.
 *
 * The lead turn is a NORMAL governed dispatch through the one shared core
 * (policy → budget → dispatch → audit + usage ledger, projectId attribution),
 * marked purpose:"decompose" in every ledger it touches. Suggested agent
 * NAMES are resolved against the caller's OWN entitlements (§5.1 — a lead can
 * suggest, never grant): an unknown or ungranted name falls back to the
 * caller's default agent and the substitution is RECORDED on the node.
 * Unparseable/invalid output gets ONE retry carrying the validation errors,
 * then a 422 with the raw output — never a half-created run.
 */

import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agents,
  auditLog,
  eq,
  mcpServers,
  mcpTools,
  userAgentPolicies,
  type Db,
} from "@regulait/db";
import { agentHaltOf, loadExecutionMode, postureOf } from "./execution-posture.js";
import { evaluateAgent, visibleTools, type AgentDecision, type ToolRef } from "@regulait/policy-kernel";
import { validateGraph } from "@regulait/orchestration-kernel";
import { isModelProviderKind, TASK_DECOMPOSITION_SENTINEL } from "@regulait/model-provider";
import { decomposeGoalSchema, decompositionPlanSchema } from "@regulait/shared";
import {
  agentProviderToken,
  configuredProviders,
  executeGovernedDispatch,
  mockShadowedByLive,
  type AgentRow,
} from "./agents-connectors.js";
import { refuseIfFeatureNotLicensed } from "./licensing.js";
import { loadAgentRevocations, loadEntitlements, loadRoleAgentGrants } from "./entitlements.js";
import { assertProjectAttribution } from "./projects.js";
import { z } from "zod";

/** A server the caller may draw worker tools from, with the tool names they
 * are entitled to on it — the pillar 7 half of the planning roster. */
interface ToolServerInfo {
  id: string;
  name: string;
  tools: string[];
}

/** The caller's entitled MCP servers + tool names, from the manifest inventory
 * (no upstream connect — the same visibleTools filter the proxy uses). A
 * server the caller can see no tools on is dropped: the lead can only assign
 * tools the caller could actually use. */
async function callerToolServers(db: Db, userId: string): Promise<ToolServerInfo[]> {
  const servers = await db.select().from(mcpServers);
  const out: ToolServerInfo[] = [];
  for (const s of servers) {
    const [tools, entitlements] = await Promise.all([
      db.select().from(mcpTools).where(eq(mcpTools.serverId, s.id)),
      loadEntitlements(db, userId, s.id),
    ]);
    const refs: ToolRef[] = tools.map((t) => ({ serverId: t.serverId, name: t.name, kind: t.kind }));
    const names = visibleTools(userId, s.id, refs, entitlements).map((t) => t.name);
    if (names.length > 0) out.push({ id: s.id, name: s.name, tools: names });
  }
  return out;
}

/** the mode worker nodes run in (matching the New Run editor's graphs) — the
 * roster and every name resolution are entitlement-checked under it */
const WORKER_MODE = "execute";
/** the mode the LEAD's own planning turn is checked under */
const LEAD_MODE = "plan";

/** First balanced JSON object in the text, tolerating fenced code blocks and
 * prose around it — string-aware brace matching, not a regex. */
export function extractFirstJsonObject(text: string): unknown | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** The planning system prompt. Line format of the roster is a stable contract
 * with MockModelProvider's planner (name + tier parsed back out), and the
 * sentinel is what flips the mock into planning mode — the whole feature is
 * demoable with zero external keys. */
function planningPrompt(roster: AgentRow[], toolServers: ToolServerInfo[]): string {
  const fmtUsd = (v: number | null) => (v == null ? "?" : `$${v}`);
  const toolLines =
    toolServers.length > 0
      ? [
          "A worker may optionally be given MCP tools to call across turns. Assign tools only when the task genuinely needs live data or an external action; give such a task a small maxTurns (2-4). Available tool servers (assign BY NAME):",
          ...toolServers.map((s) => `- ${s.name}: ${s.tools.join(", ")}`),
        ]
      : [];
  return [
    TASK_DECOMPOSITION_SENTINEL,
    "You are a Team-Lead agent. Decompose the user's goal into a task graph of 3-7 tasks for worker agents.",
    "Parallelize independent tasks: give them the same dependsOn instead of chaining them; sequence only genuine dependencies.",
    "Each task's instruction must be 2-4 sentences and fully self-contained — its worker sees NOTHING except that instruction.",
    "Assign each task to one of the caller's granted agents BY NAME from this roster (prefer cheaper agents for analysis/verification, mid-tier for build work):",
    ...roster.map(
      (a) =>
        `- ${a.name} (tier ${a.tier}, ${fmtUsd(a.costPerMTokIn)} in / ${fmtUsd(a.costPerMTokOut)} out per MTok)`,
    ),
    ...toolLines,
    "You MAY optionally produce a TWO-LEVEL plan: designate one or more tasks as a LEAD, and have other tasks delegate to it by setting their \"leadId\" to the lead task's id. A lead declares \"allowedAgents\" (a SUBSET of the roster names above) and optionally \"allowedTools\" — a CEILING that every worker under it is bound by. A worker under a lead must be assigned an agent from that lead's allowedAgents. Keep it optional: a flat plan with no leadId is equally valid.",
    "A ceiling can only NARROW — never assign a worker an agent or tool outside its lead's allow-list; the gateway will drop anything over-broad and the plan should not rely on it.",
    "You MAY optionally suggest a per-task budget cap in US dollars via \"budgetCapUsd\" (a small positive number, e.g. 0.5) for a task you expect to be cheap — it caps THAT task's spend. It is only a suggestion: the caller's own per-run budget still governs, so a cap can never grant more spend than the caller already has. Omit it when you have no reason to cap a task.",
    "Return ONLY a JSON object of exactly this shape, with no prose around it:",
    '{"name": string, "nodes": [{"id": "kebab-case-slug", "title": string, "instruction": string, "agent": "<roster name>", "dependsOn": ["ids"], "toolServers": ["<server name>"], "maxTurns": number, "leadId": "<lead task id>", "allowedAgents": ["<roster name>"], "allowedTools": ["<tool name>"], "budgetCapUsd": number}]}',
    "toolServers, maxTurns, leadId, allowedAgents, allowedTools, and budgetCapUsd are ALL OPTIONAL — omit them for ordinary flat single-turn tasks.",
  ].join("\n");
}

interface ProposalNode {
  id: string;
  title: string;
  instruction: string;
  ownerAgentId: string;
  agentName: string;
  mode: string;
  dependsOn: string[];
  substituted?: { requestedAgentName: string; reason: "unknown_or_ungranted_agent" };
  /** pillar 7: resolved MCP server ids this worker may draw tools from */
  toolServers?: string[];
  /** pillar 7: server NAMES the lead named that the caller isn't entitled on
   * (dropped from toolServers) — surfaced so the UI can explain the omission */
  droppedToolServers?: string[];
  /** pillar 7: the worker's tool-loop turn cap */
  maxTurns?: number;
  /** §5.1 Team-Lead delegation: the id of the node acting as this task's lead */
  leadNodeId?: string;
  /** §5.1: when this task is a LEAD, the resolved agent ids a worker under it
   * may be owned by — the ceiling, narrowed to the caller's entitlements */
  allowedAgentIds?: string[];
  /** §5.1: when this task is a LEAD, the resolved tool NAMES a worker under it
   * may call — the ceiling, narrowed to the caller's entitled tools */
  allowedToolRefs?: string[];
  /** §5.1: agent NAMES the lead named for its ceiling that the caller isn't
   * granted (dropped from allowedAgentIds) — surfaced for the UI, exactly like
   * a dropped tool server or a substituted owner */
  droppedAllowedAgents?: string[];
  /** §5.1: tool NAMES named for the ceiling the caller isn't entitled to */
  droppedAllowedTools?: string[];
  /** §5.2 (B2): a per-node budget cap in USD the lead suggested for this task —
   * carried into the submittable graph as the node's budgetCapUsd. A suggestion
   * only: the run's per-run budget + transitive ceiling still enforce downstream. */
  budgetCapUsd?: number;
}

type ParseOutcome =
  | { ok: true; name: string; nodes: ProposalNode[] }
  | { ok: false; errors: string[] };

/** model output → validated, entitlement-resolved proposal (or the error list
 * the retry prompt carries). The graph is run through the SAME kernel
 * validation planRun uses, so an accepted proposal is submittable as-is. */
function parseProposal(
  outputText: string,
  refusal: boolean,
  roster: AgentRow[],
  fallbackOwner: AgentRow,
  toolServers: ToolServerInfo[],
): ParseOutcome {
  if (refusal) return { ok: false, errors: ["the lead agent declined the planning request"] };
  const raw = extractFirstJsonObject(outputText);
  if (raw === null) return { ok: false, errors: ["no parseable JSON object found in the reply"] };
  const parsed = decompositionPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join(".") || "plan"}: ${i.message}`),
    };
  }
  const byName = new Map(roster.map((a) => [a.name.toLowerCase(), a]));
  const serverByName = new Map(toolServers.map((s) => [s.name.toLowerCase(), s]));
  // §5.1: the caller's entitled tool NAMES across their reachable servers — the
  // set a lead ceiling of tool names is narrowed to.
  const entitledToolNames = new Map<string, string>();
  for (const s of toolServers) {
    for (const t of s.tools) if (!entitledToolNames.has(t.toLowerCase())) entitledToolNames.set(t.toLowerCase(), t);
  }
  const planIds = new Set(parsed.data.nodes.map((n) => n.id));
  const nodes: ProposalNode[] = parsed.data.nodes.map((n) => {
    const suggested = byName.get(n.agent.toLowerCase());
    const owner = suggested ?? fallbackOwner;
    // §5.1: a lead may SUGGEST tool servers, never grant them — resolve names
    // to ids against the caller's entitled set, dropping any the caller can't
    // reach (recorded, exactly like an ungranted agent suggestion).
    const resolvedServers: string[] = [];
    const droppedServers: string[] = [];
    for (const name of n.toolServers ?? []) {
      const s = serverByName.get(name.toLowerCase());
      if (s) resolvedServers.push(s.id);
      else droppedServers.push(name);
    }
    // §5.1 Team-Lead ceiling: a lead may SUGGEST an agent/tool allow-list for
    // its workers, never grant one — resolve names to ids against the caller's
    // OWN entitlements, DROPPING and recording anything outside them (the exact
    // "suggest, never grant" drop pattern toolServers uses). The ceiling is
    // narrowed to the caller's grants at draft time, then narrows further only.
    const allowedAgentIds: string[] = [];
    const droppedAllowedAgents: string[] = [];
    for (const name of n.allowedAgents ?? []) {
      const a = byName.get(name.toLowerCase());
      if (a && !allowedAgentIds.includes(a.id)) allowedAgentIds.push(a.id);
      else if (!a) droppedAllowedAgents.push(name);
    }
    const allowedToolRefs: string[] = [];
    const droppedAllowedTools: string[] = [];
    for (const name of n.allowedTools ?? []) {
      const t = entitledToolNames.get(name.toLowerCase());
      if (t && !allowedToolRefs.includes(t)) allowedToolRefs.push(t);
      else if (!t) droppedAllowedTools.push(name);
    }
    // a leadId is honoured only when it names another node in this plan.
    const leadNodeId = n.leadId && n.leadId !== n.id && planIds.has(n.leadId) ? n.leadId : undefined;
    return {
      id: n.id,
      title: n.title,
      instruction: n.instruction,
      ownerAgentId: owner.id,
      agentName: owner.name,
      mode: WORKER_MODE,
      dependsOn: n.dependsOn,
      ...(resolvedServers.length > 0 ? { toolServers: resolvedServers } : {}),
      ...(droppedServers.length > 0 ? { droppedToolServers: droppedServers } : {}),
      ...(n.maxTurns ? { maxTurns: n.maxTurns } : {}),
      ...(leadNodeId ? { leadNodeId } : {}),
      ...(allowedAgentIds.length > 0 ? { allowedAgentIds } : {}),
      ...(allowedToolRefs.length > 0 ? { allowedToolRefs } : {}),
      ...(droppedAllowedAgents.length > 0 ? { droppedAllowedAgents } : {}),
      ...(droppedAllowedTools.length > 0 ? { droppedAllowedTools } : {}),
      ...(n.budgetCapUsd ? { budgetCapUsd: n.budgetCapUsd } : {}),
      ...(suggested
        ? {}
        : {
            substituted: {
              requestedAgentName: n.agent,
              reason: "unknown_or_ungranted_agent" as const,
            },
          }),
    };
  });
  // Kernel validation (cycles, dup ids, unknown deps) against the REAL run
  // graph shape — the escalation approver is a placeholder-valid uuid-shaped
  // check only at submit time, so validate with the caller's own id there.
  return { ok: true, name: parsed.data.name, nodes };
}

export function registerDecomposeRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string } = {},
) {
  app.post("/v1/runs/decompose", async (req, reply) => {
    // ADR-0052 §4: this is the flag the ADR names "advanced orchestration
    // fan-out", enforced at its enabling act. Agent-driven decomposition IS
    // the pillar-7 fan-out entry point — a LEAD agent drafting a parallel
    // task graph of worker agents. Hand-authored runs through POST /v1/runs,
    // and every run that already exists (events/dispatch/auto), stay open:
    // basic orchestration is not tier-gated, and an existing run is committed
    // footprint (§5).
    const flagRefusal = await refuseIfFeatureNotLicensed(db, {
      actorUserId: req.authCtx.userId,
      feature: "advanced_orchestration",
      what: "agent-driven task decomposition (orchestration fan-out)",
    });
    if (flagRefusal) return reply.status(flagRefusal.status).send(flagRefusal.body);
    const body = decomposeGoalSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_decompose" });

    // pillar 5 + ADR-0011: attribution must point at a project the caller may
    // bill to — same gate as any invoke.
    if (body.projectId) {
      const attribution = await assertProjectAttribution(db, body.projectId, userId, req.authCtx.isAdmin);
      if (!attribution.ok) {
        return reply.status(attribution.status).send({ error: attribution.error });
      }
    }

    const [grants, roleAgentGrantsForUser, agentRevocationsForUser, [policy], registry] =
      await Promise.all([
        db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
        // §5 role-bundled grants (ADR-0014) — a role-granted agent must be a
        // valid worker in a decomposed plan, not just on the direct invoke path.
        loadRoleAgentGrants(db, userId),
        // ADR-0019 — and a revoked agent must NOT be suggested as a worker: a
        // revocation honoured at invoke but not here would let the same user
        // reach the same agent by asking a lead to delegate to it.
        loadAgentRevocations(db, userId),
        db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
        db.select().from(agents),
      ]);
    let ceilingTier: number | null = null;
    if (policy?.ceilingAgentId) {
      ceilingTier = registry.find((a) => a.id === policy.ceilingAgentId)?.tier ?? null;
    }
    const decomposeExecutionMode = await loadExecutionMode(db);
    const evalFor = (a: AgentRow, mode: string): AgentDecision =>
      evaluateAgent({
        userId,
        // ADR-0124 — decomposition dispatches a lead agent to draft the graph,
        // so it is execution and is gated.
        execution: postureOf(decomposeExecutionMode, agentHaltOf(a)),
        agent: { id: a.id, name: a.name, tier: a.tier, enabled: a.enabled, modes: a.modes ?? null },
        mode,
        agentGrants: grants,
        roleAgentGrants: roleAgentGrantsForUser,
        agentRevocations: agentRevocationsForUser,
        ceilingTier,
      });

    // §5.1: the roster the lead may assign from is exactly the set of agents
    // the CALLER could own worker nodes with — suggestions are grounded in the
    // caller's entitlements, and resolution below can never widen them. It is
    // ALSO filtered to dispatchable agents (model id, known provider, stored
    // credential), the same filter the invoke path and the budget re-plan
    // apply: a plan whose workers cannot dispatch is a bad plan by
    // construction. The human can still reassign to any granted agent in the
    // editor before planning.
    const configured = await configuredProviders(db, opts.dataKey, userId);
    const entitledDispatchable = registry.filter(
      (a) =>
        a.enabled &&
        a.model &&
        isModelProviderKind(a.provider) &&
        configured.has(agentProviderToken(a)) &&
        evalFor(a, WORKER_MODE).effect === "allow",
    );
    // B6a (ADR-0095's own recorded residual, now closed): the WORKER roster
    // obeys the same `mockShadowedByLive` predicate the invoke path's routing
    // roster obeys. A mock worker in a plan is a node that will answer with
    // canned prose; a mock LEAD writes the plan itself, so the whole task
    // graph is nonsense — quieter than the routing defect the owner hit, and
    // the same disease. Nothing is shadowed unless a live worker-entitled
    // agent can genuinely serve, so the keyless demo (roster is all mocks) is
    // byte-identical: `shadowedMocks` is empty and `roster === entitledDispatchable`.
    const shadowedMocks = mockShadowedByLive(entitledDispatchable, () => true);
    const roster = entitledDispatchable.filter((a) => !shadowedMocks.has(a.id));
    const skippedCandidates = entitledDispatchable
      .filter((a) => shadowedMocks.has(a.id))
      .map((a) => ({ agentId: a.id, name: a.name, reason: "mock_shadowed_by_live" as const }));

    const cheapest = (pool: readonly AgentRow[]) =>
      [...pool].sort(
        (a, b) =>
          (a.costPerMTokOut ?? Infinity) - (b.costPerMTokOut ?? Infinity) || a.tier - b.tier,
      )[0];
    // Lead = explicit pick ?? the caller's default agent ?? cheapest granted
    // mock (always dispatchable with zero external keys).
    //
    // B6a: when mocks are shadowed the implicit fallback becomes the cheapest
    // agent of the SURVIVING (all-live) roster under the identical sort,
    // rather than the mock it used to be. Two facts make that surgical: the
    // narrowed roster is all-mock or all-live and never both (a dispatchable
    // live member is exactly what triggers shadowing), so with nothing
    // shadowed this expression IS the old `cheapestMock`; and an EXPLICIT lead
    // (`body.leadAgentId`) is resolved from the full registry below and is
    // therefore never shadowed — an explicit choice is not routing.
    const implicitLead = shadowedMocks.size
      ? cheapest(roster)
      : cheapest(roster.filter((a) => a.provider === "mock"));
    const leadId = body.leadAgentId ?? policy?.defaultAgentId ?? implicitLead?.id ?? null;
    const lead = leadId ? registry.find((a) => a.id === leadId) : undefined;
    if (body.leadAgentId && !lead) return reply.status(404).send({ error: "unknown_agent" });
    if (!lead) {
      return reply.status(422).send({
        error: "no_lead_agent",
        detail: "no leadAgentId given, no default agent set, and no mock agent granted",
      });
    }

    // The lead itself passes the same entitlement path as any invoke — the
    // denial is the normal 403 decision shape, audited like invoke's.
    const decision = evalFor(lead, LEAD_MODE);
    if (decision.effect !== "allow") {
      await db.insert(auditLog).values({
        userId,
        objectType: "agent",
        objectId: lead.id,
        detail: { purpose: "decompose", phase: "lead-entitlement", mode: LEAD_MODE },
        effect: "deny",
        ruleId: decision.ruleId,
        ruleChain: decision.ruleChain,
        reason: decision.reason,
      });
      return reply.status(403).send({ decision });
    }

    // Substitution fallback: the caller's default agent when it is in the
    // roster, else the lead itself (if entitled as a worker), else the
    // cheapest roster agent — always inside the caller's entitlements.
    const fallbackOwner =
      roster.find((a) => a.id === policy?.defaultAgentId) ??
      roster.find((a) => a.id === lead.id) ??
      implicitLead ??
      roster[0];
    if (!fallbackOwner) {
      return reply.status(422).send({
        error: "no_worker_agents",
        detail: `no granted agents are usable in mode '${WORKER_MODE}' to own worker nodes`,
      });
    }

    // pillar 7: the tool servers the caller could assign to workers, listed in
    // the planning prompt alongside the agent roster
    const toolServerInfo = await callerToolServers(db, userId);
    const system = planningPrompt(roster, toolServerInfo);
    const totals = { costUsd: 0 as number, costKnown: true, tokensIn: 0, tokensOut: 0 };
    const attempt = async (retryErrors: string[] | null) =>
      executeGovernedDispatch(db, opts.dataKey, {
        userId,
        served: lead,
        requestedAgentId: lead.id,
        baseline: null,
        input: body.goal,
        system: retryErrors
          ? `${system}\n\nYour previous plan failed validation: ${retryErrors.join("; ")}. Return ONLY the corrected JSON object.`
          : system,
        maxTokens: 2048,
        projectId: body.projectId ?? null,
        detail: { purpose: "decompose", ...(retryErrors ? { retry: true } : {}) },
      });
    const absorb = (r: { costUsd: number | null; usage: { inputTokens: number; outputTokens: number } }) => {
      if (r.costUsd == null) totals.costKnown = false;
      else totals.costUsd = Number((totals.costUsd + r.costUsd).toFixed(6));
      totals.tokensIn += r.usage.inputTokens;
      totals.tokensOut += r.usage.outputTokens;
    };

    // First attempt — a failed dispatch (project budget gate, credential,
    // provider error) surfaces exactly as the invoke path would surface it.
    const first = await attempt(null);
    if (!first.ok) {
      return reply
        .status(first.status)
        .send({ error: first.error, ...(first.detail ? { detail: first.detail } : {}) });
    }
    absorb(first.result);
    let parsed = parseProposal(first.result.outputText, first.result.refusal, roster, fallbackOwner, toolServerInfo);

    // Kernel graph validation folds into the same retry loop as schema errors.
    const kernelErrors = (nodes: ProposalNode[], name: string): string[] => {
      try {
        validateGraph({
          run: name,
          escalationApproverUserId: userId,
          nodes: nodes.map((n) => ({
            id: n.id,
            title: n.title,
            ownerAgentId: n.ownerAgentId,
            mode: n.mode,
            dependsOn: n.dependsOn,
            ...(n.leadNodeId ? { leadNodeId: n.leadNodeId } : {}),
            ...(n.allowedAgentIds ? { allowedAgentIds: n.allowedAgentIds } : {}),
            ...(n.allowedToolRefs ? { allowedToolRefs: n.allowedToolRefs } : {}),
            ...(n.budgetCapUsd ? { budgetCapUsd: n.budgetCapUsd } : {}),
          })),
        });
        return [];
      } catch (err) {
        if (err instanceof z.ZodError) return err.issues.map((i) => i.message);
        throw err;
      }
    };
    let graphErrors = parsed.ok ? kernelErrors(parsed.nodes, parsed.name) : [];
    let retried = false;
    let rawOutput = first.result.outputText;
    if (!parsed.ok || graphErrors.length > 0) {
      const errors = parsed.ok ? graphErrors : parsed.errors;
      retried = true;
      const second = await attempt(errors);
      if (!second.ok) {
        return reply
          .status(second.status)
          .send({ error: second.error, ...(second.detail ? { detail: second.detail } : {}) });
      }
      absorb(second.result);
      rawOutput = second.result.outputText;
      parsed = parseProposal(second.result.outputText, second.result.refusal, roster, fallbackOwner, toolServerInfo);
      graphErrors = parsed.ok ? kernelErrors(parsed.nodes, parsed.name) : [];
      if (!parsed.ok || graphErrors.length > 0) {
        const detail = (parsed.ok ? graphErrors : parsed.errors).join("; ");
        await db.insert(auditLog).values({
          userId,
          objectType: "run",
          objectId: null,
          detail: { purpose: "decompose", phase: "invalid-plan", leadAgentId: lead.id, retried: true },
          effect: "allow",
          ruleId: "run-decompose-invalid",
          ruleChain: [],
          reason: `lead agent '${lead.name}' produced an invalid plan twice; nothing was created`,
        });
        return reply.status(422).send({ error: "decomposition_invalid", detail, rawOutput });
      }
    }

    const substitutions = parsed.nodes
      .filter((n) => n.substituted)
      .map((n) => ({ nodeId: n.id, requestedAgentName: n.substituted!.requestedAgentName, ownerAgentId: n.ownerAgentId }));
    await db.insert(auditLog).values({
      userId,
      objectType: "run",
      objectId: null,
      detail: {
        purpose: "decompose",
        phase: "proposal",
        leadAgentId: lead.id,
        servedAgentId: first.result.servedAgentId,
        nodes: parsed.nodes.length,
        retried,
        costUsd: totals.costKnown ? totals.costUsd : null,
        ...(substitutions.length > 0 ? { substitutions } : {}),
        // B6a: a worker candidate that was NOT offered to the lead is as
        // explainable as one that was — same reason string as routing's.
        ...(skippedCandidates.length > 0 ? { skippedCandidates } : {}),
      },
      effect: "allow",
      ruleId: "run-decomposed",
      ruleChain: [],
      reason: `goal decomposed into ${parsed.nodes.length} proposed tasks by lead agent '${lead.name}'; nothing runs until the caller plans the run`,
    });

    return {
      proposal: { name: parsed.name, nodes: parsed.nodes },
      dispatch: {
        costUsd: totals.costKnown ? totals.costUsd : null,
        modelUsed: first.result.model,
        servedAgentId: first.result.servedAgentId,
        tokens: { inputTokens: totals.tokensIn, outputTokens: totals.tokensOut },
      },
      retried,
      ...(skippedCandidates.length > 0 ? { skippedCandidates } : {}),
    };
  });
}
