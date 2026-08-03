/**
 * ADR-0056 — THE AI GOVERNANCE COPILOT, the gateway half.
 *
 *   `packages/shared/src/copilot.ts`   the tool vocabulary, the NL -> structured
 *                                      query step, the grounded renderer, the
 *                                      narrator INTERFACE. Pure.
 *   THIS FILE                          the ENTITLEMENT-SCOPED retrieval, the
 *                                      governed dispatch, the guardrail pass
 *                                      over untrusted ledger text, the
 *                                      proposal -> Approvals-Queue writer, the
 *                                      audit rows.
 *
 * THE FIVE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 * ------------------------------------------------
 *  1. THE COPILOT CANNOT READ WHAT ITS INVOKING USER CANNOT. Not by prompting —
 *     at the QUERY BOUNDARY. `resolveCopilotScope` turns the caller into a
 *     concrete project-id list using ADR-0047's own `callerProjectIds`, and
 *     every SELECT below is built with that list in its WHERE clause at
 *     construction time. A post-hoc filter over an aggregate cannot un-aggregate
 *     it, so anything computed org-wide and filtered afterwards has already
 *     leaked. There is no "copilot super-reader" grant and no code path that
 *     could produce one: an identity-less caller (the bootstrap token) is
 *     refused outright, because there would be no entitlement set to inherit.
 *
 *  2. IT IS A TENANT, NOT A SYSTEM COMPONENT. The narration call goes through
 *     `executeGovernedDispatch` — the same function an ordinary user invoke
 *     takes — AFTER the same `evaluateAgent` entitlement check. A user who may
 *     not invoke the narrator agent may not narrate with it either, and the
 *     refusal is the ordinary AgentDecision shape. Its tokens land in
 *     `usage_events` and bill a project; its call is audited. If our own
 *     flagship agent needed an exemption, the kernel would not be fit to sell.
 *
 *  3. IT HAS NO MUTATING TOOLS. Four read tools, enumerated in
 *     `COPILOT_TOOL_SPECS`, all `SELECT`. A proposal is a row in
 *     `copilot_proposals` plus an ordinary `approvals` row; nothing in this
 *     module writes a grant, a role, a rule, a policy or an entitlement. The
 *     approval is decided through the EXISTING decide path, so the change (if
 *     any) is attributed to the approving human.
 *
 *  4. THE AUDIT LOG IS AN INJECTION SURFACE, AND IS TREATED AS ONE. Retrieved
 *     `reason` strings are attacker-influenceable text. They pass through
 *     ADR-0042's guardrails as PHASE INPUT before they reach any model or any
 *     answer, and a `block` withholds the samples rather than forwarding them.
 *     The grounded answer is composed from COUNTS, so a blocked sample costs
 *     the answer nothing but the sample.
 *
 *  5. GENERATION QUALITY IS UNVERIFIED, AND SAYS SO. No model provider is
 *     connected in this build. The retrieval, the planning, the grounding, the
 *     scoping and the proposal path are all real and tested. `ModelBackedNarrator`
 *     follows ADR-0044's judge pattern exactly — interface, model-backed
 *     implementation, test seam — and has never narrated real output. Every
 *     answer carries `modelNarrationVerified: false`.
 */
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agents,
  and,
  approvals,
  auditLog,
  copilotProposals,
  copilotQueries,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  projectMembers,
  sql,
  usageEvents,
  userAgentPolicies,
  users,
  type Db,
} from "@regulait/db";
import {
  COPILOT_DECISION_SUPPORT_NOTICE,
  COPILOT_SCOPE_CAVEAT,
  COPILOT_TOOL_SPECS,
  buildNarrationPrompt,
  buildProposalRecord,
  copilotAskSchema,
  copilotProposalSchema,
  narrationIsGrounded,
  parseNarration,
  planCopilotQuery,
  renderGroundedAnswer,
  type CopilotEvidence,
  type CopilotNarration,
  type CopilotNarrationRequest,
  type CopilotNarrator,
  type CopilotProposalKind,
  type CopilotQueryPlan,
  type CopilotTimeframe,
} from "@regulait/shared";
import { evaluateAgent, type AgentDecision } from "@regulait/policy-kernel";
import { executeGovernedDispatch, type AgentRow } from "./agents-connectors.js";
import { loadAgentRevocations, loadRoleAgentGrants } from "./entitlements.js";
import { resolveGuardrailPolicy, runGuardrails } from "./guardrails.js";
import { callerProjectIds } from "./reporting.js";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** stable rule ids — the strings an operator greps the audit log for */
export const COPILOT_RULE_IDS = {
  asked: "copilot-question-answered",
  refusedNoIdentity: "copilot-refused-no-identity",
  narratorNotEntitled: "copilot-narrator-not-entitled",
  narrationFailed: "copilot-narration-unusable",
  guardrailActed: "copilot-guardrail-acted",
  proposalOpened: "copilot-proposal-opened",
  proposalRefused: "copilot-proposal-refused",
} as const;

// ---------------------------------------------------------------------------
// Scope — the whole security model, resolved once, per request
// ---------------------------------------------------------------------------

export interface CopilotScope {
  /** the EXACT ids every retrieval may touch. `null` = org-wide, and is only
   * ever produced for an admin. */
  projectIds: string[] | null;
  /** the users who are members of those projects, for ledgers with no project
   * column of their own. Null exactly when projectIds is null. */
  memberIds: string[] | null;
  statement: string;
}

export async function resolveCopilotScope(
  db: Db,
  actor: { userId: string | null; isAdmin: boolean },
): Promise<CopilotScope> {
  if (actor.isAdmin) {
    return {
      projectIds: null,
      memberIds: null,
      statement: "admin caller: organization-wide read, including records attributed to no project",
    };
  }
  const ids = await callerProjectIds(db, actor.userId);
  const memberIds = ids.length
    ? (
        await db
          .selectDistinct({ userId: projectMembers.userId })
          .from(projectMembers)
          .where(inArray(projectMembers.projectId, ids))
      ).map((r) => r.userId)
    : [];
  return {
    projectIds: ids,
    memberIds,
    statement: `non-admin caller: narrowed to the ${ids.length} project(s) they are a member of`,
  };
}

/** the scoped id list, or the impossible uuid so an empty allow-list selects
 * NOTHING rather than everything — fail CLOSED */
const safeIds = (ids: string[]) => (ids.length ? ids : [ZERO_UUID]);

function assertUuid(v: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)) {
    throw new Error("non-uuid project id in copilot scope");
  }
  return v;
}

/** `audit_log` carries no project column; attribution rides `detail.projectId`,
 * the key every governed path writes. Built by interpolation, so every id is
 * re-validated as a uuid — a non-uuid here would be an injection primitive. */
function auditScopePredicate(projectIds: string[]) {
  const ids = safeIds(projectIds).map((p) => `'${assertUuid(p)}'`).join(",");
  return sql`${auditLog.detail} ->> 'projectId' = ANY(${sql.raw(`ARRAY[${ids}]::text[]`)})`;
}

// ---------------------------------------------------------------------------
// Timeframes
// ---------------------------------------------------------------------------

export function resolveCopilotTimeframe(
  tf: CopilotTimeframe,
  now: Date,
): { start: Date; end: Date; label: string } {
  const end = new Date(now.getTime());
  const startOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const startOfQuarter = (d: Date) =>
    new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
  switch (tf) {
    case "last_7_days":
      return { start: new Date(end.getTime() - 7 * 86_400_000), end, label: "the last 7 days" };
    case "current_month":
      return { start: startOfMonth(now), end, label: "the current month" };
    case "last_month": {
      const s = startOfMonth(now);
      return {
        start: new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - 1, 1)),
        end: s,
        label: "last month",
      };
    }
    case "current_quarter":
      return { start: startOfQuarter(now), end, label: "the current quarter" };
    case "last_quarter": {
      const s = startOfQuarter(now);
      return {
        start: new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - 3, 1)),
        end: s,
        label: "last quarter",
      };
    }
    default:
      return { start: new Date(end.getTime() - 30 * 86_400_000), end, label: "the last 30 days" };
  }
}

// ---------------------------------------------------------------------------
// RETRIEVAL — four read tools, every WHERE built from the scope
// ---------------------------------------------------------------------------

/** how many raw ledger strings ever leave the database for this feature. Small
 * on purpose: samples are the injection surface, and a bounded sample is a
 * bounded surface. */
const SAMPLE_LIMIT = 5;

export async function retrieveEvidence(
  db: Db,
  plan: CopilotQueryPlan,
  scope: CopilotScope,
  now: Date,
): Promise<CopilotEvidence> {
  const { start, end, label } = resolveCopilotTimeframe(plan.timeframe, now);
  const base: CopilotEvidence = {
    tool: plan.tool,
    timeframe: { label, start: start.toISOString(), end: end.toISOString() },
    scopeProjectIds: scope.projectIds,
    rowsExamined: 0,
    counts: [],
    samples: [],
    leads: [],
  };

  // THE SCOPE PREDICATES. Built once, applied to every query below. Note they
  // are constructed here — not applied to a result set afterwards.
  const auditScope = scope.projectIds === null ? [] : [auditScopePredicate(scope.projectIds)];
  const memberScope =
    scope.memberIds === null ? [] : [inArray(approvals.userId, safeIds(scope.memberIds))];
  const usageScope =
    scope.projectIds === null ? [] : [inArray(usageEvents.projectId, safeIds(scope.projectIds))];

  if (plan.tool === "queryAuditDecisions" || plan.tool === "listAnomalies") {
    const where = and(
      gte(auditLog.at, start),
      lt(auditLog.at, end),
      ...(plan.params.effect ? [eq(auditLog.effect, plan.params.effect)] : []),
      ...(plan.params.objectType
        ? [eq(auditLog.objectType, plan.params.objectType as (typeof auditLog.objectType)["_"]["data"])]
        : []),
      ...auditScope,
    );
    const [total, byEffect, topRules, samples] = await Promise.all([
      db.select({ n: count() }).from(auditLog).where(where),
      db.select({ effect: auditLog.effect, n: count() }).from(auditLog).where(where).groupBy(auditLog.effect),
      db
        .select({ ruleId: auditLog.ruleId, n: count() })
        .from(auditLog)
        .where(and(where, eq(auditLog.effect, "deny")))
        .groupBy(auditLog.ruleId)
        .orderBy(desc(count()))
        .limit(5),
      db
        .select({ ruleId: auditLog.ruleId, reason: auditLog.reason })
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.at))
        .limit(SAMPLE_LIMIT),
    ]);
    base.rowsExamined = total[0]?.n ?? 0;
    base.counts.push({ key: "decisions", label: "governance decisions", value: base.rowsExamined });
    for (const e of byEffect) {
      base.counts.push({ key: `effect.${e.effect}`, label: `decisions with effect '${e.effect}'`, value: e.n });
    }
    for (const r of topRules) {
      base.counts.push({ key: `deny_rule.${r.ruleId}`, label: `denials from rule '${r.ruleId}'`, value: r.n });
    }
    base.samples = samples.map((s) => ({ key: s.ruleId, text: s.reason }));

    if (plan.tool === "listAnomalies") {
      for (const r of topRules) {
        if (r.n >= 3) {
          base.leads.push({
            kind: "deny_burst",
            subject: r.ruleId,
            detail: `rule denied ${r.n} time(s) in ${label} — a misconfigured agent or an entitlement gap`,
            evidenceCount: r.n,
          });
        }
      }
      const fast = await db
        .select({ id: approvals.id, requestedAt: approvals.requestedAt, decidedAt: approvals.decidedAt })
        .from(approvals)
        .where(
          and(
            gte(approvals.requestedAt, start),
            lt(approvals.requestedAt, end),
            inArray(approvals.status, ["approved", "denied"]),
            ...memberScope,
          ),
        );
      const rubber = fast.filter(
        (a) => a.decidedAt && a.decidedAt.getTime() - a.requestedAt.getTime() < 2000,
      );
      if (rubber.length) {
        base.leads.push({
          kind: "instant_decision",
          subject: "approvals decided in under 2 seconds",
          detail: "a decision that fast is unlikely to be a review — a lead for a human, not a finding",
          evidenceCount: rubber.length,
        });
      }
      base.counts.push({ key: "instant_decisions", label: "approvals decided in <2s", value: rubber.length });
    }
    return base;
  }

  if (plan.tool === "listApprovals") {
    const where = and(
      gte(approvals.requestedAt, start),
      lt(approvals.requestedAt, end),
      ...(plan.params.status ? [eq(approvals.status, plan.params.status)] : []),
      ...memberScope,
    );
    const [total, byStatus] = await Promise.all([
      db.select({ n: count() }).from(approvals).where(where),
      db.select({ status: approvals.status, n: count() }).from(approvals).where(where).groupBy(approvals.status),
    ]);
    base.rowsExamined = total[0]?.n ?? 0;
    base.counts.push({ key: "approvals", label: "approvals requested", value: base.rowsExamined });
    for (const s of byStatus) {
      base.counts.push({ key: `status.${s.status}`, label: `approvals in state '${s.status}'`, value: s.n });
    }
    return base;
  }

  // summarizeUsage
  const where = and(gte(usageEvents.at, start), lt(usageEvents.at, end), ...usageScope);
  const [total, grouped] = await Promise.all([
    db.select({ n: count() }).from(usageEvents).where(where),
    db
      .select({
        projectId: usageEvents.projectId,
        costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        n: count(),
      })
      .from(usageEvents)
      .where(where)
      .groupBy(usageEvents.projectId)
      .orderBy(desc(count()))
      .limit(10),
  ]);
  base.rowsExamined = total[0]?.n ?? 0;
  base.counts.push({ key: "calls", label: "measured model/tool calls", value: base.rowsExamined });
  for (const g of grouped) {
    base.counts.push({
      key: `project.${g.projectId ?? "unattributed"}`,
      label: `calls attributed to project ${g.projectId ?? "(none)"}`,
      value: g.n,
    });
  }
  return base;
}

// ---------------------------------------------------------------------------
// The narrator — a governed dispatch, behind ADR-0044's judge pattern
// ---------------------------------------------------------------------------

/**
 * THE MODEL-BACKED NARRATOR. An ordinary governed dispatch of a registry agent,
 * which is what makes it provider-agnostic and what makes its cost visible in
 * pillar 5 rather than hidden in a system component's budget.
 *
 * UNVERIFIED IN THIS BUILD: no provider is connected here, so this class has
 * never narrated real evidence. `buildNarrationPrompt`, `parseNarration` and
 * `narrationIsGrounded` are unit-tested; the model's prose is not.
 */
export class ModelBackedNarrator implements CopilotNarrator {
  readonly id: string;
  constructor(
    private readonly db: Db,
    private readonly dataKey: string | undefined,
    private readonly ctx: {
      agent: AgentRow;
      userId: string;
      projectId: string | null;
    },
  ) {
    this.id = `model:${ctx.agent.name}`;
  }

  async narrate(req: CopilotNarrationRequest): Promise<CopilotNarration> {
    const outcome = await executeGovernedDispatch(this.db, this.dataKey, {
      userId: this.ctx.userId,
      served: this.ctx.agent,
      requestedAgentId: this.ctx.agent.id,
      // no routing counterfactual: the narrator is pinned by the caller
      baseline: null,
      input: buildNarrationPrompt(req),
      maxTokens: 1024,
      projectId: this.ctx.projectId,
      detail: { purpose: "copilot-narration", tool: req.plan.tool },
    });
    if (!outcome.ok) {
      throw new Error(
        `copilot narration dispatch failed: ${outcome.error}${outcome.detail ? ` — ${outcome.detail}` : ""}`,
      );
    }
    const parsed = parseNarration(outcome.result.outputText);
    if (!parsed.ok) throw new Error(`copilot narration unusable: ${parsed.error}`);
    return parsed.narration;
  }
}

/** the entitlement inputs, the SAME `evaluateAgent` path an ordinary invoke
 * takes — the copilot's narrator is not exempt from anything */
async function agentDecision(db: Db, userId: string, agent: AgentRow): Promise<AgentDecision> {
  const [grants, roleGrants, revocations, [policy]] = await Promise.all([
    db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
    loadRoleAgentGrants(db, userId),
    loadAgentRevocations(db, userId),
    db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
  ]);
  let ceilingTier: number | null = null;
  if (policy?.ceilingAgentId) {
    const [ceiling] = await db
      .select({ tier: agents.tier })
      .from(agents)
      .where(eq(agents.id, policy.ceilingAgentId));
    ceilingTier = ceiling?.tier ?? null;
  }
  return evaluateAgent({
    userId,
    agent: {
      id: agent.id,
      name: agent.name,
      tier: agent.tier,
      enabled: agent.enabled,
      modes: agent.modes ?? null,
    },
    mode: "chat",
    agentGrants: grants,
    roleAgentGrants: roleGrants,
    agentRevocations: revocations,
    ceilingTier,
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface CopilotRouteOptions {
  dataKey?: string | undefined;
  /** TEST SEAM, and the future extension point. Absent = a `ModelBackedNarrator`
   * built from the caller's `narratorAgentId`, i.e. the real, governed path. */
  narrator?: CopilotNarrator | null | undefined;
}

export function registerCopilotRoutes(app: FastifyInstance, db: Db, opts: CopilotRouteOptions = {}): void {
  async function audit(
    actor: string | null,
    objectType: "copilot_query" | "copilot_proposal",
    objectId: string | null,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
    effect: "allow" | "deny" = "allow",
  ) {
    await db.insert(auditLog).values({
      userId: actor ?? ZERO_UUID,
      objectType,
      objectId,
      detail,
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  }

  /** the honest inventory of everything this agent can reach */
  app.get("/v1/copilot/tools", async () => ({
    tools: COPILOT_TOOL_SPECS,
    mutatingTools: [],
    note:
      "The copilot has NO MUTATING TOOLS (ADR-0056 §4). Everything it can do is listed above and " +
      "every one of them is a read. Its only route to a change is a PROPOSAL that opens an " +
      "Approvals-Queue item; a named human applies it, under their own identity.",
    scopeCaveat: COPILOT_SCOPE_CAVEAT,
    decisionSupport: COPILOT_DECISION_SUPPORT_NOTICE,
  }));

  /**
   * ASK. Plan -> retrieve (scoped) -> guardrail the untrusted ledger text ->
   * ground -> optionally narrate through the governed dispatch.
   */
  app.post("/v1/copilot/ask", async (req, reply) => {
    const body = copilotAskSchema.parse(req.body ?? {});
    const userId = req.authCtx.userId ?? null;

    // AN IDENTITY-LESS CALLER IS REFUSED. There would be no entitlement set to
    // inherit, and "inherits the caller's entitlements, never exceeds them" is
    // the entire security model. The bootstrap token cannot ask the copilot.
    if (!userId) {
      await audit(
        null,
        "copilot_query",
        null,
        COPILOT_RULE_IDS.refusedNoIdentity,
        "refused a copilot question from an identity-less caller: the copilot answers with the " +
          "INVOKING USER's entitlements, and there is no entitlement set to inherit here",
        { isAdmin: req.authCtx.isAdmin },
        "deny",
      );
      return reply.status(403).send({
        error: "copilot_requires_identity",
        detail:
          "The copilot reads only what its invoking user may read. A token with no user identity has " +
          "no entitlement set to inherit, so it cannot ask.",
      });
    }

    const now = new Date();
    const plan = planCopilotQuery(body.question);
    const scope = await resolveCopilotScope(db, { userId, isAdmin: req.authCtx.isAdmin });
    const evidence = await retrieveEvidence(db, plan, scope, now);

    // ADR-0042 — THE INJECTION SURFACE. Retrieved `reason` strings are text an
    // attacker may have influenced. They are evaluated as PHASE INPUT before
    // they reach a model or an answer; a block WITHHOLDS the samples. The
    // grounded answer is composed from counts, so it survives intact.
    const policy = await resolveGuardrailPolicy(db, { projectId: body.projectId ?? null });
    const sampleText = evidence.samples.map((s) => s.text).join("\n");
    const guard = sampleText ? runGuardrails(policy, "input", sampleText) : null;
    let guardrailAction: string | null = null;
    if (guard && guard.findings.length > 0) {
      guardrailAction = guard.action;
      if (guard.action === "block") {
        evidence.samples = [];
      }
      await audit(
        userId,
        "copilot_query",
        null,
        COPILOT_RULE_IDS.guardrailActed,
        `a guardrail fired on evidence read out of the audit log itself (action '${guard.action}') — ` +
          `the copilot's context IS the governance record, so a crafted log entry is an injection ` +
          `vector and is treated as untrusted input, not as instructions`,
        { action: guard.action, categories: guard.findings.map((f) => f.detector) },
        guard.action === "block" ? "deny" : "allow",
      );
    }

    const grounded = renderGroundedAnswer(plan, evidence, body.question);
    let answerText = grounded.text;
    let generation: "grounded" | "model" = "grounded";
    let narratorAgentId: string | null = null;
    let narrationError: string | null = null;

    if (body.narratorAgentId) {
      const [agent] = await db.select().from(agents).where(eq(agents.id, body.narratorAgentId));
      if (!agent) return reply.status(404).send({ error: "unknown_narrator_agent" });
      // THE SAME ENTITLEMENT CHECK AN ORDINARY INVOKE TAKES. The copilot is a
      // tenant: a user who may not call this agent may not narrate with it.
      const decision = await agentDecision(db, userId, agent as AgentRow);
      if (decision.effect !== "allow") {
        await audit(
          userId,
          "copilot_query",
          null,
          COPILOT_RULE_IDS.narratorNotEntitled,
          `refused a copilot narration: ${decision.reason}. The copilot is a governed tenant, not a ` +
            `privileged system component — it inherits this user's entitlements and never exceeds them`,
          { narratorAgentId: agent.id, accessRuleId: decision.ruleId },
          "deny",
        );
        return reply.status(403).send({ error: "narrator_not_entitled", detail: decision.reason });
      }
      const narrator =
        opts.narrator ??
        new ModelBackedNarrator(db, opts.dataKey, {
          agent: agent as AgentRow,
          userId,
          projectId: body.projectId ?? null,
        });
      try {
        const narration = await narrator.narrate({
          question: body.question,
          plan,
          evidence,
          groundedText: grounded.text,
        });
        const check = narrationIsGrounded(narration, evidence);
        if (!check.ok) throw new Error(check.reason);
        answerText = `${grounded.text}\n\n--- narration ---\n${narration.text}`;
        generation = "model";
        narratorAgentId = agent.id;
      } catch (err) {
        // THE GROUNDED ANSWER STANDS. A narration that failed, or that cited a
        // figure the retrieval never produced, is DISCARDED — never merged in
        // and never allowed to replace the counts.
        narrationError = err instanceof Error ? err.message : String(err);
        await audit(
          userId,
          "copilot_query",
          null,
          COPILOT_RULE_IDS.narrationFailed,
          `a copilot narration was DISCARDED (${narrationError}) — the grounded, count-derived answer ` +
            `stands on its own, because an ungrounded narration is exactly the confidently-wrong ` +
            `failure mode this design refuses to paper over`,
          { narratorAgentId: agent.id },
          "deny",
        );
      }
    }

    const [row] = await db
      .insert(copilotQueries)
      .values({
        userId,
        question: body.question,
        plan: plan as unknown as Record<string, unknown>,
        evidence: evidence as unknown as Record<string, unknown>,
        answer: answerText,
        generation,
        narratorAgentId,
        scopeProjectIds: scope.projectIds,
        projectId: body.projectId ?? null,
        guardrailAction,
      })
      .returning();

    await audit(
      userId,
      "copilot_query",
      row!.id,
      COPILOT_RULE_IDS.asked,
      `copilot answered a governance question using the '${plan.tool}' read tool over ` +
        `${evidence.timeframe.label}, scoped to ` +
        (scope.projectIds === null
          ? "the whole organization (admin caller)"
          : `${scope.projectIds.length} entitled project(s)`) +
        ` — ${evidence.rowsExamined} record(s) examined. Read-only: the copilot has no mutating tools`,
      {
        tool: plan.tool,
        timeframe: plan.timeframe,
        // THE HONEST RECORD OF WHAT IT WAS PERMITTED TO SEE
        scopeProjectIds: scope.projectIds,
        rowsExamined: evidence.rowsExamined,
        generation,
        guardrailAction,
      },
    );

    return reply.status(201).send({
      query: { ...row, evidence: undefined },
      plan,
      answer: { ...grounded, text: answerText, generation },
      evidence,
      scope: { projectIds: scope.projectIds, statement: scope.statement },
      ...(narrationError ? { narrationDiscarded: narrationError } : {}),
      note:
        "The retrieval, scoping and grounding above are real and tested. NO MODEL PROVIDER IS " +
        "CONNECTED IN THIS BUILD, so any narration path is unverified — `modelNarrationVerified` is " +
        "false on every answer.",
    });
  });

  app.get("/v1/copilot/queries", async (req) => {
    const q = z
      .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
      .parse(req.query ?? {});
    // A NON-ADMIN SEES THEIR OWN QUESTIONS ONLY. Someone else's question, with
    // its retrieved evidence attached, is someone else's data.
    const where = req.authCtx.isAdmin
      ? undefined
      : eq(copilotQueries.userId, req.authCtx.userId ?? ZERO_UUID);
    const rows = await db
      .select()
      .from(copilotQueries)
      .where(where)
      .orderBy(desc(copilotQueries.createdAt))
      .limit(q.limit);
    return { queries: rows, decisionSupport: COPILOT_DECISION_SUPPORT_NOTICE };
  });

  /**
   * PROPOSE. The copilot's ONLY route to a change — and it is not a change.
   * This writes a proposal row and an ordinary `approvals` row. It writes no
   * grant, no role, no rule, no policy. Applying the diff is a separate,
   * governed act by the approving human through the existing decide path.
   */
  app.post("/v1/copilot/proposals", async (req, reply) => {
    const body = copilotProposalSchema.parse(req.body);
    const userId = req.authCtx.userId ?? null;
    if (!userId) return reply.status(403).send({ error: "copilot_requires_identity" });

    const [query] = await db.select().from(copilotQueries).where(eq(copilotQueries.id, body.queryId));
    if (!query) return reply.status(404).send({ error: "unknown_copilot_query" });

    // A PROPOSAL MUST REST ON THE PROPOSER'S OWN QUERY. Otherwise a user could
    // launder another user's (wider-scoped) evidence into a proposal of their
    // own — a scope-widening path dressed as a suggestion.
    if (query.userId !== userId && !req.authCtx.isAdmin) {
      await audit(
        userId,
        "copilot_proposal",
        null,
        COPILOT_RULE_IDS.proposalRefused,
        "refused a copilot proposal built on ANOTHER USER'S query: the evidence behind a proposal was " +
          "retrieved under that user's entitlement scope, and reusing it here would launder a wider " +
          "read into this caller's hands",
        { queryId: body.queryId },
        "deny",
      );
      return reply.status(403).send({ error: "proposal_evidence_not_yours" });
    }

    const [approver] = await db.select().from(users).where(eq(users.id, body.approverUserId));
    if (!approver) return reply.status(404).send({ error: "unknown_approver" });

    const record = buildProposalRecord({
      kind: body.kind as CopilotProposalKind,
      title: body.title,
      rationale: body.rationale,
      diff: body.diff as Record<string, unknown>,
      evidence: query.evidence as unknown as CopilotEvidence,
    });

    // THE ONE QUEUE. Not a copilot inbox.
    const [approval] = await db
      .insert(approvals)
      .values({
        userId,
        objectType: "copilot_proposal",
        approverUserId: body.approverUserId,
        status: "pending",
      })
      .returning();

    const [proposal] = await db
      .insert(copilotProposals)
      .values({
        queryId: query.id,
        kind: record.kind,
        title: record.title,
        rationale: record.rationale,
        diff: record.diff,
        evidence: record.evidence,
        approvalId: approval!.id,
        proposedByUserId: userId,
      })
      .returning();

    await audit(
      userId,
      "copilot_proposal",
      proposal!.id,
      COPILOT_RULE_IDS.proposalOpened,
      `copilot proposal '${record.title}' (${record.kind}) opened as an ordinary Approvals-Queue item ` +
        `for a named approver. NOTHING WAS APPLIED: the copilot has no mutating tools, and if this diff ` +
        `is ever applied it will be a governed action attributed to the approver, not to the copilot`,
      { kind: record.kind, approvalId: approval!.id, queryId: query.id },
    );

    return reply.status(201).send({
      proposal,
      approvalId: approval!.id,
      note: record.note,
    });
  });

  app.get("/v1/copilot/proposals", async (req) => {
    const rows = req.authCtx.isAdmin
      ? await db.select().from(copilotProposals).orderBy(desc(copilotProposals.createdAt)).limit(200)
      : await db
          .select()
          .from(copilotProposals)
          .where(eq(copilotProposals.proposedByUserId, req.authCtx.userId ?? ZERO_UUID))
          .orderBy(desc(copilotProposals.createdAt))
          .limit(200);
    return {
      proposals: rows,
      note:
        "A proposal is a diff plus its evidence. Recording one applies nothing — it opens an " +
        "Approvals-Queue item, and applying the diff is a governed act by the approver.",
    };
  });
}
