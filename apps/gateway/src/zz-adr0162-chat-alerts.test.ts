/**
 * ADR-0162 — governance-monitor alerts delivered to chat.
 *
 * Pinned against a REAL local "Slack" (the guarded fetch really connects):
 * a workspace opted in at `high` receives newly raised HIGH alerts and not
 * medium ones; a second pass does not re-post; the card carries no buttons;
 * `PATCH` changes the threshold (audited); the manual post works regardless of
 * threshold; and with the destination off the egress allow-list the post is
 * refused, audited, and the monitor pass still succeeds. Shared database:
 * assertions are on records this file creates (M-008); the egress allow entry
 * is removed only if this file added it.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiRisks,
  aiUseCases,
  and,
  auditLog,
  chatopsConnections,
  createDb,
  egressAllowHosts,
  eq,
  governanceAlerts,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `g162-boot-${RUN}`;
const DATA_KEY = "c".repeat(64);
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
let upstream: http.Server;
const posted: Array<Record<string, any>> = [];
let addedAllow = false;
let connectionId = "";
let useCaseName = "";
let useCaseId = "";
const admin = { id: "", auth: { authorization: "" } };

const call = (method: "GET" | "POST" | "PATCH", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const postsAbout = (needle: string) => posted.filter((p) => JSON.stringify(p).includes(needle));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        posted.push(JSON.parse(body || "{}"));
      } catch {
        posted.push({ raw: body });
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ts: `1785.${posted.length}` }));
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const port = (upstream.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  const existing = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  if (existing.length === 0) {
    const allow = await call("POST", "/v1/egress-allow-hosts", AUTH, {
      host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "adr0162 suite: local fake Slack",
    });
    expect([200, 201]).toContain(allow.statusCode);
    addedAllow = true;
  }

  const u = await call("POST", "/v1/users", AUTH, { email: `g162-${RUN}@example.com`, displayName: "Chat admin", isAdmin: true });
  admin.id = u.json().id;
  admin.auth = { authorization: `Bearer ${(await call("POST", `/v1/users/${admin.id}/keys`, AUTH, { name: "k" })).json().token}` };

  const conn = await call("POST", "/v1/connectors", AUTH, { name: `g162-slack-${RUN}`, kind: "chat", providerKind: "slack", baseUrl: base });
  expect(conn.statusCode, conn.body).toBe(201);
  const connectorId = conn.json().id;
  expect([200, 201]).toContain((await call("POST", `/v1/connectors/${connectorId}/credential`, AUTH, { token: "xoxb-g162" })).statusCode);
  const created = await call("POST", "/v1/chatops/connections", AUTH, {
    name: `g162-ws-${RUN}`, provider: "slack", connectorId, signingSecret: "g162-signing-secret",
    defaultChannel: "#governance", notifyAlertMinSeverity: "high",
  });
  expect(created.statusCode, created.body).toBe(201);
  connectionId = created.json().id;

  // an approved use case with its own high risk (→ HIGH alert) and an unowned
  // agent (→ MEDIUM alert)
  const [a] = await db.insert(agents).values({ name: `g162-agent-${RUN}`, provider: "mock", tier: 1, model: "m" }).returning({ id: agents.id });
  useCaseName = `g162-use-case-${RUN}`;
  const [uc] = await db
    .insert(aiUseCases)
    .values({ name: useCaseName, description: "s", businessContext: "s", dataSensitivity: "internal", ownerUserId: admin.id, intendedAgentIds: [a!.id], status: "approved" })
    .returning({ id: aiUseCases.id });
  useCaseId = uc!.id;
  await db.insert(aiRisks).values({ title: `g162 risk ${RUN}`, description: "s", category: "prompt_injection", ownerUserId: admin.id, useCaseId, likelihood: "high", impact: "high" });
}, 120_000);

afterAll(async () => {
  await db.delete(chatopsConnections).where(eq(chatopsConnections.id, connectionId));
  if (addedAllow) await db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
  app.server.closeAllConnections();
  await app.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

describe("ADR-0162 governance alerts in chat", () => {
  it("posts newly raised HIGH alerts to an opted-in workspace, not medium ones, with no buttons", async () => {
    const r = await call("POST", "/v1/governance/monitor/evaluate", admin.auth);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().notified.posted).toBeGreaterThanOrEqual(1);
    const mine = postsAbout(useCaseName);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    expect(mine.every((p) => String(p.text).includes("HIGH"))).toBe(true); // the medium unowned-agent alert is not posted
    expect(mine.some((p) => String(p.text).includes("Governance alert"))).toBe(true);
    for (const p of mine) expect(JSON.stringify(p.blocks ?? [])).not.toContain('"actions"');

    const before = postsAbout(useCaseName).length;
    await call("POST", "/v1/governance/monitor/evaluate", admin.auth); // persisting → refreshed, not re-posted
    expect(postsAbout(useCaseName).length).toBe(before);
  });

  it("changes the threshold by PATCH (audited) and posts one alert on demand", async () => {
    const p = await call("PATCH", `/v1/chatops/connections/${connectionId}`, admin.auth, { notifyAlertMinSeverity: null });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json().notifyAlertMinSeverity).toBeNull();
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "chatops-alert-settings-changed"), eq(auditLog.objectId, connectionId)));
    expect(audits).toHaveLength(1);

    const [medium] = await db
      .select()
      .from(governanceAlerts)
      .where(and(eq(governanceAlerts.ruleId, "use_case_agent_unowned"), eq(governanceAlerts.status, "open")));
    const mine = (await db.select().from(governanceAlerts).where(eq(governanceAlerts.ruleId, "use_case_agent_unowned"))).find((x) =>
      x.subjectKey.startsWith(`use_case:${useCaseId}>`),
    );
    expect(mine ?? medium).toBeDefined();
    const before = posted.length;
    const r = await call("POST", `/v1/governance/alerts/${mine!.id}/post`, admin.auth, { connectionName: `g162-ws-${RUN}` });
    expect(r.statusCode, r.body).toBe(200);
    expect(posted.length).toBe(before + 1);
    expect(String(posted[posted.length - 1]!.text)).toContain("MEDIUM");
  });

  it("an egress refusal is audited, returned, and never fails the monitor", async () => {
    if (!addedAllow) return; // another file owns the allow entry — do not remove it from under it
    await db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
    try {
      const [alert] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey, `use_case:${useCaseId}`));
      const r = await call("POST", `/v1/governance/alerts/${alert!.id}/post`, admin.auth, { connectionName: `g162-ws-${RUN}` });
      expect(r.statusCode).toBe(502);
      const failed = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.ruleId, "chatops-alert-post-failed"), eq(auditLog.objectId, connectionId)));
      expect(failed.length).toBeGreaterThanOrEqual(1);
      await call("PATCH", `/v1/chatops/connections/${connectionId}`, admin.auth, { notifyAlertMinSeverity: "medium" });
      expect((await call("POST", "/v1/governance/monitor/evaluate", admin.auth)).statusCode).toBe(200);
    } finally {
      await call("POST", "/v1/egress-allow-hosts", AUTH, {
        host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "adr0162 suite: local fake Slack",
      });
    }
  });
});
