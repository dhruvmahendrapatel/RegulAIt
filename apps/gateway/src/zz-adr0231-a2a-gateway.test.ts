/**
 * ADR-0231 §2 (slice B3) — agent gateway connections, the ARD import, and pending cards.
 *
 * A fake SAP-style agent gateway on a loopback port: a client-credentials token endpoint, an ARD catalogue
 * (`/.well-known/ard.json`, already filtered to what this client may see), the A2A 0.3 cards it names, and the SDK's own
 * v0.3 REST server half for the calls. Pinned:
 *  - `sapAgentGatewayEnabled` is off by default; while off nothing is connected, read or called, and every refusal is
 *    audited; a connection needs https unless opted into private ranges, and is a settings_relax step-up;
 *  - the client secret is encrypted and never returned; the discovery token is used for the catalogue and the cards
 *    only, cached, and never sent with a message;
 *  - IMPORT lists candidates and registers nothing; a card on another origin is refused, an inline entry is skipped;
 *    an admin then registers one, and nobody may call it until granted;
 *  - REFRESH holds a changed card as pending: calls keep the stored card, narrowed at once to what both allow;
 *    accepting a widening card is a step-up; rejecting keeps the stored card; a moved card is refused; an agent gone
 *    from the catalogue is turned off, not deleted.
 * Scoped to the rows this file creates (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AgentCard, Role, type Message } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor } from "@a2a-js/sdk/server";
import { UserBuilder } from "@a2a-js/sdk/server/express";
import { legacyRestRouter } from "@a2a-js/sdk/compat/v0_3/server/express";
import { a2aAgents, a2aGatewayConnections, and, auditLog, createDb, desc, eq, inArray, ORG_SETTINGS_ID, orgSettings, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { A2A_RULE_IDS } from "./a2a.js";
import { A2A_GATEWAY_RULE_IDS, clearGatewayTokenCacheForTest, parseArdManifest, PENDING_CARD_TRANSITIONS, pendingCardNext } from "./a2a-gateway.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

// express is the SDK's own server-half peer, resolved from the SDK's install (test-only; the gateway ships no express)
const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@a2a-js/sdk"));
type SdkHandler = ReturnType<typeof legacyRestRouter>;
type HReq = Parameters<SdkHandler>[0];
type HRes = Parameters<SdkHandler>[1];
type HNext = Parameters<SdkHandler>[2];
interface Req {
  method: string;
  url: string;
  path: string;
  params: Record<string, string>;
  headers: http.IncomingHttpHeaders;
}
interface Res {
  status(code: number): Res;
  json(body: unknown): void;
  end(): void;
}
interface MiniExpress {
  (req: http.IncomingMessage, res: http.ServerResponse): void;
  use(path: string, handler: (req: HReq, res: HRes, next: HNext) => void): void;
  use(handler: (req: Req, res: Res, next: () => void) => void): void;
  get(path: string, handler: (req: Req, res: Res) => void): void;
  post(path: string, handler: (req: Req, res: Res) => void): void;
}
const express = sdkRequire("express") as () => MiniExpress;

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `b3-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = randomBytes(32).toString("hex");
const CLIENT_ID = `regulait-consumer-${RUN}`;
const CLIENT_SECRET = `b3-client-secret-${randomBytes(12).toString("hex")}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const restores: Array<() => Promise<void>> = [];
let userId: string;
let userKey: Record<string, string>;
let adminKey: Record<string, string>;
let connectionId: string;

const skill = (id: string) => ({ id, name: id, description: `the ${id} skill`, tags: ["sap"] });
/** an A2A 0.3.0 card over HTTP+JSON, as SAP Agent Gateway publishes */
const legacyCard = (base: string, name: string, skills: string[], extra: Record<string, unknown> = {}) => ({
  name,
  description: "a Joule agent",
  version: "1.0.0",
  protocolVersion: "0.3.0",
  url: `${base}/legacy`,
  preferredTransport: "HTTP+JSON",
  capabilities: { streaming: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: skills.map(skill),
  ...extra,
});

interface Seen {
  method: string;
  path: string;
  authorization: string | undefined;
}

/** the fake gateway: everything mutable so a test can change the catalogue or a card between calls */
async function startGateway() {
  const seen: Seen[] = [];
  let tokensIssued = 0;
  let base = "";
  const state = {
    cards: new Map<string, () => Record<string, unknown>>(),
    entries: [] as Array<Record<string, unknown>>,
  };
  const executor: AgentExecutor = {
    execute: async (ctx, bus) => {
      const text = ctx.userMessage.parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("");
      const reply: Message = { messageId: `m-${Math.random()}`, contextId: ctx.contextId, taskId: "", role: Role.ROLE_AGENT, parts: [{ content: { $case: "text", value: `joule: ${text}` }, metadata: undefined, filename: "", mediaType: "text/plain" }], metadata: undefined, extensions: [], referenceTaskIds: [] };
      bus.publish(AgentEvent.message(reply));
      bus.finished();
    },
    cancelTask: async () => {},
  };
  const ex = express();
  ex.use((req, _res, next) => {
    seen.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    next();
  });
  const bearerOk = (req: Req) => typeof req.headers.authorization === "string" && /^Bearer tok-/.test(req.headers.authorization);
  ex.post("/oauth/token", (req, res) => {
    // RFC 6749 §2.3.1: each half is form-urlencoded before base64 (oauth4webapi sends '-' as %2D), so decode both
    const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    const [id, secret] = basic ? Buffer.from(basic, "base64").toString("utf8").split(":").map((p) => decodeURIComponent(p.replace(/\+/g, " "))) : [];
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET) return res.status(401).json({ error: "invalid_client" });
    tokensIssued += 1;
    res.json({ access_token: `tok-${tokensIssued}-${RUN}`, token_type: "Bearer", expires_in: 300 });
  });
  ex.get("/.well-known/ard.json", (req, res) => {
    if (!bearerOk(req)) return res.status(401).json({ error: "unauthorized" });
    res.json({ entries: state.entries });
  });
  ex.get("/cards/:id", (req, res) => {
    if (!bearerOk(req)) return res.status(401).json({ error: "unauthorized" });
    const card = state.cards.get(req.params.id!);
    if (!card) return res.status(404).json({ error: "not_found" });
    res.json(card());
  });
  const v1 = () =>
    AgentCard.fromJSON({ name: "fake", description: "d", version: "1", supportedInterfaces: [{ url: `${base}/legacy`, protocolBinding: "HTTP+JSON", protocolVersion: "0.3" }], capabilities: { streaming: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [] });
  let handler: DefaultRequestHandler | null = null;
  ex.use("/legacy", (req: HReq, res: HRes, next: HNext) => legacyRestRouter({ requestHandler: (handler ??= new DefaultRequestHandler(v1(), new InMemoryTaskStore(), executor)), userBuilder: UserBuilder.noAuthentication })(req, res, next));
  const server = http.createServer(ex);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
  return {
    base,
    seen,
    state,
    tokensIssued: () => tokensIssued,
    entry: (id: string, extra: Record<string, unknown> = {}) => ({ identifier: `urn:air:sap.com:joule:${id}`, displayName: `Joule ${id}`, type: "application/a2a-agent-card+json", url: `${base}/cards/${id}`, ...extra }),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let gw: Awaited<ReturnType<typeof startGateway>>;
let elsewhere: Awaited<ReturnType<typeof startGateway>>;

const req = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const setOrg = (patch: { a2aEnabled?: boolean; sapAgentGatewayEnabled?: boolean }) => db.update(orgSettings).set(patch).where(eq(orgSettings.id, ORG_SETTINGS_ID));
const lastAudit = async (ruleId: string, objectId?: string) =>
  (await db.select().from(auditLog).where(objectId ? and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)) : eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.seq)).limit(1))[0];
const connBody = (extra: Record<string, unknown> = {}) => ({
  name: `b3-sap-${RUN}`,
  provider: "sap_agent_gateway",
  baseUrl: gw.base,
  tokenEndpoint: `${gw.base}/oauth/token`,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  allowPrivateRanges: true,
  ...extra,
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxGovernanceGatesForTest(db, { a2aAttributionRequired: false }));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ a2aEnabled: orgSettings.a2aEnabled, sap: orgSettings.sapAgentGatewayEnabled }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => void (await setOrg({ a2aEnabled: before?.a2aEnabled ?? false, sapAgentGatewayEnabled: before?.sap ?? false })));
  await setOrg({ a2aEnabled: true, sapAgentGatewayEnabled: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  clearGatewayTokenCacheForTest();
  gw = await startGateway();
  elsewhere = await startGateway();
  gw.state.cards.set("orders", () => legacyCard(gw.base, "Joule orders", ["status", "echo"]));
  gw.state.cards.set("finance", () => legacyCard(gw.base, "Joule finance", ["report"]));
  gw.state.cards.set("liar", () => legacyCard(elsewhere.base, "Joule liar", ["x"]));
  gw.state.entries = [
    gw.entry("orders"),
    gw.entry("finance"),
    gw.entry("liar"),
    { identifier: "urn:air:sap.com:joule:inline", displayName: "inline", type: "application/a2a-agent-card+json", data: {} },
    { identifier: "urn:air:sap.com:mcp:weather", displayName: "an MCP server", type: "application/mcp-server-card+json", url: `${gw.base}/mcp.json` },
  ];
  const u = await req("POST", "/v1/users", { email: `b3-user-${RUN}@example.com`, displayName: `b3 user ${RUN}` });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id;
  userKey = { authorization: `Bearer ${(await req("POST", `/v1/users/${userId}/keys`, { name: "b3" })).json().token}` };
  const a = await req("POST", "/v1/users", { email: `b3-admin-${RUN}@example.com`, displayName: `b3 admin ${RUN}`, isAdmin: true });
  adminKey = { authorization: `Bearer ${(await req("POST", `/v1/users/${a.json().id}/keys`, { name: "b3" })).json().token}` };
}, 120_000);

afterAll(async () => {
  try {
    const conns = await db.select({ id: a2aGatewayConnections.id }).from(a2aGatewayConnections).where(eq(a2aGatewayConnections.name, `b3-sap-${RUN}`));
    if (conns.length) {
      await db.delete(a2aAgents).where(inArray(a2aAgents.gatewayConnectionId, conns.map((c) => c.id)));
      await db.delete(a2aGatewayConnections).where(inArray(a2aGatewayConnections.id, conns.map((c) => c.id)));
    }
    for (const r of restores.reverse()) await r();
  } finally {
    await gw?.close();
    await elsewhere?.close();
    app.server.closeAllConnections();
    await app.close();
  }
});

describe("B3: the ARD manifest", () => {
  it("keeps A2A card entries by reference, skips inline ones, ignores other artifact types", () => {
    const out = parseArdManifest({ entries: [{ identifier: "a", displayName: "A", type: "application/a2a-agent-card+json", url: "https://x/a" }, { identifier: "b", displayName: "B", type: "application/a2a-agent-card+json", data: {} }, { identifier: "c", type: "application/mcp-server-card+json", url: "https://x/c" }, { type: "x" }, "junk"] });
    expect(out.entries.map((e) => e.identifier)).toEqual(["a"]);
    expect(out.skipped.map((s) => s.identifier)).toEqual(["b"]);
    expect(parseArdManifest(null)).toEqual({ entries: [], skipped: [] });
  });
});

describe("B3: the org setting and the connection", () => {
  it("is off by default: a connection is refused and audited", async () => {
    const r = await req("POST", "/v1/a2a/gateway-connections", connBody());
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "sap_agent_gateway_disabled" });
    expect((await lastAudit(A2A_GATEWAY_RULE_IDS.connectionRefused))?.effect).toBe("deny");
    expect(gw.seen).toHaveLength(0);
  });

  it("turning it on is a relaxation: an API key is asked for a step-up", async () => {
    const asked = await req("PUT", "/v1/org/settings", { sapAgentGatewayEnabled: true }, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const on = await req("PUT", "/v1/org/settings", { sapAgentGatewayEnabled: true });
    expect(on.statusCode, on.body).toBe(200);
  });

  it("needs https unless opted into private ranges, and a step-up; the secret is encrypted and never returned", async () => {
    const plain = await req("POST", "/v1/a2a/gateway-connections", connBody({ allowPrivateRanges: null }));
    expect(plain.statusCode, plain.body).toBe(400);
    expect(plain.json()).toMatchObject({ code: "https_required" });
    const asked = await req("POST", "/v1/a2a/gateway-connections", connBody(), adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required" });

    const r = await req("POST", "/v1/a2a/gateway-connections", connBody());
    expect(r.statusCode, r.body).toBe(201);
    connectionId = r.json().id;
    expect(r.body).not.toContain(CLIENT_SECRET);
    expect(r.json()).toMatchObject({ clientSecretLast4: CLIENT_SECRET.slice(-4), provider: "sap_agent_gateway" });
    const [row] = await db.select().from(a2aGatewayConnections).where(eq(a2aGatewayConnections.id, connectionId));
    expect(row!.clientSecretCiphertext).not.toContain(CLIENT_SECRET);
    expect((await req("GET", "/v1/a2a/gateway-connections")).body).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify((await lastAudit(A2A_GATEWAY_RULE_IDS.connectionCreated))?.detail)).not.toContain(CLIENT_SECRET);
    // creating reads nothing from the gateway
    expect(gw.seen).toHaveLength(0);
  });
});

describe("B3: import lists, the admin registers", () => {
  it("lists what the catalogue offers, refuses a card on another origin, skips inline entries, and registers nothing", async () => {
    const r = await req("POST", `/v1/a2a/gateway-connections/${connectionId}/import`);
    expect(r.statusCode, r.body).toBe(200);
    const byId = Object.fromEntries((r.json().candidates as Array<{ identifier: string; status: string; detail?: string }>).map((c) => [c.identifier.split(":").pop(), c]));
    expect(Object.keys(byId).sort()).toEqual(["finance", "liar", "orders"]);
    expect(byId.orders).toMatchObject({ status: "new", protocolVersion: "0.3.0", bindings: [{ binding: "HTTP+JSON", legacy: true }] });
    expect(byId.liar).toMatchObject({ status: "refused", code: "card_refused" });
    expect(r.json().skipped).toEqual([expect.objectContaining({ identifier: "urn:air:sap.com:joule:inline" })]);
    expect(await db.select().from(a2aAgents).where(eq(a2aAgents.gatewayConnectionId, connectionId))).toHaveLength(0);
    // the token came from the token endpoint with the client's basic auth; the catalogue and cards carried it
    expect(gw.tokensIssued()).toBe(1);
    expect(gw.seen.filter((s) => s.path.startsWith("/cards/") || s.path === "/.well-known/ard.json").every((s) => /^Bearer tok-/.test(s.authorization ?? ""))).toBe(true);
    expect(elsewhere.seen).toHaveLength(0);
    expect((await lastAudit(A2A_GATEWAY_RULE_IDS.discovery))?.detail).toMatchObject({ connectionId });
  });

  it("caches the discovery token: a second read asks for no new one", async () => {
    const r = await req("POST", `/v1/a2a/gateway-connections/${connectionId}/import`);
    expect(r.statusCode, r.body).toBe(200);
    expect(gw.tokensIssued()).toBe(1);
  });

  it("registers only an entry the catalogue lists now, and nobody may call it until granted", async () => {
    const missing = await req("POST", `/v1/a2a/gateway-connections/${connectionId}/agents`, { identifier: "urn:air:sap.com:joule:hr", name: `b3-hr-${RUN}` });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json()).toMatchObject({ code: "not_in_catalogue" });
    const liar = await req("POST", `/v1/a2a/gateway-connections/${connectionId}/agents`, { identifier: "urn:air:sap.com:joule:liar", name: `b3-liar-${RUN}` });
    expect(liar.statusCode, liar.body).toBe(400);

    const r = await req("POST", `/v1/a2a/gateway-connections/${connectionId}/agents`, { identifier: "urn:air:sap.com:joule:orders", name: `b3-orders-${RUN}` });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json()).toMatchObject({ gatewayConnectionId: connectionId, ardIdentifier: "urn:air:sap.com:joule:orders", cardProtocolVersion: "0.3.0", pendingCard: null });
    const id = r.json().id as string;
    const denied = await req("POST", `/v1/a2a/agents/${id}/messages`, { text: "hi", skillId: "status" }, userKey);
    expect(denied.statusCode, denied.body).toBe(403);
    expect((await req("POST", `/v1/a2a/gateway-connections/${connectionId}/agents`, { identifier: "urn:air:sap.com:joule:orders", name: `b3-orders-2-${RUN}` })).statusCode).toBe(409);
  });

  it("a granted call goes over the v0.3 REST wire and never carries the discovery token", async () => {
    const [agent] = await db.select().from(a2aAgents).where(and(eq(a2aAgents.gatewayConnectionId, connectionId), eq(a2aAgents.name, `b3-orders-${RUN}`)));
    const g = await req("POST", `/v1/a2a/agents/${agent!.id}/grants`, { userId, skillId: "status" });
    expect(g.statusCode, g.body).toBe(201);
    const c = await req("POST", `/v1/a2a/agents/${agent!.id}/messages`, { text: "order 42?", skillId: "status" }, userKey);
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().reply).toBe("joule: order 42?");
    const msg = gw.seen.filter((s) => s.method === "POST" && s.path.startsWith("/legacy/"));
    expect(msg.map((m) => m.path)).toEqual(["/legacy/v1/message:send"]);
    expect(msg[0]!.authorization).toBeUndefined();
  });

  it("a manual card refresh of an imported agent is refused: the gateway's refresh owns it", async () => {
    const [agent] = await db.select().from(a2aAgents).where(eq(a2aAgents.name, `b3-orders-${RUN}`));
    const r = await req("POST", `/v1/a2a/agents/${agent!.id}/card`);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "use_gateway_refresh" });
  });
});

describe("B3: refresh holds a changed card for review", () => {
  const agentId = async () => (await db.select().from(a2aAgents).where(eq(a2aAgents.name, `b3-orders-${RUN}`)))[0]!.id;
  const call = async (skillId: string) => req("POST", `/v1/a2a/agents/${await agentId()}/messages`, { text: `do ${skillId}`, skillId }, userKey);

  it("a changed card is pending; calls keep the stored card, narrowed at once to what both allow", async () => {
    // the remote drops `status`... no: it drops `echo`, keeps `status`, and adds `approve` (a write-style skill)
    gw.state.cards.set("orders", () => legacyCard(gw.base, "Joule orders", ["status", "approve"]));
    const g = await req("POST", `/v1/a2a/agents/${await agentId()}/grants`, { userId, skillId: "echo" });
    expect(g.statusCode, g.body).toBe(201);
    expect((await call("echo")).statusCode).toBe(200);

    const r = await req("POST", `/v1/a2a/gateway-connections/${connectionId}/refresh`);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().results).toEqual([expect.objectContaining({ outcome: "pending", diff: expect.objectContaining({ skillsAdded: ["approve"], skillsRemoved: ["echo"], widens: true }) })]);
    const [row] = await db.select().from(a2aAgents).where(eq(a2aAgents.id, await agentId()));
    expect(cardSkillIds(row!.card)).toEqual(["status", "echo"]);
    expect((await lastAudit(A2A_GATEWAY_RULE_IDS.cardPending, row!.id))?.detail).toMatchObject({ diff: { widens: true } });

    // narrowing applies now: the removed skill is refused before anything is sent; the added one is not callable yet
    const before = gw.seen.length;
    const echo = await call("echo");
    expect(echo.statusCode, echo.body).toBe(400);
    expect(echo.json()).toMatchObject({ ruleId: A2A_RULE_IDS.unknownSkill });
    expect((await call("approve")).statusCode).toBe(400);
    expect(gw.seen.length).toBe(before);
    expect((await call("status")).statusCode).toBe(200);
    // a second refresh of the same card changes nothing
    expect((await req("POST", `/v1/a2a/gateway-connections/${connectionId}/refresh`)).json().results).toEqual([expect.objectContaining({ outcome: "pending" })]);
  });

  it("accepting a widening card is a step-up; the new skill still needs a grant", async () => {
    const id = await agentId();
    const asked = await req("POST", `/v1/a2a/agents/${id}/pending-card/accept`, undefined, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const ok = await req("POST", `/v1/a2a/agents/${id}/pending-card/accept`);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().pendingCard).toBeNull();
    expect(ok.json().skills.map((s: { id: string }) => s.id)).toEqual(["status", "approve"]);
    expect((await lastAudit(A2A_GATEWAY_RULE_IDS.cardAccepted, id))?.detail).toMatchObject({ relaxation: true });
    // the person holds grants for `status` and `echo` only
    expect((await call("approve")).statusCode).toBe(403);
    expect((await call("status")).statusCode).toBe(200);
  });

  it("rejecting keeps the stored card; a narrowing-only accept needs no step-up", async () => {
    const id = await agentId();
    gw.state.cards.set("orders", () => legacyCard(gw.base, "Joule orders", ["status", "approve", "delete-po"]));
    await req("POST", `/v1/a2a/gateway-connections/${connectionId}/refresh`);
    expect((await req("DELETE", `/v1/a2a/agents/${id}/pending-card`)).statusCode).toBe(204);
    const [kept] = await db.select().from(a2aAgents).where(eq(a2aAgents.id, id));
    expect(cardSkillIds(kept!.card)).toEqual(["status", "approve"]);
    expect(kept!.pendingCard).toBeNull();

    gw.state.cards.set("orders", () => legacyCard(gw.base, "Joule orders", ["status"]));
    await req("POST", `/v1/a2a/gateway-connections/${connectionId}/refresh`);
    const narrowed = await req("POST", `/v1/a2a/agents/${id}/pending-card/accept`, undefined, adminKey);
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json().skills.map((s: { id: string }) => s.id)).toEqual(["status"]);
  });

  it("a card that moved to another url is refused, not followed", async () => {
    const id = await agentId();
    gw.state.cards.set("orders-v2", () => legacyCard(gw.base, "Joule orders", ["status"]));
    gw.state.entries = gw.state.entries.map((e) => (e.identifier === "urn:air:sap.com:joule:orders" ? { ...e, url: `${gw.base}/cards/orders-v2` } : e));
    const r = await req("POST", `/v1/a2a/gateway-connections/${connectionId}/refresh`);
    expect(r.json().results).toEqual([expect.objectContaining({ agentId: id, outcome: "moved_refused" })]);
    const [row] = await db.select().from(a2aAgents).where(eq(a2aAgents.id, id));
    expect(row!.url).toBe(`${gw.base}/cards/orders`);
  });

  it("an agent gone from the catalogue is turned off, not deleted", async () => {
    const id = await agentId();
    gw.state.entries = gw.state.entries.filter((e) => e.identifier !== "urn:air:sap.com:joule:orders");
    const r = await req("POST", `/v1/a2a/gateway-connections/${connectionId}/refresh`);
    expect(r.json().results).toEqual([expect.objectContaining({ agentId: id, outcome: "gone_disabled" })]);
    const [row] = await db.select().from(a2aAgents).where(eq(a2aAgents.id, id));
    expect(row!.enabled).toBe(false);
    expect((await call("status")).statusCode).toBe(404);
    expect((await lastAudit(A2A_GATEWAY_RULE_IDS.agentGone, id))?.effect).toBe("allow");
  });
});

describe("B3: switching it off", () => {
  it("the org setting off refuses the gateway agents' calls; a turned-off connection does too; deleting turns its agents off", async () => {
    gw.state.entries = [...gw.state.entries, gw.entry("finance")];
    const reg = await req("POST", `/v1/a2a/gateway-connections/${connectionId}/agents`, { identifier: "urn:air:sap.com:joule:finance", name: `b3-finance-${RUN}` });
    expect(reg.statusCode, reg.body).toBe(201);
    const id = reg.json().id as string;
    await req("POST", `/v1/a2a/agents/${id}/grants`, { userId });
    const call = () => req("POST", `/v1/a2a/agents/${id}/messages`, { text: "q3?" }, userKey);
    expect((await call()).statusCode).toBe(200);

    await setOrg({ sapAgentGatewayEnabled: false });
    const off = await call();
    expect(off.statusCode, off.body).toBe(403);
    expect(off.json()).toMatchObject({ error: "sap_agent_gateway_disabled", ruleId: A2A_RULE_IDS.gatewayDisabled });
    expect((await req("POST", `/v1/a2a/gateway-connections/${connectionId}/import`)).statusCode).toBe(409);
    await setOrg({ sapAgentGatewayEnabled: true });

    expect((await req("PATCH", `/v1/a2a/gateway-connections/${connectionId}`, { enabled: false }, adminKey)).statusCode).toBe(200);
    expect((await call()).json()).toMatchObject({ error: "gateway_disabled" });
    const reenable = await req("PATCH", `/v1/a2a/gateway-connections/${connectionId}`, { enabled: true }, adminKey);
    expect(reenable.statusCode, reenable.body).toBe(403);
    expect((await req("PATCH", `/v1/a2a/gateway-connections/${connectionId}`, { enabled: true })).statusCode).toBe(200);

    const del = await req("DELETE", `/v1/a2a/gateway-connections/${connectionId}`);
    expect(del.statusCode, del.body).toBe(204);
    const [row] = await db.select().from(a2aAgents).where(eq(a2aAgents.id, id));
    expect(row).toMatchObject({ enabled: false, gatewayConnectionId: null });
    expect((await lastAudit(A2A_GATEWAY_RULE_IDS.connectionRemoved))?.detail).toMatchObject({ agentsDisabled: expect.arrayContaining([id]) });
    // the imported agents stay for the trail; clean them up here (their connection id is now null)
    await db.delete(a2aAgents).where(inArray(a2aAgents.name, [`b3-orders-${RUN}`, `b3-finance-${RUN}`]));
  });
});

function cardSkillIds(card: Record<string, unknown>): string[] {
  return (Array.isArray(card.skills) ? card.skills : []).map((s) => String((s as Record<string, unknown>).id));
}

describe("build rule 12: the pending-card review state is one declared table", () => {
  it("allows exactly these transitions and refuses the rest", () => {
    expect(PENDING_CARD_TRANSITIONS).toEqual({
      none: { refresh_changed: "pending" },
      pending: { refresh_changed: "pending", refresh_reverted: "none", accept: "none", reject: "none" },
    });
    expect(pendingCardNext("none", "accept")).toBeNull();
    expect(pendingCardNext("none", "reject")).toBeNull();
    expect(pendingCardNext("none", "refresh_reverted")).toBeNull();
    expect(pendingCardNext("pending", "accept")).toBe("none");
  });
});
