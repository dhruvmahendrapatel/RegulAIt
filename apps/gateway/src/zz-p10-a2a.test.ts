/**
 * ADR-0219 (P10) — governed agent-to-agent (A2A) calls.
 *
 * A real A2A agent (the SDK's own server half on a loopback port) is registered and called through the gateway. Pinned:
 *  - the org setting is off by default; while off, registration and calls are refused and audited, and turning it on
 *    is a `settings_relax` relaxation (an API key is asked for a step-up);
 *  - registration reads the card through the guarded fetch, refuses a private destination unless opted in, and refuses
 *    a card whose JSON-RPC interface is on another origin;
 *  - a call is default-deny on the person's own grant (agent-wide or one skill); a worker's lead ceiling only narrows;
 *  - an allowed call writes the pillar-5 usage row and the audit row together; a refusal sends nothing upstream;
 *  - the credential is encrypted, never returned, and sent only to the registered origin.
 * Scoped to the rows this file creates (M-008).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AgentCard, Role, type Message } from "@a2a-js/sdk";
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, JsonRpcTransportHandler, ServerCallContext, type AgentExecutor } from "@a2a-js/sdk/server";
import { a2aAgentCredentials, a2aAgentGrants, a2aAgents, and, auditLog, createDb, desc, eq, inArray, ORG_SETTINGS_ID, orgSettings, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { A2A_RULE_IDS, executeGovernedA2aCall } from "./a2a.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `p10-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = randomBytes(32).toString("hex");
const SECRET = `p10-secret-${randomBytes(12).toString("hex")}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const restores: Array<() => Promise<void>> = [];
const agentIds: string[] = [];
let userId: string;
let userKey: Record<string, string>;
let adminKey: Record<string, string>;

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
}

/** an A2A agent with one `echo` skill; `rpcOrigin` lets a test publish a card whose interface is elsewhere */
async function startAgent(rpcOrigin?: string) {
  const seen: Seen[] = [];
  let base = "";
  const card = () =>
    AgentCard.fromJSON({
      name: `p10 echo ${RUN}`,
      description: "echoes",
      version: "1.0.0",
      supportedInterfaces: [{ url: `${rpcOrigin ?? base}/rpc`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
      capabilities: { streaming: false },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [
        { id: "echo", name: "Echo", description: "repeats the message", tags: ["test"] },
        { id: "shout", name: "Shout", description: "repeats it loudly", tags: ["test"] },
      ],
    });
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
  let handler: JsonRpcTransportHandler | null = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      void (async () => {
        seen.push({ method: req.method ?? "", path: req.url ?? "", headers: { ...req.headers } });
        if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(AgentCard.toJSON(card())));
          return;
        }
        if (req.method === "POST" && req.url === "/rpc") {
          handler ??= new JsonRpcTransportHandler(new DefaultRequestHandler(card(), new InMemoryTaskStore(), executor));
          const out = await handler.handle(body, new ServerCallContext());
          res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
          return;
        }
        res.writeHead(404).end();
      })().catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
  });
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

let agentUp: Awaited<ReturnType<typeof startAgent>>;
let elsewhereUp: Awaited<ReturnType<typeof startAgent>>;

const req = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const setEnabled = (on: boolean) => db.update(orgSettings).set({ a2aEnabled: on }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
const lastAudit = async (ruleId: string, objectId?: string) =>
  (await db.select().from(auditLog).where(objectId ? and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)) : eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.seq)).limit(1))[0];

async function register(name: string, url: string, extra: Record<string, unknown> = { allowPrivateRanges: true }) {
  const r = await req("POST", "/v1/a2a/agents", { name, url, ...extra });
  if (r.statusCode === 201) agentIds.push(r.json().id);
  return r;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  const [before] = await db.select({ a2aEnabled: orgSettings.a2aEnabled }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  restores.push(async () => void (await setEnabled(before?.a2aEnabled ?? false)));
  await setEnabled(false);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  agentUp = await startAgent();
  elsewhereUp = await startAgent();
  const u = await req("POST", "/v1/users", { email: `p10-user-${RUN}@example.com`, displayName: `p10 user ${RUN}` });
  expect(u.statusCode, u.body).toBe(201);
  userId = u.json().id;
  userKey = { authorization: `Bearer ${(await req("POST", `/v1/users/${userId}/keys`, { name: "p10" })).json().token}` };
  const a = await req("POST", "/v1/users", { email: `p10-admin-${RUN}@example.com`, displayName: `p10 admin ${RUN}`, isAdmin: true });
  expect(a.statusCode, a.body).toBe(201);
  adminKey = { authorization: `Bearer ${(await req("POST", `/v1/users/${a.json().id}/keys`, { name: "p10" })).json().token}` };
}, 120_000);

afterAll(async () => {
  try {
    if (agentIds.length > 0) await db.delete(a2aAgents).where(inArray(a2aAgents.id, agentIds));
    for (const r of restores.reverse()) await r();
  } finally {
    await agentUp?.close();
    await elsewhereUp?.close();
    app.server.closeAllConnections();
    await app.close();
  }
});

describe("A2A: the org setting", () => {
  it("is off by default: registration and calls are refused and audited", async () => {
    const r = await register(`p10-off-${RUN}`, agentUp.base);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json()).toMatchObject({ error: "a2a_registration_refused", code: "a2a_disabled" });
    expect((await lastAudit(A2A_RULE_IDS.registrationRefused))?.effect).toBe("deny");
    expect(agentUp.seen).toHaveLength(0);

    const c = await req("POST", `/v1/a2a/agents/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}/messages`, { text: "hi" }, userKey);
    expect(c.statusCode, c.body).toBe(403);
    expect(c.json()).toMatchObject({ error: "a2a_disabled", ruleId: A2A_RULE_IDS.disabled });
    expect((await req("GET", "/v1/a2a/agents")).json().enabled).toBe(false);
  });

  it("turning it on is a relaxation: an API key is asked for a step-up", async () => {
    const asked = await req("PUT", "/v1/org/settings", { a2aEnabled: true }, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const on = await req("PUT", "/v1/org/settings", { a2aEnabled: true });
    expect(on.statusCode, on.body).toBe(200);
    const row = (await db.select().from(auditLog).where(eq(auditLog.ruleId, "org-settings-updated")).orderBy(desc(auditLog.seq)).limit(1))[0];
    expect(JSON.stringify(row?.detail)).toContain("a2aEnabled");
  });
});

describe("A2A: registration", () => {
  it("refuses a loopback agent without the private-range opt-in (the MCP egress posture)", async () => {
    const r = await register(`p10-strict-${RUN}`, agentUp.base, {});
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({ code: "egress_blocked" });
    expect(agentUp.seen).toHaveLength(0);
  });

  it("refuses a card whose JSON-RPC interface is on another origin", async () => {
    const liar = await startAgent(elsewhereUp.base);
    try {
      const r = await register(`p10-liar-${RUN}`, liar.base);
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json()).toMatchObject({ code: "card_refused" });
      expect(r.json().detail).toContain("another origin");
    } finally {
      await liar.close();
    }
  });

  it("reads the card through the guarded fetch and lists its skills; nobody may call it yet", async () => {
    const r = await register(`p10-echo-${RUN}`, agentUp.base, { allowPrivateRanges: true, pricePerCallUsd: 0.02 });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().skills.map((s: { id: string }) => s.id)).toEqual(["echo", "shout"]);
    expect(r.json().credential).toMatchObject({ set: false });
    expect(agentUp.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["GET /.well-known/agent-card.json"]);
    const a = await lastAudit(A2A_RULE_IDS.registered, r.json().id);
    expect(a?.detail).toMatchObject({ phase: "registration", relaxation: true, skills: ["echo", "shout"] });
    const list = await req("GET", "/v1/a2a/agents");
    expect(list.json().enabled).toBe(true);
    expect(list.json().agents.some((x: { id: string }) => x.id === r.json().id)).toBe(true);
  });

  it("is admin-only", async () => {
    const r = await req("POST", "/v1/a2a/agents", { name: `p10-nope-${RUN}`, url: agentUp.base }, userKey);
    expect(r.statusCode).toBe(403);
  });
});

describe("A2A: the governed call", () => {
  const agentId = () => agentIds[0]!;
  const call = (payload: Record<string, unknown>) => req("POST", `/v1/a2a/agents/${agentId()}/messages`, payload, userKey);

  it("is default-deny: no grant, no call, and nothing leaves the box", async () => {
    const before = agentUp.posts().length;
    const r = await call({ text: "hello", skillId: "echo" });
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json()).toMatchObject({ error: "forbidden", ruleId: A2A_RULE_IDS.noGrant });
    expect(agentUp.posts().length).toBe(before);
    const a = await lastAudit(A2A_RULE_IDS.noGrant, agentId());
    expect(a).toMatchObject({ effect: "deny", userId, toolName: "echo" });
  });

  it("a one-skill grant covers that skill only", async () => {
    const g = await req("POST", `/v1/a2a/agents/${agentId()}/grants`, { userId, skillId: "echo" });
    expect(g.statusCode, g.body).toBe(201);
    expect((await call({ text: "x" })).json().ruleId).toBe(A2A_RULE_IDS.noGrant);
    expect((await call({ text: "x", skillId: "shout" })).json().ruleId).toBe(A2A_RULE_IDS.noGrant);
    expect((await call({ text: "x", skillId: "nope" })).json().ruleId).toBe(A2A_RULE_IDS.unknownSkill);
  });

  it("an allowed call returns the reply and writes the usage row and the audit row", async () => {
    const projectId = "7a1e2b3c-0000-4000-8000-00000000a2a0";
    const r = await call({ text: "hi there", skillId: "echo", projectId });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ reply: "echo: hi there", costUsd: 0.02 });
    const a = await lastAudit(A2A_RULE_IDS.callAllowed, agentId());
    expect(a).toMatchObject({ effect: "allow", userId, toolName: "echo" });
    const usageId = (a!.detail as { usageEventId: string }).usageEventId;
    const [u] = await db.select().from(usageEvents).where(eq(usageEvents.id, usageId));
    expect(u).toMatchObject({ userId, objectType: "a2a_agent", operation: "echo", costUsd: 0.02, projectId });
  });

  it("a worker's lead ceiling only narrows: excluded agents are refused even with a grant", async () => {
    const before = agentUp.posts().length;
    const out = await executeGovernedA2aCall(db, { userId, agentId: agentId(), skillId: "echo", text: "w", ceilingAgentIds: [] });
    expect(out).toMatchObject({ kind: "denied", ruleId: A2A_RULE_IDS.leadCeiling });
    expect(agentUp.posts().length).toBe(before);
    const ok = await executeGovernedA2aCall(db, { userId, agentId: agentId(), skillId: "echo", text: "w", ceilingAgentIds: [agentId()] });
    expect(ok.kind).toBe("allowed");
  });

  it("a turned-off agent cannot be called", async () => {
    expect((await req("PATCH", `/v1/a2a/agents/${agentId()}`, { enabled: false })).statusCode).toBe(200);
    expect((await call({ text: "x", skillId: "echo" })).json()).toMatchObject({ error: "unknown_agent" });
    expect((await req("PATCH", `/v1/a2a/agents/${agentId()}`, { enabled: true })).statusCode).toBe(200);
  });
});

describe("A2A: the credential", () => {
  const agentId = () => agentIds[0]!;
  const url = () => `/v1/a2a/agents/${agentId()}/credential`;

  it("an API key is asked for a step-up; the secret is stored encrypted and never returned", async () => {
    const asked = await req("PUT", url(), { scheme: "bearer", secret: SECRET }, adminKey);
    expect(asked.statusCode, asked.body).toBe(403);
    expect(asked.json()).toMatchObject({ error: "step_up_required", actionKind: "settings_relax" });
    const set = await req("PUT", url(), { scheme: "bearer", secret: SECRET });
    expect(set.statusCode, set.body).toBe(201);
    expect(set.body).not.toContain(SECRET);
    expect(set.json().credential).toMatchObject({ set: true, scheme: "bearer", last4: SECRET.slice(-4) });
    const [row] = await db.select().from(a2aAgentCredentials).where(eq(a2aAgentCredentials.agentId, agentId()));
    expect(row!.secretCiphertext).not.toContain(SECRET);
    expect((await req("GET", url())).body).not.toContain(SECRET);
    expect((await req("GET", "/v1/a2a/agents")).body).not.toContain(SECRET);
    const a = await lastAudit(A2A_RULE_IDS.credentialSet, agentId());
    expect(JSON.stringify(a)).not.toContain(SECRET);
  });

  it("refuses a header the A2A transport owns", async () => {
    const r = await req("PUT", url(), { scheme: "header", headerName: "A2A-Version", secret: SECRET, rotate: true });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json()).toMatchObject({ code: "header_refused" });
  });

  it("is sent on the call, to the registered origin", async () => {
    const before = agentUp.posts().length;
    const r = await req("POST", `/v1/a2a/agents/${agentId()}/messages`, { text: "with cred", skillId: "echo" }, userKey);
    expect(r.statusCode, r.body).toBe(200);
    const sent = agentUp.posts().slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it("clears", async () => {
    const r = await req("DELETE", url());
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().credential).toMatchObject({ set: false });
  });
});

describe("A2A: removal", () => {
  it("removes the agent with its grants, audited", async () => {
    const agentId = agentIds[0]!;
    const r = await req("DELETE", `/v1/a2a/agents/${agentId}`);
    expect(r.statusCode, r.body).toBe(204);
    expect(await db.select().from(a2aAgentGrants).where(eq(a2aAgentGrants.agentId, agentId))).toHaveLength(0);
    expect((await lastAudit(A2A_RULE_IDS.removed, agentId))?.detail).toMatchObject({ grantsRemoved: 1 });
  });
});
