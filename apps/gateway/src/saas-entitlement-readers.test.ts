/**
 * ADR-0337 (E18 slice 1): the Microsoft 365 and Google Workspace entitlement readers against ADR-0195 SD0's Scanner
 * contract, without a database. Fixture vendors stand behind `ctx.fetch` (no live tenant). The tests check that:
 *
 *  - M365 joins delegated grants and application permissions to their apps and resources, resolves role ids to
 *    permission names, leaves Microsoft first-party apps out, pseudonymises consenting users as `idp_user`, keeps a
 *    tenant consent nameless, and returns a batch the worker's own check accepts; a read that is cut short is PARTIAL;
 *    a write-capable token is refused before any Graph read (decision 7);
 *  - Google asks for ONLY the read-only Reports scope, takes the latest event per user and app (a later revoke cancels
 *    an earlier authorize), returns revocations explicitly and is always PARTIAL, and keeps the token out of every
 *    digest;
 *  - a reader never writes: every Graph and Reports call is a GET.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GOOGLE_WORKSPACE_DIRECTORY_USER_READONLY_SCOPE,
  GOOGLE_WORKSPACE_DIRECTORY_USER_SECURITY_SCOPE,
  GOOGLE_WORKSPACE_REPORTS_READONLY_SCOPE,
} from "@regulait/cloud-discovery";
import { checkSaasEntitlementBatch, type SaasEntitlementBatch } from "@regulait/shared";
import { DISCOVERY_SCANNERS, type ScanContext } from "./discovery-scanners.js";
import { M365_PERMISSION_RESOURCES, SAAS_ENTITLEMENT_SCANNERS, readOnlyFetch, slackWriteScope } from "./saas-entitlement-readers.js";
import { SALESFORCE_PERMISSIONS_QUERY, WRITE_SYSTEM_PERMISSIONS } from "./salesforce-org.js";

const TENANT = "00000000-0000-4000-8000-000000000e18";
const CLIENT = "00000000-0000-4000-8000-000000000e19";
const AGENT_APP = "00000000-0000-4000-8000-0000000000b1";
const WIKI_APP = "00000000-0000-4000-8000-0000000000b2";
const MS_APP = "00000000-0000-4000-8000-0000000000b3";
const GRAPH_APP = M365_PERMISSION_RESOURCES[0]!.appId;
const MAIL_ROLE = "00000000-0000-4000-8000-00000000a001";
const FILES_ROLE = "00000000-0000-4000-8000-00000000a002";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const scanner = (kind: string) => SAAS_ENTITLEMENT_SCANNERS.find((s) => s.kind === kind)!;
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

function ctxFor(over: Partial<ScanContext> & Pick<ScanContext, "fetch" | "source" | "credential">) {
  const calls = { throttle: 0, raw: [] as string[], pseudonymise: [] as string[], secrets: [] as string[], methods: [] as Array<[string, string]> };
  const inner = over.fetch;
  const ctx: ScanContext = {
    throttle: async () => {
      calls.throttle += 1;
    },
    backoff: async () => false,
    recordRaw: (chunk) => {
      calls.raw.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    },
    registerSecret: (v) => {
      calls.secrets.push(v);
    },
    pseudonymise: async (kind, name) => {
      calls.pseudonymise.push(kind);
      return `psn:${Buffer.from(name).toString("hex").slice(0, 24).padEnd(24, "0")}`;
    },
    heartbeat: async () => true,
    signal: new AbortController().signal,
    catalogue: { matches: () => true, rows: () => [] },
    ...over,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const u = urlOf(input);
      calls.methods.push([u.hostname, (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()]);
      return inner(input, init);
    }) as typeof fetch,
  };
  return { ctx, calls };
}

describe("ADR-0337 registration", () => {
  it("registers all four readers in the production registry", () => {
    for (const k of ["entitlement_m365", "entitlement_google_workspace", "entitlement_salesforce", "entitlement_slack"] as const) expect(DISCOVERY_SCANNERS.has(k)).toBe(true);
  });

  it("refuses a malformed target before anything runs", () => {
    expect(scanner("entitlement_m365").validateTarget!({ tenantId: "nope" }, { orgLevel: true, include: [] })).toMatch(/tenantId/);
    expect(scanner("entitlement_m365").validateTarget!({ tenantId: TENANT }, { orgLevel: false, include: ["x"] })).toMatch(/GUID/);
    expect(scanner("entitlement_google_workspace").validateTarget!({ lookbackDays: "400" }, { orgLevel: true, include: [] })).toMatch(/180/);
    expect(scanner("entitlement_google_workspace").validateTarget!({ customerId: "evil&x=1" }, { orgLevel: true, include: [] })).toMatch(/customerId/);
    expect(scanner("entitlement_google_workspace").validateTarget!({ customerId: "C01abcd23", lookbackDays: "30" }, { orgLevel: true, include: [] })).toBeNull();
  });
});

describe("ADR-0337 entitlement_m365", () => {
  const source = { id: "s-m365", name: "m365", kind: "entitlement_m365" as const, target: { tenantId: TENANT }, scope: { orgLevel: true, include: [] as string[] } };
  const credential = { mode: "static" as const, publicConfig: { tenantId: TENANT, clientId: CLIENT }, secret: `cs-${randomBytes(12).toString("hex")}` };

  function fakeM365(roles: string[], over?: (url: URL) => Response | null) {
    const accessToken = jwt({ roles, tid: TENANT });
    const f = (async (input: string | URL | Request) => {
      const url = urlOf(input);
      if (url.hostname === "login.microsoftonline.com") {
        if (url.pathname.endsWith("/discovery/instance")) {
          return json({
            tenant_discovery_endpoint: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
            "api-version": "1.1",
            metadata: [{ preferred_network: "login.microsoftonline.com", preferred_cache: "login.windows.net", aliases: ["login.microsoftonline.com", "login.windows.net"] }],
          });
        }
        if (url.pathname.endsWith("/.well-known/openid-configuration")) {
          return json({
            token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
            authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
            issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
            end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
            jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
          });
        }
        if (url.pathname.endsWith("/oauth2/v2.0/token")) return json({ token_type: "Bearer", expires_in: 3600, ext_expires_in: 3600, access_token: accessToken });
      }
      const o = over?.(url);
      if (o) return o;
      if (url.hostname !== "graph.microsoft.com") return json({}, 404);
      const p = decodeURIComponent(url.pathname);
      if (p === "/v1.0/servicePrincipals") {
        return json({
          value: [
            { id: "sp-agent", appId: AGENT_APP, displayName: "Sales agent", appOwnerOrganizationId: "00000000-0000-4000-8000-00000000ffff", verifiedPublisher: { displayName: null } },
            { id: "sp-wiki", appId: WIKI_APP, displayName: "Wiki\n\u0000", publisherName: "Wiki Co", verifiedPublisher: { displayName: "Wiki Co Ltd" } },
            { id: "sp-ms", appId: MS_APP, displayName: "Microsoft Teams", appOwnerOrganizationId: "f8cdef31-a31e-4b4a-93e4-5f571e91255a" },
            { id: "sp-graph", appId: GRAPH_APP, displayName: "Microsoft Graph", appOwnerOrganizationId: "f8cdef31-a31e-4b4a-93e4-5f571e91255a" },
          ],
        });
      }
      if (p === "/v1.0/oauth2PermissionGrants") {
        return json({
          value: [
            { clientId: "sp-agent", resourceId: "sp-graph", consentType: "Principal", principalId: "uo1", scope: " openid Mail.Read Mail.Send " },
            { clientId: "sp-agent", resourceId: "sp-graph", consentType: "Principal", principalId: "uo2", scope: "Mail.Read" },
            { clientId: "sp-wiki", resourceId: "sp-graph", consentType: "AllPrincipals", principalId: null, scope: "User.Read" },
            { clientId: "sp-ms", resourceId: "sp-graph", consentType: "AllPrincipals", principalId: null, scope: "Directory.ReadWrite.All" },
          ],
        });
      }
      if (p === `/v1.0/servicePrincipals(appId='${GRAPH_APP}')`) {
        return json({ id: "sp-graph", appRoles: [{ id: MAIL_ROLE, value: "Mail.ReadWrite" }, { id: FILES_ROLE, value: "Files.Read.All" }] });
      }
      if (p === "/v1.0/servicePrincipals/sp-graph/appRoleAssignedTo") {
        return json({
          value: [
            { principalType: "ServicePrincipal", principalId: "sp-agent", appRoleId: MAIL_ROLE },
            { principalType: "ServicePrincipal", principalId: "sp-agent", appRoleId: FILES_ROLE },
            { principalType: "ServicePrincipal", principalId: "sp-ms", appRoleId: MAIL_ROLE },
            { principalType: "Group", principalId: "g-1", appRoleId: MAIL_ROLE },
          ],
        });
      }
      // Exchange and SharePoint are not provisioned in this tenant (HTTP 404): no assignments, the read stays complete
      return json({ error: { code: "Request_ResourceNotFound" } }, 404);
    }) as typeof fetch;
    return { f, accessToken };
  }

  it("builds the graph: delegated and application grants, users pseudonymised, first-party left out, complete", async () => {
    const v = fakeM365(["Application.Read.All", "DelegatedPermissionGrant.Read.All", "AppRoleAssignment.Read.All"]);
    const { ctx, calls } = ctxFor({ fetch: v.f, source, credential });
    const res = await scanner("entitlement_m365").run(ctx);
    expect(res.observations).toEqual([]);
    expect(res.credentialWriteScope).toBe("read_only");
    const batch = checkSaasEntitlementBatch(res.entitlements, "m365");
    expect(batch.complete).toBe(true);
    expect(batch.tenant).toBe(TENANT);
    expect(batch.apps.map((a) => a.externalId).sort()).toEqual([AGENT_APP, WIKI_APP].sort());
    const agent = batch.apps.find((a) => a.externalId === AGENT_APP)!;
    const p1 = `psn:${Buffer.from("uo1").toString("hex").slice(0, 24).padEnd(24, "0")}`;
    const grants = agent.grants.map((g) => ({ ...g, principals: g.principals.length })).sort((a, b) => `${a.grantType}${a.scope}`.localeCompare(`${b.grantType}${b.scope}`));
    expect(grants).toEqual([
      { resource: GRAPH_APP, scope: "Files.Read.All", grantType: "application", consent: "tenant", principals: 0 },
      { resource: GRAPH_APP, scope: "Mail.ReadWrite", grantType: "application", consent: "tenant", principals: 0 },
      { resource: GRAPH_APP, scope: "Mail.Read", grantType: "delegated", consent: "user", principals: 2 },
      { resource: GRAPH_APP, scope: "Mail.Send", grantType: "delegated", consent: "user", principals: 1 },
      { resource: GRAPH_APP, scope: "openid", grantType: "delegated", consent: "user", principals: 1 },
    ]);
    expect(agent.grants.find((g) => g.scope === "Mail.Send")!.principals).toEqual([p1]);
    // a control character in a vendor-chosen name is neutralised, so it cannot get the whole batch refused
    expect(batch.apps.find((a) => a.externalId === WIKI_APP)).toMatchObject({ displayName: "Wiki", publisher: "Wiki Co Ltd", publisherVerified: true, grants: [{ scope: "User.Read", consent: "tenant", principals: [] }] });
    expect(agent.publisherVerified).toBe(false);
    // users are pseudonymised (one call per consent), never carried raw; the token is registered, never digested
    expect(new Set(calls.pseudonymise)).toEqual(new Set(["idp_user"]));
    expect(JSON.stringify(res)).not.toContain("uo1");
    expect(JSON.stringify(res)).not.toContain(credential.secret);
    expect(calls.secrets).toContain(v.accessToken);
    expect(calls.raw.join("")).not.toContain(v.accessToken);
    // every read of the tenant is a GET (the token request is the only POST, to the identity service)
    expect(calls.methods.filter(([host]) => host === "graph.microsoft.com").every(([, m]) => m === "GET")).toBe(true);
    expect(calls.throttle).toBeGreaterThan(0);
  });

  it("a listing that is denied makes the batch partial (nothing unseen may then be removed)", async () => {
    const v = fakeM365(["Application.Read.All"], (url) => (url.pathname === "/v1.0/oauth2PermissionGrants" ? json({ error: {} }, 403) : null));
    const { ctx } = ctxFor({ fetch: v.f, source, credential });
    const res = await scanner("entitlement_m365").run(ctx);
    const batch = res.entitlements as SaasEntitlementBatch;
    expect(batch.complete).toBe(false);
    expect(res.readOutcomes!.find((o) => o.read === "Microsoft Graph delegated permission grants")!.status).toBe("denied");
    // the application permissions were still read
    expect(batch.apps.find((a) => a.externalId === AGENT_APP)!.grants.map((g) => g.scope).sort()).toEqual(["Files.Read.All", "Mail.ReadWrite"]);
  });

  it("the include list keeps only the named client applications", async () => {
    const v = fakeM365(["Application.Read.All"]);
    const { ctx } = ctxFor({ fetch: v.f, source: { ...source, scope: { orgLevel: false, include: [WIKI_APP.toUpperCase()] } }, credential });
    const res = await scanner("entitlement_m365").run(ctx);
    expect((res.entitlements as SaasEntitlementBatch).apps.map((a) => a.externalId)).toEqual([WIKI_APP]);
  });

  it("a write-capable token is refused before any Graph read (decision 7)", async () => {
    const v = fakeM365(["Application.ReadWrite.All"]);
    const { ctx, calls } = ctxFor({ fetch: v.f, source, credential });
    const res = await scanner("entitlement_m365").run(ctx);
    expect(res.credentialWriteScope).toBe("write");
    expect(res.entitlements).toBeUndefined();
    expect(calls.methods.some(([host]) => host === "graph.microsoft.com")).toBe(false);
  });
});

describe("ADR-0337 entitlement_google_workspace", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyJson = JSON.stringify({ type: "service_account", client_email: "reader@acme-proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });
  const credential = { mode: "static" as const, publicConfig: { adminSubject: "admin@acme.example" }, secret: keyJson };
  const source = { id: "s-gws", name: "gws", kind: "entitlement_google_workspace" as const, target: { lookbackDays: "90" }, scope: { orgLevel: true, include: [] as string[] } };
  const NOTETAKER = "1234567890-notetaker.apps.googleusercontent.com";
  const MAILER = "555-mailer.apps.googleusercontent.com";

  const event = (name: string, user: string, at: string, client: string, scopes: string[], app = "AI notetaker") => ({
    id: { time: at, applicationName: "token" },
    actor: { profileId: user, email: `${user}@acme.example` },
    events: [{ type: "auth", name, parameters: [{ name: "client_id", value: client }, { name: "app_name", value: app }, { name: "scope", multiValue: scopes }] }],
  });

  function fakeGoogle() {
    const accessToken = `ya29.${randomBytes(16).toString("hex")}`;
    const assertions: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
        const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : new TextDecoder().decode(init?.body as ArrayBuffer);
        const assertion = new URLSearchParams(body).get("assertion");
        if (assertion) assertions.push(assertion);
        return json({ access_token: accessToken, expires_in: 3600, token_type: "Bearer" });
      }
      if (url.hostname === "admin.googleapis.com" && url.pathname === "/admin/reports/v1/activity/users/all/applications/token") {
        const name = url.searchParams.get("eventName");
        if (name === "authorize") {
          if (!url.searchParams.get("pageToken")) {
            return json({
              items: [
                event("authorize", "u1", "2026-11-01T10:00:00.000Z", NOTETAKER, ["https://www.googleapis.com/auth/drive", "openid"]),
                event("authorize", "u2", "2026-11-02T10:00:00.000Z", NOTETAKER, ["https://www.googleapis.com/auth/drive"]),
              ],
              nextPageToken: "p2",
            });
          }
          return json({ items: [event("authorize", "u3", "2026-11-03T10:00:00.000Z", MAILER, ["https://mail.google.com/"], "Mailer"), event("authorize", "u2", "2026-11-10T10:00:00.000Z", MAILER, ["https://www.googleapis.com/auth/gmail.readonly"], "Mailer")] });
        }
        if (name === "revoke") return json({ items: [event("revoke", "u2", "2026-11-05T10:00:00.000Z", NOTETAKER, [])] });
      }
      return json({}, 404);
    }) as typeof fetch;
    return { f, accessToken, assertions };
  }

  it("reads grants from the Reports API with only the read-only scope; latest event wins; always partial", async () => {
    const g = fakeGoogle();
    const { ctx, calls } = ctxFor({ fetch: g.f, source, credential });
    const res = await scanner("entitlement_google_workspace").run(ctx);
    expect(res.credentialWriteScope).toBe("unverified");
    const batch = checkSaasEntitlementBatch(res.entitlements, "google_workspace");
    expect(batch.complete).toBe(false);
    expect(batch.tenant).toBe("my_customer");
    // the JWT asks for exactly the read-only Reports scope and acts for the configured admin
    expect(g.assertions).toHaveLength(1);
    const claims = JSON.parse(Buffer.from(g.assertions[0]!.split(".")[1]!, "base64url").toString("utf8")) as { scope: string; sub: string };
    expect(claims.scope).toBe(GOOGLE_WORKSPACE_REPORTS_READONLY_SCOPE);
    expect(claims.sub).toBe("admin@acme.example");

    const psn = (u: string) => `psn:${Buffer.from(u).toString("hex").slice(0, 24).padEnd(24, "0")}`;
    const notetaker = batch.apps.find((a) => a.externalId === NOTETAKER)!;
    expect(notetaker).toMatchObject({ appKind: "oauth_client", displayName: "AI notetaker" });
    // u2 revoked the notetaker after authorising it: only u1 holds its grants, and u2's revocation is explicit
    expect(notetaker.grants.map((x) => [x.scope, x.principals]).sort()).toEqual([
      ["https://www.googleapis.com/auth/drive", [psn("u1")]],
      ["openid", [psn("u1")]],
    ]);
    expect(batch.revokedPrincipals).toEqual([{ externalId: NOTETAKER, principal: psn("u2") }]);
    // the second page was followed; u2's later authorize of the mailer counts
    const mailer = batch.apps.find((a) => a.externalId === MAILER)!;
    expect(mailer.grants.map((x) => x.scope).sort()).toEqual(["https://mail.google.com/", "https://www.googleapis.com/auth/gmail.readonly"]);
    // the start time respects the 90-day lookback; every Reports call is a GET; the token is registered, never digested
    expect(calls.methods.filter(([h]) => h === "admin.googleapis.com").every(([, m]) => m === "GET")).toBe(true);
    expect(calls.secrets).toContain(g.accessToken);
    expect(calls.raw.join("")).not.toContain(g.accessToken);
    expect(JSON.stringify(res)).not.toContain("acme.example");
  });

  // ---- the admin opt-in Directory token listing (owner decision 2026-11-17) ----
  const dirSource = { ...source, target: { directoryTokens: "on" } };
  function fakeDirectory(opts: { deny?: string } = {}) {
    const g = fakeGoogle();
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.hostname === "admin.googleapis.com" && url.pathname === "/admin/directory/v1/users") {
        return url.searchParams.get("pageToken") ? json({ users: [{ id: "222" }] }) : json({ users: [{ id: "111" }], nextPageToken: "n2" });
      }
      const m = /^\/admin\/directory\/v1\/users\/([0-9]+)\/tokens$/.exec(url.pathname);
      if (url.hostname === "admin.googleapis.com" && m) {
        if (m[1] === opts.deny) return json({ error: { code: 403 } }, 403);
        if (m[1] === "111") return json({ items: [{ clientId: NOTETAKER, displayText: "AI notetaker", scopes: ["https://www.googleapis.com/auth/drive", "openid"] }] });
        return json({ items: [{ clientId: NOTETAKER, displayText: "AI notetaker", scopes: ["https://www.googleapis.com/auth/drive"] }, { clientId: MAILER, displayText: "Mailer", scopes: ["https://mail.google.com/"] }] });
      }
      return g.f(input, init);
    }) as typeof fetch;
    return { ...g, f };
  }

  it("Directory opt-in: asks for the two Directory scopes, reads every user's tokens and is COMPLETE", async () => {
    const g = fakeDirectory();
    const { ctx, calls } = ctxFor({ fetch: g.f, source: dirSource, credential });
    const res = await scanner("entitlement_google_workspace").run(ctx);
    const batch = checkSaasEntitlementBatch(res.entitlements, "google_workspace");
    expect(batch.complete).toBe(true);
    expect(res.credentialWriteScope).toBe("unverified");
    const claims = JSON.parse(Buffer.from(g.assertions[0]!.split(".")[1]!, "base64url").toString("utf8")) as { scope: string };
    expect(claims.scope.split(" ").sort()).toEqual([GOOGLE_WORKSPACE_DIRECTORY_USER_READONLY_SCOPE, GOOGLE_WORKSPACE_DIRECTORY_USER_SECURITY_SCOPE].sort());
    expect(claims.scope).not.toContain(GOOGLE_WORKSPACE_REPORTS_READONLY_SCOPE);
    const psn = (u: string) => `psn:${Buffer.from(u).toString("hex").slice(0, 24).padEnd(24, "0")}`;
    const notetaker = batch.apps.find((a) => a.externalId === NOTETAKER)!;
    expect(notetaker.grants.map((x) => [x.scope, x.principals]).sort()).toEqual([
      ["https://www.googleapis.com/auth/drive", [psn("111"), psn("222")]],
      ["openid", [psn("111")]],
    ]);
    expect(batch.apps.find((a) => a.externalId === MAILER)!.grants.map((x) => x.scope)).toEqual(["https://mail.google.com/"]);
    expect(calls.pseudonymise.every((k) => k === "idp_user")).toBe(true);
    // the read says the opted-in scope could revoke, and that it only read
    expect((res.readOutcomes ?? []).some((o) => /can also revoke/.test(o.detail ?? ""))).toBe(true);
    expect(calls.raw.join("")).not.toContain(g.accessToken);
  });

  it("Directory opt-in never revokes: every data call is a GET, and no DELETE ever reaches a token endpoint", async () => {
    const g = fakeDirectory();
    const sent: Array<[string, string]> = [];
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push([(init?.method ?? "GET").toUpperCase(), urlOf(input).pathname]);
      return g.f(input, init);
    }) as typeof fetch;
    await scanner("entitlement_google_workspace").run(ctxFor({ fetch: spy, source: dirSource, credential }).ctx);
    const data = sent.filter(([, path]) => path.startsWith("/admin/"));
    expect(data.length).toBeGreaterThan(0);
    expect(data.every(([m]) => m === "GET")).toBe(true);
    expect(sent.some(([m, path]) => m === "DELETE" || /\/tokens\/[^/]+$/.test(path))).toBe(false);
    // the transport itself refuses a revoke before it leaves, whatever the token's scope allows
    const inner: string[] = [];
    const guarded = readOnlyFetch((async (input: string | URL | Request) => {
      inner.push(String(input));
      return json({});
    }) as typeof fetch);
    await expect(guarded("https://admin.googleapis.com/admin/directory/v1/users/111/tokens/" + NOTETAKER, { method: "DELETE" })).rejects.toThrow(/DELETE refused/);
    await expect(guarded(new Request("https://admin.googleapis.com/x", { method: "POST" }))).rejects.toThrow(/POST refused/);
    await expect(guarded("https://admin.googleapis.com/x", { method: "GET" })).resolves.toBeInstanceOf(Response);
    expect(inner).toEqual(["https://admin.googleapis.com/x"]);
  });

  it("Directory opt-in: a user whose tokens cannot be read makes the read PARTIAL (nothing unseen is removed)", async () => {
    const g = fakeDirectory({ deny: "222" });
    const res = await scanner("entitlement_google_workspace").run(ctxFor({ fetch: g.f, source: dirSource, credential }).ctx);
    const batch = checkSaasEntitlementBatch(res.entitlements, "google_workspace");
    expect(batch.complete).toBe(false);
    expect(batch.apps.map((a) => a.externalId)).toEqual([NOTETAKER]);
  });

  it("the Directory switch is 'on' or 'off' only; off (the default) keeps the Reports-only read", async () => {
    expect(scanner("entitlement_google_workspace").validateTarget!({ directoryTokens: "yes" }, { orgLevel: true, include: [] })).toMatch(/directoryTokens/);
    expect(scanner("entitlement_google_workspace").validateTarget!({ directoryTokens: "off" }, { orgLevel: true, include: [] })).toBeNull();
    const g = fakeDirectory();
    await scanner("entitlement_google_workspace").run(ctxFor({ fetch: g.f, source: { ...source, target: { directoryTokens: "off" } }, credential }).ctx);
    const claims = JSON.parse(Buffer.from(g.assertions[0]!.split(".")[1]!, "base64url").toString("utf8")) as { scope: string };
    expect(claims.scope).toBe(GOOGLE_WORKSPACE_REPORTS_READONLY_SCOPE);
  });

  it("refuses without the admin subject or a key", async () => {
    const g = fakeGoogle();
    await expect(scanner("entitlement_google_workspace").run(ctxFor({ fetch: g.f, source, credential: { ...credential, publicConfig: {} } }).ctx)).rejects.toThrow(/adminSubject/);
    await expect(scanner("entitlement_google_workspace").run(ctxFor({ fetch: g.f, source, credential: { ...credential, secret: null } }).ctx)).rejects.toThrow(/static credential/);
  });
});

describe("ADR-0337 entitlement_slack", () => {
  const ORG = "E0ACME123";
  const source = { id: "s-slack", name: "slack", kind: "entitlement_slack" as const, target: { enterpriseId: ORG }, scope: { orgLevel: true, include: [] as string[] } };
  const credential = { mode: "static" as const, publicConfig: {}, secret: `xoxp-${randomBytes(12).toString("hex")}` };

  function fakeSlack(scopesHeader: string, over?: (url: URL) => Response | null) {
    const f = (async (input: string | URL | Request) => {
      const url = urlOf(input);
      const o = over?.(url);
      if (o) return o;
      if (url.pathname === "/api/auth.test") {
        return new Response(JSON.stringify({ ok: true, enterprise_id: ORG, team_id: "T0ACME123", user_id: "U1" }), { status: 200, headers: { "content-type": "application/json", "x-oauth-scopes": scopesHeader } });
      }
      if (url.pathname === "/api/admin.apps.approved.list") {
        if (!url.searchParams.get("cursor")) {
          return json({
            ok: true,
            approved_apps: [
              {
                app: { id: "A0NOTES001", name: "AI notes\u0007", is_app_directory_approved: true },
                scopes: [
                  { name: "channels:history", token_type: "user", is_sensitive: true },
                  { name: "chat:write", token_type: "bot", is_sensitive: false },
                  { name: "bad scope!", token_type: "bot" },
                ],
              },
            ],
            response_metadata: { next_cursor: "c2" },
          });
        }
        return json({ ok: true, approved_apps: [{ app: { id: "A0WIKI0002", name: "Wiki" }, scopes: [{ name: "users:read", token_type: "bot" }] }], response_metadata: { next_cursor: "" } });
      }
      return json({ ok: false, error: "unknown_method" });
    }) as typeof fetch;
    return f;
  }

  it("reads approved apps and their scopes across pages, read-only token verified, complete", async () => {
    const { ctx, calls } = ctxFor({ fetch: fakeSlack("admin.apps:read, users:read"), source, credential });
    const res = await scanner("entitlement_slack").run(ctx);
    expect(res.credentialWriteScope).toBe("read_only");
    const batch = checkSaasEntitlementBatch(res.entitlements, "slack");
    expect(batch).toMatchObject({ tenant: ORG, complete: true });
    const notes = batch.apps.find((a) => a.externalId === "A0NOTES001")!;
    expect(notes).toMatchObject({ appKind: "slack_app", displayName: "AI notes", publisherVerified: true });
    expect(notes.grants.map((g) => [g.scope, g.grantType, g.consent]).sort()).toEqual([
      ["channels:history", "delegated", "tenant"],
      ["chat:write", "application", "tenant"],
    ]);
    expect(batch.apps.find((a) => a.externalId === "A0WIKI0002")!.publisherVerified).toBeNull();
    expect(calls.methods.every(([, m]) => m === "GET")).toBe(true);
    expect(calls.secrets).toContain(credential.secret);
    expect(JSON.stringify(res)).not.toContain(credential.secret);
  });

  it("a token with any non-read scope is refused before the app listing is read (decision 7)", async () => {
    const { ctx, calls } = ctxFor({ fetch: fakeSlack("admin.apps:read,admin.apps:write"), source, credential });
    const res = await scanner("entitlement_slack").run(ctx);
    expect(res.credentialWriteScope).toBe("write");
    expect(res.entitlements).toBeUndefined();
    expect(calls.methods).toHaveLength(1);
  });

  it("a token of another org is refused; a Slack refusal makes the read fail with its reason", async () => {
    await expect(scanner("entitlement_slack").run(ctxFor({ fetch: fakeSlack("admin.apps:read"), source: { ...source, target: { enterpriseId: "E0OTHER99" } }, credential }).ctx)).rejects.toThrow(/another Slack org/);
    const denied = fakeSlack("admin.apps:read", (u) => (u.pathname === "/api/admin.apps.approved.list" ? json({ ok: false, error: "not_an_admin" }) : null));
    await expect(scanner("entitlement_slack").run(ctxFor({ fetch: denied, source, credential }).ctx)).rejects.toThrow(/approved apps denied/);
  });

  it("scope header parsing and target checks", () => {
    expect(slackWriteScope(null).scope).toBe("unverified");
    expect(slackWriteScope("admin.apps:read").scope).toBe("read_only");
    expect(slackWriteScope("admin.apps:read,chat:write").scope).toBe("write");
    expect(slackWriteScope("admin").scope).toBe("write");
    expect(scanner("entitlement_slack").validateTarget!({ enterpriseId: ORG, teamId: "T0ACME123" }, { orgLevel: true, include: [] })).toMatch(/exactly one/);
    expect(scanner("entitlement_slack").validateTarget!({ teamId: "T0ACME123" }, { orgLevel: false, include: ["A0NOTES001"] })).toBeNull();
  });
});

describe("ADR-0337 entitlement_salesforce", () => {
  const ORG = "00D5g000004AbCdEAA";
  const USER = "0055g00000AbCdEAAA";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const credential = { mode: "static" as const, publicConfig: { clientId: "3MVG9consumerKeyForTests_000", username: "integration@acme.example" }, secret: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
  const INSTANCE = "https://acme.my.salesforce.com";
  const source = { id: "s-sf", name: "sf", kind: "entitlement_salesforce" as const, target: { environment: "production", myDomain: INSTANCE, orgId: ORG }, scope: { orgLevel: true, include: [] as string[] } };

  function fakeSalesforce(perms: Record<string, boolean>, over?: (url: URL, q: string) => Response | null, objectWrites: unknown[] = []) {
    const accessToken = `00D!${randomBytes(16).toString("hex")}`;
    const assertions: string[] = [];
    const queries: string[] = [];
    const hosts: string[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = urlOf(input);
      hosts.push(url.host);
      if (url.origin === INSTANCE && url.pathname === "/services/oauth2/token") {
        assertions.push(new URLSearchParams(String(init?.body)).get("assertion") ?? "");
        // a vendor-named instance elsewhere is never used (#890 R4 [2]): every later call goes to the My Domain
        return json({ access_token: accessToken, instance_url: "https://elsewhere.my.salesforce.com", id: `https://login.salesforce.com/id/${ORG}/${USER}`, token_type: "Bearer" });
      }
      if (url.origin === INSTANCE && url.pathname.startsWith("/services/data/v62.0/query")) {
        const q = url.searchParams.get("q") ?? "";
        queries.push(q || url.pathname);
        const o = over?.(url, q);
        if (o) return o;
        if (q === SALESFORCE_PERMISSIONS_QUERY) return json({ done: true, records: [{ ...Object.fromEntries(WRITE_SYSTEM_PERMISSIONS.map((p) => [p, false])), ...perms }] });
        if (q.includes("FROM ObjectPermissions")) return json({ done: true, records: objectWrites });
        if (q.includes("FROM ConnectedApplication")) {
          return json({ done: false, nextRecordsUrl: "/services/data/v62.0/query/01gxx00000000AB-2000", records: [{ Id: "0H4AGENT0000001AAA", Name: "Sales agent", OptionsAllowAdminApprovedUsersOnly: false }] });
        }
        if (url.pathname === "/services/data/v62.0/query/01gxx00000000AB-2000") return json({ done: true, records: [{ Id: "0H4LOCKED000002AAA", Name: "Locked app", OptionsAllowAdminApprovedUsersOnly: true }] });
        if (q.includes("FROM SetupEntityAccess")) {
          return json({
            done: true,
            records: [
              { SetupEntityId: "0H4LOCKED000002AAA", Parent: { Name: "Sales_Agents", IsOwnedByProfile: false } },
              { SetupEntityId: "0H4AGENT0000001AAA", Parent: { Name: "X00e", IsOwnedByProfile: true, Profile: { Name: "System Administrator" } } },
            ],
          });
        }
      }
      return json({}, 404);
    }) as typeof fetch;
    return { f, accessToken, assertions, queries, hosts };
  }

  it("reads connected apps, self-authorisation and pre-authorisations with a read-only user; never selects a token field", async () => {
    const sf = fakeSalesforce({});
    const { ctx, calls } = ctxFor({ fetch: sf.f, source, credential });
    const res = await scanner("entitlement_salesforce").run(ctx);
    // both shared checks passed (no write system permission, no object-level write): read_only (#890 R4 [1])
    expect(res.credentialWriteScope).toBe("read_only");
    const batch = checkSaasEntitlementBatch(res.entitlements, "salesforce");
    expect(batch).toMatchObject({ tenant: ORG.slice(0, 15), complete: true });
    expect(batch.apps.map((a) => [a.externalId, a.grants.map((g) => `${g.resource} ${g.scope}`).sort()]).sort()).toEqual([
      ["0H4AGENT0000001", [" connected_app:self_authorize", "profile:System_Administrator connected_app:preauthorized"]],
      ["0H4LOCKED000002", ["permission_set:Sales_Agents connected_app:preauthorized"]],
    ]);
    // the shared JWT helper: consumer key, user, production audience, a 2-minute life and a fresh jti
    const claims = JSON.parse(Buffer.from(sf.assertions[0]!.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims).toMatchObject({ iss: credential.publicConfig.clientId, sub: credential.publicConfig.username, aud: "https://login.salesforce.com" });
    expect((claims.exp as number) - (claims.iat as number)).toBe(120);
    expect(typeof claims.jti).toBe("string");
    // only the My Domain is ever called; the vendor's instance_url is ignored
    expect(new Set(sf.hosts)).toEqual(new Set(["acme.my.salesforce.com"]));
    // nothing that could revoke a token (DeleteToken, RequestToken, AccessToken) is ever queried; every API call is a GET
    expect(sf.queries.join(" ")).not.toMatch(/OauthToken|DeleteToken|RequestToken/);
    // the token exchange is the one POST (to the My Domain's token endpoint); every API call is a GET
    expect(calls.methods.filter(([h, m]) => h === "acme.my.salesforce.com" && m !== "GET")).toEqual([["acme.my.salesforce.com", "POST"]]);
    expect(calls.secrets).toEqual(expect.arrayContaining([sf.accessToken, sf.assertions[0]]));
    expect(calls.raw.join("")).not.toContain(sf.accessToken);
  });

  it.each([...WRITE_SYSTEM_PERMISSIONS])("an integration user holding %s is refused before any app is read (decision 7)", async (perm) => {
    const sf = fakeSalesforce({ [perm]: true });
    const res = await scanner("entitlement_salesforce").run(ctxFor({ fetch: sf.f, source, credential }).ctx);
    expect(res.credentialWriteScope).toBe("write");
    expect(res.entitlements).toBeUndefined();
    expect(sf.queries.some((q) => q.includes("ConnectedApplication"))).toBe(false);
  });

  it("object-level write on any object refuses the credential too (#890 R4 [1])", async () => {
    const sf = fakeSalesforce({}, undefined, [{ Id: "110xx0000000001AAA", SobjectType: "Account" }]);
    const res = await scanner("entitlement_salesforce").run(ctxFor({ fetch: sf.f, source, credential }).ctx);
    expect(res.credentialWriteScope).toBe("write");
    expect(res.readOutcomes![0]!.detail).toMatch(/write on Account/);
    expect(sf.queries.some((q) => q.includes("ConnectedApplication"))).toBe(false);
  });

  it("an unreadable permission check reads nothing else and stays unverified", async () => {
    const sf = fakeSalesforce({}, (_u, q) => (q === SALESFORCE_PERMISSIONS_QUERY ? json({ done: true, records: [] }) : null));
    const res = await scanner("entitlement_salesforce").run(ctxFor({ fetch: sf.f, source, credential }).ctx).catch((e: Error) => e);
    // nothing could be read: the run fails with the reason rather than reporting an empty graph
    expect(String(res instanceof Error ? res.message : res.credentialWriteScope)).toMatch(/permission check|unverified/);
    expect(sf.queries.some((q) => q.includes("ConnectedApplication"))).toBe(false);
  });

  it("refuses another org's token, a target that names no My Domain, a key that is not RSA and a non-PKCS#8 key", async () => {
    await expect(scanner("entitlement_salesforce").run(ctxFor({ fetch: fakeSalesforce({}).f, source: { ...source, target: { ...source.target, orgId: "00D5g000009ZzZzEAA" } }, credential }).ctx)).rejects.toThrow(/another org/);
    const v = (target: Record<string, string>) => scanner("entitlement_salesforce").validateTarget!(target, { orgLevel: true, include: [] });
    expect(v({ environment: "production", myDomain: "https://login.salesforce.com", orgId: ORG })).toMatch(/myDomain/);
    expect(v({ environment: "production", myDomain: "https://evil.example", orgId: ORG })).toMatch(/myDomain/);
    expect(v({ myDomain: INSTANCE, orgId: ORG })).toMatch(/environment/);
    expect(v({ environment: "sandbox", myDomain: "https://acme--uat.sandbox.my.salesforce.com", orgId: ORG })).toBeNull();
    expect(v({ environment: "production", myDomain: INSTANCE, orgId: "nope" })).toMatch(/orgId/);
    // the shared helper's key check is in force: a key that is not RSA is refused (its RSA size rule, under 2048 bits
    // refused, is pinned in the helper's own suite through rsaKeyStrongEnough, without generating a weak key here)
    const notRsa = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await expect(scanner("entitlement_salesforce").run(ctxFor({ fetch: fakeSalesforce({}).f, source, credential: { ...credential, secret: notRsa } }).ctx)).rejects.toThrow(/RSA private key of at least 2048 bits/);
    await expect(scanner("entitlement_salesforce").run(ctxFor({ fetch: fakeSalesforce({}).f, source, credential: { ...credential, secret: "not a key" } }).ctx)).rejects.toThrow(/PKCS#8/);
  });
});

