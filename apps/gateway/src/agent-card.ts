/**
 * Demo task C5 — THE AGENT CARD: purpose, data sources, guardrails, oversight
 * and where the agent is used, for one registry agent.
 *
 * Composition only, over records the platform already keeps:
 *  - PURPOSE and DATA SOURCES are what the agent's model cards DECLARE
 *    (intended use, data claims, limitations — ADR-0063). They are the card
 *    author's statements, labelled as such; the platform does not verify them.
 *  - GUARDRAILS are the modes `resolveGuardrailPolicy` would apply to an
 *    unattributed call to this agent right now (org default, agent override),
 *    with provenance. A project's compliance floor can only raise them.
 *  - USE CASES are the registered use cases that name this agent.
 *  - TOOLS are NOT recomputed here: tool and connector entitlements attach to
 *    users, and `GET /v1/inventory/agents/:id` already separates GRANTED from
 *    OBSERVED (ADR-0082). The card links there instead of keeping a second,
 *    drifting copy of that union.
 *
 * Admin-only through the default gate, like the inventory it links to.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { agents, aiUseCases, eq, modelCards, sql, users, type Db } from "@regulait/db";
import { resolveGuardrailPolicy } from "./guardrails.js";
import { loadCardsForSubject } from "./mrm.js";
import { stewardshipViews } from "./agent-stewardship.js";

const params = z.object({ agentId: z.string().uuid() });

export function registerAgentCardRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/agents/:agentId/card", async (req, reply) => {
    const { agentId } = params.parse(req.params);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "not_found" });
    const now = new Date();

    const [owner] = agent.ownerUserId
      ? await db
          .select({ id: users.id, displayName: users.displayName, email: users.email, disabledAt: users.disabledAt })
          .from(users)
          .where(eq(users.id, agent.ownerUserId))
      : [];

    const cards = await db.select().from(modelCards).where(eq(modelCards.agentId, agentId));
    const signOffs = await loadCardsForSubject(db, { agentId });
    const approvedCard = signOffs.some((c) =>
      c.approvals.some((a) => a.status === "approved" && (!a.validUntil || new Date(a.validUntil) > now)),
    );

    const guardrails = await resolveGuardrailPolicy(db, { agentId });
    // ADR-0168 item 6 — steward, successor, orphaned / review-overdue flags
    const stewardship = (await stewardshipViews(db, [agent], now)).get(agent.id)!;

    // use cases that name this agent among their intended agents (jsonb array)
    const useCases = await db
      .select({ id: aiUseCases.id, name: aiUseCases.name, status: aiUseCases.status, euAiActTier: aiUseCases.euAiActTier })
      .from(aiUseCases)
      .where(sql`${aiUseCases.intendedAgentIds} @> ${JSON.stringify([agentId])}::jsonb`);

    return {
      agent: {
        id: agent.id,
        name: agent.name,
        provider: agent.provider,
        model: agent.model,
        tier: agent.tier,
        modes: agent.modes ?? [],
        enabled: agent.enabled,
        lifecycleStatus: agent.lifecycleStatus,
        halted: agent.haltedAt !== null,
        haltedReason: agent.haltedReason,
        hasSystemPrompt: !!agent.systemPrompt,
      },
      owner: owner
        ? { id: owner.id, name: owner.displayName || owner.email, state: owner.disabledAt ? "orphaned" : "owned" }
        : { id: null, name: null, state: "unowned" },
      stewardship,
      purpose: {
        /** DECLARED by model-card authors — not verified by the platform */
        intendedUses: cards.map((c) => c.intendedUse),
        limitations: cards.map((c) => c.limitations).filter(Boolean),
        source: "model_cards",
      },
      dataSources: {
        declared: cards
          .map((c) => ({ cardId: c.id, claims: (c.dataClaims ?? {}) as Record<string, unknown> }))
          .filter((c) => Object.keys(c.claims).length > 0),
        source: "model_cards.data_claims",
        note: "the card author's declaration of what data the model is used with; not observed traffic",
      },
      guardrails: {
        modes: guardrails.modes,
        blocksInput: guardrails.blocksInput,
        blocksOutput: guardrails.blocksOutput,
        provenance: guardrails.provenance,
        note: "in force for an unattributed call right now; a project's compliance floor can only raise these",
      },
      oversight: {
        modelCards: cards.length,
        modelCardApproved: approvedCard,
        note: approvedCard
          ? "an unexpired model-card approval exists (the MRM gate passes when enforced)"
          : "no unexpired model-card approval — the MRM gate refuses dispatch when enforced",
      },
      useCases,
      links: {
        tools: `/v1/inventory/agents/${agentId}`,
        toolsNote: "granted vs observed tools and connectors live on the inventory record (ADR-0082)",
      },
    };
  });
}
