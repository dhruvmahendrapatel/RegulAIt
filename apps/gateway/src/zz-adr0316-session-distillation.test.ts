import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, runMigrations, usageEvents, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";

/**
 * ADR-0316 — session distillation into the Shared Project context store, end to end:
 *   · off by default per project; only an admin turns it on, audited;
 *   · only the session's author distils it, and only a session attributed to a project;
 *   · the distillation is one governed dispatch billed to the project, written as an ordinary revision of
 *     `session/<conversationId>` through the one context write path, with provenance;
 *   · a reader sees it only while they could read its inputs (the session's agents, declared context inputs);
 *   · checkpoints: the next distillation reads only the turns since, and builds on the previous revision.
 *
 * Shares one database with the other gateway suites; every object here is prefixed e4-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "e4-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "4".repeat(64);
type Auth = { authorization: string };

let db: Db;
let app: ReturnType<typeof buildApp>;
let restorePosture: (() => Promise<void>) | undefined;
let restoreGates: () => Promise<void> = async () => {};

let authorId: string;
let authorAuth: Auth;
let peerAuth: Auth; // project viewer who may use the session's agent
let outsiderAuth: Auth; // project viewer who may NOT use the session's agent
let strangerAuth: Auth; // not the author, contributor on the project
let agentId: string;
let projectId: string;
let otherProjectId: string;
let otherItemId: string;
let convoId: string;

async function makeUser(email: string, name: string) {
  const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: name } });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "e4" } });
  expect(k.statusCode).toBe(201);
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

const addMember = (pid: string, userId: string, role: "viewer" | "contributor" | "owner") =>
  app.inject({ method: "POST", headers: AUTH, url: `/v1/projects/${pid}/members`, payload: { userId, role } });

async function sendTurn(input: string) {
  const r = await app.inject({
    method: "POST",
    headers: authorAuth,
    url: `/v1/agents/${agentId}/invoke`,
    payload: { mode: "chat", input, dispatch: true, conversationId: convoId },
  });
  expect(r.statusCode).toBe(200);
}

const distil = (auth: Auth, id: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: "POST", headers: auth, url: `/v1/conversations/${id}/distil`, payload });

const readContext = (auth: Auth) =>
  app.inject({ method: "GET", headers: auth, url: `/v1/projects/${projectId}/context` });

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restorePosture = await relaxDataPostureForTest(db, {
    org: { defaultPiiMode: "none" },
    interception: false,
    guardrails: { promptInjectionMode: "warn", jailbreakMode: "warn" },
  });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreGates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });

  const author = await makeUser("e4-author@example.com", "E4 Author");
  const peer = await makeUser("e4-peer@example.com", "E4 Peer");
  const outsider = await makeUser("e4-outsider@example.com", "E4 Outsider");
  const stranger = await makeUser("e4-stranger@example.com", "E4 Stranger");
  authorId = author.id;
  authorAuth = author.auth;
  peerAuth = peer.auth;
  outsiderAuth = outsider.auth;
  strangerAuth = stranger.auth;

  const agent = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/agents",
    payload: { name: "e4-agent", provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(agent.statusCode).toBe(201);
  agentId = agent.json().id;
  for (const u of [author.id, peer.id, stranger.id]) {
    await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: u, agentId } });
  }

  const p = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "e4-shared" } });
  expect(p.statusCode).toBe(201);
  projectId = p.json().id;
  expect((await addMember(projectId, author.id, "contributor")).statusCode).toBe(201);
  expect((await addMember(projectId, peer.id, "viewer")).statusCode).toBe(201);
  expect((await addMember(projectId, outsider.id, "viewer")).statusCode).toBe(201);
  expect((await addMember(projectId, stranger.id, "contributor")).statusCode).toBe(201);

  // a second project the author can read and the peer cannot: a declared context input from it gates the peer
  const p2 = await app.inject({ method: "POST", headers: AUTH, url: "/v1/projects", payload: { name: "e4-private" } });
  otherProjectId = p2.json().id;
  expect((await addMember(otherProjectId, author.id, "contributor")).statusCode).toBe(201);
  const item = await app.inject({
    method: "POST",
    headers: authorAuth,
    url: `/v1/projects/${otherProjectId}/context`,
    payload: { key: "e4-private-notes", content: "e4 private: the pricing floor is confidential" },
  });
  expect(item.statusCode).toBe(201);
  otherItemId = item.json().id;

  const c = await app.inject({ method: "POST", headers: authorAuth, url: "/v1/conversations", payload: { agentId, projectId } });
  expect(c.statusCode).toBe(201);
  convoId = c.json().id;
  await sendTurn("e4: we decided to keep invoice numbering monotonic per region");
  await sendTurn("e4: open question — who owns the reconciliation job?");
});

afterAll(async () => {
  await restoreGates();
  await restorePosture?.();
});

describe("ADR-0316 off by default, admin switch", () => {
  it("refuses a distillation while the project's switch is off (no row = off)", async () => {
    const r = await distil(authorAuth, convoId);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("session_distillation_disabled");
    const g = await app.inject({ method: "GET", headers: authorAuth, url: `/v1/projects/${projectId}/session-distillation` });
    expect(g.statusCode).toBe(200);
    expect(g.json().enabled).toBe(false);
  });

  it("only an admin changes the switch, and the change is audited", async () => {
    const denied = await app.inject({
      method: "PUT",
      headers: authorAuth,
      url: `/v1/projects/${projectId}/session-distillation`,
      payload: { enabled: true },
    });
    expect(denied.statusCode).toBe(403);
    const ok = await app.inject({
      method: "PUT",
      headers: AUTH,
      url: `/v1/projects/${projectId}/session-distillation`,
      payload: { enabled: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().enabled).toBe(true);
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, projectId), eq(auditLog.ruleId, "session-distillation-enabled")));
    expect(rows.length).toBe(1);
  });
});

describe("ADR-0316 who may distil", () => {
  it("refuses anyone but the session's author, admins included", async () => {
    expect((await distil(strangerAuth, convoId)).statusCode).toBe(403);
    expect((await distil(AUTH, convoId)).statusCode).toBe(403);
  });

  it("refuses a session that is not attributed to a project", async () => {
    const c = await app.inject({ method: "POST", headers: authorAuth, url: "/v1/conversations", payload: { agentId } });
    expect(c.statusCode).toBe(201);
    const r = await distil(authorAuth, c.json().id);
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe("conversation_not_attributed");
  });

  it("refuses a declared context input the author cannot read", async () => {
    const r = await distil(strangerAuth, convoId, { contextInputItemIds: [otherItemId] });
    expect(r.statusCode).toBe(403); // not the author: refused before any input is looked at
  });
});

describe("ADR-0316 distil, read gating and checkpoints", () => {
  let itemId: string;

  it("writes a governed, billed, provenance-tagged revision through the one context path", async () => {
    const usageBefore = await db.select().from(usageEvents).where(eq(usageEvents.projectId, projectId));
    const r = await distil(authorAuth, convoId);
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.key).toBe(`session/${convoId}`);
    expect(body.revision).toBe(1);
    expect(body.accepted).toBe(true);
    expect(body.turnsRead).toBe(4); // two user turns and two assistant turns
    itemId = body.id;

    const usageAfter = await db.select().from(usageEvents).where(eq(usageEvents.projectId, projectId));
    expect(usageAfter.length).toBe(usageBefore.length + 1); // the distillation dispatch is billed to the project

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, projectId), eq(auditLog.ruleId, "session-distilled")));
    expect(audits.length).toBe(1);
    expect(audits[0]!.userId).toBe(authorId);
    // the ordinary context-contribution audit row is written by the same path as any other contribution
    const contributed = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, projectId), eq(auditLog.ruleId, "project-context-contributed")));
    expect(contributed.some((a) => (a.detail as { key?: string }).key === `session/${convoId}`)).toBe(true);
  });

  it("shows the revision to the author and a reader who may use the session's agent", async () => {
    for (const auth of [authorAuth, peerAuth]) {
      const ctx = await readContext(auth);
      expect(ctx.statusCode).toBe(200);
      const entry = ctx.json().context.find((c: { key: string }) => c.key === `session/${convoId}`);
      expect(entry).toBeDefined();
      expect(entry.provenance.userId).toBe(authorId);
    }
    const prov = await app.inject({
      method: "GET",
      headers: peerAuth,
      url: `/v1/projects/${projectId}/context/items/${itemId}/distillation`,
    });
    expect(prov.statusCode).toBe(200);
    expect(prov.json().source.conversationId).toBe(convoId);
    expect(prov.json().inputs.agents.map((a: { agentId: string }) => a.agentId)).toContain(agentId);
    expect(prov.json().inputs.messageIds.length).toBe(4);
  });

  it("withholds it from a viewer who may not use the session's agent, on every read", async () => {
    const ctx = await readContext(outsiderAuth);
    expect(ctx.statusCode).toBe(200);
    expect(ctx.json().context.find((c: { key: string }) => c.key === `session/${convoId}`)).toBeUndefined();
    expect(ctx.json().withheld).toEqual([{ key: `session/${convoId}`, revision: 1 }]);

    const history = await app.inject({
      method: "GET",
      headers: outsiderAuth,
      url: `/v1/projects/${projectId}/context?key=${encodeURIComponent(`session/${convoId}`)}&history=true`,
    });
    expect(history.json().history).toEqual([]);
    expect(history.json().withheldRevisions).toBe(1);

    const graph = await app.inject({ method: "GET", headers: outsiderAuth, url: `/v1/projects/${projectId}/context/graph` });
    expect(graph.json().nodes.find((n: { id: string }) => n.id === itemId)).toBeUndefined();
    expect(graph.json().keys.find((k: { key: string }) => k.key === `session/${convoId}`).currentWithheld).toBe(true);

    const prov = await app.inject({
      method: "GET",
      headers: outsiderAuth,
      url: `/v1/projects/${projectId}/context/items/${itemId}/distillation`,
    });
    expect(prov.statusCode).toBe(404);
  });

  it("refuses a second distillation with no new turns, then reads only the turns since the checkpoint", async () => {
    const again = await distil(authorAuth, convoId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("nothing_to_distil");

    await sendTurn("e4: the reconciliation job belongs to the ledger team");
    // a declared input from a project the peer cannot read: the new revision is withheld from the peer
    const r = await distil(authorAuth, convoId, { contextInputItemIds: [otherItemId] });
    expect(r.statusCode).toBe(201);
    expect(r.json().revision).toBe(2);
    expect(r.json().turnsRead).toBe(2);

    const peer = await readContext(peerAuth);
    expect(peer.json().context.find((c: { key: string }) => c.key === `session/${convoId}`)).toBeUndefined();
    expect(peer.json().withheld).toEqual([{ key: `session/${convoId}`, revision: 2 }]);
    const author = await readContext(authorAuth);
    expect(author.json().context.find((c: { key: string }) => c.key === `session/${convoId}`).revision).toBe(2);
  });

  it("turning the switch off stops new distillations", async () => {
    const off = await app.inject({
      method: "PUT",
      headers: AUTH,
      url: `/v1/projects/${projectId}/session-distillation`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    await sendTurn("e4: one more turn after the switch went off");
    expect((await distil(authorAuth, convoId)).statusCode).toBe(409);
  });
});
