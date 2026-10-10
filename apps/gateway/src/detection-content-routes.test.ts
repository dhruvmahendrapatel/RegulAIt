/** Actual app/auth/settings with a disposable migrated PostgreSQL database. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDb, eq, orgSettings, ORG_SETTINGS_ID, runMigrations, sql, type Db } from "@regulait/db";
import { VENDORED_PACK_MANIFESTS } from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";
const base=process.env.DATABASE_URL;
const name=`regulait_x23_${process.pid}_${Date.now()}`;
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../..");
let db:Db, control:Db, app:ReturnType<typeof buildApp>, restore:(()=>Promise<void>)|undefined;
const boot={authorization:"Bearer x23-synthetic-bootstrap"};
let member:Record<string,string>;
describe.skipIf(!base)("X23 manifest on real app and database",()=>{
 beforeAll(async()=>{
  control=createDb(base!); await control.execute(sql.raw(`CREATE DATABASE "${name}"`));
  const url=new URL(base!);url.pathname=`/${name}`;db=createDb(url.toString());
  await runMigrations(db,path.join(root,"packages/db/migrations"));
  restore=await relaxIdentityForTest(db,{mfaRequired:"off"});
  app=buildApp(db,{bootstrapToken:"x23-synthetic-bootstrap",dataKey:"a".repeat(64)});
  const user=await app.inject({method:"POST",url:"/v1/users",headers:boot,payload:{email:"x23-member@example.test",displayName:"Synthetic member",isAdmin:false}});expect(user.statusCode).toBe(201);
  const key=await app.inject({method:"POST",url:`/v1/users/${user.json().id}/keys`,headers:boot,payload:{name:"X23 fixture"}});expect(key.statusCode).toBe(201);member={authorization:`Bearer ${key.json().token}`};
 },120000);
 afterAll(async()=>{await app?.close();await restore?.();await db?.$client.end();if(control){await dropScratchDatabase(control,name);await control.$client.end();}});
 it("reports pinned manifests and real strict settings with the outbound audience enforced (decision 30)",async()=>{
  const result=await app.inject({method:"GET",url:"/v1/detection-content",headers:boot});expect(result.statusCode).toBe(200);
  const body=result.json();expect(body.outboundAudienceEnforced).toBe(true);expect(body.outboundCredentialAudience).toBe("enforce");expect(body.packs).toHaveLength(4);
  for(const pack of body.packs){expect(pack.enabled).toBe(true);expect(pack.commit).toMatch(/^[a-f0-9]{40}$/);expect(pack.sha256).toMatch(/^[a-f0-9]{64}$/);expect(pack.rules).toBe(VENDORED_PACK_MANIFESTS.find(p=>p.id===pack.id)!.rules);}
  expect(body.packs.find((p:{id:string})=>p.id==="nemo-yara-injection").notImported).toHaveLength(5);
 });
 it("reads changed selection while audit redaction remains unconditional",async()=>{
  await db.update(orgSettings).set({vendoredDetectionPacks:[]}).where(eq(orgSettings.id,ORG_SETTINGS_ID));
  try{const body=(await app.inject({method:"GET",url:"/v1/detection-content",headers:boot})).json();expect(body.packs.every((p:{enabled:boolean})=>!p.enabled)).toBe(true);expect(body.packs.find((p:{id:string})=>p.id==="pipelock-secrets").auditRedactionAlways).toBe(true);
   // with the secrets pack off nothing can match, so enforcement is not claimed
   expect(body.outboundAudienceEnforced).toBe(false);}
  finally{await db.update(orgSettings).set({vendoredDetectionPacks:["pipelock-secrets","pipelock-normalise","nemo-yara-injection","agt-mcp-heuristics"]}).where(eq(orgSettings.id,ORG_SETTINGS_ID));}
 });
 it("requires administrator authentication",async()=>{
  expect((await app.inject({method:"GET",url:"/v1/detection-content"})).statusCode).toBe(401);
  expect((await app.inject({method:"GET",url:"/v1/detection-content",headers:member})).statusCode).toBe(403);
 });
});
