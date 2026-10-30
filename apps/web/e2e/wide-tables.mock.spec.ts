import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// F6/F20/F21/F25 (owner-approved mockup on #453, 2026-10-21): the four wide tables fit their cards at 1440, 1024 and
// 390 px, and with the drawer open. A narrow table folds columns into another column's cell (kit Column.fold) as
// labelled lines; the Inventory caption sits outside the scroll box (Card.caption). Values move, never disappear.

const NOW = Date.now();
const ago = (h: number) => new Date(NOW - h * 3600_000).toISOString();
const id = (p: string, n: number) => `${p}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PSN = "psn:3f9a1c0d2b4e6f8a7c5d1e2f";
const USE_CASE = id("c", 1);

const finding = (n: number, over: Record<string, unknown>) => ({
  id: id("f", n), subjectKind: "repository", subject: `team-${n}/app`, provider: "acme-llm", signalSources: ["saas_export"], severity: "high",
  confidence: "low", disposition: "open", observationCount: n, firstSeenAt: ago(48), lastSeenAt: ago(1), replacementAgent: null,
  replacementNote: null, dispositionStale: false, evidence: [], ...over,
});
const findings = [
  finding(1, { subject: "Credit Team LLM Prototype" }),
  finding(2, { subject: "gitlab:acme-bank-demo/support-ticket-triage", provider: "northwind-ai", signalSources: ["code_scan"], evidence: [
    { source: "repo_gitlab", observedAt: ago(3), location: { path: "src/triage/summarise.ts", line: 42, commit: "9f3c2a1be4d5c6a7" }, names: ["northwind-sdk"], actor: PSN },
    { source: "repo_gitlab", location: { path: ".env.example", line: 7 }, presence: ["northwind-key-prefix"], actor: PSN },
    { source: "repo_gitlab", location: { path: "package.json", line: 18 }, names: ["northwind-sdk"] },
  ] }),
  finding(3, { subject: "azure:/subscriptions/demo/resourceGroups/branch-faq-bot", provider: "contoso-ai", severity: "medium", confidence: "high" }),
  finding(4, { subject: "laptop psn:1a2b3c", severity: "medium", disposition: "remediated", dispositionStale: true, signalSources: ["self_reported", "egress_log"] }),
];
const coverage = { sources: [], sourcesOn: 1, sourcesPossible: 4, statement: "Coverage reflects only the evidence you supplied." };
const plan = (fid: string) => ({
  findingId: fid, subject: findings[1]!.subject, provider: "northwind-ai", severity: "high", replacementAgent: null,
  steps: [{ step: "register the endpoint in the model catalogue", why: "a governed entry is what makes the traffic routable" }],
  workflowRequest: { route: "/v1/workflows/instances", body: { change: { description: "Remove ungoverned usage", paths: [], changeType: "shadow-ai-remediation", environment: "unstated" } }, needsInput: ["environment"] },
  assignment: { changeType: "shadow-ai-remediation", ruleConfigured: true }, pendingLink: null, currentLink: null,
  note: "Starting a workflow does not change the finding until it is linked.",
});

const SOURCE_NAMES = ["Acme Bank laptops (endpoint agent) (demo dataset)", "Acme Bank MDM inventory (demo dataset)", "Acme Bank Azure (demo dataset)", "Acme Bank AWS sandbox (demo dataset)"];
const sources = SOURCE_NAMES.map((name, i) => ({
  id: id("5", i + 1), name, kind: "repo_gitlab", target: {}, scope: { orgLevel: true, include: [] }, enabled: true, scheduleIntervalSeconds: 86400,
  version: 1, nextRunAt: null, lastRunAt: ago(2), scannerBuilt: true, credential: null, lastRun: null,
}));
const runs = sources.map((s, i) => ({
  id: id("r", i + 1), sourceId: s.id, kind: s.kind, trigger: "manual", status: i === 3 ? "failed" : "succeeded", attempt: 1, startedAt: ago(1),
  finishedAt: ago(1), observed: i + 1, matched: i + 1, findingsCreated: i + 1, findingsUpdated: 0, rawOutputSha256: null,
  errorCode: i === 3 ? "credential_refused" : null, errorDetail: null, createdAt: ago(1),
  catalogueGaps: i === 0 ? [{ kind: "desktop_app", value: "cli.acme-llm.assistant" }, { kind: "ide_extension", value: "fabrikam.code-helper" }] : [],
  readOutcomes: i === 2 ? [{ read: "role_assignments", status: "forbidden", detail: "the reader role was not granted" }] : [],
}));
const posture = { sourcesTotal: 4, sourcesEnabled: [], staticCredentials: [], staleCredentials: [], writeScopeUnverified: [], credentialsRefused: [], credentialWarningAgeDays: 90, endpointRetentionDays: 90, statement: "4 of 4 discovery sources are enabled." };

const USERS = [{ id: "u", email: "ada@example.test", displayName: "Ada Admin" }, { id: "m", email: "morgan@example.test", displayName: "Morgan Reyes" }];
const LONG = "AI policy demo-acceptable-use v1 acknowledged by the user themselves, signed in with a password and a one-time code from the registered authenticator.";
const entries = [
  { ruleId: "login_succeeded", objectType: "user", effect: "allow", deployMode: null, reason: "user 'avery@example.test' signed in with a password (by email)" },
  { ruleId: "workflow:approval_granted", objectType: "workflow", effect: "allow", deployMode: null, reason: "workflow instance event 'approval_granted' (status → completed)" },
  { ruleId: "ai_policy_acknowledged", objectType: "ai_policy_acknowledgement", effect: "allow", deployMode: null, reason: LONG },
  { ruleId: "workflow_deploy", objectType: "workflow", effect: "require_approval", deployMode: "byoc", reason: "deploy to staging held for a separate approver" },
  { ruleId: "use_case_registered", objectType: "ai_use_case", effect: "allow", deployMode: null, reason: "AI use case 'Credit memo assistant' registered from shadow-AI finding" },
  { ruleId: "decision_receipt", objectType: "agent_call", effect: "deny", deployMode: null, reason: "the tool is not on the caller's allow-list" },
].map((e, i) => ({ id: id("a", i + 1), at: new Date(NOW - i * 60_000).toISOString(), userId: i % 2 ? "m" : "u", ...e }));

async function mock(route: Route) {
  const url = new URL(route.request().url());
  const p = url.pathname;
  let body: unknown = {};
  if (p === "/auth/me") body = { userId: "u", isAdmin: true, via: "session", user: USERS[0], mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false };
  else if (p === "/v1/me") body = { userId: "u", isAdmin: true, user: USERS[0] };
  else if (p === "/v1/shadow-ai/findings") body = { findings, coverage, posture: "Detection is signal, not proof." };
  else if (p === "/v1/shadow-ai/catalogue") body = { signatures: [], total: 0, enabled: 0, oldestEntryAt: null, posture: "" };
  else if (p === "/v1/shadow-ai/imports") body = { imports: [] };
  else if (p === "/v1/shadow-ai/adapters") body = { adapters: [], posture: "", pipeline: "" };
  else if (p === "/v1/shadow-ai/discovery/catalog") body = { catalogVersion: 1, total: 0, endpoints: 0, sdks: 0, entries: [], governedHosts: [], posture: "", limits: "" };
  else if (/^\/v1\/shadow-ai\/findings\/[^/]+\/remediation-plan$/.test(p)) body = plan(p.split("/")[4]!);
  else if (p === "/v1/workflows/instances") body = { instances: [] };
  else if (p === "/v1/projects") body = { projects: [] };
  else if (p === "/v1/discovery/scanners") body = { kinds: [{ kind: "repo_gitlab", label: "GitLab group (repositories)", family: "repo", slice: "SD1", evidenceKinds: ["code_scan"], subjectKinds: ["repository"], built: true, requiresCredential: false }] };
  else if (p === "/v1/discovery/sources") body = { sources, posture };
  else if (p === "/v1/discovery/runs") body = { runs };
  else if (p === "/v1/discovery/settings") body = { credentialWarningAgeDays: 90, endpointRetentionDays: 90, version: 1 };
  else if (p === "/v1/discovery/federation") body = { enabled: false, issuer: null, jwksUri: null, tokenTtlSeconds: 900, keys: [], awsPrincipal: { configured: false, roleArn: null, subject: "" }, subjectFormat: "", audiences: {} };
  else if (/enrolment-tokens$/.test(p)) body = { tokens: [] };
  else if (/endpoint-devices$/.test(p)) body = { devices: [], summary: { devices: 0, revoked: 0, softwareKeys: 0 } };
  else if (p === "/v1/discovery/endpoint-signatures") body = { signatures: [] };
  else if (p === "/v1/audit") body = { entries: url.searchParams.get("objectId") ? entries.filter((e) => e.objectType === "ai_use_case").concat(entries) : entries, pageSize: 100, hasMore: true, nextCursor: "c" };
  else if (p === "/v1/audit/retention") body = { retainedDays: null, prunable: 0, floorSource: [] };
  else if (p === "/v1/users") body = { users: USERS };
  await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    return route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth")) ? route.continue() : mock(route);
  });
});

// a foldable card's title is inside its fold button, with its count ("Inventory 4 findings"); a plain card's is text
const cardOf = (page: Page, title: string) =>
  page
    .locator("section[data-rg-card]")
    .filter({ has: page.locator("button[aria-expanded][aria-controls]", { hasText: new RegExp(`^${title}`) }).or(page.getByText(title, { exact: true })) })
    .filter({ has: page.locator("tbody tr") })
    .first();

/** the card, opened if it starts collapsed (X6b: Recent runs does), so its table has a width to fold on */
async function openCard(page: Page, title: string): Promise<Locator> {
  const card = cardOf(page, title);
  await card.waitFor();
  const fold = card.locator(":scope > div").first().locator('button[aria-expanded="false"]');
  if (await fold.count()) await fold.click();
  await expect(card.locator("tbody tr").first()).toBeVisible();
  return card;
}

/**
 * How far the card's table reaches past the card: the widest of the table past its wrapper, any box between the table
 * and the card that scrolls sideways (the X6 box), the table's right edge past the card's content edge, and the page.
 */
async function overflow(card: Locator): Promise<number> {
  await expect(card.locator("tbody tr").first()).toBeVisible();
  return card.evaluate((section) => {
    const table = section.querySelector("table")!;
    const style = getComputedStyle(section);
    const contentRight = section.getBoundingClientRect().right - parseFloat(style.paddingRight) - parseFloat(style.borderRightWidth);
    const boxes: HTMLElement[] = [];
    for (let b = table.parentElement; b && b !== section; b = b.parentElement) boxes.push(b);
    const page = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return Math.max(
      0,
      Math.round(table.getBoundingClientRect().right - contentRight),
      ...boxes.map((b) => b.scrollWidth - b.clientWidth),
      page,
    );
  });
}

const TABLES = [
  { name: "Inventory", url: "/ui/admin/shadow-ai", card: "Inventory" },
  { name: "Recent runs", url: "/ui/admin/shadow-ai/discovery-sources", card: "Recent runs" },
  { name: "Audit entries", url: "/ui/admin/audit", card: "Entries" },
  { name: "Use-case audit trail", url: `/ui/admin/audit?objectType=ai_use_case&objectId=${USE_CASE}`, card: "Entries" },
];

for (const width of [1440, 1024, 390]) {
  for (const t of TABLES) {
    test(`${t.name} fits its card at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(t.url);
      expect(await overflow(await openCard(page, t.card))).toBe(0);
    });
  }
}

async function openDrawer(page: Page) {
  await page.getByRole("button", { name: `Plan remediation for ${findings[1]!.subject}` }).click();
  await expect(page.getByRole("dialog", { name: findings[1]!.subject })).toBeVisible();
}

for (const width of [1440, 1024]) {
  test(`Inventory fits beside the open drawer at ${width} px, and its caption is whole`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/ui/admin/shadow-ai");
    await openDrawer(page);
    const card = cardOf(page, "Inventory");
    // the drawer narrows the table, not the window: it folds on its own width
    await expect(card.locator("[data-fold-step]")).not.toHaveAttribute("data-fold-step", "lg");
    expect(await overflow(card)).toBe(0);
    const caption = card.getByText("Every row is a lead for triage, not a verdict.", { exact: true });
    const fits = await caption.evaluate((el) => el.scrollWidth <= el.clientWidth && el.getBoundingClientRect().left >= el.closest("section")!.getBoundingClientRect().left);
    expect(fits).toBe(true);
  });
}

test("the Inventory caption sits outside the scroll box", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai");
  const card = cardOf(page, "Inventory");
  const caption = card.getByText("Every row is a lead for triage, not a verdict.", { exact: true });
  await expect(caption).toBeVisible();
  // the X6 box is the card's child that holds the table; the caption is a sibling before it, never inside it
  const where = await caption.evaluate((el) => {
    const section = el.closest("section")!;
    const box = Array.from(section.children).find((c) => c.querySelector("table"))!;
    return { inBox: box.contains(el), before: Boolean(el.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING) };
  });
  expect(where).toEqual({ inBox: false, before: true });
});

test("on a phone every folded value carries its column name, and each (i) is reachable once, in the header", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/ui/admin/shadow-ai");
  const card = cardOf(page, "Inventory");
  await expect(card.locator("thead th")).toHaveCount(1);
  expect((await heads(card))[0]).toContain("Subject · Severity · Evidence");
  const row = card.locator("tbody tr", { hasText: findings[3]!.subject });
  for (const [key, label] of [["severity", "Severity"], ["sources", "Evidence"], ["confidence", "Confidence"], ["observations", "Seen"], ["disposition", "Status"], ["triage", "Next step"]] as const) {
    await expect(row.locator(`[data-fold="${key}"]`).locator("span").first()).toHaveText(label);
  }
  // moved, never removed: the warning, the review and the row's actions all stay in the row
  await expect(row.getByText("Seen again", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "Review again" })).toBeVisible();
  await expect(row.getByRole("button", { name: `Plan remediation for ${findings[3]!.subject}` })).toBeVisible();
  for (const help of ["Evidence", "Confidence", "Status"]) {
    await expect(card.getByRole("button", { name: new RegExp(`^What is ${help}\\?`) })).toHaveCount(1);
  }
  // nothing renders twice
  const dupes = await page.evaluate(() => {
    const seen = new Map<string, number>();
    for (const el of Array.from(document.querySelectorAll("[id], [data-testid]"))) {
      const key = el.id ? `#${el.id}` : `@${el.getAttribute("data-testid")}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
  });
  expect(dupes).toEqual([]);
  // the X7 slots hold: the primary action of every row starts at one x
  const lefts = await card.locator("tbody tr").evaluateAll((rows) => rows.map((r) => Math.round(r.querySelector('[data-fold="triage"] button')!.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);
});

test("Audit entries on a phone: every value is a labelled line under Event, and a deny stays tagged", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/ui/admin/audit");
  const card = cardOf(page, "Entries");
  await expect(card.locator("thead th")).toHaveCount(1);
  expect(await heads(card)).toEqual(["Event · At · User · Effect · Deploy mode · Reason · Evidence"]);
  const row = card.locator("tbody tr").filter({ hasText: "not on the caller's allow-list" });
  for (const [key, label] of [["at", "At"], ["user", "User"], ["effect", "Effect"], ["reason", "Reason"]] as const) {
    await expect(row.locator(`[data-fold="${key}"]`).locator("span").first()).toHaveText(label);
  }
  await expect(row.locator('[data-fold="effect"]')).toContainText("deny");
  // a row with no Decision BOM moves no empty "Evidence" label
  await expect(row.locator('[data-fold="bom"]')).toHaveCount(0);
});

test("Recent runs takes the full width, with Reveal a pseudonym in its own row below", async ({ page }) => {
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  const runsCard = await openCard(page, "Recent runs");
  const reveal = page.locator("section[data-rg-card]").filter({ has: page.getByText("Reveal a pseudonym", { exact: true }) });
  const [a, b] = [(await runsCard.boundingBox())!, (await reveal.boundingBox())!];
  expect(Math.abs(a.width - b.width)).toBeLessThanOrEqual(1);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  // at 1440 nothing folds: every column has its own header
  expect(await heads(runsCard)).toEqual(["Source", "Status", "Queued", "Observed / matched", "Findings", "Catalogue gaps", "Reads"]);
  // a read the scanner could not make is still said in the row
  await expect(runsCard.locator("tbody tr").nth(2)).toContainText(/could not read/i);
});

/** the header texts and each row's folded lines (data-fold key → its label) */
// the server-sorted column carries its arrow (ADR-0219): the header's words are what these tests read
const heads = (card: Locator) => card.locator("thead th").allInnerTexts().then((all) => all.map((h) => h.replace(/[▲▼]/g, "").replace(/\s+/g, " ").trim()));
async function foldLabels(row: Locator, labels: Record<string, string>) {
  for (const [key, label] of Object.entries(labels)) await expect(row.locator(`[data-fold="${key}"]`).locator("span").first()).toHaveText(label);
}

test("Inventory at 1024 px folds at md: Evidence and Seen under Subject, Confidence under Severity, each labelled", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto("/ui/admin/shadow-ai");
  const card = await openCard(page, "Inventory");
  await expect(card.locator("[data-fold-step]")).toHaveAttribute("data-fold-step", "md");
  expect(await heads(card)).toEqual(["Severity · Confidence", "Subject · Evidence · Seen", "Status", "Next step"]);
  const row = card.locator("tbody tr", { hasText: findings[2]!.subject });
  await foldLabels(row, { sources: "Evidence", observations: "Seen", confidence: "Confidence" });
  // L1: a short value stays on its label's line ("Confidence [High]"), as in the mockup
  const [label, value] = await row.locator('[data-fold="confidence"] > span').evaluateAll((spans) => spans.map((s) => s.getBoundingClientRect().top));
  expect(Math.abs(label! - value!)).toBeLessThanOrEqual(4);
});

test("Recent runs at 1024 px, opened from collapsed, folds at md with every value labelled and no overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  const card = cardOf(page, "Recent runs");
  // ADR-0219: the card pages under the list control instead of folding, so its table is there from the start
  await openCard(page, "Recent runs");
  await expect(card.locator("[data-fold-step]")).toHaveAttribute("data-fold-step", "md");
  expect(await overflow(card)).toBe(0);
  expect(await heads(card)).toEqual(["Source · Queued", "Status · Reads", "Findings · Observed / matched", "Catalogue gaps"]);
  await foldLabels(card.locator("tbody tr").nth(2), { when: "Queued", counts: "Observed / matched", reads: "Reads" });
  await expect(card.locator("tbody tr").nth(2).locator('[data-fold="reads"]')).toContainText(/could not read/i);
});

test("Recent runs on a phone: Findings, Catalogue gaps and the md folds sit under Source, each labelled", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/ui/admin/shadow-ai/discovery-sources");
  const card = await openCard(page, "Recent runs");
  await expect(card.locator("[data-fold-step]")).toHaveAttribute("data-fold-step", "sm");
  expect(await heads(card)).toEqual(["Source · Queued · Observed / matched · Findings · Catalogue gaps", "Status · Reads"]);
  await foldLabels(card.locator("tbody tr").first(), { when: "Queued", counts: "Observed / matched", findings: "Findings", gaps: "Catalogue gaps" });
  await expect(card.locator("tbody tr").first().locator('[data-fold="gaps"]').getByTestId("catalogue-gap")).toHaveCount(2);
  await expect(card.locator("tbody tr").nth(3)).toContainText("credential_refused");
});

test("the use-case audit trail on a phone: every value is a labelled line under Event", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto(`/ui/admin/audit?objectType=ai_use_case&objectId=${USE_CASE}`);
  const card = cardOf(page, "Entries");
  await expect(card.locator("[data-fold-step]")).toHaveAttribute("data-fold-step", "sm");
  await expect(card.locator("thead th")).toHaveCount(1);
  const row = card.locator("tbody tr").filter({ hasText: "Credit memo assistant" }).first();
  await foldLabels(row, { at: "At", user: "User", effect: "Effect", deployMode: "Deploy mode", reason: "Reason" });
});

test("Audit entries at 1024 px: a folded column keeps its own sort, from its name in the host header (M1)", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto("/ui/admin/audit");
  const card = cardOf(page, "Entries");
  await expect(card.locator("[data-fold-step]")).toHaveAttribute("data-fold-step", "md");
  expect(await heads(card)).toEqual(["At · User", "Event", "Effect · Deploy mode", "Reason", "Evidence"]);
  await foldLabels(card.locator("tbody tr").first(), { user: "User", deployMode: "Deploy mode" });
  const effect = card.locator("thead th", { hasText: "Effect" });
  const rows = card.locator("tbody tr");
  // ADR-0219: the folded Deploy mode sorts on the server, ascending then descending
  const asks = (sort: string, dir: string) => page.waitForRequest((r) => { const q = new URL(r.url()).searchParams; return new URL(r.url()).pathname === "/v1/audit" && q.get("sort") === sort && q.get("dir") === dir; });
  let asked = asks("deployMode", "asc");
  await effect.getByRole("button", { name: "Deploy mode", exact: true }).click();
  await asked;
  await expect(effect).toHaveAttribute("aria-sort", "ascending");
  asked = asks("deployMode", "desc");
  await effect.getByRole("button", { name: "Deploy mode", exact: true }).click();
  await asked;
  await expect(effect).toHaveAttribute("aria-sort", "descending");
  await expect(rows.first()).toBeVisible();
  // the host's own header text still sorts the host: by Effect
  asked = asks("effect", "asc");
  await effect.click({ position: { x: 12, y: 12 } });
  await asked;
  await expect(effect).toHaveAttribute("aria-sort", "ascending");
  // one arrow, beside the column that sorts
  await expect(effect.locator("span", { hasText: /^[▲▼]$/ })).toHaveCount(1);
  // a column that is not folded still announces only its own sort
  await expect(card.locator("thead th", { hasText: "Event" })).not.toHaveAttribute("aria-sort", /.+/);
});

test("Audit entries at 1024 px: the folded Deploy mode sort works from the keyboard (L4)", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 1000 });
  await page.goto("/ui/admin/audit");
  const card = cardOf(page, "Entries");
  await expect(card.locator("[data-fold-step]")).toHaveAttribute("data-fold-step", "md");
  const effect = card.locator("thead th", { hasText: "Effect" });
  const deployMode = effect.getByRole("button", { name: "Deploy mode", exact: true });
  await expect(effect).not.toHaveAttribute("aria-sort", /.+/);
  await deployMode.focus();
  await expect(deployMode).toBeFocused();
  const asked = page.waitForRequest((r) => { const q = new URL(r.url()).searchParams; return new URL(r.url()).pathname === "/v1/audit" && q.get("sort") === "deployMode" && q.get("dir") === "asc"; });
  await page.keyboard.press("Enter");
  await asked;
  await expect(effect).toHaveAttribute("aria-sort", "ascending");
  await expect(deployMode).toBeFocused();
});

test("on a phone a card's header wraps: the title keeps one line and the filters move below it (M2)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.goto("/ui/admin/shadow-ai");
  const header = (await openCard(page, "Inventory")).locator(":scope > div").first();
  // ADR-0219: the Inventory pages under the list control instead of folding; its title is the header's first span
  const fold = header.locator(":scope > span").first();
  const filters = header.getByRole("button", { name: /^All/ });
  const [f, a] = [(await fold.boundingBox())!, (await filters.boundingBox())!];
  // one 44 px line: "Inventory 4 findings" is not squeezed onto two
  expect(f.height).toBeLessThanOrEqual(44);
  expect(a.y).toBeGreaterThanOrEqual(f.y + f.height);
  // the same rule as a plain card's title (#453): it is as wide as its content before anything shrinks it, so a
  // header that does not fit wraps its actions instead of squeezing the title
  await expect(header.locator(":scope > span").first()).toHaveCSS("flex-basis", "max-content");
});
