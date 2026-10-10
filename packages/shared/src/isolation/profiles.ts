/**
 * ADR-0190 decision 2 — the SHIPPED execution profiles. Migration 0183 seeds
 * each one as version 1 (canonical body and digest); the I1 suite checks the
 * seeded rows equal these bodies byte for byte.
 *
 *  - `restricted`: the strict reference every relaxation is judged against.
 *  - `restricted-microvm`: the same, at L3 (OWNER DECISION 3's regulated floor).
 *  - `engine-worker`: ADR-0187's worker posture as data (decision 10, OWNER
 *    DECISION 4: L2). It differs from `restricted` where the worker must: a
 *    read-only job input, a larger work directory and resources, and the run's
 *    virtual key (`task_scoped`, decision 5) for its model calls through the
 *    gateway. Each of those is named by `executionProfileRelaxations`.
 */
import {
  ATTESTATION_PROBE_IDS,
  EXECUTION_PROFILE_SCHEMA,
  executionProfileBodySchema,
  type ExecutionProfileBody,
} from "./contract.js";

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const RESTRICTED: ExecutionProfileBody = {
  schema: EXECUTION_PROFILE_SCHEMA,
  name: "restricted",
  workloadKinds: ["mcp_stdio", "code_exec", "engine_worker", "byoc_worker"],
  minClass: "user_space_kernel",
  filesystem: { rootReadOnly: true, workDir: { path: "/work", tmpfsMiB: 256 }, inputs: [] },
  network: { mode: "gateway_only" },
  process: {
    uid: 10001,
    capabilities: [],
    noNewPrivileges: true,
    seccomp: { type: "RuntimeDefault" },
    // amendment C: 128 is the workload's RLIMIT_NPROC; the host cgroup leaves headroom for the runtime (512 in I0)
    pids: { workloadNproc: 128, hostCgroupPidsMax: 512 },
    exec: "image_only",
  },
  resources: {
    cpuMillis: 1000,
    memoryMiB: 1024,
    wallClockSecondsPerCall: 300,
    wallClockSecondsPerSession: 1800,
    outputBytes: 16 * 1024 * 1024,
  },
  secrets: "none",
  persistence: "none",
  runsc: {
    ociSeccomp: true,
    sidecarUsagePolicy: "STRICT",
    sidecarReleaseEnforcementPolicy: "ALWAYS",
    platform: "systrap",
    directfs: false,
  },
  attestation: { probes: [...ATTESTATION_PROBE_IDS], executorMaxAgeMinutes: 120, perPlacement: true },
};

const RESTRICTED_MICROVM: ExecutionProfileBody = {
  ...structuredClone(RESTRICTED),
  name: "restricted-microvm",
  minClass: "microvm",
};

const ENGINE_WORKER: ExecutionProfileBody = {
  ...structuredClone(RESTRICTED),
  name: "engine-worker",
  workloadKinds: ["engine_worker"],
  filesystem: {
    rootReadOnly: true,
    workDir: { path: "/work", tmpfsMiB: 1024 },
    inputs: [{ name: "jobs", mountPath: "/jobs" }],
  },
  process: {
    ...structuredClone(RESTRICTED.process),
    pids: { workloadNproc: 256, hostCgroupPidsMax: 768 },
  },
  resources: {
    cpuMillis: 2000,
    memoryMiB: 2048,
    // ADR-0187: the longest run is the engine timeout setting's strict default (30 minutes)
    wallClockSecondsPerCall: 1800,
    wallClockSecondsPerSession: 1800,
    outputBytes: 64 * 1024 * 1024,
  },
  secrets: "task_scoped",
};

/** the shipped profiles, by name (frozen; parse-checked at module load) */
export const SHIPPED_EXECUTION_PROFILES: Readonly<Record<"restricted" | "restricted-microvm" | "engine-worker", ExecutionProfileBody>> =
  deepFreeze({
    restricted: executionProfileBodySchema.parse(RESTRICTED),
    "restricted-microvm": executionProfileBodySchema.parse(RESTRICTED_MICROVM),
    "engine-worker": executionProfileBodySchema.parse(ENGINE_WORKER),
  });
export type ShippedExecutionProfileName = keyof typeof SHIPPED_EXECUTION_PROFILES;

/** the strict reference of decision 2 */
export const RESTRICTED_EXECUTION_PROFILE = SHIPPED_EXECUTION_PROFILES.restricted;

/** PF-06: an unknown or low-assurance agent starts in the most restrictive shipped profile */
export const MOST_RESTRICTIVE_EXECUTION_PROFILE: ShippedExecutionProfileName = "restricted-microvm";
