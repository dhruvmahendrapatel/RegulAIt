import { describe, expect, it } from "vitest";
import { SHADOW_AI_CATALOG_V1 } from "../shadow-discovery.js";
import { CREDENTIAL_MATERIAL_RULES } from "../guardrails.js";
import {
  BROWSER_DLP_RULE_IDS,
  BROWSER_POLICY_SCHEMA,
  BROWSER_SITE_CATALOGUE,
  browserEventSchema,
  browserManagedConfigSchema,
  browserPolicySchema,
  browserRegisterRequestSchema,
  siteForHost,
  siteMatchPatterns,
  siteVerdict,
  type BrowserPolicy,
} from "./index.js";

const now = 1_800_000_000;
const policy = (over: Partial<BrowserPolicy> = {}): BrowserPolicy => ({
  schema: BROWSER_POLICY_SCHEMA,
  deviceId: "7d0f6a4e-1c2b-4b6a-9e3f-2a1b3c4d5e6f",
  subject: "",
  profileEmail: "",
  mode: "enforce",
  issuedAt: now - 10,
  notAfter: now + 3600,
  sites: [
    { siteId: "ep-anthropic-claude-web", decision: "allow", denyReason: null, accountDomains: ["example.com"] },
    { siteId: "ep-openai-chatgpt", decision: "deny", denyReason: "site_denied", accountDomains: [] },
    { siteId: "ep-poe-web", decision: "allow", denyReason: null, accountDomains: [] },
  ],
  dlp: { ruleIds: [...BROWSER_DLP_RULE_IDS] },
  promptCapture: { enabled: false },
  ...over,
});

describe("ADR-0334 browser governance contract", () => {
  it("every governed site is the plain-host endpoint entry of the frozen shadow-AI catalogue", () => {
    for (const s of BROWSER_SITE_CATALOGUE) {
      const e = SHADOW_AI_CATALOG_V1.find((x) => x.id === s.siteId);
      expect(e, s.siteId).toBeDefined();
      expect(e!.kind).toBe("endpoint");
      expect(e!.pattern).toBe(s.host);
      expect(e!.provider).toBe(s.provider);
      expect(e!.pattern).not.toContain("*");
    }
  });

  it("the DLP rule ids are exactly the shared dlp.secret.* credential rules, in order", () => {
    expect([...BROWSER_DLP_RULE_IDS]).toEqual(CREDENTIAL_MATERIAL_RULES.map((r) => r.id).filter((id) => id.startsWith("dlp.secret.")));
  });

  it("match patterns are https only, the host and its subdomains", () => {
    expect(siteMatchPatterns({ host: "chat.example.org" })).toEqual(["https://chat.example.org/*", "https://*.chat.example.org/*"]);
    expect(siteForHost("claude.ai")).toBe("ep-anthropic-claude-web");
    expect(siteForHost("www.claude.ai.")).toBe("ep-anthropic-claude-web");
    expect(siteForHost("notclaude.ai")).toBeNull();
    expect(siteForHost("claude.ai.example.org")).toBeNull();
  });

  it("siteVerdict fails closed and applies account domains", () => {
    expect(siteVerdict(null, "ep-poe-web", "", now)).toEqual({ effect: "block", code: "no_valid_policy" });
    expect(siteVerdict(policy({ notAfter: now }), "ep-poe-web", "", now)).toEqual({ effect: "block", code: "no_valid_policy" });
    expect(siteVerdict(policy({ issuedAt: now + 400, notAfter: now + 4000 }), "ep-poe-web", "", now).effect).toBe("block");
    expect(siteVerdict(policy(), "ep-poe-web", "", now)).toEqual({ effect: "allow" });
    expect(siteVerdict(policy(), "ep-openai-chatgpt", "a@example.com", now)).toEqual({ effect: "block", code: "site_denied" });
    expect(siteVerdict(policy(), "ep-perplexity-web", "a@example.com", now)).toEqual({ effect: "block", code: "site_not_in_policy" });
    expect(siteVerdict(policy(), "ep-anthropic-claude-web", "", now)).toEqual({ effect: "block", code: "account_signed_out" });
    expect(siteVerdict(policy(), "ep-anthropic-claude-web", "a@other.example", now)).toEqual({ effect: "block", code: "account_not_allowed" });
    expect(siteVerdict(policy(), "ep-anthropic-claude-web", "a@sub.example.com", now)).toEqual({ effect: "block", code: "account_not_allowed" });
    expect(siteVerdict(policy(), "ep-anthropic-claude-web", "A@Example.com", now)).toEqual({ effect: "allow" });
  });

  it("the policy schema refuses unknown members, a deny without a reason, duplicates and a long life", () => {
    expect(browserPolicySchema.safeParse(policy()).success).toBe(true);
    expect(browserPolicySchema.safeParse({ ...policy(), extra: 1 }).success).toBe(false);
    expect(browserPolicySchema.safeParse(policy({ sites: [{ siteId: "ep-poe-web", decision: "deny", denyReason: null, accountDomains: [] }] })).success).toBe(false);
    expect(browserPolicySchema.safeParse(policy({ sites: [policy().sites[2]!, policy().sites[2]!] })).success).toBe(false);
    expect(browserPolicySchema.safeParse(policy({ notAfter: now + 2 * 86400 })).success).toBe(false);
    expect(browserPolicySchema.safeParse({ ...policy(), dlp: { ruleIds: ["dlp.secret.nope"] } }).success).toBe(false);
  });

  it("a registration key carries public members only, and managed config needs https and a well-formed token", () => {
    const jwk = { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "B".repeat(43) };
    expect(browserRegisterRequestSchema.safeParse({ publicJwk: jwk, os: "mac", browserMajor: 140, extensionVersion: "0.1.0" }).success).toBe(true);
    expect(browserRegisterRequestSchema.safeParse({ publicJwk: { ...jwk, d: "C".repeat(43) }, os: "mac", browserMajor: 140, extensionVersion: "0.1.0" }).success).toBe(false);
    const cfg = { gatewayUrl: "https://gw.example.org", enrolmentToken: `rgbe_${"a".repeat(64)}`, policyKeys: [{ keyId: "gw-key-1", x: "A".repeat(43) }] };
    expect(browserManagedConfigSchema.safeParse(cfg).success).toBe(true);
    expect(browserManagedConfigSchema.safeParse({ ...cfg, gatewayUrl: "http://gw.example.org" }).success).toBe(false);
    expect(browserManagedConfigSchema.safeParse({ ...cfg, enrolmentToken: "rgbe_short" }).success).toBe(false);
    expect(browserManagedConfigSchema.safeParse({ ...cfg, policyKeys: [] }).success).toBe(false);
  });

  it("an event never carries text: dlp events name rules, others none; paths have no query", () => {
    const base = { eventId: "7d0f6a4e-1c2b-4b6a-9e3f-2a1b3c4d5e6f", siteId: "ep-poe-web", path: "/chat/abc", occurredAt: now, outcome: "blocked" };
    expect(browserEventSchema.safeParse({ ...base, kind: "dlp_blocked", code: "dlp_match", ruleIds: ["dlp.secret.aws_key"] }).success).toBe(true);
    expect(browserEventSchema.safeParse({ ...base, kind: "dlp_blocked", code: "dlp_match", ruleIds: [] }).success).toBe(false);
    expect(browserEventSchema.safeParse({ ...base, kind: "site_blocked", code: "site_denied", ruleIds: ["dlp.secret.aws_key"] }).success).toBe(false);
    expect(browserEventSchema.safeParse({ ...base, kind: "site_blocked", code: "site_denied", ruleIds: [], path: "/c?q=secret" }).success).toBe(false);
    expect(browserEventSchema.safeParse({ ...base, kind: "site_blocked", code: "site_denied", ruleIds: [], text: "hello" }).success).toBe(false);
  });
});

describe("ADR-0334 the signed-policy envelope is the endpoint agent's", () => {
  it("is exactly {keyId, payload, signature}, standard base64, with the endpoint agent's key id shape", async () => {
    const { devicePolicyEnvelopeSchema } = await import("./index.js");
    const env = { keyId: "gw-key-1", payload: Buffer.from("{}").toString("base64"), signature: Buffer.alloc(64, 1).toString("base64") };
    expect(devicePolicyEnvelopeSchema.safeParse(env).success).toBe(true);
    expect(devicePolicyEnvelopeSchema.safeParse({ ...env, alg: "none" }).success).toBe(false);
    expect(devicePolicyEnvelopeSchema.safeParse({ ...env, keyId: "Key_1" }).success).toBe(false);
    expect(devicePolicyEnvelopeSchema.safeParse({ ...env, signature: Buffer.alloc(64, 1).toString("base64url") + "x" }).success).toBe(false);
  });
});
