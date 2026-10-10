// X53 independent PostgreSQL/HTTP controls for frozen PR322.
// B9D-01 checks the newer board's declaration-only entry condition, not the
// frozen ADR R51's explicitly permitted fallback. EXPECT_FIXED=1 makes it a gate.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { agents, modelCards, trainingDatasets, evalDatasets, createDb, runMigrations, sql } from '../../../packages/db/dist/index.js';
import { buildAiBom, validateSpdx } from '../../../packages/shared/dist/index.js';
import { buildApp } from '../../../apps/gateway/dist/app.js';
import { loadAiBomRecords } from '../../../apps/gateway/dist/ai-bom.js';
import { relaxIdentityForTest } from '../../../apps/gateway/dist/testing/identity-posture.js';
const require=createRequire(new URL('../../../packages/db/package.json',import.meta.url));
const {Pool}=require('pg');
const url=process.env.DATABASE_URL!;
assert.equal(new URL(url).pathname,'/regulait_review_x53_oct10b','own scratch database only');
const pool=new Pool({connectionString:url,ssl:false});const db=createDb(url);
let app:any;let pass=0,fail=0,findings=0;
async function test(name:string,fn:()=>Promise<void>){try{await fn();pass++;console.log(`PASS ${name}`)}catch(e){fail++;console.log(`FAIL ${name}: ${(e as Error).message}`)}}
async function transaction(fn:(c:any)=>Promise<void>){const c=await pool.connect();try{await c.query('BEGIN');await fn(c)}finally{await c.query('ROLLBACK');c.release()}}
const boot='x53-synthetic-bootstrap';const auth={authorization:`Bearer ${boot}`};
const route=(kind:string,id:string,property?:string)=>`/v1/ai-bom/spdx-fields/${kind}/${id}${property?'/'+property:''}`;
const request=(method:string,url:string,headers:any,payload?:any)=>app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
let card:string,card2:string,agent:string,training:string,evaluation:string,user:string;let member:any;
const declarationCount=async()=>Number((await pool.query('select count(*) as n from ai_bom_spdx_declarations')).rows[0].n);
const auditCount=async()=>Number((await pool.query("select count(*) as n from audit_log where rule_id in ('ai-bom-spdx-field-declared','ai-bom-spdx-field-withdrawn')")).rows[0].n);
const put=(property:string,value:any)=>request('PUT',route('model_card',card,property),auth,{value,source:'supplier_declared'});
const snapshot=async()=>{
  const records=await db.transaction((tx:any)=>loadAiBomRecords(tx,{kind:'agent',id:agent},{personIdentifiers:'id_only',installId:null}),{isolationLevel:'repeatable read'});
  return buildAiBom(records,{id:'00000000-0000-4000-8000-000000000053',subjectKind:'agent',subjectId:agent,version:1,supersedes:null,trigger:'on_demand',createdAt:'2026-10-10T12:00:00.000Z'},{cyclonedxVersions:['1.7']});
};
try{
  await runMigrations(db,new URL('../../../packages/db/migrations',import.meta.url).pathname);
  await relaxIdentityForTest(db,{mfaRequired:'off'});
  app=buildApp(db,{bootstrapToken:boot,dataKey:'c'.repeat(64)});
  const made=await request('POST','/v1/users',auth,{email:'x53-synthetic-member@example.test',displayName:'Synthetic X53 member',isAdmin:false});assert.equal(made.statusCode,201,made.body);user=made.json().id;
  const key=await request('POST',`/v1/users/${user}/keys`,auth,{name:'x53'});assert.equal(key.statusCode,201,key.body);member={authorization:`Bearer ${key.json().token}`};
  const [a]=await db.insert(agents).values({name:'X53 synthetic agent',provider:'mock',model:'synthetic',tier:1,lifecycleStatus:'active'}).returning();agent=a!.id;
  const [c]=await db.insert(modelCards).values({agentId:agent,intendedUse:'X53 synthetic',pinnedModelVersion:'v1',dataClaims:{license:'Apache-2.0',releaseTime:'2026-01-01T00:00:00Z',downloadLocation:'https://old-claims.example'}}).returning();card=c!.id;
  const [a2]=await db.insert(agents).values({name:'X53 cascade agent',provider:'mock',model:'synthetic',tier:1,lifecycleStatus:'active'}).returning();
  const [c2]=await db.insert(modelCards).values({agentId:a2!.id,intendedUse:'X53 cascade'}).returning();card2=c2!.id;
  const [t]=await db.insert(trainingDatasets).values({name:'X53 synthetic training',version:1,checksum:`sha256:${'a'.repeat(64)}:1`,rowCount:1,piiVerdict:'clean'}).returning();training=t!.id;
  const [e]=await db.insert(evalDatasets).values({name:'X53 synthetic eval',version:1}).returning();evaluation=e!.id;
  await test('anonymous401 and member403 on GET/PUT/withdraw; no declarations',async()=>{
    const n=await declarationCount();for(const headers of [{},member])for(const [method,url,payload] of [['GET',route('model_card',card),undefined],['PUT',route('model_card',card,'releaseTime'),{value:'2026-01-01T00:00:00Z',source:'admin_entered'}],['POST',route('model_card',card,'releaseTime')+'/withdraw',{}]]){
      const r=await request(method as string,url as string,headers,payload);assert.equal(r.statusCode,headers===member?403:401,r.body);
    }assert.equal(await declarationCount(),n);
  });
  for(const [value,label] of [['http://x.example','http'],['https://x.example/private?token=X53_CANARY','path/query'],['https://x.example#X53_CANARY','fragment'],['https://svc:X53_CANARY@x.example','userinfo'],['https://x.example/','slash'],['https://x.example.é','unicode'],['https://x.example:99999','invalid-port']]){
    await test(`download refuses ${label} without value echo or writes`,async()=>{const n=await declarationCount(),audits=await auditCount();const r=await put('downloadLocation',value);assert.equal(r.statusCode,422,r.body);assert.equal(r.body.includes(value),false);assert.equal(r.body.includes('X53_CANARY'),false);assert.equal(await declarationCount(),n);assert.equal(await auditCount(),audits)});
  }
  await test('unknown source/property and fractional time are value-free refusals',async()=>{
    for(const [property,body,status] of [['releaseTime',{value:'X53_CANARY',source:'X53_CANARY'},400],['X53_CANARY',{value:'X53_CANARY',source:'admin_entered'},422],['releaseTime',{value:'2026-01-01T00:00:00.5Z',source:'admin_entered'},422]]){
      const r=await request('PUT',route('model_card',card,property as string),auth,body);assert.equal(r.statusCode,status,r.body);assert.equal(r.body.includes('X53_CANARY'),false);
    }
  });
  await test('newer board declaration-only entry condition: undeclared legacy claims do not render',async()=>{
    const b=await snapshot();const s=b.body.renderings['spdx-3.0.1'];
    if(s.status==='rendered'){
      const doc=JSON.parse(b.renderings.find(r=>r.format==='spdx-3.0.1')!.bytes);assert.equal(validateSpdx(doc).valid,true);
      console.log('REPRODUCED B9D-01: no declaration exists, yet legacy data_claims produce schema-valid SPDX');findings++;
      if(process.env.EXPECT_FIXED==='1')assert.fail('B9D-01 declarations-only requirement not implemented');
    }else assert.deepEqual(s,{status:'not_producible',missing:['ai_AIPackage.releaseTime','ai_AIPackage.software_downloadLocation']});
  });
  await test('valid declaration uses DB clock/provenance and one audit per write',async()=>{
    for(const [property,value] of [['releaseTime','2026-02-02T03:04:05+02:00'],['downloadLocation','https://declared.example:8443']]){
      const n=await declarationCount(),audits=await auditCount();const before=await pool.query('select clock_timestamp() as t');const r=await put(property,value);assert.equal(r.statusCode,200,r.body);assert.equal(await declarationCount(),n+1);assert.equal(await auditCount(),audits+1);assert.ok(new Date(r.json().declaration.declaredAt)>=before.rows[0].t);
      assert.equal(r.json().declaration.source,'supplier_declared');
    }
    const b=await snapshot();const d=JSON.parse(b.renderings.find(r=>r.format==='spdx-3.0.1')!.bytes);const model=d['@graph'].find((x:any)=>x.type==='ai_AIPackage');assert.equal(model.releaseTime,'2026-02-02T01:04:05Z');assert.equal(model.software_downloadLocation,'https://declared.example:8443');
  });
  await test('withdrawal audit/current view clears field; newer board requires exact missing names',async()=>{
    for(const property of ['releaseTime','downloadLocation']){const audits=await auditCount();const r=await request('POST',route('model_card',card,property)+'/withdraw',auth,{});assert.equal(r.statusCode,200,r.body);assert.equal(await auditCount(),audits+1);assert.equal((await request('POST',route('model_card',card,property)+'/withdraw',auth,{})).statusCode,409)}
    const view=(await request('GET',route('model_card',card),auth)).json();assert.equal(view.current.length,0);assert.ok(view.undeclared.includes('releaseTime'));assert.ok(view.undeclared.includes('downloadLocation'));
    const b=await snapshot();const s=b.body.renderings['spdx-3.0.1'];
    if(s.status==='rendered'){const d=JSON.parse(b.renderings.find(r=>r.format==='spdx-3.0.1')!.bytes);const model=d['@graph'].find((x:any)=>x.type==='ai_AIPackage');assert.equal(model.releaseTime,'2026-01-01T00:00:00Z');assert.equal(model.software_downloadLocation,'https://old-claims.example');console.log('REPRODUCED B9D-01: withdrawn fields silently revert to legacy claims while GET reports undeclared');findings++;if(process.env.EXPECT_FIXED==='1')assert.fail('B9D-01 withdrawal fallback remains');}
    else assert.deepEqual(s,{status:'not_producible',missing:['ai_AIPackage.releaseTime','ai_AIPackage.software_downloadLocation']});
  });
  await test('audit insert failure rolls declaration back atomically',async()=>{
    const n=await declarationCount();await pool.query("CREATE FUNCTION public.x53_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.rule_id='ai-bom-spdx-field-declared' THEN RAISE EXCEPTION 'x53 audit negative control'; END IF; RETURN NEW; END $$");
    await pool.query('CREATE TRIGGER x53_audit_control BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION public.x53_refuse_audit()');
    try{const r=await put('packageVersion','x53-v2');assert.equal(r.statusCode,500);assert.equal(await declarationCount(),n)}finally{await pool.query('DROP TRIGGER x53_audit_control ON audit_log');await pool.query('DROP FUNCTION public.x53_refuse_audit()')}
  });
  for(const [column,id] of [['model_card_id',card2],['training_dataset_id',training],['eval_dataset_id',evaluation]]){
    await test(`append-only + own parent cascade ${column}`,async()=>{
      const inserted=await pool.query(`INSERT INTO ai_bom_spdx_declarations(${column},property,value_text,source,declared_by_user_id,declared_at) VALUES($1,'downloadLocation','https://x53.example','admin_entered',$2,'2100-01-01') RETURNING seq,declared_at`,[id,user]);const seq=inserted.rows[0].seq;assert.notEqual(inserted.rows[0].declared_at.getUTCFullYear(),2100);
      for(const q of [`UPDATE ai_bom_spdx_declarations SET source='supplier_declared' WHERE seq=${seq}`,`DELETE FROM ai_bom_spdx_declarations WHERE seq=${seq}`,'TRUNCATE ai_bom_spdx_declarations'])await assert.rejects(pool.query(q),/append-only|TRUNCATE refused/);
      const table=column==='model_card_id'?'model_cards':column==='training_dataset_id'?'training_datasets':'eval_datasets';await transaction(async c=>{await c.query(`DELETE FROM ${table} WHERE id=$1`,[id]);assert.equal((await c.query('SELECT 1 FROM ai_bom_spdx_declarations WHERE seq=$1',[seq])).rowCount,0)});
      assert.equal((await pool.query('SELECT 1 FROM ai_bom_spdx_declarations WHERE seq=$1',[seq])).rowCount,1);
    });
  }
  await test('pinned function search_path resists temp parent shadow',async()=>{
    const f=await pool.query("SELECT proname,proconfig FROM pg_proc WHERE proname IN ('regulait_ai_bom_spdx_declaration_stamp','regulait_ai_bom_spdx_declaration_guard')");assert.equal(f.rowCount,2);for(const r of f.rows)assert.ok(r.proconfig.includes('search_path=pg_catalog, public, pg_temp'));
    await transaction(async c=>{await c.query('CREATE TEMP TABLE model_cards(id uuid)');await c.query('SET LOCAL search_path=pg_temp,public,pg_catalog');await assert.rejects(c.query('DELETE FROM public.ai_bom_spdx_declarations WHERE model_card_id=$1',[card]),/append-only/)});
  });
  await test('DB CHECKs reject direct bad URL, time, parent combination and field shape',async()=>{
    for(const [columns,values,params] of [
      ['model_card_id,property,value_text',"$1,'downloadLocation','https://x53.example/private'",[card]],
      ['model_card_id,property,value_time',"$1,'releaseTime','2026-01-01T00:00:00.5Z'",[card]],
      ['model_card_id,training_dataset_id,property,value_text',"$1,$2,'downloadLocation','https://x53.example'",[card,training]],
      ['model_card_id,property,value_text,value_time',"$1,'packageVersion','v1',now()",[card]],
    ])await assert.rejects(pool.query(`INSERT INTO ai_bom_spdx_declarations(${columns},source,declared_by_user_id) VALUES(${values},'admin_entered','${user}')`,params as any),/check constraint/);
  });
}finally{if(app){app.server.closeAllConnections();await app.close()}await pool.end();await (db.$client as any).end()}
console.log(JSON.stringify({pass,fail,reproducedFindingCases:findings,expectFixed:process.env.EXPECT_FIXED==='1'}));process.exitCode=fail?1:0;
