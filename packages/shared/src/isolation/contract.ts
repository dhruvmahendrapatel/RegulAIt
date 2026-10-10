/**
 * ADR-0190 (batch 6 item 3) — isolation and execution profiles (PF-06): the
 * shared contract. Slice I1 (foundation): vocabularies, the
 * `regulait.execution-profile.v1` body, its digest, the relaxation comparator
 * against the shipped `restricted` profile, and the route list (every route a
 * 501 stub until its slice lands).
 *
 * What is ours here (ADR-0176 §4): which isolation a call REQUIRES, the profile
 * semantics, the evidence format. The isolation itself is always a third-party
 * runtime (gVisor `runsc` for L2, Kata for L3).
 *
 * Vocabulary rule (decision 1, ENTERPRISE_READINESS_PLAN §3): L0 and L1 are
 * never called a sandbox. L1 is a "hardened container".
 */
import { z } from "zod";
import canonicalize from "canonicalize";
import { sha256Hex } from "../audit-chain.js";

export const EXECUTION_PROFILE_SCHEMA = "regulait.execution-profile.v1" as const;

// ---------------------------------------------------------------------------
// Decision 1: isolation classes, a fixed, ordered vocabulary
// ---------------------------------------------------------------------------

/** the ordered classes (index = rank). `in_gateway` is not isolation. */
export const ISOLATION_CLASSES = ["in_gateway", "hardened_container", "user_space_kernel", "microvm"] as const;
export type IsolationClass = (typeof ISOLATION_CLASSES)[number];

/** the classes a profile, a floor or a placement may require (L1 to L3; never L0) */
export const REQUIRABLE_ISOLATION_CLASSES = ["hardened_container", "user_space_kernel", "microvm"] as const;
export type RequirableIsolationClass = (typeof REQUIRABLE_ISOLATION_CLASSES)[number];

/** the short labels the ADR uses */
export const ISOLATION_CLASS_LABELS: Readonly<Record<IsolationClass, string>> = {
  in_gateway: "L0",
  hardened_container: "L1",
  user_space_kernel: "L2",
  microvm: "L3",
};

/** classes compare by order only; there is no score */
export function isolationClassRank(c: IsolationClass): number {
  return ISOLATION_CLASSES.indexOf(c);
}

/** does a backend attesting `provided` satisfy a requirement of `required`? (a class is a floor) */
export function isolationClassSatisfies(provided: IsolationClass, required: IsolationClass): boolean {
  return isolationClassRank(provided) >= isolationClassRank(required);
}

/** the stricter of two classes */
export function maxIsolationClass<C extends IsolationClass>(a: C, b: C): C {
  return isolationClassRank(a) >= isolationClassRank(b) ? a : b;
}

/**
 * What a placement records as its applied isolation. `customer_declared` is a
 * BYOC plane's own, unverified claim (decision 1): it satisfies a class only
 * where an admin mapped that plane to it (decision 7, OWNER DECISION 6).
 */
export const APPLIED_ISOLATION_KINDS = [...REQUIRABLE_ISOLATION_CLASSES, "customer_declared"] as const;
export type AppliedIsolationKind = (typeof APPLIED_ISOLATION_KINDS)[number];

// ---------------------------------------------------------------------------
// Decision 3: workload kinds
// ---------------------------------------------------------------------------

export const WORKLOAD_KINDS = [
  "model_call",
  "connector_call",
  "remote_mcp",
  "mcp_stdio",
  "code_exec",
  "engine_worker",
  "byoc_worker",
] as const;
export type WorkloadKind = (typeof WORKLOAD_KINDS)[number];

/** the kinds an executor places in a sandbox; the others run at L0 or on a third party's host */
export const ISOLABLE_WORKLOAD_KINDS = ["mcp_stdio", "code_exec", "engine_worker", "byoc_worker"] as const;
export type IsolableWorkloadKind = (typeof ISOLABLE_WORKLOAD_KINDS)[number];

/** what a non-isolable kind records instead of a class (decision 9) */
export const NON_ISOLABLE_EXECUTION: Readonly<Record<Exclude<WorkloadKind, IsolableWorkloadKind>, "in_gateway" | "external">> = {
  model_call: "in_gateway",
  connector_call: "in_gateway",
  remote_mcp: "external",
};

// ---------------------------------------------------------------------------
// Decisions 6, 7 and 14: backends, executor states, refusal reasons, floors
// ---------------------------------------------------------------------------

export const EXECUTOR_BACKENDS = ["runc", "gvisor", "kata", "openshell", "customer"] as const;
export type ExecutorBackend = (typeof EXECUTOR_BACKENDS)[number];

/** the classes each backend may attest (decision 1 with amendment F: OpenShell never attests L2) */
export const BACKEND_ATTESTABLE_CLASSES: Readonly<Record<ExecutorBackend, readonly AppliedIsolationKind[]>> = {
  runc: ["hardened_container"],
  gvisor: ["hardened_container", "user_space_kernel"],
  kata: ["hardened_container", "microvm"],
  openshell: ["hardened_container", "microvm"],
  customer: ["customer_declared"],
};

export const EXECUTOR_STATUSES = ["active", "quarantined", "revoked"] as const;
export type ExecutorStatus = (typeof EXECUTOR_STATUSES)[number];

/** why an executor was quarantined (a fixed vocabulary, never free prose) */
export const EXECUTOR_QUARANTINE_CODES = ["execution_profile_mismatch", "attestation_failed", "admin"] as const;
export type ExecutorQuarantineCode = (typeof EXECUTOR_QUARANTINE_CODES)[number];

export const ATTESTATION_VERDICTS = ["pass", "fail"] as const;

/** decision 7: `409 execution_profile_unavailable` reasons. There is no fallback to a lower class. */
export const EXECUTION_REFUSAL_REASONS = [
  "no_executor",
  "attestation_stale",
  "class_below_required",
  "executor_quarantined",
  "profile_retired",
] as const;
export type ExecutionRefusalReason = (typeof EXECUTION_REFUSAL_REASONS)[number];

/** the floor that set a required class (decision 7, items 1–6) */
export const REQUIRED_CLASS_SOURCES = [
  "workload_kind",
  "data_sensitivity",
  "compliance_tag",
  "autonomy_class",
  "configured_profile",
  "unknown_agent",
  "parent_grant",
] as const;
export type RequiredClassSource = (typeof REQUIRED_CLASS_SOURCES)[number];

export const PLACEMENT_OUTCOMES = ["placed", "refused", "mismatch"] as const;
export type PlacementOutcome = (typeof PLACEMENT_OUTCOMES)[number];

/** the kernel rule ids decision 7 and 8 add */
export const EXECUTION_PROFILE_RULE_ID = "execution-profile" as const;
export const DELEGATION_ISOLATION_RULE_ID = "delegation-isolation" as const;

/** decision 13: the audit actions (written by later slices; named here so the vocabulary is one list) */
export const ISOLATION_AUDIT_ACTIONS = [
  "execution-profile-created",
  "execution-profile-versioned",
  "execution-profile-retired",
  "execution-profile-relaxed",
  "executor-registered",
  // I3: the executor's own announce over its channel (what it is, what runtime it runs)
  "executor-announced",
  "executor-revoked",
  "executor-declared-class-set",
  "executor-attestation-passed",
  "executor-attestation-failed",
  "executor-quarantined",
  "executor-reenabled",
  "execution-placed",
  "execution-refused",
  "execution-profile-mismatch",
] as const;

// ---------------------------------------------------------------------------
// Decision 6 with amendment D: the probes
// ---------------------------------------------------------------------------

/**
 * The probe set. `in_sandbox` probes are reported from inside the sandbox;
 * `executor_side` ones only the executor can see (host cgroup counters). The
 * in-sandbox CPU count is derived from the quota and proves nothing, so it is
 * not a probe.
 */
export const ATTESTATION_PROBES = {
  /** gVisor's kernel version / boot message; a microVM's hypervisor flag and a guest kernel distinct from the host's */
  runtime_identity: "in_sandbox",
  /** `/proc/self/status`: the profile's uid, `CapEff` zero, `NoNewPrivs` 1, `Seccomp` 2 */
  proc_status: "in_sandbox",
  /** a syscall the seccomp profile denies is refused (EPERM) */
  seccomp_enforced: "in_sandbox",
  /** EROFS on a root write, or `/` mounted `ro` in `/proc/self/mounts` (EACCES as non-root proves nothing) */
  root_read_only: "in_sandbox",
  /** a connection to a public literal address, with no resolver, fails */
  egress_literal_address: "in_sandbox",
  /** name resolution fails */
  egress_dns: "in_sandbox",
  /** no interface except loopback and the decision 4 channel */
  network_interfaces: "in_sandbox",
  /** no executor, runner or gateway credential in the environment, arguments or filesystem */
  no_executor_credentials: "in_sandbox",
  /** `MemTotal` equals the memory limit; `RLIMIT_NPROC` and `RLIMIT_NOFILE` are the profile's */
  visible_limits: "in_sandbox",
  /** host cgroup CPU quota, memory limit, `pids.max` and throttling counters */
  host_cgroup_limits: "executor_side",
  /** the runtime configuration the sandbox was started with (amendment A: the runsc flags) */
  runtime_config: "executor_side",
} as const;
export type AttestationProbe = keyof typeof ATTESTATION_PROBES;
export const ATTESTATION_PROBE_IDS = Object.keys(ATTESTATION_PROBES) as AttestationProbe[];

/** what the evidence always says about the attestation (decision 6, OWNER DECISION 5) */
export const ATTESTATION_STRENGTH = "software_attested" as const;

// ---------------------------------------------------------------------------
// Decision 2: the profile body
// ---------------------------------------------------------------------------

/** a profile name: lowercase, digits and hyphens */
export const EXECUTION_PROFILE_NAME_RE = /^[a-z][a-z0-9-]{1,62}$/;
/**
 * Each pattern below is linear: anchored, one character class per position, no nested or overlapping
 * quantifier. Paths and host names are split first and each piece is checked on its own (a regex over the
 * whole string with a repeated group backtracks exponentially, CodeQL js/redos), with a length cap checked
 * before any pattern runs.
 */
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const HOST_LABEL_RE = /^[a-z0-9-]+$/;
const IP_LITERAL_RE = /^\[[0-9a-f:.]+\]$/;
const SANDBOX_PATH_MAX = 256;

/** an absolute path inside the sandbox: `/seg[/seg…][/]`, no empty, `.` or `..` segment */
export function isSandboxPath(p: string): boolean {
  if (p.length < 2 || p.length > SANDBOX_PATH_MAX || p[0] !== "/") return false;
  const segments = p.slice(1).split("/");
  if (segments[segments.length - 1] === "") segments.pop(); // one trailing slash
  return (
    segments.length > 0 &&
    segments.every((seg) => seg !== "." && seg !== ".." && PATH_SEGMENT_RE.test(seg))
  );
}

/** an exact DNS name (lowercase labels of 1–63, no leading or trailing hyphen) or a bracketed IP literal; no wildcard */
export function isExactHost(h: string): boolean {
  if (h.length < 1 || h.length > 253) return false;
  if (h[0] === "[") return IP_LITERAL_RE.test(h);
  return h
    .split(".")
    .every((label) => label.length >= 1 && label.length <= 63 && HOST_LABEL_RE.test(label) && label[0] !== "-" && label[label.length - 1] !== "-");
}

const uniqueBy = <T>(key: (t: T) => string) => (a: T[]) => new Set(a.map(key)).size === a.length;
const posInt = (max: number) => z.number().int().min(1).max(max);

export const EXECUTION_PROFILE_LIMITS = {
  workDirMiB: { max: 65536 },
  inputs: { max: 16 },
  allowList: { max: 64 },
  uid: { min: 1, max: 2147483647 },
  workloadNproc: { max: 65536 },
  hostCgroupPidsMax: { max: 1048576 },
  /** amendment C: the host cgroup counts the Sentry's threads too, so it needs headroom above the workload limit */
  hostPidsHeadroom: 128,
  cpuMillis: { max: 256000 },
  memoryMiB: { max: 1048576 },
  wallClockSecondsPerCall: { max: 86400 },
  wallClockSecondsPerSession: { max: 604800 },
  outputBytes: { max: 1073741824 },
  attestationMaxAgeMinutes: { min: 1, max: 1440 },
} as const;

/** a mount path inside the sandbox, never a host path */
const sandboxPath = z.string().refine(isSandboxPath, {
  message: "an absolute sandbox path of at most 256 characters, with no empty, . or .. segment",
});

export const executionProfileInputSchema = z
  .object({
    /** what the input is (a job volume, a model artifact) */
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/),
    /** where it is mounted read-only */
    mountPath: sandboxPath,
  })
  .strict();

export const executionProfileNetworkSchema = z.discriminatedUnion("mode", [
  /** no interface but loopback */
  z.object({ mode: z.literal("none") }).strict(),
  /** only the executor's channel to the gateway (decision 4) */
  z.object({ mode: z.literal("gateway_only") }).strict(),
  /**
   * exact hosts and ports, carried over the channel to the trusted side, which
   * resolves DNS and checks each entry against the egress allow-list too
   */
  z
    .object({
      mode: z.literal("allow_list"),
      entries: z
        .array(z.object({ host: z.string().refine(isExactHost, { message: "an exact host name or IP literal" }), port: z.number().int().min(1).max(65535) }).strict())
        .min(1)
        .max(EXECUTION_PROFILE_LIMITS.allowList.max)
        .refine(uniqueBy((e) => `${e.host}:${e.port}`), { message: "duplicate allow-list entry" }),
    })
    .strict(),
]);
export type ExecutionProfileNetwork = z.infer<typeof executionProfileNetworkSchema>;

export const SECCOMP_PROFILE_TYPES = ["RuntimeDefault", "Localhost"] as const;
export const EXEC_POLICIES = ["image_only", "image_and_work_dir"] as const;
export const EXECUTION_SECRETS_MODES = ["none", "task_scoped", "injected_at_egress"] as const;
export const EXECUTION_PERSISTENCE_MODES = ["none", "scoped_volume"] as const;
/** runsc platforms admitted (`systrap` needs no KVM; `kvm` needs /dev/kvm) */
export const RUNSC_PLATFORMS = ["systrap", "kvm"] as const;

export const executionProfileBodySchema = z
  .object({
    schema: z.literal(EXECUTION_PROFILE_SCHEMA),
    name: z.string().regex(EXECUTION_PROFILE_NAME_RE),
    /** which isolable workload kinds it may run */
    workloadKinds: z
      .array(z.enum(ISOLABLE_WORKLOAD_KINDS))
      .min(1)
      .max(ISOLABLE_WORKLOAD_KINDS.length)
      .refine(uniqueBy(String), { message: "duplicate workload kind" }),
    /** the class floor (never L0) */
    minClass: z.enum(REQUIRABLE_ISOLATION_CLASSES),
    filesystem: z
      .object({
        /** an invariant: the root is read-only, from a digest-pinned image */
        rootReadOnly: z.literal(true),
        /** the one writable place: a tmpfs work directory with a size cap */
        workDir: z.object({ path: sandboxPath, tmpfsMiB: posInt(EXECUTION_PROFILE_LIMITS.workDirMiB.max) }).strict(),
        /** declared read-only inputs; there is no host-path field at all */
        inputs: z
          .array(executionProfileInputSchema)
          .max(EXECUTION_PROFILE_LIMITS.inputs.max)
          .refine(uniqueBy((i) => i.name), { message: "duplicate input name" })
          .refine(uniqueBy((i) => i.mountPath), { message: "duplicate input mount path" }),
      })
      .strict(),
    network: executionProfileNetworkSchema,
    process: z
      .object({
        /** non-root: an invariant */
        uid: z.number().int().min(EXECUTION_PROFILE_LIMITS.uid.min).max(EXECUTION_PROFILE_LIMITS.uid.max),
        /** no capabilities: an invariant */
        capabilities: z.array(z.never()).max(0),
        /** an invariant */
        noNewPrivileges: z.literal(true),
        seccomp: z.discriminatedUnion("type", [
          z.object({ type: z.literal("RuntimeDefault") }).strict(),
          z.object({ type: z.literal("Localhost"), profile: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/) }).strict(),
        ]),
        /**
         * amendment C: two limits. `workloadNproc` is the workload's
         * RLIMIT_NPROC (a clean EAGAIN); `hostCgroupPidsMax` is the host cgroup
         * `pids.max`, with headroom for the runtime's own threads.
         */
        pids: z
          .object({
            workloadNproc: posInt(EXECUTION_PROFILE_LIMITS.workloadNproc.max),
            hostCgroupPidsMax: posInt(EXECUTION_PROFILE_LIMITS.hostCgroupPidsMax.max),
          })
          .strict()
          .refine((p) => p.hostCgroupPidsMax >= p.workloadNproc + EXECUTION_PROFILE_LIMITS.hostPidsHeadroom, {
            message: `hostCgroupPidsMax must leave at least ${EXECUTION_PROFILE_LIMITS.hostPidsHeadroom} above workloadNproc for the runtime's own threads`,
          }),
        /** `image_only`: only files present in the pinned image may be executed */
        exec: z.enum(EXEC_POLICIES),
      })
      .strict(),
    resources: z
      .object({
        cpuMillis: posInt(EXECUTION_PROFILE_LIMITS.cpuMillis.max),
        memoryMiB: posInt(EXECUTION_PROFILE_LIMITS.memoryMiB.max),
        wallClockSecondsPerCall: posInt(EXECUTION_PROFILE_LIMITS.wallClockSecondsPerCall.max),
        wallClockSecondsPerSession: posInt(EXECUTION_PROFILE_LIMITS.wallClockSecondsPerSession.max),
        outputBytes: posInt(EXECUTION_PROFILE_LIMITS.outputBytes.max),
      })
      .strict()
      .refine((r) => r.wallClockSecondsPerSession >= r.wallClockSecondsPerCall, {
        message: "the per-session wall clock cannot be shorter than the per-call one",
      }),
    secrets: z.enum(EXECUTION_SECRETS_MODES),
    persistence: z.enum(EXECUTION_PERSISTENCE_MODES),
    /**
     * Amendments A and B: how the executor starts `runsc` when its backend is
     * gVisor. `ociSeccomp` and the two sidecar policies are fixed (without
     * `--oci-seccomp` runsc ignores the seccomp filter; without the STRICT /
     * ALWAYS sidecar policies a bare `runsc` falls back to embedded sidecars
     * that the release says stop working). `directfs: true` is an audited
     * relaxation (the Sentry then runs with weaker syscall filters).
     */
    runsc: z
      .object({
        ociSeccomp: z.literal(true),
        sidecarUsagePolicy: z.literal("STRICT"),
        sidecarReleaseEnforcementPolicy: z.literal("ALWAYS"),
        platform: z.enum(RUNSC_PLATFORMS),
        directfs: z.boolean(),
      })
      .strict(),
    attestation: z
      .object({
        /** the probes every report must carry (decision 6) */
        probes: z
          .array(z.enum(ATTESTATION_PROBE_IDS as [AttestationProbe, ...AttestationProbe[]]))
          .min(1)
          .max(ATTESTATION_PROBE_IDS.length)
          .refine(uniqueBy(String), { message: "duplicate probe" }),
        /** the executor self-test's freshness limit, in minutes */
        executorMaxAgeMinutes: z
          .number()
          .int()
          .min(EXECUTION_PROFILE_LIMITS.attestationMaxAgeMinutes.min)
          .max(EXECUTION_PROFILE_LIMITS.attestationMaxAgeMinutes.max),
        /** every sandbox start reports before the first byte of input: an invariant */
        perPlacement: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((b, ctx) => {
    // `injected_at_egress` needs a trusted side that adds the credential on approved requests: it has no meaning
    // without an allow-list (decision 5)
    if (b.secrets === "injected_at_egress" && b.network.mode !== "allow_list") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secrets"],
        message: "injected_at_egress needs network.mode allow_list (the credential is added only to allow-listed requests)",
      });
    }
    // an input mounted on the work directory would shadow the one writable place
    for (const [i, input] of b.filesystem.inputs.entries()) {
      const w = b.filesystem.workDir.path.replace(/\/$/, "");
      const m = input.mountPath.replace(/\/$/, "");
      if (m === w || m.startsWith(`${w}/`) || w.startsWith(`${m}/`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["filesystem", "inputs", i, "mountPath"],
          message: "an input cannot be mounted on or around the work directory",
        });
      }
    }
  });
export type ExecutionProfileBody = z.infer<typeof executionProfileBodySchema>;

/**
 * The canonical text of a body: RFC 8785 (JCS) through `canonicalize` 5.1.0,
 * as decision 2 says (admitted by ADR-0186's admission test, which pins it
 * byte-identical to `canonicalJson` for JSON of this shape).
 */
export function canonicalExecutionProfile(body: ExecutionProfileBody): string {
  const text = canonicalize(body);
  if (text === undefined) throw new TypeError("canonicalExecutionProfile: the body did not serialise");
  return text;
}

/** the profile digest every placement, report and fact names: SHA-256 of the canonical body, lowercase hex */
export function executionProfileDigest(body: ExecutionProfileBody): string {
  return sha256Hex(canonicalExecutionProfile(body));
}

/** the runsc flags the executor starts a sandbox with under this profile (amendments A and B) */
export function runscFlags(body: ExecutionProfileBody): string[] {
  return [
    "--oci-seccomp",
    // every mode starts with no network of the sandbox's own: the decision 4 channel is wired by the executor,
    // and allow-listed egress leaves through that channel to the trusted side
    "--network=none",
    `--sidecar-usage-policy=${body.runsc.sidecarUsagePolicy}`,
    `--sidecar-release-enforcement-policy=${body.runsc.sidecarReleaseEnforcementPolicy}`,
    `--platform=${body.runsc.platform}`,
    `--directfs=${body.runsc.directfs ? "true" : "false"}`,
  ];
}

// ---------------------------------------------------------------------------
// Relaxation (ADR-0180, decision 2's last paragraph)
// ---------------------------------------------------------------------------

/** the fields of a profile a relaxation is named by */
export const EXECUTION_PROFILE_RELAXABLE_FIELDS = [
  "workloadKinds",
  "minClass",
  "filesystem.workDir",
  "filesystem.inputs",
  "network",
  "process.seccomp",
  "process.pids",
  "process.exec",
  "resources",
  "secrets",
  "persistence",
  "runsc.directfs",
  "attestation.probes",
  "attestation.executorMaxAgeMinutes",
] as const;
export type ExecutionProfileRelaxableField = (typeof EXECUTION_PROFILE_RELAXABLE_FIELDS)[number];

const NETWORK_RANK: Record<ExecutionProfileNetwork["mode"], number> = { allow_list: 0, gateway_only: 1, none: 2 };
const SECRETS_RANK: Record<(typeof EXECUTION_SECRETS_MODES)[number], number> = { injected_at_egress: 0, task_scoped: 1, none: 2 };

function addsAny(next: readonly string[], base: readonly string[]): boolean {
  const before = new Set(base);
  return next.some((x) => !before.has(x));
}
function dropsAny(next: readonly string[], base: readonly string[]): boolean {
  const after = new Set(next);
  return base.some((x) => !after.has(x));
}
const networkEntries = (n: ExecutionProfileNetwork) => (n.mode === "allow_list" ? n.entries.map((e) => `${e.host}:${e.port}`) : []);

/**
 * Which fields of `next` are LOOSER than `base` (by default the shipped
 * `restricted` profile, the strict reference of decision 2; a new version is
 * also judged against the version it replaces, as ADR-0186 decision 26 does
 * for settings). Each named field needs the `settings_relax` step-up and is
 * audited as `execution-profile-relaxed`.
 *
 * A Localhost seccomp profile may well be stricter than RuntimeDefault, but
 * nothing here can tell, so a change of seccomp profile is treated as a
 * relaxation (audited) rather than assumed safe.
 */
export function executionProfileRelaxations(next: ExecutionProfileBody, base: ExecutionProfileBody): ExecutionProfileRelaxableField[] {
  const out: ExecutionProfileRelaxableField[] = [];
  if (addsAny(next.workloadKinds, base.workloadKinds)) out.push("workloadKinds");
  if (isolationClassRank(next.minClass) < isolationClassRank(base.minClass)) out.push("minClass");
  if (next.filesystem.workDir.tmpfsMiB > base.filesystem.workDir.tmpfsMiB || next.filesystem.workDir.path !== base.filesystem.workDir.path) {
    out.push("filesystem.workDir");
  }
  if (
    addsAny(
      next.filesystem.inputs.map((i) => `${i.name}@${i.mountPath}`),
      base.filesystem.inputs.map((i) => `${i.name}@${i.mountPath}`),
    )
  ) {
    out.push("filesystem.inputs");
  }
  if (NETWORK_RANK[next.network.mode] < NETWORK_RANK[base.network.mode] || addsAny(networkEntries(next.network), networkEntries(base.network))) {
    out.push("network");
  }
  if (JSON.stringify(next.process.seccomp) !== JSON.stringify(base.process.seccomp)) out.push("process.seccomp");
  if (
    next.process.pids.workloadNproc > base.process.pids.workloadNproc ||
    next.process.pids.hostCgroupPidsMax > base.process.pids.hostCgroupPidsMax
  ) {
    out.push("process.pids");
  }
  if (next.process.exec !== "image_only" && base.process.exec === "image_only") out.push("process.exec");
  const r = next.resources;
  const b = base.resources;
  if (
    r.cpuMillis > b.cpuMillis ||
    r.memoryMiB > b.memoryMiB ||
    r.wallClockSecondsPerCall > b.wallClockSecondsPerCall ||
    r.wallClockSecondsPerSession > b.wallClockSecondsPerSession ||
    r.outputBytes > b.outputBytes
  ) {
    out.push("resources");
  }
  if (SECRETS_RANK[next.secrets] < SECRETS_RANK[base.secrets]) out.push("secrets");
  if (next.persistence !== "none" && base.persistence === "none") out.push("persistence");
  if (next.runsc.directfs && !base.runsc.directfs) out.push("runsc.directfs");
  if (dropsAny(next.attestation.probes, base.attestation.probes)) out.push("attestation.probes");
  if (next.attestation.executorMaxAgeMinutes > base.attestation.executorMaxAgeMinutes) out.push("attestation.executorMaxAgeMinutes");
  return out;
}

// ---------------------------------------------------------------------------
// Request bodies of the admin routes (I1 stubs; their slices implement them)
// ---------------------------------------------------------------------------

/** POST /v1/execution-profiles and POST /v1/execution-profiles/:name/versions */
export const createExecutionProfileSchema = z.object({ body: executionProfileBodySchema }).strict();

/** POST /v1/executors: register an executor against an ADR-0188 `worker_runtime` identity */
export const registerExecutorSchema = z
  .object({
    workloadIdentityId: z.string().uuid(),
    name: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
    backend: z.enum(EXECUTOR_BACKENDS),
    runtimeVersion: z.string().min(1).max(128).regex(/^[A-Za-z0-9._+-]+$/),
    classesDeclared: z
      .array(z.enum(APPLIED_ISOLATION_KINDS))
      .min(1)
      .max(APPLIED_ISOLATION_KINDS.length)
      .refine(uniqueBy(String), { message: "duplicate class" }),
  })
  .strict()
  .superRefine((v, ctx) => {
    const allowed = BACKEND_ATTESTABLE_CLASSES[v.backend];
    for (const c of v.classesDeclared) {
      if (!allowed.includes(c)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["classesDeclared"], message: `${v.backend} cannot attest ${c}` });
      }
    }
  });

/** POST /v1/executors/:executorId/quarantine */
export const quarantineExecutorSchema = z.object({ code: z.literal("admin") }).strict();

/**
 * PUT /v1/executors/:executorId/declared-class — OWNER DECISION 6: a BYOC
 * plane's `customer_declared` isolation maps to NO class until an admin maps
 * it (audited, step-up); `null` unmaps it.
 */
export const setDeclaredClassSchema = z.object({ class: z.enum(REQUIRABLE_ISOLATION_CLASSES).nullable() }).strict();

// ---------------------------------------------------------------------------
// The routes (I1 registers every one as a 501 stub)
// ---------------------------------------------------------------------------

/** what every isolation route that is not built yet answers */
export const ISOLATION_NOT_BUILT = { error: "not_built" } as const;

/**
 * EVERY ADR-0190 admin route, and the slice that builds it. All are admin
 * routes. The executor's own channel (registration proof, the outbound
 * stream, self-test and per-placement reports) authenticates with ADR-0188
 * credentials and is designed by slice I3; it is not stubbed here.
 */
export const ISOLATION_ROUTES: ReadonlyArray<{ method: "GET" | "POST" | "PUT"; path: string; cls: "admin"; slice: string; built: boolean }> = [
  { method: "GET", path: "/v1/execution-profiles", cls: "admin", slice: "I2", built: false },
  { method: "POST", path: "/v1/execution-profiles", cls: "admin", slice: "I2", built: false },
  { method: "GET", path: "/v1/execution-profiles/:name", cls: "admin", slice: "I2", built: false },
  { method: "POST", path: "/v1/execution-profiles/:name/versions", cls: "admin", slice: "I2", built: false },
  { method: "POST", path: "/v1/execution-profiles/:name/retire", cls: "admin", slice: "I2", built: false },
  { method: "GET", path: "/v1/executors", cls: "admin", slice: "I3", built: true },
  { method: "POST", path: "/v1/executors", cls: "admin", slice: "I3", built: true },
  { method: "GET", path: "/v1/executors/:executorId", cls: "admin", slice: "I3", built: true },
  { method: "GET", path: "/v1/executors/:executorId/attestations", cls: "admin", slice: "I3", built: true },
  { method: "POST", path: "/v1/executors/:executorId/quarantine", cls: "admin", slice: "I3", built: true },
  { method: "POST", path: "/v1/executors/:executorId/reenable", cls: "admin", slice: "I3", built: true },
  { method: "POST", path: "/v1/executors/:executorId/revoke", cls: "admin", slice: "I3", built: true },
  { method: "PUT", path: "/v1/executors/:executorId/declared-class", cls: "admin", slice: "I3", built: true },
  { method: "GET", path: "/v1/execution-placements", cls: "admin", slice: "I2", built: false },
  { method: "GET", path: "/v1/execution-placements/:placementId", cls: "admin", slice: "I2", built: false },
];
