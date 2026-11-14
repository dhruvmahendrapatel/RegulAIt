/**
 * ADR-0090 amendment (lane L11) — certification-campaign deadline notices through ChatOps.
 *
 * A local fake Resend API on its own loopback host (the ADR-0202 test's pattern), so the egress guard adjudicates it
 * like a vendor. Other files may leave open campaigns behind; every assertion names this file's campaigns and mails
 * by id.
 *  1. off by default: with no workspace opted in nothing is sent and nothing is recorded;
 *  2. opted in: a due-soon reminder mails each NAMED REVIEWER their own count, once; nothing operator-typed (campaign
 *     name, holder or object label) is in the mail; one audit marker per campaign and kind;
 *  3. at expiry, one expiry notice, once; a campaign due later than 48 h gets nothing;
 *  4. the toggle is audited.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  and,
  auditLog,
  chatopsConnections,
  connectorCredentials,
  connectors,
  createDb,
  eq,
  grantCertificationCampaigns,
  grantCertificationItems,
  inArray,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { trackEgressAllowHosts } from "./testing/egress-allow-cleanup.js";
import { setOrgSettingsForTest } from "./testing/strict-data-posture.js";
import { CHATOPS_RULE_IDS, RESEND_RECIPIENT_MODE } from "./chatops.js";
import { CAMPAIGN_DEADLINE_NOTIFIED_RULE_ID, runCampaignDeadlineNotifySweep } from "./grant-certification.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `cdn-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "c".repeat(64);
const API_KEY = `re_SYNTHETIC_campaign_${RUN}`;
const SENDER = "reviews@mail.example.com";
const PUBLIC_URL = "https://regulait.example.com";
const priorPublicUrl = process.env.REGULAIT_PUBLIC_URL;
/** a loopback host no sibling suite allow-lists (M-048) */
const RESEND_HOST = "127.0.0.37";
const CONNECTION = `cdn-resend-${RUN}`;
const SECRET_NAME = `Q4 review of the payroll agent ${RUN}`;
const HOLDER_LABEL = `holder-label-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let server: http.Server;
let base = "";
const hits: Array<{ to: string[]; subject: string; html: string }> = [];
let connectorId = "";
let connectionId = "";
let openerId = "";
let reviewerA = "";
let reviewerB = "";
const emails: Record<string, string> = {};
const campaignIds: string[] = [];
const allowed = trackEgressAllowHosts();
let restoreOrg: (() => Promise<void>) | undefined;

const inject = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
  app.inject({ method, url, headers: AUTH, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function makeCampaign(dueInHours: number, items: Array<{ reviewer: string; decided?: boolean }>): Promise<string> {
  const [c] = await db
    .insert(grantCertificationCampaigns)
    .values({
      name: SECRET_NAME,
      scopeKind: "all",
      openedByUserId: openerId,
      dueAt: new Date(Date.now() + dueInHours * 3600_000),
    } as typeof grantCertificationCampaigns.$inferInsert)
    .returning({ id: grantCertificationCampaigns.id });
  campaignIds.push(c!.id);
  for (const it of items) {
    await db.insert(grantCertificationItems).values({
      campaignId: c!.id,
      grantKind: "agent",
      grantId: randomUUID(),
      holderUserId: openerId,
      holderLabel: HOLDER_LABEL,
      objectLabel: `object-label-${RUN}`,
      reviewerUserId: it.reviewer,
      ...(it.decided ? { decision: "keep" as const, decidedByUserId: it.reviewer, decidedAt: new Date() } : {}),
    });
  }
  return c!.id;
}
const mailsFor = (email: string) => hits.filter((h) => h.to.includes(email));
const markers = async (campaignId: string) =>
  db.select().from(auditLog).where(and(eq(auditLog.ruleId, CAMPAIGN_DEADLINE_NOTIFIED_RULE_ID), eq(auditLog.objectId, campaignId)));

beforeAll(async () => {
  process.env.REGULAIT_PUBLIC_URL = PUBLIC_URL;
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreOrg = await setOrgSettingsForTest(db, { defaultPiiMode: "none" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        hits.push(JSON.parse(body));
      } catch {
        /* not a send */
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: `email-${hits.length}` }));
    });
  });
  base = await new Promise<string>((resolve) =>
    server.listen(0, RESEND_HOST, () => {
      const addr = server.address();
      if (typeof addr !== "object" || !addr) throw new Error("no address");
      resolve(`http://${RESEND_HOST}:${addr.port}`);
    }),
  );
  const allow = await relaxStepUpAround(db, () =>
    inject("POST", "/v1/egress-allow-hosts", { host: allowed.trackHost(RESEND_HOST), allowPrivateRanges: true, allowPlaintextHttp: true, note: `adr0090 notices ${RUN}` }),
  );
  expect(allow.statusCode, allow.body).toBe(201);
  const mk = async (tag: string) => {
    const email = `cdn-${tag}-${RUN}@example.com`;
    const res = await inject("POST", "/v1/users", { email, displayName: `cdn ${tag}` });
    expect(res.statusCode, res.body).toBe(201);
    emails[res.json().id] = email;
    return res.json().id as string;
  };
  openerId = await mk("opener");
  reviewerA = await mk("reviewer-a");
  reviewerB = await mk("reviewer-b");
  const c = await inject("POST", "/v1/connectors", { name: `cdn-resend-connector-${RUN}`, kind: "chat", providerKind: "resend", baseUrl: base });
  expect(c.statusCode, c.body).toBe(201);
  connectorId = c.json().id;
  const cred = await inject("POST", `/v1/connectors/${connectorId}/credential`, { token: JSON.stringify({ apiKey: API_KEY, from: SENDER }) });
  expect(cred.statusCode, cred.body).toBe(201);
  const conn = await inject("POST", "/v1/chatops/connections", { name: CONNECTION, provider: "resend", connectorId, defaultChannel: RESEND_RECIPIENT_MODE });
  expect(conn.statusCode, conn.body).toBe(201);
  connectionId = conn.json().id;
  expect(conn.json().notifyCampaignDeadlines ?? false).toBe(false);
});

afterAll(async () => {
  const entries = await allowed.removeAll(app, AUTH);
  try {
    if (priorPublicUrl === undefined) delete process.env.REGULAIT_PUBLIC_URL;
    else process.env.REGULAIT_PUBLIC_URL = priorPublicUrl;
    await restoreOrg?.();
    if (connectionId) await db.execute(sql`delete from rate_limit_counters where bucket = ${`chatops-resend:${connectionId}`}`);
    if (campaignIds.length) {
      await db.update(grantCertificationCampaigns).set({ status: "cancelled", cancelledAt: new Date(), cancelledReason: "test cleanup" } as never).where(inArray(grantCertificationCampaigns.id, campaignIds));
    }
    await db.delete(chatopsConnections).where(eq(chatopsConnections.name, CONNECTION));
    if (connectorId) {
      await db.delete(connectorCredentials).where(eq(connectorCredentials.connectorId, connectorId));
      await db.delete(connectors).where(eq(connectors.id, connectorId));
    }
    app.server.closeAllConnections();
    await app.close();
    await new Promise<void>((r) => server.close(() => r()));
  } finally {
    entries.assertRemoved();
  }
});

describe("ADR-0090 amendment: campaign deadline notices", () => {
  let soon = "";
  it("off by default: no workspace opted in, nothing sent and nothing marked", async () => {
    soon = await makeCampaign(10, [{ reviewer: reviewerA }, { reviewer: reviewerA }, { reviewer: reviewerB }, { reviewer: reviewerB, decided: true }]);
    await runCampaignDeadlineNotifySweep(db, { actorUserId: null });
    expect(mailsFor(emails[reviewerA]!)).toHaveLength(0);
    expect(await markers(soon)).toHaveLength(0);
  });

  it("opting a workspace in is audited", async () => {
    const res = await inject("PATCH", `/v1/chatops/connections/${connectionId}`, { notifyCampaignDeadlines: true });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, connectionId), eq(auditLog.ruleId, CHATOPS_RULE_IDS.campaignNoticeSettingsChanged)));
    expect(row).toBeDefined();
  });

  it("due within 48 h: each named reviewer gets their own count, once, with nothing operator-typed", async () => {
    const out = await runCampaignDeadlineNotifySweep(db, { actorUserId: null });
    expect(out.notified.find((n) => n.campaignId === soon)).toMatchObject({ kind: "due_soon", reviewers: 2 });
    const a = mailsFor(emails[reviewerA]!).filter((m) => m.html.includes(soon));
    const b = mailsFor(emails[reviewerB]!).filter((m) => m.html.includes(soon));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]!.html).toContain("2 undecided items assigned to you");
    expect(b[0]!.html).toContain("1 undecided item assigned to you");
    expect(a[0]!.subject).toMatch(/due soon/);
    expect(a[0]!.html).toContain(`${PUBLIC_URL}/ui/inbox`);
    for (const m of [...a, ...b]) {
      expect(m.html).not.toContain(SECRET_NAME);
      expect(m.html).not.toContain(HOLDER_LABEL);
    }
    expect(await markers(soon)).toHaveLength(1);
    // re-run: nothing more
    await runCampaignDeadlineNotifySweep(db, { actorUserId: null });
    expect(mailsFor(emails[reviewerA]!).filter((m) => m.html.includes(soon))).toHaveLength(1);
    expect(await markers(soon)).toHaveLength(1);
  });

  it("a campaign due later than 48 h gets nothing; at expiry one expiry notice goes out, once", async () => {
    const later = await makeCampaign(24 * 7, [{ reviewer: reviewerA }]);
    await runCampaignDeadlineNotifySweep(db, { actorUserId: null });
    expect(hits.filter((m) => m.html.includes(later))).toHaveLength(0);
    // a sweep that sees the campaign past due (clock injected, as the scheduler does in tests)
    const now = new Date(Date.now() + 24 * 8 * 3600_000);
    const out = await runCampaignDeadlineNotifySweep(db, { actorUserId: null, now });
    expect(out.notified.find((n) => n.campaignId === later)).toMatchObject({ kind: "expired", reviewers: 1 });
    const mails = mailsFor(emails[reviewerA]!).filter((m) => m.html.includes(later));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.subject).toMatch(/expired/);
    expect(mails[0]!.html).toContain("nothing is kept or revoked automatically");
    await runCampaignDeadlineNotifySweep(db, { actorUserId: null, now });
    expect(mailsFor(emails[reviewerA]!).filter((m) => m.html.includes(later))).toHaveLength(1);
    const ms = await markers(later);
    expect(ms.map((m) => (m.detail as Record<string, unknown>).kind)).toEqual(["expired"]);
  });

  it("each send is audited on the workspace, and the API key never appears in an audit row", async () => {
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.objectId, connectionId), eq(auditLog.ruleId, CHATOPS_RULE_IDS.campaignNoticePosted)));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(rows)).not.toContain(API_KEY);
  });
});
