/**
 * ADR-0190 slice I4 — THE STDIO SESSION, executor side, against an in-memory
 * gateway and the fake backend's stdio stand-in:
 *  - nothing reaches the sandbox before the gateway's `start`; the release
 *    carries exactly the registered argv;
 *  - stdin frames arrive in order, each one line; stdout goes back in order
 *    with contiguous sequence numbers, then `eof`;
 *  - `close` ends the server's stdin; the server exits and the session completes;
 *  - an out-of-order frame ends the session and kills the sandbox;
 *  - a session the gateway refuses (or that never starts) kills the sandbox
 *    with its input never released.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { executionProfileDigest, SHIPPED_EXECUTION_PROFILES, stdioFrameMac, stdioMacKey, type ExecutionOffer, type ExecutorStdioMessage, type ExecutorStdioPost, type StdioWorkload } from "@regulait/shared";
import { ExecutorHttpError, type ExecutorClient } from "./client.js";
import { FakeSandboxBackend } from "./fake-backend.js";
import { pumpStdio } from "./stdio-pump.js";

const restricted = SHIPPED_EXECUTION_PROFILES.restricted;
const offer: ExecutionOffer = {
  id: "6b0c1a3e-6a1e-4a4b-9a2c-0f4e5d6c7b8a",
  workloadKind: "mcp_stdio",
  requiredClass: "user_space_kernel",
  requiredBy: "workload_kind",
  enforcement: "enforce",
  profileDigest: executionProfileDigest(restricted),
  imageDigest: `sha256:${"e".repeat(64)}`,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};
const WORKLOAD = { command: "/srv/mcp/server.js", args: ["--root", "/work"] };
const SECRET = Buffer.alloc(32, 7).toString("base64url");
const KEY = stdioMacKey(SECRET, offer.id);
/** the gateway's lines, MACed as the gateway does it */
const start = (workload: StdioWorkload = WORKLOAD, key = KEY, offerId = offer.id): ExecutorStdioMessage => ({ type: "start", workload, mac: stdioFrameMac(key, offerId, { type: "start", workload }) });
const stdin = (seq: number, data: string, key = KEY): ExecutorStdioMessage => ({ type: "stdin", seq, data, mac: stdioFrameMac(key, offer.id, { type: "stdin", seq, data }) });

/** an in-memory gateway: one scripted window per call, and a record of every POST */
function gateway(windows: ExecutorStdioMessage[][], opts: { refuse?: string } = {}) {
  const posts: ExecutorStdioPost[] = [];
  const froms: number[] = [];
  let i = 0;
  const client = {
    async stdioStream(_id: string, _w: number, from: number, onMessage: (m: ExecutorStdioMessage) => Promise<void> | void, signal?: AbortSignal) {
      froms.push(from);
      if (opts.refuse) throw new ExecutorHttpError("stdio", 409, opts.refuse);
      const w = windows[i++];
      if (!w) {
        // nothing more: hold the window until the pump aborts it
        await new Promise<void>((r) => signal?.addEventListener("abort", () => r(), { once: true }));
        return;
      }
      for (const m of w) await onMessage(m);
    },
    async stdioPost(_id: string, body: ExecutorStdioPost) {
      posts.push(body);
      return { nextSeq: posts.flatMap((p) => p.frames).length, closed: false };
    },
  } as unknown as ExecutorClient;
  return { client, posts, froms };
}

async function sandbox(backend: FakeSandboxBackend) {
  return backend.start(offer, restricted, "user_space_kernel");
}

describe("the executor's stdio session", () => {
  it("releases only on start with the registered argv; stdin in order; stdout back in order, then eof once the server exits after close", async () => {
    const backend = new FakeSandboxBackend({ stdioServer: (line) => [`echo:${line}`] });
    const h = await sandbox(backend);
    const rec = backend.sandboxes[0]!;
    const { client, posts } = gateway([
      [start(), stdin(0, '{"id":1}'), stdin(1, '{"id":2}')],
      [{ type: "keepalive" }, { type: "close" }],
    ]);
    const how = await pumpStdio({ client, offerId: offer.id, handle: h, macKey: KEY });
    // the server exited by itself once its stdin ended: a clean end
    expect(how).toBe("completed");
    expect(rec.workload).toEqual(WORKLOAD);
    expect(rec.stdin).toEqual(['{"id":1}', '{"id":2}']);
    const frames = posts.flatMap((p) => p.frames);
    expect(frames).toEqual([
      { seq: 0, data: 'echo:{"id":1}' },
      { seq: 1, data: 'echo:{"id":2}' },
    ]);
    expect(await h.ended).toBe("completed");
  });

  it("a frame out of sequence ends the session and the sandbox (fail closed)", async () => {
    const backend = new FakeSandboxBackend({ stdioServer: () => [] });
    const h = await sandbox(backend);
    const { client } = gateway([[start(), stdin(1, "{}")]]);
    expect(await pumpStdio({ client, offerId: offer.id, handle: h, macKey: KEY })).toBe("sequence");
    expect(backend.sandboxes[0]).toMatchObject({ killed: true, stdin: [] });
  });

  it("a session the gateway refuses never releases the input, and the sandbox is killed", async () => {
    const backend = new FakeSandboxBackend({ stdioServer: () => [] });
    const h = await sandbox(backend);
    const { client } = gateway([], { refuse: "stdio_session_unknown" });
    expect(await pumpStdio({ client, offerId: offer.id, handle: h, macKey: KEY })).toBe("refused");
    expect(backend.sandboxes[0]).toMatchObject({ released: false, killed: true, workload: null });
  });

  it("no start within the deadline: never released, killed", async () => {
    const backend = new FakeSandboxBackend({ stdioServer: () => [] });
    const h = await sandbox(backend);
    const { client } = gateway([[{ type: "keepalive" }]]);
    expect(await pumpStdio({ client, offerId: offer.id, handle: h, macKey: KEY, startTimeoutMs: 50 })).toBe("no_start");
    expect(backend.sandboxes[0]).toMatchObject({ released: false, killed: true });
  });

  describe("review M4: an injected line is refused", () => {
    // another session's offer id, made at run time (no id-shaped literal next to a key)
    const OTHER_OFFER = randomUUID();
    const OTHER = stdioMacKey(Buffer.alloc(32, 9).toString("base64url"), offer.id);
    const cases: Array<[string, ExecutorStdioMessage[]]> = [
      ["injected argv (a start MACed with another key)", [start({ command: "/bin/sh", args: ["-c", "id"] }, OTHER)]],
      ["argv altered after MACing", [{ ...(start() as Extract<ExecutorStdioMessage, { type: "start" }>), workload: { command: "/bin/sh", args: [] } }]],
      ["a start replayed from another session", [start(WORKLOAD, stdioMacKey(SECRET, OTHER_OFFER), OTHER_OFFER)]],
    ];
    it.each(cases)("%s: never released, killed", async (_n, window) => {
      const backend = new FakeSandboxBackend({ stdioServer: () => [] });
      const h = await sandbox(backend);
      const { client } = gateway([window]);
      expect(await pumpStdio({ client, offerId: offer.id, handle: h, macKey: KEY })).toBe("mac_invalid");
      expect(backend.sandboxes[0]).toMatchObject({ released: false, killed: true, workload: null });
    });

    it("injected stdin (a frame with a forged MAC) is never written to the server", async () => {
      const backend = new FakeSandboxBackend({ stdioServer: () => [] });
      const h = await sandbox(backend);
      const { client } = gateway([[start(), stdin(0, '{"ok":1}'), stdin(1, '{"evil":1}', OTHER)]]);
      expect(await pumpStdio({ client, offerId: offer.id, handle: h, macKey: KEY })).toBe("mac_invalid");
      expect(backend.sandboxes[0]!.stdin).toEqual(['{"ok":1}']);
      expect(backend.sandboxes[0]!.killed).toBe(true);
    });
  });

  it("review M6: a lost window loses nothing; the next window asks from the next unacknowledged frame, and re-sent frames are skipped", async () => {
    const backend = new FakeSandboxBackend({ stdioServer: (line) => [`echo:${line}`] });
    const h = await sandbox(backend);
    const { client, froms } = gateway([
      // the first window drops after frame 0 (frame 1 was sent by the gateway but never arrived)
      [start(), stdin(0, '{"id":1}')],
      // the gateway re-sends from the executor's `from` (1); a duplicate of 0 in flight is skipped
      [start(), stdin(0, '{"id":1}'), stdin(1, '{"id":2}'), { type: "close" }],
    ]);
    expect(await pumpStdio({ client, offerId: offer.id, handle: h, macKey: KEY })).toBe("completed");
    expect(froms.slice(0, 2)).toEqual([0, 1]);
    expect(backend.sandboxes[0]!.stdin).toEqual(['{"id":1}', '{"id":2}']);
  });

  it("a blank stdout line is skipped, not fatal", async () => {
    const backend = new FakeSandboxBackend({ stdioServer: (line) => ["", `echo:${line}`, "   "] });
    const h = await sandbox(backend);
    const { client, posts } = gateway([[start(), stdin(0, "{}"), { type: "close" }]]);
    expect(await pumpStdio({ client, offerId: offer.id, handle: h, macKey: KEY })).toBe("completed");
    expect(posts.flatMap((p) => p.frames)).toEqual([{ seq: 0, data: "echo:{}" }]);
  });
});
