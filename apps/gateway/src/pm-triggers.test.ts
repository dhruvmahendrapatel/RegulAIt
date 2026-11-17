import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, pmLinks, pmWorkTriggers, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";

/**
 * ADR-0356 — work assigned from the PM tool (PR 1: the trigger path).
 *
 * Claims, through the real webhook route against a fake Jira receiver:
 *  1. Off by default: a connection without trigger settings ignores an assignment to the agent.
 *  2. Assigning an item to the agent user starts a workflow through the normal template assignment, AS the linked
 *     person, with the item's text read through (not stored) and the instance linked to the item.
 *  3. A replay of the same delivery is acknowledged and starts nothing; a second hand-over while one is open starts
 *     nothing.
 *  4. An unlinked person, and a linked person without the agent grant, are denied, and the item gets a comment
 *     saying why (the trigger then reads written_back).
 *  5. The lifecycle is enforced by the database: an undeclared move is refused.
 *  6. The admin routes are admin-only.
 *
 * Shares one database with the other gateway suites; objects are prefixed pmt-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "pmt-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const CONN = `pmt-jira-${RUN}`;
const CONN_OFF = `pmt-jira-off-${RUN}`;
const AGENT_ACCOUNT = "557058:pmt-regulait-agent";
const CHANGE_TYPE = `pmt-change-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let server: http.Server;
let allowHostId: string;
let secret: string;
let secretOff: string;
let agentId: string;
let alice: { id: string; auth: { authorization: string } };
let bob: { id: string; auth: { authorization: string } };
const comments: Array<{ id: string; body: string }> = [];

const assignment = (issueId: string, actor: string, to = AGENT_ACCOUNT) =>
  JSON.stringify({
    webhookEvent: "jira:issue_updated",
    timestamp: Date.now(),
    user: { accountId: actor },
    issue: { id: issueId, key: `PMT-${issueId}`, fields: { summary: "ignored: read through live" } },
    changelog: { items: [{ field: "assignee", fieldId: "assignee", from: null, to }] },
  });

const deliver = (connection: string, token: string, body: string, deliveryId?: string) =>
  app.inject({
    method: "POST",
    url: `/v1/pm/webhooks/${connection}?token=${encodeURIComponent(token)}`,
    headers: { "content-type": "application/json", ...(deliveryId ? { "x-atlassian-webhook-identifier": deliveryId } : {}) },
    payload: body,
  });

const triggersFor = async (externalId: string) =>
  db.select().from(pmWorkTriggers).where(eq(pmWorkTriggers.externalId, externalId)).orderBy(pmWorkTriggers.createdAt);

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "c".repeat(64) });

  // a fake Jira: GET an issue, POST a comment
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const m = /\/rest\/api\/2\/issue\/([^/]+)(\/comment)?$/.exec(req.url ?? "");
      if (!m) return void res.writeHead(404).end("{}");
      if (m[2] && req.method === "POST") {
        comments.push({ id: m[1]!, body: (JSON.parse(raw) as { body: string }).body });
        return void res.writeHead(201).end(JSON.stringify({ id: "c1" }));
      }
      if (m[1] === "unreadable") return void res.writeHead(500).end("{}");
      res.end(JSON.stringify({
        id: m[1],
        key: `PMT-${m[1]}`,
        fields: { summary: `Item ${m[1]} title`, description: `Item ${m[1]} details`, issuetype: { name: "Task" }, status: { name: "To Do" } },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/jira`;
  const allow = await relaxStepUpAround(db, () =>
    app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/egress-allow-hosts",
      payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "pm-triggers suite: fake Jira" },
    }),
  );
  expect(allow.statusCode, allow.body).toBe(201);
  allowHostId = allow.json().id as string;

  for (const name of [CONN, CONN_OFF]) {
    const c = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/connections",
      payload: { name, provider: "jira", project: "PMT", baseUrl: base, token: "bot@example.com:api-token" },
    });
    expect(c.statusCode, c.body).toBe(201);
    if (name === CONN) secret = c.json().webhookSecret as string;
    else secretOff = c.json().webhookSecret as string;
  }

  const mkUser = async (email: string) => {
    const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email, displayName: email.split("@")[0] } });
    const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "pmt" } });
    return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
  };
  alice = await mkUser(`pmt-alice-${RUN}@example.com`);
  bob = await mkUser(`pmt-bob-${RUN}@example.com`);
  const approver = await mkUser(`pmt-approver-${RUN}@example.com`);

  const agent = await app.inject({ method: "POST", headers: AUTH, url: "/v1/agents", payload: { name: `pmt-agent-${RUN}`, provider: "anthropic", tier: 1, modes: ["execute"] } });
  expect(agent.statusCode, agent.body).toBe(201);
  agentId = agent.json().id as string;
  // alice holds the agent; bob does not
  expect((await app.inject({ method: "POST", headers: AUTH, url: "/v1/grants/agents", payload: { userId: alice.id, agentId } })).statusCode).toBe(201);

  const tpl = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/workflows/templates",
    payload: { name: `pmt-template-${RUN}`, definition: { workflow: "pmt", stages: [
      { id: "intake", type: "trigger" },
      { id: "pmt_gate", type: "human_approval", approvers: [approver.id] },
    ] } },
  });
  expect(tpl.statusCode, tpl.body).toBe(201);
  const rule = await app.inject({ method: "POST", headers: AUTH, url: "/v1/workflows/assignment-rules", payload: { templateId: tpl.json().id, changeType: CHANGE_TYPE } });
  expect(rule.statusCode, rule.body).toBe(201);

  const put = await app.inject({
    method: "PUT",
    headers: AUTH,
    url: `/v1/pm/connections/${CONN}/trigger-settings`,
    payload: { enabled: true, agentIdentities: [AGENT_ACCOUNT], agentId, change: { changeType: CHANGE_TYPE, environment: "dev" } },
  });
  expect(put.statusCode, put.body).toBe(200);
  for (const [who, account] of [[alice, "557058:pmt-alice"], [bob, "557058:pmt-bob"]] as const) {
    const l = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/pm/identity-links",
      payload: { connectionName: CONN, pmUserId: account, email: `pmt-${who === alice ? "alice" : "bob"}-${RUN}@example.com` },
    });
    expect(l.statusCode, l.body).toBe(201);
  }
});

afterAll(async () => {
  (await removeEgressAllowEntry(app, AUTH, { id: allowHostId })).assertRemoved();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("ADR-0356 trigger path", () => {
  it("is off by default: a connection without settings ignores an assignment to the agent", async () => {
    const r = await deliver(CONN_OFF, secretOff, assignment(`off-${RUN}`, "557058:pmt-alice"));
    expect(r.statusCode, r.body).toBe(202);
    expect(await triggersFor(`off-${RUN}`)).toEqual([]);
  });

  it("an assignment to the agent starts the assigned workflow as the linked person, linked to the item", async () => {
    const id = `a-${RUN}`;
    const r = await deliver(CONN, secret, assignment(id, "557058:pmt-alice"), `d-${id}`);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().triggers).toEqual([expect.objectContaining({ externalId: id, mechanism: "assignment", state: "running" })]);
    const [t] = await triggersFor(id);
    expect(t).toMatchObject({ state: "running", userId: alice.id, actorPmUserId: "557058:pmt-alice" });
    const inst = await app.inject({ method: "GET", headers: alice.auth, url: `/v1/workflows/instances/${t!.instanceId}` });
    expect(inst.statusCode, inst.body).toBe(200);
    expect(inst.json().instance.initiatorUserId).toBe(alice.id);
    // the item's own text, read through at start (not the webhook's snapshot)
    expect(JSON.stringify(inst.json().instance)).toContain(`Item ${id} details`);
    const [link] = await db.select().from(pmLinks).where(and(eq(pmLinks.objectType, "workflow_instance"), eq(pmLinks.objectId, t!.instanceId!)));
    expect(link).toMatchObject({ externalId: id });

    // the same delivery again: acknowledged, never processed
    const replay = await deliver(CONN, secret, assignment(id, "557058:pmt-alice"), `d-${id}`);
    expect(replay.json()).toMatchObject({ duplicate: true });
    // a fresh hand-over while this one is open: recorded in the audit trail, nothing new started
    const again = await deliver(CONN, secret, assignment(id, "557058:pmt-alice"), `d2-${id}`);
    expect(again.json().triggers).toEqual([expect.objectContaining({ state: "duplicate" })]);
    expect(await triggersFor(id)).toHaveLength(1);
  });

  it("an unlinked person is denied and the item says why", async () => {
    const id = `u-${RUN}`;
    const r = await deliver(CONN, secret, assignment(id, "557058:pmt-stranger"));
    expect(r.json().triggers).toEqual([expect.objectContaining({ state: "written_back", outcomeCode: "not_linked" })]);
    const [t] = await triggersFor(id);
    expect(t).toMatchObject({ state: "written_back", outcomeCode: "not_linked", userId: null, instanceId: null });
    expect(comments.find((c) => c.id === id)?.body).toMatch(/not linked to a RegulAIt user/);
  });

  it("a linked person without the agent grant is denied and the item says why", async () => {
    const id = `b-${RUN}`;
    const r = await deliver(CONN, secret, assignment(id, "557058:pmt-bob"));
    expect(r.json().triggers).toEqual([expect.objectContaining({ state: "written_back", outcomeCode: "not_entitled" })]);
    const [t] = await triggersFor(id);
    expect(t).toMatchObject({ userId: bob.id, instanceId: null });
    expect(comments.find((c) => c.id === id)?.body).toMatch(/not entitled/);
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, t!.id), eq(auditLog.ruleId, "pm-trigger-denied")));
    expect(a?.effect).toBe("deny");
  });

  it("an item the tool cannot read fails with a reason, and the item can be handed over again", async () => {
    const r = await deliver(CONN, secret, assignment("unreadable", "557058:pmt-alice"), `d-unreadable-${RUN}`);
    expect(r.json().triggers).toEqual([expect.objectContaining({ state: "failed", outcomeCode: "item_unreadable" })]);
  });

  it("the database refuses a move the lifecycle table does not declare", async () => {
    const [t] = await triggersFor(`u-${RUN}`);
    await expect(db.execute(sql`UPDATE pm_work_triggers SET state = 'running' WHERE id = ${t!.id}`)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/cannot move from written_back to running/) }),
    });
  });

  it("the admin routes are admin-only", async () => {
    for (const [method, url] of [
      ["GET", `/v1/pm/connections/${CONN}/trigger-settings`],
      ["GET", "/v1/pm/identity-links"],
      ["GET", `/v1/pm/triggers?connectionName=${CONN}`],
    ] as const) {
      expect((await app.inject({ method, url, headers: alice.auth })).statusCode, url).toBe(403);
    }
    const list = await app.inject({ method: "GET", headers: AUTH, url: `/v1/pm/triggers?connectionName=${CONN}&limit=2` });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().triggers).toHaveLength(2);
    expect(list.json().nextBefore).toEqual(expect.any(String));
  });
});
