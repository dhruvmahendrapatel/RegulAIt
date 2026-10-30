/**
 * T1 Phase 1 (owner decision on #453, 2026-10-21): how regulAIt looks for this person — one of six palettes and
 * Light, Dark or Match my device. Colours only: risk colours, words and layout stay the same in every palette.
 * Kept in this browser for now; saving it to the account (with an organisation default) is Phase 2.
 */
import { useEffect } from "react";
import { loadPaletteSheet, PALETTES, setPalette, usePalette } from "../../theme/palette";
import { setThemeMode, useThemeMode, type ThemeMode } from "../../theme/mode";
import { Card } from "../../ui/kit";
import a from "./appearance.module.css";

const MODES: ReadonlyArray<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "system", label: "Match my device" },
];

export default function AppearanceCard() {
  const palette = usePalette();
  const mode = useThemeMode();
  useEffect(() => {
    void loadPaletteSheet().catch(() => undefined);
  }, []);
  return (
    <Card
      title="Appearance"
      info={<p>This changes colours only: risk colours, words and layout stay the same.</p>}
    >
      <p className={a.lead}>The choice is kept in this browser.</p>
      <fieldset className={a.group}>
        <legend className={a.legend}>Theme</legend>
        <div className={a.themes}>
          {PALETTES.map((p) => (
            <label key={p.id} className={a.option} data-checked={palette === p.id || undefined}>
              <input
                type="radio"
                name="appearance-theme"
                value={p.id}
                checked={palette === p.id}
                onChange={() => void setPalette(p.id)}
              />
              <span className={a.swatch} data-swatch={p.id} aria-hidden>
                <span className={a.dot} />
              </span>
              <span className={a.text}>
                <span className={a.name}>{p.name}</span>
                <span className={a.tag}>{p.tag}</span>
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
                onChange={() => setThemeMode(m.id)}
              />
              {m.label}
            </label>
          ))}
        </div>
      </fieldset>
    </Card>
  );
}
