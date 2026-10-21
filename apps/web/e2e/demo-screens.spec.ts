/**
 * ADR-0197 — the populated-state screenshot pack for the 2026-11-01 demo, and an automated visual QA pass over it.
 *
 * Walks the beats of `docs/product/DEMO_SCRIPT_2026-11-01.md` in order on a `demo:prepare` database (after the
 * 10-05 journeys in the same CI job, which leave it populated): Shadow AI first (discovery sources, findings and
 * sightings, agents, the remediation plan, the workflow and Morgan's sign-off in the Inbox, the intake prefill),
 * then the governance beats (the use-case record, trust, alerts, graph, regulatory, evidence, posture, content
 * trust). Full-page shots at 1440x900, light theme; the opening Shadow-AI screens in dark as well, and one alert in
 * the shared detail drawer at 900 px, where it is a modal. The pack is
 * uploaded as the `demo-screens` artifact on every run (`.github/workflows/demo.yml`).
 *
 * The QA pass is machine-checkable only: every screen's text, and every input and textarea value, is scanned for
 * leaks ("undefined", "NaN", "[object Object]", secret-shaped values including this product's own token prefixes) and
 * the signed-in persona's name, and the spec fails on any console error or uncaught page error. A 4xx console line is
 * ignored only for a path the walk reaches on purpose (`EXPECTED_4XX`), and every ignored line is kept in
 * `qa-report.json`. Raw ids, ISO timestamps, truncated text and horizontal overflow are recorded per screen in
 * `qa-report.json` for the human review in `docs/product/DEMO_SCREENS_QA_2026-11-01.md`, never asserted: some ids
 * are shown on purpose (a workflow id in a status line).
 *
 * Personas sign in with what demo:prepare printed (E2E_DEMO_PREPARE_LOG, `demo-credentials.ts`); a password a
 * journey sets is never a literal.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disposablePassword, PERSONA_EMAIL, signInPrepared } from "./demo-credentials";
import { settleWithStepUp } from "./admin-api";

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, "artifacts", "demo-screens");
mkdirSync(SHOTS, { recursive: true });
const BASE_URL = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3105";
const VIEWPORT = { width: 1440, height: 900 };

const ADMIN_PASSWORD = disposablePassword("E2E_DEMO_ADMIN_PASSWORD");
const AVERY_PASSWORD = disposablePassword("E2E_DEMO_AVERY_PASSWORD");
const MORGAN_PASSWORD = disposablePassword("E2E_DEMO_MORGAN_PASSWORD");
const REMEDIATION_REPO = "gitlab:acme-bank-demo/credit-memo-assistant";
const LIVE_FINDING = /branch-faq-bot/;

type Check = { name: string; persona: string; url: string; files: string[]; leaks: string[]; ids: string[]; isoTimestamps: string[]; truncated: string[]; overflowX: number; empty: string[]; personaShown: boolean; notes: string[] };
const report: Check[] = [];
const consoleProblems: string[] = [];
const ignoredConsole: string[] = [];

/**
 * The API paths whose 4xx the walk causes on purpose, so the browser's "Failed to load resource" line for them is
 * not a defect: the signed-out session probe, and the step-up refusal (403 step_up_required) a protected write
 * answers before `settleWithStepUp` steps up and retries it. Any other 4xx, an asset's included, fails the walk.
 */
const EXPECTED_4XX: RegExp[] = [
  /^\/auth\/me$/, // the SPA's session probe on the sign-in screen answers 401 before anyone signs in
  /^\/v1\/workflows\/instances$/, // S3 Start and link: the workflow
  /^\/v1\/shadow-ai\/findings\/[^/]+\/remediate$/, // S3 Start and link: the link to the finding
  /^\/v1\/approvals\/[^/]+\/decide$/, // S3 Morgan's sign-off
];

/** every console error and uncaught error, per persona; a 4xx line is ignored (and recorded) only for EXPECTED_4XX */
function watch(page: Page, persona: string) {
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    const from = msg.location().url;
    const where = from ? new URL(from, BASE_URL).pathname : "";
    const line = `${persona} ${new URL(page.url()).pathname}: ${text}${where ? ` (${where})` : ""}`;
    if (/^Failed to load resource: the server responded with a status of 4\d\d/.test(text) && EXPECTED_4XX.some((re) => re.test(where))) {
      ignoredConsole.push(line);
      return;
    }
    consoleProblems.push(line);
  });
  page.on("pageerror", (err) => consoleProblems.push(`${persona} ${page.url()}: uncaught ${err.message}`));
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page
    .waitForFunction(() => !document.querySelector('[class*="_skeleton"], [aria-busy="true"]'), null, { timeout: 10_000 })
    .catch(() => undefined);
  // let a toast leave first so it never covers the content (they auto-dismiss after ~4s)
  await page
    .waitForFunction(
      () => !Array.from(document.querySelectorAll('[aria-live="polite"]')).some((el) => getComputedStyle(el).position === "fixed" && el.childElementCount > 0),
      null,
      { timeout: 4_500 },
    )
    .catch(() => undefined);
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate((next) => {
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("regulait.theme", next); } catch { /* storage blocked: the attribute is enough */ }
    window.scrollTo(0, 0);
  }, theme);
  await page.waitForTimeout(300);
}

const SECRET_SHAPES = [
  /\bAKIA[0-9A-Z]{16}\b/, // cloud access key id
  /\bglpat-[0-9A-Za-z_-]{20}\b/, // GitLab token
  /\bgh[pousr]_[0-9A-Za-z]{36}\b/, // GitHub token
  /\bsk-[0-9A-Za-z_-]{20,}\b/, // provider API key
  /\botpauth:\/\/\S+/, // an authenticator secret
  // this product's own: API key, virtual key, session, feedback link, SCIM, step-up, endpoint bulk token and ticket,
  // engine enrolment token and runner key. The prefixes are not all exported from @regulait/shared (several live in
  // apps/gateway), so they are listed here; `packages/shared/src/guardrails.ts` holds the DLP form of the same set.
  /\brg(?:l|lv|ls|lf|lscim|lwh|su|ea|at|ee|ek)_[0-9A-Za-z_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** shoot `name` (light, and dark when asked) and record what the QA pass reads off the screen */
async function capture(page: Page, persona: { key: string; displayName: string }, name: string, opts: { dark?: boolean; notes?: string[] } = {}) {
  await settle(page);
  const files: string[] = [];
  for (const theme of opts.dark ? (["light", "dark"] as const) : (["light"] as const)) {
    await setTheme(page, theme);
    const file = `${name}-${theme}.png`;
    await page.screenshot({ path: path.join(SHOTS, file), fullPage: true });
    files.push(file);
  }
  await setTheme(page, "light");
  const seen = await page.evaluate(() => {
    // a secret shown in a read-only field is in its value, not in innerText
    const fields = Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea"))
      .filter((el) => el.type !== "password")
      .map((el) => el.value)
      .filter(Boolean);
    const text = document.body.innerText;
    const truncated = Array.from(document.querySelectorAll("body *"))
      .filter((el) => {
        const he = el as HTMLElement;
        // visible text only: the collapsed navigation rail and screen-reader-only labels clip on purpose
        if (!he.textContent?.trim() || he.children.length > 0 || he.clientWidth < 24 || he.closest("nav")) return false;
        const cs = getComputedStyle(he);
        return he.scrollWidth > he.clientWidth + 1 && (cs.textOverflow === "ellipsis" || cs.overflowX === "hidden");
      })
      .slice(0, 25)
      .map((el) => (el.textContent ?? "").trim().slice(0, 90));
    const empty = Array.from(document.querySelectorAll('[class*="_emptyTitle_"]')).map((el) => (el.textContent ?? "").trim());
    return { text, fields: fields.join("\n"), truncated, empty, overflowX: document.documentElement.scrollWidth - window.innerWidth };
  });
  const leaks = [
    ...[/\bundefined\b/, /\bNaN\b/, /\[object Object\]/].flatMap((re) => (re.test(seen.text) ? [`"${re.source}"`] : [])),
    ...SECRET_SHAPES.flatMap((re) => (re.test(seen.text) ? [`secret-shaped: ${re.source}`] : [])),
    ...SECRET_SHAPES.flatMap((re) => (re.test(seen.fields) ? [`secret-shaped field value: ${re.source}`] : [])),
  ];
  const uniq = (xs: string[]) => [...new Set(xs)].slice(0, 12);
  const check: Check = {
    name,
    persona: persona.key,
    url: new URL(page.url()).pathname,
    files,
    leaks,
    ids: uniq(seen.text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi) ?? []),
    isoTimestamps: uniq(seen.text.match(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?\b/g) ?? []),
    truncated: uniq(seen.truncated),
    overflowX: seen.overflowX,
    empty: uniq(seen.empty),
    personaShown: seen.text.includes(persona.displayName),
    // "null" can be a JSON value an audit row shows on purpose: recorded for the review, not asserted
    notes: [...(opts.notes ?? []), ...(/\bnull\b/.test(seen.text) ? ['the text "null" is on screen'] : [])],
  };
  report.push(check);
  expect.soft(leaks, `${name}: text leaks on screen`).toEqual([]);
  // the shell and page width are asserted at the pack's 1440 px; a narrower shot (the drawer as a modal) records them
  if ((page.viewportSize()?.width ?? VIEWPORT.width) < VIEWPORT.width) {
    if (!check.personaShown) check.notes.push(`narrow shot: ${persona.displayName} not in the visible text`);
    if (seen.overflowX > 0) check.notes.push(`narrow shot: ${seen.overflowX}px of horizontal page scroll`);
    return;
  }
  expect.soft(check.personaShown, `${name}: the shell names ${persona.displayName}`).toBe(true);
  expect.soft(seen.overflowX, `${name}: no horizontal page scroll at 1440px`).toBeLessThanOrEqual(0);
}

async function personaPage(browser: Browser, persona: string) {
  const ctx = await browser.newContext({ baseURL: BASE_URL, viewport: VIEWPORT, reducedMotion: "reduce", colorScheme: "light" });
  await ctx.addInitScript(() => {
    try { localStorage.setItem("regulait.theme", "light"); } catch { /* storage blocked */ }
  });
  const page = await ctx.newPage();
  watch(page, persona);
  return page;
}

const ADA = { key: "ada", displayName: "Ada Admin" };
const MORGAN = { key: "morgan", displayName: "Morgan Reyes" };
const AVERY = { key: "avery", displayName: "Avery Approver" };

/** the AI-policy acknowledgement gate a persona's first sign-in can meet: acknowledge, or defer what stays open */
async function passPolicyGate(page: Page, gate: ReturnType<Page["getByRole"]>) {
  if (!(await gate.isVisible())) return;
  for (const box of await gate.getByRole("checkbox").all()) await box.check();
  for (const button of await gate.getByRole("button", { name: "Acknowledge" }).all()) await button.click();
  // the gate closes once nothing is outstanding; if a document stays open it is deferred, never forced
  if (!(await gate.waitFor({ state: "hidden", timeout: 5_000 }).then(() => true, () => false))) await gate.getByRole("button", { name: "Not now" }).click();
  await expect(gate).toBeHidden();
}

test.afterAll(() => {
  writeFileSync(path.join(SHOTS, "qa-report.json"), JSON.stringify({ screens: report, consoleProblems, ignoredConsole }, null, 2));
  // the job log carries the summary, so the QA review does not depend on opening the artifact
  for (const c of report) {
    console.log(
      `[demo-screens] ${c.name} ${c.url} leaks=${c.leaks.length} ids=${c.ids.length} iso=${c.isoTimestamps.length} ` +
        `truncated=${c.truncated.length} overflowX=${c.overflowX} empty=${JSON.stringify(c.empty)} persona=${c.personaShown}` +
        (c.truncated.length ? ` truncatedText=${JSON.stringify(c.truncated)}` : "") +
        (c.isoTimestamps.length ? ` isoText=${JSON.stringify(c.isoTimestamps)}` : "") +
        (c.leaks.length ? ` leakText=${JSON.stringify(c.leaks)}` : "") +
        (c.notes.length ? ` notes=${JSON.stringify(c.notes)}` : ""),
    );
  }
  for (const p of consoleProblems) console.log(`[demo-screens] console: ${p}`);
  for (const p of ignoredConsole) console.log(`[demo-screens] console (expected 4xx, ignored): ${p}`);
});

test("2026-11-01 demo screens, in script order: Shadow AI, then governance", async ({ browser }) => {
  test.setTimeout(420_000);
  const ada = await personaPage(browser, "ada");
  const signedIn = await signInPrepared(ada, PERSONA_EMAIL.admin, ADMIN_PASSWORD, ada.getByRole("heading", { name: /Welcome back/ }));
  expect(signedIn, "demo:prepare's output (E2E_DEMO_PREPARE_LOG) names Ada").toBe(true);

  // ---------------------------------------------------------------- Act 1: find it
  await test.step("S1 discovery sources", async () => {
    await ada.goto("/ui/admin/shadow-ai/discovery-sources");
    await expect(ada.getByRole("heading", { name: "Discovery sources" })).toBeVisible();
    // W2: with the one endpoint agent source, its device table shows without a click, counted in words
    await expect(ada.getByText(/^1 device, 0 revoked, /)).toBeVisible();
    await expect(ada.getByText("Users (self-reported)", { exact: true })).toBeVisible();
    await expect(ada.getByText(/^psn:[0-9a-f]+$/).first()).toBeVisible();
    await capture(ada, ADA, "ds-s1-discovery-sources", { dark: true });
  });

  let pseudonymHref: string | null = null;
  await test.step("S2 findings, sightings, coverage", async () => {
    await ada.goto("/ui/admin/shadow-ai");
    await expect(ada.getByRole("heading", { name: "Shadow-AI discovery" })).toBeVisible();
    await expect(ada.getByRole("button", { name: `Plan remediation for ${REMEDIATION_REPO}` })).toBeVisible();
    await capture(ada, ADA, "ds-s2-findings", { dark: true });
    pseudonymHref = await ada.locator('a[href*="discovery-sources?pseudonym="]').first().getAttribute("href", { timeout: 5_000 }).catch(() => null);
  });

  await test.step("S2 a pseudonym link opens Reveal, prefilled", async () => {
    expect.soft(pseudonymHref, "a sighting links its pseudonym to Reveal").toBeTruthy();
    if (!pseudonymHref) return;
    // "Where seen" folds each finding's sightings behind a count (SH, #456): open that disclosure first, as a person would
    const link = ada.locator(`a[href="${pseudonymHref}"]`).first();
    if (!(await link.isVisible())) await ada.locator("details").filter({ has: link }).last().locator(":scope > summary").click();
    await link.click();
    await expect(ada.getByRole("heading", { name: "Discovery sources" })).toBeVisible();
    await capture(ada, ADA, "ds-s2b-pseudonym-reveal-prefilled", { notes: ["Reveal not pressed (step-up, audited)"] });
  });

  await test.step("S2 the Coverage tab (the scorecard sits on its own tab)", async () => {
    await ada.goto("/ui/admin/shadow-ai?tab=coverage");
    await expect(ada.getByRole("tab", { name: "Coverage", selected: true })).toBeVisible();
    await capture(ada, ADA, "ds-s2d-coverage");
  });

  await test.step("S1/S2 agents (the governed registry the findings map onto)", async () => {
    await ada.goto("/ui/admin/agents");
    await expect(ada.getByRole("heading", { name: "Agents" })).toBeVisible();
    await capture(ada, ADA, "ds-s2c-agents");
  });

  await test.step("S3 the seeded remediation plan (linked, waiting on Morgan)", async () => {
    await ada.goto("/ui/admin/shadow-ai");
    await ada.getByRole("button", { name: `Plan remediation for ${REMEDIATION_REPO}` }).click();
    await expect(ada.getByTestId("shadow-remediation")).toBeVisible();
    await ada.getByTestId("shadow-remediation").scrollIntoViewIfNeeded();
    // W3: the linked workflow's status reads in words, never "blocked on_approval"
    await expect(ada.getByTestId("shadow-remediation")).toContainText("blocked on approval");
    await capture(ada, ADA, "ds-s3a-remediation-plan-seeded", { dark: true });
  });

  // the script's live start, on a finding the seed left unlinked (the Azure branch FAQ deployment)
  let liveInstance: string | null = null;
  await test.step("S3 start a remediation workflow live", async () => {
    // the Azure branch FAQ deployment if the seed reports it as its own finding, else any other unlinked one
    const findings = ((await (await ada.request.get("/v1/shadow-ai/findings")).json()) as { findings: Array<{ id: string; subject: string }> }).findings;
    const candidates = [...findings.filter((f) => LIVE_FINDING.test(f.subject)), ...findings.filter((f) => f.subject !== REMEDIATION_REPO)];
    let subject: string | null = null;
    for (const f of candidates) {
      const plan = (await (await ada.request.get(`/v1/shadow-ai/findings/${f.id}/remediation-plan`)).json()) as { currentLink?: unknown; pendingLink?: unknown };
      if (!plan.currentLink && !plan.pendingLink) {
        subject = f.subject;
        break;
      }
    }
    expect(subject, "a finding with no remediation workflow yet, for the live start").toBeTruthy();
    await ada.goto("/ui/admin/shadow-ai");
    await ada.getByRole("button", { name: `Plan remediation for ${subject}`, exact: true }).click();
    const panel = ada.getByTestId("shadow-remediation");
    await expect(panel).toBeVisible();
    // the script says `sandbox`, but the product accepts only an environment a deploy target or assignment rule uses;
    // the seed's demo company deploys to `staging` (QA finding F1 in DEMO_SCREENS_QA_2026-11-01.md)
    await panel.getByRole("textbox", { name: "Environment" }).fill("staging");
    await capture(ada, ADA, "ds-s3b-remediation-plan-live");
    await panel.getByRole("button", { name: "Start remediation workflow…" }).click();
    const dialog = ada.getByRole("dialog", { name: "Start a remediation workflow?" });
    await expect(dialog).toBeVisible();
    await capture(ada, ADA, "ds-s3c-start-dialog");
    await dialog.getByRole("button", { name: "Start and link" }).click();
    const linked = panel.getByRole("status").filter({ hasText: /^Linked to workflow/ });
    await settleWithStepUp(ada, linked.or(panel.getByRole("alert")).first(), PERSONA_EMAIL.admin);
    await expect(linked).toBeVisible();
    liveInstance = (await linked.locator("code").first().textContent())?.trim() ?? null;
    await capture(ada, ADA, "ds-s3d-started-and-linked");
  });

  await test.step("S3 the workflow: plan-only, the plan as its artifact, waiting for sign-off", async () => {
    expect(liveInstance, "the status line names the started workflow").toBeTruthy();
    await ada.goto(`/ui/workflows/${liveInstance}`);
    const finish = ada.getByRole("button", { name: "Finish planning" });
    await expect(finish).toBeVisible();
    await capture(ada, ADA, "ds-s3e-workflow-plan-only");
    await finish.click();
    const artifact = ada.getByLabel("Artifact content");
    await expect(artifact).toBeVisible();
    await artifact.fill(
      "# Remediation plan: branch-faq-bot\n\n1. Register the branch FAQ use case and route it through the governed agent.\n" +
        "2. Replace the direct deployment call with the gateway endpoint.\n3. Confirm the next call appears in the audit log and the usage ledger.",
    );
    await capture(ada, ADA, "ds-s3f-workflow-artifact");
    await ada.getByRole("button", { name: "Submit for sign-off" }).click();
    await expect(ada.getByText("waiting for sign-off", { exact: true })).toBeVisible();
    await capture(ada, ADA, "ds-s3g-workflow-waiting-signoff");
  });

  await test.step("S3 Morgan signs the remediation off in the Inbox", async () => {
    const morgan = await personaPage(browser, "morgan");
    // Morgan's first sign-in meets the AI-policy acknowledgement gate (enforced in the demo data): she reads and
    // acknowledges, as the presenter does once while preparing (QA finding F2)
    const gate = morgan.getByRole("region", { name: "AI policy acknowledgement" });
    const ok = await signInPrepared(morgan, PERSONA_EMAIL.morgan, MORGAN_PASSWORD, morgan.getByRole("heading", { name: /Welcome back/ }).or(gate));
    expect(ok, "demo:prepare's output names Morgan (the second admin)").toBe(true);
    if (await gate.isVisible()) {
      await capture(morgan, MORGAN, "ds-s3g2-morgan-policy-gate", { notes: ["Morgan's first sign-in: the AI-policy acknowledgement gate"] });
      await passPolicyGate(morgan, gate);
    }
    await morgan.goto("/ui/inbox");
    await expect(morgan.getByRole("heading", { name: "Inbox" })).toBeVisible();
    const row = morgan
      .locator("div")
      .filter({ has: morgan.locator(`a[href$="/workflows/${liveInstance}"]`) })
      .filter({ has: morgan.getByRole("button", { name: /^Review / }) })
      .last();
    await expect(row).toBeVisible();
    // the item's evidence and decision open in the shared detail drawer (owner decision on #453)
    await row.getByRole("button", { name: /^Review / }).click();
    const item = morgan.getByTestId("inbox-item");
    await expect(item.getByRole("button", { name: "Approve" })).toBeVisible();
    await capture(morgan, MORGAN, "ds-s3h-morgan-inbox");
    await item.getByRole("button", { name: "Approve" }).click();
    await settleWithStepUp(morgan, morgan.getByText("Approved", { exact: true }).first(), PERSONA_EMAIL.morgan);
    await expect(morgan.getByText("Approved", { exact: true }).first()).toBeVisible();
    await capture(morgan, MORGAN, "ds-s3i-morgan-approved");
    await morgan.context().close();
    await ada.goto(`/ui/workflows/${liveInstance}`);
    await expect(ada.getByText("waiting for sign-off", { exact: true })).toBeHidden();
    await capture(ada, ADA, "ds-s3j-workflow-signed-off");
  });

  await test.step("S4 register as use case: the intake, prefilled from the finding", async () => {
    await ada.goto("/ui/admin/shadow-ai");
    const register = ada.getByRole("row").filter({ has: ada.getByRole("button", { name: `Plan remediation for ${REMEDIATION_REPO}` }) }).getByRole("link", { name: "Register as use case" });
    await register.first().click();
    await expect(ada.getByRole("heading", { name: "Register AI use case" })).toBeVisible();
    await capture(ada, ADA, "ds-s4-intake-prefilled", { notes: ["not submitted: the 10-05 journey already drove the intake end to end"] });
  });

  // ---------------------------------------------------------------- Act 2: govern it
  let recordId: string | null = null;
  await test.step("G1 the use-case registry and record", async () => {
    await ada.goto("/ui/admin/use-cases");
    await expect(ada.getByRole("heading", { name: "AI registry" })).toBeVisible();
    await capture(ada, ADA, "ds-g1a-registry");
    const list = (await (await ada.request.get("/v1/use-cases")).json()) as { useCases: Array<{ id: string; name: string }> };
    const record = list.useCases.find((u) => u.name.startsWith("Govern ")) ?? list.useCases[0];
    expect(record, "the registry has a use case").toBeTruthy();
    recordId = record!.id;
    await ada.goto(`/ui/admin/governance/use-cases/${recordId}`);
    await expect(ada.getByText("Lifecycle tracker")).toBeVisible();
    await capture(ada, ADA, "ds-g1b-use-case-record");
    // #465: the use case's own audit trail, its true total, and (admin only) the link into the audit log's filter
    await ada.getByRole("tab", { name: /^Audit\b/ }).click();
    await expect(ada.getByText("Recent use-case audit evidence")).toBeVisible();
    await capture(ada, ADA, "ds-g1c-use-case-audit");
    await ada.getByRole("link", { name: "Open this use case's full audit trail" }).click();
    await expect(ada.getByTestId("audit-only-object")).toBeVisible();
    await capture(ada, ADA, "ds-g1d-use-case-audit-trail");
  });

  await test.step("G2 Avery's independent review: Approve with conditions (captured, not submitted)", async () => {
    const avery = await personaPage(browser, "avery");
    const gate = avery.getByRole("region", { name: "AI policy acknowledgement" });
    const ok = await signInPrepared(avery, PERSONA_EMAIL.avery, AVERY_PASSWORD, avery.getByRole("heading", { name: /Welcome back/ }).or(gate));
    expect(ok, "demo:prepare's output names Avery").toBe(true);
    await passPolicyGate(avery, gate);
    await avery.goto("/ui/inbox");
    await expect(avery.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await capture(avery, AVERY, "ds-g2a-avery-inbox");
    const review = avery.getByRole("button", { name: /^Review sign-off for / });
    // the 10-05 journey decides its own registration, so a pending sign-off is not guaranteed here: record it
    if ((await review.count()) === 0) {
      report.at(-1)!.notes.push("no use-case sign-off pending for Avery: the review dialog was not captured");
    } else {
      await review.last().click();
      const dialog = avery.getByRole("dialog", { name: "Review use case sign-off" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("radio", { name: "Approve with conditions" }).check();
      await expect(dialog.getByRole("group", { name: "Condition 1" })).toBeVisible();
      await capture(avery, AVERY, "ds-g2b-avery-review-conditions", { notes: ["Approve with conditions chosen, not submitted"] });
      await dialog.getByRole("button", { name: "Close review" }).click();
      await expect(dialog).toBeHidden();
    }
    await avery.context().close();
  });

  const pages: Array<[string, string, string]> = [
    ["G4 trust dashboard", "/ui/admin/governance/trust", "Trust & evidence"],
    ["G5 alerts and remediation", "/ui/admin/governance/alerts", "Governance alerts"],
    ["G6 dependency graph", "/ui/admin/governance/graph", "AI dependency graph"],
    ["G7 regulatory intelligence", "/ui/admin/governance/regulatory", "Regulatory & policy intelligence"],
    ["G8 evidence: the audit log and signed export", "/ui/admin/audit", "Audit log"],
    ["posture", "/ui/admin/posture", "Posture"],
    ["G9 incidents", "/ui/incidents", "AI incidents"],
    ["G9 feedback", "/ui/feedback", "Feedback and appeals"],
  ];
  const shoot = async ([beat, url, heading]: [string, string, string]) => {
    await test.step(beat, async () => {
      await ada.goto(url);
      await expect(ada.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      if (url.endsWith("/audit")) await expect(ada.getByRole("button", { name: "Download signed bundle" })).toBeVisible();
      await capture(ada, ADA, `ds-${beat.split(" ")[0]!.toLowerCase()}-${url.split("/").pop()}`);
    });
  };
  for (const p of pages) await shoot(p);
  await test.step("G5 an alert in the shared detail drawer: a side panel above 900 px, a modal at 900 px and below", async () => {
    await ada.goto("/ui/admin/governance/alerts");
    await expect(ada.getByRole("heading", { name: "Governance alerts", exact: true })).toBeVisible();
    const rows = ada.getByRole("button").filter({ has: ada.locator("strong") }).filter({ hasText: / · seen / });
    if ((await rows.count()) === 0) {
      report.at(-1)?.notes.push("no active alert to open: the drawer was not captured");
      return;
    }
    await rows.first().click();
    const drawer = ada.getByTestId("alert-detail");
    await expect(drawer).toBeVisible();
    await capture(ada, ADA, "ds-g5b-alert-drawer", { notes: ["side panel at 1440 px; Acknowledge is in the pinned footer"] });
    await ada.setViewportSize({ width: 900, height: 900 });
    await expect(drawer).toBeVisible();
    await capture(ada, ADA, "ds-g5c-alert-drawer-narrow", { notes: ["900 px: the drawer is a modal over the page"] });
    await ada.setViewportSize(VIEWPORT);
  });
  await test.step("G9 the use case's Decision records tab", async () => {
    expect(recordId, "G1 opened a use-case record").toBeTruthy();
    await ada.goto(`/ui/admin/governance/use-cases/${recordId}`);
    await ada.getByRole("tab", { name: "Decision records" }).click();
    await expect(ada.getByText("Decision records").last()).toBeVisible();
    await capture(ada, ADA, "ds-g9-decision-records");
  });
  await shoot(["G10 content trust", "/ui/admin/content-trust", "Content trust"]);
  await ada.context().close();

  expect(consoleProblems, "console errors and uncaught page errors across the walk").toEqual([]);
});
