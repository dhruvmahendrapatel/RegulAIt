/**
 * Bar 3, the human half (ADR-0196): the screenshot pack, every screen x viewport x theme, for the owner to scan.
 *
 * Written to SCREENSHOT_PACK_DIR (default apps/web/test-results/screenshot-pack) as
 * `<route-slug>/<viewport>-<theme>.jpg`, with `manifest.json` beside them; `node scripts/ui-screenshot-index.mjs`
 * turns that into index.html. CI uploads the folder as an artifact (.github/workflows/ui-enterprise.yml). Nothing
 * here asserts: the automated checks live in the other specs. Run it with `--project=screenshots`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@playwright/test";
import { mockApi } from "./mock-api";
import { openRoute, presetTheme, routeSlug, ROUTES, switchTheme, THEMES, VIEWPORTS } from "./harness";

const OUT = process.env.SCREENSHOT_PACK_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "test-results", "screenshot-pack");

test.describe("screenshot pack", () => {
  for (const route of ROUTES) {
    test(`shots ${route.path}`, async ({ page }) => {
      const slug = routeSlug(route.path);
      mkdirSync(path.join(OUT, slug), { recursive: true });
      await presetTheme(page, "light");
      await mockApi(page, { signedOut: route.public });
      await openRoute(page, route);
      const shots: string[] = [];
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        for (const theme of THEMES) {
          await switchTheme(page, theme);
          const file = `${slug}/${vp.name}-${theme}.jpg`;
          await page.screenshot({ path: path.join(OUT, file), type: "jpeg", quality: 70, animations: "disabled" });
          shots.push(file);
        }
      }
      writeFileSync(path.join(OUT, slug, "manifest.json"), JSON.stringify({ route: route.path, url: route.url, shots }, null, 2));
    });
  }
});
