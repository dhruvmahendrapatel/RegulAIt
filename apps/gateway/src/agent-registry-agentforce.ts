/**
 * ADR-0336 slice 2: the Agentforce adapter's read path. It reads a Salesforce org's agents (BotDefinition and its
 * versions), their planners and their actions, through the REST and Tooling SOQL query endpoints, and stages each agent
 * with its actions as components.
 *
 * Credential (decision 5): the JWT bearer flow (`salesforce-jwt.ts`), signed with the connected app's private key (the
 * stored secret, static only: Salesforce takes no external OIDC token), bound to one consumer key and one integration
 * user. The token is POSTed only to the validated My Domain origin.
 *
 * Read-only, checked on EVERY run: `UserPermissionAccess` is queried for the integration user's own session, and any
 * admin or metadata write permission (`ADMIN_WRITE_PERMISSIONS`) refuses the credential before anything else is read
 * (the worker marks it `refused`). If the permissions cannot be read, nothing is read. Ordinary object permissions are
 * not part of this check: the connected app's integration user should hold the "Minimum Access - API Only
 * Integrations" profile plus read access to the agent objects.
 *
 * Never a secret, an instruction or prompt text (decision 4): every query selects named columns only (pinned in
 * tests); `Description`, `Scope`, `AgentGraph`, `ProgressIndicatorMessage`, `Metadata` and `FullName` are never
 * selected. The run-as user is staged only as a pseudonym.
 *
 * Every call goes through `allowListedFetch` (AGENTFORCE_ENDPOINTS: the token POST, and GET on the REST and Tooling
 * `query` paths, nothing else) on top of the guarded fetch. Paging takes the query locator from `nextRecordsUrl` and
 * builds the next URL itself on the same path; a `nextRecordsUrl` is never fetched as given.
 *
 * TARGET (key=value fields on the source): myDomain (`https://<name>.my.salesforce.com`, or
 * `https://<name>--<sandbox>.sandbox.my.salesforce.com`), environment (`production` or `sandbox`, matching the host),
 * apiVersion (default 67.0; at least 65.0, where the planner and topic links on actions exist). Scope:
 * organisation-level = every agent; include = BotDefinition ids (15 or 18 characters).
 * Credential: static, publicConfig consumerKey and username; the secret is the PKCS#8 PEM private key.
 */
import type { AgentRegistry, DiscoveryReadOutcome } from "@regulait/shared";
import { allowListedFetch, type EndpointRule } from "./agent-platform-endpoints.js";
import { REGISTRY_COMPONENTS_PER_RECORD_MAX } from "./agent-registry-records.js";
import { attrs, finishRegistry, fullyRead } from "./agent-registry-scanners.js";
import { dedupedSecretSink, scannerFetch } from "./discovery-cloud-scanners.js";
import { ITEM_CAP, ReadFailure, WIDER_MAX_ITEMS, WiderSourceConfigError, atPath, getJson, readListing, str } from "./discovery-wider-scanners.js";
import { salesforceJwtToken, type SalesforceEnvironment } from "./salesforce-jwt.js";
import type { RegistryAgentComponent, RegistryAgentRecord, ScanContext, ScanResult, Scanner } from "./discovery-scanners.js";

const KIND = "agent_registry_agentforce";
export const AGENTFORCE_DEFAULT_API_VERSION = "67.0";
const PRODUCTION_HOST = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?\.my\.salesforce\.com$/;
const SANDBOX_HOST = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?--[a-z0-9]{1,40}\.sandbox\.my\.salesforce\.com$/;
const API_VERSION = /^(?:6[5-9]|[7-9][0-9])\.0$/;
/** a Salesforce record id: 15 characters (case-sensitive) or 18 (with the case-safe suffix) */
const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const LOCATOR = /^[A-Za-z0-9]{15,18}-[0-9]{1,7}$/;

/** decision 5: the only calls this adapter makes against an org */
export const AGENTFORCE_ENDPOINTS: readonly EndpointRule[] = Object.freeze([
  { method: "POST", path: /^\/services\/oauth2\/token$/ },
  { method: "GET", path: /^\/services\/data\/v[0-9]{2}\.0\/query$/ },
  { method: "GET", path: /^\/services\/data\/v[0-9]{2}\.0\/query\/[A-Za-z0-9]{15,18}-[0-9]{1,7}$/ },
  { method: "GET", path: /^\/services\/data\/v[0-9]{2}\.0\/tooling\/query$/ },
  { method: "GET", path: /^\/services\/data\/v[0-9]{2}\.0\/tooling\/query\/[A-Za-z0-9]{15,18}-[0-9]{1,7}$/ },
]);

/**
 * An admin or metadata write permission on the integration user's session: any one of these refuses the credential.
 * Deactivating an agent (a write E19 may add with its own credential) needs one of them.
 */
export const ADMIN_WRITE_PERMISSIONS = Object.freeze([
  "PermissionsModifyAllData",
  "PermissionsModifyMetadata",
  "PermissionsCustomizeApplication",
  "PermissionsAuthorApex",
  "PermissionsManageUsers",
] as const);

/** the exact SOQL issued (decision 4: pinned in tests); no free-text column is ever selected */
export const AGENTFORCE_QUERIES = Object.freeze({
  permissions: `SELECT ${ADMIN_WRITE_PERMISSIONS.join(", ")} FROM UserPermissionAccess`,
  bots: "SELECT Id, DeveloperName, MasterLabel, Type, AgentType, BotUserId FROM BotDefinition",
  versions: "SELECT Id, BotDefinitionId, VersionNumber, Status FROM BotVersion",
  /** Tooling: LinkedBotVersionId is documented on the Tooling object only */
  planners: "SELECT Id, DeveloperName, MasterLabel, PlannerType, LinkedBotVersionId FROM GenAiPlannerDefinition",
  topics: "SELECT Id, DeveloperName, MasterLabel, PlannerId FROM GenAiPluginDefinition",
  actions: "SELECT Id, DeveloperName, MasterLabel, PlannerId, PluginId, InvocationTargetType FROM GenAiFunctionDefinition",
} as const);

export interface AgentforceTarget {
  origin: string;
  environment: SalesforceEnvironment;
  apiVersion: string;
}

export function agentforceTarget(target: Readonly<Record<string, string>>): AgentforceTarget | null {
  const origin = (target.myDomain ?? "").trim().toLowerCase().replace(/\/+$/, "");
  const environment = target.environment;
  const apiVersion = target.apiVersion ?? AGENTFORCE_DEFAULT_API_VERSION;
  if (environment !== "production" && environment !== "sandbox") return null;
  if (!(environment === "production" ? PRODUCTION_HOST : SANDBOX_HOST).test(origin)) return null;
  if (!API_VERSION.test(apiVersion)) return null;
  return { origin, environment, apiVersion };
}

export function agentforceTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (target.environment !== "production" && target.environment !== "sandbox") return "'environment' must be production or sandbox";
  if (target.apiVersion !== undefined && !API_VERSION.test(target.apiVersion)) return "'apiVersion' must be a Salesforce API version from 65.0, such as 67.0";
  if (!agentforceTarget(target)) {
    return target.environment === "production"
      ? "'myDomain' must be the org's My Domain URL, https://<name>.my.salesforce.com"
      : "'myDomain' must be the sandbox's My Domain URL, https://<name>--<sandbox>.sandbox.my.salesforce.com";
  }
  if (!scope.orgLevel && (scope.include.length === 0 || scope.include.some((x) => !SF_ID.test(x.trim())))) return "the scope names agent (BotDefinition) ids of 15 or 18 characters";
  return null;
}

/** a cursor that could not be passed back safely: the listing stops and reads as partial */
const PARTIAL = Symbol("partial");
/** the next page: OUR URL built from the locator at the end of `nextRecordsUrl`, on the same query path */
function locatorNext(first: string, body: unknown): string | null | typeof PARTIAL {
  if (atPath(body, "done") === true) return null;
  const next = str(atPath(body, "nextRecordsUrl"), 512);
  if (!next) return atPath(body, "done") === false ? PARTIAL : null;
  const base = new URL(first);
  const prefix = `${base.pathname}/`;
  if (!next.startsWith(prefix)) return PARTIAL;
  const locator = next.slice(prefix.length);
  if (!LOCATOR.test(locator)) return PARTIAL;
  return `${base.origin}${base.pathname}/${locator}`;
}

/** the 15-character form, which identifies a record case-sensitively whichever form the API returned */
const id15 = (id: string): string => id.slice(0, 15);

interface Bot {
  rec: RegistryAgentRecord;
  id: string;
  components: Map<string, RegistryAgentComponent>;
  plannerIds: Set<string>;
}

async function runAgentforce(ctx: ScanContext): Promise<ScanResult> {
  const problem = agentforceTargetProblem(ctx.source.target, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`${KIND}: ${problem}`);
  const t = agentforceTarget(ctx.source.target)!;
  const c = ctx.credential;
  if (!c || c.mode !== "static" || !c.secret) throw new WiderSourceConfigError(`${KIND}: a static credential with the connected app's private key is required`);
  const consumerKey = c.publicConfig.consumerKey;
  const username = c.publicConfig.username;
  if (!consumerKey || !username) throw new WiderSourceConfigError(`${KIND}: the credential names consumerKey and username`);
  const host = new URL(t.origin).host;
  const onSecret = dedupedSecretSink(ctx.registerSecret);
  await ctx.throttle();
  const token = await salesforceJwtToken(KIND, {
    // credential exchanges are never digested
    fetch: allowListedFetch(scannerFetch(ctx, { digest: false }), new Set([t.origin]), AGENTFORCE_ENDPOINTS),
    origin: t.origin,
    environment: t.environment,
    consumerKey,
    username,
    privateKeyPem: c.secret,
    signal: ctx.signal,
    onSecret,
  });
  const fetchImpl = allowListedFetch(scannerFetch(ctx), new Set([t.origin]), AGENTFORCE_ENDPOINTS);
  const get = (url: string) => getJson(fetchImpl, url, { authorization: `Bearer ${token}` }, ctx.signal);
  const queryUrl = (soql: string, tooling = false) => `${t.origin}/services/data/v${t.apiVersion}/${tooling ? "tooling/" : ""}query?q=${encodeURIComponent(soql)}`;
  const outcomes: DiscoveryReadOutcome[] = [];

  // 1. what the integration user's session may do: an admin or metadata write permission refuses it (decision 5)
  const PERMISSIONS = `credential permissions in ${host}`;
  try {
    const body = await get(queryUrl(AGENTFORCE_QUERIES.permissions));
    const rows = atPath(body, "records");
    if (!Array.isArray(rows) || rows.length !== 1) throw new ReadFailure("error", "the permission check returned no single row");
    const held = ADMIN_WRITE_PERMISSIONS.filter((p) => atPath(rows[0], p) === true);
    const unknown = ADMIN_WRITE_PERMISSIONS.filter((p) => typeof atPath(rows[0], p) !== "boolean");
    if (unknown.length) throw new ReadFailure("error", `the permission check did not report ${unknown.join(", ")}`);
    if (held.length) {
      outcomes.push({ read: PERMISSIONS, status: "denied", detail: `the integration user holds write permissions: ${held.join(", ")}` });
      return { observations: [], credentialWriteScope: "write", readOutcomes: outcomes };
    }
  } catch (err) {
    if (err instanceof ReadFailure) {
      outcomes.push({ read: PERMISSIONS, status: err.status, detail: `${err.message.slice(0, 200)}; nothing else was read` });
      return finishRegistry([], outcomes, [], "unverified");
    }
    throw err;
  }
  outcomes.push({ read: PERMISSIONS, status: "read" });

  // a bounded listing of one SOQL query; `row` returns ITEM_CAP to stop
  const listing = async (read: string, soql: string, tooling: boolean, row: (r: unknown) => void | typeof ITEM_CAP): Promise<boolean> => {
    const first = queryUrl(soql, tooling);
    const firstPath = `${t.origin}/services/data/v${t.apiVersion}/${tooling ? "tooling/" : ""}query`;
    let cut = false;
    await readListing(ctx, read, first, outcomes, (body) => {
      const records = atPath(body, "records");
      if (!Array.isArray(records)) return null;
      for (const r of records) if (row(r) === ITEM_CAP) return ITEM_CAP;
      const next = locatorNext(firstPath, body);
      if (next === PARTIAL) {
        cut = true;
        return null;
      }
      return next;
    }, get);
    return fullyRead(outcomes, read) && !cut;
  };

  // 2. the agents
  const include = ctx.source.scope.orgLevel ? null : new Set(ctx.source.scope.include.map((x) => id15(x.trim())));
  const bots = new Map<string, Bot>();
  const runAs: Array<{ bot: Bot; userId: string }> = [];
  const botsComplete = await listing(`agents in ${host}`, AGENTFORCE_QUERIES.bots, false, (b) => {
    if (bots.size >= WIDER_MAX_ITEMS) return ITEM_CAP;
    const id = str(atPath(b, "Id"), 18);
    if (!id || !SF_ID.test(id) || (include && !include.has(id15(id)))) return;
    const bot: Bot = {
      id,
      components: new Map(),
      plannerIds: new Set(),
      rec: {
        registry: "agentforce",
        externalId: `${host}/${id}`,
        displayName: str(atPath(b, "MasterLabel"), 256) ?? str(atPath(b, "DeveloperName"), 256) ?? id,
        description: null,
        attributes: attrs({ org: host, botId: id, developerName: str(atPath(b, "DeveloperName"), 128), type: str(atPath(b, "Type"), 64), agentType: str(atPath(b, "AgentType"), 64) }),
      },
    };
    const user = str(atPath(b, "BotUserId"), 18);
    if (user && SF_ID.test(user)) runAs.push({ bot, userId: user });
    bots.set(id15(id), bot);
  });
  // the run-as user, as a pseudonym only (gap 5: who an agent acts as)
  for (const r of runAs) r.bot.rec.attributes = { ...r.bot.rec.attributes, runAs: [await ctx.pseudonymise("idp_user", `salesforce:${host}:${id15(r.userId)}`)] };

  // 3. versions: which is active; and the version -> agent map the planners link through
  const botOfVersion = new Map<string, Bot>();
  const versionsComplete = await listing(`agent versions in ${host}`, AGENTFORCE_QUERIES.versions, false, (v) => {
    const id = str(atPath(v, "Id"), 18);
    const bot = bots.get(id15(str(atPath(v, "BotDefinitionId"), 18) ?? ""));
    if (!id || !bot) return;
    botOfVersion.set(id15(id), bot);
    if (atPath(v, "Status") === "Active") {
      const n = atPath(v, "VersionNumber");
      bot.rec.attributes = { ...bot.rec.attributes, state: "active", ...(typeof n === "number" ? { activeVersion: String(n) } : {}) };
    }
  });
  for (const b of bots.values()) if (versionsComplete && b.rec.attributes?.state === undefined) b.rec.attributes = { ...b.rec.attributes, state: "inactive" };

  // 4. planners, linked to an agent through their bot version (Tooling)
  const botOfPlanner = new Map<string, Bot>();
  const plannersComplete = await listing(`agent planners in ${host}`, AGENTFORCE_QUERIES.planners, true, (p) => {
    const id = str(atPath(p, "Id"), 18);
    const bot = botOfVersion.get(id15(str(atPath(p, "LinkedBotVersionId"), 18) ?? ""));
    if (!id || !bot) return;
    botOfPlanner.set(id15(id), bot);
    bot.plannerIds.add(id15(id));
  });

  // 5. topics: counted per agent (a topic is a grouping; its actions are the components)
  const plannerOfTopic = new Map<string, string>();
  const topicCount = new Map<Bot, number>();
  const topicsComplete = await listing(`agent topics in ${host}`, AGENTFORCE_QUERIES.topics, false, (tp) => {
    const id = str(atPath(tp, "Id"), 18);
    const planner = id15(str(atPath(tp, "PlannerId"), 18) ?? "");
    if (!id || !planner) return;
    plannerOfTopic.set(id15(id), planner);
    const bot = botOfPlanner.get(planner);
    if (bot) topicCount.set(bot, (topicCount.get(bot) ?? 0) + 1);
  });

  // 6. actions: each a tool component of the agent whose planner (directly, or through its topic) it belongs to
  let seen = 0;
  const actionsComplete = await listing(`agent actions in ${host}`, AGENTFORCE_QUERIES.actions, false, (a) => {
    if (++seen > WIDER_MAX_ITEMS) return ITEM_CAP;
    const id = str(atPath(a, "Id"), 18);
    const planner = id15(str(atPath(a, "PlannerId"), 18) ?? "") || plannerOfTopic.get(id15(str(atPath(a, "PluginId"), 18) ?? "")) || "";
    const bot = botOfPlanner.get(planner);
    if (!id || !bot) return;
    const ref = str(atPath(a, "DeveloperName"), 256) ?? id;
    bot.components.set(`tool\u0000${ref}`, { kind: "tool", vendorRef: ref, displayName: str(atPath(a, "MasterLabel"), 256) ?? ref, enabled: null, providedBy: null });
  });

  const componentsComplete = versionsComplete && plannersComplete && topicsComplete && actionsComplete;
  const records: RegistryAgentRecord[] = [];
  let unlinked = 0;
  let overCap = 0;
  for (const bot of bots.values()) {
    const n = topicCount.get(bot);
    if (n !== undefined && topicsComplete) bot.rec.attributes = { ...bot.rec.attributes, topicCount: String(n) };
    // decision 3: an agent's components are staged only when read in full; an agent with no linked planner is
    // unknown, not "none", so its stored set is kept
    const linked = bot.plannerIds.size > 0;
    if (!linked) unlinked++;
    const tooMany = bot.components.size > REGISTRY_COMPONENTS_PER_RECORD_MAX;
    if (tooMany) overCap++;
    records.push(componentsComplete && linked && !tooMany ? { ...bot.rec, components: [...bot.components.values()] } : bot.rec);
  }
  if (unlinked > 0 && plannersComplete) outcomes.push({ read: `agent components in ${host}`, status: "read", detail: `${unlinked} agent(s) have no linked planner: their components were not staged, so the stored set is kept` });
  if (overCap > 0) outcomes.push({ read: `agent components in ${host}`, status: "read", detail: `${overCap} agent(s) use more than ${REGISTRY_COMPONENTS_PER_RECORD_MAX} actions: their components were not staged, so the stored set is kept` });
  const registries: AgentRegistry[] = botsComplete ? ["agentforce"] : [];
  // read_only here means: no admin or metadata write permission on the session (ADMIN_WRITE_PERMISSIONS)
  return finishRegistry(records, outcomes, registries, "read_only");
}

export const AGENTFORCE_SCANNER: Scanner = Object.freeze({
  kind: KIND,
  requiresCredential: true,
  run: runAgentforce,
  validateTarget: agentforceTargetProblem,
});
