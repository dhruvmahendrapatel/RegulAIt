/**
 * ADR-0183 batch 2.6 — the Outlook SEND half that ADR-0121 designed (amended
 * 2026-10-06). Against a local fake Microsoft identity platform token endpoint
 * and a local fake Microsoft Graph, each on its own loopback host so the egress
 * guard adjudicates them separately:
 *
 *  1. registration opens, strictly: no credential, a malformed one, a recipient
 *     that is not one mailbox, a chat-decide opt-in and a signing secret are
 *     each refused by name and write nothing; the good one registers with no
 *     secret, and the list says it can send;
 *  2. an approval card is DELIVERED as Graph sendMail: from the credential's
 *     sender mailbox to the workspace's recipient, carrying the summary and an
 *     absolute portal link, with NO decision affordance (no button, no reply
 *     instruction that decides, no bearer link), recorded as not decidable;
 *  3. the sensitivity fence (ADR-0061) holds: a fenced approval's mail names
 *     nothing and says the content is withheld;
 *  4. the app-only token is CACHED (one token request for several sends) and
 *     REFRESHED (a token Graph refuses with 401 is evicted and a fresh one used);
 *  5. egress: Graph not allow-listed → 403 `egress_blocked`, nothing requested
 *     of either host; the login host not allow-listed → 403 mid-call naming
 *     both hosts, Graph never reached; under REGULAIT_DEPLOY_MODE=air_gapped the
 *     same refusals hold and the allow-listed pair still sends;
 *  6. a provider refusal (bad client secret) is a named 502, nothing sent;
 *  7. a governance alert reaches outlook as information-only mail;
 *  8. inbound is still `inbound_unsupported_by_design` on every inbound route;
 *  9. the client secret never appears in a response, an audit row or a log line;
 * 10. the mail link's origin is REGULAIT_PUBLIC_URL ONLY: a forged Host header
 *     never reaches a mail; unset (or unusable), registration is refused with
 *     422 `public_url_required` and a post to an existing workspace sends nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  approvals,
  auditLog,
  chatopsConnections,
  chatopsMessages,
  connectorCredentials,
  connectors,
  createDb,
  desc,
  eq,
  gte,
  governanceAlerts,
  inArray,
  runMigrations,
  type Db,
} from "@regulait/db";
import { clearOutlookTokenCache } from "@regulait/connector-provider";
import { buildApp } from "./app.js";
import { resolveGatewayLogger } from "./gateway-logger.js";
import { CHATOPS_OUTBOUND_PROVIDERS, CHATOPS_RULE_IDS } from "./chatops.js";
import { setOrgSettingsForTest } from "./testing/strict-data-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `b26-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
/** obviously synthetic; the assertion of criterion 9 is that it never leaves the wire to the token endpoint */
const CLIENT_SECRET = `SYNTHETIC-outlook-client-secret-${RUN}`;
const TENANT = `tenant-${RUN}.example.test`;
const SENDER = "regulait-approvals@example.test";
const RECIPIENT = "approvers@example.test";
/** the deployment's public URL (with a base path), and a Host a caller forges */
const PUBLIC_URL = "https://approvals.regulait.example.test/gov";
const FORGED_HOST = "login-regulait.evil.example";
const priorPublicUrl = process.env.REGULAIT_PUBLIC_URL;
/** loopback hosts no sibling suite allow-lists (M-048) */
const LOGIN_HOST = "127.0.0.16";
const GRAPH_HOST = "127.0.0.17";
const CONNECTION = `b26-outlook-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const logLines: string[] = [];
const responses: string[] = [];
const startedAt = new Date();

type Hit = { url: string; body: string; authorization: string | undefined };
const loginHits: Hit[] = [];
const graphHits: Hit[] = [];
let loginServer: http.Server;
let graphServer: http.Server;
let loginBase = "";
let graphBase = "";
let mintSeq = 0;
/** what the fake token endpoint answers: a token, or the client-secret refusal */
let loginMode: "ok" | "invalid_client" = "ok";
/** tokens the fake Graph refuses with 401 (a revoked token) */
const graphRefuses = new Set<string>();

let connectorId = "";
let bareConnectorId = "";
let requesterId = "";
let approverId = "";
const allowIds: Record<string, string> = {};
const approvalIds: string[] = [];
let alertId = "";
let restoreOrg: (() => Promise<void>) | undefined;

const inject = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = AUTH) => {
  const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  responses.push(res.body);
  return res;
};

function serve(host: string, hits: Hit[], answer: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url ?? "", body, authorization: req.headers.authorization });
      answer(req, body, res);
    });
  });
  return new Promise<{ server: http.Server; base: string }>((resolve) =>
    server.listen(0, host, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) throw new Error("no address");
      resolve({ server, base: `http://${host}:${addr.port}` });
    }),
  );
}

const allow = async (host: string) => {
  const res = await inject("POST", "/v1/egress-allow-hosts", {
    host,
    allowPrivateRanges: true,
    allowPlaintextHttp: true,
    note: `adr0183 2.6 ${RUN}: local fake ${host === LOGIN_HOST ? "token endpoint" : "Graph"}`,
  });
  expect(res.statusCode, res.body).toBe(201);
  allowIds[host] = res.json().id as string;
};
const disallow = async (host: string) => {
  const id = allowIds[host];
  if (!id) return;
  await inject("DELETE", `/v1/egress-allow-hosts/${id}`);
  delete allowIds[host];
};

async function makeApproval(projectId?: string) {
  const [row] = await db
    .insert(approvals)
    .values({
      userId: requesterId,
      objectType: "mcp_tool",
      toolName: "patients.read",
      stageId: "prod-signoff",
      approverUserId: approverId,
      status: "pending",
      ...(projectId ? { projectId } : {}),
    })
    .returning();
  approvalIds.push(row!.id);
  return row!.id;
}

const postCard = (approvalId: string) =>
  inject("POST", `/v1/chatops/approvals/${approvalId}/post`, { connectionName: CONNECTION }, { ...AUTH, host: FORGED_HOST });

const sends = () => graphHits.filter((h) => h.url.includes("/sendMail"));
const lastMail = () =>
  JSON.parse(sends().at(-1)!.body) as {
    message: { subject: string; body: { contentType: string; content: string }; toRecipients: Array<{ emailAddress: { address: string } }> };
    saveToSentItems: boolean;
  };

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181: the org PII floor ships at block, which fences every approval;
  // criterion 2 needs an unfenced one, criterion 3 sets the floor back itself
  restoreOrg = await setOrgSettingsForTest(db, { defaultPiiMode: "none" });
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  const resolved = resolveGatewayLogger({ LOG_LEVEL: "trace" } as NodeJS.ProcessEnv);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, logger: { ...(resolved as object), stream: sink } as never });

  ({ server: loginServer, base: loginBase } = await serve(LOGIN_HOST, loginHits, (_req, _body, res) => {
    if (loginMode === "invalid_client") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided." }));
      return;
    }
    mintSeq += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token_type: "Bearer", expires_in: 3600, access_token: `graph-token-${mintSeq}` }));
  }));
  ({ server: graphServer, base: graphBase } = await serve(GRAPH_HOST, graphHits, (req, _body, res) => {
    const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (graphRefuses.has(token)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: "InvalidAuthenticationToken", message: "Access token has expired or is not yet valid." } }));
      return;
    }
    res.writeHead(202);
    res.end();
  }));
  await allow(LOGIN_HOST);
  await allow(GRAPH_HOST);

  const mk = async (email: string, displayName: string) => {
    const res = await inject("POST", "/v1/users", { email, displayName });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  requesterId = await mk(`b26-requester-${RUN}@example.test`, "b26 requester");
  approverId = await mk(`b26-approver-${RUN}@example.test`, "b26 approver");

  const c = await inject("POST", "/v1/connectors", { name: `b26-outlook-connector-${RUN}`, kind: "chat", providerKind: "outlook", baseUrl: graphBase });
  expect(c.statusCode, c.body).toBe(201);
  connectorId = c.json().id;
  const bare = await inject("POST", "/v1/connectors", { name: `b26-outlook-bare-${RUN}`, kind: "chat", providerKind: "outlook", baseUrl: graphBase });
  expect(bare.statusCode, bare.body).toBe(201);
  bareConnectorId = bare.json().id;
});

afterAll(async () => {
  delete process.env.REGULAIT_DEPLOY_MODE;
  if (priorPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
  else process.env.REGULAIT_PUBLIC_URL = priorPublicUrl;
  await restoreOrg?.();
  if (approvalIds.length) {
    await db.delete(chatopsMessages).where(inArray(chatopsMessages.approvalId, approvalIds));
    await db.delete(approvals).where(inArray(approvals.id, approvalIds));
  }
  if (alertId) await db.delete(governanceAlerts).where(eq(governanceAlerts.id, alertId));
  await db.delete(chatopsConnections).where(eq(chatopsConnections.name, CONNECTION));
  const ids = [connectorId, bareConnectorId].filter(Boolean);
  if (ids.length) {
    await db.delete(connectorCredentials).where(inArray(connectorCredentials.connectorId, ids));
    await db.delete(connectors).where(inArray(connectors.id, ids));
  }
  for (const host of Object.keys(allowIds)) await disallow(host);
  clearOutlookTokenCache();
  app.server.closeAllConnections();
  await app.close();
  await new Promise<void>((r) => loginServer.close(() => r()));
  await new Promise<void>((r) => graphServer.close(() => r()));
});

const register = (over: Record<string, unknown> = {}) =>
  inject("POST", "/v1/chatops/connections", { name: CONNECTION, provider: "outlook", connectorId, defaultChannel: RECIPIENT, ...over });
const connectionRows = async () => (await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, CONNECTION))).length;

describe("1. registration opens — strictly", () => {
  it("outlook is an outbound provider now", () => {
    expect(CHATOPS_OUTBOUND_PROVIDERS).toContain("outlook");
  });

  it("10: refuses with 422 public_url_required while REGULAIT_PUBLIC_URL is unset or unusable, writing nothing", async () => {
    for (const value of [undefined, "http://evil.example"]) {
      if (value === undefined) delete process.env.REGULAIT_PUBLIC_URL;
      else process.env.REGULAIT_PUBLIC_URL = value;
      try {
        const res = await inject("POST", "/v1/chatops/connections", { name: CONNECTION, provider: "outlook", connectorId, defaultChannel: RECIPIENT }, { ...AUTH, host: FORGED_HOST });
        expect(res.statusCode, res.body).toBe(422);
        expect(res.json().error).toBe("public_url_required");
        expect(String(res.json().detail)).toContain("REGULAIT_PUBLIC_URL");
      } finally {
        process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
      }
    }
    expect(await connectionRows()).toBe(0);
  });

  it("refuses by name, writing nothing: no credential, a bad credential, a bad recipient, chat decide, a signing secret", async () => {
    let res = await register({ connectorId: bareConnectorId });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("connector_credential_missing");

    // the connector credential route itself refuses a malformed app registration…
    const raw = await inject("POST", `/v1/connectors/${connectorId}/credential`, { token: "eyJ.raw.bearer" });
    expect(raw.statusCode).toBe(400);
    expect(raw.json().error).toBe("invalid_connector_credential");
    // …so one stored before that check existed is planted directly
    const { encryptSecret } = await import("./secrets.js");
    await db.insert(connectorCredentials).values({ connectorId: bareConnectorId, tokenCiphertext: encryptSecret(DATA_KEY, JSON.stringify({ appId: "a" })) });
    res = await register({ connectorId: bareConnectorId });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("invalid_connector_credential");
    expect(String(res.json().detail)).toMatch(/tenantId/);

    // the good credential: client id, client secret, tenant, sender mailbox
    const cred = await inject("POST", `/v1/connectors/${connectorId}/credential`, {
      token: JSON.stringify({ appId: `client-${RUN}`, appPassword: CLIENT_SECRET, tenantId: TENANT, senderUpn: SENDER, loginBaseUrl: loginBase }),
    });
    expect(cred.statusCode, cred.body).toBe(201);
    expect(cred.body).not.toContain(CLIENT_SECRET);

    res = await register({ defaultChannel: "C0123456789" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_recipient");
    res = await register({ allowFencedDecide: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("fenced_decide_not_applicable");
    res = await register({ signingSecret: "an-inbound-secret-that-verifies-nothing" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("signing_secret_not_applicable");
    expect(await connectionRows()).toBe(0);
  });

  it("registers with no signing secret, audited, and the list says it can send", async () => {
    const res = await register();
    expect(res.statusCode, res.body).toBe(201);
    const [row] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, CONNECTION));
    expect(row!.provider).toBe("outlook");
    expect(row!.signingSecretCiphertext).toBeNull();
    expect(row!.allowFencedDecide).toBe(false);
    const list = await inject("GET", "/v1/chatops/connections");
    const mine = (list.json().connections as Array<{ name: string; outboundSupported: boolean; signingSecretSet: boolean }>).find((c) => c.name === CONNECTION);
    expect(mine).toMatchObject({ outboundSupported: true, signingSecretSet: false });
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.objectId, row!.id));
    expect(audit!.ruleId).toBe(CHATOPS_RULE_IDS.connectionRegistered);
  });
});

describe("2–4. an approval card is delivered as mail: summary, portal link, no decision, cached token", () => {
  it("2: sendMail from the sender mailbox to the recipient, with the summary and an absolute portal link, and no way to decide", async () => {
    clearOutlookTokenCache();
    const approvalId = await makeApproval();
    const tokensBefore = loginHits.length;
    const res = await postCard(approvalId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ redacted: false, decidable: false, messageRef: null });

    // the token request: client credentials for the tenant, the Graph scope
    expect(loginHits.length).toBe(tokensBefore + 1);
    const tokenReq = loginHits.at(-1)!;
    expect(tokenReq.url).toBe(`/${encodeURIComponent(TENANT)}/oauth2/v2.0/token`);
    expect(tokenReq.body).toContain("grant_type=client_credentials");
    expect(tokenReq.body).toContain(encodeURIComponent("https://graph.microsoft.com/.default"));

    const send = sends().at(-1)!;
    expect(send.url).toBe(`/v1.0/users/${encodeURIComponent(SENDER)}/sendMail`);
    expect(send.authorization).toBe("Bearer graph-token-1");
    const mail = lastMail();
    expect(mail.message.toRecipients).toEqual([{ emailAddress: { address: RECIPIENT } }]);
    expect(mail.message.subject).toBe("RegulAIt: an approval needs you");
    expect(mail.message.body.contentType).toBe("HTML");
    const html = mail.message.body.content;
    expect(html).toContain("<code>patients.read</code>");
    expect(html).toContain("<code>prod-signoff</code>");
    // the link is built from REGULAIT_PUBLIC_URL; the forged Host the request carried is nowhere
    expect(html).toContain(`<a href="${PUBLIC_URL}/ui/admin/review-workbench?approval=${approvalId}">Open this approval in RegulAIt to decide</a>`);
    expect(sends().at(-1)!.body).not.toContain(FORGED_HOST);
    expect(html).toContain("never by replying to this message");
    // NO decision affordance: no button, no decide link, no bearer token in a link
    expect(html).not.toMatch(/Action\.Submit|regulait_approve|regulait_reject|mailto:|token=|[?&](action|decision)=/i);
    expect(html).not.toMatch(/>\s*(Approve|Reject|Deny)\s*</);
    expect(mail.saveToSentItems).toBe(true);

    const [msg] = await db.select().from(chatopsMessages).where(eq(chatopsMessages.approvalId, approvalId));
    expect(msg).toMatchObject({ decidable: false, redacted: false, channel: RECIPIENT, messageRef: null });
  });

  it("4: the token is cached across sends, and a token Graph refuses (401) is replaced by a fresh one", async () => {
    const tokensBefore = loginHits.length;
    await postCard(await makeApproval());
    await postCard(await makeApproval());
    expect(loginHits.length).toBe(tokensBefore); // cached: no new token request
    expect(sends().slice(-2).map((s) => s.authorization)).toEqual(["Bearer graph-token-1", "Bearer graph-token-1"]);

    graphRefuses.add("graph-token-1"); // revoked before its expiry
    const res = await postCard(await makeApproval());
    expect(res.statusCode, res.body).toBe(200);
    expect(loginHits.length).toBe(tokensBefore + 1); // refreshed once
    expect(sends().slice(-2).map((s) => s.authorization)).toEqual(["Bearer graph-token-1", "Bearer graph-token-2"]);
    graphRefuses.clear();
  });

  it("3: a fenced approval's mail names nothing and says its content is withheld", async () => {
    const restore = await setOrgSettingsForTest(db, { defaultPiiMode: "block" });
    try {
      const res = await postCard(await makeApproval());
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ redacted: true, decidable: false });
      const mail = lastMail();
      expect(mail.message.subject).toBe("RegulAIt: an approval needs you (content withheld)");
      for (const leak of ["patients.read", "prod-signoff", "b26-requester", "b26-approver"]) expect(mail.message.body.content).not.toContain(leak);
      expect(mail.message.body.content).toContain("details are withheld");
    } finally {
      await restore();
    }
  });
});

describe("5. both hosts go through the egress guard", () => {
  const refusedEgress = async () =>
    (await db.select().from(auditLog).where(eq(auditLog.ruleId, CHATOPS_RULE_IDS.postRefusedEgress))).filter((r) => r.at >= startedAt);

  it("Graph not allow-listed: 403 egress_blocked by name, and neither host is asked anything", async () => {
    clearOutlookTokenCache();
    await disallow(GRAPH_HOST);
    try {
      const before = { login: loginHits.length, graph: graphHits.length };
      const res = await postCard(await makeApproval());
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
      expect(loginHits.length).toBe(before.login);
      expect(graphHits.length).toBe(before.graph);
    } finally {
      await allow(GRAPH_HOST);
    }
  });

  it("the login host not allow-listed: refused mid-call, naming both hosts; Graph never reached", async () => {
    clearOutlookTokenCache();
    await disallow(LOGIN_HOST);
    try {
      const before = { login: loginHits.length, graph: graphHits.length, audits: (await refusedEgress()).length };
      const res = await postCard(await makeApproval());
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
      expect(String(res.json().detail)).toMatch(/Entra login host as well as Microsoft Graph/);
      expect(loginHits.length).toBe(before.login);
      expect(graphHits.length).toBe(before.graph);
      const audits = await refusedEgress();
      expect(audits.length).toBe(before.audits + 1);
      expect((audits.at(-1)!.detail as { phase?: string }).phase).toBe("adapter");
    } finally {
      await allow(LOGIN_HOST);
    }
  });

  it("air_gapped: the same refusal without the allow entries, and the allow-listed pair still sends", async () => {
    process.env.REGULAIT_DEPLOY_MODE = "air_gapped";
    try {
      clearOutlookTokenCache();
      await disallow(GRAPH_HOST);
      const before = graphHits.length;
      const refused = await postCard(await makeApproval());
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error).toBe("egress_blocked");
      expect(graphHits.length).toBe(before);
      await allow(GRAPH_HOST);
      const sent = await postCard(await makeApproval());
      expect(sent.statusCode, sent.body).toBe(200);
      expect(graphHits.length).toBe(before + 1);
    } finally {
      delete process.env.REGULAIT_DEPLOY_MODE;
    }
  });
});

describe("6–8. failures, alerts and the inbound path that does not exist", () => {
  it("6: a refused client secret is a named 502, and nothing is sent", async () => {
    clearOutlookTokenCache();
    loginMode = "invalid_client";
    try {
      const before = graphHits.length;
      const res = await postCard(await makeApproval());
      expect(res.statusCode, res.body).toBe(502);
      expect(res.json().error).toBe("chatops_post_failed");
      expect(String(res.json().detail)).toContain("invalid_client");
      expect(graphHits.length).toBe(before);
    } finally {
      loginMode = "ok";
    }
  });

  it("7: a governance alert is sent as information-only mail", async () => {
    const [alert] = await db
      .insert(governanceAlerts)
      .values({ ruleId: "spend_spike", subjectKey: `b26-${RUN}`, severity: "high", title: `b26 spend spike ${RUN}` })
      .returning();
    alertId = alert!.id;
    const res = await inject("POST", `/v1/governance/alerts/${alertId}/post`, { connectionName: CONNECTION });
    expect(res.statusCode, res.body).toBe(200);
    const mail = lastMail();
    expect(mail.message.subject).toMatch(/^RegulAIt: governance alert \(HIGH\) — /);
    expect(mail.message.body.content).toContain(`b26 spend spike ${RUN}`);
    expect(mail.message.body.content).toContain(`<a href="${PUBLIC_URL}/ui/admin/governance/alerts?alert=${alertId}">`);
    expect(mail.message.body.content).toContain("Replies to this message are not read.");
  });

  it("10: with REGULAIT_PUBLIC_URL unset, a post to the existing workspace is refused by name and nothing is sent", async () => {
    delete process.env.REGULAIT_PUBLIC_URL;
    try {
      const before = { login: loginHits.length, graph: graphHits.length };
      const res = await postCard(await makeApproval());
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error).toBe("public_url_required");
      expect({ login: loginHits.length, graph: graphHits.length }).toEqual(before);
      // the alert path is refused the same way (the alert route reports the failure)
      const alertRes = await inject("POST", `/v1/governance/alerts/${alertId}/post`, { connectionName: CONNECTION });
      expect(alertRes.statusCode).toBe(502);
      expect(graphHits.length).toBe(before.graph);
    } finally {
      process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
    }
  });

  it("L1: a per-post recipient other than the registered mailbox is refused (403), audited, and nothing is sent", async () => {
    const approvalId = await makeApproval();
    const before = { login: loginHits.length, graph: graphHits.length };
    for (const channel of ["outsider@evil.example", "ANA@other.example"]) {
      const res = await inject("POST", `/v1/chatops/approvals/${approvalId}/post`, { connectionName: CONNECTION, channel });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe("recipient_not_registered");
    }
    const alertRes = await inject("POST", `/v1/governance/alerts/${alertId}/post`, { connectionName: CONNECTION, channel: "outsider@evil.example" });
    expect(alertRes.statusCode).not.toBe(200);
    expect({ login: loginHits.length, graph: graphHits.length }).toEqual(before);
    const refused = (await db.select().from(auditLog).where(eq(auditLog.ruleId, CHATOPS_RULE_IDS.postRefusedRecipient))).filter((r) => r.at >= startedAt);
    expect(refused.length).toBeGreaterThanOrEqual(3);
    // the registered recipient, named explicitly (any case), still sends
    const ok = await inject("POST", `/v1/chatops/approvals/${approvalId}/post`, { connectionName: CONNECTION, channel: RECIPIENT.toUpperCase() });
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it("ADR-0185: an admin's recipient allow-list adds exact mailboxes (audited with transitions); nothing else is reachable", async () => {
    const EXTRA = "cab@example.test";
    const [conn] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, CONNECTION));
    const patch = (list: unknown) => inject("PATCH", `/v1/chatops/connections/${conn!.id}`, { outlookRecipientAllowList: list });
    expect(conn!.outlookRecipientAllowList).toEqual([]); // strict default: the registered mailbox only
    // refused by name, nothing saved
    let res = await patch(["example.test"]);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("invalid_recipient");
    res = await patch(["@example.test"]);
    expect(res.json().error).toBe("invalid_recipient");
    res = await patch(Array.from({ length: 51 }, (_, i) => `r${i}@example.test`));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("allow_list_too_long");
    expect((await db.select().from(chatopsConnections).where(eq(chatopsConnections.id, conn!.id)))[0]!.outlookRecipientAllowList).toEqual([]);

    res = await patch([" CAB@Example.test ", EXTRA]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().outlookRecipientAllowList).toEqual([EXTRA]);
    const [changed] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, CHATOPS_RULE_IDS.outlookRecipientsChanged))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(changed!.objectId).toBe(conn!.id);
    expect(changed!.detail).toMatchObject({ transitions: { outlookRecipientAllowList: { from: [], to: [EXTRA] } } });
    const list = (await inject("GET", "/v1/chatops/connections")).json().connections as Array<{ name: string; outlookRecipientAllowList: string[] }>;
    expect(list.find((c) => c.name === CONNECTION)?.outlookRecipientAllowList).toEqual([EXTRA]);

    // the allow-listed mailbox (any case) is reachable; anything else is still refused
    const approvalId = await makeApproval();
    const ok = await inject("POST", `/v1/chatops/approvals/${approvalId}/post`, { connectionName: CONNECTION, channel: EXTRA.toUpperCase() });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(lastMail().message.toRecipients.map((r) => r.emailAddress.address.toLowerCase())).toEqual([EXTRA]);
    const before = graphHits.length;
    const refused = await inject("POST", `/v1/chatops/approvals/${approvalId}/post`, { connectionName: CONNECTION, channel: "other@example.test" });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe("recipient_not_registered");
    expect(graphHits.length).toBe(before);

    // emptied again: back to the registered mailbox only
    res = await patch([]);
    expect(res.statusCode).toBe(200);
    const again = await inject("POST", `/v1/chatops/approvals/${approvalId}/post`, { connectionName: CONNECTION, channel: EXTRA });
    expect(again.statusCode).toBe(403);
    expect(graphHits.length).toBe(before);
  });

  it("8: every inbound route still refuses outlook BY NAME", async () => {
    for (const route of ["interactions", "events", "messages"]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/chatops/${CONNECTION}/${route}`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ approvalId: approvalIds[0], action: "approve" }),
      });
      responses.push(res.body);
      expect(res.statusCode, `${route}: ${res.body}`).toBe(401);
      if (route === "interactions") expect(res.json().code).toBe("inbound_unsupported_by_design");
    }
  });
});

describe("9. the client secret never leaves the wire to the token endpoint", () => {
  it("is in no response, no audit row since this file began, no log line, and no Graph request", async () => {
    // positive control: it WAS used, on the one wire that must carry it
    expect(loginHits.some((h) => h.body.includes(encodeURIComponent(CLIENT_SECRET)))).toBe(true);
    expect(responses.length).toBeGreaterThan(10);
    for (const body of responses) expect(body).not.toContain(CLIENT_SECRET);
    const audits = await db.select().from(auditLog).where(gte(auditLog.at, startedAt));
    expect(audits.length).toBeGreaterThan(5);
    for (const row of audits) expect(JSON.stringify(row)).not.toContain(CLIENT_SECRET);
    expect(logLines.length).toBeGreaterThan(5);
    for (const line of logLines) expect(line).not.toContain(CLIENT_SECRET);
    for (const hit of graphHits) {
      expect(hit.body).not.toContain(CLIENT_SECRET);
      expect(hit.authorization ?? "").not.toContain(CLIENT_SECRET);
    }
  });
});
