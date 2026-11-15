/**
 * The generic webhook contract's signature, in ONE place for both directions
 * (ADR-0010 amendment; S-03 follow-up (a)):
 *
 *   x-regulait-timestamp: <unix seconds>
 *   x-regulait-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
 *
 * Inbound (a customer bridge -> RegulAIt) is verified with it in `inbound.ts`;
 * outbound (RegulAIt -> a customer receiver) is signed with it in
 * `GenericWebhookProvider`, so a receiver applies the same replay window
 * RegulAIt applies (PM_WEBHOOK_REPLAY_WINDOW_SECONDS, 300 s).
 *
 * No dependencies on purpose: both the adapter module and the inbound module
 * import it without adding an edge to their existing cycle.
 */
import { createHmac } from "node:crypto";

/** generic contract headers: unix seconds, and `sha256=<hex HMAC of "<ts>.<raw body>">` */
export const GENERIC_TIMESTAMP_HEADER = "x-regulait-timestamp";
export const GENERIC_SIGNATURE_HEADER = "x-regulait-signature";

/** `sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">` under the shared secret. */
export const genericSignature = (secret: string, timestamp: string, rawBody: string): string =>
  `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;

/** The two headers that sign one delivery of `rawBody` at `nowSeconds`. */
export function signGenericWebhook(
  secret: string,
  rawBody: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const timestamp = String(nowSeconds);
  return {
    [GENERIC_TIMESTAMP_HEADER]: timestamp,
    [GENERIC_SIGNATURE_HEADER]: genericSignature(secret, timestamp, rawBody),
  };
}
