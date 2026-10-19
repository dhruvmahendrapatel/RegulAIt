/** UIW-03 — the active suite is the person's suite, never an admin rail shown to a non-admin. */
import { describe, expect, it } from "vitest";
import { shadowedByMoreSpecific, suiteOfPath } from "./suites";

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

describe("shadowedByMoreSpecific — only the active route is highlighted", () => {
  const routes = ["/", "/admin/shadow-ai", "/admin/shadow-ai/discovery-sources", "/admin/vendors"];
  it("on Discovery sources, Shadow-AI discovery is not active as well", () => {
    expect(shadowedByMoreSpecific("/admin/shadow-ai", "/admin/shadow-ai/discovery-sources", routes)).toBe(true);
    expect(shadowedByMoreSpecific("/admin/shadow-ai/discovery-sources", "/admin/shadow-ai/discovery-sources", routes)).toBe(false);
  });
  it("leaves the parent active on its own page and its other sub-paths", () => {
    expect(shadowedByMoreSpecific("/admin/shadow-ai", "/admin/shadow-ai", routes)).toBe(false);
    expect(shadowedByMoreSpecific("/admin/shadow-ai", "/admin/shadow-ai/f1", routes)).toBe(false);
  });
  it("is not fooled by a shared prefix that is not a path segment", () => {
    expect(shadowedByMoreSpecific("/admin/shadow-ai", "/admin/shadow-ai-x", [...routes, "/admin/shadow-ai-x"])).toBe(false);
  });
});
