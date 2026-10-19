import { expect, test, type Page, type Route } from "@playwright/test";

// Governed - Designer batch 2 (owner-approved one item at a time on #453, 2026-10-19):
// S1 Discovery sources, SH1-SH3 Shadow AI findings, SH4-SH5 remediation, A2 tabs,
// X6a contained sections and the X7 row-action alignment rule.

const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const F = (n: number) => `f0000000-0000-4000-8000-00000000000${n}`;
const S = (n: number) => `50000000-0000-4000-8000-00000000000${n}`;
const PSN = "psn:3f9a1c0d2b4e6f8a7c5d1e2f";

const finding = (n: number, over: Record<string, unknown>) => ({
  id: F(n), subjectKind: "repository", subject: `team-${n}/app`, provider: "Acme LLM", signalSources: ["code_scan"], severity: "high",
  confidence: "high", disposition: "open", observationCount: 3, firstSeenAt: ago(48), lastSeenAt: ago(3), replacementAgent: null,
  replacementNote: null, dispositionStale: false, evidence: [], ...over,
});
const findings = [
  finding(1, { subject: "team-17/payments-api", severity: "critical", evidence: [
    { source: "repo_gitlab", observedAt: ago(3), location: { path: "src/billing/summarise.ts", line: 42, commit: "9f3c2a1be4d5c6a7" }, names: ["acme-llm-sdk"], actor: PSN },
    { source: "repo_gitlab", location: { path: ".env.example", line: 7 }, presence: ["acme-key-prefix"], actor: PSN },
  ] }),
  finding(2, { subject: "team-08/marketing-site", severity: "low", confidence: "low", disposition: "false_positive" }),
  finding(3, { subject: "team-22", severity: "medium", disposition: "confirmed", signalSources: ["saas_export"] }),
  finding(4, { subject: "laptop psn:1a2b3c", severity: "medium", disposition: "remediated", dispositionStale: true }),
];
const coverage = {
  sources: [
    { kind: "egress_log", on: true, imports: 4, rows: 1840, whatItSees: "Calls that leave through the proxy.", whatItMisses: "Traffic that bypasses the proxy." },
    { kind: "self_reported", on: false, imports: 0, rows: 0, whatItSees: "What people tell you they use.", whatItMisses: "Everything nobody reports." },
  ],
  sourcesOn: 1, sourcesPossible: 4, statement: "Coverage reflects only the evidence you supplied.",
};
const plan = (id: string) => ({
  findingId: id, subject: "team-17/payments-api", provider: "Acme LLM", severity: "critical", replacementAgent: null,
  steps: [
    { step: "confirm the finding", why: "a remediation starts from a confirmed lead" },
    { step: "register a governed replacement", why: "the usage needs somewhere governed to go", blocked: "No governed agent is registered as this provider's replacement." },
  ],
  workflowRequest: { route: "/v1/workflows/instances", body: { change: { description: `Remove ungoverned Acme LLM usage — shadow-AI finding ${id}`, paths: ["src/billing/summarise.ts"], changeType: "shadow-ai-remediation", environment: "unstated" } }, needsInput: ["environment"] },
  assignment: { changeType: "shadow-ai-remediation", ruleConfigured: true },
  pendingLink: null, currentLink: null, note: "Starting a workflow does not change the finding until it is linked.",
});

const scanners = { kinds: [
  { kind: "repo_gitlab", label: "GitLab group (repositories)", family: "repo", slice: "SD1", evidenceKinds: ["code_scan"], subjectKinds: ["repository"], built: true, requiresCredential: true },
  { kind: "cloud_aws", label: "AWS account", family: "cloud", slice: "SD2", evidenceKinds: ["saas_export"], subjectKinds: ["cloud_account"], built: true, requiresCredential: true },
] };
const cred = (mode: "federated" | "static", writeScope: string) => ({ id: `c-${mode}`, mode, publicConfig: {}, hasSecret: mode === "static", writeScope, createdAt: ago(48), ageDays: 2, ageWarning: false });
const source = (n: number, over: Record<string, unknown>) => ({
  id: S(n), name: `Source ${n}`, kind: "repo_gitlab", target: { group: "acme-demo" }, scope: { orgLevel: true, include: [] }, enabled: true,
  scheduleIntervalSeconds: 86400, version: 1, nextRunAt: null, lastRunAt: ago(2), scannerBuilt: true, credential: cred("static", "read_only"), lastRun: null, ...over,
});
const sources = [
  source(1, { name: "Demo GitLab group" }),
  source(2, { name: "AWS demo sandbox", kind: "cloud_aws", credential: cred("federated", "unverified") }),
  source(3, { name: "Azure demo subscription", kind: "cloud_aws", enabled: false }),
];
const ref = (s: (typeof sources)[number]) => ({ sourceId: s.id, name: s.name, kind: s.kind });
const posture = {
  sourcesTotal: 3, sourcesEnabled: sources.filter((s) => s.enabled).map(ref), staticCredentials: [ref(sources[0]!)], staleCredentials: [],
  writeScopeUnverified: [ref(sources[1]!)], credentialsRefused: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90,
  statement: "2 of 3 discovery sources are enabled.",
};

async function mock(route: Route) {
  const p = new URL(route.request().url()).pathname;
  let body: unknown = {};
  if (p === "/auth/me") body = { userId: "u", isAdmin: true, via: "session", user: { id: "u", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
  else if (p === "/v1/me") body = { userId: "u", isAdmin: true, user: { id: "u", email: "ada@example.test", displayName: "Ada Admin" } };
  else if (p === "/v1/shadow-ai/findings") body = { findings, coverage, posture: "Detection is signal, not proof." };
  else if (p === "/v1/shadow-ai/catalogue") body = { signatures: [], total: 0, enabled: 0, oldestEntryAt: null, posture: "No collector ships." };
  else if (p === "/v1/shadow-ai/imports") body = { imports: [] };
  else if (p === "/v1/shadow-ai/adapters") body = { adapters: [], posture: "Operator supplied evidence only.", pipeline: "No raw content retained." };
  else if (p === "/v1/shadow-ai/discovery/catalog") body = { catalogVersion: 1, total: 0, endpoints: 0, sdks: 0, entries: [], governedHosts: [], posture: "Catalogue classification only.", limits: "No scan is performed." };
  else if (/^\/v1\/shadow-ai\/findings\/[^/]+\/remediation-plan$/.test(p)) body = plan(p.split("/")[4]!);
  else if (p === "/v1/workflows/instances") body = { instances: [] };
  else if (p === "/v1/projects") body = { projects: [] };
  else if (p === "/v1/discovery/scanners") body = scanners;
  else if (p === "/v1/discovery/sources") body = { sources, posture };
  else if (p === "/v1/discovery/runs") body = { runs: [] };
  else if (p === "/v1/discovery/settings") body = { credentialWarningAgeDays: 90, endpointRetentionDays: 90, version: 1 };
  else if (p === "/v1/discovery/federation") body = { enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 900, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" }, subjectFormat: "", audiences: {} };
  else if (/enrolment-tokens$/.test(p)) body = { tokens: [] };
  else if (/endpoint-devices$/.test(p)) body = { devices: [], summary: { devices: 0, revoked: 0, softwareKeys: 0 } };
  else if (p === "/v1/discovery/endpoint-signatures") body = { signatures: [] };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    return route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth")) ? route.continue() : mock(route);
  });
});

/** every row's first action slot starts at one x (X7): read from the rendered slot, not a fixed list */
async function slotLefts(page: Page, card: string) {
  return page.getByRole("region", { name: `${card}, scrollable` }).locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => {
      const slot = row.querySelector("td:last-child > div > span");
      return slot ? Math.round(slot.getBoundingClientRect().left) : null;
    }).filter((x): x is number => x !== null));
}

test("Shadow AI: tabs, figures with (i), aligned next steps and the coverage tiles", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai");
  await expect(page.getByRole("heading", { name: "Shadow-AI discovery", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Findings/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("note").filter({ hasText: "What this can see." })).toBeVisible();
  await expect(page.getByRole("button", { name: "What is Critical?" })).toBeVisible();

  // X6a: the findings list is a named, focusable scroll region
  const region = page.getByRole("region", { name: "Inventory, scrollable" });
  await expect(region).toHaveAttribute("tabindex", "0");
  // X7: every row's primary slot starts at the same x
  const lefts = await slotLefts(page, "Inventory");
  expect(lefts.length).toBe(findings.length);
  expect(new Set(lefts).size).toBe(1);

  // codes read as words, and the stale disposition offers a review
  await expect(region.getByText("False positive", { exact: true })).toBeVisible();
  await expect(region.getByRole("button", { name: "Review again" })).toBeVisible();

  // status filter
  await page.getByRole("button", { name: /^Closed \d/ }).click();
  await expect(region.locator("tbody tr")).toHaveCount(2);
  await page.getByRole("button", { name: /^All \d/ }).click();

  // sightings fold behind a count, a native disclosure
  await region.getByText("2 places").click();
  await expect(region.getByText(/summarise\.ts/)).toBeVisible();

  // A2: a tab is a URL, so a link can open it
  await page.getByRole("tab", { name: "Coverage" }).click();
  await expect(page).toHaveURL(/tab=coverage/);
  await expect(page.getByRole("list", { name: "Coverage by evidence class" }).getByText("Missing")).toBeVisible();
  await page.goto("/ui/admin/shadow-ai?tab=import");
  await expect(page.getByRole("tab", { name: "Import evidence" })).toHaveAttribute("aria-selected", "true");
});

test("Shadow AI remediation: the plan opens as steps, named approver rules, no raw id in the description", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai");
  await page.getByRole("button", { name: "Remediation plan for team-17/payments-api" }).click();
  const panel = page.getByTestId("shadow-remediation");
  await expect(panel.getByRole("list", { name: "Remediation steps" }).getByText("Blocked")).toBeVisible();
  await expect(panel.getByRole("complementary", { name: "Who acts next" })).toContainText("Fresh MFA check");
  await expect(panel.getByRole("textbox", { name: "Change description" })).toHaveValue("Remove ungoverned Acme LLM usage");
  // the confirm dialog still stands between the click and the workflow
  await panel.getByRole("textbox", { name: "Environment" }).fill("production");
  await panel.getByRole("button", { name: "Start remediation workflow…" }).click();
  await expect(page.getByRole("dialog", { name: "Start a remediation workflow?" })).toBeVisible();
});

test("A1: a finding's plan and triage open in the one shared drawer; Escape closes it and focus returns", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai");
  const opener = page.getByRole("button", { name: "Remediation plan for team-17/payments-api" });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: "team-17/payments-api" });
  await expect(drawer).toContainText("Remediation plan");
  await expect(drawer.getByRole("heading", { name: "team-17/payments-api" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(opener).toBeFocused();
  // triage replaces the plan rather than stacking a second drawer
  await opener.click();
  const row = page.getByRole("region", { name: /Inventory, scrollable/ }).locator("tbody tr", { hasText: "team-17/payments-api" });
  // the drawer covers the row, so the click is dispatched to the button itself
  await row.getByRole("button", { name: /^(Triage|Review again)$/ }).dispatchEvent("click");
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toContainText("Triage");
  await page.getByRole("button", { name: "Close triage" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Discovery sources: how it works, labelled figures, aligned row actions and More", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  await expect(page.getByRole("list", { name: "How discovery works" })).toContainText("2 of 3 sources enabled");
  await expect(page.getByRole("button", { name: "What is Write scope unverified?" }).first()).toBeVisible();
  const lefts = await slotLefts(page, "Sources");
  expect(lefts.length).toBe(sources.length);
  expect(new Set(lefts).size).toBe(1);
  const sourcesRegion = page.getByRole("region", { name: "Sources, scrollable" });
  // the rarer actions stay one disclosure away; Delete keeps its disabled state and says why
  const row = sourcesRegion.locator("tbody tr", { hasText: "Demo GitLab group" });
  await row.getByText("More", { exact: true }).click();
  await expect(row.getByRole("button", { name: "Delete" })).toBeDisabled();
  await expect(row.getByText("Delete is available once the source is disabled.")).toBeVisible();
  await expect(sourcesRegion.locator("tbody tr", { hasText: "Azure demo subscription" }).getByRole("button", { name: "Enable" })).toBeVisible();
});

test("X6b: Show all lets a contained section flow at full length, remembered for that section", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto("/ui/admin/shadow-ai");
  const inventory = page.locator("section[data-rg-card]").filter({ has: page.getByRole("region", { name: "Inventory, scrollable" }) });
  const showAll = inventory.getByRole("button", { name: "Show all" });
  await expect(showAll).toHaveAttribute("aria-pressed", "false");
  await showAll.click();
  await expect(page.getByRole("region", { name: "Inventory, scrollable" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Show all" }).first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("region", { name: "Inventory, scrollable" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show all" }).first().click();
  await expect(page.getByRole("region", { name: "Inventory, scrollable" })).toBeVisible();
});
