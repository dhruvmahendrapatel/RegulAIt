/**
 * ADR-0124 — the execution-control page, driven the way an operator would.
 *
 * WHY AN E2E AND NOT JUST A UNIT TEST. Everything about this page is about
 * whether a human can use it under pressure: that the current state is
 * readable, that the dangerous action asks for a reason before it does
 * anything, that a terse reason is refused while the box is still open, and
 * that lifting works. A typecheck proves none of that, and the gateway tests
 * prove the API rather than the page.
 *
 * WHAT IT ASSERTS, IN THE ORDER AN INCIDENT HAPPENS:
 *
 *  1. The page loads clean and says nothing is stopped.
 *  2. Halting a single tool takes a reason, and a terse reason is REFUSED in
 *     the modal — the server also enforces this, and being told after the
 *     round trip is the wrong moment.
 *  3. The halt then shows up in "Right now", with its reason and its clock.
 *  4. The deployment dial goes to halted, and the page still renders — a
 *     control surface that dies with the thing it controls is not a control
 *     surface.
 *  5. Both are lifted, and the page returns to "nothing is stopped".
 *
 * Every step asserts ZERO console errors, like every other spec here.
 */
import { expect, test, type Page } from "@playwright/test";
import { passTotp } from "./totp-sign-in";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string; dana: string; avery: string };
  baseUrl: string;
};
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(here, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const ADMIN_PASSWORD = "E2e-Admin-Execution!";

function trackConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (/Failed to load resource.*(400|401|403|409)/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return {
    assertClean(label: string) {
      expect(errors, `console must be clean after: ${label}`).toEqual([]);
    },
  };
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

test.describe.configure({ mode: "serial" });

let page: Page;
let track: ReturnType<typeof trackConsole>;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  track = trackConsole(page);

  // own our sign-in rather than borrowing the seeded one-time password, which
  // whichever spec runs first consumes
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

  await page.goto("/ui");
  await page.getByLabel("Email").fill("admin@regulait.local");
  await page.getByLabel("Password", { exact: true }).fill(minted.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // ADR-0181: the admin answers the TOTP challenge (or enrols, below)
  await passTotp(page, "admin@regulait.local", page.getByLabel("Current (one-time) password"));
  await page.getByLabel("Current (one-time) password").fill(minted.password);
  await page.getByLabel("New password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel("Confirm new password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Set password & continue" }).click();
  await passTotp(page, "admin@regulait.local", page.getByRole("heading", { name: /Welcome back/ }));
});

test.afterAll(async () => {
  await page.close();
});

async function openExecutionControl() {
  await page.getByLabel("Filter navigation").fill("Execution control");
  await page.getByRole("link", { name: "Execution control", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Execution control", exact: true })).toBeVisible();
}

test("1: the page loads and says, plainly, that nothing is stopped", async () => {
  await openExecutionControl();
  await expect(page.getByText("Nothing is stopped.")).toBeVisible();
  // the four positions are all offered, with what each one does
  for (const label of ["Normal", "Read-only", "Require approval", "Halt everything"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // and the page says what SURVIVES a halt — the hesitation problem
  await expect(page.getByText(/never gated by it|approvals queue/)).toBeVisible();
  await shot(page, "execution-control-normal");
  track.assertClean("page load");
});

test("2+3: halting one tool asks for a reason, refuses a terse one, then shows it", async () => {
  await openExecutionControl();

  // the seeded repo-tools server and one of its write tools
  await page.getByLabel("Server", { exact: true }).selectOption({ label: "repo-tools" });
  await page.getByLabel("Tool to halt").selectOption({ label: "write_file (write)" });
  await page.getByRole("button", { name: "Halt tool" }).click();

  // the modal explains the blast radius BEFORE anything happens
  const modal = page.getByRole("dialog");
  await expect(modal.getByText(/Every call to this tool will be refused/)).toBeVisible();

  // a terse reason is refused in the modal — not after the round trip
  await page.getByLabel("Reason").fill("bad");
  await page.getByRole("button", { name: "Halt tool" }).last().click();
  await expect(page.getByText(/Say a little more/)).toBeVisible();

  // a real one goes through
  await page.getByLabel("Reason").fill("vendor advisory VA-2026-11 — tool returns injected content");
  await page.getByRole("button", { name: "Halt tool" }).last().click();

  // and the page now leads with it
  await expect(page.getByText(/1 tool\(s\) halted/)).toBeVisible();
  await expect(page.getByText("Halted tools", { exact: true })).toBeVisible();
  await expect(page.getByText(/vendor advisory VA-2026-11/)).toBeVisible();
  await shot(page, "execution-control-tool-halted");
  track.assertClean("halt one tool");
});

test("4: the deployment dial halts, and the control surface still works", async () => {
  await openExecutionControl();
  await page
    .getByRole("row", { name: /Halt everything/ })
    .getByRole("button", { name: "Switch" })
    .click();
  await expect(
    page.getByRole("dialog").getByText(/Every governed call is refused/),
  ).toBeVisible();
  await page
    .getByLabel("Reason")
    .fill("suspected prompt-injection campaign across the estate, containing");
  await page.getByRole("button", { name: "Halt everything" }).last().click();

  // THE ASSERTION THAT MATTERS: the page that controls the halt survives it.
  await expect(page.getByText(/the deployment is in halted mode/)).toBeVisible();
  await expect(page.getByText(/suspected prompt-injection campaign/)).toBeVisible();
  await shot(page, "execution-control-halted");
  track.assertClean("halt the deployment");

  // and a reload — the real test of "can I still get to this page?"
  await page.reload();
  await expect(page.getByRole("heading", { name: "Execution control", exact: true })).toBeVisible();
  await expect(page.getByText(/halted/).first()).toBeVisible();
  track.assertClean("reload while halted");
});

test("5: both are lifted, and the page returns to nothing stopped", async () => {
  await openExecutionControl();

  await page.getByRole("row", { name: /Normal/ }).getByRole("button", { name: "Resume" }).click();
  await expect(
    page.getByRole("dialog").getByText(/record of why it was safe to resume/),
  ).toBeVisible();
  await page.getByLabel("Reason").fill("campaign contained, upstream patched, resuming service");
  await page.getByRole("button", { name: "Resume" }).last().click();

  await page.getByRole("row", { name: /write_file/ }).getByRole("button", { name: "Lift" }).click();
  await page.getByLabel("Reason").fill("advisory withdrawn, tool retested clean");
  await page.getByRole("button", { name: "Lift halt" }).last().click();

  await expect(page.getByText("Nothing is stopped.")).toBeVisible();
  await shot(page, "execution-control-restored");
  track.assertClean("lift everything");
});
