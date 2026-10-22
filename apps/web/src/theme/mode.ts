/**
 * T1: Light, Dark or Match my device for the Appearance card. "system" clears the stored `regulait.theme` so the OS
 * decides again (tokens.css follows `prefers-color-scheme` when no `data-theme` is set). Kept out of ui/useTheme so
 * the topbar toggle's entry bundle does not grow.
 */
import { useSyncExternalStore } from "react";

export type ThemeMode = "light" | "dark" | "system";

const KEY = "regulait.theme";
const listeners = new Set<() => void>();

function currentMode(): ThemeMode {
  const explicit = document.documentElement.dataset.theme;
  return explicit === "light" || explicit === "dark" ? explicit : "system";
}

export function setThemeMode(mode: ThemeMode): void {
  if (mode === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  try {
    if (mode === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* private mode — the choice still works for the tab */
  }
  listeners.forEach((l) => l());
}

/** the topbar toggle writes `data-theme` too, so this watches the attribute rather than only its own writes */
export function useThemeMode(): ThemeMode {
  return useSyncExternalStore((cb) => {
    listeners.add(cb);
    const observer = new MutationObserver(cb);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      listeners.delete(cb);
      observer.disconnect();
    };
  }, currentMode);
}
