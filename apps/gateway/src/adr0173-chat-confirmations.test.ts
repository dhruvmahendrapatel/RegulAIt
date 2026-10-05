/**
 * ADR-0173 batch 2b — "Ask first" answered from Slack, and the Teams Bot
 * Framework endpoint, PROVED BY ATTACK.
 *
 * One local HTTP server plays Slack, the Entra login host + Bot Connector,
 * the OpenID metadata + JWKS of the bot platform, and the receiver a tool
 * writes to (a `webhook` connector): "the tool ran" is a body that reached its
 * socket, "the message was updated" is a `chat.update` that arrived.
 *
 * Global state (M-068): the egress allow entry for 127.0.0.1 is added only if
 * absent and removed only if this file added it; the JWKS cooldown env var is
 * restored afterwards.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import {
  and,
  auditLog,
  builderChannelThreads,
  builderStepChatPrompts,
  builderToolSteps,
  chatopsConnections,
  connectorCredentials,
  connectors,
  egressAllowHosts,
  eq,
  inArray,
  sql,
} from "@regulait/db";
import {
  SLACK_STEP_ACTION_IDS,
  composeApprovalCard,
  composeStepConfirmBlocks,
  escapeSlackText,
  slackSignature,
  teamsActivityForCard,
} from "@regulait/shared";
import { reservedChatControl } from "@regulait/connector-provider";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { drainBackgroundWork } from "./background-work.js";
import { resolveToolbox } from "./builder-tools.js";
import { builderAgents, builderMessages } from "@regulait/db";

let k: BuilderKit;
let admin: Person;
let owner: Person;
let colleague: Person;
let model = "";
let base = "";
let upstream: http.Server;
let createdEgressEntry = false;
const connectionIds: string[] = [];
const connectorIds: string[] = [];

const SECRET = "chat-confirmations-signing-secret";
const CHANNEL = "C-ASK";
/** what reached the fake chat platform (token exchanges excluded) */
const posted: Array<{ url: string; body: Record<string, any> }> = [];
/** what reached the tool's receiver */
const toolHits: string[] = [];
let jwksFetches = 0;
let metadataFetches = 0;
/** the stub OpenID metadata answers 503 while this is set */
let metadataDown = false;

let slackConn = "";
let slackConnId = "";
let slackConnectorId = "";
let pinnedSlackConn = "";
let pinnedSlackConnId = "";
let otherSlackConn = "";
let botConn = "";
let botConnId = "";
let pinnedBotConn = "";
let localhostBotConn = "";
let toolConnectorId = "";
let seq = 0;

// --- the bot platform's keys -------------------------------------------------
const ISSUER = "https://api.botframework.test";
const SERVICE_URL = "https://smba.example.test/teams/";
let APP_ID = "";
type Key = { kid: string; privateKey: CryptoKey; jwk: JWK };
const published: JWK[] = [];
async function newKey(kid: string, endorsements: string[] | null = ["msteams"]): Promise<Key> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig", ...(endorsements ? { endorsements } : {}) } as JWK;
  return { kid, privateKey, jwk };
}
let k1: Key;
let unpublished: Key;
let skypeOnly: Key;

const token = (key: Key, over: { aud?: string; iss?: string; exp?: string | number; serviceUrl?: string | null } = {}) => {
  const jwt = new SignJWT(over.serviceUrl === null ? {} : { serviceUrl: over.serviceUrl ?? SERVICE_URL })
    .setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
    .setIssuer(over.iss ?? ISSUER)
    .setAudience(over.aud ?? APP_ID)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
    .setExpirationTime(over.exp ?? "5m");
  return jwt.sign(key.privateKey);
};

const activity = (o: { user: string; text: string; tenant?: string; type?: string; serviceUrl?: string }) => {
  const id = `bot-act-${k.RUN}-${++seq}`;
  return {
    id,
    body: JSON.stringify({
      type: o.type ?? "message",
      id,
      timestamp: new Date().toISOString(),
      channelId: "msteams",
      serviceUrl: o.serviceUrl ?? SERVICE_URL,
      text: `<at>RegulAIt</at> ${o.text}`,
      from: { id: `29:${o.user}`, aadObjectId: o.user },
      conversation: { id: `a:personal-${k.RUN}-${o.user}`, tenantId: o.tenant ?? "tenant-A" },
      channelData: { tenant: { id: o.tenant ?? "tenant-A" } },
    }),
  };
};
const sendBot = (conn: string, body: string, authorization?: string) =>
  k.app.inject({
    method: "POST",
    url: `/v1/chatops/${conn}/bot`,
    headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    payload: body,
  });

// --- Slack -------------------------------------------------------------------
function slackHeaders(body: string, opts: { secondsAgo?: number; secret?: string; form?: boolean } = {}) {
  const ts = String(Math.floor(Date.now() / 1000) - (opts.secondsAgo ?? 0));
  return {
    "content-type": opts.form ? "application/x-www-form-urlencoded" : "application/json",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": slackSignature(opts.secret ?? SECRET, ts, body),
  };
}
const mention = async (conn: string, user: string, text: string, channel = CHANNEL) => {
  const ts = `${1787000000 + ++seq}.000${seq}`;
  const raw = JSON.stringify({
    type: "event_callback",
    team_id: "T1",
    event_id: `Ev-cc-${k.RUN}-${ts}`,
    event: { type: "app_mention", user, channel, ts, text: `<@UBOT> ${text}` },
  });
  const res = await k.app.inject({ method: "POST", url: `/v1/chatops/${conn}/events`, headers: slackHeaders(raw), payload: raw });
  expect(res.statusCode, res.body).toBe(200);
  await drainBackgroundWork(k.db);
  return ts;
};
type ClickOpts = { secret?: string; secondsAgo?: number; team?: string | null; sectionText?: string };
const clickBody = (user: string, promptId: string, answer: "approve" | "deny", opts: ClickOpts = {}) =>
  new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: user },
      ...(opts.team === null ? {} : { team: { id: opts.team ?? "T1" } }),
      container: { message_ts: "1785.1" },
      channel: { id: CHANNEL },
      // what the click carries back of the message is NOT what the answered
      // message is rebuilt from (batch 2b review): it could say anything
      message: { blocks: [{ type: "section", text: { type: "mrkdwn", text: opts.sectionText ?? "Let me send that." } }] },
      actions: [{ action_id: SLACK_STEP_ACTION_IDS[answer], value: promptId }],
    }),
  }).toString();
const click = (conn: string, user: string, promptId: string, answer: "approve" | "deny", opts: ClickOpts = {}) => {
  const body = clickBody(user, promptId, answer, opts);
  return k.app.inject({
    method: "POST",
    url: `/v1/chatops/${conn}/interactions`,
    headers: slackHeaders(body, { ...opts, form: true }),
    payload: body,
  });
};

const toolArgs = (note: string) =>
  Buffer.from(JSON.stringify({ operation: "write", object: "inbox", payload: { note } })).toString("base64");
const repliesIn = (ts: string) => posted.filter((p) => p.url === "/chat.postMessage" && p.body.thread_ts === ts);
const updates = () => posted.filter((p) => p.url === "/chat.update");
const stepRow = async (id: string) => (await k.db.select().from(builderToolSteps).where(eq(builderToolSteps.id, id)))[0]!;
const promptFor = async (stepId: string) =>
  (await k.db.select().from(builderStepChatPrompts).where(eq(builderStepChatPrompts.stepId, stepId)))[0];
const auditOf = async (ruleId: string, promptId: string) =>
  k.db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), sql`${auditLog.detail}->>'stepPromptId' = ${promptId}`));

async function makeConnection(provider: "slack" | "teams", label: string, extra: Record<string, unknown>) {
  const conn = await k.req("POST", "/v1/connectors", k.BOOT, {
    name: `cc-${label}-connector-${k.RUN}`,
    kind: "chat",
    providerKind: provider,
    baseUrl: base,
  });
  expect(conn.statusCode, conn.body).toBe(201);
  connectorIds.push(conn.json().id);
  const tokenValue = provider === "teams" ? JSON.stringify({ appId: "app", appPassword: "pw", loginBaseUrl: base }) : "xoxb-test";
  const cred = await k.req("POST", `/v1/connectors/${conn.json().id}/credential`, k.BOOT, { token: tokenValue });
  expect(cred.statusCode, cred.body).toBeLessThan(300);
  const name = `cc-${label}-${k.RUN}`;
  const created = await k.req("POST", "/v1/chatops/connections", k.BOOT, {
    name,
    provider,
    connectorId: conn.json().id,
    defaultChannel: CHANNEL,
    ...extra,
  });
  expect(created.statusCode, created.body).toBe(201);
  connectionIds.push(created.json().id);
  return { name, id: created.json().id as string, connectorId: conn.json().id as string };
}
const link = async (connName: string, chatUserId: string, who: Person, label: string) => {
  const r = await k.req("POST", "/v1/chatops/identity-links", k.BOOT, {
    connectionName: connName,
    chatUserId,
    email: `p2bl-chat-${label}-${k.RUN}@example.com`,
  });
  expect(r.statusCode, r.body).toBe(201);
  expect(r.json().userId).toBe(who.id);
};

/** an agent whose one tool (a connector write) is marked "Ask first" */
async function askFirstAgent(by: Person, projectId?: string) {
  const r = await k.req("POST", "/v1/builder/agents", by.auth, {
    name: `Ask agent ${Math.random().toString(36).slice(2, 7)}`,
    connectionFormat: "shared",
    computerUse: false,
    modelAgentId: model,
    projectId: projectId ?? by.projectId,
  });
  expect(r.statusCode, r.body).toBe(201);
  const id = r.json().agent.id as string;
  const t = await k.req("PUT", `/v1/builder/agents/${id}/tools`, by.auth, {
    tools: [{ kind: "connector", refId: toolConnectorId, requiresApproval: true }],
  });
  expect(t.statusCode, t.body).toBe(200);
  const [row] = await k.db.select().from(builderAgents).where(eq(builderAgents.id, id));
  const box = await resolveToolbox(k.db, row!, by.id);
  return { id, toolName: box.entries[0]!.name };
}
async function routeSlack(agentId: string, connId: string, channel: string | null) {
  const b = await k.req("POST", `/v1/builder/agents/${agentId}/channels`, admin.auth, { provider: "slack", chatopsConnectionId: connId });
  expect(b.statusCode, b.body).toBe(201);
  const routed = await k.req("PUT", `/v1/chatops/builder-routes/${b.json().id}`, k.BOOT, { externalChannelId: channel });
  expect(routed.statusCode, routed.body).toBe(200);
}

/** run a paused turn in Slack: the message with buttons, its prompt and step */
async function pausedInSlack(agent: { toolName: string }, note: string, channel = CHANNEL) {
  const ts = await mention(slackConn, "U-OWNER", `send it <<use-tool:${agent.toolName}>> <<use-tool-args:${toolArgs(note)}>>`, channel);
  const [reply] = repliesIn(ts);
  expect(reply, JSON.stringify(posted.slice(-3))).toBeTruthy();
  const [map] = await k.db.select().from(builderChannelThreads).where(eq(builderChannelThreads.externalThreadId, ts));
  const [step] = await k.db.select().from(builderToolSteps).where(eq(builderToolSteps.threadId, map!.builderThreadId));
  return { ts, reply: reply!, step: step!, prompt: await promptFor(step!.id) };
}

let agent: { id: string; toolName: string };

beforeAll(async () => {
  process.env.REGULAIT_TEAMS_BOT_JWKS_COOLDOWN_SECONDS = "0";
  k = await builderKit("p2bl-chat");
  APP_ID = `bot-app-${k.RUN}`;
  admin = await k.person("admin", { admin: true });
  owner = await k.person("owner");
  colleague = await k.person("colleague");
  model = await k.model("m", { price: 1 });
  for (const p of [owner, colleague, admin]) await k.grantModel(p.id, model);
  const seat = await k.req("POST", `/v1/projects/${owner.projectId}/members`, k.BOOT, { userId: colleague.id, role: "contributor" });
  expect(seat.statusCode, seat.body).toBeLessThan(300);

  k1 = await newKey("k1");
  unpublished = await newKey("k-unpublished");
  skypeOnly = await newKey("k-skype", ["skype"]);
  published.push(k1.jwk, skypeOnly.jwk);

  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.includes("/oauth2/v2.0/token")) return json(200, { token_type: "Bearer", expires_in: 3600, access_token: "test-jwt" });
      if (url === "/openid") {
        metadataFetches += 1;
        return metadataDown ? json(503, { error: "down" }) : json(200, { issuer: ISSUER, jwks_uri: `${base}/jwks` });
      }
      if (url === "/jwks") {
        jwksFetches += 1;
        return json(200, { keys: published });
      }
      if (url === "/collect") {
        toolHits.push(raw);
        return json(200, { received: true });
      }
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = { raw };
      }
      posted.push({ url, body });
      json(200, { ok: true, ts: `1785.${posted.length}`, id: `reply-${posted.length}` });
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const addr = upstream.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;

  const [existing] = await k.db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  if (!existing) {
    const allow = await k.req("POST", "/v1/egress-allow-hosts", k.BOOT, {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "chat confirmations suite: local fake platform",
    });
    expect([200, 201]).toContain(allow.statusCode);
    createdEgressEntry = true;
  }

  // the tool: a webhook connector the owner and admin may write to
  const tool = await k.req("POST", "/v1/connectors", k.BOOT, {
    name: `cc-tool-${k.RUN}`,
    kind: "notifications",
    providerKind: "webhook",
    baseUrl: `${base}/collect`,
  });
  expect(tool.statusCode, tool.body).toBe(201);
  toolConnectorId = tool.json().id;
  connectorIds.push(toolConnectorId);
  for (const p of [owner, admin, colleague]) {
    const g = await k.req("POST", "/v1/grants/connectors", k.BOOT, { userId: p.id, connectorId: toolConnectorId, mode: "readwrite" });
    expect(g.statusCode, g.body).toBeLessThan(300);
  }

  ({ name: slackConn, id: slackConnId, connectorId: slackConnectorId } = await makeConnection("slack", "slack", { signingSecret: SECRET }));
  ({ name: otherSlackConn } = await makeConnection("slack", "other", { signingSecret: SECRET }));
  // a bot-only Teams workspace: no signing secret, the bot's tokens prove it
  ({ name: botConn, id: botConnId } = await makeConnection("teams", "bot", { botAppId: APP_ID, botOpenidMetadataUrl: `${base}/openid` }));
  ({ name: pinnedBotConn } = await makeConnection("teams", "pinned", {
    botAppId: APP_ID,
    botTenantId: "tenant-A",
    botOpenidMetadataUrl: `${base}/openid`,
  }));
  // the metadata host here is NOT on the egress allow-list
  ({ name: localhostBotConn } = await makeConnection("teams", "lh", {
    botAppId: APP_ID,
    botOpenidMetadataUrl: `${base.replace("127.0.0.1", "localhost")}/openid`,
  }));
  // batch 2b review: a Slack workspace pinned to one team (created last: the
  // tests above index `connectionIds`)
  ({ name: pinnedSlackConn, id: pinnedSlackConnId } = await makeConnection("slack", "pinslack", { signingSecret: SECRET, slackTeamId: "TPINNED" }));
  await link(slackConn, "U-OWNER", owner, "owner");
  await link(slackConn, "U-COLLEAGUE", colleague, "colleague");
  await link(slackConn, "U-ADMIN", admin, "admin");
  await link(otherSlackConn, "U-OWNER", owner, "owner");
  await link(botConn, "aad-owner", owner, "owner");
  await link(pinnedBotConn, "aad-owner", owner, "owner");

  agent = await askFirstAgent(owner);
  await routeSlack(agent.id, slackConnId, CHANNEL);
  const tb = await k.req("POST", `/v1/builder/agents/${agent.id}/channels`, admin.auth, { provider: "teams", chatopsConnectionId: botConnId });
  expect(tb.statusCode, tb.body).toBe(201);
  const pinnedId = connectionIds[3]!;
  const tp = await k.req("POST", `/v1/builder/agents/${agent.id}/channels`, admin.auth, { provider: "teams", chatopsConnectionId: pinnedId });
  expect(tp.statusCode, tp.body).toBe(201);
}, 120_000);

afterAll(async () => {
  await drainBackgroundWork(k.db);
  delete process.env.REGULAIT_TEAMS_BOT_JWKS_COOLDOWN_SECONDS;
  if (connectionIds.length) await k.db.delete(chatopsConnections).where(inArray(chatopsConnections.id, connectionIds));
  if (connectorIds.length) {
    await k.db.delete(connectorCredentials).where(inArray(connectorCredentials.connectorId, connectorIds));
    await k.db.delete(connectors).where(inArray(connectors.id, connectorIds));
  }
  if (createdEgressEntry) await k.db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await k.close();
});

describe("Slack: an \"Ask first\" pause carries Approve / Deny", () => {
  it("the pause message has the two buttons, bound to a prompt record for that step on that workspace", async () => {
    const p = await pausedInSlack(agent, `buttons-${k.RUN}`);
    expect(p.step.status).toBe("pending_confirmation");
    expect(p.prompt).toMatchObject({ connectionId: slackConnId, channel: CHANNEL, messageRef: expect.any(String), answeredAt: null });
    const actions = (p.reply.body.blocks as any[]).find((b) => b.type === "actions");
    expect(actions.elements.map((e: any) => [e.action_id, e.value])).toEqual([
      [SLACK_STEP_ACTION_IDS.approve, p.prompt!.id],
      [SLACK_STEP_ACTION_IDS.deny, p.prompt!.id],
    ]);
    // the notification text is unchanged (it still links to RegulAIt)
    expect(p.reply.body.text).toContain("Waiting for your confirmation in RegulAIt");
  });

  it("approve: the thread's own person runs the identical call ONCE, the message is updated, the reply posted; a second click is 409", async () => {
    const p = await pausedInSlack(agent, `approve-${k.RUN}`);
    const before = toolHits.length;
    const r = await click(slackConn, "U-OWNER", p.prompt!.id, "approve");
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, answer: "approve" });
    await drainBackgroundWork(k.db);
    expect(toolHits.length).toBe(before + 1);
    expect(toolHits.at(-1)).toContain(`approve-${k.RUN}`);
    expect(await stepRow(p.step.id)).toMatchObject({ status: "done", decidedByUserId: owner.id });
    const upd = updates().find((u) => u.body.ts === p.prompt!.messageRef)!;
    expect(upd, "the button message was rewritten").toBeTruthy();
    expect(upd.body.channel).toBe(CHANNEL);
    expect((upd.body.blocks as any[]).some((b) => b.type === "actions")).toBe(false);
    expect(JSON.stringify(upd.body.blocks)).toContain("Approved by");
    expect(repliesIn(p.ts).length).toBeGreaterThanOrEqual(2); // the resumed turn's reply
    expect(await promptFor(p.step.id)).toMatchObject({ answer: "approve", answeredByUserId: owner.id });
    expect(await auditOf("builder-channel-step-answered", p.prompt!.id)).toHaveLength(1);

    // claimed once: a second answer (even the other one) is refused and runs nothing
    const again = await click(slackConn, "U-OWNER", p.prompt!.id, "deny");
    expect(again.statusCode).toBe(409);
    await drainBackgroundWork(k.db);
    expect(toolHits.length).toBe(before + 1);
  });

  it("two answers racing (a double-click, or approve and deny at once): exactly one is taken", async () => {
    const p = await pausedInSlack(agent, `race-${k.RUN}`);
    const before = toolHits.length;
    const [a, b] = await Promise.all([
      click(slackConn, "U-OWNER", p.prompt!.id, "approve"),
      click(slackConn, "U-OWNER", p.prompt!.id, "deny"),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().error).toBe("already_answered");
    await drainBackgroundWork(k.db);
    const winner = (a.statusCode === 200 ? a : b).json().answer as string;
    expect(await stepRow(p.step.id)).toMatchObject({ status: winner === "approve" ? "done" : "denied" });
    expect(toolHits.length).toBe(before + (winner === "approve" ? 1 : 0));
    expect(await auditOf("builder-channel-step-answered", p.prompt!.id)).toHaveLength(1);
  });

  it("deny: the model is told and the tool never runs", async () => {
    const p = await pausedInSlack(agent, `deny-${k.RUN}`);
    const before = toolHits.length;
    const r = await click(slackConn, "U-OWNER", p.prompt!.id, "deny");
    expect(r.statusCode, r.body).toBe(200);
    await drainBackgroundWork(k.db);
    expect(await stepRow(p.step.id)).toMatchObject({ status: "denied", outcomeCode: "declined_by_user" });
    expect(toolHits.length).toBe(before);
    expect(JSON.stringify(updates().find((u) => u.body.ts === p.prompt!.messageRef)?.body.blocks)).toContain("Denied by");
  });

  it("only the thread's own person: another LINKED person (even an admin) and an unlinked user are refused, audited, and nothing runs", async () => {
    const p = await pausedInSlack(agent, `who-${k.RUN}`);
    const before = toolHits.length;
    const colleagueClick = await click(slackConn, "U-COLLEAGUE", p.prompt!.id, "approve");
    expect(colleagueClick.statusCode).toBe(403);
    expect(colleagueClick.json().error).toBe("not_thread_person");
    const adminClick = await click(slackConn, "U-ADMIN", p.prompt!.id, "approve");
    expect(adminClick.statusCode).toBe(403);
    expect(adminClick.json().error).toBe("not_thread_person");
    const unlinked = await click(slackConn, "U-NOBODY", p.prompt!.id, "approve");
    expect(unlinked.statusCode).toBe(403);
    expect(unlinked.json().error).toBe("unmapped_chat_identity");
    await drainBackgroundWork(k.db);
    expect(toolHits.length).toBe(before);
    expect(await stepRow(p.step.id)).toMatchObject({ status: "pending_confirmation" });
    expect(await promptFor(p.step.id)).toMatchObject({ answeredAt: null });
    expect(await auditOf("builder-channel-step-refused-not-thread-person", p.prompt!.id)).toHaveLength(2);
    expect(await auditOf("builder-channel-step-refused-unlinked-identity", p.prompt!.id)).toHaveLength(1);
    // and the right person still can
    expect((await click(slackConn, "U-OWNER", p.prompt!.id, "deny")).statusCode).toBe(200);
    await drainBackgroundWork(k.db);
  });

  it("the signature and replay window come first; a prompt names nothing on another workspace", async () => {
    const p = await pausedInSlack(agent, `walls-${k.RUN}`);
    const forged = await click(slackConn, "U-OWNER", p.prompt!.id, "approve", { secret: "not-the-secret" });
    expect(forged.statusCode).toBe(401);
    expect(forged.json().code).toBe("bad_signature");
    const replayed = await click(slackConn, "U-OWNER", p.prompt!.id, "approve", { secondsAgo: 400 });
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json().code).toBe("stale_timestamp");
    // the same person, linked on another workspace, clicking there
    const elsewhere = await click(otherSlackConn, "U-OWNER", p.prompt!.id, "approve");
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.json().error).toBe("unknown_prompt");
    expect(await stepRow(p.step.id)).toMatchObject({ status: "pending_confirmation" });
    expect(await promptFor(p.step.id)).toMatchObject({ answeredAt: null });
    expect((await click(slackConn, "U-OWNER", p.prompt!.id, "deny")).statusCode).toBe(200);
    await drainBackgroundWork(k.db);
  });

  it("answered in the web app first: the click is 409 and the buttons are retired", async () => {
    const p = await pausedInSlack(agent, `web-first-${k.RUN}`);
    const web = await k.req("POST", `/v1/builder/threads/${p.step.threadId}/steps/${p.step.id}/confirm`, owner.auth, { decision: "deny" });
    expect(web.statusCode, web.body).toBe(200);
    await drainBackgroundWork(k.db);
    const r = await click(slackConn, "U-OWNER", p.prompt!.id, "approve");
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe("step_not_pending");
    await drainBackgroundWork(k.db);
    expect(JSON.stringify(updates().find((u) => u.body.ts === p.prompt!.messageRef)?.body.blocks)).toContain("No longer waiting");
    expect(await promptFor(p.step.id)).toMatchObject({ answeredAt: null });
  });

  it("the answered message is rebuilt from the stored reply, never from what the click carries back (batch 2b review)", async () => {
    const p = await pausedInSlack(agent, `rebuilt-${k.RUN}`);
    const r = await click(slackConn, "U-OWNER", p.prompt!.id, "deny", { sectionText: "<!channel> FORGED: the payment was approved" });
    expect(r.statusCode, r.body).toBe(200);
    await drainBackgroundWork(k.db);
    const upd = updates().find((u) => u.body.ts === p.prompt!.messageRef)!;
    expect(upd, "the button message was rewritten").toBeTruthy();
    const shown = JSON.stringify(upd.body.blocks);
    expect(shown).not.toContain("FORGED");
    expect(shown).not.toContain("<!channel>");
    // what RegulAIt stored for that step: the agent's reply, made inert once
    const [stored] = await k.db.select().from(builderMessages).where(eq(builderMessages.id, p.step.messageId));
    expect(stored!.content.trim().length).toBeGreaterThan(0);
    expect(shown).toContain(JSON.stringify(escapeSlackText(stored!.content.trim().slice(0, 40))).slice(1, -1));
    expect(shown).toContain("Denied by");
  });

  it("a resume that fails is not reported as approved: the claim is released and the message says what happened (batch 2b review)", async () => {
    // a dedicated agent on its own channel, so breaking it touches no other test
    const failing = await askFirstAgent(owner);
    const failChannel = `C-FAIL-${k.RUN}`;
    await routeSlack(failing.id, slackConnId, failChannel);
    const p = await pausedInSlack(failing, `resume-fails-${k.RUN}`, failChannel);
    // the agent loses its model between the pause and the answer: the resume's gate refuses
    await k.db.update(builderAgents).set({ modelAgentId: null }).where(eq(builderAgents.id, failing.id));
    const before = toolHits.length;
    const r = await click(slackConn, "U-OWNER", p.prompt!.id, "approve");
    expect(r.statusCode, r.body).toBe(200);
    await drainBackgroundWork(k.db);
    expect(toolHits.length).toBe(before);
    expect(await stepRow(p.step.id)).toMatchObject({ status: "refused" });
    // the answer was not applied, so the prompt holds none
    expect(await promptFor(p.step.id)).toMatchObject({ answeredAt: null, answeredByUserId: null, answer: null });
    const msgUpdates = updates().filter((u) => u.body.ts === p.prompt!.messageRef);
    expect(msgUpdates).toHaveLength(1);
    const shown = JSON.stringify(msgUpdates[0]!.body.blocks);
    expect(shown).toContain("did not resume (builder_agent_has_no_model)");
    expect(shown).toContain("This step is refused");
    expect(shown).not.toContain("The agent continues");
    expect(await auditOf("builder-channel-step-resume-failed", p.prompt!.id)).toHaveLength(1);
  });

  it("an agent whose project blocks sensitive content: no buttons, and a click on its prompt is refused", async () => {
    const tag = `p2bl-chat-block-${k.RUN}`;
    expect((await k.req("POST", "/v1/compliance/profiles", k.BOOT, { tag, piiMode: "block" })).statusCode).toBeLessThan(300);
    const proj = await k.req("POST", "/v1/projects", k.BOOT, { name: `p2bl-chat-fenced-${k.RUN}`, classifications: [tag] });
    expect(proj.statusCode, proj.body).toBe(201);
    const fencedAgent = await askFirstAgent(admin, proj.json().id);
    const fencedChannel = `C-FENCED-${k.RUN}`;
    await routeSlack(fencedAgent.id, slackConnId, fencedChannel);
    const ts = await mention(slackConn, "U-ADMIN", `send it <<use-tool:${fencedAgent.toolName}>> <<use-tool-args:${toolArgs("f")}>>`, fencedChannel);
    const [reply] = repliesIn(ts);
    expect(reply!.body.blocks).toBeUndefined();
    const [map] = await k.db.select().from(builderChannelThreads).where(eq(builderChannelThreads.externalThreadId, ts));
    const [step] = await k.db.select().from(builderToolSteps).where(eq(builderToolSteps.threadId, map!.builderThreadId));
    expect(step!.status).toBe("pending_confirmation");
    expect(await promptFor(step!.id)).toBeUndefined();
    // a prompt that exists anyway (posted before the classification changed) is refused by the fence
    const [planted] = await k.db
      .insert(builderStepChatPrompts)
      .values({ stepId: step!.id, connectionId: slackConnId, channel: fencedChannel, messageRef: "1785.9" })
      .returning();
    const r = await click(slackConn, "U-ADMIN", planted!.id, "approve");
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("chat_decide_not_permitted_for_sensitivity");
    expect(await stepRow(step!.id)).toMatchObject({ status: "pending_confirmation" });
  });
});

describe("the product's own chat controls are not a connector call's to use (batch 2b review)", () => {
  const invoke = (who: Person, payload: Record<string, unknown>) =>
    k.req("POST", `/v1/connectors/${slackConnectorId}/invoke`, who.auth, { operation: "write", object: CHANNEL, payload });
  const reservedAudits = async (userId: string) =>
    k.db.select().from(auditLog).where(and(eq(auditLog.ruleId, "connector-reserved-chat-control"), eq(auditLog.userId, userId)));

  beforeAll(async () => {
    const g = await k.req("POST", "/v1/grants/connectors", k.BOOT, { userId: owner.id, connectorId: slackConnectorId, mode: "readwrite" });
    expect(g.statusCode, g.body).toBeLessThan(300);
  });

  it("every control the product posts is caught by the reserved-control check (the prefix stays in sync)", () => {
    const step = composeStepConfirmBlocks({ text: "t", toolLabel: "x", promptId: "00000000-0000-4000-8000-000000000001" });
    expect(reservedChatControl("slack", "write", { blocks: step })?.code).toBe("reserved_chat_control");
    const card = composeApprovalCard({ approvalId: "00000000-0000-4000-8000-000000000002", objectType: "mcp_tool", portalUrl: "/x", fenced: false, decidable: true });
    expect(reservedChatControl("slack", "write", { blocks: card.blocks })?.code).toBe("reserved_chat_control");
    expect(reservedChatControl("teams", "write", teamsActivityForCard(card))?.code).toBe("reserved_chat_control");
  });

  it("a direct caller with a Slack write grant cannot rewrite a message or post a look-alike card: refused (403, audited), nothing reaches Slack", async () => {
    const p = await pausedInSlack(agent, `governed-${k.RUN}`);
    const before = posted.length;
    const rewrite = await invoke(owner, { op: "chat.update", ts: p.prompt!.messageRef, text: "Approved by your manager" });
    expect(rewrite.statusCode, rewrite.body).toBe(403);
    expect(rewrite.json().error).toBe("chat_update_internal_only");
    const fakeStepCard = await invoke(owner, {
      text: "Routine check",
      blocks: [{ type: "actions", elements: [{ type: "button", action_id: SLACK_STEP_ACTION_IDS.approve, value: p.prompt!.id, text: { type: "plain_text", text: "OK" } }] }],
    });
    expect(fakeStepCard.statusCode, fakeStepCard.body).toBe(403);
    expect(fakeStepCard.json().error).toBe("reserved_chat_control");
    const fakeApprovalCard = await invoke(owner, { text: "x", attachments: [{ callback_id: "regulait_approve" }] });
    expect(fakeApprovalCard.statusCode).toBe(403);
    expect(posted.length).toBe(before);
    expect((await reservedAudits(owner.id)).length).toBeGreaterThanOrEqual(3);
    // the grant itself works: an ordinary message goes out
    const plain = await invoke(owner, { text: `hello ${k.RUN}` });
    expect(plain.statusCode, plain.body).toBe(200);
    expect(posted.length).toBe(before + 1);
    expect((await click(slackConn, "U-OWNER", p.prompt!.id, "deny")).statusCode).toBe(200);
    await drainBackgroundWork(k.db);
  });

  it("the builder tool path: an agent (or a prompt injection steering it) is refused the same way, and the model is told", async () => {
    const r = await k.req("POST", "/v1/builder/agents", owner.auth, {
      name: `Slack writer ${Math.random().toString(36).slice(2, 7)}`,
      connectionFormat: "shared",
      computerUse: false,
      modelAgentId: model,
      projectId: owner.projectId,
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().agent.id as string;
    const t = await k.req("PUT", `/v1/builder/agents/${id}/tools`, owner.auth, {
      tools: [{ kind: "connector", refId: slackConnectorId, requiresApproval: false }],
    });
    expect(t.statusCode, t.body).toBe(200);
    const [row] = await k.db.select().from(builderAgents).where(eq(builderAgents.id, id));
    const toolName = (await resolveToolbox(k.db, row!, owner.id)).entries[0]!.name;
    const before = posted.length;
    for (const [payload, code] of [
      [{ op: "chat.update", ts: "1785.1", text: "Approved" }, "chat_update_internal_only"],
      [{ text: "x", blocks: [{ type: "actions", block_id: "regulait_step", elements: [] }] }, "reserved_chat_control"],
    ] as const) {
      const args = Buffer.from(JSON.stringify({ operation: "write", object: CHANNEL, payload })).toString("base64");
      const turn = await k.req("POST", `/v1/builder/agents/${id}/chat`, owner.auth, { message: `do it <<use-tool:${toolName}>> <<use-tool-args:${args}>>` });
      expect(turn.statusCode, turn.body).toBe(200);
      const detail = (await k.req("GET", `/v1/builder/threads/${turn.json().thread.id}`, owner.auth)).json();
      const step = (detail.messages as Array<{ steps: any[] }>).flatMap((m) => m.steps)[0];
      expect(step, JSON.stringify(detail.messages)).toMatchObject({ kind: "connector", status: "denied", outcomeCode: code });
    }
    expect(posted.length).toBe(before);
  });
});

describe("the Slack workspace pin (batch 2b review)", () => {
  const event = (team: string | null) => {
    const ts = `${1788000000 + ++seq}.000${seq}`;
    return JSON.stringify({
      type: "event_callback",
      ...(team ? { team_id: team } : {}),
      event_id: `Ev-pin-${k.RUN}-${ts}`,
      event: { type: "app_mention", user: "U-OWNER", channel: CHANNEL, ts, text: "<@UBOT> hi" },
    });
  };
  const sendEvent = (raw: string) =>
    k.app.inject({ method: "POST", url: `/v1/chatops/${pinnedSlackConn}/events`, headers: slackHeaders(raw), payload: raw });
  const refusals = async () =>
    k.db.select().from(auditLog).where(and(eq(auditLog.ruleId, "chatops-slack-refused-team"), eq(auditLog.objectId, pinnedSlackConnId)));

  it("a signed event or click from another team (or naming none) is refused, audited, and runs nothing; the pinned team passes", async () => {
    const before = { posted: posted.length, refusals: (await refusals()).length };
    for (const team of ["TOTHER", null]) {
      const r = await sendEvent(event(team));
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json().error).toBe("team_not_allowed");
    }
    const strangerClick = await click(pinnedSlackConn, "U-OWNER", "00000000-0000-4000-8000-000000000009", "approve", { team: "TOTHER" });
    expect(strangerClick.statusCode).toBe(403);
    expect(strangerClick.json().error).toBe("team_not_allowed");
    await drainBackgroundWork(k.db);
    expect(posted.length).toBe(before.posted);
    expect((await refusals()).length).toBe(before.refusals + 3);
    // the pinned team gets through the pin (to whatever comes next)
    const ok = await sendEvent(event("TPINNED"));
    expect(ok.statusCode, ok.body).toBe(200);
    const pinnedClick = await click(pinnedSlackConn, "U-OWNER", "00000000-0000-4000-8000-000000000009", "approve", { team: "TPINNED" });
    expect(pinnedClick.statusCode).toBe(404);
    expect(pinnedClick.json().error).toBe("unknown_prompt");
    // Slack's URL handshake names no team and runs nothing: still answered
    const hs = JSON.stringify({ type: "url_verification", challenge: "c-1" });
    const handshake = await sendEvent(hs);
    expect(handshake.statusCode, handshake.body).toBe(200);
    expect(handshake.json().challenge).toBe("c-1");
    await drainBackgroundWork(k.db);
  });

  it("an unpinned workspace accepts any team (the pin is opt-in)", async () => {
    const r = await click(slackConn, "U-OWNER", "00000000-0000-4000-8000-000000000009", "approve", { team: "TANY" });
    expect(r.statusCode).toBe(404);
  });

  it("the pin is admin-set, slack only, and audited when changed", async () => {
    const conns = (await k.req("GET", "/v1/chatops/connections", k.BOOT)).json().connections as any[];
    expect(conns.find((c) => c.name === pinnedSlackConn)).toMatchObject({ slackTeamId: "TPINNED" });
    const onTeams = await k.req("PATCH", `/v1/chatops/connections/${botConnId}`, k.BOOT, { slackTeamId: "T1" });
    expect(onTeams.statusCode).toBe(400);
    expect(onTeams.json().error).toBe("slack_team_slack_only");
    expect((await k.req("PATCH", `/v1/chatops/connections/${pinnedSlackConnId}`, owner.auth, { slackTeamId: "T1" })).statusCode).toBe(403);
    const changed = await k.req("PATCH", `/v1/chatops/connections/${pinnedSlackConnId}`, k.BOOT, { slackTeamId: "TNEW" });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().slackTeamId).toBe("TNEW");
    const audits = await k.db.select().from(auditLog).where(and(eq(auditLog.ruleId, "chatops-slack-team-changed"), eq(auditLog.objectId, pinnedSlackConnId)));
    expect(audits).toHaveLength(1);
    expect((await k.req("PATCH", `/v1/chatops/connections/${pinnedSlackConnId}`, k.BOOT, { slackTeamId: "TPINNED" })).statusCode).toBe(200);
    const teamsPinned = await k.req("POST", "/v1/chatops/connections", k.BOOT, {
      name: `cc-teams-team-${k.RUN}`,
      provider: "teams",
      connectorId: connectorIds[3], // the bot workspace's teams connector
      defaultChannel: CHANNEL,
      signingSecret: SECRET,
      slackTeamId: "T1",
    });
    expect(teamsPinned.statusCode).toBe(400);
    expect(teamsPinned.json().error).toBe("slack_team_slack_only");
  });
});

describe("Teams: the Bot Framework endpoint", () => {
  it("a valid token: the turn runs as the linked person and the reply goes out through the connector", async () => {
    const a = activity({ user: "aad-owner", text: "hello bot" });
    const before = posted.length;
    const r = await sendBot(botConn, a.body, `Bearer ${await token(k1)}`);
    expect(r.statusCode, r.body).toBe(200);
    await drainBackgroundWork(k.db);
    const reply = posted.slice(before).find((p) => p.url.includes(`/activities/${encodeURIComponent(a.id)}`));
    expect(reply, JSON.stringify(posted.slice(before))).toBeTruthy();
    expect(reply!.body.text).toBeTruthy();
    const [map] = await k.db.select().from(builderChannelThreads).where(eq(builderChannelThreads.externalThreadId, `a:personal-${k.RUN}-aad-owner`));
    expect(map).toMatchObject({ userId: owner.id, agentId: agent.id });
  });

  it("refuses with a bare 401 a missing, mis-addressed, mis-issued, expired, unknown-key, unendorsed or wrong-service token — and runs nothing", async () => {
    const cases: Array<[string, string | undefined, string]> = [
      ["no token", undefined, "missing_token"],
      ["not bearer", "Basic abc", "missing_token"],
      ["another bot's token", `Bearer ${await token(k1, { aud: "someone-else" })}`, "wrong_audience"],
      ["another issuer", `Bearer ${await token(k1, { iss: "https://evil.test" })}`, "wrong_issuer"],
      ["expired", `Bearer ${await token(k1, { exp: Math.floor(Date.now() / 1000) - 3600 })}`, "expired_token"],
      ["an unpublished key", `Bearer ${await token(unpublished)}`, "unknown_signing_key"],
      ["a key endorsed for another channel", `Bearer ${await token(skypeOnly)}`, "key_not_endorsed"],
      ["another service", `Bearer ${await token(k1, { serviceUrl: "https://elsewhere.test/" })}`, "service_url_mismatch"],
      ["no service claim", `Bearer ${await token(k1, { serviceUrl: null })}`, "service_url_mismatch"],
    ];
    const before = { posted: posted.length, threads: (await k.db.select().from(builderChannelThreads)).length };
    for (const [label, auth, code] of cases) {
      const r = await sendBot(botConn, activity({ user: "aad-owner", text: label }).body, auth);
      expect(r.statusCode, label).toBe(401);
      expect(r.json().code, label).toBe(code);
    }
    // a tampered body: the signature still verifies, but not for this service
    const tampered = await sendBot(botConn, activity({ user: "aad-owner", text: "x", serviceUrl: "https://elsewhere.test/" }).body, `Bearer ${await token(k1)}`);
    expect(tampered.json().code).toBe("service_url_mismatch");
    await drainBackgroundWork(k.db);
    expect(posted.length).toBe(before.posted);
    expect((await k.db.select().from(builderChannelThreads)).length).toBe(before.threads);
    // an unknown workspace, a workspace with no bot, and a Slack one answer the same 401
    for (const conn of [`nope-${k.RUN}`, slackConn]) {
      expect((await sendBot(conn, activity({ user: "aad-owner", text: "x" }).body, `Bearer ${await token(k1)}`)).statusCode).toBe(401);
    }
  });

  it("a key published AFTER the key set was cached is fetched on its unknown kid; a known kid is served from the cache", async () => {
    const k2 = await newKey("k2");
    published.push(k2.jwk);
    const fetchesBefore = jwksFetches;
    const r = await sendBot(botConn, activity({ user: "aad-owner", text: "rotated" }).body, `Bearer ${await token(k2)}`);
    expect(r.statusCode, r.body).toBe(200);
    expect(jwksFetches).toBe(fetchesBefore + 1);
    const again = await sendBot(botConn, activity({ user: "aad-owner", text: "cached" }).body, `Bearer ${await token(k2)}`);
    expect(again.statusCode, again.body).toBe(200);
    expect(jwksFetches).toBe(fetchesBefore + 1);
    await drainBackgroundWork(k.db);
  });

  it("a metadata refresh keeps the key set when jwks_uri is unchanged, and a FAILED refresh keeps the last good keys (batch 2b review)", async () => {
    // every request re-reads the metadata for this test (TTL 0); restored after
    const prevTtl = process.env.REGULAIT_TEAMS_BOT_METADATA_TTL_SECONDS;
    process.env.REGULAIT_TEAMS_BOT_METADATA_TTL_SECONDS = "0";
    try {
      const warm = await sendBot(botConn, activity({ user: "aad-owner", text: "warm" }).body, `Bearer ${await token(k1)}`);
      expect(warm.statusCode, warm.body).toBe(200);
      const fetches = { metadata: metadataFetches, jwks: jwksFetches };
      for (const text of ["refresh-1", "refresh-2"]) {
        const r = await sendBot(botConn, activity({ user: "aad-owner", text }).body, `Bearer ${await token(k1)}`);
        expect(r.statusCode, r.body).toBe(200);
      }
      expect(metadataFetches).toBe(fetches.metadata + 2); // the metadata WAS re-read …
      expect(jwksFetches).toBe(fetches.jwks); // … and the unchanged key set was not re-downloaded
      // the metadata host goes down: a valid token still verifies against the last good keys
      metadataDown = true;
      const during = await sendBot(botConn, activity({ user: "aad-owner", text: "outage" }).body, `Bearer ${await token(k1)}`);
      expect(during.statusCode, during.body).toBe(200);
      expect(metadataFetches).toBeGreaterThan(fetches.metadata + 2); // a refresh was attempted, and failed
      // and a forged key is still refused
      const forged = await sendBot(botConn, activity({ user: "aad-owner", text: "forged" }).body, `Bearer ${await token(unpublished)}`);
      expect(forged.statusCode).toBe(401);
      expect(forged.json().code).toBe("unknown_signing_key");
    } finally {
      metadataDown = false;
      if (prevTtl === undefined) delete process.env.REGULAIT_TEAMS_BOT_METADATA_TTL_SECONDS;
      else process.env.REGULAIT_TEAMS_BOT_METADATA_TTL_SECONDS = prevTtl;
      await drainBackgroundWork(k.db);
    }
  });

  it("a pinned tenant: another tenant's activity is refused (403, audited) even with a valid token", async () => {
    const r = await sendBot(pinnedBotConn, activity({ user: "aad-owner", text: "hi", tenant: "tenant-B" }).body, `Bearer ${await token(k1)}`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe("tenant_not_allowed");
    const ok = await sendBot(pinnedBotConn, activity({ user: "aad-owner", text: "hi", tenant: "tenant-A" }).body, `Bearer ${await token(k1)}`);
    expect(ok.statusCode, ok.body).toBe(200);
    await drainBackgroundWork(k.db);
    const audits = await k.db.select().from(auditLog).where(and(eq(auditLog.ruleId, "chatops-bot-refused-tenant"), eq(auditLog.objectId, connectionIds[3]!)));
    expect(audits).toHaveLength(1);
  });

  it("the OpenID metadata is fetched through the egress guard: a host not on the allow-list means no bot endpoint", async () => {
    const r = await sendBot(localhostBotConn, activity({ user: "aad-owner", text: "hi" }).body, `Bearer ${await token(k1)}`);
    expect(r.statusCode).toBe(401);
    expect(r.json().code).toBe("openid_metadata_unavailable");
  });

  it("non-message activities are acknowledged and run nothing; the webhook route refuses a bot-only workspace", async () => {
    const before = posted.length;
    const r = await sendBot(botConn, activity({ user: "aad-owner", text: "x", type: "conversationUpdate" }).body, `Bearer ${await token(k1)}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().ignored).toBe("activity_conversationUpdate");
    await drainBackgroundWork(k.db);
    expect(posted.length).toBe(before);
    const hook = await k.app.inject({ method: "POST", url: `/v1/chatops/${botConn}/messages`, headers: { "content-type": "application/json" }, payload: "{}" });
    expect(hook.statusCode).toBe(401);
  });

  it("the bot settings are admin-managed: teams only, an app id before anything else, and audited when changed", async () => {
    const conns = (await k.req("GET", "/v1/chatops/connections", k.BOOT)).json().connections as any[];
    expect(conns.find((c) => c.name === botConn)).toMatchObject({ botAppId: APP_ID, botEndpoint: `/v1/chatops/${botConn}/bot`, signingSecretSet: false });
    expect(conns.find((c) => c.name === slackConn)).toMatchObject({ botAppId: null, botEndpoint: null });
    const slackId = conns.find((c) => c.name === slackConn).id;
    const onSlack = await k.req("PATCH", `/v1/chatops/connections/${slackId}`, k.BOOT, { botAppId: "x" });
    expect(onSlack.statusCode).toBe(400);
    expect(onSlack.json().error).toBe("bot_fields_teams_only");
    const noApp = await k.req("PATCH", `/v1/chatops/connections/${botConnId}`, k.BOOT, { botAppId: null });
    expect(noApp.statusCode).toBe(400); // a bot-only workspace keeps its only inbound path
    const tenant = await k.req("PATCH", `/v1/chatops/connections/${botConnId}`, k.BOOT, { botTenantId: "tenant-A" });
    expect(tenant.statusCode, tenant.body).toBe(200);
    const audits = await k.db.select().from(auditLog).where(and(eq(auditLog.ruleId, "chatops-bot-settings-changed"), eq(auditLog.objectId, botConnId)));
    expect(audits).toHaveLength(1);
    const back = await k.req("PATCH", `/v1/chatops/connections/${botConnId}`, k.BOOT, { botTenantId: null });
    expect(back.statusCode).toBe(200);
    // a non-admin cannot touch it
    expect((await k.req("PATCH", `/v1/chatops/connections/${botConnId}`, owner.auth, { botTenantId: "t" })).statusCode).toBe(403);
    const created = await k.req("POST", "/v1/chatops/connections", k.BOOT, {
      name: `cc-tenant-only-${k.RUN}`,
      provider: "teams",
      connectorId: connectorIds[1],
      defaultChannel: CHANNEL,
      botTenantId: "t",
    });
    expect(created.statusCode).toBe(400);
  });
});
