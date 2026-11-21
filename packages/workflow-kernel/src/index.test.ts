import { describe, expect, it } from "vitest";
import {
  assertCompensationStatus,
  closePrSupersededByMerge,
  COMPENSATION_LIFECYCLE,
  compensationStatusFor,
  compensationPhaseOf,
  compensationPlan,
  nextCompensationPhase,
  currentPlanningStage,
  isCompensating,
  initialState,
  isExecutedStage,
  matchTemplates,
  retryDelaySeconds,
  mergeDefinitions,
  transition,
  validateDefinition,
  workflowDefinitionSchema,
  type AssignmentRule,
  type ChangeDescriptor,
  type InstanceState,
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

  it("AER-049: `reopen` takes a COMPLETED instance back to a stage it passed and runs forward from there", () => {
    const intake = validateDefinition({
      workflow: "intake-like",
      stages: [
        { id: "t", type: "trigger" },
        { id: "q", type: "artifact_generation", output: "questionnaire" },
        { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
      ],
    });
    let r = transition(intake, initialState(intake), { kind: "start" });
    r = transition(intake, r.state, { kind: "artifact_submitted", stageId: "q" });
    r = transition(intake, r.state, { kind: "approval_granted", stageId: "signoff" });
    expect(r.state.status).toBe("completed");
    // every other event is still refused on a completed instance
    expect(() => transition(intake, r.state, { kind: "artifact_submitted", stageId: "q" })).toThrow(/terminal/);
    const back = transition(intake, r.state, { kind: "reopen", stageId: "signoff", reason: "recertification" });
    expect(back.state.status).toBe("blocked_on_approval");
    expect(back.state.currentStageIndex).toBe(2);
    expect(back.state.stageStatuses[2]).toBe("active");
    expect(back.state.artifactVersions.questionnaire).toBe(1); // no new artifact version
    expect(back.effects).toEqual([{ kind: "request_approval", stageId: "signoff", approvers: ["requesting_user"] }]);
    // re-opening to the artifact stage runs forward through the existing version into the gate
    const fromQ = transition(intake, r.state, { kind: "reopen", stageId: "q", reason: "change" });
    expect(fromQ.state.status).toBe("blocked_on_approval");
    expect(fromQ.state.stageStatuses[1]).toBe("completed");
  });

  it("AER-049: `reopen` is refused on aborted/denied instances and for a stage not yet passed", () => {
    let r = startedPastPlan();
    expect(() => transition(standard, r.state, { kind: "reopen", stageId: "requirements_signoff", reason: "x" })).toThrow(
      /not before the current stage/,
    );
    expect(() => transition(standard, r.state, { kind: "reopen", stageId: "nope", reason: "x" })).toThrow(/no stage/);
    r = transition(standard, r.state, { kind: "abort" });
    expect(() => transition(standard, r.state, { kind: "reopen", stageId: "requirements", reason: "x" })).toThrow(
      /cannot be re-opened/,
    );
    // denied and rolled_back stay terminal too
    let d = startedPastPlan();
    d = transition(standard, d.state, { kind: "artifact_submitted", stageId: "requirements" });
    d = transition(standard, d.state, { kind: "approval_denied", stageId: "requirements_signoff" });
    expect(d.state.status).toBe("denied");
    expect(() => transition(standard, d.state, { kind: "reopen", stageId: "requirements", reason: "x" })).toThrow(
      /instance is terminal \(denied\) and cannot be re-opened/,
    );
    const rolledBack = { ...d.state, status: "rolled_back" as const };
    expect(() => transition(standard, rolledBack, { kind: "reopen", stageId: "requirements", reason: "x" })).toThrow(
      /instance is terminal \(rolled_back\) and cannot be re-opened/,
    );
  });

  it("AER-049 review: `reopen` targets only a sign-off or artifact stage at or before the first PR / merge / deploy stage", () => {
    const shipping = validateDefinition({
      workflow: "ship",
      stages: [
        { id: "t", type: "trigger" },
        { id: "branch", type: "git_operation", action: "create_branch", connection: "c", repo: "o/r" },
        { id: "req", type: "artifact_generation", output: "requirements_file" },
        { id: "gate", type: "human_approval", approvers: ["requesting_user"] },
        { id: "open_pr", type: "git_operation", action: "open_pr", connection: "c", repo: "o/r" },
        { id: "merge_gate", type: "human_approval", approvers: ["requesting_user"] },
        { id: "merge", type: "git_operation", action: "merge", connection: "c", repo: "o/r" },
      ],
    });
    // a completed instance (every stage passed)
    const done: InstanceState = {
      status: "completed",
      currentStageIndex: shipping.stages.length,
      stageStatuses: shipping.stages.map(() => "completed"),
      artifactVersions: { requirements_file: 1 },
    };
    expect(() => transition(shipping, done, { kind: "reopen", stageId: "merge_gate", reason: "x" })).toThrow(
      /comes after 'open_pr' \(git_operation\)/,
    );
    expect(() => transition(shipping, done, { kind: "reopen", stageId: "open_pr", reason: "x" })).toThrow(
      /is a git_operation stage/,
    );
    expect(() => transition(shipping, done, { kind: "reopen", stageId: "t", reason: "x" })).toThrow(/is a trigger stage/);
    // the positive control: the gate before the first git stage re-opens
    const back = transition(shipping, done, { kind: "reopen", stageId: "gate", reason: "x" });
    // (after a create_branch: that ships nothing, and open_pr cuts the round's branch)
    expect(back.state).toMatchObject({ status: "blocked_on_approval", currentStageIndex: 3 });
    expect(transition(shipping, done, { kind: "reopen", stageId: "req", reason: "x" }).state.status).toBe(
      "blocked_on_approval",
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

describe("ADR-0187 engine bindings (PR #203 review [14])", () => {
  const def = (engine: string) => ({
    workflow: "w",
    stages: [
      { id: "t", type: "trigger" },
      { id: "c", type: "automated_check", checks: ["e"], engines: [{ check: "e", engine, agent: "a", sets: ["basic"] }] },
    ],
  });
  it("binds an agent-target engine, and refuses an artifact-only engine (it can never target an agent)", () => {
    expect(workflowDefinitionSchema.safeParse(def("promptfoo")).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(def("garak")).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse(def("modelscan")).success).toBe(false);
  });
});

describe("ADR-0260 review bindings", () => {
  const def = (stage: Record<string, unknown>) => ({
    workflow: "w",
    stages: [{ id: "i", type: "trigger" }, { id: "c", type: "automated_check", ...stage }],
  });
  const ok = (stage: Record<string, unknown>) => workflowDefinitionSchema.safeParse(def(stage)).success;

  it("accepts a review bound to a declared check, for every profile", () => {
    for (const profile of ["code_review", "security_review", "design_review"]) {
      expect(ok({ checks: ["r"], reviews: [{ check: "r", agent: "reviewer", profile }] })).toBe(true);
    }
  });

  it("refuses an unknown profile, a nit fail-on and an undeclared check", () => {
    expect(ok({ checks: ["r"], reviews: [{ check: "r", agent: "a", profile: "vibes" }] })).toBe(false);
    expect(ok({ checks: ["r"], reviews: [{ check: "r", agent: "a", profile: "code_review", failOn: "nit" }] })).toBe(false);
    expect(ok({ checks: ["x"], reviews: [{ check: "r", agent: "a", profile: "code_review" }] })).toBe(false);
  });

  it("refuses a check decided twice (two reviews, or a review and an eval/engine)", () => {
    const review = { check: "r", agent: "a", profile: "code_review" };
    expect(ok({ checks: ["r"], reviews: [review, review] })).toBe(false);
    expect(ok({ checks: ["r"], reviews: [review], evals: [{ check: "r", dataset: "d", agent: "a" }] })).toBe(false);
    expect(
      ok({ checks: ["r"], reviews: [review], engines: [{ check: "r", engine: "garak", agent: "a", sets: ["s"] }] }),
    ).toBe(false);
  });

  it("refuses review bindings on a stage that is not an automated_check", () => {
    const parsed = workflowDefinitionSchema.safeParse({
      workflow: "w",
      stages: [
        { id: "i", type: "trigger" },
        { id: "p", type: "planning", reviews: [{ check: "r", agent: "a", profile: "code_review" }] },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts the evidence-only opt-in only as a boolean", () => {
    const at = (allowEvidenceOnly: unknown) =>
      ok({ checks: ["r"], reviews: [{ check: "r", agent: "a", profile: "code_review", allowEvidenceOnly }] });
    expect(at(true)).toBe(true);
    expect(at(false)).toBe(true);
    expect(at("yes")).toBe(false);
  });

  it("bounds the answer budget", () => {
    const at = (maxTokens: number) => ok({ checks: ["r"], reviews: [{ check: "r", agent: "a", profile: "code_review", maxTokens }] });
    expect(at(4096)).toBe(true);
    expect(at(100)).toBe(false);
    expect(at(100_000)).toBe(false);
  });
});

describe("ADR-0283: a stage retry policy is an executed-stage-only, bounded opt-in", () => {
  const base = [{ id: "intake", type: "trigger" }] as const;
  const git = { id: "branch", type: "git_operation", action: "create_branch", connection: "gh", repo: "acme/app" } as const;

  it("is absent by default — no automatic retry unless the template opts in", () => {
    const def = validateDefinition({ workflow: "default", stages: [...base, git] });
    expect(def.stages[1]!.retry).toBeUndefined();
  });

  it("fills the delay defaults and keeps the attempts the template set", () => {
    const def = validateDefinition({ workflow: "r", stages: [...base, { ...git, retry: { maxAttempts: 3 } }] });
    expect(def.stages[1]!.retry).toEqual({ maxAttempts: 3, delaySeconds: 30, backoff: true, maxDelaySeconds: 3600 });
  });

  it.each([
    [{ maxAttempts: 0 }],
    [{ maxAttempts: 11 }],
    [{ maxAttempts: 2, delaySeconds: 1 }],
    [{ maxAttempts: 2, delaySeconds: 600, maxDelaySeconds: 60 }],
    [{ maxAttempts: 2, jitter: true }],
    [{ maxAttempts: "3" }],
  ])("refuses an out-of-bounds or unknown policy %j", (retry) => {
    expect(() => validateDefinition({ workflow: "bad", stages: [...base, { ...git, retry }] })).toThrow();
  });

  it.each([
    [{ id: "approve", type: "human_approval", approvers: ["requesting_user"] }],
    [{ id: "checks", type: "automated_check" }],
    [{ id: "build", type: "automated_build", scope: "x" }],
    [{ id: "plan", type: "planning" }],
    // executed, but never re-deployed unattended (#808 review)
    [{ id: "deploy", type: "deployment", connection: "t", environment: "production" }],
  ])("is refused on a stage that does not complete through execution, and on a deployment: %j", (stage) => {
    expect(() =>
      validateDefinition({ workflow: "bad", stages: [...base, { ...stage, retry: { maxAttempts: 2 } }] }),
    ).toThrow(/cannot carry retry/);
  });

  it("is accepted on a check stage with named checks", () => {
    const def = validateDefinition({
      workflow: "ok",
      stages: [
        ...base,
        { id: "checks", type: "automated_check", checks: ["unit"], retry: { maxAttempts: 2 } },
      ],
    });
    expect(isExecutedStage(def.stages[1]!)).toBe(true);
  });

  it("execution_failed still leaves the stage awaiting execution (the retry is the gateway's, never the kernel's)", () => {
    const def = validateDefinition({ workflow: "r", stages: [...base, { ...git, retry: { maxAttempts: 2 } }] });
    const started = transition(def, initialState(def), { kind: "start" });
    expect(started.state.status).toBe("awaiting_execution");
    const failed = transition(def, started.state, { kind: "execution_failed", stageId: "branch", error: "boom" });
    expect(failed.state.status).toBe("awaiting_execution");
    expect(failed.effects).toEqual([]);
  });

  it("retryDelaySeconds doubles from the base delay and never passes the ceiling", () => {
    const p = { maxAttempts: 10, delaySeconds: 30, backoff: true, maxDelaySeconds: 300 };
    expect([1, 2, 3, 4, 5, 6].map((n) => retryDelaySeconds(p, n))).toEqual([30, 60, 120, 240, 300, 300]);
    expect(retryDelaySeconds({ ...p, backoff: false }, 5)).toBe(30);
    expect(() => retryDelaySeconds(p, 0)).toThrow(RangeError);
  });
});

describe("ADR-0285: checkConcurrency is a check-stage-only, bounded setting", () => {
  const base = [{ id: "intake", type: "trigger" }] as const;
  it("is kept on an automated_check stage with named checks and absent by default", () => {
    const def = validateDefinition({ workflow: "fan", stages: [...base, { id: "checks", type: "automated_check", checks: ["a", "b"], checkConcurrency: 3 }] });
    expect(def.stages[1]!.checkConcurrency).toBe(3);
    const none = validateDefinition({ workflow: "seq", stages: [...base, { id: "checks", type: "automated_check", checks: ["a"] }] });
    expect(none.stages[1]!.checkConcurrency).toBeUndefined();
  });
  it.each([[0], [17], [1.5], ["4"]])("refuses %j", (n) => {
    expect(() => validateDefinition({ workflow: "bad", stages: [...base, { id: "checks", type: "automated_check", checks: ["a"], checkConcurrency: n }] })).toThrow();
  });
  it("is refused on any other stage", () => {
    expect(() => validateDefinition({ workflow: "bad", stages: [...base, { id: "checks", type: "automated_check", checkConcurrency: 2 }] })).toThrow(/cannot carry checkConcurrency/);
    expect(() => validateDefinition({ workflow: "bad", stages: [...base, { id: "plan", type: "planning", checkConcurrency: 2 }] })).toThrow(/cannot carry checkConcurrency/);
  });
});

describe("ADR-0340: compensation (saga) stages", () => {
  const sagaStages = [
    { id: "intake", type: "trigger" },
    { id: "branch", type: "git_operation", action: "create_branch", connection: "gh", repo: "o/r" },
    { id: "pr", type: "git_operation", action: "open_pr", connection: "gh", repo: "o/r" },
    { id: "deploy", type: "deployment", connection: "dt", environment: "staging" },
    { id: "merge_gate", type: "human_approval", approvers: ["requesting_user"] },
    { id: "merge", type: "git_operation", action: "merge", connection: "gh", repo: "o/r" },
    { id: "undo_branch", type: "git_operation", action: "delete_branch", connection: "gh", repo: "o/r", compensates: "branch" },
    { id: "undo_pr", type: "git_operation", action: "close_pr", connection: "gh", repo: "o/r", compensates: "pr" },
    { id: "undo_deploy", type: "rollback", connection: "dt", compensates: "deploy" },
    { id: "undo_merge", type: "automated_build", compensates: "merge" },
  ];
  const saga = validateDefinition({ workflow: "saga", stages: sagaStages });

  /** run forward to the merge gate: branch, pr and deploy have run */
  function atGate(): InstanceState {
    let r = transition(saga, initialState(saga), { kind: "start" });
    for (const id of ["branch", "pr", "deploy"]) r = transition(saga, r.state, { kind: "execution_succeeded", stageId: id });
    expect(r.state.status).toBe("blocked_on_approval");
    return r.state;
  }

  it("compensation stages never run in the forward flow", () => {
    let r = transition(saga, atGate(), { kind: "approval_granted", stageId: "merge_gate" });
    expect(r.effects).toContainEqual({ kind: "execute_stage", stageId: "merge" });
    r = transition(saga, r.state, { kind: "execution_succeeded", stageId: "merge" });
    expect(r.state.status).toBe("completed");
    for (const id of ["undo_branch", "undo_pr", "undo_deploy", "undo_merge"]) {
      expect(r.state.stageStatuses[saga.stages.findIndex((s) => s.id === id)]).toBe("pending");
    }
  });

  it("a cancel runs the compensations of the stages that ran, in reverse order, then ends aborted", () => {
    const gate = atGate();
    expect(compensationPlan(saga, gate)).toEqual(["undo_deploy", "undo_pr", "undo_branch"]);
    let r = transition(saga, gate, { kind: "abort" });
    expect(r.effects).toEqual([
      { kind: "compensation_started", cause: "aborted", plan: ["undo_deploy", "undo_pr", "undo_branch"] },
      { kind: "execute_stage", stageId: "undo_deploy" },
    ]);
    expect(r.state.status).toBe("awaiting_execution");
    expect(isCompensating(r.state)).toBe(true);
    expect(r.state.compensation).toMatchObject({ cause: "aborted", fromStageId: "merge_gate" });
    // the rollback compensation ends with rolled_back, which here moves on instead of ending the run
    r = transition(saga, r.state, { kind: "rolled_back", stageId: "undo_deploy" });
    expect(r.effects).toEqual([{ kind: "execute_stage", stageId: "undo_pr" }]);
    // a failed compensation stays where it is, retryable
    r = transition(saga, r.state, { kind: "execution_failed", stageId: "undo_pr", error: "502" });
    expect(r.state.status).toBe("awaiting_execution");
    expect(saga.stages[r.state.currentStageIndex]!.id).toBe("undo_pr");
    r = transition(saga, r.state, { kind: "execution_succeeded", stageId: "undo_pr" });
    r = transition(saga, r.state, { kind: "execution_succeeded", stageId: "undo_branch" });
    expect(r.state.status).toBe("aborted");
    expect(r.state.compensation).toMatchObject({ outcome: "completed", remaining: [] });
    expect(r.effects).toEqual([
      { kind: "compensation_completed", cause: "aborted", plan: ["undo_deploy", "undo_pr", "undo_branch"] },
      { kind: "instance_aborted" },
    ]);
    expect(isCompensating(r.state)).toBe(false);
  });

  it("a denial compensates and ends denied; a manual compensation completes by a person", () => {
    let r = transition(saga, atGate(), { kind: "approval_granted", stageId: "merge_gate" });
    r = transition(saga, r.state, { kind: "execution_succeeded", stageId: "merge" });
    // a completed instance cannot be cancelled (it is terminal) — so deny at a gate instead: use a 2nd gate template
    expect(() => transition(saga, r.state, { kind: "abort" })).toThrow(/terminal/);
    r = transition(saga, atGate(), { kind: "approval_denied", stageId: "merge_gate" });
    expect(r.state.compensation?.cause).toBe("denied");
    expect(r.state.status).toBe("awaiting_execution");
    r = transition(saga, r.state, { kind: "rolled_back", stageId: "undo_deploy" });
    r = transition(saga, r.state, { kind: "execution_succeeded", stageId: "undo_pr" });
    r = transition(saga, r.state, { kind: "execution_succeeded", stageId: "undo_branch" });
    expect(r.state.status).toBe("denied");
    expect(r.effects).toContainEqual({ kind: "instance_denied" });
  });

  it("a merge is undone by a manual task a person completes (never by a git action)", () => {
    const def = validateDefinition({
      workflow: "merge-saga",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "branch", type: "git_operation", action: "create_branch", connection: "gh", repo: "o/r" },
        { id: "pr", type: "git_operation", action: "open_pr", connection: "gh", repo: "o/r" },
        { id: "merge", type: "git_operation", action: "merge", connection: "gh", repo: "o/r" },
        { id: "release_gate", type: "human_approval", approvers: ["requesting_user"] },
        { id: "revert_merge", type: "automated_build", compensates: "merge" },
      ],
    });
    let r = transition(def, initialState(def), { kind: "start" });
    for (const id of ["branch", "pr", "merge"]) r = transition(def, r.state, { kind: "execution_succeeded", stageId: id });
    r = transition(def, r.state, { kind: "approval_denied", stageId: "release_gate" });
    expect(r.state.status).toBe("awaiting_trigger");
    expect(r.effects).toContainEqual({ kind: "await_human_trigger", stageId: "revert_merge" });
    // nothing else moves a compensating instance
    expect(() => transition(def, r.state, { kind: "approval_granted", stageId: "release_gate" })).toThrow(/compensating/);
    expect(() => transition(def, r.state, { kind: "reopen", stageId: "release_gate", reason: "x" })).toThrow(/compensating/);
    r = transition(def, r.state, { kind: "human_trigger", stageId: "revert_merge" });
    expect(r.state.status).toBe("denied");
  });

  it("an abort while compensating abandons the rest, naming what never ran", () => {
    let r = transition(saga, atGate(), { kind: "abort" });
    r = transition(saga, r.state, { kind: "rolled_back", stageId: "undo_deploy" });
    r = transition(saga, r.state, { kind: "abort" });
    expect(r.state.status).toBe("aborted");
    expect(r.state.compensation?.outcome).toBe("abandoned");
    expect(r.effects).toEqual([
      { kind: "compensation_abandoned", cause: "aborted", notRun: ["undo_pr", "undo_branch"] },
      { kind: "instance_aborted" },
    ]);
  });

  it("a stage that never completed is not compensated; no compensations = the old abort", () => {
    let r = transition(saga, initialState(saga), { kind: "start" });
    r = transition(saga, r.state, { kind: "execution_failed", stageId: "branch", error: "x" });
    r = transition(saga, r.state, { kind: "abort" });
    expect(r.state.status).toBe("aborted");
    expect(r.state.compensation).toBeUndefined();
    expect(r.effects).toEqual([{ kind: "instance_aborted" }]);
  });

  it("re-opens ignore compensation stages when finding the first shipping stage", () => {
    const def = validateDefinition({
      workflow: "reopen-saga",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "req", type: "artifact_generation", output: "r" },
        { id: "branch", type: "git_operation", action: "create_branch", connection: "gh", repo: "o/r" },
        { id: "undo_branch", type: "git_operation", action: "delete_branch", connection: "gh", repo: "o/r", compensates: "branch" },
        { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
        { id: "pr", type: "git_operation", action: "open_pr", connection: "gh", repo: "o/r" },
      ],
    });
    let r = transition(def, initialState(def), { kind: "start" });
    r = transition(def, r.state, { kind: "artifact_submitted", stageId: "req" });
    r = transition(def, r.state, { kind: "execution_succeeded", stageId: "branch" });
    expect(r.state.status).toBe("blocked_on_approval");
    r = transition(def, r.state, { kind: "approval_granted", stageId: "signoff" });
    r = transition(def, r.state, { kind: "reopen", stageId: "signoff", reason: "recertify" });
    expect(r.state.status).toBe("blocked_on_approval");
  });

  it("validation: undo actions need compensates; the pairing, repo and uniqueness are checked", () => {
    const base = sagaStages.slice(0, 6);
    const bad = (extra: unknown[], re: RegExp) =>
      expect(() => validateDefinition({ workflow: "bad", stages: [...base, ...extra] })).toThrow(re);
    bad([{ id: "x", type: "git_operation", action: "delete_branch", connection: "gh", repo: "o/r" }], /needs compensates/);
    bad([{ id: "x", type: "git_operation", action: "close_pr", connection: "gh", repo: "o/r", compensates: "branch" }], /cannot compensate 'branch'/);
    bad([{ id: "x", type: "git_operation", action: "delete_branch", connection: "gh", repo: "o/other", compensates: "branch" }], /connection and repo/);
    bad([{ id: "x", type: "rollback", connection: "dt", compensates: "pr" }], /cannot compensate 'pr'/);
    bad([{ id: "x", type: "automated_build", compensates: "merge_gate" }], /cannot compensate 'merge_gate'/);
    bad([{ id: "x", type: "automated_build", compensates: "nope" }], /not a forward stage/);
    bad(
      [
        { id: "x", type: "automated_build", compensates: "branch" },
        { id: "y", type: "git_operation", action: "delete_branch", connection: "gh", repo: "o/r", compensates: "branch" },
      ],
      /more than one compensation/,
    );
    bad(
      [
        { id: "x", type: "automated_build", compensates: "branch" },
        { id: "y", type: "automated_build", compensates: "x" },
      ],
      /not a forward stage/,
    );
  });
});

describe("ADR-0340 rule 12: the compensation lifecycle is one declared table", () => {
  it("pins every allowed move, and refuses anything else", () => {
    expect(COMPENSATION_LIFECYCLE).toEqual({
      none: { cancel: { to: "compensating", status: "stage" }, deny: { to: "compensating", status: "stage" } },
      compensating: {
        step_succeeded: { to: "compensating", status: "stage" },
        step_failed: { to: "compensating", status: "unchanged" },
        last_step_succeeded: { to: "completed", status: "cause" },
        abort: { to: "abandoned", status: "cause" },
      },
      completed: {},
      abandoned: {},
    });
    expect(() => nextCompensationPhase("completed", "abort")).toThrow(/cannot 'abort' from 'completed'/);
    expect(() => nextCompensationPhase("none", "step_succeeded")).toThrow();
    expect(() => nextCompensationPhase("abandoned", "cancel")).toThrow();
  });

  it("an instance's phase follows the table through a real saga", () => {
    const def = validateDefinition({
      workflow: "phase",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "branch", type: "git_operation", action: "create_branch", connection: "gh", repo: "o/r" },
        { id: "gate", type: "human_approval", approvers: ["requesting_user"] },
        { id: "undo", type: "git_operation", action: "delete_branch", connection: "gh", repo: "o/r", compensates: "branch" },
      ],
    });
    let r = transition(def, initialState(def), { kind: "start" });
    r = transition(def, r.state, { kind: "execution_succeeded", stageId: "branch" });
    expect(compensationPhaseOf(r.state)).toBe("none");
    r = transition(def, r.state, { kind: "abort" });
    expect(compensationPhaseOf(r.state)).toBe("compensating");
    expect(r.state.status).toBe("awaiting_execution");
    expect(() => assertCompensationStatus(def, r.state)).not.toThrow();
    r = transition(def, r.state, { kind: "execution_succeeded", stageId: "undo" });
    expect(compensationPhaseOf(r.state)).toBe("completed");
    expect(r.state.status).toBe("aborted");
    expect(compensationStatusFor(def, r.state)).toBe("aborted");
  });

  it("the status each phase implies is checked: a finished saga without its terminal status is refused", () => {
    const def = validateDefinition({
      workflow: "phase-status",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "branch", type: "git_operation", action: "create_branch", connection: "gh", repo: "o/r" },
        { id: "gate", type: "human_approval", approvers: ["requesting_user"] },
        { id: "undo", type: "git_operation", action: "delete_branch", connection: "gh", repo: "o/r", compensates: "branch" },
      ],
    });
    let r = transition(def, initialState(def), { kind: "start" });
    r = transition(def, r.state, { kind: "execution_succeeded", stageId: "branch" });
    expect(compensationStatusFor(def, r.state)).toBeNull();
    r = transition(def, r.state, { kind: "approval_denied", stageId: "gate", approver: "u" } as never);
    expect(r.state.status).toBe("awaiting_execution");
    // a later edit that ends the saga without its outcome, or sets the outcome without the status, is caught
    expect(() => assertCompensationStatus(def, { ...r.state, status: "denied" })).toThrow(/needs status 'awaiting_execution'/);
    const done = transition(def, r.state, { kind: "execution_succeeded", stageId: "undo" }).state;
    expect(done.status).toBe("denied");
    expect(() => assertCompensationStatus(def, { ...done, status: "awaiting_execution" })).toThrow(/needs status 'denied'/);
    // a failed compensation keeps its status (retryable)
    const failed = transition(def, r.state, { kind: "execution_failed", stageId: "undo", error: "x" } as never).state;
    expect(failed.status).toBe("awaiting_execution");
  });
});

describe("ADR-0340: a saga after a merge", () => {
  const stages = [
    { id: "intake", type: "trigger" },
    { id: "branch", type: "git_operation", action: "create_branch", connection: "gh", repo: "o/r" },
    { id: "pr", type: "git_operation", action: "open_pr", connection: "gh", repo: "o/r" },
    { id: "merge", type: "git_operation", action: "merge", connection: "gh", repo: "o/r" },
    { id: "release", type: "human_approval", approvers: ["requesting_user"] },
    { id: "undo_branch", type: "git_operation", action: "delete_branch", connection: "gh", repo: "o/r", compensates: "branch" },
    { id: "undo_pr", type: "git_operation", action: "close_pr", connection: "gh", repo: "o/r", compensates: "pr" },
  ];

  it("a close_pr whose pull request a stage merges needs that merge compensated too", () => {
    expect(() => validateDefinition({ workflow: "m", stages })).toThrow(/closes the pull request that 'merge' merges/);
    expect(() =>
      validateDefinition({ workflow: "m", stages: [...stages, { id: "revert", type: "automated_build", compensates: "merge" }] }),
    ).not.toThrow();
  });

  it("close_pr is superseded only once the merge's own revert completed in this saga", () => {
    const def = validateDefinition({ workflow: "m", stages: [...stages, { id: "revert", type: "automated_build", compensates: "merge" }] });
    let r = transition(def, initialState(def), { kind: "start" });
    for (const id of ["branch", "pr", "merge"]) r = transition(def, r.state, { kind: "execution_succeeded", stageId: id });
    expect(r.state.status).toBe("blocked_on_approval");
    expect(closePrSupersededByMerge(def, r.state, "undo_pr")).toBe(false);
    r = transition(def, r.state, { kind: "abort" });
    expect(r.state.compensation!.plan).toEqual(["revert", "undo_pr", "undo_branch"]);
    expect(closePrSupersededByMerge(def, r.state, "undo_pr")).toBe(false); // the revert has not run yet
    r = transition(def, r.state, { kind: "human_trigger", stageId: "revert" } as never);
    expect(r.state.status).toBe("awaiting_execution");
    expect(closePrSupersededByMerge(def, r.state, "undo_pr")).toBe(true);
    expect(closePrSupersededByMerge(def, r.state, "undo_branch")).toBe(false);
    r = transition(def, r.state, { kind: "execution_succeeded", stageId: "undo_pr" });
    r = transition(def, r.state, { kind: "execution_succeeded", stageId: "undo_branch" });
    expect(r.state.status).toBe("aborted");
    expect(r.state.compensation!.outcome).toBe("completed");
  });
});
