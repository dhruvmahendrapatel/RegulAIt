import { describe, expect, it } from "vitest";
import type { BuilderIntegrationsResponse } from "../../api/types";
import {
  AGENT_COLORS,
  agentInitials,
  bundleFileName,
  codeSnippets,
  countIntegrations,
  filterIntegrations,
  filterThreads,
  isValidTimeUtc,
  localTime,
  parseBundleText,
  parseLimitInput,
  parseSkillFrontmatter,
  safeAgentColor,
  scheduleSummary,
  shapeDaily,
  shortDate,
  spendState,
  withShare,
} from "./builderLogic";

describe("bundle import", () => {
  const good = { version: 1, agent: { name: "Intake reviewer", instructions: "x" }, skills: [{ name: "a" }] };

  it("accepts an exported bundle, bare or wrapped in the export response", () => {
    const bare = parseBundleText(JSON.stringify(good));
    expect(bare).toEqual({ ok: true, bundle: good });
    const wrapped = parseBundleText(JSON.stringify({ bundle: good }));
    expect(wrapped).toEqual({ ok: true, bundle: good });
  });

  it("defaults a missing skills list to empty", () => {
    const r = parseBundleText(JSON.stringify({ version: 1, agent: { name: "A" } }));
    expect(r.ok && r.bundle.skills).toEqual([]);
  });

  it("refuses non-JSON, other versions, a missing agent, a nameless agent and non-list skills, each with its own reason", () => {
    const reasons = [
      parseBundleText("not json"),
      parseBundleText("[1,2]"),
      parseBundleText(JSON.stringify({ ...good, version: 2 })),
      parseBundleText(JSON.stringify({ version: 1 })),
      parseBundleText(JSON.stringify({ version: 1, agent: { name: "  " } })),
      parseBundleText(JSON.stringify({ ...good, skills: {} })),
    ].map((r) => (r.ok ? "accepted" : r.error));
    expect(reasons).not.toContain("accepted");
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(reasons[0]).toMatch(/valid JSON/);
    expect(reasons[2]).toMatch(/unsupported version/);
  });

  it("names the download after the agent", () => {
    expect(bundleFileName("Vendor AI risk assessor!")).toBe("vendor-ai-risk-assessor.agent.json");
    expect(bundleFileName("***")).toBe("agent.agent.json");
  });
});

describe("skill frontmatter", () => {
  it("reads name and description, unquoting values", () => {
    expect(parseSkillFrontmatter('---\nname: "Draft a finding"\ndescription: Use when an audit gap is found\n---\n# Body')).toEqual({
      name: "Draft a finding",
      description: "Use when an audit gap is found",
    });
  });
  it("is null without frontmatter or without a name", () => {
    expect(parseSkillFrontmatter("# Just a heading")).toBeNull();
    expect(parseSkillFrontmatter("---\ndescription: x\n---\n")).toBeNull();
  });
});

describe("schedule display", () => {
  it("validates HH:MM in 24-hour time", () => {
    expect(isValidTimeUtc("09:00")).toBe(true);
    expect(isValidTimeUtc("23:59")).toBe(true);
    expect(isValidTimeUtc("24:00")).toBe(false);
    expect(isValidTimeUtc("9:00")).toBe(false);
  });
  it("words every cadence plainly", () => {
    expect(scheduleSummary("hourly", "09:00")).toBe("Every hour, on the hour");
    expect(scheduleSummary("hourly", "09:15")).toBe("Every hour at :15");
    expect(scheduleSummary("daily", "07:30")).toBe("Every day at 07:30 UTC");
    expect(scheduleSummary("weekdays", "09:00")).toBe("Weekdays at 09:00 UTC");
    expect(scheduleSummary("weekly", "16:00")).toBe("Once a week at 16:00 UTC");
  });
  it("converts a UTC time to the reader's zone", () => {
    expect(localTime("09:00", "UTC")).toBe("9:00 AM");
    expect(localTime("09:00", "Asia/Kolkata")).toBe("2:30 PM");
    expect(localTime("bad", "UTC")).toBeNull();
  });
});

describe("spend against a limit", () => {
  it("is none without a limit, warns from 80% and is over at the limit", () => {
    expect(spendState(50, null)).toBe("none");
    expect(spendState(79, 100)).toBe("ok");
    expect(spendState(80, 100)).toBe("warn");
    expect(spendState(100, 100)).toBe("over");
  });
  it("parses the limit input: empty is no limit, bounds are enforced, cents rounded", () => {
    expect(parseLimitInput("")).toEqual({ ok: true, value: null });
    expect(parseLimitInput("$25.555")).toEqual({ ok: true, value: 25.56 });
    expect(parseLimitInput("0").ok).toBe(false);
    expect(parseLimitInput("100001").ok).toBe(false);
    expect(parseLimitInput("ten").ok).toBe(false);
  });
});

describe("integrations filtering", () => {
  const groups: BuilderIntegrationsResponse["groups"] = [
    {
      name: "Atlassian",
      items: [
        { key: "jira", name: "Jira", description: "Issues and projects", category: "productivity", status: "connected", connectHref: "/admin/connectors", kind: "connector" },
        { key: "confluence", name: "Confluence", description: "Team pages", category: "productivity", status: "available", connectHref: "/admin/connectors", kind: "connector" },
      ],
    },
    {
      name: "Chat",
      items: [{ key: "slack", name: "Slack", description: "Messages", category: "communication", status: "available", connectHref: "/admin/chatops", kind: "chatops" }],
    },
  ];
  const none = { query: "", connectedOnly: false, category: null };

  it("keeps everything with no filter, and counts connected", () => {
    expect(filterIntegrations(groups, none)).toEqual(groups);
    expect(countIntegrations(groups)).toEqual({ total: 3, connected: 1 });
  });
  it("drops groups left empty by Connected only", () => {
    const r = filterIntegrations(groups, { ...none, connectedOnly: true });
    expect(r.map((g) => g.name)).toEqual(["Atlassian"]);
    expect(r[0]!.items.map((i) => i.key)).toEqual(["jira"]);
  });
  it("filters by category and by search over name, description and vendor", () => {
    expect(filterIntegrations(groups, { ...none, category: "communication" }).flatMap((g) => g.items.map((i) => i.key))).toEqual(["slack"]);
    expect(filterIntegrations(groups, { ...none, query: "team pages" }).flatMap((g) => g.items.map((i) => i.key))).toEqual(["confluence"]);
    expect(filterIntegrations(groups, { ...none, query: "atlassian" }).flatMap((g) => g.items.map((i) => i.key))).toEqual(["jira", "confluence"]);
  });
});

describe("usage shaping", () => {
  const today = new Date("2026-10-04T15:00:00Z");
  it("returns exactly N consecutive days ending today, zero-filling gaps and summing duplicates", () => {
    const out = shapeDaily(
      [
        { date: "2026-10-02", spendUsd: 1.5, messages: 3 },
        { date: "2026-10-04T00:00:00Z", spendUsd: 2, messages: 1 },
        { date: "2026-10-04", spendUsd: 0.5, messages: 1 },
        { date: "2026-09-01", spendUsd: 99, messages: 99 },
      ],
      7,
      today,
    );
    expect(out.map((d) => d.date)).toEqual(["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(out[4]).toEqual({ date: "2026-10-02", spendUsd: 1.5, messages: 3 });
    expect(out[5]).toEqual({ date: "2026-10-03", spendUsd: 0, messages: 0 });
    expect(out[6]).toEqual({ date: "2026-10-04", spendUsd: 2.5, messages: 2 });
  });
  it("labels days in UTC", () => {
    expect(shortDate("2026-10-04")).toBe("Oct 4");
  });
  it("sorts by spend with each row's share", () => {
    const r = withShare([
      { id: "a", spendUsd: 1 },
      { id: "b", spendUsd: 3 },
    ]);
    expect(r.map((x) => [x.id, x.share])).toEqual([
      ["b", 0.75],
      ["a", 0.25],
    ]);
    expect(withShare([{ id: "z", spendUsd: 0 }])[0]!.share).toBe(0);
  });
});

describe("identity and threads", () => {
  it("makes initials from one or two words", () => {
    expect(agentInitials("Policy Q&A assistant")).toBe("PQ");
    expect(agentInitials("triage")).toBe("TR");
    expect(agentInitials("  ")).toBe("?");
  });
  it("keeps a palette colour and replaces anything else with a stable palette colour", () => {
    expect(safeAgentColor("#7C3AED", "x")).toBe("#7c3aed");
    const fallback = safeAgentColor("#ffff00", "Agent");
    expect(AGENT_COLORS).toContain(fallback);
    expect(safeAgentColor(null, "Agent")).toBe(fallback);
  });
  it("searches threads by title, agent and preview", () => {
    const base = { agentId: "a", agentColor: "#2563eb", status: "active" as const, source: "chat" as const, updatedAt: "" };
    const ts = [
      { ...base, id: "1", title: "Q3 vendor review", agentName: "Risk assessor", lastMessagePreview: "Two vendors flagged" },
      { ...base, id: "2", title: "Morning sweep", agentName: "Intake reviewer", lastMessagePreview: null },
    ];
    expect(filterThreads(ts, "").length).toBe(2);
    expect(filterThreads(ts, "INTAKE").map((t) => t.id)).toEqual(["2"]);
    expect(filterThreads(ts, "flagged").map((t) => t.id)).toEqual(["1"]);
  });
});

describe("use in code", () => {
  it("targets the agent's chat route and never embeds a key", () => {
    const sn = codeSnippets("abc-123", "https://gw.example.test");
    for (const code of Object.values(sn)) {
      expect(code).toContain("https://gw.example.test/v1/builder/agents/abc-123/chat");
      expect(code).toContain("REGULAIT_API_KEY");
      expect(code).not.toMatch(/sk-|rg_live/);
    }
  });
});
