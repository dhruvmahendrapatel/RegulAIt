import { describe, expect, it } from "vitest";
import {
  freshStageId,
  fromCanvas,
  insertStage,
  moveStage,
  newStage,
  removeStage,
  setRollbackTarget,
  STAGE_TYPE_INFO,
  STAGE_TYPES,
  stageSentence,
  toCanvas,
  updateStage,
  type TemplateDefinition,
} from "./pipelineCanvasModel";

/** a definition with every stage type and every optional field the kernel knows, plus opaque content */
const everything = (): TemplateDefinition => ({
  workflow: "everything",
  costSensitivity: "quality-sensitive",
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
    { id: "req", type: "artifact_generation", output: "requirements_file" },
    { id: "signoff", type: "human_approval", approvers: ["requesting_user", "00000000-0000-4000-8000-000000000001"], quorum: "all" },
    {
      id: "build",
      type: "automated_build",
      scope: "requirements_file",
      run: { lead: { agent: "lead" }, nodes: [{ id: "n1", deps: [] }], escalationApproverUserId: "u" },
      retry: { maxAttempts: 2, delaySeconds: 30, backoff: true, maxDelaySeconds: 3600 },
    },
    {
      id: "checks",
      type: "automated_check",
      checks: ["unit", "evals", "redteam", "code_review"],
      offlineAutoPass: false,
      checkConcurrency: 2,
      evals: [{ check: "evals", dataset: "golden", version: 3, agent: "a", tolerance: 0.05, requireBaseline: true }],
      engines: [{ check: "redteam", engine: "promptfoo", agent: "a", sets: ["owasp"], params: { depth: 2 }, trials: 3, budgetUsd: 5 }],
      reviews: [{ check: "code_review", agent: "reviewer", profile: "code_review", failOn: "medium", maxTokens: 4096 }],
    },
    { id: "branch", type: "git_operation", action: "create_branch", connection: "gh", repo: "o/r", base: "main", branchPrefix: "rg" },
    { id: "pr", type: "git_operation", action: "open_pr", connection: "gh", repo: "o/r" },
    { id: "merge", type: "git_operation", action: "merge", connection: "gh", repo: "o/r", strategy: "merge" },
    { id: "ship", type: "deployment", connection: "target", environment: "staging", condition: { field: "environment", equals: "staging" } },
    { id: "verify", type: "automated_check", checks: ["smoke"], onFailure: "rollback", rollbackStageId: "undo" },
    { id: "undo", type: "rollback", connection: "target" },
  ],
});

/** the built-in gallery's shapes, as `apps/gateway/src/template-gallery.ts` declares them (placeholders as text) */
const gallery = (): TemplateDefinition[] => [
  {
    workflow: "standard-change",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "plan", type: "planning" },
      { id: "requirements", type: "artifact_generation", output: "requirements_file" },
      { id: "signoff", type: "human_approval", approvers: ["<approver>"] },
    ],
  },
  {
    workflow: "code-review-check",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "code-review", type: "automated_check", checks: ["code_review"], reviews: [{ check: "code_review", agent: "<reviewer>", profile: "code_review" }] },
    ],
  },
  {
    workflow: "hotfix",
    stages: [
      { id: "intake", type: "trigger" },
      { id: "plan", type: "planning" },
      { id: "build", type: "automated_build" },
      { id: "checks", type: "automated_check", checks: ["unit_tests", "smoke"] },
      { id: "signoff", type: "human_approval", approvers: ["<approver>"] },
    ],
  },
];

const bytes = (d: unknown) => JSON.stringify(d);

describe("round trip (ADR-0341 §2)", () => {
  it("definition -> canvas -> definition is the identity, byte for byte, key order included", () => {
    for (const d of [everything(), ...gallery()]) {
      const before = bytes(d);
      expect(bytes(fromCanvas(d, toCanvas(d)))).toBe(before);
      // and the projection never mutates its input
      expect(bytes(d)).toBe(before);
    }
  });

  it("keeps top-level fields the builder does not know about, in place", () => {
    const d = { workflow: "w", future: { x: 1 }, stages: [{ id: "intake", type: "trigger", alsoFuture: [1, 2] }] } as TemplateDefinition;
    expect(bytes(fromCanvas(d, toCanvas(d)))).toBe(bytes(d));
  });

  it("derives one order edge per adjacent pair and a rollback edge only to a stage that exists", () => {
    const c = toCanvas(everything());
    expect(c.nodes.map((n) => n.id)).toEqual(everything().stages.map((s) => s.id));
    expect(c.edges.filter((e) => e.kind === "next")).toHaveLength(everything().stages.length - 1);
    expect(c.edges.filter((e) => e.kind === "rollback")).toEqual([{ id: "rollback:verify:undo", from: "verify", to: "undo", kind: "rollback" }]);
    const dangling = updateStage(everything(), "verify", { rollbackStageId: "nowhere" });
    expect(toCanvas(dangling).edges.some((e) => e.kind === "rollback")).toBe(false);
  });

  it("an edit followed by its inverse returns the original bytes", () => {
    const d = everything();
    const s = newStage(d, "automated_check");
    expect(bytes(removeStage(insertStage(d, 3, s), s.id))).toBe(bytes(d));
    expect(bytes(moveStage(moveStage(d, "req", 6), "req", 2))).toBe(bytes(d));
    const renamed = updateStage(d, "undo", { id: "revert" });
    expect(renamed.stages.find((x) => x.id === "verify")!.rollbackStageId).toBe("revert");
    expect(bytes(updateStage(renamed, "revert", { id: "undo" }))).toBe(bytes(d));
    // a field set then cleared is gone, and the other keys keep their order
    expect(bytes(updateStage(updateStage(d, "plan", { note: "x" }), "plan", { note: undefined }))).toBe(bytes(d));
  });
});

describe("edits", () => {
  it("inserts at a clamped position and refuses a duplicate id", () => {
    const d = gallery()[0]!;
    const s = newStage(d, "automated_build");
    expect(insertStage(d, 99, s).stages.at(-1)!.id).toBe("automated-build");
    expect(insertStage(d, -5, s).stages[0]!.id).toBe("automated-build");
    expect(() => insertStage(d, 1, { id: "plan", type: "planning" })).toThrow(/already exists/);
  });

  it("removing a rollback stage clears the check's target", () => {
    const d = removeStage(everything(), "undo");
    const verify = d.stages.find((s) => s.id === "verify")!;
    expect(verify.rollbackStageId).toBeUndefined();
    expect(verify.onFailure).toBe("rollback");
  });

  it("sets and clears a rollback target", () => {
    const d = setRollbackTarget(everything(), "verify", null);
    expect(d.stages.find((s) => s.id === "verify")).toEqual({ id: "verify", type: "automated_check", checks: ["smoke"] });
    expect(bytes(setRollbackTarget(d, "verify", "undo"))).toBe(bytes(everything()));
  });

  it("refuses a rename onto an existing id; an unknown move is a no-op", () => {
    expect(() => updateStage(everything(), "plan", { id: "intake" })).toThrow(/already exists/);
    const d = everything();
    expect(moveStage(d, "nope", 1)).toBe(d);
    expect(moveStage(d, "plan", 1)).toBe(d);
  });

  it("fresh ids never collide", () => {
    const d = everything();
    expect(freshStageId(d, "automated_check")).toBe("automated-check");
    const d2 = insertStage(d, 1, newStage(d, "automated_check"));
    expect(freshStageId(d2, "automated_check")).toBe("automated-check-2");
  });

  it("every palette type has a starter and describes itself", () => {
    for (const t of STAGE_TYPES) {
      expect(STAGE_TYPE_INFO[t].description.length).toBeGreaterThan(10);
      expect(newStage(everything(), t).type).toBe(t);
    }
    expect(stageSentence(everything().stages[1]!, 1, 12, 2)).toBe("Step 2 of 12: Plan only stage plan, 2 problems");
  });
});
