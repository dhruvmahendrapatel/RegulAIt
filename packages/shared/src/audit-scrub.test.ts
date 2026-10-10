/**
 * ADR-0099 — the audit-log credential scrub, PURE half.
 *
 * The e2e half (`apps/gateway/src/audit-scrub.test.ts`) proves the scrub is
 * actually WIRED: it SELECTs real rows out of Postgres after driving them
 * through a real route and through a raw `db.insert(auditLog)`. This file
 * proves the RULE itself, where a database would only get in the way — the span
 * arithmetic, the PEM extension, the assignment narrowing, and above all the
 * OVER-SCRUB GUARD, which is the half of this feature most likely to do quiet
 * damage. An audit ledger whose ordinary content gets mangled is a worse
 * outcome than the risk being closed, so the negative cases here are asserted
 * on IDENTITY (`toBe`), not equality: the string that comes back must be the
 * same object that went in.
 */
import { describe, expect, it } from "vitest";
import {
  AUDIT_SCRUB_MARKER_PREFIX,
  CREDENTIAL_MATERIAL_RULES,
  scrubAuditDetail,
  scrubAuditRow,
  scrubAuditText,
} from "./index.js";
import { semanticDlpDetector } from "./guardrails.js";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const RGL_KEY = `rgl_${"a1b2c3d4".repeat(6)}`;
const RGLV_KEY = `rglv_${"9f8e7d6c".repeat(6)}`;
const JWT =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";

describe("the marker's grammar", () => {
  it("names the rule, the length and a correlation fingerprint — and no secret", () => {
    const out = scrubAuditText(`sync failed for ${AWS_KEY} on host x`);
    // rule name, exact removed length, 12 hex of fingerprint — and nothing else
    expect(out).toMatch(/^sync failed for \[redacted:aws_key:20:[0-9a-f]{12}\] on host x$/);
    expect(out).not.toContain(AWS_KEY);
  });

  it("preserves the sentence around the credential byte for byte", () => {
    const out = scrubAuditText(`connector 'acme' refused: ${AWS_KEY} rejected by sts`);
    expect(out.startsWith("connector 'acme' refused: ")).toBe(true);
    expect(out.endsWith(" rejected by sts")).toBe(true);
  });

  it("CORRELATES: the same credential in two rows redacts to the same marker", () => {
    const a = scrubAuditText(`first sighting ${RGL_KEY}`);
    const b = scrubAuditText(`months later, ${RGL_KEY} again`);
    const markerOf = (s: string) => /\[redacted:[^\]]+\]/.exec(s)?.[0];
    expect(markerOf(a)).toBeTruthy();
    expect(markerOf(a)).toBe(markerOf(b));
    expect(a).not.toContain(RGL_KEY);
    expect(b).not.toContain(RGL_KEY);
  });

  it("DISCRIMINATES: two different credentials never collapse into one text", () => {
    const a = scrubAuditText(RGL_KEY);
    const b = scrubAuditText(RGLV_KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain(RGL_KEY);
    expect(b).not.toContain(RGLV_KEY);
  });
});

describe("the shapes it catches", () => {
  it("catches every credential-material rule ADR-0042 already ships", () => {
    for (const [label, text] of [
      ["aws_key", `id ${AWS_KEY} here`],
      ["private_key", "-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK7\n-----END RSA PRIVATE KEY-----"],
      ["jwt", `bearer ${JWT}`],
      ["assignment", 'client_secret = "abcdefghijklmnopq"'],
      ["provider_token", "sk-abcdefghijklmnopqrstuvwxyz012345"],
      ["regulait_token", `bearer ${RGL_KEY}`],
      ["bearer_token", `Authorization: Bearer ${"9f8e7d6c".repeat(5)}`],
    ] as const) {
      const out = scrubAuditText(text);
      expect(out, label).toContain(AUDIT_SCRUB_MARKER_PREFIX);
    }
  });

  it("ADR-0189 B7 review: an opaque bearer token is replaced, the header name survives, prose is untouched", () => {
    const token = "9f8e7d6c".repeat(5);
    const out = scrubAuditText(`POST /mcp 401 "Authorization: Bearer ${token}"`);
    expect(out).not.toContain(token);
    expect(out).toMatch(/^POST \/mcp 401 "Authorization: Bearer \[redacted:bearer_token:40:[0-9a-f]{12}\]"$/);
    expect(scrubAuditText(`bearer\t${"aZ09._~+/-".repeat(3)}==`)).toMatch(/^bearer\t\[redacted:bearer_token:32:[0-9a-f]{12}\]$/);
    // scrub-only: the DLP detector's credential rules do not carry it (mcp-discovery.ts's reason)
    expect(CREDENTIAL_MATERIAL_RULES.map((r) => r.id)).not.toContain("bearer_token");
    for (const prose of ["Bearer token missing", "Bearer abc.def", "the Bearer of bad news"]) expect(scrubAuditText(prose)).toBe(prose);
  });

  it("covers the credential shapes THIS product mints, not just third-party ones", () => {
    for (const token of [RGL_KEY, RGLV_KEY, `rgls_${"0".repeat(64)}`, `rglscim_${"f".repeat(64)}`]) {
      expect(scrubAuditText(`presented ${token}`), token.slice(0, 8)).not.toContain(token);
    }
  });

  it("takes the WHOLE PEM block, not just the header line the detector matches", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BA\nQEFAASCBKcwggSjAgEAAoIBAQ\n-----END PRIVATE KEY-----";
    const out = scrubAuditText(`key follows:\n${pem}\nand that is all`);
    expect(out).not.toContain("MIIEvQIBADANBgkqhkiG9w0BA");
    expect(out).not.toContain("BEGIN PRIVATE KEY");
    expect(out).toContain("key follows:\n");
    expect(out).toContain("\nand that is all");
  });

  it("takes a TRUNCATED PEM block to the end of the string rather than leaving the body", () => {
    const out = scrubAuditText("-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIBSECRETBODY");
    expect(out).not.toContain("SECRETBODY");
    expect(out).toMatch(/^\[redacted:(?:[a-z0-9_.]+\+)*private_key(?:\+[a-z0-9_.]+)*:51:[0-9a-f]{12}\]$/);
  });

  it("keeps the assigned FIELD NAME and takes only the value", () => {
    const out = scrubAuditText('api_key = "sk_live_abcdefghijklmnop"');
    expect(out.startsWith("api_key = ")).toBe(true);
    expect(out).not.toContain("sk_live_abcdefghijklmnop");
    // password and client_secret must stay distinguishable in the ledger
    expect(scrubAuditText("password: hunter2000000000")).toContain("password: ");
    expect(scrubAuditText("client_secret: hunter2000000000")).toContain("client_secret: ");
  });

  it("emits ONE marker for a run two rules both match, not a marker inside a marker", () => {
    const out = scrubAuditText(`access_token = ${JWT}`);
    expect(out.match(/\[redacted:/g)?.length).toBe(1);
    expect(out).toContain("assignment+jwt");
    expect(out).not.toContain(JWT.slice(0, 24));
  });
});

describe("THE OVER-SCRUB GUARD — ordinary detail must survive byte-identical", () => {
  const ORDINARY = [
    "user 3f8a2b1c-0000-4444-8888-abcdefabcdef was granted mcp.tool.read",
    "notified dhruv@example.com about the pending approval",
    "routed to claude-opus-4-20260101 after gpt-4o-mini exceeded the budget",
    "rule mcp.allow.default -> allow; chain [org-default, project-override]",
    "cost $12.4501 over 1200 input tokens and 340 output tokens",
    "workflow stage plan-signoff approved by team 'platform' at 2026-09-06T00:00:00.000Z",
    "the key insight is that caching dominates the cost",
    "we store secrets in the encrypted vault, never in git",
    "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "",
  ];

  it("returns every ordinary string BY IDENTITY — not rebuilt, not re-encoded", () => {
    for (const s of ORDINARY) expect(scrubAuditText(s), JSON.stringify(s)).toBe(s);
  });

  it("returns an unchanged detail object BY IDENTITY, structure and all", () => {
    const detail = {
      phase: "dispatch",
      tokensIn: 1200,
      tokensOut: 340,
      tokenCount: 5,
      totalTokens: 1540,
      apiKeyId: "7f2c1e90-0000-4000-8000-000000000001",
      scimTokenName: "okta-prod",
      secretsScanned: 12,
      model: "claude-opus-4",
      nested: { ruleChain: ["org-default", "project-override"], ok: true, n: null },
      arr: [1, "two", false, null],
    };
    expect(scrubAuditDetail(detail)).toBe(detail);
  });

  it("returns the ROW itself by identity when nothing matched", () => {
    const row = { detail: { a: 1 }, reason: "nothing to see", toolName: "search_docs" };
    expect(scrubAuditRow(row)).toBe(row);
  });

  it("never INTRODUCES a column the caller did not set", () => {
    const row: { reason: string; toolName?: string } = { reason: `leaked ${AWS_KEY}` };
    const out = scrubAuditRow(row);
    expect(out).not.toBe(row);
    expect(Object.keys(out).sort()).toEqual(["reason"]);
    expect(out.reason).not.toContain(AWS_KEY);
  });
});

describe("field-name redaction — the only path that can catch a SHAPELESS credential", () => {
  it("redacts by name whatever the value looks like (bootstrap token, data key)", () => {
    const out = scrubAuditDetail({
      bootstrapToken: "seed-bootstrap",
      dataKey: "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==",
      credentials: "whatever the vendor issued",
    }) as Record<string, string>;
    expect(out.bootstrapToken).toMatch(/^\[redacted:field:\d+:[0-9a-f]{12}\]$/);
    expect(out.dataKey).not.toContain("YWFhYWFh");
    expect(out.credentials).not.toContain("vendor issued");
  });

  it("matches the key name EXACTLY — `token` goes, `tokensIn`/`tokenCount` stay", () => {
    const detail = { token: "opaque-value-no-shape", tokensIn: 1200, tokenCount: 5, tokenBudget: "12000" };
    const out = scrubAuditDetail(detail) as Record<string, unknown>;
    expect(out.token).not.toBe("opaque-value-no-shape");
    expect(out.tokensIn).toBe(1200);
    expect(out.tokenCount).toBe(5);
    expect(out.tokenBudget).toBe("12000");
  });

  it("only fires on STRING values — a numeric `token` is a count and stays a count", () => {
    expect((scrubAuditDetail({ token: 1200 }) as { token: number }).token).toBe(1200);
  });

  it("reaches any depth, and through arrays", () => {
    const out = scrubAuditDetail({ a: [{ b: { password: "s3cr3t-value" } }] }) as {
      a: [{ b: { password: string } }];
    };
    expect(out.a[0].b.password).toContain("[redacted:field:");
  });
});

describe("no second, drifting copy of the credential rules", () => {
  it("the scrubber's rule set IS the DLP detector's credential-material subset", () => {
    const fromDetector = semanticDlpDetector.ruleIds.filter((id) => id.startsWith("dlp.secret."));
    expect(CREDENTIAL_MATERIAL_RULES.map((r) => r.id)).toEqual(fromDetector);
  });

  it("leaves the shared RegExps' lastIndex clean, so a later `detect()` is unaffected", () => {
    scrubAuditText(`${AWS_KEY} and ${AWS_KEY}`);
    for (const r of CREDENTIAL_MATERIAL_RULES) expect(r.re.lastIndex).toBe(0);
    expect(semanticDlpDetector.detect(`${AWS_KEY} ${AWS_KEY}`).some((h) => h.count === 2)).toBe(true);
  });
});
