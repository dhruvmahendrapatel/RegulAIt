/**
 * ADR-0231 §3 (slice B1) — the HTTP+JSON binding and legacy A2A 0.3 cards.
 *
 * Real agents on loopback ports, served by the SDK's own server halves (the 1.0 REST handler and the v0.3 REST
 * compatibility router), are registered and called through the gateway. Pinned:
 *  - a 1.0 card with only an HTTP+JSON interface registers and is called over REST;
 *  - a legacy 0.3 card (SAP Agent Gateway's shape: `url`, `preferredTransport`, card-level `protocolVersion`) is
 *    converted at read time, stored normalised with version 0.3 on every interface, and called over the v0.3 REST
 *    wire (`/v1/message:send`, `application/json`), the credential going to the registered origin only;
 *  - a legacy card whose `url` or `additionalInterfaces` names another origin is refused, and nothing is saved;
 *  - a card offering only gRPC, or a JSON-RPC/HTTP+JSON interface in an unsupported or empty protocol version, is
 *    refused rather than guessed.
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
import { restHandler, UserBuilder } from "@a2a-js/sdk/server/express";
import { legacyRestRouter } from "@a2a-js/sdk/compat/v0_3/server/express";
import { a2aAgentGrants, a2aAgents, auditLog, createDb, desc, eq, inArray, ORG_SETTINGS_ID, orgSettings, runMigrations, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { A2A_RULE_IDS, a2aProtocolVersionSupported } from "./a2a.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

// express is the SDK's own server-half peer, resolved from the SDK's install (test-only; the gateway ships no express)
const sdkRequire = createRequire(createRequire(import.meta.url).resolve("@a2a-js/sdk"));
type SdkHandler = ReturnType<typeof restHandler>;
type HReq = Parameters<SdkHandler>[0];
type HRes = Parameters<SdkHandler>[1];
type HNext = Parameters<SdkHandler>[2];
/** the few members of an express app this file uses (the gateway has no express types of its own) */
interface MiniExpress {
  (req: http.IncomingMessage, res: http.ServerResponse): void;
  use(path: string, handler: (req: HReq, res: HRes, next: HNext) => void): void;
  use(handler: (req: { method: string; url: string; headers: http.IncomingHttpHeaders }, res: unknown, next: () => void) => void): void;
  get(path: string, handler: (req: unknown, res: { json(body: unknown): void }) => void): void;
}
const express = sdkRequire("express") as () => MiniExpress;

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `b1-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = randomBytes(32).toString("hex");
const SECRET = `b1-secret-${randomBytes(12).toString("hex")}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const restores: Array<() => Promise<void>> = [];
const agentIds: string[] = [];
let userId: string;
let userKey: Record<string, string>;

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

const SKILLS = [{ id: "echo", name: "Echo", description: "repeats the message", tags: ["test"] }];

const executor: AgentExecutor = {
  execute: async (ctx, bus) => {
    const text = ctx.userMessage.parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("");
    const reply: Message = {
      messageId: `m-${Math.random()}`,
      contextId: ctx.contextId,
      taskId: "",
      role: Role.ROLE_AGENT,
      parts: [{ content: { $case: "text", value: `echo: ${text}` }, metadata: undefined, filename: "", mediaType: "text/plain" }],
      metadata: undefined,
      extensions: [],
      referenceTaskIds: [],
    };
    bus.publish(AgentEvent.message(reply));
    bus.finished();
  },
  cancelTask: async () => {},
};

/**
 * One loopback agent. `cardJson(base)` is the raw card it publishes (1.0 or 0.3 shape). It serves the 1.0 REST
 * handler under `/rest` and the v0.3 REST router under `/legacy`, both over the SDK's request handler.
 */
async function startAgent(cardJson: (base: string) => Record<string, unknown>) {
  const seen: Seen[] = [];
  let base = "";
  const v1Card = () =>
    AgentCard.fromJSON({
      name: `b1 ${RUN}`,
      description: "echoes",
      version: "1.0.0",
      supportedInterfaces: [
        { url: `${base}/rest`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
        { url: `${base}/legacy`, protocolBinding: "HTTP+JSON", protocolVersion: "0.3" },
      ],
      capabilities: { streaming: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: SKILLS,
    });
  const ex = express();
  ex.use((req, _res, next) => {
    seen.push({ method: req.method, path: req.url, headers: { ...req.headers } });
    next();
  });
  ex.get("/.well-known/agent-card.json", (_req, res) => {
    res.json(cardJson(base));
  });
  let handler: DefaultRequestHandler | null = null;
  const requestHandler = () => (handler ??= new DefaultRequestHandler(v1Card(), new InMemoryTaskStore(), executor));
  ex.use("/rest", (req: HReq, res: HRes, next: HNext) => restHandler({ requestHandler: requestHandler(), userBuilder: UserBuilder.noAuthentication })(req, res, next));
  ex.use("/legacy", (req: HReq, res: HRes, next: HNext) => legacyRestRouter({ requestHandler: requestHandler(), userBuilder: UserBuilder.noAuthentication })(req, res, next));
  const server = http.createServer(ex);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;
  return {
    base,
    seen,
    posts: () => seen.filter((s) => s.method === "POST"),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** SAP Agent Gateway's reported shape: an A2A 0.3.0 card over HTTP+JSON */
const legacyCard = (url: string, extra: Record<string, unknown> = {}) => ({
  name: `b1 legacy ${RUN}`,
  description: "a 0.3 agent",
  version: "1.0.0",
  protocolVersion: "0.3.0",
  url,
  preferredTransport: "HTTP+JSON",
  capabilities: { streaming: false },
  defaultInputModes: ["text/plain"],
  defaultOutputModes: ["text/plain"],
  skills: SKILLS,
  ...extra,
});
const v1Card = (interfaces: Array<{ url: string; protocolBinding: string; protocolVersion: string }>) =>
  AgentCard.toJSON(
    AgentCard.fromJSON({ name: `b1 v1 ${RUN}`, description: "a 1.0 agent", version: "1.0.0", supportedInterfaces: interfaces, capabilities: { streaming: false }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: SKILLS }),
  ) as Record<string, unknown>;

const up: Array<Awaited<ReturnType<typeof startAgent>>> = [];
const start = async (cardJson: (base: string) => Record<string, unknown>) => {
  const a = await startAgent(cardJson);
  up.push(a);
  return a;
};

const req = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const setEnabled = (on: boolean) => db.update(orgSettings).set({ a2aEnabled: on }).where(eq(orgSettings.id, ORG_SETTINGS_ID));

async function register(name: string, url: string) {
  const r = await req("POST", "/v1/a2a/agents", { name, url, allowPrivateRanges: true });
  if (r.statusCode === 201) agentIds.push(r.json().id);
  return r;
}
async function grant(agentId: string) {
  const g = await req("POST", `/v1/a2a/agents/${agentId}/grants`, { userId });
  expect(g.statusCode, g.body).toBe(201);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxGovernanceGatesForTest(db, { a2aAttributionRequired: false }));
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ a2aEnabled: orgSettings.a2aEnabled }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => void (await setEnabled(before?.a2aEnabled ?? false)));
  await setEnabled(true);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  const u = await req("POST", "/v1/users", { email: `b1-user-${RUN}@example.com`, displayName: `b1 user ${RUN}` });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id;
  userKey = { authorization: `Bearer ${(await req("POST", `/v1/users/${userId}/keys`, { name: "b1" })).json().token}` };
}, 120_000);

afterAll(async () => {
  try {
    if (agentIds.length > 0) await db.delete(a2aAgents).where(inArray(a2aAgents.id, agentIds));
    for (const r of restores.reverse()) await r();
  } finally {
    for (const a of up) await a.close();
    app.server.closeAllConnections();
    await app.close();
  }
});

describe("ADR-0231 B1: protocol versions", () => {
  it("speaks 0.3.x and 1.x only; an empty or other version is not supported", () => {
    for (const v of ["0.3", "0.3.0", "0.3.12", "1", "1.0", "1.0.0", "1.2"]) expect(a2aProtocolVersionSupported(v), v).toBe(true);
    for (const v of ["", "0.2.5", "0.4", "2.0", "1.0-beta", " 1.0", "0.3.0.1.2"]) expect(a2aProtocolVersionSupported(v), v).toBe(false);
  });
});

describe("ADR-0231 B1: the HTTP+JSON binding (A2A 1.0)", () => {
  it("registers a REST-only card and calls it over HTTP+JSON", async () => {
    const agent = await start((base) => v1Card([{ url: `${base}/rest`, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" }]));
    const r = await register(`b1-rest-${RUN}`, agent.base);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().bindings).toEqual([{ binding: "HTTP+JSON", protocolVersion: "1.0", legacy: false }]);
    const id = r.json().id as string;
    await grant(id);
    const c = await req("POST", `/v1/a2a/agents/${id}/messages`, { text: "over rest" }, userKey);
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().reply).toBe("echo: over rest");
    expect(agent.posts().map((p) => p.path)).toEqual(["/rest/message:send"]);
  });
});

describe("ADR-0231 B1: legacy A2A 0.3 cards (SAP Agent Gateway's shape)", () => {
  it("registers a 0.3 HTTP+JSON card, stores it normalised, and calls it over the v0.3 REST wire with the credential", async () => {
    const agent = await start((base) => legacyCard(`${base}/legacy`));
    const r = await register(`b1-legacy-${RUN}`, agent.base);
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().bindings).toEqual([{ binding: "HTTP+JSON", protocolVersion: "0.3.0", legacy: true }]);
    const id = r.json().id as string;
    // the stored card is the 1.0 shape, version stamped on the interface: the call decides from it, not from the remote
    const [row] = await db.select().from(a2aAgents).where(eq(a2aAgents.id, id));
    expect(row!.card).not.toHaveProperty("url");
    expect(row!.card.supportedInterfaces).toEqual([expect.objectContaining({ url: `${agent.base}/legacy`, protocolBinding: "HTTP+JSON", protocolVersion: "0.3.0" })]);
    const reg = (await db.select().from(auditLog).where(eq(auditLog.objectId, id)).orderBy(desc(auditLog.seq)).limit(1))[0];
    expect(reg?.ruleId).toBe(A2A_RULE_IDS.registered);
    expect(reg?.detail).toMatchObject({ bindings: [{ binding: "HTTP+JSON", protocolVersion: "0.3.0", legacy: true }] });

    const cred = await req("PUT", `/v1/a2a/agents/${id}/credential`, { scheme: "bearer", secret: SECRET });
    expect(cred.statusCode, cred.body).toBe(201);
    await grant(id);
    const c = await req("POST", `/v1/a2a/agents/${id}/messages`, { text: "hello joule", skillId: "echo" }, userKey);
    expect(c.statusCode, c.body).toBe(200);
    expect(c.json().reply).toBe("echo: hello joule");
    const posts = agent.posts();
    expect(posts.map((p) => p.path)).toEqual(["/legacy/v1/message:send"]);
    expect(posts[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(String(posts[0]!.headers["content-type"])).toContain("application/json");
    // the card read carried no credential
    expect(agent.seen.find((s) => s.method === "GET")?.headers.authorization).toBeUndefined();
  });

  it("refuses a legacy card whose url names another origin, and saves nothing", async () => {
    const elsewhere = await start((base) => legacyCard(`${base}/legacy`));
    const liar = await start(() => legacyCard(`${elsewhere.base}/legacy`));
    const r = await register(`b1-liar-url-${RUN}`, liar.base);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({ code: "card_refused" });
    expect(r.json().detail).toContain("another origin");
    expect(await db.select().from(a2aAgents).where(eq(a2aAgents.name, `b1-liar-url-${RUN}`))).toHaveLength(0);
    expect(elsewhere.seen).toHaveLength(0);
  });

  it("refuses a legacy card whose additionalInterfaces name another origin", async () => {
    const elsewhere = await start((base) => legacyCard(`${base}/legacy`));
    const liar = await start((base) => legacyCard(`${base}/legacy`, { additionalInterfaces: [{ url: `${elsewhere.base}/rpc`, transport: "JSONRPC" }] }));
    const r = await register(`b1-liar-extra-${RUN}`, liar.base);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({ code: "card_refused" });
    expect(r.json().detail).toContain("another origin");
  });
});

describe("ADR-0231 B1: cards the gateway does not speak", () => {
  it("refuses a gRPC-only card", async () => {
    const a = await start((base) => v1Card([{ url: `${base}/grpc`, protocolBinding: "GRPC", protocolVersion: "1.0" }]));
    const r = await register(`b1-grpc-${RUN}`, a.base);
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().detail).toContain("no JSON-RPC or HTTP+JSON interface");
  });

  it("refuses an interface in an unsupported or empty protocol version, rather than guessing", async () => {
    for (const [tag, version] of [["v2", "2.0"], ["empty", ""]] as const) {
      const a = await start((base) => v1Card([{ url: `${base}/rest`, protocolBinding: "HTTP+JSON", protocolVersion: version }]));
      const r = await register(`b1-ver-${tag}-${RUN}`, a.base);
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().detail).toContain("0.3.x and 1.x only");
      expect(a.posts()).toHaveLength(0);
    }
  });

  it("a refused call sends nothing upstream: no grant, no request", async () => {
    const agent = await start((base) => legacyCard(`${base}/legacy`));
    const r = await register(`b1-nogrant-${RUN}`, agent.base);
    expect(r.statusCode, r.body).toBe(201);
    const c = await req("POST", `/v1/a2a/agents/${r.json().id}/messages`, { text: "hi" }, userKey);
    expect(c.statusCode, c.body).toBe(403);
    expect(agent.posts()).toHaveLength(0);
    expect(await db.select().from(a2aAgentGrants).where(eq(a2aAgentGrants.agentId, r.json().id))).toHaveLength(0);
  });
});
