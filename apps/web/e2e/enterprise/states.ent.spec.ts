/**
 * Bar 3, automated half (ADR-0196): consistent loading and error states on every screen, and one table density.
 *
 *   loading  every call is held open: within LOADING_MS the screen must say so to assistive technology, with
 *            role="status" (the kit's Skeleton / SkeletonBlock) or aria-busy="true", rather than show a blank or
 *            a premature "nothing here";
 *   error    every call answers 503: once settled, the screen must show an alert (role="alert", the kit's
 *            ErrorState / RecordError), and it must not throw;
 *   density  every table on the error-state screen uses the kit's density: header and cell padding and the
 *            table's font size equal those of the kit's own Table (src/ui/kit.module.css), measured off a probe
 *            table styled the same way, so a token change moves the reference with it.
 *
 * Empty states need per-page data (an empty list differs from a failed read), so they join this spec with the
 * feature-baseline fixtures; see the ADR.
 */
import { test, type Page } from "@playwright/test";
import { mockApi } from "./mock-api";
import { openRoute, ROUTES } from "./harness";
import { bump, ratchet, type Findings } from "./ratchet";

const LOADING_MS = 3_000;

/** the kit table's computed density, taken from a probe built with the same rules as kit.module.css `.table` */
async function tableDensity(page: Page) {
  return page.evaluate(() => {
    const sig = (cell: Element) => {
      const s = getComputedStyle(cell);
      return `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft} / ${s.fontSize}`;
    };
    const tables = Array.from(document.querySelectorAll("main table"));
    return tables.map((t) => ({
      th: Array.from(t.querySelectorAll("thead th")).map(sig),
      td: Array.from(t.querySelectorAll("tbody td")).slice(0, 20).map(sig),
    }));
  });
}

async function kitReference(page: Page) {
  return page.evaluate(() => {
    const probe = document.createElement("table");
    probe.style.cssText = "position:absolute;visibility:hidden;font-size:var(--text-sm)";
    probe.innerHTML = "<thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody>";
    const th = probe.querySelector("th") as HTMLElement;
    const td = probe.querySelector("td") as HTMLElement;
    th.style.cssText = "padding:12px 16px;font-size:var(--text-sm)";
    td.style.cssText = "padding:12px 16px";
    document.body.append(probe);
    const sig = (cell: Element) => {
      const s = getComputedStyle(cell);
      return `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft} / ${s.fontSize}`;
    };
    const out = { th: sig(th), td: sig(td) };
    probe.remove();
    return out;
  });
}

test.describe("bar 3: loading and error states, table density", () => {
  for (const route of ROUTES) {
    test(`states ${route.path}`, async ({ page }, testInfo) => {
      test.skip(route.public, "public screens: covered by the sign-in journey");
      const findings: Findings = {};
      const detail: string[] = [];

      await mockApi(page, { mode: "loading", signedOut: route.public });
      await openRoute(page, route, { idle: false });
      const announced = await page
        .locator('main [role="status"], main [aria-busy="true"]')
        .first()
        .waitFor({ state: "attached", timeout: LOADING_MS })
        .then(() => true, () => false);
      if (!announced) bump(findings, "loading-not-announced");
      await page.unrouteAll({ behavior: "ignoreErrors" });

      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await mockApi(page, { mode: "error", signedOut: route.public });
      await openRoute(page, route);
      const alerts = await page.locator('main [role="alert"]').count();
      if (alerts === 0) bump(findings, "error-not-shown");
      if (errors.length) {
        bump(findings, "page-error", errors.length);
        detail.push(...errors.map((e) => `page error: ${e.slice(0, 200)}`));
      }
      ratchet(testInfo, "states", route.path, findings, detail);

      const kit = await kitReference(page);
      const density: Findings = {};
      for (const t of await tableDensity(page)) {
        for (const th of t.th) if (th !== kit.th) bump(density, `th ${th}`);
        for (const td of t.td) if (td !== kit.td) bump(density, `td ${td}`);
      }
      ratchet(testInfo, "density", route.path, density, [`kit: th ${kit.th}; td ${kit.td}`]);
    });
  }
});
