/**
 * ADR-0175 (A1) — the pack scorecard shows COVERAGE beside the pass rate, every
 * /v1 and /auth call answered by an in-test mock.
 *
 * The fixture is the shape of `nist-ai-rmf` v3 evaluated on a quiet deployment:
 * 31 mapped controls, 25 checked by a ledger collector (18 met their threshold,
 * 7 did not), 6 attestation-only. The page must say 25 / 31 covered and
 * 18 / 25 passing, and a scorecard with nothing evidence-backed must read
 * "unknown", never 0% or 100%.
 */
import { expect, test, type Page, type Route } from "@playwright/test";

const PACK = "d1111111-1111-4111-8111-111111111111";
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const pack = {
  id: PACK,
  framework: "nist-ai-rmf",
  version: 3,
  title: "NIST AI RMF 1.0 — GOVERN / MAP / MEASURE / MANAGE (control mapping) — v3 corrects subcategory IDs and widens coverage",
  description: null,
  provenance: { source: "NIST AI RMF 1.0" },
  cascadeTag: null,
  status: "active",
  controlCount: 31,
  activatedAt: "2026-10-04T09:00:00Z",
  retiredAt: null,
};

function scorecard(totals: { satisfied: number; unsatisfied: number; attested: number; attestationRequired: number; unaddressed: number }) {
  const controls = totals.satisfied + totals.unsatisfied + totals.attested + totals.attestationRequired + totals.unaddressed;
  return {
    framework: "nist-ai-rmf",
    packVersion: 3,
    packTitle: pack.title,
    cascadeTag: null,
    scope: { kind: "org", id: null, projectIds: null },
    period: { period: "current_quarter", label: "2026 Q4", start: "2026-10-01T00:00:00Z", end: "2027-01-01T00:00:00Z" },
    generatedAt: "2026-10-04T10:00:00Z",
    totals: { controls, ...totals, declaredEnforced: 2 },
    controls: [
      { controlRef: "nist-ai-rmf:MANAGE-2.4", title: "Mechanisms are in place to supersede, disengage or deactivate an AI system", coverage: "enforced", collector: "audit_decisions", status: "satisfied", evidenceCount: 3, minEvidenceCount: 1, attestationRequired: false, note: "3 evidence record(s)" },
      { controlRef: "nist-ai-rmf:GOVERN-2.3", title: "Executive leadership takes responsibility for AI risk decisions", coverage: "unaddressed", collector: "none", status: "attestation_required", evidenceCount: null, minEvidenceCount: 1, attestationRequired: true, note: "ATTESTATION REQUIRED" },
    ],
    statement: "A coverage count, NOT a compliance verdict.",
    disclaimer: "This is a control-mapping report, not a compliance certification.",
    updatePolicy: "A pack is rows, not a build artifact.",
  };
}

async function mockApi(page: Page, totals: Parameters<typeof scorecard>[0]) {
  await page.route("**/*", async (route) => {
    const p = new URL(route.request().url()).pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me") return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/compliance/packs") return json(route, { packs: [pack], updatePolicy: "A pack is rows.", disclaimer: "Not a certification." });
    if (p === `/v1/compliance/packs/${PACK}/evaluate`) return json(route, { scorecard: scorecard(totals) });
    return json(route, {});
  });
}

test("the scorecard shows coverage (evidence-backed ÷ mapped) beside passing (passing ÷ evidence-backed)", async ({ page }) => {
  await mockApi(page, { satisfied: 18, unsatisfied: 7, attested: 0, attestationRequired: 6, unaddressed: 0 });
  await page.goto("/ui/admin/compliance-packs");
  await page.getByRole("button", { name: "Evaluate" }).click();
  const ratios = page.getByTestId("pack-ratios");
  await expect(ratios).toContainText("25 / 31");
  await expect(ratios).toContainText("Coverage 80%");
  await expect(ratios).toContainText("18 / 25");
  await expect(ratios).toContainText("Passing 72%");
  // the existing counts are still there beside the ratios
  await expect(page.getByText("Evidenced from the ledgers")).toBeVisible();
  await expect(page.getByText("nist-ai-rmf:MANAGE-2.4")).toBeVisible();
});

test("with nothing evidence-backed, passing reads unknown — never 0% or 100%", async ({ page }) => {
  await mockApi(page, { satisfied: 0, unsatisfied: 0, attested: 1, attestationRequired: 5, unaddressed: 0 });
  await page.goto("/ui/admin/compliance-packs");
  await page.getByRole("button", { name: "Evaluate" }).click();
  const ratios = page.getByTestId("pack-ratios");
  await expect(ratios).toContainText("0 / 6");
  await expect(ratios).toContainText("Coverage 0%");
  await expect(ratios).toContainText("Passing unknown");
  await expect(ratios).not.toContainText("Passing 0%");
  await expect(ratios).not.toContainText("Passing 100%");
});
