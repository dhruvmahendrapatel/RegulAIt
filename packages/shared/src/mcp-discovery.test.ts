import { describe, expect, it } from "vitest";
import { findMcpEndpoints, MCP_DISCOVERY_POSTURE } from "./mcp-discovery.js";

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
