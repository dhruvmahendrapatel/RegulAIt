/**
 * ADR-0334 (lane E16): the gateway side of the managed browser extension, PURE PART (no database, no routes).
 *
 *  - Device authentication is NOT here: an extension is a workload identity of kind `browser_extension` and reaches
 *    the gateway with an S7 DPoP-bound self token (oauth/), the endpoint agent's pattern (ADR-0195 SD4b).
 *  - `buildBrowserPolicy`: the per-user decision for each catalogue site, deterministic, fail closed. The order is the
 *    governed core's (ADR-0251): an unknown or disabled person gets nothing; the execution posture (the kernel's
 *    `executionGate`, the same kill switch every governed call obeys) can only remove access; then the admin's site
 *    rule, where no rule means deny. Account domains are carried for the extension to check against the profile.
 *  - `signBrowserPolicy`: the endpoint agent's signed-policy envelope (ADR-0298) under the browser policy key, a key
 *    of its own (ADR-0195: separate signing keys per purpose), operator-managed or install-generated.
 *
 * No model is called anywhere here: every permission and governance decision is a data check.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import { executionGate, type ExecutionPosture } from "@regulait/policy-kernel";
import {
  BROWSER_DLP_RULE_IDS,
  BROWSER_POLICY_SCHEMA,
  BROWSER_POLICY_TTL_SECONDS,
  BROWSER_SITE_CATALOGUE,
  browserPolicySchema,
  type BrowserDenyReason,
  DEVICE_POLICY_KEY_ID_RE,
  type BrowserPolicy,
  type DevicePolicyEnvelope,
  type BrowserPolicyMode,
  type BrowserPolicySite,
  type BrowserSiteId,
} from "@regulait/shared";
import { ensureInstallKeyFile, INSTALL_SECRETS_DIR_ENV, loadInstallKeyFile } from "./receipt-signing-key.js";

// ---------------------------------------------------------------------------
// Keyed references
// ---------------------------------------------------------------------------

/**
 * The conversation a governed page belongs to, as a keyed hash of the site and its path (no query, no fragment).
 * The path itself is never stored. `key` is the deployment's pseudonym key (ADR-0195 decision 20).
 */
export function conversationRef(key: Buffer, siteId: string, sitePath: string): string {
  return `cnv:${createHmac("sha256", key).update(`browser-conversation\u0000${siteId}\u0000${sitePath}`).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export interface SiteRuleInput {
  siteId: string;
  decision: "allow" | "deny";
  accountDomains: readonly string[];
}

export interface BuildPolicyInput {
  deviceId: string;
  subject: string;
  profileEmail: string;
  mode: BrowserPolicyMode;
  promptCaptureEnabled: boolean;
  /** the org user the profile account matched, and whether they may act at all */
  user: { id: string; disabled: boolean } | null;
  /** the deployment's execution posture (the governed core's kill switch) */
  posture: ExecutionPosture;
  rules: readonly SiteRuleInput[];
  nowSeconds: number;
}

/** The per-user policy. Every catalogue site appears once; anything not explicitly allowed is a deny with its reason. */
export function buildBrowserPolicy(input: BuildPolicyInput): BrowserPolicy {
  const userDeny: BrowserDenyReason | null = !input.user || input.user.disabled ? "user_unknown" : null;
  // a prompt to an AI site sends data out: a write for the read-only dial, and no per-call approval queue exists here
  const stop = executionGate(input.posture, true, "an AI assistant site in the browser", false);
  const postureDeny: BrowserDenyReason | null = stop && stop.effect !== "allow" ? "execution_posture" : null;
  const sites: BrowserPolicySite[] = BROWSER_SITE_CATALOGUE.map((site) => {
    const rule = input.rules.find((r) => r.siteId === site.siteId);
    const denyReason: BrowserDenyReason | null = userDeny ?? postureDeny ?? (!rule ? "no_site_rule" : rule.decision === "deny" ? "site_denied" : null);
    return {
      siteId: site.siteId as BrowserSiteId,
      decision: denyReason ? "deny" : "allow",
      denyReason,
      accountDomains: denyReason ? [] : [...(rule?.accountDomains ?? [])].sort(),
    };
  });
  const policy: BrowserPolicy = {
    schema: BROWSER_POLICY_SCHEMA,
    deviceId: input.deviceId,
    subject: input.subject,
    profileEmail: input.profileEmail,
    mode: input.mode,
    issuedAt: input.nowSeconds,
    notAfter: input.nowSeconds + BROWSER_POLICY_TTL_SECONDS,
    sites,
    // every shared credential rule is on; turning one off is a later, audited relaxation (ADR-0334 follow-ups)
    dlp: { ruleIds: [...BROWSER_DLP_RULE_IDS] },
    promptCapture: { enabled: input.promptCaptureEnabled },
  };
  // the same schema the extension parses: a policy the extension would refuse is never signed
  return browserPolicySchema.parse(policy);
}

// ---------------------------------------------------------------------------
// The browser policy signing key
// ---------------------------------------------------------------------------

export const BROWSER_POLICY_KEY_FILE_ENV = "REGULAIT_BROWSER_POLICY_SIGNING_KEY";
export const BROWSER_POLICY_KEY_ID_ENV = "REGULAIT_BROWSER_POLICY_SIGNING_KEY_ID";
export const INSTALL_BROWSER_POLICY_KEY_FILE = "browser-policy-signing-key.pem";
/** `.browser-policy-signing-key.pem.<pid>.<12 hex>.tmp`, a literal like the other install keys' (CodeQL) */
const BROWSER_POLICY_TMP_RE = /^\.browser-policy-signing-key\.pem\.\d+\.[0-9a-f]{12}\.tmp$/;
const MAX_KEY_BYTES = 16384;

export interface BrowserPolicyKey {
  keyId: string;
  privateKey: KeyObject;
  /** the public key as the extension's managed storage pins it */
  x: string;
  source: "operator_managed" | "install_generated";
}

function installKeyId(x: string): string {
  return `browser-ed25519-${createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex").slice(0, 24)}`;
}

function parsePem(pem: Buffer): { privateKey: KeyObject; x: string } | null {
  if (pem.length > MAX_KEY_BYTES || !pem.toString("utf8").startsWith("-----BEGIN PRIVATE KEY-----")) return null;
  try {
    const privateKey = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
    if (privateKey.asymmetricKeyType !== "ed25519") return null;
    const pub = createPublicKey(privateKey).export({ format: "jwk" });
    return pub.x && !pub.d ? { privateKey, x: pub.x } : null;
  } catch {
    return null;
  }
}

/**
 * The key, or why there is none. Operator variables win (both must be set and valid; one alone is `invalid`). Else
 * the install-generated key under REGULAIT_INSTALL_SECRETS_DIR, created on first use when `create` is set (the
 * enable route), read strictly by the shared install-key reader. No key means no policy: the extension stays closed.
 */
export function resolveBrowserPolicyKey(
  env: NodeJS.ProcessEnv = process.env,
  opts: { create?: boolean } = {},
): { state: "ok"; key: BrowserPolicyKey } | { state: "missing" | "invalid" } {
  const file = env[BROWSER_POLICY_KEY_FILE_ENV]?.trim();
  const keyId = env[BROWSER_POLICY_KEY_ID_ENV]?.trim();
  if (file || keyId) {
    if (!file || !keyId || !DEVICE_POLICY_KEY_ID_RE.test(keyId)) return { state: "invalid" };
    try {
      if (!statSync(file).isFile()) return { state: "invalid" };
      const parsed = parsePem(readFileSync(file));
      return parsed ? { state: "ok", key: { keyId, ...parsed, source: "operator_managed" } } : { state: "invalid" };
    } catch {
      return { state: "invalid" };
    }
  }
  const dir = env[INSTALL_SECRETS_DIR_ENV]?.trim();
  if (!dir) return { state: "missing" };
  const keyFile = path.join(path.resolve(dir), INSTALL_BROWSER_POLICY_KEY_FILE);
  try {
    if (opts.create) {
      const made = ensureInstallKeyFile(keyFile, BROWSER_POLICY_TMP_RE);
      if (made.outcome === "failed") return { state: "invalid" };
    }
    const loaded = loadInstallKeyFile(keyFile);
    if (!loaded) return { state: "missing" };
    return { state: "ok", key: { keyId: installKeyId(loaded.jwk.x), privateKey: loaded.privateKey, x: loaded.jwk.x, source: "install_generated" } };
  } catch {
    return { state: "invalid" };
  }
}

/** sign a policy into the endpoint agent's envelope (ADR-0298): Ed25519 over the exact payload bytes (Node's crypto) */
export function signBrowserPolicy(policy: BrowserPolicy, key: BrowserPolicyKey): DevicePolicyEnvelope {
  const payload = Buffer.from(JSON.stringify(policy), "utf8");
  return { keyId: key.keyId, payload: payload.toString("base64"), signature: sign(null, payload, key.privateKey).toString("base64") };
}
