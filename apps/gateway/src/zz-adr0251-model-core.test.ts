/**
 * ADR-0251 slice 2 — model dispatch through the one governed decision core.
 *
 * The core runs once in the shared dispatch core (`dispatchAttempt`), after the caller's own `evaluateAgent`:
 *  - the model rate limit (ADR-0212) is enforced BY DEFAULT now (migration governed_core_resource_rules);
 *  - a model approval rule REFUSES the dispatch (403 `approval_required`, audited, no usage row), because a model call
 *    has no per-call approval queue yet; it binds only its subject (and its model: resource.test.ts);
 *  - an error inside the core is a deny;
 *  - DIFFERENTIAL: with no approval rule, the gate's answer is exactly ADR-0212's `checkModelRateLimit` answer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, auditLog, desc, eq, modelRateLimits, orgSettings, ORG_SETTINGS_ID, resourceApprovalRules, usageEvents, type Db } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { governedModelGate } from "./governed-core.js";
import { checkModelRateLimit } from "./model-rate-limits.js";

let restoreGates: () => Promise<void> = async () => {};
let k: BuilderKit;
let caller: Person;
let other: Person;
let approver: Person;
let MODEL = "";

const invoke = (who: Person, agentId: string) =>
  k.req("POST", `/v1/agents/${agentId}/invoke`, who.auth, { mode: "chat", input: "adr0251 probe", dispatch: true, projectId: who.projectId });
const usage = async (userId: string, agentId: string) =>
  (await k.db.select({ id: usageEvents.id }).from(usageEvents).where(and(eq(usageEvents.userId, userId), eq(usageEvents.agentId, agentId)))).length;

beforeAll(async () => {
  k = await builderKit("adr0251-model");
  restoreGates = await relaxGovernanceGatesForTest(k.db, { mrmEnforced: false });
  caller = await k.person("caller");
  other = await k.person("other");
  approver = await k.person("approver");
  MODEL = await k.model("held", { price: 1 });
  // one model grant each, so cost routing can never move a call onto another model
  await k.grantModel(caller.id, MODEL);
  await k.grantModel(other.id, MODEL);
}, 120_000);

afterAll(async () => {
  await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.agentId, MODEL));
  await k.db.delete(modelRateLimits).where(eq(modelRateLimits.agentId, MODEL));
  await restoreGates();
  await k.close();
});

describe("ADR-0251 slice 2: model rate limits are enforced by default", () => {
  it("the org default is on, and a configured limit binds without an opt-in", async () => {
    const [org] = await k.db.select({ on: orgSettings.modelRateLimitsEnabled }).from(orgSettings).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(org?.on).toBe(true);
    const [limit] = await k.db.insert(modelRateLimits).values({ scope: "user", userId: caller.id, agentId: MODEL, maxCalls: 1, windowSeconds: 3600 }).returning();
    try {
      expect((await invoke(caller, MODEL)).statusCode).toBe(200);
      const hit = await invoke(caller, MODEL);
      expect(hit.statusCode, hit.body).toBe(429);
      expect(hit.json()).toMatchObject({ error: "model_rate_limited" });
    } finally {
      await k.db.delete(modelRateLimits).where(eq(modelRateLimits.id, limit!.id));
    }
  });
});

describe("ADR-0251 slice 2: model approval rules", () => {
  it("refuse a matching dispatch (no queue for model calls yet), audited, with no usage row; others are untouched", async () => {
    const [rule] = await k.db
      .insert(resourceApprovalRules)
      .values({ resourceType: "model", agentId: MODEL, scope: "user", userId: caller.id, approverUserId: approver.id })
      .returning();
    try {
      const before = await usage(caller.id, MODEL);
      const r = await invoke(caller, MODEL);
      expect(r.statusCode, r.body).toBe(403);
      expect(r.json()).toMatchObject({ error: "approval_required" });
      expect(await usage(caller.id, MODEL)).toBe(before);
      const [row] = await k.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, caller.id), eq(auditLog.objectId, MODEL), eq(auditLog.ruleId, rule!.id)))
        .orderBy(desc(auditLog.seq))
        .limit(1);
      expect(row).toMatchObject({ effect: "deny", objectType: "agent" });
      expect(row!.detail).toMatchObject({ phase: "governed-core", matchedApprovalRuleIds: [rule!.id] });
      // another person on this model is not bound by the rule (the resource binding is pinned in resource.test.ts)
      const unbound = await invoke(other, MODEL);
      expect(unbound.statusCode, unbound.body).toBe(200);
    } finally {
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, rule!.id));
    }
    expect((await invoke(caller, MODEL)).statusCode).toBe(200);
  });
});

describe("ADR-0251 slice 2: error is deny", () => {
  it("a load that throws refuses the dispatch (governed-core-error), never allows it", async () => {
    let n = 0;
    const flaky = new Proxy(k.db, {
      get(target, prop, recv) {
        // the first reads succeed (the rate step), then the core's rule load fails
        if (prop === "select" && ++n > 1) throw new Error("connection reset");
        return Reflect.get(target, prop, recv);
      },
    }) as Db;
    const out = await governedModelGate(flaky, { userId: caller.id, agentId: MODEL, agentName: "held", mode: "execute", projectId: caller.projectId });
    expect(out).toMatchObject({ ok: false, status: 503, error: "governed_core_error", ruleId: "governed-core-error" });
  });
});

describe("ADR-0251 differential: with no approval rule the gate answers exactly as ADR-0212's rate check", () => {
  it("over enforcement on/off x no limit / under / at the limit", async () => {
    let compared = 0;
    for (const enforce of [true, false])
      for (const maxCalls of [null, 1000, 1] as const) {
        await k.db.update(orgSettings).set({ modelRateLimitsEnabled: enforce }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
        const [limit] = maxCalls
          ? await k.db.insert(modelRateLimits).values({ scope: "fleet", agentId: MODEL, maxCalls, windowSeconds: 3600 }).returning()
          : [];
        try {
          const args = { userId: caller.id, agentId: MODEL, agentName: "held", projectId: caller.projectId };
          const old = await checkModelRateLimit(k.db, args);
          const now = await governedModelGate(k.db, { ...args, mode: "execute" });
          expect(now === null ? null : { status: now.status, error: now.error, ruleId: now.ruleId }, `${enforce}/${maxCalls}`).toEqual(
            old === null ? null : { status: old.status, error: old.error, ruleId: old.ruleId },
          );
          compared++;
        } finally {
          if (limit) await k.db.delete(modelRateLimits).where(eq(modelRateLimits.id, limit.id));
        }
      }
    await k.db.update(orgSettings).set({ modelRateLimitsEnabled: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
    expect(compared).toBe(6);
  });
});
