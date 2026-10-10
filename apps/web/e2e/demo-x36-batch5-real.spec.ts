import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { signInPrepared } from "./demo-credentials";
import { nextCode } from "./totp-sign-in";
import { activate, expectDialogTrap, escapeToTrigger, tabTo, typeAt } from "./keyboard-audit";

const email = "admin@regulait.local";
async function signIn(page: Page) {
  expect(await signInPrepared(page, email, "X36-Disposable-Admin!", page.getByRole("heading", { name: /Welcome back/ }))).toBe(true);
}
async function evidence(page: Page, info: TestInfo, name: string) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate(async t => { document.documentElement.dataset.theme = t; localStorage.setItem("regulait.theme", t);
      await Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined))); }, theme);
    const violations = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations;
    expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join("; ")}`), `${name} ${theme}`).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${name}-${theme}.png`), fullPage: true });
  }
}
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", message => {
    // Chromium logs the deliberate real HTTP refusals as failed resources.
    // Their status/body is separately asserted; all other console errors fail.
    if (message.type() === "error" && !/^Failed to load resource: the server responded with a status of (403|404|409|501)\b/.test(message.text())) errors.push(message.text());
  });
  return errors;
}

test("real unbuilt engines refuse enabling/self-test; disabled engines and unavailable runs never appear passed", async ({ page }, info) => {
  await signIn(page); const errors = collectErrors(page);
  await page.goto("/ui/admin/engines");
  await expect(page.getByRole("heading", { name: "Engines", level: 1 })).toBeVisible();
  const res = await page.request.get("/v1/engines"); expect(res.status()).toBe(200);
  const engines = (await res.json()).engines;
  expect(engines).toHaveLength(3);
  for (const engine of engines) {
    expect(engine.enabled).toBe(false); expect(engine.imageDigest).toBeNull();
    await expect(page.getByTestId(`engine-${engine.id}`).getByText("Off — not built", { exact: true })).toBeVisible();
  }
  await evidence(page, info, "engines-off");
  const card = page.getByTestId("engine-promptfoo");
  const trigger = card.getByRole("button", { name: "Enable…", exact: true });
  await activate(page, trigger);
  let dialog = page.getByRole("dialog", { name: "Enable promptfoo?" });
  await expectDialogTrap(page, dialog); await escapeToTrigger(page, dialog, trigger);
  await activate(page, trigger); dialog = page.getByRole("dialog", { name: "Enable promptfoo?" });
  const response = page.waitForResponse(r => r.url().endsWith("/v1/engines/promptfoo") && r.request().method() === "PATCH");
  await activate(page, dialog.getByRole("button", { name: "Enable", exact: true }));
  const refused = await response; expect(refused.status()).toBe(409);
  expect((await refused.json()).error).toBe("engine_self_test_required");
  await expect(card.getByRole("alert")).toContainText("no passing runner self-test is recorded");
  await activate(page, card.getByRole("button", { name: "Run self-test…", exact: true }));
  dialog = page.getByRole("dialog", { name: "Run promptfoo's self-test?" });
  await activate(page, dialog.getByRole("button", { name: "Run self-test", exact: true }));
  await expect(card.getByRole("alert")).toContainText("no live runner is registered for the current build");
  await expect(card.getByText("Off — not built", { exact: true })).toBeVisible();
  await evidence(page, info, "engines-refused");
  for (const path of ["/ui/admin/redteam", "/ui/admin/evals?tab=engines"]) {
    await page.goto(path);
    await expect(page.getByText("No engine is enabled", { exact: true })).toBeVisible();
    await expect(page.getByText("No engine runs yet", { exact: true })).toBeVisible();
    await expect(page.getByTestId("engine-verdict")).toHaveCount(0);
    await evidence(page, info, path.includes("redteam") ? "redteam-no-engine" : "evals-no-engine");
  }
  await page.goto("/ui/admin/evals?tab=engines&run=00000000-0000-4000-8000-000000000036");
  await expect(page.getByTestId("engine-run-unavailable")).toBeVisible();
  await expect(page.getByTestId("engine-verdict")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("actual artifact upload stays not clean without modelscan and never renders raw file content", async ({ page }, info) => {
  await signIn(page); const errors = collectErrors(page);
  await page.goto("/ui/admin/admission?tab=artifacts");
  await expect(page.getByTestId("artifact-file")).toBeVisible();
  const filename = `x36-unknown-${Date.now()}.bin`;
  const bytes = Buffer.from("X36_SYNTHETIC_RAW_FILE_CONTENT_NEVER_DOM");
  await page.getByTestId("artifact-file").setInputFiles({ name: filename, mimeType: "application/octet-stream", buffer: bytes });
  const response = page.waitForResponse(r => r.url().includes("/v1/model-artifacts") && r.request().method() === "POST");
  await activate(page, page.getByRole("button", { name: "Upload", exact: true }));
  const uploaded = await response; expect(uploaded.status()).toBe(201);
  const artifact = (await uploaded.json()).artifact; expect(artifact.format).toBe("unrecognised");
  await expect(page.getByRole("button", { name: `Open ${filename}`, exact: true })).toBeVisible();
  const openArtifact = page.getByRole("button", { name: `Open ${filename}`, exact: true });
  if (await openArtifact.getAttribute("aria-pressed") !== "true") await activate(page, openArtifact);
  await expect(page.getByTestId("engine-off")).toContainText("no scan can start");
  await expect(page.getByRole("button", { name: "Scan with modelscan", exact: true })).toBeDisabled();
  await expect(page.locator('[data-testid="scan-status"][data-clean="true"]')).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(bytes.toString());
  const attempted = await page.request.post("/v1/engine-runs", { headers: { "x-regulait-csrf": "1" }, data: { engineId: "modelscan", target: { artifactId: artifact.id }, config: { sets: ["scan"] } } });
  expect(attempted.status()).toBe(409); expect((await attempted.json()).error).toBe("engine_disabled");
  const detail = await page.request.get(`/v1/model-artifacts/${artifact.id}`);
  expect((await detail.json()).scans).toEqual([]);
  await evidence(page, info, "artifact-unknown-not-scanned"); expect(errors).toEqual([]);
});

test("execution kill switch confirms a reason and restoring normal mode requires real identity step-up", async ({ page }, info) => {
  await signIn(page); const errors = collectErrors(page);
  await page.goto("/ui/admin/execution");
  await expect(page.getByRole("heading", { name: "Execution control", level: 1 })).toBeVisible();
  await activate(page, page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Halt everything", exact: true }) }).getByRole("button", { name: "Switch", exact: true }));
  let dialog = page.getByRole("dialog");
  await expectDialogTrap(page, dialog);
  await typeAt(page, dialog.getByLabel("Reason", { exact: true }), "X36 disposable review: stop governed execution");
  await activate(page, dialog.getByRole("button", { name: "Halt everything", exact: true }));
  await expect.poll(async () => (await (await page.request.get("/v1/execution")).json()).mode).toBe("halted");
  await evidence(page, info, "execution-halted");
  await activate(page, page.getByRole("row").filter({ has: page.getByRole("cell", { name: "Normal", exact: true }) }).getByRole("button", { name: "Resume", exact: true }));
  dialog = page.getByRole("dialog");
  await typeAt(page, dialog.getByLabel("Reason", { exact: true }), "X36 disposable review: resume normal policy enforcement");
  await activate(page, dialog.getByRole("button", { name: "Resume", exact: true }));
  const prompt = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(prompt).toBeVisible();
  await expect.poll(async () => (await (await page.request.get("/v1/execution")).json()).mode).toBe("halted");
  await tabTo(page, prompt.getByLabel("Authenticator code")); await page.keyboard.type(await nextCode(email));
  await activate(page, prompt.getByRole("button", { name: "Confirm with code" }));
  await expect.poll(async () => (await (await page.request.get("/v1/execution")).json()).mode).toBe("normal");
  await evidence(page, info, "execution-restored"); expect(errors).toEqual([]);
});
