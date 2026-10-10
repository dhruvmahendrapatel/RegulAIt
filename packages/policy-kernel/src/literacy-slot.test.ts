/**
 * ADR-0182 (D4) P0 — the AI literacy slot on ExecutionPosture is a PURE
 * addition: absent means "not required", so every existing call site keeps
 * today's decision exactly. A14 fills the slot and adds the refusal.
 */
import { describe, expect, it } from "vitest";
import { LITERACY_NOT_REQUIRED, evaluate, literacyOf, type ToolRef } from "./index.js";

const readTool: ToolRef = { serverId: "s1", name: "query_database", kind: "read" };
const grant = { id: "tg-1", userId: "u1", serverId: "s1", toolName: "query_database" };

describe("ADR-0182 P0: the literacy slot", () => {
  it("defaults to not required when a posture does not carry it", () => {
    expect(literacyOf({ mode: "normal" })).toEqual({ required: false, current: true });
    expect(LITERACY_NOT_REQUIRED.required).toBe(false);
  });

  it("changes no decision: absent and the explicit default evaluate identically", () => {
    const base = { userId: "u1", serverId: "s1", tool: readTool, toolGrants: [grant], serverGrants: [] };
    const a = evaluate({ actor: null, ...base, execution: { mode: "normal" } });
    const b = evaluate({ actor: null, ...base, execution: { mode: "normal", literacy: LITERACY_NOT_REQUIRED } });
    expect(b).toEqual(a);
    expect(a.effect).toBe("allow");
  });
});
