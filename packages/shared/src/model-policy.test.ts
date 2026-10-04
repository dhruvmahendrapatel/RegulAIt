/**
 * ADR-0173 §3 — the model-policy verdict (the gateway's enforcement rule). The
 * console mirrors it in apps/web/src/views/models/modelPolicy.ts and pins the
 * same cases in modelPolicy.test.ts.
 */
import { describe, expect, it } from "vitest";
import { modelPolicyDefault, modelPolicyPutSchema, modelPolicyVerdict, type ModelPolicy, type ModelPolicyRule } from "./model-policy.js";

const A = { id: "a", provider: "anthropic" };
const B = { id: "b", provider: "mock" };
const rule = (over: Partial<ModelPolicyRule>): ModelPolicyRule => ({
  feature: "chat",
  dataClass: null,
  restricted: true,
  allowedAgentIds: [],
  allowedProviders: [],
  defaultAgentId: null,
  ...over,
});

describe("modelPolicyVerdict", () => {
  it("an empty policy allows everything", () => {
    expect(modelPolicyVerdict({ rules: [] }, "chat", A).allowed).toBe(true);
  });

  it("a restricted feature admits listed bindings and listed providers only", () => {
    const p: ModelPolicy = { rules: [rule({ allowedAgentIds: ["a"] })] };
    expect(modelPolicyVerdict(p, "chat", A).allowed).toBe(true);
    const no = modelPolicyVerdict(p, "chat", B);
    expect(no.allowed).toBe(false);
    if (!no.allowed) expect(no.reason).toContain("Chat");
    expect(modelPolicyVerdict({ rules: [rule({ allowedProviders: ["mock"] })] }, "chat", B).allowed).toBe(true);
  });

  it("is per feature, and an unrestricted rule restricts nothing", () => {
    const p: ModelPolicy = { rules: [rule({ allowedAgentIds: ["a"] }), rule({ feature: "builder", restricted: false, defaultAgentId: "b" })] };
    expect(modelPolicyVerdict(p, "builder", B).allowed).toBe(true);
    expect(modelPolicyVerdict(p, "copilot", B).allowed).toBe(true);
  });

  it("a data-class rule narrows only for that class, and never widens the feature", () => {
    const p: ModelPolicy = { rules: [rule({ feature: "intake_assist", dataClass: "regulated", allowedAgentIds: ["a"] })] };
    expect(modelPolicyVerdict(p, "intake_assist", B, "regulated").allowed).toBe(false);
    expect(modelPolicyVerdict(p, "intake_assist", B, "public").allowed).toBe(true);
    expect(modelPolicyVerdict(p, "intake_assist", B).allowed).toBe(true);
    const narrowOnly: ModelPolicy = {
      rules: [rule({ feature: "intake_assist", allowedAgentIds: ["a"] }), rule({ feature: "intake_assist", dataClass: "public", allowedAgentIds: ["b"] })],
    };
    expect(modelPolicyVerdict(narrowOnly, "intake_assist", B, "public").allowed).toBe(false);
  });

  it("the default is the data-class rule's when it names one, else the feature's", () => {
    const p: ModelPolicy = {
      rules: [rule({ feature: "intake_assist", restricted: false, defaultAgentId: "a" }), rule({ feature: "intake_assist", dataClass: "regulated", allowedAgentIds: ["b"], defaultAgentId: "b" })],
    };
    expect(modelPolicyDefault(p, "intake_assist")).toBe("a");
    expect(modelPolicyDefault(p, "intake_assist", "regulated")).toBe("b");
    expect(modelPolicyDefault(p, "intake_assist", "public")).toBe("a");
  });

  it("the PUT schema refuses a duplicate (feature, data class) and an unknown feature", () => {
    expect(modelPolicyPutSchema.safeParse({ rules: [{ feature: "chat" }, { feature: "chat" }] }).success).toBe(false);
    expect(modelPolicyPutSchema.safeParse({ rules: [{ feature: "chat" }, { feature: "chat", dataClass: "public" }] }).success).toBe(true);
    expect(modelPolicyPutSchema.safeParse({ rules: [{ feature: "billing" }] }).success).toBe(false);
  });
});
