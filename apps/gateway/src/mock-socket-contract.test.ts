/**
 * ADR-0106 — pins the MockSocket completion installed by
 * `src/testing/mock-socket-contract.ts` (a vitest `setupFiles` entry).
 *
 * Without it, `@hono/node-server`'s `drainIncoming()` — reached from every
 * `app.inject()` that lands on the inbound MCP route, because
 * `mcp-proxy.ts` hands `req.raw`/`reply.raw` to
 * `StreamableHTTPServerTransport`, which is built on `getRequestListener()` —
 * arms a 500 ms timer whose `forceClose` runs
 *
 *     if (socket && !socket.destroyed) { socket.destroySoon(); }
 *
 * against a mock that has neither property. `!undefined` is true, the guard
 * passes, and the missing method throws a TypeError from the timer queue with
 * nothing to catch it: an unhandled error, a non-zero exit, on an all-green
 * run.
 *
 * These tests are the non-vacuity control. Delete the setupFiles entry and the
 * first two go red on the exact expression hono evaluates.
 */
import { EventEmitter } from "node:events";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";

/** Inject one request and hand back the socket the framework built for it. */
async function injectedSocket(): Promise<import("node:net").Socket> {
  const app = Fastify({ logger: false });
  let socket: import("node:net").Socket | null = null;
  app.post("/probe", async (req) => {
    socket = req.raw.socket;
    return { ok: true };
  });
  await app.ready();
  await app.inject({ method: "POST", url: "/probe", payload: { a: 1 } });
  await app.close();
  if (socket === null) throw new Error("route did not run");
  return socket;
}

describe("light-my-request MockSocket satisfies the net.Socket contract hono calls", () => {
  it("is the mock, not a real socket, and still answers both members", async () => {
    const socket = await injectedSocket();

    // Guard against this test silently becoming vacuous if light-my-request
    // ever starts handing out real sockets: then the shim is unnecessary, and
    // this assertion is the thing that says so.
    expect(socket).toBeInstanceOf(EventEmitter);
    expect(socket.constructor.name).toBe("MockSocket");

    expect(typeof socket.destroySoon).toBe("function");
    expect(socket.destroyed).toBe(false);
  });

  it("survives the exact guard @hono/node-server's forceClose evaluates", async () => {
    const socket = await injectedSocket();
    const closes: number[] = [];
    socket.on("close", () => closes.push(1));

    // Verbatim from @hono/node-server dist/index.mjs `forceClose`.
    if (socket && !socket.destroyed) {
      socket.destroySoon();
    }

    expect(socket.destroyed).toBe(true);
    expect(closes).toHaveLength(1);

    // Idempotent: a real socket's destroySoon on an already-destroyed socket is
    // a no-op, and hono's guard would skip it anyway.
    socket.destroySoon();
    expect(closes).toHaveLength(1);
  });

  it("does not touch real net.Socket", async () => {
    const { Socket } = await import("node:net");
    const real = new Socket();
    try {
      expect(typeof real.destroySoon).toBe("function");
      expect(real.destroyed).toBe(false);
      expect(Object.getPrototypeOf(real)).not.toBe(
        Object.getPrototypeOf(await injectedSocket()),
      );
    } finally {
      real.destroy();
    }
  });
});
