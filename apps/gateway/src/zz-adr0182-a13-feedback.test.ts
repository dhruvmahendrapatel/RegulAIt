/**
 * ADR-0182 (ADR-0175 batch D4) A13 — END-USER FEEDBACK AND APPEAL, on a real
 * database through the real app.
 *
 * Pinned (each red-proven by reverting the rule; see the slice summary):
 *  - submission: any signed-in user; a cited trace/span from another project
 *    (or no such trace) is 422 `trace_not_in_use_case`, audited; the body and
 *    contact are stored as data-key envelopes, never plaintext; due times
 *    follow the org's SLA settings; routing to the owner, or to the admins for
 *    an appeal against the owner's own decision;
 *  - reading: a non-owner non-admin cannot read a body (403, audited); every
 *    read by the owner or an admin is audited; the queue carries no body;
 *  - answering: a problem report cannot be upheld/overturned; a resolution
 *    needs a note; an appeal is never resolved by the person whose decision it
 *    contests (SoD, 403, audited); a resolved item is final;
 *  - `feedback-sla-sweep` raises `feedback_sla_breached` once per breached
 *    phase, owned by the item's owner; the monitor loader reports the same
 *    subjects and drops one once it is answered;
 *  - `feedback-retention-sweep` deletes bodies and contacts past the window,
 *    stamps `body_purged_at` and keeps the resolution record;
 *  - signed links: 404 while the setting is off (the shipped default), minting
 *    refused while off; token shown once and stored only as its hash; expired,
 *    revoked and used-up links refused; body over 4000 characters refused;
 *    rate-limited per address and per link;
 *  - the two A2 metrics read `insufficient` below their minimum samples and
 *    compute the stated arithmetic above it;
 *  - "Open incident" builds A12's create payload (user_report, feedback link,
 *    no copy of the body) and relays A12's answer.
 *
 * Global state (M-068): the feedback settings are put back to strict in
 * afterAll, and every use case, project, trace and alert this file created is
 * removed (use cases cascade to their feedback and links).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiIncidentLinks,
  aiIncidents,
  aiUseCases,
  and,
  auditLog,
  createDb,
  desc,
  eq,
  governanceAlerts,
  inArray,
  projects,
  runMigrations,
  sql,
  traceSpans,
  traces,
  useCaseFeedback,
  useCaseFeedbackLinks,
  type Db,
} from "@regulait/db";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { buildApp } from "./app.js";
import {
  FEEDBACK_RULE_IDS,
  feedbackMonitorInput,
  generateFeedbackLinkToken,
  openIncidentFromFeedback,
  runFeedbackRetentionSweep,
  runFeedbackSlaSweep,
} from "./feedback.js";
import { measureAssuranceMetric } from "./condition-metrics.js";
import { runAlertSlaSweep } from "./alert-ownership.js";
import { routeAuthClass } from "./route-classes.js";
import { hashToken } from "./token-hash.js";
import { decryptSecret } from "./secrets.js";
import { relaxStepUpForTest } from "./testing/step-up-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `a13-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);
const HOUR = 3_600_000;
const DAY = 86_400_000;
let db: Db;
let app: ReturnType<typeof buildApp>;
/** a second app with the HTTP rate limiter ON (the suite runs with it off) */
let limited: ReturnType<typeof buildApp>;
type Who = "admin" | "owner" | "member" | "decider";
const users = {} as Record<Who, { id: string; auth: { authorization: string } }>;
const created = { useCases: [] as string[], projects: [] as string[], traces: [] as string[] };

type Method = "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
const inject = (method: Method, url: string, headers: Record<string, string>, payload?: unknown, remoteAddress?: string) =>
  app.inject({
    method,
    url,
    headers,
    ...(payload !== undefined ? { payload: payload as object } : {}),
    ...(remoteAddress ? { remoteAddress } : {}),
  });

const rnd = () => Math.floor(Math.random() * 250) + 1;
/** a fresh TEST-NET-3 address per call, so the shared rate-limit counters of an earlier run never apply */
const freshIp = () => `203.0.${rnd()}.${rnd()}`;

async function mkProject(label: string): Promise<string> {
  const [p] = await db.insert(projects).values({ name: `a13 ${label} ${RUN}` }).returning({ id: projects.id });
  created.projects.push(p!.id);
  return p!.id;
}

async function mkUseCase(label: string, projectId: string | null, ownerUserId = users.owner.id): Promise<string> {
  const [row] = await db
    .insert(aiUseCases)
    .values({
      name: `a13 ${label} ${RUN}`,
      description: "synthetic ADR-0182 A13 fixture",
      ownerUserId,
      businessContext: "synthetic",
      dataSensitivity: "internal",
      projectId,
    })
    .returning({ id: aiUseCases.id });
  created.useCases.push(row!.id);
  return row!.id;
}

async function mkTrace(projectId: string | null, userId: string, opts: { status?: "ok" | "error" | "running"; startedAt?: Date } = {}) {
  const [t] = await db
    .insert(traces)
    .values({
      kind: "dispatch",
      name: `a13 trace ${RUN}`,
      userId,
      projectId,
      status: opts.status ?? "ok",
      startedAt: opts.startedAt ?? new Date(),
    })
    .returning({ id: traces.id });
  created.traces.push(t!.id);
  const [s] = await db
    .insert(traceSpans)
    .values({ traceId: t!.id, seq: 0, kind: "llm", name: "a13 span", startedAt: new Date() })
    .returning({ id: traceSpans.id });
  return { traceId: t!.id, spanId: s!.id };
}

async function setFeedbackSettings(patch: Record<string, unknown>) {
  const r = await inject("PUT", "/v1/org/settings", users.admin.auth, patch);
  expect(r.statusCode, r.body).toBe(200);
}

async function lastAudit(ruleId: string, objectId?: string) {
  const [row] = await db
    .select()
    .from(auditLog)
    .where(objectId ? and(eq(auditLog.ruleId, ruleId), eq(auditLog.objectId, objectId)) : eq(auditLog.ruleId, ruleId))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  return row;
}

async function submit(useCaseId: string, who: Who, body: Record<string, unknown>) {
  return inject("POST", `/v1/use-cases/${useCaseId}/feedback`, users[who].auth, body);
}

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
// ADR-0186 A: this suite drives step-up actions through API keys, which can never step up (restored below, M-068)
let restoreStepUp: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  restoreStepUp = await relaxStepUpForTest(db);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  limited = buildApp(db, {
    bootstrapToken: BOOT,
    dataKey: DATA_KEY,
    trustProxy: false,
    rateLimit: { enabled: true, globalMax: 100_000, apiKeyMax: 100_000 },
  });
  for (const [k, isAdmin] of [["admin", true], ["owner", false], ["member", false], ["decider", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `a13-${k}-${RUN}@example.com`, displayName: `a13 ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "a13" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
}, 120_000);

afterAll(async () => {
  await restoreStepUp?.();
  await db.execute(sql`UPDATE org_settings SET feedback_signed_links_enabled = false,
    feedback_ack_sla_hours = 72, feedback_resolve_sla_days = 30, feedback_retention_days = 365`);
  await restoreAdminKeyMfa?.();
  for (const id of created.useCases) {
    await db.delete(governanceAlerts).where(sql`${governanceAlerts.subjectKey} like ${`use_case:${id}>feedback:%`}`);
  }
  if (created.useCases.length) await db.delete(aiUseCases).where(inArray(aiUseCases.id, created.useCases));
  if (created.traces.length) await db.delete(traces).where(inArray(traces.id, created.traces));
  if (created.projects.length) await db.delete(projects).where(inArray(projects.id, created.projects));
  await db.execute(sql`delete from rate_limit_counters where bucket like 'fbl:%'`);
  for (const a of [app, limited]) {
    a.server.closeAllConnections();
    await a.close();
  }
});

// ---------------------------------------------------------------------------

describe("A13 submission: ownership of a cited trace, encryption, due times, routing", () => {
  it("a trace from another project, a span from another trace, or no such trace is 422 and audited", async () => {
    const p1 = await mkProject("p1");
    const p2 = await mkProject("p2");
    const uc = await mkUseCase("trace-check", p1);
    const foreign = await mkTrace(p2, users.member.id);
    const own = await mkTrace(p1, users.member.id);
    const other = await mkTrace(p1, users.member.id);

    const bad = await submit(uc, "member", { kind: "problem", body: "wrong answer", traceId: foreign.traceId });
    expect(bad.statusCode, bad.body).toBe(422);
    expect(bad.json().error).toBe("trace_not_in_use_case");
    const refusal = await lastAudit(FEEDBACK_RULE_IDS.submitRefused);
    expect(refusal!.effect).toBe("deny");
    expect((refusal!.detail as { traceId: string }).traceId).toBe(foreign.traceId);

    const missing = await submit(uc, "member", { kind: "problem", body: "x", traceId: "00000000-0000-4000-8000-000000000001" });
    expect(missing.statusCode).toBe(422);
    const crossSpan = await submit(uc, "member", { kind: "problem", body: "x", traceId: own.traceId, spanId: other.spanId });
    expect(crossSpan.statusCode).toBe(422);

    const ok = await submit(uc, "member", { kind: "problem", body: "wrong answer", traceId: own.traceId, spanId: own.spanId });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().traceId).toBe(own.traceId);
  });

  it("stores the body and contact as data-key envelopes, sets due times from the settings, routes to the owner", async () => {
    const uc = await mkUseCase("encrypt", null);
    const before = Date.now();
    const r = await submit(uc, "member", { kind: "problem", body: "SYNTHETIC-BODY-a13 the answer was wrong", contact: "synthetic@example.com" });
    expect(r.statusCode, r.body).toBe(201);
    const j = r.json();
    expect(j.ownerUserId).toBe(users.owner.id);
    expect(j.routedTo).toBe("owner");
    expect(j).not.toHaveProperty("body");
    const [row] = await db.select().from(useCaseFeedback).where(eq(useCaseFeedback.id, j.id));
    expect(row!.bodyCiphertext).toBeTruthy();
    expect(row!.bodyCiphertext).not.toContain("SYNTHETIC-BODY");
    expect(row!.contactCiphertext).not.toContain("synthetic@example.com");
    // strict defaults: 72 h to acknowledge, 30 d to resolve
    const ack = row!.ackDueAt.getTime() - row!.createdAt.getTime();
    const res = row!.resolveDueAt.getTime() - row!.createdAt.getTime();
    expect(ack).toBe(72 * HOUR);
    expect(res).toBe(30 * DAY);
    expect(row!.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    const a = await lastAudit(FEEDBACK_RULE_IDS.submitted, j.id);
    expect(JSON.stringify(a)).not.toContain("SYNTHETIC-BODY");
    expect(JSON.stringify(a)).not.toContain("synthetic@example.com");
  });

  it("a relaxed SLA setting moves the due times (and acknowledgement never falls after resolution)", async () => {
    try {
      await setFeedbackSettings({ feedbackAckSlaHours: 168, feedbackResolveSlaDays: 1 });
      const uc = await mkUseCase("sla-setting", null);
      const r = await submit(uc, "member", { kind: "problem", body: "x" });
      expect(r.statusCode, r.body).toBe(201);
      const j = r.json();
      expect(Date.parse(j.resolveDueAt) - Date.parse(j.createdAt)).toBe(1 * DAY);
      expect(j.ackDueAt).toBe(j.resolveDueAt);
    } finally {
      await setFeedbackSettings({ feedbackAckSlaHours: 72, feedbackResolveSlaDays: 30 });
    }
  });

  it("an appeal against the owner's own decision is routed to the admins", async () => {
    const p = await mkProject("route");
    const uc = await mkUseCase("route", p);
    const ownersTrace = await mkTrace(p, users.owner.id);
    const r = await submit(uc, "member", { kind: "appeal", body: "please review", traceId: ownersTrace.traceId });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().ownerUserId).toBeNull();
    expect(r.json().routedTo).toBe("admins");
    // and the admin cannot hand it to the person whose decision it contests
    const reassign = await inject("PATCH", `/v1/feedback/${r.json().id}`, users.admin.auth, { ownerUserId: users.owner.id });
    expect(reassign.statusCode, reassign.body).toBe(422);
    expect(reassign.json().error).toBe("owner_conflicted");
  });
});

describe("A13 reading: owner or admin only, every read audited, the queue carries no body", () => {
  it("a non-owner non-admin cannot read a body; the owner and an admin can, and each read is audited", async () => {
    const uc = await mkUseCase("read", null);
    const r = await submit(uc, "member", { kind: "problem", body: "READ-ME-a13 private words", contact: "reach@example.com" });
    const id = r.json().id as string;

    const denied = await inject("GET", `/v1/feedback/${id}`, users.decider.auth);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).not.toContain("READ-ME");
    const d = await lastAudit(FEEDBACK_RULE_IDS.readDenied, id);
    expect(d!.effect).toBe("deny");
    expect(d!.userId).toBe(users.decider.id);

    // the submitter is not the owner either
    expect((await inject("GET", `/v1/feedback/${id}`, users.member.auth)).statusCode).toBe(403);

    const owner = await inject("GET", `/v1/feedback/${id}`, users.owner.auth);
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().body).toBe("READ-ME-a13 private words");
    expect(owner.json().contact).toBe("reach@example.com");
    const read = await lastAudit(FEEDBACK_RULE_IDS.bodyRead, id);
    expect(read!.userId).toBe(users.owner.id);
    expect((read!.detail as { bodyRead: boolean; contactRead: boolean }).bodyRead).toBe(true);
    expect((read!.detail as { contactRead: boolean }).contactRead).toBe(true);
    expect(JSON.stringify(read)).not.toContain("READ-ME");

    const admin = await inject("GET", `/v1/feedback/${id}`, users.admin.auth);
    expect(admin.statusCode).toBe(200);
    expect((await lastAudit(FEEDBACK_RULE_IDS.bodyRead, id))!.userId).toBe(users.admin.id);
  });

  it("the queue: the owner sees their items without bodies, a member sees none, the submitter sees what they sent", async () => {
    const uc = await mkUseCase("queue", null);
    const r = await submit(uc, "member", { kind: "problem", body: "QUEUE-a13 text" });
    const id = r.json().id as string;
    const ownerQ = await inject("GET", `/v1/feedback?useCaseId=${uc}`, users.owner.auth);
    expect(ownerQ.statusCode, ownerQ.body).toBe(200);
    expect(ownerQ.json().items.map((i: { id: string }) => i.id)).toContain(id);
    expect(ownerQ.body).not.toContain("QUEUE-a13");
    expect(ownerQ.json().items[0].sla.chip).toBe("on_time");
    const memberQ = await inject("GET", `/v1/feedback?useCaseId=${uc}`, users.member.auth);
    expect(memberQ.json().items).toEqual([]);
    const mine = await inject("GET", `/v1/feedback?scope=submitted&useCaseId=${uc}`, users.member.auth);
    expect(mine.json().items.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(mine.body).not.toContain("QUEUE-a13");
  });
});

describe("A13 answering: transitions, the resolution note, separation of duties", () => {
  it("acknowledge, then a problem cannot be upheld, and resolving needs a note; a resolved item is final", async () => {
    const uc = await mkUseCase("answer", null);
    const id = (await submit(uc, "member", { kind: "problem", body: "x" })).json().id as string;
    const ack = await inject("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status: "acknowledged" });
    expect(ack.statusCode, ack.body).toBe(200);
    expect(ack.json().acknowledgedAt).not.toBeNull();
    const audited = await lastAudit(FEEDBACK_RULE_IDS.updated, id);
    expect((audited!.detail as { transitions: Record<string, unknown> }).transitions.status).toEqual({ from: "received", to: "acknowledged" });

    const upheld = await inject("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status: "upheld", resolutionNote: "n" });
    expect(upheld.statusCode).toBe(422);
    expect(upheld.json().error).toBe("appeal_outcome_on_problem");
    const noNote = await inject("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status: "no_change" });
    expect(noNote.statusCode).toBe(422);
    expect(noNote.json().error).toBe("resolution_note_required");
    const done = await inject("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status: "no_change", resolutionNote: "Checked: behaving as designed." });
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().resolvedAt).not.toBeNull();
    const again = await inject("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status: "in_review" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("feedback_already_resolved");
    // a member who is not the owner cannot answer at all
    expect((await inject("PATCH", `/v1/feedback/${id}`, users.member.auth, { status: "in_review" })).statusCode).toBe(403);
  });

  it("SoD: the person whose decision an appeal contests cannot resolve it (403, audited); someone else can", async () => {
    const p = await mkProject("sod");
    const uc = await mkUseCase("sod", p);
    // the contested decision was the ADMIN's (their trace); the use case's owner owns the appeal
    const adminTrace = await mkTrace(p, users.admin.id);
    const r = await submit(uc, "member", { kind: "appeal", body: "I was refused unfairly", traceId: adminTrace.traceId });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id as string;
    expect(r.json().ownerUserId).toBe(users.owner.id);

    const view = await inject("GET", `/v1/feedback/${id}`, users.admin.auth);
    expect(view.json().youMayResolve).toBe(false);
    expect(view.json().sodConflict).toBe("contested_decision_maker");

    const self = await inject("PATCH", `/v1/feedback/${id}`, users.admin.auth, { status: "upheld", resolutionNote: "the decision stands" });
    expect(self.statusCode, self.body).toBe(403);
    expect(self.json().error).toBe("appeal_separation_of_duties");
    const a = await lastAudit(FEEDBACK_RULE_IDS.sodRefused, id);
    expect(a!.effect).toBe("deny");
    expect(a!.userId).toBe(users.admin.id);
    const [still] = await db.select().from(useCaseFeedback).where(eq(useCaseFeedback.id, id));
    expect(still!.resolvedAt).toBeNull();

    const other = await inject("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status: "overturned", resolutionNote: "Reversed after review." });
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json().status).toBe("overturned");
  });

  it("SoD: the person who filed an appeal cannot resolve it", async () => {
    const uc = await mkUseCase("sod-filer", null, users.admin.id);
    const id = (await submit(uc, "admin", { kind: "appeal", body: "x" })).json().id as string;
    const r = await inject("PATCH", `/v1/feedback/${id}`, users.admin.auth, { status: "upheld", resolutionNote: "n" });
    expect(r.statusCode).toBe(403);
    expect(r.json().conflict).toBe("submitter");
  });
});

describe("A13 sweeps: SLA breach raises the rule; retention purges bodies", () => {
  it("the SLA sweep raises feedback_sla_breached once per breached phase, owned by the item's owner", async () => {
    const uc = await mkUseCase("sla", null);
    const id = (await submit(uc, "member", { kind: "problem", body: "x" })).json().id as string;
    const now = new Date();
    // received 4 days ago: past the 72 h acknowledgement, inside the 30 d resolution
    await db
      .update(useCaseFeedback)
      .set({ createdAt: new Date(now.getTime() - 4 * DAY), ackDueAt: new Date(now.getTime() - DAY), resolveDueAt: new Date(now.getTime() + 26 * DAY) })
      .where(eq(useCaseFeedback.id, id));
    const loaded = await feedbackMonitorInput(db, now);
    const subjectKey = `use_case:${uc}>feedback:${id}>acknowledge`;
    expect(loaded.feedback_sla_breached!.breaches.map((b) => b.subjectKey)).toContain(subjectKey);
    const breach = loaded.feedback_sla_breached!.breaches.find((b) => b.subjectKey === subjectKey)!;
    expect(breach.title).not.toMatch(/@/);

    const first = await runFeedbackSlaSweep(db, now);
    expect(first.raised).toBeGreaterThanOrEqual(1);
    const [alert] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey, subjectKey));
    expect(alert!.ruleId).toBe("feedback_sla_breached");
    expect(alert!.severity).toBe("medium");
    expect(alert!.status).toBe("open");
    expect(alert!.ownerUserId).toBe(users.owner.id);
    expect((await lastAudit(FEEDBACK_RULE_IDS.slaBreached, id))!.detail).toMatchObject({ phase: "acknowledge", alertId: alert!.id });

    const second = await runFeedbackSlaSweep(db, now);
    const alerts = await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey, subjectKey));
    expect(alerts).toHaveLength(1);
    expect(second.breached).toBeGreaterThanOrEqual(1);

    // acknowledged: the acknowledgement phase is no longer reported (the monitor resolves the episode)
    await inject("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status: "acknowledged" });
    const after = await feedbackMonitorInput(db, new Date());
    expect(after.feedback_sla_breached!.breaches.map((b) => b.subjectKey)).not.toContain(subjectKey);
  });

  it("an UNOWNED breached item (routed to the admins) is escalated to them by the alert-SLA sweep, once (integrator, S5 x A13)", async () => {
    const uc = await mkUseCase("sla-unowned", null);
    // the owner's own appeal cannot be decided by the owner: routed to the admins, no owner on the item
    const sent = await submit(uc, "owner", { kind: "appeal", body: "x" });
    expect(sent.statusCode, sent.body).toBe(201);
    const id = sent.json().id as string;
    const [item] = await db.select({ ownerUserId: useCaseFeedback.ownerUserId }).from(useCaseFeedback).where(eq(useCaseFeedback.id, id));
    expect(item!.ownerUserId).toBeNull();
    const now = new Date();
    await db
      .update(useCaseFeedback)
      .set({ createdAt: new Date(now.getTime() - 4 * DAY), ackDueAt: new Date(now.getTime() - DAY), resolveDueAt: new Date(now.getTime() + 26 * DAY) })
      .where(eq(useCaseFeedback.id, id));
    await runFeedbackSlaSweep(db, now);
    const subjectKey = `use_case:${uc}>feedback:${id}>acknowledge`;
    const [alert] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey, subjectKey));
    expect(alert!.ownerUserId).toBeNull();
    const escalations = () =>
      db.select().from(auditLog).where(and(eq(auditLog.ruleId, "governance-alert-escalated"), eq(auditLog.objectId, alert!.id)));
    expect(await escalations()).toHaveLength(0);
    await runAlertSlaSweep(db, now);
    const first = await escalations();
    expect(first).toHaveLength(1);
    expect(first[0]!.detail).toMatchObject({ reason: "unowned" });
    expect((first[0]!.detail as { recipients: string[] }).recipients).toContain(users.admin.id);
    // once: a second sweep adds nothing for this episode
    await runAlertSlaSweep(db, now);
    expect(await escalations()).toHaveLength(1);
  });

  it("the retention sweep deletes bodies and contacts past the window and keeps the resolution record", async () => {
    const uc = await mkUseCase("retention", null);
    const oldId = (await submit(uc, "member", { kind: "problem", body: "OLD-a13", contact: "old@example.com" })).json().id as string;
    const newId = (await submit(uc, "member", { kind: "problem", body: "NEW-a13" })).json().id as string;
    await inject("PATCH", `/v1/feedback/${oldId}`, users.owner.auth, { status: "no_change", resolutionNote: "Resolved long ago." });
    const now = new Date();
    const old = new Date(now.getTime() - 366 * DAY);
    await db
      .update(useCaseFeedback)
      .set({ createdAt: old, ackDueAt: new Date(old.getTime() + DAY), resolveDueAt: new Date(old.getTime() + 2 * DAY) })
      .where(eq(useCaseFeedback.id, oldId));

    const out = await runFeedbackRetentionSweep(db, now);
    expect(out.retentionDays).toBe(365);
    expect(out.purged).toBeGreaterThanOrEqual(1);
    const [o] = await db.select().from(useCaseFeedback).where(eq(useCaseFeedback.id, oldId));
    expect(o!.bodyCiphertext).toBeNull();
    expect(o!.contactCiphertext).toBeNull();
    expect(o!.bodyPurgedAt).not.toBeNull();
    expect(o!.status).toBe("no_change");
    // D4 DFX2 (D4A-07b): the kept resolution record is a data-key envelope
    expect(decryptSecret(DATA_KEY, o!.resolutionNote!)).toBe("Resolved long ago.");
    expect(o!.resolvedAt).not.toBeNull();
    const [n] = await db.select().from(useCaseFeedback).where(eq(useCaseFeedback.id, newId));
    expect(n!.bodyCiphertext).not.toBeNull();
    expect((await lastAudit(FEEDBACK_RULE_IDS.purged, oldId))!.detail).toMatchObject({ retentionDays: 365 });
    const view = await inject("GET", `/v1/feedback/${oldId}`, users.owner.auth);
    expect(view.json().body).toBeNull();
    expect(view.json().bodyUnavailable).toBe("purged");
  });
});

describe("A13 signed links: off by default, shown once, hashed, bounded, rate-limited", () => {
  it("while the setting is off (the shipped default) the public routes 404 and minting is refused", async () => {
    const uc = await mkUseCase("links-off", null);
    const settings = (await inject("GET", "/v1/org/settings", users.admin.auth)).json().settings;
    expect(settings.feedbackSignedLinksEnabled).toBe(false);
    const mint = await inject("POST", `/v1/use-cases/${uc}/feedback-links`, users.owner.auth, { expiresInDays: 7, maxUses: 5 });
    expect(mint.statusCode, mint.body).toBe(409);
    expect(mint.json().error).toBe("feedback_signed_links_disabled");
    // a link minted while on stops working the moment the setting is off
    const { token, tokenHash } = generateFeedbackLinkToken();
    await db.insert(useCaseFeedbackLinks).values({ useCaseId: uc, tokenHash, expiresAt: new Date(Date.now() + DAY), maxUses: 5 });
    expect((await inject("GET", `/v1/feedback/l/${token}`, {})).statusCode).toBe(404);
    const post = await inject("POST", `/v1/feedback/l/${token}`, {}, { kind: "problem", body: "x" });
    expect(post.statusCode).toBe(404);
    expect(await db.select().from(useCaseFeedback).where(eq(useCaseFeedback.useCaseId, uc))).toHaveLength(0);
  });

  it("on: the owner mints a link shown once and stored hashed; a submission spends a use; limits hold", async () => {
    const uc = await mkUseCase("links-on", null);
    try {
      await setFeedbackSettings({ feedbackSignedLinksEnabled: true });
      expect((await inject("POST", `/v1/use-cases/${uc}/feedback-links`, users.member.auth, { expiresInDays: 7, maxUses: 1 })).statusCode).toBe(403);
      expect((await inject("POST", `/v1/use-cases/${uc}/feedback-links`, users.owner.auth, { expiresInDays: 31, maxUses: 1 })).statusCode).toBe(400);

      const mint = await inject("POST", `/v1/use-cases/${uc}/feedback-links`, users.owner.auth, { expiresInDays: 7, maxUses: 1 });
      expect(mint.statusCode, mint.body).toBe(201);
      const { token, id: linkId } = mint.json() as { token: string; id: string };
      expect(token).toMatch(/^rglf_[0-9a-f]{64}$/);
      const [stored] = await db.select().from(useCaseFeedbackLinks).where(eq(useCaseFeedbackLinks.id, linkId));
      expect(stored!.tokenHash).toBe(hashToken(token));
      const list = await inject("GET", `/v1/use-cases/${uc}/feedback-links`, users.owner.auth);
      expect(list.body).not.toContain(token);
      expect(list.json().links[0].state).toBe("active");
      expect(JSON.stringify(await lastAudit(FEEDBACK_RULE_IDS.linkCreated, linkId))).not.toContain(token);

      const info = await inject("GET", `/v1/feedback/l/${token}`, {});
      expect(info.statusCode, info.body).toBe(200);
      expect(Object.keys(info.json()).sort()).toEqual(["bodyMaxChars", "expiresAt", "kinds", "useCaseName"]);
      expect(info.json().useCaseName).toBe(`a13 links-on ${RUN}`);

      const tooLong = await inject("POST", `/v1/feedback/l/${token}`, {}, { kind: "problem", body: "x".repeat(4001) });
      expect(tooLong.statusCode).toBe(400);
      const html = "<script>alert(1)</script> the outcome was wrong";
      const sent = await inject("POST", `/v1/feedback/l/${token}`, {}, { kind: "appeal", body: html, contact: "outside@example.com" });
      expect(sent.statusCode, sent.body).toBe(201);
      expect(sent.headers["content-type"]).toMatch(/application\/json/);
      const [row] = await db.select().from(useCaseFeedback).where(eq(useCaseFeedback.id, sent.json().reference));
      expect(row!.channel).toBe("signed_link");
      expect(row!.linkId).toBe(linkId);
      expect(row!.submitterUserId).toBeNull();
      expect(row!.ownerUserId).toBe(users.owner.id);
      // the owner reads it back verbatim, as data (the page renders text, never HTML)
      expect((await inject("GET", `/v1/feedback/${row!.id}`, users.owner.auth)).json().body).toBe(html);

      const usedUp = await inject("POST", `/v1/feedback/l/${token}`, {}, { kind: "problem", body: "again" });
      expect(usedUp.statusCode).toBe(410);
      expect(usedUp.json().error).toBe("link_used_up");

      // revoked
      const m2 = (await inject("POST", `/v1/use-cases/${uc}/feedback-links`, users.admin.auth, { expiresInDays: 1, maxUses: 10 })).json();
      const del = await inject("DELETE", `/v1/use-cases/${uc}/feedback-links/${m2.id}`, users.owner.auth);
      expect(del.statusCode, del.body).toBe(200);
      expect((await lastAudit(FEEDBACK_RULE_IDS.linkRevoked, m2.id))!.userId).toBe(users.owner.id);
      const revoked = await inject("POST", `/v1/feedback/l/${m2.token}`, {}, { kind: "problem", body: "x" });
      expect(revoked.statusCode).toBe(410);
      expect(revoked.json().error).toBe("link_revoked");

      // expired (created 10 days ago for 7 days)
      const { token: t3, tokenHash: h3 } = generateFeedbackLinkToken();
      const created10 = new Date(Date.now() - 10 * DAY);
      await db.insert(useCaseFeedbackLinks).values({ useCaseId: uc, tokenHash: h3, createdAt: created10, expiresAt: new Date(created10.getTime() + 7 * DAY), maxUses: 5 });
      const expired = await inject("GET", `/v1/feedback/l/${t3}`, {});
      expect(expired.statusCode).toBe(410);
      expect(expired.json().error).toBe("link_expired");

      // an unknown or malformed token is a plain 404
      expect((await inject("GET", `/v1/feedback/l/${generateFeedbackLinkToken().token}`, {})).statusCode).toBe(404);
      expect((await inject("GET", "/v1/feedback/l/not-a-token", {})).statusCode).toBe(404);
    } finally {
      await setFeedbackSettings({ feedbackSignedLinksEnabled: false });
    }
  });

  it("the public routes are rate-limited per address, and per link across addresses", async () => {
    const uc = await mkUseCase("links-rate", null);
    try {
      await setFeedbackSettings({ feedbackSignedLinksEnabled: true });
      const { token, tokenHash } = generateFeedbackLinkToken();
      await db.insert(useCaseFeedbackLinks).values({ useCaseId: uc, tokenHash, expiresAt: new Date(Date.now() + DAY), maxUses: 10_000 });
      const ip = freshIp();
      const codes: number[] = [];
      for (let i = 0; i < 21; i++) codes.push((await limited.inject({ method: "GET", url: `/v1/feedback/l/${token}`, remoteAddress: ip })).statusCode);
      expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
      expect(codes[20]).toBe(429);

      // per link: 60 per hour, whatever the address
      const { token: t2, tokenHash: h2 } = generateFeedbackLinkToken();
      await db.insert(useCaseFeedbackLinks).values({ useCaseId: uc, tokenHash: h2, expiresAt: new Date(Date.now() + DAY), maxUses: 10_000 });
      const linkCodes: number[] = [];
      for (let i = 0; i < 61; i++) linkCodes.push((await limited.inject({ method: "GET", url: `/v1/feedback/l/${t2}`, remoteAddress: freshIp() })).statusCode);
      expect(linkCodes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(1);
      expect(linkCodes[60]).toBe(429);
    } finally {
      await setFeedbackSettings({ feedbackSignedLinksEnabled: false });
    }
  }, 60_000);
});

describe("A13 metrics: user_report_rate and appeal_overturn_rate", () => {
  it("user_report_rate: reports per 1k finished traces; insufficient below the minimum samples", async () => {
    const p = await mkProject("metric-urr");
    const uc = await mkUseCase("metric-urr", p);
    for (let i = 0; i < 4; i++) await mkTrace(p, users.member.id);
    await submit(uc, "member", { kind: "problem", body: "x" });
    await submit(uc, "member", { kind: "appeal", body: "not a problem report" });
    const now = new Date(Date.now() + 1000);
    const spec = { metric: "user_report_rate" as const, params: {}, operator: "lte" as const, threshold: 100, windowDays: 7 };
    const low = await measureAssuranceMetric(db, { ...spec, minSamples: 10 }, { projectId: p, agentIds: [] }, now);
    expect(low.state).toBe("insufficient");
    expect(low.samples).toBe(4);
    const enough = await measureAssuranceMetric(db, { ...spec, minSamples: 4 }, { projectId: p, agentIds: [] }, now);
    expect(enough.value).toBe(250); // 1 problem / 4 traces × 1000
    expect(enough.state).toBe("fail");
    expect(enough.evidence.every((e) => e.type === "use_case_feedback")).toBe(true);
    const empty = await measureAssuranceMetric(db, { ...spec, minSamples: 1 }, { projectId: await mkProject("metric-empty"), agentIds: [] }, now);
    expect(empty.state).toBe("not_run");
  });

  it("appeal_overturn_rate: overturned share of decided appeals; insufficient below the minimum samples", async () => {
    const p = await mkProject("metric-aor");
    const uc = await mkUseCase("metric-aor", p);
    const decide = async (status: "upheld" | "overturned" | "no_change") => {
      const id = (await submit(uc, "member", { kind: "appeal", body: "x" })).json().id as string;
      const r = await inject("PATCH", `/v1/feedback/${id}`, users.owner.auth, { status, resolutionNote: "decided" });
      expect(r.statusCode, r.body).toBe(200);
    };
    await decide("upheld");
    await decide("overturned");
    await decide("no_change");
    const now = new Date(Date.now() + 1000);
    const spec = { metric: "appeal_overturn_rate" as const, params: {}, operator: "lte" as const, threshold: 25, windowDays: 30 };
    const low = await measureAssuranceMetric(db, { ...spec, minSamples: 3 }, { projectId: p, agentIds: [] }, now);
    expect(low.samples).toBe(2);
    expect(low.state).toBe("insufficient");
    const enough = await measureAssuranceMetric(db, { ...spec, minSamples: 2 }, { projectId: p, agentIds: [] }, now);
    expect(enough.value).toBe(50);
    expect(enough.state).toBe("fail");
  });
});

describe("A13 open incident: A12's contract, pre-linked, no copy of the body", () => {
  it("builds the user_report payload with a feedback link and relays A12's answer", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const linked: string[] = [];
    const out = await openIncidentFromFeedback(
      {
        createIncident: async (payload) => {
          calls.push(payload);
          return { status: 201, body: { id: "11111111-1111-4111-8111-111111111111" } };
        },
        linkIncident: async (incidentId) => {
          linked.push(incidentId);
          return true;
        },
      },
      { feedbackId: "f-1", useCaseId: "uc-1", kind: "appeal", title: "Wrong refusal", severity: "high" },
    );
    expect(out).toEqual({ status: 201, body: { feedbackId: "f-1", incidentId: "11111111-1111-4111-8111-111111111111" } });
    expect(calls[0]).toMatchObject({
      title: "Wrong refusal",
      severity: "high",
      detectionSource: "user_report",
      sourceRef: "feedback:f-1",
      useCaseId: "uc-1",
      links: [{ objectType: "feedback", objectId: "f-1" }],
    });
    expect(linked).toEqual(["11111111-1111-4111-8111-111111111111"]);
    const lost = await openIncidentFromFeedback(
      { createIncident: async () => ({ status: 201, body: { incident: { id: "x" } } }), linkIncident: async () => false },
      { feedbackId: "f-1", useCaseId: "uc-1", kind: "problem", title: "t", severity: "low" },
    );
    expect(lost.status).toBe(409);
    const refused = await openIncidentFromFeedback(
      { createIncident: async () => ({ status: 403, body: { error: "forbidden" } }), linkIncident: async () => true },
      { feedbackId: "f-1", useCaseId: "uc-1", kind: "problem", title: "t", severity: "low" },
    );
    expect(refused).toEqual({ status: 403, body: { error: "forbidden" } });
  });

  it("through the route: owner or admin only, and A12's answer is relayed (nothing linked unless it created one)", async () => {
    const uc = await mkUseCase("incident", null);
    const id = (await submit(uc, "member", { kind: "problem", body: "x" })).json().id as string;
    expect((await inject("POST", `/v1/feedback/${id}/open-incident`, users.member.auth, { title: "t", severity: "high" })).statusCode).toBe(403);
    const r = await inject("POST", `/v1/feedback/${id}/open-incident`, users.owner.auth, { title: "From feedback", severity: "high" });
    expect(r.statusCode, r.body).toBe(201);
    const [row] = await db.select().from(useCaseFeedback).where(eq(useCaseFeedback.id, id));
    const incidentId = r.json().incidentId as string;
    expect(row!.incidentId).toBe(incidentId);
    // A12's own create ran as the owner: a user_report incident on this use case, linked back to the item
    const [inc] = await db.select().from(aiIncidents).where(eq(aiIncidents.id, incidentId));
    expect(inc).toMatchObject({ detectionSource: "user_report", sourceRef: `feedback:${id}`, useCaseId: uc, createdBy: users.owner.id });
    const links = await db.select().from(aiIncidentLinks).where(eq(aiIncidentLinks.incidentId, incidentId));
    expect(links.map((l) => `${l.objectType}:${l.objectId}`)).toContain(`feedback:${id}`);
    // a second open is refused: one incident per item
    const again = await inject("POST", `/v1/feedback/${id}/open-incident`, users.owner.auth, { title: "again", severity: "high" });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("incident_already_linked");
    await db.update(useCaseFeedback).set({ incidentId: null }).where(eq(useCaseFeedback.id, id));
    // migration 0168: an incident that is not closed is never deleted — close the fixture first (test-only)
    await db.execute(sql`UPDATE ai_incidents SET status = 'closed', closed_at = now(), root_cause = 'fixture cleanup',
      lessons_learned = 'fixture cleanup' WHERE id = ${incidentId} AND status <> 'closed'`);
    await db.delete(aiIncidents).where(eq(aiIncidents.id, incidentId));
  });
});

describe("A13 routes: each with its deliberate auth class (moved here from the P0 stub table)", () => {
  const X = "22222222-2222-4222-8222-222222222222";
  const ROUTES: Array<{ method: Method; pattern: string; url: string; cls: "user" | "public" }> = [
    { method: "POST", pattern: "/v1/use-cases/:useCaseId/feedback", url: `/v1/use-cases/${X}/feedback`, cls: "user" },
    { method: "GET", pattern: "/v1/feedback", url: "/v1/feedback", cls: "user" },
    { method: "GET", pattern: "/v1/feedback/:feedbackId", url: `/v1/feedback/${X}`, cls: "user" },
    { method: "PATCH", pattern: "/v1/feedback/:feedbackId", url: `/v1/feedback/${X}`, cls: "user" },
    { method: "POST", pattern: "/v1/feedback/:feedbackId/open-incident", url: `/v1/feedback/${X}/open-incident`, cls: "user" },
    { method: "POST", pattern: "/v1/use-cases/:useCaseId/feedback-links", url: `/v1/use-cases/${X}/feedback-links`, cls: "user" },
    { method: "GET", pattern: "/v1/use-cases/:useCaseId/feedback-links", url: `/v1/use-cases/${X}/feedback-links`, cls: "user" },
    { method: "DELETE", pattern: "/v1/use-cases/:useCaseId/feedback-links/:linkId", url: `/v1/use-cases/${X}/feedback-links/${X}`, cls: "user" },
    { method: "POST", pattern: "/v1/feedback/l/:token", url: "/v1/feedback/l/synthetic-token", cls: "public" },
    { method: "GET", pattern: "/v1/feedback/l/:token", url: "/v1/feedback/l/synthetic-token", cls: "public" },
  ];
  it.each(ROUTES)("$method $pattern is classed $cls; without a credential it is 401 (user) or the link's own answer (public)", async (r) => {
    expect(routeAuthClass(r.method, r.pattern)).toBe(r.cls);
    const anon = await inject(r.method, r.url, {}, r.method === "GET" || r.method === "DELETE" ? undefined : {});
    // public: the setting is off (strict default), so the link routes answer 404 — never 401
    expect(anon.statusCode, anon.body).toBe(r.cls === "public" ? 404 : 401);
  });
});

describe("A13 the link token", () => {
  it("has 256 random bits behind its prefix and is stored as sha256(token) only", () => {
    const a = generateFeedbackLinkToken();
    const b = generateFeedbackLinkToken();
    expect(Buffer.from(a.token.slice("rglf_".length), "hex").length * 8).toBeGreaterThanOrEqual(256);
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).toBe(hashToken(a.token));
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
