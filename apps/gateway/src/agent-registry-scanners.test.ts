/**
 * ADR-0314 (G6): the three vendor agent registry scanners against fake vendor endpoints (no real tenant; live tenants
 * are owner-gated). Each is driven through its real code path: the Entra token through @azure/identity, the Google
 * token through google-auth-library's JWT grant, AgentCore through the AWS SDK's SigV4 signing. Then the worker's own
 * `checkRegistryAgents` is run on the result, so the scanner contract (registries per kind, bounded fields, owners as
 * pseudonyms) is proven on what the scanners really produce.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ScanContext, ScanSource } from "./discovery-scanners.js";
import { DISCOVERY_SCANNERS } from "./discovery-scanners.js";
import { ENTRA_OWNER_LOOKUPS_MAX, agentCoreTargetProblem, agentRegistryScanners, entraRegistryTargetProblem, geminiTargetProblem } from "./agent-registry-scanners.js";
import { RegistryRecordRefused, checkRegistryAgents } from "./agent-registry-records.js";

const TENANT = "00000000-0000-4000-8000-000000000314";
const CLIENT = "00000000-0000-4000-8000-000000000315";
const AGENT_1 = "11111111-1111-4111-8111-111111111111";
const AGENT_2 = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "111122223333";
const synthetic = (label: string) => `${label}-${randomBytes(12).toString("hex")}`;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

function ctxFor(over: Partial<ScanContext> & Pick<ScanContext, "fetch" | "source" | "credential">) {
  const calls = { urls: [] as string[], methods: [] as string[], secrets: [] as string[], pseudonymised: [] as string[] };
  const inner = over.fetch;
  const ctx: ScanContext = {
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
    ...over,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.urls.push(urlOf(input).href);
      calls.methods.push((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase());
      return inner(input, init);
    }) as typeof fetch,
  };
  return { ctx, calls };
}

const scanners = agentRegistryScanners({ oidcToken: async () => synthetic("oidc") });
const scanner = (kind: string) => scanners.find((s) => s.kind === kind)!;

describe("ADR-0314 registration", () => {
  it("every registry kind has a scanner in the production registry and needs a credential", () => {
    for (const kind of ["agent_registry_entra", "agent_registry_gemini", "agent_registry_agentcore"] as const) {
      expect(DISCOVERY_SCANNERS.get(kind)?.requiresCredential).toBe(true);
    }
  });
  it("targets are shape-checked before anything is written", () => {
    expect(entraRegistryTargetProblem({ tenantId: TENANT }, { orgLevel: true, include: [] })).toBeNull();
    expect(entraRegistryTargetProblem({ tenantId: "contoso" }, { orgLevel: true, include: [] })).toMatch(/GUID/);
    expect(entraRegistryTargetProblem({ tenantId: TENANT, agent365: "yes" }, { orgLevel: true, include: [] })).toMatch(/agent365/);
    expect(geminiTargetProblem({ projectId: "acme-agents", location: "eu" }, { orgLevel: true, include: [] })).toBeNull();
    // the location picks the host, so it is a closed list (never a free host name)
    expect(geminiTargetProblem({ projectId: "acme-agents", location: "evil.example.com" }, { orgLevel: true, include: [] })).toMatch(/location/);
    expect(geminiTargetProblem({ projectId: "acme-agents", location: "us" }, { orgLevel: false, include: ["../x"] })).toMatch(/engine/);
    expect(agentCoreTargetProblem({ accountId: ACCOUNT }, { orgLevel: false, include: ["us-east-1"] })).toBeNull();
    expect(agentCoreTargetProblem({ accountId: ACCOUNT }, { orgLevel: true, include: [] })).toMatch(/regional/);
    expect(agentCoreTargetProblem({ accountId: ACCOUNT, federation: "principal" }, { orgLevel: false, include: ["us-east-1"] })).toMatch(/federation/);
  });
});

describe("agent_registry_entra (Entra Agent ID and Agent 365)", () => {
  const source: ScanSource = { id: "s-entra", name: "entra", kind: "agent_registry_entra", target: { tenantId: TENANT, agent365: "true" }, scope: { orgLevel: true, include: [] } };

  function fakeEntra(roles: string[], opts: { packagesStatus?: number } = {}) {
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
      if (url.hostname === "graph.microsoft.com") {
        if (url.pathname === "/v1.0/servicePrincipals/microsoft.graph.agentIdentity") {
          if (url.searchParams.get("$skiptoken")) return json({ value: [{ id: AGENT_2, appId: CLIENT, displayName: "Invoice bot", accountEnabled: false }] });
          return json({
            value: [{ id: AGENT_1, appId: TENANT, displayName: "HR helper", description: "answers HR questions", accountEnabled: true, agentIdentityBlueprintId: CLIENT }],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/servicePrincipals/microsoft.graph.agentIdentity?$skiptoken=2",
          });
        }
        if (url.pathname === `/v1.0/servicePrincipals/${AGENT_1}/microsoft.graph.agentIdentity/owners`) return json({ value: [{ id: "u-1", displayName: "Avery Admin" }] });
        if (url.pathname === `/v1.0/servicePrincipals/${AGENT_2}/microsoft.graph.agentIdentity/owners`) return json({ error: "Forbidden" }, 403);
        if (url.pathname === "/v1.0/copilot/admin/catalog/packages") {
          if (opts.packagesStatus) return json({ error: "no licence" }, opts.packagesStatus);
          return json({ value: [{ id: "P_hr", displayName: "Contoso HR Agent", shortDescription: "HR agent", type: "custom", isBlocked: false, elementTypes: ["declarativeAgent"], agentIdentityId: AGENT_1 }] });
        }
      }
      return json({}, 404);
    }) as typeof fetch;
    return { f, accessToken };
  }

  it("reads agent identities (paged), their owners as pseudonyms, and the Agent 365 catalogue; only GETs; read-only verified", async () => {
    const entra = fakeEntra(["AgentIdentity.Read.All", "CopilotPackages.Read.All"]);
    const secret = synthetic("client-secret");
    const { ctx, calls } = ctxFor({ fetch: entra.f, source, credential: { mode: "static", publicConfig: { tenantId: TENANT, clientId: CLIENT }, secret } });
    const res = await scanner("agent_registry_entra").run(ctx);
    expect(res.credentialWriteScope).toBe("read_only");
    expect(res.observations).toEqual([]);
    expect(res.registryAgents!.map((r) => [r.registry, r.externalId, r.displayName])).toEqual([
      ["entra_agent_id", AGENT_1, "HR helper"],
      ["entra_agent_id", AGENT_2, "Invoice bot"],
      ["agent_365", "P_hr", "Contoso HR Agent"],
    ]);
    const hr = res.registryAgents![0]!;
    expect(hr.attributes).toMatchObject({ appId: TENANT, accountEnabled: true, blueprintId: CLIENT });
    // the owner's name never leaves the scanner: only the pseudonym does
    expect(JSON.stringify(res.registryAgents)).not.toContain("Avery");
    expect(calls.pseudonymised).toEqual(["idp_user:Avery Admin"]);
    expect((hr.attributes!.owners as string[])[0]).toMatch(/^psn:[0-9a-f]{24}$/);
    expect(res.registriesComplete).toEqual(["entra_agent_id", "agent_365"]);
    // one owner read failed: said so, not hidden
    expect(res.readOutcomes!.find((o) => o.read === "Entra agent identity owners")?.detail).toMatch(/1 read, 1 failed/);
    // read-only: every Graph call is a GET (the token request is the one POST, to the login host)
    const graphMethods = calls.urls.map((u, i) => [new URL(u).hostname, calls.methods[i]]).filter(([h]) => h === "graph.microsoft.com");
    expect(graphMethods.every(([, m]) => m === "GET")).toBe(true);
    expect(calls.secrets).toContain(entra.accessToken);
    // the worker's own check accepts what the scanner produced
    expect(checkRegistryAgents("agent_registry_entra", res.registryAgents, res.registriesComplete).records).toHaveLength(3);
  });

  it("refuses a credential that can write before anything is read", async () => {
    const entra = fakeEntra(["AgentIdentity.ReadWrite.All"]);
    const { ctx, calls } = ctxFor({ fetch: entra.f, source, credential: { mode: "static", publicConfig: { tenantId: TENANT, clientId: CLIENT }, secret: synthetic("s") } });
    const res = await scanner("agent_registry_entra").run(ctx);
    expect(res.credentialWriteScope).toBe("write");
    expect(res.registryAgents ?? []).toEqual([]);
    expect(calls.urls.some((u) => new URL(u).hostname === "graph.microsoft.com")).toBe(false);
  });

  it("an unlicensed Agent 365 catalogue is reported denied, and that registry is NOT complete (nothing will be marked absent)", async () => {
    const entra = fakeEntra(["AgentIdentity.Read.All"], { packagesStatus: 403 });
    const { ctx } = ctxFor({ fetch: entra.f, source, credential: { mode: "static", publicConfig: { tenantId: TENANT, clientId: CLIENT }, secret: synthetic("s") } });
    const res = await scanner("agent_registry_entra").run(ctx);
    expect(res.registriesComplete).toEqual(["entra_agent_id"]);
    expect(res.readOutcomes!.find((o) => o.read === "Agent 365 catalogue")?.status).toBe("denied");
  });

  it("an include list keeps only the named identities (and their Agent 365 packages)", async () => {
    const entra = fakeEntra(["AgentIdentity.Read.All", "CopilotPackages.Read.All"]);
    const { ctx } = ctxFor({ fetch: entra.f, source: { ...source, scope: { orgLevel: false, include: [AGENT_2] } }, credential: { mode: "static", publicConfig: { tenantId: TENANT, clientId: CLIENT }, secret: synthetic("s") } });
    const res = await scanner("agent_registry_entra").run(ctx);
    expect(res.registryAgents!.map((r) => r.externalId)).toEqual([AGENT_2]);
    expect(ENTRA_OWNER_LOOKUPS_MAX).toBe(200);
  });
});

describe("agent_registry_gemini (Gemini Enterprise)", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keyJson = JSON.stringify({ type: "service_account", client_email: "importer@acme-agents.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.googleapis.com/token" });
  const source: ScanSource = { id: "s-gem", name: "gemini", kind: "agent_registry_gemini", target: { projectId: "acme-agents", location: "eu" }, scope: { orgLevel: true, include: [] } };
  const ACCESS = synthetic("ya29");
  const f = (async (input: string | URL | Request) => {
    const url = urlOf(input);
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") return json({ access_token: ACCESS, expires_in: 3600, token_type: "Bearer" });
    if (url.hostname === "eu-discoveryengine.googleapis.com") {
      const base = "/v1alpha/projects/acme-agents/locations/eu/collections/default_collection";
      if (url.pathname === `${base}/engines`) return json({ engines: [{ name: `projects/1/locations/eu/collections/default_collection/engines/support-app` }] });
      if (url.pathname === `${base}/engines/support-app/assistants/default_assistant/agents`) {
        if (url.searchParams.get("pageToken") === "p2") return json({ agents: [{ name: `${base.slice(9)}/engines/support-app/assistants/default_assistant/agents/a2`, displayName: "Refunds", state: "ENABLED" }] });
        return json({ agents: [{ name: `${base.slice(9)}/engines/support-app/assistants/default_assistant/agents/a1`, displayName: "Triage", description: "routes tickets", state: "ENABLED" }], nextPageToken: "p2" });
      }
    }
    return json({}, 404);
  }) as typeof fetch;

  it("lists engines, then each engine's agents (paged), with the read-only token; the token is registered for scrubbing", async () => {
    const { ctx, calls } = ctxFor({ fetch: f, source, credential: { mode: "static", publicConfig: {}, secret: keyJson } });
    const res = await scanner("agent_registry_gemini").run(ctx);
    expect(res.registryAgents!.map((r) => [r.registry, r.displayName, r.attributes?.engine])).toEqual([
      ["gemini_enterprise", "Triage", "support-app"],
      ["gemini_enterprise", "Refunds", "support-app"],
    ]);
    expect(res.registriesComplete).toEqual(["gemini_enterprise"]);
    expect(res.credentialWriteScope).toBe("read_only");
    expect(calls.secrets).toContain(ACCESS);
    const apiCalls = calls.urls.map((u, i) => [new URL(u).hostname, calls.methods[i]]).filter(([h]) => h === "eu-discoveryengine.googleapis.com");
    expect(apiCalls.length).toBe(3);
    expect(apiCalls.every(([, m]) => m === "GET")).toBe(true);
    expect(checkRegistryAgents("agent_registry_gemini", res.registryAgents, res.registriesComplete).records).toHaveLength(2);
  });

  it("an engine it cannot read makes the registry incomplete", async () => {
    const { ctx } = ctxFor({ fetch: f, source: { ...source, scope: { orgLevel: false, include: ["support-app", "missing-app"] } }, credential: { mode: "static", publicConfig: {}, secret: keyJson } });
    const res = await scanner("agent_registry_gemini").run(ctx);
    expect(res.registryAgents).toHaveLength(2);
    expect(res.registriesComplete).toEqual([]);
  });
});

describe("agent_registry_agentcore (Bedrock AgentCore)", () => {
  const source: ScanSource = { id: "s-ac", name: "agentcore", kind: "agent_registry_agentcore", target: { accountId: ACCOUNT }, scope: { orgLevel: false, include: ["us-east-1"] } };
  const f = (async (input: string | URL | Request) => {
    const url = urlOf(input);
    if (url.hostname === "bedrock-agentcore-control.us-east-1.amazonaws.com" && url.pathname === "/runtimes/") {
      return json({
        agentRuntimes: [
          { agentRuntimeArn: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:runtime/support-x1`, agentRuntimeId: "support-x1", agentRuntimeName: "support", agentRuntimeVersion: "2", status: "READY", lastUpdatedAt: "2026-11-01T10:00:00Z" },
          // another account's runtime (a misrouted credential) is never staged
          { agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:999999999999:runtime/other-y", agentRuntimeId: "other-y", agentRuntimeName: "other", agentRuntimeVersion: "1", status: "READY", lastUpdatedAt: "2026-11-01T10:00:00Z" },
        ],
      });
    }
    return json({ message: "unexpected" }, 400);
  }) as typeof fetch;

  it("lists runtimes of the named regions, keeps only the source account's, and says the write scope is unverified", async () => {
    const secret = JSON.stringify({ accessKeyId: `AKIA${randomBytes(8).toString("hex").toUpperCase()}`, secretAccessKey: synthetic("sk") });
    const { ctx, calls } = ctxFor({ fetch: f, source, credential: { mode: "static", publicConfig: {}, secret } });
    const res = await scanner("agent_registry_agentcore").run(ctx);
    expect(res.registryAgents!.map((r) => [r.registry, r.displayName, r.attributes?.region])).toEqual([["bedrock_agentcore", "support", "us-east-1"]]);
    expect(res.registriesComplete).toEqual(["bedrock_agentcore"]);
    expect(res.credentialWriteScope).toBe("unverified");
    expect(calls.urls.every((u) => new URL(u).hostname === "bedrock-agentcore-control.us-east-1.amazonaws.com")).toBe(true);
    expect(checkRegistryAgents("agent_registry_agentcore", res.registryAgents, res.registriesComplete).records).toHaveLength(1);
  });
});

describe("the worker's registry record check (scanner contract)", () => {
  const rec = { registry: "entra_agent_id" as const, externalId: AGENT_1, displayName: "HR helper" };
  it("refuses a registry the kind may not report, a source kind that reports none, and a person's name as an owner", () => {
    expect(() => checkRegistryAgents("agent_registry_gemini", [rec], [])).toThrow(RegistryRecordRefused);
    expect(() => checkRegistryAgents("idp_entra", [rec], [])).toThrow(/does not report registry agents/);
    expect(() => checkRegistryAgents("agent_registry_entra", [{ ...rec, attributes: { owners: ["Avery Admin"] } }], [])).toThrow(/pseudonyms/);
    expect(() => checkRegistryAgents("agent_registry_entra", [{ ...rec, displayName: "x".repeat(257) }], [])).toThrow(/name/);
    expect(() => checkRegistryAgents("agent_registry_entra", [{ ...rec, attributes: { nested: { a: 1 } as unknown as string } }], [])).toThrow(/attribute/);
  });
  it("keeps the first of duplicates, and drops a completeness claim for a registry the kind does not read", () => {
    const out = checkRegistryAgents("agent_registry_entra", [rec, { ...rec, displayName: "dup" }], ["entra_agent_id", "gemini_enterprise"]);
    expect(out.records.map((r) => r.displayName)).toEqual(["HR helper"]);
    expect(out.complete).toEqual(["entra_agent_id"]);
  });
});
