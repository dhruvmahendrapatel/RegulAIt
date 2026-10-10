/**
 * ADR-0190 I1 — the shared isolation contract: the class order, the
 * `regulait.execution-profile.v1` body (invariants refused, amendments A–C),
 * the shipped profiles, digests, the relaxation comparator, the strict org
 * settings and the route list.
 */
import { describe, expect, it } from "vitest";
import canonicalize from "canonicalize";
import { createHash } from "node:crypto";
import {
  ATTESTATION_PROBE_IDS,
  ATTESTATION_PROBES,
  BACKEND_ATTESTABLE_CLASSES,
  canonicalExecutionProfile,
  executionProfileBodySchema,
  executionProfileDigest,
  executionProfileRelaxations,
  EXECUTION_PROFILE_SCHEMA,
  ISOLATION_CLASSES,
  ISOLATION_ROUTES,
  ISOLATION_SETTING_COLUMNS,
  ISOLATION_SETTING_KEYS,
  ISOLATION_STRICT_DEFAULTS,
  isolationClassSatisfies,
  isolationSettingLooser,
  isolationSettingRelaxed,
  maxIsolationClass,
  MOST_RESTRICTIVE_EXECUTION_PROFILE,
  registerExecutorSchema,
  RESTRICTED_EXECUTION_PROFILE,
  runscFlags,
  SENSITIVITY_FLOOR_KEYS,
  setDeclaredClassSchema,
  SHIPPED_EXECUTION_PROFILES,
  type ExecutionProfileBody,
} from "./index.js";
import { AI_USE_CASE_DATA_SENSITIVITIES, updateOrgSettingsSchema } from "../index.js";
import { canonicalJson } from "../audit-chain.js";

/** a mutable deep copy of `restricted` with one change applied */
function variant(mutate: (b: ExecutionProfileBody) => void): ExecutionProfileBody {
  const b = structuredClone(RESTRICTED_EXECUTION_PROFILE) as ExecutionProfileBody;
  mutate(b);
  return b;
}
const parses = (b: unknown) => executionProfileBodySchema.safeParse(b).success;

describe("decision 1: isolation classes", () => {
  it("are ordered L0 < L1 < L2 < L3, compared by order only; a class is a floor", () => {
    expect(ISOLATION_CLASSES).toEqual(["in_gateway", "hardened_container", "user_space_kernel", "microvm"]);
    expect(isolationClassSatisfies("microvm", "user_space_kernel")).toBe(true);
    expect(isolationClassSatisfies("user_space_kernel", "microvm")).toBe(false);
    expect(isolationClassSatisfies("hardened_container", "hardened_container")).toBe(true);
    expect(maxIsolationClass("user_space_kernel", "hardened_container")).toBe("user_space_kernel");
  });

  it("OpenShell never attests L2 (amendment F); a customer plane attests only customer_declared", () => {
    expect(BACKEND_ATTESTABLE_CLASSES.openshell).not.toContain("user_space_kernel");
    expect(BACKEND_ATTESTABLE_CLASSES.gvisor).toContain("user_space_kernel");
    expect(BACKEND_ATTESTABLE_CLASSES.kata).toContain("microvm");
    expect(BACKEND_ATTESTABLE_CLASSES.customer).toEqual(["customer_declared"]);
    const base = { workloadIdentityId: "7b0b1c2e-0000-4000-8000-000000000001", name: "exec-a", runtimeVersion: "release-20261005.0" };
    expect(registerExecutorSchema.safeParse({ ...base, backend: "openshell", classesDeclared: ["user_space_kernel"] }).success).toBe(false);
    expect(registerExecutorSchema.safeParse({ ...base, backend: "runc", classesDeclared: ["microvm"] }).success).toBe(false);
    expect(registerExecutorSchema.safeParse({ ...base, backend: "gvisor", classesDeclared: ["user_space_kernel"] }).success).toBe(true);
    // the customer mapping takes a class or null (maps to nothing), never L0
    expect(setDeclaredClassSchema.safeParse({ class: null }).success).toBe(true);
    expect(setDeclaredClassSchema.safeParse({ class: "in_gateway" }).success).toBe(false);
  });
});

describe("decision 2: the shipped profiles", () => {
  it("restricted is the strict default of decision 2, with amendments A, B and C", () => {
    const r = RESTRICTED_EXECUTION_PROFILE;
    expect(r.schema).toBe(EXECUTION_PROFILE_SCHEMA);
    expect(r.minClass).toBe("user_space_kernel");
    expect(r.filesystem).toEqual({ rootReadOnly: true, workDir: { path: "/work", tmpfsMiB: 256 }, inputs: [] });
    expect(r.network).toEqual({ mode: "gateway_only" });
    expect(r.process).toMatchObject({ uid: 10001, capabilities: [], noNewPrivileges: true, seccomp: { type: "RuntimeDefault" }, exec: "image_only" });
    // C: 128 is RLIMIT_NPROC; the host cgroup has headroom for the runtime's threads
    expect(r.process.pids).toEqual({ workloadNproc: 128, hostCgroupPidsMax: 512 });
    expect(r.resources).toEqual({
      cpuMillis: 1000,
      memoryMiB: 1024,
      wallClockSecondsPerCall: 300,
      wallClockSecondsPerSession: 1800,
      outputBytes: 16 * 1024 * 1024,
    });
    expect(r.secrets).toBe("none");
    expect(r.persistence).toBe("none");
    // A and B
    expect(r.runsc).toEqual({
      ociSeccomp: true,
      sidecarUsagePolicy: "STRICT",
      sidecarReleaseEnforcementPolicy: "ALWAYS",
      platform: "systrap",
      directfs: false,
    });
    expect(runscFlags(r)).toEqual([
      "--oci-seccomp",
      "--network=none",
      "--sidecar-usage-policy=STRICT",
      "--sidecar-release-enforcement-policy=ALWAYS",
      "--platform=systrap",
      "--directfs=false",
    ]);
    expect(r.attestation).toEqual({ probes: ATTESTATION_PROBE_IDS, executorMaxAgeMinutes: 120, perPlacement: true });
  });

  it("every shipped profile validates, is frozen, and its digest is the SHA-256 of its RFC 8785 text", () => {
    expect(Object.keys(SHIPPED_EXECUTION_PROFILES).sort()).toEqual(["engine-worker", "restricted", "restricted-microvm"]);
    for (const [name, body] of Object.entries(SHIPPED_EXECUTION_PROFILES)) {
      expect(executionProfileBodySchema.parse(body), name).toEqual(body);
      expect(body.name).toBe(name);
      expect(Object.isFrozen(body) && Object.isFrozen(body.process.pids), name).toBe(true);
      const text = canonicalExecutionProfile(body);
      expect(text).toBe(canonicalize(body));
      // the same bytes as the audit chain's canonicaliser (ADR-0186 admission)
      expect(text).toBe(canonicalJson(body));
      expect(executionProfileDigest(body)).toBe(createHash("sha256").update(text, "utf8").digest("hex"));
    }
    const digests = new Set(Object.values(SHIPPED_EXECUTION_PROFILES).map(executionProfileDigest));
    expect(digests.size).toBe(3);
    // key order does not change the digest
    const reverseKeys = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverseKeys)
        : v && typeof v === "object"
          ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]))
          : v;
    const shuffled = reverseKeys(RESTRICTED_EXECUTION_PROFILE);
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(RESTRICTED_EXECUTION_PROFILE));
    expect(executionProfileDigest(executionProfileBodySchema.parse(shuffled))).toBe(executionProfileDigest(RESTRICTED_EXECUTION_PROFILE));
  });

  it("restricted-microvm differs only by L3; the most restrictive profile is it (PF-06)", () => {
    const m = SHIPPED_EXECUTION_PROFILES["restricted-microvm"];
    expect({ ...m, name: "restricted", minClass: "user_space_kernel" }).toEqual(RESTRICTED_EXECUTION_PROFILE);
    expect(MOST_RESTRICTIVE_EXECUTION_PROFILE).toBe("restricted-microvm");
    expect(executionProfileRelaxations(m, RESTRICTED_EXECUTION_PROFILE)).toEqual([]);
    expect(executionProfileRelaxations(RESTRICTED_EXECUTION_PROFILE, m)).toEqual(["minClass"]);
  });

  it("engine-worker is L2 (OWNER DECISION 4) and names exactly where it is looser than restricted", () => {
    const e = SHIPPED_EXECUTION_PROFILES["engine-worker"];
    expect(e.minClass).toBe("user_space_kernel");
    expect(e.workloadKinds).toEqual(["engine_worker"]);
    expect(e.network.mode).toBe("gateway_only");
    expect(executionProfileRelaxations(e, RESTRICTED_EXECUTION_PROFILE)).toEqual([
      "filesystem.workDir",
      "filesystem.inputs",
      "process.pids",
      "resources",
      "secrets",
    ]);
  });
});

describe("decision 2: the body refuses every invariant break", () => {
  const bad: Array<[string, (b: ExecutionProfileBody) => void]> = [
    ["L0 floor", (b) => ((b as { minClass: string }).minClass = "in_gateway")],
    ["customer_declared floor", (b) => ((b as { minClass: string }).minClass = "customer_declared")],
    ["a writable root", (b) => ((b.filesystem as { rootReadOnly: boolean }).rootReadOnly = false)],
    ["a host path field", (b) => ((b.filesystem as Record<string, unknown>).hostPaths = ["/var/run/docker.sock"])],
    ["a relative work dir", (b) => (b.filesystem.workDir.path = "work")],
    ["a .. segment", (b) => (b.filesystem.inputs = [{ name: "x", mountPath: "/in/../etc" }])],
    ["an input over the work dir", (b) => (b.filesystem.inputs = [{ name: "x", mountPath: "/work/in" }])],
    ["root uid", (b) => (b.process.uid = 0)],
    ["a capability", (b) => ((b.process as { capabilities: string[] }).capabilities = ["NET_ADMIN"])],
    ["new privileges", (b) => ((b.process as { noNewPrivileges: boolean }).noNewPrivileges = false)],
    ["seccomp unconfined", (b) => ((b.process as { seccomp: unknown }).seccomp = { type: "Unconfined" })],
    ["no host pids headroom (amendment C)", (b) => (b.process.pids = { workloadNproc: 128, hostCgroupPidsMax: 200 })],
    ["runsc without --oci-seccomp (amendment A)", (b) => ((b.runsc as { ociSeccomp: boolean }).ociSeccomp = false)],
    ["sidecar policy not STRICT (amendment A)", (b) => ((b.runsc as { sidecarUsagePolicy: string }).sidecarUsagePolicy = "LENIENT")],
    ["a platform we did not admit", (b) => ((b.runsc as { platform: string }).platform = "ptrace")],
    ["no per-placement report", (b) => ((b.attestation as { perPlacement: boolean }).perPlacement = false)],
    ["no probes", (b) => (b.attestation.probes = [])],
    ["an unknown probe", (b) => ((b.attestation as { probes: string[] }).probes = ["cpu_count"])],
    ["a wildcard host", (b) => (b.network = { mode: "allow_list", entries: [{ host: "*.example.com", port: 443 }] })],
    ["an empty allow-list", (b) => (b.network = { mode: "allow_list", entries: [] })],
    ["injected_at_egress without an allow-list", (b) => (b.secrets = "injected_at_egress")],
    ["a non-isolable workload kind", (b) => ((b as { workloadKinds: string[] }).workloadKinds = ["model_call"])],
    ["session shorter than a call", (b) => (b.resources.wallClockSecondsPerSession = 10)],
    ["an unknown field", (b) => ((b as Record<string, unknown>).privileged = true)],
    ["another schema", (b) => ((b as { schema: string }).schema = "regulait.execution-profile.v2")],
  ];
  it.each(bad)("refuses %s", (_label, mutate) => {
    // the unmodified body parses, so each refusal is the mutation's
    expect(parses(variant(() => undefined))).toBe(true);
    expect(parses(variant(mutate))).toBe(false);
  });

  it("the in-sandbox probes and the executor-side probes are split (amendment D)", () => {
    expect(ATTESTATION_PROBES.host_cgroup_limits).toBe("executor_side");
    expect(ATTESTATION_PROBES.root_read_only).toBe("in_sandbox");
    expect(ATTESTATION_PROBE_IDS).not.toContain("cpu_count");
  });
});

describe("relaxation against the strict reference", () => {
  const cases: Array<[string, (b: ExecutionProfileBody) => void]> = [
    ["minClass", (b) => (b.minClass = "hardened_container")],
    ["network", (b) => (b.network = { mode: "allow_list", entries: [{ host: "api.example.com", port: 443 }] })],
    ["secrets", (b) => (b.secrets = "task_scoped")],
    ["persistence", (b) => (b.persistence = "scoped_volume")],
    ["runsc.directfs", (b) => (b.runsc.directfs = true)],
    ["resources", (b) => (b.resources.memoryMiB = 2048)],
    ["process.pids", (b) => (b.process.pids = { workloadNproc: 256, hostCgroupPidsMax: 512 })],
    ["process.exec", (b) => (b.process.exec = "image_and_work_dir")],
    ["process.seccomp", (b) => (b.process.seccomp = { type: "Localhost", profile: "regulait-tight" })],
    ["attestation.probes", (b) => (b.attestation.probes = b.attestation.probes.filter((p) => p !== "egress_dns"))],
    ["attestation.executorMaxAgeMinutes", (b) => (b.attestation.executorMaxAgeMinutes = 240)],
    ["filesystem.workDir", (b) => (b.filesystem.workDir.tmpfsMiB = 512)],
  ];
  it.each(cases)("names %s, and only it", (field, mutate) => {
    const v = executionProfileBodySchema.parse(variant(mutate));
    expect(executionProfileRelaxations(v, RESTRICTED_EXECUTION_PROFILE)).toEqual([field]);
  });

  it("tightening names nothing; none to gateway_only to allow_list is looser at each step; a new allow-list host is looser", () => {
    const tighter = variant((b) => {
      b.minClass = "microvm";
      b.network = { mode: "none" };
      b.resources.memoryMiB = 512;
      b.process.pids = { workloadNproc: 64, hostCgroupPidsMax: 256 };
    });
    expect(executionProfileRelaxations(tighter, RESTRICTED_EXECUTION_PROFILE)).toEqual([]);
    expect(executionProfileRelaxations(RESTRICTED_EXECUTION_PROFILE, tighter)).toContain("network");
    const one = variant((b) => (b.network = { mode: "allow_list", entries: [{ host: "a.example.com", port: 443 }] }));
    const two = variant(
      (b) =>
        (b.network = {
          mode: "allow_list",
          entries: [
            { host: "a.example.com", port: 443 },
            { host: "b.example.com", port: 443 },
          ],
        }),
    );
    expect(executionProfileRelaxations(two, one)).toEqual(["network"]);
    expect(executionProfileRelaxations(one, two)).toEqual([]);
  });
});

describe("decision 11: the isolation org settings", () => {
  it("strict defaults: enforce, L2/L2/L2/L3 by sensitivity, L2 for stdio and engines, 120 minutes", () => {
    expect(ISOLATION_STRICT_DEFAULTS).toEqual({
      isolationEnforcement: "enforce",
      isolationFloorPublic: "user_space_kernel",
      isolationFloorInternal: "user_space_kernel",
      isolationFloorConfidential: "user_space_kernel",
      isolationFloorRegulated: "microvm",
      isolationFloorMcpStdio: "user_space_kernel",
      isolationFloorEngineWorker: "user_space_kernel",
      executorAttestationMaxAgeMinutes: 120,
    });
    expect(Object.keys(SENSITIVITY_FLOOR_KEYS).sort()).toEqual([...AI_USE_CASE_DATA_SENSITIVITIES].sort());
    expect(Object.keys(ISOLATION_SETTING_COLUMNS).sort()).toEqual([...ISOLATION_SETTING_KEYS].sort());
  });

  it("relaxed: warn, a lower floor, a longer lifetime; never relaxed: the defaults themselves or tightening", () => {
    expect(isolationSettingRelaxed("isolationEnforcement", "warn")).toBe(true);
    expect(isolationSettingRelaxed("isolationFloorRegulated", "user_space_kernel")).toBe(true);
    expect(isolationSettingRelaxed("isolationFloorPublic", "hardened_container")).toBe(true);
    expect(isolationSettingRelaxed("isolationFloorPublic", "microvm")).toBe(false);
    expect(isolationSettingRelaxed("executorAttestationMaxAgeMinutes", 121)).toBe(true);
    expect(isolationSettingRelaxed("executorAttestationMaxAgeMinutes", 60)).toBe(false);
    for (const k of ISOLATION_SETTING_KEYS) expect(isolationSettingRelaxed(k, ISOLATION_STRICT_DEFAULTS[k] as never), k).toBe(false);
    // against the stored value: a raised floor lowered back to the default is looser
    expect(isolationSettingLooser("isolationFloorPublic", "user_space_kernel", "microvm")).toBe(true);
    expect(isolationSettingLooser("isolationFloorPublic", "microvm", "user_space_kernel")).toBe(false);
    expect(isolationSettingLooser("executorAttestationMaxAgeMinutes", 120, 60)).toBe(true);
  });

  it("PUT /v1/org/settings accepts the isolation keys within bounds; never L0, never outside 60–1440", () => {
    expect(updateOrgSettingsSchema.safeParse({ isolationFloorPublic: "hardened_container" }).success).toBe(true);
    expect(updateOrgSettingsSchema.safeParse({ isolationEnforcement: "warn" }).success).toBe(true);
    for (const body of [
      { isolationFloorPublic: "in_gateway" },
      { isolationFloorMcpStdio: "customer_declared" },
      { isolationEnforcement: "off" },
      { executorAttestationMaxAgeMinutes: 59 },
      { executorAttestationMaxAgeMinutes: 1441 },
    ]) {
      expect(updateOrgSettingsSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });
});

describe("the routes", () => {
  it("every isolation route is an admin route under /v1, listed once", () => {
    const keys = ISOLATION_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of ISOLATION_ROUTES) {
      expect(r.cls).toBe("admin");
      expect(r.path.startsWith("/v1/")).toBe(true);
    }
  });
});
