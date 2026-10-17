/**
 * Bar 2 (ADR-0196): every screen at desktop 1280 / 1440 / 1920 and tablet 768 / 1024, in Chromium, Firefox and
 * WebKit (one project each; Firefox and WebKit are installed by CI only).
 *
 * At each width the screen must not scroll sideways (the document is no wider than the viewport: a table or a
 * code block scrolls inside its own container instead), it must keep a visible <main>, and the page must not
 * throw. One load per screen; the widths are applied by resizing, as a person resizing the window does.
 */
import { test } from "@playwright/test";
import { mockApi } from "./mock-api";
import { openRoute, ROUTES, VIEWPORTS } from "./harness";
import { bump, ratchet, type Findings } from "./ratchet";

test.describe("bar 2: every screen at every viewport", () => {
  for (const route of ROUTES) {
    test(`responsive ${route.path}`, async ({ page, browserName }, testInfo) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await mockApi(page);
      await openRoute(page, route);
      const findings: Findings = {};
      const detail: string[] = [];
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const m = await page.evaluate(() => {
          const doc = document.documentElement;
          const main = document.querySelector("main");
          const box = main?.getBoundingClientRect();
          return {
            overflow: doc.scrollWidth - doc.clientWidth,
            main: Boolean(main && box && box.width > 0 && box.height > 0),
          };
        });
        if (m.overflow > 1) {
          bump(findings, `horizontal-overflow@${vp.width}`);
          detail.push(`${vp.name}: the page is ${m.overflow}px wider than the viewport`);
        }
        if (!m.main) bump(findings, `no-visible-main@${vp.width}`);
      }
      if (errors.length) {
        bump(findings, "page-error", errors.length);
        detail.push(...errors.map((e) => `page error: ${e.slice(0, 200)}`));
      }
      ratchet(testInfo, "responsive", `${browserName}|${route.path}`, findings, detail);
    });
  }
});
