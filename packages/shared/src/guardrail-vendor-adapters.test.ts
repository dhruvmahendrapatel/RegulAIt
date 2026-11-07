/**
 * ADR-0237 — the pure half of the third-party guardrail adapters: registration
 * rules, request bodies and strict reply parsing. The reply fixtures follow each
 * vendor's published API reference (OpenAI Moderation, Azure AI Content Safety
 * 2024-09-01, Lakera Guard v2 with breakdown).
 */
import { describe, expect, it } from "vitest";
import {
  buildVendorHttpRequest,
  createExternalScorerSchema,
  mergeWindowVerdicts,
  vendorTextWindows,
  parseAzureAnalyze,
  parseAzureShieldPrompt,
  parseLakeraGuard,
  parseOpenAiModeration,
  parseVendorReply,
  vendorAdapterRefusal,
  vendorLabel,
  VENDOR_ADAPTER_KINDS,
} from "./index.js";

describe("registration rules", () => {
  const base = { name: "v", baseUrl: "https://api.lakera.ai", apiKey: "k" };

  it("a vendor adapter claims guardrail kinds only, never an evaluation metric", () => {
    const r = createExternalScorerSchema.safeParse({ ...base, adapter: "lakera_guard", scorerKinds: ["llm_as_judge"] });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("never an evaluation metric");
  });

  it("a kind the vendor does not serve is refused (OpenAI Moderation has no injection classifier)", () => {
    expect(
      createExternalScorerSchema.safeParse({ ...base, adapter: "openai_moderation", scorerKinds: ["guardrail_prompt_injection"] }).success,
    ).toBe(false);
    expect(createExternalScorerSchema.safeParse({ ...base, adapter: "openai_moderation", scorerKinds: ["guardrail_harm"] }).success).toBe(true);
  });

  it("vendor adapters are HTTPS only, and options are per adapter", () => {
    expect(
      vendorAdapterRefusal({ adapter: "azure_content_safety", scorerKinds: ["guardrail_harm"], allowPlaintextHttp: true, options: null }),
    ).toMatch(/HTTPS only/);
    expect(
      vendorAdapterRefusal({ adapter: "azure_content_safety", scorerKinds: ["guardrail_harm"], allowPlaintextHttp: false, options: { projectId: "p" } }),
    ).toMatch(/does not take/);
    expect(
      vendorAdapterRefusal({ adapter: "lakera_guard", scorerKinds: ["guardrail_pii"], allowPlaintextHttp: false, options: { projectId: "project-1" } }),
    ).toBeNull();
    expect(createExternalScorerSchema.safeParse({ ...base, adapter: "lakera_guard", scorerKinds: ["guardrail_pii"], adapterOptions: { projectId: "bad id!" } }).success).toBe(false);
  });

  it("the regulait contract is unchanged (no adapter = regulait, any claimable kind)", () => {
    expect(createExternalScorerSchema.safeParse({ ...base, scorerKinds: ["llm_as_judge", "guardrail_harm"] }).success).toBe(true);
  });

  it("a negative price is refused", () => {
    expect(
      createExternalScorerSchema.safeParse({ ...base, adapter: "lakera_guard", scorerKinds: ["guardrail_pii"], pricePerCallUsd: -1 }).success,
    ).toBe(false);
  });
});

describe("request bodies", () => {
  it("Azure: injection goes to shieldPrompt, harm to analyze with eight severity levels", () => {
    const inj = buildVendorHttpRequest("azure_content_safety", "https://r.cognitiveservices.azure.com/", { kind: "guardrail_prompt_injection", phase: "input", text: "t" }, null);
    expect(inj.url).toBe("https://r.cognitiveservices.azure.com/contentsafety/text:shieldPrompt?api-version=2024-09-01");
    expect(inj.body).toEqual({ userPrompt: "t", documents: [] });
    const harm = buildVendorHttpRequest("azure_content_safety", "https://r.cognitiveservices.azure.com", { kind: "guardrail_harm", phase: "output", text: "t" }, null);
    expect(harm.url).toContain("/contentsafety/text:analyze?api-version=2024-09-01");
    expect(harm.body).toEqual({ text: "t", outputType: "EightSeverityLevels" });
  });

  it("Lakera: the phase decides the role, breakdown is always asked for, the project is optional", () => {
    const out = buildVendorHttpRequest("lakera_guard", "https://api.lakera.ai", { kind: "guardrail_pii", phase: "output", text: "t" }, { projectId: "p-1" });
    expect(out.url).toBe("https://api.lakera.ai/v2/guard");
    expect(out.body).toEqual({ messages: [{ role: "assistant", content: "t" }], breakdown: true, project_id: "p-1" });
    const inp = buildVendorHttpRequest("lakera_guard", "https://api.lakera.ai", { kind: "guardrail_pii", phase: "input", text: "t" }, null);
    expect(inp.body).toEqual({ messages: [{ role: "user", content: "t" }], breakdown: true });
  });
});

describe("strict reply parsing", () => {
  it("OpenAI: the highest category score, flagged categories as bare labels", () => {
    const r = parseOpenAiModeration({
      results: [
        {
          flagged: true,
          categories: { "harassment/threatening": true, violence: false },
          category_scores: { "harassment/threatening": 0.91, violence: 0.2 },
        },
      ],
    });
    expect(r).toEqual({ ok: true, verdict: { score: 0.91, reasons: ["harassment_threatening"] } });
    expect(parseOpenAiModeration({ results: [] }).ok).toBe(false);
    expect(parseOpenAiModeration({ results: [{ category_scores: { a: 2 } }] }).ok).toBe(false);
  });

  it("Azure analyze: highest severity over 7; a missing analysis is an error", () => {
    const r = parseAzureAnalyze({ categoriesAnalysis: [{ category: "Hate", severity: 0 }, { category: "SelfHarm", severity: 7 }] });
    expect(r).toEqual({ ok: true, verdict: { score: 1, reasons: ["selfharm"] } });
    expect(parseAzureAnalyze({ blocklistsMatch: [] }).ok).toBe(false);
    expect(parseAzureAnalyze({ categoriesAnalysis: [{ category: "Hate", severity: 9 }] }).ok).toBe(false);
  });

  it("Azure shieldPrompt: a boolean, or an error", () => {
    expect(parseAzureShieldPrompt({ userPromptAnalysis: { attackDetected: true } })).toEqual({
      ok: true,
      verdict: { score: 1, reasons: ["user_prompt_attack"] },
    });
    expect(parseAzureShieldPrompt({ userPromptAnalysis: { attackDetected: false } })).toEqual({ ok: true, verdict: { score: 0, reasons: [] } });
    expect(parseAzureShieldPrompt({}).ok).toBe(false);
  });

  it("Lakera: per-detector `detected` decides (not `flagged`, which detect mode forces false)", () => {
    const reply = {
      flagged: false,
      breakdown: [
        { detector_type: "prompt_attack", detected: true },
        { detector_type: "pii/email", detected: false },
        { detector_type: "moderated_content/hate", detected: false },
      ],
    };
    expect(parseLakeraGuard(reply, "guardrail_prompt_injection")).toEqual({ ok: true, verdict: { score: 1, reasons: ["prompt_attack"] } });
    expect(parseLakeraGuard(reply, "guardrail_pii")).toEqual({ ok: true, verdict: { score: 0, reasons: [] } });
  });

  it("Lakera: a policy that ran no detector for the kind is an error, not a clean result", () => {
    const r = parseLakeraGuard({ breakdown: [{ detector_type: "prompt_attack", detected: false }] }, "guardrail_pii");
    expect(r.ok).toBe(false);
    expect(parseLakeraGuard({ flagged: true }, "guardrail_pii").ok).toBe(false);
  });

  it("dispatches by adapter and kind", () => {
    expect(parseVendorReply("azure_content_safety", "guardrail_prompt_injection", { userPromptAnalysis: { attackDetected: false } }).ok).toBe(true);
    expect(parseVendorReply("azure_content_safety", "guardrail_harm", { userPromptAnalysis: { attackDetected: false } }).ok).toBe(false);
  });

  it("labels are bare or dropped", () => {
    expect(vendorLabel("Self-Harm")).toBe("self_harm");
    expect(vendorLabel("1234")).toBeNull();
    expect(Object.keys(VENDOR_ADAPTER_KINDS)).toEqual(["openai_moderation", "azure_content_safety", "lakera_guard"]);
  });
});

describe("overlapping windows (design reference: Gravitee AI prompt guard rails)", () => {
  it("text within the limit is one window", () => {
    expect(vendorTextWindows("abc", 10)).toEqual(["abc"]);
  });

  it("an attack split across a window boundary is whole in the next window", () => {
    const text = "a".repeat(95) + "ATTACK" + "b".repeat(30);
    const w = vendorTextWindows(text, 100, 20)!;
    expect(w[0]).not.toContain("ATTACK");
    expect(w.some((x) => x.includes("ATTACK"))).toBe(true);
    expect(w.every((x) => x.length <= 100)).toBe(true);
    // the windows cover the text with the overlap between neighbours
    expect(w.map((x, i) => (i === 0 ? x : x.slice(20))).join("")).toBe(text);
  });

  it("more windows than the bound is null (the caller fails closed), never a partial scan", () => {
    expect(vendorTextWindows("x".repeat(100 + 8 * 80), 100, 20, 8)).toBeNull();
    expect(vendorTextWindows("x".repeat(100 + 7 * 80), 100, 20, 8)).toHaveLength(8);
  });

  it("the merged verdict is the highest score and the union of labels", () => {
    expect(mergeWindowVerdicts([{ score: 0.1, reasons: ["a"] }, { score: 0.9, reasons: ["b", "a"] }])).toEqual({ score: 0.9, reasons: ["a", "b"] });
  });
});

describe("label and URL helpers run in linear time (CodeQL js/polynomial-redos)", () => {
  it("long runs of separators are handled correctly (linear scans, no backtracking regex)", () => {
    expect(vendorLabel("_".repeat(100_000) + "x")).toBe("x");
    expect(vendorLabel("/".repeat(50_000) + "hate" + "/".repeat(50_000))).toBe("hate");
    expect(vendorLabel("__Self--Harm__")).toBe("self_harm");
    const req = buildVendorHttpRequest("lakera_guard", "https://api.lakera.ai" + "/".repeat(100_000), { kind: "guardrail_pii", phase: "input", text: "t" }, null);
    expect(req.url).toBe("https://api.lakera.ai/v2/guard");
  });
});
