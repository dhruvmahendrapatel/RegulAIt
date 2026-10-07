import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
async function setup(page: Page, state: unknown = { state: "no_key", lastSeq: 0, lagRows: 3 }, fail = false) {
  const calls = { exports: [] as string[], verifies: [] as unknown[] };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url()), p = url.pathname;
    if (!p.startsWith("/v1") && !p.startsWith("/auth")) return route.continue();
    const me = { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } };
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/receipts/status") return json(route, fail ? { error: "receipt_signing_key_invalid" } : state, fail ? 503 : 200);
    if (p === "/v1/receipts/export") {
      calls.exports.push(url.search);
      return json(route, { verifier: "regulait.receipt.v1", receipts: [], keys: [] });
    }
    if (p === "/v1/receipts/verify") {
      calls.verifies.push(route.request().postDataJSON());
      return json(route, { results: [{ receiptSeq: 1, status: "invalid", reason: "Signature mismatch." }, { receiptSeq: 2, status: "unverifiable", reason: "Missing prefix." }], cannotProve: ["Omission after the last receipt.", "Identity requires independent key pinning."] });
    }
    if (p === "/v1/audit") return json(route, { entries: [], pageSize: 100, hasMore: false, nextCursor: null });
    if (p === "/v1/users") return json(route, { users: [] });
    if (p === "/v1/audit/retention") return json(route, { days: 365, oldestAt: null, count: 0 });
    return json(route, {});
  });
  await page.goto("/ui/admin/audit");
  await expect(page.getByText("Signed decision receipts", { exact: true })).toBeVisible();
  return calls;
}

for (const state of ["no_key", "off"] as const) test(`${state}: measured unsigned state and unavailable export`, async ({ page }) => {
  await setup(page, { state, lastSeq: 0, lagRows: 3 });
  await expect(page.getByText(state === "off" ? "Receipt signing is off." : "Unsigned: no receipt signing key is configured.")).toBeVisible();
  await expect(page.getByText("Last receipt sequence: 0. Decision rows awaiting signing: 3.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Export receipt bundle" })).toBeDisabled();
});
test("failed status never claims signing is configured", async ({ page }) => {
  await setup(page, undefined, true);
  await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(page.getByText("Receipt signing is configured.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export receipt bundle" })).toBeDisabled();
});
test("exports the chosen bounded range and displays verifier findings and limits", async ({ page }) => {
  const calls = await setup(page, { state: "signing", lastSeq: 8, lagRows: 1 });
  await page.getByLabel("First receipt sequence", { exact: true }).fill("3");
  await page.getByLabel("Last receipt sequence (blank = latest)").fill("6");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export receipt bundle" }).click();
  expect((await download).suggestedFilename()).toBe("decision-receipts-3-6.json");
  expect(calls.exports).toEqual(["?fromSeq=3&toSeq=6"]);
  await page.getByRole("button", { name: "Verify loaded receipt bundle" }).click();
  await expect(page.getByText("Receipt 1: invalid — Signature mismatch.")).toBeVisible();
  await expect(page.getByText("Receipt 2: unverifiable — Missing prefix.")).toBeVisible();
  await expect(page.getByText("Omission after the last receipt.")).toBeVisible();
  expect(calls.verifies).toHaveLength(1);
});
test("upload validation prevents stale bundle verification and rejects malformed/oversized inputs", async ({ page }) => {
  const calls = await setup(page);
  const input = page.getByLabel("Receipt bundle to verify");
  await input.setInputFiles({ name: "good.json", mimeType: "application/json", buffer: Buffer.from('{"verifier":"regulait.receipt.v1","receipts":[],"keys":[]}') });
  await expect(page.getByRole("button", { name: "Verify loaded receipt bundle" })).toBeEnabled();
  await input.setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{") });
  await expect(page.getByRole("alert")).toHaveText("This file is not valid JSON.");
  await expect(page.getByRole("button", { name: "Verify loaded receipt bundle" })).toBeDisabled();
  await input.setInputFiles({ name: "large.json", mimeType: "application/json", buffer: Buffer.alloc(5 * 1024 * 1024 + 1) });
  await expect(page.getByRole("alert")).toHaveText("Choose a receipt JSON file no larger than 5 MiB.");
  expect(calls.verifies).toEqual([]);
});
