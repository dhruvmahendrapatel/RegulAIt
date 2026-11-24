/**
 * ADR-0336 slice 1: the Copilot Studio adapter's read path. It reads agents built in Copilot Studio from each named
 * Power Platform environment's Dataverse Web API (v9.2) and stages them as registry records with their components
 * (knowledge sources, skills, connected apps). App-only: an Entra app registration added as an application user in
 * each environment, with a security role that grants Read privileges only.
 *
 * Read-only, checked on EVERY run (decision 5): `WhoAmI` names the application user, `RetrieveUserPrivileges` lists
 * what it may do, and any privilege that is not a `prvRead*` refuses the credential before anything is read (the
 * worker marks it `refused`). A run whose privileges cannot be read reads nothing from that environment.
 *
 * Never a secret, an instruction or prompt text (decision 4): `bots` and `botcomponents` are read with named columns
 * that exclude `configuration`, `content`, `data` and `dependencies`; a connected app is its connection reference's
 * connector id and name, never the connection itself. People only as pseudonyms (the owner's display name).
 *
 * Plaintext credentials (decision 4, slice 5): the `data` (YAML) of the agents' topic (type 9) and generative
 * instruction (type 15) components is read in a separate listing (`COPILOT_STUDIO_SCANNED`), passed in memory through
 * the vendored secret matcher and dropped; a hit is reported as `agent_config` evidence by its path
 * (`bots/<bot id>/components/<component id>/data`) and rule id only. It is never kept: `COPILOT_STUDIO_SELECTS`, the
 * columns that are kept, still exclude `data`.
 *
 * Every call goes through `allowListedFetch` (COPILOT_STUDIO_ENDPOINTS: GET on six Dataverse paths of the named
 * environments, nothing else) on top of the guarded fetch. Paging passes the `$skiptoken` back on the same path; a
 * `@odata.nextLink` is never fetched as given.
 *
 * TARGET (key=value fields on the source): tenantId (the Entra tenant), orgUrls (1 to 20 environment URLs,
 * `https://<org>.crm[N].dynamics.com`, comma separated). Scope: organisation-level = every agent of the environments;
 * include = agent (bot) ids (GUIDs). Credential: tenantId and clientId, federated (Entra workload identity) by
 * default, a client secret as the static step-up relaxation.
 */
import type { AgentRegistry, DiscoveryReadOutcome } from "@regulait/shared";
import { allowListedFetch, type EndpointRule } from "./agent-platform-endpoints.js";
import { REGISTRY_COMPONENTS_PER_RECORD_MAX } from "./agent-registry-records.js";
import { ConfigSecretCollector, attrs, finishRegistry, fullyRead, includeSet } from "./agent-registry-scanners.js";
import { GUID, ITEM_CAP, ReadFailure, WIDER_MAX_ITEMS, WiderSourceConfigError, atPath, entraToken, getJson, readListing, str } from "./discovery-wider-scanners.js";
import { scannerFetch } from "./discovery-cloud-scanners.js";
import type { RegistryAgentComponent, RegistryAgentRecord, ScanContext, ScanResult, Scanner } from "./discovery-scanners.js";

const KIND = "agent_registry_copilot_studio";
const API = "/api/data/v9.2";
/** the most environments one source reads */
export const COPILOT_STUDIO_MAX_ORGS = 20;
/** commercial and regional Dataverse hosts (`crm`, `crm2` … `crm21`); a sovereign cloud with its own Entra authority is not accepted */
const ORG_URL = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.crm(?:[0-9]{1,2})?\.dynamics\.com$/;
const GUID_PATH = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

/** decision 5: the only calls this adapter makes against an environment, all GET */
export const COPILOT_STUDIO_ENDPOINTS: readonly EndpointRule[] = Object.freeze([
  { method: "GET", path: /^\/api\/data\/v9\.2\/WhoAmI$/ },
  { method: "GET", path: new RegExp(`^/api/data/v9\\.2/systemusers\\(${GUID_PATH}\\)/Microsoft\\.Dynamics\\.CRM\\.RetrieveUserPrivileges\\(\\)$`) },
  // ADR-0338 slice 1b: the environment's Power Platform id, the locator the governed quarantine needs (a read)
  { method: "GET", path: /^\/api\/data\/v9\.2\/RetrieveCurrentOrganization\(AccessType=@p1\)$/ },
  { method: "GET", path: /^\/api\/data\/v9\.2\/bots$/ },
  { method: "GET", path: /^\/api\/data\/v9\.2\/botcomponents$/ },
  { method: "GET", path: /^\/api\/data\/v9\.2\/connectionreferences$/ },
]);

/**
 * The exact columns read (decision 4: pinned in tests). Not one of them holds instructions, topic bodies, knowledge
 * content or credentials: `configuration`, `content`, `data`, `dependencies` and `authenticationconfiguration` are
 * never selected.
 */
export const COPILOT_STUDIO_SELECTS = Object.freeze({
  bots: ["botid", "name", "schemaname", "statecode", "statuscode", "publishedon", "createdon", "modifiedon", "language", "authenticationmode", "accesscontrolpolicy", "_ownerid_value"],
  botcomponents: ["botcomponentid", "name", "componenttype", "statecode", "_parentbotid_value"],
  connectionreferences: ["connectionreferenceid", "connectionreferencelogicalname", "connectionreferencedisplayname", "connectorid", "statecode"],
} as const);

/**
 * Slice 5: the listing whose `data` is scanned in memory for plaintext credentials and dropped (never kept): topics
 * (componenttype 9) and generative instructions (15), the components whose YAML holds an agent's text and HTTP calls.
 */
export const COPILOT_STUDIO_SCANNED = Object.freeze({
  botcomponents: ["botcomponentid", "componenttype", "_parentbotid_value", "data"],
  componentTypes: [9, 15],
} as const);
/** a page of scanned components is held smaller: each carries its YAML */
const SCANNED_PAGE_SIZE = 20;

/** `botcomponent.componenttype` values that are components of the agent (Dataverse `botcomponent_componenttype`) */
const COMPONENT_KIND_OF_TYPE: Readonly<Record<number, RegistryAgentComponent["kind"]>> = Object.freeze({
  1: "tool", // Skill
  13: "tool", // Skill (V2)
  14: "knowledge", // Bot File Attachment (its name only, never the file)
  16: "knowledge", // Knowledge Source
});

const AUTH_MODES = ["unspecified", "none", "integrated", "custom_entra_id", "generic_oauth2"] as const;
const ACCESS_POLICIES = ["any", "agent_readers", "group_membership", "any_multi_tenant"] as const;
const FORMATTED = "@OData.Community.Display.V1.FormattedValue";
/** a field's formatted value; read as an own property, since the annotation key itself holds dots */
const formatted = (row: unknown, field: string): unknown =>
  row && typeof row === "object" && Object.hasOwn(row, `${field}${FORMATTED}`) ? (row as Record<string, unknown>)[`${field}${FORMATTED}`] : undefined;

/** the environment URLs of a target, normalised (lower case, no trailing slash); null when any is not accepted */
export function copilotStudioOrgs(raw: string | undefined): string[] | null {
  if (!raw) return null;
  const list = [...new Set(raw.split(",").map((u) => u.trim().toLowerCase().replace(/\/+$/, "")).filter(Boolean))];
  if (list.length === 0 || list.length > COPILOT_STUDIO_MAX_ORGS || list.some((u) => !ORG_URL.test(u))) return null;
  return list;
}

export function copilotStudioTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (!target.tenantId || !GUID.test(target.tenantId)) return "'tenantId' must be the Entra tenant's id (a GUID)";
  if (!copilotStudioOrgs(target.orgUrls)) return `'orgUrls' must list 1 to ${COPILOT_STUDIO_MAX_ORGS} environment URLs of the form https://<org>.crm<N>.dynamics.com, comma separated`;
  if (!scope.orgLevel && (scope.include.length === 0 || scope.include.some((x) => !GUID.test(x.trim())))) return "the scope names agent (bot) ids (GUIDs)";
  return null;
}

/**
 * A Dataverse next page: the `$skiptoken` of the service's `@odata.nextLink`, set on OUR first URL (same path, same
 * query); a link to another origin or path ends the listing, which then reads as partial.
 */
function skipTokenNext(first: string, body: unknown): string | null | typeof PARTIAL {
  const link = body && typeof body === "object" && Object.hasOwn(body, "@odata.nextLink") ? str((body as Record<string, unknown>)["@odata.nextLink"], 4096) : null;
  if (!link) return null;
  try {
    const next = new URL(link);
    const base = new URL(first);
    const token = next.searchParams.get("$skiptoken");
    if (next.origin !== base.origin || next.pathname !== base.pathname || !token || token.length > 2048) return PARTIAL;
    base.searchParams.set("$skiptoken", token);
    return base.toString();
  } catch {
    return PARTIAL;
  }
}
/** a cursor that could not be passed back safely: the listing stops and reads as partial */
const PARTIAL = Symbol("partial");

const label = <T extends readonly string[]>(choices: T, v: unknown): T[number] | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < choices.length ? choices[v]! : null);
const isoOrNull = (v: unknown): string | null => str(v, 40);

interface Bot {
  rec: RegistryAgentRecord;
  botId: string;
  components: Map<string, RegistryAgentComponent>;
  /** a nested connection-reference list was cut short for this bot, so its components are partial */
  partial: boolean;
}

async function readOrg(ctx: ScanContext, org: string, include: Set<string> | null, outcomes: DiscoveryReadOutcome[], records: RegistryAgentRecord[], secrets: ConfigSecretCollector): Promise<{ complete: boolean; write: boolean; verified: boolean }> {
  const host = new URL(org).host;
  let accessToken: string;
  try {
    ({ accessToken } = await entraToken(ctx, KIND, `${org}/.default`));
  } catch (err) {
    if (err instanceof WiderSourceConfigError) {
      outcomes.push({ read: `environment ${host}`, status: "denied", detail: err.message.slice(0, 300) });
      return { complete: false, write: false, verified: false };
    }
    throw err;
  }
  const fetchImpl = allowListedFetch(scannerFetch(ctx), new Set([org]), COPILOT_STUDIO_ENDPOINTS);
  const headers = {
    authorization: `Bearer ${accessToken}`,
    "odata-maxversion": "4.0",
    "odata-version": "4.0",
    prefer: `odata.include-annotations="OData.Community.Display.V1.FormattedValue",odata.maxpagesize=100`,
  };
  const get = (url: string) => getJson(fetchImpl, url, headers, ctx.signal);

  // 1. who the credential is, and 2. everything it may do: any privilege that is not a read refuses it (decision 5)
  const PRIVILEGES = `credential privileges in ${host}`;
  let privileges: string[];
  try {
    const who = await get(`${org}${API}/WhoAmI`);
    const userId = str(atPath(who, "UserId"), 64);
    if (!userId || !GUID.test(userId)) throw new ReadFailure("error", "WhoAmI named no user");
    const body = await get(`${org}${API}/systemusers(${userId.toLowerCase()})/Microsoft.Dynamics.CRM.RetrieveUserPrivileges()`);
    const list = atPath(body, "RolePrivileges");
    if (!Array.isArray(list)) throw new ReadFailure("error", "the privilege list was not readable");
    privileges = list.map((p) => str(atPath(p, "PrivilegeName"), 128)).filter((p): p is string => p !== null);
  } catch (err) {
    if (err instanceof ReadFailure) {
      // read-only cannot be verified, so nothing is read from this environment
      outcomes.push({ read: PRIVILEGES, status: err.status, detail: `${err.message.slice(0, 200)}; nothing was read from this environment` });
      return { complete: false, write: false, verified: false };
    }
    throw err;
  }
  const writes = privileges.filter((p) => !/^prvRead[A-Za-z0-9_]*$/.test(p));
  if (writes.length > 0 || privileges.length === 0) {
    outcomes.push({ read: PRIVILEGES, status: "denied", detail: writes.length ? `the application user holds more than read privileges: ${writes.slice(0, 20).join(", ").slice(0, 300)}` : "the application user holds no privilege" });
    return { complete: false, write: writes.length > 0, verified: false };
  }
  outcomes.push({ read: PRIVILEGES, status: "read" });

  // 2b. ADR-0338 slice 1b: the environment's Power Platform id (`Detail.EnvironmentId`), kept on each agent as the
  // locator the governed quarantine addresses; unreadable, the agents are still staged, without it (no control)
  let environmentId: string | null = null;
  const ENV_ID = `environment id of ${host}`;
  try {
    const detail = await get(`${org}${API}/RetrieveCurrentOrganization(AccessType=@p1)?@p1=Microsoft.Dynamics.CRM.EndpointAccessType'Default'`);
    const id = str(atPath(detail, "Detail.EnvironmentId"), 64);
    if (!id || !GUID.test(id)) throw new ReadFailure("error", "the organization detail named no environment id");
    environmentId = id.toLowerCase();
    outcomes.push({ read: ENV_ID, status: "read" });
  } catch (err) {
    if (!(err instanceof ReadFailure)) throw err;
    outcomes.push({ read: ENV_ID, status: err.status, detail: `${err.message.slice(0, 200)}; its agents cannot be quarantined from regulAIt` });
  }

  // 3. the agents
  const bots = new Map<string, Bot>();
  const BOTS = `agents in ${host}`;
  const botsFirst = `${org}${API}/bots?$select=${COPILOT_STUDIO_SELECTS.bots.join(",")}`;
  const owners: Array<{ bot: Bot; name: string }> = [];
  let botsCut = false;
  await readListing(ctx, BOTS, botsFirst, outcomes, (body) => {
    const value = atPath(body, "value");
    if (!Array.isArray(value)) return null;
    for (const b of value) {
      if (records.length + bots.size >= WIDER_MAX_ITEMS) return ITEM_CAP;
      const botId = str(atPath(b, "botid"), 64)?.toLowerCase();
      if (!botId || !GUID.test(botId)) continue;
      if (include && !include.has(botId)) continue;
      const bot: Bot = {
        botId,
        partial: false,
        components: new Map(),
        rec: {
          registry: "copilot_studio",
          externalId: `${host}/${botId}`,
          displayName: str(atPath(b, "name"), 256) ?? str(atPath(b, "schemaname"), 256) ?? botId,
          description: null,
          attributes: attrs({
            environment: host,
            environmentId,
            botId,
            schemaName: str(atPath(b, "schemaname"), 100),
            state: atPath(b, "statecode") === 0 ? "active" : atPath(b, "statecode") === 1 ? "inactive" : null,
            status: str(formatted(b, "statuscode"), 64),
            publishedOn: isoOrNull(atPath(b, "publishedon")),
            createdOn: isoOrNull(atPath(b, "createdon")),
            modifiedOn: isoOrNull(atPath(b, "modifiedon")),
            language: str(formatted(b, "language"), 64),
            authenticationMode: label(AUTH_MODES, atPath(b, "authenticationmode")),
            accessControlPolicy: label(ACCESS_POLICIES, atPath(b, "accesscontrolpolicy")),
          }),
        },
      };
      const owner = str(formatted(b, "_ownerid_value"), 256);
      if (owner) owners.push({ bot, name: owner });
      bots.set(botId, bot);
    }
    const next = skipTokenNext(botsFirst, body);
    if (next === PARTIAL) {
      botsCut = true;
      return null;
    }
    return next;
  }, get);
  for (const o of owners) o.bot.rec.attributes = { ...o.bot.rec.attributes, owners: [await ctx.pseudonymise("idp_user", o.name)] };
  const botsComplete = fullyRead(outcomes, BOTS) && !botsCut;

  // 4. the environment's connection references (a connector id and a name; never the connection)
  const refs = new Map<string, { connectorId: string; name: string; enabled: boolean | null }>();
  const REFS = `connection references in ${host}`;
  const refsFirst = `${org}${API}/connectionreferences?$select=${COPILOT_STUDIO_SELECTS.connectionreferences.join(",")}`;
  let refsCut = false;
  await readListing(ctx, REFS, refsFirst, outcomes, (body) => {
    const value = atPath(body, "value");
    if (!Array.isArray(value)) return null;
    for (const r of value) {
      if (refs.size >= WIDER_MAX_ITEMS) return ITEM_CAP;
      const id = str(atPath(r, "connectionreferenceid"), 64)?.toLowerCase();
      const connectorId = str(atPath(r, "connectorid"), 512);
      if (!id || !GUID.test(id) || !connectorId) continue;
      const name = str(atPath(r, "connectionreferencedisplayname"), 256) ?? str(atPath(r, "connectionreferencelogicalname"), 256) ?? connectorId.split("/").pop() ?? connectorId;
      const state = atPath(r, "statecode");
      refs.set(id, { connectorId, name: name.slice(0, 256), enabled: state === 0 ? true : state === 1 ? false : null });
    }
    const next = skipTokenNext(refsFirst, body);
    if (next === PARTIAL) {
      refsCut = true;
      return null;
    }
    return next;
  }, get);
  const refsComplete = fullyRead(outcomes, REFS) && !refsCut;

  // 5. the agents' components, with each component's connection references (ids only)
  const COMPONENTS = `agent components in ${host}`;
  const compFirst = `${org}${API}/botcomponents?$select=${COPILOT_STUDIO_SELECTS.botcomponents.join(",")}&$filter=_parentbotid_value ne null&$expand=botcomponent_connectionreference($select=connectionreferenceid)`;
  let compCut = false;
  let seen = 0;
  await readListing(ctx, COMPONENTS, compFirst, outcomes, (body) => {
    const value = atPath(body, "value");
    if (!Array.isArray(value)) return null;
    for (const c of value) {
      if (++seen > WIDER_MAX_ITEMS) return ITEM_CAP;
      const bot = bots.get(str(atPath(c, "_parentbotid_value"), 64)?.toLowerCase() ?? "");
      if (!bot) continue;
      const id = str(atPath(c, "botcomponentid"), 64)?.toLowerCase();
      const type = atPath(c, "componenttype");
      const kind = typeof type === "number" ? COMPONENT_KIND_OF_TYPE[type] : undefined;
      const state = atPath(c, "statecode");
      if (id && kind) {
        bot.components.set(`${kind}\u0000${id}`, { kind, vendorRef: id, displayName: str(atPath(c, "name"), 256) ?? id, enabled: state === 0 ? true : state === 1 ? false : null, providedBy: null });
      }
      const linked = atPath(c, "botcomponent_connectionreference");
      if (c && typeof c === "object" && Object.hasOwn(c, "botcomponent_connectionreference@odata.nextLink")) bot.partial = true;
      if (Array.isArray(linked)) {
        for (const l of linked) {
          const ref = refs.get(str(atPath(l, "connectionreferenceid"), 64)?.toLowerCase() ?? "");
          if (!ref) {
            bot.partial = true; // a reference the listing did not return: the connected-app set is not known in full
            continue;
          }
          bot.components.set(`connected_app\u0000${ref.connectorId}`, { kind: "connected_app", vendorRef: ref.connectorId, displayName: ref.name, enabled: ref.enabled, providedBy: null });
        }
      }
    }
    const next = skipTokenNext(compFirst, body);
    if (next === PARTIAL) {
      compCut = true;
      return null;
    }
    return next;
  }, get);
  const componentsComplete = fullyRead(outcomes, COMPONENTS) && !compCut && refsComplete;

  // 6. slice 5: the topic and generative-instruction YAML, scanned in memory for plaintext credentials and dropped
  const SCAN = `agent configurations in ${host}`;
  const scanFirst = `${org}${API}/botcomponents?$select=${COPILOT_STUDIO_SCANNED.botcomponents.join(",")}&$filter=_parentbotid_value ne null and (${COPILOT_STUDIO_SCANNED.componentTypes.map((t) => `componenttype eq ${t}`).join(" or ")})`;
  const scanHeaders = { ...headers, prefer: `odata.maxpagesize=${SCANNED_PAGE_SIZE}` };
  await readListing(ctx, SCAN, scanFirst, outcomes, (body) => {
    const value = atPath(body, "value");
    if (!Array.isArray(value)) return null;
    for (const c of value) {
      const bot = bots.get(str(atPath(c, "_parentbotid_value"), 64)?.toLowerCase() ?? "");
      const id = str(atPath(c, "botcomponentid"), 64)?.toLowerCase();
      if (!bot || !id || !GUID.test(id)) continue;
      secrets.scan(bot.rec.externalId, [{ path: `bots/${bot.botId}/components/${id}/data`, text: c && typeof c === "object" && Object.hasOwn(c, "data") ? (c as Record<string, unknown>).data : undefined }]);
    }
    const next = skipTokenNext(scanFirst, body);
    return next === PARTIAL ? null : next;
  }, (url) => getJson(fetchImpl, url, scanHeaders, ctx.signal));

  let overCap = 0;
  for (const bot of bots.values()) {
    // decision 3: components are staged only when this agent's were read in full; otherwise the stored set stays.
    // More than the per-agent bound is never truncated into a "complete" set: it reads as partial.
    const tooMany = bot.components.size > REGISTRY_COMPONENTS_PER_RECORD_MAX;
    if (tooMany) overCap++;
    records.push(componentsComplete && !bot.partial && !tooMany ? { ...bot.rec, components: [...bot.components.values()] } : bot.rec);
  }
  if (overCap > 0) outcomes.push({ read: `agent components in ${host}`, status: "read", detail: `${overCap} agent(s) use more than ${REGISTRY_COMPONENTS_PER_RECORD_MAX} components: their components were not staged, so the stored set is kept` });
  return { complete: botsComplete, write: false, verified: true };
}

async function runCopilotStudio(ctx: ScanContext): Promise<ScanResult> {
  const problem = copilotStudioTargetProblem(ctx.source.target, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`${KIND}: ${problem}`);
  const orgs = copilotStudioOrgs(ctx.source.target.orgUrls)!;
  const include = includeSet(ctx);
  const outcomes: DiscoveryReadOutcome[] = [];
  const records: RegistryAgentRecord[] = [];
  const secrets = new ConfigSecretCollector();
  let complete = true;
  let verified = true;
  for (const org of orgs) {
    if (ctx.signal.aborted || !(await ctx.heartbeat())) {
      outcomes.push({ read: `environment ${new URL(org).host}`, status: "skipped", detail: "the run's lease or time ran out" });
      complete = false;
      verified = false;
      continue;
    }
    const r = await readOrg(ctx, org, include, outcomes, records, secrets);
    if (r.write) {
      // decision 5 / ADR-0195 decision 7: a write privilege refuses the credential; nothing from this run is kept
      return { observations: [], credentialWriteScope: "write", readOutcomes: outcomes.filter((o) => o.status !== "read").slice(0, 100) };
    }
    if (!r.complete) complete = false;
    if (!r.verified) verified = false;
  }
  const registries: AgentRegistry[] = complete ? ["copilot_studio"] : [];
  // read_only only when EVERY environment's privileges were listed and all were reads
  const capped = secrets.outcome("plaintext credentials in agent configurations");
  if (capped) outcomes.push(capped);
  return finishRegistry(records, outcomes, registries, verified ? "read_only" : "unverified", secrets.observations);
}

export const COPILOT_STUDIO_SCANNER: Scanner = Object.freeze({
  kind: KIND,
  requiresCredential: true,
  run: runCopilotStudio,
  validateTarget: copilotStudioTargetProblem,
});
