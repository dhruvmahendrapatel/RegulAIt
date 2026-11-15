/**
 * ADR-0334 (lane E16): the gateway side of the managed browser extension, PURE PART (no database, no routes).
 *
 *  - `verifyBrowserProof`: a request proof is a compact JWS (ES256, `typ` regulait-browser-proof+jwt, no embedded key)
 *    by the device's registered P-256 key over the method, the path, the SHA-256 of the raw body, a time and a one-use
 *    id. The route claims the id in the replay store; this file checks everything else.
 *  - `buildBrowserPolicy`: the per-user decision for each catalogue site, deterministic, fail closed. The order is the
 *    governed core's (ADR-0251): an unknown or disabled person gets nothing; the execution posture (the kernel's
 *    `executionGate`, the same kill switch every governed call obeys) can only remove access; then the admin's site
 *    rule, where no rule means deny. Account domains are carried for the extension to check against the profile.
 *  - `signBrowserPolicy`: a compact JWS (EdDSA) under the browser policy key, a key of its own (ADR-0195: separate
 *    signing keys per purpose), operator-managed or install-generated.
 *
 * No model is called anywhere here: every permission and governance decision is a data check.
 */
import { createHash, createHmac, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { statSync, readFileSync } from "node:fs";
import path from "node:path";
import { calculateJwkThumbprint, CompactSign, compactVerify, decodeProtectedHeader, importJWK, type JWK } from "jose";
import { executionGate, type ExecutionPosture } from "@regulait/policy-kernel";
import {
  BROWSER_DLP_RULE_IDS,
  BROWSER_POLICY_SCHEMA,
  BROWSER_POLICY_TTL_SECONDS,
  BROWSER_POLICY_TYP,
  BROWSER_PROOF_MAX_AGE_SECONDS,
  BROWSER_PROOF_MAX_FUTURE_SECONDS,
  BROWSER_PROOF_TYP,
  BROWSER_SITE_CATALOGUE,
  browserPolicySchema,
  browserProofClaimsSchema,
  type BrowserDenyReason,
  type BrowserPolicy,
  type BrowserPolicyMode,
  type BrowserPolicySite,
  type BrowserProofClaims,
  type BrowserPublicJwk,
  type BrowserSiteId,
} from "@regulait/shared";
import { ensureInstallKeyFile, INSTALL_SECRETS_DIR_ENV, loadInstallKeyFile } from "./receipt-signing-key.js";

// ---------------------------------------------------------------------------
// Digests and keyed references
// ---------------------------------------------------------------------------

/** SHA-256 of the raw body, base64url (the proof's `bd` claim) */
export function browserBodyDigest(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("base64url");
}

/** RFC 7638 thumbprint of a registered key: its identity in `browser_devices` */
export function browserJwkThumbprint(jwk: BrowserPublicJwk): Promise<string> {
  return calculateJwkThumbprint({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, "sha256");
}

/**
 * The conversation a governed page belongs to, as a keyed hash of the site and its path (no query, no fragment).
 * The path itself is never stored. `key` is the deployment's pseudonym key (ADR-0195 decision 20).
 */
export function conversationRef(key: Buffer, siteId: string, sitePath: string): string {
  return `cnv:${createHmac("sha256", key).update(`browser-conversation\u0000${siteId}\u0000${sitePath}`).digest("hex").slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// Request proofs
// ---------------------------------------------------------------------------

export type ProofRefusal = "invalid_proof" | "proof_stale" | "body_digest_mismatch";

/**
 * Verify one request proof. `nowSeconds` is the DATABASE clock (M-075). Returns the claims, or the fixed refusal code.
 * The caller claims `jti` once in the replay store after this returns ok.
 */
export async function verifyBrowserProof(
  proof: string,
  jwk: BrowserPublicJwk,
  expected: { htu: string; bodyDigest: string },
  nowSeconds: number,
): Promise<{ ok: true; claims: BrowserProofClaims } | { ok: false; code: ProofRefusal }> {
  if (proof.length > 4096) return { ok: false, code: "invalid_proof" };
  let claims: BrowserProofClaims;
  try {
    const header = decodeProtectedHeader(proof);
    // one algorithm, one type, and never a key or key reference taken from the token itself
    if (header.alg !== "ES256" || header.typ !== BROWSER_PROOF_TYP || header.jwk || header.jku || header.x5c || header.x5u || header.crit) {
      return { ok: false, code: "invalid_proof" };
    }
    const key = await importJWK({ kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as JWK, "ES256");
    const { payload } = await compactVerify(proof, key, { algorithms: ["ES256"] });
    const parsed = browserProofClaimsSchema.safeParse(JSON.parse(Buffer.from(payload).toString("utf8")));
    if (!parsed.success) return { ok: false, code: "invalid_proof" };
    claims = parsed.data;
  } catch {
    return { ok: false, code: "invalid_proof" };
  }
  if (claims.htm !== "POST" || claims.htu !== expected.htu) return { ok: false, code: "invalid_proof" };
  if (claims.iat < nowSeconds - BROWSER_PROOF_MAX_AGE_SECONDS || claims.iat > nowSeconds + BROWSER_PROOF_MAX_FUTURE_SECONDS) {
    return { ok: false, code: "proof_stale" };
  }
  if (claims.bd !== expected.bodyDigest) return { ok: false, code: "body_digest_mismatch" };
  return { ok: true, claims };
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
const KEY_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
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
    if (!file || !keyId || !KEY_ID_RE.test(keyId)) return { state: "invalid" };
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

/** sign a policy (compact JWS, EdDSA, the key id in `kid`) */
export async function signBrowserPolicy(policy: BrowserPolicy, key: BrowserPolicyKey): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(policy)))
    .setProtectedHeader({ alg: "EdDSA", typ: BROWSER_POLICY_TYP, kid: key.keyId })
    .sign(key.privateKey);
}
