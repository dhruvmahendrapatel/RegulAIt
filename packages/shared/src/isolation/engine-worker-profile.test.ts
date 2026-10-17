/**
 * ADR-0190 I5 follow-up — THE VERSIONABLE engine-worker PROFILE and the L1 refusal rules (pure):
 *  - only `engine-worker` among the shipped profiles may be versioned; `restricted` and `restricted-microvm` stay the
 *    strict references; custom profiles are versioned as before;
 *  - a version of engine-worker is judged against the SHIPPED engine-worker body (its strict reference): its accepted
 *    posture (the jobs input, task-scoped secret, larger resources) is not a relaxation, a lower minClass IS one
 *    (the gateway then needs a `settings_relax` step-up), and so is anything else looser;
 *  - a version must keep the engine shape (engine_worker only, the one jobs input at /jobs);
 *  - the strict default stays L2 (OWNER DECISION 4): the shipped body, the org floor, and an L1 attestation never
 *    meeting an L2 requirement.
 */
import { describe, expect, it } from "vitest";
import {
  BACKEND_ATTESTABLE_CLASSES,
  executionProfileRelaxations,
  isolationClassSatisfies,
  type ExecutionProfileBody,
} from "./contract.js";
import {
  engineWorkerProfileProblem,
  executionProfileReference,
  executionProfileVersionable,
  RESTRICTED_EXECUTION_PROFILE,
  SHIPPED_EXECUTION_PROFILES,
  VERSIONABLE_SHIPPED_EXECUTION_PROFILES,
} from "./profiles.js";
import { ISOLATION_STRICT_DEFAULTS } from "./settings.js";

const ENGINE = SHIPPED_EXECUTION_PROFILES["engine-worker"];
const version = (mutate: (b: ExecutionProfileBody) => void): ExecutionProfileBody => {
  const b = structuredClone(ENGINE) as ExecutionProfileBody;
  mutate(b);
  return b;
};

describe("which profiles are versioned", () => {
  it("engine-worker is versionable; the strict references are not; a custom name is", () => {
    expect(VERSIONABLE_SHIPPED_EXECUTION_PROFILES).toEqual(["engine-worker"]);
    expect(executionProfileVersionable("engine-worker")).toBe(true);
    expect(executionProfileVersionable("restricted")).toBe(false);
    expect(executionProfileVersionable("restricted-microvm")).toBe(false);
    expect(executionProfileVersionable("team-profile")).toBe(true);
    // a prototype key is not a shipped profile name
    expect(executionProfileVersionable("constructor")).toBe(true);
    expect(executionProfileReference("constructor")).toBe(RESTRICTED_EXECUTION_PROFILE);
  });

  it("an engine-worker version is judged against the shipped engine-worker body; anything else against restricted", () => {
    expect(executionProfileReference("engine-worker")).toBe(ENGINE);
    expect(executionProfileReference("team-profile")).toBe(RESTRICTED_EXECUTION_PROFILE);
    expect(executionProfileReference("restricted-microvm")).toBe(RESTRICTED_EXECUTION_PROFILE);
  });
});

describe("relaxations of an engine-worker version (each one a settings_relax step-up on the gateway)", () => {
  it("negative control: the shipped body is no relaxation against itself; against restricted it is (input, secrets, resources)", () => {
    expect(executionProfileRelaxations(ENGINE, executionProfileReference("engine-worker"))).toEqual([]);
    expect(executionProfileRelaxations(ENGINE, RESTRICTED_EXECUTION_PROFILE)).toEqual(expect.arrayContaining(["filesystem.inputs", "secrets", "resources"]));
  });

  it("L1 is a relaxation (minClass): the step-up path, never a silent change", () => {
    const l1 = version((b) => (b.minClass = "hardened_container"));
    expect(executionProfileRelaxations(l1, executionProfileReference("engine-worker"))).toEqual(["minClass"]);
  });

  it("a tightening version (L3, fewer resources) is no relaxation; looser resources are", () => {
    const tighter = version((b) => {
      b.minClass = "microvm";
      b.resources.memoryMiB = 1024;
    });
    expect(executionProfileRelaxations(tighter, executionProfileReference("engine-worker"))).toEqual([]);
    const looser = version((b) => (b.resources.memoryMiB = 8192));
    expect(executionProfileRelaxations(looser, executionProfileReference("engine-worker"))).toEqual(["resources"]);
  });
});

describe("an engine-worker version keeps the engine shape", () => {
  it("accepts the shipped body and a class change; refuses another kind, a missing or moved input, another name", () => {
    expect(engineWorkerProfileProblem(ENGINE)).toBeNull();
    expect(engineWorkerProfileProblem(version((b) => (b.minClass = "hardened_container")))).toBeNull();
    expect(engineWorkerProfileProblem(version((b) => (b.workloadKinds = ["engine_worker", "mcp_stdio"])))).toMatch(/exactly \[engine_worker\]/);
    expect(engineWorkerProfileProblem(version((b) => (b.filesystem.inputs = [])))).toMatch(/one jobs input at \/jobs/);
    expect(engineWorkerProfileProblem(version((b) => (b.filesystem.inputs = [{ name: "jobs", mountPath: "/data" }])))).toMatch(/one jobs input/);
    expect(engineWorkerProfileProblem(version((b) => (b.name = "engine-worker-2")))).toMatch(/another profile/);
  });
});

describe("the strict default stays L2 (OWNER DECISION 4)", () => {
  it("the shipped engine-worker body and the org floor are L2; runc attests L1 only, which never satisfies L2 or L3", () => {
    expect(ENGINE.minClass).toBe("user_space_kernel");
    expect(ISOLATION_STRICT_DEFAULTS.isolationFloorEngineWorker).toBe("user_space_kernel");
    expect(BACKEND_ATTESTABLE_CLASSES.runc).toEqual(["hardened_container"]);
    expect(isolationClassSatisfies("hardened_container", "user_space_kernel")).toBe(false);
    expect(isolationClassSatisfies("hardened_container", "microvm")).toBe(false);
    expect(isolationClassSatisfies("hardened_container", "hardened_container")).toBe(true);
  });
});
