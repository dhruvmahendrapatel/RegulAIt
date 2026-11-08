/**
 * ADR-0255 (P31) — the Activepieces EE guard. The repository scan runs here, so CI's `vitest run --dir scripts` step
 * fails on any Enterprise-licensed import, vendored file or lockfile entry. Negative controls show each rule fires.
 */
import { describe, expect, it } from "vitest";
import {
  allowedActivepiecesPackage,
  availableFindings,
  curatedKeys,
  badSpecifier,
  curatedUpstreamFindings,
  isActivepiecesEePath,
  run,
  scan,
  specifiers,
} from "./activepieces-ee-guard.mjs";

describe("activepieces-ee-guard (ADR-0255)", () => {
  it("the repository is clean", () => {
    expect(run()).toEqual([]);
  });

  it("allows only community and framework packages", () => {
    for (const ok of ["@activepieces/piece-slack", "@activepieces/pieces-framework", "@activepieces/pieces-common", "@activepieces/shared", "zod"]) {
      expect(allowedActivepiecesPackage(ok), ok).toBe(true);
    }
    for (const bad of ["@activepieces/ee-shared", "@activepieces/ee", "@activepieces/server-api", "@activepieces/piece-x/ee", "@activepieces/engine"]) {
      expect(allowedActivepiecesPackage(bad), bad).toBe(false);
    }
  });

  it("names a vendored EE path", () => {
    expect(isActivepiecesEePath("vendor/activepieces/packages/ee/billing.ts")).toBe(true);
    expect(isActivepiecesEePath("third_party/activepieces/packages/server/api/src/app/ee/sso.ts")).toBe(true);
    expect(isActivepiecesEePath("vendor/activepieces/packages/pieces/community/slack/index.ts")).toBe(false);
    expect(isActivepiecesEePath("apps/web/src/ee/thing.ts")).toBe(false);
  });

  it("finds every import form", () => {
    const src = [
      'import { a } from "@activepieces/ee-shared";',
      'export * from "../activepieces/packages/ee/x.js";',
      'const m = await import("@activepieces/ee");',
      'const r = require("vendor/activepieces/packages/server/api/src/app/ee/y");',
      'import "@activepieces/server-api";',
      'import { z } from "zod";',
    ].join("\n");
    const specs = specifiers(src);
    expect(specs.filter(badSpecifier)).toHaveLength(5);
  });

  it("flags a vendored file, a bad import and a locked EE package", () => {
    const files = ["vendor/activepieces/packages/ee/a.ts", "apps/x.ts", "pnpm-lock.yaml"];
    const contents = { "vendor/activepieces/packages/ee/a.ts": "", "apps/x.ts": 'import x from "@activepieces/ee-shared";', "pnpm-lock.yaml": "  /@activepieces/ee-shared@1.0.0:\n" };
    const findings = scan(files, (f) => contents[f]);
    expect(findings).toHaveLength(3);
  });

  it("refuses a curated upstream outside packages/pieces/community", () => {
    const one = (p) => `export const CURATED_PIECES = [\n  {\n    key: "slack",\n    upstream: { npm: "x", version: "1", path: "${p}" },\n  },\n];`;
    expect(curatedUpstreamFindings(one("packages/ee/slack"))).toHaveLength(1);
    expect(curatedUpstreamFindings(one("packages/pieces/community/slack"))).toEqual([]);
  });

  it("a curated check that matches nothing fails instead of passing", () => {
    expect(curatedUpstreamFindings("no curated pieces here").length).toBeGreaterThan(0);
    const one = 'export const CURATED_PIECES = [\n  {\n    key: "slack",\n    upstream: { npm: "x", version: "1", path: "packages/pieces/community/slack" },\n  },\n  {\n    key: "gmail",\n  },\n];';
    expect(curatedKeys(one)).toEqual(["slack", "gmail"]);
    expect(curatedUpstreamFindings(one).join()).toMatch(/2 pieces but only 1 upstream path/);
  });

  it("checks every available row's upstream path and the recorded commit", () => {
    const ok = 'commit: "' + "a".repeat(40) + '",\n  ["notion", "0.8.3", "packages/pieces/community/notion"],\n';
    expect(availableFindings(ok)).toEqual([]);
    expect(availableFindings('commit: "' + "a".repeat(40) + '",\n  ["agent", "0.3.7", "packages/pieces/core/agent"],\n')).toHaveLength(1);
    expect(availableFindings('  ["notion", "0.8.3", "packages/pieces/community/notion"],\n').join()).toMatch(/no 40-character upstream commit/);
    expect(availableFindings("").join()).toMatch(/vacuous/);
    expect(availableFindings('commit: "' + "a".repeat(40) + '",\n  ["notion", "0.8.3"],\n').join()).toMatch(/only 0 are/);
  });
});
