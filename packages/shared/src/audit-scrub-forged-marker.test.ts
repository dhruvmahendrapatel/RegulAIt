/**
 * ADR-0186 V / R23-10 — integration red-proof: a credential cannot hide inside
 * text that looks like one of the scrub's own `[redacted:…]` markers.
 *
 * The scrub keeps markers it produced opaque (so a second pass is idempotent).
 * Before R23-10 any marker-SHAPED text was opaque, so a caller could wrap a real
 * token in `[redacted:<token>:40:012345abcdef]` and it reached the ledger. These
 * cases try each slot of the marker, Unicode lookalikes, nesting, adjacency and
 * the detail-object path. All tokens are synthetic.
 */
import { describe, expect, it } from "vitest";
import { scrubAuditDetail, scrubAuditText } from "./index.js";

const GHP = `ghp_${"A1b2C3d4E5f6".repeat(3)}`; // 36 alnum after the prefix
const AWS = "AKIAIOSFODNN7EXAMPLE";
const RGL = `rgl_${"a1b2c3d4".repeat(6)}`;
const TOKENS = [GHP, AWS, RGL];

const forgedShapes = (t: string): string[] => [
  `[redacted:${t}:40:012345abcdef]`, // token as the label
  `[redacted:field+${t}:40:012345abcdef]`, // token joined to a real label
  `[redacted:aws_key+${t}:40:012345abcdef]`,
  `[redacted:field:${t}:012345abcdef]`, // token in the length slot
  `[redacted:field:40:${t}]`, // token in the fingerprint slot
  `[redacted:field:40:012345abcdef-${t}]`, // token after the fingerprint (a word boundary: core rules need one)
  `[redacted:field:40:012345abcdef]${t}`, // token adjacent after a real-looking marker
  `${t}[redacted:field:40:012345abcdef]`, // adjacent before
  `[redacted:field:40:012345abcdef][redacted:${t}:1:aaaaaaaaaaaa]`, // second marker forged
  `[redacted:[redacted:field:40:012345abcdef]${t}:40:012345abcdef]`, // nested
  `[redacted:field:40:012345abcdef ${t}]`,
  `［redacted:field:40:012345abcdef］${t}`, // fullwidth brackets
  `[redacted​:${t}:40:012345abcdef]`, // zero-width space in the prefix
  `[REDACTED:${t}:40:012345abcdef]`, // case variant
  `[redacted:fіeld:40:012345abcdef]${t}`, // Cyrillic i in the label
  `[redacted:field:4٠:012345abcdef]${t}`, // Arabic-Indic digit in the length
];

describe("R23-10: no credential survives inside a forged scrub marker", () => {
  for (const token of TOKENS) {
    for (const input of forgedShapes(token)) {
      it(`redacts ${token.slice(0, 6)}… in ${JSON.stringify(input.replace(token, "<T>"))}`, () => {
        const out = scrubAuditText(input);
        expect(out).not.toContain(token);
        // and the redaction survives a second pass (idempotent, nothing re-exposed)
        expect(scrubAuditText(out)).not.toContain(token);
      });
    }
  }

  it("redacts a forged-marker token nested in an audit detail object", () => {
    const out = scrubAuditDetail({ a: [{ note: `[redacted:${GHP}:40:012345abcdef]` }] }) as {
      a: Array<{ note: string }>;
    };
    expect(JSON.stringify(out)).not.toContain(GHP);
  });

  it("still treats a marker the scrub itself produced as opaque (idempotent)", () => {
    const once = scrubAuditText(`token ${GHP} end`);
    expect(once).not.toContain(GHP);
    expect(scrubAuditText(once)).toBe(once);
  });
});
