/**
 * ADR-0088 in the real SPA — an external scorer registered, tested against a
 * REAL local scoring endpoint (started by this spec, speaking OUR contract),
 * enabled, and disclosed on the Evaluations page:
 *
 *  - the register → test → enable lifecycle is driven through the UI, with
 *    the "never tested" → "tested — enable it" → "enabled" states visible;
 *  - the disclosure ("the vendor's opinion", "does not validate the
 *    instrument") is in the DOM on BOTH surfaces — the registration page and
 *    the Evaluations scorer registry — not in a doc;
 *  - the egress posture is real: the spec must allow-list 127.0.0.1 (private
 *    ranges + plaintext) before the gateway will touch the endpoint, exactly
 *    the sequence an operator performs for an on-prem scoring shim.
 *
 * This spec WRITES (an allow-list entry, a scorer), so it runs LAST (zz-
 * prefix, M-018) and creates only zz-e2e-prefixed objects nothing earlier
 * asserts about. Sign-in is the order-independent helper (M-017).
 */
import { expect, test, type Page } from "@playwright/test";
import { passTotp } from "./totp-sign-in";
import http from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string };
};

const ADMIN_PASSWORD = "E2e-Admin-Phase2!";
const CSRF = { "x-regulait-csrf": "1" };
const SCORER = "zz-e2e-scorer";

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

let srv: http.Server;
let port: number;

test.beforeAll(async () => {
  // a REAL local endpoint speaking the ADR-0088 contract — the gateway (same
  // host) will fetch it through the egress guard once 127.0.0.1 is allowed
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ score: 0.5, reasons: ["e2e probe scored by the local shim"] }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  port = (srv.address() as { port: number }).port;
});

test.afterAll(async () => {
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
});

test("an external scorer is registered, tested against a real endpoint, enabled, and disclosed", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  // the operator's egress act: allow 127.0.0.1 with private ranges + plaintext
  const allow = await page.request.post("/v1/egress-allow-hosts", {
    headers: CSRF,
    data: {
      host: "127.0.0.1",
      allowPrivateRanges: true,
      allowPlaintextHttp: true,
      note: "zz-e2e local scoring shim",
    },
  });
  expect(allow.status()).toBe(201);

  await page.goto("/ui/admin/external-scorers");
  await expect(page.getByRole("heading", { name: "External scorers", exact: true })).toBeVisible();
  // the disclosure is ON the page, not in a doc
  await expect(page.getByText(/the vendor's opinion/).first()).toBeVisible();
  await expect(page.getByText(/does not validate the instrument/).first()).toBeVisible();
  // the named ADR-0042 boundary is stated where an admin would look for it
  await expect(page.getByText(/inline guardrail path \(ADR-0042\) stays/)).toBeVisible();

  // register through the real form
  await page.getByLabel("Scorer name").fill(SCORER);
  await page.getByLabel("Endpoint URL").fill(`http://127.0.0.1:${port}/score`);
  await page
    .getByRole("group", { name: "Scorer kinds claimed" })
    .getByRole("checkbox")
    .first()
    .check(); // llm_as_judge, in addition to the default groundedness_judge
  await page.getByLabel(/Plaintext http/).check();
  await page.getByRole("button", { name: "Register scorer" }).click();
  await expect(page.getByText(`External scorer '${SCORER}' registered`)).toBeVisible();

  // the lifecycle is visible: never tested → tested → enabled
  const row = page.getByRole("row", { name: new RegExp(SCORER) });
  await expect(row.getByText("never tested")).toBeVisible();
  await row.getByRole("button", { name: "Test" }).click();
  await expect(page.getByText(`Connection test for '${SCORER}' passed`)).toBeVisible();
  await expect(row.getByText(/tested .* enable it/)).toBeVisible();
  await row.getByRole("button", { name: "Enable" }).click();
  await expect(row.getByText("enabled", { exact: true })).toBeVisible();

  // the Evaluations page discloses the registered instrument beside the
  // scorer registry, under its method label
  await page.goto("/ui/admin/evals");
  await expect(page.getByText("External scorers (registered instruments)")).toBeVisible();
  await expect(page.getByText(`external:${SCORER}`)).toBeVisible();
  await expect(page.getByText(/never substitutes one method for another|never averaged/).first()).toBeVisible();
});
