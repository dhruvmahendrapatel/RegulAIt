/**
 * ADR-0190 I4 follow-up — stdio sessions on a multi-replica gateway (the frames table, migration 0204), without a
 * database:
 *
 *  - THE ROUTING RULE (`stdioRouteDecision`), every branch: a window or a stdout POST is served only for this
 *    executor's placed offer whose row is live and whose holder's lease is current. A lapsed lease, or no row for an
 *    offer older than one lease, is `session_lost` (recorded; final for the executor). A young offer's window waits
 *    (`stdio_session_pending`, not final); a stdout POST never waits (it can only follow a `start`). An ended row is
 *    `offer_unavailable`.
 *  - THE SEALED START LINE: it opens only for its own offer (the offer id is the associated data), never after a
 *    byte is altered, and never under another replica's root (a replica without the shared data key cannot open it,
 *    so it cannot hand the sandbox a workload or an engine task's secret).
 *  - THE SEALED FRAMES (review finding 3, ADR-0180): a stored frame opens only for its own offer, direction and
 *    place in the order (all three are the associated data), never after a byte is altered, and never under another
 *    root (no shared data key: fail closed); the stored text never carries the frame in the clear.
 *  - A RAW NUL in a stdout frame (review finding 2) is refused by the POST body schema (`invalid_body`), never a 500.
 *  - THE VOCABULARY: both new refusals are in the fixed list, and the lost-session text the holder fails its call
 *    with is the one the routes record.
 * The database half (ownership, leases, loss, isolation between sessions and executors, retention, the 0185 guards)
 * is `zz-adr0190-i4-stdio-relay.test.ts`.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EXECUTOR_STDIO_REFUSALS, executorStdioPostSchema, stdioFrameMacValid, stdioMacKey, type ExecutorStdioMessage } from "@regulait/shared";
import { openStdioStart, sealStdioStart, setStdioMacRoot, StdioSession, stdioSecretFor } from "./executor-stdio.js";
import {
  STDIO_OWNER_HEARTBEAT_MS,
  STDIO_OWNER_LEASE_MS,
  STDIO_RELAY_LOST_CODES,
  openStdioFrame,
  sealStdioFrame,
  stdioRouteDecision,
  type StdioRouteState,
} from "./stdio-relay.js";

const live = { ended: false, leaseLive: true };

describe("ADR-0190 I4 multi-replica: the routing rule", () => {
  const cases: Array<[string, StdioRouteState, boolean, ReturnType<typeof stdioRouteDecision>]> = [
    ["a live row on a placed offer is served (window)", { offerPlaced: true, offerYoung: false, row: live }, true, { kind: "serve" }],
    ["a live row on a placed offer is served (stdout)", { offerPlaced: true, offerYoung: true, row: live }, false, { kind: "serve" }],
    [
      "not this executor's offer, or not placed: offer_unavailable, nothing recorded",
      { offerPlaced: false, offerYoung: true, row: live },
      true,
      { kind: "refuse", code: "offer_unavailable", record: false, endLease: false },
    ],
    [
      "an ended row: offer_unavailable (the session is over)",
      { offerPlaced: true, offerYoung: false, row: { ended: true, leaseLive: false } },
      true,
      { kind: "refuse", code: "offer_unavailable", record: false, endLease: false },
    ],
    [
      "a lapsed lease: session_lost, the row ended and the loss recorded",
      { offerPlaced: true, offerYoung: false, row: { ended: false, leaseLive: false } },
      true,
      { kind: "refuse", code: "session_lost", record: true, endLease: true },
    ],
    [
      "a lapsed lease on a stdout POST: the same",
      { offerPlaced: true, offerYoung: true, row: { ended: false, leaseLive: false } },
      false,
      { kind: "refuse", code: "session_lost", record: true, endLease: true },
    ],
    [
      "no row yet for a young offer: the window comes back (pending, not final, nothing recorded)",
      { offerPlaced: true, offerYoung: true, row: null },
      true,
      { kind: "refuse", code: "stdio_session_pending", record: false, endLease: false },
    ],
    [
      "no row for an offer older than a lease: its holder is gone, session_lost, recorded",
      { offerPlaced: true, offerYoung: false, row: null },
      true,
      { kind: "refuse", code: "session_lost", record: true, endLease: false },
    ],
    [
      "no row on a stdout POST never waits, even for a young offer",
      { offerPlaced: true, offerYoung: true, row: null },
      false,
      { kind: "refuse", code: "session_lost", record: true, endLease: false },
    ],
  ];
  it.each(cases)("%s", (_name, state, allowPending, want) => {
    expect(stdioRouteDecision(state, allowPending)).toEqual(want);
  });

  it("every refusal code the rule answers is in the fixed vocabulary; only the lease, buffer and seal ends are losses", () => {
    for (const [, state, allowPending] of cases) {
      const d = stdioRouteDecision(state, allowPending);
      if (d.kind === "refuse") expect(EXECUTOR_STDIO_REFUSALS).toContain(d.code);
    }
    expect([...STDIO_RELAY_LOST_CODES].sort()).toEqual(["buffer_full", "lease_expired", "unsealed"]);
  });

  it("the holder renews at least twice within one lease, so one missed beat is never a loss", () => {
    expect(STDIO_OWNER_LEASE_MS / STDIO_OWNER_HEARTBEAT_MS).toBeGreaterThanOrEqual(3);
  });
});

describe("ADR-0190 I4 multi-replica: the sealed start line", () => {
  const WORKLOAD = { command: "/srv/mcp/server.js", args: ["--root", "/work"] };

  it("opens for its own offer, under the same root, and still verifies under the executor's key", () => {
    const s = new StdioSession(randomUUID(), randomUUID(), WORKLOAD);
    const sealed = sealStdioStart(s.offerId, s.startLine());
    const opened = openStdioStart(s.offerId, sealed);
    expect(opened).toEqual(s.startLine());
    expect(stdioFrameMacValid(stdioMacKey(stdioSecretFor(s.offerId), s.offerId), s.offerId, opened!)).toBe(true);
    // the sealed text does not carry the workload in the clear
    expect(sealed).not.toContain("/srv/mcp/server.js");
  });

  it("an engine task's secret is sealed too, and opens only with its line", () => {
    const s = new StdioSession(randomUUID(), randomUUID(), WORKLOAD);
    s.secret = randomBytes(24).toString("base64url");
    const sealed = sealStdioStart(s.offerId, s.startLine());
    expect(sealed).not.toContain(s.secret);
    expect(openStdioStart(s.offerId, sealed)).toMatchObject({ type: "start", secret: s.secret });
  });

  it("never opens for another offer, after an altered byte, or as a non-start line", () => {
    const s = new StdioSession(randomUUID(), randomUUID(), WORKLOAD);
    const sealed = sealStdioStart(s.offerId, s.startLine());
    expect(openStdioStart(randomUUID(), sealed)).toBeNull();
    const [iv, tag, ct] = sealed.split(".");
    const flipped = Buffer.from(ct!, "base64url");
    flipped[0] = flipped[0]! ^ 1;
    expect(openStdioStart(s.offerId, [iv, tag, flipped.toString("base64url")].join("."))).toBeNull();
    expect(openStdioStart(s.offerId, "not.a.seal")).toBeNull();
    expect(openStdioStart(s.offerId, "")).toBeNull();
    const keepalive = sealStdioStart(s.offerId, { type: "keepalive" } as ExecutorStdioMessage);
    expect(openStdioStart(s.offerId, keepalive)).toBeNull();
  });

  it("a replica with another root (no shared data key) cannot open it: the window is refused, never served", () => {
    const s = new StdioSession(randomUUID(), randomUUID(), WORKLOAD);
    const sealed = sealStdioStart(s.offerId, s.startLine());
    // what another replica with a different data key derives (set after sealing: this process now plays that replica)
    setStdioMacRoot(randomBytes(32).toString("hex"));
    expect(openStdioStart(s.offerId, sealed)).toBeNull();
    // and its MAC would not verify either: the two fail together
    const other = new StdioSession(s.offerId, s.executorId, WORKLOAD);
    expect(other.macKey.equals(s.macKey)).toBe(false);
  });
});

describe("ADR-0190 I4 multi-replica: frames are sealed at rest (review finding 3)", () => {
  const key = randomBytes(32);
  const offerId = randomUUID();
  const line = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"lookup","arguments":{"email":"user@example.org"}}}';

  it("opens for its own offer, direction and sequence number; the stored text is not the frame", () => {
    const sealed = sealStdioFrame(offerId, "in", 3, line, key);
    expect(openStdioFrame(offerId, "in", 3, sealed, key)).toBe(line);
    expect(sealed).not.toContain("user@example.org");
    expect(sealed).toMatch(/^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/);
    // the table's CHECK: the stored length follows from the plaintext size exactly
    const bytes = Buffer.byteLength(line, "utf8");
    expect(sealed.length).toBe(40 + Math.floor((bytes * 4 + 2) / 3));
    // a fresh iv every time: two seals of one frame differ
    expect(sealStdioFrame(offerId, "in", 3, line, key)).not.toBe(sealed);
  });

  it("never opens moved: another offer, the other direction, or another place in the order (reordered)", () => {
    const first = sealStdioFrame(offerId, "out", 0, '"first"', key);
    const second = sealStdioFrame(offerId, "out", 1, '"second"', key);
    expect(openStdioFrame(randomUUID(), "out", 0, first, key)).toBeNull();
    expect(openStdioFrame(offerId, "in", 0, first, key)).toBeNull();
    // swapped at rest: neither opens in the other's place
    expect(openStdioFrame(offerId, "out", 0, second, key)).toBeNull();
    expect(openStdioFrame(offerId, "out", 1, first, key)).toBeNull();
  });

  it("never opens altered, malformed, or under another root (no shared data key: fail closed)", () => {
    const sealed = sealStdioFrame(offerId, "in", 0, line, key);
    const [iv, tag, ct] = sealed.split(".");
    for (const part of [0, 1, 2]) {
      const pieces = [iv!, tag!, ct!].map((p) => Buffer.from(p, "base64url"));
      pieces[part]![0] = pieces[part]![0]! ^ 1;
      expect(openStdioFrame(offerId, "in", 0, pieces.map((b) => b.toString("base64url")).join("."), key)).toBeNull();
    }
    expect(openStdioFrame(offerId, "in", 0, `${sealed}.x`, key)).toBeNull();
    expect(openStdioFrame(offerId, "in", 0, "not.a.seal", key)).toBeNull();
    expect(openStdioFrame(offerId, "in", 0, line, key)).toBeNull();
    expect(openStdioFrame(offerId, "in", 0, sealed, randomBytes(32))).toBeNull();
  });
});

describe("ADR-0190 I4 multi-replica: a raw NUL in stdout (review finding 2)", () => {
  it("is refused by the POST body (the route answers invalid_body), never stored or a server error", () => {
    // JSON's own escape (six characters, no NUL byte) is a valid line
    expect(executorStdioPostSchema.safeParse({ frames: [{ seq: 0, data: '{"jsonrpc":"2.0","id":1,"result":"a\\u0000b"}' }] }).success).toBe(true);
    expect(executorStdioPostSchema.safeParse({ frames: [{ seq: 0, data: "{\"jsonrpc\":\"2.0\"}\u0000" }] }).success).toBe(false);
    expect(executorStdioPostSchema.safeParse({ frames: [{ seq: 0, data: "\u0000" }] }).success).toBe(false);
  });
});
