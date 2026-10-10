/**
 * ADR-0187 B5-E — THE ONE DETECTION-SCRUB INTERFACE for engine output.
 *
 * Every string an engine hands us (item keys, taxonomy ids, reasons) passes
 * through `engineDetectionScrub` before it is normalised, stored, or copied
 * into the red-team and eval ledgers. One interface, so the scrub cannot be
 * applied on one path and forgotten on another (M-035), and so the vendored
 * detection content plugs in at one place.
 *
 * DEFAULT IMPLEMENTATION: the scrub already on `main` — ADR-0099's
 * `scrubAuditText` (the audit-row credential scrub, the same detector the
 * ADR-0102 prose scrub and the ADR-0115 eval-result presentation use). It
 * already consults the vendored `pipelock-secrets` spans
 * (`detection-content/match.ts`), whose rule table is empty until Codex's X23
 * (ADR-0186 V) lands; when it lands, its rules apply here with no change to this
 * file. A different scrub (a stricter vendored ruleset) replaces it through
 * `setEngineDetectionScrub` at boot, never per request.
 *
 * FAIL CLOSED: the normaliser calls the scrub per string and treats a throw as
 * "this item's text cannot be cleared": the item is stored as `unknown` with
 * its text withheld, never passed through (normalise.ts `safeScrub`).
 */
import { scrubAuditText, type EngineTextScrub } from "@regulait/shared";

let current: EngineTextScrub = scrubAuditText;

/** the scrub every engine string passes through */
export function engineDetectionScrub(text: string): string {
  return current(text);
}

/** replace the scrub (boot-time wiring of a vendored ruleset; tests) — returns the previous one */
export function setEngineDetectionScrub(scrub: EngineTextScrub): EngineTextScrub {
  const prev = current;
  current = scrub;
  return prev;
}
