import { describe, expect, it } from "vitest";
import {
  currentPlanningStage,
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

/**
 * ADR-0079: `standard` opens with a planning stage, and a planning stage now
 * RESTS instead of auto-completing. Every walk that used to run straight from
 * `start` into the artifact stage therefore leaves plan-only explicitly first —
 * this helper is that one extra, deliberate act.
 */
function startedPastPlan(def: WorkflowDefinition = standard) {
  const started = transition(def, initialState(def), { kind: "start" });
  return transition(def, started.state, { kind: "human_trigger", stageId: "plan" });
}

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
    { id: "r1", templateId: "tpl-db", pathPattern: "**.sql", changeType: null, environment: null, targetSystem: null, initiatorRole: null },
    { id: "r2", templateId: "tpl-prod", pathPattern: null, changeType: null, environment: "production", targetSystem: null, initiatorRole: null },
    { id: "r3", templateId: "tpl-fe", pathPattern: "frontend/**", changeType: null, environment: null, targetSystem: null, initiatorRole: null },
    { id: "r4", templateId: "tpl-any", pathPattern: null, changeType: null, environment: null, targetSystem: null, initiatorRole: null },
  ];

  it("matches on path glob and environment, ANDs conditions, ignores unconditioned rules", () => {
    expect(matchTemplates(change, rules)).toEqual(["tpl-db", "tpl-prod"]);
  });

  it("path patterns respect segment boundaries for single *", () => {
    const r: AssignmentRule[] = [
      { id: "x", templateId: "t", pathPattern: "infra/*", changeType: null, environment: null, targetSystem: null, initiatorRole: null },
    ];
    expect(
      matchTemplates({ ...change, paths: ["infra/main.tf"] }, r),
    ).toEqual(["t"]);
    expect(matchTemplates({ ...change, paths: ["infra/modules/x.tf"] }, r)).toEqual([]);
  });

  // ADR-0018 §4 — the two newly-wired dims: target-system and initiator-role.
  it("matches on targetSystem and rejects a mismatch (ANDed like the rest)", () => {
    const r: AssignmentRule[] = [
      { id: "ts", templateId: "tpl-ts", pathPattern: null, changeType: null, environment: null, targetSystem: "checkout-svc", initiatorRole: null },
    ];
    expect(matchTemplates({ ...change, targetSystem: "checkout-svc" }, r)).toEqual(["tpl-ts"]);
    expect(matchTemplates({ ...change, targetSystem: "billing-svc" }, r)).toEqual([]);
    // unset on the change → a targetSystem condition can't match
    expect(matchTemplates(change, r)).toEqual([]);
  });

  it("an initiator-role-scoped rule fires only for a role holder", () => {
    const r: AssignmentRule[] = [
      { id: "ir", templateId: "tpl-ir", pathPattern: null, changeType: null, environment: null, targetSystem: null, initiatorRole: "release-manager" },
    ];
    // holder: the server-derived initiatorRoles carries the role
    expect(matchTemplates({ ...change, initiatorRoles: ["dev", "release-manager"] }, r)).toEqual(["tpl-ir"]);
    // non-holder: role absent → rule does not fire
    expect(matchTemplates({ ...change, initiatorRoles: ["dev"] }, r)).toEqual([]);
    // no roles at all
    expect(matchTemplates(change, r)).toEqual([]);
  });

  it("multi-dim AND: every set condition must hold (target-system + initiator-role together)", () => {
    const r: AssignmentRule[] = [
      { id: "m", templateId: "tpl-m", pathPattern: null, changeType: "feature", environment: null, targetSystem: "checkout-svc", initiatorRole: "release-manager" },
    ];
    const holder = { ...change, changeType: "feature", targetSystem: "checkout-svc", initiatorRoles: ["release-manager"] };
    expect(matchTemplates(holder, r)).toEqual(["tpl-m"]);
    // drop any single dim and it stops matching
    expect(matchTemplates({ ...holder, targetSystem: "other" }, r)).toEqual([]);
    expect(matchTemplates({ ...holder, initiatorRoles: [] }, r)).toEqual([]);
    expect(matchTemplates({ ...holder, changeType: "bugfix" }, r)).toEqual([]);
  });

  // --- ADR-0018 addendum (ADR-0019): the 6th and final dim ---

  it("a data-sensitivity-scoped rule fires only when the change carries that classification", () => {
    const r: AssignmentRule[] = [
      { id: "ds", templateId: "tpl-ds", pathPattern: null, changeType: null, environment: null, targetSystem: null, initiatorRole: null, dataSensitivity: "pci" },
    ];
    // the gateway resolves these from the attributed project's classifications
    expect(matchTemplates({ ...change, dataSensitivities: ["internal", "pci"] }, r)).toEqual(["tpl-ds"]);
    // a differently-classified project does not match
    expect(matchTemplates({ ...change, dataSensitivities: ["internal"] }, r)).toEqual([]);
    // ABSENT means absent: an unclassified project, or no project at all, never
    // matches a sensitivity condition — no sensitivity is ever invented
    expect(matchTemplates({ ...change, dataSensitivities: [] }, r)).toEqual([]);
    expect(matchTemplates(change, r)).toEqual([]);
  });

  it("the 6th dim ANDs with the other five, and an all-null rule still matches nothing", () => {
    const r: AssignmentRule[] = [
      { id: "all", templateId: "tpl-all", pathPattern: null, changeType: "feature", environment: null, targetSystem: null, initiatorRole: "release-manager", dataSensitivity: "pci" },
    ];
    const full = { ...change, changeType: "feature", initiatorRoles: ["release-manager"], dataSensitivities: ["pci"] };
    expect(matchTemplates(full, r)).toEqual(["tpl-all"]);
    expect(matchTemplates({ ...full, dataSensitivities: ["hipaa"] }, r)).toEqual([]);

    const empty: AssignmentRule[] = [
      { id: "none", templateId: "tpl-none", pathPattern: null, changeType: null, environment: null, targetSystem: null, initiatorRole: null, dataSensitivity: null },
    ];
    expect(matchTemplates(full, empty)).toEqual([]);
  });

  it("an omitted dataSensitivity is unconstrained — a pre-6th-dim rule keeps matching exactly as before", () => {
    // the field is optional on the interface, so an older fixture/rule that
    // never mentions it behaves identically (back-compat, not a silent deny)
    const r: AssignmentRule[] = [
      { id: "legacy", templateId: "tpl-legacy", pathPattern: null, changeType: "feature", environment: null, targetSystem: null, initiatorRole: null },
    ];
    expect(matchTemplates({ ...change, changeType: "feature" }, r)).toEqual(["tpl-legacy"]);
    expect(
      matchTemplates({ ...change, changeType: "feature", dataSensitivities: ["pci"] }, r),
    ).toEqual(["tpl-legacy"]);
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
  // §2 stage 2 (ADR-0079): start no longer runs THROUGH the planning stage —
  // it comes to rest ON it. That resting point is the whole enforcement hook.
  it("start comes to rest AT the planning stage, not through it", () => {
    const { state, effects } = transition(standard, initialState(standard), { kind: "start" });
    expect(state.status).toBe("blocked_on_plan");
    expect(effects).toContainEqual({ kind: "await_plan", stageId: "plan" });
    // the trigger before it still auto-completes; planning is ACTIVE, not done
    expect(state.stageStatuses[0]).toBe("completed");
    expect(state.stageStatuses[1]).toBe("active");
    expect(currentPlanningStage(standard, state)?.id).toBe("plan");
  });

  it("leaving plan-only is an explicit act, and only then does the artifact stage block", () => {
    const { state, effects } = startedPastPlan();
    expect(state.status).toBe("blocked_on_artifact");
    expect(state.stageStatuses[1]).toBe("completed");
    expect(currentPlanningStage(standard, state)).toBeNull();
    expect(effects).toContainEqual({
      kind: "await_artifact",
      stageId: "requirements",
      output: "requirements_file",
    });
  });

  it("currentPlanningStage is null on a terminal instance even at a planning index", () => {
    const started = transition(standard, initialState(standard), { kind: "start" });
    expect(currentPlanningStage(standard, started.state)?.id).toBe("plan");
    const aborted = transition(standard, started.state, { kind: "abort" });
    expect(aborted.state.currentStageIndex).toBe(1); // still sitting on 'plan'
    expect(currentPlanningStage(standard, aborted.state)).toBeNull();
  });

  it("artifact submission advances to sign-off; approval unblocks to build trigger", () => {
    let r = startedPastPlan();
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
    let r = startedPastPlan();
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
    let r = startedPastPlan();
    r = transition(standard, r.state, { kind: "artifact_submitted", stageId: "requirements" });
    r = transition(standard, r.state, { kind: "approval_denied", stageId: "requirements_signoff" });
    expect(r.state.status).toBe("denied");
    expect(() => transition(standard, r.state, { kind: "approval_granted", stageId: "requirements_signoff" })).toThrow(/terminal/);
  });

  it("ADR-0168: a returned approval rests at the preceding artifact stage until a NEW version", () => {
    let r = startedPastPlan();
    r = transition(standard, r.state, { kind: "artifact_submitted", stageId: "requirements" });
    expect(r.state.status).toBe("blocked_on_approval");
    r = transition(standard, r.state, { kind: "approval_returned", stageId: "requirements_signoff" });
    expect(r.state.status).toBe("blocked_on_artifact");
    expect(r.state.currentStageIndex).toBe(2);
    expect(r.state.stageStatuses[2]).toBe("active");
    expect(r.state.stageStatuses[3]).toBe("reopened");
    expect(r.effects).toEqual([{ kind: "await_artifact", stageId: "requirements", output: "requirements_file" }]);
    // no decision on the returned gate is possible any more
    expect(() =>
      transition(standard, r.state, { kind: "approval_granted", stageId: "requirements_signoff" }),
    ).toThrow(/not blocked on approval/);
    // a new version re-requests the sign-off
    r = transition(standard, r.state, { kind: "artifact_submitted", stageId: "requirements" });
    expect(r.state.status).toBe("blocked_on_approval");
    expect(r.state.artifactVersions.requirements_file).toBe(2);
    expect(r.effects).toContainEqual({
      kind: "request_approval",
      stageId: "requirements_signoff",
      approvers: ["requesting_user"],
    });
  });

  it("ADR-0168: returning is refused off an approval gate, or with no artifact stage before it", () => {
    let r = startedPastPlan();
    expect(() =>
      transition(standard, r.state, { kind: "approval_returned", stageId: "requirements_signoff" }),
    ).toThrow(/not blocked on approval/);
    const noArtifact = validateDefinition({
      workflow: "no-artifact",
      stages: [
        { id: "t", type: "trigger" },
        { id: "s", type: "human_approval", approvers: ["requesting_user"] },
      ],
    });
    r = transition(noArtifact, initialState(noArtifact), { kind: "start" });
    expect(() => transition(noArtifact, r.state, { kind: "approval_returned", stageId: "s" })).toThrow(
      /no preceding artifact stage/,
    );
  });

  it("a human trigger walks build to the check executor; check success completes", () => {
    let r = startedPastPlan();
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

  it("deploy → verify(pass) completes; a deploy stage runs via the executor", () => {
    const dep = validateDefinition({
      workflow: "deploy-ok",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "deploy", type: "deployment", connection: "prod-target", environment: "production" },
        { id: "verify", type: "automated_check", checks: ["smoke"], onFailure: "rollback", rollbackStageId: "undo" },
        { id: "undo", type: "rollback", connection: "prod-target" },
      ],
    });
    let r = transition(dep, initialState(dep), { kind: "start" });
    // parks awaiting the deploy executor
    expect(r.state.status).toBe("awaiting_execution");
    expect(r.effects).toContainEqual({ kind: "execute_stage", stageId: "deploy" });
    r = transition(dep, r.state, { kind: "execution_succeeded", stageId: "deploy" });
    // advances into the verify check
    expect(r.state.status).toBe("awaiting_execution");
    expect(r.effects).toContainEqual({ kind: "execute_stage", stageId: "verify" });
    r = transition(dep, r.state, { kind: "execution_succeeded", stageId: "verify" });
    expect(r.state.status).toBe("completed");
  });

  it("a post-deploy verify FAILURE with onFailure:rollback jumps straight to the rollback stage → rolled_back", () => {
    const dep = validateDefinition({
      workflow: "deploy-rollback",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "deploy", type: "deployment", connection: "prod-target" },
        { id: "verify", type: "automated_check", checks: ["smoke"], onFailure: "rollback", rollbackStageId: "undo" },
        { id: "undo", type: "rollback", connection: "prod-target" },
        { id: "done", type: "human_approval", approvers: ["requesting_user"] },
      ],
    });
    let r = transition(dep, initialState(dep), { kind: "start" });
    r = transition(dep, r.state, { kind: "execution_succeeded", stageId: "deploy" });
    // verify fails → NOT blocked_on_check; it routes to the rollback executor
    r = transition(dep, r.state, { kind: "check_failed", stageId: "verify", failures: ["smoke"] });
    expect(r.state.status).toBe("awaiting_execution");
    expect(r.effects).toContainEqual({ kind: "execute_stage", stageId: "undo" });
    expect(r.effects).toContainEqual({ kind: "check_failed", stageId: "verify", failures: ["smoke"] });
    // the rollback executor finishing ends the run at the terminal rolled_back
    r = transition(dep, r.state, { kind: "rolled_back", stageId: "undo" });
    expect(r.state.status).toBe("rolled_back");
    expect(r.effects).toContainEqual({ kind: "instance_rolled_back", stageId: "undo" });
    // terminal: no further events
    expect(() => transition(dep, r.state, { kind: "recheck", stageId: "verify" })).toThrow(/terminal/);
  });

  it("a deploy that cannot proceed parks at blocked_on_deploy; an override advances past it", () => {
    const dep = validateDefinition({
      workflow: "deploy-handoff",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "deploy", type: "deployment", connection: "missing-target" },
        { id: "done", type: "human_approval", approvers: ["requesting_user"] },
      ],
    });
    let r = transition(dep, initialState(dep), { kind: "start" });
    r = transition(dep, r.state, { kind: "deploy_blocked", stageId: "deploy", reason: "no deploy target 'missing-target'" });
    expect(r.state.status).toBe("blocked_on_deploy");
    expect(r.effects).toContainEqual({ kind: "await_manual_deploy", stageId: "deploy", reason: "no deploy target 'missing-target'" });
    // override → advances to the final gate
    r = transition(dep, r.state, { kind: "deploy_override", stageId: "deploy" });
    expect(r.state.status).toBe("blocked_on_approval");
  });

  it("rejects a deploy/rollback stage without a target, and onFailure:rollback without a rollback stage", () => {
    expect(() =>
      validateDefinition({
        workflow: "bad-deploy",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "deploy", type: "deployment" },
        ],
      }),
    ).toThrow(/needs a deploy target/);
    expect(() =>
      validateDefinition({
        workflow: "bad-rollback-link",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "verify", type: "automated_check", checks: ["x"], onFailure: "rollback" },
        ],
      }),
    ).toThrow(/no rollbackStageId/);
    expect(() =>
      validateDefinition({
        workflow: "rollback-points-at-nonrollback",
        stages: [
          { id: "intake", type: "trigger" },
          { id: "verify", type: "automated_check", checks: ["x"], onFailure: "rollback", rollbackStageId: "done" },
          { id: "done", type: "human_approval", approvers: ["requesting_user"] },
        ],
      }),
    ).toThrow(/not a rollback stage/);
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
    let r = startedPastPlan();
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

describe("AER-047: offlineAutoPass is a typed, check-stage-only opt-in", () => {
  const base = [{ id: "intake", type: "trigger" }] as const;

  it("is kept (not stripped) on an automated_check stage with named checks", () => {
    const def = validateDefinition({
      workflow: "opt-in",
      stages: [...base, { id: "checks", type: "automated_check", checks: ["unit_tests"], offlineAutoPass: true }],
    });
    expect(def.stages[1]!.offlineAutoPass).toBe(true);
    const absent = validateDefinition({
      workflow: "default",
      stages: [...base, { id: "checks", type: "automated_check", checks: ["unit_tests"] }],
    });
    // the DEFAULT is no opt-in: an unreported check stays pending at the gateway
    expect(absent.stages[1]!.offlineAutoPass).toBeUndefined();
  });

  it("must be a boolean — a stringly 'true' is refused, never coerced", () => {
    expect(() =>
      validateDefinition({
        workflow: "bad",
        stages: [...base, { id: "checks", type: "automated_check", checks: ["unit_tests"], offlineAutoPass: "true" }],
      }),
    ).toThrow();
  });

  it("is refused on any other stage type, and on a check stage with no named checks", () => {
    expect(() =>
      validateDefinition({
        workflow: "bad",
        stages: [...base, { id: "build", type: "automated_build", offlineAutoPass: true }],
      }),
    ).toThrow(/cannot carry offlineAutoPass/);
    expect(() =>
      validateDefinition({
        workflow: "bad",
        stages: [...base, { id: "checks", type: "automated_check", offlineAutoPass: true }],
      }),
    ).toThrow(/cannot carry offlineAutoPass/);
  });

  it("changes nothing in the state machine: the stage still awaits the check executor", () => {
    const def = validateDefinition({
      workflow: "opt-in",
      stages: [...base, { id: "checks", type: "automated_check", checks: ["unit_tests"], offlineAutoPass: true }],
    });
    const started = transition(def, initialState(def), { kind: "start" });
    expect(started.state.status).toBe("awaiting_execution");
    expect(() =>
      transition(def, started.state, { kind: "human_trigger", stageId: "checks" }),
    ).toThrow(/cannot be human-triggered/);
  });
});
