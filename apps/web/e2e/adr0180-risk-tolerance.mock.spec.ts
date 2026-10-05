/**
 * ADR-0180 §6 (A10) — risk tolerance and time-boxed acceptance on the Risks
 * page, against a mocked gateway (the *.mock.spec.ts harness):
 *
 *  - the risk detail shows the residual level against the tolerance (and its
 *    source), "above tolerance" when nothing valid covers it, and the
 *    acceptance history (who, when, expires in, compensating controls,
 *    superseded/expired);
 *  - the accept form explains the 6/12-month limit in plain words, caps the
 *    date picker at the band's maximum, and posts to the new acceptances
 *    route with the response type, rationale, controls and expiry;
 *  - a caller who may not accept sees why instead of a form;
 *  - the admin tolerance editor reads the strict default and saves the whole
 *    set through PUT /v1/risk-tolerances;
 *  - axe (WCAG 2.x A/AA) in light and dark.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const RISK_ID = "11111111-1111-4111-8111-111111111111";
const DAY = 86_400_000;
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString();
const MAX = iso(182);

const risk = {
  id: RISK_ID,
  title: "Prompt injection steers the claims assistant",
  description: "Adversarial documents redirect the assistant.",
  category: "prompt_injection",
  ownerUserId: "u-owner",
  ownerName: "Olive Owner",
  projectId: null,
  agentId: null,
  useCaseId: "22222222-2222-4222-8222-222222222222",
  status: "open",
  likelihood: "high",
  impact: "high",
  mitigation: "Injection detection at block.",
  acceptedByUserId: null,
  acceptedAt: null,
  acceptanceNote: null,
  createdAt: iso(-30),
  controls: [],
};

function history(canAccept: boolean, refusal: string | null = null) {
  return {
    riskId: RISK_ID,
    position: {
      riskId: RISK_ID,
      band: "high",
      tolerance: { band: "medium", source: "default" },
      acceptance: null,
      aboveTolerance: true,
      maxAcceptanceMonths: 6,
      maxExpiresAt: MAX,
    },
    canAccept,
    acceptRefusal: refusal,
    acceptances: [
      {
        id: "a2",
        state: "expired",
        responseType: "transfer",
        residualBand: "high",
        acceptedByUserId: "u-acc",
        acceptedByName: "Ari Acceptor",
        acceptedAt: iso(-200),
        expiresAt: iso(-18),
        rationale: "Cyber insurance covers the residual exposure.",
        compensatingControls: [{ controlRef: "eu-ai-act:art-14-human-oversight", description: "A claims handler reviews every payout." }],
        supersededAt: null,
        expiredAt: iso(-18),
        revokedAt: null,
      },
      {
        id: "a1",
        state: "superseded",
        responseType: "accept",
        residualBand: "high",
        acceptedByUserId: "u-acc",
        acceptedByName: "Ari Acceptor",
        acceptedAt: iso(-260),
        expiresAt: iso(-80),
        rationale: "Accepted for the pilot.",
        compensatingControls: [],
        supersededAt: iso(-200),
        expiredAt: null,
        revokedAt: null,
      },
    ],
  };
}

const tolerances = {
  source: "default",
  strictDefault: { maxBand: "medium" },
  tolerances: [],
  effective: {
    categories: { prompt_injection: { maxBand: "medium", source: "default" }, hallucination: { maxBand: "medium", source: "default" } },
    tiers: { high: { maxBand: "medium", source: "default" } },
  },
  bands: ["none", "low", "medium", "high", "critical"],
};

interface Captured {
  acceptancePosts: Array<Record<string, unknown>>;
  tolerancePuts: unknown[];
  legacyPosts: number;
}

async function mockApi(page: Page, opts: { canAccept?: boolean; refusal?: string | null } = {}): Promise<Captured> {
  const cap: Captured = { acceptancePosts: [], tolerancePuts: [], legacyPosts: 0 };
  const me = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    const method = req.method();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/risks/library") return json(route, { library: [], disclaimer: "d" });
    if (p === "/v1/risks/scenarios") return json(route, { scenarios: [], note: "" });
    if (p === "/v1/risks") return json(route, { risks: [risk], disclaimer: "d" });
    if (p === `/v1/risks/${RISK_ID}/acceptances` && method === "POST") {
      cap.acceptancePosts.push(req.postDataJSON() as Record<string, unknown>);
      return json(route, { acceptance: { id: "a3" } }, 201);
    }
    if (p === `/v1/risks/${RISK_ID}/acceptances`) return json(route, history(opts.canAccept ?? true, opts.refusal ?? null));
    if (p === `/v1/risks/${RISK_ID}/accept`) {
      cap.legacyPosts += 1;
      return json(route, {});
    }
    if (p === `/v1/risks/${RISK_ID}`) {
      return json(route, {
        risk,
        declared: { likelihood: "high", impact: "high", residual: null, status: "open", mitigation: risk.mitigation, acceptance: null, note: "n" },
        evidence: { window: { start: iso(-90), end: iso(0), days: 90 }, scope: { projectId: null, agentId: null }, entries: [], computedAt: iso(0), note: "live", disclaimer: "d" },
      });
    }
    if (p === "/v1/risk-tolerances" && method === "PUT") {
      cap.tolerancePuts.push(req.postDataJSON());
      return json(route, tolerances);
    }
    if (p === "/v1/risk-tolerances") return json(route, tolerances);
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/projects") return json(route, { projects: [] });
    return json(route, {});
  });
  return cap;
}

const THEMES = ["light", "dark"] as const;
async function expectAxeClean(page: Page, label: string) {
  for (const theme of THEMES) {
    await page.evaluate(async (next) => {
      document.documentElement.dataset.theme = next;
      localStorage.setItem("regulait.theme", next);
      await Promise.race([
        Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
    }, theme);
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
    const summary = results.violations.map((v) => `${v.id} (${v.impact}) — ${v.help}\n    ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join("\n    ")}`);
    expect(summary, `axe on "${label}" (${theme})`).toEqual([]);
  }
}

test.describe("ADR-0180 §6: risk tolerance and time-boxed acceptance", () => {
  test("shows residual against tolerance and the history, and records a capped acceptance", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto(`/ui/admin/risks?riskId=${RISK_ID}`);

    const position = page.getByTestId("risk-position");
    await expect(position).toContainText("Residual level: high");
    await expect(position).toContainText("up to medium");
    await expect(position).toContainText("strict default");
    await expect(position).toContainText("Above tolerance: needs a valid acceptance");

    const historyCard = page.locator("section[data-rg-card]").filter({ hasText: "Acceptance history" }).first();
    await expect(historyCard).toContainText("Ari Acceptor");
    await expect(historyCard).toContainText("expired");
    await expect(historyCard).toContainText("superseded");
    await expect(historyCard).toContainText("eu-ai-act:art-14-human-oversight");
    await expect(historyCard).toContainText("A claims handler reviews every payout.");

    const limit = page.getByTestId("expiry-limit");
    await expect(limit).toContainText("Because this risk's residual level is high, an acceptance can last at most 6 months");
    await expect(limit).toContainText(`until ${MAX.slice(0, 10)}`);
    await expect(limit).toContainText("the risk reopens");
    const date = page.getByLabel("Expires on (optional)");
    await expect(date).toHaveAttribute("max", MAX.slice(0, 10));

    await expectAxeClean(page, "risk detail with acceptance history");

    const form = page.getByRole("form", { name: "Accept residual risk" });
    await form.getByLabel("Response").selectOption("transfer");
    await form.getByLabel("Why is the remaining risk acceptable? (required, recorded)").fill("Insurance renewed; human review stays in place.");
    await form.getByRole("button", { name: "Add a compensating control" }).click();
    await form.getByLabel("Control 1 reference (optional)").fill("eu-ai-act:art-14-human-oversight");
    await form.getByLabel("Control 1: what it does").fill("A claims handler reviews every payout.");
    const pick = new Date(Date.now() + 60 * DAY).toISOString().slice(0, 10);
    await date.fill(pick);
    await form.getByRole("button", { name: "Record acceptance" }).click();

    await expect.poll(() => cap.acceptancePosts.length).toBe(1);
    expect(cap.acceptancePosts[0]).toMatchObject({
      responseType: "transfer",
      rationale: "Insurance renewed; human review stays in place.",
      compensatingControls: [{ controlRef: "eu-ai-act:art-14-human-oversight", description: "A claims handler reviews every payout." }],
      expiresAt: `${pick}T23:59:59.000Z`,
    });
    expect(cap.legacyPosts).toBe(0);
  });

  test("a date past the band's limit is flagged and cannot be submitted", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto(`/ui/admin/risks?riskId=${RISK_ID}`);
    const form = page.getByRole("form", { name: "Accept residual risk" });
    await form.getByLabel("Why is the remaining risk acceptable? (required, recorded)").fill("Insurance renewed; human review stays in place.");
    const late = new Date(Date.now() + 300 * DAY).toISOString().slice(0, 10);
    await form.getByLabel("Expires on (optional)").fill(late);
    await expect(form).toContainText(`The latest allowed date is ${MAX.slice(0, 10)}.`);
    await expect(form.getByRole("button", { name: "Record acceptance" })).toBeDisabled();
    expect(cap.acceptancePosts).toEqual([]);
  });

  test("a caller who may not accept sees why, not a form", async ({ page }) => {
    await mockApi(page, { canAccept: false, refusal: "proposer_cannot_accept_risk" });
    await page.goto(`/ui/admin/risks?riskId=${RISK_ID}`);
    await expect(page.getByTestId("accept-refusal")).toContainText("someone else must accept it");
    await expect(page.getByRole("form", { name: "Accept residual risk" })).toHaveCount(0);
  });

  test("the admin tolerance editor reads the strict default and saves the whole set", async ({ page }) => {
    const cap = await mockApi(page);
    await page.goto("/ui/admin/risks");
    const card = page.locator("section[data-rg-card]").filter({ hasText: "Risk tolerance (admin)" }).first();
    await expect(card).toContainText("With nothing configured, any residual risk above medium needs a valid, time-limited acceptance");
    await expect(card).toContainText("strict default");
    await expectAxeClean(page, "risk tolerance editor");

    const save = card.getByRole("button", { name: "Save risk tolerances" });
    await expect(save).toBeDisabled();
    await card.getByLabel("Tolerance for category Prompt injection").selectOption("high");
    await card.getByLabel("Tolerance for tier High").selectOption("none");
    await save.click();
    await expect.poll(() => cap.tolerancePuts.length).toBe(1);
    const body = cap.tolerancePuts[0] as { tolerances: Array<Record<string, string>> };
    expect([...body.tolerances].sort((a, b) => a.scopeKey!.localeCompare(b.scopeKey!))).toEqual([
      { scopeKind: "tier", scopeKey: "high", maxBand: "none" },
      { scopeKind: "category", scopeKey: "prompt_injection", maxBand: "high" },
    ]);
  });
});
