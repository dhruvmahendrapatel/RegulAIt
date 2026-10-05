import { describe, expect, it } from "vitest";
import {
  diffLinesOf,
  diffStats,
  extractVariables,
  fmtCost,
  isRunShortcut,
  missingVariables,
  parseJsonObject,
  rowsForRequest,
  selectorCovers,
  syncRows,
  syncValues,
  TAG_RE,
  webhookSelectors,
} from "./promptsLogic";

describe("template variables (mirrors the gateway's rule)", () => {
  it("finds {{name}} once each, in order, and ignores single braces and JSON", () => {
    expect(extractVariables('Hi {{ name }}, see {{doc}} and {{name}}. {"a": 1} {single}')).toEqual(["name", "doc"]);
    expect(extractVariables("{{1bad}} {{ok_2}}")).toEqual(["ok_2"]);
  });
  it("keeps values of variables still present and adds new ones empty", () => {
    expect(syncValues(["a", "c"], { a: "1", b: "2" })).toEqual({ a: "1", c: "" });
    expect(missingVariables(["a", "b"], { a: "" })).toEqual(["b"]);
  });
  it("reshapes evaluate rows and sends a blank reference as none", () => {
    const rows = syncRows([{ inputs: { a: "x", gone: "y" }, reference: "  " }], ["a", "b"]);
    expect(rows).toEqual([{ inputs: { a: "x", b: "" }, reference: "  " }]);
    expect(rowsForRequest(rows)).toEqual([{ inputs: { a: "x", b: "" }, reference: null }]);
  });
});

describe("editors", () => {
  it("a JSON-object editor: blank is none, an array or bad JSON is refused", () => {
    expect(parseJsonObject("  ")).toEqual({ ok: true, value: null });
    expect(parseJsonObject('{"type":"object"}')).toEqual({ ok: true, value: { type: "object" } });
    expect(parseJsonObject("[1]").ok).toBe(false);
    expect(parseJsonObject("{nope").ok).toBe(false);
  });
  it("Ctrl+Enter and Cmd+Enter run; plain Enter does not", () => {
    expect(isRunShortcut({ key: "Enter", ctrlKey: true, metaKey: false })).toBe(true);
    expect(isRunShortcut({ key: "Enter", ctrlKey: false, metaKey: true })).toBe(true);
    expect(isRunShortcut({ key: "Enter", ctrlKey: false, metaKey: false })).toBe(false);
  });
  it("tag names the gateway accepts", () => {
    expect(["prod", "staging", "canary-2"].every((t) => TAG_RE.test(t))).toBe(true);
    expect(["Prod", "2x", ""].some((t) => TAG_RE.test(t))).toBe(false);
  });
  it("costs: unpriced is said, tiny amounts keep precision", () => {
    expect(fmtCost(null)).toBe("not priced");
    expect(fmtCost(0.0042)).toBe("$0.0042");
    expect(fmtCost(1.5)).toBe("$1.50");
  });
});

describe("diff view", () => {
  it("splits multi-line parts into one entry per line and counts them", () => {
    const lines = diffLinesOf([
      { op: "same", text: "a\nb\n" },
      { op: "remove", text: "c\n" },
      { op: "add", text: "C\nD\n" },
    ]);
    expect(lines.map((l) => `${l.op}:${l.text}`)).toEqual(["same:a", "same:b", "remove:c", "add:C", "add:D"]);
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });
});

describe("webhook selectors", () => {
  it("a whole family becomes <family>.* and swallows its exact events", () => {
    expect(webhookSelectors(["prompt.commit", "prompt.tag.moved"], [])).toEqual(["prompt.commit", "prompt.tag.moved"]);
    expect(webhookSelectors(["prompt.commit"], ["prompt"])).toEqual(["prompt.*"]);
  });
  it("covers an event exactly or by its family", () => {
    expect(selectorCovers(["prompt.*"], "prompt.commit")).toBe(true);
    expect(selectorCovers(["prompt.commit"], "prompt.tag.moved")).toBe(false);
  });
});
