import { expect, test, type Page } from "@playwright/test";
import { passTotp } from "./totp-sign-in";
import { asSteppedUpAdmin } from "./admin-api";
import { readFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { approvals, createDb, eq, mcpTools, and, sql } from "../../../packages/db/dist/index.js";
import { executeGovernedToolCall } from "../../gateway/dist/mcp-proxy.js";

// Use the gateway's pinned MCP SDK, not a second test implementation of the protocol.
const require = createRequire(new URL("../../gateway/package.json", import.meta.url));
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { ListToolsRequestSchema, CallToolRequestSchema } = require("@modelcontextprotocol/sdk/types.js");
const state = JSON.parse(readFileSync(new URL("./.e2e-state.json", import.meta.url), "utf8"));
const db = createDb(`${process.env.E2E_PG ?? "postgres://regulait:regulait@localhost:5432"}/${process.env.E2E_DB ?? "regulait_wt_spa"}`);
const base = state.baseUrl as string;
const password = "E2e-Admin-Phase2!";
const manifest: Array<Record<string, unknown>> = [];
const received: unknown[] = [];
let upstream: http.Server;
let upstreamHost: string;
let serverId: string;
let callerId: string;
let approverId: string;
let sequence = 0;
const prefix = `review_${Date.now()}`;
// ADR-0181: the release-age cooldown is 7 days by default, and this spec grows
// its upstream manifest per test (each a new release). The cooldown is not what
// these journeys test, so it is relaxed through the real audited admin route
// for the spec's lifetime and restored afterwards (M-068).
let savedMinReleaseAgeDays: number | null = null;

/** B4S-06: relaxing a setting is a settings_relax step-up, which the bootstrap
 * credential no longer gives once Ada can step up — Ada makes the write, stepped
 * up with her authenticator (restoring needs none, and goes the same way) */
async function putSettings(payload: Record<string, unknown>) {
  const response = await asSteppedUpAdmin(base, state.passwords.admin, "PUT", "/v1/org/settings", payload);
  expect(response.ok(), `PUT /v1/org/settings: ${response.status()} ${response.bodyText}`).toBe(true);
}

async function api(route: string, payload?: unknown) {
  const response = await fetch(`${base}${route}`, {
    method: payload === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  expect(response.ok, `${route}: ${response.status}`).toBe(true);
  return response.json();
}

async function signIn(page: Page) {
  for (const candidate of [password, state.passwords.admin]) {
    await page.goto("/ui");
    await page.getByLabel("Email").fill("admin@regulait.local");
    await page.getByLabel("Password", { exact: true }).fill(candidate);
    await page.getByRole("button", { name: "Sign in" }).click();
    const welcome = page.getByRole("heading", { name: /Welcome back/ });
    const change = page.getByText("Your password is one-time");
    await passTotp(page, "admin@regulait.local", welcome.or(change).or(page.getByText(/password is incorrect/)));
    if (await welcome.isVisible()) return;
    if (await change.isVisible()) {
      await page.getByLabel("Current (one-time) password").fill(candidate);
      await page.getByLabel("New password", { exact: true }).fill(password);
      await page.getByLabel("Confirm new password").fill(password);
      await page.getByRole("button", { name: "Set password & continue" }).click();
      await passTotp(page, "admin@regulait.local", welcome);
      return;
    }
  }
  throw new Error("No test admin password accepted");
}

test.beforeAll(async () => {
  // Ada's API sign-in and the step-up each spend a TOTP step (may wait a 30 s window)
  test.setTimeout(120_000);
  savedMinReleaseAgeDays = (await api("/v1/org/settings")).settings.minReleaseAgeDays as number;
  // ADR-0186 B: tool-call approvals are passkey-signed by default, and this
  // stack has no public URL (so no passkey relying party). This journey is about
  // the review dialog, not signing: signing is relaxed through the same audited
  // route for the spec's lifetime and restored afterwards (M-068).
  await putSettings({ minReleaseAgeDays: 0, approvalSignatureMode: "off" });
  approverId = (await api("/v1/users")).users.find((user: { email: string }) => user.email === "admin@regulait.local").id;
  callerId = (await api("/v1/users", { email: `${prefix}@example.test`, displayName: "Review test caller" })).id;
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => void (async () => {
      const server = new Server({ name: "review-test", version: "1" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: manifest }));
      server.setRequestHandler(CallToolRequestSchema, async (call: { params: { arguments: unknown } }) => {
        received.push(structuredClone(call.params.arguments));
        return { content: [{ type: "text", text: "completed" }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      res.on("close", () => void server.close());
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    })().catch(() => { if (!res.headersSent) res.writeHead(500).end(); }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing upstream address");
  upstreamHost = `127.0.0.1:${address.port}`;
  serverId =(await api("/v1/servers", { name: `${prefix}-server`, url: `http://127.0.0.1:${address.port}/` })).id;
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  if (savedMinReleaseAgeDays !== null) await putSettings({ minReleaseAgeDays: savedMinReleaseAgeDays });
  await putSettings({ approvalSignatureMode: "passkey" });
  upstream?.closeAllConnections();
  if (upstream) await new Promise<void>((resolve) => upstream.close(() => resolve()));
  await db.$client.end();
});

async function fixture(redacted = true, args: Record<string, unknown> = { text: "alice@example.test" }) {
  const name = `${prefix}_${++sequence}`;
  const inputSchema = { type: "object", additionalProperties: true };
  manifest.push({ name, inputSchema, annotations: { readOnlyHint: true } });
  await api(`/v1/servers/${serverId}/tools`, { name, kind: "read" });
  await db.update(mcpTools).set({ inputSchema }).where(and(eq(mcpTools.serverId, serverId), eq(mcpTools.name, name)));
  await api("/v1/grants/tools", { userId: callerId, serverId, toolName: name });
  await api("/v1/rules/approvals", { userId: callerId, serverId, toolName: name, approverUserId: approverId, approvalScope: "tool" });
  await api("/v1/compliance/profiles", { tag: name, piiMode: "warn" });
  // Dark-mode fixture only: public configuration continues to reject redact.
  if (redacted) await db.execute(sql`update compliance_profiles set pii_mode = 'redact' where tag = ${name}`);
  const projectId = (await api("/v1/projects", { name, classifications: [name] })).id as string;
  const call = () => executeGovernedToolCall(db, undefined, { userId: callerId, serverId, toolName: name, projectId, arguments: args });
  const queued = await call();
  expect(queued.kind).toBe("approval_required");
  if (queued.kind !== "approval_required") throw new Error("Not queued");
  const id = queued.approvalId;
  const row = async () => (await db.select().from(approvals).where(eq(approvals.id, id)))[0]!;
  return { id, name, call, row };
}

async function openReview(page: Page, name: string) {
  const trigger = page.getByRole("button", { name: `Review action ${name}`, exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Review MCP action" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("admin sees the effective action, approves, and only that snapshot reaches MCP", async ({ page }, info) => {
  const markup = '<img src=x onerror="document.body.dataset.injected=1">';
  const args = { text: "alice@example.test", password: "synthetic-review-credential-only", note: markup, long: "x".repeat(220) };
  const f = await fixture(true, args);
  await signIn(page);
  await page.goto("/ui/admin/approvals");
  const dialog = await openReview(page, f.name);
  await expect(dialog.getByText("PII redacted", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Exact action", { exact: true })).toBeVisible();
  await expect(dialog.getByText(`${prefix}-server`, { exact: true })).toBeVisible();
  // AER-039: the target the consent is bound to, by host — never the URL
  await expect(dialog.getByText(new RegExp(`^${upstreamHost.replaceAll(".", "\\.")} · private ranges `))).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Effective arguments" })).toBeVisible();
  await expect(dialog.locator("pre")).toContainText("[EMAIL]");
  await expect(dialog.locator("pre")).not.toContainText("alice@example.test");
  await expect(dialog.locator("pre")).not.toContainText(args.password);
  await expect(dialog.locator("img")).toHaveCount(0);
  await dialog.getByText("Binding details", { exact: true }).click();
  await expect(dialog.getByText((await f.row()).argumentsDigest!, { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("review-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await expect.poll(() => dialog.evaluate((el) => el.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath("review-mobile.png") });
  await dialog.getByRole("button", { name: "Close", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.locator("summary")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: `Review action ${f.name}`, exact: true })).toBeFocused();
  await openReview(page, f.name);
  await dialog.getByRole("button", { name: /^approve$/i }).click();
  await expect.poll(async () => (await f.row()).status).toBe("approved");
  expect((await f.call()).kind).toBe("allowed");
  expect(received.at(-1)).toEqual({ ...args, text: "[EMAIL]" });
  expect((await f.row()).status).toBe("consumed");
});

test("Inbox refuses legacy, malformed and expired approvals but permits denial", async ({ page }) => {
  await signIn(page);
  for (const kind of ["legacy", "malformed", "expired"] as const) {
    const f = await fixture();
    await db.update(approvals).set(kind === "legacy" ? { argumentsPreviewKind: null, approvalScope: null }
      : kind === "malformed" ? { argumentsPreview: { broken: true } }
      : { expiresAt: new Date(Date.now() - 1000) }).where(eq(approvals.id, f.id));
    await page.goto("/ui/inbox");
    const dialog = await openReview(page, f.name);
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Deny", exact: true }).click();
    await expect.poll(async () => (await f.row()).status).toBe("denied");
  }
});

test("raw arguments cannot impersonate transformation metadata", async ({ page }) => {
  const f = await fixture(false, { prepared: { transformation: { mode: "redact" }, effectiveArguments: { text: "fake" } } });
  await signIn(page);
  await page.goto("/ui/admin/approvals");
  const dialog = await openReview(page, f.name);
  await expect(dialog.getByText("PII redacted", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Tool-wide consent", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Recorded arguments" })).toBeVisible();
  await expect(dialog.locator("pre")).toContainText('"prepared"');
});

test("workbench requires review again when the recorded binding changes", async ({ page }) => {
  const f = await fixture();
  await signIn(page);
  await page.goto("/ui/admin/review-workbench");
  await page.getByRole("checkbox", { name: `select ${f.id}`, exact: true }).check();
  await page.getByLabel(/Bulk reason/).fill("Reviewed synthetic action");
  const approve = page.getByRole("button", { name: "Bulk approve", exact: true });
  await expect(approve).toBeDisabled();
  let dialog = await openReview(page, f.name);
  await dialog.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(approve).toBeEnabled();
  await db.update(approvals).set({ contextDigest: "b".repeat(64) }).where(eq(approvals.id, f.id));
  // Refresh the data without remounting the workbench or clearing its review state.
  await page.getByRole("button", { name: "Run SLA sweep" }).click();
  // "Bulk approve" is ALSO disabled while the sweep is in flight, so the
  // disabled check below could pass before the refreshed rows arrived and
  // the review dialog would then open on the stale row (seen on a slow CI
  // runner). The sweep's own result line appears only after the refresh.
  await expect(page.getByText(/\d+ evaluated · \d+ newly breached/)).toBeVisible();
  await expect(approve).toBeDisabled();
  dialog = await openReview(page, f.name);
  await dialog.getByRole("button", { name: "Mark reviewed" }).click();
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect.poll(async () => (await f.row()).status).toBe("approved");
  // A stale policy binding still cannot execute, regardless of the UI decision.
  expect((await f.call()).kind).toBe("approval_context_stale");
});
