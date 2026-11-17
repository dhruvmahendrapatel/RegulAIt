/**
 * ADR-0337 (lane E18): the SaaS entitlement readers, registered as ADR-0195 discovery scanners.
 *
 * Each reader runs inside the discovery framework unchanged: a source an admin created and enabled (a step-up), in a
 * family switched on (`identity`), on a schedule, leased, with a credential the worker decrypts for the run only.
 * Network only through `ctx.fetch` (the egress-guarded fetch, via `scannerFetch`: throttle, backoff, digest; a
 * credential exchange is never digested). Every call is a GET except the token request, which reads and writes
 * nothing in the tenant. People appear only as pseudonyms (`idp_user`, decision 20). Nothing a response carries is
 * kept except the fields named below; bodies are digested and discarded (decision 6).
 *
 * A reader returns NO observations: it returns one `SaasEntitlementBatch` (vendor-neutral, `@regulait/shared`), which
 * the worker checks and stores in the entitlement graph tables in the run's own transaction.
 *
 *  - `entitlement_m365` (Microsoft Graph, beyond ADR-0235's consent discovery): every third-party or custom app's
 *    DELEGATED permissions (`oauth2PermissionGrants`, with the consenting users as pseudonyms) and APPLICATION
 *    permissions (`appRoleAssignedTo` on Microsoft Graph, Exchange Online and SharePoint Online, role ids resolved to
 *    permission names through each resource's `appRoles`). Microsoft's own first-party apps are left out. The token
 *    must carry read permissions only (decision 7), as for `idp_entra`.
 *  - `entitlement_google_workspace`: OAuth grants from the Admin SDK Reports API's `token` activity (`authorize` and
 *    `revoke` events, the latest per user and app wins), through domain-wide delegation with ONLY the read-only
 *    `admin.reports.audit.readonly` scope. The Directory API's token listing would see older grants, but its only scope
 *    (`admin.directory.user.security`) can also revoke them, so it is not used (secure by default, owner question in
 *    ADR-0337). Grants authorised before the window are therefore not seen, so the batch is always PARTIAL (it never
 *    removes a grant it did not see), and revocations are applied explicitly.
 *
 * TARGETS (key=value fields on the source; documented in docs/deployment/SAAS_ENTITLEMENTS.md):
 *  - entitlement_m365              tenantId; scope: organisation-level = every app, include = client application ids
 *  - entitlement_google_workspace  customerId? (default my_customer), lookbackDays? (1-180, default 180);
 *                                  scope: organisation-level = every app, include = OAuth client ids
 */
import {
  GOOGLE_WORKSPACE_DIRECTORY_USER_READONLY_SCOPE,
  GOOGLE_WORKSPACE_DIRECTORY_USER_SECURITY_SCOPE,
  GOOGLE_WORKSPACE_REPORTS_READONLY_SCOPE,
  workspaceDelegatedClient,
} from "@regulait/cloud-discovery";
import type { DiscoveryReadOutcome, SaasAppEntitlement, SaasEntitlementBatch, SaasScopeGrant } from "@regulait/shared";
import { SAAS_ENTITLEMENT_LIMITS } from "@regulait/shared";
import { dedupedSecretSink, scannerFetch } from "./discovery-cloud-scanners.js";
import {
  GRAPH_ORIGIN,
  GUID,
  ITEM_CAP,
  ReadFailure,
  WIDER_MAX_ITEMS,
  WiderSourceConfigError,
  atPath,
  entraGraphToken,
  finish,
  getJson,
  includeSet,
  readListing,
  sameOriginNext,
  str,
} from "./discovery-wider-scanners.js";
import type { ScanContext, ScanResult, Scanner } from "./discovery-scanners.js";
import { errMessage } from "./err-serializer.js";

/**
 * A read outcome that says the listing was not read to its end. A resource that is not provisioned in the tenant
 * (`not_enabled` on its application roles: HTTP 404) holds no assignments, so it does not make a read partial.
 */
const cutShort = (o: DiscoveryReadOutcome) =>
  !(o.status === "not_enabled" && o.read.endsWith(" application roles")) && (o.status !== "read" || (o.detail !== undefined && o.detail.startsWith("stopped after")));

/**
 * A vendor-chosen label (an app or publisher name), bounded, with control characters turned into spaces: anyone who can
 * register an app chooses its name, and one name the batch check refuses must not fail the whole tenant's read.
 */
const label = (v: unknown, max: number): string | null => {
  const s = str(v, max)?.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return s ? s : null;
};

/** an app as the readers build it, before it becomes a batch entry */
interface AppDraft {
  app: Omit<SaasAppEntitlement, "grants">;
  grants: Map<string, SaasScopeGrant>;
}

function addGrant(draft: AppDraft, g: Omit<SaasScopeGrant, "principals">, principal: string | null): boolean {
  const key = `${g.resource}\u0000${g.scope}\u0000${g.grantType}`;
  let cur = draft.grants.get(key);
  if (!cur) {
    if (draft.grants.size >= SAAS_ENTITLEMENT_LIMITS.grantsPerApp) return false;
    cur = { ...g, principals: [] };
    draft.grants.set(key, cur);
  }
  if (g.consent === "tenant" || cur.consent === "tenant") {
    cur.consent = "tenant";
    cur.principals = [];
    return true;
  }
  if (principal && !cur.principals.includes(principal)) {
    if (cur.principals.length >= SAAS_ENTITLEMENT_LIMITS.principalsPerGrant) return false;
    cur.principals.push(principal);
  }
  return true;
}

// ---------------------------------------------------------------------------
// entitlement_m365
// ---------------------------------------------------------------------------

/** the tenants that publish Microsoft's own first-party apps (left out: they are the platform, not an agent) */
export const MICROSOFT_FIRST_PARTY_TENANTS: ReadonlySet<string> = new Set(["f8cdef31-a31e-4b4a-93e4-5f571e91255a", "72f988bf-86f1-41af-91ab-2d7cd011db47"]);

/** the resources whose application permissions are read: Microsoft Graph, Exchange Online, SharePoint Online */
export const M365_PERMISSION_RESOURCES = Object.freeze([
  { appId: "00000003-0000-0000-c000-000000000000", label: "Microsoft Graph" },
  { appId: "00000002-0000-0ff1-ce00-000000000000", label: "Office 365 Exchange Online" },
  { appId: "00000003-0000-0ff1-ce00-000000000000", label: "Office 365 SharePoint Online" },
]);

function m365TargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (!target.tenantId || !GUID.test(target.tenantId)) return "'tenantId' must be the Entra tenant's id (a GUID)";
  if (!scope.orgLevel && scope.include.some((x) => !GUID.test(x.trim()))) return "the scope names client application ids (GUIDs)";
  return null;
}

interface M365Principal {
  appId: string;
  displayName: string | null;
  owner: string | null;
  publisher: string | null;
  verified: boolean | null;
}

async function runM365Entitlements(ctx: ScanContext): Promise<ScanResult> {
  const problem = m365TargetProblem(ctx.source.target, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`entitlement_m365: ${problem}`);
  const token = await entraGraphToken(ctx, "entitlement_m365");
  if ("refused" in token) return token.refused;
  const fetchImpl = scannerFetch(ctx);
  const headers = { authorization: `Bearer ${token.accessToken}` };
  const outcomes: DiscoveryReadOutcome[] = [];
  const get = (url: string) => getJson(fetchImpl, url, headers, ctx.signal);
  const nextLink = (body: unknown) =>
    sameOriginNext(GRAPH_ORIGIN, body && typeof body === "object" && Object.hasOwn(body, "@odata.nextLink") ? (body as Record<string, unknown>)["@odata.nextLink"] : null);
  const values = (body: unknown, what: string): unknown[] => {
    const v = atPath(body, "value");
    if (!Array.isArray(v)) throw new ReadFailure("error", `the ${what} listing has no value list`);
    return v;
  };

  // every service principal, by object id (the clients, and the resources their delegated grants point at)
  const principals = new Map<string, M365Principal>();
  await readListing(
    ctx,
    "Microsoft Graph service principals",
    `${GRAPH_ORIGIN}/v1.0/servicePrincipals?$select=id,appId,displayName,appOwnerOrganizationId,publisherName,verifiedPublisher&$top=999`,
    outcomes,
    (body) => {
      for (const sp of values(body, "service principal")) {
        if (principals.size >= WIDER_MAX_ITEMS) return ITEM_CAP;
        const id = str(atPath(sp, "id"), 64);
        const appId = str(atPath(sp, "appId"), 64);
        if (!id || !appId || !GUID.test(appId)) continue;
        const verifiedName = label(atPath(sp, "verifiedPublisher.displayName"), SAAS_ENTITLEMENT_LIMITS.publisher);
        principals.set(id, {
          appId: appId.toLowerCase(),
          displayName: label(atPath(sp, "displayName"), SAAS_ENTITLEMENT_LIMITS.displayName),
          owner: str(atPath(sp, "appOwnerOrganizationId"), 64)?.toLowerCase() ?? null,
          publisher: verifiedName ?? label(atPath(sp, "publisherName"), SAAS_ENTITLEMENT_LIMITS.publisher),
          verified: verifiedName ? true : atPath(sp, "verifiedPublisher") && typeof atPath(sp, "verifiedPublisher") === "object" ? false : null,
        });
      }
      return nextLink(body);
    },
    get,
  );

  const keep = includeSet(ctx);
  const drafts = new Map<string, AppDraft>();
  let truncated = false;
  let unmatched = 0;
  /** the draft for a client service principal, or null when it is left out (first-party, out of scope, unknown) */
  const draftFor = (spId: string): AppDraft | null => {
    const sp = principals.get(spId);
    if (!sp) {
      unmatched += 1;
      return null;
    }
    if (sp.owner && MICROSOFT_FIRST_PARTY_TENANTS.has(sp.owner)) return null;
    if (keep && !keep.has(sp.appId)) return null;
    let d = drafts.get(sp.appId);
    if (!d) {
      if (drafts.size >= SAAS_ENTITLEMENT_LIMITS.apps) {
        truncated = true;
        return null;
      }
      d = { app: { externalId: sp.appId, appKind: "service_principal", displayName: sp.displayName, publisher: sp.publisher, publisherVerified: sp.verified }, grants: new Map() };
      drafts.set(sp.appId, d);
    }
    return d;
  };

  // delegated permissions: what each client may do on behalf of the users who consented (or of everyone)
  const delegated: Array<{ client: string; resource: string; scopes: string[]; tenant: boolean; principal: string | null }> = [];
  await readListing(
    ctx,
    "Microsoft Graph delegated permission grants",
    `${GRAPH_ORIGIN}/v1.0/oauth2PermissionGrants?$top=999`,
    outcomes,
    (body) => {
      for (const g of values(body, "grant")) {
        if (delegated.length >= WIDER_MAX_ITEMS * 4) return ITEM_CAP;
        const client = str(atPath(g, "clientId"), 64);
        const resource = str(atPath(g, "resourceId"), 64);
        if (!client || !resource) continue;
        const scopes = (str(atPath(g, "scope"), 8192) ?? "").split(/\s+/).filter((s) => /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(s));
        delegated.push({ client, resource, scopes, tenant: str(atPath(g, "consentType"), 32) === "AllPrincipals", principal: str(atPath(g, "principalId"), 64) });
      }
      return nextLink(body);
    },
    get,
  );
  for (const g of delegated) {
    const d = draftFor(g.client);
    if (!d) continue;
    const resource = principals.get(g.resource)?.appId;
    if (!resource) {
      unmatched += 1;
      continue;
    }
    const principal = !g.tenant && g.principal ? await ctx.pseudonymise("idp_user", g.principal) : null;
    for (const scope of g.scopes) {
      if (!addGrant(d, { resource, scope, grantType: "delegated", consent: g.tenant ? "tenant" : "user" }, principal)) truncated = true;
    }
  }

  // application permissions: what each client may do as itself, on the three Microsoft 365 resources
  for (const res of M365_PERMISSION_RESOURCES) {
    const roles = new Map<string, string>();
    let resourceSpId: string | null = null;
    const ok = await readListing(
      ctx,
      `${res.label} application roles`,
      `${GRAPH_ORIGIN}/v1.0/servicePrincipals(appId='${res.appId}')?$select=id,appRoles`,
      outcomes,
      (body) => {
        resourceSpId = str(atPath(body, "id"), 64);
        const appRoles = atPath(body, "appRoles");
        if (Array.isArray(appRoles)) {
          for (const r of appRoles) {
            const id = str(atPath(r, "id"), 64);
            const value = str(atPath(r, "value"), 128);
            if (id && value && /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(value)) roles.set(id.toLowerCase(), value);
          }
        }
        return null;
      },
      get,
    );
    if (!ok || !resourceSpId) continue;
    await readListing(
      ctx,
      `${res.label} application permission assignments`,
      `${GRAPH_ORIGIN}/v1.0/servicePrincipals/${encodeURIComponent(resourceSpId)}/appRoleAssignedTo?$top=999`,
      outcomes,
      (body) => {
        for (const a of values(body, "assignment")) {
          if (str(atPath(a, "principalType"), 32) !== "ServicePrincipal") continue;
          const client = str(atPath(a, "principalId"), 64);
          const role = roles.get((str(atPath(a, "appRoleId"), 64) ?? "").toLowerCase());
          if (!client || !role) continue;
          const d = draftFor(client);
          if (d && !addGrant(d, { resource: res.appId, scope: role, grantType: "application", consent: "tenant" }, null)) truncated = true;
        }
        return nextLink(body);
      },
      get,
    );
  }

  if (unmatched > 0) outcomes.push({ read: "Microsoft Graph grants matched to applications", status: "skipped", detail: `${unmatched} grant(s) named a service principal that was not in the listing and are not reported` });
  if (truncated) outcomes.push({ read: "entitlement batch size", status: "skipped", detail: "a per-app or per-grant bound was reached: the rest was not kept" });
  const complete = !truncated && unmatched === 0 && !outcomes.some(cutShort);
  const result = finish([], outcomes, token.write.scope);
  const entitlements: SaasEntitlementBatch = {
    platform: "m365",
    tenant: ctx.source.target.tenantId!.toLowerCase(),
    complete,
    apps: [...drafts.values()].filter((d) => d.grants.size > 0).map((d) => ({ ...d.app, grants: [...d.grants.values()] })),
  };
  return { ...result, entitlements };
}

// ---------------------------------------------------------------------------
// entitlement_google_workspace
// ---------------------------------------------------------------------------

const REPORTS_ORIGIN = "https://admin.googleapis.com";
export const GOOGLE_REPORTS_MAX_LOOKBACK_DAYS = 180;
/** a Google OAuth client id: digits, a hyphen, a hash, or a bare numeric id (installed apps), bounded */
const GOOGLE_CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const GOOGLE_CUSTOMER_ID = /^(?:my_customer|C[0-9a-z]{6,20})$/;

function workspaceTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (target.directoryTokens !== undefined && target.directoryTokens !== "on" && target.directoryTokens !== "off") return "'directoryTokens' is 'on' (the admin opt-in Directory token listing) or 'off' (the default)";
  if (target.customerId !== undefined && !GOOGLE_CUSTOMER_ID.test(target.customerId)) return "'customerId' must be my_customer or a Workspace customer id (C…)";
  if (target.lookbackDays !== undefined) {
    const n = Number(target.lookbackDays);
    if (!Number.isInteger(n) || n < 1 || n > GOOGLE_REPORTS_MAX_LOOKBACK_DAYS) return `'lookbackDays' must be a whole number from 1 to ${GOOGLE_REPORTS_MAX_LOOKBACK_DAYS} (the Reports API keeps token events 180 days)`;
  }
  if (!scope.orgLevel && scope.include.some((x) => !GOOGLE_CLIENT_ID.test(x.trim()))) return "the scope names OAuth client ids";
  return null;
}

/** one parameter of a Reports API event, own properties only */
function eventParam(event: unknown, name: string): { value: string | null; multi: string[] } {
  const params = atPath(event, "parameters");
  if (!Array.isArray(params)) return { value: null, multi: [] };
  for (const p of params) {
    if (atPath(p, "name") !== name) continue;
    const multi = atPath(p, "multiValue");
    return { value: str(atPath(p, "value"), 512), multi: Array.isArray(multi) ? multi.map((m) => str(m, 512)).filter((m): m is string => m !== null) : [] };
  }
  return { value: null, multi: [] };
}

interface TokenEvent {
  at: string;
  kind: "authorize" | "revoke";
  appName: string | null;
  scopes: string[];
}

async function runWorkspaceEntitlements(ctx: ScanContext): Promise<ScanResult> {
  const t = ctx.source.target;
  const problem = workspaceTargetProblem(t, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`entitlement_google_workspace: ${problem}`);
  const c = ctx.credential;
  if (!c || c.mode !== "static" || !c.secret) throw new WiderSourceConfigError("entitlement_google_workspace: a static credential holding the service-account key is required");
  const directory = t.directoryTokens === "on";
  const subject = c.publicConfig.adminSubject;
  if (!subject) throw new WiderSourceConfigError("entitlement_google_workspace: the credential names adminSubject, the admin the read acts for");
  const onSecret = dedupedSecretSink(ctx.registerSecret);
  let accessToken: string;
  try {
    const client = workspaceDelegatedClient({
      fetch: scannerFetch(ctx),
      credentialFetch: scannerFetch(ctx, { digest: false }),
      onSecret,
      keyJson: c.secret,
      subject,
      // the Reports scope only, unless an admin opted in to the Directory token listing (ADR-0337 §4)
      scopes: directory ? [GOOGLE_WORKSPACE_DIRECTORY_USER_READONLY_SCOPE, GOOGLE_WORKSPACE_DIRECTORY_USER_SECURITY_SCOPE] : [GOOGLE_WORKSPACE_REPORTS_READONLY_SCOPE],
    });
    await ctx.throttle();
    const tok = await client.getAccessToken();
    if (!tok.token) throw new Error("no token");
    accessToken = tok.token;
  } catch (err) {
    // only Google's OAuth error code is kept from the error text, never the response body
    const code = /\b(unauthorized_client|invalid_grant|access_denied|invalid_client|invalid_scope)\b/.exec(errMessage(err))?.[1];
    throw new WiderSourceConfigError(
      `entitlement_google_workspace: the delegated token request failed${code ? ` (${code})` : ""}; check the service account's domain-wide delegation of ${directory ? "the two Directory scopes" : "the read-only Reports scope"}`,
    );
  }
  onSecret(accessToken);
  // every data call is a GET: a revoke (DELETE) is refused before it leaves, whatever the token could do
  const fetchImpl = readOnlyFetch(scannerFetch(ctx));
  const headers = { authorization: `Bearer ${accessToken}` };
  if (directory) return runWorkspaceDirectory(ctx, fetchImpl, headers);
  const get = (url: string) => getJson(fetchImpl, url, headers, ctx.signal);
  const outcomes: DiscoveryReadOutcome[] = [];
  const lookback = t.lookbackDays ? Number(t.lookbackDays) : GOOGLE_REPORTS_MAX_LOOKBACK_DAYS;
  const start = new Date(Date.now() - lookback * 86_400_000).toISOString();
  const customer = t.customerId && t.customerId !== "my_customer" ? `&customerId=${encodeURIComponent(t.customerId)}` : "";
  const keep = includeSet(ctx);

  // the latest token event per (user, client); a later revoke cancels an earlier authorize and the reverse
  const latest = new Map<string, Map<string, TokenEvent>>();
  let events = 0;
  for (const eventName of ["authorize", "revoke"] as const) {
    const base = `${REPORTS_ORIGIN}/admin/reports/v1/activity/users/all/applications/token?eventName=${eventName}&startTime=${encodeURIComponent(start)}&maxResults=1000${customer}`;
    await readListing(
      ctx,
      `Google Workspace token ${eventName} events`,
      base,
      outcomes,
      (body) => {
        const items = atPath(body, "items");
        if (items !== undefined && !Array.isArray(items)) throw new ReadFailure("error", "the activity listing has no item list");
        for (const item of (items as unknown[] | undefined) ?? []) {
          if (events >= WIDER_MAX_ITEMS * 10) return ITEM_CAP;
          events += 1;
          const at = str(atPath(item, "id.time"), 64);
          // the stable profile id is preferred; the email only when Google gives no profile id
          const user = str(atPath(item, "actor.profileId"), 64) ?? str(atPath(item, "actor.email"), 320);
          const evs = atPath(item, "events");
          if (!at || !user || !Array.isArray(evs)) continue;
          for (const ev of evs) {
            if (atPath(ev, "name") !== eventName) continue;
            const clientId = eventParam(ev, "client_id").value;
            if (!clientId || !GOOGLE_CLIENT_ID.test(clientId)) continue;
            if (keep && !keep.has(clientId.toLowerCase())) continue;
            const scopes = eventParam(ev, "scope").multi.filter((s) => s.length <= SAAS_ENTITLEMENT_LIMITS.scope && /^[\x21-\x7e]+$/.test(s));
            const perUser = latest.get(clientId) ?? new Map<string, TokenEvent>();
            const prev = perUser.get(user);
            if (!prev || prev.at < at) perUser.set(user, { at, kind: eventName, appName: label(eventParam(ev, "app_name").value, SAAS_ENTITLEMENT_LIMITS.displayName), scopes });
            latest.set(clientId, perUser);
          }
        }
        const token = str(atPath(body, "nextPageToken"), 2048);
        return token ? `${base}&pageToken=${encodeURIComponent(token)}` : null;
      },
      get,
    );
  }

  const drafts = new Map<string, AppDraft>();
  const revokedPrincipals: Array<{ externalId: string; principal: string }> = [];
  let truncated = false;
  for (const [clientId, perUser] of latest) {
    for (const [user, ev] of perUser) {
      const principal = await ctx.pseudonymise("idp_user", user);
      if (ev.kind === "revoke") {
        if (revokedPrincipals.length < SAAS_ENTITLEMENT_LIMITS.revokedPrincipals) revokedPrincipals.push({ externalId: clientId, principal });
        else truncated = true;
        continue;
      }
      let d = drafts.get(clientId);
      if (!d) {
        if (drafts.size >= SAAS_ENTITLEMENT_LIMITS.apps) {
          truncated = true;
          continue;
        }
        d = { app: { externalId: clientId, appKind: "oauth_client", displayName: ev.appName, publisher: null, publisherVerified: null }, grants: new Map() };
        drafts.set(clientId, d);
      }
      if (!d.app.displayName && ev.appName) d.app.displayName = ev.appName;
      for (const scope of ev.scopes) if (!addGrant(d, { resource: "", scope, grantType: "delegated", consent: "user" }, principal)) truncated = true;
    }
  }
  if (truncated) outcomes.push({ read: "entitlement batch size", status: "skipped", detail: "a per-app or per-grant bound was reached: the rest was not kept" });
  outcomes.push({ read: "Google Workspace grants older than the window", status: "skipped", detail: `the Reports API shows grants authorised in the last ${lookback} days only; older grants are not seen, so nothing unseen is removed` });
  // the token carries only the read-only Reports scope; whether the delegation allows more cannot be read, so unverified
  const result = finish([], outcomes, "unverified");
  const entitlements: SaasEntitlementBatch = {
    platform: "google_workspace",
    tenant: t.customerId ?? "my_customer",
    complete: false,
    apps: [...drafts.values()].filter((d) => d.grants.size > 0).map((d) => ({ ...d.app, grants: [...d.grants.values()] })),
    revokedPrincipals,
  };
  return { ...result, entitlements };
}

/**
 * A fetch that only reads. The opt-in Directory scope (`admin.directory.user.security`) can also revoke a user's
 * tokens; an entitlement reader never revokes (findings are recommendations acted on through the governed removal
 * flow), so any method other than GET or HEAD is refused here, before it leaves the gateway.
 */
export function readOnlyFetch(f: typeof fetch): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      throw new Error(`entitlement reader: ${method} refused: a reader only reads; a revoke goes through the governed removal flow`);
    }
    return f(input, init);
  }) as typeof fetch;
}

/** a Google Directory user id (numeric), bounded */
const GOOGLE_USER_ID = /^[0-9]{1,64}$/;

/**
 * The admin opt-in Directory read (owner decision 2026-11-17): every user (`users.list`), then each user's OAuth tokens
 * (`users.tokens.list`). It sees grants older than the Reports window, so a read that reached every user and every
 * listing is COMPLETE (an unseen grant was revoked); anything less is partial and removes nothing unseen.
 */
async function runWorkspaceDirectory(ctx: ScanContext, fetchImpl: typeof fetch, headers: Record<string, string>): Promise<ScanResult> {
  const t = ctx.source.target;
  const get = (url: string) => getJson(fetchImpl, url, headers, ctx.signal);
  const outcomes: DiscoveryReadOutcome[] = [];
  const keep = includeSet(ctx);
  const customer = encodeURIComponent(t.customerId ?? "my_customer");
  const userIds: string[] = [];
  const base = `${REPORTS_ORIGIN}/admin/directory/v1/users?customer=${customer}&maxResults=500&projection=basic&fields=${encodeURIComponent("users(id),nextPageToken")}`;
  await readListing(
    ctx,
    "Google Workspace users (Directory)",
    base,
    outcomes,
    (body) => {
      const users = atPath(body, "users");
      if (users !== undefined && !Array.isArray(users)) throw new ReadFailure("error", "the user listing has no user list");
      for (const u of (users as unknown[] | undefined) ?? []) {
        if (userIds.length >= WIDER_MAX_ITEMS) return ITEM_CAP;
        const id = str(atPath(u, "id"), 64);
        if (id && GOOGLE_USER_ID.test(id)) userIds.push(id);
      }
      const token = str(atPath(body, "nextPageToken"), 2048);
      return token ? `${base}&pageToken=${encodeURIComponent(token)}` : null;
    },
    get,
  );

  const drafts = new Map<string, AppDraft>();
  let truncated = false;
  let failed = 0;
  let firstFailure: ReadFailure | null = null;
  let stopped = false;
  let read = 0;
  for (const id of userIds) {
    if (ctx.signal.aborted || !(await ctx.heartbeat())) {
      stopped = true;
      break;
    }
    let body: unknown;
    try {
      body = await get(`${REPORTS_ORIGIN}/admin/directory/v1/users/${encodeURIComponent(id)}/tokens`);
    } catch (err) {
      if (!(err instanceof ReadFailure)) throw err;
      failed += 1;
      firstFailure ??= err;
      continue;
    }
    read += 1;
    const items = atPath(body, "items");
    if (!Array.isArray(items)) continue;
    const principal = await ctx.pseudonymise("idp_user", id);
    for (const item of items) {
      const clientId = str(atPath(item, "clientId"), 255);
      if (!clientId || !GOOGLE_CLIENT_ID.test(clientId)) continue;
      if (keep && !keep.has(clientId.toLowerCase())) continue;
      const scopes = atPath(item, "scopes");
      let d = drafts.get(clientId);
      if (!d) {
        if (drafts.size >= SAAS_ENTITLEMENT_LIMITS.apps) {
          truncated = true;
          continue;
        }
        d = { app: { externalId: clientId, appKind: "oauth_client", displayName: label(atPath(item, "displayText"), SAAS_ENTITLEMENT_LIMITS.displayName), publisher: null, publisherVerified: null }, grants: new Map() };
        drafts.set(clientId, d);
      }
      for (const scope of Array.isArray(scopes) ? scopes : []) {
        const name = str(scope, SAAS_ENTITLEMENT_LIMITS.scope);
        if (!name || !/^[\x21-\x7e]+$/.test(name)) continue;
        if (!addGrant(d, { resource: "", scope: name, grantType: "delegated", consent: "user" }, principal)) truncated = true;
      }
    }
  }
  const tokensRead = "Google Workspace user tokens (Directory)";
  if (stopped) outcomes.push({ read: tokensRead, status: "skipped", detail: `the run's lease or time ran out after ${read} of ${userIds.length} users` });
  else if (failed > 0 && read === 0 && firstFailure) outcomes.push({ read: tokensRead, status: firstFailure.status, detail: firstFailure.message });
  else outcomes.push({ read: tokensRead, status: "read", ...(failed > 0 ? { detail: `stopped after ${read} of ${userIds.length} users: ${failed} listing(s) could not be read` } : {}) });
  if (truncated) outcomes.push({ read: "entitlement batch size", status: "skipped", detail: "a per-app or per-grant bound was reached: the rest was not kept" });
  // completeness first: the note below is informational, not a listing cut short
  const complete = !stopped && failed === 0 && !truncated && !outcomes.some(cutShort);
  outcomes.push({
    read: "Google Workspace token scope",
    status: "skipped",
    detail: "the opted-in Directory token scope can also revoke tokens; this reader only reads (every data call is a GET)",
  });
  const result = finish([], outcomes, "unverified");
  const entitlements: SaasEntitlementBatch = {
    platform: "google_workspace",
    tenant: t.customerId ?? "my_customer",
    complete,
    apps: [...drafts.values()].filter((d) => d.grants.size > 0).map((d) => ({ ...d.app, grants: [...d.grants.values()] })),
    revokedPrincipals: [],
  };
  return { ...result, entitlements };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export const SAAS_ENTITLEMENT_SCANNERS: readonly Scanner[] = Object.freeze([
  { kind: "entitlement_m365", requiresCredential: true, run: runM365Entitlements, validateTarget: (t, s) => m365TargetProblem(t, s) },
  { kind: "entitlement_google_workspace", requiresCredential: true, run: runWorkspaceEntitlements, validateTarget: (t, s) => workspaceTargetProblem(t, s) },
]);
