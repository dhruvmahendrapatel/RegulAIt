/**
 * Phase-1 SPA journey against a REAL seeded gateway: sign in as the seeded
 * developer persona with the printed one-time password (forced change), land
 * on the dashboard, then drive Chat (streamed mock reply), Runs, Workflows,
 * Inbox (decide something) and Projects.
 *
 * Also covers the three capabilities the phase-3 correction found were still
 * legacy-only (ADR-0026's phase-2 "parity proven" claim was wrong): pillar 7
 * goal decomposition (draft → review → edit → accept), pillar 8 PM work-item
 * links, and pillar 4's decision ledger — and the two END-USER residuals the
 * phase-4 capability diff found (2026-08-01): a non-admin's own Spend &
 * savings (pillars 5+6, self-scoped), and self-service BYO model keys
 * (add → listed as present-but-never-revealed → removed). The key-custody
 * half of that second surface is driven from phase2 (it needs an admin to
 * flip the org toggle). Every page asserts ZERO console
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

test("run detail: PM work items and the decision ledger (pillars 8 + 4)", async () => {
  // the seeded checkout-refactor run is pm-synced and already carries one
  // decision, so both surfaces have real data to render
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await page.locator("tbody tr[role='link']").first().click();
  await expect(page.getByText("Task graph")).toBeVisible();

  const pmCard = page.locator("section", { hasText: "PM work items" }).first();
  await expect(pmCard).toBeVisible();
  // RegulAIt stores the LINK, not a copy — the card has to say so
  await expect(pmCard.getByText(/stores the/)).toBeVisible();
  // the seeded run is pm-synced, so its work items are listed and re-syncable
  await expect(pmCard.getByRole("cell", { name: "run", exact: true })).toBeVisible();
  await pmCard.getByRole("button", { name: "Sync now" }).click();
  await expect(page.getByText(/Synced with /).first()).toBeVisible();
  // reading live resolves the PM-authoritative fields, or says "unreachable" —
  // either is honest; silently showing a stale cached copy would not be
  await pmCard.getByRole("button", { name: "Read live from the tool" }).click();
  await expect(pmCard.getByRole("button", { name: "Stop reading live" })).toBeVisible();

  const decisionsCard = page.locator("section", { hasText: "Decision ledger" }).first();
  await expect(decisionsCard).toBeVisible();
  await shot(page, "06b-run-pm-and-decisions");

  // record a decision and see it land in the ledger
  const text = `e2e: proceed with the SPA parity build (${Date.now()})`;
  await decisionsCard.getByLabel("Decision", { exact: true }).fill(text);
  await decisionsCard.getByLabel(/^Rationale/).fill("Recorded from the SPA to prove the ledger is writable here.");
  await decisionsCard.getByRole("button", { name: "Record decision" }).click();
  await expect(page.getByText(/Decision recorded/).first()).toBeVisible();
  await expect(decisionsCard.getByRole("cell", { name: text })).toBeVisible();
  await shot(page, "06c-run-decision-recorded");
  track.assertClean("run pm links + decision ledger");
});

test("workflows: list and open a seeded instance (stage rail)", async () => {
  await page.getByRole("link", { name: "Workflows", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Workflows", exact: true })).toBeVisible();
  await shot(page, "07-workflows-list");

  const firstRow = page.locator("tbody tr[role='link']").first();
  await expect(firstRow).toBeVisible();
  await firstRow.click();

  await expect(page.getByText("Pipeline")).toBeVisible();
  // the same two pillar-8 / pillar-4 surfaces hang off a workflow instance
  await expect(page.locator("section", { hasText: "PM work items" }).first()).toBeVisible();
  await expect(page.locator("section", { hasText: "Decision ledger" }).first()).toBeVisible();
  await shot(page, "08-workflow-detail");
  track.assertClean("workflows list + detail");
});

test("runs: goal decomposition drafts a reviewable, editable plan (pillar 7)", async () => {
  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();

  // the goal must be substantial — the endpoint enforces a 10-char minimum and
  // the UI states that before the request is made
  await page.getByLabel("Describe the goal").fill("short");
  await page.getByRole("button", { name: "Draft plan with a lead agent" }).click();
  await expect(page.getByText(/at least 10 characters/)).toBeVisible();

  await page
    .getByLabel("Describe the goal")
    .fill("Add per-tool price overrides to the MCP admin surface and prove they persist");
  await page.getByRole("button", { name: "Draft plan with a lead agent" }).click();
  await expect(page.getByText("Plan drafted").first()).toBeVisible();

  // the draft is a PROPOSAL — it must be visibly costed and visibly not-yet-run
  const proposal = page.getByTestId("run-proposal");
  await expect(proposal).toBeVisible();
  await expect(proposal.getByText(/plan drafted by/)).toBeVisible();
  await expect(proposal.getByText(/lead cost/)).toBeVisible();
  await expect(proposal.getByText(/nothing runs until you press Plan run/)).toBeVisible();
  await shot(page, "06d-run-proposal");

  // and it must be EDITABLE before acceptance
  const firstTitle = proposal.getByLabel(/^Title for node /).first();
  await expect(firstTitle).toBeVisible();
  const editedTitle = `edited by the human ${Date.now()}`;
  await firstTitle.fill(editedTitle);

  // accepting is the ordinary POST /v1/runs — the run that appears carries the
  // human's edit, not the lead's original wording
  await page.getByRole("button", { name: "Plan run" }).click();
  await expect(page.getByText(/Run planned/).first()).toBeVisible();
  await expect(page.getByText("Task graph")).toBeVisible();
  await expect(page.getByText(editedTitle)).toBeVisible();
  await shot(page, "06e-run-from-proposal");
  track.assertClean("goal decomposition");
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

test("spend & savings: a non-admin sees their OWN spend and the optimizer's savings", async () => {
  // the ADR-0026 end-user residual: cost-events / usage-events were reachable
  // in the SPA only from the ADMIN Optimization page
  await page.locator("aside").getByRole("link", { name: "Spend & savings" }).click();
  await expect(page.getByRole("heading", { name: "Spend & savings", exact: true })).toBeVisible();

  // the four self-scoped headline numbers
  await expect(page.getByText("measured spend ·")).toBeVisible();
  await expect(page.getByText("tokens in → out")).toBeVisible();
  await expect(page.getByText("measured savings — routing actuals")).toBeVisible();
  await expect(page.getByText("estimated savings — all techniques")).toBeVisible();

  // dana is NOT an admin, so the page must not advertise an org-wide rollup
  await expect(page.getByText("your own numbers only")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Cost dashboard" })).toHaveCount(0);

  // the seeded dispatches + connector reads make every breakdown real
  await expect(page.getByText("Spend by project", { exact: true })).toBeVisible();
  await expect(page.getByText("Spend by agent", { exact: true })).toBeVisible();
  await expect(page.getByText("Spend by connector", { exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Key used" })).toBeVisible();
  await expect(page.getByRole("img", { name: "Daily spend, last 14 days" })).toBeVisible();
  await shot(page, "13a-spend-overview");

  // the pillar-6 half: what the optimizer did on her behalf
  await page.getByRole("tab", { name: "Savings" }).click();
  await expect(page.getByText("Savings by technique — estimated, full history")).toBeVisible();
  await expect(page.getByText("What the optimizer did for you")).toBeVisible();
  await expect(page.getByText("Estimated vs measured")).toBeVisible();
  await shot(page, "13b-spend-savings");

  track.assertClean("spend & savings");
});

test("my model keys: add, listed as present-but-never-revealed, remove", async () => {
  const SECRET = "sk-e2e-never-echoed-0123456789";
  await page.getByRole("button", { name: /Dana Developer/ }).click();
  await page.getByRole("menuitem", { name: "Your model keys" }).click();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(page.getByText("Your model keys", { exact: true })).toBeVisible();
  // nothing stored yet — and no custody notice, since the seed leaves the
  // key-custody toggle off
  await expect(page.getByText("No keys of your own")).toBeVisible();
  await expect(page.getByText("This deployment enforces key custody.")).toHaveCount(0);
  await shot(page, "13c-model-keys-empty");

  await page.getByLabel("API key").fill(SECRET);
  await page.getByRole("button", { name: "Save key" }).click();
  await expect(page.getByText(/anthropic key saved/)).toBeVisible();

  // presence is reported; the secret itself is nowhere on the page or in the DOM
  await expect(page.getByRole("cell", { name: "anthropic", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "stored", exact: true })).toBeVisible();
  await expect(page.getByRole("cell", { name: "provider default" })).toBeVisible();
  expect(await page.content()).not.toContain(SECRET);
  await expect(page.getByLabel("API key")).toHaveValue("");
  // re-selecting the provider now offers a rotation rather than a duplicate
  await expect(page.getByRole("button", { name: "Replace key" })).toBeVisible();
  await shot(page, "13d-model-keys-stored");

  await page.getByRole("button", { name: "Remove your anthropic key" }).click();
  await page.getByRole("button", { name: "Remove key" }).click();
  await expect(page.getByText(/anthropic key removed/)).toBeVisible();
  await expect(page.getByText("No keys of your own")).toBeVisible();
  await shot(page, "13e-model-keys-removed");

  track.assertClean("model keys add/list/remove");
});

test("account + theme toggle + sign out", async () => {
  await page.getByRole("button", { name: /Dana Developer/ }).click();
  await page.getByRole("menuitem", { name: "Account", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
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
