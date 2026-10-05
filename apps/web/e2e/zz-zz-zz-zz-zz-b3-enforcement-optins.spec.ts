/**
 * Batch B3 — the three enforcement opt-ins in the real SPA, all DEFAULT-OFF:
 *
 *  1. the ADR-0080 use-case dispatch gate knob on Settings → Organization
 *     (renders 'off', saves 'warn' through the audited PUT, and is restored
 *     to 'off' so no later run inherits an armed gate);
 *  2. the ADR-0086 staleness-forces-recertification controls on Model risk
 *     (rendered OFF with threshold 1 — read-only assertions, no writes);
 *  3. the ADR-0089 intent-capture field on a use case's detail (editable
 *     while in flight, feeding the intendedAgentIds column the alignment
 *     comparison reads).
 *
 * This spec WRITES (an org-settings save it reverts, plus one b3e2e-prefixed
 * use case), so it runs LAST (sorts after zz-zz-zz-zz-*, M-018) and signs in
 * with the order-independent helper the other zz- specs use (M-017).
 */
import { expect, test, type Page } from "@playwright/test";
import { passTotp } from "./totp-sign-in";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string };
};

/** the password every admin spec in this suite settles on */
const ADMIN_PASSWORD = "E2e-Admin-Phase2!";

/**
 * Order-independent sign-in, copied from the phase4-7 / zz- specs. The suite
 * shares ONE seeded database, so the seeded one-time password is consumed by
 * whichever spec runs first; trying the candidates in turn and settling on
 * the SHARED password keeps every spec runnable in any order.
 */
async function signIn(page: Page, email: string, candidates: string[], settleOn: string) {
  for (const [i, password] of candidates.entries()) {
    await page.goto("/ui");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    const welcome = page.getByRole("heading", { name: /Welcome back/ });
    const forcedChange = page.getByText("Your password is one-time");
    const rejected = page.getByText(/password is incorrect/);
    await passTotp(page, email, welcome.or(forcedChange).or(rejected));

    if (await welcome.isVisible()) return password;
    if (await forcedChange.isVisible()) {
      await page.getByLabel("Current (one-time) password").fill(password);
      await page.getByLabel("New password", { exact: true }).fill(settleOn);
      await page.getByLabel("Confirm new password").fill(settleOn);
      await page.getByRole("button", { name: "Set password & continue" }).click();
      await passTotp(page, email, welcome);
      return settleOn;
    }
    expect(i, `no candidate password worked for admin`).toBeLessThan(candidates.length - 1);
  }
  throw new Error("could not sign in as admin");
}

/**
 * A proposed use case to capture intent on. ADR-0168 made the intake wizard
 * the only UI way in; this spec is about what happens AFTER the proposal, so
 * it creates the record through the API the wizard itself calls (the session
 * cookie and CSRF header of the signed-in admin).
 */
async function proposeUseCase(page: Page, f: { name: string; what: string; why: string }) {
  const res = await page.request.post("/v1/use-cases", {
    headers: { "x-regulait-csrf": "1" },
    data: { name: f.name, description: f.what, businessContext: f.why, dataSensitivity: "internal", complianceTags: [], intendedAgentIds: [] },
  });
  expect(res.status(), await res.text()).toBe(201);
}

test("the use-case gate knob ships OFF, saves through the audited PUT, and is restored", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/organization");
  await expect(page.getByRole("heading", { name: "Organization", exact: true })).toBeVisible();
  await expect(page.getByText("5b · AI use-case dispatch gate (ADR-0080)")).toBeVisible();
  const knob = page.getByLabel("Use-case dispatch gate");
  // DEFAULT-OFF is the safety argument, asserted on the real form
  await expect(knob).toHaveValue("off");

  // warn, saved through the audited PUT
  await knob.selectOption("warn");
  const savedWarn = page.waitForResponse(
    (r) => r.url().includes("/v1/org/settings") && r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save use-case gate" }).click();
  expect((await savedWarn).status()).toBe(200);
  await expect(page.getByText("Use-case gate saved (audited)").first()).toBeVisible();

  // RESTORE (M-012 in e2e form): later runs must not inherit an armed gate
  await knob.selectOption("off");
  const savedOff = page.waitForResponse(
    (r) => r.url().includes("/v1/org/settings") && r.request().method() === "PUT",
  );
  await page.getByRole("button", { name: "Save use-case gate" }).click();
  expect((await savedOff).status()).toBe(200);
  await expect(knob).toHaveValue("off");
});

test("the staleness-recertification controls render OFF with threshold 1 on Model risk", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/model-risk");
  await expect(page.getByRole("heading", { name: "Model risk", exact: true })).toBeVisible();
  await expect(page.getByLabel("Staleness forces recertification")).toHaveValue("off");
  await expect(
    page.getByLabel("Drift threshold (ledger changes since certification)"),
  ).toHaveValue("1");
  await expect(page.getByText(/deepens that gate, it creates none of its own/)).toBeVisible();
});

test("intent capture: a proposed use case's intended agents are editable in flight and feed the alignment comparison", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  // propose without any intent — the exact "no intent recorded" state
  await proposeUseCase(page, {
    name: "b3e2e-intent-capture",
    what: "prove intent is captured in flight",
    why: "close the ADR-0089 capture half",
  });

  await page.goto("/ui/admin/use-cases");
  await expect(page.getByRole("heading", { name: "AI registry", exact: true })).toBeVisible();
  // open the registry preview: the capture section is there and editable pre-decision
  await page.getByLabel("Search use cases").fill("b3e2e-intent-capture");
  await page.getByRole("link", { name: /^b3e2e-intent-capture,/ }).click();
  const preview = page.getByRole("dialog", { name: "b3e2e-intent-capture" });
  await expect(preview).toBeVisible();
  await expect(preview.getByText("Intended agents", { exact: true })).toBeVisible();
  // undecided intent is honestly "Not approved", never a guessed alignment
  await expect(preview.getByText("Not approved", { exact: true })).toBeVisible();

  const picker = preview.getByLabel("Intended agents (ctrl/cmd-click to select several)");
  await expect(picker).toBeVisible();
  // capture the first registered agent as the intent
  const firstAgent = await picker.locator("option").first().getAttribute("value");
  expect(firstAgent).toBeTruthy();
  await picker.selectOption(firstAgent!);
  const patched = page.waitForResponse(
    (r) => r.url().includes("/v1/use-cases/") && r.request().method() === "PATCH",
  );
  await preview.getByRole("button", { name: "Save intended agents" }).click();
  expect((await patched).status()).toBe(200);
  await expect(
    page.getByText("Intended agents captured — the alignment comparison reads exactly this list"),
  ).toBeVisible();
});
