/**
 * ADR-0218 (P9): the wider discovery sources, registered against ADR-0195 SD0's `Scanner` interface
 * (`discovery-scanners.ts`). Each family is also behind its own default-off org switch (`familySwitchProblem`), which
 * the routes and the worker check before a source of it is created, enabled or run.
 *
 *  - `saas_inventory_api` (family saas): the SaaS apps a customer's own inventory tool (a SaaS-management or CASB
 *    product, an in-house register) reports over a JSON API. Vendor-neutral: the admin names the URL and the field
 *    names; RegulAIt ships no vendor preset (ADR-0195 decision 12 stands).
 *  - `idp_entra` (family identity): the OAuth/OIDC client applications users or admins consented to in a Microsoft
 *    Entra ID tenant (Microsoft Graph `oauth2PermissionGrants` joined to `servicePrincipals`). Entra is the identity
 *    service of Azure, which decision 12 already names.
 *  - `ml_mlflow` (family ml_platform): registered models and serving endpoints of an MLflow-compatible platform
 *    outside the three clouds (the open MLflow REST API, also served by hosted platforms built on it).
 *
 * SD0 WIRING, as every scanner: network only through `ctx.fetch` (wrapped by `scannerFetch`: throttle, backoff,
 * digest; credential exchanges are never digested), people only as pseudonyms (`idp_user`), observations only (the
 * worker matches them against the enabled admin catalogue). Read-only: every call is a GET, except the Entra token
 * request, which reads nothing and writes nothing in the tenant. Nothing a response carries is stored except the
 * fields named below; bodies are digested and discarded (decision 6).
 *
 * TARGETS (key=value fields on the source; documented in docs/deployment/WIDER_DISCOVERY.md):
 *  - saas_inventory_api  url (https), itemsPath (dotted path to the array; empty = the body is the array),
 *                        nameField (default name), domainField (default domain), usersField?, nextField? (dotted
 *                        path to the next page's absolute URL, same origin only)
 *                        scope: organisation-level = every app; include = app domains to keep
 *                        credential: static only; secret = the API token; publicConfig authHeader? (default
 *                        `Authorization: Bearer <token>`; a named header carries the token as is)
 *  - idp_entra           tenantId
 *                        scope: organisation-level = every consented app; include = client application ids
 *                        credential: tenantId, clientId (federated: Entra workload identity; static: client secret)
 *  - ml_mlflow           baseUrl (https)
 *                        scope: organisation-level = every model and endpoint; include = model or endpoint names
 *                        credential: static only; secret = the API token; publicConfig authHeader? as above
 */
import { azureCredential as entraCredential } from "@regulait/cloud-discovery";
import { DISCOVERY_READ_OUTCOMES_MAX, type DiscoveryReadOutcome, type DiscoveryReadStatus } from "@regulait/shared";
import { dedupedSecretSink, scannerFetch } from "./discovery-cloud-scanners.js";
import type { ScanContext, ScanObservation, ScanResult, Scanner } from "./discovery-scanners.js";

/** a configuration problem a run can name without leaking anything */
export class WiderSourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WiderSourceConfigError";
  }
}

/** at most this many pages of one listing, and this many items in all, per run */
export const WIDER_MAX_PAGES = 50;
export const WIDER_MAX_ITEMS = 5_000;
/** at most this much of one JSON body is parsed */
export const WIDER_MAX_BODY_BYTES = 8 * 1024 * 1024;

const GRAPH_ORIGIN = "https://graph.microsoft.com";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** query parameter names that could carry a credential: refused in a stored URL (the target is shown to admins) */
const SECRET_PARAM = /^(?:access_?token|api_?key|key|token|secret|client_?secret|password|passwd|sig|signature|code|auth|authorization|session)$/i;

/** null when `raw` is an https URL with no credentials, fragment or credential-shaped query parameter */
export function httpsTargetProblem(raw: string | undefined, field: string): string | null {
  if (!raw) return `'${field}' is required`;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `'${field}' is not a URL`;
  }
  if (u.protocol !== "https:") return `'${field}' must be https`;
  if (u.username || u.password) return `'${field}' must not carry credentials`;
  if (u.hash) return `'${field}' must not have a fragment`;
  for (const name of u.searchParams.keys()) {
    if (SECRET_PARAM.test(name)) return `'${field}' must not carry '${name.slice(0, 40)}' in its query: a token goes in the credential`;
  }
  return null;
}

/** a dotted field path: 1 to 8 segments of letters, digits, _ or - (no evaluation, own properties only) */
const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
export function fieldPathProblem(raw: string | undefined, field: string, allowEmpty = false): string | null {
  if (raw === undefined || raw === "") return allowEmpty ? null : `'${field}' is required`;
  const parts = raw.split(".");
  if (parts.length > 8 || parts.some((p) => !PATH_SEGMENT.test(p))) return `'${field}' must be a dotted field path (for example data.apps)`;
  return null;
}

/** the value at a dotted path, own properties only (never the prototype) */
export function atPath(value: unknown, path: string): unknown {
  if (path === "") return value;
  let cur: unknown = value;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

const str = (v: unknown, max = 256): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** the host of an http(s) URL or bare domain, lower-case; null when it is not one */
export function hostOf(raw: string | null): string | null {
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(candidate);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    return /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

/** the request headers that carry a static API token */
function tokenHeaders(ctx: ScanContext, kind: string): Record<string, string> {
  const c = ctx.credential;
  if (!c || c.mode !== "static" || !c.secret) throw new WiderSourceConfigError(`${kind}: a static credential with the API token is required`);
  const header = c.publicConfig.authHeader;
  return header && header.toLowerCase() !== "authorization" ? { [header]: c.secret } : { authorization: `Bearer ${c.secret}` };
}

class ReadFailure extends Error {
  constructor(
    readonly status: DiscoveryReadStatus,
    message: string,
  ) {
    super(message);
  }
}

/** GET a JSON body, bounded; an HTTP or transport failure becomes a `ReadFailure` with a read status */
async function getJson(fetchImpl: typeof fetch, url: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json", ...headers }, redirect: "manual", signal });
  } catch (err) {
    if (signal.aborted) throw err;
    throw new ReadFailure("unreachable", "the request did not reach the service (is its host on the egress allow list?)");
  }
  if (res.status === 401 || res.status === 403) throw new ReadFailure("denied", `HTTP ${res.status}: the credential may not read this`);
  if (res.status === 404) throw new ReadFailure("not_enabled", "HTTP 404: this API is not available on this service");
  if (res.status < 200 || res.status >= 300) throw new ReadFailure("error", `HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > WIDER_MAX_BODY_BYTES) throw new ReadFailure("error", `the response is larger than ${WIDER_MAX_BODY_BYTES} bytes`);
  const text = await res.text();
  if (text.length > WIDER_MAX_BODY_BYTES) throw new ReadFailure("error", `the response is larger than ${WIDER_MAX_BODY_BYTES} bytes`);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReadFailure("error", "the response is not JSON");
  }
}

/** the include list, lower-cased; null for an organisation-level scope */
const includeSet = (ctx: ScanContext): Set<string> | null =>
  ctx.source.scope.orgLevel ? null : new Set(ctx.source.scope.include.map((x) => x.trim().toLowerCase()));

/** finish a run: read outcomes (problems first), and a failure when nothing could be read at all */
function finish(observations: ScanObservation[], outcomes: DiscoveryReadOutcome[], writeScope: ScanResult["credentialWriteScope"]): ScanResult {
  const sorted = [...outcomes.filter((o) => o.status !== "read"), ...outcomes.filter((o) => o.status === "read")].slice(0, DISCOVERY_READ_OUTCOMES_MAX);
  if (!outcomes.some((o) => o.status === "read")) {
    throw new WiderSourceConfigError(`nothing could be read: ${sorted.map((o) => `${o.read} ${o.status}${o.detail ? ` (${o.detail})` : ""}`).join("; ").slice(0, 600)}`);
  }
  return { observations, readOutcomes: sorted, ...(writeScope ? { credentialWriteScope: writeScope } : {}) };
}

/** run one paged listing, recording its outcome; `page` returns the next URL or null */
async function readListing(
  ctx: ScanContext,
  read: string,
  first: string,
  outcomes: DiscoveryReadOutcome[],
  page: (body: unknown) => string | null,
  fetchPage: (url: string) => Promise<unknown>,
): Promise<boolean> {
  let url: string | null = first;
  let pages = 0;
  try {
    while (url && pages < WIDER_MAX_PAGES) {
      if (ctx.signal.aborted || !(await ctx.heartbeat())) {
        outcomes.push({ read, status: "skipped", detail: "the run's lease or time ran out" });
        return false;
      }
      url = page(await fetchPage(url));
      pages++;
    }
    outcomes.push({ read, status: "read", ...(url ? { detail: `stopped after ${WIDER_MAX_PAGES} pages` } : {}) });
    return true;
  } catch (err) {
    if (err instanceof ReadFailure) {
      outcomes.push({ read, status: err.status, detail: err.message });
      return false;
    }
    throw err;
  }
}

/** a next-page URL the service returned, kept only when it stays on the first URL's origin */
function sameOriginNext(base: string, next: unknown): string | null {
  const s = str(next, 4096);
  if (!s) return null;
  try {
    const u = new URL(s, base);
    return u.origin === new URL(base).origin && u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// saas_inventory_api
// ---------------------------------------------------------------------------

function saasTargetProblem(target: Readonly<Record<string, string>>): string | null {
  return (
    httpsTargetProblem(target.url, "url") ??
    fieldPathProblem(target.itemsPath, "itemsPath", true) ??
    fieldPathProblem(target.nameField ?? "name", "nameField") ??
    fieldPathProblem(target.domainField ?? "domain", "domainField") ??
    fieldPathProblem(target.usersField, "usersField", true) ??
    fieldPathProblem(target.nextField, "nextField", true)
  );
}

async function runSaasInventory(ctx: ScanContext): Promise<ScanResult> {
  const t = ctx.source.target;
  const problem = saasTargetProblem(t);
  if (problem) throw new WiderSourceConfigError(`saas_inventory_api: ${problem}`);
  const headers = tokenHeaders(ctx, "saas_inventory_api");
  const fetchImpl = scannerFetch(ctx);
  const keep = includeSet(ctx);
  const nameField = t.nameField ?? "name";
  const domainField = t.domainField ?? "domain";
  const observations: ScanObservation[] = [];
  const outcomes: DiscoveryReadOutcome[] = [];
  let seen = 0;
  await readListing(
    ctx,
    "SaaS app inventory",
    t.url!,
    outcomes,
    (body) => {
      const items = atPath(body, t.itemsPath ?? "");
      if (!Array.isArray(items)) throw new ReadFailure("error", `'${(t.itemsPath ?? "").slice(0, 60) || "the body"}' is not a list`);
      for (const item of items) {
        if (seen >= WIDER_MAX_ITEMS) return null;
        seen++;
        const name = str(atPath(item, nameField), 200);
        const host = hostOf(str(atPath(item, domainField), 512));
        if (!name && !host) continue;
        if (keep && !(host && keep.has(host)) && !(name && keep.has(name.toLowerCase()))) continue;
        const users = atPath(item, t.usersField ?? "");
        observations.push({
          evidenceKind: "saas_inventory",
          subjectKind: "saas_app",
          subject: host ?? name!,
          ...(host ? { host } : {}),
          ...(t.usersField && typeof users === "number" && Number.isInteger(users) && users > 0 ? { count: Math.min(users, 1_000_000) } : {}),
        });
      }
      return t.nextField ? sameOriginNext(t.url!, atPath(body, t.nextField)) : null;
    },
    (url) => getJson(fetchImpl, url, headers, ctx.signal),
  );
  // a generic API cannot be asked what its token may do: the admin's read-only token is trusted, and said so
  outcomes.push({ read: "credential write scope", status: "skipped", detail: "a generic inventory API cannot report its token's scope: use a read-only token" });
  return finish(observations, outcomes, "unverified");
}

// ---------------------------------------------------------------------------
// idp_entra
// ---------------------------------------------------------------------------

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function entraTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (!target.tenantId || !GUID.test(target.tenantId)) return "'tenantId' must be the Entra tenant's id (a GUID)";
  if (!scope.orgLevel && scope.include.some((x) => !GUID.test(x.trim()))) return "the scope names client application ids (GUIDs)";
  return null;
}

/**
 * The application permissions an Entra access token carries (its `roles` claim). The token is RegulAIt's own, just
 * issued to it; it is decoded to read the claim, never trusted for anything else. Read-only when every role is a
 * `.Read.All` or `.ReadBasic.All` permission; `write` otherwise; `unverified` when there is no claim.
 */
export function entraWriteScope(accessToken: string): { scope: "read_only" | "write" | "unverified"; roles: string[] } {
  const payload = accessToken.split(".")[1];
  if (!payload) return { scope: "unverified", roles: [] };
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { scope: "unverified", roles: [] };
  }
  const raw = claims && typeof claims === "object" ? (claims as Record<string, unknown>).roles : undefined;
  const roles = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string").slice(0, 50) : [];
  if (roles.length === 0) return { scope: "unverified", roles };
  return { scope: roles.every((r) => /\.Read(?:Basic)?\.All$/.test(r)) ? "read_only" : "write", roles };
}

interface EntraApp {
  appId: string;
  displayName: string | null;
  host: string | null;
}

async function runEntra(ctx: ScanContext): Promise<ScanResult> {
  const problem = entraTargetProblem(ctx.source.target, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`idp_entra: ${problem}`);
  const c = ctx.credential;
  if (!c) throw new WiderSourceConfigError("idp_entra: a credential is required");
  const tenantId = c.publicConfig.tenantId;
  const clientId = c.publicConfig.clientId;
  if (!tenantId || !clientId) throw new WiderSourceConfigError("idp_entra: the credential names tenantId and clientId");
  if (tenantId.toLowerCase() !== ctx.source.target.tenantId!.toLowerCase()) throw new WiderSourceConfigError("idp_entra: the credential's tenant is not the source's tenant");
  let credential;
  if (c.mode === "static") {
    if (!c.secret) throw new WiderSourceConfigError("idp_entra: the static credential has no client secret");
    credential = { mode: "azure_client_secret" as const, tenantId, clientId, clientSecret: c.secret };
  } else {
    if (!ctx.federation) throw new WiderSourceConfigError("idp_entra: federated credentials need RegulAIt's federation issuer; an admin turns federation on under Discovery sources");
    credential = { mode: "azure_federated" as const, tenantId, clientId };
  }
  const onSecret = dedupedSecretSink(ctx.registerSecret);
  const tokenSource = entraCredential({
    fetch: scannerFetch(ctx),
    credentialFetch: scannerFetch(ctx, { digest: false }),
    onSecret,
    credential,
    ...(ctx.federation ? { oidcToken: ctx.federation.sourceToken } : {}),
  });
  await ctx.throttle();
  let accessToken: string;
  try {
    const tok = await tokenSource.getToken(GRAPH_SCOPE, { abortSignal: ctx.signal });
    if (!tok?.token) throw new Error("no token");
    accessToken = tok.token;
  } catch (err) {
    const code = /AADSTS[0-9]{5,7}/.exec(err instanceof Error ? err.message : String(err))?.[0];
    throw new WiderSourceConfigError(`idp_entra: the Entra token request failed${code ? ` (${code})` : ""}`);
  }
  onSecret(accessToken);
  const write = entraWriteScope(accessToken);
  if (write.scope === "write") {
    // decision 7: a credential that may write is refused before anything is read
    return { observations: [], credentialWriteScope: "write", readOutcomes: [{ read: "credential write scope", status: "denied", detail: `the app holds more than read permissions: ${write.roles.join(", ").slice(0, 300)}` }] };
  }
  const fetchImpl = scannerFetch(ctx);
  const headers = { authorization: `Bearer ${accessToken}` };
  const outcomes: DiscoveryReadOutcome[] = [];
  const get = (url: string) => getJson(fetchImpl, url, headers, ctx.signal);
  // the key itself holds a dot, so it is read directly (own property), not as a dotted path
  const nextLink = (body: unknown) =>
    sameOriginNext(GRAPH_ORIGIN, body && typeof body === "object" && Object.hasOwn(body, "@odata.nextLink") ? (body as Record<string, unknown>)["@odata.nextLink"] : null);

  // the client applications by service principal object id
  const apps = new Map<string, EntraApp>();
  await readListing(
    ctx,
    "Entra service principals",
    `${GRAPH_ORIGIN}/v1.0/servicePrincipals?$select=id,appId,displayName,homepage,replyUrls&$top=999`,
    outcomes,
    (body) => {
      const value = atPath(body, "value");
      if (!Array.isArray(value)) throw new ReadFailure("error", "the service principal listing has no value list");
      for (const sp of value) {
        if (apps.size >= WIDER_MAX_ITEMS) return null;
        const id = str(atPath(sp, "id"), 64);
        const appId = str(atPath(sp, "appId"), 64);
        if (!id || !appId || !GUID.test(appId)) continue;
        const replyUrls = atPath(sp, "replyUrls");
        const firstReply = Array.isArray(replyUrls) ? (replyUrls.map((u) => hostOf(str(u, 2048))).find((h) => h !== null) ?? null) : null;
        apps.set(id, { appId: appId.toLowerCase(), displayName: str(atPath(sp, "displayName"), 120), host: hostOf(str(atPath(sp, "homepage"), 2048)) ?? firstReply });
      }
      return nextLink(body);
    },
    get,
  );

  // the consents, grouped by client application
  const grants = new Map<string, { scopes: Set<string>; users: Set<string>; tenantWide: boolean }>();
  await readListing(
    ctx,
    "Entra delegated permission grants",
    `${GRAPH_ORIGIN}/v1.0/oauth2PermissionGrants?$top=999`,
    outcomes,
    (body) => {
      const value = atPath(body, "value");
      if (!Array.isArray(value)) throw new ReadFailure("error", "the grant listing has no value list");
      for (const g of value) {
        const clientId = str(atPath(g, "clientId"), 64);
        if (!clientId) continue;
        const entry = grants.get(clientId) ?? { scopes: new Set<string>(), users: new Set<string>(), tenantWide: false };
        for (const s of (str(atPath(g, "scope"), 4096) ?? "").split(/\s+/)) {
          // scope NAMES only (a permission name, never a value), in the observation `names` shape
          if (/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(s) && !/^[A-Z][A-Z0-9_]*$/.test(s) && entry.scopes.size < 50) entry.scopes.add(s);
        }
        if (str(atPath(g, "consentType"), 32) === "AllPrincipals") entry.tenantWide = true;
        const principal = str(atPath(g, "principalId"), 64);
        if (principal && entry.users.size < 10_000) entry.users.add(principal);
        grants.set(clientId, entry);
        if (grants.size >= WIDER_MAX_ITEMS) return null;
      }
      return nextLink(body);
    },
    get,
  );

  const keep = includeSet(ctx);
  const observations: ScanObservation[] = [];
  for (const [spId, g] of grants) {
    const app = apps.get(spId);
    if (!app) continue;
    if (keep && !keep.has(app.appId)) continue;
    // the person behind a single-user consent is kept only as a pseudonym (decision 20); never for a tenant-wide one
    const onlyUser = !g.tenantWide && g.users.size === 1 ? [...g.users][0]! : null;
    observations.push({
      evidenceKind: "idp_app_grant",
      subjectKind: "saas_app",
      subject: app.displayName ? `${app.displayName} (${app.appId})` : app.appId,
      artifact: { kind: "oauth_app", value: app.appId },
      ...(app.host ? { host: app.host } : {}),
      count: g.tenantWide ? Math.max(1, g.users.size) : g.users.size,
      ...(g.scopes.size ? { names: [...g.scopes].sort() } : {}),
      ...(onlyUser ? { actorPseudonym: await ctx.pseudonymise("idp_user", onlyUser) } : {}),
    });
  }
  return finish(observations, outcomes, write.scope);
}

// ---------------------------------------------------------------------------
// ml_mlflow
// ---------------------------------------------------------------------------

/** the asset keys an MLflow-compatible platform's observations carry (`ml_platform_asset`, matched by identifier) */
export const MLFLOW_ASSET_KEYS = Object.freeze({
  registeredModel: "mlflow:registered_model",
  servingEndpoint: "mlflow:serving_endpoint",
  /** + the external model provider's name as the platform reports it */
  externalModelPrefix: "mlflow:external_model:",
});

function mlflowTargetProblem(target: Readonly<Record<string, string>>): string | null {
  const p = httpsTargetProblem(target.baseUrl, "baseUrl");
  if (p) return p;
  const u = new URL(target.baseUrl!);
  return u.search ? "'baseUrl' must not have a query" : null;
}

async function runMlflow(ctx: ScanContext): Promise<ScanResult> {
  const problem = mlflowTargetProblem(ctx.source.target);
  if (problem) throw new WiderSourceConfigError(`ml_mlflow: ${problem}`);
  const headers = tokenHeaders(ctx, "ml_mlflow");
  const fetchImpl = scannerFetch(ctx);
  const base = ctx.source.target.baseUrl!.replace(/\/+$/, "");
  const host = new URL(base).hostname.toLowerCase();
  const keep = includeSet(ctx);
  const wanted = (name: string) => !keep || keep.has(name.toLowerCase());
  const observations: ScanObservation[] = [];
  const outcomes: DiscoveryReadOutcome[] = [];
  const get = (url: string) => getJson(fetchImpl, url, headers, ctx.signal);
  const subjectOf = (what: string, name: string) => `${host}/${what}/${name}`.slice(0, 512);

  const modelsUrl = (token: string | null) =>
    `${base}/api/2.0/mlflow/registered-models/search?max_results=1000${token ? `&page_token=${encodeURIComponent(token)}` : ""}`;
  await readListing(
    ctx,
    "MLflow registered models",
    modelsUrl(null),
    outcomes,
    (body) => {
      const models = atPath(body, "registered_models") ?? [];
      if (!Array.isArray(models)) throw new ReadFailure("error", "the model listing has no registered_models list");
      for (const m of models) {
        if (observations.length >= WIDER_MAX_ITEMS) return null;
        const name = str(atPath(m, "name"), 256);
        if (!name || !wanted(name)) continue;
        observations.push({
          evidenceKind: "ml_platform_inventory",
          subjectKind: "system",
          subject: subjectOf("models", name),
          host,
          artifact: { kind: "ml_platform_asset", value: MLFLOW_ASSET_KEYS.registeredModel },
        });
      }
      const token = str(atPath(body, "next_page_token"), 2048);
      return token ? modelsUrl(token) : null;
    },
    get,
  );

  await readListing(
    ctx,
    "serving endpoints",
    `${base}/api/2.0/serving-endpoints`,
    outcomes,
    (body) => {
      const endpoints = atPath(body, "endpoints") ?? [];
      if (!Array.isArray(endpoints)) throw new ReadFailure("error", "the endpoint listing has no endpoints list");
      for (const e of endpoints) {
        if (observations.length >= WIDER_MAX_ITEMS) return null;
        const name = str(atPath(e, "name"), 256);
        if (!name || !wanted(name)) continue;
        const entities = atPath(atPath(e, "config"), "served_entities");
        const providers = new Set<string>();
        if (Array.isArray(entities)) {
          for (const ent of entities) {
            const provider = str(atPath(atPath(ent, "external_model"), "provider"), 64);
            if (provider && /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(provider)) providers.add(provider.toLowerCase());
          }
        }
        const subject = subjectOf("serving-endpoints", name);
        observations.push({ evidenceKind: "ml_platform_inventory", subjectKind: "system", subject, host, artifact: { kind: "ml_platform_asset", value: MLFLOW_ASSET_KEYS.servingEndpoint } });
        // an endpoint that forwards to an external model provider is AI use leaving the platform: one sighting each
        for (const p of providers) {
          observations.push({ evidenceKind: "ml_platform_inventory", subjectKind: "system", subject, host, artifact: { kind: "ml_platform_asset", value: `${MLFLOW_ASSET_KEYS.externalModelPrefix}${p}` } });
        }
      }
      return null;
    },
    get,
  );
  outcomes.push({ read: "credential write scope", status: "skipped", detail: "an MLflow-compatible API cannot report its token's scope: use a read-only token" });
  return finish(observations, outcomes, "unverified");
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export const WIDER_DISCOVERY_SCANNERS: readonly Scanner[] = Object.freeze([
  { kind: "saas_inventory_api", requiresCredential: true, run: runSaasInventory, validateTarget: (t) => saasTargetProblem(t) },
  { kind: "idp_entra", requiresCredential: true, run: runEntra, validateTarget: (t, s) => entraTargetProblem(t, s) },
  { kind: "ml_mlflow", requiresCredential: true, run: runMlflow, validateTarget: (t) => mlflowTargetProblem(t) },
]);

// ---------------------------------------------------------------------------
// catalogue seed (detection is data): the ML platform asset keys
// ---------------------------------------------------------------------------

const MLFLOW_REFERENCE = "https://mlflow.org/docs/latest/";
const mlRow = (provider: string, value: string, replacementNote: string) =>
  Object.freeze({
    provider,
    kind: "ml_platform_asset" as const,
    value,
    matchType: "identifier" as const,
    provenance: "regulait-seed" as const,
    enabled: true as const,
    reference: MLFLOW_REFERENCE,
    replacementNote,
  });

/**
 * ADR-0218: seed rows of signature kind `ml_platform_asset`. A registered model or a serving endpoint is an AI asset
 * outside governance; an endpoint forwarding to an external model provider is AI use leaving the platform. The
 * external-provider keys use the provider names the MLflow external-model configuration documents. An admin may
 * disable any row (an admin edit flips it to provenance `admin`). No `oauth_app` rows are seeded: an application id
 * is added by an admin once verified; consented apps match the existing hostname rows through their host.
 */
export const ML_PLATFORM_ASSET_SEED = Object.freeze([
  mlRow("self-hosted", MLFLOW_ASSET_KEYS.registeredModel, "register this model as a use case, or serve it through a governed RegulAIt agent registration"),
  mlRow("self-hosted", MLFLOW_ASSET_KEYS.servingEndpoint, "register this endpoint as a use case, and route its callers through the RegulAIt gateway"),
  ...(
    [
      ["openai", "openai"],
      ["anthropic", "anthropic"],
      ["cohere", "cohere"],
      ["mistral", "mistral"],
      ["gemini", "google"],
      ["amazon-bedrock", "aws-bedrock"],
      ["togetherai", "together"],
    ] as const
  ).map(([key, provider]) =>
    mlRow(provider, `${MLFLOW_ASSET_KEYS.externalModelPrefix}${key}`, "route this endpoint's external model through a governed RegulAIt agent registration"),
  ),
]);
