import { describe, expect, it } from "vitest";
import {
  initialState,
  planInstanceMigration,
  transition,
  validateDefinition,
  type InstanceState,
} from "./index.js";

describe("ADR-0340 slice 3: planInstanceMigration", () => {
  const v1 = validateDefinition({
    workflow: "m",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "req", type: "artifact_generation", output: "r" },
      { id: "branch", type: "git_operation", action: "create_branch", connection: "gh", repo: "o/r" },
      { id: "gate", type: "human_approval", approvers: ["requesting_user"] },
      { id: "pr", type: "git_operation", action: "open_pr", connection: "gh", repo: "o/r" },
      { id: "undo_branch", type: "git_operation", action: "delete_branch", connection: "gh", repo: "o/r", compensates: "branch" },
    ],
  });
  function atGate(): InstanceState {
    let r = transition(v1, initialState(v1), { kind: "start" });
    r = transition(v1, r.state, { kind: "artifact_submitted", stageId: "req" });
    r = transition(v1, r.state, { kind: "execution_succeeded", stageId: "branch" });
    expect(r.state.status).toBe("blocked_on_approval");
    return r.state;
  }
  const stages = () => JSON.parse(JSON.stringify(v1.stages)) as Array<Record<string, unknown>>;

  it("a change ahead of the current stage migrates; statuses follow the stage ids", () => {
    const to = { workflow: "m", stages: [...stages().slice(0, 4), { id: "scan", type: "automated_check" }, ...stages().slice(4)] };
    const plan = planInstanceMigration(v1, to, atGate());
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.added).toEqual(["scan"]);
    expect(plan.state.currentStageIndex).toBe(3);
    expect(plan.state.stageStatuses).toEqual(["completed", "completed", "completed", "active", "pending", "pending", "pending"]);
    // and the migrated instance runs on: approving the gate now reaches the new stage
    const def = validateDefinition(to);
    const r = transition(def, plan.state, { kind: "approval_granted", stageId: "gate" });
    expect(r.effects).toContainEqual({ kind: "await_human_trigger", stageId: "scan" });
  });

  it("refuses rewriting the past, skipping a new gate, dropping an undo or changing the current stage", () => {
    const st = atGate();
    const codes = (to: unknown) => {
      const p = planInstanceMigration(v1, to, st);
      return p.ok ? [] : p.refusals.map((r) => r.code);
    };
    const s = stages();
    expect(codes({ workflow: "m", stages: s.filter((x) => x.id !== "req") })).toContain("stage_removed");
    expect(codes({ workflow: "m", stages: s.map((x) => (x.id === "branch" ? { ...x, repo: "o/other" } : x.id === "undo_branch" ? { ...x, repo: "o/other" } : x)) })).toContain("stage_changed");
    expect(codes({ workflow: "m", stages: [s[0], s[1], { id: "extra_gate", type: "human_approval", approvers: ["u"] }, ...s.slice(2)] })).toContain("inserted_before_current");
    expect(codes({ workflow: "m", stages: s.filter((x) => x.id !== "undo_branch") })).toContain("compensation_lost");
    expect(codes({ workflow: "m", stages: s.map((x) => (x.id === "gate" ? { ...x, approvers: ["someone_else"] } : x)) })).toContain("stage_changed");
    expect(codes({ workflow: "m", stages: [s[0], s[2], s[1], ...s.slice(3)] })).toContain("order_changed");
    expect(codes({ workflow: "m", stages: [{ id: "x", type: "planning" }] })).toContain("invalid_target");
  });

  it("refuses an ended or compensating instance", () => {
    const aborted = transition(v1, atGate(), { kind: "abort" });
    expect(aborted.state.compensation).toBeDefined();
    const p1 = planInstanceMigration(v1, v1, aborted.state);
    expect(p1.ok ? null : p1.refusals[0]!.code).toBe("compensating");
    const ended = transition(v1, aborted.state, { kind: "abort" });
    const p2 = planInstanceMigration(v1, v1, ended.state);
    expect(p2.ok ? null : p2.refusals[0]!.code).toBe("terminal");
  });
});
