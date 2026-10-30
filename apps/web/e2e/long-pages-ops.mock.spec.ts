/**
 * P3 long-page split (#453 c6527514889) on the operations and cost pages, against the mocked gateway in
 * long-pages-ops.fixtures.ts:
 *
 *  - each overview keeps a short preview (at most five rows) with its count, and what needs attention in the heading;
 *  - "View all" opens the list's own page, where the full list control works (page size, sort, Excel);
 *  - the breadcrumb goes back to the overview;
 *  - every warning the long page showed is still visible without a click (a preview heading or a tab label);
 *  - axe (WCAG 2.x A/AA) is clean on the previews, the tabs and the list pages, in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { EXECUTOR_ID, IMPORT_ID, REGISTRY_ID, mockOps, type OpsCapture } from "./long-pages-ops.fixtures";

const status = (page: Page, listId: string) => page.locator(`[data-list="${listId}"]`).getByTestId("list-status");
const lastList = (cap: OpsCapture, endpoint: string) => [...cap.lists].reverse().find((u) => u.pathname === endpoint)!;
const preview = (page: Page, endpoint: string) => page.locator(`[data-preview="${endpoint}"]`);

async function expectAxeClean(page: Page, label: string, selectors: string[]) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1000))]);
    }, theme);
    let axe = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
    for (const s of selectors) axe = axe.include(s);
    const results = await axe.analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

/** the full list control on a list page: 10 rows of N, a header click asks the server, Excel asks for the screen's columns */
async function expectControl(page: Page, cap: OpsCapture, listId: string, endpoint: string, total: number, sortHeader: string, sortId: string) {
  await expect(status(page, listId)).toHaveText(`1–${Math.min(10, total)} of ${total}`);
  expect(lastList(cap, endpoint).searchParams.get("limit")).toBe("10");
  await page.locator(`[data-list="${listId}"]`).getByLabel("Rows per page").selectOption("50");
  await expect(status(page, listId)).toHaveText(`1–${Math.min(50, total)} of ${total}`);
  await page.locator(`[data-list="${listId}"]`).getByLabel("Rows per page").selectOption("10");
  const th = page.locator(`[data-list="${listId}"] thead th`).filter({ has: page.getByRole("button", { name: sortHeader, exact: true }) });
  await th.getByRole("button", { name: sortHeader, exact: true }).click();
  await expect.poll(() => lastList(cap, endpoint).searchParams.get("sort")).toBe(sortId);
  await page.locator(`[data-list="${listId}"]`).getByRole("button", { name: "Download Excel" }).click();
  await expect.poll(() => cap.exports.length).toBe(1);
  expect(cap.exports[0]!.pathname).toBe(`${endpoint}/export.xlsx`);
  expect(cap.exports[0]!.searchParams.get("sort")).toBe(sortId);
  // the gear is there too (the column picker itself is covered by list-control-p2c.mock.spec.ts)
  await expect(page.getByRole("button", { name: /^Choose columns for / }).first()).toBeVisible();
}

async function backTo(page: Page, crumb: string, path: string) {
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: crumb }).click();
  await expect(page).toHaveURL(new RegExp(`/ui${path.replace(/[?]/g, "\\?")}$`));
}

test.describe("Cross-vendor consolidation", () => {
  test("warnings stay visible without a click: the honesty legend, the tab counts and a refused import", async ({ page }) => {
    await mockOps(page);
    await page.goto("/ui/admin/cost-consolidation");
    await expect(page.getByText("Imported · customer-supplied")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Import · 3 refused" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Consolidated view · 1 unattributed" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Reconciliation · 1 warning" })).toBeVisible();
    await expect(page.getByText("Import history · 37 imports · 3 refused")).toBeVisible();
    await expect(preview(page, "/v1/cost-imports").getByText("refused", { exact: true }).first()).toBeVisible();
    await expect(preview(page, "/v1/cost-imports").locator("tbody tr")).toHaveCount(5);
    await expectAxeClean(page, "consolidation overview", ['[role="tablist"]', "[data-preview]"]);
  });

  test("View all opens the import history with the list control, its filter, and a breadcrumb back", async ({ page }) => {
    const cap = await mockOps(page);
    await page.goto("/ui/admin/cost-consolidation");
    await page.getByRole("link", { name: "View all imports" }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/cost-consolidation\/imports$/);
    await expect(page.getByRole("heading", { level: 1, name: "Import history" })).toBeVisible();
    await expectControl(page, cap, "cost-imports", "/v1/cost-imports", 37, "Vendor", "vendor");
    await page.getByLabel("Status").selectOption("refused");
    await expect(status(page, "cost-imports")).toHaveText("1–3 of 3");
    expect(lastList(cap, "/v1/cost-imports").searchParams.get("status")).toBe("refused");
    await expectAxeClean(page, "import history page", ["[data-list]", 'nav[aria-label="Breadcrumb"]']);
    await backTo(page, "Cross-vendor consolidation", "/admin/cost-consolidation");
  });

  test("an import's lines: five in the dialog with the unattributed count, every line on the batch's own page", async ({ page }) => {
    const cap = await mockOps(page);
    await page.goto("/ui/admin/cost-consolidation/imports");
    await page.getByRole("button", { name: /^Open the acme-ai import/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Imported cost batch" });
    await expect(dialog.getByText("Imported lines · 42 lines · 4 unattributed")).toBeVisible();
    await expect(dialog.locator(`[data-preview] tbody tr`)).toHaveCount(5);
    await dialog.getByRole("link", { name: "View all lines" }).click();
    await expect(page).toHaveURL(new RegExp(`/ui/admin/cost-consolidation/imports/${IMPORT_ID}$`));
    await expect(page.getByText(/4 line\(s\) unattributed/)).toBeVisible();
    await expectControl(page, cap, "cost-import-lines", `/v1/cost-imports/${IMPORT_ID}`, 42, "Vendor account", "acct");
    await expectAxeClean(page, "import lines page", ["[data-list]"]);
    await backTo(page, "Import history", "/admin/cost-consolidation/imports");
  });
});

test.describe("Engines", () => {
  test("warnings stay visible without a click: engine status, and the Isolation and settings tab counts", async ({ page }) => {
    await mockOps(page);
    await page.goto("/ui/admin/engines");
    await expect(page.getByText(/self-test failed/).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: "Isolation · 1 quarantined · 8 refused · 1 projects unresolved" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Run settings · unmeasured" })).toBeVisible();
    await page.getByRole("tab", { name: /^Isolation/ }).click();
    await expect(page.getByText("Placement decisions · newest 50 decisions · 5 refused · 1 mismatched · 2 refused before placement")).toBeVisible();
    await expect(page.getByText("Quarantined", { exact: true })).toBeVisible();
    await expect(page.getByText("Unresolved · calls refused")).toBeVisible();
    await expectAxeClean(page, "engines isolation tab", ['[role="tablist"]', '[role="tabpanel"]']);
  });

  test("placement decisions: View all, every decision with Load older, and a breadcrumb back", async ({ page }) => {
    await mockOps(page);
    await page.goto("/ui/admin/engines?tab=isolation");
    await page.getByRole("link", { name: "View all placement decisions" }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/engines\/placements$/);
    await expect(page.getByRole("heading", { level: 1, name: "Placement decisions" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Evidence for placement/ })).toHaveCount(50);
    await page.getByRole("button", { name: "Load older decisions" }).click();
    await expect(page.getByRole("button", { name: /^Evidence for placement/ })).toHaveCount(60);
    await expect(page.getByText("Refused before any placement")).toBeVisible();
    await backTo(page, "Engines", "/admin/engines");
  });

  test("an executor's self-test history: five rows in its detail, the full list control on its own page", async ({ page }) => {
    const cap = await mockOps(page);
    await page.goto("/ui/admin/engines?tab=isolation");
    await page.getByRole("button", { name: /^Manage/ }).first().click();
    await expect(page.getByText("Self-test history · 26 self-test reports")).toBeVisible();
    await page.getByRole("link", { name: "View all self-test reports" }).click();
    await expect(page).toHaveURL(new RegExp(`/ui/admin/engines/executors/${EXECUTOR_ID}/attestations$`));
    await expectControl(page, cap, "executor-attestations", `/v1/executors/${EXECUTOR_ID}/attestations`, 26, "Class", "class");
    await expectAxeClean(page, "self-test history page", ["[data-list]"]);
    await backTo(page, "Engines", "/admin/engines");
  });
});

test.describe("MCP servers: a registry's catalogue", () => {
  test("five entries and a count on the registries tab; the catalogue's own page has the control and its filters", async ({ page }) => {
    const cap = await mockOps(page);
    await page.goto("/ui/admin/mcp-servers?tab=registries");
    await page.getByRole("button", { name: "Browse entries of Public MCP registry" }).click();
    await expect(page.getByText("Catalogue: Public MCP registry · 64 catalogue entries")).toBeVisible();
    const p = preview(page, `/v1/mcp-registries/${REGISTRY_ID}/entries`);
    await expect(p.locator("tbody tr")).toHaveCount(5);
    // a conflict is a state chip, required on every row the preview shows
    await expect(p.getByText("name taken").first()).toBeVisible();
    await expectAxeClean(page, "registry preview", ["[data-preview]"]);
    await page.getByRole("link", { name: "View all catalogue entries" }).click();
    await expect(page).toHaveURL(new RegExp(`/ui/admin/mcp-servers/registries/${REGISTRY_ID}/entries$`));
    await expectControl(page, cap, "mcp-registry-entries", `/v1/mcp-registries/${REGISTRY_ID}/entries`, 64, "Kind", "kind");
    await page.getByLabel("Kind", { exact: true }).selectOption("catalogue_only");
    await expect.poll(() => lastList(cap, `/v1/mcp-registries/${REGISTRY_ID}/entries`).searchParams.get("kind")).toBe("catalogue_only");
    await expect(status(page, "mcp-registry-entries")).toHaveText("1–10 of 12");
    await expectAxeClean(page, "catalogue page", ["[data-list]"]);
    await backTo(page, "MCP servers: federated registries", "/admin/mcp-servers?tab=registries");
  });
});

test.describe("Cost dashboard", () => {
  test("budgets and the unattributed bucket stay on the default tab; set-up is its own tab", async ({ page }) => {
    await mockOps(page);
    await page.goto("/ui/admin/cost");
    await expect(page.getByRole("tab", { name: "Spend", selected: true })).toBeVisible();
    await expect(page.getByRole("meter", { name: "team-17 project 2 budget" }).or(page.getByLabel("team-17 project 2 budget"))).toBeVisible();
    await expect(page.getByText("no budget set")).toBeVisible();
    await expect(page.getByText("Unattributed spend — calls with no project header")).toBeVisible();
    await expect(page.getByText("Create a project")).toHaveCount(0);
    await page.getByRole("tab", { name: "Projects and initiatives" }).click();
    await expect(page).toHaveURL(/\/ui\/admin\/cost\?tab=setup$/);
    await expect(page.getByText("Create a project")).toBeVisible();
    await expect(page.getByText("Initiatives — cross-team rollup")).toBeVisible();
    await expectAxeClean(page, "cost dashboard tabs", ['[role="tablist"]']);
  });
});

test.describe("Infrastructure", () => {
  test("warnings stay visible without a click: the posture, the attention counts and the worst rows", async ({ page }) => {
    await mockOps(page);
    await page.goto("/ui/admin/infrastructure");
    await expect(page.getByText("open findings (23 total)")).toBeVisible();
    await expect(page.getByText("backups missed / targets")).toBeVisible();
    await expect(page.getByText("Findings — severity-sorted posture inbox · 23 findings · 6 open")).toBeVisible();
    await expect(page.getByText("Backups — run / restore ledger · 21 backup runs · 2 missed")).toBeVisible();
    await expect(page.getByText("Certificates — rotation ledger · 9 certificates")).toBeVisible();
    await expect(page.getByText("CVE patches — remediation ledger · 17 CVE patches")).toBeVisible();
    await expect(page.getByText("Resources — with cascade-derived floors · 14 resources")).toBeVisible();
    // worst first: a critical finding and the soonest-expiring certificate head their previews
    await expect(preview(page, "/v1/infra/findings").locator("tbody tr").first()).toContainText("critical");
    await expect(preview(page, "/v1/infra/certs").locator("tbody tr").first()).toContainText("rotation_failed");
    await expect(preview(page, "/v1/infra/backups").getByText("missed", { exact: true })).toBeVisible();
    for (const e of ["/v1/infra/findings", "/v1/infra/certs", "/v1/infra/patches", "/v1/infra/backups", "/v1/infra/resources"]) {
      await expect(preview(page, e).locator("tbody tr")).toHaveCount(5);
    }
    await page.getByRole("tab", { name: "Set up" }).click();
    await expect(page.getByText("Mock executor only")).toBeVisible();
    await expect(page.getByText("Operational policies")).toBeVisible();
    await expectAxeClean(page, "infrastructure overview", ['[role="tablist"]', '[role="tabpanel"]']);
  });

  for (const [id, noun, listId, endpoint, total, sortHeader, sortId] of [
    ["findings", "findings", "infra-findings", "/v1/infra/findings", 23, "Kind", "kind"],
    ["certificates", "certificates", "infra-certs", "/v1/infra/certs", 9, "Common name", "cn"],
    ["patches", "CVE patches", "infra-patches", "/v1/infra/patches", 17, "CVE", "cve"],
    ["backups", "backup runs", "infra-backups", "/v1/infra/backups", 21, "Kind", "kind"],
    ["resources", "resources", "infra-resources", "/v1/infra/resources", 14, "Name", "name"],
  ] as const) {
    test(`${noun}: View all, the list control, and a breadcrumb back`, async ({ page }) => {
      const cap = await mockOps(page);
      await page.goto("/ui/admin/infrastructure");
      await page.getByRole("link", { name: `View all ${noun}` }).click();
      await expect(page).toHaveURL(new RegExp(`/ui/admin/infrastructure/${id}$`));
      await expectControl(page, cap, listId, endpoint, total, sortHeader, sortId);
      if (id !== "resources") await expect(page.getByLabel("Remediation approver (persisted org default)")).toBeVisible();
      await expectAxeClean(page, `${noun} page`, ["[data-list]"]);
      await backTo(page, "Infrastructure", "/admin/infrastructure");
    });
  }
});
