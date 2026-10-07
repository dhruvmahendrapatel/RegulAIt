import { expect, type Locator, type Page } from "@playwright/test";

/** Navigate with real Tab presses: locating a control never focuses it. */
export async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  for (let step = 0; step < 180; step += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target, "control must be reachable in the keyboard tab order").toBeFocused();
}

export async function activate(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press("Enter");
}

export async function typeAt(page: Page, target: Locator, text: string) {
  await tabTo(page, target);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(text);
  await expect(target).toHaveValue(text);
  await expect(target, "editing must not move focus back to the dialog").toBeFocused();
}

export async function selectAt(page: Page, target: Locator, value: string) {
  const index = await target.evaluate((element, wanted) =>
    Array.from((element as HTMLSelectElement).options).findIndex((option) => option.value === wanted), value);
  expect(index, `option ${value} must exist`).toBeGreaterThanOrEqual(0);
  await tabTo(page, target);
  await page.keyboard.press("Home");
  for (let step = 0; step < index; step += 1) await page.keyboard.press("ArrowDown");
  await expect(target).toHaveValue(value);
}

export async function expectDialogTrap(page: Page, dialog: Locator) {
  await expect(dialog).toBeVisible();
  const controls = await dialog.locator('button, input, select, textarea, a[href], [tabindex]').evaluateAll((elements) =>
    elements.filter((element) => !element.matches(":disabled") && (element as HTMLElement).tabIndex >= 0 &&
      element.getClientRects().length > 0).length);
  expect(controls, "the dialog keyboard audit must exercise actual controls").toBeGreaterThan(0);
  for (const direction of ["Tab", "Shift+Tab"]) {
    for (let step = 0; step < controls + 2; step += 1) {
      await page.keyboard.press(direction);
      expect(await dialog.evaluate((element) => element.contains(document.activeElement)),
        `${direction} must keep focus inside the modal`).toBe(true);
    }
  }
}

export async function escapeToTrigger(page: Page, dialog: Locator, trigger: Locator) {
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger, "closing the dialog must restore its keyboard trigger").toBeFocused();
}
