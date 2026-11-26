import { describe, expect, it } from "vitest";
import { STATE_MACHINES } from "./state-machines.js";
import { fragmentVersionState, FRAGMENT_VERSION_CALLABLE_STATE, WORKFLOW_FRAGMENT_VERSION_MACHINE as M } from "./workflow-fragment-machine.js";

describe("ADR-0341 §9 the sub-process version machine", () => {
  it("is declared in the shared registry", () => {
    expect(STATE_MACHINES["workflow_fragment_version"]).toBe(M);
  });

  it("moves only from pending_approval, to approved or rejected, by an approver", () => {
    expect(M.next("pending_approval", "approve")).toBe("approved");
    expect(M.next("pending_approval", "reject")).toBe("rejected");
    expect(M.can("approved", "reject")).toBe(false);
    expect(M.can("rejected", "approve")).toBe(false);
    expect(M.def.terminal).toEqual(["approved", "rejected"]);
  });

  it("reads the approval row's status, failing closed, and only approved is callable", () => {
    expect(fragmentVersionState("pending")).toBe("pending_approval");
    expect(fragmentVersionState("approved")).toBe("approved");
    expect(fragmentVersionState("denied")).toBe("rejected");
    expect(fragmentVersionState("superseded")).toBe("rejected");
    expect(fragmentVersionState(null)).toBe("rejected");
    expect(FRAGMENT_VERSION_CALLABLE_STATE).toBe("approved");
  });
});
