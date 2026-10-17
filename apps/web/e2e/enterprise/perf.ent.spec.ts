/**
 * Bar 4 (ADR-0196): Largest Contentful Paint and Interaction to Next Paint on every screen, measured in Chromium
 * with the web-vitals library (Apache-2.0, pinned; injected into the page by the test, never bundled).
 *
 * Budgets are web-vitals' own "good" thresholds: LCP at most 2500 ms, INP at most 200 ms. A screen over a budget is
 * a finding for the ratchet; the measured values of every screen are written to
 * test-results/enterprise-perf.<project>.json so a CI run shows the numbers, not only the verdict.
 *
 * The interaction is a click on the screen's first heading, which runs the app's root event handlers without
 * changing the page. An interaction below web-vitals' 40 ms reporting threshold reports no INP; that counts as 0.
 * The build is the production one (`vite preview`); the API is the harness mock, so the numbers are the client's
 * own cost, not the network's.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "@playwright/test";
import { mockApi } from "./mock-api";
import { openRoute, ROUTES } from "./harness";
import { bump, FINDINGS_DIR, ratchet, type Findings } from "./ratchet";

export const LCP_BUDGET_MS = 2500;
export const INP_BUDGET_MS = 200;

const require = createRequire(import.meta.url);
// the package exports only its modules (not dist/*.iife.js), so the IIFE build is read beside the resolved entry
const WEB_VITALS = readFileSync(path.join(path.dirname(require.resolve("web-vitals")), "web-vitals.iife.js"), "utf8");
const COLLECT = `${WEB_VITALS}
;(function () {
  window.__vitals = { lcp: 0, inp: 0 };
  webVitals.onLCP(function (m) { window.__vitals.lcp = Math.max(window.__vitals.lcp, m.value); }, { reportAllChanges: true });
  webVitals.onINP(function (m) { window.__vitals.inp = Math.max(window.__vitals.inp, m.value); }, { reportAllChanges: true });
})();`;

test.describe("bar 4: LCP and INP per screen", () => {
  for (const route of ROUTES) {
    test(`perf ${route.path}`, async ({ page }, testInfo) => {
      await page.addInitScript({ content: COLLECT });
      await mockApi(page);
      await openRoute(page, route);
      const heading = page.locator("main h1, h1").first();
      if (await heading.count()) await heading.click({ trial: false }).catch(() => undefined);
      else await page.mouse.click(5, 5);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      // LCP is final at the first input; a hidden page makes web-vitals flush INP as well
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const v = await page.evaluate(() => (window as unknown as { __vitals: { lcp: number; inp: number } }).__vitals);
      const findings: Findings = {};
      if (v.lcp > LCP_BUDGET_MS) bump(findings, "lcp-over-budget");
      if (v.inp > INP_BUDGET_MS) bump(findings, "inp-over-budget");
      mkdirSync(FINDINGS_DIR, { recursive: true });
      appendFileSync(path.join(FINDINGS_DIR, "..", `enterprise-perf.${testInfo.project.name}.jsonl`), `${JSON.stringify({ route: route.path, lcpMs: Math.round(v.lcp), inpMs: Math.round(v.inp) })}\n`);
      ratchet(testInfo, "perf", route.path, findings, [`LCP ${Math.round(v.lcp)} ms (budget ${LCP_BUDGET_MS}), INP ${Math.round(v.inp)} ms (budget ${INP_BUDGET_MS})`]);
    });
  }
});
