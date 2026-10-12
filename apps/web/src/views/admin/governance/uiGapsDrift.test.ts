/**
 * Drift guards for values the governance UI-gap screens mirror from the
 * gateway (the SPA does not depend on `@regulait/shared` at runtime), plus the
 * review-round model behaviours: the ABAC schema note, the shadow-AI
 * environment with no default, and releasing only on-screen picks.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AbacPolicyVersion } from "../../../api/adminTypes";
import { ABAC_LIMITS, schemaNote } from "./abacModel";
import { REMEDIATION_STATUSES } from "./RemediationsCard";
import { startFormFrom, startInstanceBody, type RemediationPlan } from "./shadowRemediationModel";
import { pickedOnScreen, type RetentionHold } from "../observability/retentionHoldsModel";

describe("drift against the gateway", () => {
  it("REMEDIATION_STATUSES matches packages/shared remediation.ts", async () => {
    const shared = await import(new URL("../../../../../../packages/shared/src/remediation.ts", import.meta.url).pathname);
    expect([...REMEDIATION_STATUSES]).toEqual([...shared.REMEDIATION_STATUSES]);
  });

  it("ABAC_LIMITS matches the bounds of versionBodySchema in apps/gateway/src/abac.ts", () => {
    const src = readFileSync(new URL("../../../../../gateway/src/abac.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("const versionBodySchema = z.object({"));
    const body = block.slice(0, block.indexOf("});"));
    const num = (re: RegExp) => Number(body.match(re)?.[1]?.replace(/_/g, ""));
    expect(num(/source: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(([\d_]+)\)/)).toBe(ABAC_LIMITS.sourceMax);
    expect(num(/timezone: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(([\d_]+)\)/)).toBe(ABAC_LIMITS.timezoneMax);
    expect(num(/testCases: z\.array\(testCaseSchema\)\.max\(([\d_]+)\)/)).toBe(ABAC_LIMITS.testCasesMax);
  });
});

describe("ABAC schema note", () => {
  const version = (n: number, schemaVersion: string) => ({ id: `v${n}`, version: n, schemaVersion }) as AbacPolicyVersion;
  it("says a new version is saved on the current schema, and flags an older one", () => {
    expect(schemaNote([version(1, "v4")], "v4")).toBe("The new version is validated and saved against the current attribute schema (v4).");
    expect(schemaNote([version(1, "v2"), version(2, "v3")], "v4")).toContain("v2 was written against v3, so an attribute that schema allowed may now be refused.");
    expect(schemaNote([], null)).toBe("The new version is validated and saved against the current attribute schema.");
  });
});

describe("shadow-AI environment", () => {
  const plan: RemediationPlan = {
    findingId: "f1",
    subject: "app.example",
    provider: "example-provider",
    severity: "high",
    replacementAgent: null,
    steps: [],
    workflowRequest: {
      route: "POST /v1/workflows/instances",
      body: { change: { description: "Pull app.example (example-provider) into governance — shadow-AI finding f1", paths: [], changeType: "shadow-ai-remediation", environment: "unstated", targetSystem: "app.example" } },
      needsInput: ["change.environment"],
    },
    note: "",
  };
  it("has no default and must be stated", () => {
    expect(startFormFrom(plan).environment).toBe("");
    expect(startInstanceBody(plan, startFormFrom(plan))).toEqual({ ok: false, problem: expect.stringContaining("Name the environment") });
    const built = startInstanceBody(plan, { ...startFormFrom(plan), environment: " staging " });
    expect(built.ok && built.body.change.environment).toBe("staging");
  });
});

describe("retention holds release only what is on screen", () => {
  const hold = (traceId: string, over: Partial<RetentionHold> = {}): RetentionHold => ({
    traceId,
    traceUserId: "u",
    holdUntil: "2999-01-01T00:00:00.000Z",
    ruleId: null,
    createdByUserId: null,
    releasedAt: null,
    releaseReason: null,
    ...over,
  });
  it("drops picks hidden by the filter and holds no longer active", () => {
    const rows = [hold("a"), hold("b", { releasedAt: "2026-01-01T00:00:00.000Z" }), hold("c")];
    expect(pickedOnScreen(new Set(["c", "a", "b", "hidden"]), rows)).toEqual(["a", "c"]);
  });
});
