import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_LIMITS,
  CLASSIFIER_VERSION_STATUSES,
  classifierDefinitionProblem,
  classifierDefinitionSchema,
  classifierTokens,
  classifierVersionRelaxes,
  compileClassifier,
  edmNormalise,
  unavailableClassifier,
  unmatchableClassifierValues,
  type ClassifierSpec,
  type ClassifierVersionShape,
} from "./custom-classifiers.js";
import { CLASSIFIER_VERSION_MACHINE, STATE_MACHINES } from "./state-machines.js";
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

  it("the lifecycle is one declared ADR-0348 machine, registered", () => {
    expect([...CLASSIFIER_VERSION_MACHINE.def.states]).toEqual([...CLASSIFIER_VERSION_STATUSES]);
    expect(STATE_MACHINES["custom_classifier_version"]).toBe(CLASSIFIER_VERSION_MACHINE);
    expect(CLASSIFIER_VERSION_MACHINE.next("draft", "submit")).toBe("pending_approval");
    expect(CLASSIFIER_VERSION_MACHINE.next("pending_approval", "approve")).toBe("published");
    expect(CLASSIFIER_VERSION_MACHINE.can("draft", "approve")).toBe(false);
    expect(CLASSIFIER_VERSION_MACHINE.can("rejected", "approve")).toBe(false);
    expect(CLASSIFIER_VERSION_MACHINE.next("published", "supersede")).toBe("superseded");
    expect(CLASSIFIER_VERSION_MACHINE.sourcesOf("retire")).toEqual(["published"]);
  });

  it("tokens never keep a trailing joiner, so a sentence-final value still matches", () => {
    expect(classifierTokens("My id is EMP-1234. Also a.b@c.com/x- and E12345-")).toEqual(["My", "id", "is", "EMP-1234", "Also", "a.b@c.com/x", "and", "E12345"]);
    const dict = compileClassifier(spec({ kind: "dictionary", terms: ["Bluebird"] }), hash);
    expect(dict.count("The codename is Bluebird. Ok")).toBe(1);
    for (const tail of [".", "-", "/", "_", "@"]) {
      const edm = compileClassifier(spec({ kind: "exact_data_match", normalisation: "exact", maxTokens: 2 }, { digests: [hash("E12345"), hash("Jane Doe")] }), hash);
      expect(edm.count(`Employee E12345${tail} and Jane Doe${tail}`)).toBe(2);
    }
  });

  it("a value the scan could never match is reported at save, by position only", () => {
    const edm = { kind: "exact_data_match", normalisation: "casefold", maxTokens: 2 } as const;
    expect(unmatchableClassifierValues(edm, ["E12345", "Jane Doe", "O'Brien", "+1 (555) 010", "a b c", "  "])).toEqual([2, 3, 4]);
    // digits normalisation rebuilds a phone number from its tokens
    expect(unmatchableClassifierValues({ ...edm, normalisation: "digits", maxTokens: 3 }, ["+1 (555) 010"])).toEqual([]);
    expect(unmatchableClassifierValues({ kind: "dictionary", terms: ["ok", "end.", "O'Brien"] })).toEqual([1, 2]);
    expect(unmatchableClassifierValues({ kind: "keyword", terms: ["x y"] })).toEqual([]);
  });

  it("scans past their bounds are unavailable (fail closed), never clean", () => {
    const edm = compileClassifier(spec({ kind: "exact_data_match", normalisation: "exact", maxTokens: 6 }, { digests: [hash("zz")] }), hash);
    expect(edm.count("a ".repeat(CLASSIFIER_LIMITS.edmScanTokens + 1))).toBe("unavailable");
    expect(edm.count("a ".repeat(100))).toBe(0);
    const re = compileClassifier(spec({ kind: "regex", pattern: "zz", caseInsensitive: false }), hash);
    expect(re.count("a".repeat(CLASSIFIER_LIMITS.scanChars + 1))).toBe("unavailable");
    expect(unavailableClassifier({ key: "k", version: 1, mode: "block", phases: ["input"] }).count("x")).toBe("unavailable");
  });

  it("a looser version is named as a relaxation; a stricter one is not", () => {
    const base: ClassifierVersionShape = { mode: "block", scanInput: true, scanOutput: true, definition: { kind: "keyword", terms: ["a", "b"] } };
    expect(classifierVersionRelaxes(base, { ...base, definition: { kind: "keyword", terms: ["a", "b", "c"] } })).toEqual([]);
    expect(classifierVersionRelaxes(base, { ...base, mode: "log" })).toEqual(["mode block -> log"]);
    expect(classifierVersionRelaxes(base, { ...base, scanOutput: false })).toEqual(["stops scanning the output"]);
    expect(classifierVersionRelaxes(base, { ...base, definition: { kind: "keyword", terms: ["a"] } })).toEqual(["1 term(s) removed"]);
    const re: ClassifierVersionShape = { ...base, definition: { kind: "regex", pattern: "x", caseInsensitive: false } };
    expect(classifierVersionRelaxes(re, { ...re, definition: { kind: "regex", pattern: "y", caseInsensitive: false } })).toEqual(["the pattern changed"]);
    expect(classifierVersionRelaxes(base, re)).toEqual(["kind keyword -> regex"]);
    const edm: ClassifierVersionShape = { ...base, definition: { kind: "exact_data_match", normalisation: "casefold", maxTokens: 3 } };
    expect(classifierVersionRelaxes(edm, edm, 0)).toEqual([]);
    expect(classifierVersionRelaxes(edm, { ...edm, definition: { kind: "exact_data_match", normalisation: "casefold", maxTokens: 2 } }, 4)).toEqual([
      "maxTokens 3 -> 2",
      "4 protected value(s) removed",
    ]);
  });

  it("normalisation modes", () => {
    expect(edmNormalise("  Jane\tDOE ", "casefold")).toBe("jane doe");
    expect(edmNormalise("A-12.b", "alphanumeric")).toBe("a12b");
    expect(edmNormalise("+1 (555) 010-9999", "digits")).toBe("15550109999");
    expect(edmNormalise("Ａ１", "exact")).toBe("A1");
  });
});
