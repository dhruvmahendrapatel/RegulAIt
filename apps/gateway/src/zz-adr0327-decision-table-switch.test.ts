import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  costEvents,
  createDb,
  decisionTables,
  desc,
  eq,
  ruleStepSettings,
  ruleStepSuggestions,
  ruleStepSwitches,
  runMigrations,
  sql,
  traceSpans,
  usageEvents,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { NOT_RULE_SERVED_SPAN } from "./rule-step-serve.js";
import { RULE_STEP_AUDIT_RULE_IDS } from "./rule-steps.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import type { StepUpCheckArgs } from "./step-up.js";

/**
 * ADR-0327 slice 4d — switching an AI step to its published decision table.
 *
 * The same switch lifecycle as a detector rule (requested with step-up, decided by a named administrator through the
 * one approvals decide path, reverted in one action), bound to ONE published version. The evidence for "the table
 * answered" is NO PROVIDER CALL: a usage_events delta of zero, paired with a delta of one on every call the AI must
 * answer (M-033).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = Math.random().toString(36).slice(2, 8);
const BOOT = `adr0327-dts-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const STEP = `adr0327-dts-${RUN}`;
const V1 = { fields: ["severity"], rows: [{ when: { severity: "high" }, then: "on-call" }, { when: { severity: "low" }, then: "backlog" }] };
const V2 = { fields: ["severity"], rows: [{ when: { severity: "high" }, then: "page-everyone" }] };
const V3 = { fields: ["severity"], rows: [{ when: { severity: ["high", "urgent"] }, then: "on-call" }] };

type Person = { id: string; key: { authorization: string } };
let db: Db;
let app: ReturnType<typeof buildApp>;
let requester: Person;
let reviewer: Person;
let agentId: string;
let otherAgentId: string;
let tableId: string;
const restores: Array<() => Promise<void>> = [];

async function makeUser(name: string): Promise<Person> {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `${name}-${RUN}@example.com`, displayName: name, isAdmin: true } });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "dts" } });
  return { id: u.json().id as string, key: { authorization: `Bearer ${k.json().token}` } };
}

async function makeAgent(name: string): Promise<string> {
  const ag = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: `${name}-model` },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  await app.inject({ method: "POST", url: "/v1/grants/agents", headers: AUTH, payload: { userId: requester.id, agentId: ag.json().id } });
  return ag.json().id as string;
}

async function makeTable(forAgent: string, stepName: string): Promise<string> {
  const t = await app.inject({ method: "POST", url: "/v1/decision-tables", headers: requester.key, payload: { name: `dts-${stepName}`, agentId: forAgent, stepName } });
  expect(t.statusCode, t.body).toBe(201);
  return t.json().id as string;
}

const decide = (who: Person, approvalId: string, decision: "approved" | "denied") =>
  relaxStepUpAround(db, () =>
    app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: who.key, payload: { decision, reason: "read the table" } }),
  );

async function publish(table: string, body: unknown) {
  const p = await app.inject({ method: "POST", headers: requester.key, url: `/v1/decision-tables/${table}/versions`, payload: { table: body, reviewerUserId: reviewer.id, reason: "routing" } });
  expect(p.statusCode, p.body).toBe(202);
  const d = await decide(reviewer, p.json().approvalId, "approved");
  expect(d.statusCode, d.body).toBe(200);
  return p.json().version as number;
}

const askSwitch = async (table: string, reviewerUserId = reviewer.id) =>
  app.inject({
    method: "POST",
    url: `/v1/decision-tables/${table}/switch`,
    ...stepUpRequest(await grantStepUpForTest(db, requester.id, { kind: "settings_relax", facts: { ruleSteps: "switch", decisionTableId: table } } as StepUpCheckArgs)),
    payload: { reviewerUserId, reason: "the team wrote this table; serve it" },
  });
const revert = (table: string) =>
  app.inject({ method: "POST", url: `/v1/decision-tables/${table}/revert`, headers: requester.key, payload: { reason: "back to the AI" } });
const detail = async (table: string) => (await app.inject({ method: "GET", url: `/v1/decision-tables/${table}`, headers: requester.key })).json();
const switchRow = async (id: string) => (await db.select().from(ruleStepSwitches).where(eq(ruleStepSwitches.id, id)))[0]!;
const lastAudit = async (ruleId: string) => (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1))[0];

const usageCount = async () => (await db.select().from(usageEvents).where(eq(usageEvents.userId, requester.id))).length;
const ruleSavings = async () =>
  db.select().from(costEvents).where(and(eq(costEvents.userId, requester.id), eq(costEvents.technique, "rule_replacement")));
const ask = (text: string) =>
  app.inject({ method: "POST", url: `/v1/agents/${agentId}/invoke`, headers: requester.key, payload: { mode: "execute", dispatch: true, input: text } });

async function expectTableAnswer(text: string, output: string) {
  const usage = await usageCount();
  const savings = (await ruleSavings()).length;
  const r = await ask(text);
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().dispatch.outputText).toBe(output);
  expect(await usageCount()).toBe(usage);
  expect((await ruleSavings()).length).toBe(savings + 1);
}
async function expectAiAnswer(text: string) {
  const usage = await usageCount();
  const savings = (await ruleSavings()).length;
  const r = await ask(text);
  expect(r.statusCode, r.body).toBe(200);
  expect(await usageCount()).toBe(usage + 1);
  expect((await ruleSavings()).length).toBe(savings);
}

/** request a switch of the table's published version and have the named reviewer approve it */
async function switchOn(table: string) {
  const r = await askSwitch(table);
  expect(r.statusCode, r.body).toBe(202);
  const d = await decide(reviewer, r.json().approvalId, "approved");
  expect(d.statusCode, d.body).toBe(200);
  expect((await switchRow(r.json().switchId)).status).toBe("switched");
  return r.json().switchId as string;
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "e".repeat(64) });
  restores.push(
    await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false, useCaseGateMode: "off", requireProjectAttribution: false }),
  );
  requester = await makeUser("dts-requester");
  reviewer = await makeUser("dts-reviewer");
  // the native invoke path records the step as the agent's name
  agentId = await makeAgent(STEP);
  otherAgentId = await makeAgent(`${STEP}-other`);
  tableId = await makeTable(agentId, STEP);
});

afterAll(async () => {
  for (const id of [agentId, otherAgentId]) {
    if (!id) continue;
    await db.delete(decisionTables).where(eq(decisionTables.agentId, id));
    await db.delete(ruleStepSuggestions).where(eq(ruleStepSuggestions.agentId, id));
  }
  for (const r of restores.reverse()) await r();
  await app.close();
});

describe("ADR-0327 slice 4d: switching a step to its published decision table", () => {
  it("needs a published version, a person, and a reviewer other than the requester", async () => {
    const none = await askSwitch(tableId);
    expect(none.statusCode, none.body).toBe(409);
    expect(none.json().error).toBe("no_published_version");
    expect(await publish(tableId, V1)).toBe(1);
    const self = await askSwitch(tableId, requester.id);
    expect(self.statusCode, self.body).toBe(422);
    expect(self.json().error).toBe("reviewer_is_requester");
  });

  it("nothing changes until the named reviewer approves; the requester cannot decide their own switch", async () => {
    const r = await askSwitch(tableId);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().version).toBe(1);
    const w = await switchRow(r.json().switchId);
    expect(w.status).toBe("pending_review");
    expect(w.suggestionId).toBeNull();
    expect((await detail(tableId)).switch).toMatchObject({ id: w.id, status: "pending_review", version: 1 });
    await expectAiAnswer(JSON.stringify({ severity: "high" }));
    const again = await askSwitch(tableId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("switch_pending");
    const own = await decide(requester, r.json().approvalId, "approved");
    expect(own.statusCode, own.body).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_rule_step_switch");
    const no = await decide(reviewer, r.json().approvalId, "denied");
    expect(no.statusCode, no.body).toBe(200);
    expect((await switchRow(w.id)).status).toBe("rejected");
    await expectAiAnswer(JSON.stringify({ severity: "high" }));
  });

  it("approved: the published version answers the inputs it covers, marked and priced; the AI answers the rest", async () => {
    const switchId = await switchOn(tableId);
    await expectTableAnswer(JSON.stringify({ severity: "high", ticket: 4 }), "on-call");
    const [saving] = (await ruleSavings()).slice(-1);
    expect(saving!.detail).toMatchObject({ switchId, suggestionId: null, surface: "invoke" });
    expect((saving!.detail as { decisionTableVersionId: string | null }).decisionTableVersionId).toBe((await detail(tableId)).published.id);
    // the span says a rule answered, and detection and shadow counts never read it as an AI run
    const [span] = await db
      .select()
      .from(traceSpans)
      .where(and(eq(traceSpans.agentId, agentId), eq(traceSpans.kind, "llm")))
      .orderBy(desc(traceSpans.startedAt))
      .limit(1);
    expect((span!.attributes as { ruleStep?: { switchId: string } }).ruleStep?.switchId).toBe(switchId);
    const [counted] = await db.select({ n: sql<number>`count(*)::int` }).from(traceSpans).where(and(eq(traceSpans.id, span!.id), NOT_RULE_SERVED_SPAN));
    expect(counted!.n).toBe(0);
    await expectAiAnswer(JSON.stringify({ severity: "medium" }));
    expect((await lastAudit(RULE_STEP_AUDIT_RULE_IDS.switched))!.detail).toMatchObject({ decisionTableId: tableId, version: 1 });
  });

  it("one live switch per step: the detected rule's switch is refused while the table holds the step", async () => {
    const [prev] = await db.select().from(ruleStepSettings);
    if (prev) await db.update(ruleStepSettings).set({ enabled: true });
    else await db.insert(ruleStepSettings).values({ enabled: true });
    try {
      const rule = { fields: ["severity"], cells: [{ key: ["high"], output: "on-call", support: 9 }] };
      const [s] = await db
        .insert(ruleStepSuggestions)
        .values({ agentId, stepName: STEP, rule, runs: 50, structuredRuns: 50, outputClasses: 1, agreement: 1, coverage: 1, windowCostUsd: 1, projectedMonthlySavingsUsd: 1, status: "shadow" })
        .returning({ id: ruleStepSuggestions.id });
      const r = await app.inject({
        method: "POST",
        url: `/v1/rule-steps/suggestions/${s!.id}/switch`,
        ...stepUpRequest(await grantStepUpForTest(db, requester.id, { kind: "settings_relax", facts: { ruleSteps: "switch", suggestionId: s!.id } } as StepUpCheckArgs)),
        payload: { reviewerUserId: reviewer.id, reason: "measured" },
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().error).toBe("step_switched_to_decision_table");
    } finally {
      await db.delete(ruleStepSuggestions).where(eq(ruleStepSuggestions.agentId, agentId));
      if (prev) await db.update(ruleStepSettings).set({ enabled: prev.enabled });
      else await db.delete(ruleStepSettings);
    }
  });

  it("and the table's switch is refused while the detected rule holds the step", async () => {
    const otherTable = await makeTable(otherAgentId, `${STEP}-other`);
    await publish(otherTable, V1);
    await db
      .insert(ruleStepSuggestions)
      .values({ agentId: otherAgentId, stepName: `${STEP}-other`, rule: { fields: ["severity"], cells: [] }, runs: 50, structuredRuns: 50, outputClasses: 1, agreement: 1, coverage: 1, windowCostUsd: 1, projectedMonthlySavingsUsd: 1, status: "switched" });
    const r = await askSwitch(otherTable);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().error).toBe("step_switched_to_suggestion");
  });

  it("publishing a newer version reverts the switch: the new version never answers without its own approval", async () => {
    const live = (await detail(tableId)).switch.id as string;
    expect(await publish(tableId, V2)).toBe(2);
    const w = await switchRow(live);
    expect(w.status).toBe("reverted");
    expect(w.revertReason).toContain("superseded by version 2");
    await expectAiAnswer(JSON.stringify({ severity: "high" }));
  });

  it("a request approved after its version was superseded is recorded stale, and nothing is switched", async () => {
    const r = await askSwitch(tableId);
    expect(r.statusCode, r.body).toBe(202);
    expect(r.json().version).toBe(2);
    expect(await publish(tableId, V3)).toBe(3);
    const d = await decide(reviewer, r.json().approvalId, "approved");
    expect(d.statusCode, d.body).toBe(200);
    expect((await switchRow(r.json().switchId)).status).toBe("stale");
    expect((await lastAudit(RULE_STEP_AUDIT_RULE_IDS.switchStale))!.reason).toContain("version 2 is superseded");
    await expectAiAnswer(JSON.stringify({ severity: "urgent" }));
  });

  it("revert takes the table out in one action, and a request is frozen once made", async () => {
    const switchId = await switchOn(tableId);
    await expectTableAnswer(JSON.stringify({ severity: "urgent" }), "on-call");
    await expect(
      db.update(ruleStepSwitches).set({ decisionTableVersionId: null, suggestionId: null }).where(eq(ruleStepSwitches.id, switchId)),
    ).rejects.toThrow();
    const r = await revert(tableId);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().switch.status).toBe("reverted");
    expect((await revert(tableId)).statusCode).toBe(409);
    await expectAiAnswer(JSON.stringify({ severity: "urgent" }));
  });
});
