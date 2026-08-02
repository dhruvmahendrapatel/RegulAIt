import { describe, expect, it } from "vitest";
import {
  bulkCapRefusal,
  bulkDecideApprovalsSchema,
  bulkSensitivityFenced,
  createApprovalAssignmentRuleSchema,
  createApprovalSlaPolicySchema,
  evaluateSla,
  ruleMatches,
  selectAssignmentRule,
  slaDeadlines,
  stagePatternMatches,
  type ApprovalRoutingContext,
  type AssignmentRuleLike,
} from "./workbench.js";

/**
 * ADR-0046 — the review workbench's pure half, proved by attack.
 *
 * The three things these tests exist to make impossible:
 *
 *  1. A RULE THAT MATCHES EVERYTHING. Every match case has a NON-match twin,
 *     and the unconditioned rule is asserted to match nothing at all.
 *  2. AN SLA CLOCK THAT DRIFTS. Deadlines are asserted as a pure function of
 *     `requestedAt`, so an assignment materialized late gets the same deadlines
 *     an eager one would have — which is the entire justification for lazy
 *     evaluation.
 *  3. AN ESCALATION THAT DECIDES. The policy shape is asserted to reject an
 *     escalation with nowhere to escalate to, and the action enum has no
 *     auto-approve/auto-deny member for a caller to reach.
 */

const NOW = new Date("2026-08-02T12:00:00.000Z");
const REQUESTED = new Date("2026-08-02T10:00:00.000Z");

const ctx = (over: Partial<ApprovalRoutingContext> = {}): ApprovalRoutingContext => ({
  objectType: "workflow",
  projectId: "p1",
  dataSensitivity: "hipaa",
  stageId: "stage:approve-design",
  templateIds: ["t1"],
  ...over,
});

const rule = (over: Partial<AssignmentRuleLike> = {}): AssignmentRuleLike => ({
  id: over.id ?? "r1",
  objectType: null,
  projectId: null,
  dataSensitivity: null,
  stagePattern: null,
  templateId: null,
  assigneeKind: "user",
  assigneeId: "u1",
  quorum: 1,
  priority: 100,
  slaPolicyId: null,
  enabled: true,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

describe("stagePatternMatches", () => {
  it("matches literally when there is no wildcard", () => {
    expect(stagePatternMatches("stage:approve", "stage:approve")).toBe(true);
    expect(stagePatternMatches("stage:approve", "stage:approve-design")).toBe(false);
  });
  it("supports * as prefix / suffix / infix", () => {
    expect(stagePatternMatches("stage:*", "stage:approve-design")).toBe(true);
    expect(stagePatternMatches("*design", "stage:approve-design")).toBe(true);
    expect(stagePatternMatches("stage:*-design", "stage:approve-design")).toBe(true);
    expect(stagePatternMatches("stage:*-design", "stage:approve-build")).toBe(false);
  });
  it("treats regex metacharacters as literals, so an admin cannot smuggle a regex in", () => {
    expect(stagePatternMatches("stage:a.c", "stage:abc")).toBe(false);
    expect(stagePatternMatches("stage:a.c", "stage:a.c")).toBe(true);
    expect(stagePatternMatches("(a|b)+", "aaa")).toBe(false);
  });
  it("never matches a null stage id, and never matches an empty pattern", () => {
    expect(stagePatternMatches("*", null)).toBe(false);
    expect(stagePatternMatches("", "anything")).toBe(false);
  });
});

describe("ruleMatches — conditions AND, and an unconditioned rule matches NOTHING", () => {
  it("a rule with no conditions matches nothing", () => {
    expect(ruleMatches(rule(), ctx())).toBe(false);
  });
  it("a disabled rule matches nothing even when every condition fits", () => {
    expect(ruleMatches(rule({ objectType: "workflow", enabled: false }), ctx())).toBe(false);
  });
  it("each dimension matches and fails to match on its own", () => {
    expect(ruleMatches(rule({ objectType: "workflow" }), ctx())).toBe(true);
    expect(ruleMatches(rule({ objectType: "mcp_tool" }), ctx())).toBe(false);
    expect(ruleMatches(rule({ projectId: "p1" }), ctx())).toBe(true);
    expect(ruleMatches(rule({ projectId: "p2" }), ctx())).toBe(false);
    expect(ruleMatches(rule({ dataSensitivity: "hipaa" }), ctx())).toBe(true);
    expect(ruleMatches(rule({ dataSensitivity: "pci" }), ctx())).toBe(false);
    expect(ruleMatches(rule({ stagePattern: "stage:*" }), ctx())).toBe(true);
    expect(ruleMatches(rule({ stagePattern: "other:*" }), ctx())).toBe(false);
    expect(ruleMatches(rule({ templateId: "t1" }), ctx())).toBe(true);
    expect(ruleMatches(rule({ templateId: "t9" }), ctx())).toBe(false);
  });
  it("conditions AND: one wrong dimension defeats every right one", () => {
    const r = rule({ objectType: "workflow", projectId: "p1", dataSensitivity: "pci" });
    expect(ruleMatches(r, ctx())).toBe(false);
  });
  it("a null project on the approval does not match a project-scoped rule", () => {
    expect(ruleMatches(rule({ projectId: "p1" }), ctx({ projectId: null }))).toBe(false);
  });
  it("an unclassified project does not match a sensitivity-scoped rule", () => {
    expect(ruleMatches(rule({ dataSensitivity: "hipaa" }), ctx({ dataSensitivity: null }))).toBe(false);
  });
});

describe("selectAssignmentRule — total ordering, so a queue is never non-deterministic", () => {
  it("returns null when nothing matches", () => {
    expect(selectAssignmentRule([rule({ objectType: "run" })], ctx())).toBeNull();
  });
  it("lowest priority wins", () => {
    const lo = rule({ id: "lo", objectType: "workflow", priority: 10 });
    const hi = rule({ id: "hi", objectType: "workflow", priority: 90 });
    expect(selectAssignmentRule([hi, lo], ctx())!.id).toBe("lo");
    expect(selectAssignmentRule([lo, hi], ctx())!.id).toBe("lo");
  });
  it("ties break on createdAt, oldest first", () => {
    const older = rule({ id: "older", objectType: "workflow", createdAt: new Date("2026-01-01") });
    const newer = rule({ id: "newer", objectType: "workflow", createdAt: new Date("2026-06-01") });
    expect(selectAssignmentRule([newer, older], ctx())!.id).toBe("older");
  });
  it("identical priority AND createdAt still resolve deterministically", () => {
    const a = rule({ id: "aaa", objectType: "workflow" });
    const b = rule({ id: "bbb", objectType: "workflow" });
    expect(selectAssignmentRule([b, a], ctx())!.id).toBe("aaa");
    expect(selectAssignmentRule([a, b], ctx())!.id).toBe("aaa");
  });
});

describe("the SLA clock is DERIVED, which is what makes lazy evaluation honest", () => {
  it("deadlines are a pure function of requestedAt and the policy", () => {
    const d = slaDeadlines(REQUESTED, { warnAfterMinutes: 60, breachAfterMinutes: 180 });
    expect(d.warnAt.toISOString()).toBe("2026-08-02T11:00:00.000Z");
    expect(d.dueAt.toISOString()).toBe("2026-08-02T13:00:00.000Z");
    // computing them an hour later yields the SAME answer — an assignment
    // materialized late is indistinguishable from one materialized eagerly
    const again = slaDeadlines(REQUESTED.toISOString(), { warnAfterMinutes: 60, breachAfterMinutes: 180 });
    expect(again.dueAt.getTime()).toBe(d.dueAt.getTime());
  });

  it("no dueAt = no SLA = nothing ever changes", () => {
    const v = evaluateSla({ warnAt: null, dueAt: null, slaState: "ok" }, NOW);
    expect(v.state).toBe("ok");
    expect(v.changed).toBe(false);
    expect(v.breachedNow).toBe(false);
  });

  it("before the warn time nothing changes", () => {
    const v = evaluateSla(
      { warnAt: new Date("2026-08-02T13:00:00Z"), dueAt: new Date("2026-08-02T15:00:00Z"), slaState: "ok" },
      NOW,
    );
    expect(v.changed).toBe(false);
  });

  it("at the warn time it becomes warning, exactly once", () => {
    const at = { warnAt: NOW, dueAt: new Date("2026-08-02T15:00:00Z"), slaState: "ok" };
    const first = evaluateSla(at, NOW);
    expect(first.state).toBe("warning");
    expect(first.changed).toBe(true);
    const second = evaluateSla({ ...at, slaState: "warning" }, NOW);
    expect(second.changed).toBe(false);
  });

  it("at the due time it BREACHES, and breachedNow fires exactly once", () => {
    const at = { warnAt: new Date("2026-08-02T11:00:00Z"), dueAt: NOW, slaState: "warning" };
    const first = evaluateSla(at, NOW);
    expect(first.state).toBe("breached");
    expect(first.breachedNow).toBe(true);
    expect(first.minutesLate).toBe(0);
    const second = evaluateSla({ ...at, slaState: "breached" }, NOW);
    expect(second.breachedNow).toBe(false);
    expect(second.changed).toBe(false);
  });

  it("a breach detected LATE reports how late, so the lag is visible rather than hidden", () => {
    const v = evaluateSla(
      { warnAt: new Date("2026-08-02T09:00:00Z"), dueAt: new Date("2026-08-02T10:00:00Z"), slaState: "ok" },
      NOW,
    );
    expect(v.state).toBe("breached");
    expect(v.breachedNow).toBe(true);
    expect(v.minutesLate).toBe(120);
  });

  it("is MONOTONIC — a breached assignment never falls back to warning or ok", () => {
    const v = evaluateSla(
      { warnAt: new Date("2026-08-02T13:00:00Z"), dueAt: new Date("2026-08-02T15:00:00Z"), slaState: "breached" },
      NOW,
    );
    expect(v.state).toBe("breached");
    expect(v.changed).toBe(false);
  });

  it("an unknown stored state degrades to ok rather than being trusted", () => {
    const v = evaluateSla({ warnAt: NOW, dueAt: new Date("2026-08-02T15:00:00Z"), slaState: "??" }, NOW);
    expect(v.state).toBe("warning");
  });
});

describe("bulk fences", () => {
  it("the cap refuses the request WHOLE rather than truncating it", () => {
    expect(bulkCapRefusal(25, 25).refused).toBe(false);
    const over = bulkCapRefusal(26, 25);
    expect(over.refused).toBe(true);
    expect(over.detail).toContain("at most 25");
  });

  it("the sensitivity fence catches piiMode 'block' and nothing else", () => {
    expect(bulkSensitivityFenced({ enabled: true, projectPiiMode: "block" })).toBe(true);
    expect(bulkSensitivityFenced({ enabled: true, projectPiiMode: "warn" })).toBe(false);
    expect(bulkSensitivityFenced({ enabled: true, projectPiiMode: null })).toBe(false);
    // and an org that has turned the fence off is not fenced
    expect(bulkSensitivityFenced({ enabled: false, projectPiiMode: "block" })).toBe(false);
  });

  it("a bulk request must carry a reason — an unexplained mass decision is the failure mode", () => {
    expect(
      bulkDecideApprovalsSchema.safeParse({
        approvalIds: ["11111111-1111-1111-1111-111111111111"],
        decision: "approved",
      }).success,
    ).toBe(false);
    expect(
      bulkDecideApprovalsSchema.safeParse({
        approvalIds: ["11111111-1111-1111-1111-111111111111"],
        decision: "approved",
        reason: "reviewed as a batch of identical low-risk reads",
      }).success,
    ).toBe(true);
  });
});

describe("policy and rule shapes refuse the dangerous cases", () => {
  it("an SLA policy cannot breach before it warns", () => {
    expect(
      createApprovalSlaPolicySchema.safeParse({
        name: "x",
        warnAfterMinutes: 60,
        breachAfterMinutes: 60,
        escalateAction: "notify_only",
      }).success,
    ).toBe(false);
  });

  it("an escalation with nowhere to escalate to is refused", () => {
    expect(
      createApprovalSlaPolicySchema.safeParse({
        name: "x",
        warnAfterMinutes: 10,
        breachAfterMinutes: 20,
        escalateAction: "add_assignee",
      }).success,
    ).toBe(false);
  });

  it("reassign must name a single user — a team cannot become the one named approver", () => {
    const base = { name: "x", warnAfterMinutes: 10, breachAfterMinutes: 20, escalateAction: "reassign" as const };
    expect(
      createApprovalSlaPolicySchema.safeParse({
        ...base,
        escalateToKind: "team",
        escalateToId: "11111111-1111-1111-1111-111111111111",
      }).success,
    ).toBe(false);
    expect(
      createApprovalSlaPolicySchema.safeParse({
        ...base,
        escalateToKind: "user",
        escalateToId: "11111111-1111-1111-1111-111111111111",
      }).success,
    ).toBe(true);
  });

  it("there is NO auto-approve or auto-deny escalation action to reach for", () => {
    for (const action of ["auto_approve", "auto_deny", "approve", "deny", "expire"]) {
      expect(
        createApprovalSlaPolicySchema.safeParse({
          name: "x",
          warnAfterMinutes: 10,
          breachAfterMinutes: 20,
          escalateAction: action,
          escalateToKind: "user",
          escalateToId: "11111111-1111-1111-1111-111111111111",
        }).success,
        action,
      ).toBe(false);
    }
  });

  it("a routing rule needs at least one condition", () => {
    const assignee = {
      name: "everything",
      assigneeKind: "team" as const,
      assigneeId: "11111111-1111-1111-1111-111111111111",
    };
    expect(createApprovalAssignmentRuleSchema.safeParse(assignee).success).toBe(false);
    expect(
      createApprovalAssignmentRuleSchema.safeParse({ ...assignee, objectType: "workflow" }).success,
    ).toBe(true);
  });
});
