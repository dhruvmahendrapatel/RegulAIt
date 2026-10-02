import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as { baseUrl: string };
const SHOTS = path.join(here, "artifacts", "demo");
mkdirSync(SHOTS, { recursive: true });

async function freshAdmin(page: Page) {
  const headers = { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" };
  const users = await (await fetch(`${state.baseUrl}/v1/users`, { headers })).json() as { users: Array<{ id: string; email: string }> };
  const id = users.users.find((user) => user.email === "admin@regulait.local")!.id;
  const minted = await (await fetch(`${state.baseUrl}/v1/users/${id}/set-initial-password`, { method: "POST", headers, body: JSON.stringify({ force: true }) })).json() as { password: string };
  await page.goto("/ui");
  await page.getByLabel("Email").fill("admin@regulait.local");
  await page.getByLabel("Password", { exact: true }).fill(minted.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Current (one-time) password").fill(minted.password);
  await page.getByLabel("New password", { exact: true }).fill("E2e-Demo-Intake!");
  await page.getByLabel("Confirm new password").fill("E2e-Demo-Intake!");
  await page.getByRole("button", { name: "Set password & continue" }).click();
}

async function shotBoth(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((next) => { document.documentElement.dataset.theme = next; localStorage.setItem("regulait.theme", next); window.scrollTo(0, 0); }, theme);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), fullPage: true });
  }
}

test("seeded credit-assistant journey: discover, register, assess, approve, monitor, export", async ({ page }) => {
  await freshAdmin(page);
  await page.goto("/ui/admin/shadow-ai");
  await expect(page.getByRole("heading", { name: "Shadow-AI discovery" })).toBeVisible();
  await shotBoth(page, "real-01-discover");

  await page.goto("/ui/admin/governance/intake");
  await page.getByRole("button", { name: "Draft suggestions" }).click();
  await expect(page.getByText(/Proposed tier:/)).toContainText("high");
  await shotBoth(page, "real-02-assist");
  for (let step = 0; step < 3; step += 1) await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Submit for human review" }).click();
  const workspace = page.getByRole("link", { name: "Open the use-case workspace" });
  await expect(workspace).toBeVisible();
  await workspace.click();
  await expect(page.getByRole("tab", { name: "Risks" })).toBeVisible();
  await shotBoth(page, "real-03-use-case-360");

  await page.getByRole("tab", { name: "Risks" }).click();
  await expect(page.getByText("Add risk from library")).toBeVisible();
  await shotBoth(page, "real-04-risks-controls");

  await page.goto("/ui/admin/approvals");
  await expect(page.getByRole("heading", { name: /Approvals/ })).toBeVisible();
  await shotBoth(page, "real-05-approval-queue");

  await page.goto("/ui/admin/governance/trust");
  await expect(page.getByRole("heading", { name: "Trust & evidence" })).toBeVisible();
  await shotBoth(page, "real-06-monitor");

  await page.goto("/ui/admin/governance/regulatory");
  await expect(page.getByRole("heading", { name: "Regulatory & policy intelligence" })).toBeVisible();
  await shotBoth(page, "real-06b-regulatory-intelligence");

  await page.goto("/ui/admin/audit");
  await expect(page.getByRole("button", { name: "Download signed bundle" })).toBeVisible();
  await shotBoth(page, "real-07-signed-audit-export");
});
