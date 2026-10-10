/**
 * ADR-0186 V, decision 32 — OUTBOUND CREDENTIAL AUDIENCE, on the real app and
 * a real database, at both dispatch points (the MCP proxy — tool and protocol
 * calls — and the connector call).
 *
 * The owner's decision (2026-10-10): a `pipelock-secrets` credential in the
 * CALLER's own content, bound for a host outside that credential's audience,
 * is refused (403 `credential_audience_violation`) and audited by rule id and
 * match count only. Credentials the gateway injects itself are never scanned.
 * The setting `outboundCredentialAudience` is `enforce` by default; `off`
 * needs a `settings_relax` step-up and is audited.
 *
 * Every credential below is synthetic (a fixed prefix and a repeated letter).
 * The upstreams are real loopback receivers that record what reached them, so
 * "refused" is proved as "the receiver saw nothing", not "the call errored".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  and,
  auditLog,
  authSessions,
  connectorCredentials,
  connectors,
  createDb,
  desc,
  egressAllowHosts,
  eq,
  gt,
  inArray,
  mcpServers,
  mcpTools,
  ORG_SETTINGS_ID,
  orgSettings,
  runMigrations,
  sql,
  stepUpGrants,
  users as usersTable,
  webauthnChallenges,
  webauthnCredentials,
  type Db,
} from "@regulait/db";
import { STEP_UP_HEADER, vendoredSecretSpans } from "@regulait/shared";
import { buildApp } from "./app.js";
import { encryptSecret } from "./secrets.js";
import { audienceViolations, callerSuppliedText, CREDENTIAL_AUDIENCE_RULE_ID } from "./outbound-audience.js";
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { forgetStepUpMethodsForTest } from "./testing/step-up-posture.js";
import { SoftAuthenticator } from "./webauthn-soft-authenticator.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
const BOOT = `b4o-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "b".repeat(64);
const PUBLIC_URL = "http://localhost";
const CSRF = { "x-regulait-csrf": "1" };

/** synthetic GitHub token: the pack names no host it may go to */
const GH_TOKEN = `ghp_${"Q".repeat(36)}`;
/** synthetic Fireworks key: its audience is *.fireworks.ai over https */
const FW_KEY = `fw_${"Z".repeat(22)}`;
const GH_RULE = "pipelock.secrets.github_token";
const FW_RULE = "pipelock.secrets.fireworks_api_key";

let db: Db;
let app: ReturnType<typeof buildApp>;
let gatewayUrl: string;
let restoreAdmission: (() => Promise<void>) | undefined;
let restoreGates: () => Promise<void> = async () => {};
let restorePosture: (() => Promise<void>) | undefined;
let restoreIdentity: (() => Promise<void>) | undefined;
let priorMethods: string[] = [];
let allowHostId: string | null = null;
const prevPublicUrl = process.env.REGULAIT_PUBLIC_URL;
const created = { users: [] as string[], servers: [] as string[], connectors: [] as string[], sessions: [] as string[] };

// --- a real MCP upstream that records every tool call and prompt it served ---
const upstreamSeen: string[] = [];
let upstreamHttp: http.Server;
let upstreamUrl: string;
function buildUpstream(): McpServer {
  const server = new McpServer({ name: "b4o-upstream", version: "0.0.1" });
  server.registerTool("send", { description: "sends", inputSchema: { body: z.unknown() } }, async (a) => {
    upstreamSeen.push(`tools/call:${JSON.stringify(a)}`);
    return { content: [{ type: "text", text: "sent" }] };
  });
  server.registerPrompt("greet", { description: "greets", argsSchema: { who: z.string() } }, async ({ who }) => {
    upstreamSeen.push(`prompts/get:${who}`);
    return { messages: [{ role: "user", content: { type: "text", text: "hello" } }] };
  });
  return server;
}

// --- a real webhook receiver ---
let collector: http.Server;
let collectorPort: number;
const collectorHits: Array<{ body: string; auth: string | null }> = [];

let userId: string;
let userKey: { authorization: string };
let serverId: string;
let serverWithKeyId: string;
let fwServerId: string;
let webhookId: string;
let injectedId: string;
let fwConnectorId: string;

async function newUser(label: string): Promise<string> {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `b4o-${label}-${RUN}@example.com`, displayName: `b4o ${label}` } });
  expect(r.statusCode, r.body).toBe(201);
  created.users.push(r.json().id);
  return r.json().id as string;
}
async function keyFor(id: string) {
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${id}/keys`, payload: { name: "b4o" } });
  expect(k.statusCode, k.body).toBe(201);
  return { authorization: `Bearer ${k.json().token}` };
}
async function grantTool(sid: string, toolName: string) {
  const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/tools", payload: { userId, serverId: sid, toolName } });
  expect(r.statusCode, r.body).toBe(201);
}
async function mcpClient(sid: string): Promise<Client> {
  const client = new Client({ name: "b4o-client", version: "0.0.1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gatewayUrl}/mcp/${sid}`), { requestInit: { headers: userKey } }));
  return client;
}
/** a server row as an operator registered it before the write-time egress check (no DNS in this suite) */
async function insertServer(name: string, url: string): Promise<string> {
  const [row] = await db.insert(mcpServers).values({ name: `${name}-${RUN}`, url }).returning({ id: mcpServers.id });
  created.servers.push(row!.id);
  return row!.id;
}
async function insertConnector(name: string, baseUrl: string | null): Promise<string> {
  const [row] = await db
    .insert(connectors)
    .values({ name: `${name}-${RUN}`, kind: "notifications", providerKind: "webhook", baseUrl })
    .returning({ id: connectors.id });
  created.connectors.push(row!.id);
  const g = await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/connectors", payload: { userId, connectorId: row!.id, mode: "readwrite" } });
  expect(g.statusCode, g.body).toBe(201);
  return row!.id;
}
const invoke = (connectorId: string, object: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", headers: userKey, url: `/v1/connectors/${connectorId}/invoke`, payload: { operation: "write", object, payload } });

/** the ledger's high-water mark (rows after it were written by what follows) */
async function mark(): Promise<number> {
  const [row] = await db.select({ m: sql<string | null>`max(${auditLog.seq})` }).from(auditLog);
  return Number(row?.m ?? 0);
}
/** this suite's audience rows since `since` */
async function audienceRows(since: number) {
  return db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.ruleId, CREDENTIAL_AUDIENCE_RULE_ID), eq(auditLog.userId, userId), gt(auditLog.seq, since)))
    .orderBy(desc(auditLog.seq));
}
/** every audit row this user produced since `since` (to prove no secret, fragment or hash anywhere) */
async function userRows(since: number) {
  return db.select().from(auditLog).where(and(eq(auditLog.userId, userId), gt(auditLog.seq, since)));
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function expectNoSecret(rows: unknown[], secret: string) {
  const text = JSON.stringify(rows);
  expect(text).not.toContain(secret);
  // no fragment: the distinctive run of the synthetic body, nor its prefix plus a few characters
  expect(text).not.toContain(secret.slice(4, 16));
  expect(text).not.toContain(secret.slice(0, 8));
  expect(text).not.toContain(sha(secret));
}
async function setAudience(mode: "enforce" | "off") {
  await db.update(orgSettings).set({ outboundCredentialAudience: mode }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
}

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdmission = await relaxStrictAdmissionForTest(db);
  restoreGates = await relaxGovernanceGatesForTest(db, {
    mrmEnforced: false,
    dispatchAttributionRequired: false,
    requireMcpAttribution: false,
    keyCustodyEnforced: false,
  });
  // the PII floor and guardrail defaults are not under test here
  restorePosture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: false });
  restoreIdentity = await relaxIdentityForTest(db, { mfaRequired: "off" });
  const [org] = await db.select().from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorMethods = (org?.mcpProtocolMethods ?? []) as string[];
  await db
    .update(orgSettings)
    .set({ mcpProtocolMethods: [...new Set([...priorMethods, "prompts/list", "prompts/get"])] as never })
    .where(eq(orgSettings.id, ORG_SETTINGS_ID));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  gatewayUrl = await app.listen({ port: 0, host: "127.0.0.1" });

  upstreamHttp = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        const server = buildUpstream();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await server.connect(transport);
        await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
  await new Promise<void>((r) => upstreamHttp.listen(0, "127.0.0.1", r));
  upstreamUrl = `http://127.0.0.1:${(upstreamHttp.address() as { port: number }).port}/`;

  collector = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      collectorHits.push({ body: raw, auth: (req.headers.authorization as string) ?? null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ received: true }));
    });
  });
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  collectorPort = (collector.address() as { port: number }).port;

  const allow = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/egress-allow-hosts",
    payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "b4o suite: loopback upstreams" },
  });
  expect([201, 409]).toContain(allow.statusCode);
  if (allow.statusCode === 201) allowHostId = allow.json().id as string;

  userId = await newUser("caller");
  userKey = await keyFor(userId);
  serverId = await insertServer("b4o-loopback", upstreamUrl);
  // the operator's own upstream credential rides the registered URL: admin configuration, never scanned
  serverWithKeyId = await insertServer("b4o-loopback-keyed", `${upstreamUrl}?key=${GH_TOKEN}`);
  // a host in the Fireworks key's audience (unreachable here: the egress guard refuses it after this check)
  fwServerId = await insertServer("b4o-fireworks", "https://api.fireworks.ai/mcp");
  // its manifest as a past sync stored it, so a call reaches governance without a pre-decision connect
  await db.insert(mcpTools).values({ serverId: fwServerId, name: "send", kind: "write", inputSchema: { type: "object" } });
  for (const sid of [serverId, serverWithKeyId, fwServerId]) await grantTool(sid, "send");
  await grantTool(serverId, "mcp:prompts");

  webhookId = await insertConnector("b4o-webhook", `http://127.0.0.1:${collectorPort}/collect`);
  injectedId = await insertConnector("b4o-webhook-injected", null);
  // the gateway injects this one itself (a bearer header): it is a GitHub token bound for a loopback host
  await db.insert(connectorCredentials).values({
    connectorId: injectedId,
    tokenCiphertext: encryptSecret(DATA_KEY, GH_TOKEN),
    baseUrl: `http://127.0.0.1:${collectorPort}/injected`,
  });
  fwConnectorId = await insertConnector("b4o-webhook-fireworks", "https://api.fireworks.ai/v1/hook");
}, 120_000);

afterAll(async () => {
  try {
    await setAudience("enforce");
    await db.update(orgSettings).set({ mcpProtocolMethods: priorMethods as never }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    await forgetStepUpMethodsForTest(db, created.users);
    if (created.users.length) {
      await db.delete(stepUpGrants).where(inArray(stepUpGrants.userId, created.users));
      await db.delete(webauthnChallenges).where(inArray(webauthnChallenges.userId, created.users));
      await db.delete(webauthnCredentials).where(inArray(webauthnCredentials.userId, created.users));
    }
    if (created.sessions.length) await db.delete(authSessions).where(inArray(authSessions.id, created.sessions));
    if (allowHostId) await db.delete(egressAllowHosts).where(eq(egressAllowHosts.id, allowHostId));
    // this file's upstreams close below: their rows must not outlive it (a health sweep would probe dead ports)
    if (created.servers.length) await db.delete(mcpServers).where(inArray(mcpServers.id, created.servers));
    if (created.connectors.length) await db.delete(connectors).where(inArray(connectors.id, created.connectors));
    await restoreIdentity?.();
    await restorePosture?.();
    await restoreGates();
    await restoreAdmission?.();
  } finally {
    if (prevPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
    else process.env.REGULAIT_PUBLIC_URL = prevPublicUrl;
    app?.server.closeAllConnections();
    await app?.close();
    upstreamHttp?.closeAllConnections();
    collector?.closeAllConnections();
    await new Promise<void>((r) => (upstreamHttp ? upstreamHttp.close(() => r()) : r()));
    await new Promise<void>((r) => (collector ? collector.close(() => r()) : r()));
  }
});

describe("decision 32: the scan input and the matcher (pure)", () => {
  it("decodes caller content recursively: nested values, object keys and percent-escapes", () => {
    const text = callerSuppliedText({ a: [{ deep: { [GH_TOKEN]: 1 } }], q: `token%3D${encodeURIComponent(GH_TOKEN)}`, n: 5, b: true });
    expect(text).toContain(GH_TOKEN);
    expect(audienceViolations(callerSuppliedText({ q: `x=${GH_TOKEN.replace("ghp_", "ghp%5F")}` }), ["http://127.0.0.1/"])).toEqual([
      { rule: GH_RULE, count: 1 },
    ]);
  });

  it("a credential is permitted only where its audience names the host, over https; [] = nothing leaves; null = no exemption", () => {
    expect(audienceViolations(FW_KEY, ["https://api.fireworks.ai/inference"])).toEqual([]);
    expect(audienceViolations(FW_KEY, ["http://api.fireworks.ai/"])).toEqual([{ rule: FW_RULE, count: 1 }]);
    expect(audienceViolations(FW_KEY, ["https://fireworks.ai.evil.test/"])).toEqual([{ rule: FW_RULE, count: 1 }]);
    // several destinations: permitted only if every one is in the audience
    expect(audienceViolations(FW_KEY, ["https://api.fireworks.ai/", "https://login.example.test/"])).toEqual([{ rule: FW_RULE, count: 1 }]);
    expect(audienceViolations(GH_TOKEN, [])).toEqual([]);
    expect(audienceViolations(FW_KEY, null)).toEqual([{ rule: FW_RULE, count: 1 }]);
    expect(audienceViolations(FW_KEY, ["not a url"])).toEqual([{ rule: FW_RULE, count: 1 }]);
    // personal data is not a credential: the pack's SSN shape is left to the §8.4 piiMode cascade
    expect(audienceViolations("ssn 078-05-1120", ["http://127.0.0.1/"])).toEqual([]);
    expect(audienceViolations(`ssn 078-05-1120 ${GH_TOKEN}`, ["http://127.0.0.1/"])).toEqual([{ rule: GH_RULE, count: 1 }]);
    // the pack off: nothing to match (the detection-content route then reports enforcement off)
    expect(audienceViolations(GH_TOKEN, ["http://127.0.0.1/"], [])).toEqual([]);
  });

  it("gate-dense content is one linear pass of the pack matcher (B4I-02), no dearer than the DLP scan of the same text", () => {
    const gates = " sk-ant- sk-proj- fw_ ghp_ glpat- xoxb- AIza tvly- pplx- sk-or-v1- ";
    const textOf = (n: number) => callerSuppliedText({ items: Array.from({ length: n }, (_, i) => ({ [`k${i}`]: gates })) });
    const best = (f: () => void) => {
      let min = Infinity;
      for (let i = 0; i < 3; i++) {
        const t = performance.now();
        f();
        min = Math.min(min, performance.now() - t);
      }
      return min;
    };
    const small = textOf(1500);
    const large = textOf(6000);
    expect(large.length).toBeGreaterThan(400_000);
    best(() => audienceViolations(small, ["http://127.0.0.1/"])); // warm the compiled matchers
    const tSmall = best(() => expect(audienceViolations(small, ["http://127.0.0.1/"])).toEqual([]));
    const tLarge = best(() => expect(audienceViolations(large, ["http://127.0.0.1/"])).toEqual([]));
    const tDlp = best(() => vendoredSecretSpans(large));
    // four times the input costs about four times as much (linear, not quadratic), with slack for timer noise
    expect(tLarge / Math.max(tSmall, 1)).toBeLessThan(8);
    // the same order as the matcher the input DLP guardrail already runs on every call's arguments
    expect(tLarge).toBeLessThan(Math.max(3 * tDlp, 50));
  }, 30_000);
});

describe("decision 32: the setting is strict by default and reported truthfully", () => {
  it("a migrated org reads `enforce` (column default and stored row); the detection-content route reports enforcement", async () => {
    const res = await db.execute(sql`select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'org_settings' and column_name = 'outbound_credential_audience'`);
    const rows = (res as unknown as { rows?: Array<{ column_default: string }> }).rows ?? (res as unknown as Array<{ column_default: string }>);
    expect(rows[0]?.column_default).toBe("'enforce'::text");
    const g = await app.inject({ method: "GET", url: "/v1/org/settings", headers: AUTH });
    expect(g.statusCode, g.body).toBe(200);
    expect(g.json().settings.outboundCredentialAudience).toBe("enforce");
    const d = await app.inject({ method: "GET", url: "/v1/detection-content", headers: AUTH });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().outboundAudienceEnforced).toBe(true);
    expect(d.json().outboundCredentialAudience).toBe("enforce");
  });
});

describe("decision 32: MCP proxy dispatch", () => {
  it("a GitHub token in tool arguments to a non-matching host is refused (credential_audience_violation); nothing reaches the upstream; audited with no secret", async () => {
    const since = await mark();
    const client = await mcpClient(serverId);
    try {
      const before = upstreamSeen.filter((s) => s.startsWith("tools/call")).length;
      let caught: unknown;
      try {
        await client.callTool({ name: "send", arguments: { body: { headers: { Authorization: `token ${GH_TOKEN}` }, note: "hi" } } });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(McpError);
      expect((caught as McpError).message).toContain("credential_audience_violation");
      expect((caught as McpError).data).toEqual({ error: "credential_audience_violation", status: 403 });
      expect(upstreamSeen.filter((s) => s.startsWith("tools/call")).length).toBe(before);
      const rows = await audienceRows(since);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.effect).toBe("deny");
      expect(row.serverId).toBe(serverId);
      expect(row.toolName).toBe("send");
      const detail = row.detail as { violations: unknown; surface: string; destinationHosts: unknown };
      expect(detail.violations).toEqual([{ rule: GH_RULE, count: 1 }]);
      expect(detail.surface).toBe("mcp_tool");
      expect(detail.destinationHosts).toEqual([new URL(upstreamUrl).host]);
      // the refused call wrote no decision row with an arguments digest: nothing about the payload but rule and count
      const all = await userRows(since);
      expect(all.filter((r) => (r.detail as { argumentsDigest?: string } | null)?.argumentsDigest)).toEqual([]);
      expectNoSecret(all, GH_TOKEN);
    } finally {
      await client.close();
    }
  });

  it("the same refusal on an MCP protocol call (prompts/get arguments)", async () => {
    const since = await mark();
    const client = await mcpClient(serverId);
    try {
      const before = upstreamSeen.filter((s) => s.startsWith("prompts/get")).length;
      await expect(client.getPrompt({ name: "greet", arguments: { who: GH_TOKEN } })).rejects.toThrow(/credential_audience_violation/);
      expect(upstreamSeen.filter((s) => s.startsWith("prompts/get")).length).toBe(before);
      const rows = await audienceRows(since);
      expect(rows).toHaveLength(1);
      expect((rows[0]!.detail as { surface: string }).surface).toBe("mcp_protocol");
      expectNoSecret(await userRows(since), GH_TOKEN);
      // a clean prompt still runs
      await client.getPrompt({ name: "greet", arguments: { who: "world" } });
      expect(upstreamSeen.at(-1)).toBe("prompts/get:world");
    } finally {
      await client.close();
    }
  });

  it("a key bound for its own audience host passes this check (it then meets the egress guard, which runs after it)", async () => {
    const since = await mark();
    const client = await mcpClient(fwServerId);
    try {
      await expect(client.callTool({ name: "send", arguments: { body: FW_KEY } })).rejects.toThrow();
      expect(await audienceRows(since)).toHaveLength(0);
      // the egress refusal is what stopped it, and it is written after this check
      const [egress] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.serverId, fwServerId), gt(auditLog.seq, since)))
        .orderBy(desc(auditLog.seq))
        .limit(1);
      expect(egress?.ruleId).not.toBe(CREDENTIAL_AUDIENCE_RULE_ID);
      expect(egress?.effect).toBe("deny");
      // the control: the same server, a credential outside its audience, IS refused by this check
      const since2 = await mark();
      await expect(client.callTool({ name: "send", arguments: { body: GH_TOKEN } })).rejects.toThrow(/credential_audience_violation/);
      expect(await audienceRows(since2)).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  it("the operator's credential in the registered upstream URL is not scanned: a clean call runs", async () => {
    const since = await mark();
    const client = await mcpClient(serverWithKeyId);
    try {
      const out = await client.callTool({ name: "send", arguments: { body: "clean" } });
      expect(JSON.stringify(out.content)).toContain("sent");
      expect(await audienceRows(since)).toHaveLength(0);
    } finally {
      await client.close();
    }
  });
});

describe("decision 32: connector-call dispatch", () => {
  it("a GitHub token in the caller's payload to a non-matching host: 403 credential_audience_violation, the receiver sees nothing, audited with no secret", async () => {
    const since = await mark();
    const hits = collectorHits.length;
    const r = await invoke(webhookId, "events", { nested: [{ token: GH_TOKEN }] });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("credential_audience_violation");
    expect(r.json().violations).toEqual([{ rule: GH_RULE, count: 1 }]);
    expect(r.body).not.toContain(GH_TOKEN);
    expect(collectorHits.length).toBe(hits);
    const rows = await audienceRows(since);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.objectType).toBe("connector");
    expect(rows[0]!.objectId).toBe(webhookId);
    expect((rows[0]!.detail as { surface: string }).surface).toBe("connector");
    expectNoSecret(await userRows(since), GH_TOKEN);
  });

  it("the caller-controlled `object` (a path/URL surface) is scanned too", async () => {
    const hits = collectorHits.length;
    const r = await invoke(webhookId, `repos?access_token=${GH_TOKEN}`, { note: "x" });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("credential_audience_violation");
    expect(collectorHits.length).toBe(hits);
  });

  it("a key bound for its own audience host passes this check (the egress guard after it refuses the unreachable host)", async () => {
    const since = await mark();
    const r = await invoke(fwConnectorId, "events", { key: FW_KEY });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error).toBe("egress_blocked");
    expect(await audienceRows(since)).toHaveLength(0);
    // control: the same connector, a credential outside the audience
    const g = await invoke(fwConnectorId, "events", { key: GH_TOKEN });
    expect(g.json().error).toBe("credential_audience_violation");
  });

  it("the gateway-injected connector credential (a GitHub token, to a loopback host) is not refused; it is sent as configured", async () => {
    const since = await mark();
    const hits = collectorHits.length;
    const r = await invoke(injectedId, "events", { note: "clean payload" });
    expect(r.statusCode, r.body).toBe(200);
    expect(collectorHits.length).toBe(hits + 1);
    expect(collectorHits.at(-1)!.auth).toBe(`Bearer ${GH_TOKEN}`);
    expect(await audienceRows(since)).toHaveLength(0);
  });

  it("a clean payload to the same host is delivered", async () => {
    const hits = collectorHits.length;
    const r = await invoke(webhookId, "events", { note: "legitimate" });
    expect(r.statusCode, r.body).toBe(200);
    expect(collectorHits.length).toBe(hits + 1);
  });
});

describe("decision 32: relaxing to `off` needs a settings_relax step-up, is audited, and then allows", () => {
  it("off without a step-up is refused; with one it is saved and audited as relaxed; both dispatch paths then let the call through", async () => {
    // a session admin with a passkey (the bootstrap credential is not a person)
    const adminId = await newUser("admin");
    await db.update(usersTable).set({ isAdmin: true }).where(eq(usersTable.id, adminId));
    const token = "rgls_" + randomBytes(32).toString("hex");
    const [s] = await db
      .insert(authSessions)
      .values({
        tokenHash: createHash("sha256").update(token).digest("hex"),
        userId: adminId,
        origin: "password",
        expiresAt: new Date(Date.now() + 3_600_000),
        idleExpiresAt: new Date(Date.now() + 3_600_000),
        idleMinutes: 60,
      })
      .returning({ id: authSessions.id });
    created.sessions.push(s!.id);
    const as = (method: "POST" | "PUT", url: string, payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { ...CSRF, ...headers }, cookies: { regulait_session: token }, payload: payload as object });
    const opt = await as("POST", "/v1/auth/passkeys/registration-options", {});
    expect(opt.statusCode, opt.body).toBe(200);
    const authr = new SoftAuthenticator({ origin: PUBLIC_URL });
    const reg = await as("POST", "/v1/auth/passkeys", { challengeId: opt.json().challengeId, response: authr.register(opt.json().options), label: "b4o" });
    expect(reg.statusCode, reg.body).toBe(201);

    try {
      const refused = await as("PUT", "/v1/org/settings", { outboundCredentialAudience: "off" });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toBe("step_up_required");
      expect(refused.json().actionKind).toBe("settings_relax");
      expect((await loadSetting())).toBe("enforce");

      const o = await as("POST", "/v1/auth/step-up/options", { action: refused.json().action });
      expect(o.statusCode, o.body).toBe(200);
      const v = await as("POST", "/v1/auth/step-up/verify", {
        stepUpId: o.json().stepUpId,
        method: "passkey",
        response: authr.authenticate(o.json().passkey.options),
      });
      expect(v.statusCode, v.body).toBe(200);
      const since = await mark();
      const ok = await as("PUT", "/v1/org/settings", { outboundCredentialAudience: "off" }, { [STEP_UP_HEADER]: v.json().stepUpToken });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json().settings.outboundCredentialAudience).toBe("off");
      const [audit] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, adminId), eq(auditLog.ruleId, "org-settings-updated"), gt(auditLog.seq, since)))
        .orderBy(desc(auditLog.seq))
        .limit(1);
      const detail = audit!.detail as { transitions: Record<string, unknown>; relaxed?: string[] };
      expect(detail.transitions.outboundCredentialAudience).toEqual({ from: "enforce", to: "off" });
      expect(detail.relaxed).toEqual(["outboundCredentialAudience"]);
      const [grant] = await db.select().from(stepUpGrants).where(eq(stepUpGrants.userId, adminId)).orderBy(desc(stepUpGrants.createdAt)).limit(1);
      expect(grant?.actionKind).toBe("settings_relax");
      expect(grant?.usedAt).not.toBeNull();

      const d = await app.inject({ method: "GET", url: "/v1/detection-content", headers: AUTH });
      expect(d.json().outboundAudienceEnforced).toBe(false);

      // off: the same calls now go out, and nothing is refused by this check
      const callSince = await mark();
      const hits = collectorHits.length;
      const r = await invoke(webhookId, "events", { nested: [{ token: GH_TOKEN }] });
      expect(r.statusCode, r.body).toBe(200);
      expect(collectorHits.length).toBe(hits + 1);
      const client = await mcpClient(serverId);
      try {
        const out = await client.callTool({ name: "send", arguments: { body: GH_TOKEN } });
        expect(JSON.stringify(out.content)).toContain("sent");
      } finally {
        await client.close();
      }
      expect(await audienceRows(callSince)).toHaveLength(0);
    } finally {
      await setAudience("enforce");
    }
  });
});

async function loadSetting(): Promise<string | undefined> {
  const [row] = await db.select({ v: orgSettings.outboundCredentialAudience }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  return row?.v;
}
