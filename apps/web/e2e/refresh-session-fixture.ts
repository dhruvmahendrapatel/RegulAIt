import type { Page } from "@playwright/test";

/** Review precondition: another tab changed the session cookie. Invoke the
 * actual SessionProvider.refresh without navigating/unmounting the intake.
 * React's development fiber is inspected only to reach that existing callback;
 * no draft state, save outcome, or product function is patched. */
export async function refreshSessionInPlace(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const element = document.querySelector("main")!;
    const key = Object.keys(element).find((key) => key.startsWith("__reactFiber$"));
    if (!key) throw new Error("React development fixture unavailable");
    type Fiber = { return: Fiber | null; memoizedProps?: { value?: {
      refresh?: () => Promise<{ userId: string } | null>; applyAuth?: unknown;
    } } };
    let fiber = (element as unknown as Record<string, Fiber>)[key];
    while (fiber) {
      const value = fiber.memoizedProps?.value;
      if (value?.refresh && value.applyAuth) {
        const auth = await value.refresh();
        if (!auth) throw new Error("Refreshed session missing");
        return auth.userId;
      }
      fiber = fiber.return!;
    }
    throw new Error("SessionProvider not found");
  });
}
