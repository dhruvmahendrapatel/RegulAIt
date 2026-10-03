/** UIW-03 — the active suite is the person's suite, never an admin rail shown to a non-admin. */
import { describe, expect, it } from "vitest";
import { suiteOfPath } from "./suites";

describe("suiteOfPath", () => {
  it("resolves an admin path to its admin suite for an admin", () => {
    const suite = suiteOfPath("/admin/users", true);
    expect(suite.admin).toBe(true);
    expect(suite.id).toBe("identity-access");
  });
  it("falls back to the Workspace suite for a non-admin on the same path", () => {
    const suite = suiteOfPath("/admin/users", false);
    expect(suite.admin).toBe(false);
    expect(suite.id).toBe("workspace");
  });
  it("leaves non-admin paths alone either way", () => {
    expect(suiteOfPath("/runs/abc", false).id).toBe("workspace");
    expect(suiteOfPath("/runs/abc", true).id).toBe("workspace");
  });
});
