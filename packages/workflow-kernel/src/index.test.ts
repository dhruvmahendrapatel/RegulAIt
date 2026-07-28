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

  it("a human trigger walks build to the check executor; check success completes", () => {
    let r = transition(standard, initialState(standard), { kind: "start" });
    r = transition(standard, r.state, { kind: "artifact_submitted", stageId: "requirements" });
    r = transition(standard, r.state, { kind: "approval_granted", stageId: "requirements_signoff" });
    r = transition(standard, r.state, { kind: "human_trigger", stageId: "build" });
    // named checks are executed by the gateway, never human-triggered
    expect(r.state.status).toBe("awaiting_execution");
    expect(r.effects).toContainEqual({ kind: "execute_stage", stageId: "checks" });
    expect(() =>
      transition(standard, r.state, { kind: "human_trigger", stageId: "checks" }),
    ).toThrow(/named checks/);
    r = transition(standard, r.state, { kind: "execution_succeeded", stageId: "checks" });
    expect(r.state.status).toBe("completed");
    expect(r.effects).toContainEqual({ kind: "instance_completed" });
  });

  it("a check stage WITHOUT named checks still awaits a human trigger", () => {
    const plain = validateDefinition({
      workflow: "plain-check",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "checks", type: "automated_check" },
      ],
    });
    const started = transition(plain, initialState(plain), { kind: "start" });
    expect(started.state.status).toBe("awaiting_trigger");
    const done = transition(plain, started.state, { kind: "human_trigger", stageId: "checks" });
    expect(done.state.status).toBe("completed");
  });

  it("a failed check stays awaiting execution and is retryable", () => {
    const checked = validateDefinition({
      workflow: "check-retry",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "checks", type: "automated_check", checks: ["ci_tests", "lint"] },
      ],
    });
    let r = transition(checked, initialState(checked), { kind: "start" });
    expect(r.state.status).toBe("awaiting_execution");
    r = transition(checked, r.state, { kind: "execution_failed", stageId: "checks", error: "flake" });
    expect(r.state.status).toBe("awaiting_execution");
    r = transition(checked, r.state, { kind: "execution_succeeded", stageId: "checks" });
    expect(r.state.status).toBe("completed");
  });

  it("a REPORTED check failure parks at blocked_on_check (not retryable-in-place, not advanced)", () => {
    const checked = validateDefinition({
      workflow: "check-fail",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "checks", type: "automated_check", checks: ["ci_tests"] },
        { id: "ship", type: "human_approval", approvers: ["requesting_user"] },
      ],
    });
    let r = transition(checked, initialState(checked), { kind: "start" });
    expect(r.state.status).toBe("awaiting_execution");
    r = transition(checked, r.state, { kind: "check_failed", stageId: "checks", failures: ["ci_tests"] });
    expect(r.state.status).toBe("blocked_on_check");
    // it did NOT advance to the ship gate, and it surfaced the named failures
    expect(r.effects).toContainEqual({ kind: "check_failed", stageId: "checks", failures: ["ci_tests"] });
    // recheck resumes the SAME stage; a clean pass then advances past it
    r = transition(checked, r.state, { kind: "recheck", stageId: "checks" });
    expect(r.state.status).toBe("awaiting_execution");
    expect(r.effects).toContainEqual({ kind: "execute_stage", stageId: "checks" });
    r = transition(checked, r.state, { kind: "execution_succeeded", stageId: "checks" });
    expect(r.state.status).toBe("blocked_on_approval"); // reached the ship gate
  });

  it("check_failed is rejected unless the named-check stage is the one executing; recheck needs blocked_on_check", () => {
    const checked = validateDefinition({
      workflow: "check-guard",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "checks", type: "automated_check", checks: ["ci_tests"] },
      ],
    });
    const started = transition(checked, initialState(checked), { kind: "start" });
    // recheck when not blocked → rejected
    expect(() => transition(checked, started.state, { kind: "recheck", stageId: "checks" })).toThrow(
      /not blocked/,
    );
    // check_failed naming the wrong stage → rejected
    expect(() =>
      transition(checked, started.state, { kind: "check_failed", stageId: "intake", failures: [] }),
    ).toThrow(/not running checks/);
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

describe("git_operation stages", () => {
  const gitFlow = validateDefinition({
    workflow: "git-flow",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "branch", type: "git_operation", action: "create_branch", connection: "gh", repo: "o/r" },
      { id: "pr", type: "git_operation", action: "open_pr", connection: "gh", repo: "o/r" },
      { id: "merge_gate", type: "human_approval", approvers: ["requesting_user"] },
      { id: "merge", type: "git_operation", action: "merge", connection: "gh", repo: "o/r", strategy: "squash" },
    ],
  });

  it("validates ordering and required config", () => {
    expect(() =>
      validateDefinition({
        workflow: "bad",
        stages: [
          { id: "t", type: "trigger" },
          { id: "g", type: "git_operation", action: "open_pr", connection: "gh", repo: "o/r" },
        ],
      }),
    ).toThrow(/needs an earlier create_branch/);
    expect(() =>
      validateDefinition({
        workflow: "bad",
        stages: [
          { id: "t", type: "trigger" },
          { id: "g", type: "git_operation" },
        ],
      }),
    ).toThrow(/needs action, connection, and repo/);
  });

  it("git stages block on execution; success advances, failure stays retryable", () => {
    let r = transition(gitFlow, initialState(gitFlow), { kind: "start" });
    expect(r.state.status).toBe("awaiting_execution");
    expect(r.effects).toContainEqual({ kind: "execute_stage", stageId: "branch" });

    r = transition(gitFlow, r.state, { kind: "execution_failed", stageId: "branch", error: "boom" });
    expect(r.state.status).toBe("awaiting_execution");

    r = transition(gitFlow, r.state, { kind: "execution_succeeded", stageId: "branch" });
    expect(r.state.status).toBe("awaiting_execution");
    expect(r.effects).toContainEqual({ kind: "execute_stage", stageId: "pr" });

    r = transition(gitFlow, r.state, { kind: "execution_succeeded", stageId: "pr" });
    expect(r.state.status).toBe("blocked_on_approval");

    r = transition(gitFlow, r.state, { kind: "approval_granted", stageId: "merge_gate" });
    expect(r.state.status).toBe("awaiting_execution");
    r = transition(gitFlow, r.state, { kind: "execution_succeeded", stageId: "merge" });
    expect(r.state.status).toBe("completed");
  });

  it("rejects execution events for the wrong stage", () => {
    const r = transition(gitFlow, initialState(gitFlow), { kind: "start" });
    expect(() =>
      transition(gitFlow, r.state, { kind: "execution_succeeded", stageId: "merge" }),
    ).toThrow(/not executing stage/);
  });
});

describe("cost-sensitivity tag (§9, EPIC-04)", () => {
  const tagged = (tag: string | undefined, workflow: string) =>
    validateDefinition({
      workflow,
      ...(tag ? { costSensitivity: tag } : {}),
      stages: [{ id: `${workflow}-intake`, type: "trigger" }],
    });

  it("accepts the three tags and rejects anything else", () => {
    for (const tag of ["cost-sensitive", "standard", "quality-sensitive"]) {
      expect(tagged(tag, "w").costSensitivity).toBe(tag);
    }
    expect(() => tagged("cheapest", "w")).toThrow();
  });

  it("a single-template run keeps its own tag", () => {
    expect(mergeDefinitions([tagged("cost-sensitive", "w")]).costSensitivity).toBe("cost-sensitive");
  });

  it("merge is strictest-wins: quality-sensitive beats cost-sensitive", () => {
    const merged = mergeDefinitions([tagged("cost-sensitive", "a"), tagged("quality-sensitive", "b")]);
    expect(merged.costSensitivity).toBe("quality-sensitive");
  });

  it("an untagged template counts as standard, so it blocks cost-sensitive downgrading", () => {
    const merged = mergeDefinitions([tagged("cost-sensitive", "a"), tagged(undefined, "b")]);
    expect(merged.costSensitivity).toBe("standard");
  });
});

describe("automated_build with a nested run (§8)", () => {
  const def = validateDefinition({
    workflow: "nested",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "build", type: "automated_build", run: { any: "opaque graph" } },
    ],
  });

  it("reaching the stage awaits execution and completes via execution_succeeded", () => {
    const started = transition(def, initialState(def), { kind: "start" });
    expect(started.state.status).toBe("awaiting_execution");
    expect(started.effects).toContainEqual({ kind: "execute_stage", stageId: "build" });

    const done = transition(def, started.state, { kind: "execution_succeeded", stageId: "build" });
    expect(done.state.status).toBe("completed");
  });

  it("a human trigger can never bypass the nested run", () => {
    const started = transition(def, initialState(def), { kind: "start" });
    expect(() =>
      transition(def, started.state, { kind: "human_trigger", stageId: "build" }),
    ).toThrow(/nested run/);
  });

  it("a build stage WITHOUT a run still awaits a human trigger", () => {
    const plain = validateDefinition({
      workflow: "plain",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "build", type: "automated_build" },
      ],
    });
    const started = transition(plain, initialState(plain), { kind: "start" });
    expect(started.state.status).toBe("awaiting_trigger");
    const done = transition(plain, started.state, { kind: "human_trigger", stageId: "build" });
    expect(done.state.status).toBe("completed");
  });
});
