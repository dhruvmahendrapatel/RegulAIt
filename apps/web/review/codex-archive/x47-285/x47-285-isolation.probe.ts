/** X47 returned DBG-01/I1R-01 independent, synthetic-only scratch-Postgres evidence; copy into gateway/src to execute with gateway Vitest. */
import { beforeAll, afterAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDb, runMigrations } from '@regulait/db';
const url = process.env.DATABASE_URL!;
if (new URL(url).pathname !== '/regulait_review_x47_285_oct10') throw new Error('X47 exact scratch database required');
const db = createDb(url);
const pinned = 'search_path=pg_catalog, public, pg_temp';
const owner0185 = readFileSync(resolve('../../packages/db/migrations/0185_guard_search_path_and_truncate.sql'), 'utf8');
const original0185 = execFileSync('git',['show','6f6de2bc4cc8d69a810c0a30d1acb29da420a316:packages/db/migrations/0185_guard_search_path_and_truncate.sql'],{encoding:'utf8'});
const unpinnedQuery = `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND l.lanname IN ('plpgsql','sql') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') AND NOT ($1 = ANY(COALESCE(p.proconfig,'{}'))) ORDER BY 1`;
const missingQuery = `WITH expected AS (SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND NOT t.tgisinternal AND (t.tgtype&1)=1 AND (t.tgtype&2)=2 AND (t.tgtype&(8|16))<>0 AND p.prosrc ~* 'raise\\s+exception' UNION SELECT 'audit_log' UNION SELECT 'audit_anchors'), actual AS (SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled<>'D' AND (t.tgtype&2)=2 AND (t.tgtype&32)=32 AND pn.nspname='public' AND p.proname='regulait_refuse_truncate') SELECT relname FROM expected EXCEPT SELECT relname FROM actual`;
beforeAll(async () => { await runMigrations(db, resolve('../../packages/db/migrations')); }, 240000);
afterAll(async () => { await db.$client.end(); });
async function rollback(f: (c: Awaited<ReturnType<typeof db.$client.connect>>) => Promise<void>) {
 const c = await db.$client.connect(); try { await c.query('BEGIN'); await f(c); } finally { await c.query('ROLLBACK'); c.release(); }
}
it('DBG-01 returned fix: whole migrated schema and exact 0185 replay twice succeed with the frozen journal', async () => {
 const journal=JSON.parse(readFileSync(resolve('../../packages/db/migrations/meta/_journal.json'),'utf8')).entries;
 for(let i=1;i<journal.length;i++){expect(journal[i].when).toBeGreaterThan(journal[i-1].when);expect(journal[i].idx).toBeGreaterThan(journal[i-1].idx);}
 expect(journal.find((e:any)=>e.tag==='0185_guard_search_path_and_truncate').when).toBe(1785120000000);
 const migrations=await db.$client.query('SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1');
 expect(Number(migrations.rows[0].created_at)).toBe(1785120000000);
 await rollback(async c=>{await c.query(owner0185);await c.query(owner0185);expect((await c.query(unpinnedQuery,[pinned])).rows).toEqual([]);expect((await c.query(missingQuery)).rows).toEqual([]);});
});
it('DBG-01 original exact migration still reproduces duplicate_function, validating the old negative',async()=>{
 await rollback(async c=>{await expect(c.query(original0185)).rejects.toMatchObject({code:'42723'});});
});
it('I1R-01 returned fix rejects independently missing and JSON-null identity fields with actual body-check SQLSTATE',async()=>{
 const bodies=['{}','{"schema":null,"name":null,"minClass":null}',
  '{"schema":"regulait.execution-profile.v1","name":"x47-missing"}',
  '{"schema":"regulait.execution-profile.v1","minClass":"user_space_kernel"}',
  '{"name":"x47-missing","minClass":"user_space_kernel"}'];
 for(const body of bodies)await rollback(async c=>{
  await expect(c.query(`INSERT INTO public.execution_profiles(name,version,body,digest,min_class) VALUES('x47-missing',1,$1,$2,'user_space_kernel')`,[body,createHash('sha256').update(body).digest('hex')])).rejects.toMatchObject({code:'23514',constraint:'execution_profiles_body_check'});
 });
});
it('I1R-01 independent old predicate accepts both original malformed bodies; shipped-body positive remains valid',async()=>{
 await rollback(async c=>{
  await c.query(`ALTER TABLE public.execution_profiles DROP CONSTRAINT execution_profiles_body_check, ADD CONSTRAINT execution_profiles_body_check CHECK(length(body)<=65536 AND jsonb_typeof(body::jsonb)='object' AND (body::jsonb->>'schema')='regulait.execution-profile.v1' AND (body::jsonb->>'name')=name AND (body::jsonb->>'minClass')=min_class)`);
  for(const[i,body]of['{}','{"schema":null,"name":null,"minClass":null}'].entries())expect((await c.query(`INSERT INTO public.execution_profiles(name,version,body,digest,min_class) VALUES($1,1,$2,$3,'user_space_kernel') RETURNING id`,['x47-old-'+i,body,createHash('sha256').update(body).digest('hex')])).rowCount).toBe(1);
 });
 await rollback(async c=>{
  const row=(await c.query(`SELECT body,min_class FROM public.execution_profiles WHERE name='restricted'`)).rows[0];
  const body=JSON.stringify({...JSON.parse(row.body),name:'x47-positive'});
  expect((await c.query(`INSERT INTO public.execution_profiles(name,version,body,digest,min_class) VALUES('x47-positive',1,$1,$2,$3) RETURNING id`,[body,createHash('sha256').update(body).digest('hex'),row.min_class])).rowCount).toBe(1);
 });
});
it('I1 new guard functions pin hostile search paths; profile version check still refuses a skipped version', async () => {
 await rollback(async c => {
  await c.query(`CREATE TEMP TABLE execution_profiles (name text, version int, retired_at timestamptz); INSERT INTO execution_profiles VALUES('restricted',99,NULL); SET LOCAL search_path=pg_temp,public,pg_catalog`);
  const original=(await c.query(`SELECT body FROM public.execution_profiles WHERE name='restricted'`)).rows[0].body;
  const changed=JSON.stringify({...JSON.parse(original),resources:{...JSON.parse(original).resources,cpuMillis:1010}});
  await expect(c.query(`INSERT INTO public.execution_profiles(name,version,body,digest,min_class) VALUES('restricted',100,$1,$2,'user_space_kernel')`,[changed,createHash('sha256').update(changed).digest('hex')])).rejects.toMatchObject({code:'23514'});
 });
});
it('I1 four append-only tables refuse TRUNCATE CASCADE under hostile search path with every transaction rolled back', async () => {
 for (const table of ['execution_profiles','executors','executor_attestations','execution_placements']) {
  await rollback(async c => {
   await c.query('SET LOCAL search_path=pg_temp,pg_catalog,public');
   await expect(c.query(`TRUNCATE public.${table} CASCADE`)).rejects.toThrow(/TRUNCATE refused/);
  });
 }
});
it('0185 invariant census catches a future unpinned function and a future forgotten truncate guard', async () => {
 await rollback(async c => {
  await c.query(`CREATE FUNCTION public.x42_unpinned() RETURNS int LANGUAGE sql AS 'SELECT 1'; CREATE TABLE public.x42_evidence(id int); CREATE FUNCTION public.x42_refuse() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$BEGIN RAISE EXCEPTION 'append only'; END$$; CREATE TRIGGER x42_guard BEFORE UPDATE OR DELETE ON public.x42_evidence FOR EACH ROW EXECUTE FUNCTION public.x42_refuse()`);
  expect((await c.query(unpinnedQuery,[pinned])).rows).toContainEqual({proname:'x42_unpinned'});
  expect((await c.query(missingQuery)).rows).toContainEqual({relname:'x42_evidence'});
 });
});
it('0185 forward census reports merged I1 tables guarded, and no new I1 function omitted', async () => {
 const unpinned=(await db.$client.query(unpinnedQuery,[pinned])).rows.map(r=>r.proname);
 for (const f of ['regulait_execution_profile_guard','regulait_executor_guard','regulait_refuse_truncate']) expect(unpinned).not.toContain(f);
 const missing=(await db.$client.query(missingQuery)).rows.map(r=>r.relname);
 for (const t of ['execution_profiles','executors','executor_attestations','execution_placements']) expect(missing).not.toContain(t);
 console.info('X47 current unpinned functions',unpinned,'current missing TRUNCATE guards',missing);
});

import { executionProfileBodySchema, executionProfileRelaxations, executionProfileDigest, runscFlags, SHIPPED_EXECUTION_PROFILES, registerExecutorSchema, ISOLATION_STRICT_DEFAULTS, isolationSettingRelaxed, isolationSettingLooser, ATTESTATION_PROBES } from '@regulait/shared';
it('amendments A-D: each immutable runsc/process invariant refuses its independent mutation', () => {
 const variants=[
  (b:any)=>b.runsc.ociSeccomp=false,
  (b:any)=>b.runsc.sidecarUsagePolicy='EMBEDDED',
  (b:any)=>b.runsc.sidecarReleaseEnforcementPolicy='NEVER',
  (b:any)=>b.process.pids.hostCgroupPidsMax=b.process.pids.workloadNproc+127,
  (b:any)=>b.process.uid=0,
  (b:any)=>b.filesystem.rootReadOnly=false,
  (b:any)=>b.process.noNewPrivileges=false,
  (b:any)=>b.attestation.perPlacement=false,
 ];
 for (const change of variants) { const b=structuredClone(SHIPPED_EXECUTION_PROFILES.restricted); change(b); expect(executionProfileBodySchema.safeParse(b).success).toBe(false); }
 const b=structuredClone(SHIPPED_EXECUTION_PROFILES.restricted); b.runsc.directfs=true;
 expect(executionProfileBodySchema.safeParse(b).success).toBe(true);
 expect(executionProfileRelaxations(b,SHIPPED_EXECUTION_PROFILES.restricted)).toEqual(['runsc.directfs']);
 expect(runscFlags(SHIPPED_EXECUTION_PROFILES.restricted)).toEqual(['--oci-seccomp','--network=none','--sidecar-usage-policy=STRICT','--sidecar-release-enforcement-policy=ALWAYS','--platform=systrap','--directfs=false']);
 expect(ATTESTATION_PROBES.root_read_only).toBe('in_sandbox');
 expect(ATTESTATION_PROBES.host_cgroup_limits).toBe('executor_side');
 expect(ATTESTATION_PROBES.runtime_config).toBe('executor_side');
});
it('profile digest is stable across object insertion order; security-relevant flag changes digest',()=>{
 const base=SHIPPED_EXECUTION_PROFILES.restricted;
 const reversed=Object.fromEntries(Object.entries(base).reverse()) as typeof base;
 expect(executionProfileDigest(reversed)).toBe(executionProfileDigest(base));
 const relaxed=structuredClone(base); relaxed.runsc.directfs=true;
 expect(executionProfileDigest(relaxed)).not.toBe(executionProfileDigest(base));
});
it('backend claims never promote runc/OpenShell to L2 or gVisor to L3; customer has only declared isolation',()=>{
 const base={workloadIdentityId:'7b0b1c2e-0000-4000-8000-000000000001',name:'x42-executor',runtimeVersion:'synthetic'};
 for(const [backend,classesDeclared] of [['runc',['user_space_kernel']],['openshell',['user_space_kernel']],['gvisor',['microvm']],['customer',['hardened_container']]] ) expect(registerExecutorSchema.safeParse({...base,backend,classesDeclared}).success).toBe(false);
 expect(registerExecutorSchema.safeParse({...base,backend:'customer',classesDeclared:['customer_declared']}).success).toBe(true);
});
it('strictness compares both strict defaults and stored stricter values',()=>{
 expect(ISOLATION_STRICT_DEFAULTS.isolationEnforcement).toBe('enforce');
 expect(ISOLATION_STRICT_DEFAULTS.isolationFloorRegulated).toBe('microvm');
 expect(isolationSettingRelaxed('isolationFloorPublic','hardened_container')).toBe(true);
 expect(isolationSettingRelaxed('isolationFloorPublic','user_space_kernel')).toBe(false);
 expect(isolationSettingLooser('isolationFloorPublic','user_space_kernel','microvm')).toBe(true);
 expect(isolationSettingLooser('executorAttestationMaxAgeMinutes',120,60)).toBe(true);
});

async function hostileEvidenceDelete(c: Awaited<ReturnType<typeof db.$client.connect>>) {
 const incident=(await c.query(`INSERT INTO public.ai_incidents(title,severity,detection_source,aware_at) VALUES('x42 synthetic incident','low','manual',now()) RETURNING id`)).rows[0].id;
 const event=(await c.query(`INSERT INTO public.ai_incident_events(incident_id,kind,note) VALUES($1,'note','x42 synthetic evidence') RETURNING id`,[incident])).rows[0].id;
 await c.query(`CREATE SCHEMA x42_hostile; CREATE TABLE x42_hostile.ai_incidents(id uuid); CREATE TEMP TABLE x42_kick(x int); CREATE FUNCTION pg_temp.x42_kick() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM public.ai_incident_events WHERE id='${event}'; RETURN NULL; END $$; CREATE TRIGGER x42_kick AFTER INSERT ON x42_kick FOR EACH ROW EXECUTE FUNCTION pg_temp.x42_kick(); SET LOCAL search_path=x42_hostile,public,pg_catalog; SAVEPOINT x42_attack`);
 let err: Error|null=null;
 try{await c.query('INSERT INTO pg_temp.x42_kick VALUES(1)');}catch(e){err=e as Error;await c.query('ROLLBACK TO SAVEPOINT x42_attack');}
 const exists=(await c.query('SELECT id FROM public.ai_incident_events WHERE id=$1',[event])).rowCount===1;
 return {err,exists};
}
it('0185 independent negative control: resetting only the original function pin recreates caller-schema evidence deletion',async()=>{
 await rollback(async c=>{await c.query('ALTER FUNCTION public.regulait_refuse_mutation() RESET search_path');const r=await hostileEvidenceDelete(c);expect(r.err).toBeNull();expect(r.exists).toBe(false);});
});
it('0185 real migrated guards close hostile-schema deletion and refuse every guarded TRUNCATE CASCADE',async()=>{
 await rollback(async c=>{
  expect((await c.query(unpinnedQuery,[pinned])).rows).toEqual([]);
  expect((await c.query(missingQuery)).rows).toEqual([]);
  const r=await hostileEvidenceDelete(c);expect(r.err?.message).toMatch(/ai_incident_events is append-only: DELETE refused/);expect(r.exists).toBe(true);
  const tables=(await c.query(`SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND p.proname='regulait_refuse_truncate' AND t.tgenabled<>'D' ORDER BY 1`)).rows;
  expect(tables.length).toBe(34);
  for(const {relname}of tables){
   await c.query('SAVEPOINT x42_truncate');
   await expect(c.query(`TRUNCATE public."${relname}" CASCADE`)).rejects.toThrow(/TRUNCATE refused/);
   await c.query('ROLLBACK TO SAVEPOINT x42_truncate');
  }
  console.info('X47 independently refused TRUNCATE on',tables.length,'tables');
 });
});
