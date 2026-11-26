import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { and, auditLog, createDb, eq, pmAuditEvents, runMigrations, sql, type Db } from "@regulait/db";
import { buildApp } from "./app.js";
import { removeEgressAllowEntry } from "./testing/egress-allow-cleanup.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";

/**
 * ADR-0356 PR 3 — Atlassian Rovo-agent and MCP audit events as read-only evidence.
 *
 * Claims, against a fake Atlassian Organizations API:
 *  1. A feed is created disabled; polling a disabled feed is refused; enabling it is a step-up.
 *  2. A poll reads the events-stream with the org key (GET only), follows the cursor, stores the Rovo/MCP events once
 *     each as append-only evidence under one audit row per page (third_party, enforcement false), and drops the rest.
 *  3. A second poll stores nothing again (dedup, cursor kept).
 *  4. The key never appears in a response; the stored evidence carries no ip, geo or display name.
 *  5. A failing API is refused and audited, by status only.
 *  6. The evidence rows refuse UPDATE and DELETE.
 *  7. Admin only.
 *
 * Shares one database with the other gateway suites; objects are prefixed pmai-.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "pmai-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const CONN = `pmai-jira-${RUN}`;
const ORG = `org-${RUN}`;
const KEY = `atlassian-org-key-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let server: http.Server;
let allowHostId: string;
let base: string;
let sourceId: string;
let failNext = false;
const requests: Array<{ method: string; url: string; auth: string | undefined }> = [];

const ev = (id: string, action: string) => ({
  id,
  type: "events",
  attributes: {
    time: "2026-11-17T09:00:00.000Z",
    action,
    actor: { id: "557058:alice", name: "Alice Example" },
    context: [{ id: "agent-1", type: "rovo-agent" }],
    location: { ip: "203.0.113.7" },
  },
});

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  server = http.createServer((req, res) => {
    requests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
    res.setHeader("content-type", "application/json");
    if (failNext) return void res.writeHead(500).end(JSON.stringify({ error: KEY }));
    const u = new URL(req.url ?? "/", "http://x");
    if (u.pathname !== `/admin/v1/orgs/${ORG}/events-stream`) return void res.writeHead(404).end("{}");
    const cursor = u.searchParams.get("cursor");
    if (!cursor) return void res.end(JSON.stringify({ data: [ev("e1", "rovo_agent_invoked"), ev("e2", "user_login")], meta: { next: "c2" } }));
    if (cursor === "c2") return void res.end(JSON.stringify({ data: [ev("e3", "mcp_tool_called")], meta: { next: "c3" } }));
    return void res.end(JSON.stringify({ data: [], meta: { next: "c3" } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const allow = await relaxStepUpAround(db, () =>
    app.inject({ method: "POST", headers: AUTH, url: "/v1/egress-allow-hosts", payload: { host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "pm-audit-ingest suite: fake Atlassian" } }),
  );
  expect(allow.statusCode, allow.body).toBe(201);
  allowHostId = allow.json().id as string;
  const c = await app.inject({ method: "POST", headers: AUTH, url: "/v1/pm/connections", payload: { name: CONN, provider: "jira", project: "PMAI", baseUrl: `${base}/jira`, token: "bot@example.com:api-token" } });
  expect(c.statusCode, c.body).toBe(201);
});

afterAll(async () => {
  (await removeEgressAllowEntry(app, AUTH, { id: allowHostId })).assertRemoved();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("ADR-0356 PR 3 Atlassian audit feed", () => {
  it("is created disabled, never echoes the key, and refuses a poll until enabled", async () => {
    const r = await app.inject({ method: "POST", headers: AUTH, url: "/v1/pm/audit-sources", payload: { connectionName: CONN, orgId: ORG, apiKey: KEY, baseUrl: base } });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.body).not.toContain(KEY);
    expect(r.json()).toMatchObject({ enabled: false, actionFilters: ["rovo", "mcp"] });
    sourceId = r.json().id as string;
    const p = await app.inject({ method: "POST", headers: AUTH, url: `/v1/pm/audit-sources/${sourceId}/poll` });
    expect(p.statusCode).toBe(409);
    const list = await app.inject({ method: "GET", headers: AUTH, url: "/v1/pm/audit-sources" });
    expect(list.body).not.toContain(KEY);
  });

  it("stores the Rovo and MCP events once each, as evidence, following the cursor", async () => {
    const en = await relaxStepUpAround(db, () => app.inject({ method: "PATCH", headers: AUTH, url: `/v1/pm/audit-sources/${sourceId}`, payload: { enabled: true } }));
    expect(en.statusCode, en.body).toBe(200);
    const p = await app.inject({ method: "POST", headers: AUTH, url: `/v1/pm/audit-sources/${sourceId}/poll` });
    expect(p.statusCode, p.body).toBe(200);
    expect(p.json()).toMatchObject({ seen: 3, stored: 2 });
    expect(requests.every((r) => r.method === "GET" && r.auth === `Bearer ${KEY}`)).toBe(true);
    const events = await app.inject({ method: "GET", headers: AUTH, url: `/v1/pm/audit-sources/${sourceId}/events` });
    expect(events.json().events.map((e: { eventId: string }) => e.eventId).sort()).toEqual(["e1", "e3"]);
    expect(events.body).not.toMatch(/203\.0\.113\.7|Alice Example/);
    const auditId = events.json().events[0].auditLogId as string;
    const [batch] = await db.select().from(auditLog).where(eq(auditLog.id, auditId));
    expect(batch?.detail).toMatchObject({ attribution: "third_party", enforcement: false });

    const again = await app.inject({ method: "POST", headers: AUTH, url: `/v1/pm/audit-sources/${sourceId}/poll` });
    expect(again.json()).toMatchObject({ stored: 0 });
  });

  it("a failing API is refused and audited by status, without the key", async () => {
    failNext = true;
    const p = await app.inject({ method: "POST", headers: AUTH, url: `/v1/pm/audit-sources/${sourceId}/poll` });
    failNext = false;
    expect(p.statusCode).toBe(502);
    expect(p.json()).toMatchObject({ refused: "http_error" });
    expect(p.body).not.toContain(KEY);
    const [a] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectId, sourceId), eq(auditLog.ruleId, "pm-audit-poll-refused")));
    expect(JSON.stringify(a)).not.toContain(KEY);
  });

  it("the evidence is append-only", async () => {
    const [row] = await db.select().from(pmAuditEvents).where(eq(pmAuditEvents.sourceId, sourceId)).limit(1);
    await expect(db.execute(sql`UPDATE pm_audit_events SET action = 'x' WHERE id = ${row!.id}`)).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }),
    });
    await expect(db.execute(sql`DELETE FROM pm_audit_events WHERE id = ${row!.id}`)).rejects.toBeTruthy();
  });

  it("is admin only", async () => {
    const u = await app.inject({ method: "POST", headers: AUTH, url: "/v1/users", payload: { email: `pmai-member-${RUN}@example.com`, displayName: "member" } });
    const k = await app.inject({ method: "POST", headers: AUTH, url: `/v1/users/${u.json().id}/keys`, payload: { name: "pmai" } });
    const member = { authorization: `Bearer ${k.json().token}` };
    for (const [method, url] of [["GET", "/v1/pm/audit-sources"], ["GET", `/v1/pm/audit-sources/${sourceId}/events`], ["POST", `/v1/pm/audit-sources/${sourceId}/poll`]] as const) {
      expect((await app.inject({ method, url, headers: member })).statusCode, url).toBe(403);
    }
  });
});
