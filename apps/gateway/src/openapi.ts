/**
 * ADR-0053 — THE PUBLIC API CONTRACT.
 *
 * WHY THIS FILE IS A GENERATOR AND NOT A DOCUMENT
 * -----------------------------------------------
 * A hand-written OpenAPI file is wrong the day after it is written. Nothing in
 * this module contains a route path that was typed twice. The document is built
 * from three things that already exist and are already load-bearing:
 *
 *   1. `app.routeInventory` — the LIVE Fastify route list, collected by an
 *      `onRoute` hook registered before any route in buildApp. If a route
 *      exists, it is in here. There is no second place to forget.
 *   2. `route-classes.ts` — the two sets the gateway's auth hook and admin gate
 *      actually branch on. The documented credential per route is COMPUTED from
 *      them, so the spec cannot claim "no auth" on a route the gate 403s.
 *   3. `openapi-registry.ts` — the one genuinely human decision per route: is
 *      it part of the published contract (`public-stable` / `public-beta`) or
 *      not (`internal`)?
 *
 * Request/response bodies are derived from the SAME zod schemas the handlers
 * parse with (`@regulait/shared`), converted to JSON Schema. A route whose body
 * schema is not bound here says so IN THE ARTIFACT
 * (`x-regulait-schema: "unspecified"`) rather than silently publishing an empty
 * object as if it were the contract. ADR-0053 names that weakness as a known
 * consequence; disclosing it per route is the honest form of it.
 *
 * WHAT IS *NOT* IN THE PUBLISHED DOCUMENT
 * ---------------------------------------
 * Everything tagged `internal` — which is most of the 350+ routes, and
 * deliberately so. Publishing the whole surface would freeze the admin console's
 * own API. `GET /v1/openapi.json?include=all` will render them for an admin who
 * asks, clearly marked `x-regulait-stability: internal` and
 * `x-regulait-guarantee: none`, because an operator debugging their own
 * deployment should not have to read our source. It is admin-gated and it is
 * not the published artifact.
 *
 * ONE DEPENDENCY WAS ADDED: `zod-to-json-schema` (3.25.2, zero runtime
 * dependencies of its own, already resolved in this workspace's lockfile as a
 * transitive dependency of the OpenAI SDK). It is the difference between bodies
 * DERIVED from the schemas the handlers enforce and bodies re-typed by hand
 * beside them — which is the exact drift this ADR exists to prevent. Under
 * ADR-0012's dependency scrutiny that trade is worth one small, pinned,
 * dependency-free package.
 */
import type { FastifyInstance } from "fastify";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  assignRoleSchema,
  createApiKeySchema,
  createProjectSchema,
  createRoleSchema,
  createUserSchema,
  decideApprovalSchema,
  deactivateUserSchema,
  evaluateRequestSchema,
  invokeAgentSchema,
  invokeConnectorSchema,
  reportChecksSchema,
} from "@regulait/shared";
import { routeAuthClass, type RouteAuthClass } from "./route-classes.js";
import { COMPAT_SURFACES, ROUTE_STABILITY, ROUTE_TAGS, type Stability } from "./openapi-registry.js";

export type { Stability } from "./openapi-registry.js";
export { ROUTE_STABILITY } from "./openapi-registry.js";

export interface RouteInventoryEntry {
  method: string;
  url: string;
}

declare module "fastify" {
  interface FastifyInstance {
    /** ADR-0053: every route registered on this instance, in registration
     * order, HEAD/OPTIONS twins excluded. Populated by an `onRoute` hook added
     * before any route, so coverage is order-independent. */
    routeInventory: RouteInventoryEntry[];
  }
}

// ===========================================================================
// 1. VERSIONING AND DEPRECATION POLICY (ADR-0053 §3)
// ===========================================================================

/** the only major currently served. A new major is a NEW PATH PREFIX. */
export const API_MAJOR = "v1";

/**
 * The policy, as data, so `GET /v1/api/versioning` serves the SAME words this
 * module enforces rather than a prose page that can disagree with it.
 */
export const VERSIONING_POLICY = {
  major: API_MAJOR,
  scheme: "url-path",
  /** what a caller may rely on, per stability tag */
  guarantees: {
    "public-stable":
      "breaking changes require a new major path (/v2) served alongside /v1; " +
      "a deprecated route or field emits RFC-8594 Deprecation and Sunset headers " +
      "for at least 12 months before removal",
    "public-beta":
      "in the published spec and clients, but may change within the major with " +
      "notice; the deprecation window is 90 days, not 12 months",
    internal:
      "not part of the published spec or clients and carries NO compatibility " +
      "guarantee; may change or be removed in any release",
  },
  /** what counts as breaking — stated so a reviewer does not have to guess */
  breakingChanges: [
    "removing a route, or changing its method or path",
    "removing a response field, or narrowing its type",
    "adding a REQUIRED request field, or narrowing an existing field's type",
    "changing the meaning of an existing field without changing its name",
    "changing a route's auth class to a stricter one (e.g. user -> admin)",
    "changing an error code a documented failure mode returns",
  ],
  nonBreakingChanges: [
    "adding a new route",
    "adding an OPTIONAL request field",
    "adding a response field",
    "adding a new enum member to a field that already documents an open set",
    "relaxing a route's auth class (e.g. admin -> user)",
  ],
  deprecationWindowDays: { "public-stable": 365, "public-beta": 90 },
} as const;

/**
 * Routes on the clock. Empty today — nothing has been deprecated yet — and that
 * emptiness is itself the published statement. When a route lands here it
 * starts emitting `Deprecation` / `Sunset` (RFC 8594) automatically from the
 * hook below AND appears in the machine-readable deprecation section of the
 * spec: one edit, both consequences, no way to deprecate something quietly.
 */
export interface DeprecationEntry {
  /** ISO date the deprecation took effect (the RFC-8594 `Deprecation` value) */
  since: string;
  /** ISO date after which the route may be removed (RFC-8594 `Sunset`) */
  sunset: string;
  /** what a caller should move to */
  replacement: string | null;
  reason: string;
}
export const DEPRECATIONS: Readonly<Record<string, DeprecationEntry>> = {};

// ===========================================================================
// 2. THE PER-ROUTE DOCUMENTATION FOR THE PUBLISHED SUBSET
// ===========================================================================

export interface RouteDoc {
  summary: string;
  /** the zod schema the HANDLER parses the body with — not a copy of it */
  body?: ZodTypeAny;
  /** a named response shape, when one is worth stating */
  responseNote?: string;
}

/**
 * Bodies are bound to the ACTUAL shared schema the handler calls `.parse()`
 * with. Binding the wrong one is caught by review, not by the type system — but
 * binding NOTHING is caught by the artifact, which marks the route
 * `x-regulait-schema: "unspecified"` rather than pretending.
 */
export const ROUTE_DOCS: Readonly<Record<string, RouteDoc>> = {
  "GET /health": { summary: "Liveness probe. The only route that is never rate limited." },
  "GET /v1/me": {
    summary: "Identity echo — who the presented credential is, and the org size ceilings a client needs to pre-validate uploads.",
  },
  "GET /v1/openapi.json": {
    summary: "This document. `?include=all` additionally renders internal routes (admin only) — those carry no compatibility guarantee.",
  },
  "GET /v1/api/versioning": {
    summary: "The versioning and deprecation policy, plus every route currently on a sunset clock, as machine-readable data.",
  },

  "GET /v1/users": { summary: "List users, with sign-in posture flags (never a hash or a secret). Bounded: `limit` (default 1000, max 5000)." },
  "POST /v1/users": {
    summary: "Provision a user. Refused when the licensed seat cap is reached (ADR-0052) — a growth gate, never a service gate.",
    body: createUserSchema,
  },
  "GET /v1/users/directory": { summary: "Minimal user directory for pickers — id, email, display name." },
  "PATCH /v1/users/:userId": { summary: "Update a user's mutable profile fields." },
  "POST /v1/users/:userId/deactivate": {
    summary: "Deactivate a user. Keys and sessions stop authenticating immediately; nothing is deleted.",
    body: deactivateUserSchema,
  },
  "POST /v1/users/:userId/reactivate": { summary: "Reactivate a deactivated user. Their unrevoked keys resume working unchanged." },
  "POST /v1/users/:userId/keys": {
    summary: "Mint an API key for a user. The plaintext is returned exactly once and never stored.",
    body: createApiKeySchema,
  },
  "GET /v1/keys": { summary: "List API keys (metadata only — never the token)." },
  "POST /v1/keys/:keyId/revoke": { summary: "Revoke an API key immediately." },

  "GET /v1/roles": { summary: "List roles." },
  "POST /v1/roles": { summary: "Create a role.", body: createRoleSchema },
  "DELETE /v1/roles/:roleId": { summary: "Delete a role and every grant it carried." },
  "GET /v1/roles/:roleId/grants": { summary: "Every grant a role confers — tools, servers, agents and connectors." },
  "GET /v1/roles/:roleId/assignments": { summary: "The users currently holding a role." },
  "POST /v1/users/:userId/roles": { summary: "Assign a role to a user.", body: assignRoleSchema },
  "DELETE /v1/users/:userId/roles/:roleId": { summary: "Remove a role assignment." },
  "GET /v1/users/:userId/agents": { summary: "The agents this user is entitled to dispatch." },
  "GET /v1/users/:userId/connectors": { summary: "The connectors this user is entitled to invoke." },
  "GET /v1/users/:userId/servers/:serverId/tools": { summary: "The tools of one MCP server this user may actually see and call." },

  "POST /v1/evaluate": {
    summary: "The governance decision itself: may this user call this tool, right now, with this input? Returns the effect and the rule chain that produced it.",
    body: evaluateRequestSchema,
  },

  "GET /v1/approvals": { summary: "The approvals queue, scoped to what the caller may see." },
  "POST /v1/approvals/:approvalId/decide": {
    summary: "Approve or deny a pending request. Non-admin by design — the named approver is usually not an admin.",
    body: decideApprovalSchema,
  },

  "GET /v1/projects": { summary: "Projects visible to the caller." },
  "POST /v1/projects": { summary: "Create a project.", body: createProjectSchema },
  "GET /v1/projects/:projectId/costs": { summary: "Per-project AI spend, attributed at the point of every gateway call (pillar 5)." },
  "GET /v1/projects/:projectId/costs.csv": { summary: "The same ledger as a streamed CSV export." },
  "GET /v1/cost-events": { summary: "The raw cost ledger, one row per priced gateway call." },
  "GET /v1/usage-events": { summary: "The raw usage ledger, one row per governed call (priced or not)." },

  "GET /v1/workflows/instances": { summary: "Workflow instances." },
  "POST /v1/workflows/instances": { summary: "Start a workflow instance from a template." },
  "GET /v1/workflows/instances/:instanceId": {
    summary: "One workflow instance with its stage history.",
    responseNote:
      "`instance.round` is the workflow round (bumped by every re-open — artifact resubmitted, sign-off returned); a CI binds its check report to it. `instance.stageEntry` moves on every entry into an executable stage (AER-048).",
  },
  "POST /v1/workflows/instances/:instanceId/checks": {
    summary:
      "Report per-check results into an automated_check stage. AER-048: `round` binds the results to the workflow round they were produced for — a report for any other round is refused 409 `stale_check_report` (audited). A key-authenticated caller (CI) MUST send it (422 `round_required`) unless the org setting `checkReportsAllowUnbound` is on; a console session may omit it, binding to the current round.",
    body: reportChecksSchema,
    responseNote:
      "200 with `evaluation: \"evaluated\"` (the stage re-evaluated on this report) or `\"stored_for_later\"` (the stage is not executing yet); 202 with `evaluation: \"deferred_to_running_executor\"` when another executor is mid-evaluation of the stage — it folds this report into its verdict, or re-evaluates once if it ends without committing. Always carries `round`.",
  },
  "POST /v1/workflows/instances/:instanceId/advance": { summary: "Advance a workflow instance past its current stage, subject to that stage's gates." },

  "GET /v1/audit": { summary: "The audit log — every governed decision, paged, filterable by user, object type, effect and time window." },
  "GET /v1/audit.csv": { summary: "The audit log as a streamed CSV export, with an explicit disclosure when rows fall outside the exported window." },

  "POST /v1/agents/:agentId/invoke": { summary: "Dispatch an agent. Governed, metered and audited like every other gateway call.", body: invokeAgentSchema },
  "POST /v1/connectors/:connectorId/invoke": { summary: "Invoke a connector.", body: invokeConnectorSchema },
  "GET /v1/agents": { summary: "Registered agents/models. Bounded: `limit` (default 1000, max 5000)." },
  "GET /v1/connectors": { summary: "Registered connectors." },
  "GET /v1/servers": { summary: "Registered MCP servers." },

  "POST /v1/messages": { summary: "Anthropic-shaped compatibility surface (ADR-0020). Off-the-shelf Anthropic clients point here unchanged." },
  "POST /v1/chat/completions": { summary: "OpenAI-shaped compatibility surface (ADR-0024). Off-the-shelf OpenAI clients point here unchanged." },
  "POST /mcp/:serverId": { summary: "The governed MCP proxy. Speaks the MCP wire protocol; every tool call is entitlement-checked." },
  "POST /v1/runs": { summary: "Start a multi-agent orchestration run (pillar 7)." },
  "GET /v1/runs": { summary: "Orchestration runs, newest first. Bounded: `limit` (default 200, max 1000); `status` narrows." },
  "GET /v1/runs/:runId": { summary: "One orchestration run with its task graph." },
  "POST /v1/runs/decompose": { summary: "Decompose a goal into a task DAG without executing it." },
  "GET /v1/reports/runs": { summary: "Generated report runs the caller may see." },
  "GET /v1/reports/runs/:id": { summary: "One report run." },
  "GET /v1/spend/forecast": { summary: "Spend projection for the caller's own projects." },
  "GET /v1/spend/anomalies": { summary: "Anomaly flags for the caller's own projects." },
  "GET /v1/billing/statements": { summary: "Billing statements the caller may see." },
  "GET /v1/billing/statements/:id": { summary: "One billing statement." },
  "GET /v1/lineage": { summary: "Context provenance edges, narrowed to the caller's project memberships." },
  "GET /v1/lineage/runs/:runId": { summary: "Lineage for one orchestration run." },
  "GET /v1/lineage/nodes": { summary: "Lineage nodes." },
  "POST /v1/evals/runs": { summary: "Start an evaluation run. Governed by the caller's own agent entitlement." },
  "POST /v1/conversations": { summary: "Create a conversation." },
  "GET /v1/conversations": { summary: "The caller's conversations." },
  "GET /v1/conversations/:conversationId": { summary: "One conversation." },
  "DELETE /v1/conversations/:conversationId": { summary: "Delete a conversation." },
};

// ===========================================================================
// 3. THE DOCUMENT BUILDER
// ===========================================================================

const PUBLIC_STABILITIES: ReadonlySet<Stability> = new Set<Stability>(["public-stable", "public-beta"]);

export function routeKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}

/** `/v1/users/:userId` -> `/v1/users/{userId}` (OpenAPI path templating) */
export function openApiPath(url: string): string {
  return url.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\/\*$/, "/{wildcard}");
}

export function pathParams(url: string): string[] {
  return [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

/**
 * The OpenAPI `security` requirement for an auth class. There is exactly one
 * credential type per class and it is derived, never declared twice.
 */
function securityFor(auth: RouteAuthClass): Array<Record<string, string[]>> {
  switch (auth) {
    case "public":
      return [];
    case "scim-token":
      return [{ scimToken: [] }];
    default:
      return [{ apiKey: [] }];
  }
}

function jsonSchemaFor(schema: ZodTypeAny): Record<string, unknown> {
  const out = zodToJsonSchema(schema, { $refStrategy: "none", target: "openApi3" }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

export interface BuildSpecOptions {
  /** include `internal` routes too. Admin-only, and never the published file. */
  includeInternal?: boolean;
  /** absolute base URL to advertise; omitted means "relative to this host" */
  serverUrl?: string;
  version?: string;
}

export function buildOpenApiDocument(
  inventory: readonly RouteInventoryEntry[],
  opts: BuildSpecOptions = {},
): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const tags = new Set<string>();

  for (const entry of inventory) {
    const key = routeKey(entry.method, entry.url);
    const stability = ROUTE_STABILITY[key];
    // An unregistered route reaching here means the registry is stale. The
    // spec REFUSES to invent an entry — openapi.test.ts is what turns that into
    // a red build, and skipping quietly here would defeat it.
    if (!stability) continue;
    if (!opts.includeInternal && !PUBLIC_STABILITIES.has(stability)) continue;

    const auth = routeAuthClass(entry.method, entry.url);
    const doc = ROUTE_DOCS[key];
    const tag = ROUTE_TAGS[key] ?? "misc";
    tags.add(tag);
    const deprecation = DEPRECATIONS[key];
    const compat = COMPAT_SURFACES[key];

    const operation: Record<string, unknown> = {
      operationId: operationIdFor(entry.method, entry.url),
      summary: doc?.summary ?? `${entry.method} ${entry.url}`,
      tags: [tag],
      security: securityFor(auth),
      "x-regulait-stability": stability,
      // The DOCUMENTED credential, computed from the sets the gateway's gates
      // branch on. Not a second opinion — the same objects.
      "x-regulait-auth": auth,
      "x-regulait-guarantee":
        stability === "internal" ? "none" : VERSIONING_POLICY.guarantees[stability],
    };
    if (compat) {
      operation["x-regulait-compat-surface"] = compat;
      operation.description =
        (doc?.summary ? doc.summary + " " : "") +
        `Request and response bodies conform to the upstream vendor schema at ${compat}; ` +
        "RegulAIt deliberately does not re-specify a shape it does not own.";
    }
    if (deprecation) {
      operation.deprecated = true;
      operation["x-regulait-deprecation"] = deprecation;
    }

    const params = pathParams(entry.url).map((name) => ({
      name,
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    if (params.length > 0) operation.parameters = params;

    if (doc?.body) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: jsonSchemaFor(doc.body) } },
      };
    } else if (["POST", "PUT", "PATCH"].includes(entry.method) && !compat) {
      // Say it out loud in the artifact rather than publishing `{}` as if it
      // were the contract. ADR-0053 lists under-specified schemas as a known
      // consequence; an integrator deserves to see WHICH routes carry it.
      operation["x-regulait-schema"] = "unspecified";
    }

    operation.responses = {
      "2XX": { description: doc?.responseNote ?? "Success." },
      "400": { description: "Request body failed schema validation." },
      ...(auth === "public"
        ? {}
        : { "401": { description: "Missing, invalid, or revoked credential." } }),
      ...(auth === "admin" ? { "403": { description: "Caller is not an administrator." } } : {}),
      "429": { description: "Rate limited. Retry after the `retry-after` header." },
    };

    const p = openApiPath(entry.url);
    paths[p] ??= {};
    paths[p]![entry.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.0.3",
    info: {
      title: "RegulAIt Management API",
      version: opts.version ?? "1.0.0",
      description:
        "The governed front door to a RegulAIt deployment. Every call documented here is an " +
        "ordinary gateway call: it passes the same policy kernel, the same metering, and the " +
        "same audit path as any other request. Exposure in this document grants nothing that " +
        "entitlement did not already grant.\n\n" +
        "Generated from the live Fastify route inventory and the zod schemas the handlers " +
        "enforce — never hand-maintained. See GET /v1/api/versioning for the deprecation policy.",
      "x-regulait-generated": "derived from route inventory + zod request schemas",
    },
    servers: opts.serverUrl ? [{ url: opts.serverUrl }] : [{ url: "/" }],
    tags: [...tags].sort().map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "An ADR-0025 API key: `Authorization: Bearer rgl_...`. The public API introduces " +
            "NO new credential — it documents the existing one. A browser session cookie is " +
            "accepted on the same routes but is not the programmatic path.",
        },
        scimToken: {
          type: "http",
          scheme: "bearer",
          description:
            "A SCIM provisioning token (ADR-0037) — a SEPARATE TRUST PATH. These routes " +
            "authenticate ONLY against `scim_tokens`; a human session or a user's API key is " +
            "refused here, and a SCIM token is refused everywhere else.",
        },
      },
    },
    "x-regulait-versioning": VERSIONING_POLICY,
    "x-regulait-deprecations": DEPRECATIONS,
  };
}

/** stable, human-readable operation ids the generated clients name methods from */
export function operationIdFor(method: string, url: string): string {
  const camel = (s: string) => s.replace(/[^A-Za-z0-9]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ""));
  const parts = url
    .split("/")
    .filter(Boolean)
    .map((seg) =>
      seg.startsWith(":")
        ? "By" + seg.slice(1, 2).toUpperCase() + seg.slice(2)
        : seg === "*"
          ? "Wildcard"
          : camel(seg),
    );
  const tail = parts.map((p, i) => (i === 0 ? p : p.slice(0, 1).toUpperCase() + p.slice(1))).join("");
  return method.toLowerCase() + tail.slice(0, 1).toUpperCase() + tail.slice(1);
}

// ===========================================================================
// 4. THE ROUTES
// ===========================================================================

export function registerOpenApiRoutes(app: FastifyInstance): void {
  /**
   * RFC 8594. A deprecated route SAYS SO on every response, without the caller
   * having to read the spec. Driven from `DEPRECATIONS`, so deprecating a route
   * is one edit that produces both the header and the spec entry — there is no
   * way to deprecate something and forget the header.
   */
  app.addHook("onSend", async (req, reply, payload) => {
    const key = routeKey(req.method, req.routeOptions.url ?? "");
    const dep = DEPRECATIONS[key];
    if (dep) {
      reply.header("deprecation", `@${Math.floor(Date.parse(dep.since) / 1000)}`);
      reply.header("sunset", new Date(dep.sunset).toUTCString());
      if (dep.replacement) reply.header("link", `<${dep.replacement}>; rel="successor-version"`);
    }
    return payload;
  });

  /**
   * The spec itself. In `NON_ADMIN_ROUTES` — any authenticated caller may read
   * the contract they are building against; it is deliberately not
   * unauthenticated, because the route list of a governance deployment is not
   * something to hand to an anonymous prober.
   *
   * `?include=all` renders the internal routes too and is refused for a
   * non-admin: those routes exist, but their shapes are ours to change and only
   * an operator of this deployment has a reason to see them.
   */
  app.get("/v1/openapi.json", async (req, reply) => {
    const includeAll = (req.query as { include?: string } | undefined)?.include === "all";
    if (includeAll && !req.authCtx.isAdmin) {
      return reply.status(403).send({
        error: "admin_only",
        detail: "internal routes carry no compatibility guarantee and are visible to administrators only",
      });
    }
    return buildOpenApiDocument(app.routeInventory, { includeInternal: includeAll });
  });

  /** the policy as data — the same object the document embeds */
  app.get("/v1/api/versioning", async () => ({
    ...VERSIONING_POLICY,
    deprecations: DEPRECATIONS,
    counts: stabilityCounts(app.routeInventory),
  }));
}

export function stabilityCounts(inventory: readonly RouteInventoryEntry[]): Record<string, number> {
  const counts: Record<string, number> = { "public-stable": 0, "public-beta": 0, internal: 0, unregistered: 0 };
  for (const e of inventory) {
    const s = ROUTE_STABILITY[routeKey(e.method, e.url)];
    counts[s ?? "unregistered"] = (counts[s ?? "unregistered"] ?? 0) + 1;
  }
  return counts;
}
