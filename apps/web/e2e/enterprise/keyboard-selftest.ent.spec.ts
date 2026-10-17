/**
 * The keyboard walk's self-test (ADR-0196): traps planted in a fixture page (test-only HTML, never product code) prove
 * the walk reports each one, in every browser the journeys run in, and a page without a trap reports neither. The
 * journeys themselves (keyboard.ent.spec.ts) prove the other side on real screens: their committed baselines hold no
 * focus-stuck or focus-trapped, so a false positive there fails the run.
 */
import { expect, test, type Page } from "@playwright/test";
import { auditWalk, keys } from "./keyboard-walk";
import type { Findings } from "./ratchet";

const CONTROLS = `<a href="#a">first link</a> <input aria-label="name" /> <button type="button">plain</button>`;
const AFTER = `<button type="button">after one</button> <a href="#b">after two</a>`;

/** a fixture page: controls, then `middle`, then more controls */
async function fixture(page: Page, middle: string) {
  await page.setContent(`<!doctype html><html><head><style>:focus { outline: 2px solid black; }</style></head><body><main>${CONTROLS} ${middle} ${AFTER}</main></body></html>`);
}

async function walk(page: Page, browserName: string) {
  const f: Findings = {};
  const detail: string[] = [];
  await auditWalk(page, keys(browserName).tab, f, detail);
  return { f, detail };
}

test.describe("keyboard walk self-test", () => {
  test("a page without a trap reports neither finding", async ({ page, browserName }) => {
    await fixture(page, "");
    const { f } = await walk(page, browserName);
    expect(f["focus-stuck"] ?? 0).toBe(0);
    expect(f["focus-trapped"] ?? 0).toBe(0);
    expect(f["focus-lost"] ?? 0).toBe(0);
  });

  test("a control that swallows Tab is focus-stuck", async ({ page, browserName }) => {
    await fixture(page, `<button type="button" id="trap">trap</button>`);
    await page.evaluate(() => {
      document.getElementById("trap")!.addEventListener("keydown", (e) => {
        if (e.key === "Tab") e.preventDefault();
      });
    });
    const { f, detail } = await walk(page, browserName);
    expect(f["focus-stuck"], detail.join("\n")).toBe(1);
    expect(f["focus-trapped"] ?? 0).toBe(0);
  });

  test("a control that swallows Tab and stops its propagation is still focus-stuck", async ({ page, browserName }) => {
    await fixture(page, `<button type="button" id="trap">trap</button>`);
    await page.evaluate(() => {
      document.getElementById("trap")!.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          e.stopPropagation();
        }
      });
    });
    const { f, detail } = await walk(page, browserName);
    expect(f["focus-stuck"], detail.join("\n")).toBe(1);
  });

  test("two controls that hand Tab back and forth are focus-trapped", async ({ page, browserName }) => {
    await fixture(page, `<button type="button" id="ta">trap A</button> <button type="button" id="tb">trap B</button>`);
    await page.evaluate(() => {
      const a = document.getElementById("ta")!;
      const b = document.getElementById("tb")!;
      b.addEventListener("keydown", (e) => {
        if (e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          a.focus();
        }
      });
    });
    const { f, detail } = await walk(page, browserName);
    expect(f["focus-trapped"], detail.join("\n")).toBe(1);
    expect(f["focus-stuck"] ?? 0).toBe(0);
  });
});
