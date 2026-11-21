import { describe, expect, it } from "vitest";
import { REGISTRY_RECORD_STATES, REGISTRY_RECORD_TRANSITIONS, canMoveRegistryRecord, registryRecordState } from "./agent-registry-records.js";

// ADR-0314: the staged record's declared lifecycle (owner build rule 12)
describe("agent registry record lifecycle", () => {
  const at = new Date("2026-11-17T00:00:00Z");
  it("derives one state per row; imported wins over absent", () => {
    expect(registryRecordState({ agentId: null, absentSince: null })).toBe("open");
    expect(registryRecordState({ agentId: null, absentSince: at })).toBe("absent");
    expect(registryRecordState({ agentId: "a", absentSince: null })).toBe("imported");
    expect(registryRecordState({ agentId: "a", absentSince: at })).toBe("imported");
  });
  it("declares every state, and imported is terminal", () => {
    expect(Object.keys(REGISTRY_RECORD_TRANSITIONS).sort()).toEqual([...REGISTRY_RECORD_STATES].sort());
    for (const s of REGISTRY_RECORD_STATES) expect(canMoveRegistryRecord("imported", s)).toBe(false);
  });
  it("allows import from open and absent, and open and absent to swap", () => {
    expect(canMoveRegistryRecord("open", "imported")).toBe(true);
    expect(canMoveRegistryRecord("absent", "imported")).toBe(true);
    expect(canMoveRegistryRecord("open", "absent")).toBe(true);
    expect(canMoveRegistryRecord("absent", "open")).toBe(true);
    expect(canMoveRegistryRecord("open", "open")).toBe(false);
  });
});
