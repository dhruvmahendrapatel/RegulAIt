/**
 * ADR-0060 §4 and §5 — ANCHORING and VERIFICATION.
 *
 * The chain itself (§1–§3) lives at the storage boundary, in `@regulait/db`.
 * This file is the half an operator and an auditor actually touch:
 *
 *   * `POST /v1/audit/anchor`   — pin the current chain head to WORM storage
 *   * `POST /v1/audit/anchors/flush` — externalize anchors buffered offline
 *   * `GET  /v1/audit/anchors`  — what has been pinned, where, and did it land
 *   * `GET  /v1/audit/verify`   — recompute the chain and say OK, or say which
 *                                 `seq` it breaks at
 *
 * WHY THE ANCHOR IS NOT DECORATION
 * --------------------------------
 * Hash-chaining is easy to over-sell. It catches any edit by someone who cannot
 * recompute the whole chain. It does NOT catch the adversary the ADR is most
 * worried about: a DB admin who rewrites every row can also rewrite every hash,
 * and the result is INTERNALLY CONSISTENT. `verifyAuditChain` will happily
 * report `ok` on it — there is a test that asserts exactly that, because a
 * control whose limits are not written down gets sold as covering things it
 * does not cover.
 *
 * The anchor is what closes it. The chain head is a commitment to the entire
 * history (that is why `prev_hash` names the predecessor's `row_hash` and not
 * its `content_hash`), so ANY edit anywhere moves the head. Pin the head
 * somewhere the DB admin cannot rewrite and the forgery becomes a divergence.
 *
 * Which is why `anchorSource` is reported on every verification, and why
 * "the anchor row in our own database" is reported as NOT tamper-resistant. An
 * adversary with total DB write owns `audit_anchors` too. Only an externalized
 * copy — S3 Object Lock in compliance mode, an independent transparency log, or
 * an auditor's own retained copy passed in as a query parameter — is evidence.
 *
 * RESIDUAL WINDOW, STATED EVERY TIME. Rows written after the last anchor are
 * not yet pinned. A forgery confined to them is internally consistent and
 * undetectable by this control until they are anchored. Anchor cadence BOUNDS
 * that window; it does not remove it. `unanchoredRows` is in every response.
 */
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  and,
  asc,
  auditAnchors,
  auditLog,
  desc,
  eq,
  gt,
  isNotNull,
  lte,
  sql,
  type Db,
} from "@regulait/db";
import {
  AUDIT_CHAIN_ALGORITHM,
  AUDIT_GENESIS_CONTENT_HASH,
  AUDIT_GENESIS_PREV_HASH,
  AUDIT_GENESIS_ROW_HASH,
  AUDIT_GENESIS_SEQ,
  AUDIT_LEGACY_DISCLOSURE,
  AUDIT_PAYLOAD_VERSION,
  verifyChainBatch,
  type ChainBreak,
  type ChainedAuditRow,
} from "@regulait/shared";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

// --- the WORM sink -----------------------------------------------------------

/** The tiny, immutable thing that gets externalized. Deliberately minimal:
 * three values plus provenance. It is meant to be cheap enough to write hourly
 * forever, and small enough for an auditor to keep a copy of by hand. */
export interface AnchorRecord {
  seq: number;
  rowHash: string;
  headAt: string;
  algorithm: string;
  payloadVersion: string;
  capturedAt: string;
}

/**
 * Where an anchor goes once it leaves the database.
 *
 * An interface rather than a hardcoded S3 call, for the reason ADR-0041 gives:
 * BYOC and air-gapped are the PRIMARY motion. The bucket lives in the
 * customer's account under their IAM, or there is no bucket at all and anchors
 * buffer to a local write-once volume until someone carries them out. One
 * interface, three postures.
 */
export interface AnchorSink {
  /** recorded on the anchor row, so "where is the immutable copy" is answerable
   * from the database without guessing at configuration */
  readonly destination: "local_worm" | "s3_object_lock" | "external_log";
  /** True only for a medium the DB admin provably cannot rewrite. A local
   * directory is NOT that — see `LocalWormSink`. */
  readonly tamperResistant: boolean;
  write(record: AnchorRecord): Promise<string>;
  readLatest(): Promise<AnchorRecord | null>;
}

/**
 * The air-gapped buffer: anchors written to a local directory as read-only
 * files, to be carried or synced out later (§8.5's buffer-and-flush).
 *
 * HONESTY ABOUT WHAT THIS IS. A directory on the same host is NOT WORM. `chmod
 * 0444` stops a fat-fingered overwrite; it stops root from nothing. This sink
 * reports `tamperResistant: false`, and verification says so in its response,
 * because the alternative — letting an operator believe a local folder is
 * Object Lock — is worse than having no anchor at all. It is a BUFFER whose
 * value is realised when its contents reach a medium that really is immutable.
 */
export class LocalWormSink implements AnchorSink {
  readonly destination = "local_worm" as const;
  readonly tamperResistant = false;
  constructor(private readonly dir: string) {}

  async write(record: AnchorRecord): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `anchor-${String(record.seq).padStart(20, "0")}.json`);
    const body = JSON.stringify(record, null, 2);
    await writeFile(file, body, { encoding: "utf8", flag: "w" });
    // best-effort immutability; see the class comment for what this is worth
    await chmod(file, 0o444).catch(() => undefined);
    return file;
  }

  async readLatest(): Promise<AnchorRecord | null> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return null;
    }
    const anchors = names.filter((n) => n.startsWith("anchor-") && n.endsWith(".json")).sort();
    const last = anchors.at(-1);
    if (!last) return null;
    try {
      return JSON.parse(await readFile(path.join(this.dir, last), "utf8")) as AnchorRecord;
    } catch {
      return null;
    }
  }
}

/** where the local anchor buffer lands when nothing overrides it */
export const DEFAULT_ANCHOR_DIR = "./audit-anchors";

/**
 * Resolve the configured sink, or `null` for "no sink".
 *
 * DEFAULT-ON, AND HONEST ABOUT WHAT THAT DOES NOT BUY. The local buffer is now
 * the default rather than opt-in, because an install that anchors nothing keeps
 * its only integrity evidence inside the very table an attacker edits. Writing
 * the head to a second artifact raises the bar from "rewrite one table" to
 * "rewrite one table AND the anchor rows AND the anchor files".
 *
 * It does NOT make the trail tamper-RESISTANT, and this function must never be
 * read as if it did. `LocalWormSink.tamperResistant` is `false` and says why: a
 * directory on the same host stops a fat-fingered overwrite, and stops root from
 * nothing. Against an adversary with total database and filesystem write, a full
 * recompute still passes verification. The verify report says exactly that, and
 * turning this default on does not change one word of it.
 *
 * The value that IS real: the buffer exists from the first boot, so pointing an
 * install at a medium that genuinely is immutable becomes a configuration change
 * rather than a code change and a backfill.
 *
 * `REGULAIT_AUDIT_ANCHOR_DIR` moves the buffer. `REGULAIT_AUDIT_ANCHOR=off`
 * restores the previous `null` posture, which remains a legitimate, DISCLOSED
 * state — every anchor written without a sink records `destination: 'none'` so
 * nobody can mistake it for externalized.
 *
 * The S3 Object-Lock sink is still deliberately NOT wired — the bucket is
 * terraform (`infra/modules/audit-anchor-worm-s3/`), nothing has been applied to
 * any cloud account, and shipping a half-configured S3 writer that silently
 * no-ops would be exactly the false assurance this ADR exists to avoid. That
 * sink, not this default, is what would make `tamperResistant` true.
 */
export function resolveAnchorSink(env: NodeJS.ProcessEnv = process.env): AnchorSink | null {
  if ((env.REGULAIT_AUDIT_ANCHOR ?? "").trim().toLowerCase() === "off") return null;
  const dir = env.REGULAIT_AUDIT_ANCHOR_DIR?.trim();
  return new LocalWormSink(dir && dir.length > 0 ? dir : DEFAULT_ANCHOR_DIR);
}

// --- reading the chain head --------------------------------------------------

export interface ChainHead {
  seq: number;
  rowHash: string;
  headAt: Date;
}

/** The current tip: the highest CHAINED row. Legacy rows carry a NULL `seq` and
 * are excluded — a plain `order by seq desc` would sort NULLs first and return
 * a pre-genesis row as the "head". */
export async function readChainHead(db: Db): Promise<ChainHead | null> {
  const rows = await db
    .select({ seq: auditLog.seq, rowHash: auditLog.rowHash, at: auditLog.at })
    .from(auditLog)
    .where(isNotNull(auditLog.seq))
    .orderBy(desc(auditLog.seq))
    .limit(1);
  const head = rows[0];
  if (!head?.seq || !head.rowHash) return null;
  return { seq: head.seq, rowHash: head.rowHash, headAt: head.at };
}

// --- capturing and flushing anchors -----------------------------------------

export interface CaptureResult {
  anchorId: string;
  seq: number;
  rowHash: string;
  destination: "local_worm" | "s3_object_lock" | "external_log" | "none";
  status: "pending" | "flushed" | "failed";
  externalRef: string | null;
  tamperResistant: boolean;
  error: string | null;
}

function anchorRecordOf(head: ChainHead): AnchorRecord {
  return {
    seq: head.seq,
    rowHash: head.rowHash,
    headAt: head.headAt.toISOString(),
    algorithm: AUDIT_CHAIN_ALGORITHM,
    payloadVersion: AUDIT_PAYLOAD_VERSION,
    capturedAt: new Date().toISOString(),
  };
}

/**
 * Pin the current chain head.
 *
 * ORDER MATTERS, and it is the opposite of the obvious one: the audit row for
 * "an anchor was taken" is written FIRST, and the head is read AFTER. Reading
 * the head first would produce an anchor that is stale the instant it is
 * created — it would not cover its own audit row — and every verification would
 * report one unanchored row forever, training the reader to ignore the number.
 */
export async function captureAnchor(db: Db, sink: AnchorSink | null, actorUserId: string | null): Promise<CaptureResult | null> {
  await db.insert(auditLog).values({
    userId: actorUserId ?? NIL_UUID,
    objectType: "audit_chain",
    effect: "allow",
    ruleId: "audit-anchor-captured",
    ruleChain: ["audit-anchor-captured"],
    reason: "admin pinned the audit-log chain head to WORM storage",
    detail: { phase: "anchor", destination: sink?.destination ?? "none" },
  });

  const head = await readChainHead(db);
  if (!head) return null;

  const id = randomUUID();
  const destination = sink?.destination ?? "none";
  await db.insert(auditAnchors).values({
    id,
    seq: head.seq,
    rowHash: head.rowHash,
    headAt: head.headAt,
    algorithm: AUDIT_CHAIN_ALGORITHM,
    destination,
    status: "pending",
  });

  const flushed = await flushAnchorRow(db, sink, { id, record: anchorRecordOf(head) });
  return {
    anchorId: id,
    seq: head.seq,
    rowHash: head.rowHash,
    destination,
    status: flushed.status,
    externalRef: flushed.externalRef,
    tamperResistant: sink?.tamperResistant ?? false,
    error: flushed.error,
  };
}

async function flushAnchorRow(
  db: Db,
  sink: AnchorSink | null,
  anchor: { id: string; record: AnchorRecord },
): Promise<{ status: "pending" | "flushed" | "failed"; externalRef: string | null; error: string | null }> {
  // No sink is not a failure. It is the disclosed "buffered locally, nothing
  // externalized" state that an air-gapped install sits in by design.
  if (!sink) return { status: "pending", externalRef: null, error: null };
  try {
    const ref = await sink.write(anchor.record);
    await db
      .update(auditAnchors)
      .set({ status: "flushed", externalRef: ref, flushedAt: new Date(), lastError: null })
      .where(eq(auditAnchors.id, anchor.id));
    return { status: "flushed", externalRef: ref, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // FAILED, not silently retried. An anchor that did not reach WORM must not
    // look like one that did.
    await db.update(auditAnchors).set({ status: "failed", lastError: message }).where(eq(auditAnchors.id, anchor.id));
    return { status: "failed", externalRef: null, error: message };
  }
}

/** §8.5 buffer-and-flush: push everything still buffered to the sink now that
 * there is a connection. Idempotent — an anchor already `flushed` is skipped. */
export async function flushPendingAnchors(db: Db, sink: AnchorSink | null): Promise<{ attempted: number; flushed: number; failed: number }> {
  const pending = await db
    .select()
    .from(auditAnchors)
    .where(sql`${auditAnchors.status} in ('pending','failed')`)
    .orderBy(asc(auditAnchors.seq));
  let flushed = 0;
  let failed = 0;
  for (const row of pending) {
    const res = await flushAnchorRow(db, sink, {
      id: row.id,
      record: {
        seq: row.seq,
        rowHash: row.rowHash,
        headAt: row.headAt.toISOString(),
        algorithm: row.algorithm,
        payloadVersion: AUDIT_PAYLOAD_VERSION,
        capturedAt: row.createdAt.toISOString(),
      },
    });
    if (res.status === "flushed") flushed += 1;
    else if (res.status === "failed") failed += 1;
  }
  return { attempted: pending.length, flushed, failed };
}

// --- verification ------------------------------------------------------------

/** ADR-0031: verification NEVER loads the table. It walks it in keyset pages
 * over the unique `seq` index and holds one page at a time. `audit_log` grows a
 * row per governed call; a verification that materialised it would be an OOM of
 * the container with a compliance label on it. */
export const VERIFY_DEFAULT_BATCH = 500;
export const VERIFY_MAX_BATCH = 5000;

export interface VerifyOptions {
  fromSeq?: number;
  toSeq?: number;
  batchSize?: number;
  /** an anchor the CALLER retained out-of-band (an auditor's own copy). Beats
   * both the sink and the database, because its trustworthiness is the
   * auditor's own problem rather than ours. */
  anchor?: { seq: number; rowHash: string } | undefined;
}

export interface VerifyReport {
  status: "ok" | "broken" | "empty";
  algorithm: string;
  payloadVersion: string;
  genesis: { present: boolean; seq: number; expectedRowHash: string; actualRowHash: string | null; matches: boolean };
  scanned: { fromSeq: number; toSeq: number | null; rows: number; batches: number; batchSize: number; bounded: boolean };
  legacy: { unchainedRowsBeforeGenesis: number; covered: false; disclosure: string };
  firstBreak: ChainBreak | null;
  anchor: {
    checked: boolean;
    source: "caller_supplied" | "worm_sink" | "database" | "none";
    tamperResistant: boolean;
    seq: number | null;
    expectedRowHash: string | null;
    actualRowHash: string | null;
    matches: boolean | null;
    unanchoredRows: number | null;
    disclosure: string;
  };
  limits: string[];
}

/**
 * Recompute the chain and report `ok`, or the FIRST `seq` at which it breaks.
 *
 * A bounded range (`fromSeq` > genesis) cannot recompute the history in front of
 * it, so it TRUSTS the stored `prev_hash` of its first row as a starting point.
 * That is a real weakening — an adversary who rewrote everything before
 * `fromSeq` would not be caught by a bounded scan — so `scanned.bounded` is
 * reported and the limitation is spelled out in `limits`. A bounded verify is a
 * triage tool; a full verify from genesis is the evidence.
 */
export async function verifyAuditChain(db: Db, sink: AnchorSink | null, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const batchSize = Math.min(Math.max(opts.batchSize ?? VERIFY_DEFAULT_BATCH, 1), VERIFY_MAX_BATCH);
  const fromSeq = Math.max(opts.fromSeq ?? AUDIT_GENESIS_SEQ, 1);
  const bounded = fromSeq > AUDIT_GENESIS_SEQ;

  // The un-chained legacy population, counted live rather than baked into the
  // genesis row (which must stay byte-identical across installs so its hash is
  // a product constant). This number is the honest boundary of the guarantee.
  const legacyCount = (await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(sql`${auditLog.seq} is null`)) as Array<{ n: number }>;
  const legacyRows = legacyCount[0]?.n ?? 0;

  const genesisRows = await db
    .select({ seq: auditLog.seq, rowHash: auditLog.rowHash, contentHash: auditLog.contentHash })
    .from(auditLog)
    .where(eq(auditLog.seq, AUDIT_GENESIS_SEQ));
  const genesisRow = genesisRows[0];
  const genesis = {
    present: Boolean(genesisRow),
    seq: AUDIT_GENESIS_SEQ,
    expectedRowHash: AUDIT_GENESIS_ROW_HASH,
    actualRowHash: genesisRow?.rowHash ?? null,
    matches: genesisRow?.rowHash === AUDIT_GENESIS_ROW_HASH && genesisRow?.contentHash === AUDIT_GENESIS_CONTENT_HASH,
  };

  // Walk state. From genesis, the predecessor hash is the fixed zero constant.
  // From a bounded start, it is whatever the first row claims — see the doc
  // comment for why that is weaker and reported as such.
  let expectedSeq = fromSeq;
  let prevRowHash = AUDIT_GENESIS_PREV_HASH;
  if (bounded) {
    const before = await db
      .select({ rowHash: auditLog.rowHash })
      .from(auditLog)
      .where(eq(auditLog.seq, fromSeq - 1));
    prevRowHash = before[0]?.rowHash ?? AUDIT_GENESIS_PREV_HASH;
  }

  let cursor = fromSeq - 1;
  let rowsScanned = 0;
  let batches = 0;
  let lastSeq: number | null = null;
  let lastRowHash: string | null = null;
  let firstBreak: ChainBreak | null = null;

  for (;;) {
    const where = [isNotNull(auditLog.seq), gt(auditLog.seq, cursor)];
    if (opts.toSeq !== undefined) where.push(lte(auditLog.seq, opts.toSeq));
    const page = (await db
      .select({
        seq: auditLog.seq,
        id: auditLog.id,
        at: auditLog.at,
        userId: auditLog.userId,
        objectType: auditLog.objectType,
        objectId: auditLog.objectId,
        detail: auditLog.detail,
        serverId: auditLog.serverId,
        toolName: auditLog.toolName,
        effect: auditLog.effect,
        ruleId: auditLog.ruleId,
        ruleChain: auditLog.ruleChain,
        reason: auditLog.reason,
        deployMode: auditLog.deployMode,
        contentHash: auditLog.contentHash,
        prevHash: auditLog.prevHash,
        rowHash: auditLog.rowHash,
      })
      .from(auditLog)
      .where(and(...where))
      .orderBy(asc(auditLog.seq))
      .limit(batchSize)) as unknown as ChainedAuditRow[];

    if (page.length === 0) break;
    batches += 1;
    rowsScanned += page.length;

    const res = verifyChainBatch(page, { expectedSeq, prevRowHash });
    if (res.break) {
      firstBreak = res.break;
      break;
    }
    expectedSeq = res.expectedSeq;
    prevRowHash = res.prevRowHash;
    const last = page[page.length - 1]!;
    cursor = last.seq;
    lastSeq = last.seq;
    lastRowHash = last.rowHash;
    if (page.length < batchSize) break;
  }

  const anchor = await compareAgainstAnchor(db, sink, opts.anchor, { lastSeq, firstBreak });

  const limits = [
    "Local recomputation cannot detect an adversary with total database write who rewrites every row AND every hash: that forgery is internally consistent. Only an externalized anchor catches it.",
    "Rows written after the newest anchor are not yet pinned; tampering confined to them can be made internally consistent. Anchor cadence bounds this window, it does not remove it.",
    "This is detection and evidence, not prevention. It does not block writes, and it provides no confidentiality — a hash is not encryption.",
  ];
  if (bounded) {
    limits.unshift(
      `Bounded scan: rows before seq ${fromSeq} were NOT recomputed. The starting prev_hash was taken on trust from the stored chain, so tampering before seq ${fromSeq} is outside this result. Verify from genesis for evidence.`,
    );
  }
  if (!genesis.present) {
    limits.unshift("The genesis row is ABSENT — the boundary marker itself is missing, which is a break in its own right.");
  } else if (!genesis.matches) {
    limits.unshift("The genesis row does not match its published constant — the chain was seeded from a doctored starting point.");
  }

  const status: VerifyReport["status"] = firstBreak ? "broken" : rowsScanned === 0 ? "empty" : "ok";

  return {
    status,
    algorithm: AUDIT_CHAIN_ALGORITHM,
    payloadVersion: AUDIT_PAYLOAD_VERSION,
    genesis,
    scanned: { fromSeq, toSeq: lastSeq, rows: rowsScanned, batches, batchSize, bounded },
    legacy: {
      unchainedRowsBeforeGenesis: legacyRows ?? 0,
      covered: false,
      disclosure: AUDIT_LEGACY_DISCLOSURE,
    },
    firstBreak,
    anchor,
    limits,
  };
}

async function compareAgainstAnchor(
  db: Db,
  sink: AnchorSink | null,
  supplied: { seq: number; rowHash: string } | undefined,
  ctx: { lastSeq: number | null; firstBreak: ChainBreak | null },
): Promise<VerifyReport["anchor"]> {
  let source: VerifyReport["anchor"]["source"] = "none";
  let tamperResistant = false;
  let expected: { seq: number; rowHash: string } | null = null;

  if (supplied) {
    source = "caller_supplied";
    // The auditor vouches for their own copy; we do not get to grade it.
    tamperResistant = true;
    expected = supplied;
  } else if (sink) {
    const record = await sink.readLatest();
    if (record) {
      source = "worm_sink";
      tamperResistant = sink.tamperResistant;
      expected = { seq: record.seq, rowHash: record.rowHash };
    }
  }

  if (!expected) {
    // Last resort: our own table. Recorded, but explicitly NOT evidence — an
    // adversary with database write owns this row too.
    const rows = await db.select().from(auditAnchors).orderBy(desc(auditAnchors.seq)).limit(1);
    const row = rows[0];
    if (row) {
      source = "database";
      tamperResistant = false;
      expected = { seq: row.seq, rowHash: row.rowHash };
    }
  }

  const disclosureFor = (s: VerifyReport["anchor"]["source"], resistant: boolean): string => {
    if (s === "none") {
      return "No anchor exists. The chain still detects any edit by someone who cannot recompute it, but a full recompute by an adversary with total database write would pass this verification undetected.";
    }
    if (!resistant) {
      return "The anchor compared against is NOT held on tamper-resistant storage (it is in this database, or in a local buffer on this host). An adversary who can rewrite audit_log can rewrite it too, so this comparison is a consistency check, not evidence.";
    }
    return "The anchor compared against is held outside this database. A divergence here is what catches a full-recompute forgery.";
  };

  if (!expected) {
    return {
      checked: false,
      source: "none",
      tamperResistant: false,
      seq: null,
      expectedRowHash: null,
      actualRowHash: null,
      matches: null,
      unanchoredRows: null,
      disclosure: disclosureFor("none", false),
    };
  }

  // What does the CURRENT table say the row at the anchored seq hashes to?
  const rows = await db
    .select({ rowHash: auditLog.rowHash })
    .from(auditLog)
    .where(eq(auditLog.seq, expected.seq));
  const actual = rows[0]?.rowHash ?? null;

  return {
    checked: true,
    source,
    tamperResistant,
    seq: expected.seq,
    expectedRowHash: expected.rowHash,
    actualRowHash: actual,
    matches: actual !== null && actual === expected.rowHash,
    unanchoredRows: ctx.lastSeq !== null ? Math.max(ctx.lastSeq - expected.seq, 0) : null,
    disclosure: disclosureFor(source, tamperResistant),
  };
}

// --- routes ------------------------------------------------------------------

const verifyQuery = z.object({
  fromSeq: z.coerce.number().int().min(1).optional(),
  toSeq: z.coerce.number().int().min(1).optional(),
  batchSize: z.coerce.number().int().min(1).max(VERIFY_MAX_BATCH).optional(),
  /** an auditor's own retained anchor, both halves or neither */
  anchorSeq: z.coerce.number().int().min(1).optional(),
  anchorRowHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

/**
 * All four routes are ADMIN-ONLY, by the gateway's default posture (every route
 * not in `NON_ADMIN_ROUTES` requires `isAdmin`). Deliberately not relaxed:
 * verification reports the shape of the whole trail, and anchoring is a
 * governed act that itself lands in the trail.
 */
export function registerAuditChainRoutes(
  app: FastifyInstance,
  db: Db,
  opts: { sink?: AnchorSink | null } = {},
): void {
  const sink = opts.sink === undefined ? resolveAnchorSink() : opts.sink;

  app.get("/v1/audit/verify", async (req, reply) => {
    const q = verifyQuery.parse(req.query);
    if ((q.anchorSeq === undefined) !== (q.anchorRowHash === undefined)) {
      return reply.status(400).send({ error: "anchor_incomplete", detail: "supply anchorSeq AND anchorRowHash, or neither" });
    }
    return verifyAuditChain(db, sink, {
      ...(q.fromSeq !== undefined ? { fromSeq: q.fromSeq } : {}),
      ...(q.toSeq !== undefined ? { toSeq: q.toSeq } : {}),
      ...(q.batchSize !== undefined ? { batchSize: q.batchSize } : {}),
      anchor: q.anchorSeq !== undefined && q.anchorRowHash !== undefined ? { seq: q.anchorSeq, rowHash: q.anchorRowHash } : undefined,
    });
  });

  app.post("/v1/audit/anchor", async (req, reply) => {
    const result = await captureAnchor(db, sink, req.authCtx?.userId ?? null);
    if (!result) return reply.status(409).send({ error: "no_chain", detail: "there is no chained row to anchor" });
    return reply.status(201).send(result);
  });

  app.post("/v1/audit/anchors/flush", async () => flushPendingAnchors(db, sink));

  app.get("/v1/audit/anchors", async () => {
    const rows = await db.select().from(auditAnchors).orderBy(desc(auditAnchors.seq)).limit(100);
    return {
      anchors: rows,
      sink: sink ? { destination: sink.destination, tamperResistant: sink.tamperResistant } : null,
      disclosure: sink
        ? sink.tamperResistant
          ? "Anchors are externalized to tamper-resistant storage."
          : "Anchors are buffered to a medium this host can still rewrite. Until they reach WORM storage they are a consistency check, not evidence."
        : "No anchor sink is configured: anchors exist only in this database and are NOT tamper-resistant.",
    };
  });
}

/** Exported for the throughput harness and for tests that need a stable digest
 * of the whole chain without re-reading it row by row. */
export function fingerprintOf(values: string[]): string {
  const h = createHash("sha256");
  for (const v of values) h.update(v);
  return h.digest("hex");
}
