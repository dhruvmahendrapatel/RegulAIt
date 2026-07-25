import { describe, expect, it } from "vitest";
import {
  initialState,
  matchTemplates,
  mergeDefinitions,
  transition,
  validateDefinition,
  type AssignmentRule,
  type ChangeDescriptor,
  type WorkflowDefinition,
} from "./index.js";

const standard: WorkflowDefinition = validateDefinition({
  workflow: "standard-change-workflow",
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "requirements", type: "artifact_generation", output: "requirements_file" },
    { id: "requirements_signoff", type: "human_approval", approvers: ["requesting_user"] },
    { id: "build", type: "automated_build", scope: "requirements_file" },
    { id: "checks", type: "automated_check", checks: ["ci_tests"] },
  ],
});

describe("template validation", () => {
  it("accepts the standard template", () => {
    expect(standard.stages).toHaveLength(6);
  });

  it("rejects duplicate stage ids, missing approvers, unproduced scope, non-trigger start", () => {
    expect(() =>
      validateDefinition({
        workflow: "bad",
        stages: [
          { id: "a", type: "trigger" },
          { id: "a", type: "planning" },
        ],
      }),
    ).toThrow(/duplicate stage id/);
    expect(() =>
      validateDefinition({
        workflow: "bad",
        stages: [
          { id: "t", type: "trigger" },
          { id: "s", type: "human_approval" },
        ],
      }),
    ).toThrow(/at least one approver/);
    expect(() =>
      validateDefinition({
        workflow: "bad",
        stages: [
          { id: "t", type: "trigger" },
          { id: "b", type: "automated_build", scope: "ghost" },
        ],
      }),
    ).toThrow(/no stage produces/);
    expect(() =>
      validateDefinition({ workflow: "bad", stages: [{ id: "p", type: "planning" }] }),
    ).toThrow(/first stage must be a trigger/);
  });

  it("rejects stage types the engine cannot execute yet", () => {
    expect(() =>
      validateDefinition({
        workflow: "bad",
        stages: [
          { id: "t", type: "trigger" },
          { id: "d", type: "deployment" },
        ],
      }),
    ).toThrow();
  });
});

describe("assignment matching + merge (§4)", () => {
  const change: ChangeDescriptor = {
    description: "migrate users table",
    paths: ["db/migrations/0001_users.sql"],
    changeType: "database_migration",
    environment: "production",
  };
  const rules: AssignmentRule[] = [
    { id: "r1", templateId: "tpl-db", pathPattern: "**.sql", changeType: null, environment: null },
    { id: "r2", templateId: "tpl-prod", pathPattern: null, changeType: null, environment: "production" },
    { id: "r3", templateId: "tpl-fe", pathPattern: "frontend/**", changeType: null, environment: null },
    { id: "r4", templateId: "tpl-any", pathPattern: null, changeType: null, environment: null },
  ];

  it("matches on path glob and environment, ANDs conditions, ignores unconditioned rules", () => {
    expect(matchTemplates(change, rules)).toEqual(["tpl-db", "tpl-prod"]);
  });

  it("path patterns respect segment boundaries for single *", () => {
    const r: AssignmentRule[] = [
      { id: "x", templateId: "t", pathPattern: "infra/*", changeType: null, environment: null },
    ];
    expect(
      matchTemplates({ ...change, paths: ["infra/main.tf"] }, r),
    ).toEqual(["t"]);
    expect(matchTemplates({ ...change, paths: ["infra/modules/x.tf"] }, r)).toEqual([]);
  });

  it("merges multiple templates keeping every approval stage, single trigger", () => {
    const stricter: WorkflowDefinition = validateDefinition({
      workflow: "prod-extra",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "compliance_signoff", type: "human_approval", approvers: ["compliance-officer"] },
      ],
    });
    const merged = mergeDefinitions([standard, stricter]);
    expect(merged.stages.filter((s) => s.type === "trigger")).toHaveLength(1);
    expect(merged.stages.map((s) => s.id)).toContain("compliance_signoff");
    expect(merged.stages.filter((s) => s.type === "human_approval")).toHaveLength(2);
  });
});

describe("instance state machine", () => {
  it("start runs to the artifact stage and blocks", () => {
    const { state, effects } = transition(standard, initialState(standard), { kind: "start" });
    expect(state.status).toBe("blocked_on_artifact");
    expect(effects).toContainEqual({
      kind: "await_artifact",
      stageId: "requirements",
      output: "requirements_file",
    });
  });

  it("artifact submission advances to sign-off; approval unblocks to build trigger", () => {
    let r = transition(standard, initialState(standard), { kind: "start" });
    r = transition(standard, r.state, { kind: "artifact_submitted", stageId: "requirements" });
    expect(r.state.status).toBe("blocked_on_approval");
    expect(r.effects).toContainEqual({
      kind: "request_approval",
      stageId: "requirements_signoff",
      approvers: ["requesting_user"],
    });
    expect(r.state.artifactVersions.requirements_file).toBe(1);

    r = transition(standard, r.state, { kind: "approval_granted", stageId: "requirements_signoff" });
    expect(r.state.status).toBe("awaiting_trigger");
    expect(r.effects).toContainEqual({ kind: "await_human_trigger", stageId: "build" });
  });

  it("editing the artifact after sign-off re-opens the sign-off (versioned re-approval, §2)", () => {
    let r = transition(standard, initialState(standard), { kind: "start" });
    r = transition(standard, r.state, { kind: "artifact_submitted", stageId: "requirements" });
    r = transition(standard, r.state, { kind: "approval_granted", stageId: "requirements_signoff" });
    expect(r.state.status).toBe("awaiting_trigger");

    r = transition(standard, r.state, { kind: "artifact_submitted", stageId: "requirements" });
    expect(r.state.status).toBe("blocked_on_approval");
    expect(r.state.artifactVersions.requirements_file).toBe(2);
    expect(r.effects).toContainEqual({
      kind: "request_approval",
      stageId: "requirements_signoff",
      approvers: ["requesting_user"],
    });
  });

  it("denied approval terminates the instance", () => {
    let r = transition(standard, initialState(standard), { kind: "start" });
    r = transition(standard, r.state, { kind: "artifact_submitted", stageId: "requirements" });
    r = transition(standard, r.state, { kind: "approval_denied", stageId: "requirements_signoff" });
    expect(r.state.status).toBe("denied");
    expect(() => transition(standard, r.state, { kind: "approval_granted", stageId: "requirements_signoff" })).toThrow(/terminal/);
  });

  it("human triggers walk build and checks to completion", () => {
    let r = transition(standard, initialState(standard), { kind: "start" });
    r = transition(standard, r.state, { kind: "artifact_submitted", stageId: "requirements" });
    r = transition(standard, r.state, { kind: "approval_granted", stageId: "requirements_signoff" });
    r = transition(standard, r.state, { kind: "human_trigger", stageId: "build" });
    expect(r.state.status).toBe("awaiting_trigger");
    r = transition(standard, r.state, { kind: "human_trigger", stageId: "checks" });
    expect(r.state.status).toBe("completed");
    expect(r.effects).toContainEqual({ kind: "instance_completed" });
  });

  it("rejects out-of-order events", () => {
    const r = transition(standard, initialState(standard), { kind: "start" });
    expect(() => transition(standard, r.state, { kind: "approval_granted", stageId: "requirements_signoff" })).toThrow(
      /not blocked on approval stage/,
    );
    expect(() =>
      transition(standard, r.state, { kind: "human_trigger", stageId: "build" }),
    ).toThrow(/not waiting on stage/);
  });

  it("abort works from any non-terminal state and is terminal", () => {
    const r = transition(standard, initialState(standard), { kind: "start" });
    const aborted = transition(standard, r.state, { kind: "abort" });
    expect(aborted.state.status).toBe("aborted");
    expect(() => transition(standard, aborted.state, { kind: "abort" })).toThrow(/terminal/);
  });
});

describe("review-fix regressions", () => {
  it("an approval event for the wrong stage is rejected (cross-stage forgery)", () => {
    let r = transition(standard, initialState(standard), { kind: "start" });
    r = transition(standard, r.state, { kind: "artifact_submitted", stageId: "requirements" });
    expect(() =>
      transition(standard, r.state, { kind: "approval_granted", stageId: "some_other_stage" }),
    ).toThrow(/not blocked on approval stage 'some_other_stage'/);
  });

  it("merging templates with conflicting same-id stages throws instead of dropping one", () => {
    const a = validateDefinition({
      workflow: "a",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "signoff", type: "human_approval", approvers: ["u1"] },
      ],
    });
    const b = validateDefinition({
      workflow: "b",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "signoff", type: "human_approval", approvers: ["u1", "u2"] },
      ],
    });
    expect(() => mergeDefinitions([a, b])).toThrow(/conflicting configs/);
    // identical duplicates still dedupe fine
    expect(mergeDefinitions([a, a]).stages.filter((s) => s.id === "signoff")).toHaveLength(1);
  });
});
