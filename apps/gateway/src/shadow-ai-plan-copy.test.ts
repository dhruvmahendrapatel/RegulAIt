/**
 * D3 (F7): the remediation plan's steps and note are printed on screen as they stand, so they carry product
 * language only. Pure, no database.
 */
import { describe, expect, it } from "vitest";
import { REMEDIATION_PLAN_NOTE, remediationPlanSteps } from "./shadow-ai-remediation.js";

const INTERNAL = [/ADR-\d/, /pillar \d/i, /§/, /audit_log|usage_events|replacementAgentId/, /catalogue row/, /\bONE\b/, /MECHANICALLY/, /compat surface/];

function allText(steps: ReturnType<typeof remediationPlanSteps>): string[] {
  return [...steps.flatMap((s) => [s.step, s.why, s.blocked ?? ""]), REMEDIATION_PLAN_NOTE];
}

describe("remediation plan copy", () => {
  it("names no decision record, pillar, table or column, with or without a replacement agent", () => {
    for (const agent of [null, { name: "Governed coder" }]) {
      for (const severity of ["critical", "high"]) {
        for (const text of allText(remediationPlanSteps({ subject: "acme/billing", severity }, agent))) {
          for (const re of INTERNAL) expect(text, text).not.toMatch(re);
        }
      }
    }
  });

  it("keeps the meaning: the routing step is blocked only without a replacement, and the loop closes on the ledgers", () => {
    const without = remediationPlanSteps({ subject: "acme/billing", severity: "high" }, null);
    expect(without.map((s) => s.step)).toEqual([
      "register the endpoint in the model catalogue",
      "route acme/billing through the gateway's provider-compatible endpoints",
      "grant the owner a per-user entitlement for that agent",
      "confirm the next call appears in the audit log and the usage ledger",
    ]);
    expect(without[1]?.blocked).toBe(
      "no governed replacement is registered for this provider. Set a governed replacement agent on the provider's Detection catalogue entry.",
    );
    const withAgent = remediationPlanSteps({ subject: "acme/billing", severity: "critical" }, { name: "Governed coder" });
    expect(withAgent[0]?.step).toBe("rotate the exposed credential");
    expect(withAgent[2]?.step).toContain("'Governed coder'");
    expect(withAgent.some((s) => s.blocked)).toBe(false);
    expect(REMEDIATION_PLAN_NOTE).toMatch(/does not start a workflow by itself/);
  });
});
