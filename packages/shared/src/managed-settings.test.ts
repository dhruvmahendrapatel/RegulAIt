/**
 * ADR-0310 (G2) — the vendor compilers are default-deny, stable and refuse URLs that would leak credentials.
 */
import { describe, expect, it } from "vitest";
import { parse as parseToml } from "smol-toml";
import {
  canonicalPolicyJson,
  compileClaudeCode,
  compileCodex,
  compileCopilot,
  compileCursorWorksheet,
  compileManagedSettings,
  managedServerKey,
  type EffectiveMcpPolicy,
} from "./managed-settings.js";

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const none: EffectiveMcpPolicy = { subject: { kind: "user", id: "u1" }, servers: [] };
const two: EffectiveMcpPolicy = {
  subject: { kind: "user", id: "u1" },
  servers: [
    { serverId: S2, name: "Docs", gatewayUrl: `https://gw.example.com/mcp/${S2}`, tools: ["search", "read", "search"] },
    { serverId: S1, name: "GitHub", gatewayUrl: `https://gw.example.com/mcp/${S1}`, tools: ["list_issues"] },
  ],
};

describe("default deny", () => {
  it("emits an explicit empty allowlist for every vendor, never an absent key", () => {
    const cc = compileClaudeCode(none);
    expect(cc.allowedMcpServers).toEqual([]);
    expect(cc.allowManagedMcpServersOnly).toBe(true);
    expect(compileCopilot(none).allowedMcpServers).toEqual([]);
    const toml = compileCodex(none);
    expect(toml).toContain("[mcp_servers]");
    expect(parseToml(toml)).toEqual({ mcp_servers: {} });
    expect(compileCursorWorksheet(none)).toMatchObject({ allowlistActive: true, servers: [] });
  });

  it("locks bypass mode off", () => {
    expect(compileClaudeCode(two).permissions).toEqual({ disableBypassPermissionsMode: "disable" });
    expect(compileCopilot(two).permissions).toEqual({ disableBypassPermissionsMode: "disable" });
  });
});

describe("entitled servers", () => {
  it("names each server by its gateway URL, sorted, with sorted unique tools", () => {
    expect(compileClaudeCode(two).allowedMcpServers).toEqual([
      { serverUrl: `https://gw.example.com/mcp/${S1}` },
      { serverUrl: `https://gw.example.com/mcp/${S2}` },
    ]);
    const parsed = parseToml(compileCodex(two)) as { mcp_servers: Record<string, { identity: { url: string } }> };
    expect(parsed.mcp_servers[managedServerKey("GitHub", S1)]!.identity.url).toBe(`https://gw.example.com/mcp/${S1}`);
    expect(Object.keys(parsed.mcp_servers)).toHaveLength(2);
    expect((compileCursorWorksheet(two).servers as Array<{ tools: string[] }>)[1]!.tools).toEqual(["read", "search"]);
  });

  it("is byte-stable whatever the input order", () => {
    const shuffled: EffectiveMcpPolicy = { ...two, servers: [...two.servers].reverse() };
    expect(compileManagedSettings(shuffled)).toEqual(compileManagedSettings(two));
    expect(canonicalPolicyJson(shuffled)).toBe(canonicalPolicyJson(two));
  });

  it("pins a Claude Code minimum version only when asked, and only as x.y.z", () => {
    expect(compileClaudeCode(two)).not.toHaveProperty("requiredMinimumVersion");
    expect(compileClaudeCode(two, { claudeCodeMinimumVersion: "2.1.300" }).requiredMinimumVersion).toBe("2.1.300");
    expect(() => compileClaudeCode(two, { claudeCodeMinimumVersion: "latest" })).toThrow(/x\.y\.z/);
  });
});

describe("refusals", () => {
  const withUrl = (u: string): EffectiveMcpPolicy => ({ ...none, servers: [{ serverId: S1, name: "x", gatewayUrl: u, tools: [] }] });
  it.each([
    ["http://gw.example.com/mcp/x", /https/],
    ["https://user:pw@gw.example.com/mcp/x", /credentials/],
    ["https://gw.example.com/mcp/x?token=abc", /query/],
    ["not a url", /unparseable/],
    ["https://*.example.com/mcp/x", /'\*'/],
  ])("refuses %s", (u, re) => {
    expect(() => compileManagedSettings(withUrl(u))).toThrow(re);
  });

  it("allows plain http only on loopback (local development)", () => {
    expect(() => compileManagedSettings(withUrl("http://localhost:8080/mcp/x"))).not.toThrow();
  });
});

describe("managedServerKey", () => {
  it("keeps to [A-Za-z0-9_-] and disambiguates names that slug alike", () => {
    expect(managedServerKey("My Docs!", S1)).toMatch(/^[a-z0-9_-]+$/);
    expect(managedServerKey("My Docs", S1)).not.toBe(managedServerKey("my-docs", S2));
    expect(managedServerKey("***", S1)).toBe("server-11111111");
  });
});
