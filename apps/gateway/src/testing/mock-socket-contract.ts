/**
 * Vitest `setupFiles` entry: complete `light-my-request`'s `MockSocket` against
 * the part of the `net.Socket` contract that a real dependency actually calls.
 *
 * THE DEFECT THIS CLOSES (see ADR-0106)
 * -------------------------------------
 * `apps/gateway/src/mcp-proxy.ts` serves the inbound MCP endpoint by handing the
 * RAW Node request/response to the MCP SDK:
 *
 *     await transport.handleRequest(req.raw, reply.raw, req.body);
 *
 * `StreamableHTTPServerTransport` implements that with `getRequestListener()`
 * from `@hono/node-server` (a transitive dependency of
 * `@modelcontextprotocol/sdk`, which is why it appears in no workspace
 * package.json). When a request body was not fully consumed by the time the
 * response finishes or closes, that listener calls its own `drainIncoming()`,
 * which arms a 500 ms timer and then, on expiry:
 *
 *     const socket = incoming.socket;
 *     if (socket && !socket.destroyed) { socket.destroySoon(); }
 *
 * Under `app.inject()` the request is a `light-my-request` `CustomRequest`
 * whose `.socket` is a `MockSocket extends EventEmitter` carrying exactly one
 * property: `remoteAddress`. It has no `destroyed` and no `destroySoon`. So the
 * guard reads `!undefined` → true, passes, and calls a method that is not
 * there. The result is
 *
 *     TypeError: socket.destroySoon is not a function
 *         at Timeout.forceClose (@hono/node-server/dist/index.mjs)
 *         at listOnTimeout (node:internal/timers)
 *
 * thrown from the timer queue with no try/catch in the path — an UNHANDLED
 * exception. Vitest reports it, warns that it "might cause false positive
 * tests", and exits NON-ZERO even when every test passed. `timer.unref()` stops
 * the timer holding the process open; it does not stop it firing.
 *
 * That is why the suite's exit code was non-deterministic: the timer only arms
 * when some request's body goes undrained, and the throw only lands if the
 * process is still alive 500 ms later.
 *
 * WHY THIS IS A FIX AND NOT A SUPPRESSION
 * ---------------------------------------
 * The mock is INCOMPLETE against the interface it stands in for. A real
 * `net.Socket` has `destroySoon()` and reports `destroyed` truthfully; this one
 * reports `undefined` for both, which is what makes the caller's guard lie.
 * Completing the mock removes the defect. It does not hide unhandled errors:
 * there is deliberately no `dangerouslyIgnoreUnhandledErrors` and no
 * `process.on('uncaughtException')` here, so the next unrelated unhandled error
 * still fails the run. That property is asserted by the controls recorded in
 * ADR-0106.
 *
 * HOW THE PROTOTYPE IS REACHED, AND WHAT WAS REJECTED
 * ---------------------------------------------------
 * `MockSocket` is not exported by `light-my-request` — not from its index, not
 * from its types. So one throwaway request is injected into a bare Fastify
 * instance and the socket's prototype is read off it. That binds to the EXACT
 * class every other `inject()` in this suite will use, whatever version pnpm
 * resolved, with no path guessing.
 *
 * Rejected:
 *   - deep-importing `light-my-request/lib/request.js`: it is a transitive dep
 *     (via fastify), so the bare specifier does not resolve from this package
 *     under pnpm's isolated layout, and pinning an absolute `.pnpm` path would
 *     break on every version bump.
 *   - a Fastify `onRequest` hook: the suite builds its own app instances, so a
 *     hook here would never be installed on them.
 *   - passing a custom `Request` to `inject`: that would have to be threaded
 *     through all 172 test files.
 *
 * The patch is applied ONCE, only if `destroySoon` is genuinely missing, and
 * only to the mock's prototype. Real sockets are untouched — nothing here can
 * reach `net.Socket`.
 */
import Fastify from "fastify";

/** Own-property flag backing the `destroyed` accessor. */
const kDestroyed = Symbol.for("regulait.light-my-request.MockSocket.destroyed");

type MockSocketLike = {
  [kDestroyed]?: boolean;
  emit: (event: string, ...args: unknown[]) => boolean;
};

let mockSocketPrototype: object | null = null;

const probe = Fastify({ logger: false });
probe.get("/__mock_socket_probe", async (req) => {
  // `req.raw.socket` is typed as net.Socket; under inject it is a MockSocket.
  mockSocketPrototype = Object.getPrototypeOf(req.raw.socket) as object | null;
  return { ok: true };
});

await probe.ready();
await probe.inject({ method: "GET", url: "/__mock_socket_probe" });
await probe.close();

if (mockSocketPrototype === null) {
  throw new Error(
    "mock-socket-contract: could not reach light-my-request's MockSocket prototype. " +
      "The shim that keeps @hono/node-server's drainIncoming() from throwing an unhandled " +
      "TypeError is therefore NOT installed — see ADR-0106. Failing loudly rather than " +
      "letting the suite run with a non-deterministic exit code.",
  );
}

const proto = mockSocketPrototype as MockSocketLike;

if (typeof (proto as { destroySoon?: unknown }).destroySoon !== "function") {
  Object.defineProperty(proto, "destroyed", {
    configurable: true,
    get(this: MockSocketLike): boolean {
      return this[kDestroyed] === true;
    },
    set(this: MockSocketLike, value: boolean) {
      this[kDestroyed] = value === true;
    },
  });

  Object.defineProperty(proto, "destroySoon", {
    configurable: true,
    writable: true,
    enumerable: false,
    // A real net.Socket's destroySoon() ends the writable side and destroys the
    // socket once anything buffered has flushed, after which `destroyed` is
    // true and a `close` event has been emitted. A MockSocket has no buffer and
    // no peer, so "once flushed" is "now": mark it destroyed and emit `close`.
    // That is the whole observable behaviour a caller can depend on here.
    value(this: MockSocketLike): MockSocketLike {
      if (this[kDestroyed] === true) return this;
      this[kDestroyed] = true;
      this.emit("close");
      return this;
    },
  });
}
