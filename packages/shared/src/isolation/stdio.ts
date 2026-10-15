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
import { z } from "zod";
import { EXECUTOR_CHANNEL_ROUTES } from "./channel.js";

/** a closure image's content digest: what the registration pins and the offer names (linear, anchored) */
export const STDIO_CLOSURE_IMAGE_RE = /^sha256:[0-9a-f]{64}$/;
export function isStdioClosureImage(v: unknown): v is string {
  return typeof v === "string" && v.length === 71 && STDIO_CLOSURE_IMAGE_RE.test(v);
}

/** where the RegulAIt stdio base puts the sandbox init; every closure image is built FROM that base */
export const STDIO_SANDBOX_INIT_PATH = "/regulait/sandbox-init" as const;

/** the longest single stdio line either way (a JSON-RPC message), in UTF-8 bytes */
export const STDIO_FRAME_MAX_BYTES = 768 * 1024;
/** at most this many frames in one POST (and the POST body limit) */
export const STDIO_POST_MAX_FRAMES = 64;
export const STDIO_POST_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
/** the gateway holds at most this many unread `stdin` bytes for one session before it refuses more */
export const STDIO_SESSION_BUFFER_MAX_BYTES = 4 * 1024 * 1024;

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
  });

/** the server's entry point inside the image and its fixed argv (as registered), sent to the sandbox init at release */
export const stdioWorkloadSchema = z
  .object({
    command: z.string().min(2).max(4096).refine((c) => c.startsWith("/") && !c.includes("\0"), { message: "an absolute path" }),
    args: z.array(z.string().max(4096).refine((a) => !a.includes("\0"), { message: "no NUL" })).max(64),
  })
  .strict();
export type StdioWorkload = z.infer<typeof stdioWorkloadSchema>;

/** gateway → executor, on the session's NDJSON window */
export const executorStdioMessageSchema = z.discriminatedUnion("type", [
  /** first line of every window: what the sandbox runs once released (the executor uses the first it sees) */
  z.object({ type: z.literal("start"), workload: stdioWorkloadSchema }).strict(),
  z.object({ type: z.literal("stdin"), seq: z.number().int().min(0), data: frameData }).strict(),
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
  /** no gateway replica process here holds the session (see the I4 as-built note on replicas) */
  "stdio_session_unknown",
  /** a frame's sequence number is not the next one */
  "stdio_sequence",
  "invalid_body",
] as const;
