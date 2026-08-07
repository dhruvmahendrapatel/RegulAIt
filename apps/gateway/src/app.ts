import Fastify from "fastify";
import {
  and,
  desc,
  eq,
  gte,
  lte,
  agentRevocations,
  agents,
  approvalAssignments,
  apiKeys,
  approvalDelegations,
  approvalRules,
  approvals,
  auditLog,
  authSessions,
  backupRuns,
  certInventory,
  infraFindings,
  infraResources,
  patchRecords,
  connectorRevocations,
  connectors,
  dataScopeRules,
  inArray,
  isNull,
  mcpServers,
  mcpTools,
  modelCards,
  or,
  orchestrationRuns,
  projectContextItems,
  projects,
  rateLimits,
  revocations,
  roleAgentGrants,
  roleAssignments,
  roleConnectorGrants,
  roleServerGrants,
  roleToolGrants,
  roles,
  serverGrants,
  sql,
  teamMembers,
  teams,
  toolGrants,
  users,
  workflowInstances,
  type Db,
  type SQL,
} from "@regulait/db";
import {
  csvBatchRows,
  csvMaxRows,
  resolveCsvWindow,
  streamCsv,
} from "./csv-export.js";
import { afterCursorDesc, atTextSql, decodeCursor, encodeCursor } from "./pagination.js";
import { resolveTrustProxy, type TrustProxySetting } from "./trusted-proxy.js";
import { resolveHsts } from "./hsts.js";
import fastifyRateLimit from "@fastify/rate-limit";
import { schedulerHealth } from "./scheduler-health.js";
import {
  rateLimitKey,
  rateLimitMax,
  rateLimitWindowMs,
  resolveRateLimitConfig,
  type RateLimitConfig,
} from "./rate-limit.js";
import { visibleTools, type ToolRef } from "@regulait/policy-kernel";
import {
  assignRoleSchema,
  createAgentRevocationSchema,
  createApiKeySchema,
  createApprovalRuleSchema,
  createDataScopeRuleSchema,
  createConnectorRevocationSchema,
  createRateLimitSchema,
  createRevocationSchema,
  createRoleAgentGrantSchema,
  createRoleConnectorGrantSchema,
  createRoleSchema,
  createRoleServerGrantSchema,
  createRoleToolGrantSchema,
  createServerGrantSchema,
  createServerSchema,
  createToolGrantSchema,
  createToolSchema,
  createUserSchema,
  createDelegationSchema,
  deactivateUserSchema,
  decideApprovalSchema,
  deleteRoleSchema,
  evaluateRequestSchema,
  setUserAdminSchema,
  updateServerSchema,
  updateUserSchema,
} from "@regulait/shared";
import { governedEvaluate } from "./governed-evaluate.js";
import { refuseMcpServerWrite } from "./mcp-egress.js";
import { loadEntitlements } from "./entitlements.js";
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  authenticate,
  clearSessionCookie,
  generateToken,
  governingIpPolicy,
  readCookie,
  registerAuthRoutes,
  requestIsSecure,
  resolveSession,
  type AuthContext,
} from "./auth.js";
import { registerSamlRoutes } from "./saml.js";
import { SCIM_ROUTES, registerScimAdminRoutes, registerScimRoutes } from "./scim.js";
import { registerGroupRoleMappingRoutes } from "./group-role-api.js";
import { registerAbacRoutes } from "./abac.js";
import { registerPolicySimulationRoutes } from "./policy-simulation.js";
import { registerGuardrailRoutes } from "./guardrails.js";
import { registerEvalRoutes } from "./evals.js";
import { applyModelCardApprovalDecision, registerMrmRoutes } from "./mrm.js";
import { registerRedTeamRoutes } from "./redteam.js";
import { registerReportingRoutes } from "./reporting.js";
import { registerConfigVersionRoutes } from "./config-versions.js";
import { registerSpendMonitorRoutes } from "./spend-monitor.js";
import { registerLineageRoutes } from "./lineage.js";
import { registerBillingRoutes } from "./billing.js";
import { refuseIfSeatCapReached, registerLicensingRoutes } from "./licensing.js";
import { registerAuditChainRoutes, type AnchorSink } from "./audit-chain.js";
import {
  assignedApprovalIdsFor,
  ensureAssignment,
  evaluateAssignmentSla,
  materializeAndEvaluate,
  registerWorkbenchRoutes,
  routingActive,
} from "./workbench.js";
import { abacPrincipalFromRequest } from "./abac-principal.js";
import { evaluateIpEnvelope } from "./net-policy.js";
import { activeDelegatorsFor, activeDelegationFrom } from "./delegations.js";

declare module "fastify" {
  interface FastifyRequest {
    authCtx: AuthContext;
  }
}

export interface BuildAppOptions {
  /** deploy-time admin token used to create the first real user + key */
  bootstrapToken?: string;
  /** hex AES-256 key for encrypting stored git tokens (REGULAIT_DATA_KEY) */
  dataKey?: string;
  /** ADR-0031: which peers may speak for the client via X-Forwarded-*.
   * Defaults to REGULAIT_TRUSTED_PROXIES (which itself defaults to trusting
   * nothing). Exposed so a test can assert both directions. */
  trustProxy?: TrustProxySetting;
  /** ADR-0031: per-IP / per-key HTTP rate limits. Defaults come from the
   * environment (see rate-limit.ts); this override exists so a test can pin
   * tiny windows without touching process.env. */
  rateLimit?: Partial<RateLimitConfig>;
  /** ADR-0029 amendment: the Strict-Transport-Security value sent on genuinely
   * secure responses, or `null` for none. Defaults to REGULAIT_HSTS (which
   * itself defaults to `max-age=86400`). Exposed so a test can assert both
   * directions without touching process.env — see hsts.ts for why this is a
   * deployment env var rather than an org_settings toggle. */
  hsts?: string | null;
  /** ADR-0060: where audit-chain head anchors are externalized. Defaults to
   * REGULAIT_AUDIT_ANCHOR_DIR (and to NO sink at all when that is unset, which
   * is a disclosed state, not a misconfiguration). `null` forces no sink.
   * Exposed so a test can drive a real WORM buffer without touching the
   * environment. */
  auditAnchorSink?: AnchorSink | null;
}
import { z } from "zod";
import { registerMcpProxy } from "./mcp-proxy.js";
import { registerAgentConnectorRoutes } from "./agents-connectors.js";
import { registerCustomProviderRoutes } from "./custom-providers.js";
import {
  applyTrainingJobApprovalDecision,
  registerRegulAItLlmRoutes,
} from "./regulait-llm.js";
import {
  API_KEY_HEADER_ROUTES,
  COMPAT_ANTHROPIC_ROUTE,
  COMPAT_MODELS_ROUTE,
  INTERCEPTION_GATED_ROUTES,
  MCP_PROXY_ROUTE,
  PROJECT_HEADER,
  interceptionScopeRulesExist,
  loadInterceptionSettings,
  notFoundBody,
  registerInterceptionRoutes,
  resolveInterceptionPolicy,
} from "./compat-core.js";
import { registerAnthropicCompat } from "./compat-anthropic.js";
import { registerOpenAiCompat } from "./compat-openai.js";
import { registerModelsDiscovery } from "./compat-models.js";
import { registerVirtualKeyRoutes, VIRTUAL_KEY_ALLOWED_ROUTES } from "./virtual-keys.js";
import { registerConversationRoutes } from "./conversations.js";
import { applyProjectApprovalDecision, registerProjectRoutes } from "./projects.js";
import { applyInfraApprovalDecision, registerInfraRoutes } from "./infra.js";
import { registerOptimizationRoutes } from "./optimization.js";
import { applyRunApprovalDecision, registerOrchestrationRoutes } from "./orchestration.js";
import { registerDecomposeRoutes } from "./decompose.js";
import { mirrorApprovalDecision, registerPmRoutes } from "./pm.js";
import { RunStateError } from "@regulait/orchestration-kernel";
import { applyWorkflowApprovalDecision, registerWorkflowRoutes } from "./workflows.js";
import {
  loadOrgSettings,
  registerOrgSettingsRoutes,
  startAuditPruneScheduler,
} from "./org-settings.js";
import { registerSetupStatusRoutes } from "./setup-status.js";
import { registerSchedulerRoutes } from "./scheduler-api.js";
import { schedulerJobRegistry } from "./scheduler-jobs.js";
import { registerDataKeyRoutes } from "./data-key.js";
import { WEB_UI_ROUTES, defaultWebDistDir, registerWebServing } from "./web-serving.js";
// ADR-0053 — the auth-class sets the two gates below branch on. They live in
// their own module so the published OpenAPI document derives each route's
// documented credential requirement from the SAME objects that enforce it.
import { AUTH_EXEMPT_ROUTES, NON_ADMIN_ROUTES } from "./route-classes.js";
import { registerOpenApiRoutes, type RouteInventoryEntry } from "./openapi.js";
import { registerOnboardingRoutes } from "./onboarding.js";
import { registerShadowAiRoutes } from "./shadow-ai.js";
import { registerCostImportRoutes } from "./cost-import.js";
import { registerCompliancePackRoutes } from "./compliance-packs.js";
import { registerCopilotRoutes } from "./copilot.js";
import { registerChatOpsRoutes } from "./chatops.js";
import path from "node:path";
import { registerSpaInlineScripts, securityHeaders } from "./security-headers.js";
import { MergeConflictError, WorkflowStateError } from "@regulait/workflow-kernel";

const uuidParam = z.object({ serverId: z.string().uuid() });
const visibleToolsParams = z.object({
  userId: z.string().uuid(),
  serverId: z.string().uuid(),
});
/** ADR-0031: documented ceiling on one /v1/audit page. A caller that wants more
 * than this pages with `cursor`, or takes the streamed CSV export. */
export const AUDIT_MAX_PAGE_SIZE = 1000;
const AUDIT_DEFAULT_PAGE_SIZE = 100;

/**
 * THE filter set for the audit trail. Both the screen read (`GET /v1/audit`)
 * and the compliance export (`GET /v1/audit.csv`) parse this same object and
 * build their WHERE with the same `auditFilters()` below — a downloaded trail
 * can never quietly cover a different set of rows than the one an admin saw.
 *
 * `deployMode` is A4 (ADR-0027) exposed as a QUERY dimension: it filters the
 * trail by the deploy mode a deploy-mode-scoped action acted on. The honest
 * fourth value is `unknown` → `deploy_mode IS NULL`. That bucket is NOT
 * "hosted by default" and never can be: pre-0044 rows never recorded a mode
 * (ADR-0027 §2a — un-backfillable by design), and the large majority of rows
 * (MCP calls, membership changes, settings edits …) are not deploy-scoped at
 * all, so they have no mode to have. Omitting the param = every row.
 *
 * `objectType`/`effect`/`from`/`to` are ADR-0031 additions; `from`/`to` are
 * also what lets an auditor take the export in bounded slices instead of
 * asking for the whole table at once.
 */
const auditFilterQuery = z.object({
  userId: z.string().uuid().optional(),
  deployMode: z.enum(["hosted", "byoc", "air_gapped", "unknown"]).optional(),
  objectType: z.string().min(1).max(64).optional(),
  effect: z.enum(["allow", "deny", "require_approval"]).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
type AuditFilterInput = z.infer<typeof auditFilterQuery>;

/** the screen read adds paging on top of the shared filter set */
const auditQuery = auditFilterQuery.extend({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(AUDIT_MAX_PAGE_SIZE)
    .default(AUDIT_DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).max(256).optional(),
});

/** the export takes the filter set unchanged — no paging params, because it
 * streams the whole (bounded, disclosed) selection rather than one page */
const auditCsvQuery = auditFilterQuery;
const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** every audit_log column, spelled out so a keyset read can select the row AND
 * a derived microsecond-exact `atText` cursor field in one query without
 * changing the row shape any existing caller sees */
const auditLogColumns = {
  id: auditLog.id,
  at: auditLog.at,
  userId: auditLog.userId,
  objectType: auditLog.objectType,
  objectId: auditLog.objectId,
  detail: auditLog.detail,
  serverId: auditLog.serverId,
  toolName: auditLog.toolName,
  effect: auditLog.effect,
  ruleId: auditLog.ruleId,
  ruleChain: auditLog.ruleChain,
  reason: auditLog.reason,
  deployMode: auditLog.deployMode,
} as const;

/**
 * THE WHERE terms for the audit trail — the single implementation behind both
 * `GET /v1/audit` and `GET /v1/audit.csv` (PR #79's `auditWhere`, extended with
 * ADR-0031's filters and its explicit date window). One function, so a filter
 * added on one side can never silently stop applying to the other.
 *
 * `from`/`to` are passed in rather than read off `q` because the export may
 * apply a DEFAULTED window the caller never asked for (see csv-export.ts), and
 * because the "are there rows outside the window?" disclosure probe needs the
 * same filters with the window inverted.
 */
function auditFilters(q: AuditFilterInput, from: Date | null, to: Date | null): SQL[] {
  const out: SQL[] = [];
  if (q.userId) out.push(eq(auditLog.userId, q.userId));
  if (q.deployMode) {
    // 'unknown' is deploy_mode IS NULL — an explicit, equal bucket, never an
    // inferred "hosted" (ADR-0027 §2a: those rows are un-backfillable).
    out.push(
      q.deployMode === "unknown"
        ? isNull(auditLog.deployMode)
        : eq(auditLog.deployMode, q.deployMode),
    );
  }
  if (q.objectType) out.push(eq(auditLog.objectType, q.objectType as "mcp_tool"));
  if (q.effect) out.push(eq(auditLog.effect, q.effect));
  if (from) out.push(gte(auditLog.at, from));
  if (to) out.push(lte(auditLog.at, to));
  return out;
}

/** the same terms as one composed predicate (`undefined` = no filter at all) */
function auditWhere(q: AuditFilterInput, from: Date | null, to: Date | null): SQL | undefined {
  const conds = auditFilters(q, from, to);
  return conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds);
}

export function buildApp(db: Db, opts: BuildAppOptions = {}) {
  // trustProxy (ADR-0029, NARROWED by ADR-0031 item 3): the deployed stack runs
  // behind a Caddy TLS terminator, so the socket peer is the proxy, not the
  // user. Without trusting it, `req.ip` — recorded on every auth_sessions row
  // (ADR-0025/0028) — degrades to the proxy's container address and the session
  // audit trail loses the real client. That is why ADR-0029 turned it on.
  //
  // But `true` trusts X-Forwarded-* from ANY peer, and Caddy's overwrite
  // (`header_up X-Forwarded-For {remote_host}`) only protects the path that
  // actually goes through Caddy. Anything that reaches the gateway port
  // directly — host loopback, a sibling container on the compose network, a
  // future sidecar — bypasses Caddy entirely and could then choose the client
  // IP that lands on the compliance trail. So the peer is now named instead of
  // assumed: REGULAIT_TRUSTED_PROXIES (IPs/CIDRs/proxy-addr keywords), which
  // docker-compose.yml sets to the compose network for the `tls` profile.
  // Default when unset: trust nothing. See trusted-proxy.ts.
  const trustProxy = opts.trustProxy ?? resolveTrustProxy();
  const app = Fastify({ logger: false, trustProxy });

  // ADR-0053 — THE ROUTE INVENTORY. Registered FIRST, before any route, because
  // Fastify's `onRoute` hook only fires for routes added after it. Every
  // `app.get/post/...` call anywhere in this process — including the ones inside
  // the ~40 `register*Routes` modules below — lands here.
  //
  // This is what makes spec drift DETECTABLE rather than aspirational: the
  // OpenAPI document is built against this list, and `openapi.test.ts` fails
  // when a registered route has no spec entry, or a spec entry names a route
  // that no longer exists. Nobody has to remember to update a document.
  //
  // HEAD is excluded: Fastify auto-registers a HEAD twin for every GET, and
  // documenting a route the author never wrote would be noise, not contract.
  const routeInventory: RouteInventoryEntry[] = [];
  app.addHook("onRoute", (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const m of methods) {
      if (m === "HEAD" || m === "OPTIONS") continue;
      const key = `${m} ${r.url}`;
      if (routeInventory.some((e) => `${e.method} ${e.url}` === key)) continue;
      routeInventory.push({ method: m, url: r.url });
    }
  });
  app.decorate("routeInventory", routeInventory);

  // ADR-0029 amendment — the Strict-Transport-Security value, resolved ONCE at
  // boot (never per request: the header must not depend on the database, and
  // an operator's posture must not drift mid-process). `undefined` means "not
  // overridden", which is different from `null` = "send no header", so the
  // nullish coalesce is deliberately on `undefined` only.
  const hsts = opts.hsts !== undefined ? opts.hsts : resolveHsts();

  // ADR-0031 item 4 — HTTP rate limiting. There was a per-ACCOUNT login
  // lockout (ADR-0025) and nothing bounding per-IP/per-key request rates on
  // any of the ~167 endpoints, so credential spraying across many accounts was
  // unmetered. Two buckets: a generous global one, and a much stricter one on
  // the three credential-accepting endpoints. Both key on `req.ip`, which is
  // only trustworthy because of item 3 above — with a blanket trustProxy an
  // attacker would rotate x-forwarded-for for a fresh bucket per request.
  //
  // The plugin is registered with global:false and driven from OUR onRequest
  // hook rather than its onRoute integration: onRoute only sees routes
  // registered after the plugin finishes loading, and `register()` defers that
  // to ready() — long after every route below is in place. Driving it from a
  // hook added here, before any route, makes coverage order-independent.
  const rateCfg = resolveRateLimitConfig(process.env, opts.rateLimit ?? {});
  if (rateCfg.enabled) {
    app.register(fastifyRateLimit, {
      global: false,
      keyGenerator: rateLimitKey,
      max: (_req, key) => rateLimitMax(rateCfg, key),
      timeWindow: (_req, key) => rateLimitWindowMs(rateCfg, key),
      // a load balancer's liveness poll must never be throttled into a false
      // "gateway is down"
      allowList: (req) => req.url === "/health",
    });
    let limiter: ReturnType<typeof app.createRateLimit> | null = null;
    app.addHook("onRequest", async (req, reply) => {
      limiter ??= app.createRateLimit();
      const verdict = await limiter(req);
      // isAllowed === true means allow-listed (never counted at all)
      if (verdict.isAllowed) return;
      reply
        .header("x-ratelimit-limit", String(verdict.max))
        .header("x-ratelimit-remaining", String(verdict.remaining))
        .header("x-ratelimit-reset", String(verdict.ttlInSeconds));
      if (!verdict.isExceeded) return;
      return reply
        .status(429)
        .header("x-ratelimit-remaining", "0")
        .header("retry-after", String(verdict.ttlInSeconds))
        .send({
          error: "rate_limited",
          detail: `too many requests — limit ${verdict.max} per ${Math.round(verdict.timeWindow / 1000)}s`,
          retryAfterSeconds: verdict.ttlInSeconds,
        });
    });
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: "validation", issues: err.issues });
    }
    // Postgres constraint violations surface as DrizzleQueryError wrapping the
    // pg error; map them to client errors instead of a generic 500.
    if (err instanceof WorkflowStateError) {
      return reply.status(409).send({ error: "invalid_workflow_state", detail: err.message });
    }
    if (err instanceof RunStateError) {
      return reply.status(409).send({ error: "invalid_run_state", detail: err.message });
    }
    if (err instanceof MergeConflictError) {
      return reply.status(422).send({ error: "template_merge_conflict", detail: err.message });
    }
    const pgCode = (err as { cause?: { code?: string } }).cause?.code;
    if (pgCode === "23505") return reply.status(409).send({ error: "conflict" });
    if (pgCode === "23503") return reply.status(400).send({ error: "invalid_reference" });
    app.log.error(err);
    if (process.env.DEBUG_ERRORS) console.error("GATEWAY ERR:", err);
    return reply.status(500).send({ error: "internal" });
  });

  // ADR-0031 item 5 — security headers on every response. The gateway serves
  // the SPA itself and is directly reachable (the compose port, and every dev
  // machine), so it cannot delegate CSP / nosniff / frame-ancestors to an edge
  // proxy. Deliberately here rather than in web-serving.ts: these belong to
  // every response, not just static files.
  //
  // Set-if-absent, never overwrite: a route (or an edge) that already chose a
  // value keeps it, so nothing here can conflict with a header set upstream.
  // The one thing that is NOT set unconditionally is HSTS — announcing it over
  // plain http would be wrong in dev, so it rides only a genuinely secure
  // request (which, per item 3, means a real TLS hop or a hop from a trusted
  // proxy — never a forged x-forwarded-proto).
  //
  // ADR-0029 amendment: the VALUE is no longer hardcoded. It used to be a flat
  // `max-age=31536000; includeSubDomains`, which directly contradicted
  // ADR-0029's stated "HSTS deliberately OFF" — the Caddyfile abstained and the
  // gateway asserted a one-year pin anyway. The gateway is now the single
  // owner (it is what ships into BYOC/air-gapped installs where no Caddy of
  // ours exists), the default is a bounded `max-age=86400`, and an operator on
  // a real domain raises it via REGULAIT_HSTS. See hsts.ts.
  app.addHook("onSend", async (req, reply, payload) => {
    const contentType = reply.getHeader("content-type");
    const headers = securityHeaders(
      typeof contentType === "string" ? contentType : undefined,
    );
    for (const [name, value] of Object.entries(headers)) {
      if (reply.getHeader(name) === undefined) reply.header(name, value);
    }
    if (
      hsts !== null &&
      req.protocol === "https" &&
      reply.getHeader("strict-transport-security") === undefined
    ) {
      reply.header("strict-transport-security", hsts);
    }
    return payload;
  });

  app.decorateRequest("authCtx");

  // Every route requires a valid Bearer token (bootstrap or API key) or an
  // ADR-0025 session cookie — except the inbound PM webhook (ADR-0010), which
  // is called by external systems and authenticates with its per-connection
  // secret inside the route handler, the two shell redirects (/app, /admin),
  // the two unauthenticated entry points a browser or a load balancer hits
  // before it has any credential (/ and /health), and the ADR-0025 login surface itself
  // (login/mfa/key-exchange/OIDC — a browser has no credential yet; logout is
  // exempt so an expired session can still clear its cookie, and reads the
  // cookie in-route).
  // ADR-0053: the two sets below moved to route-classes.ts, VERBATIM, so the
  // published OpenAPI document can derive each route's documented auth class
  // from the very objects these hooks branch on. See that file's header.
  // ADR-0020 INTERCEPTION GATE. Runs in the onRequest phase — BEFORE auth — so
  // a surface the admin has not enabled answers Fastify's own 404 body and is
  // indistinguishable from a route that was never registered. Doing this after
  // auth would leak the surface's existence via a 401. Only the three
  // interception routes are consulted; every other route short-circuits with no
  // query at all.
  //
  // ADR-0024 (O13) makes the two COMPAT routes SCOPE-AWARE: a per-user /
  // per-project / per-role rule can enable a surface the org singleton has off
  // (staged rollout) or disable it for a scope the org has on. Resolution:
  //  - no scope rules exist (the common case): the org value decides, with no
  //    identity resolution at all — byte-identical to the pre-0041 gate;
  //  - rules exist: the caller's identity is resolved from the SAME headers
  //    the auth hook reads (Authorization, plus the x-api-key alias on the
  //    Anthropic route) and the effective value is user > project > role > org.
  //    An unauthenticated or invalid caller resolves at the ORG level, so a
  //    credential-less probe cannot detect that scope rules exist — a
  //    disabled-by-resolution surface answers the SAME indistinguishable 404.
  // The MCP route stays org-only: scope rules cover the compat surfaces.
  // SURFACE EXPOSURE IS NOT ENTITLEMENT — a rule passing this gate grants
  // nothing; evaluateAgent still gates the dispatch identically.
  app.addHook("onRequest", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    if (!INTERCEPTION_GATED_ROUTES.has(route)) return;
    const settings = await loadInterceptionSettings(db);
    if (route === MCP_PROXY_ROUTE) {
      if (!settings.mcpInterceptionEnabled) {
        return reply.status(404).send(notFoundBody(req.method, req.url));
      }
      return;
    }
    // ADR-0066: `GET /v1/models` is the discovery endpoint for BOTH shims, so
    // it exists when EITHER is enabled. A deployment that intercepts nothing
    // still answers the same indistinguishable 404, and a client that can list
    // models can always call at least one of them.
    const orgEnabled =
      route === COMPAT_MODELS_ROUTE
        ? settings.anthropicCompatEnabled || settings.openaiCompatEnabled
        : route === COMPAT_ANTHROPIC_ROUTE
          ? settings.anthropicCompatEnabled
          : settings.openaiCompatEnabled;
    if (!(await interceptionScopeRulesExist(db))) {
      if (!orgEnabled) return reply.status(404).send(notFoundBody(req.method, req.url));
      return;
    }
    let authorization = req.headers.authorization;
    if (!authorization && API_KEY_HEADER_ROUTES.has(route)) {
      const alt = req.headers["x-api-key"];
      if (typeof alt === "string" && alt.length > 0) authorization = `Bearer ${alt}`;
    }
    const ctx = await authenticate(db, opts.bootstrapToken, authorization);
    // ADR-0066: `authenticate` may now answer with a refusal STRING for a
    // credential that exists but may not be used (deactivated owner, revoked or
    // expired virtual key). None of those resolves to an identity, so scope
    // rules fall back to the org level exactly as an invalid token does — a
    // probe still cannot detect that scope rules exist.
    const userId = typeof ctx === "object" && ctx !== null ? ctx.userId : null;
    const projectHeader = req.headers[PROJECT_HEADER];
    const projectId =
      typeof projectHeader === "string" && UUID_ANY_RE.test(projectHeader) ? projectHeader : null;
    const policy = await resolveInterceptionPolicy(db, { userId, projectId }, settings);
    const enabled =
      route === COMPAT_MODELS_ROUTE
        ? policy.anthropicCompatEnabled || policy.openaiCompatEnabled
        : route === COMPAT_ANTHROPIC_ROUTE
          ? policy.anthropicCompatEnabled
          : policy.openaiCompatEnabled;
    if (!enabled) {
      return reply.status(404).send(notFoundBody(req.method, req.url));
    }
  });

  // ADR-0025: the session-authenticated auth self-service surface a user may
  // reach while a must-change-password or must-enroll-MFA gate is closed.
  const AUTH_SELF_SERVICE_ROUTES = new Set([
    "GET /auth/me",
    "POST /auth/change-password",
    "POST /auth/totp/enroll",
    "POST /auth/totp/activate",
  ]);

  app.addHook("preHandler", async (req, reply) => {
    if (AUTH_EXEMPT_ROUTES.has(req.routeOptions.url ?? "")) {
      req.authCtx = { userId: null, isAdmin: false, via: "api-key" };
      return;
    }
    // ADR-0020: the Anthropic-shaped compat endpoint additionally accepts the
    // key in `x-api-key`, because that is the header Anthropic clients send.
    // It is the SAME RegulAIt API key resolved by the SAME authenticate() —
    // a second header name, never a second credential or a weaker path.
    let authorization = req.headers.authorization;
    if (!authorization && API_KEY_HEADER_ROUTES.has(`${req.method} ${req.routeOptions.url ?? ""}`)) {
      const alt = req.headers["x-api-key"];
      if (typeof alt === "string" && alt.length > 0) authorization = `Bearer ${alt}`;
    }

    // ADR-0025: no bearer credential -> try the session cookie. Header auth
    // ALWAYS wins when present, so the API-key request path is byte-identical
    // to pre-0042 even when a stale cookie rides along.
    if (!authorization) {
      const cookieToken = readCookie(req.headers.cookie, SESSION_COOKIE);
      if (cookieToken) {
        // ADR-0039: the client IP rides into the SAME update as the idle-slide
        // so last_seen_ip tracks where the session IS, not where it started
        const session = await resolveSession(db, cookieToken, Boolean(opts.bootstrapToken), req.ip ?? null);
        if (session === "disabled") {
          return reply.status(401).send({
            error: "user_disabled",
            detail: "this account has been deactivated — an admin can reactivate it",
          });
        }
        if (session) {
          // CSRF: SameSite=Strict already blocks cross-site cookie sends in
          // modern browsers; the custom-header requirement is the second,
          // browser-model-independent wall — no cross-origin form or no-cors
          // fetch can attach a custom header, so a forged state-changing
          // request dies here even if the cookie were somehow attached.
          // Applies ONLY to cookie-authenticated mutations: header-credential
          // clients (API keys) are not CSRF-able and stay untouched.
          if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS") {
            if (req.headers[CSRF_HEADER] !== "1") {
              return reply.status(403).send({
                error: "csrf_header_required",
                detail: `state-changing requests must carry ${CSRF_HEADER}: 1`,
              });
            }
          }
          // ADR-0039 enforce_continuous: EVERY authenticated use of a governed
          // session is checked against the org envelope; an out-of-range
          // request is refused AND the session force-revoked on the spot (the
          // "trusted network only" posture — a laptop leaving the corporate
          // VPN loses its session mid-flight). Fail closed: an undeterminable
          // client IP under a non-empty allow-list is outside the envelope.
          // Human sessions answer to session_ip_policy, exchanged api_key
          // sessions to api_key_ip_policy; bootstrap is never restricted.
          // Settings are re-read from the singleton row on every check, so a
          // tightened allow-list binds on the very next request — no cache.
          const org = await loadOrgSettings(db);
          const ipPolicy = governingIpPolicy(org, session.origin);
          if (ipPolicy === "enforce_continuous") {
            const decision = evaluateIpEnvelope(org.sessionIpAllowlist, req.ip ?? null);
            if (!decision.allowed) {
              const knob = session.origin === "api_key" ? "api_key_ip_policy" : "session_ip_policy";
              // ONE way sessions die: revoked_at — this is just a finer caller
              await db
                .update(authSessions)
                .set({ revokedAt: new Date() })
                .where(and(eq(authSessions.id, session.sessionId), isNull(authSessions.revokedAt)));
              await db.insert(auditLog).values({
                userId: session.ctx.userId ?? "00000000-0000-0000-0000-000000000000",
                objectType: "user",
                objectId: session.ctx.userId,
                detail: {
                  phase: "ip-policy-session-revoked",
                  knob,
                  policy: ipPolicy,
                  sessionId: session.sessionId,
                  origin: session.origin,
                  clientIp: req.ip ?? null,
                  reason: decision.reason,
                  allowlist: org.sessionIpAllowlist ?? [],
                },
                effect: "deny",
                ruleId: "ip-policy-session-revoked",
                ruleChain: [],
                reason: `session ${session.sessionId} force-revoked: request from ${req.ip ?? "an undeterminable client IP"} is outside the org IP allow-list under ${knob}='enforce_continuous'`,
              });
              void reply.header("set-cookie", clearSessionCookie(requestIsSecure(req)));
              return reply.status(401).send({
                error: "ip_not_allowed",
                detail:
                  "this session was signed out: requests from this network address are not permitted by organization policy",
              });
            }
          }
          const route = `${req.method} ${req.routeOptions.url ?? ""}`;
          // gate 1: a one-time password must be replaced before anything else
          if (session.mustChangePassword && !AUTH_SELF_SERVICE_ROUTES.has(route)) {
            return reply.status(403).send({
              error: "password_change_required",
              detail: "this account's password is one-time — set your own via POST /auth/change-password",
            });
          }
          // gate 2: org-mandated MFA enrollment (off|admins|all)
          if (!session.totpEnabled && !AUTH_SELF_SERVICE_ROUTES.has(route) && session.ctx.userId) {
            const mustEnroll =
              org.mfaRequired === "all" || (org.mfaRequired === "admins" && session.ctx.isAdmin);
            if (mustEnroll) {
              return reply.status(403).send({
                error: "mfa_enrollment_required",
                detail: "this organization requires TOTP MFA — enroll via POST /auth/totp/enroll",
              });
            }
          }
          req.authCtx = session.ctx;
          req.sessionAuth = session;
          return;
        }
        // an invalid/expired cookie falls through to the uniform 401 below
      }
    }

    const ctx = await authenticate(db, opts.bootstrapToken, authorization);
    // ADR-0022: a valid key whose user is DEACTIVATED gets its own reason —
    // the holder should learn "your account is disabled", not "bad token".
    if (ctx === "disabled") {
      return reply.status(401).send({
        error: "user_disabled",
        detail: "this account has been deactivated — an admin can reactivate it",
      });
    }
    // ADR-0066: a virtual key that really exists but is revoked or expired says
    // so, rather than reading as a bad token. Only someone holding the real
    // token ever sees this, so it leaks nothing.
    if (ctx === "virtual_key_revoked" || ctx === "virtual_key_expired") {
      return reply.status(401).send({
        error: ctx,
        detail:
          ctx === "virtual_key_revoked"
            ? "this virtual key has been revoked and authenticates nothing"
            : "this virtual key has expired — its issuer can mint a new one",
      });
    }
    if (!ctx) return reply.status(401).send({ error: "unauthenticated" });
    // ADR-0039: header API-key auth under api_key_ip_policy. Each request
    // presents the credential anew, so ANY enforcing level checks every
    // request (there is no session to distinguish "login" from "use", and
    // nothing to revoke — the deny IS the whole enforcement). The bootstrap
    // header is the break-glass path and is never IP-restricted; the human
    // knob never touches this path in either direction.
    // ADR-0066: a virtual key is a programmatic header credential like an API
    // key, so it answers to the SAME api_key_ip_policy. Leaving it out would
    // have made "issue a virtual key" a way around the network envelope.
    if (ctx.via === "api-key" || ctx.via === "virtual-key") {
      const org = await loadOrgSettings(db);
      if (org.apiKeyIpPolicy !== "off") {
        const decision = evaluateIpEnvelope(org.sessionIpAllowlist, req.ip ?? null);
        if (!decision.allowed) {
          await db.insert(auditLog).values({
            userId: ctx.userId ?? "00000000-0000-0000-0000-000000000000",
            objectType: "user",
            objectId: ctx.userId,
            detail: {
              phase: "ip-policy-api-key-denied",
              knob: "api_key_ip_policy",
              policy: org.apiKeyIpPolicy,
              clientIp: req.ip ?? null,
              reason: decision.reason,
              allowlist: org.sessionIpAllowlist ?? [],
            },
            effect: "deny",
            ruleId: "ip-policy-api-key-denied",
            ruleChain: [],
            reason: `API-key request refused: ${req.ip ?? "an undeterminable client IP"} is outside the org IP allow-list under api_key_ip_policy='${org.apiKeyIpPolicy}'`,
          });
          return reply.status(401).send({
            error: "ip_not_allowed",
            detail: "API-key requests from this network address are not permitted by organization policy",
          });
        }
      }
    }
    req.authCtx = ctx;
  });

  // ADR-0066 — THE VIRTUAL-KEY ROUTE CEILING. Runs BEFORE the admin gate,
  // because it is a stricter statement than "is this caller an admin": a
  // virtual key reaches the dispatch surfaces and nothing else, whatever its
  // owner may reach with their own credential.
  //
  // It is an ALLOW-LIST, not a deny-list, and that is the whole design. A route
  // added tomorrow is unreachable on a virtual key until someone deliberately
  // names it here — so the failure mode of forgetting is a 403, not a hole. The
  // routes most worth keeping out are the ones that would dissolve the ceiling:
  // minting credentials, editing grants, and reading model credentials.
  app.addHook("preHandler", async (req, reply) => {
    if (req.authCtx.via !== "virtual-key") return;
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    if (!VIRTUAL_KEY_ALLOWED_ROUTES.has(route)) {
      return reply.status(403).send({
        error: "virtual_key_scope",
        detail:
          `a virtual key may only reach this deployment's model-dispatch surfaces (${[...VIRTUAL_KEY_ALLOWED_ROUTES].join(", ")}); ` +
          `'${route}' is not one of them. Use the owner's own API key or session for anything else.`,
      });
    }
  });

  // Everything is admin-only except the routes where a non-admin identity is
  // the point: deciding an approval (named approver), viewing one's own
  // visible tools, and calling tools through the proxy.
  app.addHook("preHandler", async (req, reply) => {
    const route = `${req.method} ${req.routeOptions.url ?? ""}`;
    if (!NON_ADMIN_ROUTES.has(route) && !req.authCtx.isAdmin) {
      return reply.status(403).send({ error: "admin_only" });
    }
  });

  // identity echo for UI clients — who am I, what may I see. Additively
  // carries the ADR-0021 org size ceilings any authenticated client needs to
  // pre-validate uploads (numbers only — no admin-only configuration leaks).
  app.get("/v1/me", async (req) => {
    const userId = req.authCtx.userId;
    let user = null;
    if (userId) {
      const [row] = await db
        .select({ id: users.id, email: users.email, displayName: users.displayName })
        .from(users)
        .where(eq(users.id, userId));
      user = row ?? null;
    }
    const org = await loadOrgSettings(db);
    return {
      userId,
      isAdmin: req.authCtx.isAdmin,
      user,
      limits: {
        maxAttachmentsPerDispatch: org.maxAttachmentsPerDispatch,
        maxAttachmentBytes: org.maxAttachmentBytes,
      },
    };
  });

  app.post("/v1/users", async (req, reply) => {
    const body = createUserSchema.parse(req.body);
    // ADR-0052 — THE SEAT GATE. A seat is an entitled user, so provisioning one
    // is an EXPANSION-class act: it is refused when the licensed cap is reached
    // or the license has lapsed past its grace window. It is a GROWTH gate and
    // never a service gate — nothing here can revoke, disable or degrade a user
    // who already exists, and a deployment that is over cap (which happens
    // legitimately when a smaller license is installed onto a larger estate)
    // simply cannot add the NEXT one. With no license installed there is no
    // authoritative cap and this is a no-op.
    const seatRefusal = await refuseIfSeatCapReached(db, {
      actorUserId: req.authCtx.userId ?? null,
      email: body.email,
    });
    if (seatRefusal) return reply.status(seatRefusal.status).send(seatRefusal.body);
    const [row] = await db
      .insert(users)
      .values({ email: body.email, displayName: body.displayName, isAdmin: body.isAdmin ?? false })
      .returning();
    return reply.status(201).send(row);
  });

  // ADR-0012: portal-driven API-parity gap fill — the bulk user table needs
  // a list endpoint, not only POST. disabledAt rides along (ADR-0022) so the
  // portal can grey deactivated accounts and offer Reactivate.
  app.get("/v1/users", async () => ({
    users: await db
      .select({
        id: users.id,
        email: users.email,
        // ADR-0030: the second login identifier (null = email-only), so the
        // users table can show and manage it. Never a credential.
        username: users.username,
        displayName: users.displayName,
        isAdmin: users.isAdmin,
        disabledAt: users.disabledAt,
        createdAt: users.createdAt,
        // ADR-0025: sign-in posture flags for the portal (booleans only —
        // never a hash, never a secret)
        totpEnabled: users.totpEnabled,
        hasPassword: sql<boolean>`${users.passwordHash} is not null`,
        mustChangePassword: users.mustChangePassword,
      })
      .from(users),
  }));

  // --- ADR-0022 identity lifecycle (admin-only via the default gate) --------
  // Deactivate ≠ delete: nothing is removed, audit history and FKs survive;
  // only authentication and dispatch-as stop. There is deliberately NO
  // hard-delete route.

  const userIdParam = z.object({ userId: z.string().uuid() });
  const loadUser = async (userId: string) => {
    const [row] = await db.select().from(users).where(eq(users.id, userId));
    return row ?? null;
  };
  /** lockout guard: true when the org would be left with NO active admin */
  const wouldOrphanAdmins = async (exceptUserId: string): Promise<boolean> => {
    const admins = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isAdmin, true), isNull(users.disabledAt)));
    return admins.every((a) => a.id === exceptUserId);
  };
  const auditUserAct = (
    actorId: string | null,
    targetId: string,
    ruleId: string,
    reason: string,
    detail: Record<string, unknown>,
  ) =>
    db.insert(auditLog).values({
      userId: actorId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "user",
      objectId: targetId,
      detail,
      effect: "allow",
      ruleId,
      ruleChain: [],
      reason,
    });

  app.post("/v1/users/:userId/deactivate", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    const body = deactivateUserSchema.parse(req.body ?? {});
    const target = await loadUser(userId);
    if (!target) return reply.status(404).send({ error: "unknown_user" });
    if (target.disabledAt) return reply.status(409).send({ error: "already_disabled" });
    // an admin cannot deactivate THEMSELVES (no self-lockout), and the org
    // must never be left without an active admin
    if (req.authCtx.userId === userId) {
      return reply.status(409).send({
        error: "cannot_deactivate_self",
        detail: "deactivating your own account would lock you out — another admin must do it",
      });
    }
    if (target.isAdmin && (await wouldOrphanAdmins(userId))) {
      return reply.status(409).send({
        error: "last_active_admin",
        detail: "this is the last active admin — promote another admin before deactivating them",
      });
    }
    const [row] = await db
      .update(users)
      .set({ disabledAt: new Date() })
      .where(eq(users.id, userId))
      .returning({ id: users.id, disabledAt: users.disabledAt });
    await auditUserAct(
      req.authCtx.userId,
      userId,
      "user-deactivated",
      `user '${target.email}' deactivated${body.reason ? `: ${body.reason}` : ""}`,
      { phase: "deactivate", email: target.email, ...(body.reason ? { reason: body.reason } : {}) },
    );
    return row;
  });

  app.post("/v1/users/:userId/reactivate", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    const target = await loadUser(userId);
    if (!target) return reply.status(404).send({ error: "unknown_user" });
    if (!target.disabledAt) return reply.status(409).send({ error: "not_disabled" });
    const [row] = await db
      .update(users)
      .set({ disabledAt: null })
      .where(eq(users.id, userId))
      .returning({ id: users.id, disabledAt: users.disabledAt });
    await auditUserAct(req.authCtx.userId, userId, "user-reactivated", `user '${target.email}' reactivated`, {
      phase: "reactivate",
      email: target.email,
    });
    return row;
  });

  // rename — display fields only, deliberately (the email is an identity
  // anchor and stays immutable here)
  app.patch("/v1/users/:userId", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    const body = updateUserSchema.parse(req.body);
    const target = await loadUser(userId);
    if (!target) return reply.status(404).send({ error: "unknown_user" });
    const [row] = await db
      .update(users)
      .set({ displayName: body.displayName })
      .where(eq(users.id, userId))
      .returning({ id: users.id, displayName: users.displayName });
    await auditUserAct(
      req.authCtx.userId,
      userId,
      "user-renamed",
      `user '${target.email}' renamed '${target.displayName}' → '${body.displayName}'`,
      { phase: "rename", from: target.displayName, to: body.displayName },
    );
    return row;
  });

  // promote/demote the admin flag — same lockout guard as deactivation
  app.post("/v1/users/:userId/admin", async (req, reply) => {
    const { userId } = userIdParam.parse(req.params);
    const body = setUserAdminSchema.parse(req.body);
    const target = await loadUser(userId);
    if (!target) return reply.status(404).send({ error: "unknown_user" });
    if (target.isAdmin === body.isAdmin) return reply.status(409).send({ error: "no_change" });
    if (!body.isAdmin && target.isAdmin && !target.disabledAt && (await wouldOrphanAdmins(userId))) {
      return reply.status(409).send({
        error: "last_active_admin",
        detail: "this is the last active admin — promote another admin before demoting them",
      });
    }
    const [row] = await db
      .update(users)
      .set({ isAdmin: body.isAdmin })
      .where(eq(users.id, userId))
      .returning({ id: users.id, isAdmin: users.isAdmin });
    await auditUserAct(
      req.authCtx.userId,
      userId,
      body.isAdmin ? "user-promoted-admin" : "user-demoted-admin",
      `user '${target.email}' ${body.isAdmin ? "promoted to" : "demoted from"} admin${body.reason ? `: ${body.reason}` : ""}`,
      { phase: "admin-flag", isAdmin: body.isAdmin, ...(body.reason ? { reason: body.reason } : {}) },
    );
    return row;
  });

  // Names-only directory for the /app pickers (add a project member, name an
  // approver) — the gap slices 3–4 kept hitting: non-admins cannot read the
  // admin-only GET /v1/users, so their forms had no one to offer. This
  // exposes ids, display names, and team names ONLY — no emails, no roles,
  // no admin flags, no keys, no grants.
  app.get("/v1/users/directory", async () => {
    const [userRows, memberRows] = await Promise.all([
      db.select({ id: users.id, displayName: users.displayName }).from(users),
      db
        .select({ userId: teamMembers.userId, teamId: teamMembers.teamId, teamName: teams.name })
        .from(teamMembers)
        .innerJoin(teams, eq(teams.id, teamMembers.teamId)),
    ]);
    const teamsByUser = new Map<string, Array<{ id: string; name: string }>>();
    for (const m of memberRows) {
      const list = teamsByUser.get(m.userId) ?? [];
      list.push({ id: m.teamId, name: m.teamName });
      teamsByUser.set(m.userId, list);
    }
    return {
      users: userRows.map((u) => ({
        id: u.id,
        name: u.displayName,
        teams: teamsByUser.get(u.id) ?? [],
      })),
    };
  });

  app.post("/v1/users/:userId/keys", async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const body = createApiKeySchema.parse(req.body);
    // ADR-0022: a deactivated user cannot be handed a fresh credential — the
    // key would 401 anyway; refuse loudly instead of minting a dead secret.
    const [keyTarget] = await db
      .select({ disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, userId));
    if (keyTarget?.disabledAt) {
      return reply.status(409).send({
        error: "user_disabled",
        detail: "this account is deactivated — reactivate it before issuing keys",
      });
    }
    const { token, tokenHash } = generateToken();
    const [row] = await db
      .insert(apiKeys)
      .values({ userId, name: body.name, tokenHash })
      .returning({ id: apiKeys.id, name: apiKeys.name, createdAt: apiKeys.createdAt });
    // The plaintext token is returned exactly once and never stored.
    return reply.status(201).send({ ...row, token });
  });

  app.get("/v1/keys", async (req) => {
    const { userId } = z.object({ userId: z.string().uuid().optional() }).parse(req.query);
    const rows = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        name: apiKeys.name,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(userId ? eq(apiKeys.userId, userId) : undefined);
    return { keys: rows };
  });

  app.post("/v1/keys/:keyId/revoke", async (req, reply) => {
    const { keyId } = z.object({ keyId: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id, revokedAt: apiKeys.revokedAt });
    if (!row) return reply.status(404).send({ error: "unknown_or_already_revoked" });
    return row;
  });

  app.post("/v1/servers", async (req, reply) => {
    const body = createServerSchema.parse(req.body);
    // ADR-0043: WRITE-TIME egress check — a bad destination is an honest 400
    // at the moment somebody types it, audited, not a surprise at first tool
    // call. (Write-time is not sufficient — connectUpstream re-checks every
    // time — but it is the earliest honest failure.)
    const refusal = await refuseMcpServerWrite(db, {
      url: body.url,
      allowPrivateRanges: body.allowPrivateRanges ?? null,
      userId: req.authCtx.userId ?? null,
      phase: "registration",
      label: `MCP server '${body.name}' url`,
    });
    if (refusal) return reply.status(400).send(refusal);
    const [row] = await db.insert(mcpServers).values(body).returning();
    return reply.status(201).send(row);
  });

  /** ADR-0043: update an MCP server's destination / private-range posture.
   * Changing either re-runs the write-time egress check against the NEXT
   * values (null allowPrivateRanges restores inheritance of the org default).
   * Admin-only via the default gate, like the registry POST above. */
  app.patch("/v1/servers/:serverId", async (req, reply) => {
    const { serverId } = uuidParam.parse(req.params);
    const body = updateServerSchema.parse(req.body);
    const [before] = await db.select().from(mcpServers).where(eq(mcpServers.id, serverId));
    if (!before) return reply.status(404).send({ error: "unknown_server" });
    const nextUrl = body.url ?? before.url;
    const nextFlag =
      body.allowPrivateRanges !== undefined ? body.allowPrivateRanges : before.allowPrivateRanges;
    if (body.url !== undefined || body.allowPrivateRanges !== undefined) {
      const refusal = await refuseMcpServerWrite(db, {
        url: nextUrl,
        allowPrivateRanges: nextFlag,
        userId: req.authCtx.userId ?? null,
        serverId,
        phase: "update",
        label: `MCP server '${before.name}' url`,
      });
      if (refusal) return reply.status(400).send(refusal);
    }
    const [row] = await db
      .update(mcpServers)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.url !== undefined ? { url: body.url } : {}),
        ...(body.allowPrivateRanges !== undefined
          ? { allowPrivateRanges: body.allowPrivateRanges }
          : {}),
      })
      .where(eq(mcpServers.id, serverId))
      .returning();
    return reply.send(row);
  });

  app.get("/v1/servers", async () => ({ servers: await db.select().from(mcpServers) }));

  app.get("/v1/servers/:serverId/tools", async (req) => {
    const { serverId } = uuidParam.parse(req.params);
    return { tools: await db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)) };
  });

  app.post("/v1/servers/:serverId/tools", async (req, reply) => {
    const { serverId } = uuidParam.parse(req.params);
    const body = createToolSchema.parse(req.body);
    const [row] = await db
      .insert(mcpTools)
      .values({ serverId, name: body.name, kind: body.kind, description: body.description ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/grants/tools", async (req, reply) => {
    const body = createToolGrantSchema.parse(req.body);
    const [row] = await db.insert(toolGrants).values(body).returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/grants/servers", async (req, reply) => {
    const body = createServerGrantSchema.parse(req.body);
    const [row] = await db.insert(serverGrants).values(body).returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/users/:userId/servers/:serverId/tools", async (req, reply) => {
    const { userId, serverId } = visibleToolsParams.parse(req.params);
    // Non-admins may only view their own visible tools.
    if (!req.authCtx.isAdmin && req.authCtx.userId !== userId) {
      return reply.status(403).send({ error: "forbidden" });
    }
    const [tools, entitlements] = await Promise.all([
      db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)),
      loadEntitlements(db, userId, serverId),
    ]);
    const refs: ToolRef[] = tools.map((t) => ({ serverId: t.serverId, name: t.name, kind: t.kind }));
    return { tools: visibleTools(userId, serverId, refs, entitlements) };
  });

  // §5 roles: named entitlement bundles, admin-assignable as a user's baseline.
  app.post("/v1/roles", async (req, reply) => {
    const body = createRoleSchema.parse(req.body);
    const [row] = await db
      .insert(roles)
      .values({ name: body.name, description: body.description ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/roles", async () => {
    return { roles: await db.select().from(roles) };
  });

  app.post("/v1/roles/:roleId/grants/tools", async (req, reply) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const body = createRoleToolGrantSchema.parse(req.body);
    const [row] = await db
      .insert(roleToolGrants)
      .values({ roleId, serverId: body.serverId, toolName: body.toolName })
      .returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/roles/:roleId/grants/servers", async (req, reply) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const body = createRoleServerGrantSchema.parse(req.body);
    const [row] = await db
      .insert(roleServerGrants)
      .values({ roleId, serverId: body.serverId, readOnlyAll: body.readOnlyAll })
      .returning();
    return reply.status(201).send(row);
  });

  // §5 role-bundled AGENT/CONNECTOR grants (ADR-0014) — the agent/connector
  // twins of the MCP role-grant POSTs above. Admin-only via the default gate.
  app.post("/v1/roles/:roleId/grants/agents", async (req, reply) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const body = createRoleAgentGrantSchema.parse(req.body);
    const [row] = await db
      .insert(roleAgentGrants)
      .values({ roleId, agentId: body.agentId, allowedModes: body.allowedModes ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/roles/:roleId/grants/connectors", async (req, reply) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const body = createRoleConnectorGrantSchema.parse(req.body);
    const [row] = await db
      .insert(roleConnectorGrants)
      .values({
        roleId,
        connectorId: body.connectorId,
        mode: body.mode,
        allowedObjects: body.allowedObjects ?? null,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // §5 admin read-back: every grant this role bundles, across all four object
  // types, joined to names where useful (the role builder / access preview).
  app.get("/v1/roles/:roleId/grants", async (req) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const [tools, servers, roleAgents, roleConnectors] = await Promise.all([
      db
        .select({
          grantId: roleToolGrants.id,
          serverId: roleToolGrants.serverId,
          serverName: mcpServers.name,
          toolName: roleToolGrants.toolName,
        })
        .from(roleToolGrants)
        .leftJoin(mcpServers, eq(roleToolGrants.serverId, mcpServers.id))
        .where(eq(roleToolGrants.roleId, roleId)),
      db
        .select({
          grantId: roleServerGrants.id,
          serverId: roleServerGrants.serverId,
          serverName: mcpServers.name,
          readOnlyAll: roleServerGrants.readOnlyAll,
        })
        .from(roleServerGrants)
        .leftJoin(mcpServers, eq(roleServerGrants.serverId, mcpServers.id))
        .where(eq(roleServerGrants.roleId, roleId)),
      db
        .select({
          grantId: roleAgentGrants.id,
          agentId: roleAgentGrants.agentId,
          agentName: agents.name,
          allowedModes: roleAgentGrants.allowedModes,
        })
        .from(roleAgentGrants)
        .leftJoin(agents, eq(roleAgentGrants.agentId, agents.id))
        .where(eq(roleAgentGrants.roleId, roleId)),
      db
        .select({
          grantId: roleConnectorGrants.id,
          connectorId: roleConnectorGrants.connectorId,
          connectorName: connectors.name,
          mode: roleConnectorGrants.mode,
          allowedObjects: roleConnectorGrants.allowedObjects,
        })
        .from(roleConnectorGrants)
        .leftJoin(connectors, eq(roleConnectorGrants.connectorId, connectors.id))
        .where(eq(roleConnectorGrants.roleId, roleId)),
    ]);
    return { tools, servers, agents: roleAgents, connectors: roleConnectors };
  });

  app.delete("/v1/roles/:roleId/grants/agents/:grantId", async (req, reply) => {
    const { roleId, grantId } = z
      .object({ roleId: z.string().uuid(), grantId: z.string().uuid() })
      .parse(req.params);
    const deleted = await db
      .delete(roleAgentGrants)
      .where(and(eq(roleAgentGrants.id, grantId), eq(roleAgentGrants.roleId, roleId)))
      .returning({ id: roleAgentGrants.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_grant" });
    return { removed: true };
  });

  app.delete("/v1/roles/:roleId/grants/connectors/:grantId", async (req, reply) => {
    const { roleId, grantId } = z
      .object({ roleId: z.string().uuid(), grantId: z.string().uuid() })
      .parse(req.params);
    const deleted = await db
      .delete(roleConnectorGrants)
      .where(and(eq(roleConnectorGrants.id, grantId), eq(roleConnectorGrants.roleId, roleId)))
      .returning({ id: roleConnectorGrants.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_grant" });
    return { removed: true };
  });

  // ADR-0038: an admin assignment is always `origin='direct'` — the origin an
  // IdP reconciliation can never touch. If a group mapping also implies this
  // role the user simply holds two rows (migration 0053's UNIQUE includes
  // origin); the direct one outlives any directory change.
  app.post("/v1/users/:userId/roles", async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const body = assignRoleSchema.parse(req.body);
    const [row] = await db
      .insert(roleAssignments)
      .values({ userId, roleId: body.roleId, origin: "direct" })
      .returning();
    return reply.status(201).send(row);
  });

  app.delete("/v1/users/:userId/roles/:roleId", async (req, reply) => {
    const params = z
      .object({ userId: z.string().uuid(), roleId: z.string().uuid() })
      .parse(req.params);
    // ADR-0038: unassign removes the ADMIN-DIRECT assignment only. A
    // group-derived one is owned by the reconciler — deleting it here would be
    // undone by the holder's very next login/sync, so the honest answer is to
    // say so and point at the two things that actually work (remove the
    // mapping, or an ADR-0019 per-user revocation, which beats a role a
    // mapping keeps re-adding).
    const deleted = await db
      .delete(roleAssignments)
      .where(
        and(
          eq(roleAssignments.userId, params.userId),
          eq(roleAssignments.roleId, params.roleId),
          eq(roleAssignments.origin, "direct"),
        ),
      )
      .returning({ id: roleAssignments.id });
    const groupHeld = await db
      .select({ id: roleAssignments.id })
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.userId, params.userId),
          eq(roleAssignments.roleId, params.roleId),
          eq(roleAssignments.origin, "group"),
        ),
      );
    if (deleted.length === 0) {
      if (groupHeld.length > 0) {
        return reply.status(409).send({
          error: "role_group_derived",
          detail:
            "this role is held via an IdP group mapping, not an admin assignment — delete the group→role mapping, or add a per-user revocation (ADR-0019), which beats a group-implied role",
        });
      }
      return reply.status(404).send({ error: "not_assigned" });
    }
    return { removed: true, ...(groupHeld.length > 0 ? { stillHeldViaGroup: true } : {}) };
  });

  // ADR-0022: who holds a role — the missing read that makes assignments
  // manageable (unassign is the DELETE above; this names the holders).
  app.get("/v1/roles/:roleId/assignments", async (req) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const rows = await db
      .select({
        userId: roleAssignments.userId,
        displayName: users.displayName,
        email: users.email,
        disabledAt: users.disabledAt,
        assignedAt: roleAssignments.createdAt,
        // ADR-0038: WHY they hold it — an admin action, or an IdP group a
        // mapping names. A holder listed twice holds it both ways.
        origin: roleAssignments.origin,
      })
      .from(roleAssignments)
      .innerJoin(users, eq(users.id, roleAssignments.userId))
      .where(eq(roleAssignments.roleId, roleId));
    return { assignments: rows };
  });

  // ADR-0022: delete an unused role. A role still HELD by users is refused
  // (409 naming the holders) unless force+reason — then the deletion cascades
  // the assignments and its bundled grants, and the audit row records who
  // held it and why it went anyway.
  app.delete("/v1/roles/:roleId", async (req, reply) => {
    const { roleId } = z.object({ roleId: z.string().uuid() }).parse(req.params);
    const body = deleteRoleSchema.parse(req.body ?? {});
    const [role] = await db.select().from(roles).where(eq(roles.id, roleId));
    if (!role) return reply.status(404).send({ error: "unknown_role" });
    const holderRows = await db
      .select({ userId: roleAssignments.userId, email: users.email })
      .from(roleAssignments)
      .innerJoin(users, eq(users.id, roleAssignments.userId))
      .where(eq(roleAssignments.roleId, roleId));
    // ADR-0038: a user holding the role BOTH directly and via a group mapping
    // has two assignment rows — they are one holder, counted once.
    const holders = [...new Map(holderRows.map((h) => [h.userId, h])).values()];
    if (holders.length > 0 && !body.force) {
      return reply.status(409).send({
        error: "role_held",
        holders: holders.map((h) => h.email),
        detail: `role '${role.name}' is held by ${holders.length} user(s) — unassign them, or force-delete with a recorded reason`,
      });
    }
    if (holders.length > 0 && !body.reason?.trim()) {
      return reply.status(422).send({
        error: "force_reason_required",
        detail: "force-deleting a held role requires a recorded reason",
      });
    }
    await db.delete(roles).where(eq(roles.id, roleId));
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "role",
      objectId: roleId,
      detail: {
        phase: "role-deleted",
        name: role.name,
        holders: holders.map((h) => h.email),
        ...(body.force ? { force: true } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
      },
      effect: "allow",
      ruleId: "role-deleted",
      ruleChain: [],
      reason:
        holders.length > 0
          ? `role '${role.name}' force-deleted while held by ${holders.length} user(s): ${body.reason}`
          : `unused role '${role.name}' deleted`,
    });
    return { removed: true, unassigned: holders.length };
  });

  // ADR-0022: the MCP twins of the agent/connector role-grant DELETEs below —
  // every role grant is now removable, all four object types.
  app.delete("/v1/roles/:roleId/grants/tools/:grantId", async (req, reply) => {
    const { roleId, grantId } = z
      .object({ roleId: z.string().uuid(), grantId: z.string().uuid() })
      .parse(req.params);
    const deleted = await db
      .delete(roleToolGrants)
      .where(and(eq(roleToolGrants.id, grantId), eq(roleToolGrants.roleId, roleId)))
      .returning({ id: roleToolGrants.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_grant" });
    return { removed: true };
  });

  app.delete("/v1/roles/:roleId/grants/servers/:grantId", async (req, reply) => {
    const { roleId, grantId } = z
      .object({ roleId: z.string().uuid(), grantId: z.string().uuid() })
      .parse(req.params);
    const deleted = await db
      .delete(roleServerGrants)
      .where(and(eq(roleServerGrants.id, grantId), eq(roleServerGrants.roleId, roleId)))
      .returning({ id: roleServerGrants.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_grant" });
    return { removed: true };
  });

  // §5 subtractive override: revoke a role-derived entitlement for one user.
  // Deleting the revocation reverses it — overrides are independently reversible.
  app.post("/v1/revocations", async (req, reply) => {
    const body = createRevocationSchema.parse(req.body);
    const [row] = await db
      .insert(revocations)
      .values({ userId: body.userId, serverId: body.serverId, toolName: body.toolName ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.delete("/v1/revocations/:revocationId", async (req, reply) => {
    const { revocationId } = z.object({ revocationId: z.string().uuid() }).parse(req.params);
    const deleted = await db
      .delete(revocations)
      .where(eq(revocations.id, revocationId))
      .returning({ id: revocations.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_revocation" });
    return { removed: true };
  });

  // --- ADR-0019: per-user AGENT / CONNECTOR revocations -------------------
  // Pillar 1 promises "role builder + per-user override". Role-bundled agent
  // and connector grants (ADR-0014) composed additively with no way to subtract
  // one object from one user — an admin could only unassign the whole role.
  // These four writes close that hole. Admin-only (deliberately NOT in
  // NON_ADMIN_ROUTES): a subtractive override on someone else's entitlement is
  // an administrative act. Deleting the row reverses it, exactly like the MCP
  // revocation routes above. The kernel consults revocations on the allow path
  // ONLY, so creating one can never grant anything.

  const revocationUserParam = z.object({ userId: z.string().uuid() });
  const revocationIdParams = z.object({
    userId: z.string().uuid(),
    revocationId: z.string().uuid(),
  });

  app.post("/v1/users/:userId/revocations/agents", async (req, reply) => {
    const { userId } = revocationUserParam.parse(req.params);
    const body = createAgentRevocationSchema.parse(req.body);
    const [row] = await db
      .insert(agentRevocations)
      .values({ userId, agentId: body.agentId, reason: body.reason ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/users/:userId/revocations/agents", async (req) => {
    const { userId } = revocationUserParam.parse(req.params);
    const rows = await db
      .select({
        id: agentRevocations.id,
        userId: agentRevocations.userId,
        agentId: agentRevocations.agentId,
        agentName: agents.name,
        reason: agentRevocations.reason,
        createdAt: agentRevocations.createdAt,
      })
      .from(agentRevocations)
      .innerJoin(agents, eq(agentRevocations.agentId, agents.id))
      .where(eq(agentRevocations.userId, userId));
    return { revocations: rows };
  });

  app.delete("/v1/users/:userId/revocations/agents/:revocationId", async (req, reply) => {
    const { userId, revocationId } = revocationIdParams.parse(req.params);
    const deleted = await db
      .delete(agentRevocations)
      .where(and(eq(agentRevocations.id, revocationId), eq(agentRevocations.userId, userId)))
      .returning({ id: agentRevocations.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_revocation" });
    return { removed: true };
  });

  app.post("/v1/users/:userId/revocations/connectors", async (req, reply) => {
    const { userId } = revocationUserParam.parse(req.params);
    const body = createConnectorRevocationSchema.parse(req.body);
    const [row] = await db
      .insert(connectorRevocations)
      .values({ userId, connectorId: body.connectorId, reason: body.reason ?? null })
      .returning();
    return reply.status(201).send(row);
  });

  app.get("/v1/users/:userId/revocations/connectors", async (req) => {
    const { userId } = revocationUserParam.parse(req.params);
    const rows = await db
      .select({
        id: connectorRevocations.id,
        userId: connectorRevocations.userId,
        connectorId: connectorRevocations.connectorId,
        connectorName: connectors.name,
        reason: connectorRevocations.reason,
        // O9 (ADR-0027): the current scope, so a UI can SHOW what it is about
        // to narrow/restore rather than editing blind. Additive projection —
        // 'full' is the column default, so every pre-0045 row reads as full.
        scope: connectorRevocations.scope,
        createdAt: connectorRevocations.createdAt,
      })
      .from(connectorRevocations)
      .innerJoin(connectors, eq(connectorRevocations.connectorId, connectors.id))
      .where(eq(connectorRevocations.userId, userId));
    return { revocations: rows };
  });

  app.delete("/v1/users/:userId/revocations/connectors/:revocationId", async (req, reply) => {
    const { userId, revocationId } = revocationIdParams.parse(req.params);
    const deleted = await db
      .delete(connectorRevocations)
      .where(
        and(eq(connectorRevocations.id, revocationId), eq(connectorRevocations.userId, userId)),
      )
      .returning({ id: connectorRevocations.id });
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_revocation" });
    return { removed: true };
  });

  // §5 override-visibility view: every entitlement with its source (direct
  // vs role) and any revocation flagged — deviations from role defaults are
  // visible, not silent.
  app.get("/v1/users/:userId/servers/:serverId/entitlements", async (req) => {
    const { userId, serverId } = visibleToolsParams.parse(req.params);
    const [entitlements, roleRows, serverTools] = await Promise.all([
      loadEntitlements(db, userId, serverId),
      db.select().from(roles),
      db.select().from(mcpTools).where(eq(mcpTools.serverId, serverId)),
    ]);
    const toolKindByName = new Map(serverTools.map((t) => [t.name, t.kind]));
    const roleName = (roleId: string) => roleRows.find((r) => r.id === roleId)?.name ?? roleId;
    const revocationFor = (toolName: string | null) =>
      entitlements.revocations?.find((r) => r.toolName === null || r.toolName === toolName);

    const entries = [
      ...entitlements.toolGrants.map((g) => ({
        kind: "tool" as const,
        toolName: g.toolName,
        source: "direct" as const,
        grantId: g.id,
      })),
      ...entitlements.serverGrants
        .filter((g) => g.readOnlyAll)
        .map((g) => ({
          kind: "server-read-only" as const,
          toolName: null,
          source: "direct" as const,
          grantId: g.id,
        })),
      ...(entitlements.roleToolGrants ?? []).map((g) => {
        const rev = revocationFor(g.toolName);
        return {
          kind: "tool" as const,
          toolName: g.toolName,
          source: "role" as const,
          role: roleName(g.roleId),
          roleId: g.roleId,
          grantId: g.id,
          revoked: Boolean(rev),
          ...(rev ? { revocationId: rev.id } : {}),
        };
      }),
      ...(entitlements.roleServerGrants ?? [])
        .filter((g) => g.readOnlyAll)
        .map((g) => {
          const rev = revocationFor(null);
          // Tool-scoped revocations also carve tools out of a role
          // read-only-all grant (the kernel enforces this); flag them here so
          // the deviation is visible, not silent (§5).
          const roleToolNames = new Set(
            (entitlements.roleToolGrants ?? []).map((g) => g.toolName),
          );
          // Only read-kind tools that exist on the server were ever conferred
          // by read-only-all, so only those are genuine carve-outs of it.
          const carveOuts = (entitlements.revocations ?? [])
            .filter(
              (r) =>
                r.toolName !== null &&
                !roleToolNames.has(r.toolName) &&
                toolKindByName.get(r.toolName) === "read",
            )
            .map((r) => ({ toolName: r.toolName, revocationId: r.id }));
          return {
            kind: "server-read-only" as const,
            toolName: null,
            source: "role" as const,
            role: roleName(g.roleId),
            roleId: g.roleId,
            grantId: g.id,
            revoked: Boolean(rev),
            ...(rev ? { revocationId: rev.id } : {}),
            ...(carveOuts.length > 0 ? { revokedTools: carveOuts } : {}),
          };
        }),
    ];
    // Every active revocation, so overrides are discoverable and reversible
    // via DELETE /v1/revocations/:id even when no grant currently matches.
    return { entitlements: entries, revocations: entitlements.revocations ?? [] };
  });

  app.get("/v1/revocations", async (req) => {
    const query = z
      .object({ userId: z.string().uuid().optional(), serverId: z.string().uuid().optional() })
      .parse(req.query);
    const conditions = [
      query.userId ? eq(revocations.userId, query.userId) : undefined,
      query.serverId ? eq(revocations.serverId, query.serverId) : undefined,
    ].filter((c) => c !== undefined);
    const rows = await db
      .select()
      .from(revocations)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    return { revocations: rows };
  });

  app.post("/v1/evaluate", async (req, reply) => {
    const body = evaluateRequestSchema.parse(req.body);

    const [tool] = await db
      .select()
      .from(mcpTools)
      .where(and(eq(mcpTools.serverId, body.serverId), eq(mcpTools.name, body.toolName)));
    if (!tool) {
      return reply.status(404).send({ error: "unknown_tool" });
    }

    // Full governed evaluation, but decision-only: unlike the proxy path this
    // endpoint never creates queue entries or consumes approvals.
    const { decision } = await governedEvaluate(
      db,
      body.userId,
      body.serverId,
      { serverId: tool.serverId, name: tool.name, kind: tool.kind },
      undefined,
      null,
      // ADR-0019 A4 attribution: this preview endpoint names no project.
      null,
      // ADR-0040: the ADMIN's own session facts are NOT the subject's — this
      // endpoint previews a decision for `body.userId`, who may not be the
      // caller, so the principal's session attributes are honestly unknown
      // here. /v1/abac/simulate is where a hypothetical session can be named.
      undefined,
    );

    await db.insert(auditLog).values({
      userId: body.userId,
      serverId: body.serverId,
      toolName: body.toolName,
      effect: decision.effect,
      ruleId: decision.ruleId,
      ruleChain: decision.ruleChain,
      reason: decision.reason,
    });

    return decision;
  });

  app.get("/v1/rules/approvals", async () => ({
    rules: await db.select().from(approvalRules),
  }));
  app.get("/v1/rules/data-scopes", async () => ({
    rules: await db.select().from(dataScopeRules),
  }));
  app.get("/v1/rules/rate-limits", async () => ({
    rules: await db.select().from(rateLimits),
  }));

  // PILLAR 1 rule scoping: the discriminant is already validated by the shared
  // superRefine (mirrors the DB CHECK). We null out every off-scope subject/
  // server field so the row is clean and the DB CHECK always passes — a
  // role-scoped rule stores only roleId, a fleet rule stores none, an
  // all-servers rule stores no serverId.
  const scopedRuleColumns = (body: {
    scope: "user" | "role" | "team" | "fleet";
    serverScope: "server" | "all";
    userId?: string | null;
    roleId?: string | null;
    teamId?: string | null;
    serverId?: string | null;
  }) => ({
    scope: body.scope,
    serverScope: body.serverScope,
    userId: body.scope === "user" ? body.userId! : null,
    roleId: body.scope === "role" ? body.roleId! : null,
    teamId: body.scope === "team" ? body.teamId! : null,
    serverId: body.serverScope === "server" ? body.serverId! : null,
  });

  app.post("/v1/rules/approvals", async (req, reply) => {
    const body = createApprovalRuleSchema.parse(req.body);
    const [row] = await db
      .insert(approvalRules)
      .values({
        ...scopedRuleColumns(body),
        toolName: body.toolName ?? null,
        writeOnly: body.writeOnly ?? false,
        approverUserId: body.approverUserId,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/rules/data-scopes", async (req, reply) => {
    const body = createDataScopeRuleSchema.parse(req.body);
    const [row] = await db
      .insert(dataScopeRules)
      .values({
        ...scopedRuleColumns(body),
        toolName: body.toolName ?? null,
        argPath: body.argPath,
        allowedValues: body.allowedValues,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.post("/v1/rules/rate-limits", async (req, reply) => {
    const body = createRateLimitSchema.parse(req.body);
    const [row] = await db
      .insert(rateLimits)
      .values({
        ...scopedRuleColumns(body),
        toolName: body.toolName ?? null,
        maxCalls: body.maxCalls,
        windowSeconds: body.windowSeconds,
      })
      .returning();
    return reply.status(201).send(row);
  });

  // --- ADR-0022 approver delegation (admin-managed) -------------------------
  // A delegation is a WINDOW: while active, every PENDING approval naming
  // from_user ALSO appears in to_user's inbox and to_user may decide it — the
  // decision records the real decider plus an on-behalf-of audit row. The org
  // master switch (org_settings.approval_delegation_enabled) turns the whole
  // mechanism off for strict separation-of-duties orgs.

  app.post("/v1/delegations", async (req, reply) => {
    const body = createDelegationSchema.parse(req.body);
    const org = await loadOrgSettings(db);
    if (!org.approvalDelegationEnabled) {
      return reply.status(409).send({
        error: "delegation_disabled",
        detail: "approver delegation is disabled for this organization (org settings)",
      });
    }
    const named = await db
      .select({ id: users.id, disabledAt: users.disabledAt })
      .from(users)
      .where(inArray(users.id, [body.fromUserId, body.toUserId]));
    if (named.length !== 2) return reply.status(422).send({ error: "unknown_user" });
    // delegating TO a deactivated user creates an inbox no one can open
    const to = named.find((u) => u.id === body.toUserId);
    if (to?.disabledAt) {
      return reply.status(422).send({ error: "delegate_disabled", detail: "the delegate account is deactivated" });
    }
    const [row] = await db
      .insert(approvalDelegations)
      .values({
        fromUserId: body.fromUserId,
        toUserId: body.toUserId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        reason: body.reason ?? null,
        createdBy: req.authCtx.userId,
      })
      .returning();
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "approval_delegation",
      objectId: row!.id,
      detail: {
        phase: "delegation-created",
        fromUserId: body.fromUserId,
        toUserId: body.toUserId,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        ...(body.reason ? { reason: body.reason } : {}),
      },
      effect: "allow",
      ruleId: "approval-delegation-created",
      ruleChain: [],
      reason: `approval delegation created (${body.startsAt.toISOString()} → ${body.endsAt.toISOString()})${body.reason ? `: ${body.reason}` : ""}`,
    });
    return reply.status(201).send(row);
  });

  app.get("/v1/delegations", async () => {
    const rows = await db.select().from(approvalDelegations);
    const ids = [...new Set(rows.flatMap((r) => [r.fromUserId, r.toUserId]))];
    const userRows = ids.length
      ? await db
          .select({ id: users.id, displayName: users.displayName, email: users.email })
          .from(users)
          .where(inArray(users.id, ids))
      : [];
    const nameOf = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));
    const now = Date.now();
    return {
      delegations: rows.map((r) => ({
        ...r,
        fromName: nameOf.get(r.fromUserId) ?? null,
        toName: nameOf.get(r.toUserId) ?? null,
        active: r.startsAt.getTime() <= now && now < r.endsAt.getTime(),
      })),
    };
  });

  app.delete("/v1/delegations/:delegationId", async (req, reply) => {
    const { delegationId } = z.object({ delegationId: z.string().uuid() }).parse(req.params);
    const deleted = await db
      .delete(approvalDelegations)
      .where(eq(approvalDelegations.id, delegationId))
      .returning();
    if (deleted.length === 0) return reply.status(404).send({ error: "unknown_delegation" });
    await db.insert(auditLog).values({
      userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000",
      objectType: "approval_delegation",
      objectId: delegationId,
      detail: { phase: "delegation-ended", fromUserId: deleted[0]!.fromUserId, toUserId: deleted[0]!.toUserId },
      effect: "allow",
      ruleId: "approval-delegation-ended",
      ruleChain: [],
      reason: "approval delegation ended by an admin",
    });
    return { removed: true };
  });

  // §6 Approvals Queue — one inbox for every paused call. Admins see all;
  // a non-admin sees exactly the approvals naming them as approver — PLUS,
  // while a delegation window to them is active (ADR-0022), the pending
  // approvals of their delegator(s), marked delegatedFrom.
  app.get("/v1/approvals", async (req) => {
    const { status } = z
      .object({ status: z.enum(["pending", "approved", "denied", "consumed", "superseded"]).optional() })
      .parse(req.query);
    // ADR-0022 delegation widening: a non-admin sees their own rows PLUS the
    // PENDING rows of anyone actively delegating to them (pending only — a
    // delegate covers live decisions, they don't inherit the archive).
    const me = req.authCtx.userId ?? "";
    const delegators = !req.authCtx.isAdmin && me ? await activeDelegatorsFor(db, me) : [];

    // ADR-0046 — THE LAZY HALF OF THE WORKBENCH, and the reason this queue does
    // not need a scheduler it does not have.
    //
    // Before the visibility query runs, every PENDING approval is materialized
    // against the routing rules and its SLA is evaluated. Two consequences:
    //   - a role/team-routed approval acquires its assignment, which is what
    //     makes it visible to that role's members below (a routed approval that
    //     only becomes visible after someone already saw it would be useless);
    //   - a breach that came due while nobody was looking is detected and
    //     escalated NOW, at the first read, with the deadlines recomputed from
    //     `requested_at` so the result is what a timer would have produced.
    //
    // Guarded by `routingActive`: with no enabled rule — the shipped state —
    // this whole block is one COUNT and the queue behaves exactly as it did
    // before migration 0058, writing nothing.
    const workbenchOn = await routingActive(db);
    if (workbenchOn) {
      const pendingAll = await db.select().from(approvals).where(eq(approvals.status, "pending"));
      await materializeAndEvaluate(db, pendingAll, me || null);
    }
    // ADR-0046 §1: routing decides WHOSE QUEUE a row shows in. A non-admin
    // therefore also sees the rows assigned (or escalated) to a role or team
    // they belong to — still not a widening of who may DECIDE, which the decide
    // path re-checks against `approverUserId` independently.
    const assignedIds = workbenchOn && !req.authCtx.isAdmin && me ? await assignedApprovalIdsFor(db, me) : [];
    const scopeCondition = req.authCtx.isAdmin
      ? undefined
      : or(
          ...[
            eq(approvals.approverUserId, me),
            ...(delegators.length
              ? [and(inArray(approvals.approverUserId, delegators), eq(approvals.status, "pending"))]
              : []),
            ...(assignedIds.length ? [inArray(approvals.id, assignedIds)] : []),
          ],
        );
    const conditions = [status ? eq(approvals.status, status) : undefined, scopeCondition].filter(
      (c) => c !== undefined,
    );
    const rows = await db
      .select()
      .from(approvals)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(approvals.requestedAt))
      .limit(100);
    const assignmentRows = rows.length
      ? await db
          .select()
          .from(approvalAssignments)
          .where(
            inArray(
              approvalAssignments.approvalId,
              rows.map((r) => r.id),
            ),
          )
      : [];
    const assignmentFor = new Map(assignmentRows.map((a) => [a.approvalId, a]));
    // Display enrichment — purely additive to the row shape: names for the
    // requester/approver/decider and a label for the governed object, so the
    // inbox and queue can say WHO asked and WHAT is governed without the
    // admin-only user list.
    const ids = (xs: Array<string | null>) => [...new Set(xs.filter((x): x is string => x !== null))];
    // §9 context conflicts: the arbiter decides between two TEXTS, so their
    // inbox row must carry both sides — the retained conflicting revision and
    // the currently accepted one — not just an object label.
    const CONFLICT_PREFIX = "__context_conflict__:";
    const conflictItemIds = ids(
      rows.map((r) =>
        r.stageId?.startsWith(CONFLICT_PREFIX) ? r.stageId.slice(CONFLICT_PREFIX.length) : null,
      ),
    );
    const conflictItems = conflictItemIds.length
      ? await db
          .select()
          .from(projectContextItems)
          .where(inArray(projectContextItems.id, conflictItemIds))
      : [];
    const acceptedCounterparts = conflictItems.length
      ? await db
          .select()
          .from(projectContextItems)
          .where(
            and(
              inArray(projectContextItems.projectId, ids(conflictItems.map((i) => i.projectId))),
              inArray(projectContextItems.key, [...new Set(conflictItems.map((i) => i.key))]),
              eq(projectContextItems.accepted, true),
            ),
          )
      : [];
    const currentFor = (item: (typeof conflictItems)[number]) =>
      acceptedCounterparts
        .filter((c) => c.projectId === item.projectId && c.key === item.key && c.id !== item.id)
        .reduce<(typeof acceptedCounterparts)[number] | null>(
          (m, c) => (m === null || c.revision > m.revision ? c : m),
          null,
        );
    const conflictByItemId = new Map(conflictItems.map((i) => [i.id, i]));
    const userIds = ids(
      rows
        .flatMap((r) => [r.userId, r.approverUserId, r.decidedBy])
        .concat(conflictItems.map((i) => i.contributedByUserId))
        .concat(acceptedCounterparts.map((c) => c.contributedByUserId)),
    );
    const instanceIds = ids(rows.map((r) => r.instanceId));
    const runIds = ids(rows.map((r) => r.runId));
    const projectIds = ids(rows.map((r) => r.projectId));
    const [userRows, instanceRows, runRows, projectRows] = await Promise.all([
      userIds.length
        ? db
            .select({ id: users.id, displayName: users.displayName, email: users.email })
            .from(users)
            .where(inArray(users.id, userIds))
        : [],
      instanceIds.length
        ? db
            .select({ id: workflowInstances.id, change: workflowInstances.change })
            .from(workflowInstances)
            .where(inArray(workflowInstances.id, instanceIds))
        : [],
      runIds.length
        ? db
            .select({ id: orchestrationRuns.id, name: orchestrationRuns.name })
            .from(orchestrationRuns)
            .where(inArray(orchestrationRuns.id, runIds))
        : [],
      projectIds.length
        ? db
            .select({ id: projects.id, name: projects.name })
            .from(projects)
            .where(inArray(projects.id, projectIds))
        : [],
    ]);
    const nameOf = new Map(userRows.map((u) => [u.id, u.displayName || u.email]));
    const instanceLabel = new Map(
      instanceRows.map((i) => [i.id, (i.change as { description?: string } | null)?.description ?? null]),
    );
    const runLabel = new Map(runRows.map((r) => [r.id, r.name]));
    const projectLabel = new Map(projectRows.map((p) => [p.id, p.name]));
    // ADR-0022 UX: infra_operation rows finally say WHAT they govern. Their
    // stageId sentinel carries the finding/ledger id — resolve it to the
    // resource plus a one-line finding/action summary, same enrichment
    // discipline as the workflow/run/project labels above.
    const REMEDIATION_PREFIX = "__infra_remediation__:";
    const ACTION_PREFIX = "__infra_action__:";
    const uuidOk = (s: string) => UUID_ANY_RE.test(s);
    const findingIds = ids(
      rows.map((r) =>
        r.stageId?.startsWith(REMEDIATION_PREFIX) && uuidOk(r.stageId.slice(REMEDIATION_PREFIX.length))
          ? r.stageId.slice(REMEDIATION_PREFIX.length)
          : null,
      ),
    );
    const actionRef = (stageId: string | null) => {
      if (!stageId?.startsWith(ACTION_PREFIX)) return null;
      const rest = stageId.slice(ACTION_PREFIX.length);
      const sep = rest.indexOf(":");
      if (sep < 0) return null;
      const ref = { action: rest.slice(0, sep), id: rest.slice(sep + 1) };
      return uuidOk(ref.id) ? ref : null;
    };
    const actionRefs = rows.map((r) => actionRef(r.stageId)).filter((x): x is { action: string; id: string } => x !== null);
    const certIds = ids(actionRefs.map((a) => (a.action === "cert_rotate" ? a.id : null)));
    const patchIds = ids(actionRefs.map((a) => (a.action === "patch_apply" ? a.id : null)));
    const backupIds = ids(actionRefs.map((a) => (a.action === "backup_restore" ? a.id : null)));
    const [findingRows, certRows, patchRows, backupRows] = await Promise.all([
      findingIds.length ? db.select().from(infraFindings).where(inArray(infraFindings.id, findingIds)) : [],
      certIds.length ? db.select().from(certInventory).where(inArray(certInventory.id, certIds)) : [],
      patchIds.length ? db.select().from(patchRecords).where(inArray(patchRecords.id, patchIds)) : [],
      backupIds.length ? db.select().from(backupRuns).where(inArray(backupRuns.id, backupIds)) : [],
    ]);
    const resourceIds = ids([
      ...findingRows.map((f) => f.resourceId),
      ...certRows.map((c) => c.resourceId),
      ...patchRows.map((p) => p.resourceId),
      ...backupRows.map((b) => b.resourceId),
    ]);
    const resourceRows = resourceIds.length
      ? await db
          .select({ id: infraResources.id, name: infraResources.name })
          .from(infraResources)
          .where(inArray(infraResources.id, resourceIds))
      : [];
    const resourceName = new Map(resourceRows.map((r) => [r.id, r.name]));
    const findingById = new Map(findingRows.map((f) => [f.id, f]));
    const certById = new Map(certRows.map((c) => [c.id, c]));
    const patchById = new Map(patchRows.map((p) => [p.id, p]));
    const backupById = new Map(backupRows.map((b) => [b.id, b]));
    const infraLabelFor = (stageId: string | null): string | null => {
      if (stageId?.startsWith(REMEDIATION_PREFIX)) {
        const f = findingById.get(stageId.slice(REMEDIATION_PREFIX.length));
        if (!f) return null;
        const summary = (f.detail as { summary?: string } | null)?.summary;
        return `${resourceName.get(f.resourceId) ?? "resource"} · ${f.kind} (${f.severity})${summary ? ` — ${summary}` : ""}`;
      }
      const ref = actionRef(stageId ?? null);
      if (!ref) return null;
      if (ref.action === "cert_rotate") {
        const c = certById.get(ref.id);
        return c ? `${resourceName.get(c.resourceId) ?? "resource"} · rotate cert ${c.commonName}` : null;
      }
      if (ref.action === "patch_apply") {
        const p = patchById.get(ref.id);
        return p ? `${resourceName.get(p.resourceId) ?? "resource"} · patch ${p.cve} (${p.severity})` : null;
      }
      if (ref.action === "backup_restore") {
        const b = backupById.get(ref.id);
        return b ? `${resourceName.get(b.resourceId) ?? "resource"} · restore ${b.kind} (${b.status})` : null;
      }
      return null;
    };
    // ADR-0045: an MRM sign-off row carries its card id in the same `stageId`
    // sentinel slot the infra/conflict rows use — no new column on `approvals`,
    // because MRM riding the ONE queue is the whole point.
    const MODEL_CARD_PREFIX = "__model_card__:";
    const modelCardIds = ids(
      rows.map((r) =>
        r.stageId?.startsWith(MODEL_CARD_PREFIX) && uuidOk(r.stageId.slice(MODEL_CARD_PREFIX.length))
          ? r.stageId.slice(MODEL_CARD_PREFIX.length)
          : null,
      ),
    );
    const modelCardRows = modelCardIds.length
      ? await db.select().from(modelCards).where(inArray(modelCards.id, modelCardIds))
      : [];
    const modelCardAgentIds = ids(modelCardRows.map((c) => c.agentId));
    const modelCardAgentRows = modelCardAgentIds.length
      ? await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, modelCardAgentIds))
      : [];
    const modelCardAgentName = new Map(modelCardAgentRows.map((a) => [a.id, a.name]));
    const modelCardById = new Map(modelCardRows.map((c) => [c.id, c]));
    const modelCardLabelFor = (stageId: string | null): string | null => {
      if (!stageId?.startsWith(MODEL_CARD_PREFIX)) return null;
      const card = modelCardById.get(stageId.slice(MODEL_CARD_PREFIX.length));
      if (!card) return null;
      const subject = card.agentId
        ? (modelCardAgentName.get(card.agentId) ?? "agent")
        : "custom provider";
      return `model risk sign-off · ${subject} · ${card.intendedUse}`;
    };
    const delegatedFor = new Set(delegators);
    const contextConflictFor = (r: (typeof rows)[number]) => {
      if (!r.stageId?.startsWith(CONFLICT_PREFIX)) return {};
      const item = conflictByItemId.get(r.stageId.slice(CONFLICT_PREFIX.length));
      if (!item) return {};
      const current = currentFor(item);
      const side = (i: NonNullable<typeof current>) => ({
        revision: i.revision,
        baseRevision: i.baseRevision,
        content: i.content,
        byName: nameOf.get(i.contributedByUserId) ?? null,
        at: i.createdAt,
      });
      return {
        contextConflict: {
          key: item.key,
          conflicting: side(item),
          current: current ? side(current) : null,
        },
      };
    };
    return {
      approvals: rows.map((r) => ({
        ...r,
        // Finding-6 separation-of-duties surface: the approver IS the user
        // who triggered the governed action — the UI badges it, deciding it
        // requires a recorded reason.
        selfReview: r.userId === r.approverUserId,
        requestedByName: nameOf.get(r.userId) ?? null,
        approverName: nameOf.get(r.approverUserId) ?? null,
        decidedByName: r.decidedBy ? (nameOf.get(r.decidedBy) ?? null) : null,
        objectLabel:
          (r.instanceId ? instanceLabel.get(r.instanceId) : null) ??
          (r.runId ? runLabel.get(r.runId) : null) ??
          (r.projectId ? projectLabel.get(r.projectId) : null) ??
          (r.objectType === "infra_operation" ? infraLabelFor(r.stageId) : null) ??
          (r.objectType === "model_card" ? modelCardLabelFor(r.stageId) : null) ??
          r.toolName ??
          null,
        // ADR-0022: this row reached the caller via an active delegation —
        // the UI badges it and the decide endpoint records on-behalf-of.
        ...(r.approverUserId !== me && delegatedFor.has(r.approverUserId)
          ? { delegatedFrom: nameOf.get(r.approverUserId) ?? r.approverUserId }
          : {}),
        // ADR-0046: the routing + SLA sidecar, purely additive. Absent when no
        // routing rule is enabled, so a pre-0058 client sees the identical shape.
        ...(assignmentFor.has(r.id)
          ? {
              assignment: (() => {
                const a = assignmentFor.get(r.id)!;
                return {
                  assigneeKind: a.assigneeKind,
                  assigneeId: a.assigneeId,
                  ruleId: a.ruleId,
                  quorum: a.quorum,
                  claimedByUserId: a.claimedByUserId,
                  claimable:
                    a.assigneeKind !== "user" && a.claimedByUserId === null && r.status === "pending",
                  slaState: a.slaState,
                  warnAt: a.warnAt,
                  dueAt: a.dueAt,
                  breachedAt: a.breachedAt,
                  escalatedAt: a.escalatedAt,
                  escalationAssigneeKind: a.escalationAssigneeKind,
                  escalationAssigneeId: a.escalationAssigneeId,
                };
              })(),
            }
          : {}),
        ...contextConflictFor(r),
      })),
    };
  });

  /**
   * THE ONE DECIDE PATH (ADR-0046).
   *
   * Extracted from the route handler so that the BULK endpoint can call the
   * exact same function rather than reimplementing "approve an approval".
   * Every guard below — bootstrap-cannot-decide, unknown, superseded,
   * not-the-named-approver, the ADR-0022 delegation widening, the admin
   * override with its required reason, the self-review reason, the single
   * transaction with its downstream workflow/run/project/infra/model-card
   * hooks, the post-commit execution and the PM mirror — therefore applies
   * IDENTICALLY to a bulk item and to a single decision.
   *
   * This is the property ADR-0046 §4 turns on: a bulk action is N recorded
   * decisions through one path, never one opaque event on a shortcut path. If
   * a future change adds a check here, bulk inherits it for free; there is no
   * second place to remember.
   */
  async function decideOneApproval(input: {
    approvalId: string;
    deciderUserId: string | null;
    isAdmin: boolean;
    body: z.infer<typeof decideApprovalSchema>;
  }): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> }> {
    const fail = (status: number, payload: Record<string, unknown>) =>
      ({ ok: false as const, status, body: payload });
    // The decider is the authenticated identity — a body-supplied id would be
    // trivially spoofable. The bootstrap token has no identity and cannot decide.
    const deciderUserId = input.deciderUserId;
    if (!deciderUserId) return fail(403, { error: "bootstrap_cannot_decide" });
    const { approvalId, isAdmin } = input;
    const body = input.body;

    const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
    if (!row) return fail(404, { error: "unknown_approval" });
    // ADR-0046: the OTHER lazy evaluation point. Deciding an approval that came
    // due while nobody was looking must still record the breach — otherwise a
    // queue that is only ever touched by a decision would never register one.
    // Evaluating BEFORE the decision is deliberate: the breach is a fact about
    // the wait, and it happened whether or not the decision now clears it.
    if (row.status === "pending" && (await routingActive(db))) {
      const assignment = await ensureAssignment(db, row, deciderUserId);
      if (assignment) await evaluateAssignmentSla(db, row, assignment);
    }
    // A superseded gate is dead, not decidable: its node was reassigned or
    // retried, its run turned terminal, or a newer artifact re-opened the
    // stage. Refuse loudly instead of accepting a decision about nothing.
    if (row.status === "superseded") {
      return fail(409, {
        error: "approval_superseded",
        detail: "this approval was superseded (its node, run, or stage moved on) and can no longer be decided",
      });
    }
    // Only the rule's named approver may decide (§3) — with two sanctioned
    // widenings: (a) ADR-0022 delegation — an ACTIVE delegation window from
    // the named approver lets the delegate decide, recorded as the real
    // decider acting on-behalf-of; (b) an org ADMIN may decide in the
    // approver's place to unblock a stuck queue, but only with a recorded
    // reason, audit-marked as the override it is.
    const delegation =
      row.approverUserId !== deciderUserId
        ? await activeDelegationFrom(db, row.approverUserId, deciderUserId)
        : null;
    const adminOverride = row.approverUserId !== deciderUserId && !delegation;
    if (adminOverride) {
      if (!isAdmin) {
        return fail(403, { error: "not_the_named_approver" });
      }
      if (!body.reason?.trim()) {
        return fail(422, {
          error: "override_reason_required",
          detail: "an admin deciding in place of the named approver must record a reason",
        });
      }
    }
    // Separation-of-duties guard: the named approver IS the user who
    // triggered the governed action. Still decidable (alternate-approver
    // routing is deliberately out of scope) but never silently — a recorded
    // reason is required and the audit row is stamped selfReview.
    const selfReview = row.userId === row.approverUserId;
    if (selfReview && !body.reason?.trim()) {
      return fail(400, {
        error: "self_review_reason_required",
        detail: "this is a self-review (the approver is the requesting user); deciding it requires a recorded reason",
      });
    }

    // ONE transaction: the decision write and the run/workflow/project event
    // it causes commit or roll back together — a downstream invalid-state 409
    // can never leave a silently persisted decision behind. Post-commit
    // execution (git stages, nested-run completion) and the PM mirror run
    // only after the decision is durable.
    const outcome = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(approvals)
        .set({
          status: body.decision,
          decidedBy: deciderUserId,
          decidedAt: new Date(),
          decisionReason: body.reason ?? null,
        })
        .where(and(eq(approvals.id, approvalId), eq(approvals.status, "pending")))
        .returning();
      if (!updated) return { updated: null, postCommit: null };
      if (adminOverride) {
        await tx.insert(auditLog).values({
          userId: deciderUserId,
          objectType: updated.objectType,
          objectId: updated.instanceId ?? updated.runId ?? updated.projectId ?? null,
          serverId: updated.serverId,
          toolName: updated.toolName,
          detail: {
            approvalId: updated.id,
            adminOverride: true,
            namedApproverUserId: row.approverUserId,
            decision: body.decision,
            stageId: updated.stageId,
          },
          effect: body.decision === "approved" ? "allow" : "deny",
          ruleId: "approval-admin-override",
          ruleChain: [],
          reason: `admin decided in place of the named approver: ${body.reason}`,
        });
      }
      if (selfReview) {
        await tx.insert(auditLog).values({
          userId: deciderUserId,
          objectType: updated.objectType,
          objectId: updated.instanceId ?? updated.runId ?? updated.projectId ?? null,
          serverId: updated.serverId,
          toolName: updated.toolName,
          detail: {
            approvalId: updated.id,
            selfReview: true,
            decision: body.decision,
            stageId: updated.stageId,
          },
          effect: body.decision === "approved" ? "allow" : "deny",
          ruleId: "approval-self-review",
          ruleChain: [],
          reason: `self-review: the approver is the requesting user; decided with recorded reason: ${body.reason}`,
        });
      }
      // ADR-0022: a delegated decision audits BOTH sides — decidedBy already
      // records the REAL decider on the approval row; this row records that
      // it was on-behalf-of the named approver, under which delegation.
      if (delegation) {
        await tx.insert(auditLog).values({
          userId: deciderUserId,
          objectType: updated.objectType,
          objectId: updated.instanceId ?? updated.runId ?? updated.projectId ?? null,
          serverId: updated.serverId,
          toolName: updated.toolName,
          detail: {
            approvalId: updated.id,
            delegated: true,
            onBehalfOfUserId: row.approverUserId,
            delegationId: delegation.id,
            decision: body.decision,
            stageId: updated.stageId,
          },
          effect: body.decision === "approved" ? "allow" : "deny",
          ruleId: "approval-delegated-decision",
          ruleChain: [],
          reason: `decided on behalf of the named approver under an active delegation${delegation.reason ? ` (${delegation.reason})` : ""}`,
        });
      }
      let postCommit: ((d: Db) => Promise<void>) | null = null;
      // Workflow sign-offs advance their instance through the same one inbox (§5).
      if (updated.objectType === "workflow") {
        postCommit = await applyWorkflowApprovalDecision(tx, updated, body.decision, deciderUserId, opts.dataKey);
      }
      // Orchestration escalations (§3): approve = another attempt, deny = abort.
      if (updated.objectType === "run") {
        postCommit = await applyRunApprovalDecision(tx, updated, body.decision, deciderUserId, opts.dataKey);
      }
      // Pillar 5 budget escalations + §9 context-conflict resolutions.
      if (updated.objectType === "project") {
        await applyProjectApprovalDecision(tx as unknown as Db, updated, body.decision, deciderUserId);
      }
      // Pillar 3 §8.2 governed remediations: approve -> provider.remediate +
      // finding 'remediated'; deny -> 'accepted_risk'. Both audited. SoD guards
      // (named-approver, admin-override-reason, self-review-reason) apply above.
      if (updated.objectType === "infra_operation") {
        await applyInfraApprovalDecision(tx as unknown as Db, updated, body.decision, deciderUserId);
      }
      // ADR-0045 MRM sign-offs: the risk acceptance is recorded on the model
      // card chain HERE, inside the one decide path, so it inherits every
      // separation-of-duties guard above (named approver, admin-override
      // reason, self-review reason, delegation) rather than inventing its own.
      if (updated.objectType === "model_card") {
        await applyModelCardApprovalDecision(
          tx as unknown as Db,
          updated,
          body.decision,
          deciderUserId,
        );
      }
      // ADR-0065 RegulAIt-LLM: an over-threshold training job. Same reasoning
      // as the MRM sign-off above — model training does not get a second
      // inbox, so the decision lands HERE, inside the one decide path, and
      // inherits every separation-of-duties guard it applies (named approver,
      // admin-override reason, self-review reason, delegation). The job's
      // actual START is the returned post-commit closure: training makes a
      // network call on a remote backend, and holding the approvals
      // transaction open across it would lock the one queue every other
      // governed action shares.
      if (updated.objectType === "training_job") {
        postCommit = await applyTrainingJobApprovalDecision(
          tx as unknown as Db,
          updated,
          body.decision,
          deciderUserId,
        );
      }
      return { updated, postCommit };
    });
    if (!outcome.updated) {
      // raced: re-read so the refusal names what actually happened
      const [current] = await db
        .select({ status: approvals.status })
        .from(approvals)
        .where(eq(approvals.id, approvalId));
      return fail(409, 
        current?.status === "superseded"
          ? {
              error: "approval_superseded",
              detail: "this approval was superseded (its node, run, or stage moved on) and can no longer be decided",
            }
          : { error: "already_decided" },
      );
    }
    // The decision is durable from here on: an execution hiccup surfaces in
    // the response (and the execution machinery's own failure events), never
    // as a failed decide.
    let executionError: string | null = null;
    if (outcome.postCommit) {
      try {
        await outcome.postCommit(db);
      } catch (err) {
        executionError = err instanceof Error ? err.message : String(err);
      }
    }
    // EPIC-06 §5: sign-offs mirror to the linked work item — display only,
    // never a second decision point; a mirror failure never unwinds the
    // decision, it is surfaced in the response.
    const pmMirror = await mirrorApprovalDecision(db, opts.dataKey, outcome.updated, deciderUserId);
    return {
      ok: true as const,
      body: {
      ...outcome.updated,
      ...(adminOverride ? { adminOverride: true } : {}),
      ...(delegation ? { onBehalfOf: row.approverUserId, delegationId: delegation.id } : {}),
      ...(selfReview ? { selfReview: true } : {}),
      ...(pmMirror ? { pmMirror } : {}),
      ...(executionError ? { executionError } : {}),
      },
    };
  }

  app.post("/v1/approvals/:approvalId/decide", async (req, reply) => {
    const { approvalId } = z.object({ approvalId: z.string().uuid() }).parse(req.params);
    const body = decideApprovalSchema.parse(req.body);
    const outcome = await decideOneApproval({
      approvalId,
      deciderUserId: req.authCtx.userId,
      isAdmin: req.authCtx.isAdmin,
      body,
    });
    if (!outcome.ok) return reply.status(outcome.status).send(outcome.body);
    return outcome.body;
  });


  // ADR-0026 phase 2 — the default-surface swap: the React SPA at /ui is the
  // product surface, so the historic shell URLs redirect there. The two
  // ADR-0012 single-file template-literal shells that /legacy/app and
  // /legacy/admin served for one release are DELETED (ADR-0033), along with
  // admin-portal.ts, app-ui.ts and ui-theme.ts. /legacy/* registers no route
  // at all now — it is gone exactly like any other removed path, never a
  // shell behind a login. These two redirects stay because SSO's server-side
  // returnTo whitelist still names /app and /admin, and because bookmarks
  // outlive releases.
  //
  // ADR-0031 item 5: allow the inline script the SPA shell actually carries
  // (the theme pre-paint) by HASH rather than surrendering script-src to
  // 'unsafe-inline'. Derived from the exact bytes that will be served — read
  // from the built bundle — so a rebuilt bundle or an edited pre-paint script
  // keeps working with no hardcoded constant to drift.
  registerSpaInlineScripts(path.resolve(process.env.REGULAIT_WEB_DIST ?? defaultWebDistDir()));
  app.get("/admin", async (_req, reply) => reply.redirect("/ui", 302));
  app.get("/app", async (_req, reply) => reply.redirect("/ui", 302));

  // ADR-0026: the React SPA at /ui (built bundle from apps/web/dist —
  // assets, SPA fallback, 503 when unbuilt) — now the ONLY UI the gateway
  // serves. The API surface is never shadowed.
  registerWebServing(app);

  // The two things anything pointed at the bare origin expects to find: a
  // human landing on / gets the app (the SPA since the phase-2 swap), a load
  // balancer or uptime check gets a status. Both are auth-exempt.
  app.get("/", async (_req, reply) => reply.redirect("/ui", 302));
  app.get("/health", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
    } catch {
      return reply.status(503).send({ status: "degraded", database: "unreachable" });
    }
    return { status: "ok", database: "ok" };
  });

  // ADR-0031 item 6: the health surface the two boot schedulers report into.
  // Admin-only via the default gate (deliberately NOT in NON_ADMIN_ROUTES) and
  // deliberately NOT part of /health — a liveness probe must not start failing
  // because a backup verification pass errored, but an admin must be able to
  // SEE that it did. In-memory on purpose: it still answers when the database
  // is the thing that broke, which is the most likely reason a tick failed.
  app.get("/v1/health/schedulers", async () => {
    const schedulers = schedulerHealth();
    return {
      schedulers,
      healthy: schedulers.every((s) => s.healthy),
      // an empty list means neither scheduler has ticked in this process yet
      // (both ship OFF by default) — absence of failures, not proof of success
      note: "in-memory, per-process, reset on restart; both schedulers are OFF by default (org_settings)",
    };
  });

  // ADR-0025: password/session/TOTP/OIDC login surface + the admin endpoints
  // for one-time passwords, MFA recovery, session revocation and SSO
  // provider CRUD.
  registerAuthRoutes(app, db, { bootstrapToken: opts.bootstrapToken, dataKey: opts.dataKey });
  registerSamlRoutes(app, db, { dataKey: opts.dataKey });
  // ADR-0037 — SCIM 2.0 provisioning. TWO registrations on purpose, because
  // they live on two different trust paths: `registerScimRoutes` mounts
  // /scim/v2 inside its own encapsulated scope that authenticates ONLY on
  // `scim_tokens` (auth-exempt above precisely so the human session/api-key
  // hook cannot admit a user credential to it), while `registerScimAdminRoutes`
  // mounts ordinary admin-gated /v1 endpoints for issuing and revoking those
  // tokens. Deprovisioning through either DELETE or active:false lands on
  // ADR-0022's `disabled_at` — never a row delete.
  registerScimRoutes(app, db);
  registerScimAdminRoutes(app, db);
  // ADR-0038 — admin CRUD for IdP-group → role mappings, the "unmapped asserted
  // groups" report, and the role-provenance read. Admin-only through the
  // DEFAULT gate above (none of them appear in NON_ADMIN_ROUTES): creating a
  // mapping delegates a role's grants to whoever administers the IdP group.
  registerGroupRoleMappingRoutes(app, db);
  // ADR-0040: ABAC policy-as-code admin surface (CRUD, versions, activate/
  // rollback, the policy test runner, and the access-preview simulation hook).
  // Admin-only through app.ts's DEFAULT gate — none of these routes appear in
  // NON_ADMIN_ROUTES, because authoring a policy that can deny every governed
  // call in the org is precisely the kind of act a non-admin must not reach.
  registerAbacRoutes(app, db);
  // ADR-0059 — POLICY SIMULATION / BLAST-RADIUS PREVIEW, the consumer ADR-0040
  // promised when it shipped the single-tuple simulate hook. Dry-runs a
  // PROPOSED policy version against recorded history and reports who it would
  // newly block, by name. Strictly side-effect-free: the module cannot dispatch
  // because the dispatch core is not reachable from it. POST
  // /v1/policy-simulations is in NON_ADMIN_ROUTES and entitlement-scoped inside
  // (ADR-0047's shape) — a team lead may ask "would this break my team" and may
  // not use the same question to read another team's traffic.
  registerPolicySimulationRoutes(app, db);
  // ADR-0042 — the guardrail engine's admin surface: the detector registry
  // (with each detector's honest limits), org/agent/connector mode config, the
  // resolved-policy explainer, the tuning sandbox and the recent-violations
  // view (a query over the ONE audit log, not a second ledger). Admin-only
  // through the DEFAULT gate — none appear in NON_ADMIN_ROUTES, because
  // relaxing a content control is exactly a privileged act.
  registerGuardrailRoutes(app, db);
  // ADR-0044 — the evaluation harness: golden dataset versions, the scorer
  // registry, runs, per-case results and the baseline comparison. Authoring a
  // dataset or moving a baseline changes what the promotion gate will accept,
  // so all of it is admin-only through the DEFAULT gate — except POST
  // /v1/evals/runs, which is in NON_ADMIN_ROUTES because its gate is the
  // caller's own agent entitlement, checked inside the runner exactly as an
  // invoke would check it.
  registerEvalRoutes(app, db, { dataKey: opts.dataKey });
  // ADR-0045 — the model risk management registry: model cards, the
  // recertification chain, evidence links onto ADR-0044 eval runs, the expiry
  // sweep, and the org toggle that turns "reviewed for a stated purpose" into
  // a dispatch gate. Every route is admin-only via the global gate (none
  // appear in NON_ADMIN_ROUTES) — authoring or signing off a risk position is
  // a privileged act by definition, and the SIGN-OFF DECISION itself is not
  // here at all: it rides POST /v1/approvals/:approvalId/decide, which the
  // named approver reaches as a non-admin exactly as before.
  registerMrmRoutes(app, db);
  // ADR-0057 — CONTINUOUS RED-TEAMING. Versioned attack libraries, the shipped
  // corpus, and runs — every one of which is an ADR-0044 eval run underneath,
  // so probes take the same governed dispatch, the same metering and the same
  // audit trail as real traffic, and a regression blocks promotion through the
  // SAME automated_check gate a failed CI check uses. Authoring a library is
  // admin-only through the DEFAULT gate (it changes what the promotion gate
  // measures); POST /v1/redteam/runs is in NON_ADMIN_ROUTES because its gate is
  // the caller's own agent entitlement, checked inside the runner.
  registerRedTeamRoutes(app, db, { dataKey: opts.dataKey });
  // ADR-0046 — the review workbench: routing rules, SLA policies + the lazy
  // breach evaluation that stands in for the scheduler this codebase does not
  // have, claiming, saved views, per-reviewer workload, and BULK. Bulk is
  // handed `decideOneApproval` — the very function the single-decision route
  // calls — so a bulk item cannot take a shortcut around any guard.
  registerWorkbenchRoutes(app, db, { decideOne: decideOneApproval });
  // ADR-0061 — CHATOPS APPROVALS. Handed the SAME `decideOneApproval` the
  // portal route and the bulk endpoint use: the chat surface is a courier over
  // the one decide path, never a second authority path. The inbound callback
  // route authenticates on the workspace's signing secret in-route (it is in
  // AUTH_EXEMPT_ROUTES / NON_ADMIN_ROUTES exactly like the PM webhook, and for
  // the same reason: Slack holds no RegulAIt credential); every other route
  // here is admin-only.
  registerChatOpsRoutes(app, db, {
    decideOne: decideOneApproval,
    ...(opts.dataKey ? { dataKey: opts.dataKey } : {}),
  });
  // ADR-0047 — executive & compliance reporting: report definitions, schedule
  // DEFINITIONS (nothing fires on a timer here — an operator drives
  // POST /v1/reports/schedules/run-due), the immutable run ledger, and the
  // CSV/JSON export. Authoring a definition or a schedule is admin-only through
  // the DEFAULT gate; GENERATING and READING are reachable by a non-admin
  // (NON_ADMIN_ROUTES below) because a team lead running their own team's
  // scorecard is the point — and every one of those paths resolves the caller's
  // entitlement to a CONCRETE project-id set and builds its ledger queries FROM
  // that set, so a report can never show spend or audit data the caller could
  // not see directly.
  registerReportingRoutes(app, db);
  // ADR-0048 — immutable versioning, canary rollout and one-click rollback for
  // the governance artifacts the gateway reads. Following ADR-0040's precedent:
  // immutable version rows plus an active pointer, activation is a pointer
  // move, rollback is selecting an older row. ALL of it is admin-only through
  // the DEFAULT gate (none of these appear in NON_ADMIN_ROUTES) — minting a
  // prompt version, ramping a canary, promoting past the eval gate or rolling
  // back changes what every subsequent dispatch in the org is governed by,
  // which is privileged by definition. The dispatch-time RESOLUTION is not a
  // route at all: it lives inside executeGovernedDispatch, so every caller
  // inherits it, and the resolved version is stamped onto the usage_events row.
  registerConfigVersionRoutes(app, db);
  // ADR-0049 — cost forecasting and spend-anomaly detection over the MEASURED
  // usage ledger. Two things about the wiring are load-bearing. First, the
  // entitlement decision is ADR-0047's `evaluateReportAccess` CALLED, not
  // re-implemented: a forecast and an anomaly alert are derived numbers, and a
  // derived number is exactly the shape in which one team's spend leaks to
  // another, so there is one copy of the rules. Second, enforcement escalates
  // into the EXISTING approvals queue with a `__spend_anomaly__` stage
  // sentinel — the same table, the same decide path, no second inbox. Reading
  // a forecast/anomaly is non-admin-reachable (scoped inside the handler);
  // authoring policies, recording scheduled changes and driving the evaluator
  // stay admin.
  registerSpendMonitorRoutes(app, db);
  // ADR-0050 — the data-lineage / provenance graph. SUPPLIED-INPUTS provenance:
  // which inputs the gateway handed to a dispatch and what it handed back,
  // chained across runs through pillar 4's already-versioned context items. It
  // does NOT claim which of those inputs influenced the output — intra-model
  // attribution is not observable from outside a model — and every response
  // carries that sentence rather than leaving it in an ADR. Capture rides the
  // interception points that already exist (the context-write path and the
  // orchestration dispatch path), so there is no second instrumentation pass.
  // The three READ routes are non-admin-reachable and narrow to the caller's
  // own project memberships at query construction; a node the caller cannot see
  // 404s exactly as a nonexistent one does, because for a provenance graph
  // confirming that something exists IS the disclosure.
  registerLineageRoutes(app, db);
  // ADR-0051 — metering & billing. Nothing here meters: `usage_events` and
  // `cost_events` have been written unconditionally at the point of every
  // governed call since ADR-0019/0024, and this is a READ-SIDE consumer of that
  // one ledger, so no billing number can drift from the cost dashboard. Three
  // things about the wiring are load-bearing. First, an issued statement is
  // IMMUTABLE: rate cards are append-only versions, every statement freezes the
  // pricing snapshot it was rated against, and re-cutting a period appends a
  // version rather than editing one. Second, the entitlement decision is again
  // ADR-0047's `evaluateReportAccess` CALLED (through ADR-0049's adapter), not
  // a third copy — an invoice is exactly the shape in which one team's spend
  // leaks. Third, there is no payment processor: `NoopBilling` (export-only, no
  // network) is the only backend, which is ADR-0051 §6's air-gapped default.
  registerBillingRoutes(app, db);
  // ADR-0052 — licensing & seats. The load-bearing piece is that verification
  // is OFFLINE: ADR-0041 makes air-gapped the primary motion, so there is no
  // home to phone, and the license is a signed artifact checked locally against
  // a pinned Ed25519 keyring — the same crypto posture as ADR-0041's update
  // bundles, not a second scheme. Three postures are deliberate rather than
  // defaulted: a FORGED or tampered artifact is refused outright and never
  // displaces the installed one (fail closed); a MISSING license is not an
  // error — the deployment runs UNLICENSED, fully governed, tier features
  // closed, no seat cap enforced (fail open, because bricking a fresh install
  // would make governance depend on commerce and leave no way to install the
  // license); and on EXPIRY the split is by action class — governance, audit
  // and approvals keep running while commercial expansion freezes. Every route
  // is admin-only via the DEFAULT gate: installing a license changes the
  // commercial ceiling for the whole deployment.
  registerLicensingRoutes(app, db);

  // ADR-0060 — the tamper-evident audit chain's operator surface. The CHAIN
  // itself is not registered here: it is computed at the storage boundary in
  // `@regulait/db`'s `createDb`, so every one of the 158 `insert(auditLog)`
  // call sites in this app — and the next one written — is chained without
  // knowing it. What lives here is verification and anchoring, both admin-only
  // via the DEFAULT gate: `GET /v1/audit/verify` reports the whole trail's
  // shape, and taking an anchor is a governed act that itself lands in the
  // trail.
  registerAuditChainRoutes(app, db, ...(opts.auditAnchorSink !== undefined ? [{ sink: opts.auditAnchorSink }] : []));

  registerAgentConnectorRoutes(app, db, { dataKey: opts.dataKey });
  // ADR-0034 — admin-registered custom LLM providers + the egress allow-list
  // that makes their admin-suppliable baseUrl safe to have. Every route is
  // admin-only via the global gate (none appear in NON_ADMIN_ROUTES).
  registerCustomProviderRoutes(app, db, { dataKey: opts.dataKey });
  // ADR-0065 — REGULAIT-LLM. Registered next to the custom-provider surface
  // because it answers the adjacent question: that one is "which model that we
  // do not own may our people reach?", this one is "which model may our people
  // BUILD, from what data, and under whose sign-off?". Everything except
  // POST /v1/llm/jobs is admin-only through the default gate; that one route is
  // in NON_ADMIN_ROUTES because its gate is the caller's own entitlement to the
  // base agent, checked inside the handler exactly as an invoke would check it.
  registerRegulAItLlmRoutes(app, db, { dataKey: opts.dataKey });
  registerConversationRoutes(app, db);
  registerProjectRoutes(app, db);
  registerInfraRoutes(app, db, opts.dataKey);
  registerOptimizationRoutes(app, db);
  registerOrchestrationRoutes(app, db, { dataKey: opts.dataKey });
  registerDecomposeRoutes(app, db, { dataKey: opts.dataKey });
  registerPmRoutes(app, db, { dataKey: opts.dataKey });

  registerWorkflowRoutes(app, db, { dataKey: opts.dataKey });

  registerMcpProxy(app, db);

  // ADR-0020 (Batch H) — IDE / existing-agent interception. The two
  // provider-shaped shims are OFF by default and gated by the onRequest hook
  // above; the settings routes that flip them are admin-only.
  registerInterceptionRoutes(app, db);

  // ADR-0021 — org-wide functional defaults (org_settings singleton). The
  // GET/PUT routes are admin-only (deliberately NOT in NON_ADMIN_ROUTES); the
  // audit auto-prune scheduler is OFF by default and unref'd, stopped on close.
  registerOrgSettingsRoutes(app, db);

  // Getting-started journey (admin-only via the default gate): one read-only
  // aggregation of real readiness signals the /admin checklist card renders.
  registerSetupStatusRoutes(app, db, { dataKey: opts.dataKey });
  // ADR-0063 — REGULAIT_DATA_KEY custody. Admin-only through the default gate.
  // The fingerprint itself is not secret (that is the whole design), but "which
  // key does this deployment's ciphertext belong to, and has any human said
  // they hold it" is org-wide custody posture, not member-visible. The BOOT
  // gate that refuses a mismatched key lives on the boot path (boot.ts), not
  // here: constructing an app is not the act of putting a deployment in
  // service, and a control that fired on construction is one every fixture
  // would have to work around.
  registerDataKeyRoutes(app, db, { dataKey: opts.dataKey });
  // ADR-0054 — the IN-PRODUCT first-run experience (the installer, ADR-0041,
  // owns deployment bring-up; nothing here duplicates it) plus the
  // migration/import tooling. Admin-only through the DEFAULT gate: every route
  // here provisions users, seeds roles or classifies a project, which is
  // exactly the authority a non-admin must not reach. None appear in
  // NON_ADMIN_ROUTES.
  registerOnboardingRoutes(app, db, { dataKey: opts.dataKey });
  // ADR-0055 — SHADOW-AI DISCOVERY. Admin-only by default (nothing here is in
  // NON_ADMIN_ROUTES): uploading a customer's proxy export, editing the
  // detection catalogue and dispositioning findings are all operator authority.
  // The subsystem makes NO outbound request and can write only its own three
  // tables — an evidence file cannot mint a user, role, grant or approval.
  registerShadowAiRoutes(app, db);
  // ADR-0069 — CROSS-VENDOR COST CONSOLIDATION. Admin-only by default: the ONLY
  // route here in NON_ADMIN_ROUTES is `GET /v1/users/:userId/cost-consolidated`,
  // which refuses in-handler unless the caller IS that user. Uploading a file
  // that restates a named colleague's spend, asserting that a vendor account is
  // a particular human, and reading fleet-wide spend are all operator authority.
  // The subsystem makes NO outbound request and can write only its own four
  // tables plus `users.cost_center`; imported money lives in a separate table
  // under a CHECK that pins `basis = 'imported'`, so nothing it writes can ever
  // be read back as metered.
  registerCostImportRoutes(app, db);
  // ADR-0058 — REGULATORY COMPLIANCE PACKS. Authoring/activating a pack and
  // recording an attestation are admin (not in NON_ADMIN_ROUTES); EVALUATING a
  // pack is reachable by a non-admin and runs ADR-0047's own
  // `evaluateReportAccess`, so a scorecard never exceeds the caller's own
  // visibility. Nothing here enforces anything: a pack drives the EXISTING
  // §8.3 cascade via its tag, and every control's status is computed from a
  // SELECT over the real ledgers — there is no column an admin can tick.
  registerCompliancePackRoutes(app, db);
  // ADR-0056 — THE AI GOVERNANCE COPILOT. The ultimate dogfood: our own
  // flagship agent is a TENANT of the kernel it fronts. Its reads are narrowed
  // to the INVOKING USER's own project scope at query construction (there is no
  // copilot super-reader grant, and an identity-less caller is refused); its
  // narration is an ordinary `executeGovernedDispatch` behind the ordinary
  // `evaluateAgent` check, so it is entitlement-gated, metered into
  // usage_events and audited like any other; the audit rows it reads are
  // treated as UNTRUSTED INPUT through ADR-0042's guardrails; and it has no
  // mutating tools at all — its only route to a change is a proposal that opens
  // an ordinary Approvals-Queue item for a named human.
  registerCopilotRoutes(app, db, { dataKey: opts.dataKey });
  // ADR-0053 — the published contract: the OpenAPI document, the versioning /
  // deprecation policy, and the RFC-8594 Deprecation/Sunset headers. Registered
  // here (rather than first) only for readability; the inventory hook at the top
  // of buildApp catches routes in any order.
  registerOpenApiRoutes(app);
  // ADR-0064 — the in-process scheduler's OPERATOR SURFACE. Note what is NOT
  // here: a timer. `buildApp` constructs routes and nothing else; the tick loop
  // is started by the BOOT path (boot.ts) and only when REGULAIT_SCHEDULER says
  // so. ~103 test files construct an app, and a scheduler that started on
  // construction would slow every one of them and make some flaky — which is
  // why "constructing the app starts no timer" is itself asserted in
  // scheduler.test.ts rather than left as an intention.
  registerSchedulerRoutes(app, db, { registry: schedulerJobRegistry({ dataKey: opts.dataKey }) });
  const stopAuditPruneScheduler = startAuditPruneScheduler(db);
  app.addHook("onClose", async () => stopAuditPruneScheduler());
  registerAnthropicCompat(app, db, { dataKey: opts.dataKey });
  registerOpenAiCompat(app, db, { dataKey: opts.dataKey });
  // ADR-0066 §1 — `GET /v1/models`. Gated by the same onRequest hook as the two
  // shims (on EITHER being enabled), and entitlement-filtered per caller inside
  // the handler, so what a client can list is exactly what it can call.
  registerModelsDiscovery(app, db);
  // ADR-0066 §2 — virtual keys. `GET/POST/PATCH/DELETE /v1/virtual-keys*` are
  // in NON_ADMIN_ROUTES because a user may issue and revoke keys for THEMSELVES
  // (a strict narrowing of their own entitlements); the handlers enforce
  // owner-or-admin per row, and the admin-only fields refuse in-handler.
  registerVirtualKeyRoutes(app, db);

  // ADR-0031 item 2: the audit read surface used to be hard-capped at 100 rows
  // with a userId filter (plus PR #79's deployMode) and nothing else — for a
  // compliance product that means no admin could ever see row 101. It now pages
  // with an opaque keyset cursor on the stable (at DESC, id DESC) sort, and
  // filters on from/to/objectType/effect as well as userId and deployMode —
  // all through the SAME auditFilters() the CSV export uses. Callers that pass
  // nothing get EXACTLY the old behaviour: the newest 100 rows under `entries`.
  app.get("/v1/audit", async (req, reply) => {
    const q = auditQuery.parse(req.query);
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (q.cursor && !cursor) return reply.status(400).send({ error: "invalid_cursor" });

    const filters = auditFilters(q, q.from ?? null, q.to ?? null);
    if (cursor) filters.push(afterCursorDesc(auditLog.at, auditLog.id, cursor));

    // one extra row decides hasMore without a second COUNT over a table that
    // grows a row per governed call
    const rows = await db
      .select({ ...auditLogColumns, atText: atTextSql(auditLog.at) })
      .from(auditLog)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(auditLog.at), desc(auditLog.id))
      .limit(q.limit + 1);

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    return {
      // `atText` is a cursor-derivation detail, never part of the row contract
      entries: page.map(({ atText: _atText, ...entry }) => entry),
      pageSize: page.length,
      maxPageSize: AUDIT_MAX_PAGE_SIZE,
      hasMore,
      nextCursor: hasMore && last ? encodeCursor({ at: last.atText, id: last.id }) : null,
    };
  });

  // ADR-0022: CSV export of the (filtered) audit trail — the compliance
  // deliverable auditors actually ask for. Admin-only via the default gate;
  // same download pattern as the per-project costs CSV.
  //
  // ADR-0031: this used to `select()` the WHOLE filtered table, materialise it
  // into a JS array and concatenate one giant string — with audit_log growing a
  // row per governed call and auto-prune OFF by default, that is an OOM of the
  // container waiting to happen. It now streams: keyset batches over
  // (at DESC, id DESC), written to reply.raw a batch at a time, under a
  // defaulted date window and a hard row ceiling — BOTH disclosed (headers
  // always, plus a trailing comment row whenever the file is not the complete
  // answer). The column shape is unchanged, so a complete export is
  // byte-identical to what the old code produced.
  // A4 (ADR-0027): `deployMode` is its own column. A row with no mode is
  // written as the literal `unknown` rather than an empty cell — the same word
  // the filter uses — so an auditor reading the export can never mistake "we
  // never recorded a mode here" for "hosted" or for a lost value.
  const AUDIT_CSV_HEADER = [
    "at",
    "userId",
    "userName",
    "objectType",
    "objectId",
    "serverId",
    "toolName",
    "effect",
    "ruleId",
    "deployMode",
    "reason",
    "detail",
  ] as const;

  app.get("/v1/audit.csv", async (req, reply) => {
    const q = auditCsvQuery.parse(req.query);
    const win = resolveCsvWindow(q.from, q.to);
    const filters = auditFilters(q, win.from, win.to);
    const where = filters.length ? and(...filters) : undefined;

    // The userName column needs a display name per row. The old code loaded
    // EVERY user up front; we resolve lazily per batch and memoise, so the map
    // is bounded by the distinct users actually present in the export.
    const nameOf = new Map<string, string>();
    const resolveNames = async (ids: string[]) => {
      const missing = [...new Set(ids)].filter((id) => !nameOf.has(id));
      if (missing.length === 0) return;
      const rows = await db
        .select({ id: users.id, displayName: users.displayName, email: users.email })
        .from(users)
        .where(inArray(users.id, missing));
      for (const u of rows) nameOf.set(u.id, u.displayName || u.email);
      for (const id of missing) if (!nameOf.has(id)) nameOf.set(id, "");
    };

    const csvCell = (v: unknown): string => {
      if (v === null || v === undefined) return "";
      const s = typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };

    // filename names every filter that shaped the file, so two downloads taken
    // with different filters never collide in a downloads folder
    const suffix = `${q.userId ? `-${q.userId.slice(0, 8)}` : ""}${q.deployMode ? `-${q.deployMode}` : ""}`;
    type Row = typeof auditLog.$inferSelect & { atText: string };
    await streamCsv<Row>(reply, {
      filename: `audit-log${suffix}.csv`,
      header: AUDIT_CSV_HEADER,
      eol: "\n",
      batchSize: csvBatchRows(),
      maxRows: csvMaxRows(),
      window: win,
      fetchPage: async (after, limit) => {
        const pageWhere = after
          ? and(...filters, afterCursorDesc(auditLog.at, auditLog.id, after))
          : where;
        const rows = (await db
          .select({ ...auditLogColumns, atText: atTextSql(auditLog.at) })
          .from(auditLog)
          .where(pageWhere)
          .orderBy(desc(auditLog.at), desc(auditLog.id))
          .limit(limit)) as Row[];
        await resolveNames(rows.map((r) => r.userId));
        return rows;
      },
      cursorOf: (r) => ({ at: r.atText, id: r.id }),
      renderRow: (r) =>
        [
          r.at.toISOString(),
          r.userId,
          nameOf.get(r.userId) ?? "",
          r.objectType,
          r.objectId,
          r.serverId,
          r.toolName,
          r.effect,
          r.ruleId,
          r.deployMode ?? "unknown",
          r.reason,
          r.detail,
        ]
          .map(csvCell)
          .join(","),
      hasRowsOutsideWindow: async () => {
        if (!win.from) return false;
        // the SAME filters with the window inverted — the disclosure must speak
        // about the rows this export would have covered, not about every row
        const older = auditFilters(q, null, win.from);
        const rows = await db
          .select({ id: auditLog.id })
          .from(auditLog)
          .where(older.length ? and(...older) : undefined)
          .limit(1);
        return rows.length > 0;
      },
    });
  });

  return app;
}
