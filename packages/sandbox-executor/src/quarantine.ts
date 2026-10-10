/**
 * ADR-0190 decision 6 — QUARANTINE on the executor's side. The gateway
 * quarantines an executor (a per-placement report that disagreed with the
 * placement, a failed self-test an admin escalated, or an admin's own
 * decision) and withdraws its classes; the executor's part is to STOP: every
 * sandbox it runs is killed at once, no offer is taken, and the stream is
 * kept only to hear the admin's re-enable (which goes back through a full
 * self-test before any work).
 */
import type { ExecutorQuarantineCode } from "@regulait/shared";
import type { SandboxHandle } from "./backend.js";

export class Quarantine {
  private code: ExecutorQuarantineCode | null = null;
  constructor(private readonly log?: (m: string) => void) {}

  get active(): boolean {
    return this.code !== null;
  }
  get reason(): ExecutorQuarantineCode | null {
    return this.code;
  }

  /** enter quarantine: kill every running sandbox (each failure logged, none skipped) */
  async enter(code: ExecutorQuarantineCode, sandboxes: Iterable<[string, SandboxHandle]>): Promise<void> {
    this.code = code;
    for (const [offerId, h] of sandboxes) {
      try {
        await h.kill();
        this.log?.(`quarantine (${code}): killed sandbox ${h.id} of offer ${offerId}`);
      } catch (e) {
        this.log?.(`quarantine (${code}): sandbox ${h.id} of offer ${offerId} could not be killed: ${(e as Error).message}`);
      }
    }
  }

  /** an admin re-enabled the executor (a fresh self-test follows before any offer is taken) */
  clear(): void {
    this.code = null;
  }
}
