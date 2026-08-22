/**
 * ADR-0094 — suite-scoped navigation, asserted end to end:
 *
 *  1. The anti-stranding invariant: the "/" nav filter searches ACROSS ALL
 *     suites from inside any one of them — the escape hatch that makes the
 *     scoped sidebar safe.
 *  2. No entry becomes unreachable: for EVERY suite, switching to it via the
 *     keyboard-accessible switcher lands inside the suite and renders every
 *     one of its entries as a live link — and does NOT render other suites'.
 *  3. The home launcher's tiles land in their suites.
 *  4. Home keeps the just-shipped orientation card + at-a-glance stats ABOVE
 *     the tile grid (no regression of the Show-orientation toggle rework).
 *  5. The scoped sidebar and switcher work at phone width.
 *  6. A non-admin sees no launcher and no switcher — just their Workspace.
 *
 * The suite → entries manifest below is HARD-CODED on purpose: the app builds
 * both the launcher and the sidebar from one array, so a spec that imported
 * that array would assert the code against itself. This file is read-only
 * against the shared database, and still sorts last per M-018.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string; dana: string };
};
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(here, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const ADMIN_PASSWORD = "E2e-Admin-Phase2!";
const DANA_PASSWORD = "E2e-Rewrite-2026!"; // what phase1 settles dana on

/** Order-independent sign-in, copied from the phase4-7 / zz- specs (M-017). */
async function signIn(page: Page, email: string, candidates: string[], settleOn: string) {
  for (const [i, password] of candidates.entries()) {
    await page.goto("/ui");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    const welcome = page.getByRole("heading", { name: /Welcome back/ });
    const forcedChange = page.getByText("Your password is one-time");
    const rejected = page.getByText(/password is incorrect/);
    await expect(welcome.or(forcedChange).or(rejected).first()).toBeVisible();

    if (await welcome.isVisible()) return password;
    if (await forcedChange.isVisible()) {
      await page.getByLabel("Current (one-time) password").fill(password);
      await page.getByLabel("New password", { exact: true }).fill(settleOn);
      await page.getByLabel("Confirm new password").fill(settleOn);
      await page.getByRole("button", { name: "Set password & continue" }).click();
      await expect(welcome).toBeVisible();
      return settleOn;
    }
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
  throw new Error(`could not sign in as ${email}`);
}

/**
 * The full IA as the USER must experience it: every suite, its landing route,
 * and every destination it owns. If an entry is dropped from the app's suites
 * array, or a suite vanishes from the switcher, this manifest catches it.
 */
const SUITE_MANIFEST: Array<{ id: string; name: string; landing: string; entries: string[] }> = [
  {
    id: "workspace",
    name: "Workspace",
    landing: "/ui",
    entries: ["Chat", "Runs", "Workflows", "Inbox", "Projects", "Shared context", "Spend & savings"],
  },
  {
    id: "ai-governance",
    name: "AI Governance",
    landing: "/ui/admin/posture",
    entries: [
      "Posture",
      "Reports",
      "Governance copilot",
      "Use cases",
      "Model risk",
      "Vendors",
      "Risks",
      "Shadow-AI discovery",
    ],
  },
  {
    id: "access-reviews",
    name: "Access Reviews",
    landing: "/ui/admin/inventory",
    entries: ["Agent inventory", "Access recommendations", "Certification campaigns", "SoD rules"],
  },
  {
    id: "approvals-audit",
    name: "Approvals & Audit",
    landing: "/ui/admin/approvals",
    entries: [
      "Approvals queue",
      "Review workbench",
      "ChatOps approvals",
      "Audit log",
      "Data lineage",
      "Traces",
    ],
  },
  {
    id: "policies-gates",
    name: "Policies & Gates",
    landing: "/ui/admin/rules",
    entries: [
      "Rules engine",
      "ABAC policies",
      "Guardrails",
      "Prompt versions",
      "Simulation",
      "Workflow templates",
    ],
  },
  {
    id: "quality-security",
    name: "Quality & Security",
    landing: "/ui/admin/evals",
    entries: ["Evaluations", "Red-teaming", "External scorers"],
  },
  {
    id: "compliance-infra",
    name: "Compliance & Infra",
    landing: "/ui/admin/compliance",
    entries: ["Compliance profiles", "Compliance packs", "Infrastructure"],
  },
  {
    id: "cost-optimization",
    name: "Cost & Optimization",
    landing: "/ui/admin/cost",
    entries: [
      "Cost dashboard",
      "Cross-vendor consolidation",
      "Spend forecast & anomalies",
      "Metering & billing",
      "Optimization",
    ],
  },
  {
    id: "identity-access",
    name: "Identity & Access",
    landing: "/ui/admin/users",
    entries: [
      "Users",
      "Roles",
      "Teams",
      "Client access",
      "Virtual keys",
      "SSO & sessions",
      "Provisioning (SCIM)",
      "Group → role mapping",
    ],
  },
  {
    id: "integrations",
    name: "Integrations",
    landing: "/ui/admin/agents",
    entries: [
      "Agents",
      "Model credentials",
      "Custom LLM providers",
      "regulAIt-LLM",
      "Connectors",
      "MCP servers",
      "Git connections",
      "PM connections",
      "Deploy targets",
    ],
  },
  {
    id: "settings",
    name: "Settings",
    landing: "/ui/admin/organization",
    entries: [
      "Organization",
      "Licensing & seats",
      "Data key custody",
      "Scheduled jobs",
      "First-run setup",
      "Getting started",
    ],
  },
];

test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
});
test.afterAll(async () => {
  await page.close();
});

test("the / filter searches ACROSS suites — the anti-stranding escape hatch", async () => {
  // stand inside Policies & Gates, where Identity's and Audit's links are
  // (correctly) not rendered
  await page.goto("/ui/admin/rules");
  await expect(page.getByRole("heading", { name: "Rules engine", exact: true })).toBeVisible();
  const aside = page.locator("aside");
  await expect(aside.getByRole("link", { name: "Audit log", exact: true })).toHaveCount(0);

  // the "/" shortcut focuses the filter; typing another suite's entry finds
  // it, grouped under ITS section heading — not scoped to the current suite
  await page.keyboard.press("/");
  await expect(page.getByLabel("Filter navigation")).toBeFocused();
  await page.keyboard.type("Audit log");
  const hit = aside.getByRole("link", { name: "Audit log", exact: true });
  await expect(hit).toBeVisible();
  await expect(aside.getByText("Approvals & Audit", { exact: true })).toBeVisible();

  // selecting the match navigates, clears the filter, and re-scopes the
  // sidebar to the destination's suite
  await hit.click();
  await expect(page.getByRole("heading", { name: "Audit log", exact: true })).toBeVisible();
  await expect(page.getByLabel("Filter navigation")).toHaveValue("");
  await expect(aside.getByRole("link", { name: "Traces", exact: true })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Rules engine", exact: true })).toHaveCount(0);
});

test("every suite is switchable, renders ALL its own entries, and ONLY its own", async () => {
  test.setTimeout(180_000);
  await page.goto("/ui/");
  const aside = page.locator("aside");
  const switcher = page.getByLabel("Switch suite");

  for (const [i, suite] of SUITE_MANIFEST.entries()) {
    await switcher.selectOption(suite.id);
    await expect
      .poll(() => new URL(page.url()).pathname.replace(/\/+$/, ""), {
        message: `switching to ${suite.name} lands on ${suite.landing}`,
      })
      .toBe(suite.landing);
    // the identity header states the scope
    await expect(aside.getByText(suite.name, { exact: true }).first()).toBeVisible();
    // every destination the suite owns is a live link — nothing unreachable
    for (const label of suite.entries) {
      await expect(
        aside.getByRole("link", { name: label, exact: true }),
        `${suite.name} must render "${label}"`,
      ).toBeVisible();
    }
    // and the previous suite's first entry is NOT here (scoping is real);
    // Home, the constant affordance, always is
    const prev = SUITE_MANIFEST[(i + SUITE_MANIFEST.length - 1) % SUITE_MANIFEST.length]!;
    await expect(aside.getByRole("link", { name: prev.entries[0]!, exact: true })).toHaveCount(0);
    await expect(aside.getByRole("link", { name: "Home", exact: true })).toBeVisible();
  }
  await page.screenshot({ path: path.join(SHOTS, "zz-suite-nav-01-switcher-last-suite.png"), fullPage: true });
});

test("home launcher: a suite tile lands inside its suite", async () => {
  await page.goto("/ui/");
  await page.getByTestId("suite-tile-access-reviews").click();
  await expect(page.getByRole("heading", { name: "Agent inventory", exact: true })).toBeVisible();
  const aside = page.locator("aside");
  await expect(aside.getByRole("link", { name: "SoD rules", exact: true })).toBeVisible();
  await expect(aside.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
});

test("home keeps orientation + at-a-glance stats ABOVE the launcher tiles", async () => {
  await page.goto("/ui/");
  // the three live numbers of the at-a-glance card (they survive dismissal —
  // the just-shipped rework this must not regress)
  for (const label of ["decisions waiting on a human", "governed calls metered", "attributed spend"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  const statsBox = await page.getByText("governed calls metered", { exact: true }).boundingBox();
  const tilesBox = await page.getByTestId("suite-tile-ai-governance").boundingBox();
  expect(statsBox, "stats card must render").not.toBeNull();
  expect(tilesBox, "tile grid must render").not.toBeNull();
  expect(statsBox!.y, "stats sit above the launcher").toBeLessThan(tilesBox!.y);
  await page.screenshot({ path: path.join(SHOTS, "zz-suite-nav-02-home-launcher.png"), fullPage: true });
});

test("phone width: the drawer opens scoped, and the switcher still switches", async () => {
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto("/ui/admin/evals");
  await expect(page.getByRole("heading", { name: "Evaluations", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  const aside = page.locator("aside");
  await expect(aside.getByText("Quality & Security", { exact: true }).first()).toBeVisible();
  await expect(aside.getByRole("link", { name: "Red-teaming", exact: true })).toBeVisible();
  await page.screenshot({ path: path.join(SHOTS, "zz-suite-nav-03-mobile-drawer.png") });

  await page.getByLabel("Switch suite").selectOption("cost-optimization");
  await expect(page.getByRole("heading", { name: "Cost dashboard", exact: true })).toBeVisible();
  // the drawer closed itself after the switch — phone users are not stranded
  // behind an open overlay
  await expect(page.getByRole("button", { name: "Toggle navigation" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await page.setViewportSize({ width: 1400, height: 900 });
});

test("a non-admin gets no launcher, no switcher — just their Workspace", async () => {
  const dana = await (await page.context().browser()!.newContext()).newPage();
  await signIn(dana, "dana@regulait.local", [DANA_PASSWORD, state.passwords.dana], DANA_PASSWORD);
  await expect(dana.getByLabel("Switch suite")).toHaveCount(0);
  await expect(dana.locator('[data-testid^="suite-tile-"]')).toHaveCount(0);
  const aside = dana.locator("aside");
  for (const label of ["Chat", "Runs", "Projects", "Spend & savings"]) {
    await expect(aside.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await expect(aside.getByRole("link", { name: "Users", exact: true })).toHaveCount(0);
  await dana.close();
});
