/**
 * ADR-0182 S5 — the pure halves of PF-14 (owner, SLA, ticket text) and PF-03
 * (the suggested halt: the KRI rule, the planner candidate). The gateway
 * suites prove the same rules on a real database.
 */
import { describe, expect, it } from "vitest";
import { ALERT_SLA_DEFAULTS } from "./accountability.js";
import { alertDueAt, alertOwnerCandidates, alertSlaChatText, alertSlaState, alertTicketText, kriOnBreachProblem } from "./alert-ownership.js";
import { evaluateMonitorRules, suggestedHaltFor, type MonitorKriInput } from "./governance-monitor.js";
import { kriCreateSchema, kriUpdateSchema } from "./kri.js";
import { EXECUTABLE_REMEDIATION_KINDS, proposeRemediations } from "./remediation.js";

const U = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const R = "33333333-3333-4333-8333-333333333333";
const V = "44444444-4444-4444-8444-444444444444";
const K = "55555555-5555-4555-8555-555555555555";

describe("PF-14 owner derivation: the records an episode's owner is read from, in order", () => {
  it("one record per subject type", () => {
    expect(alertOwnerCandidates(`use_case:${U}`, {})).toEqual([{ kind: "use_case", id: U }]);
    expect(alertOwnerCandidates(`agent:${A}`, {})).toEqual([{ kind: "agent", id: A }]);
    expect(alertOwnerCandidates(`risk:${R}`, {})).toEqual([{ kind: "risk", id: R }]);
    expect(alertOwnerCandidates(`vendor:${V}`, {})).toEqual([{ kind: "vendor", id: V }]);
  });

  it("a pair-keyed subject: the use case's owner first, then the agent's steward (whatever the key order)", () => {
    expect(alertOwnerCandidates(`use_case:${U}>agent:${A}`, {})).toEqual([{ kind: "use_case", id: U }, { kind: "agent", id: A }]);
    expect(alertOwnerCandidates(`agent:${A}>use_case:${U}`, {})).toEqual([{ kind: "use_case", id: U }, { kind: "agent", id: A }]);
    expect(alertOwnerCandidates(`use_case:${U}>vendor:${V}`, {})).toEqual([{ kind: "use_case", id: U }, { kind: "vendor", id: V }]);
  });

  it("a KRI episode is its agent's when agent-scoped; a fleet or project KRI has no owner record", () => {
    expect(alertOwnerCandidates(`kri:${K}`, { scope: "agent", scopeId: A })).toEqual([{ kind: "agent", id: A }]);
    expect(alertOwnerCandidates(`kri:${K}`, { scope: "project", scopeId: A })).toEqual([]);
    expect(alertOwnerCandidates(`kri:${K}`, { scope: "fleet", scopeId: null })).toEqual([]);
  });

  it("subjects with no owner record, and ids that are not uuids, give nothing (an owner is never invented)", () => {
    expect(alertOwnerCandidates(`project:${U}`, {})).toEqual([]);
    expect(alertOwnerCandidates(`caller:${U}`, {})).toEqual([]);
    expect(alertOwnerCandidates("agent:not-a-uuid", {})).toEqual([]);
    expect(alertOwnerCandidates("", null)).toEqual([]);
  });
});

describe("PF-14 SLA: due time and state", () => {
  const t0 = new Date("2026-10-06T00:00:00Z");
  it("due = creation + the org's hours for the severity (strict defaults 24/72/168)", () => {
    expect(alertDueAt("high", t0, ALERT_SLA_DEFAULTS).toISOString()).toBe("2026-10-07T00:00:00.000Z");
    expect(alertDueAt("medium", t0, ALERT_SLA_DEFAULTS).toISOString()).toBe("2026-10-09T00:00:00.000Z");
    expect(alertDueAt("low", t0, ALERT_SLA_DEFAULTS).toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(alertDueAt("high", t0, { high: 48, medium: 72, low: 168 }).toISOString()).toBe("2026-10-08T00:00:00.000Z");
  });

  it("on track, due soon (last quarter), breached at the due time; acknowledging does not stop the clock", () => {
    const dueAt = alertDueAt("high", t0, ALERT_SLA_DEFAULTS);
    const at = (h: number) => new Date(t0.getTime() + h * 3_600_000);
    const a = { status: "open", firstDetectedAt: t0, dueAt, slaBreachedAt: null };
    expect(alertSlaState(a, at(1))).toBe("on_track");
    expect(alertSlaState(a, at(19))).toBe("due_soon");
    expect(alertSlaState(a, at(24))).toBe("breached");
    expect(alertSlaState({ ...a, status: "acknowledged" }, at(30))).toBe("breached");
    expect(alertSlaState({ ...a, status: "resolved", resolvedAt: at(10) }, at(30))).toBe("met");
    expect(alertSlaState({ ...a, slaBreachedAt: at(24) }, at(1))).toBe("breached");
    expect(alertSlaState({ ...a, dueAt: null }, at(100))).toBe("none");
  });
});

describe("PF-14 no personal data in chat or ticket titles", () => {
  it("the chat text names a person only as 'a user (id …)' and never carries the alert's title", () => {
    const text = alertSlaChatText({ kind: "breached", ruleLabel: "Key risk indicator past its threshold", severity: "high", dueAt: new Date("2026-10-07T00:00:00Z"), ownerUserId: U });
    expect(text).toContain(`a user (id ${U})`);
    expect(text).toContain("regulAIt");
    expect(text).toContain("escalated to the admins");
    expect(text).not.toMatch(/@/);
    const unowned = alertSlaChatText({ kind: "unowned", ruleLabel: "x", severity: "medium", dueAt: null, ownerUserId: null });
    expect(unowned).toMatch(/has no owner/);
  });

  it("a ticket about a person (caller subject) replaces the title with 'a user (id …)'", () => {
    const t = alertTicketText({
      alertId: K,
      ruleLabel: "AI traffic no approved use case covers",
      severity: "medium",
      title: "AI use by alice@example.com: 40 model calls",
      subjectKey: `caller:${U}`,
      dueAt: null,
      portalPath: "/admin/governance/alerts",
    });
    expect(`${t.title}\n${t.description}`).not.toContain("alice@example.com");
    expect(t.description).toContain(`a user (id ${U})`);
    expect(t.title).toBe("[regulAIt] medium governance alert: AI traffic no approved use case covers");
  });
});

describe("PF-03 the suggested halt (owner decision 4: suggest only)", () => {
  it("only an agent-scoped KRI may suggest a halt", () => {
    expect(kriOnBreachProblem("agent", "propose_halt")).toBeNull();
    expect(kriOnBreachProblem("project", "propose_halt")).toMatch(/only an agent-scoped KRI/);
    expect(kriOnBreachProblem("fleet", "propose_halt")).toMatch(/fleet-wide/);
    expect(kriOnBreachProblem("fleet", "alert")).toBeNull();
    expect(kriCreateSchema.parse({ name: "x", metric: "error_rate", threshold: 1 }).onBreach).toBe("alert");
    expect(kriUpdateSchema.parse({ onBreach: "propose_halt" })).toEqual({ onBreach: "propose_halt" });
    expect(kriUpdateSchema.safeParse({ onBreach: "halt_now" }).success).toBe(false);
  });

  const kri = (over: Partial<MonitorKriInput>): MonitorKriInput => ({
    id: K, name: "errors", metric: "error_rate", scope: "agent", scopeId: A, scopeLabel: "Claims assistant", windowDays: 1,
    comparator: "above", threshold: 5, minSamples: 1, severity: "high", enabled: true, value: 50, samples: 10, ...over,
  });

  const empty = { useCases: [], agents: new Map(), vendors: new Map(), risks: [], dimensions: [] };
  it("a breach of a propose_halt KRI carries the suggestion on the finding; an alert-only KRI carries none", () => {
    const [f] = evaluateMonitorRules({ ...empty, kris: [kri({ onBreach: "propose_halt" })] }).filter((x) => x.ruleId === "kri_threshold_breached");
    expect(f?.detail.suggestedAction).toEqual({ kind: "halt_agent", agentId: A });
    const [g] = evaluateMonitorRules({ ...empty, kris: [kri({ onBreach: "alert" })] }).filter((x) => x.ruleId === "kri_threshold_breached");
    expect(g?.detail.suggestedAction).toBeUndefined();
    expect(suggestedHaltFor({ scope: "project", scopeId: A, onBreach: "propose_halt" })).toBeNull();
  });

  it("the planner offers ONE executable halt_agent candidate only when the episode carries the suggestion", () => {
    expect(EXECUTABLE_REMEDIATION_KINDS).toContain("halt_agent");
    const base = { risks: new Map(), activeControls: new Map(), labels: new Map([[`agent:${A}`, "Claims assistant"]]) };
    const withSuggestion = proposeRemediations({
      ...base,
      alert: { ruleId: "kri_threshold_breached", subjectKey: `kri:${K}`, detail: { suggestedAction: { kind: "halt_agent", agentId: A } } },
    });
    expect(withSuggestion).toHaveLength(1);
    expect(withSuggestion[0]).toMatchObject({ kind: "halt_agent", executable: true, params: { agentId: A }, title: "Propose halting Claims assistant" });
    expect(withSuggestion[0]!.rationale).toMatch(/different person approves/);
    expect(proposeRemediations({ ...base, alert: { ruleId: "kri_threshold_breached", subjectKey: `kri:${K}`, detail: {} } })).toEqual([]);
  });
});
