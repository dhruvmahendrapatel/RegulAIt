/**
 * ADR-0193 P0/P1, the pure half: digest round trips, the keyed (pii) digest never reveals or matches its plaintext
 * without the tenant key, the strict defaults, and the kernel rule. No database.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildContentProvenanceLabel,
  CONTENT_CONTEXT_ID_PATTERN,
  CONTENT_TRUST_TIERS,
  CONTENT_TRUST_WRITE_FLOORS,
  contentDigestBytes,
  contentDigestKeyed,
  contentMatchesDigest,
  DEFAULT_CONTENT_TRUST_TIER,
  DEFAULT_CONTENT_TRUST_WRITE_FLOOR,
  digestContent,
  evaluateContentTrust,
  lowestContentTrustTier,
  runContextId,
  builderThreadContextId,
} from "../index.js";

const KEY = { id: "00000000-0000-4000-8000-00000000c0de", bytes: randomBytes(32) };
const RESULT = { content: [{ type: "text", text: "the answer is 42" }], isError: false };
const REDACTED = { content: [{ type: "text", text: "the answer is [REDACTED]" }], isError: false };

describe("ADR-0193 P0: the content digest", () => {
  it("a clean result gets a plain SHA-256 over its canonical bytes, independent of key order, and round-trips", () => {
    const d = digestContent(RESULT, RESULT, "clean", null);
    expect(d.alg).toBe("sha256");
    expect(d.keyId).toBeNull();
    const reordered = { isError: false, content: [{ text: "the answer is 42", type: "text" }] };
    expect(d.upstream).toBe(createHash("sha256").update(contentDigestBytes(reordered)).digest("hex"));
    expect(contentMatchesDigest(reordered, d.upstream!, "sha256")).toBe(true);
    expect(contentMatchesDigest({ ...RESULT, isError: true }, d.upstream!, "sha256")).toBe(false);
    // a string is its UTF-8 bytes, not a JSON string literal
    expect(contentDigestBytes("héllo").equals(Buffer.from("héllo", "utf8"))).toBe(true);
  });

  it("both byte sets are digested: a redaction makes upstream and delivered differ, and the label says so", () => {
    const label = buildContentProvenanceLabel({
      source: { kind: "mcp_tool", serverId: KEY.id, toolName: "lookup" },
      trustTier: "untrusted",
      classification: "clean",
      upstream: RESULT,
      delivered: REDACTED,
      key: null,
      decisionAuditId: KEY.id,
      contextId: null,
    });
    expect(label.digest.upstream).not.toBe(label.digest.delivered);
    expect(label.transformed).toBe(true);
    expect(contentMatchesDigest(RESULT, label.digest.upstream!, "sha256")).toBe(true);
    expect(contentMatchesDigest(REDACTED, label.digest.delivered!, "sha256")).toBe(true);
    const same = buildContentProvenanceLabel({ ...label, source: label.source, upstream: RESULT, delivered: RESULT, key: null });
    expect(same.transformed).toBe(false);
  });

  it("pii and unscanned content are keyed; only a clean scan is plain", () => {
    expect(contentDigestKeyed("pii")).toBe(true);
    expect(contentDigestKeyed("unscanned")).toBe(true);
    expect(contentDigestKeyed("clean")).toBe(false);
  });

  it("a pii digest is an HMAC under the tenant key: it round-trips with the key, never without it, and reveals nothing", () => {
    const email = "jane.doe@example.com";
    const d = digestContent(email, "[REDACTED]", "pii", KEY);
    expect(d.alg).toBe("hmac-sha256");
    expect(d.keyId).toBe(KEY.id);
    expect(d.upstream).toBe(createHmac("sha256", KEY.bytes).update(email, "utf8").digest("hex"));
    expect(contentMatchesDigest(email, d.upstream!, "hmac-sha256", KEY.bytes)).toBe(true);
    // a guess cannot be checked without the key: the plain hash of the value is not the stored digest
    expect(d.upstream).not.toBe(createHash("sha256").update(email, "utf8").digest("hex"));
    expect(() => contentMatchesDigest(email, d.upstream!, "hmac-sha256")).toThrow(/tenant key/);
    // another tenant's key gives another digest, so digests do not correlate across tenants
    expect(digestContent(email, "[REDACTED]", "pii", { id: KEY.id, bytes: randomBytes(32) }).upstream).not.toBe(d.upstream);
    // the label carries digests, never the content
    const label = buildContentProvenanceLabel({
      source: { kind: "connector", connectorId: KEY.id, operation: "read", object: "contacts" },
      trustTier: "standard",
      classification: "pii",
      upstream: email,
      delivered: "[REDACTED]",
      key: KEY,
      decisionAuditId: KEY.id,
      contextId: runContextId(KEY.id),
    });
    const text = JSON.stringify(label);
    expect(text).not.toContain(email);
    expect(text).not.toContain("jane");
    expect(text).not.toContain(KEY.bytes.toString("hex"));
  });

  it("a keyed digest owed with no key stores no digest at all (never a plain digest of possible PII)", () => {
    const d = digestContent("jane.doe@example.com", "x", "unscanned", null);
    expect(d).toEqual({ alg: "unavailable", keyId: null, upstream: null, delivered: null });
    const label = buildContentProvenanceLabel({
      source: { kind: "mcp_tool", serverId: KEY.id, toolName: "t" },
      trustTier: "untrusted",
      classification: "unscanned",
      upstream: "jane.doe@example.com",
      delivered: "x",
      key: null,
      decisionAuditId: KEY.id,
      contextId: null,
    });
    expect(label.transformed).toBeNull();
  });
});

describe("ADR-0193 P1: trust tiers and the kernel rule", () => {
  it("three tiers, every source defaults to untrusted, and the write floor defaults to trusted (ADR-0180)", () => {
    expect(CONTENT_TRUST_TIERS).toEqual(["untrusted", "standard", "trusted"]);
    expect(DEFAULT_CONTENT_TRUST_TIER).toBe("untrusted");
    expect(DEFAULT_CONTENT_TRUST_WRITE_FLOOR).toBe("trusted");
    // the policy cannot be turned off: untrusted is never a floor
    expect(CONTENT_TRUST_WRITE_FLOORS).not.toContain("untrusted");
  });

  it("a write is refused when its context holds content below the floor; a read never is", () => {
    expect(evaluateContentTrust("write", ["trusted", "untrusted"], "trusted")).toEqual({ ok: false, lowest: "untrusted", floor: "trusted" });
    expect(evaluateContentTrust("write", ["standard"], "trusted")).toEqual({ ok: false, lowest: "standard", floor: "trusted" });
    expect(evaluateContentTrust("write", ["standard"], "standard")).toEqual({ ok: true, lowest: "standard" });
    expect(evaluateContentTrust("write", ["untrusted"], "standard").ok).toBe(false);
    expect(evaluateContentTrust("write", ["trusted"], "trusted").ok).toBe(true);
    expect(evaluateContentTrust("read", ["untrusted"], "trusted").ok).toBe(true);
    // nothing in the context yet: nothing to refuse
    expect(evaluateContentTrust("write", [], "trusted")).toEqual({ ok: true, lowest: null });
    expect(lowestContentTrustTier(["trusted", "standard", "trusted"])).toBe("standard");
  });

  it("context ids are the run and builder-thread forms only", () => {
    expect(CONTENT_CONTEXT_ID_PATTERN.test(runContextId("0b6f2c1e-7a7e-4f3c-9d55-2d1a1c0e9f00"))).toBe(true);
    expect(CONTENT_CONTEXT_ID_PATTERN.test(builderThreadContextId("0b6f2c1e-7a7e-4f3c-9d55-2d1a1c0e9f00"))).toBe(true);
    expect(CONTENT_CONTEXT_ID_PATTERN.test("mcp:0b6f2c1e-7a7e-4f3c-9d55-2d1a1c0e9f00")).toBe(false);
  });
});
