import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Every test file shares one Postgres database; parallel workers would
    // race on migrations and seed data.
    fileParallelism: false,

    // ADR-0106: completes light-my-request's MockSocket against the part of the
    // net.Socket contract @hono/node-server's drainIncoming() actually calls, so
    // a 500ms drain timer can no longer throw an unhandled TypeError from the
    // timer queue and turn an all-green run into a non-zero exit. Read that file
    // first — it carries the whole causal chain.
    setupFiles: ["./src/testing/mock-socket-contract.ts"],

    // Vitest's default is 5s. Nearly every test here is a real HTTP round trip
    // against a real Postgres — build an app, run a migration-checked schema,
    // insert fixtures, assert — and the whole suite runs SEQUENTIALLY because
    // of fileParallelism above. Under load (a second suite on the same box, a
    // cold page cache, a busy CI runner) a normally-sub-second e2e test can
    // drift past 5s and fail for no reason but timing: session-ip-policy.test.ts
    // did exactly that on one run of a two-run verification and passed on the
    // other, on identical code.
    //
    // 20s is deliberately not "no timeout": a genuinely hung request, a
    // deadlock, or a promise that never settles still fails the suite. It just
    // stops the clock being the assertion. Individual tests that legitimately
    // need longer still set their own.
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      // ADR-0031 item 4: the HTTP rate limiter is ON by default in a real
      // deployment (see rate-limit.ts). The suite drives thousands of requests
      // from one address in seconds — auth.test.ts alone deliberately fails
      // login dozens of times to exercise the ADR-0025 lockout — so it is
      // switched OFF here rather than having every future test file quietly
      // depend on staying under a limit. rate-limit.test.ts builds its own app
      // with the limiter explicitly ON, and asserts that the *default* config
      // (with an empty environment) is enabled, so the shipping posture is
      // still covered.
      REGULAIT_RATE_LIMIT: "off",
      // ADR-0181: the scheduler is ON by default in a real deployment. The
      // suite sets it off EXPLICITLY (on top of the under-test guard in
      // scheduler.ts): no test may run underneath a tick loop. Tests that need
      // the loop construct a Scheduler directly; scheduler.test.ts asserts the
      // empty-environment default is on.
      REGULAIT_SCHEDULER: "off",
      // REGULAIT_DATABASE_SSL is deliberately NOT set here: its default is
      // `require`, and the environment that points the suite at a Postgres
      // without TLS (CI, the local gate) says `disable` itself.
    },
  },
});
