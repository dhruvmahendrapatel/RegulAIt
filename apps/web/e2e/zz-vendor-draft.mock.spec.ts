/**
 * ADR-0213 — drafted vendor questionnaire answers, against a mocked gateway
 * that answers with the live route shapes.
 *
 * Pinned: drafting only fills the questionnaire text (no artifact is
 * submitted); each drafted section carries its source line; "drafts off" and
 * "no model connection" are refused inline with a next step, never only in a toast.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const U = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-0000000000e6`;
const T = "2026-10-30T12:00:00.000Z";
const ME = U(99);
const VID = U(1);
const IID = U(2);

const TEMPLATE = "# Vendor AI assessment questionnaire\n\n## 1. What AI the vendor runs\nWhich models?\n";
const VENDOR = { id: VID, name: "Acme AI", description: "Summaries", category: "ai_feature_vendor", ownerUserId: ME, linkedCustomProviderIds: [], linkedAgentProviders: [], packAttestations: [], status: "under_assessment", workflowInstanceId: IID, decidedAt: null, retiredReason: null, createdAt: T };
const DETAIL = {
  vendor: VENDOR,
  instance: { id: IID, status: "blocked_on_artifact", currentStageId: "questionnaire", stages: [{ id: "questionnaire", type: "artifact_generation" }] },
  questionnaire: null,
  questionnaireTemplate: TEMPLATE,
  attestations: [],
  packChecklist: null,
  disclaimer: "",
};
const DRAFTED = "## 1. What AI the vendor runs\n> Drafted from records — from: Vendor record. Check it against the vendor's own answer before submitting.\n\nFrom our vendor record: Summaries";
const DRAFT = (model: Json) => ({
  sections: [{ id: "ai_systems", heading: "1. What AI the vendor runs", text: "From our vendor record: Summaries", source: "rules", cites: [{ id: "vendor-record", kind: "vendor_record", label: "Vendor record" }] }],
  sources: [{ id: "vendor-record", kind: "vendor_record", label: "Vendor record" }],
  model,
  draft: DRAFTED,
  submitted: false,
  disclaimer: "Drafts only.",
});

async function mockApi(page: Page, draft: (body: Json) => { status: number; body: unknown }) {
  const calls: Array<{ method: string; path: string; body: Json }> = [];
  await page.route("**/*", async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    if (req.resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.push({ method: req.method(), path: p, body });
    if (p === "/auth/me" || p === "/v1/me") {
      return json(route, { userId: ME, isAdmin: true, via: "session", user: { id: ME, email: "ada@example.test", username: null, displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false, usernameSelfService: true });
    }
    if (req.method() === "GET" && p === "/v1/vendors") return json(route, { vendors: [VENDOR], disclaimer: "" });
    if (req.method() === "GET" && p === `/v1/vendors/${VID}`) return json(route, DETAIL);
    if (req.method() === "POST" && p === `/v1/vendors/${VID}/questionnaire/draft`) {
      const out = draft(body);
      return json(route, out.body, out.status);
    }
    return json(route, {});
  });
  return calls;
}

async function openQuestionnaire(page: Page) {
  await page.goto(`/ui/admin/vendors?vendorId=${VID}`);
  await expect(page.getByTestId("vendor-draft-panel")).toBeVisible();
}

test.describe("ADR-0213 vendor questionnaire drafts", () => {
  test("drafts fill the questionnaire with source labels and submit nothing", async ({ page }) => {
    const calls = await mockApi(page, () => ({ status: 200, body: DRAFT({ status: "not_requested" }) }));
    await openQuestionnaire(page);
    await page.getByRole("button", { name: "Draft answers into the questionnaire" }).click();
    await expect(page.getByTestId("vendor-draft-result")).toContainText("1 of 6 sections drafted");
    await expect(page.locator("textarea").last()).toHaveValue(DRAFTED);
    expect(calls.filter((c) => c.path.endsWith("/questionnaire/draft")).map((c) => c.body)).toEqual([{ useModel: false, supplierDocuments: [] }]);
    // nothing was submitted on the person's behalf
    expect(calls.filter((c) => c.method === "POST" && c.path.includes("/artifacts"))).toEqual([]);
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/attestations"))).toEqual([]);
  });

  test("drafts that are off are refused inline with the next step", async ({ page }) => {
    await mockApi(page, () => ({ status: 409, body: { error: "vendor_draft_disabled", detail: "off" } }));
    await openQuestionnaire(page);
    await page.getByRole("button", { name: "Draft answers into the questionnaire" }).click();
    const notice = page.getByTestId("refusal-guidance");
    await expect(notice).toHaveAttribute("data-refusal", "vendor_draft_disabled");
    await expect(notice.getByRole("link")).toHaveAttribute("href", /\/admin\/organization$/);
  });

  test("no model connection is refused inline, and the record-based draft still fills the text", async ({ page }) => {
    const calls = await mockApi(page, () => ({ status: 200, body: DRAFT({ status: "refused", reason: "no model connection" }) }));
    await openQuestionnaire(page);
    await page.getByLabel("Draft with").selectOption("model");
    await page.getByLabel("Supplier document (pasted text)").fill("We use one subprocessor.");
    await page.getByRole("button", { name: "Draft answers into the questionnaire" }).click();
    const notice = page.getByTestId("refusal-guidance");
    await expect(notice).toHaveAttribute("data-refusal", "vendor_draft_no_model");
    await expect(notice.getByRole("link")).toHaveAttribute("href", /\/admin\/model-policy$/);
    await expect(page.locator("textarea").last()).toHaveValue(DRAFTED);
    expect(calls.filter((c) => c.path.endsWith("/questionnaire/draft")).map((c) => c.body)).toEqual([
      { useModel: true, supplierDocuments: [{ name: "Supplier document", text: "We use one subprocessor." }] },
    ]);
  });
});
