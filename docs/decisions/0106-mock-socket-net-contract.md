# ADR-0106 — The gateway suite's exit code is a fact, not a coin flip: completing an incomplete socket mock

- **Status**: Accepted
- **Date**: 2026-09-08
- **Relates to**: [ADR-0097](0097-mcp-admission-scanning-and-auth-discovery.md) and
  [ADR-0103](0103-mcp-path-project-budget-gate.md) (the MCP proxy route whose `req.raw` /
  `reply.raw` hand-off is the one production call site that reaches the defective code path),
  [ADR-0104](0104-approval-payload-binding.md) / [ADR-0105](0105-consent-context-binding-and-expiry.md)
  (suites that drive that route hardest, and where the symptom was most often blamed)
- **Migration**: none. No schema change, no route change, no production-code change.
- **Closes**: finding F01 (the quality gate's non-deterministic exit code) and the residue of
  AER-003 (no documented local clean-checkout verification sequence).

## Context

The gateway suite has, intermittently and for a long time, exited **non-zero on a run in which
every single test passed**. The most recent certification run on this tree produced exactly that:

```
Test Files  172 passed (172)
     Tests  2685 passed | 9 skipped (2694)
    Errors  1 error
```

— all green, `exit 1`, with vitest's warning that the unhandled error "might cause false positive
tests". A gate that can be red for a reason unrelated to any assertion is a gate people learn to
re-run, and a gate people re-run is not a gate. That is the defect: not the noise, the loss of
signal.

### The causal chain, traced end to end

Every link below was re-verified against this tree rather than taken from the finding.

1. **`apps/gateway/src/mcp-proxy.ts:1458`** serves the inbound MCP endpoint by handing the *raw*
   Node request and response to the SDK:

   ```ts
   await transport.handleRequest(req.raw, reply.raw, req.body);
   ```

2. **`StreamableHTTPServerTransport`** implements that with `getRequestListener()` from
   `@hono/node-server` (`@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js:9`).

3. **`@hono/node-server@1.19.15` is in the tree transitively**, as a dependency of
   `@modelcontextprotocol/sdk@1.29.0` (`pnpm-lock.yaml:4223`). That is why it appears in no
   workspace `package.json` and why nobody looking at our declared dependencies would find it.

4. Its listener registers `outgoing.on("finish"|"close")` handlers that call **`drainIncoming()`**
   whenever a non-`GET`/`HEAD` request's body was not fully consumed. `drainIncoming` arms

   ```js
   const timer = setTimeout(forceClose, DRAIN_TIMEOUT_MS /* = 500 */);
   timer.unref?.();
   ```

   **`unref()` stops the timer from holding the process open; it does not stop it firing** while
   the process is alive. `forceClose` is:

   ```js
   const socket = incoming.socket;
   if (socket && !socket.destroyed) { socket.destroySoon(); }
   ```

5. Under `app.inject()` — Fastify's testing entry point, i.e. `light-my-request` — the request is
   a `CustomRequest` whose `.socket` is

   ```js
   class MockSocket extends EventEmitter {
     constructor (remoteAddress) { super(); this.remoteAddress = remoteAddress }
   }
   ```

   (`light-my-request@6.6.0/lib/request.js:40-45`) — **one property, and nothing else**.

6. So `socket.destroyed` is `undefined`, `!undefined` is `true`, the guard **passes**, and the very
   next statement calls a method that does not exist. Verified in-process, in vitest, with the
   whole stack:

   ```
   TypeError: socket.destroySoon is not a function
    ❯ Timeout.forceClose  @hono/node-server/dist/index.mjs:390:14
    ❯ listOnTimeout       node:internal/timers:585:17
    ❯ processTimers       node:internal/timers:521:7
   ```

   Thrown from the timer queue, with no `try`/`catch` anywhere on the path. An **unhandled
   exception**. Vitest reports it and exits non-zero regardless of assertion outcomes.

7. A real `net.Socket` was checked against the same two expressions and answers both:
   `typeof s.destroySoon === "function"`, `s.destroyed === false`.

### Why it was intermittent, and why it kept being blamed on the wrong file

Two independent conditions must coincide: some request's body must go undrained (which depends on
request shape, response shape and who consumed what), **and** the process must still be alive
500 ms later. Neither is stable across runs, machines or file ordering. `mcp-admission-auth.test.ts`
is where it usually surfaced only because that file drives the MCP transport hardest — the bug is
not in it, and no edit to it could have fixed anything.

### What this is NOT

It is not a flaky test. Not one assertion in the suite is unstable; the 172 files were green on
every run in which the failure appeared. It is a defect in test *infrastructure* that could report
failure on a correct tree — and, worse in principle, could report an error alongside a genuine
failure and make the genuine one harder to see.

## Decision

**Complete the mock against the part of the `net.Socket` contract that a real dependency actually
calls, in a vitest `setupFiles` entry.**

`apps/gateway/vitest.config.ts` gains its first `setupFiles` entry,
`src/testing/mock-socket-contract.ts`, which gives `MockSocket`:

- **`destroySoon()`** — a real socket ends its writable side and destroys once anything buffered has
  flushed, after which it is `destroyed` and has emitted `close`. A `MockSocket` has no buffer and
  no peer, so "once flushed" is "now": mark it destroyed, emit `close`, return `this`. Idempotent,
  as the real one is.
- **`destroyed`** — an accessor over an own-symbol flag, so it reads `false` on a live mock and
  `true` after `destroySoon()`. Truthfully, which is the whole point: the caller's guard was lied
  to by `undefined`.

### Why this is a fix and not a suppression

The distinction matters enough to state plainly. A suppression makes a true report stop being
heard. This makes a false report stop being *produced*:

- The mock stands in for `net.Socket`. It was **incomplete against that interface** — a real socket
  has both members. Completing it removes the cause.
- The guard `socket && !socket.destroyed` was **not wrong to pass**; it was fed `undefined` by an
  object claiming to be a socket. After the change it is answered correctly, and `forceClose` runs
  to completion — verified by observing `socket.destroyed === true` after the 500 ms timer, i.e.
  the drain path *executes*, it is not skipped.
- **No unhandled error is hidden.** There is deliberately no
  `dangerouslyIgnoreUnhandledErrors`, no `process.on('uncaughtException')`, and no `try`/`catch`
  around anything. This is asserted by control (3) below: an unrelated asynchronous throw
  introduced into a test file still fails the run.
- **Nothing in `node_modules` is vendored or patched**, and nothing changes for real sockets — the
  patched object is reachable only through `light-my-request`.

### How the prototype is reached, and what was rejected

`MockSocket` is not exported — not from `light-my-request`'s index, not from its types. The setup
file therefore injects **one throwaway request into a bare Fastify instance** and reads the
prototype off the socket the framework built. That binds to the exact class every other `inject()`
in the suite will use, whatever version pnpm resolved, with no path guessing. If the prototype
cannot be reached the setup file **throws**, rather than leaving the suite running with the defect
un-fixed and nobody told.

Rejected, and why:

| considered | rejected because |
| --- | --- |
| deep-import `light-my-request/lib/request.js` | transitive via fastify, so the bare specifier does not resolve from this package under pnpm's isolated layout; pinning an absolute `.pnpm` path would break on the next version bump |
| a Fastify `onRequest` hook in the setup file | the suite builds its own app instances; a hook registered here would never be installed on them |
| pass a custom `Request` to `inject` | would have to be threaded through all 173 test files |
| `dangerouslyIgnoreUnhandledErrors` | forbidden by F01, and it would hide the *next* unhandled error too |
| patch or pin `@hono/node-server` | it is not our dependency to hold, and a resolution override on a transitive package is a maintenance liability far larger than the defect |

### The verification sequence is documented (Part C, AER-003)

`README.md` previously documented only `pnpm install && pnpm -r build` plus a one-line note that
tests need a `DATABASE_URL`. It now carries a pinned **clean-checkout verification** sequence:
`corepack enable` / `corepack prepare --activate`, `pnpm install --frozen-lockfile`, `pnpm -r
build`, repo-wide `pnpm -r exec tsc --noEmit`, and the suite against a database explicitly created
and dropped for the run — with the reason for each step, and an explicit instruction to read the
**exit code** rather than the "N passed" line.

**Two facts stated accurately, because an external review got them backwards.** This repo **does**
pin its package manager (`package.json` → `"packageManager": "pnpm@10.33.0"`) and CI **does**
install with `--frozen-lockfile` via `pnpm/action-setup@v4`, which reads exactly that field. The
reviewer's host ignored the pin; the repo did not lack one. The genuine gap was only that the
*local* path was undocumented, and `corepack enable` is the step that closes it.

## What this deliberately does NOT do

- **It does not touch production code.** No `src` file outside `src/testing/` changed; the shim
  cannot be reached at runtime, because nothing outside vitest's `setupFiles` imports it.
- **It does not make `MockSocket` a real socket.** It adds exactly two members — the two a real
  dependency calls. It does not add `write`, `end`, `destroy`, `setTimeout`, `pause`/`resume`,
  `address()`, or anything else. A future dependency that calls a third member will fail loudly at
  the same spot, which is the correct outcome: the mock will again be incomplete, and again we will
  know it.
- **It does not silence, catch, filter or ignore any error.** There is no error handling in the
  setup file at all, except the one `throw` that fires when the shim *cannot* be installed.
- **It does not change the drain behaviour.** `drainIncoming` still arms its timer and `forceClose`
  still runs; it now completes instead of throwing.
- **It does not fix the upstream guard.** See below.
- **It does not add a lint rule, CI check, or dependency-drift alarm** for this class of problem.
  One would be defensible; it is a separate decision, and the pinning test below is the cheap half
  of it.

## Honest limits

- **The upstream guard is weak, and we cannot fix it.** `@hono/node-server`'s `forceClose` tests
  `socket && !socket.destroyed` and then calls `socket.destroySoon()` without ever establishing
  that it is callable. A `typeof socket.destroySoon === "function"` conjunct — or a `try`/`catch`
  around a best-effort teardown — would make the whole class of failure impossible for every
  consumer. That is upstream's to write. Ours is a consumer-side completion of the mock, and it is
  strictly narrower: it fixes *our* mock, not *their* guard.
- **A dependency bump can reintroduce or change this.** `DRAIN_TIMEOUT_MS`, the guard, and the
  method called are all internal details of a package we do not declare and do not control; the
  MCP SDK could also switch transports entirely. `src/mock-socket-contract.test.ts` pins the two
  members and the exact expression `forceClose` evaluates, so a change that makes the shim
  *insufficient* is caught — but a change that calls some *third* socket member is not, and would
  surface as the same kind of unhandled error this ADR is about. The stack trace will name it.
- **The shim is installed by observing a prototype at setup time.** If `light-my-request` ever
  hands out something other than a `MockSocket`, or constructs sockets per request from a different
  class, the observation could bind to the wrong object. The pinning test asserts
  `socket.constructor.name === "MockSocket"` precisely so that this becomes a red test rather than
  a silent no-op.
- **One throwaway Fastify instance is created and injected per test file** (setup files run per
  file). Measured at single-digit milliseconds against a suite that runs for ~8 minutes; real, and
  not worth optimising away by trading it for a fragile deep import.
- **`destroySoon()` emits `close` synchronously**, where a real socket emits it on a later tick.
  Nothing in fastify or light-my-request listens for `close` on the request socket (fastify
  registers only a `timeout` listener), so this is unobservable today. It is a difference, and it
  is written down rather than assumed harmless forever.
- **This ADR makes the gate trustworthy; it does not make it complete.** Nothing here says the 2688
  assertions cover the right things. It says only that their verdict is now the whole verdict.
- **Three green runs is evidence, not proof, for an intermittent defect.** What raises it above
  three lucky runs is the deterministic in-vitest reproduction of the exact `TypeError` with the
  shim removed, and the pinning test that reddens on the same removal.

## Non-vacuity (M-002, measured)

Four separate controls were run. All four are the point; the green runs alone would not be.

**1 — The defect reproduces deterministically, in vitest, with the shim removed.** A throwaway
test drove `getRequestListener()` with an injected request carrying an unconsumed body and waited
past the 500 ms timer. With `setupFiles` neutralised the run produced, and failed on:

```
⎯ Uncaught Exception ⎯
TypeError: socket.destroySoon is not a function
 ❯ Timeout.forceClose  @hono/node-server/dist/index.mjs:390:14
 ❯ listOnTimeout       node:internal/timers:585:17
 ❯ processTimers       node:internal/timers:521:7
Test Files  1 failed (1) · Errors 1 error · exit 1
```

With `setupFiles` restored the same file passed **and asserted `socket.destroyed === true`** —
proving `forceClose` ran to completion rather than being skipped. The file was then deleted; the
committed `src/mock-socket-contract.test.ts` pins the same contract without the absolute
`node_modules` path such a probe requires.

**2 — The pinning test is not vacuous.** With the `setupFiles` line removed, 2 of its 3 cases go
red on the exact assertion (`expected 'undefined' to be 'function'`). The third — *does not touch
real `net.Socket`* — correctly stays **green**, because it asserts something the shim must never
change; a probe that reddened it would have meant the shim was reaching too far.

**3 — A deliberately failing assertion still fails the gate.** One assertion in a committed test
file was inverted; the run exited non-zero with that test named. Reverted exactly.

**4 — An unhandled error still fails the gate.** `setTimeout(() => { throw new Error("control") }, 0)`
was added inside one test file; the run exited non-zero, reported as an unhandled error, with every
test still passing. Reverted exactly. **This is the control that distinguishes a fix from a
suppression**: quiet was not achieved by making unhandled errors invisible.

Exit codes and the exact commands for all four, plus the three consecutive full-suite runs on
freshly created databases, are recorded in the session log for this change.
