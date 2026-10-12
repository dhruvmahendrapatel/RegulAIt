import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GATEWAY_BODY_LIMIT_BYTES, LLM_REFUSALS, parseCorpusRows, rowsBodyProblem, validateBody, validationVerdict, type ValidateResponse } from "./llmDatasetModel";

describe("adding rows", () => {
  it("parses JSON Lines into rowSchema rows, skipping blank lines", () => {
    expect(parseCorpusRows('{"input":"a","output":"b"}\n\n{"input":"c","tags":["x"]}\n')).toEqual({
      rows: [
        { input: "a", output: "b" },
        { input: "c", output: null, tags: ["x"] },
      ],
    });
  });

  it("names the file line of the first problem", () => {
    expect(parseCorpusRows('{"input":"a"}\nnot json')).toEqual({ error: "Line 2 is not valid JSON." });
    expect(parseCorpusRows('\n{"output":"b"}')).toEqual({ error: 'Line 2 has no "input".' });
    expect(parseCorpusRows('["a"]')).toMatchObject({ error: expect.stringContaining("Line 1") });
    expect(parseCorpusRows('{"input":"a","output":3}')).toMatchObject({ error: expect.stringContaining('"output"') });
    expect(parseCorpusRows('{"input":"a","tags":[""]}')).toMatchObject({ error: expect.stringContaining('"tags"') });
    expect(parseCorpusRows(`{"input":"${"x".repeat(50_001)}"}`)).toMatchObject({ error: expect.stringContaining("50000") });
    expect(parseCorpusRows("  \n ")).toMatchObject({ error: expect.stringContaining("No rows") });
  });
});

describe("the request size", () => {
  it("refuses, with the size, rows over the gateway's 1 MiB body limit instead of a bare 413", () => {
    expect(rowsBodyProblem([{ input: "a", output: null }])).toBeNull();
    const big = Array.from({ length: 30 }, () => ({ input: "x".repeat(40_000), output: null }));
    expect(rowsBodyProblem(big)).toMatch(/over the gateway's 1\.00 MiB request limit/);
    const gateway = readFileSync(new URL("../../../../../gateway/src/timeouts.ts", import.meta.url), "utf8");
    expect(gateway).toContain(`bodyLimitBytes: ${GATEWAY_BODY_LIMIT_BYTES.toLocaleString("en-US").replace(/,/g, "_")},`);
  });
});

describe("the dry-run validation", () => {
  it("sends only the typed dials, as numbers, and the price only when given", () => {
    expect(validateBody({ method: "text_classifier", backend: "local", dials: { epochs: "4", l2: "" }, price: "" }, ["epochs", "l2"])).toEqual({
      body: { method: "text_classifier", backend: "local", hyperparameters: { epochs: 4 } },
    });
    expect(validateBody({ method: "lora_sft", backend: "remote-example", dials: {}, price: "2.5" }, [])).toEqual({
      body: { method: "lora_sft", backend: "remote-example", hyperparameters: {}, pricePerMTokUsd: 2.5 },
    });
    expect(validateBody({ method: "lora_sft", backend: "remote-example", dials: { epochs: "lots" }, price: "" }, ["epochs"])).toHaveProperty("error");
    expect(validateBody({ method: "lora_sft", backend: "remote-example", dials: {}, price: "-1" }, [])).toHaveProperty("error");
    expect(validateBody({ method: "", backend: "local", dials: {}, price: "" }, [])).toHaveProperty("error");
  });

  it("would train only when the corpus and the dials both pass", () => {
    const base: ValidateResponse = {
      validation: { ok: true, rowCount: 2, charCount: 10, checksum: "sha256:x", errors: [], warnings: [], labels: [] },
      hyperparameters: {},
      hyperparameterErrors: [],
      estimatedCostUsd: null,
    };
    expect(validationVerdict(base)).toEqual({ ok: true, problems: [] });
    expect(validationVerdict({ ...base, hyperparameterErrors: ["epochs out of range"] })).toEqual({ ok: false, problems: ["Hyperparameters: epochs out of range"] });
    expect(validationVerdict({ ...base, validation: { ...base.validation, ok: false, errors: ["row 0: input is empty"] } }).ok).toBe(false);
  });

  it("every refusal code named here is one regulait-llm.ts sends", () => {
    const gateway = readFileSync(new URL("../../../../../gateway/src/regulait-llm.ts", import.meta.url), "utf8");
    expect(Object.keys(LLM_REFUSALS).filter((code) => !gateway.includes(`error: "${code}"`))).toEqual([]);
  });
});
