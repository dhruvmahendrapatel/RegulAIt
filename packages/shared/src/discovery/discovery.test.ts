import { describe, expect, it } from "vitest";
import {
  activeDiscoveryPosture,
  credentialTargetMatch,
  DISCOVERY_KIND_SPECS,
  DISCOVERY_SOURCE_KINDS,
  publicConfigProblem,
  scopeWidens,
} from "./index.js";
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
  it("upload-fed kinds are exactly the two no-agent endpoint importers and the endpoint agent (SD4b)", () => {
    expect(DISCOVERY_SOURCE_KINDS.filter((k) => DISCOVERY_KIND_SPECS[k].uploadFed)).toEqual(["endpoint_osquery", "endpoint_inventory", "endpoint_agent"]);
  });

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

describe("credential public config: an allowlist per kind and mode (review of #403)", () => {
  it("accepts exactly the allowlisted identifiers, well-formed", () => {
    expect(publicConfigProblem("repo_github", "federated", { appId: "1", installationId: "2" })).toBeNull();
    expect(publicConfigProblem("cloud_aws", "federated", { roleArn: "arn:aws:iam::000000000000:role/reader" })).toBeNull();
    expect(publicConfigProblem("cloud_azure", "static", { tenantId: "00000000-0000-0000-0000-000000000000", clientId: "00000000-0000-0000-0000-000000000001" })).toBeNull();
    expect(publicConfigProblem("repo_gitlab", "static", {})).toBeNull();
  });
  it("refuses any other key, a malformed value, a missing field, and the generated externalId in any spelling", () => {
    expect(publicConfigProblem("repo_github", "federated", { appId: "1", installationId: "2", sk: "x" })).toMatch(/not a public config field/);
    expect(publicConfigProblem("repo_github", "static", { serviceAccountJson: "{}" })).toMatch(/not a public config field/);
    expect(publicConfigProblem("repo_github", "federated", { appId: "abc", installationId: "2" })).toMatch(/not a valid/);
    expect(publicConfigProblem("repo_github", "federated", { appId: "1" })).toMatch(/required/);
    for (const k of ["externalId", "ExternalId", "external_id", "EXTERNALID"]) {
      expect(publicConfigProblem("cloud_aws", "federated", { roleArn: "arn:aws:iam::000000000000:role/r", [k]: "x" })).not.toBeNull();
    }
    expect(publicConfigProblem("repo_gitlab", "federated", { audience: "https://a.example.test/?token=x" })).toMatch(/not a valid/);
    expect(publicConfigProblem("repo_gitlab", "federated", { audience: "http://a.example.test/" })).toMatch(/not a valid/);
    for (const k of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(publicConfigProblem("repo_gitlab", "static", JSON.parse(`{"${k}": "x"}`) as Record<string, string>)).toMatch(/not a public config field/);
    }
  });
  it("matches a credential's account or tenant to the target", () => {
    const arn = "arn:aws:iam::000000000000:role/reader";
    expect(credentialTargetMatch("cloud_aws", { accountId: "000000000000" }, { roleArn: arn })).toBe("match");
    expect(credentialTargetMatch("cloud_aws", { accountId: "111111111111" }, { roleArn: arn })).toBe("mismatch");
    expect(credentialTargetMatch("cloud_aws", {}, { roleArn: arn })).toBe("unverifiable");
    expect(credentialTargetMatch("repo_github", { org: "x" }, { appId: "1" })).toBe("unverifiable");
    // GCP: the impersonated service account's home project matches, or the answer is unverifiable (never mismatch)
    const sa = { serviceAccountEmail: "scanner@acme-ml.iam.gserviceaccount.com" };
    expect(credentialTargetMatch("cloud_gcp", { projectId: "acme-ml" }, sa)).toBe("match");
    expect(credentialTargetMatch("cloud_gcp", { projectId: "other-proj" }, sa)).toBe("unverifiable");
    expect(credentialTargetMatch("cloud_gcp", {}, sa)).toBe("unverifiable");
    // the suffix is required: a look-alike domain never matches
    expect(credentialTargetMatch("cloud_gcp", { projectId: "acme-ml" }, { serviceAccountEmail: "x@acme-ml.example.com" })).toBe("unverifiable");
    expect(credentialTargetMatch("cloud_gcp", { projectId: "acme-ml" }, { serviceAccountEmail: "x@acme-ml.evil.iam.gserviceaccount.com" })).toBe("unverifiable");
    // a project id that merely ENDS with the target's is a different project
    expect(credentialTargetMatch("cloud_gcp", { projectId: "acme-ml" }, { serviceAccountEmail: "x@evil-acme-ml.iam.gserviceaccount.com" })).toBe("unverifiable");
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

  it("a row scoped to an OS or an ecosystem matches only observations from it; a low-confidence match says so", () => {
    const mac = { ...ide, os: "macos" as const, confidence: "low" as const };
    const art = { artifact: { kind: "ide_extension" as const, value: "acme.assistant" } };
    expect(classifyObservation(obs({ ...art, os: "macos" }), [mac]).matched).toBe(true);
    expect(classifyObservation(obs({ ...art, os: "macos" }), [mac]).signatureConfidence).toBe("low");
    expect(classifyObservation(obs({ ...art, os: "windows" }), [mac]).matched).toBe(false);
    expect(classifyObservation(obs(art), [mac]).matched).toBe(false);
    const npm = sig({ kind: "sdk_package", value: "acme-ai", matchType: "package", ecosystem: "npm" });
    expect(classifyObservation(obs({ subjectKind: "repo", subject: "r", packageName: "acme-ai", ecosystem: "NPM" }), [npm]).matched).toBe(true);
    expect(classifyObservation(obs({ subjectKind: "repo", subject: "r", packageName: "acme-ai", ecosystem: "pypi" }), [npm]).matched).toBe(false);
    expect(classifyObservation(obs({ ...art, os: "macos" }), [ide]).signatureConfidence).toBeUndefined();
  });

  it("the catalogue schema accepts bounded scope fields and refuses malformed ones", () => {
    const base = { provider: "p", kind: "desktop_app", value: "x", matchType: "identifier" };
    expect(catalogueSignatureSchema.parse({ ...base, os: "linux", ecosystem: "npm", toolId: "acme.tool", note: "n" }).confidence).toBe("high");
    expect(catalogueSignatureSchema.safeParse({ ...base, os: "beos" }).success).toBe(false);
    expect(catalogueSignatureSchema.safeParse({ ...base, ecosystem: "NPM Registry" }).success).toBe(false);
    expect(catalogueSignatureSchema.safeParse({ ...base, note: "x".repeat(501) }).success).toBe(false);
    expect(catalogueSignatureSchema.safeParse({ ...base, confidence: "certain" }).success).toBe(false);
  });

  it("the catalogue schema binds artifact kinds to the identifier match type", () => {
    expect(catalogueSignatureSchema.safeParse({ provider: "p", kind: "desktop_app", value: "x", matchType: "identifier" }).success).toBe(true);
    expect(catalogueSignatureSchema.safeParse({ provider: "p", kind: "desktop_app", value: "x", matchType: "exact_host" }).success).toBe(false);
    expect(catalogueSignatureSchema.safeParse({ provider: "p", kind: "hostname", value: "x", matchType: "identifier" }).success).toBe(false);
  });
});
