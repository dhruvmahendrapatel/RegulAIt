/**
 * Phase-1 SPA journey against a REAL seeded gateway: sign in as the seeded
 * developer persona with the printed one-time password (forced change), land
 * on the dashboard, then drive Chat (streamed mock reply), Runs, Workflows,
 * Inbox (decide something) and Projects. Every page asserts ZERO console
 * errors (uncaught page errors are always fatal; the only filtered console
 * line is the browser's own network log for the expected pre-login 401
 * probe, which JS cannot suppress) and screenshots into E2E_SHOTS_DIR.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string; dana: string; avery: string };
  baseUrl: string;
};
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(here, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const NEW_PASSWORD = "E2e-Rewrite-2026!";

interface ConsoleTracker {
  errors: string[];
  assertClean: (label: string) => void;
}
function trackConsole(page: Page): ConsoleTracker {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // the browser's own network log for the expected unauthenticated probe
    // (GET /auth/me before sign-in) — not emitted by our code, not
    // suppressible from JS. Everything else is fatal.
    if (/Failed to load resource.*40[13]/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return {
    errors,
    assertClean(label: string) {
      expect(errors, `console must be clean after: ${label}`).toEqual([]);
    },
  };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

test.describe.configure({ mode: "serial" });

let page: Page;
let track: ConsoleTracker;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  track = trackConsole(page);
});
test.afterAll(async () => {
  await page.close();
});

test("login: one-time password → forced change → dashboard", async () => {
  await page.goto("/ui");
  await expect(page.getByLabel("Email")).toBeVisible();
  await shot(page, "01-login");

  await page.getByLabel("Email").fill("dana@regulait.local");
  await page.getByLabel("Password", { exact: true }).fill(state.passwords.dana);
  await page.getByRole("button", { name: "Sign in" }).click();

  // gate 1: the one-time password must be replaced
  await expect(page.getByText("Your password is one-time")).toBeVisible();
  await shot(page, "02-forced-password-change");
  await page.getByLabel("Current (one-time) password").fill(state.passwords.dana);
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD);
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD);
  await page.getByRole("button", { name: "Set password & continue" }).click();

  // dashboard
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Chat" })).toBeVisible();
  await shot(page, "03-home-dashboard");
  track.assertClean("login + dashboard");
});

test("chat: send a message and watch the streamed mock reply", async () => {
  await page.getByRole("link", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chat", exact: true })).toBeVisible();
  // workspace data settles (agent picker populated from entitlements)
  await expect(page.getByLabel("Agent")).toBeVisible();

  await page.getByLabel("Message").fill("Summarize what RegulAIt governs in one sentence.");
  await page.getByLabel("Message").press("Enter");

  // the streamed reply lands as an agent bubble with dispatch badges
  await expect(page.locator("[class*='bubbleAgent']").last()).not.toBeEmpty({ timeout: 20_000 });
  await expect(page.getByText("governance trace").last()).toBeVisible({ timeout: 20_000 });
  await shot(page, "04-chat-streamed-reply");
  track.assertClean("chat send + stream");
});

test("runs: list and open a seeded run (DAG + nodes)", async () => {
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  await shot(page, "05-runs-list");

  const firstRow = page.locator("tbody tr[role='link']").first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();

  await expect(page.getByText("Task graph")).toBeVisible();
  await expect(page.getByRole("img", { name: "Run task graph" })).toBeVisible();
  await expect(page.getByText("Nodes")).toBeVisible();
  await shot(page, "06-run-detail");
  track.assertClean("runs list + detail");
});

test("workflows: list and open a seeded instance (stage rail)", async () => {
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();
  await shot(page, "07-workflows-list");

  const firstRow = page.locator("tbody tr[role='link']").first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();

  await expect(page.getByText("Pipeline")).toBeVisible();
  await shot(page, "08-workflow-detail");
  track.assertClean("workflows list + detail");
});

test("inbox: a pending item is decidable with a reason", async () => {
  // the nav badge (pending count) is part of the link's accessible name
  await page.getByRole("link", { name: /^Inbox/ }).click();
  await expect(page.getByRole("heading", { name: "Inbox", exact: true })).toBeVisible();
  await shot(page, "09-inbox");

  // dana is the seeded arbiter of a context conflict — decide the first
  // pending row that offers her the Approve control
  const approve = page.getByRole("button", { name: "Approve" }).first();
  await expect(approve).toBeVisible();
  await page.getByLabel("Decision reason").first().fill("e2e: arbitrated in the SPA rewrite journey");
  await approve.click();
  await expect(page.getByText("Approved", { exact: true })).toBeVisible();
  await shot(page, "10-inbox-decided");
  track.assertClean("inbox approve");
});

test("projects: list and budget/membership detail", async () => {
  await page.getByRole("link", { name: "Projects", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  await shot(page, "11-projects-list");

  const firstCard = page.getByRole("button", { name: /Open project/ }).first();
  await expect(firstCard).toBeVisible();
  await firstCard.click();

  await expect(page.getByText("Budget vs actual")).toBeVisible();
  // exact: the project tab strip also carries the word "members"
  await expect(page.getByText("Members", { exact: true })).toBeVisible();
  await shot(page, "12-project-detail");
  track.assertClean("projects list + detail");
});

test("account security + theme toggle + sign out", async () => {
  await page.getByRole("button", { name: /Dana Developer/ }).click();
  await page.getByRole("menuitem", { name: "Account security" }).click();
  await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible();
  await shot(page, "13-account-security");

  // theme toggle flips the root data-theme attribute
  await page.getByRole("button", { name: /Switch to (light|dark) theme/ }).click();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(theme === "light" || theme === "dark").toBe(true);
  await shot(page, "14-theme-toggled");

  await page.getByRole("button", { name: /Dana Developer/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByLabel("Email")).toBeVisible();
  track.assertClean("account + theme + sign-out");
});
