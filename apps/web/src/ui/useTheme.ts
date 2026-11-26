import { useCallback, useSyncExternalStore } from "react";

const KEY = "regulait.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function currentTheme(): "light" | "dark" {
  const explicit = document.documentElement.dataset.theme;
  if (explicit === "light" || explicit === "dark") return explicit;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/**
 * UIS-07: the theme is whatever `data-theme` on <html> says, or the OS when it is unset. Every writer (this toggle,
 * the Appearance card in theme/mode.ts, the account's saved appearance) changes that attribute, so the store watches
 * the attribute and the OS preference rather than a listener set only this module fires. theme/mode.ts is not
 * imported here: it is kept out of the entry bundle.
 */
function subscribe(cb: () => void): () => void {
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", cb);
  return () => {
    observer.disconnect();
    media.removeEventListener("change", cb);
  };
}

export function useTheme(): { theme: "light" | "dark"; toggle: () => void } {
  const theme = useSyncExternalStore(subscribe, currentTheme);
  const toggle = useCallback(() => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode — the toggle still works for the tab */
    }
    // ADR-0218: saved to the account too, when there is one (loaded on demand)
    void import("../theme/account").then((m) => m.saveModeQuietly(next)).catch(() => undefined);
  }, []);
  return { theme, toggle };
}
