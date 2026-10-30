/**
 * ADR-0222 (P13(a)) — the Fairness testing screen, against a mocked gateway.
 *
 *  - off by default: only the settings card and an empty state show, and turning it on is a PUT to the fairness
 *    settings (the gateway decides the step-up; the harness answers it here);
 *  - an upload sends only the chosen columns' names and the file, and the protected attributes the admin ticked;
 *  - a failing result reads as failed, names each breach, and says it holds the model card; axe finds nothing;
 *  - deleting a dataset's rows goes through a confirmation that names the dataset.
 */
import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import { installBuilderMock } from "./builder-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const CARD = "c2220000-0000-4000-8000-000000000001";
const DATASET = "d2220000-0000-4000-8000-000000000001";
const RUN = "e2220000-0000-4000-8000-000000000001";

const LIMITS = {
  maxCsvBytes: 5 * 1024 * 1024,
  maxRows: 100_000,
  maxAttributes: 5,
  maxGroupsPerAttribute: 50,
  maxCellChars: 200,
  minGroupSize: { min: 1, max: 10_000, default: 30 },
  retentionDays: { min: 1, max: 365, default: 30 },
};
const DEFAULT_THRESHOLDS = [
  { metric: "demographic_parity_difference", limit: 0.1, action: "fail" },
  { metric: "disparate_impact_ratio", limit: 0.8, action: "fail" },
  { metric: "equal_opportunity_difference", limit: 0.1, action: "fail" },
  { metric: "equalized_odds_difference", limit: 0.1, action: "fail" },
];

const dataset = {
  id: DATASET,
  name: "Credit applications Q3",
  description: null,
  labelColumn: "outcome",
  predictionColumn: "predicted",
  favourableLabel: "1",
  protectedAttributes: ["sex"],
  rowCount: 240,
  csvBytes: 4096,
  csvSha256: "a".repeat(64),
  expiresAt: "2026-11-29T10:00:00.000Z",
  purgedAt: null,
  purgeReason: null,
  rowsStored: true,
  createdAt: "2026-10-30T10:00:00.000Z",
};

const failingRun = {
  id: RUN,
  cardId: CARD,
  datasetId: DATASET,
  datasetSha256: "a".repeat(64),
  minGroupSize: 30,
  outcome: "fail",
  blocks: true,
  createdAt: "2026-10-30T10:05:00.000Z",
  result: {
    rowCount: 240,
    attributes: [
      {
        attribute: "sex",
        groups: [
          { group: "female", n: 118, labelPositives: 50, predictedPositives: 49, selectionRate: 0.415, truePositiveRate: 0.78, falsePositiveRate: 0.2, included: true },
          { group: "male", n: 122, labelPositives: 66, predictedPositives: 65, selectionRate: 0.533, truePositiveRate: 0.88, falsePositiveRate: 0.2, included: true },
        ],
        metrics: {
          demographic_parity_difference: { value: 0.121 },
          disparate_impact_ratio: { value: 0.777 },
          equal_opportunity_difference: { value: 0.101 },
          equalized_odds_difference: { value: 0.101 },
        },
      },
    ],
    evaluations: [
      { attribute: "sex", metric: "demographic_parity_difference", value: 0.121, limit: 0.1, direction: "max", action: "fail", status: "breach" },
      { attribute: "sex", metric: "disparate_impact_ratio", value: 0.777, limit: 0.8, direction: "min", action: "fail", status: "breach" },
      { attribute: "sex", metric: "equal_opportunity_difference", value: 0.101, limit: 0.1, direction: "max", action: "fail", status: "breach" },
      { attribute: "sex", metric: "equalized_odds_difference", value: 0.101, limit: 0.1, direction: "max", action: "flag", status: "breach" },
    ],
  },
};

interface State {
  enabled: boolean;
  datasets: Json[];
  runs: Json[];
  calls: Array<{ method: string; path: string; body: Json }>;
}

async function open(page: Page, init: Partial<State> = {}, query = ""): Promise<State> {
  const st: State = { enabled: false, datasets: [], runs: [], calls: [], ...init };
  await installBuilderMock(page, { isAdmin: true });
  await page.route("**/v1/mrm/**", async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    st.calls.push({ method: req.method(), path: p, body });
    if (p === "/v1/mrm/cards") return json(route, { cards: [{ id: CARD, intendedUse: "Credit pre-screening", subjectName: "underwriting-assistant" }], enforced: true });
    if (p === "/v1/mrm/fairness" && req.method() === "GET") {
      return json(route, {
        settings: { enabled: st.enabled, blockOnFail: true, datasetRetentionDays: 30, limits: LIMITS, defaultThresholds: DEFAULT_THRESHOLDS },
        datasets: st.datasets,
        runs: st.runs,
        note: "The metrics are computed on the predictions in the uploaded file; regulAIt does not run the model against the dataset.",
      });
    }
    if (p === "/v1/mrm/fairness/settings" && req.method() === "PUT") {
      if (typeof body?.enabled === "boolean") st.enabled = body.enabled;
      return json(route, { enabled: st.enabled, blockOnFail: true, datasetRetentionDays: 30, limits: LIMITS, defaultThresholds: DEFAULT_THRESHOLDS });
    }
    if (p === "/v1/mrm/fairness/datasets" && req.method() === "POST") {
      const d = { ...dataset, id: "d2220000-0000-4000-8000-000000000002", name: body.name, protectedAttributes: body.protectedAttributes };
      st.datasets = [d, ...st.datasets];
      return json(route, { dataset: d }, 201);
    }
    if (p.startsWith("/v1/mrm/fairness/datasets/") && req.method() === "DELETE") {
      st.datasets = st.datasets.map((d) => (p.endsWith(d.id) ? { ...d, rowsStored: false, purgeReason: "deleted", purgedAt: "2026-10-30T11:00:00.000Z" } : d));
      return json(route, { dataset: st.datasets.find((d) => p.endsWith(d.id)) });
    }
    if (p === `/v1/mrm/fairness/runs/${RUN}`) return json(route, { run: failingRun, note: "" });
    return route.fallback();
  });
  await page.goto(`/ui/admin/model-risk/fairness${query}`);
  await expect(page.getByRole("heading", { name: "Fairness testing", level: 1 })).toBeVisible();
  return st;
}

test("off by default: only the settings show, and turning it on writes the setting", async ({ page }) => {
  const st = await open(page);
  await expect(page.getByText("Fairness testing is off")).toBeVisible();
  await expect(page.getByText("Upload an evaluation dataset")).toHaveCount(0);
  await page.getByLabel("Fairness testing", { exact: true }).selectOption("on");
  await expect(page.getByText("Upload an evaluation dataset")).toBeVisible();
  expect(st.calls.filter((c) => c.method === "PUT").map((c) => c.body)).toEqual([{ enabled: true }]);
});

test("an upload sends the chosen columns and the ticked protected attributes", async ({ page }) => {
  const st = await open(page, { enabled: true });
  const csv = "applicant_ref,sex,age_band,outcome,predicted\nA-1,female,18-30,1,1\nA-2,male,31-50,0,0\n";
  await page.getByLabel("Evaluation dataset file").setInputFiles({ name: "credit.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
  await page.getByLabel("True outcome column").selectOption("outcome");
  await page.getByLabel("Model prediction column").selectOption("predicted");
  await page.getByRole("checkbox", { name: "sex" }).check();
  await page.getByRole("button", { name: "Upload dataset" }).click();
  await expect(page.getByText("Dataset uploaded")).toBeVisible();
  const post = st.calls.find((c) => c.method === "POST" && c.path === "/v1/mrm/fairness/datasets")!;
  expect(post.body).toMatchObject({ name: "credit", labelColumn: "outcome", predictionColumn: "predicted", favourableLabel: "1", protectedAttributes: ["sex"] });
  expect(post.body.csv).toBe(csv);
});

test("a failing result says it failed, names each check, says it holds the card, and passes axe", async ({ page }) => {
  await open(page, { enabled: true, datasets: [dataset], runs: [failingRun] }, `?run=${RUN}`);
  const detail = page.getByTestId("fairness-run-detail");
  await expect(detail.getByText("Failed", { exact: true })).toBeVisible();
  await expect(detail).toContainText("holds the model card's sign-off and use");
  await expect(detail).toContainText("Disparate impact ratio");
  await expect(detail).toContainText("at least 0.8");
  await expect(detail).toContainText("flag only");
  await expect(detail.getByRole("cell", { name: "female" })).toBeVisible();
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const serious = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
});

test("deleting a dataset's rows asks first, naming the dataset", async ({ page }) => {
  const st = await open(page, { enabled: true, datasets: [dataset] });
  await page.getByRole("button", { name: `Delete rows of ${dataset.name}` }).click();
  const dialog = page.getByRole("dialog", { name: `Delete the rows of ${dataset.name}?` });
  await expect(dialog).toContainText("fingerprint");
  await dialog.getByRole("button", { name: "Delete rows" }).click();
  await expect(page.getByText("Rows deleted", { exact: true })).toBeVisible();
  expect(st.calls.some((c) => c.method === "DELETE" && c.path === `/v1/mrm/fairness/datasets/${DATASET}`)).toBe(true);
});
