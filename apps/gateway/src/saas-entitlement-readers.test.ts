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
import { GOOGLE_WORKSPACE_REPORTS_READONLY_SCOPE } from "@regulait/cloud-discovery";
import { checkSaasEntitlementBatch, type SaasEntitlementBatch } from "@regulait/shared";
import { DISCOVERY_SCANNERS, type ScanContext } from "./discovery-scanners.js";
import { M365_PERMISSION_RESOURCES, SAAS_ENTITLEMENT_SCANNERS } from "./saas-entitlement-readers.js";

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
  it("registers the two slice-1 readers in the production registry, Salesforce and Slack not yet", () => {
    expect(DISCOVERY_SCANNERS.has("entitlement_m365")).toBe(true);
    expect(DISCOVERY_SCANNERS.has("entitlement_google_workspace")).toBe(true);
    expect(DISCOVERY_SCANNERS.has("entitlement_salesforce")).toBe(false);
    expect(DISCOVERY_SCANNERS.has("entitlement_slack")).toBe(false);
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

  it("refuses without the admin subject or a key", async () => {
    const g = fakeGoogle();
    await expect(scanner("entitlement_google_workspace").run(ctxFor({ fetch: g.f, source, credential: { ...credential, publicConfig: {} } }).ctx)).rejects.toThrow(/adminSubject/);
    await expect(scanner("entitlement_google_workspace").run(ctxFor({ fetch: g.f, source, credential: { ...credential, secret: null } }).ctx)).rejects.toThrow(/static credential/);
  });
});
