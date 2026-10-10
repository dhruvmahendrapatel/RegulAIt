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
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** the page also reads the skills tab's queues and the org's size limit */
async function installPageMocks(page: Page, opts: { maxMegabytes?: number; retentionDays?: number } = {}) {
  await page.route("**/v1/admission/skills", (route) => json(route, { scannerVersion: "skill-admission/2", holdAt: "medium", refuseAt: "high", rules: [], skills: [] }));
  await page.route("**/v1/release-quarantine", (route) => json(route, { enabled: false, minReleaseAgeDays: 7, recommendedDays: 7, servers: [], skills: [] }));
  await page.route("**/v1/mcp/admission", (route) => json(route, { mode: "log", enforcing: false, servers: [] }));
  await page.route("**/v1/org/settings", (route) => json(route, { settings: { modelArtifactMaxMegabytes: opts.maxMegabytes ?? 512, modelArtifactRetentionDays: opts.retentionDays ?? 30 } }));
}

async function setup(page: Page, opts: { maxMegabytes?: number; retentionDays?: number } = {}): Promise<{ st: MockState; eng: EnginesMockState }> {
  const st = await installBuilderMock(page);
  await installPageMocks(page, opts);
  const eng = await installEnginesMock(page);
  return { st, eng };
}

const artifactsTab = (page: Page) => page.goto("/ui/admin/admission?tab=artifacts");
const row = (page: Page, filename: string) =>
  page.getByRole("table").first().getByRole("row").filter({ has: page.getByRole("cell", { name: filename, exact: true }) });

test("independent X30 pre-aborted upload settles", async ({page}) => {
  await setup(page);
  await artifactsTab(page);
  const result=await page.evaluate(async()=>{
    const m=await import("/ui/src/views/admin/governance/modelArtifacts.ts");
    const c=new AbortController(); c.abort();
    return Promise.race([
      m.uploadModelArtifact(new Blob(["fixture"]),{filename:"fixture.bin",signal:c.signal}).then(()=>"resolved",()=>"rejected"),
      new Promise(r=>setTimeout(()=>r("pending"),500))
    ]);
  });
  expect(result).toBe("rejected");
});
test("independent X30 cited earlier run remains selected", async ({page})=>{
  await setup(page);
  const a=ARTIFACTS.safetensors;
  const latest={...ARTIFACT_SCANS[a.id]![0],id:"99999999-9999-4000-8000-0000000000f2",engineRunId:"99999999-7777-4000-8000-0000000000f2",createdAt:"2026-10-10T00:00:00Z"};
  const cited={...latest,id:"99999999-9999-4000-8000-0000000000f1",engineRunId:"99999999-7777-4000-8000-0000000000f1",createdAt:"2026-10-09T00:00:00Z",verdict:"unknown",admissible:false};
  await page.route(`**/v1/model-artifacts/${a.id}`,route=>json(route,{artifact:a,scans:[latest,cited]}));
  await page.goto(`/ui/admin/admission?tab=artifacts&artifact=${a.id}&run=${cited.engineRunId}`);
  await expect(page.getByTestId("scan-run")).toBeVisible();
  const current=await page.getByTestId("scan-run").getByTitle(new RegExp(latest.engineRunId)).count();
  console.log("X30 evidence link actual latest run chips",current,"cited run chips",await page.getByTestId("scan-run").getByTitle(new RegExp(cited.engineRunId)).count());
  await expect(page.getByTestId("scan-run").getByTitle(new RegExp(cited.engineRunId))).toBeVisible();
});

test("independent X30 malformed finding severity leaves artifact detail readable", async ({page}) => {
  await setup(page);
  const a=ARTIFACTS.safetensors;
  const scan={...ARTIFACT_SCANS[a.id]![0],verdict:"unknown",admissible:false,findings:[{kind:"scan_error",id:"synthetic_error",severity:{untrusted:"synthetic"}}]};
  await page.route(`**/v1/model-artifacts/${a.id}`,route=>json(route,{artifact:a,scans:[scan]}));
  await page.goto(`/ui/admin/admission?tab=artifacts&artifact=${a.id}`);
  await expect(page.getByText("Artifact: weights.safetensors")).toBeVisible();
  await expect(page.getByTestId("latest-scan").getByTestId("scan-status")).toHaveAttribute("data-clean","false");
});

test("independent X30 unread retention does not promise a measured lifetime", async ({page}) => {
  await setup(page,{retentionDays:45});
  await page.route("**/v1/org/settings",route=>json(route,{error:"synthetic_settings_unavailable"},503));
  await page.goto(`/ui/admin/admission?tab=artifacts&artifact=${ARTIFACTS.safetensors.id}`);
  await expect(page.getByTestId("artifact-retention")).toContainText("retention period and deletion date are unknown here");
  await expect(page.getByTestId("artifact-retention")).not.toContainText(/Kept for|deleted from \w{3} \d{1,2}, \d{4}/);
});


for (const [shape, severity] of Object.entries({object:{private:"SYNTHETIC_UNTRUSTED_MARKER"}, array:["SYNTHETIC_UNTRUSTED_MARKER"], unknown:"SYNTHETIC_UNTRUSTED_MARKER"})) {
test(`independent unsafe ${shape} severity stays unsafe with fixed unknown-severity wording`, async ({page},testInfo) => {
  await setup(page);
  const artifact=ARTIFACTS.renamedPickle;
  const scan={...ARTIFACT_SCANS[artifact.id]![0],verdict:"unsafe",admissible:false,findings:[{kind:"unsafe_operator",id:"os.system",severity}]};
  await page.route(`**/v1/model-artifacts/${artifact.id}`,route=>json(route,{artifact,scans:[scan]}));
  await page.goto(`/ui/admin/admission?tab=artifacts&artifact=${artifact.id}`);
  await expect(page.getByTestId("latest-scan").getByTestId("scan-status")).toContainText("Unsafe");
  await expect(page.getByTestId("latest-scan").getByTestId("scan-status")).toHaveAttribute("data-clean","false");
  await expect(page.getByRole("cell",{name:"unknown severity",exact:true})).toBeVisible();
  await expect(page.getByRole("list",{name:"Why it is not clean"})).toContainText("unknown severity");
  await expect(page.locator("body")).not.toContainText("SYNTHETIC_UNTRUSTED_MARKER");
  if(shape === "object") await page.screenshot({path:testInfo.outputPath("unsafe-unknown-severity.png"),fullPage:true});
});

}
