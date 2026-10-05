import { expect, test, type Browser, type Page } from "@playwright/test";
import { passTotp } from "./totp-sign-in";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const stateFile = path.join(here, ".e2e-state.json");
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, "utf8")) as { baseUrl: string }
  : { baseUrl: process.env.E2E_BASE_URL ?? "http://127.0.0.1:4174" };
const SHOTS = path.join(here, "artifacts", "demo");
// DEMO-01: the live gateway's token never has to be the public one — export
// REGULAIT_BOOTSTRAP_TOKEN with whatever the gateway was started with.
const BOOT_TOKEN = process.env.REGULAIT_BOOTSTRAP_TOKEN ?? "e2e-bootstrap-token";
mkdirSync(SHOTS, { recursive: true });

async function freshUser(page: Page, email: string, password: string) {
  const headers = { authorization: `Bearer ${BOOT_TOKEN}`, "content-type": "application/json" };
  const users = await (await fetch(`${state.baseUrl}/v1/users`, { headers })).json() as { users: Array<{ id: string; email: string }> };
  const id = users.users.find((user) => user.email === email)?.id;
  expect(id, `seeded persona ${email} must exist`).toBeTruthy();
  const minted = await (await fetch(`${state.baseUrl}/v1/users/${id}/set-initial-password`, { method: "POST", headers, body: JSON.stringify({ force: true }) })).json() as { password: string };
  await page.goto("/ui");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(minted.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // ADR-0181: an admin who already enrolled answers the TOTP challenge first
  await passTotp(page, email, page.getByLabel("Current (one-time) password"));
  await page.getByLabel("Current (one-time) password").fill(minted.password);
  await page.getByLabel("New password", { exact: true }).fill(password);
  await page.getByLabel("Confirm new password").fill(password);
  await page.getByRole("button", { name: "Set password & continue" }).click();
  // ...and an admin who has not enrols now, from the secret on screen
  await passTotp(page, email, page.getByRole("heading", { name: /Welcome back/ }));
}

async function shotBoth(page: Page, name: string) {
  // Screenshots only — never an assertion. Let transient toasts leave first so
  // they do not sit on top of the content a slide is about (they auto-dismiss
  // after ~4s); if one is still up after the wait, shoot anyway.
  await page
    .waitForFunction(
      () => !Array.from(document.querySelectorAll('[aria-live="polite"]')).some((el) => getComputedStyle(el).position === "fixed" && el.childElementCount > 0),
      null,
      // capped just above a toast's ~3.8s life: 15 shots must stay well inside the 180s test
      { timeout: 4_000 },
    )
    .catch(() => undefined);
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate((next) => { document.documentElement.dataset.theme = next; localStorage.setItem("regulait.theme", next); window.scrollTo(0, 0); }, theme);
    // let colour transitions finish so a shot never catches a half-switched theme
    await page.waitForTimeout(300);
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
  await expect(page.getByText(/Prefilled from a shadow-AI finding/)).toBeVisible();
  // ADR-0168: Describe (name, purpose — prefilled) and Classify are separate steps
  await page.getByRole("button", { name: "Continue" }).click();
  for (const [label, value] of [
    ["Primary purpose domain", "essential-services"],
    ["People affected", "customers"],
    ["Decision autonomy", "human-reviews"],
    ["Biometric use", "none"],
    ["Deployment audience", "customer-facing"],
  ] as const) await page.getByLabel(label).selectOption(value);
  await page.getByLabel("Sectors: Financial services", { exact: true }).check();
  await page.getByLabel("Data categories: Personal", { exact: true }).check();
  await page.getByLabel("Data categories: Financial", { exact: true }).check();
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
  for (let step = 0; step < 2; step += 1) await page.getByRole("button", { name: "Continue" }).click();
  // the stack step: the agent and vendor the shadow evidence pointed at (Anthropic usage)
  await page.getByLabel("Model / agent").selectOption({ label: "claude-opus · anthropic/claude-opus-5" });
  await page.getByLabel("Vendor").selectOption({ label: "Anthropic · approved" });
  await page.getByRole("button", { name: "Continue" }).click();
    await page.getByRole("button", { name: "Submit for human review" }).click();
  const workspace = page.getByRole("link", { name: "Open the use-case workspace" });
  await expect(workspace).toBeVisible();
  // AER-042: the persisted record carries the derived sensitivity (personal + financial → regulated)
  const boot = { authorization: `Bearer ${BOOT_TOKEN}` };
  const listed = await (await fetch(`${state.baseUrl}/v1/use-cases`, { headers: boot })).json() as { useCases: Array<{ name: string; dataSensitivity: string }> };
  expect(listed.useCases.find((u) => u.name.startsWith("Govern "))?.dataSensitivity).toBe("regulated");
  await workspace.click();
  await expect(page.getByRole("tab", { name: "Risks" })).toBeVisible();
  await shotBoth(page, "real-03-use-case-360");
  // 2A.1 — the Stack tab shows the linked agent's card; Dependencies shows the chain to its vendor
  await page.getByRole("tab", { name: "Stack" }).click();
  await expect(page.getByText("claude-opus").first()).toBeVisible();
  await shotBoth(page, "real-03b-stack");
  await page.getByRole("tab", { name: "Dependencies" }).click();
  await expect(page.getByRole("img", { name: "AI dependency and propagated risk graph" })).toBeVisible();
  await shotBoth(page, "real-03c-dependencies");

  await page.getByRole("tab", { name: "Risks" }).click();
  await expect(page.getByText("Add risk from library")).toBeVisible();
  await shotBoth(page, "real-04-risks-controls");

  const avery = await openAvery(browser);
  await avery.goto("/ui/inbox");
  await expect(avery.getByRole("heading", { name: "Inbox" })).toBeVisible();
  // THIS run's registration — routed to Avery, the independent governance approver
  // (demo:intake installs the intake template naming Avery), never to its proposer
  // ADR-0168: the sign-off is a review task — the drawer carries the evidence and the decision
  await avery.getByRole("button", { name: /^Review sign-off for Govern / }).last().click();
  const review = avery.getByRole("dialog", { name: "Review use case sign-off" });
  await expect(review).toBeVisible();
  await expect(review.getByText(/high/i).first()).toBeVisible();
  await shotBoth(avery, "real-05-avery-signoff");
  // approve with one BEFORE-go-live condition: the deploy gate holds until it is met
  await review.getByRole("radio", { name: "Approve with conditions" }).check();
  const condition = review.getByRole("group", { name: "Condition 1" });
  await condition.getByLabel("Condition", { exact: true }).fill("Approve the claude-opus model card before go-live");
  const ownerSelect = condition.getByLabel("Owner");
  const adaOption = await ownerSelect.locator("option").filter({ hasText: /Ada|Admin/ }).first().getAttribute("value");
  await ownerSelect.selectOption(adaOption ?? "");
  const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
  await condition.getByLabel("Due date").fill(due);
  await condition.getByLabel("Applies").selectOption({ label: "Before go-live (holds deployment)" });
  await shotBoth(avery, "real-05a-avery-conditions");
  await review.getByRole("button", { name: "Approve with conditions" }).click();
  await expect(avery.getByText("Approved with conditions", { exact: true }).first()).toBeVisible();
  await expect(avery.getByText("Recently decided")).toBeVisible();
  const afterSignoff = await (await fetch(`${state.baseUrl}/v1/use-cases`, { headers: boot })).json() as { useCases: Array<{ id: string; name: string; status: string; approvedUntil: string | null; openConditions: number }> };
  const approved = afterSignoff.useCases.find((u) => u.name.startsWith("Govern "));
  expect(approved?.status).toBe("approved");
  // high tier → the approval is valid for six months, and one before-go-live condition is open
  expect(approved?.approvedUntil).toBeTruthy();
  const months = (Date.parse(approved!.approvedUntil!) - Date.now()) / (30 * 86_400_000);
  expect(months).toBeGreaterThan(5.5);
  expect(months).toBeLessThan(6.5);
  expect(approved?.openConditions).toBe(1);
  await shotBoth(avery, "real-05b-avery-approved");
  // back in Profile A: the record says the approval stands, with a condition holding deployment
  await page.goto(`/ui/admin/governance/use-cases/${approved!.id}`);
  await expect(page.getByText(/1 before-go-live condition open/)).toBeVisible();

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
  await expect(page.getByText("In force", { exact: true }).first()).toBeVisible();
  await shotBoth(page, "real-10-regulatory-intelligence");

  await page.goto("/ui/admin/audit");
  await expect(page.getByRole("button", { name: "Download signed bundle" })).toBeVisible();
  await shotBoth(page, "real-11-signed-audit-export");
  // 3E — the bundle actually downloads (a keyless deployment answers 409 here: AER-008 / demo:export-key)
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download signed bundle" }).click();
  const bundle = await download;
  expect(bundle.suggestedFilename()).toMatch(/\.tar\.gz$/);
  expect(readFileSync(await bundle.path()).subarray(0, 2).toString("hex")).toBe("1f8b"); // gzip magic
});
