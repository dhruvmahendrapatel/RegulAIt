import { describe, expect, it } from "vitest";
import { detectPII, EMAIL_RE, redactPII, visitEmails } from "./pii.js";

// ADR-0184 review: EMAIL_RE scanned with RegExp.exec was quadratic on a long
// run of local-part characters with no usable `@` (40,000 characters: 1.7 s),
// and detectPII runs on every guardrailed prompt. visitEmails replaces the scan.

function regexSpans(text: string): Array<[number, number]> {
  const re = new RegExp(EMAIL_RE.source, EMAIL_RE.flags);
  const out: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push([m.index, m.index + m[0].length]);
  return out;
}
function linearSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  visitEmails(text, (s, e) => out.push([s, e]));
  return out;
}

describe("visitEmails finds exactly EMAIL_RE's matches", () => {
  it("on representative text", () => {
    for (const s of [
      "", "alice@example.com", "Contact: alice.b+tag@mail.example.co.uk, bob@x.io.", "a@b@c.com", "a@b.c", "a@b.co5",
      "x@y.com.z", "@example.com", "user@@example.com", "first.last@sub-domain.example.org then more",
      "mail me at ALICE@EXAMPLE.COM or carol%ops@ex-ample.net", "a@.com", "a@b..cc", "a@b.-cc.dd", "1@2.ab3cd",
    ]) {
      expect(linearSpans(s), JSON.stringify(s)).toEqual(regexSpans(s));
    }
  });

  it("on 20,000 generated strings", () => {
    const alphabet = ["a", "Z", "0", ".", "-", "_", "%", "+", "@", " ", ",", "co", "com", "é", "!", "x.io", "@b."];
    let seed = 17;
    const next = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296;
    for (let i = 0; i < 20000; i++) {
      let s = "";
      for (let j = 0, n = Math.floor(next() * 14); j < n; j++) s += alphabet[Math.floor(next() * alphabet.length)];
      expect(linearSpans(s), JSON.stringify(s)).toEqual(regexSpans(s));
    }
  });
});

describe("PII detection is linear on pathological input", () => {
  const N = 400_000;
  it("detectPII and redactPII on a long run with no usable @ finish well inside a second", () => {
    for (const s of ["ab.".repeat(N / 3), "ab.".repeat(N / 3) + "@x", "a".repeat(N) + "@", "a@".repeat(N / 2)]) {
      const t0 = performance.now();
      detectPII(s);
      redactPII(s);
      expect(performance.now() - t0, s.slice(0, 12)).toBeLessThan(1000);
    }
  });
});
