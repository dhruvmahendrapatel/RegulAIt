/**
 * The three parity features that shipped API-only, driven for real in a browser.
 *
 * ADR-0066 (virtual keys), ADR-0069 (cross-vendor cost consolidation) and
 * ADR-0071 (shadow-AI raw-format import) each disclosed "there is no SPA page"
 * as a gap. These specs exist because a passing unit test is not evidence that
 * a VIEWING feature works, and because each of these three pages carries an
 * honesty rule that only survives if it is asserted on the rendered screen:
 *
 *   1. The virtual-key token is shown EXACTLY ONCE, with the "will not be shown
 *      again" affordance, and the ceiling ("a key only ever NARROWS") is on the
 *      page rather than in an ADR. A refusal — `expiry_in_the_past` — renders
 *      the gateway's own sentence, not "something went wrong".
 *   2. The cost page must NEVER render metered + imported as one figure. This
 *      spec walks every rendered number on the consolidated card and asserts
 *      the blend does not appear, with fixtures chosen so the sum could arise
 *      no other way. A malformed row is refused WITH ITS FILE LINE NUMBER, and
 *      an account that resolves to nobody is shown as unattributed rather than
 *      hidden.
 *   3. The shadow-AI adapter's `verification` sentence — which for several
 *      adapters says outright that it has never been run against a real vendor
 *      export — is printed VERBATIM on screen before an operator can import.
 *
 * Plus the default-deny check that matters for a freeware admin console: a
 * non-admin sees none of these in nav and gets a REAL refusal on direct
 * navigation, not a silent bounce.
 *
 * Zero console errors is asserted throughout; screenshots land in
 * E2E_SHOTS_DIR.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
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

/** the password phase2 rotates the seeded one-time admin credential to */
const ADMIN_PASSWORD = "E2e-Admin-Phase2!";
/** the password phase1 rotates dana's seeded one-time credential to */
const DANA_PASSWORD = "E2e-Rewrite-2026!";

interface ConsoleTracker {
  errors: string[];
  assertClean: (label: string) => void;
}
function trackConsole(page: Page): ConsoleTracker {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // The browser's own network log for a non-2xx fetch. These specs
    // DELIBERATELY provoke 400/401/402/403/409/413/422 refusals — they are the
    // feature — and the line is emitted by the browser, not by our code and is
    // not suppressible from JS. Everything else, including any 5xx, is fatal.
    if (/Failed to load resource.*status of 4\d\d/.test(text)) return;
    errors.push(`console.error: ${text}`);
  });
  return {
    errors,
    assertClean(label: string) {
      expect(errors, `console must be clean after: ${label}`).toEqual([]);
    },
  };
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
}

/**
 * ADR-0031's credential-endpoint bucket is 10 attempts per IP per 300s, and it
 * is SHARED with every other spec in this suite. It is a real control, so this
 * helper WAITS IT OUT rather than the suite raising the limit for its own
 * convenience — the alternative would be a test run that only passes because a
 * security control was weakened for it.
 */
async function submitLogin(page: Page): Promise<number | null> {
  const settled = page
    .waitForResponse((r) => r.url().includes("/auth/login") && r.request().method() === "POST", {
      timeout: 15_000,
    })
    .catch(() => null);
  await page.getByRole("button", { name: "Sign in" }).click();
  const res = await settled;
  if (!res || res.status() !== 429) return null;
  const body = (await res.json()) as { retryAfterSeconds?: number };
  return Math.min(body.retryAfterSeconds ?? 60, 310);
}

/** Sign in without assuming which earlier spec rotated the password. */
async function signIn(page: Page, email: string, candidates: string[], settleOn: string) {
  for (const [i, password] of candidates.entries()) {
    await page.goto("/ui");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);

    for (let attempt = 0; ; attempt += 1) {
      const waitFor = await submitLogin(page);
      if (waitFor === null) break;
      expect(attempt, `login stayed rate-limited for ${email}`).toBeLessThan(6);
      await page.waitForTimeout((waitFor + 2) * 1000);
    }

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
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
  throw new Error(`could not sign in as ${email}`);
}

/**
 * ONE SIGN-IN PER PERSONA FOR THE WHOLE FILE. The gateway rate-limits
 * `/auth/login` to 10 attempts per 300s per client, which is a REAL control
 * (ADR-0025) and not something to raise for a test: signing in once per
 * describe block was itself the thing that tripped it when the full suite ran.
 */
let sharedAdmin: { page: Page; track: ConsoleTracker } | null = null;
async function adminSession(browser: Browser) {
  if (!sharedAdmin) {
    test.setTimeout(400_000);
    const page = await browser.newPage();
    const track = trackConsole(page);
    await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
    sharedAdmin = { page, track };
  }
  return sharedAdmin;
}

test.describe.configure({ mode: "serial" });

// ===========================================================================
// ADR-0066 — virtual keys
// ===========================================================================

test.describe("ADR-0066 virtual keys — the surface the ADR said did not exist", () => {
  let page: Page;
  let track: ConsoleTracker;
  const KEY_NAME = "e2e-contractor-ide";

  test.beforeAll(async ({ browser }) => {
    ({ page, track } = await adminSession(browser));
  });

  const gotoPage = async () => {
    // ADR-0094: the sidebar is suite-scoped; the "/" filter reaches any suite
    await page.getByLabel("Filter navigation").fill("Virtual keys");
    await page.getByRole("link", { name: "Virtual keys", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Virtual keys", exact: true })).toBeVisible();
  };

  test("the ceiling is on the page, not in an ADR", async () => {
    await gotoPage();
    await expect(page.getByText(/A virtual key only ever NARROWS/)).toBeVisible();
    await expect(page.getByText(/A key issued by an admin is/)).toBeVisible();
    await expect(page.getByText(/lifetime cap, not a monthly one|LIFETIME cap/)).toBeVisible();
    await shot(page, "phase6-01-virtual-keys-ceiling");
    track.assertClean("virtual keys landing");
  });

  test("an impossible expiry is refused with the gateway's OWN sentence", async () => {
    await page.getByTestId("vk-name").fill("e2e-already-expired");
    await page.getByTestId("vk-expires").fill("2020-01-01T00:00");
    const refused = page.waitForResponse(
      (r) => r.url().endsWith("/v1/virtual-keys") && r.request().method() === "POST",
    );
    await page.getByTestId("vk-issue").click();
    expect((await refused).status()).toBe(400);

    const outcome = page.getByTestId("vk-outcome");
    await expect(outcome).toContainText("expiry_in_the_past");
    // VERBATIM. Not "something went wrong", not "Refused".
    await expect(outcome.getByTestId("outcome-reason")).toContainText(
      "an already-expired key would authenticate nothing",
    );
    await shot(page, "phase6-02-virtual-key-refusal");
    track.assertClean("expiry refusal");
  });

  test("issuing shows the token EXACTLY ONCE, and it is never fetched again", async () => {
    await page.getByTestId("vk-name").fill(KEY_NAME);
    await page.getByTestId("vk-expires").fill("");
    await page.getByTestId("vk-budget").fill("20");
    await page.getByTestId("vk-restrict").setChecked(true);
    await page.getByTestId("vk-allowlist").fill("claude-3-5-sonnet-20241022");

    const issued = page.waitForResponse(
      (r) => r.url().endsWith("/v1/virtual-keys") && r.request().method() === "POST",
    );
    await page.getByTestId("vk-issue").click();
    const res = await issued;
    expect(res.status()).toBe(201);
    const token = (await res.json()).token as string;
    expect(token).toMatch(/^rglv_[0-9a-f]{48}$/);

    // on screen, once, with the affordance
    const secret = page.getByTestId("revealed-secret");
    await expect(secret).toHaveText(token);
    await expect(page.getByText("shown once")).toBeVisible();
    await expect(page.getByText(/This will not be shown again/)).toBeVisible();
    await shot(page, "phase6-03-virtual-key-one-time-token");

    // the row renders the ceiling, not the secret
    const row = page.getByRole("row", { name: new RegExp(KEY_NAME) });
    await expect(row).toContainText("active");
    await expect(row).toContainText("admin@regulait.local");
    await expect(row).toContainText("claude-3-5-sonnet-20241022");

    // DISMISS, then reload: the token is gone and nothing re-fetches it.
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("revealed-secret")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("heading", { name: "Virtual keys", exact: true })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toContain(token);
    // and the list payload itself carries no token field at all
    const listed = await page.evaluate(async () => {
      const r = await fetch("/v1/virtual-keys", { credentials: "include" });
      return (await r.text()) as string;
    });
    expect(listed).not.toContain(token);
    expect(listed).not.toContain('"token"');

    track.assertClean("issue + one-time reveal");
  });

  test("the enforcement counter and the ledger are shown APART", async () => {
    await page.getByRole("button", { name: KEY_NAME, exact: true }).click();
    await expect(page.getByText("Enforcement counter (spentUsd)")).toBeVisible();
    await expect(page.getByText("Ledger total (usage_events)")).toBeVisible();
    await expect(page.getByText(/computed independently and are shown/)).toBeVisible();
    await expect(page.getByText(/Only its sha256 was ever stored/)).toBeVisible();
    await shot(page, "phase6-04-virtual-key-spend");
    track.assertClean("per-key spend");
  });

  test("revoke is confirmed, and never deletes", async () => {
    await page.getByTestId(`vk-revoke-${KEY_NAME}`).click();
    await expect(page.getByRole("dialog")).toContainText(`Revoke '${KEY_NAME}'?`);
    await expect(page.getByRole("dialog")).toContainText("revoking is not deleting");
    const done = page.waitForResponse(
      (r) => r.url().includes("/v1/virtual-keys/") && r.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: "Revoke key" }).click();
    expect((await done).status()).toBe(200);

    // still listed — revoked is a STATE
    const row = page.getByRole("row", { name: new RegExp(KEY_NAME) });
    await expect(row).toContainText("revoked");
    await shot(page, "phase6-05-virtual-key-revoked");
    track.assertClean("revoke");
  });
});

// ===========================================================================
// ADR-0069 — cross-vendor cost consolidation
// ===========================================================================

test.describe("ADR-0069 cross-vendor cost consolidation — metered and imported, never added", () => {
  let page: Page;
  let track: ConsoleTracker;

  /**
   * Line 3 carries `07/08/2026` — the date nobody can disambiguate — so it is
   * REFUSED with its file line number while lines 2 and 4 are accepted. Line 4
   * names an account that resolves to no RegulAIt user, so it must appear as
   * unattributed spend rather than disappearing.
   */
  const CSV = [
    "account,amount,period",
    "dana@regulait.local,61.11,2026-07",
    "someone@acme.example,999.00,07/08/2026",
    "ghost@nowhere.example,146.30,2026-07",
  ].join("\n");

  test.beforeAll(async ({ browser }) => {
    ({ page, track } = await adminSession(browser));
  });

  const gotoPage = async () => {
    await page.getByLabel("Filter navigation").fill("Cross-vendor consolidation");
    await page.getByRole("link", { name: "Cross-vendor consolidation", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Cross-vendor cost consolidation", exact: true }),
    ).toBeVisible();
  };

  test("the honesty rule leads the page, and each adapter's limits are verbatim", async () => {
    await gotoPage();
    await expect(page.getByText(/no combined total exists to render/)).toBeVisible();
    await expect(page.getByText(/reporting-only/)).toBeVisible();

    // the adapter's OWN sentence, from the registry, on screen
    const limits = page.getByTestId("ci-adapter-limits");
    await expect(limits).toContainText("it does not understand your vendor's semantics");
    await expect(limits).toContainText("Header inference refuses on ambiguity");

    // switching adapter switches the sentence — it is read from the registry,
    // not hard-coded on the page
    await page.getByTestId("ci-adapter").selectOption("seat_roster");
    await expect(page.getByTestId("ci-adapter-limits")).not.toContainText(
      "it does not understand your vendor's semantics",
    );
    await expect(page.getByText(/the money is an operator assertion/)).toBeVisible();
    await shot(page, "phase6-06-cost-adapter-limits");

    await page.getByTestId("ci-adapter").selectOption("generic_mapped");
    track.assertClean("adapter registry");
  });

  test("a dry run reports accepted vs REFUSED, naming the file line", async () => {
    await page.getByTestId("ci-content").fill(CSV);
    await page.getByTestId("ci-source").fill("e2e-seats.csv");
    const done = page.waitForResponse(
      (r) => r.url().endsWith("/v1/cost-imports") && r.request().method() === "POST",
    );
    await page.getByTestId("ci-dry-run").click();
    expect((await done).status()).toBe(200);

    const result = page.getByTestId("ci-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText("Rows parsed");
    // 3 data rows: 2 accepted, 1 refused
    await expect(result.getByText("2Rows accepted")).toBeVisible();
    await expect(result.getByText("1Rows refused")).toBeVisible();

    // the refusal names LINE 3 of the file the operator has open
    const refusals = page.getByTestId("ci-refusals");
    await expect(refusals).toContainText("Refused lines (1)");
    await expect(refusals.getByRole("row").nth(1)).toContainText("3");
    await expect(refusals).toContainText("ambiguous");

    // the account that matched nobody is reported, not hidden
    await expect(page.getByTestId("ci-unattributed")).toContainText("unattributed spend");
    await shot(page, "phase6-07-cost-dry-run-refusal");
    track.assertClean("dry run");
  });

  test("apply, then the consolidated view keeps the two bases APART", async () => {
    const done = page.waitForResponse(
      (r) => r.url().endsWith("/v1/cost-imports") && r.request().method() === "POST",
    );
    await page.getByTestId("ci-apply").click();
    expect((await done).status()).toBe(201);
    await expect(page.getByTestId("ci-outcome")).toContainText("Accepted");

    // widen the window so the July period is inside it
    await page.getByTestId("cc-from").fill("2026-01-01");
    await page.getByTestId("cc-to").fill("2027-01-01");
    await expect(page.getByTestId("cc-subjects")).toBeVisible();

    const subjects = page.getByTestId("cc-subjects");
    // both basis words are rendered, each labelled with what it MEANS
    await expect(subjects.getByText(/metered — regulAIt observed and priced/).first()).toBeVisible();
    await expect(subjects.getByText(/imported — restated from a file you supplied/).first()).toBeVisible();
    // the unattributed subject is a row of its own
    await expect(subjects.getByText(/unattributed — no regulAIt user resolved/)).toBeVisible();
    await expect(page.getByTestId("cc-note")).toContainText("no combined figure");

    // THE ASSERTION THIS FEATURE EXISTS FOR: nowhere on the rendered page does
    // any subject's metered figure appear ADDED to its imported one. The blend
    // is COMPUTED from the API's own answer rather than hard-coded, so this
    // cannot quietly stop testing anything if the seeded metered spend moves.
    const api = (await page.evaluate(async () => {
      const r = await fetch(
        "/v1/cost-consolidated?by=user&from=2026-01-01T00:00:00.000Z&to=2027-01-01T00:00:00.000Z",
        { credentials: "include" },
      );
      return (await r.json()) as unknown;
    })) as {
      subjects: Array<{
        label: string;
        metered: { usd: number };
        imported: { usd: number | null };
      }>;
    };
    // the response body itself has no blended field — the type has no room for one
    expect(JSON.stringify(api)).not.toMatch(/"(total|grandTotal|combined|allUsd|blended)"/);

    const rendered = await page.locator("body").innerText();
    let checkedABlend = false;
    for (const s of api.subjects) {
      if (s.imported.usd === null) continue;
      const blend = (s.metered.usd + s.imported.usd).toFixed(2);
      // only meaningful when the blend is a DIFFERENT number from each half —
      // otherwise "not rendered" would be trivially false
      if (blend === s.metered.usd.toFixed(2) || blend === s.imported.usd.toFixed(2)) continue;
      expect(rendered, `${s.label}: metered+imported must never be rendered`).not.toContain(blend);
      checkedABlend = true;
    }
    expect(checkedABlend, "the fixture must produce at least one subject with BOTH bases").toBe(true);

    // and the individual figures ARE there, separately
    const subjectsText = await subjects.innerText();
    expect(subjectsText).toContain("61.11");
    expect(subjectsText).toContain("146.30");

    await shot(page, "phase6-08-cost-consolidated-two-bases");
    track.assertClean("consolidated view");
  });

  test("re-applying the same bytes is refused as a double count, with the reason", async () => {
    const done = page.waitForResponse(
      (r) => r.url().endsWith("/v1/cost-imports") && r.request().method() === "POST",
    );
    await page.getByTestId("ci-apply").click();
    expect((await done).status()).toBe(409);
    const outcome = page.getByTestId("ci-outcome");
    await expect(outcome).toContainText("duplicate_import");
    await expect(outcome.getByTestId("outcome-reason")).toContainText(
      "Applying them again would double every figure",
    );
    await shot(page, "phase6-09-cost-duplicate-refused");
    track.assertClean("duplicate import");
  });

  test("mapping the unresolved account re-attributes it, and says how many lines moved", async () => {
    await page.getByTestId("al-account").fill("ghost@nowhere.example");
    await page.getByTestId("al-user").selectOption({ label: "Avery Approver · avery@regulait.local" });
    await page.getByTestId("al-reason").fill("e2e: this contractor account is Avery");
    const done = page.waitForResponse(
      (r) => r.url().endsWith("/v1/cost-imports/mappings") && r.request().method() === "POST",
    );
    await page.getByTestId("al-save").click();
    expect([200, 201]).toContain((await done).status());

    await expect(page.getByRole("row", { name: /ghost@nowhere.example/ })).toContainText(
      "avery@regulait.local",
    );
    // the unattributed row is gone: the money moved to a person, it did not vanish
    await expect(
      page.getByTestId("cc-subjects").getByText(/unattributed — no regulAIt user resolved/),
    ).toHaveCount(0);
    await shot(page, "phase6-10-cost-identity-mapping");
    track.assertClean("identity mapping");
  });

  test("revoking a batch demands an audited reason", async () => {
    await page.getByRole("button", { name: "Revoke", exact: true }).first().click();
    await expect(page.getByRole("dialog")).toContainText("The batch row itself is");
    await page.getByRole("button", { name: "Revoke batch" }).click();
    // a blank reason is refused BY THE UI before the request is made
    await expect(page.getByRole("dialog")).toContainText("A reason is required");
    await page.getByRole("dialog").getByLabel("Reason").fill("e2e cleanup");
    const done = page.waitForResponse(
      (r) => r.url().includes("/v1/cost-imports/") && r.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: "Revoke batch" }).click();
    expect((await done).status()).toBe(200);
    await expect(page.getByTestId("ci-outcome")).toContainText("Accepted");
    await shot(page, "phase6-11-cost-batch-revoked");
    track.assertClean("revoke batch");
  });
});

// ===========================================================================
// ADR-0071 — shadow-AI raw-format import
// ===========================================================================

test.describe("ADR-0071 raw evidence import — the verification claim reaches the operator", () => {
  let page: Page;
  let track: ConsoleTracker;

  /** line 2 is not a CEF record; lines 1 and 3 are */
  const RAGGED = [
    "CEF:0|Acme|Proxy|4.2|100|allowed|5|dhost=api.anthropic.com suser=e2e-bob",
    "Jul 30 09:00:00 gw this line is not a CEF record at all",
    "CEF:0|Acme|Proxy|4.2|100|allowed|5|dhost=api.openai.com suser=e2e-carol",
  ].join("\n");

  test.beforeAll(async ({ browser }) => {
    ({ page, track } = await adminSession(browser));
  });

  const gotoPage = async () => {
    await page.getByLabel("Filter navigation").fill("Shadow-AI discovery");
    await page.getByRole("link", { name: "Shadow-AI discovery", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Shadow-AI discovery", exact: true })).toBeVisible();
  };

  test("each adapter's verification sentence is on screen, verbatim", async () => {
    await gotoPage();
    // DETECTION IS DATA. The demo seed installs no signatures, so nothing would
    // ever be found no matter how well a file parsed — install the shipped
    // catalogue first, through the page's own button, so the later assertion
    // that the inventory GREW is meaningful rather than vacuous.
    const seeded = page.waitForResponse(
      (r) => r.url().endsWith("/v1/shadow-ai/catalogue/seed") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Install / refresh shipped seed" }).click();
    expect((await seeded).status()).toBe(200);

    await expect(page.getByText("Import a raw log file (format adapters)")).toBeVisible();

    // the CEF adapter is honest about never having met a real vendor export
    const verification = page.getByTestId("raw-verification");
    await expect(verification).toContainText("has NOT been run against a real");
    await expect(page.getByText("published grammar").first()).toBeVisible();

    // and switching adapter switches the sentence — it comes from the registry
    await page.getByTestId("raw-adapter").selectOption("generic_mapped");
    await expect(page.getByTestId("raw-verification")).toContainText("Assumes nothing about your file");
    await expect(page.getByText("you mapped it").first()).toBeVisible();
    await page.getByTestId("raw-adapter").selectOption("cef");

    // the whole registry, including the fact that no vendor-named preset ships
    await expect(page.getByText(/No vendor-named preset ships, deliberately/)).toBeVisible();
    await shot(page, "phase6-12-shadow-ai-adapters");
    track.assertClean("adapter registry");
  });

  test("a bad line refuses the WHOLE file by default, naming the line", async () => {
    await page.getByTestId("raw-content").fill(RAGGED);
    await page.getByTestId("raw-source").fill("e2e-proxy.log");
    const done = page.waitForResponse(
      (r) => r.url().endsWith("/v1/shadow-ai/imports/raw") && r.request().method() === "POST",
    );
    await page.getByTestId("raw-apply").click();
    expect((await done).status()).toBe(422);

    const outcome = page.getByTestId("raw-outcome");
    await expect(outcome).toContainText("malformed_rows");
    await expect(outcome.getByTestId("outcome-reason")).toContainText("starting at line 2");
    await expect(outcome.getByTestId("outcome-reason")).toContainText(
      "SMALLER inventory that looks complete",
    );
    // and the refusal table names the line too
    await expect(page.getByTestId("raw-outcome-refusals").getByRole("row").nth(1)).toContainText("2");
    await shot(page, "phase6-13-shadow-ai-refuse-file");
    track.assertClean("refuse whole file");
  });

  test("the opt-out is labelled as an opt-out, and still lists every refusal", async () => {
    await page.getByTestId("raw-malformed").selectOption("report_and_continue");
    await expect(page.getByText(/You have opted out of the safe default/)).toBeVisible();

    const done = page.waitForResponse(
      (r) => r.url().endsWith("/v1/shadow-ai/imports/raw") && r.request().method() === "POST",
    );
    await page.getByTestId("raw-apply").click();
    expect((await done).status()).toBe(200);

    const result = page.getByTestId("raw-result");
    await expect(result).toBeVisible();
    await expect(result.getByText("3Lines read")).toBeVisible();
    await expect(result.getByText("2Lines accepted")).toBeVisible();
    await expect(result.getByText("1Lines refused")).toBeVisible();
    await expect(page.getByTestId("raw-result-refusals").getByRole("row").nth(1)).toContainText("2");
    await expect(result).toContainText("accepted + refused = lines read");

    // THE IMPORT WAS REAL, not a preview: the same evidence reached ADR-0055's
    // inventory, so the actors the CEF lines named are now findings.
    await expect(page.getByRole("row", { name: /e2e-bob/ })).toBeVisible();
    await expect(page.getByRole("row", { name: /e2e-carol/ })).toBeVisible();
    await shot(page, "phase6-14-shadow-ai-continue-mode");
    track.assertClean("report_and_continue");
  });

  test("an adapter whose required config is missing refuses with its own reason", async () => {
    await page.getByTestId("raw-adapter").selectOption("proxy_common");
    await expect(page.getByText(/layout is an operator assertion/).first()).toBeVisible();
    await page.getByTestId("raw-content").fill("1690000000.000 100 10.0.0.5 TCP_MISS/200 512 GET http://api.openai.com/v1 alice DIRECT/1.2.3.4 text/json");
    const done = page.waitForResponse(
      (r) => r.url().endsWith("/v1/shadow-ai/imports/raw") && r.request().method() === "POST",
    );
    await page.getByTestId("raw-dry-run").click();
    expect((await done).status()).toBe(422);
    await expect(page.getByTestId("raw-outcome")).toContainText("invalid_adapter_config");
    await shot(page, "phase6-15-shadow-ai-config-required");
    track.assertClean("required config");
  });
});

// ===========================================================================
// ADR-0072 — the stranded-baseline report
// ===========================================================================

test.describe("ADR-0072 — an operator can SEE which baselines are stranded", () => {
  let page: Page;
  let track: ConsoleTracker;

  test.beforeAll(async ({ browser }) => {
    ({ page, track } = await adminSession(browser));
  });

  test("the scoring-semantics card states what a score MEANT, per version", async () => {
    await page.getByLabel("Filter navigation").fill("Evaluations");
    await page.getByRole("link", { name: "Evaluations", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Evaluations", exact: true })).toBeVisible();

    const card = page.locator("section", {
      has: page.getByText("Scoring semantics — which stored measurements are still comparable"),
    });
    await expect(card.getByText("Current semantics", { exact: true })).toBeVisible();
    await expect(card.getByText("Pinned baselines that are stranded", { exact: true })).toBeVisible();
    await expect(card.getByRole("cell", { name: "ADR-0072", exact: true })).toBeVisible();
    await expect(card.getByText(/PLATFORM HOLD/)).toBeVisible();
    await shot(page, "phase6-16-scoring-semantics");
    track.assertClean("scoring semantics");
  });

  test("the groundedness scorers and the context field are authorable", async () => {
    // ADR-0067's four metrics come from the registry, so their presence here is
    // evidence that the eval page renders whatever scorers the gateway ships.
    for (const scorer of ["claim_support", "context_precision", "context_recall", "answer_relevance"]) {
      await expect(page.getByRole("cell", { name: scorer, exact: true })).toBeVisible();
    }
    // and the judged variants are offered too — they REFUSE with a 422 rather
    // than degrading to the lexical proxy under the judged name
    await expect(page.getByRole("cell", { name: "groundedness_judge", exact: true })).toBeVisible();

    // ADR-0067's `eval_cases.context` is AUTHORABLE, which needs a dataset to
    // author into. Create one, open it, and assert the field is there.
    const dsForm = page.locator("form", { has: page.getByRole("button", { name: "Create", exact: true }) });
    await dsForm.getByLabel("Name", { exact: true }).fill("e2e-groundedness");
    await dsForm.locator("select").first().selectOption("claim_support");
    const created = page.waitForResponse(
      (r) => r.url().endsWith("/v1/evals/datasets") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Create", exact: true }).click();
    expect((await created).status()).toBe(201);

    // the kit gives a clickable table row `role="link"`, not `role="row"`
    await page.getByRole("link", { name: /e2e-groundedness/ }).click();
    await expect(page.getByText(/one chunk per blank-line-separated block/)).toBeVisible();
    await expect(
      page.getByText(/uncheck to hold it back and score against it/),
    ).toBeVisible();
    await shot(page, "phase6-17-groundedness-authorable");
    track.assertClean("groundedness authoring");
  });
});

// ===========================================================================
// default-deny
// ===========================================================================

test.describe("default-deny — a non-admin sees none of this, and is told why", () => {
  let page: Page;
  let track: ConsoleTracker;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(400_000);
    page = await browser.newPage();
    track = trackConsole(page);
    await signIn(page, "dana@regulait.local", [DANA_PASSWORD, state.passwords.dana], DANA_PASSWORD);
  });
  test.afterAll(async () => {
    await page.close();
    await sharedAdmin?.page.close();
    sharedAdmin = null;
  });

  test("the three new pages are absent from a non-admin's navigation", async () => {
    for (const label of ["Virtual keys", "Cross-vendor consolidation", "Shadow-AI discovery"]) {
      await expect(page.getByRole("link", { name: label, exact: true })).toHaveCount(0);
    }
    await shot(page, "phase6-18-non-admin-nav");
    track.assertClean("non-admin nav");
  });

  test("navigating directly gets a REAL refusal, not a silent bounce", async () => {
    for (const route of ["/ui/admin/virtual-keys", "/ui/admin/cost-consolidation", "/ui/admin/shadow-ai"]) {
      await page.goto(route);
      await expect(page.getByText("You don't have access to this view")).toBeVisible();
      await expect(page.getByText(/does not hold the administrator role/)).toBeVisible();
      // and it did NOT quietly become the home page
      expect(new URL(page.url()).pathname).toBe(route);
    }
    await shot(page, "phase6-19-non-admin-refusal");

    // the gateway refuses independently of the screen
    const status = await page.evaluate(async () => {
      const r = await fetch("/v1/cost-imports/adapters", { credentials: "include" });
      return r.status;
    });
    expect(status).toBe(403);
    track.assertClean("non-admin direct navigation");
  });
});
