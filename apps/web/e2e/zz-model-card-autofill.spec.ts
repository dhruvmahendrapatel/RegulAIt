/**
 * ADR-0086 in the real SPA — the model card as a WINDOW over the ledgers.
 *
 * The one thing this spec exists to prove end-to-end: a LEDGER write (a real
 * eval run) appears in the card's computed autofill block WITHOUT any card
 * edit. Plus the two-block honesty on the page itself: the computed block is
 * labelled "Computed from ledgers at read time", the manual evidence block is
 * labelled apart, and an unprobed subject's red-team line reads "unmeasured,
 * not resisted" — never a reassuring 0%.
 *
 * This spec WRITES (a model card on the seeded balanced-mock agent, an eval
 * dataset/run) — safe only because it runs LAST (zz- prefix, M-018); its
 * objects are zz-prefixed and unique so nothing earlier can collide with them.
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
 * Order-independent sign-in, copied from the phase4-7 / zz- specs (M-017):
 * the suite shares ONE seeded database, so the seeded one-time password is
 * consumed by whichever spec runs first; trying the candidates in turn and
 * settling on the SHARED password keeps every spec runnable in any order.
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

const CSRF = { "x-regulait-csrf": "1" };

const INTENDED_USE = "zz-autofill window probe";

/** open the probe card's detail panel and return its "Evaluations:" count */
async function openCardAndReadEvalCount(page: Page): Promise<number> {
  await page
    .getByRole("row")
    .filter({ hasText: INTENDED_USE })
    .getByRole("button", { name: "Open" })
    .click();
  // exact: the badge — the block's own note also contains the phrase
  await expect(page.getByText("Computed from ledgers at read time", { exact: true })).toBeVisible();
  const line = await page.getByText(/^Evaluations: \d+ runs? recorded/).textContent();
  const m = /Evaluations: (\d+) runs? recorded/.exec(line ?? "");
  expect(m, `could not parse the evaluations line: ${line}`).toBeTruthy();
  return Number(m![1]);
}

test("a ledger write appears in the card's autofill with NO card edit", async ({ page }) => {
  await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);

  // the seeded agent this card is about
  const agents = (await (await page.request.get("/v1/agents")).json()) as {
    agents: Array<{ id: string; name: string }>;
  };
  const subject = agents.agents.find((a) => a.name === "balanced-mock");
  expect(subject, "the seeded balanced-mock agent must exist").toBeTruthy();

  // author the card THROUGH THE PAGE — the last card edit that ever happens
  await page.goto("/ui/admin/model-risk");
  await expect(page.getByRole("heading", { name: "Model risk", exact: true })).toBeVisible();
  await page.getByLabel("Agent").selectOption(subject!.id);
  await page.getByLabel("Intended use").fill(INTENDED_USE);
  await page.getByRole("button", { name: "Create card" }).click();
  await expect(page.getByRole("cell", { name: INTENDED_USE })).toBeVisible();

  // open it: the computed block renders, labelled, beside the manual block
  const before = await openCardAndReadEvalCount(page);
  // an unprobed subject reads UNMEASURED, in words — never a reassuring 0%
  await expect(page.getByText(/unmeasured, not resisted/)).toBeVisible();
  // the manual evidence block is labelled APART from the computed block
  await expect(page.getByText("Attached evidence (manual)")).toBeVisible();
  await expect(page.getByText(/never summed into, the computed/)).toBeVisible();

  // THE LEDGER WRITE — a real eval run against the subject, via the same
  // session; the CARD is never touched
  const ds = await page.request.post("/v1/evals/datasets", {
    headers: CSRF,
    data: { name: `zz-autofill-golden-${Date.now()}`, scorerKind: "contains", scorerConfig: { needles: ["ok"] } },
  });
  expect(ds.status()).toBe(201);
  const dsId = ((await ds.json()) as { id: string }).id;
  const kase = await page.request.post(`/v1/evals/datasets/${dsId}/cases`, {
    headers: CSRF,
    data: { input: "say ok", expected: "ok" },
  });
  expect(kase.status()).toBe(201);
  const run = await page.request.post("/v1/evals/runs", {
    headers: CSRF,
    data: { datasetId: dsId, agentId: subject!.id, trigger: "manual" },
  });
  expect(run.status()).toBe(201);

  // the card noticed, without any card edit
  await page.reload();
  const after = await openCardAndReadEvalCount(page);
  expect(after).toBe(before + 1);
});
