/**
 * ADR-0255 (P31) — the Activepieces EE guard. The repository scan runs here, so CI's `vitest run --dir scripts` step
 * fails on any Enterprise-licensed import, vendored file or lockfile entry. Negative controls show each rule fires.
 */
import { describe, expect, it } from "vitest";
import {
  allowedActivepiecesPackage,
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
    expect(curatedUpstreamFindings('upstream: { npm: "x", version: "1", path: "packages/ee/slack" }')).toHaveLength(1);
    expect(curatedUpstreamFindings('upstream: { npm: "x", version: "1", path: "packages/pieces/community/slack" }')).toEqual([]);
  });
});
