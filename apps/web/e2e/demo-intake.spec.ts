import { expect, test, type Browser, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(here, ".e2e-state.json");
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8")) as { baseUrl: string }
  : { baseUrl: process.env.E2E_BASE_URL ?? "http://127.0.0.1:4174" };
const SHOTS = path.join(here, "artifacts", "demo");
mkdirSync(SHOTS, { recursive: true });

async function freshUser(page: Page, email: string, password: string) {
  const headers = { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" };
  const users = await (await fetch(`${state.baseUrl}/v1/users`, { headers })).json() as { users: Array<{ id: string; email: string }> };
  const id = users.users.find((user) => user.email === email)?.id;
  expect(id, `seeded persona ${email} must exist`).toBeTruthy();
  const minted = await (await fetch(`${state.baseUrl}/v1/users/${id}/set-initial-password`, { method: "POST", headers, body: JSON.stringify({ force: true }) })).json() as { password: string };
  await page.goto("/ui");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(minted.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByLabel("Current (one-time) password").fill(minted.password);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Set password & continue" }).click();
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
}

async function shotBoth(page: Page, name: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((next) => { document.documentElement.dataset.theme = next; localStorage.setItem("regulait.theme", next); window.scrollTo(0, 0); }, theme);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), fullPage: true });
  }
}

async function openAvery(browser: Browser) {
  const page = await browser.newPage();
  await freshUser(page, "avery@regulait.local", "E2e-Demo-Avery!");
  return page;
}

test("seeded credit-assistant journey: discover, register, assess, approve, monitor, remediate", async ({ page, browser }) => {
  await freshUser(page, "admin@regulait.local", "E2e-Demo-Intake!");
  await page.goto("/ui/admin/shadow-ai");
  await expect(page.getByRole("heading", { name: "Shadow-AI discovery" })).toBeVisible();
  await shotBoth(page, "real-01-discover");

  await page.getByRole("link", { name: "Register as use case" }).first().click();
  await expect(page).toHaveURL(/\/ui\/admin\/governance\/intake\?source=shadow-ai/);
  await expect(page.getByText(/Prefilled only from shadow-AI record/)).toBeVisible();
  for (const [label, value] of [
    ["Primary purpose domain", "essential-services"],
    ["People affected", "customers"],
    ["Decision autonomy", "human-reviews"],
    ["Biometric use", "none"],
    ["Deployment audience", "customer-facing"],
  ] as const) await page.getByLabel(label).selectOption(value);
  await page.getByLabel("Sectors: financial-services").check();
  await page.getByLabel("Data categories: personal").check();
  await page.getByLabel("Data categories: financial").check();
  for (const [label, value] of [
    ["Emotion recognition", "no"],
    ["Social scoring", "no"],
    ["Manipulative techniques", "no"],
    ["Profiles natural persons", "yes"],
    ["Safety component", "no"],
    ["Interacts directly with people", "yes"],
    ["Generates synthetic content", "yes"],
    ["Has an EU nexus", "yes"],
    ["Can take autonomous actions", "no"],
    ["Uses an external AI vendor", "yes"],
  ] as const) await page.getByLabel(label).selectOption(value);
  await expect(page.getByRole("button", { name: "Draft suggestions" })).toBeEnabled();
  await page.getByRole("button", { name: "Draft suggestions" }).click();
  await expect(page.getByText(/Proposed tier:/)).toContainText("high");
  await shotBoth(page, "real-02-assist");
  await page.getByRole("button", { name: /Accept all remaining/ }).click();
  for (let step = 0; step < 3; step += 1) await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Submit for human review" }).click();
  const workspace = page.getByRole("link", { name: "Open the use-case workspace" });
  await expect(workspace).toBeVisible();
  // AER-042: the persisted record carries the derived sensitivity (personal + financial → regulated)
  const boot = { authorization: "Bearer e2e-bootstrap-token" };
  const listed = await (await fetch(`${state.baseUrl}/v1/use-cases`, { headers: boot })).json() as { useCases: Array<{ name: string; dataSensitivity: string }> };
  expect(listed.useCases.find((u) => u.name.startsWith("Govern "))?.dataSensitivity).toBe("regulated");
  await workspace.click();
  await expect(page.getByRole("tab", { name: "Risks" })).toBeVisible();
  await shotBoth(page, "real-03-use-case-360");

  await page.getByRole("tab", { name: "Risks" }).click();
  await expect(page.getByText("Add risk from library")).toBeVisible();
  await shotBoth(page, "real-04-risks-controls");

  const avery = await openAvery(browser);
  await avery.goto("/ui/inbox");
  await expect(avery.getByRole("heading", { name: "Inbox" })).toBeVisible();
  // THIS run's registration — routed to Avery, the independent governance approver
  // (demo:intake installs the intake template naming Avery), never to its proposer
  const signoff = avery.locator("div").filter({ hasText: /^Sign-off · signoff · AI use-case intake: Govern / }).filter({ has: avery.getByRole("button", { name: "Approve" }) }).last();
  await expect(signoff).toBeVisible();
  await shotBoth(avery, "real-05-avery-signoff");
  await signoff.getByRole("button", { name: "Approve" }).click();
  await expect(avery.getByText("Approved", { exact: true })).toBeVisible();
  await expect(avery.getByText("Recently decided")).toBeVisible();
  const afterSignoff = await (await fetch(`${state.baseUrl}/v1/use-cases`, { headers: boot })).json() as { useCases: Array<{ name: string; status: string }> };
  expect(afterSignoff.useCases.find((u) => u.name.startsWith("Govern "))?.status).toBe("approved");
  await shotBoth(avery, "real-05b-avery-approved");

  // 3A — the trust dashboard (evidence coverage), as the presenter shows it before the alerts
  await page.goto("/ui/admin/governance/trust");
  await expect(page.getByRole("heading", { name: "Trust & evidence" })).toBeVisible();
  await expect(page.getByText("Evidence coverage by dimension")).toBeVisible();
  await shotBoth(page, "real-05c-trust-dashboard");

  await page.goto("/ui/admin/governance/alerts");
  await expect(page.getByRole("heading", { name: "Governance alerts" })).toBeVisible();
  await page.getByRole("button", { name: "Evaluate now" }).click();
  await expect(page.getByRole("status")).toContainText("Evaluation raised");
  // the remediation beat needs an alert with an EXECUTABLE candidate — in the demo data that is an
  // unowned-agent alert (assign an owner); the high alerts carry guidance only
  const alert = page.locator("button").filter({ hasText: /which is unowned/ }).first();
  await expect(alert).toBeVisible();
  await alert.click();
  await page.getByLabel("Acknowledgement note — required and audited").fill("Ada owns the response and is escalating the evidence-backed remediation.");
  await page.getByRole("button", { name: "Acknowledge", exact: true }).click();
  await expect(page.getByText(/Acknowledgement note: Ada owns the response/)).toBeVisible();
  await shotBoth(page, "real-06-alert-acknowledged");

  const approver = page.getByLabel("Independent approver").first();
  await expect(approver).toBeVisible();
  await approver.selectOption({ label: "Avery Approver" });
  await page.getByRole("button", { name: "Propose…" }).first().click();
  await expect(page.getByText("pending approval", { exact: true })).toBeVisible();
  await shotBoth(page, "real-07-remediation-proposed");

  await avery.goto("/ui/inbox");
  // the innermost row whose text STARTS with the label (outer wrappers also contain it)
  const remediation = avery.locator("div").filter({ hasText: /^Governance remediation/ }).filter({ has: avery.getByRole("button", { name: "Approve" }) }).last();
  await expect(remediation).toBeVisible();
  await remediation.getByRole("button", { name: "Approve" }).click();
  await expect(avery.getByText("Approved", { exact: true })).toBeVisible();
  await shotBoth(avery, "real-08-remediation-approved");
  await avery.close();

  await page.goto("/ui/admin/governance/graph");
  await expect(page.getByRole("heading", { name: "AI dependency graph" })).toBeVisible();
  await expect(page.getByText("Nodes", { exact: true })).toBeVisible();
  await shotBoth(page, "real-09-dependency-graph");

  await page.goto("/ui/admin/governance/regulatory");
  await expect(page.getByRole("heading", { name: "Regulatory & policy intelligence" })).toBeVisible();
  await expect(page.getByText("in force", { exact: true }).first()).toBeVisible();
  await shotBoth(page, "real-10-regulatory-intelligence");

  await page.goto("/ui/admin/audit");
  await expect(page.getByRole("button", { name: "Download signed bundle" })).toBeVisible();
  await shotBoth(page, "real-11-signed-audit-export");
});
