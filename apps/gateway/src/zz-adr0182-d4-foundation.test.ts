/**
 * ADR-0182 (ADR-0175 batch D4) — the accountability-records FOUNDATION (P0).
 *
 * Pinned on a real database, through the real app:
 *  - SECURE BY DEFAULT: a freshly migrated org reads every D4 setting at its
 *    strict value (the column defaults, and the row the migration upgraded),
 *    and each relaxation through PUT /v1/org/settings is audited with
 *    `detail.transitions` and named under `detail.relaxed`.
 *  - THE DATABASE RULES of migration 0162: append-only decision records,
 *    incident events and review-policy versions; a notification clock is never
 *    deleted; the CHECKs (closed incident without lessons, link TTL > 30 days,
 *    `propose_halt` on a fleet KRI, a clock set aside without a reason).
 *  - THE EU AI ACT ROLE: `both` by default; the owner may return to it, only
 *    an admin may narrow it (with a reason), every change audited.
 *  - THE STUBS: every D4 route is registered with its deliberate auth class
 *    and answers 501 until its slice lands; the public signed-link routes need
 *    no credential.
 *  - THE MONITOR and THE SCHEDULER: the four rules evaluate (nothing raised by
 *    the stubs), an injected breach raises, a failed loader leaves its rules
 *    unevaluated; each D4 job is registered under its name.
 *  - `haltAgentInTx`: the extracted halt, idempotent, audited.
 *
 * Global state (M-068): every org setting this file relaxes is restored to
 * strict in a `finally`, and every row it creates is removed before it ends.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
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
  governanceReviewPolicyVersions,
  kris,
  runMigrations,
  sql,
  useCaseDecisionRecords,
  useCaseFeedback,
  useCaseFeedbackLinks,
  type Db,
} from "@regulait/db";
import {
  ACCOUNTABILITY_MONITOR_RULE_IDS,
  ACCOUNTABILITY_STRICT_DEFAULTS,
  MONITOR_RULES,
  accountabilityDigest,
} from "@regulait/shared";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { buildApp } from "./app.js";
import { runGovernanceMonitor } from "./governance-monitor.js";
import { routeAuthClass } from "./route-classes.js";
import { SCHEDULER_JOB_NAMES, schedulerJobDefinitions } from "./scheduler-jobs.js";
import { haltAgentInTx } from "./execution-control.js";
import { encryptSecret } from "./secrets.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a182-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "owner" | "member", { id: string; auth: { authorization: string } }>;
const created = { useCases: [] as string[], incidents: [] as string[], agents: [] as string[], kris: [] as string[] };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });

/** the D4 settings as snake_case columns, for the column-default read */
const COLUMN: Record<keyof typeof ACCOUNTABILITY_STRICT_DEFAULTS, string> = {
  decisionRegressionGate: "decision_regression_gate",
  decisionRegressionMaxAgeMinutes: "decision_regression_max_age_minutes",
  incidentGateMode: "incident_gate_mode",
  incidentEvidenceHold: "incident_evidence_hold",
  incidentClockRegimes: "incident_clock_regimes",
  feedbackSignedLinksEnabled: "feedback_signed_links_enabled",
  feedbackAckSlaHours: "feedback_ack_sla_hours",
  feedbackResolveSlaDays: "feedback_resolve_sla_days",
  feedbackRetentionDays: "feedback_retention_days",
  literacyGateMode: "literacy_gate_mode",
  literacyDefaultValidityDays: "literacy_default_validity_days",
  alertSlaHours: "alert_sla_hours",
  alertTicketMode: "alert_ticket_mode",
};

/** one relaxed value per setting (each within its bounds) */
const RELAXED: { [K in keyof typeof ACCOUNTABILITY_STRICT_DEFAULTS]: unknown } = {
  decisionRegressionGate: "warn",
  decisionRegressionMaxAgeMinutes: 1440,
  incidentGateMode: "off",
  incidentEvidenceHold: false,
  incidentClockRegimes: ["eu-ai-act"],
  feedbackSignedLinksEnabled: true,
  feedbackAckSlaHours: 168,
  feedbackResolveSlaDays: 90,
  feedbackRetentionDays: 2555,
  literacyGateMode: "warn",
  literacyDefaultValidityDays: 730,
  alertSlaHours: { high: 48, medium: 72, low: 720 },
  alertTicketMode: "auto_high",
};

async function mkUseCase(label: string): Promise<string> {
  const [row] = await db
    .insert(aiUseCases)
    .values({
      name: `a182 ${label} ${RUN}`,
      description: "synthetic ADR-0182 fixture",
      ownerUserId: users.owner.id,
      businessContext: "synthetic",
      dataSensitivity: "internal",
    })
    .returning({ id: aiUseCases.id });
  created.useCases.push(row!.id);
  return row!.id;
}

async function mkIncident(values: Partial<typeof aiIncidents.$inferInsert> = {}): Promise<string> {
  const [row] = await db
    .insert(aiIncidents)
    .values({ title: `a182 incident ${RUN}`, severity: "high", detectionSource: "manual", awareAt: new Date(), ...values })
    .returning({ id: aiIncidents.id });
  created.incidents.push(row!.id);
  return row!.id;
}

/** the text of a refusal, including Postgres's own message (drizzle wraps it as `cause`) */
function refusalText(e: unknown): string {
  return `${String((e as Error)?.message ?? e)} ${String((e as { cause?: Error })?.cause?.message ?? "")}`;
}
/** the statement must be REFUSED, and for the stated reason */
async function expectRefused(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const e = await Promise.resolve(p).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, "the statement was refused").not.toBeNull();
  expect(refusalText(e)).toMatch(pattern);
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  // ADR-0181 (FX2): this suite drives admins through API keys and is not about
  // MFA, so it relaxes that dial and hands the database back strict (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["owner", false], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, {
      email: `a182-${k}-${RUN}@example.com`,
      displayName: `a182 ${k} ${RUN}`,
      isAdmin,
    });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a182" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  // M-068: every D4 setting back to strict, whatever happened above
  await db.execute(sql`UPDATE org_settings SET
    decision_regression_gate = 'enforce', decision_regression_max_age_minutes = 60,
    incident_gate_mode = 'enforce', incident_evidence_hold = true,
    incident_clock_regimes = '["eu-ai-act", "hipaa"]'::jsonb, feedback_signed_links_enabled = false,
    feedback_ack_sla_hours = 72, feedback_resolve_sla_days = 30, feedback_retention_days = 365,
    literacy_gate_mode = 'enforce', literacy_default_validity_days = 365,
    alert_sla_hours = '{"high": 24, "medium": 72, "low": 168}'::jsonb, alert_ticket_mode = 'manual'`);
  await restoreAdminKeyMfa?.();
  // incidents cascade to their events and clocks (the referential path the
  // append-only trigger admits); use cases cascade to their decision records
  for (const id of created.incidents) await db.delete(aiIncidents).where(eq(aiIncidents.id, id));
  for (const id of created.useCases) await db.delete(aiUseCases).where(eq(aiUseCases.id, id));
  for (const id of created.kris) await db.delete(kris).where(eq(kris.id, id));
  for (const id of created.agents) await db.delete(agents).where(eq(agents.id, id));
  app.server.closeAllConnections();
  await app.close();
});

// ---------------------------------------------------------------------------

describe("ADR-0182 secure by default: the D4 org settings", () => {
  it("a freshly migrated org reads every D4 setting strict — the column defaults and the stored row", async () => {
    const res = await db.execute(sql`
      select column_name, column_default from information_schema.columns
       where table_schema = 'public' and table_name = 'org_settings'`);
    const defaults = new Map(
      (res as unknown as { rows: Array<{ column_name: string; column_default: string | null }> }).rows.map((r) => [
        r.column_name,
        r.column_default ?? "",
      ]),
    );
    const g = await inject("GET", "/v1/org/settings", users.admin.auth);
    expect(g.statusCode, g.body).toBe(200);
    const settings = g.json().settings as Record<string, unknown>;
    for (const [key, strict] of Object.entries(ACCOUNTABILITY_STRICT_DEFAULTS)) {
      // the stored singleton carries the strict value
      expect(settings[key], key).toEqual(strict);
      // and so does the column default (what a first load gets)
      const def = defaults.get(COLUMN[key as keyof typeof COLUMN]);
      expect(def, key).toBeDefined();
      if (typeof strict === "string") expect(def, key).toContain(`'${strict}'`);
      else if (typeof strict === "number" || typeof strict === "boolean") expect(def, key).toBe(String(strict));
      else expect(JSON.parse(def!.replace(/^'/, "").replace(/'::jsonb$/, "")), key).toEqual(strict);
    }
  });

  it("each relaxation is audited with detail.transitions and named as relaxed; strict values come back", async () => {
    try {
      for (const [key, value] of Object.entries(RELAXED)) {
        const put = await inject("PUT", "/v1/org/settings", users.admin.auth, { [key]: value });
        expect(put.statusCode, `${key}: ${put.body}`).toBe(200);
        expect(put.json().settings[key], key).toEqual(value);
        const [row] = await db
          .select()
          .from(auditLog)
          .where(and(eq(auditLog.ruleId, "org-settings-updated"), eq(auditLog.userId, users.admin.id)))
          .orderBy(desc(auditLog.seq))
          .limit(1);
        const detail = row!.detail as { transitions: Record<string, { from: unknown; to: unknown }>; relaxed?: string[] };
        expect(detail.transitions[key], key).toEqual({
          from: ACCOUNTABILITY_STRICT_DEFAULTS[key as keyof typeof ACCOUNTABILITY_STRICT_DEFAULTS],
          to: value,
        });
        expect(detail.relaxed, key).toEqual([key]);
        expect(row!.reason, key).toContain("RELAXED from the strict default");
      }
    } finally {
      const back = await inject("PUT", "/v1/org/settings", users.admin.auth, { ...ACCOUNTABILITY_STRICT_DEFAULTS });
      expect(back.statusCode, back.body).toBe(200);
    }
    const [restore] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "org-settings-updated"), eq(auditLog.userId, users.admin.id)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    const detail = restore!.detail as { transitions: Record<string, unknown>; relaxed?: string[] };
    expect(Object.keys(detail.transitions).sort()).toEqual(Object.keys(ACCOUNTABILITY_STRICT_DEFAULTS).sort());
    expect(detail.relaxed).toBeUndefined();
  });

  it("refuses a value outside its bounds (400), and the database holds the same bounds", async () => {
    for (const body of [
      { alertSlaHours: { high: 721, medium: 72, low: 168 } },
      { alertSlaHours: { high: 24, medium: 72 } },
      { feedbackRetentionDays: 2556 },
      { feedbackAckSlaHours: 169 },
      { literacyDefaultValidityDays: 731 },
      { decisionRegressionMaxAgeMinutes: 1441 },
      { incidentClockRegimes: ["eu-ai-act", "eu-ai-act"] },
      { incidentClockRegimes: ["gdpr"] },
      { incidentGateMode: "lenient" },
    ]) {
      const r = await inject("PUT", "/v1/org/settings", users.admin.auth, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    await expectRefused(db.execute(sql`UPDATE org_settings SET feedback_retention_days = 10`), /org_settings_feedback_retention_check/);
    await expectRefused(
      db.execute(sql`UPDATE org_settings SET alert_sla_hours = '{"high": 0, "medium": 72, "low": 168}'::jsonb`), /org_settings_alert_sla_hours_check/);
    await expectRefused(db.execute(sql`UPDATE org_settings SET incident_clock_regimes = '["gdpr"]'::jsonb`), /org_settings_incident_clock_regimes_check/);
  });

  it("a member cannot read or write the settings", async () => {
    expect((await inject("PUT", "/v1/org/settings", users.member.auth, { incidentGateMode: "off" })).statusCode).toBe(403);
  });
});

describe("ADR-0182 migration 0162: the rules the database holds", () => {
  it("decision records are append-only; deleting the use case removes them (the referential path)", async () => {
    const uc = await mkUseCase("records");
    const [rec] = await db
      .insert(useCaseDecisionRecords)
      .values({ useCaseId: uc, outcome: "approved", decidedAt: new Date(), decidedBy: users.admin.id })
      .returning({ id: useCaseDecisionRecords.id });
    await expectRefused(
      db.update(useCaseDecisionRecords).set({ outcome: "rejected" }).where(eq(useCaseDecisionRecords.id, rec!.id)),
      /append-only/,
    );
    await expectRefused(db.delete(useCaseDecisionRecords).where(eq(useCaseDecisionRecords.id, rec!.id)), /append-only/);
    expect(await db.select().from(useCaseDecisionRecords).where(eq(useCaseDecisionRecords.id, rec!.id))).toHaveLength(1);
    await expectRefused(
      db.insert(useCaseDecisionRecords).values({ useCaseId: uc, outcome: "waved_through", decidedAt: new Date() } as never),
      /use_case_decision_records_outcome_check/,
    );
    await db.delete(aiUseCases).where(eq(aiUseCases.id, uc));
    expect(await db.select().from(useCaseDecisionRecords).where(eq(useCaseDecisionRecords.id, rec!.id))).toHaveLength(0);
  });

  it("incident events are append-only; a clock is never deleted and is set aside only with a reason", async () => {
    const inc = await mkIncident();
    const [ev] = await db
      .insert(aiIncidentEvents)
      .values({ incidentId: inc, kind: "note", note: "synthetic note", actorUserId: users.admin.id })
      .returning({ id: aiIncidentEvents.id });
    await expectRefused(db.update(aiIncidentEvents).set({ note: "edited" }).where(eq(aiIncidentEvents.id, ev!.id)), /append-only/);
    await expectRefused(db.delete(aiIncidentEvents).where(eq(aiIncidentEvents.id, ev!.id)), /append-only/);

    const start = new Date();
    const [clock] = await db
      .insert(aiIncidentNotifications)
      .values({ incidentId: inc, regime: "eu-ai-act", clockId: "art73-2-general", clockStart: start, dueAt: new Date(start.getTime() + 15 * 86_400_000) })
      .returning({ id: aiIncidentNotifications.id });
    await expectRefused(db.delete(aiIncidentNotifications).where(eq(aiIncidentNotifications.id, clock!.id)), /append-only/);
    await expectRefused(
      db.update(aiIncidentNotifications).set({ status: "not_required" }).where(eq(aiIncidentNotifications.id, clock!.id)), /ai_incident_notifications_reason_check/);
    await expectRefused(
      db.update(aiIncidentNotifications).set({ status: "tolled", reason: "  " }).where(eq(aiIncidentNotifications.id, clock!.id)), /ai_incident_notifications_reason_check/);
    await db
      .update(aiIncidentNotifications)
      .set({ status: "tolled", reason: "law-enforcement delay under 45 CFR 164.412 (synthetic)" })
      .where(eq(aiIncidentNotifications.id, clock!.id));
    // one clock per (incident, clock id)
    await expectRefused(
      db.insert(aiIncidentNotifications).values({ incidentId: inc, regime: "eu-ai-act", clockId: "art73-2-general", clockStart: start, dueAt: start }), /ai_incident_notifications_clock_uq/);
  });

  it("an incident closes only with a root cause and lessons learned", async () => {
    const inc = await mkIncident();
    await expectRefused(
      db.update(aiIncidents).set({ status: "closed", closedAt: new Date(), rootCause: "x" }).where(eq(aiIncidents.id, inc)), /ai_incidents_closed_check/);
    await expectRefused(
      db
        .update(aiIncidents)
        .set({ status: "closed", closedAt: new Date(), rootCause: "x", lessonsLearned: "   " })
        .where(eq(aiIncidents.id, inc)), /ai_incidents_closed_check/);
    await db
      .update(aiIncidents)
      .set({ status: "closed", closedAt: new Date(), rootCause: "a synthetic cause", lessonsLearned: "a synthetic lesson" })
      .where(eq(aiIncidents.id, inc));
    const [row] = await db.select({ ref: aiIncidents.ref }).from(aiIncidents).where(eq(aiIncidents.id, inc));
    expect(row!.ref).toMatch(/^INC-\d{5,}$/);
  });

  it("refuses a signed feedback link living longer than 30 days, and an appeal outcome on a problem", async () => {
    const uc = await mkUseCase("links");
    const now = new Date();
    const hash = (c: string) => c.repeat(64);
    await expectRefused(
      db.insert(useCaseFeedbackLinks).values({
        useCaseId: uc,
        tokenHash: hash("a"),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 31 * 86_400_000),
        maxUses: 5,
      }), /use_case_feedback_links_ttl_check/);
    await db.insert(useCaseFeedbackLinks).values({
      useCaseId: uc,
      tokenHash: hash("b"),
      createdAt: now,
      expiresAt: new Date(now.getTime() + 30 * 86_400_000),
      maxUses: 5,
    });
    const due = { ackDueAt: new Date(now.getTime() + 72 * 3_600_000), resolveDueAt: new Date(now.getTime() + 30 * 86_400_000) };
    await expectRefused(
      db.insert(useCaseFeedback).values({
        useCaseId: uc, kind: "problem", channel: "in_app", bodyCiphertext: encryptSecret("a".repeat(64), "synthetic feedback body"), status: "overturned", resolvedAt: now, ...due,
      }), /use_case_feedback_appeal_outcome_check/);
    await db.insert(useCaseFeedback).values({
      useCaseId: uc, kind: "appeal", channel: "in_app", bodyCiphertext: encryptSecret("a".repeat(64), "synthetic feedback body"), status: "overturned", resolvedAt: now, ...due,
    });
  });

  it("refuses propose_halt on a fleet or project KRI, and allows it on an agent KRI", async () => {
    await expectRefused(
      db.insert(kris).values({ name: `a182 fleet ${RUN}`, metric: "error_rate", threshold: 0.1, onBreach: "propose_halt" }), /kris_on_breach_scope_check/);
    const [a] = await db.insert(agents).values({ name: `a182-agent-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
    created.agents.push(a!.id);
    const [k] = await db
      .insert(kris)
      .values({ name: `a182 agent ${RUN}`, metric: "error_rate", scope: "agent", scopeId: a!.id, threshold: 0.1, onBreach: "propose_halt" })
      .returning({ id: kris.id, onBreach: kris.onBreach });
    created.kris.push(k!.id);
    expect(k!.onBreach).toBe("propose_halt");
    // and a KRI created without naming it takes `alert`
    const [d] = await db
      .insert(kris)
      .values({ name: `a182 default ${RUN}`, metric: "error_rate", threshold: 0.1 })
      .returning({ id: kris.id, onBreach: kris.onBreach });
    created.kris.push(d!.id);
    expect(d!.onBreach).toBe("alert");
  });

  it("review-policy versions are append-only, and the SQL digest equals the shared one", async () => {
    const body = {
      roles: [{ id: "r1", name: "Privacy — DPO \"lead\"", memberUserIds: ["u2", "u1"] }],
      tiers: { high: { roleIds: ["r1"], validityMonths: 6 }, minimal: { roleIds: [] } },
      riskAcceptorUserIds: [],
      requiredTests: { high: { classes: [{ class: "prompt_injection", maxAgeDays: 30, threshold: 0.05 }] } },
      zeta: "line\nbreak\ttab é 日本",
    };
    const res = await db.execute(
      sql`select encode(sha256(convert_to(regulait_canonical_json(${JSON.stringify(body)}::jsonb), 'UTF8')), 'hex') as d`,
    );
    const sqlDigest = (res as unknown as { rows: Array<{ d: string }> }).rows[0]!.d;
    expect(sqlDigest).toBe(accountabilityDigest(body));

    // An append-only row can never be removed, so the probe runs inside a
    // transaction that is rolled back: the version table stays as A11 finds it.
    const ROLLBACK = new Error("a182: roll the probe back");
    const refusals: string[] = [];
    await expect(
      db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const version = 900_000 + Math.floor(Math.random() * 99_999);
        await tx.insert(governanceReviewPolicyVersions).values({ version, body, digest: accountabilityDigest(body) });
        for (const attempt of [
          () => tx.update(governanceReviewPolicyVersions).set({ digest: "0".repeat(64) }).where(eq(governanceReviewPolicyVersions.version, version)),
          () => tx.delete(governanceReviewPolicyVersions).where(eq(governanceReviewPolicyVersions.version, version)),
        ]) {
          // a savepoint per attempt, so the refusal does not abort the probe
          await rawTx
            .transaction(async () => {
              await attempt();
            })
            .catch((e: unknown) => refusals.push(refusalText(e)));
        }
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    expect(refusals).toHaveLength(2);
    for (const r of refusals) expect(r).toMatch(/append-only/);
  });
});

describe("ADR-0182 the use case's EU AI Act role", () => {
  const PATH = (id: string) => `/v1/use-cases/${id}/eu-ai-act-role`;

  it("defaults to both; only an admin narrows it, with a reason; the owner may return it to both; all audited", async () => {
    const uc = await mkUseCase("role");
    const [fresh] = await db.select({ role: aiUseCases.euAiActRole }).from(aiUseCases).where(eq(aiUseCases.id, uc));
    expect(fresh!.role).toBe("both");
    expect(routeAuthClass("PUT", "/v1/use-cases/:useCaseId/eu-ai-act-role")).toBe("user");

    // a stranger may do nothing; the owner may not narrow (and the refusal is audited)
    expect((await inject("PUT", PATH(uc), users.member.auth, { role: "both" })).statusCode).toBe(403);
    const ownerNarrow = await inject("PUT", PATH(uc), users.owner.auth, { role: "deployer", reason: "we only deploy this system" });
    expect(ownerNarrow.statusCode, ownerNarrow.body).toBe(403);
    expect(ownerNarrow.json().error).toBe("relaxation_admin_only");
    const [refused] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "use-case-eu-ai-act-role-refused"), eq(auditLog.objectId, uc)));
    expect(refused?.effect).toBe("deny");

    // an admin narrows it only with a reason
    expect((await inject("PUT", PATH(uc), users.admin.auth, { role: "deployer" })).statusCode).toBe(422);
    const narrowed = await inject("PUT", PATH(uc), users.admin.auth, {
      role: "deployer",
      reason: "the vendor is the provider; we deploy it as is",
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    expect(narrowed.json()).toMatchObject({ euAiActRole: "deployer", changed: true });
    const [set] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "use-case-eu-ai-act-role-set"), eq(auditLog.objectId, uc)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    expect(set!.detail).toMatchObject({ transitions: { euAiActRole: { from: "both", to: "deployer" } }, relaxed: true });
    expect(set!.reason).toContain("RELAXED");

    // the owner returns it to the strict default
    const back = await inject("PUT", PATH(uc), users.owner.auth, { role: "both" });
    expect(back.statusCode, back.body).toBe(200);
    const [row] = await db.select({ role: aiUseCases.euAiActRole }).from(aiUseCases).where(eq(aiUseCases.id, uc));
    expect(row!.role).toBe("both");
    // a write that changes nothing writes nothing
    const again = await inject("PUT", PATH(uc), users.owner.auth, { role: "both" });
    expect(again.json().changed).toBe(false);
    // unknown use case, bad role
    expect((await inject("PUT", PATH("00000000-0000-4000-8000-000000000009"), users.admin.auth, { role: "both" })).statusCode).toBe(404);
    expect((await inject("PUT", PATH(uc), users.admin.auth, { role: "importer" })).statusCode).toBe(400);
  });
});

describe("ADR-0182 D4 routes: registered with a deliberate auth class, 501 until their slice lands", () => {
  const U = "00000000-0000-4000-8000-000000000001";
  const X = "00000000-0000-4000-8000-000000000002";
  const ROUTES: Array<{ method: Method; pattern: string; url: string; cls: "admin" | "user" | "public" }> = [
    // A11: built — classes and behaviour pinned by zz-adr0182-a11-decision-regression.test.ts
    // A12
    { method: "GET", pattern: "/v1/incidents", url: "/v1/incidents", cls: "user" },
    { method: "POST", pattern: "/v1/incidents", url: "/v1/incidents", cls: "user" },
    { method: "GET", pattern: "/v1/incidents/:incidentId", url: `/v1/incidents/${X}`, cls: "user" },
    { method: "PATCH", pattern: "/v1/incidents/:incidentId", url: `/v1/incidents/${X}`, cls: "user" },
    { method: "POST", pattern: "/v1/incidents/:incidentId/events", url: `/v1/incidents/${X}/events`, cls: "user" },
    { method: "POST", pattern: "/v1/incidents/:incidentId/links", url: `/v1/incidents/${X}/links`, cls: "user" },
    { method: "POST", pattern: "/v1/incidents/:incidentId/actions", url: `/v1/incidents/${X}/actions`, cls: "user" },
    { method: "PATCH", pattern: "/v1/incidents/:incidentId/actions/:actionId", url: `/v1/incidents/${X}/actions/${U}`, cls: "user" },
    { method: "POST", pattern: "/v1/incidents/:incidentId/notifications/:notificationId/sent", url: `/v1/incidents/${X}/notifications/${U}/sent`, cls: "user" },
    { method: "POST", pattern: "/v1/incidents/:incidentId/notifications/:notificationId/not-required", url: `/v1/incidents/${X}/notifications/${U}/not-required`, cls: "admin" },
    { method: "POST", pattern: "/v1/incidents/:incidentId/notifications/:notificationId/toll", url: `/v1/incidents/${X}/notifications/${U}/toll`, cls: "admin" },
    { method: "POST", pattern: "/v1/incidents/:incidentId/close", url: `/v1/incidents/${X}/close`, cls: "user" },
    { method: "POST", pattern: "/v1/incidents/:incidentId/contain", url: `/v1/incidents/${X}/contain`, cls: "admin" },
    { method: "GET", pattern: "/v1/incidents/:incidentId/export", url: `/v1/incidents/${X}/export`, cls: "admin" },
    // A13
    { method: "POST", pattern: "/v1/use-cases/:useCaseId/feedback", url: `/v1/use-cases/${U}/feedback`, cls: "user" },
    { method: "GET", pattern: "/v1/feedback", url: "/v1/feedback", cls: "user" },
    { method: "GET", pattern: "/v1/feedback/:feedbackId", url: `/v1/feedback/${X}`, cls: "user" },
    { method: "PATCH", pattern: "/v1/feedback/:feedbackId", url: `/v1/feedback/${X}`, cls: "user" },
    { method: "POST", pattern: "/v1/feedback/:feedbackId/open-incident", url: `/v1/feedback/${X}/open-incident`, cls: "user" },
    { method: "POST", pattern: "/v1/use-cases/:useCaseId/feedback-links", url: `/v1/use-cases/${U}/feedback-links`, cls: "user" },
    { method: "GET", pattern: "/v1/use-cases/:useCaseId/feedback-links", url: `/v1/use-cases/${U}/feedback-links`, cls: "user" },
    { method: "DELETE", pattern: "/v1/use-cases/:useCaseId/feedback-links/:linkId", url: `/v1/use-cases/${U}/feedback-links/${X}`, cls: "user" },
    { method: "POST", pattern: "/v1/feedback/l/:token", url: "/v1/feedback/l/synthetic-token", cls: "public" },
    { method: "GET", pattern: "/v1/feedback/l/:token", url: "/v1/feedback/l/synthetic-token", cls: "public" },
    // A14
    { method: "GET", pattern: "/v1/ai-policies", url: "/v1/ai-policies", cls: "user" },
    { method: "POST", pattern: "/v1/ai-policies", url: "/v1/ai-policies", cls: "admin" },
    { method: "GET", pattern: "/v1/ai-policies/coverage", url: "/v1/ai-policies/coverage", cls: "admin" },
    { method: "POST", pattern: "/v1/ai-policies/:policyId/publish", url: `/v1/ai-policies/${X}/publish`, cls: "admin" },
    { method: "POST", pattern: "/v1/ai-policies/:policyId/retire", url: `/v1/ai-policies/${X}/retire`, cls: "admin" },
    { method: "POST", pattern: "/v1/ai-policies/:policyId/acknowledge", url: `/v1/ai-policies/${X}/acknowledge`, cls: "user" },
    { method: "POST", pattern: "/v1/ai-policies/:policyId/records", url: `/v1/ai-policies/${X}/records`, cls: "admin" },
    { method: "GET", pattern: "/v1/me/ai-literacy", url: "/v1/me/ai-literacy", cls: "user" },
    // S5
    { method: "PUT", pattern: "/v1/governance/alerts/:alertId/owner", url: `/v1/governance/alerts/${X}/owner`, cls: "user" },
    { method: "POST", pattern: "/v1/governance/alerts/:alertId/ticket", url: `/v1/governance/alerts/${X}/ticket`, cls: "admin" },
  ];

  it.each(ROUTES)("$method $pattern is classed $cls and answers 501", async (r) => {
    expect(routeAuthClass(r.method, r.pattern)).toBe(r.cls);
    const asAdmin = await inject(r.method, r.url, users.admin.auth, r.method === "GET" || r.method === "DELETE" ? undefined : {});
    expect(asAdmin.statusCode, asAdmin.body).toBe(501);
    expect(asAdmin.json().error).toBe("not_implemented");
    const asMember = await inject(r.method, r.url, users.member.auth, r.method === "GET" || r.method === "DELETE" ? undefined : {});
    expect(asMember.statusCode, asMember.body).toBe(r.cls === "admin" ? 403 : 501);
    if (r.cls === "public") {
      const anon = await inject(r.method, r.url, {}, r.method === "GET" ? undefined : {});
      expect(anon.statusCode, anon.body).toBe(501);
    } else {
      expect((await inject(r.method, r.url, {}, r.method === "GET" || r.method === "DELETE" ? undefined : {})).statusCode).toBe(401);
    }
  });
});

describe("ADR-0182 monitor and scheduler: the four accountability rules, the five jobs", () => {
  it("the rules are in the catalogue at their stated severities", () => {
    expect([...ACCOUNTABILITY_MONITOR_RULE_IDS].sort()).toEqual([
      "feedback_sla_breached",
      "incident_action_overdue",
      "incident_notification_due",
      "literacy_coverage_gap",
    ]);
    expect(MONITOR_RULES.incident_notification_due.severity).toBe("high");
    expect(MONITOR_RULES.incident_action_overdue.severity).toBe("medium");
    expect(MONITOR_RULES.feedback_sla_breached.severity).toBe("medium");
    expect(MONITOR_RULES.literacy_coverage_gap.severity).toBe("low");
  });

  it("the stubs report nothing (every rule evaluated); a slice's breach raises; a failed loader leaves its rules unevaluated", async () => {
    const subjectKey = `incident:a182-${RUN}>clock:art73-2-general`;
    const open = () =>
      db
        .select({ id: governanceAlerts.id, status: governanceAlerts.status, severity: governanceAlerts.severity, ownerUserId: governanceAlerts.ownerUserId, dueAt: governanceAlerts.dueAt })
        .from(governanceAlerts)
        .where(and(eq(governanceAlerts.ruleId, "incident_notification_due"), eq(governanceAlerts.subjectKey, subjectKey)));
    try {
      const quiet = await runGovernanceMonitor(db, { actorUserId: users.admin.id });
      for (const id of ACCOUNTABILITY_MONITOR_RULE_IDS) expect(quiet.notEvaluated).not.toContain(id);
      expect(await open()).toEqual([]);

      const raised = await runGovernanceMonitor(db, {
        actorUserId: users.admin.id,
        optionalInputs: {
          incidents: async () => ({
            incident_notification_due: { breaches: [{ subjectKey, title: `a182 ${RUN}: a clock is due`, detail: { runId: RUN } }] },
            incident_action_overdue: { breaches: [] },
          }),
          literacy: async () => {
            throw new Error("injected literacy failure");
          },
        },
      });
      expect(raised.notEvaluated).toContain("literacy_coverage_gap");
      expect(raised.notEvaluated).not.toContain("incident_notification_due");
      const rows = await open();
      expect(rows).toHaveLength(1);
      // the S5 stub assigns no owner and no due time yet
      expect(rows[0]).toMatchObject({ status: "open", severity: "high", ownerUserId: null, dueAt: null });

      await runGovernanceMonitor(db, { actorUserId: users.admin.id });
      expect((await open())[0]?.status).toBe("resolved");
    } finally {
      await db.delete(governanceAlerts).where(and(eq(governanceAlerts.ruleId, "incident_notification_due"), eq(governanceAlerts.subjectKey, subjectKey)));
    }
  });

  it("each D4 job is registered under its name and processes nothing yet", async () => {
    const defs = new Map(schedulerJobDefinitions({ dataKey: "a".repeat(64) }).map((d) => [d.name, d]));
    for (const name of [
      SCHEDULER_JOB_NAMES.incidentClockSweep,
      SCHEDULER_JOB_NAMES.feedbackSlaSweep,
      SCHEDULER_JOB_NAMES.feedbackRetentionSweep,
      SCHEDULER_JOB_NAMES.literacyExpirySweep,
      SCHEDULER_JOB_NAMES.alertSlaSweep,
    ]) {
      const d = defs.get(name);
      expect(d, name).toBeDefined();
      expect(d!.adr).toBe("ADR-0182");
      const out = await d!.run({ db, now: new Date(), actorUserId: null } as never);
      expect(out.itemsProcessed, name).toBe(0);
    }
  });
});

describe("ADR-0182 P0: haltAgentInTx, the extracted halt", () => {
  it("halts once inside the caller's transaction, audits it, and a second call writes nothing", async () => {
    const [a] = await db.insert(agents).values({ name: `a182-halt-${RUN}`, provider: "mock", tier: 1 }).returning({ id: agents.id });
    created.agents.push(a!.id);
    const first = await db.transaction((tx) =>
      haltAgentInTx(tx as unknown as Db, a!.id, "synthetic containment for a test", { userId: users.admin.id, detail: { incidentRef: "INC-TEST" } }),
    );
    expect(first).toMatchObject({ agentId: a!.id, halted: true, changed: true });
    const [row] = await db.select().from(agents).where(eq(agents.id, a!.id));
    expect(row!.haltedAt).not.toBeNull();
    expect(row!.haltedByUserId).toBe(users.admin.id);
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, "execution-agent-halted"), eq(auditLog.objectId, a!.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0]!.detail).toMatchObject({ incidentRef: "INC-TEST" });
    const second = await db.transaction((tx) =>
      haltAgentInTx(tx as unknown as Db, a!.id, "synthetic containment again", { userId: users.admin.id }),
    );
    expect(second).toMatchObject({ changed: false });
    expect(
      await db.select().from(auditLog).where(and(eq(auditLog.ruleId, "execution-agent-halted"), eq(auditLog.objectId, a!.id))),
    ).toHaveLength(1);
    expect(await db.transaction((tx) => haltAgentInTx(tx as unknown as Db, "00000000-0000-4000-8000-00000000000f", "unknown agent here", { userId: null }))).toBeNull();
  });
});
