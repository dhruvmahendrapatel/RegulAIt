/**
 * ADR-0190 slice I5 — the engine task contract (shared): the input digest and manifest, the runner's upload, the
 * frames, the MACed `start` line carrying the task secret, the per-placement report's input digest, and the I8
 * capture of an engine run's entitlement decision (its placement is the run's engine_worker placement).
 */
import { describe, expect, it } from "vitest";
import canonicalize from "canonicalize";
import { createHash } from "node:crypto";
import {
  engineTaskFramesResponseSchema,
  engineTaskInFrameSchema,
  engineTaskInputDigest,
  engineTaskInputManifestSchema,
  engineTaskInputUploadSchema,
  engineTaskOutFrameSchema,
  isEngineTaskPath,
} from "./engine-task.js";
import { executorStdioMessageSchema, stdioFrameMac, stdioFrameMacValid, stdioMacKey } from "./stdio.js";
import { evaluateExecutorReport, executorReportSchema, type ExecutorReport } from "./attestation.js";
import { executionProfileDigest, runscFlags } from "./contract.js";
import { SHIPPED_EXECUTION_PROFILES } from "./profiles.js";
import { buildExecutionFacts, DecisionFactsCaptureError, ENGINE_RUN_ENTITLEMENT_PHASE, type DecisionAuditRow, type DecisionFactReads } from "../bom/facts-capture.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const RUN = "0f1e2d3c-4b5a-4968-8776-655443322110";
const files = [
  { path: `${RUN}/job.json`, size: 10, sha256: sha("a") },
  { path: `${RUN}/artifact.pkl`, size: 20, sha256: sha("b") },
];

describe("the input digest and manifest", () => {
  it("is the SHA-256 of the canonical, path-sorted file list (order of listing does not matter)", () => {
    const d = engineTaskInputDigest(files);
    expect(engineTaskInputDigest([...files].reverse())).toBe(d);
    const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
    expect(d).toBe(sha(canonicalize({ v: 1, input: "jobs", files: sorted })!));
    expect(engineTaskInputDigest([{ ...files[0]!, size: 11 }, files[1]!])).not.toBe(d);
  });

  it("a manifest must name its own digest, distinct paths and no path nested in another", () => {
    expect(engineTaskInputManifestSchema.safeParse({ input: "jobs", files, digest: engineTaskInputDigest(files) }).success).toBe(true);
    expect(engineTaskInputManifestSchema.safeParse({ input: "jobs", files, digest: "0".repeat(64) }).success).toBe(false);
    const nested = [{ ...files[0]!, path: RUN }, files[1]!];
    expect(engineTaskInputManifestSchema.safeParse({ input: "jobs", files: nested, digest: engineTaskInputDigest(nested) }).success).toBe(false);
    const dup = [files[0]!, files[0]!];
    expect(engineTaskInputManifestSchema.safeParse({ input: "jobs", files: dup, digest: engineTaskInputDigest(dup) }).success).toBe(false);
  });

  it.each(["a", "a/b", `${RUN}/job.json`, "a/b/c/d"])("admits the path %s", (p) => expect(isEngineTaskPath(p)).toBe(true));
  it.each(["", "/a", "a/", "a/../b", "./a", "a//b", "a/b/c/d/e", "a b", "a\\b", "x".repeat(129)])("refuses the path %j", (p) => expect(isEngineTaskPath(p)).toBe(false));
});

describe("the runner's upload", () => {
  const job = Buffer.from("{}").toString("base64");
  it("inline files plus at most the run's artifact (placed, never named by id), and a printable secret or none", () => {
    expect(engineTaskInputUploadSchema.safeParse({ files: [{ path: `${RUN}/job.json`, data: job }], artifact: { path: `${RUN}/artifact.pkl` }, secret: null }).success).toBe(true);
    expect(engineTaskInputUploadSchema.safeParse({ files: [{ path: `${RUN}/job.json`, data: job }], artifact: { path: `${RUN}/a.pkl`, artifactId: RUN }, secret: null }).success).toBe(false);
    expect(engineTaskInputUploadSchema.safeParse({ files: [], artifact: null, secret: null }).success).toBe(false);
    expect(engineTaskInputUploadSchema.safeParse({ files: [{ path: `${RUN}/job.json`, data: job }], artifact: null, secret: "has space" }).success).toBe(false);
    const big = Buffer.alloc(1024 * 1024 + 100, 1).toString("base64");
    expect(engineTaskInputUploadSchema.safeParse({ files: [{ path: `${RUN}/job.json`, data: big }], artifact: null, secret: null }).success).toBe(false);
  });
});

describe("the frames", () => {
  it("a file chunk's last frame names the file's size and sha256; a tunnelled request carries only the named headers", () => {
    expect(engineTaskOutFrameSchema.safeParse({ t: "file", path: `${RUN}/done.json`, chunk: 0, data: "", last: true }).success).toBe(false);
    expect(engineTaskOutFrameSchema.safeParse({ t: "file", path: `${RUN}/done.json`, chunk: 0, data: "", last: true, size: 0, sha256: sha("") }).success).toBe(true);
    // any subset of the named headers (zod 4: a partial record), none other
    expect(engineTaskOutFrameSchema.safeParse({ t: "http", id: "1", method: "POST", path: "/v1/chat/completions", headers: { authorization: "Bearer x" }, body: "" }).success).toBe(true);
    expect(engineTaskOutFrameSchema.safeParse({ t: "http", id: "1", method: "POST", path: "/v1/x", headers: { cookie: "a" }, body: "" }).success).toBe(false);
    expect(engineTaskOutFrameSchema.safeParse({ t: "http", id: "1", method: "PUT", path: "/v1/x", headers: {}, body: "" }).success).toBe(false);
    expect(engineTaskOutFrameSchema.safeParse({ t: "http", id: "1", method: "GET", path: "/v1/../admin", headers: {}, body: "" }).success).toBe(false);
    expect(engineTaskInFrameSchema.safeParse({ t: "http_err", id: "1", code: "not_gateway" }).success).toBe(true);
    expect(engineTaskFramesResponseSchema.safeParse({ state: "running", frames: [], nextSeq: 0, eof: false, refusal: null }).success).toBe(true);
  });
});

describe("the MACed start line carries the task secret", () => {
  const key = stdioMacKey(Buffer.alloc(32, 7).toString("base64url"), RUN);
  const workload = { command: "/usr/local/bin/node", args: ["/app/dist/task-main.js"] };
  const secret = `k-${sha("i5").slice(0, 20)}`;
  it("the secret is covered by the MAC; a start with no secret is MACed exactly as in I4", () => {
    const mac = stdioFrameMac(key, RUN, { type: "start", workload, secret });
    expect(stdioFrameMacValid(key, RUN, { type: "start", workload, secret, mac })).toBe(true);
    // swapping or stripping the secret breaks the MAC
    expect(stdioFrameMacValid(key, RUN, { type: "start", workload, secret: `${secret}x`, mac })).toBe(false);
    expect(stdioFrameMacValid(key, RUN, { type: "start", workload, mac })).toBe(false);
    const noSecret = stdioFrameMac(key, RUN, { type: "start", workload });
    expect(noSecret).toBe(stdioFrameMac(key, RUN, { type: "start", workload, secret: undefined }));
    expect(executorStdioMessageSchema.safeParse({ type: "start", workload, secret, mac }).success).toBe(true);
    expect(executorStdioMessageSchema.safeParse({ type: "start", workload, secret: "a b", mac }).success).toBe(false);
  });
});

describe("the per-placement report names the input it mounted", () => {
  const profile = SHIPPED_EXECUTION_PROFILES["engine-worker"];
  const digest = executionProfileDigest(profile);
  const base = (o: Partial<ExecutorReport> = {}): ExecutorReport => ({
    schema: "regulait.executor-report.v1",
    kind: "placement",
    executor: { identifier: "spiffe://test.example/regulait/worker_runtime/x", backend: "gvisor", runtimeVersion: "test-1" },
    profileDigest: digest,
    class: "user_space_kernel",
    observedAt: new Date().toISOString(),
    offerId: RUN,
    imageDigest: `sha256:${"e".repeat(64)}`,
    probes: {
      runtime_identity: { observed: { runtime: "gvisor", kernelVersion: "4.4.0", hypervisor: false, guestKernelDistinct: false } },
      proc_status: { observed: { uid: profile.process.uid, capEff: "0000000000000000", noNewPrivs: 1, seccomp: 2 } },
      seccomp_enforced: { observed: { syscall: "unshare", denied: true } },
      root_read_only: { observed: { method: "erofs", readOnly: true } },
      egress_literal_address: { observed: { address: "203.0.113.9", connected: false } },
      egress_dns: { observed: { host: "example.com", resolved: false } },
      network_interfaces: { observed: { interfaces: ["lo"], channelInterface: null } },
      no_executor_credentials: { observed: { scanned: ["env", "args", "fs"], found: 0 } },
      visible_limits: { observed: { memTotalMiB: profile.resources.memoryMiB, rlimitNproc: profile.process.pids.workloadNproc, rlimitNofile: 1024 } },
      host_cgroup_limits: { observed: { cpuQuotaMillis: profile.resources.cpuMillis, memoryLimitMiB: profile.resources.memoryMiB, pidsMax: profile.process.pids.hostCgroupPidsMax, throttledPeriods: 0 } },
      runtime_config: { observed: { backend: "gvisor", flags: runscFlags(profile) } },
    },
    strength: "software_attested",
    ...o,
  });
  const evaluate = (r: ExecutorReport) => evaluateExecutorReport(r, { profile, profileDigest: digest, backend: "gvisor", classesDeclared: ["user_space_kernel"], requiredClass: "user_space_kernel" });

  it("a placement under a profile with inputs passes only with the input digest (the gateway compares it)", () => {
    expect(evaluate(base({ inputSha256: "a".repeat(64) }))).toEqual({ verdict: "pass", failures: [] });
    expect(evaluate(base()).failures).toContainEqual({ probe: "report", code: "placement_fields_missing" });
  });
  it("a self-test report names no input", () => {
    expect(executorReportSchema.safeParse({ ...base(), kind: "self_test", offerId: undefined, imageDigest: undefined, inputSha256: "a".repeat(64) }).success).toBe(false);
  });
});

describe("I8 capture of an engine run's entitlement decision (I5 writes its placement)", () => {
  const row = (o: Partial<DecisionAuditRow> = {}): DecisionAuditRow => ({
    id: RUN, seq: 1, at: new Date("2026-10-16T00:00:00.000Z"), userId: RUN, objectType: "agent", objectId: RUN,
    serverId: null, toolName: null, effect: "allow", detail: { receiptClass: "decision", phase: ENGINE_RUN_ENTITLEMENT_PHASE, role: "target" },
    actorIdentityId: null, delegationGrantId: null, actorChain: null, chainVersion: null, ...o,
  });
  const reads = (placement?: Record<string, unknown>): DecisionFactReads => ({
    projectTags: new Map(), approvals: new Map(), approvalDecisions: new Map(), grants: new Map(), identities: new Map(),
    ...(placement ? { placements: new Map([[RUN, { placement, profile: null, executor: null, executorIdentity: null, executorAttestation: null }]]) } : {}),
  });
  const offered = { id: RUN, workloadKind: "engine_worker", outcome: "offered", requiredClass: "user_space_kernel", requiredBy: "workload_kind", appliedClass: "user_space_kernel", refusalCode: null, reportSha256: null, offerId: RUN, imageDigest: `sha256:${"e".repeat(64)}`, runtimeFlagsSha256: null };

  it("an allowed one records its engine_worker placement (never in_gateway)", () => {
    expect(buildExecutionFacts(row(), reads(offered))).toMatchObject({ workloadKind: "engine_worker", placement: "offered", placementId: RUN, requiredClass: "user_space_kernel" });
  });
  it("an allowed one with no placement, or with another workload's, fails the capture (the I5 contract is broken)", () => {
    expect(() => buildExecutionFacts(row(), reads())).toThrow(DecisionFactsCaptureError);
    expect(() => buildExecutionFacts(row(), reads({ ...offered, workloadKind: "mcp_stdio" }))).toThrow(DecisionFactsCaptureError);
  });
  it("a refused one (the task start refused by decision 7) records its refused placement; one written before any task start records none", () => {
    expect(buildExecutionFacts(row({ effect: "deny" }), reads({ ...offered, outcome: "refused", refusalCode: "policy_unresolved", requiredClass: null, requiredBy: null, appliedClass: null, offerId: null }))).toMatchObject({ placement: "refused", refusalCode: "policy_unresolved" });
    expect(buildExecutionFacts(row({ effect: "deny" }), reads())).toBeNull();
  });
});
