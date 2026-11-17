/**
 * ADR-0352 (lane E33 slice 3): incremental output inspection for streamed model
 * answers, extending ADR-0042/0137.
 *
 * Before this, any output-phase block policy (a guardrail at `block`, or the PII
 * mode at `block`) buffered the WHOLE completion and flushed it once scanned. In the
 * opt-in `incremental` mode the stream is released in pieces instead, under one rule
 * that does not change: no character reaches the client before a scan that covered it
 * has passed.
 *
 * How. Deltas accumulate. Whenever at least `step` characters wait beyond a hold-back
 * of `hold` characters, the window
 *
 *     acc[released - hold, acc.length)
 *
 * is scanned with the same detectors the final scan uses. If it passes, everything up
 * to `acc.length - hold` is released. A finding no longer than `hold` that touches the
 * released range lies wholly inside some scanned window: the window reaches `hold`
 * back into already released text and `hold` past the new release point. On a block
 * the releaser stops for good; nothing more is emitted, and the caller ends the stream
 * with an explicit error event.
 *
 * The authoritative full-result scan still runs when the provider finishes (it also
 * covers thinking and tool-call arguments), and the held-back tail is only released
 * after it passes. What incremental mode gives up is stated in ADR-0352: a detector
 * that judges the whole text (a classifier score, a span longer than `hold`) can block
 * at the end after earlier pieces were released; the client then receives the error
 * event and must discard what it showed. That is why the mode is off by default.
 */

/** Longest finding the window rule covers (PII patterns, keyword hits). */
export const STREAM_HOLD_BACK_CHARS = 256;
/** How much new text a scan waits for (bounds scans to about length / step). */
export const STREAM_SCAN_STEP_CHARS = 512;

export type WindowScan = (window: string) => Promise<{ block: false } | { block: true; reason: "guardrail" | "pii" }>;

export interface ReleaserStats {
  scans: number;
  /** wall time spent inside scans, ms */
  scanMs: number;
  released: number;
}

export class IncrementalStreamReleaser {
  private acc = "";
  private released = 0;
  private chain: Promise<void> = Promise.resolve();
  private scanning = false;
  private failure: unknown = null;
  violation: "guardrail" | "pii" | null = null;
  readonly stats: ReleaserStats = { scans: 0, scanMs: 0, released: 0 };

  constructor(
    private readonly emit: (delta: string) => void,
    private readonly scan: WindowScan,
    private readonly hold = STREAM_HOLD_BACK_CHARS,
    private readonly step = STREAM_SCAN_STEP_CHARS,
    private readonly now: () => number = () => performance.now(),
  ) {}

  /** Called synchronously by the provider for every text delta. */
  push = (delta: string): void => {
    if (this.violation || this.failure !== null) return;
    this.acc += delta;
    if (!this.scanning && this.acc.length - this.hold - this.released >= this.step) this.schedule(this.acc.length - this.hold);
  };

  private schedule(target: number): void {
    this.scanning = true;
    this.chain = this.chain.then(async () => {
      try {
        await this.release(target);
      } catch (err) {
        // a scanner failure fails closed: nothing more is released
        this.failure = err;
      } finally {
        this.scanning = false;
      }
      // text that arrived during the scan may already be due for the next one
      if (!this.violation && this.failure === null && this.acc.length - this.hold - this.released >= this.step) {
        this.schedule(this.acc.length - this.hold);
      }
    });
  }

  private async release(target: number): Promise<void> {
    if (target <= this.released || this.violation) return;
    const window = this.acc.slice(Math.max(0, this.released - this.hold), Math.min(this.acc.length, target + this.hold));
    const t0 = this.now();
    const verdict = await this.scan(window);
    this.stats.scans += 1;
    this.stats.scanMs += this.now() - t0;
    if (verdict.block) {
      this.violation = verdict.reason;
      return;
    }
    const piece = this.acc.slice(this.released, target);
    this.released = target;
    this.stats.released = target;
    if (piece) this.emit(piece);
  }

  /** Wait for every scheduled scan; rethrows a scanner failure. */
  async settle(): Promise<void> {
    // a link may schedule the next one while it runs, so wait until the chain stops growing
    for (;;) {
      const current = this.chain;
      await current;
      if (current === this.chain) break;
    }
    if (this.failure !== null) throw this.failure;
  }

  /** After the authoritative full scan passed: release the held-back tail. */
  flushTail(): void {
    if (this.violation || this.failure !== null) return;
    const tail = this.acc.slice(this.released);
    this.released = this.acc.length;
    this.stats.released = this.released;
    if (tail) this.emit(tail);
  }

  /** Whether any text has reached the client. */
  get emittedAny(): boolean {
    return this.released > 0;
  }

  /** Everything the provider streamed (for the caller's consistency check). */
  get text(): string {
    return this.acc;
  }
}
