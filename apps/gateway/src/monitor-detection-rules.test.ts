/** Real migrated database; only the suite-owned scratch DB is dropped. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aiUseCases, auditLog, configActivationEvents, configVersions, createDb, decisions, eq, governanceAlerts, orgSettings, ORG_SETTINGS_ID, runMigrations, sql, users, workflowInstances, type Db } from "@regulait/db";
import { detectionMonitorInput } from "./monitor-detection-rules.js";
import { runGovernanceMonitor } from "./governance-monitor.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";
const base=process.env.DATABASE_URL,name=`regulait_x24_${process.pid}_${Date.now()}`;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
const now=new Date("2026-10-07T22:00:00Z"), at=(hours:number)=>new Date(now.getTime()+hours*3600000);
let db:Db,control:Db,userId:string;
async function entry(value:Partial<typeof auditLog.$inferInsert>={}){
 const [row]=await db.insert(auditLog).values({userId,at:at(-1),objectType:"mcp_tool",effect:"allow",ruleId:"fixture-decision",ruleChain:[],reason:"PRIVATE FIXTURE REASON",...value}).returning();return row!;
}
async function promptFixture(){
 const agentId=randomUUID();const [instance]=await db.insert(workflowInstances).values({templateIds:[],definition:{stages:[]},initiatorUserId:userId,change:{},state:{},status:"completed"}).returning();
 const [useCase]=await db.insert(aiUseCases).values({name:"Synthetic use case",description:"PRIVATE FIXTURE DESCRIPTION",businessContext:"PRIVATE FIXTURE CONTEXT",ownerUserId:userId,intendedAgentIds:[agentId],dataSensitivity:"internal",status:"approved",workflowInstanceId:instance!.id}).returning();
 await db.insert(decisions).values({objectType:"workflow_instance",objectId:instance!.id,decision:"approved",decisionMakerUserId:userId,createdAt:at(-2)});
 const [v1]=await db.insert(configVersions).values({artifactType:"agent_system_prompt",artifactId:agentId,version:1,body:{systemPrompt:"PRIVATE PROMPT ONE"},status:"superseded",createdAt:at(-10)}).returning();
 const [v2]=await db.insert(configVersions).values({artifactType:"agent_system_prompt",artifactId:agentId,version:2,body:{systemPrompt:"PRIVATE PROMPT TWO"},status:"active",createdAt:at(-1)}).returning();
 await db.insert(configActivationEvents).values([{artifactType:"agent_system_prompt",artifactId:agentId,versionId:v1!.id,version:1,action:"activated",at:at(-10)},{artifactType:"agent_system_prompt",artifactId:agentId,versionId:v2!.id,version:2,fromVersionId:v1!.id,fromVersion:1,action:"activated",at:at(-1)}]);
 return {agentId,useCaseId:useCase!.id,v1:v1!,v2:v2!,instanceId:instance!.id};
}
describe.skipIf(!base)("X24 measured detection monitor inputs",()=>{
 beforeAll(async()=>{
  control=createDb(base!);await control.execute(sql.raw(`CREATE DATABASE "${name}"`));const url=new URL(base!);url.pathname=`/${name}`;db=createDb(url.toString());
  await runMigrations(db,path.join(root,"packages/db/migrations"));const [user]=await db.insert(users).values({email:"x24@example.test",displayName:"Synthetic owner"}).returning();userId=user!.id;
 },120000);
 afterAll(async()=>{await db?.$client.end();if(control){await dropScratchDatabase(control,name);await control.$client.end();}});
 it("detects recent attributed servers absent from the separate baseline window",async()=>{
  const agent=randomUUID(),known=randomUUID(),fresh=randomUUID();
  await entry({serverId:known,toolName:"fixture",at:at(-48),detail:{builderAgentId:agent}});
  await entry({serverId:known,toolName:"fixture",detail:{builderAgentId:agent}});
  await entry({serverId:fresh,toolName:"fixture",detail:{builderAgentId:agent}});
  await entry({serverId:randomUUID(),toolName:"fixture",at:at(1),detail:{builderAgentId:agent}});
  const result=await detectionMonitorInput(db,now);const breaches=result.mcp_server_baseline_drift!.breaches;
  expect(breaches.map(b=>b.subjectKey)).toContain(`builder_agent:${agent}>mcp_server:${fresh}`);
  expect(breaches.map(b=>b.subjectKey)).not.toContain(`builder_agent:${agent}>mcp_server:${known}`);
  expect(JSON.stringify(result)).not.toContain("PRIVATE FIXTURE");
 });
 it("observes scope widening and holds recipient edits with no prior recipient snapshot",async()=>{
  const agent=randomUUID(),unknown=randomUUID(),skill=randomUUID();
  await entry({objectType:"builder_agent",objectId:agent,ruleId:"builder-agent-sharing-changed",detail:{from:"private",to:"workspace"}});
  await entry({objectType:"builder_agent",objectId:unknown,ruleId:"builder-agent-sharing-changed",detail:{from:"people",to:"people",sharedUserIds:[randomUUID()]}});
  await entry({objectType:"builder_skill",objectId:skill,ruleId:"builder-skill-visibility-approved",detail:{from:"private",requested:"workspace",reason:"PRIVATE SHARE REASON"}});
  const result=(await detectionMonitorInput(db,now)).sharing_scope_widened!;
  expect(result.breaches.map(b=>b.subjectKey)).toEqual(expect.arrayContaining([`builder_agent:${agent}`,`builder_skill:${skill}`]));
  expect(result.heldSubjectKeys).toContain(`builder_agent:${unknown}`);
  expect(JSON.stringify(result)).not.toContain("PRIVATE SHARE");
 });
 it("detects added selected recipients while narrowing alone contributes no widening",async()=>{
  const agent=randomUUID(),narrow=randomUUID(),first=randomUUID(),added=randomUUID();
  await entry({at:at(-3),objectType:"builder_agent",objectId:agent,ruleId:"builder-agent-sharing-changed",detail:{from:"private",to:"people",sharedUserIds:[first]}});
  await entry({objectType:"builder_agent",objectId:agent,ruleId:"builder-agent-sharing-changed",detail:{from:"people",to:"people",sharedUserIds:[first,added]}});
  await entry({objectType:"builder_agent",objectId:narrow,ruleId:"builder-agent-sharing-changed",detail:{from:"workspace",to:"private"}});
  const result=(await detectionMonitorInput(db,now)).sharing_scope_widened!;
  expect(result.breaches.find(b=>b.subjectKey===`builder_agent:${agent}`)?.detail.addedRecipients).toBe(1);
  expect(result.breaches.find(b=>b.subjectKey===`builder_agent:${narrow}`)).toBeUndefined();
 });
 it("compares the active version to actual approving-decision history, then respects reapproval",async()=>{
  const f=await promptFixture(),key=`use_case:${f.useCaseId}>agent:${f.agentId}`;
  let result=(await detectionMonitorInput(db,now)).instructions_changed_after_approval!;
  expect(result.breaches.find(b=>b.subjectKey===key)?.detail).toMatchObject({approvedVersionId:f.v1.id,activeVersionId:f.v2.id});
  expect(JSON.stringify(result)).not.toContain("PRIVATE PROMPT");
  await db.insert(decisions).values({objectType:"workflow_instance",objectId:f.instanceId,decision:"approved",decisionMakerUserId:userId,createdAt:at(-0.5)});
  result=(await detectionMonitorInput(db,now)).instructions_changed_after_approval!;expect(result.breaches.find(b=>b.subjectKey===key)).toBeUndefined();expect(result.heldSubjectKeys).not.toContain(key);
 });
 it("holds missing/ambiguous historical versions instead of treating them as unchanged",async()=>{
  const f=await promptFixture(),key=`use_case:${f.useCaseId}>agent:${f.agentId}`;
  await db.insert(configActivationEvents).values({artifactType:"agent_system_prompt",artifactId:f.agentId,versionId:f.v2.id,version:2,action:"activated",at:at(-10)});
  expect((await detectionMonitorInput(db,now)).instructions_changed_after_approval!.heldSubjectKeys).toContain(key);
  const noHistory=randomUUID();await db.update(aiUseCases).set({intendedAgentIds:[noHistory]}).where(eq(aiUseCases.id,f.useCaseId));
  expect((await detectionMonitorInput(db,now)).instructions_changed_after_approval!.heldSubjectKeys).toContain(`use_case:${f.useCaseId}>agent:${noHistory}`);
 });
 it("requires threshold findings followed by an allowed call by the same person",async()=>{
  const who=randomUUID(),before=randomUUID();
  const findings=(count:number)=>({guardrail:{findings:[{detector:"jailbreak",category:"persona",count,mode:"block"}]}});
  await entry({userId:who,at:at(-4),objectType:"agent",ruleId:"guardrail-blocked",effect:"deny",detail:findings(2)});
  await entry({userId:who,at:at(-3),toolName:"before_threshold",serverId:randomUUID()});
  await entry({userId:who,at:at(-2),objectType:"agent",ruleId:"guardrail-blocked",effect:"deny",detail:findings(1)});
  await entry({userId:who,at:at(-1),toolName:"after_threshold",serverId:randomUUID()});
  await entry({userId:before,at:at(-3),toolName:"before_findings",serverId:randomUUID()});
  await entry({userId:before,at:at(-2),objectType:"agent",ruleId:"guardrail-blocked",effect:"deny",detail:findings(3)});
  let result=(await detectionMonitorInput(db,now)).jailbreak_correlation!;
  expect(result.breaches.find(b=>b.subjectKey===`user:${who}`)?.detail.allowedCallsAfterThreshold).toBe(1);expect(result.breaches.find(b=>b.subjectKey===`user:${before}`)).toBeUndefined();
  await db.update(orgSettings).set({monitorJailbreakWindowHours:1}).where(eq(orgSettings.id,ORG_SETTINGS_ID));
  try{expect((await detectionMonitorInput(db,now)).jailbreak_correlation!.breaches).toEqual([]);}finally{await db.update(orgSettings).set({monitorJailbreakWindowHours:24}).where(eq(orgSettings.id,ORG_SETTINGS_ID));}
 });
 it("raises one stable episode and preserves its identity across repeated real monitor passes",async()=>{
  const f=await promptFixture(),key=`use_case:${f.useCaseId}>agent:${f.agentId}`;
  await runGovernanceMonitor(db,{now,actorUserId:userId});
  const first=await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey,key));expect(first).toHaveLength(1);
  await runGovernanceMonitor(db,{now:new Date(now.getTime()+1000),actorUserId:userId});
  const again=await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey,key));expect(again).toHaveLength(1);expect(again[0]!.id).toBe(first[0]!.id);
  const noHistory=randomUUID();await db.update(aiUseCases).set({intendedAgentIds:[f.agentId,noHistory]}).where(eq(aiUseCases.id,f.useCaseId));
  await db.update(configVersions).set({status:"draft"}).where(eq(configVersions.id,f.v2.id));
  await runGovernanceMonitor(db,{now:new Date(now.getTime()+2000),actorUserId:userId});
  expect((await db.select().from(governanceAlerts).where(eq(governanceAlerts.subjectKey,key)))[0]!.status).toBe("open");
 });
 it("a malformed measured finding leaves all detection episodes unevaluated",async()=>{
  const open=await db.select().from(governanceAlerts).where(eq(governanceAlerts.status,"open"));
  const tracked=open.filter(row=>["mcp_server_baseline_drift","sharing_scope_widened","instructions_changed_after_approval","jailbreak_correlation"].includes(row.ruleId));expect(tracked.length).toBeGreaterThan(0);
  await entry({objectType:"agent",ruleId:"guardrail-blocked",effect:"deny",detail:{guardrail:{findings:"PRIVATE MALFORMED FINDING"}}});
  await expect(detectionMonitorInput(db,now)).rejects.toThrow("detection_monitor_findings_invalid");
  await runGovernanceMonitor(db,{now:new Date(now.getTime()+3000),actorUserId:userId});
  const after=await db.select().from(governanceAlerts);for(const row of tracked)expect(after.find(a=>a.id===row.id)?.status).toBe("open");
 });

});
