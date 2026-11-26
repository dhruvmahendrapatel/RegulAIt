/**
 * ADR-0352 slice 3: the incremental releaser's rule — no character reaches the client
 * before a scan that covered it passed — and its cost, measured with the real PII detector.
 */
import { describe, expect, it } from "vitest";
import { enforcePII } from "./projects.js";
import {
  IncrementalStreamReleaser,
  STREAM_HOLD_BACK_CHARS,
  STREAM_SCAN_STEP_CHARS,
  STREAM_SCAN_TIMEOUT_MS,
  StreamScanTimeoutError,
  type WindowScan,
} from "./stream-inspection.js";
import { TRAINED_TIMEOUT_MAX_MS } from "@regulait/shared";

const piiScan: WindowScan = async (w) =>
  enforcePII("block", { output: w }, []).action === "block" ? { block: true, reason: "pii" } : { block: false };

async function stream(text: string, scan: WindowScan, chunk = 40) {
  const out: string[] = [];
  const windows: string[] = [];
  const r = new IncrementalStreamReleaser((d) => out.push(d), async (w) => {
    windows.push(w);
    return scan(w);
  });
  let firstAt = -1;
  for (let i = 0; i < text.length; i += chunk) {
    r.push(text.slice(i, i + chunk));
    if (firstAt < 0 && out.length > 0) firstAt = i;
    // a real provider's deltas arrive on separate event-loop turns
    await new Promise((res) => setImmediate(res));
  }
  await r.settle();
  return { r, out, windows, firstAt };
}

const filler = Array.from({ length: 60 }, (_, i) => `Sentence ${i + 1} of a long, harmless answer. `).join("");

describe("ADR-0352 incremental stream release", () => {
  it("releases a clean answer in pieces, holding the tail until the final scan", async () => {
    const { r, out } = await stream(filler, piiScan);
    expect(out.length).toBeGreaterThan(1);
    expect(filler.startsWith(out.join(""))).toBe(true);
    expect(filler.length - out.join("").length).toBeGreaterThanOrEqual(STREAM_HOLD_BACK_CHARS);
    r.flushTail();
    expect(out.join("")).toBe(filler);
  });

  it("never emits a finding, wherever the chunk boundaries split it", async () => {
    const ssn = "123-45-6789";
    for (const chunk of [1, 3, 7, 40, 97]) {
      const text = `${filler}The id is ${ssn}. ${filler}`;
      const { r, out } = await stream(text, piiScan, chunk);
      expect(r.violation).toBe("pii");
      const sent = out.join("");
      expect(sent).not.toContain(ssn);
      // and not even a prefix that ends inside it
      expect(text.indexOf(ssn)).toBeGreaterThanOrEqual(sent.length);
      r.flushTail(); // a no-op after a violation
      expect(out.join("")).toBe(sent);
    }
  });

  it("covers every released character with a scanned window that reaches hold-back past it", async () => {
    const released: number[] = [];
    let total = 0;
    const r = new IncrementalStreamReleaser((d) => {
      total += d.length;
      released.push(total);
    }, async () => ({ block: false }));
    const windows: Array<[number, number]> = [];
    // instrument: reconstruct window bounds from the scan text positions
    const text = filler.repeat(3);
    const spy = new IncrementalStreamReleaser(() => {}, async (w) => {
      const start = text.indexOf(w);
      windows.push([start, start + w.length]);
      return { block: false };
    });
    for (let i = 0; i < text.length; i += 50) {
      r.push(text.slice(i, i + 50));
      spy.push(text.slice(i, i + 50));
    }
    await r.settle();
    await spy.settle();
    for (const end of released) {
      const w = windows.find(([, e]) => e >= Math.min(text.length, end + STREAM_HOLD_BACK_CHARS));
      expect(w, `release to ${end} must have been scanned past ${end + STREAM_HOLD_BACK_CHARS}`).toBeTruthy();
    }
  });

  it("a scanner failure fails closed", async () => {
    const r = new IncrementalStreamReleaser(() => {
      throw new Error("must not emit");
    }, async () => {
      throw new Error("scanner down");
    });
    r.push(filler);
    await expect(r.settle()).rejects.toThrow(/scanner down/);
    r.flushTail();
    expect(r.emittedAny).toBe(false);
  });

  it("a scan that never answers fails closed at the deadline, and nothing more is released", async () => {
    const out: string[] = [];
    const r = new IncrementalStreamReleaser(
      (d) => out.push(d),
      () => new Promise(() => {}),
      STREAM_HOLD_BACK_CHARS,
      STREAM_SCAN_STEP_CHARS,
      () => performance.now(),
      50,
    );
    r.push(filler);
    await expect(r.settle()).rejects.toBeInstanceOf(StreamScanTimeoutError);
    r.push(filler); // later deltas are ignored once failed
    r.flushTail();
    expect(out).toEqual([]);
    expect(r.emittedAny).toBe(false);
  });

  it("a failure after a released piece stops the stream: no unchecked text follows", async () => {
    const out: string[] = [];
    let calls = 0;
    const r = new IncrementalStreamReleaser(
      (d) => out.push(d),
      async () => {
        calls += 1;
        if (calls === 1) return { block: false };
        throw new Error("scanner down");
      },
    );
    const first = filler.slice(0, STREAM_HOLD_BACK_CHARS + STREAM_SCAN_STEP_CHARS);
    r.push(first);
    await new Promise((res) => setImmediate(res));
    r.push(filler.slice(first.length));
    await expect(r.settle()).rejects.toThrow(/scanner down/);
    r.flushTail();
    // only the first scanned piece left; the held-back tail and the rest never did
    expect(out.join("")).toBe(first.slice(0, first.length - STREAM_HOLD_BACK_CHARS));
  });

  it("the scan deadline sits above the longest trained-detector timeout", () => {
    expect(STREAM_SCAN_TIMEOUT_MS).toBeGreaterThan(TRAINED_TIMEOUT_MAX_MS);
  });

  it("measures the overhead against one whole-result scan (recorded in ADR-0352)", async () => {
    const text = filler.repeat(4); // about 11,000 characters
    const t0 = performance.now();
    for (let i = 0; i < 20; i += 1) await piiScan(text);
    const wholeMs = (performance.now() - t0) / 20;
    let scanMs = 0;
    let scans = 0;
    let firstAt = 0;
    for (let i = 0; i < 20; i += 1) {
      const res = await stream(text, piiScan);
      scanMs += res.r.stats.scanMs;
      scans += res.r.stats.scans;
      firstAt += res.firstAt;
    }
    const incrementalMs = scanMs / 20;
    // eslint-disable-next-line no-console
    console.log(
      `ADR-0352 stream inspection: ${text.length} chars, ${scans / 20} windowed scans, ` +
        `${incrementalMs.toFixed(3)} ms windowed vs ${wholeMs.toFixed(3)} ms one whole scan; ` +
        `first release after ${Math.round(firstAt / 20)} chars (buffer mode: after ${text.length})`,
    );
    // windows overlap by 2 x hold-back, so the scanned volume is bounded by about (step + 2 x hold) / step
    expect(scans / 20).toBeLessThanOrEqual(Math.ceil(text.length / 512) + 1);
    expect(incrementalMs).toBeLessThan(50);
  });
});
