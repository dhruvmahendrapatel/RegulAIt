/**
 * ADR-0190 slice I2 — THE PLACEMENT DECISION, pure (no database):
 *  - THE CASCADE (decision 7), table-driven: every floor raises, none lowers;
 *    the floor that wins is named; an unknown or low-assurance agent starts at
 *    the most restrictive profile's class; `byoc_worker` has no kind floor of
 *    its own; `code_exec` is L3 for confidential and regulated projects.
 *  - UNRESOLVED FACTS (amendment item 15, owner decision B): every fact that is
 *    missing or outside its vocabulary is reported, first one wins, and never
 *    becomes a class.
 *  - DELEGATION (decision 8): a child below its parent is refused; one that
 *    names nothing inherits; the token-endpoint shape (amendment item 11).
 *  - THE LIVE CHAIN (amendment item 12): an actor's placement whose executor is
 *    not active, quarantined, or not freshly attested at the class.
 *  - CONFORMANCE: the ADR-0190 placement vectors I2 owns (PR #334's corpus,
 *    `packages/shared/test-vectors/placement/`) run against the product's own
 *    functions: every requirement vector, every `unknown-*`, every
 *    `delegation-*`, every `middle-actor-*` and the non-isolable kinds.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { InvalidGrant } from "oidc-provider/lib/helpers/errors.js";
import {
  AUTONOMY_CLASSES,
  AUTONOMY_ISOLATION_FLOORS,
  childIsolationClass,
  computeRequiredClass,
  defaultProfileFor,
  DELEGATION_ERROR_CODES,
  DELEGATION_ISOLATION_RULE_ID,
  DELEGATION_RULE_IDS,
  delegationIsolationViolation,
  EXECUTION_PROFILE_RULE_ID,
  executionProfileUnavailable,
  ISOLATION_ROUTES,
  grantCoversPlacement,
  isolationClassSatisfies,
  livePlacementFailure,
  livePlacementRequiredClass,
  NO_AUTONOMY_CLASS_FLOOR,
  NON_ISOLABLE_EXECUTION,
  SHIPPED_EXECUTION_PROFILES,
  unresolvedRequirementFact,
  workloadKindFloor,
  type RequirableIsolationClass,
  type RequirementFacts,
} from "@regulait/shared";
import { DelegationRefusedError } from "./delegation.js";
import { mapDelegationRefusal } from "./oauth/token-endpoint.js";

const L = { L1: "hardened_container", L2: "user_space_kernel", L3: "microvm" } as const satisfies Record<string, RequirableIsolationClass>;
const STRICT_FLOORS = { isolationFloorMcpStdio: L.L2, isolationFloorEngineWorker: L.L2 };

/** a fully resolved request: an L2 stdio call on a public project by a known, supervised agent */
const base = (over: Partial<RequirementFacts> = {}): RequirementFacts => ({
  workloadKind: "mcp_stdio",
  sensitivity: "public",
  sensitivityFloor: L.L2,
  workloadKindFloor: L.L2,
  complianceFloors: [],
  autonomyFloor: L.L1,
  agentAssurance: "known",
  configuredProfileFloor: L.L2,
  parentRequiredClass: null,
  ...over,
});

describe("ADR-0190 decision 7: the required class is the MAX of every floor", () => {
  const cases: Array<[string, Partial<RequirementFacts>, RequirableIsolationClass, string]> = [
    ["all floors at L2: the workload kind is named first", {}, L.L2, "workload_kind"],
    ["a regulated project (sensitivity floor L3)", { sensitivity: "regulated", sensitivityFloor: L.L3 }, L.L3, "data_sensitivity"],
    ["a compliance tag at L3 raises an L2 project", { complianceFloors: [L.L3] }, L.L3, "compliance_tag"],
    ["a compliance tag at L1 never lowers it", { complianceFloors: [L.L1] }, L.L2, "workload_kind"],
    ["a tag with no isolation opinion (null) is not a floor", { complianceFloors: [null, null] }, L.L2, "workload_kind"],
    ["the strictest tag of several wins", { complianceFloors: [L.L1, L.L3, L.L2] }, L.L3, "compliance_tag"],
    ["an autonomy floor at L3 raises", { autonomyFloor: L.L3 }, L.L3, "autonomy_class"],
    ["the configured profile's minClass raises", { configuredProfileFloor: L.L3 }, L.L3, "configured_profile"],
    ["the configured profile at L1 never lowers", { configuredProfileFloor: L.L1 }, L.L2, "workload_kind"],
    ["an agent with no identity starts at the most restrictive profile", { agentAssurance: "no_identity" }, L.L3, "unknown_agent"],
    ["an observed autonomy above the declared one is low-assurance", { agentAssurance: "observed_autonomy_above_declared" }, L.L3, "unknown_agent"],
    ["the parent's class raises a delegated call", { parentRequiredClass: L.L3 }, L.L3, "parent_grant"],
    ["a parent at L1 never lowers", { parentRequiredClass: L.L1 }, L.L2, "workload_kind"],
    ["a relaxed stdio floor (L1) with the strict sensitivity floor (L2)", { workloadKindFloor: L.L1 }, L.L2, "data_sensitivity"],
    ["every floor relaxed to L1 is still L1, never L0", { workloadKindFloor: L.L1, sensitivityFloor: L.L1, configuredProfileFloor: L.L1 }, L.L1, "workload_kind"],
    ["byoc_worker has no kind floor of its own", { workloadKind: "byoc_worker", workloadKindFloor: null }, L.L2, "data_sensitivity"],
    // THE TIE-BREAK: when several floors give the same (highest) class, the first in decision 7's order is named
    // (workload kind, sensitivity, compliance tag, autonomy, configured profile, unknown agent, parent grant)
    ["a tie: a regulated project and an unknown agent (both L3) name the sensitivity", { sensitivity: "regulated", sensitivityFloor: L.L3, agentAssurance: "no_identity" }, L.L3, "data_sensitivity"],
    ["a tie: a configured L3 profile and an unknown agent name the configured profile", { configuredProfileFloor: L.L3, agentAssurance: "no_identity" }, L.L3, "configured_profile"],
    ["a tie: a compliance tag and the parent at L3 name the tag", { complianceFloors: [L.L3], parentRequiredClass: L.L3 }, L.L3, "compliance_tag"],
  ];
  it.each(cases)("%s", (_name, over, cls, by) => {
    const r = computeRequiredClass(base(over));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.requiredClass).toBe(cls);
    expect(r.requiredBy).toBe(by);
    // the evidence lists every floor that took part, and the winner is one of them
    expect(r.floors.some((f) => f.source === by && f.class === cls)).toBe(true);
  });

  it("decision 3: the workload kind floors (settings for stdio and engines; code_exec by sensitivity; byoc none)", () => {
    expect(workloadKindFloor("mcp_stdio", "public", STRICT_FLOORS)).toBe(L.L2);
    expect(workloadKindFloor("mcp_stdio", "public", { ...STRICT_FLOORS, isolationFloorMcpStdio: L.L1 })).toBe(L.L1);
    expect(workloadKindFloor("engine_worker", "regulated", STRICT_FLOORS)).toBe(L.L2);
    for (const s of ["public", "internal"]) expect(workloadKindFloor("code_exec", s, STRICT_FLOORS)).toBe(L.L2);
    for (const s of ["confidential", "regulated"]) expect(workloadKindFloor("code_exec", s, STRICT_FLOORS)).toBe(L.L3);
    expect(workloadKindFloor("byoc_worker", "regulated", STRICT_FLOORS)).toBeNull();
  });

  it("decision 7 item 4: delegated and autonomous agents start at L2 at least; a subject with no autonomy class adds nothing above L1", () => {
    for (const c of AUTONOMY_CLASSES) expect(Object.hasOwn(AUTONOMY_ISOLATION_FLOORS, c)).toBe(true);
    expect(AUTONOMY_ISOLATION_FLOORS.delegated).toBe(L.L2);
    expect(AUTONOMY_ISOLATION_FLOORS.autonomous).toBe(L.L2);
    expect(AUTONOMY_ISOLATION_FLOORS.assist).toBe(L.L1);
    expect(NO_AUTONOMY_CLASS_FLOOR).toBe(L.L1);
  });

  it("decision 7 item 5: an unknown agent runs under the most restrictive shipped profile, whatever the kind", () => {
    for (const k of ["mcp_stdio", "code_exec", "engine_worker", "byoc_worker"] as const) {
      expect(defaultProfileFor(k, "no_identity")).toBe("restricted-microvm");
      expect(defaultProfileFor(k, "observed_autonomy_above_declared")).toBe("restricted-microvm");
    }
    expect(defaultProfileFor("mcp_stdio", "known")).toBe("restricted");
    expect(defaultProfileFor("engine_worker", "known")).toBe("engine-worker");
    expect(SHIPPED_EXECUTION_PROFILES["restricted-microvm"].minClass).toBe(L.L3);
  });
});

describe("ADR-0190 amendment item 15 with owner decision B: an unresolved fact is never a class", () => {
  const unresolved: Array<[keyof RequirementFacts, unknown]> = [
    ["workloadKind", "future_kind"],
    ["workloadKind", undefined],
    ["workloadKind", "model_call"],
    ["sensitivity", "secret"],
    ["sensitivity", undefined],
    ["sensitivityFloor", undefined],
    ["sensitivityFloor", "in_gateway"],
    ["workloadKindFloor", undefined],
    ["workloadKindFloor", null],
    ["complianceFloors", undefined],
    ["complianceFloors", ["L9"]],
    ["complianceFloors", [L.L2, "in_gateway"]],
    ["autonomyFloor", undefined],
    ["autonomyFloor", null],
    ["agentAssurance", "trusted"],
    ["configuredProfileFloor", undefined],
    ["configuredProfileFloor", "in_gateway"],
    ["parentRequiredClass", undefined],
    ["parentRequiredClass", "L9"],
  ];
  it.each(unresolved)("%s = %j does not resolve", (fact, value) => {
    const facts = base({ [fact]: value } as Partial<RequirementFacts>);
    const r = computeRequiredClass(facts);
    expect(r).toEqual({ ok: false, unresolved: fact });
    expect(unresolvedRequirementFact(facts)).toBe(fact);
  });

  it("byoc_worker with a kind floor is a lookup that did not resolve (decision 3 gives it none)", () => {
    expect(computeRequiredClass(base({ workloadKind: "byoc_worker", workloadKindFloor: L.L2 }))).toEqual({ ok: false, unresolved: "workloadKindFloor" });
  });

  it("the first unresolved fact names the refusal (fixed order)", () => {
    expect(computeRequiredClass(base({ sensitivity: undefined, parentRequiredClass: "L9" }))).toEqual({ ok: false, unresolved: "sensitivity" });
  });

  it("the refusal envelope: 409 execution_profile_unavailable, rule execution-profile, reason policy_unresolved", () => {
    expect(executionProfileUnavailable("policy_unresolved")).toEqual({ statusCode: 409, error: "execution_profile_unavailable", ruleId: "execution-profile", reason: "policy_unresolved" });
    expect(EXECUTION_PROFILE_RULE_ID).toBe("execution-profile");
  });
});

describe("ADR-0190 decision 8: delegation-isolation and the live chain", () => {
  const classes = [L.L1, L.L2, L.L3];
  it("a child below its parent is refused; equal or above is admitted; none inherits", () => {
    for (const p of classes)
      for (const c of classes) expect(delegationIsolationViolation(p, c), `${p} -> ${c}`).toBe(classes.indexOf(c) < classes.indexOf(p));
    for (const p of classes) {
      expect(delegationIsolationViolation(p, null)).toBe(false);
      expect(childIsolationClass(p, null)).toBe(p);
      expect(childIsolationClass(p, undefined)).toBe(p);
    }
    expect(delegationIsolationViolation(null, L.L1)).toBe(false);
    expect(childIsolationClass(null, L.L1)).toBe(L.L1);
  });

  it("amendment item 11: the rule id is a delegation rule; on the token endpoint it is invalid_grant with error_code delegation_isolation", () => {
    expect(DELEGATION_ISOLATION_RULE_ID).toBe("delegation-isolation");
    expect(DELEGATION_RULE_IDS).toContain("delegation-isolation");
    expect(DELEGATION_ERROR_CODES).toContain("delegation_isolation");
    const mapped = mapDelegationRefusal(new DelegationRefusedError("delegation-isolation", "delegation_isolation", "below the parent"));
    expect(mapped).toBeInstanceOf(InvalidGrant);
    expect((mapped as { error: string }).error).toBe("invalid_grant");
  });

  it("review M1: the class a placement must still hold is the stricter of the grant's and the placement's; a grant never names less than its placement", () => {
    expect(livePlacementRequiredClass(L.L2, L.L3)).toBe(L.L3);
    expect(livePlacementRequiredClass(L.L3, L.L2)).toBe(L.L3);
    expect(livePlacementRequiredClass(null, L.L2)).toBe(L.L2);
    expect(grantCoversPlacement(L.L3, L.L2)).toBe(true);
    expect(grantCoversPlacement(L.L3, L.L3)).toBe(true);
    expect(grantCoversPlacement(L.L2, L.L3)).toBe(false);
    expect(grantCoversPlacement(null, L.L1)).toBe(false);
  });

  it("amendment item 12: a placement holds only on an active, unquarantined, freshly attested executor", () => {
    expect(livePlacementFailure({ executorStatus: "active", attestationFresh: true, attestedClassSatisfies: true })).toBeNull();
    expect(livePlacementFailure({ executorStatus: "revoked", attestationFresh: true, attestedClassSatisfies: true })).toBe("executor_not_active");
    expect(livePlacementFailure({ executorStatus: null, attestationFresh: false, attestedClassSatisfies: false })).toBe("executor_not_active");
    expect(livePlacementFailure({ executorStatus: "quarantined", attestationFresh: true, attestedClassSatisfies: true })).toBe("executor_quarantined");
    expect(livePlacementFailure({ executorStatus: "active", attestationFresh: false, attestedClassSatisfies: true })).toBe("executor_attestation_stale");
    expect(livePlacementFailure({ executorStatus: "active", attestationFresh: true, attestedClassSatisfies: false })).toBe("executor_attestation_stale");
  });
});

describe("ADR-0190 I2: every isolation route is built", () => {
  it("no route answers the I1 stub any more", () => {
    expect(ISOLATION_ROUTES.filter((r) => !r.built)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The specification vectors (PR #334), run against the product's functions
// ---------------------------------------------------------------------------

interface Vector {
  id: string;
  semanticRequest: Record<string, unknown>;
  expectedProjection: Record<string, unknown>;
}
const corpus = JSON.parse(readFileSync(new URL("../../../packages/shared/test-vectors/placement/placement-semantic-corpus.json", import.meta.url), "utf8")) as { vectors: Vector[] };
const toClass = (v: unknown): unknown => (typeof v === "string" && v in L ? L[v as keyof typeof L] : v);
const has = (q: Record<string, unknown>, k: string) => Object.hasOwn(q, k);

/** the vector's semantic request as the gateway's resolved facts (a missing key stays missing) */
function factsOf(q: Record<string, unknown>): RequirementFacts {
  const kind = q.workloadKind;
  const sensitivity = q.sensitivity;
  const kindFloor =
    q.workloadKindFloorOverride !== undefined
      ? toClass(q.workloadKindFloorOverride)
      : typeof kind === "string" && ["mcp_stdio", "code_exec", "engine_worker", "byoc_worker"].includes(kind)
        ? workloadKindFloor(kind as "mcp_stdio", sensitivity, STRICT_FLOORS)
        : undefined;
  const f: RequirementFacts = {
    workloadKind: kind,
    sensitivity,
    sensitivityFloor: has(q, "sensitivityFloor") ? toClass(q.sensitivityFloor) : undefined,
    workloadKindFloor: kindFloor,
    complianceFloors: Array.isArray(q.complianceFloors) ? q.complianceFloors.map(toClass) : q.complianceFloors,
    autonomyFloor: has(q, "autonomyFloor") ? toClass(q.autonomyFloor) : undefined,
    agentAssurance: q.agentAssurance,
    configuredProfileFloor: has(q, "ownProfileFloor") ? toClass(q.ownProfileFloor) : undefined,
    parentRequiredClass: has(q, "parentRequiredClass") ? toClass(q.parentRequiredClass) : undefined,
  };
  // a named lookup that did not resolve (owner decision B's vector)
  const lookup = q.unresolvedPolicyLookup;
  if (lookup === "ownProfileFloor") f.configuredProfileFloor = undefined;
  else if (typeof lookup === "string") (f as unknown as Record<string, unknown>)[lookup] = undefined;
  return f;
}

/** the vector checker's fact names for the product's */
const VECTOR_FACT: Record<string, string> = { configuredProfileFloor: "ownProfileFloor" };

describe("ADR-0190 placement vectors I2 owns, against the product", () => {
  const requirementVectors = corpus.vectors.filter(
    (v) =>
      v.semanticRequest.operation === undefined &&
      (v.expectedProjection.requiredClass !== undefined || v.expectedProjection.reason === "policy_unresolved"),
  );

  it("covers the families I2 owns", () => {
    const ids = requirementVectors.map((v) => v.id);
    for (const prefix of ["floor-", "compliance-", "autonomyFloor-", "ownProfileFloor-", "parentRequiredClass-", "assurance-", "unknown-", "refusal-policy_unresolved"])
      expect(ids.some((id) => id.startsWith(prefix)), prefix).toBe(true);
    expect(requirementVectors.length).toBeGreaterThanOrEqual(60);
  });

  it.each(requirementVectors.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const r = computeRequiredClass(factsOf(v.semanticRequest));
    const e = v.expectedProjection;
    if (e.reason === "policy_unresolved") {
      expect(r.ok, JSON.stringify(r)).toBe(false);
      if (!r.ok) {
        // the product names the same fact the vector made unresolvable
        const lookup = v.semanticRequest.unresolvedPolicyLookup;
        if (typeof lookup === "string") expect(VECTOR_FACT[r.unresolved] ?? r.unresolved).toBe(lookup);
      }
      expect(executionProfileUnavailable("policy_unresolved")).toMatchObject({ statusCode: e.httpStatus, error: e.error, ruleId: e.ruleId, reason: e.reason });
    } else {
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (r.ok) expect(r.requiredClass).toBe(toClass(e.requiredClass));
    }
  });

  const delegation = corpus.vectors.filter((v) => v.semanticRequest.operation === "grant_creation");
  it.each(delegation.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const q = v.semanticRequest;
    const parent = (toClass(q.parentRequiredClass) ?? null) as RequirableIsolationClass | null;
    const child = (toClass(q.childRequestedClass) ?? null) as RequirableIsolationClass | null;
    const refused = delegationIsolationViolation(parent, child);
    expect(refused).toBe(v.expectedProjection.outcome === "refuse");
    if (refused) expect(v.expectedProjection.ruleId).toBe(DELEGATION_ISOLATION_RULE_ID);
  });

  const liveChain = corpus.vectors.filter((v) => v.semanticRequest.operation === "live_chain_use");
  it("includes vectors that exercise the attested class against the placement's and the grant's class (review M1)", () => {
    expect(liveChain.filter((v) => (v.semanticRequest.actorPlacements as Array<{ attestedClass?: string }>).some((p) => p.attestedClass)).length).toBeGreaterThanOrEqual(3);
  });
  it.each(liveChain.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const placements = v.semanticRequest.actorPlacements as Array<{
      executorActive: boolean;
      executorQuarantined: boolean;
      attestation: string;
      grantClass?: string;
      placementRequiredClass?: string;
      attestedClass?: string;
    }>;
    const failures = placements.map((p) => {
      // where the vector states the classes, the product decides whether the attestation still satisfies
      const satisfies =
        p.attestedClass === undefined
          ? true
          : isolationClassSatisfies(
              toClass(p.attestedClass) as RequirableIsolationClass,
              livePlacementRequiredClass((toClass(p.grantClass) ?? null) as RequirableIsolationClass | null, toClass(p.placementRequiredClass) as RequirableIsolationClass),
            );
      return livePlacementFailure({
        executorStatus: p.executorQuarantined ? "quarantined" : p.executorActive ? "active" : "revoked",
        attestationFresh: p.attestation === "fresh_passing",
        attestedClassSatisfies: satisfies,
      });
    });
    const failure = failures.find((f) => f !== null) ?? null;
    expect(failure !== null).toBe(v.expectedProjection.outcome === "refuse");
    if (v.expectedProjection.liveFailure !== undefined) expect(failure).toBe(v.expectedProjection.liveFailure);
  });

  const nonIsolable = corpus.vectors.filter((v) => v.id.startsWith("non-isolable-"));
  it.each(nonIsolable.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const kind = v.semanticRequest.workloadKind as keyof typeof NON_ISOLABLE_EXECUTION;
    // the vectors say L0 for the gateway's own code; the product records it as `in_gateway` (decision 9)
    const where = v.expectedProjection.executionLocation === "L0" ? "in_gateway" : v.expectedProjection.executionLocation;
    expect(NON_ISOLABLE_EXECUTION[kind]).toBe(where);
    expect(v.expectedProjection.isolated ?? false).toBe(false);
  });
});
