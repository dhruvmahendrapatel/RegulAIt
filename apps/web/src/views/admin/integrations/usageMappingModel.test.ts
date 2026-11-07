import { describe, expect, it } from "vitest";
import {
  USAGE_MAPPING_FORMAT,
  activation,
  buildMapping,
  buildTestBody,
  draftFrom,
  emptyDraft,
  fieldsMappedLabel,
  mappedFields,
  mappingErrors,
  refusalText,
  sourceOf,
  sourceText,
  testRows,
} from "./usageMappingModel";

const draftWith = (sources: Record<string, string>) => {
  const d = emptyDraft();
  Object.assign(d.sources, sources);
  return d;
};

describe("usage mapping form: a text box becomes a source", () => {
  it("empty is not reported, one pointer is kept as typed, ' + ' is a sum", () => {
    expect(sourceOf("   ")).toBeUndefined();
    expect(sourceOf(" /usage/input_tokens ")).toEqual({ pointer: "/usage/input_tokens" });
    expect(sourceOf("/a + /b")).toEqual({ sum: ["/a", "/b"] });
    // a '+' inside a pointer is part of it; the gateway judges the syntax, never this helper
    expect(sourceOf("/a+b")).toEqual({ pointer: "/a+b" });
    expect(sourceOf("usage/output_tokens")).toEqual({ pointer: "usage/output_tokens" });
  });

  it("round-trips pointers and sums", () => {
    expect(sourceText({ pointer: "/x" })).toBe("/x");
    expect(sourceText({ sum: ["/a", "/b"] })).toBe("/a + /b");
    expect(sourceText(undefined)).toBe("");
  });
});

describe("usage mapping form: the body it sends", () => {
  it("sends the format tag and only the counts that were filled", () => {
    const out = buildMapping(draftWith({ inputTokens: "/usage/input_tokens", outputTokens: "/usage/output_tokens", cacheReadInputTokens: "/usage/cached_tokens" }));
    expect(out).toEqual({
      mapping: {
        format: USAGE_MAPPING_FORMAT,
        fields: {
          inputTokens: { pointer: "/usage/input_tokens" },
          outputTokens: { pointer: "/usage/output_tokens" },
          cacheReadInputTokens: { pointer: "/usage/cached_tokens" },
        },
      },
    });
  });

  it("text in and text out are required", () => {
    expect(buildMapping(emptyDraft())).toEqual({ errors: ["Text in is required.", "Text out is required."] });
  });

  it("totals that exclude image and audio are sent as text_only", () => {
    const d = draftWith({ inputTokens: "/i", outputTokens: "/o" });
    d.totalsInclude = "text_only";
    expect(buildMapping(d)).toMatchObject({ mapping: { totalsInclude: "text_only" } });
  });

  it("a sum over a list needs its count, list and value, and a filter needs both halves", () => {
    const d = draftWith({ inputTokens: "/i", outputTokens: "/o" });
    d.list = { field: "imageInputTokens", array: "/details", value: "/tokenCount", wherePointer: "/modality", equals: "IMAGE, VIDEO" };
    expect(buildMapping(d)).toMatchObject({
      mapping: { fields: { imageInputTokens: { arraySum: { array: "/details", value: "/tokenCount", where: { pointer: "/modality", equals: ["IMAGE", "VIDEO"] } } } } },
    });
    d.list = { field: "", array: "/details", value: "", wherePointer: "/modality", equals: "" };
    expect(buildMapping(d)).toEqual({
      errors: [
        "Sum over a list: choose the count it gives.",
        "Sum over a list: enter the pointer to each entry's value.",
        "Sum over a list: to count only some entries, enter both the pointer and the values it must equal.",
      ],
    });
  });

  it("a count with both a pointer and a list sum is refused; a list sum can satisfy a required count", () => {
    const d = draftWith({ inputTokens: "/i", outputTokens: "/o" });
    d.list = { field: "inputTokens", array: "/l", value: "/v", wherePointer: "", equals: "" };
    expect(buildMapping(d)).toEqual({ errors: ["Text in has a pointer and a sum over a list: keep one."] });
    d.sources.inputTokens = "";
    expect(buildMapping(d)).toMatchObject({ mapping: { fields: { inputTokens: { arraySum: { array: "/l", value: "/v" } } } } });
  });

  it("a stored version becomes the next draft", () => {
    const mapping = {
      format: USAGE_MAPPING_FORMAT,
      fields: { inputTokens: { pointer: "/i" }, outputTokens: { sum: ["/a", "/b"] }, audioInputTokens: { arraySum: { array: "/l", value: "/v" } } },
    };
    const d = draftFrom(mapping);
    expect(d.sources.inputTokens).toBe("/i");
    expect(d.sources.outputTokens).toBe("/a + /b");
    expect(d.list).toEqual({ field: "audioInputTokens", array: "/l", value: "/v", wherePointer: "", equals: "" });
    expect(buildMapping(d)).toEqual({ mapping });
  });
});

describe("usage mapping: what a version maps", () => {
  it("lists the counts in the gateway's order, in words", () => {
    const m = { format: USAGE_MAPPING_FORMAT, fields: { cacheReadInputTokens: { pointer: "/c" }, outputTokens: { pointer: "/o" }, inputTokens: { pointer: "/i" } } };
    expect(mappedFields(m)).toEqual(["inputTokens", "outputTokens", "cacheReadInputTokens"]);
    expect(fieldsMappedLabel(m)).toBe("Text in, text out, cache read");
    expect(fieldsMappedLabel(null)).toBe("None");
  });
});

describe("usage mapping: the sample test", () => {
  const fields = ["inputTokens", "outputTokens", "cacheReadInputTokens"] as const;

  it("sends the parsed sample and the counts given; a blank optional count is left out", () => {
    expect(buildTestBody('{"usage":{"input_tokens":1840}}', { inputTokens: "1,840", outputTokens: "212", cacheReadInputTokens: " " }, fields)).toEqual({
      body: { sample: { usage: { input_tokens: 1840 } }, expected: { inputTokens: 1840, outputTokens: 212 } },
    });
  });

  it("refuses a sample that is not JSON, a missing required count, and a count that is not a whole number", () => {
    expect(buildTestBody("{", { inputTokens: "1", outputTokens: "2" }, fields)).toEqual({ error: "The sample response is not valid JSON." });
    expect(buildTestBody("{}", { inputTokens: "1" }, fields)).toEqual({ error: "Enter the text out count the sample should give." });
    expect(buildTestBody("{}", { inputTokens: "1.5", outputTokens: "2" }, fields)).toEqual({ error: "Text in: a count is a whole number of tokens." });
    expect(buildTestBody("{}", { inputTokens: "-1", outputTokens: "2" }, fields)).toEqual({ error: "Text in: a count is a whole number of tokens." });
  });

  it("the table: expected against read, per count, and only an exact count matches", () => {
    const rows = testRows(fields, { inputTokens: 1840, outputTokens: 212 }, { inputTokens: 1840, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, imageInputTokens: 0, imageOutputTokens: 0, audioInputTokens: 0, audioOutputTokens: 5 });
    expect(rows.map((r) => [r.label, r.expected, r.read, r.match])).toEqual([
      ["Text in", 1840, 1840, true],
      ["Text out", 212, 0, false],
      ["Cache read", 0, 0, true],
      // an unmapped count the mapping read is shown, so a surprise is visible
      ["Audio out", 0, 5, false],
    ]);
  });

  it("a mapping that could not read the sample reads nothing, and nothing matches", () => {
    expect(testRows(["inputTokens", "outputTokens"], { inputTokens: 1, outputTokens: 0 }, null).map((r) => [r.read, r.match])).toEqual([
      [null, false],
      [null, false],
    ]);
  });
});

describe("usage mapping: activation and refusals", () => {
  it("activates only after its latest test passed, and says why beside the button", () => {
    expect(activation({ latestTest: null })).toEqual({ allowed: false, reason: "Activates only after its latest test passed" });
    expect(activation({ latestTest: { id: "t", versionId: "v", passed: false, failure: "x", testedAt: "" } }).allowed).toBe(false);
    expect(activation({ latestTest: { id: "t", versionId: "v", passed: true, failure: null, testedAt: "" } })).toEqual({ allowed: true, reason: null });
  });

  it("the 409 says the step-up was not used; the 413 names the bound", () => {
    expect(refusalText("sample_test_required", 409, { version: 2 })).toEqual({
      title: "Not activated.",
      body: "Version 2's latest test did not pass. Run a passing test first; your step-up was not used.",
    });
    expect(refusalText("sample_too_large", 413)).toEqual({ title: "Sample too large.", body: "A sample is at most 1 MB of JSON." });
    expect(refusalText(null, 413)?.title).toBe("Sample too large.");
    expect(refusalText("invalid_usage_mapping", 422)).toBeNull();
  });

  it("reads the 422's errors as the gateway wrote them", () => {
    expect(mappingErrors({ error: "invalid_usage_mapping", errors: ["mapping.fields.outputTokens: not an RFC 6901 JSON pointer", 3] })).toEqual([
      "mapping.fields.outputTokens: not an RFC 6901 JSON pointer",
    ]);
    expect(mappingErrors(null)).toEqual([]);
  });
});
