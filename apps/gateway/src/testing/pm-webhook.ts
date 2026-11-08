/**
 * S-03 test helper: a generic/mock inbound PM webhook delivery, signed the only way the gateway now accepts
 * (`x-regulait-timestamp` + `x-regulait-signature` over "<timestamp>.<raw body>"). Each call takes a distinct
 * timestamp inside the replay window, so two identical reports in one test are two deliveries, not a replay; a test
 * that means to replay sends the SAME injected request twice.
 */
import { signGenericInboundWebhook } from "@regulait/pm-provider";

let calls = 0;

export function genericInbound(secret: string, body: unknown): { headers: Record<string, string>; payload: string } {
  const payload = JSON.stringify(body);
  const nowSeconds = Math.floor(Date.now() / 1000) - 240 + (calls++ % 480);
  return { headers: { "content-type": "application/json", ...signGenericInboundWebhook(secret, payload, nowSeconds) }, payload };
}
