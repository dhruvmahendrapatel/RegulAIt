import { describe, expect, it } from "vitest";
import {
  EMPTY_TRACE_FILTERS,
  activeFilterCount,
  bulkSentence,
  reasonWords,
  tagProblem,
  traceFilterProblem,
  traceListQuery,
} from "./tracesQuery";

describe("ADR-0173 2c: the trace list query", () => {
  it("sends only what is set, trimmed, with the limit", () => {
    expect(traceListQuery(EMPTY_TRACE_FILTERS)).toBe("limit=100");
    const q = new URLSearchParams(
      traceListQuery({
        ...EMPTY_TRACE_FILTERS,
        deniedOnly: true,
        model: "  m-1 ",
        minCostUsd: "0.5",
        scoreName: "helpful",
        scoreMin: "3",
        flagged: "false",
        tagKey: "release",
        tagValue: "2026.10",
      }),
    );
    expect(Object.fromEntries(q)).toEqual({
      deniedOnly: "true",
      model: "m-1",
      minCostUsd: "0.5",
      scoreName: "helpful",
      scoreMin: "3",
      flagged: "false",
      tagKey: "release",
      tagValue: "2026.10",
      limit: "100",
    });
  });

  it("never sends a tag value without its key", () => {
    expect(traceListQuery({ ...EMPTY_TRACE_FILTERS, tagValue: "orphan" })).toBe("limit=100");
  });

  it("states what is wrong before anything is sent", () => {
    expect(traceFilterProblem(EMPTY_TRACE_FILTERS)).toBeNull();
    expect(traceFilterProblem({ ...EMPTY_TRACE_FILTERS, minCostUsd: "lots" })).toBe("Minimum cost must be a number");
    expect(traceFilterProblem({ ...EMPTY_TRACE_FILTERS, scoreMin: "1" })).toBe("A score range needs a score name");
    expect(traceFilterProblem({ ...EMPTY_TRACE_FILTERS, tagValue: "x" })).toBe("A tag value needs a tag key");
    expect(traceFilterProblem({ ...EMPTY_TRACE_FILTERS, tagKey: "Upper" })).toMatch(/tag key/);
  });

  it("counts the active filters", () => {
    expect(activeFilterCount(EMPTY_TRACE_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_TRACE_FILTERS, deniedOnly: true, model: "m", tagKey: " " })).toBe(2);
  });
});

describe("ADR-0173 2c: tags and bulk outcomes", () => {
  it("mirrors the gateway's tag rules", () => {
    expect(tagProblem("release", "2026.10")).toBeNull();
    expect(tagProblem("Release", "x")).toMatch(/tag key/);
    expect(tagProblem("k".repeat(65), "x")).toMatch(/tag key/);
    expect(tagProblem("regulait.system", "x")).toMatch(/reserved/);
    expect(tagProblem("ok", "v".repeat(257))).toMatch(/256/);
    expect(tagProblem("ok", "v".repeat(256))).toBeNull();
  });

  it("says what was added and how many were skipped", () => {
    expect(bulkSentence("Added", "to the dataset", { added: 2, skipped: [] })).toBe("Added 2 traces to the dataset.");
    expect(bulkSentence("Queued", "for review", { added: 1, skipped: [{ id: "x", reason: "withheld" }] })).toBe(
      "Queued 1 trace for review; 1 skipped.",
    );
    expect(reasonWords("not_found_or_forbidden")).toBe("not found, or not yours");
    expect(reasonWords("frozen_dataset_version")).toBe("frozen dataset version");
  });
});
