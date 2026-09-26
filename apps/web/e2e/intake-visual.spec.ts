/**
 * A LOOKING test for the guided intake (not an assertion suite).
 *
 * The dataviz skill's last procedural step is "render it and look at it" — a
 * validator checks colour, never layout. This walks the four stages and
 * captures each, plus an InfoButton open, so collisions, overflow and
 * dark-mode contrast are seen rather than assumed.
 */
import { expect, test } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  baseUrl: string;
};
const SHOTS = path.join(here, "screenshots");
mkdirSync(SHOTS, { recursive: true });

test("the guided intake, stage by stage", async ({ page }) => {
  const boot = { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" };
  const users = (await (await fetch(`${state.baseUrl}/v1/users`, { headers: boot })).json()) as {
    users: Array<{ id: string; email: string }>;
  };
  const adminId = users.users.find((u) => u.email === "admin@regulait.local")!.id;
  const minted = (await (
    await fetch(`${state.baseUrl}/v1/users/${adminId}/set-initial-password`, {
      method: "POST",
      headers: boot,
      body: JSON.stringify({ force: true }),
    })
  ).json()) as { password: string };

  const PW = "E2e-Intake-Visual!";
  await page.goto("/ui");
  await page.getByLabel("Email").fill("admin@regulait.local");
  await page.getByLabel("Password", { exact: true }).fill(minted.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Current (one-time) password").fill(minted.password);
  await page.getByLabel("New password", { exact: true }).fill(PW);
  await page.getByLabel("Confirm new password").fill(PW);
  await page.getByRole("button", { name: "Set password & continue" }).click();
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();

  await page.getByLabel("Filter navigation").fill("Use cases");
  await page.getByRole("link", { name: "Use cases", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Use cases", exact: true })).toBeVisible();

  const shot = (n: string) => page.screenshot({ path: path.join(SHOTS, `intake-${n}.png`), fullPage: true });

  // stage 1 — and the page subtitle is now one line, not a paragraph
  await shot("1-what-it-is");

  // the InfoButton that replaced the 60-word subtitle
  await page.getByRole("button", { name: /What is proposing a use case/ }).click();
  await expect(page.getByRole("note")).toBeVisible();
  await shot("1-info-open");
  await page.keyboard.press("Escape");

  await page.getByLabel("Name").fill("Summarize support tickets");
  await page.getByLabel("What it does").fill("Reads inbound tickets and drafts a summary for the queue.");
  await page.getByLabel("Why the business wants it").fill("Cuts first-response time on the support desk.");
  await page.getByRole("button", { name: "Continue" }).click();

  // stage 2 — the tag picker, including an unbound tag
  await expect(page.getByText("Compliance tags")).toBeVisible();
  const tagBox = page.locator("input[list]");
  await tagBox.fill("not-a-real-profile");
  await tagBox.press("Enter");
  await expect(page.getByText("unbound")).toBeVisible();
  await shot("2-data-and-risk");
  await page.getByRole("button", { name: /Remove tag not-a-real-profile/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();

  await shot("3-intended-use");
  await page.getByRole("button", { name: "Continue" }).click();

  // stage 4 — review
  await expect(page.getByText("Summarize support tickets")).toBeVisible();
  await shot("4-review");

  // and dark mode, which is where contrast mistakes actually show up
  await page.emulateMedia({ colorScheme: "dark" });
  await shot("4-review-dark");
});
