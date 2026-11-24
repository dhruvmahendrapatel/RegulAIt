/** ADR-0367: offline signed detection content. No fetch path, global active registry, or customer data. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditLog, sql, type Db } from "@regulait/db";
import {
  DETECTION_FEED_MAX_AGE_DAYS, DETECTION_FEED_MAX_BYTES, DETECTION_FEED_MAX_CLOCK_SKEW_MS, compileDetectionFeedRules,
  detectionFeedEnvelopeSchema, detectionFeedSchema, type CompiledDetectionFeedRule, type DetectionFeed,
} from "@regulait/shared";
import {
  cachedSignedBundleKeyring, loadSignedBundleKeyring, signedBundleKeyringFingerprint, verifySignedBundle, type SignedBundleKeyring,
} from "./signed-bundle.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { requireStepUp } from "./step-up.js";
import { settingTransitions } from "./setting-transitions.js";

export const DETECTION_FEED_KEYS_ENV = "REGULAIT_DETECTION_FEED_KEYS";
export const DETECTION_FEED_KEYS_FILE_ENV = "REGULAIT_DETECTION_FEED_KEYS_FILE";
export const detectionFeedKeyring = () => loadSignedBundleKeyring(DETECTION_FEED_KEYS_ENV, DETECTION_FEED_KEYS_FILE_ENV, "detection feed");
/** The hot-path keyring: parsed once per configuration, file read asynchronously (see signed-bundle.ts). */
const feedKeyring = cachedSignedBundleKeyring(DETECTION_FEED_KEYS_ENV, DETECTION_FEED_KEYS_FILE_ENV, "detection feed");
interface FeedMeta {
  enabled: boolean; version: string | number; feed_id: string | null; key_id: string | null; digest: string | null;
  issued_at: Date | string | null; row_version: string;
}
interface FeedRow extends FeedMeta { bundle: string | null; signature: string | null }
function rows<T>(result: unknown): T[] { return (result as {rows:T[]}).rows; }
// `xmin` changes on every UPDATE of the row, so it keys the verified snapshot without reading the 256 KiB bundle per call.
async function readFeed(db: Db, lock=false): Promise<FeedRow | undefined> {
  const query=lock ? sql`SELECT *, xmin::text AS row_version FROM detection_feed WHERE id=true FOR UPDATE` : sql`SELECT *, xmin::text AS row_version FROM detection_feed WHERE id=true`;
  return rows<FeedRow>(await db.execute(query))[0];
}
async function readFeedMeta(db: Db): Promise<FeedMeta | undefined> {
  return rows<FeedMeta>(await db.execute(sql`SELECT enabled, version, feed_id, key_id, digest, issued_at, xmin::text AS row_version FROM detection_feed WHERE id=true`))[0];
}
export type FeedVerification = {ok:true; feed:DetectionFeed; digest:string} | {ok:false; code:string};
export function verifyDetectionFeed(body: unknown, keyring: SignedBundleKeyring = detectionFeedKeyring()): FeedVerification {
  const envelope=detectionFeedEnvelopeSchema.safeParse(body);
  if(!envelope.success) return {ok:false,code:"invalid_envelope"};
  const verified=verifySignedBundle(envelope.data,keyring,DETECTION_FEED_MAX_BYTES);
  if(!verified.ok) return verified;
  let json:unknown;
  try { json=JSON.parse(envelope.data.bundle) as unknown; } catch {return {ok:false,code:"invalid_document"};}
  const parsed=detectionFeedSchema.safeParse(json);
  if(!parsed.success) return {ok:false,code:"invalid_rules"};
  return {ok:true,feed:parsed.data,digest:verified.digest};
}
const issuedMs=(v:Date|string|null)=>v===null?Number.NaN:new Date(v).getTime();
function verifyRow(row:FeedRow, keyring:SignedBundleKeyring):FeedVerification {
  verifications+=1;
  const result=verifyDetectionFeed({bundle:row.bundle,signature:row.signature,keyId:row.key_id},keyring);
  if(!result.ok) return result;
  if(result.digest!==row.digest || result.feed.version!==Number(row.version) || result.feed.feedId!==row.feed_id ||
    Date.parse(result.feed.issuedAt)!==issuedMs(row.issued_at))
    return {ok:false,code:"stored_metadata_mismatch"};
  return result;
}
export interface DetectionFeedRuntime {
  rules:readonly CompiledDetectionFeedRule[]; unavailable:boolean; code?:string; issuedAt?:string;
}
let verifications=0;
/** Test seam: how many full verifications (signature, parse, schema, compile) have run in this process. */
export const detectionFeedVerificationCount=()=>verifications;
let snapshot:{key:string; runtime:DetectionFeedRuntime}|undefined;
const snapshotKey=(meta:FeedMeta, fingerprint:string)=>
  JSON.stringify([meta.row_version,Number(meta.version),meta.feed_id,meta.digest,meta.key_id,issuedMs(meta.issued_at),fingerprint]);
/**
 * The verified snapshot for governed calls. Verification, parsing, schema validation and RE2 compilation run once per
 * (row update, version, digest, keyring fingerprint), not once per call: an import, a stored-byte change or any key
 * added to or removed from the keyring changes the key, so each still takes effect at the next call.
 */
export async function loadDetectionFeedRuntime(db:Db, keyring?:SignedBundleKeyring):Promise<DetectionFeedRuntime | undefined> {
  const meta=await readFeedMeta(db);
  // The migration creates the off singleton. A missing row is not an implicit security relaxation.
  if(!meta) return {rules:[],unavailable:true,code:"state_missing"};
  if(!meta.enabled) return undefined;
  const ring=keyring ? {keyring,fingerprint:signedBundleKeyringFingerprint(keyring)} : await feedKeyring();
  const key=snapshotKey(meta,ring.fingerprint);
  if(snapshot?.key===key) return snapshot.runtime;
  const row=await readFeed(db);
  if(!row) return {rules:[],unavailable:true,code:"state_missing"};
  if(!row.enabled) return undefined;
  const result=verifyRow(row,ring.keyring);
  const runtime:DetectionFeedRuntime=result.ok
    ? {rules:compileDetectionFeedRules(result.feed.rules),unavailable:false,issuedAt:result.feed.issuedAt}
    : {rules:[],unavailable:true,code:result.code};
  // one slot: there is one feed row, so the cache holds at most one bounded snapshot
  snapshot={key:snapshotKey(row,ring.fingerprint),runtime};
  return runtime;
}
async function audit(db:Db, userId:string|null, effect:"allow"|"deny", code:string, detail:Record<string,unknown>={}) {
  await db.insert(auditLog).values({userId:userId??"00000000-0000-0000-0000-000000000000",objectType:"org_settings",objectId:null,
    ruleId:"detection-feed-import",ruleChain:[],effect,reason:`Detection feed: ${code}`,detail:{code,...detail}});
}
const DAY_MS=24*60*60*1000;
function freshness(issuedAt:string|null, now:number) {
  if(!issuedAt) return {issuedAt:null,ageSeconds:null,stale:false,maxAgeDays:DETECTION_FEED_MAX_AGE_DAYS};
  const age=Math.max(0,now-Date.parse(issuedAt));
  return {issuedAt,ageSeconds:Math.floor(age/1000),stale:age>DETECTION_FEED_MAX_AGE_DAYS*DAY_MS,maxAgeDays:DETECTION_FEED_MAX_AGE_DAYS};
}
function status(row:FeedRow|undefined,keyring:SignedBundleKeyring,now=Date.now()) {
  const result=row && Number(row.version)>0 ? verifyRow(row,keyring):undefined;
  return {enabled:row?.enabled??false,available:result?.ok??false,unavailableCode:result && !result.ok ? result.code : null,
    version:Number(row?.version??0),feedId:row?.feed_id??null,digest:row?.digest??null,keyId:row?.key_id??null,
    ruleCount:result?.ok?result.feed.rules.length:0,supportedKinds:["prompt_injection"],
    ...freshness(row?.issued_at ? new Date(row.issued_at).toISOString() : null,now)};
}
/**
 * The daily health pass (and the startup check): an enabled feed that no longer verifies blocks every governed call,
 * and a feed past its maximum age is a freeze signal. Both are audited for admins; neither changes enforcement.
 */
export async function runDetectionFeedHealthCheck(db:Db, opts:{now?:Date; write?:boolean}={}) {
  const row=await readFeed(db);
  if(!row) {if(opts.write!==false) await audit(db,null,"deny","health_state_missing");return {enabled:false,unavailable:true,stale:false,code:"state_missing"};}
  if(!row.enabled) return {enabled:false,unavailable:false,stale:false,code:null};
  const st=status(row,(await feedKeyring()).keyring,(opts.now??new Date()).getTime());
  if(opts.write!==false) {
    if(!st.available) await audit(db,null,"deny","health_unavailable",{version:st.version,unavailableCode:st.unavailableCode});
    else if(st.stale) await audit(db,null,"allow","health_stale",{version:st.version,issuedAt:st.issuedAt,ageSeconds:st.ageSeconds,maxAgeDays:st.maxAgeDays});
  }
  return {enabled:true,unavailable:!st.available,stale:st.stale,code:st.unavailableCode};
}
export const DETECTION_FEED_HEALTH_JOB_NAME = "detection-feed-health-sweep";
export function detectionFeedJobDefinitions(): SchedulerJobDefinition[] {
  return [{
    name:DETECTION_FEED_HEALTH_JOB_NAME,
    description:"Check the enabled signed detection feed once a day. Writes an audit row when it no longer verifies (every " +
      `governed call is then blocked) or when its signed issue time is older than ${DETECTION_FEED_MAX_AGE_DAYS} days (a ` +
      "freeze signal). With the feed off it does nothing; it never changes enforcement.",
    adr:"ADR-0367",
    defaultIntervalSeconds:24*60*60,
    run:async(ctx)=>{const out=await runDetectionFeedHealthCheck(ctx.db,{now:ctx.now});return {itemsProcessed:out.enabled?1:0,detail:{...out}};},
  }];
}

/** Default global admin gate applies; none of these routes is public or non-admin. */
export function registerDetectionFeedRoutes(app:FastifyInstance,db:Db):void {
  // Startup health warning: an enabled feed that no longer verifies blocks every governed call, so say so loudly.
  app.addHook("onReady",async()=>{
    try {
      const h=await runDetectionFeedHealthCheck(db,{write:false});
      if(h.unavailable) app.log.warn({code:h.code},"detection feed is enabled but does not verify: every governed call is blocked (feed_unavailable)");
      else if(h.stale) app.log.warn(`detection feed is older than ${DETECTION_FEED_MAX_AGE_DAYS} days; import a newer signed feed`);
    } catch (err) { app.log.warn({err},"detection feed health check could not run"); }
  });
  app.get("/v1/detection-content/feed",async()=>status(await readFeed(db),detectionFeedKeyring()));
  app.post("/v1/detection-content/feed/import",{bodyLimit:DETECTION_FEED_MAX_BYTES*2+65536,onError:async(req)=>{
    if(req.authCtx?.userId) await audit(db,req.authCtx.userId,"deny","request_rejected");
  }},async(req,reply)=>{
    const verdict=verifyDetectionFeed(req.body);
    const actor=req.authCtx.userId??null;
    if(!verdict.ok) {
      await audit(db,actor,"deny",verdict.code);
      return reply.status(400).send({error:"detection_feed_refused",code:verdict.code});
    }
    const body=detectionFeedEnvelopeSchema.parse(req.body);
    return db.transaction(async raw=>{
      const tx=raw as unknown as Db;
      const current=await readFeed(tx,true);
      if(!current) {await audit(tx,actor,"deny","state_missing");return reply.status(409).send({error:"detection_feed_state_missing"});}
      const version=Number(current.version);
      const refuse=async(code:string)=>{await audit(tx,actor,"deny",code,{version:verdict.feed.version,digest:verdict.digest});return reply.status(409).send({error:"detection_feed_refused",code});};
      if(current.feed_id!==null && current.feed_id!==verdict.feed.feedId) return refuse("different_feed");
      if(verdict.feed.version<=version) return refuse(verdict.feed.version<version?"downgrade":"version_replay");
      // Freeze/rollback by time: the signed issue time must move forward with the version, and cannot be post-dated
      // (a far-future time would make every later genuine feed look older).
      const issued=Date.parse(verdict.feed.issuedAt);
      if(issued>Date.now()+DETECTION_FEED_MAX_CLOCK_SKEW_MS) return refuse("issued_in_future");
      if(current.issued_at!==null && issued<=issuedMs(current.issued_at)) return refuse("issued_not_newer");
      // Replacing active policy can remove a finding: a signed update is not permission to bypass fresh approval.
      if(current.enabled) {
        const su=await requireStepUp(tx,req,reply,{kind:"settings_relax",facts:{op:"detection_feed_import",version:verdict.feed.version,digest:verdict.digest,priorVersion:version}});
        if(!su.ok) {await audit(tx,actor,"deny","step_up_required");return reply;}
      }
      await tx.execute(sql`UPDATE detection_feed SET version=${verdict.feed.version},feed_id=${verdict.feed.feedId},bundle=${body.bundle},signature=${body.signature},key_id=${body.keyId},digest=${verdict.digest},issued_at=${verdict.feed.issuedAt}::timestamptz,installed_at=now(),installed_by=${actor} WHERE id=true`);
      await audit(tx,actor,"allow","installed",{version:verdict.feed.version,digest:verdict.digest,ruleCount:verdict.feed.rules.length});
      return {installed:true,enabled:current.enabled,version:verdict.feed.version,digest:verdict.digest};
    });
  });
  app.put("/v1/detection-content/feed/settings",async(req,reply)=>{
    const body=z.object({enabled:z.boolean()}).strict().parse(req.body);
    return db.transaction(async raw=>{
      const tx=raw as unknown as Db;
      const current=await readFeed(tx,true);
      const actor=req.authCtx.userId??null;
      if(!current) {await audit(tx,actor,"deny","settings_state_missing");return reply.status(409).send({error:"detection_feed_state_missing"});}
      if(body.enabled) {
        const check=verifyRow(current,detectionFeedKeyring());
        if(!check.ok) {await audit(tx,actor,"deny","settings_unavailable",{version:Number(current.version),unavailableCode:check.code});return reply.status(409).send({error:"detection_feed_unavailable"});}
      }
      if(current.enabled===body.enabled) return {enabled:body.enabled,changed:false};
      const su=await requireStepUp(tx,req,reply,{kind:"settings_relax",facts:{op:"detection_feed_enable",enabled:body.enabled,version:Number(current.version),digest:current.digest}});
      if(!su.ok) {await audit(tx,actor,"deny","step_up_required",{enabled:body.enabled,version:Number(current.version)});return reply;}
      await tx.execute(sql`UPDATE detection_feed SET enabled=${body.enabled} WHERE id=true`);
      await audit(tx,actor,"allow","setting_updated",{transitions:settingTransitions(current,{enabled:body.enabled})});
      return {enabled:body.enabled,changed:true};
    });
  });
}
