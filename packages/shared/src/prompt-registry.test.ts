import { describe, expect, it } from "vitest";
import {
  caseInputAsVariables,
  extractPromptVariables,
  playgroundEvaluateSchema,
  promptCommitHash,
  promptPromotionDigest,
  renderPromptTemplate,
  type PromptHashInput,
} from "./prompt-registry.js";
import {
  WEBHOOK_LIMITS,
  isWebhookEventSelector,
  webhookPayloadFor,
  webhookRetryDelaySeconds,
  webhookSelectorMatches,
} from "./outbound-webhooks.js";

const base: PromptHashInput = {
  template: "Hi {{name}}",
  modelConfig: { agentId: null, maxTokens: null },
  variables: ["name"],
  outputSchema: null,
  tools: [],
  parent: null,
};

describe("prompt template variables", () => {
  it("finds {{name}} variables in order, once each, and ignores single braces", () => {
    expect(extractPromptVariables("{{a}} {b} {{ b }} {{a}} {\"json\": 1} {{_c9}}")).toEqual(["a", "b", "_c9"]);
  });
  it("renders every variable and refuses a missing one by name", () => {
    expect(renderPromptTemplate("{{a}}-{{ b }}", { a: "1", b: "2" })).toEqual({ ok: true, text: "1-2" });
    expect(renderPromptTemplate("{{a}}-{{b}}", { a: "1" })).toEqual({ ok: false, missing: ["b"] });
  });
  it("binds a case input: a JSON object of strings is the variables, anything else the only variable", () => {
    expect(caseInputAsVariables('{"topic":"x"}', ["topic"])).toEqual({ topic: "x" });
    expect(caseInputAsVariables("plain", ["topic"])).toEqual({ topic: "plain" });
    expect(caseInputAsVariables("plain", ["a", "b"])).toEqual({ input: "plain" });
  });
});

describe("prompt commit hash", () => {
  it("is deterministic and independent of key order", () => {
    const reordered = { ...base, modelConfig: { maxTokens: null, agentId: null } } as PromptHashInput;
    expect(promptCommitHash(base)).toBe(promptCommitHash(reordered));
    expect(promptCommitHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
  it("changes when any of the six covered fields changes", () => {
    const h = promptCommitHash(base);
    const variants: PromptHashInput[] = [
      { ...base, template: "Hi {{name}}!" },
      { ...base, modelConfig: { agentId: "00000000-0000-4000-8000-000000000001", maxTokens: null } },
      { ...base, variables: ["name", "x"] },
      { ...base, outputSchema: { type: "object" } },
      { ...base, tools: [{ name: "t", description: "", inputSchema: {} }] },
      { ...base, parent: "a".repeat(64) },
    ];
    for (const v of variants) expect(promptCommitHash(v)).not.toBe(h);
  });
  it("binds a promotion to prompt, tag and commit", () => {
    const d = promptPromotionDigest({ promptId: "p", tag: "prod", commitHash: "h" });
    expect(promptPromotionDigest({ promptId: "p", tag: "prod", commitHash: "h2" })).not.toBe(d);
    expect(promptPromotionDigest({ promptId: "p", tag: "staging", commitHash: "h" })).not.toBe(d);
  });
});

describe("playground evaluate shape", () => {
  it("takes rows or a dataset, never both or neither, and at most 50 rows", () => {
    const m = "00000000-0000-4000-8000-000000000001";
    expect(playgroundEvaluateSchema.safeParse({ template: "x", modelAgentId: m, rows: [] }).success).toBe(true);
    expect(playgroundEvaluateSchema.safeParse({ template: "x", modelAgentId: m }).success).toBe(false);
    expect(playgroundEvaluateSchema.safeParse({ template: "x", modelAgentId: m, rows: [], datasetId: m }).success).toBe(false);
    const rows = Array.from({ length: 51 }, () => ({ inputs: {} }));
    expect(playgroundEvaluateSchema.safeParse({ template: "x", modelAgentId: m, rows }).success).toBe(false);
  });
});

describe("webhook event registry", () => {
  it("accepts exact events and registered families only", () => {
    expect(isWebhookEventSelector("prompt.commit")).toBe(true);
    expect(isWebhookEventSelector("prompt.*")).toBe(true);
    // batch 2c registered trace.*, annotation.* and automation.*; an unknown family is still refused
    expect(isWebhookEventSelector("billing.*")).toBe(false);
    expect(isWebhookEventSelector("prompt.nope")).toBe(false);
    expect(webhookSelectorMatches(["prompt.*"], "prompt.tag.moved")).toBe(true);
    expect(webhookSelectorMatches(["prompt.commit"], "prompt.tag.moved")).toBe(false);
  });
  it("keeps only the fields an event declares", () => {
    const out = webhookPayloadFor("prompt.commit", { promptId: "p", commitHash: "h", template: "secret text", apiKey: "k" });
    expect(out).toEqual({ promptId: "p", commitHash: "h" });
  });
  it("backs off exponentially, capped", () => {
    expect(webhookRetryDelaySeconds(1)).toBe(WEBHOOK_LIMITS.baseBackoffSeconds);
    expect(webhookRetryDelaySeconds(2)).toBe(WEBHOOK_LIMITS.baseBackoffSeconds * 2);
    expect(webhookRetryDelaySeconds(40)).toBe(WEBHOOK_LIMITS.maxBackoffSeconds);
  });
});
