/**
 * ADR-0334: verifying the signed policy and turning it into blocking rules. Pure (the clock and keys are inputs).
 *
 * A policy is used only when ALL hold: a compact JWS, `alg` EdDSA, `typ` regulait-browser-policy+jws, a `kid` naming
 * one of the keys the customer's browser management pinned, a valid Ed25519 signature, a body the shared schema
 * accepts, this device's id, not issued in the future beyond the skew, and not past `notAfter`. Anything else is no
 * policy, and no policy blocks every governed site. There is no last-known-good: an expired policy is no policy.
 */
import { compactVerify, decodeProtectedHeader, importJWK } from "jose";
import {
  BROWSER_POLICY_MAX_FUTURE_SKEW_SECONDS,
  BROWSER_POLICY_TYP,
  BROWSER_SITE_CATALOGUE,
  browserManagedConfigSchema,
  browserPolicySchema,
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

export async function verifyPolicy(
  jws: string,
  config: Pick<BrowserManagedConfig, "policyKeys">,
  deviceId: string,
  nowSeconds: number,
): Promise<{ ok: true; policy: BrowserPolicy } | { ok: false; code: PolicyRefusal }> {
  if (typeof jws !== "string" || jws.length > 65_536) return { ok: false, code: "malformed" };
  let kid: string;
  try {
    const h = decodeProtectedHeader(jws);
    if (h.alg !== "EdDSA" || h.typ !== BROWSER_POLICY_TYP || typeof h.kid !== "string" || h.jwk || h.jku || h.x5c || h.x5u || h.crit) {
      return { ok: false, code: "malformed" };
    }
    kid = h.kid;
  } catch {
    return { ok: false, code: "malformed" };
  }
  const pinned = config.policyKeys.find((k) => k.keyId === kid);
  if (!pinned) return { ok: false, code: "unknown_key" };
  let payload: Uint8Array;
  try {
    const key = await importJWK({ kty: "OKP", crv: "Ed25519", x: pinned.x }, "EdDSA");
    ({ payload } = await compactVerify(jws, key, { algorithms: ["EdDSA"] }));
  } catch {
    return { ok: false, code: "bad_signature" };
  }
  let parsed: ReturnType<typeof browserPolicySchema.safeParse>;
  try {
    parsed = browserPolicySchema.safeParse(JSON.parse(new TextDecoder().decode(payload)));
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
