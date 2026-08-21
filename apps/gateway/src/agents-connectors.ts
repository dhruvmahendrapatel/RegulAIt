import type { FastifyInstance } from "fastify";
import {
  agentFallbacks,
  agentGrants,
  agents,
  asc,
  auditLog,
  connectorCredentials,
  connectorGrants,
  connectors,
  costEvents,
  and,
  count,
  eq,
  gte,
  inArray,
  isNull,
  customModelProviders,
  modelCredentials,
  sql,
  semanticCache,
  usageEvents,
  userModelCredentials,
  userAgentPolicies,
  users,
  type Db,
} from "@regulait/db";
import { createHash } from "node:crypto";
import { deleteAgentGrantById, deleteConnectorGrantById } from "./grant-revocation.js";
// ADR-0091 — toxic-combination SoD: the mint-time gate on the two direct
// agent/connector grant endpoints (the other seven mint paths live in app.ts).
import { refuseSodMint } from "./sod.js";
import { evaluateAgent, evaluateConnector } from "@regulait/policy-kernel";
import {
  ConnectorProviderError,
  connectorDefaultBaseUrl,
  isConnectorProviderKind,
  parseSnowflakeCredential,
  resolveConnectorProvider,
} from "@regulait/connector-provider";
import {
  classifyComplexity,
  estimateTokens,
  routeModel,
  planPromptCache,
  planEditVsRewrite,
  classifyEditIntent,
  planFilePreprocessing,
  normalizeCacheInput,
  type RoutingDecision,
} from "@regulait/optimizer-kernel";
import {
  defaultBaseUrlFor,
  isModelProviderKind,
  ModelProviderError,
  resolveModelProvider,
  type ModelChatMessage,
  type ModelContentBlock,
  type ModelDispatchRequest,
  type ModelResponseFormat,
  type ModelThinkingBlock,
  type ModelToolChoice,
  type ModelToolDef,
} from "@regulait/model-provider";
import {
  createAgentGrantSchema,
  agentCustomProviderPairValid,
  createAgentSchema,
  createConnectorCredentialSchema,
  createConnectorGrantSchema,
  createConnectorSchema,
  createModelCredentialSchema,
  invokeAgentSchema,
  invokeConnectorSchema,
  setAgentEnabledSchema,
  setAgentFallbacksSchema,
  setAgentLifecycleSchema,
  setAgentOwnerSchema,
  setAgentPolicySchema,
  setAgentSystemPromptSchema,
} from "@regulait/shared";
import type { PiiHit } from "@regulait/shared";
import { guardrailWithheldMarker, guardrailCategoryList } from "@regulait/shared";
import {
  guardrailOutcome,
  recordGuardrailDecision,
  resolveGuardrailPolicy,
  runGuardrails,
  flattenFindings,
  type DispatchGuardrails,
  type GuardrailPolicy,
} from "./guardrails.js";
import { mrmDispatchGate } from "./mrm.js";
// ADR-0079: pillar 2 §2 stage 2 — the invoke→instance join point and the
// plan-only refusal it makes possible.
import { guardInstanceAttributedCall } from "./plan-only.js";
import { newVersion, resolveAgentPromptVersion } from "./config-versions.js";
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
import {
  loadAgentRevocations,
  loadConnectorRevocations,
  loadRoleAgentGrants,
  loadRoleConnectorGrants,
} from "./entitlements.js";
import {
  effectiveTechniqueMode,
  envFallbackAllowed,
  loadOrgSettings,
} from "./org-settings.js";
import { loadInterceptionSettings } from "./compat-core.js";
import { resolveCustomProviderForDispatch } from "./custom-providers.js";
import { resolveArtifactProviderForDispatch } from "./regulait-llm.js";
import type { ArtifactModelProvider } from "@regulait/training-provider";
import { egressRefusal } from "./egress-guard.js";
import { refuseIfExpansionBlocked } from "./licensing.js";
import { checkCredentialBaseUrl, credentialGuardedFetch } from "./credential-egress.js";
import {
  ConnectionEgressBlockedError,
  guardConnectionCall,
  refuseConnectionEgressWrite,
  type ConnectionSurface,
} from "./connection-egress.js";
// ADR-0062 — the deployment-wide egress posture and the compiled-vendor-default
// admission decision it gates.
import {
  auditCompiledDefaultDenied,
  decideCompiledDefault,
  loadCompiledEgressContext,
} from "./compiled-egress.js";
// ADR-0066 — the virtual-key ceiling (allow-list + budget) and the per-key
// spend counter. Applied INSIDE the one dispatch core, so every caller of it
// inherits both without a check of its own.
import {
  loadVirtualKeyContext,
  recordVirtualKeySpend,
  virtualKeyAllowListRefusal,
  virtualKeyBudgetRefusal,
  type VirtualKeyContext,
} from "./virtual-keys.js";
// ADR-0070 — the trace recorder. Wrapped AROUND the one dispatch attempt so
// every governed caller (invoke, both compat shims, orchestration workers,
// evals, the copilot, decompose) is traced without a line of its own, and so a
// governance DENY becomes a PRESENT span carrying its reason.
import {
  beginTrace,
  finishTrace,
  loadTracingPolicy,
  recordSpan,
  traceForRoot,
  type TraceContext,
} from "./tracing.js";

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
/**
 * The project's PII input gate, hoisted so it can run BEFORE the two things
 * that used to sit in front of it and let PII through:
 *
 *  1. the semantic-cache serve — a cache hit returned the cached output and the
 *     request never reached `dispatchAttempt`, where the only PII gate lived. A
 *     PII prompt cached under an ungated (no-project) call was then served
 *     verbatim on a HIPAA-attributed replay. This is a compliance BYPASS, found
 *     driving pillar 3 end-to-end.
 *  2. the per-technique cost_events writes (`model_routing`, `context_compaction`,
 *     …) — those were written in the handler BEFORE dispatch, so a call that
 *     `dispatchAttempt` then blocked on PII still left phantom estimate rows
 *     attributed to the project, skewing savings-by-technique reporting.
 *
 * Running the input gate here fixes both: a blocked call returns 403 before any
 * cache serve and before any estimate row is written. `dispatchAttempt` keeps
 * its own input+output gate — that path is also reached by orchestration and
 * worker-node dispatch, which do not pass through this handler, so it is
 * defense-in-depth, not redundancy. Both gates share one audit shape and one
 * `pii-blocked` rule id, and a clean input simply passes both.
 *
 * Returns the block result (already audited) or null when the input is clean or
 * the project has no PII mode.
 */
async function enforceProjectInputPii(
  db: Db,
  userId: string,
  agentObjectId: string,
  projectId: string | null,
  input: string | undefined,
): Promise<{ status: 403; error: "pii_blocked"; detail: string; pii: DispatchPii } | null> {
  const piiMode = await projectPiiMode(db, projectId);
  if (!piiMode) return null;
  const chk = enforcePII(piiMode, { input });
  if (chk.action !== "block") return null;
  const detail = `input contains PII: ${piiCategoryList(chk.hits)}`;
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
    objectId: agentObjectId,
    detail: {
      phase: "pii",
      pii: { mode: piiMode, action: "block", phase: "input", inputHits: chk.hits, outputHits: [] },
      ...(projectId ? { projectId } : {}),
    },
    effect: "deny",
    ruleId: "pii-blocked",
    ruleChain: [],
    reason: detail,
  });
  return { status: 403, error: "pii_blocked", detail, pii };
}

/**
 * The OUTPUT counterpart for the cache-hit path. The input may be clean while
 * the CACHED output carries PII (it was generated under a different, ungated
 * attribution). Serving that cached output on a project whose mode is `block`
 * would leak it, so the cached text is checked before it is served, with the
 * same audit shape as the input gate above.
 */
async function enforceProjectCachedOutputPii(
  db: Db,
  userId: string,
  agentObjectId: string,
  projectId: string | null,
  outputText: string,
): Promise<{ status: 403; error: "pii_blocked"; detail: string; pii: DispatchPii } | null> {
  const piiMode = await projectPiiMode(db, projectId);
  if (!piiMode) return null;
  const chk = enforcePII(piiMode, { output: outputText });
  if (chk.action !== "block") return null;
  const detail = `cached output withheld: contains PII (${piiCategoryList(chk.hits)})`;
  const pii: DispatchPii = {
    mode: piiMode,
    action: "block",
    inputHits: [],
    outputHits: chk.hits,
    withheld: true,
  };
  await db.insert(auditLog).values({
    userId,
    objectType: "agent",
    objectId: agentObjectId,
    detail: {
      phase: "pii",
      pii: { mode: piiMode, action: "block", phase: "output", inputHits: [], outputHits: chk.hits },
      semanticCache: { hit: true },
      ...(projectId ? { projectId } : {}),
    },
    effect: "deny",
    ruleId: "pii-blocked",
    ruleChain: [],
    reason: detail,
  });
  return { status: 403, error: "pii_blocked", detail, pii };
}

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
        /** ADR-0020 long tail: the extended-thinking blocks the model emitted
         * (signature intact), threaded from the provider result so the compat
         * surface can render them; withheld along with the output on a PII
         * output block. Their tokens are already inside usage.outputTokens. */
        thinking?: ModelThinkingBlock[];
        usage: { inputTokens: number; outputTokens: number };
        costUsd: number | null;
        measuredCostSavedUsd: number | null;
        credentialSource: "user" | "platform" | "none";
        projectBudgetAlerted: boolean;
        /** §8.4: present only when a classified project's PII policy acted */
        pii?: DispatchPii;
        /** ADR-0042: present only when a guardrail detector produced hits */
        guardrails?: DispatchGuardrails;
        /** ADR-0066 §4: present ONLY when the primary target failed at the
         * transport layer and a configured fallback hop served instead. Its
         * presence is the disclosure — a fallback is never silent. */
        fallback?: DispatchFallback;
      };
      /** ADR-0070: where this call landed in the trace tree. Present whenever
       * tracing is enabled; absent when the org switched it off. */
      trace?: DispatchTraceRef;
    }
  | {
      ok: false;
      status: number;
      error: string;
      detail?: string;
      pii?: DispatchPii;
      guardrails?: DispatchGuardrails;
      /** ADR-0066 §4: present when a chain was attempted and exhausted, so the
       * caller sees WHICH hops were tried and why each one did not serve. */
      fallback?: DispatchFallback;
      /** ADR-0070: a REFUSAL gets a trace reference too — that is the whole
       * point. The span it names carries `status: 'denied'` and the reason. */
      trace?: DispatchTraceRef;
    };

/** ADR-0070 — the trace coordinates of one dispatch attempt. */
export interface DispatchTraceRef {
  traceId: string;
  spanId: string | null;
}

/** ADR-0066 §4 — what happened on the way to the answer. One entry per hop
 * ATTEMPTED, in order, including the hops that were skipped for governance
 * reasons: a chain that quietly dropped an unentitled hop would make a
 * fallback look like a routing decision nobody made. */
export interface DispatchFallback {
  /** the agent the caller actually asked for (chain position -1) */
  primaryAgentId: string;
  /** the agent that ultimately served; null when the whole chain failed */
  servedAgentId: string | null;
  hops: Array<{
    position: number;
    agentId: string;
    agentName: string;
    outcome: "served" | "denied" | "failed" | "unavailable";
    /** why this hop did not serve; absent on the hop that did */
    reason?: string;
  }>;
}

/** The arguments of the one governed-dispatch core. Extracted as a named type
 * by ADR-0066 so the fallback driver and the single-attempt body share exactly
 * one definition rather than two that agree today. */
export interface GovernedDispatchArgs {
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
  /** ADR-0020 long tail: constrain which tools the model may/must call.
   * Pure ModelDispatchRequest threading — validated upstream by the shims. */
  toolChoice?: ModelToolChoice | undefined;
  /** ADR-0020 long tail: structured-output constraint. The caller has
   * already checked the served provider can honour it. */
  responseFormat?: ModelResponseFormat | undefined;
  /** ADR-0020 long tail: Anthropic extended thinking. The caller has
   * already checked the served provider can honour it. */
  thinking?: { budgetTokens: number } | undefined;
  maxTokens?: number | undefined;
  /** pillar 5 attribution: the project this call bills to */
  projectId?: string | null | undefined;
  /** streaming delta callback, forwarded to the provider */
  onText?: ((delta: string) => void) | undefined;
  /** streaming thinking-delta callback, forwarded to the provider */
  onThinking?: ModelDispatchRequest["onThinking"] | undefined;
  detail?: Record<string, unknown>;
  /** ADR-0066 §2/§3 — the virtual key this call arrived on, when it did. Its
   * allow-list and budget are applied INSIDE the core so no caller can forget
   * them; absent/null on every ordinary path, where every check below is a
   * no-op and the behaviour is byte-identical to pre-0066. */
  virtualKey?: VirtualKeyContext | null | undefined;
  /** ADR-0066 §4 — the mode a FALLBACK HOP is re-evaluated under. Only the
   * chain driver reads it; a hop must be entitlement-checked in the same mode
   * the primary was, or a `plan`-only grant could serve an `execute` call. */
  mode?: string | undefined;
  /** ADR-0070 — the trace this attempt's span hangs from.
   *
   *  - UNDEFINED (every ordinary caller): the core RESOLVES one from
   *    `detail.runId` / `detail.conversationId`, or opens a standalone trace,
   *    and closes it. Nothing to remember at any call site.
   *  - a context: the caller owns the tree (the orchestration run path, the
   *    fallback driver) and this attempt hangs under `parentSpanId`.
   *  - EXPLICIT NULL: record nothing. Used by the fallback driver's own
   *    bookkeeping and by anything that has already recorded the span itself.
   */
  trace?: TraceContext | null | undefined;
  /** ADR-0070 — override the span's displayed name. Absent = derived from the
   * served agent. Used by the fallback driver to label a hop. */
  traceSpanName?: string | undefined;
  /** ADR-0070 — the span kind this attempt records as. Defaults to `llm`; the
   * fallback driver passes `fallback_hop`. */
  traceSpanKind?: "llm" | "fallback_hop" | undefined;
}

/**
 * ADR-0066 §4 — THE ONE GOVERNED-DISPATCH ENTRY POINT, now with fallback.
 *
 * Shared by the direct invoke path, both compat shims, the orchestration
 * worker-node path, evals, the copilot and decompose. The served agent is an
 * INPUT — this function never picks a model; governance and (where applicable)
 * routing have already happened upstream.
 *
 * What it adds over `dispatchOnce` is the chain, and the chain has exactly four
 * rules, each of which is a test in `gateway-parity.test.ts`:
 *
 *  1. **A GOVERNANCE DENY IS NOT A FAILURE.** Only a transport/upstream error
 *     (`model_dispatch_failed`) triggers the chain. An entitlement denial, a
 *     PII or guardrail block, an egress refusal, an MRM refusal, an exhausted
 *     project or key budget, a missing credential, an undispatchable agent —
 *     every one of those is a DECISION, and retrying a decision somewhere else
 *     is how a governance product turns into a bypass. This is the subtle one
 *     and it is asserted directly.
 *  2. **ENTITLEMENT IS RE-EVALUATED PER HOP, FROM SCRATCH.** A hop never
 *     inherits the primary's allow. It runs the caller's own `evaluateAgent`
 *     again — same grants, same revocations, same tier ceiling, same mode — and
 *     a hop the caller may not use is SKIPPED and audited, never served.
 *  3. **EGRESS POSTURE IS RE-EVALUATED PER HOP**, because each hop runs the
 *     whole of `dispatchOnce`, including ADR-0062's compiled-default admission
 *     and ADR-0034's baseUrl guard. There is no shortcut path.
 *  4. **EVERY HOP IS AUDITED.** A fallback is visible in the trail and in the
 *     response (`result.fallback`), never silent. "Which model actually
 *     answered, and why not the one I asked for" must be answerable afterwards.
 *
 * An agent with no `agent_fallbacks` rows — every agent, until an admin
 * configures one — takes exactly one extra indexed SELECT on the failure path
 * only, and is otherwise byte-identical to the pre-0066 core.
 */
export async function executeGovernedDispatch(
  db: Db,
  dataKey: string | undefined,
  args: GovernedDispatchArgs,
): Promise<DispatchOutcome> {
  const primary = await dispatchOnce(db, dataKey, args);
  if (primary.ok) return primary;
  // RULE 1. Everything except a transport/upstream failure is a decision.
  if (primary.error !== "model_dispatch_failed") return primary;
  if (!args.served) return primary;

  // ADR-0070 — RULE 5 (added by this ADR, and the reason a trace exists at all
  // for this feature): EVERY HOP IS A SPAN, NESTED UNDER THE ATTEMPT THAT
  // FAILED. A silent fallback is precisely what a trace is for, and ADR-0066's
  // audit rows — while complete — require knowing to go looking. The hop spans
  // hang from the primary attempt's span so the tree reads "I asked for X, it
  // failed at the transport layer, and here is what was tried instead". A hop
  // SKIPPED for governance reasons is a span too, `status: 'denied'`, for the
  // same reason ADR-0066 audits it: a chain that quietly dropped an unentitled
  // hop would make a fallback look like a routing decision nobody made.
  const hopTrace: TraceContext | null = primary.trace
    ? {
        traceId: primary.trace.traceId,
        parentSpanId: primary.trace.spanId,
        sessionId: null,
        policy: await loadTracingPolicy(db),
      }
    : null;
  const recordSkippedHop = async (
    label: { position: number; agentId: string; agentName: string },
    reason: string,
    ruleId: string,
  ) => {
    if (!hopTrace) return;
    const at = new Date();
    await recordSpan(db, hopTrace, {
      kind: "fallback_hop",
      name: `fallback ${label.position}: ${label.agentName}`,
      status: "denied",
      statusReason: reason,
      startedAt: at,
      endedAt: at,
      agentId: label.agentId,
      attributes: { fallbackPosition: label.position, ruleId, primaryAgentId: args.served!.id },
    });
  };

  const chain = await db
    .select()
    .from(agentFallbacks)
    .where(eq(agentFallbacks.agentId, args.served.id))
    .orderBy(asc(agentFallbacks.position));
  if (chain.length === 0) return primary;

  const primaryAgent = args.served;
  const hops: DispatchFallback["hops"] = [];

  // The caller's entitlement inputs, loaded ONCE for the whole chain — the same
  // inputs, in the same shape, that `compat-core.ts` and the invoke path build.
  // Loading them once is a query optimisation, not a policy shortcut: each hop
  // still runs its own `evaluateAgent` against them.
  const [grants, roleGrants, revocationRows, [policy]] = await Promise.all([
    db.select().from(agentGrants).where(eq(agentGrants.userId, args.userId)),
    loadRoleAgentGrants(db, args.userId),
    loadAgentRevocations(db, args.userId),
    db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, args.userId)),
  ]);
  let ceilingTier: number | null = null;
  if (policy?.ceilingAgentId) {
    const [ceiling] = await db
      .select({ tier: agents.tier })
      .from(agents)
      .where(eq(agents.id, policy.ceilingAgentId));
    ceilingTier = ceiling?.tier ?? null;
  }
  const hopMode = args.mode ?? "execute";

  const auditHop = async (
    hop: { position: number; agentId: string; agentName: string },
    effect: "allow" | "deny",
    ruleId: string,
    reason: string,
    extra: Record<string, unknown> = {},
  ) => {
    await db.insert(auditLog).values({
      userId: args.userId,
      objectType: "agent",
      objectId: hop.agentId,
      detail: {
        phase: "fallback",
        primaryAgentId: primaryAgent.id,
        primaryAgentName: primaryAgent.name,
        position: hop.position,
        mode: hopMode,
        ...(args.projectId ? { projectId: args.projectId } : {}),
        ...(args.virtualKey ? { virtualKeyId: args.virtualKey.id } : {}),
        ...extra,
      },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  };

  for (const link of chain) {
    const [hopAgent] = await db.select().from(agents).where(eq(agents.id, link.fallbackAgentId));
    const label = { position: link.position, agentId: link.fallbackAgentId, agentName: hopAgent?.name ?? "(unknown)" };
    if (!hopAgent || !hopAgent.enabled) {
      const reason = hopAgent
        ? `fallback hop '${hopAgent.name}' is disabled`
        : `fallback hop ${link.fallbackAgentId} no longer exists`;
      hops.push({ ...label, outcome: "unavailable", reason });
      await auditHop(label, "deny", "fallback-hop-unavailable", reason);
      await recordSkippedHop(label, reason, "fallback-hop-unavailable");
      continue;
    }
    // RULE 2 — re-evaluate, never inherit.
    const decision = evaluateAgent({
      userId: args.userId,
      agent: {
        id: hopAgent.id,
        name: hopAgent.name,
        tier: hopAgent.tier,
        enabled: hopAgent.enabled,
        modes: hopAgent.modes ?? null,
      },
      mode: hopMode,
      agentGrants: grants,
      roleAgentGrants: roleGrants,
      agentRevocations: revocationRows,
      ceilingTier,
    });
    if (decision.effect !== "allow") {
      hops.push({ ...label, outcome: "denied", reason: decision.reason });
      await auditHop(label, "deny", "fallback-hop-denied", decision.reason, {
        kernelRuleId: decision.ruleId,
      });
      await recordSkippedHop(label, decision.reason, "fallback-hop-denied");
      continue;
    }
    // The virtual key's own ceiling applies to hops too — a fallback must not
    // be the way a key reaches a model its allow-list excludes.
    if (args.virtualKey) {
      const refusal = virtualKeyAllowListRefusal(args.virtualKey, hopAgent);
      if (refusal) {
        hops.push({ ...label, outcome: "denied", reason: refusal.detail });
        await auditHop(label, "deny", refusal.ruleId, refusal.detail);
        await recordSkippedHop(label, refusal.detail, refusal.ruleId);
        continue;
      }
    }

    const outcome = await dispatchOnce(db, dataKey, {
      ...args,
      served: hopAgent,
      // ADR-0070: this hop's span is a CHILD of the primary attempt's span.
      trace: hopTrace,
      traceSpanKind: "fallback_hop",
      traceSpanName: `fallback ${link.position}: ${hopAgent.name}`,
      // The baseline is a ROUTING counterfactual; a fallback is not routing, so
      // carrying the primary's baseline here would invent a savings figure for
      // a decision the optimizer never made.
      baseline: null,
      detail: {
        ...(args.detail ?? {}),
        fallbackFromAgentId: primaryAgent.id,
        fallbackPosition: link.position,
      },
    });
    if (outcome.ok) {
      hops.push({ ...label, outcome: "served" });
      await auditHop(
        label,
        "allow",
        "fallback-hop-served",
        `primary agent '${primaryAgent.name}' failed at the transport layer; fallback hop ${link.position} ('${hopAgent.name}') served instead`,
      );
      return {
        ok: true,
        result: {
          ...outcome.result,
          fallback: { primaryAgentId: primaryAgent.id, servedAgentId: hopAgent.id, hops },
        },
        // the trace the CALLER is handed is the one containing the whole story:
        // the failed primary attempt AND the hop that served under it.
        ...(primary.trace ? { trace: primary.trace } : {}),
      };
    }
    const reason = outcome.detail ?? outcome.error;
    // A hop that is itself DENIED (its own PII/guardrail/budget/egress verdict)
    // is recorded as denied, not failed — the distinction is the whole point of
    // rule 1 and it must survive into the trail.
    const isFailure = outcome.error === "model_dispatch_failed";
    hops.push({ ...label, outcome: isFailure ? "failed" : "denied", reason });
    await auditHop(
      label,
      "deny",
      isFailure ? "fallback-hop-failed" : "fallback-hop-denied",
      reason,
      { hopError: outcome.error },
    );
  }

  await auditHop(
    { position: -1, agentId: primaryAgent.id, agentName: primaryAgent.name },
    "deny",
    "fallback-chain-exhausted",
    `every configured fallback for '${primaryAgent.name}' was exhausted; returning the primary failure`,
    { attempted: hops.length },
  );
  // The ORIGINAL failure is what the caller gets back — a chain that swapped in
  // the last hop's error would hide which target they actually asked for.
  return {
    ...primary,
    fallback: { primaryAgentId: primaryAgent.id, servedAgentId: null, hops },
  };
}

/**
 * ADR-0070 — what the traced attempt could not learn from the outcome alone.
 * Populated by `dispatchAttempt` as it writes the rows the span REFERENCES.
 * Deliberately a mutable sink rather than an addition to `DispatchOutcome`:
 * the ids of the ledger and audit rows are plumbing, and no caller of the
 * dispatch core should have to think about them.
 */
interface DispatchTraceSink {
  usageEventId?: string | null;
  auditLogId?: string | null;
  /** the served provider/model, known even on refusals that never dispatched */
  provider?: string | null;
  model?: string | null;
  /** the text the caller may see — post-PII/guardrail substitution */
  outputText?: string | null;
  contentWithheld?: boolean;
  stopReason?: string | null;
}

/**
 * ADR-0070 — resolve which trace this attempt belongs to when the caller did
 * not name one. Three cases, in this order:
 *
 *   `detail.runId`     -> the RUN's tree (so every node dispatch of a run lands
 *                         in one tree rather than N unrelated ones). This is a
 *                         fallback: the orchestration path passes an explicit
 *                         context so the dispatch nests under its node span.
 *   `detail.conversationId` -> a per-turn trace grouped by the conversation as
 *                         the SESSION id. That is the thread grouping: a
 *                         multi-turn conversation reads as one thing.
 *   otherwise          -> a standalone one-shot trace.
 */
async function resolveDispatchTrace(
  db: Db,
  args: GovernedDispatchArgs,
): Promise<{ ctx: TraceContext | null; owned: boolean }> {
  if (args.trace !== undefined) return { ctx: args.trace, owned: false };
  const policy = await loadTracingPolicy(db);
  if (!policy.enabled) return { ctx: null, owned: false };
  const detail = args.detail ?? {};
  const runId = typeof detail["runId"] === "string" ? (detail["runId"] as string) : null;
  const conversationId =
    typeof detail["conversationId"] === "string" ? (detail["conversationId"] as string) : null;
  if (runId) {
    const ctx = await traceForRoot(
      db,
      {
        kind: "run",
        name: `run ${runId}`,
        userId: args.userId,
        projectId: args.projectId ?? null,
        sessionId: runId,
        rootRefId: runId,
      },
      policy,
    );
    // NOT owned: a run's trace is closed when the run reaches a terminal state,
    // not when one of its dispatches returns.
    return { ctx, owned: false };
  }
  const ctx = await beginTrace(
    db,
    {
      kind: conversationId ? "conversation" : "dispatch",
      name: args.served ? `dispatch ${args.served.name}` : "dispatch",
      userId: args.userId,
      projectId: args.projectId ?? null,
      sessionId: conversationId,
      rootRefId: conversationId,
    },
    policy,
  );
  return { ctx, owned: !!ctx };
}

/**
 * ADR-0070 — ONE governed dispatch attempt, TRACED.
 *
 * This is a thin wrapper and it is deliberately the ONLY place a dispatch span
 * is written. Everything governance-bearing stays in `dispatchAttempt` below,
 * untouched; this function times it, records exactly one span from whatever
 * came back, and returns the outcome with the span's coordinates attached.
 *
 * THE RULE THIS SHAPE EXISTS TO ENFORCE: **a refusal produces a span too.**
 * Every early return in `dispatchAttempt` — a virtual key's allow-list, the
 * MRM gate, a project budget, a §8.4 PII block, an ADR-0042 guardrail block, an
 * egress refusal, a missing credential, an undispatchable agent — flows through
 * here and lands as `status: 'denied'` carrying its stated reason. A trace that
 * showed only the calls that happened would answer "why did nothing happen"
 * with silence, which is the single question this feature exists for.
 *
 * `model_dispatch_failed` is the one non-decision: it records as `error`, not
 * `denied`, because it is a transport fault rather than a verdict — the same
 * distinction ADR-0066's rule 1 draws when deciding whether to hop.
 */
async function dispatchOnce(
  db: Db,
  dataKey: string | undefined,
  args: GovernedDispatchArgs,
): Promise<DispatchOutcome> {
  const { ctx, owned } = await resolveDispatchTrace(db, args);
  const startedAt = new Date();
  const sink: DispatchTraceSink = {};
  let outcome: DispatchOutcome;
  try {
    outcome = await dispatchAttempt(db, dataKey, args, sink);
  } catch (err) {
    // An unexpected throw is still a thing that happened to a governed call.
    if (ctx) {
      await recordSpan(db, ctx, {
        kind: args.traceSpanKind ?? "llm",
        name: args.traceSpanName ?? (args.served ? args.served.name : "dispatch"),
        status: "error",
        statusReason: (err as Error)?.message ?? "dispatch threw",
        startedAt,
        agentId: args.served?.id ?? null,
        provider: sink.provider ?? args.served?.provider ?? null,
        model: sink.model ?? args.served?.model ?? null,
        ...(args.projectId ? { attributes: { projectId: args.projectId } } : {}),
      });
      if (owned) await finishTrace(db, ctx, "error", startedAt);
    }
    throw err;
  }

  if (!ctx) return outcome;

  const detail = args.detail ?? {};
  const runId = typeof detail["runId"] === "string" ? (detail["runId"] as string) : null;
  const nodeId = typeof detail["nodeId"] === "string" ? (detail["nodeId"] as string) : null;
  const attributes: Record<string, unknown> = {
    requestedAgentId: args.requestedAgentId,
    ...(args.projectId ? { projectId: args.projectId } : {}),
    ...(args.virtualKey ? { virtualKeyId: args.virtualKey.id } : {}),
    ...(typeof detail["turn"] === "number" ? { turn: detail["turn"] } : {}),
    ...(typeof args.traceSpanKind === "string" && args.traceSpanKind === "fallback_hop"
      ? { fallbackPosition: detail["fallbackPosition"] ?? null }
      : {}),
  };

  let spanId: string | null;
  if (outcome.ok) {
    const r = outcome.result;
    attributes["stopReason"] = r.stopReason;
    if (r.refusal) attributes["providerRefusal"] = true;
    if (r.credentialSource) attributes["credentialSource"] = r.credentialSource;
    if (r.pii) attributes["pii"] = { mode: r.pii.mode, action: r.pii.action, withheld: r.pii.withheld };
    if (r.guardrails) {
      attributes["guardrails"] = { action: r.guardrails.action, withheld: r.guardrails.withheld };
    }
    spanId = await recordSpan(db, ctx, {
      kind: args.traceSpanKind ?? "llm",
      name: args.traceSpanName ?? (args.served ? args.served.name : "dispatch"),
      status: "ok",
      startedAt,
      agentId: r.servedAgentId,
      runId,
      nodeId,
      // THE REFERENCE. The five denormalised figures below were copied FROM
      // this row, in the same call that inserted it.
      usageEventId: sink.usageEventId ?? null,
      provider: sink.provider ?? args.served?.provider ?? null,
      model: r.model,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      costUsd: r.costUsd,
      inputText: args.input,
      // ALREADY-ADJUDICATED text: the withheld marker is already substituted.
      outputText: r.outputText,
      contentWithheld: !!(r.pii?.withheld || r.guardrails?.withheld),
      attributes,
    });
    if (owned) await finishTrace(db, ctx, "ok", startedAt);
    return { ...outcome, trace: { traceId: ctx.traceId, spanId } };
  }

  attributes["error"] = outcome.error;
  const isTransport = outcome.error === "model_dispatch_failed";
  spanId = await recordSpan(db, ctx, {
    kind: args.traceSpanKind ?? "llm",
    name: args.traceSpanName ?? (args.served ? args.served.name : "dispatch"),
    status: isTransport ? "error" : "denied",
    statusReason: outcome.detail ?? outcome.error,
    startedAt,
    agentId: args.served?.id ?? null,
    runId,
    nodeId,
    auditLogId: sink.auditLogId ?? null,
    provider: sink.provider ?? args.served?.provider ?? null,
    model: sink.model ?? args.served?.model ?? null,
    // A refusal that never dispatched has no input preview worth storing when
    // the refusal WAS about the input (a PII/guardrail block): storing the very
    // text a block refused would defeat the block. `pii_blocked` and
    // `guardrail_blocked` therefore carry the marker, not the prompt.
    inputText:
      outcome.error === "pii_blocked" || outcome.error === "guardrail_blocked"
        ? (outcome.detail ?? null)
        : args.input,
    contentWithheld: outcome.error === "pii_blocked" || outcome.error === "guardrail_blocked",
    attributes,
  });
  if (owned) await finishTrace(db, ctx, isTransport ? "error" : "denied", startedAt);
  return { ...outcome, trace: { traceId: ctx.traceId, spanId } };
}

/**
 * ONE governed dispatch ATTEMPT. This is the pre-ADR-0066 body of
 * `executeGovernedDispatch`, unchanged except for the two virtual-key checks
 * and the per-key spend counter. It never recurses and knows nothing about
 * fallback chains, which is what makes the driver above's rules provable.
 *
 * Config problems (no model id, unknown provider, missing credential) fail
 * explicit, never fall back to a different model. Every execution lands one
 * MEASURED row in usage_events.
 *
 * ADR-0070 renamed this from `dispatchOnce` and wrapped it (above). Nothing in
 * this body decides anything about tracing beyond populating `sink` with the
 * ids of rows it was already writing.
 */
async function dispatchAttempt(
  db: Db,
  dataKey: string | undefined,
  args: GovernedDispatchArgs,
  sink: DispatchTraceSink = {},
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
  // ADR-0070: the served provider/model, known here and therefore attachable to
  // EVERY span below including the refusals that never reach the provider.
  sink.provider = served.provider;
  sink.model = served.model;

  // ADR-0089 — THE AGENT LIFECYCLE GATE (gap L20). Retired is TERMINAL for
  // governance purposes: a retired agent refuses dispatch with a named 409,
  // the ADR-0045 gate idiom — refusal before ANY provider work, cost, or
  // content processing, audited with the lifecycle reason. Placed in this ONE
  // shared core so direct invokes, orchestration workers, fallback hops and
  // both compat shims inherit it. The agent's grants still EVALUATE (nothing
  // here deletes or bypasses entitlement rows — every caller already ran
  // evaluateAgent); the refusal is a lifecycle decision layered after them,
  // which keeps the entitlement history readable and the retirement
  // reversible as a record, never as a dispatch. `deprecated` deliberately
  // does NOT appear here: deprecation only WARNS in the ADR-0082 inventory.
  if (served.lifecycleStatus === "retired") {
    const [lcRow] = await db
      .insert(auditLog)
      .values({
        userId,
        objectType: "agent",
        objectId: served.id,
        detail: {
          phase: "dispatch",
          agentId: served.id,
          agentName: served.name,
          model: served.model,
          lifecycleStatus: "retired",
          lifecycleReason: served.lifecycleReason,
          ...(args.projectId ? { projectId: args.projectId } : {}),
        },
        effect: "deny",
        ruleId: "agent-retired-dispatch-refused",
        ruleChain: [],
        reason: `agent '${served.name}' is retired${served.lifecycleReason ? ` (${served.lifecycleReason})` : ""} — a retired agent refuses dispatch; its grants and history remain readable`,
      })
      .returning({ id: auditLog.id });
    sink.auditLogId = lcRow?.id ?? null;
    return {
      ok: false,
      status: 409,
      error: "agent_retired",
      detail: `agent '${served.name}' is retired${served.lifecycleReason ? `: ${served.lifecycleReason}` : ""} — retirement is terminal; re-registering is a new agent`,
    };
  }

  // ADR-0066 §2/§3 — THE VIRTUAL-KEY CEILING. Placed FIRST, before the MRM
  // gate and before any provider work, for the same reason every gate below is
  // where it is: a refusal here must cost nothing — no tokens, no usage row, no
  // network. Both checks are pure functions of the key row, so on every
  // ordinary call (`virtualKey` absent) this block is two null checks.
  //
  // THE INVARIANT. This runs AFTER the caller's `evaluateAgent` — every caller
  // of this function has already made that decision — and can therefore only
  // ever SUBTRACT from it. There is no branch here that turns a deny into an
  // allow, which is what makes "a key can only narrow" a property of the code
  // rather than of the documentation.
  const vk = args.virtualKey ?? null;
  if (vk) {
    const allowList = virtualKeyAllowListRefusal(vk, served);
    const refusal = allowList ?? virtualKeyBudgetRefusal(vk);
    if (refusal) {
      const [vkRow] = await db.insert(auditLog).values({
        userId,
        objectType: "virtual_key",
        objectId: vk.id,
        detail: {
          phase: "dispatch",
          agentId: served.id,
          agentName: served.name,
          model: served.model,
          ...(vk.budgetUsd !== null ? { budgetUsd: vk.budgetUsd, spentUsd: vk.spentUsd } : {}),
          ...(args.projectId ? { projectId: args.projectId } : {}),
        },
        effect: "deny",
        ruleId: refusal.ruleId,
        ruleChain: [],
        reason: refusal.detail,
      }).returning({ id: auditLog.id });
      sink.auditLogId = vkRow?.id ?? null;
      return { ok: false, status: refusal.status, error: refusal.error, detail: refusal.detail };
    }
  }

  // ADR-0045 — MODEL RISK MANAGEMENT GATE. Placed HERE: after the caller's
  // entitlement decision (every caller of this function has already run
  // evaluateAgent) and before ANY provider work, cost, or content processing.
  //
  // Default-OFF (`org_settings.mrm_enforced`), so with the toggle untouched
  // this is one settings read and byte-identical behaviour. When ON it refuses
  // a model that carries no model card with an UNEXPIRED approved risk
  // sign-off — 409 `mrm_approval_required`, audited with a ruleId that
  // distinguishes "never reviewed" from "review lapsed". The gate recomputes
  // expiry from `valid_until` on every call rather than trusting the stored
  // status, so a lapsed certification stops dispatch even in a deployment that
  // never runs the sweep. That is what makes expiry a control instead of a badge.
  const mrmRefusal = await mrmDispatchGate(db, {
    userId,
    agentId: served.id,
    agentName: served.name,
    model: served.model,
    customProviderId: served.customProviderId ?? null,
    projectId: args.projectId ?? null,
  });
  if (mrmRefusal) {
    return {
      ok: false,
      status: mrmRefusal.status,
      error: mrmRefusal.error,
      detail: mrmRefusal.detail,
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
      const [piiRow] = await db.insert(auditLog).values({
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
      }).returning({ id: auditLog.id });
      sink.auditLogId = piiRow?.id ?? null;
      return { ok: false, status: 403, error: "pii_blocked", detail: reason, pii };
    }
  }

  // ADR-0042 GUARDRAIL ENGINE (pillar 1/3). The SAME interception point and the
  // SAME two phases §8.4's PII enforcement uses, generalized to a registry of
  // detectors. PII is deliberately EXCLUDED from the engine's dispatch-time
  // evaluation (`runGuardrails` passes exclude:['pii']) because the dedicated
  // path above already enforces it with ADR-0019's exact response and audit
  // semantics — double-enforcing would double-audit and change those semantics.
  // PII remains classifier #1 in the registry itself.
  //
  // The effective modes are MAX-composed from the org default, this agent's
  // override, and the attributed project's compliance floor — so a framework
  // can raise a layer and no local setting can lower it.
  const guardrails = await resolveGuardrailPolicy(db, {
    projectId: args.projectId ?? null,
    agentId: served.id,
  });
  let guardrailInput: ReturnType<typeof runGuardrails> | null = null;
  if (guardrails.active) {
    // INPUT phase, BEFORE any provider work — a block costs nothing: no
    // dispatch, no usage row, no tokens. Identical placement to the PII input
    // check immediately above.
    guardrailInput = runGuardrails(guardrails, "input", args.input);
    const outcome = guardrailOutcome(guardrailInput);
    if (outcome) {
      sink.auditLogId = await recordGuardrailDecision(db, {
        userId,
        objectType: "agent",
        objectId: served.id,
        projectId: args.projectId ?? null,
        evaluation: guardrailInput,
        outcome,
        detail: { agentId: served.id, model: served.model },
      });
    }
    if (guardrailInput.action === "block") {
      const reason = `input blocked by guardrail: ${guardrailCategoryList(guardrailInput.blocking)}`;
      return {
        ok: false,
        status: 403,
        error: "guardrail_blocked",
        detail: reason,
        guardrails: {
          action: "block",
          phase: "input",
          findings: flattenFindings(guardrailInput.findings),
          withheld: false,
        },
      };
    }
  }

  // ADR-0034 — CUSTOM PROVIDER RESOLUTION. Deliberately placed HERE, inside
  // the one governed-dispatch core, after the entitlement/routing decision and
  // after the project budget + PII gates: a custom endpoint gets exactly the
  // same governance every other provider gets, and nothing about this branch
  // can widen it. What it adds is a destination that must clear the egress
  // guard EVERY TIME (DNS can be re-pointed after an admin approved the host),
  // and an audit row naming the host we actually talked to.
  let customDestination: { host: string; port: number; protocol: string; addresses: string[] } | null =
    null;
  let customProvider: Awaited<ReturnType<typeof resolveCustomProviderForDispatch>> | null = null;
  if (served.provider === "custom") {
    customProvider = await resolveCustomProviderForDispatch(db, dataKey, served.customProviderId);
    if (!customProvider.ok) {
      const [cpRow] = await db.insert(auditLog).values({
        userId,
        objectType: "custom_model_provider",
        objectId: served.customProviderId,
        detail: {
          phase: "dispatch",
          agentId: served.id,
          error: customProvider.error,
          ...(args.projectId ? { projectId: args.projectId } : {}),
        },
        effect: "deny",
        ruleId: `custom-provider-${customProvider.error}`,
        ruleChain: [],
        reason: customProvider.detail,
      }).returning({ id: auditLog.id });
      sink.auditLogId = cpRow?.id ?? null;
      return {
        ok: false,
        status: customProvider.status,
        error: customProvider.error,
        detail: customProvider.detail,
      };
    }
    customDestination = customProvider.destination;
  }

  // ADR-0065 — A MODEL THIS DEPLOYMENT TRAINED, served from its stored
  // artifact. Placed HERE, in the same position as the custom-endpoint branch
  // above, for the same reason: everything before it (entitlement, the MRM
  // gate, the project budget, §8.4 PII) has already run, so a home-trained
  // model is governed by exactly the machinery a bought one is, and this branch
  // contributes only a provider instance. Notably it makes NO network call and
  // needs NO credential, which is what lets a custom model work on an
  // air-gapped install.
  let artifactProvider: ArtifactModelProvider | null = null;
  if (served.provider === "regulait_llm") {
    const resolved = await resolveArtifactProviderForDispatch(db, served.id);
    if (!resolved.ok) {
      await db.insert(auditLog).values({
        userId,
        objectType: "training_artifact",
        objectId: null,
        detail: {
          phase: "dispatch",
          agentId: served.id,
          agentName: served.name,
          error: resolved.error,
          ...(args.projectId ? { projectId: args.projectId } : {}),
        },
        effect: "deny",
        ruleId: `llm-${resolved.error}`,
        ruleChain: [],
        reason: resolved.detail,
      });
      return { ok: false, status: resolved.status, error: resolved.error, detail: resolved.detail };
    }
    artifactProvider = resolved.provider;
  }

  let apiKey: string | null = null;
  let baseUrl: string | null = null;
  let credentialSource: "user" | "platform" | "none" = "none";
  /** which row (if any) supplied the baseUrl override — for the egress audit */
  let credentialId: string | null = null;
  let credentialOrigin: "user_credential" | "platform_credential" | "environment" | null = null;
  // `regulait_llm` joins `mock` and `custom` in needing no vendor credential:
  // the artifact is in our own database and is queried in-process, so there is
  // no key to decrypt and no env fallback to consult.
  if (served.provider !== "mock" && served.provider !== "custom" && served.provider !== "regulait_llm") {
    if (!dataKey) {
      return { ok: false, status: 503, error: "no_data_key", detail: "set REGULAIT_DATA_KEY" };
    }
    // ADR-0024 (O15) KEY CUSTODY ENFORCEMENT: while keyCustodyEnforced is on,
    // stored per-user credentials are SKIPPED ENTIRELY at dispatch — the org
    // holds the vendor keys (platform credentials / env fallback), developers
    // hold only RegulAIt keys. The rows are not deleted, merely inert, so
    // flipping the toggle off restores them (reversible). Without custody:
    // BYO key — the BILLING user's own credential wins over the platform one;
    // their spend rides their key, and the ledger records which was used.
    //
    // ADR-0066 §2 — THE PINNED UPSTREAM CREDENTIAL, and why it is FIRST.
    // A virtual key exists so a developer can call a vendor without ever
    // holding the vendor's key. When the key names an upstream platform
    // credential, THAT credential is what this dispatch uses — ahead of the
    // owner's BYO key, ahead of the ordinary platform lookup, ahead of the env
    // fallback — because "which vendor account does this key's traffic land on"
    // is a decision the key's issuer made, not one the holder gets to change by
    // pasting a credential of their own. A provider mismatch REFUSES rather
    // than falling through to a different key: silently burning a credential
    // the issuer did not name is precisely the accounting lie this feature
    // exists to prevent. The key material is decrypted here and, as everywhere
    // else in this codebase, is never returned to any caller.
    if (vk?.upstreamCredentialId) {
      const [pinned] = await db
        .select()
        .from(modelCredentials)
        .where(eq(modelCredentials.id, vk.upstreamCredentialId));
      if (!pinned) {
        return {
          ok: false,
          status: 409,
          error: "virtual_key_credential_missing",
          detail: `virtual key '${vk.name}' pins an upstream credential that no longer exists`,
        };
      }
      if (pinned.provider !== served.provider) {
        return {
          ok: false,
          status: 409,
          error: "virtual_key_credential_provider_mismatch",
          detail:
            `virtual key '${vk.name}' is pinned to the '${pinned.provider}' platform credential, but agent ` +
            `'${served.name}' dispatches on provider '${served.provider}'. The call is refused rather than ` +
            `billed to a credential this key was not issued against.`,
        };
      }
      apiKey = decryptSecret(dataKey, pinned.keyCiphertext);
      baseUrl = pinned.baseUrl;
      credentialSource = "platform";
      credentialId = pinned.id;
      credentialOrigin = "platform_credential";
    }
    const custody = vk?.upstreamCredentialId
      ? true
      : (await loadInterceptionSettings(db)).keyCustodyEnforced;
    const [userCred] = custody
      ? [undefined]
      : await db
          .select()
          .from(userModelCredentials)
          .where(
            and(
              eq(userModelCredentials.userId, userId),
              eq(userModelCredentials.provider, served.provider),
            ),
          );
    const [platformCred] =
      userCred || vk?.upstreamCredentialId
        ? [undefined]
        : await db.select().from(modelCredentials).where(eq(modelCredentials.provider, served.provider));
    const cred = userCred ?? platformCred;
    if (apiKey !== null) {
      // the virtual key's pinned credential already resolved above; the whole
      // BYO/platform/env chain is deliberately skipped, not merely outranked
    } else if (cred) {
      credentialSource = userCred ? "user" : "platform";
      credentialId = cred.id;
      credentialOrigin = userCred ? "user_credential" : "platform_credential";
      apiKey = decryptSecret(dataKey, cred.keyCiphertext);
      baseUrl = cred.baseUrl;
    } else {
      // PLATFORM CREDENTIAL VIA ENVIRONMENT — the last-resort fallback. With no
      // stored user OR platform credential, a self-hosted / single-tenant box
      // can still activate a real provider by exporting its conventional
      // API-key env var (e.g. ANTHROPIC_API_KEY). Read here at dispatch time
      // only, never stored. Same trust level as a stored platform credential:
      // it's the operator's key, applied on every user's behalf. Precedence is
      // strict — a stored user or platform credential above already won; this
      // engages ONLY when both are absent. ADR-0021: the fallback is itself an
      // ADMIN CHOICE (envKeyFallbackEnabled + the per-provider allow-list) —
      // a regulated org can force every credential through the encrypted store.
      const org = await loadOrgSettings(db);
      const fallbackAllowed = envFallbackAllowed(org, served.provider);
      const envKey = fallbackAllowed ? platformEnvKey(served.provider) : null;
      if (envKey) {
        credentialSource = "platform";
        credentialOrigin = "environment";
        apiKey = envKey.apiKey;
        baseUrl = envKey.baseUrl;
      } else {
        // only hint at the env var when the fallback could actually engage —
        // advertising a disabled path would send the operator down a dead end
        const envHint = fallbackAllowed ? platformEnvKeyName(served.provider) : null;
        return {
          ok: false,
          status: 409,
          error: "no_model_credential",
          detail:
            `no stored credential (user or platform) for provider '${served.provider}'` +
            ` — an admin can add one in Model Credentials` +
            (envHint ? `, or set the ${envHint} environment variable on the server` : ``),
        };
      }
    }
  }

  // ADR-0034 amendment — THE CREDENTIAL `baseUrl` OVERRIDE, BEHIND THE SAME
  // EGRESS GUARD as a custom provider. ADR-0034 disclosed this as an open gap:
  // `model_credentials.baseUrl` / `user_model_credentials.baseUrl` (migrations
  // 0016/0017) are the SAME SSRF primitive as an admin-typed custom endpoint —
  // point one at http://169.254.169.254/… and this gateway, which runs on EC2,
  // fetches the instance role's credentials and hands them back.
  //
  // It runs HERE, on every dispatch, and not only at write time, because:
  //   - rows written BEFORE this guard existed are in the live database now,
  //     carrying whatever baseUrl they were given, and they are refused rather
  //     than silently rewritten or nulled;
  //   - a write-time verdict is not a fact about the future: DNS can be
  //     re-pointed and the allow-list can be withdrawn after approval.
  //
  // NO OVERRIDE MEANS NO CHECK: with baseUrl null the adapter uses its compiled
  // vendor default, which no human can type, so there is nothing to decide and
  // the behaviour of every non-overriding deployment is byte-identical.
  //
  // ── AMENDED BY ADR-0062 (2026-08-03) ────────────────────────────────────────
  // The paragraph above is kept verbatim because it is what this file shipped
  // saying, and it remains exactly right AS AN SSRF ARGUMENT. It is not an
  // egress POLICY. On an air-gapped deployment the compiled vendor default is
  // the one destination that matters: storing a credential for a built-in
  // provider — or merely exporting ANTHROPIC_API_KEY — makes this dispatch
  // attempt the vendor's public API carrying the prompt, and nothing in the
  // application refuses it (docs/deployment/DATA_BOUNDARY.md §4 recorded this
  // as an open finding). So there IS something to decide, and it is decided in
  // the `else` branch below: under a strict posture the compiled destination
  // must be in the SAME `egress_allow_hosts` table every other surface uses.
  // Under `hosted` (the default) nothing about this changes, down to the fetch
  // implementation.
  let credentialFetch: typeof fetch | undefined;
  if (baseUrl) {
    const { decision, allowList } = await checkCredentialBaseUrl(db, baseUrl);
    if (!decision.ok) {
      const reason =
        `model credential baseUrl override for provider '${served.provider}' ` +
        `(${credentialOrigin ?? "unknown source"}): ${decision.reason}`;
      const [egRow] = await db.insert(auditLog).values({
        userId,
        objectType: "model_credential",
        objectId: credentialId,
        detail: {
          phase: "dispatch",
          agentId: served.id,
          provider: served.provider,
          source: credentialOrigin,
          baseUrl,
          code: decision.code,
          ...(decision.host ? { host: decision.host } : {}),
          ...(args.projectId ? { projectId: args.projectId } : {}),
        },
        effect: "deny",
        ruleId: "model-credential-egress-blocked",
        ruleChain: [],
        reason,
      }).returning({ id: auditLog.id });
      sink.auditLogId = egRow?.id ?? null;
      return { ok: false, status: 403, error: "egress_blocked", detail: reason };
    }
    // the same guarded fetch the custom-provider path uses: re-validates every
    // HTTP request the SDK makes, pins plaintext http to the validated address,
    // refuses redirects. Built from the SAME allow-list snapshot just validated.
    credentialFetch = credentialGuardedFetch(allowList);
  } else {
    // ADR-0062 — THE COMPILED VENDOR DEFAULT. `mock` and `custom` resolve to
    // "nothing to adjudicate" (no outbound call of its own; and a custom
    // endpoint has already cleared the ADR-0034 guard above), so this branch is
    // inert for them in every posture.
    const { posture, allowList } = await loadCompiledEgressContext(db);
    const decision = decideCompiledDefault({
      posture,
      surface: "model",
      kind: served.provider,
      defaultBaseUrl: defaultBaseUrlFor(served.provider),
      allowList,
    });
    if (!decision.ok) {
      await auditCompiledDefaultDenied(db, {
        userId,
        surface: "model",
        objectId: served.id,
        kind: served.provider,
        decision,
        posture,
        detail: {
          agentId: served.id,
          model: served.model,
          source: credentialOrigin,
          ...(args.projectId ? { projectId: args.projectId } : {}),
        },
      });
      return { ok: false, status: 403, error: "egress_blocked", detail: decision.reason };
    }
  }

  // ADR-0023 `agents.systemPrompt` INVARIANT — enforced here in the ONE shared
  // dispatch core so the direct invoke path, orchestration workers, and both
  // compat shims inherit it without reimplementation: when the SERVED agent
  // carries an admin-authored system prompt, that prompt is the dispatch's
  // system BASE, and a caller-supplied system is APPENDED after it — it never
  // replaces it. The admin prompt is a governance artifact (what the admin
  // decided this agent IS), so no caller-side field may displace it.
  //
  // ADR-0048 layers VERSIONING onto exactly this line and nothing else. When
  // the served agent has any `config_versions` rows, the base prompt comes from
  // the RESOLVED version — the active one, or the canary when this request's
  // stable key falls inside the canary percentage — instead of from the
  // `agents.systemPrompt` column. The invariant above is untouched: a canary
  // base prompt still wins over, and is still only appended to by, the caller's
  // `system`. An agent with no version rows resolves to null and falls back to
  // the column, which is byte-identical pre-0048 behaviour.
  //
  // The stable key is the run id (else the conversation id, else the user), so
  // a multi-turn conversation cannot flip its base prompt halfway through.
  const promptVersion = await resolveAgentPromptVersion(db, {
    agentId: served.id,
    userId,
    runId: typeof args.detail?.["runId"] === "string" ? (args.detail["runId"] as string) : null,
    conversationId:
      typeof args.detail?.["conversationId"] === "string"
        ? (args.detail["conversationId"] as string)
        : null,
  });
  const basePrompt = promptVersion ? promptVersion.systemPrompt : served.systemPrompt;
  const dispatchSystem = basePrompt
    ? basePrompt + (args.system ? `\n\n${args.system}` : "")
    : args.system;

  // A custom endpoint's key (when it has one at all) is the ORG's, stored on
  // the custom_model_providers row — the same trust level as a platform
  // credential, so the ledger says so. A keyless local endpoint honestly
  // records "none": there was no credential, not a hidden one.
  if (customProvider?.ok) {
    credentialSource = customProvider.row.keyCiphertext ? "platform" : "none";
  }

  // ADR-0042 STREAMING, AND THE HONEST RESIDUAL.
  //
  // An output-phase guardrail can only decide once the full completion exists.
  // A live delta stream would therefore have already put the offending bytes on
  // the client's wire before the decision was reachable — the exact failure
  // ADR-0019 recorded for PII and closed with route-level suppression.
  //
  // This closes it HERE, inside the one dispatch core, so it covers EVERY
  // streaming caller — the SSE invoke route, both compat shims, and the
  // orchestration worker path — rather than only the one route that knows to
  // ask. When any output-phase detector is at `block`, `onText` is not handed
  // to the provider at all: deltas are accumulated locally, the completed text
  // is scanned, and only then is the buffer flushed to the caller — or dropped
  // entirely if the scan blocked. A client can therefore never receive a token
  // of content the buffered path would have withheld.
  //
  // RESIDUAL, STATED PLAINLY: streaming is DEGRADED, not preserved, whenever an
  // output detector is at `block` — the caller receives the text in one flush
  // at completion instead of incrementally. `streamBuffered: true` rides the
  // response so this is disclosed rather than silent. With every output
  // detector at `off`/`log`/`warn` (the shipped posture) nothing is buffered and
  // streaming is byte-identical to before.
  const bufferStream = !!args.onText && guardrails.blocksOutput;
  const bufferedDeltas: string[] = [];
  const providerOnText = bufferStream
    ? (delta: string) => {
        bufferedDeltas.push(delta);
      }
    : args.onText;

  let result;
  try {
    // the custom path brings its own already-guarded provider instance; every
    // other provider resolves exactly as before
    const provider = artifactProvider
      ? artifactProvider
      : customProvider?.ok
      ? customProvider.provider
      : resolveModelProvider(
          { provider: served.provider, apiKey, baseUrl },
          // only an OVERRIDDEN destination gets the guarded fetch; a vendor
          // default endpoint is unchanged, down to the fetch implementation
          credentialFetch,
        );
    result = await provider.dispatch({
      model: served.model,
      input: args.input,
      ...(args.messages ? { messages: args.messages } : {}),
      ...(dispatchSystem ? { system: dispatchSystem } : {}),
      ...(args.cacheSystem ? { cacheSystem: true } : {}),
      ...(args.tools ? { tools: args.tools } : {}),
      ...(args.toolChoice ? { toolChoice: args.toolChoice } : {}),
      ...(args.responseFormat ? { responseFormat: args.responseFormat } : {}),
      ...(args.thinking ? { thinking: args.thinking } : {}),
      ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
      ...(providerOnText ? { onText: providerOnText } : {}),
      ...(args.onThinking ? { onThinking: args.onThinking } : {}),
    });
  } catch (err) {
    // ADR-0034: an egress refusal raised INSIDE the adapter (the guarded fetch
    // re-checking per request, or a redirect) is a governance decision, not a
    // network blip. The SDKs flatten it to "Connection error.", so unwrap the
    // cause chain and report the real reason — and audit it, because a block
    // that fires between registration and the socket is exactly the event a
    // governance product must be able to show afterwards.
    const egress = egressRefusal(err);
    if (egress) {
      // the same refusal can now arrive from either guarded path — a custom
      // endpoint or a credential baseUrl override — so the audit row names the
      // right object instead of filing a credential block under a provider id
      // that does not exist.
      const viaCredential = !customProvider?.ok;
      await db.insert(auditLog).values({
        userId,
        objectType: viaCredential ? "model_credential" : "custom_model_provider",
        objectId: viaCredential ? credentialId : served.customProviderId,
        detail: {
          phase: "dispatch",
          agentId: served.id,
          ...(viaCredential
            ? { provider: served.provider, source: credentialOrigin, baseUrl }
            : {}),
          ...(customDestination ? { intendedHost: customDestination.host } : {}),
          ...(args.projectId ? { projectId: args.projectId } : {}),
        },
        effect: "deny",
        ruleId: viaCredential ? "model-credential-egress-blocked" : "custom-provider-egress-blocked",
        ruleChain: [],
        reason: egress,
      });
      return { ok: false, status: 403, error: "egress_blocked", detail: egress };
    }
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

  // ADR-0042 OUTPUT phase. The call already ran, so a block here is the same
  // BILL-AND-WITHHOLD the PII path performs: the usage row below records the
  // honest spend, and the text is replaced by a counts-only marker.
  let guardrailOutput: ReturnType<typeof runGuardrails> | null = null;
  let guardrailWithheld = false;
  if (guardrails.active) {
    guardrailOutput = runGuardrails(guardrails, "output", result.outputText);
    if (guardrailOutput.action === "block") {
      guardrailWithheld = true;
      // the guardrail marker wins over the PII one when both fired: both are
      // withheld markers, and this one names the layer that refused.
      outputText = guardrailWithheldMarker(guardrailOutput.blocking);
    }
  }
  // Flush (or drop) the buffered stream. This is the line that makes the
  // streaming guarantee real: on a block the deltas are simply never written.
  if (bufferStream && args.onText && !guardrailWithheld && !withheld) {
    for (const delta of bufferedDeltas) args.onText(delta);
  }
  const guardrailFindings = [
    ...(guardrailInput?.findings ?? []),
    ...(guardrailOutput?.findings ?? []),
  ];
  const guardrailAction: DispatchGuardrails["action"] | null = guardrailWithheld
    ? "block"
    : guardrailFindings.length === 0
      ? null
      : guardrailFindings.some((f) => f.action === "warn")
        ? "warn"
        : "log";
  const dispatchGuardrails: DispatchGuardrails | null = guardrailAction
    ? {
        action: guardrailAction,
        phase: guardrailWithheld ? "output" : (guardrailInput?.findings.length ? "input" : "output"),
        findings: flattenFindings(guardrailFindings),
        withheld: guardrailWithheld,
        ...(bufferStream ? { streamBuffered: true as const } : {}),
      }
    : null;
  // COUNTS ONLY in the usage detail, exactly as the PII detail is.
  const guardrailDetail = dispatchGuardrails
    ? {
        guardrails: {
          action: dispatchGuardrails.action,
          findings: dispatchGuardrails.findings,
          withheld: guardrailWithheld,
        },
      }
    : {};

  const [usageRow] = await db.insert(usageEvents).values({
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
    // ADR-0048 §3 — THE STAMP. Which immutable prompt version actually served
    // this dispatch, and whether it served as a canary. This is what makes a
    // regression attributable to the version that caused it rather than to a
    // time window; without it the canary would be a rollout mechanism with no
    // way to read its own result. NULL when the agent has never been versioned.
    configVersionId: promptVersion?.versionId ?? null,
    configVersion: promptVersion?.version ?? null,
    configCanary: promptVersion?.canary ?? false,
    // ADR-0066 §2 — WHICH VIRTUAL KEY PAID. Attribution rides the ONE existing
    // ledger rather than a parallel per-key table, so per-key spend, per-project
    // spend and the pillar-5 rollups are the same numbers by construction.
    virtualKeyId: vk?.id ?? null,
    detail: {
      credentialSource,
      ...(promptVersion
        ? {
            promptVersion: {
              version: promptVersion.version,
              canary: promptVersion.canary,
              bucket: promptVersion.bucket,
              reason: promptVersion.reason,
            },
          }
        : {}),
      ...(customDestination ? { customProviderId: served.customProviderId, egress: customDestination } : {}),
      ...(args.detail ?? {}),
      ...piiDetail,
      ...guardrailDetail,
    },
  }).returning({ id: usageEvents.id });
  // ADR-0070 — THE REFERENCE. The span's provider/model/token/cost fields are
  // copied from THIS row, and `tracing.test.ts` joins on this id and asserts
  // they still agree rather than trusting the copy.
  sink.usageEventId = usageRow?.id ?? null;
  // ADR-0042: the OUTPUT-phase guardrail audit row — one row into the SINGLE
  // existing audit log, with detector, category counts, mode and outcome. A
  // block is `effect: 'deny'`; warn and log are allows.
  if (guardrailOutput) {
    const outcome = guardrailOutcome(guardrailOutput);
    if (outcome) {
      await recordGuardrailDecision(db, {
        userId,
        objectType: "agent",
        objectId: served.id,
        projectId: args.projectId ?? null,
        evaluation: guardrailOutput,
        outcome,
        detail: {
          agentId: served.id,
          model: served.model,
          ...(bufferStream ? { streamBuffered: true } : {}),
        },
      });
    }
  }
  // ADR-0034 — THE DESTINATION-HOST AUDIT ROW. The whole point of a governance
  // product is that "which third-party endpoint did our models talk to, on
  // whose behalf, for which project" is answerable after the fact. Written for
  // every custom-provider dispatch, alongside (never instead of) the ordinary
  // entitlement audit the caller already wrote.
  if (customDestination) {
    await db.insert(auditLog).values({
      userId,
      objectType: "custom_model_provider",
      objectId: served.customProviderId,
      detail: {
        phase: "dispatch",
        agentId: served.id,
        model: served.model,
        egress: customDestination,
        ...(customProvider?.ok ? { providerName: customProvider.row.name, wireProtocol: customProvider.row.wireProtocol } : {}),
        credentialSource,
        ...(args.projectId ? { projectId: args.projectId } : {}),
      },
      effect: "allow",
      ruleId: "custom-provider-dispatch",
      ruleChain: [],
      reason: `custom provider dispatch to ${customDestination.protocol}//${customDestination.host}:${customDestination.port}`,
    });
  }
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
  // ADR-0066 §2 — move the MEASURED cost onto the key's enforcement counter,
  // in the same position and with the same discipline as the project budget
  // just below: the crossing dispatch is billed honestly, and it is the NEXT
  // call that the pre-gate refuses. An unpriced agent adds nothing rather than
  // an invented figure.
  if (vk) await recordVirtualKeySpend(db, vk.id, costUsd);

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
      // thinking blocks ride out with the output — and are withheld WITH the
      // output when a PII or guardrail block replaced it (reasoning can leak
      // the same content the completion was withheld for)
      ...(result.thinking && !withheld && !guardrailWithheld ? { thinking: result.thinking } : {}),
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
      ...(dispatchGuardrails ? { guardrails: dispatchGuardrails } : {}),
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
    /** ADR-0066: the virtual key this invoke arrived on, when it did */
    virtualKey?: VirtualKeyContext | null | undefined;
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
    virtualKey: args.virtualKey ?? null,
    // ADR-0066 §4: a fallback hop is re-evaluated in the SAME mode the primary
    // was entitled under — a `plan`-only grant must not serve an `execute` call
    // just because it appears in a chain.
    mode: body.mode,
    detail: { mode: body.mode, ...(body.conversationId ? { conversationId: body.conversationId } : {}) },
  });
}

/**
 * Platform credential via environment. A self-hosted / single-tenant deploy can
 * activate a real provider by exporting its conventional API-key env var instead
 * of pasting a key into the admin portal — no admin-UI paste, no key material in
 * the DB. Read at dispatch time only, never persisted. This is the SAME trust
 * level as a stored PLATFORM credential (see modelCredentials): it is the
 * platform operator's key, applied on every user's behalf, and it is the LAST
 * resort — a stored user or platform credential always takes precedence.
 *
 * Returns null when the provider has no env-key convention or the var is unset.
 */
export function platformEnvKey(
  provider: string,
): { apiKey: string; baseUrl: string | null } | null {
  // provider -> [api-key env names (first non-empty wins), base-url env names]
  const map: Record<string, { key: readonly string[]; base: readonly string[] }> = {
    anthropic: { key: ["ANTHROPIC_API_KEY"], base: ["ANTHROPIC_BASE_URL"] },
    openai: { key: ["OPENAI_API_KEY"], base: ["OPENAI_BASE_URL"] },
    google: { key: ["GOOGLE_API_KEY", "GEMINI_API_KEY"], base: ["GOOGLE_BASE_URL", "GEMINI_BASE_URL"] },
    xai: { key: ["XAI_API_KEY"], base: ["XAI_BASE_URL"] },
  };
  const entry = map[provider];
  if (!entry) return null;
  const firstSet = (names: readonly string[]): string | null => {
    for (const name of names) {
      const v = process.env[name];
      if (v && v.length > 0) return v;
    }
    return null;
  };
  const apiKey = firstSet(entry.key);
  if (!apiKey) return null;
  return { apiKey, baseUrl: firstSet(entry.base) };
}

/** The primary env-var NAME a provider's platform key is read from — for the
 * 409 detail message only (never the value). Null when the provider has no
 * env-key convention. */
export function platformEnvKeyName(provider: string): string | null {
  const names: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    google: "GOOGLE_API_KEY",
    xai: "XAI_API_KEY",
  };
  return names[provider] ?? null;
}

/** The non-mock providers that support the platform-key env fallback, i.e. the
 * provider kinds `platformEnvKey` can resolve. */
export const ENV_FALLBACK_PROVIDERS = ["anthropic", "openai", "google", "xai"] as const;

/**
 * ADR-0034 — the key an agent is looked up under in `configuredProviders`'s
 * set. For every shipped vendor this is just the provider kind (today's
 * behaviour, byte-identical). For a custom-provider agent it is the SPECIFIC
 * endpoint, so dispatchability is decided per endpoint rather than per kind.
 */
export function agentProviderToken(a: { provider: string; customProviderId?: string | null }): string {
  return a.provider === "custom" ? `custom:${a.customProviderId ?? "none"}` : a.provider;
}

/** Providers this user could actually dispatch to right now: "mock" needs no
 * key at all, everything else needs a stored credential — the caller's own
 * (BYO key) or the platform's — and a data key to decrypt it with, OR a
 * platform-key env var set for that provider (the env fallback, which needs no
 * data key since it is not encrypted at rest). Exported so orchestration's
 * re-plan routing filters candidates exactly like the invoke path does —
 * routing anywhere may only land on a servable agent. */
export async function configuredProviders(
  db: Db,
  dataKey: string | undefined,
  userId: string,
): Promise<Set<string>> {
  // ADR-0065: `regulait_llm` joins `mock` as credential-free — a locally
  // trained artifact is served from our own database with no vendor key and no
  // outbound call, so it is always "configured". An agent of this kind whose
  // artifact is missing still fails honestly at dispatch (409
  // `artifact_not_registered`); what this set decides is only whether the
  // router may consider it, and a router that skipped every home-trained model
  // would make the whole feature unreachable from the invoke path.
  const set = new Set<string>(["mock", "regulait_llm"]);
  // ADR-0034 — CUSTOM PROVIDERS ARE DISPATCHABLE PER ENDPOINT, NOT PER KIND.
  // Every other entry in this set is a provider KIND ("anthropic"), because a
  // stored key makes every agent of that kind servable. A custom endpoint is
  // not like that: two agents can both be provider 'custom' while one points
  // at a live endpoint and the other at a disabled one. So the token here is
  // `custom:<uuid>` (see `agentProviderToken`), and only ENABLED endpoints get
  // one — a routed-to agent whose endpoint is off would otherwise turn a
  // working request into a 409 the router could have avoided. When the org
  // master switch is off, no token is added and every custom agent is
  // correctly seen as unservable.
  {
    const org = await loadOrgSettings(db);
    if (org.customModelProvidersEnabled) {
      const live = await db
        .select({ id: customModelProviders.id })
        .from(customModelProviders)
        .where(eq(customModelProviders.enabled, true));
      for (const c of live) set.add(`custom:${c.id}`);
    }
  }
  // The env fallback is decrypted-key-free, so it counts even without a data
  // key — but only when the ADR-0021 org gate allows it for that provider.
  const org = await loadOrgSettings(db);
  for (const provider of ENV_FALLBACK_PROVIDERS) {
    if (envFallbackAllowed(org, provider) && platformEnvKey(provider)) set.add(provider);
  }
  // Without REGULAIT_DATA_KEY no STORED credential can be decrypted, so mock +
  // any env-configured provider is all that can be served.
  if (!dataKey) return set;
  // ADR-0024 (O15): under enforced key custody a user's own stored credential
  // is inert at dispatch, so it must not count as a dispatchable provider
  // here either — routing may only land on an agent that can actually serve.
  const custody = (await loadInterceptionSettings(db)).keyCustodyEnforced;
  const [userCreds, platformCreds] = await Promise.all([
    custody
      ? Promise.resolve([])
      : db
          .select({ provider: userModelCredentials.provider })
          .from(userModelCredentials)
          .where(eq(userModelCredentials.userId, userId)),
    db.select({ provider: modelCredentials.provider }).from(modelCredentials),
  ]);
  for (const c of userCreds) set.add(c.provider);
  for (const c of platformCreds) set.add(c.provider);
  return set;
}

/**
 * ADR-0070 amendment (2026-08-15) — what the governed connector body answers
 * into instead of the Fastify reply, so that ONE wrapper can see EVERY exit and
 * write the `connector` span from it.
 *
 * It is deliberately not a Fastify reply and is deliberately not named `reply`:
 * it sends nothing, it decides nothing, it only captures the status and payload
 * the attempt chose so the wrapper can classify them and then send them on
 * unchanged. The shape mirrors `reply.status(n).send(body)` exactly so the body
 * it wraps reads the same as every other route in this file.
 */
interface ConnectorAttemptResult {
  status: number;
  body: Record<string, unknown>;
}
interface ConnectorReplyRecorder {
  status(code: number): ConnectorReplyRecorder;
  send(body: Record<string, unknown>): ConnectorAttemptResult;
}
function connectorReplyRecorder(): ConnectorReplyRecorder {
  let code = 200;
  const api: ConnectorReplyRecorder = {
    status(c) {
      code = c;
      return api;
    },
    send(body) {
      return { status: code, body };
    },
  };
  return api;
}

/** §2/§4: agent registry + entitlements, connector catalog + grants, and the
 * governed invoke endpoints — decision, routing, and (dispatch=true) real
 * model execution. */
export function registerAgentConnectorRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { dataKey?: string } = {},
) {
  /**
   * ADR-0034 amendment — WRITE-TIME EGRESS CHECK for a credential `baseUrl`.
   *
   * Returns null when the destination is permitted, or the 400 body when it is
   * not. Every refusal is audited: somebody attempting to point the gateway at
   * IMDS is precisely the event a governance product must be able to show
   * afterwards, whether or not it succeeded.
   */
  async function refuseCredentialEgress(
    req: { authCtx: { userId?: string | null } },
    provider: string,
    baseUrl: string,
    subjectUserId: string | null,
    scope: "user" | null,
  ): Promise<{ error: string; code: string; detail: string } | null> {
    const { decision } = await checkCredentialBaseUrl(db, baseUrl);
    if (decision.ok) return null;
    const detail =
      `baseUrl override for provider '${provider}' refused: ${decision.reason}` +
      ` (an admin adds permitted destinations under Egress Allow Hosts)`;
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "model_credential",
      objectId: null,
      detail: {
        phase: scope === "user" ? "user_credential_write" : "platform_credential_write",
        provider,
        baseUrl,
        code: decision.code,
        ...(decision.host ? { host: decision.host } : {}),
        ...(subjectUserId ? { subjectUserId } : {}),
      },
      effect: "deny",
      ruleId: "model-credential-egress-blocked",
      ruleChain: [],
      reason: detail,
    });
    return { error: "egress_blocked", code: decision.code, detail };
  }

  /**
   * ADR-0034 amendment #2 — the same thing for the CONNECTOR surface, whose
   * `baseUrl` (on the connector row or on its credential row) is the URL a
   * `webhook`-kind connector POSTs a caller-supplied payload to. Thin wrapper
   * so the route bodies stay readable; the policy lives in
   * `connection-egress.ts` with the other three surfaces.
   */
  async function refuseConnectionEgress(
    req: { authCtx: { userId?: string | null } },
    args: {
      surface: ConnectionSurface;
      baseUrl: string;
      objectId?: string;
      phase: string;
      label: string;
      detail?: Record<string, unknown>;
    },
  ) {
    return refuseConnectionEgressWrite(db, {
      ...args,
      userId: req.authCtx.userId ?? null,
    });
  }

  // --- agent registry (§4: global catalog, decoupled from entitlement) ---

  app.post("/v1/agents", async (req, reply) => {
    const body = createAgentSchema.parse(req.body);
    // ADR-0052 — THE EXPANSION GATE. A new agent is a wider governed footprint,
    // so it is expansion-class: refused once the license has lapsed past its
    // grace window, permitted in every other state including grace. Dispatching
    // an agent that already exists is governance-class and is deliberately NOT
    // gated — an expired license freezes growth, it never turns the gate off.
    const licenseRefusal = await refuseIfExpansionBlocked(db, {
      actorUserId: req.authCtx.userId ?? null,
      objectType: "agent",
      what: `creating agent '${body.name}'`,
    });
    if (licenseRefusal) return reply.status(licenseRefusal.status).send(licenseRefusal.body);
    // ADR-0034 — the discriminated union, checked here so the 400 explains
    // itself rather than surfacing as a raw CHECK-constraint violation.
    if (!agentCustomProviderPairValid(body)) {
      return reply.status(400).send({
        error: "invalid_custom_provider_binding",
        detail:
          "provider 'custom' requires customProviderId, and customProviderId is only valid with provider 'custom'",
      });
    }
    if (body.customProviderId) {
      const [cp] = await db
        .select({ id: customModelProviders.id })
        .from(customModelProviders)
        .where(eq(customModelProviders.id, body.customProviderId));
      if (!cp) return reply.status(404).send({ error: "unknown_custom_provider" });
    }
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
        systemPrompt: body.systemPrompt ?? null,
        customProviderId: body.customProviderId ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // ADR-0023: set/clear an agent's admin-authored BASE system prompt — a
  // governance artifact, so writing it is admin-only (the global gate; this
  // route is deliberately NOT in NON_ADMIN_ROUTES). It is not a secret: it
  // rides the agent row that admins already read, and it is disclosed policy
  // context applied to every dispatch of the agent, not key material.
  //
  // ADR-0048: this used to be a straight `UPDATE agents SET system_prompt`,
  // which took effect org-wide on the next dispatch with NO version history and
  // NO way to answer "which prompt text served this dispatch". It now MINTS AN
  // IMMUTABLE VERSION and activates it: the admin gesture and its
  // effective-immediately behaviour are unchanged, but the prior text survives
  // as its own row and one click rolls back to it. `agents.systemPrompt` is
  // still written — as a READ-MODEL of the active version — so the agents API,
  // the SPA, and ADR-0044's `eval_runs.system_prompt_hash` keep seeing the
  // served base prompt without learning about `config_versions`.
  app.post("/v1/agents/:agentId/system-prompt", async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    const body = setAgentSystemPromptSchema.parse(req.body);
    const [existing] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!existing) return reply.status(404).send({ error: "unknown_agent" });
    const created = await newVersion(db, {
      artifactType: "agent_system_prompt",
      artifactId: agentId,
      body: { systemPrompt: body.systemPrompt ?? null },
      label: `set via POST /v1/agents/:id/system-prompt`,
      authorUserId: req.authCtx.userId ?? null,
      activate: true,
    });
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return { ...row!, configVersion: created.version.version };
  });

  // --- model credentials (admin-only via the global gate) ---
  // One platform credential per provider, encrypted at rest, never returned.

  app.post("/v1/model-credentials", async (req, reply) => {
    const body = createModelCredentialSchema.parse(req.body);
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }
    // ADR-0034 amendment: a baseUrl override is an SSRF primitive, so it clears
    // the egress allow-list HERE, at the moment somebody types it — the
    // earliest honest failure. This is NOT a substitute for the dispatch-time
    // check (DNS moves; rows predate the guard), it is the polite half of it.
    if (body.baseUrl) {
      const refused = await refuseCredentialEgress(req, body.provider, body.baseUrl, null, null);
      if (refused) return reply.status(400).send(refused);
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

  // Which providers are LIVE platform-wide, so the /app playground can guide a
  // user ("Anthropic: not configured") without ever seeing key material. A
  // provider is `configured` when a PLATFORM stored credential exists OR the
  // platform-key env var is set (the env fallback); "mock" is always true.
  // Booleans + provider names ONLY — no keys, no ciphertext, no base URLs.
  // Any authenticated user may read it (NON_ADMIN_ROUTES); it exposes no secret.
  app.get("/v1/model-providers/status", async () => {
    const [stored, org] = await Promise.all([
      db
        .select({ provider: modelCredentials.provider })
        .from(modelCredentials)
        .then((rows) => new Set(rows.map((r) => r.provider))),
      loadOrgSettings(db),
    ]);
    const providers: Record<string, { configured: boolean }> = {
      mock: { configured: true },
    };
    for (const provider of ENV_FALLBACK_PROVIDERS) {
      providers[provider] = {
        configured:
          stored.has(provider) ||
          // ADR-0021: a disabled env fallback means an env-only provider is
          // honestly NOT configured — its dispatches will 409.
          (envFallbackAllowed(org, provider) && platformEnvKey(provider) !== null),
      };
    }
    return { providers };
  });

  // ADR-0024 (O11) — the EXPLICIT "Unattributed" bucket: every usage row with
  // projectId NULL (calls that arrived without x-regulait-project-id), rolled
  // up so an admin can SEE the attribution leak instead of it hiding as a gap
  // between provider invoices and project totals. Admin-only (not in
  // NON_ADMIN_ROUTES). Deliberately a separate bucket, never mixed into any
  // project rollup — a null-project row cannot hit a project budget, and every
  // per-project number is unchanged by its existence.
  app.get("/v1/costs/unattributed", async () => {
    const where = isNull(usageEvents.projectId);
    const [[measured], byObjectType, byUser, byMcpTool] = await Promise.all([
      db
        .select({
          events: count(),
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
          inputTokens: sql<number>`coalesce(sum(${usageEvents.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${usageEvents.outputTokens}), 0)::int`,
        })
        .from(usageEvents)
        .where(where),
      db
        .select({
          objectType: usageEvents.objectType,
          events: count(),
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        })
        .from(usageEvents)
        .where(where)
        .groupBy(usageEvents.objectType),
      db
        .select({
          userId: usageEvents.userId,
          events: count(),
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        })
        .from(usageEvents)
        .where(where)
        .groupBy(usageEvents.userId),
      db
        .select({
          toolName: usageEvents.operation,
          events: count(),
          costUsd: sql<number>`coalesce(sum(${usageEvents.costUsd}), 0)::float8`,
        })
        .from(usageEvents)
        .where(and(where, eq(usageEvents.objectType, "mcp_tool")))
        .groupBy(usageEvents.operation),
    ]);
    return {
      bucket: "unattributed",
      note:
        "calls that arrived with no x-regulait-project-id header — metered on the same ledger, " +
        "never counted against any project budget. Close the gap with requireProjectAttribution " +
        "(compat surfaces) and requireMcpAttribution (MCP proxy).",
      measured,
      byObjectType,
      byUser,
      byMcpTool,
    };
  });

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
    // ADR-0024 (O15): under enforced key custody, per-user BYO credentials
    // stop working — creation AND update (this endpoint upserts) are refused
    // with an explanation, and every refusal is audited. Existing rows are not
    // deleted; they are inert while the toggle is on (reversible).
    const custody = (await loadInterceptionSettings(db)).keyCustodyEnforced;
    if (custody) {
      await db.insert(auditLog).values({
        userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
        objectType: "user",
        objectId: userId,
        detail: { phase: "key_custody", provider: body.provider, keyCustodyEnforced: true },
        effect: "deny",
        ruleId: "key-custody-enforced",
        ruleChain: [],
        reason: `per-user model credential for '${body.provider}' refused: key custody is enforced on this deployment`,
      });
      return reply.status(409).send({
        error: "key_custody_enforced",
        detail:
          "this deployment enforces key custody: the organisation holds the vendor keys and " +
          "developers hold only RegulAIt keys, so per-user BYO model credentials cannot be " +
          "created or updated. Dispatches use the org/platform credential for each provider. " +
          "An admin can lift this in Client Access (keyCustodyEnforced).",
      });
    }
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
    }
    // ADR-0034 amendment — the per-user table is the MORE exposed of the two:
    // a non-admin may write their own row here, so without this check any user
    // could choose a destination the gateway would then fetch on their behalf.
    // Checked after the key-custody gate so the more specific refusal wins.
    if (body.baseUrl) {
      const refused = await refuseCredentialEgress(req, body.provider, body.baseUrl, userId, "user");
      if (refused) return reply.status(400).send(refused);
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

  // -------------------------------------------------------------------------
  // ADR-0066 §4 — PROVIDER FALLBACK CHAINS (admin-only via the default gate).
  //
  // The chain is CONFIGURATION, not entitlement: putting an agent in a chain
  // grants nobody anything. Every hop is re-evaluated against the CALLER's own
  // grants at dispatch time, so an admin can configure a chain full of models
  // that a particular user will never reach — and that user's calls will simply
  // skip them, audibly. This is why the write path validates existence and
  // shape but deliberately does NOT validate anybody's entitlement: a chain is
  // not a promise about who may use it.
  // -------------------------------------------------------------------------
  app.get("/v1/agents/:agentId/fallbacks", async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    const rows = await db
      .select({
        position: agentFallbacks.position,
        agentId: agentFallbacks.fallbackAgentId,
        name: agents.name,
        provider: agents.provider,
        model: agents.model,
        enabled: agents.enabled,
      })
      .from(agentFallbacks)
      .innerJoin(agents, eq(agentFallbacks.fallbackAgentId, agents.id))
      .where(eq(agentFallbacks.agentId, agentId))
      .orderBy(asc(agentFallbacks.position));
    return reply.send({ agentId, fallbacks: rows });
  });

  app.put("/v1/agents/:agentId/fallbacks", async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    const body = setAgentFallbacksSchema.parse(req.body);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });

    if (body.fallbackAgentIds.includes(agentId)) {
      return reply.status(422).send({
        error: "self_fallback",
        detail:
          "an agent cannot be its own fallback — the primary already failed, and re-trying it is a loop expressed as configuration",
      });
    }
    if (new Set(body.fallbackAgentIds).size !== body.fallbackAgentIds.length) {
      return reply.status(422).send({
        error: "duplicate_fallback",
        detail: "a fallback chain must name each target at most once",
      });
    }
    if (body.fallbackAgentIds.length > 0) {
      const found = await db
        .select({ id: agents.id, model: agents.model, provider: agents.provider })
        .from(agents)
        .where(inArray(agents.id, body.fallbackAgentIds));
      const known = new Set(found.map((a) => a.id));
      const missing = body.fallbackAgentIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        return reply.status(422).send({
          error: "unknown_fallback_agent",
          detail: `no agent with id(s): ${missing.join(", ")}`,
        });
      }
      // A hop with no model id can never dispatch (ADR-0016: `model` NULL means
      // decision-only). Accepting it would build a chain with a guaranteed dead
      // rung, which fails at 3am rather than at configuration time.
      const undispatchable = found.filter((a) => !a.model || !isModelProviderKind(a.provider));
      if (undispatchable.length > 0) {
        return reply.status(422).send({
          error: "fallback_not_dispatchable",
          detail:
            `these agents cannot serve a dispatch and so cannot be fallbacks: ` +
            undispatchable.map((a) => a.id).join(", "),
        });
      }
    }

    // Replace the whole ordered chain in one transaction — a partial chain is
    // never a valid intermediate state, and PUT-the-list avoids every
    // position-renumbering bug an incremental API would have.
    await db.transaction(async (tx) => {
      await tx.delete(agentFallbacks).where(eq(agentFallbacks.agentId, agentId));
      if (body.fallbackAgentIds.length > 0) {
        await tx.insert(agentFallbacks).values(
          body.fallbackAgentIds.map((fallbackAgentId, position) => ({
            agentId,
            fallbackAgentId,
            position,
          })),
        );
      }
    });
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "agent",
      objectId: agentId,
      detail: { phase: "fallback-chain", chain: body.fallbackAgentIds },
      effect: "allow",
      ruleId: "fallback-chain-configured",
      ruleChain: [],
      reason:
        body.fallbackAgentIds.length === 0
          ? `fallback chain cleared for agent '${agent.name}'`
          : `fallback chain for agent '${agent.name}' set to ${body.fallbackAgentIds.length} hop(s); each hop is re-entitled per caller at dispatch time`,
    });
    return reply.send({ agentId, fallbackAgentIds: body.fallbackAgentIds });
  });

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

  // -------------------------------------------------------------------------
  // ADR-0089 (gap L20) — agent ownership and lifecycle. Admin-only via the
  // default gate, audited acts — never silent PATCH writes.
  // -------------------------------------------------------------------------

  // Set/clear the accountable human owner. A GOVERNANCE RECORD, not
  // authentication: it changes what the ADR-0082 inventory and the posture
  // page say about accountability, and nothing about who may invoke.
  app.post("/v1/agents/:agentId/owner", async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    const body = setAgentOwnerSchema.parse(req.body);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    let ownerEmail: string | null = null;
    if (body.ownerUserId) {
      const [owner] = await db
        .select({ id: users.id, email: users.email, disabledAt: users.disabledAt })
        .from(users)
        .where(eq(users.id, body.ownerUserId));
      if (!owner) return reply.status(400).send({ error: "invalid_reference", field: "ownerUserId" });
      // assigning ownership to a deactivated account would MINT an orphan —
      // the exact state the inventory's orphan flag exists to surface
      if (owner.disabledAt) {
        return reply.status(409).send({
          error: "owner_deactivated",
          detail: "this account is deactivated — an agent owner must be an active user (reactivate them first)",
        });
      }
      ownerEmail = owner.email;
    }
    const [row] = await db
      .update(agents)
      .set({ ownerUserId: body.ownerUserId })
      .where(eq(agents.id, agentId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "agent",
      objectId: agentId,
      detail: {
        phase: "ownership",
        from: agent.ownerUserId,
        to: body.ownerUserId,
        ...(ownerEmail ? { ownerEmail } : {}),
      },
      effect: "allow",
      ruleId: body.ownerUserId ? "agent-owner-set" : "agent-owner-cleared",
      ruleChain: [],
      reason: body.ownerUserId
        ? `agent '${agent.name}' owner set to '${ownerEmail}' — an accountability record, not an entitlement`
        : `agent '${agent.name}' owner cleared — the inventory now reads this agent as unowned`,
    });
    return row;
  });

  // Lifecycle transition, with reason, audited. Retired is TERMINAL for
  // governance purposes: transitions out of it are refused by name — the
  // record of why an agent was decommissioned must not be erasable by a
  // status flip (re-registering is a new agent). The dispatch-side half of
  // this decision (the 409 gate) lives in dispatchAttempt.
  app.post("/v1/agents/:agentId/lifecycle", async (req, reply) => {
    const { agentId } = agentIdParam.parse(req.params);
    const body = setAgentLifecycleSchema.parse(req.body);
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    if (agent.lifecycleStatus === "retired") {
      return reply.status(409).send({
        error: "agent_retired_terminal",
        detail:
          "retirement is terminal for governance purposes — the decommissioning record cannot be " +
          "flipped back; register a new agent instead",
      });
    }
    if (agent.lifecycleStatus === body.status) {
      return reply.status(409).send({ error: "lifecycle_unchanged", detail: `agent is already ${body.status}` });
    }
    if (body.status !== "active" && !body.reason) {
      return reply.status(422).send({
        error: "lifecycle_reason_required",
        detail: `moving an agent to '${body.status}' requires a reason — it becomes part of the governance record`,
      });
    }
    const [row] = await db
      .update(agents)
      .set({
        lifecycleStatus: body.status,
        lifecycleReason: body.status === "active" ? null : (body.reason ?? null),
        lifecycleChangedAt: new Date(),
      })
      .where(eq(agents.id, agentId))
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "agent",
      objectId: agentId,
      detail: {
        phase: "lifecycle",
        from: agent.lifecycleStatus,
        to: body.status,
        ...(body.status !== "active" ? { reason: body.reason } : {}),
      },
      effect: "allow",
      ruleId: `agent-lifecycle-${body.status}`,
      ruleChain: [],
      reason:
        body.status === "retired"
          ? `agent '${agent.name}' retired: ${body.reason} — dispatch now refuses with 409 agent_retired; grants and history remain readable`
          : body.status === "deprecated"
            ? `agent '${agent.name}' deprecated: ${body.reason} — a WARNING in the inventory; dispatch is not blocked`
            : `agent '${agent.name}' returned to active (was ${agent.lifecycleStatus})`,
    });
    return row;
  });

  // ADR-0090: the removal itself lives in grant-revocation.ts — ONE
  // implementation per grant kind, shared with a certification campaign's
  // revoke decision so the campaign can never grow a parallel delete.
  app.delete("/v1/grants/agents/:grantId", async (req, reply) => {
    const { grantId } = z.object({ grantId: z.string().uuid() }).parse(req.params);
    if (!(await deleteAgentGrantById(db, grantId))) {
      return reply.status(404).send({ error: "unknown_grant" });
    }
    return { removed: true };
  });

  app.delete("/v1/grants/connectors/:grantId", async (req, reply) => {
    const { grantId } = z.object({ grantId: z.string().uuid() }).parse(req.params);
    if (!(await deleteConnectorGrantById(db, grantId))) {
      return reply.status(404).send({ error: "unknown_grant" });
    }
    return { removed: true };
  });

  app.post("/v1/grants/agents", async (req, reply) => {
    const body = createAgentGrantSchema.parse(req.body);
    // ADR-0091: the SoD mint gate — refused 409 by name, audited, no row
    const sod = await refuseSodMint(
      db,
      { kind: "agent", userId: body.userId, agentId: body.agentId },
      req.authCtx.userId,
    );
    if (sod) return reply.status(409).send(sod);
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
    const [grants, roleGrants, revoked, [policy]] = await Promise.all([
      db
        .select({
          agentId: agents.id,
          name: agents.name,
          provider: agents.provider,
          tier: agents.tier,
          model: agents.model,
          enabled: agents.enabled,
          allowedModes: agentGrants.allowedModes,
          grantId: agentGrants.id,
        })
        .from(agentGrants)
        .innerJoin(agents, eq(agentGrants.agentId, agents.id))
        .where(eq(agentGrants.userId, userId)),
      // §5 role-bundled grants (ADR-0014) — folded into the Access-preview so
      // Simulation shows a role-granted agent, tagged with its provenance.
      loadRoleAgentGrants(db, userId),
      // ADR-0019 — the per-user override made VISIBLE, not silent (§5): a row
      // reads "granted via role X, REVOKED" instead of quietly disappearing.
      loadAgentRevocations(db, userId),
      db.select().from(userAgentPolicies).where(eq(userAgentPolicies.userId, userId)),
    ]);
    const revokedById = new Map(revoked.map((r) => [r.agentId, r]));

    // Direct grants win the displayed entry; a role that also grants the same
    // agent surfaces as provenance on that row (roles[]). A role-ONLY agent
    // becomes its own source:"role" row so the Access-preview is complete.
    const directIds = new Set(grants.map((g) => g.agentId));
    const revocationView = (agentId: string) => {
      const rev = revokedById.get(agentId);
      return rev
        ? { revoked: true as const, revocationId: rev.id, revocationReason: rev.reason ?? null }
        : { revoked: false as const };
    };
    const direct = grants.map((g) => ({
      ...g,
      source: "direct" as const,
      roles: roleGrants.filter((r) => r.agentId === g.agentId).map((r) => r.roleName ?? r.roleId),
      ...revocationView(g.agentId),
    }));
    const roleOnlyIds = [...new Set(roleGrants.map((r) => r.agentId).filter((id) => !directIds.has(id)))];
    const roleAgentMeta = roleOnlyIds.length
      ? await db
          .select({
            id: agents.id,
            name: agents.name,
            provider: agents.provider,
            tier: agents.tier,
            model: agents.model,
            enabled: agents.enabled,
          })
          .from(agents)
          .where(inArray(agents.id, roleOnlyIds))
      : [];
    const metaById = new Map(roleAgentMeta.map((a) => [a.id, a]));
    const roleOnly = roleOnlyIds
      .map((agentId) => {
        const meta = metaById.get(agentId);
        if (!meta) return null;
        // First role granting this agent owns the displayed grant row; every
        // granting role still shows in roles[] for provenance.
        const granting = roleGrants.filter((r) => r.agentId === agentId);
        const primary = granting[0];
        if (!primary) return null;
        return {
          agentId,
          name: meta.name,
          provider: meta.provider,
          tier: meta.tier,
          model: meta.model,
          enabled: meta.enabled,
          allowedModes: primary.allowedModes,
          grantId: primary.id,
          source: "role" as const,
          roles: granting.map((r) => r.roleName ?? r.roleId),
          ...revocationView(agentId),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    // The whole policy, not half of it: an editor that can set a run budget
    // but never read the current one makes every edit a guess.
    return {
      agents: [...direct, ...roleOnly],
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

    // ADR-0066 §3 — THE PER-KEY ALLOW-LIST ON THE NATIVE DISPATCH PATH.
    // The same check runs inside the dispatch core for the SERVED agent (so
    // pillar-6 routing cannot route around it, and neither can a fallback hop).
    // It ALSO runs here, on the REQUESTED agent, for two reasons a check in
    // only one place would miss: `dispatch: false` never reaches the core at
    // all, so a decision-only invoke would otherwise answer for a model the key
    // may not touch; and refusing at the entry point names the agent the caller
    // actually asked for instead of whatever routing settled on.
    //
    // The BUDGET is checked here as well, and not only in the core, for a
    // reason the core cannot see: a semantic-cache HIT returns before the core
    // is ever called. That hit costs $0, so leaving it unchecked would not
    // overspend — but it would make an exhausted key work intermittently
    // (fine on a prompt somebody asked before, 402 on a new one), which is both
    // baffling to the holder and a free oracle for probing what is cached. An
    // exhausted key refuses, consistently.
    const invokeVirtualKey = await loadVirtualKeyContext(db, req);
    if (invokeVirtualKey) {
      const refusal =
        virtualKeyAllowListRefusal(invokeVirtualKey, agent) ??
        virtualKeyBudgetRefusal(invokeVirtualKey);
      if (refusal) {
        await db.insert(auditLog).values({
          userId,
          objectType: "virtual_key",
          objectId: invokeVirtualKey.id,
          detail: { phase: "invoke", agentId: agent.id, agentName: agent.name, model: agent.model },
          effect: "deny",
          ruleId: refusal.ruleId,
          ruleChain: [],
          reason: refusal.detail,
        });
        return reply.status(refusal.status).send({ error: refusal.error, detail: refusal.detail });
      }
    }

    // ADR-0021: the org-wide functional defaults, loaded ONCE per request
    // (the interception-settings pattern) and threaded to every consumption
    // point below. A fresh row is behaviour-preserving by construction.
    const org = await loadOrgSettings(db);

    // ADR-0021 size ceilings — each narrows BELOW the zod wall (which stays
    // the absolute maximum). Defaults equal the shipped composer's own
    // clamps, so nothing changes until an admin narrows them.
    if ((body.attachments?.length ?? 0) > org.maxAttachmentsPerDispatch) {
      return reply.status(422).send({
        error: "too_many_attachments",
        detail: `this deployment allows at most ${org.maxAttachmentsPerDispatch} attachment(s) per dispatch`,
      });
    }
    for (const a of body.attachments ?? []) {
      const decodedBytes = Math.floor((a.dataBase64.length * 3) / 4);
      if (decodedBytes > org.maxAttachmentBytes) {
        return reply.status(422).send({
          error: "attachment_too_large",
          detail: `attachment '${a.name}' is ~${decodedBytes} bytes decoded; this deployment allows at most ${org.maxAttachmentBytes} bytes per attachment`,
        });
      }
    }

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

    // PILLAR 2 §2 stage 2 (ADR-0079) — WORKFLOW-INSTANCE ATTRIBUTION AND THE
    // PLAN-ONLY GATE. Validated exactly like `projectId` above: an unknown or
    // unauthorized instance REFUSES rather than being ignored. When the named
    // instance rests at a `planning` stage, a mutating mode is refused here —
    // before any dispatch, cache lookup or billing — and a plan/read mode is
    // allowed through untouched. Naming no instance is unconstrained, exactly
    // as before: this is opt-in attribution, and the ADR says so plainly.
    if (body.instanceId) {
      const gate = await guardInstanceAttributedCall(db, {
        instanceId: body.instanceId,
        userId,
        isAdmin: req.authCtx.isAdmin,
        mode: body.mode,
        detail: { phase: "invoke", agentId: agent.id, agentName: agent.name },
      });
      if (!gate.ok) return reply.status(gate.status).send({ error: gate.error, detail: gate.detail });
    }

    // §8.4 STREAMING SUPPRESSION (ADR-0019, closing the recorded known limit).
    // The output PII check can only run once the full text exists, so on a
    // block-mode project an SSE delta stream would flash raw model output at
    // the client before the result event could overwrite it with the withheld
    // marker — the bytes are already on the wire and out of our control. So a
    // block-mode project gets NO delta stream at all: the same governed
    // dispatch runs fully buffered and returns the ordinary JSON payload, with
    // the output check applied before a single byte leaves. This is disclosed,
    // not silent — `streamingSuppressed: true` rides the response and the audit
    // detail, so a client that asked for SSE learns why it got JSON instead.
    // Input-block stays exactly as it was: pre-call, no dispatch, no cost.
    // Only computed when the caller actually asked to stream, so the
    // non-streaming path takes no extra query.
    //
    // ADR-0042 extends the SAME rule to the guardrail engine: an output-phase
    // detector at `block` has the identical "decision needs the whole text"
    // problem, so it suppresses the delta stream identically and the existing
    // `streamingOnBlockMode: 'reject'` posture applies unchanged. This check
    // uses the REQUESTED agent, because routing has not run yet; the served
    // agent's own override is still caught by the core's buffer-and-flush in
    // executeGovernedDispatch, which is the actual guarantee — this one is the
    // early, disclosed refusal.
    const streamSuppressed =
      body.stream === true &&
      ((await projectPiiMode(db, projectId)) === "block" ||
        (await resolveGuardrailPolicy(db, { projectId, agentId: agent.id })).blocksOutput);
    // ADR-0021: 'suppress' (default) keeps ADR-0019's buffer-and-disclose;
    // 'reject' refuses the stream request outright so a client that REQUIRES
    // streaming learns immediately instead of receiving an unasked-for shape.
    if (streamSuppressed) {
      const iset = await loadInterceptionSettings(db);
      if (iset.streamingOnBlockMode === "reject") {
        return reply.status(400).send({
          error: "streaming_rejected_on_block_project",
          detail:
            "an output-phase content control is in 'block' mode for this call (the project's PII mode, or an ADR-0042 guardrail detector) and this deployment rejects streaming in that case — retry without stream:true",
        });
      }
    }
    const useStream = body.stream === true && !streamSuppressed;
    const suppressionFlag = streamSuppressed ? { streamingSuppressed: true as const } : {};

    const [grants, roleAgentGrantsForUser, agentRevocationsForUser, [policy]] = await Promise.all([
      db.select().from(agentGrants).where(eq(agentGrants.userId, userId)),
      // §5 role-bundled grants (ADR-0014) — a role-granted agent must invoke
      // just like a directly granted one.
      loadRoleAgentGrants(db, userId),
      // ADR-0019 — and a per-user revocation must take it away again, whether
      // the grant came from a role or directly.
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
      roleAgentGrants: roleAgentGrantsForUser,
      agentRevocations: agentRevocationsForUser,
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
      // §8.4 PII INPUT GATE — hoisted ahead of BOTH the semantic-cache serve and
      // the per-technique cost_events writes below, so a PII-bearing prompt can
      // neither be answered from cache without adjudication nor leave phantom
      // estimate rows before it is blocked. dispatchAttempt keeps its own gate
      // for the orchestration/worker-node paths that never reach this handler.
      // Runs only when dispatching (a decision-only invoke sends nothing to a
      // model and produces no output to leak).
      if (body.dispatch === true) {
        const inputBlock = await enforceProjectInputPii(db, userId, agent.id, projectId, body.input);
        if (inputBlock) {
          return reply
            .status(inputBlock.status)
            .send({ decision, error: inputBlock.error, detail: inputBlock.detail, pii: inputBlock.pii, ...suppressionFlag });
        }
      }
      // PILLAR 6 §8/§10 SEMANTIC CACHING (REAL cache) — opt-in per-(user,agent)
      // EXACT-MATCH response cache. When enabled, an identical (whitespace/
      // case-normalized) single-turn input already answered for the SAME
      // user+agent within the TTL is served straight from the cache, skipping
      // the provider call entirely (no usage_events, no spend). "passthrough"
      // is §12's off switch; conversation dispatches are excluded (a single
      // input key can't stand in for multi-turn history). When off, this is
      // byte-identical to today — no lookup, no store. The lookup is scoped by
      // BOTH userId AND agentId: a user can NEVER be served another user's (or
      // another agent's) cached response (§12).
      // ADR-0021: the CEILING MODEL for every pillar-6 technique — org toggle
      // off forces passthrough; org on defers to the user's own routingMode
      // (their passthrough still wins), else the org default for unset users.
      const userRoutingMode = policy?.routingMode ?? null;
      const modeFor = (techniqueEnabled: boolean) =>
        effectiveTechniqueMode(org, techniqueEnabled, userRoutingMode);
      // ADR-0021 semantic-cache POLICY: 'off' beats a caller's opt-in; 'opt_in'
      // (default) = today's caller-opt-in; 'always' caches every eligible
      // dispatch. A passthrough user (or org default) still disables it.
      const routingModeForCache = modeFor(true);
      const cachePolicyWants =
        org.semanticCachePolicy === "always"
          ? true
          : org.semanticCachePolicy === "opt_in"
            ? body.semanticCache === true
            : false;
      const wantCache =
        cachePolicyWants &&
        body.dispatch === true &&
        !!body.input &&
        !convo &&
        routingModeForCache !== "passthrough";
      let cacheNorm: string | null = null;
      let cacheHash: string | null = null;
      if (wantCache && body.input) {
        cacheNorm = normalizeCacheInput(body.input);
        cacheHash = createHash("sha256").update(cacheNorm).digest("hex");
        const ttlCutoff = new Date(Date.now() - org.semanticCacheTtlSeconds * 1000);
        // THE GOVERNANCE BOUNDARY: userId AND agentId (the invoked agent) AND a
        // fresh row; the stored normalizedInput is re-checked as a hash-collision
        // guard before anything is served.
        const [hit] = await db
          .select()
          .from(semanticCache)
          .where(
            and(
              eq(semanticCache.userId, userId),
              eq(semanticCache.agentId, agent.id),
              eq(semanticCache.promptHash, cacheHash),
              gte(semanticCache.createdAt, ttlCutoff),
            ),
          )
          .limit(1);
        if (hit && hit.normalizedInput === cacheNorm) {
          // The input was gated above; the CACHED OUTPUT may still carry PII it
          // acquired under a different, ungated attribution. Withhold it rather
          // than serve it on a project whose mode is `block`.
          const outputBlock = await enforceProjectCachedOutputPii(
            db,
            userId,
            agent.id,
            projectId,
            hit.outputText,
          );
          if (outputBlock) {
            return reply
              .status(outputBlock.status)
              .send({ decision, error: outputBlock.error, detail: outputBlock.detail, pii: outputBlock.pii, ...suppressionFlag });
          }
          // HIT: no provider call, no usage_events (no real spend). One
          // semantic_caching cost_events row estimates the WHOLE call saved —
          // full cached input+output tokens at the invoked agent's list price
          // (null when the agent is unpriced; the cache row itself stores no
          // price, and the invoked agent is the one the cache is scoped to).
          const savedTokens = hit.inputTokens + hit.outputTokens;
          const estimatedCostSavedUsd =
            agent.costPerMTokIn != null && agent.costPerMTokOut != null
              ? Number(
                  (
                    (hit.inputTokens / 1e6) * agent.costPerMTokIn +
                    (hit.outputTokens / 1e6) * agent.costPerMTokOut
                  ).toFixed(6),
                )
              : null;
          await db.insert(costEvents).values({
            userId,
            objectType: "agent",
            objectId: agent.id,
            technique: "semantic_caching",
            requestedAgentId: agent.id,
            servedAgentId: agent.id,
            baselineAgentId: agent.id,
            estimatedTokensIn: hit.inputTokens,
            estimatedTokensOut: hit.outputTokens,
            estimatedTokensSaved: savedTokens,
            estimatedCostSavedUsd,
            estimationBasis:
              "semantic-caching: whole call served from the per-(user,agent) exact-match cache — full cached input+output tokens saved at the invoked agent's list price",
            ruleId: "semantic-cache-hit",
            projectId,
            detail: { model: hit.model, cachedAt: hit.createdAt, mode: body.mode },
          });
          const cachedDispatch = {
            servedAgentId: agent.id,
            model: hit.model,
            outputText: hit.outputText,
            stopReason: "cached",
            refusal: false,
            usage: { inputTokens: hit.inputTokens, outputTokens: hit.outputTokens },
            costUsd: 0,
            measuredCostSavedUsd: null,
            credentialSource: "none" as const,
            projectBudgetAlerted: false,
            cached: true as const,
          };
          await db.insert(auditLog).values({
            userId,
            objectType: "agent",
            objectId: agent.id,
            detail: {
              mode: body.mode,
              servedAgentId: agent.id,
              semanticCache: { hit: true, model: hit.model, cachedAt: hit.createdAt },
            },
            effect: decision.effect,
            ruleId: decision.ruleId,
            ruleChain: decision.ruleChain,
            reason: decision.reason,
          });
          if (useStream) {
            reply.hijack();
            reply.raw.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            });
            const send = (event: string, data: unknown) =>
              reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
            // A hit need not simulate token-by-token streaming: emit the cached
            // text as one delta, then the final result event.
            send("delta", { text: hit.outputText });
            send("result", { decision, cached: true, dispatch: cachedDispatch });
            reply.raw.end();
            return reply;
          }
          return reply.send({ decision, cached: true, dispatch: cachedDispatch, ...suppressionFlag });
        }
      }

      // PILLAR-6 HONESTY: the per-technique cost_events rows below are only
      // ESTIMATES for the dispatch this handler is about to attempt. They used
      // to be inserted eagerly, BEFORE performDispatch — but the dispatch core
      // still holds refusal gates of its own (virtual-key ceiling, MRM,
      // project budget, §8.4 PII, ADR-0042 guardrail input, egress, missing
      // credential), so a dispatch those gates refused had already left
      // phantom savings rows attributed to the project. That is the same
      // disease the enforceProjectInputPii hoist fixed for PII only (see its
      // comment), proved by probe: a 409 project_budget_exceeded left a
      // model_routing row claiming savings for a call that never ran. So the
      // rows are STAGED here and flushed only once the outcome is known: a
      // decision-only invoke flushes immediately (the routing DECISION is the
      // deliverable, pinned behaviour), a dispatching invoke flushes only on a
      // successful outcome — bill-and-withhold outcomes included, because that
      // dispatch really ran and really billed.
      const pendingCostEvents: Array<typeof costEvents.$inferInsert> = [];
      const flushPendingCostEvents = async () => {
        if (pendingCostEvents.length > 0) await db.insert(costEvents).values(pendingCostEvents);
      };

      const registry = await db.select().from(agents).where(eq(agents.enabled, true));
      const entitled = registry.filter(
        (a) =>
          evaluateAgent({
            userId,
            agent: { id: a.id, name: a.name, tier: a.tier, enabled: a.enabled, modes: a.modes ?? null },
            mode: body.mode,
            agentGrants: grants,
            roleAgentGrants: roleAgentGrantsForUser,
            // ADR-0019: the routing roster is exactly what evaluateAgent would
            // allow, so a revoked agent must not be a routing candidate either
            // — otherwise the optimizer could serve an agent governance denies.
            agentRevocations: agentRevocationsForUser,
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
          if (!configured.has(agentProviderToken(a))) return "no_model_credential";
          return null;
        };
        skippedCandidates = entitled.flatMap((a) => {
          const reason = skipReason(a);
          return reason ? [{ agentId: a.id, name: a.name, reason }] : [];
        });
        const skippedIds = new Set(skippedCandidates.map((s) => s.agentId));
        candidateRows = entitled.filter((a) => !skippedIds.has(a.id));
        compactionCandidates = entitled.filter(
          (a) => a.model && isModelProviderKind(a.provider) && configured.has(agentProviderToken(a)),
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
      // the full stored history dispatches verbatim. ADR-0021: the org
      // compactionEnabled toggle is the ceiling above that, and the
      // threshold/window dials + failure mode + summarizer selection ride the
      // org settings row into the compactor.
      if (convo && body.dispatch && modeFor(org.compactionEnabled) !== "passthrough") {
        convoContext = await prepareConversationContext(db, opts.dataKey, {
          userId,
          conversation: convo.conversation,
          messages: convo.messages,
          candidates: compactionCandidates,
          projectId,
          execute: executeGovernedDispatch,
          org,
        });
        // ADR-0021 fail_closed: a failed compaction fails the TURN instead of
        // silently dispatching the full history — for orgs whose posture is
        // "never send what we decided to compact away un-summarized".
        if (convoContext.failClosed) {
          return reply.status(502).send({
            error: "compaction_failed",
            detail: `context compaction failed (${convoContext.failClosed.error}) and this deployment's compaction failure mode is fail_closed`,
            ...suppressionFlag,
          });
        }
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
      // PILLAR 6 §8 file preprocessing: large reference/file content attached to
      // the dispatch is deterministically shrunk before the model sees it. The
      // model only ever receives the PROCESSED content, so fold the PROCESSED
      // size into the routing estimate (the original size when preprocessing
      // doesn't apply) — routing, budget, and cost must reflect the ACTUAL sent
      // size, exactly like the baseline above.
      const fpp = planFilePreprocessing({
        referenceText: body.referenceContent,
        routingMode: modeFor(org.filePreprocessingEnabled),
        minTokens: org.minPreprocessTokens,
      });
      const referenceTokens = Math.ceil(
        (fpp.apply ? fpp.processedText.length : (body.referenceContent?.length ?? 0)) / 4,
      );
      if (referenceTokens) estimate.in += referenceTokens;
      // MULTIMODAL ATTACHMENTS: images the model sees as vision and PDFs it
      // reads as documents are real input the dispatch must pay for, so fold a
      // bounded per-attachment estimate into the routing/budget/cost input the
      // same additive way. An image is a flat ~1.2k-token allowance (a rough
      // upper bound for a resized vision tile); a PDF is estimated from its
      // decoded byte size at the usual ~4 chars/token, since Claude reads its
      // extracted text. Non-vision providers only see the tiny placeholder, but
      // charging the upper bound keeps the estimate conservative regardless of
      // which agent routing lands on. Absent attachments → no change.
      const attachmentTokens = (body.attachments ?? []).reduce((sum, a) => {
        if (a.kind === "image") return sum + org.imageTokenEstimateTokens;
        // base64 is ~4/3 the decoded size; decoded/4 ≈ base64Length * 3 / 16
        return sum + Math.ceil((a.dataBase64.length * 3) / 16);
      }, 0);
      if (attachmentTokens) estimate.in += attachmentTokens;
      routing = routeModel({
        requestedAgentId: agent.id,
        candidates,
        routingMode: modeFor(org.routingEnabled),
        complexity,
        costSensitivity: body.costSensitivity,
        ceilingTier,
        estimate,
      });
      // Purely additive to the trace: the kernel's own fields keep meaning
      // exactly what they meant, and the agents it never got to weigh are
      // listed beside them with the reason each was withheld.
      if (skippedCandidates.length > 0) routing = { ...routing, skippedCandidates };
      // ADR-0021: with the ORG routing toggle off the technique does not run
      // at all — no model_routing ledger row is written (a per-user
      // passthrough, org toggle on, still records its passthrough decision,
      // exactly as today).
      if (org.routingEnabled) {
        pendingCostEvents.push({
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
      }

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
        pendingCostEvents.push({
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
      // ADR-0024 estimation-accuracy fix: what the provider actually caches is
      // the FULL outgoing system — the SERVED agent's admin-authored base
      // prompt (ADR-0023, prepended in executeGovernedDispatch) PLUS the
      // caller's system — so the cacheable-token estimate must count both.
      // Counting only the caller's part both under-reported savings and could
      // wrongly skip caching when the base alone cleared the provider minimum.
      const routedForCacheEstimate = routing;
      const servedForCacheEstimate = routedForCacheEstimate
        ? registry.find((a) => a.id === routedForCacheEstimate.selectedAgentId)
        : agent;
      const adminBasePrompt = servedForCacheEstimate?.systemPrompt ?? undefined;
      const outgoingSystem = [adminBasePrompt, systemPrompt].filter(Boolean).join("\n\n");
      const systemTokens = outgoingSystem ? Math.ceil(outgoingSystem.length / 4) : 0;
      const promptCache = planPromptCache({
        systemTokens,
        routingMode: modeFor(org.promptCachingEnabled),
        minCacheableTokens: org.minCacheableTokens,
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
                  // ADR-0021: the cache-read discount is an org dial (default =
                  // the kernel's Anthropic-ephemeral 0.9)
                  org.cacheReadDiscount
                ).toFixed(6),
              )
            : null;
        pendingCostEvents.push({
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
        routingMode: modeFor(org.editVsRewriteEnabled),
        minBaselineTokens: org.minEditableBaselineTokens,
      });
      if (body.dispatch && editPlan.mode === "edit" && routing) {
        const routed = routing;
        const servedRow = registry.find((a) => a.id === routed.selectedAgentId);
        const estimatedCostSavedUsd =
          servedRow?.costPerMTokOut != null
            ? Number(((editPlan.estimatedTokensSaved / 1e6) * servedRow.costPerMTokOut).toFixed(6))
            : null;
        pendingCostEvents.push({
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

      // PILLAR 6 §8 FILE PREPROCESSING — a pure cost annotation on this
      // ALREADY-authorized dispatch: the kernel deterministically shrinks the
      // attached reference content (collapse redundant whitespace, elide long
      // data blobs) WITHOUT changing meaning; the reduced content is what the
      // model actually receives (composed below), and one estimate row lands in
      // the SAME per-technique ledger. It NEVER changes the served agent, model,
      // entitlement, budget, or output — guarded on `routing` like the caching
      // and edit-vs-rewrite blocks. "passthrough" is the per-user off switch.
      // The saving is INPUT tokens (a smaller reference sent to the model), so
      // dollars = saved tokens at the SERVED agent's INPUT list price. Written
      // only when preprocessing actually reduces the content.
      if (body.dispatch && fpp.apply && routing) {
        const routed = routing;
        const servedRow = registry.find((a) => a.id === routed.selectedAgentId);
        const estimatedCostSavedUsd =
          servedRow?.costPerMTokIn != null
            ? Number(((fpp.estimatedTokensSaved / 1e6) * servedRow.costPerMTokIn).toFixed(6))
            : null;
        pendingCostEvents.push({
          userId,
          objectType: "agent",
          objectId: agent.id,
          technique: "file_preprocessing",
          requestedAgentId: agent.id,
          servedAgentId: routing.selectedAgentId,
          baselineAgentId: routing.baselineAgentId,
          estimatedTokensIn: estimate.in,
          estimatedTokensOut: estimate.out,
          estimatedTokensSaved: fpp.estimatedTokensSaved,
          estimatedCostSavedUsd,
          estimationBasis: fpp.estimationBasis,
          ruleId: "file-preprocessing",
          projectId,
          detail: {
            referenceChars: body.referenceContent?.length ?? 0,
            savedTokens: fpp.estimatedTokensSaved,
            mode: body.mode,
          },
        });
      }

      // Compose the OUTGOING system + input. Both are ADDITIVE: with neither
      // technique active they are byte-identical to today. Prompt caching
      // supplies the stable `system`; edit-vs-rewrite (when applied) appends a
      // compact-diff directive to that system and the supplied baseline to the
      // input, so the model actually receives the diff instruction + the
      // content it must edit (not just an accounting row); file preprocessing
      // (when reference content is supplied) appends the PROCESSED reference to
      // the input the same additive way — after the baseline block if both are
      // present.
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
      if (body.referenceContent) {
        // The model sees the PROCESSED reference when preprocessing applied, the
        // original otherwise (fpp.processedText === original in that case).
        // Absent referenceContent → byte-identical to today.
        dispatchInput =
          dispatchInput +
          "\n\n----- REFERENCE -----\n" +
          (fpp.apply ? fpp.processedText : body.referenceContent);
      }

      // MULTIMODAL: when the caller attached images/PDFs, the newest user turn
      // is an ordered block array — the composed text first, then each
      // attachment as an image/document block — instead of a plain string. Only
      // Claude sees the bytes; other providers get a short placeholder. A turn
      // with no attachments stays a plain string (byte-identical to before).
      const attachmentBlocks: ModelContentBlock[] = (body.attachments ?? []).map((a) => ({
        type: a.kind,
        mediaType: a.mediaType,
        dataBase64: a.dataBase64,
        name: a.name,
      }));
      const userTurnContent: string | ModelContentBlock[] = attachmentBlocks.length
        ? [
            ...(dispatchInput ? [{ type: "text" as const, text: dispatchInput }] : []),
            ...attachmentBlocks,
          ]
        : dispatchInput;

      // MULTI-TURN: a conversation dispatch sends the model-bound history —
      // [summary context] + recent verbatim turns when a summary exists, the
      // FULL ordered history otherwise — plus the newest user turn as the
      // provider messages array; the governed pipeline around it (policy,
      // routing, budget, attribution, audit, usage ledger) is exactly the
      // single-turn one. A single-turn dispatch WITH attachments also needs a
      // messages array (a bare `input` string can't carry blocks), so build a
      // one-turn array in that case; a plain single turn keeps riding `input`.
      const messages: ModelChatMessage[] | undefined =
        convo && body.dispatch
          ? [
              ...(convoContext ? convoContext.modelBound : convo.history),
              { role: "user" as const, content: userTurnContent },
            ]
          : attachmentBlocks.length && body.dispatch
            ? [{ role: "user" as const, content: userTurnContent }]
            : undefined;
      // One persistence rule for the streaming and non-streaming paths —
      // the exact contract lives in conversations.ts. A failed outcome
      // persists nothing (never a half-written turn).
      // Stored history keeps a NAMED marker for each attachment, never the
      // base64 bytes: the thread stays small and, crucially, a later turn does
      // NOT re-send (or re-bill) the image/PDF — it only records that one was
      // attached at that turn.
      const attachmentMarker = body.attachments?.length
        ? `\n\n${body.attachments.map((a) => `[attached ${a.kind}: ${a.name}]`).join(" ")}`
        : "";
      const persistTurns = async (outcome: DispatchOutcome) => {
        if (!convo || !outcome.ok) return;
        const r = outcome.result;
        await recordConversationTurns(db, convo.conversation, {
          userContent: (body.input ?? "") + attachmentMarker,
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

      // PILLAR 6 §8/§10 SEMANTIC CACHING — MISS store side: after a successful,
      // non-refusal, non-withheld dispatch, upsert the result keyed by
      // (userId, agentId=invoked agent, promptHash) so a later identical re-ask
      // is a HIT. onConflict refreshes the output/tokens AND createdAt, so the
      // TTL slides on reuse. Only reached when the cache is opted in (wantCache);
      // otherwise a no-op (byte-identical to the pre-caching path). No
      // cost_events on a miss — nothing was saved yet.
      const storeSemanticCacheIf = async (outcome: DispatchOutcome) => {
        if (!wantCache || !cacheHash || cacheNorm == null || !outcome.ok) return;
        const r = outcome.result;
        // never store a refusal, an empty output, or a PII-withheld marker
        if (r.refusal || !r.outputText || r.pii?.withheld) return;
        await db
          .insert(semanticCache)
          .values({
            userId,
            agentId: agent.id,
            promptHash: cacheHash,
            normalizedInput: cacheNorm,
            outputText: r.outputText,
            model: r.model,
            inputTokens: r.usage.inputTokens,
            outputTokens: r.usage.outputTokens,
          })
          .onConflictDoUpdate({
            target: [semanticCache.userId, semanticCache.agentId, semanticCache.promptHash],
            set: {
              normalizedInput: cacheNorm,
              outputText: r.outputText,
              model: r.model,
              inputTokens: r.usage.inputTokens,
              outputTokens: r.usage.outputTokens,
              createdAt: new Date(),
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
      //
      // A DECISION-ONLY invoke first: nothing further can refuse it, so the
      // staged estimate rows (only model_routing can be pending here) land now
      // — the routing decision itself is the recorded event, exactly as before.
      if (!body.dispatch) await flushPendingCostEvents();

      if (body.dispatch && useStream) {
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
          virtualKey: invokeVirtualKey,
        });
        // savings are only claimed for work that happened (see the staging
        // comment above) — a refused/failed stream leaves the ledger untouched
        if (outcome.ok) await flushPendingCostEvents();
        await persistTurns(outcome);
        await storeSemanticCacheIf(outcome);
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
            ...(outcome.guardrails ? { guardrails: outcome.guardrails } : {}),
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
          virtualKey: invokeVirtualKey,
        });
        // savings are only claimed for work that happened (see the staging
        // comment above) — a refused/failed dispatch leaves the ledger untouched
        if (dispatchOutcome.ok) await flushPendingCostEvents();
        await persistTurns(dispatchOutcome);
        await storeSemanticCacheIf(dispatchOutcome);
      }
    }

    const [decisionAuditRow] = await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: agent.id,
      // §8: the served model is always visible in the execution log
      detail: {
        mode: body.mode,
        ...(routing ? { servedAgentId: routing.selectedAgentId } : {}),
        ...(routing?.skippedCandidates ? { routingSkippedCandidates: routing.skippedCandidates } : {}),
        ...(convoContext?.publicDetail ? { compaction: convoContext.publicDetail } : {}),
        // §8.4: the caller asked for SSE and got a buffered JSON reply instead
        // because the project's PII mode is 'block' — recorded, never silent.
        ...suppressionFlag,
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
    }).returning({ id: auditLog.id });

    // ADR-0070 — THE MOST VALUABLE SPAN IN THIS PRODUCT: the one that shows why
    // NOTHING happened.
    //
    // Every refusal INSIDE the dispatch core (virtual-key ceiling, MRM gate,
    // project budget, §8.4 PII, ADR-0042 guardrails, egress, missing
    // credential) already becomes a `denied` span, because the core's traced
    // wrapper records one from whatever the attempt returned. A pillar-1
    // ENTITLEMENT denial never reaches the core at all — it is decided here, at
    // the entry point, and returned — so without this block the single most
    // common governance refusal in the product would be the ONE thing with no
    // trace. It gets a one-span `dispatch` trace whose root is a `policy` span
    // carrying the kernel's own reason and REFERENCING the audit row just
    // written. No usage row exists (nothing was billed) and none is invented.
    if (decision.effect !== "allow") {
      const denyTrace = await beginTrace(db, {
        kind: "dispatch",
        name: `denied: ${agent.name}`,
        userId,
        projectId,
        ...(convo ? { sessionId: convo.conversation.id, rootRefId: convo.conversation.id } : {}),
      });
      if (denyTrace) {
        const at = new Date();
        await recordSpan(db, denyTrace, {
          kind: "policy",
          name: `entitlement: ${agent.name}`,
          status: "denied",
          statusReason: decision.reason,
          startedAt: at,
          endedAt: at,
          agentId: agent.id,
          auditLogId: decisionAuditRow?.id ?? null,
          model: agent.model,
          provider: agent.provider,
          attributes: {
            mode: body.mode,
            ruleId: decision.ruleId,
            ruleChain: decision.ruleChain,
            effect: decision.effect,
            ...(projectId ? { projectId } : {}),
          },
        });
        await finishTrace(db, denyTrace, "denied", at);
      }
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
        ...(dispatchOutcome.guardrails ? { guardrails: dispatchOutcome.guardrails } : {}),
        // ADR-0066 §4: an EXHAUSTED chain must be as visible as a successful
        // one. Without this the caller sees only the primary's failure and has
        // no way to know that three governed alternatives were tried.
        ...(dispatchOutcome.fallback ? { fallback: dispatchOutcome.fallback } : {}),
        ...(dispatchOutcome.trace ? { trace: dispatchOutcome.trace } : {}),
        ...suppressionFlag,
      });
    }
    return reply.send({
      decision,
      routing,
      // ADR-0070: the trace coordinates ride out with the dispatch, so a caller
      // (and the SPA) can open the tree for the call it just made without
      // guessing which of its traces was theirs.
      ...(dispatchOutcome
        ? {
            dispatch: {
              ...dispatchOutcome.result,
              ...(dispatchOutcome.trace ? { trace: dispatchOutcome.trace } : {}),
            },
          }
        : {}),
      ...(convoContext?.publicDetail ? { compaction: convoContext.publicDetail } : {}),
      ...suppressionFlag,
    });
  });

  // --- connectors (§2) ---

  app.post("/v1/connectors", async (req, reply) => {
    const body = createConnectorSchema.parse(req.body);
    // ADR-0034 amendment #2 — the earliest honest failure for a connector
    // endpoint. NOT a substitute for the invoke-time check (see the note
    // there): this is so a typo, or a deliberate IMDS/collector URL, is a 400
    // at the moment somebody types it rather than a surprise on a later user's
    // governed call.
    if (body.baseUrl) {
      const refusal = await refuseConnectionEgress(req, {
        surface: "connector",
        baseUrl: body.baseUrl,
        phase: "connector_write",
        label: `connector '${body.name}' baseUrl`,
        detail: { name: body.name, ...(body.providerKind ? { connectorKind: body.providerKind } : {}) },
      });
      if (refusal) return reply.status(400).send(refusal);
    }
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
    // ADR-0023: multi-field credentials ride a structured-JSON convention
    // INSIDE the one token (kind=snowflake: {account, user, privateKey,
    // passphrase?}). Validate the shape HERE, at connection-create time, so a
    // malformed credential 400s with an actionable message instead of failing
    // opaquely at first invoke. Single-field kinds are untouched.
    if (connector.providerKind === "snowflake") {
      try {
        parseSnowflakeCredential(body.token);
      } catch (err) {
        if (err instanceof ConnectorProviderError) {
          return reply
            .status(400)
            .send({ error: "invalid_connector_credential", detail: err.message });
        }
        throw err;
      }
    }
    // ADR-0034 amendment #2 — the credential `baseUrl` OVERRIDES the
    // connector's, so it is the same primitive and gets the same write-time
    // refusal. Checked after the credential-shape validation above so the more
    // specific message still wins when both are wrong.
    if (body.baseUrl) {
      const refusal = await refuseConnectionEgress(req, {
        surface: "connector",
        baseUrl: body.baseUrl,
        objectId: connectorId,
        phase: "connector_credential_write",
        label: `connector '${connector.name}' credential baseUrl`,
        detail: {
          name: connector.name,
          ...(connector.providerKind ? { connectorKind: connector.providerKind } : {}),
        },
      });
      if (refusal) return reply.status(400).send(refusal);
    }
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
    // ADR-0091: the SoD mint gate — refused 409 by name, audited, no row
    const sod = await refuseSodMint(
      db,
      { kind: "connector", userId: body.userId, connectorId: body.connectorId, mode: body.mode },
      req.authCtx.userId,
    );
    if (sod) return reply.status(409).send(sod);
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
    const [rows, roleGrants, revoked] = await Promise.all([
      db
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
        .where(eq(connectorGrants.userId, userId)),
      // §5 role-bundled grants (ADR-0014), folded into the Access-preview.
      loadRoleConnectorGrants(db, userId),
      // ADR-0019 — per-user revocations, flagged rather than silently hidden.
      loadConnectorRevocations(db, userId),
    ]);
    const revokedById = new Map(revoked.map((r) => [r.connectorId, r]));
    const revocationView = (connectorId: string) => {
      const rev = revokedById.get(connectorId);
      return rev
        ? { revoked: true as const, revocationId: rev.id, revocationReason: rev.reason ?? null }
        : { revoked: false as const };
    };

    const directIds = new Set(rows.map((r) => r.connectorId));
    const direct = rows.map((r) => ({
      ...r,
      source: "direct" as const,
      roles: roleGrants
        .filter((g) => g.connectorId === r.connectorId)
        .map((g) => g.roleName ?? g.roleId),
      ...revocationView(r.connectorId),
    }));
    const roleOnlyIds = [
      ...new Set(roleGrants.map((g) => g.connectorId).filter((id) => !directIds.has(id))),
    ];
    const roleConnMeta = roleOnlyIds.length
      ? await db
          .select({ id: connectors.id, name: connectors.name, kind: connectors.kind })
          .from(connectors)
          .where(inArray(connectors.id, roleOnlyIds))
      : [];
    const metaById = new Map(roleConnMeta.map((c) => [c.id, c]));
    const roleOnly = roleOnlyIds
      .map((connectorId) => {
        const meta = metaById.get(connectorId);
        if (!meta) return null;
        const granting = roleGrants.filter((g) => g.connectorId === connectorId);
        const primary = granting[0];
        if (!primary) return null;
        return {
          connectorId,
          name: meta.name,
          kind: meta.kind,
          mode: primary.mode,
          allowedObjects: primary.allowedObjects,
          grantId: primary.id,
          source: "role" as const,
          roles: granting.map((g) => g.roleName ?? g.roleId),
          ...revocationView(connectorId),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    return { connectors: [...direct, ...roleOnly] };
  });

  app.post("/v1/connectors/:connectorId/invoke", async (req, reply) => {
    const { connectorId } = connectorIdParam.parse(req.params);
    const body = invokeConnectorSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) return reply.status(403).send({ error: "bootstrap_cannot_invoke" });

    const [connector] = await db.select().from(connectors).where(eq(connectors.id, connectorId));
    if (!connector) return reply.status(404).send({ error: "unknown_connector" });

    // ─────────────────────────────────────────────────────────────────────
    // ADR-0070 amendment (2026-08-15) — THE CONNECTOR SPAN.
    //
    // `connector` was a DECLARED span kind with no writer, which made the
    // vocabulary promise coverage the product did not have. It is emitted here,
    // and it is emitted by a WRAPPER for exactly the reason the dispatch core's
    // span is: this handler has FOURTEEN exits and eleven of them are refusals.
    // A recorder sprinkled through the branches would trace the successes and
    // miss the denials — "a trace of only the successes" is failure mode 2 in
    // the ADR, and on a connector it is the worst one available, because a
    // connector call is where customer data actually moves.
    //
    // So the whole governed body answers into a RECORDER instead of the Fastify
    // reply, and the one span is written from whatever came back. Adding a
    // fifteenth refusal below cannot forget to be traced, because nothing below
    // mentions tracing.
    //
    // WHAT COUNTS AS A REFUSAL, and why the split is where it is: every 4xx this
    // route produces is a DECISION (the entitlement kernel, §8.4 PII, an
    // ADR-0042 guardrail, the ADR-0034/0062 egress guard, a missing credential,
    // an unrecognised provider). Only a 5xx is a fault — a 502 from the upstream
    // connector or a 503 for a missing data key. That is the same line
    // `dispatchOnce` draws when it calls `model_dispatch_failed` the one
    // non-decision, and it is the line ADR-0072 exists to protect: a defence
    // working must never be scored as a defence failing.
    // ─────────────────────────────────────────────────────────────────────
    const projectId = body.projectId ?? null;
    /** filled at the ONE place the ledger row is written, so the span
     * REFERENCES that row rather than recomputing its figures (rule 1). */
    const sink: { usageEventId?: string | null; costUsd?: number | null } = {};
    const attempt = async (out: ConnectorReplyRecorder): Promise<ConnectorAttemptResult> => {
      // pillar 5 + ADR-0011: attribution must point at a real project the caller
      // may bill to — mirror the model invoke path. Checked up front, before any
      // execution or metering can happen.
      if (projectId) {
        const attribution = await assertProjectAttribution(db, projectId, userId, req.authCtx.isAdmin);
        if (!attribution.ok) return out.status(attribution.status).send({ error: attribution.error });
      }

      const [grants, roleConnectorGrantsForUser, connectorRevocationsForUser] = await Promise.all([
        db.select().from(connectorGrants).where(eq(connectorGrants.userId, userId)),
        // §5 role-bundled grants (ADR-0014): unioned in the kernel so a narrow
        // direct grant cannot mask a broader role grant.
        loadRoleConnectorGrants(db, userId),
        // ADR-0019: the subtractive bound on that union.
        loadConnectorRevocations(db, userId),
      ]);

      const decision = evaluateConnector({
        userId,
        connectorId,
        connectorName: connector.name,
        operation: body.operation,
        object: body.object ?? null,
        connectorGrants: grants,
        roleConnectorGrants: roleConnectorGrantsForUser,
        connectorRevocations: connectorRevocationsForUser,
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
        return out.status(403).send({ decision });
      }

      // EXECUTION runs strictly INSIDE the allow branch, after the audit insert.
      // A connector with no providerKind keeps TODAY'S behaviour exactly:
      // governance-only, no execution, no cost, no usage row.
      if (!connector.providerKind) {
        return out.send({ decision });
      }
      if (!isConnectorProviderKind(connector.providerKind)) {
        return out.status(409).send({
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
          return out.status(503).send({ error: "no_data_key", detail: "set REGULAIT_DATA_KEY" });
        }
        token = decryptSecret(opts.dataKey, cred.tokenCiphertext);
        if (cred.baseUrl) baseUrl = cred.baseUrl;
      } else if (!keylessKinds.has(connector.providerKind)) {
        return out.status(409).send({
          decision,
          error: "no_connector_credential",
          detail: `connector '${connector.name}' (${connector.providerKind}) has no stored credential`,
        });
      }

      // §8.4 PII ENFORCEMENT (pillar 3), connector path. The effective piiMode
      // comes from the attributed project's cascade; an unattributed or
      // unclassified call falls to the ORG FLOOR (ADR-0021 defaultPiiMode, null
      // when unset). The resolver is called unconditionally — the old
      // `projectId ? … : null` ternary here was exactly the one-keystroke
      // attribution dodge the floor exists to close. The INPUT check runs BEFORE
      // provider.invoke, so a block executes nothing and bills nothing.
      const piiMode: PiiMode | null = await projectPiiMode(db, projectId ?? null);
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
          return out.status(403).send({
            decision,
            error: "pii_blocked",
            detail: reason,
            pii: { mode: piiMode, action: "block", inputHits: chk.hits, outputHits: [], withheld: false },
          });
        }
      }

      // ADR-0042 GUARDRAIL ENGINE, connector path — the same two phases, the same
      // exclusion of PII (enforced on its own path above), the same audit rules.
      // Scoped to this connector's override (or the org default), MAX-composed
      // with the attributed project's compliance floor.
      const connectorGuardrails: GuardrailPolicy = await resolveGuardrailPolicy(db, {
        projectId,
        connectorId,
      });
      let cgInput: ReturnType<typeof runGuardrails> | null = null;
      if (connectorGuardrails.active) {
        cgInput = runGuardrails(
          connectorGuardrails,
          "input",
          JSON.stringify({ object: body.object ?? null, payload: body.payload ?? null }),
        );
        const outcome = guardrailOutcome(cgInput);
        if (outcome) {
          await recordGuardrailDecision(db, {
            userId,
            objectType: "connector",
            objectId: connectorId,
            projectId,
            evaluation: cgInput,
            outcome,
            detail: { operation: body.operation, connectorKind: connector.providerKind },
          });
        }
        if (cgInput.action === "block") {
          const reason = `input blocked by guardrail: ${guardrailCategoryList(cgInput.blocking)}`;
          return out.status(403).send({
            decision,
            error: "guardrail_blocked",
            detail: reason,
            guardrails: {
              action: "block",
              phase: "input",
              findings: flattenFindings(cgInput.findings),
              withheld: false,
            },
          });
        }
      }

      // ADR-0034 amendment #2 — THE CONNECTOR `baseUrl`, BEHIND THE EGRESS GUARD.
      //
      // This is the surface both earlier amendments named as the highest-priority
      // one still open, and it is worse than the model paths in one specific way:
      // the `webhook` kind does not READ the URL, it **POSTs `body.payload` to
      // it**. A governed connector call is exactly where customer data lives, so
      // an admin-typed `baseUrl` here is an exfiltration pipe, not merely an SSRF
      // primitive. It is checked HERE, on every invoke — not only at write time —
      // because a write-time verdict is not a fact about the future and because
      // rows written before this guard existed are in the live database now.
      //
      // NO OVERRIDE MEANS NO CHECK: with `baseUrl` null the adapter uses its
      // compiled vendor endpoint (slack/github/jira/... defaults), which nobody
      // can type, so a non-overriding connector behaves byte-identically — the
      // global fetch, no allow-list entry required.
      //
      // ── AMENDED BY ADR-0062 (2026-08-03) ────────────────────────────────────
      // Still true as an SSRF argument, still not an egress policy. A connector
      // is the surface that carries CUSTOMER DATA by construction, so a Slack or
      // GitHub connector running on its compiled endpoint inside an air-gapped
      // install is the exact thing that mode promises does not happen. Under a
      // strict posture the compiled destination is adjudicated against the same
      // `egress_allow_hosts` table; under `hosted` this is byte-identical.
      let connectorFetch: typeof fetch | undefined;
      if (baseUrl) {
        let guarded;
        try {
          guarded = await guardConnectionCall(db, {
            surface: "connector",
            baseUrl,
            userId,
            objectId: connectorId,
            label: `connector '${connector.name}' (${connector.providerKind})`,
            detail: {
              connectorKind: connector.providerKind,
              operation: body.operation,
              source: cred?.baseUrl ? "connector_credential" : "connector",
              ...(projectId ? { projectId } : {}),
            },
          });
        } catch (err) {
          if (err instanceof ConnectionEgressBlockedError) {
            return out.status(403).send({
              decision,
              error: "egress_blocked",
              code: err.decision.code,
              detail:
                `connector '${connector.name}' (${connector.providerKind}): ${err.decision.reason}` +
                ` (an admin adds permitted destinations under Egress Allow Hosts)`,
            });
          }
          throw err;
        }
        connectorFetch = guarded.fetchImpl;
      } else {
        // ADR-0062 — the compiled connector endpoint. `snowflake` resolves to
        // "not statically knowable" (its default is derived from the decrypted
        // credential) and is therefore REFUSED under a strict posture rather
        // than assumed safe; every kind that cannot exist without an explicit
        // baseUrl resolves to "nothing to adjudicate".
        const { posture, allowList } = await loadCompiledEgressContext(db);
        const compiled = decideCompiledDefault({
          posture,
          surface: "connector",
          kind: connector.providerKind,
          defaultBaseUrl: connectorDefaultBaseUrl(connector.providerKind),
          allowList,
        });
        if (!compiled.ok) {
          await auditCompiledDefaultDenied(db, {
            userId,
            surface: "connector",
            objectId: connectorId,
            kind: connector.providerKind,
            decision: compiled,
            posture,
            detail: {
              connectorKind: connector.providerKind,
              operation: body.operation,
              ...(projectId ? { projectId } : {}),
            },
          });
          return out.status(403).send({
            decision,
            error: "egress_blocked",
            code: compiled.code,
            detail: `connector '${connector.name}': ${compiled.reason}`,
          });
        }
      }

      // Execute. A FAILED call (ConnectorProviderError) bills NOTHING and
      // surfaces as 502 — the same discipline as a failed model dispatch.
      let result;
      try {
        const provider = resolveConnectorProvider(
          { kind: connector.providerKind, baseUrl, token },
          connectorFetch as unknown as Parameters<typeof resolveConnectorProvider>[1],
        );
        result = await provider.invoke({
          operation: body.operation,
          object: body.object ?? null,
          payload: body.payload ?? null,
        });
      } catch (err) {
        // ADR-0034 amendment #2 — a refusal raised by the GUARDED FETCH itself
        // (the allow-list withdrawn between the pre-check and the request, or an
        // approved endpoint answering 302 -> IMDS) is a GOVERNANCE decision, not
        // an upstream failure. Without this it would surface as an opaque 500 or
        // be laundered into a 502 "the connector broke", hiding the one fact an
        // operator needs. `egressRefusal` digs it out of whatever the adapter
        // wrapped it in, exactly as the model paths do.
        const refusal = egressRefusal(err);
        if (refusal) {
          await db.insert(auditLog).values({
            userId,
            objectType: "connector",
            objectId: connectorId,
            detail: {
              phase: "call",
              baseUrl,
              connectorKind: connector.providerKind,
              operation: body.operation,
              ...(projectId ? { projectId } : {}),
            },
            effect: "deny",
            ruleId: "connector-egress-blocked",
            ruleChain: [],
            reason: `connector '${connector.name}': ${refusal}`,
          });
          return out.status(403).send({
            decision,
            error: "egress_blocked",
            detail: `connector '${connector.name}': ${refusal}`,
          });
        }
        if (err instanceof ConnectorProviderError) {
          return out
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

      // ADR-0042 OUTPUT phase, connector path — bill-and-withhold, same as PII.
      let cgOutput: ReturnType<typeof runGuardrails> | null = null;
      let cgWithheld = false;
      if (connectorGuardrails.active) {
        cgOutput = runGuardrails(connectorGuardrails, "output", JSON.stringify(result.body ?? null));
        if (cgOutput.action === "block") {
          cgWithheld = true;
          respBody = guardrailWithheldMarker(cgOutput.blocking);
        }
      }
      const cgFindings = [...(cgInput?.findings ?? []), ...(cgOutput?.findings ?? [])];
      const connectorGuardrailView: DispatchGuardrails | null = cgFindings.length
        ? {
            action: cgWithheld ? "block" : cgFindings.some((f) => f.action === "warn") ? "warn" : "log",
            phase: cgWithheld ? "output" : cgInput?.findings.length ? "input" : "output",
            findings: flattenFindings(cgFindings),
            withheld: cgWithheld,
          }
        : null;

      // pillar 5 actuals: an allowed, executed call bills the connector's flat
      // list price. Unpriced → null, never an invented figure (agents' rule).
      const costUsd = connector.pricePerCallUsd ?? null;
      const [connectorUsageRow] = await db.insert(usageEvents).values({
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
          // ADR-0042 COUNTS ONLY, same contract
          ...(connectorGuardrailView
            ? {
                guardrails: {
                  action: connectorGuardrailView.action,
                  findings: connectorGuardrailView.findings,
                  withheld: cgWithheld,
                },
              }
            : {}),
        },
      }).returning({ id: usageEvents.id });
      // ADR-0070 — the span REFERENCES this row and copies its figure from it,
      // in the same call that inserted it. Never a recomputed price.
      sink.usageEventId = connectorUsageRow?.id ?? null;
      sink.costUsd = costUsd;
      if (cgOutput) {
        const outcome = guardrailOutcome(cgOutput);
        if (outcome) {
          await recordGuardrailDecision(db, {
            userId,
            objectType: "connector",
            objectId: connectorId,
            projectId,
            evaluation: cgOutput,
            outcome,
            detail: { operation: body.operation, connectorKind: connector.providerKind },
          });
        }
      }
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

      return out.send({
        decision,
        result: { status: result.status, body: respBody },
        costUsd,
        ...(pii ? { pii } : {}),
        ...(connectorGuardrailView ? { guardrails: connectorGuardrailView } : {}),
      });
    };

    const traceCtx = await beginTrace(db, {
      // a direct connector call is its own one-span trace, grouped by the
      // CONNECTOR as the session — the same idiom the MCP proxy uses for
      // `mcp:<serverId>`.
      kind: "tool",
      name: `connector ${connector.name}.${body.operation}`,
      userId,
      projectId,
      sessionId: `connector:${connectorId}`,
      rootRefId: connectorId,
    });
    const spanStartedAt = new Date();
    let outcome: ConnectorAttemptResult;
    try {
      outcome = await attempt(connectorReplyRecorder());
    } catch (err) {
      // An unexpected throw is still a thing that happened to a governed call.
      await recordSpan(db, traceCtx, {
        kind: "connector",
        name: `${connector.name}.${body.operation}`,
        status: "error",
        statusReason: (err as Error)?.message ?? "connector invoke threw",
        startedAt: spanStartedAt,
        connectorId,
        attributes: { operation: body.operation, ...(projectId ? { projectId } : {}) },
      });
      await finishTrace(db, traceCtx, "error", spanStartedAt);
      throw err;
    }

    const errCode =
      typeof outcome.body["error"] === "string" ? (outcome.body["error"] as string) : null;
    const outDetail =
      typeof outcome.body["detail"] === "string" ? (outcome.body["detail"] as string) : null;
    const outDecision = outcome.body["decision"] as
      | { reason?: string; ruleId?: string }
      | undefined;
    const spanStatus: "ok" | "denied" | "error" =
      outcome.status < 400 ? "ok" : outcome.status >= 500 ? "error" : "denied";
    // A refusal ABOUT the input does not store the input — storing the very
    // payload a block refused would defeat the block (ADR-0070 rule 3).
    const inputRefused = errCode === "pii_blocked" || errCode === "guardrail_blocked";
    const resultBody = (outcome.body["result"] as { body?: unknown } | undefined)?.body;
    const withheld =
      inputRefused ||
      !!(outcome.body["pii"] as { withheld?: boolean } | undefined)?.withheld ||
      !!(outcome.body["guardrails"] as { withheld?: boolean } | undefined)?.withheld;
    await recordSpan(db, traceCtx, {
      kind: "connector",
      name: `${connector.name}.${body.operation}`,
      status: spanStatus,
      statusReason: spanStatus === "ok" ? null : (outDetail ?? outDecision?.reason ?? errCode),
      startedAt: spanStartedAt,
      connectorId,
      // THE REFERENCE, and the figure copied from it in the same call.
      usageEventId: sink.usageEventId ?? null,
      costUsd: sink.costUsd ?? null,
      inputText: inputRefused
        ? outDetail
        : JSON.stringify({ object: body.object ?? null, payload: body.payload ?? null }),
      // ALREADY-ADJUDICATED text: the withheld marker is already substituted.
      outputText: resultBody === undefined ? null : JSON.stringify(resultBody),
      contentWithheld: withheld,
      attributes: {
        operation: body.operation,
        httpStatus: outcome.status,
        ...(body.object ? { object: body.object } : {}),
        ...(connector.providerKind ? { providerKind: connector.providerKind } : {}),
        ...(projectId ? { projectId } : {}),
        ...(errCode ? { error: errCode } : {}),
        ...(outDecision?.ruleId ? { ruleId: outDecision.ruleId } : {}),
      },
    });
    await finishTrace(db, traceCtx, spanStatus, spanStartedAt);
    return reply.status(outcome.status).send(outcome.body);
  });
}
