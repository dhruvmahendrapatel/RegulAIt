import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  costEvents,
  createDb,
  desc,
  eq,
  ruleStepSuggestions,
  ruleStepSwitches,
  runMigrations,
  traceSpans,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { NOT_RULE_SERVED_SPAN, ruleStepRuleDigest } from "./rule-step-serve.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";

/**
 * ADR-0327 slice 4c — a switched rule-like step is answered by its approved rule on the native invoke path.
 *
 * The evidence for "the rule answered" is NO PROVIDER CALL: a usage_events delta of zero, paired with a delta of one
 * on every call the AI must answer, so a zero can never be the zero of a call that failed for another reason (M-033).
 * The switch itself (request, approval, revert) is slice 4a's and is tested there; here the switched state is set up
 * directly so each refusal to serve can be shown on its own.
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0327-native-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const RULE = {
  fields: ["severity"],
  cells: [
    { key: ["high"], output: "on-call", support: 9 },
    { key: ["low"], output: "backlog", support: 9 },
  ],
};
const OTHER_RULE = { fields: ["severity"], cells: [{ key: ["high"], output: "page-everyone", support: 9 }] };

let db: Db;
let app: ReturnType<typeof buildApp>;
let userId: string;
let auth: { authorization: string };
let agentId: string;
let suggestionId: string;
let switchId: string;
let restoreGates: () => Promise<void> = async () => {};

const usageCount = async () => (await db.select().from(usageEvents).where(eq(usageEvents.userId, userId))).length;
const ruleSavings = async () =>
  db.select().from(costEvents).where(and(eq(costEvents.userId, userId), eq(costEvents.technique, "rule_replacement")));
const latestSpan = async () =>
  (await db.select().from(traceSpans).where(and(eq(traceSpans.agentId, agentId), eq(traceSpans.kind, "llm"))).orderBy(desc(traceSpans.startedAt)).limit(1))[0]!;

function ask(text: string, extra: Record<string, unknown> = {}) {
  return app.inject({
    method: "POST",
    url: `/v1/agents/${agentId}/invoke`,
    headers: auth,
    payload: { mode: "execute", dispatch: true, input: text, ...extra },
  });
}

/** One call the rule must answer: no provider call, one saving, the rule's output. */
async function expectRuleAnswer(text: string, output: string) {
  const usage = await usageCount();
  const savings = (await ruleSavings()).length;
  const r = await ask(text);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().dispatch.outputText).toBe(output);
  expect(r.json().dispatch.costUsd).toBe(0);
  expect(await usageCount()).toBe(usage);
  expect((await ruleSavings()).length).toBe(savings + 1);
}

/** One call the AI must answer: exactly one provider call, no rule saving. */
async function expectAiAnswer(text: string, extra: Record<string, unknown> = {}) {
  const usage = await usageCount();
  const savings = (await ruleSavings()).length;
  const r = await ask(text, extra);
  expect(r.statusCode, r.body).toBe(200);
  expect(await usageCount()).toBe(usage + 1);
  expect((await ruleSavings()).length).toBe(savings);
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "f".repeat(64) });
  restoreGates = await relaxGovernanceGatesForTest(db, {
    mrmEnforced: false,
    dispatchAttributionRequired: false,
    useCaseGateMode: "off",
    requireProjectAttribution: false,
  });
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `adr0327-native-${RUN}@example.com`, displayName: "Serve" } });
  userId = u.json().id;
  const k = await app.inject({ method: "POST", url: `/v1/users/${userId}/keys`, headers: AUTH, payload: { name: "serve" } });
  auth = { authorization: `Bearer ${k.json().token}` };
  const ag = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `adr0327-native-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: `adr0327-native-model-${RUN}` },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  agentId = ag.json().id;
  await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId, agentId } });

  // the step a compat call to this agent is recorded as: the served agent's name
  const [s] = await db
    .insert(ruleStepSuggestions)
    .values({ agentId, stepName: `adr0327-native-${RUN}`, rule: RULE, runs: 200, structuredRuns: 200, outputClasses: 2, agreement: 1, coverage: 1, windowCostUsd: 4, projectedMonthlySavingsUsd: 2, status: "switched" })
    .returning({ id: ruleStepSuggestions.id });
  suggestionId = s!.id;
  const [w] = await db
    .insert(ruleStepSwitches)
    .values({ suggestionId, ruleSha256: ruleStepRuleDigest(RULE), status: "switched", decidedAt: new Date() })
    .returning({ id: ruleStepSwitches.id });
  switchId = w!.id;
});

afterAll(async () => {
  if (agentId) await db.delete(ruleStepSuggestions).where(eq(ruleStepSuggestions.agentId, agentId));
  await restoreGates();
  await app.close();
});

describe("ADR-0327 slice 4c: a switched step is answered by its rule on the invoke path", () => {
  it("a covered input is answered by the rule: no provider call, a rule_replacement saving, an audited decision", async () => {
    await expectRuleAnswer(JSON.stringify({ severity: "high", ticket: 7 }), "on-call");
    const [saving] = (await ruleSavings()).slice(-1);
    // the step's measured average AI cost per run: 4 USD over 200 runs
    expect(saving!.estimatedCostSavedUsd).toBe(0.02);
    expect(saving!.detail).toMatchObject({ suggestionId, switchId, surface: "invoke" });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.userId, userId), eq(auditLog.objectId, agentId))).orderBy(desc(auditLog.at)).limit(1);
    expect(audit!.detail).toMatchObject({ ruleStep: { suggestionId, switchId }, servedAgentId: agentId });
  });

  it("the rule-served span is marked, carries no cache claim, and is not an AI run for detection or shadow", async () => {
    await expectRuleAnswer(JSON.stringify({ severity: "low" }), "backlog");
    const span = await latestSpan();
    expect(span.attributes).toMatchObject({ ruleStep: { suggestionId, switchId } });
    expect(span.attributes).not.toHaveProperty("semanticCache");
    await expectAiAnswer(JSON.stringify({ severity: "medium" }));
    const ai = await latestSpan();
    const aiRuns = await db
      .select({ id: traceSpans.id })
      .from(traceSpans)
      .where(and(eq(traceSpans.agentId, agentId), eq(traceSpans.kind, "llm"), NOT_RULE_SERVED_SPAN));
    const ids = aiRuns.map((r) => r.id);
    expect(ids).toContain(ai.id);
    expect(ids).not.toContain(span.id);
  });

  it("an input the rule does not cover, a non-JSON input, a system prompt and reference content go to the AI", async () => {
    await expectAiAnswer(JSON.stringify({ severity: "medium" }));
    await expectAiAnswer("severity is high, who handles it?");
    await expectAiAnswer(JSON.stringify({ severity: "high" }), { system: "answer as the incident commander" });
    await expectAiAnswer(JSON.stringify({ severity: "high" }), { referenceContent: "the on-call rota for this week" });
  });

  it("a passthrough user keeps every AI call", async () => {
    const off = await app.inject({ method: "POST", url: `/v1/users/${userId}/agent-policy`, headers: AUTH, payload: { routingMode: "passthrough" } });
    expect(off.statusCode, off.body).toBeLessThan(300);
    try {
      await expectAiAnswer(JSON.stringify({ severity: "high" }));
    } finally {
      const on = await app.inject({ method: "POST", url: `/v1/users/${userId}/agent-policy`, headers: AUTH, payload: { routingMode: "automatic" } });
      expect(on.statusCode, on.body).toBeLessThan(300);
    }
    await expectRuleAnswer(JSON.stringify({ severity: "high" }), "on-call");
  });

  it("a rule that no longer hashes to the approved digest is not served", async () => {
    await db.update(ruleStepSuggestions).set({ rule: OTHER_RULE }).where(eq(ruleStepSuggestions.id, suggestionId));
    try {
      await expectAiAnswer(JSON.stringify({ severity: "high" }));
    } finally {
      await db.update(ruleStepSuggestions).set({ rule: RULE }).where(eq(ruleStepSuggestions.id, suggestionId));
    }
    await expectRuleAnswer(JSON.stringify({ severity: "high" }), "on-call");
  });

  it("a reverted step goes back to the AI", async () => {
    await db.update(ruleStepSwitches).set({ status: "reverted", revertedAt: new Date() }).where(eq(ruleStepSwitches.id, switchId));
    await db.update(ruleStepSuggestions).set({ status: "suggested" }).where(eq(ruleStepSuggestions.id, suggestionId));
    await expectAiAnswer(JSON.stringify({ severity: "high" }));
  });
});
