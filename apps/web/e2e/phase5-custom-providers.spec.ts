/**
 * ADR-0034 — the custom-LLM-provider admin surface, driven for real.
 *
 * A registration form that renders is not evidence of anything: this surface's
 * whole job is to be HONEST about a security model, so every assertion here is
 * about BEHAVIOUR — what the gateway actually answered, and whether the exact
 * reason it gave reached the operator's screen.
 *
 *   1. register → the row appears DISABLED, and enabling it is refused with the
 *      gateway's real 409 (`connection_test_required`), not a generic toast;
 *   2. a blocked destination (`http://169.254.169.254/` — the instance-metadata
 *      address) is refused, and the ACTUAL egress reason is on screen, both
 *      before the host is allow-listed and again after it is allow-listed
 *      WITHOUT `allowPrivateRanges`;
 *   3. the two-flag plaintext rule: with neither flag, then with only the host
 *      row's, the UI names WHICH opt-in is still missing — and with both plus
 *      `allowPrivateRanges` a legitimate local endpoint goes through;
 *   4. test → enable → the provider becomes selectable when binding an agent
 *      (and is NOT selectable before that);
 *   5. editing `baseUrl` visibly re-arms the gate — back to disabled/untested;
 *   6. with the org master switch off the page SAYS SO — the rows are still
 *      listed, and the gateway's own `custom_providers_disabled` 409 is shown.
 *
 * The endpoint under test is a REAL local OpenAI-compatible HTTP server, so the
 * connection test is a real dispatch through the real egress guard, exactly as
 * an air-gapped operator's Ollama box would be. Zero console errors is asserted
 * throughout; screenshots land in E2E_SHOTS_DIR, including a narrow viewport.
 */
import { expect, test, type Page } from "@playwright/test";
import http from "node:http";
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

const PROVIDER = "e2e-local-llama";
const IMDS = "169.254.169.254";

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
    // The browser's own network log for a non-2xx fetch. This spec DELIBERATELY
    // provokes 400/403/409/502 refusals — they are the feature — and the log
    // line is emitted by the browser, not by our code, and is not suppressible
    // from JS. Everything else is fatal.
    if (/Failed to load resource.*(40[0139]|50[02])/.test(text)) return;
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

/** Sign in without assuming which earlier spec rotated the password. */
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
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
  throw new Error(`could not sign in as ${email}`);
}

test.describe.configure({ mode: "serial" });

test.describe("ADR-0034 custom LLM providers — the admin surface", () => {
  let page: Page;
  let track: ConsoleTracker;
  let srv: http.Server;
  let port: number;
  /** every request the fake endpoint saw — proof the connection test is real */
  const hits: Array<{ url: string; auth: string | null }> = [];

  test.beforeAll(async ({ browser }) => {
    // A real local OpenAI-compatible endpoint: the shape Ollama / vLLM /
    // LM Studio / LocalAI all present, and KEYLESS — no Authorization header
    // is expected or required.
    srv = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        hits.push({ url: req.url ?? "", auth: (req.headers.authorization as string) ?? null });
        const parsed = raw ? (JSON.parse(raw) as { model?: string }) : {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-web-e2e",
            object: "chat.completion",
            created: 1,
            model: parsed.model ?? "probe",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "local llama says hi", refusal: null },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 },
          }),
        );
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as { port: number }).port;

    page = await browser.newPage();
    track = trackConsole(page);
    await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
  });

  test.afterAll(async () => {
    await page.close();
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  const gotoPage = async () => {
    // ADR-0094: the sidebar is suite-scoped; the "/" filter reaches any suite
    await page.getByLabel("Filter navigation").fill("Custom LLM providers");
    await page.getByRole("link", { name: "Custom LLM providers", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Custom LLM providers", exact: true })).toBeVisible();
  };

  const baseUrl = () => `http://127.0.0.1:${port}/v1`;
  const outcome = (testId: string) => page.getByTestId(testId).getByTestId("outcome-reason");

  /** Upsert the 127.0.0.1 allow-list row with a given pair of opt-ins. */
  const setLocalAllowEntry = async (opts: { privateRanges: boolean; plaintext: boolean }) => {
    await page.getByTestId("allow-host-input").fill("127.0.0.1");
    await page.getByTestId("allow-host-note").fill("e2e local OpenAI-compatible endpoint");
    const priv = page.getByLabel("Allow private ranges");
    const plain = page.getByLabel("Allow plaintext HTTP", { exact: true });
    if ((await priv.isChecked()) !== opts.privateRanges) await priv.setChecked(opts.privateRanges);
    if ((await plain.isChecked()) !== opts.plaintext) await plain.setChecked(opts.plaintext);
    const done = page.waitForResponse(
      (r) => r.url().includes("/v1/egress-allow-hosts") && r.request().method() === "POST",
    );
    await page.getByTestId("add-allow-host").click();
    expect((await done).status()).toBe(201);
  };

  /** Fill (but do not submit) the register form. */
  const fillRegister = async (opts: { name: string; url: string; plaintext: boolean }) => {
    await page.getByTestId("provider-name").fill(opts.name);
    await page.getByTestId("provider-base-url").fill(opts.url);
    const plain = page.getByLabel("Allow plaintext HTTP (provider half)");
    if ((await plain.isChecked()) !== opts.plaintext) await plain.setChecked(opts.plaintext);
  };

  const submitRegister = async (): Promise<number> => {
    const done = page.waitForResponse(
      (r) => r.url().endsWith("/v1/custom-model-providers") && r.request().method() === "POST",
    );
    await page.getByTestId("register-provider").click();
    return (await done).status();
  };

  // -------------------------------------------------------------------------

  test("the lifecycle is stated up front, and the allow-list starts empty (default-deny)", async () => {
    await gotoPage();

    // register → test → enable, in that order, before anything is attempted
    await expect(page.getByText("Allow-list, then register", { exact: true })).toBeVisible();
    await expect(page.getByText("Pass a connection test", { exact: true })).toBeVisible();
    await expect(page.getByText(/Refused while no test has passed/)).toBeVisible();
    // an empty allow-list is a POSTURE, and the page says so rather than
    // looking like a failed load
    await expect(page.getByText("No destinations granted")).toBeVisible();
    await expect(page.getByText(/default-deny posture, not a problem/)).toBeVisible();

    await shot(page, "phase5-01-lifecycle-and-empty-allowlist");
    track.assertClean("custom providers landing");
  });

  test("a blocked destination is refused, and the gateway's ACTUAL reason is on screen", async () => {
    // (a) not allow-listed at all
    await fillRegister({ name: "imds-probe", url: `http://${IMDS}/`, plaintext: true });
    // the advisory pre-flight already names both gaps, BEFORE any request
    await expect(page.getByTestId("register-preflight")).toContainText("is not on the egress allow-list");
    await expect(page.getByTestId("register-preflight")).toContainText("Allow private ranges");

    expect(await submitRegister()).toBe(400);
    await expect(page.getByTestId("register-outcome")).toContainText("Egress refused");
    await expect(page.getByTestId("register-outcome")).toContainText("egress_blocked");
    // VERBATIM — the guard's own sentence, not a paraphrase and not "something
    // went wrong". The whole point of the guard is that the operator learns why.
    await expect(outcome("register-outcome")).toContainText(
      `host '${IMDS}' is not in the egress allow-list — an admin must add it before it can be reached`,
    );
    await shot(page, "phase5-02-egress-refused-not-allowlisted");

    // (b) allow-listed, but WITHOUT allowPrivateRanges — the link-local range
    //     is still default-deny, and the reason now names the resolved address.
    await page.getByTestId("allow-host-input").fill(IMDS);
    await page.getByTestId("allow-host-note").fill("e2e: proving an allow-list row is not a bypass");
    const added = page.waitForResponse(
      (r) => r.url().includes("/v1/egress-allow-hosts") && r.request().method() === "POST",
    );
    await page.getByTestId("add-allow-host").click();
    expect((await added).status()).toBe(201);

    // https, so the scheme rule is satisfied and the check reaches the address
    // classifier — which is the part being proven here.
    await fillRegister({ name: "imds-probe", url: `https://${IMDS}/`, plaintext: false });
    expect(await submitRegister()).toBe(400);
    await expect(outcome("register-outcome")).toContainText(
      `'${IMDS}' resolves to ${IMDS} — link-local`,
    );
    await expect(outcome("register-outcome")).toContainText("an admin may set allowPrivateRanges");
    await shot(page, "phase5-03-egress-refused-link-local");

    // clean the row back off the allow-list through the UI's own confirm
    await page.getByRole("row", { name: new RegExp(IMDS) }).getByRole("button", { name: "remove" }).click();
    await expect(page.getByRole("dialog")).toContainText(`Revoke egress to ${IMDS}?`);
    const removed = page.waitForResponse(
      (r) => r.url().includes("/v1/egress-allow-hosts/") && r.request().method() === "DELETE",
    );
    await page.getByRole("button", { name: "Revoke destination" }).click();
    expect((await removed).status()).toBe(200);
    await expect(page.getByRole("row", { name: new RegExp(IMDS) })).toHaveCount(0);

    track.assertClean("egress refusals");
  });

  test("the two-flag plaintext rule names WHICH opt-in is still missing", async () => {
    // host allow-listed with private ranges (it is loopback) but NOT plaintext
    await setLocalAllowEntry({ privateRanges: true, plaintext: false });

    // neither plaintext flag set → the refusal is about the HOST ROW's flag
    await fillRegister({ name: PROVIDER, url: baseUrl(), plaintext: false });
    await expect(page.getByTestId("register-preflight")).toContainText("Allow plaintext HTTP");
    expect(await submitRegister()).toBe(400);
    await expect(outcome("register-outcome")).toContainText(
      "plaintext http to '127.0.0.1' requires the egress allow entry to set allowPlaintextHttp",
    );
    // and the fix list names the second flag too, so it is one trip not two
    await expect(page.getByTestId("register-outcome")).toContainText(
      "must tick Allow plaintext HTTP as well as the allow-list row",
    );
    await shot(page, "phase5-04-plaintext-host-flag-missing");

    // give the HOST its flag; the PROVIDER's is still missing, and the gateway
    // says exactly that — a different sentence, naming the other half
    await setLocalAllowEntry({ privateRanges: true, plaintext: true });
    await fillRegister({ name: PROVIDER, url: baseUrl(), plaintext: false });
    expect(await submitRegister()).toBe(400);
    await expect(outcome("register-outcome")).toContainText(
      "plaintext http requires the provider itself to set allowPlaintextHttp as well as the host entry",
    );
    await shot(page, "phase5-05-plaintext-provider-flag-missing");

    track.assertClean("two-flag plaintext rule");
  });

  test("with both opt-ins the endpoint registers — DISABLED — and cannot be enabled", async () => {
    await fillRegister({ name: PROVIDER, url: baseUrl(), plaintext: true });
    // the advisory pre-flight now clears
    await expect(page.getByTestId("register-preflight")).toContainText("nothing is obviously missing");
    expect(await submitRegister()).toBe(201);
    await expect(page.getByTestId("register-outcome")).toContainText("Endpoint registered — disabled");

    const row = page.getByRole("row", { name: new RegExp(PROVIDER) });
    await expect(row).toContainText("disabled");
    await expect(row).toContainText("never tested");
    await expect(row).toContainText("Enable is gated until a connection test passes");
    // a keyless endpoint is a first-class case, stated as such
    await expect(row).toContainText("no key (unauthenticated endpoint)");
    await shot(page, "phase5-06-registered-disabled");

    // ENABLING AN UNTESTED PROVIDER IS REFUSED — and the gateway's own 409
    // reaches the screen intact.
    const refused = page.waitForResponse(
      (r) => r.url().includes("/enabled") && r.request().method() === "POST",
    );
    await page.getByTestId(`enable-${PROVIDER}`).click();
    expect((await refused).status()).toBe(409);
    await expect(page.getByTestId("provider-outcome")).toContainText("connection_test_required");
    await expect(outcome("provider-outcome")).toContainText(
      `custom provider '${PROVIDER}' has not passed a connection test`,
    );
    await expect(page.getByRole("row", { name: new RegExp(PROVIDER) })).toContainText("disabled");
    await shot(page, "phase5-07-enable-refused-409");

    track.assertClean("register + refused enable");
  });

  test("a disabled endpoint is NOT selectable when binding an agent", async () => {
    await page.getByLabel("Filter navigation").fill("Agents");
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    await page.getByTestId("agent-provider").getByRole("radio", { name: "Custom endpoint" }).check(); // ADR-0172 provider tiles
    const endpoints = page.getByTestId("agent-custom-endpoint");
    await expect(endpoints).toBeVisible();
    await expect(endpoints.locator("option")).toHaveCount(1); // the placeholder only
    await expect(page.getByTestId("no-enabled-endpoints")).toBeVisible();
    // and the unpriced discipline is stated where the cost boxes are
    await expect(page.getByText(/leaving both cost fields blank is the/)).toBeVisible();
    await shot(page, "phase5-08-agent-binding-no-enabled-endpoint");
    track.assertClean("agent binding before enable");
  });

  test("test → enable, and only then does the endpoint become bindable", async () => {
    await gotoPage();
    const before = hits.length;

    const tested = page.waitForResponse((r) => r.url().includes("/test") && r.request().method() === "POST");
    await page.getByTestId(`test-${PROVIDER}`).click();
    expect((await tested).status()).toBe(200);
    await expect(page.getByTestId("provider-outcome")).toContainText("Connection test passed");
    // a REAL dispatch left the gateway and reached the local endpoint — and it
    // carried NO Authorization header, because this endpoint is keyless
    expect(hits.length).toBeGreaterThan(before);
    expect(hits[hits.length - 1]!.url).toContain("/chat/completions");
    expect(hits[hits.length - 1]!.auth).toBeNull();

    await expect(page.getByRole("row", { name: new RegExp(PROVIDER) })).toContainText("tested OK");

    const enabled = page.waitForResponse(
      (r) => r.url().includes("/enabled") && r.request().method() === "POST",
    );
    await page.getByTestId(`enable-${PROVIDER}`).click();
    expect((await enabled).status()).toBe(200);
    await expect(page.getByRole("row", { name: new RegExp(PROVIDER) })).toContainText("enabled");
    await shot(page, "phase5-09-tested-and-enabled");

    // now — and only now — it can be bound to an agent
    await page.getByLabel("Filter navigation").fill("Agents");
    await page.getByRole("link", { name: "Agents", exact: true }).click();
    await page.getByTestId("agent-provider").getByRole("radio", { name: "Custom endpoint" }).check(); // ADR-0172 provider tiles
    const endpoints = page.getByTestId("agent-custom-endpoint");
    await expect(endpoints.locator("option")).toHaveCount(2);
    await expect(endpoints.locator("option").nth(1)).toContainText(PROVIDER);
    await endpoints.selectOption({ index: 1 });

    const reg = page.locator("form", { has: page.getByRole("button", { name: "Register agent" }) });
    await reg.getByLabel("Name", { exact: true }).fill("e2e-local-agent");
    await reg.getByLabel("Model id (blank = not dispatchable)").fill("llama3.1");
    const created = page.waitForRequest(
      (r) => r.url().endsWith("/v1/agents") && r.method() === "POST",
    );
    await page.getByRole("button", { name: "Register agent" }).click();
    const body = JSON.parse((await created).postData() ?? "{}") as Record<string, unknown>;
    // ON THE WIRE: the discriminated union is sent as a PAIR, exactly as the
    // DB CHECK constraint requires.
    expect(body.provider).toBe("custom");
    expect(String(body.customProviderId)).toMatch(/^[0-9a-f-]{36}$/);
    // and no invented price
    expect(body.costPerMTokIn).toBeUndefined();
    expect(body.costPerMTokOut).toBeUndefined();

    // scoped to the Catalog card: the stewardship table above lists the same agent
    const catalog = page.locator("section[data-rg-card]").filter({ has: page.getByText("Catalog", { exact: true }) });
    const row = catalog.getByRole("row", { name: /e2e-local-agent/ });
    await expect(row).toContainText(`custom · ${PROVIDER}`);
    await expect(row).toContainText("unpriced");
    await shot(page, "phase5-10-agent-bound-to-custom-endpoint");

    track.assertClean("test, enable, bind");
  });

  test("moving the endpoint URL visibly re-arms the gate", async () => {
    await gotoPage();
    await page.getByTestId(`edit-${PROVIDER}`).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    // the stored key is never shown — only its presence, and only as a choice
    await expect(page.getByRole("dialog")).toContainText("no key (unauthenticated endpoint)");
    await expect(page.getByRole("dialog")).toContainText("never returned by any endpoint");

    await page.getByTestId("edit-base-url").fill(`http://127.0.0.1:${port}/v1/openai`);
    // the consequence is stated BEFORE the save, not discovered after it
    await expect(page.getByTestId("rearm-warning")).toContainText(
      "disables this provider and clears its connection test",
    );
    await shot(page, "phase5-11-edit-rearms-gate");

    const saved = page.waitForResponse(
      (r) => r.url().includes("/v1/custom-model-providers/") && r.request().method() === "PATCH",
    );
    await page.getByTestId("save-provider-edit").click();
    expect((await saved).status()).toBe(200);

    const row = page.getByRole("row", { name: new RegExp(PROVIDER) });
    await expect(row).toContainText("disabled");
    await expect(row).toContainText("never tested");
    await expect(row).toContainText("Enable is gated until a connection test passes");
    await expect(row).toContainText("/v1/openai");
    await shot(page, "phase5-12-gate-rearmed");

    track.assertClean("endpoint move re-arms the gate");
  });

  test("the org master switch, when off, says so plainly instead of looking broken", async () => {
    const setSwitch = async (value: "true" | "false") => {
      await page.getByLabel("Filter navigation").fill("Organization");
      await page.getByRole("link", { name: "Organization", exact: true }).click();
      await expect(page.getByRole("heading", { name: "Organization", exact: true })).toBeVisible();
      await page.getByLabel("Custom LLM providers").selectOption(value);
      const saved = page.waitForResponse(
        (r) => r.url().includes("/v1/org/settings") && r.request().method() === "PUT",
      );
      await page.getByRole("button", { name: "Save custom-provider switch" }).click();
      expect((await saved).status()).toBe(200);
    };

    await setSwitch("false");
    await gotoPage();
    const banner = page.getByTestId("capability-off");
    await expect(banner).toContainText("switched off for this organisation");
    await expect(banner).toContainText("customModelProvidersEnabled = false");
    // the rows are STILL LISTED — "off" is a posture, not a broken page
    await expect(page.getByRole("row", { name: new RegExp(PROVIDER) })).toBeVisible();
    await shot(page, "phase5-13-org-switch-off");

    // and the gateway agrees: registration is refused with its own 409
    await fillRegister({ name: "should-not-exist", url: baseUrl(), plaintext: true });
    expect(await submitRegister()).toBe(409);
    await expect(page.getByTestId("register-outcome")).toContainText("custom_providers_disabled");
    await expect(outcome("register-outcome")).toContainText(
      "custom LLM providers are switched off for this organisation",
    );

    await setSwitch("true");
    await gotoPage();
    await expect(page.getByTestId("capability-off")).toHaveCount(0);
    track.assertClean("org master switch");
  });

  test("the surface holds together at a narrow width", async () => {
    await page.setViewportSize({ width: 420, height: 900 });
    // the shell hides the sidebar behind the hamburger below the breakpoint —
    // reach the page the way a phone user actually would
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    // ADR-0094: the drawer is suite-scoped too — the filter works at 420px
    await page.getByLabel("Filter navigation").fill("Custom LLM providers");
    await page.getByRole("link", { name: "Custom LLM providers", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Custom LLM providers", exact: true })).toBeVisible();
    // no horizontal overflow of the page body — wide content scrolls inside
    // its own container, the document does not
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await shot(page, "phase5-14-narrow");
    await page.setViewportSize({ width: 1400, height: 900 });
    track.assertClean("narrow viewport");
  });

  test("dark theme renders the security blocks and refusal panels", async () => {
    await gotoPage();
    await page.getByRole("button", { name: /Switch to dark theme/ }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await shot(page, "phase5-15-dark");
    await page.getByRole("button", { name: /Switch to light theme/ }).click();
    track.assertClean("dark theme");
  });
});
