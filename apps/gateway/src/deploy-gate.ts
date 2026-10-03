/**
 * ADR-0161 — `POST /v1/gates/deploy`: the CI/CD deploy gate.
 *
 * Gathers governance state the platform already keeps — the use case and its
 * approved stack, each agent's availability, the ADR-0045 MRM dispatch gate
 * (called, not re-implemented), and active ADR-0157 monitor alerts on the use
 * case or its agents — and hands it to the pure `evaluateDeployGate`. Every
 * evaluation is audited (`deploy-gate-allowed` / `deploy-gate-denied`) with
 * the pipeline's `ref` and `environment`, so "what did the gate say about
 * build 4417?" has an answer.
 *
 * Callable by an admin or by the use case's OWNER (a pipeline runs as a
 * service account that owns the use cases it ships). Always 200 with a
 * decision on a known use case — the pipeline acts on `decision`.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  eq,
  gt,
  inArray,
  isNull,
  modelCardApprovals,
  modelCards,
  ne,
  or,
  governanceAlerts,
  type Db,
} from "@regulait/db";
import { evaluateDeployGate, evaluateMrmGate, type DeployGateAgentInput } from "@regulait/shared";
import { loadCardsForSubject } from "./mrm.js";
import { loadOrgSettings } from "./org-settings.js";

export const DEPLOY_GATE_RULE_IDS = { allowed: "deploy-gate-allowed", denied: "deploy-gate-denied" } as const;

const body = z
  .object({
    useCaseId: z.string().uuid(),
    /**
     * the agents this release ships. AER-044: a selection never narrows what
     * the gate checks — the whole approved stack is always evaluated, so an
     * omitted list, `[]` and a subset all check every intended agent (a halt or
     * MRM refusal on any of them blocks); an agent outside the stack blocks.
     */
    agentIds: z.array(z.string().uuid()).max(50).optional(),
    /** free text from the pipeline, e.g. "staging", "eu-west" — recorded, never interpreted */
    environment: z.string().trim().min(1).max(64).optional(),
    /** build / commit / release identifier — recorded for the audit trail */
    ref: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export function registerDeployGateRoutes(app: FastifyInstance, db: Db): void {
  app.post("/v1/gates/deploy", async (req, reply) => {
    const b = body.parse(req.body);
    const callerId = req.authCtx.userId ?? null;
    const [uc] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, b.useCaseId));
    if (!uc) return reply.status(404).send({ error: "unknown_use_case" });
    if (!req.authCtx.isAdmin && callerId !== uc.ownerUserId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "the deploy gate answers for a use case's owner (e.g. its pipeline's service account) or an admin",
      });
    }
    const now = new Date();
    const intended = (uc.intendedAgentIds ?? []) as string[];
    // AER-044: the approved stack plus any requested extras (the same union the
    // evaluator checks) — `[]` and a subset cannot drop an intended agent.
    const checkIds = [...new Set([...intended, ...(b.agentIds ?? [])])];

    const agentRows = checkIds.length
      ? await db.select().from(agents).where(inArray(agents.id, checkIds))
      : [];
    const approved = checkIds.length
      ? await db
          .selectDistinct({ agentId: modelCards.agentId })
          .from(modelCardApprovals)
          .innerJoin(modelCards, eq(modelCards.id, modelCardApprovals.cardId))
          .where(
            and(
              inArray(modelCards.agentId, checkIds),
              eq(modelCardApprovals.status, "approved"),
              or(isNull(modelCardApprovals.validUntil), gt(modelCardApprovals.validUntil, now)),
            ),
          )
      : [];
    const approvedSet = new Set(approved.map((a) => a.agentId));
    const agentMap = new Map<string, DeployGateAgentInput>();
    // The MRM gate's DECISION, evaluated with the same card loading as the
    // dispatch gate but without its dispatch-phase side effects (the
    // staleness-recertification audit row is a dispatch event, not a pipeline
    // check — that deepening still applies at runtime).
    const org = await loadOrgSettings(db);
    for (const a of agentRows) {
      let refusal: { detail: string } | null = null;
      if (org.mrmEnforced) {
        const cards = [
          ...(await loadCardsForSubject(db, { agentId: a.id, customProviderId: null })),
          ...(a.customProviderId ? await loadCardsForSubject(db, { customProviderId: a.customProviderId }) : []),
        ];
        const d = evaluateMrmGate({ enforced: true, cards, now });
        if (!d.allowed) refusal = { detail: d.detail };
      }
      agentMap.set(a.id, {
        id: a.id,
        name: a.name,
        halted: a.haltedAt !== null,
        enabled: a.enabled,
        lifecycleStatus: a.lifecycleStatus,
        mrmRefusal: refusal ? refusal.detail : null,
        modelCardApproved: approvedSet.has(a.id),
      });
    }

    // active alerts whose subject is this use case, or one of the checked
    // agents under it (pair keys) or on its own
    const alertRows = await db
      .select({
        id: governanceAlerts.id,
        ruleId: governanceAlerts.ruleId,
        severity: governanceAlerts.severity,
        status: governanceAlerts.status,
        title: governanceAlerts.title,
        subjectKey: governanceAlerts.subjectKey,
      })
      .from(governanceAlerts)
      .where(ne(governanceAlerts.status, "resolved"));
    const ucKey = `use_case:${uc.id}`;
    const agentKeys = new Set(checkIds.map((id) => `agent:${id}`));
    const alerts = alertRows.filter((a) => {
      const parts = a.subjectKey.split(">");
      if (parts[0] === ucKey) return true;
      return parts.length === 1 && agentKeys.has(parts[0]!);
    });

    const result = evaluateDeployGate({
      useCase: { id: uc.id, name: uc.name, status: uc.status, intendedAgentIds: intended },
      requestedAgentIds: b.agentIds ?? null,
      agents: agentMap,
      alerts,
    });

    await db.insert(auditLog).values({
      userId: callerId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "deploy_gate",
      objectId: uc.id,
      detail: {
        decision: result.decision,
        environment: b.environment ?? null,
        ref: b.ref ?? null,
        agents: result.agentsChecked,
        requestedAgents: b.agentIds ?? null,
        reasons: result.reasons.map((r) => ({ code: r.code, severity: r.severity, ref: r.ref ?? null })),
      },
      effect: result.decision === "allow" ? "allow" : "deny",
      ruleId: result.decision === "allow" ? DEPLOY_GATE_RULE_IDS.allowed : DEPLOY_GATE_RULE_IDS.denied,
      ruleChain: [],
      reason:
        `deploy gate ${result.decision === "allow" ? "allowed" : "denied"} use case '${uc.name}'` +
        `${b.environment ? ` for ${b.environment}` : ""}${b.ref ? ` (${b.ref})` : ""}: ` +
        `${result.reasons.filter((r) => r.severity === "block").length} blocking, ` +
        `${result.reasons.filter((r) => r.severity === "warn").length} warning`,
    });

    return {
      decision: result.decision,
      useCase: { id: uc.id, name: uc.name, status: uc.status, euAiActTier: uc.euAiActTier },
      agentsChecked: result.agentsChecked,
      agentsRequested: b.agentIds ?? null,
      reasons: result.reasons,
      environment: b.environment ?? null,
      ref: b.ref ?? null,
      evaluatedAt: now.toISOString(),
      note:
        "The pipeline enforces `decision`; a warning does not fail the gate. Dispatch enforcement (MRM incl. " +
        "staleness recertification, halts, entitlements) is unchanged and still applies at runtime.",
    };
  });
}
