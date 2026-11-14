/**
 * ADR-0251 slice 4 — Cedar schema v5: the governed core's other actions (`ModelInvoke`, `ConnectorCall`,
 * `A2aMessage`) on their own resource types (`Model`, `Connector`, `RemoteAgent`).
 */
import { describe, expect, it } from "vitest";
import {
  ABAC_CURRENT_SCHEMA_VERSION,
  ABAC_SCHEMA_VERSIONS,
  ABAC_V5_RESOURCE_HELP,
  abacEngine,
  abacSchemaText,
  type AbacGovernedResourceAttrs,
  type AbacPolicy,
  type AbacRequest,
} from "./abac.js";

const policy = (id: string, source: string, schemaVersion = "v5", mode: AbacPolicy["mode"] = "forbid"): AbacPolicy => ({
  id,
  name: id,
  source,
  mode,
  timezone: "UTC",
  schemaVersion,
  version: 1,
  ...(mode === "require_approval" ? { approverUserId: "approver-1" } : {}),
});

const base = (over: Partial<AbacRequest> = {}): AbacRequest => ({
  principal: {
    id: "22222222-2222-4222-8222-222222222222",
    roles: ["engineer"],
    roleIds: ["r1"],
    teams: [],
    isAdmin: false,
    sessionOrigin: "api_key",
    mfaCompleted: false,
    aiTrainingCurrent: true,
  },
  resource: { id: "srv/deploy", serverId: "srv", serverName: "ops", toolName: "deploy", kind: "write", priceTier: "metered", classifications: ["pci"] },
  context: { deployModes: [], environments: [], rateLimitUsagePct: 0 },
  ...over,
});
const shared = { name: "x", priceTier: "metered", projectId: "p1", projectName: "Payments", classifications: ["pci"], dataSensitivity: "pci" };
const MODEL: AbacGovernedResourceAttrs = { type: "Model", id: "m1", ...shared, name: "gpt", provider: "openai", model: "gpt-x", mode: "chat" };
const CONNECTOR: AbacGovernedResourceAttrs = { type: "Connector", id: "c1", ...shared, name: "crm", providerKind: "salesforce", operation: "write" };
const REMOTE: AbacGovernedResourceAttrs = { type: "RemoteAgent", id: "r1", ...shared, name: "travel", skillId: "book" };

describe("ADR-0251 slice 4: schema v5 declares the governed actions", () => {
  it("is a known, opt-in version; v4 stays the default stamp", () => {
    expect(ABAC_SCHEMA_VERSIONS).toContain("v5");
    expect(ABAC_CURRENT_SCHEMA_VERSION).toBe("v4");
    const text = abacSchemaText("v5")!;
    for (const name of ["ModelInvoke", "ConnectorCall", "A2aMessage", "Model", "Connector", "RemoteAgent", "McpToolCall"]) expect(text).toContain(name);
  });

  it("a policy naming a governed action validates under v5 and is refused under v4 (no silent no-op)", () => {
    const src = 'forbid (principal, action == RegulAIt::Action::"ModelInvoke", resource) when { resource.mode == "execute" };';
    expect(abacEngine.validate(src, "v5")).toMatchObject({ ok: true });
    expect(abacEngine.validate(src, "v4").ok).toBe(false);
  });

  it("an unscoped v5 policy reading a type-specific attribute is refused, with help that says how to narrow it", () => {
    const r = abacEngine.validate('forbid (principal, action, resource) when { resource.toolName == "deploy" };', "v5");
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => (e.help ?? "").includes(ABAC_V5_RESOURCE_HELP))).toBe(true);
    // narrowed, it validates
    expect(abacEngine.validate('forbid (principal, action == RegulAIt::Action::"McpToolCall", resource) when { resource.toolName == "deploy" };', "v5").ok).toBe(true);
    expect(abacEngine.validate('forbid (principal, action, resource is RegulAIt::Connector) when { resource.operation == "write" };', "v5").ok).toBe(true);
  });
});

describe("ADR-0251 slice 4: evaluation", () => {
  const onlyModels = policy("no-execute-models", 'forbid (principal, action == RegulAIt::Action::"ModelInvoke", resource) when { resource.mode == "chat" };');
  const connectorWrites = policy("no-crm-writes", 'forbid (principal, action == RegulAIt::Action::"ConnectorCall", resource) when { resource.operation == "write" };');
  const skill = policy("hold-bookings", 'forbid (principal, action == RegulAIt::Action::"A2aMessage", resource) when { resource has skillId && resource.skillId == "book" };', "v5", "require_approval");
  const everywhere = policy("no-pci-for-non-admins", 'forbid (principal is RegulAIt::User, action, resource) when { !principal.isAdmin && resource.classifications.contains("pci") };');
  const toolV4 = policy("v4-tool", "forbid (principal, action, resource) when { resource.toolName == \"deploy\" };", "v4");

  it("each governed action is decided by the policies written for it", () => {
    expect(abacEngine.evaluate([onlyModels, connectorWrites, skill], base({ governed: MODEL }))).toMatchObject({ effect: "forbid", policyId: "no-execute-models" });
    expect(abacEngine.evaluate([onlyModels, connectorWrites, skill], base({ governed: CONNECTOR }))).toMatchObject({ effect: "forbid", policyId: "no-crm-writes" });
    expect(abacEngine.evaluate([onlyModels, connectorWrites, skill], base({ governed: REMOTE }))).toMatchObject({
      effect: "require_approval",
      policyId: "hold-bookings",
      approverUserId: "approver-1",
    });
    expect(abacEngine.evaluate([onlyModels], base({ governed: { ...MODEL, mode: "execute" } }))).toEqual({ effect: "permit" });
  });

  it("v1–v4 policies never run for a governed call (they were written for McpToolCall), but still run for tools", () => {
    expect(abacEngine.evaluate([toolV4], base({ governed: MODEL }))).toEqual({ effect: "permit" });
    expect(abacEngine.evaluate([toolV4], base())).toMatchObject({ effect: "forbid", policyId: "v4-tool" });
  });

  it("an unscoped v5 policy about a shared attribute applies to every call type, tools included", () => {
    for (const governed of [MODEL, CONNECTOR, REMOTE]) {
      expect(abacEngine.evaluate([everywhere], base({ governed })), governed.type).toMatchObject({ effect: "forbid", policyId: "no-pci-for-non-admins" });
    }
    expect(abacEngine.evaluate([everywhere], base())).toMatchObject({ effect: "forbid", policyId: "no-pci-for-non-admins" });
    const admin = base({ governed: MODEL });
    admin.principal = { ...admin.principal, isAdmin: true };
    expect(abacEngine.evaluate([everywhere], admin)).toEqual({ effect: "permit" });
  });

  it("a governed call by an Agent principal is evaluated as that agent (v5 carries the v4 principals)", () => {
    const agentReq = base({
      governed: MODEL,
      agent: { id: "a1", kind: "agent", identifier: "spiffe://t/a1", environments: [], stewards: [] },
      delegation: { actorChain: ["a1"], delegationDepth: 1 },
    });
    const deep = policy("no-delegated-models", 'forbid (principal is RegulAIt::Agent, action == RegulAIt::Action::"ModelInvoke", resource) when { context.delegationDepth > 0 };');
    expect(abacEngine.evaluate([deep, everywhere], agentReq)).toMatchObject({ effect: "forbid", policyId: "no-delegated-models" });
  });

  it("an optional attribute that is absent is genuinely absent (an unattributed call), so a guarded policy does not match", () => {
    const attributed = policy("needs-project", 'forbid (principal, action == RegulAIt::Action::"ConnectorCall", resource) unless { resource has projectId };');
    const { projectId: _p, projectName: _n, ...unattributed } = CONNECTOR as AbacGovernedResourceAttrs & { projectId?: string; projectName?: string };
    expect(abacEngine.evaluate([attributed], base({ governed: unattributed as AbacGovernedResourceAttrs }))).toMatchObject({ effect: "forbid" });
    expect(abacEngine.evaluate([attributed], base({ governed: CONNECTOR }))).toEqual({ effect: "permit" });
  });
});
