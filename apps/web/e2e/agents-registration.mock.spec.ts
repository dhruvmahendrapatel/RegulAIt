import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const AGENT = "a1111111-1111-4111-8111-111111111111";
const ENDPOINT = "b1111111-1111-4111-8111-111111111111";
const ALTERNATIVE = "b2222222-2222-4222-8222-222222222222";
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const registration = (page: Page) => page.locator("section").filter({ has: page.getByText("Register an agent", { exact: true }) });

async function fixture(page: Page) {
  const st = { enabled: true, present: true, reads: 0, registrations: [] as Record<string, unknown>[] };
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = route.request().method();
    if (p === "/auth/me" || p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/users") return json(route, { users: [{ id: "ada", displayName: "Ada Admin", email: "ada@example.test", isAdmin: true, disabledAt: null }] });
    if (p === "/v1/custom-model-providers") {
      st.reads++;
      const base = { wireProtocol: "openai", baseUrl: "https://endpoint.example.test", authMode: "none", connectionTestStatus: "passed" };
      return json(route, { providers: [...(st.present ? [{ ...base, id: ENDPOINT, name: "Local endpoint", enabled: st.enabled }] : []), { ...base, id: ALTERNATIVE, name: "Alternative endpoint", enabled: true }] });
    }
    if (p === "/v1/agents") {
      if (method === "POST") { st.registrations.push(route.request().postDataJSON()); return json(route, { id: "new-agent" }, 201); }
      return json(route, { agents: [{ id: AGENT, name: "Fixture agent", provider: "mock", tier: 1, model: "mock-balanced", enabled: true, costPerMTokIn: null, costPerMTokOut: null, lifecycleStatus: "active", stewardUserId: "ada", stewardName: "Ada Admin", reviewCadenceMonths: 12 }] });
    }
    return json(route, {});
  });
  await page.goto("/ui/admin/agents");
  const card = registration(page);
  await card.getByLabel("Name", { exact: true }).fill("Draft custom agent");
  await card.getByRole("radio", { name: "Custom endpoint", exact: true }).check();
  await card.getByTestId("agent-custom-endpoint").selectOption(ENDPOINT);
  return st;
}

for (const state of ["disabled", "removed"] as const) {
  test(`UX-AG-2: a selected endpoint ${state} during a draft stays visible and cannot be bound`, async ({ page }, testInfo) => {
    const st = await fixture(page);
    if (state === "disabled") st.enabled = false; else st.present = false;
    const reads = st.reads;
    // Saving another card performs the normal admin-catalog invalidation,
    // exactly as a real catalogue change/refetch would; it preserves this draft.
    const prompt = page.locator("section").filter({ has: page.getByText("System prompt — admin base (governance artifact)", { exact: true }) });
    await prompt.getByLabel("Agent", { exact: true }).selectOption(AGENT);
    await prompt.getByRole("button", { name: "Save prompt", exact: true }).click();
    await expect.poll(() => st.reads).toBeGreaterThan(reads);
    const card = registration(page);
    const endpoint = card.getByTestId("agent-custom-endpoint");
    await expect(endpoint).toHaveValue(ENDPOINT);
    await expect(endpoint.locator("option:checked")).toContainText(state === "disabled" ? "disabled" : "unavailable");
    await expect(card.getByRole("alert")).toContainText("Choose an enabled endpoint");
    await expect(card.getByLabel("Name", { exact: true })).toHaveValue("Draft custom agent");
    await expect(card.getByRole("button", { name: "Register agent", exact: true })).toBeDisabled();
    expect(st.registrations).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`endpoint-${state}.png`), fullPage: true });
    await endpoint.selectOption(ALTERNATIVE);
    await expect(card.getByRole("button", { name: "Register agent", exact: true })).toBeEnabled();
    await card.getByRole("button", { name: "Register agent", exact: true }).click();
    await expect.poll(() => st.registrations.length).toBe(1);
    expect(st.registrations[0]).toMatchObject({ name: "Draft custom agent", customProviderId: ALTERNATIVE, provider: "custom" });
  });
}

test("UX-AG-3: unpriced is explicit, does not submit staged prices, and recorded zero is distinct", async ({ page }, testInfo) => {
  const st = await fixture(page);
  const card = registration(page);
  const pricing = card.getByLabel("Pricing for this custom model");
  const input = card.getByLabel("$/MTok in", { exact: true });
  const output = card.getByLabel("$/MTok out", { exact: true });
  await expect(pricing).toHaveValue("unpriced");
  await expect(input).toBeDisabled();
  await expect(output).toBeDisabled();
  await pricing.selectOption("recorded");
  await input.fill("1.25");
  await output.fill("2.5");
  await pricing.selectOption("unpriced");
  await expect(input).toBeDisabled();
  await expect(input).toHaveValue("1.25");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((next) => { document.documentElement.dataset.theme = next; localStorage.setItem("regulait.theme", next); }, theme);
    const a = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    expect(a.violations.map((v) => v.id)).toEqual([]);
  }
  await page.screenshot({ path: testInfo.outputPath("explicit-unpriced.png"), fullPage: true });
  await card.getByRole("button", { name: "Register agent", exact: true }).click();
  await expect.poll(() => st.registrations.length).toBe(1);
  expect(st.registrations[0]).not.toHaveProperty("costPerMTokIn");
  expect(st.registrations[0]).not.toHaveProperty("costPerMTokOut");
  await card.getByLabel("Name", { exact: true }).fill("Recorded free model");
  await card.getByRole("radio", { name: "Custom endpoint", exact: true }).check();
  await card.getByTestId("agent-custom-endpoint").selectOption(ALTERNATIVE);
  await pricing.selectOption("recorded");
  await input.fill("0");
  await output.fill("0");
  await card.getByRole("button", { name: "Register agent", exact: true }).click();
  await expect.poll(() => st.registrations.length).toBe(2);
  expect(st.registrations[1]).toMatchObject({ costPerMTokIn: 0, costPerMTokOut: 0 });
});
