import { expect, test, type Page, type Route } from "@playwright/test";
const json = (route: Route, body: unknown, status=200) => route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
async function setup(page: Page, path: string, response: unknown, status=200) {
  await page.route("**/*", async route => {
    const p=new URL(route.request().url()).pathname;
    if(!p.startsWith("/v1")&&!p.startsWith("/auth")) return route.continue();
    const me={userId:"ada",isAdmin:true,user:{id:"ada",email:"ada@example.test",displayName:"Ada Admin"}};
    if(p==="/auth/me") return json(route,{...me,via:"session",mustChangePassword:false,totpEnabled:true,passwordSet:true,mfaSetupRequired:false});
    if(p==="/v1/me") return json(route,me);
    if(p==="/v1/detection-content") return json(route,response,status);
    if(p==="/v1/guardrails") return json(route,{rules:[]});
    if(p==="/v1/admission/skills") return json(route,{skills:[]});
    if(p==="/v1/org/settings") return json(route,{settings:{}});
    return json(route,{});
  });
  await page.goto(`/ui/admin/${path}`);
  await expect(page.getByText("Vendored detection content",{exact:true})).toBeVisible();
}
const pack=(id:string,rules:number,enabled:boolean)=>({id,rules,enabled,source:"Pinned fixture",repo:"https://example.test/source",commit:"a".repeat(40),sha256:"b".repeat(64),licence:"Apache-2.0",notImported:[{id:"excluded_condition",reason:"Compound upstream condition is outside the admitted grammar"}],auditRedactionAlways:id==="pipelock-secrets"});
for(const path of ["guardrails","admission"]) test(`${path} reports actual content, disabled packs and coverage limits`, async({page})=>{
  await setup(page,path,{packs:[pack("pipelock-secrets",62,false),pack("nemo-yara-injection",0,true)],outboundAudienceEnforced:false});
  await expect(page.getByText("Credential audience restrictions are not installed on outbound requests.")).toBeVisible();
  await expect(page.getByText(/Disabled; 62 imported rules/)).toBeVisible();
  await expect(page.getByText("This pack has no eligible imported rules and contributes no detections.")).toBeVisible();
  await expect(page.getByText(/Secret redaction on the audit path always applies/)).toBeVisible();
  await page.getByText("Excluded content for nemo-yara-injection").click();
  await expect(page.getByText(/Compound upstream condition/).last()).toBeVisible();
  await page.screenshot({path:`/workspace/.regulait-onboarding/x23-${path}.png`,fullPage:true});
});
test("failed manifest does not claim installed detectors", async({page})=>{
 await setup(page,"guardrails",{error:"unavailable"},503);
 await expect(page.getByRole("button",{name:"Retry",exact:true})).toBeVisible();
 await expect(page.getByText(/imported rules;/)).toHaveCount(0);
});
test("missing measured fields stay unreported",async({page})=>{
 await setup(page,"guardrails",{packs:[]});
 await expect(page.getByText("Outbound credential audience enforcement is not reported.")).toBeVisible();
});
