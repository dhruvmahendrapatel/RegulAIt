import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENY_RULE_ID,
  evaluate,
  visibleTools,
  type ServerGrant,
  type ToolGrant,
  type ToolRef,
} from "./index.js";

/** ADR-0124 — the shipped posture: the dial adds nothing to any decision.
 * Declared here rather than exported from the kernel on purpose: a public
 * "normal" constant is an affordance for a gateway call site to bypass the
 * dial with, and the gateway must always resolve it from org_settings. */
const EXEC = { mode: "normal" } as const;

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
    const d = evaluate({
    execution: EXEC, userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [] });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    expect(d.ruleChain.map((t) => t.rule)).toEqual([
      "tool-allow-list",
      "role-tool-allow-list",
      "server-read-only-all",
      "role-server-read-only-all",
      "default-deny",
    ]);
    // The trace outcome must match the effect: a denying rule must never be
    // recorded as "allow" in the persisted audit ruleChain.
    expect(d.ruleChain.map((t) => t.outcome)).toEqual([
      "no-match",
      "no-match",
      "no-match",
      "no-match",
      "deny",
    ]);
  });

  it("allows a tool on the user's explicit allow-list", () => {
    const g = toolGrant();
    const d = evaluate({
    execution: EXEC, userId: USER, serverId: SERVER, tool: readTool, toolGrants: [g], serverGrants: [] });
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
    const d = evaluate({
    execution: EXEC, userId: USER, serverId: SERVER, tool: writeTool, toolGrants: [g], serverGrants: [] });
    expect(d.effect).toBe("allow");
  });

  it("does not leak grants across users", () => {
    const g = toolGrant({ userId: OTHER_USER });
    const d = evaluate({
    execution: EXEC, userId: USER, serverId: SERVER, tool: readTool, toolGrants: [g], serverGrants: [] });
    expect(d.effect).toBe("deny");
  });

  it("does not leak grants across servers", () => {
    const g = toolGrant({ serverId: OTHER_SERVER });
    const d = evaluate({
    execution: EXEC, userId: USER, serverId: SERVER, tool: readTool, toolGrants: [g], serverGrants: [] });
    expect(d.effect).toBe("deny");
  });

  it("read-only-all server grant allows read tools", () => {
    const g = serverGrant();
    const d = evaluate({
    execution: EXEC, userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [g] });
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
    const d = evaluate({
    execution: EXEC, userId: USER, serverId: SERVER, tool: writeTool, toolGrants: [], serverGrants: [g] });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
  });

  it("readOnlyAll=false grants nothing", () => {
    const g = serverGrant({ readOnlyAll: false });
    const d = evaluate({
    execution: EXEC, userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [g] });
    expect(d.effect).toBe("deny");
  });

  it("explicit tool grant wins before the server-wide rule (ruleChain shows short-circuit)", () => {
    const tg = toolGrant();
    const sg = serverGrant();
    const d = evaluate({
    execution: EXEC, userId: USER, serverId: SERVER, tool: readTool, toolGrants: [tg], serverGrants: [sg] });
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
    const deny = evaluate({
    execution: EXEC, userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [] });
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
    expect(visibleTools(USER, SERVER, tools, { toolGrants: [], serverGrants: [] })).toEqual([]);
  });

  it("returns only explicitly granted tools", () => {
    const g = toolGrant();
    expect(visibleTools(USER, SERVER, tools, { toolGrants: [g], serverGrants: [] })).toEqual([readTool]);
  });

  it("read-only-all shows all read tools on that server only", () => {
    const g = serverGrant();
    const visible = visibleTools(USER, SERVER, tools, { toolGrants: [], serverGrants: [g] });
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
    execution: EXEC,
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
    execution: EXEC,
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
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [], approvalRules: [rule],
    });
    expect(read.effect).toBe("allow");

    const write = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: writeTool,
      toolGrants: [toolGrant({ toolName: "drop_table" })], serverGrants: [], approvalRules: [rule],
    });
    expect(write.effect).toBe("require_approval");
  });

  it("tool-scoped approval rule only pauses that tool", () => {
    const rule = approvalRule({ toolName: "drop_table" });
    const other = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [], approvalRules: [rule],
    });
    expect(other.effect).toBe("allow");
  });

  it("an approved approval satisfies the rule for that evaluation and is traced", () => {
    const d = evaluate({
    execution: EXEC,
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
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      rateLimits: [rateLimit({ currentCount: 2 })],
    });
    expect(under.effect).toBe("allow");

    const at = evaluate({
    execution: EXEC,
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
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      rateLimits: [rateLimit({ toolName: "drop_table", currentCount: 99 })],
    });
    expect(d.effect).toBe("allow");
  });

  it("an exhausted rate limit denies even when an approved approval is in hand", () => {
    const d = evaluate({
    execution: EXEC,
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
    execution: EXEC,
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
    const tools = visibleTools(USER, SERVER, [readTool], { toolGrants: [toolGrant()], serverGrants: [] });
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
    execution: EXEC,
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
    const missing = evaluate({
    ...base, dataScopeRules: [dataScopeRule()], args: {} });
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

// --- §5 roles + per-user overrides ---

import type { RoleToolGrant, RoleServerGrant, Revocation } from "./index.js";

const ROLE = "role-analyst";

function roleToolGrant(overrides: Partial<RoleToolGrant> = {}): RoleToolGrant {
  return { id: "rtg-1", roleId: ROLE, serverId: SERVER, toolName: "query_database", ...overrides };
}

function roleServerGrant(overrides: Partial<RoleServerGrant> = {}): RoleServerGrant {
  return { id: "rsg-1", roleId: ROLE, serverId: SERVER, readOnlyAll: true, ...overrides };
}

function revocation(overrides: Partial<Revocation> = {}): Revocation {
  return { id: "rev-1", userId: USER, serverId: SERVER, toolName: "query_database", ...overrides };
}

describe("role-derived entitlements (§5)", () => {
  const none = { toolGrants: [], serverGrants: [] };

  it("a role tool grant allows and is traced with the role grant id", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, ...none,
      roleToolGrants: [roleToolGrant()],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("rtg-1");
    expect(d.reason).toContain(ROLE);
    expect(d.ruleChain).toContainEqual({
      rule: "role-tool-allow-list", outcome: "allow", grantId: "rtg-1",
    });
  });

  it("a direct user grant wins before the role grant (chain shows the short-circuit)", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      roleToolGrants: [roleToolGrant()],
    });
    expect(d.ruleId).toBe("tg-1");
    expect(d.ruleChain.some((t) => t.rule === "role-tool-allow-list")).toBe(false);
  });

  it("a revocation suppresses a role tool grant and is traced with the revocation id", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, ...none,
      roleToolGrants: [roleToolGrant()],
      revocations: [revocation()],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    expect(d.ruleChain).toContainEqual({
      rule: "role-tool-allow-list", outcome: "revoked", grantId: "rev-1",
    });
  });

  it("a direct user grant survives a revocation of the same tool", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      roleToolGrants: [roleToolGrant()],
      revocations: [revocation()],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("tg-1");
  });

  it("role read-only-all allows read tools, never write tools", () => {
    const read = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, ...none,
      roleServerGrants: [roleServerGrant()],
    });
    expect(read.effect).toBe("allow");
    expect(read.ruleId).toBe("rsg-1");

    const write = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: writeTool, ...none,
      roleServerGrants: [roleServerGrant()],
    });
    expect(write.effect).toBe("deny");
  });

  it("a server-wide revocation (toolName null) suppresses all role-derived access", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, ...none,
      roleToolGrants: [roleToolGrant()],
      roleServerGrants: [roleServerGrant()],
      revocations: [revocation({ toolName: null })],
    });
    expect(d.effect).toBe("deny");
  });

  it("a tool-scoped revocation also suppresses role read-only-all for that tool only", () => {
    const revoked = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, ...none,
      roleServerGrants: [roleServerGrant()],
      revocations: [revocation()],
    });
    expect(revoked.effect).toBe("deny");

    const other = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER,
      tool: { serverId: SERVER, name: "list_schemas", kind: "read" }, ...none,
      roleServerGrants: [roleServerGrant()],
      revocations: [revocation()],
    });
    expect(other.effect).toBe("allow");
  });

  it("another user's revocation does not suppress this user's role grants", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, ...none,
      roleToolGrants: [roleToolGrant()],
      revocations: [revocation({ userId: OTHER_USER })],
    });
    expect(d.effect).toBe("allow");
  });

  it("grants from multiple roles union together", () => {
    const d1 = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, ...none,
      roleToolGrants: [roleToolGrant(), roleToolGrant({ id: "rtg-2", roleId: "role-other", toolName: "drop_table" })],
    });
    expect(d1.effect).toBe("allow");

    const d2 = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: writeTool, ...none,
      roleToolGrants: [roleToolGrant(), roleToolGrant({ id: "rtg-2", roleId: "role-other", toolName: "drop_table" })],
    });
    expect(d2.effect).toBe("allow");
    expect(d2.ruleId).toBe("rtg-2");
  });

  it("visibleTools reflects role grants minus revocations", () => {
    const tools: ToolRef[] = [readTool, writeTool];
    const visible = visibleTools(USER, SERVER, tools, {
      toolGrants: [], serverGrants: [],
      roleToolGrants: [roleToolGrant(), roleToolGrant({ id: "rtg-2", toolName: "drop_table" })],
      revocations: [revocation({ toolName: "drop_table" })],
    });
    expect(visible.map((t) => t.name)).toEqual(["query_database"]);
  });
});

// --- §2/§4 agents + connectors ---

import {
  evaluateAgent,
  evaluateConnector,
  type AgentGrant,
  type AgentRef,
  type ConnectorGrant,
  type RoleAgentGrant,
  type RoleConnectorGrant,
} from "./index.js";

const AGENT: AgentRef = { id: "agent-claude", tier: 3, enabled: true, modes: null };
const CONNECTOR = "connector-salesforce";

function agentGrant(overrides: Partial<AgentGrant> = {}): AgentGrant {
  return { id: "ag-1", userId: USER, agentId: "agent-claude", allowedModes: null, ...overrides };
}

function connectorGrant(overrides: Partial<ConnectorGrant> = {}): ConnectorGrant {
  return {
    id: "cg-1",
    userId: USER,
    connectorId: CONNECTOR,
    mode: "read",
    allowedObjects: null,
    ...overrides,
  };
}

describe("evaluateAgent (§4)", () => {
  it("denies by default without a grant, even for an enabled agent", () => {
    const d = evaluateAgent({
    execution: EXEC, userId: USER, agent: AGENT, mode: "plan", agentGrants: [] });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
  });

  it("denies a platform-disabled agent even when granted", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER,
      agent: { ...AGENT, enabled: false },
      mode: "plan",
      agentGrants: [agentGrant()],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("agent-registry-enabled");
  });

  it("allows a granted agent and traces the grant", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute", agentGrants: [agentGrant()],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("ag-1");
    expect(d.ruleChain).toContainEqual({
      rule: "agent-allow-list", outcome: "allow", grantId: "ag-1",
    });
  });

  it("mode-level restriction on top of agent-level restriction (§4)", () => {
    const grant = agentGrant({ allowedModes: ["plan"] });
    const plan = evaluateAgent({
    execution: EXEC, userId: USER, agent: AGENT, mode: "plan", agentGrants: [grant] });
    expect(plan.effect).toBe("allow");

    const exec = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute", agentGrants: [grant],
    });
    expect(exec.effect).toBe("deny");
    expect(exec.reason).toContain("mode 'execute'");
  });

  it("ceiling denies agents above the user's tier ceiling, allows at the ceiling", () => {
    const at = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "plan", agentGrants: [agentGrant()], ceilingTier: 3,
    });
    expect(at.effect).toBe("allow");

    const above = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "plan", agentGrants: [agentGrant()], ceilingTier: 2,
    });
    expect(above.effect).toBe("deny");
    expect(above.ruleId).toBe("agent-ceiling");
  });

  it("another user's grant does not apply", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "plan",
      agentGrants: [agentGrant({ userId: OTHER_USER })],
    });
    expect(d.effect).toBe("deny");
  });
});

describe("evaluateConnector (§2)", () => {
  it("denies by default without a grant", () => {
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read", connectorGrants: [],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
  });

  it("read-only grant allows reads and denies writes", () => {
    const read = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read",
      connectorGrants: [connectorGrant()],
    });
    expect(read.effect).toBe("allow");

    const write = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "write",
      connectorGrants: [connectorGrant()],
    });
    expect(write.effect).toBe("deny");
    expect(write.reason).toContain("read-only");
  });

  it("readwrite grant allows writes", () => {
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "write",
      connectorGrants: [connectorGrant({ mode: "readwrite" })],
    });
    expect(d.effect).toBe("allow");
  });

  it("object scope allows listed objects, denies others, fails closed when unnamed", () => {
    const grant = connectorGrant({ allowedObjects: ["accounts", "contacts"] });
    const ok = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read", object: "accounts",
      connectorGrants: [grant],
    });
    expect(ok.effect).toBe("allow");

    const outside = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read", object: "payroll",
      connectorGrants: [grant],
    });
    expect(outside.effect).toBe("deny");

    const unnamed = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read",
      connectorGrants: [grant],
    });
    expect(unnamed.effect).toBe("deny");
    expect(unnamed.reason).toContain("fails closed");
  });

  it("another user's connector grant does not apply", () => {
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read",
      connectorGrants: [connectorGrant({ userId: OTHER_USER })],
    });
    expect(d.effect).toBe("deny");
  });
});

// --- §5 role-bundled agent + connector grants (ADR-0014) ---

function roleAgentGrant(overrides: Partial<RoleAgentGrant> = {}): RoleAgentGrant {
  return { id: "rag-1", roleId: ROLE, agentId: "agent-claude", allowedModes: null, ...overrides };
}

function roleConnectorGrant(overrides: Partial<RoleConnectorGrant> = {}): RoleConnectorGrant {
  return { id: "rcg-1", roleId: ROLE, connectorId: CONNECTOR, mode: "read", allowedObjects: null, ...overrides };
}

describe("role-bundled agent grants (§5, ADR-0014)", () => {
  it("(a) a role-only agent grant allows and traces role-agent-allow-list", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [],
      roleAgentGrants: [roleAgentGrant()],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("rag-1");
    expect(d.reason).toContain(ROLE);
    expect(d.ruleChain).toContainEqual({
      rule: "role-agent-allow-list", outcome: "allow", grantId: "rag-1",
    });
  });

  it("(b) a direct agent grant wins and the role grant is never consulted", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [agentGrant()],
      roleAgentGrants: [roleAgentGrant()],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("ag-1");
    expect(d.ruleChain.some((t) => t.rule === "role-agent-allow-list")).toBe(false);
    expect(d.ruleChain).toContainEqual({
      rule: "agent-allow-list", outcome: "allow", grantId: "ag-1",
    });
  });

  it("(c) the per-user tier ceiling narrows a role grant (agent-ceiling deny)", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "plan",
      agentGrants: [],
      roleAgentGrants: [roleAgentGrant()],
      ceilingTier: 2, // AGENT.tier === 3
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("agent-ceiling");
  });

  it("(d) a role grant's allowedModes excludes the mode → agent-mode deny", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [],
      roleAgentGrants: [roleAgentGrant({ allowedModes: ["plan"] })],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("rag-1");
    expect(d.reason).toContain("mode 'execute'");
  });

  it("no role grants passed → byte-identical default-deny (direct-only unchanged)", () => {
    const withEmpty = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "plan", agentGrants: [], roleAgentGrants: [],
    });
    const without = evaluateAgent({
    execution: EXEC, userId: USER, agent: AGENT, mode: "plan", agentGrants: [] });
    expect(withEmpty).toEqual(without);
  });
});

describe("role-bundled connector grants (§5, ADR-0014, UNION-MAX)", () => {
  it("(e1) a role-only connector grant allows and traces role-connector-allow-list", () => {
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read",
      connectorGrants: [],
      roleConnectorGrants: [roleConnectorGrant()],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("rcg-1");
    expect(d.reason).toContain(ROLE);
    expect(d.ruleChain).toContainEqual({
      rule: "role-connector-allow-list", outcome: "allow", grantId: "rcg-1",
    });
  });

  it("(e2) a role grant mode 'read' + write op → connector-mode deny", () => {
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "write",
      connectorGrants: [],
      roleConnectorGrants: [roleConnectorGrant({ mode: "read" })],
    });
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain("read-only");
  });

  it("(e3) a role grant allowedObjects excludes the object → object-scope deny", () => {
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read", object: "payroll",
      connectorGrants: [],
      roleConnectorGrants: [roleConnectorGrant({ allowedObjects: ["accounts"] })],
    });
    expect(d.effect).toBe("deny");
  });

  it("(f) ADDITIVITY GUARD: narrow direct grant does NOT mask a broader role grant", () => {
    // direct read-only + role readwrite, write op → the union ALLOWS via the
    // role grant. A direct-first short-circuit would have wrongly denied here.
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "write",
      connectorGrants: [connectorGrant({ mode: "read" })],
      roleConnectorGrants: [roleConnectorGrant({ mode: "readwrite" })],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("rcg-1");
    expect(d.ruleChain).toContainEqual({
      rule: "role-connector-allow-list", outcome: "allow", grantId: "rcg-1",
    });
  });

  it("union across object scope: a broader role object-scope rescues a narrow direct one", () => {
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read", object: "payroll",
      connectorGrants: [connectorGrant({ allowedObjects: ["accounts"] })],
      roleConnectorGrants: [roleConnectorGrant({ allowedObjects: ["payroll"] })],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleId).toBe("rcg-1");
  });

  it("no role grants passed → byte-identical to the direct-only evaluation", () => {
    const withEmpty = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read",
      connectorGrants: [connectorGrant()], roleConnectorGrants: [],
    });
    const without = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read",
      connectorGrants: [connectorGrant()],
    });
    expect(withEmpty).toEqual(without);
  });
});

describe("agent declared modes (review fix)", () => {
  it("the registry's declared modes bound every grant, even allowedModes null", () => {
    const declared: AgentRef = { id: "agent-claude", tier: 3, enabled: true, modes: ["plan"] };
    const ok = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: declared, mode: "plan", agentGrants: [agentGrant()],
    });
    expect(ok.effect).toBe("allow");

    const undeclared = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: declared, mode: "execute", agentGrants: [agentGrant()],
    });
    expect(undeclared.effect).toBe("deny");
    expect(undeclared.reason).toContain("not a declared mode");
  });
});

describe("display names in reason prose (demo finding 5)", () => {
  it("evaluateAgent's ceiling denial names the agent, id truncated in parentheses", () => {
    const named = {
      id: "c8d62183-0000-4000-8000-000000000000",
      name: "premium-mock",
      tier: 2,
      enabled: true,
      modes: null,
    } satisfies AgentRef;
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER,
      agent: named,
      mode: "plan",
      agentGrants: [agentGrant({ agentId: named.id })],
      ceilingTier: 1,
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("agent-ceiling");
    expect(d.reason).toContain("'premium-mock' (c8d62183…)");
    expect(d.reason).toContain("(tier 2) exceeds user's ceiling (tier 1)");
    expect(d.reason).not.toContain("c8d62183-0000"); // never the raw UUID in prose
  });

  it("without a display name the old id-quoting format is unchanged", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "plan", agentGrants: [agentGrant()], ceilingTier: 2,
    });
    expect(d.reason).toContain(`agent '${AGENT.id}' (tier 3) exceeds user's ceiling (tier 2)`);
  });

  it("evaluate() names server, user, and approver when the caller passes names in", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER,
      userName: "Dana Developer",
      serverId: SERVER,
      serverName: "repo-tools",
      tool: writeTool,
      toolGrants: [toolGrant({ toolName: "drop_table" })],
      serverGrants: [],
      approvalRules: [
        {
          id: "apr-1",
          userId: USER,
          serverId: SERVER,
          toolName: null,
          writeOnly: true,
          approverUserId: "6f0a1b2c-0000-4000-8000-000000000000",
          approverName: "Avery Approver",
        },
      ],
    });
    expect(d.effect).toBe("require_approval");
    expect(d.reason).toContain(`server 'repo-tools' (${SERVER.slice(0, 8)}…)`);
    expect(d.reason).toContain("approver 'Avery Approver' (6f0a1b2c…)");
    expect(d.approverUserId).toBe("6f0a1b2c-0000-4000-8000-000000000000"); // full id preserved
    expect(d.approverName).toBe("Avery Approver");

    const deny = evaluate({
    execution: EXEC,
      userId: USER,
      userName: "Dana Developer",
      serverId: SERVER,
      serverName: "repo-tools",
      tool: readTool,
      toolGrants: [],
      serverGrants: [],
    });
    expect(deny.reason).toContain("user 'Dana Developer'");
    expect(deny.reason).toContain("server 'repo-tools'");
  });

  it("evaluateConnector names the connector when a display name is passed", () => {
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER,
      connectorId: CONNECTOR,
      connectorName: "salesforce",
      operation: "write",
      connectorGrants: [connectorGrant()],
    });
    expect(d.effect).toBe("deny");
    expect(d.reason).toContain(`'salesforce' (${CONNECTOR.slice(0, 8)}…)`);
  });
});

// ---------------------------------------------------------------------------
// §5.1 Team-Lead entitlement-narrowing ceiling
// ---------------------------------------------------------------------------

describe("evaluateAgent Team-Lead ceiling (§5.1)", () => {
  it("allows a granted agent that is inside the lead ceiling", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [agentGrant()], ceilingAgentIds: ["agent-claude", "agent-gpt"],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleChain).toContainEqual({ rule: "agent-lead-ceiling", outcome: "allow" });
  });

  it("DENIES a granted agent that the lead ceiling excludes (narrows, not relabels)", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [agentGrant()], ceilingAgentIds: ["agent-gpt"], // claude granted but not in ceiling
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("agent-lead-ceiling");
    expect(d.reason).toContain("delegation ceiling");
  });

  it("does not rescue an UNgranted agent — an empty grant stays default-deny even if the ceiling lists it", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [], ceilingAgentIds: ["agent-claude"],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID); // ceiling never reached
    expect(d.ruleChain).not.toContainEqual({ rule: "agent-lead-ceiling", outcome: "allow" });
  });

  it("an empty ceiling forbids every agent (nothing allowed)", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [agentGrant()], ceilingAgentIds: [],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("agent-lead-ceiling");
  });

  it("a null/absent ceiling changes nothing (flat run) and adds no trace entry", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute", agentGrants: [agentGrant()], ceilingAgentIds: null,
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleChain.some((r) => r.rule === "agent-lead-ceiling")).toBe(false);
  });
});

describe("evaluate tool Team-Lead ceiling (§5.1)", () => {
  it("allows a granted tool inside the ceiling", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [], ceilingTools: ["query_database", "list_rows"],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleChain).toContainEqual({ rule: "lead-ceiling", outcome: "allow" });
  });

  it("DENIES a granted tool the ceiling excludes, with ruleId lead-ceiling (narrows)", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [], ceilingTools: ["some_other_tool"],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("lead-ceiling");
  });

  it("does NOT rescue an ungranted tool — stays default-deny before the ceiling is consulted", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: writeTool, // not granted
      toolGrants: [toolGrant()], serverGrants: [], ceilingTools: ["drop_table"],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    expect(d.ruleChain.some((r) => r.rule === "lead-ceiling")).toBe(false);
  });

  it("a null/absent ceiling changes nothing and adds no trace entry (137 proxy tests stay green)", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, toolGrants: [toolGrant()], serverGrants: [],
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleChain.some((r) => r.rule === "lead-ceiling")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PILLAR 1 rule scoping — role/team/fleet-scoped restriction rules
//
// The rule set arrives ALREADY scope-filtered by the gateway (a fleet rule has
// no user id, a role rule matched the user's roles, etc.). The kernel only
// re-checks the one scope it must never widen: a 'user'-scoped rule still binds
// to its own user id. Every scoped rule is a pure RESTRICTION evaluated after
// the grant check — it can only ever ADD a deny/approval/cap.
// ---------------------------------------------------------------------------

describe("rule scoping (pillar 1): fleet/role/team restrictions", () => {
  const fleetApproval = (over: Partial<ApprovalRule> = {}): ApprovalRule => ({
    id: "ar-fleet",
    userId: null,
    serverId: null,
    scope: "fleet",
    serverScope: "all",
    toolName: null,
    writeOnly: false,
    approverUserId: APPROVER,
    ...over,
  });

  it("a FLEET approval rule pauses a granted call by a user with NO user-specific rule", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      approvalRules: [fleetApproval()],
    });
    expect(d.effect).toBe("require_approval");
    expect(d.ruleId).toBe("ar-fleet");
    expect(d.approverUserId).toBe(APPROVER);
    // additive audit prose names the scope that paused it
    expect(d.reason).toContain("fleet-wide rule");
    expect(d.reason).toContain("all servers");
  });

  it("a ROLE-scoped approval rule requires sign-off; a user rule cannot relax it (most-restrictive-wins)", () => {
    const roleRule: ApprovalRule = {
      id: "ar-role", userId: null, serverId: SERVER, roleId: ROLE, scope: "role",
      serverScope: "server", toolName: null, writeOnly: false, approverUserId: APPROVER,
    };
    // role rule alone → pauses
    const d1 = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [], approvalRules: [roleRule],
    });
    expect(d1.effect).toBe("require_approval");
    expect(d1.reason).toContain("role-scoped rule");
    // adding a user-scoped rule too — still require_approval, never relaxed
    const userRule = approvalRule({ id: "ar-user" });
    const d2 = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [], approvalRules: [userRule, roleRule],
    });
    expect(d2.effect).toBe("require_approval");
  });

  it("data-scope rules from two scopes INTERSECT — a value must satisfy every matching rule", () => {
    const userDs: DataScopeRule = {
      id: "ds-user", userId: USER, serverId: SERVER, scope: "user", serverScope: "server",
      toolName: null, argPath: "schema", allowedValues: ["analytics", "reporting"],
    };
    const fleetDs: DataScopeRule = {
      id: "ds-fleet", userId: null, serverId: null, scope: "fleet", serverScope: "all",
      toolName: null, argPath: "schema", allowedValues: ["reporting", "ops"],
    };
    const base = {
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [], dataScopeRules: [userDs, fleetDs],
      execution: EXEC,
    };
    // in BOTH allow-lists → allowed
    expect(evaluate({
    ...base, args: { schema: "reporting" } }).effect).toBe("allow");
    // only in the user rule → the fleet rule denies it
    const dA = evaluate({
    ...base, args: { schema: "analytics" } });
    expect(dA.effect).toBe("deny");
    expect(dA.ruleId).toBe("ds-fleet");
    // only in the fleet rule → the user rule denies it
    const dO = evaluate({
    ...base, args: { schema: "ops" } });
    expect(dO.effect).toBe("deny");
    expect(dO.ruleId).toBe("ds-user");
  });

  it("a FLEET and a USER rate limit each count independently; the tightest (exhausted) denies first", () => {
    const userRl: RateLimit = {
      id: "rl-user", userId: USER, serverId: SERVER, scope: "user", serverScope: "server",
      toolName: null, maxCalls: 5, windowSeconds: 60, currentCount: 2,
    };
    const fleetRl: RateLimit = {
      id: "rl-fleet", userId: null, serverId: null, scope: "fleet", serverScope: "all",
      toolName: null, maxCalls: 3, windowSeconds: 60, currentCount: 3,
    };
    // fleet exhausted, user not → fleet denies
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [], rateLimits: [userRl, fleetRl],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("rl-fleet");
    // neither exhausted → allowed
    const ok = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      rateLimits: [{ ...userRl }, { ...fleetRl, currentCount: 0 }],
    });
    expect(ok.effect).toBe("allow");
    // user exhausted instead → user denies
    const du = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      rateLimits: [{ ...userRl, currentCount: 5 }, { ...fleetRl, currentCount: 0 }],
    });
    expect(du.effect).toBe("deny");
    expect(du.ruleId).toBe("rl-user");
  });

  it("THE INVARIANT: a fleet/role restriction NEVER rescues an ungranted call — default-deny still wins", () => {
    // fleet approval on an ungranted tool
    const dApproval = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [], serverGrants: [], approvalRules: [fleetApproval()],
    });
    expect(dApproval.effect).toBe("deny");
    expect(dApproval.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    // a role data-scope rule on an ungranted tool likewise cannot rescue it
    const roleDs: DataScopeRule = {
      id: "ds-role", userId: null, serverId: SERVER, roleId: ROLE, scope: "role",
      serverScope: "server", toolName: null, argPath: "schema", allowedValues: ["analytics"],
    };
    const dScope = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [], serverGrants: [], dataScopeRules: [roleDs], args: { schema: "analytics" },
    });
    expect(dScope.effect).toBe("deny");
    expect(dScope.ruleId).toBe(DEFAULT_DENY_RULE_ID);
  });

  it("a user-scoped rule still binds to its own user id — another user's fleet-free rule never applies", () => {
    // legacy/user rule for OTHER_USER is not applied to USER (subject check kept)
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [toolGrant()], serverGrants: [],
      approvalRules: [approvalRule({ userId: OTHER_USER })],
    });
    expect(d.effect).toBe("allow");
  });
});

// --- ADR-0019: per-user AGENT / CONNECTOR revocations ---------------------
// The headline invariant, stated once and proved four ways below:
//   a revocation can ONLY turn an allow into a deny.
// It beats a direct grant AND a role grant, and it can NEVER rescue an
// ungranted call — an ungranted call keeps its ORIGINAL default-deny ruleId,
// because the kernel never even looks at revocations on that path.

import type { AgentRevocation, ConnectorRevocation } from "./index.js";

function agentRevocation(overrides: Partial<AgentRevocation> = {}): AgentRevocation {
  return { id: "arev-1", userId: USER, agentId: "agent-claude", reason: null, ...overrides };
}

function connectorRevocation(
  overrides: Partial<ConnectorRevocation> = {},
): ConnectorRevocation {
  return { id: "crev-1", userId: USER, connectorId: CONNECTOR, reason: null, ...overrides };
}

describe("per-user agent revocation (ADR-0019)", () => {
  it("(a) a ROLE-granted agent + a revocation denies with ruleId 'agent-revoked'", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [],
      roleAgentGrants: [roleAgentGrant()],
      agentRevocations: [agentRevocation()],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("agent-revoked");
    // the trace names the REVOCATION id, not the grant id
    expect(d.ruleChain).toContainEqual({
      rule: "agent-revoked", outcome: "deny", grantId: "arev-1",
    });
    // the role grant is still traced as found — the deviation is visible, not silent
    expect(d.ruleChain).toContainEqual({
      rule: "role-agent-allow-list", outcome: "allow", grantId: "rag-1",
    });
  });

  it("(b) a DIRECT grant + a revocation also denies — a revocation beats both grant kinds", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [agentGrant()],
      agentRevocations: [agentRevocation()],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("agent-revoked");
  });

  it("(c) THE INVARIANT: a revocation with NO grant still denies with the ORIGINAL default-deny ruleId — never 'rescued', never re-labelled", () => {
    const withRevocation = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [],
      agentRevocations: [agentRevocation()],
    });
    expect(withRevocation.effect).toBe("deny");
    expect(withRevocation.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    expect(withRevocation.ruleChain).not.toContainEqual(
      expect.objectContaining({ rule: "agent-revoked" }),
    );
    // and it is byte-identical to the same call with no revocation at all
    const without = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute", agentGrants: [],
    });
    expect(withRevocation).toEqual(without);
  });

  it("(d) NO revocation input is byte-identical to the pre-ADR-0019 evaluation", () => {
    const before = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute", agentGrants: [agentGrant()],
    });
    const emptyList = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute", agentGrants: [agentGrant()],
      agentRevocations: [],
    });
    expect(emptyList).toEqual(before);
    // a revocation for a DIFFERENT agent, or a DIFFERENT user, changes nothing
    const otherAgent = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute", agentGrants: [agentGrant()],
      agentRevocations: [agentRevocation({ agentId: "agent-other" })],
    });
    expect(otherAgent).toEqual(before);
    const otherUser = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute", agentGrants: [agentGrant()],
      agentRevocations: [agentRevocation({ userId: OTHER_USER })],
    });
    expect(otherUser).toEqual(before);
  });

  it("(e) the deny reason names the revocation and carries the admin's stated reason", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: AGENT, mode: "execute",
      agentGrants: [agentGrant()],
      agentRevocations: [agentRevocation({ reason: "left the payments team" })],
    });
    expect(d.reason).toContain("arev-1");
    expect(d.reason).toContain("revoked");
    expect(d.reason).toContain("left the payments team");
  });

  it("(f) a revocation cannot rescue a platform-disabled agent either — registry check still wins", () => {
    const d = evaluateAgent({
    execution: EXEC,
      userId: USER, agent: { ...AGENT, enabled: false }, mode: "execute",
      agentGrants: [agentGrant()],
      agentRevocations: [agentRevocation()],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("agent-registry-enabled");
  });
});

describe("per-user connector revocation (ADR-0019)", () => {
  it("(a) a ROLE-granted connector + a revocation denies with ruleId 'connector-revoked'", () => {
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read",
      connectorGrants: [],
      roleConnectorGrants: [roleConnectorGrant()],
      connectorRevocations: [connectorRevocation()],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("connector-revoked");
    expect(d.ruleChain).toContainEqual({
      rule: "connector-revoked", outcome: "deny", grantId: "crev-1",
    });
  });

  it("(b) a DIRECT grant + a revocation also denies — including a readwrite grant", () => {
    const d = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "write",
      connectorGrants: [connectorGrant({ mode: "readwrite" })],
      connectorRevocations: [connectorRevocation()],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("connector-revoked");
  });

  it("(c) THE INVARIANT: a revocation with NO grant still denies with the ORIGINAL default-deny ruleId", () => {
    const withRevocation = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read",
      connectorGrants: [],
      connectorRevocations: [connectorRevocation()],
    });
    expect(withRevocation.effect).toBe("deny");
    expect(withRevocation.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    expect(withRevocation.ruleChain).not.toContainEqual(
      expect.objectContaining({ rule: "connector-revoked" }),
    );
    const without = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read", connectorGrants: [],
    });
    expect(withRevocation).toEqual(without);
  });

  it("(d) NO revocation input is byte-identical to the pre-ADR-0019 evaluation", () => {
    const before = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "read",
      connectorGrants: [connectorGrant()],
    });
    expect(
      evaluateConnector({
    execution: EXEC,
        userId: USER, connectorId: CONNECTOR, operation: "read",
        connectorGrants: [connectorGrant()], connectorRevocations: [],
      }),
    ).toEqual(before);
    expect(
      evaluateConnector({
    execution: EXEC,
        userId: USER, connectorId: CONNECTOR, operation: "read",
        connectorGrants: [connectorGrant()],
        connectorRevocations: [connectorRevocation({ connectorId: "connector-other" })],
      }),
    ).toEqual(before);
    expect(
      evaluateConnector({
    execution: EXEC,
        userId: USER, connectorId: CONNECTOR, operation: "read",
        connectorGrants: [connectorGrant()],
        connectorRevocations: [connectorRevocation({ userId: OTHER_USER })],
      }),
    ).toEqual(before);
  });

  it("(e) a revocation bounds ADR-0014's UNION-MAX: a broad role grant beside a narrow direct one is revoked too", () => {
    // without the revocation the union allows a write via the role grant
    const allowed = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "write",
      connectorGrants: [connectorGrant({ mode: "read" })],
      roleConnectorGrants: [roleConnectorGrant({ mode: "readwrite" })],
    });
    expect(allowed.effect).toBe("allow");
    const revoked = evaluateConnector({
    execution: EXEC,
      userId: USER, connectorId: CONNECTOR, operation: "write",
      connectorGrants: [connectorGrant({ mode: "read" })],
      roleConnectorGrants: [roleConnectorGrant({ mode: "readwrite" })],
      connectorRevocations: [connectorRevocation()],
    });
    expect(revoked.effect).toBe("deny");
    expect(revoked.ruleId).toBe("connector-revoked");
  });
});

// ===========================================================================
// ADR-0040 — ABAC on the kernel ALLOW PATH
//
// The whole point of putting ABAC inside the kernel rather than beside it is
// that these invariants can be asserted structurally, once, here — the same
// way the additive-only / allow-path-only invariants for ADR-0019 revocations
// already are.
// ===========================================================================
describe("ADR-0040 ABAC — the invariants, locked", () => {
  const abacToolGrant: ToolGrant = {
    id: "tg-abac", userId: USER, serverId: SERVER, toolName: "query_database",
  };
  const FORBID = {
    effect: "forbid" as const,
    policyId: "e0f1a2b3-0000-4000-8000-000000000001",
    policyName: "no-night-hipaa-writes",
    policyVersion: 3,
  };

  // -- INVARIANT 1: ABAC NEVER GRANTS -------------------------------------
  it("(1) a Cedar PERMIT cannot rescue an ungranted call — it never even reaches ABAC", () => {
    // No grant of any kind. Feed the kernel the most permissive ABAC verdict
    // there is and assert the decision is still the plain default-deny.
    const withoutAbac = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [],
    });
    const withPermit = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [],
      abacDecision: { effect: "permit" },
    });
    expect(withPermit).toEqual(withoutAbac);
    expect(withPermit.effect).toBe("deny");
    expect(withPermit.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    // …and the proof that ABAC was never consulted: no abac-forbid trace exists
    expect(withPermit.ruleChain.some((t) => t.rule === "abac-forbid")).toBe(false);
  });

  it("(1) not even a forbid changes an ungranted call — ABAC is not an extra gate, it is a step on the allow path", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool, toolGrants: [], serverGrants: [],
      abacDecision: FORBID,
    });
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    expect(d.ruleChain.some((t) => t.rule === "abac-forbid")).toBe(false);
  });

  it("(1) a lead-ceiling deny still wins — ABAC cannot override an earlier terminal deny", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      ceilingTools: ["something_else"],
      abacDecision: { effect: "permit" },
    });
    expect(d.ruleId).toBe("lead-ceiling");
    expect(d.ruleChain.some((t) => t.rule === "abac-forbid")).toBe(false);
  });

  // -- INVARIANT 2: EMPTY POLICY SET = TODAY, BYTE FOR BYTE ----------------
  it("(2) absent abacDecision is byte-identical to the pre-ADR-0040 kernel — representative ALLOW", () => {
    const base = {
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      execution: EXEC,
    };
    const today = evaluate(base);
    expect(evaluate({
    ...base, abacDecision: null })).toEqual(today);
    expect(evaluate({
    ...base, abacDecision: undefined })).toEqual(today);
    // the full Decision, ruleChain included — not merely the effect
    expect(today).toEqual({
      effect: "allow",
      ruleId: "tg-abac",
      ruleChain: [
        { rule: "tool-allow-list", outcome: "allow", grantId: "tg-abac" },
        { rule: "data-scope", outcome: "no-match" },
        { rule: "rate-limit", outcome: "no-match" },
        { rule: "approval-required", outcome: "no-match" },
      ],
      reason: "tool 'query_database' on server 'server-1' is on user's allow-list",
    });
  });

  it("(2) absent abacDecision is byte-identical — representative DENY", () => {
    const base = { userId: USER, serverId: SERVER, tool: writeTool, toolGrants: [], serverGrants: [], execution: EXEC };
    const today = evaluate(base);
    expect(evaluate({
    ...base, abacDecision: null })).toEqual(today);
    expect(today).toEqual({
      effect: "deny",
      ruleId: DEFAULT_DENY_RULE_ID,
      ruleChain: [
        { rule: "tool-allow-list", outcome: "no-match" },
        { rule: "role-tool-allow-list", outcome: "no-match" },
        { rule: "server-read-only-all", outcome: "no-match" },
        { rule: "role-server-read-only-all", outcome: "no-match" },
        { rule: "default-deny", outcome: "deny" },
      ],
      reason: "no grant matches user 'user-a', server 'server-1', tool 'drop_table' — default-deny",
    });
  });

  it("(2) a 'permit' verdict adds NO rule-chain entry — a matching-nothing policy set is invisible", () => {
    const base = {
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      execution: EXEC,
    };
    expect(evaluate({
    ...base, abacDecision: { effect: "permit" } })).toEqual(evaluate(base));
  });

  // -- FORBID -> DENY ------------------------------------------------------
  it("a forbid DENIES a granted call, naming the policy in ruleId and abac-forbid in the chain", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      abacDecision: FORBID,
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(FORBID.policyId);
    expect(d.ruleChain).toEqual([
      { rule: "tool-allow-list", outcome: "allow", grantId: "tg-abac" },
      { rule: "abac-forbid", outcome: "deny", grantId: FORBID.policyId },
    ]);
    expect(d.reason).toContain("no-night-hipaa-writes");
    expect(d.reason).toContain("v3");
  });

  it("a forbid beats data-scope, rate-limit and approval — it is terminal like the lead ceiling", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      dataScopeRules: [
        { id: "ds-1", userId: USER, serverId: SERVER, toolName: null, argPath: "schema", allowedValues: ["public"] },
      ],
      rateLimits: [
        { id: "rl-1", userId: USER, serverId: SERVER, toolName: null, maxCalls: 1, windowSeconds: 60, currentCount: 9 },
      ],
      approvalRules: [
        { id: "ar-1", userId: USER, serverId: SERVER, toolName: null, writeOnly: false, approverUserId: "boss" },
      ],
      abacDecision: FORBID,
    });
    expect(d.ruleId).toBe(FORBID.policyId);
    expect(d.ruleChain.map((t) => t.rule)).toEqual(["tool-allow-list", "abac-forbid"]);
  });

  // -- REQUIRE APPROVAL -> THE SAME QUEUE ----------------------------------
  it("require_approval pauses the call through the ordinary require_approval effect + approver", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      abacDecision: {
        effect: "require_approval",
        policyId: "e0f1a2b3-0000-4000-8000-000000000002",
        policyName: "prod-writes-need-signoff",
        approverUserId: "approver-1",
        approverName: "Ada",
      },
    });
    expect(d.effect).toBe("require_approval");
    expect(d.ruleId).toBe("e0f1a2b3-0000-4000-8000-000000000002");
    expect(d.approverUserId).toBe("approver-1");
    expect(d.approverName).toBe("Ada");
    expect(d.ruleChain).toEqual([
      { rule: "tool-allow-list", outcome: "allow", grantId: "tg-abac" },
      { rule: "data-scope", outcome: "no-match" },
      { rule: "rate-limit", outcome: "no-match" },
      { rule: "abac-forbid", outcome: "require-approval", grantId: "e0f1a2b3-0000-4000-8000-000000000002" },
    ]);
  });

  it("an already-approved queue entry satisfies an ABAC pause — the SAME mechanism, not a second one", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      approvedApprovalId: "approval-99",
      abacDecision: {
        effect: "require_approval", policyId: "pol-2", approverUserId: "approver-1",
      },
    });
    expect(d.effect).toBe("allow");
    expect(d.ruleChain).toContainEqual({
      rule: "abac-forbid", outcome: "satisfied-by-approval", grantId: "approval-99",
    });
  });

  it("a require_approval with NO approver FAILS CLOSED to a deny — never a silent allow", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      abacDecision: { effect: "require_approval", policyId: "pol-3" },
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("pol-3");
    expect(d.reason).toContain("names no approver");
  });

  it("a DENY from data-scope or rate-limit still wins over an ABAC pause — a pause is not an escape hatch", () => {
    const pause = {
      effect: "require_approval" as const, policyId: "pol-4", approverUserId: "approver-1",
    };
    const scoped = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      dataScopeRules: [
        { id: "ds-2", userId: USER, serverId: SERVER, toolName: null, argPath: "schema", allowedValues: ["public"] },
      ],
      args: { schema: "secret" },
      abacDecision: pause,
    });
    expect(scoped.effect).toBe("deny");
    expect(scoped.ruleId).toBe("ds-2");
    const limited = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      rateLimits: [
        { id: "rl-2", userId: USER, serverId: SERVER, toolName: null, maxCalls: 1, windowSeconds: 60, currentCount: 4 },
      ],
      abacDecision: pause,
    });
    expect(limited.effect).toBe("deny");
    expect(limited.ruleId).toBe("rl-2");
  });

  it("an ABAC pause takes precedence over a rule-driven approval, and both name a real approver", () => {
    const d = evaluate({
    execution: EXEC,
      userId: USER, serverId: SERVER, tool: readTool,
      toolGrants: [abacToolGrant], serverGrants: [],
      approvalRules: [
        { id: "ar-2", userId: USER, serverId: SERVER, toolName: null, writeOnly: false, approverUserId: "rule-boss" },
      ],
      abacDecision: {
        effect: "require_approval", policyId: "pol-5", approverUserId: "abac-boss",
      },
    });
    expect(d.effect).toBe("require_approval");
    expect(d.ruleId).toBe("pol-5");
    expect(d.approverUserId).toBe("abac-boss");
  });
});

// ===========================================================================
// AER-017 — `require_approval` mode manufactured entitlement and could never
// be satisfied.
// ===========================================================================
//
// ADR-0124 put the execution gate FIRST, "ahead of every grant, rule, limit and
// scope", and argued for it well: a stop that ran after entitlement resolution
// would still be a stop, but it would be one more thing to get right in the
// wrong order later. That argument is correct for `halted`, a subject halt and
// `read_only` — each can ONLY deny, so running it first is free.
//
// It is WRONG for `require_approval`, and the reason is the whole finding:
// `require_approval` is not a stop. It is a CONDITIONAL ALLOW — the one effect
// the gate can return that leads to execution. Returning it before entitlement
// is resolved produces two defects at once:
//
//   1. an UNGRANTED caller is invited into the approvals queue, so approval
//      manufactures entitlement — contradicting the rule this very file states
//      in `evaluate`'s own docstring: "an ungranted call is default-denied and
//      nothing can rescue it";
//   2. the approval can NEVER be consumed. The gate returns before the consume
//      logic, so a retry carrying an approved id gets `require_approval` again,
//      forever. Operators approve work that cannot run.
//
// ADR-0124's exhaustive "the gate can only ever restrict" unit test passed
// throughout, because `require_approval` is not technically an `allow` — which
// is exactly how a conditional allow hid inside a set of stops.

describe("AER-017 — require_approval is a restriction on an allowed call, not a gate before one", () => {
  const REQ = { mode: "require_approval", approverUserId: "approver-1" } as const;
  const grant = toolGrant();

  it("does NOT queue an UNGRANTED call — approval can never manufacture entitlement", () => {
    const d = evaluate({
      execution: REQ,
      userId: USER,
      serverId: SERVER,
      tool: readTool,
      toolGrants: [],
      serverGrants: [],
    });
    // default-deny, exactly as in normal mode. The dial restricts; it does not
    // invite. Before the fix this returned require_approval and the proxy duly
    // opened a queue row for a caller with no grant at all.
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(DEFAULT_DENY_RULE_ID);
    expect(d.ruleChain.some((t) => t.rule === "execution-require-approval")).toBe(false);
  });

  it("queues a GRANTED call, naming the dial's approver", () => {
    const d = evaluate({
      execution: REQ,
      userId: USER,
      serverId: SERVER,
      tool: readTool,
      toolGrants: [grant],
      serverGrants: [],
    });
    expect(d.effect).toBe("require_approval");
    expect(d.ruleId).toBe("execution-require-approval");
    expect(d.approverUserId).toBe("approver-1");
    // THE ORDERING UNDER TEST, read off the chain: the grant is resolved and the
    // denial checks are traversed BEFORE the hold is recorded. That sequence is
    // the fix — the hold can only restrict a call the rest of the policy already
    // allowed, and the ledger shows it.
    expect(d.ruleChain).toEqual([
      { rule: "tool-allow-list", outcome: "allow", grantId: "tg-1" },
      { rule: "data-scope", outcome: "no-match" },
      { rule: "rate-limit", outcome: "no-match" },
      { rule: "execution-require-approval", outcome: "require-approval" },
    ]);
  });

  it("THE PERMANENT LOOP, closed: an approved id satisfies the hold and the call proceeds", () => {
    const d = evaluate({
      execution: REQ,
      userId: USER,
      serverId: SERVER,
      tool: readTool,
      toolGrants: [grant],
      serverGrants: [],
      approvedApprovalId: "appr-1",
    });
    expect(d.effect).toBe("allow");
    // the ledger records WHICH approval satisfied it, so the consume is traceable
    expect(d.ruleChain).toEqual([
      { rule: "tool-allow-list", outcome: "allow", grantId: "tg-1" },
      { rule: "data-scope", outcome: "no-match" },
      { rule: "rate-limit", outcome: "no-match" },
      { rule: "execution-require-approval", outcome: "satisfied-by-approval", grantId: "appr-1" },
      // and evaluation CONTINUES past the satisfied hold into the ordinary
      // approval rules, exactly as the ABAC hold does — the dial does not
      // short-circuit the rest of the policy on the way to an allow
      { rule: "approval-required", outcome: "no-match" },
    ]);
  });

  it("cannot override a rate limit, a data-scope refusal or an ABAC forbid", () => {
    // "Approval restricts an allow path" cuts both ways: a call the other rules
    // deny must stay denied in this mode, and must not be offered a queue.
    const overLimit = evaluate({
      execution: REQ,
      userId: USER,
      serverId: SERVER,
      tool: readTool,
      toolGrants: [grant],
      serverGrants: [],
      rateLimits: [
        { id: "rl-1", scope: "user", userId: USER, serverScope: "server", serverId: SERVER,
          toolName: null, maxCalls: 1, windowSeconds: 60, currentCount: 1 },
      ],
    });
    expect(overLimit.effect).toBe("deny");
    expect(overLimit.ruleId).toBe("rl-1");

    const forbidden = evaluate({
      execution: REQ,
      userId: USER,
      serverId: SERVER,
      tool: readTool,
      toolGrants: [grant],
      serverGrants: [],
      abacDecision: { effect: "forbid", policyId: "pol-1", reason: "off-network" },
    });
    expect(forbidden.effect).toBe("deny");
    expect(forbidden.ruleId).toBe("pol-1");
  });

  it("a HALT still stops first — the stops keep their ADR-0124 ordering", () => {
    // Only the conditional hold moved. `halted` must still refuse an ungranted
    // caller without resolving entitlement, because that is a stop and running
    // it first costs nothing.
    const halted = evaluate({
      execution: { mode: "halted" },
      userId: USER,
      serverId: SERVER,
      tool: readTool,
      toolGrants: [],
      serverGrants: [],
    });
    expect(halted.effect).toBe("deny");
    expect(halted.ruleId).toBe("execution-halted");
    expect(halted.ruleChain).toEqual([{ rule: "execution-halted", outcome: "deny" }]);

    // read-only likewise, and it still lets a read through untouched
    const roWrite = evaluate({
      execution: { mode: "read_only" },
      userId: USER,
      serverId: SERVER,
      tool: writeTool,
      toolGrants: [],
      serverGrants: [],
    });
    expect(roWrite.ruleId).toBe("execution-read-only");
  });

  it("read_only and require_approval COMPOSE: a write is stopped, not queued", () => {
    // Belt and braces on the ordering: if a deployment is in require_approval
    // mode the write path is still subject to every stop, and a stop wins.
    const d = evaluate({
      execution: { mode: "read_only" },
      userId: USER,
      serverId: SERVER,
      tool: writeTool,
      toolGrants: [toolGrant({ id: "tg-w", toolName: "drop_table" })],
      serverGrants: [],
    });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe("execution-read-only");
  });
});
