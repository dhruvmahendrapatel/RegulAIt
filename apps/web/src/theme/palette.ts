/**
 * T1 Phase 1 (owner decision on #453, 2026-10-21): the colour palette a person picks, kept in this browser beside
 * `regulait.theme` (light / dark). Aurora is tokens.css itself; any other palette loads palettes.css on demand and
 * sets `data-palette` on <html> once that sheet is in, so the page never shows a palette name without its colours.
 * Phase 2 moves the choice to the account, with an organisation default and lock (needs a migration).
 */
import { useSyncExternalStore } from "react";

export type PaletteId = "aurora" | "harbor" | "evergreen" | "graphite" | "orchid" | "contrast";

/** the picker's swatch colours are `[data-swatch]` rules in palettes.css, beside the real tokens (palette.test.ts checks they agree) */
export const PALETTES: ReadonlyArray<{ id: PaletteId; name: string; tag: string }> = [
  { id: "aurora", name: "Aurora", tag: "Default · cyan" },
  { id: "harbor", name: "Harbor", tag: "Blue · slate" },
  { id: "evergreen", name: "Evergreen", tag: "Teal · sage" },
  { id: "graphite", name: "Graphite", tag: "Neutral · indigo" },
  { id: "orchid", name: "Orchid", tag: "Plum · blush" },
  { id: "contrast", name: "High contrast", tag: "Accessibility" },
];

const KEY = "regulait.palette";
const listeners = new Set<() => void>();
let sheet: Promise<unknown> | null = null;

/** palettes.css: the palette tokens and the picker's swatches; the Appearance card loads it to draw them */
export function loadPaletteSheet(): Promise<unknown> {
  sheet ??= import("./palettes.css");
  return sheet;
}

function isPalette(value: unknown): value is PaletteId {
  return PALETTES.some((p) => p.id === value);
}

function stored(): PaletteId {
  try {
    const value = localStorage.getItem(KEY);
    return isPalette(value) ? value : "aurora";
  } catch {
    return "aurora";
  }
}

/** the latest choice: the picker shows it at once, while its sheet may still be loading */
let latest: PaletteId = "aurora";

function current(): PaletteId {
  return latest;
}

async function apply(id: PaletteId): Promise<void> {
  latest = id;
  listeners.forEach((l) => l());
  if (id !== "aurora") {
    await loadPaletteSheet();
  }
  // a later choice landed while the sheet loaded: that one wins
  if (latest !== id) return;
  if (id === "aurora") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = id;
  listeners.forEach((l) => l());
}

/** before the first render: the stored palette, so the app paints in it (Aurora needs nothing) */
export function startPalette(): Promise<void> {
  const id = stored();
  return id === "aurora" ? Promise.resolve() : apply(id).catch(() => undefined);
}

export function setPalette(id: PaletteId): Promise<void> {
  try {
    if (id === "aurora") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, id);
  } catch {
    // storage unavailable: the choice lasts for this visit only
  }
  return apply(id);
}

export function usePalette(): PaletteId {
  return useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, current);
}
