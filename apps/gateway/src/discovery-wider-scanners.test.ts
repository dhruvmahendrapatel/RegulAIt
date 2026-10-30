/**
 * ADR-0218 (P9): the wider discovery scanners against ADR-0195 SD0's Scanner contract, without a database. A fake
 * service stands behind `ctx.fetch`; the tests check the worker hooks (throttle before every request, every body
 * digested, token responses never digested, consenting users pseudonymised as `idp_user`), that observations pass
 * the worker's own `checkObservations` for the source kind and match the shipped catalogue rows (detection is data),
 * that a write-capable Entra credential is refused before anything is read, that a next-page link to another origin
 * is never followed, and that an all-unreachable run fails with a reason.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { classifyObservation, familySwitchProblem, publicConfigProblem, type AiSignature } from "@regulait/shared";
import type { ScanContext } from "./discovery-scanners.js";
import { DISCOVERY_SCANNERS } from "./discovery-scanners.js";
import { checkObservations } from "./discovery-worker.js";
import { ML_PLATFORM_ASSET_SEED, WIDER_DISCOVERY_SCANNERS, atPath, entraWriteScope, httpsTargetProblem } from "./discovery-wider-scanners.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const CLIENT = "00000000-0000-4000-8000-000000000002";
const AI_APP = "00000000-0000-4000-8000-0000000000a1";
const OTHER_APP = "00000000-0000-4000-8000-0000000000a2";
const NOW = "2026-10-30T00:00:00.000Z";
const synthetic = (label: string) => `${label}-${randomBytes(12).toString("hex")}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const scanner = (kind: string) => WIDER_DISCOVERY_SCANNERS.find((s) => s.kind === kind)!;
const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;

function ctxFor(over: Partial<ScanContext> & Pick<ScanContext, "fetch" | "source" | "credential">) {
  const calls = { throttle: 0, raw: [] as string[], pseudonymise: [] as string[], secrets: [] as string[], urls: [] as string[] };
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
      calls.urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      return inner(input, init);
    }) as typeof fetch,
  };
  return { ctx, calls };
}

const catalogueRow = (over: Partial<AiSignature> & Pick<AiSignature, "kind" | "value" | "matchType">): AiSignature => ({
  provider: "acme-ai",
  provenance: "admin",
  enabled: true,
  minLength: null,
  ...over,
});
const SEED_ROWS: AiSignature[] = ML_PLATFORM_ASSET_SEED.map((r) => catalogueRow({ provider: r.provider, kind: r.kind, value: r.value, matchType: r.matchType, provenance: r.provenance }));

describe("ADR-0218 registration and gating", () => {
  it("every wider kind has a scanner in the production registry, needs a credential, and is switched off by default", () => {
    for (const kind of ["saas_inventory_api", "idp_entra", "ml_mlflow"] as const) {
      expect(DISCOVERY_SCANNERS.get(kind)?.requiresCredential).toBe(true);
      expect(familySwitchProblem(kind, { saas: false, identity: false, ml_platform: false })).toMatch(/switched off/);
    }
    expect(familySwitchProblem("idp_entra", { saas: false, identity: true, ml_platform: false })).toBeNull();
    // the ADR-0195 families have no switch
    expect(familySwitchProblem("cloud_aws", { saas: false, identity: false, ml_platform: false })).toBeNull();
  });

  it("public config: a federated token cannot work for the generic APIs; Entra needs tenant and client ids", () => {
    expect(publicConfigProblem("saas_inventory_api", "federated", {})).toMatch(/no external OIDC token/);
    expect(publicConfigProblem("ml_mlflow", "static", { authHeader: "X-Api-Key" })).toBeNull();
    expect(publicConfigProblem("ml_mlflow", "static", { authHeader: "X Api Key: v" })).toMatch(/header_name/);
    expect(publicConfigProblem("saas_inventory_api", "static", { token: "abc" })).toMatch(/not a public config field/);
    expect(publicConfigProblem("idp_entra", "federated", { tenantId: TENANT, clientId: CLIENT })).toBeNull();
    expect(publicConfigProblem("idp_entra", "static", { tenantId: TENANT })).toMatch(/clientId/);
  });

  it("targets: https only, no credentials in the URL or its query, field paths only", () => {
    expect(httpsTargetProblem("http://inv.regulait.example/apps", "url")).toMatch(/https/);
    expect(httpsTargetProblem("https://u:p@inv.regulait.example/apps", "url")).toMatch(/credentials/);
    expect(httpsTargetProblem("https://inv.regulait.example/apps?api_key=x", "url")).toMatch(/api_key/);
    expect(httpsTargetProblem("https://inv.regulait.example/apps?limit=500", "url")).toBeNull();
    const saas = scanner("saas_inventory_api").validateTarget!;
    expect(saas({ url: "https://inv.regulait.example/apps", itemsPath: "data.apps" }, { orgLevel: true, include: [] })).toBeNull();
    expect(saas({ url: "https://inv.regulait.example/apps", itemsPath: "data[0]" }, { orgLevel: true, include: [] })).toMatch(/dotted field path/);
    expect(scanner("idp_entra").validateTarget!({ tenantId: "acme" }, { orgLevel: true, include: [] })).toMatch(/GUID/);
    expect(scanner("ml_mlflow").validateTarget!({ baseUrl: "https://ml.regulait.example?x=1" }, { orgLevel: true, include: [] })).toMatch(/query/);
    // own properties only, never the prototype
    expect(atPath({ a: { b: 1 } }, "a.b")).toBe(1);
    expect(atPath({}, "constructor")).toBeUndefined();
  });
});

describe("ADR-0218 saas_inventory_api", () => {
  const source = {
    id: "s-saas",
    name: "inventory",
    kind: "saas_inventory_api" as const,
    target: { url: "https://inv.regulait.example/v1/apps?limit=2", itemsPath: "data.apps", domainField: "url", usersField: "stats.users", nextField: "links.next" },
    scope: { orgLevel: true, include: [] as string[] },
  };

  it("reads every page on the same origin, sends the token in its header, and observes apps by host", async () => {
    const token = synthetic("tok");
    const seen: Array<{ url: string; auth: string | null }> = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: new Headers(init?.headers).get("x-api-key") });
      if (url.includes("page=2")) {
        // a next link to another origin is never followed
        return json({ data: { apps: [{ name: "Notes", url: "notes.regulait.example" }] }, links: { next: "https://elsewhere.regulait.example/steal" } });
      }
      return json({ data: { apps: [{ name: "Chat assistant", url: "https://chat.ai-vendor.example/login", stats: { users: 42 } }, { name: "No host" }] }, links: { next: "/v1/apps?limit=2&page=2" } });
    }) as typeof fetch;
    const { ctx, calls } = ctxFor({ fetch: f, source, credential: { mode: "static", publicConfig: { authHeader: "X-Api-Key" }, secret: token } });
    const res = await scanner("saas_inventory_api").run(ctx);

    expect(seen.map((s) => s.url)).toEqual(["https://inv.regulait.example/v1/apps?limit=2", "https://inv.regulait.example/v1/apps?limit=2&page=2"]);
    expect(seen.every((s) => s.auth === token)).toBe(true);
    expect(calls.throttle).toBe(2);
    expect(calls.raw.length).toBeGreaterThan(0);
    expect(res.credentialWriteScope).toBe("unverified");
    expect(res.observations).toEqual([
      { evidenceKind: "saas_inventory", subjectKind: "saas_app", subject: "chat.ai-vendor.example", host: "chat.ai-vendor.example", count: 42 },
      { evidenceKind: "saas_inventory", subjectKind: "saas_app", subject: "No host" },
      { evidenceKind: "saas_inventory", subjectKind: "saas_app", subject: "notes.regulait.example", host: "notes.regulait.example" },
    ]);
    expect(checkObservations("saas_inventory_api", res.observations, NOW)).toHaveLength(3);
    // detection is data: the AI app matches an admin hostname row, the notes app does not
    const rows = [catalogueRow({ kind: "hostname", value: "chat.ai-vendor.example", matchType: "exact_host" })];
    const checked = checkObservations("saas_inventory_api", res.observations, NOW);
    expect(checked.map((o) => classifyObservation(o, rows).matched)).toEqual([true, false, false]);
    expect(JSON.stringify(res)).not.toContain(token);
  });

  it("a scope list keeps only the named apps; an unreachable API fails the run with the reason", async () => {
    const f = (async () => json({ data: { apps: [{ name: "A", url: "a.regulait.example" }, { name: "B", url: "b.regulait.example" }] } })) as typeof fetch;
    const scoped = ctxFor({ fetch: f, source: { ...source, scope: { orgLevel: false, include: ["B.regulait.example"] } }, credential: { mode: "static", publicConfig: {}, secret: "t" } });
    expect((await scanner("saas_inventory_api").run(scoped.ctx)).observations.map((o) => o.subject)).toEqual(["b.regulait.example"]);

    const down = (async () => {
      throw Object.assign(new Error("egress blocked (host_not_allowlisted): host not allowed"), { name: "EgressBlockedError" });
    }) as typeof fetch;
    const off = ctxFor({ fetch: down, source, credential: { mode: "static", publicConfig: {}, secret: "t" } });
    await expect(scanner("saas_inventory_api").run(off.ctx)).rejects.toThrow(/nothing could be read: SaaS app inventory unreachable/);
  });

  it("refuses to run without a static token", async () => {
    const { ctx } = ctxFor({ fetch: (async () => json({})) as typeof fetch, source, credential: null });
    await expect(scanner("saas_inventory_api").run(ctx)).rejects.toThrow(/static credential/);
  });
});

describe("ADR-0218 idp_entra", () => {
  const source = { id: "s-entra", name: "entra", kind: "idp_entra" as const, target: { tenantId: TENANT }, scope: { orgLevel: true, include: [] as string[] } };

  function fakeEntra(roles: string[]) {
    const accessToken = jwt({ roles, tid: TENANT });
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
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
      if (url.hostname === "graph.microsoft.com" && url.pathname === "/v1.0/servicePrincipals") {
        if (url.searchParams.get("$skiptoken")) {
          return json({ value: [{ id: "sp-2", appId: OTHER_APP, displayName: "Wiki", homepage: "https://wiki.regulait.example" }] });
        }
        return json({
          value: [{ id: "sp-1", appId: AI_APP, displayName: "AI notetaker", replyUrls: ["https://app.notetaker-ai.example/callback"] }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/servicePrincipals?$skiptoken=2",
        });
      }
      if (url.hostname === "graph.microsoft.com" && url.pathname === "/v1.0/oauth2PermissionGrants") {
        return json({
          value: [
            { clientId: "sp-1", consentType: "Principal", principalId: "user-object-1", scope: "openid User.Read Mail.Read Calendars.Read" },
            { clientId: "sp-2", consentType: "AllPrincipals", principalId: null, scope: "User.Read" },
          ],
        });
      }
      return json({}, 404);
    }) as typeof fetch;
    return { f, accessToken };
  }

  it("joins consents to apps, keeps scope names, pseudonymises the single consenting user, and verifies read-only", async () => {
    const entra = fakeEntra(["Application.Read.All", "DelegatedPermissionGrant.Read.All"]);
    const secret = synthetic("client-secret");
    const { ctx, calls } = ctxFor({ fetch: entra.f, source, credential: { mode: "static", publicConfig: { tenantId: TENANT, clientId: CLIENT }, secret } });
    const res = await scanner("idp_entra").run(ctx);

    expect(res.credentialWriteScope).toBe("read_only");
    expect(res.observations).toEqual([
      {
        evidenceKind: "idp_app_grant",
        subjectKind: "saas_app",
        subject: `AI notetaker (${AI_APP})`,
        artifact: { kind: "oauth_app", value: AI_APP },
        host: "app.notetaker-ai.example",
        count: 1,
        names: ["Calendars.Read", "Mail.Read", "User.Read", "openid"],
        actorPseudonym: expect.stringMatching(/^psn:[0-9a-f]{24}$/),
      },
      { evidenceKind: "idp_app_grant", subjectKind: "saas_app", subject: `Wiki (${OTHER_APP})`, artifact: { kind: "oauth_app", value: OTHER_APP }, host: "wiki.regulait.example", count: 1, names: ["User.Read"] },
    ]);
    expect(calls.pseudonymise).toEqual(["idp_user"]);
    expect(checkObservations("idp_entra", res.observations, NOW)).toHaveLength(2);
    // the access token and the client secret are registered for scrubbing, never digested, never in the result
    expect(calls.secrets).toEqual(expect.arrayContaining([entra.accessToken]));
    expect(calls.raw.join("")).not.toContain(entra.accessToken);
    expect(JSON.stringify(res)).not.toContain("user-object-1");
    expect(JSON.stringify(res)).not.toContain(secret);
    // an admin's application-id row matches by identifier; an AI hostname row matches by host
    const checked = checkObservations("idp_entra", res.observations, NOW);
    expect(classifyObservation(checked[0]!, [catalogueRow({ kind: "oauth_app", value: AI_APP.toUpperCase(), matchType: "identifier" })]).matched).toBe(true);
    expect(classifyObservation(checked[1]!, [catalogueRow({ kind: "oauth_app", value: AI_APP, matchType: "identifier" })]).matched).toBe(false);
  });

  it("a credential holding a write permission is refused before Graph is read", async () => {
    const entra = fakeEntra(["Application.Read.All", "Application.ReadWrite.All"]);
    const { ctx, calls } = ctxFor({ fetch: entra.f, source, credential: { mode: "static", publicConfig: { tenantId: TENANT, clientId: CLIENT }, secret: "s" } });
    const res = await scanner("idp_entra").run(ctx);
    expect(res.credentialWriteScope).toBe("write");
    expect(res.observations).toEqual([]);
    expect(calls.urls.some((u) => new URL(u).hostname === "graph.microsoft.com")).toBe(false);
  });

  it("reads the roles claim only", () => {
    expect(entraWriteScope(jwt({ roles: ["Directory.Read.All", "User.ReadBasic.All"] })).scope).toBe("read_only");
    expect(entraWriteScope(jwt({ roles: ["Directory.ReadWrite.All"] })).scope).toBe("write");
    expect(entraWriteScope(jwt({})).scope).toBe("unverified");
    expect(entraWriteScope("not-a-jwt").scope).toBe("unverified");
  });

  it("a credential for another tenant is refused", async () => {
    const entra = fakeEntra(["Application.Read.All"]);
    const other = "00000000-0000-4000-8000-0000000000ff";
    const { ctx } = ctxFor({ fetch: entra.f, source, credential: { mode: "static", publicConfig: { tenantId: other, clientId: CLIENT }, secret: "s" } });
    await expect(scanner("idp_entra").run(ctx)).rejects.toThrow(/not the source's tenant/);
  });
});

describe("ADR-0218 ml_mlflow", () => {
  const source = { id: "s-ml", name: "ml", kind: "ml_mlflow" as const, target: { baseUrl: "https://ml.regulait.example/" }, scope: { orgLevel: true, include: [] as string[] } };

  it("lists registered models (paged) and serving endpoints; external providers are their own sightings matched by the seed", async () => {
    const f = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/2.0/mlflow/registered-models/search") {
        if (url.searchParams.get("page_token") === "p2") return json({ registered_models: [{ name: "churn" }] });
        return json({ registered_models: [{ name: "fraud-scorer" }], next_page_token: "p2" });
      }
      if (url.pathname === "/api/2.0/serving-endpoints") {
        return json({ endpoints: [{ name: "chat", config: { served_entities: [{ external_model: { provider: "openai", name: "some-model" } }] } }] });
      }
      return json({}, 404);
    }) as typeof fetch;
    const { ctx } = ctxFor({ fetch: f, source, credential: { mode: "static", publicConfig: {}, secret: "t" } });
    const res = await scanner("ml_mlflow").run(ctx);
    expect(res.observations.map((o) => [o.subject, o.artifact?.value])).toEqual([
      ["ml.regulait.example/models/fraud-scorer", "mlflow:registered_model"],
      ["ml.regulait.example/models/churn", "mlflow:registered_model"],
      ["ml.regulait.example/serving-endpoints/chat", "mlflow:serving_endpoint"],
      ["ml.regulait.example/serving-endpoints/chat", "mlflow:external_model:openai"],
    ]);
    const checked = checkObservations("ml_mlflow", res.observations, NOW);
    expect(checked).toHaveLength(4);
    const verdicts = checked.map((o) => classifyObservation(o, SEED_ROWS));
    expect(verdicts.every((v) => v.matched)).toBe(true);
    expect(res.readOutcomes?.find((o) => o.read === "serving endpoints")?.status).toBe("read");
  });

  it("a plain MLflow server without serving endpoints still succeeds and says so", async () => {
    const f = (async (input: string | URL | Request) =>
      new URL(String(input)).pathname.endsWith("/registered-models/search") ? json({}) : json({ error_code: "ENDPOINT_NOT_FOUND" }, 404)) as typeof fetch;
    const { ctx } = ctxFor({ fetch: f, source, credential: { mode: "static", publicConfig: {}, secret: "t" } });
    const res = await scanner("ml_mlflow").run(ctx);
    expect(res.observations).toEqual([]);
    expect(res.readOutcomes?.[0]).toMatchObject({ read: "serving endpoints", status: "not_enabled" });
  });

  it("a denied token fails the run with the reason", async () => {
    const f = (async () => json({ error_code: "PERMISSION_DENIED" }, 403)) as typeof fetch;
    const { ctx } = ctxFor({ fetch: f, source, credential: { mode: "static", publicConfig: {}, secret: "t" } });
    await expect(scanner("ml_mlflow").run(ctx)).rejects.toThrow(/MLflow registered models denied/);
  });
});
