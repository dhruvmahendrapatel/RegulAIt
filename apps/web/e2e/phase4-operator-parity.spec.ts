/**
 * The six capabilities the 2026-08-01 capability diff found were STILL
 * legacy-only after the "parity proven" claim — driven for real in a browser,
 * against a real seeded gateway, so the claim is evidenced this time.
 *
 * Admin console (as the seeded admin):
 *   1. PATCH /v1/rules/:kind/:ruleId/deploy-mode   — ADR-0027 A4 mode scoping
 *   2. PATCH /v1/revocations/:kind/:id/scope       — ADR-0027 O9 narrowing
 *
 * Run-detail operator console (as the seeded developer, a NON-admin — these
 * are non-admin routes and must work without admin-ness):
 *   3. POST /v1/runs/:runId/nodes/:nodeId/dispatch — manual STREAMING dispatch
 *   4. run event reassign_node                     — pillar 7 §3's middle verb
 *   5. run event node_submitted                    — the second half of 3
 *   6. per-node `inputs` override on /auto         — instruction editor
 *
 * Every assertion that matters is made ON THE WIRE (the request body the
 * browser actually sent, the status the gateway actually answered) as well as
 * in the DOM, because a control that renders but posts the wrong shape is
 * exactly the failure mode this spec exists to catch. Zero console errors is
 * asserted throughout; screenshots land in E2E_SHOTS_DIR.
 *
 * Runs last in file order, but does not depend on that: signIn() below tries
 * both the seeded one-time credential and the password an earlier spec may
 * already have rotated to, so this spec passes standalone too.
 */
import { expect, test, type Page } from "@playwright/test";
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

/** the passwords phase1/phase2 rotated the seeded one-time ones to */
const DANA_PASSWORD = "E2e-Rewrite-2026!";
const ADMIN_PASSWORD = "E2e-Admin-Phase2!";
const CSRF = { "x-regulait-csrf": "1" };

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
    // the browser's own network log for the pre-login 401 probe — not emitted
    // by our code and not suppressible from JS. Everything else is fatal.
    if (/Failed to load resource.*40[13]/.test(text)) return;
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

/** every request the browser made to `pathIncludes`, with its parsed body */
function recordRequests(page: Page, pathIncludes: string) {
  const seen: Array<{ method: string; url: string; body: Record<string, unknown> }> = [];
  page.on("request", (req) => {
    const u = new URL(req.url());
    if (!u.pathname.includes(pathIncludes)) return;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(req.postData() ?? "{}") as Record<string, unknown>;
    } catch {
      body = {};
    }
    seen.push({ method: req.method(), url: u.pathname, body });
  });
  return seen;
}

/**
 * Sign in without assuming WHICH earlier spec has already rotated this
 * persona's one-time password. Each candidate is tried in turn, and the forced
 * password-change screen is completed if the seeded one-time credential is the
 * one that works. This keeps the spec runnable both in the full ordered suite
 * and on its own (`--grep`), which matters because it is the evidence for a
 * parity claim — it must not be the spec that only passes in one arrangement.
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
    expect(i, `no candidate password worked for ${email}`).toBeLessThan(candidates.length - 1);
  }
  throw new Error(`could not sign in as ${email}`);
}

test.describe.configure({ mode: "serial" });

// ===========================================================================
// gaps 1 + 2 — the admin console
// ===========================================================================

test.describe("admin console parity", () => {
  let page: Page;
  let track: ConsoleTracker;
  let rulePatches: ReturnType<typeof recordRequests>;
  let scopePatches: ReturnType<typeof recordRequests>;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    track = trackConsole(page);
    rulePatches = recordRequests(page, "/deploy-mode");
    scopePatches = recordRequests(page, "/scope");
    await signIn(page, "admin@regulait.local", [ADMIN_PASSWORD, state.passwords.admin], ADMIN_PASSWORD);
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("gap 1: a rule is deploy-mode scoped inline, and cleared again (ADR-0027 A4)", async () => {
    // ADR-0094: reach a suite's page from anywhere via the cross-suite filter
    await page.getByLabel("Filter navigation").fill("Rules engine");
    await page.getByRole("link", { name: "Rules engine", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Rules engine", exact: true })).toBeVisible();
    // the disclosure that mode scoping can only ever NARROW, never mint an allow
    await expect(page.getByText(/it can never\s+mint an allow/)).toBeVisible();

    // seed one rule of our own so the row is unambiguous
    const rateForm = page.locator("form", { has: page.getByRole("button", { name: "Add rate limit" }) });
    await rateForm.getByLabel("Scope").selectOption("fleet");
    await rateForm.getByLabel("Servers").selectOption("all");
    await rateForm.getByLabel("Max calls").fill("11");
    await rateForm.getByLabel("Window seconds").fill("60");
    await page.getByRole("button", { name: "Add rate limit" }).click();
    await expect(page.getByText("Rule added").first()).toBeVisible();

    // every rule row carries a mode select, defaulting to mode-unscoped
    const modeSelect = page.locator("[data-testid^='deploy-mode-']").last();
    await expect(modeSelect).toBeVisible();
    await expect(modeSelect).toHaveValue("");

    const patched = page.waitForResponse(
      (r) => r.url().includes("/deploy-mode") && r.request().method() === "PATCH",
    );
    await modeSelect.selectOption("air_gapped");
    expect((await patched).status()).toBe(200);
    await expect(page.getByText(/Rule scoped to air_gapped/).first()).toBeVisible();
    await expect(modeSelect).toHaveValue("air_gapped");
    await shot(page, "phase4-01-rules-deploy-mode");

    // and it can be cleared back to "every call" — the null branch
    const cleared = page.waitForResponse(
      (r) => r.url().includes("/deploy-mode") && r.request().method() === "PATCH",
    );
    await modeSelect.selectOption("");
    expect((await cleared).status()).toBe(200);
    await expect(page.getByText(/Scope cleared/).first()).toBeVisible();

    // ON THE WIRE: the real endpoint, the real body shape, both branches
    expect(rulePatches.map((r) => r.method)).toEqual(["PATCH", "PATCH"]);
    expect(rulePatches[0]!.url).toMatch(/^\/v1\/rules\/rate-limits\/[0-9a-f-]{36}\/deploy-mode$/);
    expect(rulePatches[0]!.body).toEqual({ deployMode: "air_gapped" });
    expect(rulePatches[1]!.body).toEqual({ deployMode: null });
    track.assertClean("rules engine deploy-mode scoping");
  });

  test("gap 2: an existing revocation is narrowed to read_only and restored (ADR-0027 O9)", async () => {
    await page.getByLabel("Filter navigation").fill("Users");
    await page.getByRole("link", { name: "Users", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Users", exact: true })).toBeVisible();
    await page.locator("tbody tr[role='link']").first().click();
    await page.getByRole("tab", { name: "Overrides" }).click();
    await expect(page.getByText("MCP revocations", { exact: true })).toBeVisible();
    // the O9 disclosure: creation is always full, narrowing is a second act
    await expect(page.getByText(/Every revocation is CREATED full/)).toBeVisible();

    // create one to narrow (creation is always the ADR-0019 total). The id
    // comes off the creation response so the row under test is addressed
    // exactly — a positional selector would drift, because Postgres returns an
    // UPDATEd row in a different heap position than it had before.
    const mcpForm = page.locator("form", { has: page.getByRole("button", { name: "Add revocation" }) });
    await mcpForm.getByLabel("Server").selectOption({ index: 1 });
    const createdRes = page.waitForResponse(
      (r) => r.url().endsWith("/v1/revocations") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Add revocation" }).click();
    const revocationId = ((await (await createdRes).json()) as { id: string }).id;
    await expect(page.getByText("MCP revocation added").first()).toBeVisible();

    const scopeSelect = page.getByTestId(`revocation-scope-${revocationId}`);
    await expect(scopeSelect).toBeVisible();
    await expect(scopeSelect, "a new revocation is created FULL").toHaveValue("full");

    const narrowed = page.waitForResponse(
      (r) => /\/v1\/revocations\/\w+\/[0-9a-f-]{36}\/scope/.test(r.url()) && r.request().method() === "PATCH",
    );
    await scopeSelect.selectOption("read_only");
    expect((await narrowed).status()).toBe(200);
    await expect(page.getByText(/Narrowed to read_only/).first()).toBeVisible();
    await expect(scopeSelect).toHaveValue("read_only");
    await shot(page, "phase4-02-revocation-scope");

    const restored = page.waitForResponse(
      (r) => /\/v1\/revocations\/\w+\/[0-9a-f-]{36}\/scope/.test(r.url()) && r.request().method() === "PATCH",
    );
    await scopeSelect.selectOption("full");
    expect((await restored).status()).toBe(200);
    await expect(page.getByText(/Restored to full/).first()).toBeVisible();

    const patches = scopePatches.filter((r) => r.method === "PATCH");
    expect(patches.length).toBeGreaterThanOrEqual(2);
    expect(patches[0]!.url).toBe(`/v1/revocations/mcp/${revocationId}/scope`);
    expect(patches[0]!.body).toEqual({ scope: "read_only" });
    expect(patches[1]!.body).toEqual({ scope: "full" });
    track.assertClean("revocation scope narrowing");
  });
});

// ===========================================================================
// gaps 3-6 — the run-detail operator console, as a NON-admin
// ===========================================================================

test.describe("run-detail operator parity", () => {
  let page: Page;
  let track: ConsoleTracker;
  let runId = "";
  let agentId = "";
  let dispatches: ReturnType<typeof recordRequests>;
  let events: ReturnType<typeof recordRequests>;
  let autos: ReturnType<typeof recordRequests>;

  const INSTR = {
    strand: "Original instruction for the stranded node.",
    block: "Original instruction for the node that will block.",
    pending: "Original instruction for the untouched node.",
  };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    track = trackConsole(page);
    dispatches = recordRequests(page, "/dispatch");
    events = recordRequests(page, "/events");
    autos = recordRequests(page, "/auto");
    await signIn(page, "dana@regulait.local", [DANA_PASSWORD, state.passwords.dana], DANA_PASSWORD);

    // A run built for this spec, so every node state is ours to control. Set
    // up through the SAME governed API the UI uses (the browser's own
    // authenticated context), never by touching the database.
    const me = await (await page.request.get("/auth/me")).json();
    const roster = await (await page.request.get(`/v1/users/${me.userId}/agents`)).json();
    const mock = roster.agents.find((a: { provider: string }) => a.provider === "mock") ?? roster.agents[0];
    agentId = mock.agentId;
    expect(agentId, "dana must have a granted agent to own the nodes").toBeTruthy();

    const node = (id: string, instruction: string) => ({
      id,
      title: `node ${id}`,
      instruction,
      ownerAgentId: agentId,
      mode: "execute",
      estimate: { in: 100, out: 200 },
    });
    const created = await page.request.post("/v1/runs", {
      headers: CSRF,
      data: {
        graph: {
          run: `operator-parity-${Date.now().toString(36)}`,
          escalationApproverUserId: me.userId,
          // three INDEPENDENT nodes: one to strand in_progress, one to block,
          // one left not_started for the auto-advance override
          nodes: [node("strand", INSTR.strand), node("block", INSTR.block), node("pending", INSTR.pending)],
        },
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    runId = (await created.json()).id;

    const event = async (body: Record<string, unknown>) => {
      const res = await page.request.post(`/v1/runs/${runId}/events`, { headers: CSRF, data: body });
      expect(res.status(), `${JSON.stringify(body)} → ${await res.text()}`).toBeLessThan(300);
    };
    await event({ kind: "start" });
    // strand one node in_progress — exactly what a failed pass leaves behind
    await event({ kind: "node_started", nodeId: "strand" });
    // and drive another to blocked, so §3's full verb set has a subject
    await event({ kind: "node_started", nodeId: "block" });
    await event({ kind: "node_failed", nodeId: "block", error: "worker failed — operator must decide" });
  });
  test.afterAll(async () => {
    await page.close();
  });

  test("gaps 3+5+6: the per-node instruction editor, then a manual streaming dispatch that submits for review", async () => {
    await page.goto(`/ui/runs/${runId}`);
    await expect(page.getByText("Task graph")).toBeVisible();

    // gap 6 — an expandable per-node override, DEFAULTED to the node's own
    // instruction (not blank, not the title)
    await page.getByTestId("node-edit-toggle-strand").click();
    const editor = page.getByTestId("node-instruction-strand");
    await expect(editor).toBeVisible();
    await expect(editor, "the editor defaults to the node's existing instruction").toHaveValue(
      INSTR.strand,
    );

    const OVERRIDE = "Rewritten by the operator before the manual dispatch.";
    await editor.fill(OVERRIDE);
    // an edited node is disclosed, so a pass is never silently re-instructed
    await expect(page.getByText("1 instruction override")).toBeVisible();
    await shot(page, "phase4-03-run-operator-panel");

    // gap 3 — the manual STREAMING dispatch of the stranded in_progress node
    const dispatched = page.waitForResponse(
      (r) => r.url().includes(`/nodes/strand/dispatch`) && r.request().method() === "POST",
    );
    await page.getByTestId("dispatch-strand").click();
    const dispatchRes = await dispatched;
    expect(dispatchRes.status(), await dispatchRes.text()).toBe(200);
    expect(
      dispatchRes.headers()["content-type"],
      "the dispatch must really stream, not fall back to buffered JSON",
    ).toContain("event-stream");

    // the worker's tokens land in a live pane for that node
    const pane = page.locator("pre").filter({ hasText: /\S/ }).first();
    await expect(page.getByText("Live worker output")).toBeVisible({ timeout: 20_000 });
    await expect(pane).not.toBeEmpty({ timeout: 20_000 });

    // gap 5 — and the output is then SUBMITTED for review
    await expect(page.getByText("Node dispatched — output submitted for review").first()).toBeVisible({
      timeout: 20_000,
    });
    await shot(page, "phase4-04-run-manual-dispatch");

    // ON THE WIRE: the streaming dispatch carried the override, and the
    // node_submitted event followed it
    const d = dispatches.find((r) => r.url.endsWith("/nodes/strand/dispatch"));
    expect(d, "a POST to the node dispatch endpoint").toBeTruthy();
    expect(d!.body).toEqual({ stream: true, input: OVERRIDE });
    const submitted = events.filter((e) => e.body.kind === "node_submitted");
    expect(submitted.length, "node_submitted must be POSTED, not merely rendered").toBe(1);
    expect(submitted[0]!.body).toEqual({ kind: "node_submitted", nodeId: "strand" });

    // and the run really moved: the node is now awaiting a human review
    const after = await (await page.request.get(`/v1/runs/${runId}`)).json();
    expect(after.run.state.nodeStatuses.strand).toBe("in_review");
    track.assertClean("manual streaming dispatch + node_submitted");
  });

  test("gap 4: a blocked node is reassigned to another entitled agent (pillar 7 §3)", async () => {
    await page.goto(`/ui/runs/${runId}`);
    // the blocked node offers the FULL triad, not just retry + escalate
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByTestId("reassign-block")).toBeVisible();
    await expect(page.getByRole("button", { name: "Escalate" })).toBeVisible();

    // the owner picker is the caller's own roster, preselected to the current
    // owner — never a free-text agent id
    const picker = page.getByTestId("reassign-agent-block");
    await expect(picker).toHaveValue(agentId);
    const optionValues = await picker.locator("option").evaluateAll((els) =>
      els.map((e) => (e as HTMLOptionElement).value),
    );
    expect(optionValues.length).toBeGreaterThan(0);
    const target = optionValues.find((v) => v !== agentId) ?? agentId;
    await picker.selectOption(target);

    const reassigned = page.waitForResponse(
      (r) => r.url().includes(`/runs/${runId}/events`) && r.request().method() === "POST",
    );
    await page.getByTestId("reassign-block").click();
    expect((await reassigned).status()).toBeLessThan(300);
    await expect(page.getByText("Node reassigned and re-opened").first()).toBeVisible();
    await shot(page, "phase4-05-run-reassign");

    // ON THE WIRE: the reassign_node verb with an ownerAgentId from the roster
    const r = events.filter((e) => e.body.kind === "reassign_node");
    expect(r.length).toBe(1);
    expect(r[0]!.body).toEqual({ kind: "reassign_node", nodeId: "block", ownerAgentId: target });

    // and the kernel really re-opened it under the new owner
    const after = await (await page.request.get(`/v1/runs/${runId}`)).json();
    expect(after.run.state.nodeStatuses.block).toBe("not_started");
    expect(after.run.state.owners.block).toBe(target);
    track.assertClean("reassign a blocked node");
  });

  test("gap 6: an edited instruction rides along as the auto-advance `inputs` map", async () => {
    await page.goto(`/ui/runs/${runId}`);
    await page.getByTestId("node-edit-toggle-pending").click();
    const editor = page.getByTestId("node-instruction-pending");
    await expect(editor).toHaveValue(INSTR.pending);

    const OVERRIDE = "Auto-advance should use THIS instruction for the pending node.";
    await editor.fill(OVERRIDE);
    await expect(page.getByText("1 instruction override")).toBeVisible();

    const advanced = page.waitForResponse(
      (r) => r.url().includes(`/runs/${runId}/auto`) && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Auto-advance" }).click();
    expect((await advanced).status()).toBe(200);
    await expect(page.getByText(/Auto-advance —/).first()).toBeVisible({ timeout: 30_000 });
    await shot(page, "phase4-06-run-auto-with-inputs");

    // ON THE WIRE: the legacy payload shape — stream + acceptReviews + the
    // per-node inputs map, carrying ONLY the node that was actually edited
    const a = autos.find((x) => x.url.endsWith("/auto"));
    expect(a, "a POST to the auto-advance endpoint").toBeTruthy();
    expect(a!.body.stream).toBe(true);
    expect(a!.body).toHaveProperty("acceptReviews");
    expect(a!.body.inputs, "the per-node instruction override map").toEqual({ pending: OVERRIDE });
    track.assertClean("auto-advance with per-node instruction overrides");
  });
});
