/**
 * ADR-0353 part 1 — GOVERNED MCP TOOLS FROM A CUSTOMER'S OPENAPI DOCUMENT OR REST ENDPOINT LIST: the pure half.
 *
 * An admin imports an OpenAPI 3.x document (or a list of REST endpoints, turned into a minimal OpenAPI 3.1 document
 * here) and the gateway serves the operations an admin approved as MCP tools of an in-process `openapi` upstream.
 * This file decides nothing about the database or the request path. It owns:
 *   - the operation lifecycle as ONE declared machine (`OPENAPI_OPERATION_MACHINE`, ADR-0348 `defineMachine`), the
 *     function every write goes through (`nextOperationState`) and the events each state allows, so the server, the
 *     UI and an agent read the same machine;
 *   - the definition digest (RFC 8785 canonical JSON via `canonicalize`, SHA-256), the value an admin approves;
 *   - the re-import plan: which stored operation moves where;
 *   - the request shapes of the admin routes.
 */
import canonicalize from "canonicalize";
import { z } from "zod";
import { sha256Hex } from "./audit-chain.js";
import { OPENAPI_OPERATION_MACHINE, OPENAPI_OPERATION_STATES, type OpenApiOperationState } from "./state-machines.js";

// ---------------------------------------------------------------------------
// the lifecycle: one declared machine (ADR-0348 `defineMachine`), enforced server side
// ---------------------------------------------------------------------------

export { OPENAPI_OPERATION_MACHINE, OPENAPI_OPERATION_STATES, type OpenApiOperationState };

export type OpenApiOperationEvent = (typeof OPENAPI_OPERATION_MACHINE.events)[number];
export const OPENAPI_OPERATION_EVENTS = OPENAPI_OPERATION_MACHINE.events;

/** the events an admin sends through `POST .../operations/:operationId/:event` */
export const OPENAPI_OPERATION_ADMIN_EVENTS = ["approve", "reject", "revoke"] as const satisfies readonly OpenApiOperationEvent[];
export type OpenApiOperationAdminEvent = (typeof OPENAPI_OPERATION_ADMIN_EVENTS)[number];

/** Only an approved operation is served. A drifted one is withheld until an admin approves its new definition. */
export const OPENAPI_SERVED_STATE: OpenApiOperationState = "approved";

/** the state `event` moves `from` to, or null when the machine does not allow it */
export function nextOperationState(from: OpenApiOperationState, event: OpenApiOperationEvent): OpenApiOperationState | null {
  return OPENAPI_OPERATION_MACHINE.can(from, event) ? OPENAPI_OPERATION_MACHINE.next(from, event) : null;
}

/** the admin events a state allows (shown with each operation so a client offers only legal actions) */
export function allowedOperationEvents(state: OpenApiOperationState): OpenApiOperationAdminEvent[] {
  return OPENAPI_OPERATION_ADMIN_EVENTS.filter((e) => OPENAPI_OPERATION_MACHINE.can(state, e));
}

// ---------------------------------------------------------------------------
// the definition an admin approves
// ---------------------------------------------------------------------------

/** One parameter of the request template: where an input property goes (the `mcp-from-openapi` mapper, minus any
 * security entry: credentials are the server's, never an input). */
export interface OpenApiRequestMapping {
  inputKey: string;
  type: "path" | "query" | "header" | "cookie" | "body";
  key: string;
  required?: boolean;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
  wholeBody?: boolean;
  serialization?: { contentType?: string };
}

/** What one approved operation serves (the MCP tool) and sends (the request template). */
export interface OpenApiOperationDefinition {
  tool: {
    name: string;
    title?: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  };
  request: {
    method: string;
    path: string;
    mapper: OpenApiRequestMapping[];
  };
}

/** SHA-256 over the RFC 8785 canonical form, after a JSON round trip (so jsonb and the digest describe one value) */
export function openApiDefinitionDigest(definition: OpenApiOperationDefinition): string {
  const canonical = canonicalize(JSON.parse(JSON.stringify(definition)));
  if (canonical === undefined) throw new Error("the operation definition is not canonicalizable");
  return sha256Hex(canonical);
}

/** the stable key of an operation inside one source: the upper-case method and the path template */
export function openApiOperationKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

// ---------------------------------------------------------------------------
// the re-import plan
// ---------------------------------------------------------------------------

export interface StoredOpenApiOperation {
  id: string;
  operationKey: string;
  state: OpenApiOperationState;
  importedDigest: string;
  approvedDigest: string | null;
}

export interface ImportedOpenApiOperation {
  operationKey: string;
  digest: string;
}

export interface OpenApiReimportPlan {
  /** operations seen for the first time: inserted as staged */
  added: ImportedOpenApiOperation[];
  /** stored operations that move, with the event and the new state */
  moved: Array<{ id: string; operationKey: string; event: OpenApiOperationEvent; from: OpenApiOperationState; to: OpenApiOperationState; digest: string | null }>;
  /** stored operations whose definition did not change, or whose state allows no move: left as they are */
  unchanged: string[];
}

export function planOpenApiReimport(
  stored: readonly StoredOpenApiOperation[],
  imported: readonly ImportedOpenApiOperation[],
): OpenApiReimportPlan {
  const byKey = new Map(imported.map((o) => [o.operationKey, o]));
  const storedKeys = new Set(stored.map((s) => s.operationKey));
  const plan: OpenApiReimportPlan = { added: imported.filter((o) => !storedKeys.has(o.operationKey)), moved: [], unchanged: [] };
  for (const s of stored) {
    const next = byKey.get(s.operationKey);
    let event: OpenApiOperationEvent | null;
    if (!next) event = s.state === "withdrawn" ? null : "reimport_missing";
    else if (s.state === "withdrawn") event = "reimport_present";
    else if (next.digest === s.importedDigest) event = null;
    else if (s.state === "drifted" && next.digest === s.approvedDigest) event = "reimport_reverted";
    else event = s.state === "approved" || s.state === "drifted" ? "reimport_changed" : "reimport_restaged";
    const to = event ? nextOperationState(s.state, event) : null;
    if (!event || !to) {
      plan.unchanged.push(s.id);
      continue;
    }
    plan.moved.push({ id: s.id, operationKey: s.operationKey, event, from: s.state, to, digest: next?.digest ?? null });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// REST endpoint lists → a minimal OpenAPI 3.1 document (one generator for both inputs)
// ---------------------------------------------------------------------------

export const OPENAPI_HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export const OPENAPI_MAX_SPEC_BYTES = 2 * 1024 * 1024;
export const OPENAPI_MAX_OPERATIONS = 200;
export const OPENAPI_SOURCE_NAME = /^[a-z0-9][a-z0-9-]{1,62}$/;
/** an OpenAPI path template: absolute, no query or fragment, no dot segment, `{name}` parameters */
const PATH_TEMPLATE = /^\/(?:[A-Za-z0-9\-._~!$&'()*+,;=:@%]|\{[A-Za-z_][A-Za-z0-9_]{0,63}\}|\/)*$/;

export const restEndpointSchema = z
  .object({
    method: z.enum(OPENAPI_HTTP_METHODS),
    path: z
      .string()
      .min(1)
      .max(512)
      .regex(PATH_TEMPLATE, "an absolute path template such as /orders/{id}")
      .refine((p) => !p.split("/").some((seg) => seg === "." || seg === ".."), "a path has no '.' or '..' segment"),
    /** becomes the tool name; derived from the method and path when absent */
    operationId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).optional(),
    description: z.string().min(1).max(2000),
    /** a JSON Schema object for the JSON request body (POST/PUT/PATCH only) */
    bodySchema: z.record(z.string(), z.unknown()).optional(),
    /** query parameters, each a string unless a JSON Schema is given */
    query: z
      .array(z.object({ name: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), required: z.boolean().optional(), schema: z.record(z.string(), z.unknown()).optional() }).strict())
      .max(32)
      .optional(),
  })
  .strict();
export type RestEndpoint = z.infer<typeof restEndpointSchema>;

export function restEndpointsToOpenApi(title: string, endpoints: readonly RestEndpoint[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const e of endpoints) {
    const method = e.method.toLowerCase();
    const pathParams = [...e.path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
    const operation: Record<string, unknown> = {
      operationId: e.operationId ?? `${method}_${e.path.replace(/[{}]/g, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "root"}`.slice(0, 64),
      description: e.description,
      parameters: [
        ...pathParams.map((name) => ({ name, in: "path", required: true, schema: { type: "string" } })),
        ...(e.query ?? []).map((q) => ({ name: q.name, in: "query", required: q.required === true, schema: q.schema ?? { type: "string" } })),
      ],
      responses: { "200": { description: "OK" } },
    };
    if (e.bodySchema && method !== "get" && method !== "delete") {
      operation.requestBody = { required: true, content: { "application/json": { schema: e.bodySchema } } };
    }
    (paths[e.path] ??= {})[method] = operation;
  }
  return { openapi: "3.1.0", info: { title, version: "rest-endpoints" }, paths };
}

// ---------------------------------------------------------------------------
// admin request shapes
// ---------------------------------------------------------------------------

const specInput = {
  /** an OpenAPI 3.0 or 3.1 document as JSON or YAML text; never fetched from a URL */
  spec: z.string().min(2).max(OPENAPI_MAX_SPEC_BYTES).optional(),
  /** or a list of REST endpoints */
  endpoints: z.array(restEndpointSchema).min(1).max(OPENAPI_MAX_OPERATIONS).optional(),
};
const exactlyOneInput = (b: { spec?: unknown; endpoints?: unknown }) => (b.spec === undefined) !== (b.endpoints === undefined);
const ONE_INPUT = { message: "send exactly one of spec (an OpenAPI document) or endpoints (a REST endpoint list)" };

export const importOpenApiToolSourceSchema = z
  .object({
    /** the MCP server's name (lower-case letters, digits and '-') */
    name: z.string().regex(OPENAPI_SOURCE_NAME, "2 to 63 lower-case letters, digits or '-'"),
    /** the API's base URL; the document's own `servers` entries are never used */
    baseUrl: z.string().url().max(2048),
    /** null/absent inherits the org's MCP private-range default; true is a stepped-up relaxation */
    allowPrivateRanges: z.boolean().nullable().optional(),
    ownerUserId: z.string().uuid().optional(),
    ...specInput,
  })
  .strict()
  .refine(exactlyOneInput, ONE_INPUT);
export type ImportOpenApiToolSource = z.infer<typeof importOpenApiToolSourceSchema>;

export const reimportOpenApiToolSourceSchema = z.object(specInput).strict().refine(exactlyOneInput, ONE_INPUT);
export type ReimportOpenApiToolSource = z.infer<typeof reimportOpenApiToolSourceSchema>;

export const decideOpenApiOperationSchema = z
  .object({
    /** approve: the digest of the definition the admin reviewed (compare-and-set) */
    definitionDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict();
export type DecideOpenApiOperation = z.infer<typeof decideOpenApiOperationSchema>;
