import { describe, expect, it } from "vitest";
import { activeDiscoveryPosture, DISCOVERY_KIND_SPECS, DISCOVERY_SOURCE_KINDS, scopeWidens } from "./index.js";
import {
  artifactMatchesSignature,
  catalogueSignatureSchema,
  classifyObservation,
  coverageScorecard,
  type AiSignature,
  type Observation,
} from "../shadow-ai.js";

const sig = (s: Partial<AiSignature> & Pick<AiSignature, "kind" | "value" | "matchType">): AiSignature => ({
  provider: "acme-ai",
  provenance: "admin",
  enabled: true,
  ...s,
});
const obs = (o: Partial<Observation>): Observation => ({
  subjectKind: "device",
  subject: "psn:000000000000000000000000",
  signalSource: "endpoint_agent",
  observedAt: "2026-10-17T00:00:00.000Z",
  count: 1,
  ...o,
});

describe("ADR-0195 SD0 discovery vocabulary", () => {
  it("every source kind has a spec whose evidence and subject kinds are non-empty", () => {
    for (const k of DISCOVERY_SOURCE_KINDS) {
      expect(DISCOVERY_KIND_SPECS[k].evidenceKinds.length).toBeGreaterThan(0);
      expect(DISCOVERY_KIND_SPECS[k].subjectKinds.length).toBeGreaterThan(0);
    }
  });

  it("scope widening: org-level and new names widen; removals and case changes do not", () => {
    expect(scopeWidens({ orgLevel: false, include: ["a"] }, { orgLevel: false, include: ["a", "b"] })).toBe(true);
    expect(scopeWidens({ orgLevel: false, include: ["a", "b"] }, { orgLevel: false, include: ["A"] })).toBe(false);
    expect(scopeWidens({ orgLevel: false, include: ["a"] }, { orgLevel: true, include: [] })).toBe(true);
    expect(scopeWidens({ orgLevel: true, include: [] }, { orgLevel: true, include: [] })).toBe(false);
    expect(scopeWidens({ orgLevel: true, include: [] }, { orgLevel: false, include: ["x"] })).toBe(false);
  });

  it("the posture sentence says nothing is scanned with no source, and names each enabled source otherwise", () => {
    expect(activeDiscoveryPosture([])).toMatch(/No active discovery source is enabled, so nothing is scanned/);
    const s = activeDiscoveryPosture([{ name: "Main org", kind: "repo_github" }]);
    expect(s).toMatch(/1 enabled source/);
    expect(s).toMatch(/Main org \(GitHub repositories\)/);
    expect(coverageScorecard([], [{ name: "Prod", kind: "cloud_aws" }]).statement).toMatch(/Prod \(AWS\)/);
  });
});

describe("ADR-0195 artifact signatures (detection is data)", () => {
  const ide = sig({ kind: "ide_extension", value: "Acme.Assistant", matchType: "identifier" });

  it("matches whole identifiers, case-insensitively, of the same kind only", () => {
    expect(artifactMatchesSignature("ide_extension", "acme.assistant", ide)).toBe(true);
    expect(artifactMatchesSignature("ide_extension", "acme.assistant-pro", ide)).toBe(false);
    expect(artifactMatchesSignature("browser_extension", "acme.assistant", ide)).toBe(false);
  });

  it("an artifact observation becomes a match only through an enabled catalogue row", () => {
    const o = obs({ artifact: { kind: "ide_extension", value: "ACME.assistant" } });
    expect(classifyObservation(o, [ide]).matched).toBe(true);
    expect(classifyObservation(o, [ide]).severity).toBe("medium");
    expect(classifyObservation(o, [{ ...ide, enabled: false }]).matched).toBe(false);
    expect(classifyObservation(o, []).matched).toBe(false);
  });

  it("the catalogue schema binds artifact kinds to the identifier match type", () => {
    expect(catalogueSignatureSchema.safeParse({ provider: "p", kind: "desktop_app", value: "x", matchType: "identifier" }).success).toBe(true);
    expect(catalogueSignatureSchema.safeParse({ provider: "p", kind: "desktop_app", value: "x", matchType: "exact_host" }).success).toBe(false);
    expect(catalogueSignatureSchema.safeParse({ provider: "p", kind: "hostname", value: "x", matchType: "identifier" }).success).toBe(false);
  });
});
