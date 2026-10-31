/**
 * ADR-0213 — drafted vendor questionnaire answers, against a mocked gateway
 * that answers with the live route shapes.
 *
 * Pinned: drafting changes nothing in the questionnaire by itself; an answer is
 * accepted per section and carries its source line; typed answers survive a
 * draft and are replaced only by an explicit, labelled click; no artifact or
 * attestation is ever posted; "drafts off" and "no model connection" are
 * refused inline with a next step, never only in a toast.
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

const TEMPLATE = "# Vendor AI assessment questionnaire\n\n## 1. What AI the vendor runs\nWhich models?\n\n## 3. Subprocessors\nWhich subprocessors?\n";
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
const LABEL = "> Drafted from records — from: Vendor record. Check it against the vendor's own answer before submitting.";
const DRAFT = (model: Json) => ({
  sections: [{ id: "ai_systems", heading: "1. What AI the vendor runs", text: "From our vendor record: Summaries", source: "rules", cites: [{ id: "vendor-record", kind: "vendor_record", label: "Vendor record" }] }],
  sources: [{ id: "vendor-record", kind: "vendor_record", label: "Vendor record" }],
  model,
  draft: "unused by the panel",
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

const questionnaire = (page: Page) => page.locator("textarea").last();
const USE_AI = "Use this answer for 1. What AI the vendor runs";

test.describe("ADR-0213 vendor questionnaire drafts", () => {
  test("drafting changes nothing until an answer is used; a used answer carries its source line", async ({ page }) => {
    const calls = await mockApi(page, () => ({ status: 200, body: DRAFT({ status: "not_requested" }) }));
    await openQuestionnaire(page);
    await page.getByRole("button", { name: "Draft answers", exact: true }).click();
    await expect(page.getByTestId("vendor-draft-result")).toContainText("1 of 1 sections drafted");
    await expect(questionnaire(page)).toHaveValue(TEMPLATE);
    await page.getByRole("button", { name: USE_AI }).click();
    const text = await questionnaire(page).inputValue();
    expect(text).toContain(`## 1. What AI the vendor runs\n${LABEL}\n\nFrom our vendor record: Summaries`);
    // the other section is untouched
    expect(text).toContain("## 3. Subprocessors\nWhich subprocessors?");
    expect(calls.filter((c) => c.path.endsWith("/questionnaire/draft")).map((c) => c.body)).toEqual([{ useModel: false, supplierDocuments: [] }]);
    // nothing was submitted or recorded on the person's behalf
    expect(calls.filter((c) => c.method === "POST" && c.path.includes("/artifacts"))).toEqual([]);
    expect(calls.filter((c) => c.method === "POST" && c.path.endsWith("/attestations"))).toEqual([]);
  });

  test("a typed answer survives a draft and is replaced only by its own labelled click", async ({ page }) => {
    await mockApi(page, () => ({ status: 200, body: DRAFT({ status: "not_requested" }) }));
    await openQuestionnaire(page);
    const typed = TEMPLATE.replace("Which models?", "The vendor told us: one hosted model, no training on our data.");
    await questionnaire(page).fill(typed);
    await page.getByRole("button", { name: "Draft answers", exact: true }).click();
    await expect(page.getByTestId("vendor-draft-result")).toBeVisible();
    await expect(questionnaire(page)).toHaveValue(typed);
    // the only drafted section is answered, so there is no bulk fill and the button says it replaces
    await expect(page.getByRole("button", { name: "Use drafts in unanswered sections" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: USE_AI })).toHaveCount(0);
    await page.getByRole("button", { name: "Replace my answer to 1. What AI the vendor runs" }).click();
    await expect(questionnaire(page)).not.toHaveValue(typed);
    expect(await questionnaire(page).inputValue()).toContain(LABEL);
  });

  test("drafts that are off are refused inline with the next step", async ({ page }) => {
    await mockApi(page, () => ({ status: 409, body: { error: "vendor_draft_disabled", detail: "off" } }));
    await openQuestionnaire(page);
    await page.getByRole("button", { name: "Draft answers", exact: true }).click();
    const notice = page.getByTestId("refusal-guidance");
    await expect(notice).toHaveAttribute("data-refusal", "vendor_draft_disabled");
    await expect(notice.getByRole("link")).toHaveAttribute("href", /\/admin\/organization$/);
    await expect(questionnaire(page)).toHaveValue(TEMPLATE);
  });

  test("no model connection is refused inline with its reason, and the record-based draft is still offered", async ({ page }) => {
    const calls = await mockApi(page, () => ({ status: 200, body: DRAFT({ status: "refused", reason: "no model connection" }) }));
    await openQuestionnaire(page);
    await page.getByLabel("Draft with").selectOption("model");
    await page.getByLabel("Supplier document (pasted text)").fill("We use one subprocessor.");
    await page.getByRole("button", { name: "Draft answers", exact: true }).click();
    const notice = page.getByTestId("refusal-guidance");
    await expect(notice).toHaveAttribute("data-refusal", "vendor_draft_no_model");
    await expect(notice.getByRole("link")).toHaveAttribute("href", /\/admin\/model-policy$/);
    await expect(page.getByText("Reason: no model connection")).toBeVisible();
    await expect(page.getByRole("button", { name: USE_AI })).toBeVisible();
    await expect(questionnaire(page)).toHaveValue(TEMPLATE);
    expect(calls.filter((c) => c.path.endsWith("/questionnaire/draft")).map((c) => c.body)).toEqual([
      { useModel: true, supplierDocuments: [{ name: "Supplier document", text: "We use one subprocessor." }] },
    ]);
  });
});
