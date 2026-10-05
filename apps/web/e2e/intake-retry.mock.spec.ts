/**
 * AER-046 — an intake retry after the proposer EDITED earlier inputs must end
 * coherent: every persisted record matches the inputs on screen (all-new), or
 * the retry is refused and nothing is sent (all-old). Never the old use case
 * and questionnaire beside new risks.
 *
 * The mock below is a tiny in-memory gateway: it keeps the use case, every
 * questionnaire VERSION and every risk the page writes, so each test can assert
 * both the requests the page sent and the state those requests left behind.
 * The first attempt always fails on the second risk — after the use case, the
 * questionnaire and the first risk (with its control) are written.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const USE_CASE = "11111111-1111-4111-8111-111111111111";
const USE_CASE_2 = "44444444-4444-4444-8444-444444444444";
const BIAS_TITLE = "Disparate credit recommendation outcomes";
const INJECTION_TITLE = "Prompt injection through customer-supplied text";

const assist = {
  tier: { value: "high", reasons: [{ ruleId: "annex-iii", tier: "high", ref: "Annex III", reason: "Essential service" }], rulesetVersion: 1, source: "rules", disclaimer: "Screening, not legal advice." },
  frameworks: [
    { framework: "eu-ai-act", title: "EU AI Act", why: "EU nexus and high-risk purpose", source: "rules" },
    { framework: "nist-ai-rmf", title: "NIST AI RMF", why: "agentic financial workflow", source: "rules" },
  ],
  risks: [
    { scenarioKey: "credit-bias", title: BIAS_TITLE, description: "Profiling data may produce materially different recommendations across protected groups.", category: "bias_fairness", dimension: "bias", likelihood: "medium", impact: "high", suggestedControls: ["eu-ai-act:art-14-human-oversight"], why: "profiles natural persons", source: "rules" },
    { scenarioKey: "prompt-injection", title: INJECTION_TITLE, description: "Free-text input may steer the assistant away from its instructions.", category: "prompt_injection", dimension: "security", likelihood: "medium", impact: "medium", suggestedControls: [], why: "the system interacts directly with people", source: "mock" },
  ],
  euAiActBlock: "```eu-ai-act-answers\n{\"purposeDomain\":\"essential-services\",\"profilesNaturalPersons\":true}\n```",
  questionnaire: Array.from({ length: 8 }, (_, i) => ({
    id: `q${i + 1}`,
    heading: `${i + 1}. ${["Purpose and business context", "Affected people", "Data", "Human oversight", "Operations", "Monitoring", "Security", "Accountability"][i]}`,
    text: `Draft answer ${i + 1}`,
    source: "rules",
  })),
  blocking: null,
  narrative: { status: "drafted", source: "mock" },
  disclaimer: "Suggestions only.",
};

type Json = Record<string, unknown>;
interface Sent { method: string; path: string; body: Json }
interface Store {
  useCases: Array<Json & { id: string }>;
  /** questionnaire versions, oldest first */
  artifacts: string[];
  risks: Array<Json & { id: string; controls: string[] }>;
  sent: Sent[];
  /** the wizard's server-side draft (ADR-0171) */
  draft: { scope: string; state: unknown; updatedAt: string } | null;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function mockGateway(page: Page): Promise<Store> {
  const store: Store = { useCases: [], artifacts: [], risks: [], sent: [], draft: null };
  let injectionFailed = false;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    if (request.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = request.method();
    const body = (method === "GET" ? {} : request.postDataJSON() ?? {}) as Json;
    // ADR-0171: the wizard's own draft is kept beside the records, not among them
    if (p === "/v1/use-cases/draft") {
      if (method === "PUT") store.draft = { scope: "new", state: body.state, updatedAt: "2026-10-03T12:00:00Z" };
      if (method === "DELETE") store.draft = null;
      return method === "DELETE" ? route.fulfill({ status: 204 }) : json(route, { draft: store.draft });
    }
    if (method !== "GET") store.sent.push({ method, path: p, body });

    if (p === "/auth/me") return json(route, { userId: "u", isAdmin: true, via: "session", user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "u", isAdmin: true, user: { id: "u", email: "avery@example.test", displayName: "Avery Admin" } });
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/vendors") return json(route, { vendors: [] });
    if (p === "/v1/use-cases/intake/assist") return json(route, assist);
    if (p === "/v1/use-cases" && method === "POST") {
      const id = store.useCases.length === 0 ? USE_CASE : USE_CASE_2;
      store.useCases.push({ ...body, id });
      return json(route, { id, instance: { id: `instance-${id}` } }, 201);
    }
    const useCase = p.match(/^\/v1\/use-cases\/([^/]+)$/);
    if (useCase && method === "PATCH") {
      const row = store.useCases.find((item) => item.id === useCase[1]);
      if (!row) return json(route, { error: "not_found" }, 404);
      // the gateway's lock: once a questionnaire is stored the use case is
      // under review and nothing about it may change under the reviewers
      if (store.artifacts.length > 0) {
        return json(route, { error: "locked_under_review", detail: "this use case is with its reviewers, so it can't be changed until a reviewer sends it back for more information" }, 409);
      }
      Object.assign(row, body);
      return json(route, row);
    }
    if (/^\/v1\/workflows\/instances\/[^/]+\/advance$/.test(p)) return json(route, { status: "running" });
    const abort = p.match(/^\/v1\/workflows\/instances\/instance-([^/]+)\/abort$/);
    if (abort && method === "POST") {
      const row = store.useCases.find((item) => item.id === abort[1]);
      if (row) row.status = "rejected";
      return json(route, { status: "aborted" });
    }
    if (/^\/v1\/workflows\/instances\/[^/]+\/artifacts$/.test(p)) {
      store.artifacts.push(String(body.content));
      return json(route, { version: store.artifacts.length, status: "blocked_on_approval" }, 201);
    }
    if (p === "/v1/risks" && method === "POST") {
      // the first attempt's later step fails: the injection risk, once
      if (body.title === INJECTION_TITLE && !injectionFailed) {
        injectionFailed = true;
        return json(route, { error: "internal", detail: "database unavailable" }, 500);
      }
      const row = { ...body, id: `risk-${store.risks.length + 1}`, controls: [] as string[] };
      store.risks.push(row);
      return json(route, row, 201);
    }
    const risk = p.match(/^\/v1\/risks\/([^/]+)$/);
    if (risk && method === "PATCH") {
      const row = store.risks.find((item) => item.id === risk[1]);
      if (!row) return json(route, { error: "not_found" }, 404);
      Object.assign(row, body);
      return json(route, row);
    }
    const controls = p.match(/^\/v1\/risks\/([^/]+)\/controls$/);
    if (controls && method === "POST") {
      store.risks.find((item) => item.id === controls[1])?.controls.push(String(body.controlRef));
      return json(route, { linked: true }, 201);
    }
    return json(route, {});
  });
  return store;
}

const goTo = async (page: Page, stage: string) => {
  await expect(page.locator(`[aria-current="step"]`)).toContainText(stage);
};

/** draft, accept every suggestion, optionally edit each risk's text, edit the purpose answer, reach Review */
async function walkToReview(page: Page, edits: { risks?: Record<string, string>; purpose?: string } = {}) {
  // from Describe: Classify is its own step (ADR-0168)
  await page.getByRole("button", { name: "Continue" }).click();
  await goTo(page, "Classify");
  await page.getByRole("button", { name: "Draft suggestions" }).click();
  await goTo(page, "Suggestions");
  // a second walk finds every decision still made (AER-051: going back never resets them)
  const acceptAll = page.getByRole("button", { name: /Accept all remaining/ });
  if (await acceptAll.isEnabled()) await acceptAll.click();
  for (const [riskTitle, text] of Object.entries(edits.risks ?? {})) {
    const card = page.locator("section").filter({ has: page.getByText(riskTitle, { exact: true }) }).last();
    await card.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel(`Edit ${riskTitle}`).fill(text);
  }
  await page.getByRole("button", { name: "Continue" }).click();
  await goTo(page, "Questionnaire");
  if (edits.purpose) await page.getByLabel("1. Purpose and business context answer").fill(edits.purpose);
  await page.getByRole("button", { name: "Continue" }).click();
  await goTo(page, "Link stack");
  await page.getByRole("button", { name: "Continue" }).click();
  await goTo(page, "Review");
}

/** the first attempt: the use case, planning, the questionnaire and the bias risk are written; the injection risk fails */
async function failFirstAttempt(page: Page, store: Store) {
  await page.goto("/ui/admin/governance/intake");
  await page.getByRole("button", { name: "Fill in an example" }).click();
  await walkToReview(page);
  await page.getByRole("button", { name: "Submit for human review" }).click();
  await expect(page.getByRole("main").getByRole("alert").filter({ hasText: "retry to resume" })).toBeVisible();
  expect(store.useCases).toHaveLength(1);
  expect(store.artifacts).toHaveLength(1);
  expect(store.risks.map((r) => r.title)).toEqual([BIAS_TITLE]);
  expect(store.risks[0]!.controls).toEqual(["eu-ai-act:art-14-human-oversight"]);
}

/** WCAG A + AA over the page in both themes (the same tags as intake-a11y.mock.spec.ts) */
async function expectNoAxeViolations(page: Page, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined)));
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.target.join(" ")}`), `axe on "${label}" (${theme})`).toEqual([]);
  }
}

async function backToDescribe(page: Page) {
  for (const stage of ["Link stack", "Questionnaire", "Suggestions", "Classify", "Describe"]) {
    await page.getByRole("button", { name: "Back" }).click();
    await goTo(page, stage);
  }
}

test.describe("AER-046: an intake retry after edits never mixes old records with new inputs", () => {
  test("edits made before the retry are applied to what was written — all-new, no second use case", async ({ page }) => {
    const store = await mockGateway(page);
    await failFirstAttempt(page, store);
    const mark = store.sent.length;

    // the questionnaire is stored, so the use case is with its reviewers: the
    // answers and the risks can still be brought up to date, its own fields not
    await backToDescribe(page);
    await walkToReview(page, {
      risks: { [BIAS_TITLE]: "Edited bias text.", [INJECTION_TITLE]: "Edited injection text." },
      purpose: "Edited purpose answer.",
    });
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Submitted for human review." })).toBeVisible();

    const retry = store.sent.slice(mark).filter((item) => item.path !== "/v1/use-cases/intake/assist");
    // no second use case, no second planning advance, no second bias risk, no re-linked control
    expect(retry.filter((item) => item.method === "POST" && item.path === "/v1/use-cases")).toEqual([]);
    expect(retry.filter((item) => item.path.endsWith("/advance"))).toEqual([]);
    expect(retry.filter((item) => item.path.endsWith("/controls"))).toEqual([]);
    // ADR-0179: the injection risk's first request ended in a server error, so
    // it may have been registered: the retry first finishes THAT request (same
    // Idempotency-Key, same text), then applies the edit made since
    expect(retry.map((item) => `${item.method} ${item.path}`)).toEqual([
      `POST /v1/workflows/instances/instance-${USE_CASE}/artifacts`,
      "PATCH /v1/risks/risk-1",
      "POST /v1/risks",
      "PATCH /v1/risks/risk-2",
    ]);
    expect(retry[1]!.body).toEqual({ description: "Edited bias text." });
    expect(retry[2]!.body).toMatchObject({ title: INJECTION_TITLE, description: "Free-text input may steer the assistant away from its instructions.", useCaseId: USE_CASE });
    expect(retry[3]!.body).toEqual({ description: "Edited injection text." });

    // the state the gateway holds is entirely the edited inputs
    expect(store.useCases).toHaveLength(1);
    expect(store.artifacts).toHaveLength(2); // a NEW questionnaire version over the stale one
    expect(store.artifacts.at(-1)).toContain("Edited purpose answer.");
    expect(store.artifacts.at(-1)).not.toContain("Draft answer 1\n");
    expect(store.risks.map((r) => [r.title, r.description, r.useCaseId])).toEqual([
      [BIAS_TITLE, "Edited bias text.", USE_CASE],
      [INJECTION_TITLE, "Edited injection text.", USE_CASE],
    ]);
  });

  test("a use case already with its reviewers is not edited by a retry: the refusal says why, with nothing sent", async ({ page }) => {
    const store = await mockGateway(page);
    await failFirstAttempt(page, store);
    const before = JSON.parse(JSON.stringify({ useCases: store.useCases, artifacts: store.artifacts, risks: store.risks }));

    await backToDescribe(page);
    await page.getByLabel("What will the system do?").fill("Edited: recommends credit-limit increases; a human decides every one.");
    await walkToReview(page);
    const sentBeforeSubmit = store.sent.length;
    await page.getByRole("button", { name: "Submit for human review" }).click();

    const refusal = page.getByRole("main").getByRole("alert").filter({ hasText: "This retry was not sent" });
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText("the description changed after the use case went to its reviewers");
    await expect(refusal.getByRole("button", { name: "Start over as a new use case" })).toBeVisible();
    expect(store.sent.slice(sentBeforeSubmit)).toEqual([]);
    expect({ useCases: store.useCases, artifacts: store.artifacts, risks: store.risks }).toEqual(before);
    await expectNoAxeViolations(page, "Review (retry refused, under review)");
  });

  test("an edit the gateway cannot apply refuses the retry with nothing sent — all-old — and starting over is explicit", async ({ page }) => {
    const store = await mockGateway(page);
    await failFirstAttempt(page, store);
    const before = JSON.parse(JSON.stringify({ useCases: store.useCases, artifacts: store.artifacts, risks: store.risks }));
    const mark = store.sent.length;

    await backToDescribe(page);
    await page.getByLabel("Use-case name").fill("Renamed credit assistant");
    await walkToReview(page);
    const sentBeforeSubmit = store.sent.length;
    await page.getByRole("button", { name: "Submit for human review" }).click();

    const refusal = page.getByRole("main").getByRole("alert").filter({ hasText: "This retry was not sent" });
    await expect(refusal).toBeVisible();
    await expect(refusal).toContainText("the use-case name changed");
    await expect(refusal.getByRole("link", { name: "open the existing use case" })).toHaveAttribute("href", `/ui/admin/governance/use-cases/${USE_CASE}`);
    // nothing at all left the page for this retry, and the written records are untouched;
    // the classification did not change, so the suggestions were not drafted again (AER-051)
    expect(store.sent.slice(sentBeforeSubmit)).toEqual([]);
    expect(store.sent.slice(mark).map((item) => item.path)).toEqual([]);
    expect({ useCases: store.useCases, artifacts: store.artifacts, risks: store.risks }).toEqual(before);
    await expectNoAxeViolations(page, "Review (retry refused)");

    // starting over is the proposer's explicit choice: a NEW use case from the current inputs
    const sentBeforeStartOver = store.sent.length;
    await refusal.getByRole("button", { name: "Start over as a new use case" }).click();
    await expect(refusal).toHaveCount(0);
    // …which WITHDRAWS the earlier record first, so its pending sign-off cannot
    // be approved with only part of its risk set
    expect(store.sent.slice(sentBeforeStartOver).map((item) => `${item.method} ${item.path}`)).toEqual([
      `POST /v1/workflows/instances/instance-${USE_CASE}/abort`,
    ]);
    expect(store.useCases.find((u) => u.id === USE_CASE)?.status).toBe("rejected");
    await page.getByRole("button", { name: "Submit for human review" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Submitted for human review." })).toBeVisible();
    expect(store.useCases.map((u) => [u.id, u.name])).toEqual([
      [USE_CASE, "Credit-limit-increase assistant"],
      [USE_CASE_2, "Renamed credit assistant"],
    ]);
    expect(store.risks.filter((r) => r.useCaseId === USE_CASE_2).map((r) => r.title)).toEqual([BIAS_TITLE, INJECTION_TITLE]);
    await expect(page.getByRole("link", { name: "Open the use-case workspace" })).toHaveAttribute("href", `/ui/admin/governance/use-cases/${USE_CASE_2}`);
  });
});
