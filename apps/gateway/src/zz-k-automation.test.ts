/**
 * ADR-0173 batch 2c (K) — automation rules and retention holds through the
 * real routes, the real sweep and the real prune, against a real Postgres.
 * Queue and dataset actions use FAKES (the injected `AutomationActionDeps`);
 * the webhook and retention actions are real.
 *
 *  A1  every rule and hold route is admin-only; a rule needs an identity.
 *  A2  a hold above 2x the floor / 3 years, or a webhook to an inactive
 *      subscription, is refused on write (422).
 *  A3  never silent: a new rule matches nothing that ended before it existed;
 *      an explicit backfill is at most 7 days, audited, and marks its matches.
 *      Matches are unique per (rule, trace): a re-run or a rewound backfill
 *      never runs an action twice. Actions run as the rule's author.
 *  A4  a retried action runs again; the ones that succeeded do not.
 *  A5  an author who is no longer an active admin pauses the rule (audited).
 *  A6  a pass examines at most 500 traces and stops at 45 s; a rule's daily
 *      cap stops it, and the cursor resumes where it stopped.
 *  A7  the webhook action reaches only its subscription, once per match, and
 *      an inactive target is a recorded failure (automation.action.failed).
 *  A8  the retention action holds a trace within the bound; the prune skips a
 *      live hold and deletes an expired one; an erasure request releases the
 *      hold (audited) and a released hold is never re-applied.
 *  A9  late arrivals (fix round B): a flag, tag or score that lands after
 *      the trace ended is still matched within the 24 h rescan window, the
 *      SQL sample pre-filter agrees with `automationSampled`, and the window
 *      ends at 24 h.
 *  A10 the keyset scan walks migration 0151's index (EXPLAIN).
 *  A11 the production wiring carries the rule id to Q and E, kicks Q's
 *      deliveries, and signs E's (a real receiver checks the signature).
 *  A12 an erasure release is scoped to a person, never to trace ids.
 *
 * Global state: the org's default audit retention (restored), webhook
 * subscriptions, rules, holds, traces and users created here are removed in
 * afterAll (M-068).
 */
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { Webhook } from "standardwebhooks";
import {
  and,
  annotationItems,
  annotationQueues,
  auditLog,
  automationMatches,
  automationRules,
  createDb,
  egressAllowHosts,
  eq,
  evalDatasets,
  inArray,
  complianceProfiles,
  orgSettings,
  ORG_SETTINGS_ID,
  runMigrations,
  sql,
  traceEvaluations,
  traceRetentionHolds,
  traceSpans,
  traceTags,
  traces,
  users,
  webhookDeliveries,
  webhookSubscriptions,
  type Db,
} from "@regulait/db";
import { AUTOMATION_LIMITS, automationSampled, maxRetentionHoldDays } from "@regulait/shared";
import { buildApp } from "./app.js";
import {
  automationActionDeps,
  automationCandidatesQuery,
  placeRetentionHold,
  productionAutomationActionDeps,
  releaseRetentionHolds,
  runAutomationRuleSweep,
  type AutomationActionDeps,
  type AutomationActionOutcome,
} from "./automation-rules.js";
import { drainBackgroundWork } from "./background-work.js";
import { retentionFloorDays, runAuditPruneOnce } from "./org-settings.js";
import { encryptSecret } from "./secrets.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const RUN = crypto.randomBytes(3).toString("hex");
const BOOT = "k-auto-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "a".repeat(64);
const TAG = `k.auto-${RUN}`;
const DAY = 86_400_000;
type Auth = { authorization: string };

let db: Db;
let app: ReturnType<typeof buildApp>;
let admin: { id: string; auth: Auth };
let admin2: { id: string; auth: Auth };
let member: { id: string; auth: Auth };
const createdUserIds: string[] = [];
const createdRuleIds: string[] = [];
const createdSubscriptionIds: string[] = [];
const createdQueueIds: string[] = [];
const createdDatasetIds: string[] = [];
const createdEvaluationTraceIds: string[] = [];
let allowId: string | null = null;
let receiver: http.Server | null = null;
let priorRetentionDays: number | null = null;
let priorProfileRetention: Array<{ id: string; d: number }> = [];
let floorDays = 0;
let maxHold = 0;

async function makeUser(name: string, isAdmin = false) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `${name}-${RUN}@example.com`, displayName: name, isAdmin },
  });
  expect(u.statusCode, JSON.stringify(u.json())).toBe(201);
  const id = u.json().id as string;
  createdUserIds.push(id);
  const k = await app.inject({ method: "POST", url: `/v1/users/${id}/keys`, headers: AUTH, payload: { name: "k" } });
  expect(k.statusCode).toBe(201);
  return { id, auth: { authorization: `Bearer ${k.json().token}` } };
}

/** a finished trace tagged `TAG=<value>`, with one model-call span */
async function makeTrace(value: string, endedAt: Date, opts: { startedAt?: Date; userId?: string } = {}): Promise<string> {
  const startedAt = opts.startedAt ?? new Date(endedAt.getTime() - 1000);
  const [t] = await db
    .insert(traces)
    .values({ kind: "dispatch", name: `k-auto ${value} ${RUN}`, userId: opts.userId ?? member.id, status: "ok", startedAt, endedAt, durationMs: 1000 })
    .returning({ id: traces.id });
  await db.insert(traceTags).values({ traceId: t!.id, key: TAG, value });
  await db.insert(traceSpans).values({ traceId: t!.id, seq: 1, kind: "llm", name: "call", status: "ok", startedAt });
  return t!.id;
}

async function makeTraces(value: string, n: number, endedAt: Date): Promise<string[]> {
  const rows = await db
    .insert(traces)
    .values(
      Array.from({ length: n }, (_, i) => ({
        kind: "dispatch" as const,
        name: `k-auto ${value} ${i} ${RUN}`,
        userId: member.id,
        status: "ok" as const,
        startedAt: new Date(endedAt.getTime() - 1000),
        endedAt: new Date(endedAt.getTime() + i),
      })),
    )
    .returning({ id: traces.id });
  await db.insert(traceTags).values(rows.map((r) => ({ traceId: r.id, key: TAG, value })));
  return rows.map((r) => r.id);
}

interface Call {
  type: string;
  traceId: string;
  actorUserId: string;
}
function fakeDeps(opts: { datasetOutcomes?: AutomationActionOutcome[]; onQueue?: () => void } = {}) {
  const calls: Call[] = [];
  const datasetOutcomes = [...(opts.datasetOutcomes ?? [])];
  const deps: AutomationActionDeps = {
    async enqueueToQueue(_db, a) {
      calls.push({ type: "queue", traceId: a.traceId, actorUserId: a.actorUserId });
      opts.onQueue?.();
      return { ok: true };
    },
    async addToDataset(_db, a) {
      calls.push({ type: "dataset", traceId: a.traceId, actorUserId: a.actorUserId });
      return datasetOutcomes.shift() ?? { ok: true };
    },
    async sendWebhook(_db, a) {
      calls.push({ type: "webhook", traceId: a.traceId, actorUserId: a.actorUserId });
      return { ok: true };
    },
    async extendRetention(_db, a) {
      calls.push({ type: "retention", traceId: a.traceId, actorUserId: a.actorUserId });
      return { ok: true };
    },
  };
  return { deps, calls };
}

async function createRule(payload: Record<string, unknown>, auth: Auth = admin.auth) {
  const r = await app.inject({ method: "POST", url: "/v1/automation-rules", headers: auth, payload });
  if (r.statusCode === 201) createdRuleIds.push(r.json().id);
  return r;
}

const later = (ms = 60_000) => new Date(Date.now() + ms);

let restoreAdminKeyMfa: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations"));
  // ADR-0181 (FX2): an admin's API key now answers to mfaRequired. This suite
  // drives admins through keys and is not about MFA, so it relaxes the dial
  // explicitly and hands the shared database back strict in afterAll (M-068).
  restoreAdminKeyMfa = await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  await app.ready();
  admin = await makeUser("k-auto-admin", true);
  admin2 = await makeUser("k-auto-admin2", true);
  member = await makeUser("k-auto-member");
  const [prior] = await db.select({ d: orgSettings.defaultAuditRetentionDays }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  priorRetentionDays = prior?.d ?? null;
  await db.update(orgSettings).set({ defaultAuditRetentionDays: 365 }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  // The §8.3 floor is the MAX of the org default and every compliance
  // profile's retention. A profile another file left behind (CI ran one with
  // a multi-year retention) would push the floor past the 3-year hold cap and
  // make every "hold beyond the floor" refused. Pin the floor to exactly the
  // org default for this file; restored in afterAll.
  priorProfileRetention = (
    await db.select({ id: complianceProfiles.id, d: complianceProfiles.auditRetentionDays }).from(complianceProfiles)
  ).filter((p) => p.d != null) as Array<{ id: string; d: number }>;
  if (priorProfileRetention.length) {
    await db
      .update(complianceProfiles)
      .set({ auditRetentionDays: null })
      .where(inArray(complianceProfiles.id, priorProfileRetention.map((p) => p.id)));
  }
  floorDays = (await retentionFloorDays(db))!;
  expect(floorDays, "this file needs the §8.3 floor pinned to its own 365-day org default").toBe(365);
  maxHold = maxRetentionHoldDays(floorDays)!;
}, 120_000);

afterAll(async () => {
  await restoreAdminKeyMfa?.();
  await drainBackgroundWork(db);
  if (createdQueueIds.length) await db.delete(annotationQueues).where(inArray(annotationQueues.id, createdQueueIds));
  if (createdDatasetIds.length) await db.delete(evalDatasets).where(inArray(evalDatasets.id, createdDatasetIds));
  if (createdEvaluationTraceIds.length) await db.delete(traceEvaluations).where(inArray(traceEvaluations.traceId, createdEvaluationTraceIds));
  if (allowId) await db.delete(egressAllowHosts).where(eq(egressAllowHosts.id, allowId));
  if (receiver) {
    receiver.closeAllConnections();
    await new Promise<void>((r) => receiver!.close(() => r()));
  }
  await db.update(orgSettings).set({ defaultAuditRetentionDays: priorRetentionDays }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  for (const p of priorProfileRetention) {
    await db.update(complianceProfiles).set({ auditRetentionDays: p.d }).where(eq(complianceProfiles.id, p.id));
  }
  if (createdRuleIds.length) await db.delete(automationRules).where(inArray(automationRules.id, createdRuleIds));
  if (createdSubscriptionIds.length) await db.delete(webhookSubscriptions).where(inArray(webhookSubscriptions.id, createdSubscriptionIds));
  if (createdUserIds.length) {
    await db.delete(traces).where(inArray(traces.userId, createdUserIds));
    await db.delete(automationRules).where(inArray(automationRules.authorUserId, createdUserIds));
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  app.server.closeAllConnections();
  await app.close();
});

const queueRule = (value: string, extra: Record<string, unknown> = {}) => ({
  name: `k-auto ${value} ${RUN}`,
  filter: { tagKey: TAG, tagValue: value },
  actions: [{ type: "queue", queueId: crypto.randomUUID() }],
  ...extra,
});

describe("A1: admin-only, with an identity", () => {
  it("a non-admin gets 403 on every rule and hold route; the bootstrap token cannot author", async () => {
    const id = crypto.randomUUID();
    for (const [method, url, payload] of [
      ["GET", "/v1/automation-rules", undefined],
      ["POST", "/v1/automation-rules", queueRule("x")],
      ["PATCH", `/v1/automation-rules/${id}`, { status: "paused" }],
      ["DELETE", `/v1/automation-rules/${id}`, undefined],
      ["POST", `/v1/automation-rules/${id}/backfill`, { days: 1 }],
      ["GET", `/v1/automation-rules/${id}/matches`, undefined],
      ["POST", "/v1/automation-rules/sweep", {}],
      ["GET", "/v1/retention-holds", undefined],
      ["POST", "/v1/retention-holds/release", { userId: member.id, reason: "erasure", reference: "x" }],
    ] as const) {
      const r = await app.inject({ method, url, headers: member.auth, ...(payload ? { payload } : {}) });
      expect(r.statusCode, `${method} ${url}`).toBe(403);
    }
    const boot = await app.inject({ method: "POST", url: "/v1/automation-rules", headers: AUTH, payload: queueRule("x") });
    expect(boot.statusCode).toBe(403);
    expect(boot.json().error).toBe("identity_required");
  });
});

describe("A2: refused on write", () => {
  it("a hold above min(2x floor, 3 years) and a webhook to an inactive subscription are 422", async () => {
    expect(maxHold).toBe(Math.min(2 * floorDays, 1095));
    const over = await createRule(queueRule("x", { actions: [{ type: "retention", days: maxHold + 1 }] }));
    if (maxHold < 1095) {
      expect(over.statusCode).toBe(422);
      expect(over.json()).toMatchObject({ error: "hold_exceeds_bound", maxDays: maxHold });
    }
    // three years is a bound whatever the floor
    expect((await createRule(queueRule("x", { actions: [{ type: "retention", days: 1096 }] }))).statusCode).toBe(400);
    const [sub] = await db
      .insert(webhookSubscriptions)
      .values({ name: `k-auto off ${RUN}`, url: "https://hooks.example.test/off", secretCiphertext: encryptSecret(DATA_KEY, "whsec_x"), active: false })
      .returning({ id: webhookSubscriptions.id });
    createdSubscriptionIds.push(sub!.id);
    const off = await createRule(queueRule("x", { actions: [{ type: "webhook", subscriptionId: sub!.id }] }));
    expect(off.statusCode).toBe(422);
    expect(off.json().error).toBe("webhook_target_inactive");
  });
});

describe("A3: never silent; unique matches; actions run as the author", () => {
  it("matches only what ended after creation, then an explicit backfill, never twice", async () => {
    const old = await makeTrace("a", new Date(Date.now() - 3_600_000));
    const r = await createRule(queueRule("a", { actions: [{ type: "queue", queueId: crypto.randomUUID() }, { type: "dataset", datasetId: crypto.randomUUID() }] }));
    expect(r.statusCode).toBe(201);
    const ruleId = r.json().id as string;
    const fresh = [await makeTrace("a", later(1000)), await makeTrace("a", later(2000)), await makeTrace("a", later(3000))];
    const { deps, calls } = fakeDeps();

    const p1 = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p1.matched).toBe(3);
    expect(calls.filter((c) => c.type === "queue").map((c) => c.traceId).sort()).toEqual([...fresh].sort());
    expect(calls.every((c) => c.actorUserId === admin.id)).toBe(true);

    const p2 = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p2.matched).toBe(0);
    expect(calls).toHaveLength(6);

    expect((await app.inject({ method: "POST", url: `/v1/automation-rules/${ruleId}/backfill`, headers: admin.auth, payload: { days: 8 } })).statusCode).toBe(400);
    const bf = await app.inject({ method: "POST", url: `/v1/automation-rules/${ruleId}/backfill`, headers: admin.auth, payload: { days: 1 } });
    expect(bf.statusCode).toBe(200);
    expect(bf.json().rewound).toBe(true);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, ruleId), eq(auditLog.ruleId, "automation-rule-backfill")));
    expect(audit?.detail).toMatchObject({ days: 1, rewound: true });

    const p3 = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p3.matched).toBe(1); // only the old trace: the rewound window re-reads the fresh ones without re-running anything
    expect(calls.filter((c) => c.type === "queue")).toHaveLength(4);
    const matches = await app.inject({ method: "GET", url: `/v1/automation-rules/${ruleId}/matches`, headers: admin.auth });
    const list = matches.json().matches as Array<{ traceId: string; backfill: boolean; status: string }>;
    expect(list).toHaveLength(4);
    expect(list.filter((m) => m.backfill).map((m) => m.traceId)).toEqual([old]);
    expect(list.every((m) => m.status === "done")).toBe(true);
  });
});

describe("A4: a retried action does not duplicate", () => {
  it("re-runs only the failed action, until it succeeds", async () => {
    const r = await createRule(queueRule("b", { actions: [{ type: "queue", queueId: crypto.randomUUID() }, { type: "dataset", datasetId: crypto.randomUUID() }] }));
    const ruleId = r.json().id as string;
    await makeTrace("b", later(1000));
    const { deps, calls } = fakeDeps({ datasetOutcomes: [{ ok: false, reason: "internal_error", retryable: true }] });
    const t0 = Date.now();
    await runAutomationRuleSweep(db, deps, { ruleId, now: new Date(t0 + 60_000) });
    const [m1] = await db.select().from(automationMatches).where(eq(automationMatches.ruleId, ruleId));
    expect(m1?.status).toBe("retry");
    expect(calls.map((c) => c.type)).toEqual(["queue", "dataset"]);

    // inside the lease nothing is retried
    await runAutomationRuleSweep(db, deps, { ruleId, now: new Date(t0 + 120_000) });
    expect(calls).toHaveLength(2);

    const p = await runAutomationRuleSweep(db, deps, { ruleId, now: new Date(t0 + 10 * 60_000) });
    expect(p.retried).toBe(1);
    expect(calls.map((c) => c.type)).toEqual(["queue", "dataset", "dataset"]);
    const [m2] = await db.select().from(automationMatches).where(eq(automationMatches.ruleId, ruleId));
    expect(m2?.status).toBe("done");
    expect(m2?.actionResults).toEqual([
      { type: "queue", status: "ok", reason: null, attempts: 1, retryable: false },
      { type: "dataset", status: "ok", reason: null, attempts: 2, retryable: false },
    ]);
    await runAutomationRuleSweep(db, deps, { ruleId, now: new Date(t0 + 20 * 60_000) });
    expect(calls).toHaveLength(3);
  });
});

describe("A5: the author must stay an active admin", () => {
  it("pauses (audited) instead of acting as somebody else; a resume takes authorship", async () => {
    const r = await createRule(queueRule("c"), admin2.auth);
    const ruleId = r.json().id as string;
    await makeTrace("c", later(1000));
    await db.update(users).set({ isAdmin: false }).where(eq(users.id, admin2.id));
    const { deps, calls } = fakeDeps();
    const p = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p.paused).toEqual([ruleId]);
    expect(calls).toHaveLength(0);
    const [rule] = await db.select().from(automationRules).where(eq(automationRules.id, ruleId));
    expect(rule).toMatchObject({ status: "paused", pausedReason: "author_not_admin" });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, ruleId), eq(auditLog.ruleId, "automation-rule-paused")));
    expect(audit).toMatchObject({ effect: "deny" });
    expect(audit?.detail).toMatchObject({ reason: "author_not_admin", authorUserId: admin2.id, automatic: true });

    const resume = await app.inject({ method: "PATCH", url: `/v1/automation-rules/${ruleId}`, headers: admin.auth, payload: { status: "active" } });
    expect(resume.statusCode).toBe(200);
    expect(resume.json().author.id).toBe(admin.id);
    await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(calls.map((c) => c.actorUserId)).toEqual([admin.id]);
  });
});

describe("A6: pass and daily caps", () => {
  it("a pass examines at most 500 traces and resumes where it stopped", async () => {
    const r = await createRule(queueRule("d", { samplingRate: 0 }));
    const ruleId = r.json().id as string;
    await makeTraces("d", 505, later(1000));
    const { deps } = fakeDeps();
    const p1 = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p1).toMatchObject({ examined: 500, matched: 0, truncated: true });
    const p2 = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p2).toMatchObject({ examined: 5, truncated: false });
  });

  it("a pass stops after 45 s and the next one picks up the rest", async () => {
    const r = await createRule(queueRule("e"));
    const ruleId = r.json().id as string;
    await makeTraces("e", 3, later(1000));
    let t = 0;
    const { deps, calls } = fakeDeps({ onQueue: () => (t += 46_000) });
    const p1 = await runAutomationRuleSweep(db, deps, { ruleId, now: later(), clock: () => t });
    expect(p1).toMatchObject({ matched: 1, truncated: true });
    const p2 = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p2.matched).toBe(2);
    expect(new Set(calls.map((c) => c.traceId)).size).toBe(3);
  });

  it("a rule's daily cap stops it until the next UTC day", async () => {
    const r = await createRule(queueRule("f", { dailyActionCap: 2 }));
    const ruleId = r.json().id as string;
    await makeTraces("f", 3, later(1000));
    const { deps, calls } = fakeDeps();
    const now = later();
    const p1 = await runAutomationRuleSweep(db, deps, { ruleId, now });
    expect(p1).toMatchObject({ matched: 2, capped: [ruleId] });
    const p2 = await runAutomationRuleSweep(db, deps, { ruleId, now });
    expect(p2).toMatchObject({ matched: 0, capped: [ruleId] });
    const p3 = await runAutomationRuleSweep(db, deps, { ruleId, now: new Date(now.getTime() + DAY) });
    expect(p3.matched).toBe(1);
    expect(new Set(calls.map((c) => c.traceId)).size).toBe(3);
  });
});

describe("A7: the webhook action", () => {
  it("reaches its subscription once per match; an inactive target is a recorded failure", async () => {
    const secret = encryptSecret(DATA_KEY, "whsec_" + Buffer.from("k".repeat(32)).toString("base64"));
    const [fan] = await db
      .insert(webhookSubscriptions)
      .values({ name: `k-auto fan ${RUN}`, url: "https://hooks.example.test/fan", secretCiphertext: secret, events: ["automation.*"] })
      .returning({ id: webhookSubscriptions.id });
    const [only] = await db
      .insert(webhookSubscriptions)
      .values({ name: `k-auto only ${RUN}`, url: "https://hooks.example.test/only", secretCiphertext: secret, events: [] })
      .returning({ id: webhookSubscriptions.id });
    createdSubscriptionIds.push(fan!.id, only!.id);
    const deps = automationActionDeps({ dataKey: DATA_KEY });

    const toFan = (await createRule(queueRule("g1", { actions: [{ type: "webhook", subscriptionId: fan!.id }] }))).json().id as string;
    const toOnly = (await createRule(queueRule("g2", { actions: [{ type: "webhook", subscriptionId: only!.id }] }))).json().id as string;
    await makeTrace("g1", later(1000));
    await makeTrace("g2", later(1000));
    await runAutomationRuleSweep(db, deps, { ruleId: toFan, now: later() });
    await runAutomationRuleSweep(db, deps, { ruleId: toOnly, now: later() });
    const deliveries = async (subId: string) =>
      (await db.select({ event: webhookDeliveries.event, payload: webhookDeliveries.payload }).from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, subId)))
        .filter((d) => d.event === "automation.matched")
        .map((d) => d.payload["ruleId"]);
    // the fan-out subscription gets each match once (its own rule's webhook action does not add a second)
    expect((await deliveries(fan!.id)).sort()).toEqual([toFan, toOnly].sort());
    // the other subscription selects nothing, so it gets only its rule's
    expect(await deliveries(only!.id)).toEqual([toOnly]);

    await db.update(webhookSubscriptions).set({ active: false }).where(eq(webhookSubscriptions.id, only!.id));
    await makeTrace("g2", later(2000));
    const p = await runAutomationRuleSweep(db, deps, { ruleId: toOnly, now: later() });
    expect(p.actionsFailed).toBe(1);
    const failed = await db.select().from(automationMatches).where(and(eq(automationMatches.ruleId, toOnly), eq(automationMatches.status, "failed")));
    expect(failed[0]?.actionResults[0]).toMatchObject({ type: "webhook", status: "failed", reason: "target_inactive", retryable: false });
    const failures = (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, fan!.id))).filter((d) => d.event === "automation.action.failed");
    expect(failures.map((d) => d.payload)).toEqual([
      expect.objectContaining({ ruleId: toOnly, action: "webhook", reason: "target_inactive", attempts: 1 }),
    ]);
    expect(JSON.stringify(failures[0]!.payload)).not.toMatch(/error|stack/i);
  });
});

describe("A8: retention holds", () => {
  it("the action holds within the bound, as the author", async () => {
    const ruleId = (await createRule(queueRule("h", { actions: [{ type: "retention", days: maxHold }] }))).json().id as string;
    const traceId = await makeTrace("h", later(1000));
    const p = await runAutomationRuleSweep(db, automationActionDeps({ dataKey: DATA_KEY }), { ruleId, now: later() });
    expect(p.actionsOk).toBe(1);
    const [hold] = await db.select().from(traceRetentionHolds).where(eq(traceRetentionHolds.traceId, traceId));
    const [t] = await db.select({ startedAt: traces.startedAt }).from(traces).where(eq(traces.id, traceId));
    expect(hold?.holdUntil.getTime()).toBe(t!.startedAt.getTime() + maxHold * DAY);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, traceId), eq(auditLog.ruleId, "trace-retention-extended")));
    expect(audit?.userId).toBe(admin.id);
  });

  it("the prune skips a live hold, deletes an expired one, and erasure releases a hold (audited, never re-applied)", async () => {
    const old = new Date(Date.now() - (floorDays + 30) * DAY);
    const held = await makeTrace("i", old, { startedAt: old });
    const unheld = await makeTrace("i", old, { startedAt: old });
    const expired = await makeTrace("i", old, { startedAt: old });
    const now = new Date();
    expect(await placeRetentionHold(db, { traceId: held, days: maxHold + 1, ruleId: null, actorUserId: admin.id, now })).toMatchObject({
      ok: false,
      reason: "hold_exceeds_bound",
    });
    expect(await placeRetentionHold(db, { traceId: held, days: floorDays + 60, ruleId: null, actorUserId: admin.id, now })).toMatchObject({ ok: true });
    await db.insert(traceRetentionHolds).values({ traceId: expired, holdUntil: new Date(Date.now() - DAY), createdByUserId: admin.id });

    await runAuditPruneOnce(db, admin.id, false);
    const left = async () =>
      (await db.select({ id: traces.id }).from(traces).where(inArray(traces.id, [held, unheld, expired]))).map((r) => r.id);
    expect(await left()).toEqual([held]);

    const rel = await app.inject({
      method: "POST",
      url: "/v1/retention-holds/release",
      headers: admin.auth,
      payload: { userId: member.id, reason: "erasure", reference: `DSR-${RUN}` },
    });
    expect(rel.statusCode).toBe(200);
    expect(rel.json().traceIds).toContain(held);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, held), eq(auditLog.ruleId, "trace-retention-hold-released")));
    expect(audit).toMatchObject({ userId: admin.id });
    expect(audit?.detail).toMatchObject({ reason: "erasure", reference: `DSR-${RUN}`, subjectUserId: member.id });
    expect(await placeRetentionHold(db, { traceId: held, days: floorDays + 60, ruleId: null, actorUserId: admin.id, now })).toEqual({
      ok: false,
      reason: "erasure_released",
    });
    await runAuditPruneOnce(db, admin.id, false);
    expect(await left()).toEqual([]);
  });
});

/** the ADR-0160 flag on a trace, landing whenever the test says (it has no FK; afterAll removes it) */
async function flag(...traceIds: string[]) {
  createdEvaluationTraceIds.push(...traceIds);
  await db
    .insert(traceEvaluations)
    .values(traceIds.map((traceId) => ({ spanId: crypto.randomUUID(), traceId, spanStartedAt: new Date(), outcome: "evaluated" as const, flagged: true })));
}
const flaggedRule = (value: string, extra: Record<string, unknown> = {}) =>
  queueRule(value, { filter: { tagKey: TAG, tagValue: value, flagged: true }, ...extra });

describe("A9: late arrivals (a flag, tag or score that lands after the trace ended)", () => {
  it("T1 ends, T2 ends flagged, the pass matches T2; T1 flagged later is matched on the next pass", async () => {
    const ruleId = (await createRule(flaggedRule("late"))).json().id as string;
    const t1 = await makeTrace("late", later(1000));
    const t2 = await makeTrace("late", later(2000));
    await flag(t2);
    const { deps, calls } = fakeDeps();
    const p1 = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p1.matched).toBe(1);
    expect(calls.map((c) => c.traceId)).toEqual([t2]);

    await flag(t1); // the cursor is already past T1
    const p2 = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p2.matched).toBe(1);
    expect(calls.map((c) => c.traceId)).toEqual([t2, t1]);
    const [m] = await db.select().from(automationMatches).where(and(eq(automationMatches.ruleId, ruleId), eq(automationMatches.traceId, t1)));
    expect(m).toMatchObject({ backfill: false, status: "done" });

    // a matched trace drops out of the rescan: nothing is examined, nothing runs twice
    const p3 = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p3).toMatchObject({ matched: 0, examined: 0 });
    expect(calls).toHaveLength(2);
  });

  it("the rescan reaches back 24 hours and no further", async () => {
    const base = Date.now();
    const ruleId = (await createRule(flaggedRule("late24"))).json().id as string;
    const t = await makeTrace("late24", new Date(base + 1000));
    const marker = await makeTrace("late24", new Date(base + 2000));
    await flag(marker);
    const { deps, calls } = fakeDeps();
    // the pass matches the flagged marker, so the cursor is past T
    expect((await runAutomationRuleSweep(db, deps, { ruleId, now: new Date(base + 60_000) })).matched).toBe(1);
    await flag(t);
    const h = AUTOMATION_LIMITS.lateArrivalWindowHours * 3_600_000;
    expect(AUTOMATION_LIMITS.lateArrivalWindowHours).toBe(24);
    const past = await runAutomationRuleSweep(db, deps, { ruleId, now: new Date(base + 1000 + h + 60_000) });
    expect(past.matched).toBe(0);
    const inside = await runAutomationRuleSweep(db, deps, { ruleId, now: new Date(base + h - 60_000) });
    expect(inside.matched).toBe(1);
    expect(calls.map((c) => c.traceId)).toEqual([marker, t]);
  });

  it("the SQL sample pre-filter agrees with automationSampled, so unsampled traces are never re-read", async () => {
    const ruleId = (await createRule(flaggedRule("late-s", { samplingRate: 0.5 }))).json().id as string;
    const ids = await makeTraces("late-s", 60, later(1000));
    // a flagged trace after them moves the cursor past all 60 (sampled in or not)
    const marker = await makeTrace("late-s", later(5000));
    await flag(marker);
    const { deps, calls } = fakeDeps();
    const p0 = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    expect(p0.examined).toBe(1);
    calls.length = 0;
    await flag(...ids);
    const p = await runAutomationRuleSweep(db, deps, { ruleId, now: later() });
    const expected = ids.filter((id) => automationSampled(ruleId, id, 0.5));
    expect(expected.length).toBeGreaterThan(10);
    expect(expected.length).toBeLessThan(50);
    expect(calls.map((c) => c.traceId).sort()).toEqual([...expected].sort());
    expect(p.examined).toBe(expected.length);
  });
});

describe("A10: the keyset scan walks migration 0151's index", () => {
  it("EXPLAIN: the cursor compare and the ORDER BY use traces_ended_ms_id_idx, with no sort", async () => {
    const q = automationCandidatesQuery(db, { cursorEndedAt: new Date(), cursorTraceId: null }, {}, later(), 500);
    const plan = await db.transaction(async (tx) => {
      // on a small test table the planner would rightly prefer a seq scan or a
      // bitmap scan and a sort; this asks whether the index CAN serve both the
      // compare and the order, i.e. that the expressions match exactly
      await tx.execute(sql`set local enable_seqscan = off`);
      await tx.execute(sql`set local enable_bitmapscan = off`);
      const r = await tx.execute(sql`explain (format json) ${q}`);
      return JSON.stringify(r.rows);
    });
    expect(plan).toContain("traces_ended_ms_id_idx");
    expect(plan).toMatch(/"Index Cond":"\(ROW\(date_trunc/);
    expect(plan).not.toMatch(/"Node Type":"(Incremental )?Sort"/);
  });
});

describe("A11: the production wiring", () => {
  it("Q's item and audit row carry the rule id; Q's and E's deliveries are kicked and signed", async () => {
    const hits: Array<{ headers: Record<string, string>; body: string }> = [];
    receiver = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [h, v] of Object.entries(req.headers)) if (typeof v === "string") headers[h] = v;
        hits.push({ headers, body: raw });
        res.writeHead(204);
        res.end();
      });
    });
    await new Promise<void>((r) => receiver!.listen(0, "127.0.0.1", r));
    const port = (receiver.address() as { port: number }).port;
    const [existing] = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
    if (existing) {
      // another file's entry: use it as it is, and never delete what is not ours
      expect(existing.allowPrivateRanges && existing.allowPlaintextHttp).toBe(true);
    } else {
      const [row] = await db
        .insert(egressAllowHosts)
        .values({ host: "127.0.0.1", allowPrivateRanges: true, allowPlaintextHttp: true, note: "k-auto test receiver" })
        .returning();
      allowId = row!.id;
    }
    const sub = await app.inject({
      method: "POST",
      url: "/v1/webhooks",
      headers: admin.auth,
      payload: { name: `k-auto rcv ${RUN}`, url: `http://127.0.0.1:${port}/hook`, events: ["trace.queued", "trace.added_to_dataset"], allowPlaintextHttp: true },
    });
    expect(sub.statusCode, sub.body).toBe(201);
    const subId = sub.json().id as string;
    createdSubscriptionIds.push(subId);
    const queue = await app.inject({
      method: "POST",
      url: "/v1/annotation-queues",
      headers: admin.auth,
      payload: { name: `k-auto q ${RUN}`, rubric: { criteria: [{ name: "helpfulness", kind: "score", min: 1, max: 5, step: 1 }] }, reviewerUserIds: [admin.id] },
    });
    expect(queue.statusCode, queue.body).toBe(201);
    const queueId = queue.json().id as string;
    createdQueueIds.push(queueId);
    const ds = await app.inject({
      method: "POST",
      url: "/v1/evals/datasets",
      headers: admin.auth,
      payload: { name: `k-auto ds ${RUN}`, scorerKind: "contains", scorerConfig: { needles: ["ok"] } },
    });
    expect(ds.statusCode, ds.body).toBe(201);
    const datasetId = ds.json().id as string;
    createdDatasetIds.push(datasetId);

    const ruleId = (
      await createRule(queueRule("wire", { actions: [{ type: "queue", queueId }, { type: "dataset", datasetId }] }))
    ).json().id as string;
    const traceId = await makeTrace("wire", later(1000));
    await db.update(traceSpans).set({ inputPreview: "is it ok?", outputPreview: "ok" }).where(eq(traceSpans.traceId, traceId));

    const p = await runAutomationRuleSweep(db, productionAutomationActionDeps(DATA_KEY), { ruleId, now: later() });
    expect(p).toMatchObject({ matched: 1, actionsOk: 2, actionsFailed: 0 });
    await drainBackgroundWork(db);

    const [item] = await db.select().from(annotationItems).where(and(eq(annotationItems.queueId, queueId), eq(annotationItems.traceId, traceId)));
    expect(item?.ruleId).toBe(ruleId);
    const [qAudit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, queueId), eq(auditLog.ruleId, "annotation-items-queued")));
    expect(qAudit).toMatchObject({ userId: admin.id });
    expect(qAudit?.detail).toMatchObject({ automationRuleId: ruleId, added: 1 });
    const [eAudit] = await db.select().from(auditLog).where(and(eq(auditLog.objectId, datasetId), eq(auditLog.ruleId, "eval-dataset-from-traces")));
    expect(eAudit?.detail).toMatchObject({ ruleId, added: 1 });

    // both deliveries went out on their first attempt (kicked, signed, not spent on a missing key)
    const deliveries = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.subscriptionId, subId));
    expect(deliveries.map((d) => [d.event, d.status, d.attempts]).sort()).toEqual([
      ["trace.added_to_dataset", "delivered", 1],
      ["trace.queued", "delivered", 1],
    ]);
    expect(deliveries.every((d) => d.payload["ruleId"] === ruleId)).toBe(true);
    expect(hits).toHaveLength(2);
    const wh = new Webhook(sub.json().secret as string);
    for (const h of hits) expect(() => wh.verify(h.body, h.headers)).not.toThrow();
  });
});

describe("A12: an erasure release is scoped to a person", () => {
  it("erasure naming trace ids is refused; an admin release may name traces", async () => {
    const old = new Date(Date.now() - DAY);
    const a = await makeTrace("rel", old, { startedAt: old });
    const b = await makeTrace("rel", old, { startedAt: old });
    for (const t of [a, b]) {
      expect(await placeRetentionHold(db, { traceId: t, days: floorDays + 1, ruleId: null, actorUserId: admin.id, now: new Date() })).toMatchObject({ ok: true });
    }
    const release = (payload: Record<string, unknown>) =>
      app.inject({ method: "POST", url: "/v1/retention-holds/release", headers: admin.auth, payload });
    expect((await release({ traceIds: [a], reason: "erasure", reference: `E-${RUN}` })).statusCode).toBe(400);
    expect((await release({ userId: member.id, traceIds: [a], reason: "erasure", reference: `E-${RUN}` })).statusCode).toBe(400);
    expect((await release({ userId: member.id, traceIds: [a], reason: "admin", reference: `E-${RUN}` })).statusCode).toBe(400);
    await expect(
      releaseRetentionHolds(db, { reason: "erasure", traceIds: [a], reference: "x", actorUserId: admin.id } as unknown as Parameters<typeof releaseRetentionHolds>[1]),
    ).rejects.toThrow(/person/);
    const live = async () =>
      (await db.select().from(traceRetentionHolds).where(inArray(traceRetentionHolds.traceId, [a, b])))
        .filter((h) => h.releasedAt === null)
        .map((h) => h.traceId);
    expect((await live()).sort()).toEqual([a, b].sort());

    const byTrace = await release({ traceIds: [a], reason: "admin", reference: `T-${RUN}` });
    expect(byTrace.statusCode).toBe(200);
    expect(byTrace.json()).toEqual({ released: 1, traceIds: [a] });
    expect(await live()).toEqual([b]);
  });
});
