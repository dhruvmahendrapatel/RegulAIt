import { useCallback, useSyncExternalStore } from "react";

const KEY = "regulait.theme";
const listeners = new Set<() => void>();

function currentTheme(): "light" | "dark" {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme(): { theme: "light" | "dark"; toggle: () => void } {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    currentTheme,
  );
  const toggle = useCallback(() => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode — the toggle still works for the tab */
    }
    listeners.forEach((l) => l());
  }, []);
  return { theme, toggle };
}
