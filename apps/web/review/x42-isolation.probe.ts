/** X42 independent, synthetic-only scratch-Postgres evidence; copy into gateway/src to execute with gateway Vitest. */
import { beforeAll, afterAll, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createDb, runMigrations } from '@regulait/db';
const url = process.env.DATABASE_URL!;
if (new URL(url).pathname !== '/regulait_review_x42_oct10b') throw new Error('X42 exact scratch database required');
const db = createDb(url);
const pinned = 'search_path=pg_catalog, public, pg_temp';
const owner0185 = readFileSync('/tmp/x42-0185.sql', 'utf8');
const unpinnedQuery = `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang WHERE n.nspname='public' AND l.lanname IN ('plpgsql','sql') AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e') AND NOT ($1 = ANY(COALESCE(p.proconfig,'{}'))) ORDER BY 1`;
const missingQuery = `WITH expected AS (SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND NOT t.tgisinternal AND (t.tgtype&1)=1 AND (t.tgtype&2)=2 AND (t.tgtype&(8|16))<>0 AND p.prosrc ~* 'raise\\s+exception' UNION SELECT 'audit_log' UNION SELECT 'audit_anchors'), actual AS (SELECT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgenabled<>'D' AND (t.tgtype&2)=2 AND (t.tgtype&32)=32 AND pn.nspname='public' AND p.proname='regulait_refuse_truncate') SELECT relname FROM expected EXCEPT SELECT relname FROM actual`;
beforeAll(async () => { await runMigrations(db, resolve('../../packages/db/migrations')); }, 240000);
afterAll(async () => { await db.$client.end(); });
async function rollback(f: (c: Awaited<ReturnType<typeof db.$client.connect>>) => Promise<void>) {
 const c = await db.$client.connect(); try { await c.query('BEGIN'); await f(c); } finally { await c.query('ROLLBACK'); c.release(); }
}
it('DBG-01: exact 0185 cannot be applied after merged 0182/0183; all ALTER effects roll back', async () => {
 await rollback(async c => {
  await expect(c.query(owner0185)).rejects.toMatchObject({ code: '42723' });
 });
 expect((await db.$client.query(unpinnedQuery,[pinned])).rows).toContainEqual({proname:'regulait_refuse_mutation'});
});
it('I1R-01: missing/null required body fields pass the SQL CHECK despite claimed body invariants', async () => {
 await rollback(async c => {
  for (const [i,body] of ['{}','{"schema":null,"name":null,"minClass":null}'].entries()) {
   const digest=createHash('sha256').update(body).digest('hex');
   const r=await c.query(`INSERT INTO execution_profiles(name,version,body,digest,min_class) VALUES($1,1,$2,$3,'user_space_kernel') RETURNING name`, ['x42-body-'+i,body,digest]);
   expect(r.rowCount).toBe(1);
  }
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
 console.info('X42 baseline unpinned functions',unpinned,'baseline missing TRUNCATE guards',missing);
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
it('0185 independent negative control: caller nonpublic schema shadows an append-only parent before the pin',async()=>{
 await rollback(async c=>{const r=await hostileEvidenceDelete(c);expect(r.err).toBeNull();expect(r.exists).toBe(false);});
});
it('0185 intended guard statements independently close hostile-schema deletion and all truncate gaps (transaction-only, failing CREATE excluded)',async()=>{
 await rollback(async c=>{
  // This explicitly omits the collided CREATE FUNCTION. It proves individual guard statements, never whole-migration success.
  const chunks=owner0185.split('--> statement-breakpoint');
  for(const chunk of chunks)if(!chunk.includes('CREATE FUNCTION public.regulait_refuse_truncate'))await c.query(chunk);
  expect((await c.query(unpinnedQuery,[pinned])).rows).toEqual([]);
  expect((await c.query(missingQuery)).rows).toEqual([]);
  const r=await hostileEvidenceDelete(c);expect(r.err?.message).toMatch(/ai_incident_events is append-only: DELETE refused/);expect(r.exists).toBe(true);
  const tables=(await c.query(`SELECT DISTINCT c.relname FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname='public' AND p.proname='regulait_refuse_truncate' AND t.tgenabled<>'D' ORDER BY 1`)).rows;
  expect(tables.length).toBeGreaterThan(25);
  for(const {relname}of tables){
   await c.query('SAVEPOINT x42_truncate');
   await expect(c.query(`TRUNCATE public."${relname}" CASCADE`)).rejects.toThrow(/TRUNCATE refused/);
   await c.query('ROLLBACK TO SAVEPOINT x42_truncate');
  }
  console.info('X42 independently refused TRUNCATE on',tables.length,'tables');
 });
});
