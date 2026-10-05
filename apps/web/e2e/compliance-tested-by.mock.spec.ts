/**
 * ADR-0173 batch 2c (E) — the per-control "Tested by" chip on a compliance
 * pack scorecard, against a mocked gateway. The chip counts only evaluators
 * whose completed run PASSED in the period; a control whose evaluators only
 * failed or did not run reads "Tested by 0 of N". Axe in light and dark.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean } from "./prompts-fixtures";

const PACK = "d2222222-2222-4222-8222-222222222222";
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const pack = {
  id: PACK,
  framework: "nist-ai-rmf",
  version: 3,
  title: "NIST AI RMF 1.0 (control mapping) — v3",
  description: null,
  provenance: { source: "NIST AI RMF 1.0" },
  cascadeTag: null,
  status: "active",
  controlCount: 2,
  activatedAt: "2026-10-04T09:00:00Z",
  retiredAt: null,
};

const scorecard = {
  framework: "nist-ai-rmf",
  packVersion: 3,
  packTitle: pack.title,
  cascadeTag: null,
  scope: { kind: "org", id: null, projectIds: null },
  period: { period: "current_quarter", label: "2026 Q4", start: "2026-10-01T00:00:00Z", end: "2027-01-01T00:00:00Z" },
  generatedAt: "2026-10-05T10:00:00Z",
  totals: { controls: 2, satisfied: 1, unsatisfied: 1, attested: 0, attestationRequired: 0, unaddressed: 0, declaredEnforced: 0 },
  controls: [
    { controlRef: "nist-ai-rmf:MEASURE-2.5", title: "Validity and reliability are measured", coverage: "partial", collector: "eval_runs", status: "satisfied", evidenceCount: 4, minEvidenceCount: 1, attestationRequired: false, note: "4 evidence record(s)" },
    { controlRef: "nist-ai-rmf:MEASURE-2.7", title: "AI system security and resilience are evaluated", coverage: "evidenced", collector: "audit_decisions", status: "unsatisfied", evidenceCount: 0, minEvidenceCount: 1, attestationRequired: false, note: "0 evidence record(s)" },
  ],
  statement: "A coverage count, NOT a compliance verdict.",
  disclaimer: "This is a control-mapping report, not a compliance certification.",
  updatePolicy: "A pack is rows.",
};

const testedBy = {
  packId: PACK,
  framework: "nist-ai-rmf",
  period: { start: scorecard.period.start, end: scorecard.period.end },
  controls: {
    "nist-ai-rmf:MEASURE-2.5": [
      { evaluatorId: "scorer:exact", kind: "scorer", name: "exact", status: "passed", runs: 3, passedRuns: 2, lastRunId: null },
      { evaluatorId: "scorer:llm_as_judge", kind: "scorer", name: "llm_as_judge", status: "not_run", runs: 0, passedRuns: 0, lastRunId: null },
    ],
    "nist-ai-rmf:MEASURE-2.7": [
      { evaluatorId: "redteam:jailbreak", kind: "redteam_class", name: "jailbreak", status: "failed", runs: 1, passedRuns: 0, lastRunId: null },
      { evaluatorId: "detector:prompt_injection", kind: "detector", name: "prompt_injection", status: "not_run", runs: 0, passedRuns: 0, lastRunId: null },
    ],
  },
  note: "A control is TESTED only by a completed run that passed in the period.",
};

async function mockApi(page: Page) {
  const asked: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (route.request().resourceType() === "document" || (!p.startsWith("/v1") && !p.startsWith("/auth"))) return route.continue();
    if (p === "/auth/me")
      return json(route, { userId: "ada", isAdmin: true, via: "session", user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" }, mustChangePassword: false, totpEnabled: true, passwordSet: true, mfaSetupRequired: false });
    if (p === "/v1/me") return json(route, { userId: "ada", isAdmin: true, user: { id: "ada", email: "ada@example.test", displayName: "Ada Admin" } });
    if (p === "/v1/compliance/packs") return json(route, { packs: [pack], updatePolicy: "A pack is rows.", disclaimer: "Not a certification." });
    if (p === `/v1/compliance/packs/${PACK}/evaluate`) return json(route, { scorecard });
    if (p === "/v1/evals/catalog/tested-by") {
      asked.push(url.search);
      return json(route, testedBy);
    }
    return json(route, {});
  });
  return asked;
}

test("each control carries a 'Tested by' chip: only a passed run counts, failed and not-run are said as such", async ({ page }) => {
  const asked = await mockApi(page);
  await page.goto("/ui/admin/compliance-packs");
  await page.getByRole("button", { name: "Evaluate" }).click();
  const measured = page.getByTestId("tested-by-nist-ai-rmf:MEASURE-2.5");
  const security = page.getByTestId("tested-by-nist-ai-rmf:MEASURE-2.7");
  await expect(measured).toContainText("Tested by 1 of 2");
  await expect(security).toContainText("Tested by 0 of 2");
  // the chip asks about the scorecard's own pack and period
  expect(asked[0]).toContain(`packId=${PACK}`);
  expect(asked[0]).toContain("from=2026-10-01");
  await security.locator("summary").click();
  await expect(security).toContainText("redteam:jailbreak");
  await expect(security).toContainText("failed");
  await expect(security).toContainText("not run");
  await expect(security).toContainText("no run in the period");
  await expectAxeClean(page, "compliance pack tested-by chips");
});
