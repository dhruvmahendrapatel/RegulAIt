import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agents,
  auditLog,
  connectorGrants,
  connectors,
  costEvents,
  and,
  eq,
  modelCredentials,
  usageEvents,
  userModelCredentials,
  userAgentPolicies,
  type Db,
} from "@regulait/db";
import { evaluateAgent, evaluateConnector } from "@regulait/policy-kernel";
import { classifyComplexity, estimateTokens, routeModel } from "@regulait/optimizer-kernel";
import {
  isModelProviderKind,
  ModelProviderError,
  resolveModelProvider,
} from "@regulait/model-provider";
import {
  createAgentGrantSchema,
  createAgentSchema,
  createConnectorGrantSchema,
  createConnectorSchema,
  createModelCredentialSchema,
  invokeAgentSchema,
  invokeConnectorSchema,
  setAgentEnabledSchema,
  setAgentPolicySchema,
} from "@regulait/shared";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { assertProjectAttribution, postDispatchProjectAlert, preDispatchProjectGate } from "./projects.js";

const userIdParam = z.object({ userId: z.string().uuid() });
const agentIdParam = z.object({ agentId: z.string().uuid() });
const connectorIdParam = z.object({ connectorId: z.string().uuid() });

export type AgentRow = typeof agents.$inferSelect;

export type DispatchOutcome =
  | {
      ok: true;
      result: {
        servedAgentId: string;
        model: string;
        outputText: string;
        stopReason: string;
        refusal: boolean;
        usage: { inputTokens: number; outputTokens: number };
        costUsd: number | null;
        measuredCostSavedUsd: number | null;
        credentialSource: "user" | "platform" | "none";
        projectBudgetAlerted: boolean;
      };
    }
  | { ok: false; status: number; error: string; detail?: string };

/** The one governed-dispatch core, shared by the direct invoke path and the
 * orchestration worker-node path. The served agent is an INPUT — this
 * function never picks a model; governance and (where applicable) routing
 * have already happened upstream. Config problems (no model id, unknown
 * provider, missing credential) fail explicit, never fall back to a
 * different model. Every execution lands one MEASURED row in usage_events. */
export async function executeGovernedDispatch(
  db: Db,
  dataKey: string | undefined,
  args: {
    userId: string;
    /** the agent to execute — caller has already governance-checked it */
    served: AgentRow | undefined;
    requestedAgentId: string;
    /** routing counterfactual for measured savings; null = no routing happened */
    baseline?: AgentRow | null;
    input: string;
    /** system context (e.g. a nested run's signed-off workflow artifacts) */
    system?: string | undefined;
    maxTokens?: number | undefined;
    /** pillar 5 attribution: the project this call bills to */
    projectId?: string | null | undefined;
    detail?: Record<string, unknown>;
  },
): Promise<DispatchOutcome> {
  const { userId, served, requestedAgentId, baseline } = args;
  if (!served || !served.model || !isModelProviderKind(served.provider)) {
    return {
      ok: false,
      status: 409,
      error: "agent_not_dispatchable",
      detail: served
        ? `agent '${served.name}' needs a model id and a known provider (got provider '${served.provider}', model '${served.model ?? "none"}')`
        : "served agent not found in registry",
    };
  }

  // PILLAR 5 enforcement: an attributed dispatch is gated on the project's
  // measured budget BEFORE any provider work happens.
  const projectGate = await preDispatchProjectGate(db, args.projectId ?? null, userId);
  if (!projectGate.ok) {
    return {
      ok: false,
      status: projectGate.status,
      error: projectGate.error,
      ...(projectGate.detail ? { detail: projectGate.detail } : {}),
    };
  }

  let apiKey: string | null = null;
  let baseUrl: string | null = null;
  let credentialSource: "user" | "platform" | "none" = "none";
  if (served.provider !== "mock") {
    if (!dataKey) {
      return { ok: false, status: 503, error: "no_data_key", detail: "set REGULAIT_DATA_KEY" };
    }
    // BYO key: the BILLING user's own credential wins over the platform one —
    // their spend rides their key, and the ledger records which was used.
    const [userCred] = await db
      .select()
      .from(userModelCredentials)
      .where(
        and(
          eq(userModelCredentials.userId, userId),
          eq(userModelCredentials.provider, served.provider),
        ),
      );
    const [platformCred] = userCred
      ? [undefined]
      : await db.select().from(modelCredentials).where(eq(modelCredentials.provider, served.provider));
    const cred = userCred ?? platformCred;
    if (!cred) {
      return {
        ok: false,
        status: 409,
        error: "no_model_credential",
        detail: `no stored credential (user or platform) for provider '${served.provider}'`,
      };
    }
    credentialSource = userCred ? "user" : "platform";
    apiKey = decryptSecret(dataKey, cred.keyCiphertext);
    baseUrl = cred.baseUrl;
  }

  let result;
  try {
    const provider = resolveModelProvider({ provider: served.provider, apiKey, baseUrl });
    result = await provider.dispatch({
      model: served.model,
      input: args.input,
      ...(args.system ? { system: args.system } : {}),
      ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
    });
  } catch (err) {
    if (err instanceof ModelProviderError) {
      return { ok: false, status: 502, error: "model_dispatch_failed", detail: err.message };
    }
    throw err;
  }

  // Pillar 5 actuals: measured tokens × the served agent's list price. An
  // unpriced agent yields null — a measured token count never becomes an
  // invented dollar figure.
  const costUsd =
    served.costPerMTokIn != null && served.costPerMTokOut != null
      ? (result.usage.inputTokens / 1e6) * served.costPerMTokIn +
        (result.usage.outputTokens / 1e6) * served.costPerMTokOut
      : null;
  // The measured version of routing's savings claim: what the baseline agent
  // would have cost at the SAME measured token volumes, minus what we paid.
  const measuredCostSavedUsd =
    costUsd != null &&
    baseline &&
    baseline.costPerMTokIn != null &&
    baseline.costPerMTokOut != null
      ? (result.usage.inputTokens / 1e6) * baseline.costPerMTokIn +
        (result.usage.outputTokens / 1e6) * baseline.costPerMTokOut -
        costUsd
      : null;

  await db.insert(usageEvents).values({
    userId,
    agentId: served.id,
    requestedAgentId,
    baselineAgentId: baseline?.id ?? null,
    provider: served.provider,
    model: served.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd,
    measuredCostSavedUsd,
    stopReason: result.stopReason,
    refusal: result.refusal,
    providerMessageId: result.providerMessageId,
    projectId: args.projectId ?? null,
    detail: { credentialSource, ...(args.detail ?? {}) },
  });
  // first budget crossing is allowed (measured cost arrives after the call)
  // but alerts immediately; the pre-gate blocks everything after it
  const projectBudgetAlerted = await postDispatchProjectAlert(db, projectGate, userId, costUsd);

  return {
    ok: true,
    result: {
      servedAgentId: served.id,
      model: served.model,
      outputText: result.outputText,
      stopReason: result.stopReason,
      refusal: result.refusal,
      usage: result.usage,
      costUsd,
      measuredCostSavedUsd,
      credentialSource,
      projectBudgetAlerted,
    },
  };
}

/** Direct-invoke dispatch: resolve routing's choice against the registry and
 * hand it to the shared core. */
async function performDispatch(
  db: Db,
  dataKey: string | undefined,
  args: {
    userId: string;
    requestedAgentId: string;
    registry: AgentRow[];
    routing: ReturnType<typeof routeModel>;
    body: z.infer<typeof invokeAgentSchema>;
  },
): Promise<DispatchOutcome> {
  const { userId, requestedAgentId, registry, routing, body } = args;
  return executeGovernedDispatch(db, dataKey, {
    userId,
    served: registry.find((a) => a.id === routing.selectedAgentId),
    requestedAgentId,
    baseline: registry.find((a) => a.id === routing.baselineAgentId) ?? null,
    input: body.input ?? "",
    maxTokens: body.maxTokens,
    projectId: body.projectId ?? null,
    detail: { mode: body.mode },
  });
}

/** §2/§4: agent registry + entitlements, connector catalog + grants, and the
 * governed invoke endpoints — decision, routing, and (dispatch=true) real
 * model execution. */
export function registerAgentConnectorRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string } = {},
) {
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
        model: body.model ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // --- model credentials (admin-only via the global gate) ---
  // One platform credential per provider, encrypted at rest, never returned.

  app.post("/v1/model-credentials", async (req, reply) => {
    const body = createModelCredentialSchema.parse(req.body);
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }
    const values = {
      provider: body.provider,
      keyCiphertext: encryptSecret(opts.dataKey, body.apiKey),
      baseUrl: body.baseUrl ?? null,
    };
    const [row] = await db
      .insert(modelCredentials)
      .values(values)
      .onConflictDoUpdate({ target: modelCredentials.provider, set: values })
      .returning({
        id: modelCredentials.id,
        provider: modelCredentials.provider,
        baseUrl: modelCredentials.baseUrl,
        createdAt: modelCredentials.createdAt,
      });
    return reply.status(201).send(row);
  });

  app.get("/v1/model-credentials", async () => ({
    credentials: await db
      .select({
        id: modelCredentials.id,
        provider: modelCredentials.provider,
        baseUrl: modelCredentials.baseUrl,
        createdAt: modelCredentials.createdAt,
      })
      .from(modelCredentials),
  }));

  // --- per-user model credentials (BYO key; self-service or admin) ---
  // Same write-only discipline as the platform surface: the key is accepted,
  // encrypted, and never returned.

  const userCredCols = {
    id: userModelCredentials.id,
    userId: userModelCredentials.userId,
    provider: userModelCredentials.provider,
    baseUrl: userModelCredentials.baseUrl,
    createdAt: userModelCredentials.createdAt,
  };

  app.post("/v1/users/:userId/model-credentials", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    if (!req.authCtx.isAdmin && req.authCtx.userId !== userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const body = createModelCredentialSchema.parse(req.body);
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }
    const values = {
      userId,
      provider: body.provider,
      keyCiphertext: encryptSecret(opts.dataKey, body.apiKey),
      baseUrl: body.baseUrl ?? null,
    };
    const [row] = await db
      .insert(userModelCredentials)
      .values(values)
      .onConflictDoUpdate({
        target: [userModelCredentials.userId, userModelCredentials.provider],
        set: values,
      })
      .returning(userCredCols);
    return reply.status(201).send(row);
  });

  app.get("/v1/users/:userId/model-credentials", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    if (!req.authCtx.isAdmin && req.authCtx.userId !== userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    return {
      credentials: await db
        .select(userCredCols)
        .from(userModelCredentials)
        .where(eq(userModelCredentials.userId, userId)),
    };
  });

  app.delete("/v1/users/:userId/model-credentials/:provider", async (req, reply) => {
    const { userId, provider } = z
      .object({ userId: z.string().uuid(), provider: z.string().min(1) })
      .parse(req.params);
    if (!req.authCtx.isAdmin && req.authCtx.userId !== userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const deleted = await db
      .delete(userModelCredentials)
      .where(
        and(eq(userModelCredentials.userId, userId), eq(userModelCredentials.provider, provider)),
      )
      .returning({ id: userModelCredentials.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_credential" });
    return { removed: true };
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

    // pillar 5 + ADR-0011: attribution must point at a real project the
    // caller may bill to — the ledgers are FK-free, so the gate is here at
    // the entry point.
    if (body.projectId) {
      const attribution = await assertProjectAttribution(db, body.projectId, userId, req.authCtx.isAdmin);
      if (!attribution.ok) return reply.status(attribution.status).send({ error: attribution.error });
    }

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
    let dispatchOutcome: DispatchOutcome | null = null;
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
        projectId: body.projectId ?? null,
        detail: { effect: routing.effect, complexity, mode: body.mode },
      });

      // MODEL DISPATCH: real execution, strictly after governance + routing —
      // the served agent is routing's choice, so dispatch can never widen
      // entitlement. Measured usage lands in usage_events (pillar 5 actuals).
      if (body.dispatch) {
        dispatchOutcome = await performDispatch(db, opts.dataKey, {
          userId,
          requestedAgentId: agent.id,
          registry,
          routing,
          body,
        });
      }
    }

    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: agent.id,
      // §8: the served model is always visible in the execution log
      detail: {
        mode: body.mode,
        ...(routing ? { servedAgentId: routing.selectedAgentId } : {}),
        ...(dispatchOutcome
          ? {
              dispatch: dispatchOutcome.ok
                ? {
                    model: dispatchOutcome.result.model,
                    stopReason: dispatchOutcome.result.stopReason,
                    refusal: dispatchOutcome.result.refusal,
                  }
                : { error: dispatchOutcome.error },
            }
          : {}),
      },
      effect: decision.effect,
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    });

    if (decision.effect !== "allow") return reply.status(403).send({ decision });
    if (dispatchOutcome && !dispatchOutcome.ok) {
      return reply.status(dispatchOutcome.status).send({
        decision,
        routing,
        error: dispatchOutcome.error,
        ...(dispatchOutcome.detail ? { detail: dispatchOutcome.detail } : {}),
      });
    }
    return reply.send({
      decision,
      routing,
      ...(dispatchOutcome ? { dispatch: dispatchOutcome.result } : {}),
    });
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
