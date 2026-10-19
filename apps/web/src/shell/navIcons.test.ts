import { describe, expect, it } from "vitest";
import { hasNavGlyph, navGlyphKey } from "./navIcons";
import { ADMIN_GROUPS, WORKSPACE } from "./suites";

// ADR-0169: the collapsed rail is an icon strip, so every destination needs a
// drawn glyph. The monogram fallback exists so a new entry never renders blank,
// but it is a fallback, not a design — this says when one is missing.
describe("nav glyphs", () => {
  it("every navigation destination has a drawn glyph", () => {
    const routes = [...WORKSPACE, ...ADMIN_GROUPS.flatMap((g) => g.items)].map((n) => n.to);
    expect(routes.filter((to) => !hasNavGlyph(to))).toEqual([]);
  });

  it("Shadow-AI discovery and Discovery sources, adjacent in the rail, draw different glyphs", () => {
    expect(navGlyphKey("/admin/shadow-ai")).not.toBeNull();
    expect(navGlyphKey("/admin/shadow-ai/discovery-sources")).not.toBe(navGlyphKey("/admin/shadow-ai"));
  });
});
