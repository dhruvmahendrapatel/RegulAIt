import { createHash, sign, type KeyObject } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { filterParams, parseListExport, parseListPage, runListPage, sendListError, sendListExport, type ListReader, type ListSpec } from "./list-contract.js";
import { and, asc, auditLog, decisionCaptureStatus, decisionReceipts, desc, eq, gt, gte, inArray, isNotNull, isNull, loadAuditChainBoundary, lte, receiptSigningKeys, schedulerJobs, sql, type Db } from "@regulait/db";
import { auditChainVersionAt, auditContentHashFor, auditRowHash, auditRowVersionProblem, isDecisionReceiptPayload, isDecisionReceiptPayloadV1, isReceiptBundle, RECEIPT_EMITTER_SUPPORTS_V2, RECEIPT_GENESIS_PREV, RECEIPT_OBJECT_TYPES, RECEIPT_PAYLOAD_VERSION, RECEIPT_PAYLOAD_VERSION_V2, receiptCanonicalBytes, receiptPayloadHash, receiptVersionForAuditSeq, type AnyDecisionReceiptPayload, type DecisionReceiptPayloadV2, verifyReceiptBundle, type DecisionReceiptPayload, type ReceiptPublicKey, type ReceiptSigningState, type SignedDecisionReceipt } from "@regulait/shared";
import { loadOrgSettings } from "./org-settings.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { isReceiptKeyId, ReceiptKeyError, receiptPublicKeyFingerprint, receiptSigningKeyPosture, resolveReceiptSigningKey, type ReceiptKeySource } from "./receipt-signing-key.js";
import { requireStepUp, type StepUpCheckArgs } from "./step-up.js";

/** ADR-0186 R: one-writer, append-only receipts for chained governed decisions. */
export const DECISION_RECEIPT_SIGN_JOB_NAME = "decision-receipt-sign-sweep";
export const RECEIPT_SIGN_LOCK_KEY = 6_000_000_186;
const SWEEP_LIMIT = 500;
const EXPORT_LIMIT = 5000;
export interface DecisionReceiptSweepResult { signed: number; state: ReceiptSigningState }

interface SigningKey { keyId: string; privateKey: KeyObject; jwk: ReceiptPublicKey["jwk"]; source: ReceiptKeySource }
/**
 * ADR-0186 receipt key, ADR-0189 R25 item 12: the operator key (REGULAIT_RECEIPT_SIGNING_KEY +
 * _ID) when set, else the install-generated key (receipt-signing-key.ts), else null. Throws
 * ReceiptKeyError when a configured key is unusable.
 */
function signingKey(): SigningKey | null {
  const key = resolveReceiptSigningKey(process.env);
  return key ? { keyId: key.keyId, privateKey: key.privateKey, jwk: key.jwk, source: key.source } : null;
}

export const RECEIPT_KEY_REGISTERED_RULE_ID = "receipt-signing-key-registered";
export const RECEIPT_KEY_RETIRED_RULE_ID = "receipt-signing-key-retired";
export const RECEIPT_KEY_RETIRE_REFUSED_RULE_ID = "receipt-signing-key-retire-refused";
/** migration 0203: retiring a receipt key is a `key_management` step-up bound to the op and the exact key */
export const receiptKeyRetireStepUp = (keyId: string): StepUpCheckArgs => ({ kind: "key_management", facts: { op: "receipt_key_retire", keyId } });
const SYSTEM_ACTOR = "00000000-0000-0000-0000-000000000000";
/**
 * ADR-0189 R25 item 12: record a receipt signing key on its first use, and AUDIT it in the same
 * transaction. Every writer that registers a key (the receipt sweep, an AI BOM snapshot, a Decision
 * BOM) goes through here. The insert is ON CONFLICT DO NOTHING ... RETURNING, so of two writers racing
 * on one key exactly one inserts and writes the audit row; the other waits on the key's unique index,
 * finds the committed row, and writes nothing. A key that replaces a lost one has a new key id, so it is
 * registered (and audited) once of its own. The row carries the key id, the SPKI fingerprint and the
 * source, never key material. Returns true when this call registered the key.
 *
 * #353 follow-up: when another writer registered the key id first, the committed row is read back and
 * this call throws `ReceiptKeyError` if it records a DIFFERENT public key (two replicas configured with
 * one key id and different keys) or is retired, so nothing is signed under a key id whose recorded
 * public key would not verify it.
 */
export async function registerReceiptSigningKey(
  tx: Pick<Db, "insert" | "select">,
  key: Pick<SigningKey, "keyId" | "jwk" | "source">,
  firstUsedAt: Date,
  via: "receipt-sweep" | "ai-bom-snapshot" | "decision-bom",
): Promise<boolean> {
  const inserted = await tx.insert(receiptSigningKeys).values({ keyId: key.keyId, publicJwk: key.jwk, firstUsedAt }).onConflictDoNothing().returning({ keyId: receiptSigningKeys.keyId });
  if (inserted.length === 0) {
    const [recorded] = await tx.select().from(receiptSigningKeys).where(eq(receiptSigningKeys.keyId, key.keyId)).for("share");
    if (!recorded || !samePublicKey(recorded.publicJwk, key.jwk) || recorded.retiredAt) throw new ReceiptKeyError();
    return false;
  }
  await tx.insert(auditLog).values({
    userId: SYSTEM_ACTOR, objectType: "decision_receipt", objectId: null, effect: "allow", ruleId: RECEIPT_KEY_REGISTERED_RULE_ID, ruleChain: [],
    reason: `Receipt signing key ${key.keyId} registered on first use (${key.source})`,
    detail: { keyId: key.keyId, publicKeyFingerprint: receiptPublicKeyFingerprint(key.jwk), source: key.source, via },
  });
  return true;
}
const samePublicKey = (a: ReceiptPublicKey["jwk"], b: ReceiptPublicKey["jwk"]) => a.kty === b.kty && a.crv === b.crv && a.x === b.x;
const envelope = (row: typeof decisionReceipts.$inferSelect): SignedDecisionReceipt => ({ receiptSeq: row.receiptSeq, payload: row.payload as DecisionReceiptPayload, signature: row.signature, keyId: row.keyId });

/**
 * ADR-0189 R34 / R42 / R43 — the recorded receipt v2 boundary: the first audit
 * seq that v2 governs, or null (no boundary: every receipt is v1). Read from the
 * append-only, verifier-trusted `receipt_payload_versions` table; every writer
 * reads it under the receipt sign lock before each pass.
 */
export async function loadReceiptV2Boundary(db: { execute: Db["execute"] }): Promise<number | null> {
  const res = (await db.execute(sql`select min("from_audit_seq")::bigint as "from" from "receipt_payload_versions"`)) as unknown as { rows: Array<{ from: string | number | null }> };
  const from = res.rows[0]?.from;
  return from === null || from === undefined ? null : Number(from);
}

/** R43: thrown at boot when a receipt v2 boundary exists and this build cannot emit v2 receipts with facts */
export class ReceiptV2BootError extends Error {
  constructor(readonly fromAuditSeq: number) {
    super(
      `A receipt v2 boundary is recorded (from audit seq ${fromAuditSeq}), and this build emits v1 receipts only. ` +
        "Refusing to start: a v1 receipt at or above the boundary is invalid (ADR-0189 R43). Deploy a build that emits v2.",
    );
    this.name = "ReceiptV2BootError";
  }
}
/** R43: every binary from B1 on checks at boot; this one refuses to start once a boundary exists */
export async function assertReceiptEmitterBootable(db: { execute: Db["execute"] }, supportsV2: boolean = RECEIPT_EMITTER_SUPPORTS_V2): Promise<void> {
  const from = await loadReceiptV2Boundary(db);
  if (from !== null && !supportsV2) throw new ReceiptV2BootError(from);
}
const publicKeys = async (db: Db): Promise<ReceiptPublicKey[]> => (await db.select().from(receiptSigningKeys).orderBy(asc(receiptSigningKeys.createdAt))).map((key) => ({ keyId: key.keyId, jwk: key.publicJwk, firstUsedAt: key.firstUsedAt?.toISOString() ?? null, retiredAt: key.retiredAt?.toISOString() ?? null }));

// Receipt eligibility is classified at the writer and is fail-closed. Unknown
// or historical unclassified rows remain in the audit chain, not this stream.
const eligibleAfter=(seq:number)=>and(isNotNull(auditLog.seq),gt(auditLog.seq,seq),inArray(auditLog.objectType,[...RECEIPT_OBJECT_TYPES]),sql`${auditLog.detail}->>'receiptClass' = 'decision'`);
function boundedDecisionField(value:string|null){return value===null||value.length<=4096?{value}:{value:null,hash:createHash("sha256").update(value,"utf8").digest("hex")};}
/**
 * ADR-0189 R34 / B2: the v2 receipt payload of one decision at or above the boundary: v1's fields, the actor
 * binding from ADR-0188's columns, and `factsStatus` / `factsHash` from the decision's capture-status marker.
 * Pure. Throws (the pass stops, as an integrity failure does) on a missing marker or an audit v1 row, whose
 * hash does not cover the actor columns. Not reachable from the sweep until the cutover slice sets
 * `RECEIPT_EMITTER_SUPPORTS_V2`; B2 ships it with its tests so that slice only flips the switch.
 */
export function receiptV2PayloadFor(
  v1: DecisionReceiptPayload,
  row: Pick<typeof auditLog.$inferSelect, "id" | "seq" | "chainVersion" | "actorIdentityId" | "delegationGrantId" | "actorChain">,
  marker: Pick<typeof decisionCaptureStatus.$inferSelect, "auditSeq" | "status" | "factsHash"> | undefined,
): DecisionReceiptPayloadV2 {
  if (!marker || marker.auditSeq !== row.seq) throw new Error("Decision at or above the receipt v2 boundary has no capture-status marker; no receipts from this pass committed.");
  if (row.chainVersion !== 2) throw new Error("Decision at or above the receipt v2 boundary is not an audit v2 row; run the audit v2 cutover first. No receipts from this pass committed.");
  const payload: DecisionReceiptPayloadV2 = {
    ...v1, v: RECEIPT_PAYLOAD_VERSION_V2,
    actor: { identityId: row.actorIdentityId, delegationGrantId: row.delegationGrantId, chain: row.actorChain ? [...row.actorChain] : null },
    factsStatus: marker.status, factsHash: marker.status === "captured" ? marker.factsHash : null,
  };
  if (!isDecisionReceiptPayload(payload) || payload.v !== RECEIPT_PAYLOAD_VERSION_V2) throw new Error("Audit decision cannot be represented by the receipt v2 contract.");
  return payload;
}

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
    // R43: the v2 boundary, read under the sign lock before the pass. Rows below it are always v1, whenever
    // the sweep reaches them (R42). This build EMITS v1 only (`RECEIPT_EMITTER_SUPPORTS_V2`, flipped by the
    // cutover slice, not by B2): it signs nothing at or above the boundary and never throws on such a row; the
    // `decision_receipts_version_guard` trigger refuses a v1 receipt there in any case.
    const v2FromAuditSeq = await loadReceiptV2Boundary(tx as unknown as Db);
    const [last] = await tx.select().from(decisionReceipts).orderBy(desc(decisionReceipts.receiptSeq)).limit(1);
    if (last) {
      const keys = await publicKeys(tx as unknown as Db);
      const checked = verifyReceiptBundle({ verifier: RECEIPT_PAYLOAD_VERSION, receipts: [envelope(last)], keys, receiptV2FromAuditSeq: v2FromAuditSeq });
      if (!keys.some((k) => k.keyId === last.keyId) || checked.results.some((r) => r.status === "invalid") ||
          !isDecisionReceiptPayload(last.payload) || last.payloadHash !== receiptPayloadHash(last.payload) || last.prevHash !== last.payload.prev)
        throw new Error("Receipt chain tip failed integrity verification; no new receipts signed.");
    }
    const eligible = eligibleAfter(last?.auditSeq ?? 0);
    const rows = await tx.select().from(auditLog).where(v2FromAuditSeq === null || RECEIPT_EMITTER_SUPPORTS_V2 ? eligible : and(eligible, sql`${auditLog.seq} < ${v2FromAuditSeq}`)).orderBy(asc(auditLog.seq)).limit(SWEEP_LIMIT);
    if (!rows.length) return { signed: 0, state: "signing" as const };
    if (!recorded) await registerReceiptSigningKey(tx as unknown as Db, key, opts.now, "receipt-sweep");
    // ADR-0188 decision 19: rows from the recorded v2 boundary on hash as v2 (and must say so)
    // the one boundary loader the writer and verifier share (X35 I7S-02): an unknown version signs nothing
    const boundary = await loadAuditChainBoundary(tx);
    if (!boundary.supported) throw new Error(`Audit chain boundary unsupported (${boundary.detail}); no receipts signed.`);
    const v2FromSeq = boundary.v2FromSeq;
    let receiptSeq = last?.receiptSeq ?? 0;
    let prev = last?.payloadHash ?? RECEIPT_GENESIS_PREV;
    // ADR-0189 B2 / R34: the capture-status marker of every row v2 governs (none while this build emits v1 only)
    const v2Ids = RECEIPT_EMITTER_SUPPORTS_V2 ? rows.filter((r) => r.seq !== null && receiptVersionForAuditSeq(r.seq, v2FromAuditSeq) === RECEIPT_PAYLOAD_VERSION_V2).map((r) => r.id) : [];
    const markers = new Map(
      (v2Ids.length ? await tx.select().from(decisionCaptureStatus).where(inArray(decisionCaptureStatus.auditId, v2Ids)) : []).map((m) => [m.auditId, m]),
    );
    for (const row of rows) {
      // Never notarise corrupted audit content merely because the stored hash exists.
      if (row.seq === null || !row.contentHash || !row.rowHash || !row.prevHash ||
          auditRowVersionProblem({ ...row, seq: row.seq }, v2FromSeq) !== null ||
          row.contentHash !== auditContentHashFor(row, auditChainVersionAt(row.seq, v2FromSeq)) || row.rowHash !== auditRowHash(row.prevHash, row.contentHash))
        throw new Error("Audit row failed integrity verification; no receipts from this pass committed.");
      const tool=boundedDecisionField(row.toolName),rule=boundedDecisionField(row.ruleId);
      const v1: DecisionReceiptPayload = {
        v: RECEIPT_PAYLOAD_VERSION, receiptSeq: ++receiptSeq,
        audit: { id: row.id, seq: row.seq, rowHash: row.rowHash, contentHash: row.contentHash },
        decision: { at: row.at.toISOString(), userId: row.userId, objectType: row.objectType, objectId: row.objectId, serverId: row.serverId, toolName: tool.value, ...(tool.hash?{toolNameHash:tool.hash}:{}), effect: row.effect, ruleId: rule.value, ...(rule.hash?{ruleIdHash:rule.hash}:{}) },
        prev, keyId: key.keyId,
      };
      let payload: AnyDecisionReceiptPayload = v1;
      if (RECEIPT_EMITTER_SUPPORTS_V2 && receiptVersionForAuditSeq(row.seq, v2FromAuditSeq) === RECEIPT_PAYLOAD_VERSION_V2) {
        payload = receiptV2PayloadFor(v1, row, markers.get(row.id));
      } else if (!isDecisionReceiptPayloadV1(payload)) throw new Error("Audit decision cannot be represented by the receipt contract.");
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
// ---- ADR-0219: the receipts list (a receipt carries no reason or detail text; the file carries no signature)
type ReceiptListRow = SignedDecisionReceipt;
const receiptsFilterQuery = z.object({ fromSeq: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1) }).strict();
const rp = (r: ReceiptListRow) => (r.payload && typeof r.payload === "object" ? (r.payload as unknown as Record<string, unknown>) : {});
const rd = (r: ReceiptListRow) => {
  const d = rp(r).decision;
  return (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
};
const rs = (v: unknown) => (typeof v === "string" && v !== "" ? v : null);
export const RECEIPTS_LIST: ListSpec<ReceiptListRow> = {
  id: "decision-receipts",
  sorts: {
    seq: { expr: decisionReceipts.receiptSeq },
    at: { expr: sql`(${decisionReceipts.payload}->'decision'->>'at')` },
    effect: { expr: sql`(${decisionReceipts.payload}->'decision'->>'effect')` },
    object: { expr: sql`(${decisionReceipts.payload}->'decision'->>'objectType')` },
    rule: { expr: sql`coalesce(${decisionReceipts.payload}->'decision'->>'ruleId', ${decisionReceipts.payload}->'decision'->>'ruleIdHash')` },
    v: { expr: sql`(${decisionReceipts.payload}->>'v')` },
  },
  columns: {
    seq: { label: "Sequence", value: (r) => r.receiptSeq },
    at: { label: "Decided", value: (r) => rs(rd(r).at) },
    effect: { label: "Effect", value: (r) => rs(rd(r).effect) },
    object: { label: "Object", value: (r) => rs(rd(r).objectType) },
    rule: { label: "Rule", value: (r) => rs(rd(r).ruleId) ?? (rs(rd(r).ruleIdHash) ? `sha256:${rs(rd(r).ruleIdHash)}` : null) },
    v: { label: "Version", value: (r) => (typeof rp(r).v === "number" ? `v${rp(r).v as number}` : null) },
  },
  filters: ["fromSeq"],
  defaultSort: { col: "seq", dir: "asc" },
  idCol: decisionReceipts.receiptSeq,
};

export function registerDecisionReceiptRoutes(app: FastifyInstance, db: Db, _opts: { dataKey?: string } = {}): void {
  // ADR-0219: the receipts list under the shared list contract. The list pages by `fromSeq`, so the switch is any of
  // sort/dir/offset/count/cursor; `fromSeq` stays a filter. Every page is audited, as the list always was.
  const receiptsReader: ListReader<ReceiptListRow> = {
    fetch: async (q) => {
      const rows = await db.select().from(decisionReceipts).where(q.where).orderBy(...q.orderBy).limit(q.limit).offset(q.offset);
      return rows.map(envelope);
    },
    countable: (where) => db.select({ one: sql`1` }).from(decisionReceipts).where(where),
    idOf: (r) => String(r.receiptSeq),
  };
  app.get("/v1/receipts/export.xlsx", async (req, reply) => {
    try {
      const q = req.query as Record<string, unknown>;
      const f = receiptsFilterQuery.parse(filterParams(q));
      const ex = parseListExport(RECEIPTS_LIST, q);
      await sendListExport(db, req, reply, RECEIPTS_LIST, receiptsReader, gte(decisionReceipts.receiptSeq, f.fromSeq), ex, f);
      return reply;
    } catch (e) {
      return sendListError(reply, e);
    }
  });
  app.get("/v1/receipts", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    if (["sort", "dir", "offset", "count", "cursor"].some((k) => q[k] !== undefined)) {
      try {
        const f = receiptsFilterQuery.parse(filterParams(q));
        const page = parseListPage(RECEIPTS_LIST, q);
        const out = await runListPage(db, RECEIPTS_LIST, receiptsReader, gte(decisionReceipts.receiptSeq, f.fromSeq), page);
        await db.insert(auditLog).values({userId:req.authCtx.userId??"00000000-0000-0000-0000-000000000000",objectType:"decision_receipt",effect:"allow",ruleId:"decision-receipts-listed",ruleChain:[],reason:"Decision receipt envelopes listed",detail:{fromSeq:f.fromSeq,limit:page.limit,offset:page.offset,sort:page.sort,dir:page.dir,rows:out.items.length}});
        return out;
      } catch (e) {
        return sendListError(reply, e);
      }
    }
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
    // M-075: "the oldest unsigned decision is over two minutes old" is judged on the database clock, as `at` is stamped
    const [oldest]=await db.select({stale:sql<boolean>`${auditLog.at} < now() - interval '120 seconds'`}).from(auditLog).where(eligibleAfter(last?.auditSeq??0)).orderBy(asc(auditLog.seq)).limit(1);
    const stalled=state==="signing"&&(job?.lastOutcome==="failed"||job?.enabled===false|| oldest?.stale===true);
    if(stalled)state="stalled";
    // ADR-0189 R25 item 12: where the key came from (install_generated | operator_managed | missing | invalid), never the key
    return { state, lastSweep:job?{at:job.lastFinishedAt?.toISOString()??null,outcome:job.lastOutcome}:null, lastSeq: last?.receiptSeq ?? 0, lagRows: counts[0]?.n ?? 0, signingKey: receiptSigningKeyPosture(process.env) };
  });
  app.get("/v1/receipts/keys", async () => ({ keys: await publicKeys(db) }));
  /**
   * #353 follow-up: RETIRE a receipt signing key. Admin-only (the default route class), a `key_management`
   * step-up bound to the op and this key (migration 0203), audited. Retiring sets `retired_at` (database clock) and nothing else: the public key stays
   * recorded, so receipts it signed keep verifying (packages/shared/src/receipts/README.md), and no writer
   * signs with it again (every signer refuses a retired key). One-way: there is no un-retire.
   *
   * Refused (409, audited) when the key is the one this gateway signs with now (`receipt_key_in_use`:
   * configure the replacement and restart first), or when no other recorded key is active
   * (`receipt_key_only_active`): retiring the last active key would leave nothing that signs. Decided under
   * the receipt sign lock, so two retires (or a retire and a sweep) cannot cross.
   */
  app.post("/v1/receipts/keys/:keyId/retire", { bodyLimit: 1024 }, async (req, reply) => {
    const { keyId } = req.params as { keyId?: unknown };
    if (!isReceiptKeyId(keyId)) return reply.status(400).send({ error: "invalid_receipt_key_id" });
    const actorUserId = req.authCtx.userId ?? SYSTEM_ACTOR;
    // the key this gateway resolves now; an unusable configuration signs nothing, so it holds no key "in use"
    let signingKeyId: string | null = null;
    try { signingKeyId = signingKey()?.keyId ?? null; } catch (e) { if (!(e instanceof ReceiptKeyError)) throw e; }
    type Refusal = { status: 404 | 409; error: string; detail: string; activeKeyIds: string[] };
    /** the one decision, over the recorded keys as read (unlocked for the pre-check, locked for the write) */
    const decide = (keys: ReadonlyArray<{ keyId: string; retiredAt: Date | null }>): Refusal | null => {
      const target = keys.find((k) => k.keyId === keyId);
      const others = keys.filter((k) => k.keyId !== keyId && !k.retiredAt).map((k) => k.keyId);
      if (!target) return { status: 404, error: "receipt_key_unknown", detail: `no receipt signing key ${keyId} is recorded`, activeKeyIds: others };
      if (target.retiredAt) return { status: 409, error: "receipt_key_already_retired", detail: `receipt signing key ${keyId} is already retired`, activeKeyIds: others };
      if (signingKeyId === keyId) {
        return { status: 409, error: "receipt_key_in_use", detail: `receipt signing key ${keyId} is the key this gateway signs with: configure its replacement and restart, then retire it; nothing was changed`, activeKeyIds: others };
      }
      if (others.length === 0) {
        return { status: 409, error: "receipt_key_only_active", detail: `receipt signing key ${keyId} is the only active key: a replacement must be recorded (it is, on its first signature) before it can be retired; nothing was changed`, activeKeyIds: others };
      }
      return null;
    };
    /** a refusal's answer; the in-use and only-active refusals leave a deny row (written outside any deciding transaction) */
    const refuse = async (r: Refusal, stepUp: string | null) => {
      if (r.error === "receipt_key_in_use" || r.error === "receipt_key_only_active") {
        await db.insert(auditLog).values({
          userId: actorUserId, objectType: "decision_receipt", objectId: null, effect: "deny", ruleId: RECEIPT_KEY_RETIRE_REFUSED_RULE_ID, ruleChain: [],
          reason: `Retiring receipt signing key ${keyId} was refused (${r.error}); nothing was changed`,
          detail: { keyId, code: r.error, activeKeyIds: r.activeKeyIds, stepUp, stepUpKind: "key_management" },
        });
      }
      return reply.status(r.status).send({ error: r.error, detail: r.detail });
    };
    // PR #377 review: decided once BEFORE the step-up is spent (unlocked), so a retire that would be refused does not
    // burn the grant; the authoritative decision is made again under the lock below
    const pre = decide(await db.select({ keyId: receiptSigningKeys.keyId, retiredAt: receiptSigningKeys.retiredAt }).from(receiptSigningKeys));
    if (pre) return refuse(pre, null);
    const su = await requireStepUp(db, req, reply, receiptKeyRetireStepUp(keyId));
    if (!su.ok) return reply;
    const out = await db.transaction(async (tx): Promise<{ refused: Refusal } | { refused: null; retiredAt: Date; activeKeyIds: string[] }> => {
      await tx.execute(sql`select pg_advisory_xact_lock(${RECEIPT_SIGN_LOCK_KEY})`);
      // lock order: the sign lock, then the key rows, then (the audit row below) the audit chain lock. The BOM signers
      // take the key row FOR SHARE before the chain lock, so the orders agree and a signer in flight is waited for.
      const keys = await tx.select().from(receiptSigningKeys).orderBy(asc(receiptSigningKeys.createdAt)).for("update");
      const refused = decide(keys);
      if (refused) return { refused };
      const target = keys.find((k) => k.keyId === keyId)!;
      const others = keys.filter((k) => k.keyId !== keyId && !k.retiredAt).map((k) => k.keyId);
      const [moved] = await tx
        .update(receiptSigningKeys)
        .set({ retiredAt: sql`now()` })
        .where(and(eq(receiptSigningKeys.keyId, keyId), isNull(receiptSigningKeys.retiredAt)))
        .returning({ retiredAt: receiptSigningKeys.retiredAt });
      const retiredAt = moved!.retiredAt!;
      await tx.insert(auditLog).values({
        userId: actorUserId, objectType: "decision_receipt", objectId: null, effect: "allow", ruleId: RECEIPT_KEY_RETIRED_RULE_ID, ruleChain: [],
        reason: `Receipt signing key ${keyId} retired: no writer signs with it again; receipts it signed stay verifiable under its recorded public key`,
        detail: { keyId, publicKeyFingerprint: receiptPublicKeyFingerprint(target.publicJwk), retiredAt: retiredAt.toISOString(), activeKeyIds: others, stepUp: su.method, stepUpKind: "key_management" },
      });
      return { refused: null, retiredAt, activeKeyIds: others };
    });
    // the deciding transaction wrote nothing on a refusal; its row is written after it, on its own
    if (out.refused) return refuse(out.refused, su.method);
    return reply.status(200).send({ key: { keyId, retiredAt: out.retiredAt.toISOString() }, activeKeyIds: out.activeKeyIds, keys: await publicKeys(db) });
  });
  app.get("/v1/receipts/export", async (req, reply) => {
    const q = req.query as Record<string, unknown>;
    const [last] = await db.select().from(decisionReceipts).orderBy(desc(decisionReceipts.receiptSeq)).limit(1);
    const from = integer(q.fromSeq, 1), to = integer(q.toSeq, last?.receiptSeq ?? 0);
    if (from === null || to === null || to < from || to - from + 1 > EXPORT_LIMIT) return reply.status(400).send({ error: "invalid_receipt_export_range", detail: "Choose a nonempty range of at most 5000 receipts." });
    const rows = await db.select().from(decisionReceipts).where(and(gte(decisionReceipts.receiptSeq, from), lte(decisionReceipts.receiptSeq, to))).orderBy(asc(decisionReceipts.receiptSeq)).limit(EXPORT_LIMIT);
    await db.insert(auditLog).values({ userId: req.authCtx.userId ?? "00000000-0000-0000-0000-000000000000", objectType: "decision_receipt", objectId: null, effect: "allow", ruleId: "decision-receipt-exported", ruleChain: [], reason: "Decision receipt bundle exported", detail: { fromSeq: from, toSeq: to, rows: rows.length } });
    return { receipts: rows.map(envelope), keys: await publicKeys(db), verifier: RECEIPT_PAYLOAD_VERSION, receiptV2FromAuditSeq: await loadReceiptV2Boundary(db) };
  });
  app.post("/v1/receipts/verify", { bodyLimit: 5 * 1024 * 1024 }, async (req, reply) => {
    if (!isReceiptBundle(req.body)) return reply.status(400).send({ error: "invalid_receipt_bundle" });
    const trusted=await publicKeys(db);
    // the server's recorded keys AND its recorded v2 boundary are the trust root here, never the caller's
    return {...verifyReceiptBundle({...req.body,keys:trusted,receiptV2FromAuditSeq:await loadReceiptV2Boundary(db)}),trust:"deployment_registry"};
  });
  app.get("/v1/receipts/:auditId", async (req, reply) => {
    const { auditId } = req.params as { auditId: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(auditId)) return reply.status(400).send({ error: "invalid_audit_id" });
    const rows = await db.select().from(decisionReceipts).where(eq(decisionReceipts.auditId, auditId));
    await db.insert(auditLog).values({userId:req.authCtx.userId??"00000000-0000-0000-0000-000000000000",objectType:"decision_receipt",objectId:auditId,effect:"allow",ruleId:"decision-receipt-read",ruleChain:[],reason:"Decision receipt envelope read",detail:{rows:rows.length}});
    return { receipts: rows.map(envelope) };
  });
}

/** ADR-0189 B3: the AI BOM snapshot signer reuses the receipt key (OWNER DECISION 2), read the same way */
export { signingKey as loadReceiptSigningKey, ReceiptKeyError, samePublicKey as sameReceiptPublicKey };
export { receiptSigningKeyPosture };
