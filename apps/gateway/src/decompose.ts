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
import { agentGrants, agents, auditLog, eq, userAgentPolicies, type Db } from "@regulait/db";
import { evaluateAgent, type AgentDecision } from "@regulait/policy-kernel";
import { validateGraph } from "@regulait/orchestration-kernel";
import { isModelProviderKind, TASK_DECOMPOSITION_SENTINEL } from "@regulait/model-provider";
import { decomposeGoalSchema, decompositionPlanSchema } from "@regulait/shared";
import { configuredProviders, executeGovernedDispatch, type AgentRow } from "./agents-connectors.js";
import { assertProjectAttribution } from "./projects.js";
import { z } from "zod";

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
function planningPrompt(roster: AgentRow[]): string {
  const fmtUsd = (v: number | null) => (v == null ? "?" : `$${v}`);
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
    "Return ONLY a JSON object of exactly this shape, with no prose around it:",
    '{"name": string, "nodes": [{"id": "kebab-case-slug", "title": string, "instruction": string, "agent": "<roster name>", "dependsOn": ["ids"]}]}',
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
  const nodes: ProposalNode[] = parsed.data.nodes.map((n) => {
    const suggested = byName.get(n.agent.toLowerCase());
    const owner = suggested ?? fallbackOwner;
    return {
      id: n.id,
      title: n.title,
      instruction: n.instruction,
      ownerAgentId: owner.id,
      agentName: owner.name,
      mode: WORKER_MODE,
      dependsOn: n.dependsOn,
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

    const [grants, [policy], registry] = await Promise.all([
      db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
      db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
      db.select().from(agents),
    ]);
    let ceilingTier: number | null = null;
    if (policy?.ceilingAgentId) {
      ceilingTier = registry.find((a) => a.id === policy.ceilingAgentId)?.tier ?? null;
    }
    const evalFor = (a: AgentRow, mode: string): AgentDecision =>
      evaluateAgent({
        userId,
        agent: { id: a.id, name: a.name, tier: a.tier, enabled: a.enabled, modes: a.modes ?? null },
        mode,
        agentGrants: grants,
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
    const roster = registry.filter(
      (a) =>
        a.enabled &&
        a.model &&
        isModelProviderKind(a.provider) &&
        configured.has(a.provider) &&
        evalFor(a, WORKER_MODE).effect === "allow",
    );

    // Lead = explicit pick ?? the caller's default agent ?? cheapest granted
    // mock (always dispatchable with zero external keys).
    const cheapestMock = roster
      .filter((a) => a.provider === "mock")
      .sort(
        (a, b) =>
          (a.costPerMTokOut ?? Infinity) - (b.costPerMTokOut ?? Infinity) || a.tier - b.tier,
      )[0];
    const leadId = body.leadAgentId ?? policy?.defaultAgentId ?? cheapestMock?.id ?? null;
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
      cheapestMock ??
      roster[0];
    if (!fallbackOwner) {
      return reply.status(422).send({
        error: "no_worker_agents",
        detail: `no granted agents are usable in mode '${WORKER_MODE}' to own worker nodes`,
      });
    }

    const system = planningPrompt(roster);
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
    let parsed = parseProposal(first.result.outputText, first.result.refusal, roster, fallbackOwner);

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
      parsed = parseProposal(second.result.outputText, second.result.refusal, roster, fallbackOwner);
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
    };
  });
}
