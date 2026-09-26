/**
 * INDEPENDENT check by the reviewing session. CEF's escaping is the one place a
 * log parser quietly produces plausible garbage: a naive split on the separator
 * tears a field in half wherever the value legitimately CONTAINS that separator,
 * and the result still looks like a well-formed record.
 *
 * So this asserts two things at once: the parser gets it right, AND the naive
 * approach gets it wrong on the very same input. The second half is what makes
 * the first non-vacuous — without it, a parser that never had to handle an
 * escape would pass.
 */
import { describe, it, expect } from "vitest";
import { splitUnescaped, unescapeLogValue, parseCefLine, parseCefExtension } from "@regulait/shared";

// a device vendor and product that legitimately contain the pipe separator
const LINE =
  "CEF:0|Acme\\|Security|Proxy\\|NG|4.2|100|AI egress|5|" +
  "dst=api.openai.com suser=ada duser=a\\=b cnt=3";

describe("ADVERSARIAL: CEF escaping is handled, and naive splitting is not enough", () => {
  it("splitUnescaped respects a backslash-escaped separator; String.split does not", () => {
    const naive = "Acme\\|Security|Proxy".split("|");
    const careful = splitUnescaped("Acme\\|Security|Proxy", "|");
    expect(naive).toHaveLength(3);      // torn: the escaped pipe was treated as a separator
    expect(careful).toHaveLength(2);    // correct: one field, then the next
    expect(unescapeLogValue(careful[0]!)).toBe("Acme|Security");
  });

  it("parses a real CEF header whose vendor AND product both contain escaped pipes", () => {
    const r = parseCefLine(LINE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // the naive parser would shift every subsequent header field left by two
    expect(r.value.vendor).toBe("Acme|Security");
    expect(r.value.product).toBe("Proxy|NG");
    expect(r.value.deviceVersion).toBe("4.2");
    expect(r.value.name).toBe("AI egress");
  });

  it("an extension value containing an escaped '=' survives intact", () => {
    const bag = parseCefExtension("dst=api.openai.com duser=a\\=b cnt=3");
    expect(bag.get("dst")).toBe("api.openai.com");
    expect(bag.get("duser")).toBe("a=b");   // NOT "a" with a stray "b"
    expect(bag.get("cnt")).toBe("3");
  });

  it("a header with too few fields is refused, not silently half-parsed", () => {
    const r = parseCefLine("CEF:0|Acme|Proxy|4.2");
    expect(r.ok).toBe(false);
  });
});
