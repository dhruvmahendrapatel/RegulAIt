/**
 * The deploy-override separation-of-duties UI (ADR-0022 amendment,
 * 2026-08-13), driven end-to-end in the REAL SPA against the REAL gateway.
 *
 * The backend refuses an INITIATOR clearing their own parked deploy without a
 * recorded reason (400 deploy_override_reason_required). This spec proves the
 * UI carries that contract rather than tripping over it:
 *   · the deploy-hold card shows the REQUIRED-reason copy to the initiator;
 *   · the button is disabled while the reason is empty (no doomed request);
 *   · typing a reason enables it, the override lands, the instance advances.
 *
 * Setup is API-side (bootstrap token, Ada stepped up for the one-time password,
 * and the initiator's own key), because the
 * subject under test is the deploy-hold card, not the workflow authoring UI.
 */
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asSteppedUpAdmin } from "./admin-api";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  baseUrl: string;
  passwords: { admin: string };
};
const SHOTS = process.env.E2E_SHOTS_DIR ?? path.join(here, "screenshots");
mkdirSync(SHOTS, { recursive: true });

const BOOT_AUTH = { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" };
const IDA_EMAIL = "ovr-ida@example.com";
const IDA_PASSWORD = "E2e-Ovr-Ida-1!";

async function api<T = Record<string, unknown>>(
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = BOOT_AUTH,
): Promise<{ status: number; json: T }> {
  const res = await fetch(`${state.baseUrl}${url}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, json };
}

let instanceId: string;
let oneTimePassword: string;

test.describe.configure({ mode: "serial" });

let page: Page;
const consoleErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  // Ada's API sign-in and the step-up each spend a TOTP step (may wait a 30 s window)
  test.setTimeout(120_000);
  // --- the initiator persona ---
  const user = await api<{ id: string }>("POST", "/v1/users", {
    email: IDA_EMAIL,
    displayName: "Ovr Ida",
  });
  expect(user.status).toBe(201);
  const idaId = user.json.id;
  // B4S-06: issuing someone else's one-time password is a settings_relax
  // step-up, which the bootstrap credential no longer gives once Ada can step
  // up — Ada issues it, stepped up with her authenticator
  const otp = await asSteppedUpAdmin(state.baseUrl, state.passwords.admin, "POST", `/v1/users/${idaId}/set-initial-password`, {});
  expect(otp.status(), otp.bodyText).toBe(200);
  oneTimePassword = (JSON.parse(otp.bodyText) as { password: string }).password;
  const key = await api<{ token: string }>("POST", `/v1/users/${idaId}/keys`, { name: "ovr" });
  const idaAuth = { authorization: `Bearer ${key.json.token}`, "content-type": "application/json" };

  // --- a template whose deploy stage parks (target does not exist) ---
  const tpl = await api<{ id: string }>("POST", "/v1/workflows/templates", {
    name: "ovr-e2e-deploy",
    definition: {
      workflow: "ovr-e2e-deploy",
      stages: [
        { id: "intake", type: "trigger" },
        { id: "signoff", type: "human_approval", approvers: ["requesting_user"] },
        { id: "deploy", type: "deployment", connection: "ovr-nonexistent-target" },
      ],
    },
  });
  expect(tpl.status).toBe(201);
  const rule = await api("POST", "/v1/workflows/assignment-rules", {
    templateId: tpl.json.id,
    changeType: "ovr-e2e",
  });
  expect(rule.status).toBe(201);

  // --- ida starts her own change and signs off (self-review, reason given) ---
  const started = await api<{ id: string }>(
    "POST",
    "/v1/workflows/instances",
    {
      change: {
        description: "ida's change, parked at deploy",
        paths: ["src/ovr.ts"],
        changeType: "ovr-e2e",
        environment: "staging",
      },
    },
    idaAuth,
  );
  expect(started.status).toBe(201);
  instanceId = started.json.id;

  const inbox = await api<{ approvals: Array<{ id: string; instanceId: string | null; status: string }> }>(
    "GET",
    "/v1/approvals?status=pending",
    undefined,
    idaAuth,
  );
  const gate = inbox.json.approvals.find((a) => a.instanceId === instanceId);
  expect(gate, "the self sign-off must be in ida's inbox").toBeTruthy();
  const decided = await api(
    "POST",
    `/v1/approvals/${gate!.id}/decide`,
    { decision: "approved", reason: "e2e: solo persona, self sign-off is the scenario under test" },
    idaAuth,
  );
  expect(decided.status).toBe(200);

  // the deploy stage must now be parked
  const view = await api<{ instance: { status: string } }>(
    "GET",
    `/v1/workflows/instances/${instanceId}`,
    undefined,
    idaAuth,
  );
  expect(view.json.instance.status).toBe("blocked_on_deploy");

  // --- browser session as ida ---
  page = await browser.newPage();
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (/Failed to load resource.*(400|401|403|409)/.test(msg.text())) return;
    consoleErrors.push(`console.error: ${msg.text()}`);
  });
  await page.goto("/ui");
  await page.getByLabel("Email").fill(IDA_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(oneTimePassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Your password is one-time")).toBeVisible();
  await page.getByLabel("Current (one-time) password").fill(oneTimePassword);
  await page.getByLabel("New password", { exact: true }).fill(IDA_PASSWORD);
  await page.getByLabel("Confirm new password").fill(IDA_PASSWORD);
  await page.getByRole("button", { name: "Set password & continue" }).click();
  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
});

test.afterAll(async () => {
  await page?.close();
});

test("the initiator sees the required-reason copy and a disabled button", async () => {
  await page.goto(`/ui/workflows/${instanceId}`);
  await expect(page.getByText("deploy on hold")).toBeVisible();
  // the self-attestation variant of the copy, not the optional one
  await expect(page.getByText(/You initiated this change/, { exact: false })).toBeVisible();
  const button = page.getByRole("button", { name: "Mark deployed & continue" });
  await expect(button).toBeDisabled();
  await page.screenshot({ path: path.join(SHOTS, "deploy-override-01-required.png"), fullPage: true });
});

test("a recorded reason enables the button and the override advances the instance", async () => {
  await page
    .getByPlaceholder(/shipped by hand/)
    .fill("e2e: released manually from the runbook; ticket OPS-E2E-1");
  const button = page.getByRole("button", { name: "Mark deployed & continue" });
  await expect(button).toBeEnabled();
  await button.click();
  // past the deploy stage: the instance leaves blocked_on_deploy
  await expect(page.getByText("deploy on hold")).toHaveCount(0);
  await page.screenshot({ path: path.join(SHOTS, "deploy-override-02-advanced.png"), fullPage: true });
  // the gateway recorded the attested override with selfAttested on it
  const audit = await api<{ entries: Array<{ ruleId: string; detail: { selfAttested?: boolean } | null }> }>(
    "GET",
    `/v1/audit?limit=200`,
  );
  const attested = audit.json.entries.find((e) => e.ruleId === "workflow:deploy-override-attested");
  expect(attested, "the attested audit row must exist").toBeTruthy();
  expect(attested!.detail?.selfAttested).toBe(true);
  expect(consoleErrors, "console must be clean").toEqual([]);
});
