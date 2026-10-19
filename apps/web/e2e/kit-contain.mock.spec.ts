import { expect, test, type Page } from "@playwright/test";

// X6a (Governed - Designer, owner-approved 2026-10-19): a contained card renders
// its body once, notices rows added later, keeps Expand on phones, is a tab stop
// only while it scrolls, and refuses to contain forms and warnings (ADR-0180).
// The harness page is served by the Vite dev server only.

const open = (page: Page, query: string) => page.goto(`/ui/e2e/harness/kit-contain.html?${query}`);
const box = (page: Page) => page.locator("[data-rg-card] > div").last();

test("the body renders once, and its state survives Expand and close", async ({ page }) => {
  await open(page, "rows=60");
  const toggle = page.getByTestId("contain-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const expand = page.getByRole("button", { name: "Expand" });
  await expand.click();
  const dialog = page.getByRole("dialog", { name: "Findings" });
  await expect(dialog).toBeVisible();
  // one subtree: the toggle moved into the dialog, it was not mounted twice
  await expect(page.getByTestId("contain-toggle")).toHaveCount(1);
  expect(await page.locator("#contain-toggle").count()).toBe(1);
  await expect(dialog.getByTestId("contain-toggle")).toHaveAttribute("aria-pressed", "true");
  await dialog.getByTestId("contain-toggle").click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(box(page).getByTestId("contain-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect(expand).toBeFocused();
});

test("the expanded view fits the dynamic viewport", async ({ page }) => {
  await open(page, "rows=60");
  await page.getByRole("button", { name: "Expand" }).click();
  const height = (await page.getByRole("dialog").boundingBox())!.height;
  expect(height).toBeLessThanOrEqual(page.viewportSize()!.height);
  expect(height).toBeGreaterThan(page.viewportSize()!.height * 0.9);
});

test("a short body is no tab stop and has no Expand; rows added later bring both", async ({ page }) => {
  await open(page, "rows=3");
  await expect(page.getByText("3 rows")).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand" })).toHaveCount(0);
  await expect(page.getByRole("region")).toHaveCount(0);
  await expect(box(page)).not.toHaveAttribute("tabindex", /.*/);
  await page.getByRole("button", { name: "Add rows" }).click();
  await expect(page.getByRole("button", { name: "Expand" })).toBeVisible();
  const region = page.getByRole("region", { name: "Findings, scrollable" });
  await expect(region).toHaveAttribute("tabindex", "0");
});

test("on a phone the body flows with the page and still offers Expand", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await open(page, "rows=60");
  await expect(page.getByRole("button", { name: "Expand" })).toBeVisible();
  // nothing scrolls inside, so it is neither a tab stop nor a landmark
  await expect(page.getByRole("region")).toHaveCount(0);
  const { scroll, client } = await box(page).evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
  expect(scroll).toBeLessThanOrEqual(client + 1);
});

for (const variant of ["alert", "form"]) {
  test(`a body holding ${variant === "alert" ? "an alert" : "a form"} is never contained`, async ({ page }) => {
    const warnings: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "warning") warnings.push(m.text());
    });
    await open(page, `rows=60&variant=${variant}`);
    await expect(page.getByText("Finding 60")).toBeAttached();
    await expect(page.getByRole("button", { name: "Expand" })).toHaveCount(0);
    await expect(page.getByRole("region")).toHaveCount(0);
    // fully visible: the box does not clip, so the page scroll reaches the last row
    const { scroll, client } = await box(page).evaluate((el) => ({ scroll: el.scrollHeight, client: el.clientHeight }));
    expect(scroll).toBeLessThanOrEqual(client + 1);
    expect(warnings.some((w) => w.includes("contain refused"))).toBe(true);
  });
}

test("a warning that appears under a long, already-clipped body releases it", async ({ page }) => {
  await open(page, "rows=60");
  await expect(page.getByRole("region", { name: "Findings, scrollable" })).toBeVisible();
  // the clamped box keeps its size, so only watching the whole body notices this
  await page.getByRole("button", { name: "Fail refresh" }).click();
  await expect(page.getByRole("button", { name: "Expand" })).toHaveCount(0);
  await expect(page.getByRole("region")).toHaveCount(0);
});
