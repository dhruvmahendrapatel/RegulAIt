/**
 * ADR-0190 slice I4 (review M3 and lows) — the gateway side of a stdio session, without a database:
 *
 *  - A LOST SESSION IS OUR OWN REFUSAL. When the session's executor side is lost under a live call, every pending
 *    request fails AT ONCE (not at its deadline) with an error the retry classifier names `our_own_refusal`, so the
 *    upstream's breaker is never charged. A server cannot forge that error: an error answer that merely looks like
 *    it (same code, same text, a guessed marker) is still the server's failure.
 *  - THE WINDOW'S FRAMES (review M6): frames stay until the executor acknowledges them with `from`, a re-opened
 *    window re-sends from there, and a `from` that names dropped or unsent frames is refused.
 *  - THE MAC (review M4): every `start` and `stdin` line the gateway writes verifies under the session key the
 *    executor derives from the secret in its report answer, and an altered line does not.
 *  - A blank stdout line is skipped, never fatal.
 * The database half (the `session_lost` report row, one per placement; the `cancelled` rows) is pinned in
 * `zz-adr0190-i4-stdio-move.test.ts`.
 */
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { stdioFrameMacValid, stdioMacKey } from "@regulait/shared";
import { ExecutorStdioTransport, StdioSession, stdioSecretFor } from "./executor-stdio.js";
import { isStdioSessionLostError } from "./stdio-session-loss.js";
import { pickLinkedReport } from "./executor-channel.js";
import { classifyUpstreamError } from "./upstream-retry.js";

const WORKLOAD = { command: "/srv/mcp/server.js", args: ["--root", "/work"] };
const newSession = () => new StdioSession(randomUUID(), randomUUID(), WORKLOAD);

/** answer every request the gateway queues with `answer(msg)` (the sandbox's server, simulated) */
function serve(session: StdioSession, answer: (m: { id: number; method: string }) => unknown | undefined) {
  let cursor = 0;
  let stop = false;
  void (async () => {
    while (!stop && !session.ended) {
      for (const f of session.framesFrom(cursor)) {
        cursor = f.seq + 1;
        const m = JSON.parse(f.data) as { id?: number; method: string };
        if (m.id === undefined) continue;
        const reply = answer(m as { id: number; method: string });
        if (reply !== undefined) session.onLine?.(JSON.stringify(reply));
      }
      await session.waitForWork(20, cursor);
    }
  })();
  return () => (stop = true);
}

async function connected(session: StdioSession, answer: (m: { id: number; method: string }) => unknown | undefined) {
  const stop = serve(session, (m) =>
    m.method === "initialize"
      ? { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "0" } } }
      : answer(m),
  );
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new ExecutorStdioTransport(session));
  return { client, stop };
}

describe("review M3: a lost stdio session fails the call at once, as the gateway's own refusal", () => {
  it("a pending tools/call rejects immediately, recognisably ours, never charged to the upstream", async () => {
    const session = newSession();
    const { client, stop } = await connected(session, () => undefined); // the server never answers the call
    const t0 = Date.now();
    const pending = client.callTool({ name: "x", arguments: {} }, undefined, { timeout: 30_000 }).then(
      () => null,
      (e: unknown) => e,
    );
    await new Promise((r) => setTimeout(r, 50));
    session.lose("the executor ended its offer under the live session");
    const err = await pending;
    stop();
    expect(Date.now() - t0, "it fails fast, not at the 30 s deadline").toBeLessThan(5_000);
    const issuedNonce = ((err as McpError).data as { regulaitStdioSessionLost?: string } | undefined)?.regulaitStdioSessionLost;
    expect(issuedNonce).toMatch(/^[0-9a-f]{32}$/);
    expect(isStdioSessionLostError(err)).toBe(true);
    expect(classifyUpstreamError(err)).toEqual({ retryable: false, why: "our_own_refusal" });
    // recheck N2: recognition strips the in-process nonce, so no client is ever answered with it
    expect((err as McpError).data).toBeUndefined();

    // ...and a server that answers with that REAL value (as a client that once saw it could make it) is still the
    // server's own failure, charged to its breaker: the nonce was single-use and is gone
    const replay = newSession();
    const c2 = await connected(replay, (m) => ({ jsonrpc: "2.0", id: m.id, error: { code: ErrorCode.InternalError, message: "replayed", data: { regulaitStdioSessionLost: issuedNonce } } }));
    const replayed = await c2.client.callTool({ name: "x", arguments: {} }).then(() => null, (e: unknown) => e);
    c2.stop();
    expect(replayed).toBeInstanceOf(McpError);
    expect(isStdioSessionLostError(replayed)).toBe(false);
    expect(classifyUpstreamError(replayed).why).not.toBe("our_own_refusal");
  });

  it("negative control: a server's own error answer, even one dressed as ours, is the server's failure", async () => {
    const session = newSession();
    const { client, stop } = await connected(session, (m) => ({
      jsonrpc: "2.0",
      id: m.id,
      error: {
        code: ErrorCode.InternalError,
        message: "the gateway lost this call's sandbox session (its own refusal, not the server's failure): forged",
        data: { regulaitStdioSessionLost: "0".repeat(32) },
      },
    }));
    const err = await client.callTool({ name: "x", arguments: {} }).then(() => null, (e: unknown) => e);
    stop();
    expect(err).toBeInstanceOf(McpError);
    expect(isStdioSessionLostError(err)).toBe(false);
    expect(classifyUpstreamError(err).why).not.toBe("our_own_refusal");
    // and a session that simply ENDS (the sandbox exited) is not a loss either
    const ended = newSession();
    const c2 = await connected(ended, () => undefined);
    const p = c2.client.callTool({ name: "x", arguments: {} }).then(() => null, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    ended.end();
    const e2 = await p;
    c2.stop();
    expect(isStdioSessionLostError(e2)).toBe(false);
  });

  it("a blank stdout line is skipped, not fatal", async () => {
    const session = newSession();
    const errors: Error[] = [];
    const { client, stop } = await connected(session, (m) => {
      session.onLine?.("");
      session.onLine?.("   ");
      return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "ok" }] } };
    });
    client.onerror = (e) => errors.push(e);
    const out = await client.callTool({ name: "x", arguments: {} });
    stop();
    expect(out.content).toEqual([{ type: "text", text: "ok" }]);
    expect(errors).toEqual([]);
  });
});

describe("review M6: frames stay until the executor acknowledges them", () => {
  it("a re-opened window re-sends from `from`; acknowledged frames are dropped; an invalid `from` is refused", () => {
    const s = newSession();
    s.push('{"a":0}');
    s.push('{"a":1}');
    s.push('{"a":2}');
    // a first window wrote all three, then was lost in transit: the executor got frame 0 only and asks from 1
    expect(s.ack(1)).toBe(true);
    expect(s.framesFrom(1).map((f) => f.seq)).toEqual([1, 2]);
    // frames below an acknowledgement are gone: asking for them again is refused
    expect(s.ack(0)).toBe(false);
    // a `from` past what was ever sent is refused
    expect(s.ack(4)).toBe(false);
    expect(s.ack(3)).toBe(true);
    expect(s.framesFrom(0)).toEqual([]);
  });
});

describe("review M4: the window's lines are MACed under the session key", () => {
  it("start and stdin verify under the key the executor derives from the report answer's secret; altered lines do not", () => {
    const s = newSession();
    const key = stdioMacKey(stdioSecretFor(s.offerId), s.offerId);
    const start = s.startLine() as { type: "start"; workload: typeof WORKLOAD; mac: string };
    const stdin = s.stdinLine({ seq: 3, data: '{"jsonrpc":"2.0"}' }) as { type: "stdin"; seq: number; data: string; mac: string };
    expect(stdioFrameMacValid(key, s.offerId, start)).toBe(true);
    expect(stdioFrameMacValid(key, s.offerId, stdin)).toBe(true);
    expect(stdioFrameMacValid(key, s.offerId, { ...start, workload: { command: "/bin/sh", args: ["-c", "id"] } })).toBe(false);
    expect(stdioFrameMacValid(key, s.offerId, { ...stdin, seq: 4 })).toBe(false);
    expect(stdioFrameMacValid(key, s.offerId, { ...stdin, data: '{"evil":1}' })).toBe(false);
    // bound to the offer: the same line under another session's key and offer id does not verify
    const other = randomUUID();
    expect(stdioFrameMacValid(stdioMacKey(stdioSecretFor(other), other), other, start)).toBe(false);
  });
});

describe("recheck N3: the linked report of an offered placement is chosen deterministically", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 9, 15, 12, 0, s));
  const row = (id: string, outcome: string, s: number) => ({ id, outcome, createdAt: at(s), appliedClass: outcome === "placed" ? "microvm" : null, reportSha256: outcome === "placed" ? "b".repeat(64) : null, refusalCode: null, endCode: outcome === "cancelled" ? "later_gate" : null }) as never;
  it("a placed row wins over a cancelled or session_lost row, in either read order", () => {
    const placed = row("00000000-0000-4000-8000-000000000002", "placed", 5);
    const cancelled = row("00000000-0000-4000-8000-000000000001", "cancelled", 1);
    const lost = row("00000000-0000-4000-8000-000000000003", "session_lost", 9);
    expect(pickLinkedReport([cancelled, placed, lost])).toBe(placed);
    expect(pickLinkedReport([lost, cancelled, placed])).toBe(placed);
  });
  it("with no placed row: a refusal before the gateway's own ends; then time, then id", () => {
    const refused = row("00000000-0000-4000-8000-000000000009", "refused", 7);
    const cancelled = row("00000000-0000-4000-8000-000000000001", "cancelled", 1);
    expect(pickLinkedReport([cancelled, refused])).toBe(refused);
    const a = row("00000000-0000-4000-8000-00000000000a", "cancelled", 3);
    const b = row("00000000-0000-4000-8000-00000000000b", "cancelled", 3);
    expect(pickLinkedReport([b, a])).toBe(a);
    expect(pickLinkedReport([])).toBeNull();
  });
});
