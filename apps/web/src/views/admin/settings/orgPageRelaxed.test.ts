import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ORG_PAGE_EXEMPT,
  ORG_PAGE_OWN_ENDPOINT,
  ORG_PAGE_RELAXED,
  ORG_PAGE_SPEC_TABS,
  ORG_PAGE_STORED_ONLY,
} from "./orgPageRelaxed";
import { ALL_SPECS } from "./orgSettingSpecs";

/* eslint-disable @typescript-eslint/no-explicit-any */
// the gateway's strictness registry is the one source of "relaxed" (review of #699); the SPA mirrors it and this fails
// on any drift. It loads the gateway source, which resolves @regulait/shared through the workspace (built first).
const registryFile = new URL("../../../../../gateway/src/org-setting-strictness.ts", import.meta.url).pathname;
const registry = async (): Promise<Record<string, any>> =>
  (await import(/* @vite-ignore */ registryFile)).ORG_SETTING_STRICTNESS;
const pageSource = readFileSync(new URL("./OrganizationPage.tsx", import.meta.url), "utf8");

const listed = (): Set<string> =>
  new Set([
    ...ORG_PAGE_RELAXED.map((r) => r.key),
    ...ORG_PAGE_OWN_ENDPOINT.map((r) => r.key),
    ...ORG_PAGE_SPEC_TABS.flatMap((g) => g.keys),
    ...ORG_PAGE_STORED_ONLY,
    ...ORG_PAGE_EXEMPT,
  ]);

describe("the Organisation page's relaxed settings follow the gateway's strictness registry", () => {
  it("every registry key the page edits is in exactly one list", async () => {
    const r = await registry();
    // every identifier in the page source that names a registry key (quoted, or read as `s.key`)
    const quoted = new Set([...pageSource.matchAll(/\b([a-z][A-Za-z0-9]+)\b/g)].map((m) => m[1]!));
    const edited = [...quoted].filter((k) => Object.hasOwn(r, k));
    expect(edited.length).toBeGreaterThan(40);
    const all = listed();
    for (const k of edited) expect(all.has(k), `${k} is edited on the page but not classified in orgPageRelaxed.ts`).toBe(true);
    const flat = [
      ...ORG_PAGE_RELAXED.map((x) => x.key),
      ...ORG_PAGE_OWN_ENDPOINT.map((x) => x.key),
      ...ORG_PAGE_SPEC_TABS.flatMap((g) => g.keys),
      ...ORG_PAGE_STORED_ONLY,
      ...ORG_PAGE_EXEMPT,
    ];
    expect(flat.length, "a key is listed twice").toBe(all.size);
    // and nothing is listed that the page does not edit
    for (const k of all) expect(quoted.has(k), `${k} is listed but not on the page`).toBe(true);
  });

  it("each rule agrees with the registry's `relaxed` on its strict default and every sample", async () => {
    const r = await registry();
    for (const rule of ORG_PAGE_RELAXED) {
      const entry = r[rule.key];
      expect(entry?.kind, `${rule.key} must be a registry rule`).toBe("rule");
      expect(rule.relaxed(entry.strict), `${rule.key}: its strict default is not relaxed`).toBe(false);
      expect(rule.samples.some((v) => entry.relaxed(v)), `${rule.key}: a sample must be relaxed`).toBe(true);
      for (const v of [entry.strict, ...rule.samples]) {
        expect(rule.relaxed(v), `${rule.key}=${JSON.stringify(v)}`).toBe(entry.relaxed(v));
      }
    }
  });

  it("exempt keys are exempt; stored-only keys have no relaxed value; own-endpoint keys are outside the registry", async () => {
    const r = await registry();
    for (const k of ORG_PAGE_EXEMPT) expect(r[k]?.kind, k).toBe("exempt");
    for (const k of ORG_PAGE_STORED_ONLY) {
      expect(r[k]?.kind, k).toBe("rule");
      for (const v of [r[k].strict, null, "enforce_at_login", "enforce_continuous", [], ["openai"]]) {
        expect(r[k].relaxed(v), `${k}=${JSON.stringify(v)}`).toBe(false);
      }
    }
    for (const rule of ORG_PAGE_OWN_ENDPOINT) expect(r[rule.key], rule.key).toBeUndefined();
    for (const k of ORG_PAGE_SPEC_TABS.flatMap((g) => g.keys)) expect(ALL_SPECS[k], k).toBeDefined();
  });

  it("the review's case: semantic cache always is relaxed, the model judge is not", () => {
    const sem = ORG_PAGE_RELAXED.find((x) => x.key === "semanticCachePolicy")!;
    expect(sem.relaxed("always")).toBe(true);
    expect(ORG_PAGE_RELAXED.some((x) => x.key === "recommendationJudgeEnabled")).toBe(false);
  });
});
