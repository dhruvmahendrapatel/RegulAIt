/**
 * ADR-0182 (ADR-0175 batch D4) S5 — PF-14: governance alert OWNER, SLA and
 * TICKET, on a real database through the real monitor, sweep and routes.
 *
 *  - OWNER DERIVATION per subject type, at raise: use case → its owner; a
 *    use-case/agent pair → the use case's owner; agent → its steward (the
 *    successor when the steward is deactivated); risk → its owner; vendor →
 *    its owner; agent-scoped KRI → the agent's steward; anything else → none.
 *    The due time is the creation + `alert_sla_hours` for the severity.
 *  - ASSIGNMENT: an admin or the current owner may reassign (audited with
 *    transitions); anyone else is refused (403, audited); the new owner must
 *    be active.
 *  - THE SLA SWEEP marks a past-due episode breached ONCE, never resolves or
 *    acknowledges it, escalates breached and unowned episodes to the admins
 *    once, and posts to chat with no personal data.
 *  - THE TICKET: one PM work item per episode (a second request returns the
 *    first); `manual` (strict) files nothing on its own; `auto_high` files one
 *    for a new HIGH episode and none for a medium one.
 *
 * Global state (M-068): the alert settings are restored strict in afterAll, and
 * every row this file creates is removed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiRisks,
  aiUseCases,
  aiVendors,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  governanceAlerts,
  inArray,
  kris,
  orgSettings,
  pmConnections,
  pmLinks,
  runMigrations,
  sql,
  users as usersTable,
  type Db,
} from "@regulait/db";
import { resolvePmProvider } from "@regulait/pm-provider";
import type { MonitorFinding } from "@regulait/shared";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { buildApp } from "./app.js";
import { runGovernanceMonitor } from "./governance-monitor.js";
import {
  ALERT_OWNERSHIP_RULE_IDS,
  alertOwnershipAtRaise,
  alertOwnershipViews,
  registerAlertSlaCourier,
  runAlertSlaSweep,
  type AlertSlaChatMessage,
} from "./alert-ownership.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `s5-own-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const HOUR = 3_600_000;
let db: Db;
let app: ReturnType<typeof buildApp>;
type Who = "admin" | "admin2" | "owner" | "steward" | "successor" | "member" | "gone";
const u = {} as Record<Who, { id: string; auth: { authorization: string } }>;
const made = { useCases: [] as string[], agents: [] as string[], risks: [] as string[], vendors: [] as string[], kris: [] as string[], conns: [] as string[] };
const subjects: string[] = [];

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

let restoreMfa: (() => Promise<void>) | undefined;
const fx = {} as { useCase: string; agent: string; agentGone: string; risk: string; vendor: string; kri: string };

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["admin2", true], ["owner", false], ["steward", false], ["successor", false], ["member", false], ["gone", false]] as const) {
    const r = await inject("POST", "/v1/users", AUTH, { email: `s5o-${k}-${RUN}@example.com`, displayName: `s5o ${k} ${RUN}`, isAdmin });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "s5o" })).json().token as string;
    u[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
  await db.update(usersTable).set({ disabledAt: new Date() }).where(eq(usersTable.id, u.gone.id));

  const [uc] = await db.insert(aiUseCases).values({ name: `s5o uc ${RUN}`, description: "synthetic", ownerUserId: u.owner.id, businessContext: "synthetic", dataSensitivity: "internal" }).returning({ id: aiUseCases.id });
  fx.useCase = uc!.id;
  const [ag] = await db.insert(agents).values({ name: `s5o-agent-${RUN}`, provider: "mock", tier: 1, ownerUserId: u.steward.id }).returning({ id: agents.id });
  fx.agent = ag!.id;
  const [ag2] = await db.insert(agents).values({ name: `s5o-agent-gone-${RUN}`, provider: "mock", tier: 1, ownerUserId: u.gone.id, successorUserId: u.successor.id }).returning({ id: agents.id });
  fx.agentGone = ag2!.id;
  const [rk] = await db.insert(aiRisks).values({ title: `s5o risk ${RUN}`, description: "synthetic", category: "scope_drift", ownerUserId: u.member.id, likelihood: "low", impact: "low" }).returning({ id: aiRisks.id });
  fx.risk = rk!.id;
  const [vd] = await db.insert(aiVendors).values({ name: `s5o vendor ${RUN}`, description: "synthetic", category: "model_provider", ownerUserId: u.admin2.id }).returning({ id: aiVendors.id });
  fx.vendor = vd!.id;
  const [kr] = await db.insert(kris).values({ name: `s5o kri ${RUN}`, metric: "error_rate", scope: "agent", scopeId: fx.agent, threshold: 99, enabled: false }).returning({ id: kris.id });
  fx.kri = kr!.id;
  made.useCases.push(fx.useCase);
  made.agents.push(fx.agent, fx.agentGone);
  made.risks.push(fx.risk);
  made.vendors.push(fx.vendor);
  made.kris.push(fx.kri);
}, 120_000);

afterAll(async () => {
  try {
    // M-068: the two alert settings back to strict, whatever happened above
    await db.execute(sql`UPDATE org_settings SET alert_sla_hours = '{"high": 24, "medium": 72, "low": 168}'::jsonb, alert_ticket_mode = 'manual', alert_ticket_connection_id = NULL`);
    if (subjects.length) await db.delete(governanceAlerts).where(inArray(governanceAlerts.subjectKey, subjects));
    if (made.conns.length) await db.delete(pmConnections).where(inArray(pmConnections.id, made.conns));
    if (made.kris.length) await db.delete(kris).where(inArray(kris.id, made.kris));
    if (made.agents.length) await db.delete(agents).where(inArray(agents.id, made.agents));
    if (made.risks.length) await db.delete(aiRisks).where(inArray(aiRisks.id, made.risks));
    if (made.vendors.length) await db.delete(aiVendors).where(inArray(aiVendors.id, made.vendors));
    if (made.useCases.length) await db.delete(aiUseCases).where(inArray(aiUseCases.id, made.useCases));
    await restoreMfa?.();
  } finally {
    await app?.close();
    await db?.$client.end();
  }
});

const finding = (subjectKey: string, over: Partial<MonitorFinding> = {}): MonitorFinding =>
  ({ ruleId: "incident_notification_due", subjectKey, severity: "high", title: `s5o ${RUN}`, detail: {}, ...over }) as MonitorFinding;

/** raise one episode through the REAL monitor (the incidents loader injected) */
async function raise(subjectKey: string, severity: "high" | "medium" = "high") {
  subjects.push(subjectKey);
  await runGovernanceMonitor(db, {
    actorUserId: u.admin.id,
    optionalInputs: {
      incidents: async () => ({
        incident_notification_due: { breaches: [{ subjectKey, severity, title: `s5o ${RUN} ${severity}`, detail: { runId: RUN } }] },
        incident_action_overdue: { breaches: [] },
      }),
    },
  });
  const [row] = await db
    .select()
    .from(governanceAlerts)
    .where(and(eq(governanceAlerts.ruleId, "incident_notification_due"), eq(governanceAlerts.subjectKey, subjectKey)))
    .orderBy(desc(governanceAlerts.firstDetectedAt))
    .limit(1);
  return row!;
}

/** a bare episode row, for the sweep and the routes */
async function episode(values: Partial<typeof governanceAlerts.$inferInsert> = {}) {
  const subjectKey = `s5o:${RUN}:${subjects.length}`;
  subjects.push(subjectKey);
  const [row] = await db
    .insert(governanceAlerts)
    .values({ ruleId: "kri_threshold_breached", subjectKey, severity: "high", title: `s5o episode ${RUN} for s5o-member-${RUN}@example.com`, ...values })
    .returning();
  return row!;
}

describe("PF-14 owner derivation, per subject type, at raise", () => {
  const now = new Date("2026-10-06T00:00:00Z");
  it.each([
    ["use case → its owner", () => `use_case:${fx.useCase}`, () => u.owner.id],
    ["use case + agent → the use case's owner", () => `use_case:${fx.useCase}>agent:${fx.agent}`, () => u.owner.id],
    ["agent → its steward", () => `agent:${fx.agent}`, () => u.steward.id],
    ["agent with a deactivated steward → its successor", () => `agent:${fx.agentGone}`, () => u.successor.id],
    ["risk → its owner", () => `risk:${fx.risk}`, () => u.member.id],
    ["vendor → its owner", () => `vendor:${fx.vendor}`, () => u.admin2.id],
  ])("%s", async (_label, key, owner) => {
    const at = await alertOwnershipAtRaise(db, finding(key()), now);
    expect(at).toEqual({ ownerUserId: owner(), ownerSource: "derived", dueAt: new Date(now.getTime() + 24 * HOUR) });
  });

  it("agent-scoped KRI → the agent's steward; project and caller subjects → nobody (never invented)", async () => {
    const kri = await alertOwnershipAtRaise(db, finding(`kri:${fx.kri}`, { ruleId: "kri_threshold_breached", detail: { scope: "agent", scopeId: fx.agent } }), now);
    expect(kri.ownerUserId).toBe(u.steward.id);
    const none = await alertOwnershipAtRaise(db, finding(`project:${fx.useCase}`, { severity: "low" }), now);
    expect(none).toEqual({ ownerUserId: null, ownerSource: null, dueAt: new Date(now.getTime() + 168 * HOUR) });
    expect((await alertOwnershipAtRaise(db, finding(`caller:${u.member.id}`), now)).ownerUserId).toBeNull();
  });

  it("a deactivated owner owns nothing", async () => {
    const [rk] = await db.insert(aiRisks).values({ title: `s5o gone risk ${RUN}`, description: "synthetic", category: "scope_drift", ownerUserId: u.gone.id, likelihood: "low", impact: "low" }).returning({ id: aiRisks.id });
    made.risks.push(rk!.id);
    expect((await alertOwnershipAtRaise(db, finding(`risk:${rk!.id}`), now)).ownerUserId).toBeNull();
  });

  it("the monitor writes the derived owner and the due time on the episode it raises, and audits them", async () => {
    const before = Date.now();
    const row = await raise(`use_case:${fx.useCase}`);
    expect(row.ownerUserId).toBe(u.owner.id);
    expect(row.ownerSource).toBe("derived");
    expect(row.dueAt!.getTime() - row.firstDetectedAt.getTime()).toBe(24 * HOUR);
    expect(row.firstDetectedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const [a] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.ownerDerived), eq(auditLog.objectId, row.id)));
    expect(a!.detail).toMatchObject({ ownerUserId: u.owner.id, ownerSource: "derived" });
  });

  it("the due time follows the org's alert_sla_hours (a relaxation an admin made)", async () => {
    const put = await inject("PUT", "/v1/org/settings", u.admin.auth, { alertSlaHours: { high: 48, medium: 72, low: 168 } });
    expect(put.statusCode, put.body).toBe(200);
    try {
      const at = await alertOwnershipAtRaise(db, finding(`use_case:${fx.useCase}`), now);
      expect(at.dueAt).toEqual(new Date(now.getTime() + 48 * HOUR));
    } finally {
      await inject("PUT", "/v1/org/settings", u.admin.auth, { alertSlaHours: { high: 24, medium: 72, low: 168 } });
    }
  });
});

describe("PF-14 assignment: an admin or the current owner, audited", () => {
  it("a non-owner non-admin is refused (403, audited); the owner hands it on; an admin takes it back", async () => {
    const a = await episode({ ownerUserId: u.owner.id, ownerSource: "derived" });
    const refused = await inject("PUT", `/v1/governance/alerts/${a.id}/owner`, u.member.auth, { userId: u.member.id });
    expect(refused.statusCode, refused.body).toBe(403);
    const [r] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.ownerAssignRefused), eq(auditLog.objectId, a.id)));
    expect(r!.effect).toBe("deny");

    const byOwner = await inject("PUT", `/v1/governance/alerts/${a.id}/owner`, u.owner.auth, { userId: u.member.id });
    expect(byOwner.statusCode, byOwner.body).toBe(200);
    expect(byOwner.json().owner).toMatchObject({ id: u.member.id, source: "assigned" });
    const [row] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, a.id));
    expect(row).toMatchObject({ ownerUserId: u.member.id, ownerSource: "assigned" });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.ownerAssigned), eq(auditLog.objectId, a.id)));
    expect((audit!.detail as { transitions: unknown }).transitions).toEqual({
      ownerUserId: { from: u.owner.id, to: u.member.id },
      ownerSource: { from: "derived", to: "assigned" },
    });
    // the previous owner is no longer the owner, so they cannot take it back
    expect((await inject("PUT", `/v1/governance/alerts/${a.id}/owner`, u.owner.auth, { userId: u.owner.id })).statusCode).toBe(403);
    // an admin may
    expect((await inject("PUT", `/v1/governance/alerts/${a.id}/owner`, u.admin.auth, { userId: u.admin2.id })).statusCode).toBe(200);
  });

  it("the new owner must be active; a resolved episode cannot be reassigned", async () => {
    const a = await episode();
    const inactive = await inject("PUT", `/v1/governance/alerts/${a.id}/owner`, u.admin.auth, { userId: u.gone.id });
    expect(inactive.statusCode, inactive.body).toBe(422);
    const resolved = await episode({ status: "resolved", resolvedAt: new Date() });
    expect((await inject("PUT", `/v1/governance/alerts/${resolved.id}/owner`, u.admin.auth, { userId: u.member.id })).statusCode).toBe(409);
    expect((await inject("PUT", `/v1/governance/alerts/${a.id}/owner`, {}, { userId: u.member.id })).statusCode).toBe(401);
  });
});

describe("PF-14 the SLA sweep: breach once, never resolve, escalate, chat without personal data", () => {
  it("marks a past-due episode breached exactly once and leaves its status alone", async () => {
    const posted: AlertSlaChatMessage[] = [];
    registerAlertSlaCourier(db, async (m) => (posted.push(m), { posted: 1, failed: 0 }));
    const now = new Date();
    const due = await episode({ ownerUserId: u.owner.id, ownerSource: "derived", firstDetectedAt: new Date(now.getTime() - 30 * HOUR), dueAt: new Date(now.getTime() - 6 * HOUR) });
    const acked = await episode({ status: "acknowledged", ownerUserId: u.owner.id, acknowledgedAt: now, ackNote: "looking", dueAt: new Date(now.getTime() - HOUR) });
    const fresh = await episode({ ownerUserId: u.owner.id, dueAt: new Date(now.getTime() + 6 * HOUR) });

    const first = await runAlertSlaSweep(db, now, null);
    expect(first.breached).toBeGreaterThanOrEqual(2);
    const read = async (id: string) => (await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, id)))[0]!;
    expect((await read(due.id)).slaBreachedAt).toEqual(now);
    expect((await read(due.id)).status).toBe("open"); // never resolved, never acknowledged
    expect((await read(acked.id)).status).toBe("acknowledged"); // acknowledging does not stop the clock…
    expect((await read(acked.id)).slaBreachedAt).toEqual(now); // …so it is breached too
    expect((await read(fresh.id)).slaBreachedAt).toBeNull();

    const later = new Date(now.getTime() + HOUR);
    await runAlertSlaSweep(db, later, null);
    expect((await read(due.id)).slaBreachedAt).toEqual(now); // ONCE: the second pass does not move it
    const breachRows = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.slaBreached), eq(auditLog.objectId, due.id)));
    expect(breachRows).toHaveLength(1);
    const esc = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.escalated), eq(auditLog.objectId, due.id)));
    expect(esc).toHaveLength(1);
    expect((esc[0]!.detail as { recipients: string[] }).recipients).toEqual(expect.arrayContaining([u.owner.id, u.admin.id, u.admin2.id]));

    // the chat post: rule label, severity, ids — never the title, a name or an email
    const msg = posted.find((m) => m.alertId === due.id)!;
    expect(msg.text).toContain(`a user (id ${u.owner.id})`);
    expect(msg.text).not.toContain("@");
    expect(msg.text).not.toContain("s5o episode");
    expect(msg.text).not.toContain(`s5o owner ${RUN}`);
    expect(posted.filter((m) => m.alertId === due.id)).toHaveLength(1);
  });

  it("escalates an unowned episode to the admins once; gives a due time to an episode that had none", async () => {
    const posted: AlertSlaChatMessage[] = [];
    registerAlertSlaCourier(db, async (m) => (posted.push(m), { posted: 1, failed: 0 }));
    const now = new Date();
    const unowned = await episode({ severity: "medium", firstDetectedAt: new Date(now.getTime() - HOUR) });
    const r1 = await runAlertSlaSweep(db, now, null);
    expect(r1.escalatedUnowned).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, unowned.id));
    expect(row!.dueAt).toEqual(new Date(unowned.firstDetectedAt.getTime() + 72 * HOUR));
    expect(row!.slaBreachedAt).toBeNull();
    expect(row!.status).toBe("open");
    await runAlertSlaSweep(db, new Date(now.getTime() + HOUR), null);
    const esc = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.escalated), eq(auditLog.objectId, unowned.id)));
    expect(esc).toHaveLength(1);
    expect(esc[0]!.detail).toMatchObject({ reason: "unowned" });
    const msg = posted.filter((m) => m.alertId === unowned.id);
    expect(msg).toHaveLength(1);
    expect(msg[0]!.text).toMatch(/has no owner/);
  });

  it("the console view reads owner, SLA state and ticket", async () => {
    const now = new Date();
    const a = await episode({ ownerUserId: u.owner.id, ownerSource: "assigned", firstDetectedAt: new Date(now.getTime() - 20 * HOUR), dueAt: new Date(now.getTime() + 4 * HOUR) });
    const v = (await alertOwnershipViews(db, [a], now)).get(a.id)!;
    expect(v).toMatchObject({ owner: { id: u.owner.id, source: "assigned", name: `s5o owner ${RUN}` }, sla: "due_soon", slaBreachedAt: null, ticket: null });
  });
});

describe("PF-14 the ticket: one PM work item per episode", () => {
  let connectionId: string;
  beforeAll(async () => {
    const r = await inject("POST", "/v1/pm/connections", u.admin.auth, { name: `s5o-pm-${RUN}`, provider: "mock", project: `S5O${RUN}`, token: "synthetic-token" });
    expect(r.statusCode, r.body).toBe(201);
    connectionId = r.json().id as string;
    made.conns.push(connectionId);
  });
  const links = (alertId: string) => db.select().from(pmLinks).where(and(eq(pmLinks.objectType, "governance_alert" as never), eq(pmLinks.objectId, alertId)));

  it("an admin files one; a second request returns the same item; a non-admin is refused", async () => {
    // a caller subject: the title names a person, so the ticket must not carry it
    const a = await episode({ ruleId: "unregistered_ai_traffic", subjectKey: `caller:${u.member.id}` });
    subjects.push(`caller:${u.member.id}`);
    expect((await inject("POST", `/v1/governance/alerts/${a.id}/ticket`, u.member.auth, { connectionId })).statusCode).toBe(403);
    const first = await inject("POST", `/v1/governance/alerts/${a.id}/ticket`, u.admin.auth, { connectionId });
    expect(first.statusCode, first.body).toBe(201);
    const second = await inject("POST", `/v1/governance/alerts/${a.id}/ticket`, u.admin2.auth, { connectionId });
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json()).toMatchObject({ idempotent: true, ticket: { externalId: first.json().ticket.externalId } });
    expect(await links(a.id)).toHaveLength(1);
    // the work item carries no personal data: the title is the rule and severity
    const item = await resolvePmProvider({ provider: "mock", token: "" }).getWorkItem(`S5O${RUN}`, first.json().ticket.externalId);
    expect(JSON.stringify(item)).not.toContain("@example.com");
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.ticketFiled), eq(auditLog.objectId, a.id)));
    expect(audit!.detail).toMatchObject({ trigger: "manual", connectionId });
  });

  it("auto_high is refused without a named, existing PM connection (never an implicit choice)", async () => {
    const bare = await inject("PUT", "/v1/org/settings", u.admin.auth, { alertTicketMode: "auto_high" });
    expect(bare.statusCode, bare.body).toBe(422);
    expect(bare.json().error).toBe("alert_ticket_connection_required");
    const unknown = await inject("PUT", "/v1/org/settings", u.admin.auth, { alertTicketMode: "auto_high", alertTicketConnectionId: "00000000-0000-4000-8000-0000000000aa" });
    expect(unknown.statusCode, unknown.body).toBe(422);
    expect(unknown.json().error).toBe("unknown_pm_connection");
    const [row] = await db.select({ mode: orgSettings.alertTicketMode }).from(orgSettings);
    expect(row!.mode).toBe("manual"); // nothing was saved
  });

  it("manual (strict default) files nothing on its own; auto_high files on the NAMED connection, for high episodes only", async () => {
    const high = await raise(`use_case:${fx.useCase}>agent:${fx.agentGone}`, "high");
    expect(await links(high.id)).toHaveLength(0);

    const put = await inject("PUT", "/v1/org/settings", u.admin.auth, { alertTicketMode: "auto_high", alertTicketConnectionId: connectionId });
    expect(put.statusCode, put.body).toBe(200);
    const [audit0] = await db.select().from(auditLog).where(eq(auditLog.ruleId, "org-settings-updated")).orderBy(desc(auditLog.seq)).limit(1);
    expect((audit0!.detail as { transitions: Record<string, unknown> }).transitions).toMatchObject({
      alertTicketMode: { from: "manual", to: "auto_high" },
      alertTicketConnectionId: { from: null, to: connectionId },
    });
    try {
      const high2 = await raise(`vendor:${fx.vendor}`, "high");
      const filed = await links(high2.id);
      expect(filed).toHaveLength(1);
      expect(filed[0]!.connectionId).toBe(connectionId); // the named one, whatever else exists
      const medium = await raise(`risk:${fx.risk}`, "medium");
      expect(medium.severity).toBe("medium");
      expect(await links(medium.id)).toHaveLength(0);
      const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.ticketFiled), eq(auditLog.objectId, high2.id)));
      expect(audit!.detail).toMatchObject({ trigger: "auto_high" });
    } finally {
      await inject("PUT", "/v1/org/settings", u.admin.auth, { alertTicketMode: "manual", alertTicketConnectionId: null });
    }
  });

  it("when the named connection is deleted, automatic filing STOPS (no fallback) and the sweep records it once", async () => {
    const other = await inject("POST", "/v1/pm/connections", u.admin.auth, { name: `s5o-pm-other-${RUN}`, provider: "mock", project: `S5P${RUN}`, token: "synthetic-token" });
    made.conns.push(other.json().id);
    const named = await inject("POST", "/v1/pm/connections", u.admin.auth, { name: `s5o-pm-named-${RUN}`, provider: "mock", project: `S5N${RUN}`, token: "synthetic-token" });
    const namedId = named.json().id as string;
    expect((await inject("PUT", "/v1/org/settings", u.admin.auth, { alertTicketMode: "auto_high", alertTicketConnectionId: namedId })).statusCode).toBe(200);
    try {
      await db.delete(pmConnections).where(eq(pmConnections.id, namedId));
      const [row] = await db.select({ mode: orgSettings.alertTicketMode, conn: orgSettings.alertTicketConnectionId }).from(orgSettings);
      expect(row).toEqual({ mode: "auto_high", conn: null }); // the mode is left alone; the connection is gone

      const high = await raise(`agent:${fx.agent}`, "high");
      expect(await links(high.id)).toHaveLength(0); // the other connection is NOT used
      const [failed] = await db.select().from(auditLog).where(and(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.ticketFailed), eq(auditLog.objectId, high.id)));
      expect(failed!.detail).toMatchObject({ trigger: "auto_high", error: "ticket_connection_missing" });

      const first = await runAlertSlaSweep(db, new Date(), null);
      expect(first.ticketConnectionMissing).toBe(true);
      await runAlertSlaSweep(db, new Date(), null);
      const recorded = await db.select().from(auditLog).where(eq(auditLog.ruleId, ALERT_OWNERSHIP_RULE_IDS.ticketConnectionMissing)).orderBy(desc(auditLog.seq));
      expect(recorded.filter((r) => Date.now() - r.at.getTime() < 60_000)).toHaveLength(1);
      expect(recorded[0]!.effect).toBe("deny");
    } finally {
      await inject("PUT", "/v1/org/settings", u.admin.auth, { alertTicketMode: "manual", alertTicketConnectionId: null });
    }
  });

});
