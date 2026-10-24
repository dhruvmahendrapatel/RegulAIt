/**
 * FS-43 (#547): a shadow-AI refusal an admin reads names no internal decision record. The refusal strings live in
 * shadow-ai.ts; this pins that no code line building one cites an ADR number (comments may).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./shadow-ai.ts", import.meta.url), "utf8");
const codeLines = source.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l));

describe("shadow-AI refusal copy", () => {
  it("cites no ADR number in a refusal reason", () => {
    expect(codeLines.filter((l) => /refused/i.test(l) && /ADR-\d{4}/.test(l))).toEqual([]);
  });
  it("names the row schema in words when an adapter's output is rejected", () => {
    expect(source).toContain("produced rows that the evidence row schema rejects");
  });
});
