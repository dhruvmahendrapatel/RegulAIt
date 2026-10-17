/**
 * The keyboard walk (ADR-0196), shared by the keyboard journeys (keyboard.ent.spec.ts) and the walk's own self-test
 * (keyboard-selftest.ent.spec.ts), which plants traps in a fixture page to prove each finding fires.
 *
 * A Tab that leaves focus where it was means one of two things: the page swallowed it (a trap on that control), or
 * Tab left the page for the browser's own UI (Chromium keeps the document's active element then). watchTabs() tells
 * them apart: it keeps the last Tab keydown event, caught on `window` in the capture phase so a handler that stops
 * propagation cannot hide it, and after the key is pressed reads its `defaultPrevented`.
 */
import type { Page } from "@playwright/test";
import { bump, type Findings } from "./ratchet";

export const WALK = 80;

/** the keys that move focus; WebKit moves through links only with Option+Tab (Safari's default) */
export function keys(browserName: string) {
  return browserName === "webkit" ? { tab: "Alt+Tab", back: "Alt+Shift+Tab" } : { tab: "Tab", back: "Shift+Tab" };
}

export type Focused = { id: string; tag: string; name: string; visible: boolean; body: boolean; tabindex: number };

/** what has focus now, and whether it shows a focus indicator */
export const focused = (page: Page) =>
  page.evaluate((): Focused => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body || el === document.documentElement) {
      return { id: "body", tag: "body", name: "", visible: false, body: true, tabindex: -1 };
    }
    if (!el.dataset.kbId) el.dataset.kbId = String(Math.random()).slice(2);
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
    const shadow = s.boxShadow !== "none" && s.boxShadow !== "";
    return {
      id: el.dataset.kbId,
      tag: el.tagName.toLowerCase(),
      name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 60),
      visible: outline || shadow,
      body: false,
      tabindex: el.tabIndex,
    };
  });

/**
 * Put the sequential-focus starting point at the top of the document. `body.focus()` does not do this in Firefox
 * (it keeps the last focused element as the starting point, so Tab runs on into the browser chrome), so focus a
 * non-tabbable marker placed first in <body>: the next Tab reaches the page's first control in every engine.
 */
export async function focusStartOfPage(page: Page) {
  await page.evaluate(() => {
    let start = document.querySelector<HTMLElement>("[data-kb-start]");
    if (!start) {
      start = document.createElement("span");
      start.dataset.kbStart = "";
      start.tabIndex = -1;
      document.body.prepend(start);
    }
    start.focus();
  });
}

/** start keeping the last Tab keydown (once per document) */
async function watchTabs(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __kbWatch?: boolean; __kbLastTab?: KeyboardEvent | null };
    w.__kbLastTab = null;
    if (w.__kbWatch) return;
    w.__kbWatch = true;
    window.addEventListener("keydown", (e) => { if (e.key === "Tab") w.__kbLastTab = e; }, true);
  });
}

/** whether the page cancelled the Tab just pressed; clears it for the next one */
async function tabSwallowed(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { __kbLastTab?: KeyboardEvent | null };
    const prevented = Boolean(w.__kbLastTab?.defaultPrevented);
    w.__kbLastTab = null;
    return prevented;
  });
}

/** Tab through the page: indicator on every stop, no lost, stuck or cycling focus, no positive tabindex */
export async function auditWalk(page: Page, tab: string, f: Findings, detail: string[]) {
  await focusStartOfPage(page);
  await watchTabs(page);
  const seen = new Set<string>();
  let first = "";
  let last = "";
  for (let i = 0; i < WALK; i += 1) {
    await page.keyboard.press(tab);
    const swallowed = await tabSwallowed(page);
    const now = await focused(page);
    if (now.body) {
      // reaching <body> after the last control is the normal wrap-around; before any control it is not
      if (seen.size === 0) bump(f, "focus-lost");
      break;
    }
    if (now.id === last) {
      // focus did not move. If the page swallowed the Tab (preventDefault) it is a trap on one control; if not, Tab
      // left the page for the browser's own UI and the document kept its active element (Chromium): the walk is done
      if (swallowed) {
        bump(f, "focus-stuck");
        detail.push(`focus stuck on <${now.tag}> "${now.name}": the page swallows Tab there`);
      }
      break;
    }
    last = now.id;
    if (seen.has(now.id)) {
      // back at the first stop is the normal wrap-around; back at any other stop is a cycle
      if (now.id !== first) {
        bump(f, "focus-trapped");
        detail.push(`focus cycles back to <${now.tag}> "${now.name}" without leaving the page`);
      }
      break;
    }
    if (!first) first = now.id;
    seen.add(now.id);
    if (!now.visible) {
      bump(f, "focus-not-visible");
      detail.push(`no focus indicator on <${now.tag}> "${now.name}"`);
    }
    if (now.tabindex > 0) bump(f, "positive-tabindex");
  }
}
