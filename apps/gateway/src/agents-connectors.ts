import type { FastifyInstance } from "fastify";
import {
  agentGrants,
  agents,
  auditLog,
  connectorCredentials,
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
import {
  ConnectorProviderError,
  isConnectorProviderKind,
  resolveConnectorProvider,
} from "@regulait/connector-provider";
import {
  classifyComplexity,
  estimateTokens,
  routeModel,
  planPromptCache,
  CACHE_READ_DISCOUNT,
  planEditVsRewrite,
  classifyEditIntent,
  type RoutingDecision,
} from "@regulait/optimizer-kernel";
import {
  isModelProviderKind,
  ModelProviderError,
  resolveModelProvider,
  type ModelChatMessage,
  type ModelToolDef,
} from "@regulait/model-provider";
import {
  createAgentGrantSchema,
  createAgentSchema,
  createConnectorCredentialSchema,
  createConnectorGrantSchema,
  createConnectorSchema,
  createModelCredentialSchema,
  invokeAgentSchema,
  invokeConnectorSchema,
  setAgentEnabledSchema,
  setAgentPolicySchema,
} from "@regulait/shared";
import type { PiiHit } from "@regulait/shared";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "./secrets.js";
import {
  assertProjectAttribution,
  enforcePII,
  piiCategoryList,
  piiWithheldMarker,
  postDispatchProjectAlert,
  preDispatchProjectGate,
  projectPiiMode,
  type PiiMode,
} from "./projects.js";
import {
  loadOwnConversation,
  recordConversationTurns,
  type ConversationContext,
} from "./conversations.js";
import {
  prepareConversationContext,
  type PreparedConversationContext,
} from "./compaction.js";

const userIdParam = z.object({ userId: z.string().uuid() });
const agentIdParam = z.object({ agentId: z.string().uuid() });
const connectorIdParam = z.object({ connectorId: z.string().uuid() });

export type AgentRow = typeof agents.$inferSelect;

/** An entitled agent routing was not allowed to consider, and why. Reported
 * alongside the routing decision so a downroute that did NOT happen is as
 * explainable as one that did (§8). */
export interface SkippedCandidate {
  agentId: string;
  name: string;
  reason: "no_model_credential" | "no_model_id" | "unknown_provider";
}

/** §8.4 PII enforcement outcome threaded onto a dispatch. COUNTS ONLY —
 * inputHits/outputHits are per-category counts, never the matched text. */
export interface DispatchPii {
  mode: PiiMode;
  /** the effective action on this dispatch: 'block' (output withheld here, or
   * a pre-call input block that never reached the model), 'warn', or 'log'. */
  action: "block" | "warn" | "log";
  inputHits: PiiHit[];
  outputHits: PiiHit[];
  /** true when a block replaced the model output with the withheld marker */
  withheld: boolean;
}

export type DispatchOutcome =
  | {
      ok: true;
      result: {
        servedAgentId: string;
        model: string;
        outputText: string;
        stopReason: string;
        refusal: boolean;
        /** present only when the model paused to call tools (pillar 7 loop) */
        toolCalls?: Array<{ id: string; name: string; arguments: unknown }>;
        usage: { inputTokens: number; outputTokens: number };
        costUsd: number | null;
        measuredCostSavedUsd: number | null;
        credentialSource: "user" | "platform" | "none";
        projectBudgetAlerted: boolean;
        /** §8.4: present only when a classified project's PII policy acted */
        pii?: DispatchPii;
      };
    }
  | { ok: false; status: number; error: string; detail?: string; pii?: DispatchPii };

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
    /** multi-turn: the FULL ordered history including the newest user turn;
     * when present the provider ignores `input` (model-provider contract) */
    messages?: ModelChatMessage[] | undefined;
    /** system context (e.g. a nested run's signed-off workflow artifacts) */
    system?: string | undefined;
    /** pillar-6 prompt caching: mark `system` cacheable on the outgoing request
     * (Anthropic ephemeral breakpoint). Purely a cost annotation — the served
     * agent, model, entitlement, and output are unchanged. */
    cacheSystem?: boolean | undefined;
    /** pillar 7: tools the worker may call this turn. When absent the request
     * is byte-identical to the tool-free dispatch. */
    tools?: ModelToolDef[] | undefined;
    maxTokens?: number | undefined;
    /** pillar 5 attribution: the project this call bills to */
    projectId?: string | null | undefined;
    /** streaming delta callback, forwarded to the provider */
    onText?: ((delta: string) => void) | undefined;
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

  // §8.4 PII ENFORCEMENT (pillar 3). The project's effective piiMode is
  // resolved from its compliance cascade; an unclassified/unmatched project
  // yields null and every check below is a no-op (byte-identical behaviour).
  const piiMode = await projectPiiMode(db, args.projectId ?? null);
  let inputHits: PiiHit[] = [];
  if (piiMode) {
    // INPUT check runs BEFORE any provider work, so a block incurs no cost —
    // no usage row, no dispatch, no tokens.
    const chk = enforcePII(piiMode, { input: args.input });
    inputHits = chk.hits;
    if (chk.action === "block") {
      const reason = `input contains PII: ${piiCategoryList(chk.hits)}`;
      const pii: DispatchPii = {
        mode: piiMode,
        action: "block",
        inputHits: chk.hits,
        outputHits: [],
        withheld: false,
      };
      await db.insert(auditLog).values({
        userId,
        objectType: "agent",
        objectId: served.id,
        detail: {
          phase: "pii",
          pii: { mode: piiMode, action: "block", phase: "input", inputHits: chk.hits, outputHits: [] },
          ...(args.projectId ? { projectId: args.projectId } : {}),
        },
        effect: "deny",
        ruleId: "pii-blocked",
        ruleChain: [],
        reason,
      });
      return { ok: false, status: 403, error: "pii_blocked", detail: reason, pii };
    }
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
      ...(args.messages ? { messages: args.messages } : {}),
      ...(args.system ? { system: args.system } : {}),
      ...(args.cacheSystem ? { cacheSystem: true } : {}),
      ...(args.tools ? { tools: args.tools } : {}),
      ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
      ...(args.onText ? { onText: args.onText } : {}),
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

  // §8.4 OUTPUT check: the call already ran, so a block here is BILL-AND-
  // WITHHOLD — the usage row below records the honest spend, but the output
  // text is replaced by a withheld marker and the response is denial-shaped.
  let outputHits: PiiHit[] = [];
  let outputText = result.outputText;
  let withheld = false;
  if (piiMode) {
    const chk = enforcePII(piiMode, { output: result.outputText });
    outputHits = chk.hits;
    if (chk.action === "block") {
      withheld = true;
      outputText = piiWithheldMarker(chk.hits);
    }
  }
  const anyHits = inputHits.length > 0 || outputHits.length > 0;
  // The recorded action, only meaningful when there were hits: a withheld
  // output is 'block', otherwise the mode's own posture (warn / log).
  const piiAction: DispatchPii["action"] = withheld
    ? "block"
    : piiMode === "warn"
      ? "warn"
      : "log";
  const pii: DispatchPii | null =
    piiMode && anyHits
      ? { mode: piiMode, action: piiAction, inputHits, outputHits, withheld }
      : null;
  // §8.4: COUNTS ONLY in the usage detail — never the matched substrings.
  const piiDetail = pii
    ? { pii: { mode: pii.mode, action: pii.action, inputHits, outputHits } }
    : {};

  await db.insert(usageEvents).values({
    userId,
    objectType: "agent",
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
    detail: { credentialSource, ...(args.detail ?? {}), ...piiDetail },
  });
  // §8.4 audit rows for a PII event (never for a clean payload): an OUTPUT
  // block is a governance deny; a warn is an allow with the 'pii-warned' rule;
  // log mode records counts in the usage detail above and stays silent here.
  if (withheld) {
    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: served.id,
      detail: {
        phase: "pii",
        pii: { mode: piiMode, action: "block", phase: "output", inputHits, outputHits },
        ...(args.projectId ? { projectId: args.projectId } : {}),
      },
      effect: "deny",
      ruleId: "pii-blocked",
      ruleChain: [],
      reason: `output contains PII: ${piiCategoryList(outputHits)} — billed and withheld`,
    });
  } else if (piiMode === "warn" && anyHits) {
    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: served.id,
      detail: {
        phase: "pii",
        pii: { mode: piiMode, action: "warn", inputHits, outputHits },
        ...(args.projectId ? { projectId: args.projectId } : {}),
      },
      effect: "allow",
      ruleId: "pii-warned",
      ruleChain: [],
      reason: `PII detected (${piiCategoryList([...inputHits, ...outputHits])}) — warned, dispatch proceeded`,
    });
  }
  // first budget crossing is allowed (measured cost arrives after the call)
  // but alerts immediately; the pre-gate blocks everything after it. Below the
  // cap, the softer configurable threshold raises a distinct non-blocking signal.
  const budgetSignal = await postDispatchProjectAlert(db, projectGate, userId, costUsd);

  return {
    ok: true,
    result: {
      servedAgentId: served.id,
      model: served.model,
      outputText,
      stopReason: result.stopReason,
      refusal: result.refusal,
      ...(result.toolCalls ? { toolCalls: result.toolCalls } : {}),
      usage: result.usage,
      costUsd,
      measuredCostSavedUsd,
      credentialSource,
      projectBudgetAlerted: budgetSignal.escalated,
      ...(budgetSignal.thresholdAlert
        ? {
            projectBudgetThresholdAlert: {
              thresholdPct: budgetSignal.thresholdPct,
              spentUsd: budgetSignal.spentUsd,
              budgetUsd: budgetSignal.budgetUsd,
              ...(budgetSignal.period ? { period: budgetSignal.period } : {}),
            },
          }
        : {}),
      ...(pii ? { pii } : {}),
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
    /** effective attribution — explicit body.projectId, else the conversation's */
    projectId: string | null;
    /** multi-turn history including the newest turn (conversation dispatches) */
    messages?: ModelChatMessage[] | undefined;
    /** pillar-6 edit-vs-rewrite: the single-turn user input to send, overriding
     * `body.input` when the caller has composed a baseline-augmented input.
     * Absent = the plain `body.input` (byte-identical to the pre-edit path). */
    input?: string | undefined;
    /** pillar-6 prompt caching: the stable system prefix to send, and whether
     * to mark it cacheable (the kernel's planPromptCache decision). */
    system?: string | undefined;
    cacheSystem?: boolean | undefined;
    onText?: ((delta: string) => void) | undefined;
  },
): Promise<DispatchOutcome> {
  const { userId, requestedAgentId, registry, routing, body } = args;
  return executeGovernedDispatch(db, dataKey, {
    userId,
    served: registry.find((a) => a.id === routing.selectedAgentId),
    requestedAgentId,
    baseline: registry.find((a) => a.id === routing.baselineAgentId) ?? null,
    input: args.input ?? body.input ?? "",
    messages: args.messages,
    ...(args.system ? { system: args.system } : {}),
    ...(args.cacheSystem ? { cacheSystem: true } : {}),
    maxTokens: body.maxTokens,
    projectId: args.projectId,
    onText: args.onText,
    detail: { mode: body.mode, ...(body.conversationId ? { conversationId: body.conversationId } : {}) },
  });
}

/** Providers this user could actually dispatch to right now: "mock" needs no
 * key at all, everything else needs a stored credential — the caller's own
 * (BYO key) or the platform's — and a data key to decrypt it with. Exported
 * so orchestration's re-plan routing filters candidates exactly like the
 * invoke path does — routing anywhere may only land on a servable agent. */
export async function configuredProviders(
  db: Db,
  dataKey: string | undefined,
  userId: string,
): Promise<Set<string>> {
  // Without REGULAIT_DATA_KEY no stored credential can be decrypted, so mock
  // is the only thing that can be served (executeGovernedDispatch agrees).
  if (!dataKey) return new Set(["mock"]);
  const [userCreds, platformCreds] = await Promise.all([
    db
      .select({ provider: userModelCredentials.provider })
      .from(userModelCredentials)
      .where(eq(userModelCredentials.userId, userId)),
    db.select({ provider: modelCredentials.provider }).from(modelCredentials),
  ]);
  return new Set([
    "mock",
    ...userCreds.map((c) => c.provider),
    ...platformCreds.map((c) => c.provider),
  ]);
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

  // Rotation is the POST above (upsert on provider); this is the way OUT — a
  // platform key that must stop being used has to be removable without a
  // psql session, and there is no other route that can do it.
  app.delete("/v1/model-credentials/:provider", async (req, reply) => {
    const { provider } = z.object({ provider: z.string().min(1) }).parse(req.params);
    const deleted = await db
      .delete(modelCredentials)
      .where(eq(modelCredentials.provider, provider))
      .returning({ id: modelCredentials.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_credential" });
    return { removed: true };
  });

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
    // The whole policy, not half of it: an editor that can set a run budget
    // but never read the current one makes every edit a guess.
    return {
      agents: grants,
      defaultAgentId: policy?.defaultAgentId ?? null,
      ceilingAgentId: policy?.ceilingAgentId ?? null,
      routingMode: policy?.routingMode ?? null,
      runBudgetUsd: policy?.runBudgetUsd ?? null,
      runBudgetBreachAction: policy?.runBudgetBreachAction ?? null,
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

    // MULTI-TURN: resolve the conversation before anything can bill or
    // dispatch — unknown is 404, someone else's is 403 (admins included;
    // conversations are personal, see conversations.ts).
    let convo: Extract<ConversationContext, { ok: true }> | null = null;
    if (body.conversationId) {
      const loaded = await loadOwnConversation(db, body.conversationId, userId);
      if (!loaded.ok) return reply.status(loaded.status).send({ error: loaded.error });
      convo = loaded;
    }

    // pillar 5 + ADR-0011: attribution must point at a real project the
    // caller may bill to — an explicit projectId wins, else the
    // conversation's default; the ledgers are FK-free, so the gate is here
    // at the entry point.
    const projectId = body.projectId ?? convo?.conversation.projectId ?? null;
    if (projectId) {
      const attribution = await assertProjectAttribution(db, projectId, userId, req.authCtx.isAdmin);
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
      // the display name rides along so denial prose says "premium-mock
      // (c8d62183…)" instead of a bare UUID (the id stays in the trace)
      agent: {
        id: agent.id,
        name: agent.name,
        tier: agent.tier,
        enabled: agent.enabled,
        modes: agent.modes ?? null,
      },
      mode: body.mode,
      agentGrants: grants,
      ceilingTier,
    });

    // OPTIMIZATION §8: routing runs strictly after — and inside — governance.
    // The candidate set starts as exactly the agents evaluateAgent would allow
    // for this user+mode, and is only ever narrowed from there, so the
    // optimizer can never widen entitlement (§12).
    let routing: (RoutingDecision & { skippedCandidates?: SkippedCandidate[] }) | null = null;
    let dispatchOutcome: DispatchOutcome | null = null;
    let convoContext: PreparedConversationContext | null = null;
    if (decision.effect === "allow") {
      const registry = await db.select().from(agents).where(eq(agents.enabled, true));
      const entitled = registry.filter(
        (a) =>
          evaluateAgent({
            userId,
            agent: { id: a.id, name: a.name, tier: a.tier, enabled: a.enabled, modes: a.modes ?? null },
            mode: body.mode,
            agentGrants: grants,
            ceilingTier,
          }).effect === "allow",
      );

      // A request that will really execute may only be routed onto an agent
      // that can really be served: downrouting onto a provider with no stored
      // credential turns a working request into a `no_model_credential`
      // failure. A decision-only invoke executes nothing, so it stays a
      // preview over the whole entitled set. The REQUESTED agent is never
      // filtered out — routeModel fails safe without its baseline, and an
      // unconfigured requested agent must fail explicitly rather than be
      // quietly substituted away.
      let skippedCandidates: SkippedCandidate[] = [];
      let candidateRows = entitled;
      // PILLAR 6 §5: the summarizer roster — strictly dispatchable (model id,
      // known provider, stored credential; NO requested-agent exemption) so a
      // compaction dispatch can never fail on config the invoke path already
      // knows about. Same filter decompose.ts applies to its worker roster.
      let compactionCandidates: AgentRow[] = [];
      if (body.dispatch) {
        const configured = await configuredProviders(db, opts.dataKey, userId);
        const skipReason = (a: AgentRow): SkippedCandidate["reason"] | null => {
          if (a.id === agent.id) return null;
          if (!a.model) return "no_model_id";
          if (!isModelProviderKind(a.provider)) return "unknown_provider";
          if (!configured.has(a.provider)) return "no_model_credential";
          return null;
        };
        skippedCandidates = entitled.flatMap((a) => {
          const reason = skipReason(a);
          return reason ? [{ agentId: a.id, name: a.name, reason }] : [];
        });
        const skippedIds = new Set(skippedCandidates.map((s) => s.agentId));
        candidateRows = entitled.filter((a) => !skippedIds.has(a.id));
        compactionCandidates = entitled.filter(
          (a) => a.model && isModelProviderKind(a.provider) && configured.has(a.provider),
        );
      }

      // PILLAR 6 §5 CONTEXT COMPACTION — strictly after governance (the
      // summarizer candidates are the caller's own entitled roster) and
      // strictly before the main dispatch. May run one governed, metered
      // summarization dispatch (audit purpose "compact", billed to the same
      // project); its failure NEVER fails this turn — the full history
      // dispatches instead (fail-open, noted in the trace). Stored messages
      // are never touched. "passthrough" is §12's per-user optimization off
      // switch and disables compaction exactly like it disables routing —
      // the full stored history dispatches verbatim. Threshold/window stay
      // the kernel defaults: the agent-policy row has no natural home for
      // per-user dials without a migration, deferred deliberately.
      if (convo && body.dispatch && (policy?.routingMode ?? "automatic") !== "passthrough") {
        convoContext = await prepareConversationContext(db, opts.dataKey, {
          userId,
          conversation: convo.conversation,
          messages: convo.messages,
          candidates: compactionCandidates,
          projectId,
          execute: executeGovernedDispatch,
        });
      }

      const candidates = candidateRows.map((a) => ({
        id: a.id,
        tier: a.tier,
        costPerMTokIn: a.costPerMTokIn ?? null,
        costPerMTokOut: a.costPerMTokOut ?? null,
      }));
      // Conversations: complexity stays classified on the NEWEST user turn
      // (the routing signal), but the history riding the same request is
      // counted into the input estimate so budget gates and cost forecasts
      // stay truthful as the thread grows — the MODEL-BOUND history, i.e.
      // the compacted view when a summary is in play.
      const complexity = classifyComplexity(body.input);
      const estimate = estimateTokens(body.input, complexity);
      const boundChars = convoContext ? convoContext.modelBoundChars : (convo?.historyChars ?? 0);
      if (convo && boundChars > 0) estimate.in += Math.ceil(boundChars / 4);
      // PILLAR 6 §8 edit-vs-rewrite: when the caller supplies a baseline to
      // edit, the model must SEE it either way, so its input tokens are a real
      // part of this dispatch's payload — fold them into the routing estimate
      // (like conversation history above) BEFORE routing/budget/cost see it.
      const baselineTokens = body.baseline ? Math.ceil(body.baseline.length / 4) : 0;
      if (baselineTokens) estimate.in += baselineTokens;
      routing = routeModel({
        requestedAgentId: agent.id,
        candidates,
        routingMode: policy?.routingMode ?? "automatic",
        complexity,
        costSensitivity: body.costSensitivity,
        ceilingTier,
        estimate,
      });
      // Purely additive to the trace: the kernel's own fields keep meaning
      // exactly what they meant, and the agents it never got to weigh are
      // listed beside them with the reason each was withheld.
      if (skippedCandidates.length > 0) routing = { ...routing, skippedCandidates };
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
        projectId,
        detail: {
          effect: routing.effect,
          complexity,
          mode: body.mode,
          ...(body.conversationId ? { conversationId: body.conversationId } : {}),
        },
      });

      // PILLAR 6 §5 savings accounting: a dispatch that rode a summary in
      // place of the omitted older turns lands one context_compaction row in
      // the SAME per-technique ledger model_routing writes — the Spend page
      // and admin savings-by-technique chart pick it up with zero changes.
      // Tokens saved = omitted history minus the summary (floored at 0);
      // dollars = those tokens at the SERVED agent's input list price.
      if (convoContext?.summaryUsed && routing) {
        const routed = routing;
        const servedRow = registry.find((a) => a.id === routed.selectedAgentId);
        const estimatedCostSavedUsd =
          servedRow?.costPerMTokIn != null
            ? Number(((convoContext.savedTokensEst / 1e6) * servedRow.costPerMTokIn).toFixed(6))
            : null;
        await db.insert(costEvents).values({
          userId,
          objectType: "agent",
          objectId: agent.id,
          technique: "context_compaction",
          requestedAgentId: agent.id,
          servedAgentId: routing.selectedAgentId,
          baselineAgentId: routing.baselineAgentId,
          estimatedTokensIn: estimate.in,
          estimatedTokensOut: estimate.out,
          estimatedTokensSaved: convoContext.savedTokensEst,
          estimatedCostSavedUsd,
          estimationBasis: "estimated-tokens-of-omitted-history-minus-summary-x-served-input-list-price",
          ruleId: "context-compaction",
          projectId,
          detail: {
            mode: body.mode,
            conversationId: body.conversationId,
            omittedMessages: convoContext.publicDetail?.omittedMessages ?? 0,
            summaryTokens: convoContext.publicDetail?.summaryTokens ?? 0,
          },
        });
      }

      // PILLAR 6 §8/§10 PROMPT CACHING — a pure cost annotation on this
      // ALREADY-authorized dispatch: the kernel decides whether the stable
      // system prefix clears the provider's minimum cacheable size, the
      // Anthropic adapter emits the real ephemeral breakpoint (cacheSystem
      // threaded into the dispatch below), and one estimate row lands in the
      // SAME per-technique ledger. It NEVER changes the served agent, model,
      // entitlement, budget, or output (the §12 "can never widen entitlement"
      // invariant). "passthrough" is the per-user off switch, exactly as for
      // routing/compaction. Estimated tokens saved = the full cached prefix
      // served from cache on each reuse; dollars = those tokens at the SERVED
      // agent's input list price × the ephemeral cache-read discount. Written
      // only when caching actually applies (like context_compaction).
      const systemPrompt = body.system ?? undefined;
      const systemTokens = systemPrompt ? Math.ceil(systemPrompt.length / 4) : 0;
      const promptCache = planPromptCache({
        systemTokens,
        routingMode: policy?.routingMode ?? "automatic",
      });
      if (body.dispatch && promptCache.cacheSystem && routing) {
        const routed = routing;
        const servedRow = registry.find((a) => a.id === routed.selectedAgentId);
        const estimatedCostSavedUsd =
          servedRow?.costPerMTokIn != null
            ? Number(
                (
                  (promptCache.estimatedTokensSaved / 1e6) *
                  servedRow.costPerMTokIn *
                  CACHE_READ_DISCOUNT
                ).toFixed(6),
              )
            : null;
        await db.insert(costEvents).values({
          userId,
          objectType: "agent",
          objectId: agent.id,
          technique: "prompt_caching",
          requestedAgentId: agent.id,
          servedAgentId: routing.selectedAgentId,
          baselineAgentId: routing.baselineAgentId,
          estimatedTokensIn: estimate.in,
          estimatedTokensOut: estimate.out,
          estimatedTokensSaved: promptCache.estimatedTokensSaved,
          estimatedCostSavedUsd,
          estimationBasis: promptCache.estimationBasis,
          ruleId: "prompt-caching",
          projectId,
          detail: { systemTokens, mode: body.mode },
        });
      }

      // PILLAR 6 §8 EDIT VS REWRITE — a pure cost annotation on this
      // ALREADY-authorized dispatch: the kernel decides whether the caller's
      // change request reads as a targeted EDIT over a large-enough baseline;
      // if so the gateway (a) injects a compact-diff directive into the
      // dispatch system and the supplied baseline into the input so the OUTPUT
      // saving is real, and (b) lands one estimate row in the SAME
      // per-technique ledger. It NEVER changes the served agent, model,
      // entitlement, budget, or output contract (the §12 "can never widen
      // entitlement" invariant) — guarded on `routing` like the caching and
      // compaction blocks. "passthrough" is the per-user off switch. The saving
      // is OUTPUT tokens (a small diff vs re-emitting the whole baseline), so
      // dollars = saved tokens at the SERVED agent's OUTPUT list price. Written
      // only when the edit path actually applies.
      const editPlan = planEditVsRewrite({
        baselineTokens,
        requestText: body.input,
        routingMode: policy?.routingMode ?? "automatic",
      });
      if (body.dispatch && editPlan.mode === "edit" && routing) {
        const routed = routing;
        const servedRow = registry.find((a) => a.id === routed.selectedAgentId);
        const estimatedCostSavedUsd =
          servedRow?.costPerMTokOut != null
            ? Number(((editPlan.estimatedTokensSaved / 1e6) * servedRow.costPerMTokOut).toFixed(6))
            : null;
        await db.insert(costEvents).values({
          userId,
          objectType: "agent",
          objectId: agent.id,
          technique: "edit_vs_rewrite",
          requestedAgentId: agent.id,
          servedAgentId: routing.selectedAgentId,
          baselineAgentId: routing.baselineAgentId,
          estimatedTokensIn: estimate.in,
          estimatedTokensOut: estimate.out,
          estimatedTokensSaved: editPlan.estimatedTokensSaved,
          estimatedCostSavedUsd,
          estimationBasis: editPlan.estimationBasis,
          ruleId: "edit-vs-rewrite",
          projectId,
          detail: { baselineTokens, intent: classifyEditIntent(body.input), mode: body.mode },
        });
      }

      // Compose the OUTGOING system + input. Both are ADDITIVE: with neither
      // technique active they are byte-identical to today. Prompt caching
      // supplies the stable `system`; edit-vs-rewrite (when applied) appends a
      // compact-diff directive to that system and the supplied baseline to the
      // input, so the model actually receives the diff instruction + the
      // content it must edit (not just an accounting row).
      let dispatchSystem = systemPrompt;
      let dispatchInput = body.input ?? "";
      if (editPlan.applyDiffDirective && body.baseline) {
        dispatchSystem =
          (systemPrompt ? systemPrompt + "\n\n" : "") +
          "The user is editing the BASELINE content below. Return ONLY a minimal " +
          "unified diff (the changed hunks with a little surrounding context), NOT " +
          "the full rewritten content.";
        dispatchInput = dispatchInput + "\n\n----- BASELINE -----\n" + body.baseline;
      }

      // MULTI-TURN: a conversation dispatch sends the model-bound history —
      // [summary context] + recent verbatim turns when a summary exists, the
      // FULL ordered history otherwise — plus the newest user turn as the
      // provider messages array; the governed pipeline around it (policy,
      // routing, budget, attribution, audit, usage ledger) is exactly the
      // single-turn one.
      const messages: ModelChatMessage[] | undefined =
        convo && body.dispatch
          ? [
              ...(convoContext ? convoContext.modelBound : convo.history),
              { role: "user" as const, content: dispatchInput },
            ]
          : undefined;
      // One persistence rule for the streaming and non-streaming paths —
      // the exact contract lives in conversations.ts. A failed outcome
      // persists nothing (never a half-written turn).
      const persistTurns = async (outcome: DispatchOutcome) => {
        if (!convo || !outcome.ok) return;
        const r = outcome.result;
        await recordConversationTurns(db, convo.conversation, {
          userContent: body.input ?? "",
          assistant: {
            content: r.refusal
              ? r.outputText || "[the model declined to answer this request]"
              : r.outputText,
            detail: {
              stopReason: r.stopReason,
              refusal: r.refusal,
              servedAgentId: r.servedAgentId,
              modelUsed: r.model,
              costUsd: r.costUsd,
              credentialSource: r.credentialSource,
              // §5 transparency: replayed threads keep showing what this
              // turn's model actually saw (summary vs full history)
              ...(convoContext?.publicDetail ? { compaction: convoContext.publicDetail } : {}),
            },
          },
        });
      };

      // MODEL DISPATCH: real execution, strictly after governance + routing —
      // the served agent is routing's choice, so dispatch can never widen
      // entitlement. Measured usage lands in usage_events (pillar 5 actuals).
      // STREAMING (stream: true): the same governed pipeline, delivered as
      // SSE — deltas as they arrive, then ONE result event carrying exactly
      // the payload the JSON path returns. Denials never reach this branch
      // (they respond as plain JSON before any stream opens), and the audit
      // row + usage ledger are written identically after completion.
      if (body.dispatch && body.stream) {
        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const send = (event: string, data: unknown) =>
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        const outcome = await performDispatch(db, opts.dataKey, {
          userId,
          requestedAgentId: agent.id,
          registry,
          routing,
          body,
          projectId,
          messages,
          input: dispatchInput,
          system: dispatchSystem,
          cacheSystem: promptCache.cacheSystem,
          onText: (delta) => send("delta", { text: delta }),
        });
        await persistTurns(outcome);
        await db.insert(auditLog).values({
          userId,
          objectType: "agent",
          objectId: agent.id,
          detail: {
            mode: body.mode,
            servedAgentId: routing.selectedAgentId,
            ...(routing.skippedCandidates ? { routingSkippedCandidates: routing.skippedCandidates } : {}),
            ...(convoContext?.publicDetail ? { compaction: convoContext.publicDetail } : {}),
            stream: true,
            dispatch: outcome.ok
              ? {
                  model: outcome.result.model,
                  stopReason: outcome.result.stopReason,
                  refusal: outcome.result.refusal,
                }
              : { error: outcome.error },
          },
          effect: decision.effect,
          ruleId: decision.ruleId,
          ruleChain: decision.ruleChain,
          reason: decision.reason,
        });
        if (outcome.ok) {
          send("result", {
            decision,
            routing,
            dispatch: outcome.result,
            ...(convoContext?.publicDetail ? { compaction: convoContext.publicDetail } : {}),
          });
        } else {
          send("error", {
            decision,
            routing,
            error: outcome.error,
            ...(outcome.detail ? { detail: outcome.detail } : {}),
            ...(outcome.pii ? { pii: outcome.pii } : {}),
          });
        }
        reply.raw.end();
        return reply;
      }
      if (body.dispatch) {
        dispatchOutcome = await performDispatch(db, opts.dataKey, {
          userId,
          requestedAgentId: agent.id,
          registry,
          routing,
          body,
          projectId,
          messages,
          input: dispatchInput,
          system: dispatchSystem,
          cacheSystem: promptCache.cacheSystem,
        });
        await persistTurns(dispatchOutcome);
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
        ...(routing?.skippedCandidates ? { routingSkippedCandidates: routing.skippedCandidates } : {}),
        ...(convoContext?.publicDetail ? { compaction: convoContext.publicDetail } : {}),
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

    if (decision.effect !== "allow") {
      // A denied conversation turn is recorded honestly (detail.denied, no
      // assistant turn) but never replayed to a provider on later turns —
      // loadOwnConversation filters it out of the model-bound history.
      if (convo && body.dispatch) {
        await recordConversationTurns(db, convo.conversation, {
          userContent: body.input ?? "",
          userDetail: { denied: true, ruleId: decision.ruleId, reason: decision.reason },
        });
      }
      return reply.status(403).send({ decision });
    }
    if (dispatchOutcome && !dispatchOutcome.ok) {
      return reply.status(dispatchOutcome.status).send({
        decision,
        routing,
        error: dispatchOutcome.error,
        ...(dispatchOutcome.detail ? { detail: dispatchOutcome.detail } : {}),
        ...(dispatchOutcome.pii ? { pii: dispatchOutcome.pii } : {}),
      });
    }
    return reply.send({
      decision,
      routing,
      ...(dispatchOutcome ? { dispatch: dispatchOutcome.result } : {}),
      ...(convoContext?.publicDetail ? { compaction: convoContext.publicDetail } : {}),
    });
  });

  // --- connectors (§2) ---

  app.post("/v1/connectors", async (req, reply) => {
    const body = createConnectorSchema.parse(req.body);
    const [row] = await db.insert(connectors).values(body).returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/connectors", async () => ({ connectors: await db.select().from(connectors) }));

  // --- connector credentials (admin-only via the global gate) ---
  // One platform credential per connector, encrypted at rest, never returned —
  // exactly the write-only discipline of the model-credential routes. Keyless
  // kinds (mock, unauthenticated generic) never need one.

  const connectorCredCols = {
    id: connectorCredentials.id,
    connectorId: connectorCredentials.connectorId,
    baseUrl: connectorCredentials.baseUrl,
    createdAt: connectorCredentials.createdAt,
  };

  app.post("/v1/connectors/:connectorId/credential", async (req, reply) => {
    const { connectorId } = connectorIdParam.parse(req.params);
    const body = createConnectorCredentialSchema.parse(req.body);
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }
    const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    if (!connector) return reply.status(404).send({ error: "unknown_connector" });
    const values = {
      connectorId,
      tokenCiphertext: encryptSecret(opts.dataKey, body.token),
      baseUrl: body.baseUrl ?? null,
    };
    const [row] = await db
      .insert(connectorCredentials)
      .values(values)
      .onConflictDoUpdate({ target: connectorCredentials.connectorId, set: values })
      .returning(connectorCredCols);
    return reply.status(201).send(row);
  });

  app.get("/v1/connectors/:connectorId/credential", async (req, reply) => {
    const { connectorId } = connectorIdParam.parse(req.params);
    const [row] = await db
      .select(connectorCredCols)
      .from(connectorCredentials)
      .where(eq(connectorCredentials.connectorId, connectorId));
    // never the secret — only that one is configured, its baseUrl, and when
    return { credential: row ?? null };
  });

  app.delete("/v1/connectors/:connectorId/credential", async (req, reply) => {
    const { connectorId } = connectorIdParam.parse(req.params);
    const deleted = await db
      .delete(connectorCredentials)
      .where(eq(connectorCredentials.connectorId, connectorId))
      .returning({ id: connectorCredentials.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_credential" });
    return { removed: true };
  });

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

    // pillar 5 + ADR-0011: attribution must point at a real project the caller
    // may bill to — mirror the model invoke path. Checked up front, before any
    // execution or metering can happen.
    const projectId = body.projectId ?? null;
    if (projectId) {
      const attribution = await assertProjectAttribution(db, projectId, userId, req.authCtx.isAdmin);
      if (!attribution.ok) return reply.status(attribution.status).send({ error: attribution.error });
    }

    const grants = await db
      .select()
      .from(connectorGrants)
      .where(eq(connectorGrants.userId, userId));

    const decision = evaluateConnector({
      userId,
      connectorId,
      connectorName: connector.name,
      operation: body.operation,
      object: body.object ?? null,
      connectorGrants: grants,
    });

    // THE ONE AUDIT ROW — unchanged, written for every decision (allow or deny).
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

    // A DENIED call bills nothing and executes nothing (mirror the model path).
    if (decision.effect !== "allow") {
      return reply.status(403).send({ decision });
    }

    // EXECUTION runs strictly INSIDE the allow branch, after the audit insert.
    // A connector with no providerKind keeps TODAY'S behaviour exactly:
    // governance-only, no execution, no cost, no usage row.
    if (!connector.providerKind) {
      return reply.send({ decision });
    }
    if (!isConnectorProviderKind(connector.providerKind)) {
      return reply.status(409).send({
        decision,
        error: "unknown_connector_provider",
        detail: `connector '${connector.name}' has an unrecognized provider_kind '${connector.providerKind}'`,
      });
    }

    // Resolve the platform credential (connector_credentials → decrypt with the
    // data key). Keyless kinds (mock, unauthenticated generic) skip it; a keyed
    // kind with no stored credential fails explicit like the model path. A
    // credential.baseUrl overrides the connector's, mirroring model_credentials.
    const keylessKinds = new Set(["mock", "generic", "http", "webhook"]);
    let token: string | null = null;
    let baseUrl: string | null = connector.baseUrl ?? null;
    const [cred] = await db
      .select()
      .from(connectorCredentials)
      .where(eq(connectorCredentials.connectorId, connectorId));
    if (cred) {
      if (!opts.dataKey) {
        return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
      }
      token = decryptSecret(opts.dataKey, cred.tokenCiphertext);
      if (cred.baseUrl) baseUrl = cred.baseUrl;
    } else if (!keylessKinds.has(connector.providerKind)) {
      return reply.status(409).send({
        decision,
        error: "no_connector_credential",
        detail: `connector '${connector.name}' (${connector.providerKind}) has no stored credential`,
      });
    }

    // §8.4 PII ENFORCEMENT (pillar 3), connector path. The effective piiMode
    // comes from the attributed project's cascade; an unattributed/unclassified
    // call yields null and every check is a no-op. The INPUT check runs BEFORE
    // provider.invoke, so a block executes nothing and bills nothing.
    const piiMode: PiiMode | null = projectId ? await projectPiiMode(db, projectId) : null;
    let inputHits: PiiHit[] = [];
    if (piiMode) {
      const chk = enforcePII(piiMode, {
        input: JSON.stringify({ object: body.object ?? null, payload: body.payload ?? null }),
      });
      inputHits = chk.hits;
      if (chk.action === "block") {
        const reason = `input contains PII: ${piiCategoryList(chk.hits)}`;
        await db.insert(auditLog).values({
          userId,
          objectType: "connector",
          objectId: connectorId,
          detail: {
            phase: "pii",
            pii: { mode: piiMode, action: "block", phase: "input", inputHits: chk.hits, outputHits: [] },
            operation: body.operation,
            ...(projectId ? { projectId } : {}),
          },
          effect: "deny",
          ruleId: "pii-blocked",
          ruleChain: [],
          reason,
        });
        return reply.status(403).send({
          decision,
          error: "pii_blocked",
          detail: reason,
          pii: { mode: piiMode, action: "block", inputHits: chk.hits, outputHits: [], withheld: false },
        });
      }
    }

    // Execute. A FAILED call (ConnectorProviderError) bills NOTHING and
    // surfaces as 502 — the same discipline as a failed model dispatch.
    let result;
    try {
      const provider = resolveConnectorProvider({ kind: connector.providerKind, baseUrl, token });
      result = await provider.invoke({
        operation: body.operation,
        object: body.object ?? null,
        payload: body.payload ?? null,
      });
    } catch (err) {
      if (err instanceof ConnectorProviderError) {
        return reply
          .status(502)
          .send({ decision, error: "connector_invoke_failed", detail: err.message });
      }
      throw err;
    }

    // §8.4 OUTPUT check: the call ran, so a block is BILL-AND-WITHHOLD — the
    // usage row records honest spend, but result.body is replaced by the
    // withheld marker and the response is denial-shaped.
    let outputHits: PiiHit[] = [];
    let respBody = result.body;
    let withheld = false;
    if (piiMode) {
      const chk = enforcePII(piiMode, { output: JSON.stringify(result.body ?? null) });
      outputHits = chk.hits;
      if (chk.action === "block") {
        withheld = true;
        respBody = piiWithheldMarker(chk.hits);
      }
    }
    const anyHits = inputHits.length > 0 || outputHits.length > 0;
    const piiAction: "block" | "warn" | "log" = withheld
      ? "block"
      : piiMode === "warn"
        ? "warn"
        : "log";
    const pii =
      piiMode && anyHits
        ? { mode: piiMode, action: piiAction, inputHits, outputHits, withheld }
        : null;

    // pillar 5 actuals: an allowed, executed call bills the connector's flat
    // list price. Unpriced → null, never an invented figure (agents' rule).
    const costUsd = connector.pricePerCallUsd ?? null;
    await db.insert(usageEvents).values({
      userId,
      objectType: "connector",
      connectorId,
      operation: body.operation,
      costUsd,
      projectId,
      detail: {
        status: result.status,
        ...(body.object ? { object: body.object } : {}),
        providerKind: connector.providerKind,
        // §8.4 COUNTS ONLY — never the matched substrings
        ...(pii ? { pii: { mode: pii.mode, action: pii.action, inputHits, outputHits } } : {}),
      },
    });
    // §8.4 audit rows for a PII event (never for a clean payload): an OUTPUT
    // block is a deny; a warn is an allow with 'pii-warned'; log is silent
    // (counts already recorded in the usage detail above).
    if (withheld) {
      await db.insert(auditLog).values({
        userId,
        objectType: "connector",
        objectId: connectorId,
        detail: {
          phase: "pii",
          pii: { mode: piiMode, action: "block", phase: "output", inputHits, outputHits },
          operation: body.operation,
          ...(projectId ? { projectId } : {}),
        },
        effect: "deny",
        ruleId: "pii-blocked",
        ruleChain: [],
        reason: `output contains PII: ${piiCategoryList(outputHits)} — billed and withheld`,
      });
    } else if (piiMode === "warn" && anyHits) {
      await db.insert(auditLog).values({
        userId,
        objectType: "connector",
        objectId: connectorId,
        detail: {
          phase: "pii",
          pii: { mode: piiMode, action: "warn", inputHits, outputHits },
          operation: body.operation,
          ...(projectId ? { projectId } : {}),
        },
        effect: "allow",
        ruleId: "pii-warned",
        ruleChain: [],
        reason: `PII detected (${piiCategoryList([...inputHits, ...outputHits])}) — warned, invoke proceeded`,
      });
    }

    return reply.send({
      decision,
      result: { status: result.status, body: respBody },
      costUsd,
      ...(pii ? { pii } : {}),
    });
  });
}
