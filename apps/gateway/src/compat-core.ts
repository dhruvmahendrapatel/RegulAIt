/**
 * ADR-0020 (ROADMAP Batch H) — the shared core behind the provider-shaped
 * COMPATIBILITY surfaces (`POST /v1/messages`, `POST /v1/chat/completions`).
 *
 * THE ONE INVARIANT THIS FILE EXISTS TO HOLD: those endpoints are TRANSLATION
 * SHIMS, never a second policy path. Everything governance-bearing —
 * entitlement (`evaluateAgent`), attribution, PII, budget, optimization, the
 * usage ledger — happens here, by calling exactly the same primitives
 * `/v1/agents/:agentId/invoke` calls, and then `executeGovernedDispatch`. A
 * compat call can therefore never obtain something the invoke path would deny;
 * if it could, the interception story would be a privilege-escalation feature
 * rather than a governance one.
 *
 * The shims (`compat-anthropic.ts`, `compat-openai.ts`) own ONLY wire-format
 * translation: request blocks in, response blocks / SSE frames out.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  agentGrants,
  agents,
  auditLog,
  costEvents,
  eq,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  userAgentPolicies,
  type Db,
  type InterceptionSettingsRow,
} from "@regulait/db";
import { evaluateAgent } from "@regulait/policy-kernel";
import { classifyComplexity, estimateTokens, routeModel } from "@regulait/optimizer-kernel";
import { isModelProviderKind, type ModelChatMessage, type ModelToolDef } from "@regulait/model-provider";
import { updateInterceptionSettingsSchema } from "@regulait/shared";
import { z } from "zod";
import {
  configuredProviders,
  executeGovernedDispatch,
  type AgentRow,
  type DispatchOutcome,
} from "./agents-connectors.js";
import { loadAgentRevocations, loadRoleAgentGrants } from "./entitlements.js";
import { assertProjectAttribution, projectPiiMode } from "./projects.js";
import { PROJECT_HEADER } from "./mcp-proxy.js";
import { effectiveTechniqueMode, loadOrgSettings } from "./org-settings.js";

export { PROJECT_HEADER };

/**
 * Optional explicit agent selection. REQUIRED in `require_agent` mode, honoured
 * as an override in the other two. It can only ever NARROW: the named agent
 * still goes through `evaluateAgent` for the calling user, so naming an agent
 * you are not entitled to is a 403 exactly as it is at the invoke endpoint.
 */
export const AGENT_HEADER = "x-regulait-agent-id";

/** The mode compat calls evaluate under. Provider wire formats carry no
 * RegulAIt "mode", and a completion request is an execution, so every compat
 * call is evaluated as `execute` — a grant restricted to other modes denies it,
 * which is the same answer `/invoke` gives. */
export const COMPAT_MODE = "execute";

export const COMPAT_ANTHROPIC_ROUTE = "POST /v1/messages";
export const COMPAT_OPENAI_ROUTE = "POST /v1/chat/completions";
export const MCP_PROXY_ROUTE = "POST /mcp/:serverId";

/** Routes that additionally accept the RegulAIt API key in `x-api-key`. Not a
 * weaker credential — the SAME key, under the header name Anthropic clients
 * send, so an `ANTHROPIC_BASE_URL`-based tool authenticates unmodified. */
export const API_KEY_HEADER_ROUTES: ReadonlySet<string> = new Set([COMPAT_ANTHROPIC_ROUTE]);

/** Routes whose existence is admin-configurable (ADR-0020). A disabled surface
 * answers Fastify's own 404 body, so it is indistinguishable from a route that
 * was never registered — we do not advertise a surface the admin turned off. */
export const INTERCEPTION_GATED_ROUTES: ReadonlySet<string> = new Set([
  COMPAT_ANTHROPIC_ROUTE,
  COMPAT_OPENAI_ROUTE,
  MCP_PROXY_ROUTE,
]);

/** Byte-for-byte Fastify's default not-found payload. */
export function notFoundBody(method: string, url: string) {
  return {
    message: `Route ${method}:${url} not found`,
    error: "Not Found",
    statusCode: 404,
  };
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/** The singleton posture row, created on first read if migration seeding was
 * skipped (belt-and-braces; 0037 inserts it). */
export async function loadInterceptionSettings(db: Db): Promise<InterceptionSettingsRow> {
  const [row] = await db
    .select()
    .from(interceptionSettings)
    .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  if (row) return row;
  const [created] = await db
    .insert(interceptionSettings)
    .values({ id: INTERCEPTION_SETTINGS_ID })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [again] = await db
    .select()
    .from(interceptionSettings)
    .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
  if (!again) throw new Error("interception_settings singleton missing");
  return again;
}

/** true/false for an interception-gated route, null when the route is not one. */
export async function interceptionSurfaceEnabled(db: Db, route: string): Promise<boolean | null> {
  if (!INTERCEPTION_GATED_ROUTES.has(route)) return null;
  const s = await loadInterceptionSettings(db);
  if (route === COMPAT_ANTHROPIC_ROUTE) return s.anthropicCompatEnabled;
  if (route === COMPAT_OPENAI_ROUTE) return s.openaiCompatEnabled;
  return s.mcpInterceptionEnabled;
}

// ---------------------------------------------------------------------------
// unsupported-field discipline
// ---------------------------------------------------------------------------

/**
 * ROADMAP Batch H: "Aim for a documented, tested subset that fails loudly on
 * the unsupported rest … do NOT silently drop fields." A dropped
 * `tool_choice`/`thinking` would change what the model does without the caller
 * ever learning — the opposite of a governance product's job. So an unsupported
 * field is a 400 naming it, never a shrug.
 */
export class CompatFieldError extends Error {
  constructor(
    readonly field: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/**
 * Fields we ACCEPT and then do not honour. A deliberate third tier between
 * "supported" and "400", added because the strict rule had a false positive
 * that mattered in practice: IDE clients (Cursor, Continue, Cline) send
 * `temperature` on every request from a settings default the developer never
 * chose, so a 400 bounced the whole call over a field the caller did not
 * meaningfully ask for. Rejecting it protected nothing and blocked the
 * interception this batch exists to enable.
 *
 * The honesty requirement does NOT go away, it moves: an ignored field is
 * recorded on the audit row AND disclosed on the response via
 * `x-regulait-ignored-fields`, so "we dropped this" stays a fact the caller
 * and the auditor can both see. That is the difference between accept-and-
 * disclose and a silent shrug — only the latter is the thing Batch H forbids.
 *
 * Deliberately NARROW. A field only belongs here when ignoring it cannot
 * change whether an output is safe, governed, priced or attributed —
 * `temperature` nudges sampling; `tool_choice` or `thinking` would change what
 * the model is *able to do*, so those stay a 400.
 */
export const COMPAT_IGNORED_FIELDS = ["temperature"] as const;

/**
 * Rejects any key present in `body` that is neither supported nor in the
 * accept-and-ignore tier. Returns the ignored keys that were actually present,
 * for the caller to thread into the audit row and the disclosure header.
 */
export function rejectUnsupportedFields(
  body: Record<string, unknown>,
  supported: readonly string[],
  surface: string,
): string[] {
  const allowed = new Set(supported);
  const ignorable = new Set<string>(COMPAT_IGNORED_FIELDS);
  const ignored: string[] = [];
  for (const key of Object.keys(body)) {
    if (allowed.has(key)) continue;
    if (body[key] === undefined || body[key] === null) continue;
    if (ignorable.has(key)) {
      ignored.push(key);
      continue;
    }
    throw new CompatFieldError(
      key,
      `'${key}' is not supported by the RegulAIt ${surface}-compatible endpoint. ` +
        `RegulAIt governs, prices and audits every dispatch, so it will not silently ignore a ` +
        `field that changes what the model does. Supported: ${supported.join(", ")}. ` +
        `Accepted but not honoured (reported back in x-regulait-ignored-fields): ` +
        `${COMPAT_IGNORED_FIELDS.join(", ")}.`,
    );
  }
  return ignored;
}

// ---------------------------------------------------------------------------
// prepared call
// ---------------------------------------------------------------------------

export interface CompatResolution {
  mode: "map_by_model" | "require_agent" | "router_decides";
  /** exactly what the client asked for */
  requestedModel: string;
  /** what we will actually serve — DISCLOSED, never silently substituted */
  servedModel: string;
  requestedAgentId: string;
  servedAgentId: string;
  /** how the requested agent was found */
  via: "agent_header" | "model_match" | "router";
  /** when several registry agents carry the same model id, the deterministic
   * tie-break that picked one (lowest tier, then oldest) */
  tieBreak?: { candidates: number; picked: string };
  /** true when the pillar-6 router served something other than the request */
  routerOverrode: boolean;
}

export interface CompatPrepared {
  userId: string;
  projectId: string | null;
  settings: InterceptionSettingsRow;
  requested: AgentRow;
  served: AgentRow;
  resolution: CompatResolution;
  /** ADR-0019: a block-mode PII project never streams */
  streamingSuppressed: boolean;
  useStream: boolean;
  /** COMPAT_IGNORED_FIELDS actually present on this request — accepted, not
   * honoured, and disclosed rather than dropped in silence. */
  ignoredFields: string[];
}

export type CompatError = { status: number; error: string; detail: string };
export type CompatPrepareResult = { ok: true; prepared: CompatPrepared } | ({ ok: false } & CompatError);

const projectHeaderSchema = z.object({ [PROJECT_HEADER]: z.string().uuid().optional() });
const agentHeaderSchema = z.object({ [AGENT_HEADER]: z.string().uuid().optional() });

/**
 * Everything between "a request arrived" and "dispatch it": identity,
 * attribution, model→agent resolution, entitlement, optional pillar-6 routing,
 * and the streaming decision. Returns a neutral error the shim renders in its
 * own provider-shaped envelope.
 */
export async function prepareCompatCall(
  db: Db,
  dataKey: string | undefined,
  req: FastifyRequest,
  args: { requestedModel: string; stream: boolean; text: string; ignoredFields?: string[] },
): Promise<CompatPrepareResult> {
  const userId = req.authCtx.userId;
  if (!userId) {
    return {
      ok: false,
      status: 403,
      error: "bootstrap_cannot_invoke",
      detail: "the bootstrap token has no user identity; use a per-user RegulAIt API key",
    };
  }
  const settings = await loadInterceptionSettings(db);

  // ADR-0021 strict field rejection: when the admin turned the
  // COMPAT_IGNORED_FIELDS accept-and-disclose tier OFF, a present-but-ignorable
  // field (temperature) is a 400 again — the strict pre-#47 posture. Enforced
  // here (before entitlement or dispatch) so both shims inherit it without a
  // change of their own.
  if (settings.strictFieldRejection && (args.ignoredFields?.length ?? 0) > 0) {
    const fields = (args.ignoredFields ?? []).join(", ");
    return {
      ok: false,
      status: 400,
      error: "unsupported_field",
      detail:
        `'${fields}' is not supported by this RegulAIt-compatible endpoint, and this deployment's ` +
        `strict field rejection is ON — the accept-and-disclose tier is disabled, so an ` +
        `unsupported field fails the call instead of being ignored.`,
    };
  }

  // --- pillar 5 attribution, validated exactly as the MCP proxy validates it
  const headerParse = projectHeaderSchema.safeParse(req.headers);
  if (!headerParse.success) {
    return { ok: false, status: 400, error: "invalid_project_id", detail: `${PROJECT_HEADER} must be a uuid` };
  }
  const projectId = headerParse.data[PROJECT_HEADER] ?? null;
  if (!projectId && settings.requireProjectAttribution) {
    // The admin's lever to GUARANTEE pillar-5 coverage: an unattributed compat
    // call is refused rather than run as untracked spend.
    return {
      ok: false,
      status: 400,
      error: "project_attribution_required",
      detail:
        `this deployment requires every intercepted call to be attributed — send the ` +
        `${PROJECT_HEADER} header with a project you may bill to`,
    };
  }
  if (projectId) {
    const attribution = await assertProjectAttribution(db, projectId, userId, req.authCtx.isAdmin);
    if (!attribution.ok) {
      return {
        ok: false,
        status: attribution.status,
        error: attribution.error,
        detail: `project ${projectId} is not one this caller may bill to`,
      };
    }
  }

  // --- model -> agent resolution (ADMIN-SELECTABLE, ADR-0020) ---------------
  const agentHeaderParse = agentHeaderSchema.safeParse(req.headers);
  if (!agentHeaderParse.success) {
    return { ok: false, status: 400, error: "invalid_agent_id", detail: `${AGENT_HEADER} must be a uuid` };
  }
  const namedAgentId = agentHeaderParse.data[AGENT_HEADER] ?? null;
  const mode = settings.resolutionMode;

  if (mode === "require_agent" && !namedAgentId) {
    return {
      ok: false,
      status: 400,
      error: "agent_header_required",
      detail:
        `this deployment's resolution mode is 'require_agent': the caller must name the governed ` +
        `agent in the ${AGENT_HEADER} header. The '${args.requestedModel}' model string is advisory.`,
    };
  }

  const registry = await db.select().from(agents).where(eq(agents.enabled, true));
  let requested: AgentRow | undefined;
  let via: CompatResolution["via"] = "model_match";
  let tieBreak: CompatResolution["tieBreak"];

  if (namedAgentId) {
    requested = registry.find((a) => a.id === namedAgentId);
    via = "agent_header";
    if (!requested) {
      // DEFAULT-DENY. An unknown/disabled named agent is never a pass-through.
      return {
        ok: false,
        status: 403,
        error: "agent_not_resolvable",
        detail: `no enabled governed agent with id '${namedAgentId}'; RegulAIt never forwards an ungoverned call to a vendor`,
      };
    }
  } else {
    const matches = registry.filter((a) => a.model === args.requestedModel);
    if (matches.length > 1) {
      // Deterministic tie-break, documented in ADR-0020: LOWEST tier first
      // (the cheapest governed way to honour the request), then OLDEST
      // createdAt, then id — total and stable across deployments.
      matches.sort(
        (a, b) =>
          a.tier - b.tier ||
          a.createdAt.getTime() - b.createdAt.getTime() ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
      tieBreak = { candidates: matches.length, picked: matches[0]!.name };
    }
    requested = matches[0];
    if (!requested) {
      // THE BATCH-H INVARIANT. An unmapped model is DEFAULT-DENY — never a
      // silent pass-through to the vendor, which is the entire point of
      // intercepting in the first place.
      return {
        ok: false,
        status: 403,
        error: "model_not_mapped",
        detail:
          `model '${args.requestedModel}' does not map to any enabled governed agent in this ` +
          `deployment, so the call is denied rather than forwarded to the provider. An admin can ` +
          `register an agent with this model id, or switch the resolution mode to 'require_agent'.`,
      };
    }
  }

  // --- entitlement: the SAME check /v1/agents/:agentId/invoke performs -------
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
  const evalFor = (a: AgentRow) =>
    evaluateAgent({
      userId,
      agent: { id: a.id, name: a.name, tier: a.tier, enabled: a.enabled, modes: a.modes ?? null },
      mode: COMPAT_MODE,
      agentGrants: grants,
      roleAgentGrants: roleGrants,
      agentRevocations: revocations,
      ceilingTier,
    });

  const decision = evalFor(requested);
  if (decision.effect !== "allow") {
    await db.insert(auditLog).values({
      userId,
      objectType: "agent",
      objectId: requested.id,
      detail: {
        surface: "compat",
        mode: COMPAT_MODE,
        requestedModel: args.requestedModel,
        resolutionMode: mode,
        ...(projectId ? { projectId } : {}),
      },
      effect: decision.effect,
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    });
    return { ok: false, status: 403, error: "agent_denied", detail: decision.reason };
  }

  // --- pillar-6 routing, ONLY in router_decides ------------------------------
  // ADR-0021: the org routingEnabled toggle is the ceiling — off forces
  // passthrough (and writes no ledger row); on defers to the user's own
  // routingMode, else the org default for unset users.
  const org = await loadOrgSettings(db);
  let served = requested;
  let routerOverrode = false;
  if (mode === "router_decides") {
    const entitled = registry.filter((a) => evalFor(a).effect === "allow");
    const configured = await configuredProviders(db, dataKey, userId);
    const candidateRows = entitled.filter(
      (a) => a.id === requested.id || (a.model && isModelProviderKind(a.provider) && configured.has(a.provider)),
    );
    const complexity = classifyComplexity(args.text);
    const estimate = estimateTokens(args.text, complexity);
    const routing = routeModel({
      requestedAgentId: requested.id,
      candidates: candidateRows.map((a) => ({
        id: a.id,
        tier: a.tier,
        costPerMTokIn: a.costPerMTokIn ?? null,
        costPerMTokOut: a.costPerMTokOut ?? null,
      })),
      routingMode: effectiveTechniqueMode(org, org.routingEnabled, policy?.routingMode ?? null),
      complexity,
      ceilingTier,
      estimate,
    });
    served = registry.find((a) => a.id === routing.selectedAgentId) ?? requested;
    routerOverrode = served.id !== requested.id;
    // Same per-technique ledger the invoke path writes, so the Spend page and
    // the savings-by-technique chart pick intercepted traffic up unchanged.
    // ADR-0021: with the ORG toggle off the technique does not run — no row.
    if (org.routingEnabled) {
      await db.insert(costEvents).values({
        userId,
        objectType: "agent",
        objectId: requested.id,
        technique: "model_routing",
        requestedAgentId: requested.id,
        servedAgentId: routing.selectedAgentId,
        baselineAgentId: routing.baselineAgentId,
        estimatedTokensIn: estimate.in,
        estimatedTokensOut: estimate.out,
        estimatedTokensSaved: routing.estimatedTokensSaved,
        estimatedCostSavedUsd: routing.estimatedCostSavedUsd,
        estimationBasis: routing.estimationBasis,
        ruleId: routing.ruleId,
        projectId,
        detail: { effect: routing.effect, complexity, surface: "compat", mode: COMPAT_MODE },
      });
    }
  }

  // --- ADR-0019 streaming suppression ---------------------------------------
  // Reused verbatim, not re-derived: on a block-mode project the OUTPUT PII
  // check can only run once the full text exists, so no delta may leave.
  const streamingSuppressed = args.stream && (await projectPiiMode(db, projectId)) === "block";
  // ADR-0021: 'reject' refuses the stream request instead of quietly buffering
  // — the same admin choice the invoke path honours, held here so both shims
  // inherit it.
  if (streamingSuppressed && settings.streamingOnBlockMode === "reject") {
    return {
      ok: false,
      status: 400,
      error: "streaming_rejected_on_block_project",
      detail:
        "this project's PII mode is 'block' and this deployment rejects streaming on such projects — retry without stream:true",
    };
  }

  return {
    ok: true,
    prepared: {
      userId,
      projectId,
      settings,
      requested,
      served,
      resolution: {
        mode,
        requestedModel: args.requestedModel,
        servedModel: served.model ?? args.requestedModel,
        requestedAgentId: requested.id,
        servedAgentId: served.id,
        via: routerOverrode ? "router" : via,
        ...(tieBreak ? { tieBreak } : {}),
        routerOverrode,
      },
      streamingSuppressed,
      useStream: args.stream && !streamingSuppressed,
      ignoredFields: args.ignoredFields ?? [],
    },
  };
}

/**
 * Run the prepared call through the ONE governed dispatch core and audit it.
 * Nothing policy-bearing lives here — this is `executeGovernedDispatch` plus
 * the audit row that records requested-vs-served (Batch H: the router may never
 * substitute a model invisibly).
 */
export async function executeCompatCall(
  db: Db,
  dataKey: string | undefined,
  prepared: CompatPrepared,
  args: {
    surface: "anthropic" | "openai";
    messages: ModelChatMessage[];
    system?: string | undefined;
    /** pillar-6 prompt caching, mapped from an Anthropic `cache_control`
     * marker on a system block. A pure cost annotation. */
    cacheSystem?: boolean | undefined;
    tools?: ModelToolDef[] | undefined;
    maxTokens?: number | undefined;
    onText?: ((delta: string) => void) | undefined;
  },
): Promise<DispatchOutcome> {
  const flatText = args.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => (b.type === "text" ? b.text : "")).join(" "),
    )
    .join("\n");

  const outcome = await executeGovernedDispatch(db, dataKey, {
    userId: prepared.userId,
    served: prepared.served,
    requestedAgentId: prepared.requested.id,
    baseline: prepared.resolution.routerOverrode ? prepared.requested : null,
    input: flatText,
    messages: args.messages,
    ...(args.system ? { system: args.system } : {}),
    ...(args.cacheSystem ? { cacheSystem: true } : {}),
    ...(args.tools ? { tools: args.tools } : {}),
    ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
    projectId: prepared.projectId,
    ...(args.onText ? { onText: args.onText } : {}),
    detail: {
      surface: `compat_${args.surface}`,
      mode: COMPAT_MODE,
      requestedModel: prepared.resolution.requestedModel,
      resolutionMode: prepared.resolution.mode,
    },
  });

  await db.insert(auditLog).values({
    userId: prepared.userId,
    objectType: "agent",
    objectId: prepared.requested.id,
    detail: {
      surface: `compat_${args.surface}`,
      mode: COMPAT_MODE,
      // requested-vs-served, always both, so a router override is legible in
      // the audit trail as well as in the response body.
      resolution: prepared.resolution,
      servedAgentId: prepared.served.id,
      stream: !!args.onText,
      ...(prepared.streamingSuppressed ? { streamingSuppressed: true } : {}),
      // accepted-but-not-honoured fields are a FACT on the audit row, not a
      // silent drop — an auditor reconstructing this call can see the caller
      // asked for something we did not apply.
      ...(prepared.ignoredFields.length ? { ignoredFields: prepared.ignoredFields } : {}),
      ...(prepared.projectId ? { projectId: prepared.projectId } : {}),
      dispatch: outcome.ok
        ? {
            model: outcome.result.model,
            stopReason: outcome.result.stopReason,
            refusal: outcome.result.refusal,
          }
        : { error: outcome.error },
    },
    effect: outcome.ok ? "allow" : "deny",
    ruleId: outcome.ok ? "compat-dispatch" : "compat-dispatch-failed",
    ruleChain: [],
    reason: outcome.ok
      ? `intercepted ${args.surface}-shaped call served by agent ${prepared.served.name} (${prepared.resolution.servedModel})`
      : `intercepted ${args.surface}-shaped call failed: ${outcome.error}`,
  });

  return outcome;
}

/** Disclosure headers every compat response carries, in BOTH shapes. The body
 * already names the served model; these make requested-vs-served legible to a
 * client that only reads headers (and to a proxy log). */
export function disclosureHeaders(reply: FastifyReply, prepared: CompatPrepared): void {
  const r = prepared.resolution;
  reply.header("x-regulait-requested-model", r.requestedModel);
  reply.header("x-regulait-served-model", r.servedModel);
  reply.header("x-regulait-served-agent-id", r.servedAgentId);
  reply.header("x-regulait-resolution-mode", r.mode);
  if (prepared.projectId) reply.header("x-regulait-project-id", prepared.projectId);
  if (prepared.streamingSuppressed) reply.header("x-regulait-streaming-suppressed", "true");
  // the caller sent it, we did not honour it, and we say so — this header is
  // what keeps accept-and-ignore from being the silent drop Batch H forbids.
  if (prepared.ignoredFields.length)
    reply.header("x-regulait-ignored-fields", prepared.ignoredFields.join(","));
}

/** The same disclosure for a hijacked SSE response, as raw header pairs. */
export function disclosureHeaderPairs(prepared: CompatPrepared): Record<string, string> {
  const r = prepared.resolution;
  return {
    "x-regulait-requested-model": r.requestedModel,
    "x-regulait-served-model": r.servedModel,
    "x-regulait-served-agent-id": r.servedAgentId,
    "x-regulait-resolution-mode": r.mode,
    ...(prepared.projectId ? { "x-regulait-project-id": prepared.projectId } : {}),
  };
}

// ---------------------------------------------------------------------------
// admin settings endpoints
// ---------------------------------------------------------------------------

/** GET/PUT the posture. ADMIN-ONLY — deliberately absent from
 * NON_ADMIN_ROUTES, unlike the compat endpoints themselves (which are the
 * developer's path and must be callable by a non-admin, exactly like the MCP
 * proxy). Every write is audited. */
export function registerInterceptionRoutes(app: FastifyInstance, db: Db) {
  app.get("/v1/interception/settings", async () => {
    const settings = await loadInterceptionSettings(db);
    return { settings };
  });

  app.put("/v1/interception/settings", async (req, reply) => {
    const body = updateInterceptionSettingsSchema.parse(req.body);
    const before = await loadInterceptionSettings(db);
    const [row] = await db
      .update(interceptionSettings)
      .set({
        ...body,
        updatedBy: req.authCtx.userId,
        updatedAt: new Date(),
      })
      .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID))
      .returning();
    const after = row ?? before;
    const changed = Object.fromEntries(
      Object.entries(body).filter(
        ([k, v]) => (before as Record<string, unknown>)[k] !== v,
      ),
    );
    await db.insert(auditLog).values({
      // bootstrap has no user identity; the nil uuid marks a non-user actor,
      // as elsewhere in the codebase, and `via` records which it was.
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "interception_settings",
      objectId: null,
      detail: { via: req.authCtx.via, changed, after },
      effect: "allow",
      ruleId: "interception-settings-updated",
      ruleChain: [],
      reason:
        Object.keys(changed).length > 0
          ? `interception posture updated: ${Object.keys(changed).join(", ")}`
          : "interception posture written with no effective change",
    });
    return reply.send({ settings: after });
  });
}
