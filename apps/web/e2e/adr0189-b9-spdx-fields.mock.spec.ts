/**
 * ADR-0189 B9 (OWNER DECISION 13, amendment R51) — the SPDX fields panel on the
 * existing model card, evaluation dataset version and training dataset version
 * pages, against a mocked gateway.
 *
 * What these pin: the banner names exactly the undeclared properties and says
 * the SPDX output is not_producible until they are declared; a value carries
 * its source, who and when; the source is a required choice; the confirmation
 * shows exactly what will be recorded and the PUT carries exactly that; a value
 * the gateway would refuse is refused before sending, and a gateway refusal is
 * announced in a live region; no refusal ever shows the refused value; a
 * withdrawal is confirmed and appears in the history; a non-admin gets no panel
 * and no request. Axe (light and dark) on every state.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { ME, expectAxeClean, installBuilderMock } from "./builder-fixtures";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const CARD = "99999999-5555-4000-8000-000000000b91";
const EVAL_DS = "99999999-5555-4000-8000-000000000b92";
const TRAIN_DS = "99999999-5555-4000-8000-000000000b93";
const OTHER_ADMIN = "11111111-0000-4000-8000-0000000000b9";
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

const DECLARABLE = {
  model_card: ["releaseTime", "downloadLocation", "packageVersion"],
  training_dataset: ["builtTime", "originatedBy", "releaseTime", "downloadLocation", "datasetType"],
  eval_dataset: ["builtTime", "originatedBy", "releaseTime", "downloadLocation", "datasetType"],
} as const;
type Kind = keyof typeof DECLARABLE;
/** the gateway's display names for the three mocked records */
const DISPLAY: Record<Kind, string> = { model_card: "Clause triage · Contract clause triage", eval_dataset: "golden v2", training_dataset: "support-corpus v1" };

interface Row {
  seq: number;
  property: string;
  withdrawn: boolean;
  value: string | string[] | null;
  source: string;
  declaredByUserId: string;
  declaredAt: string;
}

/** the gateway's three routes over an append-only store, as the handler shapes them */
async function installSpdxMock(page: Page, seed: Partial<Record<string, Row[]>> = {}) {
  const store = new Map<string, Row[]>(Object.entries(seed).map(([k, v]) => [k, [...(v ?? [])]]));
  const calls: Array<{ method: string; path: string; body: Json }> = [];
  let seq = 100;
  const refuseNext: Array<{ status: number; body: Json }> = [];
  await page.route(/\/v1\/ai-bom\/spdx-fields\//, (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    let body: Json;
    try {
      body = req.postDataJSON();
    } catch {
      body = undefined;
    }
    calls.push({ method: req.method(), path, body });
    const [, , , , kind, id, property, action] = path.split("/") as [string, string, string, string, Kind, string, string?, string?];
    const key = `${kind}:${id}`;
    const rows = store.get(key) ?? [];
    store.set(key, rows);
    if (req.method() === "GET" && !property) {
      const latest = new Map<string, Row>();
      for (const r of [...rows].sort((a, b) => a.seq - b.seq)) latest.set(r.property, r);
      const current = DECLARABLE[kind].filter((p) => latest.get(p) && !latest.get(p)!.withdrawn).map((p) => latest.get(p)!);
      return json(route, {
        subject: { kind, id, displayName: DISPLAY[kind] },
        declarable: DECLARABLE[kind],
        current,
        undeclared: DECLARABLE[kind].filter((p) => !current.some((c) => c.property === p)),
        history: [...rows].sort((a, b) => b.seq - a.seq),
        historyLimit: 200,
      });
    }
    const refusal = refuseNext.shift();
    if (refusal) return json(route, refusal.body, refusal.status);
    if (req.method() === "PUT") {
      const row: Row = { seq: ++seq, property: property!, withdrawn: false, value: body.value, source: body.source, declaredByUserId: ME, declaredAt: new Date().toISOString() };
      rows.push(row);
      return json(route, { declaration: row });
    }
    if (req.method() === "POST" && action === "withdraw") {
      const last = rows.filter((r) => r.property === property).sort((a, b) => b.seq - a.seq)[0];
      if (!last || last.withdrawn) return json(route, { error: "spdx_field_not_declared" }, 409);
      const row: Row = { seq: ++seq, property: property!, withdrawn: true, value: null, source: "admin_entered", declaredByUserId: ME, declaredAt: new Date().toISOString() };
      rows.push(row);
      return json(route, { declaration: row });
    }
    return json(route, { error: "not_found" }, 404);
  });
  return {
    calls,
    writes: () => calls.filter((c) => c.method !== "GET"),
    refuseNext: (status: number, body: Json) => refuseNext.push({ status, body }),
  };
}

const card = {
  id: CARD,
  agentId: "22222222-0000-4000-8000-000000000001",
  customProviderId: null,
  intendedUse: "Contract clause triage",
  limitations: null,
  dataClaims: {},
  biasFairness: [],
  standardRefs: [],
  pinnedModelVersion: null,
  state: "unsigned",
  daysUntilExpiry: null,
  subjectKind: "agent",
  subjectName: "Clause triage",
  subjectModel: null,
  approvals: [],
  evidence: [],
  completeness: { complete: false, missing: ["sign_off"], bias: { declared: 0, assessed: 0, waived: 0, unevidenced: 0, complete: false, disclaimer: "declared, not measured" } },
  createdAt: iso(600),
};

async function setup(page: Page, opts: { isAdmin?: boolean; seed?: Partial<Record<string, Row[]>> } = {}) {
  await installBuilderMock(page, { isAdmin: opts.isAdmin ?? true });
  await page.route("**/v1/users", (route) =>
    json(route, { users: [{ id: ME, email: "avery@example.test", displayName: "Avery Admin" }, { id: OTHER_ADMIN, email: "blake@example.test", displayName: "Blake Admin" }] }),
  );
  // the model card page
  await page.route("**/v1/mrm/status", (route) =>
    json(route, { enforced: false, warnDays: 30, stalenessRecertEnabled: true, stalenessRecertThreshold: 1, posture: "declared", label: "declared", cards: 1, approved: 0, expiring: 0, expired: 0, pending: 0, unsigned: 1, revoked: 0, note: "" }),
  );
  // ADR-0226: the lists ask with the contract's query string, so match the path, not the whole URL
  await page.route((u) => u.pathname === "/v1/mrm/expiring", (route) => json(route, { warnDays: 30, items: [] }));
  await page.route((u) => u.pathname === "/v1/mrm/cards", (route) => json(route, { cards: [card], enforced: false }));
  await page.route(`**/v1/mrm/cards/${CARD}`, (route) => json(route, { card: { ...card, autofill: null, staleness: null } }));
  // the evaluation dataset page
  const evalRow = { id: EVAL_DS, name: "golden", version: 2, note: null, scorerKind: "contains", scorerConfig: {}, caseCount: 1, runCount: 0, frozen: false, createdAt: iso(90) };
  await page.route("**/v1/evals/scorers", (route) => json(route, { scorers: [{ id: "contains", deterministic: true, modelBacked: false, summary: "Contains.", limits: "Lexical." }], note: "Scorers." }));
  await page.route("**/v1/evals/scoring-semantics", (route) => json(route, { current: 2, versions: [{ version: 2, adr: "ADR-0072", summary: "Current." }], evalRuns: [], stalePinnedBaselines: [], note: "Semantics." }));
  await page.route("**/v1/evals/datasets", (route) => json(route, { datasets: [evalRow], note: "Datasets freeze." }));
  await page.route(`**/v1/evals/datasets/${EVAL_DS}`, (route) => json(route, { dataset: evalRow, cases: [{ id: "c1", input: "What is the status?", expected: "ok", scorerKind: null, tags: [] }], frozen: false }));
  await page.route(/\/v1\/evals\/runs\?/, (route) => json(route, { runs: [] }));
  // the training dataset page
  const trainRow = { id: TRAIN_DS, name: "support-corpus", version: 1, note: null, format: "prompt_completion", rowCount: 1, charCount: 20, checksum: "0".repeat(64), piiVerdict: "clean", piiMode: "block", scanFindings: {}, projectId: null, jobCount: 0, frozen: false, createdAt: iso(120) };
  await page.route("**/v1/llm/backends", (route) => json(route, { enabled: true, approvalThresholdUsd: 0, backends: [], note: "Backends." }));
  await page.route("**/v1/llm/datasets", (route) => json(route, { datasets: [trainRow], note: "Datasets." }));
  await page.route(`**/v1/llm/datasets/${TRAIN_DS}`, (route) => json(route, { dataset: trainRow, rows: [{ id: "r1", idx: 0, input: "hello", output: "hi" }], versions: [trainRow], jobs: [], frozen: false }));
  await page.route(/\/v1\/llm\/jobs\?/, (route) => json(route, { jobs: [] }));
  await page.route("**/v1/llm/artifacts", (route) => json(route, { artifacts: [], note: "Artifacts." }));
  return installSpdxMock(page, opts.seed);
}

const openCard = async (page: Page) => {
  await page.goto("/ui/admin/model-risk");
  await page.getByRole("row").filter({ hasText: "Clause triage" }).getByRole("button", { name: "Open" }).click();
};
const panel = (page: Page) => page.getByTestId("spdx-fields");
const banner = (page: Page) => page.getByTestId("spdx-banner");
const decl = (property: string, value: string | string[], over: Partial<Row> = {}): Row => ({
  seq: 1,
  property,
  withdrawn: false,
  value,
  source: "supplier_declared",
  declaredByUserId: OTHER_ADMIN,
  declaredAt: "2026-10-01T12:00:05.000Z",
  ...over,
});

test.describe("ADR-0189 B9: SPDX fields on a model card", () => {
  test("empty: the banner names all three; set a release time through a confirmation of exactly what is recorded", async ({ page }) => {
    const spdx = await setup(page);
    await openCard(page);
    await expect(panel(page).getByRole("heading", { name: "SPDX fields" })).toBeVisible();
    await expect(panel(page)).toContainText("written to the audit log by the gateway");
    await expect(banner(page)).toHaveAttribute("data-producible", "false");
    await expect(banner(page)).toContainText("SPDX output for this model card is not_producible until these properties are declared: Release time, Download location, Package version.");
    await expect(page.getByTestId("spdx-history")).toContainText("History (0)");
    await expectAxeClean(page, "model card SPDX fields, empty");

    const trigger = panel(page).getByRole("button", { name: "Set release time" });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Set release time" });
    await expect(dialog).toBeVisible();
    // the source is a required choice: nothing is pre-selected
    await expect(dialog.getByRole("radio", { name: /Supplier declared/ })).not.toBeChecked();
    await expect(dialog.getByRole("radio", { name: /Admin entered/ })).not.toBeChecked();
    await expect(dialog).toContainText("UTC, whole seconds: YYYY-MM-DDThh:mm:ssZ");
    await dialog.getByLabel("Release time (UTC)").fill("2026-01-31T09:30:00Z");
    await dialog.getByRole("button", { name: "Review" }).click();
    await expect(dialog.getByTestId("spdx-refusal-text")).toHaveText("Choose where this value comes from: supplier declared or admin entered. Nothing was sent.");
    await dialog.getByRole("radio", { name: /Supplier declared/ }).check();
    await dialog.getByRole("button", { name: "Review" }).click();
    const confirm = dialog.getByTestId("spdx-confirm");
    await expect(confirm).toBeFocused();
    await expect(dialog.getByTestId("spdx-confirm-value")).toHaveText("2026-01-31T09:30:00Z");
    await expect(confirm).toContainText("Release time");
    await expect(confirm).toContainText("Supplier declared");
    await expect(confirm.getByTestId("spdx-subject-name")).toHaveText("Clause triage · Contract clause triage");
    await expect(confirm).toContainText(`model card ${CARD}`);
    await expect(dialog).toContainText("value and its audit record in one transaction");
    await expectAxeClean(page, "model card SPDX confirmation");
    expect(spdx.writes()).toEqual([]);

    await dialog.getByRole("button", { name: "Record value" }).click();
    await expect(dialog).toHaveCount(0);
    expect(spdx.writes()).toEqual([{ method: "PUT", path: `/v1/ai-bom/spdx-fields/model_card/${CARD}/releaseTime`, body: { value: "2026-01-31T09:30:00Z", source: "supplier_declared" } }]);
    await expect(panel(page).getByTestId("spdx-value-releaseTime")).toHaveText("2026-01-31T09:30:00Z");
    await expect(banner(page)).toContainText("until these properties are declared: Download location, Package version.");
    await expect(panel(page).getByRole("button", { name: "Correct release time" })).toBeFocused();
    await expect(page.getByTestId("spdx-history")).toContainText("History (1)");
  });

  test("partial, then complete: the provenance is shown and the banner clears", async ({ page }) => {
    await setup(page, {
      seed: {
        [`model_card:${CARD}`]: [
          decl("releaseTime", "2026-01-31T09:30:00Z", { seq: 1, source: "admin_entered" }),
          decl("downloadLocation", "https://models.example.com", { seq: 2 }),
        ],
      },
    });
    await openCard(page);
    await expect(banner(page)).toContainText("until this property is declared: Package version.");
    const row = panel(page).getByRole("row").filter({ hasText: "Download location" });
    await expect(row).toContainText("https://models.example.com");
    await expect(row).toContainText("Supplier declared");
    await expect(row).toContainText("Blake Admin");
    await expect(row).toContainText("2026-10-01T12:00:05Z");
    await expect(panel(page).getByRole("row").filter({ hasText: "Release time" })).toContainText("Admin entered");
    await expect(panel(page).getByRole("button", { name: "Withdraw package version" })).toBeDisabled();
    await expectAxeClean(page, "model card SPDX fields, partial");

    await panel(page).getByRole("button", { name: "Set package version" }).click();
    const dialog = page.getByRole("dialog", { name: "Set package version" });
    await dialog.getByLabel("Package version").fill("2025-06-01.v3");
    await dialog.getByRole("radio", { name: /Admin entered/ }).check();
    await dialog.getByRole("button", { name: "Review" }).click();
    await dialog.getByRole("button", { name: "Record value" }).click();
    await expect(banner(page)).toHaveAttribute("data-producible", "true");
    await expect(banner(page)).toContainText("Every property SPDX 3.0.1 needs from this model card is declared.");
    await page.getByTestId("spdx-history").locator("summary").click();
    await expect(page.getByTestId("spdx-history").getByRole("row")).toHaveCount(4);
    await expectAxeClean(page, "model card SPDX fields, complete");
  });

  test("refused before sending: a path, plain http and userinfo; the value is never shown back", async ({ page }) => {
    const spdx = await setup(page);
    await openCard(page);
    await panel(page).getByRole("button", { name: "Set download location" }).click();
    const dialog = page.getByRole("dialog", { name: "Set download location" });
    await expect(dialog).toContainText("An https origin only: https://host or https://host:port.");
    await dialog.getByRole("radio", { name: /Supplier declared/ }).check();
    const input = dialog.getByLabel("Download location");
    const refusal = dialog.getByTestId("spdx-refusal");
    const cases: Array<[string, string, string]> = [
      ["https://models.example.com/weights?token=SECRET-TOKEN-1", "download_location_not_origin", "is not an https origin (https://host[:port])"],
      ["http://models.example.com", "download_location_not_https", "plain http is refused"],
      ["https://bob:SECRET-PASS-2@models.example.com", "download_location_credentials", "carries a user name or password"],
    ];
    for (const [value, rule, sentence] of cases) {
      await input.fill(value);
      await dialog.getByRole("button", { name: "Review" }).click();
      await expect(refusal, rule).toContainText(rule);
      await expect(refusal, rule).toContainText(sentence);
      await expect(refusal, rule).toContainText("Nothing was sent.");
      await expect(refusal, rule).not.toContainText("SECRET");
      await expect(refusal, rule).not.toContainText("models.example.com");
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute("aria-invalid", "true");
    }
    await expect(refusal).toHaveAttribute("aria-live", "assertive");
    await expect(refusal.getByRole("alert")).toBeVisible();
    await expectAxeClean(page, "download location refused before sending");
    expect(spdx.writes()).toEqual([]);
  });
});

test.describe("ADR-0189 B9: SPDX fields on dataset versions", () => {
  test("an evaluation dataset version: five fields; a gateway refusal is announced without the value", async ({ page }) => {
    const spdx = await setup(page);
    await page.goto("/ui/admin/evals");
    await page.getByRole("link", { name: /^golden v2/ }).click();
    await expect(banner(page)).toContainText(
      "SPDX output for this evaluation dataset version is not_producible until these properties are declared: Built time, Originated by, Release time, Download location.",
    );
    await expect(banner(page)).toContainText("Dataset type is not declared, so the SPDX output records the standard's own noAssertion for it.");
    for (const name of ["Built time", "Originated by", "Release time", "Download location", "Dataset type"]) {
      await expect(panel(page).getByRole("row").filter({ hasText: name }).first()).toBeVisible();
    }
    await expectAxeClean(page, "evaluation dataset SPDX fields, empty");

    // credential-shaped text passes the browser's hints; the gateway refuses it
    spdx.refuseNext(422, { error: "invalid_spdx_declaration", rule: "credential_shaped", property: "originatedBy", detail: "ai-bom spdx field originatedBy: holds credential-shaped material (refused, never redacted)" });
    await panel(page).getByRole("button", { name: "Set originated by" }).click();
    const dialog = page.getByRole("dialog", { name: "Set originated by" });
    await dialog.getByLabel("Originated by").fill("Lab AKIAIOSFODNN7EXAMPLE");
    await dialog.getByRole("radio", { name: /Supplier declared/ }).check();
    await dialog.getByRole("button", { name: "Review" }).click();
    await expect(dialog.getByTestId("spdx-confirm-value")).toHaveText("Lab AKIAIOSFODNN7EXAMPLE");
    await dialog.getByRole("button", { name: "Record value" }).click();
    const refusal = dialog.getByTestId("spdx-refusal");
    await expect(refusal.getByRole("alert")).toContainText("Originated by holds credential-shaped material. It is refused, never redacted. Nothing was recorded.");
    await expect(refusal).toContainText("credential_shaped");
    await expect(refusal).not.toContainText("AKIA");
    await expect(dialog.getByLabel("Originated by")).toBeFocused();
    await expectAxeClean(page, "evaluation dataset SPDX refused by the gateway");
    expect(spdx.writes()).toHaveLength(1);
    await expect(page.getByTestId("spdx-history")).toContainText("History (0)");
  });

  test("withdrawn: a declared built time is withdrawn after a confirmation, and the history keeps it", async ({ page }) => {
    const spdx = await setup(page, { seed: { [`eval_dataset:${EVAL_DS}`]: [decl("builtTime", "2026-01-02T03:04:05Z", { seq: 7 })] } });
    await page.goto("/ui/admin/evals");
    await page.getByRole("link", { name: /^golden v2/ }).click();
    await expect(panel(page).getByTestId("spdx-value-builtTime")).toHaveText("2026-01-02T03:04:05Z");
    await expect(banner(page)).not.toContainText("Built time");

    await panel(page).getByRole("button", { name: "Withdraw built time" }).click();
    const dialog = page.getByRole("dialog", { name: "Withdraw built time" });
    await expect(dialog.getByTestId("spdx-withdraw-subject")).toContainText(`golden v2 (evaluation dataset version ${EVAL_DS})`);
    await expect(dialog).toContainText("2026-01-02T03:04:05Z");
    await expect(dialog).toContainText("declared by Blake Admin at 2026-10-01T12:00:05Z");
    await expect(dialog).toContainText("becomes not_producible until a built time is declared again");
    await expect(dialog).toContainText("withdrawal and its audit record in one transaction");
    await expectAxeClean(page, "withdraw confirmation");
    await dialog.getByRole("button", { name: "Withdraw value" }).click();
    await expect(dialog).toHaveCount(0);
    expect(spdx.writes()).toEqual([{ method: "POST", path: `/v1/ai-bom/spdx-fields/eval_dataset/${EVAL_DS}/builtTime/withdraw`, body: {} }]);
    await expect(banner(page)).toContainText("Built time, Originated by, Release time, Download location.");
    const history = page.getByTestId("spdx-history");
    await history.locator("summary").click();
    await expect(history.getByRole("row").filter({ hasText: "withdrawn" })).toHaveCount(1);
    await expect(history).toContainText("2026-01-02T03:04:05Z");
    await history.getByLabel("Show the history of").selectOption("releaseTime");
    await expect(history).toContainText("Nothing has been declared for this record yet.");
    await expectAxeClean(page, "evaluation dataset SPDX fields, withdrawn");
  });

  test("a training dataset version: the dataset type is a set of SPDX values, recorded sorted", async ({ page }) => {
    const spdx = await setup(page);
    await page.goto("/ui/admin/regulait-llm");
    await page.getByRole("link", { name: /^support-corpus v1/ }).click();
    await expect(banner(page)).toContainText("SPDX output for this training dataset version is not_producible");
    await panel(page).getByRole("button", { name: "Set dataset type" }).click();
    const dialog = page.getByRole("dialog", { name: "Set dataset type" });
    await dialog.getByRole("radio", { name: /Admin entered/ }).check();
    await dialog.getByRole("button", { name: "Review" }).click();
    await expect(dialog.getByTestId("spdx-refusal")).toContainText("must be one or more SPDX 3.0.1 dataset types");
    await dialog.getByRole("checkbox", { name: "text" }).check();
    await dialog.getByRole("checkbox", { name: "categorical" }).check();
    await dialog.getByRole("button", { name: "Review" }).click();
    await expect(dialog.getByTestId("spdx-confirm-value")).toHaveText("categorical, text");
    await expect(dialog.getByTestId("spdx-subject-name")).toHaveText("support-corpus v1");
    await dialog.getByRole("button", { name: "Record value" }).click();
    await expect(dialog).toHaveCount(0);
    expect(spdx.writes()).toEqual([{ method: "PUT", path: `/v1/ai-bom/spdx-fields/training_dataset/${TRAIN_DS}/datasetType`, body: { value: ["categorical", "text"], source: "admin_entered" } }]);
    await expect(panel(page).getByTestId("spdx-value-datasetType")).toHaveText("categorical, text");
    await expectAxeClean(page, "training dataset SPDX fields, partial");
  });
});

test.describe("ADR-0189 B9: the panel fails on its own", () => {
  for (const [name, status, body] of [
    ["an answer in another shape", 200, {}],
    ["a server error", 500, { error: "internal", detail: "db unavailable" }],
  ] as const) {
    test(`${name}: the panel says so and the rest of the model card still renders`, async ({ page }) => {
      await setup(page);
      await page.route(/\/v1\/ai-bom\/spdx-fields\//, (route) => json(route, body, status));
      await openCard(page);
      await expect(panel(page).getByRole("alert")).toBeVisible();
      await expect(panel(page).getByRole("button", { name: "Retry" })).toBeVisible();
      await expect(page.getByTestId("spdx-banner")).toHaveCount(0);
      // the card's own content is untouched
      await expect(page.getByLabel("Attach a model-artifact scan as evidence")).toBeVisible();
      await expect(page.getByRole("button", { name: "Request" })).toBeVisible();
      await expectAxeClean(page, `SPDX panel load failure (${name})`);
    });
  }
});

test.describe("ADR-0189 B9: admin only", () => {
  test("a non-admin gets the administrative refusal, no SPDX panel and no SPDX request", async ({ page }) => {
    const spdx = await setup(page, { isAdmin: false });
    await page.goto("/ui/admin/model-risk");
    await expect(page.getByText("This is an administrative surface")).toBeVisible();
    await expect(page.getByTestId("spdx-fields")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Set release time|Withdraw/ })).toHaveCount(0);
    expect(spdx.calls).toEqual([]);
    await expectAxeClean(page, "non-admin");
  });
});
