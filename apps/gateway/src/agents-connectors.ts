import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agents,
  auditLog,
  connectorGrants,
  connectors,
  costEvents,
  eq,
  userAgentPolicies,
  type Db,
} from "@regulait/db";
import { evaluateAgent, evaluateConnector } from "@regulait/policy-kernel";
import { classifyComplexity, estimateTokens, routeModel } from "@regulait/optimizer-kernel";
import {
  createAgentGrantSchema,
  createAgentSchema,
  createConnectorGrantSchema,
  createConnectorSchema,
  invokeAgentSchema,
  invokeConnectorSchema,
  setAgentEnabledSchema,
  setAgentPolicySchema,
} from "@regulait/shared";
import { z } from "zod";

const userIdParam = z.object({ userId: z.string().uuid() });
const agentIdParam = z.object({ agentId: z.string().uuid() });
const connectorIdParam = z.object({ connectorId: z.string().uuid() });

/** §2/§4: agent registry + entitlements, connector catalog + grants, and the
 * governed invoke endpoints that will anchor actual routing later. */
export function registerAgentConnectorRoutes(app: FastifyInstance, db: Db) {
  // --- agent registry (§4: global catalog, decoupled from entitlement) ---

  app.post("/v1/agents", async (req, reply) => {
    const body = createAgentSchema.parse(req.body);
    const [row] = await db
      .insert(agents)
      .values({
        name: body.name,
        provider: body.provider,
        tier: body.tier,
        modes: body.modes ?? null,
        costPerMTokIn: body.costPerMTokIn ?? null,
        costPerMTokOut: body.costPerMTokOut ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/agents", async () => ({ agents: await db.select().from(agents) }));

  // §4 new-agent-onboarding policy is opt-in by definition here: disabling is
  // platform-wide, but even an enabled agent reaches nobody without a grant.
  app.post("/v1/agents/:agentId/enabled", async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    const body = setAgentEnabledSchema.parse(req.body);
    const [row] = await db
      .update(agents)
      .set({ enabled: body.enabled })
      .where(eq(agents.id, agentId))
      .returning();
    if (!row) return reply.status(404).send({ error: "unknown_agent" });
    return row;
  });

  app.delete("/v1/grants/agents/:grantId", async (req, reply) => {
    const { grantId } = z.object({ grantId: z.string().uuid() }).parse(req.params);
    const deleted = await db
      .delete(agentGrants)
      .where(eq(agentGrants.id, grantId))
      .returning({ id: agentGrants.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_grant" });
    return { removed: true };
  });

  app.delete("/v1/grants/connectors/:grantId", async (req, reply) => {
    const { grantId } = z.object({ grantId: z.string().uuid() }).parse(req.params);
    const deleted = await db
      .delete(connectorGrants)
      .where(eq(connectorGrants.id, grantId))
      .returning({ id: connectorGrants.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_grant" });
    return { removed: true };
  });

  app.post("/v1/grants/agents", async (req, reply) => {
    const body = createAgentGrantSchema.parse(req.body);
    const [row] = await db
      .insert(agentGrants)
      .values({
        userId: body.userId,
        agentId: body.agentId,
        allowedModes: body.allowedModes ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // §4 per-user default + ceiling (partial upsert: an omitted field is left
  // untouched — only an explicit null clears it, so a partial update can
  // never silently lift the ceiling).
  app.post("/v1/users/:userId/agent-policy", async (req) => {
    const { userId } = userIdParam.parse(req.params);
    const body = setAgentPolicySchema.parse(req.body);
    const set: Partial<{
      defaultAgentId: string | null;
      ceilingAgentId: string | null;
      routingMode: "automatic" | "passthrough";
      runBudgetUsd: number | null;
      runBudgetBreachAction: "approve" | "replan";
    }> = {};
    if ("defaultAgentId" in (req.body as object)) set.defaultAgentId = body.defaultAgentId ?? null;
    if ("ceilingAgentId" in (req.body as object)) set.ceilingAgentId = body.ceilingAgentId ?? null;
    if (body.routingMode !== undefined) set.routingMode = body.routingMode;
    if ("runBudgetUsd" in (req.body as object)) set.runBudgetUsd = body.runBudgetUsd ?? null;
    if (body.runBudgetBreachAction !== undefined)
      set.runBudgetBreachAction = body.runBudgetBreachAction;
    const [row] = await db
      .insert(userAgentPolicies)
      .values({
        userId,
        defaultAgentId: set.defaultAgentId ?? null,
        ceilingAgentId: set.ceilingAgentId ?? null,
        routingMode: set.routingMode ?? "automatic",
        runBudgetUsd: set.runBudgetUsd ?? null,
        runBudgetBreachAction: set.runBudgetBreachAction ?? "approve",
      })
      .onConflictDoUpdate({ target: userAgentPolicies.userId, set })
      .returning();
    return row;
  });

  app.get("/v1/users/:userId/agents", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    if (!req.authCtx.isAdmin && req.authCtx.userId !== userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const [grants, [policy]] = await Promise.all([
      db
        .select({
          agentId: agents.id,
          name: agents.name,
          provider: agents.provider,
          tier: agents.tier,
          enabled: agents.enabled,
          allowedModes: agentGrants.allowedModes,
          grantId: agentGrants.id,
        })
        .from(agentGrants)
        .innerJoin(agents, eq(agentGrants.agentId, agents.id))
        .where(eq(agentGrants.userId, userId)),
      db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
    ]);
    return {
      agents: grants,
      defaultAgentId: policy?.defaultAgentId ?? null,
      ceilingAgentId: policy?.ceilingAgentId ?? null,
    };
  });

  // The governed enforcement point (§7): entitlement + mode + ceiling checks
  // and an audit row for every decision. Actual provider routing attaches
  // here later — governance precedes routing, not the other way around.
  app.post("/v1/agents/:agentId/invoke", async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    const body = invokeAgentSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_invoke" });

    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });

    const [grants, [policy]] = await Promise.all([
      db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
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

    const decision = evaluateAgent({
      userId,
      agent: { id: agent.id, tier: agent.tier, enabled: agent.enabled, modes: agent.modes ?? null },
      mode: body.mode,
      agentGrants: grants,
      ceilingTier,
    });

    // OPTIMIZATION §8: routing runs strictly after — and inside — governance.
    // The candidate set is exactly the agents evaluateAgent would allow for
    // this user+mode, so the optimizer can never widen entitlement (§12).
    let routing = null;
    if (decision.effect === "allow") {
      const registry = await db.select().from(agents).where(eq(agents.enabled, true));
      const candidates = registry
        .filter(
          (a) =>
            evaluateAgent({
              userId,
              agent: { id: a.id, tier: a.tier, enabled: a.enabled, modes: a.modes ?? null },
              mode: body.mode,
              agentGrants: grants,
              ceilingTier,
            }).effect === "allow",
        )
        .map((a) => ({
          id: a.id,
          tier: a.tier,
          costPerMTokIn: a.costPerMTokIn ?? null,
          costPerMTokOut: a.costPerMTokOut ?? null,
        }));
      const complexity = classifyComplexity(body.input);
      const estimate = estimateTokens(body.input, complexity);
      routing = routeModel({
        requestedAgentId: agent.id,
        candidates,
        routingMode: policy?.routingMode ?? "automatic",
        complexity,
        costSensitivity: body.costSensitivity,
        ceilingTier,
        estimate,
      });
      await db.insert(costEvents).values({
        userId,
        objectType: "agent",
        objectId: agent.id,
        technique: "model_routing",
        requestedAgentId: agent.id,
        servedAgentId: routing.selectedAgentId,
        baselineAgentId: routing.baselineAgentId,
        estimatedTokensIn: estimate.in,
        estimatedTokensOut: estimate.out,
        estimatedTokensSaved: routing.estimatedTokensSaved,
        estimatedCostSavedUsd: routing.estimatedCostSavedUsd,
        estimationBasis: routing.estimationBasis,
        ruleId: routing.ruleId,
        detail: { effect: routing.effect, complexity, mode: body.mode },
      });
    }

    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: agent.id,
      // §8: the served model is always visible in the execution log
      detail: { mode: body.mode, ...(routing ? { servedAgentId: routing.selectedAgentId } : {}) },
      effect: decision.effect,
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    });

    return reply
      .status(decision.effect === "allow" ? 200 : 403)
      .send(routing ? { decision, routing } : { decision });
  });

  // --- connectors (§2) ---

  app.post("/v1/connectors", async (req, reply) => {
    const body = createConnectorSchema.parse(req.body);
    const [row] = await db.insert(connectors).values(body).returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/connectors", async () => ({ connectors: await db.select().from(connectors) }));

  app.post("/v1/grants/connectors", async (req, reply) => {
    const body = createConnectorGrantSchema.parse(req.body);
    const [row] = await db
      .insert(connectorGrants)
      .values({
        userId: body.userId,
        connectorId: body.connectorId,
        mode: body.mode,
        allowedObjects: body.allowedObjects ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/users/:userId/connectors", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    if (!req.authCtx.isAdmin && req.authCtx.userId !== userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const rows = await db
      .select({
        connectorId: connectors.id,
        name: connectors.name,
        kind: connectors.kind,
        mode: connectorGrants.mode,
        allowedObjects: connectorGrants.allowedObjects,
        grantId: connectorGrants.id,
      })
      .from(connectorGrants)
      .innerJoin(connectors, eq(connectorGrants.connectorId, connectors.id))
      .where(eq(connectorGrants.userId, userId));
    return { connectors: rows };
  });

  app.post("/v1/connectors/:connectorId/invoke", async (req, reply) => {
    const { connectorId } = connectorIdParam.parse(req.params);
    const body = invokeConnectorSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_invoke" });

    const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    if (!connector) return reply.status(404).send({ error: "unknown_connector" });

    const grants = await db
      .select()
      .from(connectorGrants)
      .where(eq(connectorGrants.userId, userId));

    const decision = evaluateConnector({
      userId,
      connectorId,
      operation: body.operation,
      object: body.object ?? null,
      connectorGrants: grants,
    });

    await db.insert(auditLog).values({
      userId,
      objectType: "connector",
      objectId: connectorId,
      detail: { operation: body.operation, ...(body.object ? { object: body.object } : {}) },
      effect: decision.effect,
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    });

    return reply.status(decision.effect === "allow" ? 200 : 403).send({ decision });
  });
}
