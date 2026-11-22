/**
 * ADR-0364 S3 — THE robot_browser WORKLOAD KIND under ADR-0190 (pure):
 *  - the kind is isolable, its floor is the org's `isolationFloorRobotBrowser` (strict L2, relaxable to L1 only, never
 *    unresolved-as-allowed), and its one shipped profile is `robot-browser`, whatever the agent's assurance;
 *  - the profile: robot_browser only, a per-run egress proxy (`egress_proxy`, no static hosts), read-only root, a tmpfs
 *    work directory, task-scoped secrets, no persistence, a wall clock above the 5-minute run limit;
 *  - `egress_proxy` belongs to robot_browser alone, ranks loosest, and runs gVisor's netstack (`--network=sandbox`);
 *  - an offer carries `egress` exactly when it is a robot_browser offer, and the ACL is generated from its targets.
 */
import { describe, expect, it } from "vitest";
import { ROBOT_EGRESS_DENY_RANGES, ROBOT_RUN_LIMITS, robotEgressTargets, smokescreenAcl, smokescreenAclForTargets } from "../robots-run.js";
import { executorEndSchema, executionOfferSchema } from "./channel.js";
import {
  ISOLABLE_WORKLOAD_KINDS,
  WORKLOAD_KINDS,
  executionProfileBodySchema,
  executionProfileRelaxations,
  runscFlags,
  type ExecutionProfileBody,
} from "./contract.js";
import { computeRequiredClass, defaultProfileFor, workloadKindFloor, type RequirementFacts } from "./placement.js";
import { RESTRICTED_EXECUTION_PROFILE, SHIPPED_EXECUTION_PROFILES, robotBrowserProfileProblem } from "./profiles.js";
import { ISOLATION_FLOOR_KEYS, ISOLATION_SETTING_COLUMNS, ISOLATION_STRICT_DEFAULTS, isolationOrgSettingsFields, isolationSettingRelaxed } from "./settings.js";

const ROBOT = SHIPPED_EXECUTION_PROFILES["robot-browser"];
const clone = (b: ExecutionProfileBody, mutate: (x: ExecutionProfileBody) => void): ExecutionProfileBody => {
  const x = structuredClone(b) as ExecutionProfileBody;
  mutate(x);
  return x;
};

describe("the kind and its floor", () => {
  it("robot_browser is a workload kind an executor places in a sandbox", () => {
    expect(WORKLOAD_KINDS).toContain("robot_browser");
    expect(ISOLABLE_WORKLOAD_KINDS).toContain("robot_browser");
  });

  it("the floor is the org setting, strict L2; L1 is a relaxation; there is no L0 value", () => {
    expect(ISOLATION_STRICT_DEFAULTS.isolationFloorRobotBrowser).toBe("user_space_kernel");
    expect(ISOLATION_FLOOR_KEYS).toContain("isolationFloorRobotBrowser");
    expect(ISOLATION_SETTING_COLUMNS.isolationFloorRobotBrowser).toBe("isolation_floor_robot_browser");
    expect(isolationSettingRelaxed("isolationFloorRobotBrowser", "hardened_container")).toBe(true);
    expect(isolationSettingRelaxed("isolationFloorRobotBrowser", "microvm")).toBe(false);
    const field = isolationOrgSettingsFields.isolationFloorRobotBrowser;
    expect(field.safeParse("hardened_container").success).toBe(true);
    expect(field.safeParse("in_gateway").success).toBe(false);
    const settings = { isolationFloorMcpStdio: "user_space_kernel", isolationFloorEngineWorker: "user_space_kernel" };
    expect(workloadKindFloor("robot_browser", "public", { ...settings, isolationFloorRobotBrowser: "hardened_container" })).toBe("hardened_container");
    // a floor that was never read does not resolve: the requirement refuses rather than defaulting
    expect(workloadKindFloor("robot_browser", "public", settings)).toBeUndefined();
  });

  it("a requirement with an unread robot floor is unresolved; with it, the MAX of the floors", () => {
    const facts: RequirementFacts = {
      workloadKind: "robot_browser",
      sensitivity: "internal",
      sensitivityFloor: "user_space_kernel",
      workloadKindFloor: undefined,
      complianceFloors: [],
      autonomyFloor: "hardened_container",
      agentAssurance: "known",
      configuredProfileFloor: "user_space_kernel",
      parentRequiredClass: null,
    };
    expect(computeRequiredClass(facts)).toEqual({ ok: false, unresolved: "workloadKindFloor" });
    const r = computeRequiredClass({ ...facts, workloadKindFloor: "user_space_kernel" });
    expect(r.ok && r.requiredClass).toBe("user_space_kernel");
    // an unknown agent still raises a robot run to L3 (the profile stays robot-browser)
    const u = computeRequiredClass({ ...facts, workloadKindFloor: "user_space_kernel", agentAssurance: "unknown" });
    expect(u.ok && u.requiredClass).toBe("microvm");
  });

  it("a robot run is always placed under robot-browser, whatever the assurance", () => {
    expect(defaultProfileFor("robot_browser", "known")).toBe("robot-browser");
    expect(defaultProfileFor("robot_browser", "unknown")).toBe("robot-browser");
    expect(defaultProfileFor("robot_browser", "no_identity")).toBe("robot-browser");
    expect(defaultProfileFor("mcp_stdio", "unknown")).toBe("restricted-microvm");
  });
});

describe("the robot-browser profile", () => {
  it("is robot_browser only, L2, read-only root, a tmpfs work dir, a per-run egress proxy, task-scoped secrets, nothing persisted", () => {
    expect(ROBOT.workloadKinds).toEqual(["robot_browser"]);
    expect(ROBOT.minClass).toBe("user_space_kernel");
    expect(ROBOT.filesystem.rootReadOnly).toBe(true);
    expect(ROBOT.filesystem.workDir.path).toBe("/work");
    expect(ROBOT.filesystem.inputs).toEqual([]);
    expect(ROBOT.network).toEqual({ mode: "egress_proxy" });
    expect(ROBOT.secrets).toBe("task_scoped");
    expect(ROBOT.persistence).toBe("none");
    expect(ROBOT.process.uid).toBeGreaterThan(0);
    expect(ROBOT.process.capabilities).toEqual([]);
    // the run's own wall clock (5 minutes) plus a margin for start-up and evidence
    expect(ROBOT.resources.wallClockSecondsPerCall).toBeGreaterThan(ROBOT_RUN_LIMITS.wallClockMs / 1000);
    expect(ROBOT.resources.wallClockSecondsPerSession).toBe(ROBOT.resources.wallClockSecondsPerCall);
    expect(ROBOT.resources.outputBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
    expect(robotBrowserProfileProblem(ROBOT)).toBeNull();
  });

  it("names its accepted differences from restricted as relaxations (the egress proxy among them)", () => {
    expect(executionProfileRelaxations(ROBOT, RESTRICTED_EXECUTION_PROFILE)).toEqual([
      "workloadKinds",
      "filesystem.workDir",
      "network",
      "process.pids",
      "resources",
      "secrets",
    ]);
    // against itself (its own strict reference as a versionable shipped profile) nothing is looser; L1 is
    expect(executionProfileRelaxations(ROBOT, ROBOT)).toEqual([]);
    expect(executionProfileRelaxations(clone(ROBOT, (b) => (b.minClass = "hardened_container")), ROBOT)).toEqual(["minClass"]);
  });

  it("a version must keep the robot shape", () => {
    expect(robotBrowserProfileProblem(clone(ROBOT, (b) => (b.name = "other")))).toMatch(/another profile/);
    expect(robotBrowserProfileProblem(clone(ROBOT, (b) => (b.minClass = "hardened_container")))).toBeNull();
  });

  it("runs gVisor's own netstack on its internal network; every other profile keeps --network=none", () => {
    expect(runscFlags(ROBOT)).toContain("--network=sandbox");
    expect(runscFlags(ROBOT)).not.toContain("--network=none");
    expect(runscFlags(RESTRICTED_EXECUTION_PROFILE)).toContain("--network=none");
  });
});

describe("egress_proxy belongs to robot_browser alone", () => {
  it("a robot profile must use egress_proxy and run nothing else", () => {
    expect(executionProfileBodySchema.safeParse(clone(ROBOT, (b) => (b.network = { mode: "gateway_only" }))).success).toBe(false);
    expect(executionProfileBodySchema.safeParse(clone(ROBOT, (b) => (b.workloadKinds = ["robot_browser", "mcp_stdio"]))).success).toBe(false);
  });
  it("no other kind may have an egress proxy", () => {
    expect(executionProfileBodySchema.safeParse(clone(RESTRICTED_EXECUTION_PROFILE, (b) => (b.network = { mode: "egress_proxy" }))).success).toBe(false);
    expect(executionProfileBodySchema.safeParse(clone(RESTRICTED_EXECUTION_PROFILE, (b) => (b.workloadKinds = ["robot_browser"]))).success).toBe(false);
  });
  it("moving to egress_proxy from anything is a network relaxation", () => {
    const allowList = clone(RESTRICTED_EXECUTION_PROFILE, (b) => (b.network = { mode: "allow_list", entries: [{ host: "a.example", port: 443 }] }));
    expect(executionProfileRelaxations(ROBOT, clone(ROBOT, (b) => Object.assign(b, { network: allowList.network })))).toContain("network");
  });
});

describe("the offer's per-run egress", () => {
  const base = {
    id: "00000000-0000-4000-8000-000000000001",
    requiredClass: "user_space_kernel",
    requiredBy: "workload_kind",
    enforcement: "enforce",
    profileDigest: "a".repeat(64),
    imageDigest: `sha256:${"b".repeat(64)}`,
    expiresAt: "2026-11-19T12:00:00.000Z",
  } as const;
  const runId = "00000000-0000-4000-8000-0000000000aa";
  const egress = { runId, targets: [{ host: "portal.example.com", port: 443 }, { host: "files.example.com", port: 8443 }] };

  it("is required on a robot_browser offer", () => {
    expect(executionOfferSchema.safeParse({ ...base, workloadKind: "robot_browser", egress }).success).toBe(true);
    expect(executionOfferSchema.safeParse({ ...base, workloadKind: "robot_browser" }).success).toBe(false);
    // the run id is part of it: a uuid, never absent
    expect(executionOfferSchema.safeParse({ ...base, workloadKind: "robot_browser", egress: { targets: egress.targets } }).success).toBe(false);
    expect(executionOfferSchema.safeParse({ ...base, workloadKind: "robot_browser", egress: { ...egress, runId: "run-1" } }).success).toBe(false);
  });
  it("is refused on every other kind", () => {
    for (const k of ISOLABLE_WORKLOAD_KINDS.filter((x) => x !== "robot_browser")) {
      expect(executionOfferSchema.safeParse({ ...base, workloadKind: k, egress }).success, k).toBe(false);
      expect(executionOfferSchema.safeParse({ ...base, workloadKind: k }).success, k).toBe(true);
    }
  });
  it("targets are DNS names and ports only: no IP literal, wildcard, upper case, empty list or duplicate", () => {
    const bad = [
      [],
      [{ host: "10.0.0.1", port: 443 }],
      [{ host: "169.254.169.254", port: 80 }],
      [{ host: "*.example.com", port: 443 }],
      [{ host: "Portal.example.com", port: 443 }],
      [{ host: "localhost", port: 443 }],
      [{ host: "a.example.com", port: 0 }],
      [{ host: "a.example.com", port: 443 }, { host: "a.example.com", port: 443 }],
      [{ host: "a.example.com\n  - evil.example", port: 443 }],
    ];
    for (const targets of bad) expect(executionOfferSchema.safeParse({ ...base, workloadKind: "robot_browser", egress: { runId, targets } }).success, JSON.stringify(targets)).toBe(false);
  });
  it("the ACL is generated from the targets, the same as from the version's origins", () => {
    const origins = ["https://portal.example.com", "https://files.example.com:8443"];
    expect(robotEgressTargets(origins)).toEqual([...egress.targets].sort((a, b) => (a.host < b.host ? -1 : 1)));
    expect(smokescreenAclForTargets(egress.targets)).toBe(smokescreenAcl(origins));
    expect(smokescreenAclForTargets(egress.targets)).toContain("action: enforce");
    expect(() => smokescreenAclForTargets([{ host: "10.0.0.1", port: 443 }])).toThrow();
    expect(ROBOT_EGRESS_DENY_RANGES).toContain("169.254.169.254/32");
  });
  it("an end may carry the run's egress log (bounded)", () => {
    expect(executorEndSchema.safeParse({ outcome: "completed", egressLog: "CANONICAL-PROXY-DECISION ..." }).success).toBe(true);
    expect(executorEndSchema.safeParse({ outcome: "completed", egressLog: "x".repeat(256 * 1024 + 1) }).success).toBe(false);
  });
});
