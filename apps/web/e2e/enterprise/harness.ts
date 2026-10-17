/**
 * Shared steps of the enterprise UI harness (ADR-0196): the route list, the themes and viewports, and opening a
 * screen in a settled state.
 */
import type { Page } from "@playwright/test";
import { routeSlug, spaRoutes, type SpaRoute } from "../../../../scripts/ui-spa-routes.mjs";

export { routeSlug, type SpaRoute };
export const ROUTES: SpaRoute[] = spaRoutes();
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
/** desktop 1280 / 1440 / 1920, tablet 768 / 1024 (the owner's bar 2) */
export const VIEWPORTS = [
  { name: "desktop-1280", width: 1280, height: 800 },
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "desktop-1920", width: 1920, height: 1080 },
  { name: "tablet-1024", width: 1024, height: 768 },
  { name: "tablet-768", width: 768, height: 1024 },
] as const;

/** the persisted theme, applied before first paint by index.html's own script (what a returning user gets) */
export async function presetTheme(page: Page, theme: Theme) {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem("regulait.theme", t);
    } catch {
      /* storage blocked: the page falls back to the system theme */
    }
  }, theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
}

/** switch the theme on an open page and wait out the colour transitions it starts */
export async function switchTheme(page: Page, theme: Theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("regulait.theme", t);
    } catch {
      /* the attribute alone themes the page */
    }
  }, theme);
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
}

/**
 * Open a screen and wait until it has settled: the network is idle (the mock's error answers, including the one
 * retry, have landed), fonts are loaded and no animation is running.
 */
export async function openRoute(page: Page, route: SpaRoute, opts: { idle?: boolean } = {}) {
  await page.goto(`/ui${route.url}`, { waitUntil: "load" });
  if (opts.idle !== false) await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
}
