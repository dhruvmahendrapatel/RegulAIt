import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ATLAS_TECHNIQUES_FRAMEWORK,
  ATLAS_TECHNIQUES_RELEASE,
  REDTEAM_CLASS_ATLAS_TECHNIQUES,
  atlasTechniqueRef,
  redTeamClassesForAtlasTechnique,
} from "./atlas-redteam-map.js";
import { catalogReferenceProblems, evaluatorCatalog, evaluatorsForControl } from "./evaluator-catalog.js";
import { frameworkImportSnapshotSchema } from "./framework-imports.js";
import { RED_TEAM_ATTACK_CLASSES } from "./redteam.js";

const snapshot = frameworkImportSnapshotSchema.parse(
  JSON.parse(
    readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "framework-imports-data", "mitre-atlas-techniques.json"),
      "utf8",
    ),
  ),
);
const vendored = new Set(snapshot.controls.map((c) => c.controlRef));

describe("ADR-0293 red-team attack classes to MITRE ATLAS techniques", () => {
  it("covers every attack class and was checked against the vendored release", () => {
    expect(Object.keys(REDTEAM_CLASS_ATLAS_TECHNIQUES).sort()).toEqual([...RED_TEAM_ATTACK_CLASSES].sort());
    expect(snapshot.source.framework).toBe(ATLAS_TECHNIQUES_FRAMEWORK);
    expect(snapshot.source.sourceVersion).toBe(ATLAS_TECHNIQUES_RELEASE);
  });

  it("every mapped id is a technique of the vendored release, never a tactic", () => {
    for (const [cls, ids] of Object.entries(REDTEAM_CLASS_ATLAS_TECHNIQUES)) {
      for (const id of ids) {
        expect(id, `${cls} -> ${id}`).toMatch(/^AML\.T\d{4}(\.\d{3})?$/);
        expect(vendored.has(atlasTechniqueRef(id)), `${cls} -> ${id} is not in ATLAS ${ATLAS_TECHNIQUES_RELEASE}`).toBe(true);
      }
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("only bias maps to nothing (ATLAS has no fairness technique)", () => {
    const empty = Object.entries(REDTEAM_CLASS_ATLAS_TECHNIQUES).filter(([, ids]) => ids.length === 0).map(([c]) => c);
    expect(empty).toEqual(["bias"]);
  });

  it("the evaluator catalog cites the techniques on the red-team classes, and a technique control finds them", () => {
    const catalog = evaluatorCatalog();
    expect(catalogReferenceProblems(catalog)).toEqual([]);
    const jailbreak = catalog.find((e) => e.id === "redteam:jailbreak")!;
    expect(jailbreak.refs.mitreAtlas).toEqual(["mitre-atlas-techniques:AML.T0054"]);
    expect(catalog.filter((e) => e.kind !== "redteam_class").every((e) => e.refs.mitreAtlas.length === 0)).toBe(true);
    const testedBy = evaluatorsForControl("mitre-atlas-techniques:AML.T0053", catalog).map((e) => e.id).sort();
    expect(testedBy).toEqual(["redteam:excessive_agency", "redteam:tool_abuse"]);
    expect(redTeamClassesForAtlasTechnique("AML.T0053")).toEqual(["excessive_agency", "tool_abuse"]);
  });
});
