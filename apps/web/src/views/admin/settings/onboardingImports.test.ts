import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GROUP_SOURCES, importRows, readPlan, refusalLines } from "./onboardingImports";
import { walkState } from "./ReencryptionStatusCard";

const src = readFileSync(new URL("../../../../../../packages/shared/src/onboarding.ts", import.meta.url).pathname, "utf8");

describe("group → role import rows", () => {
  it("the sources are the shared schema's", () => {
    expect(src).toContain(`source: z.enum([${GROUP_SOURCES.map((s) => `"${s}"`).join(", ")}])`);
  });
  it("blank rows are dropped; a half-filled row names itself; values are trimmed", () => {
    expect(importRows([{ source: "scim", externalGroup: " eng ", roleName: " Developer " }, { source: "oidc", externalGroup: "", roleName: "" }])).toEqual({
      ok: true,
      rows: [{ source: "scim", externalGroup: "eng", roleName: "Developer" }],
    });
    const half = importRows([{ source: "oidc", externalGroup: "ops", roleName: "" }]);
    expect(!half.ok && half.problem).toBe("Row 1: enter both the group and the role.");
    expect(importRows([{ source: "oidc", externalGroup: "", roleName: "" }]).ok).toBe(false);
    expect(importRows([{ source: "oidc", externalGroup: "g".repeat(513), roleName: "r" }]).ok).toBe(false);
  });
  it("a plan is read defensively, never as an empty success", () => {
    expect(readPlan(undefined)).toBeNull();
    expect(readPlan({ entries: "x", counts: {} })).toBeNull();
    expect(readPlan({ entries: [], counts: { create: 0, unchanged: 0, unknown_role: 0 } })?.unknownRoles).toEqual([]);
  });
  it("refusals name what to fix", () => {
    expect(refusalLines("unknown_role", { unknownRoles: ["Auditor"] })[0]).toBe("These roles do not exist: Auditor.");
    expect(refusalLines("import_privilege_escalation_refused", { findings: [{ path: "rows.0.isAdmin" }] })).toEqual(["Refused field: rows.0.isAdmin"]);
    expect(refusalLines("import_validation_failed", { issues: [{ path: ["rows", 0, "roleName"], message: "Required" }] })).toEqual(["rows.0.roleName: Required"]);
    expect(refusalLines("other", { a: 1 })).toEqual([]);
  });
});

describe("re-encryption walk state", () => {
  it("an incomplete walk is an alarm; an unknown status is never read as complete", () => {
    expect(walkState("running").tone).toBe("danger");
    expect(walkState("completed_with_failures").tone).toBe("warn");
    expect(walkState("completed")).toEqual({ tone: "ok", label: "completed" });
    expect(walkState("paused")).toEqual({ tone: "warn", label: "status: paused" });
  });
});
