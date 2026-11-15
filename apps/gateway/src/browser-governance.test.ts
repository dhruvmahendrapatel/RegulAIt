/**
 * ADR-0334 (lane E16): the browser extension contract's pure gateway side, with no database.
 * Proof verification refuses every forgery the route relies on it for; the per-user policy is fail closed in the
 * governed core's order; a policy is signed under its own key and verifies with the public half alone.
 */
import { generateKeyPairSync, randomUUID, webcrypto } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CompactSign, compactVerify, exportJWK, importJWK } from "jose";
import { afterAll, describe, expect, it } from "vitest";
import { BROWSER_POLICY_TYP, BROWSER_PROOF_TYP, BROWSER_SITE_CATALOGUE, browserPolicySchema, type BrowserPublicJwk } from "@regulait/shared";
import {
  browserBodyDigest,
  buildBrowserPolicy,
  conversationRef,
  resolveBrowserPolicyKey,
  signBrowserPolicy,
  verifyBrowserProof,
  type BuildPolicyInput,
} from "./browser-governance.js";

const NOW = 1_800_000_000;
const HTU = "/v1/browser-extension/policy";

async function deviceKey() {
  const pair = (await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as webcrypto.CryptoKeyPair;
  const j = await exportJWK(pair.publicKey);
  return { pair, jwk: { kty: "EC", crv: "P-256", x: j.x!, y: j.y! } as BrowserPublicJwk };
}

async function proof(key: CryptoKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader({ alg: "ES256", typ: BROWSER_PROOF_TYP, ...header } as never).sign(key);
}

describe("ADR-0334 device proofs", () => {
  const body = Buffer.from(JSON.stringify({ profileEmail: "" }));
  const claims = () => ({ htm: "POST", htu: HTU, iat: NOW, jti: randomUUID(), bd: browserBodyDigest(body) });

  it("accepts a proof by the registered key over this path and these bytes", async () => {
    const d = await deviceKey();
    const v = await verifyBrowserProof(await proof(d.pair.privateKey, claims()), d.jwk, { htu: HTU, bodyDigest: browserBodyDigest(body) }, NOW + 10);
    expect(v.ok).toBe(true);
  });

  it("refuses another key, path, body, time, type, algorithm, an embedded key and unknown claims", async () => {
    const d = await deviceKey();
    const other = await deviceKey();
    const exp = { htu: HTU, bodyDigest: browserBodyDigest(body) };
    const check = async (p: string, e = exp, now = NOW) => (await verifyBrowserProof(p, d.jwk, e, now)) as { ok: boolean; code?: string };
    expect(await check(await proof(other.pair.privateKey, claims()))).toEqual({ ok: false, code: "invalid_proof" });
    expect(await check(await proof(d.pair.privateKey, { ...claims(), htu: "/v1/browser-extension/events" }))).toEqual({ ok: false, code: "invalid_proof" });
    expect(await check(await proof(d.pair.privateKey, claims()), { htu: HTU, bodyDigest: browserBodyDigest(Buffer.from("{}")) })).toEqual({ ok: false, code: "body_digest_mismatch" });
    expect(await check(await proof(d.pair.privateKey, claims()), exp, NOW + 301)).toEqual({ ok: false, code: "proof_stale" });
    expect(await check(await proof(d.pair.privateKey, claims()), exp, NOW - 61)).toEqual({ ok: false, code: "proof_stale" });
    expect(await check(await proof(d.pair.privateKey, claims(), { typ: "JWT" }))).toEqual({ ok: false, code: "invalid_proof" });
    expect(await check(await proof(d.pair.privateKey, claims(), { jwk: other.jwk }))).toEqual({ ok: false, code: "invalid_proof" });
    expect(await check(await proof(d.pair.privateKey, { ...claims(), scope: "admin" }))).toEqual({ ok: false, code: "invalid_proof" });
    expect(await check("not-a-jws")).toEqual({ ok: false, code: "invalid_proof" });
    const ed = generateKeyPairSync("ed25519");
    const edProof = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims()))).setProtectedHeader({ alg: "EdDSA", typ: BROWSER_PROOF_TYP }).sign(ed.privateKey);
    expect(await check(edProof)).toEqual({ ok: false, code: "invalid_proof" });
  });
});

describe("ADR-0334 per-user policy", () => {
  const base = (over: Partial<BuildPolicyInput> = {}): BuildPolicyInput => ({
    deviceId: randomUUID(),
    subject: "psn:0123456789abcdef01234567",
    profileEmail: "a@example.com",
    mode: "enforce",
    promptCaptureEnabled: false,
    user: { id: randomUUID(), disabled: false },
    posture: { mode: "normal" },
    rules: [
      { siteId: "ep-poe-web", decision: "allow", accountDomains: ["example.com"] },
      { siteId: "ep-openai-chatgpt", decision: "deny", accountDomains: [] },
    ],
    nowSeconds: NOW,
    ...over,
  });
  const site = (p: ReturnType<typeof buildBrowserPolicy>, id: string) => p.sites.find((s) => s.siteId === id)!;

  it("lists every catalogue site; no rule means deny", () => {
    const p = buildBrowserPolicy(base());
    expect(p.sites.map((s) => s.siteId)).toEqual(BROWSER_SITE_CATALOGUE.map((s) => s.siteId));
    expect(site(p, "ep-poe-web")).toEqual({ siteId: "ep-poe-web", decision: "allow", denyReason: null, accountDomains: ["example.com"] });
    expect(site(p, "ep-openai-chatgpt").denyReason).toBe("site_denied");
    expect(site(p, "ep-perplexity-web").denyReason).toBe("no_site_rule");
    expect(p.notAfter - p.issuedAt).toBe(4 * 3600);
    expect(browserPolicySchema.safeParse(p).success).toBe(true);
  });

  it("an unknown or disabled person, and a halted or read-only deployment, get nothing", () => {
    for (const p of [buildBrowserPolicy(base({ user: null })), buildBrowserPolicy(base({ user: { id: randomUUID(), disabled: true } }))]) {
      expect(p.sites.every((s) => s.decision === "deny" && s.denyReason === "user_unknown")).toBe(true);
    }
    for (const mode of ["halted", "read_only", "require_approval"] as const) {
      const p = buildBrowserPolicy(base({ posture: { mode } }));
      expect(p.sites.every((s) => s.decision === "deny" && s.denyReason === "execution_posture"), mode).toBe(true);
    }
  });

  it("carries the mode and the capture switch the admin set", () => {
    const p = buildBrowserPolicy(base({ mode: "audit", promptCaptureEnabled: true }));
    expect(p.mode).toBe("audit");
    expect(p.promptCapture.enabled).toBe(true);
  });

  it("conversation refs are keyed, stable and do not contain the path", () => {
    const k = Buffer.alloc(32, 7);
    const a = conversationRef(k, "ep-poe-web", "/chat/abc123");
    expect(a).toMatch(/^cnv:[0-9a-f]{32}$/);
    expect(conversationRef(k, "ep-poe-web", "/chat/abc123")).toBe(a);
    expect(conversationRef(k, "ep-poe-web", "/chat/abc124")).not.toBe(a);
    expect(conversationRef(Buffer.alloc(32, 8), "ep-poe-web", "/chat/abc123")).not.toBe(a);
    expect(a).not.toContain("abc123");
  });
});

describe("ADR-0334 the browser policy signing key", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("is missing until configured, invalid when half configured", () => {
    expect(resolveBrowserPolicyKey({}).state).toBe("missing");
    expect(resolveBrowserPolicyKey({ REGULAIT_BROWSER_POLICY_SIGNING_KEY_ID: "k1" }).state).toBe("invalid");
  });

  it("an operator key signs a policy that verifies with its public half only", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bp-key-"));
    dirs.push(dir);
    const file = path.join(dir, "k.pem");
    writeFileSync(file, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
    const r = resolveBrowserPolicyKey({ REGULAIT_BROWSER_POLICY_SIGNING_KEY: file, REGULAIT_BROWSER_POLICY_SIGNING_KEY_ID: "ops-1" });
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    const policy = buildBrowserPolicy({
      deviceId: randomUUID(), subject: "", profileEmail: "", mode: "enforce", promptCaptureEnabled: false, user: null, posture: { mode: "normal" }, rules: [], nowSeconds: NOW,
    });
    const jws = await signBrowserPolicy(policy, r.key);
    const { payload, protectedHeader } = await compactVerify(jws, await importJWK({ kty: "OKP", crv: "Ed25519", x: r.key.x }, "EdDSA"));
    expect(protectedHeader).toEqual({ alg: "EdDSA", typ: BROWSER_POLICY_TYP, kid: "ops-1" });
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual(policy);
  });

  it("an RSA or malformed operator key is invalid", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bp-key-"));
    dirs.push(dir);
    const rsa = path.join(dir, "rsa.pem");
    writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }));
    expect(resolveBrowserPolicyKey({ REGULAIT_BROWSER_POLICY_SIGNING_KEY: rsa, REGULAIT_BROWSER_POLICY_SIGNING_KEY_ID: "k" }).state).toBe("invalid");
    const junk = path.join(dir, "junk.pem");
    writeFileSync(junk, "not a key");
    expect(resolveBrowserPolicyKey({ REGULAIT_BROWSER_POLICY_SIGNING_KEY: junk, REGULAIT_BROWSER_POLICY_SIGNING_KEY_ID: "k" }).state).toBe("invalid");
  });

  it.skipIf(process.platform === "win32")("an install-generated key is created only on request, then reused under a derived id", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bp-install-"));
    dirs.push(dir);
    chmodSync(dir, 0o700);
    const env = { REGULAIT_INSTALL_SECRETS_DIR: dir };
    expect(resolveBrowserPolicyKey(env).state).toBe("missing");
    const made = resolveBrowserPolicyKey(env, { create: true });
    expect(made.state).toBe("ok");
    const again = resolveBrowserPolicyKey(env);
    expect(again.state === "ok" && made.state === "ok" && again.key.keyId === made.key.keyId && again.key.keyId.startsWith("browser-ed25519-")).toBe(true);
  });
});
