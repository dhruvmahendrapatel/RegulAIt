/**
 * ADR-0190 owner decisions C and D, pure (no database):
 *  - C: the unknown-agent floor is L3, and L2 ONLY for an `mcp_stdio` call with no agent (`unknown`) that the gateway
 *    found relaxed. A low-assurance agent, any other workload kind, or anything but `true` stays at L3, and every
 *    other floor still wins over the relaxed one (it is one floor in the MAX).
 *  - C: "a person in an interactive session" is one predicate: a password, OIDC or SAML session with no delegation
 *    grant. An API key, a session exchanged from one, the bootstrap identity, a workload token and a caller that
 *    supplies nothing are not. The shared mirror equals the gateway's `HUMAN_SESSION_ORIGINS`.
 *  - D: MAX(use cases' strictest, the admin field); the field only raises; neither, or a value outside the
 *    vocabulary, does not resolve.
 */
import { describe, expect, it } from "vitest";
import {
  computeRequiredClass,
  INTERACTIVE_SESSION_ORIGINS,
  ISOLATION_AUDIT_ACTIONS,
  ISOLATION_ROUTES,
  PERSON_STDIO_RELAXED_FLOOR,
  projectIsolationSensitivity,
  setPersonStdioRelaxationSchema,
  setProjectIsolationSensitivitySchema,
  UNKNOWN_AGENT_FLOOR,
  unknownAgentFloor,
  type RequirableIsolationClass,
  type RequirementFacts,
} from "@regulait/shared";
import { abacPrincipalFromRequest } from "./abac-principal.js";
import { HUMAN_SESSION_ORIGINS } from "./auth.js";
import { interactivePersonCaller } from "./execution-placement.js";

const L = { L1: "hardened_container", L2: "user_space_kernel", L3: "microvm" } as const satisfies Record<string, RequirableIsolationClass>;

/** an interactive person's own stdio call (no agent) on a public project, all floors strict */
const base = (over: Partial<RequirementFacts> = {}): RequirementFacts => ({
  workloadKind: "mcp_stdio",
  sensitivity: "public",
  sensitivityFloor: L.L2,
  workloadKindFloor: L.L2,
  complianceFloors: [],
  autonomyFloor: L.L1,
  agentAssurance: "unknown",
  configuredProfileFloor: L.L2,
  parentRequiredClass: null,
  ...over,
});

describe("owner decision C: the unknown-agent floor", () => {
  it("is L3 by default and L2 only when relaxed, for mcp_stdio with no agent", () => {
    expect(UNKNOWN_AGENT_FLOOR).toBe(L.L3);
    expect(PERSON_STDIO_RELAXED_FLOOR).toBe(L.L2);
    expect(unknownAgentFloor({ workloadKind: "mcp_stdio", agentAssurance: "unknown" })).toBe(L.L3);
    expect(unknownAgentFloor({ workloadKind: "mcp_stdio", agentAssurance: "unknown", personStdioRelaxed: true })).toBe(L.L2);
  });

  it("never relaxes a low-assurance agent, another workload kind, or a value that is not exactly true", () => {
    for (const agentAssurance of ["no_identity", "observed_autonomy_above_declared"]) {
      expect(unknownAgentFloor({ workloadKind: "mcp_stdio", agentAssurance, personStdioRelaxed: true }), agentAssurance).toBe(L.L3);
    }
    for (const workloadKind of ["code_exec", "engine_worker", "byoc_worker"]) {
      expect(unknownAgentFloor({ workloadKind, agentAssurance: "unknown", personStdioRelaxed: true }), workloadKind).toBe(L.L3);
    }
    for (const personStdioRelaxed of [false, "true", 1, null, undefined, {}]) {
      expect(unknownAgentFloor({ workloadKind: "mcp_stdio", agentAssurance: "unknown", personStdioRelaxed }), String(personStdioRelaxed)).toBe(L.L3);
    }
  });

  it("the cascade: relaxed gives L2 (the workload kind named on the tie); unrelaxed gives L3 by the unknown agent", () => {
    expect(computeRequiredClass(base())).toMatchObject({ ok: true, requiredClass: L.L3, requiredBy: "unknown_agent" });
    const relaxed = computeRequiredClass(base({ personStdioRelaxed: true }));
    expect(relaxed).toMatchObject({ ok: true, requiredClass: L.L2, requiredBy: "workload_kind" });
    if (relaxed.ok) expect(relaxed.floors).toContainEqual({ source: "unknown_agent", class: L.L2 });
  });

  it("never overrides another floor: regulated sensitivity, a compliance tag, the server's profile and a parent grant still win", () => {
    const cases: Array<[string, Partial<RequirementFacts>, string]> = [
      ["regulated sensitivity", { sensitivity: "regulated", sensitivityFloor: L.L3 }, "data_sensitivity"],
      ["a compliance tag at L3", { complianceFloors: [L.L3] }, "compliance_tag"],
      ["the server's own profile at L3", { configuredProfileFloor: L.L3 }, "configured_profile"],
      ["a parent grant at L3", { parentRequiredClass: L.L3 }, "parent_grant"],
    ];
    for (const [name, over, by] of cases) {
      expect(computeRequiredClass(base({ ...over, personStdioRelaxed: true })), name).toMatchObject({ ok: true, requiredClass: L.L3, requiredBy: by });
    }
  });

  it("never places below L2: with the mcp_stdio and sensitivity floors relaxed to L1, a relaxed call still requires L2", () => {
    expect(computeRequiredClass(base({ sensitivityFloor: L.L1, workloadKindFloor: L.L1, configuredProfileFloor: L.L1, personStdioRelaxed: true }))).toMatchObject({
      ok: true,
      requiredClass: L.L2,
      requiredBy: "unknown_agent",
    });
  });

  it("an unresolved fact is still refused, relaxed or not (the relaxation is never a fact that resolves another)", () => {
    expect(computeRequiredClass(base({ sensitivity: undefined, personStdioRelaxed: true }))).toEqual({ ok: false, unresolved: "sensitivity" });
  });
});

describe("owner decision C: who is an interactive person", () => {
  it("the shared mirror equals the gateway's human session origins (ADR-0039)", () => {
    expect([...INTERACTIVE_SESSION_ORIGINS].sort()).toEqual([...HUMAN_SESSION_ORIGINS].sort());
  });

  it("a password, OIDC or SAML session with no grant is; anything else is not", () => {
    for (const sessionOrigin of ["password", "oidc", "saml"]) expect(interactivePersonCaller({ sessionOrigin }, null), sessionOrigin).toBe(true);
    for (const sessionOrigin of ["api_key", "bootstrap", "unknown", "", "PASSWORD", null, undefined]) {
      expect(interactivePersonCaller({ sessionOrigin }, null), String(sessionOrigin)).toBe(false);
    }
    expect(interactivePersonCaller(undefined, null)).toBe(false);
    expect(interactivePersonCaller(null, undefined)).toBe(false);
    // a delegated call is an agent's, whatever session the sponsor holds
    expect(interactivePersonCaller({ sessionOrigin: "password" }, "6f1b6c1e-0000-4000-8000-000000000001")).toBe(false);
  });

  it("what the request's credential derives to: only a person's session is interactive (an API key never is)", () => {
    const derive = (via: string, origin?: string) =>
      interactivePersonCaller(abacPrincipalFromRequest({ authCtx: { via }, ...(origin ? { sessionAuth: { origin } } : {}) } as Parameters<typeof abacPrincipalFromRequest>[0]), null);
    expect(derive("session", "password")).toBe(true);
    expect(derive("session", "oidc")).toBe(true);
    expect(derive("session", "api_key")).toBe(false);
    expect(derive("session")).toBe(false);
    expect(derive("api-key")).toBe(false);
    expect(derive("virtual-key")).toBe(false);
    expect(derive("workload")).toBe(false);
    expect(derive("bootstrap")).toBe(false);
  });
});

describe("owner decision D: the project's sensitivity", () => {
  it("is the MAX of the use cases and the admin field; the field only raises", () => {
    expect(projectIsolationSensitivity(["public", "confidential", "internal"], null)).toBe("confidential");
    expect(projectIsolationSensitivity(["confidential"], "public")).toBe("confidential");
    expect(projectIsolationSensitivity(["internal"], "regulated")).toBe("regulated");
    expect(projectIsolationSensitivity([], "internal")).toBe("internal");
  });

  it("does not resolve with neither, or with any value outside the vocabulary (never defaulted, never masked)", () => {
    expect(projectIsolationSensitivity([], null)).toBeUndefined();
    expect(projectIsolationSensitivity([], undefined)).toBeUndefined();
    expect(projectIsolationSensitivity(["secret"], "regulated")).toBeUndefined();
    expect(projectIsolationSensitivity(["internal"], "secret")).toBeUndefined();
    expect(projectIsolationSensitivity([null], null)).toBeUndefined();
  });
});

describe("owner decisions C and D: the contract", () => {
  it("the routes are admin routes, built, and the audit actions are named", () => {
    const keys = ISOLATION_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(keys).toEqual(
      expect.arrayContaining([
        "GET /v1/execution-person-stdio-relaxations",
        "PUT /v1/execution-person-stdio-relaxations/:scopeKind/:scopeId",
        "GET /v1/execution-project-sensitivities",
        "PUT /v1/execution-project-sensitivities/:projectId",
      ]),
    );
    expect(ISOLATION_AUDIT_ACTIONS).toEqual(
      expect.arrayContaining(["execution-person-stdio-relaxed", "execution-person-stdio-relaxation-cleared", "execution-project-sensitivity-set"]),
    );
  });

  it("the bodies are strict: no class to choose (the relaxation only ever means L2), no unknown sensitivity", () => {
    expect(setPersonStdioRelaxationSchema.safeParse({ relaxed: true }).success).toBe(true);
    expect(setPersonStdioRelaxationSchema.safeParse({ relaxed: true, class: "hardened_container" }).success).toBe(false);
    expect(setPersonStdioRelaxationSchema.safeParse({ relaxed: "yes" }).success).toBe(false);
    expect(setProjectIsolationSensitivitySchema.safeParse({ sensitivity: null }).success).toBe(true);
    expect(setProjectIsolationSensitivitySchema.safeParse({ sensitivity: "regulated" }).success).toBe(true);
    expect(setProjectIsolationSensitivitySchema.safeParse({ sensitivity: "secret" }).success).toBe(false);
    expect(setProjectIsolationSensitivitySchema.safeParse({}).success).toBe(false);
  });
});
