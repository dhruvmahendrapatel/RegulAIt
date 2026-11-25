import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  agents,
  and,
  approvals,
  auditLog,
  createDb,
  desc,
  eq,
  isNull,
  ruleStepSettings,
  ruleStepShadows,
  ruleStepSuggestions,
  ruleStepSwitches,
  runMigrations,
  RULE_STEP_SWITCH_STATUSES,
  type Db,
} from "@regulait/db";
import { RULE_STEP_SWITCH_MACHINE, STATE_MACHINES } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { grantStepUpForTest, sessionRequest, stepUpRequest } from "./testing/step-up-grant.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import type { StepUpCheckArgs } from "./step-up.js";
import { RULE_STEP_AUDIT_RULE_IDS, ruleStepRuleDigest } from "./rule-steps.js";

/**
 * ADR-0327 slice 4a — switching a rule-like step from the AI to its rule. Requested from shadow mode by a person
 * (step-up), decided by a named administrator through the one approvals decide path, bound to the digest of the rule
 * that was measured, and reverted in one action without an approval. Nothing here serves the rule yet (slice 4b).
 */

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "adr0327-switch-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = Date.now();
const STEP = `adr0327-switch-${RUN}`;
const RULE = {
  fields: ["severity"],
  cells: [
    { key: ["high"], output: "on-call", support: 9 },
    { key: ["low"], output: "backlog", support: 9 },
  ],
};

type Person = { id: string; key: { authorization: string } };
let db: Db;
let app: ReturnType<typeof buildApp>;
let requester: Person;
let reviewer: Person;
let member: Person;
let agentId: string;
let suggestionId: string;
const restores: Array<() => Promise<void>> = [];

async function makeUser(name: string, isAdmin: boolean): Promise<Person> {
  const u = await app.inject({ method: "POST", url: "/v1/users", headers: AUTH, payload: { email: `${name}-${RUN}@example.com`, displayName: name, isAdmin } });
  expect(u.statusCode, u.body).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "sw" } });
  return { id: u.json().id as string, key: { authorization: `Bearer ${k.json().token}` } };
}

const steppedUp = async (facts: Record<string, unknown>) =>
  stepUpRequest(await grantStepUpForTest(db, requester.id, { kind: "settings_relax", facts } as StepUpCheckArgs));
const request = async (reviewerUserId = reviewer.id, opts: { stepUp?: boolean } = {}) =>
  app.inject({
    method: "POST",
    url: `/v1/rule-steps/suggestions/${suggestionId}/switch`,
    ...(opts.stepUp === false
      ? sessionRequest(await grantStepUpForTest(db, requester.id, { kind: "settings_relax", facts: { unrelated: true } } as StepUpCheckArgs))
      : await steppedUp({ ruleSteps: "switch", suggestionId })),
    payload: { reviewerUserId, reason: "measured in shadow: agreement 100% on covered inputs" },
  });
const decide = (who: Person, approvalId: string, decision: "approved" | "denied") =>
  relaxStepUpAround(db, () =>
    app.inject({ method: "POST", url: `/v1/approvals/${approvalId}/decide`, headers: who.key, payload: { decision, reason: "read the measurement" } }),
  );
const revert = (who: Person) =>
  app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${suggestionId}/revert`, headers: who.key, payload: { reason: "back to the AI" } });
const suggestion = async () => (await db.select().from(ruleStepSuggestions).where(eq(ruleStepSuggestions.id, suggestionId)))[0]!;
const latestSwitch = async () =>
  (await db.select().from(ruleStepSwitches).where(eq(ruleStepSwitches.suggestionId, suggestionId)).orderBy(desc(ruleStepSwitches.requestedAt)).limit(1))[0];
const lastAudit = async (ruleId: string) => (await db.select().from(auditLog).where(eq(auditLog.ruleId, ruleId)).orderBy(desc(auditLog.at)).limit(1))[0];
const openShadow = async () => (await db.select().from(ruleStepShadows).where(and(eq(ruleStepShadows.suggestionId, suggestionId), isNull(ruleStepShadows.stoppedAt))))[0];
const startShadow = async () => {
  const r = await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${suggestionId}/shadow`, headers: requester.key });
  expect(r.statusCode, r.body).toBe(200);
};

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restores.push(await relaxIdentityForTest(db, { mfaRequired: "off" }));
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "d".repeat(64) });
  requester = await makeUser("sw-requester", true);
  reviewer = await makeUser("sw-reviewer", true);
  member = await makeUser("sw-member", false);
  const [a] = await db
    .insert(agents)
    .values({ name: `adr0327-switch-agent-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 1, costPerMTokOut: 1, model: "mock-balanced" })
    .returning({ id: agents.id });
  agentId = a!.id;
  // detection on (the switch is refused while it is off); restored after
  const [prev] = await db.select().from(ruleStepSettings);
  if (prev) await db.update(ruleStepSettings).set({ enabled: true });
  else await db.insert(ruleStepSettings).values({ enabled: true });
  restores.push(async () => {
    if (prev) await db.update(ruleStepSettings).set({ enabled: prev.enabled });
    else await db.delete(ruleStepSettings);
  });
  const [s] = await db
    .insert(ruleStepSuggestions)
    .values({ agentId, stepName: STEP, rule: RULE, runs: 220, structuredRuns: 220, outputClasses: 2, agreement: 1, coverage: 0.5, windowCostUsd: 11, projectedMonthlySavingsUsd: 5.5 })
    .returning({ id: ruleStepSuggestions.id });
  suggestionId = s!.id;
});

afterAll(async () => {
  if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  for (const r of restores.reverse()) await r();
  await app.close();
});

describe("ADR-0327 slice 4a: switching a rule-like step to its rule", () => {
  it("the switch request lifecycle is a declared ADR-0348 machine over its column's states", () => {
    const m = RULE_STEP_SWITCH_MACHINE;
    expect([...m.def.states].sort()).toEqual([...RULE_STEP_SWITCH_STATUSES].sort());
    expect(STATE_MACHINES[m.def.id]).toBe(m);
    expect(Object.fromEntries(Object.entries(m.def.transitions).map(([e, t]) => [e, [[...t.from], t.to]]))).toEqual({
      approve: [["pending_review"], "switched"],
      reject: [["pending_review"], "rejected"],
      mark_stale: [["pending_review"], "stale"],
      revert: [["switched"], "reverted"],
    });
  });

  it("is admin-only, and only from shadow mode", async () => {
    expect((await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${suggestionId}/switch`, headers: member.key, payload: { reviewerUserId: reviewer.id, reason: "x" } })).statusCode).toBe(403);
    expect((await revert(member)).statusCode).toBe(403);
    const early = await request();
    expect(early.statusCode, early.body).toBe(409);
    expect(early.json().error).toBe("not_in_shadow");
    expect(await latestSwitch()).toBeUndefined();
  });

  it("needs a step-up, a user identity, and an eligible reviewer other than the requester", async () => {
    await startShadow();
    const noStepUp = await request(reviewer.id, { stepUp: false });
    // refused for want of a step-up (403 step_up_required, or 422 step_up_unavailable when no method is enrolled)
    expect([403, 422], noStepUp.body).toContain(noStepUp.statusCode);
    expect(noStepUp.json().error, noStepUp.body).toMatch(/^step_up_/);
    const bootstrap = await app.inject({ method: "POST", url: `/v1/rule-steps/suggestions/${suggestionId}/switch`, headers: AUTH, payload: { reviewerUserId: reviewer.id, reason: "x" } });
    expect(bootstrap.statusCode, bootstrap.body).toBe(422);
    expect(bootstrap.json().error).toBe("user_identity_required");
    expect((await request(requester.id)).json().error).toBe("reviewer_is_requester");
    expect((await request(member.id)).json().error).toBe("reviewer_not_eligible");
    expect(await latestSwitch()).toBeUndefined();
  });

  it("asks a named reviewer, bound to the measured rule's digest; the requester cannot decide it", async () => {
    const r = await request();
    expect(r.statusCode, r.body).toBe(202);
    const w = (await latestSwitch())!;
    expect(w).toMatchObject({ status: "pending_review", requestedBy: requester.id, ruleSha256: ruleStepRuleDigest(RULE) });
    const [a] = await db.select().from(approvals).where(eq(approvals.id, r.json().approvalId));
    expect(a).toMatchObject({ objectType: "rule_step_switch", approverUserId: reviewer.id, argumentsDigest: w.ruleSha256 });
    expect((await request()).json().error).toBe("switch_pending");
    expect((await suggestion()).status).toBe("shadow");
    expect(await lastAudit(RULE_STEP_AUDIT_RULE_IDS.switchRequested)).toBeTruthy();
    const own = await decide(requester, a!.id, "approved");
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe("cannot_approve_own_rule_step_switch");
    expect((await suggestion()).status).toBe("shadow");
  });

  it("freezes what was requested: suggestion, digest, time and requester cannot change after insert", async () => {
    const w = (await latestSwitch())!;
    for (const change of [{ ruleSha256: "0".repeat(64) }, { suggestionId: w.suggestionId === suggestionId ? agentId : suggestionId }, { requestedBy: reviewer.id }, { requestedAt: new Date(0) }]) {
      const err = await db.update(ruleStepSwitches).set(change).where(eq(ruleStepSwitches.id, w.id)).then(() => null, (e: unknown) => e);
      expect(err, JSON.stringify(change)).toBeTruthy();
      expect(String((err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code), JSON.stringify(change)).toMatch(/^23(514|503)$/);
    }
    expect((await latestSwitch())!.ruleSha256).toBe(w.ruleSha256);
  });

  it("the reviewer's approval switches the step and closes the shadow period; the list shows it", async () => {
    const w = (await latestSwitch())!;
    expect(await openShadow()).toBeTruthy();
    expect((await decide(reviewer, w.approvalId!, "approved")).statusCode).toBe(200);
    expect((await suggestion()).status).toBe("switched");
    expect((await latestSwitch())!).toMatchObject({ status: "switched", decidedBy: reviewer.id });
    expect(await openShadow()).toBeUndefined();
    expect((await lastAudit(RULE_STEP_AUDIT_RULE_IDS.switched))?.detail).toMatchObject({ suggestionId, ruleSha256: w.ruleSha256 });
    const list = await app.inject({ method: "GET", url: "/v1/rule-steps/suggestions?status=switched", headers: requester.key });
    const item = (list.json().items as Array<{ id: string; switch: { status: string; lifecycle: { transitions: Array<{ event: string; allowed: boolean }> } }; lifecycle: { transitions: Array<{ event: string; allowed: boolean }> } }>).find((x) => x.id === suggestionId)!;
    expect(item.switch.status).toBe("switched");
    expect(item.lifecycle.transitions.find((t) => t.event === "revert")?.allowed).toBe(true);
    expect(item.switch.lifecycle.transitions.find((t) => t.event === "revert")?.allowed).toBe(true);
  });

  it("reverts in one action with no approval, audited; a second revert is refused", async () => {
    const r = await revert(requester);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ status: "suggested", switch: { status: "reverted" } });
    expect((await suggestion()).status).toBe("suggested");
    expect((await latestSwitch())!).toMatchObject({ status: "reverted", revertedBy: requester.id, revertReason: "back to the AI" });
    expect(await lastAudit(RULE_STEP_AUDIT_RULE_IDS.reverted)).toBeTruthy();
    expect((await revert(requester)).statusCode).toBe(409);
  });

  it("an approval is recorded stale, not applied, when the rule no longer matches what was requested", async () => {
    await startShadow();
    const r = await request();
    expect(r.statusCode, r.body).toBe(202);
    // the rule under test changes after the request (only a direct write can do it; a rescan leaves shadow rows alone)
    await db.update(ruleStepSuggestions).set({ rule: { ...RULE, cells: [RULE.cells[0]] } }).where(eq(ruleStepSuggestions.id, suggestionId));
    expect((await decide(reviewer, r.json().approvalId, "approved")).statusCode).toBe(200);
    expect((await suggestion()).status).toBe("shadow");
    expect((await latestSwitch())!.status).toBe("stale");
    expect((await lastAudit(RULE_STEP_AUDIT_RULE_IDS.switchStale))?.detail).toMatchObject({ requestedSha256: ruleStepRuleDigest(RULE) });
    await db.update(ruleStepSuggestions).set({ rule: RULE }).where(eq(ruleStepSuggestions.id, suggestionId));
  });

  it("a denial is recorded and changes nothing: the step stays in shadow", async () => {
    const r = await request();
    expect(r.statusCode, r.body).toBe(202);
    expect((await decide(reviewer, r.json().approvalId, "denied")).statusCode).toBe(200);
    expect((await suggestion()).status).toBe("shadow");
    expect((await latestSwitch())!.status).toBe("rejected");
    expect(await lastAudit(RULE_STEP_AUDIT_RULE_IDS.switchRejected)).toBeTruthy();
  });
});
