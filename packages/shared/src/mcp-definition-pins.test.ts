/** ADR-0246: the pure half of MCP definition pinning. */
import { describe, expect, it } from "vitest";
import {
  approveMcpDefinitionPinsSchema,
  definitionDiff,
  definitionPinStatus,
  MCP_DEFINITION_PIN_LIMIT_PER_KIND,
  pinnableDefinition,
  pinnableDefinitions,
  planDefinitionPins,
} from "./mcp-definition-pins.js";

const tool = (extra: Record<string, unknown> = {}) => ({
  name: "t",
  description: "d",
  inputSchema: { type: "object", properties: { a: { type: "string" } } },
  ...extra,
});

describe("pinnableDefinition", () => {
  it("digests the pinned fields only, independent of key order", () => {
    const a = pinnableDefinition("tool", tool())!;
    const b = pinnableDefinition("tool", { inputSchema: { properties: { a: { type: "string" } }, type: "object" }, description: "d", name: "t" })!;
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(b.digest).toBe(a.digest);
    expect(pinnableDefinition("tool", tool({ _meta: { x: 1 }, icons: [] }))!.digest).toBe(a.digest);
  });

  it("moves on every pinned field, annotations included", () => {
    const base = pinnableDefinition("tool", tool())!.digest;
    for (const extra of [{ description: "d2" }, { title: "T" }, { annotations: { readOnlyHint: true } }, { outputSchema: { type: "object" } }]) {
      expect(pinnableDefinition("tool", tool(extra))!.digest).not.toBe(base);
    }
  });

  it("keys a resource by URI and refuses an item with no usable key", () => {
    expect(pinnableDefinition("resource", { uri: "a://b", name: "n" })!.name).toBe("a://b");
    expect(pinnableDefinition("tool", { description: "no name" })).toBeNull();
    expect(pinnableDefinition("tool", null)).toBeNull();
    expect(pinnableDefinition("tool", { name: "x".repeat(5000) })).toBeNull();
  });
});

describe("pinnableDefinitions and the plan", () => {
  it("treats a null kind as not observed and an empty one as served none", () => {
    const set = pinnableDefinitions({ tools: [tool()], prompts: null, resources: [] });
    expect([...set.observedKinds].sort()).toEqual(["resource", "tool"]);
    const stored = [
      { kind: "prompt" as const, name: "p", approvedDigest: "a", observedDigest: "a" },
      { kind: "resource" as const, name: "r://1", approvedDigest: "b", observedDigest: "b" },
    ];
    const plan = planDefinitionPins(stored, set);
    expect(plan.gone.map((p) => p.name)).toEqual(["r://1"]);
    expect(plan.added.map((d) => d.name)).toEqual(["t"]);
  });

  it("pins the first of a duplicate name and stops at the per-kind cap", () => {
    const set = pinnableDefinitions({ tools: [tool(), tool({ description: "shadow" })] });
    expect(set.definitions).toHaveLength(1);
    expect(set.definitions[0]!.definition.description).toBe("d");
    expect(set.skipped).toEqual([{ kind: "tool", reason: "duplicate" }]);
    const many = Array.from({ length: MCP_DEFINITION_PIN_LIMIT_PER_KIND + 2 }, (_, i) => tool({ name: `t${i}` }));
    expect(pinnableDefinitions({ tools: many }).skipped.filter((s) => s.reason === "over_limit")).toHaveLength(2);
  });

  it("an unchanged observation plans nothing", () => {
    const set = pinnableDefinitions({ tools: [tool()] });
    const d = set.definitions[0]!;
    expect(planDefinitionPins([{ kind: "tool", name: "t", approvedDigest: d.digest, observedDigest: d.digest }], set)).toEqual({ added: [], reobserved: [], gone: [] });
  });
});

describe("status, diff and the approval body", () => {
  it("derives the status from the two digests", () => {
    expect(definitionPinStatus("a", "a")).toBe("approved");
    expect(definitionPinStatus("a", "b")).toBe("changed");
    expect(definitionPinStatus(null, "b")).toBe("added");
    expect(definitionPinStatus("a", null)).toBe("removed");
  });

  it("diffs as an RFC 6902 patch", () => {
    expect(definitionDiff({ name: "t", description: "a" }, { name: "t", description: "b" })).toEqual([{ op: "replace", path: "/description", value: "b" }]);
    expect(definitionDiff(null, { name: "t" })).toEqual([{ op: "add", path: "/name", value: "t" }]);
  });

  it("requires a reason, a 64-hex or null digest, and at most 100 items", () => {
    const item = { kind: "tool", name: "t", observedDigest: "a".repeat(64) };
    expect(approveMcpDefinitionPinsSchema.safeParse({ items: [item], reason: "ok" }).success).toBe(true);
    expect(approveMcpDefinitionPinsSchema.safeParse({ items: [{ ...item, observedDigest: null }], reason: "ok" }).success).toBe(true);
    expect(approveMcpDefinitionPinsSchema.safeParse({ items: [item], reason: " " }).success).toBe(false);
    expect(approveMcpDefinitionPinsSchema.safeParse({ items: [{ ...item, observedDigest: "A".repeat(64) }], reason: "ok" }).success).toBe(false);
    expect(approveMcpDefinitionPinsSchema.safeParse({ items: Array(101).fill(item), reason: "ok" }).success).toBe(false);
  });
});
