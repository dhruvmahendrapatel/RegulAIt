/**
 * ADR-0187 B5-G — the garak catalogue, manifest entry, taxonomy rows and OWASP crosswalk (decisions
 * 142-149). Each guard was shown red by breaking the code it pins (recorded in the ADR).
 */
import { describe, expect, it } from "vitest";
import { RED_TEAM_AGENTIC_ATTACK_CLASSES } from "../redteam.js";
import { OWASP_LLM_TOP_10_MAPPING } from "../owasp-framework-mappings.js";
import {
  ENGINE_MANIFEST,
  ENGINE_TAXONOMY,
  engineConfigNeedsApproval,
  engineRunConfigSchema,
  engineTaxonomyProblems,
  GARAK_JUDGE_MODULES,
  GARAK_OWASP_CROSSWALK,
  GARAK_PRESEEDED_HF_ASSETS,
  GARAK_PROBE_SETTINGS,
  GARAK_PROBES,
  GARAK_UPSTREAM_PROBES,
  GARAK_USAGE_DATA_ENV,
  GARAK_WORKER_SELF_TEST_SWITCH,
  garakConfigProblem,
  garakOwasp2025,
  garakPreseededPlugins,
  garakPrimaryDetector,
  garakProbeForSet,
  garakSetId,
  lookupEngineTaxonomy,
} from "./index.js";

const local = GARAK_PROBES.filter((p) => p.disposition === "local");
const byProbe = new Map(GARAK_PROBES.map((p) => [p.probe, p]));

describe("B5-G garak catalogue", () => {
  it("names only probes the pinned release has, and classifies every one but the always-pass test probes and the detector-less intent probe", () => {
    const upstream = new Set(GARAK_UPSTREAM_PROBES.map((p) => p.probe));
    expect(GARAK_PROBES.filter((p) => !upstream.has(p.probe)).map((p) => p.probe)).toEqual([]);
    expect(GARAK_UPSTREAM_PROBES.filter((p) => !byProbe.has(p.probe)).map((p) => p.probe)).toEqual(["grandma.GrandmaIntent", "test.Blank", "test.Test"]);
    // control: the admitted set is not empty, and not everything
    expect(local.length).toBeGreaterThan(40);
    expect(local.length).toBeLessThan(GARAK_PROBES.length);
  });

  it("never runs a probe whose payload data is copyrighted, personal or unlicensed (licence-excluded probes refused)", () => {
    const mustNotRun = [
      ...GARAK_UPSTREAM_PROBES.filter((p) => /^(leakreplay|propile|continuation|phrasing|test)\./.test(p.probe)).map((p) => p.probe),
      "dan.Dan_11_0",
      "dan.DUDE",
      "dan.Ablation_Dan_11_0",
      "misleading.FalseAssertion",
      "tap.TAPCached",
      "realtoxicityprompts.RTPBlank",
      "latentinjection.LatentJailbreak",
      "lmrc.SlurUsage",
      "packagehallucination.Rust",
      "grandma.Slurs",
      "lmrc.SexualContent",
    ];
    expect(mustNotRun.length).toBeGreaterThan(20);
    for (const p of mustNotRun) {
      expect(garakProbeForSet(garakSetId(p))?.disposition ?? "unlisted", p).not.toBe("local");
      expect(ENGINE_MANIFEST.garak.sets[garakSetId(p)], p).toBeUndefined();
    }
    for (const p of GARAK_UPSTREAM_PROBES.filter((u) => u.probe.startsWith("leakreplay.") || u.probe.startsWith("propile."))) {
      expect(byProbe.get(p.probe)?.disposition).toBe("excluded_licence");
    }
  });

  it("every admitted probe's primary detector runs locally, or is a judge re-pointed at the gateway judge: no Hub model, hosted judge, hosted API or unlicensed word list", () => {
    const allowedDetectorModules = new Set([
      "ansiescape",
      "apikey",
      "base",
      "dan",
      "divergence",
      "encoding",
      "exploitation",
      "goodside",
      "knownbadsignatures",
      "lmrc",
      "malwaregen",
      "mitigation",
      "productkey",
      "promptinject",
      "snowball",
      "sysprompt_extraction",
      "web_injection",
    ]);
    // these detectors (or the probe's own payload) read a Hub asset: admitted only when it is pre-seeded
    const needsHub = new Set(["packagehallucination", "misleading"]);
    const preseeded = garakPreseededPlugins();
    for (const p of local) {
      const d = garakPrimaryDetector(p.probe);
      expect(d, p.probe).not.toBeNull();
      const mod = d!.split(".")[0]!;
      // ADR-0187 decisions 203-205: a model-calling detector is admitted only on a judge probe, which runs
      // only with the run's judge behind the gateway (never garak's hosted default)
      if (p.requiresJudge) expect(GARAK_JUDGE_MODULES.includes(mod), `${p.probe} -> ${d}`).toBe(true);
      else if (needsHub.has(mod)) expect(preseeded.has(d!), `${p.probe} -> ${d} is not pre-seeded`).toBe(true);
      else expect(allowedDetectorModules.has(mod), `${p.probe} -> ${d}`).toBe(true);
    }
    expect(local.filter((p) => p.requiresJudge).map((p) => p.probe)).toEqual(["agent_breaker.AgentBreaker"]);
    // the detector module that reads the two deleted word lists at import is never a primary detector
    expect(local.filter((p) => garakPrimaryDetector(p.probe)!.startsWith("unsafe_content.")).map((p) => p.probe)).toEqual([]);
    // the system-prompt probe reads a Hub dataset: it is pre-seeded, and the probe is pinned to it alone
    expect(preseeded.has("sysprompt_extraction.SystemPromptExtraction")).toBe(true);
    expect(GARAK_PROBE_SETTINGS["sysprompt_extraction.SystemPromptExtraction"]).toEqual({ system_prompt_sources: ["garak-llm/drh-System-Prompt-processed"] });
    expect(GARAK_PRESEEDED_HF_ASSETS.map((a) => a.id)).toContain("garak-llm/drh-System-Prompt-processed");
    // the HF-backed mitigation detector is never a primary detector of an admitted probe
    expect(local.some((p) => garakPrimaryDetector(p.probe) === "mitigation.ModernBERTRefusal")).toBe(false);
  });

  it("the owner's admissions of 2026-10-10 (questions 20 and 22): runnable ones run, the rest say exactly why not", () => {
    // question 20: admitted, and runnable here (string, trigger or regex detectors; data now shipped)
    const admitted = [
      ...GARAK_UPSTREAM_PROBES.filter((p) => /^(doctor|goodside|glitch)\./.test(p.probe)).map((p) => p.probe),
      "grandma.Substances",
      "grandma.Win10",
      "grandma.Win11",
      "badchars.BadCharacters",
      // question 22: their Hub datasets are pre-seeded
      "sysprompt_extraction.SystemPromptExtraction",
      ...GARAK_UPSTREAM_PROBES.filter((p) => p.probe.startsWith("packagehallucination.") && p.probe !== "packagehallucination.Rust").map((p) => p.probe),
    ];
    expect(admitted.length).toBe(20);
    for (const p of admitted) {
      expect(byProbe.get(p)?.disposition, p).toBe("local");
      expect(ENGINE_MANIFEST.garak.sets[garakSetId(p)], p).toBeDefined();
      expect(ENGINE_MANIFEST.garak.airGappedReducedSet.some((e) => e.key === p), p).toBe(false);
    }
    expect(byProbe.get("sysprompt_extraction.SystemPromptExtraction")?.attackClass).toBe("system_prompt_extraction");
    expect(byProbe.get("badchars.BadCharacters")).toMatchObject({ setClass: "offensive", attackClass: "encoding_evasion" });
    expect(byProbe.get("doctor.Bypass")).toMatchObject({ setClass: "offensive", attackClass: "jailbreak" });
    // admitted by licence, but their detector needs the OpenRAIL toxicity model (not pre-seeded) in the
    // module that reads the two deleted word lists: not run, and the reason is the missing asset
    for (const p of ["atkgen.Tox", "lmrc.Bullying", "latentinjection.LatentJailbreak", "realtoxicityprompts.RTPBlank"]) {
      expect(byProbe.get(p)?.disposition, p).toBe("missing_preseed");
      expect(byProbe.get(p)?.note, p).toMatch(/licence admitted/);
    }
    // their detector reads a word list that stays deleted (question 26) or was never admitted
    for (const p of ["lmrc.SlurUsage", "lmrc.SexualContent", "lmrc.Sexualisation", "grandma.Slurs"]) expect(byProbe.get(p)?.disposition, p).toBe("excluded_licence");
    // every pre-seeded asset is MIT or Apache-2.0 and pinned to a full commit
    for (const a of GARAK_PRESEEDED_HF_ASSETS) {
      expect(["mit", "apache-2.0"]).toContain(a.licence);
      expect(a.revision).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it("set ids are the probes' names in lower case and fit the shared set grammar", () => {
    for (const p of GARAK_PROBES) {
      expect(engineRunConfigSchema.safeParse({ sets: [garakSetId(p.probe)] }).success, p.probe).toBe(true);
      expect(garakProbeForSet(garakSetId(p.probe))?.probe).toBe(p.probe);
    }
    expect(garakProbeForSet("encoding.InjectBase64")).toBeNull(); // the set grammar is lower case
  });
});

describe("B5-G manifest entry", () => {
  const m = ENGINE_MANIFEST.garak;
  it("classes every set that runs and declares every one that does not", () => {
    expect(Object.keys(m.sets).sort()).toEqual(local.map((p) => garakSetId(p.probe)).sort());
    expect(m.airGappedReducedSet.map((e) => e.key).sort()).toEqual(GARAK_PROBES.filter((p) => p.disposition !== "local").map((p) => p.probe).sort());
    for (const e of m.airGappedReducedSet) expect(["excluded_licence", "missing_preseed", "cloud_only"]).toContain(e.reason);
  });

  it("routes offensive and unknown sets to approval; the standard ones do not wait", () => {
    expect(engineConfigNeedsApproval(m, ["encoding.injectbase64", "promptinject.hijackhatehumans"])).toBe(false);
    expect(engineConfigNeedsApproval(m, ["dan.daninthewild"])).toBe(true);
    expect(engineConfigNeedsApproval(m, ["malwaregen.payload"])).toBe(true);
    // a licence-excluded or unknown set is unclassified: offensive, approval first (fail closed)
    expect(engineConfigNeedsApproval(m, ["leakreplay.nytcloze"])).toBe(true);
    expect(engineConfigNeedsApproval(m, ["test.test"])).toBe(true);
  });

  it("isolates the runner credential (two containers), needs model access and no judge, and names every worker switch", () => {
    expect(m).toMatchObject({ credentialIsolation: true, needsModelAccess: true, requiresJudge: false, imageDigest: null, version: "0.17.0" });
    expect(m.usageDataEnv).toEqual({ ...GARAK_USAGE_DATA_ENV, [GARAK_WORKER_SELF_TEST_SWITCH]: "1" });
    expect(m.usageDataEnv).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_DATASETS_OFFLINE: "1" });
  });

  it("refuses run params (nothing reaches garak's config unseen)", () => {
    expect(garakConfigProblem({ sets: ["encoding.injectbase64"], params: {} })).toBeNull();
    expect(garakConfigProblem({ sets: ["encoding.injectbase64"], params: { generations: 100 } })).toMatch(/no run params/);
  });
});

describe("B5-G taxonomy rows", () => {
  it("map admitted probes only, by garak's class name, and never claim an agentic class", () => {
    expect(engineTaxonomyProblems(ENGINE_TAXONOMY)).toEqual([]);
    const rows = ENGINE_TAXONOMY.entries.filter((e) => e.system === "garak");
    expect(rows.length).toBeGreaterThan(30);
    for (const r of rows) {
      expect(byProbe.get(r.id)?.disposition, r.id).toBe("local");
      expect((RED_TEAM_AGENTIC_ATTACK_CLASSES as readonly string[]).includes(r.attackClass!), r.id).toBe(false);
    }
    expect(lookupEngineTaxonomy(ENGINE_TAXONOMY, "garak", "promptinject.HijackHateHumans")?.attackClass).toBe("prompt_injection");
    expect(lookupEngineTaxonomy(ENGINE_TAXONOMY, "garak", "latentinjection.LatentInjectionReport")?.attackClass).toBe("prompt_injection");
    expect(lookupEngineTaxonomy(ENGINE_TAXONOMY, "garak", "encoding.InjectBase64")?.attackClass).toBe("encoding_evasion");
    // excluded or unmapped probes count toward nothing
    expect(lookupEngineTaxonomy(ENGINE_TAXONOMY, "garak", "leakreplay.NYTCloze")).toBeNull();
    expect(lookupEngineTaxonomy(ENGINE_TAXONOMY, "garak", "web_injection.MarkdownXSS")).toBeNull();
  });
});

describe("B5-G OWASP crosswalk (garak's 2023 tags -> the 2025 ids)", () => {
  it("maps only to ids our catalog knows, and leaves the contested rows to the owner", () => {
    for (const r of GARAK_OWASP_CROSSWALK.rows) {
      if (r.owasp2025 !== null) expect(Object.keys(OWASP_LLM_TOP_10_MAPPING), r.garak).toContain(r.owasp2025);
      expect(r.status === "owner_decision").toBe(r.owasp2025 === null);
    }
    expect(GARAK_OWASP_CROSSWALK.rows.filter((r) => r.status === "owner_decision").map((r) => r.garak)).toEqual(["owasp:llm07", "owasp:llm10"]);
    expect(GARAK_OWASP_CROSSWALK.garakVersion).toBe(ENGINE_MANIFEST.garak.version);
  });

  it("has a row for every tag an admitted probe carries; numbering is translated, not copied", () => {
    const rows = new Set(GARAK_OWASP_CROSSWALK.rows.map((r) => r.garak));
    for (const p of GARAK_UPSTREAM_PROBES) for (const t of p.owasp) expect(rows.has(t), `${p.probe} ${t}`).toBe(true);
    expect(garakOwasp2025("encoding.InjectBase64")).toEqual(["owasp:llm:01"]);
    // 2023 llm06 Sensitive Information Disclosure is 2025 LLM02, never 2025 LLM06 (Excessive Agency)
    expect(garakOwasp2025("web_injection.MarkdownImageExfil")).toEqual(["owasp:llm:02", "owasp:llm:05"]);
    // an owner-decision row contributes nothing
    expect(garakOwasp2025("leakreplay.NYTCloze")).toEqual(["owasp:llm:02"]);
  });
});
