/**
 * ADR-0187 B5-M — MODEL ARTIFACTS: the upload, the store, the runner's stream, and the scan record.
 *
 *   upload   POST /v1/model-artifacts, `application/octet-stream`, streamed to a private temporary
 *            file while its sha256 is computed and its length counted; a body over the org's limit
 *            (`modelArtifactMaxMegabytes`, strict 512 MiB; raising it is a stepped-up, audited
 *            relaxation) is cut off and refused 413 with nothing kept. The FORMAT is decided from the
 *            bytes (magic numbers, the zip directory, a verified safetensors header), never the file
 *            name, which is kept for display only. The bytes go to the content-addressed store once
 *            (`sha256/<hex>`); the row and its audit commit together.
 *   stream   GET /v1/engine-runner/artifacts/:artifactId (runner token) streams the artifact only to
 *            the runner holding a LIVE lease on a run that targets it (audited either way); the
 *            runner checks the sha256 and length against its lease.
 *   record   every terminal write of an artifact run (result, cancel, timeout, not-run) writes one
 *            `artifact_scans` row in the same transaction, with the verdict the GATEWAY derives
 *            (`deriveArtifactScanVerdict`) from the format it detected at upload: an executable
 *            format is never `clean` (safe formats only: owner decision 2026-10-09, ADR-0187 decision 105).
 *
 * No store configured → uploads are refused (503), never kept in the database or memory.
 *
 * BOUNDED STORAGE (PR #212 review [4235322397], ADR-0187 decision 127): quotas on stored bytes and
 * artifact count, per uploader and for the whole deployment, decided under one storage lock inside the
 * row's transaction (413 / 409 `artifact_quota_exceeded`, audited); DELETE by the uploader or an admin
 * with a step-up (409 `artifact_in_use` while a scan is cited as model-card evidence or a run on it is
 * unfinished); a retention sweep for artifacts nothing uses. A stored object is deleted only after the
 * last row naming it is gone and committed, under the same lock; a failed delete stays queued
 * (`model_artifact_object_deletions`) and the sweep retries it.
 *
 * Open-source check (ADR-0176): the S3 store is the AWS SDK the gateway already ships
 * (@aws-sdk/client-s3, Apache-2.0); the filesystem store is node:fs. Streaming hash and size limit are
 * node:crypto and node:stream. Format detection: see packages/shared/src/engines/modelscan.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import {
  and,
  artifactScans,
  asc,
  auditLog,
  desc,
  engineRuns,
  eq,
  gt,
  inArray,
  lt,
  lte,
  modelArtifactObjectDeletions,
  modelArtifacts,
  modelCardEvidence,
  notInArray,
  sql,
  type OrgSettingsRow,
  type Db,
  type EngineRunRow,
} from "@regulait/db";
import {
  ARTIFACT_FORMAT_PLANS,
  ARTIFACT_SCAN_CHIP,
  artifactScanAdmissible,
  deriveArtifactScanVerdict,
  detectArtifactFormat,
  ENGINE_TERMINAL_RUN_STATUSES,
  type ArtifactFormat,
  type ArtifactReader,
  type ArtifactScanVerdictValue,
  type EngineRunNormalised,
  type EngineTerminalRunStatus,
} from "@regulait/shared";
import { fsyncDir } from "@regulait/engine-runner";
import { z } from "zod";
import { loadOrgSettings } from "./org-settings.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { assertProjectAttribution } from "./projects.js";
import { requireStepUp } from "./step-up.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const MIB = 1024 * 1024;

// ---------------------------------------------------------------------------
// The store (content-addressed by sha256)
// ---------------------------------------------------------------------------

export interface ArtifactStore {
  readonly kind: "filesystem" | "s3";
  has(key: string): Promise<boolean>;
  /** store a local file under `key` (its sha256 already computed and verified by the caller) */
  putFile(key: string, file: string, sha256: string, size: number): Promise<void>;
  /** the stored bytes */
  open(key: string): Promise<{ stream: Readable; size: number }>;
  /**
   * remove the object under `key`; a missing object is not an error (idempotent: a failed delete is
   * retried by the retention sweep). Called only once no artifact row names the key, and that is committed.
   */
  delete(key: string): Promise<void>;
}

/** the node:fs calls the filesystem store makes while writing (a seam, so a test can fail each one) */
export interface FileStoreIo {
  pipeline: (source: Readable, destination: NodeJS.WritableStream) => Promise<void>;
  open: (file: string, flags: "r") => Promise<FileHandle>;
  rename: (from: string, to: string) => Promise<void>;
}

export const artifactStorageKey = (sha256: string) => `sha256/${sha256}`;
const KEY = /^sha256\/[0-9a-f]{64}$/;

/**
 * a directory on the gateway's own volume: one 0600 file per sha256, written durably. PR #212 review
 * [4234946106]: the temp file is fsynced, renamed into place, and the directory holding it is fsynced
 * (so the rename survives a power cut), and every directory `mkdir` newly created on the way is made
 * durable by fsyncing its parent — all before `putFile` returns, so before the row's transaction
 * commits. The directory fsync is the runner core's (`fsyncDir`, packages/engine-runner/src/durable.ts),
 * not a second copy.
 */
export class FileArtifactStore implements ArtifactStore {
  readonly kind = "filesystem" as const;
  private readonly io: FileStoreIo;
  constructor(
    private readonly dir: string,
    /** seam for tests: the directory fsync (default: the runner core's `fsyncDir`) */
    private readonly syncDir: (dir: string) => Promise<void> = fsyncDir,
    /** seam for tests: the copy, the open used for the fsync, and the rename (default: node's) */
    io: Partial<FileStoreIo> = {},
  ) {
    this.io = { pipeline: (a, b) => pipeline(a, b), open: (f, fl) => open(f, fl), rename: (a, b) => rename(a, b), ...io };
  }
  private pathOf(key: string): string {
    if (!KEY.test(key)) throw new Error("invalid artifact key");
    return path.join(this.dir, key);
  }
  async has(key: string): Promise<boolean> {
    return stat(this.pathOf(key)).then(
      () => true,
      () => false,
    );
  }
  async putFile(key: string, file: string): Promise<void> {
    const target = this.pathOf(key);
    const parent = path.dirname(target);
    // `mkdir -p` returns the FIRST directory it created (undefined when all existed): each directory
    // from there down to `parent` is new, and its own parent must be fsynced for it to survive
    const firstCreated = await mkdir(parent, { recursive: true, mode: 0o700 });
    if (firstCreated) {
      const created: string[] = [];
      for (let d = parent; ; d = path.dirname(d)) {
        created.unshift(d);
        if (d === path.resolve(firstCreated) || d === path.dirname(d)) break;
      }
      for (const d of created) await this.syncDir(path.dirname(d));
    }
    // PR #212 review [4235322391] (ADR-0187 decision 130): whatever fails — the copy, the fsync, the close
    // or the rename — the handle is closed and the temporary file is removed, so a failed write leaves
    // nothing behind in the persistent directory
    const tmp = `${target}.${randomUUID()}.tmp`;
    let fh: FileHandle | undefined;
    let renamed = false;
    try {
      await this.io.pipeline(createReadStream(file), createWriteStream(tmp, { mode: 0o600, flags: "wx" }));
      fh = await this.io.open(tmp, "r");
      await fh.sync();
      const closing = fh;
      fh = undefined;
      await closing.close();
      await this.io.rename(tmp, target);
      renamed = true;
    } finally {
      if (fh) await fh.close().catch(() => undefined);
      if (!renamed) await rm(tmp, { force: true }).catch(() => undefined);
    }
    await this.syncDir(parent);
  }
  async delete(key: string): Promise<void> {
    const file = this.pathOf(key);
    // a missing object is already deleted (the sweep retries a failed delete, so this is idempotent)
    await rm(file, { force: true });
    await this.syncDir(path.dirname(file)).catch((err: NodeJS.ErrnoException) => {
      // nothing was ever stored under this prefix: nothing to make durable
      if (err?.code !== "ENOENT") throw err;
    });
  }
  async open(key: string): Promise<{ stream: Readable; size: number }> {
    const file = this.pathOf(key);
    const size = (await stat(file)).size;
    return { stream: createReadStream(file), size };
  }
}

/** an S3-compatible bucket (SeaweedFS in the compose stack, the customer's bucket in BYOC) */
export class S3ArtifactStore implements ArtifactStore {
  readonly kind = "s3" as const;
  constructor(
    private readonly bucket: string,
    private readonly client: Pick<S3Client, "send">,
    private readonly prefix = "model-artifacts/",
  ) {}
  async has(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
      return true;
    } catch {
      return false;
    }
  }
  async putFile(key: string, file: string, sha256: string, size: number): Promise<void> {
    if (!KEY.test(key)) throw new Error("invalid artifact key");
    // the bucket verifies the bytes it received against our sha256
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.prefix + key,
        Body: createReadStream(file),
        ContentLength: size,
        ContentType: "application/octet-stream",
        ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
      }),
    );
  }
  async delete(key: string): Promise<void> {
    if (!KEY.test(key)) throw new Error("invalid artifact key");
    // S3 DeleteObject answers success for a missing key, so a retry is safe
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
  }
  async open(key: string): Promise<{ stream: Readable; size: number }> {
    if (!KEY.test(key)) throw new Error("invalid artifact key");
    const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.prefix + key }));
    if (!out.Body || typeof out.ContentLength !== "number") throw new Error("the artifact store returned no body");
    return { stream: out.Body as Readable, size: out.ContentLength };
  }
}

/**
 * The store this deployment names, or null (uploads refused). REGULAIT_MODEL_ARTIFACT_DIR → a
 * directory; REGULAIT_MODEL_ARTIFACT_S3_BUCKET (+ _ENDPOINT, _REGION) → a bucket, with the SDK's own
 * credential chain (no key is read here).
 */
export function artifactStoreFromEnv(env: NodeJS.ProcessEnv = process.env): ArtifactStore | null {
  if (env.REGULAIT_MODEL_ARTIFACT_S3_BUCKET) {
    const client = new S3Client({
      region: env.REGULAIT_MODEL_ARTIFACT_S3_REGION || "us-east-1",
      ...(env.REGULAIT_MODEL_ARTIFACT_S3_ENDPOINT ? { endpoint: env.REGULAIT_MODEL_ARTIFACT_S3_ENDPOINT, forcePathStyle: true } : {}),
    });
    return new S3ArtifactStore(env.REGULAIT_MODEL_ARTIFACT_S3_BUCKET, client);
  }
  if (env.REGULAIT_MODEL_ARTIFACT_DIR) return new FileArtifactStore(env.REGULAIT_MODEL_ARTIFACT_DIR);
  return null;
}

// ---------------------------------------------------------------------------
// Bounded storage: quotas, deletion and retention (ADR-0187 decision 127)
// ---------------------------------------------------------------------------

/**
 * ONE lock over the artifact store: every quota decision, every object write that a row will name and
 * every object delete takes it (a transaction-scoped advisory lock), so two uploads cannot both fit
 * under a quota, and an object is never deleted while an upload is about to name it.
 */
export const MODEL_ARTIFACT_STORAGE_LOCK = "regulait:model-artifact-storage";
/** an upload's write-ahead deletion record is not acted on before this (the upload removes it when it lands) */
export const UPLOAD_WRITE_AHEAD_MS = 6 * 3_600_000;
/** seams for tests (never set in production): a pause inside the locked quota decision */
export const modelArtifactTestHooks: { afterQuotaRead?: () => Promise<void> } = {};
/** a failed object delete is retried after this many minutes per attempt so far, at most a day */
const DELETE_RETRY_MINUTES = 5;

type Reader = Db | Tx;
async function lockArtifactStorage(tx: Tx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${MODEL_ARTIFACT_STORAGE_LOCK}))`);
}

export interface ArtifactStorageUsage {
  uploaderBytes: number;
  uploaderCount: number;
  orgBytes: number;
  orgCount: number;
}

/** what is stored now: every artifact row counts its own size (the same bytes uploaded twice count twice) */
export async function artifactStorageUsage(q: Reader, uploaderId: string): Promise<ArtifactStorageUsage> {
  const mine = sql`${modelArtifacts.uploadedByUserId} = ${uploaderId}`;
  const [r] = await q
    .select({
      uploaderBytes: sql<string>`COALESCE(SUM(${modelArtifacts.sizeBytes}) FILTER (WHERE ${mine}), 0)`,
      uploaderCount: sql<string>`COUNT(*) FILTER (WHERE ${mine})`,
      orgBytes: sql<string>`COALESCE(SUM(${modelArtifacts.sizeBytes}), 0)`,
      orgCount: sql<string>`COUNT(*)`,
    })
    .from(modelArtifacts);
  return { uploaderBytes: Number(r?.uploaderBytes ?? 0), uploaderCount: Number(r?.uploaderCount ?? 0), orgBytes: Number(r?.orgBytes ?? 0), orgCount: Number(r?.orgCount ?? 0) };
}

export interface ArtifactQuotaRefusal {
  scope: "uploader" | "org";
  measure: "count" | "bytes";
  /** the org setting that sets this quota (an admin may raise it, with a step-up) */
  setting: "modelArtifactUploaderQuotaCount" | "modelArtifactUploaderQuotaMegabytes" | "modelArtifactOrgQuotaCount" | "modelArtifactOrgQuotaMegabytes";
  limit: number;
  used: number;
  /** 409 for a count (delete one first), 413 for bytes (the upload is too large for what is left) */
  status: 409 | 413;
}

type QuotaSettings = Pick<OrgSettingsRow, "modelArtifactUploaderQuotaCount" | "modelArtifactUploaderQuotaMegabytes" | "modelArtifactOrgQuotaCount" | "modelArtifactOrgQuotaMegabytes">;

/** would one more artifact of `sizeBytes` take any quota past its limit? the first one it would, or null */
export function artifactQuotaExceeded(org: QuotaSettings, usage: ArtifactStorageUsage, sizeBytes: number): ArtifactQuotaRefusal | null {
  const checks: ArtifactQuotaRefusal[] = [
    { scope: "uploader", measure: "count", setting: "modelArtifactUploaderQuotaCount", limit: org.modelArtifactUploaderQuotaCount, used: usage.uploaderCount, status: 409 },
    { scope: "uploader", measure: "bytes", setting: "modelArtifactUploaderQuotaMegabytes", limit: org.modelArtifactUploaderQuotaMegabytes * MIB, used: usage.uploaderBytes, status: 413 },
    { scope: "org", measure: "count", setting: "modelArtifactOrgQuotaCount", limit: org.modelArtifactOrgQuotaCount, used: usage.orgCount, status: 409 },
    { scope: "org", measure: "bytes", setting: "modelArtifactOrgQuotaMegabytes", limit: org.modelArtifactOrgQuotaMegabytes * MIB, used: usage.orgBytes, status: 413 },
  ];
  return checks.find((c) => c.used + (c.measure === "count" ? 1 : sizeBytes) > c.limit) ?? null;
}

/** what keeps an artifact: a scan of it cited as model-card evidence, or a run on it not yet finished */
export async function artifactReferences(q: Reader, artifactId: string): Promise<{ citedScans: number; unfinishedRuns: number }> {
  const [cited] = await q
    .select({ n: sql<string>`COUNT(*)` })
    .from(modelCardEvidence)
    .innerJoin(artifactScans, eq(modelCardEvidence.artifactScanId, artifactScans.id))
    .where(eq(artifactScans.artifactId, artifactId));
  const [running] = await q
    .select({ n: sql<string>`COUNT(*)` })
    .from(engineRuns)
    .where(and(eq(engineRuns.targetArtifactId, artifactId), notInArray(engineRuns.status, [...ENGINE_TERMINAL_RUN_STATUSES])));
  return { citedScans: Number(cited?.n ?? 0), unfinishedRuns: Number(running?.n ?? 0) };
}

/**
 * Queue the object under `key` for deletion, in the caller's locked transaction, but only while no
 * artifact row names it (content addressing: another upload of the same bytes keeps it).
 */
async function queueObjectDeletionTx(tx: Tx, key: string, notBefore: Date): Promise<boolean> {
  const [named] = await tx.select({ id: modelArtifacts.id }).from(modelArtifacts).where(eq(modelArtifacts.storageKey, key)).limit(1);
  if (named) return false;
  await tx
    .insert(modelArtifactObjectDeletions)
    .values({ storageKey: key, notBefore })
    .onConflictDoUpdate({ target: modelArtifactObjectDeletions.storageKey, set: { notBefore: sql`LEAST(${modelArtifactObjectDeletions.notBefore}, excluded.not_before)` } });
  return true;
}

type DeleteArtifactOutcome =
  | { ok: true; artifact: typeof modelArtifacts.$inferSelect; scansDeleted: number; objectQueued: boolean }
  | { ok: false; error: "unknown_artifact" }
  | { ok: false; error: "artifact_in_use"; citedScans: number; unfinishedRuns: number };

/**
 * Remove one artifact row and its (uncited) scans, under the storage lock, re-checking what keeps it
 * on the locked row; queue its object when no other row names it; audit — all in one transaction. The
 * object itself is deleted only after this commits (`drainArtifactObjectDeletions`).
 */
async function deleteArtifactRow(
  db: Db,
  artifactId: string,
  how: { userId: string; ruleId: "model-artifact-deleted" | "model-artifact-expired"; still: (a: typeof modelArtifacts.$inferSelect) => boolean; detail: Record<string, unknown>; now: Date },
): Promise<DeleteArtifactOutcome> {
  return db.transaction(async (tx) => {
    await lockArtifactStorage(tx);
    const [a] = await tx.select().from(modelArtifacts).where(eq(modelArtifacts.id, artifactId)).for("update");
    if (!a || !how.still(a)) return { ok: false as const, error: "unknown_artifact" as const };
    const refs = await artifactReferences(tx, a.id);
    if (refs.citedScans > 0 || refs.unfinishedRuns > 0) return { ok: false as const, error: "artifact_in_use" as const, ...refs };
    const scans = await tx.delete(artifactScans).where(eq(artifactScans.artifactId, a.id)).returning({ id: artifactScans.id });
    await tx.delete(modelArtifacts).where(eq(modelArtifacts.id, a.id));
    const objectQueued = await queueObjectDeletionTx(tx, a.storageKey, how.now);
    await tx.insert(auditLog).values({
      userId: how.userId,
      objectType: "model_artifact",
      objectId: a.id,
      detail: {
        phase: how.ruleId === "model-artifact-expired" ? "retention" : "delete",
        sha256: a.sha256,
        sizeBytes: a.sizeBytes,
        format: a.format,
        uploadedByUserId: a.uploadedByUserId,
        scansDeleted: scans.map((x) => x.id),
        // false: another artifact row still names the same bytes, so the object stays
        objectQueued,
        ...how.detail,
      },
      effect: "allow",
      ruleId: how.ruleId,
      ruleChain: [],
      reason:
        how.ruleId === "model-artifact-expired"
          ? `model artifact ${a.id} (sha256 ${a.sha256}) deleted by retention: nothing cites it or is scanning it`
          : `model artifact ${a.id} (sha256 ${a.sha256}) deleted with ${scans.length} uncited scan(s)`,
    });
    return { ok: true as const, artifact: a, scansDeleted: scans.length, objectQueued };
  });
}

const errorName = (err: unknown) => (err instanceof Error ? err.name : typeof err).replace(/[^A-Za-z0-9_]/g, "").slice(0, 64) || "Error";

/**
 * Delete the queued objects that are due (or exactly `keys`, when given and due), each in its own
 * transaction under the storage lock, and only while no artifact row names the key. A failed delete
 * keeps its record (attempts + 1, retried later) and is audited; it is never left half-done, because
 * the record goes only with the object.
 */
export async function drainArtifactObjectDeletions(
  db: Db,
  store: ArtifactStore | null,
  opts: { keys?: string[]; now?: Date; limit?: number; actorUserId?: string } = {},
): Promise<{ deleted: number; failed: number; stillNamed: number; waiting: number }> {
  const out = { deleted: 0, failed: 0, stillNamed: 0, waiting: 0 };
  const now = opts.now ?? new Date();
  const scope = opts.keys ? inArray(modelArtifactObjectDeletions.storageKey, opts.keys) : undefined;
  const due = await db
    .select()
    .from(modelArtifactObjectDeletions)
    .where(and(scope, lte(modelArtifactObjectDeletions.notBefore, now)))
    .orderBy(asc(modelArtifactObjectDeletions.notBefore))
    .limit(opts.limit ?? 200);
  if (!store) {
    // nothing to delete them from yet: they wait, queued, for a store
    out.waiting = due.length;
    return out;
  }
  const actor = opts.actorUserId ?? NO_IDENTITY;
  for (const d of due) {
    await db.transaction(async (tx) => {
      await lockArtifactStorage(tx);
      const [pending] = await tx
        .select()
        .from(modelArtifactObjectDeletions)
        .where(and(eq(modelArtifactObjectDeletions.storageKey, d.storageKey), lte(modelArtifactObjectDeletions.notBefore, now)));
      if (!pending) return; // another drain took it, or an upload named the key again
      const [named] = await tx.select({ id: modelArtifacts.id }).from(modelArtifacts).where(eq(modelArtifacts.storageKey, d.storageKey)).limit(1);
      if (named) {
        await tx.delete(modelArtifactObjectDeletions).where(eq(modelArtifactObjectDeletions.storageKey, d.storageKey));
        out.stillNamed += 1;
        return;
      }
      try {
        await store.delete(d.storageKey);
      } catch (err) {
        const attempts = pending.attempts + 1;
        await tx
          .update(modelArtifactObjectDeletions)
          .set({ attempts, lastAttemptAt: now, lastErrorCode: "object_delete_failed", notBefore: new Date(now.getTime() + Math.min(attempts * DELETE_RETRY_MINUTES, 24 * 60) * 60_000) })
          .where(eq(modelArtifactObjectDeletions.storageKey, d.storageKey));
        await tx.insert(auditLog).values({
          userId: actor,
          objectType: "model_artifact",
          objectId: NO_IDENTITY,
          detail: { phase: "object_delete", storageKey: d.storageKey, store: store.kind, attempts, error: errorName(err) },
          effect: "deny",
          ruleId: "model-artifact-object-delete-failed",
          ruleChain: [],
          reason: `the stored object ${d.storageKey} could not be deleted (attempt ${attempts}); it stays queued and the retention sweep retries it`,
        });
        out.failed += 1;
        return;
      }
      await tx.delete(modelArtifactObjectDeletions).where(eq(modelArtifactObjectDeletions.storageKey, d.storageKey));
      await tx.insert(auditLog).values({
        userId: actor,
        objectType: "model_artifact",
        objectId: NO_IDENTITY,
        detail: { phase: "object_delete", storageKey: d.storageKey, store: store.kind, attempts: pending.attempts + 1 },
        effect: "allow",
        ruleId: "model-artifact-object-deleted",
        ruleChain: [],
        reason: `the stored object ${d.storageKey} was deleted: no artifact names it any more`,
      });
      out.deleted += 1;
    });
  }
  return out;
}

/**
 * THE RETENTION SWEEP. An artifact older than `modelArtifactRetentionDays` (strict 30) that nothing
 * keeps (no scan of it cited as model-card evidence, no unfinished run on it) is deleted with its
 * uncited scans, audited `model-artifact-expired`; then every due queued object is deleted (retrying
 * failed deletes). The setting is read NOW, so lowering it applies to artifacts already stored.
 */
export async function runModelArtifactRetentionSweep(db: Db, store: ArtifactStore | null, opts: { now?: Date; actorUserId?: string } = {}) {
  const now = opts.now ?? new Date();
  const org = await loadOrgSettings(db);
  const cutoff = new Date(now.getTime() - org.modelArtifactRetentionDays * 24 * 3_600_000);
  const out = { expired: 0, kept: 0, objectsDeleted: 0, objectDeletesFailed: 0, objectsWaiting: 0 };
  const candidates = await db
    .select({ id: modelArtifacts.id })
    .from(modelArtifacts)
    .where(
      and(
        lt(modelArtifacts.createdAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM ${modelCardEvidence} INNER JOIN ${artifactScans} ON ${artifactScans.id} = ${modelCardEvidence.artifactScanId} WHERE ${artifactScans.artifactId} = ${modelArtifacts.id})`,
        sql`NOT EXISTS (SELECT 1 FROM ${engineRuns} WHERE ${engineRuns.targetArtifactId} = ${modelArtifacts.id} AND ${notInArray(engineRuns.status, [...ENGINE_TERMINAL_RUN_STATUSES])})`,
      ),
    )
    .orderBy(asc(modelArtifacts.createdAt))
    .limit(200);
  for (const c of candidates) {
    const done = await deleteArtifactRow(db, c.id, {
      userId: opts.actorUserId ?? NO_IDENTITY,
      ruleId: "model-artifact-expired",
      still: (a) => a.createdAt < cutoff,
      detail: { retentionDays: org.modelArtifactRetentionDays },
      now,
    });
    if (done.ok) out.expired += 1;
    else out.kept += 1;
  }
  const drained = await drainArtifactObjectDeletions(db, store, { now, ...(opts.actorUserId ? { actorUserId: opts.actorUserId } : {}) });
  out.objectsDeleted = drained.deleted;
  out.objectDeletesFailed = drained.failed;
  out.objectsWaiting = drained.waiting;
  return out;
}

export const MODEL_ARTIFACT_RETENTION_JOB_NAME = "model-artifact-retention-sweep";

export function modelArtifactJobDefinitions(opts: { artifactStore?: ArtifactStore | null } = {}): SchedulerJobDefinition[] {
  return [
    {
      name: MODEL_ARTIFACT_RETENTION_JOB_NAME,
      description:
        "Delete model artifacts older than the retention setting (strict 30 days) that no model card cites and no " +
        "unfinished scan targets, with their uncited scans, audited; then delete their stored objects once no artifact " +
        "names them, retrying any delete that failed.",
      adr: "ADR-0187",
      defaultIntervalSeconds: 3600,
      run: async (ctx) => {
        const store = opts.artifactStore === undefined ? artifactStoreFromEnv() : opts.artifactStore;
        const out = await runModelArtifactRetentionSweep(ctx.db, store, { now: ctx.now, ...(ctx.actorUserId ? { actorUserId: ctx.actorUserId } : {}) });
        return { itemsProcessed: out.expired + out.objectsDeleted, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// The scan record, written inside a run's terminal transaction
// ---------------------------------------------------------------------------

/**
 * Write the artifact run's scan record in the caller's transaction (the run's terminal write). One
 * row per run (a unique index); the verdict is derived here from the format the gateway detected at
 * upload, never taken from the runner.
 */
export async function recordArtifactScanTx(tx: Tx, run: EngineRunRow, status: EngineTerminalRunStatus, normalised: EngineRunNormalised): Promise<{ id: string; verdict: ArtifactScanVerdictValue } | null> {
  if (run.targetKind !== "artifact" || !run.targetArtifactId) return null;
  const [artifact] = await tx.select().from(modelArtifacts).where(eq(modelArtifacts.id, run.targetArtifactId));
  if (!artifact) return null;
  const judged = deriveArtifactScanVerdict({
    storedFormat: artifact.format,
    runStatus: status,
    runVerdict: normalised.verdict,
    runtimeNotRun: normalised.runtimeNotRun,
    items: normalised.items.map((i) => ({ key: i.key, sourceSystem: i.sourceSystem, sourceId: i.sourceId, verdict: i.verdict, severity: i.severity })),
  });
  const [row] = await tx
    .insert(artifactScans)
    .values({
      artifactId: artifact.id,
      engineRunId: run.id,
      artifactSha256: artifact.sha256,
      format: artifact.format,
      verdict: judged.verdict,
      issues: judged.findings,
      scannerVersion: run.engineVersion,
    })
    .onConflictDoNothing()
    .returning();
  if (!row) return null;
  await tx.insert(auditLog).values({
    userId: run.runAsUserId ?? NO_IDENTITY,
    objectType: "model_artifact",
    objectId: artifact.id,
    detail: {
      phase: "scan",
      artifactScanId: row.id,
      engineRunId: run.id,
      sha256: artifact.sha256,
      format: artifact.format,
      verdict: judged.verdict,
      admissible: artifactScanAdmissible(judged.verdict),
      findings: judged.findings.length,
      runStatus: status,
    },
    effect: judged.verdict === "clean" ? "allow" : "deny",
    ruleId: "model-artifact-scanned",
    ruleChain: [],
    reason: `model artifact ${artifact.id} scanned (${status}): ${ARTIFACT_SCAN_CHIP[judged.verdict]} — ${judged.why}`,
  });
  return { id: row.id, verdict: judged.verdict };
}

/** the view of one scan (the chip never says "safe") */
export function scanView(s: typeof artifactScans.$inferSelect) {
  const verdict = s.verdict as ArtifactScanVerdictValue;
  return {
    id: s.id,
    artifactId: s.artifactId,
    engineRunId: s.engineRunId,
    sha256: s.artifactSha256,
    format: s.format,
    verdict,
    chip: ARTIFACT_SCAN_CHIP[verdict] ?? "Scan inconclusive",
    admissible: artifactScanAdmissible(verdict),
    findings: s.issues,
    scannerVersion: s.scannerVersion,
    createdAt: s.createdAt,
  };
}

function artifactView(a: typeof modelArtifacts.$inferSelect) {
  const plan = (ARTIFACT_FORMAT_PLANS as Record<string, (typeof ARTIFACT_FORMAT_PLANS)[ArtifactFormat]>)[a.format];
  return {
    id: a.id,
    sha256: a.sha256,
    sizeBytes: a.sizeBytes,
    format: a.format,
    executable: plan?.executable ?? true,
    formatDescription: plan?.describe ?? null,
    filename: a.filename,
    projectId: a.projectId,
    uploadedByUserId: a.uploadedByUserId,
    createdAt: a.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export interface ModelArtifactOptions {
  /** the store; a test passes one (default: from the environment; none = uploads refused) */
  artifactStore?: ArtifactStore | null;
}

const uploadQuery = z
  .object({
    /** the uploader's name for the file: display only, never used to decide anything */
    filename: z.string().trim().min(1).max(255).optional(),
    projectId: z.string().uuid().optional(),
  })
  .strict();
const artifactParam = z.object({ artifactId: z.string().uuid() });
/** the step-up a deletion needs (the same digest the client asks /options for) */
export const artifactDeleteStepUp = (artifactId: string) => ({ kind: "settings_relax" as const, facts: { modelArtifactId: artifactId, values: { deleted: true } } });

/** a display-safe file name: printable, no path */
export function displayFilename(name: string | undefined): string {
  const base = (name ?? "artifact").split(/[\\/]/).pop() ?? "artifact";
  const clean = base.replace(/[^\x20-\x7e]/g, "?").trim().slice(0, 255);
  return clean.length ? clean : "artifact";
}

/**
 * Stream `body` into a new 0600 file, calling `onChunk` for each chunk written, until the body ends
 * (false) or more than `limit` bytes have arrived (true: the file is closed, nothing more is written,
 * and the rest of the body is drained and dropped).
 */
export async function streamBounded(body: Readable, file: string, limit: number, onChunk: (chunk: Buffer) => void): Promise<boolean> {
  const out = createWriteStream(file, { mode: 0o600, flags: "wx" });
  let seen = 0;
  let over = false;
  await new Promise<void>((resolve, reject) => {
    const finish = () => out.end(() => resolve());
    out.on("error", reject);
    body.on("error", reject);
    body.on("data", (chunk: Buffer) => {
      if (over) return;
      seen += chunk.length;
      if (seen > limit) {
        over = true;
        finish();
        return;
      }
      onChunk(chunk);
      if (!out.write(chunk)) {
        body.pause();
        out.once("drain", () => body.resume());
      }
    });
    body.on("end", () => {
      if (!over) finish();
    });
  });
  return over;
}

function fileReaderOf(fh: Awaited<ReturnType<typeof open>>, size: number): ArtifactReader {
  return {
    size,
    async read(offset, length) {
      const n = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.alloc(n);
      if (n > 0) await fh.read(buf, 0, n, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, n);
    },
  };
}

function quotaFacts(over: ArtifactQuotaRefusal) {
  return { scope: over.scope, measure: over.measure, setting: over.setting, limit: over.limit, used: over.used };
}
function quotaDetail(over: ArtifactQuotaRefusal): string {
  const whose = over.scope === "org" ? "this deployment's" : "your";
  const what = over.measure === "count" ? `${over.limit} stored artifacts` : `${Math.floor(over.limit / MIB)} MiB of stored artifacts`;
  return `this upload would take ${whose} model artifacts past ${what} (${over.setting}): delete artifacts no longer needed, or an admin may raise the quota (the change needs a step-up)`;
}

/** can this caller use this artifact (scan it, attach its scans)? its uploader, or an admin */
export function artifactAccessible(a: { uploadedByUserId: string | null }, caller: { userId: string | null; isAdmin: boolean }): boolean {
  return caller.isAdmin || (caller.userId !== null && a.uploadedByUserId === caller.userId);
}

export function registerModelArtifactRoutes(app: FastifyInstance, db: Db, opts: ModelArtifactOptions = {}): void {
  const store = opts.artifactStore === undefined ? artifactStoreFromEnv() : opts.artifactStore;

  // ---- POST /v1/model-artifacts (the upload) -----------------------------------
  app.register(async (scope) => {
    // this route — and only this one — takes the raw body as a stream; the global JSON parser is untouched
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    scope.post("/v1/model-artifacts", { bodyLimit: 8192 * MIB + 1 }, async (req, reply) => {
      const body = req.body as Readable | undefined;
      const drain = () => body?.resume?.();
      const userId = req.authCtx.userId;
      if (!userId) {
        drain();
        return reply.status(403).send({ error: "human_required", detail: "an artifact is uploaded by a person" });
      }
      const q = uploadQuery.safeParse(req.query ?? {});
      if (!q.success) {
        drain();
        return reply.status(400).send({ error: "invalid_request", issues: q.error.issues.slice(0, 10) });
      }
      const ctype = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
      if (ctype !== "application/octet-stream") {
        drain();
        return reply.status(415).send({ error: "artifact_content_type", detail: "send the artifact's bytes as application/octet-stream" });
      }
      if (!store) {
        drain();
        return reply.status(503).send({ error: "artifact_store_unavailable", detail: "no model-artifact store is configured on this gateway, so nothing is accepted" });
      }
      if (q.data.projectId) {
        const attribution = await assertProjectAttribution(db, q.data.projectId, userId, req.authCtx.isAdmin);
        if (!attribution.ok) {
          drain();
          return reply.status(attribution.status).send({ error: attribution.error });
        }
      }
      const org = await loadOrgSettings(db);
      const limit = org.modelArtifactMaxMegabytes * MIB;
      const filename = displayFilename(q.data.filename);
      const refuse = async (bytes: number) => {
        await db.insert(auditLog).values({
          userId,
          objectType: "model_artifact",
          objectId: NO_IDENTITY,
          detail: { phase: "upload", refused: "artifact_too_large", limitMegabytes: org.modelArtifactMaxMegabytes, receivedAtLeast: bytes },
          effect: "deny",
          ruleId: "model-artifact-upload-refused",
          ruleChain: [],
          reason: `a model-artifact upload over the ${org.modelArtifactMaxMegabytes} MiB limit was refused; nothing of it was kept`,
        });
        return reply.status(413).send({ error: "artifact_too_large", detail: `the limit is ${org.modelArtifactMaxMegabytes} MiB (an admin may raise it; the change needs a step-up)` });
      };
      const declared = Number(req.headers["content-length"]);
      if (Number.isFinite(declared) && declared > limit) {
        drain();
        return refuse(declared);
      }
      if (!body || typeof (body as Readable).pipe !== "function") return reply.status(400).send({ error: "invalid_request", detail: "no body" });
      // stream to a private temporary file, hashing and counting; cut off past the limit
      const dir = path.join(tmpdir(), `regulait-artifact-${randomUUID()}`);
      await mkdir(dir, { mode: 0o700 });
      const tmp = path.join(dir, "upload.bin");
      const hash = createHash("sha256");
      let size = 0;
      try {
        // past the limit nothing more is written or hashed: the file is closed and removed, the rest of
        // the body is read and dropped (the request is not destroyed under the response), and the
        // answer is 413 with the connection closed
        const tooLarge = await streamBounded(body, tmp, limit, (chunk) => {
          size += chunk.length;
          hash.update(chunk);
        });
        if (tooLarge) {
          size = Math.max(size, limit + 1);
          reply.header("connection", "close");
          return refuse(size);
        }
        const sha256 = hash.digest("hex");
        // THE FORMAT IS DECIDED FROM THE BYTES, never from `filename`
        const fh = await open(tmp, "r");
        let detection;
        try {
          detection = await detectArtifactFormat(fileReaderOf(fh, size));
        } finally {
          await fh.close();
        }
        const key = artifactStorageKey(sha256);
        const refuseQuota = async (over: ArtifactQuotaRefusal) => {
          await db.insert(auditLog).values({
            userId,
            objectType: "model_artifact",
            objectId: NO_IDENTITY,
            detail: { phase: "upload", refused: "artifact_quota_exceeded", ...quotaFacts(over), sizeBytes: size, sha256 },
            effect: "deny",
            ruleId: "model-artifact-upload-refused",
            ruleChain: [],
            reason: `a model-artifact upload was refused: it would take the ${over.scope === "org" ? "deployment's" : "uploader's"} stored ${over.measure} past the ${over.setting} quota; nothing of it was kept`,
          });
          return reply.status(over.status).send({ error: "artifact_quota_exceeded", ...quotaFacts(over), detail: quotaDetail(over) });
        };
        // a fast refusal before anything is written to the store (the decision that counts is the
        // locked one below)
        const early = artifactQuotaExceeded(org, await artifactStorageUsage(db, userId), size);
        if (early) return refuseQuota(early);
        const storedNew = !(await store.has(key));
        if (storedNew) {
          // write-ahead: a crash between the object write and the row leaves a queued delete behind,
          // not an object nothing names (the sweep acts on it once the upload has had its time)
          await db
            .insert(modelArtifactObjectDeletions)
            .values({ storageKey: key, notBefore: new Date(Date.now() + UPLOAD_WRITE_AHEAD_MS) })
            .onConflictDoNothing();
          await store.putFile(key, tmp, sha256, size);
        }
        const declaredExtension = /\.([A-Za-z0-9]{1,12})$/.exec(filename)?.[1]?.toLowerCase() ?? null;
        const decided = await db.transaction(async (tx) => {
          // THE QUOTA DECISION: under the storage lock, on what is stored now
          await lockArtifactStorage(tx);
          const orgNow = await loadOrgSettings(tx as unknown as Db);
          const over = artifactQuotaExceeded(orgNow, await artifactStorageUsage(tx, userId), size);
          await modelArtifactTestHooks.afterQuotaRead?.();
          if (over) {
            // the bytes this upload wrote go again, unless another row names them
            if (storedNew) await queueObjectDeletionTx(tx, key, new Date());
            return { over: over as ArtifactQuotaRefusal, row: null };
          }
          // a delete may have removed the object since it was checked: write it again, under the lock
          if (!(await store.has(key))) await store.putFile(key, tmp, sha256, size);
          // this row names the key: no queued delete of it may run
          await tx.delete(modelArtifactObjectDeletions).where(eq(modelArtifactObjectDeletions.storageKey, key));
          const [a] = await tx
            .insert(modelArtifacts)
            .values({ sha256, sizeBytes: size, format: detection.format, filename, storageKey: key, projectId: q.data.projectId ?? null, uploadedByUserId: userId })
            .returning();
          await tx.insert(auditLog).values({
            userId,
            objectType: "model_artifact",
            objectId: a!.id,
            detail: {
              phase: "upload",
              sha256,
              sizeBytes: size,
              format: detection.format,
              formatEvidence: detection.evidence,
              executable: ARTIFACT_FORMAT_PLANS[detection.format].executable,
              declaredExtension,
              storedNew,
              store: store.kind,
              projectId: q.data.projectId ?? null,
            },
            effect: "allow",
            ruleId: "model-artifact-uploaded",
            ruleChain: [],
            reason: `model artifact uploaded (${size} bytes, sha256 ${sha256}); its format was decided from its content: ${detection.format}`,
          });
          return { over: null, row: a! };
        });
        if (decided.over) {
          await drainArtifactObjectDeletions(db, store, { keys: [key], actorUserId: userId });
          return refuseQuota(decided.over);
        }
        return reply.status(201).send({ artifact: artifactView(decided.row!) });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // ---- GET /v1/model-artifacts (the caller's own; an admin sees all) ------------
  app.get("/v1/model-artifacts", async (req) => {
    const where = req.authCtx.isAdmin ? undefined : eq(modelArtifacts.uploadedByUserId, req.authCtx.userId ?? NO_IDENTITY);
    const rows = await db.select().from(modelArtifacts).where(where).orderBy(desc(modelArtifacts.createdAt)).limit(200);
    return { artifacts: rows.map(artifactView) };
  });

  app.get("/v1/model-artifacts/:artifactId", async (req, reply) => {
    const { artifactId } = artifactParam.parse(req.params);
    const [a] = await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, artifactId));
    if (!a || !artifactAccessible(a, req.authCtx)) return reply.status(404).send({ error: "unknown_artifact" });
    const scans = await db.select().from(artifactScans).where(eq(artifactScans.artifactId, artifactId)).orderBy(desc(artifactScans.createdAt)).limit(100);
    return { artifact: artifactView(a), scans: scans.map(scanView) };
  });

  // ---- DELETE /v1/model-artifacts/:artifactId (the uploader or an admin, with a step-up) ----
  app.delete("/v1/model-artifacts/:artifactId", async (req, reply) => {
    const { artifactId } = artifactParam.parse(req.params);
    const caller = req.authCtx;
    const actor = caller.userId ?? NO_IDENTITY;
    const [a] = await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, artifactId));
    if (!a || !artifactAccessible(a, caller)) return reply.status(404).send({ error: "unknown_artifact" });
    const inUse = async (refs: { citedScans: number; unfinishedRuns: number }) => {
      await db.insert(auditLog).values({
        userId: actor,
        objectType: "model_artifact",
        objectId: artifactId,
        detail: { phase: "delete", refused: "artifact_in_use", ...refs },
        effect: "deny",
        ruleId: "model-artifact-delete-refused",
        ruleChain: [],
        reason: `model artifact ${artifactId} was not deleted: ${refs.citedScans} of its scans are cited as model-card evidence and ${refs.unfinishedRuns} runs on it are unfinished`,
      });
      return reply.status(409).send({
        error: "artifact_in_use",
        ...refs,
        detail: "a scan of this artifact is cited as model-card evidence, or a run on it has not finished: remove the citation or wait for the run, then delete it",
      });
    };
    // a fast refusal before a step-up is spent (re-checked on the locked row below)
    const refs = await artifactReferences(db, artifactId);
    if (refs.citedScans > 0 || refs.unfinishedRuns > 0) return inUse(refs);
    if (!(await requireStepUp(db, req, reply, artifactDeleteStepUp(artifactId))).ok) return reply;
    const done = await deleteArtifactRow(db, artifactId, {
      userId: actor,
      ruleId: "model-artifact-deleted",
      // still the caller's to delete (an admin's, or still uploaded by the caller)
      still: (row) => artifactAccessible(row, caller),
      detail: { byAdmin: caller.isAdmin && a.uploadedByUserId !== caller.userId },
      now: new Date(),
    });
    if (!done.ok) {
      if (done.error === "artifact_in_use") return inUse({ citedScans: done.citedScans, unfinishedRuns: done.unfinishedRuns });
      return reply.status(404).send({ error: "unknown_artifact" });
    }
    // the row is gone and committed: now the object (a failure stays queued for the sweep)
    const drained = done.objectQueued ? await drainArtifactObjectDeletions(db, store, { keys: [done.artifact.storageKey], actorUserId: actor }) : null;
    return reply.status(200).send({
      deleted: {
        id: done.artifact.id,
        sha256: done.artifact.sha256,
        scansDeleted: done.scansDeleted,
        // "shared": another artifact names the same bytes; "queued": the delete failed or no store is configured, the sweep retries it
        object: !done.objectQueued || (drained?.stillNamed ?? 0) > 0 ? "shared" : (drained?.deleted ?? 0) > 0 ? "deleted" : "queued",
      },
    });
  });

  // ---- GET /v1/engine-runner/artifacts/:artifactId (runner token; the scope hook enforces it) ----
  app.get("/v1/engine-runner/artifacts/:artifactId", async (req, reply) => {
    const { artifactId } = artifactParam.parse(req.params);
    const runnerId = req.authCtx.engineRunnerId!;
    const now = new Date();
    // only to the runner holding a LIVE lease on a run that targets this artifact
    const [run] = await db
      .select()
      .from(engineRuns)
      .where(
        and(
          eq(engineRuns.runnerId, runnerId),
          eq(engineRuns.status, "leased"),
          eq(engineRuns.targetArtifactId, artifactId),
          gt(engineRuns.deadlineAt, now),
          gt(engineRuns.leaseExpiresAt, now),
        ),
      )
      .limit(1);
    const [artifact] = run ? await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, artifactId)) : [];
    if (!run || !artifact || !store) {
      await db.insert(auditLog).values({
        userId: run?.runAsUserId ?? NO_IDENTITY,
        objectType: "model_artifact",
        objectId: artifactId,
        detail: { phase: "stream", runnerId, refused: !store ? "artifact_store_unavailable" : "engine_artifact_not_leased" },
        effect: "deny",
        ruleId: "engine-run-artifact-refused",
        ruleChain: [],
        reason: `runner ${runnerId} asked for artifact ${artifactId} without a live lease on a run that targets it`,
      });
      if (!store) return reply.status(503).send({ error: "artifact_store_unavailable" });
      return reply.status(409).send({ error: "engine_artifact_not_leased", detail: "this runner holds no live lease on a run that targets this artifact" });
    }
    const opened = await store.open(artifact.storageKey);
    if (opened.size !== artifact.sizeBytes) {
      opened.stream.destroy();
      return reply.status(500).send({ error: "artifact_store_inconsistent" });
    }
    await db.insert(auditLog).values({
      userId: run.runAsUserId ?? NO_IDENTITY,
      objectType: "engine_run",
      objectId: run.id,
      detail: { phase: "artifact_stream", engineId: run.engineId, runnerId, artifactId, sha256: artifact.sha256, sizeBytes: artifact.sizeBytes },
      effect: "allow",
      ruleId: "engine-run-artifact-streamed",
      ruleChain: [],
      reason: `artifact ${artifactId} streamed to runner ${runnerId} for ${run.engineId} run ${run.id}`,
    });
    return reply
      .header("content-type", "application/octet-stream")
      .header("content-length", String(artifact.sizeBytes))
      .header("x-regulait-artifact-sha256", artifact.sha256)
      .header("cache-control", "no-store")
      .send(opened.stream);
  });
}
