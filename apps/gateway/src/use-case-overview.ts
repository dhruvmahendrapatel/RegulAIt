/**
 * Demo task C3 — THE USE-CASE 360. One read that assembles what the platform
 * already records about one AI use case, so the record page does not need six
 * round trips and the reviewer sees the whole system in one place.
 *
 * Presentation over existing ledgers only — no new storage, nothing computed
 * that another route could disagree with:
 *  - the use case, its owner, its EU AI Act screening and questionnaire state;
 *  - the STACK: the intended agents, their model cards with sign-off state
 *    (MRM, ADR-0063), and the AI vendors linked to those agents' providers
 *    (ADR-0084) or named by this use case's risks;
 *  - the RISKS registered against it, with declared inherent and residual
 *    positions and linked controls (ADR-0147);
 *  - APPROVALS raised on its intake workflow instance, and the last 20 audit
 *    rows about it.
 *
 * Frameworks are deliberately NOT duplicated here: `GET
 * /v1/use-cases/:id/frameworks` owns that computation (ADR-0123) and the page
 * calls it — two copies of a compliance mapping would drift.
 *
 * Visibility: the owner, admins and the intake sign-off's reviewer (ADR-0168),
 * exactly the detail route's rule (`canReadUseCase`).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  aiRisks,
  aiUseCases,
  aiVendors,
  approvals,
  auditLog,
  and,
  desc,
  eq,
  inArray,
  users,
  workflowArtifacts,
  type Db,
} from "@regulait/db";
import { RISK_CATEGORY_DIMENSION, type AiRiskCategory } from "@regulait/shared";
import { loadCardsForSubject } from "./mrm.js";
import { loadRiskControls } from "./risks.js";
import { canReadUseCase, USE_CASE_QUESTIONNAIRE_OUTPUT } from "./use-cases.js";

const params = z.object({ useCaseId: z.string().uuid() });

export function registerUseCaseOverviewRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/use-cases/:useCaseId/overview", async (req, reply) => {
    const { useCaseId } = params.parse(req.params);
    const [useCase] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
    if (!useCase) return reply.status(404).send({ error: "not_found" });
    // ADR-0168: + the reviewer of its intake sign-off (read-only)
    if (!(await canReadUseCase(db, useCase, req.authCtx))) {
      return reply.status(403).send({ error: "forbidden", detail: "a use case is visible to its owner and to admins" });
    }
    const now = new Date();

    const [owner] = await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, useCase.ownerUserId));

    // --- questionnaire state ---------------------------------------------------
    const [artifact] = useCase.workflowInstanceId
      ? await db
          .select({ id: workflowArtifacts.id, version: workflowArtifacts.version, createdAt: workflowArtifacts.createdAt })
          .from(workflowArtifacts)
          .where(
            and(
              eq(workflowArtifacts.instanceId, useCase.workflowInstanceId),
              eq(workflowArtifacts.output, USE_CASE_QUESTIONNAIRE_OUTPUT),
            ),
          )
          .orderBy(desc(workflowArtifacts.version))
          .limit(1)
      : [];

    // --- stack: agents, model cards, vendors -------------------------------------
    const agentIds = (useCase.intendedAgentIds ?? []).filter(Boolean);
    const agentRows = agentIds.length ? await db.select().from(agents).where(inArray(agents.id, agentIds)) : [];
    const stackAgents = [];
    for (const a of agentRows) {
      const cards = await loadCardsForSubject(db, { agentId: a.id });
      const live = cards.some((c) =>
        c.approvals.some((ap) => ap.status === "approved" && (!ap.validUntil || new Date(ap.validUntil) > now)),
      );
      stackAgents.push({
        id: a.id,
        name: a.name,
        provider: a.provider,
        model: a.model,
        lifecycleStatus: a.lifecycleStatus,
        halted: a.haltedAt !== null,
        modelCards: cards.map((c) => ({
          id: c.id,
          intendedUse: c.intendedUse,
          signOff: c.approvals[0]?.status ?? "none",
        })),
        /** true when at least one card holds an unexpired approval — the MRM gate's own test */
        modelCardApproved: live,
      });
    }

    const risks = await db
      .select()
      .from(aiRisks)
      .where(eq(aiRisks.useCaseId, useCaseId))
      .orderBy(desc(aiRisks.createdAt));
    const controls = await loadRiskControls(db, risks.map((r) => r.id));
    const acceptorIds = [...new Set(risks.map((r) => r.acceptedByUserId).filter((x): x is string => !!x))];
    const acceptorName = new Map(
      (acceptorIds.length
        ? await db
            .select({ id: users.id, displayName: users.displayName, email: users.email })
            .from(users)
            .where(inArray(users.id, acceptorIds))
        : []
      ).map((u) => [u.id, u.displayName || u.email]),
    );

    const providers = [...new Set(agentRows.map((a) => a.provider))];
    const customProviderIds = agentRows.map((a) => a.customProviderId).filter((x): x is string => !!x);
    const riskVendorIds = [...new Set(risks.map((r) => r.vendorId).filter((x): x is string => !!x))];
    const allVendors = await db.select().from(aiVendors);
    const vendors = allVendors
      .map((v) => {
        const via: string[] = [];
        const linkedProviders = (v.linkedAgentProviders ?? []) as string[];
        const linkedCustom = (v.linkedCustomProviderIds ?? []) as string[];
        if (linkedProviders.some((p) => providers.includes(p))) via.push("agent provider");
        if (linkedCustom.some((c) => customProviderIds.includes(c))) via.push("custom provider");
        if (riskVendorIds.includes(v.id)) via.push("named by a risk");
        return via.length ? { id: v.id, name: v.name, category: v.category, status: v.status, linkedVia: via } : null;
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    // --- approvals and audit ------------------------------------------------------
    const approvalRows = useCase.workflowInstanceId
      ? await db
          .select({
            id: approvals.id,
            status: approvals.status,
            stageId: approvals.stageId,
            approverUserId: approvals.approverUserId,
            requestedAt: approvals.requestedAt,
            decidedAt: approvals.decidedAt,
            decisionReason: approvals.decisionReason,
          })
          .from(approvals)
          .where(eq(approvals.instanceId, useCase.workflowInstanceId))
          .orderBy(desc(approvals.requestedAt))
      : [];
    const audit = await db
      .select({
        id: auditLog.id,
        at: auditLog.at,
        userId: auditLog.userId,
        ruleId: auditLog.ruleId,
        effect: auditLog.effect,
        reason: auditLog.reason,
      })
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "ai_use_case"), eq(auditLog.objectId, useCaseId)))
      .orderBy(desc(auditLog.at))
      .limit(20);

    const live = risks.filter((r) => r.status === "open" || r.status === "mitigating");
    return {
      useCase: { ...useCase, ownerName: owner ? owner.displayName || owner.email : null },
      screening: {
        tier: useCase.euAiActTier,
        reasons: useCase.euAiActReasons ?? [],
        rulesetVersion: useCase.euAiActRulesetVersion,
        screened: useCase.euAiActTier !== null,
      },
      questionnaire: artifact
        ? { submitted: true, artifactId: artifact.id, version: artifact.version, submittedAt: artifact.createdAt }
        : { submitted: false, artifactId: null, version: null, submittedAt: null },
      stack: { agents: stackAgents, vendors },
      risks: risks.map((r) => ({
        id: r.id,
        title: r.title,
        category: r.category,
        dimension: RISK_CATEGORY_DIMENSION[r.category as AiRiskCategory] ?? null,
        status: r.status,
        inherent: { likelihood: r.likelihood, impact: r.impact },
        residual:
          r.residualLikelihood && r.residualImpact
            ? { likelihood: r.residualLikelihood, impact: r.residualImpact }
            : null,
        controls: controls.get(r.id) ?? [],
        // ADR-0168 amendment: an acceptance recorded on a sign-off (or the register)
        acceptedByName: r.acceptedByUserId ? (acceptorName.get(r.acceptedByUserId) ?? null) : null,
        acceptedAt: r.acceptedAt,
        acceptanceRationale: r.status === "accepted" ? r.acceptanceNote : null,
      })),
      summary: {
        risks: risks.length,
        liveRisks: live.length,
        liveWithoutControls: live.filter((r) => (controls.get(r.id) ?? []).length === 0).length,
        agentsWithoutApprovedModelCard: stackAgents.filter((a) => !a.modelCardApproved).length,
        pendingApprovals: approvalRows.filter((a) => a.status === "pending").length,
      },
      approvals: approvalRows,
      audit,
      links: { frameworks: `/v1/use-cases/${useCaseId}/frameworks` },
    };
  });
}
