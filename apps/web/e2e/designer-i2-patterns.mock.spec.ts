/**
 * Batch I-2 (owner, #453): five layout patterns, against a mocked gateway (the *.mock.spec.ts harness).
 *
 *  - Traces: the status row stays above the tabs, so the Export chip is visible on every tab.
 *  - Billing: the Statement step's Cut statement acts on the newest open period, with the Period row's toast; with
 *    no open period it is disabled and says why.
 *  - Risks: a register row expands in place from the keyboard (a button with aria-expanded and aria-controls), and
 *    the detail it opens takes focus as a named region, so a screen reader reads it; Esc closes it again.
 *  - Red-teaming: one empty state while nothing exists, and the green-run qualifier stays.
 *  - Enforcement posture: each settings tab names what is unresolved inside it; a clear tab shows only its name.
 *  - axe (WCAG 2.x A/AA, light and dark) on each, through the shared helper.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

type Json = Record<string, unknown>;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000a2`;
const T = "2026-10-20T12:00:00.000Z";
const ME = { userId: U(99), isAdmin: true, user: { id: U(99), email: "ada@example.test", displayName: "Ada Admin" } };

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** a table of `METHOD /path` → body (or a function of the request body); anything else answers `{}` */
async function mockApi(page: Page, routes: Record<string, unknown>): Promise<Call[]> {
  const calls: Call[] = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    let body: unknown;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.push({ method: req.method(), path: p, body });
    if (p === "/auth/me") return json(route, { ...ME, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, ME);
    const h = routes[`${req.method()} ${p}`];
    if (h === undefined) return json(route, {});
    return json(route, typeof h === "function" ? (h as (b: unknown) => unknown)(body) : h);
  });
  return calls;
}

// ---------------------------------------------------------------------------

test.describe("I-2: Traces keeps its status row above the tabs", () => {
  test("the Export chip stays visible on every tab", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/tracing/config": {
        enabled: true,
        captureContent: false,
        previewMaxChars: 4000,
        otlp: { configured: false, endpoint: null, serviceName: "regulait-gateway", headerNames: [] },
        limits: "Export is a pull over a bounded window.",
        retention: "Traces follow the audit retention floor.",
        note: "",
        profiles: ["otel_genai"],
      },
      "GET /v1/sessions": { sessions: [], scope: "fleet" },
      "GET /v1/traces": { traces: [], total: 0, scope: "fleet", note: "" },
      "GET /v1/agents": { agents: [] },
      "GET /v1/evals/datasets": { datasets: [], note: "" },
      "GET /v1/annotation-queues": { queues: [] },
      "GET /v1/automation-rules": { rules: [], retention: { floorDays: 90, maxHoldDays: 180 } },
      "GET /v1/retention-holds": { holds: [] },
    });
    await page.goto("/ui/admin/traces");
    await expect(page.getByRole("heading", { name: "Traces", level: 1 })).toBeVisible();
    const status = page.getByRole("group", { name: "Tracing status" });
    const tabs = ["Traces", "Export", "Retention", "Automations", "Evaluation"];
    await expect(page.getByRole("tablist", { name: "Traces" }).getByRole("tab")).toHaveText(tabs);
    for (const name of tabs) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toBeVisible();
      await expect(status.getByText("Export: not configured", { exact: true })).toBeVisible();
      await expect(status.getByText("Recording: on", { exact: true })).toBeVisible();
    }
    // the chip's own button opens the Export tab, where the full posture is
    await page.getByRole("tab", { name: "Traces", exact: true }).click();
    await status.getByRole("button", { name: "Export settings" }).click();
    await expect(page.getByRole("tab", { name: "Export", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Export and posture", { exact: true })).toBeVisible();
    await expectAxeClean(page, "Traces, Export tab");
  });
});

// ---------------------------------------------------------------------------

test.describe("I-2: Billing cuts a statement from the Statement step", () => {
  const RC = { id: U(1), name: "standard", version: 1, currency: "USD", status: "active", createdAt: T };
  const SEP = { id: U(2), scopeKind: "org", scopeId: null, periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z", status: "open", closedAt: null };
  const OCT = { ...SEP, id: U(3), periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z" };
  const overview = (periods: Json[]) => ({
    rateCards: [RC],
    periods,
    statements: [],
    exports: [],
    activeSeats: 3,
    backend: { name: "noop", capabilities: {} },
    ledger: { totalEvents: 0, totalListPriceUsd: 0 },
    schedulerPresent: false,
    paymentProcessorIntegrated: false,
    reconciledRatingAvailable: false,
    disclaimer: "",
    note: "",
  });
  const CUT = {
    statement: { id: U(4), version: 1, coversFullScope: true },
    report: {
      periodLabel: "2026-10",
      ratingMode: "estimated",
      usageSubtotalUsd: 0,
      seatSubtotalUsd: 120,
      totalUsd: 120,
      disclaimer: "Not a tax invoice.",
      pricing: { name: "standard", version: 1, currency: "USD", entries: [] },
      seats: { seatCount: 3, billedUsd: 120, note: "" },
      usage: { eventCount: 0, unpricedEventCount: 0, measuredInputTokens: 0, measuredOutputTokens: 0, ledgerEstimatedCostUsd: 0, lines: [] },
    },
    scope: { effectiveProjectIds: null, coversFullScope: true },
  };

  test("Cut statement acts on the newest open period, with the same toast as a period row", async ({ page }) => {
    const calls = await mockApi(page, {
      "GET /v1/billing/overview": overview([SEP, OCT, { ...SEP, id: U(5), periodStart: "2026-11-01T00:00:00.000Z", periodEnd: "2026-12-01T00:00:00.000Z", status: "closed", closedAt: T }]),
      [`POST /v1/billing/periods/${OCT.id}/statements`]: CUT,
    });
    await page.goto("/ui/admin/billing");
    const steps = page.getByRole("list", { name: "Billing set-up" });
    // a rate card and a period exist, so the stepper opens on the Statement step
    await expect(steps.getByRole("button", { name: /^Statement/ })).toHaveAttribute("aria-current", "step");
    const cut = page.getByRole("button", { name: "Cut statement", exact: true });
    await expect(cut).toBeEnabled();
    await expect(cut).toHaveAccessibleDescription("For the newest open period: org, 2026-10-01 → 2026-11-01");
    await expectAxeClean(page, "Billing, Statement step");
    await cut.click();
    await expect(page.getByText("Statement cut (draft)", { exact: true })).toBeVisible();
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual([`/v1/billing/periods/${OCT.id}/statements`]);
    await expect(page.getByText("Statement v1 — 2026-10", { exact: true })).toBeVisible();
  });

  test("with no open period the button is disabled and says why", async ({ page }) => {
    await mockApi(page, { "GET /v1/billing/overview": overview([{ ...SEP, status: "closed", closedAt: T }]) });
    await page.goto("/ui/admin/billing");
    const cut = page.getByRole("button", { name: "Cut statement", exact: true });
    await expect(cut).toBeDisabled();
    await expect(cut).toHaveAccessibleDescription("No open period to cut a statement for. Open one on the Period step first.");
    await expect(page.getByText("No open period to cut a statement for. Open one on the Period step first.")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------

test.describe("I-2: the Risks register expands in place", () => {
  const RISK = {
    id: U(10),
    title: "Prompt injection steers the claims assistant",
    description: "Adversarial documents redirect the assistant.",
    category: "prompt_injection",
    ownerUserId: U(11),
    ownerName: "Olive Owner",
    projectId: null,
    agentId: null,
    useCaseId: null,
    status: "open",
    likelihood: "high",
    impact: "high",
    mitigation: "Injection detection at block.",
    acceptedByUserId: null,
    acceptedAt: null,
    acceptanceNote: null,
    createdAt: T,
    controls: [],
  };
  const TOLERANCES = {
    source: "default",
    strictDefault: { maxBand: "medium" },
    tolerances: [],
    effective: { categories: { prompt_injection: { maxBand: "medium", source: "default" } }, tiers: { high: { maxBand: "medium", source: "default" } } },
    bands: ["none", "low", "medium", "high", "critical"],
  };

  test("a row opens from the keyboard, its detail is read as a region, and Esc closes it", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/risks": { risks: [RISK], disclaimer: "d" },
      "GET /v1/risk-tolerances": TOLERANCES,
      [`GET /v1/risks/${RISK.id}`]: {
        risk: RISK,
        declared: { likelihood: "high", impact: "high", residual: null, status: "open", mitigation: RISK.mitigation, acceptance: null, note: "n" },
        evidence: { window: { start: T, end: T, days: 90 }, scope: { projectId: null, agentId: null }, entries: [], computedAt: T, note: "live", disclaimer: "d" },
      },
      [`GET /v1/risks/${RISK.id}/acceptances`]: {
        riskId: RISK.id,
        position: { riskId: RISK.id, band: "high", tolerance: { band: "medium", source: "default" }, acceptance: null, aboveTolerance: true, maxAcceptanceMonths: 6, maxExpiresAt: "2027-04-20T12:00:00.000Z" },
        canAccept: false,
        acceptRefusal: "You own this risk, so someone else must accept it.",
        acceptances: [],
      },
      "GET /v1/agents": { agents: [] },
      "GET /v1/projects": { projects: [] },
    });
    await page.goto("/ui/admin/risks");
    // the tolerance as one chip, the panels on demand
    await expect(page.getByRole("group", { name: "Effective risk tolerance" })).toContainText("residual risk above medium");
    await expect(page.getByRole("button", { name: "Register a risk" })).toHaveAttribute("aria-expanded", "false");

    const toggle = page.getByRole("button", { name: `Details: ${RISK.title}` });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    const controls = await toggle.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    // it controls the detail row that follows it, present (hidden) while closed so the reference never dangles
    await expect(page.locator(`[id="${controls}"]`)).toBeHidden();

    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    const region = page.getByRole("region", { name: `Details: ${RISK.title}` });
    await expect(region).toBeVisible();
    await expect(region).toBeFocused();
    await expect(page.locator(`[id="${controls}"]`)).toContainText("Declared — human judgments");
    await expect(region).toContainText("Residual risk against tolerance");
    await expectAxeClean(page, "Risks, an expanded register row");

    await page.keyboard.press("Escape");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toBeFocused();
    await expect(region).toHaveCount(0);

    // Space toggles it too, as on any button
    await page.keyboard.press(" ");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});

// ---------------------------------------------------------------------------

test.describe("I-2: Red-teaming shows one empty state while nothing exists", () => {
  test("nothing probed: one empty state, the green-run qualifier, and tabs for the rest", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/redteam/attack-classes": {
        attackClasses: [{ id: "prompt_injection", summary: "s", limits: "l" }],
        disclosure: "A green run means no probe in this library version succeeded.",
        scheduling: { schedulerEnabled: false, posture: "off", note: "" },
      },
      "GET /v1/redteam/libraries": { libraries: [], note: "" },
      "GET /v1/redteam/runs": { runs: [] },
      "GET /v1/agents": { agents: [] },
      "GET /v1/projects": { projects: [] },
    });
    await page.goto("/ui/admin/redteam");
    await expect(page.getByRole("heading", { name: "Red-teaming", level: 1 })).toBeVisible();
    await expect(page.getByText("A green run: no probe got through, not proof of safety", { exact: true })).toBeVisible();
    await expect(page.getByText("Nothing has been probed yet", { exact: true })).toBeVisible();
    // exactly one empty state on the page, not one per card
    await expect(page.locator("main").getByText(/^No .* yet$|^Nothing .* yet$/)).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Install the shipped corpus" })).toBeVisible();
    await expect(page.getByRole("tablist", { name: "Red-teaming" }).getByRole("tab")).toHaveText([
      "Overview",
      "Libraries (0)",
      "Runs (0)",
      "Engines",
      "Attack classes",
    ]);
    await expectAxeClean(page, "Red-teaming, nothing probed");
    // "Start your own library" takes the reader to the Libraries tab
    await page.getByRole("button", { name: "Start your own library" }).click();
    await expect(page.getByRole("tab", { name: "Libraries (0)" })).toHaveAttribute("aria-selected", "true");
  });
});

// ---------------------------------------------------------------------------

test.describe("I-2: Enforcement posture tabs name what is unresolved inside them", () => {
  const control = (key: string, group: string, satisfied: boolean, settable = true) => ({
    key,
    group,
    current: satisfied ? "enforce" : "off",
    hardened: "enforce",
    satisfied,
    settable,
    refuses: `what ${key} refuses`,
  });
  const ISOLATION = {
    isolationEnforcement: "enforce",
    isolationFloorPublic: "user_space_kernel",
    isolationFloorInternal: "user_space_kernel",
    isolationFloorConfidential: "user_space_kernel",
    isolationFloorRegulated: "microvm",
    isolationFloorMcpStdio: "user_space_kernel",
    isolationFloorEngineWorker: "user_space_kernel",
    executorAttestationMaxAgeMinutes: 120,
  };
  // every BOM setting at its strict default
  const BOM = {
    decisionFactsCapture: "on",
    decisionBomFinality: "anchored",
    bomExportRoles: "admins_only",
    bomPersonIdentifiers: "id_only",
    aiBomSnapshotTriggers: "sign_off_events",
    aiBomSnapshotWithoutKey: "refuse",
    cyclonedxExportVersions: ["1.7"],
    bomExportRateLimitPerMinute: 30,
    decisionBomFiniteLockFinality: "refuse",
  };
  const posture = (discovery: Json | undefined) => ({
    hardened: false,
    summary: { enforcementSatisfied: 1, enforcementTotal: 2, optimisationSatisfied: 0, optimisationTotal: 1, blockedByEnvironment: [] },
    controls: [
      control("mcpAdmissionMode", "enforcement", true),
      { ...control("databaseTls", "enforcement", true, false), current: "required", hardened: "required" },
      control("semanticCachePolicy", "optimisation", false),
    ],
    execution: { mode: "normal", reason: null, setAt: null, restricted: false, note: "" },
    receiptSigningKey: { state: "operator_managed", keyId: "receipt-2026", publicKeyFingerprint: `sha256:${"a".repeat(64)}`, publicKeys: "/v1/receipts/keys", note: "Managed by the operator." },
    ...(discovery ? { discovery } : {}),
  });
  const CLEAR = {
    sourcesTotal: 1,
    sourcesEnabled: [],
    staticCredentials: [],
    staleCredentials: [],
    writeScopeUnverified: [],
    credentialsRefused: [],
    credentialWarningAgeDays: 90,
    endpointRetentionDays: 30,
    statement: "Active discovery is reported, never a control.",
  };
  const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });

  test("unknown and warning counts in the labels; a clear tab shows just its name", async ({ page }) => {
    // two isolation values not reported, one evidence key missing, one discovery source on a stale static credential
    const { isolationFloorPublic: _p, isolationFloorInternal: _i, ...partialIsolation } = ISOLATION;
    await mockApi(page, {
      "GET /v1/org/posture": posture({ ...CLEAR, staleCredentials: [{ sourceId: U(20), name: "acme-proxy", kind: "proxy", ageDays: 200 }] }),
      "GET /v1/org/settings": {
        settings: {
          ...partialIsolation,
          ...BOM,
          // vendoredDetectionPacks and outboundCredentialAudience left out: two unknown
          decisionReceiptsMode: "on",
          auditAnchorTimestampMode: "required",
        },
      },
      "GET /v1/receipts/keys": { keys: [{ keyId: "receipt-2026", jwk: { kty: "OKP" }, firstUsedAt: T, retiredAt: null }] },
    });
    await page.goto("/ui/admin/enforcement-posture");
    await expect(page.getByRole("heading", { name: "Enforcement posture", level: 1 })).toBeVisible();
    await expect(tab(page, "Isolation")).toHaveText("Isolation · 2 unknown");
    await expect(tab(page, "Discovery")).toHaveText("Discovery · 1 warning");
    await expect(tab(page, "BOM evidence")).toHaveText("BOM evidence");
    // vendoredDetectionPacks and outboundCredentialAudience are not reported
    await expect(tab(page, "Evidence and detection")).toHaveText("Evidence and detection · 2 unknown");

    // what the label counts is what the card says
    await tab(page, "Isolation").click();
    await expect(page.getByRole("tabpanel")).toContainText("Isolation settings are unmeasured");
    await tab(page, "Discovery").click();
    await expect(page.getByRole("tabpanel")).toContainText("acme-proxy (200 days)");
    await expectAxeClean(page, "Enforcement posture, Discovery tab");
  });

  test("a gateway that does not report its discovery posture reads unknown, not clear", async ({ page }) => {
    await mockApi(page, {
      "GET /v1/org/posture": posture(undefined),
      "GET /v1/org/settings": { settings: { ...ISOLATION, ...BOM } },
      "GET /v1/receipts/keys": { keys: [] },
    });
    await page.goto("/ui/admin/enforcement-posture");
    await expect(tab(page, "Isolation")).toHaveText("Isolation");
    await expect(tab(page, "Discovery")).toHaveText("Discovery · 1 unknown");
    await tab(page, "Discovery").click();
    await expect(page.getByRole("tabpanel")).toContainText("did not report its discovery posture");
  });
});
