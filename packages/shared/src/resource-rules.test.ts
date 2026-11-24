import { describe, expect, it } from "vitest";
import {
  createResourceApprovalRuleSchema,
  createResourceRateLimitSchema,
  rateLimitChangeRelaxes,
  updateResourceApprovalRuleSchema,
} from "./resource-rules.js";

const U = "00000000-0000-4000-a000-000000000001";

describe("ADR-0251: rateLimitChangeRelaxes (a loosening takes the step-up)", () => {
  const was = { maxCalls: 10, windowSeconds: 60 };
  it.each([
    [{ maxCalls: 11, windowSeconds: 60 }, true, "more calls"],
    [{ maxCalls: 10, windowSeconds: 59 }, true, "shorter window"],
    [{ maxCalls: 20, windowSeconds: 3600 }, true, "bigger burst over a longer window (ambiguous, so stepped up)"],
    [{ maxCalls: 9, windowSeconds: 60 }, false, "fewer calls"],
    [{ maxCalls: 10, windowSeconds: 61 }, false, "longer window"],
    [{ maxCalls: 5, windowSeconds: 30 }, false, "same rate, smaller burst"],
    [{ maxCalls: 10, windowSeconds: 60 }, false, "no change"],
  ])("%j relaxes=%s (%s)", (next, relaxes) => {
    expect(rateLimitChangeRelaxes(was, next)).toBe(relaxes);
  });
});

describe("ADR-0251: resource rule request shapes mirror the tables' CHECKs", () => {
  it("subject fields match the scope exactly", () => {
    const ok = { resourceType: "connector", scope: "user", userId: U, approverUserId: U };
    expect(createResourceApprovalRuleSchema.safeParse(ok).success).toBe(true);
    expect(createResourceApprovalRuleSchema.safeParse({ ...ok, userId: undefined }).success).toBe(false);
    expect(createResourceApprovalRuleSchema.safeParse({ ...ok, roleId: U }).success).toBe(false);
    expect(createResourceApprovalRuleSchema.safeParse({ ...ok, scope: "fleet", userId: undefined }).success).toBe(true);
  });
  it("a model rule cannot be write-only; a rate limit cannot be on a model", () => {
    expect(createResourceApprovalRuleSchema.safeParse({ resourceType: "model", scope: "fleet", writeOnly: true, approverUserId: U }).success).toBe(false);
    expect(createResourceRateLimitSchema.safeParse({ resourceType: "model", scope: "fleet", maxCalls: 1, windowSeconds: 1 }).success).toBe(false);
    expect(createResourceRateLimitSchema.safeParse({ resourceType: "a2a", scope: "fleet", maxCalls: 1, windowSeconds: 2_592_001 }).success).toBe(false);
  });
  it("an update must change something, and never the binding", () => {
    expect(updateResourceApprovalRuleSchema.safeParse({}).success).toBe(false);
    expect(updateResourceApprovalRuleSchema.safeParse({ scope: "fleet" }).success).toBe(false);
    expect(updateResourceApprovalRuleSchema.safeParse({ writeOnly: true }).success).toBe(true);
  });
});
