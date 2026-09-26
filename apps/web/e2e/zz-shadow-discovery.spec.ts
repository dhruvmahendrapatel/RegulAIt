/**
 * ADR-0083 in the real SPA — the first-party discovery card on the Shadow-AI
 * page, driven end to end:
 *
 *  - the compiled-catalogue posture and the governed/shadow split render from
 *    the API, verbatim — a classify of a log naming an ungoverned OpenAI hit
 *    and plain noise shows ONE shadow candidate and the unmatched sample;
 *  - Confirm ingest files the finding through ADR-0055's pipeline and it
 *    appears in the page's own inventory table;
 *  - the retention claim (pasted content not stored) is on screen before
 *    anything is ingested.
 *
 * Writes findings on purpose, so it runs LAST (zz- prefix, M-018): nothing
 * after it asserts global emptiness. Sign-in is the order-independent helper
 * every late spec uses (M-017).
 */
import { expect, test, type Page } from "@playwright/test";
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
    await expect(welcome.or(forcedChange).or(rejected).first()).toBeVisible();

    if (await welcome.isVisible()) return password;
    if (await forcedChange.isVisible()) {
      await page.getByLabel("Current (one-time) password").fill(password);
      await page.getByLabel("New password", { exact: true }).fill(settleOn);
      await page.getByLabel("Confirm new password").fill(settleOn);
      await page.getByRole("button", { name: "Set password & continue" }).click();
      await expect(welcome).toBeVisible();
      return settleOn;
    }
    expect(i, `no candidate password worked for admin`).toBeLessThan(candidates.length - 1);
  }
  throw new Error("could not sign in as admin");
}

const DNS_LOG = [
  "Aug 20 10:00:01 dnsmasq[812]: query[A] api.openai.com from 10.7.7.1",
  "Aug 20 10:00:02 dnsmasq[812]: query[A] github.com from 10.7.7.2",
  "Aug 20 10:00:03 dnsmasq[812]: query[A] api.openai.com from 10.7.7.3",
].join("\n");

test("first-party discovery: classify, review the split, confirm ingest, see the finding", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  await page.goto("/ui/admin/shadow-ai");
  await expect(page.getByRole("heading", { name: "Shadow-AI discovery", exact: true })).toBeVisible();

  // the card and its honesty text, from the API
  await expect(page.getByText("First-party discovery (classify what you already hold)")).toBeVisible();
  await expect(page.getByText(/COMPILED INTO THIS BUILD/)).toBeVisible();
  // the phrase appears in BOTH honesty sentences (posture and limits) — assert presence, not uniqueness
  await expect(page.getByText(/inherently incomplete and dated/).first()).toBeVisible();

  // the finding is minted by the ADMIN catalogue (detection is data), so make
  // sure it is seeded — idempotent, through the page's own button, the same
  // move phase6 makes
  const seeded = page.waitForResponse(
    (r) => r.url().endsWith("/v1/shadow-ai/catalogue/seed") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Install / refresh shipped seed" }).click();
  expect((await seeded).status()).toBe(200);

  // classify a small DNS excerpt
  await page.getByTestId("disc-kind").selectOption("dns_log");
  await page.getByTestId("disc-subject").fill("zz-e2e-resolver");
  await page.getByTestId("disc-content").fill(DNS_LOG);
  await page.getByTestId("disc-classify").click();

  const result = page.getByTestId("disc-result");
  await expect(result).toBeVisible();
  // one distinct shadow candidate (api.openai.com ×2), one unmatched (github.com)
  await expect(result.getByText("1Shadow candidates")).toBeVisible();
  await expect(result.getByText("1Unmatched")).toBeVisible();
  await expect(result.getByRole("cell", { name: "api.openai.com" })).toBeVisible();
  await expect(page.getByTestId("disc-unmatched")).toContainText("github.com");
  // the retention claim is on screen BEFORE any ingest
  await expect(result.getByText(/was not stored/)).toBeVisible();

  // confirm the ingest of the shadow rows
  await page.getByTestId("disc-ingest").click();
  await expect(page.getByTestId("disc-ingest-summary")).toContainText(/Ingested: 1 shadow row/);

  // the finding landed in the page's own inventory, under the subject label
  await expect(page.getByRole("cell", { name: "zz-e2e-resolver" })).toBeVisible();
});
