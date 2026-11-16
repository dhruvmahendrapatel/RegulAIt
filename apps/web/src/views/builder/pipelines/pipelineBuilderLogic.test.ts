import { describe, expect, it } from "vitest";
import { historyReducer, isDraftView, issuesByStage, type History } from "./usePipelineDraft";
import { linesToList, parseStageJson } from "./StageProperties";
import { indexAtX } from "./stageDrag";
import { insertStage, newStage, type TemplateDefinition } from "./pipelineCanvasModel";

const def = (): TemplateDefinition => ({
  workflow: "w",
  stages: [
    { id: "intake", type: "trigger" },
    { id: "plan", type: "planning" },
  ],
});

describe("historyReducer (undo and redo)", () => {
  it("records edits, undoes and redoes them, and a new edit clears redo", () => {
    let h: History = historyReducer({ working: null, past: [], future: [] }, { type: "reset", definition: def() });
    const add = (d: TemplateDefinition) => insertStage(d, d.stages.length, newStage(d, "automated_check"));
    h = historyReducer(h, { type: "edit", change: add });
    h = historyReducer(h, { type: "edit", change: add });
    expect(h.working!.stages.map((s) => s.id)).toEqual(["intake", "plan", "automated-check", "automated-check-2"]);
    h = historyReducer(h, { type: "undo" });
    h = historyReducer(h, { type: "undo" });
    expect(JSON.stringify(h.working)).toBe(JSON.stringify(def()));
    expect(historyReducer(h, { type: "undo" })).toBe(h); // nothing left to undo
    h = historyReducer(h, { type: "redo" });
    expect(h.working!.stages).toHaveLength(3);
    h = historyReducer(h, { type: "edit", change: (d) => ({ ...d, workflow: "renamed" }) });
    expect(h.future).toEqual([]);
    expect(historyReducer(h, { type: "redo" })).toBe(h);
  });

  it("ignores an edit that changes nothing, and is pure (the same answer twice)", () => {
    const h: History = { working: def(), past: [], future: [] };
    expect(historyReducer(h, { type: "edit", change: (d) => d })).toBe(h);
    const a = historyReducer(h, { type: "edit", change: (d) => ({ ...d, workflow: "x" }) });
    const b = historyReducer(h, { type: "edit", change: (d) => ({ ...d, workflow: "x" }) });
    expect(a).toEqual(b);
    expect(h.past).toEqual([]);
  });

  it("keeps at most 100 undo steps", () => {
    let h: History = { working: def(), past: [], future: [] };
    for (let i = 0; i < 130; i++) h = historyReducer(h, { type: "edit", change: (d) => ({ ...d, workflow: `w${i}` }) });
    expect(h.past).toHaveLength(100);
  });
});

describe("helpers", () => {
  it("isDraftView refuses an empty or partial answer", () => {
    expect(isDraftView({})).toBe(false);
    expect(isDraftView(null)).toBe(false);
    expect(isDraftView({ template: { name: "t" }, draft: { revision: 1, definition: {} } })).toBe(false);
    expect(isDraftView({ template: { id: "x", name: "t" }, draft: { revision: 1, definition: def() } })).toBe(true);
  });

  it("issuesByStage groups by stage and keeps whole-workflow issues under the empty key", () => {
    const m = issuesByStage([
      { code: "a", message: "a", stageId: "plan", path: [] },
      { code: "b", message: "b", stageId: null, path: [] },
      { code: "c", message: "c", stageId: "plan", path: [] },
    ]);
    expect(m.get("plan")!.map((i) => i.code)).toEqual(["a", "c"]);
    expect(m.get("")!.map((i) => i.code)).toEqual(["b"]);
  });

  it("linesToList reads lines or commas, and an empty list removes the field", () => {
    expect(linesToList("unit\n lint ,e2e\n\n")).toEqual(["unit", "lint", "e2e"]);
    expect(linesToList("  \n ")).toBeUndefined();
  });

  it("parseStageJson accepts a stage and names what is wrong otherwise", () => {
    const others = new Set(["intake"]);
    expect(parseStageJson('{"id":"plan","type":"planning","x":1}', "plan", others)).toEqual({ stage: { id: "plan", type: "planning", x: 1 } });
    expect(parseStageJson("{", "plan", others)).toEqual({ error: "This is not valid JSON." });
    expect(parseStageJson("[]", "plan", others)).toEqual({ error: "A stage is a JSON object." });
    expect(parseStageJson('{"type":"planning"}', "plan", others)).toEqual({ error: "A stage needs an id." });
    expect(parseStageJson('{"id":"intake","type":"planning"}', "plan", others)).toEqual({ error: "Another stage is already called intake." });
  });

  it("indexAtX counts the other stages left of a point", () => {
    const centres = [
      { id: "a", x: 100 },
      { id: "b", x: 400 },
      { id: "c", x: 700 },
    ];
    expect(indexAtX(centres, 50)).toBe(0);
    expect(indexAtX(centres, 500)).toBe(2);
    expect(indexAtX(centres, 800, "a")).toBe(2); // dragging a past c: it lands last
    expect(indexAtX(centres, 50, "c")).toBe(0);
  });
});
