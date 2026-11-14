/**
 * ADR-0251 (P-01 remainder, review #715 finding 4) — the admin routes for `resource_approval_rules` and
 * `resource_rate_limits`.
 *
 *  - admin only (a non-admin key is refused before anything is read);
 *  - a create only ever restricts: no step-up, one audit row in the same transaction;
 *  - a loosening (delete; an approval rule's approver change or writeOnly on; a rate limit with more calls or a
 *    shorter window) is refused without a `settings_relax` step-up bound to exactly that change, and audited with the
 *    row before and after once admitted; a tightening needs no step-up;
 *  - bad bindings are refused with a reason (unknown resource, subject or approver, an approver who is the subject,
 *    a write-only model rule), never stored;
 *  - the list is bounded and keyset-paginated;
 *  - what the routes write is what the core enforces (a created connector limit binds, a deleted one stops binding).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, auditLog, eq, resourceApprovalRules, resourceRateLimits, desc } from "@regulait/db";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { relaxStepUpAround } from "./testing/step-up-posture.js";
import { loadResourceRestrictions } from "./governed-core.js";

let k: BuilderKit;
/** a real admin's API key: unlike the bootstrap credential it can never satisfy a step-up */
let adminP: Person;
let caller: Person;
let approver: Person;
let MODEL = "";
const created: { approval: string[]; rate: string[] } = { approval: [], rate: [] };

const admin = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) => k.req(method, url, adminP.auth, payload);
const lastAudit = async (objectId: string) =>
  (await k.db.select().from(auditLog).where(and(eq(auditLog.objectType, "restriction_rule"), eq(auditLog.objectId, objectId))).orderBy(desc(auditLog.seq)).limit(1))[0];

/** refused without a step-up (naming exactly this change), then admitted under the relaxed posture */
async function relaxing(method: "PATCH" | "DELETE", url: string, payload: unknown, values: Record<string, unknown>) {
  const refused = await admin(method, url, payload);
  expect(refused.statusCode, refused.body).toBe(403);
  expect(refused.json()).toMatchObject({ error: "step_up_required" });
  expect(refused.json().action?.body?.values ?? values).toEqual(values);
  return relaxStepUpAround(k.db, () => admin(method, url, payload));
}

beforeAll(async () => {
  k = await builderKit("adr0251-routes");
  adminP = await k.person("admin", { admin: true });
  caller = await k.person("caller");
  approver = await k.person("approver");
  MODEL = await k.model("routed", { price: 1 });
}, 120_000);

afterAll(async () => {
  for (const id of created.approval) await k.db.delete(resourceApprovalRules).where(eq(resourceApprovalRules.id, id));
  for (const id of created.rate) await k.db.delete(resourceRateLimits).where(eq(resourceRateLimits.id, id));
  await k.close();
});

describe("ADR-0251: resource approval rule routes", () => {
  it("are admin only", async () => {
    const r = await k.req("GET", "/v1/rules/resource/approval-rules", caller.auth);
    expect(r.statusCode).toBe(403);
    const w = await k.req("POST", "/v1/rules/resource/approval-rules", caller.auth, {
      resourceType: "model", resourceId: MODEL, scope: "user", userId: caller.id, approverUserId: approver.id,
    });
    expect(w.statusCode).toBe(403);
  });

  it("create (no step-up, audited), list, tighten without a step-up, loosen and delete only with one", async () => {
    const c = await admin("POST", "/v1/rules/resource/approval-rules", {
      resourceType: "connector", scope: "user", userId: caller.id, writeOnly: true, approverUserId: approver.id,
    });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().id as string;
    created.approval.push(id);
    expect(c.json()).toMatchObject({ resourceType: "connector", connectorId: null, scope: "user", userId: caller.id, writeOnly: true });
    expect(await lastAudit(id)).toMatchObject({ ruleId: "resource-approval-rule-created", effect: "allow" });
    // the core loads it for its subject
    const loaded = await loadResourceRestrictions(k.db, { userId: caller.id, resource: { type: "connector", id: "00000000-0000-4000-a000-000000000001", operation: "write" } });
    expect(loaded.approvalRules.map((r) => r.id)).toContain(id);

    // tightening: writeOnly off holds MORE calls, so no step-up
    const tight = await admin("PATCH", `/v1/rules/resource/approval-rules/${id}`, { writeOnly: false });
    expect(tight.statusCode, tight.body).toBe(200);
    expect(tight.json()).toMatchObject({ changed: true, rule: { writeOnly: false } });
    expect((await lastAudit(id))!.detail).toMatchObject({ transitions: { writeOnly: { from: true, to: false } } });
    // a no-op is not a write
    expect((await admin("PATCH", `/v1/rules/resource/approval-rules/${id}`, { writeOnly: false })).json()).toMatchObject({ changed: false });

    // loosening: writeOnly back on, and a new approver, each need the step-up
    const on = await relaxing("PATCH", `/v1/rules/resource/approval-rules/${id}`, { writeOnly: true }, {
      resourceApprovalRuleChanged: { ruleId: id, writeOnly: true, approverUserId: approver.id },
    });
    expect(on.statusCode, on.body).toBe(200);
    expect((await lastAudit(id))!.detail).toMatchObject({ relaxed: ["writeOnly"] });
    const second = await k.person("approver-2");
    const moved = await relaxing("PATCH", `/v1/rules/resource/approval-rules/${id}`, { approverUserId: second.id }, {
      resourceApprovalRuleChanged: { ruleId: id, writeOnly: true, approverUserId: second.id },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await lastAudit(id))!.detail).toMatchObject({ relaxed: ["approverUserId"], transitions: { approverUserId: { from: approver.id, to: second.id } } });

    // the list is bounded and paginated
    const page = await admin("GET", "/v1/rules/resource/approval-rules?resourceType=connector&limit=1");
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().rules.length).toBe(1);
    expect((await admin("GET", "/v1/rules/resource/approval-rules?limit=500")).statusCode).toBe(400);

    const del = await relaxing("DELETE", `/v1/rules/resource/approval-rules/${id}`, undefined, { resourceApprovalRuleRemoved: { ruleId: id } });
    expect(del.statusCode, del.body).toBe(200);
    expect((await lastAudit(id))!).toMatchObject({ ruleId: "resource-approval-rule-deleted" });
    expect((await lastAudit(id))!.detail).toMatchObject({ relaxation: true });
    expect((await k.db.select().from(resourceApprovalRules).where(eq(resourceApprovalRules.id, id))).length).toBe(0);
    expect((await admin("DELETE", `/v1/rules/resource/approval-rules/${id}`)).statusCode).toBe(404);
  });

  it("refuses a binding that cannot work, with the reason", async () => {
    const base = { resourceType: "model", resourceId: MODEL, scope: "user", userId: caller.id, approverUserId: approver.id };
    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ ...base, resourceId: "00000000-0000-4000-a000-0000000000ff" }, 422, "unknown_resource"],
      [{ ...base, userId: "00000000-0000-4000-a000-0000000000ff" }, 422, "unknown_user"],
      [{ ...base, approverUserId: "00000000-0000-4000-a000-0000000000ff" }, 422, "unknown_approver"],
      [{ ...base, approverUserId: caller.id }, 422, "approver_is_subject"],
    ];
    for (const [body, status, error] of cases) {
      const r = await admin("POST", "/v1/rules/resource/approval-rules", body);
      expect(r.statusCode, `${error}: ${r.body}`).toBe(status);
      expect(r.json().error).toBe(error);
    }
    // shape errors are 400s
    for (const body of [
      { ...base, writeOnly: true },
      { ...base, scope: "fleet" },
      { ...base, roleId: "00000000-0000-4000-a000-000000000001" },
      { ...base, resourceType: "tool" },
    ]) {
      expect((await admin("POST", "/v1/rules/resource/approval-rules", body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("ADR-0251: resource rate limit routes", () => {
  it("create binds in the core; a tightening needs no step-up; a loosening and a delete need one", async () => {
    const c = await admin("POST", "/v1/rules/resource/rate-limits", {
      resourceType: "a2a", scope: "user", userId: caller.id, maxCalls: 10, windowSeconds: 60,
    });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().id as string;
    created.rate.push(id);
    expect(await lastAudit(id)).toMatchObject({ ruleId: "resource-rate-limit-created" });
    const loaded = await loadResourceRestrictions(k.db, { userId: caller.id, resource: { type: "a2a", id: "00000000-0000-4000-a000-000000000001", skillId: null } });
    expect(loaded.rateLimits.map((r) => r.id)).toContain(id);

    // fewer calls over a longer window: tighter, no step-up
    const tight = await admin("PATCH", `/v1/rules/resource/rate-limits/${id}`, { maxCalls: 5, windowSeconds: 120 });
    expect(tight.statusCode, tight.body).toBe(200);
    expect((await lastAudit(id))!.detail).toMatchObject({ transitions: { maxCalls: { from: 10, to: 5 }, windowSeconds: { from: 60, to: 120 } } });
    expect((await lastAudit(id))!.detail).not.toHaveProperty("relaxed");

    // the same calls over a shorter window: looser
    const shorter = await relaxing("PATCH", `/v1/rules/resource/rate-limits/${id}`, { windowSeconds: 30 }, {
      resourceRateLimitChanged: { ruleId: id, maxCalls: 5, windowSeconds: 30 },
    });
    expect(shorter.statusCode, shorter.body).toBe(200);
    // more calls over a longer window: ambiguous, so it takes the step-up
    const ambiguous = await relaxing("PATCH", `/v1/rules/resource/rate-limits/${id}`, { maxCalls: 6, windowSeconds: 3600 }, {
      resourceRateLimitChanged: { ruleId: id, maxCalls: 6, windowSeconds: 3600 },
    });
    expect(ambiguous.statusCode, ambiguous.body).toBe(200);
    expect((await lastAudit(id))!.detail).toMatchObject({ relaxed: ["maxCalls", "windowSeconds"] });

    // model limits live at /v1/rules/model-rate-limits (one fact, one place)
    expect((await admin("GET", "/v1/rules/resource/rate-limits?resourceType=model")).statusCode).toBe(400);
    expect((await admin("POST", "/v1/rules/resource/rate-limits", { resourceType: "model", scope: "fleet", maxCalls: 1, windowSeconds: 1 })).statusCode).toBe(400);
    expect((await admin("POST", "/v1/rules/resource/rate-limits", { resourceType: "a2a", scope: "fleet", maxCalls: 0, windowSeconds: 1 })).statusCode).toBe(400);

    const del = await relaxing("DELETE", `/v1/rules/resource/rate-limits/${id}`, undefined, { resourceRateLimitRemoved: { ruleId: id } });
    expect(del.statusCode, del.body).toBe(200);
    expect((await lastAudit(id))!.detail).toMatchObject({ relaxation: true });
    const after = await loadResourceRestrictions(k.db, { userId: caller.id, resource: { type: "a2a", id: "00000000-0000-4000-a000-000000000001", skillId: null } });
    expect(after.rateLimits.map((r) => r.id)).not.toContain(id);
  });
});
