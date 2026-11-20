/**
 * ADR-0336 slice 2: the Agentforce adapter against a fake Salesforce org (no real org; live orgs are owner-gated).
 * The JWT bearer assertion is really signed (jose, RS256) and verified by the fake token endpoint with the public key;
 * every org call goes through the adapter's endpoint allow-list. The worker's own `checkRegistryAgents` then runs on
 * what the adapter produced.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createLocalJWKSet, exportJWK, importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import type { ScanContext, ScanSource } from "./discovery-scanners.js";
import { WRITE_SYSTEM_PERMISSIONS, AGENTFORCE_ENDPOINTS, AGENTFORCE_QUERIES, AGENTFORCE_SCANNER, agentforceTargetProblem, objectWriteQuery } from "./agent-registry-agentforce.js";
import { SALESFORCE_JWT_LIFETIME_S } from "./salesforce-jwt.js";
import { checkRegistryAgents } from "./agent-registry-records.js";

const ORIGIN = "https://acme.my.salesforce.com";
const V = "67.0";
const CONSUMER_KEY = "3MVG9" + "A".repeat(60);
const USERNAME = "integration@acme.example.com";
const BOT_1 = "0XxAA00000000AAAAA";
const BOT_2 = "0XxAA00000000BBBBB";
const VER_1 = "0X9AA00000000AAAAA";
const VER_2 = "0X9AA00000000BBBBB";
const PLANNER_1 = "16jAA00000000AAAAA";
const TOPIC_1 = "179AA00000000AAAAA";
const USER_1 = "005AA00000000AAAAA";
/** the integration user the token acts as (from the token response's identity URL) */
const INTEGRATION_USER = "005AA00000000ZZZZZ";
/** free text a careless adapter might keep: it must never be requested or staged */
const SECRET_TEXT = "INSTRUCTIONS-never-stored-sk_live_example";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const urlOf = (input: string | URL | Request) => new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

interface FakeOpts {
  permissions?: Partial<Record<(typeof WRITE_SYSTEM_PERMISSIONS)[number], boolean>>;
  permissionsStatus?: number;
  tokenError?: string;
  actionsPage2Status?: number;
  botsNextRecordsUrl?: string;
  noPlanner?: boolean;
  instanceUrl?: string;
  /** object-level write rows the integration user's permission sets grant */
  objectWrites?: Array<{ SobjectType: string }>;
  objectStatus?: number;
  /** the token response's identity URL; null omits it */
  identity?: string | null;
}

function fakeOrg(opts: FakeOpts = {}) {
  const accessToken = `00DAA!${randomBytes(24).toString("hex")}`;
  const assertions: Array<Record<string, unknown>> = [];
  const soql: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (url.origin !== ORIGIN) return json({}, 404);
    if (url.pathname === "/services/oauth2/token") {
      if (opts.tokenError) return json({ error: opts.tokenError, error_description: `user hint ${SECRET_TEXT}` }, 400);
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
      const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(await importSPKI(publicKey, "RS256"))), alg: "RS256" }] });
      const { payload, protectedHeader } = await jwtVerify(form.get("assertion")!, jwks, { audience: "https://login.salesforce.com", issuer: CONSUMER_KEY, subject: USERNAME });
      expect(protectedHeader.alg).toBe("RS256");
      assertions.push(payload as Record<string, unknown>);
      const id = opts.identity === undefined ? `https://login.salesforce.com/id/00DAA0000000AAAAAA/${INTEGRATION_USER}` : opts.identity;
      return json({ access_token: accessToken, instance_url: opts.instanceUrl ?? ORIGIN, token_type: "Bearer", ...(id === null ? {} : { id }) });
    }
    expect(init?.headers && (init.headers as Record<string, string>).authorization).toBe(`Bearer ${accessToken}`);
    const q = url.searchParams.get("q");
    if (q) soql.push(q);
    const p = url.pathname;
    if (p === `/services/data/v${V}/query` && q === AGENTFORCE_QUERIES.permissions) {
      if (opts.permissionsStatus) return json([{ errorCode: "INSUFFICIENT_ACCESS" }], opts.permissionsStatus);
      return json({ done: true, records: [{ ...Object.fromEntries(WRITE_SYSTEM_PERMISSIONS.map((x) => [x, false])), ...opts.permissions }] });
    }
    if (p === `/services/data/v${V}/query` && q === objectWriteQuery(INTEGRATION_USER)) {
      if (opts.objectStatus) return json([{ errorCode: "INSUFFICIENT_ACCESS" }], opts.objectStatus);
      return json({ done: true, records: opts.objectWrites ?? [] });
    }
    if (p === `/services/data/v${V}/query` && q === AGENTFORCE_QUERIES.bots) {
      return json({
        done: false,
        records: [{ Id: BOT_1, DeveloperName: "HR_Helper", MasterLabel: "HR helper", Type: "InternalCopilot", AgentType: "EinsteinServiceAgent", BotUserId: USER_1, Description: SECRET_TEXT }],
        nextRecordsUrl: opts.botsNextRecordsUrl ?? `/services/data/v${V}/query/01gAA00000000AAAAA-2000`,
      });
    }
    if (p === `/services/data/v${V}/query/01gAA00000000AAAAA-2000`) {
      return json({ done: true, records: [{ Id: BOT_2, DeveloperName: "Invoice_Agent", MasterLabel: "Invoice agent", Type: "Bot" }] });
    }
    if (p === `/services/data/v${V}/query` && q === AGENTFORCE_QUERIES.versions) {
      return json({ done: true, records: [{ Id: VER_1, BotDefinitionId: BOT_1, VersionNumber: 3, Status: "Active" }, { Id: VER_2, BotDefinitionId: BOT_2, VersionNumber: 1, Status: "Inactive" }] });
    }
    if (p === `/services/data/v${V}/tooling/query` && q === AGENTFORCE_QUERIES.planners) {
      return json({ done: true, records: opts.noPlanner ? [] : [{ Id: PLANNER_1, DeveloperName: "HR_Planner", MasterLabel: "HR", PlannerType: "AiCopilot__ReAct", LinkedBotVersionId: VER_1, AgentGraph: SECRET_TEXT }] });
    }
    if (p === `/services/data/v${V}/query` && q === AGENTFORCE_QUERIES.topics) {
      return json({ done: true, records: [{ Id: TOPIC_1, DeveloperName: "Leave", MasterLabel: "Leave", PlannerId: PLANNER_1, Scope: SECRET_TEXT }] });
    }
    if (p === `/services/data/v${V}/query` && q === AGENTFORCE_QUERIES.actions) {
      return json({
        done: false,
        records: [{ Id: "179AA00000000F001", DeveloperName: "Lookup_Leave_Balance", MasterLabel: "Look up leave balance", PlannerId: PLANNER_1, InvocationTargetType: "flow", Description: SECRET_TEXT }],
        nextRecordsUrl: `/services/data/v${V}/query/01gAA00000000BBBBB-2000`,
      });
    }
    if (p === `/services/data/v${V}/query/01gAA00000000BBBBB-2000`) {
      if (opts.actionsPage2Status) return json([{ errorCode: "REQUEST_LIMIT_EXCEEDED" }], opts.actionsPage2Status);
      // linked through its topic only
      return json({ done: true, records: [{ Id: "179AA00000000F002", DeveloperName: "Submit_Leave", MasterLabel: "Submit leave", PluginId: TOPIC_1, InvocationTargetType: "apex" }] });
    }
    return json([{ errorCode: "NOT_FOUND" }], 404);
  }) as typeof fetch;
  return { f, accessToken, assertions, soql };
}

function run(opts: FakeOpts = {}, source: Partial<ScanSource> = {}, credential?: ScanContext["credential"]) {
  const org = fakeOrg(opts);
  const calls = { urls: [] as string[], methods: [] as string[], secrets: [] as string[], pseudonymised: [] as string[] };
  const ctx: ScanContext = {
    source: { id: "s-af", name: "agentforce", kind: "agent_registry_agentforce", target: { myDomain: `${ORIGIN}/`, environment: "production" }, scope: { orgLevel: true, include: [] }, ...source },
    credential: credential ?? { mode: "static", publicConfig: { consumerKey: CONSUMER_KEY, username: USERNAME }, secret: privateKey },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.urls.push(urlOf(input).href);
      calls.methods.push((init?.method ?? "GET").toUpperCase());
      return org.f(input, init);
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
  return { promise: AGENTFORCE_SCANNER.run(ctx), calls, org };
}

describe("ADR-0336 agent_registry_agentforce: targets", () => {
  const ok = { orgLevel: true, include: [] };
  it("names a My Domain URL matching its environment and a pinned API version; anything else is refused before a write", () => {
    expect(agentforceTargetProblem({ myDomain: ORIGIN, environment: "production" }, ok)).toBeNull();
    expect(agentforceTargetProblem({ myDomain: "https://acme--uat.sandbox.my.salesforce.com", environment: "sandbox", apiVersion: "66.0" }, ok)).toBeNull();
    for (const myDomain of ["https://evil.example.com", "http://acme.my.salesforce.com", "https://acme.my.salesforce.com.evil.com", "https://user:pw@acme.my.salesforce.com", "https://acme.my.salesforce.com/services", "https://acme--uat.sandbox.my.salesforce.com"]) {
      expect(agentforceTargetProblem({ myDomain, environment: "production" }, ok), myDomain).toMatch(/myDomain/);
    }
    // a production host named as a sandbox is refused too (the JWT audience follows the environment)
    expect(agentforceTargetProblem({ myDomain: ORIGIN, environment: "sandbox" }, ok)).toMatch(/myDomain/);
    expect(agentforceTargetProblem({ myDomain: ORIGIN, environment: "dev" }, ok)).toMatch(/environment/);
    expect(agentforceTargetProblem({ myDomain: ORIGIN, environment: "production", apiVersion: "60.0" }, ok)).toMatch(/apiVersion/);
    expect(agentforceTargetProblem({ myDomain: ORIGIN, environment: "production" }, { orgLevel: false, include: ["x' OR Id != '"] })).toMatch(/15 or 18/);
  });
});

describe("ADR-0336 agent_registry_agentforce: the read", () => {
  it("signs a bound, short assertion; reads agents, versions, planners, topics and actions (paged by our own locator URL); GET only after the token", async () => {
    const { promise, calls, org } = run();
    const res = await promise;
    expect(res.credentialWriteScope).toBe("read_only");
    expect(res.registriesComplete).toEqual(["agentforce"]);
    // the assertion: our consumer key and user, Salesforce's production audience, 2 minutes, a fresh jti
    expect(org.assertions).toHaveLength(1);
    const a = org.assertions[0]!;
    expect((a.exp as number) - (a.iat as number)).toBe(SALESFORCE_JWT_LIFETIME_S);
    expect(typeof a.jti).toBe("string");
    const [hr, invoice] = res.registryAgents!;
    expect(hr!.externalId).toBe(`acme.my.salesforce.com/${BOT_1}`);
    expect(hr!.attributes).toMatchObject({ org: "acme.my.salesforce.com", developerName: "HR_Helper", type: "InternalCopilot", state: "active", activeVersion: "3", topicCount: "1" });
    expect(invoice!.attributes).toMatchObject({ state: "inactive" });
    // actions are components: one linked through the planner, one through its topic
    expect(hr!.components).toEqual([
      { kind: "tool", vendorRef: "Lookup_Leave_Balance", displayName: "Look up leave balance", enabled: null, providedBy: null },
      { kind: "tool", vendorRef: "Submit_Leave", displayName: "Submit leave", enabled: null, providedBy: null },
    ]);
    // an agent with no linked planner is unknown, not "none": its stored set is kept
    expect(invoice!.components).toBeUndefined();
    // the run-as user only as a pseudonym; no free text anywhere
    expect((hr!.attributes!.runAs as string[])[0]).toMatch(/^psn:/);
    expect(JSON.stringify(res)).not.toContain(USER_1);
    expect(JSON.stringify(res)).not.toContain(SECRET_TEXT);
    // the exact SOQL issued, in order; the permission check first
    expect(org.soql).toEqual([AGENTFORCE_QUERIES.permissions, objectWriteQuery(INTEGRATION_USER), AGENTFORCE_QUERIES.bots, AGENTFORCE_QUERIES.versions, AGENTFORCE_QUERIES.planners, AGENTFORCE_QUERIES.topics, AGENTFORCE_QUERIES.actions]);
    // one POST (the token), every other call a GET on an allow-listed path of the My Domain origin
    const sent = calls.urls.map((u, i) => ({ url: new URL(u), method: calls.methods[i] }));
    expect(sent.filter((c) => c.method === "POST").map((c) => c.url.pathname)).toEqual(["/services/oauth2/token"]);
    expect(sent.every((c) => c.url.origin === ORIGIN && AGENTFORCE_ENDPOINTS.some((r) => r.method === c.method && r.path.test(c.url.pathname)))).toBe(true);
    // the token and the signed assertion are both registered for scrubbing
    expect(calls.secrets).toContain(org.accessToken);
    expect(calls.secrets.some((s) => s.split(".").length === 3)).toBe(true);
    expect(checkRegistryAgents("agent_registry_agentforce", res.registryAgents, res.registriesComplete).records).toHaveLength(2);
  });

  it("decision 4, pinned: the exact columns read, and no free-text column among them", () => {
    expect(AGENTFORCE_QUERIES).toEqual({
      permissions:
        "SELECT PermissionsModifyAllData, PermissionsModifyMetadata, PermissionsCustomizeApplication, PermissionsAuthorApex, PermissionsManageUsers, PermissionsAssignPermissionSets, PermissionsManageProfilesPermissionsets, PermissionsManageInternalUsers, PermissionsManageRoles, PermissionsManageSharing, PermissionsResetPasswords FROM UserPermissionAccess",
      bots: "SELECT Id, DeveloperName, MasterLabel, Type, AgentType, BotUserId FROM BotDefinition",
      versions: "SELECT Id, BotDefinitionId, VersionNumber, Status FROM BotVersion",
      planners: "SELECT Id, DeveloperName, MasterLabel, PlannerType, LinkedBotVersionId FROM GenAiPlannerDefinition",
      topics: "SELECT Id, DeveloperName, MasterLabel, PlannerId FROM GenAiPluginDefinition",
      actions: "SELECT Id, DeveloperName, MasterLabel, PlannerId, PluginId, InvocationTargetType FROM GenAiFunctionDefinition",
    });
    const cols = Object.values(AGENTFORCE_QUERIES).flatMap((q) => q.replace(/^SELECT /, "").replace(/ FROM .*$/, "").split(", "));
    for (const text of ["Description", "Scope", "AgentGraph", "ProgressIndicatorMessage", "Metadata", "FullName"]) expect(cols).not.toContain(text);
  });

  it("#1111 [1]: an escalation or user-management permission refuses the credential too", async () => {
    for (const perm of ["PermissionsAssignPermissionSets", "PermissionsManageProfilesPermissionsets", "PermissionsManageInternalUsers", "PermissionsManageRoles", "PermissionsManageSharing", "PermissionsResetPasswords"] as const) {
      const { promise, org } = run({ permissions: { [perm]: true } });
      const res = await promise;
      expect(res.credentialWriteScope, perm).toBe("write");
      expect(org.soql).toEqual([AGENTFORCE_QUERIES.permissions]);
    }
  });

  it("#1111 [1]: object-level Create, Edit, Delete or Modify All on any assigned permission set refuses the credential; nothing else is read", async () => {
    const { promise, org } = run({ objectWrites: [{ SobjectType: "Account" }, { SobjectType: "Opportunity" }] });
    const res = await promise;
    expect(res.credentialWriteScope).toBe("write");
    expect(res.registryAgents ?? []).toEqual([]);
    expect(res.readOutcomes![0]!.detail).toMatch(/write on Account, write on Opportunity/);
    expect(org.soql).toEqual([AGENTFORCE_QUERIES.permissions, objectWriteQuery(INTEGRATION_USER)]);
  });

  it("#1111 [1]: an object permission check that cannot be read reads nothing, and the credential is never read_only", async () => {
    const { promise, org } = run({ objectStatus: 403 });
    await expect(promise).rejects.toThrow(/nothing could be read/);
    expect(org.soql).toEqual([AGENTFORCE_QUERIES.permissions, objectWriteQuery(INTEGRATION_USER)]);
  });

  it("#1111 [1]: the object query is pinned, and only a validated id is ever placed in it", () => {
    expect(objectWriteQuery(INTEGRATION_USER)).toBe(
      `SELECT Id, SobjectType FROM ObjectPermissions WHERE (PermissionsCreate = true OR PermissionsEdit = true OR PermissionsDelete = true OR PermissionsModifyAllRecords = true) AND ParentId IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${INTEGRATION_USER}') LIMIT 5`,
    );
    expect(() => objectWriteQuery("x' OR Id != '")).toThrow(/not a Salesforce id/);
  });

  it("a token response that names no user is refused before any query", async () => {
    const { promise, org } = run({ identity: null });
    await expect(promise).rejects.toThrow(/named no user/);
    expect(org.soql).toEqual([]);
  });

  it("an admin or metadata write permission refuses the credential and nothing else is read (checked on every run)", async () => {
    const { promise, org } = run({ permissions: { PermissionsModifyMetadata: true } });
    const res = await promise;
    expect(res.credentialWriteScope).toBe("write");
    expect(res.registryAgents ?? []).toEqual([]);
    expect(res.readOutcomes![0]!.detail).toMatch(/PermissionsModifyMetadata/);
    expect(org.soql).toEqual([AGENTFORCE_QUERIES.permissions]);
  });

  it("permissions that cannot be read mean nothing is read (the run fails: nothing could be read)", async () => {
    const { promise, org } = run({ permissionsStatus: 400 });
    await expect(promise).rejects.toThrow(/nothing could be read/);
    expect(org.soql).toEqual([AGENTFORCE_QUERIES.permissions]);
  });

  it("a refused token request reports only Salesforce's error code, never its text", async () => {
    const err = await run({ tokenError: "invalid_grant" }).promise.then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/HTTP 400, invalid_grant/);
    expect(err?.message).not.toContain(SECRET_TEXT);
  });

  it("the instance_url Salesforce returns is ignored: every call stays on the validated My Domain", async () => {
    const { promise, calls } = run({ instanceUrl: "https://evil.example.com" });
    await promise;
    expect(calls.urls.every((u) => new URL(u).origin === ORIGIN)).toBe(true);
  });

  it("a partial action read stages the agents WITHOUT components (the stored set is kept); the registry is still complete", async () => {
    const res = await run({ actionsPage2Status: 403 }).promise;
    expect(res.registriesComplete).toEqual(["agentforce"]);
    expect(res.registryAgents!.every((r) => r.components === undefined)).toBe(true);
  });

  it("a nextRecordsUrl off the query path is never fetched: the listing stops as partial and nothing is marked absent", async () => {
    for (const next of ["https://evil.example.com/services/data/v67.0/query/01gAA00000000AAAAA-2000", "/services/data/v67.0/sobjects/User", "/services/data/v67.0/query/../tooling/x"]) {
      const { promise, calls } = run({ botsNextRecordsUrl: next });
      const res = await promise;
      expect(res.registriesComplete, next).toEqual([]);
      expect(calls.urls.some((u) => new URL(u).hostname === "evil.example.com" || new URL(u).pathname.includes("sobjects"))).toBe(false);
    }
  });

  it("an include list keeps only the named agents, matched on the 15-character id", async () => {
    const res = await run({}, { scope: { orgLevel: false, include: [BOT_2.slice(0, 15)] } }).promise;
    expect(res.registryAgents!.map((r) => r.attributes!.botId)).toEqual([BOT_2]);
  });

  it("refuses a federated credential, a missing key and a secret that is not a PKCS#8 RSA key, before any call", async () => {
    await expect(run({}, {}, { mode: "federated", publicConfig: {}, secret: null }).promise).rejects.toThrow(/static credential/);
    const bad = run({}, {}, { mode: "static", publicConfig: { consumerKey: CONSUMER_KEY, username: USERNAME }, secret: "not a key" });
    await expect(bad.promise).rejects.toThrow(/PKCS#8/);
    expect(bad.calls.urls).toEqual([]);
    // #1111 S4 [2]: an RSA key under 2048 bits is refused
    const short = generateKeyPairSync("rsa", { modulusLength: 1024, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey;
    const weak = run({}, {}, { mode: "static", publicConfig: { consumerKey: CONSUMER_KEY, username: USERNAME }, secret: short });
    await expect(weak.promise).rejects.toThrow(/at least 2048 bits/);
    expect(weak.calls.urls).toEqual([]);
  });

  it("is registered as an adapter whose endpoints are the token POST and GET on the query paths only", () => {
    expect(AGENTFORCE_ENDPOINTS.filter((r) => r.method === "POST").map((r) => r.path.source)).toEqual(["^\\/services\\/oauth2\\/token$"]);
    expect(AGENTFORCE_ENDPOINTS.filter((r) => r.method === "GET").every((r) => /query/.test(r.path.source))).toBe(true);
  });
});
