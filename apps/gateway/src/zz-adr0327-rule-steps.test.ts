/**
 * ADR-0327 slice 2 — rule-like AI step detection at the gateway edge.
 *
 *  - Off by default: with no settings row the scan is refused (409) and reads still answer.
 *  - Turning it on, or lowering a threshold, needs a step-up; tightening does not. Every change is audited.
 *  - A scan finds the step whose output is a function of two input fields, ignores a free-text step, skips
 *    unstructured and truncated runs, stores a suggestion with readable lines, test cases and a projected saving, and
 *    is audited. Scans are spaced by the database clock (429 inside the window).
 *  - Dismissing is audited, idempotent-safe (a second dismiss is 404), and a later scan keeps it dismissed.
 *  - Admin-only through the default gate: a non-admin key is refused.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  inArray,
  ruleStepSettings,
  ruleStepShadows,
  ruleStepSuggestions,
  RULE_STEP_SUGGESTION_STATUSES,
  sql,
  traceSpans,
  traces,
  runMigrations,
  type Db,
} from "@regulait/db";
import { TRACE_TRUNCATION_MARKER } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { RULE_STEP_AUDIT_RULE_IDS, RULE_STEP_TRANSITIONS } from "./rule-steps.js";
import { pruneRuleStepSuggestions } from "./rule-step-retention.js";
import { induceStepRule, type StepRun } from "@regulait/optimizer-kernel";
import { induceStepRuleOffThread } from "@regulait/optimizer-kernel/offload";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0327-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const TRIAGE = `adr0327-triage-${RUN}`;
const SUMMARY = `adr0327-summary-${RUN}`;

let db: Db;
let app: ReturnType<typeof buildApp>;
let adminId: string;
let KEY: { authorization: string };
let USER_KEY: { authorization: string };
let agentId: string;
let traceId: string;
const restores: Array<() => Promise<void>> = [];
const asSession = async () => sessionRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts: { unrelated: true } }));
const asSteppedUp = async (facts: Record<string, unknown>) =>
  stepUpRequest(await grantStepUpForTest(db, adminId, { kind: "settings_relax", facts } as StepUpCheckArgs));

const SEVERITIES = ["low", "medium", "high", "critical"] as const;
const SOURCES = ["email", "portal", "phone"] as const;
const queueFor = (sev: string, src: string) => (sev === "critical" || (sev === "high" && src === "phone") ? "on-call" : sev === "low" ? "backlog" : "triage");

const auditRows = (ruleId: string) => db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  await db.delete(ruleStepSettings);
  const created = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0327-admin-${RUN}@example.com`, displayName: "rule admin", isAdmin: true } });
  expect(created.statusCode, created.body).toBe(201);
  adminId = created.json().id;
  KEY = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${adminId}/keys`, headers: AUTH, payload: { name: "adr0327" } })).json().token}` };
  const user = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0327-user-${RUN}@example.com`, displayName: "rule user" } });
  USER_KEY = { authorization: `Bearer ${(await app.inject({ method: "POST", url: `/v1/users/${user.json().id}/keys`, headers: AUTH, payload: { name: "u" } })).json().token}` };
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `adr0327-agent-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 1, model: "mock-balanced" },
  });
  expect(a.statusCode, a.body).toBe(201);
  agentId = a.json().id;

  const [t] = await db.insert(traces).values({ kind: "dispatch", name: "adr0327", userId: adminId, status: "ok" }).returning();
  traceId = t!.id;
  const spans: (typeof traceSpans.$inferInsert)[] = [];
  let seq = 0;
  for (let i = 0; i < 300; i++) {
    const sev = SEVERITIES[i % 4]!;
    const src = SOURCES[Math.floor(i / 4) % 3]!;
    const base = { traceId, kind: "llm" as const, status: "ok" as const, startedAt: new Date(), agentId, costUsd: 0.01 };
    spans.push({ ...base, seq: seq++, name: TRIAGE, inputPreview: JSON.stringify({ severity: sev, source: src, ticket: `T-${i}` }), outputPreview: queueFor(sev, src) });
    spans.push({ ...base, seq: seq++, name: SUMMARY, inputPreview: JSON.stringify({ severity: sev, source: src }), outputPreview: `summary number ${i}` });
  }
  // runs the scan must skip: an unstructured prompt, a truncated output, a withheld preview
  const skip = { traceId, kind: "llm" as const, status: "ok" as const, startedAt: new Date(), agentId, name: TRIAGE, costUsd: 0.01 };
  spans.push({ ...skip, seq: seq++, inputPreview: "please triage: severity high", outputPreview: "triage" });
  spans.push({ ...skip, seq: seq++, inputPreview: JSON.stringify({ severity: "high", source: "phone" }), outputPreview: `on-c${TRACE_TRUNCATION_MARKER}` });
  await db.insert(traceSpans).values(spans);
});

afterAll(async () => {
  await db.delete(ruleStepSuggestions).where(eq(ruleStepSuggestions.agentId, agentId));
  await db.delete(ruleStepSettings);
  if (traceId) await db.delete(traces).where(eq(traces.id, traceId));
  for (const r of restores.reverse()) await r();
  await app.close();
});

describe("ADR-0327 rule-like AI step detection", () => {
  it("is off by default: the scan is refused, reads answer", async () => {
    const s = await app.inject({ method: "GET", url: "/v1/rule-steps/settings", headers: KEY });
    expect(s.statusCode).toBe(200);
    expect(s.json()).toMatchObject({ settings: { enabled: false, minRuns: 200, minAgreement: 0.99 }, floors: { minAgreement: 0.95 } });
    const scan = await app.inject({ method: "POST", url: "/v1/rule-steps/scan", headers: KEY });
    expect(scan.statusCode).toBe(409);
    expect(scan.json().error).toBe("rule_steps_disabled");
    const list = await app.inject({ method: "GET", url: "/v1/rule-steps/suggestions", headers: KEY });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.filter((x: { agentId: string }) => x.agentId === agentId)).toEqual([]);
  });

  it("is admin-only", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/rule-steps/settings", headers: USER_KEY })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/v1/rule-steps/scan", headers: USER_KEY })).statusCode).toBe(403);
  });

  it("turning it on and lowering a threshold need a step-up; tightening does not; floors hold", async () => {
    const refused = await app.inject({ method: "PUT", url: "/v1/rule-steps/settings", ...(await asSession()), payload: { enabled: true } });
    expect([403, 422], refused.body).toContain(refused.statusCode);
    expect(refused.json().error).toMatch(/^step_up_/);
    const below = await app.inject({ method: "PUT", url: "/v1/rule-steps/settings", headers: KEY, payload: { minAgreement: 0.9 } });
    expect(below.statusCode).toBe(400);
    const tighten = await app.inject({ method: "PUT", url: "/v1/rule-steps/settings", ...(await asSession()), payload: { minAgreement: 0.995 } });
    expect(tighten.statusCode, tighten.body).toBe(200);
    const on = await app.inject({
      method: "PUT",
      url: "/v1/rule-steps/settings",
      ...(await asSteppedUp({ ruleSteps: "settings", values: { enabled: true, minAgreement: 0.99 } })),
      payload: { enabled: true, minAgreement: 0.99 },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().settings).toMatchObject({ enabled: true, minAgreement: 0.99 });
    const [audit] = await auditRows(RULE_STEP_AUDIT_RULE_IDS.settings);
    expect(audit).toMatchObject({ effect: "deny", detail: { relaxed: ["enabled", "minAgreement"] } });
  });

  it("finds the rule-like step, ignores the free-text step and skips unusable runs", async () => {
    const r = await app.inject({ method: "POST", url: "/v1/rule-steps/scan", headers: KEY });
    expect(r.statusCode, r.body).toBe(200);
    const mine = r.json().steps.filter((s: { agentId: string }) => s.agentId === agentId);
    expect(mine.find((s: { stepName: string }) => s.stepName === TRIAGE)).toMatchObject({ outcome: "rule_like" });
    expect(mine.find((s: { stepName: string }) => s.stepName === SUMMARY)).toMatchObject({ outcome: "not_rule_like", reason: "too_many_output_classes" });
    const [audit] = await auditRows(RULE_STEP_AUDIT_RULE_IDS.scan);
    expect(audit?.detail).toMatchObject({ scope: "rule_steps" });

    const list = await app.inject({ method: "GET", url: "/v1/rule-steps/suggestions", headers: KEY });
    const s = list.json().items.find((x: { agentId: string }) => x.agentId === agentId);
    expect(s).toMatchObject({ stepName: TRIAGE, fields: ["severity", "source"], evidence: { runs: 302, structuredRuns: 300, agreement: 1, coverage: 1 } });
    expect(s.ruleLines).toContain('when severity = "high" and source = "phone" -> "on-call" (25 runs)');
    expect(s.ruleLines.at(-1)).toMatch(/^otherwise -> ask the AI/);
    expect(s.testCases).toContainEqual({ input: { severity: "low", source: "email" }, expected: "backlog", support: 25 });
    // 302 runs at $0.01 over 30 days; 300 of 302 structured, all covered
    expect(s.savings.windowCostUsd).toBeCloseTo(3.02, 6);
    expect(s.savings.projectedMonthlySavingsUsd).toBeCloseTo(3.0, 6);
  });

  it("spaces scans by the database clock", async () => {
    const again = await app.inject({ method: "POST", url: "/v1/rule-steps/scan", headers: KEY });
    expect(again.statusCode).toBe(429);
    expect(again.json().error).toBe("rule_steps_scan_too_soon");
  });

  it("answers the suggestions list under the shared list contract (review #862)", async () => {
    const page = await app.inject({ method: "GET", url: "/v1/rule-steps/suggestions?count=exact&sort=detected&dir=desc&limit=10", headers: KEY });
    expect(page.statusCode, page.body).toBe(200);
    const body = page.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.total).toBeGreaterThanOrEqual(1);
    expect(body).toHaveProperty("nextCursor");
    expect((await app.inject({ method: "GET", url: "/v1/rule-steps/suggestions?bogus=1", headers: KEY })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/v1/rule-steps/suggestions?status=other", headers: KEY })).statusCode).toBe(400);
    const xlsx = await app.inject({ method: "GET", url: "/v1/rule-steps/suggestions/export.xlsx?columns=agent,step,savings", headers: KEY });
    expect(xlsx.statusCode, xlsx.body).toBe(200);
    expect(xlsx.headers["content-type"]).toMatch(/spreadsheetml/);
  });

  it("dismissing is audited and survives a later scan", async () => {
    const [row] = await db.select().from(ruleStepSuggestions).where(and(eq(ruleStepSuggestions.agentId, agentId), eq(ruleStepSuggestions.stepName, TRIAGE)));
    const d = await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${row!.id}/dismiss`, headers: KEY });
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().status).toBe("dismissed");
    expect((await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${row!.id}/dismiss`, headers: KEY })).statusCode).toBe(404);
    const [audit] = await auditRows(RULE_STEP_AUDIT_RULE_IDS.dismiss);
    expect(audit?.detail).toMatchObject({ suggestionId: row!.id });
    // move the spacing window back and scan again: the suggestion refreshes but stays dismissed
    await db.update(ruleStepSettings).set({ lastScanAt: sql`now() - interval '1 hour'` });
    expect((await app.inject({ method: "POST", url: "/v1/rule-steps/scan", headers: KEY })).statusCode).toBe(200);
    const [after] = await db.select().from(ruleStepSuggestions).where(inArray(ruleStepSuggestions.id, [row!.id]));
    expect(after?.status).toBe("dismissed");
    const dismissed = await app.inject({ method: "GET", url: "/v1/rule-steps/suggestions?status=dismissed", headers: KEY });
    expect(dismissed.json().items.map((x: { id: string }) => x.id)).toContain(row!.id);
  });
});

describe("ADR-0327 induction off the event loop (review #862)", () => {
  // a deterministic, CPU-heavy, not-rule-like history: many candidate fields, random labels
  const heavy = (): StepRun[] => {
    let x = 7;
    const rnd = () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0), x / 2 ** 32);
    return Array.from({ length: 2000 }, () => ({
      fields: Object.fromEntries(Array.from({ length: 16 }, (_, k) => [`f${k}`, Math.floor(rnd() * 6)])),
      output: rnd() < 0.5 ? "a" : "b",
    }));
  };

  it("gives the same result as the inline kernel while the event loop keeps ticking", async () => {
    const runs = heavy();
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    const off = await induceStepRuleOffThread(runs);
    clearInterval(timer);
    expect(off).toEqual(induceStepRule(runs));
    expect(ticks).toBeGreaterThan(0);
  });

  it("rejects when the worker runs past its time limit, so no partial rule is ever used", async () => {
    await expect(induceStepRuleOffThread(heavy(), {}, { timeoutMs: 1 })).rejects.toThrow(/timed out/);
  });
});

describe("ADR-0327 suggestions follow the §8.3 retention floor (slice 3)", () => {
  it("deletes a suggestion whose scan window starts before the cutoff, even one detected inside the floor (review #901)", async () => {
    const row = (stepName: string) => ({
      agentId,
      stepName,
      rule: { fields: ["severity"], cells: [{ key: ["high"], output: "on-call", support: 9 }] },
      runs: 9,
      structuredRuns: 9,
      outputClasses: 1,
      agreement: 1,
      coverage: 1,
      windowCostUsd: 0.1,
      projectedMonthlySavingsUsd: 0.1,
    });
    // a 60-day floor; the scan window is 30 days
    const cutoff = new Date(Date.now() - 60 * 86_400_000);
    const at = async (name: string, daysAgo: number) =>
      (await db
        .insert(ruleStepSuggestions)
        .values({ ...row(`${name}-${Date.now()}`), detectedAt: sql`now() - make_interval(days => ${daysAgo})` })
        .returning({ id: ruleStepSuggestions.id }))[0]!.id;
    const old = await at("retention-old", 70); // detected before the cutoff
    const straddling = await at("retention-straddling", 45); // detected inside the floor, window starts 75 days ago
    const fresh = await at("retention-fresh", 0); // window starts 30 days ago, inside the floor
    expect(await pruneRuleStepSuggestions(db, cutoff)).toBeGreaterThanOrEqual(2);
    const left = await db.select({ id: ruleStepSuggestions.id }).from(ruleStepSuggestions).where(inArray(ruleStepSuggestions.id, [old, straddling, fresh]));
    expect(left.map((x) => x.id)).toEqual([fresh]);
  });
});

describe("ADR-0327 shadow mode (slice 3b)", () => {
  const SHADOW = `adr0327-shadow-${RUN}`;
  // a deliberately simpler rule than the scan would induce, so a rewrite by a rescan is visible
  const RULE = {
    fields: ["severity"],
    cells: [
      { key: ["high"], output: "on-call", support: 9 },
      { key: ["low"], output: "backlog", support: 9 },
    ],
  };
  let suggestionId: string;
  let seq = 100_000;
  const span = (fields: Record<string, string> | string, output: string, startedAt: Date) => ({
    traceId,
    seq: seq++,
    kind: "llm" as const,
    status: "ok" as const,
    agentId,
    name: SHADOW,
    costUsd: 0.05,
    startedAt,
    inputPreview: typeof fields === "string" ? fields : JSON.stringify(fields),
    outputPreview: output,
  });
  const rescan = async () => {
    await db.update(ruleStepSettings).set({ lastScanAt: sql`now() - interval '1 hour'` });
    const r = await app.inject({ method: "POST", url: "/v1/rule-steps/scan", headers: KEY });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { shadows: Array<{ suggestionId: string; runs: number; covered: number; agreed: number }> };
  };
  const latest = async () => {
    const r = await app.inject({ method: "GET", url: "/v1/rule-steps/suggestions?status=shadow", headers: KEY });
    return (r.json().items as Array<{ id: string; fields: string[]; shadow: { runs: number; covered: number; agreed: number; agreement: number | null } | null }>).find((x) => x.id === suggestionId);
  };

  beforeAll(async () => {
    // history from before the shadow starts: rule-like on (severity, source), enough for a scan to pick the step up
    const before = new Date(Date.now() - 3600_000);
    const history = [];
    for (let i = 0; i < 220; i++) {
      const sev = SEVERITIES[i % 4]!;
      const src = SOURCES[Math.floor(i / 4) % 3]!;
      history.push(span({ severity: sev, source: src }, queueFor(sev, src), before));
    }
    await db.insert(traceSpans).values(history);
    const [s] = await db
      .insert(ruleStepSuggestions)
      .values({ agentId, stepName: SHADOW, rule: RULE, runs: 220, structuredRuns: 220, outputClasses: 2, agreement: 1, coverage: 0.5, windowCostUsd: 11, projectedMonthlySavingsUsd: 5.5 })
      .returning({ id: ruleStepSuggestions.id });
    suggestionId = s!.id;
  });

  it("starts a shadow period (audited) and refuses a second start", async () => {
    const r = await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${suggestionId}/shadow`, headers: KEY });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: "shadow", shadow: { runs: 0, covered: 0, agreed: 0, stoppedAt: null } });
    expect((await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${suggestionId}/shadow`, headers: KEY })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${suggestionId}/shadow`, headers: USER_KEY })).statusCode).toBe(403);
    // the declared lifecycle: a suggestion in shadow cannot be dismissed until its shadow is stopped
    expect((await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${suggestionId}/dismiss`, headers: KEY })).statusCode).toBe(404);
    const [audit] = await auditRows(RULE_STEP_AUDIT_RULE_IDS.shadowStarted);
    expect(audit?.detail).toMatchObject({ suggestionId });
  });

  it("measures only runs recorded after the start, keeps the rule under test frozen, and never counts a run twice", async () => {
    const after = new Date(Date.now() + 1000);
    await db.insert(traceSpans).values([
      span({ severity: "high", source: "phone" }, "on-call", after), // covered, agrees
      span({ severity: "high", source: "portal" }, " on-call ", after), // covered, agrees after normalising
      span({ severity: "high", source: "email" }, "triage", after), // covered, disagrees
      span({ severity: "low", source: "email" }, "backlog", after), // covered, agrees
      span({ severity: "medium", source: "email" }, "triage", after), // not covered
      span({ severity: "critical", source: "phone" }, "on-call", after), // not covered
      span("unstructured prompt", "triage", after), // not a structured run
    ]);
    const first = await rescan();
    expect(first.shadows.find((x) => x.suggestionId === suggestionId)).toMatchObject({ runs: 6, covered: 4, agreed: 3 });
    const v = await latest();
    expect(v?.fields).toEqual(["severity"]); // the rescan found the step rule-like and still left the row alone
    expect(v?.shadow).toMatchObject({ runs: 6, covered: 4, agreed: 3 });
    expect(v?.shadow?.agreement).toBeCloseTo(0.75, 6);
    const second = await rescan();
    expect(second.shadows.find((x) => x.suggestionId === suggestionId)).toBeUndefined();
    expect((await latest())?.shadow).toMatchObject({ runs: 6, covered: 4, agreed: 3 });
  });

  it("stopping keeps the counts, reopens the suggestion and is audited; later runs are not counted", async () => {
    const r = await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${suggestionId}/shadow/stop`, headers: KEY });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: "suggested", shadow: { runs: 6, covered: 4, agreed: 3 } });
    expect(r.json().shadow.stoppedAt).not.toBeNull();
    const [audit] = await auditRows(RULE_STEP_AUDIT_RULE_IDS.shadowStopped);
    expect(audit?.detail).toMatchObject({ suggestionId, runs: 6, covered: 4, agreed: 3 });
    expect((await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${suggestionId}/shadow/stop`, headers: KEY })).statusCode).toBe(404);
    await db.insert(traceSpans).values([span({ severity: "high", source: "phone" }, "on-call", new Date(Date.now() + 2000))]);
    const scanned = await rescan();
    expect(scanned.shadows.find((x) => x.suggestionId === suggestionId)).toBeUndefined();
    const [period] = await db.select().from(ruleStepShadows).where(eq(ruleStepShadows.suggestionId, suggestionId));
    expect(period).toMatchObject({ runs: 6, covered: 4, agreed: 3 });
  });
});

describe("ADR-0327 suggestion lifecycle is one declared table (owner rule 12)", () => {
  it("declares exactly the allowed transitions, each between known states", () => {
    expect(RULE_STEP_TRANSITIONS).toEqual({
      shadow_start: { from: "suggested", to: "shadow" },
      shadow_stop: { from: "shadow", to: "suggested" },
      dismiss: { from: "suggested", to: "dismissed" },
    });
    for (const t of Object.values(RULE_STEP_TRANSITIONS)) {
      expect(RULE_STEP_SUGGESTION_STATUSES).toContain(t.from);
      expect(RULE_STEP_SUGGESTION_STATUSES).toContain(t.to);
    }
  });
});
