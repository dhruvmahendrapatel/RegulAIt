/**
 * ADR-0336 slice 3: the OpenAI adapter's read path. It reads a ChatGPT Enterprise or Edu workspace's custom GPTs
 * through the Compliance API (`GET https://api.chatgpt.com/v1/compliance/workspaces/{workspace_id}/gpts`, paged with
 * `after`), and stages each live workspace GPT with its tools, custom actions and knowledge files as components. Draft
 * and third-party GPTs are not in that listing (OpenAI's API reference says so), so they are not seen.
 *
 * Credential (decision 5): an OpenAI admin key for the workspace (`Authorization: Bearer`), static only: OpenAI
 * takes no external OIDC token. The GPT listing needs the `chatgpt.enterprise.compliance_export: read` scope. OpenAI
 * offers no endpoint that shows a key's own scopes, so a run never proves read-only: it reports `unverified`, and
 * storing and enabling the key is recorded as a relaxation (`credentialScope: "unverified"`). HOW BROAD THE KEY IS: a
 * Compliance key reaches far more than this listing. Its read scope opens the workspace's other compliance exports
 * (users, projects, files, and with the conversation scope, every conversation), and a key created with the "All"
 * preset can also DELETE GPTs, GPT files and conversations. The source's docs ask for a Custom key with only
 * `chatgpt.enterprise.compliance_export: read`. Whatever the key holds, the endpoint allow-list keeps it on one path:
 * `GET .../workspaces/{the target's workspace}/gpts`, nothing else (never a single-GPT, configs, shared-users, file or
 * delete path).
 *
 * Never a secret, an instruction or prompt text (decision 4): from each GPT only its id, name, creation time, owner
 * (as a pseudonym), sharing visibility, and its tools' types, custom-action domains and auth types,
 * and its knowledge files' ids and names are kept. `instructions`, `conversation_starters`, `description`,
 * `categories`, `action_openapi_raw`, `action_privacy_policy_url` and file contents are never read into a record.
 * Files are listed with `file_format=id`, so no download URL is ever returned.
 *
 * Paging passes `last_id` back as `after` on our own first URL, after a shape check; no URL from a response is fetched.
 *
 * TARGET (key=value fields on the source): workspaceId (the ChatGPT workspace's id, a UUID). Scope:
 * organisation-level = every GPT in the workspace; include = GPT ids (`g-…`).
 */
import type { DiscoveryReadOutcome } from "@regulait/shared";
import { allowListedFetch, type EndpointRule } from "./agent-platform-endpoints.js";
import { REGISTRY_COMPONENTS_PER_RECORD_MAX } from "./agent-registry-records.js";
import { attrs, finishRegistry, fullyRead, includeSet } from "./agent-registry-scanners.js";
import { scannerFetch } from "./discovery-cloud-scanners.js";
import { GUID, ITEM_CAP, WIDER_MAX_ITEMS, WiderSourceConfigError, atPath, getJson, readListing, str } from "./discovery-wider-scanners.js";
import type { RegistryAgentComponent, RegistryAgentRecord, ScanContext, ScanResult, Scanner } from "./discovery-scanners.js";

const KIND = "agent_registry_openai";
export const OPENAI_COMPLIANCE_ORIGIN = "https://api.chatgpt.com";
/** the page size asked for: OpenAI's documented default, since its reference names no maximum */
export const OPENAI_PAGE_LIMIT = 20;
/** a GPT id (`g-` and an opaque id) */
const GPT_ID = /^g-[A-Za-z0-9_-]{1,64}$/;
const FILE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_TYPES = ["code_interpreter", "browser", "dall-e", "memory", "custom_action"] as const;
const TOOL_LABEL: Readonly<Record<(typeof TOOL_TYPES)[number], string>> = Object.freeze({
  code_interpreter: "Code interpreter",
  browser: "Web browsing",
  "dall-e": "Image generation",
  memory: "Memory",
  custom_action: "Custom action",
});
const VISIBILITIES = ["invite-only", "workspace-with-link", "workspace", "anyone-with-link", "gpt-store"] as const;
const AUTH_TYPE = /^[a-z_]{1,32}$/;
const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** decision 5: the one call this adapter makes, GET, on the compliance origin */
export const OPENAI_ENDPOINTS: readonly EndpointRule[] = Object.freeze([
  { method: "GET", path: /^\/v1\/compliance\/workspaces\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/gpts$/ },
]);
/**
 * The exact fields read (decision 4: pinned in tests). Not one of them holds instructions, conversation starters,
 * descriptions, action schemas or file content.
 */
export const OPENAI_GPT_FIELDS = Object.freeze({
  gpt: ["id", "created_at", "owner_id", "owner_email", "sharing.visibility", "latest_config"],
  config: ["id", "name", "created_at", "files", "tools"],
  tool: ["type", "action_domain", "auth_type"],
  file: ["id", "name"],
} as const);

export function openaiTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (!target.workspaceId || !GUID.test(target.workspaceId)) return "'workspaceId' must be the workspace's id (a UUID)";
  if (!scope.orgLevel && (scope.include.length === 0 || scope.include.some((x) => !GPT_ID.test(x.trim())))) return "the scope names GPT ids (g-…)";
  return null;
}

/** the next page: our own first URL with `after` = the shape-checked `last_id`; PARTIAL when it cannot be passed back */
function afterNext(first: string, body: unknown): string | null | typeof PARTIAL {
  if (atPath(body, "has_more") !== true) return null;
  const last = atPath(body, "last_id");
  if (typeof last !== "string" || !GPT_ID.test(last)) return PARTIAL;
  const next = new URL(first);
  next.searchParams.set("after", last);
  return next.toString();
}
const PARTIAL = Symbol("partial");

const unixIso = (v: unknown): string | null => (typeof v === "number" && Number.isFinite(v) && v > 0 && v < 1e11 ? new Date(Math.floor(v * 1000)).toISOString() : null);
const listData = (v: unknown): unknown[] | null => {
  const d = atPath(v, "data");
  return Array.isArray(d) ? d : null;
};

/** a GPT's components from its latest configuration; null when the configuration could not be read in full */
export function gptComponents(config: unknown): RegistryAgentComponent[] | null {
  const tools = listData(atPath(config, "tools"));
  const files = listData(atPath(config, "files"));
  if (!tools || !files) return null;
  const out = new Map<string, RegistryAgentComponent>();
  for (const t of tools) {
    const type = atPath(t, "type");
    if (typeof type !== "string" || !(TOOL_TYPES as readonly string[]).includes(type)) continue;
    if (type === "custom_action") {
      const domain = str(atPath(t, "action_domain"), 253)?.toLowerCase();
      if (!domain || !DOMAIN.test(domain)) continue;
      const auth = str(atPath(t, "auth_type"), 32);
      // a custom action calls the domain's API: a connected app, by its domain only; who supplies the sign-in is
      // the GPT's maker (a stored key) unless the action signs each user in (oauth)
      out.set(`connected_app\u0000${domain}`, {
        kind: "connected_app",
        vendorRef: `custom_action:${domain}`,
        displayName: domain,
        enabled: true,
        providedBy: auth && AUTH_TYPE.test(auth) ? (auth === "oauth" ? "end_user" : auth === "none" ? null : "maker") : null,
      });
    } else {
      out.set(`tool\u0000${type}`, { kind: "tool", vendorRef: type, displayName: TOOL_LABEL[type as (typeof TOOL_TYPES)[number]], enabled: true, providedBy: null });
    }
  }
  for (const f of files) {
    const id = str(atPath(f, "id"), 128);
    if (!id || !FILE_ID.test(id)) continue;
    out.set(`knowledge\u0000${id}`, { kind: "knowledge", vendorRef: id, displayName: str(atPath(f, "name"), 256) ?? id, enabled: true, providedBy: null });
  }
  return [...out.values()];
}

async function runOpenai(ctx: ScanContext): Promise<ScanResult> {
  const problem = openaiTargetProblem(ctx.source.target, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`${KIND}: ${problem}`);
  const c = ctx.credential;
  if (!c || c.mode !== "static" || !c.secret) throw new WiderSourceConfigError(`${KIND}: a static credential with the workspace's admin key is required`);
  const workspaceId = ctx.source.target.workspaceId!.toLowerCase();
  const include = includeSet(ctx);
  const fetchImpl = allowListedFetch(scannerFetch(ctx), new Set([OPENAI_COMPLIANCE_ORIGIN]), OPENAI_ENDPOINTS);
  const get = (url: string) => getJson(fetchImpl, url, { authorization: `Bearer ${c.secret}` }, ctx.signal);
  const outcomes: DiscoveryReadOutcome[] = [];
  const records: RegistryAgentRecord[] = [];
  const owners: Array<{ rec: RegistryAgentRecord; who: string }> = [];

  const READ = `GPTs in workspace ${workspaceId}`;
  const first = `${OPENAI_COMPLIANCE_ORIGIN}/v1/compliance/workspaces/${workspaceId}/gpts?limit=${OPENAI_PAGE_LIMIT}&file_format=id`;
  let seen = 0;
  let cut = false;
  let overCap = 0;
  await readListing(ctx, READ, first, outcomes, (body) => {
    const data = listData(body);
    if (!data) return null;
    for (const g of data) {
      if (++seen > WIDER_MAX_ITEMS) return ITEM_CAP;
      const id = str(atPath(g, "id"), 80);
      if (!id || !GPT_ID.test(id)) continue;
      if (include && !include.has(id.toLowerCase())) continue;
      const configs = listData(atPath(g, "latest_config"));
      const config = configs?.[0];
      const visibility = str(atPath(g, "sharing.visibility"), 40);
      const rec: RegistryAgentRecord = {
        registry: "openai_gpts",
        externalId: `${workspaceId}/${id}`,
        displayName: str(atPath(config, "name"), 256) ?? id,
        description: null,
        attributes: attrs({
          workspace: workspaceId,
          gptId: id,
          configId: str(atPath(config, "id"), 128),
          createdAt: unixIso(atPath(g, "created_at")),
          configCreatedAt: unixIso(atPath(config, "created_at")),
          visibility: visibility && (VISIBILITIES as readonly string[]).includes(visibility) ? visibility : null,
        }),
      };
      const components = config ? gptComponents(config) : null;
      const tooMany = components !== null && components.length > REGISTRY_COMPONENTS_PER_RECORD_MAX;
      if (tooMany) overCap++;
      const staged = components !== null && !tooMany ? { ...rec, components } : rec;
      const who = str(atPath(g, "owner_email"), 320) ?? str(atPath(g, "owner_id"), 128);
      if (who) owners.push({ rec: staged, who });
      records.push(staged);
    }
    const next = afterNext(first, body);
    if (next === PARTIAL) {
      cut = true;
      return null;
    }
    return next;
  }, get);
  // people only as pseudonyms (decision 3): never the owner's email
  for (const o of owners) o.rec.attributes = { ...o.rec.attributes, owners: [await ctx.pseudonymise("idp_user", o.who)] };
  if (overCap > 0) outcomes.push({ read: `GPT components in workspace ${workspaceId}`, status: "read", detail: `${overCap} GPT(s) use more than ${REGISTRY_COMPONENTS_PER_RECORD_MAX} components: their components were not staged, so the stored set is kept` });
  if (cut) outcomes.push({ read: READ, status: "error", detail: "the next-page id was not of the expected shape, so the rest was not read" });
  const complete = fullyRead(outcomes, READ) && !cut;
  // decision 5: no API shows a Compliance key's scope, so the run never proves read-only
  return finishRegistry(records, outcomes, complete ? ["openai_gpts"] : [], "unverified");
}

export const OPENAI_SCANNER: Scanner = Object.freeze({
  kind: KIND,
  requiresCredential: true,
  run: runOpenai,
  validateTarget: openaiTargetProblem,
});
