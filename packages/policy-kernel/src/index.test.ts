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
    expect(d.ruleChain).toEqual([
      { rule: "tool-allow-list", outcome: "allow", grantId: g.id },
      { rule: "data-scope", outcome: "no-match" },
      { rule: "rate-limit", outcome: "no-match" },
      { rule: "approval-required", outcome: "no-match" },
    ]);
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
    expect(d.ruleChain).toContainEqual({
      rule: "server-read-only-all",
      outcome: "allow",
      grantId: g.id,
    });
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
    // grant phase short-circuits: no server-read-only-all trace when the
    // explicit tool grant already matched
    expect(d.ruleChain.map((t) => t.rule)).toEqual([
      "tool-allow-list",
      "data-scope",
      "rate-limit",
      "approval-required",
    ]);
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

// --- §3 approvals + rate limits ---

import type { ApprovalRule, RateLimit } from "./index.js";

const APPROVER = "user-approver";

function approvalRule(overrides: Partial<ApprovalRule> = {}): ApprovalRule {
  return {
    id: "ar-1",
    userId: USER,
    serverId: SERVER,
    toolName: null,
    writeOnly: false,
    approverUserId: APPROVER,
    ...overrides,
  };
}

function rateLimit(overrides: Partial<RateLimit> = {}): RateLimit {
  return {
    id: "rl-1",
    userId: USER,
    serverId: SERVER,
    toolName: null,
    maxCalls: 3,
    windowSeconds: 60,
    currentCount: 0,
    ...overrides,
  };
}

describe("approval rules", () => {
  it("granted call matching an approval rule returns require_approval with the named approver", () => {
    const d = evaluate({
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      approvalRules: [approvalRule()],
    });
    expect(d.effect).toBe("require_approval");
    expect(d.ruleId).toBe("ar-1");
    expect(d.approverUserId).toBe(APPROVER);
    expect(d.ruleChain.at(-1)).toEqual({
      rule: "approval-required", outcome: "require-approval", grantId: "ar-1",
    });
  });

  it("an approval rule never rescues an ungranted call — default-deny still wins", () => {
    const d = evaluate({
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [], serverGrants: [],
      approvalRules: [approvalRule()],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
  });

  it("writeOnly approval rule skips read tools but pauses write tools", () => {
    const rule = approvalRule({ writeOnly: true });
    const read = evaluate({
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [], approvalRules: [rule],
    });
    expect(read.effect).toBe("allow");

    const write = evaluate({
      userId: USER, serverId: SERVER, tool: writeTool,
      toolGrants: [toolGrant({ toolName: "drop_table" })], serverGrants: [], approvalRules: [rule],
    });
    expect(write.effect).toBe("require_approval");
  });

  it("tool-scoped approval rule only pauses that tool", () => {
    const rule = approvalRule({ toolName: "drop_table" });
    const other = evaluate({
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [], approvalRules: [rule],
    });
    expect(other.effect).toBe("allow");
  });

  it("an approved approval satisfies the rule for that evaluation and is traced", () => {
    const d = evaluate({
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      approvalRules: [approvalRule()],
      approvedApprovalId: "appr-42",
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("tg-1");
    expect(d.ruleChain).toContainEqual({
      rule: "approval-required", outcome: "satisfied-by-approval", grantId: "appr-42",
    });
  });
});

describe("rate limits", () => {
  it("allows under the cap and denies at the cap", () => {
    const under = evaluate({
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      rateLimits: [rateLimit({ currentCount: 2 })],
    });
    expect(under.effect).toBe("allow");

    const at = evaluate({
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      rateLimits: [rateLimit({ currentCount: 3 })],
    });
    expect(at.effect).toBe("deny");
    expect(at.ruleId).toBe("rl-1");
    expect(at.ruleChain.at(-1)).toEqual({ rule: "rate-limit", outcome: "deny", grantId: "rl-1" });
  });

  it("tool-scoped limit does not throttle other tools", () => {
    const d = evaluate({
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      rateLimits: [rateLimit({ toolName: "drop_table", currentCount: 99 })],
    });
    expect(d.effect).toBe("allow");
  });

  it("an exhausted rate limit denies even when an approved approval is in hand", () => {
    const d = evaluate({
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      approvalRules: [approvalRule()],
      rateLimits: [rateLimit({ currentCount: 3 })],
      approvedApprovalId: "appr-42",
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("rl-1");
  });

  it("another user's rate limit does not apply", () => {
    const d = evaluate({
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      rateLimits: [rateLimit({ userId: OTHER_USER, currentCount: 99 })],
    });
    expect(d.effect).toBe("allow");
  });
});

describe("visibility with approvals", () => {
  it("approval-required tools remain visible (they pause, they are not hidden)", () => {
    // visibleTools evaluates without approval rules by design — but even a
    // require_approval effect must not hide the tool.
    const tools = visibleTools(USER, SERVER, [readTool], [toolGrant()], []);
    expect(tools.map((t) => t.name)).toEqual(["query_database"]);
  });
});

// --- §3 data-scope rules ---

import type { DataScopeRule } from "./index.js";

function dataScopeRule(overrides: Partial<DataScopeRule> = {}): DataScopeRule {
  return {
    id: "ds-1",
    userId: USER,
    serverId: SERVER,
    toolName: "query_database",
    argPath: "schema",
    allowedValues: ["analytics", "public"],
    ...overrides,
  };
}

describe("data-scope rules", () => {
  const base = {
    userId: USER,
    serverId: SERVER,
    tool: readTool,
    toolGrants: [toolGrant()],
    serverGrants: [],
  };

  it("allows an in-scope argument value and traces the check", () => {
    const d = evaluate({
      ...base,
      dataScopeRules: [dataScopeRule()],
      args: { schema: "analytics" },
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleChain).toContainEqual({ rule: "data-scope", outcome: "allow" });
  });

  it("denies an out-of-scope value with the violated rule id", () => {
    const d = evaluate({
      ...base,
      dataScopeRules: [dataScopeRule()],
      args: { schema: "payroll" },
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("ds-1");
    expect(d.reason).toMatch(/outside the allowed data scope/);
    expect(d.ruleChain.at(-1)).toEqual({ rule: "data-scope", outcome: "deny", grantId: "ds-1" });
  });

  it("fails closed when the argument is missing or not a scalar", () => {
    const missing = evaluate({ ...base, dataScopeRules: [dataScopeRule()], args: {} });
    expect(missing.effect).toBe("deny");
    expect(missing.reason).toMatch(/fails closed/);

    const nonScalar = evaluate({
      ...base,
      dataScopeRules: [dataScopeRule()],
      args: { schema: ["analytics"] },
    });
    expect(nonScalar.effect).toBe("deny");
  });

  it("supports nested dot-paths", () => {
    const d = evaluate({
      ...base,
      dataScopeRules: [dataScopeRule({ argPath: "target.schema" })],
      args: { target: { schema: "public" } },
    });
    expect(d.effect).toBe("allow");
  });

  it("all matching rules must pass (AND across paths)", () => {
    const d = evaluate({
      ...base,
      dataScopeRules: [
        dataScopeRule(),
        dataScopeRule({ id: "ds-2", argPath: "table", allowedValues: ["events"] }),
      ],
      args: { schema: "analytics", table: "users" },
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("ds-2");
  });

  it("tool-scoped rule leaves other tools unconstrained", () => {
    const d = evaluate({
      ...base,
      tool: writeTool,
      toolGrants: [toolGrant({ toolName: "drop_table" })],
      dataScopeRules: [dataScopeRule()],
      args: {},
    });
    expect(d.effect).toBe("allow");
  });

  it("a scope violation denies before rate limits and approvals are consulted", () => {
    const d = evaluate({
      ...base,
      dataScopeRules: [dataScopeRule()],
      approvalRules: [approvalRule()],
      rateLimits: [rateLimit({ currentCount: 99 })],
      args: { schema: "payroll" },
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("ds-1");
    expect(d.ruleChain.some((t) => t.rule === "rate-limit")).toBe(false);
  });
});
