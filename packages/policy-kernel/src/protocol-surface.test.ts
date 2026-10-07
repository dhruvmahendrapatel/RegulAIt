/**
 * ADR-0185 G3 — a READ-ONLY-ALL server grant never covers a protocol method.
 *
 * The red proof: put `tool.kind === "read"` back as the only test in the two
 * read-only-all branches and the first two cases below allow `mcp:resources`
 * on the strength of a grant issued for read TOOLS.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_DENY_RULE_ID, evaluate, type ToolRef } from "./index.js";

const EXEC = { mode: "normal" } as const;
const USER = "user-a";
const SERVER = "server-1";
const resources: ToolRef = { serverId: SERVER, name: "mcp:resources", kind: "read", surface: "protocol" };
const logging: ToolRef = { serverId: SERVER, name: "mcp:logging", kind: "write", surface: "protocol" };
const base = { execution: EXEC, userId: USER, serverId: SERVER, toolGrants: [], serverGrants: [] };

describe("ADR-0185 G3 — protocol surface in the kernel", () => {
  it("a direct read-only-all server grant does NOT allow a protocol read", () => {
    const d = evaluate({
      ...base,
      tool: resources,
      serverGrants: [{ id: "sg-1", userId: USER, serverId: SERVER, readOnlyAll: true }],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    expect(d.ruleChain).toContainEqual({ rule: "server-read-only-all", outcome: "no-match" });
  });

  it("a role read-only-all server grant does NOT allow a protocol read", () => {
    const d = evaluate({
      ...base,
      tool: resources,
      roleServerGrants: [{ id: "rsg-1", roleId: "r", serverId: SERVER, readOnlyAll: true }],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleChain).toContainEqual({ rule: "role-server-read-only-all", outcome: "no-match" });
  });

  it("the same grant still allows an ordinary read tool (surface absent or 'tool')", () => {
    const sg = { id: "sg-1", userId: USER, serverId: SERVER, readOnlyAll: true };
    for (const tool of [
      { serverId: SERVER, name: "get_time", kind: "read" } as ToolRef,
      { serverId: SERVER, name: "get_time", kind: "read", surface: "tool" } as ToolRef,
    ]) {
      expect(evaluate({ ...base, tool, serverGrants: [sg] }).effect).toBe("allow");
    }
  });

  it("a grant BY NAME allows the protocol method", () => {
    const d = evaluate({
      ...base,
      tool: resources,
      toolGrants: [{ id: "tg-1", userId: USER, serverId: SERVER, toolName: "mcp:resources" }],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("tg-1");
  });

  it("a grant for one protocol name does not cover another", () => {
    const d = evaluate({
      ...base,
      tool: logging,
      toolGrants: [{ id: "tg-1", userId: USER, serverId: SERVER, toolName: "mcp:resources" }],
    });
    expect(d.effect).toBe("deny");
  });

  it("resources/read is scoped by data-scope rules on `uri`, exact match", () => {
    const grant = { id: "tg-1", userId: USER, serverId: SERVER, toolName: "mcp:resources" };
    const rule = {
      id: "ds-1",
      userId: USER,
      serverId: SERVER,
      toolName: "mcp:resources",
      argPath: "uri",
      allowedValues: ["file:///public/readme.md"],
    };
    const decide = (uri: string) =>
      evaluate({ ...base, tool: resources, toolGrants: [grant], dataScopeRules: [rule], args: { uri } });
    expect(decide("file:///public/readme.md").effect).toBe("allow");
    expect(decide("file:///public/readme.md.bak").effect).toBe("deny");
    expect(decide("file:///public/README.md").effect).toBe("deny");
  });
});
