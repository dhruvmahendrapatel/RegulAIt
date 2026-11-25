/**
 * ADR-0334: verifying the signed policy and turning it into blocking rules. Pure (the clock and keys are inputs).
 *
 * A policy is used only when ALL hold: the endpoint agent's envelope (ADR-0298) with a `keyId` naming one of the keys
 * the customer's browser management pinned, a valid Ed25519 signature over the payload bytes, a body the shared schema
 * accepts, this device's id, not issued in the future beyond the skew, and not past `notAfter`. Anything else is no
 * policy, and no policy blocks every governed site. There is no last-known-good: an expired policy is no policy.
 */
import { base64url } from "jose";
import {
  BROWSER_POLICY_MAX_FUTURE_SKEW_SECONDS,
  BROWSER_SITE_CATALOGUE,
  browserManagedConfigSchema,
  browserPolicySchema,
  devicePolicyEnvelopeSchema,
  siteVerdict,
  type BrowserCatalogueSite,
  type BrowserManagedConfig,
  type BrowserPolicy,
} from "@regulait/shared/browser-governance";
import { blockRule, DYNAMIC_RULE_ID_BASE } from "./manifest.js";

export type PolicyRefusal = "malformed" | "unknown_key" | "bad_signature" | "bad_body" | "wrong_device" | "not_yet_valid" | "expired";

/** the managed configuration, or null when it is absent or anything in it is malformed (then nothing is fetched) */
export function parseManagedConfig(raw: unknown): BrowserManagedConfig | null {
  const r = browserManagedConfigSchema.safeParse(raw);
  return r.success ? r.data : null;
}

function b64ToBytes(b64: string, url = false): Uint8Array<ArrayBuffer> | null {
  try {
    if (url) return new Uint8Array(base64url.decode(b64));
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Verify the endpoint agent's signed-policy envelope (ADR-0298): a strict `{keyId, payload, signature}`, a key id
 * pinned in managed storage, and an Ed25519 signature (WebCrypto) over exactly the payload bytes. Then the payload must
 * be a browser policy the shared schema accepts, for this device, current by `nowSeconds`.
 */
export async function verifyPolicy(
  envelope: unknown,
  config: Pick<BrowserManagedConfig, "policyKeys">,
  deviceId: string,
  nowSeconds: number,
): Promise<{ ok: true; policy: BrowserPolicy } | { ok: false; code: PolicyRefusal }> {
  const env = devicePolicyEnvelopeSchema.safeParse(envelope);
  if (!env.success) return { ok: false, code: "malformed" };
  const pinned = config.policyKeys.find((k) => k.keyId === env.data.keyId);
  if (!pinned) return { ok: false, code: "unknown_key" };
  const payload = b64ToBytes(env.data.payload);
  const signature = b64ToBytes(env.data.signature);
  const raw = b64ToBytes(pinned.x, true);
  if (!payload || !signature || !raw || raw.length !== 32 || signature.length !== 64) return { ok: false, code: "malformed" };
  let valid = false;
  try {
    const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, payload);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, code: "bad_signature" };
  let parsed: ReturnType<typeof browserPolicySchema.safeParse>;
  try {
    parsed = browserPolicySchema.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
  } catch {
    return { ok: false, code: "bad_body" };
  }
  if (!parsed.success) return { ok: false, code: "bad_body" };
  const policy = parsed.data;
  if (policy.deviceId !== deviceId) return { ok: false, code: "wrong_device" };
  if (policy.issuedAt - BROWSER_POLICY_MAX_FUTURE_SKEW_SECONDS > nowSeconds) return { ok: false, code: "not_yet_valid" };
  if (nowSeconds >= policy.notAfter) return { ok: false, code: "expired" };
  return { ok: true, policy };
}

/**
 * The dynamic redirect rules for a policy and the profile account signed in now: one per catalogue site that the
 * policy blocks. In `audit` mode nothing is blocked (the content script records `would_block` instead), but a site the
 * policy does not cover still is, because audit mode is a decision the signed policy made and it made none for it.
 */
export function dynamicRulesFor(
  policy: BrowserPolicy,
  profileEmail: string,
  nowSeconds: number,
  sites: readonly BrowserCatalogueSite[] = BROWSER_SITE_CATALOGUE,
): chrome.declarativeNetRequest.Rule[] {
  const rules: chrome.declarativeNetRequest.Rule[] = [];
  sites.forEach((site, i) => {
    const v = siteVerdict(policy, site.siteId, profileEmail, nowSeconds);
    if (v.effect === "allow") return;
    if (policy.mode === "audit" && v.code !== "no_valid_policy" && v.code !== "site_not_in_policy") return;
    rules.push(blockRule(DYNAMIC_RULE_ID_BASE + i, site, v.code));
  });
  return rules;
}
