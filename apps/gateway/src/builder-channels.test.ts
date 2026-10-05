/**
 * ADR-0173 §2 — inbound channels to builder agents, PROVED BY ATTACK.
 *
 * The outbound side is a REAL local HTTP server playing Slack, the Bot
 * Connector and the Entra login host, reached through the egress-guarded
 * courier — so "a reply was posted" is a body that arrived on a socket, and
 * "nothing was posted" is an empty capture, not a mock that was never called.
 *
 * Every refusal is asserted with what it must NOT have done (no builder
 * thread, no usage row, no reply) and, where it makes sense, the same call
 * succeeding once the rule allows it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import {
  and,
  auditLog,
  builderChannelEvents,
  builderChannelThreads,
  builderMessages,
  builderThreads,
  chatopsConnections,
  connectorCredentials,
  connectors,
  egressAllowHosts,
  eq,
  inArray,
  usageEvents,
} from "@regulait/db";
import { slackSignature, teamsSignature } from "@regulait/shared";
import {
  BUILDER_CHANNEL_RULE_IDS,
  CHANNEL_REPLY_MAX_CHARS,
  channelWorkInFlight,
  composeChannelReply,
  drainChannelWork,
  pauseOf,
  threadLink,
} from "./builder-channels.js";
import type { TurnOutcome } from "./builder-runtime.js";
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";

let k: BuilderKit;
let admin: Person;
let owner: Person;
let colleague: Person;
let model = "";

const SECRET = "builder-channels-signing-secret";
const TEAMS_SECRET = Buffer.from("builder-channels-teams-key").toString("base64");
const CHANNEL = "C-AGENT";
const OTHER_CHANNEL = "C-ELSEWHERE";
const SLOW_CHANNEL = "C-SLOW";

let base = "";
let upstream: http.Server;
/** every request that reached the fake platform (token exchanges excluded) */
const posted: Array<{ url: string; body: Record<string, any> }> = [];
let createdEgressEntry = false;
const connectionIds: string[] = [];
const connectorIds: string[] = [];

let slackConn = "";
let slackConnId = "";
let wideConn = "";
let wideConnId = "";
let teamsConn = "";
let teamsConnId = "";
let agentId = "";

let seq = 0;
const nextTs = () => `${1785000000 + ++seq}.000${seq}`;

function slackHeaders(body: string, opts: { secondsAgo?: number; secret?: string; retry?: string } = {}) {
  const ts = String(Math.floor(Date.now() / 1000) - (opts.secondsAgo ?? 0));
  return {
    "content-type": "application/json",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": slackSignature(opts.secret ?? SECRET, ts, body),
    ...(opts.retry ? { "x-slack-retry-num": opts.retry } : {}),
  };
}

const slackMessage = (o: {
  user: string;
  text: string;
  channel?: string;
  ts?: string;
  threadTs?: string;
  type?: "message" | "app_mention";
  eventId?: string;
  extra?: Record<string, unknown>;
}) => {
  const ts = o.ts ?? nextTs();
  return {
    ts,
    eventId: o.eventId ?? `Ev-${k.RUN}-${ts}`,
    body: JSON.stringify({
      type: "event_callback",
      team_id: "T1",
      event_id: o.eventId ?? `Ev-${k.RUN}-${ts}`,
      event: {
        type: o.type ?? "app_mention",
        user: o.user,
        channel: o.channel ?? CHANNEL,
        ts,
        text: `<@UBOT> ${o.text}`,
        ...(o.threadTs ? { thread_ts: o.threadTs } : {}),
        ...(o.extra ?? {}),
      },
    }),
  };
};

const sendSlack = (conn: string, body: string, headers: Record<string, string>) =>
  k.app.inject({ method: "POST", url: `/v1/chatops/${conn}/events`, headers, payload: body });

const teamsActivity = (o: { user: string; text: string; id?: string; timestamp?: string; conv?: string }) => {
  const id = o.id ?? `act-${k.RUN}-${++seq}`;
  return {
    id,
    body: JSON.stringify({
      type: "message",
      id,
      timestamp: o.timestamp ?? new Date().toISOString(),
      text: `<at>RegulAIt</at> ${o.text}`,
      from: { id: `29:${o.user}`, aadObjectId: o.user },
      conversation: { id: o.conv ?? `19:team-${k.RUN}@thread.tacv2;messageid=100` },
    }),
  };
};
const sendTeams = (body: string, secret = TEAMS_SECRET) =>
  k.app.inject({
    method: "POST",
    url: `/v1/chatops/${teamsConn}/messages`,
    headers: { "content-type": "application/json", authorization: teamsSignature(secret, body) },
    payload: body,
  });

const usageCount = async (userId: string) =>
  (await k.db.select({ id: usageEvents.id }).from(usageEvents).where(eq(usageEvents.userId, userId))).length;
const channelThreadsOf = async (userId: string) =>
  k.db.select().from(builderThreads).where(and(eq(builderThreads.userId, userId), eq(builderThreads.source, "channel")));
const postsTo = (channel: string) => posted.filter((p) => p.body.channel === channel);
const auditFor = async (ruleId: string, objectId: string) =>
  k.db.select().from(auditLog).where(and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)));

async function makeConnection(provider: "slack" | "teams", label: string, secret: string) {
  const conn = await k.req("POST", "/v1/connectors", k.BOOT, {
    name: `bld-chan-${label}-connector-${k.RUN}`,
    kind: "chat",
    providerKind: provider,
    baseUrl: base,
  });
  expect(conn.statusCode, conn.body).toBe(201);
  connectorIds.push(conn.json().id);
  const token = provider === "teams" ? JSON.stringify({ appId: "app", appPassword: "pw", loginBaseUrl: base }) : "xoxb-test";
  const cred = await k.req("POST", `/v1/connectors/${conn.json().id}/credential`, k.BOOT, { token });
  expect(cred.statusCode, cred.body).toBeLessThan(300);
  const name = `bld-chan-${label}-${k.RUN}`;
  const created = await k.req("POST", "/v1/chatops/connections", k.BOOT, {
    name,
    provider,
    connectorId: conn.json().id,
    signingSecret: secret,
    defaultChannel: CHANNEL,
  });
  expect(created.statusCode, created.body).toBe(201);
  connectionIds.push(created.json().id);
  return { name, id: created.json().id as string };
}

async function link(connName: string, chatUserId: string, who: string) {
  const r = await k.req("POST", "/v1/chatops/identity-links", k.BOOT, {
    connectionName: connName,
    chatUserId,
    email: `bld-chan-${who}-${k.RUN}@example.com`,
  });
  expect(r.statusCode, r.body).toBe(201);
}

async function newAgent(by: Person, extra: Record<string, unknown> = {}) {
  const r = await k.req("POST", "/v1/builder/agents", by.auth, {
    name: `Channel agent ${Math.random().toString(36).slice(2, 7)}`,
    connectionFormat: "shared",
    computerUse: false,
    modelAgentId: model,
    projectId: by.projectId,
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().agent.id as string;
}

/** an ADMIN binds the connection (the ADR-0172 review rule) */
async function bind(agent: string, provider: "slack" | "teams", connectionId: string) {
  const r = await k.req("POST", `/v1/builder/agents/${agent}/channels`, admin.auth, { provider, chatopsConnectionId: connectionId });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  k = await builderKit("bld-chan");
  // ADR-0181: the org PII floor ships at block, and a block-mode reply is withheld from
  // chat. This file pins the channel round trip, so the floor is set off explicitly.
  restoreSb1Posture = await relaxDataPostureForTest(k.db, { org: { defaultPiiMode: "none" }, interception: false, guardrails: false });
  admin = await k.person("admin", { admin: true });
  owner = await k.person("owner");
  colleague = await k.person("colleague");
  model = await k.model("m", { price: 100_000 });
  await k.grantModel(owner.id, model);
  await k.grantModel(admin.id, model);
  // every builder agent bills to a project: the colleague may bill the owner's
  // (where the owner's shared agent spends)
  const seat = await k.req("POST", `/v1/projects/${owner.projectId}/members`, k.BOOT, { userId: colleague.id, role: "contributor" });
  expect(seat.statusCode, seat.body).toBeLessThan(300);

  upstream = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = req.url ?? "";
      if (url.includes("/oauth2/v2.0/token")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token_type: "Bearer", expires_in: 3600, access_token: "test-jwt" }));
        return;
      }
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = { raw };
      }
      const answer = () => {
        posted.push({ url, body });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ts: `1785.${posted.length}`, id: `reply-${posted.length}` }));
      };
      // the async-ack proof: this "Slack" takes 1.5 s to accept a reply here
      if (body.channel === SLOW_CHANNEL) setTimeout(answer, 1500);
      else answer();
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const addr = upstream.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  base = `http://127.0.0.1:${addr.port}`;

  // egress_allow_hosts is org-wide: add 127.0.0.1 only if absent, and remove it
  // afterwards only if this file added it
  const [existing] = await k.db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  if (!existing) {
    const allow = await k.req("POST", "/v1/egress-allow-hosts", k.BOOT, {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "builder-channels suite: local fake chat platform",
    });
    expect([200, 201]).toContain(allow.statusCode);
    createdEgressEntry = true;
  }

  ({ name: slackConn, id: slackConnId } = await makeConnection("slack", "slack", SECRET));
  ({ name: wideConn, id: wideConnId } = await makeConnection("slack", "wide", SECRET));
  ({ name: teamsConn, id: teamsConnId } = await makeConnection("teams", "teams", TEAMS_SECRET));
  await link(slackConn, "U-OWNER", "owner");
  await link(slackConn, "U-COLLEAGUE", "colleague");
  await link(wideConn, "U-OWNER", "owner");
  await link(teamsConn, "aad-owner", "owner");

  // the agent under test: owned by `owner`, PRIVATE, routed to CHANNEL on the
  // slack connection, and connection-wide on the teams one
  agentId = await newAgent(owner);
  const ch = await bind(agentId, "slack", slackConnId);
  const routed = await k.req("PUT", `/v1/chatops/builder-routes/${ch}`, k.BOOT, { externalChannelId: CHANNEL });
  expect(routed.statusCode, routed.body).toBe(200);
  await bind(agentId, "teams", teamsConnId);
}, 120_000);

afterAll(async () => {
  await restoreSb1Posture?.();
  await drainChannelWork(k.db);
  if (connectionIds.length) await k.db.delete(chatopsConnections).where(inArray(chatopsConnections.id, connectionIds));
  if (connectorIds.length) {
    await k.db.delete(connectorCredentials).where(inArray(connectorCredentials.connectorId, connectorIds));
    await k.db.delete(connectors).where(inArray(connectors.id, connectorIds));
  }
  if (createdEgressEntry) await k.db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await k.close();
});

describe("the first walls: signature and replay", () => {
  it("refuses an unsigned, a wrongly-signed and a replayed event with 401, and runs nothing", async () => {
    const m = slackMessage({ user: "U-OWNER", text: "forged" });
    const before = { posts: posted.length, usage: await usageCount(owner.id) };
    const unsigned = await sendSlack(slackConn, m.body, { "content-type": "application/json" });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.json().code).toBe("missing_signature");
    const wrong = await sendSlack(slackConn, m.body, slackHeaders(m.body, { secret: "not-the-secret" }));
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().code).toBe("bad_signature");
    // a genuinely old, genuinely valid signature — the clock is not stubbed
    const replayed = await sendSlack(slackConn, m.body, slackHeaders(m.body, { secondsAgo: 400 }));
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json().code).toBe("stale_timestamp");
    await drainChannelWork(k.db);
    expect(posted.length).toBe(before.posts);
    expect(await usageCount(owner.id)).toBe(before.usage);
    // nothing was even recorded for de-duplication
    const ev = await k.db.select().from(builderChannelEvents).where(eq(builderChannelEvents.externalEventId, m.eventId));
    expect(ev).toHaveLength(0);
    // an unknown workspace and a workspace of the other provider answer the same 401
    expect((await sendSlack(`no-such-${k.RUN}`, m.body, slackHeaders(m.body))).statusCode).toBe(401);
    expect((await sendSlack(teamsConn, m.body, slackHeaders(m.body))).statusCode).toBe(401);
  });

  it("answers Slack's url_verification handshake — but only when it is signed", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: `chal-${k.RUN}`, token: "x" });
    const ok = await sendSlack(slackConn, body, slackHeaders(body));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ challenge: `chal-${k.RUN}` });
    expect((await sendSlack(slackConn, body, { "content-type": "application/json" })).statusCode).toBe(401);
  });

  it("Teams: a bad HMAC and a stale (signed) activity timestamp are refused; a fresh one is accepted", async () => {
    const stale = teamsActivity({ user: "aad-owner", text: "old", timestamp: new Date(Date.now() - 400_000).toISOString() });
    const r1 = await sendTeams(stale.body);
    expect(r1.statusCode).toBe(401);
    expect(r1.json().code).toBe("stale_timestamp");
    const fresh = teamsActivity({ user: "aad-owner", text: "hello from teams" });
    const r2 = await sendTeams(fresh.body, Buffer.from("wrong-key").toString("base64"));
    expect(r2.statusCode).toBe(401);
    expect(r2.json().code).toBe("bad_signature");
    const before = await usageCount(owner.id);
    const r3 = await sendTeams(fresh.body);
    expect(r3.statusCode, r3.body).toBe(200);
    expect(r3.json()).toMatchObject({ type: "message" });
    expect(r3.json().text).toContain("working on it");
    await drainChannelWork(k.db);
    expect(await usageCount(owner.id)).toBe(before + 1);
    // the reply went to the Bot Connector, threaded under the activity
    const reply = posted.find((p) => p.url.includes(`/activities/${encodeURIComponent(fresh.id)}`));
    expect(reply, JSON.stringify(posted.map((p) => p.url))).toBeTruthy();
    expect(reply!.body.type).toBe("message");
    expect(String(reply!.body.text).length).toBeGreaterThan(0);
    // model output is shown as PLAIN text in Teams (no markdown/HTML, so no disguised link)
    expect(reply!.body.textFormat).toBe("plain");

    // the SAME activity re-sent inside the window (a replay the HMAC cannot
    // catch) is de-duplicated by its activity id: no second turn
    const again = await sendTeams(fresh.body);
    expect(again.statusCode).toBe(200);
    await drainChannelWork(k.db);
    expect(await usageCount(owner.id)).toBe(before + 1);
  });
});

describe("a routed turn and its reply", () => {
  it("runs as the linked person, posts the agent's reply in the Slack thread, and continues the conversation", async () => {
    const before = { usage: await usageCount(owner.id), threads: (await channelThreadsOf(owner.id)).length };
    const m = slackMessage({ user: "U-OWNER", text: "Summarise our AI policy" });
    const ack = await sendSlack(slackConn, m.body, slackHeaders(m.body));
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json()).toMatchObject({ ok: true, accepted: true });
    await drainChannelWork(k.db);

    expect(await usageCount(owner.id)).toBe(before.usage + 1);
    const threads = await channelThreadsOf(owner.id);
    expect(threads.length).toBe(before.threads + 1);
    const [map] = await k.db
      .select()
      .from(builderChannelThreads)
      .where(and(eq(builderChannelThreads.connectionId, slackConnId), eq(builderChannelThreads.externalThreadId, m.ts)));
    expect(map).toBeTruthy();
    expect(map!.userId).toBe(owner.id);
    const msgs = await k.db.select().from(builderMessages).where(eq(builderMessages.threadId, map!.builderThreadId));
    const agentMsg = msgs.find((x) => x.role === "agent")!;
    expect(msgs.find((x) => x.role === "user")!.content).toBe("Summarise our AI policy");

    const reply = postsTo(CHANNEL).find((p) => p.body.thread_ts === m.ts);
    expect(reply, JSON.stringify(postsTo(CHANNEL))).toBeTruthy();
    expect(reply!.body.text).toBe(agentMsg.content);
    expect((await auditFor(BUILDER_CHANNEL_RULE_IDS.replyPosted, slackConnId)).length).toBeGreaterThan(0);

    // a follow-up in the same Slack thread — not even a mention, the channel
    // is routed to the agent — continues the SAME builder thread
    const follow = slackMessage({ user: "U-OWNER", text: "Shorter please", threadTs: m.ts, type: "message" });
    expect((await sendSlack(slackConn, follow.body, slackHeaders(follow.body))).statusCode).toBe(200);
    await drainChannelWork(k.db);
    const after = await k.db.select().from(builderMessages).where(eq(builderMessages.threadId, map!.builderThreadId));
    expect(after).toHaveLength(4);
    expect((await channelThreadsOf(owner.id)).length).toBe(before.threads + 1);
  });

  it("de-duplicates a Slack retry by event id, and the paired message + app_mention events by message", async () => {
    const m = slackMessage({ user: "U-OWNER", text: "once only" });
    const before = await usageCount(owner.id);
    expect((await sendSlack(slackConn, m.body, slackHeaders(m.body))).statusCode).toBe(200);
    const retry = await sendSlack(slackConn, m.body, slackHeaders(m.body, { retry: "1" }));
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ duplicate: true });
    // Slack sends a `message` event too, under a different event id, for the same ts
    const twin = slackMessage({ user: "U-OWNER", text: "once only", ts: m.ts, type: "message", eventId: `Ev-twin-${k.RUN}` });
    expect((await sendSlack(slackConn, twin.body, slackHeaders(twin.body))).json()).toMatchObject({ duplicate: true });
    await drainChannelWork(k.db);
    expect(await usageCount(owner.id)).toBe(before + 1);
    expect(postsTo(CHANNEL).filter((p) => p.body.thread_ts === m.ts)).toHaveLength(1);
  });

  it("ignores bot messages (its own replies included) and edits: nothing runs, nothing is posted", async () => {
    const before = { usage: await usageCount(owner.id), posts: posted.length };
    const bot = slackMessage({ user: "U-OWNER", text: "I am a bot", extra: { bot_id: "B-REGULAIT" } });
    const r1 = await sendSlack(slackConn, bot.body, slackHeaders(bot.body));
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toMatchObject({ ignored: "bot_message" });
    const edit = slackMessage({ user: "U-OWNER", text: "edited", type: "message", extra: { subtype: "message_changed" } });
    expect((await sendSlack(slackConn, edit.body, slackHeaders(edit.body))).json()).toMatchObject({ ignored: "edit" });
    await drainChannelWork(k.db);
    expect(await usageCount(owner.id)).toBe(before.usage);
    expect(posted.length).toBe(before.posts);
  });

  it("acknowledges BEFORE the turn and reply finish (the platform's few-second deadline)", async () => {
    // route the slow channel to a second agent so its replies take 1.5 s to land
    const slowAgent = await newAgent(owner);
    const ch = await bind(slowAgent, "slack", slackConnId);
    expect((await k.req("PUT", `/v1/chatops/builder-routes/${ch}`, k.BOOT, { externalChannelId: SLOW_CHANNEL })).statusCode).toBe(200);
    const m = slackMessage({ user: "U-OWNER", text: "take your time", channel: SLOW_CHANNEL });
    const started = Date.now();
    const ack = await sendSlack(slackConn, m.body, slackHeaders(m.body));
    const elapsed = Date.now() - started;
    expect(ack.statusCode).toBe(200);
    expect(elapsed).toBeLessThan(1000);
    expect(postsTo(SLOW_CHANNEL)).toHaveLength(0);
    expect(channelWorkInFlight(k.db)).toBeGreaterThan(0);
    await drainChannelWork(k.db);
    expect(postsTo(SLOW_CHANNEL)).toHaveLength(1);
  });
});

describe("who may talk to the agent", () => {
  it("an UNLINKED chat user is told to get linked, and nothing runs", async () => {
    const m = slackMessage({ user: "U-STRANGER", text: "run something for me" });
    const before = posted.length;
    const ack = await sendSlack(slackConn, m.body, slackHeaders(m.body));
    expect(ack.statusCode).toBe(200);
    await drainChannelWork(k.db);
    const replies = posted.slice(before);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body.text).toContain("isn't linked to a RegulAIt user");
    expect(replies[0]!.body.thread_ts).toBe(m.ts);
    const maps = await k.db.select().from(builderChannelThreads).where(eq(builderChannelThreads.externalThreadId, m.ts));
    expect(maps).toHaveLength(0);
    const denied = await auditFor(BUILDER_CHANNEL_RULE_IDS.refusedUnlinked, agentId);
    expect(denied.some((d) => (d.detail as Record<string, unknown>)?.["chatUserId"] === "U-STRANGER")).toBe(true);
  });

  it("Teams: the refusal for an unlinked sender is the webhook's own reply; nothing is posted", async () => {
    const a = teamsActivity({ user: "aad-stranger", text: "hi" });
    const before = posted.length;
    const r = await sendTeams(a.body);
    expect(r.statusCode).toBe(200);
    expect(r.json().text).toContain("isn't linked to a RegulAIt user");
    await drainChannelWork(k.db);
    expect(posted.length).toBe(before);
  });

  it("a linked person who may not see the (private) agent is refused politely; sharing it lets the same person in", async () => {
    await k.grantModel(colleague.id, model);
    const m = slackMessage({ user: "U-COLLEAGUE", text: "let me use it" });
    const before = { usage: await usageCount(colleague.id), posts: posted.length };
    expect((await sendSlack(slackConn, m.body, slackHeaders(m.body))).statusCode).toBe(200);
    await drainChannelWork(k.db);
    expect(await usageCount(colleague.id)).toBe(before.usage);
    expect((await channelThreadsOf(colleague.id)).length).toBe(0);
    expect(posted.slice(before.posts).map((p) => p.body.text)).toEqual([expect.stringContaining("don't have access")]);
    expect((await auditFor(BUILDER_CHANNEL_RULE_IDS.refusedNotVisible, agentId)).length).toBeGreaterThan(0);

    // positive control: shared with the workspace, the same person's next message runs — as them
    expect((await k.req("PATCH", `/v1/builder/agents/${agentId}`, owner.auth, { sharing: "workspace" })).statusCode).toBe(200);
    const again = slackMessage({ user: "U-COLLEAGUE", text: "now?" });
    expect((await sendSlack(slackConn, again.body, slackHeaders(again.body))).statusCode).toBe(200);
    await drainChannelWork(k.db);
    expect(await usageCount(colleague.id)).toBe(before.usage + 1);
    expect((await channelThreadsOf(colleague.id)).length).toBe(1);
    await k.req("PATCH", `/v1/builder/agents/${agentId}`, owner.auth, { sharing: "private" });
  });
});

describe("which agent answers", () => {
  it("a connection with no agent: a mention gets a polite reply, a plain message is ignored silently", async () => {
    const plain = slackMessage({ user: "U-OWNER", text: "chatting among humans", type: "message", channel: OTHER_CHANNEL });
    const before = posted.length;
    const r1 = await sendSlack(wideConn, plain.body, slackHeaders(plain.body));
    expect(r1.json()).toMatchObject({ ignored: "not_addressed" });
    const mention = slackMessage({ user: "U-OWNER", text: "anyone there?", channel: OTHER_CHANNEL });
    expect((await sendSlack(wideConn, mention.body, slackHeaders(mention.body))).statusCode).toBe(200);
    await drainChannelWork(k.db);
    expect(posted.slice(before).map((p) => p.body.text)).toEqual([expect.stringContaining("No RegulAIt agent is connected")]);
    const ev = await k.db.select().from(builderChannelEvents).where(eq(builderChannelEvents.externalEventId, plain.eventId));
    expect(ev).toHaveLength(0);
  });

  it("two connection-wide agents are ambiguous (refused, never guessed); routing the channel to one resolves it", async () => {
    const a1 = await newAgent(owner);
    const a2 = await newAgent(owner);
    const ch1 = await bind(a1, "slack", wideConnId);
    await bind(a2, "slack", wideConnId);
    const m = slackMessage({ user: "U-OWNER", text: "who answers?", channel: OTHER_CHANNEL });
    const before = { posts: posted.length, usage: await usageCount(owner.id) };
    await sendSlack(wideConn, m.body, slackHeaders(m.body));
    await drainChannelWork(k.db);
    expect(posted.slice(before.posts).map((p) => p.body.text)).toEqual([expect.stringContaining("won't guess")]);
    expect(await usageCount(owner.id)).toBe(before.usage);

    expect((await k.req("PUT", `/v1/chatops/builder-routes/${ch1}`, k.BOOT, { externalChannelId: OTHER_CHANNEL })).statusCode).toBe(200);
    const again = slackMessage({ user: "U-OWNER", text: "now?", channel: OTHER_CHANNEL });
    await sendSlack(wideConn, again.body, slackHeaders(again.body));
    await drainChannelWork(k.db);
    expect(await usageCount(owner.id)).toBe(before.usage + 1);
    const [map] = await k.db.select().from(builderChannelThreads).where(eq(builderChannelThreads.externalThreadId, again.ts));
    expect(map!.agentId).toBe(a1);
  });

  it("routes are admin-only, one agent per connection + channel, and email channels have no inbound to route", async () => {
    const a = await newAgent(owner);
    const ch = await bind(a, "slack", slackConnId);
    // not an admin
    expect((await k.req("PUT", `/v1/chatops/builder-routes/${ch}`, owner.auth, { externalChannelId: "C-MINE" })).statusCode).toBe(403);
    // CHANNEL already answers to the suite's agent
    const taken = await k.req("PUT", `/v1/chatops/builder-routes/${ch}`, k.BOOT, { externalChannelId: CHANNEL });
    expect(taken.statusCode).toBe(409);
    expect(taken.json().error).toBe("channel_already_routed");
    const email = await k.req("POST", `/v1/builder/agents/${a}/channels`, admin.auth, { provider: "email" });
    expect(email.statusCode, email.body).toBe(201);
    const refused = await k.req("PUT", `/v1/chatops/builder-routes/${email.json().id}`, k.BOOT, { externalChannelId: "x" });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe("channel_inbound_unsupported");
    const list = await k.req("GET", "/v1/chatops/builder-routes", k.BOOT);
    expect(list.json().routes.some((r: { channelId: string; externalChannelId: string }) => r.externalChannelId === CHANNEL)).toBe(true);
    expect((await k.req("GET", "/v1/chatops/builder-routes", owner.auth)).statusCode).toBe(403);
  });
});

describe("what goes back", () => {
  it("an agent whose project blocks sensitive content gets a link in chat, not its reply", async () => {
    const tag = `bld-chan-block-${k.RUN}`;
    expect((await k.req("POST", "/v1/compliance/profiles", k.BOOT, { tag, piiMode: "block" })).statusCode).toBeLessThan(300);
    const proj = await k.req("POST", "/v1/projects", k.BOOT, { name: `bld-chan-fenced-${k.RUN}`, classifications: [tag] });
    expect(proj.statusCode, proj.body).toBe(201);
    const fencedChannel = `C-FENCED-${k.RUN}`;
    const a = await newAgent(admin);
    expect((await k.req("PATCH", `/v1/builder/agents/${a}`, admin.auth, { projectId: proj.json().id })).statusCode).toBe(200);
    const ch = await bind(a, "slack", slackConnId);
    expect((await k.req("PUT", `/v1/chatops/builder-routes/${ch}`, k.BOOT, { externalChannelId: fencedChannel })).statusCode).toBe(200);
    await link(slackConn, "U-ADMIN", "admin");
    const m = slackMessage({ user: "U-ADMIN", text: "tell me about the roadmap", channel: fencedChannel });
    await sendSlack(slackConn, m.body, slackHeaders(m.body));
    await drainChannelWork(k.db);
    const [map] = await k.db.select().from(builderChannelThreads).where(eq(builderChannelThreads.externalThreadId, m.ts));
    expect(map, "the turn ran").toBeTruthy();
    const agentMsg = (await k.db.select().from(builderMessages).where(eq(builderMessages.threadId, map!.builderThreadId))).find(
      (x) => x.role === "agent",
    )!;
    const reply = postsTo(fencedChannel);
    expect(reply).toHaveLength(1);
    expect(reply[0]!.body.text).toContain("withheld from chat");
    expect(reply[0]!.body.text).toContain(map!.builderThreadId);
    expect(reply[0]!.body.text).not.toContain(agentMsg.content);
  });

  it("composes pause notices and cuts long replies with a link (pure)", () => {
    const link = "/builder/inbox?tab=all&thread=t1";
    expect(composeChannelReply({ replyText: "Let me check.", fenced: false, pause: "confirmation", link })).toBe(
      `Let me check.\n\nWaiting for your confirmation in RegulAIt before using a tool: ${link}`,
    );
    expect(composeChannelReply({ replyText: null, fenced: false, pause: "approval", link })).toContain("Waiting for an approval in RegulAIt");
    const long = composeChannelReply({ replyText: "z".repeat(CHANNEL_REPLY_MAX_CHARS + 50), fenced: false, pause: null, link });
    expect(long.length).toBeLessThan(CHANNEL_REPLY_MAX_CHARS + 200);
    expect(long).toContain(link);
    // a paused turn is read off the runtime's steps, wherever it reports them
    const ok = (extra: Record<string, unknown>, messages: unknown[] = []) =>
      ({ ok: true, thread: {} as never, messages, ...extra }) as unknown as TurnOutcome;
    expect(pauseOf(ok({ steps: [{ status: "done" }, { status: "pending_confirmation" }] }))).toBe("confirmation");
    expect(pauseOf(ok({}, [{ role: "agent", steps: [{ status: "pending_approval" }] }]))).toBe("approval");
    expect(pauseOf(ok({ steps: [{ status: "done" }] }))).toBeNull();
    expect(pauseOf({ ok: false, status: 403, error: "agent_denied" })).toBeNull();
    // the link is the SPA's (under /ui), absolute when the public origin is known
    expect(threadLink("t1", "https://gw.example.com/")).toBe("https://gw.example.com/ui/builder/inbox?tab=all&thread=t1");
    expect(threadLink("t1", null)).toBe("/ui/builder/inbox?tab=all&thread=t1");
  });
});
