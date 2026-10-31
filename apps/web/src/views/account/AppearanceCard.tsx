/**
 * T1 (owner decision on #453, 2026-10-21): how regulAIt looks for this person — one of six palettes and Light, Dark or
 * Match my device. Colours only: risk colours, words and layout stay the same in every palette.
 * Phase 2 (ADR-0218): the choice is saved to the person's account, so it follows them to any browser. While their
 * organisation has locked the theme, only its default palette and High contrast are offered; High contrast always
 * stays available (accessibility). A refused save is shown here, beside the choice, and the page goes back to what the
 * account holds.
 */
import { useEffect, useState } from "react";
import { ACCESSIBILITY_PALETTE, loadPaletteSheet, PALETTES, setPalette, usePalette, type PaletteId } from "../../theme/palette";
import { setThemeMode, useThemeMode, type ThemeMode } from "../../theme/mode";
import { saveAppearance } from "../../theme/account";
import { ApiError } from "../../api/client";
import type { AccountAppearance } from "../../api/types";
import { useSession } from "../../session/SessionContext";
import { Card } from "../../ui/kit";
import v from "../views.module.css";
import a from "./appearance.module.css";

const MODES: ReadonlyArray<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "Match my device" },
];

function saveError(err: unknown): string {
  if (err instanceof ApiError && err.payload.error === "palette_locked")
    return "Your organisation has set the theme for everyone, so that one isn't available. You can still choose High contrast.";
  return "Your choice couldn't be saved to your account, so it applies in this browser only. Try again in a moment.";
}

export default function AppearanceCard() {
  const { auth } = useSession();
  const palette = usePalette();
  const mode = useThemeMode();
  // what the account holds, updated by each save (the session's copy is refreshed on the next sign-in or reload)
  const [account, setAccount] = useState<AccountAppearance | undefined>(auth?.appearance);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadPaletteSheet().catch(() => undefined);
  }, []);
  useEffect(() => setAccount(auth?.appearance), [auth?.appearance]);

  const saves = account?.saved === true;
  const locked = account?.org.locked === true;
  const offered = locked
    ? PALETTES.filter((p) => p.id === account?.org.defaultPalette || p.id === ACCESSIBILITY_PALETTE)
    : PALETTES;

  const save = async (patch: { palette?: PaletteId; mode?: ThemeMode }, undo: () => void) => {
    setError(null);
    if (!saves) return;
    try {
      const next = await saveAppearance(patch);
      if (next) setAccount(next);
    } catch (err) {
      undo();
      setError(saveError(err));
    }
  };

  const pickPalette = (id: PaletteId) => {
    const before = palette;
    void setPalette(id);
    void save({ palette: id }, () => void setPalette(before));
  };
  const pickMode = (id: ThemeMode) => {
    const before = mode;
    setThemeMode(id);
    void save({ mode: id }, () => setThemeMode(before));
  };

  return (
    <Card
      title="Appearance"
      info={<p>This changes colours only: risk colours, words and layout stay the same.</p>}
    >
      <p className={a.lead} data-testid="appearance-lead">
        {saves ? "Your choice is saved to your account, so it follows you to any browser." : "The choice is kept in this browser."}
      </p>
      {locked && (
        <p className={a.lead} data-testid="appearance-locked">
          Your organisation has set the theme for everyone. High contrast is always available.
        </p>
      )}
      {error && (
        <p className={v.errLine} role="alert" data-testid="appearance-error">
          {error}
        </p>
      )}
      <fieldset className={a.group}>
        <legend className={a.legend}>Theme</legend>
        <div className={a.themes}>
          {offered.map((p) => (
            <label key={p.id} className={a.option} data-checked={palette === p.id || undefined}>
              <input
                type="radio"
                name="appearance-theme"
                value={p.id}
                checked={palette === p.id}
                onChange={() => pickPalette(p.id)}
              />
              <span className={a.swatch} data-swatch={p.id} aria-hidden>
                <span className={a.dot} />
              </span>
              <span className={a.text}>
                <span className={a.name}>{p.name}</span>
                <span className={a.tag}>{locked && p.id !== ACCESSIBILITY_PALETTE ? "Organisation default" : p.tag}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className={a.group}>
        <legend className={a.legend}>Mode</legend>
        <div className={a.modes}>
          {MODES.map((m) => (
            <label key={m.id} className={a.option} data-checked={mode === m.id || undefined}>
              <input
                type="radio"
                name="appearance-mode"
                value={m.id}
                checked={mode === m.id}
                onChange={() => pickMode(m.id)}
              />
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>
    </Card>
  );
}
