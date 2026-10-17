/**
 * ADR-0190 slice I4 — STDIO MCP SERVERS MOVE INTO THE SANDBOX.
 *
 * A stdio MCP server no longer runs as a child of the gateway (OWNER
 * DECISION 2: third-party code never runs in the gateway's process or host
 * namespaces). It runs from a CLOSURE IMAGE (decision 4): an OCI image built
 * from the RegulAIt stdio base, holding the server, its interpreter and every
 * module, pinned by its content digest at registration. An executor starts
 * that digest under the placement's execution profile (gVisor `runsc` for
 * L2), proves the sandbox with the per-placement report, and only then
 * carries the MCP bytes.
 *
 * THE BYTES (answers I3 open question 3: a SIBLING stream on the same proof).
 * Once a placement is `placed`, the executor holds a second NDJSON window for
 * that offer, beside its main stream:
 *
 *   GET  /v1/executor-channel/offers/:offerId/stdio?window=   gateway → sandbox: `start` (the registered entry
 *                                                              point and argv, released to the sandbox init),
 *                                                              `stdin` frames (one JSON-RPC message each),
 *                                                              `close`, keepalives, `bye`
 *   POST /v1/executor-channel/offers/:offerId/stdio           sandbox → gateway: a batch of `stdout` frames, and
 *                                                              `eof` once the server's stdout has ended
 *
 * Each request carries the executor's one-use proof (amendment K), exactly as
 * the other channel routes. A frame is ONE line of the server's stdio (MCP's
 * stdio transport is newline-delimited JSON-RPC), bounded by
 * `STDIO_FRAME_MAX_BYTES`; a longer line ends the session (fail closed).
 * Sequence numbers are per direction and start at 0; a gap or a repeat is
 * refused, so a frame is never delivered twice or out of order.
 *
 * THE REGISTRATION. The `mcp_servers` row keeps its stdio columns with a new
 * meaning (no migration): `stdio_command` is the absolute path of the server's
 * entry point INSIDE the image, `stdio_args` its fixed argv, and
 * `stdio_command_digest` the closure image's digest (`sha256:` + 64 hex). A row
 * whose digest is not of that form (an older host-path registration) is
 * refused at connect (`mcp_stdio_image_unpinned`): built as for a first load,
 * no grandfathering (ADR-0180).
 */
import { createHmac, hkdfSync } from "node:crypto";
import canonicalize from "canonicalize";
import { z } from "zod";
import { constantTimeEqual } from "../constant-time.js";
import { EXECUTOR_CHANNEL_ROUTES } from "./channel.js";

/** a closure image's content digest: what the registration pins and the offer names (linear, anchored) */
export const STDIO_CLOSURE_IMAGE_RE = /^sha256:[0-9a-f]{64}$/;
export function isStdioClosureImage(v: unknown): v is string {
  return typeof v === "string" && v.length === 71 && STDIO_CLOSURE_IMAGE_RE.test(v);
}

/**
 * Review H2: the sandbox init is EXECUTOR-CONTROLLED. The executor ships it, checks its pinned SHA-256, copies it
 * into a volume it owns, mounts that volume READ-ONLY at this directory and makes the init the sandbox's entry
 * point, so the workload's image cannot replace or shadow it. The interpreter that runs it is the image's own
 * Node (every closure image is built FROM the RegulAIt stdio base), which is why the in-sandbox probes corroborate
 * and never decide: the class is decided by what the executor sees from outside (the container's runtime and the
 * runtime binary's pinned hash).
 *
 * Recheck N4: the per-placement probe report is therefore evidence gathered INSIDE AN IMAGE-CHOSEN INTERPRETER. The
 * executor blanks the Node variables that load code (`NODE_OPTIONS`, `NODE_PATH` and the like) on every sandbox, but
 * an image that replaces the `node` binary itself controls the interpreter, so it can FORGE the probe report (make
 * the inside view look better or worse than it is). The class is decided from outside the sandbox (this container's
 * runtime and the runtime binary's pinned hash), so a forged report can never make runc pass as gVisor.
 * Bind-mounting a pinned Node for the init is a follow-up.
 */
export const STDIO_SANDBOX_INIT_DIR = "/.regulait-init" as const;
export const STDIO_SANDBOX_INIT_PATH = "/.regulait-init/sandbox-init.mjs" as const;
/** the interpreter the stdio base image provides (Node 22, from the pinned base) */
export const STDIO_SANDBOX_NODE = "/usr/local/bin/node" as const;

/** the longest single stdio line either way (a JSON-RPC message), in UTF-8 bytes */
export const STDIO_FRAME_MAX_BYTES = 768 * 1024;
/** at most this many frames in one POST (and the POST body limit) */
export const STDIO_POST_MAX_FRAMES = 64;
export const STDIO_POST_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
/** the gateway holds at most this many unacknowledged `stdin` bytes for one session before it refuses more */
export const STDIO_SESSION_BUFFER_MAX_BYTES = 4 * 1024 * 1024;
/** at most this many stdio sessions live in one gateway process (a placement past it is refused, capacity) */
export const STDIO_MAX_LIVE_SESSIONS = 256;

// ---------------------------------------------------------------------------
// Review M4: every gateway → executor window line that the sandbox acts on is MACed
// ---------------------------------------------------------------------------

/**
 * The gateway derives a 32-byte secret for each stdio offer from its deploy-time data key (HKDF, salt = the offer
 * id), so every replica derives the same one, and hands it to the executor in its answer to the accepted
 * per-placement report. Both sides derive the session's MAC key from it with HKDF-SHA-256 (salt = the offer id).
 * Each `start` and `stdin` line carries an HMAC-SHA-256 over its canonical text with the offer id, so a line
 * injected into the window, replayed from another session or altered is refused by the executor. Over https this is
 * defence in depth; it is not a substitute for TLS (an on-path reader of the report answer learns the secret).
 */
export function stdioSessionSecret(root: Buffer, offerId: string): string {
  return Buffer.from(hkdfSync("sha256", root, Buffer.from(offerId, "utf8"), "regulait.executor-stdio-secret.v1", 32)).toString("base64url");
}
export const STDIO_SECRET_RE = /^[A-Za-z0-9_-]{43}$/;
export function stdioMacKey(secretB64url: string, offerId: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secretB64url, "base64url"), Buffer.from(offerId, "utf8"), "regulait.executor-stdio-mac.v1", 32));
}
/**
 * I5: an engine task's `start` also carries its task secret (decision 5, `task_scoped`), covered by the same MAC. A
 * `start` with no secret is MACed exactly as in I4 (the key is absent from the canonical text, not null).
 */
type MacInput = { type: "start"; workload: StdioWorkload; secret?: string | undefined } | { type: "stdin"; seq: number; data: string };
function macText(offerId: string, m: MacInput): string {
  const body =
    m.type === "start"
      ? { v: 1, offerId, type: "start", workload: m.workload, ...(m.secret !== undefined ? { secret: m.secret } : {}) }
      : { v: 1, offerId, type: "stdin", seq: m.seq, data: m.data };
  const t = canonicalize(body);
  if (t === undefined) throw new TypeError("stdio MAC: not serialisable");
  return t;
}
export function stdioFrameMac(key: Buffer, offerId: string, m: MacInput): string {
  return createHmac("sha256", key).update(macText(offerId, m), "utf8").digest("base64url");
}
export function stdioFrameMacValid(key: Buffer, offerId: string, m: MacInput & { mac: string }): boolean {
  return constantTimeEqual(stdioFrameMac(key, offerId, m), m.mac);
}

/** the two session routes (also members of `EXECUTOR_CHANNEL_ROUTES`) */
export const EXECUTOR_STDIO_ROUTES = EXECUTOR_CHANNEL_ROUTES.filter((r) => r.endsWith("/stdio"));

const utf8 = new TextEncoder();
/** a stdio line's size in UTF-8 bytes */
export function stdioLineBytes(s: string): number {
  return utf8.encode(s).length;
}

const frameData = z
  .string()
  .min(1)
  .refine((s) => stdioLineBytes(s) <= STDIO_FRAME_MAX_BYTES && !s.includes("\n"), {
    message: `one line of at most ${STDIO_FRAME_MAX_BYTES} bytes`,
  })
  // a raw NUL is never a JSON-RPC line (JSON escapes it): refused as `invalid_body`, never a server error (review)
  .refine((s) => !s.includes("\u0000"), { message: "no NUL" });

/** the server's entry point inside the image and its fixed argv (as registered), sent to the sandbox init at release */
export const stdioWorkloadSchema = z
  .object({
    command: z.string().min(2).max(4096).refine((c) => c.startsWith("/") && !c.includes("\0"), { message: "an absolute path" }),
    args: z.array(z.string().max(4096).refine((a) => !a.includes("\0"), { message: "no NUL" })).max(64),
  })
  .strict();
export type StdioWorkload = z.infer<typeof stdioWorkloadSchema>;

const macField = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/**
 * gateway → executor, on the session's NDJSON window (`GET …/stdio?window=&from=`). Review M6: frames stay with the
 * gateway until the executor acknowledges them; `from` is the next sequence number the executor expects, and the
 * window re-sends every frame from there. One window per session at a time.
 */
export const executorStdioMessageSchema = z.discriminatedUnion("type", [
  /** first line of every window: what the sandbox runs once released (the executor uses the first it sees) */
  z
    .object({
      type: z.literal("start"),
      workload: stdioWorkloadSchema,
      /** I5: an engine task's secret (the run's key), released to the workload on fd 3; never for an MCP server */
      secret: z.string().regex(/^[\x21-\x7e]{1,1024}$/).optional(),
      mac: macField,
    })
    .strict(),
  z.object({ type: z.literal("stdin"), seq: z.number().int().min(0), data: frameData, mac: macField }).strict(),
  /** the gateway closed the session: the executor ends the server's stdin and stops the sandbox */
  z.object({ type: z.literal("close") }).strict(),
  z.object({ type: z.literal("keepalive") }).strict(),
  z.object({ type: z.literal("bye"), reason: z.enum(["window"]) }).strict(),
]);
export type ExecutorStdioMessage = z.infer<typeof executorStdioMessageSchema>;

/** executor → gateway: POST /offers/:id/stdio */
export const executorStdioPostSchema = z
  .object({
    frames: z
      .array(z.object({ seq: z.number().int().min(0), data: frameData }).strict())
      .max(STDIO_POST_MAX_FRAMES),
    /** the server's stdout has ended (it exited or was stopped) */
    eof: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.frames.length > 0 || b.eof === true, { message: "a POST carries frames, eof, or both" });
export type ExecutorStdioPost = z.infer<typeof executorStdioPostSchema>;

/** POST /offers/:id/stdio → 200 */
export const executorStdioPostResponseSchema = z
  .object({
    /** the next sequence number the gateway expects */
    nextSeq: z.number().int().min(0),
    /** the gateway closed the session: stop sending, stop the sandbox */
    closed: z.boolean(),
  })
  .strict();

/** the refusals a stdio session route answers with (a fixed vocabulary) */
export const EXECUTOR_STDIO_REFUSALS = [
  /** the offer is not this executor's, or not placed */
  "offer_unavailable",
  /** no longer answered (the multi-replica relay, migration 0204, answers `session_lost`); kept so an older peer reads it */
  "stdio_session_unknown",
  /** the session's holder is gone (its lease lapsed, or it never wrote its row): final, the sandbox stops */
  "session_lost",
  /** the offer is new and its holder has not written the session's row yet: come back (not final) */
  "stdio_session_pending",
  /** a frame's sequence number is not the next one */
  "stdio_sequence",
  /** another window of this session is open (one at a time, review M6) */
  "stdio_window_open",
  /** the gateway holds no MAC key for the session: it cannot be MACed (fail closed) */
  "stdio_unkeyed",
  /** `from` names frames the gateway no longer holds, or frames it never sent (review M6) */
  "stdio_from_invalid",
  "invalid_body",
] as const;
