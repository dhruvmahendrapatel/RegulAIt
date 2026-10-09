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
 *            format is never `clean` (owner decision 1, pending confirmation).
 *
 * No store configured → uploads are refused (503), never kept in the database or memory.
 *
 * Open-source check (ADR-0176): the S3 store is the AWS SDK the gateway already ships
 * (@aws-sdk/client-s3, Apache-2.0); the filesystem store is node:fs. Streaming hash and size limit are
 * node:crypto and node:stream. Format detection: see packages/shared/src/engines/modelscan.ts.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FastifyInstance } from "fastify";
import {
  and,
  artifactScans,
  auditLog,
  desc,
  engineRuns,
  eq,
  gt,
  modelArtifacts,
  type Db,
  type EngineRunRow,
} from "@regulait/db";
import {
  ARTIFACT_FORMAT_PLANS,
  ARTIFACT_SCAN_CHIP,
  artifactScanAdmissible,
  deriveArtifactScanVerdict,
  detectArtifactFormat,
  type ArtifactFormat,
  type ArtifactReader,
  type ArtifactScanVerdictValue,
  type EngineRunNormalised,
  type EngineTerminalRunStatus,
} from "@regulait/shared";
import { z } from "zod";
import { loadOrgSettings } from "./org-settings.js";
import { assertProjectAttribution } from "./projects.js";

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
}

export const artifactStorageKey = (sha256: string) => `sha256/${sha256}`;
const KEY = /^sha256\/[0-9a-f]{64}$/;

/** a directory on the gateway's own volume: one 0600 file per sha256, written by rename */
export class FileArtifactStore implements ArtifactStore {
  readonly kind = "filesystem" as const;
  constructor(private readonly dir: string) {}
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
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await pipeline(createReadStream(file), createWriteStream(tmp, { mode: 0o600, flags: "wx" }));
    const fh = await open(tmp, "r");
    await fh.sync();
    await fh.close();
    await rename(tmp, target);
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
        const storedNew = !(await store.has(key));
        if (storedNew) await store.putFile(key, tmp, sha256, size);
        const declaredExtension = /\.([A-Za-z0-9]{1,12})$/.exec(filename)?.[1]?.toLowerCase() ?? null;
        const row = await db.transaction(async (tx) => {
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
          return a!;
        });
        return reply.status(201).send({ artifact: artifactView(row) });
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
