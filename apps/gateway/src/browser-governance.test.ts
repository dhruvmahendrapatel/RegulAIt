/**
 * ADR-0334 (lane E16): the browser extension contract's pure gateway side, with no database.
 * The per-user policy is fail closed in the governed core's order; a policy is signed under its own key and verifies with the public half alone.
 */
import { createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BROWSER_SITE_CATALOGUE, browserPolicySchema, devicePolicyEnvelopeSchema } from "@regulait/shared";
import { devicePolicyKeyId, resolveDevicePolicySigner, signDevicePolicy } from "./device-policy-signer.js";
import {
  buildBrowserPolicy,
  conversationRef,
  type BuildPolicyInput,
} from "./browser-governance.js";

const NOW = 1_800_000_000;

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

  it("B1: an unmatched account gets the org-wide rules (account domains kept); a disabled person and a halted or read-only deployment get nothing", () => {
    const unmatched = buildBrowserPolicy(base({ user: null }));
    expect(unmatched.sites).toEqual(buildBrowserPolicy(base()).sites);
    expect(unmatched.sites.find((s) => s.siteId === "ep-poe-web")).toEqual({ siteId: "ep-poe-web", decision: "allow", denyReason: null, accountDomains: ["example.com"] });
    const disabled = buildBrowserPolicy(base({ user: { id: randomUUID(), disabled: true } }));
    expect(disabled.sites.every((s) => s.decision === "deny" && s.denyReason === "user_disabled")).toBe(true);
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

describe("ADR-0334 B4: the rotatable device-policy signer", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const pemOf = () => generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyFile = (pems: string[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), "dp-key-"));
    dirs.push(dir);
    const file = path.join(dir, "k.pem");
    writeFileSync(file, pems.join(""));
    return file;
  };

  it("is missing until configured, invalid when the active id is set alone or names no key", async () => {
    expect((await resolveDevicePolicySigner({})).state).toBe("missing");
    expect((await resolveDevicePolicySigner({ REGULAIT_DEVICE_POLICY_ACTIVE_KEY_ID: "device-policy-abc" })).state).toBe("invalid");
    const f = keyFile([pemOf(), pemOf()]);
    // two keys and no active id: never a guess
    expect((await resolveDevicePolicySigner({ REGULAIT_DEVICE_POLICY_SIGNING_KEY: f })).state).toBe("invalid");
    expect((await resolveDevicePolicySigner({ REGULAIT_DEVICE_POLICY_SIGNING_KEY: f, REGULAIT_DEVICE_POLICY_ACTIVE_KEY_ID: "device-policy-000000000000000000000000" })).state).toBe("invalid");
  });

  it("signs the endpoint agent's envelope, verifiable with the public half alone", async () => {
    const r = await resolveDevicePolicySigner({ REGULAIT_DEVICE_POLICY_SIGNING_KEY: keyFile([pemOf()]) });
    expect(r.state).toBe("ok");
    if (r.state !== "ok") return;
    expect(r.signer.active.keyId).toBe(devicePolicyKeyId(r.signer.active.x));
    expect(r.signer.active.keyId).toMatch(/^device-policy-[0-9a-f]{24}$/);
    const policy = buildBrowserPolicy({
      deviceId: randomUUID(), subject: "", profileEmail: "", mode: "enforce", promptCaptureEnabled: false, user: null, posture: { mode: "normal" }, rules: [], nowSeconds: NOW,
    });
    const env = signDevicePolicy(policy, r.signer);
    expect(devicePolicyEnvelopeSchema.parse(env)).toEqual(env);
    expect(Object.keys(env).sort()).toEqual(["keyId", "payload", "signature"]);
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: r.signer.active.x }, format: "jwk" });
    const payload = Buffer.from(env.payload, "base64");
    expect(verify(null, payload, pub, Buffer.from(env.signature, "base64"))).toBe(true);
    expect(verify(null, Buffer.concat([payload, Buffer.from(" ")]), pub, Buffer.from(env.signature, "base64"))).toBe(false);
    expect(JSON.parse(payload.toString("utf8"))).toEqual(policy);
  });

  it("rotates: every configured key is published, the named one signs, and a P-256 or junk file is refused", async () => {
    const f = keyFile([pemOf(), pemOf()]);
    const both = await resolveDevicePolicySigner({ REGULAIT_DEVICE_POLICY_SIGNING_KEY: f, REGULAIT_DEVICE_POLICY_ACTIVE_KEY_ID: "x" });
    expect(both.state).toBe("invalid");
    const probe = await import("./identity-signing-keys.js").then((m) => m.readSigningKeyFile(f, () => new Error("bad"), ["Ed25519"]));
    const ids = probe.map((k) => devicePolicyKeyId(k.publicJwk.x));
    for (const active of ids) {
      const r = await resolveDevicePolicySigner({ REGULAIT_DEVICE_POLICY_SIGNING_KEY: f, REGULAIT_DEVICE_POLICY_ACTIVE_KEY_ID: active });
      expect(r.state === "ok" && r.signer.active.keyId).toBe(active);
      expect(r.state === "ok" && r.signer.published.map((k) => k.keyId)).toEqual([active, ...ids.filter((i) => i !== active)]);
      expect(r.state === "ok" && signDevicePolicy({ a: 1 }, r.signer).keyId).toBe(active);
    }
    const p256 = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect((await resolveDevicePolicySigner({ REGULAIT_DEVICE_POLICY_SIGNING_KEY: keyFile([p256]) })).state).toBe("invalid");
    expect((await resolveDevicePolicySigner({ REGULAIT_DEVICE_POLICY_SIGNING_KEY: keyFile(["not a key"]) })).state).toBe("invalid");
  });

  it.skipIf(process.platform === "win32")("an install-generated key is created only on request, then reused under a derived id", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dp-install-"));
    dirs.push(dir);
    chmodSync(dir, 0o700);
    const env = { REGULAIT_INSTALL_SECRETS_DIR: dir };
    expect((await resolveDevicePolicySigner(env)).state).toBe("missing");
    const made = await resolveDevicePolicySigner(env, { create: true });
    expect(made.state).toBe("ok");
    const again = await resolveDevicePolicySigner(env);
    expect(again.state === "ok" && made.state === "ok" && again.signer.active.keyId === made.signer.active.keyId).toBe(true);
    expect(again.state === "ok" && again.signer.source).toBe("install_generated");
  });
});
