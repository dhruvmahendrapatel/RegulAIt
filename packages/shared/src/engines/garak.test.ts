/**
 * ADR-0187 B5-G — the garak catalogue, manifest entry and taxonomy rows (decisions 142-149; the OWASP
 * table is pinned in garak-owasp-2025.test.ts). Each guard was shown red by breaking the code it pins
 * (recorded in the ADR).
 */
import { describe, expect, it } from "vitest";
import { RED_TEAM_AGENTIC_ATTACK_CLASSES } from "../redteam.js";
import {
  ENGINE_MANIFEST,
  ENGINE_TAXONOMY,
  engineConfigNeedsApproval,
  engineRunConfigSchema,
  engineTaxonomyProblems,
  GARAK_PROBES,
  GARAK_UPSTREAM_PROBES,
  GARAK_USAGE_DATA_ENV,
  GARAK_WORKER_SELF_TEST_SWITCH,
  garakConfigProblem,
  garakPrimaryDetector,
  garakProbeForSet,
  garakSetId,
  lookupEngineTaxonomy,
} from "./index.js";

const local = GARAK_PROBES.filter((p) => p.disposition === "local");
const byProbe = new Map(GARAK_PROBES.map((p) => [p.probe, p]));

describe("B5-G garak catalogue", () => {
  it("names only probes the pinned release has, and classifies every one but the always-pass test probes", () => {
    const upstream = new Set(GARAK_UPSTREAM_PROBES.map((p) => p.probe));
    expect(GARAK_PROBES.filter((p) => !upstream.has(p.probe)).map((p) => p.probe)).toEqual([]);
    expect(GARAK_UPSTREAM_PROBES.filter((p) => !byProbe.has(p.probe)).map((p) => p.probe)).toEqual(["test.Blank", "test.Test"]);
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
      "badchars.BadCharacters",
      "tap.TAPCached",
      "realtoxicityprompts.RTPBlank",
      "latentinjection.LatentJailbreak",
      "lmrc.SlurUsage",
      "packagehallucination.Rust",
      "doctor.Puppetry",
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

  it("every admitted probe's primary detector runs locally: no Hub model, hosted judge, hosted API or unlicensed word list", () => {
    const allowedDetectorModules = new Set([
      "ansiescape",
      "apikey",
      "base",
      "dan",
      "divergence",
      "encoding",
      "exploitation",
      "knownbadsignatures",
      "lmrc",
      "malwaregen",
      "mitigation",
      "promptinject",
      "snowball",
      "web_injection",
    ]);
    for (const p of local) {
      const d = garakPrimaryDetector(p.probe);
      expect(d, p.probe).not.toBeNull();
      expect(allowedDetectorModules.has(d!.split(".")[0]!), `${p.probe} -> ${d}`).toBe(true);
    }
    // the HF-backed mitigation detector is never a primary detector of an admitted probe
    expect(local.some((p) => garakPrimaryDetector(p.probe) === "mitigation.ModernBERTRefusal")).toBe(false);
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
