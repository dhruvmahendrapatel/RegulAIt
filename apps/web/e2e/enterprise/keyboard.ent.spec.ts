/**
 * Bar 1, keyboard half (ADR-0196): the primary journeys walked with the keyboard alone, in Chromium, Firefox and
 * WebKit. Each journey reports these findings (counts) to the ratchet, keyed by browser and journey:
 *
 *   skip-link-*        the first Tab reaches a visible "Skip to main content" that moves focus into <main>
 *   focus-not-visible  a control reached by Tab draws no focus indicator (outline or box-shadow)
 *   focus-lost         Tab lands on <body> part-way through the page
 *   focus-stuck        three Tabs in a row leave focus on the same element (a trap outside a dialog)
 *   focus-trapped      Tab cycles through several controls outside a dialog: the walk comes back to an earlier
 *                      control, not the page's first stop (a real wrap-around) and not the control it is on
 *   positive-tabindex  a tabindex above 0 reorders the page
 *   order-*            a journey's controls are reached out of reading order
 *   dialog-*           a dialog opened from the keyboard does not take focus, lets Tab escape, ignores Escape,
 *                      or does not hand focus back to the control that opened it
 *
 * WebKit moves through links only with Option+Tab (Safari's default), so the walk presses Alt+Tab there.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mockApi } from "./mock-api";
import { requireStepUpOn } from "../step-up-harness";
import { bump, ratchet, type Findings } from "./ratchet";

const WALK = 80;
const ISO = "2026-10-07T10:00:00.000Z";

function keys(browserName: string) {
  return browserName === "webkit" ? { tab: "Alt+Tab", back: "Alt+Shift+Tab" } : { tab: "Tab", back: "Shift+Tab" };
}

type Focused = { id: string; tag: string; name: string; visible: boolean; body: boolean; tabindex: number };

/** what has focus now, and whether it shows a focus indicator */
const focused = (page: Page) =>
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
async function focusStartOfPage(page: Page) {
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

/** the skip link: first Tab, visible, and Enter moves focus into <main> */
async function auditSkipLink(page: Page, tab: string, f: Findings) {
  await focusStartOfPage(page);
  await page.keyboard.press(tab);
  const first = await focused(page);
  if (!/skip to main content/i.test(first.name)) {
    bump(f, "skip-link-not-first");
    return;
  }
  const box = await page.evaluate(() => (document.activeElement as HTMLElement).getBoundingClientRect().width);
  if (box < 2) bump(f, "skip-link-not-visible");
  await page.keyboard.press("Enter");
  const inMain = await page.evaluate(() => Boolean(document.querySelector("main")?.contains(document.activeElement)));
  if (!inMain) bump(f, "skip-link-target");
}

/** Tab through the page: indicator on every stop, no lost or stuck focus, no positive tabindex */
async function auditWalk(page: Page, tab: string, f: Findings, detail: string[]) {
  await focusStartOfPage(page);
  const seen = new Set<string>();
  let first = "";
  let last = "";
  let repeats = 0;
  for (let i = 0; i < WALK; i += 1) {
    await page.keyboard.press(tab);
    const now = await focused(page);
    if (now.body) {
      // reaching <body> after the last control is the normal wrap-around; before any control it is not
      if (seen.size === 0) bump(f, "focus-lost");
      break;
    }
    repeats = now.id === last ? repeats + 1 : 0;
    if (repeats >= 2) {
      bump(f, "focus-stuck");
      detail.push(`focus stuck on <${now.tag}> "${now.name}"`);
      break;
    }
    const previous = last;
    last = now.id;
    if (seen.has(now.id)) {
      // back at the first stop is the normal wrap-around, and staying on the last stop is Tab leaving the page for
      // the browser's own UI (the document keeps its active element); back at any other stop is a cycle
      if (now.id !== first && now.id !== previous) {
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

/** Tab to `target` from the top of the page (or, with `fromStart: false`, from the current focus); false when it is not in the tab order */
async function tabTo(page: Page, tab: string, target: Locator, opts: { fromStart?: boolean } = {}) {
  await expect(target).toBeVisible();
  if (opts.fromStart !== false) await focusStartOfPage(page);
  for (let i = 0; i < 200; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return true;
    await page.keyboard.press(tab);
  }
  return false;
}

/** the order in which `targets` are first reached by Tab, as their indexes */
async function reachOrder(page: Page, tab: string, targets: Locator[]) {
  await focusStartOfPage(page);
  const order: number[] = [];
  for (let i = 0; i < 200 && order.length < targets.length; i += 1) {
    await page.keyboard.press(tab);
    for (const [n, t] of targets.entries()) {
      if (!order.includes(n) && (await t.evaluate((el) => el === document.activeElement).catch(() => false))) order.push(n);
    }
  }
  return order;
}

/** open a dialog from the keyboard, then: focus inside, Tab and Shift+Tab stay inside, Escape closes, focus returns */
async function auditDialog(page: Page, k: { tab: string; back: string }, trigger: Locator, dialog: Locator, f: Findings) {
  if (!(await tabTo(page, k.tab, trigger))) {
    bump(f, "dialog-trigger-unreachable");
    return;
  }
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  const inside = () => dialog.evaluate((d) => d.contains(document.activeElement)).catch(() => false);
  if (!(await inside())) bump(f, "dialog-focus-not-moved");
  const controls = await dialog
    .locator("button, input, select, textarea, a[href], [tabindex]")
    .evaluateAll((els) => els.filter((e) => !e.matches(":disabled") && (e as HTMLElement).tabIndex >= 0 && e.getClientRects().length > 0).length);
  for (const key of [k.tab, k.back]) {
    for (let i = 0; i < controls + 2; i += 1) {
      await page.keyboard.press(key);
      if (!(await inside())) {
        bump(f, "dialog-focus-escapes");
        break;
      }
    }
  }
  await page.keyboard.press("Escape");
  const closed = await dialog.waitFor({ state: "detached", timeout: 2_000 }).then(() => true, () => false);
  if (!closed) {
    bump(f, "dialog-escape-does-not-close");
    return;
  }
  if (!(await trigger.evaluate((el) => el === document.activeElement).catch(() => false))) bump(f, "dialog-focus-not-restored");
}

test.describe("bar 1: keyboard journeys", () => {
  test("sign-in", async ({ page, browserName }, testInfo) => {
    const k = keys(browserName);
    const f: Findings = {};
    const detail: string[] = [];
    await mockApi(page, { signedOut: true });
    await page.goto("/ui/login");
    const identifier = page.getByLabel(/email or username/i).first();
    await expect(identifier).toBeVisible();
    await auditWalk(page, k.tab, f, detail);
    const order = await reachOrder(page, k.tab, [identifier, page.getByLabel(/^password$/i).first(), page.getByRole("button", { name: /^sign in$/i }).first()]);
    if (order.join() !== "0,1,2") bump(f, "order-sign-in-form");
    ratchet(testInfo, "keyboard", `${browserName}|sign-in`, f, detail);
  });

  test("intake", async ({ page, browserName }, testInfo) => {
    const k = keys(browserName);
    const f: Findings = {};
    const detail: string[] = [];
    await mockApi(page, {
      extra: {
        "GET /v1/agents": { agents: [{ id: "22222222-2222-4222-8222-222222222222", name: "Credit assistant", provider: "mock", model: "mock-balanced", enabled: true, modes: ["chat"] }] },
        "GET /v1/vendors": { vendors: [] },
        "GET /v1/approvals": { approvals: [] },
      },
    });
    await page.goto("/ui/admin/governance/intake");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await auditSkipLink(page, k.tab, f);
    await auditWalk(page, k.tab, f, detail);
    ratchet(testInfo, "keyboard", `${browserName}|intake`, f, detail);
  });

  test("approvals", async ({ page, browserName }, testInfo) => {
    const k = keys(browserName);
    const f: Findings = {};
    const detail: string[] = [];
    await mockApi(page, {
      extra: {
        "GET /v1/approvals": {
          approvals: [{
            id: "a-tool-1", status: "pending", objectType: "mcp_tool", stageId: null, requestedAt: ISO, userId: "u-dana",
            approverUserId: null, toolName: "write_file", serverId: "s-repo", serverName: "repo", requestedByName: "Dana Developer",
            argumentsDigest: "a".repeat(64), argumentsPreview: { path: "README.md" }, argumentsPreviewKind: "arguments_v1",
            approvalScope: "action", contextDigest: "b".repeat(64), expiresAt: "2099-01-01T00:00:00.000Z",
            boundTarget: { host: "repo.example.test", allowPrivateRanges: false, admissionManifestDigest: null },
            quorum: 1, signatureMode: "none", approvalsCount: 0, myDecision: null, decisions: [],
          }],
        },
        "GET /v1/approvals/views": { views: [] },
      },
    });
    await page.goto("/ui/admin/approvals");
    const trigger = page.getByRole("button", { name: "Review action write_file" }).first();
    await expect(trigger).toBeVisible();
    await auditSkipLink(page, k.tab, f);
    await auditWalk(page, k.tab, f, detail);
    await auditDialog(page, k, trigger, page.getByRole("dialog", { name: "Review MCP action" }), f);
    ratchet(testInfo, "keyboard", `${browserName}|approvals`, f, detail);
  });

  test("settings step-up", async ({ page, browserName }, testInfo) => {
    const k = keys(browserName);
    const f: Findings = {};
    const detail: string[] = [];
    await mockApi(page, {
      extra: {
        "GET /v1/execution": {
          mode: "halted", meaning: "Every governed call is refused.", reason: "incident drill", setAt: ISO, setByUserId: "u-admin",
          haltedAgents: [], haltedTools: [], summary: "Execution is halted", note: "", scheduledSweepsNote: "",
        },
        "GET /v1/agents": { agents: [] },
      },
    });
    await requireStepUpOn(page, { method: "PUT", path: "/v1/execution/mode", kind: "settings_relax", facts: () => ({ values: { executionMode: "normal" } }) });
    await page.goto("/ui/admin/execution");
    const resume = page.getByRole("button", { name: "Resume" }).first();
    await expect(resume).toBeVisible();
    await auditSkipLink(page, k.tab, f);
    await auditWalk(page, k.tab, f, detail);
    // the confirm dialog: opened, trapped and closed from the keyboard
    const confirm = page.getByRole("dialog", { name: "Resume normal execution" });
    await auditDialog(page, k, resume, confirm, f);
    // then through to the step-up dialog, which is audited the same way from its own trigger
    if (await tabTo(page, k.tab, resume)) {
      await page.keyboard.press("Enter");
      await expect(confirm).toBeVisible();
      // the Reason field and the submit button reached by Tab from where the dialog put focus, not by .focus()
      if (!(await tabTo(page, k.tab, confirm.getByLabel("Reason"), { fromStart: false }))) bump(f, "dialog-control-unreachable");
      await page.keyboard.type("incident closed, verified safe to resume");
      const submit = confirm.getByRole("button", { name: "Resume" });
      if (!(await tabTo(page, k.tab, submit, { fromStart: false }))) bump(f, "dialog-control-unreachable");
      await page.keyboard.press("Enter");
      const stepUp = page.getByRole("dialog", { name: "Confirm it's you" });
      const opened = await stepUp.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
      if (!opened) bump(f, "step-up-not-opened");
      else {
        if (!(await stepUp.evaluate((d) => d.contains(document.activeElement)))) bump(f, "dialog-focus-not-moved");
        await page.keyboard.press("Escape");
        const closed = await stepUp.waitFor({ state: "detached", timeout: 2_000 }).then(() => true, () => false);
        if (!closed) bump(f, "dialog-escape-does-not-close");
        else if (await page.evaluate(() => document.activeElement === document.body)) bump(f, "dialog-focus-not-restored");
      }
    }
    ratchet(testInfo, "keyboard", `${browserName}|settings-step-up`, f, detail);
  });
});
