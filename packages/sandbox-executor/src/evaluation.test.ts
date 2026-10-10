/**
 * ADR-0190 decision 6 — the report evaluator against the fake backend: an
 * honest report passes for every shipped profile and backend that can serve
 * it; a backend lying in ONE probe at a time (the ADR's test strategy) is
 * caught with the named failure code; an omitted probe, a claimed class above
 * what the runtime shows, a backend that cannot attest the class, and a
 * placement below its requirement each fail. Negative control first: the
 * honest report must pass, or the lies prove nothing.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateExecutorReport,
  executionProfileDigest,
  executorReportSchema,
  SHIPPED_EXECUTION_PROFILES,
  type AttestationProbe,
  type ExecutionProfileBody,
  type ExecutorBackend,
  type ReportFailureCode,
} from "@regulait/shared";
import { FakeSandboxBackend } from "./fake-backend.js";
import { buildReport } from "./report.js";

const ID = "spiffe://test.example/regulait/worker_runtime/exec-1";
const restricted = SHIPPED_EXECUTION_PROFILES.restricted;
const microvm = SHIPPED_EXECUTION_PROFILES["restricted-microvm"];

async function selfTestReport(backend: FakeSandboxBackend, profile: ExecutionProfileBody, cls: Parameters<FakeSandboxBackend["startCanary"]>[1]) {
  const canary = await backend.startCanary(profile, cls);
  const probes = await canary.probe(profile.attestation.probes);
  await canary.kill();
  return buildReport({ kind: "self_test", identifier: ID, backend: backend.describe(), profileDigest: executionProfileDigest(profile), cls, probes });
}

const input = (backend: FakeSandboxBackend, profile: ExecutionProfileBody) => ({
  profile,
  profileDigest: executionProfileDigest(profile),
  backend: backend.describe().backend,
  classesDeclared: backend.describe().classes,
});

describe("an honest fake backend", () => {
  it.each([
    ["gvisor", restricted, "user_space_kernel"],
    ["gvisor", SHIPPED_EXECUTION_PROFILES["engine-worker"], "user_space_kernel"],
    ["kata", microvm, "microvm"],
    ["openshell", microvm, "microvm"],
    ["runc", restricted, "hardened_container"],
  ] as const)("%s at %s passes the evaluator and the schema", async (b, profile, cls) => {
    const backend = new FakeSandboxBackend({ backend: b as ExecutorBackend });
    const report = await selfTestReport(backend, profile, cls);
    expect(executorReportSchema.safeParse(report).success).toBe(true);
    expect(evaluateExecutorReport(report, input(backend, profile))).toEqual({ verdict: "pass", failures: [] });
  });
});

describe("a backend lying in one probe at a time is caught with the named code", () => {
  const lies: Array<[AttestationProbe, (o: never) => unknown, ReportFailureCode]> = [
    ["runtime_identity", (o: { runtime: string }) => ({ ...o, runtime: "runc" }), "class_above_observed_runtime"],
    ["runtime_identity", (o: { hypervisor: boolean }) => ({ ...o, hypervisor: true, guestKernelDistinct: true }), "runtime_identity_inconsistent"],
    ["proc_status", (o: { uid: number }) => ({ ...o, uid: 0 }), "uid_mismatch"],
    ["proc_status", (o: { capEff: string }) => ({ ...o, capEff: "000001ffffffffff" }), "capabilities_present"],
    ["proc_status", (o: { noNewPrivs: number }) => ({ ...o, noNewPrivs: 0 }), "no_new_privs_unset"],
    ["proc_status", (o: { seccomp: number }) => ({ ...o, seccomp: 0 }), "seccomp_not_filtering"],
    ["seccomp_enforced", (o: { denied: boolean }) => ({ ...o, denied: false }), "seccomp_not_enforced"],
    ["root_read_only", (o: { readOnly: boolean }) => ({ ...o, readOnly: false }), "root_writable"],
    ["root_read_only", (o: { method: string }) => ({ ...o, method: "eacces" }), "root_proof_insufficient"],
    ["egress_literal_address", (o: { connected: boolean }) => ({ ...o, connected: true }), "egress_reached"],
    ["egress_dns", (o: { resolved: boolean }) => ({ ...o, resolved: true }), "dns_resolved"],
    ["network_interfaces", (o: { interfaces: string[] }) => ({ ...o, interfaces: [...o.interfaces, "eth1"] }), "extra_interface"],
    ["no_executor_credentials", (o: { found: number }) => ({ ...o, found: 1 }), "credentials_reachable"],
    ["no_executor_credentials", (o: { scanned: string[] }) => ({ ...o, scanned: ["env"] }), "credential_scan_incomplete"],
    ["visible_limits", (o: { memTotalMiB: number }) => ({ ...o, memTotalMiB: o.memTotalMiB * 2 }), "memory_visible_above_limit"],
    ["visible_limits", (o: { rlimitNproc: number }) => ({ ...o, rlimitNproc: o.rlimitNproc + 1 }), "nproc_mismatch"],
    ["host_cgroup_limits", (o: { cpuQuotaMillis: number }) => ({ ...o, cpuQuotaMillis: o.cpuQuotaMillis * 4 }), "host_cpu_quota_mismatch"],
    ["host_cgroup_limits", (o: { memoryLimitMiB: number }) => ({ ...o, memoryLimitMiB: o.memoryLimitMiB + 1 }), "host_memory_limit_mismatch"],
    ["host_cgroup_limits", (o: { pidsMax: number }) => ({ ...o, pidsMax: o.pidsMax * 2 }), "host_pids_max_mismatch"],
    ["runtime_config", (o: { flags: string[] }) => ({ ...o, flags: o.flags.filter((f) => f !== "--oci-seccomp") }), "runtime_flags_missing"],
    ["runtime_config", (o: { flags: string[] }) => ({ ...o, flags: o.flags.map((f) => (f === "--directfs=false" ? "--directfs=true" : f)) }), "runtime_flags_missing"],
    ["runtime_config", (o: { backend: string }) => ({ ...o, backend: "runc" }), "backend_mismatch"],
  ];
  it.each(lies)("%s lying (%s) → %s", async (probe, mutate, code) => {
    const backend = new FakeSandboxBackend().lie(probe, mutate as never);
    const report = await selfTestReport(backend, restricted, "user_space_kernel");
    const v = evaluateExecutorReport(report, input(backend, restricted));
    expect(v.verdict).toBe("fail");
    expect(v.failures).toContainEqual({ probe, code });
    // the negative control: the same backend, honest again, passes
    expect(evaluateExecutorReport(await selfTestReport(backend.truthful(), restricted, "user_space_kernel"), input(backend, restricted)).verdict).toBe("pass");
  });

  it("an omitted probe fails as probe_missing; a probe that did not run as probe_not_run", async () => {
    const backend = new FakeSandboxBackend().omit("egress_dns");
    const report = await selfTestReport(backend, restricted, "user_space_kernel");
    expect(evaluateExecutorReport(report, input(backend, restricted)).failures).toContainEqual({ probe: "egress_dns", code: "probe_missing" });
    const notRun = structuredClone(report);
    (notRun.probes as Record<string, unknown>).egress_dns = { observed: null, error: "no_resolver_probe" };
    expect(executorReportSchema.safeParse(notRun).success).toBe(true);
    expect(evaluateExecutorReport(notRun, input(backend, restricted)).failures).toContainEqual({ probe: "egress_dns", code: "probe_not_run" });
  });

  it("the network_interfaces probe under network: none refuses any channel interface", async () => {
    const none: ExecutionProfileBody = { ...restricted, name: "none-net", network: { mode: "none" } };
    const backend = new FakeSandboxBackend().lie("network_interfaces", (o) => ({ ...o, interfaces: ["lo", "eth0"], channelInterface: "eth0" }));
    const report = await selfTestReport(backend, none, "user_space_kernel");
    expect(evaluateExecutorReport(report, input(backend, none)).failures).toContainEqual({ probe: "network_interfaces", code: "channel_interface_under_network_none" });
  });
});

describe("the claimed class", () => {
  it("cannot exceed what the backend may attest, what the admin declared, or what the runtime shows", async () => {
    // a runc executor claims L2: not attestable by the backend
    const runc = new FakeSandboxBackend({ backend: "runc", classes: ["hardened_container"] });
    const canary = await runc.startCanary(restricted, "hardened_container");
    const probes = await canary.probe(restricted.attestation.probes);
    const claimsL2 = buildReport({ kind: "self_test", identifier: ID, backend: runc.describe(), profileDigest: executionProfileDigest(restricted), cls: "user_space_kernel", probes });
    const v = evaluateExecutorReport(claimsL2, input(runc, restricted));
    expect(v.failures.map((f) => f.code)).toEqual(expect.arrayContaining(["class_not_declared", "class_not_attestable_by_backend", "class_above_observed_runtime"]));
    // a gvisor executor the admin registered at L1 only, claiming L2 honestly observed: not declared
    const gvisorL1 = new FakeSandboxBackend({ backend: "gvisor" });
    const r = await selfTestReport(gvisorL1, restricted, "user_space_kernel");
    expect(evaluateExecutorReport(r, { ...input(gvisorL1, restricted), classesDeclared: ["hardened_container"] }).failures).toContainEqual({ probe: "report", code: "class_not_declared" });
  });

  it("a placement report below the placement's requirement fails class_below_required; at or above passes", async () => {
    const backend = new FakeSandboxBackend();
    const offer = { id: "4b0c1a3e-6a1e-4a4b-9a2c-0f4e5d6c7b8a", workloadKind: "mcp_stdio", requiredClass: "microvm", requiredBy: "data_sensitivity", enforcement: "enforce", profileDigest: executionProfileDigest(restricted), imageDigest: `sha256:${"b".repeat(64)}`, expiresAt: new Date().toISOString() } as const;
    const h = await backend.start(offer, restricted, "user_space_kernel");
    const probes = await h.probe(restricted.attestation.probes);
    const report = buildReport({ kind: "placement", identifier: ID, backend: backend.describe(), profileDigest: offer.profileDigest, cls: "user_space_kernel", probes, offerId: offer.id, imageDigest: h.imageDigest });
    expect(evaluateExecutorReport(report, { ...input(backend, restricted), requiredClass: "microvm" }).failures).toContainEqual({ probe: "report", code: "class_below_required" });
    expect(evaluateExecutorReport(report, { ...input(backend, restricted), requiredClass: "user_space_kernel" }).verdict).toBe("pass");
    expect(evaluateExecutorReport(report, { ...input(backend, restricted), requiredClass: "hardened_container" }).verdict).toBe("pass");
  });

  it("a placement report without its offer or image is refused by the schema and the evaluator", async () => {
    const backend = new FakeSandboxBackend();
    const report = await selfTestReport(backend, restricted, "user_space_kernel");
    const bad = { ...report, kind: "placement" as const };
    expect(executorReportSchema.safeParse(bad).success).toBe(false);
    expect(evaluateExecutorReport(bad, input(backend, restricted)).failures).toContainEqual({ probe: "report", code: "placement_fields_missing" });
  });

  it("a report for another profile digest fails profile_digest_mismatch", async () => {
    const backend = new FakeSandboxBackend();
    const report = await selfTestReport(backend, restricted, "user_space_kernel");
    expect(evaluateExecutorReport(report, { ...input(backend, restricted), profileDigest: executionProfileDigest(microvm) }).failures).toContainEqual({ probe: "report", code: "profile_digest_mismatch" });
  });
});
