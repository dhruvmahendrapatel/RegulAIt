import { describe, expect, it } from "vitest";
import {
  agentSetupAssistRequestSchema,
  mergeAgentSetupReply,
  parseAgentSetupReply,
  suggestAgentSetup,
} from "./agent-setup-assist.js";

describe("ADR-0205 agent setup draft (rules)", () => {
  it("rates sensitive work high, with the strictest approval rule and no grants", () => {
    const d = suggestAgentSetup({ description: "Answers patient questions about their medical bills." });
    expect(d.riskTier.value).toBe("high");
    expect(d.riskTier.source).toBe("rules");
    expect(d.approvalRule.value).toMatch(/every tool call/i);
    expect(d.grants.value).toMatch(/no one/i);
    expect(d.tier.value).toBe(2);
    expect(d.name.value).toMatch(/^[a-z0-9][a-z0-9-]*-agent$/);
  });

  it("rates a quiet internal summariser minimal (negative control)", () => {
    const d = suggestAgentSetup({ description: "Summarises internal engineering notes into a short digest." });
    expect(d.riskTier.value).toBe("minimal");
  });

  it("rates an agent that acts limited", () => {
    expect(suggestAgentSetup({ description: "Creates tickets from team chat threads." }).riskTier.value).toBe("limited");
  });

  it("refuses unknown request keys", () => {
    expect(agentSetupAssistRequestSchema.safeParse({ description: "long enough text", apply: true }).success).toBe(false);
  });
});

describe("ADR-0205 model reply", () => {
  it("parses fenced JSON and rejects prose", () => {
    expect(parseAgentSetupReply('```json\n{"purpose":"x"}\n```')).toEqual({ purpose: "x" });
    expect(parseAgentSetupReply("Sure, here is a helpful answer.")).toBeNull();
    expect(parseAgentSetupReply('{"name":"Bad Name!"}')).toBeNull();
  });

  it("rejects a pathological reply in linear time (CodeQL: no regex over model output)", () => {
    const t0 = Date.now();
    expect(parseAgentSetupReply("```" + " ".repeat(200_000))).toBeNull();
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it("may raise the risk tier but never lower it", () => {
    const high = suggestAgentSetup({ description: "Reviews loan applications from customers." });
    const lowered = mergeAgentSetupReply(high, { riskTier: "minimal", purpose: "p" }, "model");
    expect(lowered.draft.riskTier.value).toBe("high");
    expect(lowered.draft.purpose).toEqual({ value: "p", source: "model" });
    expect(lowered.fields).not.toContain("riskTier");

    const low = suggestAgentSetup({ description: "Summarises internal engineering notes." });
    const raised = mergeAgentSetupReply(low, { riskTier: "high" }, "mock");
    expect(raised.draft.riskTier.value).toBe("high");
    expect(raised.draft.approvalRule.value).toMatch(/every tool call/i);
  });
});
