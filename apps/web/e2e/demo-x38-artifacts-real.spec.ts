import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { signInPrepared } from "./demo-credentials";
import { nextCode } from "./totp-sign-in";
import { activate, expectDialogTrap, escapeToTrigger, tabTo } from "./keyboard-audit";

// No route mocks. SQL below only installs explicit synthetic states into this
// disposable database; it never admits a scanner or claims a real scan occurred.
const email = "admin@regulait.local";
const raw = "X38_SYNTHETIC_MODEL_BYTES_NEVER_IN_THE_DOM";
function sql(query: string): string {
  const database = process.env.DATABASE_URL;
  if (!database || new URL(database).hostname !== "127.0.0.1" || new URL(database).pathname !== "/regulait_review_x38_oct10b") throw new Error("X38 requires its own loopback disposable database");
  return execFileSync("psql", [database, "-X", "-v", "ON_ERROR_STOP=1", "-At", "-c", query], { encoding: "utf8" }).trim();
}
function id(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) throw new Error("Invalid fixture UUID");
  return value;
}
async function signIn(page: Page) {
  expect(await signInPrepared(page, email, "X38-Disposable-Admin!", page.getByRole("heading", { name: /Welcome back/ }))).toBe(true);
}
function errorsOf(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("console", message => {
    if (message.type() === "error" && !/^Failed to load resource: the server responded with a status of (403|404|409|413)\b/.test(message.text())) errors.push(message.text());
  });
  return errors;
}
async function evidence(page: Page, info: TestInfo, name: string) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate(async t => {
      document.documentElement.dataset.theme = t; localStorage.setItem("regulait.theme", t);
      await Promise.all(document.getAnimations().map(a => a.finished.catch(() => undefined)));
    }, theme);
    const violations = (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations;
    expect(violations.map(v => `${v.id}: ${v.nodes.map(n => n.target.join(" ")).join("; ")}`), `${name} ${theme}`).toEqual([]);
    await page.screenshot({ path: info.outputPath(`${name}-${theme}.png`), fullPage: true });
    await expect(page.locator("body")).not.toContainText(raw);
  }
}
async function upload(page: Page, label: string, size = 100) {
  const filename = `x38-${label}-${randomUUID()}.bin`;
  const bytes = Buffer.alloc(size, 0); Buffer.from(raw).copy(bytes);
  await page.getByTestId("artifact-file").setInputFiles({ name: filename, mimeType: "application/octet-stream", buffer: bytes });
  const received = page.waitForResponse(r => new URL(r.url()).pathname === "/v1/model-artifacts" && r.request().method() === "POST");
  await activate(page, page.getByRole("button", { name: "Upload", exact: true }));
  const response = await received; expect(response.status(), await response.text()).toBe(201);
  const artifact = (await response.json()).artifact; id(artifact.id);
  return { ...artifact, filename } as { id: string; sha256: string; filename: string };
}
async function open(page: Page, artifact: { id: string; filename: string }) {
  await page.goto(`/ui/admin/admission?tab=artifacts&artifact=${artifact.id}`);
  const button = page.getByRole("button", { name: `Open ${artifact.filename}`, exact: true });
  await expect(button).toBeVisible();
  if (await button.getAttribute("aria-pressed") !== "true") await activate(page, button);
}
async function confirmDelete(page: Page, filename: string, checkTrap = false) {
  const trigger = page.getByRole("button", { name: `Delete ${filename}`, exact: true });
  await activate(page, trigger);
  let dialog = page.getByRole("dialog", { name: `Delete ${filename}?` });
  if (checkTrap) { await expectDialogTrap(page, dialog); await escapeToTrigger(page, dialog, trigger); await activate(page, trigger); dialog = page.getByRole("dialog", { name: `Delete ${filename}?` }); }
  await activate(page, dialog.getByRole("button", { name: "Delete", exact: true }));
}

test("actual cited-scan delete refuses before step-up and preserves inconclusive evidence", async ({ page }, info) => {
  await signIn(page); const errors = errorsOf(page);
  await page.goto("/ui/admin/admission?tab=artifacts");
  const artifact = await upload(page, "cited");
  const scan = randomUUID(), card = randomUUID(), evidenceId = randomUUID();
  sql(`INSERT INTO artifact_scans(id,artifact_id,artifact_sha256,format,verdict,issues,scanner_version) VALUES('${scan}','${artifact.id}','${artifact.sha256}','unrecognised','unknown','[]','synthetic-x38-fixture');
    INSERT INTO model_cards(id,agent_id,intended_use) SELECT '${card}',id,'X38 synthetic cited evidence fixture' FROM agents ORDER BY id LIMIT 1;
    INSERT INTO model_card_evidence(id,card_id,kind,artifact_scan_id) VALUES('${evidenceId}','${card}','engine_scan','${scan}');`);
  try {
    await open(page, artifact);
    await expect(page.getByTestId("artifact-retention")).toContainText("Kept for 30 days.");
    const response = page.waitForResponse(r => r.url().endsWith(`/v1/model-artifacts/${artifact.id}`) && r.request().method() === "DELETE");
    await confirmDelete(page, artifact.filename, true);
    const refused = await response; expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "artifact_in_use", citedScans: 1, unfinishedRuns: 0 });
    await expect(page.getByTestId("delete-error")).toContainText("still in use");
    await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toHaveCount(0);
    expect(sql(`SELECT count(*) FROM model_artifacts WHERE id='${artifact.id}'`)).toBe("1");
    expect(sql(`SELECT count(*) FROM audit_log WHERE object_id='${artifact.id}' AND rule_id='model-artifact-delete-refused' AND effect='deny'`)).toBe("1");
    await expect(page.locator('[data-testid="scan-status"][data-clean="true"]')).toHaveCount(0);
    await evidence(page, info, "cited-delete-refused"); expect(errors).toEqual([]);
  } finally { sql(`DELETE FROM model_card_evidence WHERE id='${evidenceId}'; DELETE FROM model_cards WHERE id='${card}'; DELETE FROM artifact_scans WHERE id='${scan}';`); }
});

test("actual unfinished-run delete refuses; terminal fixture permits confirmed real TOTP delete", async ({ page }, info) => {
  await signIn(page); const errors = errorsOf(page);
  await page.goto("/ui/admin/admission?tab=artifacts"); const artifact = await upload(page, "unfinished", 101);
  const run = randomUUID();
  sql(`INSERT INTO engine_runs(id,engine_id,engine_version,status,trigger,run_as_user_id,target_kind,target_artifact_id,config,config_hash,budget_usd,timeout_seconds,queue_expires_at)
    SELECT '${run}','modelscan','synthetic-x38-fixture','queued','manual',id,'artifact','${artifact.id}','{"sets":["scan"]}','synthetic-x38',1,600,now()+interval '1 hour' FROM users WHERE email='${email}';`);
  try {
    await open(page, artifact);
    const response = page.waitForResponse(r => r.url().endsWith(`/v1/model-artifacts/${artifact.id}`) && r.request().method() === "DELETE");
    await confirmDelete(page, artifact.filename);
    const refused = await response; expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ error: "artifact_in_use", citedScans: 0, unfinishedRuns: 1 });
    await expect(page.getByTestId("delete-error")).toContainText("still in use");
    await expect(page.getByRole("dialog", { name: "Confirm it's you" })).toHaveCount(0);
    await evidence(page, info, "unfinished-delete-refused");
    sql(`UPDATE engine_runs SET status='cancelled',finished_at=now(),error_code='test_cleanup' WHERE id='${run}'`);
    await open(page, artifact);
    await activate(page, page.getByRole("button", { name: `Delete ${artifact.filename}`, exact: true }));
    await evidence(page, info, "delete-confirmation");
    const needsStepUp = page.waitForResponse(r => r.url().endsWith(`/v1/model-artifacts/${artifact.id}`) && r.request().method() === "DELETE");
    await activate(page, page.getByRole("dialog").getByRole("button", { name: "Delete", exact: true }));
    const challenged = await needsStepUp; expect(challenged.status()).toBe(403);
    expect((await challenged.json()).error).toBe("step_up_required");
    let prompt = page.getByRole("dialog", { name: "Confirm it's you" });
    await expect(prompt).toBeVisible();
    expect(sql(`SELECT count(*) FROM model_artifacts WHERE id='${artifact.id}'`)).toBe("1");
    await expectDialogTrap(page, prompt);
    await evidence(page, info, "delete-step-up-required");
    await activate(page, prompt.getByRole("button", { name: "Cancel", exact: true }));
    expect(sql(`SELECT count(*) FROM model_artifacts WHERE id='${artifact.id}'`)).toBe("1");
    await confirmDelete(page, artifact.filename);
    prompt = page.getByRole("dialog", { name: "Confirm it's you" });
    await tabTo(page, prompt.getByLabel("Authenticator code")); await page.keyboard.type(await nextCode(email));
    const deleted = page.waitForResponse(r => r.url().endsWith(`/v1/model-artifacts/${artifact.id}`) && r.request().method() === "DELETE" && r.status() === 200);
    await activate(page, prompt.getByRole("button", { name: "Confirm with code" }));
    expect((await (await deleted).json()).deleted).toMatchObject({ id: artifact.id, object: "deleted" });
    await expect(page.getByRole("button", { name: `Open ${artifact.filename}`, exact: true })).toHaveCount(0);
    expect(sql(`SELECT count(*) FROM model_artifacts WHERE id='${artifact.id}'`)).toBe("0");
    expect(existsSync(`${process.env.REGULAIT_MODEL_ARTIFACT_DIR}/sha256/${artifact.sha256}`)).toBe(false);
    await evidence(page, info, "artifact-deleted"); expect(errors).toEqual([]);
  } finally { sql(`DELETE FROM engine_runs WHERE id='${run}'`); }
});

test("real uploader and organisation count/byte quotas refuse with readable UI errors", async ({ page }, info) => {
  await signIn(page); const errors = errorsOf(page);
  await page.goto("/ui/admin/admission?tab=artifacts");
  const saved = sql("SELECT row_to_json(x) FROM (SELECT model_artifact_uploader_quota_count,model_artifact_org_quota_count,model_artifact_uploader_quota_megabytes,model_artifact_org_quota_megabytes FROM org_settings) x");
  const settings = JSON.parse(saved) as Record<string, number>;
  const count = Number(sql("SELECT count(*) FROM model_artifacts")); expect(count).toBeGreaterThan(0);
  try {
    for (const [scope, measure] of [["uploader", "count"], ["org", "count"], ["uploader", "bytes"], ["org", "bytes"]] as const) {
      sql(`UPDATE org_settings SET model_artifact_uploader_quota_count=${scope === "uploader" && measure === "count" ? count : 20}, model_artifact_org_quota_count=${scope === "org" && measure === "count" ? count : 200},model_artifact_uploader_quota_megabytes=${scope === "uploader" && measure === "bytes" ? 1 : 2048},model_artifact_org_quota_megabytes=${scope === "org" && measure === "bytes" ? 1 : 20480}`);
      const bytes = Buffer.alloc(measure === "bytes" ? 2 * 1024 * 1024 : 102, 0); Buffer.from(raw).copy(bytes);
      await page.getByTestId("artifact-file").setInputFiles({ name: `x38-refused-${scope}-${measure}.bin`, mimeType: "application/octet-stream", buffer: bytes });
      const response = page.waitForResponse(r => new URL(r.url()).pathname === "/v1/model-artifacts" && r.request().method() === "POST");
      await activate(page, page.getByRole("button", { name: "Upload", exact: true }));
      const refused = await response; expect(refused.status()).toBe(measure === "count" ? 409 : 413);
      expect(await refused.json()).toMatchObject({ error: "artifact_quota_exceeded", scope, measure });
      await expect(page.getByTestId("upload-error")).toContainText(/quota/i);
      expect(Number(sql("SELECT count(*) FROM model_artifacts"))).toBe(count);
      expect(existsSync(`${process.env.REGULAIT_MODEL_ARTIFACT_DIR}/sha256/${createHash("sha256").update(bytes).digest("hex")}`)).toBe(false);
      await evidence(page, info, `quota-${scope}-${measure}`);
    }
    expect(errors).toEqual([]);
  } finally { sql(`UPDATE org_settings SET ${Object.entries(settings).map(([key, value]) => `${key}=${value}`).join(",")}`); }
});

test("actual settings permission loss shows unknown retention without inventing a date", async ({ page }, info) => {
  await signIn(page); const errors = errorsOf(page);
  // The fresh browser has never mounted this tab, so its settings query has no
  // cached successful result. Its existing shell remains mounted during demotion.
  sql(`UPDATE users SET is_admin=false WHERE email='${email}'`);
  try {
    const settings = page.waitForResponse(r => r.url().endsWith("/v1/org/settings") && r.request().method() === "GET");
    await tabTo(page, page.getByRole("textbox", { name: "Filter navigation" })); await page.keyboard.type("Admission review");
    await activate(page, page.getByRole("link", { name: "Admission review", exact: true }));
    await tabTo(page, page.getByRole("tab", { name: "Skills and servers", exact: true }));
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Model artifacts", exact: true })).toHaveAttribute("aria-selected", "true");
    const refused = await settings; expect(refused.status()).toBe(403); expect((await refused.json()).error).toBe("admin_only");
    const actual = await page.request.get("/v1/model-artifacts"); expect(actual.status()).toBe(200);
    const artifact = (await actual.json()).artifacts[0]; expect(artifact).toBeTruthy();
    expect((await page.request.get(`/v1/model-artifacts/${artifact.id}`)).status()).toBe(200);
    await activate(page, page.getByRole("button", { name: `Open ${artifact.filename}`, exact: true }));
    await expect(page.getByTestId("artifact-retention")).toContainText("retention period and deletion date are unknown here");
    await expect(page.getByTestId("artifact-retention")).not.toContainText(/Kept for|deleted from/);
    await evidence(page, info, "retention-unknown-real-permission-loss"); expect(errors).toEqual([]);
  } finally { sql(`UPDATE users SET is_admin=true WHERE email='${email}'`); }
});
