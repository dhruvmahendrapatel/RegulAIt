/** ADR-0357: the document schema, the normal form and the plan's classification table, one row at a time. */
import { describe, expect, it } from "vitest";
import {
  GOVERNANCE_CONFIG_API_VERSION,
  duplicateKeys,
  governanceConfigJsonSchema,
  governanceConfigSchema,
  normalizeSpec,
  planGovernanceConfig,
  planWidenings,
  specRevision,
  toGovernanceDocument,
  type GovernanceConfigSpec,
  type NormalSpec,
} from "./governance-config.js";

const APPROVER = "00000000-0000-4000-8000-000000000001";
const EMPTY: Required<NormalSpec> = { roles: [], rateLimits: [], mcpBundles: [], workflowTemplates: [], budgets: [] };
const live = (spec: GovernanceConfigSpec): Required<NormalSpec> => ({ ...EMPTY, ...normalizeSpec(spec) });
const plan = (before: GovernanceConfigSpec, after: GovernanceConfigSpec) => planGovernanceConfig(live(before), normalizeSpec(after));
const codes = (before: GovernanceConfigSpec, after: GovernanceConfigSpec) =>
  plan(before, after).changes.flatMap((c) => c.findings.map((f) => `${f.effect}:${f.code}`));

describe("the document schema", () => {
  it("accepts a full document and refuses unknown keys, versions and kinds", () => {
    const doc = {
      apiVersion: GOVERNANCE_CONFIG_API_VERSION,
      kind: "GovernanceConfig",
      spec: { roles: [{ name: "eng", toolGrants: [{ server: "gh", tool: "read" }] }] },
    };
    expect(governanceConfigSchema.safeParse(doc).success).toBe(true);
    expect(governanceConfigSchema.safeParse({ ...doc, apiVersion: "regulait.io/governance/v2" }).success).toBe(false);
    expect(governanceConfigSchema.safeParse({ ...doc, kind: "Other" }).success).toBe(false);
    expect(governanceConfigSchema.safeParse({ ...doc, spec: { ...doc.spec, secrets: [] } }).success).toBe(false);
    expect(governanceConfigSchema.safeParse({ ...doc, spec: { roles: [{ name: "eng", token: "x" }] } }).success).toBe(false);
  });

  it("refuses rate limits whose subject does not match their scope, and tool limits with no server", () => {
    const rl = (r: Record<string, unknown>) =>
      governanceConfigSchema.safeParse({ apiVersion: GOVERNANCE_CONFIG_API_VERSION, kind: "GovernanceConfig", spec: { rateLimits: [r] } }).success;
    expect(rl({ scope: "fleet", maxCalls: 1, windowSeconds: 60 })).toBe(true);
    expect(rl({ scope: "fleet", subject: "eng", maxCalls: 1, windowSeconds: 60 })).toBe(false);
    expect(rl({ scope: "role", maxCalls: 1, windowSeconds: 60 })).toBe(false);
    expect(rl({ scope: "user", subject: "u", maxCalls: 1, windowSeconds: 60 })).toBe(false);
    expect(rl({ scope: "fleet", tool: "t", maxCalls: 1, windowSeconds: 60 })).toBe(false);
  });

  it("a bundle grant names exactly one subject", () => {
    const b = (g: Record<string, unknown>) =>
      governanceConfigSchema.safeParse({ apiVersion: GOVERNANCE_CONFIG_API_VERSION, kind: "GovernanceConfig", spec: { mcpBundles: [{ name: "b", grants: [g] }] } }).success;
    expect(b({ role: "eng" })).toBe(true);
    expect(b({ role: "eng", team: "t" })).toBe(false);
    expect(b({})).toBe(false);
  });

  it("publishes a JSON Schema with the version pinned", () => {
    const js = JSON.stringify(governanceConfigJsonSchema());
    expect(js).toContain(GOVERNANCE_CONFIG_API_VERSION);
    expect(js).toContain("additionalProperties");
  });

  it("reports duplicate keys inside a section", () => {
    expect(duplicateKeys({ roles: [{ name: "a" }, { name: "a" }], budgets: [] })).toEqual([{ section: "roles", key: "a" }]);
  });
});

describe("the normal form", () => {
  it("is independent of list order and fills defaults", () => {
    const a = normalizeSpec({
      roles: [{ name: "b" }, { name: "a", toolGrants: [{ server: "s", tool: "y" }, { server: "s", tool: "x" }] }],
    });
    const b = normalizeSpec({
      roles: [{ name: "a", description: null, toolGrants: [{ server: "s", tool: "x" }, { server: "s", tool: "y" }] }, { name: "b", toolGrants: [] }],
    });
    expect(specRevision(a)).toBe(specRevision(b));
  });

  it("export round-trips: an exported document plans to no change against the live state it came from", () => {
    const spec: GovernanceConfigSpec = {
      roles: [{ name: "eng", connectorGrants: [{ connector: "jira", mode: "read", allowedObjects: ["issue"] }], agentGrants: [{ agent: "claude" }] }],
      rateLimits: [{ scope: "role", subject: "eng", server: "gh", maxCalls: 10, windowSeconds: 60 }],
      mcpBundles: [{ name: "b", items: [{ server: "gh", tool: "read" }], grants: [{ team: "t", maxTier: "write" }] }],
      workflowTemplates: [{ name: "w", definition: { stages: [] } }],
      budgets: [{ project: "p", budgetUsd: 100, approverUserId: APPROVER }],
    };
    const doc = toGovernanceDocument(live(spec), "2026-11-17T00:00:00Z");
    const reparsed = governanceConfigSchema.parse(JSON.parse(JSON.stringify(doc)));
    const p = planGovernanceConfig(live(spec), normalizeSpec(reparsed.spec));
    expect(p.changes).toEqual([]);
    expect(doc.metadata?.revision).toBe(specRevision(live(spec)));
  });
});

describe("the plan: sections and binding", () => {
  it("touches only the sections the file names", () => {
    const p = plan({ roles: [{ name: "eng", toolGrants: [{ server: "s", tool: "t" }] }] }, { budgets: [] });
    expect(p.sections).toEqual(["budgets"]);
    expect(p.changes).toEqual([]);
  });

  it("an empty section prunes everything in it", () => {
    const p = plan({ roles: [{ name: "eng" }] }, { roles: [] });
    expect(p.changes.map((c) => [c.op, c.key, c.effect])).toEqual([["delete", "eng", "narrows"]]);
  });

  it("the plan hash moves when the live state or the file moves, and not with order", () => {
    const a = plan({ roles: [{ name: "x" }] }, { roles: [{ name: "a" }, { name: "b" }] }).planHash;
    expect(plan({ roles: [{ name: "x" }] }, { roles: [{ name: "b" }, { name: "a" }] }).planHash).toBe(a);
    expect(plan({ roles: [{ name: "y" }] }, { roles: [{ name: "a" }, { name: "b" }] }).planHash).not.toBe(a);
    expect(plan({ roles: [{ name: "x" }] }, { roles: [{ name: "a" }] }).planHash).not.toBe(a);
  });

  it("each change carries an RFC 6902 patch", () => {
    const [c] = plan({ budgets: [{ project: "p", budgetUsd: 10, approverUserId: APPROVER }] }, { budgets: [{ project: "p", budgetUsd: 20, approverUserId: APPROVER }] }).changes;
    expect(c!.patch).toEqual([{ op: "replace", path: "/budgetUsd", value: 20 }]);
  });
});

describe("the classification table (ADR-0357 §3)", () => {
  const role = (r: Record<string, unknown>) => ({ roles: [{ name: "eng", ...r }] });
  it("roles", () => {
    expect(codes({ roles: [] }, role({ toolGrants: [{ server: "s", tool: "t" }] }))).toEqual(["widens:tool_grant_added"]);
    expect(codes(role({ toolGrants: [{ server: "s", tool: "t" }] }), role({}))).toEqual(["narrows:tool_grant_removed"]);
    expect(codes(role({ serverGrants: [{ server: "s", readOnlyAll: false }] }), role({ serverGrants: [{ server: "s", readOnlyAll: true }] }))).toEqual([
      "widens:server_grant_widened",
    ]);
    expect(codes(role({ serverGrants: [{ server: "s", readOnlyAll: true }] }), role({ serverGrants: [{ server: "s", readOnlyAll: false }] }))).toEqual([
      "narrows:server_grant_narrowed",
    ]);
    expect(codes(role({ connectorGrants: [{ connector: "c", mode: "read" }] }), role({ connectorGrants: [{ connector: "c", mode: "readwrite" }] }))).toEqual([
      "widens:connector_mode_widened",
    ]);
    expect(
      codes(role({ connectorGrants: [{ connector: "c", mode: "read", allowedObjects: ["a"] }] }), role({ connectorGrants: [{ connector: "c", mode: "read" }] })),
    ).toEqual(["widens:connector_c_objects_unrestricted"]);
    expect(codes(role({ agentGrants: [{ agent: "a", allowedModes: ["x", "y"] }] }), role({ agentGrants: [{ agent: "a", allowedModes: ["x"] }] }))).toEqual([
      "narrows:agent_a_modes_lost",
    ]);
    expect(codes(role({ agentGrants: [{ agent: "a" }] }), role({ agentGrants: [{ agent: "a", allowedModes: ["x"] }] }))).toEqual(["narrows:agent_a_modes_restricted"]);
    expect(codes({ roles: [] }, role({}))).toEqual(["neutral:role_created"]);
    expect(codes(role({ description: "a" }), role({ description: "b" }))).toEqual(["neutral:description_changed"]);
  });

  it("rate limits", () => {
    const rl = (r: Record<string, unknown>) => ({ rateLimits: [{ scope: "fleet" as const, maxCalls: 10, windowSeconds: 60, ...r }] });
    expect(codes(rl({}), { rateLimits: [] })).toEqual(["widens:rate_limit_removed"]);
    expect(codes({ rateLimits: [] }, rl({}))).toEqual(["narrows:rate_limit_added"]);
    expect(codes(rl({}), rl({ maxCalls: 11 }))).toEqual(["widens:max_calls_raised"]);
    expect(codes(rl({}), rl({ maxCalls: 9 }))).toEqual(["narrows:max_calls_lowered"]);
    expect(codes(rl({}), rl({ windowSeconds: 30 }))).toEqual(["widens:window_shortened"]);
    expect(codes(rl({}), rl({ windowSeconds: 120 }))).toEqual(["narrows:window_lengthened"]);
    // writeOnly selects which calls count, so flipping it is a new rule: the old one's removal widens
    expect(plan(rl({}), rl({ writeOnly: true })).changes.map((c) => [c.op, c.effect])).toEqual([
      ["delete", "widens"],
      ["create", "narrows"],
    ]);
    // a mixed edit is a widening: the reviewer must approve the part that loosens
    expect(plan(rl({}), rl({ maxCalls: 20, windowSeconds: 120 })).changes[0]!.effect).toBe("widens");
  });

  it("rate limits: live duplicates beyond the first are deleted (and that widens)", () => {
    const one = { scope: "fleet" as const, maxCalls: 10, windowSeconds: 60 };
    const p = planGovernanceConfig({ ...EMPTY, rateLimits: normalizeSpec({ rateLimits: [one, { ...one, maxCalls: 5 }] }).rateLimits! }, normalizeSpec({ rateLimits: [one] }));
    expect(p.changes.map((c) => [c.op, c.effect])).toEqual([["delete", "widens"]]);
  });

  it("MCP bundles", () => {
    const b = (x: Record<string, unknown>) => ({ mcpBundles: [{ name: "b", ...x }] });
    expect(codes(b({}), b({ items: [{ server: "s", tool: "t" }] }))).toEqual(["widens:bundle_item_added"]);
    expect(codes(b({ items: [{ server: "s", tool: "t" }] }), b({}))).toEqual(["narrows:bundle_item_removed"]);
    expect(codes(b({}), b({ grants: [{ role: "eng" }] }))).toEqual(["widens:bundle_grant_added"]);
    expect(codes(b({ grants: [{ role: "eng" }] }), b({ grants: [{ role: "eng", maxTier: "dangerous" }] }))).toEqual(["widens:bundle_tier_raised"]);
    expect(codes(b({ grants: [{ role: "eng", maxTier: "write" }] }), b({ grants: [{ role: "eng" }] }))).toEqual(["narrows:bundle_tier_lowered"]);
    expect(codes(b({ archived: true }), b({}))).toEqual(["widens:bundle_unarchived"]);
    expect(codes(b({}), { mcpBundles: [] })).toEqual(["narrows:bundle_archived"]);
    expect(codes(b({}), b({ approverUserId: APPROVER }))).toEqual(["widens:approver_changed"]);
    // an archived bundle that the file omits is already as "missing" means: no change
    expect(codes(b({ archived: true }), { mcpBundles: [] })).toEqual([]);
  });

  it("workflow templates", () => {
    const t = (x: Record<string, unknown>) => ({ workflowTemplates: [{ name: "w", definition: { stages: [1] }, ...x }] });
    expect(codes({ workflowTemplates: [] }, t({}))).toEqual(["widens:template_created"]);
    expect(codes(t({}), t({ definition: { stages: [] } }))).toEqual(["widens:definition_changed"]);
    expect(codes(t({}), t({ retired: true }))).toEqual(["narrows:template_retired"]);
    expect(codes(t({ retired: true }), t({}))).toEqual(["widens:template_unretired"]);
    expect(codes(t({}), { workflowTemplates: [] })).toEqual(["narrows:template_retired"]);
    expect(codes(t({ retired: true }), { workflowTemplates: [] })).toEqual([]);
  });

  it("budgets", () => {
    const b = (x: Record<string, unknown>) => ({ budgets: [{ project: "p", budgetUsd: 100, approverUserId: APPROVER, ...x }] });
    expect(codes(b({}), { budgets: [] })).toEqual(["widens:budget_removed"]);
    expect(codes({ budgets: [] }, b({}))).toEqual(["narrows:budget_added"]);
    expect(codes(b({}), b({ budgetUsd: 200 }))).toEqual(["widens:budget_raised"]);
    expect(codes(b({}), b({ budgetUsd: 50 }))).toEqual(["narrows:budget_lowered"]);
    expect(codes(b({}), b({ alertThresholdPct: 100 }))).toEqual(["widens:alert_threshold_raised"]);
    expect(codes(b({}), b({ alertThresholdPct: 50 }))).toEqual(["narrows:alert_threshold_lowered"]);
    expect(codes(b({}), b({ period: "monthly" }))).toEqual(["widens:period_monthly"]);
    expect(codes(b({ period: "monthly" }), b({}))).toEqual(["narrows:period_lifetime"]);
    expect(codes(b({}), b({ approverUserId: "00000000-0000-4000-8000-000000000002" }))).toEqual(["widens:approver_changed"]);
  });

  it("planWidenings lists only the widening changes and codes", () => {
    const p = plan(
      { budgets: [{ project: "p", budgetUsd: 100, approverUserId: APPROVER }] },
      { budgets: [{ project: "p", budgetUsd: 200, alertThresholdPct: 50, approverUserId: APPROVER }] },
    );
    expect(planWidenings(p)).toEqual([{ section: "budgets", key: "p", codes: ["budget_raised"] }]);
  });
});
