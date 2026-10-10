import { describe, expect, it } from "vitest";
import { findMcpEndpoints, MCP_DISCOVERY_POSTURE, scrubEvidenceSample } from "./mcp-discovery.js";
import { AUDIT_SCRUB_MARKER_PREFIX } from "./audit-scrub.js";

/**
 * ADR-0122 — the tests that matter here are the NEGATIVE ones.
 *
 * A discovery feature is judged on what it does NOT report. `/sse` is a
 * convention MCP shares with plenty of ordinary streaming endpoints, so the
 * file below spends more assertions on traffic that must stay silent, and on
 * the confidence grade, than on the happy path.
 */

describe("finding MCP endpoints in supplied evidence", () => {
  it("finds a tool INVOCATION and grades it high, with the host read off the line", () => {
    const log = [
      `2026-09-24T10:00:01Z POST https://tools.internal.corp/mcp 200 {"jsonrpc":"2.0","method":"tools/call","params":{}}`,
    ].join("\n");
    const found = findMcpEndpoints(log);
    expect(found).toHaveLength(1);
    expect(found[0]!.host).toBe("tools.internal.corp");
    expect(found[0]!.path).toBe("/mcp");
    expect(found[0]!.confidence).toBe("high");
    expect(found[0]!.indicators).toContain("jsonrpc-tools-call");
    expect(found[0]!.indicators).toContain("transport-path:/mcp");
  });

  it("grades a BARE transport path medium — a path is a convention, not a proof", () => {
    const found = findMcpEndpoints("2026-09-24 GET https://maybe.internal.corp/sse 200");
    expect(found).toHaveLength(1);
    expect(found[0]!.confidence).toBe("medium");
    // and it says WHY, rather than emitting a number on its own
    expect(found[0]!.indicators).toEqual(["transport-path:/sse"]);
  });

  it("the protocol-version header alone is enough, and is graded high", () => {
    const found = findMcpEndpoints(
      `POST https://gw.example.com/api 200 "MCP-Protocol-Version: 2026-03-26"`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.confidence).toBe("high");
    expect(found[0]!.indicators).toContain("protocol-version-header");
    // no transport path was present, and it does not invent one
    expect(found[0]!.path).toBeNull();
  });

  it("STAYS SILENT on ordinary traffic — the assertion this feature lives or dies on", () => {
    const noise = [
      "2026-09-24 GET https://www.example.com/index.html 200",
      "2026-09-24 POST https://api.stripe.com/v1/charges 200",
      "2026-09-24 GET https://cdn.example.com/assets/app.js 200",
      // a path that merely STARTS with the segment must not match
      "2026-09-24 GET https://example.com/mcpartner/signup 200",
      // no host at all
      "a line with no url whatsoever",
      "",
    ].join("\n");
    expect(findMcpEndpoints(noise)).toEqual([]);
  });

  it("does not fire on the word 'mcp' appearing in a query string or filename", () => {
    const found = findMcpEndpoints(
      [
        "GET https://example.com/search?q=mcp 200",
        "GET https://example.com/downloads/mcp-guide.pdf 200",
      ].join("\n"),
    );
    expect(found).toEqual([]);
  });

  it("collapses repeat lines onto one host, counting them and bounding the samples", () => {
    const lines = Array.from(
      { length: 9 },
      (_, i) => `POST https://tools.internal.corp/mcp 200 req-${i}`,
    ).join("\n");
    const found = findMcpEndpoints(lines);
    expect(found).toHaveLength(1);
    expect(found[0]!.occurrences).toBe(9);
    // bounded: an operator gets enough to judge, not the whole log back
    expect(found[0]!.samples.length).toBeLessThanOrEqual(3);
  });

  it("separates distinct hosts rather than merging them", () => {
    const log = [
      `POST https://a.internal.corp/mcp 200 {"method":"initialize"}`,
      `POST https://b.internal.corp/mcp 200 {"method":"tools/list"}`,
    ].join("\n");
    const found = findMcpEndpoints(log).sort((x, y) => x.host.localeCompare(y.host));
    expect(found.map((f) => f.host)).toEqual(["a.internal.corp", "b.internal.corp"]);
  });

  it("reads a host:port proxy format as well as a full URL", () => {
    const found = findMcpEndpoints(`CONNECT tools.internal.corp:8443 /mcp 200`);
    expect(found).toHaveLength(1);
    expect(found[0]!.host).toBe("tools.internal.corp");
  });

  it("states its own posture rather than leaving it to be inferred", () => {
    expect(MCP_DISCOVERY_POSTURE).toMatch(/Nothing is scanned, resolved, crawled or connected to/);
    expect(MCP_DISCOVERY_POSTURE).toMatch(/not a\s+claim to have searched your estate/);
  });
});

/**
 * AER-020 — the samples are SCRUBBED, and scrubbed BEFORE they are truncated.
 *
 * Every row below is a secret or a formatted identifier a proxy export would
 * carry verbatim. Each is planted twice: once early on the line, where the
 * old `line.slice(0, 200)` would have returned it whole, and once BEHIND 190
 * characters of ordinary log text, where the old slice would have returned
 * its first few characters — enough for a human to finish. The assertion is
 * the same both times: no window of the secret survives in the sample.
 */
const CORPUS: readonly { label: string; secret: string; line: (secret: string) => string }[] = [
  { label: "AWS access key id", secret: "AKIAIOSFODNN7EXAMPLE",
    line: (s) => `POST https://tools.corp/mcp 200 x-amz-key=${s} {"jsonrpc":"2.0","method":"tools/call"}` },
  { label: "OpenAI-style sk- key in a query string", secret: "sk-" + "Ab3dEf7gH1jKl9MnOpQrStUvWxYz0123456789",
    line: (s) => `GET https://tools.corp/sse?api_key=${s} 200` },
  { label: "GitHub personal token", secret: "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8",
    line: (s) => `POST https://tools.corp/mcp 200 {"jsonrpc":"2.0","method":"tools/call","params":{"token":"${s}"}}` },
  { label: "Slack bot token", secret: "xoxb-" + "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx",
    line: (s) => `POST https://tools.corp/mcp 200 slack=${s} {"jsonrpc":"2.0","method":"initialize"}` },
  { label: "JWT", secret: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    line: (s) => `POST https://tools.corp/mcp 200 "Authorization: Bearer ${s}"` },
  { label: "opaque bearer token in the Authorization header (header shape, space-separated)", secret: "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e",
    line: (s) => `POST https://tools.corp/mcp 200 "Authorization: Bearer ${s}"` },
  { label: "Basic auth header value", secret: "dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk",
    line: (s) => `POST https://tools.corp/messages 200 Authorization: Basic ${s}` },
  { label: "bare 40-hex token in a ?token= query string (no vendor prefix)", secret: "4f1c9a2e7b3d8e6f0a5c2b9d1e8f7a6c3b4d5e6f",
    line: (s) => `GET https://tools.corp/sse?token=${s} 200` },
  { label: "bare signature in a &sig= query parameter", secret: "Qm9ndXNTaWduYXR1cmVWYWx1ZTEyMzQ1Njc4OTA",
    line: (s) => `GET https://tools.corp/messages?session=abc123&sig=${s} 200` },
  { label: "X-Auth-Token header value", secret: "7d2f9c1b4a8e6f3d0c5b2a9e8d7f6c1b3a4e5d6f",
    line: (s) => `POST https://tools.corp/mcp 200 X-Auth-Token: ${s}` },
  { label: "X-Api-Key header value", secret: "regulait-test-key-0123456789abcdef",
    line: (s) => `POST https://tools.corp/mcp 200 x-api-key: ${s}` },
  { label: "bare token in a JSON-RPC argument", secret: "c3a1e5f7b9d2468ace0f13579bdf2468ace13579",
    line: (s) => `POST https://tools.corp/mcp 200 {"jsonrpc":"2.0","method":"tools/call","params":{"arguments":{"token":"${s}"}}}` },
  { label: "client secret in a JSON body (camelCase)", secret: "S3cr3t-Value-With-Enough-Length-To-Be-Real",
    line: (s) => `POST https://tools.corp/mcp 200 {"clientSecret":"${s}","grant_type":"client_credentials"}` },
  { label: "this product's own API key", secret: "rgl_" + "0123456789abcdef0123456789abcdef",
    line: (s) => `POST https://tools.corp/mcp 200 "authorization: Bearer ${s}"` },
  { label: "api_key assignment", secret: "Zq8vLm2PxR7tWy4KbN6s",
    line: (s) => `POST https://tools.corp/mcp 200 api_key=${s} {"jsonrpc":"2.0","method":"tools/call"}` },
  { label: "e-mail address", secret: "jane.doe@customer-bank.example",
    line: (s) => `POST https://tools.corp/mcp 200 {"jsonrpc":"2.0","method":"tools/call","params":{"arguments":{"to":"${s}"}}}` },
  { label: "credit-card-shaped (Luhn-valid) number", secret: "4111 1111 1111 1111",
    line: (s) => `POST https://tools.corp/mcp 200 {"jsonrpc":"2.0","method":"tools/call","params":{"arguments":{"card":"${s}"}}}` },
];

/** Where the secret is made to START: 12 characters before the 200-character
 * cut, so a truncate-then-scrub order would keep a 12-character fragment —
 * long enough to be caught by the 8-character windows below. */
const STRADDLE_START = 188;
/** Prepend ordinary log text so the secret begins exactly at STRADDLE_START. */
function straddling(line: string, secret: string): string {
  const at = line.indexOf(secret);
  const filler = "GET https://tools.corp/mcp 200 ".padEnd(Math.max(0, STRADDLE_START - at), "-");
  const out = filler + line;
  expect(out.indexOf(secret)).toBe(STRADDLE_START);
  return out;
}

/** every 8-character window of the secret — a fragment is a leak too */
function windows(secret: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 8 <= secret.length; i += 1) out.push(secret.slice(i, i + 8));
  return out;
}

describe("AER-020 — evidence samples are scrubbed before truncation", () => {
  it.each(CORPUS)("$label never reaches the sample, early on the line", ({ secret, line }) => {
    const found = findMcpEndpoints(line(secret));
    expect(found).toHaveLength(1);
    const sample = found[0]!.samples[0]!;
    expect(sample).not.toContain(secret);
    for (const w of windows(secret)) expect(sample).not.toContain(w);
    // positive control: the sample is still a sample, the host still reads
    expect(sample.length).toBeGreaterThan(0);
    expect(found[0]!.host).toBe("tools.corp");
  });

  it.each(CORPUS)("$label never reaches the sample when it straddles the 200-character cut", ({ secret, line }) => {
    // the secret starts at 188 and would have been cut mid-token by a
    // truncate-then-scrub order — exactly the fragment the old code leaked
    const found = findMcpEndpoints(straddling(line(secret), secret));
    expect(found).toHaveLength(1);
    const sample = found[0]!.samples[0]!;
    expect(sample.length).toBeLessThanOrEqual(200);
    expect(sample).not.toContain(secret);
    for (const w of windows(secret)) expect(sample).not.toContain(w);
  });

  it("the credential markers keep the KIND and lose the value", () => {
    const out = scrubEvidenceSample(`x-amz-key=AKIAIOSFODNN7EXAMPLE "Authorization: Bearer 9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e" to=jane.doe@customer-bank.example`);
    expect(out).toContain(`${AUDIT_SCRUB_MARKER_PREFIX}aws_key:20:`);
    // ADR-0189 B7 review: the audit scrub's own bearer_token rule now takes the header value first
    expect(out).toContain(`Bearer ${AUDIT_SCRUB_MARKER_PREFIX}bearer_token:40:`);
    expect(out).toContain("[EMAIL]");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e");
    expect(out).not.toContain("jane.doe");
  });

  it("a bare credential value is scrubbed by the NAME it travels under, keeping the name", () => {
    const out = scrubEvidenceSample(`GET https://tools.corp/sse?token=4f1c9a2e7b3d8e6f0a5c2b9d1e8f7a6c3b4d5e6f&q=weather 200 X-Auth-Token: 7d2f9c1b4a8e6f3d0c5b2a9e8d7f6c1b3a4e5d6f`);
    expect(out).toContain(`?token=${AUDIT_SCRUB_MARKER_PREFIX}credential_value:40:`);
    // the shared assignment rule may claim the header first — either marker
    // is fine, the value is what must be gone
    expect(out).toMatch(new RegExp(`X-Auth-Token: \\${AUDIT_SCRUB_MARKER_PREFIX}(credential_value|assignment):40:`));
    expect(out).toContain("&q=weather");
    expect(out).not.toContain("4f1c9a2e7b3d8e6f0a5c2b9d1e8f7a6c3b4d5e6f");
    expect(out).not.toContain("7d2f9c1b4a8e6f3d0c5b2a9e8d7f6c1b3a4e5d6f");
    // a short value under the same name is a word, not a secret, and stays
    expect(scrubEvidenceSample("GET https://tools.corp/sse?key=weather 200")).toContain("key=weather");
  });

  it("NEGATIVE CONTROL — an ordinary line is returned unchanged, so the scrub is a scrub and not a shredder", () => {
    const plain = `2026-09-24T10:00:01Z POST https://tools.internal.corp/mcp 200 {"jsonrpc":"2.0","method":"tools/call","params":{"name":"search","arguments":{"q":"quarterly report 2026"}}}`;
    expect(scrubEvidenceSample(plain)).toBe(plain);
    const found = findMcpEndpoints(plain);
    expect(found[0]!.samples[0]).toBe(plain);
  });
});

