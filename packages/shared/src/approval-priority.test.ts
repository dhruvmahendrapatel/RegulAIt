import { describe, expect, it } from "vitest";
import { APPROVAL_PRIORITIES, APPROVAL_PRIORITY_MACHINE as machine, approvalPriorityLifecycle } from "./approval-priority.js";

describe("approval priority", () => {
  it("declares every non-no-op move once, without changing approval status", () => {
    for (const from of APPROVAL_PRIORITIES) for (const to of APPROVAL_PRIORITIES) {
      expect(machine.can(from, `set_${to}`)).toBe(from !== to);
      if (from !== to) expect(machine.next(from, `set_${to}`)).toBe(to);
    }
    expect(machine.def.stored).toBe("approvals.priority");
    expect(machine.isState("approved")).toBe(false);
  });
  it("disables every action for non-admins and decided records", () => {
    expect(approvalPriorityLifecycle("normal", "pending", false).transitions.every(t => !t.allowed)).toBe(true);
    for (const status of ["approved", "denied", "returned", "consumed", "superseded"]) {
      expect(approvalPriorityLifecycle("normal", status, true).transitions.every(t => !t.allowed)).toBe(true);
    }
    expect(approvalPriorityLifecycle("normal", "pending", true).transitions.filter(t => t.allowed)).toHaveLength(3);
  });
});
