import path from "node:path";
import {fileURLToPath} from "node:url";
/** ADR-0367: real PostgreSQL and the real admin gate; no remote feed or model is contacted. */
import {afterAll,beforeAll,describe,it,expect,vi} from "vitest";
import {generateKeyPairSync,sign,randomUUID} from "node:crypto";
import {createDb,runMigrations,sql,auditLog,agentGrants,eq,type Db} from "@regulait/db";
import {buildApp} from "./app.js";
import {DETECTION_FEED_KEYS_ENV,verifyDetectionFeed,loadDetectionFeedRuntime} from "./detection-feed.js";
import {loadSignedBundleKeyring} from "./signed-bundle.js";
import {resolveGuardrailPolicy,runGuardrails} from "./guardrails.js";
import {relaxIdentityForTest} from "./testing/identity-posture.js";
import {relaxStepUpForTest} from "./testing/step-up-posture.js";
import {relaxGovernanceGatesForTest} from "./testing/governance-gates.js";
import {DETECTION_FEED_FORMAT} from "@regulait/shared";
const URL=process.env.DATABASE_URL;
if(!URL) throw new Error("DATABASE_URL required");
const RUN=randomUUID();
const BOOT=`feed-bootstrap-${RUN}`;
const boot={authorization:`Bearer ${BOOT}`};
const keys=generateKeyPairSync("ed25519");
const keyring=new Map([["feed-key",keys.publicKey]]);
const envBefore=process.env[DETECTION_FEED_KEYS_ENV];
const payload=(version:number,patch:Record<string,unknown>={})=>({format:DETECTION_FEED_FORMAT,feedId:"public-feed",version,source:{id:"public-rules",licence:"MIT"},kind:"prompt_injection",rules:[{id:"public.one",category:"sample",patterns:["synthetic amber lattice"],minMatches:1}],...patch});
const signed=(value:unknown)=>{const bundle=typeof value==="string"?value:JSON.stringify(value);return {bundle,signature:sign(null,Buffer.from(bundle),keys.privateKey).toString("base64"),keyId:"feed-key"};};
let db:Db;
let app:ReturnType<typeof buildApp>;
let auth:Record<string,string>;
let restoreIdentity:()=>Promise<void>;
let restoreStepUp:(()=>Promise<void>)|undefined;
let restoreGates:()=>Promise<void>;
let agentId:string;
let adminId:string;
const invoke=()=>app.inject({method:"POST",url:`/v1/agents/${agentId}/invoke`,headers:auth,payload:{mode:"execute",input:"synthetic amber lattice",dispatch:true}});
const usage=async()=>Number((await db.execute(sql`SELECT count(*) AS n FROM usage_events WHERE user_id=${adminId}`)).rows[0]!.n);
const post=(body:unknown)=>app.inject({method:"POST",url:"/v1/detection-content/feed/import",headers:auth,payload:body as object});
const read=async()=>{const r=await db.execute(sql`SELECT * FROM detection_feed WHERE id=true`);return r.rows[0]!;};
beforeAll(async()=>{
 process.env[DETECTION_FEED_KEYS_ENV]=JSON.stringify([{keyId:"feed-key",publicKeyPem:keys.publicKey.export({format:"pem",type:"spki"})}]);
 db=createDb(URL);
 await runMigrations(db,path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../../../packages/db/migrations"));
 restoreIdentity=await relaxIdentityForTest(db,{mfaRequired:"off"});
 app=buildApp(db,{bootstrapToken:BOOT,dataKey:"b".repeat(64)});
 const user=await app.inject({method:"POST",url:"/v1/users",headers:boot,payload:{email:`feed-${RUN}@example.invalid`,displayName:"synthetic feed fixture",isAdmin:true}});
 expect(user.statusCode,user.body).toBe(201);
 const key=await app.inject({method:"POST",url:`/v1/users/${user.json().id}/keys`,headers:boot,payload:{name:"feed fixture"}});
 expect(key.statusCode,key.body).toBe(201);
 auth={authorization:`Bearer ${key.json().token}`};
 adminId=user.json().id;
 restoreGates=await relaxGovernanceGatesForTest(db,{mrmEnforced:false,dispatchAttributionRequired:false});
 const created=await app.inject({method:"POST",url:"/v1/agents",headers:boot,payload:{name:`feed-fixture-${RUN}`,provider:"mock",model:"mock-balanced",tier:1,costPerMTokIn:1,costPerMTokOut:1}});
 expect(created.statusCode,created.body).toBe(201);agentId=created.json().id;
 await db.insert(agentGrants).values({userId:adminId,agentId});
},120000);
afterAll(async()=>{
 await restoreStepUp?.();await restoreIdentity?.();await restoreGates?.();
 if(envBefore===undefined) delete process.env[DETECTION_FEED_KEYS_ENV];else process.env[DETECTION_FEED_KEYS_ENV]=envBefore;
 await app?.close();await db?.$client.end();vi.restoreAllMocks();
});

describe("pinned signature before parsing",()=>{
 it("rejects tampering, wrong key, wrong purpose and unsupported rules without partial success",()=>{
  expect(verifyDetectionFeed(signed(payload(1)),keyring).ok).toBe(true);
  expect(verifyDetectionFeed({...signed(payload(1)),bundle:JSON.stringify(payload(2))},keyring)).toMatchObject({ok:false,code:"bad_signature"});
  expect(verifyDetectionFeed({...signed(payload(1)),keyId:"unknown"},keyring)).toMatchObject({ok:false,code:"unknown_key"});
  expect(verifyDetectionFeed(signed(payload(1,{format:"regulait.mcp-catalogue-bundle/v1"})),keyring)).toMatchObject({ok:false,code:"invalid_rules"});
  expect(verifyDetectionFeed({...signed("not json"),signature:"AA=="},keyring)).toMatchObject({ok:false,code:"bad_signature"});
  expect(verifyDetectionFeed(signed("not json"),keyring)).toMatchObject({ok:false,code:"invalid_document"});
  expect(verifyDetectionFeed(signed(payload(1,{kind:"secret"})),keyring)).toMatchObject({ok:false,code:"invalid_rules"});
  expect(loadSignedBundleKeyring("INLINE","FILE","fixture",{INLINE:JSON.stringify([{keyId:"duplicate",publicKeyPem:keys.publicKey.export({format:"pem",type:"spki"})},{keyId:"duplicate",publicKeyPem:keys.publicKey.export({format:"pem",type:"spki"})}])})).not.toBeInstanceOf(Map);
 });
});

describe("offline feed import and effective policy",()=>{
 it("is admin-only and initially off with no installed rules",async()=>{
  const denied=await app.inject({method:"POST",url:"/v1/detection-content/feed/import",payload:signed(payload(1))});
  expect(denied.statusCode).toBe(401);
  const state=await app.inject({method:"GET",url:"/v1/detection-content/feed",headers:auth});
  expect(state.json()).toMatchObject({enabled:false,available:false,version:0});
  expect(await loadDetectionFeedRuntime(db)).toBeUndefined();
  const before=await usage();const baseline=await invoke();
  expect(baseline.statusCode,baseline.body).toBe(200);expect(await usage()).toBe(before+1);
 });
 it("audits refusals and imports atomically without a network request",async()=>{
  const fetch=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("network must not run"));
  const refused=await post({...signed(payload(1)),signature:"AA=="});
  expect(refused.statusCode).toBe(400);
  const accepted=await post(signed(payload(1)));
  expect(accepted.statusCode,accepted.body).toBe(200);
  expect(accepted.json()).toMatchObject({installed:true,enabled:false,version:1});
  expect(await loadDetectionFeedRuntime(db)).toBeUndefined();
  expect((await read()).version).toBe("1");
  const audits=await db.select().from(auditLog).where(eq(auditLog.ruleId,"detection-feed-import"));
  expect(audits.some(r=>r.effect==="deny")).toBe(true);
  expect(audits.some(r=>r.effect==="allow")).toBe(true);
  expect(JSON.stringify(audits)).not.toContain("synthetic amber lattice");
  expect(fetch).not.toHaveBeenCalled();fetch.mockRestore();
 });
 it("requires fresh step-up to enable, then loads an actual additional block",async()=>{
  const denied=await app.inject({method:"PUT",url:"/v1/detection-content/feed/settings",headers:auth,payload:{enabled:true}});
  expect(denied.statusCode).toBe(403);
  restoreStepUp=await relaxStepUpForTest(db);
  const on=await app.inject({method:"PUT",url:"/v1/detection-content/feed/settings",headers:auth,payload:{enabled:true}});
  expect(on.statusCode,on.body).toBe(200);
  const policy=await resolveGuardrailPolicy(db,{});
  const result=runGuardrails(policy,"input","synthetic amber lattice");
  expect(result.action).toBe("block");
  expect(result.findings.some(f=>f.hits.some(h=>h.category==="feed.sample"))).toBe(true);
  expect(runGuardrails(policy,"input","ordinary synthetic text").action).toBe("allow");
  const before=await usage();const blocked=await invoke();
  expect(blocked.statusCode,blocked.body).toBe(403);expect(blocked.json().error).toBe("guardrail_blocked");
  expect(await usage()).toBe(before);
 });
 it("rejects replay, downgrade and another feed without changing the accepted bytes",async()=>{
  const installed=await read();
  for(const body of [signed(payload(1)),signed(payload(1,{source:{id:"changed",licence:"MIT"}})),signed(payload(2,{feedId:"different-stream"}))])
   expect((await post(body)).statusCode).toBe(409);
  expect((await read()).digest).toBe(installed.digest);
  expect((await post(signed(payload(2)))).statusCode).toBe(200);
  expect((await post(signed(payload(1)))).json()).toMatchObject({code:"downgrade"});
 });
 it("serializes concurrent version updates and never lowers the watermark",async()=>{
  const both=await Promise.all([post(signed(payload(3))),post(signed(payload(4)))]);
  expect(both.some(r=>r.statusCode===200)).toBe(true);
  expect(Number((await read()).version)).toBe(4);
 });
 it("fails closed on corruption and trust removal, even if the normal detector mode is off",async()=>{
  const original=await read();
  await db.execute(sql`UPDATE detection_feed SET bundle='{}' WHERE id=true`);
  let policy=await resolveGuardrailPolicy(db,{});
  expect(policy.active).toBe(true);expect(policy.blocksInput).toBe(true);expect(policy.blocksOutput).toBe(true);
  expect(runGuardrails(policy,"input","ordinary text").action).toBe("block");
  await db.execute(sql`UPDATE detection_feed SET bundle=${original.bundle as string} WHERE id=true`);
  process.env[DETECTION_FEED_KEYS_ENV]="[]";
  policy=await resolveGuardrailPolicy(db,{});
  expect(runGuardrails(policy,"input","ordinary text").action).toBe("block");
  process.env[DETECTION_FEED_KEYS_ENV]=JSON.stringify([{keyId:"feed-key",publicKeyPem:keys.publicKey.export({format:"pem",type:"spki"})}]);
 });
 it("rolls the policy update back when its audit cannot commit",async()=>{
  await db.execute(sql`CREATE FUNCTION c2_test_refuse_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$ BEGIN IF NEW.rule_id='detection-feed-import' AND NEW.detail->>'code'='installed' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
  await db.execute(sql`CREATE TRIGGER c2_test_refuse_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION c2_test_refuse_audit()`);
  try {
    const original=await read();const failed=await post(signed(payload(5)));
    expect(failed.statusCode).toBe(500);expect((await read()).digest).toBe(original.digest);expect(Number((await read()).version)).toBe(4);
  } finally {await db.execute(sql`DROP TRIGGER c2_test_refuse_audit ON audit_log`);await db.execute(sql`DROP FUNCTION c2_test_refuse_audit()`);}
 });
 it("allows policy reads but refuses an unscoped application role's changes",async()=>{
  const client=await db.$client.connect();await client.query("BEGIN");
  try {
   await client.query("SET LOCAL ROLE regulait_app");
   expect((await client.query("SELECT id FROM detection_feed")).rowCount).toBe(1);
   expect((await client.query("UPDATE detection_feed SET enabled=false RETURNING id")).rowCount).toBe(0);
  } finally {await client.query("ROLLBACK");client.release();}
 });
 it("disables without clearing the signed version or admitting a downgrade",async()=>{
  const off=await app.inject({method:"PUT",url:"/v1/detection-content/feed/settings",headers:auth,payload:{enabled:false}});
  expect(off.statusCode,off.body).toBe(200);
  expect(await loadDetectionFeedRuntime(db)).toBeUndefined();
  expect(Number((await read()).version)).toBe(4);
  expect((await post(signed(payload(2)))).statusCode).toBe(409);
 });
});
