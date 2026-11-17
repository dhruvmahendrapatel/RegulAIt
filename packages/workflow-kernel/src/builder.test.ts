import { describe, expect, it } from "vitest";
import { builderRuleIssues, findRelaxations, stageDiff, validateDefinition, type WorkflowDefinition } from "./index.js";

const APPROVER = "00000000-0000-4000-8000-000000000001";

const standard = (): WorkflowDefinition =>
  validateDefinition({
    workflow: "standard",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "plan", type: "planning" },
      { id: "req", type: "artifact_generation", output: "requirements" },
      { id: "signoff", type: "human_approval", approvers: [APPROVER, "requesting_user"] },
      { id: "build", type: "automated_build", scope: "requirements" },
      { id: "checks", type: "automated_check", checks: ["unit", "lint"] },
    ],
  });

describe("builderRuleIssues (ADR-0341 §4.3, §4.4)", () => {
  it("passes a standard change and a review-only fragment", () => {
    expect(builderRuleIssues(standard())).toEqual([]);
    const fragment = validateDefinition({ workflow: "review", stages: [{ id: "intake", type: "trigger" }, { id: "c", type: "automated_check", checks: ["x"] }] });
    expect(builderRuleIssues(fragment)).toEqual([]);
  });

  it("refuses a build with no planning stage before it (the forced plan gate)", () => {
    const def = standard();
    def.stages = def.stages.filter((s) => s.type !== "planning");
    expect(builderRuleIssues(def).map((i) => [i.code, i.stageId])).toEqual([["plan_gate_missing", "build"]]);
  });

  it("refuses a planning stage that comes only after the first mutating stage", () => {
    const def = validateDefinition({
      workflow: "late-plan",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "build", type: "automated_build" },
        { id: "plan", type: "planning" },
      ],
    });
    expect(builderRuleIssues(def).map((i) => i.code)).toEqual(["plan_gate_missing"]);
  });

  it("refuses a deployment without an earlier sign-off and an earlier named check", () => {
    const bare = validateDefinition({
      workflow: "deploy",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "plan", type: "planning" },
        { id: "ship", type: "deployment", connection: "prod-target" },
      ],
    });
    expect(builderRuleIssues(bare).map((i) => i.code)).toEqual(["deploy_without_signoff", "deploy_without_checks"]);
    const gated = validateDefinition({
      ...bare,
      stages: [bare.stages[0], bare.stages[1], { id: "ok", type: "human_approval", approvers: ["requesting_user"] }, { id: "c", type: "automated_check", checks: ["smoke"] }, bare.stages[2]],
    });
    expect(builderRuleIssues(gated)).toEqual([]);
  });

  it("does not count a check stage with no named checks as the deploy's check", () => {
    const def = validateDefinition({
      workflow: "deploy",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "plan", type: "planning" },
        { id: "ok", type: "human_approval", approvers: ["requesting_user"] },
        { id: "c", type: "automated_check" },
        { id: "ship", type: "deployment", connection: "t" },
      ],
    });
    expect(builderRuleIssues(def).map((i) => i.code)).toEqual(["deploy_without_checks"]);
  });
});

describe("stageDiff", () => {
  it("is empty for the same definition in another key order", () => {
    const a = standard();
    const b = JSON.parse(JSON.stringify(a, Object.keys(a).reverse())) as WorkflowDefinition;
    expect(stageDiff(a, { ...b, stages: a.stages.map((s) => Object.fromEntries(Object.entries(s).reverse()) as typeof s) })).toEqual({
      added: [],
      removed: [],
      changed: [],
      moved: [],
      topLevel: [],
    });
  });

  it("lists added, removed, changed and moved stages", () => {
    const a = standard();
    const b = standard();
    b.stages = [b.stages[0]!, b.stages[2]!, b.stages[1]!, { ...b.stages[3]!, quorum: "any" }, { id: "extra", type: "automated_check", checks: ["e2e"] }];
    const d = stageDiff(a, b);
    expect(d.added).toEqual(["extra"]);
    expect(d.removed).toEqual(["build", "checks"]);
    expect(d.changed).toEqual(["signoff"]);
    expect(d.moved).toEqual(["req", "plan"]);
  });
});

describe("findRelaxations (ADR-0341 §4.5)", () => {
  it("finds nothing in a tightening", () => {
    const a = standard();
    const b = standard();
    b.stages.push({ id: "sec", type: "automated_check", checks: ["sast"] });
    expect(findRelaxations(a, b)).toEqual([]);
  });

  it("finds each kind of relaxation", () => {
    const a = validateDefinition({
      workflow: "w",
      costSensitivity: "quality-sensitive",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "plan", type: "planning" },
        { id: "signoff", type: "human_approval", approvers: [APPROVER, "requesting_user"] },
        { id: "build", type: "automated_build", run: { opaque: true } },
        {
          id: "checks",
          type: "automated_check",
          checks: ["unit", "code_review"],
          reviews: [{ check: "code_review", agent: "reviewer", profile: "code_review" }],
        },
        { id: "extra", type: "automated_check", checks: ["e2e"] },
      ],
    });
    const b = validateDefinition({
      workflow: "w",
      costSensitivity: "cost-sensitive",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "signoff", type: "human_approval", approvers: ["requesting_user"], quorum: "any" },
        { id: "build", type: "automated_build", run: { opaque: true }, retry: { maxAttempts: 2 } },
        {
          id: "checks",
          type: "automated_check",
          checks: ["code_review"],
          offlineAutoPass: true,
          reviews: [{ check: "code_review", agent: "reviewer", profile: "code_review", failOn: "blocker", allowEvidenceOnly: true }],
        },
      ],
    });
    expect(findRelaxations(a, b).map((r) => [r.code, r.stageId]).sort()).toEqual(
      [
        ["approvers_reduced", "signoff"],
        ["checks_removed", "checks"],
        ["cost_sensitivity_relaxed", null],
        ["evidence_only_review_enabled", "checks"],
        ["gate_stage_removed", "extra"],
        ["gate_stage_removed", "plan"],
        ["offline_auto_pass_enabled", "checks"],
        ["quorum_relaxed", "signoff"],
        ["retry_enabled", "build"],
        ["review_fail_on_relaxed", "checks"],
      ].sort(),
    );
  });

  it("treats a gate stage whose type changed as removed", () => {
    const a = standard();
    const b = standard();
    b.stages[3] = { id: "signoff", type: "artifact_generation", output: "x" };
    expect(findRelaxations(a, b).map((r) => r.code)).toContain("gate_stage_removed");
  });
});
