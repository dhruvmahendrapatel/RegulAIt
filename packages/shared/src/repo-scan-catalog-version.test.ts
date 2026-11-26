// ADR-0083 §2 (lane E54): a repo scan stamps the compiled catalogue version it
// matched against, so "matched X" in repo-scan evidence tells v2 from v3.
import { describe, expect, it } from "vitest";
import { analyseRepo, REPO_SCAN_CATALOG_VERSIONS, type RepoFileRead } from "./repo-analysis.js";
import { SHADOW_AI_CATALOG_V2, SHADOW_AI_CATALOG_V2_VERSION } from "./shadow-catalog-v2.js";
import { SHADOW_AI_CATALOG_V3_VERSION } from "./shadow-catalog-v3.js";
import { correlateObservations, type Classification, type Observation } from "./shadow-ai.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const files: Record<string, string> = { "package.json": JSON.stringify({ dependencies: { openai: "^4" } }) };
const input = {
  repo: "a/b",
  commitSha: SHA,
  entries: Object.keys(files).map((path) => ({ path, size: Buffer.byteLength(files[path]!) })),
  readFile: async (path: string): Promise<RepoFileRead> => (files[path] === undefined ? { status: "not_found" } : { status: "ok", content: files[path]! }),
};

describe("repo scan catalogue version (ADR-0083 §2)", () => {
  it("names v2 and v3 as the compiled versions a repo scan may report", () => {
    expect(REPO_SCAN_CATALOG_VERSIONS).toEqual([2, 3]);
    expect(Object.isFrozen(REPO_SCAN_CATALOG_VERSIONS)).toBe(true);
  });

  it("defaults to catalogue v3 and reports it", async () => {
    const res = await analyseRepo(input);
    expect(res.catalogVersion).toBe(SHADOW_AI_CATALOG_V3_VERSION);
    expect(res.observations.some((o) => o.packageName === "openai")).toBe(true);
  });

  it("reports v2 when the caller matches against catalogue v2", async () => {
    const res = await analyseRepo({ ...input, catalog: { entries: SHADOW_AI_CATALOG_V2, version: SHADOW_AI_CATALOG_V2_VERSION } });
    expect(res.catalogVersion).toBe(2);
  });

  it("refuses a version that is not a compiled catalogue", async () => {
    await expect(analyseRepo({ ...input, catalog: { entries: SHADOW_AI_CATALOG_V2, version: 4 } })).rejects.toThrow(/not a compiled catalogue version/);
  });

  it("carries the version onto the finding's evidence, and omits it when the sighting has none", () => {
    const base: Observation = { subjectKind: "repo", subject: "github:acme/app", signalSource: "repo_scan", observedAt: "2026-11-21T00:00:00.000Z", count: 1, packageName: "openai" };
    const c = { matched: true, provider: "openai", matchedValue: "openai", reason: "r", severity: "medium", signatureKind: "sdk_package", replacementAgentId: null, replacementNote: null } as unknown as Classification;
    const [v3] = correlateObservations([{ observation: { ...base, catalogVersion: 3 }, classification: c }]);
    expect(v3!.evidence[0]!.catalogVersion).toBe(3);
    const [none] = correlateObservations([{ observation: { ...base, signalSource: "endpoint_agent" }, classification: c }]);
    expect("catalogVersion" in none!.evidence[0]!).toBe(false);
  });
});
