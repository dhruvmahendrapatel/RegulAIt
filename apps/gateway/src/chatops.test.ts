/**
 * ADR-0061 — CHATOPS APPROVALS, PROVED BY ATTACK.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE
 * ----------------------------------------------
 *  1. A CALLBACK THAT NOBODY SIGNED. Three shapes, each asserted 401 AND
 *     asserted to have left the approval `pending`: no signature at all, a
 *     signature made with the WRONG secret, and a genuinely REPLAYED one — a
 *     valid signature over a real timestamp, sent after the window closed. The
 *     clock is not stubbed; the stale timestamp is really stale, so the test
 *     exercises the shipped wall rather than a test seam.
 *  2. A DECISION BOUND TO THE BOT. The headline failure ADR-0061 names. A
 *     mapped, entitled human clicks and the assertion is that
 *     `approvals.decided_by` is HER user id — not the bot, not null, not the
 *     admin who registered the workspace.
 *  3. A CHAT IDENTITY THAT IS NOBODY, OR THE WRONG SOMEBODY. An unmapped Slack
 *     user and a mapped-but-not-the-approver user each get 403, the approval is
 *     asserted STILL `pending`, and the refusal is asserted present in
 *     `audit_log` under a stable rule id.
 *  4. A DOUBLE-CLICK THAT DECIDES TWICE. The same callback is delivered twice.
 *     Asserted: the second is idempotent, `decided_at` is UNCHANGED, and there
 *     is exactly ONE `chatops-decided` audit row — the status machine covers the
 *     first half of that, the interaction record covers the second.
 *  5. A FENCED APPROVAL WHOSE PAYLOAD LEAKS INTO CHAT. The card actually posted
 *     to a real local HTTP server is captured and asserted NOT to contain the
 *     tool name, the stage id or the requester's address — only a link.
 *  6. AN OUTBOUND POST THAT ESCAPES THE EGRESS GUARD. The allow entry is
 *     removed and the post is asserted refused with `egress_blocked` — the
 *     air-gapped behaviour of §8.5 arriving from the guard, not a mode flag.
 *
 * SHARED-STATE DISCIPLINE. `egress_allow_hosts` is org-wide and this suite adds
 * an entry for 127.0.0.1; `afterAll` removes it along with every connection,
 * link, message, interaction, approval, project, compliance profile, connector,
 * user and audit row the suite created.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvals,
  auditLog,
  chatIdentityLinks,
  chatopsConnections,
  chatopsInteractions,
  chatopsMessages,
  complianceProfiles,
  connectorCredentials,
  connectors,
  createDb,
  egressAllowHosts,
  eq,
  inArray,
  projects,
  runMigrations,
  users,
  type Db,
} from "@regulait/db";
import { CHATOPS_REPLAY_WINDOW_SECONDS, slackSignature } from "@regulait/shared";
import { CHATOPS_RULE_IDS } from "./chatops.js";

const { buildApp } = await import("./app.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "chatops-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
/** 64 hex chars — the AES-256 data key the credential store wants */
const DATA_KEY = "b".repeat(64);
const SIGNING_SECRET = "chatops-suite-signing-secret";
const CONNECTION = "chatops-suite-slack";
const CHANNEL = "C-DEPLOYS";
const PROFILE_TAG = "chatops-suite-block";

let db: Db;
let app: ReturnType<typeof buildApp>;

let danaId: string;
let malloryId: string;
let requesterId: string;
let connectorId: string;
let connectionId: string;
let fencedProjectId: string;
let slackBase: string;

/** every card the gateway really posted, captured off a real HTTP server so
 * the assertion is about bytes on a socket, not about a mock's arguments */
const posted: Array<Record<string, unknown>> = [];
let upstream: http.Server;

const post = (url: string, payload: unknown, headers = AUTH) =>
  app.inject({ method: "POST", url, headers, payload: payload as object });
const get = (url: string, headers = AUTH) => app.inject({ method: "GET", url, headers });

const RULE_IDS = Object.values(CHATOPS_RULE_IDS);
const EMAILS = ["chatops-dana@example.com", "chatops-mallory@example.com", "chatops-requester@example.com"];

function slackBody(approvalId: string, chatUserId = "U-DANA", action = "regulait_approve"): string {
  return new URLSearchParams({
    payload: JSON.stringify({
      type: "block_actions",
      user: { id: chatUserId },
      channel: { id: CHANNEL },
      container: { message_ts: "1785000000.000100" },
      actions: [{ action_id: action, value: approvalId }],
    }),
  }).toString();
}

function signedHeaders(body: string, secondsAgo = 0, secret = SIGNING_SECRET) {
  const ts = String(Math.floor(Date.now() / 1000) - secondsAgo);
  return {
    "content-type": "application/x-www-form-urlencoded",
    "x-slack-request-timestamp": ts,
    "x-slack-signature": slackSignature(secret, ts, body),
  };
}

const callback = (body: string, headers: Record<string, string>) =>
  app.inject({ method: "POST", url: `/v1/chatops/${CONNECTION}/interactions`, headers, payload: body });

async function makeApproval(opts: { approverUserId: string; projectId?: string | null }) {
  const [row] = await db
    .insert(approvals)
    .values({
      userId: requesterId,
      objectType: "mcp_tool",
      toolName: "patients.read",
      stageId: "prod-signoff",
      approverUserId: opts.approverUserId,
      status: "pending",
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
    })
    .returning();
  return row!.id;
}

async function approvalRow(id: string) {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
  return row!;
}
async function auditRows(ruleId: string) {
  const rows = await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId));
  return rows.map((r) => ({ ...r, detail: (r.detail ?? {}) as Record<string, unknown> }));
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });

  // A REAL local Slack: the guarded fetch really connects to it, so "the post
  // went through the guard" is proved by the socket, not by a stub.
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        posted.push(JSON.parse(body || "{}") as Record<string, unknown>);
      } catch {
        posted.push({ raw: body });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: `17850000${posted.length}.0001` }));
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const addr = upstream.address();
  if (typeof addr !== "object" || !addr) throw new Error("no address");
  slackBase = `http://127.0.0.1:${addr.port}`;

  const allow = await post("/v1/egress-allow-hosts", {
    host: "127.0.0.1",
    allowPrivateRanges: true,
    allowPlaintextHttp: true,
    note: "chatops suite: local fake Slack",
  });
  expect([201, 200]).toContain(allow.statusCode);

  const mk = async (email: string, name: string) => {
    const res = await post("/v1/users", { email, displayName: name });
    expect(res.statusCode).toBe(201);
    return res.json().id as string;
  };
  danaId = await mk(EMAILS[0]!, "Dana");
  malloryId = await mk(EMAILS[1]!, "Mallory");
  requesterId = await mk(EMAILS[2]!, "Requester");

  // The OUTBOUND credential lives in the ORDINARY connector store — ChatOps
  // does not invent a second Slack integration.
  const conn = await post("/v1/connectors", {
    name: "chatops-suite-slack-connector",
    kind: "chat",
    providerKind: "slack",
    baseUrl: slackBase,
  });
  expect(conn.statusCode).toBe(201);
  connectorId = conn.json().id;
  const cred = await post(`/v1/connectors/${connectorId}/credential`, { token: "xoxb-suite-token" });
  expect([200, 201]).toContain(cred.statusCode);

  const created = await post("/v1/chatops/connections", {
    name: CONNECTION,
    provider: "slack",
    connectorId,
    signingSecret: SIGNING_SECRET,
    defaultChannel: CHANNEL,
  });
  expect(created.statusCode).toBe(201);
  connectionId = created.json().id;

  const link = await post("/v1/chatops/identity-links", {
    connectionName: CONNECTION,
    chatUserId: "U-DANA",
    email: EMAILS[0],
  });
  expect(link.statusCode).toBe(201);
  const link2 = await post("/v1/chatops/identity-links", {
    connectionName: CONNECTION,
    chatUserId: "U-MALLORY",
    email: EMAILS[1],
  });
  expect(link2.statusCode).toBe(201);

  // a project whose compliance classification blocks sensitive content
  await post("/v1/compliance/profiles", { tag: PROFILE_TAG, piiMode: "block" });
  const proj = await post("/v1/projects", { name: "chatops-suite-fenced", classifications: [PROFILE_TAG] });
  expect(proj.statusCode).toBe(201);
  fencedProjectId = proj.json().id;
});

afterAll(async () => {
  await db.delete(chatopsInteractions);
  await db.delete(chatopsMessages);
  await db.delete(chatIdentityLinks);
  await db.delete(chatopsConnections).where(eq(chatopsConnections.id, connectionId));
  await db.delete(approvals).where(eq(approvals.userId, requesterId));
  if (fencedProjectId) await db.delete(projects).where(eq(projects.id, fencedProjectId));
  await db.delete(complianceProfiles).where(eq(complianceProfiles.tag, PROFILE_TAG));
  await db.delete(connectorCredentials).where(eq(connectorCredentials.connectorId, connectorId));
  await db.delete(connectors).where(eq(connectors.id, connectorId));
  await db.delete(auditLog).where(inArray(auditLog.ruleId, RULE_IDS));
  await db.delete(users).where(inArray(users.email, EMAILS));
  await db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  app.server.closeAllConnections();
  await app.close();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

// ===========================================================================
// 1. The first wall
// ===========================================================================

describe("an inbound callback nobody signed is refused", () => {
  it("REFUSES an unsigned callback and leaves the approval pending", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    const body = slackBody(approvalId);
    const res = await callback(body, { "content-type": "application/x-www-form-urlencoded" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("missing_signature");
    expect((await approvalRow(approvalId)).status).toBe("pending");
  });

  it("REFUSES a wrongly-signed callback", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    const body = slackBody(approvalId);
    const res = await callback(body, signedHeaders(body, 0, "not-the-signing-secret"));
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("bad_signature");
    expect((await approvalRow(approvalId)).status).toBe("pending");
  });

  it("REFUSES a REPLAY — a genuinely valid signature, sent after the window closed", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    const body = slackBody(approvalId);
    const stale = signedHeaders(body, CHATOPS_REPLAY_WINDOW_SECONDS + 60);
    const res = await callback(body, stale);
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("stale_timestamp");
    expect((await approvalRow(approvalId)).status).toBe("pending");
    // the SAME body signed with a CURRENT timestamp is accepted, so the refusal
    // above is genuinely about the window and not about the payload
    const fresh = await callback(body, signedHeaders(body));
    expect(fresh.statusCode).toBe(200);
    expect((await approvalRow(approvalId)).status).toBe("approved");
  });

  it("a signature-failure writes NO audit row — a forged flood must be cheap", async () => {
    const before = (await auditRows(CHATOPS_RULE_IDS.decideRefusedUnmapped)).length;
    const approvalId = await makeApproval({ approverUserId: danaId });
    const body = slackBody(approvalId, "U-NOBODY");
    await callback(body, { "content-type": "application/x-www-form-urlencoded" });
    expect((await auditRows(CHATOPS_RULE_IDS.decideRefusedUnmapped)).length).toBe(before);
  });

  it("an unknown workspace answers the same 401 rather than confirming it exists", async () => {
    const body = slackBody("00000000-0000-0000-0000-000000000001");
    const res = await app.inject({
      method: "POST",
      url: "/v1/chatops/no-such-workspace/interactions",
      headers: signedHeaders(body),
      payload: body,
    });
    expect(res.statusCode).toBe(401);
  });
});

// ===========================================================================
// 2. Identity binding — the crux
// ===========================================================================

describe("the chat user id is an assertion, not authorization", () => {
  it("REFUSES an unmapped chat identity, leaves the approval pending, and AUDITS it", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    const body = slackBody(approvalId, "U-STRANGER");
    const res = await callback(body, signedHeaders(body));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("unmapped_chat_identity");
    expect((await approvalRow(approvalId)).status).toBe("pending");
    const audits = await auditRows(CHATOPS_RULE_IDS.decideRefusedUnmapped);
    expect(audits.some((r) => r.effect === "deny" && String(r.detail?.["chatUserId"]) === "U-STRANGER")).toBe(true);
  });

  it("REFUSES a mapped user who is NOT the named approver, leaves it pending, and AUDITS it", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    const body = slackBody(approvalId, "U-MALLORY");
    const res = await callback(body, signedHeaders(body));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_the_named_approver");
    const row = await approvalRow(approvalId);
    expect(row.status).toBe("pending");
    expect(row.decidedBy).toBeNull();
    const audits = await auditRows(CHATOPS_RULE_IDS.decideRefusedByDecidePath);
    expect(audits.some((r) => r.effect === "deny" && String(r.detail?.["approvalId"]) === approvalId)).toBe(true);
  });

  it("a valid click decides through the ONE path and records the HUMAN, never the bot", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    const body = slackBody(approvalId);
    const res = await callback(body, signedHeaders(body));
    expect(res.statusCode).toBe(200);
    expect(res.json().decidedBy).toBe(danaId);

    const row = await approvalRow(approvalId);
    expect(row.status).toBe("approved");
    expect(row.decidedBy).toBe(danaId);
    expect(row.decidedBy).not.toBe(malloryId);
    expect(row.decisionReason).toMatch(/ChatOps/);

    const audits = await auditRows(CHATOPS_RULE_IDS.decided);
    const mine = audits.filter((r) => String(r.detail?.["approvalId"]) === approvalId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.userId).toBe(danaId);
  });

  it("a reject click denies, also through the one path", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    const body = slackBody(approvalId, "U-DANA", "regulait_reject");
    const res = await callback(body, signedHeaders(body));
    expect(res.statusCode).toBe(200);
    const row = await approvalRow(approvalId);
    expect(row.status).toBe("denied");
    expect(row.decidedBy).toBe(danaId);
  });

  it("an identity link binds an EXISTING principal and never creates one", async () => {
    const res = await post("/v1/chatops/identity-links", {
      connectionName: CONNECTION,
      chatUserId: "U-GHOST",
      email: "no-such-person-chatops@example.com",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unknown_user");
    const [ghost] = await db.select().from(users).where(eq(users.email, "no-such-person-chatops@example.com"));
    expect(ghost).toBeUndefined();
  });

  it("one chat identity cannot map to two humans", async () => {
    const dup = await post("/v1/chatops/identity-links", {
      connectionName: CONNECTION,
      chatUserId: "U-DANA",
      email: EMAILS[1],
    });
    expect(dup.statusCode).toBe(409);
  });

  it("the signing secret is never returned", async () => {
    const res = await get("/v1/chatops/connections");
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).not.toContain(SIGNING_SECRET);
  });
});

// ===========================================================================
// 3. Idempotency
// ===========================================================================

describe("a double-click is a no-op", () => {
  it("the second identical callback does not re-decide and does not double-audit", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    const body = slackBody(approvalId);

    const first = await callback(body, signedHeaders(body));
    expect(first.statusCode).toBe(200);
    const afterFirst = await approvalRow(approvalId);
    expect(afterFirst.status).toBe("approved");

    const second = await callback(body, signedHeaders(body));
    expect(second.statusCode).toBe(200);
    expect(second.json().idempotent).toBe(true);

    const afterSecond = await approvalRow(approvalId);
    expect(afterSecond.status).toBe("approved");
    expect(afterSecond.decidedAt?.toISOString()).toBe(afterFirst.decidedAt?.toISOString());
    expect(afterSecond.decidedBy).toBe(danaId);

    const decided = (await auditRows(CHATOPS_RULE_IDS.decided)).filter(
      (r) => String(r.detail?.["approvalId"]) === approvalId,
    );
    expect(decided).toHaveLength(1);
    const rows = await db.select().from(chatopsInteractions).where(eq(chatopsInteractions.approvalId, approvalId));
    expect(rows).toHaveLength(1);
  });

  it("a DIFFERENT chat user clicking an already-decided approval still cannot change it", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    const body = slackBody(approvalId);
    expect((await callback(body, signedHeaders(body))).statusCode).toBe(200);

    const other = slackBody(approvalId, "U-MALLORY");
    const res = await callback(other, signedHeaders(other));
    expect(res.statusCode).toBe(403);
    const row = await approvalRow(approvalId);
    expect(row.status).toBe("approved");
    expect(row.decidedBy).toBe(danaId);
  });
});

// ===========================================================================
// 4. Outbound: the fence and the guard
// ===========================================================================

describe("outbound posting", () => {
  it("posts a card through the guarded fetch and records the mirror", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    const before = posted.length;
    const res = await post(`/v1/chatops/approvals/${approvalId}/post`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().redacted).toBe(false);
    expect(res.json().decidable).toBe(true);
    expect(posted.length).toBe(before + 1);
    // an UNfenced card may name the gated action
    expect(JSON.stringify(posted[posted.length - 1])).toContain("patients.read");
    const msgs = await db.select().from(chatopsMessages).where(eq(chatopsMessages.approvalId, approvalId));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.redacted).toBe(false);
  });

  it("a SENSITIVITY-FENCED approval posts a LINK and NOT the payload", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId, projectId: fencedProjectId });
    const before = posted.length;
    const res = await post(`/v1/chatops/approvals/${approvalId}/post`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json().redacted).toBe(true);
    // fenced ⇒ in-app only by default: the card carries no buttons
    expect(res.json().decidable).toBe(false);

    expect(posted.length).toBe(before + 1);
    const card = JSON.stringify(posted[posted.length - 1]);
    expect(card).not.toContain("patients.read");
    expect(card).not.toContain("prod-signoff");
    expect(card).not.toContain(EMAILS[2]!);
    expect(card).toContain(approvalId);
    expect(card).toMatch(/review-workbench/);
  });

  it("a fenced approval cannot be decided from chat, and the refusal is audited", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId, projectId: fencedProjectId });
    const body = slackBody(approvalId);
    const res = await callback(body, signedHeaders(body));
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("chat_decide_not_permitted_for_sensitivity");
    expect((await approvalRow(approvalId)).status).toBe("pending");
    const audits = await auditRows(CHATOPS_RULE_IDS.decideRefusedSensitivity);
    expect(audits.some((r) => String(r.detail?.["approvalId"]) === approvalId)).toBe(true);
  });

  it("REFUSES the post when the destination is not egress-permitted", async () => {
    const approvalId = await makeApproval({ approverUserId: danaId });
    // withdraw the allow entry — exactly the air-gapped posture of §8.5
    const saved = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
    await db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
    try {
      const before = posted.length;
      const res = await post(`/v1/chatops/approvals/${approvalId}/post`, {});
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
      // and nothing left the process
      expect(posted.length).toBe(before);
      const audits = await auditRows(CHATOPS_RULE_IDS.postRefusedEgress);
      expect(audits.length).toBeGreaterThan(0);
    } finally {
      for (const row of saved) {
        await db.insert(egressAllowHosts).values({
          host: row.host,
          allowPrivateRanges: row.allowPrivateRanges,
          allowPlaintextHttp: row.allowPlaintextHttp,
          note: row.note,
        });
      }
    }
  });
});
