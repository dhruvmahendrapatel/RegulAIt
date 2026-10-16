/**
 * ADR-0190 slice I4 — THE STDIO SESSION, executor side: once the gateway has
 * accepted the per-placement report of an `mcp_stdio` sandbox, carry the MCP
 * bytes between the sandbox and the gateway over the executor's own outbound
 * channel (the sandbox has no network: the pipe IS the decision 4 channel).
 *
 *   1. hold the session's NDJSON window (`GET …/offers/:id/stdio`); its first
 *      line is `start` (the registered entry point and argv). Only then is the
 *      sandbox's input released, with that argv — never before, never twice;
 *   2. every `stdin` frame, in sequence, becomes one line on the server's stdin;
 *      a gap ends the session (fail closed); a frame already written (re-sent
 *      after a lost window, review M6) is skipped. Each window asks
 *      `from=<next expected seq>`, which acknowledges every frame before it;
 *   2a. review M4: `start` and every `stdin` line carry an HMAC over the
 *      offer id and the line (the key is derived from the secret this executor
 *      sent in its report). A line whose MAC does not verify is never acted on:
 *      the session ends and the sandbox is stopped;
 *   3. every line the server writes is POSTed back in order (batched while a
 *      POST is in flight), then `eof` when its stdout ends; a blank line is not
 *      a JSON-RPC message and is skipped (review low);
 *   4. `close` (the gateway closed the MCP session) ends the server's stdin and
 *      stops the sandbox; the session also ends when the sandbox does.
 *
 * Nothing here judges the bytes: the gateway's governance runs on its side of
 * the stream, exactly as it does for any other upstream.
 */
import { STDIO_POST_MAX_FRAMES, stdioFrameMacValid, type StdioWorkload } from "@regulait/shared";
import type { SandboxHandle } from "./backend.js";
import { ExecutorHttpError, type ExecutorClient } from "./client.js";

export interface StdioPumpOptions {
  client: ExecutorClient;
  offerId: string;
  handle: SandboxHandle;
  /** review M4: the session's MAC key (`stdioMacKey(secret, offerId)`) */
  macKey: Buffer;
  /** the session window to ask for (seconds; default 25) */
  windowSeconds?: number;
  /** how long to wait for the gateway's `start` before giving up (default 30 s) */
  startTimeoutMs?: number;
  /** after the gateway's `close`, how long the server may take to exit before it is stopped (default 5 s) */
  closeGraceMs?: number;
  log?: (m: string) => void;
}

export type StdioPumpEnd = "completed" | "gateway_closed" | "refused" | "no_start" | "sequence" | "mac_invalid";

/** the session's refusals that end it (anything else is transient and the window is re-opened) */
const FINAL = new Set(["offer_unavailable", "stdio_session_unknown", "stdio_sequence", "stdio_unkeyed", "invalid_body"]);

export async function pumpStdio(opts: StdioPumpOptions): Promise<StdioPumpEnd> {
  const { client, offerId, handle } = opts;
  const stdio = handle.stdio;
  if (!stdio) {
    await handle.kill();
    return "refused";
  }
  const abort = new AbortController();
  let started = false;
  let end: StdioPumpEnd | null = null;
  let expectSeq = 0;
  const finish = (why: StdioPumpEnd) => {
    if (end === null) end = why;
    abort.abort();
    // anything but a clean end stops the sandbox now (its stdout then ends, which unblocks the outbound side)
    if (end !== "completed") void handle.kill().catch(() => undefined);
  };
  let taskSecret: string | undefined;
  let startResolve!: (w: StdioWorkload | null) => void;
  const startGiven = new Promise<StdioWorkload | null>((r) => (startResolve = r));
  const startTimer = setTimeout(() => startResolve(null), opts.startTimeoutMs ?? 30_000);
  // stdin frames wait for the release (they may arrive in the same window as `start`)
  let releasedResolve!: (ok: boolean) => void;
  const released = new Promise<boolean>((r) => (releasedResolve = r));

  // gateway → sandbox
  const inbound = (async () => {
    let backoff = 250;
    while (!abort.signal.aborted) {
      try {
        await client.stdioStream(
          offerId,
          opts.windowSeconds ?? 25,
          expectSeq,
          async (m) => {
            if ((m.type === "start" || m.type === "stdin") && !stdioFrameMacValid(opts.macKey, offerId, m)) {
              // an injected, replayed (from another session) or altered line: never acted on
              opts.log?.(`offer ${offerId}: a ${m.type} line failed its MAC; session ended`);
              startResolve(null);
              finish("mac_invalid");
              return;
            }
            switch (m.type) {
              case "start":
                if (!started) {
                  started = true;
                  // I5: an engine task's secret travels in this MACed line only; it is handed to the release, never logged
                  taskSecret = m.secret;
                  startResolve(m.workload);
                }
                break;
              case "stdin":
                if (!started || !(await released) || end !== null) return;
                // a frame re-sent after a lost window, already written: skip it (review M6)
                if (m.seq < expectSeq) return;
                if (m.seq !== expectSeq) {
                  opts.log?.(`offer ${offerId}: stdin frame ${m.seq} out of sequence (expected ${expectSeq}); session ended`);
                  finish("sequence");
                  return;
                }
                expectSeq += 1;
                await stdio.write(m.data);
                break;
              case "close":
                // end the server's stdin and let it exit by itself; one that does not is stopped after a grace period
                await stdio.endInput().catch(() => undefined);
                setTimeout(() => finish("gateway_closed"), opts.closeGraceMs ?? 5_000).unref?.();
                break;
              case "keepalive":
              case "bye":
                break;
            }
          },
          abort.signal,
        );
        backoff = 250;
      } catch (e) {
        if (abort.signal.aborted) return;
        if (e instanceof ExecutorHttpError && e.code && FINAL.has(e.code)) {
          opts.log?.(`offer ${offerId}: the gateway refused the stdio session (${e.code}); sandbox stopped`);
          startResolve(null);
          finish("refused");
          return;
        }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(5_000, backoff * 2);
      }
    }
  })();

  const workload = await startGiven;
  clearTimeout(startTimer);
  if (!workload || end !== null) {
    releasedResolve(false);
    finish(end ?? "no_start");
    await handle.kill();
    await inbound.catch(() => undefined);
    return end ?? "no_start";
  }
  try {
    const secret = taskSecret;
    taskSecret = undefined;
    await handle.releaseInput(workload, secret);
    releasedResolve(true);
  } catch (e) {
    releasedResolve(false);
    finish("refused");
    await handle.kill().catch(() => undefined);
    await inbound.catch(() => undefined);
    opts.log?.(`offer ${offerId}: release failed (${(e as Error).message}); sandbox stopped`);
    return "refused";
  }

  // sandbox → gateway, in order, batched while a POST is in flight
  const outbound = (async () => {
    let seq = 0;
    const queue: string[] = [];
    let done = false;
    const waiter: { wake: (() => void) | null } = { wake: null };
    const reader = (async () => {
      try {
        for await (const line of stdio.lines()) {
          if (line.trim() === "") continue;
          queue.push(line);
          waiter.wake?.();
        }
      } finally {
        done = true;
        waiter.wake?.();
      }
    })();
    try {
      for (;;) {
        if (queue.length === 0 && !done) await new Promise<void>((r) => (waiter.wake = r));
        waiter.wake = null;
        if (abort.signal.aborted && end !== "completed") break;
        const batch = queue.splice(0, STDIO_POST_MAX_FRAMES);
        if (batch.length === 0 && !done) continue;
        const eof = done && queue.length === 0;
        const frames = batch.map((data) => ({ seq: seq++, data }));
        try {
          const answer = await client.stdioPost(offerId, { frames, ...(eof ? { eof: true } : {}) });
          if (answer.closed) {
            finish("gateway_closed");
            break;
          }
        } catch (e) {
          opts.log?.(`offer ${offerId}: stdout not delivered (${e instanceof ExecutorHttpError ? (e.code ?? e.status) : (e as Error).message}); session ended`);
          finish("refused");
          break;
        }
        if (eof) {
          finish("completed");
          break;
        }
      }
    } finally {
      await reader.catch(() => undefined);
    }
  })();

  await Promise.race([outbound, handle.ended]);
  if (end === null) finish("completed");
  if (end !== "completed") await handle.kill().catch(() => undefined);
  await Promise.allSettled([outbound, inbound]);
  return end ?? "completed";
}
