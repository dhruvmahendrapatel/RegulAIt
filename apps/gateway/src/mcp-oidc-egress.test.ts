/**
 * ADR-0043 e2e — `mcp_servers.url` and `oidc_providers.issuerUrl` behind the
 * egress guard, proven by attack.
 *
 * MCP half: a private-address MCP server works with ZERO ceremony under the
 * default posture (real upstream, real proxy, real MCP client through the
 * guarded transport); the org strict toggle refuses the same URL at write time
 * AND at connect time for an existing inherit-posture row; the per-server flag
 * re-opens it; IMDS is refused EVEN WITH allow_private_ranges=true and even
 * with an allow-list entry for the IMDS address itself (the unconditional
 * carve-out); a public-internet MCP URL needs an egress_allow_hosts entry; a
 * row inserted DIRECTLY into Postgres (bypassing the API) is refused at
 * connect time — the guard cannot be dodged by old rows.
 *
 * OIDC half: creating a provider with a non-allow-listed issuer is a 400
 * `egress_blocked`; a pre-existing row inserted directly into Postgres is
 * refused at DISCOVERY time on the login path; an http:// issuer only reaches
 * `allowInsecureRequests` when its host's allow entry set allowPlaintextHttp;
 * with the full opt-ins, discovery really runs through the guarded fetch
 * against a live local IdP; withdrawing the allow entry stops the very next
 * /start. (The full login round-trip through a guarded issuer is auth.test.ts,
 * whose fake IdP now sits behind an explicit allow entry.)
 *
 * REFUSAL-SUITE CONVENTION (ADR-0034): this file's subject is "what is
 * refused", so it starts from an EMPTIED egress_allow_hosts and never inherits
 * a sibling suite's entry.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  auditLog,
  createDb,
  desc,
  egressAllowHosts,
  eq,
  mcpServers,
  mcpTools,
  oidcProviders,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { checkEgress, classifyAddressLan, type EgressResolver } from "./egress-guard.js";
import { encryptSecret } from "./secrets.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "adr43-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let userId: string;
let userAuth: { authorization: string };

// --- a real local MCP upstream (same stateless shape as mcp-proxy.test.ts) ---

async function startUpstream(): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void (async () => {
        const server = new McpServer({ name: "adr43-upstream", version: "0.0.1" });
        server.registerTool(
          "echo",
          { description: "echoes", inputSchema: {}, annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "ok" }] }),
        );
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  if (typeof address !== "object" || !address) throw new Error("no address");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => resolve());
      }),
  };
}

let upstream: Awaited<ReturnType<typeof startUpstream>>;

// --- a minimal fake IdP: discovery document only (enough for /start) --------

const idp = { server: null as Server | null, issuer: "" };
async function startIdp(): Promise<void> {
  idp.server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/.well-known/openid-configuration")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          issuer: idp.issuer,
          authorization_endpoint: `${idp.issuer}/authorize`,
          token_endpoint: `${idp.issuer}/token`,
          jwks_uri: `${idp.issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => idp.server!.listen(0, "127.0.0.1", resolve));
  const addr = idp.server!.address();
  if (addr === null || typeof addr === "string") throw new Error("no idp port");
  idp.issuer = `http://127.0.0.1:${addr.port}`;
}

// --- helpers ----------------------------------------------------------------

const setOrgDefault = async (open: boolean) => {
  const r = await app.inject({
    method: "PUT",
    headers: AUTH,
    url: "/v1/org/settings",
    payload: { mcpPrivateRangesDefault: open },
  });
  expect(r.statusCode).toBe(200);
};

const allowHost = async (
  host: string,
  opts: { allowPrivateRanges?: boolean; allowPlaintextHttp?: boolean } = {},
) => {
  const r = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: { host, ...opts, note: "adr43 suite" },
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
};

const dropAllowHost = async (id: string) => {
  const r = await app.inject({ method: "DELETE", headers: AUTH, url: `/v1/egress-allow-hosts/${id}` });
  expect(r.statusCode).toBe(200);
};

const latestAudit = async (ruleId: string) => {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.at))
    .limit(1);
  return row ?? null;
};

async function mcpClientFor(serverId: string): Promise<Client> {
  const client = new Client({ name: "adr43-client", version: "0.0.1" });
  const transport = new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${serverId}`), {
    requestInit: { headers: userAuth },
  });
  await client.connect(transport);
  return client;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  upstream = await startUpstream();
  await startIdp();
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  // REFUSAL SUITE: start from an emptied allow-list and the shipped default
  // posture — nothing here may be inherited from a sibling suite.
  await db.delete(egressAllowHosts);
  await setOrgDefault(true);

  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email: "adr43@egress-test.example", displayName: "ADR43" },
  });
  userId = user.json().id;
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${userId}/keys`,
    payload: { name: "adr43-key" },
  });
  userAuth = { authorization: `Bearer ${key.json().token}` };
}, 120_000);

afterAll(async () => {
  // leave the shared database in the posture it FOUND (ADR-0181 ships private ranges closed)
  await restoreStrictAdmission?.();
  app.server.closeAllConnections();
  await app.close();
  await upstream.close();
  await new Promise<void>((resolve) => idp.server?.close(() => resolve()) ?? resolve());
});

// ===========================================================================
describe("ADR-0043 — MCP servers behind the egress guard", () => {
  let privateServerId: string;

  it("a private-address MCP server works with ZERO ceremony under the default posture", async () => {
    // no egress_allow_hosts entry exists at all — this must still work
    expect(await db.select().from(egressAllowHosts)).toHaveLength(0);
    const reg = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/servers",
      payload: { name: "adr43-private", url: upstream.url },
    });
    expect(reg.statusCode).toBe(201);
    privateServerId = reg.json().id;
    expect(reg.json().allowPrivateRanges).toBeNull();

    // end to end through the guarded transport: the proxy connects upstream
    // and syncs the manifest (tools/list is entitlement-filtered to [] for an
    // ungranted user, but the sync proves the upstream was really reached)
    const client = await mcpClientFor(privateServerId);
    const { tools } = await client.listTools();
    expect(tools).toEqual([]);
    await client.close();
    const inventory = await db.select().from(mcpTools).where(eq(mcpTools.serverId, privateServerId));
    expect(inventory.map((t) => t.name)).toEqual(["echo"]);
  });

  it("the org strict toggle refuses the same private URL at WRITE time", async () => {
    await setOrgDefault(false);
    const reg = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/servers",
      payload: { name: "adr43-strict-refused", url: upstream.url },
    });
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error).toBe("egress_blocked");
    const audit = await latestAudit("mcp-server-egress-blocked");
    expect(audit).toMatchObject({ effect: "deny" });
    expect((audit!.detail as Record<string, unknown>).phase).toBe("registration");
    await setOrgDefault(true);
  });

  it("the strict toggle refuses an EXISTING inherit-posture server at CONNECT time", async () => {
    await setOrgDefault(false);
    const res = await app.inject({
      method: "POST",
      headers: { ...userAuth, accept: "application/json, text/event-stream" },
      url: `/mcp/${privateServerId}`,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("egress_blocked");
    const audit = await latestAudit("mcp-server-egress-blocked");
    expect((audit!.detail as Record<string, unknown>).phase).toBe("connect");
    // the flag can only have come from the toggle: the row itself is null
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, privateServerId));
    expect(row!.allowPrivateRanges).toBeNull();
  });

  it("the explicit per-server flag re-opens it under strict (PATCH, write-time checked)", async () => {
    const patch = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/servers/${privateServerId}`,
      payload: { allowPrivateRanges: true },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().allowPrivateRanges).toBe(true);

    const client = await mcpClientFor(privateServerId);
    await expect(client.listTools()).resolves.toBeTruthy();
    await client.close();

    // and PATCHing the flag BACK OFF under strict is refused at write time —
    // the write-time check runs against the NEXT posture
    const closing = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/servers/${privateServerId}`,
      payload: { allowPrivateRanges: false },
    });
    expect(closing.statusCode).toBe(400);
    expect(closing.json().error).toBe("egress_blocked");

    await setOrgDefault(true);
  });

  it("IMDS is refused at write time EVEN WITH allow_private_ranges=true", async () => {
    const reg = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/servers",
      payload: {
        name: "adr43-imds",
        url: "http://169.254.169.254/latest/meta-data/",
        allowPrivateRanges: true,
      },
    });
    expect(reg.statusCode).toBe(400);
    expect(reg.json().error).toBe("egress_blocked");
    expect(reg.json().code).toBe("blocked_address_range");
    expect(reg.json().detail).toContain("never reachable");
  });

  it("a pre-existing IMDS row (inserted directly into Postgres) is refused at connect — even with the flag AND an allow entry for the IMDS address itself", async () => {
    const [row] = await db
      .insert(mcpServers)
      .values({
        name: "adr43-imds-preexisting",
        url: "http://169.254.169.254/mcp",
        allowPrivateRanges: true,
      })
      .returning();
    // belt AND braces for the attacker: the IMDS address is even allow-listed
    // with both opt-ins — the unconditional carve-out is what must refuse it
    const hostId = await allowHost("169.254.169.254", {
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
    });

    try {
      const res = await app.inject({
        method: "POST",
        headers: { ...userAuth, accept: "application/json, text/event-stream" },
        url: `/mcp/${row!.id}`,
        payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
      expect(res.json().code).toBe("blocked_address_range");
      const audit = await latestAudit("mcp-server-egress-blocked");
      expect((audit!.detail as Record<string, unknown>).phase).toBe("connect");
      // the row is refused, never rewritten
      const [after] = await db.select().from(mcpServers).where(eq(mcpServers.id, row!.id));
      expect(after!.url).toBe("http://169.254.169.254/mcp");
    } finally {
      await dropAllowHost(hostId);
    }
  });

  it("a public-internet MCP URL is refused without an allow entry and accepted with one", async () => {
    const refused = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/servers",
      payload: { name: "adr43-public", url: "https://198.51.100.7/mcp" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe("egress_blocked");
    expect(refused.json().code).toBe("host_not_allowlisted");

    const hostId = await allowHost("198.51.100.7");
    const accepted = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/servers",
      payload: { name: "adr43-public", url: "https://198.51.100.7/mcp" },
    });
    expect(accepted.statusCode).toBe(201);
    await dropAllowHost(hostId);
  });

  it("plaintext http to a PUBLIC host needs the allow entry's plaintext opt-in even on the MCP path", async () => {
    const hostId = await allowHost("198.51.100.8"); // no plaintext opt-in
    const refused = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/servers",
      payload: { name: "adr43-public-http", url: "http://198.51.100.8/mcp" },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().code).toBe("plaintext_http_forbidden");
    await dropAllowHost(hostId);
  });
});

// ===========================================================================
describe("ADR-0043 — the private-LAN-aware guard itself (hostnames, split DNS, v6)", () => {
  const resolverFor =
    (answers: Record<string, string[]>): EgressResolver =>
    async (host) => {
      const a = answers[host];
      if (!a) throw new Error(`no stub answer for ${host}`);
      return a.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
    };

  it("a hostname resolving to private LAN is open under the flag, plaintext included", async () => {
    const d = await checkEgress("http://mcp.internal:9000/", {
      allowList: [],
      privateLan: { openByDefault: true },
      resolve: resolverFor({ "mcp.internal": ["10.0.0.5"] }),
    });
    expect(d.ok).toBe(true);
  });

  it("the same hostname is refused under strict, and an allow entry with allowPrivateRanges re-opens it", async () => {
    const strict = await checkEgress("http://mcp.internal:9000/", {
      allowList: [],
      privateLan: { openByDefault: false },
      resolve: resolverFor({ "mcp.internal": ["10.0.0.5"] }),
    });
    expect(strict.ok).toBe(false);
    if (!strict.ok) expect(strict.code).toBe("host_not_allowlisted");

    const withEntry = await checkEgress("http://mcp.internal:9000/", {
      allowList: [{ host: "mcp.internal", allowPrivateRanges: true, allowPlaintextHttp: true }],
      privateLan: { openByDefault: false },
      resolve: resolverFor({ "mcp.internal": ["10.0.0.5"] }),
    });
    expect(withEntry.ok).toBe(true);
  });

  it("a hostname that RESOLVES to IMDS is refused even under the open flag (and split DNS does not launder it)", async () => {
    const direct = await checkEgress("http://metadata.evil.example/", {
      allowList: [],
      privateLan: { openByDefault: true },
      resolve: resolverFor({ "metadata.evil.example": ["169.254.169.254"] }),
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.code).toBe("blocked_address_range");

    const split = await checkEgress("http://metadata.evil.example/", {
      allowList: [],
      privateLan: { openByDefault: true },
      resolve: resolverFor({ "metadata.evil.example": ["10.0.0.5", "169.254.169.254"] }),
    });
    expect(split.ok).toBe(false);
    if (!split.ok) expect(split.code).toBe("blocked_address_range");
  });

  it("split DNS with a public answer is NOT zero-ceremony — the host must be allow-listed", async () => {
    const d = await checkEgress("https://half.inside.example/", {
      allowList: [],
      privateLan: { openByDefault: true },
      resolve: resolverFor({ "half.inside.example": ["10.0.0.5", "203.0.113.7"] }),
    });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.code).toBe("host_not_allowlisted");
  });

  it("the IPv6 carve-outs hold: mapped IMDS, v6 link-local and AWS fd00:ec2::/32 are never-openable; ordinary ULA is private LAN", () => {
    expect(classifyAddressLan("::ffff:169.254.169.254").never).toContain("IMDS");
    expect(classifyAddressLan("fe80::1").never).toContain("link-local");
    expect(classifyAddressLan("fd00:ec2::254").never).toContain("IMDS");
    expect(classifyAddressLan("fd12::1")).toEqual({ never: null, privateLan: true });
    expect(classifyAddressLan("::1")).toEqual({ never: null, privateLan: true });
    expect(classifyAddressLan("10.1.2.3")).toEqual({ never: null, privateLan: true });
    expect(classifyAddressLan("100.64.0.1").never).toContain("CGNAT");
    expect(classifyAddressLan("203.0.113.7")).toEqual({ never: null, privateLan: false });
  });

  it("the classic (non-MCP) posture is untouched: an allow entry with allowPrivateRanges still opens link-local there", async () => {
    // this is the PRE-EXISTING behaviour of every other surface, pinned here
    // so ADR-0043's privateLanOnly narrowing provably did not change it
    const d = await checkEgress("http://169.254.169.254/", {
      allowList: [
        { host: "169.254.169.254", allowPrivateRanges: true, allowPlaintextHttp: true },
      ],
    });
    expect(d.ok).toBe(true);
  });
});

// ===========================================================================
describe("ADR-0043 — OIDC issuers behind the egress guard", () => {
  it("creating a provider with a non-allow-listed issuer is a 400 egress_blocked, audited, nothing stored", async () => {
    const r = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/auth/oidc-providers",
      payload: {
        name: "adr43-refused",
        issuerUrl: idp.issuer,
        clientId: "c",
        clientSecret: "s",
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("egress_blocked");
    const rows = await db.select().from(oidcProviders).where(eq(oidcProviders.name, "adr43-refused"));
    expect(rows).toHaveLength(0);
    const audit = await latestAudit("oidc-egress-blocked");
    expect(audit).toMatchObject({ effect: "deny" });
  });

  it("an http:// issuer allow-listed WITHOUT the plaintext opt-in is still refused — allowInsecureRequests is gated on allowPlaintextHttp", async () => {
    const hostId = await allowHost("127.0.0.1", { allowPrivateRanges: true });
    const r = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/auth/oidc-providers",
      payload: {
        name: "adr43-no-plaintext",
        issuerUrl: idp.issuer,
        clientId: "c",
        clientSecret: "s",
      },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().code).toBe("plaintext_http_forbidden");
    await dropAllowHost(hostId);
  });

  it("with the full per-host opt-ins, registration passes and /start performs REAL discovery through the guarded fetch; withdrawing the entry stops the next /start", async () => {
    const hostId = await allowHost("127.0.0.1", {
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
    });
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/auth/oidc-providers",
      payload: {
        name: "adr43-live",
        issuerUrl: idp.issuer,
        clientId: "adr43-client",
        clientSecret: "adr43-secret",
      },
    });
    expect(created.statusCode).toBe(201);
    const providerId = created.json().id;

    const start = await app.inject({ method: "GET", url: `/auth/oidc/${providerId}/start` });
    expect(start.statusCode).toBe(302);
    expect(start.headers.location).toContain(`${idp.issuer}/authorize`);

    // DISCOVERY-TIME re-validation: the allow entry is withdrawn, the very
    // next /start refuses with nothing leaving the box — a stored provider is
    // not a standing permission
    await dropAllowHost(hostId);
    const refused = await app.inject({ method: "GET", url: `/auth/oidc/${providerId}/start` });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("egress_blocked");
    const audit = await latestAudit("oidc-egress-blocked");
    expect((audit!.detail as Record<string, unknown>).phase).toBe("oidc-discovery");

    // clean up: disable so the login screen of other suites never lists it
    await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/auth/oidc-providers/${providerId}`,
      payload: { enabled: false },
    });
  });

  it("a pre-existing row inserted DIRECTLY into Postgres is refused at discovery time on the login path", async () => {
    const [row] = await db
      .insert(oidcProviders)
      .values({
        name: "adr43-preexisting",
        issuerUrl: "http://169.254.169.254/",
        clientId: "c",
        clientSecretCiphertext: encryptSecret(DATA_KEY, "s"),
        enabled: true,
      })
      .returning();
    const start = await app.inject({ method: "GET", url: `/auth/oidc/${row!.id}/start` });
    expect(start.statusCode).toBe(403);
    expect(start.json().error).toBe("egress_blocked");
    // refused, never rewritten
    const [after] = await db.select().from(oidcProviders).where(eq(oidcProviders.id, row!.id));
    expect(after!.issuerUrl).toBe("http://169.254.169.254/");
    await db.update(oidcProviders).set({ enabled: false }).where(eq(oidcProviders.id, row!.id));
  });

  it("PATCHing an issuer to a blocked destination is a 400 egress_blocked", async () => {
    const hostId = await allowHost("127.0.0.1", {
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
    });
    const created = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/auth/oidc-providers",
      payload: {
        name: "adr43-move",
        issuerUrl: idp.issuer,
        clientId: "c",
        clientSecret: "s",
        enabled: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const moved = await app.inject({
      method: "PATCH",
      headers: AUTH,
      url: `/v1/auth/oidc-providers/${created.json().id}`,
      payload: { issuerUrl: "http://169.254.169.254/" },
    });
    expect(moved.statusCode).toBe(400);
    expect(moved.json().error).toBe("egress_blocked");
    // the stored issuer is unchanged
    const [after] = await db
      .select()
      .from(oidcProviders)
      .where(eq(oidcProviders.id, created.json().id));
    expect(after!.issuerUrl).toBe(idp.issuer);
    await dropAllowHost(hostId);
  });

  it("(hygiene) the org toggle is back at this file's open baseline (afterAll then restores what it found)", async () => {
    const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(org!.mcpPrivateRangesDefault).toBe(true);
  });
});
