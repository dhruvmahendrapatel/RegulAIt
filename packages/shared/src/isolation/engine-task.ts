/**
 * ADR-0190 slice I5 — ENGINE WORKERS UNDER EXECUTION PROFILES: the engine task contract.
 *
 * An ADR-0187 engine worker (the garak and promptfoo workers, the modelscan scanner) no longer runs as a
 * long-lived container beside its runner. Each leased run is ONE `engine_worker` placement (decision 3, OWNER
 * DECISION 4: L2), decided in the lease's transaction and keyed to the run's own decision (the I4/I8 contract),
 * and ONE sandbox an executor starts from the engine's task image under the placement's profile. The runner is the
 * trusted side; it never runs the engine. The gateway is the hub between the two:
 *
 *   runner   POST /v1/engine-runner/runs/:runId/task/input    the job files (inline) and the run's artifact (by
 *                                                             reference), plus the task secret (the run's key)
 *   executor GET  /v1/executor-channel/offers/:offerId/input  the input manifest (paths, sizes, sha256, digest)
 *   executor GET  /v1/executor-channel/offers/:offerId/input/:n   file n's bytes
 *   executor (I4) the per-placement report now names `inputSha256`; the stdio window's MACed `start` line carries
 *                 the task secret; stdout frames go back on the I4 stdio routes
 *   runner   GET  /v1/engine-runner/runs/:runId/task/frames   the sandbox's stdout frames (result files, tunnel
 *                                                             requests), long-polled and acknowledged with `from`
 *   runner   POST /v1/engine-runner/runs/:runId/task/frames   frames for the sandbox's stdin (tunnel answers), or
 *                                                             `close` (a cancel)
 *
 * THE TWO CHANNELS the runsc backend gains (I4 refused both):
 *  - INPUT VOLUME: the executor writes the input into a directory it owns, verifies every file against the
 *    manifest as it writes, and mounts that directory READ-ONLY at the profile's input path. The digest of what it
 *    wrote (`engineTaskInputDigest`) is in the per-placement report, and the gateway refuses a report whose digest
 *    is not the one the runner's input has (`input_digest_mismatch`): the sandbox never runs on other bytes.
 *  - TASK-SCOPED SECRET (decision 5): the run's key reaches the sandbox only in the MACed `start` line, then the
 *    release line on the sandbox init's stdin, and from the init to the workload on file descriptor 3 (a pipe). It is
 *    never in the environment, the argv, a label or a file Docker can show, never logged, and it dies with the task
 *    (the gateway drops it once the sandbox spoke, and revokes the run's key when the run ends, ADR-0187).
 *
 * THE GATEWAY CHANNEL (decision 4, `network: gateway_only`). The sandbox has no network of its own (runsc
 * `--network=none`). A worker that calls models (garak, promptfoo) reaches the gateway through a loopback proxy in
 * the sandbox that turns each request into an `http` stdout frame; the RUNNER (outside, on the engines network)
 * sends it to the run's own gateway model route and answers with an `http_res` stdin frame. Only the run's gateway
 * base path is reachable that way; anything else is answered `http_err` (`not_gateway`).
 */
import canonicalize from "canonicalize";
import { z } from "zod";
import { sha256Hex } from "../audit-chain.js";

/** the engine-worker profile's input name and where the shipped profile mounts it (profiles.ts) */
export const ENGINE_TASK_INPUT_NAME = "jobs" as const;
/** at most this many files in one task's input */
export const ENGINE_TASK_MAX_FILES = 16;
/** the inline files' total size (job descriptions; an artifact is streamed by reference) */
export const ENGINE_TASK_INLINE_MAX_BYTES = 1024 * 1024;
/** the runner's upload body bound (inline files as base64 plus the rest) */
export const ENGINE_TASK_UPLOAD_BODY_LIMIT_BYTES = 2 * 1024 * 1024;
/** one file of a task's input, at most (an artifact is also bounded by the org's artifact limit) */
export const ENGINE_TASK_FILE_MAX_BYTES = 16 * 1024 * 1024 * 1024;
/** one `file` frame's decoded chunk, at most (its base64 stays well inside the I4 frame bound) */
export const ENGINE_TASK_CHUNK_MAX_BYTES = 384 * 1024;
/** one tunnelled request or answer body, decoded, at most */
export const ENGINE_TASK_HTTP_BODY_MAX_BYTES = 512 * 1024;
/** the gateway holds at most this many unacknowledged stdout bytes of one task for its runner */
export const ENGINE_TASK_OUTPUT_BUFFER_MAX_BYTES = 32 * 1024 * 1024;
/** at most this many frames in one answer to the runner */
export const ENGINE_TASK_FRAMES_MAX = 64;
/** how long an executor waits for the runner's input (within the report deadline of an accepted offer) */
export const ENGINE_TASK_INPUT_WAIT_MS = 90_000;
/** a refusal of the executor's input fetch that means "not yet": the runner has not uploaded it */
export const ENGINE_TASK_INPUT_PENDING = "engine_task_input_pending" as const;
/**
 * the public literal address an engine task's in-sandbox egress probe must FAIL to reach (ADR-0187 decision 19; the
 * engine images' `REGULAIT_EGRESS_PROBE_ADDRESS`, which the sandbox init does not pass to the workload)
 */
export const ENGINE_TASK_EGRESS_PROBE_ADDRESS = "93.184.215.14" as const;
/** the workload's file descriptor the sandbox init writes the task secret to (a pipe; never env or argv) */
export const ENGINE_TASK_SECRET_FD = 3;

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;
/** a relative path of 1 to 4 segments, none `.` or `..` (split first, each piece checked alone: linear) */
export function isEngineTaskPath(p: unknown): p is string {
  if (typeof p !== "string" || p.length < 1 || p.length > 300 || p.startsWith("/") || p.endsWith("/")) return false;
  const segs = p.split("/");
  return segs.length >= 1 && segs.length <= 4 && segs.every((s) => s !== "." && s !== ".." && SEGMENT_RE.test(s));
}
const taskPath = z.string().refine(isEngineTaskPath, { message: "a relative path of at most 4 segments of [A-Za-z0-9._-]" });
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const b64 = z.string().max(4 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** the task secret: printable ASCII, no space, bounded (the run's virtual key) */
export const ENGINE_TASK_SECRET_RE = /^[\x21-\x7e]{1,1024}$/;
export const engineTaskSecretSchema = z.string().regex(ENGINE_TASK_SECRET_RE);

/** one file of a task's input, as the manifest names it */
export const engineTaskInputFileSchema = z.object({ path: taskPath, size: z.number().int().min(0).max(ENGINE_TASK_FILE_MAX_BYTES), sha256 }).strict();
export type EngineTaskInputFile = z.infer<typeof engineTaskInputFileSchema>;

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * THE INPUT DIGEST every per-placement report of an engine task names: SHA-256 of the canonical (RFC 8785) text of
 * `{v: 1, input: "jobs", files: [{path, size, sha256}] sorted by path}`. The executor computes it from the bytes it
 * WROTE into the input directory, the gateway from the runner's upload; they must agree.
 */
export function engineTaskInputDigest(files: readonly EngineTaskInputFile[]): string {
  const sorted = [...files].sort(byPath).map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 }));
  const text = canonicalize({ v: 1, input: ENGINE_TASK_INPUT_NAME, files: sorted });
  if (text === undefined) throw new TypeError("engineTaskInputDigest: not serialisable");
  return sha256Hex(text);
}

const uniquePaths = (files: ReadonlyArray<{ path: string }>) => new Set(files.map((f) => f.path)).size === files.length;
/** no path may be a directory of another (`a` and `a/b`): the input is a tree of files only */
const noPrefixPaths = (files: ReadonlyArray<{ path: string }>) => files.every((f) => !files.some((g) => g !== f && g.path.startsWith(`${f.path}/`)));

/** GET …/offers/:offerId/input → 200: the manifest the executor writes the input against */
export const engineTaskInputManifestSchema = z
  .object({
    input: z.literal(ENGINE_TASK_INPUT_NAME),
    files: z.array(engineTaskInputFileSchema).min(1).max(ENGINE_TASK_MAX_FILES),
    digest: sha256,
  })
  .strict()
  .refine((m) => uniquePaths(m.files) && noPrefixPaths(m.files), { message: "duplicate or nested input path" })
  .refine((m) => m.digest === engineTaskInputDigest(m.files), { message: "the digest is not the files' digest" });
export type EngineTaskInputManifest = z.infer<typeof engineTaskInputManifestSchema>;

/** POST /v1/engine-runner/runs/:runId/task/input: once per run; the input is immutable after it */
export const engineTaskInputUploadSchema = z
  .object({
    /** small files written by the runner's adapter (the job description), base64 */
    files: z.array(z.object({ path: taskPath, data: b64 }).strict()).max(ENGINE_TASK_MAX_FILES),
    /**
     * where the run's OWN target artifact goes in the input (an artifact scan only); the gateway streams it from its
     * store to the executor (never through the runner), and the runner cannot name any other artifact
     */
    artifact: z.object({ path: taskPath }).strict().nullable(),
    /** the task secret (the run's key), or null for a worker that calls nothing (the modelscan scanner) */
    secret: engineTaskSecretSchema.nullable(),
  })
  .strict()
  .refine((u) => u.files.length + (u.artifact ? 1 : 0) >= 1 && u.files.length + (u.artifact ? 1 : 0) <= ENGINE_TASK_MAX_FILES, {
    message: `1 to ${ENGINE_TASK_MAX_FILES} files`,
  })
  .refine((u) => uniquePaths([...u.files, ...(u.artifact ? [u.artifact] : [])]) && noPrefixPaths([...u.files, ...(u.artifact ? [u.artifact] : [])]), {
    message: "duplicate or nested input path",
  })
  .refine((u) => u.files.reduce((n, f) => n + Math.floor((f.data.length * 3) / 4), 0) <= ENGINE_TASK_INLINE_MAX_BYTES + 3 * ENGINE_TASK_MAX_FILES, {
    message: `the inline files exceed ${ENGINE_TASK_INLINE_MAX_BYTES} bytes`,
  });
export type EngineTaskInputUpload = z.infer<typeof engineTaskInputUploadSchema>;

// ---------------------------------------------------------------------------
// Frames: one JSON object per stdout / stdin line of the task (inside the I4 frame bound)
// ---------------------------------------------------------------------------

/** headers the tunnel carries either way (lower-case names; everything else is dropped) */
export const ENGINE_TASK_HTTP_HEADERS = ["content-type", "accept", "authorization", "x-regulait-agent", "x-regulait-project"] as const;
const headerValue = z.string().max(4096).regex(/^[\x20-\x7e]*$/);
// zod 4: a record keyed by an enum is exhaustive; a partial record admits any subset of the named headers
const headers = z.partialRecord(z.enum(ENGINE_TASK_HTTP_HEADERS), headerValue);
const requestId = z.string().regex(/^[0-9]{1,12}$/);
const http_path = z
  .string()
  .min(2)
  .max(2048)
  .refine((p) => p.startsWith("/") && !p.startsWith("//") && !/[\s\\#]/.test(p) && !p.split("?")[0]!.split("/").some((s) => s === ".." || s === "."), {
    message: "an absolute path with no dot segments",
  });

/** sandbox → runner (stdout) */
export const engineTaskOutFrameSchema = z.discriminatedUnion("t", [
  /**
   * one chunk of a result file, in order; `last` carries the whole file's size and sha256. The path is relative to
   * the runner's results directory: `<runId>/<file>` for the run's files, or a top-level `.<name>-selftest.json`
   */
  z
    .object({
      t: z.literal("file"),
      path: taskPath,
      chunk: z.number().int().min(0).max(1_000_000),
      data: b64,
      last: z.boolean(),
      size: z.number().int().min(0).optional(),
      sha256: sha256.optional(),
    })
    .strict()
    .refine((f) => !f.last || (f.size !== undefined && f.sha256 !== undefined), { message: "the last chunk names the file's size and sha256" }),
  /** a request for the gateway, through the runner (the gateway channel) */
  z.object({ t: z.literal("http"), id: requestId, method: z.enum(["GET", "POST"]), path: http_path, headers, body: b64 }).strict(),
  /** the task is over: every result file was sent */
  z.object({ t: z.literal("end"), code: z.number().int().min(0).max(255) }).strict(),
]);
export type EngineTaskOutFrame = z.infer<typeof engineTaskOutFrameSchema>;

/** why the runner did not forward a tunnelled request (a fixed vocabulary) */
export const ENGINE_TASK_HTTP_ERRORS = ["not_gateway", "too_large", "unreachable", "timeout", "invalid"] as const;

/** runner → sandbox (stdin) */
export const engineTaskInFrameSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("http_res"), id: requestId, status: z.number().int().min(100).max(599), headers, body: b64 }).strict(),
  z.object({ t: z.literal("http_err"), id: requestId, code: z.enum(ENGINE_TASK_HTTP_ERRORS) }).strict(),
]);
export type EngineTaskInFrame = z.infer<typeof engineTaskInFrameSchema>;

/** GET /v1/engine-runner/runs/:runId/task/frames → 200 */
export const ENGINE_TASK_STATES = ["awaiting_input", "awaiting_placement", "running", "ended", "refused"] as const;
export type EngineTaskState = (typeof ENGINE_TASK_STATES)[number];
export const engineTaskFramesResponseSchema = z
  .object({
    state: z.enum(ENGINE_TASK_STATES),
    /** stdout frames from `from` on (each one stdout line of the task) */
    frames: z.array(z.object({ seq: z.number().int().min(0), data: z.string() }).strict()).max(ENGINE_TASK_FRAMES_MAX),
    /** the next frame the gateway will hand out after these */
    nextSeq: z.number().int().min(0),
    /** the sandbox's stdout ended (no frame follows the ones held) */
    eof: z.boolean(),
    /** why the task cannot run (a decision 7 code, `execution_profile_mismatch`, or a session failure) */
    refusal: z.string().max(64).nullable(),
  })
  .strict();
export type EngineTaskFramesResponse = z.infer<typeof engineTaskFramesResponseSchema>;

/** POST /v1/engine-runner/runs/:runId/task/frames: stdin frames for the sandbox, or close it */
export const engineTaskFramesPostSchema = z
  .object({
    frames: z.array(z.string().min(1).max(768 * 1024)).max(ENGINE_TASK_FRAMES_MAX),
    close: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.frames.length > 0 || b.close === true, { message: "frames, close, or both" });

/**
 * ADR-0190 decision 10 — the RUNTIME PROBE an engine worker's self-test records (written inside its sandbox at the
 * start of every task): what the worker observes of its runtime from inside. Recorded, never decisive (review H2):
 * the isolation class is decided from outside the sandbox by the executor.
 */
export const sandboxRuntimeObservationSchema = z
  .object({
    kernelRelease: z.string().max(128),
    procVersionGvisor: z.boolean(),
    uid: z.number().int().min(-1),
    capEff: z.string().max(16),
    noNewPrivs: z.number().int().min(-1).max(1),
    seccomp: z.number().int().min(-1).max(2),
  })
  .strict();
export type SandboxRuntimeObservation = z.infer<typeof sandboxRuntimeObservationSchema>;

/** the lease's task: where the run executes (always an executor placement from I5 on) */
export const engineLeaseTaskSchema = z.object({ placementId: z.string().uuid(), offerId: z.string().uuid() }).strict();
