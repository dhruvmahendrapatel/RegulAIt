/**
 * ADR-0354 — the graduated response vocabulary: the declared table, the resolver's "never changes what is enforced"
 * invariant, Cedar precedence, and parity with the Go endpoint agent's mirror (one golden file, read by both).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_RESPONSES,
  AGENT_RESPONSE_TABLE,
  POLICY_RESPONSES,
  agentResponseBody,
  compareResponseStrictness,
  isResponseRelaxation,
  resolveAgentResponse,
  responseOfEffect,
  responseOfPolicyMode,
  type AgentResponseKind,
} from "./agent-response.js";
import { ABAC_CURRENT_SCHEMA_VERSION, abacEngine, type AbacPolicy, type AbacRequest } from "./abac.js";

const GOLDEN = fileURLToPath(
  new URL("../../../agents/endpoint/internal/enforce/testdata/responses/v1.json", import.meta.url),
);

describe("ADR-0354 the declared response table", () => {
  it("is the golden contract the Go endpoint agent also reads (one vocabulary, two languages)", () => {
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    expect(golden.schema).toBe("regulait.agent-responses/1");
    expect(golden.order).toEqual([...AGENT_RESPONSES]);
    expect(golden.policyModes).toEqual([...POLICY_RESPONSES]);
    expect(golden.responses).toEqual(AGENT_RESPONSES.map((k) => ({ ...AGENT_RESPONSE_TABLE[k] })));
  });

  it("maps every response onto exactly the effect the requirement names", () => {
    expect(AGENT_RESPONSE_TABLE.advise.effect).toBe("allow");
    expect(AGENT_RESPONSE_TABLE.correct.effect).toBe("deny");
    expect(AGENT_RESPONSE_TABLE.block_session.effect).toBe("deny");
    expect(AGENT_RESPONSE_TABLE.disable.effect).toBe("deny");
    expect(AGENT_RESPONSE_TABLE.ask.effect).toBe("require_approval");
    expect(AGENT_RESPONSE_TABLE.block_session.session).toBe("ends");
    expect(AGENT_RESPONSE_TABLE.disable.agent).toBe("quarantine");
    // only correct carries an alternative; only advise and correct carry guidance
    for (const k of AGENT_RESPONSES) {
      const s = AGENT_RESPONSE_TABLE[k];
      expect(s.kind).toBe(k);
      expect(s.alternative === "required").toBe(k === "correct");
      expect(s.guidance === "required").toBe(k === "advise" || k === "correct");
      expect(s.auditRuleId).toMatch(/^response-[a-z-]+$/);
    }
  });

  it("ranks so that ABAC still cannot grant: every policy mode restricts at least as much as allow", () => {
    for (const m of POLICY_RESPONSES) expect(AGENT_RESPONSE_TABLE[responseOfPolicyMode(m)].rank).toBeGreaterThanOrEqual(0);
    expect(POLICY_RESPONSES).not.toContain("allow" as never);
  });

  it("treats block → advise as a relaxation and advise → block as not", () => {
    expect(isResponseRelaxation("deny", "advise")).toBe(true);
    expect(isResponseRelaxation("disable", "block_session")).toBe(true);
    expect(isResponseRelaxation("advise", "deny")).toBe(false);
    // deny ↔ correct changes no enforcement
    expect(isResponseRelaxation("deny", "correct")).toBe(false);
    expect(isResponseRelaxation("correct", "deny")).toBe(false);
  });

  it("orders strictest first, with a plain deny above correct", () => {
    const sorted = [...AGENT_RESPONSES].sort(compareResponseStrictness);
    expect(sorted).toEqual(["disable", "block_session", "deny", "correct", "ask", "advise", "allow"]);
  });
});

describe("ADR-0354 resolveAgentResponse never changes what is enforced", () => {
  const g = { message: "Use the internal share.", alternative: "Upload to the team share instead." };

  it("decorates the decision its own policy made", () => {
    const r = resolveAgentResponse({ effect: "deny", ruleId: "p1" }, { policyId: "p1", mode: "correct", guidance: g });
    expect(r).toMatchObject({ kind: "correct", effect: "deny", guidance: g, endSession: false });
    expect(agentResponseBody(r)).toEqual({ response: "correct", message: g.message, alternative: g.alternative });
  });

  it("advise annotates an allow and nothing else", () => {
    const allow = resolveAgentResponse({ effect: "allow", ruleId: "grant-1" }, { policyId: "p1", mode: "advise", guidance: { message: "m" } });
    expect(allow.kind).toBe("advise");
    expect(allow.guidance).toEqual({ message: "m" });
    // advise never rescues a refusal made by another rule
    const denied = resolveAgentResponse({ effect: "deny", ruleId: "rate-limit-1" }, { policyId: "p1", mode: "advise", guidance: { message: "m" } });
    expect(denied).toEqual(responseOfEffect("deny"));
  });

  it("a correct written for one rule never decorates another rule's refusal", () => {
    const r = resolveAgentResponse({ effect: "deny", ruleId: "default-deny" }, { policyId: "p1", mode: "correct", guidance: g });
    expect(r.kind).toBe("deny");
    expect(r.guidance).toBeNull();
  });

  it("missing guidance degrades to the plain response of the same effect", () => {
    expect(resolveAgentResponse({ effect: "deny", ruleId: "p1" }, { policyId: "p1", mode: "correct", guidance: { message: "m" } }).kind).toBe("deny");
    expect(resolveAgentResponse({ effect: "allow", ruleId: "g" }, { policyId: "p1", mode: "advise", guidance: null }).kind).toBe("allow");
  });

  it("block_session and disable carry their side effects and no guidance", () => {
    const b = resolveAgentResponse({ effect: "deny", ruleId: "p1" }, { policyId: "p1", mode: "block_session", guidance: g });
    expect(b).toMatchObject({ kind: "block_session", endSession: true, quarantineAgent: false, guidance: null });
    expect(agentResponseBody(b)).toEqual({ response: "block_session", sessionEnded: true });
    const d = resolveAgentResponse({ effect: "deny", ruleId: "p1" }, { policyId: "p1", mode: "disable" });
    expect(d).toMatchObject({ kind: "disable", endSession: true, quarantineAgent: true });
  });

  it("an unknown mode is the plain effect (error is never wider)", () => {
    expect(resolveAgentResponse({ effect: "deny", ruleId: "p1" }, { policyId: "p1", mode: "allow" as never })).toEqual(responseOfEffect("deny"));
  });

  it("for every response and every effect, the resolved effect is the decision's effect", () => {
    for (const mode of POLICY_RESPONSES) {
      for (const effect of ["allow", "deny", "require_approval"] as const) {
        for (const ruleId of ["p1", "other"]) {
          const r = resolveAgentResponse({ effect, ruleId }, { policyId: "p1", mode, guidance: g });
          expect(r.effect).toBe(effect);
          expect(AGENT_RESPONSE_TABLE[r.kind as AgentResponseKind].effect).toBe(effect);
        }
      }
    }
  });
});

describe("ADR-0354 Cedar policy modes (ADR-0040 engine)", () => {
  const request = {
    principal: { id: "11111111-1111-1111-1111-111111111111", roles: ["engineer"], roleIds: ["r1"], teams: ["platform"], isAdmin: false, sessionOrigin: "password", mfaCompleted: true },
    resource: { id: "srv/create_gist", serverId: "srv", serverName: "github", toolName: "create_gist", kind: "write", priceTier: "metered", projectId: "p1", projectName: "Claims", classifications: [], dataSensitivity: null },
    context: { deployModes: ["hosted"], environments: ["production"], rateLimitUsagePct: 0 },
  } as unknown as AbacRequest;
  const policy = (id: string, name: string, mode: AbacPolicy["mode"], guidance?: AbacPolicy["guidance"]): AbacPolicy => ({
    id, name, mode, guidance: guidance ?? null, timezone: "UTC", schemaVersion: ABAC_CURRENT_SCHEMA_VERSION, version: 1,
    source: `forbid (principal, action, resource) when { resource.toolName == "create_gist" };`,
  });

  it("accepts every response mode and still refuses a permit", () => {
    for (const m of POLICY_RESPONSES) {
      expect(abacEngine.validate(`forbid (principal, action, resource);`, ABAC_CURRENT_SCHEMA_VERSION, m).ok).toBe(true);
    }
    expect(abacEngine.validate(`permit (principal, action, resource);`, ABAC_CURRENT_SCHEMA_VERSION, "advise").ok).toBe(false);
  });

  it("an advise match leaves the call permitted and carries the guidance", () => {
    const d = abacEngine.evaluate([policy("p-adv", "a", "advise", { message: "Prefer the internal share." })], request);
    expect(d.effect).toBe("permit");
    expect(d.response).toEqual({ policyId: "p-adv", mode: "advise", guidance: { message: "Prefer the internal share." } });
  });

  it("the strictest matched response governs", () => {
    const d = abacEngine.evaluate(
      [
        policy("p-adv", "a", "advise", { message: "m" }),
        policy("p-cor", "b", "correct", { message: "m", alternative: "x" }),
        policy("p-bs", "c", "block_session"),
      ],
      request,
    );
    expect(d.effect).toBe("forbid");
    expect(d.policyId).toBe("p-bs");
    expect(d.response?.mode).toBe("block_session");
    const e = abacEngine.evaluate([policy("p-cor", "a", "correct", { message: "m", alternative: "x" }), policy("p-f", "z", "forbid")], request);
    expect(e.policyId).toBe("p-f");
  });
});
