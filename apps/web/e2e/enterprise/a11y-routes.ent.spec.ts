/**
 * Bar 1 (ADR-0196): WCAG 2.2 AA over EVERY screen in the SPA route census, in the light and the dark theme.
 *
 * axe-core runs with the WCAG 2.0 / 2.1 / 2.2 A and AA tags, which include colour contrast (1.4.3) and target size
 * (2.5.8, `target-size`). A serious or critical violation fails the run unless the committed baseline
 * (baselines/axe.json) already counts it for that screen and theme; moderate and minor ones are printed, not gated.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { test } from "@playwright/test";
import { mockApi } from "./mock-api";
import { openRoute, ROUTES, switchTheme, THEMES } from "./harness";
import { bump, ratchet, type Findings } from "./ratchet";

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const GATED = new Set(["serious", "critical"]);

test.describe("bar 1: axe on every screen, both themes", () => {
  for (const route of ROUTES) {
    test(`axe ${route.path}`, async ({ page }, testInfo) => {
      await mockApi(page);
      await openRoute(page, route);
      for (const theme of THEMES) {
        await switchTheme(page, theme);
        const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
        const findings: Findings = {};
        const detail: string[] = [];
        for (const v of results.violations) {
          const line = `${v.impact} ${v.id} x${v.nodes.length}: ${v.nodes[0]?.target.join(" ")}`;
          if (v.impact && GATED.has(v.impact)) {
            bump(findings, v.id, v.nodes.length);
            detail.push(line);
          } else {
            testInfo.annotations.push({ type: "axe-ungated", description: `${route.path} ${theme} ${line}` });
          }
        }
        ratchet(testInfo, "axe", `${route.path}|${theme}`, findings, detail);
      }
    });
  }
});
