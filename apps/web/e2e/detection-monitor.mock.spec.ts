import { expect,test,type Page,type Route } from "@playwright/test";
const json=(route:Route,body:unknown,status=200)=>route.fulfill({status,contentType:"application/json",body:JSON.stringify(body)});
async function setup(page:Page,reported=true,failSave=false){
 const settings:Record<string,unknown>=reported?{monitorMcpBaselineDays:14,monitorJailbreakThreshold:3,monitorJailbreakWindowHours:24}:{};
 const puts:unknown[]=[];
 await page.route("**/*",async route=>{
  const req=route.request(),p=new URL(req.url()).pathname;
  if(!p.startsWith("/v1")&&!p.startsWith("/auth"))return route.continue();
  const me={userId:"ada",isAdmin:true,user:{id:"ada",email:"ada@example.test",displayName:"Ada Admin"}};
  if(p==="/auth/me")return json(route,{...me,via:"session",mustChangePassword:false,totpEnabled:true,passwordSet:true,mfaSetupRequired:false});
  if(p==="/v1/me")return json(route,me);
  if(p==="/v1/governance/alerts")return json(route,{alerts:[],counts:{open:0,acknowledged:0,resolved:0},lastEvaluatedAt:null,rules:[]});
  if(p==="/v1/org/settings"){
   if(req.method()==="PUT"){puts.push(req.postDataJSON());if(failSave)return json(route,{error:"fixture_refused"},403);Object.assign(settings,req.postDataJSON());}
   return json(route,{settings});
  }
  if(p==="/v1/users")return json(route,{users:[]});
  if(p==="/v1/pm/connections")return json(route,{connections:[]});
  return json(route,{});
 });
 await page.goto("/ui/admin/governance/alerts");
 await expect(page.getByText("Detection monitor rules and thresholds",{exact:true})).toBeVisible();return puts;
}
test("shows measured defaults and explains observational and missing-history limits",async({page},testInfo)=>{
 await setup(page);
 await expect(page.getByLabel("MCP baseline days",{exact:true})).toHaveValue("14");
 await expect(page.getByLabel("Jailbreak finding threshold",{exact:true})).toHaveValue("3");
 await expect(page.getByLabel("Jailbreak observation hours",{exact:true})).toHaveValue("24");
 await expect(page.getByText(/Missing or ambiguous history holds an existing alert/)).toBeVisible();
 await expect(page.getByText(/Correlation does not establish cause or successful execution/)).toBeVisible();
 await page.screenshot({path:testInfo.outputPath("x24-monitor.png"),fullPage:true});
});
test("saves only changed thresholds through the existing audited settings route",async({page})=>{
 const puts=await setup(page);await page.getByLabel("Jailbreak finding threshold",{exact:true}).fill("5");
 await page.getByRole("button",{name:"Save detection thresholds",exact:true}).click();
 await expect(page.getByRole("button",{name:"Save detection thresholds",exact:true})).toBeDisabled();
 expect(puts).toEqual([{monitorJailbreakThreshold:5}]);await expect(page.getByLabel("Jailbreak finding threshold",{exact:true})).toHaveValue("5");
});
test("rejects blank, fractional and out-of-range thresholds before any write",async({page})=>{
 const puts=await setup(page);const input=page.getByLabel("Jailbreak observation hours",{exact:true});
 for(const value of ["","0","169","1.5"]){await input.fill(value);await page.getByRole("button",{name:"Save detection thresholds",exact:true}).click();await expect(page.getByRole("alert")).toHaveText("Jailbreak observation hours must be a whole number from 1 to 168.");}
 expect(puts).toEqual([]);
});
test("missing settings stay unreported without editable invented defaults",async({page})=>{
 await setup(page,false);await expect(page.getByText("Detection monitor thresholds are not reported by this gateway.")).toBeVisible();await expect(page.getByLabel("MCP baseline days",{exact:true})).toHaveCount(0);
});
test("refused save preserves the draft and does not claim success",async({page})=>{
 const puts=await setup(page,true,true);await page.getByLabel("MCP baseline days",{exact:true}).fill("7");await page.getByRole("button",{name:"Save detection thresholds",exact:true}).click();
 await expect(page.getByRole("button",{name:"Save detection thresholds",exact:true})).toBeEnabled();await expect(page.getByLabel("MCP baseline days",{exact:true})).toHaveValue("7");expect(puts).toEqual([{monitorMcpBaselineDays:7}]);await expect(page.getByText("Detection monitor thresholds saved",{exact:true})).toHaveCount(0);
});

test("R24-07: measured relaxed settings show their posture and Restore strict changes only that field",async({page})=>{
 const puts=await setup(page);await page.getByLabel("Jailbreak finding threshold",{exact:true}).fill("5");await page.getByRole("button",{name:"Save detection thresholds",exact:true}).click();
 await expect(page.getByText("Relaxed",{exact:true})).toBeVisible();await expect(page.getByText(/requires step-up authentication/)).toBeVisible();
 await page.getByRole("button",{name:"Restore strict jailbreak finding threshold",exact:true}).click();await page.getByRole("button",{name:"Save detection thresholds",exact:true}).click();
 await expect(page.getByText("Relaxed",{exact:true})).toHaveCount(0);expect(puts).toEqual([{monitorJailbreakThreshold:5},{monitorJailbreakThreshold:3}]);
});
