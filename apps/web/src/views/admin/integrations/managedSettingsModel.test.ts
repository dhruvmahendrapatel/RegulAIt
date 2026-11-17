/**
 * Managed settings (UI-D D1): the form refuses what the gateway refuses before anything is sent, the list path is the
 * contract's keyset query, names are joined (a missing one is named by its kind), and the export flow only moves
 * along its declared transitions.
 */
import { describe, expect, it } from "vitest";
import {
  EXPORT_IDLE,
  archiveName,
  exportBlockedReason,
  exportBody,
  exportReducer,
  filterValue,
  listPath,
  parseFilter,
  resultWords,
  subjectWords,
  versionProblem,
  type ExportResult,
} from "./managedSettingsModel";

const U = "aaaaaaaa-0000-4000-8000-000000000001";
const result = { id: "b1", subject: { kind: "user", id: U }, version: 3, created: true } as ExportResult;

describe("versionProblem", () => {
  it("accepts an empty value and a dotted version", () => {
    expect(versionProblem("")).toBeNull();
    expect(versionProblem(" 1.0.30 ")).toBeNull();
  });
  it("refuses what the gateway's pattern refuses", () => {
    expect(versionProblem("1.0")).toMatch(/1\.0\.30/);
    expect(versionProblem("v1.0.30")).not.toBeNull();
    expect(versionProblem("12345.0.0")).not.toBeNull();
  });
});

describe("exportBody", () => {
  it("omits an empty minimum version and trims one that is set", () => {
    expect(exportBody("role", U, " ")).toEqual({ subject: { kind: "role", id: U } });
    expect(exportBody("user", U, " 1.2.3 ")).toEqual({ subject: { kind: "user", id: U }, claudeCodeMinimumVersion: "1.2.3" });
  });
});

describe("listPath and the subject filter", () => {
  it("sends the subject and cursor only when set", () => {
    expect(listPath(null)).toBe("/v1/managed-settings/bundles?limit=50");
    expect(listPath({ kind: "role", id: U }, "c1")).toBe(`/v1/managed-settings/bundles?limit=50&subjectKind=role&subjectId=${U}&before=c1`);
  });
  it("round-trips the Select value, and reads anything else as everyone", () => {
    expect(parseFilter(filterValue({ kind: "user", id: U }))).toEqual({ kind: "user", id: U });
    expect(parseFilter("")).toBeNull();
    expect(parseFilter("team:x")).toBeNull();
  });
});

describe("names and words", () => {
  const names = { users: new Map([[U, "Avery"]]), roles: new Map<string, string>() };
  it("joins the subject's current name and names a missing one by kind", () => {
    expect(subjectWords({ kind: "user", id: U }, names)).toBe("Avery (user)");
    expect(subjectWords({ kind: "role", id: U }, names)).toBe("A role that no longer exists");
  });
  it("names the archive as the gateway does and says when no new version was made", () => {
    expect(archiveName(result)).toBe("regulait-managed-settings-user-v3.tar.gz");
    expect(resultWords({ created: false, version: 2 })).toMatch(/no new version/);
    expect(resultWords({ created: true, version: 3 })).toMatch(/Version 3 exported/);
  });
});

describe("exportReducer", () => {
  it("exports only from the open form and closes with the result", () => {
    expect(exportReducer(EXPORT_IDLE, { type: "submit" })).toBe(EXPORT_IDLE);
    const choosing = exportReducer(EXPORT_IDLE, { type: "open" });
    const exporting = exportReducer(choosing, { type: "submit" });
    expect(exporting.step).toBe("exporting");
    expect(exportReducer(exporting, { type: "ok", result })).toEqual({ step: "closed", last: result });
  });
  it("cannot be closed while exporting, and a refusal returns to the form", () => {
    const exporting = { step: "exporting" as const, last: null };
    expect(exportReducer(exporting, { type: "close" })).toBe(exporting);
    expect(exportReducer(exporting, { type: "fail" })).toEqual({ step: "choosing", last: null });
    expect(exportBlockedReason(exporting)).toMatch(/Exporting/);
    expect(exportBlockedReason({ step: "choosing", last: null })).toBeNull();
  });
});
