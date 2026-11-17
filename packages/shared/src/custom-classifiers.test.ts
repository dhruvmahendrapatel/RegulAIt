import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_VERSION_STATUSES,
  CLASSIFIER_VERSION_TRANSITIONS,
  classifierDefinitionProblem,
  classifierDefinitionSchema,
  classifierTransitionProblem,
  compileClassifier,
  edmNormalise,
  type ClassifierSpec,
} from "./custom-classifiers.js";
import { GUARDRAIL_DEFAULT_MODES, evaluateGuardrails } from "./guardrails.js";

const KEY = Buffer.alloc(32, 7);
const hash = (s: string) => createHmac("sha256", KEY).update(s).digest("hex");
const spec = (definition: ClassifierSpec["definition"], extra: Partial<ClassifierSpec> = {}): ClassifierSpec => ({
  key: "acme_ids",
  version: 1,
  mode: "block",
  phases: ["input", "output"],
  definition,
  ...extra,
});

describe("ADR-0363 slice 2: customer classifiers", () => {
  it("regex runs on RE2 and a pattern RE2 refuses is refused at save", () => {
    const c = compileClassifier(spec({ kind: "regex", pattern: "EMP-[0-9]{6}", caseInsensitive: true }), null);
    expect(c.count("emp-123456 and EMP-654321, not EMP-12")).toBe(2);
    expect(classifierDefinitionProblem({ kind: "regex", pattern: "(a)\\1", caseInsensitive: false })).toMatch(/RE2/);
    expect(classifierDefinitionProblem({ kind: "regex", pattern: "a+b", caseInsensitive: false })).toBeNull();
  });

  it("keyword matches whole words case-insensitively; dictionary looks words up", () => {
    expect(compileClassifier(spec({ kind: "keyword", terms: ["Project Aurora"] }), null).count("the project aurora plan, projectaurora")).toBe(1);
    const dict = compileClassifier(spec({ kind: "dictionary", terms: ["Zephyr", "orchid"] }), null);
    expect(dict.count("ZEPHYR met an Orchid; zephyrs are not counted")).toBe(2);
    expect(classifierDefinitionSchema.safeParse({ kind: "dictionary", terms: ["two words"] }).success).toBe(false);
  });

  it("EDM: values are matched only by digest, with the same normalisation on both sides, longest window first", () => {
    const values = ["123-45-6789", "Jane Doe"];
    const ssn = compileClassifier(
      spec({ kind: "exact_data_match", normalisation: "digits", maxTokens: 1 }, { digests: [hash(edmNormalise(values[0]!, "digits"))] }),
      hash,
    );
    expect(ssn.count("ssn 123456789 or 123-45-6789; 123-45-6780 is someone else")).toBe(2);
    const names = compileClassifier(
      spec({ kind: "exact_data_match", normalisation: "casefold", maxTokens: 3 }, { digests: [hash(edmNormalise(values[1]!, "casefold"))] }),
      hash,
    );
    expect(names.count("Ask JANE   doe, or jane alone")).toBe(1);
    // the plaintext never appears in what is stored
    expect(JSON.stringify(spec({ kind: "exact_data_match", normalisation: "digits", maxTokens: 1 }, { digests: [hash("123456789")] }))).not.toContain("123456789");
  });

  it("an EDM classifier without its key reports unavailable, and the engine counts that as a hit (fail closed)", () => {
    const c = compileClassifier(spec({ kind: "exact_data_match", normalisation: "exact", maxTokens: 1 }, { digests: ["ab"] }), null);
    expect(c.count("anything")).toBe("unavailable");
    const ev = evaluateGuardrails({ phase: "input", text: "anything", modes: GUARDRAIL_DEFAULT_MODES, classifiers: [c] });
    expect(ev.action).toBe("block");
    expect(ev.blocking[0]!.hits[0]!.category).toBe("classifier.acme_ids.unavailable");
  });

  it("runs inside evaluateGuardrails with its own mode and phases, counts only", () => {
    const warn = compileClassifier(spec({ kind: "keyword", terms: ["aurora"] }, { mode: "warn", phases: ["output"] }), null);
    const block = compileClassifier(spec({ kind: "regex", pattern: "EMP-[0-9]{6}", caseInsensitive: false }, { key: "emp" }), null);
    const modes = { ...GUARDRAIL_DEFAULT_MODES, semantic_dlp: "off" as const };
    const input = evaluateGuardrails({ phase: "input", text: "aurora EMP-123456", modes, classifiers: [warn, block] });
    expect(input.findings).toEqual([{ detector: "semantic_dlp", mode: "block", action: "block", hits: [{ detector: "semantic_dlp", category: "classifier.emp", count: 1 }] }]);
    const output = evaluateGuardrails({ phase: "output", text: "aurora", modes, classifiers: [warn] });
    expect(output.action).toBe("warn");
    expect(JSON.stringify(output)).not.toContain("aurora");
  });

  it("the lifecycle is one declared machine", () => {
    for (const s of CLASSIFIER_VERSION_STATUSES) expect(CLASSIFIER_VERSION_TRANSITIONS[s]).toBeDefined();
    expect(classifierTransitionProblem("draft", "pending_approval")).toBeNull();
    expect(classifierTransitionProblem("pending_approval", "published")).toBeNull();
    expect(classifierTransitionProblem("draft", "published")).toMatch(/cannot/);
    expect(classifierTransitionProblem("rejected", "published")).toMatch(/cannot/);
    expect(classifierTransitionProblem("published", "superseded")).toBeNull();
  });

  it("normalisation modes", () => {
    expect(edmNormalise("  Jane\tDOE ", "casefold")).toBe("jane doe");
    expect(edmNormalise("A-12.b", "alphanumeric")).toBe("a12b");
    expect(edmNormalise("+1 (555) 010-9999", "digits")).toBe("15550109999");
    expect(edmNormalise("Ａ１", "exact")).toBe("A1");
  });
});
