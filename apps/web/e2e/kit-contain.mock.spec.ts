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

test("Tab and Shift+Tab stay inside the expanded view, through the portaled body", async ({ page }) => {
  await open(page, "rows=60");
  await page.getByRole("button", { name: "Expand" }).click();
  const dialog = page.getByRole("dialog", { name: "Findings" });
  const close = dialog.getByRole("button", { name: "Close" });
  const pin = dialog.getByTestId("contain-toggle");
  // Close is the first control, the portaled Pin the last
  await pin.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(pin).toBeFocused();
});

for (const width of [1280, 390]) {
  test(`the expanded view has a visible Close that hands focus back to Expand (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await open(page, "rows=60");
    const expand = page.getByRole("button", { name: "Expand" });
    await expand.click();
    const dialog = page.getByRole("dialog", { name: "Findings" });
    // pinned in view even once the long body has scrolled
    await dialog.evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const close = dialog.getByRole("button", { name: "Close" });
    await expect(close).toBeInViewport({ ratio: 1 });
    await close.click();
    await expect(dialog).toBeHidden();
    await expect(expand).toBeFocused();
  });
}

test("without StrictMode the body is in the document when its layout effects first run", async ({ page }) => {
  await open(page, "rows=3&strict=0");
  await expect(page.getByText("Finding 3")).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { probeConnected: boolean[] }).probeConnected)).toEqual([true]);
});

test("contain can switch on after mount", async ({ page }) => {
  await open(page, "rows=60&contain=late");
  await expect(page.getByRole("button", { name: "Expand" })).toHaveCount(0);
  await page.getByRole("button", { name: "Contain", exact: true }).click();
  await expect(page.getByRole("region", { name: "Findings, scrollable" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Expand" })).toBeVisible();
  await expect(page.getByTestId("contain-toggle")).toHaveCount(1);
});

test.describe("InfoButton", () => {
  test("clicking (i) in a sortable header opens it without sorting the column", async ({ page }) => {
    await open(page, "view=info");
    const header = page.locator("th", { hasText: "Name" });
    await header.getByRole("button", { name: "What is Name?" }).click();
    await expect(page.getByRole("note")).toHaveText("The record's display name.");
    await expect(header).not.toHaveAttribute("aria-sort", /.*/);
    await expect(page.locator("tbody td").first()).toHaveText("Beta");
  });

  test("shows the term as its first line and closes on a pointer down outside", async ({ page }) => {
    await open(page, "view=info");
    await page.getByRole("button", { name: "What is residual risk?" }).click();
    const note = page.getByRole("note");
    await expect(note.locator("b")).toHaveText("Residual risk");
    await expect(note).toContainText("The risk left after controls apply.");
    // a bare pointer down, no click: focus stays put, so blur cannot be what closes it
    await page.getByText("Outside").dispatchEvent("pointerdown");
    await expect(note).toHaveCount(0);
  });

  test("near the bottom edge the panel opens above its trigger", async ({ page }) => {
    await open(page, "view=info");
    const trigger = page.locator('button[aria-label$="residual risk?"], button[aria-label^="Hide help for residual risk"]');
    await trigger.click();
    const panel = (await page.getByRole("note").boundingBox())!;
    const button = (await trigger.boundingBox())!;
    expect(panel.y + panel.height).toBeLessThanOrEqual(button.y);
    expect(panel.y).toBeGreaterThanOrEqual(0);
  });
});
