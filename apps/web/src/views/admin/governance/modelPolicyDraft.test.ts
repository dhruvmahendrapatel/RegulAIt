/** ADR-0173 §3 — the Model policy page's draft → PUT body rules. */
import { describe, expect, it } from "vitest";
import {
  cellAllowed,
  draftFrom,
  featuresAllowingNothing,
  removeClassRule,
  setBindingAllowed,
  setDefault,
  setProviderAllowed,
  setRestricted,
  toRules,
  upsertClassRule,
} from "./modelPolicyDraft";

const A = { id: "a", provider: "anthropic" };
const B = { id: "b", provider: "mock" };

describe("model policy draft", () => {
  it("an untouched draft is the empty policy (today's behaviour)", () => {
    expect(toRules(draftFrom({ rules: [] }))).toEqual([]);
  });

  it("round-trips a stored policy", () => {
    const rules = [
      { feature: "chat" as const, dataClass: null, restricted: true, allowedAgentIds: ["a"], allowedProviders: ["mock"], defaultAgentId: "a" },
      { feature: "intake_assist" as const, dataClass: "regulated" as const, restricted: true, allowedAgentIds: ["a"], allowedProviders: [], defaultAgentId: null },
    ];
    expect(toRules(draftFrom({ rules }))).toEqual(rules);
  });

  it("restricting starts from nothing allowed (plus the default), and is said out loud", () => {
    let d = setDefault(draftFrom(null), "chat", "a");
    d = setRestricted(d, "builder", true);
    expect(featuresAllowingNothing(d)).toEqual(["builder"]);
    d = setRestricted(d, "chat", true);
    expect(d.base.chat.allowedAgentIds).toEqual(["a"]);
    expect(cellAllowed(d, "chat", A)).toBe(true);
    expect(cellAllowed(d, "chat", B)).toBe(false);
    // an unrestricted feature with only a default keeps a row, unrestricted
    const onlyDefault = toRules(setDefault(draftFrom(null), "copilot", "b"));
    expect(onlyDefault).toEqual([
      { feature: "copilot", dataClass: null, restricted: false, allowedAgentIds: [], allowedProviders: [], defaultAgentId: "b" },
    ]);
  });

  it("forbidding the default clears it; a provider entry allows every binding of that provider", () => {
    let d = setRestricted(draftFrom(null), "chat", true);
    d = setBindingAllowed(d, "chat", "a", true);
    d = setDefault(d, "chat", "a");
    d = setBindingAllowed(d, "chat", "a", false);
    expect(d.base.chat.defaultAgentId).toBeNull();
    d = setProviderAllowed(d, "chat", "mock", true, [A, B]);
    expect(cellAllowed(d, "chat", B)).toBe(true);
    d = setDefault(d, "chat", "b");
    d = setProviderAllowed(d, "chat", "mock", false, [A, B]);
    expect(d.base.chat.defaultAgentId).toBeNull();
    expect(cellAllowed(d, "chat", B)).toBe(false);
  });

  it("adds, replaces and removes a data-class rule", () => {
    let d = upsertClassRule(draftFrom(null), { feature: "intake_assist", dataClass: "regulated", allowedAgentIds: ["a"], allowedProviders: [], defaultAgentId: null });
    d = upsertClassRule(d, { feature: "intake_assist", dataClass: "regulated", allowedAgentIds: ["b"], allowedProviders: [], defaultAgentId: null });
    expect(d.classes).toHaveLength(1);
    expect(toRules(d)[0]).toMatchObject({ dataClass: "regulated", restricted: true, allowedAgentIds: ["b"] });
    expect(toRules(removeClassRule(d, "intake_assist", "regulated"))).toEqual([]);
  });
});
