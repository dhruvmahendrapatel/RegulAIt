/** ADR-0349 incident console: the `stage_skipped` event and the `skippable` template opt-in. */
import { describe, expect, it } from "vitest";
import { initialState, transition, validateDefinition, WorkflowStateError, type WorkflowDefinition, type WorkflowEvent } from "./index.js";

/** apply events in order through the kernel (a refusal throws) */
const apply = (d: WorkflowDefinition, events: WorkflowEvent[]) => events.reduce((s, e) => transition(d, s, e).state, initialState(d));

const def = (skippable: boolean | undefined) =>
  validateDefinition({
    workflow: "w",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "checks", type: "automated_check", checks: ["e2e"], ...(skippable === undefined ? {} : { skippable }) },
      { id: "gate", type: "human_approval", approvers: ["requesting_user"] },
    ],
  });
const skip: WorkflowEvent = { kind: "stage_skipped", stageId: "checks", reason: "runner outage" };

describe("ADR-0349 stage_skipped", () => {
  it("skips a skippable check that is waiting or failed, and stops at the next sign-off", () => {
    for (const before of [[{ kind: "start" }], [{ kind: "start" }, { kind: "check_failed", stageId: "checks", failures: ["e2e"] }]] as WorkflowEvent[][]) {
      expect(apply(def(true), [...before, skip])).toMatchObject({ status: "blocked_on_approval", currentStageIndex: 2, stageStatuses: ["completed", "completed", "active"] });
    }
  });

  it("is refused when the template does not opt in (absent is the strict default)", () => {
    for (const d of [def(undefined), def(false)]) {
      expect(() => apply(d, [{ kind: "start" }, skip])).toThrow(/not skippable/);
    }
  });

  it("is refused unless the instance waits on that stage", () => {
    const at = { state: apply(def(true), [{ kind: "start" }, skip]) };
    // now at the sign-off: skipping it (or the check again) is refused
    expect(() => transition(def(true), at.state, { kind: "stage_skipped", stageId: "gate", reason: "x" })).toThrow(WorkflowStateError);
    expect(() => transition(def(true), at.state, skip)).toThrow(/not waiting on a stage that can be skipped/);
  });

  it("refuses skippable on any stage but a check with named checks", () => {
    const stages = (extra: Record<string, unknown>) => ({ workflow: "w", stages: [{ id: "intake", type: "trigger" }, extra] });
    expect(() => validateDefinition(stages({ id: "g", type: "human_approval", approvers: ["requesting_user"], skippable: true }))).toThrow(/cannot carry skippable/);
    expect(() => validateDefinition(stages({ id: "a", type: "artifact_generation", output: "r", skippable: true }))).toThrow(/cannot carry skippable/);
    expect(() => validateDefinition(stages({ id: "m", type: "git_operation", action: "merge", connection: "c", repo: "o/r", skippable: true }))).toThrow(/cannot carry skippable/);
    expect(() => validateDefinition(stages({ id: "c", type: "automated_check", skippable: true }))).toThrow(/cannot carry skippable/);
  });
});
