import { describe, expect, it } from "vitest";
import { allowedMcpOrigin, MCP_BATCH_REFUSAL, mcpBatchRefused, mcpOriginRefusal } from "./mcp-conformance.js";

describe("ADR-0311: the MCP transport rules the gateway enforces itself", () => {
  it("accepts no Origin (not a browser), its own public origin, and refuses every other origin", () => {
    const pub = "https://gw.example.test/base";
    expect(allowedMcpOrigin(pub)).toBe("https://gw.example.test");
    expect(mcpOriginRefusal(undefined, pub)).toBeNull();
    expect(mcpOriginRefusal("https://gw.example.test", pub)).toBeNull();
    for (const o of ["https://evil.example.test", "http://gw.example.test", "https://gw.example.test:8443", "null", ""]) {
      expect(mcpOriginRefusal(o, pub)?.error).toBe("mcp_origin_refused");
    }
    expect(mcpOriginRefusal(["https://gw.example.test", "https://evil.example.test"], pub)?.status).toBe(403);
  });

  it("with no public URL, refuses any request that carries an Origin (strict when unknown)", () => {
    expect(mcpOriginRefusal(undefined, null)).toBeNull();
    expect(mcpOriginRefusal("http://localhost:3000", null)?.detail).toMatch(/no public URL/);
  });

  it("refuses a JSON-RPC batch from 2025-06-18 on, and leaves older clients and single messages alone", () => {
    const batch = [{ jsonrpc: "2.0", id: 1, method: "ping" }];
    expect(mcpBatchRefused(batch, "2025-06-18")).toBe(true);
    expect(mcpBatchRefused(batch, "2025-11-25")).toBe(true);
    expect(mcpBatchRefused(batch, "2026-07-28")).toBe(true);
    expect(mcpBatchRefused(batch, "2025-03-26")).toBe(false);
    expect(mcpBatchRefused(batch, undefined)).toBe(false);
    expect(mcpBatchRefused(batch, "not-a-version")).toBe(false);
    expect(mcpBatchRefused({ jsonrpc: "2.0", id: 1, method: "ping" }, "2025-11-25")).toBe(false);
    expect(MCP_BATCH_REFUSAL.error.code).toBe(-32600);
  });
});
