/**
 * Tests only: a deterministic TOTP code window. Suites activate with the PREVIOUS step's code (`totpStep() - 1`) so
 * the current step stays free for a later verify (replay protection refuses any step at or before the last one used).
 * The server accepts its own step ±1, so a 30-second boundary passing between signing the code and the server
 * checking it moves its window past `totpStep() - 1` and the activation fails (zz-b4c-review-fixes, a 401 in CI).
 * Waiting until the current step has `headroomMs` left keeps signing, activation and the later verify in one step.
 */
import { TOTP_PERIOD_SECONDS } from "../totp.js";

export const TOTP_TEST_HEADROOM_MS = 5_000;

export async function awaitTotpHeadroom(headroomMs: number = TOTP_TEST_HEADROOM_MS): Promise<void> {
  const periodMs = TOTP_PERIOD_SECONDS * 1000;
  const left = periodMs - (Date.now() % periodMs);
  if (left < headroomMs) await new Promise((r) => setTimeout(r, left + 50));
}
