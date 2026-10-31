/**
 * ADR-0220 — the trained-detectors panel on the Guardrails page (against a
 * mocked gateway): the requirements are shown in the form, a refusal is shown
 * inline, and a relaxing save goes through step-up and is resent once
 * (`e2e/step-up-harness.ts`).
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const SCORER = { id: "22222222-2222-4222-8222-222222222222", name: "detectors", enabled: true, scorerKinds: ["guardrail_prompt_injection"] };
const DETECTORS = [
  { kind: "pii", label: "PII recogniser", summary: "A trained recogniser for personal data.", reportsAs: "pii", phases: ["input", "output"], scorerKind: "guardrail_pii" },
  { kind: "prompt_injection", label: "Prompt-injection classifier", summary: "A trained classifier for attempts to override instructions.", reportsAs: "prompt_injection", phases: ["input"], scorerKind: "guardrail_prompt_injection" },
  { kind: "harm", label: "Harm classifier", summary: "A trained classifier for toxic content.", reportsAs: "toxicity", phases: ["input", "output"], scorerKind: "guardrail_harm" },
].map((d) => ({ ...d, enabled: d.kind === "prompt_injection", scorerId: d.kind === "prompt_injection" ? SCORER.id : null, scorerName: d.kind === "prompt_injection" ? SCORER.name : null, mode: "block", threshold: 0.5, onFailure: "block", timeoutMs: 2000, updatedAt: null }));

async function mockApi(page: Page, put: (route: Route) => Promise<void>) {
  const me = { userId: "u-admin", isAdmin: true, user: { id: "u-admin", email: "avery@example.test", displayName: "Avery Admin" } };
  await page.route("**/*", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { ...me, via: "session", mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, me);
    if (p === "/v1/agents") return json(route, { agents: [] });
    if (p === "/v1/connectors") return json(route, { connectors: [] });
    if (p === "/v1/projects") return json(route, { projects: [] });
    if (p === "/v1/guardrails/detectors") return json(route, { detectors: [], shippedDefaults: {}, note: "" });
    if (p === "/v1/guardrails/config") return json(route, { org: null, orgModes: {}, shippedDefaults: {}, overrides: [] });
    if (p.startsWith("/v1/guardrails/violations")) return json(route, { violations: [], totals: {}, note: "" });
    if (p === "/v1/guardrails/trained-detectors") return json(route, { detectors: DETECTORS, scorers: [SCORER] });
    if (p.startsWith("/v1/guardrails/trained-detectors/") && req.method() === "PUT") return put(route);
    return json(route, {});
  });
}

test.describe("ADR-0220: trained detectors on the Guardrails page", () => {
  test("shows each detector and what turning one on needs", async ({ page }) => {
    await mockApi(page, (route) => json(route, {}));
    await page.goto("/ui/admin/guardrails");
    const card = page.locator("section, div").filter({ has: page.getByText("Trained detectors", { exact: true }) }).first();
    await expect(card.getByText("PII recogniser")).toBeVisible();
    await page.getByRole("button", { name: "Edit PII recogniser" }).click();
    const form = page.getByRole("form", { name: "Edit PII recogniser" });
    await expect(form.getByText("guardrail_pii")).toBeVisible();
    await expect(form.getByLabel("Scoring service")).toContainText("none serves this detector yet");
  });

  test("a refusal is shown inline", async ({ page }) => {
    await mockApi(page, (route) => json(route, { error: "external_scorer_kind_mismatch", detail: "scorer 'detectors' does not claim 'guardrail_pii'" }, 422));
    await page.goto("/ui/admin/guardrails");
    await page.getByRole("button", { name: "Edit PII recogniser" }).click();
    const form = page.getByRole("form", { name: "Edit PII recogniser" });
    await form.getByRole("button", { name: "Save" }).click();
    await expect(form.getByRole("alert")).toContainText("does not claim");
  });

  test("falling back to the rule-based result asks to confirm it's you and resends the same PUT once", async ({ page }) => {
    await mockApi(page, (route) => json(route, { ...DETECTORS[1], onFailure: "heuristic" }));
    const su = await requireStepUpOn(page, {
      method: "PUT",
      path: "/v1/guardrails/trained-detectors/prompt_injection",
      kind: "settings_relax",
      facts: () => ({ values: { "trainedDetectors.prompt_injection.onFailure": "heuristic" } }),
    });
    await page.goto("/ui/admin/guardrails");
    await page.getByRole("button", { name: "Edit Prompt-injection classifier" }).click();
    const form = page.getByRole("form", { name: "Edit Prompt-injection classifier" });
    await form.getByLabel("If the service fails", { exact: true }).selectOption("heuristic");
    await form.getByRole("button", { name: "Save" }).click();
    await confirmStepUp(page);
    await su.expectResentOnce();
    expect(su.attempts[1]!.body).toMatchObject({ enabled: true, onFailure: "heuristic", scorerId: SCORER.id });
  });
});
