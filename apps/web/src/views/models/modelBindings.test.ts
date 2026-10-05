/**
 * ADR-0172 — readiness of a model binding for the person looking at it, and
 * the portal's search / provider filter. Each rule has a control: the same row
 * without the triggering field must NOT get that readiness.
 */
import { describe, expect, it } from "vitest";
import {
  bindingsFromGranted,
  bindingsFromRegistry,
  classifyRunFailure,
  filterBindings,
  providerChips,
  providerLabel,
  readinessOf,
  type BindingRow,
  type ReadinessContext,
} from "./modelBindings";

const none: ReadinessContext = { providerStatus: {}, myProviders: [] };
const platformAnthropic: ReadinessContext = { providerStatus: { anthropic: { configured: true } }, myProviders: [] };
const row = (over: Partial<BindingRow> = {}): BindingRow => ({
  id: "a1",
  name: "claude-opus",
  provider: "anthropic",
  model: "claude-opus-5",
  tier: 2,
  enabled: true,
  ...over,
});

describe("readinessOf", () => {
  it("is ready on the platform credential, and needs credentials without one", () => {
    expect(readinessOf(row(), platformAnthropic)).toMatchObject({ readiness: "ready" });
    expect(readinessOf(row(), platformAnthropic).detail).toContain("platform Anthropic credential");
    const r = readinessOf(row(), none);
    expect(r.readiness).toBe("needs_credentials");
    expect(r.detail).toContain("No Anthropic credential");
  });

  it("counts the person's own key as ready, for that provider only", () => {
    const mine: ReadinessContext = { providerStatus: {}, myProviders: ["anthropic"] };
    expect(readinessOf(row(), mine)).toMatchObject({ readiness: "ready", detail: "Runs on your own Anthropic key." });
    expect(readinessOf(row({ provider: "openai" }), mine).readiness).toBe("needs_credentials");
  });

  it("a configured:false status entry is not a credential", () => {
    expect(readinessOf(row(), { providerStatus: { anthropic: { configured: false } }, myProviders: [] }).readiness).toBe(
      "needs_credentials",
    );
  });

  it("mock needs no credential; a custom endpoint carries its own", () => {
    expect(readinessOf(row({ provider: "mock" }), none).readiness).toBe("ready");
    expect(readinessOf(row({ provider: "custom", customProviderId: "c" }), none).readiness).toBe("ready");
  });

  it("halted and suspended win over a configured credential, with their reasons", () => {
    const halted = readinessOf(row({ haltedAt: "2026-10-01T00:00:00Z", haltedReason: "incident 42" }), platformAnthropic);
    expect(halted.readiness).toBe("halted");
    expect(halted.detail).toContain("incident 42");
    const suspended = readinessOf(row({ lifecycleStatus: "suspended", lifecycleReason: "vendor review" }), platformAnthropic);
    expect(suspended.readiness).toBe("suspended");
    expect(suspended.detail).toContain("vendor review");
    // control: lifecycle states that still dispatch stay ready
    expect(readinessOf(row({ lifecycleStatus: "deprecated" }), platformAnthropic).readiness).toBe("ready");
    expect(readinessOf(row({ haltedAt: null }), platformAnthropic).readiness).toBe("ready");
  });

  it("orders the refusals: revoked, halted, retired, suspended, disabled, routing only", () => {
    const all = row({ revoked: true, haltedAt: "x", lifecycleStatus: "suspended", enabled: false, model: null });
    expect(readinessOf(all, platformAnthropic).readiness).toBe("revoked");
    expect(readinessOf({ ...all, revoked: false }, platformAnthropic).readiness).toBe("halted");
    expect(readinessOf({ ...all, revoked: false, haltedAt: null, lifecycleStatus: "retired" }, platformAnthropic).readiness).toBe("retired");
    expect(readinessOf({ ...all, revoked: false, haltedAt: null }, platformAnthropic).readiness).toBe("suspended");
    expect(readinessOf({ ...all, revoked: false, haltedAt: null, lifecycleStatus: "active" }, platformAnthropic).readiness).toBe("disabled");
    expect(readinessOf(row({ model: null }), platformAnthropic).readiness).toBe("routing_only");
  });
});

describe("bindings", () => {
  it("maps grant rows (agentId) and registry rows (id) to tiles with label, logo and badge", () => {
    const [g] = bindingsFromGranted([{ agentId: "g1", name: "gpt", provider: "openai", model: "gpt-5", tier: 1 }], none);
    expect(g).toMatchObject({
      id: "g1",
      providerLabel: "OpenAI",
      logoKey: "openai",
      readiness: "needs_credentials",
      readinessLabel: "Needs credentials",
      readinessTone: "warn",
    });
    const [r] = bindingsFromRegistry([row({ provider: "mock", model: "mock-fast" })], none);
    expect(r).toMatchObject({ id: "a1", providerLabel: "Mock", logoKey: null, readinessLabel: "Ready", readinessTone: "ok" });
  });

  it("sorts by name", () => {
    const list = bindingsFromRegistry([row({ id: "b", name: "zeta" }), row({ id: "a", name: "alpha" })], none);
    expect(list.map((b) => b.name)).toEqual(["alpha", "zeta"]);
  });

  it("names providers the way the console does", () => {
    expect(providerLabel("xai")).toBe("xAI");
    expect(providerLabel("custom")).toBe("Custom endpoint");
    expect(providerLabel("acme")).toBe("Acme");
  });
});

describe("filterBindings / providerChips", () => {
  const list = bindingsFromRegistry(
    [
      row({ id: "1", name: "claude-opus", provider: "anthropic", model: "claude-opus-5" }),
      row({ id: "2", name: "fast", provider: "openai", model: "gpt-5-mini" }),
      row({ id: "3", name: "demo", provider: "mock", model: "mock-balanced" }),
    ],
    none,
  );

  it("searches name, model id and provider name, case-insensitively", () => {
    expect(filterBindings(list, "GPT", null).map((b) => b.id)).toEqual(["2"]);
    expect(filterBindings(list, "openai", null).map((b) => b.id)).toEqual(["2"]);
    expect(filterBindings(list, "anthropic", null).map((b) => b.id)).toEqual(["1"]);
    expect(filterBindings(list, "  ", null)).toHaveLength(3);
    expect(filterBindings(list, "nothing-like-this", null)).toHaveLength(0);
  });

  it("narrows by provider, and combines with the search", () => {
    expect(filterBindings(list, "", "mock").map((b) => b.id)).toEqual(["3"]);
    expect(filterBindings(list, "claude", "mock")).toHaveLength(0);
  });

  it("offers one chip per provider present, with counts", () => {
    expect(providerChips(list).map((c) => [c.label, c.count])).toEqual([
      ["Anthropic", 1],
      ["Mock", 1],
      ["OpenAI", 1],
    ]);
  });
});

describe("classifyRunFailure: only a governance refusal is 'Refused'", () => {
  it("a 403 carrying the deciding rule is a refusal, with its rule and reason", () => {
    expect(classifyRunFailure(403, { decision: { effect: "deny", ruleId: "no-grant", reason: "no grant" } }, "x")).toEqual({
      kind: "refused",
      ruleId: "no-grant",
      reason: "no grant",
    });
    expect(classifyRunFailure(403, { error: "pii_blocked", ruleId: "pii-block", detail: "an email address" }, "x")).toEqual({
      kind: "refused",
      ruleId: "pii-block",
      reason: "an email address",
    });
  });

  it("a network failure, a 5xx, a 409 and a 403 without a rule are 'Couldn't run' with the code", () => {
    expect(classifyRunFailure(null, null, "offline")).toEqual({ kind: "error", code: "network", message: "offline", status: null });
    expect(classifyRunFailure(502, { error: "model_dispatch_failed" }, "upstream")).toMatchObject({ kind: "error", code: "model_dispatch_failed", status: 502 });
    expect(classifyRunFailure(500, {}, "boom")).toMatchObject({ kind: "error", code: "HTTP 500" });
    expect(classifyRunFailure(409, { error: "agent_suspended" }, "suspended")).toMatchObject({ kind: "error", code: "agent_suspended" });
    expect(classifyRunFailure(403, { error: "forbidden" }, "no")).toMatchObject({ kind: "error", code: "forbidden" });
    // an ALLOW decision on an error response is not a refusal either
    expect(classifyRunFailure(403, { decision: { effect: "allow", ruleId: "grant-direct" } }, "x").kind).toBe("error");
  });
});
