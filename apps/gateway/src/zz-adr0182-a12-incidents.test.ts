/**
 * ADR-0182 (ADR-0175 batch D4) A12 — THE AI INCIDENT REGISTER, through the
 * real app on a real database.
 *
 * The red proofs the contract names, each a test that fails with its rule
 * reverted:
 *  - a serious incident on a high-tier use case gets the EU clocks
 *    automatically; `death` picks 10 days and `critical_infrastructure` 2;
 *    a PHI breach starts the HIPAA clocks; a limited-tier use case none;
 *  - closing without lessons learned → 422; with a clock still open → 409;
 *  - a clock cannot be deleted (the DB trigger) and the API has no route to;
 *  - `not_required` without a reason → 422, from a non-admin → 403;
 *    Art. 73(5): `sent_initial` then `sent_complete`; a final clock never moves;
 *  - the deploy gate holds with an open high incident and releases on close
 *    (and `off` says it skipped);
 *  - the evidence hold refuses a system-prompt edit on a linked agent (409,
 *    Art. 73(6) cited), refuses the override from a non-admin, and admits an
 *    admin's audited override;
 *  - containment halts the linked agent through `haltAgentInTx`;
 *  - the export refuses without a signing key (audited) and, with one, the
 *    signed bundle contains the timeline;
 *  - the list is scoped (owner, use-case owner, admin); a narrative read by
 *    someone else is audited; opening from a monitor alert pre-links it;
 *  - the monitor loader and the clock sweep report due clocks and overdue
 *    actions.
 *
 * Global state (M-068): the org settings this file relaxes are restored to
 * strict in `finally` blocks, the signing-key env is restored, and every row
 * it creates is removed before it ends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  aiIncidentActions,
  aiIncidentEvents,
  aiIncidentNotifications,
  aiIncidents,
  aiUseCases,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  governanceAlerts,
  inArray,
  runMigrations,
  sql,
  type Db,
} from "@regulait/db";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { buildApp } from "./app.js";
import { routeAuthClass } from "./route-classes.js";
import { incidentEvidenceHoldRefused, incidentMonitorInput, runIncidentClockSweep, EVIDENCE_HOLD_OVERRIDE_HEADER } from "./incidents.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a12-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "owner" | "member" | "other", { id: string; auth: { authorization: string } }>;
const created = { useCases: [] as string[], incidents: [] as string[], agents: [] as string[], alerts: [] as string[] };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

async function mkUseCase(label: string, tier: "high" | "limited" | null, owner = users.owner.id): Promise<string> {
  const [row] = await db
    .insert(aiUseCases)
    .values({
      name: `a12 ${label} ${RUN}`,
      description: "synthetic ADR-0182 A12 fixture",
      ownerUserId: owner,
      businessContext: "synthetic",
      dataSensitivity: "internal",
      ...(tier ? { euAiActTier: tier, euAiActRulesetVersion: 1, euAiActReasons: [] } : {}),
    })
    .returning({ id: aiUseCases.id });
  created.useCases.push(row!.id);
  return row!.id;
}

async function mkAgent(label: string): Promise<string> {
  const [a] = await db.insert(agents).values({ name: `a12-${label}-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
  created.agents.push(a!.id);
  return a!.id;
}

/** open an incident through the API as `who`; returns the detail body */
async function open(who: keyof typeof users, body: Record<string, unknown>) {
  const res = await inject("POST", "/v1/incidents", users[who].auth, {
    title: `a12 incident ${RUN}`,
    severity: "high",
    detectionSource: "manual",
    ...body,
  });
  expect(res.statusCode, res.body).toBe(201);
  const out = res.json();
  created.incidents.push(out.incident.id);
  return out as {
    incident: { id: string; ref: string; status: string; serious: boolean; awareAt: string; ownerUserId: string | null };
    notifications: Array<{ id: string; clockId: string; dueAt: string; status: string; clockStart: string; caveat: string | null; quote: string }>;
    links: Array<{ objectType: string; objectId: string }>;
  };
}

const clockIds = (d: { notifications: Array<{ clockId: string }> }) => d.notifications.map((n) => n.clockId).sort();
const lastAudit = async (ruleId: string, objectId?: string) =>
  (
    await db
      .select()
      .from(auditLog)
      .where(objectId ? and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)) : eq(auditLog.ruleId, ruleId))
      .orderBy(desc(auditLog.seq))
      .limit(1)
  )[0];

let restoreMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["owner", false], ["member", false], ["other", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `a12-${k}-${RUN}@example.com`, displayName: `a12 ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a12" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  await db.execute(sql`UPDATE org_settings SET incident_gate_mode = 'enforce', incident_evidence_hold = true,
    incident_clock_regimes = '["eu-ai-act", "hipaa"]'::jsonb`);
  await restoreMfa?.();
  // incidents cascade to their events, links, actions and clocks (the
  // referential path the append-only and no-delete triggers admit)
  if (created.incidents.length) await db.delete(aiIncidents).where(inArray(aiIncidents.id, created.incidents));
  if (created.alerts.length) await db.delete(governanceAlerts).where(inArray(governanceAlerts.id, created.alerts));
  if (created.useCases.length) await db.delete(aiUseCases).where(inArray(aiUseCases.id, created.useCases));
  if (created.agents.length) await db.delete(agents).where(inArray(agents.id, created.agents));
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------

describe("ADR-0182 A12: clocks start automatically on serious / phi_breach", () => {
  it("a serious incident on a high-tier use case gets the EU clocks from the awareness time; each says 'confirm with counsel'", async () => {
    const uc = await mkUseCase("high", "high");
    const aware = "2026-10-01T08:00:00.000Z";
    const d = await open("owner", { useCaseId: uc, serious: true, seriousCriteria: ["health"], awareAt: aware });
    expect(clockIds(d)).toEqual(["art26-5-inform-provider", "art73-2-general"]);
    const general = d.notifications.find((n) => n.clockId === "art73-2-general")!;
    expect(general.clockStart).toBe(aware);
    expect(general.dueAt).toBe("2026-10-16T08:00:00.000Z");
    expect(general.caveat).toMatch(/confirm with counsel/);
    expect(general.quote).toMatch(/not later than 15 days/);
    expect(d.notifications.find((n) => n.clockId === "art26-5-inform-provider")!.dueAt).toBe(aware);
    const a = await lastAudit("ai-incident-clocks-started", d.incident.id);
    expect(a?.detail).toMatchObject({ clockIds: ["art26-5-inform-provider", "art73-2-general"] });
  });

  it("death picks the 10-day clock and critical infrastructure the 2-day clock; Art. 3(49) criteria make it serious", async () => {
    const uc = await mkUseCase("death", "high");
    const aware = "2026-10-01T00:00:00.000Z";
    const death = await open("owner", { useCaseId: uc, seriousCriteria: ["death"], awareAt: aware });
    expect(death.incident.serious).toBe(true);
    expect(clockIds(death)).toEqual(["art26-5-inform-provider", "art73-4-death"]);
    expect(death.notifications.find((n) => n.clockId === "art73-4-death")!.dueAt).toBe("2026-10-11T00:00:00.000Z");
    const ci = await open("owner", { useCaseId: uc, serious: true, seriousCriteria: ["critical_infrastructure"], awareAt: aware });
    expect(clockIds(ci)).toEqual(["art26-5-inform-provider", "art73-3-critical-or-widespread"]);
    expect(ci.notifications.find((n) => n.clockId === "art73-3-critical-or-widespread")!.dueAt).toBe("2026-10-03T00:00:00.000Z");
  });

  it("an unscreened use case starts them; a limited-tier one does not; a PHI breach starts the HIPAA clocks", async () => {
    const unscreened = await open("owner", { useCaseId: await mkUseCase("unscreened", null), serious: true, seriousCriteria: ["health"] });
    expect(clockIds(unscreened)).toContain("art73-2-general");
    const limited = await open("owner", { useCaseId: await mkUseCase("limited", "limited"), serious: true, seriousCriteria: ["health"] });
    expect(clockIds(limited)).toEqual([]);
    const phi = await open("owner", { severity: "medium", seriousCriteria: ["phi_breach"], phiIndividuals: 1200 });
    expect(clockIds(phi)).toEqual(["164.404-individuals", "164.406-media", "164.408-secretary", "164.410-ba-to-ce"].sort());
    expect(phi.incident.serious).toBe(false);
  });

  it("marking an existing incident serious later starts its clocks then; a removed regime starts none", async () => {
    const uc = await mkUseCase("later", "high");
    const d = await open("owner", { useCaseId: uc, severity: "medium" });
    expect(d.notifications).toEqual([]);
    const p = await inject("PATCH", `/v1/incidents/${d.incident.id}`, users.owner.auth, { serious: true, seriousCriteria: ["fundamental_rights"] });
    expect(p.statusCode, p.body).toBe(200);
    expect(clockIds(p.json())).toEqual(["art26-5-inform-provider", "art73-2-general"]);
    try {
      expect((await inject("PUT", "/v1/org/settings", users.admin.auth, { incidentClockRegimes: ["hipaa"] })).statusCode).toBe(200);
      const none = await open("owner", { useCaseId: uc, serious: true, seriousCriteria: ["health"] });
      expect(none.notifications).toEqual([]);
    } finally {
      expect((await inject("PUT", "/v1/org/settings", users.admin.auth, { incidentClockRegimes: ["eu-ai-act", "hipaa"] })).statusCode).toBe(200);
    }
  });
});

describe("ADR-0182 A12: clocks are set aside only by an admin with a reason, and never deleted", () => {
  it("not-required without a reason → 422; from a non-admin → 403; with one → audited and final", async () => {
    const d = await open("owner", { useCaseId: await mkUseCase("aside", "high"), serious: true, seriousCriteria: ["health"] });
    const n = d.notifications.find((x) => x.clockId === "art26-5-inform-provider")!;
    const url = `/v1/incidents/${d.incident.id}/notifications/${n.id}/not-required`;
    expect((await inject("POST", url, users.owner.auth, { reason: "we are the provider of this system" })).statusCode).toBe(403);
    const noReason = await inject("POST", url, users.admin.auth, {});
    expect(noReason.statusCode, noReason.body).toBe(422);
    expect(noReason.json().error).toBe("reason_required");
    const short = await inject("POST", url, users.admin.auth, { reason: "short" });
    expect(short.statusCode).toBe(422);
    const ok = await inject("POST", url, users.admin.auth, { reason: "the organisation is the provider of this system" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().notification).toMatchObject({ status: "not_required", reason: "the organisation is the provider of this system" });
    const audit = await lastAudit("ai-incident-notification-not-required", d.incident.id);
    expect(audit?.userId).toBe(users.admin.id);
    expect(audit?.detail).toMatchObject({ transitions: { status: { from: "pending", to: "not_required" } }, relaxed: true });
    // final: a second move is refused
    const again = await inject("POST", `/v1/incidents/${d.incident.id}/notifications/${n.id}/toll`, users.admin.auth, { reason: "law enforcement asked us to wait" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("notification_final");
  });

  it("a clock row cannot be deleted (the database refuses it) and the API exposes no delete", async () => {
    const d = await open("owner", { useCaseId: await mkUseCase("nodelete", "high"), serious: true, seriousCriteria: ["health"] });
    const n = d.notifications[0]!;
    const e = await db
      .delete(aiIncidentNotifications)
      .where(eq(aiIncidentNotifications.id, n.id))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(e, "the DELETE must be refused").not.toBeNull();
    const del = await inject("DELETE", `/v1/incidents/${d.incident.id}/notifications/${n.id}`, users.admin.auth);
    expect(del.statusCode).toBe(404);
    expect(await db.select().from(aiIncidentNotifications).where(eq(aiIncidentNotifications.id, n.id))).toHaveLength(1);
  });

  it("Art. 73(5): an initial report, then the complete one; HIPAA clocks have no initial stage", async () => {
    const d = await open("owner", { useCaseId: await mkUseCase("initial", "high"), serious: true, seriousCriteria: ["health", "phi_breach"], phiIndividuals: 10 });
    const art = d.notifications.find((n) => n.clockId === "art73-2-general")!;
    const sent = (id: string, body: object) => inject("POST", `/v1/incidents/${d.incident.id}/notifications/${id}/sent`, users.owner.auth, body);
    const init = await sent(art.id, { stage: "initial", recipient: "market surveillance authority", reference: "MSA-1" });
    expect(init.statusCode, init.body).toBe(200);
    expect(init.json().notification.status).toBe("sent_initial");
    const complete = await sent(art.id, { stage: "complete", recipient: "market surveillance authority" });
    expect(complete.json().notification.status).toBe("sent_complete");
    const hipaa = d.notifications.find((n) => n.clockId === "164.404-individuals")!;
    const refused = await sent(hipaa.id, { stage: "initial", recipient: "each affected individual" });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe("initial_report_not_allowed");
  });
});

describe("ADR-0182 A12: closing", () => {
  it("without lessons learned → 422; with a clock open → 409; with every clock final → closed, and a closed incident is not changed", async () => {
    const d = await open("owner", { useCaseId: await mkUseCase("close", "high"), serious: true, seriousCriteria: ["health"] });
    const url = `/v1/incidents/${d.incident.id}/close`;
    const noLessons = await inject("POST", url, users.owner.auth, { rootCause: "a prompt regression" });
    expect(noLessons.statusCode, noLessons.body).toBe(422);
    expect(noLessons.json().error).toBe("close_requires_root_cause_and_lessons");
    const body = { rootCause: "a prompt regression", lessonsLearned: "pin the prompt version in the release" };
    const open409 = await inject("POST", url, users.owner.auth, body);
    expect(open409.statusCode).toBe(409);
    expect(open409.json().openClocks.sort()).toEqual(["art26-5-inform-provider", "art73-2-general"]);
    for (const n of d.notifications) {
      const r = await inject("POST", `/v1/incidents/${d.incident.id}/notifications/${n.id}/sent`, users.owner.auth, { stage: "complete", recipient: "recorded recipient" });
      expect(r.statusCode, r.body).toBe(200);
    }
    const closed = await inject("POST", url, users.owner.auth, body);
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().incident).toMatchObject({ status: "closed", rootCause: body.rootCause, lessonsLearned: body.lessonsLearned });
    expect(closed.json().incident.closedAt).not.toBeNull();
    const after = await inject("PATCH", `/v1/incidents/${d.incident.id}`, users.owner.auth, { title: "rewritten" });
    expect(after.statusCode).toBe(409);
    expect(after.json().error).toBe("incident_closed");
  });
});

describe("ADR-0182 A12: closing needs every corrective action done or cancelled (main-session decision)", () => {
  it("an open action → 409 naming it; cancelling without a reason → 422; with one → audited, on the timeline, and the close succeeds", async () => {
    const d = await open("owner", { severity: "medium" });
    const act = await inject("POST", `/v1/incidents/${d.incident.id}/actions`, users.owner.auth, { title: "rotate the leaked prompt" });
    const actionId = act.json().action.id as string;
    const body = { rootCause: "synthetic root cause", lessonsLearned: "synthetic lesson" };
    const refused = await inject("POST", `/v1/incidents/${d.incident.id}/close`, users.owner.auth, body);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "incident_actions_open", openActions: [actionId] });
    const url = `/v1/incidents/${d.incident.id}/actions/${actionId}`;
    const noReason = await inject("PATCH", url, users.owner.auth, { status: "cancelled" });
    expect(noReason.statusCode, noReason.body).toBe(422);
    expect(noReason.json().error).toBe("reason_required");
    expect((await inject("PATCH", url, users.owner.auth, { status: "cancelled", reason: "x", bogus: 1 })).statusCode).toBe(400);
    const ok = await inject("PATCH", url, users.owner.auth, { status: "cancelled", reason: "superseded by the model rollback" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await lastAudit("ai-incident-action-updated", d.incident.id))?.reason).toContain("superseded by the model rollback");
    const notes = await db.select().from(aiIncidentEvents).where(and(eq(aiIncidentEvents.incidentId, d.incident.id), eq(aiIncidentEvents.kind, "action")));
    expect(notes.some((n) => n.note === "superseded by the model rollback")).toBe(true);
    expect((await inject("POST", `/v1/incidents/${d.incident.id}/close`, users.owner.auth, body)).statusCode).toBe(200);
  });
});

describe("ADR-0182 A12: visibility, audited reads, pre-linking", () => {
  it("the list is scoped: owner and use-case owner see it, another user does not; admin sees all", async () => {
    const uc = await mkUseCase("scope", null, users.owner.id);
    const d = await open("member", { useCaseId: uc, ownerUserId: users.member.id });
    const ids = async (who: keyof typeof users) =>
      ((await inject("GET", "/v1/incidents?limit=500", users[who].auth)).json().incidents as Array<{ id: string }>).map((i) => i.id);
    expect(await ids("member")).toContain(d.incident.id); // the owner
    expect(await ids("owner")).toContain(d.incident.id); // the use case's owner
    expect(await ids("admin")).toContain(d.incident.id);
    expect(await ids("other")).not.toContain(d.incident.id);
    expect((await inject("GET", `/v1/incidents/${d.incident.id}`, users.other.auth)).statusCode).toBe(404);
    // the use case's owner may read but not change it
    expect((await inject("PATCH", `/v1/incidents/${d.incident.id}`, users.owner.auth, { title: "x" })).statusCode).toBe(403);
  });

  it("a read of the narrative by someone other than its reporter is audited", async () => {
    const d = await open("owner", {});
    const before = await lastAudit("ai-incident-read", d.incident.id);
    expect(before).toBeUndefined();
    expect((await inject("GET", `/v1/incidents/${d.incident.id}`, users.owner.auth)).statusCode).toBe(200);
    expect(await lastAudit("ai-incident-read", d.incident.id)).toBeUndefined();
    expect((await inject("GET", `/v1/incidents/${d.incident.id}`, users.admin.auth)).statusCode).toBe(200);
    expect((await lastAudit("ai-incident-read", d.incident.id))?.userId).toBe(users.admin.id);
  });

  it("opening from a monitor alert pre-links the alert, its agent and its use case", async () => {
    const agentId = await mkAgent("alert");
    const uc = await mkUseCase("alert", "high");
    const [al] = await db
      .insert(governanceAlerts)
      .values({ ruleId: "kri_threshold_breached", subjectKey: `use_case:${uc}>agent:${agentId}`, severity: "high", title: `a12 ${RUN}` })
      .returning({ id: governanceAlerts.id });
    created.alerts.push(al!.id);
    const d = await open("admin", { detectionSource: "monitor_alert", sourceRef: al!.id });
    expect(d.links.map((l) => `${l.objectType}:${l.objectId}`).sort()).toEqual([`agent:${agentId}`, `governance_alert:${al!.id}`].sort());
    expect((d as unknown as { useCase: { id: string } }).useCase.id).toBe(uc);
    const bad = await inject("POST", "/v1/incidents", users.admin.auth, {
      title: "x", severity: "low", detectionSource: "monitor_alert", sourceRef: "00000000-0000-4000-8000-00000000abcd",
    });
    expect(bad.statusCode).toBe(422);
  });

  it("releasing the gate is an admin's: the owner cannot lower a high incident below high or un-mark serious", async () => {
    const d = await open("owner", { useCaseId: await mkUseCase("relax", null), serious: true, seriousCriteria: [] });
    const lower = await inject("PATCH", `/v1/incidents/${d.incident.id}`, users.owner.auth, { severity: "low" });
    expect(lower.statusCode).toBe(403);
    expect(lower.json().error).toBe("incident_relaxation_admin_only");
    const unserious = await inject("PATCH", `/v1/incidents/${d.incident.id}`, users.owner.auth, { serious: false });
    expect(unserious.statusCode).toBe(403);
    const admin = await inject("PATCH", `/v1/incidents/${d.incident.id}`, users.admin.auth, { severity: "low" });
    expect(admin.statusCode, admin.body).toBe(200);
    expect((await lastAudit("ai-incident-updated", d.incident.id))?.detail).toMatchObject({
      relaxed: true,
      transitions: { severity: { from: "high", to: "low" } },
    });
  });
});

describe("ADR-0182 A12: the deploy gate", () => {
  it("an open high incident holds the gate and closing it releases the hold; off skips and says so", async () => {
    const uc = await mkUseCase("gate", "limited");
    const gate = async () => (await inject("POST", "/v1/gates/deploy", users.admin.auth, { useCaseId: uc })).json();
    const codes = (g: { reasons: Array<{ code: string; severity: string }> }) => g.reasons.filter((r) => r.code.endsWith("_incident"));
    expect(codes(await gate())).toEqual([]);
    const d = await open("owner", { useCaseId: uc, severity: "high" });
    const held = await gate();
    expect(codes(held)).toEqual([expect.objectContaining({ code: "open_high_incident", severity: "block" })]);
    expect(held.decision).toBe("deny");
    expect(held.incidentGate).toMatchObject({ mode: "enforce", status: "enforced" });
    try {
      expect((await inject("PUT", "/v1/org/settings", users.admin.auth, { incidentGateMode: "off" })).statusCode).toBe(200);
      const off = await gate();
      expect(codes(off)).toEqual([]);
      expect(off.incidentGate).toEqual({ mode: "off", status: "skipped", label: "skipped (mode off)" });
      expect((await inject("PUT", "/v1/org/settings", users.admin.auth, { incidentGateMode: "warn" })).statusCode).toBe(200);
      expect(codes(await gate())).toEqual([expect.objectContaining({ code: "open_high_incident", severity: "warn" })]);
    } finally {
      expect((await inject("PUT", "/v1/org/settings", users.admin.auth, { incidentGateMode: "enforce" })).statusCode).toBe(200);
    }
    const closed = await inject("POST", `/v1/incidents/${d.incident.id}/close`, users.owner.auth, {
      rootCause: "synthetic root cause",
      lessonsLearned: "synthetic lesson",
    });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(codes(await gate())).toEqual([]);
  });
});

describe("ADR-0182 A12: containment and the Art. 73(6) evidence hold", () => {
  it("contain (admin) halts the agent through haltAgentInTx and marks the incident contained", async () => {
    const agentId = await mkAgent("contain");
    const d = await open("owner", {});
    const asOwner = await inject("POST", `/v1/incidents/${d.incident.id}/contain`, users.owner.auth, { agentId, reason: "stop it answering now" });
    expect(asOwner.statusCode).toBe(403);
    const r = await inject("POST", `/v1/incidents/${d.incident.id}/contain`, users.admin.auth, { agentId, reason: "stop it answering now" });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().halt).toMatchObject({ agentId, halted: true, changed: true });
    const [a] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(a!.haltedAt).not.toBeNull();
    const detail = (await inject("GET", `/v1/incidents/${d.incident.id}`, users.admin.auth)).json();
    expect(detail.incident.status).toBe("contained");
    expect(detail.events.map((e: { kind: string }) => e.kind)).toContain("containment");
    expect(detail.links).toContainEqual(expect.objectContaining({ objectType: "agent", objectId: agentId, halted: true }));
  });

  it("refuses a prompt edit on a linked agent (409, Art. 73(6)), refuses a non-admin's override, admits an admin's audited override", async () => {
    const agentId = await mkAgent("hold");
    const d = await open("admin", { useCaseId: await mkUseCase("hold", "high"), serious: true, seriousCriteria: ["health"], links: [{ objectType: "agent", objectId: agentId }] });
    const edit = (headers: Record<string, string>) =>
      inject("POST", `/v1/agents/${agentId}/system-prompt`, headers, { systemPrompt: `edited during the incident ${RUN}` });
    const refused = await edit(users.admin.auth);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "incident_evidence_hold", citation: "Regulation (EU) 2024/1689, Article 73(6)" });
    expect(refused.json().incidents).toEqual([{ id: d.incident.id, ref: d.incident.ref }]);
    expect((await lastAudit("ai-incident-evidence-hold-refused", d.incident.id))?.effect).toBe("deny");
    const [unchanged] = await db.select({ p: agents.systemPrompt }).from(agents).where(eq(agents.id, agentId));
    expect(unchanged!.p).toBeNull();
    // a short reason is refused
    expect((await edit({ ...users.admin.auth, [EVIDENCE_HOLD_OVERRIDE_HEADER]: "short" })).statusCode).toBe(422);
    // the override from someone who is not an admin (reachable on the user-class builder routes): 403, audited
    const sent: { status?: number; body?: { error: string } } = {};
    const fakeReply = { status(c: number) { sent.status = c; return this; }, send(b: { error: string }) { sent.body = b; return this; } };
    const fakeReq = { headers: { [EVIDENCE_HOLD_OVERRIDE_HEADER]: "I am not an admin but it is urgent" }, authCtx: { userId: users.member.id, isAdmin: false, via: "api_key" } };
    expect(await incidentEvidenceHoldRefused(db, fakeReq as never, fakeReply as never, agentId, "system prompt")).toBe(true);
    expect(sent).toMatchObject({ status: 403, body: { error: "evidence_hold_override_admin_only" } });
    expect((await lastAudit("ai-incident-evidence-hold-refused", d.incident.id))?.detail).toMatchObject({ overrideByNonAdmin: true });
    const ok = await edit({ ...users.admin.auth, [EVIDENCE_HOLD_OVERRIDE_HEADER]: encodeURIComponent("customer harm continues — fix now") });
    expect(ok.statusCode, ok.body).toBe(200);
    const over = await lastAudit("ai-incident-evidence-hold-overridden", d.incident.id);
    expect(over?.userId).toBe(users.admin.id);
    expect(over?.reason).toContain("customer harm continues — fix now");
    const notes = await db.select().from(aiIncidentEvents).where(and(eq(aiIncidentEvents.incidentId, d.incident.id), eq(aiIncidentEvents.kind, "note")));
    expect(notes.some((n) => n.note?.includes("Evidence hold overridden"))).toBe(true);
    // the hold lifts when the authority report is sent
    const art = d.notifications.find((n) => n.clockId === "art73-2-general")!;
    expect((await inject("POST", `/v1/incidents/${d.incident.id}/notifications/${art.id}/sent`, users.admin.auth, { stage: "initial", recipient: "authority" })).statusCode).toBe(200);
    expect((await edit(users.admin.auth)).statusCode).toBe(200);
  });

  it("also covers an agent in the incident's use-case stack, not linked to the incident (main-session decision)", async () => {
    const agentId = await mkAgent("stack");
    const uc = await mkUseCase("stack", "high");
    await db.update(aiUseCases).set({ intendedAgentIds: [agentId] }).where(eq(aiUseCases.id, uc));
    const d = await open("admin", { useCaseId: uc, serious: true, seriousCriteria: ["health"] });
    expect(d.links.filter((l) => l.objectType === "agent")).toEqual([]);
    const edit = (headers: Record<string, string>) => inject("POST", `/v1/agents/${agentId}/system-prompt`, headers, { systemPrompt: `stack edit ${RUN}` });
    const refused = await edit(users.admin.auth);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: "incident_evidence_hold", incidents: [{ id: d.incident.id, ref: d.incident.ref }] });
    const ok = await edit({ ...users.admin.auth, [EVIDENCE_HOLD_OVERRIDE_HEADER]: "stack agent must change for safety now" });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await lastAudit("ai-incident-evidence-hold-overridden", d.incident.id))?.userId).toBe(users.admin.id);
  });

  it("the hold is off when the admin relaxes `incident_evidence_hold`", async () => {
    const agentId = await mkAgent("holdoff");
    await open("admin", { useCaseId: await mkUseCase("holdoff", "high"), serious: true, seriousCriteria: ["health"], links: [{ objectType: "agent", objectId: agentId }] });
    const edit = () => inject("POST", `/v1/agents/${agentId}/system-prompt`, users.admin.auth, { systemPrompt: `edited ${RUN}` });
    expect((await edit()).statusCode).toBe(409);
    try {
      expect((await inject("PUT", "/v1/org/settings", users.admin.auth, { incidentEvidenceHold: false })).statusCode).toBe(200);
      expect((await edit()).statusCode).toBe(200);
    } finally {
      expect((await inject("PUT", "/v1/org/settings", users.admin.auth, { incidentEvidenceHold: true })).statusCode).toBe(200);
    }
  });
});

describe("ADR-0182 A12: the export", () => {
  it("refuses a signed bundle without a key (audited); with one, the signed bundle carries the timeline; CSV too", async () => {
    const d = await open("owner", { useCaseId: await mkUseCase("export", "high"), serious: true, seriousCriteria: ["health"] });
    await inject("POST", `/v1/incidents/${d.incident.id}/events`, users.owner.auth, { note: `timeline note ${RUN}` });
    const prevKey = process.env.REGULAIT_EXPORT_SIGNING_KEY;
    const prevId = process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;
    const dir = mkdtempSync(path.join(os.tmpdir(), "a12-export-"));
    try {
      delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
      delete process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;
      expect((await inject("GET", `/v1/incidents/${d.incident.id}/export`, users.owner.auth)).statusCode).toBe(403);
      const refused = await inject("GET", `/v1/incidents/${d.incident.id}/export`, users.admin.auth);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe("export-signing-key-absent");
      expect((await lastAudit("ai-incident-export-refused", d.incident.id))?.effect).toBe("deny");

      const { privateKey } = generateKeyPairSync("ed25519");
      const keyPath = path.join(dir, "k.pem");
      writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
      process.env.REGULAIT_EXPORT_SIGNING_KEY = keyPath;
      process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = "a12-test";
      const res = await inject("GET", `/v1/incidents/${d.incident.id}/export`, users.admin.auth);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["content-type"]).toBe("application/gzip");
      const tgz = path.join(dir, "b.tar.gz");
      writeFileSync(tgz, res.rawPayload);
      execFileSync("tar", ["-xzf", tgz, "-C", dir]);
      const root = path.join(dir, readdirSync(dir).find((n) => n.startsWith("regulait-export-ai-incident-"))!);
      const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
      expect(manifest.subject).toMatchObject({ kind: "ai-incident", id: d.incident.id });
      const json = JSON.parse(readFileSync(path.join(root, "content", `incident-${d.incident.ref}.json`), "utf8"));
      expect(json.events.some((e: { note: string | null }) => e.note === `timeline note ${RUN}`)).toBe(true);
      expect(json.notifications.map((n: { clockId: string }) => n.clockId).sort()).toEqual(["art26-5-inform-provider", "art73-2-general"]);
      const csv = readFileSync(path.join(root, "content", `incident-${d.incident.ref}-timeline.csv`), "utf8");
      expect(csv).toContain(`timeline note ${RUN}`);
      expect((await lastAudit("ai-incident-exported", d.incident.id))?.userId).toBe(users.admin.id);

      const c = await inject("GET", `/v1/incidents/${d.incident.id}/export?format=csv`, users.admin.auth);
      expect(c.statusCode).toBe(200);
      expect(c.body.split("\n")[0]).toBe("at,kind,actor_user_id,note,detail");
      expect(c.body).toContain(`timeline note ${RUN}`);
    } finally {
      if (prevKey === undefined) delete process.env.REGULAIT_EXPORT_SIGNING_KEY;
      else process.env.REGULAIT_EXPORT_SIGNING_KEY = prevKey;
      if (prevId === undefined) delete process.env.REGULAIT_EXPORT_SIGNING_KEY_ID;
      else process.env.REGULAIT_EXPORT_SIGNING_KEY_ID = prevId;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ADR-0182 A12: the monitor inputs and the clock sweep", () => {
  it("an overdue clock and an overdue action are reported; the sweep flags each clock once", async () => {
    const aware = new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString();
    const d = await open("owner", { useCaseId: await mkUseCase("monitor", "high"), serious: true, seriousCriteria: ["health"], awareAt: aware });
    const act = await inject("POST", `/v1/incidents/${d.incident.id}/actions`, users.owner.auth, {
      title: "retrain the classifier",
      dueAt: new Date(Date.now() - 3600 * 1000).toISOString(),
    });
    expect(act.statusCode, act.body).toBe(201);
    const input = await incidentMonitorInput(db, new Date());
    const due = input.incident_notification_due!.breaches.filter((b) => b.subjectKey.startsWith(`incident:${d.incident.id}>`));
    expect(due.map((b) => b.subjectKey).sort()).toEqual([
      `incident:${d.incident.id}>clock:art26-5-inform-provider`,
      `incident:${d.incident.id}>clock:art73-2-general`,
    ]);
    for (const b of due) {
      expect(b.detail.overdue).toBe(true);
      expect(b.title).toMatch(new RegExp(`^${d.incident.ref}: `)); // no typed text in the title
      expect(b.title).not.toContain(RUN);
    }
    const overdue = input.incident_action_overdue!.breaches.filter((b) => b.subjectKey.startsWith(`incident:${d.incident.id}>`));
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.title).toBe(`${d.incident.ref}: corrective action overdue`);

    const first = await runIncidentClockSweep(db, new Date(), null);
    expect(first.flagged).toBeGreaterThanOrEqual(2);
    const second = await runIncidentClockSweep(db, new Date(), null);
    const flags = await db
      .select()
      .from(aiIncidentEvents)
      .where(and(eq(aiIncidentEvents.incidentId, d.incident.id), sql`${aiIncidentEvents.detail} ->> 'flag' = 'overdue'`));
    expect(flags).toHaveLength(2);
    expect(second.flagged).toBe(0);

    // marking the action done takes it out of the overdue set
    const actionId = act.json().action.id as string;
    expect((await inject("PATCH", `/v1/incidents/${d.incident.id}/actions/${actionId}`, users.owner.auth, { status: "done", evidenceRef: "PR 4412" })).statusCode).toBe(200);
    const [row] = await db.select().from(aiIncidentActions).where(eq(aiIncidentActions.id, actionId));
    expect(row!.doneAt).not.toBeNull();
    const after = await incidentMonitorInput(db, new Date());
    expect(after.incident_action_overdue!.breaches.filter((b) => b.subjectKey.startsWith(`incident:${d.incident.id}>`))).toEqual([]);
  });
});

describe("ADR-0182 A12: every route keeps its deliberate auth class (replaces P0's 501 table for A12)", () => {
  it.each([
    ["GET", "/v1/incidents", "user"],
    ["POST", "/v1/incidents", "user"],
    ["GET", "/v1/incidents/:incidentId", "user"],
    ["PATCH", "/v1/incidents/:incidentId", "user"],
    ["POST", "/v1/incidents/:incidentId/events", "user"],
    ["POST", "/v1/incidents/:incidentId/links", "user"],
    ["POST", "/v1/incidents/:incidentId/actions", "user"],
    ["PATCH", "/v1/incidents/:incidentId/actions/:actionId", "user"],
    ["POST", "/v1/incidents/:incidentId/notifications/:notificationId/sent", "user"],
    ["POST", "/v1/incidents/:incidentId/notifications/:notificationId/not-required", "admin"],
    ["POST", "/v1/incidents/:incidentId/notifications/:notificationId/toll", "admin"],
    ["POST", "/v1/incidents/:incidentId/close", "user"],
    ["POST", "/v1/incidents/:incidentId/contain", "admin"],
    ["GET", "/v1/incidents/:incidentId/export", "admin"],
  ] as const)("%s %s is %s; without a credential 401", async (method, pattern, cls) => {
    expect(routeAuthClass(method, pattern)).toBe(cls);
    const url = pattern.replace(/:[a-zA-Z]+/g, "00000000-0000-4000-8000-000000000009");
    const anon = await inject(method, url, {}, method === "GET" ? undefined : {});
    expect(anon.statusCode).toBe(401);
    if (cls === "admin") {
      const member = await inject(method, url, users.member.auth, method === "GET" ? undefined : {});
      expect(member.statusCode).toBe(403);
    }
  });
});
