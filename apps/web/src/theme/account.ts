/**
 * ADR-0218 (themes phase 2): the palette and mode saved to the person's account. `/auth/me` carries them; the session
 * adopts them here (loaded on demand, so the entry bundle carries only the import). This browser's copy
 * (`regulait.palette`, `regulait.theme`) stays as the pre-paint cache: adopting writes it, so the next visit paints in
 * the account's palette before the first request.
 */
import { api } from "../api/client";
import type { AccountAppearance } from "../api/types";
import { ACCESSIBILITY_PALETTE, currentPalette, isPalette, setPalette, type PaletteId } from "./palette";
import { setThemeMode, type ThemeMode } from "./mode";

/** true while a signed-in person's choices go to their account (false for the bootstrap operator, or signed out) */
let toAccount = false;

const isMode = (m: unknown): m is ThemeMode => m === "light" || m === "dark" || m === "system";

/** paint what the account says: the effective palette (the organisation's lock applied) and the saved mode, if any */
export function adoptAccountAppearance(a: AccountAppearance): void {
  toAccount = a.saved;
  if (!a.saved) {
    // no account (the bootstrap operator): this browser's choice stands, unless the organisation's lock rules it out
    const own = currentPalette();
    if (a.org.locked && own !== a.org.defaultPalette && own !== ACCESSIBILITY_PALETTE && isPalette(a.org.defaultPalette))
      void setPalette(a.org.defaultPalette);
    return;
  }
  if (isPalette(a.effectivePalette)) void setPalette(a.effectivePalette);
  if (isMode(a.mode)) setThemeMode(a.mode);
}

/** signed out: nothing is saved anywhere but this browser until the next sign-in */
export function forgetAccountAppearance(): void {
  toAccount = false;
}

/** save to the account; resolves to what the account now says (null from a gateway that does not report it) */
export async function saveAppearance(patch: { palette?: PaletteId; mode?: ThemeMode }): Promise<AccountAppearance | null> {
  const r = await api.put<{ appearance?: AccountAppearance }>("/auth/appearance", patch);
  return r?.appearance ?? null;
}

/** the topbar's light/dark toggle: saved to the account when there is one; a failure leaves the browser's copy */
export function saveModeQuietly(mode: ThemeMode): void {
  if (toAccount) void saveAppearance({ mode }).catch(() => undefined);
}
