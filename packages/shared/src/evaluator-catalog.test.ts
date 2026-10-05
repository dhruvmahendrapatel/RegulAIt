/**
 * ADR-0173 batch 2c (item 7) — the evaluator catalog and its references.
 *
 * Rule under test: EVERY catalog reference resolves — a NIST id to one of the
 * 72 subcategories, an ISO/IEC 42001 or EU AI Act ref to a shipped pack control,
 * an OWASP id to the vendored tables. Plus the shape the contract names
 * (13 scorers, 5 detectors, 10 red-team classes, external scorers) and the
 * provenance of the vendored data.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DETECTOR_TESTED_BY,
  catalogRefMatchesControl,
  catalogReferenceProblems,
  evaluatorCatalog,
  evaluatorTestStatus,
  evaluatorsForControl,
  externalScorerCatalogEntry,
  owaspReferences,
  type CatalogEvaluator,
} from "./evaluator-catalog.js";
import {
  OWASP_AGENTIC_TOP_10_MAPPING,
  OWASP_LLM_TOP_10_MAPPING,
  PROMPTFOO_FRAMEWORKS_SOURCE,
} from "./owasp-framework-mappings.js";
import { EVAL_SCORER_KINDS } from "./evals.js";
import { GUARDRAIL_DETECTOR_IDS } from "./guardrails.js";
import { RED_TEAM_ATTACK_CLASSES } from "./redteam.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("the catalog covers every evaluator", () => {
  const cat = evaluatorCatalog();
  it("13 scorers, 5 detectors, 10 red-team classes — each once", () => {
    expect(cat.filter((e) => e.kind === "scorer").map((e) => e.name).sort()).toEqual([...EVAL_SCORER_KINDS].sort());
    expect(cat.filter((e) => e.kind === "detector").map((e) => e.name).sort()).toEqual([...GUARDRAIL_DETECTOR_IDS].sort());
    expect(cat.filter((e) => e.kind === "redteam_class").map((e) => e.name).sort()).toEqual(
      [...RED_TEAM_ATTACK_CLASSES].sort(),
    );
    expect(EVAL_SCORER_KINDS).toHaveLength(13);
    expect(GUARDRAIL_DETECTOR_IDS).toHaveLength(5);
    expect(RED_TEAM_ATTACK_CLASSES).toHaveLength(10);
    expect(new Set(cat.map((e) => e.id)).size).toBe(cat.length);
  });

  it("every evaluator cites at least one NIST AI RMF subcategory", () => {
    for (const e of cat) expect(e.refs.nistAiRmf.length, e.id).toBeGreaterThan(0);
  });

  it("only deterministic scorers are runnable over traces", () => {
    for (const e of cat.filter((x) => x.kind === "scorer")) {
      expect(e.runnableOn.includes("trace"), e.id).toBe(e.deterministic);
    }
  });
});

describe("every catalog reference resolves", () => {
  it("the shipped catalog has no unresolved reference", () => {
    expect(catalogReferenceProblems()).toEqual([]);
  });

  it("an external scorer inherits the (resolving) references of the metrics it claims", () => {
    const ext = externalScorerCatalogEntry({ name: "acme-grader", scorerKinds: ["groundedness_judge", "not_a_kind"] });
    expect(ext.id).toBe("external:acme-grader");
    expect(ext.refs.owasp).toContain("owasp:llm:09");
    expect(catalogReferenceProblems([ext])).toEqual([]);
  });

  it("an unresolvable reference of each kind is reported (the check is not a no-op)", () => {
    const bad: CatalogEvaluator = {
      id: "scorer:bogus",
      kind: "scorer",
      name: "bogus",
      summary: "",
      limits: "",
      deterministic: true,
      runnableOn: ["dataset"],
      refs: {
        // built, not written, so the repository's bare-id scan never sees an invalid id
        nistAiRmf: [["MEASURE", "9.9"].join("-"), ["nist-ai-rmf", "MEASURE-2.5"].join(":")],
        iso42001: ["iso-42001:not-a-control"],
        euAiAct: ["eu-ai-act:art-99-nothing", "iso-42001:9.1-monitoring-measurement"],
        owasp: ["owasp:llm:11", "owasp:agentic:asi11"],
      },
    };
    const problems = catalogReferenceProblems([bad]);
    expect(problems).toHaveLength(7);
    expect(problems.join("\n")).toMatch(/not a NIST AI RMF 1\.0 subcategory/);
    expect(problems.join("\n")).toMatch(/must be a bare subcategory id/);
    expect(problems.join("\n")).toMatch(/not an ISO\/IEC 42001 pack control/);
    expect(problems.join("\n")).toMatch(/not an EU AI Act pack control/);
    expect(problems.join("\n")).toMatch(/not a vendored OWASP id/);
  });
});

describe("matching catalog references to pack controls", () => {
  it("a bare NIST id matches the pack's prefixed control ref; other frameworks match exactly", () => {
    expect(catalogRefMatchesControl("MEASURE-2.7", "nist-ai-rmf:MEASURE-2.7")).toBe(true);
    expect(catalogRefMatchesControl("MEASURE-2.7", "nist-ai-rmf:MEASURE-2.6")).toBe(false);
    expect(catalogRefMatchesControl("eu-ai-act:art-15-accuracy-robustness", "eu-ai-act:art-15-accuracy-robustness")).toBe(true);
    expect(catalogRefMatchesControl("eu-ai-act:art-15-accuracy-robustness", "eu-ai-act:art-14-human-oversight")).toBe(false);
  });

  it("the security subcategory is tested by the injection red-team classes and detectors", () => {
    const ids = evaluatorsForControl("nist-ai-rmf:MEASURE-2.7", evaluatorCatalog()).map((e) => e.id);
    expect(ids).toContain("redteam:prompt_injection");
    expect(ids).toContain("detector:prompt_injection");
    expect(ids).not.toContain("scorer:exact");
  });

  it("every detector is exercised only by real red-team classes; toxicity by none", () => {
    for (const classes of Object.values(DETECTOR_TESTED_BY)) {
      for (const c of classes) expect(RED_TEAM_ATTACK_CLASSES).toContain(c);
    }
    expect(DETECTOR_TESTED_BY.toxicity).toEqual([]);
  });
});

describe("tested means passed — never not-run", () => {
  it("status is passed only with a passing run", () => {
    expect(evaluatorTestStatus(0, 0)).toBe("not_run");
    expect(evaluatorTestStatus(3, 0)).toBe("failed");
    expect(evaluatorTestStatus(3, 1)).toBe("passed");
  });
});

describe("the vendored OWASP data", () => {
  it("is the two ten-item lists, named in order", () => {
    expect(Object.keys(OWASP_LLM_TOP_10_MAPPING)).toEqual(
      Array.from({ length: 10 }, (_, i) => `owasp:llm:${String(i + 1).padStart(2, "0")}`),
    );
    expect(Object.keys(OWASP_AGENTIC_TOP_10_MAPPING)).toEqual(
      Array.from({ length: 10 }, (_, i) => `owasp:agentic:asi${String(i + 1).padStart(2, "0")}`),
    );
    const refs = owaspReferences();
    expect(refs.find((r) => r.id === "owasp:llm:01")?.name).toBe("Prompt Injection");
    expect(refs.find((r) => r.id === "owasp:agentic:asi02")?.name).toBe("ASI02: Tool Misuse and Exploitation");
  });

  it("records its source commit and file hash, and THIRD_PARTY.md carries the same", () => {
    expect(PROMPTFOO_FRAMEWORKS_SOURCE.release).toBe("0.123.1");
    expect(PROMPTFOO_FRAMEWORKS_SOURCE.licence).toBe("MIT");
    expect(PROMPTFOO_FRAMEWORKS_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(PROMPTFOO_FRAMEWORKS_SOURCE.fileSha256).toMatch(/^[0-9a-f]{64}$/);
    const thirdParty = readFileSync(path.join(HERE, "../THIRD_PARTY.md"), "utf8");
    expect(thirdParty).toContain(PROMPTFOO_FRAMEWORKS_SOURCE.commit);
    expect(thirdParty).toContain(PROMPTFOO_FRAMEWORKS_SOURCE.fileSha256);
    const vendored = readFileSync(path.join(HERE, "owasp-framework-mappings.ts"), "utf8");
    expect(vendored).toContain("Permission is hereby granted, free of charge");
    expect(vendored).toContain(PROMPTFOO_FRAMEWORKS_SOURCE.fileSha256);
  });
});
