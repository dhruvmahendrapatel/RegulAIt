/**
 * ADR-0182 A12 — the incident register's web model: the relaxed badge, the
 * serious derivation (mirrors the server), timestamps, and the timeline
 * sentences (which never invent free text).
 */
import { describe, expect, it } from "vitest";
import { EU_CRITERIA, eventSentence, impliesSerious, localInputToIso, settingRelaxed, utc } from "./incidentModel";

describe("incidentModel", () => {
  it("names a setting relaxed exactly when it is off its strict default", () => {
    expect(settingRelaxed("incidentGateMode", "enforce")).toBe(false);
    expect(settingRelaxed("incidentGateMode", "warn")).toBe(true);
    expect(settingRelaxed("incidentGateMode", "off")).toBe(true);
    expect(settingRelaxed("incidentEvidenceHold", true)).toBe(false);
    expect(settingRelaxed("incidentEvidenceHold", false)).toBe(true);
    expect(settingRelaxed("incidentClockRegimes", ["hipaa", "eu-ai-act"])).toBe(false);
    expect(settingRelaxed("incidentClockRegimes", ["eu-ai-act"])).toBe(true);
    expect(settingRelaxed("incidentClockRegimes", [])).toBe(true);
  });

  it("an Art. 3(49) criterion makes the incident serious; a PHI breach alone does not", () => {
    expect(EU_CRITERIA).not.toContain("phi_breach");
    expect(impliesSerious(["phi_breach"])).toBe(false);
    expect(impliesSerious(["phi_breach", "death"])).toBe(true);
    expect(impliesSerious([])).toBe(false);
  });

  it("shows instants in UTC to the minute and parses local inputs", () => {
    expect(utc("2026-10-06T09:30:12.000Z")).toBe("2026-10-06 09:30 UTC");
    expect(utc(null)).toBe("—");
    expect(localInputToIso("")).toBeUndefined();
    expect(localInputToIso("2026-10-06T09:30")).toMatch(/^2026-10-0[56]T\d\d:30:00\.000Z$/);
  });

  it("turns timeline events into sentences", () => {
    expect(eventSentence({ kind: "status", detail: { to: "open", severity: "high", serious: true } })).toBe("Opened (high, serious)");
    expect(eventSentence({ kind: "status", detail: { from: "open", to: "contained" } })).toBe("Status open → contained");
    expect(eventSentence({ kind: "notification", detail: { started: true, paragraph: "Regulation (EU) 2024/1689, Article 73(2)", dueAt: "2026-10-21T09:30:00Z" } })).toBe(
      "Clock started: Regulation (EU) 2024/1689, Article 73(2) — due 2026-10-21 09:30 UTC",
    );
    expect(eventSentence({ kind: "notification", detail: { clockId: "art73-2-general", flag: "overdue" } })).toBe("Clock art73-2-general is overdue");
    expect(eventSentence({ kind: "notification", detail: { clockId: "art73-2-general", from: "pending", to: "sent_initial" } })).toBe(
      "Clock art73-2-general: pending → sent initial",
    );
    expect(eventSentence({ kind: "containment", detail: { agentId: "a1", changed: false } })).toBe("Contained: agent a1 halted (it was already halted)");
    expect(eventSentence({ kind: "note", detail: { evidenceHoldOverride: true } })).toBe("Evidence hold overridden by an admin");
  });
});
