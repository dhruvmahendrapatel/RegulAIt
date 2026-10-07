/**
 * ADR-0173 §1 — governed tool use in builder agents, against a REAL seeded
 * gateway and a REAL MCP server (the demo MCP double, `apps/gateway/dist/
 * demo-mcp-server.js`, started here on its own port). The model is the keyless
 * mock provider: `<<use-tool:NAME>>` makes it call NAME once and then quote
 * the tool's result.
 *
 *  1. An admin registers the MCP server and its tools, grants Dana two of
 *     them, and adds an organisation approval rule on one (approver: admin).
 *  2. Dana's agent calls a granted tool: the step shows Done and the reply
 *     quotes what the real server returned.
 *  3. The same tool marked "Ask first" pauses with the exact call; Dana
 *     approves it in the thread and the turn finishes.
 *  4. The approval-ruled tool waits "for approval by" the admin; the admin
 *     decides in the approvals queue, and Dana's thread finishes by itself.
 *
 * Sign-in is order-independent (M-017). Zero console errors are asserted.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { passTotp } from "./totp-sign-in";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const state = JSON.parse(readFileSync(path.join(here, ".e2e-state.json"), "utf8")) as {
  passwords: { admin: string; dana: string; avery: string };
  baseUrl: string;
};
const ADMIN_PASSWORD = "E2e-Admin-Phase2!";
const DANA_PASSWORD = "E2e-Rewrite-2026!";
const CSRF = { "x-regulait-csrf": "1" };
/** an org-settings write as the deployment's bootstrap credential (it needs no step-up) */
async function bootSettings(payload: Record<string, unknown>) {
  const res = await fetch(`${state.baseUrl}/v1/org/settings`, {
    method: "PUT",
    headers: { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  expect(res.ok, `PUT /v1/org/settings: ${res.status} ${await res.text()}`).toBe(true);
}
const RUN = Date.now().toString(36);
const REPO = `bt-repo-${RUN}`;
const WAREHOUSE = `bt-wh-${RUN}`;

function trackConsole(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    if (/Failed to load resource.*status of 4\d\d/.test(msg.text())) return;
    errors.push(`console.error: ${msg.text()}`);
  });
  return { assertClean: (label: string) => expect(errors, `console must be clean after: ${label}`).toEqual([]) };
}

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
    if (await welcome.isVisible()) return;
    if (await forcedChange.isVisible()) {
      await page.getByLabel("Current (one-time) password").fill(password);
      await page.getByLabel("New password", { exact: true }).fill(settleOn);
      await page.getByLabel("Confirm new password").fill(settleOn);
      await page.getByRole("button", { name: "Set password & continue" }).click();
      await passTotp(page, email, welcome);
      return;
    }
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "_");

test.describe.configure({ mode: "serial" });

let mcp: ChildProcess | null = null;
let admin: Page;
let dana: Page;
let adminTrack: ReturnType<typeof trackConsole>;
let danaTrack: ReturnType<typeof trackConsole>;
let adminName = "";
let modelId = "";
let projectId = "";
const toolIds = { branches: "", schemas: "" };

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  test.setTimeout(240_000);
  // the real MCP double, on a port of our own; stopped by its own PID below
  const port = await freePort();
  mcp = spawn("node", [path.join(repoRoot, "apps/gateway/dist/demo-mcp-server.js"), "--port", String(port)], { stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    const up = await fetch(`http://127.0.0.1:${port}/nope`).then((r) => r.status === 404).catch(() => false);
    if (up) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  admin = await browser.newPage();
  adminTrack = trackConsole(admin);
  await signIn(admin, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
  dana = await browser.newPage();
  danaTrack = trackConsole(dana);
  await signIn(dana, "dana@regulait.local", [DANA_PASSWORD, state.passwords.dana], DANA_PASSWORD);

  const me = (r: Page) => r.request.get("/auth/me").then((x) => x.json()) as Promise<{ userId: string; user?: { displayName?: string; email?: string } }>;
  const [a, d] = [await me(admin), await me(dana)];
  adminName = a.user?.displayName || a.user?.email || "";
  const post = async (url: string, data: unknown, status = 201) => {
    const res = await admin.request.post(url, { headers: CSRF, data });
    expect(res.status(), `${url}: ${await res.text()}`).toBe(status);
    return res.json();
  };
  const repo = await post("/v1/servers", { name: REPO, url: `http://127.0.0.1:${port}/repo-mcp` });
  const wh = await post("/v1/servers", { name: WAREHOUSE, url: `http://127.0.0.1:${port}/warehouse-mcp` });
  // ADR-0181: a server registered now waits out the 7-day release-age cooldown.
  // These two are the spec's own fixtures, so an admin overrides the cooldown
  // for them through the real, audited route, with a reason (per server, at the
  // registration release; nothing global changes).
  for (const id of [repo.id, wh.id]) {
    await post("/v1/release-quarantine/override", {
      kind: "mcp_server",
      id,
      digest: "registration",
      reason: "e2e: the spec's own local MCP fixture; the cooldown is not what this journey tests",
    });
  }
  const branches = await post(`/v1/servers/${repo.id}/tools`, { name: "list_branches", kind: "read", description: "list branches and their heads" });
  const schemas = await post(`/v1/servers/${wh.id}/tools`, { name: "list_schemas", kind: "read", description: "list schemas" });
  for (const [serverId, toolName] of [
    [repo.id, "list_branches"],
    [wh.id, "list_schemas"],
  ]) {
    const g = await admin.request.post("/v1/grants/tools", { headers: CSRF, data: { userId: d.userId, serverId, toolName } });
    expect(g.status(), await g.text()).toBeLessThan(300);
  }
  await post("/v1/rules/approvals", { userId: d.userId, serverId: wh.id, toolName: "list_schemas", approverUserId: a.userId });
  // ADR-0186 B: tool-call approvals are passkey-signed by default, and this
  // stack has no public URL (no passkey relying party), so the admin's decide
  // below would fail closed. Signing is not what this journey tests: it is
  // relaxed through the audited settings route (bootstrap credential) for the
  // spec's lifetime and restored in afterAll (M-068). Signing itself is proved
  // in the gateway suite and adr0186-ab-signed-approvals.mock.spec.ts.
  await bootSettings({ approvalSignatureMode: "off" });
  // owner rule: every builder agent bills to a project Dana belongs to
  const project = await post("/v1/projects", { name: `Builder tools e2e ${RUN}` });
  projectId = project.id as string;
  const member = await admin.request.post(`/v1/projects/${projectId}/members`, { headers: CSRF, data: { userId: d.userId, role: "contributor" } });
  expect(member.status(), await member.text()).toBeLessThan(300);

  const held = (await (await dana.request.get(`/v1/users/${d.userId}/agents`)).json()) as { agents: Array<{ agentId: string; name: string }> };
  modelId = held.agents.find((x) => x.name === "balanced-mock")!.agentId;
  expect(modelId).toBeTruthy();
  toolIds.branches = branches.id as string;
  toolIds.schemas = schemas.id as string;
});

test.afterAll(async () => {
  await bootSettings({ approvalSignatureMode: "passkey" });
  await admin?.close();
  await dana?.close();
  if (mcp?.pid) mcp.kill("SIGTERM");
});

/** a fresh agent of Dana's with one tool, created through the Builder API */
async function agentWith(toolId: string, askFirst: boolean): Promise<{ id: string; name: string }> {
  const name = `Tools e2e ${RUN} ${Math.random().toString(36).slice(2, 6)}`;
  const made = await dana.request.post("/v1/builder/agents", {
    headers: CSRF,
    data: { name, connectionFormat: "shared", computerUse: false, modelAgentId: modelId, projectId },
  });
  expect(made.status(), await made.text()).toBe(201);
  const id = ((await made.json()) as { agent: { id: string } }).agent.id;
  const put = await dana.request.put(`/v1/builder/agents/${id}/tools`, {
    headers: CSRF,
    data: { tools: [{ kind: "mcp_tool", refId: toolId, requiresApproval: askFirst }] },
  });
  expect(put.status(), await put.text()).toBe(200);
  return { id, name };
}

async function say(agent: { id: string; name: string }, text: string) {
  await dana.goto(`/ui/builder/agents/${agent.id}`);
  await expect(dana.getByRole("heading", { level: 1, name: agent.name })).toBeVisible();
  await dana.getByLabel(`Message ${agent.name}`).fill(text);
  await dana.getByRole("button", { name: "Send" }).click();
  await expect(dana).toHaveURL(/thread=[0-9a-f-]{36}/);
  return new URL(dana.url()).searchParams.get("thread")!;
}

test("an agent calls a granted MCP tool through the governed path and quotes the real result", async () => {
  test.setTimeout(120_000);
  const agent = await agentWith(toolIds.branches, false);
  const thread = await say(agent, `Which branches exist? <<use-tool:${slug(REPO)}__list_branches>>`);
  // the step as the API records it — if it is not done, the failure carries WHY (the CI evidence)
  let detail = "";
  try {
    await expect
      .poll(
        async () => {
          const body = (await (await dana.request.get(`/v1/builder/threads/${thread}`)).json()) as { messages?: Array<{ steps?: Array<{ status?: string }> }> };
          const steps = (body.messages ?? []).flatMap((m) => m.steps ?? []);
          detail = JSON.stringify(steps).slice(0, 2000);
          return steps.map((st) => st.status).join(",");
        },
        { timeout: 30_000 },
      )
      .toContain("done");
  } catch (err) {
    throw new Error(`tool step not done: ${detail}`, { cause: err });
  }
  const convo = dana.getByRole("region", { name: "Conversation" });
  const head = convo.getByRole("list", { name: "Tool calls" }).getByRole("button", { name: new RegExp(`${REPO} / list_branches`) });
  await expect(head).toContainText("Done", { timeout: 30_000 });
  // the final answer quotes what the real MCP server returned
  await expect(convo.getByText(/feat\/vault/).first()).toBeVisible();
  await head.click();
  await expect(convo.getByText(/release\/2026-09/).first()).toBeVisible();
  danaTrack.assertClean("plain tool call");
});

test("Ask first pauses with the exact call and resumes when Dana approves it", async () => {
  test.setTimeout(120_000);
  const agent = await agentWith(toolIds.branches, true);
  const thread = await say(agent, `Branches again please <<use-tool:${slug(REPO)}__list_branches>>`);
  const card = dana.getByRole("group", { name: `Allow ${REPO} / list_branches?` });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card).toContainText("It will run as you");
  await expect(dana.getByLabel(`Message ${agent.name}`)).toBeDisabled();
  const before = (await (await dana.request.get(`/v1/builder/threads/${thread}`)).json()) as { pending: { status: string } | null };
  expect(before.pending?.status).toBe("pending_confirmation");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card).toHaveCount(0, { timeout: 30_000 });
  const convo = dana.getByRole("region", { name: "Conversation" });
  await expect(convo.getByRole("list", { name: "Tool calls" }).getByRole("button")).toContainText("Done");
  await expect(convo.getByText(/feat\/vault/).first()).toBeVisible();
  danaTrack.assertClean("ask first");
});

test("an organisation approval waits for the admin and the thread finishes when they approve", async () => {
  test.setTimeout(120_000);
  const agent = await agentWith(toolIds.schemas, false);
  const thread = await say(agent, `What schemas are there? <<use-tool:${slug(WAREHOUSE)}__list_schemas>>`);
  await expect(dana.getByRole("status").filter({ hasText: `Waiting for approval by ${adminName}` })).toBeVisible({ timeout: 30_000 });
  await expect(dana.getByRole("button", { name: "Approve" })).toHaveCount(0);
  const detail = (await (await dana.request.get(`/v1/builder/threads/${thread}`)).json()) as { pending: { approvalId: string } };
  const approvalId = detail.pending.approvalId;
  expect(approvalId).toBeTruthy();

  // the admin decides in the one approvals queue
  const decided = await admin.request.post(`/v1/approvals/${approvalId}/decide`, { headers: CSRF, data: { decision: "approved" } });
  expect(decided.status(), await decided.text()).toBe(200);
  // the turn resumes AFTER the decide response (ADR-0173 review): wait for it
  // on the API before reading the page
  await expect
    .poll(
      async () => {
        const d = (await (await dana.request.get(`/v1/builder/threads/${thread}`)).json()) as { messages: Array<{ steps: Array<{ status: string }> }> };
        return d.messages.flatMap((m) => m.steps).map((s) => s.status);
      },
      { timeout: 30_000 },
    )
    .toContain("done");

  await dana.reload();
  const convo = dana.getByRole("region", { name: "Conversation" });
  await expect(convo.getByRole("list", { name: "Tool calls" }).getByRole("button")).toContainText("Done", { timeout: 30_000 });
  await expect(convo.getByText(/ONCOLOGY_PHI/).first()).toBeVisible();
  await expect(dana.getByRole("status").filter({ hasText: "Waiting for approval" })).toHaveCount(0);
  danaTrack.assertClean("organisation approval");
  adminTrack.assertClean("admin decide");
});
