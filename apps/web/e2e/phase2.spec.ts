/**
 * Phase-2 admin-surface journey against a REAL seeded gateway: sign in as the
 * seeded ADMIN persona (one-time password → forced change), then drive every
 * native admin view — create a user, issue a one-time password and an API
 * key, build a rule, run a simulation (precedence chain), decide an approval,
 * author a workflow template, register an agent, add a model credential,
 * exercise the Snowflake credential validation, register MCP tools, reveal a
 * PM webhook secret, add a deploy target, open the cost rollup, save a
 * compliance profile + cascade preview, propose an infra remediation, save
 * org settings, and drive the client config generator. Every page asserts
 * ZERO console errors (expected 4xx network log lines from deliberate
 * negative tests are the only filter) and screenshots into E2E_SHOTS_DIR.
 *
 * Also covers the debts closed on 2026-08-01 (ADR-0026 phase-3 amendment):
 * A4's audit deploy-mode filter including the honest unknown / pre-0044
 * bucket, and O10's per-tool MCP price override set → persisted → cleared.
 *
 * The last journey belongs to the phase-4 end-user correction: it flips
 * ADR-0024's key-custody toggle on and proves BOTH readers of the new
 * self-service key card land in the same explained state — the admin from the
 * proactive settings read, a developer from the 409 they can only learn from.
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

const ADMIN_PASSWORD = "E2e-Admin-Phase2!";

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
    // browser network log lines for the expected pre-login 401 probe and the
    // DELIBERATE negative tests (snowflake 400 validation) — not emitted by
    // our code. Everything else is fatal.
    if (/Failed to load resource.*(400|401|403|409)/.test(text)) return;
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

test.describe.configure({ mode: "serial" });

let page: Page;
let track: ConsoleTracker;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  track = trackConsole(page);
});
test.afterAll(async () => {
  await page.close();
});

async function nav(label: string, heading: string) {
  await page.getByRole("link", { name: label, exact: true }).click();
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

test("admin login: one-time password → forced change → dashboard shows admin nav", async () => {
  // MINT A FRESH one-time password rather than spending the seeded one.
  // The seeded password is single-use and this suite shares ONE database, so
  // whichever spec signs in first consumes it — this test used to depend on
  // being that spec, which alphabetical file order stopped guaranteeing. The
  // CONTRACT under test (a one-time password forces a change on first use) is
  // unchanged; only its fixture is now owned by the test instead of borrowed.
  const boot = { authorization: "Bearer e2e-bootstrap-token", "content-type": "application/json" };
  const users = (await (await fetch(`${state.baseUrl}/v1/users`, { headers: boot })).json()) as {
    users: Array<{ id: string; email: string }>;
  };
  const adminId = users.users.find((u) => u.email === "admin@regulait.local")!.id;
  const minted = (await (
    await fetch(`${state.baseUrl}/v1/users/${adminId}/set-initial-password`, {
      method: "POST",
      headers: boot,
      body: JSON.stringify({ force: true }),
    })
  ).json()) as { password: string; mustChangePassword: boolean };
  expect(minted.mustChangePassword).toBe(true);

  await page.goto("/ui");
  await page.getByLabel("Email").fill("admin@regulait.local");
  await page.getByLabel("Password", { exact: true }).fill(minted.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("Your password is one-time")).toBeVisible();
  await page.getByLabel("Current (one-time) password").fill(minted.password);
  await page.getByLabel("New password", { exact: true }).fill(ADMIN_PASSWORD);
  await page.getByLabel("Confirm new password").fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Set password & continue" }).click();

  await expect(page.getByRole("heading", { name: /Welcome back/ })).toBeVisible();
  // the six admin groups render as real nav sections, no "classic ↗" bridges
  for (const group of [
    "Identity & Access",
    "Governance",
    "Integrations",
    "Cost & Optimization",
    "Compliance & Infra",
    "Settings",
  ]) {
    await expect(page.getByText(group, { exact: true })).toBeVisible();
  }
  await expect(page.locator("text=classic ↗")).toHaveCount(0);
  await shot(page, "phase2-01-admin-dashboard");
  track.assertClean("admin login + dashboard");
});

test("users: create a user, issue a one-time password and an API key (one-time reveals)", async () => {
  await nav("Users", "Users");
  await page.getByLabel("Email").fill("e2e-user@example.com");
  await page.getByLabel("Display name").first().fill("E2E User");
  await page.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByText("User created", { exact: false }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "e2e-user@example.com" })).toBeVisible();
  await shot(page, "phase2-02-users-created");

  // open the detail panel and issue a one-time password
  await page.getByRole("link", { name: "Manage E2E User" }).click();
  await page.getByRole("button", { name: "Set one-time password" }).click();
  await expect(page.getByTestId("revealed-secret")).toBeVisible();
  await expect(page.getByText("shown once")).toBeVisible();
  await shot(page, "phase2-03-users-otp-reveal");
  await page.getByRole("button", { name: "Dismiss" }).click();

  // issue an API key — a fresh one-time reveal
  await page.getByRole("button", { name: "Issue API key" }).click();
  await expect(page.getByTestId("revealed-secret")).toBeVisible();
  await shot(page, "phase2-04-users-key-reveal");
  await page.getByRole("button", { name: "Dismiss" }).click();

  // sessions + overrides tabs render
  await page.getByRole("tab", { name: "Sessions" }).click();
  await expect(page.getByText("live session(s)", { exact: false })).toBeVisible();
  await page.getByRole("tab", { name: "Overrides" }).click();
  await expect(page.getByText("MCP revocations", { exact: true })).toBeVisible();
  await shot(page, "phase2-05-users-overrides");
  track.assertClean("users lifecycle");
});

test("roles: create a role and inspect a seeded role's grants + holders", async () => {
  await nav("Roles", "Roles");
  await page.getByLabel("Role name").fill("e2e-role");
  await page.getByRole("button", { name: "Create role" }).click();
  await expect(page.getByRole("cell", { name: "e2e-role" })).toBeVisible();

  // open the seeded analyst role — holders and grants load
  const analystRow = page.locator("tbody tr[role='link']").filter({ hasText: "data-analyst" }).first();
  if (await analystRow.count()) {
    await analystRow.click();
  } else {
    await page.locator("tbody tr[role='link']").first().click();
  }
  await expect(page.getByText("What this role provisions")).toBeVisible();
  await shot(page, "phase2-06-roles-grants");
  track.assertClean("roles");
});

test("teams: list with members and default classifications", async () => {
  await nav("Teams", "Teams");
  await expect(page.getByText("Teams & members")).toBeVisible();
  await shot(page, "phase2-07-teams");
  track.assertClean("teams");
});

test("client access: posture form, effective preview, config generator with copy", async () => {
  await nav("Client access", "Client access");
  await expect(page.getByText("Enforcement posture — declared vs enforced")).toBeVisible();

  // save the posture unchanged — the form round-trips the stored settings
  await page.getByRole("button", { name: "Save posture" }).click();
  await expect(page.getByText("Posture saved").first()).toBeVisible();

  // live effective preview for a user
  await page
    .locator("form", { has: page.getByRole("button", { name: "Preview" }) })
    .getByLabel("User")
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByTestId("effective-preview")).toBeVisible();

  // drive the config generator
  await page.getByRole("button", { name: "Generate" }).click();
  await expect(page.getByTestId("client-config")).toBeVisible();
  await expect(page.getByTestId("client-config")).toContainText("ANTHROPIC_BASE_URL");
  await shot(page, "phase2-08-client-access");
  track.assertClean("client access");
});

test("sso & sessions: OIDC list + sessions policy save", async () => {
  await nav("SSO & sessions", "SSO & sessions");
  await expect(page.getByText("Single sign-on — OIDC providers")).toBeVisible();
  await page.getByRole("button", { name: "Save sign-in policy" }).click();
  await expect(page.getByText("Sign-in policy saved", { exact: false }).first()).toBeVisible();
  await shot(page, "phase2-09-sso-sessions");
  track.assertClean("sso & sessions");
});

test("rules engine: build a fleet-wide rate limit", async () => {
  await nav("Rules engine", "Rules engine");
  const rateForm = page.locator("form", { has: page.getByRole("button", { name: "Add rate limit" }) });
  await rateForm.getByLabel("Scope").selectOption("fleet");
  await rateForm.getByLabel("Servers").selectOption("all");
  await rateForm.getByLabel("Max calls").fill("50");
  await rateForm.getByLabel("Window seconds").fill("60");
  await page.getByRole("button", { name: "Add rate limit" }).click();
  await expect(page.getByText("Rule added").first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "fleet" }).last()).toBeVisible();
  await shot(page, "phase2-10-rules-engine");
  track.assertClean("rules engine");
});

test("simulation: the precedence-chain visualizer decides a live call", async () => {
  await nav("Simulation", "Simulation / access preview");
  const simForm = page.locator("form", { has: page.getByRole("button", { name: "Evaluate" }) });
  // dana + repo server + search_code is the seeded revocation — the chain
  // shows the override deciding over the role-derived grant
  const userSel = simForm.locator("select").nth(0);
  const danaValue = await userSel.locator("option", { hasText: "dana@" }).getAttribute("value");
  await userSel.selectOption(danaValue!);
  const serverSel = simForm.locator("select").nth(1);
  const repoValue = await serverSel.locator("option", { hasText: "repo" }).first().getAttribute("value");
  await serverSel.selectOption(repoValue!);
  const toolSel = simForm.locator("select").nth(2);
  await expect(toolSel.locator("option", { hasText: "search_code" })).toBeAttached();
  await toolSel.selectOption({ label: "search_code (read)" });
  await page.getByRole("button", { name: "Evaluate" }).click();
  await expect(page.getByTestId("decision-effect")).toBeVisible();
  await expect(page.getByTestId("rule-chain")).toBeVisible();
  await expect(page.getByText("decides", { exact: true })).toBeVisible();
  await shot(page, "phase2-11-simulation-chain");
  track.assertClean("simulation");
});

test("approvals queue: decide a pending approval with a recorded reason", async () => {
  await nav("Approvals queue", "Approvals queue");
  const approve = page.getByRole("button", { name: "approve", exact: true }).first();
  await expect(approve).toBeVisible();
  await shot(page, "phase2-12-approvals-queue");
  // an admin deciding in another's place records a reason (override-audited)
  await page.locator("input[aria-label^='Reason for']").first().fill("e2e: phase-2 admin journey decision");
  await approve.click();
  await expect(page.getByText("Decision recorded").first()).toBeVisible();
  await shot(page, "phase2-13-approvals-decided");
  track.assertClean("approvals queue");
});

test("audit log: retention card, filterable table, CSV export", async () => {
  await nav("Audit log", "Audit log");
  await expect(page.getByText("Retention (§8.4)", { exact: false })).toBeVisible();
  await expect(page.locator("tbody tr").first()).toBeVisible();
  const downloadP = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  const download = await downloadP;
  expect(download.suggestedFilename()).toContain("audit-log");
  await shot(page, "phase2-14-audit-log");
  track.assertClean("audit log");
});

test("audit log: A4 deploy-mode filter, including the honest unknown / pre-0044 bucket", async () => {
  await nav("Audit log", "Audit log");
  const modeFilter = page.getByLabel("Filter by deploy mode");
  await expect(modeFilter).toBeVisible();
  // the control must NAME the un-backfillable bucket rather than hiding it
  await expect(modeFilter.locator("option", { hasText: "unknown / pre-0044" })).toHaveCount(1);
  // …and the page must say out loud why unknown is not a mode
  await expect(page.getByText("un-backfillable", { exact: false })).toBeVisible();
  // (a plain locator, not getByRole: the kit's <th> cells expose as `cell`,
  // and the header text is uppercased by CSS text-transform)
  await expect(page.locator("thead th", { hasText: "Deploy mode" })).toBeVisible();

  // the table refetches on every filter change, so settle on a CONSISTENT
  // snapshot (loading renders skeleton rows) before judging it.
  const modeCells = (mode: string) => page.getByRole("cell", { name: mode, exact: true });
  const emptyMsg = page.getByText("No audit rows match");
  const settled = async () => {
    const [rows, unknown, hosted, byoc, air, empty] = await Promise.all([
      page.locator("tbody tr").count(),
      modeCells("unknown").count(),
      modeCells("hosted").count(),
      modeCells("byoc").count(),
      modeCells("air_gapped").count(),
      emptyMsg.isVisible(),
    ]);
    return { rows, unknown, empty, byMode: { hosted, byoc, air_gapped: air } as Record<string, number> };
  };

  // unfiltered: rows exist, and the null-mode ones render as a plain "unknown"
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await expect.poll(async () => (await settled()).unknown).toBeGreaterThan(0);

  // the unknown bucket is null-ONLY — every visible row must be an unknown one
  await modeFilter.selectOption("unknown");
  await expect
    .poll(async () => {
      const s = await settled();
      return s.rows > 0 && s.rows === s.unknown;
    })
    .toBe(true);
  await shot(page, "phase2-14b-audit-mode-unknown");

  // a named mode must never leak an unknown row back in — that is exactly the
  // dishonesty the bucket exists to prevent. Either the table shows only that
  // mode, or it honestly says nothing matches yet.
  for (const mode of ["hosted", "byoc", "air_gapped"]) {
    await modeFilter.selectOption(mode);
    await expect
      .poll(async () => {
        const s = await settled();
        if (s.unknown !== 0) return false; // an unknown row leaked into a mode
        // either every row carries THIS mode, or the table is honestly empty
        return s.empty || (s.rows > 0 && s.rows === s.byMode[mode]);
      })
      .toBe(true);
    // when nothing matches, the empty state must EXPLAIN why rather than
    // implying the trail is broken
    if ((await settled()).empty) {
      await expect(
        page.getByText(`No row records a ${mode} deploy mode yet`, { exact: false }),
      ).toBeVisible();
    }
  }
  await shot(page, "phase2-14c-audit-mode-named");

  // the export follows the filter, so a downloaded trail matches the screen
  await modeFilter.selectOption("unknown");
  const dl = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV" }).click();
  expect((await dl).suggestedFilename()).toContain("audit-log");

  await modeFilter.selectOption("");
  track.assertClean("audit log deploy-mode filter");
});

test("workflow templates: author a template from a starter", async () => {
  await nav("Workflow templates", "Workflow templates");
  // exact: ADR-0077's gallery put a "Template name for <shape>" input on every
  // gallery card, so a loose "Name" match now resolves to six controls. The
  // authoring form's field is the one labelled exactly "Name".
  await page.getByLabel("Name", { exact: true }).fill(`e2e-template-${Date.now()}`);
  await page.getByRole("button", { name: "Create template" }).click();
  await expect(page.getByText("Template created").first()).toBeVisible();
  await shot(page, "phase2-15-workflow-templates");
  track.assertClean("workflow templates");
});

test("agents: register an agent and save its base system prompt", async () => {
  await nav("Agents", "Agents");
  const reg = page.locator("form", { has: page.getByRole("button", { name: "Register agent" }) });
  await reg.getByLabel("Name").fill("e2e-agent");
  await reg.getByLabel("Provider").selectOption("mock");
  await reg.getByLabel("Tier (0 = cheapest)").fill("0");
  await reg.getByLabel("Model id (blank = not dispatchable)").fill("mock-e2e");
  await page.getByRole("button", { name: "Register agent" }).click();
  await expect(page.getByText("Agent registered").first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "e2e-agent" })).toBeVisible();

  // admin base system prompt (governance artifact)
  const promptCard = page.locator("section", { has: page.getByRole("button", { name: "Save prompt" }) });
  await promptCard.getByLabel("Agent").selectOption({ label: "e2e-agent · mock · tier 0" });
  await promptCard.getByLabel("System prompt (empty = clear)").fill("You are the e2e governance agent.");
  await promptCard.getByRole("button", { name: "Save prompt" }).click();
  await expect(page.getByText("System prompt saved").first()).toBeVisible();
  await shot(page, "phase2-16-agents");
  track.assertClean("agents");
});

test("model credentials: add a platform credential (write-only) + env presence", async () => {
  await nav("Model credentials", "Model credentials");
  await page.getByLabel("API key").fill("sk-e2e-test-not-a-real-key");
  await page.getByRole("button", { name: "Save credential" }).click();
  await expect(page.getByText("Credential saved").first()).toBeVisible();
  await expect(page.getByText("Env keys present on this server")).toBeVisible();
  await shot(page, "phase2-17-model-credentials");
  track.assertClean("model credentials");
});

test("connectors: create a snowflake connector + save its structured multi-field credential", async () => {
  await nav("Connectors", "Connectors");
  const create = page.locator("form", { has: page.getByRole("button", { name: "Create", exact: true }) });
  await create.getByLabel("Name").fill("e2e-warehouse");
  await create.getByLabel("Kind (display category)").fill("warehouse");
  await create.getByLabel("Execution adapter").selectOption("snowflake");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByText("Connector created").first()).toBeVisible();

  // the credential card adapts to snowflake's structured multi-field
  // convention — the form assembles {account, user, privateKey} and the
  // server validates the shape at save time (shape-invalid JSON 400s; the
  // form can only ever assemble a valid shape, so this saves)
  const credCard = page.locator("section", { hasText: "Platform credential" }).first();
  await credCard.getByLabel("Connector").selectOption({ label: "e2e-warehouse · warehouse" });
  await credCard.getByLabel("Account").fill("xy12345.eu-west-1");
  await credCard.getByLabel("User", { exact: true }).fill("E2E_SVC");
  await credCard.getByLabel("Private key (PEM)").fill("-----BEGIN PRIVATE KEY-----\ne2e\n-----END PRIVATE KEY-----");
  await credCard.getByRole("button", { name: "Save credential" }).click();
  await expect(credCard.getByText("credential configured")).toBeVisible();
  await expect(credCard.getByRole("button", { name: "Rotate credential" })).toBeVisible();
  await shot(page, "phase2-18-connectors-snowflake");
  track.assertClean("connectors");
});

test("mcp servers: tool inventory + tool grant", async () => {
  await nav("MCP servers", "MCP servers");
  // open the seeded server's tools
  await page.locator("tbody tr[role='link']").first().click();
  await expect(page.getByText(/Tools on /)).toBeVisible();

  // register a tool on it
  const toolCard = page.locator("section", { hasText: "Tool inventory" }).first();
  await toolCard.getByLabel("Server").selectOption({ index: 1 });
  await toolCard.getByLabel("Tool name").fill("e2e_tool");
  await toolCard.getByRole("button", { name: "Register tool" }).click();
  await expect(page.getByText("Tool registered").first()).toBeVisible();
  await shot(page, "phase2-19-mcp-servers");
  track.assertClean("mcp servers");
});

test("mcp servers: set a per-tool price override and see it persist (O10)", async () => {
  const toolsCard = page.locator("section", { hasText: "Tools on " }).first();
  // selecting a server is a TOGGLE, and the previous journey left one open —
  // open it only if it is not already open, so this test is order-independent
  const openTools = async () => {
    if (!(await toolsCard.isVisible())) {
      await page.locator("tbody tr[role='link']").first().click();
    }
    await expect(toolsCard).toBeVisible();
  };
  await nav("MCP servers", "MCP servers");
  await openTools();

  // the row for the tool the previous journey registered
  const row = toolsCard.locator("tbody tr", { hasText: "e2e_tool" }).first();
  await expect(row).toBeVisible();
  // it starts with NO override — the seeded server carries no flat rate either,
  // so the honest state is "unpriced", never an invented zero
  await expect(row.getByText(/override/)).toHaveCount(0);

  await row.getByLabel("Price per call for e2e_tool").fill("0.25");
  await row.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Price for e2e_tool set to/).first()).toBeVisible();
  // the row now reports itself as an OVERRIDE, not as an inherited rate
  await expect(row.getByText(/\$0\.25 override/)).toBeVisible();
  await shot(page, "phase2-19b-mcp-tool-price");

  // PERSISTENCE: a full reload re-reads the inventory row from the backend
  await page.reload();
  await expect(page.getByRole("heading", { name: "MCP servers", exact: true })).toBeVisible();
  await openTools();
  const reloadedRow = toolsCard.locator("tbody tr", { hasText: "e2e_tool" }).first();
  await expect(reloadedRow.getByText(/\$0\.25 override/)).toBeVisible();
  await expect(reloadedRow.getByLabel("Price per call for e2e_tool")).toHaveValue("0.25");

  // clearing the field restores inheritance rather than pricing the tool at 0
  await reloadedRow.getByLabel("Price per call for e2e_tool").fill("");
  await reloadedRow.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/Override cleared for e2e_tool/).first()).toBeVisible();
  await expect(reloadedRow.getByText(/override/)).toHaveCount(0);
  track.assertClean("mcp per-tool pricing");
});

test("git connections: seeded connection listed with provider hints", async () => {
  await nav("Git connections", "Git connections");
  await expect(page.getByRole("cell", { name: "demo-git" })).toBeVisible();
  await shot(page, "phase2-20-git-connections");
  track.assertClean("git connections");
});

test("pm connections: create a mock connection → one-time webhook secret reveal", async () => {
  await nav("PM connections", "PM connections");
  await page.getByLabel("Name").fill(`e2e-pm-${Date.now() % 100000}`);
  await page.getByLabel("Project", { exact: false }).first().fill("E2E-DEMO");
  await page.getByLabel("Token").fill("e2e-token");
  await page.getByRole("button", { name: "Add connection" }).click();
  await expect(page.getByTestId("revealed-secret")).toBeVisible();
  await shot(page, "phase2-21-pm-connections");
  await page.getByRole("button", { name: "Dismiss" }).click();
  track.assertClean("pm connections");
});

test("deploy targets: add a mock target with per-kind fields", async () => {
  await nav("Deploy targets", "Deploy targets");
  await page.getByLabel("Name").fill("e2e-target");
  await page.getByRole("button", { name: "Add target" }).click();
  await expect(page.getByText("Deploy target added").first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "e2e-target" })).toBeVisible();
  await shot(page, "phase2-22-deploy-targets");
  track.assertClean("deploy targets");
});

test("cost dashboard: fleet meters, project rollup with charts, Unattributed bucket", async () => {
  await nav("Cost dashboard", "Cost dashboard");
  await expect(page.getByText("Projects — fleet spend")).toBeVisible();
  await expect(page.getByText("Unattributed spend", { exact: false }).first()).toBeVisible();

  await page.getByRole("link", { name: "Open cost rollup for demo-project" }).click();
  // scope to the rollup card: the fleet table ABOVE it also has a "Budget vs
  // actual" column, so an unscoped text match is ambiguous the moment the
  // rollup query resolves. This assertion only ever passed by racing that
  // query — it was matching the fleet column header, not the rollup.
  const rollup = page.locator("section").filter({ hasText: "Showback by user" });
  await expect(rollup.getByText("Budget vs actual")).toBeVisible();
  await expect(rollup.getByText("Showback by user")).toBeVisible();
  await expect(page.getByRole("img", { name: "Showback by user" })).toBeVisible();
  await shot(page, "phase2-23-cost-dashboard");
  track.assertClean("cost dashboard");
});

test("optimization: savings by technique + event ledgers", async () => {
  await nav("Optimization", "Optimization");
  await expect(page.getByText("Savings by technique")).toBeVisible();
  await expect(page.getByText("Cost events — the raw optimization ledger")).toBeVisible();
  await shot(page, "phase2-24-optimization");
  track.assertClean("optimization");
});

test("compliance profiles: upsert a profile + live cascade preview", async () => {
  await nav("Compliance profiles", "Compliance profiles");
  await expect(page.getByRole("cell", { name: "hipaa" })).toBeVisible();

  await page.getByLabel("Tag").fill("e2e-framework");
  await page.getByLabel("Audit retention days (blank = none)").fill("30");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByText("Profile saved", { exact: false }).first()).toBeVisible();

  // cascade preview on the classified seeded project
  const preview = page.locator("section", { hasText: "Cascade preview" }).first();
  await preview.getByLabel("Project").selectOption({ label: "hipaa-project" });
  await preview.getByRole("button", { name: "Preview cascade" }).click();
  await expect(page.getByTestId("cascade-preview")).toBeVisible();
  await expect(page.getByText("Effective policy (cascaded)")).toBeVisible();
  await shot(page, "phase2-25-compliance-cascade");
  track.assertClean("compliance profiles");
});

test("infrastructure: posture, set approver, propose a governed remediation", async () => {
  await nav("Infrastructure", "Infrastructure");
  await expect(page.getByText("monitored resources", { exact: true })).toBeVisible();

  // persist the org default remediation approver
  await page.getByLabel("Remediation approver (persisted org default)").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Set approver" }).click();
  await expect(page.getByText("Default remediation approver saved", { exact: false }).first()).toBeVisible();

  // propose remediation on the first open finding via the owned confirm modal
  const proposeBtn = page.getByRole("button", { name: "propose remediation" }).first();
  await expect(proposeBtn).toBeVisible();
  await proposeBtn.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Propose" }).click();
  await expect(page.getByText("Proposed — awaiting the named approver", { exact: false }).first()).toBeVisible();
  await shot(page, "phase2-26-infrastructure");
  track.assertClean("infrastructure");
});

// six sections since ADR-0034 added the custom-model-provider master switch
test("organization: the six-section org settings form saves partially", async () => {
  await nav("Organization", "Organization");
  await expect(page.getByText("1 · Optimization", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Save approval policy" }).click();
  await expect(page.getByText("Approval policy saved", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: "Save optimization settings" }).click();
  await expect(page.getByText("Optimization settings saved", { exact: false }).first()).toBeVisible();
  await shot(page, "phase2-27-organization");
  track.assertClean("organization");
});

test("getting started: live checklist with deep links into the new views", async () => {
  await nav("Getting started", "Getting started");
  await expect(page.getByText("steps done")).toBeVisible();
  await expect(page.getByRole("button", { name: "Re-check" })).toBeVisible();
  await shot(page, "phase2-28-getting-started");
  track.assertClean("getting started");
});

test("dark theme: flagship views render AA-clean in dark", async () => {
  await page.getByRole("button", { name: /Switch to (light|dark) theme/ }).click();
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  expect(theme === "dark" || theme === "light").toBe(true);

  await nav("Simulation", "Simulation / access preview");
  await shot(page, "phase2-29-simulation-dark");
  await nav("Cost dashboard", "Cost dashboard");
  await shot(page, "phase2-30-cost-dark");
  await nav("Users", "Users");
  await shot(page, "phase2-31-users-dark");
  track.assertClean("dark theme sweep");
});

/**
 * ADR-0026 end-user residual #2, the hard half: what the BYO-key surface does
 * when ADR-0024's key custody is enforced. Both readers are covered, because
 * they learn it differently — an admin reads
 * `GET /v1/interception/settings` up front, a developer cannot (that read is
 * admin-only) and can only learn it from the 409 on write. Neither may be
 * offered a control that cannot work, and neither may be told a stored key is
 * in use. Runs last, and restores the toggle.
 */
test("key custody enforced: the key card explains the state instead of offering a broken control", async ({
  browser,
}) => {
  await nav("Client access", "Client access");
  await page.getByLabel("Enforce key custody").selectOption("true");
  await page.getByRole("button", { name: "Save posture" }).click();
  await expect(page.getByText("Posture saved").first()).toBeVisible();

  // (a) the ADMIN path — proactive, no failed write needed
  await page.getByRole("button", { name: /Ada Admin/ }).click();
  await page.getByRole("menuitem", { name: "Your model keys" }).click();
  await expect(page.getByText("This deployment enforces key custody.")).toBeVisible();
  await expect(page.getByText("kept, not deleted, and inert")).toBeVisible();
  // the control that would 409 is GONE, not merely disabled
  await expect(page.getByLabel("API key")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Save|Replace) key$/ })).toHaveCount(0);
  await shot(page, "phase2-32-key-custody-admin-dark");
  track.assertClean("key custody — admin view");

  // (b) the NON-ADMIN path — avery cannot read the posture, so the refusal is
  // what teaches her, and it must land as the same explanation
  const dev = await browser.newPage();
  const devTrack = trackConsole(dev);
  await dev.goto("/ui");
  await dev.getByLabel("Email").fill("avery@regulait.local");
  await dev.getByLabel("Password", { exact: true }).fill(state.passwords.avery);
  await dev.getByRole("button", { name: "Sign in" }).click();
  await dev.getByLabel("Current (one-time) password").fill(state.passwords.avery);
  await dev.getByLabel("New password", { exact: true }).fill("E2e-Avery-Custody!");
  await dev.getByLabel("Confirm new password").fill("E2e-Avery-Custody!");
  await dev.getByRole("button", { name: "Set password & continue" }).click();
  await expect(dev.getByRole("heading", { name: /Welcome back/ })).toBeVisible();

  await dev.goto("/ui/account?section=keys");
  // she has no way to know yet, so the form is offered…
  const keyField = dev.getByLabel("API key");
  await expect(keyField).toBeVisible();
  await keyField.fill("sk-e2e-custody-refused-0123456789");
  await dev.getByRole("button", { name: "Save key" }).click();

  // …and the refusal turns into the explanation, not a raw error string
  await expect(dev.getByText("This deployment enforces key custody.")).toBeVisible();
  await expect(dev.getByText("An admin can lift it in Client access.")).toBeVisible();
  await expect(dev.getByLabel("API key")).toHaveCount(0);
  await expect(dev.getByText("No keys of your own")).toBeVisible();
  expect(await dev.content()).not.toContain("sk-e2e-custody-refused");
  await shot(dev, "phase2-33-key-custody-developer");
  devTrack.assertClean("key custody — developer view");
  await dev.close();

  // restore the deployment posture for anything that runs after this
  await nav("Client access", "Client access");
  await page.getByLabel("Enforce key custody").selectOption("false");
  await page.getByRole("button", { name: "Save posture" }).click();
  await expect(page.getByText("Posture saved").first()).toBeVisible();
  track.assertClean("key custody — restored");
});
