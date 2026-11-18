/** ADR-0351: offline signed detection content. No fetch path, global active registry, or customer data. */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditLog, sql, type Db } from "@regulait/db";
import {
  DETECTION_FEED_MAX_BYTES, detectionFeedEnvelopeSchema, detectionFeedSchema,
  type DetectionFeed, type DetectionFeedRule,
} from "@regulait/shared";
import { loadSignedBundleKeyring, verifySignedBundle, type SignedBundleKeyring } from "./signed-bundle.js";
import { requireStepUp } from "./step-up.js";
import { settingTransitions } from "./setting-transitions.js";

export const DETECTION_FEED_KEYS_ENV = "REGULAIT_DETECTION_FEED_KEYS";
export const DETECTION_FEED_KEYS_FILE_ENV = "REGULAIT_DETECTION_FEED_KEYS_FILE";
export const detectionFeedKeyring = () => loadSignedBundleKeyring(DETECTION_FEED_KEYS_ENV, DETECTION_FEED_KEYS_FILE_ENV, "detection feed");
interface FeedRow {
  enabled: boolean; version: string | number; feed_id: string | null; bundle: string | null;
  signature: string | null; key_id: string | null; digest: string | null;
}
function rows<T>(result: unknown): T[] { return (result as {rows:T[]}).rows; }
async function readFeed(db: Db, lock=false): Promise<FeedRow | undefined> {
  const query=lock ? sql`SELECT * FROM detection_feed WHERE id=true FOR UPDATE` : sql`SELECT * FROM detection_feed WHERE id=true`;
  return rows<FeedRow>(await db.execute(query))[0];
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
function verifyRow(row:FeedRow, keyring:SignedBundleKeyring):FeedVerification {
  const result=verifyDetectionFeed({bundle:row.bundle,signature:row.signature,keyId:row.key_id},keyring);
  if(!result.ok) return result;
  if(result.digest!==row.digest || result.feed.version!==Number(row.version) || result.feed.feedId!==row.feed_id)
    return {ok:false,code:"stored_metadata_mismatch"};
  return result;
}
export interface DetectionFeedRuntime { rules:readonly DetectionFeedRule[]; unavailable:boolean }
/** A per-call verified snapshot. Removing a trust key takes effect at the next call, without cache invalidation. */
export async function loadDetectionFeedRuntime(db:Db, keyring?:SignedBundleKeyring):Promise<DetectionFeedRuntime | undefined> {
  const row=await readFeed(db);
  // The migration creates the off singleton. A missing row is not an implicit security relaxation.
  if(!row) return {rules:[],unavailable:true};
  if(!row.enabled) return undefined;
  const result=verifyRow(row,keyring??detectionFeedKeyring());
  return result.ok ? {rules:result.feed.rules,unavailable:false} : {rules:[],unavailable:true};
}
async function audit(db:Db, userId:string|null, effect:"allow"|"deny", code:string, detail:Record<string,unknown>={}) {
  await db.insert(auditLog).values({userId:userId??"00000000-0000-0000-0000-000000000000",objectType:"org_settings",objectId:null,
    ruleId:"detection-feed-import",ruleChain:[],effect,reason:`Detection feed: ${code}`,detail:{code,...detail}});
}
function status(row:FeedRow|undefined,keyring:SignedBundleKeyring) {
  const result=row && Number(row.version)>0 ? verifyRow(row,keyring):undefined;
  return {enabled:row?.enabled??false,available:result?.ok??false,version:Number(row?.version??0),feedId:row?.feed_id??null,
    digest:row?.digest??null,keyId:row?.key_id??null,ruleCount:result?.ok?result.feed.rules.length:0,supportedKinds:["prompt_injection"]};
}

/** Default global admin gate applies; none of these routes is public or non-admin. */
export function registerDetectionFeedRoutes(app:FastifyInstance,db:Db):void {
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
      // Replacing active policy can remove a finding: a signed update is not permission to bypass fresh approval.
      if(current.enabled) {
        const su=await requireStepUp(tx,req,reply,{kind:"settings_relax",facts:{op:"detection_feed_import",version:verdict.feed.version,digest:verdict.digest,priorVersion:version}});
        if(!su.ok) {await audit(tx,actor,"deny","step_up_required");return reply;}
      }
      await tx.execute(sql`UPDATE detection_feed SET version=${verdict.feed.version},feed_id=${verdict.feed.feedId},bundle=${body.bundle},signature=${body.signature},key_id=${body.keyId},digest=${verdict.digest},installed_at=now(),installed_by=${actor} WHERE id=true`);
      await audit(tx,actor,"allow","installed",{version:verdict.feed.version,digest:verdict.digest,ruleCount:verdict.feed.rules.length});
      return {installed:true,enabled:current.enabled,version:verdict.feed.version,digest:verdict.digest};
    });
  });
  app.put("/v1/detection-content/feed/settings",async(req,reply)=>{
    const body=z.object({enabled:z.boolean()}).strict().parse(req.body);
    return db.transaction(async raw=>{
      const tx=raw as unknown as Db;
      const current=await readFeed(tx,true);
      if(!current) return reply.status(409).send({error:"detection_feed_state_missing"});
      if(body.enabled && !verifyRow(current,detectionFeedKeyring()).ok) return reply.status(409).send({error:"detection_feed_unavailable"});
      if(current.enabled===body.enabled) return {enabled:body.enabled,changed:false};
      const su=await requireStepUp(tx,req,reply,{kind:"settings_relax",facts:{op:"detection_feed_enable",enabled:body.enabled,version:Number(current.version),digest:current.digest}});
      if(!su.ok) return reply;
      await tx.execute(sql`UPDATE detection_feed SET enabled=${body.enabled} WHERE id=true`);
      await audit(tx,req.authCtx.userId??null,"allow","setting_updated",{transitions:settingTransitions(current,{enabled:body.enabled})});
      return {enabled:body.enabled,changed:true};
    });
  });
}
