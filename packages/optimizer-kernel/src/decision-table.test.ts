import { describe, expect, it } from "vitest";
import { DECISION_TABLE_LIMITS, compileDecisionTable, renderDecisionTable, type DecisionTableBody } from "./decision-table.js";
import { applyInducedRule, encodeCellKey } from "./rule-induction.js";

const triage: DecisionTableBody = {
  fields: ["source", "severity"],
  rows: [
    { when: { severity: "high", source: ["phone", "pager"] }, then: "on-call" },
    { when: { severity: "low", source: "email" }, then: "  queue  " },
  ],
};

describe("compileDecisionTable", () => {
  it("compiles to the exact-match rule the detector's engine applies, falling back outside the table", () => {
    const out = compileDecisionTable(triage);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rule.fields).toEqual(["severity", "source"]);
    expect(out.cells).toBe(3);
    expect(applyInducedRule(out.rule, { severity: "high", source: "pager" })).toEqual({ matched: true, output: "on-call" });
    expect(applyInducedRule(out.rule, { severity: "low", source: "email" })).toEqual({ matched: true, output: "queue" });
    expect(applyInducedRule(out.rule, { severity: "low", source: "phone" })).toEqual({ matched: false });
    // a value of another type is another value
    expect(applyInducedRule(out.rule, { severity: "high", source: 1 })).toEqual({ matched: false });
  });

  it("refuses two rows that cover the same input, whatever the row order", () => {
    const out = compileDecisionTable({
      fields: ["severity"],
      rows: [
        { when: { severity: ["high", "low"] }, then: "a" },
        { when: { severity: "low" }, then: "b" },
        { when: { severity: "high" }, then: "a" },
      ],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problems.map((p) => p.code)).toEqual(["conflicting_rows", "duplicate_row"]);
  });

  it("detects overlap with the engine's own cell key: every distinct key compiles, and each matches its own row", () => {
    // values that look alike but are different inputs to the engine: the compiler must not merge them
    const lookalikes = ["1", 1, "true", true, "null", null, "", 0, false];
    const out = compileDecisionTable({ fields: ["v"], rows: lookalikes.map((v, i) => ({ when: { v }, then: `row ${i}` })) });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    if (!out.ok) return;
    expect(new Set(out.rule.cells.map((c) => encodeCellKey(c.key))).size).toBe(lookalikes.length);
    lookalikes.forEach((v, i) => expect(applyInducedRule(out.rule, { v })).toEqual({ matched: true, output: `row ${i}` }));
  });

  it("reports every row problem at once", () => {
    const out = compileDecisionTable({
      fields: ["a", "b"],
      rows: [
        { when: { a: 1, c: 2 }, then: "x" },
        { when: { a: [], b: 1 }, then: "   " },
        { when: { a: Number.NaN as unknown as number, b: 1 }, then: "x".repeat(DECISION_TABLE_LIMITS.maxOutputLength + 1) },
      ],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.problems.map((p) => p.code)).toEqual([
      "unknown_field",
      "missing_condition",
      "empty_condition",
      "empty_outcome",
      "invalid_value",
      "outcome_too_long",
    ]);
  });

  it("holds the table to the field, row and cell ceilings", () => {
    expect(compileDecisionTable({ fields: [], rows: [{ when: {}, then: "x" }] })).toMatchObject({ ok: false });
    expect(compileDecisionTable({ fields: ["a", "a"], rows: [{ when: { a: 1 }, then: "x" }] })).toMatchObject({
      ok: false,
      problems: [{ code: "duplicate_field" }],
    });
    const wide = Array.from({ length: DECISION_TABLE_LIMITS.maxValuesPerCondition }, (_, i) => i);
    const big = compileDecisionTable({
      fields: ["a", "b", "c"],
      rows: [{ when: { a: wide, b: wide, c: wide }, then: "x" }],
    });
    expect(big).toMatchObject({ ok: false, problems: [{ code: "too_many_cells" }] });
  });

  it("renders the rows a person wrote, then the fallback", () => {
    expect(renderDecisionTable(triage)).toEqual([
      'when severity = "high" and source = one of "phone", "pager" -> "on-call"',
      'when severity = "low" and source = "email" -> "queue"',
      "otherwise -> ask the AI (input not covered by this table)",
    ]);
  });
});
