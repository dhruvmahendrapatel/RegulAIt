import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BROWSER_DLP_RULE_IDS, BROWSER_POLICY_SCHEMA, type BrowserPolicy } from "@regulait/shared/browser-governance";
import { DYNAMIC_RULE_ID_BASE } from "../src/manifest.js";
import { dynamicRulesFor, parseManagedConfig, verifyPolicy } from "../src/policy.js";

const now = 1_800_000_000;
const deviceId = "7d0f6a4e-1c2b-4b6a-9e3f-2a1b3c4d5e6f";
const kp = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const xOf = (k: typeof kp) => k.publicKey.export({ format: "jwk" }).x!;
const config = { policyKeys: [{ keyId: "gw-key-1", x: xOf(kp) }] };

const policy = (over: Partial<BrowserPolicy> = {}): BrowserPolicy => ({
  schema: BROWSER_POLICY_SCHEMA,
  deviceId,
  subject: "psn:0123456789abcdef01234567",
  profileEmail: "a@example.com",
  mode: "enforce",
  issuedAt: now - 5,
  notAfter: now + 3600,
  sites: [
    { siteId: "ep-poe-web", decision: "allow", denyReason: null, accountDomains: [] },
    { siteId: "ep-anthropic-claude-web", decision: "allow", denyReason: null, accountDomains: ["example.com"] },
    { siteId: "ep-openai-chatgpt", decision: "deny", denyReason: "site_denied", accountDomains: [] },
  ],
  dlp: { ruleIds: [...BROWSER_DLP_RULE_IDS] },
  promptCapture: { enabled: false },
  ...over,
});

/** the endpoint agent's envelope (ADR-0298): Ed25519 over the exact payload bytes */
const sign = async (body: unknown, opts: { key?: typeof kp; keyId?: string } = {}) => {
  const payload = Buffer.from(JSON.stringify(body));
  return { keyId: opts.keyId ?? "gw-key-1", payload: payload.toString("base64"), signature: edSign(null, payload, (opts.key ?? kp).privateKey).toString("base64") };
};

describe("ADR-0334 policy verification: fail closed", () => {
  it("accepts a policy signed by a pinned key for this device", async () => {
    const v = await verifyPolicy(await sign(policy()), config, deviceId, now);
    expect(v.ok).toBe(true);
  });

  it.each([
    ["another key under the pinned kid", async () => sign(policy(), { key: other }), "bad_signature"],
    ["an unpinned key id", async () => sign(policy(), { keyId: "gw-key-2" }), "unknown_key"],
    ["an envelope with another member", async () => ({ ...(await sign(policy())), alg: "none" }), "malformed"],
    ["a compact JWS instead of the envelope", async () => "eyJhbGciOiJFZERTQSJ9.e30.sig", "malformed"],
    ["another device", async () => sign(policy({ deviceId: "00000000-0000-4000-8000-000000000000" })), "wrong_device"],
    ["an expired policy", async () => sign(policy({ issuedAt: now - 7200, notAfter: now })), "expired"],
    ["a policy from the future", async () => sign(policy({ issuedAt: now + 600, notAfter: now + 4000 })), "not_yet_valid"],
    ["an unknown member", async () => sign({ ...policy(), allowAll: true }), "bad_body"],
    ["nothing", async () => undefined, "malformed"],
  ])("refuses %s", async (_name, make, code) => {
    const v = await verifyPolicy(await make(), config, deviceId, now);
    expect(v).toEqual({ ok: false, code });
  });

  it("refuses a tampered payload", async () => {
    const env = await sign(policy());
    const forged = Buffer.from(JSON.stringify(policy({ sites: [{ siteId: "ep-openai-chatgpt", decision: "allow", denyReason: null, accountDomains: [] }] }))).toString("base64");
    expect(await verifyPolicy({ ...env, payload: forged }, config, deviceId, now)).toEqual({ ok: false, code: "bad_signature" });
  });

  it("parses managed config strictly", () => {
    expect(parseManagedConfig({})).toBeNull();
    expect(parseManagedConfig({ gatewayUrl: "https://gw.example.org", enrolmentToken: `rgbe_${"0".repeat(64)}`, policyKeys: [{ keyId: "gw-key-1", x: xOf(kp) }] })).not.toBeNull();
  });
});

describe("ADR-0334 dynamic rules", () => {
  const blockedSites = (rules: ReturnType<typeof dynamicRulesFor>) => rules.map((r) => r.action.redirect?.extensionPath);

  it("blocks every site not allowed, with its code; account rules use the profile now", () => {
    const rules = dynamicRulesFor(policy(), "a@elsewhere.example", now);
    const paths = blockedSites(rules);
    expect(paths).toContain("/block.html?code=account_not_allowed&site=ep-anthropic-claude-web");
    expect(paths).toContain("/block.html?code=site_denied&site=ep-openai-chatgpt");
    expect(paths).toContain("/block.html?code=site_not_in_policy&site=ep-perplexity-web");
    expect(paths.some((p) => p?.includes("ep-poe-web"))).toBe(false);
    for (const r of rules) expect(r.id).toBeGreaterThanOrEqual(DYNAMIC_RULE_ID_BASE);
    expect(blockedSites(dynamicRulesFor(policy(), "b@example.com", now)).some((p) => p?.includes("ep-anthropic-claude-web"))).toBe(false);
  });

  it("audit mode blocks nothing the policy decided, but still blocks sites it does not cover", () => {
    const paths = blockedSites(dynamicRulesFor(policy({ mode: "audit" }), "", now));
    expect(paths.every((p) => p?.includes("code=site_not_in_policy"))).toBe(true);
    expect(paths.length).toBeGreaterThan(0);
  });

  it("an expired policy blocks every site", () => {
    const rules = dynamicRulesFor(policy({ issuedAt: now - 7200, notAfter: now - 1 }), "a@example.com", now);
    expect(rules).toHaveLength(9);
    expect(blockedSites(rules).every((p) => p?.includes("code=no_valid_policy"))).toBe(true);
  });
});
