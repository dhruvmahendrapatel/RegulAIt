/**
 * ADR-0179 — UX-AG-1 (the fallback chain is staged and saved explicitly) and
 * UX-AG-5 (a role-granted agent's reason links to the Roles page). Pure: the
 * exported helpers, no DOM. The browser half is
 * e2e/agents-fallback-chain.mock.spec.ts.
 */
import { describe, expect, it } from "vitest";
import {
  ROLES_PAGE_PATH,
  fallbackChainBody,
  fallbackChainDirty,
  moveFallback,
  roleGrantReasonText,
  type FallbackRow,
} from "./AgentsPage";

const row = (agentId: string, position: number): FallbackRow => ({
  position,
  agentId,
  name: agentId,
  provider: "mock",
  model: null,
  enabled: true,
});
const saved = [row("a", 0), row("b", 1), row("c", 2)];

describe("UX-AG-1 — the fallback chain is a draft until saved", () => {
  it("an unchanged draft is clean", () => {
    expect(fallbackChainDirty(saved, [...saved])).toBe(false);
    expect(fallbackChainDirty([], [])).toBe(false);
  });

  it("a reorder, an add and a remove each make the draft dirty", () => {
    expect(fallbackChainDirty(saved, moveFallback(saved, 0, 1))).toBe(true);
    expect(fallbackChainDirty(saved, [...saved, row("d", 3)])).toBe(true);
    expect(fallbackChainDirty(saved, saved.slice(1))).toBe(true);
  });

  it("moving back restores a clean draft — dirtiness is the order, not the history", () => {
    const there = moveFallback(saved, 1, 1);
    expect(there.map((r) => r.agentId)).toEqual(["a", "c", "b"]);
    expect(fallbackChainDirty(saved, moveFallback(there, 2, -1))).toBe(false);
  });

  it("a move off either end is a no-op and does not mutate the input", () => {
    expect(moveFallback(saved, 0, -1).map((r) => r.agentId)).toEqual(["a", "b", "c"]);
    expect(moveFallback(saved, 2, 1).map((r) => r.agentId)).toEqual(["a", "b", "c"]);
    moveFallback(saved, 0, 1);
    expect(saved.map((r) => r.agentId)).toEqual(["a", "b", "c"]);
  });

  it("the saved body is the ordered ids and nothing else", () => {
    expect(fallbackChainBody(moveFallback(saved, 0, 1))).toEqual({ fallbackAgentIds: ["b", "a", "c"] });
  });
});

describe("UX-AG-5 — the role-grant reason points at the Roles page", () => {
  it("names the roles and the two levers", () => {
    const text = roleGrantReasonText(["engineering", "ops"]);
    expect(text).toMatch(/Granted by role engineering, ops/);
    expect(text).toMatch(/Remove it from the role/);
    expect(text).toMatch(/per-user revocation on the Users page/);
  });

  it("links to the admin Roles route", () => {
    expect(ROLES_PAGE_PATH).toBe("/admin/roles");
  });
});
