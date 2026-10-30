/**
 * ADR-0218: the web's palette list and the gateway's (`@regulait/shared`, which the database CHECKs repeat) agree, and
 * the lock rule the Appearance card applies is the gateway's: while locked, only the organisation default and High
 * contrast are offered, and High contrast is never taken away.
 */
import { describe, expect, it } from "vitest";
import { ACCESSIBILITY_PALETTE, PALETTES } from "./palette";

/* eslint-disable @typescript-eslint/no-explicit-any */
const shared = async (): Promise<any> =>
  import(/* @vite-ignore */ new URL("../../../../packages/shared/src/appearance.ts", import.meta.url).pathname);

describe("the palette list matches the gateway's", () => {
  it("same ids, same order, same accessibility palette", async () => {
    const s = await shared();
    expect(PALETTES.map((p) => p.id)).toEqual([...s.THEME_PALETTE_IDS]);
    expect(ACCESSIBILITY_PALETTE).toBe(s.ACCESSIBILITY_PALETTE);
    expect(s.DEFAULT_THEME_PALETTE).toBe("aurora");
  });
});

describe("the lock rule", () => {
  it("unlocked: every palette; locked: only the default and High contrast", async () => {
    const s = await shared();
    const unlocked = { defaultPalette: "harbor", locked: false };
    const locked = { defaultPalette: "harbor", locked: true };
    for (const p of PALETTES) expect(s.paletteAllowed(p.id, unlocked)).toBe(true);
    expect(PALETTES.filter((p) => s.paletteAllowed(p.id, locked)).map((p) => p.id)).toEqual(["harbor", "contrast"]);
  });
  it("the effective palette: the default when nothing is saved or the lock overrides; High contrast always wins", async () => {
    const s = await shared();
    const locked = { defaultPalette: "evergreen", locked: true };
    expect(s.effectivePalette(null, locked)).toBe("evergreen");
    expect(s.effectivePalette("orchid", locked)).toBe("evergreen");
    expect(s.effectivePalette("contrast", locked)).toBe("contrast");
    expect(s.effectivePalette("orchid", { ...locked, locked: false })).toBe("orchid");
  });
  it("the account route takes only a listed palette or mode, and never a user id", async () => {
    const s = await shared();
    const ok = (b: unknown) => s.setAppearanceSchema.safeParse(b).success;
    expect(ok({ palette: "contrast" })).toBe(true);
    expect(ok({ mode: "system" })).toBe(true);
    expect(ok({ palette: null })).toBe(true);
    for (const bad of [{}, { palette: "neon" }, { mode: "sepia" }, { palette: "aurora", userId: "x" }]) expect(ok(bad)).toBe(false);
  });
});
