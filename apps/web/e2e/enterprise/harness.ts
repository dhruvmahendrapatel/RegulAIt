/**
 * Shared steps of the enterprise UI harness (ADR-0196): the route list, the themes and viewports, and opening a
 * screen in a settled state.
 */
import { expect, type Page, type Request } from "@playwright/test";
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

/** how long the network must stay quiet before a screen counts as settled (Playwright's own `networkidle` window) */
export const QUIET_MS = 500;
/** a screen that has not settled by then fails with the requests still open, well inside the test timeout */
export const SETTLE_TIMEOUT_MS = 30_000;

/**
 * Open a screen and wait until it has settled: no request has been open for QUIET_MS (the mock's error answers and
 * every lazy chunk have landed), every <img> has loaded or failed, fonts are loaded and no animation is running. The
 * screen must still be the one asked for: a redirect (a public screen opened signed in, a signed-in screen opened
 * signed out) fails here rather than auditing another screen under this route's name. Open a `route.public` screen
 * with `mockApi(page, { signedOut: true })`.
 *
 * Images are judged in the page (`HTMLImageElement.complete`), not by the browser's request events, and this is why
 * the wait is not `waitForLoadState("networkidle")`. On PR #427 `responsive /account` timed out at 300 s in
 * `networkidle`, in Firefox only, twice, while every other screen settled in under 2 s. /account is the first screen
 * in the census that renders an <img> (the provider logo in ModelKeysCard; only /admin/agents and
 * /admin/model-credentials also do), and every other request it makes (chunks, fonts, the mock's /v1 and /auth
 * answers) finishes inside 500 ms. Gecko serves images through its own image cache, separate from the HTTP cache
 * that request interception disables, and a request event it starts there without a finished or failed event keeps
 * `networkidle` from ever firing. Every other request type is still counted from the browser's events, and a screen
 * that does not settle fails after SETTLE_TIMEOUT_MS naming what is still open, not at the test timeout.
 */
export async function openRoute(page: Page, route: SpaRoute, opts: { idle?: boolean } = {}) {
  const settle = opts.idle !== false ? trackRequests(page) : null;
  try {
    await page.goto(`/ui${route.url}`, { waitUntil: "load" });
    if (settle) await settle.quiet(route.path);
  } finally {
    settle?.stop();
  }
  await page.evaluate(async () => {
    await Promise.all(
      Array.from(document.images, (img) =>
        img.complete ? undefined : new Promise((r) => { img.addEventListener("load", r, { once: true }); img.addEventListener("error", r, { once: true }); }),
      ),
    );
    await document.fonts.ready;
    await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
  });
  expect(new URL(page.url()).pathname, `${route.path} redirected instead of rendering`).toBe(`/ui${route.url}`);
}

/** the page's open requests other than images (see openRoute), and a wait for QUIET_MS with none open */
function trackRequests(page: Page) {
  const open = new Set<Request>();
  let last = Date.now();
  const onStart = (r: Request) => {
    if (r.resourceType() === "image") return;
    open.add(r);
    last = Date.now();
  };
  const onEnd = (r: Request) => {
    if (open.delete(r)) last = Date.now();
  };
  page.on("request", onStart);
  page.on("requestfinished", onEnd);
  page.on("requestfailed", onEnd);
  return {
    async quiet(name: string) {
      const deadline = Date.now() + SETTLE_TIMEOUT_MS;
      while (open.size > 0 || Date.now() - last < QUIET_MS) {
        if (Date.now() > deadline) {
          const urls = [...open].map((r) => `${r.method()} ${r.resourceType()} ${r.url()}`).join(", ");
          throw new Error(`${name} did not settle in ${SETTLE_TIMEOUT_MS} ms; still open: ${urls || "(none, but never quiet)"}`);
        }
        await page.waitForTimeout(50);
      }
    },
    stop() {
      page.off("request", onStart);
      page.off("requestfinished", onEnd);
      page.off("requestfailed", onEnd);
    },
  };
}
