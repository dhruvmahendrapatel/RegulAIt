import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_RULE_ID,
  evaluate,
  visibleTools,
  type ServerGrant,
  type ToolGrant,
  type ToolRef,
} from "./index.js";

const USER = "user-a";
const OTHER_USER = "user-b";
const SERVER = "server-1";
const OTHER_SERVER = "server-2";

const readTool: ToolRef = { serverId: SERVER, name: "query_database", kind: "read" };
const writeTool: ToolRef = { serverId: SERVER, name: "drop_table", kind: "write" };

function toolGrant(overrides: Partial<ToolGrant> = {}): ToolGrant {
  return { id: "tg-1", userId: USER, serverId: SERVER, toolName: "query_database", ...overrides };
}

function serverGrant(overrides: Partial<ServerGrant> = {}): ServerGrant {
  return { id: "sg-1", userId: USER, serverId: SERVER, readOnlyAll: true, ...overrides };
}

describe("evaluate", () => {
  it("denies by default with no grants at all", () => {
    const d = evaluate({ userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [] });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    expect(d.ruleChain.map((t) => t.rule)).toEqual([
      "tool-allow-list",
      "server-read-only-all",
      "default-deny",
    ]);
    // The trace outcome must match the effect: a denying rule must never be
    // recorded as "allow" in the persisted audit ruleChain.
    expect(d.ruleChain.map((t) => t.outcome)).toEqual(["no-match", "no-match", "deny"]);
  });

  it("allows a tool on the user's explicit allow-list", () => {
    const g = toolGrant();
    const d = evaluate({ userId: USER, serverId: SERVER, tool: readTool, toolGrants: [g], serverGrants: [] });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe(g.id);
    expect(d.ruleChain).toEqual([{ rule: "tool-allow-list", outcome: "allow", grantId: g.id }]);
  });

  it("explicit allow-list works for write tools too", () => {
    const g = toolGrant({ toolName: "drop_table" });
    const d = evaluate({ userId: USER, serverId: SERVER, tool: writeTool, toolGrants: [g], serverGrants: [] });
    expect(d.effect).toBe("allow");
  });

  it("does not leak grants across users", () => {
    const g = toolGrant({ userId: OTHER_USER });
    const d = evaluate({ userId: USER, serverId: SERVER, tool: readTool, toolGrants: [g], serverGrants: [] });
    expect(d.effect).toBe("deny");
  });

  it("does not leak grants across servers", () => {
    const g = toolGrant({ serverId: OTHER_SERVER });
    const d = evaluate({ userId: USER, serverId: SERVER, tool: readTool, toolGrants: [g], serverGrants: [] });
    expect(d.effect).toBe("deny");
  });

  it("read-only-all server grant allows read tools", () => {
    const g = serverGrant();
    const d = evaluate({ userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [g] });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe(g.id);
    expect(d.ruleChain.at(-1)).toEqual({ rule: "server-read-only-all", outcome: "allow", grantId: g.id });
  });

  it("read-only-all server grant denies write tools", () => {
    const g = serverGrant();
    const d = evaluate({ userId: USER, serverId: SERVER, tool: writeTool, toolGrants: [], serverGrants: [g] });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
  });

  it("readOnlyAll=false grants nothing", () => {
    const g = serverGrant({ readOnlyAll: false });
    const d = evaluate({ userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [g] });
    expect(d.effect).toBe("deny");
  });

  it("explicit tool grant wins before the server-wide rule (ruleChain shows short-circuit)", () => {
    const tg = toolGrant();
    const sg = serverGrant();
    const d = evaluate({ userId: USER, serverId: SERVER, tool: readTool, toolGrants: [tg], serverGrants: [sg] });
    expect(d.ruleId).toBe(tg.id);
    expect(d.ruleChain).toHaveLength(1);
  });

  it("every decision carries a human-readable reason", () => {
    const deny = evaluate({ userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [] });
    expect(deny.reason).toContain("default-deny");
  });
});

describe("visibleTools", () => {
  const tools: ToolRef[] = [
    readTool,
    writeTool,
    { serverId: SERVER, name: "list_schemas", kind: "read" },
    { serverId: OTHER_SERVER, name: "query_database", kind: "read" },
  ];

  it("returns nothing with no grants (default-deny visibility)", () => {
    expect(visibleTools(USER, SERVER, tools, [], [])).toEqual([]);
  });

  it("returns only explicitly granted tools", () => {
    const g = toolGrant();
    expect(visibleTools(USER, SERVER, tools, [g], [])).toEqual([readTool]);
  });

  it("read-only-all shows all read tools on that server only", () => {
    const g = serverGrant();
    const visible = visibleTools(USER, SERVER, tools, [], [g]);
    expect(visible.map((t) => t.name).sort()).toEqual(["list_schemas", "query_database"]);
    expect(visible.every((t) => t.serverId === SERVER)).toBe(true);
  });
});
