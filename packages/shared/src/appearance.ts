/**
 * ADR-0218 (themes phase 2, migration 0238): a person's palette and light/dark mode saved to their account, an
 * organisation default palette, and an admin lock.
 *
 * The palette ids are the six the web app ships (apps/web/src/theme/palette.ts; `appearance.test.ts` there pins that
 * the two lists agree). The database CHECKs in migration 0238 repeat this list, so a row written around the API cannot
 * name a palette the app does not have either.
 *
 * The one rule that matters: High contrast (`contrast`) is an accessibility palette, so it stays selectable by
 * anyone, even while the organisation has locked the theme. A lock pins everyone else to the organisation default.
 */
import { z } from "zod";

export const THEME_PALETTE_IDS = ["aurora", "harbor", "evergreen", "graphite", "orchid", "contrast"] as const;
export type ThemePaletteId = (typeof THEME_PALETTE_IDS)[number];
/** the accessibility palette a lock never takes away */
export const ACCESSIBILITY_PALETTE: ThemePaletteId = "contrast";
/** the palette a fresh organisation starts with */
export const DEFAULT_THEME_PALETTE: ThemePaletteId = "aurora";

export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeModeId = (typeof THEME_MODES)[number];

export const themePaletteSchema = z.enum(THEME_PALETTE_IDS);
export const themeModeSchema = z.enum(THEME_MODES);

/** the two org-settings keys, spread into `updateOrgSettingsSchema` (admin-only, audited old -> new) */
export const appearanceOrgSettingsFields = {
  /** the palette everyone starts on, and the only one (besides High contrast) while `themeLocked` is on */
  themeDefaultPalette: themePaletteSchema.optional(),
  /** true = everyone uses `themeDefaultPalette`; High contrast stays selectable by anyone */
  themeLocked: z.boolean().optional(),
} as const;

/** `PUT /auth/appearance`: the caller's OWN choice. Either field may be omitted; null clears it (back to the default). */
export const setAppearanceSchema = z
  .object({
    palette: themePaletteSchema.nullable().optional(),
    mode: themeModeSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.palette !== undefined || v.mode !== undefined, { message: "name a palette or a mode" });
export type SetAppearance = z.infer<typeof setAppearanceSchema>;

/** may this person pick `palette` under the organisation's posture? */
export function paletteAllowed(palette: ThemePaletteId, org: { defaultPalette: ThemePaletteId; locked: boolean }): boolean {
  return !org.locked || palette === org.defaultPalette || palette === ACCESSIBILITY_PALETTE;
}

/** the palette this person sees: their own choice unless the lock overrides it (never overriding High contrast) */
export function effectivePalette(
  own: ThemePaletteId | null,
  org: { defaultPalette: ThemePaletteId; locked: boolean },
): ThemePaletteId {
  if (own === null) return org.defaultPalette;
  return paletteAllowed(own, org) ? own : org.defaultPalette;
}

/** what `/auth/me` and `PUT /auth/appearance` return */
export interface AccountAppearance {
  /** the person's saved palette; null = none saved (they get the organisation default) */
  palette: ThemePaletteId | null;
  /** the person's saved mode; null = none saved (this browser decides) */
  mode: ThemeModeId | null;
  /** the palette to paint now */
  effectivePalette: ThemePaletteId;
  org: { defaultPalette: ThemePaletteId; locked: boolean };
  /** false = there is no person to save to (the bootstrap operator): the choice stays in the browser */
  saved: boolean;
}
