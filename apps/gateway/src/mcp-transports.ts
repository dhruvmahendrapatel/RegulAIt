/**
 * ADR-0185 G4 — THE UPSTREAM TRANSPORTS: Streamable HTTP, SSE and stdio.
 *
 * Every one is the official SDK transport (`@modelcontextprotocol/sdk` 1.32.0,
 * already locked — open source first, ADR-0176: no client of our own). This
 * module only decides HOW each is opened; WHETHER a connect may happen at all
 * (admission, the org's transport list, the egress guard, the stdio host rules
 * and the pinned digest) is decided before it, in `mcp-egress.ts`
 * (`checkUpstreamDestination`), and a refusal there means this file is never
 * reached — no socket, no process.
 *
 * ── SSE ─────────────────────────────────────────────────────────────────────
 * The SAME guarded, pinned fetch as Streamable HTTP for every request the
 * transport makes (the event-stream GET and every message POST), so DNS
 * re-validation, address pinning and the redirect refusal apply unchanged. On
 * top of it an ORIGIN PIN: a request to any origin other than the registered
 * URL's is refused before the inner fetch runs. The SDK already rejects an
 * `endpoint` event naming another origin; the pin is the second line, so the
 * guarantee does not rest on one library check.
 *
 * ── stdio ───────────────────────────────────────────────────────────────────
 * A double opt-in. The HOST names the directories commands may live in
 * (`REGULAIT_MCP_STDIO_ALLOWED_DIRS`, path-list; unset = stdio is impossible),
 * and an admin enables `stdio` in `mcp_upstream_transports`. Then:
 *  - the command is an absolute path whose realpath lies inside an allowed
 *    directory (a symlink pointing out is refused), a regular file with an
 *    execute bit, neither world- nor group-writable, and no directory from
 *    its own up to the allowed directory is group- or world-writable
 *    (B3S-06: `group_writable`, `writable_parent`);
 *  - argv is a fixed `string[]` (≤ 64 × 4 KiB, no NUL) handed to the SDK's
 *    cross-spawn with `shell: false` — never a shell line, never interpolated;
 *  - the child's environment is ONLY the SDK's safe default
 *    (`getDefaultEnvironment()`: HOME, LOGNAME, PATH, SHELL, TERM, USER) —
 *    never `DATABASE_URL`, `REGULAIT_DATA_KEY` or any provider key;
 *  - cwd is the allowed directory holding the command; stderr is piped and
 *    drained (discarded), so a chatty child can neither block on a full pipe
 *    nor write into the gateway's own log;
 *  - one process per request, capped process-wide by
 *    `REGULAIT_MCP_STDIO_MAX_PROCS` (default 4), killed on close (the SDK's
 *    stdin-end → SIGTERM → SIGKILL ladder) and on a missed connect deadline;
 *  - the command's sha256 is pinned at registration; a different file at
 *    connect is refused (`mcp-stdio-digest-mismatch`).
 *
 * DISCLOSED RESIDUE: the file is hashed and then spawned by its realpath, so a
 * swap in the gap between the two is not caught by the digest (a host that can
 * write into an allowed directory between those two syscalls already controls
 * that directory). Only the ENTRY FILE is digest-pinned: an interpreter it
 * names (`#!`) and the modules that interpreter loads are not. argv is stored
 * in the audit log and shown to admins, so it must never carry a secret. The
 * child runs as the gateway's own OS user with no further isolation — process
 * isolation and credential binding are PF-06 (batch 6).
 */
import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
  type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { MCP_STDIO_LIMITS, type McpUpstreamTransport } from "@regulait/shared";

// ---------------------------------------------------------------------------
// The host policy (environment)
// ---------------------------------------------------------------------------

export const STDIO_ALLOWED_DIRS_ENV = "REGULAIT_MCP_STDIO_ALLOWED_DIRS";
export const STDIO_MAX_PROCS_ENV = "REGULAIT_MCP_STDIO_MAX_PROCS";
export const STDIO_DEFAULT_MAX_PROCS = 4;
/** an operator typo must not lift the cap into "unbounded" */
const STDIO_MAX_PROCS_CEILING = 64;

export interface StdioHostPolicy {
  /** the realpaths of the allowed directories that exist; empty = stdio impossible */
  allowedDirs: string[];
  maxProcs: number;
}

/**
 * Read the host opt-in. Read on every decision (never cached), so an operator
 * who removes the variable and restarts — or a test that unsets it — gets the
 * strict answer at once. A relative entry, or one that does not resolve to a
 * directory, is ignored: it can never widen anything.
 */
export async function loadStdioHostPolicy(env: NodeJS.ProcessEnv = process.env): Promise<StdioHostPolicy> {
  const raw = env[STDIO_ALLOWED_DIRS_ENV] ?? "";
  const allowedDirs: string[] = [];
  for (const entry of raw.split(path.delimiter)) {
    const dir = entry.trim();
    if (!dir || !path.isAbsolute(dir) || dir.includes("\0")) continue;
    try {
      const real = await realpath(dir);
      if ((await stat(real)).isDirectory() && !allowedDirs.includes(real)) allowedDirs.push(real);
    } catch {
      // a missing directory allows nothing
    }
  }
  const n = Number.parseInt(env[STDIO_MAX_PROCS_ENV] ?? "", 10);
  const maxProcs =
    Number.isInteger(n) && n >= 1 ? Math.min(n, STDIO_MAX_PROCS_CEILING) : STDIO_DEFAULT_MAX_PROCS;
  return { allowedDirs, maxProcs };
}

// ---------------------------------------------------------------------------
// The command rules
// ---------------------------------------------------------------------------

export const STDIO_REFUSAL_CODES = [
  "not_absolute",
  "outside_allowed_dirs",
  "not_executable",
  "world_writable",
  "group_writable",
  "writable_parent",
  "invalid_argv",
] as const;
export type StdioRefusalCode = (typeof STDIO_REFUSAL_CODES)[number];

export type StdioCommandCheck =
  | {
      ok: true;
      /** the verified realpath — what is hashed and what is spawned */
      realCommand: string;
      /** the allowed directory that contains it (the child's cwd) */
      allowedDir: string;
      /** sha256 hex of the file's bytes */
      digest: string;
    }
  | { ok: false; code: StdioRefusalCode; detail: string };

const inside = (dir: string, p: string) => p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);

/** argv: a fixed string[] — ≤ 64 entries, each ≤ 4 KiB (UTF-8), no NUL */
export function stdioArgvProblem(args: unknown): string | null {
  if (!Array.isArray(args)) return "args must be a list of separate strings, never one shell line";
  if (args.length > MCP_STDIO_LIMITS.maxArgs) return `at most ${MCP_STDIO_LIMITS.maxArgs} arguments`;
  for (const [i, a] of args.entries()) {
    if (typeof a !== "string") return `argument ${i} is not a string`;
    if (a.includes("\0")) return `argument ${i} contains a NUL byte`;
    if (Buffer.byteLength(a, "utf8") > MCP_STDIO_LIMITS.maxArgBytes) {
      return `argument ${i} is longer than ${MCP_STDIO_LIMITS.maxArgBytes} bytes`;
    }
  }
  return null;
}

/** sha256 of a file's bytes, streamed (a large binary is never held in memory) */
export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (c) => h.update(c))
      .on("end", () => resolve(h.digest("hex")));
  });
}

/**
 * The host rules for one command + argv, at registration, on update and at
 * EVERY connect (a write-time verdict is not a fact about the future: the file
 * can be replaced, chmod'ed or re-linked after it was registered).
 */
export async function checkStdioCommand(
  command: string,
  args: unknown,
  policy: StdioHostPolicy,
): Promise<StdioCommandCheck> {
  const argv = stdioArgvProblem(args);
  if (argv) return { ok: false, code: "invalid_argv", detail: argv };
  if (
    typeof command !== "string" ||
    command.includes("\0") ||
    Buffer.byteLength(command, "utf8") > MCP_STDIO_LIMITS.maxCommandBytes ||
    !path.isAbsolute(command)
  ) {
    return { ok: false, code: "not_absolute", detail: "the command must be an absolute path to a file" };
  }
  const outside = {
    ok: false as const,
    code: "outside_allowed_dirs" as const,
    detail: `the command must resolve inside one of the host's allowed directories (${STDIO_ALLOWED_DIRS_ENV})`,
  };
  let real: string;
  try {
    real = await realpath(command);
  } catch {
    // nothing there: name WHICH rule the path breaks without probing further
    const lexical = path.resolve(command);
    return policy.allowedDirs.some((d) => inside(d, lexical))
      ? { ok: false, code: "not_executable", detail: "no file exists at the command path" }
      : outside;
  }
  // realpath, not the path as typed: a symlink inside an allowed directory
  // that points out of it is an escape, and is refused here
  const allowedDir = policy.allowedDirs.find((d) => inside(d, real));
  if (!allowedDir) return outside;
  const st = await stat(real);
  if (!st.isFile()) return { ok: false, code: "not_executable", detail: "the command is not a regular file" };
  if ((st.mode & 0o002) !== 0) {
    return { ok: false, code: "world_writable", detail: "the command file is world-writable; anyone on the host could replace it" };
  }
  // B3S-06: a group member could rewrite the file as surely as anyone could
  // a world-writable one
  if ((st.mode & 0o020) !== 0) {
    return { ok: false, code: "group_writable", detail: "the command file is group-writable; any member of its group could replace it" };
  }
  // B3S-06: nor may anyone but the owner be able to rename or replace it in
  // place — every directory from the command's own up to the allowed
  // directory must be writable by its owner only
  for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
    const ds = await stat(dir);
    if ((ds.mode & 0o022) !== 0) {
      return {
        ok: false,
        code: "writable_parent",
        detail: `a directory holding the command (${dir}) is group- or world-writable; others could replace the command in it`,
      };
    }
    if (dir === allowedDir || path.dirname(dir) === dir) break;
  }
  try {
    await access(real, fsConstants.X_OK);
  } catch {
    return { ok: false, code: "not_executable", detail: "the command file is not executable by the gateway" };
  }
  return { ok: true, realCommand: real, allowedDir, digest: await sha256File(real) };
}

// ---------------------------------------------------------------------------
// The process cap
// ---------------------------------------------------------------------------

let liveStdio = 0;

/** how many stdio children are alive right now (a test reads it) */
export function liveStdioProcesses(): number {
  return liveStdio;
}

/** take one of `max` process slots; null when the host is at its cap */
export function acquireStdioSlot(max: number): (() => void) | null {
  if (liveStdio >= max) return null;
  liveStdio += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    liveStdio -= 1;
  };
}

/**
 * The SDK's stdio transport with the gateway's lifecycle around it: the slot
 * it holds is given back exactly once — when the gateway closes it, when the
 * child exits by itself, or when the spawn fails — and stderr is drained.
 */
class GovernedStdioTransport extends StdioClientTransport {
  constructor(params: StdioServerParameters, private readonly release: () => void) {
    super(params);
    // set BEFORE Protocol.connect, which chains a handler already present
    this.onclose = () => this.release();
    this.stderr?.on("data", () => {});
  }
  override async start(): Promise<void> {
    try {
      await super.start();
    } catch (err) {
      this.release();
      throw err;
    }
  }
  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      this.release();
    }
  }
}

// ---------------------------------------------------------------------------
// The SSE origin pin
// ---------------------------------------------------------------------------

/** Thrown by the origin pin: the SSE upstream tried to send us elsewhere. */
export class SseCrossOriginError extends Error {
  constructor(readonly expectedOrigin: string, readonly requestedOrigin: string) {
    super(`SSE upstream named another origin (${requestedOrigin}); only ${expectedOrigin} may be reached`);
    this.name = "SseCrossOriginError";
  }
}

/** a fetch that refuses any request outside `origin` before `inner` runs */
export function originPinnedFetch(origin: string, inner: typeof fetch): typeof fetch {
  const pinned = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let requested: string;
    try {
      requested = new URL(raw).origin;
    } catch {
      requested = "invalid";
    }
    if (requested !== origin) throw new SseCrossOriginError(origin, requested);
    return inner(input, init);
  };
  return pinned as typeof fetch;
}

/** the SDK's own refusal of a cross-origin `endpoint` event, recognised (SDK
 * 1.32.0 wording, pinned by the lockfile and by the G4 test) */
export function isSseCrossOriginRefusal(err: unknown): boolean {
  if (err instanceof SseCrossOriginError) return true;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === "string" && msg.includes("Endpoint origin does not match connection origin");
}

// ---------------------------------------------------------------------------
// openTransport
// ---------------------------------------------------------------------------

/** what `checkUpstreamDestination` decided may be opened */
export type UpstreamLaunch =
  | { transport: "streamable_http" | "sse"; url: string; fetch: typeof fetch }
  | { transport: "stdio"; realCommand: string; args: string[]; allowedDir: string; release: () => void };

/**
 * Open the SDK transport for an ALREADY-ADJUDICATED destination. Nothing here
 * decides anything: it is reached only after `checkUpstreamDestination` allowed
 * the row (and, for stdio, after a process slot was taken).
 */
export function openTransport(launch: UpstreamLaunch, opts: { deadlineMs: number }): Transport {
  switch (launch.transport) {
    case "streamable_http":
      // byte-identical to the pre-G4 connect (ROADMAP G2's deadline signal)
      return new StreamableHTTPClientTransport(new URL(launch.url), {
        fetch: launch.fetch,
        requestInit: { signal: AbortSignal.timeout(opts.deadlineMs) },
      });
    case "sse": {
      // No requestInit signal: the event stream outlives the connect deadline
      // by design, and the SDK replaces a POST's signal with its own. The
      // connect deadline is enforced around `client.connect` instead.
      const url = new URL(launch.url);
      return new SSEClientTransport(url, { fetch: originPinnedFetch(url.origin, launch.fetch) });
    }
    case "stdio":
      return new GovernedStdioTransport(
        {
          command: launch.realCommand,
          args: [...launch.args],
          // the SDK merges this over getDefaultEnvironment(); passing exactly
          // that default makes the child's environment explicit, not inherited
          env: getDefaultEnvironment(),
          cwd: launch.allowedDir,
          stderr: "pipe",
        },
        launch.release,
      );
  }
}

/** the transport a row names (absent on a pre-0169 row shape = Streamable HTTP) */
export function rowTransport(row: { transport?: McpUpstreamTransport | null }): McpUpstreamTransport {
  return row.transport ?? "streamable_http";
}
