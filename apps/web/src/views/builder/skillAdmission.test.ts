/** ADR-0175 A6/A5 — the skill status copy the library and the agent editor show. */
import { describe, expect, it } from "vitest";
import { findingLines, skillPrivateOnSharedAgentCopy, skillStatusBadge, skillWithheldCopy } from "./builderLogic";

describe("skillStatusBadge", () => {
  const base = { admissionState: "clean", requestedVisibility: null, release: null };
  it("says nothing for a clean, shared-as-asked skill", () => {
    expect(skillStatusBadge(base)).toBeNull();
  });
  it("names a blocked, held, waiting or pending skill — blocked first", () => {
    expect(skillStatusBadge({ ...base, admissionState: "refused", requestedVisibility: "workspace" })).toEqual({ label: "Blocked by scan", tone: "danger" });
    expect(skillStatusBadge({ ...base, admissionState: "held" })).toEqual({ label: "Held for review", tone: "warn" });
    expect(skillStatusBadge({ ...base, release: { quarantined: true, readyAt: "2026-10-11T00:00:00.000Z" } })).toEqual({ label: "Waiting until Oct 11", tone: "info" });
    expect(skillStatusBadge({ ...base, requestedVisibility: "workspace" })).toEqual({ label: "Sharing pending approval", tone: "info" });
  });
});

describe("skillWithheldCopy", () => {
  it("has a badge and a reason for each withheld state, and calls the detectors detectors", () => {
    for (const why of ["held", "refused", "quarantined"] as const) {
      const c = skillWithheldCopy(why);
      expect(c.badge.length).toBeGreaterThan(0);
      expect(c.sub).toMatch(/skips it/);
    }
    expect(skillWithheldCopy("held").sub).toContain("admission detectors");
  });
});

describe("findingLines", () => {
  it("renders counts and locations only", () => {
    expect(findingLines([{ rule: "skill.confusable.mixed_script", severity: "medium", where: "body", count: 2 }])).toEqual([
      "skill.confusable.mixed_script in body (medium, ×2)",
    ]);
  });
});

describe("skillPrivateOnSharedAgentCopy (ADR-0175 review fix)", () => {
  it("says the shared agent runs without the private skill, and how to include it", () => {
    const open = skillPrivateOnSharedAgentCopy(false);
    expect(open.badge).toBe("Only its owner");
    expect(open.sub).toMatch(/run it without the skill/);
    expect(open.sub).toMatch(/an admin approves/);
    expect(skillPrivateOnSharedAgentCopy(true).sub).toMatch(/\(requested\)/);
  });
});
