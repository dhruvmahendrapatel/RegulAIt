import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { generateKeyPairSync } from "node:crypto";
import { activate, escapeToTrigger, expectDialogTrap, selectAt, tabTo } from "./keyboard-audit";

const url = "/ui/e2e/fixtures/workload-identity-preview.html";
const calls = (page: Page) => page.evaluate(() => window.identityPreview.calls);
async function open(page: Page, mode = "") {
  await page.goto(`${url}?mode=${mode}`);
  await expect(page.getByRole("heading", { name: "Workload identities", exact: true })).toBeVisible();
}
async function manage(page: Page) {
  await page.getByRole("button", { name: "Manage spiffe://demo.example/regulait/agent/identity-a" }).click();
  await expect(page.getByRole("button", { name: "Edit stewards and environments", exact: true })).toBeVisible();
}
async function verify(page: Page) {
  const prompt = page.getByRole("dialog", { name: "Mock identity management verification" });
  await expect(prompt).toBeVisible();
  await prompt.getByRole("button", { name: "Confirm mock step-up" }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByText("Workload identity change recorded.", { exact: true }).last()).toBeVisible();
}
async function tree(page: Page) {
  await page.getByLabel("Run ID").fill("synthetic-run");
  await page.getByRole("button", { name: "Load delegation tree" }).click();
}

test("empty, unavailable and unreadable inventories never invent permissions or expose server detail", async ({ page }) => {
  await open(page, "empty");
  await expect(page.getByText("No workload identities", { exact: true })).toBeVisible();
  await open(page, "unavailable");
  await expect(page.getByText("Workload identity management is not available", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add identity", exact: true })).toHaveCount(0);
  await open(page, "read-error");
  await expect(page.getByText("Workload identities could not be read. No empty or active state is inferred.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("SYNTHETIC_UNTRUSTED");
  await expect(page.getByText("No workload identities", { exact: true })).toHaveCount(0);
});

test("identity creation requires a steward, permits explicit empty environments and retries the identical request after step-up", async ({ page }) => {
  await open(page, "empty");
  await page.getByRole("button", { name: "Add identity", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add identity", exact: true });
  await form.getByRole("button", { name: "Add identity", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Choose the subject this identity belongs to.");
  await form.getByLabel("Subject", { exact: true }).selectOption("00000000-0000-4000-8000-000000000005");
  await form.getByRole("button", { name: "Add identity", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText("Choose at least one steward.");
  await form.getByLabel("Synthetic steward", { exact: true }).check();
  expect(await calls(page)).toHaveLength(0);
  await expect(form).toContainText("Empty environments allow no environment.");
  await form.getByRole("button", { name: "Add identity", exact: true }).click();
  await verify(page);
  const sent = await calls(page);
  expect(sent).toHaveLength(2);
  expect(sent[0]!.command).toEqual(sent[1]!.command);
  expect(sent[0]!.request).toEqual(sent[1]!.request);
  expect(sent[0]!.headers).toEqual({});
  expect(sent[1]!.headers["x-regulait-step-up"]).toMatch(/^synthetic-step-up-/);
  expect(sent[1]!.request).toEqual({ method: "POST", path: "/v1/workload-identities", body: { kind: "agent", agentId: "00000000-0000-4000-8000-000000000005", sponsorUserIds: ["00000000-0000-4000-8000-000000000001"], environments: [] } });
  expect(sent[1]!.command).toEqual({ operation: "create_identity", kind: "agent", subjectId: "00000000-0000-4000-8000-000000000005", stewardIds: ["00000000-0000-4000-8000-000000000001"], environments: [] });
});

test("cancelled destructive confirmation and step-up leave identity active; suspend, restore and revoke each verify", async ({ page }) => {
  await open(page); await manage(page);
  await page.getByRole("button", { name: "Suspend identity", exact: true }).click();
  await page.getByRole("dialog", { name: "Suspend identity?" }).getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await calls(page)).toHaveLength(0);
  await page.getByRole("button", { name: "Suspend identity", exact: true }).click();
  await page.getByRole("dialog", { name: "Suspend identity?" }).getByRole("button", { name: "Suspend identity", exact: true }).click();
  await page.getByRole("button", { name: "Cancel verification" }).click();
  await expect(page.getByText("Change not recorded", { exact: true })).toBeVisible();
  expect(await calls(page)).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Suspend identity", exact: true })).toBeEnabled();
  for (const [label, state] of [["Suspend identity", "suspended"], ["Restore identity", "active"], ["Revoke identity", "revoked"]]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await page.getByRole("dialog", { name: `${label}?` }).getByRole("button", { name: label, exact: true }).click();
    await verify(page);
    await expect.poll(() => page.evaluate(() => window.identityPreview.inventory.identities[0]!.status)).toBe(state);
  }
  await expect(page.getByRole("button", { name: "Edit stewards and environments" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Add public credential", exact: true })).toBeDisabled();
});

test("public key add and rotation never send private data; revocation is explicit and verified", async ({ page }) => {
  await open(page); await manage(page);
  const pair = generateKeyPairSync("ed25519");
  const publicKey = pair.publicKey.export({ format: "jwk" });
  await page.getByRole("button", { name: "Add public credential", exact: true }).click();
  let form = page.getByRole("dialog", { name: "Add public credential", exact: true });
  await form.getByLabel("Public JWK file", { exact: true }).setInputFiles({ name: "public.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...publicKey, d: "SYNTHETIC_PRIVATE_MARKER" })) });
  await expect(form.getByRole("alert")).toContainText("Private or shared key material is refused");
  await form.getByRole("button", { name: "Add public credential", exact: true }).click();
  expect(await calls(page)).toHaveLength(0);
  await expect(page.locator("body")).not.toContainText("SYNTHETIC_PRIVATE_MARKER");
  await form.getByLabel("Public JWK file", { exact: true }).setInputFiles({ name: "public.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...publicKey, kid: "DO_NOT_FORWARD_METADATA" })) });
  await expect(form.getByText(/Public thumbprint:/)).toBeVisible();
  await form.getByRole("button", { name: "Add public credential", exact: true }).click();
  await verify(page);
  expect((await calls(page))[1]!.command).toMatchObject({ operation: "add_credential", publicKey });
  expect(JSON.stringify(await calls(page))).not.toContain("DO_NOT_FORWARD_METADATA");
  await page.getByRole("button", { name: "Rotate public key", exact: true }).first().click();
  form = page.getByRole("dialog", { name: "Rotate public key", exact: true });
  await expect(form).toContainText("previous credential remains valid until its recorded expiry");
  await form.getByLabel("Public JWK file", { exact: true }).setInputFiles({ name: "public.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(publicKey)) });
  await expect(form.getByText(/Public thumbprint:/)).toBeVisible();
  await form.getByRole("button", { name: "Rotate public key", exact: true }).click(); await verify(page);
  const original = page.getByRole("row").filter({ hasText: "synthetic-public-thumbprint" });
  await expect(original).toContainText("Active");
  await original.getByRole("button", { name: "Revoke credential synthetic-public-thumbprint" }).click();
  const confirm = page.getByRole("dialog", { name: "Revoke credential?" });
  await expect(confirm).toContainText("Every token and grant this credential authenticated");
  await confirm.getByRole("button", { name: "Revoke credential", exact: true }).click(); await verify(page);
  await expect(original).toContainText("Revoked");
  await expect(page.locator("body")).not.toContainText("synthetic-step-up-");
});

test("all own grant kinds start empty, narrow authority and require verified writes and removal", async ({ page }) => {
  await open(page); await manage(page);
  await expect(page.getByText("No own grants", { exact: true })).toBeVisible();
  await expect(page.getByText(/Its stewards' permissions are not copied/)).toBeVisible();
  for (const [kind, target] of [["tool", "00000000-0000-4000-8000-000000000006"], ["server", "00000000-0000-4000-8000-000000000007"], ["connector", "00000000-0000-4000-8000-000000000008"], ["agent_invoke", "00000000-0000-4000-8000-000000000005"], ["role", "00000000-0000-4000-8000-000000000009"]]) {
    await page.getByRole("button", { name: "Add own grant", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Add own grant", exact: true });
    await form.getByLabel("Grant kind", { exact: true }).selectOption(kind);
    await form.getByLabel("Grant target", { exact: true }).selectOption(target);
    if (kind === "tool") {
      await form.getByRole("button", { name: "Add own grant", exact: true }).click();
      await expect(form.getByRole("alert")).toContainText("specific tool");
      await form.getByLabel("Tool", { exact: true }).selectOption("read-record");
    }
    await expect(form.getByLabel("Access", { exact: true })).toHaveCount(0);
    if (kind === "server") await expect(form.getByLabel("Only read-only tools")).toBeChecked();
    if (kind === "agent_invoke") await form.getByLabel("Allowed modes", { exact: true }).fill("chat, plan");
    if (kind === "connector") await form.getByLabel("Allowed objects", { exact: true }).fill("synthetic-record");
    await form.getByRole("button", { name: "Add own grant", exact: true }).click(); await verify(page);
  }
  expect((await calls(page)).filter(c => c.headers["x-regulait-step-up"])).toHaveLength(5);
  const verified = (await calls(page)).filter(c => c.headers["x-regulait-step-up"]);
  expect(verified[4]!.request).toMatchObject({ method: "PUT", path: "/v1/workload-identities/00000000-0000-4000-8000-000000000003/grants", body: {
    tools: [{ serverId: "00000000-0000-4000-8000-000000000006", toolName: "read-record" }],
    servers: [{ serverId: "00000000-0000-4000-8000-000000000007", readOnlyAll: true }],
    agents: [{ agentId: "00000000-0000-4000-8000-000000000005", allowedModes: ["chat", "plan"] }],
    connectors: [{ connectorId: "00000000-0000-4000-8000-000000000008", mode: "read", allowedObjects: ["synthetic-record"] }],
    roleIds: ["00000000-0000-4000-8000-000000000009"] } });
  await page.getByRole("button", { name: "Remove grant for Synthetic reader role" }).click();
  await page.getByRole("dialog", { name: "Remove own grant?" }).getByRole("button", { name: "Remove grant", exact: true }).click(); await verify(page);
  await expect(page.getByRole("button", { name: "Remove grant for Synthetic reader role" })).toHaveCount(0);
});

test("delegation shows per-edge accounting and cascade confirmation; unreadable budget and expiry stay unknown", async ({ page }) => {
  await open(page); await tree(page);
  const child = page.getByRole("row").filter({ hasText: "Child synthetic actor" }).last();
  await expect(child).toContainText("Allocated $60.00"); await expect(child).toContainText("Drawn $10.00; released $0.00");
  await child.getByRole("button", { name: "Revoke grant 00000000-0000-4000-8000-000000000012 and descendants" }).click();
  const confirm = page.getByRole("dialog", { name: "Revoke grant and descendants?" });
  await expect(confirm).toContainText("return to the immediate parent, once only");
  await confirm.getByRole("button", { name: "Revoke grant and descendants", exact: true }).click(); await verify(page);
  await expect(child).toContainText("released $50.00"); await expect(child).toContainText("revoked");
  await open(page, "unknown-budget"); await tree(page);
  await expect(page.getByRole("row").filter({ hasText: "Child synthetic actor" }).last()).toContainText("Cap Unmeasured");
  await open(page, "unknown-expiry"); await tree(page);
  await expect(page.getByRole("button", { name: "Revoke grant 00000000-0000-4000-8000-000000000012 and descendants" })).toBeDisabled();
  await expect(page.getByText("Validity unmeasured", { exact: true })).toBeVisible();
  await open(page, "cycle"); await tree(page);
  await expect(page.getByText(/delegation chain has a cycle/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Revoke grant .* and descendants/ })).toHaveCount(0);
});

test("read and write failures use safe copy; editing stewards and environment preserves the verified command", async ({ page }) => {
  await open(page, "detail-error"); await manage(page);
  await expect(page.getByText("Credentials and own grants could not be read. No empty or active state is inferred.")).toBeVisible();
  await open(page, "tree-error"); await tree(page);
  await expect(page.getByText(/delegation tree could not be read/i)).toBeVisible();
  await open(page, "write-error"); await manage(page);
  await page.getByRole("button", { name: "Edit stewards and environments" }).click();
  const form = page.getByRole("dialog", { name: "Edit identity", exact: true });
  await form.getByLabel("Synthetic co-steward", { exact: true }).check(); await form.getByLabel("byoc", { exact: true }).check();
  await form.getByRole("button", { name: "Edit identity", exact: true }).click();
  await page.getByRole("button", { name: "Confirm mock step-up" }).click();
  await expect(page.getByText("Change not recorded", { exact: true })).toBeVisible();
  const sent = await calls(page); expect(sent[0]!.command).toEqual(sent[1]!.command);
  expect(sent[1]!.command).toMatchObject({ stewardIds: ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"], environments: ["demo", "byoc"] });
  await expect(page.locator("body")).not.toContainText("SYNTHETIC_UNTRUSTED");
});

test("keyboard-only forms trap and restore focus; identity, detail, tree and modal pass axe in both themes", async ({ page }, info) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await open(page); await manage(page); await tree(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(async t => { document.documentElement.dataset.theme = t; await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined))); }, theme);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`identity-${theme}.png`), fullPage: true });
    const trigger = page.getByRole("button", { name: "Add identity", exact: true });
    await activate(page, trigger);
    const dialog = page.getByRole("dialog", { name: "Add identity", exact: true });
    await expectDialogTrap(page, dialog);
    await selectAt(page, dialog.getByLabel("Workload kind", { exact: true }), "worker_runtime");
    await tabTo(page, dialog.getByLabel("Synthetic steward", { exact: true })); await page.keyboard.press("Space");
    await tabTo(page, dialog.getByLabel("demo", { exact: true })); await page.keyboard.press("Space");
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await escapeToTrigger(page, dialog, trigger);
  }
  expect(errors).toEqual([]);
});


test("empty explicit modes and objects grant no implicit authority", async ({ page }) => {
  await open(page); await manage(page);
  for (const [kind, target] of [["agent_invoke", "00000000-0000-4000-8000-000000000005"], ["connector", "00000000-0000-4000-8000-000000000008"]]) {
    await page.getByRole("button", { name: "Add own grant", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Add own grant", exact: true });
    await form.getByLabel("Grant kind", { exact: true }).selectOption(kind);
    await form.getByLabel("Grant target", { exact: true }).selectOption(target);
    if (kind === "agent_invoke") await expect(form.getByLabel("Allowed modes", { exact: true })).toHaveValue("");
    else await expect(form.getByLabel("Allowed objects", { exact: true })).toHaveValue("");
    await form.getByRole("button", { name: "Add own grant", exact: true }).click(); await verify(page);
  }
  const last = (await calls(page)).at(-1)!;
  expect(last.request).toMatchObject({ method: "PUT", body: {
    agents: [{ agentId: "00000000-0000-4000-8000-000000000005", allowedModes: [] }],
    connectors: [{ connectorId: "00000000-0000-4000-8000-000000000008", mode: "read", allowedObjects: [] }],
  } });
  await expect(page.getByText("No modes allowed", { exact: true })).toBeVisible();
  await expect(page.getByText("Read; no objects allowed", { exact: true })).toBeVisible();
});

test("root delegation action is hidden unless both stewardship and project access are known", async ({ page }) => {
  for (const mode of ["not-steward", "no-project-access", "project-access-unknown", "access-unknown"]) {
    await open(page, mode); await manage(page);
    await expect(page.getByRole("button", { name: "Preview root delegation", exact: true })).toHaveCount(0);
    expect(await calls(page)).toHaveLength(0);
  }
  await open(page); await manage(page);
  await expect(page.getByRole("button", { name: "Preview root delegation", exact: true })).toBeVisible();
});

test("strict root preview requires a cap, defaults to fifteen minutes and creates no proof or token", async ({ page }) => {
  await open(page); await manage(page);
  await page.getByRole("button", { name: "Preview root delegation", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Preview root delegation", exact: true });
  await expect(form.getByLabel("Lifetime (minutes)", { exact: true })).toHaveValue("15");
  await expect(form.getByLabel("Root cap (micro-dollars)", { exact: true })).toHaveValue("");
  await form.getByRole("button", { name: "Review mock delegation" }).click();
  await expect(form.getByRole("alert")).toContainText("Name a root-grant cap");
  await form.getByLabel("Root cap (micro-dollars)", { exact: true }).fill("1000000");
  await form.getByLabel("Lifetime (minutes)", { exact: true }).fill("16");
  await form.getByRole("button", { name: "Review mock delegation" }).click();
  await expect(form.getByRole("alert")).toContainText("strict limit is 15 minutes");
  await form.getByLabel("Lifetime (minutes)", { exact: true }).fill("15");
  await form.getByRole("button", { name: "Review mock delegation" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Mock root delegation reviewed" })).toContainText("cap $1.00; lifetime 15 minutes. No proof, grant or token was created.");
  expect(await calls(page)).toHaveLength(0);
  await expect(page.locator("body")).toContainText("delegation_depth_unenforced");
  await expect(page.locator("body")).toContainText("The child's resource must exactly equal its parent's audience");
});

test("only an explicit cap relaxation permits an uncapped mock root", async ({ page }) => {
  await open(page, "cap-setting-unknown"); await manage(page);
  await page.getByRole("button", { name: "Preview root delegation", exact: true }).click();
  await page.getByRole("button", { name: "Review mock delegation" }).click();
  await expect(page.getByRole("alert")).toContainText("Name a root-grant cap");
  await open(page, "cap-relaxed"); await manage(page);
  await page.getByRole("button", { name: "Preview root delegation", exact: true }).click();
  await page.getByRole("button", { name: "Review mock delegation" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Mock root delegation reviewed" })).toContainText("uncapped under an audited admin relaxation");
  expect(await calls(page)).toHaveLength(0);
});

test("root delegation preview supports keyboard focus and axe in both themes", async ({ page }, info) => {
  await open(page); await manage(page);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, theme);
    const trigger = page.getByRole("button", { name: "Preview root delegation", exact: true });
    await activate(page, trigger);
    const dialog = page.getByRole("dialog", { name: "Preview root delegation", exact: true });
    await expectDialogTrap(page, dialog);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze()).violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`delegation-${theme}.png`), fullPage: true });
    await escapeToTrigger(page, dialog, trigger);
  }
});

test("a failed inventory refresh hides cached delegation eligibility", async ({ page }) => {
  await open(page, "refresh-read-error"); await manage(page);
  await expect(page.getByRole("button", { name: "Preview root delegation", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit stewards and environments" }).click();
  await page.getByRole("dialog", { name: "Edit identity", exact: true }).getByRole("button", { name: "Edit identity", exact: true }).click();
  await verify(page);
  await expect(page.getByText("Workload identities could not be read. No empty or active state is inferred.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview root delegation", exact: true })).toHaveCount(0);
});

test("a grant revision changed during step-up refuses the frozen replacement", async ({ page }) => {
  await open(page, "stale-grant-revision"); await manage(page);
  await page.getByRole("button", { name: "Add own grant", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add own grant", exact: true });
  await form.getByLabel("Grant target", { exact: true }).selectOption("00000000-0000-4000-8000-000000000006");
  await form.getByLabel("Tool", { exact: true }).selectOption("read-record");
  await form.getByRole("button", { name: "Add own grant", exact: true }).click();
  await page.getByRole("button", { name: "Confirm mock step-up" }).click();
  await expect(page.getByText("Change not recorded", { exact: true })).toBeVisible();
  await expect(page.getByText("No own grants", { exact: true })).toBeVisible();
  const sent = await calls(page);
  expect(sent).toHaveLength(2);
  expect(sent[0]!.request).toEqual(sent[1]!.request);
  expect(sent[1]!.request.body).toMatchObject({ revision: 0 });
});
