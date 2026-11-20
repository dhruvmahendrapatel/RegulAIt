/**
 * ADR-0336 slice 1: the Copilot Studio adapter against a fake Dataverse environment (no real tenant; live tenants are
 * owner-gated). The Entra token goes through the real @azure/identity path; every Dataverse call goes through the
 * adapter's endpoint allow-list. The worker's own `checkRegistryAgents` is then run on what the adapter produced.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScanContext, ScanSource } from "./discovery-scanners.js";
import { COPILOT_STUDIO_ENDPOINTS, COPILOT_STUDIO_SCANNER, COPILOT_STUDIO_SELECTS, copilotStudioOrgs, copilotStudioTargetProblem } from "./agent-registry-copilot-studio.js";
import { checkRegistryAgents } from "./agent-registry-records.js";

const TENANT = "00000000-0000-4000-8000-000000000336";
const CLIENT = "00000000-0000-4000-8000-000000000337";
const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOT_1 = "b0000000-0000-4000-8000-000000000001";
const BOT_2 = "b0000000-0000-4000-8000-000000000002";
const REF = "c0000000-0000-4000-8000-000000000001";
const ORG = "https://contoso.crm4.dynamics.com";
const API = `${ORG}/api/data/v9.2`;
const synthetic = (label: string) => `${label}-${randomBytes(12).toString("hex")}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const jwt = (claims: Record<string, unknown>) => `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
const FMT = "@OData.Community.Display.V1.FormattedValue";
/** a field a careless adapter might keep: it must never be requested or staged */
const SECRET_TEXT = "INSTRUCTIONS-never-stored-sk_live_example";

interface FakeOpts {
  privileges?: string[];
  privilegesStatus?: number;
  componentsPage2Status?: number;
  botsNextLink?: string;
  /** this many knowledge sources on the first agent, in one page */
  manyComponents?: number;
}

function fakeDataverse(opts: FakeOpts = {}) {
  const accessToken = jwt({ tid: TENANT, aud: ORG });
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
    if (url.origin === ORG) {
      const p = url.pathname;
      if (p === "/api/data/v9.2/WhoAmI") return json({ UserId: USER, BusinessUnitId: CLIENT, OrganizationId: TENANT });
      if (p === `/api/data/v9.2/systemusers(${USER})/Microsoft.Dynamics.CRM.RetrieveUserPrivileges()`) {
        if (opts.privilegesStatus) return json({ error: { message: "no" } }, opts.privilegesStatus);
        return json({ RolePrivileges: (opts.privileges ?? ["prvReadbot", "prvReadbotcomponent", "prvReadconnectionreference"]).map((n) => ({ PrivilegeName: n, Depth: "Global" })) });
      }
      if (p === "/api/data/v9.2/bots") {
        if (url.searchParams.get("$skiptoken")) {
          return json({ value: [{ botid: BOT_2, name: "Invoice agent", schemaname: "cr_invoice", statecode: 1, authenticationmode: 2, accesscontrolpolicy: 3 }] });
        }
        return json({
          value: [
            {
              botid: BOT_1,
              name: "HR helper",
              schemaname: "cr_hr",
              statecode: 0,
              [`statuscode${FMT}`]: "Provisioned",
              publishedon: "2026-11-01T10:00:00Z",
              language: 1033,
              [`language${FMT}`]: "English",
              authenticationmode: 3,
              accesscontrolpolicy: 2,
              _ownerid_value: USER,
              [`_ownerid_value${FMT}`]: "Avery Admin",
              // a column the adapter never selects; a real service would not return it, the fake does to prove it is dropped
              configuration: SECRET_TEXT,
            },
          ],
          "@odata.nextLink": opts.botsNextLink ?? `${API}/bots?$select=botid&$skiptoken=%3Ccookie%20page%3D%222%22%2F%3E`,
        });
      }
      if (p === "/api/data/v9.2/connectionreferences") {
        return json({ value: [{ connectionreferenceid: REF, connectionreferencedisplayname: "Contoso mail", connectorid: "/providers/Microsoft.PowerApps/apis/shared_office365", statecode: 0 }] });
      }
      if (p === "/api/data/v9.2/botcomponents") {
        if (opts.manyComponents) {
          return json({ value: Array.from({ length: opts.manyComponents }, (_, i) => ({ botcomponentid: `e0000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `K${i}`, componenttype: 16, statecode: 0, _parentbotid_value: BOT_1 })) });
        }
        if (url.searchParams.get("$skiptoken")) {
          if (opts.componentsPage2Status) return json({ error: "throttled" }, opts.componentsPage2Status);
          return json({ value: [{ botcomponentid: "d0000000-0000-4000-8000-000000000003", name: "Leave policy", componenttype: 16, statecode: 0, _parentbotid_value: BOT_2 }] });
        }
        return json({
          value: [
            { botcomponentid: "d0000000-0000-4000-8000-000000000001", name: "HR handbook", componenttype: 16, statecode: 0, _parentbotid_value: BOT_1, content: SECRET_TEXT },
            { botcomponentid: "d0000000-0000-4000-8000-000000000002", name: "Payroll skill", componenttype: 13, statecode: 1, _parentbotid_value: BOT_1 },
            // a topic: not a component itself, but its connection reference is a connected app of the agent
            { botcomponentid: "d0000000-0000-4000-8000-000000000009", name: "Send mail", componenttype: 9, statecode: 0, _parentbotid_value: BOT_1, data: SECRET_TEXT, botcomponent_connectionreference: [{ connectionreferenceid: REF }] },
          ],
          "@odata.nextLink": `${API}/botcomponents?$skiptoken=2`,
        });
      }
    }
    return json({}, 404);
  }) as typeof fetch;
  return { f, accessToken };
}

function run(opts: FakeOpts = {}, source: Partial<ScanSource> = {}) {
  const dv = fakeDataverse(opts);
  const calls = { urls: [] as string[], methods: [] as string[], secrets: [] as string[], pseudonymised: [] as string[] };
  const ctx: ScanContext = {
    source: { id: "s-cs", name: "copilot", kind: "agent_registry_copilot_studio", target: { tenantId: TENANT, orgUrls: `${ORG}/` }, scope: { orgLevel: true, include: [] }, ...source },
    credential: { mode: "static", publicConfig: { tenantId: TENANT, clientId: CLIENT }, secret: synthetic("client-secret") },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.urls.push(urlOf(input).href);
      calls.methods.push((init?.method ?? "GET").toUpperCase());
      return dv.f(input, init);
    }) as typeof fetch,
    throttle: async () => undefined,
    backoff: async () => false,
    recordRaw: () => undefined,
    registerSecret: (v) => {
      calls.secrets.push(v);
    },
    pseudonymise: async (kind, name) => {
      calls.pseudonymised.push(`${kind}:${name}`);
      return `psn:${Buffer.from(name).toString("hex").slice(0, 24).padEnd(24, "0")}`;
    },
    heartbeat: async () => true,
    signal: new AbortController().signal,
    catalogue: { matches: () => true, rows: () => [] },
  };
  return { promise: COPILOT_STUDIO_SCANNER.run(ctx), calls, dv };
}
const dataverseCalls = (calls: { urls: string[]; methods: string[] }) => calls.urls.map((u, i) => ({ url: new URL(u), method: calls.methods[i] })).filter((c) => c.url.origin === ORG);

describe("ADR-0336 agent_registry_copilot_studio: targets", () => {
  it("names the tenant and 1 to 20 Dataverse environment URLs; anything else is refused before a write", () => {
    expect(copilotStudioTargetProblem({ tenantId: TENANT, orgUrls: `${ORG}, https://fabrikam.crm.dynamics.com/` }, { orgLevel: true, include: [] })).toBeNull();
    expect(copilotStudioOrgs(`${ORG.toUpperCase()}/,${ORG}`)).toEqual([ORG]);
    for (const bad of ["https://evil.example.com", "http://contoso.crm.dynamics.com", "https://user:pw@contoso.crm.dynamics.com", "https://contoso.crm.dynamics.com/api", "https://contoso.crm.dynamics.com.evil.com", "https://contoso.crm123.dynamics.com", ""]) {
      expect(copilotStudioTargetProblem({ tenantId: TENANT, orgUrls: bad }, { orgLevel: true, include: [] }), bad).toMatch(/orgUrls/);
    }
    expect(copilotStudioTargetProblem({ tenantId: TENANT, orgUrls: Array.from({ length: 21 }, (_, i) => `https://o${i}.crm.dynamics.com`).join(",") }, { orgLevel: true, include: [] })).toMatch(/orgUrls/);
    expect(copilotStudioTargetProblem({ tenantId: "contoso", orgUrls: ORG }, { orgLevel: true, include: [] })).toMatch(/tenantId/);
    expect(copilotStudioTargetProblem({ tenantId: TENANT, orgUrls: ORG }, { orgLevel: false, include: ["../bots"] })).toMatch(/GUID/);
  });
});

describe("ADR-0336 agent_registry_copilot_studio: the read", () => {
  it("reads agents (paged by $skiptoken on our own URL) with owner, knowledge, skills and connected apps; read-only verified; GET only", async () => {
    const { promise, calls, dv } = run();
    const res = await promise;
    expect(res.credentialWriteScope).toBe("read_only");
    expect(res.observations).toEqual([]);
    expect(res.registriesComplete).toEqual(["copilot_studio"]);
    const [hr, invoice] = res.registryAgents!;
    expect(hr!.externalId).toBe(`contoso.crm4.dynamics.com/${BOT_1}`);
    expect(hr!.displayName).toBe("HR helper");
    expect(hr!.attributes).toMatchObject({ environment: "contoso.crm4.dynamics.com", botId: BOT_1, state: "active", language: "English", authenticationMode: "custom_entra_id", accessControlPolicy: "group_membership" });
    expect(invoice!.attributes).toMatchObject({ state: "inactive", authenticationMode: "integrated", accessControlPolicy: "any_multi_tenant" });
    expect(hr!.components).toEqual([
      { kind: "knowledge", vendorRef: "d0000000-0000-4000-8000-000000000001", displayName: "HR handbook", enabled: true, providedBy: null },
      { kind: "tool", vendorRef: "d0000000-0000-4000-8000-000000000002", displayName: "Payroll skill", enabled: false, providedBy: null },
      { kind: "connected_app", vendorRef: "/providers/Microsoft.PowerApps/apis/shared_office365", displayName: "Contoso mail", enabled: true, providedBy: null },
    ]);
    expect(invoice!.components).toEqual([{ kind: "knowledge", vendorRef: "d0000000-0000-4000-8000-000000000003", displayName: "Leave policy", enabled: true, providedBy: null }]);
    // the owner's name never leaves the adapter: only its pseudonym
    expect(calls.pseudonymised).toEqual(["idp_user:Avery Admin"]);
    expect(JSON.stringify(res)).not.toContain("Avery");
    // decision 4: no instruction, topic body or knowledge content anywhere in what is staged
    expect(JSON.stringify(res)).not.toContain(SECRET_TEXT);
    // every Dataverse call is a GET on an allow-listed path; the token request is the one POST, to the login host
    const dv0 = dataverseCalls(calls);
    expect(dv0.length).toBeGreaterThan(0);
    expect(dv0.every((c) => c.method === "GET" && COPILOT_STUDIO_ENDPOINTS.some((r) => r.path.test(c.url.pathname)))).toBe(true);
    // the page-2 request is our first URL with only the cursor added (the service's nextLink $select was ignored)
    const page2 = dv0.find((c) => c.url.pathname.endsWith("/bots") && c.url.searchParams.get("$skiptoken"))!;
    expect(page2.url.searchParams.get("$select")).toBe(COPILOT_STUDIO_SELECTS.bots.join(","));
    expect(calls.secrets).toContain(dv.accessToken);
    // the worker's own check accepts what the adapter produced
    expect(checkRegistryAgents("agent_registry_copilot_studio", res.registryAgents, res.registriesComplete).records).toHaveLength(2);
  });

  it("decision 4, pinned: the exact columns read, and no content column among them", () => {
    expect(COPILOT_STUDIO_SELECTS).toEqual({
      bots: ["botid", "name", "schemaname", "statecode", "statuscode", "publishedon", "createdon", "modifiedon", "language", "authenticationmode", "accesscontrolpolicy", "_ownerid_value"],
      botcomponents: ["botcomponentid", "name", "componenttype", "statecode", "_parentbotid_value"],
      connectionreferences: ["connectionreferenceid", "connectionreferencelogicalname", "connectionreferencedisplayname", "connectorid", "statecode"],
    });
    const all: readonly string[] = Object.values(COPILOT_STUDIO_SELECTS).flat();
    for (const content of ["configuration", "content", "data", "dependencies", "authenticationconfiguration", "description", "filedata", "applicationmanifestinformation"]) expect(all).not.toContain(content);
  });

  it("a write privilege refuses the credential and nothing is read (checked on every run)", async () => {
    const { promise, calls } = run({ privileges: ["prvReadbot", "prvWritebot"] });
    const res = await promise;
    expect(res.credentialWriteScope).toBe("write");
    expect(res.registryAgents ?? []).toEqual([]);
    expect(res.readOutcomes!.find((o) => o.read.startsWith("credential privileges"))?.detail).toMatch(/prvWritebot/);
    expect(dataverseCalls(calls).some((c) => c.url.pathname.endsWith("/bots"))).toBe(false);
  });

  it("privileges that cannot be read mean nothing is read from that environment (the run fails: nothing could be read)", async () => {
    const { promise, calls } = run({ privilegesStatus: 403 });
    await expect(promise).rejects.toThrow(/nothing could be read/);
    expect(dataverseCalls(calls).some((c) => c.url.pathname.endsWith("/bots"))).toBe(false);
  });

  it("a partial component read stages the agents WITHOUT components (the stored set is kept), and the registry is still complete", async () => {
    const res = await run({ componentsPage2Status: 403 }).promise;
    expect(res.registriesComplete).toEqual(["copilot_studio"]);
    expect(res.registryAgents!).toHaveLength(2);
    expect(res.registryAgents!.every((r) => r.components === undefined)).toBe(true);
    expect(res.readOutcomes!.find((o) => o.read.startsWith("agent components"))?.status).toBe("denied");
  });

  it("an agent with more components than the bound is never truncated into a 'complete' set: it reads as partial", async () => {
    const res = await run({ manyComponents: 201 }).promise;
    const [hr, invoice] = res.registryAgents!;
    expect(hr!.components).toBeUndefined();
    expect(invoice!.components).toEqual([]);
    expect(res.readOutcomes!.some((o) => /more than 200 components/.test(o.detail ?? ""))).toBe(true);
    expect(checkRegistryAgents("agent_registry_copilot_studio", res.registryAgents, res.registriesComplete).records).toHaveLength(2);
  });

  it("a next link that leaves the path is never followed: the listing stops as partial and nothing is marked absent", async () => {
    const { promise, calls } = run({ botsNextLink: "https://evil.example.com/api/data/v9.2/bots?$skiptoken=2" });
    const res = await promise;
    expect(res.registriesComplete).toEqual([]);
    expect(calls.urls.some((u) => new URL(u).hostname === "evil.example.com")).toBe(false);
  });

  it("an include list keeps only the named agents", async () => {
    const res = await run({}, { scope: { orgLevel: false, include: [BOT_2.toUpperCase()] } }).promise;
    expect(res.registryAgents!.map((r) => r.attributes!.botId)).toEqual([BOT_2]);
  });
});
