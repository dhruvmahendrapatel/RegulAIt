import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {agents,createDb,runMigrations,withAiBomSubjectSessionLock,BOM_SUBJECT_LOCK_NAMESPACE,sql} from "../../../packages/db/dist/index.js";
import {buildAiBom,bomCanonicalBytes,bomJsonSafeIssues} from "../../../packages/shared/dist/index.js";
import {loadAiBomRecords} from "../../../apps/gateway/dist/ai-bom.js";
const require = createRequire(new URL("../../../packages/db/package.json",import.meta.url));
const {Pool}=require("pg");
const url=process.env.DATABASE_URL;
assert.equal(new URL(url!).pathname,"/regulait_review_x47_314_oct10b","scratch DB only");
const pool=new Pool({connectionString:url,ssl:false});
const db=createDb(url!);
let pass=0,fail=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();pass++;console.log(`PASS ${name}`)}catch(e){fail++;console.log(`RED ${name}: ${(e as Error).message}`)}}
async function rollback(fn:(c:any)=>Promise<void>){const c=await pool.connect();try{await c.query("BEGIN");await fn(c)}finally{await c.query("ROLLBACK");c.release()}}
try{
 await runMigrations(db,new URL("../../../packages/db/migrations",import.meta.url).pathname);
 for(const sample of [{" ":"é漢字😀",z:["\b\f\n\r\t\\\"/",true,null,9007199254740991,-9007199254740991]}, {a:0,b:{x:"\u2028\u2029"}},[]]){
 await test("SQL/RFC8785 exact bytes "+pass,async()=>{const r=await pool.query("select regulait_canonical_json($1::jsonb) as bytes,regulait_bom_json_safe($1::jsonb) as safe",[JSON.stringify(sample)]);assert.equal(r.rows[0].safe,true);assert.equal(bomJsonSafeIssues(sample).length,0);assert.equal(r.rows[0].bytes,bomCanonicalBytes(sample))})}
 await test("SQL refuses unsafe fraction/exponent/Unicode key",async()=>{for(const raw of ['{"a":1.5}','{"a":1e21}','{"é":1}']){const r=await pool.query("select regulait_bom_json_safe($1::jsonb) as safe",[raw]);assert.equal(r.rows[0].safe,false)}});
 for(const statement of ["UPDATE decision_capture_status SET status='capture_off' WHERE audit_seq=900000001","DELETE FROM decision_capture_status WHERE audit_seq=900000001","TRUNCATE decision_capture_status"]){await test("append-only refusal: "+statement.split(" ")[0],async()=>rollback(async c=>{await c.query("INSERT INTO decision_capture_status(audit_id,audit_seq,audit_at,status,expires_at) VALUES(gen_random_uuid(),900000001,now()-interval '2 days','capture_off',now()+interval '1 day')");await assert.rejects(c.query(statement),/append-only|TRUNCATE|UPDATE refused/)}))}
 await test("future-dated prune refused",async()=>rollback(async c=>{await assert.rejects(c.query("INSERT INTO bom_retention_prunes(as_of) VALUES(now()+interval '1 day')"),/future refused/)}));
 await test("unexpired marker cannot be pruned even with same-transaction pass",async()=>rollback(async c=>{await c.query("INSERT INTO decision_capture_status(audit_id,audit_seq,audit_at,status,expires_at) VALUES(gen_random_uuid(),900000001,now()-interval '2 days','capture_off',now()+interval '1 day')");await c.query("INSERT INTO bom_retention_prunes(as_of) VALUES(now())");await assert.rejects(c.query("DELETE FROM decision_capture_status WHERE audit_seq=900000001"),/within its retention/)}));
 await test("unbounded marker cannot be pruned",async()=>rollback(async c=>{await c.query("INSERT INTO decision_capture_status(audit_id,audit_seq,audit_at,status) VALUES(gen_random_uuid(),900000001,now()-interval '2 days','capture_off')");await c.query("INSERT INTO bom_retention_prunes(as_of) VALUES(now())");await assert.rejects(c.query("DELETE FROM decision_capture_status WHERE audit_seq=900000001"),/within its retention/)}));
 await test("expired marker prunes with same-transaction pass",async()=>rollback(async c=>{await c.query("INSERT INTO decision_capture_status(audit_id,audit_seq,audit_at,status,expires_at) VALUES(gen_random_uuid(),900000001,now()-interval '2 days','capture_off',now()-interval '1 day')");await c.query("INSERT INTO bom_retention_prunes(as_of) VALUES(now())");assert.equal((await c.query("DELETE FROM decision_capture_status WHERE audit_seq=900000001")).rowCount,1)}));
 await test("RR receipt boundary insertion refused",async()=>rollback(async c=>{await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");await assert.rejects(c.query("INSERT INTO receipt_payload_versions(version,from_audit_seq) VALUES(2,900000001)"),/READ COMMITTED/)}));
 await test("persisted agent model secret is refused or absent after actual loader",async()=>{
  await db.transaction(async tx=>{
   const secret=["sk", "abcdefghijklmnopqrstuvwxyz012345"].join("-");
   const [a]=await tx.insert(agents).values({name:"x41-synthetic",provider:"mock",model:secret,tier:1,lifecycleStatus:"active"}).returning();
   const records=await loadAiBomRecords(tx as unknown as Parameters<typeof loadAiBomRecords>[0],{kind:"agent",id:a!.id},{personIdentifiers:"id_only",installId:null});
   const b=buildAiBom(records,{id:"00000000-0000-4000-8000-000000000099",subjectKind:"agent",subjectId:a!.id,version:1,supersedes:null,trigger:"on_demand",createdAt:"2026-10-10T12:00:00.000Z"},{cyclonedxVersions:["1.7","1.6"]});
   assert.equal([b.bodyBytes,...b.renderings.map(r=>r.bytes)].join("\n").includes(secret),false,"persisted recognised credential survived real loader and signed bytes");
   throw new Error("control rollback");
  }).catch(e=>{if(e.message==="control rollback" || (e.name==="AiBomRecordError" && e.message.includes("credential")))return;throw e;});
 });
 await test("session advisory lock is acquired before repeatable-read snapshot",async()=>{
  await pool.query("CREATE TABLE x41_lock_control(value integer)");
  const blocker=await pool.connect();let capture:any;
  try{await blocker.query("BEGIN");await blocker.query("select pg_advisory_xact_lock($1::int,hashtext($2))",[BOM_SUBJECT_LOCK_NAMESPACE,"agent:x41-synthetic"]);
   capture=withAiBomSubjectSessionLock(db,"agent","x41-synthetic",async bound=>bound.transaction(async tx=>{const r=await tx.execute(sql`select value from x41_lock_control`);return (r as any).rows},{isolationLevel:"repeatable read"}));
   let waiting=false;
   for(let i=0;i<200;i++){const r=await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select pg_advisory_lock%'");if(r.rowCount){waiting=true;break}await new Promise(r=>setTimeout(r,10))}
   assert.equal(waiting,true,"actual DB wait observed before releasing blocker");await blocker.query("INSERT INTO x41_lock_control VALUES(7)");await blocker.query("COMMIT");assert.deepEqual(await capture,[{value:7}]);
  }finally{await blocker.query("ROLLBACK");blocker.release();if(capture)await capture.catch(()=>{});await pool.query("DROP TABLE x41_lock_control")}
 });
}finally{await pool.end();await (db.$client as any).end()}
console.log(JSON.stringify({pass,fail}));process.exitCode=fail?1:0;
