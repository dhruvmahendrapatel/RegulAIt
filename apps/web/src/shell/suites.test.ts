/** UIW-03 — the active suite is the person's suite, never an admin rail shown to a non-admin. */
import { describe, expect, it } from "vitest";
import { SUITES, shadowedByMoreSpecific, suiteOfPath } from "./suites";

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

describe("AI Governance suite sections (owner decision on #453, 2026-10-21)", () => {
  const suite = SUITES.find((x) => x.id === "ai-governance")!;
  it("puts Discovery between Overview and the AI Governance registers", () => {
    expect(suite.sections.map((sec) => sec.group)).toEqual(["Overview", "Discovery", "AI Governance"]);
  });
  it("holds Shadow-AI discovery and Discovery sources, which the registers no longer repeat", () => {
    const discovery = suite.sections.find((sec) => sec.group === "Discovery")!;
    expect(discovery.items.map((i) => i.to)).toEqual(["/admin/shadow-ai", "/admin/shadow-ai/discovery-sources"]);
    const registers = suite.sections.find((sec) => sec.group === "AI Governance")!;
    expect(registers.items.some((i) => i.to.startsWith("/admin/shadow-ai"))).toBe(false);
  });
  it("still resolves both Discovery pages to the AI Governance suite", () => {
    expect(suiteOfPath("/admin/shadow-ai", true).id).toBe("ai-governance");
    expect(suiteOfPath("/admin/shadow-ai/discovery-sources", true).id).toBe("ai-governance");
  });
});
