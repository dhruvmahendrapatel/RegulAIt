/**
 * ADR-0314 (G6): read-only import of agents from vendor agent registries, registered against ADR-0195 SD0's `Scanner`
 * interface (`discovery-scanners.ts`) in the `agent_registry` family (ADR-0235's family switch pattern, default off).
 * A registry scanner reports no observations: it returns `registryAgents`, which the worker stages in
 * `agent_registry_records` (provenance: the source and the run), and an admin imports a record into the agent
 * inventory with a step-up. An imported agent starts disabled, `proposed`, and with no grant (default-deny).
 *
 * THE ADAPTER INTERFACE is `Scanner` plus `RegistryAgentRecord`: one scanner per vendor, one `AgentRegistry` value per
 * registry it reads. A later vendor (Atlassian, lane E17's set) adds a kind, a registry value and a scanner here;
 * the full checklist is ADR-0314, section "Adding a registry (the adapter seam)".
 *
 * SD0 WIRING, as every scanner: network only through `ctx.fetch` (wrapped by `scannerFetch`: throttle, backoff,
 * digest; credential exchanges are never digested), people only as pseudonyms (`idp_user`), the customer's
 * credential per source (encrypted at rest, decrypted for the run, never in code). Read-only: every Graph and
 * Discovery Engine call is a GET; AgentCore's `ListAgentRuntimes` is a REST POST that reads.
 *
 * TARGETS (key=value fields on the source):
 *  - agent_registry_entra     tenantId; agent365? (`true` also reads the Agent 365 catalogue, which needs an Agent 365
 *                             licence and CopilotPackages.Read.All; default off)
 *                             scope: organisation-level = every agent identity; include = agent identity object ids
 *                             or app ids (GUIDs)
 *                             credential: tenantId, clientId (federated: Entra workload identity; static: secret).
 *                             Graph application permissions AgentIdentity.Read.All (and CopilotPackages.Read.All);
 *                             any permission that is not `.Read.All` refuses the credential before anything is read.
 *  - agent_registry_gemini    projectId, location (global, us or eu)
 *                             scope: organisation-level = every engine (app) of the project; include = engine ids
 *                             credential: GCP workload identity (or a service-account key, static), read-only scope
 *  - agent_registry_agentcore accountId; scope include = regions (an organisation-level scope is refused: AgentCore
 *                             is regional and RegulAIt never guesses the enabled regions)
 *                             credential: AWS role by web identity (or static keys, static)
 */
import { gcpAuthClient, isAwsRegion, isAwsAccountId, listAgentCoreRuntimes } from "@regulait/cloud-discovery";
import { DISCOVERY_READ_OUTCOMES_MAX, type AgentRegistry, type DiscoveryReadOutcome } from "@regulait/shared";
import { awsCredential, dedupedSecretSink, gcpCredential, scannerFetch, sourceToken, type CloudScannerOptions } from "./discovery-cloud-scanners.js";
import {
  GRAPH_ORIGIN,
  GUID,
  ITEM_CAP,
  WIDER_MAX_ITEMS,
  WiderSourceConfigError,
  atPath,
  entraGraphToken,
  getJson,
  readListing,
  sameOriginNext,
  str,
} from "./discovery-wider-scanners.js";
import type { RegistryAgentRecord, ScanContext, ScanResult, Scanner } from "./discovery-scanners.js";

/** at most this many Entra agent identities have their owners read per run (one Graph call each) */
export const ENTRA_OWNER_LOOKUPS_MAX = 200;

type Attrs = NonNullable<RegistryAgentRecord["attributes"]>;

/** drop absent values so a record carries only what the vendor said */
function attrs(input: Record<string, string | string[] | boolean | null | undefined>): Attrs {
  const out: Attrs = {};
  for (const [k, v] of Object.entries(input)) if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) out[k] = v;
  return out;
}

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const strList = (v: unknown, max = 20): string[] => (Array.isArray(v) ? v.map((x) => str(x, 64)).filter((x): x is string => x !== null).slice(0, max) : []);

/** the include list, lower-cased; null for an organisation-level scope */
const includeSet = (ctx: ScanContext): Set<string> | null =>
  ctx.source.scope.orgLevel ? null : new Set(ctx.source.scope.include.map((x) => x.trim().toLowerCase()));

/** is this listing's outcome a full read (read, no cap note)? */
const fullyRead = (outcomes: DiscoveryReadOutcome[], read: string): boolean => outcomes.some((o) => o.read === read && o.status === "read" && !o.detail);

/** finish a registry run: problems first; a failure when nothing at all could be read */
function finishRegistry(records: RegistryAgentRecord[], outcomes: DiscoveryReadOutcome[], complete: AgentRegistry[], writeScope: ScanResult["credentialWriteScope"]): ScanResult {
  const sorted = [...outcomes.filter((o) => o.status !== "read"), ...outcomes.filter((o) => o.status === "read")].slice(0, DISCOVERY_READ_OUTCOMES_MAX);
  if (!outcomes.some((o) => o.status === "read")) {
    throw new WiderSourceConfigError(`nothing could be read: ${sorted.map((o) => `${o.read} ${o.status}${o.detail ? ` (${o.detail})` : ""}`).join("; ").slice(0, 600)}`);
  }
  return { observations: [], registryAgents: records, registriesComplete: complete, readOutcomes: sorted, ...(writeScope ? { credentialWriteScope: writeScope } : {}) };
}

// ---------------------------------------------------------------------------
// agent_registry_entra: Microsoft Entra Agent ID (Graph v1.0) and the Agent 365 catalogue
// ---------------------------------------------------------------------------

export function entraRegistryTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (!target.tenantId || !GUID.test(target.tenantId)) return "'tenantId' must be the Entra tenant's id (a GUID)";
  if (target.agent365 !== undefined && target.agent365 !== "true" && target.agent365 !== "false") return "'agent365' must be true or false";
  if (!scope.orgLevel && scope.include.some((x) => !GUID.test(x.trim()))) return "the scope names agent identity object ids or app ids (GUIDs)";
  return null;
}

async function runEntraRegistry(ctx: ScanContext): Promise<ScanResult> {
  const kind = "agent_registry_entra";
  const problem = entraRegistryTargetProblem(ctx.source.target, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`${kind}: ${problem}`);
  const { accessToken, write } = await entraGraphToken(ctx, kind);
  if (write.scope === "write") {
    // decision 7: a credential that may write is refused before anything is read
    return { observations: [], credentialWriteScope: "write", readOutcomes: [{ read: "credential write scope", status: "denied", detail: `the app holds more than read permissions: ${write.roles.join(", ").slice(0, 300)}` }] };
  }
  const fetchImpl = scannerFetch(ctx);
  const headers = { authorization: `Bearer ${accessToken}` };
  const get = (url: string) => getJson(fetchImpl, url, headers, ctx.signal);
  const nextLink = (body: unknown) =>
    sameOriginNext(GRAPH_ORIGIN, body && typeof body === "object" && Object.hasOwn(body, "@odata.nextLink") ? (body as Record<string, unknown>)["@odata.nextLink"] : null);
  const include = includeSet(ctx);
  const outcomes: DiscoveryReadOutcome[] = [];
  const records: RegistryAgentRecord[] = [];
  const complete: AgentRegistry[] = [];

  // 1. agent identities (servicePrincipal subtype); no $select, so the properties Graph adds later are still seen
  const identities: Array<{ id: string; rec: RegistryAgentRecord }> = [];
  const IDENTITIES = "Entra agent identities";
  await readListing(
    ctx,
    IDENTITIES,
    `${GRAPH_ORIGIN}/v1.0/servicePrincipals/microsoft.graph.agentIdentity?$top=100`,
    outcomes,
    (body) => {
      const value = atPath(body, "value");
      if (!Array.isArray(value)) return null;
      for (const sp of value) {
        if (identities.length >= WIDER_MAX_ITEMS) return ITEM_CAP;
        const id = str(atPath(sp, "id"), 64);
        if (!id || !GUID.test(id)) continue;
        const appId = str(atPath(sp, "appId"), 64);
        if (include && !include.has(id.toLowerCase()) && !(appId && include.has(appId.toLowerCase()))) continue;
        identities.push({
          id,
          rec: {
            registry: "entra_agent_id",
            externalId: id.toLowerCase(),
            displayName: str(atPath(sp, "displayName"), 256) ?? id,
            description: str(atPath(sp, "description"), 1000),
            attributes: attrs({
              appId: appId?.toLowerCase(),
              accountEnabled: bool(atPath(sp, "accountEnabled")),
              blueprintId: str(atPath(sp, "agentIdentityBlueprintId"), 64),
              createdDateTime: str(atPath(sp, "createdDateTime"), 40),
            }),
          },
        });
      }
      return nextLink(body);
    },
    get,
  );
  const identitiesComplete = fullyRead(outcomes, IDENTITIES);

  // 2. owners of each identity, as pseudonyms (bounded: one call each)
  let ownerReads = 0;
  let ownerFailures = 0;
  for (const it of identities) {
    // the same lease check `readListing` makes before each page: a lost lease stops the lookups
    if (ownerReads >= ENTRA_OWNER_LOOKUPS_MAX || ctx.signal.aborted || !(await ctx.heartbeat())) break;
    ownerReads++;
    try {
      const body = await get(`${GRAPH_ORIGIN}/v1.0/servicePrincipals/${it.id}/microsoft.graph.agentIdentity/owners?$select=id,displayName&$top=20`);
      const value = atPath(body, "value");
      const owners: string[] = [];
      if (Array.isArray(value)) {
        for (const o of value.slice(0, 20)) {
          const name = str(atPath(o, "displayName"), 256) ?? str(atPath(o, "id"), 64);
          if (name) owners.push(await ctx.pseudonymise("idp_user", name));
        }
      }
      if (owners.length) it.rec.attributes = { ...it.rec.attributes, owners };
    } catch {
      ownerFailures++;
    }
  }
  if (identities.length > 0) {
    const skipped = identities.length - ownerReads;
    outcomes.push({
      read: "Entra agent identity owners",
      status: ownerReads > 0 && ownerFailures === ownerReads ? "denied" : "read",
      ...(skipped > 0 || ownerFailures > 0 ? { detail: `${ownerReads - ownerFailures} read, ${ownerFailures} failed, ${skipped} not read (at most ${ENTRA_OWNER_LOOKUPS_MAX} per run)` } : {}),
    });
  }
  for (const it of identities) records.push(it.rec);
  if (identitiesComplete) complete.push("entra_agent_id");

  // 3. the Agent 365 catalogue (opt-in per source: it needs a licence and its own permission)
  if (ctx.source.target.agent365 === "true") {
    const PACKAGES = "Agent 365 catalogue";
    let n = 0;
    await readListing(
      ctx,
      PACKAGES,
      `${GRAPH_ORIGIN}/v1.0/copilot/admin/catalog/packages`,
      outcomes,
      (body) => {
        const value = atPath(body, "value");
        if (!Array.isArray(value)) return null;
        for (const p of value) {
          if (n >= WIDER_MAX_ITEMS) return ITEM_CAP;
          const id = str(atPath(p, "id"), 256);
          if (!id) continue;
          const agentIdentityId = str(atPath(p, "agentIdentityId"), 64);
          if (include && !(agentIdentityId && include.has(agentIdentityId.toLowerCase()))) continue;
          n++;
          records.push({
            registry: "agent_365",
            externalId: id,
            displayName: str(atPath(p, "displayName"), 256) ?? id,
            description: str(atPath(p, "shortDescription"), 1000),
            attributes: attrs({
              type: str(atPath(p, "type"), 64),
              publisher: str(atPath(p, "publisher"), 256),
              platform: str(atPath(p, "platform"), 64),
              version: str(atPath(p, "version"), 64),
              isBlocked: bool(atPath(p, "isBlocked")),
              availableTo: str(atPath(p, "availableTo"), 32),
              deployedTo: str(atPath(p, "deployedTo"), 32),
              elementTypes: strList(atPath(p, "elementTypes")),
              agentIdentityId: agentIdentityId?.toLowerCase(),
              lastModifiedDateTime: str(atPath(p, "lastModifiedDateTime"), 40),
            }),
          });
        }
        return nextLink(body);
      },
      get,
    );
    if (fullyRead(outcomes, PACKAGES)) complete.push("agent_365");
  }
  return finishRegistry(records, outcomes, complete, write.scope);
}

// ---------------------------------------------------------------------------
// agent_registry_gemini: Google Gemini Enterprise (Discovery Engine v1alpha)
// ---------------------------------------------------------------------------

const GCP_PROJECT_ID = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GEMINI_ENGINE_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** the most engines one run reads agents from */
export const GEMINI_MAX_ENGINES = 500;

/** the Discovery Engine host for each multi-region (the location is part of the host, so it is a closed list) */
export const GEMINI_HOSTS: Readonly<Record<string, string>> = Object.freeze({
  global: "https://discoveryengine.googleapis.com",
  us: "https://us-discoveryengine.googleapis.com",
  eu: "https://eu-discoveryengine.googleapis.com",
});

export function geminiTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (!target.projectId || !GCP_PROJECT_ID.test(target.projectId)) return "'projectId' must be a GCP project id";
  if (!target.location || !Object.hasOwn(GEMINI_HOSTS, target.location)) return "'location' must be global, us or eu";
  if (!scope.orgLevel && (scope.include.length === 0 || scope.include.some((x) => !GEMINI_ENGINE_ID.test(x.trim())))) return "the scope names the registry's engine (app) ids";
  return null;
}

async function runGemini(ctx: ScanContext, opts: CloudScannerOptions = {}): Promise<ScanResult> {
  const kind = "agent_registry_gemini";
  const problem = geminiTargetProblem(ctx.source.target, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`${kind}: ${problem}`);
  if (!ctx.credential) throw new WiderSourceConfigError(`${kind}: a credential is required`);
  const onSecret = dedupedSecretSink(ctx.registerSecret);
  const client = gcpAuthClient({
    fetch: scannerFetch(ctx),
    credentialFetch: scannerFetch(ctx, { digest: false }),
    onSecret,
    credential: gcpCredential(ctx, opts),
    ...(ctx.credential.mode === "federated" ? { oidcToken: sourceToken(ctx, opts) } : {}),
  });
  let accessToken: string;
  try {
    const t = await client.getAccessToken();
    if (!t.token) throw new Error("no token");
    accessToken = t.token;
  } catch {
    throw new WiderSourceConfigError(`${kind}: the Google token request failed`);
  }
  onSecret(accessToken);
  const origin = GEMINI_HOSTS[ctx.source.target.location!]!;
  const base = `${origin}/v1alpha/projects/${ctx.source.target.projectId}/locations/${ctx.source.target.location}/collections/default_collection`;
  const fetchImpl = scannerFetch(ctx);
  const get = (url: string) => getJson(fetchImpl, url, { authorization: `Bearer ${accessToken}` }, ctx.signal);
  const pageUrl = (first: string, body: unknown): string | null => {
    const token = str(atPath(body, "nextPageToken"), 1024);
    if (!token) return null;
    const u = new URL(first);
    u.searchParams.set("pageToken", token);
    return u.toString();
  };
  const outcomes: DiscoveryReadOutcome[] = [];

  // the engines (apps) to read: the include list, or every engine of the project
  let engines: string[] = [];
  let enginesComplete = true;
  if (ctx.source.scope.orgLevel) {
    const READ = "registry engines";
    const first = `${base}/engines?pageSize=100`;
    await readListing(ctx, READ, first, outcomes, (body) => {
      const value = atPath(body, "engines");
      if (Array.isArray(value)) {
        for (const e of value) {
          const id = str(atPath(e, "name"), 512)?.split("/").pop();
          if (!id || !GEMINI_ENGINE_ID.test(id)) continue;
          // the engine bound is a cap, not a silent drop: the read becomes partial, so nothing is marked absent
          if (engines.length >= GEMINI_MAX_ENGINES) return ITEM_CAP;
          engines.push(id);
        }
      }
      return pageUrl(first, body);
    }, get);
    enginesComplete = fullyRead(outcomes, READ);
  } else {
    engines = [...new Set(ctx.source.scope.include.map((x) => x.trim()))];
  }

  const records: RegistryAgentRecord[] = [];
  let agentsComplete = enginesComplete;
  for (const engine of engines) {
    const READ = `registry agents of engine ${engine}`;
    const first = `${base}/engines/${engine}/assistants/default_assistant/agents?pageSize=100`;
    await readListing(ctx, READ, first, outcomes, (body) => {
      const value = atPath(body, "agents");
      if (Array.isArray(value)) {
        for (const a of value) {
          if (records.length >= WIDER_MAX_ITEMS) return ITEM_CAP;
          const name = str(atPath(a, "name"), 2048);
          if (!name) continue;
          records.push({
            registry: "gemini_enterprise",
            externalId: name,
            displayName: str(atPath(a, "displayName"), 256) ?? name.split("/").pop()!,
            description: str(atPath(a, "description"), 1000),
            attributes: attrs({
              engine,
              state: str(atPath(a, "state"), 64),
              createTime: str(atPath(a, "createTime"), 40),
              updateTime: str(atPath(a, "updateTime"), 40),
            }),
          });
        }
      }
      return pageUrl(first, body);
    }, get);
    if (!fullyRead(outcomes, READ)) agentsComplete = false;
  }
  // the Gemini token was issued for the read-only cloud-platform scope: it cannot write, whatever the IAM roles
  return finishRegistry(records, outcomes, agentsComplete ? ["gemini_enterprise"] : [], "read_only");
}

// ---------------------------------------------------------------------------
// agent_registry_agentcore: AWS Bedrock AgentCore runtimes
// ---------------------------------------------------------------------------

export function agentCoreTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (!target.accountId || !isAwsAccountId(target.accountId)) return "'accountId' must be a 12-digit AWS account id";
  if (target.federation !== undefined && target.federation !== "oidc") return "'federation' may only be oidc for this kind";
  if (scope.orgLevel) return "name the regions to read: AgentCore is regional, so an organisation-level scope is not accepted";
  if (scope.include.length === 0 || scope.include.length > 30 || scope.include.some((r) => !isAwsRegion(r.trim()))) return "the scope names 1 to 30 AWS regions";
  return null;
}

async function runAgentCore(ctx: ScanContext, opts: CloudScannerOptions = {}): Promise<ScanResult> {
  const kind = "agent_registry_agentcore";
  const problem = agentCoreTargetProblem(ctx.source.target, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`${kind}: ${problem}`);
  if (!ctx.credential) throw new WiderSourceConfigError(`${kind}: a credential is required`);
  const credential = awsCredential(ctx, opts);
  if (credential.mode === "aws_assume_role") throw new WiderSourceConfigError(`${kind}: use federation=oidc or a static credential`);
  const out = await listAgentCoreRuntimes(
    {
      fetch: scannerFetch(ctx),
      credentialFetch: scannerFetch(ctx, { digest: false }),
      onSecret: dedupedSecretSink(ctx.registerSecret),
      credential,
      ...(ctx.credential.mode === "federated" ? { oidcToken: sourceToken(ctx, opts) } : {}),
    },
    [...new Set(ctx.source.scope.include.map((r) => r.trim()))],
    ctx.signal,
  );
  const outcomes: DiscoveryReadOutcome[] = out.regions.map((r) => ({
    read: `AgentCore runtimes in ${r.region}`,
    status: r.status === "ok" ? "read" : r.status,
    ...(r.detail ? { detail: r.detail } : r.truncated ? { detail: "stopped at the page or runtime cap: partial, so nothing is marked absent" } : {}),
  }));
  const account = ctx.source.target.accountId!;
  const records: RegistryAgentRecord[] = [];
  for (const r of out.runtimes) {
    // the ARN names the account: a runtime of another account (a misrouted credential) is never staged
    if (r.agentRuntimeArn.split(":")[4] !== account) continue;
    records.push({
      registry: "bedrock_agentcore",
      externalId: r.agentRuntimeArn,
      displayName: r.agentRuntimeName,
      description: r.description,
      attributes: attrs({ region: r.region, runtimeId: r.agentRuntimeId, version: r.agentRuntimeVersion, status: r.status, lastUpdatedAt: r.lastUpdatedAt }),
    });
  }
  // an IAM role cannot be asked what it may do from here: the admin's read-only role is trusted, and said so
  outcomes.push({ read: "credential write scope", status: "skipped", detail: "AWS cannot report a role's permissions to the role: grant it bedrock-agentcore:ListAgentRuntimes only" });
  return finishRegistry(records, outcomes, out.complete ? ["bedrock_agentcore"] : [], "unverified");
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

/** the registry scanners; `opts` is the test seam for the federation token supplier */
export function agentRegistryScanners(opts: CloudScannerOptions = {}): readonly Scanner[] {
  return Object.freeze([
    { kind: "agent_registry_entra", requiresCredential: true, run: runEntraRegistry, validateTarget: entraRegistryTargetProblem },
    { kind: "agent_registry_gemini", requiresCredential: true, run: (ctx: ScanContext) => runGemini(ctx, opts), validateTarget: geminiTargetProblem },
    { kind: "agent_registry_agentcore", requiresCredential: true, run: (ctx: ScanContext) => runAgentCore(ctx, opts), validateTarget: agentCoreTargetProblem },
  ]);
}

export const AGENT_REGISTRY_SCANNERS: readonly Scanner[] = agentRegistryScanners();
