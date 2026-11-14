/**
 * ADR-0251 slice 2 — model dispatch through the one governed decision core.
 *
 * The core runs once in the shared dispatch core (`dispatchAttempt`), after the caller's own `evaluateAgent`:
 *  - the model rate limit (ADR-0212) is enforced BY DEFAULT now (migration governed_core_resource_rules);
 *  - P-01: a model approval rule HOLDS the dispatch in the one approvals queue (202 `approval_pending`, a `model_call`
 *    approval per required approver, audited, no usage row); the approved IDENTICAL call runs once and spends its
 *    consent; it binds only its subject (and its model: resource.test.ts);
 *  - an error inside the core is a deny;
 *  - DIFFERENTIAL: with no approval rule, the gate's answer is exactly ADR-0212's `checkModelRateLimit` answer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  and,
  approvals,
  auditLog,
  desc,
  eq,
  inArray,
  interceptionSettings,
  INTERCEPTION_SETTINGS_ID,
  modelRateLimits,
  orgSettings,
  ORG_SETTINGS_ID,
  resourceApprovalRules,
  usageEvents,
  type Db,
} from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
import { relaxApprovalSigningForTest } from "./testing/approval-signing-posture.js";
import { AGENT_HEADER, loadInterceptionSettings, PROJECT_HEADER } from "./compat-core.js";
import { governedModelGate } from "./governed-core.js";
import { spendModelConsents, type ModelConsentState } from "./model-call-consent.js";
import { sql } from "@regulait/db";
import type { GovernedResourceDecision } from "@regulait/policy-kernel";
import { checkModelRateLimit } from "./model-rate-limits.js";

let restoreGates: () => Promise<void> = async () => {};
let restoreApprovalSigning: () => Promise<void> = async () => {};
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
  restoreApprovalSigning = await relaxApprovalSigningForTest(k.db);
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
  await restoreApprovalSigning();
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

describe("ADR-0251 P-01: the model-call approval queue and replay", () => {
  const rule = async (who: Person, approverId: string) =>
    (
      await k.db
        .insert(resourceApprovalRules)
        .values({ resourceType: "model", agentId: MODEL, scope: "user", userId: who.id, approverUserId: approverId })
        .returning()
    )[0]!;
  const ask = (who: Person, input: string) =>
    k.req("POST", `/v1/agents/${MODEL}/invoke`, who.auth, { mode: "chat", input, dispatch: true, projectId: who.projectId });
  const decide = (id: string, who: Person, decision: "approved" | "denied" = "approved") =>
    k.req("POST", `/v1/approvals/${id}/decide`, who.auth, { decision });

  it("holds a matching call (202, nothing sent or billed), runs the approved IDENTICAL call once, and holds the next", async () => {
    const r = await rule(caller, approver.id);
    try {
      const input = `held-${k.RUN}`;
      const before = await usage(caller.id, MODEL);
      const held = await ask(caller, input);
      expect(held.statusCode, held.body).toBe(202);
      expect(held.json()).toMatchObject({ error: "approval_pending" });
      const approvalId = held.json().approvalId as string;
      expect(approvalId).toMatch(/^[0-9a-f-]{36}$/);
      const [row] = await k.db.select().from(approvals).where(eq(approvals.id, approvalId));
      expect(row).toMatchObject({
        status: "pending",
        objectType: "model_call",
        agentId: MODEL,
        approverUserId: approver.id,
        approvalScope: "action",
        projectId: caller.projectId,
      });
      // what a person reads in the queue: "<model name>.<mode>"
      expect(row!.toolName).toMatch(/held-[a-z0-9]+\.chat$/);
      expect(row!.argumentsDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(await usage(caller.id, MODEL)).toBe(before);
      // the hold is one audited decision row naming the approval and the rule
      const [audit] = await k.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.userId, caller.id), eq(auditLog.objectId, MODEL), eq(auditLog.effect, "require_approval")))
        .orderBy(desc(auditLog.seq))
        .limit(1);
      expect(audit).toMatchObject({ ruleId: r.id });
      expect(audit!.detail).toMatchObject({ phase: "governed-core", approvalId, matchedApprovalRuleIds: [r.id] });
      // an identical pending call reuses its row; a different payload is a different consent
      expect((await ask(caller, input)).json().approvalId).toBe(approvalId);
      const otherPayload = (await ask(caller, `${input}-other`)).json().approvalId as string;
      expect(otherPayload).not.toBe(approvalId);
      // the caller cannot approve their own call
      expect((await decide(approvalId, caller)).statusCode).toBeGreaterThanOrEqual(400);
      const decided = await decide(approvalId, approver);
      expect(decided.statusCode, decided.body).toBeLessThan(300);
      // a DIFFERENT payload is not released by this consent
      expect((await ask(caller, `${input}-other`)).statusCode).toBe(202);
      // THE REPLAY: the identical call runs, once
      const ran = await ask(caller, input);
      expect(ran.statusCode, ran.body).toBe(200);
      expect(await usage(caller.id, MODEL)).toBe(before + 1);
      expect((await k.db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]).toMatchObject({ status: "consumed" });
      // spent once: the same call is held again, under a fresh approval
      const again = await ask(caller, input);
      expect(again.statusCode, again.body).toBe(202);
      expect(again.json().approvalId).not.toBe(approvalId);
      expect(await usage(caller.id, MODEL)).toBe(before + 1);
      // the rule binds its subject only
      expect((await invoke(other, MODEL)).statusCode).toBe(200);
    } finally {
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, r.id));
    }
    expect((await invoke(caller, MODEL)).statusCode).toBe(200);
  });

  it("a denied consent releases nothing, and the next identical call is held again", async () => {
    const r = await rule(caller, approver.id);
    try {
      const input = `denied-${k.RUN}`;
      const held = await ask(caller, input);
      const approvalId = held.json().approvalId as string;
      expect((await decide(approvalId, approver, "denied")).statusCode).toBeLessThan(300);
      const next = await ask(caller, input);
      expect(next.statusCode, next.body).toBe(202);
      expect(next.json().approvalId).not.toBe(approvalId);
    } finally {
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, r.id));
    }
  });

  it("every named approver signs: two rules with two approvers need both consents, each spent once", async () => {
    const second = await k.person("approver-2");
    const r1 = await rule(caller, approver.id);
    const r2 = await rule(caller, second.id);
    try {
      const input = `two-${k.RUN}`;
      const before = await usage(caller.id, MODEL);
      const first = await ask(caller, input);
      expect(first.statusCode).toBe(202);
      const a1 = first.json().approvalId as string;
      const row1 = (await k.db.select().from(approvals).where(eq(approvals.id, a1)))[0]!;
      expect((await decide(a1, row1.approverUserId === approver.id ? approver : second)).statusCode).toBeLessThan(300);
      // one approver alone does not release it: the other is asked next
      const secondHold = await ask(caller, input);
      expect(secondHold.statusCode).toBe(202);
      const a2 = secondHold.json().approvalId as string;
      expect(a2).not.toBe(a1);
      const row2 = (await k.db.select().from(approvals).where(eq(approvals.id, a2)))[0]!;
      expect(row2.approverUserId).not.toBe(row1.approverUserId);
      // the first approver cannot decide the second consent
      expect((await decide(a2, row1.approverUserId === approver.id ? approver : second)).statusCode).toBeGreaterThanOrEqual(400);
      expect((await decide(a2, row2.approverUserId === approver.id ? approver : second)).statusCode).toBeLessThan(300);
      const ran = await ask(caller, input);
      expect(ran.statusCode, ran.body).toBe(200);
      expect(await usage(caller.id, MODEL)).toBe(before + 1);
      const rows = await k.db.select().from(approvals).where(inArray(approvals.id, [a1, a2]));
      expect(rows.map((x) => x.status)).toEqual(["consumed", "consumed"]);
    } finally {
      await k.db.delete(resourceApprovalRules).where(inArray(resourceApprovalRules.id, [r1.id, r2.id]));
    }
  });

  // review #807 item 1: a multi-approver replay is ALL OR NOTHING
  it("a replay whose second consent fails spends neither: the first stays approved, the second is retired, the refusal is audited", async () => {
    const second = await k.person("approver-atomic");
    const r1 = await rule(caller, approver.id);
    const r2 = await rule(caller, second.id);
    try {
      const input = `atomic-${k.RUN}`;
      const before = await usage(caller.id, MODEL);
      const a1 = (await ask(caller, input)).json().approvalId as string;
      const row1 = (await k.db.select().from(approvals).where(eq(approvals.id, a1)))[0]!;
      const p1 = row1.approverUserId === approver.id ? approver : second;
      expect((await decide(a1, p1)).statusCode).toBeLessThan(300);
      const a2 = (await ask(caller, input)).json().approvalId as string;
      const row2 = (await k.db.select().from(approvals).where(eq(approvals.id, a2)))[0]!;
      expect((await decide(a2, p1 === approver ? second : approver)).statusCode).toBeLessThan(300);
      const consentOf = (r: typeof row1) => ({
        approverUserId: r.approverUserId!,
        ruleIds: [],
        argumentsDigest: r.argumentsDigest!,
        argumentsPreview: null,
        contextDigest: r.contextDigest!,
        approvedApprovalId: r.id,
        retired: [],
      });
      // both consents were read as fresh (the state the gate decided on) ...
      const state: ModelConsentState = { bindings: [consentOf(row1), consentOf(row2)], allConsented: true, missing: null };
      const decision = { effect: "allow", ruleId: "agent-entitlement", reason: "", ruleChain: [], matchedApprovalRuleIds: [r1.id, r2.id] } as unknown as GovernedResourceDecision;
      const target = { agentId: MODEL, agentName: "held", provider: null, model: null };
      const spend = () => spendModelConsents(k.db, { userId: caller.id, target, projectId: caller.projectId, mode: "chat", state, decision });
      // ... then the second lapses before the spend
      await k.db.update(approvals).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(approvals.id, a2));
      const refused = await spend();
      expect(refused).toMatchObject({ status: 409, error: "approval_expired", approvalId: a2 });
      const after = await k.db.select().from(approvals).where(inArray(approvals.id, [a1, a2]));
      expect(Object.fromEntries(after.map((x) => [x.id, x.status]))).toEqual({ [a1]: "approved", [a2]: "superseded" });
      // the refusal's decision row was written with the retirement, naming the failing consent
      const [deny] = await k.db.select().from(auditLog).where(eq(auditLog.id, refused!.auditLogId!));
      expect(deny).toMatchObject({ effect: "deny", ruleId: "approval-expired" });
      expect(deny!.detail).toMatchObject({ approvalId: a2 });
      expect(await usage(caller.id, MODEL)).toBe(before);
      // a lost race spends nothing either: the other consent was already used
      await k.db.update(approvals).set({ status: "consumed" }).where(eq(approvals.id, a2));
      const raced = await spend();
      expect(raced).toMatchObject({ status: 409, error: "approval_consumed_race", approvalId: a2 });
      expect((await k.db.select().from(approvals).where(eq(approvals.id, a1)))[0]).toMatchObject({ status: "approved" });
      // the surviving consent still counts: the next identical call asks only the approver whose consent is missing
      const next = await ask(caller, input);
      expect(next.statusCode, next.body).toBe(202);
      const a3 = next.json().approvalId as string;
      expect((await k.db.select().from(approvals).where(eq(approvals.id, a3)))[0]!.approverUserId).toBe(row2.approverUserId);
    } finally {
      await k.db.delete(resourceApprovalRules).where(inArray(resourceApprovalRules.id, [r1.id, r2.id]));
    }
  });

  // review #807 item 2: the hold's queue row and its decision row commit together
  it("a hold whose decision row cannot be written queues nothing (no approvable row without its audit)", async () => {
    const r = await rule(caller, approver.id);
    const fn = `t807_reject_hold_${k.RUN.replace(/[^a-z0-9]/g, "")}`;
    try {
      await k.db.execute(
        sql.raw(`create function ${fn}() returns trigger language plpgsql as $$
          begin
            if new.effect = 'require_approval' and new.object_id = '${MODEL}' then raise exception 't807 injected audit failure'; end if;
            return new;
          end $$`),
      );
      await k.db.execute(sql.raw(`create trigger ${fn} before insert on audit_log for each row execute function ${fn}()`));
      const input = `hold-atomic-${k.RUN}`;
      const res = await ask(caller, input);
      expect(res.statusCode, res.body).toBe(503);
      const leaked = await k.db
        .select({ id: approvals.id })
        .from(approvals)
        .where(and(eq(approvals.userId, caller.id), eq(approvals.agentId, MODEL), sql`${approvals.argumentsPreview}::text like ${`%${input}%`}`));
      expect(leaked).toEqual([]);
      // the same call, once the audit write works, IS queued and found by that query (so the check above is not vacuous)
      await k.db.execute(sql.raw(`drop trigger if exists ${fn} on audit_log`));
      const held = await ask(caller, input);
      expect(held.statusCode, held.body).toBe(202);
      const found = await k.db
        .select({ id: approvals.id })
        .from(approvals)
        .where(and(eq(approvals.userId, caller.id), eq(approvals.agentId, MODEL), sql`${approvals.argumentsPreview}::text like ${`%${input}%`}`));
      expect(found.map((f) => f.id)).toEqual([held.json().approvalId]);
    } finally {
      await k.db.execute(sql.raw(`drop trigger if exists ${fn} on audit_log`));
      await k.db.execute(sql.raw(`drop function if exists ${fn}()`));
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, r.id));
    }
  });

  // review #807 item 3: identical calls at the same moment share one pending row
  it("concurrent identical calls are held under ONE pending approval", async () => {
    const r = await rule(caller, approver.id);
    try {
      const input = `concurrent-${k.RUN}`;
      const results = await Promise.all(Array.from({ length: 6 }, () => ask(caller, input)));
      for (const res of results) expect(res.statusCode, res.body).toBe(202);
      const ids = new Set(results.map((res) => res.json().approvalId as string));
      expect(ids.size).toBe(1);
      const pending = await k.db
        .select({ id: approvals.id })
        .from(approvals)
        .where(and(eq(approvals.userId, caller.id), eq(approvals.agentId, MODEL), eq(approvals.status, "pending"), eq(approvals.id, [...ids][0]!)));
      expect(pending).toHaveLength(1);
    } finally {
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, r.id));
    }
  });

  // security review #807 (non-blocking): separation of duties, pinned on the model-call kind
  it("a requester named as the approver of their own call can never release it", async () => {
    const r = await rule(caller, caller.id);
    try {
      const input = `sod-${k.RUN}`;
      const before = await usage(caller.id, MODEL);
      const held = await ask(caller, input);
      if (held.statusCode === 202) {
        const approvalId = held.json().approvalId as string;
        expect((await decide(approvalId, caller)).statusCode).toBeGreaterThanOrEqual(400);
        expect((await k.db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]).toMatchObject({ status: "pending" });
      } else {
        // a pool that can only be the caller is unsatisfiable: refused and audited at queue time, nothing queued
        expect(held.statusCode, held.body).toBe(403);
        expect(held.json()).toMatchObject({ error: "approval_quorum_unsatisfiable" });
      }
      expect((await ask(caller, input)).statusCode).not.toBe(200);
      expect(await usage(caller.id, MODEL)).toBe(before);
    } finally {
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, r.id));
    }
  });

  it("a consent granted under a policy that has since changed is superseded and the call held afresh", async () => {
    const r = await rule(caller, approver.id);
    let r2: string | null = null;
    try {
      const input = `stale-${k.RUN}`;
      const approvalId = (await ask(caller, input)).json().approvalId as string;
      expect((await decide(approvalId, approver)).statusCode).toBeLessThan(300);
      // the rule set changes: a new rule (same approver) joins, so the context digest moves
      r2 = (await rule(caller, approver.id)).id;
      const next = await ask(caller, input);
      expect(next.statusCode, next.body).toBe(202);
      expect(next.json().approvalId).not.toBe(approvalId);
      expect(next.json().detail).toMatch(/superseded/);
      expect((await k.db.select().from(approvals).where(eq(approvals.id, approvalId)))[0]).toMatchObject({ status: "superseded" });
    } finally {
      await k.db.delete(resourceApprovalRules).where(inArray(resourceApprovalRules.id, [r.id, ...(r2 ? [r2] : [])]));
    }
  });

  it("on the OpenAI-shaped surface the hold is a 403 approval_pending (an SDK reads any 2xx as a completion)", async () => {
    // the compat surface dispatches in mode `execute`: a model that declares it, granted to the caller
    const created = await k.req("POST", "/v1/agents", k.BOOT, {
      name: `adr0251-compat-${k.RUN}`,
      provider: "mock",
      tier: 1,
      modes: ["chat", "execute"],
      model: "mock-balanced",
      costPerMTokIn: 1,
      costPerMTokOut: 1,
    });
    expect(created.statusCode, created.body).toBe(201);
    const COMPAT = created.json().id as string;
    await k.grantModel(caller.id, COMPAT);
    const [r] = await k.db
      .insert(resourceApprovalRules)
      .values({ resourceType: "model", agentId: COMPAT, scope: "user", userId: caller.id, approverUserId: approver.id })
      .returning();
    // ADR-0020 ships the compat surfaces off; on for this case only
    await loadInterceptionSettings(k.db);
    const [prev] = await k.db.select().from(interceptionSettings).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
    await k.db.update(interceptionSettings).set({ openaiCompatEnabled: true }).where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
    try {
      const res = await k.app.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { ...caller.auth, [AGENT_HEADER]: COMPAT, [PROJECT_HEADER]: caller.projectId },
        payload: { model: `adr0251-compat-${k.RUN}`, max_tokens: 32, messages: [{ role: "user", content: `compat-${k.RUN}` }] },
      });
      expect(res.statusCode, res.body).toBe(403);
      expect(res.body).toContain("approval_pending");
      expect(res.body).toMatch(/approval '[0-9a-f-]{36}' is pending/);
    } finally {
      await k.db
        .update(interceptionSettings)
        .set({ openaiCompatEnabled: prev?.openaiCompatEnabled ?? false })
        .where(eq(interceptionSettings.id, INTERCEPTION_SETTINGS_ID));
      await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, r!.id));
    }
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
