/**
 * ADR-0175 batch D2 — the two new monitor rules, pure half:
 *   A4 `served_model_drift`       the provider served a model other than the configured one
 *   A9 `unregistered_ai_traffic`  model/MCP spend no approved use case covers
 */
import { describe, expect, it } from "vitest";
import {
  MONITOR_RULES,
  evaluateMonitorRules,
  servedModelMatches,
  servedModelMatchesPin,
  splitModelVersion,
  type MonitorInput,
  type MonitorServedModelInput,
  type MonitorTrafficRow,
} from "./governance-monitor.js";
import { proposeRemediations } from "./remediation.js";

const base = (over: Partial<MonitorInput> = {}): MonitorInput => ({
  useCases: [],
  agents: new Map(),
  vendors: new Map(),
  risks: [],
  dimensions: [],
  ...over,
});
const at = "2026-10-01T00:00:00.000Z";
const sm = (over: Partial<MonitorServedModelInput> = {}): MonitorServedModelInput => ({
  agentId: "a1",
  agentName: "Support bot",
  pinnedModelVersions: [],
  windowDays: 7,
  observations: [],
  ...over,
});
const obs = (configuredModel: string, servedModel: string, calls = 1) => ({ configuredModel, servedModel, calls, lastServedAt: at });

describe("A4 served-model matching rule", () => {
  it.each([
    ["name", "name", true],
    ["name", "name-20250101", true], // alias resolved to its dated snapshot
    ["name-20250101", "name", true], // pinned id reported as its alias
    ["name", "name-2025-01-01", true],
    ["name-latest", "name-20250101", true],
    ["name", "name@20250101", true],
    ["model-g", "model-g-001", true],
    ["Name", " name-20250101 ", true], // case and whitespace
    ["models/name", "name-0613", true], // a path prefix is dropped
    ["name", "name-v1:0", true],
    ["name-20250101", "name-20250301", false], // a pinned snapshot was swapped
    ["name", "name-mini-20250101", false], // a different model
    ["name", "other", false],
    ["name-v1", "name-v2", false],
    ["mock-balanced", "mock-fast-2", false],
  ])("%s vs %s → %s", (configured, served, expected) => {
    expect(servedModelMatches(configured, served)).toBe(expected);
  });

  it("splits base and version", () => {
    expect(splitModelVersion("vendor/name-2025-01-01")).toEqual({ base: "name", version: "2025-01-01" });
    expect(splitModelVersion("name-20240620-v1:0")).toEqual({ base: "name", version: "20240620-v1:0" });
    expect(splitModelVersion("name-latest")).toEqual({ base: "name", version: null });
    expect(splitModelVersion("plain")).toEqual({ base: "plain", version: null });
  });

  it("a pin matches only the exact id", () => {
    expect(servedModelMatchesPin("name-20250101", "NAME-20250101")).toBe(true);
    expect(servedModelMatchesPin("name-20250101", "name")).toBe(false);
  });
});

describe("A4 served_model_drift", () => {
  it("is in the rule catalogue with display copy", () => {
    expect(MONITOR_RULES.served_model_drift.label).toBeTruthy();
    expect(MONITOR_RULES.served_model_drift.severity).toBe("medium");
  });

  it("a different served model raises ONE medium episode per agent", () => {
    const f = evaluateMonitorRules(
      base({ servedModels: [sm({ observations: [obs("mock-balanced", "mock-fast-2", 3), obs("mock-balanced", "other-x", 1)] })] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ ruleId: "served_model_drift", subjectKey: "agent:a1", severity: "medium" });
    expect(f[0]!.title).toBe("Support bot was served mock-fast-2, other-x instead of its configured mock-balanced on 4 calls");
    expect(f[0]!.detail).toMatchObject({ agentId: "a1", calls: 4, windowDays: 7, pinnedModelVersions: [] });
    expect((f[0]!.detail.observations as unknown[]).length).toBe(2);
  });

  it("an alias resolving to its dated snapshot does NOT alert", () => {
    const f = evaluateMonitorRules(base({ servedModels: [sm({ observations: [obs("name", "name-20250101", 50)] })] }));
    expect(f).toEqual([]);
  });

  it("matching served models only — nothing", () => {
    const f = evaluateMonitorRules(base({ servedModels: [sm({ observations: [obs("mock-balanced", "mock-balanced", 9)] })] }));
    expect(f).toEqual([]);
  });

  it("a pinned card version turns even an alias-compatible id into a HIGH alert", () => {
    const f = evaluateMonitorRules(
      base({ servedModels: [sm({ pinnedModelVersions: ["name-20250101"], observations: [obs("name", "name-20250301", 2), obs("name", "name-20250101", 5)] })] }),
    );
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe("high");
    expect(f[0]!.title).toBe("Support bot was served name-20250301 instead of its model card's pinned name-20250101 on 2 calls");
    expect((f[0]!.detail.observations as Array<{ reason: string }>)[0]!.reason).toBe("pinned_version_mismatch");
  });

  it("served exactly at the pin — nothing, even though the configured id is the bare alias", () => {
    const f = evaluateMonitorRules(base({ servedModels: [sm({ pinnedModelVersions: ["name-20250101"], observations: [obs("name", "name-20250101", 5)] })] }));
    expect(f).toEqual([]);
  });

  it("not evaluated when no served-model input is given", () => {
    expect(evaluateMonitorRules(base())).toEqual([]);
  });
});

describe("A9 unregistered_ai_traffic", () => {
  const row = (over: Partial<MonitorTrafficRow>): MonitorTrafficRow => ({
    projectId: null,
    virtualKeyId: null,
    userId: "u1",
    kind: "model",
    calls: 1,
    costUsd: 0.01,
    lastAt: at,
    ...over,
  });
  const traffic = (rows: MonitorTrafficRow[], covered: string[] = []) =>
    base({
      traffic: {
        windowDays: 7,
        rows,
        coveredProjectIds: new Set(covered),
        linkedNotApproved: new Map([["p2", [{ id: "uc9", name: "Draft UC", status: "under_review" }]]]),
        projectNames: new Map([["p1", "Fraud ops"], ["p2", "Shadow"]]),
        virtualKeyNames: new Map([["vk1", "ci-runner"]]),
        userNames: new Map([["u1", "Ada"], ["u2", "Bo"]]),
      },
    });

  it("traffic on a project an approved use case links raises nothing", () => {
    expect(evaluateMonitorRules(traffic([row({ projectId: "p1", calls: 9 })], ["p1"]))).toEqual([]);
  });

  it("a project no approved use case links → one finding naming keys, callers and the unapproved link", () => {
    const f = evaluateMonitorRules(
      traffic([
        row({ projectId: "p2", calls: 3, costUsd: 0.5 }),
        row({ projectId: "p2", kind: "mcp", calls: 2, costUsd: null, userId: "u2", virtualKeyId: "vk1" }),
      ]),
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ ruleId: "unregistered_ai_traffic", subjectKey: "project:p2", severity: "medium" });
    expect(f[0]!.title).toBe("Project Shadow: 3 model calls and 2 MCP tool calls in 7 days, no approved use case links this project");
    expect(f[0]!.detail).toMatchObject({
      subjectType: "project",
      modelCalls: 3,
      mcpCalls: 2,
      costUsd: 0.5,
      virtualKeys: [{ id: "vk1", name: "ci-runner", calls: 2 }],
      callers: [{ id: "u1", name: "Ada", calls: 3 }, { id: "u2", name: "Bo", calls: 2 }],
      linkedUseCasesNotApproved: [{ id: "uc9", name: "Draft UC", status: "under_review" }],
    });
  });

  it("projectless traffic groups by virtual key, else by caller", () => {
    const f = evaluateMonitorRules(
      traffic([row({ virtualKeyId: "vk1", calls: 4 }), row({ userId: "u2", calls: 1, kind: "mcp" }), row({ projectId: "p1" })], ["p1"]),
    );
    expect(f.map((x) => x.subjectKey)).toEqual(["caller:u2", "virtual_key:vk1"]);
    expect(f.find((x) => x.subjectKey === "virtual_key:vk1")!.title).toBe(
      "Virtual key ci-runner: 4 model calls in 7 days, attributed to no project",
    );
    expect(f.find((x) => x.subjectKey === "caller:u2")!.title).toBe(
      "Bo: 1 MCP tool call in 7 days, attributed to no project and on no virtual key",
    );
  });

  it("not evaluated when no traffic input is given", () => {
    expect(evaluateMonitorRules(base())).toEqual([]);
  });
});

describe("ADR-0175 remediation guidance", () => {
  it("unregistered traffic offers the register flow, prefilled", () => {
    const [c] = proposeRemediations({
      alert: {
        ruleId: "unregistered_ai_traffic",
        subjectKey: "project:p2",
        detail: { subjectType: "project", subjectLabel: "Shadow", modelCalls: 3, mcpCalls: 0, windowDays: 7, linkedUseCasesNotApproved: [] },
      },
      risks: new Map(),
      activeControls: new Map(),
    });
    expect(c).toMatchObject({ kind: "register_use_case", executable: false, params: { projectId: "p2" } });
    const url = new URL(c!.href!, "http://x");
    expect(url.pathname).toBe("/admin/governance/intake");
    expect(url.searchParams.get("source")).toBe("monitor");
    expect(url.searchParams.get("title")).toBe("AI use in project Shadow");
    expect(url.searchParams.get("description")).toContain("3 model calls in 7 days attributed to project Shadow");
  });

  it("served-model drift offers a review, never an automatic change", () => {
    const [c] = proposeRemediations({
      alert: {
        ruleId: "served_model_drift",
        subjectKey: "agent:a1",
        detail: { pinnedModelVersions: [], observations: [{ servedModel: "mock-fast-2" }] },
      },
      risks: new Map(),
      activeControls: new Map(),
      labels: new Map([["agent:a1", "Support bot"]]),
    });
    expect(c).toMatchObject({ kind: "review_served_model", executable: false, params: { agentId: "a1" } });
    expect(c!.title).toBe("Confirm why Support bot was served mock-fast-2");
  });
});
