/** ADR-0173 §4 — the command palette's data rules. */
import { describe, expect, it } from "vitest";
import { pageItems, pushRecent, readRecent, searchPalette, type PaletteItem } from "./commandPaletteModel";
import { SUITES } from "./suites";

describe("pages", () => {
  it("never lists an admin page to a non-admin", () => {
    const pages = pageItems(false);
    expect(pages.filter((p) => p.to.startsWith("/admin"))).toEqual([]);
    // the person's own suites are all there
    for (const to of ["/", "/chat", "/models", "/builder", "/builder/agents", "/projects", "/account"]) {
      expect(pages.map((p) => p.to)).toContain(to);
    }
  });

  it("lists every admin destination to an admin, the model policy page among them", () => {
    const pages = pageItems(true);
    const adminRoutes = SUITES.filter((s) => s.admin).flatMap((s) => s.sections.flatMap((g) => g.items.map((n) => n.to)));
    expect(adminRoutes.length).toBeGreaterThan(20);
    for (const to of adminRoutes) expect(pages.map((p) => p.to)).toContain(to);
    expect(pages.find((p) => p.to === "/admin/model-policy")?.label).toBe("Model policy");
  });

  it("a search a non-admin types for an admin page finds nothing to open", () => {
    const hits = searchPalette(pageItems(false), "model policy").flatMap((g) => g.items);
    expect(hits).toEqual([]);
    const adminHits = searchPalette(pageItems(true), "model policy").flatMap((g) => g.items);
    expect(adminHits[0]?.to).toBe("/admin/model-policy");
  });

  it("nav labels are unique across every suite (the palette and the / filter search them all)", () => {
    const labels = SUITES.flatMap((s) => s.sections.flatMap((g) => g.items.map((n) => n.label)));
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
    expect(dupes).toEqual([]);
  });
});

const item = (kind: PaletteItem["kind"], label: string, sub?: string): PaletteItem => ({
  key: `${kind}:${label}`,
  kind,
  label,
  ...(sub ? { sub } : {}),
  to: `/${kind}/${label}`,
});

describe("search", () => {
  const items = [
    item("page", "Models"),
    item("page", "Model risk", "AI Governance"),
    item("model", "claude-opus", "claude-opus-5"),
    item("builder_agent", "Policy summariser"),
    item("project", "Northwind models"),
  ];

  it("ranks a label prefix above a word match above a substring, and groups by kind in a fixed order", () => {
    const groups = searchPalette(items, "model");
    expect(groups.map((g) => g.kind)).toEqual(["page", "project"]);
    expect(groups[0]!.items.map((i) => i.label)).toEqual(["Model risk", "Models"]);
  });

  it("requires every term to match (label or secondary text)", () => {
    expect(searchPalette(items, "claude opus 5").flatMap((g) => g.items.map((i) => i.label))).toEqual(["claude-opus"]);
    expect(searchPalette(items, "risk governance").flatMap((g) => g.items.map((i) => i.label))).toEqual(["Model risk"]);
    expect(searchPalette(items, "risk zzz")).toEqual([]);
  });

  it("with no query shows recent items first (only ones still listed), then pages", () => {
    const groups = searchPalette(items, "", { recentKeys: ["builder_agent:Policy summariser", "model:gone"] });
    expect(groups[0]).toEqual({ kind: "recent", items: [items[3]] });
    expect(groups[1]!.kind).toBe("page");
  });

  it("remembers recent items most-recent-first, without duplicates", () => {
    let r: string[] = [];
    r = pushRecent(r, "a");
    r = pushRecent(r, "b");
    r = pushRecent(r, "a");
    expect(r).toEqual(["a", "b"]);
  });

  it("survives storage being unavailable", () => {
    // vitest's node environment has no localStorage: both calls must still work
    expect(readRecent()).toEqual([]);
    expect(pushRecent([], "x")).toEqual(["x"]);
  });
});
