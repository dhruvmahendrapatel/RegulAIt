import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { and, asc, auditLog, decisionReceipts, desc, eq, gt, gte, inArray, isNotNull, loadAuditChainBoundary, lte, receiptSigningKeys, schedulerJobs, sql, type Db } from "@regulait/db";
import { auditChainVersionAt, auditContentHashFor, auditRowHash, auditRowVersionProblem, isDecisionReceiptPayload, isReceiptBundle, RECEIPT_GENESIS_PREV, RECEIPT_OBJECT_TYPES, RECEIPT_PAYLOAD_VERSION, receiptCanonicalBytes, receiptPayloadHash, verifyReceiptBundle, type DecisionReceiptPayload, type ReceiptPublicKey, type ReceiptSigningState, type SignedDecisionReceipt } from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import type { SchedulerJobDefinition } from "./scheduler.js";

/** ADR-0186 R: one-writer, append-only receipts for chained governed decisions. */
export const DECISION_RECEIPT_SIGN_JOB_NAME = "decision-receipt-sign-sweep";
export const RECEIPT_SIGN_LOCK_KEY = 6_000_000_186;
const SWEEP_LIMIT = 500;
const EXPORT_LIMIT = 5000;
export interface DecisionReceiptSweepResult { signed: number; state: ReceiptSigningState }

class ReceiptKeyError extends Error { constructor() { super("Receipt signing key configuration is invalid or conflicts with its recorded public key."); } }
interface SigningKey { keyId: string; privateKey: KeyObject; jwk: ReceiptPublicKey["jwk"] }
function signingKey(): SigningKey | null {
  const file = process.env.REGULAIT_RECEIPT_SIGNING_KEY?.trim();
  const keyId = process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID?.trim();
  if (!file && !keyId) return null;
  if (!file || !keyId) throw new ReceiptKeyError();
  try {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(keyId) || !statSync(file).isFile() || statSync(file).size > 16384) throw new ReceiptKeyError();
    const pem = readFileSync(file);
    if (pem.length > 16384 || !pem.toString("utf8").startsWith("-----BEGIN PRIVATE KEY-----")) throw new ReceiptKeyError();
    const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519") throw new ReceiptKeyError();
    const publicKey = createPublicKey(pem).export({ format: "jwk" });
    if (publicKey.kty !== "OKP" || publicKey.crv !== "Ed25519" || !publicKey.x || publicKey.d) throw new ReceiptKeyError();
    return { keyId, privateKey, jwk: { kty: "OKP", crv: "Ed25519", x: publicKey.x } };
  } catch { throw new ReceiptKeyError(); }
}
const samePublicKey = (a: ReceiptPublicKey["jwk"], b: ReceiptPublicKey["jwk"]) => a.kty === b.kty && a.crv === b.crv && a.x === b.x;
const envelope = (row: typeof decisionReceipts.$inferSelect): SignedDecisionReceipt => ({ receiptSeq: row.receiptSeq, payload: row.payload as DecisionReceiptPayload, signature: row.signature, keyId: row.keyId });
const publicKeys = async (db: Db): Promise<ReceiptPublicKey[]> => (await db.select().from(receiptSigningKeys).orderBy(asc(receiptSigningKeys.createdAt))).map((key) => ({ keyId: key.keyId, jwk: key.publicJwk, firstUsedAt: key.firstUsedAt?.toISOString() ?? null, retiredAt: key.retiredAt?.toISOString() ?? null }));

// Receipt eligibility is classified at the writer and is fail-closed. Unknown
// or historical unclassified rows remain in the audit chain, not this stream.
const eligibleAfter=(seq:number)=>and(isNotNull(auditLog.seq),gt(auditLog.seq,seq),inArray(auditLog.objectType,[...RECEIPT_OBJECT_TYPES]),sql`${auditLog.detail}->>'receiptClass' = 'decision'`);
function boundedDecisionField(value:string|null){return value===null||value.length<=4096?{value}:{value:null,hash:createHash("sha256").update(value,"utf8").digest("hex")};}
export async function runDecisionReceiptSignSweep(db: Db, opts: { now: Date } = { now: new Date() }): Promise<DecisionReceiptSweepResult> {
  if ((await loadOrgSettings(db)).decisionReceiptsMode === "off") return { signed: 0, state: "off" };
  const key = signingKey();
  if (!key) return { signed: 0, state: "no_key" };
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${RECEIPT_SIGN_LOCK_KEY})`);
    // Recheck mode inside the same write transaction, after waiting for a writer.
    if ((await loadOrgSettings(tx as unknown as Db)).decisionReceiptsMode === "off") return { signed: 0, state: "off" as const };
    const [recorded] = await tx.select().from(receiptSigningKeys).where(eq(receiptSigningKeys.keyId, key.keyId));
    if (recorded && (!samePublicKey(recorded.publicJwk, key.jwk) || recorded.retiredAt)) throw new ReceiptKeyError();
    const [last] = await tx.select().from(decisionReceipts).orderBy(desc(decisionReceipts.receiptSeq)).limit(1);
    if (last) {
      const keys = await publicKeys(tx as unknown as Db);
      const checked = verifyReceiptBundle({ verifier: RECEIPT_PAYLOAD_VERSION, receipts: [envelope(last)], keys });
      if (!keys.some((k) => k.keyId === last.keyId) || checked.results.some((r) => r.status === "invalid") ||
          !isDecisionReceiptPayload(last.payload) || last.payloadHash !== receiptPayloadHash(last.payload) || last.prevHash !== last.payload.prev)
        throw new Error("Receipt chain tip failed integrity verification; no new receipts signed.");
    }
    const rows = await tx.select().from(auditLog).where(eligibleAfter(last?.auditSeq ?? 0)).orderBy(asc(auditLog.seq)).limit(SWEEP_LIMIT);
    if (!rows.length) return { signed: 0, state: "signing" as const };
    if (!recorded) await tx.insert(receiptSigningKeys).values({ keyId: key.keyId, publicJwk: key.jwk, firstUsedAt: opts.now });
    // ADR-0188 decision 19: rows from the recorded v2 boundary on hash as v2 (and must say so)
    // the one boundary loader the writer and verifier share (X35 I7S-02): an unknown version signs nothing
    const boundary = await loadAuditChainBoundary(tx);
    if (!boundary.supported) throw new Error(`Audit chain boundary unsupported (${boundary.detail}); no receipts signed.`);
    const v2FromSeq = boundary.v2FromSeq;
    let receiptSeq = last?.receiptSeq ?? 0;
    let prev = last?.payloadHash ?? RECEIPT_GENESIS_PREV;
    for (const row of rows) {
      // Never notarise corrupted audit content merely because the stored hash exists.
      if (row.seq === null || !row.contentHash || !row.rowHash || !row.prevHash ||
          auditRowVersionProblem({ ...row, seq: row.seq }, v2FromSeq) !== null ||
          row.contentHash !== auditContentHashFor(row, auditChainVersionAt(row.seq, v2FromSeq)) || row.rowHash !== auditRowHash(row.prevHash, row.contentHash))
        throw new Error("Audit row failed integrity verification; no receipts from this pass committed.");
      const tool=boundedDecisionField(row.toolName),rule=boundedDecisionField(row.ruleId);
      const payload: DecisionReceiptPayload = {
        v: RECEIPT_PAYLOAD_VERSION, receiptSeq: ++receiptSeq,
        audit: { id: row.id, seq: row.seq, rowHash: row.rowHash, contentHash: row.contentHash },
        decision: { at: row.at.toISOString(), userId: row.userId, objectType: row.objectType, objectId: row.objectId, serverId: row.serverId, toolName: tool.value, ...(tool.hash?{toolNameHash:tool.hash}:{}), effect: row.effect, ruleId: rule.value, ...(rule.hash?{ruleIdHash:rule.hash}:{}) },
        prev, keyId: key.keyId,
      };
      if (!isDecisionReceiptPayload(payload)) throw new Error("Audit decision cannot be represented by the receipt contract.");
      const payloadHash = receiptPayloadHash(payload);
      const signature = sign(null, Buffer.from(receiptCanonicalBytes(payload)), key.privateKey).toString("base64url");
      await tx.insert(decisionReceipts).values({ receiptSeq, auditId: row.id, auditSeq: row.seq, payload, payloadHash, prevHash: prev, signature, keyId: key.keyId, createdAt: opts.now });
      prev = payloadHash;
    }
    if (recorded && !recorded.firstUsedAt) await tx.update(receiptSigningKeys).set({ firstUsedAt: opts.now }).where(eq(receiptSigningKeys.keyId, key.keyId));
    return { signed: rows.length, state: "signing" as const };
  });
}

export function decisionReceiptJobDefinitions(): SchedulerJobDefinition[] {
  return [{ name: DECISION_RECEIPT_SIGN_JOB_NAME, description: "Sign bounded audit-ordered decision receipts using the deployment Ed25519 key; one writer, no reason/detail text.", adr: "ADR-0186", defaultIntervalSeconds: 60,
    run: async (ctx) => { const out = await runDecisionReceiptSignSweep(ctx.db, { now: ctx.now }); return { itemsProcessed: out.signed, detail: { ...out } }; } }];
}

function integer(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
export function registerDecisionReceiptRoutes(app: FastifyInstance, db: Db, _opts: { dataKey?: string } = {}): void {
  app.get("/v1/receipts", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const from = integer(q.fromSeq, 1), limit = integer(q.limit, 100);
    if (from === null || limit === null || limit > 500) return reply.status(400).send({ error: "invalid_receipt_range" });
    const rows=await db.select().from(decisionReceipts).where(gte(decisionReceipts.receiptSeq,from)).orderBy(asc(decisionReceipts.receiptSeq)).limit(limit);
    await db.insert(auditLog).values({userId:req.authCtx.userId??"00000000-0000-0000-0000-000000000000",objectType:"decision_receipt",effect:"allow",ruleId:"decision-receipts-listed",ruleChain:[],reason:"Decision receipt envelopes listed",detail:{fromSeq:from,limit,rows:rows.length}});
    return {receipts:rows.map(envelope)};
  });
  app.get("/v1/receipts/status", async (_req, reply) => {
    const [last] = await db.select().from(decisionReceipts).orderBy(desc(decisionReceipts.receiptSeq)).limit(1);
    const counts = await db.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(eligibleAfter(last?.auditSeq ?? 0));
    let state: ReceiptSigningState = "off";
    if ((await loadOrgSettings(db)).decisionReceiptsMode !== "off") {
      try {
        const key = signingKey();
        if (key) {
          const [recorded] = await db.select().from(receiptSigningKeys).where(eq(receiptSigningKeys.keyId, key.keyId));
          if (recorded && (!samePublicKey(recorded.publicJwk, key.jwk) || recorded.retiredAt)) throw new ReceiptKeyError();
        }
        state = key ? "signing" : "no_key";
      }
      catch { return reply.status(503).send({ error: "receipt_signing_key_invalid" }); }
    }
    const [job]=await db.select().from(schedulerJobs).where(eq(schedulerJobs.name,DECISION_RECEIPT_SIGN_JOB_NAME));
    const [oldest]=await db.select({at:auditLog.at}).from(auditLog).where(eligibleAfter(last?.auditSeq??0)).orderBy(asc(auditLog.seq)).limit(1);
    const stalled=state==="signing"&&(job?.lastOutcome==="failed"||job?.enabled===false|| (!!oldest&&oldest.at.getTime()<Date.now()-120000));
    if(stalled)state="stalled";
    return { state, lastSweep:job?{at:job.lastFinishedAt?.toISOString()??null,outcome:job.lastOutcome}:null, lastSeq: last?.receiptSeq ?? 0, lagRows: counts[0]?.n ?? 0 };
  });
  app.get("/v1/receipts/keys", async () => ({ keys: await publicKeys(db) }));
  app.get("/v1/receipts/export", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const [last] = await db.select().from(decisionReceipts).orderBy(desc(decisionReceipts.receiptSeq)).limit(1);
    const from = integer(q.fromSeq, 1), to = integer(q.toSeq, last?.receiptSeq ?? 0);
    if (from === null || to === null || to < from || to - from + 1 > EXPORT_LIMIT) return reply.status(400).send({ error: "invalid_receipt_export_range", detail: "Choose a nonempty range of at most 5000 receipts." });
    const rows = await db.select().from(decisionReceipts).where(and(gte(decisionReceipts.receiptSeq, from), lte(decisionReceipts.receiptSeq, to))).orderBy(asc(decisionReceipts.receiptSeq)).limit(EXPORT_LIMIT);
    await db.insert(auditLog).values({ userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000", objectType: "decision_receipt", objectId: null, effect: "allow", ruleId: "decision-receipt-exported", ruleChain: [], reason: "Decision receipt bundle exported", detail: { fromSeq: from, toSeq: to, rows: rows.length } });
    return { receipts: rows.map(envelope), keys: await publicKeys(db), verifier: RECEIPT_PAYLOAD_VERSION };
  });
  app.post("/v1/receipts/verify", { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    if (!isReceiptBundle(req.body)) return reply.status(400).send({ error: "invalid_receipt_bundle" });
    const trusted=await publicKeys(db);
    return {...verifyReceiptBundle({...req.body,keys:trusted}),trust:"deployment_registry"};
  });
  app.get("/v1/receipts/:auditId", async (req, reply) => {
    const { auditId } = req.params as { auditId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(auditId)) return reply.status(400).send({ error: "invalid_audit_id" });
    const rows = await db.select().from(decisionReceipts).where(eq(decisionReceipts.auditId, auditId));
    await db.insert(auditLog).values({userId:req.authCtx.userId??"00000000-0000-0000-0000-000000000000",objectType:"decision_receipt",objectId:auditId,effect:"allow",ruleId:"decision-receipt-read",ruleChain:[],reason:"Decision receipt envelope read",detail:{rows:rows.length}});
    return { receipts: rows.map(envelope) };
  });
}
