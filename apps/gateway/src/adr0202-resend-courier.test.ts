/**
 * ADR-0202 lane E — the Resend email courier for approvals and alerts, a
 * send-only ChatOps provider modelled on the Outlook courier (ADR-0121,
 * ADR-0183 2.6). Against a local fake Resend API on its own loopback host, so
 * the egress guard adjudicates it like any vendor host:
 *
 *  1. registration is strict: REGULAIT_PUBLIC_URL unset, no credential, a
 *     malformed one (no sender), a recipient, chat decide and a signing secret
 *     are each refused by name and write nothing; the good one registers with
 *     no secret, audited, and the list says it can send;
 *  2. an approval is mailed to its NAMED APPROVER, from the credential's
 *     sender, with the portal link and no decision affordance, every untrusted
 *     field HTML-escaped; a request-named recipient is refused and audited, and
 *     so is an approver who is disabled;
 *  3. egress: the Resend host not allow-listed → 403 `egress_blocked`, audited,
 *     nothing requested;
 *  4. sends are rate-limited per workspace (429, audited, nothing sent);
 *  5. a governance alert is mailed to its OWNER only; an unowned alert is not
 *     mailed, and a request cannot name a recipient (refused and audited);
 *  5b. the courier's own recipient pin (#568 review item 2): called directly
 *     with a recipient other than the server-resolved one, it refuses, audited,
 *     and sends nothing, whichever route would have called it;
 *  6. inbound stays `inbound_unsupported_by_design`;
 *  7. the API key never appears in a response, an audit row or a log line.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { trackEgressAllowHosts } from "./testing/egress-allow-cleanup.js";
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
  eq,
  gte,
  governanceAlerts,
  inArray,
  runMigrations,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { resolveGatewayLogger } from "./gateway-logger.js";
import { CHATOPS_OUTBOUND_PROVIDERS, CHATOPS_RULE_IDS, RESEND_RECIPIENT_MODE, RESEND_SEND_LIMIT, chatCourierForTest } from "./chatops.js";
import { setOrgSettingsForTest } from "./testing/strict-data-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `e2-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "e".repeat(64);
/** obviously synthetic; criterion 7 is that it never leaves the wire to the fake API */
const API_KEY = `re_SYNTHETIC_resend_key_${RUN}`;
const SENDER = "approvals@mail.example.com";
const PUBLIC_URL = "https://regulait.example.com";
const priorPublicUrl = process.env.REGULAIT_PUBLIC_URL;
/** a loopback host no sibling suite allow-lists (M-048) */
const RESEND_HOST = "127.0.0.31";
const CONNECTION = `e2-resend-${RUN}`;
const HOSTILE = `<img src=x onerror="alert('${RUN}')">`;

let db: Db;
let app: ReturnType<typeof buildApp>;
const logLines: string[] = [];
const responses: string[] = [];
const startedAt = new Date();

type Hit = { url: string; body: string; authorization: string | undefined };
const hits: Hit[] = [];
let server: http.Server;
let base = "";
let seq = 0;

let connectorId = "";
let bareConnectorId = "";
let connectionId = "";
let requesterId = "";
let approverId = "";
let approverEmail = "";
let disabledId = "";
const allowed = trackEgressAllowHosts();
let allowId: string | undefined;
const approvalIds: string[] = [];
const alertIds: string[] = [];
let restoreOrg: (() => Promise<void>) | undefined;

const inject = async (method: "GET" | "POST" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = AUTH) => {
  const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
  responses.push(res.body);
  return res;
};

const allow = async () => {
  const res = await relaxStepUpAround(db, () => inject("POST", "/v1/egress-allow-hosts", {
    host: allowed.trackHost(RESEND_HOST),
    allowPrivateRanges: true,
    allowPlaintextHttp: true,
    note: `adr0202 lane E ${RUN}: local fake Resend API`,
  }));
  expect(res.statusCode, res.body).toBe(201);
  allowId = res.json().id;
};
const disallow = async () => {
  if (!allowId) return;
  await inject("DELETE", `/v1/egress-allow-hosts/${allowId}`);
  allowId = undefined;
};

async function makeApproval(over: Record<string, unknown> = {}) {
  const [row] = await db
    .insert(approvals)
    .values({ userId: requesterId, objectType: "mcp_tool", toolName: HOSTILE, stageId: "prod-signoff", approverUserId: approverId, status: "pending", ...over })
    .returning();
  approvalIds.push(row!.id);
  return row!.id;
}
const postCard = (approvalId: string, over: Record<string, unknown> = {}) =>
  inject("POST", `/v1/chatops/approvals/${approvalId}/post`, { connectionName: CONNECTION, ...over });
const lastSend = () => JSON.parse(hits.at(-1)!.body) as { from: string; to: string[]; subject: string; html: string };
const auditSince = async (ruleId: string) =>
  (await db.select().from(auditLog).where(gte(auditLog.at, startedAt))).filter((r) => r.ruleId === ruleId && r.objectId === connectionId);

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreOrg = await setOrgSettingsForTest(db, { defaultPiiMode: "none" });
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logLines.push(String(chunk));
      cb();
    },
  });
  const resolved = resolveGatewayLogger({ LOG_LEVEL: "trace" } as NodeJS.ProcessEnv);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY, logger: { ...(resolved as object), stream: sink } as never });

  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url ?? "", body, authorization: req.headers.authorization });
      seq += 1;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `email-${seq}` }));
    });
  });
  base = await new Promise<string>((resolve) =>
    server.listen(0, RESEND_HOST, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) throw new Error("no address");
      resolve(`http://${RESEND_HOST}:${addr.port}`);
    }),
  );
  await allow();

  const mk = async (email: string, displayName: string) => {
    const res = await inject("POST", "/v1/users", { email, displayName });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  requesterId = await mk(`e2-requester-${RUN}@example.com`, "e2 requester");
  approverEmail = `e2-approver-${RUN}@example.com`;
  approverId = await mk(approverEmail, "e2 approver");
  disabledId = await mk(`e2-disabled-${RUN}@example.com`, "e2 disabled");
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, disabledId));

  const c = await inject("POST", "/v1/connectors", { name: `e2-resend-connector-${RUN}`, kind: "chat", providerKind: "resend", baseUrl: base });
  expect(c.statusCode, c.body).toBe(201);
  connectorId = c.json().id;
  const bare = await inject("POST", "/v1/connectors", { name: `e2-resend-bare-${RUN}`, kind: "chat", providerKind: "resend", baseUrl: base });
  expect(bare.statusCode, bare.body).toBe(201);
  bareConnectorId = bare.json().id;
});

afterAll(async () => {
  const entries = await allowed.removeAll(app, AUTH);
  try {
    if (priorPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
    else process.env.REGULAIT_PUBLIC_URL = priorPublicUrl;
    await restoreOrg?.();
    if (connectionId) await db.execute(sql`delete from rate_limit_counters where bucket = ${`chatops-resend:${connectionId}`}`);
    if (approvalIds.length) {
      await db.delete(chatopsMessages).where(inArray(chatopsMessages.approvalId, approvalIds));
      await db.delete(approvals).where(inArray(approvals.id, approvalIds));
    }
    if (alertIds.length) await db.delete(governanceAlerts).where(inArray(governanceAlerts.id, alertIds));
    await db.delete(chatopsConnections).where(eq(chatopsConnections.name, CONNECTION));
    const ids = [connectorId, bareConnectorId].filter(Boolean);
    if (ids.length) {
      await db.delete(connectorCredentials).where(inArray(connectorCredentials.connectorId, ids));
      await db.delete(connectors).where(inArray(connectors.id, ids));
    }
    app.server.closeAllConnections();
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  } finally {
    entries.assertRemoved();
  }
});

const register = (over: Record<string, unknown> = {}) =>
  inject("POST", "/v1/chatops/connections", { name: CONNECTION, provider: "resend", connectorId, defaultChannel: RESEND_RECIPIENT_MODE, ...over });
const connectionRows = async () => (await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, CONNECTION))).length;

describe("1. registration is strict", () => {
  it("resend is an outbound provider", () => {
    expect(CHATOPS_OUTBOUND_PROVIDERS).toContain("resend");
  });

  it("refuses by name, writing nothing: no public URL, no credential, no sender, a recipient, chat decide, a signing secret", async () => {
    delete process.env.REGULAIT_PUBLIC_URL;
    try {
      const res = await register();
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().error).toBe("public_url_required");
    } finally {
      process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
    }
    let res = await register({ connectorId: bareConnectorId });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("connector_credential_missing");

    // the credential route refuses a key with no explicit sender
    const noSender = await inject("POST", `/v1/connectors/${connectorId}/credential`, { token: JSON.stringify({ apiKey: API_KEY }) });
    expect(noSender.statusCode).toBe(400);
    expect(noSender.json().error).toBe("invalid_connector_credential");
    expect(noSender.body).not.toContain(API_KEY);

    const cred = await inject("POST", `/v1/connectors/${connectorId}/credential`, { token: JSON.stringify({ apiKey: API_KEY, from: SENDER }) });
    expect(cred.statusCode, cred.body).toBe(201);
    expect(cred.body).not.toContain(API_KEY);

    res = await register({ defaultChannel: "anyone@example.net" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("recipient_not_configurable");
    res = await register({ allowFencedDecide: true });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("fenced_decide_not_applicable");
    res = await register({ signingSecret: "an-inbound-secret-that-verifies-nothing" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("signing_secret_not_applicable");
    expect(await connectionRows()).toBe(0);
    // the storage refuses a resend row naming a recipient even if a caller bypasses the route
    await expect(
      db.insert(chatopsConnections).values({ name: `${CONNECTION}-raw`, provider: "resend", connectorId, defaultChannel: "anyone@example.net" }),
    ).rejects.toThrow();
  });

  it("registers with no signing secret, audited, and the list says it can send and returns no key", async () => {
    const res = await register({ notifyAlertMinSeverity: "high" });
    expect(res.statusCode, res.body).toBe(201);
    const [row] = await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, CONNECTION));
    connectionId = row!.id;
    expect(row).toMatchObject({ provider: "resend", signingSecretCiphertext: null, allowFencedDecide: false, defaultChannel: RESEND_RECIPIENT_MODE });
    const list = await inject("GET", "/v1/chatops/connections");
    const mine = (list.json().connections as Array<{ name: string }>).find((c) => c.name === CONNECTION);
    expect(mine).toMatchObject({ outboundSupported: true, signingSecretSet: false });
    const creds = await inject("GET", "/v1/connectors");
    expect(creds.body).not.toContain(API_KEY);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.objectId, row!.id));
    expect(audit!.ruleId).toBe(CHATOPS_RULE_IDS.connectionRegistered);
  });
});

describe("2. an approval is mailed to its named approver only", () => {
  it("sends one mail from the configured sender to the approver, escaped, with the portal link and no way to decide", async () => {
    const approvalId = await makeApproval();
    const before = hits.length;
    const res = await postCard(approvalId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ decidable: false, redacted: false, messageRef: `email-${seq}` });
    expect(hits.length).toBe(before + 1);
    expect(hits.at(-1)!.url).toBe("/emails");
    expect(hits.at(-1)!.authorization).toBe(`Bearer ${API_KEY}`);
    const mail = lastSend();
    expect(mail.from).toBe(SENDER);
    expect(mail.to).toEqual([approverEmail]);
    expect(mail.subject).toBe("RegulAIt: an approval needs you");
    // the hostile tool name is text, never markup
    expect(mail.html).not.toContain("<img");
    expect(mail.html).not.toContain(`'${RUN}'`);
    expect(mail.html).toContain("&lt;img src=x onerror=&quot;alert(&#39;");
    expect(mail.html).toContain(`<a href="${PUBLIC_URL}/ui/admin/review-workbench?approval=${approvalId}">`);
    expect(mail.html).not.toMatch(/regulait_approve|regulait_reject|mailto:|token=|[?&](action|decision)=/i);
    const [msg] = await db.select().from(chatopsMessages).where(eq(chatopsMessages.approvalId, approvalId));
    expect(msg).toMatchObject({ decidable: false, channel: approverEmail });
  });

  it("refuses a request-named recipient, audited, nothing sent", async () => {
    const approvalId = await makeApproval();
    const before = hits.length;
    const auditsBefore = (await auditSince(CHATOPS_RULE_IDS.postRefusedNoNamedRecipient)).length;
    for (const channel of ["attacker@example.net", approverEmail]) {
      const res = await postCard(approvalId, { channel });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe("recipient_not_selectable");
    }
    expect(hits.length).toBe(before);
    expect((await auditSince(CHATOPS_RULE_IDS.postRefusedNoNamedRecipient)).length).toBe(auditsBefore + 2);
  });

  it("refuses when the named approver is disabled: nobody else is mailed instead", async () => {
    const approvalId = await makeApproval({ approverUserId: disabledId });
    const before = hits.length;
    const res = await postCard(approvalId);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error).toBe("no_named_recipient");
    expect(hits.length).toBe(before);
  });
});

describe("3. every send passes the egress guard", () => {
  it("the Resend host not allow-listed: 403 egress_blocked, audited, nothing requested", async () => {
    const approvalId = await makeApproval();
    await disallow();
    const before = hits.length;
    try {
      const res = await postCard(approvalId);
      expect(res.statusCode, res.body).toBe(403);
      expect(res.json().error).toBe("egress_blocked");
      expect(hits.length).toBe(before);
      expect((await auditSince(CHATOPS_RULE_IDS.postRefusedEgress)).length).toBeGreaterThan(0);
    } finally {
      // egress-allow-cleanup: afterAll — the re-created entry is a tracked host, removed by afterAll
      await allow();
    }
  });
});

describe("5. a governance alert is mailed to its owner only", () => {
  const mkAlert = async (ownerUserId: string | null) => {
    const [alert] = await db
      .insert(governanceAlerts)
      .values({ ruleId: "spend_spike", subjectKey: `e2-${RUN}-${alertIds.length}`, severity: "high", title: `e2 spend spike ${HOSTILE}`, ownerUserId, ...(ownerUserId ? { ownerSource: "assigned" as const } : {}) })
      .returning();
    alertIds.push(alert!.id);
    return alert!.id;
  };

  it("an owned alert reaches its owner, escaped", async () => {
    const alertId = await mkAlert(approverId);
    const res = await inject("POST", `/v1/governance/alerts/${alertId}/post`, { connectionName: CONNECTION });
    expect(res.statusCode, res.body).toBe(200);
    const mail = lastSend();
    expect(mail.to).toEqual([approverEmail]);
    expect(mail.subject).toMatch(/^RegulAIt: governance alert \(HIGH\) — /);
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain(`<a href="${PUBLIC_URL}/ui/admin/governance/alerts?alert=${alertId}">`);
  });

  it("an unowned alert is not mailed, and a request cannot name a recipient", async () => {
    const alertId = await mkAlert(null);
    const before = hits.length;
    let res = await inject("POST", `/v1/governance/alerts/${alertId}/post`, { connectionName: CONNECTION });
    expect(res.statusCode, res.body).toBe(502);
    res = await inject("POST", `/v1/governance/alerts/${alertId}/post`, { connectionName: CONNECTION, channel: "attacker@example.net" });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error).toBe("recipient_not_selectable");
    expect(hits.length).toBe(before);
  });

  it("#568 review item 1: a request-named recipient on an alert is refused AND audited, for an owned alert too", async () => {
    const alertId = await mkAlert(approverId);
    const before = hits.length;
    const refusals = async () =>
      (await auditSince(CHATOPS_RULE_IDS.postRefusedNoNamedRecipient)).filter((r) => (r.detail as { alertId?: string }).alertId === alertId);
    for (const channel of ["attacker@example.net", approverEmail]) {
      const res = await inject("POST", `/v1/governance/alerts/${alertId}/post`, { connectionName: CONNECTION, channel });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().error).toBe("recipient_not_selectable");
    }
    expect(hits.length).toBe(before);
    const rows = await refusals();
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.effect).toBe("deny");
      expect(r.detail).toMatchObject({ subsystem: "chatops", alertId, label: "alert-mirror" });
      // the refused address is not copied into the audit row
      expect(JSON.stringify(r)).not.toContain("attacker@example.net");
    }
  });
});

describe("5b. the courier's own recipient pin (#568 review item 2)", () => {
  const mail = () => ({ op: "sendEmail", subject: "pin probe", html: "<p>pin probe</p>" });
  const connRow = async () => (await db.select().from(chatopsConnections).where(eq(chatopsConnections.name, CONNECTION)))[0]!;

  it("refuses a channel that is not the server-resolved recipient, or no resolved recipient at all: 403, audited, nothing sent", async () => {
    const courier = chatCourierForTest(db);
    expect(courier).toBeDefined();
    const conn = await connRow();
    const before = hits.length;
    const auditsBefore = (await auditSince(CHATOPS_RULE_IDS.postRefusedNoNamedRecipient)).length;
    const cases: Array<[string, string | null]> = [
      ["attacker@example.net", approverEmail],
      [approverEmail, null],
      [`${approverEmail}.example.net`, approverEmail],
      ["not-an-address", "not-an-address"],
    ];
    for (const [channel, named] of cases) {
      const res = await courier!(conn, channel, mail, null, "pin-probe", named);
      expect(res, `${channel} / ${named}`).toMatchObject({ ok: false, status: 403, body: { error: "recipient_not_named" } });
    }
    expect(hits.length).toBe(before);
    expect((await auditSince(CHATOPS_RULE_IDS.postRefusedNoNamedRecipient)).length).toBe(auditsBefore + cases.length);
  });

  it("positive control: the same call to the resolved recipient sends one mail to that address", async () => {
    const before = hits.length;
    const res = await chatCourierForTest(db)!(await connRow(), approverEmail, mail, null, "pin-probe", approverEmail);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(hits.length).toBe(before + 1);
    expect(lastSend().to).toEqual([approverEmail]);
  });
});

// last of the sending tests: a saturated window refuses every later send in it (local pre-filter)
describe("4. sends are rate-limited per workspace", () => {
  it("past the window's ceiling: 429, audited, nothing sent", async () => {
    // the shared counter at the ceiling, as other replicas would leave it
    await db.execute(sql`
      insert into rate_limit_counters (bucket, window_started_at, hits)
      values (${`chatops-resend:${connectionId}`}, now(), ${RESEND_SEND_LIMIT.max})
      on conflict (bucket) do update set window_started_at = now(), hits = ${RESEND_SEND_LIMIT.max}`);
    const approvalId = await makeApproval();
    const before = hits.length;
    const res = await postCard(approvalId);
    expect(res.statusCode, res.body).toBe(429);
    expect(res.json().error).toBe("rate_limited");
    expect(hits.length).toBe(before);
    expect((await auditSince(CHATOPS_RULE_IDS.resendSendRateLimited)).length).toBe(1);
    await db.execute(sql`delete from rate_limit_counters where bucket = ${`chatops-resend:${connectionId}`}`);
  });
});

describe("6–7. no inbound, and the key never leaks", () => {
  it("inbound is refused by design", async () => {
    const res = await inject("POST", `/v1/chatops/${encodeURIComponent(CONNECTION)}/interactions`, "payload=%7B%7D", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("inbound_unsupported_by_design");
  });

  it("the API key is in no response, audit row or log line", async () => {
    for (const body of responses) expect(body).not.toContain(API_KEY);
    for (const line of logLines) expect(line).not.toContain(API_KEY);
    const rows = await db.select().from(auditLog).where(gte(auditLog.at, startedAt));
    for (const r of rows) expect(JSON.stringify(r)).not.toContain(API_KEY);
    // and the one place it does go: the Authorization header to the Resend host
    expect(hits.some((h) => h.authorization === `Bearer ${API_KEY}`)).toBe(true);
  });
});
