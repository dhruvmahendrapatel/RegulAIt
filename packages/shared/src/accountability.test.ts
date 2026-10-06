/**
 * ADR-0182 (D4) P0 — the accountability contract's pure rules: the strict
 * defaults, what counts as a relaxation, the setting bounds, the suggested
 * halt (PF-03: a suggestion, never an action) and the monitor's accountability
 * input.
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNTABILITY_SETTING_COPY,
  ACCOUNTABILITY_SETTING_KEYS,
  ACCOUNTABILITY_STRICT_DEFAULTS,
  ALERT_SLA_DEFAULTS,
  accountabilityDigest,
  accountabilitySettingRelaxed,
  closeIncidentSchema,
  createAiPolicySchema,
  createIncidentSchema,
  incidentNotificationReasonSchema,
  publishAiPolicySchema,
  setEuAiActRoleSchema,
  submitFeedbackSchema,
  type AccountabilitySettingKey,
} from "./accountability.js";
import {
  ACCOUNTABILITY_MONITOR_RULE_IDS,
  MONITOR_RULES,
  evaluateMonitorRules,
  suggestedHaltFor,
  type MonitorInput,
  type MonitorKriInput,
} from "./governance-monitor.js";
import { updateOrgSettingsSchema } from "./index.js";

describe("ADR-0182: the strict defaults", () => {
  it("are exactly the owner's strict values", () => {
    expect(ACCOUNTABILITY_STRICT_DEFAULTS).toEqual({
      decisionRegressionGate: "enforce",
      decisionRegressionMaxAgeMinutes: 60,
      incidentGateMode: "enforce",
      incidentEvidenceHold: true,
      incidentClockRegimes: ["eu-ai-act", "hipaa"],
      feedbackSignedLinksEnabled: false,
      feedbackAckSlaHours: 72,
      feedbackResolveSlaDays: 30,
      feedbackRetentionDays: 365,
      literacyGateMode: "enforce",
      literacyDefaultValidityDays: 365,
      alertSlaHours: { high: 24, medium: 72, low: 168 },
      alertTicketMode: "manual",
    });
    expect(ALERT_SLA_DEFAULTS).toEqual({ high: 24, medium: 72, low: 168 });
  });

  it("each is accepted by the settings write and is not a relaxation", () => {
    expect(updateOrgSettingsSchema.parse({ ...ACCOUNTABILITY_STRICT_DEFAULTS })).toMatchObject(ACCOUNTABILITY_STRICT_DEFAULTS);
    for (const k of ACCOUNTABILITY_SETTING_KEYS) {
      expect(accountabilitySettingRelaxed(k, ACCOUNTABILITY_STRICT_DEFAULTS[k] as never), k).toBe(false);
    }
  });

  it("every setting has its strict and relaxed copy, and the copy claims nothing", () => {
    for (const k of ACCOUNTABILITY_SETTING_KEYS) {
      const c = ACCOUNTABILITY_SETTING_COPY[k];
      expect(c.label.length, k).toBeGreaterThan(0);
      expect(c.strict.length, k).toBeGreaterThan(20);
      expect(c.relaxed.length, k).toBeGreaterThan(20);
      expect(`${c.strict} ${c.relaxed}`.toLowerCase(), k).not.toMatch(/\bcompliant\b|guarantee/);
    }
  });
});

describe("ADR-0182: what counts as a relaxation", () => {
  const relaxed: Array<[AccountabilitySettingKey, unknown]> = [
    ["decisionRegressionGate", "warn"],
    ["decisionRegressionGate", "off"],
    ["decisionRegressionMaxAgeMinutes", 61],
    ["incidentGateMode", "off"],
    ["incidentEvidenceHold", false],
    ["incidentClockRegimes", ["hipaa"]],
    ["incidentClockRegimes", []],
    ["feedbackSignedLinksEnabled", true],
    ["feedbackAckSlaHours", 73],
    ["feedbackResolveSlaDays", 31],
    ["feedbackRetentionDays", 366],
    ["literacyGateMode", "warn"],
    ["literacyDefaultValidityDays", 366],
    ["alertSlaHours", { high: 25, medium: 72, low: 168 }],
    ["alertTicketMode", "auto_high"],
  ];
  it.each(relaxed)("%s = %j is a relaxation", (k, v) => {
    expect(accountabilitySettingRelaxed(k, v as never)).toBe(true);
  });

  const stricter: Array<[AccountabilitySettingKey, unknown]> = [
    ["decisionRegressionMaxAgeMinutes", 30],
    ["feedbackAckSlaHours", 24],
    ["feedbackResolveSlaDays", 14],
    ["feedbackRetentionDays", 90],
    ["literacyDefaultValidityDays", 180],
    ["alertSlaHours", { high: 4, medium: 24, low: 72 }],
    ["incidentClockRegimes", ["hipaa", "eu-ai-act"]],
  ];
  it.each(stricter)("%s = %j is not a relaxation", (k, v) => {
    expect(accountabilitySettingRelaxed(k, v as never)).toBe(false);
  });

  it("the settings write refuses values outside the bounds", () => {
    for (const bad of [
      { feedbackRetentionDays: 29 },
      { feedbackRetentionDays: 2556 },
      { feedbackAckSlaHours: 169 },
      { feedbackResolveSlaDays: 91 },
      { literacyDefaultValidityDays: 731 },
      { decisionRegressionMaxAgeMinutes: 0 },
      { alertSlaHours: { high: 721, medium: 72, low: 168 } },
      { alertSlaHours: { high: 24, medium: 72, low: 168, critical: 1 } },
      { incidentClockRegimes: ["hipaa", "hipaa"] },
      { alertTicketMode: "auto_all" },
    ]) {
      expect(updateOrgSettingsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("ADR-0182: request bodies", () => {
  it("an incident needs a title, a severity and a detection source; closing needs both texts", () => {
    expect(createIncidentSchema.safeParse({ title: "t", severity: "high", detectionSource: "manual" }).success).toBe(true);
    expect(createIncidentSchema.safeParse({ title: "t", severity: "catastrophic", detectionSource: "manual" }).success).toBe(false);
    expect(closeIncidentSchema.safeParse({ rootCause: "x", lessonsLearned: " " }).success).toBe(false);
    expect(incidentNotificationReasonSchema.safeParse({ reason: "short" }).success).toBe(false);
  });

  it("narrowing the EU AI Act role takes a reason of substance; feedback is bounded; a span cites its trace", () => {
    expect(setEuAiActRoleSchema.safeParse({ role: "deployer", reason: "too short" }).success).toBe(false);
    expect(setEuAiActRoleSchema.safeParse({ role: "importer" }).success).toBe(false);
    expect(submitFeedbackSchema.safeParse({ kind: "appeal", body: "x".repeat(4001) }).success).toBe(false);
    expect(
      submitFeedbackSchema.safeParse({ kind: "problem", body: "b", spanId: "00000000-0000-4000-8000-000000000001" }).success,
    ).toBe(false);
  });

  it("a document is a link or an attachment; an editorial version states why", () => {
    expect(createAiPolicySchema.safeParse({ key: "aup", kind: "acceptable_use", title: "AUP" }).success).toBe(false);
    const ok = createAiPolicySchema.parse({ key: "aup", kind: "acceptable_use", title: "AUP", url: "https://intranet.example/aup" });
    expect(ok.audience).toEqual({ all: true, teamIds: [], roleIds: [] });
    expect(publishAiPolicySchema.safeParse({ editorial: true }).success).toBe(false);
  });

  it("the digest does not depend on key order", () => {
    expect(accountabilityDigest({ b: 1, a: [1, { d: 2, c: "x" }] })).toBe(accountabilityDigest({ a: [1, { c: "x", d: 2 }], b: 1 }));
    expect(accountabilityDigest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("ADR-0182 monitor: the accountability input and the suggested halt", () => {
  const base = (over: Partial<MonitorInput> = {}): MonitorInput => ({
    useCases: [],
    agents: new Map(),
    vendors: new Map(),
    risks: [],
    dimensions: [],
    ...over,
  });
  const kri = (over: Partial<MonitorKriInput>): MonitorKriInput => ({
    id: "k1",
    name: "Agent errors",
    metric: "error_rate",
    scope: "agent",
    scopeId: "agent-1",
    scopeLabel: "agent one",
    windowDays: 7,
    comparator: "above",
    threshold: 0.05,
    minSamples: 10,
    severity: "high",
    enabled: true,
    value: 0.5,
    samples: 100,
    ...over,
  });

  it("a slice's reported breach becomes a finding at the rule's severity", () => {
    const f = evaluateMonitorRules(
      base({
        accountability: {
          feedback_sla_breached: { breaches: [{ subjectKey: "feedback:f1", title: "a report is past due", detail: {} }] },
          literacy_coverage_gap: { breaches: [] },
        },
      }),
    );
    expect(f).toEqual([
      { ruleId: "feedback_sla_breached", subjectKey: "feedback:f1", severity: "medium", title: "a report is past due", detail: {} },
    ]);
    for (const id of ACCOUNTABILITY_MONITOR_RULE_IDS) expect(MONITOR_RULES[id]).toBeDefined();
  });

  it("only an agent-scoped propose_halt KRI suggests a halt, and the episode carries it as a suggestion", () => {
    expect(suggestedHaltFor(kri({ onBreach: "propose_halt" }))).toEqual({ kind: "halt_agent", agentId: "agent-1" });
    expect(suggestedHaltFor(kri({ onBreach: "alert" }))).toBeNull();
    expect(suggestedHaltFor(kri({}))).toBeNull();
    expect(suggestedHaltFor(kri({ onBreach: "propose_halt", scope: "fleet", scopeId: null }))).toBeNull();

    const [withHalt] = evaluateMonitorRules(base({ kris: [kri({ onBreach: "propose_halt" })] }));
    expect(withHalt!.detail.suggestedAction).toEqual({ kind: "halt_agent", agentId: "agent-1" });
    const [plain] = evaluateMonitorRules(base({ kris: [kri({ onBreach: "alert" })] }));
    expect(plain!.detail).not.toHaveProperty("suggestedAction");
  });
});
