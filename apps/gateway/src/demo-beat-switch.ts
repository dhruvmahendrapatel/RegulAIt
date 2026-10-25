/**
 * LANE-L ADAPTER (ADR-0202 lane F) — TEMPORARY, REPLACE WHEN LANE L MERGES.
 *
 * Lane L owns the per-beat fallback switch (ADR-0202 decision 4) and exports a server-side `isBeatSimulated(beatId)`
 * from its branch `lane-l/live-demo-profile`. Lane F must not write that switch, so until L merges this adapter answers
 * "live" for every beat, which is the ADR's default (every beat is live; the switch is off until an admin turns it on).
 *
 * After L merges: merge origin/main, make this file re-export L's `isBeatSimulated`, and delete the body below. The
 * `demo:enforce` command is the only caller, so nothing else changes.
 */
export const ENFORCE_IT_BEAT_ID = "enforce-it";

export async function isBeatSimulated(_beatId: string): Promise<boolean> {
  return false;
}
