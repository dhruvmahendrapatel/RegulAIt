/**
 * ADR-0187 decisions 185–192 — the vendored CyberSecEval files: their pins,
 * their licence, and the mapping to eval cases. A changed byte in any vendored
 * file fails the first test (sha drift); the gateway suite proves the runtime
 * refuses it too (`zz-b5-cyberseceval.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_EVAL_DATASETS,
  CYBERSECEVAL_FILES,
  CYBERSECEVAL_PIN,
  builtinEvalCases,
  builtinEvalDatasetByName,
  builtinEvalScorer,
  evalCaseSetDigest,
  evalRunApprovalDigest,
  isReservedEvalDatasetName,
  vendoredFileSha256,
  type CybersecevalFileId,
} from "./cyberseceval.js";
import { JUDGE_PANEL_LIMITS } from "../judge-panels.js";
import { evalScorerConfigSchema, validateScorerConfig } from "../evals.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, CYBERSECEVAL_PIN.vendorDir);
const read = (rel: string) => readFileSync(path.join(vendor, rel));
const parsed = (id: CybersecevalFileId) => JSON.parse(read(CYBERSECEVAL_FILES[id].path).toString("utf8")) as unknown[];

describe("vendored CyberSecEval files (pins and licence)", () => {
  const provenance = JSON.parse(read("PROVENANCE.json").toString("utf8")) as {
    commit: string;
    files: Array<{ path: string; sha256: string; bytes: number; spdx: string; records?: number }>;
  };

  it("every vendored file rehashes to its pinned sha256; PROVENANCE.json and the code agree", () => {
    expect(provenance.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(provenance.commit).toBe(CYBERSECEVAL_PIN.commit);
    expect(provenance.files.map((f) => f.path).sort()).toEqual(
      ["LICENSE", ...Object.values(CYBERSECEVAL_FILES).map((f) => f.path)].sort(),
    );
    for (const f of provenance.files) {
      const bytes = read(f.path);
      expect(createHash("sha256").update(bytes).digest("hex"), f.path).toBe(f.sha256);
      expect(bytes.length, f.path).toBe(f.bytes);
      expect(f.spdx).toBe("MIT");
      expect(f.path.split("/")).not.toContain("..");
    }
    for (const [id, f] of Object.entries(CYBERSECEVAL_FILES)) {
      const p = provenance.files.find((x) => x.path === f.path)!;
      expect(p.sha256, id).toBe(f.sha256);
      expect(p.bytes, id).toBe(f.bytes);
      expect(p.records, id).toBe(f.records);
    }
  });

  it("the licence at the pinned commit is MIT", () => {
    const licence = read("LICENSE").toString("utf8");
    expect(licence.startsWith("MIT License")).toBe(true);
    expect(licence).toContain("Permission is hereby granted, free of charge");
    expect(CYBERSECEVAL_PIN.licence).toBe("MIT");
  });

  it("one changed byte is a different sha256 (what the loader compares before parsing)", () => {
    const bytes = Buffer.from(read(CYBERSECEVAL_FILES.interpreter.path));
    expect(vendoredFileSha256(bytes)).toBe(CYBERSECEVAL_FILES.interpreter.sha256);
    bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1;
    expect(vendoredFileSha256(bytes)).not.toBe(CYBERSECEVAL_FILES.interpreter.sha256);
  });

  it("together the files stay well under the 5 MB vendoring budget", () => {
    const total = Object.values(CYBERSECEVAL_FILES).reduce((n, f) => n + f.bytes, 0);
    expect(total).toBeLessThan(5 * 1024 * 1024);
  });
});

describe("the built-in datasets", () => {
  it("five datasets: injection, FRR in three parts of 250, interpreter; only interpreter is offensive", () => {
    expect(BUILTIN_EVAL_DATASETS.map((d) => [d.key, d.range, d.sensitivity])).toEqual([
      ["cyberseceval/prompt_injection", [0, 251], "standard"],
      ["cyberseceval/mitre_frr/part-1-of-3", [0, 250], "standard"],
      ["cyberseceval/mitre_frr/part-2-of-3", [250, 500], "standard"],
      ["cyberseceval/mitre_frr/part-3-of-3", [500, 750], "standard"],
      ["cyberseceval/interpreter", [0, 500], "offensive"],
    ]);
    for (const d of BUILTIN_EVAL_DATASETS) {
      expect(isReservedEvalDatasetName(d.name)).toBe(true);
      expect(builtinEvalDatasetByName(d.name)).toBe(d);
      // one judge can score every case of one run (the per-run judgement cap)
      expect(d.range[1] - d.range[0]).toBeLessThanOrEqual(JUDGE_PANEL_LIMITS.maxJudgements);
    }
    expect(isReservedEvalDatasetName("  Builtin:mine")).toBe(true);
    expect(isReservedEvalDatasetName("my-builtin:set")).toBe(false);
  });

  it("every case is judged, has a rubric the judge sees, and passes the authoring-time scorer check", () => {
    for (const spec of BUILTIN_EVAL_DATASETS) {
      const scorer = builtinEvalScorer(spec);
      expect(scorer.scorerKind).toBe("llm_as_judge");
      const cfg = evalScorerConfigSchema.parse(scorer.scorerConfig);
      const cases = builtinEvalCases(spec, parsed(spec.file));
      expect(cases).toHaveLength(spec.range[1] - spec.range[0]);
      for (const c of cases) {
        expect(c.input.length).toBeGreaterThan(0);
        expect(c.rubric.length).toBeGreaterThan(0);
        expect(validateScorerConfig("llm_as_judge", cfg, null, c.context)).toBeNull();
        for (const t of c.tags) expect(t.length).toBeLessThanOrEqual(60);
      }
    }
  });

  it("prompt injection: the instructions ride the prompt as context, the judge question is in the rubric", () => {
    const records = parsed("prompt_injection") as Array<Record<string, unknown>>;
    const cases = builtinEvalCases(BUILTIN_EVAL_DATASETS[0]!, records);
    cases.forEach((c, i) => {
      expect(c.input).toBe(records[i]!.user_input);
      expect(c.context).toEqual([records[i]!.test_case_prompt]);
      expect(c.contextInPrompt).toBe(true);
      expect(c.rubric).toContain(`Judge question: ${records[i]!.judge_question as string}`);
    });
    expect(cases.filter((c) => c.tags.includes("injection:indirect"))).toHaveLength(55);
  });

  it("FRR parts cover all 750 benign prompts once, and the record's generator field is never copied", () => {
    const records = parsed("mitre_frr") as Array<Record<string, unknown>>;
    const parts = BUILTIN_EVAL_DATASETS.filter((d) => d.file === "mitre_frr");
    const inputs = parts.flatMap((p) => builtinEvalCases(p, records).map((c) => c.input));
    expect(inputs).toEqual(records.map((r) => r.mutated_prompt));
    const generators = new Set(records.map((r) => String(r.model)));
    expect(generators.size).toBeGreaterThan(0);
    expect(generators.has("undefined")).toBe(false);
    for (const p of parts) {
      for (const c of builtinEvalCases(p, records)) {
        for (const g of generators) expect(JSON.stringify(c)).not.toContain(g);
      }
    }
  });

  it("interpreter: five attack classes of 100, tagged", () => {
    const cases = builtinEvalCases(BUILTIN_EVAL_DATASETS[4]!, parsed("interpreter"));
    const counts: Record<string, number> = {};
    for (const c of cases) {
      const tag = c.tags.find((t) => t.startsWith("attack:"))!;
      counts[tag] = (counts[tag] ?? 0) + 1;
    }
    expect(Object.values(counts)).toEqual([100, 100, 100, 100, 100]);
  });

  it("a record that does not match the upstream shape fails the whole file", () => {
    const records = parsed("interpreter") as Array<Record<string, unknown>>;
    const broken = records.map((r, i) => (i === 7 ? { ...r, attack_type: "not-a-list" } : r));
    expect(() => builtinEvalCases(BUILTIN_EVAL_DATASETS[4]!, broken)).toThrow();
    expect(() => builtinEvalCases(BUILTIN_EVAL_DATASETS[4]!, records.slice(1))).toThrow(/500 records/);
  });
});

describe("digests", () => {
  const spec = BUILTIN_EVAL_DATASETS[0]!;
  const scorer = builtinEvalScorer(spec);
  const cases = builtinEvalCases(spec, parsed("prompt_injection"));

  it("the case-set digest ignores row order and catches any changed field", () => {
    const d = evalCaseSetDigest(scorer, cases);
    expect(evalCaseSetDigest(scorer, [...cases].reverse())).toBe(d);
    const edited = cases.map((c, i) => (i === 100 ? { ...c, rubric: c.rubric + " " } : c));
    expect(evalCaseSetDigest(scorer, edited)).not.toBe(d);
    expect(evalCaseSetDigest(scorer, cases.slice(1))).not.toBe(d);
    expect(evalCaseSetDigest({ ...scorer, scorerConfig: { ...scorer.scorerConfig, threshold: 0 } }, cases)).not.toBe(d);
  });

  it("an approval digest is bound to the agent, the judge and the project, not the note", () => {
    const base = {
      datasetId: "00000000-0000-0000-0000-0000000000a1",
      datasetVersion: 1,
      agentId: "00000000-0000-0000-0000-0000000000b1",
      judgeAgentId: "00000000-0000-0000-0000-0000000000c1",
      judgePanel: null,
      repetitions: 1,
      projectId: null,
      mode: "execute",
      tolerance: 0.05,
      minScore: null,
      minPassRate: null,
      baselineRunId: null,
    };
    const d = evalRunApprovalDigest(base);
    expect(evalRunApprovalDigest({ ...base })).toBe(d);
    expect(evalRunApprovalDigest({ ...base, agentId: "00000000-0000-0000-0000-0000000000b2" })).not.toBe(d);
    expect(evalRunApprovalDigest({ ...base, judgeAgentId: null })).not.toBe(d);
    expect(evalRunApprovalDigest({ ...base, projectId: "00000000-0000-0000-0000-0000000000d1" })).not.toBe(d);
    expect(evalRunApprovalDigest({ ...base, minPassRate: 0.9 })).not.toBe(d);
  });
});
