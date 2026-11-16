/**
 * P3 with the I-2 tabs pattern on Licensing & seats (#453): the current state stays above the tabs, the rest of the
 * page sits in five tabs, each paired with its tabpanel; a tab's label says what is unresolved inside it, so a hidden
 * refusal or warning is still announced; a pasted artifact survives a tab switch; axe is clean on every tab.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./long-pages-identity.fixtures";

async function expectAxeClean(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))), new Promise((r) => setTimeout(r, 1000))]);
    }, theme);
    const results = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

/** each tab, its label with these mocks, and a card title that only its panel shows */
const TABS = [
  { label: "Action classes", card: "What still works, and what does not", also: "Action-class inventory" },
  { label: "Seats", card: "Seats", also: null },
  { label: "Tier features", card: "Tier features", also: null },
  // the mocked deployment has no in-process scheduler: a warning badge in this panel
  { label: "Install and verify · 1 warning", card: "Install a licence", also: null },
  // 12 of the 45 mocked verifications were refused
  { label: "History · 12 refused", card: "Installed licences", also: "Verification trail · 45 verifications · 12 refused" },
] as const;

test("Licensing: the state stays above five tabs, each label names what it holds, and every panel is reachable", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ui/admin/licensing");
  await expect(page.getByRole("heading", { name: "Licensing & seats", level: 1 })).toBeVisible();

  // the status row is above the tabs, never inside a panel
  const state = page.getByText("Current state", { exact: true });
  await expect(state).toBeVisible();
  expect(await state.evaluate((el) => el.closest('[role="tabpanel"]') === null)).toBe(true);

  const tablist = page.getByRole("tablist", { name: "Licensing" });
  await expect(tablist.getByRole("tab")).toHaveText(TABS.map((t) => t.label));
  await expect(tablist.getByRole("tab", { name: "Action classes", exact: true })).toHaveAttribute("aria-selected", "true");

  for (const t of TABS) {
    const tab = tablist.getByRole("tab", { name: t.label, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    const panel = page.locator(`#${await tab.getAttribute("aria-controls")}`);
    await expect(panel).toHaveAttribute("role", "tabpanel");
    await expect(panel).toHaveAttribute("aria-labelledby", (await tab.getAttribute("id"))!);
    await expect(panel).toBeVisible();
    await expect(panel.getByText(t.card, { exact: true }).first()).toBeVisible();
    if (t.also) await expect(panel.getByText(t.also, { exact: true })).toBeVisible();
    // exactly one panel shows
    await expect(page.locator('[role="tabpanel"]:visible')).toHaveCount(1);
    await expectAxeClean(page, `Licensing · ${t.label}`);
  }
});

test("Licensing: the install tab keeps its warning and step, and a pasted artifact survives a tab switch", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ui/admin/licensing");
  await page.getByRole("tab", { name: "Install and verify · 1 warning" }).click();
  const install = page.getByRole("button", { name: "Install", exact: true });
  // nothing pasted: Install is disabled
  await expect(install).toBeDisabled();
  const artifact = page.getByLabel("Signed artifact (the JSON scripts/sign-license.sh emits)");
  await artifact.fill('{"documentBase64":"e30=","signature":"c2ln","signingKeyId":"key-1"}');
  await expect(install).toBeEnabled();
  await page.getByRole("tab", { name: "History · 12 refused" }).click();
  await expect(artifact).toBeHidden();
  await page.getByRole("tab", { name: "Install and verify · 1 warning" }).click();
  await expect(artifact).toHaveValue('{"documentBase64":"e30=","signature":"c2ln","signingKeyId":"key-1"}');
  await expect(page.getByRole("button", { name: "Re-verify now" })).toBeEnabled();
});

test("Licensing: the tabs move with the arrow keys", async ({ page }) => {
  await mockApi(page);
  await page.goto("/ui/admin/licensing");
  const first = page.getByRole("tab", { name: "Action classes", exact: true });
  await first.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Seats", exact: true })).toBeFocused();
});
