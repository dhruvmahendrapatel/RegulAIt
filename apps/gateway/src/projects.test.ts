/**
 * FS-33: the project cost CSV export (`/v1/projects/:id/costs.csv`, and the
 * `/v1/usage-events?format=csv` export that shares its row formatter) goes
 * through the shared `csvRecord` neutraliser, so a cell a spreadsheet would
 * read as a formula is prefixed, as in the audit-log and report exports.
 */
import { describe, expect, it } from "vitest";
import { csvField, usageEventRow } from "./projects.js";

describe("FS-33 — usage CSV cells are formula-neutralised", () => {
  it("prefixes every formula trigger in a text cell", () => {
    for (const v of ["=HYPERLINK(\"x\")", "+1+1", "@SUM(A1)", "\tcmd", "-2+3", "\rx"]) {
      expect(csvField(v).replace(/^"/, "")).toMatch(/^'/);
    }
  });

  it("leaves numbers, plain decimals and a negative saving unchanged", () => {
    expect(csvField(42)).toBe("42");
    expect(csvField("0.012300")).toBe("0.012300");
    expect(csvField("-0.5")).toBe("-0.5");
    expect(csvField(null)).toBe("");
    expect(csvField("plain-model")).toBe("plain-model");
  });

  it("still quotes RFC 4180 specials", () => {
    expect(csvField('a,"b"')).toBe('"a,""b"""');
    expect(csvField("x\ny")).toBe('"x\ny"');
  });

  it("a usage row with a formula in the model column is neutralised end to end", () => {
    const row = usageEventRow({
      at: new Date("2026-10-24T00:00:00.000Z"),
      userId: "00000000-0000-0000-0000-000000000001",
      objectType: "agent",
      agentId: "a",
      connectorId: null,
      model: "=cmd|' /C calc'!A0",
      operation: "chat",
      inputTokens: 3,
      outputTokens: 4,
      costUsd: "0.001000",
      measuredCostSavedUsd: "-0.000100",
      projectId: null,
    } as unknown as Parameters<typeof usageEventRow>[0]);
    const cells = row.split(",");
    expect(cells[5]).toBe("'=cmd|' /C calc'!A0");
    // ADR-0212: the three modality cost cells trail the row, empty for a row with no split
    expect(cells.slice(7)).toEqual(["3", "4", "0.001000", "-0.000100", "", "", "", ""]);
  });
});
