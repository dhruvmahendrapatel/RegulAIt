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
  source(4, { name: "Refused demo source", enabled: false, credential: cred("federated", "refused") }),
];
const ref = (s: (typeof sources)[number]) => ({ sourceId: s.id, name: s.name, kind: s.kind });
const posture = {
  sourcesTotal: 4, sourcesEnabled: sources.filter((s) => s.enabled).map(ref), staticCredentials: [ref(sources[0]!)], staleCredentials: [],
  writeScopeUnverified: [ref(sources[1]!)], credentialsRefused: [ref(sources[3]!)], credentialWarningAgeDays: 90, endpointRetentionDays: 90,
  statement: "2 of 3 discovery sources are enabled.",
};

async function mock(route: Route) {
  const p = new URL(route.request().url()).pathname;
  let body: unknown = {};
  if (p === "/auth/me") body = { userId: "u", isAdmin: true, via: "session", user: { id: "u", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
  else if (p === "/v1/me") body = { userId: "u", isAdmin: true, user: { id: "u", email: "ada@example.test", displayName: "Ada Admin" } };
  else if (p === "/v1/shadow-ai/findings") {
    // ADR-0219: the status chips filter on the server (open, confirmed, or closed: every other disposition)
    const status = new URL(route.request().url()).searchParams.get("status");
    const group = (d: string) => (d === "open" ? "open" : d === "confirmed" ? "confirmed" : "closed");
    body = { findings: status ? findings.filter((f) => group(f.disposition) === status) : findings, coverage, posture: "Detection is signal, not proof." };
  }
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
// a contained card is a named scroll region only while it actually scrolls, so cards are found by title
const cardOf = (page: Page, title: string) =>
  page.locator("section[data-rg-card]").filter({ hasText: title }).filter({ has: page.locator("tbody tr") }).first();

async function slotLefts(page: Page, card: string) {
  return cardOf(page, card).locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => {
      const slot = row.querySelector("td:last-child > div > span");
      return slot ? Math.round(slot.getBoundingClientRect().left) : null;
    }).filter((x): x is number => x !== null));
}

test("the sidebar gives Discovery its own section, between Overview and the AI Governance registers (owner decision on #453)", async ({ page }) => {
  await page.addInitScript(() => { try { localStorage.setItem("regulait.rail.pinned", "1"); } catch { /* storage refused: the rail still renders */ } });
  await page.goto("/ui/admin/shadow-ai");
  const nav = page.locator('aside[aria-label="Primary navigation"]');
  await expect(nav.getByRole("link", { name: "Shadow-AI discovery", exact: true })).toHaveAttribute("aria-current", "page");
  const labels = (await nav.locator('[class*="sectionLabel"]').allTextContents()).map((t) => t.trim());
  expect(labels.slice(0, 3)).toEqual(["Overview", "Discovery", "AI Governance"]);
  // both discovery pages sit under the Discovery heading, ahead of the registers
  const order = (await nav.locator('[class*="sectionLabel"], a').allTextContents()).map((t) => t.trim());
  const at = (text: string) => order.indexOf(text);
  expect(at("Discovery")).toBeLessThan(at("Shadow-AI discovery"));
  expect(at("Shadow-AI discovery")).toBeLessThan(at("Discovery sources"));
  expect(at("Discovery sources")).toBeLessThan(at("AI Governance"));
  expect(at("AI Governance")).toBeLessThan(at("Use cases"));
  // the breadcrumb follows the section: "Discovery / …", no longer "AI Governance / …"
  const crumbs = page.locator('nav[aria-label="Breadcrumb"] li > span:not([aria-hidden])');
  await expect(crumbs).toHaveText(["Discovery", "Shadow-AI discovery"]);
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  await expect(crumbs).toHaveText(["Discovery", "Discovery sources"]);
});

test("Shadow AI: tabs, figures with (i), aligned next steps and the coverage tiles", async ({ page }) => {
  // a shorter window, so four findings overflow the box now that Where seen no longer adds a column (#453 F6)
  await page.setViewportSize({ width: 1440, height: 700 });
  await page.goto("/ui/admin/shadow-ai");
  await expect(page.getByRole("heading", { name: "Shadow-AI discovery", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Findings/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("note").filter({ hasText: "What this can see." })).toBeVisible();
  await expect(page.getByRole("button", { name: "What is Critical?" })).toBeVisible();

  // ADR-0219: the inventory pages under the list control, which says where you are (no scroll box)
  const region = cardOf(page, "Inventory");
  await expect(region.getByTestId("list-status")).toHaveText(`1–${findings.length} of ${findings.length}`);
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
  await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
  const panel = page.getByTestId("shadow-remediation");
  await expect(panel.getByRole("list", { name: "Remediation steps" }).getByText("Blocked")).toBeVisible();
  // H1: sign-off has a separate approver; the gateway asks for no fresh MFA check on it, so the panel never claims one
  const whoNext = panel.getByRole("complementary", { name: "Who acts next" });
  await expect(whoNext).toContainText("Separate approver");
  await expect(whoNext).not.toContainText(/MFA/i);
  await whoNext.getByRole("button", { name: "What is the second approver?" }).click();
  await expect(whoNext.getByRole("note")).not.toContainText(/MFA/i);
  await expect(panel.getByRole("textbox", { name: "Change description" })).toHaveValue("Remove ungoverned Acme LLM usage");
  // the confirm dialog still stands between the click and the workflow
  await panel.getByRole("textbox", { name: "Environment" }).fill("production");
  await panel.getByRole("button", { name: "Start remediation workflow…" }).click();
  await expect(page.getByRole("dialog", { name: "Start a remediation workflow?" })).toBeVisible();
});

test("F23: a plan step that carries a long resource path wraps inside the drawer", async ({ page }) => {
  const path = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-branch-faq/providers/Microsoft.CognitiveServices/accounts/branch-faq-bot/deployments/branch-faq-bot";
  await page.route(/\/v1\/shadow-ai\/findings\/[^/]+\/remediation-plan$/, (route) => {
    const body = plan(new URL(route.request().url()).pathname.split("/")[4]!);
    body.steps[1] = { ...body.steps[1]!, why: `point ${path} at the gateway's endpoint` };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto("/ui/admin/shadow-ai");
  await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
  const steps = page.getByTestId("shadow-remediation").getByRole("list", { name: "Remediation steps" });
  await expect(steps).toContainText("branch-faq-bot/deployments");
  const drawer = (await page.getByRole("dialog", { name: "team-17/payments-api" }).boundingBox())!;
  const overflow = await steps.locator("li").evaluateAll((items) => items.map((li) => li.scrollWidth - li.clientWidth));
  expect(overflow.every((d) => d <= 0)).toBe(true);
  for (const li of await steps.locator("li").all()) {
    const b = (await li.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(drawer.x + drawer.width);
  }
});

test("A1: a finding's plan and triage open in the one shared drawer; Escape closes it and focus returns", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai");
  const opener = page.getByRole("button", { name: "Plan remediation for team-17/payments-api" });
  await opener.click();
  const drawer = page.getByRole("dialog", { name: "team-17/payments-api" });
  await expect(drawer).toContainText("Remediation plan");
  await expect(drawer.getByRole("heading", { name: "team-17/payments-api" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(opener).toBeFocused();
  // triage replaces the plan rather than stacking a second drawer
  await opener.click();
  const row = cardOf(page, "Inventory").locator("tbody tr", { hasText: "team-17/payments-api" });
  // N1: the page gives up the drawer's width, so a real click reaches the row beside the open drawer
  await row.getByRole("button", { name: /^(Triage|Review again)\b/ }).click();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toContainText("Triage");
  await page.getByRole("button", { name: "Close triage" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("Discovery sources: how it works, labelled figures, aligned row actions and More", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  await expect(page.getByRole("list", { name: "How discovery works" })).toContainText("2 of 4 sources enabled");
  await expect(page.getByRole("button", { name: "What is Write scope unverified?" }).first()).toBeVisible();
  const lefts = await slotLefts(page, "Sources");
  expect(lefts.length).toBe(sources.length);
  expect(new Set(lefts).size).toBe(1);
  const sourcesRegion = cardOf(page, "Sources");
  // the rarer actions stay one disclosure away; Delete keeps its disabled state and says why
  const row = sourcesRegion.locator("tbody tr", { hasText: "Demo GitLab group" });
  await row.getByText("More", { exact: true }).click();
  await expect(row.getByRole("button", { name: "Delete" })).toBeDisabled();
  await expect(row.getByText("Delete is available once the source is disabled.")).toBeVisible();
  await expect(sourcesRegion.locator("tbody tr", { hasText: "Azure demo subscription" }).getByRole("button", { name: "Enable" })).toBeVisible();
});

test("D3 (#36, #46): the federation card says what turning it on does, in plain words", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  const fed = cardOf(page, "Cloud federation");
  await expect(fed.getByTestId("federation-status")).toContainText("Turning it on lets federated cloud sources run, and asks you to confirm it's you.");
  await expect(fed.getByTestId("federation-no-public-url")).toContainText("as described in the cloud discovery deployment guide");
  await expect(fed).toContainText("each AWS source assumes your role directly with a short-lived token from this issuer");
  await expect(fed).not.toContainText("docs/deployment/");
  await expect(fed).not.toContainText("AssumeRoleWithWebIdentity");
});

test("ADR-0219: the Inventory pages under the list control; its header keeps the worst status", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto("/ui/admin/shadow-ai");
  const card = cardOf(page, "Inventory");
  await expect(card.getByTestId("list-status")).toHaveText(`1–${findings.length} of ${findings.length}`);
  await expect(card.locator("tbody tr")).toHaveCount(findings.length);
  // the header still says how bad, and the status filters sit beside it
  await expect(card).toContainText("1 critical");
  await expect(page.getByRole("group", { name: "Filter by status" })).toBeVisible();
  // a page size is remembered for this list
  await card.getByLabel("Rows per page").selectOption("50");
  await page.reload();
  await expect(cardOf(page, "Inventory").getByLabel("Rows per page")).toHaveValue("50");
});

test("X6b (L2): a status filter asks the server, and the list says how many it shows; the chips count every finding", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai");
  await expect(cardOf(page, "Inventory").locator("tbody tr").first()).toBeVisible();
  const all = await cardOf(page, "Inventory").locator("tbody tr").count();
  const asked = page.waitForRequest((r) => new URL(r.url()).pathname === "/v1/shadow-ai/findings" && new URL(r.url()).searchParams.get("status") === "open");
  await page.getByRole("group", { name: "Filter by status" }).getByRole("button", { name: /^Open/ }).click();
  await asked;
  await expect.poll(() => cardOf(page, "Inventory").locator("tbody tr").count()).toBeLessThan(all);
  const shown = await cardOf(page, "Inventory").locator("tbody tr").count();
  await expect(cardOf(page, "Inventory").getByTestId("list-status")).toHaveText(`1–${shown} of ${shown}`);
  await expect(page.getByRole("group", { name: "Filter by status" }).getByRole("button", { name: /^All/ })).toContainText(String(all));
});

// the KEEP_VISIBLE refusal (a form or warning never folds) is probed in kit-contain.mock.spec.ts
test("X6b: a secondary section starts folded, and the viewer's choice is remembered", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  const runs = page.getByRole("button", { name: /^Recent runs/ });
  await expect(runs).toHaveAttribute("aria-expanded", "false");
  await runs.click();
  await expect(runs).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(page.getByRole("button", { name: /^Recent runs/ })).toHaveAttribute("aria-expanded", "true");
});

// the list control's page size and column picker change only how the list shows: the folding card keeps its fold
test("ADR-0219: Recent runs is a paged list with its own page size, remembered in this browser", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  const fold = page.getByRole("button", { name: /^Recent runs/ });
  await expect(fold).toHaveAttribute("aria-expanded", "false");
  await fold.click();
  await expect(fold).toHaveAttribute("aria-expanded", "true");
  const runs = page.locator('[data-list="discovery-runs"]');
  await expect(runs.getByLabel("Rows per page")).toHaveValue("10");
  await runs.getByLabel("Rows per page").selectOption("100");
  await page.reload();
  await expect(page.locator('[data-list="discovery-runs"]').getByLabel("Rows per page")).toHaveValue("100");
});

/** the plan and triage buttons' offsets inside each row's action stack: one left and one top per button, on every row */
async function actionOffsets(page: Page) {
  return cardOf(page, "Inventory").locator("tbody tr").evaluateAll((rows) =>
    rows.map((row) => {
      // the action stack itself, wherever it sits: on a phone Next step folds into the Subject cell (#453 F6)
      const stack = row.querySelector('[class*="rowActions"]')!;
      const box = stack.getBoundingClientRect();
      const at = (b: Element | undefined) => {
        const r = b!.getBoundingClientRect();
        return `${Math.round(r.left - box.left)},${Math.round(r.top - box.top)}`;
      };
      const buttons = [...stack.querySelectorAll("button")];
      return {
        plan: at(buttons.find((b) => b.getAttribute("aria-label")?.startsWith("Plan remediation for "))),
        triage: at(buttons.find((b) => /^(Triage|Review again)$/.test(b.textContent ?? ""))),
      };
    }));
}

for (const width of [1280, 390]) {
  test(`M2: Plan remediation and Triage sit at one x and one y on every findings row (${width} px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/ui/admin/shadow-ai");
    await expect(page.getByRole("button", { name: /^Plan remediation for / })).toHaveCount(findings.length);
    const at = await actionOffsets(page);
    expect(at.length).toBe(findings.length);
    // closed rows (false positive, remediated) included: an empty primary slot would shift both buttons up
    expect(new Set(at.map((r) => r.plan)).size).toBe(1);
    expect(new Set(at.map((r) => r.triage)).size).toBe(1);
  });
}

test("M1: help text says what the server does", async ({ page }) => {
  const tip = async (name: string) => {
    await page.getByRole("button", { name, exact: true }).first().click();
    const hide = page.getByRole("button", { name: name.replace(/^What is (.+)\?$/, "Hide help for $1"), exact: true }).first();
    const text = await page.locator(`[id="${await hide.getAttribute("aria-controls")}"]`).textContent();
    await hide.click();
    return text ?? "";
  };
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  // an empty include list is refused unless the organisation-level scope is chosen
  expect(await tip("What is Scope: what to scan (one per line) field?")).toContain("To scan everything, choose the organisation-level scope.");
  // the reveal route takes no reason: it is a step-up, and it is audited
  const reveal = await tip("What is Pseudonym field?");
  expect(reveal).toContain("asks you to confirm it's you");
  expect(reveal).not.toContain("reason");
  // retention deletes device findings and pseudonyms; only the audit log survives
  const retention = await tip("What is Endpoint evidence retention (days) field?");
  expect(retention).toContain("Device findings and pseudonyms not seen within this window are deleted. The audit log is kept.");

  await page.goto("/ui/admin/shadow-ai");
  // confidence is the count of distinct corroborating sources (ADR-0055 §6)
  expect(await tip("What is Confidence?")).toContain("High: three or more. Medium: two. Low: one");
  expect(await tip("What is Status?")).toContain("Moving a finding off Open needs a reason.");

  await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
  const panel = page.getByTestId("shadow-remediation");
  expect(await tip("What is a remediation plan?")).toContain("It does not change systems by itself.");
  const env = await tip("What is Environment field?");
  expect(env).toContain("Workflow assignment rules may give some environments extra stages.");
  expect(env).not.toContain("production");
  await expect(panel).not.toContainText("Nothing changes until");
});

test("M3: warnings stay outside the contained scroll boxes, each with a count or an action", async ({ page }) => {
  const outsideCards = (sel: ReturnType<Page["getByTestId"]>) => sel.evaluate((el) => el.closest("section[data-rg-card], [role=region]") === null);

  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  await expect(page.getByText("Credentials refused (write access)")).toBeVisible();
  const warnings = page.getByRole("list", { name: "Sources that need attention" });
  await expect(warnings).toContainText("Refused demo source");
  await expect(warnings).toContainText("credential refused: it grants write access");
  await expect(warnings).toContainText("AWS demo sandbox");
  await expect(warnings).toContainText("write scope unverified");
  expect(await outsideCards(page.getByTestId("source-warnings"))).toBe(true);

  await page.goto("/ui/admin/shadow-ai");
  const seenAgain = page.getByTestId("shadow-seen-again");
  await expect(seenAgain).toContainText("Seen again 1");
  expect(await outsideCards(seenAgain)).toBe(true);
  // the warning carries its action: reviewing opens the disposition form, also outside the box
  await seenAgain.getByRole("button", { name: "Review laptop psn:1a2b3c again" }).click();
  await expect(page.getByRole("region", { name: "Record a disposition for laptop psn:1a2b3c" })).toBeVisible();
});

test("L3: the link buttons and status chips are at least 24 px high", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai");
  for (const b of [page.getByRole("button", { name: "See coverage" }), page.getByRole("button", { name: /^All \d/ })]) {
    expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(24);
  }
});

// ---- #459 review round: the drawer's layers, its modality by width, focus return and the pinned actions ----

const PHONE = { width: 390, height: 700 };
const DESKTOP = { width: 1440, height: 1000 };
const findingRow = (page: Page, subject: string) => page.locator("tbody tr", { hasText: subject });
/** true while focus is inside the open drawer (the one dialog that is not the confirm dialog) */
const focusInDrawer = (page: Page) =>
  page.evaluate(() => {
    const drawer = document.querySelector('[data-testid="shadow-remediation"]');
    return !!drawer && drawer.contains(document.activeElement);
  });

for (const [label, size] of [["390 px", PHONE], ["desktop", DESKTOP]] as const) {
  test(`M1 (${label}): Escape in the confirm dialog closes only that dialog; the drawer and the typed environment stay`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/ui/admin/shadow-ai");
    await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
    const drawer = page.getByTestId("shadow-remediation");
    await drawer.getByRole("textbox", { name: "Environment" }).fill("staging");
    await drawer.getByRole("button", { name: "Start remediation workflow…" }).click();
    const confirm = page.getByRole("dialog", { name: "Start a remediation workflow?" });
    await expect(confirm).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(drawer).toHaveCount(1);
    await expect(drawer.getByRole("textbox", { name: "Environment" })).toHaveValue("staging");
    // the next Escape is the drawer's own
    await drawer.getByRole("heading", { name: "team-17/payments-api" }).focus();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });

  test(`M1 (${label}): Escape on an open (i) tip in the drawer closes only the tip`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/ui/admin/shadow-ai");
    await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
    const drawer = page.getByTestId("shadow-remediation");
    const tipButton = drawer.getByRole("button", { name: "What is a remediation plan?" });
    await tipButton.click();
    await expect(drawer.getByRole("button", { name: "Hide help for a remediation plan" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawer.getByRole("button", { name: "What is a remediation plan?" })).toBeFocused();
    await expect(drawer).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  });
}

test("M2 (390 px): the drawer covers the page, so it is modal: Tab stays inside and the page behind is inert", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/ui/admin/shadow-ai");
  const opener = page.getByRole("button", { name: "Plan remediation for team-17/payments-api" });
  await opener.click();
  const drawer = page.getByTestId("shadow-remediation");
  await expect(drawer).toHaveAttribute("aria-modal", "true");
  expect(await drawer.evaluate((el) => el.matches(":modal"))).toBe(true);
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    expect(await focusInDrawer(page), `Tab ${i + 1} left the drawer`).toBe(true);
  }
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(await focusInDrawer(page), `Shift+Tab ${i + 1} left the drawer`).toBe(true);
  }
  // the page behind cannot take focus, even programmatically, while the drawer is open
  const other = page.getByRole("button", { name: "Plan remediation for team-08/marketing-site", includeHidden: true });
  await other.evaluate((el) => (el as HTMLElement).focus());
  expect(await focusInDrawer(page)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("M2 (desktop): the drawer is a side panel; the list stays reachable and Tab leaves the drawer into the page", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/ui/admin/shadow-ai");
  await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
  const drawer = page.getByTestId("shadow-remediation");
  await expect(drawer).toHaveAttribute("aria-modal", "false");
  expect(await drawer.evaluate((el) => el.matches(":modal"))).toBe(false);
  let left = false;
  for (let i = 0; i < 60 && !left; i++) {
    await page.keyboard.press("Tab");
    left = !(await focusInDrawer(page));
  }
  expect(left).toBe(true);
  // narrowing the window past the overlay width turns the open drawer modal in place
  await page.setViewportSize(PHONE);
  await expect.poll(() => drawer.evaluate((el) => el.matches(":modal"))).toBe(true);
  await expect(drawer).toHaveAttribute("aria-modal", "true");
});

/** null when the focused element is the top hit at its own centre; otherwise what covers it */
const focusCovered = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && el.contains(hit)) return null;
    const name = (n: Element | null) => (n ? `${n.tagName} "${(n.getAttribute("aria-label") ?? n.textContent ?? "").trim().slice(0, 40)}"` : "nothing");
    return `${name(el)} is under ${name(hit)}`;
  });

for (const width of [1440, 1000]) {
  test(`N1 (${width} px): every control Tab reaches beside the side-panel drawer is the top hit at its own centre`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/ui/admin/shadow-ai");
    await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
    const drawer = page.getByTestId("shadow-remediation");
    await expect(drawer).toHaveAttribute("aria-modal", "false");
    let outside = 0;
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      if (await focusInDrawer(page)) continue;
      outside++;
      expect(await focusCovered(page), `Tab ${i + 1}`).toBeNull();
    }
    expect(outside).toBeGreaterThan(20);
    // and back the other way, through the top bar
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Shift+Tab");
      if (!(await focusInDrawer(page))) expect(await focusCovered(page), `Shift+Tab ${i + 1}`).toBeNull();
    }
    // closing hands the width back to the page
    await drawer.getByRole("button", { name: "Close plan" }).click();
    await expect(drawer).toHaveCount(0);
    expect(await page.evaluate(() => getComputedStyle(document.body).paddingInlineEnd)).toBe("0px");
  });
}

// #458 review Low: the overlay width is "900 px and below" (DRAWER_OVERLAY_QUERY); a spec sits on each side of the edge
for (const [width, modal] of [[900, true], [901, false]] as const) {
  test(`A1 edge (${width} px): the drawer is ${modal ? "a modal over the page" : "a side panel beside it"}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/ui/admin/shadow-ai");
    await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
    const drawer = page.getByTestId("shadow-remediation");
    await expect(drawer).toHaveAttribute("aria-modal", String(modal));
    // a side panel takes its width from the page; a modal leaves the page as it is
    const padding = () => page.evaluate(() => getComputedStyle(document.body).paddingInlineEnd);
    if (modal) expect(await padding()).toBe("0px");
    else await expect.poll(padding).not.toBe("0px");
  });
}

for (const [from, to] of [[DESKTOP, PHONE], [PHONE, DESKTOP]] as const) {
  test(`N2 (${from.width} → ${to.width} px): crossing the overlay width with the Start confirm open keeps the confirm on top`, async ({ page }) => {
    await page.setViewportSize(from);
    await page.goto("/ui/admin/shadow-ai");
    await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
    const drawer = page.getByTestId("shadow-remediation");
    const wasModal = await drawer.evaluate((el) => el.matches(":modal"));
    await drawer.getByRole("textbox", { name: "Environment" }).fill("staging");
    await drawer.getByRole("button", { name: "Start remediation workflow…" }).click();
    const confirm = page.getByRole("dialog", { name: "Start a remediation workflow?" });
    await expect(confirm).toBeVisible();
    await page.setViewportSize(to);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    // the drawer is not re-stacked over the confirm: its buttons are the top hits, and focus stays in it
    const buttons = confirm.getByRole("button");
    expect(await buttons.count()).toBeGreaterThan(1);
    for (const button of await buttons.all()) {
      await expect(button).toBeVisible();
      expect(
        await button.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
        }),
      ).toBe(true);
    }
    expect(await confirm.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    expect(await drawer.evaluate((el) => el.matches(":modal"))).toBe(wasModal);
    // the switch happens once the confirm closes; the typed environment survives it
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect.poll(() => drawer.evaluate((el) => el.matches(":modal"))).toBe(!wasModal);
    await expect(drawer.getByRole("textbox", { name: "Environment" })).toHaveValue("staging");
    expect(await focusInDrawer(page)).toBe(true);
  });
}

test("T1 (390 px): with the Start confirm open over the modal drawer, Tab and Shift+Tab cycle inside the confirm", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/ui/admin/shadow-ai");
  await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
  const drawer = page.getByTestId("shadow-remediation");
  await drawer.getByRole("textbox", { name: "Environment" }).fill("staging");
  await drawer.getByRole("button", { name: "Start remediation workflow…" }).click();
  const confirm = page.getByRole("dialog", { name: "Start a remediation workflow?" });
  await expect(confirm).toBeVisible();
  const where = () =>
    confirm.evaluate((el) => {
      const a = document.activeElement as HTMLElement | null;
      return el.contains(a) ? (a?.getAttribute("aria-label") ?? a?.textContent ?? a?.tagName ?? "").trim() : null;
    });
  for (const key of ["Tab", "Shift+Tab"]) {
    const seen = new Set<string>();
    let previous = await where();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(key);
      const now = await where();
      expect(now, `${key} ${i + 1} left the confirm`).not.toBeNull();
      // focus moves on every press: a trap that swallows the key without moving focus also fails
      expect(now, `${key} ${i + 1} did not move focus`).not.toBe(previous);
      seen.add(now!);
      previous = now;
    }
    expect(seen.size).toBeGreaterThan(1);
  }
});

// PR #459 round-2 recheck L1: the spec above passes without the `closest("dialog") !== dialog` guard, because the
// drawer's own trap never sees a confirm control at its edge. Here the drawer's controls after the confirm are hidden
// (a test fixture, display:none), so the confirm's last button is the drawer's last tabbable control too. Without the
// guard the drawer's trap, registered first, takes that Tab and sends focus to the drawer's first control, behind the
// modal confirm, so focus leaves the confirm or does not move.
test("T1 (390 px): Tab from the confirm's last button stays in the confirm when it is also the drawer's last control", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/ui/admin/shadow-ai");
  await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
  const drawer = page.getByTestId("shadow-remediation");
  await drawer.getByRole("textbox", { name: "Environment" }).fill("staging");
  await drawer.getByRole("button", { name: "Start remediation workflow…" }).click();
  const confirm = page.getByRole("dialog", { name: "Start a remediation workflow?" });
  await expect(confirm).toBeVisible();
  const hidden = await page.evaluate(() => {
    const confirmEl = Array.from(document.querySelectorAll("dialog")).find((d) => d.textContent?.includes("Start a remediation workflow?") && d.open && d.querySelector("dialog") === null)!;
    const drawerEl = document.querySelector<HTMLElement>('[data-testid="shadow-remediation"]')!;
    const style = document.createElement("style");
    style.textContent = "[data-t1-hidden] { display: none !important; }";
    document.head.append(style);
    let n = 0;
    for (const el of drawerEl.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]')) {
      if (confirmEl.contains(el)) continue;
      if (confirmEl.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        el.setAttribute("data-t1-hidden", "");
        n++;
      }
    }
    return n;
  });
  // non-vacuous: the drawer had controls after the confirm (its pinned footer), and one before it still shows
  expect(hidden).toBeGreaterThan(0);
  const where = () =>
    confirm.evaluate((el) => {
      const a = document.activeElement as HTMLElement | null;
      return el.contains(a) ? (a?.getAttribute("aria-label") ?? a?.textContent ?? a?.tagName ?? "").trim() : null;
    });
  const buttons = await confirm.getByRole("button").all();
  expect(buttons.length).toBeGreaterThan(1);
  await buttons.at(-1)!.focus();
  for (const key of ["Tab", "Shift+Tab"]) {
    let previous = await where();
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press(key);
      const now = await where();
      expect(now, `${key} ${i + 1} left the confirm`).not.toBeNull();
      expect(now, `${key} ${i + 1} did not move focus`).not.toBe(previous);
      previous = now;
    }
  }
});

// On the drawer path the confirm sits in the drawer body, between the drawer's Close and its pinned footer, so the
// drawer's own trap never sees a confirm control at its edge. This pins the guard for the case where it does: a nested
// dialog holding the outer dialog's last control, with the outer trap registered first, as the drawer's is.
test("T1: kit.tabTrap leaves Tab inside a nested dialog to that dialog's own trap", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai");
  await page.evaluate(async () => {
    const { tabTrap } = await import(/* @vite-ignore */ `${location.origin}/ui/src/ui/kit.tsx`);
    const outer = document.createElement("dialog");
    outer.innerHTML = '<button id="t1-a">A</button><dialog id="t1-inner"><button id="t1-b">B</button><button id="t1-c">C</button></dialog>';
    document.body.append(outer);
    outer.showModal();
    const inner = outer.querySelector<HTMLDialogElement>("#t1-inner")!;
    inner.showModal();
    document.addEventListener("keydown", tabTrap(outer));
    document.addEventListener("keydown", tabTrap(inner));
    outer.querySelector<HTMLElement>("#t1-c")!.focus();
  });
  const focused = () => page.evaluate(() => document.activeElement?.id);
  await page.keyboard.press("Tab");
  expect(await focused()).toBe("t1-b");
  await page.keyboard.press("Shift+Tab");
  expect(await focused()).toBe("t1-c");
});

test("L1: after the drawer switches subject, focus returns to the control that opened the current one", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/ui/admin/shadow-ai");
  await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
  // same drawer type, another row: the drawer stays mounted and re-captures its opener
  const otherPlan = page.getByRole("button", { name: "Plan remediation for team-08/marketing-site" });
  await otherPlan.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "team-08/marketing-site" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "team-08/marketing-site" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(otherPlan).toBeFocused();

  // another drawer type: the plan drawer unmounts, and focus still ends on the triage opener
  await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
  const triage = findingRow(page, "team-08/marketing-site").getByRole("button", { name: /^(Triage|Review again)\b/ });
  await triage.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toContainText("Triage");
  await page.getByRole("button", { name: "Close triage" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(triage).toBeFocused();
});

for (const [label, size] of [["390 px", { width: 390, height: 520 }], ["desktop", { width: 1440, height: 520 }]] as const) {
  test(`L2 (${label}): the decision and step-up actions sit in a pinned footer, never inside the scrolling body`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto("/ui/admin/shadow-ai");
    /** the action is in view, and no scroll box inside the drawer holds it */
    const pinned = (name: string) =>
      page.getByRole("dialog").getByRole("button", { name, exact: true }).evaluate((btn) => {
        const r = btn.getBoundingClientRect();
        const drawer = btn.closest("dialog")!;
        for (let el = btn.parentElement; el && el !== drawer; el = el.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return "inside a scroll box";
        }
        return r.top >= 0 && r.bottom <= window.innerHeight ? "pinned" : "out of view";
      });
    await page.getByRole("button", { name: "Plan remediation for team-17/payments-api" }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Start remediation workflow…" })).toBeVisible();
    expect(await pinned("Start remediation workflow…")).toBe("pinned");
    expect(await pinned("Link workflow…")).toBe("pinned");
    // the pinned submit still belongs to its form: the required Environment is checked before any confirm
    await page.getByRole("dialog").getByRole("button", { name: "Start remediation workflow…" }).click();
    await expect(page.getByRole("dialog", { name: "Start a remediation workflow?" })).toHaveCount(0);
    await page.getByRole("button", { name: "Close plan" }).click();

    await findingRow(page, "team-17/payments-api").getByRole("button", { name: /^(Triage|Review again)\b/ }).click();
    await expect(page.getByRole("dialog")).toContainText("Triage");
    expect(await pinned("Record")).toBe("pinned");
    expect(await pinned("Cancel")).toBe("pinned");
  });
}

test("L5: the list control still works when this browser refuses storage, and nothing is remembered", async ({ page }) => {
  await page.addInitScript(() => {
    const refuse = () => { throw new DOMException("storage refused", "SecurityError"); };
    Storage.prototype.getItem = refuse;
    Storage.prototype.setItem = refuse;
    Storage.prototype.removeItem = refuse;
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto("/ui/admin/shadow-ai");
  const size = cardOf(page, "Inventory").getByLabel("Rows per page");
  await expect(size).toHaveValue("10");
  await size.selectOption("50");
  await expect(size).toHaveValue("50");
  await page.reload();
  await expect(cardOf(page, "Inventory").getByLabel("Rows per page")).toHaveValue("10");
  expect(errors).toEqual([]);
});

// ---- design batch D1 (#547): the S1-S3 demo path, verified on main before the fix ----

test("shadow-ai-13: triage opens on Confirmed, and Record waits for the reason the gateway requires", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai");
  await findingRow(page, "team-17/payments-api").getByRole("button", { name: /^(Triage|Review again)\b/ }).click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.getByRole("combobox", { name: "Disposition" })).toHaveValue("confirmed");
  const record = drawer.getByRole("button", { name: "Record", exact: true });
  await expect(record).toBeDisabled();
  const reason = drawer.getByRole("textbox", { name: "Reason" });
  await reason.fill("docs mention only");
  await expect(record).toBeEnabled();
  // reopening as "open" needs no reason, as the gateway allows
  await reason.fill("");
  await drawer.getByRole("combobox", { name: "Disposition" }).selectOption("open");
  await expect(record).toBeEnabled();
  // a later drawer never inherits an earlier choice: Sanctioned, Cancel, then another row opens on Confirmed again
  await drawer.getByRole("combobox", { name: "Disposition" }).selectOption("sanctioned");
  await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
  await findingRow(page, "team-22").getByRole("button", { name: /^(Triage|Review again)\b/ }).click();
  await expect(page.getByRole("dialog").getByRole("combobox", { name: "Disposition" })).toHaveValue("confirmed");
  // the "Seen again after closing" callout opens the same drawer and resets it too
  await page.getByRole("dialog").getByRole("combobox", { name: "Disposition" }).selectOption("sanctioned");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByTestId("shadow-seen-again").getByRole("button", { name: "Review laptop psn:1a2b3c again" }).click();
  await expect(page.getByRole("dialog").getByRole("combobox", { name: "Disposition" })).toHaveValue("confirmed");
});

test("shadow-ai-17: each row's Triage and Register as use case name their finding", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai");
  const row = findingRow(page, "team-17/payments-api");
  await expect(row.getByRole("button", { name: /^(Triage|Review again:?) team-17\/payments-api$/ })).toBeVisible();
  await expect(row.getByRole("link", { name: "Register as use case: team-17/payments-api" })).toHaveCount(1);
});

test("shadow-ai-05: a psn: link lands on the prefilled Pseudonym field, in view and focused", async ({ page }) => {
  await page.goto(`/ui/admin/shadow-ai/discovery-sources?pseudonym=${encodeURIComponent(PSN)}`);
  const field = page.getByRole("textbox", { name: "Pseudonym" });
  await expect(field).toHaveValue(PSN);
  await expect(field).toBeFocused();
  await expect(field).toBeInViewport();
  // still a deliberate act: nothing was revealed on arrival
  await expect(page.getByTestId("revealed-pseudonym")).toHaveCount(0);
});

test("FS-6: the posture paragraph's link is underlined, not told apart by colour alone", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  // the posture paragraph sits behind the Active discovery (i)
  await page.getByRole("button", { name: "What is Active discovery?" }).click();
  const link = page.getByRole("note").getByRole("link", { name: "Shadow-AI discovery", exact: true }).and(page.locator("p a"));
  await expect(link).toHaveCSS("text-decoration-line", "underline");
});

test("shadow-ai-01: the federation card shows a failed read as an error with Retry, never as off", async ({ page }) => {
  await page.route("**/v1/discovery/federation", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  const fed = page.locator("section[data-rg-card]").filter({ hasText: "Cloud federation" }).first();
  await expect(fed.getByRole("alert")).toBeVisible();
  await expect(fed.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(fed.getByTestId("federation-status")).toHaveCount(0);
  await expect(fed).not.toContainText("No federation key yet");
});

test("shadow-ai-02/03: failed runs, token and device reads show errors with Retry, not empty states", async ({ page }) => {
  const fail = (route: Route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) });
  await page.route("**/v1/discovery/runs?*", fail);
  // ADR-0219: both lists ask with the contract's query string
  await page.route(/\/enrolment-tokens(\?.*)?$/, fail);
  await page.route(/\/endpoint-devices(\?.*)?$/, fail);
  await page.route("**/v1/discovery/sources", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sources: [...sources, source(5, { name: "Fleet agent", kind: "endpoint_agent", credential: null })], posture }) }));
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  await expect(page.getByRole("list", { name: "How discovery works" })).toContainText("Scan on a schedule—");
  await expect(page.getByText("No scan has run")).toHaveCount(0);
  await expect(page.getByText("No enrolment token")).toHaveCount(0);
  await expect(page.getByText("No device has enrolled")).toHaveCount(0);
  await expect(page.getByText("Couldn't load this list")).toHaveCount(3);
});

test("E1 (S2): a failed findings read shows the figures as unknown, never an all-clear 0", async ({ page }) => {
  await page.route("**/v1/shadow-ai/findings*", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable" }) }));
  await page.goto("/ui/admin/shadow-ai");
  await expect(page.getByRole("tab", { name: "Findings", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Findings · 0/ })).toHaveCount(0);
  await expect(page.getByText("Coverage could not be read.")).toBeVisible();
  for (const label of ["Critical", "High", "Medium or low", "Evidence classes supplied"]) {
    const stat = page.locator("div").filter({ has: page.getByText(label, { exact: true }) }).filter({ hasText: "—" }).first();
    await expect(stat, label).toBeVisible();
  }
});

test("shadow-ai-14: the link-a-workflow options read the workflow status in words", async ({ page }) => {
  await page.route("**/v1/workflows/instances", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ instances: [{
      id: "11111111-2222-4333-8444-555555555555", status: "blocked_on_approval", createdAt: ago(5), initiatorUserId: "u",
      change: { description: `Remove ungoverned Acme LLM usage — shadow-AI finding ${F(1)}`, paths: [], changeType: "shadow-ai-remediation", environment: "staging" },
    }] }) }));
  await page.goto("/ui/admin/shadow-ai");
  await page.getByRole("button", { name: `Plan remediation for ${findings[0]!.subject}` }).click();
  const select = page.getByRole("dialog").getByLabel("Or link an existing workflow");
  const options = (await select.locator("option").allTextContents()).join("\n");
  expect(options).not.toContain("blocked_on_approval");
  expect(options).toContain("Blocked on approval");
});

test("shadow-ai-16: the signatures table folds to fit its card, names its actions column and says when a confidence is missing", async ({ page }) => {
  const sig = (n: number, over: Record<string, unknown>) => ({
    id: `5160000${n}-0000-4000-8000-000000000000`, provider: "acme-model-services", kind: "sdk_package", value: `acme-llm-sdk-${n}`, matchType: "host_suffix",
    minLength: null, replacementAgentId: null, replacementNote: null, provenance: "seed", enabled: true, lastUpdatedAt: ago(30),
    os: "macos", ecosystem: "npm", toolId: "local-runtime", note: "Default listener port", ...over,
  });
  await page.route("**/v1/shadow-ai/catalogue", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      signatures: [sig(1, { confidence: "medium" }), sig(2, { provenance: "admin" })], total: 2, enabled: 2, oldestEntryAt: null, posture: "No collector ships.",
    }) }));
  await page.goto("/ui/admin/shadow-ai?tab=catalogue");
  const card = page.locator("section[data-rg-card]").filter({ hasText: "Signatures" }).filter({ has: page.locator("tbody tr") }).first();
  await expect(card.locator("thead th").last()).toHaveText("Actions");
  // at 1440 px paired values share a cell, so no value is squeezed to one word per line
  await expect(card.locator("thead th")).toHaveText(["Provider", "Kind / match", "Value", "Scope / tool", "Confidence", "Provenance", "Enabled", "Actions"]);
  const first = card.locator("tbody tr").first();
  // each cell's first line of text (its value) stays on one line
  const wrapped = await first.evaluate((tr) => [...tr.querySelectorAll("td")].flatMap((td) => {
    const text = [...td.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()) ?? td.querySelector("code, span");
    if (!text) return [];
    const range = document.createRange();
    range.selectNodeContents(text);
    return new Set([...range.getClientRects()].map((r) => Math.round(r.top))).size > 1 ? [td.textContent] : [];
  }));
  expect(wrapped).toEqual([]);
  await expect(first).toContainText("macOS");
  await expect(first).toContainText("Seed");
  await expect(card.locator("tbody tr").nth(1)).toContainText("Admin");
  await expect(card.locator("tbody tr").nth(1).getByRole("cell").filter({ hasText: /^—$/ })).toHaveCount(1);
  await expect(first).not.toContainText("high");
  await expect(card.getByRole("button", { name: "Remove signature acme-llm-sdk-1" })).toBeVisible();
});

test("shadow-ai-10: import history reads its mode and status in words, with an absolute date", async ({ page }) => {
  await page.route((u) => u.pathname === "/v1/shadow-ai/imports", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ imports: [
      { id: "1", kind: "egress_log", mode: "dry_run", status: "accepted", rowCount: 1240, reason: "parsed", createdAt: ago(96) },
    ] }) }));
  await page.goto("/ui/admin/shadow-ai?tab=history");
  const row = page.locator("tbody tr").first();
  await expect(row).toContainText("Dry run");
  await expect(row).not.toContainText("dry_run");
  await expect(row).toContainText("Accepted");
  await expect(row).toContainText("1,240");
  await expect(row).toContainText(/\d{1,2} \w{3} 2026, \d{2}:\d{2}/);
});
