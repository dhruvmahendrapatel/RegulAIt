/**
 * ADR-0175 D2 remainder — review fixes, pure half.
 *
 *  1. A credential's name is free text: it never reaches an alert title, and
 *     every alert title is made inert for the chat channel that shows it.
 */
import { describe, expect, it } from "vitest";
import { composeAlertCard, teamsActivityForCard } from "./chatops.js";
import { evaluateMonitorRules, type MonitorInput } from "./governance-monitor.js";

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
