/**
 * ADR-0353 part 1 — GOVERNED MCP TOOLS FROM AN OPENAPI DOCUMENT OR A REST ENDPOINT LIST: generation and serving.
 *
 * GENERATION. `mcp-from-openapi` (Apache-2.0, pinned 2.9.1) turns the document's operations into MCP tool definitions
 * and a parameter mapper. It is loaded only from text already in the request (`fromJSON` / `fromYAML`) with
 * `secureDefaults: true`: no spec URL is fetched, no redirect is followed and external `$ref` resolution is off. Our
 * code then keeps only what is governable: the pinned tool fields, a request template without any security entry (a
 * credential is the server's, never an input), read-only only for a safe HTTP method, and it skips an operation it
 * cannot serve safely (a multipart or binary body, an unresolved reference, a header the gateway owns, an input schema
 * that does not compile under the RE2-backed validator).
 *
 * SERVING. An `openapi` MCP server is not a socket: `guardedMcpConnect` connects the MCP client to the in-process
 * server below over the SDK's `InMemoryTransport`. So the manifest still passes `syncUpstreamTools` (ADR-0097
 * admission scanning, ADR-0246 definition pinning) and every call still goes through `executeGovernedToolCall`
 * (ADR-0251). This server lists only APPROVED operations, re-reads the state on every call, validates the arguments
 * against the approved input schema, builds the request with the library's pure `buildHttpRequest` against the
 * admin's base URL, refuses a URL that leaves the base URL's origin or path, and sends it through the guarded fetch
 * `guardedMcpConnect` gave it (egress allow-list, DNS-pinned, no redirects, the ADR-0204 credential added for that
 * origin only, a 1 MiB response bound).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { and, eq, openapiToolOperations, openapiToolSources, type Db } from "@regulait/db";
import {
  OPENAPI_MAX_OPERATIONS,
  OPENAPI_SERVED_STATE,
  openApiDefinitionDigest,
  openApiOperationKey,
  restEndpointsToOpenApi,
  sha256Hex,
  type OpenApiOperationDefinition,
  type OpenApiRequestMapping,
  type RestEndpoint,
} from "@regulait/shared";
import { buildHttpRequest, OpenAPIToolGenerator, type McpOpenAPITool } from "mcp-from-openapi";
import { errMessage } from "./err-serializer.js";
import { validateJsonSchemaShape, validateValueAgainstSchema } from "./json-schema-check.js";

/** the most response text an OpenAPI tool returns to the model */
export const OPENAPI_TOOL_MAX_RESPONSE_BYTES = 1024 * 1024;
/** the bound on one upstream API request */
export const OPENAPI_TOOL_REQUEST_TIMEOUT_MS = 30_000;

/** headers the gateway owns: a generated tool never lets a model set them */
const RESERVED_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "forwarded",
]);
const RESERVED_HEADER_PREFIXES = ["x-forwarded-", "x-regulait-", "proxy-"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface GeneratedOperation {
  operationKey: string;
  toolName: string;
  definition: OpenApiOperationDefinition;
  digest: string;
}

export interface GeneratedSource {
  sourceKind: "openapi" | "rest_endpoints";
  title: string | null;
  version: string | null;
  specDigest: string;
  operations: GeneratedOperation[];
  /** operations the gateway will not serve, each with the reason (shown to the admin, never silent) */
  skipped: Array<{ operationKey: string; reason: string }>;
}

export class OpenApiImportError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "OpenApiImportError";
  }
}

function headerReserved(name: string): boolean {
  const n = name.toLowerCase();
  return RESERVED_HEADERS.has(n) || RESERVED_HEADER_PREFIXES.some((p) => n.startsWith(p));
}

/** true when any `$ref` is left in the value (an external reference the secure loader did not resolve) */
function hasUnresolvedRef(value: unknown, depth = 0): boolean {
  if (depth > 64 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasUnresolvedRef(v, depth + 1));
  for (const [k, v] of Object.entries(value)) {
    if (k === "$ref") return true;
    if (hasUnresolvedRef(v, depth + 1)) return true;
  }
  return false;
}

/** the governable projection of one generated tool, or the reason it is skipped */
function project(tool: McpOpenAPITool): { definition: OpenApiOperationDefinition } | { reason: string } {
  const method = String(tool.metadata?.method ?? "").toUpperCase();
  const path = String(tool.metadata?.path ?? "");
  if (!method || !path.startsWith("/")) return { reason: "the operation has no method or path" };
  if (!TOOL_NAME.test(tool.name)) return { reason: `the tool name '${tool.name.slice(0, 80)}' is not 1-64 letters, digits, '_' or '-'` };
  const mapper: OpenApiRequestMapping[] = [];
  for (const m of tool.mapper ?? []) {
    if (m.security) continue; // credentials are the server's (ADR-0204), never an input
    if (!m.inputKey || !m.type || !m.key) return { reason: "a parameter could not be resolved (an external or broken $ref)" };
    if (m.serialization?.binary || (m.serialization?.contentType ?? "").startsWith("multipart/")) {
      return { reason: "multipart and binary request bodies are not supported" };
    }
    if ((m.type === "header" || m.type === "cookie") && (m.type === "cookie" || headerReserved(m.key))) {
      return { reason: m.type === "cookie" ? "cookie parameters are not supported" : `the header '${m.key}' is set by the gateway, never by a tool` };
    }
    mapper.push({
      inputKey: m.inputKey,
      type: m.type,
      key: m.key,
      ...(m.required !== undefined ? { required: m.required } : {}),
      ...(m.style !== undefined ? { style: m.style } : {}),
      ...(m.explode !== undefined ? { explode: m.explode } : {}),
      ...(m.allowReserved !== undefined ? { allowReserved: m.allowReserved } : {}),
      ...(m.wholeBody !== undefined ? { wholeBody: m.wholeBody } : {}),
      ...(m.serialization?.contentType ? { serialization: { contentType: m.serialization.contentType } } : {}),
    });
  }
  // read-only follows the HTTP method: an extension may make a GET stricter, never a write read-only
  const annotations: Record<string, unknown> = { ...(tool.annotations ?? {}) };
  annotations.readOnlyHint = SAFE_METHODS.has(method) && tool.annotations?.readOnlyHint !== false;
  if (annotations.readOnlyHint !== true) annotations.destructiveHint = tool.annotations?.destructiveHint ?? true;
  const definition: OpenApiOperationDefinition = {
    tool: {
      name: tool.name,
      ...(tool.title ? { title: tool.title.slice(0, 200) } : {}),
      description: (tool.description || `${method} ${path}`).slice(0, 4000),
      inputSchema: tool.inputSchema as Record<string, unknown>,
      // no outputSchema: an MCP client then requires structured content that matches it, and a real API's replies
      // drift from its document; the reply is returned as text instead
      annotations,
    },
    request: { method, path, mapper },
  };
  if (hasUnresolvedRef(definition)) return { reason: "the operation uses a $ref that was not resolved (external references are never fetched)" };
  const schemaProblems = validateJsonSchemaShape(definition.tool.inputSchema);
  if (schemaProblems.length > 0) return { reason: `its input schema does not compile: ${schemaProblems[0]}` };
  return { definition };
}

/**
 * Turn an imported document (JSON or YAML text) or a REST endpoint list into the operations a source would serve.
 * Throws `OpenApiImportError` (a 422) for a document that cannot be read; an operation that cannot be served is
 * skipped with its reason.
 */
export async function generateOpenApiOperations(
  input: { spec: string; endpoints?: undefined } | { spec?: undefined; endpoints: readonly RestEndpoint[] },
  fallbackTitle: string,
): Promise<GeneratedSource> {
  const options = { secureDefaults: true, validate: true, dereference: true } as const;
  let generator: OpenAPIToolGenerator;
  let specDigest: string;
  let sourceKind: GeneratedSource["sourceKind"];
  try {
    if (input.spec !== undefined) {
      sourceKind = "openapi";
      specDigest = sha256Hex(input.spec);
      const text = input.spec.trim();
      let parsed: unknown = undefined;
      if (text.startsWith("{")) {
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new OpenApiImportError("the document starts like JSON but is not valid JSON");
        }
      }
      generator = parsed !== undefined ? await OpenAPIToolGenerator.fromJSON(parsed as object, options) : await OpenAPIToolGenerator.fromYAML(text, options);
    } else {
      sourceKind = "rest_endpoints";
      const doc = restEndpointsToOpenApi(fallbackTitle, input.endpoints);
      specDigest = sha256Hex(JSON.stringify(input.endpoints));
      generator = await OpenAPIToolGenerator.fromJSON(doc, options);
    }
  } catch (err) {
    if (err instanceof OpenApiImportError) throw err;
    // the library's message names the problem in the document; it never contains a credential (none is sent)
    throw new OpenApiImportError(`the document could not be read as OpenAPI 3.x: ${errMessage(err).slice(0, 300)}`);
  }
  const doc = generator.getDocument() as { openapi?: unknown; info?: { title?: unknown; version?: unknown } };
  if (typeof doc.openapi !== "string" || !/^3\.[01]\./.test(doc.openapi)) {
    throw new OpenApiImportError("only OpenAPI 3.0 and 3.1 documents are supported");
  }
  let tools: McpOpenAPITool[];
  try {
    tools = await generator.generateTools({ includeDeprecated: false });
  } catch (err) {
    throw new OpenApiImportError(`the operations could not be generated: ${errMessage(err).slice(0, 300)}`);
  }
  if (tools.length > OPENAPI_MAX_OPERATIONS) {
    throw new OpenApiImportError(`the document has ${tools.length} operations; at most ${OPENAPI_MAX_OPERATIONS} can be imported as one source`);
  }
  const operations: GeneratedOperation[] = [];
  const skipped: GeneratedSource["skipped"] = [];
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const tool of tools) {
    const operationKey = openApiOperationKey(String(tool.metadata?.method ?? ""), String(tool.metadata?.path ?? ""));
    const out = project(tool);
    if ("reason" in out) {
      skipped.push({ operationKey, reason: out.reason });
      continue;
    }
    if (names.has(out.definition.tool.name) || keys.has(operationKey)) {
      skipped.push({ operationKey, reason: `the tool name '${out.definition.tool.name}' or the operation is generated twice` });
      continue;
    }
    names.add(out.definition.tool.name);
    keys.add(operationKey);
    operations.push({ operationKey, toolName: out.definition.tool.name, definition: out.definition, digest: openApiDefinitionDigest(out.definition) });
  }
  const title = typeof doc.info?.title === "string" ? doc.info.title.slice(0, 200) : null;
  const version = typeof doc.info?.version === "string" ? doc.info.version.slice(0, 100) : null;
  return { sourceKind, title, version, specDigest, operations, skipped };
}

/** the source behind an `openapi` MCP server (null when the row has none: the connect is refused) */
export async function openApiSourceForServer(db: Db, serverId: string): Promise<{ id: string; baseUrl: string } | null> {
  const [row] = await db
    .select({ id: openapiToolSources.id, baseUrl: openapiToolSources.baseUrl })
    .from(openapiToolSources)
    .where(eq(openapiToolSources.mcpServerId, serverId));
  return row ?? null;
}

/**
 * The URL a call on this MCP server actually reaches: the source's base URL for an `openapi` row, the registered URL
 * otherwise. For checks that look at the destination (the ADR-0186 credential-audience check), never the sentinel.
 */
export async function mcpCallDestinationUrl(db: Db, row: { id: string; url: string; transport?: string | null }): Promise<string> {
  if (row.transport !== "openapi") return row.url;
  return (await openApiSourceForServer(db, row.id))?.baseUrl ?? row.url;
}

async function approvedOperations(db: Db, sourceId: string) {
  return db
    .select({ toolName: openapiToolOperations.toolName, definition: openapiToolOperations.approvedDefinition })
    .from(openapiToolOperations)
    .where(and(eq(openapiToolOperations.sourceId, sourceId), eq(openapiToolOperations.state, OPENAPI_SERVED_STATE)))
    .orderBy(openapiToolOperations.toolName);
}

function toolError(text: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text }] };
}

/** a path parameter that would move the request up a level once the URL is normalised */
function dotSegmentValue(definition: OpenApiOperationDefinition, args: Record<string, unknown>): string | null {
  for (const m of definition.request.mapper) {
    if (m.type !== "path") continue;
    const v = args[m.inputKey];
    if (v === "." || v === "..") return m.inputKey;
  }
  return null;
}

/** is `built` inside the base URL (same origin, and under its path)? */
export function insideBaseUrl(baseUrl: string, built: string): boolean {
  let base: URL;
  let target: URL;
  try {
    base = new URL(baseUrl);
    target = new URL(built);
  } catch {
    return false;
  }
  if (target.origin !== base.origin) return false;
  const root = base.pathname.replace(/\/+$/, "");
  return target.pathname === root || target.pathname === `${root}/` || target.pathname.startsWith(`${root}/`);
}

/**
 * The in-process MCP server of one `openapi` source. `fetchImpl` is the guarded fetch `guardedMcpConnect` built for
 * the base URL (egress decision, credential, response bound); it is the only way out.
 */
export function createOpenApiMcpServer(db: Db, source: { id: string; baseUrl: string }, fetchImpl: typeof fetch): Server {
  const server = new Server({ name: "regulait-openapi-tools", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const rows = await approvedOperations(db, source.id);
    const tools: Tool[] = rows.flatMap((r) => (r.definition ? [(r.definition as OpenApiOperationDefinition).tool as Tool] : []));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    // re-read per call: an operation revoked or drifted since the manifest was listed is not called
    const [row] = await db
      .select({ definition: openapiToolOperations.approvedDefinition })
      .from(openapiToolOperations)
      .where(
        and(
          eq(openapiToolOperations.sourceId, source.id),
          eq(openapiToolOperations.toolName, req.params.name),
          eq(openapiToolOperations.state, OPENAPI_SERVED_STATE),
        ),
      );
    if (!row?.definition) return toolError(`the tool '${req.params.name}' is not an approved operation of this API; nothing was sent`);
    const definition = row.definition as OpenApiOperationDefinition;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const check = validateValueAgainstSchema(definition.tool.inputSchema, args);
    if (!check.valid) return toolError(`the arguments do not match the tool's input schema (${check.errors.join("; ")}); nothing was sent`);
    const dot = dotSegmentValue(definition, args);
    if (dot) return toolError(`the path parameter '${dot}' may not be '.' or '..'; nothing was sent`);
    let built: ReturnType<typeof buildHttpRequest>;
    try {
      built = buildHttpRequest(
        {
          name: definition.tool.name,
          description: definition.tool.description,
          inputSchema: definition.tool.inputSchema,
          mapper: definition.request.mapper,
          metadata: { path: definition.request.path, method: definition.request.method.toLowerCase(), servers: [] },
        } as unknown as McpOpenAPITool,
        args,
        { baseUrl: source.baseUrl },
      );
    } catch (err) {
      return toolError(`the request could not be built: ${errMessage(err).slice(0, 300)}; nothing was sent`);
    }
    if (!insideBaseUrl(source.baseUrl, built.url)) {
      return toolError("the request would leave the API's base URL; nothing was sent");
    }
    for (const name of Object.keys(built.headers)) {
      if (headerReserved(name)) return toolError(`the header '${name}' is set by the gateway, never by a tool; nothing was sent`);
    }
    let res: Response;
    try {
      res = await fetchImpl(built.url, {
        method: built.method,
        headers: built.headers,
        ...(built.body !== undefined ? { body: built.body as RequestInit["body"] } : {}),
        signal: AbortSignal.timeout(OPENAPI_TOOL_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      return toolError(`the API request failed: ${errMessage(err).slice(0, 300)}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      return toolError(`the API response could not be read: ${errMessage(err).slice(0, 300)}`);
    }
    const result: CallToolResult = { content: [{ type: "text", text }] };
    if (!res.ok) return { ...result, isError: true, content: [{ type: "text", text: `HTTP ${res.status}\n${text}` }] };
    return result;
  });

  return server;
}
