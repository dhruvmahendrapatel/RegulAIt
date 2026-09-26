/**
 * ADR-0071 — THE EVIDENCE FORMAT ADAPTERS, UNIT-TESTED AGAINST THEIR GRAMMARS.
 *
 * WHAT THIS FILE TRIES TO MAKE IMPOSSIBLE TO FAKE
 * ----------------------------------------------
 *  1. A PARSER THAT LOOKS RIGHT ON THE EASY CASE. Every grammar is exercised
 *     with its ESCAPED separators — `\|` in a CEF/LEEF header, `\=` inside a CEF
 *     extension value — and the naive `split()` result is asserted to be
 *     DIFFERENT, so a regression to string-splitting fails here rather than
 *     shipping a confident wrong host.
 *  2. A SILENTLY SMALLER RESULT. `rows.length + refusals.length === rowsParsed`
 *     is asserted on every adapter over a file that contains a bad line, and
 *     every refusal is asserted to carry the TRUE 1-based line number of the
 *     offending line — not its index among the good lines.
 *  3. A GUESS DRESSED AS A READING. An ambiguous date, an unknown epoch unit, a
 *     header set where two columns could both be the destination, a W3C log with
 *     no `#Fields:`, an origin-server access log with a path instead of a URL —
 *     each is asserted to REFUSE, naming what it wanted.
 *  4. AN ADAPTER THAT WIDENS WHAT AN IMPORT CAN SAY. A mapping naming a field
 *     ADR-0055's row schemas do not have is refused, and every accepted row is
 *     asserted to satisfy those same schemas.
 *  5. A CAPABILITY LIST THAT ONLY SAYS YES. Every registry entry must carry a
 *     `limits` string and a `verification` string, and every `published-spec`
 *     adapter must say IN ITS OWN TEXT that it has not been run against a real
 *     vendor export.
 */
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_ADAPTERS,
  EVIDENCE_ADAPTER_POSTURE,
  EvidenceFormatError,
  cefAdapter,
  describeEvidenceAdapters,
  egressLogRowSchema,
  genericMappedEvidenceAdapter,
  getEvidenceAdapter,
  inferEvidenceMapping,
  leefAdapter,
  numberedLines,
  parseCefExtension,
  parseCefLine,
  parseClfTimestamp,
  parseCountCell,
  parseEvidenceTimestamp,
  parseLeefLine,
  proxyCommonAdapter,
  resolveLeefDelimiter,
  splitUnescaped,
  tokenizeClf,
  tokenizeW3c,
  unescapeLogValue,
  w3cExtendedAdapter,
} from "./index.js";

/** the identity that is the whole claim that nothing was dropped */
function assertNothingDropped(r: { rows: unknown[]; refusals: unknown[]; rowsParsed: number }) {
  expect(r.rows.length + r.refusals.length).toBe(r.rowsParsed);
}

// ===========================================================================
// 1. The character-scanned primitives
// ===========================================================================

describe("the primitives are character scans, and they refuse rather than guess", () => {
  it("splits on unescaped separators only, and honours the split limit", () => {
    expect(splitUnescaped(String.raw`a\|b|c|d`, "|")).toEqual([String.raw`a\|b`, "c", "d"]);
    expect(splitUnescaped("a|b|c|d", "|", 2)).toEqual(["a", "b", "c|d"]);
  });

  it("unescapes the specified escapes and leaves everything else alone", () => {
    expect(unescapeLogValue(String.raw`a\|b\=c\\d\ne`)).toBe("a|b=c\\d\ne");
    expect(unescapeLogValue("plain text")).toBe("plain text");
  });

  it("reads epoch seconds and milliseconds, and refuses an epoch of unknown unit", () => {
    expect(parseEvidenceTimestamp("1785000000000")).toEqual({ ok: true, value: new Date(1785000000000).toISOString() });
    expect(parseEvidenceTimestamp("1785000000")).toEqual({ ok: true, value: new Date(1785000000000).toISOString() });
    const bad = parseEvidenceTimestamp("178500000");
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason).toMatch(/neither 10 .* nor 13/);
  });

  it("refuses the ambiguous date ADR-0069 refuses, for the same reason", () => {
    const bad = parseEvidenceTimestamp("07/08/2026");
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason).toMatch(/ambiguous/);
    expect(parseEvidenceTimestamp("2026-08-07T12:00:00Z").ok).toBe(true);
  });

  it("reads the NCSA bracket timestamp, which is unambiguous BECAUSE the month is spelled", () => {
    expect(parseClfTimestamp("07/Aug/2026:12:00:00 +0000")).toEqual({ ok: true, value: "2026-08-07T12:00:00.000Z" });
    // a +0530 offset must move the instant BACK to UTC, not forward
    expect(parseClfTimestamp("07/Aug/2026:12:00:00 +0530")).toEqual({ ok: true, value: "2026-08-07T06:30:00.000Z" });
    expect(parseClfTimestamp("07/Cat/2026:12:00:00 +0000").ok).toBe(false);
    expect(parseClfTimestamp("07/Aug/2026:12:00:00 +99").ok).toBe(false);
  });

  it("a count is digits — an accounting-style '(3)' is a corrupted log, not minus three", () => {
    expect(parseCountCell("3")).toEqual({ ok: true, value: 3 });
    expect(parseCountCell("(3)").ok).toBe(false);
    expect(parseCountCell("0").ok).toBe(false);
    expect(parseCountCell("").ok).toBe(false);
    expect(parseCountCell("3.5").ok).toBe(false);
  });

  it("numbers lines from 1 and does not renumber after a blank one", () => {
    const lines = numberedLines("a\n\nb\n");
    expect(lines.map((l) => l.line)).toEqual([1, 2, 3]);
    expect(lines[2]!.text).toBe("b");
  });
});

// ===========================================================================
// 2. CEF
// ===========================================================================

/** the fixture the whole slice turns on: an escaped pipe in TWO header fields
 * and an escaped equals inside an extension value, plus a space-bearing value
 * as the final pair. */
const CEF_ESCAPED = String.raw`<134>Aug  7 12:00:00 gw CEF:0|Acme\|Corp|Proxy\\Gateway|4.2|100|Egress to AI\|Model|5|rt=1785000000000 dhost=api.openai.com suser=alice\=admin cnt=3 msg=allowed by policy A`;

describe("CEF — the published grammar, including the escapes a naive split gets wrong", () => {
  it("parses an escaped header where split('|') demonstrably does not", () => {
    const rec = parseCefLine(CEF_ESCAPED);
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(rec.value.version).toBe("0");
    expect(rec.value.vendor).toBe("Acme|Corp");
    expect(rec.value.product).toBe("Proxy\\Gateway");
    expect(rec.value.deviceVersion).toBe("4.2");
    expect(rec.value.signatureId).toBe("100");
    expect(rec.value.name).toBe("Egress to AI|Model");
    expect(rec.value.severity).toBe("5");

    // THE CONTROL: the naive parse everyone writes first gets a different, and
    // wrong, answer. If this ever stops being true the fixture has gone soft.
    const naive = CEF_ESCAPED.slice(CEF_ESCAPED.indexOf("CEF:") + 4).split("|");
    expect(naive[1]).toBe("Acme\\");
    expect(naive[1]).not.toBe(rec.value.vendor);
  });

  it("parses an extension whose value contains an escaped '=' and whose last value contains spaces", () => {
    const ext = parseCefExtension(String.raw`rt=1785000000000 dhost=api.openai.com suser=alice\=admin cnt=3 msg=allowed by policy A`);
    expect(ext.get("dhost")).toBe("api.openai.com");
    expect(ext.get("suser")).toBe("alice=admin");
    expect(ext.get("cnt")).toBe("3");
    expect(ext.get("msg")).toBe("allowed by policy A");

    // the control again: splitting the extension on every '=' loses the value
    expect(String.raw`suser=alice\=admin`.split("=")[1]).toBe("alice\\");
  });

  it("produces an ADR-0055 egress_log row carrying the unescaped values", () => {
    const r = cefAdapter.parse({ content: CEF_ESCAPED, format: "text" });
    assertNothingDropped(r);
    expect(r.kind).toBe("egress_log");
    expect(r.refusals).toEqual([]);
    expect(r.rows).toEqual([
      {
        destinationHost: "api.openai.com",
        sourceIdentity: "alice=admin",
        observedAt: new Date(1785000000000).toISOString(),
        requestCount: 3,
      },
    ]);
    // and the row is one ADR-0055's OWN schema accepts — the adapter cannot
    // invent a row shape
    expect(egressLogRowSchema.safeParse(r.rows[0]).success).toBe(true);
    expect(r.fieldsUsed.sort()).toEqual(["cnt", "dhost", "rt", "suser"]);
  });

  it("refuses a malformed line NAMING ITS LINE NUMBER, and does not just return less", () => {
    const content = [
      "CEF:0|Acme|Proxy|4.2|100|allowed|5|dhost=api.openai.com suser=alice",
      "this line is not CEF at all",
      "CEF:0|Acme|Proxy|4.2|100|allowed|5|dhost=api.anthropic.com suser=bob",
    ].join("\n");
    const r = cefAdapter.parse({ content, format: "text" });
    assertNothingDropped(r);
    expect(r.rowsParsed).toBe(3);
    expect(r.rows).toHaveLength(2);
    expect(r.refusals).toHaveLength(1);
    expect(r.refusals[0]!.row).toBe(2);
    expect(r.refusals[0]!.reason).toMatch(/CEF:/);
  });

  it("refuses a header with too few pipes, naming the count and the escape rule", () => {
    const r = cefAdapter.parse({ content: "CEF:0|Acme|Proxy|4.2|100|allowed|dhost=api.openai.com", format: "text" });
    expect(r.rows).toEqual([]);
    expect(r.refusals[0]!.reason).toMatch(/not 7/);
    expect(r.refusals[0]!.reason).toMatch(/\\\|/);
  });

  it("refuses a record that names no destination, listing the keys it looked for AND the keys present", () => {
    const r = cefAdapter.parse({ content: "CEF:0|Acme|Proxy|4.2|100|allowed|5|suser=alice act=blocked", format: "text" });
    expect(r.rows).toEqual([]);
    expect(r.refusals[0]!.row).toBe(1);
    expect(r.refusals[0]!.reason).toMatch(/dhost/);
    expect(r.refusals[0]!.reason).toMatch(/suser/);
    expect(r.refusals[0]!.reason).toMatch(/will not infer/);
  });

  it("refuses a record whose timestamp cannot be read rather than stamping it with 'now'", () => {
    const r = cefAdapter.parse({ content: "CEF:0|A|P|1|1|x|5|dhost=api.openai.com rt=last tuesday", format: "text" });
    expect(r.rows).toEqual([]);
    expect(r.refusals[0]!.field).toBe("rt");
  });

  it("counts a row with no timestamp of its own rather than hiding it", () => {
    const r = cefAdapter.parse({ content: "CEF:0|A|P|1|1|x|5|dhost=api.openai.com suser=alice", format: "text" });
    expect(r.rows).toHaveLength(1);
    expect(r.rowsWithoutTimestamp).toBe(1);
  });

  it("falls back through the destination keys in the documented order", () => {
    const r = cefAdapter.parse({
      content: "CEF:0|A|P|1|1|x|5|request=https://api.openai.com/v1/chat src=10.0.0.5",
      format: "text",
    });
    expect(r.rows[0]).toMatchObject({ destinationHost: "https://api.openai.com/v1/chat", sourceIdentity: "10.0.0.5" });
  });
});

// ===========================================================================
// 3. LEEF
// ===========================================================================

describe("LEEF — 1.0 and 2.0, including the delimiter field it refuses to guess", () => {
  it("parses a tab-delimited 1.0 record with an escaped pipe in the product name", () => {
    const line = String.raw`LEEF:1.0|Acme|Secure\|Web|4.2|100|` + ["dst=api.openai.com", "usrName=alice", "devTime=1785000000000"].join("\t");
    const rec = parseLeefLine(line, "\t");
    expect(rec.ok).toBe(true);
    if (!rec.ok) return;
    expect(rec.value.product).toBe("Secure|Web");
    expect(rec.value.attributes.get("dst")).toBe("api.openai.com");

    const r = leefAdapter.parse({ content: line, format: "text" });
    assertNothingDropped(r);
    expect(r.rows).toEqual([
      { destinationHost: "api.openai.com", sourceIdentity: "alice", observedAt: new Date(1785000000000).toISOString() },
    ]);
  });

  it("honours a LEEF 2.0 delimiter field, and an escaped delimiter inside a value", () => {
    const line = String.raw`LEEF:2.0|Acme|Web|4.2|100|^|dstHostName=api.anthropic.com^usrName=team\^lead^cnt=7`;
    const r = leefAdapter.parse({ content: line, format: "text" });
    assertNothingDropped(r);
    expect(r.rows).toEqual([
      { destinationHost: "api.anthropic.com", sourceIdentity: "team^lead", requestCount: 7 },
    ]);
    expect(r.rowsWithoutTimestamp).toBe(1);
  });

  it("resolves the documented delimiter spellings and refuses anything else", () => {
    expect(resolveLeefDelimiter("x09")).toEqual({ ok: true, value: "\t" });
    expect(resolveLeefDelimiter("0x09")).toEqual({ ok: true, value: "\t" });
    expect(resolveLeefDelimiter("\\t")).toEqual({ ok: true, value: "\t" });
    expect(resolveLeefDelimiter("^")).toEqual({ ok: true, value: "^" });
    expect(resolveLeefDelimiter("delim").ok).toBe(false);
  });

  it("refuses a 2.0 line whose sixth field is not a delimiter, rather than assuming TAB", () => {
    const r = leefAdapter.parse({ content: "LEEF:2.0|Acme|Web|4.2|100|not-a-delimiter|dst=api.openai.com", format: "text" });
    expect(r.rows).toEqual([]);
    expect(r.refusals[0]!.reason).toMatch(/refuses the line/);
  });

  it("refuses a record that declares a devTimeFormat it will not guess at", () => {
    const line = ["LEEF:1.0|A|P|1|100|dst=api.openai.com", "devTime=Aug 07 2026 12:00:00", "devTimeFormat=MMM dd yyyy HH:mm:ss"].join("\t");
    const r = leefAdapter.parse({ content: line, format: "text" });
    expect(r.rows).toEqual([]);
    expect(r.refusals[0]!.field).toBe("devTimeFormat");
    expect(r.refusals[0]!.reason).toMatch(/moves evidence between reporting windows/);
  });

  it("accepts an operator-declared delimiter for a 1.0 producer that did not use TAB", () => {
    const r = leefAdapter.parse({
      content: "LEEF:1.0|A|P|1|100|dst=api.openai.com,usrName=bob",
      format: "text",
      config: { delimiter: "," },
    });
    expect(r.rows).toEqual([{ destinationHost: "api.openai.com", sourceIdentity: "bob" }]);
  });

  it("refuses the whole file when the operator's delimiter is not a delimiter", () => {
    expect(() => leefAdapter.parse({ content: "LEEF:1.0|A|P|1|100|dst=x", format: "text", config: { delimiter: "abcd" } })).toThrow(
      EvidenceFormatError,
    );
  });
});

// ===========================================================================
// 4. W3C extended
// ===========================================================================

const W3C_FILE = [
  "#Software: Acme Secure Web Gateway",
  "#Version: 1.0",
  "#Fields: date time c-ip cs-username cs-host sc-status",
  "2026-08-07 12:00:00 10.0.0.5 alice api.openai.com 200",
  "2026-08-07 12:00:01 10.0.0.6 bob github.com 200",
].join("\n");

describe("W3C extended — the field list comes from the file, never from us", () => {
  it("reads rows positioned by the file's own #Fields: directive", () => {
    const r = w3cExtendedAdapter.parse({ content: W3C_FILE, format: "text" });
    assertNothingDropped(r);
    expect(r.rowsParsed).toBe(2);
    expect(r.rows).toEqual([
      { destinationHost: "api.openai.com", sourceIdentity: "alice", observedAt: "2026-08-07T12:00:00.000Z" },
      { destinationHost: "github.com", sourceIdentity: "bob", observedAt: "2026-08-07T12:00:01.000Z" },
    ]);
  });

  it("honours a mid-file #Fields: redeclaration instead of misaligning every later row", () => {
    const content = [
      "#Fields: date time cs-host",
      "2026-08-07 12:00:00 api.openai.com",
      "#Fields: cs-host cs-username",
      "api.anthropic.com carol",
    ].join("\n");
    const r = w3cExtendedAdapter.parse({ content, format: "text" });
    assertNothingDropped(r);
    expect(r.rows).toEqual([
      { destinationHost: "api.openai.com", observedAt: "2026-08-07T12:00:00.000Z" },
      { destinationHost: "api.anthropic.com", sourceIdentity: "carol" },
    ]);
  });

  it("refuses the WHOLE FILE when there is no #Fields: directive, rather than reading positionally", () => {
    let err: unknown;
    try {
      w3cExtendedAdapter.parse({ content: "2026-08-07 12:00:00 10.0.0.5 api.openai.com", format: "text" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EvidenceFormatError);
    expect((err as EvidenceFormatError).message).toMatch(/#Fields:/);
    expect((err as EvidenceFormatError).detail.missing).toEqual(["#Fields:"]);
  });

  it("refuses a line whose token count disagrees with #Fields:, naming both counts", () => {
    const content = ["#Fields: date time cs-host", "2026-08-07 12:00:00 api.openai.com", "2026-08-07 12:00:01"].join("\n");
    const r = w3cExtendedAdapter.parse({ content, format: "text" });
    assertNothingDropped(r);
    expect(r.rows).toHaveLength(1);
    expect(r.refusals[0]!.row).toBe(3);
    expect(r.refusals[0]!.reason).toMatch(/2 field\(s\) but '#Fields:' declares 3/);
  });

  it("refuses a line whose 'destination' is a path — an origin-server log is not egress evidence", () => {
    const content = ["#Fields: date time cs-uri", "2026-08-07 12:00:00 /v1/chat/completions"].join("\n");
    const r = w3cExtendedAdapter.parse({ content, format: "text" });
    expect(r.rows).toEqual([]);
    expect(r.refusals[0]!.reason).toMatch(/PATH, not a destination/);
  });

  it("treats the W3C '-' placeholder as absent rather than as a hostname", () => {
    const content = ["#Fields: date time cs-username cs-host", "2026-08-07 12:00:00 - api.openai.com"].join("\n");
    const r = w3cExtendedAdapter.parse({ content, format: "text" });
    expect(r.rows).toEqual([{ destinationHost: "api.openai.com", observedAt: "2026-08-07T12:00:00.000Z" }]);
  });

  it("tokenizes quoted W3C fields as one token", () => {
    expect(tokenizeW3c('a "b c" d')).toEqual(["a", "b c", "d"]);
  });
});

// ===========================================================================
// 5. Squid / NCSA
// ===========================================================================

describe("proxy_common — positional formats whose layout is asserted, never sniffed", () => {
  it("reads a Squid native access.log line, preferring the ident column over the client IP", () => {
    const content = [
      "1785000000.123    412 10.0.0.5 TCP_MISS/200 5321 POST http://api.openai.com/v1/chat alice DIRECT/1.2.3.4 application/json",
      "1785000001.000    121 10.0.0.6 TCP_MISS/200 900 CONNECT api.anthropic.com:443 - DIRECT/5.6.7.8 -",
    ].join("\n");
    const r = proxyCommonAdapter.parse({ content, format: "text", config: { layout: "squid" } });
    assertNothingDropped(r);
    expect(r.rows).toEqual([
      {
        destinationHost: "http://api.openai.com/v1/chat",
        sourceIdentity: "alice",
        observedAt: new Date(1785000000123).toISOString(),
      },
      {
        destinationHost: "api.anthropic.com:443",
        // no ident, so the client address is the actor — an IP, not a person
        sourceIdentity: "10.0.0.6",
        observedAt: new Date(1785000001000).toISOString(),
      },
    ]);
  });

  it("reads an NCSA combined forward-proxy line", () => {
    const line = '10.0.0.5 - alice [07/Aug/2026:12:00:00 +0000] "POST https://api.openai.com/v1/chat HTTP/1.1" 200 5321 "-" "curl/8.4"';
    const r = proxyCommonAdapter.parse({ content: line, format: "text", config: { layout: "combined" } });
    assertNothingDropped(r);
    expect(r.rows).toEqual([
      { destinationHost: "https://api.openai.com/v1/chat", sourceIdentity: "alice", observedAt: "2026-08-07T12:00:00.000Z" },
    ]);
  });

  it("refuses an ORIGIN-server common-log line, because a path names no destination", () => {
    const line = '10.0.0.5 - - [07/Aug/2026:12:00:00 +0000] "GET /v1/chat HTTP/1.1" 200 5321';
    const r = proxyCommonAdapter.parse({ content: line, format: "text", config: { layout: "common" } });
    expect(r.rows).toEqual([]);
    expect(r.refusals[0]!.reason).toMatch(/ORIGIN server/);
    expect(r.refusals[0]!.field).toBe("request");
  });

  it("refuses a line with the wrong field count instead of aligning it by position", () => {
    const content = [
      '10.0.0.5 - alice [07/Aug/2026:12:00:00 +0000] "POST https://api.openai.com/v1/chat HTTP/1.1" 200 5321',
      '10.0.0.6 - bob [07/Aug/2026:12:00:01 +0000] "POST https://api.anthropic.com/v1/messages HTTP/1.1" 200',
    ].join("\n");
    const r = proxyCommonAdapter.parse({ content, format: "text", config: { layout: "common" } });
    assertNothingDropped(r);
    expect(r.rows).toHaveLength(1);
    expect(r.refusals[0]!.row).toBe(2);
    expect(r.refusals[0]!.reason).toMatch(/has 6/);
  });

  it("refuses a line that opens a quoted field it never closes", () => {
    const line = '10.0.0.5 - alice [07/Aug/2026:12:00:00 +0000] "POST https://api.openai.com/v1/chat HTTP/1.1 200 5321';
    const r = proxyCommonAdapter.parse({ content: line, format: "text", config: { layout: "common" } });
    expect(r.rows).toEqual([]);
    expect(r.refusals[0]!.reason).toMatch(/never closes/);
  });

  it("requires the layout — there is no default to be silently wrong about", () => {
    expect(() => proxyCommonAdapter.parse({ content: "x", format: "text" })).toThrow();
  });

  it("keeps bracketed and quoted groups whole when tokenizing", () => {
    expect(tokenizeClf('a [b c] "d e" f').tokens).toEqual(["a", "b c", "d e", "f"]);
    expect(tokenizeClf('a "b').unterminated).toBe(true);
  });
});

// ===========================================================================
// 6. generic_mapped — the one that will actually get used
// ===========================================================================

describe("generic_mapped — maps what you name, refuses what it would have to guess", () => {
  it("infers an unambiguous mapping and produces egress_log rows", () => {
    const csv = ["timestamp,user,destination,requests", "2026-08-07T12:00:00Z,alice@example.com,api.openai.com,42"].join("\n");
    const r = genericMappedEvidenceAdapter.parse({ content: csv, format: "csv", config: { kind: "egress_log" } });
    assertNothingDropped(r);
    expect(r.rows).toEqual([
      {
        destinationHost: "api.openai.com",
        sourceIdentity: "alice@example.com",
        observedAt: "2026-08-07T12:00:00.000Z",
        requestCount: 42,
      },
    ]);
  });

  it("REFUSES an ambiguous destination column rather than picking one", () => {
    const csv = ["user,host,url", "alice,api.openai.com,https://api.openai.com/v1"].join("\n");
    const inferred = inferEvidenceMapping("egress_log", ["user", "host", "url"]);
    expect(inferred.ok).toBe(false);
    expect(inferred.ok === false && inferred.reason).toMatch(/ambiguous/);
    expect(() => genericMappedEvidenceAdapter.parse({ content: csv, format: "csv", config: { kind: "egress_log" } })).toThrow(
      EvidenceFormatError,
    );
  });

  it("takes an explicit mapping over the ambiguity, and names a mapped column the file lacks", () => {
    const csv = ["user,host,url", "alice,api.openai.com,https://api.openai.com/v1"].join("\n");
    const ok = genericMappedEvidenceAdapter.parse({
      content: csv,
      format: "csv",
      config: { kind: "egress_log", mapping: { destinationHost: "host", sourceIdentity: "user" } },
    });
    expect(ok.rows).toEqual([{ destinationHost: "api.openai.com", sourceIdentity: "alice" }]);

    let err: unknown;
    try {
      genericMappedEvidenceAdapter.parse({
        content: csv,
        format: "csv",
        config: { kind: "egress_log", mapping: { destinationHost: "fqdn" } },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EvidenceFormatError);
    expect((err as EvidenceFormatError).message).toMatch(/destinationHost -> 'fqdn'/);
  });

  it("refuses a mapping naming a field ADR-0055's row schemas do not have", () => {
    const csv = ["host,severity", "api.openai.com,critical"].join("\n");
    let err: unknown;
    try {
      genericMappedEvidenceAdapter.parse({
        content: csv,
        format: "csv",
        config: { kind: "egress_log", mapping: { destinationHost: "host", severity: "severity" } },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EvidenceFormatError);
    expect((err as EvidenceFormatError).message).toMatch(/cannot widen it/);
  });

  it("refuses a row whose required cell is empty, naming the column and the line", () => {
    const csv = ["destination,user", "api.openai.com,alice", ",bob"].join("\n");
    const r = genericMappedEvidenceAdapter.parse({ content: csv, format: "csv", config: { kind: "egress_log" } });
    assertNothingDropped(r);
    expect(r.rows).toHaveLength(1);
    expect(r.refusals[0]!.row).toBe(3);
    expect(r.refusals[0]!.field).toBe("destination");
    expect(r.refusals[0]!.reason).toMatch(/would invent an observation/);
  });

  it("reads JSON as well as CSV", () => {
    const json = JSON.stringify([{ destination: "api.openai.com", user: "alice", requests: 3 }]);
    const r = genericMappedEvidenceAdapter.parse({ content: json, format: "json", config: { kind: "egress_log" } });
    expect(r.rows).toEqual([{ destinationHost: "api.openai.com", sourceIdentity: "alice", requestCount: 3 }]);
  });

  it("produces the OTHER three evidence kinds too — including the SSO/CASB app-access shape", () => {
    const saas = ["application,app_host,granted_by,assignments", "ChatGPT Enterprise,chat.openai.com,carol@example.com,12"].join("\n");
    const r1 = genericMappedEvidenceAdapter.parse({ content: saas, format: "csv", config: { kind: "saas_export" } });
    expect(r1.rows).toEqual([
      { appName: "ChatGPT Enterprise", vendorHost: "chat.openai.com", grantedBy: "carol@example.com", installCount: 12 },
    ]);

    const code = ["repository,file,dependency", "acme/api,src/llm.ts,openai"].join("\n");
    const r2 = genericMappedEvidenceAdapter.parse({ content: code, format: "csv", config: { kind: "code_scan" } });
    expect(r2.rows).toEqual([{ repo: "acme/api", path: "src/llm.ts", packageName: "openai" }]);

    const declared = ["team,service,vendor,notes", "payments,invoice-summariser,anthropic,pilot"].join("\n");
    const r3 = genericMappedEvidenceAdapter.parse({ content: declared, format: "csv", config: { kind: "self_reported" } });
    expect(r3.rows).toEqual([{ owner: "payments", system: "invoice-summariser", provider: "anthropic", note: "pilot" }]);
  });

  it("refuses a code_scan row that observes nothing, through ADR-0055's OWN refinement", () => {
    const csv = ["repository,file", "acme/api,src/llm.ts"].join("\n");
    const r = genericMappedEvidenceAdapter.parse({ content: csv, format: "csv", config: { kind: "code_scan" } });
    assertNothingDropped(r);
    expect(r.rows).toEqual([]);
    expect(r.refusals[0]!.reason).toMatch(/packageName or a keyFragment/);
  });

  it("will not read line-oriented log text", () => {
    expect(() => genericMappedEvidenceAdapter.parse({ content: "CEF:0|a", format: "text", config: { kind: "egress_log" } })).toThrow(
      EvidenceFormatError,
    );
  });
});

// ===========================================================================
// 7. The registry, and the honesty rule it is required to carry
// ===========================================================================

describe("the registry states what it cannot do", () => {
  it("resolves adapters by id and knows nothing else", () => {
    expect(getEvidenceAdapter("cef")).toBe(cefAdapter);
    expect(getEvidenceAdapter("zscaler")).toBeUndefined();
  });

  it("every adapter declares limits, a verification claim, and at least one evidence kind", () => {
    for (const a of describeEvidenceAdapters()) {
      expect(a.limits.length).toBeGreaterThan(120);
      expect(a.verification.length).toBeGreaterThan(80);
      expect(a.capabilities.kinds.length).toBeGreaterThan(0);
      expect(a.formats.length).toBeGreaterThan(0);
    }
    expect(describeEvidenceAdapters()).toHaveLength(EVIDENCE_ADAPTERS.length);
  });

  it("no adapter claims to have been verified against a live vendor export — the published-spec ones say so outright", () => {
    for (const a of describeEvidenceAdapters()) {
      if (a.formatBasis === "published-spec") {
        expect(a.verification).toMatch(/has NOT been run against a real export/);
      }
      // and no adapter may carry a verification claim with no disclaimer in it
      // at all: either it says what it has not been run against, or it says it
      // assumes nothing because the operator supplied the mapping.
      expect(a.verification).toMatch(/NOT been run against a real export|Assumes nothing about your file/);
    }
    expect(EVIDENCE_ADAPTER_POSTURE).toMatch(/ships no collector/);
    expect(EVIDENCE_ADAPTER_POSTURE).toMatch(/Coverage remains exactly what you exported/);
  });

  it("no adapter is named after a vendor whose export nobody here has seen", () => {
    const forbidden = ["zscaler", "netskope", "okta", "entra", "palo", "bluecoat", "forcepoint"];
    for (const a of EVIDENCE_ADAPTERS) {
      for (const name of forbidden) expect(a.id.toLowerCase()).not.toContain(name);
    }
  });
});
