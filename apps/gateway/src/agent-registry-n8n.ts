/**
 * ADR-0336 slice 3: the n8n adapter's read path. It reads an n8n instance's workflows through the public REST API
 * (`GET /api/v1/workflows`, cursor-paged, `excludePinnedData=true`) and stages every workflow that holds an AI agent as
 * a registry record, with the models, tools, MCP servers, knowledge stores and credentials its agent uses as
 * components.
 *
 * An AI agent here is any node that RECEIVES an `ai_languageModel` connection (the agent, chain and assistant root
 * nodes all do); the nodes that feed one over an `ai_*` connection are its components. This reads the workflow graph,
 * not a list of node type names, so a new root or tool node type is picked up without a code change.
 *
 * Credential (decision 5): an n8n API key (`X-N8N-API-KEY`), static only. Checked on EVERY run, before anything else:
 * n8n 2.14 and later answer `GET /api/v1/discover` with the key's own scopes. Any scope that is not a `:read` or
 * `:list` scope refuses the key (the worker marks it `refused`, nothing is read); only `:read`/`:list` scopes record
 * it `read_only`. An older instance has no such endpoint and, before 2.14 outside Enterprise, gives every key full
 * scope, so its run reports `unverified`. Because that cannot be known when the key is stored, storing and enabling
 * any n8n key is recorded as a relaxation (`credentialScope: "unverified"`). The endpoint allow-list keeps the key on
 * two GET paths, `/api/v1/discover` and `/api/v1/workflows` (never `/credentials`, never an activate or deactivate
 * path). The source's docs ask for a key with only `workflow:list` and `workflow:read`.
 *
 * Never a secret, an instruction or prompt text (decision 4): from each node only its id, name, type, `disabled`
 * flag, a model name, an MCP endpoint reduced to scheme, host and port, and its credential references (type, id and
 * name: never credential material) are kept. A system message, prompt, tool description, HTTP parameter or pinned
 * data is never read into a record. Pinned data is excluded at the source.
 *
 * Plaintext credentials (decision 4, slice 4): every string parameter of every node of an agent workflow (a system
 * message, an HTTP tool's header value, a code node's source) is passed in memory through the vendored secret matcher.
 * A hit is reported as `agent_config` evidence by its path (`workflows/<id>/nodes/<node id>/parameters/<keys>`, built
 * from ids and parameter keys only) and its rule id. The text is dropped when the page is done.
 *
 * Paging passes `nextCursor` back as the `cursor` query parameter on our own first URL, after a shape check; no URL
 * from a response is ever fetched.
 *
 * TARGET (key=value fields on the source): baseUrl (`https://<host>[:port][/<path prefix>]`, the instance's address;
 * an n8n Cloud instance is `https://<name>.app.n8n.cloud`; a private address is reachable only through the guarded
 * fetch's egress allow-list). Scope: organisation-level = every agent workflow; include = workflow ids.
 */
import type { DiscoveryReadOutcome } from "@regulait/shared";
import { allowListedFetch, type EndpointRule } from "./agent-platform-endpoints.js";
import { REGISTRY_COMPONENTS_PER_RECORD_MAX } from "./agent-registry-records.js";
import { ConfigSecretCollector, attrs, finishRegistry, fullyRead, includeSet, pathSegment, type ConfigField } from "./agent-registry-scanners.js";
import { scannerFetch } from "./discovery-cloud-scanners.js";
import { ITEM_CAP, ReadFailure, WIDER_MAX_ITEMS, WiderSourceConfigError, atPath, getJson, httpsTargetProblem, readListing, str } from "./discovery-wider-scanners.js";
import type { RegistryAgentComponent, RegistryAgentRecord, ScanContext, ScanResult, Scanner } from "./discovery-scanners.js";

const KIND = "agent_registry_n8n";
/** the page size asked for: small, since a workflow carries its whole node graph */
export const N8N_PAGE_LIMIT = 50;
/** at most this many nodes of one workflow are looked at; a larger workflow's components read as partial */
export const N8N_NODES_PER_WORKFLOW_MAX = 1_000;
/** a path prefix for an instance served below the root: up to 4 segments of letters, digits, `.`, `_` or `-` */
const PREFIX = /^(?:\/[A-Za-z0-9._-]{1,64}){0,4}$/;
/** n8n workflow ids: 16 alphanumerics today, small integers on older instances */
const WORKFLOW_ID = /^[A-Za-z0-9]{1,64}$/;
/** an n8n cursor is an opaque base64 string */
const CURSOR = /^[A-Za-z0-9+/=_-]{1,2048}$/;
/** a model name as n8n stores it (`gpt-4o-mini`, `models/gemini-1.5-pro`, `anthropic.claude-3-5-sonnet-20241022-v2:0`) */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/** an n8n credential type name (`openAiApi`, `httpHeaderAuth`) */
const CREDENTIAL_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const CREDENTIAL_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** the instance address of a target, normalised: origin and path prefix, no trailing slash; null when not accepted */
export function n8nBase(raw: string | undefined): { origin: string; prefix: string } | null {
  if (!raw || httpsTargetProblem(raw, "baseUrl")) return null;
  const u = new URL(raw);
  if (u.search) return null;
  const prefix = u.pathname.replace(/\/+$/, "");
  if (!PREFIX.test(prefix)) return null;
  // the prefix must not itself reach into the API: the adapter adds /api/v1/workflows
  if (/\/api(?:\/|$)/i.test(prefix)) return null;
  return { origin: u.origin, prefix };
}

export function n8nTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (!n8nBase(target.baseUrl)) return "'baseUrl' must be the n8n instance's https address (https://<host>[:port][/<path prefix>], no query, no credentials, not an /api path)";
  if (!scope.orgLevel && (scope.include.length === 0 || scope.include.some((x) => !WORKFLOW_ID.test(x.trim())))) return "the scope names n8n workflow ids";
  return null;
}

/** decision 5: the only calls this adapter makes, for an instance at `prefix`, both GET */
export function n8nEndpoints(prefix: string): readonly EndpointRule[] {
  if (!PREFIX.test(prefix)) throw new Error("not an n8n path prefix");
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
  return Object.freeze([
    { method: "GET", path: new RegExp(`^${escaped}/api/v1/discover$`) },
    { method: "GET", path: new RegExp(`^${escaped}/api/v1/workflows$`) },
  ]);
}
/** a read scope: `workflow:read`, `workflow:list`, `workflowTags:list`; anything else may change the instance */
const READ_SCOPE = /^[A-Za-z][A-Za-z0-9]{0,63}:(?:read|list)$/;
/** the allow-list for an instance served at the root, as the adapter list declares it */
export const N8N_ENDPOINTS: readonly EndpointRule[] = n8nEndpoints("");

/** the next page: our own first URL with the shape-checked cursor; PARTIAL when the cursor cannot be passed back */
function cursorNext(first: string, body: unknown): string | null | typeof PARTIAL {
  const raw = body && typeof body === "object" && Object.hasOwn(body, "nextCursor") ? (body as Record<string, unknown>).nextCursor : null;
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || !CURSOR.test(raw)) return PARTIAL;
  const next = new URL(first);
  next.searchParams.set("cursor", raw);
  return next.toString();
}
const PARTIAL = Symbol("partial");

/** an MCP or tool endpoint reduced to scheme, host and port (decision 4); null when it is not an http(s) URL */
export function endpointOrigin(raw: unknown): string | null {
  const s = str(raw, 2048);
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** a model name from a node's parameters: a plain string, or n8n's resource-locator `{ value }`; never anything else */
function modelName(params: unknown): string | null {
  for (const key of ["model", "modelName"]) {
    const v = atPath(params, key);
    const name = typeof v === "string" ? v : str(atPath(v, "value"), 256);
    if (name && MODEL_NAME.test(name.trim())) return name.trim();
  }
  return null;
}

type ComponentEdge = "model" | "tool" | "knowledge";
/** which `ai_*` connection types make the feeding node a component, and of what kind */
const EDGE_KIND: Readonly<Record<string, ComponentEdge>> = Object.freeze({
  ai_languageModel: "model",
  ai_tool: "tool",
  ai_vectorStore: "knowledge",
  ai_retriever: "knowledge",
  ai_document: "knowledge",
});

interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  disabled: boolean;
  params: unknown;
  credentials: Array<{ type: string; id: string; name: string }>;
}

function readNode(n: unknown): WorkflowNode | null {
  const name = str(atPath(n, "name"), 256);
  const type = str(atPath(n, "type"), 200);
  if (!name || !type) return null;
  const credentials: WorkflowNode["credentials"] = [];
  const creds = n && typeof n === "object" && Object.hasOwn(n, "credentials") ? (n as Record<string, unknown>).credentials : null;
  if (creds && typeof creds === "object" && !Array.isArray(creds)) {
    for (const [ctype, ref] of Object.entries(creds as Record<string, unknown>).slice(0, 20)) {
      const id = str(atPath(ref, "id"), 64);
      if (!CREDENTIAL_TYPE.test(ctype) || !id || !CREDENTIAL_ID.test(id)) continue;
      credentials.push({ type: ctype, id, name: str(atPath(ref, "name"), 256) ?? ctype });
    }
  }
  return { id: str(atPath(n, "id"), 64) ?? name, name, type, disabled: atPath(n, "disabled") === true, params: atPath(n, "parameters"), credentials };
}

/**
 * The agents of one workflow and what they use. Returns null components when the graph could not be read in full
 * (too many nodes, an unreadable connection map), so the stored set is kept.
 */
export function workflowAgents(nodesRaw: unknown, connectionsRaw: unknown): { agents: number; components: RegistryAgentComponent[] | null } {
  if (!Array.isArray(nodesRaw)) return { agents: 0, components: null };
  const tooMany = nodesRaw.length > N8N_NODES_PER_WORKFLOW_MAX;
  const nodes = new Map<string, WorkflowNode>();
  for (const raw of nodesRaw.slice(0, N8N_NODES_PER_WORKFLOW_MAX)) {
    const n = readNode(raw);
    if (n) nodes.set(n.name, n);
  }
  if (!connectionsRaw || typeof connectionsRaw !== "object" || Array.isArray(connectionsRaw)) return { agents: 0, components: null };
  // feeder node name -> the edge kinds it feeds into an agent with; roots = nodes receiving a language model
  const roots = new Set<string>();
  const feeds: Array<{ from: string; to: string; edge: string }> = [];
  let unreadable = false;
  for (const [from, byType] of Object.entries(connectionsRaw as Record<string, unknown>)) {
    if (!byType || typeof byType !== "object" || Array.isArray(byType)) {
      unreadable = true;
      continue;
    }
    for (const [edge, outputs] of Object.entries(byType as Record<string, unknown>)) {
      if (!edge.startsWith("ai_")) continue;
      if (!Array.isArray(outputs)) {
        unreadable = true;
        continue;
      }
      for (const out of outputs) {
        if (!Array.isArray(out)) continue;
        for (const link of out) {
          const to = str(atPath(link, "node"), 256);
          if (!to) continue;
          feeds.push({ from, to, edge });
          if (edge === "ai_languageModel") roots.add(to);
        }
      }
    }
  }
  const agents = [...roots].filter((r) => nodes.has(r)).length;
  if (agents === 0) return { agents: 0, components: tooMany || unreadable ? null : [] };

  const components = new Map<string, RegistryAgentComponent>();
  const add = (c: RegistryAgentComponent) => components.set(`${c.kind}\u0000${c.vendorRef}`, c);
  for (const f of feeds) {
    if (!roots.has(f.to)) continue;
    const kind = EDGE_KIND[f.edge];
    const node = nodes.get(f.from);
    if (!kind || !node) continue;
    const enabled = !node.disabled;
    if (kind === "model") {
      const model = modelName(node.params);
      add({ kind: "model", vendorRef: `${node.type}:${model ?? node.id}`.slice(0, 512), displayName: (model ?? node.name).slice(0, 256), enabled, providedBy: null });
    } else if (/mcpClientTool$/i.test(node.type)) {
      const origin = endpointOrigin(atPath(node.params, "endpointUrl")) ?? endpointOrigin(atPath(node.params, "sseEndpoint"));
      add({ kind: "mcp_server", vendorRef: (origin ?? `${node.type}:${node.id}`).slice(0, 512), displayName: (origin ?? node.name).slice(0, 256), enabled, providedBy: null });
    } else {
      const k = kind === "tool" && /vectorStore/i.test(node.type) ? "knowledge" : kind;
      add({ kind: k, vendorRef: `${node.type}:${node.id}`.slice(0, 512), displayName: node.name.slice(0, 256), enabled, providedBy: null });
    }
  }
  // the credentials any node of the workflow uses: references only (type and id), supplied by the workflow's maker
  for (const node of nodes.values()) {
    for (const c of node.credentials) add({ kind: "connected_app", vendorRef: `${c.type}:${c.id}`, displayName: c.name.slice(0, 256), enabled: null, providedBy: "maker" });
  }
  return { agents, components: tooMany || unreadable ? null : [...components.values()] };
}

/** active when a version is published (`activeVersionId`, n8n 2.x), falling back to the deprecated `active` flag */
function workflowState(w: unknown): "active" | "inactive" | null {
  if (w && typeof w === "object" && Object.hasOwn(w, "activeVersionId")) return atPath(w, "activeVersionId") ? "active" : "inactive";
  const a = atPath(w, "active");
  return a === true ? "active" : a === false ? "inactive" : null;
}

/** at most this many string parameters of one workflow are scanned, at most this deep */
export const N8N_SCANNED_STRINGS_MAX = 2_000;
const N8N_SCAN_DEPTH = 8;

/**
 * Slice 4: every string parameter of a workflow's nodes, with a value-free path. A path segment is a node id or a
 * parameter key when it is a plain identifier, otherwise its position, so no user text reaches the path.
 */
export function workflowScannedFields(workflowId: string, nodesRaw: unknown): ConfigField[] {
  const out: ConfigField[] = [];
  if (!Array.isArray(nodesRaw)) return out;
  const walk = (v: unknown, path: string, depth: number) => {
    if (out.length >= N8N_SCANNED_STRINGS_MAX || depth > N8N_SCAN_DEPTH) return;
    if (typeof v === "string") out.push({ path, text: v });
    else if (Array.isArray(v)) v.slice(0, 200).forEach((x, i) => walk(x, `${path}/${i}`, depth + 1));
    else if (v && typeof v === "object") {
      Object.entries(v as Record<string, unknown>).slice(0, 200).forEach(([k, x], i) => walk(x, `${path}/${pathSegment(k, `#${i}`)}`, depth + 1));
    }
  };
  nodesRaw.slice(0, N8N_NODES_PER_WORKFLOW_MAX).forEach((n, i) => {
    const id = pathSegment(atPath(n, "id"), `#${i}`);
    walk(n && typeof n === "object" && Object.hasOwn(n, "parameters") ? (n as Record<string, unknown>).parameters : undefined, `workflows/${workflowId}/nodes/${id}/parameters`, 0);
  });
  return out;
}

async function runN8n(ctx: ScanContext): Promise<ScanResult> {
  const problem = n8nTargetProblem(ctx.source.target, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`${KIND}: ${problem}`);
  const base = n8nBase(ctx.source.target.baseUrl)!;
  const c = ctx.credential;
  if (!c || c.mode !== "static" || !c.secret) throw new WiderSourceConfigError(`${KIND}: a static credential with the n8n API key is required`);
  const include = includeSet(ctx);
  const host = `${new URL(base.origin).host}${base.prefix}`;
  const fetchImpl = allowListedFetch(scannerFetch(ctx), new Set([base.origin]), n8nEndpoints(base.prefix));
  const get = (url: string) => getJson(fetchImpl, url, { "x-n8n-api-key": c.secret! }, ctx.signal);
  const outcomes: DiscoveryReadOutcome[] = [];
  const records: RegistryAgentRecord[] = [];
  const secrets = new ConfigSecretCollector();

  // 1. the key's own scopes, where the instance can say (n8n 2.14+): a write scope refuses it before anything is read
  const SCOPES = `credential scopes in ${host}`;
  let writeScope: "read_only" | "unverified" = "unverified";
  try {
    const scopes = atPath(await get(`${base.origin}${base.prefix}/api/v1/discover`), "data.scopes");
    if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((x) => typeof x !== "string")) {
      outcomes.push({ read: SCOPES, status: "error", detail: "the instance did not list this key's scopes, so read-only could not be checked" });
    } else {
      const writes = (scopes as string[]).filter((x) => !READ_SCOPE.test(x));
      if (writes.length > 0) {
        outcomes.push({ read: SCOPES, status: "denied", detail: `the API key holds more than read scopes: ${writes.slice(0, 20).join(", ").slice(0, 300)}` });
        return { observations: [], credentialWriteScope: "write", readOutcomes: outcomes };
      }
      writeScope = "read_only";
      outcomes.push({ read: SCOPES, status: "read" });
    }
  } catch (err) {
    if (!(err instanceof ReadFailure)) throw err;
    // an instance before 2.14 has no discover endpoint (and may give the key full scope): the run stays unverified
    outcomes.push({ read: SCOPES, status: err.status, detail: `${err.message.slice(0, 200)}; the key's scope could not be checked, so this run is unverified` });
  }

  // 2. the workflows
  const READ = `workflows in ${host}`;
  const first = `${base.origin}${base.prefix}/api/v1/workflows?excludePinnedData=true&limit=${N8N_PAGE_LIMIT}`;
  let seen = 0;
  let cut = false;
  let overCap = 0;
  await readListing(ctx, READ, first, outcomes, (body) => {
    const data = atPath(body, "data");
    if (!Array.isArray(data)) return null;
    for (const w of data) {
      if (++seen > WIDER_MAX_ITEMS) return ITEM_CAP;
      const id = str(atPath(w, "id"), 64);
      if (!id || !WORKFLOW_ID.test(id)) continue;
      if (include && !include.has(id.toLowerCase())) continue;
      const { agents, components } = workflowAgents(atPath(w, "nodes"), atPath(w, "connections"));
      if (agents === 0) continue;
      const tags = atPath(w, "tags");
      const tooMany = components !== null && components.length > REGISTRY_COMPONENTS_PER_RECORD_MAX;
      if (tooMany) overCap++;
      const rec: RegistryAgentRecord = {
        registry: "n8n",
        externalId: `${host}/${id}`,
        displayName: str(atPath(w, "name"), 256) ?? id,
        description: null,
        attributes: attrs({
          instance: host,
          workflowId: id,
          state: workflowState(w),
          archived: typeof atPath(w, "isArchived") === "boolean" ? (atPath(w, "isArchived") as boolean) : null,
          agentNodes: String(agents),
          createdAt: str(atPath(w, "createdAt"), 40),
          updatedAt: str(atPath(w, "updatedAt"), 40),
          tags: Array.isArray(tags) ? tags.map((t) => str(atPath(t, "name"), 64)).filter((t): t is string => t !== null).slice(0, 20) : null,
        }),
      };
      records.push(components !== null && !tooMany ? { ...rec, components } : rec);
      secrets.scan(rec.externalId, workflowScannedFields(id, atPath(w, "nodes")));
    }
    const next = cursorNext(first, body);
    if (next === PARTIAL) {
      cut = true;
      return null;
    }
    return next;
  }, get);
  if (overCap > 0) outcomes.push({ read: `agent components in ${host}`, status: "read", detail: `${overCap} workflow(s) use more than ${REGISTRY_COMPONENTS_PER_RECORD_MAX} components: their components were not staged, so the stored set is kept` });
  const complete = fullyRead(outcomes, READ) && !cut;
  if (cut) outcomes.push({ read: READ, status: "error", detail: "the next-page cursor was not of the expected shape, so the rest was not read" });
  const capped = secrets.outcome(`plaintext credentials in workflows in ${host}`);
  if (capped) outcomes.push(capped);
  return finishRegistry(records, outcomes, complete ? ["n8n"] : [], writeScope, secrets.observations);
}

export const N8N_SCANNER: Scanner = Object.freeze({
  kind: KIND,
  requiresCredential: true,
  run: runN8n,
  validateTarget: n8nTargetProblem,
});
