/**
 * Batch I-2 rollout D (owner, #453): the governance pages deferred from #655 and #657, against a mocked gateway (the
 * *.mock.spec.ts harness).
 *
 *  - Guardrails (pattern 5, control matrix): one matrix row per detector with Control, State, Source, Fix and what it
 *    refuses at block; the posture line stays above the tabs; each tab is paired with its tabpanel, panels stay
 *    mounted so a draft survives a tab switch, and a tab label names what is unresolved inside it.
 *  - SoD rules and Simulation (pattern 4, one empty state): while nothing exists, exactly one empty state shows, after
 *    the primary action; a failed read is never shown as empty; as soon as anything exists the page renders as before.
 *  - axe (WCAG 2.x A/AA, light and dark) through the shared helper.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000d4`;
const T = "2026-10-20T12:00:00.000Z";
const ME_ID = U(99);
const ME = { userId: ME_ID, isAdmin: true, user: { id: ME_ID, email: "ada@example.test", displayName: "Ada Admin" } };

/** an answer with a status, for a read that fails */
const fail = (status: number, body: unknown = { error: "internal" }) => ({ __status: status, body });

/** a table of `METHOD /path` → body (or a fail()); anything else answers `{}` */
async function mockApi(page: Page, routes: Record<string, unknown>) {
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    const h = routes[`${req.method()} ${p}`];
    if (h === undefined) return json(route, {});
    if (h && typeof h === "object" && "__status" in h) {
      const f = h as { __status: number; body: unknown };
      return json(route, f.body, f.__status);
    }
    return json(route, h);
  });
}

/** "No … yet" / "Nothing … yet" headings in the main region: the page's empty states */
const emptyTitles = (page: Page) => page.locator("main").getByText(/^No .* yet$|^Nothing .* yet$|^No SoD rule is defined$/);

const height = (page: Page) => page.evaluate(() => document.documentElement.scrollHeight);

// ---------------------------------------------------------------------------
// Guardrails: the control matrix
// ---------------------------------------------------------------------------

const AGENT = { id: U(1), name: "Claims assistant", provider: "mock", tier: 1, enabled: true };
const PROJECT = { id: U(2), name: "Claims" };
const DETECTORS = {
  detectors: [
    { id: "prompt_injection", tier: "rules", phases: ["input"], summary: "Prompt injection phrasings", limits: "Literal phrasings only.", ruleCount: 12, configurable: true },
    { id: "jailbreak", tier: "rules", phases: ["input"], summary: "Jailbreak phrasings", limits: "Misses novel jailbreaks.", ruleCount: 9, configurable: true },
    { id: "toxicity", tier: "rules", phases: ["output"], summary: "Toxic completions", limits: "Fires on some benign text.", ruleCount: 7, configurable: true },
  ],
  // the gateway's shipped posture (ADR-0181 GUARDRAIL_DEFAULT_MODES), as the real API returns it (review of #692)
  shippedDefaults: { prompt_injection: "block", jailbreak: "block", toxicity: "warn" },
  note: "",
};
const CONFIG = {
  org: null,
  // with no deployment default, the gateway reports the shipped modes as orgModes (apps/gateway/src/guardrails.ts)
  orgModes: { prompt_injection: "block", jailbreak: "block", toxicity: "warn" },
  shippedDefaults: { prompt_injection: "block", jailbreak: "block", toxicity: "warn" },
  overrides: [
    { id: U(3), scope: "agent", scopeId: AGENT.id, modes: { prompt_injection: "warn" }, targetName: AGENT.name, customTerms: {}, updatedAt: T },
  ],
};
const EFFECTIVE = {
  modes: { prompt_injection: "warn", jailbreak: "block", toxicity: "block" },
  provenance: [
    { detector: "prompt_injection", orgDefault: "block", override: "warn", complianceFloor: null, effective: "warn" },
    { detector: "jailbreak", orgDefault: "block", override: null, complianceFloor: null, effective: "block" },
    { detector: "toxicity", orgDefault: "warn", override: null, complianceFloor: "block", effective: "block" },
  ],
  active: true,
  blocksInput: true,
  blocksOutput: false,
  streamingNote: "Output detectors scan a streamed reply once it has finished.",
};
const GUARDRAILS: Record<string, unknown> = {
  "GET /v1/agents": { agents: [AGENT] },
  "GET /v1/connectors": { connectors: [] },
  "GET /v1/projects": { projects: [PROJECT] },
  "GET /v1/guardrails/detectors": DETECTORS,
  "GET /v1/guardrails/config": CONFIG,
  "GET /v1/guardrails/effective": EFFECTIVE,
  "GET /v1/guardrails/violations": { items: [], violations: [], totals: { blocked: 0, warned: 0, logged: 0 }, nextCursor: null, nextOffset: null, total: 0 },
  "GET /v1/guardrails/trained-detectors": { detectors: [], scorers: [] },
  "GET /v1/detection-content": {
    packs: [{ id: "pipelock-secrets", source: "Pinned fixture", repo: "https://example.test/source", commit: "a".repeat(40), sha256: "b".repeat(64), licence: "Apache-2.0", rules: 61, notImported: [], enabled: false }],
    outboundAudienceEnforced: true,
  },
};

test.describe("I-2 rollout D: Guardrails", () => {
  test("the matrix names each detector's state, source, fix and what it refuses at block; the posture line sits above the tabs", async ({ page }) => {
    await mockApi(page, GUARDRAILS);
    await page.goto("/ui/admin/guardrails");
    await expect(page.getByRole("heading", { name: "Guardrails", level: 1 })).toBeVisible();
    const posture = page.getByRole("group", { name: "Guardrail posture" });
    // the posture follows the gateway's shipped modes: two detectors refuse by default (review of #692)
    await expect(posture.getByText("Shipped posture applies")).toBeVisible();
    await expect(posture.getByText("nothing refused")).toHaveCount(0);
    await expect(posture.getByText("Blocking by default: 2 of 3")).toBeVisible();
    await posture.getByRole("button", { name: /the shipped posture/ }).click();
    await expect(page.getByText("the shipped posture applies: prompt injection block, jailbreak block, toxicity warn.", { exact: false }).first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(posture.getByText("Overrides: 1")).toBeVisible();

    const matrix = page.locator("[data-rg-card]").filter({ hasText: "What actually applies (and why)" });
    await expect(matrix.locator("thead th")).toHaveText(["", "Control", "State", "Source", "Fix", "At block, it refuses"].slice(1));
    const pi = matrix.getByRole("row").filter({ hasText: "prompt injection" });
    await expect(pi.getByText("warn", { exact: true })).toBeVisible();
    await expect(pi.getByText("Override for the agent")).toBeVisible();
    await expect(pi.getByText("A prompt on the way in that it matches.", { exact: false })).toBeVisible();
    const tx = matrix.getByRole("row").filter({ hasText: "toxicity" });
    await expect(tx.getByText("block", { exact: true })).toBeVisible();
    await expect(tx.getByText("Compliance floor of the project")).toBeVisible();
    await expect(tx.getByText(/Nothing on this page can lower it/)).toBeVisible();
    const jb = matrix.getByRole("row").filter({ hasText: "jailbreak" });
    await expect(jb.getByText("block", { exact: true })).toBeVisible();
    await expect(jb.getByText("Shipped default (no deployment default set)")).toBeVisible();
    // each detector's limits stay one (i) away, in the matrix as well as next to its switch
    await expect(matrix.getByRole("button", { name: /the limits of jailbreak/ })).toBeVisible();
    await expect(matrix.getByText(EFFECTIVE.streamingNote)).toBeVisible();

    // a tab label names what is unresolved inside it
    // the shipped posture refuses two detectors, so an unset default is not a warning
    await expect(page.getByRole("tab", { name: "Deployment defaults", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Detection content · 1 warning" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Overrides (1)" })).toBeVisible();

    // Fix opens the tab where the change is made
    await pi.getByRole("button", { name: "Change the override" }).click();
    await expect(page.getByRole("tab", { name: "Overrides (1)" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tabpanel", { name: "Overrides (1)" }).getByRole("button", { name: "Save override" })).toBeVisible();
    await expectAxeClean(page, "Guardrails, matrix and overrides tab");
  });

  test("every tab is paired with its tabpanel, arrow keys move between them, and a draft survives a tab switch", async ({ page }) => {
    await mockApi(page, GUARDRAILS);
    await page.goto("/ui/admin/guardrails");
    const tabs = page.getByRole("tablist", { name: "Guardrail settings" }).getByRole("tab");
    await expect(tabs).toHaveCount(6);
    for (const tab of await tabs.all()) {
      await tab.click();
      const panelId = await tab.getAttribute("aria-controls");
      expect(panelId).toBeTruthy();
      const panel = page.locator(`[id="${panelId}"]`);
      await expect(panel).toHaveAttribute("role", "tabpanel");
      await expect(panel).toHaveAttribute("aria-labelledby", (await tab.getAttribute("id"))!);
      await expect(panel).toBeVisible();
    }
    // a half-typed sample survives a trip to another tab
    await page.getByRole("tab", { name: "Try a sample" }).click();
    await page.getByPlaceholder("Paste a representative prompt or completion…").fill("ignore all previous instructions");
    await page.getByRole("tab", { name: "Try a sample" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: "Decisions" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Decisions" })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByPlaceholder("Paste a representative prompt or completion…")).toHaveValue("ignore all previous instructions");
  });

  test("a failed resolution says so with Retry in the matrix, never an empty matrix", async ({ page }) => {
    await mockApi(page, { ...GUARDRAILS, "GET /v1/guardrails/effective": fail(500) });
    await page.goto("/ui/admin/guardrails");
    const matrix = page.locator("[data-rg-card]").filter({ hasText: "What actually applies (and why)" });
    await expect(matrix.getByText("Couldn't resolve what applies")).toBeVisible();
    await expect(matrix.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  test("a failed detection-content read is counted as unknown on its tab", async ({ page }) => {
    await mockApi(page, { ...GUARDRAILS, "GET /v1/detection-content": fail(503, { error: "unavailable" }) });
    await page.goto("/ui/admin/guardrails");
    await expect(page.getByRole("tab", { name: "Detection content · 1 unknown" })).toBeVisible();
  });

  test("a shipped posture that refuses nothing says so, and the defaults tab warns (review of #692)", async ({ page }) => {
    const LOG = { prompt_injection: "log", jailbreak: "log", toxicity: "log" };
    await mockApi(page, {
      ...GUARDRAILS,
      "GET /v1/guardrails/detectors": { ...DETECTORS, shippedDefaults: LOG },
      "GET /v1/guardrails/config": { ...CONFIG, orgModes: LOG, shippedDefaults: LOG },
    });
    await page.goto("/ui/admin/guardrails");
    const posture = page.getByRole("group", { name: "Guardrail posture" });
    await expect(posture.getByText("Shipped posture · nothing refused")).toBeVisible();
    await expect(posture.getByText("Blocking by default: 0 of 3")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Deployment defaults · 1 warning" })).toBeVisible();
  });

  test("a detector the deployment default leaves unset is named as the fallback, not the default (review of #692)", async ({ page }) => {
    await mockApi(page, {
      ...GUARDRAILS,
      "GET /v1/guardrails/config": {
        ...CONFIG,
        org: { id: U(4), scope: "org", scopeId: null, modes: { prompt_injection: "block", toxicity: "warn" }, customTerms: {}, updatedAt: T },
      },
    });
    await page.goto("/ui/admin/guardrails");
    const matrix = page.locator("[data-rg-card]").filter({ hasText: "What actually applies (and why)" });
    // jailbreak is absent from the deployment default's modes, so it runs on the fallback mode
    await expect(matrix.getByRole("row").filter({ hasText: "jailbreak" }).getByText("Fallback mode (the deployment default leaves this detector unset)")).toBeVisible();
    await expect(matrix.getByRole("row").filter({ hasText: "toxicity" }).getByText("Compliance floor of the project")).toBeVisible();
    await expect(page.getByRole("group", { name: "Guardrail posture" }).getByText("Deployment defaults set")).toBeVisible();
  });

  for (const width of [390, 375]) {
    test(`the matrix adds no horizontal page scroll at ${width} px (review of #692)`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await mockApi(page, GUARDRAILS);
      await page.goto("/ui/admin/guardrails");
      await expect(page.getByText(EFFECTIVE.streamingNote)).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
    });
  }

  test("height at 1440 px", async ({ page }, info) => {
    await mockApi(page, GUARDRAILS);
    await page.goto("/ui/admin/guardrails");
    await expect(page.getByRole("heading", { name: "Guardrails", level: 1 })).toBeVisible();
    await expect(page.getByText(EFFECTIVE.streamingNote)).toBeVisible();
    info.annotations.push({ type: "height", description: `guardrails ${await height(page)}` });
  });
});

// ---------------------------------------------------------------------------
// SoD rules: one empty state
// ---------------------------------------------------------------------------

const PAGE_EMPTY = (legacy: string) => ({ items: [], [legacy]: [], nextCursor: null, nextOffset: null, total: 0 });
const SOD_EMPTY: Record<string, unknown> = {
  "GET /v1/sod/rules": { rules: [], notes: { enforcement: "Enforced where grants are minted." } },
  "GET /v1/sod/overrides": PAGE_EMPTY("overrides"),
  "GET /v1/users": { users: [{ id: ME_ID, email: "ada@example.test", displayName: "Ada Admin" }] },
  "GET /v1/agents": { agents: [AGENT] },
  "GET /v1/connectors": { connectors: [] },
  "GET /v1/servers": { servers: [] },
};
const RULE = {
  id: U(10),
  name: "payment vs vendor-master",
  reason: "enables invoice fraud",
  enabled: true,
  sides: [
    { kind: "agent", objectId: U(11), toolName: null, mode: null, pattern: null, label: "Payments agent" },
    { kind: "agent", objectId: U(12), toolName: null, mode: null, pattern: null, label: "Vendor-master agent" },
  ],
  createdAt: T,
  currentViolators: [],
};

test.describe("I-2 rollout D: SoD rules", () => {
  test("nothing declared: one empty state after the declare form; escalation and overrides wait for a rule", async ({ page }) => {
    await mockApi(page, SOD_EMPTY);
    await page.goto("/ui/admin/sod");
    await expect(page.getByRole("heading", { name: "SoD rules", level: 1 })).toBeVisible();
    await expect(page.getByText("No SoD rule is defined", { exact: true })).toBeVisible();
    await expect(emptyTitles(page)).toHaveCount(1);
    // the primary action comes first
    await expect(page.getByRole("button", { name: "Create rule" })).toBeVisible();
    const first = await page.getByRole("button", { name: "Create rule" }).boundingBox();
    const empty = await page.getByText("No SoD rule is defined", { exact: true }).boundingBox();
    expect(first!.y).toBeLessThan(empty!.y);
    await expect(page.getByText("Escalate a refused mint")).toHaveCount(0);
    await expect(page.getByText("Override requests")).toHaveCount(0);
    // what escalation needs stays one (i) away
    await page.getByRole("button", { name: /escalating a refusal/ }).click();
    await expect(page.getByText(/A mint no enabled rule refuses cannot be escalated/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expectAxeClean(page, "SoD rules, nothing yet");
  });

  test("a failed overrides read is never the empty state: the page renders as before and the list says it failed", async ({ page }) => {
    await mockApi(page, { ...SOD_EMPTY, "GET /v1/sod/overrides": fail(500) });
    await page.goto("/ui/admin/sod");
    await expect(page.getByText("Escalate a refused mint")).toBeVisible();
    const overrides = page.locator("[data-rg-card]").filter({ hasText: "Override requests" });
    await expect(overrides.getByRole("button", { name: "Retry" })).toBeVisible();
    await expect(page.getByText(/so no mint is refused and no override has been requested/)).toHaveCount(0);
  });

  test("a failed rules read shows the error with Retry, never the empty state", async ({ page }) => {
    await mockApi(page, { ...SOD_EMPTY, "GET /v1/sod/rules": fail(500) });
    await page.goto("/ui/admin/sod");
    await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
    await expect(page.getByText("No SoD rule is defined")).toHaveCount(0);
  });

  test("one rule is something: the page renders its sections as before", async ({ page }) => {
    await mockApi(page, { ...SOD_EMPTY, "GET /v1/sod/rules": { rules: [RULE], notes: { enforcement: "" } } });
    await page.goto("/ui/admin/sod");
    await expect(page.getByRole("row", { name: /payment vs vendor-master/ })).toBeVisible();
    await expect(page.getByText("Escalate a refused mint")).toBeVisible();
    await expect(page.getByText("No override has been requested")).toBeVisible();
  });

  test("height at 1440 px", async ({ page }, info) => {
    await mockApi(page, SOD_EMPTY);
    await page.goto("/ui/admin/sod");
    await expect(page.getByText("No SoD rule is defined", { exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    info.annotations.push({ type: "height", description: `sod ${await height(page)}` });
  });
});

// ---------------------------------------------------------------------------
// Simulation: one empty state
// ---------------------------------------------------------------------------

const SIM_EMPTY: Record<string, unknown> = {
  "GET /v1/policy-simulations": { ...PAGE_EMPTY("simulations"), fidelity: "Replays recorded decisions; never dispatches." },
  "GET /v1/users": { users: [{ id: ME_ID, email: "ada@example.test", displayName: "Ada Admin" }] },
  "GET /v1/servers": { servers: [] },
};
const SIM_ROW = {
  id: U(20),
  policyName: "Claims policy",
  policyVersion: 3,
  considered: 120,
  newlyDenied: 4,
  newlyApprovalRequired: 0,
  newlyAllowed: 0,
  unchanged: 116,
  indeterminate: 0,
  affectedUsers: 2,
  affectedProjects: 1,
  affectedTools: 1,
  capped: false,
  fidelityExact: true,
  fidelityCaveats: [],
  headline: "4 calls would be newly blocked",
  windowDays: 30,
  blastRadius: {},
  createdAt: T,
};

test.describe("I-2 rollout D: Simulation", () => {
  test("nothing previewed: one empty state after both forms, the fidelity (i) kept", async ({ page }) => {
    await mockApi(page, SIM_EMPTY);
    await page.goto("/ui/admin/simulation");
    await expect(page.getByRole("heading", { name: "Simulation / access preview", level: 1 })).toBeVisible();
    await expect(page.getByText("Nothing previewed yet", { exact: true })).toBeVisible();
    await expect(emptyTitles(page)).toHaveCount(1);
    await expect(page.getByText("Run an evaluation to see the decision")).toHaveCount(0);
    await expect(page.getByText("Previous previews")).toHaveCount(0);
    // the primary actions come first
    const preview = await page.getByRole("button", { name: "Preview", exact: true }).boundingBox();
    const empty = await page.getByText("Nothing previewed yet", { exact: true }).boundingBox();
    expect(preview!.y).toBeLessThan(empty!.y);
    await expect(page.getByRole("button", { name: "Evaluate" })).toBeVisible();
    await page.getByRole("button", { name: /the blast-radius dry run/ }).click();
    await expect(page.getByText("Replays recorded decisions; never dispatches.")).toBeVisible();
    await page.keyboard.press("Escape");
    await expectAxeClean(page, "Simulation, nothing yet");
  });

  test("a failed history read is never the empty state: the page renders as before and the list says it failed", async ({ page }) => {
    await mockApi(page, { ...SIM_EMPTY, "GET /v1/policy-simulations": fail(500) });
    await page.goto("/ui/admin/simulation");
    await expect(page.getByText("Previous previews")).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
    await expect(page.getByText("Nothing previewed yet")).toHaveCount(0);
  });

  test("one kept preview is something: the page renders its sections as before", async ({ page }) => {
    await mockApi(page, { ...SIM_EMPTY, "GET /v1/policy-simulations": { items: [SIM_ROW], simulations: [SIM_ROW], nextCursor: null, nextOffset: null, total: 1, fidelity: "f" } });
    await page.goto("/ui/admin/simulation");
    await expect(page.getByText("Run an evaluation to see the decision")).toBeVisible();
    await expect(page.getByText("Previous previews")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open the preview of Claims policy v3" })).toBeVisible();
    await expect(page.getByText("Nothing previewed yet")).toHaveCount(0);
  });

  test("an incomplete dry run is shown as incomplete, not as nothing", async ({ page }) => {
    await mockApi(page, {
      ...SIM_EMPTY,
      "POST /v1/policy-simulations": { status: "incomplete", evaluated: 10, total: 50, deadlineMs: 5000, detail: "The deadline was reached; nothing was stored." },
    });
    await page.goto("/ui/admin/simulation");
    await page.getByLabel("Proposed policy version id").fill(U(30));
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.getByTestId("simulation-incomplete")).toContainText("Incomplete: 10 of 50");
    await expect(page.getByText("Nothing previewed yet")).toHaveCount(0);
    await expect(page.getByText("Previous previews")).toBeVisible();
  });

  test("height at 1440 px", async ({ page }, info) => {
    await mockApi(page, SIM_EMPTY);
    await page.goto("/ui/admin/simulation");
    await expect(page.getByRole("heading", { name: "Simulation / access preview", level: 1 })).toBeVisible();
    await page.waitForTimeout(800);
    info.annotations.push({ type: "height", description: `simulation ${await height(page)}` });
  });
});
