/**
 * ADR-0182 (ADR-0175 batch D4) P0 — THE USE CASE'S EU AI ACT ROLE.
 *
 * `ai_use_cases.eu_ai_act_role` (migration 0162) says whether the organisation
 * is the provider, the deployer, or `both` for this system. A12's incident
 * clocks read it: `both`, the strict default (owner decision 2), starts every
 * applicable clock; naming one role narrows them.
 *
 *   PUT /v1/use-cases/:useCaseId/eu-ai-act-role   { role, reason? }
 *
 * Who may write (route class `user`, checked here):
 *   - returning to `both` (tightening): the use case's owner or an admin;
 *   - narrowing to `provider` or `deployer` (a RELAXATION, owner decision 1:
 *     "admin-relaxable, audited"): an admin only, with a reason.
 * Every change is audited with `detail.transitions` (ADR-0181's one shape).
 * A write that changes nothing writes nothing.
 *
 * Deliberately NOT part of `PATCH /v1/use-cases/:useCaseId`: that route locks
 * a use case under review and refuses edits to a decided one, while the role
 * is a fact about the organisation that must stay correct when an incident
 * happens on an approved system.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiUseCases, auditLog, eq, type Db } from "@regulait/db";
import { setEuAiActRoleSchema } from "@regulait/shared";
import { settingTransitions } from "./setting-transitions.js";

export const EU_AI_ACT_ROLE_RULE_IDS = {
  set: "use-case-eu-ai-act-role-set",
  refused: "use-case-eu-ai-act-role-refused",
} as const;

const params = z.object({ useCaseId: z.string().uuid() });

export function registerEuAiActRoleRoutes(app: FastifyInstance, db: Db): void {
  app.put("/v1/use-cases/:useCaseId/eu-ai-act-role", async (req, reply) => {
    const { useCaseId } = params.parse(req.params);
    const body = setEuAiActRoleSchema.parse(req.body);
    const [row] = await db
      .select({ id: aiUseCases.id, name: aiUseCases.name, ownerUserId: aiUseCases.ownerUserId, euAiActRole: aiUseCases.euAiActRole })
      .from(aiUseCases)
      .where(eq(aiUseCases.id, useCaseId));
    if (!row) return reply.status(404).send({ error: "not_found" });
    const isOwner = req.authCtx.userId !== null && req.authCtx.userId === row.ownerUserId;
    if (!req.authCtx.isAdmin && !isOwner) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "a use case's EU AI Act role is set by its owner or an admin",
      });
    }
    const narrowing = body.role !== "both";
    if (narrowing && !req.authCtx.isAdmin) {
      await db.insert(auditLog).values({
        userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
        objectType: "ai_use_case",
        objectId: useCaseId,
        detail: { attempted: body.role, current: row.euAiActRole },
        effect: "deny",
        ruleId: EU_AI_ACT_ROLE_RULE_IDS.refused,
        ruleChain: [],
        reason: `use case ${useCaseId}: narrowing the EU AI Act role to ${body.role} refused — an admin's relaxation`,
      });
      return reply.status(403).send({
        error: "relaxation_admin_only",
        detail:
          "'both' starts every applicable incident notification clock. Narrowing the role to provider or deployer " +
          "stops some of them, so only an admin may do it, with a reason. You may set it back to 'both'.",
      });
    }
    if (narrowing && !body.reason) {
      return reply.status(422).send({
        error: "reason_required",
        detail: "state why the organisation is only the " + body.role + " of this system (at least 10 characters)",
      });
    }
    if (row.euAiActRole === body.role) {
      return reply.send({ useCaseId, euAiActRole: row.euAiActRole, changed: false });
    }
    const transitions = settingTransitions({ euAiActRole: row.euAiActRole }, { euAiActRole: body.role });
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.update(aiUseCases).set({ euAiActRole: body.role, updatedAt: new Date() }).where(eq(aiUseCases.id, useCaseId));
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
        objectType: "ai_use_case",
        objectId: useCaseId,
        detail: { via: req.authCtx.via, transitions, relaxed: narrowing, ...(body.reason ? { reason: body.reason } : {}) },
        effect: "allow",
        ruleId: EU_AI_ACT_ROLE_RULE_IDS.set,
        ruleChain: [],
        reason:
          `use case ${useCaseId}: EU AI Act role ${row.euAiActRole} -> ${body.role}` +
          (narrowing ? ` (RELAXED from the strict default 'both': ${body.reason})` : " (the strict default)"),
      });
    });
    return reply.send({ useCaseId, euAiActRole: body.role, changed: true });
  });
}
