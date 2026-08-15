/**
 * The ADR-0060 chain-integrity card, driven in the real SPA: an admin runs
 * verification on demand and reads the report with its honesty intact —
 * chain status, anchor source, and the observed (never configured) tamper
 * resistance. Without a MinIO in the stack the anchor source is the local
 * default and the card must say NOT tamper-resistant — the honest answer is
 * the assertion, not a compromise in it.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string };
};

test("admin verifies the audit chain from the UI and reads an honest anchor report", async ({ page }) => {
  // sign in as the seeded admin (one-time password → forced change)
  await page.goto("/ui");
  await page.getByLabel("Email").fill("admin@regulait.local");
  await page.getByLabel("Password", { exact: true }).fill(state.passwords.admin);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Your password is one-time")).toBeVisible();
  await page.getByLabel("Current (one-time) password").fill(state.passwords.admin);
  await page.getByLabel("New password", { exact: true }).fill("E2e-Audit-Admin-1!");
  await page.getByLabel("Confirm new password").fill("E2e-Audit-Admin-1!");
  await page.getByRole("button", { name: "Set password & continue" }).click();
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();

  await page.goto("/ui/admin/audit");
  await expect(page.getByText("Chain integrity", { exact: false })).toBeVisible();

  // verification is ON DEMAND — no report before the click
  await expect(page.getByTestId("chain-report")).toHaveCount(0);
  await page.getByRole("button", { name: "Verify chain" }).click();

  const report = page.getByTestId("chain-report");
  await expect(report).toBeVisible();
  // the seeded trail verifies clean
  await expect(report.getByText("chain ok")).toBeVisible();
  // no MinIO in this harness → the local/database anchor must be reported as
  // NOT tamper-resistant. If this ever shows "tamper-resistant (observed)"
  // without a WORM medium present, the observed-grading contract broke.
  await expect(report.getByText("NOT tamper-resistant")).toBeVisible();
  await expect(report.getByText(/anchor MISMATCH/)).toHaveCount(0);
});
