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
 *  - entitlement_salesforce        loginUrl (https://login.salesforce.com, https://test.salesforce.com or a
 *                                  https://<domain>.my.salesforce.com), orgId (00D…); scope: organisation-level =
 *                                  every connected app, include = connected app ids (0H4…)
 *  - entitlement_slack             enterpriseId (E…, Enterprise Grid org) or teamId (T…); scope: organisation-level
 *                                  = every app, include = Slack app ids
 *  - entitlement_google_workspace  customerId? (default my_customer), lookbackDays? (1-180, default 180);
 *                                  scope: organisation-level = every app, include = OAuth client ids
 */
import {
  GOOGLE_WORKSPACE_DIRECTORY_USER_READONLY_SCOPE,
  GOOGLE_WORKSPACE_DIRECTORY_USER_SECURITY_SCOPE,
  GOOGLE_WORKSPACE_REPORTS_READONLY_SCOPE,
  workspaceDelegatedClient,
} from "@regulait/cloud-discovery";
import { BodyTooLargeError, readBodyCapped } from "@regulait/cloud-discovery";
import { SignJWT, importPKCS8 } from "jose";
import type { DiscoveryReadOutcome, SaasAppEntitlement, SaasAppUsage, SaasEntitlementBatch, SaasScopeGrant, SaasUsageObservation } from "@regulait/shared";
import { SAAS_ENTITLEMENT_LIMITS, classifyGoogleApiMethod } from "@regulait/shared";
import { dedupedSecretSink, scannerFetch } from "./discovery-cloud-scanners.js";
import {
  GRAPH_ORIGIN,
  GUID,
  ITEM_CAP,
  ReadFailure,
  WIDER_MAX_BODY_BYTES,
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
  if (token.write.scope === "write") {
    // ADR-0195 decision 7: a credential that may write is refused before anything is read
    return { observations: [], credentialWriteScope: "write", readOutcomes: [{ read: "credential write scope", status: "denied", detail: `the app holds more than read permissions: ${token.write.roles.join(", ").slice(0, 300)}` }] };
  }
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
  const apps = [...drafts.values()].filter((d) => d.grants.size > 0).map((d) => ({ ...d.app, grants: [...d.grants.values()] }));
  // observed use (ADR-0337 §5): read after `complete` is decided, so a usage read that fails never makes the grant
  // read partial; it only makes use unobservable
  const usage = await readM365Usage(ctx, get, nextLink, values, new Set(apps.map((a) => a.externalId)), outcomes);
  const result = finish([], outcomes, token.write.scope);
  const entitlements: SaasEntitlementBatch = { platform: "m365", tenant: ctx.source.target.tenantId!.toLowerCase(), complete, apps, usage };
  return { ...result, entitlements };
}

/** an instant a vendor reported, as ISO 8601, or null when it is not a time */
const isoInstant = (v: unknown): string | null => {
  const s = str(v, 40);
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) && t <= Date.now() + 86_400_000 ? new Date(t).toISOString() : null;
};

/** why a reader observes no use (ADR-0337 §5): the findings show it as "not assessable", never as "unused" */
export const USAGE_NOT_OBSERVED = Object.freeze({
  directory: "the Directory token listing carries no API activity and the opt-in asks for no Reports scope, so use is not observed",
  salesforce:
    "Salesforce login history and API event log files need permissions this read-only integration user does not hold (Monitor Login History, View Event Log Files), so use is not observed yet",
  slack: "Slack offers no read-only source of an app's API use (its access and integration logs need the write-capable admin scope), so use is not observed",
});

export const M365_USAGE_READ = "Microsoft Entra service principal sign-in activity";

/**
 * When each app last signed in (Graph beta `reports/servicePrincipalSignInActivities`: `AuditLog.Read.All`, a read
 * permission, and Microsoft Entra ID P1 or P2). Per app, not per scope, and no split between reads and writes, so the
 * coverage is `app`. Only a listing read to its end counts: an app missing from a cut-short listing may have signed in.
 */
async function readM365Usage(
  ctx: ScanContext,
  get: (url: string) => Promise<unknown>,
  nextLink: (body: unknown) => string | null,
  values: (body: unknown, what: string) => unknown[],
  held: ReadonlySet<string>,
  outcomes: DiscoveryReadOutcome[],
): Promise<SaasUsageObservation> {
  const lastUse = new Map<string, string>();
  const before = outcomes.length;
  const ok = await readListing(
    ctx,
    M365_USAGE_READ,
    `${GRAPH_ORIGIN}/beta/reports/servicePrincipalSignInActivities?$top=999`,
    outcomes,
    (body) => {
      for (const a of values(body, "sign-in activity")) {
        if (lastUse.size >= SAAS_ENTITLEMENT_LIMITS.apps) return ITEM_CAP;
        const appId = str(atPath(a, "appId"), 64)?.toLowerCase();
        const at = isoInstant(atPath(a, "lastSignInActivity.lastSignInDateTime"));
        if (appId && at && held.has(appId)) lastUse.set(appId, at);
      }
      return nextLink(body);
    },
    get,
  );
  const outcome = outcomes[before];
  if (!ok || !outcome || cutShort(outcome)) {
    return {
      coverage: "none",
      windowStart: null,
      note: "Entra sign-in activity was not read to its end (it needs AuditLog.Read.All and Microsoft Entra ID P1 or P2), so use is not observed",
      apps: [],
    };
  }
  return {
    coverage: "app",
    windowStart: null,
    note: "Entra service-principal sign-in activity: each app's last sign-in, per app, with no split between reads and writes",
    apps: [...lastUse].map(([externalId, lastUseAt]) => ({ externalId, lastUseAt, lastReadAt: null, lastWriteAt: null })),
  };
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
  // observed use (ADR-0337 §5): the token `activity` events, with the same read-only Reports scope
  const usage = await readWorkspaceUsage(ctx, get, start, customer, keep, outcomes);
  // the token carries only the read-only Reports scope; whether the delegation allows more cannot be read, so unverified
  const result = finish([], outcomes, "unverified");
  const entitlements: SaasEntitlementBatch = {
    platform: "google_workspace",
    tenant: t.customerId ?? "my_customer",
    complete: false,
    apps: [...drafts.values()].filter((d) => d.grants.size > 0).map((d) => ({ ...d.app, grants: [...d.grants.values()] })),
    revokedPrincipals,
    usage,
  };
  return { ...result, entitlements };
}

export const WORKSPACE_USAGE_READ = "Google Workspace token activity events";

/**
 * Each app's latest read and latest write, from the Reports API's token `activity` events (one per API method an app
 * called for a user; the `method_name` is classified by the frozen `classifyGoogleApiMethod`). Google records these
 * events only on Enterprise and Education Standard or Plus and Cloud Identity Premium, so a tenant where the read saw
 * none at all cannot be told from one that records none: its coverage is `none`, never "nothing was used".
 *
 * The listing comes newest first. When it is cut short at the item bound, the events read still cover a shorter,
 * recent window, so the window start becomes the oldest event read rather than throwing the observation away.
 */
async function readWorkspaceUsage(
  ctx: ScanContext,
  get: (url: string) => Promise<unknown>,
  start: string,
  customer: string,
  keep: ReadonlySet<string> | null,
  outcomes: DiscoveryReadOutcome[],
): Promise<SaasUsageObservation> {
  const base = `${REPORTS_ORIGIN}/admin/reports/v1/activity/users/all/applications/token?eventName=activity&startTime=${encodeURIComponent(start)}&maxResults=1000${customer}`;
  const perApp = new Map<string, SaasAppUsage>();
  let events = 0;
  let oldest: string | null = null;
  const before = outcomes.length;
  const ok = await readListing(
    ctx,
    WORKSPACE_USAGE_READ,
    base,
    outcomes,
    (body) => {
      const items = atPath(body, "items");
      if (items !== undefined && !Array.isArray(items)) throw new ReadFailure("error", "the activity listing has no item list");
      for (const item of (items as unknown[] | undefined) ?? []) {
        if (events >= WIDER_MAX_ITEMS * 10) return ITEM_CAP;
        const at = isoInstant(atPath(item, "id.time"));
        const evs = atPath(item, "events");
        if (!at || !Array.isArray(evs)) continue;
        events += 1;
        if (oldest === null || at < oldest) oldest = at;
        for (const ev of evs) {
          if (atPath(ev, "name") !== "activity") continue;
          const clientId = eventParam(ev, "client_id").value;
          if (!clientId || !GOOGLE_CLIENT_ID.test(clientId) || (keep && !keep.has(clientId.toLowerCase()))) continue;
          const cls = classifyGoogleApiMethod(eventParam(ev, "method_name").value ?? "");
          let u = perApp.get(clientId);
          if (!u) {
            if (perApp.size >= SAAS_ENTITLEMENT_LIMITS.apps) continue;
            u = { externalId: clientId, lastUseAt: at, lastReadAt: null, lastWriteAt: null };
            perApp.set(clientId, u);
          }
          if (at > u.lastUseAt) u.lastUseAt = at;
          if (cls === "read" && (u.lastReadAt === null || at > u.lastReadAt)) u.lastReadAt = at;
          if (cls === "write" && (u.lastWriteAt === null || at > u.lastWriteAt)) u.lastWriteAt = at;
        }
      }
      const token = str(atPath(body, "nextPageToken"), 2048);
      return token ? `${base}&pageToken=${encodeURIComponent(token)}` : null;
    },
    get,
  );
  const outcome = outcomes[before];
  if (!ok || !outcome) {
    return { coverage: "none", windowStart: null, note: "Google token activity events could not be read, so use is not observed", apps: [] };
  }
  if (events === 0) {
    return {
      coverage: "none",
      windowStart: null,
      note: "no Google token activity event was recorded in the window; Google records them only on Enterprise and Education Standard or Plus and Cloud Identity Premium, so use is not observed",
      apps: [],
    };
  }
  const cut = cutShort(outcome);
  return {
    coverage: "verb",
    windowStart: cut && oldest ? oldest : new Date(Date.parse(start)).toISOString(),
    note: cut
      ? "Google token activity events, newest first, cut short at the item bound: use is observed from the oldest event read"
      : "Google token activity events: each app's latest read and write, by API method name",
    apps: [...perApp.values()],
  };
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
    usage: { coverage: "none", windowStart: null, note: USAGE_NOT_OBSERVED.directory, apps: [] },
  };
  return { ...result, entitlements };
}

// ---------------------------------------------------------------------------
// entitlement_salesforce
// ---------------------------------------------------------------------------

export const SALESFORCE_API_VERSION = "v62.0";
const SF_ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const SF_ORG_ID = /^00D[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;
const SF_APP_ID = /^0H4[a-zA-Z0-9]{12}(?:[a-zA-Z0-9]{3})?$/;
/** a permission set or profile API name (letters, digits, underscores), bounded */
const SF_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
/**
 * The system permissions that can change the org (data, setup, users, code or metadata). A run-as user holding any of
 * them is refused before anything is read (ADR-0195 decision 7): the reader needs only View Setup and Configuration.
 */
export const SALESFORCE_WRITE_PERMISSIONS = Object.freeze(["PermissionsModifyAllData", "PermissionsCustomizeApplication", "PermissionsManageUsers", "PermissionsAuthorApex", "PermissionsModifyMetadata"]);

/** the 15-character form of a Salesforce id (ids are case-sensitive; 18-character ids add a case-safe suffix) */
const sf15 = (id: string) => id.slice(0, 15);

function salesforceLogin(raw: string | undefined): { origin: string; audience: string } | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  const h = u.hostname.toLowerCase();
  if (h === "login.salesforce.com") return { origin: u.origin, audience: "https://login.salesforce.com" };
  if (h === "test.salesforce.com") return { origin: u.origin, audience: "https://test.salesforce.com" };
  if (/^[a-z0-9-]{1,80}(?:\.sandbox)?\.my\.salesforce\.com$/.test(h)) return { origin: u.origin, audience: h.includes(".sandbox.") ? "https://test.salesforce.com" : "https://login.salesforce.com" };
  return null;
}

function salesforceTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  if (!salesforceLogin(target.loginUrl)) return "'loginUrl' must be https://login.salesforce.com, https://test.salesforce.com or your https://<domain>.my.salesforce.com (no path or query)";
  if (!target.orgId || !SF_ORG_ID.test(target.orgId)) return "'orgId' must be the org's id (00D…)";
  if (!scope.orgLevel && scope.include.some((x) => !SF_APP_ID.test(x.trim()))) return "the scope names connected app ids (0H4…)";
  return null;
}

/** the instance the token response names, kept only when it is an https Salesforce host */
function salesforceInstance(raw: unknown): string | null {
  const s = str(raw, 256);
  if (!s) return null;
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    return u.protocol === "https:" && !u.username && !u.password && /^[a-z0-9.-]{1,200}\.(?:my\.)?salesforce\.com$/.test(h) ? u.origin : null;
  } catch {
    return null;
  }
}

async function runSalesforceEntitlements(ctx: ScanContext): Promise<ScanResult> {
  const t = ctx.source.target;
  const problem = salesforceTargetProblem(t, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`entitlement_salesforce: ${problem}`);
  const login = salesforceLogin(t.loginUrl)!;
  const c = ctx.credential;
  if (!c || c.mode !== "static" || !c.secret) throw new WiderSourceConfigError("entitlement_salesforce: a static credential holding the connected app's private key is required");
  const { clientId, username } = c.publicConfig;
  if (!clientId || !username) throw new WiderSourceConfigError("entitlement_salesforce: the credential names clientId (the consumer key) and username (the read-only integration user)");

  // 1. the OAuth 2.0 JWT bearer flow: a short assertion signed with the connected app's key (jose, RS256)
  let assertion: string;
  try {
    const key = await importPKCS8(c.secret, "RS256");
    assertion = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(clientId).setSubject(username).setAudience(login.audience).setExpirationTime("3m").sign(key);
  } catch {
    throw new WiderSourceConfigError("entitlement_salesforce: the private key is not a PKCS#8 RSA key (BEGIN PRIVATE KEY)");
  }
  ctx.registerSecret(assertion);
  const credentialFetch = scannerFetch(ctx, { digest: false });
  let tokenBody: unknown;
  try {
    const res = await credentialFetch(`${login.origin}/services/oauth2/token`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
      redirect: "manual",
      signal: ctx.signal,
    });
    tokenBody = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBodyCapped(res.body, 64 * 1024)));
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new WiderSourceConfigError("entitlement_salesforce: the token request did not complete (is the login host on the egress allow list?)");
  }
  const accessToken = str(atPath(tokenBody, "access_token"), 4096);
  if (!accessToken) {
    // only Salesforce's OAuth error code is kept, never the description
    const code = (str(atPath(tokenBody, "error"), 64) ?? "no_token").replace(/[^a-z_]/g, "");
    throw new WiderSourceConfigError(`entitlement_salesforce: the token request failed (${code}); check the connected app's pre-authorisation of the integration user and its certificate`);
  }
  ctx.registerSecret(accessToken);
  const instance = salesforceInstance(atPath(tokenBody, "instance_url"));
  if (!instance) throw new WiderSourceConfigError("entitlement_salesforce: the token response named no Salesforce instance");
  // the identity URL ends /id/<org id>/<user id>; the org must be the source's org
  const idParts = (str(atPath(tokenBody, "id"), 512) ?? "").split("/");
  const orgId = idParts.at(-2) ?? "";
  const userId = idParts.at(-1) ?? "";
  if (!SF_ORG_ID.test(orgId) || !SF_ID.test(userId)) throw new WiderSourceConfigError("entitlement_salesforce: the token response named no valid identity");
  if (sf15(orgId) !== sf15(t.orgId!)) throw new WiderSourceConfigError("entitlement_salesforce: the token belongs to another org than the source's target");

  const fetchImpl = scannerFetch(ctx);
  const headers = { authorization: `Bearer ${accessToken}` };
  const get = (url: string) => getJson(fetchImpl, url, headers, ctx.signal);
  const soql = (q: string) => `${instance}/services/data/${SALESFORCE_API_VERSION}/query?q=${encodeURIComponent(q)}`;
  const nextRecords = (body: unknown) => {
    const next = str(atPath(body, "nextRecordsUrl"), 512);
    return next && next.startsWith(`/services/data/${SALESFORCE_API_VERSION}/query/`) ? sameOriginNext(instance, `${instance}${next}`) : null;
  };
  const records = (body: unknown, what: string): unknown[] => {
    const r = atPath(body, "records");
    if (!Array.isArray(r)) throw new ReadFailure("error", `the ${what} query has no record list`);
    return r;
  };

  // 2. decision 7: the run-as user's system permissions (its profile's permission set included) must be read-only
  const outcomes: DiscoveryReadOutcome[] = [];
  const held = new Set<string>();
  const permsRead = await readListing(
    ctx,
    "Salesforce run-as user permissions",
    soql(`SELECT ${SALESFORCE_WRITE_PERMISSIONS.join(", ")} FROM PermissionSet WHERE Id IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}')`),
    outcomes,
    (body) => {
      for (const r of records(body, "permission")) for (const p of SALESFORCE_WRITE_PERMISSIONS) if (atPath(r, p) === true) held.add(p);
      return nextRecords(body);
    },
    get,
  );
  if (!permsRead) return finish([], outcomes, "unverified");
  if (held.size > 0) {
    return { observations: [], credentialWriteScope: "write", readOutcomes: [{ read: "credential write scope", status: "denied", detail: `the integration user holds permissions that can change the org: ${[...held].join(", ")}` }] };
  }

  // 3. the connected apps, and whether any user may authorise each one themselves
  const keep = includeSet(ctx);
  const drafts = new Map<string, AppDraft>();
  let truncated = false;
  await readListing(
    ctx,
    "Salesforce connected apps",
    soql("SELECT Id, Name, OptionsAllowAdminApprovedUsersOnly FROM ConnectedApplication"),
    outcomes,
    (body) => {
      for (const r of records(body, "connected app")) {
        const id = str(atPath(r, "Id"), 18);
        if (!id || !SF_APP_ID.test(id)) continue;
        if (keep && !keep.has(id.toLowerCase()) && !keep.has(sf15(id).toLowerCase())) continue;
        if (drafts.size >= SAAS_ENTITLEMENT_LIMITS.apps) {
          truncated = true;
          return ITEM_CAP;
        }
        const d: AppDraft = { app: { externalId: sf15(id), appKind: "connected_app", displayName: label(atPath(r, "Name"), SAAS_ENTITLEMENT_LIMITS.displayName), publisher: null, publisherVerified: null }, grants: new Map() };
        // "All users may self-authorize": anyone in the org can grant this app access to their data
        if (atPath(r, "OptionsAllowAdminApprovedUsersOnly") === false) addGrant(d, { resource: "", scope: "connected_app:self_authorize", grantType: "delegated", consent: "tenant" }, null);
        drafts.set(sf15(id), d);
      }
      return nextRecords(body);
    },
    get,
  );

  // 4. the profiles and permission sets an admin pre-authorised for each app
  await readListing(
    ctx,
    "Salesforce connected app pre-authorisations",
    soql("SELECT SetupEntityId, Parent.Name, Parent.IsOwnedByProfile, Parent.Profile.Name FROM SetupEntityAccess WHERE SetupEntityType = 'ConnectedApplication'"),
    outcomes,
    (body) => {
      for (const r of records(body, "pre-authorisation")) {
        const appId = str(atPath(r, "SetupEntityId"), 18);
        const d = appId ? drafts.get(sf15(appId)) : undefined;
        if (!d) continue;
        const byProfile = atPath(r, "Parent.IsOwnedByProfile") === true;
        const name = str(byProfile ? atPath(r, "Parent.Profile.Name") : atPath(r, "Parent.Name"), 80);
        const resource = byProfile ? `profile:${(name ?? "").replace(/[^A-Za-z0-9_ ]/g, "").trim().replace(/ +/g, "_")}` : `permission_set:${name ?? ""}`;
        if (!name || !SF_NAME.test(resource.split(":")[1]!)) continue;
        if (!addGrant(d, { resource, scope: "connected_app:preauthorized", grantType: "delegated", consent: "tenant" }, null)) truncated = true;
      }
      return nextRecords(body);
    },
    get,
  );
  if (truncated) outcomes.push({ read: "entitlement batch size", status: "skipped", detail: "a per-app or per-grant bound was reached: the rest was not kept" });
  // completeness is judged on the listings the graph depends on, before the by-design note below is added
  const complete = !truncated && !outcomes.some(cutShort);
  outcomes.push({ read: "Salesforce OAuth scopes and per-user tokens", status: "skipped", detail: "OAuth scopes are only in the Metadata API and org-wide tokens need Customize Application; both can change the org, so neither is read (ADR-0337 owner question)" });
  // system permissions were checked; object-level edit rights of the user cannot all be judged, so unverified
  const result = finish([], outcomes, "unverified");
  const entitlements: SaasEntitlementBatch = {
    platform: "salesforce",
    tenant: sf15(orgId),
    complete,
    apps: [...drafts.values()].filter((d) => d.grants.size > 0).map((d) => ({ ...d.app, grants: [...d.grants.values()] })),
    usage: { coverage: "none", windowStart: null, note: USAGE_NOT_OBSERVED.salesforce, apps: [] },
  };
  return { ...result, entitlements };
}

// ---------------------------------------------------------------------------
// entitlement_slack
// ---------------------------------------------------------------------------

const SLACK_ORIGIN = "https://slack.com";
const SLACK_ENTERPRISE_ID = /^E[A-Z0-9]{6,20}$/;
const SLACK_TEAM_ID = /^T[A-Z0-9]{6,20}$/;
const SLACK_APP_ID = /^A[A-Z0-9]{6,20}$/;
/** a Slack scope name as the admin API returns it (bounded, linear) */
const SLACK_SCOPE = /^[a-z][a-z0-9_.]{0,63}(?::[a-z][a-z0-9_.]{0,63})?$/;

function slackTargetProblem(target: Readonly<Record<string, string>>, scope: Readonly<{ orgLevel: boolean; include: readonly string[] }>): string | null {
  const e = target.enterpriseId;
  const t = target.teamId;
  if ((e === undefined) === (t === undefined)) return "name exactly one of 'enterpriseId' (an Enterprise Grid org, E…) or 'teamId' (a workspace, T…)";
  if (e !== undefined && !SLACK_ENTERPRISE_ID.test(e)) return "'enterpriseId' must be a Slack enterprise id (E…)";
  if (t !== undefined && !SLACK_TEAM_ID.test(t)) return "'teamId' must be a Slack team id (T…)";
  if (!scope.orgLevel && scope.include.some((x) => !SLACK_APP_ID.test(x.trim().toUpperCase()))) return "the scope names Slack app ids (A…)";
  return null;
}

/**
 * The scopes a Slack token holds, from the `x-oauth-scopes` header Slack sends on every Web API response. Read-only
 * when every scope is a `:read` scope (`admin.apps:read` is the one the reader needs); `write` otherwise; `unverified`
 * when Slack sent no header.
 */
export function slackWriteScope(header: string | null): { scope: "read_only" | "write" | "unverified"; scopes: string[] } {
  if (!header) return { scope: "unverified", scopes: [] };
  const scopes = header.split(",").map((x) => x.trim()).filter((x) => x.length > 0).slice(0, 100);
  if (scopes.length === 0) return { scope: "unverified", scopes };
  return { scope: scopes.every((x) => /^[a-z][a-z0-9_.]*:read$/.test(x)) ? "read_only" : "write", scopes };
}

/** Slack answers HTTP 200 with `ok: false` for refusals; turn those into read failures */
function slackOk(body: unknown, what: string): void {
  if (atPath(body, "ok") === true) return;
  const err = str(atPath(body, "error"), 64) ?? "unknown_error";
  const denied = ["missing_scope", "not_allowed_token_type", "invalid_auth", "not_authed", "token_revoked", "account_inactive", "feature_not_enabled", "not_an_admin", "ekm_access_denied"];
  throw new ReadFailure(denied.includes(err) ? "denied" : "error", `${what}: Slack refused (${err.replace(/[^a-z_]/g, "")})`);
}

async function runSlackEntitlements(ctx: ScanContext): Promise<ScanResult> {
  const t = ctx.source.target;
  const problem = slackTargetProblem(t, ctx.source.scope);
  if (problem) throw new WiderSourceConfigError(`entitlement_slack: ${problem}`);
  const c = ctx.credential;
  if (!c || c.mode !== "static" || !c.secret) throw new WiderSourceConfigError("entitlement_slack: a static credential holding an org-level token with admin.apps:read is required");
  ctx.registerSecret(c.secret);
  const fetchImpl = scannerFetch(ctx);
  const headers = { authorization: `Bearer ${c.secret}` };

  // 1. who the token is, and which scopes it holds (decision 7), before anything is read
  let res: Response;
  try {
    res = await fetchImpl(`${SLACK_ORIGIN}/api/auth.test`, { method: "GET", headers: { accept: "application/json", ...headers }, redirect: "manual", signal: ctx.signal });
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new WiderSourceConfigError("entitlement_slack: Slack could not be reached (is slack.com on the egress allow list?)");
  }
  let auth: unknown;
  try {
    auth = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBodyCapped(res.body, WIDER_MAX_BODY_BYTES)));
  } catch (err) {
    if (err instanceof BodyTooLargeError || !ctx.signal.aborted) throw new WiderSourceConfigError("entitlement_slack: the token check did not answer JSON");
    throw err;
  }
  if (atPath(auth, "ok") !== true) throw new WiderSourceConfigError(`entitlement_slack: the token check failed (${(str(atPath(auth, "error"), 64) ?? "unknown_error").replace(/[^a-z_]/g, "")})`);
  const write = slackWriteScope(res.headers.get("x-oauth-scopes"));
  if (write.scope === "write") {
    return { observations: [], credentialWriteScope: "write", readOutcomes: [{ read: "credential write scope", status: "denied", detail: `the token holds more than read scopes: ${write.scopes.join(", ").slice(0, 300)}` }] };
  }
  const tokenOrg = t.enterpriseId ? str(atPath(auth, "enterprise_id"), 32) : str(atPath(auth, "team_id"), 32);
  if (tokenOrg !== (t.enterpriseId ?? t.teamId)) throw new WiderSourceConfigError("entitlement_slack: the token belongs to another Slack org or workspace than the source's target");

  // 2. the apps approved for the org or workspace, with the scopes each holds
  const outcomes: DiscoveryReadOutcome[] = [];
  const keep = includeSet(ctx);
  const drafts = new Map<string, AppDraft>();
  let truncated = false;
  const where = t.enterpriseId ? `enterprise_id=${encodeURIComponent(t.enterpriseId)}` : `team_id=${encodeURIComponent(t.teamId!)}`;
  const base = `${SLACK_ORIGIN}/api/admin.apps.approved.list?limit=1000&${where}`;
  await readListing(
    ctx,
    "Slack approved apps",
    base,
    outcomes,
    (body) => {
      slackOk(body, "approved apps");
      const list = atPath(body, "approved_apps");
      if (!Array.isArray(list)) throw new ReadFailure("error", "the approved app listing has no list");
      for (const entry of list) {
        const appId = str(atPath(entry, "app.id"), 32)?.toUpperCase();
        if (!appId || !SLACK_APP_ID.test(appId)) continue;
        if (keep && !keep.has(appId.toLowerCase())) continue;
        let d = drafts.get(appId);
        if (!d) {
          if (drafts.size >= SAAS_ENTITLEMENT_LIMITS.apps) {
            truncated = true;
            return ITEM_CAP;
          }
          const directory = atPath(entry, "app.is_app_directory_approved");
          d = {
            app: { externalId: appId, appKind: "slack_app", displayName: label(atPath(entry, "app.name"), SAAS_ENTITLEMENT_LIMITS.displayName), publisher: null, publisherVerified: typeof directory === "boolean" ? directory : null },
            grants: new Map(),
          };
          drafts.set(appId, d);
        }
        const scopes = atPath(entry, "scopes");
        for (const sc of Array.isArray(scopes) ? scopes : []) {
          const name = str(atPath(sc, "name"), 128);
          if (!name || !SLACK_SCOPE.test(name)) continue;
          // a user scope acts for each user who installs the app; a bot or app scope acts as the app itself
          const user = atPath(sc, "token_type") === "user";
          if (!addGrant(d, { resource: "", scope: name, grantType: user ? "delegated" : "application", consent: "tenant" }, null)) truncated = true;
        }
      }
      const cursor = str(atPath(body, "response_metadata.next_cursor"), 2048);
      return cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : null;
    },
    (url) => getJson(fetchImpl, url, headers, ctx.signal),
  );
  if (truncated) outcomes.push({ read: "entitlement batch size", status: "skipped", detail: "a per-app or per-grant bound was reached: the rest was not kept" });
  const complete = !truncated && !outcomes.some(cutShort);
  const result = finish([], outcomes, write.scope);
  const entitlements: SaasEntitlementBatch = {
    platform: "slack",
    tenant: (t.enterpriseId ?? t.teamId)!,
    complete,
    apps: [...drafts.values()].filter((d) => d.grants.size > 0).map((d) => ({ ...d.app, grants: [...d.grants.values()] })),
    usage: { coverage: "none", windowStart: null, note: USAGE_NOT_OBSERVED.slack, apps: [] },
  };
  return { ...result, entitlements };
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export const SAAS_ENTITLEMENT_SCANNERS: readonly Scanner[] = Object.freeze([
  { kind: "entitlement_m365", requiresCredential: true, run: runM365Entitlements, validateTarget: (t, s) => m365TargetProblem(t, s) },
  { kind: "entitlement_google_workspace", requiresCredential: true, run: runWorkspaceEntitlements, validateTarget: (t, s) => workspaceTargetProblem(t, s) },
  { kind: "entitlement_salesforce", requiresCredential: true, run: runSalesforceEntitlements, validateTarget: (t, s) => salesforceTargetProblem(t, s) },
  { kind: "entitlement_slack", requiresCredential: true, run: runSlackEntitlements, validateTarget: (t, s) => slackTargetProblem(t, s) },
]);
