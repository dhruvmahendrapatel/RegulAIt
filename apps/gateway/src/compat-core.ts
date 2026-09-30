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
  and,
  auditLog,
  costEvents,
  count,
  eq,
  inArray,
  interceptionScopeRules,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  or,
  projects,
  roleAssignments,
  roles,
  userAgentPolicies,
  users,
  type Db,
  type InterceptionScopeKind,
  type InterceptionScopeRuleRow,
  type InterceptionSettingsRow,
  type ResolutionMode,
} from "@regulait/db";
import { evaluateAgent } from "@regulait/policy-kernel";
import { classifyComplexity, estimateTokens, routeModel } from "@regulait/optimizer-kernel";
import {
  isModelProviderKind,
  type ModelChatMessage,
  type ModelDispatchRequest,
  type ModelResponseFormat,
  type ModelToolChoice,
  type ModelToolDef,
} from "@regulait/model-provider";
import {
  createInterceptionScopeRuleSchema,
  updateInterceptionScopeRuleSchema,
  updateInterceptionSettingsSchema,
} from "@regulait/shared";
import { z } from "zod";
import {
  agentProviderToken,
  configuredProviders,
  enforceProjectCachedOutputPii,
  executeGovernedDispatch,
  type AgentRow,
  type DispatchOutcome,
} from "./agents-connectors.js";
import { loadAgentRevocations, loadRoleAgentGrants } from "./entitlements.js";
import { loadVersions } from "./config-versions.js";
import { assertProjectAttribution, projectPiiMode } from "./projects.js";
import { PROJECT_HEADER } from "./mcp-proxy.js";
// ADR-0070 — the compat surfaces' entitlement refusal gets a `policy` deny span
// too: an SDK pointed at this gateway has no RegulAIt UI to look in.
import { beginTrace, finishTrace, recordSpan } from "./tracing.js";
import { effectiveTechniqueMode, loadOrgSettings } from "./org-settings.js";
import {
  lookupSemanticCache,
  semanticCacheRequestKey,
  semanticCacheSavings,
  storeSemanticCache,
} from "./semantic-cache-shared.js";
import { agentHaltOf, loadExecutionMode, postureOf } from "./execution-posture.js";
import {
  loadVirtualKeyContext,
  virtualKeyAdmits,
  virtualKeyAllowListRefusal,
  type VirtualKeyContext,
} from "./virtual-keys.js";

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
/** ADR-0066 §1 — the discovery endpoint both provider SDKs call at setup.
 * ONE route serving TWO envelopes, chosen by the `anthropic-version` header. */
export const COMPAT_MODELS_ROUTE = "GET /v1/models";

/** Routes that additionally accept the RegulAIt API key in `x-api-key`. Not a
 * weaker credential — the SAME key, under the header name Anthropic clients
 * send, so an `ANTHROPIC_BASE_URL`-based tool authenticates unmodified.
 * ADR-0066 adds `GET /v1/models`: the Anthropic SDK sends the same header on
 * its model-list call, and a discovery endpoint that refused the credential the
 * very next call will use would be a strange place to stop. */
export const API_KEY_HEADER_ROUTES: ReadonlySet<string> = new Set([
  COMPAT_ANTHROPIC_ROUTE,
  COMPAT_MODELS_ROUTE,
]);

/** Routes whose existence is admin-configurable (ADR-0020). A disabled surface
 * answers Fastify's own 404 body, so it is indistinguishable from a route that
 * was never registered — we do not advertise a surface the admin turned off.
 *
 * ADR-0066 gates `GET /v1/models` the same way, on EITHER compat surface being
 * enabled: a deployment that intercepts nothing should not answer a discovery
 * call, and a client that can list models must be able to call one. */
export const INTERCEPTION_GATED_ROUTES: ReadonlySet<string> = new Set([
  COMPAT_ANTHROPIC_ROUTE,
  COMPAT_OPENAI_ROUTE,
  COMPAT_MODELS_ROUTE,
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
// ADR-0024 (O13) — per-scope interception overrides (staged rollout)
// ---------------------------------------------------------------------------

/** The three fields a scope rule can override. Everything else on the posture
 * singleton stays org-wide by design — the staged-rollout use case is "pilot a
 * compat surface with one team", not a full per-user posture fork. */
export type ScopedInterceptionField =
  | "anthropicCompatEnabled"
  | "openaiCompatEnabled"
  | "resolutionMode";

/** Where an effective value came from — the org singleton, or a specific
 * scope rule. Drives the admin UI's live effective-value preview and the
 * audit detail, so an override is never invisible. */
export type InterceptionPolicySource =
  | { level: "org" }
  | { level: InterceptionScopeKind; ruleId: string; scopeId: string };

export interface InterceptionPolicyContext {
  userId: string | null;
  projectId: string | null;
}

export interface EffectiveInterceptionPolicy {
  settings: InterceptionSettingsRow;
  anthropicCompatEnabled: boolean;
  openaiCompatEnabled: boolean;
  resolutionMode: ResolutionMode;
  sources: Record<ScopedInterceptionField, InterceptionPolicySource>;
}

/** Cheap existence probe for the onRequest gate's fast path: with no scope
 * rules at all, the org singleton alone decides and NO identity resolution is
 * attempted — byte-identical to the pre-0041 gate. */
export async function interceptionScopeRulesExist(db: Db): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(interceptionScopeRules).limit(1);
  return (row?.n ?? 0) > 0;
}

/** PRECEDENCE, as documented in ADR-0024: user > project > role > org, first
 * non-NULL PER FIELD wins (each field resolves independently); ties within a
 * kind — e.g. a user holding two roles whose rules disagree — resolve to the
 * MOST RECENTLY CREATED rule (createdAt desc, then id desc for total order). */
const SCOPE_PRECEDENCE: readonly InterceptionScopeKind[] = ["user", "project", "role"];

function sortForPrecedence(rules: InterceptionScopeRuleRow[]): InterceptionScopeRuleRow[] {
  return [...rules].sort((a, b) => {
    const kind = SCOPE_PRECEDENCE.indexOf(a.scopeKind) - SCOPE_PRECEDENCE.indexOf(b.scopeKind);
    if (kind !== 0) return kind;
    const at = b.createdAt.getTime() - a.createdAt.getTime();
    if (at !== 0) return at;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

/**
 * Resolve the EFFECTIVE interception policy for a caller. The context is
 * whatever identity is known at the call site: the authenticated user (role
 * rules ride the user's role assignments) and the attributed project from the
 * x-regulait-project-id header. A null userId (unauthenticated probe,
 * bootstrap token) resolves at the ORG level — scope rules never leak to a
 * caller who has not proven an identity they attach to.
 *
 * SURFACE EXPOSURE IS NOT ENTITLEMENT: a rule enabling a surface only decides
 * that the route exists for this caller. Every dispatch still runs the same
 * evaluateAgent gate — org-off + role-enabled + unentitled user is still 403.
 */
export async function resolveInterceptionPolicy(
  db: Db,
  ctx: InterceptionPolicyContext,
  preloaded?: InterceptionSettingsRow,
): Promise<EffectiveInterceptionPolicy> {
  const settings = preloaded ?? (await loadInterceptionSettings(db));
  const base: EffectiveInterceptionPolicy = {
    settings,
    anthropicCompatEnabled: settings.anthropicCompatEnabled,
    openaiCompatEnabled: settings.openaiCompatEnabled,
    resolutionMode: settings.resolutionMode,
    sources: {
      anthropicCompatEnabled: { level: "org" },
      openaiCompatEnabled: { level: "org" },
      resolutionMode: { level: "org" },
    },
  };
  const conditions = [];
  if (ctx.userId) {
    conditions.push(
      and(eq(interceptionScopeRules.scopeKind, "user"), eq(interceptionScopeRules.scopeId, ctx.userId)),
    );
    const roleRows = await db
      .select({ roleId: roleAssignments.roleId })
      .from(roleAssignments)
      .where(eq(roleAssignments.userId, ctx.userId));
    const roleIds = [...new Set(roleRows.map((r) => r.roleId))]; // ADR-0038: distinct
    if (roleIds.length > 0) {
      conditions.push(
        and(eq(interceptionScopeRules.scopeKind, "role"), inArray(interceptionScopeRules.scopeId, roleIds)),
      );
    }
  }
  if (ctx.projectId) {
    conditions.push(
      and(
        eq(interceptionScopeRules.scopeKind, "project"),
        eq(interceptionScopeRules.scopeId, ctx.projectId),
      ),
    );
  }
  if (conditions.length === 0) return base;
  const matched = await db
    .select()
    .from(interceptionScopeRules)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions));
  if (matched.length === 0) return base;
  const ordered = sortForPrecedence(matched);
  for (const field of [
    "anthropicCompatEnabled",
    "openaiCompatEnabled",
    "resolutionMode",
  ] as const) {
    const winner = ordered.find((r) => r[field] !== null && r[field] !== undefined);
    if (!winner) continue;
    if (field === "resolutionMode") base.resolutionMode = winner.resolutionMode as ResolutionMode;
    else base[field] = winner[field] as boolean;
    base.sources[field] = { level: winner.scopeKind, ruleId: winner.id, scopeId: winner.scopeId };
  }
  return base;
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
// ADR-0020 long tail — per-provider capability gate
// ---------------------------------------------------------------------------

/** Providers whose adapter has a REAL native `thinking` mapping. */
export const THINKING_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set(["anthropic", "mock"]);

/** Providers whose adapter has a REAL native structured-output mechanism
 * (OpenAI/xAI response_format, Google responseMimeType/responseSchema, mock
 * echo). Anthropic is deliberately absent: the Messages API has none, and a
 * system-prompt nudge is not a guarantee — see ADR-0020 §5 (2026-07-31). */
export const RESPONSE_FORMAT_CAPABLE_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "xai",
  "google",
  "mock",
]);

/**
 * A field can be expressible in the surface's dialect yet un-honourable by
 * the SERVED agent's provider (resolution — including router_decides — picks
 * the agent, and each provider adapter maps only what it natively supports).
 * Per the Batch-H rule that a field is either honoured or fails loudly, that
 * mismatch is a 400 NAMING the field and the provider — never a silent drop.
 */
export function providerCapabilityError(
  prepared: CompatPrepared,
  fields: { thinking?: boolean | undefined; responseFormat?: boolean | undefined },
): CompatError | null {
  const provider = prepared.served.provider;
  if (fields.thinking && !THINKING_CAPABLE_PROVIDERS.has(provider)) {
    return {
      status: 400,
      error: "unsupported_field",
      detail:
        `'thinking' cannot be honoured on this call: the served agent '${prepared.served.name}' ` +
        `dispatches to provider '${provider}', which has no extended-thinking mapping ` +
        `(supported: ${[...THINKING_CAPABLE_PROVIDERS].join(", ")}). RegulAIt never silently ` +
        `drops a field that changes what the model does.`,
    };
  }
  if (fields.responseFormat && !RESPONSE_FORMAT_CAPABLE_PROVIDERS.has(provider)) {
    return {
      status: 400,
      error: "unsupported_field",
      detail:
        `'response_format' cannot be honoured on this call: the served agent ` +
        `'${prepared.served.name}' dispatches to provider '${provider}', which has no native ` +
        `structured-output mechanism (supported: ${[...RESPONSE_FORMAT_CAPABLE_PROVIDERS].join(", ")}). ` +
        `RegulAIt will not degrade a guarantee to a prompt nudge, so the call fails loudly instead.`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// prepared call
// ---------------------------------------------------------------------------

export interface CompatResolution {
  mode: "map_by_model" | "require_agent" | "router_decides";
  /** ADR-0024 (O13): where the resolution mode came from when a scope rule
   * overrode the org singleton — absent when the org value applied. Rides the
   * audit detail so an override is never invisible. */
  modeSource?: InterceptionPolicySource;
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
  /** ADR-0066 §2/§3: the virtual key this compat call arrived on, threaded to
   * the dispatch core so the key's allow-list and budget bind here exactly as
   * they bind on the native invoke path. null on an ordinary API key. */
  virtualKey: VirtualKeyContext | null;
  /** ADR-0119: the caller's effective optimizer mode, resolved during prepare
   * (where the user policy row is already read) so the dispatch step does not
   * re-query it. `passthrough` disables the semantic cache here exactly as it
   * does on the invoke path. */
  routingMode: string;
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
  // ADR-0024 (O13): the resolution mode is the EFFECTIVE one for this caller —
  // a user/project/role scope rule may override the org singleton (user >
  // project > role > org, first non-NULL wins). The override's provenance
  // rides the resolution object into the response body and the audit row.
  const scopedPolicy = await resolveInterceptionPolicy(db, { userId, projectId }, settings);
  const mode = scopedPolicy.resolutionMode;
  const modeSource = scopedPolicy.sources.resolutionMode;

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
  const compatExecutionMode = await loadExecutionMode(db);
  const evalFor = (a: AgentRow) =>
    evaluateAgent({
      userId,
      // ADR-0124 — the IDE surface is a dispatch path and is gated like one.
      // Developers' traffic is exactly what a halt is usually thrown for.
      execution: postureOf(compatExecutionMode, agentHaltOf(a)),
      agent: { id: a.id, name: a.name, tier: a.tier, enabled: a.enabled, modes: a.modes ?? null },
      mode: COMPAT_MODE,
      agentGrants: grants,
      roleAgentGrants: roleGrants,
      agentRevocations: revocations,
      ceilingTier,
    });

  // ADR-0066 §3 — THE PER-KEY ALLOW-LIST AT THE COMPAT SURFACE. Loaded once
  // here and threaded onto `prepared`, so the dispatch core sees it too and the
  // two surfaces cannot diverge. Checked against the REQUESTED agent BEFORE
  // routing, so the refusal names what the client asked for; the core re-checks
  // the SERVED agent, which is what stops a router override or a fallback hop
  // from becoming a way past the list.
  const virtualKey = await loadVirtualKeyContext(db, req);
  if (virtualKey) {
    const refusal = virtualKeyAllowListRefusal(virtualKey, requested);
    if (refusal) {
      await db.insert(auditLog).values({
        userId,
        objectType: "virtual_key",
        objectId: virtualKey.id,
        detail: {
          surface: "compat",
          requestedModel: args.requestedModel,
          agentId: requested.id,
          agentName: requested.name,
          ...(projectId ? { projectId } : {}),
        },
        effect: "deny",
        ruleId: refusal.ruleId,
        ruleChain: [],
        reason: refusal.detail,
      });
      return { ok: false, status: refusal.status, error: refusal.error, detail: refusal.detail };
    }
  }

  const decision = evalFor(requested);
  if (decision.effect !== "allow") {
    const [row] = await db.insert(auditLog).values({
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
    }).returning({ id: auditLog.id });
    // ADR-0070 — an entitlement refusal on a COMPAT surface gets the same
    // `policy` deny span the native invoke path's does. An off-the-shelf SDK
    // pointed at this gateway is precisely the caller most likely to be
    // confused by "why did nothing happen", and it has no RegulAIt UI to check.
    const denyTrace = await beginTrace(db, {
      kind: "dispatch",
      name: `denied: ${requested.name}`,
      userId,
      projectId,
    });
    if (denyTrace) {
      const at = new Date();
      await recordSpan(db, denyTrace, {
        kind: "policy",
        name: `entitlement: ${requested.name}`,
        status: "denied",
        statusReason: decision.reason,
        startedAt: at,
        endedAt: at,
        agentId: requested.id,
        auditLogId: row?.id ?? null,
        provider: requested.provider,
        model: requested.model,
        attributes: {
          surface: "compat",
          mode: COMPAT_MODE,
          requestedModel: args.requestedModel,
          ruleId: decision.ruleId,
          effect: decision.effect,
        },
      });
      await finishTrace(db, denyTrace, "denied", at);
    }
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
    // ADR-0066: the router chooses only among targets the caller is entitled to
    // AND — on a virtual key — that the key admits. Filtering here rather than
    // letting the core refuse afterwards means a key's allow-list narrows the
    // routing search space instead of turning a legitimate downroute into a 403.
    const entitled = registry.filter(
      (a) =>
        evalFor(a).effect === "allow" &&
        (!virtualKey || virtualKeyAdmits(virtualKey, { id: a.id, model: a.model })),
    );
    const configured = await configuredProviders(db, dataKey, userId);
    const candidateRows = entitled.filter(
      (a) =>
        a.id === requested.id ||
        (a.model && isModelProviderKind(a.provider) && configured.has(agentProviderToken(a))),
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
        ...(modeSource.level !== "org" ? { modeSource } : {}),
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
      virtualKey,
      routingMode: effectiveTechniqueMode(org, org.routingEnabled, policy?.routingMode ?? null),
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
    /** ADR-0020 long tail: already translated to the neutral shape and
     * validated (named tool present, mappable variant) by the shim. */
    toolChoice?: ModelToolChoice | undefined;
    /** ADR-0020 long tail: provider capability already checked via
     * providerCapabilityError before this call. */
    responseFormat?: ModelResponseFormat | undefined;
    thinking?: { budgetTokens: number } | undefined;
    maxTokens?: number | undefined;
    onText?: ((delta: string) => void) | undefined;
    onThinking?: ModelDispatchRequest["onThinking"] | undefined;
  },
): Promise<DispatchOutcome> {
  const flatText = args.messages
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((b) => (b.type === "text" ? b.text : "")).join(" "),
    )
    .join("\n");

  // -------------------------------------------------------------------------
  // ADR-0119 — THE SEMANTIC CACHE ON THE IDE PATH.
  //
  // Slide 10 sold "seven techniques applied automatically on every call" while
  // this surface ran exactly one of them. The cache is the technique that most
  // obviously belongs here: an IDE re-asks the same question constantly, and a
  // hit means no provider call at all.
  //
  // TWO THINGS ARE DELIBERATELY DIFFERENT FROM THE INVOKE PATH, and both are
  // consequences of the wire format rather than choices:
  //
  //  * `opt_in` CANNOT ENGAGE HERE. On the invoke path `opt_in` means the
  //    caller sets `semanticCache: true`. An Anthropic- or OpenAI-shaped
  //    request has no such field and inventing one would break wire
  //    compatibility, so this surface honours `always` and, under `opt_in`,
  //    behaves exactly as it does today. The posture read (ADR-0118) already
  //    reports the policy, so an operator can see why.
  //  * A TOOL-BEARING TURN IS NEVER CACHED. The answer to a request carrying
  //    tools is not a pure function of the prompt — the model may call a tool
  //    whose result differs every time — so serving a previous answer would be
  //    wrong rather than merely stale.
  // -------------------------------------------------------------------------
  const org = await loadOrgSettings(db);
  const wantCache =
    org.semanticCachePolicy === "always" &&
    prepared.routingMode !== "passthrough" &&
    !args.tools &&
    flatText.length > 0;
  const cacheVersions = wantCache
    ? await Promise.all([
        loadVersions(db, "agent_system_prompt", prepared.served.id),
        loadVersions(db, "agent_config", prepared.served.id),
      ])
    : null;
  const versionIdentity = (rows: Awaited<ReturnType<typeof loadVersions>>) =>
    rows.map((v) => ({ id: v.id, status: v.status, canaryPct: v.canaryPct, body: v.body }));
  const cacheKey = wantCache
    ? semanticCacheRequestKey({
        surface: args.surface,
        requestedModel: prepared.resolution.requestedModel,
        requestedAgentId: prepared.requested.id,
        servedAgentId: prepared.served.id,
        servedModel: prepared.served.model,
        servedProvider: prepared.served.provider,
        servedCustomProviderId: prepared.served.customProviderId,
        servedSystemPrompt: prepared.served.systemPrompt,
        promptVersions: versionIdentity(cacheVersions![0]),
        agentConfigVersions: versionIdentity(cacheVersions![1]),
        projectId: prepared.projectId,
        messages: args.messages,
        system: args.system ?? null,
        cacheSystem: args.cacheSystem ?? false,
        responseFormat: args.responseFormat ?? null,
        thinking: args.thinking ?? null,
        maxTokens: args.maxTokens ?? null,
        toolChoice: args.toolChoice ?? null,
      })
    : null;

  if (cacheKey) {
    const hit = await lookupSemanticCache(db, {
      userId: prepared.userId,
      // scoped to what the CALLER asked for, not what routing served — the
      // same scoping the invoke path uses, or the two would disagree about
      // whose cache a routed call reads.
      agentId: prepared.requested.id,
      key: cacheKey,
      ttlSeconds: org.semanticCacheTtlSeconds,
    });
    if (hit) {
      // The input was gated upstream, but the CACHED OUTPUT may carry PII it
      // acquired under a different, ungated attribution. Re-gate it rather
      // than serve it onto a block-mode project.
      const outputBlock = await enforceProjectCachedOutputPii(
        db,
        prepared.userId,
        prepared.requested.id,
        prepared.projectId,
        hit.outputText,
      );
      if (outputBlock) {
        return {
          ok: false,
          status: outputBlock.status,
          error: outputBlock.error,
          ...(outputBlock.detail ? { detail: outputBlock.detail } : {}),
          ...(outputBlock.pii ? { pii: outputBlock.pii } : {}),
        };
      }
      // A streaming caller still gets a stream: the cached answer is emitted
      // as one delta, so the wire contract is unchanged and an IDE cannot tell
      // a hit from a very fast model.
      args.onText?.(hit.outputText);
      const savings = semanticCacheSavings(prepared.requested, hit);
      await db.insert(costEvents).values({
        userId: prepared.userId,
        objectType: "agent",
        objectId: prepared.requested.id,
        technique: "semantic_caching",
        requestedAgentId: prepared.requested.id,
        servedAgentId: prepared.requested.id,
        baselineAgentId: prepared.requested.id,
        estimatedTokensIn: hit.inputTokens,
        estimatedTokensOut: hit.outputTokens,
        estimatedTokensSaved: savings.savedTokens,
        estimatedCostSavedUsd: savings.estimatedCostSavedUsd,
        estimationBasis:
          "semantic-caching: whole call served from the per-(user,agent) exact-match cache — " +
          "full cached input+output tokens saved at the requested agent's list price",
        ruleId: "semantic-cache-hit",
        projectId: prepared.projectId,
        detail: { model: hit.model, surface: `compat_${args.surface}` },
      });
      await db.insert(auditLog).values({
        userId: prepared.userId,
        objectType: "agent",
        objectId: prepared.requested.id,
        detail: {
          surface: `compat_${args.surface}`,
          mode: COMPAT_MODE,
          semanticCache: "hit",
          ...(prepared.projectId ? { projectId: prepared.projectId } : {}),
        },
        effect: "allow",
        ruleId: "compat-semantic-cache-hit",
        ruleChain: [],
        reason:
          `intercepted ${args.surface}-shaped call served from the semantic cache — ` +
          `no provider was contacted and nothing was billed`,
      });
      // No usage_events: nothing was spent. The cost ledger records the SAVING,
      // which is the only number a cache hit legitimately produces.
      return {
        ok: true,
        result: {
          servedAgentId: prepared.requested.id,
          // the model that PRODUCED the cached answer, which is the honest
          // thing to report; falling back to the requested model string only
          // when the row predates model recording, so the wire response always
          // carries a valid identifier.
          model: hit.model ?? prepared.resolution.requestedModel,
          outputText: hit.outputText,
          stopReason: "end_turn",
          refusal: false,
          usage: { inputTokens: hit.inputTokens, outputTokens: hit.outputTokens },
          costUsd: 0,
          measuredCostSavedUsd: savings.estimatedCostSavedUsd,
          credentialSource: "none",
          projectBudgetAlerted: false,
        },
      };
    }
  }

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
    ...(args.toolChoice ? { toolChoice: args.toolChoice } : {}),
    ...(args.responseFormat ? { responseFormat: args.responseFormat } : {}),
    ...(args.thinking ? { thinking: args.thinking } : {}),
    ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
    projectId: prepared.projectId,
    ...(args.onText ? { onText: args.onText } : {}),
    ...(args.onThinking ? { onThinking: args.onThinking } : {}),
    virtualKey: prepared.virtualKey,
    mode: COMPAT_MODE,
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

  // ADR-0119 — store on a clean miss. Never a refusal, an empty answer, a
  // PII-withheld marker or a tool-calling turn: each of those would make a
  // transient or withheld state permanent for the whole TTL.
  if (cacheKey && outcome.ok) {
    const r = outcome.result;
    if (!r.refusal && r.outputText && !r.pii?.withheld && !r.toolCalls?.length) {
      await storeSemanticCache(db, {
        userId: prepared.userId,
        agentId: prepared.requested.id,
        key: cacheKey,
        outputText: r.outputText,
        model: r.model,
        inputTokens: r.usage.inputTokens,
        outputTokens: r.usage.outputTokens,
      });
    }
  }

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

/** ADR-0024 (O15) — the HONEST posture status. The ladder rung an org declares
 * and what this deployment actually enforces are different facts, and the API
 * states both so the admin UI cannot imply enforcement that does not exist:
 *  - observe / voluntary: honor system — nothing stops a direct vendor call;
 *  - managed: policy — pushed to machines, reversible by the developer;
 *  - key_custody: ENFORCED only while keyCustodyEnforced is true (BYO user
 *    credentials 409 and are skipped at dispatch); otherwise it is a DECLARED
 *    rung with a warning — declaring custody does not implement it;
 *  - network: enforcement lives at the customer's network boundary (egress
 *    control), never in this product — see docs/product/IDE_INTEGRATION.md.
 */
export type PostureStatusKind =
  | "honor_system"
  | "policy"
  | "enforced"
  | "declared_not_enforced"
  | "external_infrastructure";

export function postureStatus(settings: InterceptionSettingsRow): {
  rung: InterceptionSettingsRow["enforcementPosture"];
  status: PostureStatusKind;
  label: string;
  detail: string;
} {
  const rung = settings.enforcementPosture;
  if (rung === "observe" || rung === "voluntary") {
    return {
      rung,
      status: "honor_system",
      label: "Honor system",
      detail:
        "Nothing stops a developer calling the vendor directly. Pointing an IDE here is a request, not an enforcement.",
    };
  }
  if (rung === "managed") {
    return {
      rung,
      status: "policy",
      label: "Policy",
      detail:
        "Pushed via IDE policy / managed settings / MDM. Better than voluntary, still reversible on the developer's own machine.",
    };
  }
  if (rung === "key_custody") {
    return settings.keyCustodyEnforced
      ? {
          rung,
          status: "enforced",
          label: "ENFORCED by this deployment",
          detail:
            "Key custody is ON: per-user BYO model credentials are rejected (409) and dispatch resolution skips stored user credentials entirely — the org holds the vendor keys, developers hold only RegulAIt keys.",
        }
      : {
          rung,
          status: "declared_not_enforced",
          label: "DECLARED but NOT enforced",
          detail:
            "This deployment declares key custody but 'enforce key custody' is OFF — per-user BYO credentials still work, so the rung is currently a statement, not a mechanism. Turn the enforcement toggle on to make it true.",
        };
  }
  return {
    rung,
    status: "external_infrastructure",
    label: "Requires egress control at your network boundary",
    detail:
      "The network rung is enforced by YOUR network (an egress allowlist that blocks the vendor APIs and allows only the RegulAIt gateway), not by this product — see docs/product/IDE_INTEGRATION.md for the recipe.",
  };
}

const scopeRuleIdParam = z.object({ ruleId: z.string().uuid() });
const effectiveQuery = z.object({
  userId: z.string().uuid(),
  projectId: z.string().uuid().optional(),
});

/** Validate that a scope rule's target actually exists for its kind, so an
 * admin typo becomes a 422 instead of a rule that silently never matches. */
async function scopeTargetName(
  db: Db,
  scopeKind: InterceptionScopeKind,
  scopeId: string,
): Promise<string | null> {
  if (scopeKind === "user") {
    const [u] = await db
      .select({ name: users.displayName, email: users.email })
      .from(users)
      .where(eq(users.id, scopeId));
    return u ? (u.name ?? u.email) : null;
  }
  if (scopeKind === "project") {
    const [p] = await db.select({ name: projects.name }).from(projects).where(eq(projects.id, scopeId));
    return p?.name ?? null;
  }
  const [r] = await db.select({ name: roles.name }).from(roles).where(eq(roles.id, scopeId));
  return r?.name ?? null;
}

/** GET/PUT the posture, plus the ADR-0024 scope-rule CRUD and the live
 * effective-value preview. ALL ADMIN-ONLY — deliberately absent from
 * NON_ADMIN_ROUTES, unlike the compat endpoints themselves (which are the
 * developer's path and must be callable by a non-admin, exactly like the MCP
 * proxy). Every write is audited. */
export function registerInterceptionRoutes(app: FastifyInstance, db: Db) {
  app.get("/v1/interception/settings", async () => {
    const settings = await loadInterceptionSettings(db);
    // O15: the honest enforced-vs-declared status rides beside the raw row so
    // every consumer (the Client Access tab first) renders the same truth.
    return { settings, posture: postureStatus(settings) };
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
    return reply.send({ settings: after, posture: postureStatus(after) });
  });

  // --- ADR-0024 (O13): per-scope override rules ---------------------------
  // Admin-only CRUD (absent from NON_ADMIN_ROUTES), every write audited with
  // objectType 'interception_scope_rule'. A rule's scope is its identity;
  // retargeting is delete + create, so PATCH only touches the override fields.

  app.get("/v1/interception/scope-rules", async () => {
    const rows = await db.select().from(interceptionScopeRules);
    const named = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        // resolved for the admin UI; null when the target was since deleted
        // (a dangling rule matches nothing and is safe to clean up)
        scopeName: await scopeTargetName(db, r.scopeKind, r.scopeId),
      })),
    );
    return { rules: named };
  });

  app.post("/v1/interception/scope-rules", async (req, reply) => {
    const body = createInterceptionScopeRuleSchema.parse(req.body);
    const scopeName = await scopeTargetName(db, body.scopeKind, body.scopeId);
    if (scopeName === null) {
      return reply.status(422).send({
        error: "unknown_scope_target",
        detail: `no ${body.scopeKind} with id '${body.scopeId}' — a rule must target something that exists`,
      });
    }
    const [row] = await db
      .insert(interceptionScopeRules)
      .values({
        scopeKind: body.scopeKind,
        scopeId: body.scopeId,
        anthropicCompatEnabled: body.anthropicCompatEnabled ?? null,
        openaiCompatEnabled: body.openaiCompatEnabled ?? null,
        resolutionMode: body.resolutionMode ?? null,
        note: body.note ?? null,
        createdBy: req.authCtx.userId,
      })
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "interception_scope_rule",
      objectId: row!.id,
      detail: { via: req.authCtx.via, action: "created", rule: row, scopeName },
      effect: "allow",
      ruleId: "interception-scope-rule-created",
      ruleChain: [],
      reason: `interception scope rule created for ${body.scopeKind} '${scopeName}' — surface exposure only, grants no entitlement`,
    });
    return reply.status(201).send({ ...row, scopeName });
  });

  app.patch("/v1/interception/scope-rules/:ruleId", async (req, reply) => {
    const { ruleId } = scopeRuleIdParam.parse(req.params);
    const body = updateInterceptionScopeRuleSchema.parse(req.body);
    const [row] = await db
      .update(interceptionScopeRules)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(interceptionScopeRules.id, ruleId))
      .returning();
    if (!row) return reply.status(404).send({ error: "unknown_scope_rule" });
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "interception_scope_rule",
      objectId: row.id,
      detail: { via: req.authCtx.via, action: "updated", changed: body, after: row },
      effect: "allow",
      ruleId: "interception-scope-rule-updated",
      ruleChain: [],
      reason: `interception scope rule ${row.id} updated: ${Object.keys(body).join(", ") || "(no fields)"}`,
    });
    return { ...row, scopeName: await scopeTargetName(db, row.scopeKind, row.scopeId) };
  });

  app.delete("/v1/interception/scope-rules/:ruleId", async (req, reply) => {
    const { ruleId } = scopeRuleIdParam.parse(req.params);
    const deleted = await db
      .delete(interceptionScopeRules)
      .where(eq(interceptionScopeRules.id, ruleId))
      .returning();
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_scope_rule" });
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "interception_scope_rule",
      objectId: ruleId,
      detail: { via: req.authCtx.via, action: "deleted", rule: deleted[0] },
      effect: "allow",
      ruleId: "interception-scope-rule-deleted",
      ruleChain: [],
      reason: `interception scope rule ${ruleId} deleted — the scope falls back to inheritance`,
    });
    return { removed: true };
  });

  // Live effective-value preview for the admin UI: "what would THIS user (on
  // THIS project) get right now?" — the exact resolver the request gate and
  // prepareCompatCall run, so the preview can never drift from enforcement.
  app.get("/v1/interception/effective", async (req, reply) => {
    const q = effectiveQuery.safeParse(req.query);
    if (!q.success) {
      return reply
        .status(400)
        .send({ error: "invalid_query", detail: "userId (uuid) required, projectId (uuid) optional" });
    }
    const policy = await resolveInterceptionPolicy(db, {
      userId: q.data.userId,
      projectId: q.data.projectId ?? null,
    });
    return {
      effective: {
        anthropicCompatEnabled: policy.anthropicCompatEnabled,
        openaiCompatEnabled: policy.openaiCompatEnabled,
        resolutionMode: policy.resolutionMode,
      },
      sources: policy.sources,
      org: {
        anthropicCompatEnabled: policy.settings.anthropicCompatEnabled,
        openaiCompatEnabled: policy.settings.openaiCompatEnabled,
        resolutionMode: policy.settings.resolutionMode,
      },
    };
  });
}
