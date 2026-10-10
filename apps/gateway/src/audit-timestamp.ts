/** ADR-0186 S: pinned RFC 3161 requests, bounded verification and retry. */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import * as asn1 from "asn1js";
import { AlgorithmIdentifier, MessageImprint, TimeStampReq } from "pkijs";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, asc, auditAnchors, auditLog, eq, ne, sql, type Db } from "@regulait/db";
import { canonicalJson } from "@regulait/shared";
import type { AnchorRecord, AnchorTimestamper } from "./audit-chain.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { loadOrgSettings } from "./org-settings.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { createGuardedFetch } from "./egress-guard.js";
import { parseTimestampTrustBundle, timestampReplyBytes, TSA_DER_LIMIT, TSA_SHA256_OID, TimestampValidationError, verifyTimestampResponse } from "./audit-timestamp-verify.js";

export const ANCHOR_TIMESTAMP_JOB_NAME = "anchor-timestamp-sweep";
export const ANCHOR_TIMESTAMP_LOCK_KEY = 6_000_000_187;
const DEADLINE_MS = 15_000;
const MAX_ATTEMPTS = 20;
type Anchor = typeof auditAnchors.$inferSelect;
function configuration() {
  const rawUrl = process.env.REGULAIT_TSA_URL?.trim();
  const file = process.env.REGULAIT_TSA_TRUST_BUNDLE?.trim();
  if (!rawUrl && !file) return null;
  try {
    if (!rawUrl || !file) throw new Error();
    const url = new URL(rawUrl);
    // HTTPS and the normal admin allow list, including explicit private-range
    // entries for an internal TSA. No default authority or redirect transport.
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error();
    if (!statSync(file).isFile() || statSync(file).size > TSA_DER_LIMIT) throw new Error();
    const trust = parseTimestampTrustBundle(readFileSync(file, "utf8"));
    const policyOid = process.env.REGULAIT_TSA_POLICY_OID?.trim();
    if (policyOid && !isCanonicalPolicyOid(policyOid)) throw new Error();
    return { url: url.toString(), trust, ...(policyOid ? { policyOid } : {}) };
  } catch { throw new TimestampValidationError("timestamp_configuration_invalid"); }
}
/** ADR-0186 decision 30 item 4: a policy OID must be the canonical dotted form that the ASN.1 encoder in use
 * (asn1js, which pkijs serialises `reqPolicy` with) encodes and decodes back to the same string. The round trip
 * enforces the X.660 grammar: the first arc 0-2, the second arc 0-39 under 0 or 1 (asn1js folds a larger one
 * into the next first arc, so it decodes differently), no leading zeros and at least two arcs. */
export function isCanonicalPolicyOid(value: string): boolean {
  if (value.length > 256 || !/^[0-2](?:\.(?:0|[1-9][0-9]*))+$/.test(value)) return false;
  try {
    const oid = new asn1.ObjectIdentifier({ value });
    if (oid.valueBlock.error) return false;
    const decoded = asn1.fromBER(oid.toBER(false));
    return decoded.offset !== -1 && decoded.result instanceof asn1.ObjectIdentifier && decoded.result.getValue() === value;
  } catch { return false; }
}
export function anchorCanonicalBytes(record: AnchorRecord): Uint8Array {
  return Buffer.from(canonicalJson(record), "utf8");
}
/** The existing text column stores versioned public timestamp metadata.
 * Legacy bare base64 rows were issued with regulait.audit.v1. */
function storedTimestamp(value:string|null):{payloadVersion:string;replyDer:string|null}|null{
 if(!value?.startsWith("{"))return null;
 const data=JSON.parse(value);
 if(data.format!=="regulait.timestamp.v1"||typeof data.payloadVersion!=="string"||!(data.replyDer===null||typeof data.replyDer==="string"))throw new TimestampValidationError("timestamp_storage_invalid");
 return data;
}
function timestampStorage(payloadVersion:string,replyDer:string|null){return JSON.stringify({format:"regulait.timestamp.v1",payloadVersion,replyDer});}
export function anchorRecordFromRow(row: Anchor): AnchorRecord {
  return { seq: row.seq, rowHash: row.rowHash, headAt: row.headAt.toISOString(), algorithm: row.algorithm, payloadVersion: storedTimestamp(row.tsaToken)?.payloadVersion ?? "regulait.audit.v1", capturedAt: row.createdAt.toISOString() };
}
export function anchorTimestampSummary(row: Anchor) {
  return { status: row.tsaStatus, genTime: row.tsaGenTime?.toISOString() ?? null, tsaUrl: row.tsaUrl, serial: row.tsaSerial, policyOid: row.tsaPolicyOid, verified: row.tsaStatus === "granted" && !!row.tsaToken && !!row.tsaGenTime && !!row.tsaMessageImprint };
}
export function timestampRequest(record: AnchorRecord) {
  let nonce = randomBytes(16);
  while (nonce.length > 1 && nonce[0] === 0) nonce = nonce.subarray(1);
  if (nonce[0]! & 0x80) nonce = Buffer.concat([Buffer.from([0]), nonce]);
  const bytes = anchorCanonicalBytes(record), imprint = createHash("sha256").update(bytes).digest();
  const request = new TimeStampReq({ version: 1, messageImprint: new MessageImprint({ hashAlgorithm: new AlgorithmIdentifier({ algorithmId: TSA_SHA256_OID, algorithmParams: new asn1.Null() }), hashedMessage: new asn1.OctetString({ valueHex: new Uint8Array(imprint).buffer }) }), nonce: new asn1.Integer({ valueHex: new Uint8Array(nonce).buffer }), certReq: true });
  return { request, bytes, nonceHex: nonce.toString("hex"), imprint: imprint.toString("hex") };
}
async function boundedResponse(response: Response): Promise<Uint8Array> {
  if (!response.ok || response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/timestamp-reply" || !response.body) {
    await response.body?.cancel();
    throw new TimestampValidationError("timestamp_http_response_invalid");
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > TSA_DER_LIMIT) { await reader.cancel(); throw new TimestampValidationError("timestamp_der_size"); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts, size);
}
async function timestampAnchor(db: Db, id: string, now: Date, options: { record?: AnchorRecord; force?: boolean } = {}) {
  return db.transaction(async (tx) => {
    // One writer across capture, scheduled retry and manual retry. No network
    // attempt or nonce can overwrite a concurrently granted token.
    const lock=await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${id})) as acquired`);
    if(!(lock.rows[0] as {acquired:boolean}).acquired)return {state:"timestamp_in_progress" as const,attempted:0,granted:0,failed:0};
    const [row] = await tx.select().from(auditAnchors).where(eq(auditAnchors.id, id));
    if (!row) return { state: "missing" as const, attempted: 0, granted: 0, failed: 0 };
    if (row.tsaStatus === "granted") return { state: "granted" as const, attempted: 0, granted: 0, failed: 0 };
    const record=options.record ?? anchorRecordFromRow(row);
    // Pin the captured record's version even on failures or absent TSA config.
    await tx.update(auditAnchors).set({tsaToken:timestampStorage(record.payloadVersion,null)}).where(eq(auditAnchors.id,id));
    const org = await loadOrgSettings(tx as unknown as Db);
    if (org.auditAnchorTimestampMode === "off") return { state: "off" as const, attempted: 0, granted: 0, failed: 0 };
    if (!options.force && (row.tsaAttempts >= MAX_ATTEMPTS || (row.tsaNextAttemptAt && row.tsaNextAttemptAt > now))) return { state: "backoff" as const, attempted: 0, granted: 0, failed: 0 };
    anchorRecordFromRow(row);
    let request: ReturnType<typeof timestampRequest> | undefined;
    let tsaUrl: string | undefined;
    // A configuration error is an operator fault, not a TSA failure: it never consumes an attempt or schedules
    // backoff, and the anchor is retried as soon as the configuration is corrected (ADR-0186 decision 30 item 4).
    let config: ReturnType<typeof configuration>;
    try { config = configuration(); } catch (error) {
      const code = error instanceof TimestampValidationError ? error.message : "timestamp_configuration_invalid";
      await tx.update(auditAnchors).set({ tsaStatus: "pending", tsaLastError: code }).where(eq(auditAnchors.id, id));
      return { state: "configuration_invalid" as const, attempted: 0, granted: 0, failed: 0 };
    }
    try {
      if (!config) {
        await tx.update(auditAnchors).set({ tsaStatus: "not_configured", tsaLastError: null, tsaNextAttemptAt: null }).where(eq(auditAnchors.id, id));
        return { state: "not_configured" as const, attempted: 0, granted: 0, failed: 0 };
      }
      tsaUrl = config.url;
      if (row.status !== "flushed") {
        await tx.update(auditAnchors).set({ tsaStatus: "pending", tsaLastError: "timestamp_waiting_for_anchor_flush" }).where(eq(auditAnchors.id, id));
        return { state: "pending" as const, attempted: 0, granted: 0, failed: 0 };
      }
      request = timestampRequest(record);
      if (config.policyOid) request.request.reqPolicy = config.policyOid;
      const signal=AbortSignal.timeout(DEADLINE_MS);
      const fetch = createGuardedFetch({ beforeSend:async()=>signal.throwIfAborted(), allowList: await loadEgressAllowList(tx as unknown as Db), providerAllowsPlaintextHttp: false });
      // ADR-0189 R33: the nonce and the DATABASE-clock send time are recorded in one statement BEFORE the
      // request leaves, and that recorded time is the `sentAt` the response is checked against, so the
      // offline verifier can re-run exactly this check from the stored row.
      const [recordedRequest] = await tx.update(auditAnchors).set({ tsaNonce: request.nonceHex, tsaRequestSentAt: sql`clock_timestamp()` }).where(eq(auditAnchors.id, id)).returning({ sentAt: auditAnchors.tsaRequestSentAt });
      const recordedSentAt = recordedRequest?.sentAt ?? (() => { throw new Error("timestamp_request_not_recorded"); })();
      // the live check uses the LATER of the recorded database time and this process's clock (never looser
      // than either); the stored database time is what the offline verifier re-checks against
      const sentAt = new Date(Math.max(recordedSentAt.getTime(), Date.now()));
      let onAbort:()=>void=()=>{};
      const aborted=new Promise<never>((_,reject)=>{onAbort=()=>reject(signal.reason);signal.addEventListener("abort",onAbort,{once:true});if(signal.aborted)onAbort();});
      const bytes=await Promise.race([(async()=>await boundedResponse(await fetch(config.url, { method: "POST", headers: { "content-type": "application/timestamp-query", accept: "application/timestamp-reply" }, body: new Uint8Array(request.request.toSchema().toBER(false)), signal: signal })))(),aborted]).finally(()=>signal.removeEventListener("abort",onAbort));
      const checked = await verifyTimestampResponse(bytes, { bytes: request.bytes, nonceHex: request.nonceHex, trust: config.trust, ...(config.policyOid ? { policyOid: config.policyOid } : {}), now: new Date(), sentAt });
      await tx.update(auditAnchors).set({ tsaStatus: "granted", tsaUrl: config.url, tsaToken: timestampStorage(record.payloadVersion,checked.tokenBase64), tsaGenTime: checked.genTime, tsaSerial: checked.serial, tsaPolicyOid: checked.policyOid, tsaMessageImprint: checked.imprint, tsaNonce: request.nonceHex, tsaAttempts: row.tsaAttempts + 1, tsaNextAttemptAt: null, tsaLastError: null }).where(eq(auditAnchors.id, id));
      return { state: "granted" as const, attempted: 1, granted: 1, failed: 0 };
    } catch (error) {
      const attempts = row.tsaAttempts + 1;
      const code = error instanceof TimestampValidationError ? error.message : "timestamp_transport_or_validation_failed";
      await tx.update(auditAnchors).set({ tsaStatus: "failed", ...(tsaUrl ? { tsaUrl } : {}), ...(request ? { tsaNonce: request.nonceHex, tsaMessageImprint: request.imprint } : {}), tsaAttempts: attempts, tsaLastError: code, tsaNextAttemptAt: new Date(now.getTime() + Math.min(86400, 60 * 2 ** Math.min(attempts - 1, 11)) * 1000) }).where(eq(auditAnchors.id, id));
      return { state: "failed" as const, attempted: 1, granted: 0, failed: 1 };
    }
  });
}
export const anchorTimestamper: AnchorTimestamper = {
  async afterFlush(db, anchor) { await timestampAnchor(db, anchor.id, new Date(), { record: anchor.record }); },
};
export interface AnchorTimestampSweepResult { attempted: number; granted: number; failed: number; state: "not_built" | "not_configured" | "configuration_invalid" | "off" | "active" }
export async function runAnchorTimestampSweep(db: Db, opts: { now: Date } = { now: new Date() }): Promise<AnchorTimestampSweepResult> {
  if ((await loadOrgSettings(db)).auditAnchorTimestampMode === "off") return { attempted: 0, granted: 0, failed: 0, state: "off" };
  const rows = await db.select().from(auditAnchors).where(and(eq(auditAnchors.status, "flushed"), ne(auditAnchors.tsaStatus, "granted"), sql`${auditAnchors.tsaAttempts} < ${MAX_ATTEMPTS}`, sql`(${auditAnchors.tsaNextAttemptAt} IS NULL OR ${auditAnchors.tsaNextAttemptAt} <= ${opts.now})`)).orderBy(asc(auditAnchors.seq)).limit(10);
  const result: AnchorTimestampSweepResult = { attempted: 0, granted: 0, failed: 0, state: "active" };
  for (const row of rows) {
    const out = await timestampAnchor(db, row.id, opts.now);
    result.attempted += out.attempted; result.granted += out.granted; result.failed += out.failed;
    if (out.state === "not_configured") result.state = "not_configured";
    if (out.state === "configuration_invalid") result.state = "configuration_invalid";
  }
  if (!rows.length && !process.env.REGULAIT_TSA_URL && !process.env.REGULAIT_TSA_TRUST_BUNDLE) result.state = "not_configured";
  return result;
}
export function anchorTimestampJobDefinitions(): SchedulerJobDefinition[] {
  return [{ name: ANCHOR_TIMESTAMP_JOB_NAME, description: "Obtain and verify bounded RFC 3161 timestamps using configured trust and pinned egress; retry with backoff, never change the anchor flush result.", adr: "ADR-0186", defaultIntervalSeconds: 300, run: async (ctx) => { const out = await runAnchorTimestampSweep(ctx.db, { now: ctx.now }); return { itemsProcessed: out.attempted, detail: { ...out } }; } }];
}
export function registerAuditTimestampRoutes(app: FastifyInstance, db: Db): void {
  const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
  app.post("/v1/audit/anchors/:anchorId/timestamp", async (req, reply) => {
    const { anchorId } = req.params as { anchorId: string };
    if (!validId(anchorId)) return reply.status(400).send({ error: "invalid_anchor_id" });
    const out = await timestampAnchor(db, anchorId, new Date(), { force: true });
    if (out.state === "timestamp_in_progress") return reply.status(409).send({error:"timestamp_in_progress"});
    if (out.state === "missing") return reply.status(404).send({ error: "anchor_not_found" });
    const [row] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, anchorId));
    await db.insert(auditLog).values({ userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000", objectType: "audit_chain", objectId: anchorId, effect: out.state === "granted" ? "allow" : "deny", ruleId: "audit-anchor-timestamp-retried", ruleChain: [], reason: "Admin requested anchor timestamp retry", detail: { state: out.state, attempted: out.attempted } });
    return reply.status(out.state === "granted" ? 200 : out.state === "failed" ? 502 : 409).send({ state: out.state, timestamp: anchorTimestampSummary(row!) });
  });
  app.get("/v1/audit/anchors/:anchorId/timestamp.tsr", async (req, reply) => {
    const { anchorId } = req.params as { anchorId: string };
    if (!validId(anchorId)) return reply.status(400).send({ error: "invalid_anchor_id" });
    const [row] = await db.select().from(auditAnchors).where(eq(auditAnchors.id, anchorId));
    if (!row) return reply.status(404).send({ error: "anchor_not_found" });
    if (row.tsaStatus !== "granted" || !row.tsaToken) return reply.status(409).send({ error: "anchor_not_timestamped" });
    try { return reply.type("application/timestamp-reply").header("cache-control", "no-store").send(timestampReplyBytes(storedTimestamp(row.tsaToken)?.replyDer ?? row.tsaToken)); }
    catch { return reply.status(500).send({ error: "timestamp_token_unreadable" }); }
  });
}
