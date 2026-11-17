import { describe, expect, it } from "vitest";
import {
  builderRuleIssues,
  collapseCalls,
  expandCalls,
  fragmentVersionState,
  FRAGMENT_VERSION_STATES,
  validateDefinition,
  validateFragmentStages,
} from "./index.js";

const FRAG = "11111111-1111-4111-8111-111111111111";
const review = [
  { id: "plan", type: "planning" },
  { id: "sign-off", type: "human_approval", approvers: ["requesting_user"] },
  { id: "checks", type: "automated_check", checks: ["unit"], onFailure: "rollback", rollbackStageId: "undo" },
  { id: "undo", type: "rollback", connection: "c" },
];
const draft = {
  workflow: "w",
  stages: [{ id: "intake", type: "trigger" }, { id: "review", type: "call", fragment: FRAG, version: 2 }, { id: "build", type: "automated_build" }],
};
const resolve = (id: string, v: number) => (id === FRAG && v === 2 ? review : null);

describe("fragment version states (rule 12)", () => {
  it("only an approved version is listed or callable, and an unknown status fails closed", () => {
    expect(fragmentVersionState("pending")).toBe("pending_approval");
    expect(fragmentVersionState("approved")).toBe("approved");
    expect(fragmentVersionState("denied")).toBe("rejected");
    expect(fragmentVersionState("superseded")).toBe("rejected");
    expect(fragmentVersionState(undefined)).toBe("rejected");
    const callable = Object.entries(FRAGMENT_VERSION_STATES).filter(([, s]) => s.callable).map(([k]) => k);
    expect(callable).toEqual(["approved"]);
    expect(FRAGMENT_VERSION_STATES.pending_approval.next).toEqual(["approved", "rejected"]);
  });
});

describe("validateFragmentStages", () => {
  it("accepts stages with an internal rollback target", () => {
    const r = validateFragmentStages(review);
    expect(r.ok).toBe(true);
  });
  it("refuses an empty list, a trigger, a nested call, a dotted id and a schema error", () => {
    expect(validateFragmentStages([])).toMatchObject({ ok: false, issues: [{ code: "fragment_empty" }] });
    expect(validateFragmentStages([{ id: "t", type: "trigger" }])).toMatchObject({ ok: false, issues: [{ code: "fragment_trigger" }] });
    expect(validateFragmentStages([{ id: "c", type: "call", fragment: FRAG, version: 1 }])).toMatchObject({ ok: false, issues: [{ code: "fragment_call" }] });
    expect(validateFragmentStages([{ id: "a.b", type: "planning" }])).toMatchObject({ ok: false, issues: [{ code: "fragment_stage_id" }] });
    const bad = validateFragmentStages([{ id: "x", type: "human_approval" }]);
    expect(bad).toMatchObject({ ok: false, issues: [{ code: "fragment_schema" }] });
    // a rollback target outside the fragment does not resolve
    expect(validateFragmentStages([review[2]])).toMatchObject({ ok: false });
  });
});

describe("expandCalls and collapseCalls", () => {
  it("expands a pinned call into prefixed stages that the kernel and the builder rules accept", () => {
    const r = expandCalls(draft, resolve);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const def = validateDefinition(r.definition);
    expect(def.stages.map((s) => s.id)).toEqual(["intake", "review.plan", "review.sign-off", "review.checks", "review.undo", "build"]);
    expect(def.stages[3]!.rollbackStageId).toBe("review.undo");
    // the plan gate is met by the fragment's planning stage
    expect(builderRuleIssues(def)).toEqual([]);
    expect(r.calls).toEqual([{ callStageId: "review", fragmentId: FRAG, version: 2, stages: review }]);
  });

  it("refuses an unapproved or unknown version and a call stage with an extra field", () => {
    const unknown = { ...draft, stages: [draft.stages[0], { ...draft.stages[1], version: 3 }] };
    expect(expandCalls(unknown, resolve)).toMatchObject({ ok: false, issues: [{ code: "call_unresolved", stageId: "review" }] });
    const extra = { ...draft, stages: [draft.stages[0], { ...draft.stages[1], approvers: ["x"] }] };
    expect(expandCalls(extra, resolve)).toMatchObject({ ok: false, issues: [{ code: "call_schema", stageId: "review" }] });
  });

  it("leaves a definition with no call untouched", () => {
    const plain = { workflow: "w", stages: [{ id: "intake", type: "trigger" }] };
    const r = expandCalls(plain, resolve);
    expect(r).toEqual({ ok: true, definition: plain, calls: [] });
  });

  it("collapses a published expansion back into the call, byte for byte", () => {
    const r = expandCalls(draft, resolve);
    if (!r.ok) throw new Error("expected ok");
    const back = collapseCalls(validateDefinition(r.definition), r.calls);
    expect(JSON.stringify(back)).toBe(JSON.stringify(draft));
  });

  it("leaves an expansion that was changed in place expanded", () => {
    const r = expandCalls(draft, resolve);
    if (!r.ok) throw new Error("expected ok");
    const def = validateDefinition(r.definition);
    const edited = { ...def, stages: def.stages.map((s) => (s.id === "review.plan" ? { ...s, output: "x" } : s)) };
    expect(collapseCalls(edited, r.calls).stages).toHaveLength(6);
  });
});
