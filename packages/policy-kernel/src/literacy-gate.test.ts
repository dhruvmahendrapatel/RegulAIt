/**
 * ADR-0182 A14 — the kernel's literacy refusal. The gateway fills `ExecutionPosture.literacy`; the kernel refuses
 * (enforce), records (warn), or does nothing (not required / current), on all three governed paths.
 */
import { describe, expect, it } from "vitest";
import {
  LITERACY_RULE_ID,
  evaluate,
  evaluateAgent,
  evaluateConnector,
  type ExecutionPosture,
  type LiteracyPosture,
  type ToolRef,
} from "./index.js";

const readTool: ToolRef = { serverId: "s1", name: "query_database", kind: "read" };
const grant = { id: "tg-1", userId: "u1", serverId: "s1", toolName: "query_database" };
const notCurrent: LiteracyPosture = { required: true, current: false, missing: ['"Acceptable use" (aup v2, missing)'], mode: "enforce" };
const tool = (execution: ExecutionPosture) =>
  evaluate({ userId: "u1", serverId: "s1", tool: readTool, toolGrants: [grant], serverGrants: [], execution });

describe("ADR-0182 A14: the literacy gate in the kernel", () => {
  it("enforce + required + not current: the tool call is refused and the reason names the document", () => {
    const d = tool({ mode: "normal", literacy: notCurrent });
    expect(d.effect).toBe("deny");
    expect(d.ruleId).toBe(LITERACY_RULE_ID);
    expect(d.ruleId).toBe("ai-literacy-not-current");
    expect(d.reason).toContain('"Acceptable use" (aup v2, missing)');
    expect(d.reason).toContain("support the");
    expect(d.ruleChain).toEqual([{ rule: "ai-literacy-not-current", outcome: "deny" }]);
  });

  it("an absent mode reads as enforce (the strict default)", () => {
    const { mode: _m, ...noMode } = notCurrent;
    expect(tool({ mode: "normal", literacy: noMode }).effect).toBe("deny");
  });

  it("current, or not required: the decision is exactly the one without the slot", () => {
    const base = tool({ mode: "normal" });
    expect(tool({ mode: "normal", literacy: { required: true, current: true, mode: "enforce" } })).toEqual(base);
    expect(tool({ mode: "normal", literacy: { required: false, current: false, mode: "enforce" } })).toEqual(base);
    expect(base.effect).toBe("allow");
  });

  it("warn: allowed exactly as without the gate, with the gap recorded first on the trace", () => {
    const base = tool({ mode: "normal" });
    const warned = tool({ mode: "normal", literacy: { ...notCurrent, mode: "warn" } });
    expect(warned.effect).toBe("allow");
    expect(warned.ruleId).toBe(base.ruleId);
    expect(warned.ruleChain).toEqual([{ rule: "ai-literacy-not-current", outcome: "no-match" }, ...base.ruleChain]);
  });

  it("a halt outranks the literacy refusal; read-only reads and the approval hold do not", () => {
    expect(tool({ mode: "halted", literacy: notCurrent }).ruleId).toBe("execution-halted");
    expect(tool({ mode: "read_only", literacy: notCurrent }).ruleId).toBe(LITERACY_RULE_ID);
    // refused, not queued for approval
    const held = tool({ mode: "require_approval", approverUserId: "a1", literacy: notCurrent });
    expect(held.effect).toBe("deny");
    expect(held.ruleId).toBe(LITERACY_RULE_ID);
  });

  it("the agent and connector paths refuse on the same slot", () => {
    const agent = evaluateAgent({
      userId: "u1",
      agent: { id: "a1", name: "helper", enabled: true },
      mode: "chat",
      agentGrants: [{ id: "g1", userId: "u1", agentId: "a1", modes: ["chat"] }],
      execution: { mode: "normal", literacy: notCurrent },
    } as unknown as Parameters<typeof evaluateAgent>[0]);
    expect(agent.ruleId).toBe(LITERACY_RULE_ID);
    const conn = evaluateConnector({
      userId: "u1",
      connectorId: "c1",
      operation: "read",
      connectorGrants: [{ id: "g1", userId: "u1", connectorId: "c1", mode: "read", allowedObjects: null }],
      execution: { mode: "normal", literacy: notCurrent },
    });
    expect(conn.effect).toBe("deny");
    expect(conn.ruleId).toBe(LITERACY_RULE_ID);
  });
});
