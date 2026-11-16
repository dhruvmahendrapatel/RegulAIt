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
  ruleStepSuggestions,
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
import { RULE_STEP_AUDIT_RULE_IDS } from "./rule-steps.js";
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
