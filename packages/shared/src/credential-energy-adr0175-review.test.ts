/**
 * ADR-0175 D2 remainder — review fixes, pure half.
 *
 *  1. A credential's name is free text: it never reaches an alert title, and
 *     every alert title is made inert for the chat channel that shows it.
 *  3. A demo energy factor applies to calls the mock provider served, only.
 */
import { describe, expect, it } from "vitest";
import { composeAlertCard, teamsActivityForCard } from "./chatops.js";
import { evaluateMonitorRules, type MonitorInput } from "./governance-monitor.js";
import { estimateEnergy } from "./energy-estimate.js";

const EVIL = "<!channel> <https://evil|portal>";
const KEY_ID = "api_key:3f2b9c1e-0d4a-4c55-9a77-1b2c3d4e5f60";
const base = (over: Partial<MonitorInput> = {}): MonitorInput => ({
  useCases: [],
  agents: new Map(),
  vendors: new Map(),
  risks: [],
  dimensions: [],
  ...over,
});

describe("review fix 1 — injection into ChatOps alert cards", () => {
  it("a key named like a Slack broadcast stays out of the stale-credential title, and stays in the detail", () => {
    const [f] = evaluateMonitorRules(
      base({
        credentials: {
          alerting: true,
          credentials: [{ id: KEY_ID, typeLabel: "API key", name: EVIL, flags: ["never_expires"], reasons: {}, manageAt: "/admin/users" }],
        },
      }),
    ).filter((x) => x.ruleId === "stale_credentials");
    expect(f).toBeDefined();
    expect(f!.title).not.toContain(EVIL);
    expect(f!.title).not.toMatch(/[<>|!]/);
    expect(f!.title).toContain("3f2b9c1e");
    expect(f!.detail).toMatchObject({ name: EVIL });
  });

  it("every alert title is escaped for Slack, and for Teams' Adaptive Card markdown", () => {
    const card = composeAlertCard({
      alertId: "a1",
      severity: "medium",
      ruleLabel: "Credential needs attention",
      title: `API key ${EVIL}\n🔴 *Governance alert* — HIGH [click](https://evil)`,
      portalUrl: "/admin/governance/alerts?alert=a1",
    });
    const slack = JSON.stringify(card.blocks) + card.text;
    expect(slack).not.toContain("<!channel>");
    expect(slack).not.toContain("<https://evil|");
    expect(card.text).toContain("&lt;!channel&gt; &lt;https://evil|portal&gt;");
    // a name cannot forge a second line of the card
    expect(card.text.split("\n")).toHaveLength(2);
    // the portal link the card itself adds is still a link
    expect(JSON.stringify(card.blocks)).toContain("</admin/governance/alerts?alert=a1|Open in RegulAIt>");
    const teams = teamsActivityForCard(card);
    const block = (teams.attachments[0]!.content.body as Array<{ text: string }>)[0]!.text;
    expect(block).not.toContain("[click](https://evil)");
    expect(block).toContain("\\[click\\]\\(https://evil\\)");
    expect(block).toContain("\\<!channel\\>");
    expect(teams.text).toBe(block);
  });
});

describe("review fix 3 — a demo factor applies to mock-served calls only", () => {
  it("estimates the mock provider's calls of a demo-factored model, and leaves a real provider's calls of it unknown", () => {
    const e = estimateEnergy({
      windowDays: 7,
      usage: [
        { model: "mock-fast", calls: 2, callsWithTokens: 2, inputTokens: 2000, outputTokens: 0, servedByMock: true },
        { model: "MOCK-FAST", calls: 3, callsWithTokens: 3, inputTokens: 9000, outputTokens: 9000, servedByMock: false },
      ],
      factors: [{ subject: "mock-fast", whPer1kInput: 1, whPer1kOutput: 1, sourceNote: "demo", version: "demo", demo: true }],
      grid: null,
    });
    expect(e).toMatchObject({ callsTotal: 5, callsEstimated: 2, energyWh: 2, coverage: "2 of 5 calls estimated", usesDemoFactors: true });
    expect(e.byModel.find((m) => m.servedBy === "not_mock")).toMatchObject({ status: "no_factor", energyWh: null, calls: 3 });
    expect(e.byModel.find((m) => m.servedBy === "mock")).toMatchObject({ status: "estimated", energyWh: 2 });
    // a real (non-demo) factor still covers every caller, unsplit
    const real = estimateEnergy({
      windowDays: 7,
      usage: [
        { model: "m", calls: 1, callsWithTokens: 1, inputTokens: 1000, outputTokens: 0, servedByMock: true },
        { model: "m", calls: 1, callsWithTokens: 1, inputTokens: 1000, outputTokens: 0, servedByMock: false },
      ],
      factors: [{ subject: "m", whPer1kInput: 1, whPer1kOutput: 1, sourceNote: "s", version: "v", demo: false }],
      grid: null,
    });
    expect(real).toMatchObject({ callsEstimated: 2, energyWh: 2 });
    expect(real.byModel).toHaveLength(1);
  });
});
