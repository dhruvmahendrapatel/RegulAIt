/**
 * ADR-0187 X28 (AgentCoordination §4.10, decisions 104–126) — model artifacts
 * in Admission review and the `engine_scan` evidence chip on model cards.
 * Mocked API (engines-fixtures.ts, synthetic artifacts only).
 *
 * What these pin: only the verified safetensors artifact ever reads clean; the
 * pickle-family, unknown, not-run and never-scanned artifacts never do; every
 * "why" is a fixed sentence from structured fields; the upload refuses a file
 * over the org's declared limit before sending it, shows the gateway's own
 * refusals, and sends raw bytes; a scan is started as the §4.10 modelscan run;
 * and a model card shows engine, version, result, date and a link to the run.
 */
import { expect, test, type Page, type Route } from "@playwright/test";
import { expectAxeClean, installBuilderMock, type MockState } from "./builder-fixtures";
import { ARTIFACT_CHIP, ARTIFACTS, ARTIFACT_SCANS, installEnginesMock, type EnginesMockState } from "./engines-fixtures";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** the page also reads the skills tab's queues and the org's size limit */
async function installPageMocks(page: Page, opts: { maxMegabytes?: number } = {}) {
  await page.route("**/v1/admission/skills", (route) => json(route, { scannerVersion: "skill-admission/2", holdAt: "medium", refuseAt: "high", rules: [], skills: [] }));
  await page.route("**/v1/release-quarantine", (route) => json(route, { enabled: false, minReleaseAgeDays: 7, recommendedDays: 7, servers: [], skills: [] }));
  await page.route("**/v1/mcp/admission", (route) => json(route, { mode: "log", enforcing: false, servers: [] }));
  await page.route("**/v1/org/settings", (route) => json(route, { settings: { modelArtifactMaxMegabytes: opts.maxMegabytes ?? 512 } }));
}

async function setup(page: Page, opts: { maxMegabytes?: number } = {}): Promise<{ st: MockState; eng: EnginesMockState }> {
  const st = await installBuilderMock(page);
  await installPageMocks(page, opts);
  const eng = await installEnginesMock(page);
  return { st, eng };
}

const artifactsTab = (page: Page) => page.goto("/ui/admin/admission?tab=artifacts");
const row = (page: Page, filename: string) =>
  page.getByRole("table").first().getByRole("row").filter({ has: page.getByRole("cell", { name: filename, exact: true }) });

test.describe("ADR-0187 X28: Model artifacts in Admission review", () => {
  test("only the verified safetensors artifact reads clean; every other verdict says it is not", async ({ page }) => {
    await setup(page);
    await artifactsTab(page);
    await expect(page.getByRole("tab", { name: "Model artifacts" })).toHaveAttribute("aria-selected", "true");
    await expect(row(page, "weights.safetensors").getByTestId("scan-status")).toContainText(`Clean${ARTIFACT_CHIP.clean}`);
    await expect(row(page, "model.pkl").getByTestId("scan-status")).toContainText(`Not clean${ARTIFACT_CHIP.no_known_unsafe}`);
    await expect(row(page, "model.safetensors").getByTestId("scan-status")).toContainText(`Unsafe${ARTIFACT_CHIP.unsafe}`);
    await expect(row(page, "broken.pkl").getByTestId("scan-status")).toContainText(`Not clean${ARTIFACT_CHIP.unknown}`);
    await expect(row(page, "model.gguf").getByTestId("scan-status")).toContainText(`Not clean${ARTIFACT_CHIP.not_run}`);
    // exactly one clean row, and it is the safetensors one
    await expect(page.locator('[data-testid="scan-status"][data-clean="true"]')).toHaveCount(1);
    await expect(row(page, "model.pkl")).toContainText("Executable");
    await expect(row(page, "weights.safetensors")).toContainText("Holds no code");
    await expect(page.getByText(/\bsafe\b/i)).toHaveCount(0);
    await expectAxeClean(page, "model artifacts list");
  });

  test("a renamed pickle: the content wins over the name, and the reasons and findings come from structured fields", async ({ page }) => {
    await setup(page);
    await artifactsTab(page);
    await page.getByRole("button", { name: "Open model.safetensors" }).click();
    await expect(page).toHaveURL(new RegExp(`artifact=${ARTIFACTS.renamedPickle.id}`));
    const detail = page.locator("section", { hasText: "Artifact: model.safetensors" }).last();
    await expect(detail.getByTestId("name-mismatch")).toContainText("ends in .safetensors, but its content is Python pickle");
    const latest = detail.getByTestId("latest-scan");
    await expect(latest.getByTestId("scan-status")).toHaveAttribute("data-clean", "false");
    await expect(latest).toContainText("Not admissible");
    const reasons = latest.getByRole("list", { name: "Why it is not clean" });
    await expect(reasons).toContainText("An unsafe operator was found: os.system (critical).");
    await expect(reasons).toContainText("Python pickle is an executable format: loading it can run code, so it can never be clean.");
    await expect(detail.getByRole("cell", { name: "Unsafe operator" })).toBeVisible();
    await expect(detail.getByRole("cell", { name: "os.system" })).toBeVisible();
    await expect(detail.getByTestId("scan-run")).toContainText("modelscan v0.8.8");
    await expectAxeClean(page, "renamed pickle detail");
  });

  test("a clean-format pickle scan, an inconclusive scan and an unsupported format each say why they are not clean", async ({ page }) => {
    await setup(page);
    await artifactsTab(page);
    const cases: Array<[string, RegExp]> = [
      ["model.pkl", /executable format: loading it can run code, so it can never be clean/],
      ["broken.pkl", /The scanner reported an error \(PICKLE_GENOPS\), so the result is inconclusive\./],
      ["model.gguf", /This format \(GGUF\) is not supported by the scanner, so it was not scanned and cannot be clean\./],
    ];
    for (const [name, why] of cases) {
      await page.getByRole("button", { name: `Open ${name}` }).click();
      const latest = page.getByTestId("latest-scan");
      await expect(latest.getByTestId("scan-status"), name).toHaveAttribute("data-clean", "false");
      await expect(latest.getByRole("list", { name: "Why it is not clean" }), name).toContainText(why);
      await expect(latest, name).toContainText("Not admissible");
    }
    await page.getByRole("button", { name: "Open weights.safetensors" }).click();
    await expect(page.getByTestId("latest-scan").getByRole("list", { name: "Why it is clean" })).toContainText("This is the only format that can be clean.");
    await expect(page.getByTestId("latest-scan")).toContainText("Admissible");
  });

  test("upload: raw bytes with progress, the format from the content, then a scan as the §4.10 modelscan run", async ({ page }) => {
    const { eng } = await setup(page);
    // the fixture's modelscan is not built (off): enable it for this test only
    const modelscan = eng.engines.engines.find((e: { id: string }) => e.id === "modelscan");
    modelscan.enabled = true;
    // the real gateway classes modelscan's `scan` set as standard (no approver); the shared mock
    // approves only `basic`, so this test answers the run itself, as the gateway does
    const posted: unknown[] = [];
    await page.route("**/v1/engine-runs", (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const body = route.request().postDataJSON();
      posted.push(body);
      const run = { id: "99999999-7777-4000-8000-0000000000f1", engineId: "modelscan", engineVersion: "0.8.8", status: "queued", targetArtifactId: body.target.artifactId, createdAt: new Date().toISOString(), finishedAt: null, errorCode: null };
      eng.runs.unshift(run);
      return json(route, { run, approvalId: null }, 202);
    });
    await artifactsTab(page);
    await expect(page.getByText("Size limit: 512 MiB")).toBeVisible();
    // a pickle (protocol 4) named as safetensors: the name decides nothing
    await page.getByTestId("artifact-file").setInputFiles({ name: "innocent.safetensors", mimeType: "application/octet-stream", buffer: Buffer.from([0x80, 0x04, 0x95, 0x00, 0x00, 0x2e]) });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByRole("button", { name: "Open innocent.safetensors" })).toBeVisible();
    const upload = eng.calls.find((c) => c.method === "POST" && c.path === "/v1/model-artifacts");
    expect(upload?.headers["content-type"]).toBe("application/octet-stream");
    expect(upload?.headers["x-regulait-csrf"]).toBe("1");
    await expect(page).toHaveURL(/artifact=99999999-8888-4000-8000-000000000105/);
    await expect(page.getByTestId("name-mismatch")).toContainText("its content is Python pickle");
    const latest = page.getByTestId("latest-scan");
    await expect(latest.getByTestId("scan-status")).toContainText("Not scanned");
    await expect(latest.getByTestId("scan-status")).toHaveAttribute("data-clean", "false");
    await expect(row(page, "innocent.safetensors").getByTestId("scan-status")).toContainText("Not scanned");

    await page.getByRole("button", { name: "Scan with modelscan" }).click();
    await expect.poll(() => posted).toEqual([{ engineId: "modelscan", target: { artifactId: "99999999-8888-4000-8000-000000000105" }, config: { sets: ["scan"] } }]);
    await expect(row(page, "innocent.safetensors")).toContainText("Queued — waiting for a scanner");
    await expect(page.getByRole("button", { name: "Scan with modelscan" })).toBeDisabled();
    await expectAxeClean(page, "uploaded artifact with a queued scan");
  });

  test("the scan button is off while modelscan is switched off, and says so", async ({ page }) => {
    await setup(page);
    await page.goto(`/ui/admin/admission?tab=artifacts&artifact=${ARTIFACTS.truncated.id}`);
    await expect(page.getByRole("button", { name: "Scan again with modelscan" })).toBeDisabled();
    await expect(page.getByTestId("engine-off")).toContainText("this artifact stays not clean");
  });

  test("a file over the org's declared limit is refused before a byte is sent", async ({ page }) => {
    const { eng } = await setup(page, { maxMegabytes: 1 });
    await artifactsTab(page);
    await expect(page.getByText("Size limit: 1 MiB")).toBeVisible();
    await page.getByTestId("artifact-file").setInputFiles({ name: "big.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(1024 * 1024 + 1) });
    await expect(page.getByRole("alert")).toContainText("the limit is 1 MiB. Nothing was sent.");
    await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeDisabled();
    expect(eng.calls.filter((c) => c.method === "POST" && c.path === "/v1/model-artifacts")).toHaveLength(0);
  });

  test("the gateway's refusals are shown as they arrive: 413, 503 and one this page does not know", async ({ page }) => {
    await setup(page);
    const answers = [
      { status: 413, body: { error: "artifact_too_large", detail: "the limit is 512 MiB (an admin may raise it; the change needs a step-up)" } },
      { status: 503, body: { error: "artifact_store_unavailable", detail: "no model-artifact store is configured on this gateway, so nothing is accepted" } },
      { status: 409, body: { error: "artifact_quota_exceeded", detail: "this person's artifact quota is used up" } },
    ];
    let n = 0;
    await page.route(/\/v1\/model-artifacts\?/, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const a = answers[n++]!;
      return json(route, a.body, a.status);
    });
    await artifactsTab(page);
    const expected = [/over the organisation's model-artifact size limit, so nothing of it was kept/, /no model-artifact store configured/, /Artifact quota exceeded — this person's artifact quota is used up/i];
    for (const want of expected) {
      await page.getByTestId("artifact-file").setInputFiles({ name: "w.safetensors", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3]) });
      await page.getByRole("button", { name: "Upload", exact: true }).click();
      await expect(page.getByTestId("upload-error")).toContainText(want);
    }
    await expectAxeClean(page, "upload refused");
  });

  test("an upload in flight shows its progress and can be cancelled", async ({ page }) => {
    await setup(page);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(/\/v1\/model-artifacts\?/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await held;
      return json(route, { error: "late" }, 500).catch(() => undefined);
    });
    await artifactsTab(page);
    await page.getByTestId("artifact-file").setInputFiles({ name: "slow.safetensors", mimeType: "application/octet-stream", buffer: Buffer.alloc(64 * 1024) });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page.getByRole("progressbar", { name: "Upload progress" })).toBeVisible();
    await expect(page.getByText(/Uploading: .* of 64\.0 KiB/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Cancel upload" }).click();
    await expect(page.getByTestId("upload-error")).toContainText("Upload cancelled.");
    await expect(page.getByRole("progressbar", { name: "Upload progress" })).toHaveCount(0);
    release();
  });

  test("a lost session during an upload goes to sign-in, as every other call does", async ({ page }) => {
    await setup(page);
    await page.route(/\/v1\/model-artifacts\?/, (route) =>
      route.request().method() === "POST" ? json(route, { error: "unauthenticated" }, 401) : route.fallback(),
    );
    await artifactsTab(page);
    await page.getByTestId("artifact-file").setInputFiles({ name: "w.safetensors", mimeType: "application/octet-stream", buffer: Buffer.from([1]) });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(page).toHaveURL(/\/ui\/login/);
  });

  test("a scan refusal from the gateway is shown (engine disabled), and nothing reads as clean", async ({ page }) => {
    const { eng } = await setup(page);
    eng.engines.engines.find((e: { id: string }) => e.id === "modelscan").enabled = true;
    await page.route("**/v1/engine-runs", (route) =>
      route.request().method() === "POST" ? json(route, { error: "engine_disabled", detail: "engine modelscan is switched off" }, 409) : route.fallback(),
    );
    await page.goto(`/ui/admin/admission?tab=artifacts&artifact=${ARTIFACTS.cleanPickle.id}`);
    await page.getByRole("button", { name: "Scan again with modelscan" }).click();
    await expect(page.getByTestId("scan-error")).toContainText("The modelscan engine is switched off on this deployment");
    await expect(page.getByTestId("latest-scan").getByTestId("scan-status")).toHaveAttribute("data-clean", "false");
  });

  test("the skills and servers tab is still the default", async ({ page }) => {
    await setup(page);
    await page.goto("/ui/admin/admission");
    await expect(page.getByRole("tab", { name: "Skills and servers" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Builder skills held by the admission detectors")).toBeVisible();
    await page.getByRole("tab", { name: "Model artifacts" }).click();
    await expect(page).toHaveURL(/tab=artifacts/);
    await expect(page.getByText("Upload a model artifact")).toBeVisible();
  });
});

// ---- the model card -----------------------------------------------------------

const CARD = "99999999-5555-4000-8000-000000000001";
const scanOf = (key: keyof typeof ARTIFACTS) => ARTIFACT_SCANS[ARTIFACTS[key].id]![0];

async function installMrmMock(page: Page) {
  const posted: unknown[] = [];
  const evidence = [
    { id: "ev-1", kind: "engine_scan", evalRunId: null, externalRef: null, artifactScanId: scanOf("safetensors").id, label: null, attachedAt: new Date().toISOString(), artifactScan: { ...scanOf("safetensors"), engineRunId: "99999999-7777-4000-8000-0000000000e1" } },
    { id: "ev-2", kind: "engine_scan", evalRunId: null, externalRef: null, artifactScanId: scanOf("cleanPickle").id, label: null, attachedAt: new Date().toISOString(), artifactScan: scanOf("cleanPickle") },
    { id: "ev-3", kind: "engine_scan", evalRunId: null, externalRef: null, artifactScanId: "99999999-9999-4000-8000-0000000000ff", label: null, attachedAt: new Date().toISOString(), artifactScan: null },
  ];
  const card = {
    id: CARD,
    agentId: "22222222-0000-4000-8000-000000000001",
    customProviderId: null,
    intendedUse: "Contract clause triage",
    limitations: null,
    dataClaims: {},
    biasFairness: [],
    standardRefs: [],
    state: "unsigned",
    daysUntilExpiry: null,
    subjectKind: "agent",
    subjectName: "Clause triage",
    subjectModel: null,
    approvals: [],
    evidence,
    completeness: { complete: false, missing: ["sign_off"], bias: { declared: 0, assessed: 0, waived: 0, unevidenced: 0, complete: false, disclaimer: "declared, not measured" } },
    createdAt: new Date().toISOString(),
  };
  await page.route("**/v1/mrm/status", (route) =>
    json(route, { enforced: false, warnDays: 30, stalenessRecertEnabled: true, stalenessRecertThreshold: 1, posture: "declared", label: "declared", cards: 1, approved: 0, expiring: 0, expired: 0, pending: 0, unsigned: 1, revoked: 0, note: "" }),
  );
  await page.route("**/v1/mrm/expiring", (route) => json(route, { warnDays: 30, items: [] }));
  await page.route("**/v1/mrm/cards", (route) => json(route, { cards: [card], enforced: false }));
  await page.route(`**/v1/mrm/cards/${CARD}`, (route) => json(route, { card: { ...card, autofill: null, staleness: null } }));
  await page.route(`**/v1/mrm/cards/${CARD}/evidence`, (route) => {
    posted.push(route.request().postDataJSON());
    return json(route, { evidence: { id: "ev-new" } }, 201);
  });
  return posted;
}

test.describe("ADR-0187 X28: the engine-scan evidence chip on a model card", () => {
  test("engine, version, result, date and a link to the run; a pickle or a missing scan never reads clean", async ({ page }) => {
    await setup(page);
    const posted = await installMrmMock(page);
    await page.goto("/ui/admin/model-risk");
    await page.getByRole("row").filter({ hasText: "Clause triage" }).getByRole("button", { name: "Open" }).click();
    const chips = page.getByTestId("engine-scan-chip");
    await expect(chips).toHaveCount(3);
    const clean = chips.nth(0);
    await expect(clean.getByTestId("scan-status")).toHaveAttribute("data-clean", "true");
    await expect(clean).toContainText(ARTIFACT_CHIP.clean);
    await expect(clean).toContainText("Engine: modelscan v0.8.8");
    await expect(clean).toContainText(/Scanned \w{3} \d{1,2}, \d{4}/);
    await expect(clean).toContainText("Admissible");
    const pickle = chips.nth(1);
    await expect(pickle.getByTestId("scan-status")).toHaveAttribute("data-clean", "false");
    await expect(pickle).toContainText(ARTIFACT_CHIP.no_known_unsafe);
    await expect(pickle).toContainText("Not admissible");
    await expect(chips.nth(2)).toContainText("Scan record unavailable");
    await expect(chips.nth(2)).toContainText("Not clean");
    await expectAxeClean(page, "model card with engine-scan evidence");

    // attach another scan by its id
    await page.getByLabel("Attach a model-artifact scan as evidence").fill(scanOf("gguf").id);
    await page.getByRole("button", { name: "Attach scan" }).click();
    await expect.poll(() => posted).toEqual([{ kind: "engine_scan", artifactScanId: scanOf("gguf").id }]);

    // the link opens the artifact's scan in Admission review
    await clean.getByRole("link", { name: "View the scan and its run" }).click();
    await expect(page).toHaveURL(new RegExp(`/ui/admin/admission\\?tab=artifacts&artifact=${ARTIFACTS.safetensors.id}&run=`));
    await expect(page.getByText("Artifact: weights.safetensors")).toBeVisible();
    await expect(page.getByTestId("latest-scan").getByTestId("scan-status")).toHaveAttribute("data-clean", "true");
  });
});
