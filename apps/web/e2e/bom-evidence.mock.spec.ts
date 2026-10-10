import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const path="/ui/e2e/fixtures/bom-preview.html";
const json=(route:any,body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
async function setup(page:Page,mode="normal"){
 await page.route("**/auth/me",route=>json(route,{userId:id(5),isAdmin:true,via:"session",user:{id:id(5),email:"synthetic@example.invalid",displayName:"Synthetic reviewer"},mustChangePassword:false,totpEnabled:true,passwordSet:true,mfaSetupRequired:false}));
 await page.route("**/v1/me",route=>json(route,{userId:id(5),isAdmin:true,user:{id:id(5),email:"synthetic@example.invalid",displayName:"Synthetic reviewer"}}));
 await page.goto(`${path}?mode=${mode}`);await expect(page.getByRole("heading",{name:"Synthetic BOM UI preview"})).toBeVisible();
}
async function inspect(page:Page){await page.getByRole("button",{name:"Inspect snapshot version 1"}).click();}
const snapshotCard=(page:Page)=>page.locator("section").filter({has:page.getByText("Snapshot version 1",{exact:true})}).first();
test("snapshot/drift/export preserve digest-only display and bundle format",async({page})=>{
 await setup(page);await inspect(page);await expect(snapshotCard(page).getByText("Not recorded",{exact:true})).toBeVisible();
 await page.getByRole("button",{name:"Check inventory drift"}).click();await expect(page.getByText("Not evidence",{exact:true})).toBeVisible();await expect(page.getByText(`Agent ${id(1)}: changed hash`)).toBeVisible();
 await expect(page.locator("body")).not.toContainText("SYNTHETIC_PRIVATE_VERSION");
 await snapshotCard(page).getByLabel("BOM bundle format").selectOption("spdx-3.0.1");
 const download=page.waitForEvent("download");await snapshotCard(page).getByRole("button",{name:"Download BOM bundle",exact:true}).click();expect((await download).suggestedFilename()).toBe(`ai-bom-${id(9)}-spdx-3.0.1.zip`);
 await expect(page.getByRole("region",{name:"Synthetic operation log"})).toContainText("snapshot bundle spdx-3.0.1");
});
test("decision view records gaps and downloads a bundle without raw content",async({page})=>{
 await setup(page);const card=page.locator("section").filter({has:page.getByText("Decision BOM",{exact:true})}).first();await expect(card).toContainText("Historical decision evidence");
 const download=page.waitForEvent("download");await card.getByRole("button",{name:"Download Decision BOM bundle"}).click();expect((await download).suggestedFilename()).toBe(`decision-bom-${id(7)}.zip`);
 await expect(card).toContainText("Predates workload identity");await expect(card).toContainText("does not establish completeness");
});
test("production B3 adapter reads exact metadata and has unavailable B4 controls",async({page})=>{
 let lists=0,drifts=0,writes=0;
 await page.route(`**/v1/ai-bom/agent/${id(1)}/snapshots`,route=>{if(route.request().method()==="POST"){writes++;return json(route,{},501)}lists++;return json(route,{subject:{kind:"agent",id:id(1)},released:false,snapshots:[{id:id(9),version:1,serialNumber:`urn:uuid:${id(9)}`,trigger:"on_demand",bodySha256:"a".repeat(64),keyId:"synthetic-key",createdAt:"2026-10-10T12:00:00.000Z",formats:["cyclonedx-1.7"]}]})});
 await page.route(`**/v1/ai-bom/agent/${id(1)}/drift`,route=>{drifts++;return json(route,{subject:{kind:"agent",id:id(1)},evidence:false,baseline:{snapshotId:id(9),version:1,serialNumber:`urn:uuid:${id(9)}`,createdAt:"2026-10-10T12:00:00.000Z"},changes:[]})});
 await setup(page,"api");await expect(page.getByRole("button",{name:"Take signed snapshot"})).toBeDisabled();await inspect(page);await expect(page.getByText("Snapshot inspection and verifiable bundle downloads are unavailable on this gateway.")).toBeVisible();await page.getByRole("button",{name:"Check inventory drift"}).click();await expect(page.getByText(/No inventory changes measured/)).toBeVisible();expect(lists).toBe(1);expect(drifts).toBe(1);expect(writes).toBe(0);
});
test("unknown assurance vocabulary remains safe and unmeasured",async({page})=>{await setup(page,"unknown");await inspect(page);await expect(snapshotCard(page)).toContainText("Unrecognised section");await expect(snapshotCard(page)).toContainText("Additional assurance is not established");await expect(page.locator("body")).not.toContainText("[object Object]");});
test("pending, missing, mismatched, denied and failed inspection never enable snapshot export",async({page})=>{
 for(const mode of ["pending","missing","mismatch","deny","inspection-error"]){await setup(page,mode);await inspect(page);await expect(snapshotCard(page).getByRole("button",{name:"Download BOM bundle",exact:true})).toBeDisabled();if(mode==="mismatch"||mode==="inspection-error")await expect(snapshotCard(page)).toContainText("Snapshot assurance is unavailable");}
});
test("finite and lapsed locks remain distinct from anchored assurance",async({page})=>{for(const [mode,label] of [["finite","Anchored with a time-limited lock"],["lapsed","Anchor lock has lapsed"]]){await setup(page,mode);await inspect(page);await expect(snapshotCard(page).getByText(label,{exact:true})).toBeVisible();}});
test("bundle upload never renders raw text and distinguishes unverifiable sections",async({page})=>{
 await setup(page);const verify=page.locator("section").filter({has:page.getByText("Verify a BOM bundle",{exact:true})}).first();
 await verify.getByLabel("BOM bundle to verify",{exact:true}).setInputFiles({name:"synthetic.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({synthetic:true,raw:"SYNTHETIC_RAW_SECRET",keys:["SYNTHETIC_PRIVATE_KEY"]}))});await verify.getByRole("button",{name:"Verify loaded BOM bundle"}).click();await expect(verify).toContainText("Trust root: this deployment's recorded keys");await expect(verify.getByText("Unverifiable",{exact:true})).toBeVisible();await expect(page.locator("body")).not.toContainText("SYNTHETIC_RAW_SECRET");
 await verify.getByLabel("BOM bundle to verify",{exact:true}).setInputFiles({name:"bad.json",mimeType:"application/json",buffer:Buffer.from("SYNTHETIC_PRIVATE_KEY invalid")});await verify.getByRole("button",{name:"Verify loaded BOM bundle"}).click();await expect(verify).toContainText("No verification result was established");await expect(verify).not.toContainText("Trust root: this deployment's recorded keys");
});
test("confirmation is cancelled when subject changes and keyboard focus returns",async({page})=>{
 await setup(page);const trigger=page.getByRole("button",{name:"Take signed snapshot"});await trigger.focus();await page.keyboard.press("Enter");await expect(page.getByRole("dialog",{name:"Take signed AI BOM snapshot"})).toBeVisible();await page.keyboard.press("Escape");await expect(trigger).toBeFocused();await trigger.click();await page.evaluate(()=>{(window as unknown as {switchBomSubject:()=>void}).switchBomSubject()});await expect(page.getByRole("dialog")).toHaveCount(0);await expect(page.getByRole("region",{name:"Synthetic operation log"})).not.toContainText("created");
});
test("empty/error/unavailable states remain honest and axe passes both themes",async({page},testInfo)=>{
 await setup(page,"empty");await expect(page.getByText("No signed snapshots",{exact:true})).toBeVisible();await setup(page,"error");await expect(page.getByText("Snapshot metadata is unavailable.",{exact:false})).toBeVisible();await expect(page.locator("body")).not.toContainText("SYNTHETIC_SECRET_ERROR");
 await setup(page);await inspect(page);
 for(const theme of ["light","dark"]){await page.evaluate(t=>{document.documentElement.dataset.theme=t},theme);await page.evaluate(()=>Promise.all(document.getAnimations().map(a=>a.finished.catch(()=>{}))));const axe=await new AxeBuilder({page}).analyze();expect(axe.violations).toEqual([]);await page.screenshot({path:testInfo.outputPath(`bom-${theme}.png`),fullPage:true});}
});

test("agent and model-card BOM tabs work by keyboard without replacing editor state",async({page})=>{
 const {installBuilderMock}=await import("./builder-fixtures");await installBuilderMock(page);
 const registry=[{id:id(1),name:"Synthetic agent",provider:"mock",model:"synthetic-model",tier:0,enabled:true,lifecycleStatus:"active",costPerMTokIn:null,costPerMTokOut:null},{id:id(2),name:"Second synthetic agent",provider:"mock",model:"synthetic-model-2",tier:0,enabled:true,lifecycleStatus:"active",costPerMTokIn:null,costPerMTokOut:null}];
 await page.route("**/v1/agents",route=>json(route,{agents:registry}));
 const bomReads:string[]=[];await page.route("**/v1/ai-bom/agent/*/snapshots",route=>{const subjectId=new URL(route.request().url()).pathname.split("/")[4]!;bomReads.push(subjectId);return json(route,{subject:{kind:"agent",id:subjectId},released:false,snapshots:[]})});
 await page.goto("/ui/admin/agents");await page.getByLabel("Agent for AI BOM evidence").selectOption(id(1));expect(bomReads).toEqual([]);const overview=page.getByRole("tab",{name:"Overview",exact:true});await overview.focus();await page.keyboard.press("ArrowRight");await expect(page.getByRole("tab",{name:"AI BOM",exact:true})).toHaveAttribute("aria-selected","true");await expect(page.getByText("No signed snapshots",{exact:true})).toBeVisible();await page.getByLabel("Agent for AI BOM evidence").selectOption(id(2));await expect.poll(()=>bomReads).toEqual([id(1),id(2)]);await page.getByRole("tab",{name:"AI BOM",exact:true}).focus();await page.keyboard.press("Home");await expect(overview).toHaveAttribute("aria-selected","true");
 const card={id:id(6),agentId:id(1),customProviderId:null,intendedUse:"Synthetic summaries",limitations:null,dataClaims:{},biasFairness:[],standardRefs:[],state:"unsigned",daysUntilExpiry:null,subjectName:"Synthetic agent",approvals:[],evidence:[],completeness:{complete:false,missing:["evidence"],bias:{declared:0,assessed:0,waived:0,unevidenced:0,complete:false,disclaimer:"Unmeasured"}},createdAt:"2026-10-10T12:00:00.000Z",autofill:null,staleness:null};
 await page.route("**/v1/mrm/status",route=>json(route,{enforced:true,warnDays:30,stalenessRecertEnabled:true,stalenessRecertThreshold:1,posture:"declared",label:"Synthetic fixture",cards:1,approved:0,expiring:0,expired:0,pending:0,unsigned:1,revoked:0,note:"Mock"}));
 await page.route("**/v1/mrm/expiring",route=>json(route,{warnDays:30,items:[]}));await page.route("**/v1/mrm/cards",route=>json(route,{cards:[card],enforced:true}));await page.route(`**/v1/mrm/cards/${id(6)}`,route=>json(route,{card}));
 await page.goto("/ui/admin/model-risk");await page.getByRole("button",{name:"Open",exact:true}).click();const editor=page.getByPlaceholder("eval run id from /admin/evals");await editor.fill("synthetic-unsaved-evidence");const evidenceTab=page.getByRole("tab",{name:"Model card and evidence"});await evidenceTab.focus();await page.keyboard.press("End");await expect(page.getByRole("tab",{name:"AI BOM",exact:true})).toHaveAttribute("aria-selected","true");await expect(page.getByRole("tabpanel",{name:"Model card AI BOM"})).toContainText("No signed snapshots");await page.keyboard.press("Home");await expect(evidenceTab).toHaveAttribute("aria-selected","true");await expect(page.getByRole("tabpanel",{name:"Model card and evidence"})).toBeVisible();await expect(editor).toHaveValue("synthetic-unsaved-evidence");
});

test("BOM posture requires step-up and locks after successful write with failed refresh",async({page})=>{
 const {installBuilderMock}=await import("./builder-fixtures");const {confirmStepUp,requireStepUpOn}=await import("./step-up-harness");await installBuilderMock(page);
 const stored:Record<string,unknown>={decisionFactsCapture:"on",decisionBomFinality:"anchored",bomExportRoles:"admins_only",bomPersonIdentifiers:"id_only",aiBomSnapshotTriggers:"sign_off_events",aiBomSnapshotWithoutKey:"refuse",cyclonedxExportVersions:["1.6","1.7"],bomExportRateLimitPerMinute:30,decisionBomFiniteLockFinality:"refuse"};
 let failed=false,writes=0;await page.route("**/v1/org/settings",route=>{if(route.request().method()==="PUT"){writes++;Object.assign(stored,route.request().postDataJSON());failed=true;return json(route,{settings:stored});}return failed?json(route,{error:"synthetic_read_failed"},500):json(route,{settings:stored})});
 await page.route("**/v1/org/posture",route=>json(route,{hardened:true,summary:{enforcementSatisfied:0,enforcementTotal:0,optimisationSatisfied:0,optimisationTotal:0,blockedByEnvironment:[]},controls:[],execution:{mode:"normal",reason:null}}));
 const stepUp=await requireStepUpOn(page,{method:"PUT",path:"/v1/org/settings",kind:"settings_relax"});await page.goto("/ui/admin/enforcement-posture");
 await expect(page.getByLabel("CycloneDX export versions",{exact:true})).toHaveValue("1.7,1.6");const facts=page.locator("form").filter({has:page.getByLabel("Decision BOM facts",{exact:true})});await facts.getByLabel("Decision BOM facts",{exact:true}).selectOption("off");await facts.getByRole("button",{name:"Review change"}).click();const dialog=page.getByRole("dialog",{name:"Change decision bom facts?"});await expect(dialog).toContainText("Stored value: on → New value: off");await dialog.getByRole("button",{name:"Save setting"}).click();await confirmStepUp(page);await stepUp.expectResentOnce();await expect(page.getByText(/This form stays locked/)).toBeVisible();expect(writes).toBe(1);await expect(page.getByRole("button",{name:"Review change"})).toHaveCount(0);failed=false;await page.getByRole("button",{name:"Retry loading current values"}).click();await expect(page.getByLabel("Decision BOM facts",{exact:true})).toHaveValue("off");await expect(page.getByText("Decision BOM: not captured",{exact:true})).toBeVisible();
});
