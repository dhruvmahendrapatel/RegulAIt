/**
 * ADR-0190 decision 6 (with amendment D) — THE ATTESTATION REPORT and its
 * evaluation. Slice I3 (executor core).
 *
 * An executor produces one `regulait.executor-report.v1` document per probe
 * run: the executor SELF-TEST (a canary sandbox under the profile under test,
 * hourly, 2 h freshness) and the PER-PLACEMENT report (the workload's own
 * sandbox, before its first byte of input). The executor never judges its own
 * report: it reports what each probe OBSERVED, in a fixed vocabulary, and the
 * gateway evaluates the observations against the profile and the class the
 * report claims (`evaluateExecutorReport`). The same function runs on the
 * executor so a fake backend's lie is caught by the same rule the gateway
 * applies — and so a test can show the rule firing in both places.
 *
 * The report's identity is its canonical text (RFC 8785 through
 * `canonicalize`, as the profile body) and its SHA-256
 * (`executorReportDigest`), the value `executor_attestations.report_sha256`
 * and `execution_placements.report_sha256` carry. The executor signs the
 * canonical text with its ADR-0188 workload key as a DETACHED JWS (RFC 7797,
 * `b64: false`): the stored row keeps the body as JSON plus the signature, so
 * anyone holding the identity's public key can re-canonicalise and verify
 * later. Signing and verification live where the keys are (the executor
 * package and the gateway); this module holds the shape, the digest and the
 * rules.
 *
 * What the evidence always says (OWNER DECISION 5): `strength:
 * "software_attested"`. Both reports are produced by software on the same
 * host; a compromised host or executor can lie, and nothing here claims
 * otherwise.
 */
import { z } from "zod";
import canonicalize from "canonicalize";
import { sha256Hex } from "../audit-chain.js";
import {
  APPLIED_ISOLATION_KINDS,
  ATTESTATION_STRENGTH,
  BACKEND_ATTESTABLE_CLASSES,
  EXECUTOR_BACKENDS,
  isolationClassRank,
  runscFlags,
  type AppliedIsolationKind,
  type AttestationProbe,
  type ExecutionProfileBody,
  type ExecutorBackend,
  type RequirableIsolationClass,
} from "./contract.js";

export const EXECUTOR_REPORT_SCHEMA = "regulait.executor-report.v1" as const;
export const EXECUTOR_REPORT_KINDS = ["self_test", "placement"] as const;
export type ExecutorReportKind = (typeof EXECUTOR_REPORT_KINDS)[number];

/** the runtime a sandbox observes from inside (decision 6: how each class identifies itself) */
export const OBSERVED_RUNTIMES = ["runc", "gvisor", "kata", "openshell_microvm", "customer"] as const;
export type ObservedRuntime = (typeof OBSERVED_RUNTIMES)[number];

/** the class an observed runtime can attest at most (amendment F: OpenShell's container drivers attest L1 only) */
export const RUNTIME_ATTESTS: Readonly<Record<ObservedRuntime, AppliedIsolationKind>> = {
  runc: "hardened_container",
  gvisor: "user_space_kernel",
  kata: "microvm",
  openshell_microvm: "microvm",
  customer: "customer_declared",
};

/** fixed-vocabulary strings only: a short token, never prose (reports are stored and audited) */
const token = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9._:+=@/-]+$/);
const IMAGE_DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
/** an IPv4 literal (the egress probe's public literal address) */
const ipv4 = z.string().regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);

/** what each probe reports when it ran (every field bounded; nothing free-form) */
export const PROBE_OBSERVED_SCHEMAS = {
  runtime_identity: z
    .object({
      runtime: z.enum(OBSERVED_RUNTIMES),
      kernelVersion: token(128),
      /** a hypervisor CPU flag is visible (a microVM) */
      hypervisor: z.boolean(),
      /** the guest kernel differs from the host's (reported by the executor from outside) */
      guestKernelDistinct: z.boolean(),
    })
    .strict(),
  proc_status: z
    .object({
      uid: z.number().int().min(0),
      /** `CapEff` as 16 hex digits */
      capEff: z.string().regex(/^[0-9a-f]{16}$/),
      noNewPrivs: z.union([z.literal(0), z.literal(1)]),
      /** `Seccomp` mode: 0 disabled, 1 strict, 2 filter */
      seccomp: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    })
    .strict(),
  seccomp_enforced: z.object({ syscall: token(32), denied: z.boolean() }).strict(),
  root_read_only: z
    .object({
      /** EROFS on a write, or `ro` on `/` in `/proc/self/mounts` (EACCES as non-root proves nothing) */
      method: z.enum(["erofs", "mount_ro", "eacces"]),
      readOnly: z.boolean(),
    })
    .strict(),
  egress_literal_address: z.object({ address: ipv4, connected: z.boolean() }).strict(),
  egress_dns: z.object({ host: token(253), resolved: z.boolean() }).strict(),
  network_interfaces: z
    .object({
      interfaces: z.array(token(32)).max(16),
      /** the decision 4 channel interface the executor wired, or null under `network: none` */
      channelInterface: token(32).nullable(),
    })
    .strict(),
  no_executor_credentials: z
    .object({
      scanned: z.array(z.enum(["env", "args", "fs"])).min(1).max(3),
      /** how many credential-shaped values were found (never the values) */
      found: z.number().int().min(0),
    })
    .strict(),
  visible_limits: z
    .object({
      memTotalMiB: z.number().int().min(1),
      rlimitNproc: z.number().int().min(1),
      rlimitNofile: z.number().int().min(1),
    })
    .strict(),
  host_cgroup_limits: z
    .object({
      cpuQuotaMillis: z.number().int().min(1),
      memoryLimitMiB: z.number().int().min(1),
      pidsMax: z.number().int().min(1),
      throttledPeriods: z.number().int().min(0),
    })
    .strict(),
  runtime_config: z
    .object({
      backend: z.enum(EXECUTOR_BACKENDS),
      /** the runtime flags the sandbox was started with (amendment A) */
      flags: z.array(token(128)).max(32),
    })
    .strict(),
} as const satisfies Record<AttestationProbe, z.ZodTypeAny>;

/** a probe either ran and observed, or did not run (a code says why; it fails the report) */
function probeEntry<S extends z.ZodTypeAny>(observed: S) {
  return z.union([z.object({ observed }).strict(), z.object({ observed: z.null(), error: token(64) }).strict()]).optional();
}

/** written out per probe (one entry each; `probe_missing` when absent) */
const probesShape = {
  runtime_identity: probeEntry(PROBE_OBSERVED_SCHEMAS.runtime_identity),
  proc_status: probeEntry(PROBE_OBSERVED_SCHEMAS.proc_status),
  seccomp_enforced: probeEntry(PROBE_OBSERVED_SCHEMAS.seccomp_enforced),
  root_read_only: probeEntry(PROBE_OBSERVED_SCHEMAS.root_read_only),
  egress_literal_address: probeEntry(PROBE_OBSERVED_SCHEMAS.egress_literal_address),
  egress_dns: probeEntry(PROBE_OBSERVED_SCHEMAS.egress_dns),
  network_interfaces: probeEntry(PROBE_OBSERVED_SCHEMAS.network_interfaces),
  no_executor_credentials: probeEntry(PROBE_OBSERVED_SCHEMAS.no_executor_credentials),
  visible_limits: probeEntry(PROBE_OBSERVED_SCHEMAS.visible_limits),
  host_cgroup_limits: probeEntry(PROBE_OBSERVED_SCHEMAS.host_cgroup_limits),
  runtime_config: probeEntry(PROBE_OBSERVED_SCHEMAS.runtime_config),
} satisfies Record<AttestationProbe, z.ZodTypeAny>;

export const executorReportSchema = z
  .object({
    schema: z.literal(EXECUTOR_REPORT_SCHEMA),
    kind: z.enum(EXECUTOR_REPORT_KINDS),
    executor: z
      .object({
        /** the ADR-0188 identity identifier (the OAuth client_id) */
        identifier: z.string().min(1).max(2048),
        backend: z.enum(EXECUTOR_BACKENDS),
        runtimeVersion: z.string().min(1).max(128).regex(/^[A-Za-z0-9._+-]+$/),
      })
      .strict(),
    /** the profile the sandbox was started under (its digest names the exact version) */
    profileDigest: z.string().regex(/^[0-9a-f]{64}$/),
    /** the class this report claims (the gateway checks it against the observations and the backend) */
    class: z.enum(APPLIED_ISOLATION_KINDS),
    /** the executor's clock, informational: the gateway stamps the database clock */
    observedAt: z.string().datetime({ offset: true }),
    /** placement reports only */
    offerId: z.string().uuid().optional(),
    imageDigest: z.string().regex(IMAGE_DIGEST_RE).optional(),
    probes: z.object(probesShape).strict(),
    strength: z.literal(ATTESTATION_STRENGTH),
  })
  .strict()
  .superRefine((r, ctx) => {
    if (r.kind === "placement") {
      if (!r.offerId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["offerId"], message: "a placement report names its offer" });
      if (!r.imageDigest) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["imageDigest"], message: "a placement report names the image digest applied" });
    } else if (r.offerId !== undefined || r.imageDigest !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["kind"], message: "a self-test report names no offer or image" });
    }
  });
export type ExecutorReport = z.infer<typeof executorReportSchema>;
export type ProbeObserved<P extends AttestationProbe> = z.infer<(typeof PROBE_OBSERVED_SCHEMAS)[P]>;

/** a report's canonical text (RFC 8785) */
export function canonicalExecutorReport(report: ExecutorReport): string {
  const text = canonicalize(report);
  if (text === undefined) throw new TypeError("canonicalExecutorReport: the report did not serialise");
  return text;
}

/** the report hash every attestation and placement row names: SHA-256 of the canonical text, lowercase hex */
export function executorReportDigest(report: ExecutorReport): string {
  return sha256Hex(canonicalExecutorReport(report));
}

/**
 * The executor's signature over the canonical text: a detached JWS (RFC 7797,
 * `b64: false`, `crit: ["b64"]`), EdDSA or ES256 under the registered
 * workload key, `kid` = the key's RFC 7638 thumbprint. Verification
 * re-canonicalises the stored body and checks this against the identity's
 * live credentials.
 */
export const executorReportSignatureSchema = z
  .object({
    protected: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/),
    signature: z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();
export type ExecutorReportSignature = z.infer<typeof executorReportSignatureSchema>;

/** what travels over the channel and is stored: the body and its detached signature */
export const signedExecutorReportSchema = z.object({ report: executorReportSchema, signature: executorReportSignatureSchema }).strict();
export type SignedExecutorReport = z.infer<typeof signedExecutorReportSchema>;

// ---------------------------------------------------------------------------
// Evaluation (decision 6: the gateway evaluates the report against the profile)
// ---------------------------------------------------------------------------

/** why a report fails (a fixed vocabulary; stored with the verdict) */
export const REPORT_FAILURE_CODES = [
  "profile_digest_mismatch",
  "backend_mismatch",
  "class_not_declared",
  "class_not_attestable_by_backend",
  "class_above_observed_runtime",
  "class_below_required",
  "probe_missing",
  "probe_not_run",
  "runtime_identity_inconsistent",
  "uid_mismatch",
  "capabilities_present",
  "no_new_privs_unset",
  "seccomp_not_filtering",
  "seccomp_not_enforced",
  "root_writable",
  "root_proof_insufficient",
  "egress_reached",
  "dns_resolved",
  "extra_interface",
  "channel_interface_under_network_none",
  "credentials_reachable",
  "credential_scan_incomplete",
  "memory_visible_above_limit",
  "nproc_mismatch",
  "host_cpu_quota_mismatch",
  "host_memory_limit_mismatch",
  "host_pids_max_mismatch",
  "runtime_flags_missing",
  "placement_fields_missing",
  /** the placement report names an image other than the offer's (checked by the gateway against the offer) */
  "image_digest_mismatch",
  /** the report's signature does not verify under a live credential of the executor's identity */
  "signature_invalid",
] as const;
export type ReportFailureCode = (typeof REPORT_FAILURE_CODES)[number];

export interface ReportFailure {
  probe: AttestationProbe | "report";
  code: ReportFailureCode;
}

export interface EvaluateReportInput {
  profile: ExecutionProfileBody;
  profileDigest: string;
  /** the executor row's backend and declared classes (what the admin registered) */
  backend: ExecutorBackend;
  classesDeclared: readonly AppliedIsolationKind[];
  /** a placement report must also meet the placement's requirement */
  requiredClass?: RequirableIsolationClass;
}

export type ReportVerdict = { verdict: "pass"; failures: [] } | { verdict: "fail"; failures: ReportFailure[] };

const ZERO_CAPS = "0".repeat(16);

/**
 * THE RULES. Every probe the profile asks for must have run; every observation
 * must agree with the profile; the claimed class must be declared, attestable
 * by the backend, supported by what the runtime probe saw, and (for a
 * placement) at or above the requirement. Any failure fails the whole report:
 * there is no partial pass and no score.
 */
export function evaluateExecutorReport(report: ExecutorReport, input: EvaluateReportInput): ReportVerdict {
  const failures: ReportFailure[] = [];
  const fail = (probe: ReportFailure["probe"], code: ReportFailureCode) => failures.push({ probe, code });
  const p = input.profile;

  if (report.profileDigest !== input.profileDigest) fail("report", "profile_digest_mismatch");
  if (report.executor.backend !== input.backend) fail("report", "backend_mismatch");
  if (!input.classesDeclared.includes(report.class)) fail("report", "class_not_declared");
  if (!BACKEND_ATTESTABLE_CLASSES[input.backend].includes(report.class)) fail("report", "class_not_attestable_by_backend");
  if (report.kind === "placement") {
    if (!report.offerId || !report.imageDigest) fail("report", "placement_fields_missing");
    if (input.requiredClass && report.class !== "customer_declared" && isolationClassRank(report.class) < isolationClassRank(input.requiredClass)) {
      fail("report", "class_below_required");
    }
  }

  const observed = <P extends AttestationProbe>(probe: P): ProbeObserved<P> | null => {
    const entry = report.probes[probe] as { observed: ProbeObserved<P> | null } | undefined;
    if (!entry) {
      fail(probe, "probe_missing");
      return null;
    }
    if (entry.observed === null) {
      fail(probe, "probe_not_run");
      return null;
    }
    return entry.observed;
  };

  for (const probe of p.attestation.probes) {
    switch (probe) {
      case "runtime_identity": {
        const o = observed(probe);
        if (!o) break;
        const attests = RUNTIME_ATTESTS[o.runtime];
        // a microVM shows a hypervisor flag and a guest kernel distinct from the host's; a runtime that says
        // "kata" without them is inconsistent, and so is a container runtime that claims them
        const microvm = o.runtime === "kata" || o.runtime === "openshell_microvm";
        if (microvm !== (o.hypervisor && o.guestKernelDistinct)) fail(probe, "runtime_identity_inconsistent");
        if (report.class !== "customer_declared" && attests !== "customer_declared") {
          if (isolationClassRank(report.class) > isolationClassRank(attests)) fail(probe, "class_above_observed_runtime");
        } else if (report.class !== attests) {
          fail(probe, "class_above_observed_runtime");
        }
        break;
      }
      case "proc_status": {
        const o = observed(probe);
        if (!o) break;
        if (o.uid !== p.process.uid) fail(probe, "uid_mismatch");
        if (o.capEff !== ZERO_CAPS) fail(probe, "capabilities_present");
        if (o.noNewPrivs !== 1) fail(probe, "no_new_privs_unset");
        if (o.seccomp !== 2) fail(probe, "seccomp_not_filtering");
        break;
      }
      case "seccomp_enforced": {
        const o = observed(probe);
        if (o && !o.denied) fail(probe, "seccomp_not_enforced");
        break;
      }
      case "root_read_only": {
        const o = observed(probe);
        if (!o) break;
        // amendment D: EACCES as a non-root user proves nothing
        if (o.method === "eacces") fail(probe, "root_proof_insufficient");
        else if (!o.readOnly) fail(probe, "root_writable");
        break;
      }
      case "egress_literal_address": {
        const o = observed(probe);
        if (o && o.connected) fail(probe, "egress_reached");
        break;
      }
      case "egress_dns": {
        const o = observed(probe);
        if (o && o.resolved) fail(probe, "dns_resolved");
        break;
      }
      case "network_interfaces": {
        const o = observed(probe);
        if (!o) break;
        if (p.network.mode === "none" && o.channelInterface !== null) fail(probe, "channel_interface_under_network_none");
        for (const name of o.interfaces) {
          if (name !== "lo" && name !== o.channelInterface) {
            fail(probe, "extra_interface");
            break;
          }
        }
        break;
      }
      case "no_executor_credentials": {
        const o = observed(probe);
        if (!o) break;
        if (o.found > 0) fail(probe, "credentials_reachable");
        if (!(["env", "args", "fs"] as const).every((s) => o.scanned.includes(s))) fail(probe, "credential_scan_incomplete");
        break;
      }
      case "visible_limits": {
        const o = observed(probe);
        if (!o) break;
        if (o.memTotalMiB > p.resources.memoryMiB) fail(probe, "memory_visible_above_limit");
        if (o.rlimitNproc !== p.process.pids.workloadNproc) fail(probe, "nproc_mismatch");
        break;
      }
      case "host_cgroup_limits": {
        const o = observed(probe);
        if (!o) break;
        if (o.cpuQuotaMillis !== p.resources.cpuMillis) fail(probe, "host_cpu_quota_mismatch");
        if (o.memoryLimitMiB !== p.resources.memoryMiB) fail(probe, "host_memory_limit_mismatch");
        if (o.pidsMax !== p.process.pids.hostCgroupPidsMax) fail(probe, "host_pids_max_mismatch");
        break;
      }
      case "runtime_config": {
        const o = observed(probe);
        if (!o) break;
        if (o.backend !== input.backend) fail(probe, "backend_mismatch");
        // amendment A: a gVisor sandbox is started with exactly the profile's runsc flags
        if (input.backend === "gvisor") {
          const have = new Set(o.flags);
          if (!runscFlags(p).every((f) => have.has(f))) fail(probe, "runtime_flags_missing");
        }
        break;
      }
    }
  }
  return failures.length === 0 ? { verdict: "pass", failures: [] } : { verdict: "fail", failures };
}

/** the freshness limit an attestation gets: the stricter of the profile's and the org's (decision 6, decision 11) */
export function attestationMaxAgeMinutes(profile: ExecutionProfileBody, orgMaxAgeMinutes: number): number {
  return Math.min(profile.attestation.executorMaxAgeMinutes, orgMaxAgeMinutes);
}
