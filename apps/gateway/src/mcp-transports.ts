/**
 * ADR-0185 G4 — THE UPSTREAM TRANSPORTS: Streamable HTTP, SSE and stdio.
 *
 * HTTP and SSE are the official SDK transports (`@modelcontextprotocol/sdk`
 * 1.32.0, already locked — open source first, ADR-0176: no client of our
 * own). This module only decides HOW each is opened; WHETHER a connect may
 * happen at all (admission, the org's transport list, the egress guard, the
 * stdio closure rules and the isolation placement) is decided before it, in
 * `mcp-egress.ts` (`checkUpstreamDestination`, `guardedMcpConnect`), and a
 * refusal there means this file is never reached — no socket, no sandbox.
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
 * ── stdio (ADR-0190 slice I4) ───────────────────────────────────────────────
 * A stdio server NEVER runs on the gateway host: there is no process spawn
 * anywhere in the gateway (OWNER DECISION 2, an invariant; built as for a
 * first load, ADR-0180, with no fallback to the old in-process spawn). It runs
 * in a sandbox an executor started from the server's CLOSURE IMAGE, pinned by
 * its content digest at registration, under the execution profile decision 7
 * requires (gVisor at L2 by default). The MCP bytes travel over the
 * executor's own outbound channel (`executor-stdio.ts`), and the transport
 * here is the SDK `Transport` over that session. Registration stores:
 *  - `image`: the closure image's digest (`sha256:` + 64 hex);
 *  - `command`: the absolute path of the server's entry point INSIDE the image;
 *  - `args`: a fixed `string[]` (≤ 64 × 4 KiB, no NUL), never a shell line.
 * This closes ADR-0185's three disclosed stdio residues: the hash-to-spawn
 * TOCTOU (the runtime starts a digest, not a path), interpreter and module
 * pinning (the closure image holds them), and credential binding (the sandbox
 * holds no credential: profile `secrets: none`). argv is stored in the audit
 * log and shown to admins, so it must never carry a secret.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { isStdioClosureImage, MCP_STDIO_LIMITS, type McpUpstreamTransport } from "@regulait/shared";
import { ExecutorStdioTransport, type StdioSession } from "./executor-stdio.js";

// ---------------------------------------------------------------------------
// The stdio closure rules (registration, update and every connect)
// ---------------------------------------------------------------------------

export const STDIO_REFUSAL_CODES = ["not_absolute", "invalid_argv", "image_unpinned"] as const;
export type StdioRefusalCode = (typeof STDIO_REFUSAL_CODES)[number];

export type StdioClosureCheck =
  | { ok: true; image: string; command: string; args: string[] }
  | { ok: false; code: StdioRefusalCode; detail: string };

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

/**
 * The rules for one stdio registration, checked at registration, on update
 * and at EVERY connect (a stored row is re-checked, never trusted): the image
 * is pinned by content digest, the entry point is an absolute path inside the
 * image (no `.` or `..` segment), argv is bounded. Nothing on the gateway's
 * filesystem is looked at: the command does not exist here, and never runs here.
 */
export function checkStdioClosure(image: unknown, command: unknown, args: unknown): StdioClosureCheck {
  if (!isStdioClosureImage(image)) {
    return {
      ok: false,
      code: "image_unpinned",
      detail: "a stdio server runs from a closure image pinned by its content digest (sha256: followed by 64 hex characters)",
    };
  }
  const argv = stdioArgvProblem(args);
  if (argv) return { ok: false, code: "invalid_argv", detail: argv };
  if (
    typeof command !== "string" ||
    command.length < 2 ||
    !command.startsWith("/") ||
    command.includes("\0") ||
    Buffer.byteLength(command, "utf8") > MCP_STDIO_LIMITS.maxCommandBytes ||
    command.split("/").some((seg, i) => i > 0 && (seg === "" || seg === "." || seg === ".."))
  ) {
    return { ok: false, code: "not_absolute", detail: "the command must be the absolute path of the server's entry point inside the image" };
  }
  return { ok: true, image, command, args: [...(args as string[])] };
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

/** what `guardedMcpConnect` decided may be opened (stdio: a session already PLACED in a sandbox) */
export type UpstreamLaunch =
  | { transport: "streamable_http" | "sse"; url: string; fetch: typeof fetch }
  | { transport: "stdio"; session: StdioSession };

/**
 * Open the SDK transport for an ALREADY-ADJUDICATED destination. Nothing here
 * decides anything: it is reached only after `checkUpstreamDestination` allowed
 * the row (and, for stdio, after an executor's sandbox was placed and its
 * per-placement report accepted).
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
      // ADR-0190 I4: the MCP bytes go to the sandbox over the executor's channel; nothing is spawned here
      return new ExecutorStdioTransport(launch.session);
  }
}

/** the transport a row names (absent on a pre-0169 row shape = Streamable HTTP) */
export function rowTransport(row: { transport?: McpUpstreamTransport | null }): McpUpstreamTransport {
  return row.transport ?? "streamable_http";
}
