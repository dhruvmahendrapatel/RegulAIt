/**
 * ADR-0189 R25 item 13 prevention — the pure parts of the executor's sign-off
 * lookahead, with no database (PR #357 review 1, 2 and 7):
 *  - `completesOnEvent` answers false ONLY for the kernel's own refusal
 *    (`WorkflowStateError`: not executable here) and rethrows anything else,
 *    so a broken lookahead fails closed instead of skipping the guard;
 *  - `checkStageGuardsAtClaim`: a check stage is guarded at its claim only when
 *    paid work would start or every reported check passed; a reported failure
 *    or a pending check defers the guard to the commit, so a CI failure is never
 *    shown as a key problem;
 *  - `standingExecutorRefusal`: an idempotent replay reads back the refusal the
 *    instance still stands on, and nothing once the stage moved on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { initialState, transition, validateDefinition, type InstanceState, type WorkflowDefinition } from "@regulait/workflow-kernel";
import { checkStageGuardsAtClaim, completesOnEvent, OFFLINE_CHECKS_ENV, standingExecutorRefusal } from "./workflows.js";

const savedOffline = process.env[OFFLINE_CHECKS_ENV];
afterEach(() => {
  if (savedOffline === undefined) delete process.env[OFFLINE_CHECKS_ENV];
  else process.env[OFFLINE_CHECKS_ENV] = savedOffline;
});

/** a definition started into its first executor stage */
function started(stages: unknown[]): { def: WorkflowDefinition; state: InstanceState } {
  const def = validateDefinition({ workflow: "lookahead-unit", stages });
  return { def, state: transition(def, initialState(def), { kind: "start" }).state };
}
const BRANCH = { id: "branch", type: "git_operation", action: "create_branch", connection: "c", repo: "o/r" };

describe("completesOnEvent", () => {
  it("true when the stage's success completes the instance, false when a stage follows", () => {
    const last = started([{ id: "intake", type: "trigger" }, BRANCH]);
    expect(last.state.status).toBe("awaiting_execution");
    expect(completesOnEvent(last.def, last.state, { kind: "execution_succeeded", stageId: "branch" })).toBe(true);
    const more = started([{ id: "intake", type: "trigger" }, BRANCH, { id: "done", type: "human_approval", approvers: ["requesting_user"] }]);
    expect(completesOnEvent(more.def, more.state, { kind: "execution_succeeded", stageId: "branch" })).toBe(false);
  });

  it("false for the kernel's own refusal: a stage that is not the one executing", () => {
    const last = started([{ id: "intake", type: "trigger" }, BRANCH]);
    expect(completesOnEvent(last.def, last.state, { kind: "execution_succeeded", stageId: "intake" })).toBe(false);
  });

  it("any other error is rethrown, never read as 'does not complete' (fails closed)", () => {
    const last = started([{ id: "intake", type: "trigger" }, BRANCH]);
    // a definition the kernel cannot even read: a TypeError, not a WorkflowStateError
    const broken = { ...last.def, stages: null } as unknown as WorkflowDefinition;
    expect(() => completesOnEvent(broken, last.state, { kind: "execution_succeeded", stageId: "branch" })).toThrow(TypeError);
  });
});

describe("checkStageGuardsAtClaim", () => {
  const stage = (extra: Record<string, unknown> = {}) =>
    validateDefinition({
      workflow: "lookahead-unit",
      stages: [{ id: "intake", type: "trigger" }, { id: "ci-gate", type: "automated_check", checks: ["ci", "lint"], ...extra }],
    }).stages[1]!;
  const reports = (...r: Array<[string, "passed" | "failed", number?]>) => ({
    "reported:ci-gate": r.map(([check, status, round]) => ({ check, status, ...(round === undefined ? {} : { round }) })),
  });

  it("every reported check passed: guarded at the claim", () => {
    expect(checkStageGuardsAtClaim(stage(), reports(["ci", "passed"], ["lint", "passed"]), 0)).toBe(true);
  });

  it("a reported failure: deferred to the commit (the verdict is the CI's failure, never a key problem)", () => {
    expect(checkStageGuardsAtClaim(stage(), reports(["ci", "failed"], ["lint", "passed"]), 0)).toBe(false);
    expect(checkStageGuardsAtClaim(stage(), reports(["ci", "failed"]), 0)).toBe(false);
  });

  it("a pending check: deferred to the commit (the stage only waits)", () => {
    expect(checkStageGuardsAtClaim(stage(), reports(["ci", "passed"]), 0)).toBe(false);
    expect(checkStageGuardsAtClaim(stage(), {}, 0)).toBe(false);
  });

  it("a report of another round does not count", () => {
    expect(checkStageGuardsAtClaim(stage(), reports(["ci", "passed", 0], ["lint", "passed", 0]), 1)).toBe(false);
  });

  it("paid work (an eval-bound check) starts after the claim: guarded at the claim unless a reported failure decides it", () => {
    const paid = stage({ evals: [{ check: "lint", dataset: "d", agent: "a" }] });
    expect(checkStageGuardsAtClaim(paid, {}, 0)).toBe(true);
    expect(checkStageGuardsAtClaim(paid, reports(["ci", "failed"]), 0)).toBe(false);
  });

  it("offlineAutoPass honoured (a declared offline box): unreported checks count as passed", () => {
    process.env[OFFLINE_CHECKS_ENV] = "1";
    expect(checkStageGuardsAtClaim(stage({ offlineAutoPass: true }), {}, 0)).toBe(true);
  });
});

describe("standingExecutorRefusal", () => {
  const marker = { stageId: "branch", stageEntry: 2, code: "bom_signing_unavailable", at: "2026-10-11T10:00:00+00:00" };
  it("reads the refusal the instance still stands on", () => {
    expect(
      standingExecutorRefusal({ status: "awaiting_execution", stageEntry: 2, context: { signoffRefused: marker, lastError: "branch: no key" } }),
    ).toEqual({ stageId: "branch", code: "bom_signing_unavailable", detail: "no key" });
  });
  it("nothing once the stage moved on, completed, or was re-entered", () => {
    expect(standingExecutorRefusal({ status: "completed", stageEntry: 2, context: { signoffRefused: marker } })).toBeNull();
    expect(standingExecutorRefusal({ status: "awaiting_execution", stageEntry: 3, context: { signoffRefused: marker } })).toBeNull();
    expect(standingExecutorRefusal({ status: "awaiting_execution", stageEntry: 2, context: {} })).toBeNull();
  });
});
