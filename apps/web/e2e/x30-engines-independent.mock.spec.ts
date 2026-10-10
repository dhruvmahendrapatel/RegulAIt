/** Independent X30 returned-fix probes; synthetic routes test UI orchestration, not gateway locking. */
import { expect, test, type Page, type Route } from "@playwright/test";
import { installBuilderMock } from "./builder-fixtures";
import { enginesList, installEnginesMock, type EnginesMockState } from "./engines-fixtures";
import { confirmStepUp, requireStepUpOn } from "./step-up-harness";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const ISOLATION_DETAIL =
  "engine promptfoo's build runs the engine process as the runner's own user, so a compromised engine could read the runner token " +
  "(it can lease this engine's runs and post their results; it cannot reach any other route). " +
  "To enable it anyway, send acceptCredentialIsolationRisk: true with a step-up; the isolating build is ADR-0187 slice B5-P2.";

/** the fixture list with promptfoo switched off (its self-test still a fresh pass), so it can be enabled */
function enginesWithPromptfooOff(): Json {
  const list = enginesList();
  list.engines[0].enabled = false;
  return list;
}

async function open(page: Page, init: Partial<EnginesMockState> = {}): Promise<EnginesMockState> {
  await installBuilderMock(page, { isAdmin: true });
  const st = await installEnginesMock(page, init);
  await page.route("**/v1/detection-content", (route) => json(route, 501, { error: "not_built" }));
  await page.goto("/ui/admin/engines");
  await expect(page.getByRole("heading", { name: "Engines", level: 1 })).toBeVisible();
  return st;
}

const card = (page: Page, id: string) => page.getByTestId(`engine-${id}`);

test("independent replacement build is bound to the refusal then refused if it moves during step-up",async({page})=>{
  const st=await open(page,{engines:enginesWithPromptfooOff()});
  const original=st.engines.engines[0].version;
  const b={version:"88.0.0",imageDigest:`sha256:${"b".repeat(64)}`};
  const c={version:"99.0.0",imageDigest:`sha256:${"c".repeat(64)}`};
  let current=b;const attempts:Array<{body:Json;header:string|null}>=[];
  const su=await requireStepUpOn(page,{method:"PATCH",path:"/v1/engines/promptfoo",kind:"settings_relax",facts:body=>({values:{"engine.promptfoo.enabled":true,"engine.promptfoo.acceptCredentialIsolationRisk":{version:(body as Json).expectedVersion,imageDigest:(body as Json).expectedDigest}}})});
  await page.route("**/v1/engines/promptfoo",route=>{
    const req=route.request();if(req.method()!=="PATCH")return route.fallback();
    const body=req.postDataJSON(),header=req.headers()["x-regulait-step-up"]??null;attempts.push({body,header});
    if(body.acceptCredentialIsolationRisk!==true)return json(route,409,{error:"engine_credential_isolation_missing",...current,detail:ISOLATION_DETAIL});
    if(body.expectedVersion!==current.version||body.expectedDigest!==current.imageDigest)return json(route,409,{error:"engine_build_changed",...current,detail:"Synthetic build changed; no write"});
    return route.fallback();
  });
  await card(page,"promptfoo").getByRole("button",{name:"Enable…"}).click();
  await page.getByRole("dialog",{name:"Enable promptfoo?"}).getByRole("button",{name:"Enable",exact:true}).click();
  const risk=page.getByRole("dialog",{name:/Accept the credential-isolation risk/});
  await expect(risk.getByText(/I accept that a compromised/)).toContainText(b.version);
  await expect(risk.getByText(/I accept that a compromised/)).not.toContainText(original);
  await risk.getByRole("checkbox").check();await risk.getByRole("button",{name:"Accept risk and enable"}).click();
  await expect(page.getByRole("dialog",{name:"Confirm it's you"})).toBeVisible();current=c;
  await confirmStepUp(page);
  const reopened=page.getByRole("dialog",{name:/Accept the credential-isolation risk/});
  await expect(reopened.getByTestId("build-changed-notice")).toContainText(c.version);
  await expect(reopened.getByRole("checkbox")).not.toBeChecked();
  await expect(reopened.getByRole("button",{name:"Accept risk and enable"})).toBeDisabled();
  expect(attempts).toHaveLength(3);
  expect(attempts[1].body).toEqual({enabled:true,acceptCredentialIsolationRisk:true,expectedVersion:b.version,expectedDigest:b.imageDigest});
  expect(attempts[2].body).toEqual(attempts[1].body);expect(attempts[2].header).toBe("rgsu_1");
  expect(su.optionsCalls).toHaveLength(1);expect((su.optionsCalls[0] as Json).action.body.values["engine.promptfoo.acceptCredentialIsolationRisk"]).toEqual(b);
  expect(st.engines.engines[0].enabled).toBe(false);
});

test("independent unnamed isolation refusal cannot produce an accepted write",async({page})=>{
  const st=await open(page,{engines:enginesWithPromptfooOff()});let writes=0;
  await page.route("**/v1/engines/promptfoo",route=>{if(route.request().method()!=="PATCH")return route.fallback();writes++;return json(route,409,{error:"engine_credential_isolation_missing",detail:"Synthetic old gateway omitted the build"});});
  await card(page,"promptfoo").getByRole("button",{name:"Enable…"}).click();
  await page.getByRole("dialog",{name:"Enable promptfoo?"}).getByRole("button",{name:"Enable",exact:true}).click();
  const risk=page.getByRole("dialog",{name:/Accept the credential-isolation risk/});
  await expect(risk.getByRole("button",{name:"Accept risk and enable"})).toBeDisabled();
  await expect(page.getByRole("dialog",{name:"Confirm it's you"})).toHaveCount(0);expect(writes).toBe(1);expect(st.engines.engines[0].enabled).toBe(false);
});


test("independent future-dated passing runner report has no healthy badge", async ({ page }) => {
  const list = enginesList();
  list.engines[0].runners[0].selfTestReportedAt = new Date(Date.now() + 10 * 60_000).toISOString();
  await open(page, { engines: list });
  const row = card(page, "promptfoo").getByRole("row", { name: /promptfoo-runner-1/ });
  await expect(row.getByText("self-test report stale")).toBeVisible();
  await expect(row.getByText("passed", { exact: true })).toHaveCount(0);
});
