/**
 * ADR-0190 I3 — THE FAKE BACKEND, for tests only (exported from `./testing`,
 * never reachable from `main.ts`: a fake that attests isolation that does
 * not exist would be the one thing the gateway cannot tell from the real
 * thing).
 *
 * Honest by default: it observes exactly what the profile and the declared
 * backend would produce. `lie(probe, mutate)` makes ONE probe's observation
 * wrong (the ADR's test strategy: "a fake backend lying in one probe at a
 * time"), and `omit(probe)` leaves one out. It records every sandbox it
 * started, probed, released and killed, so a test can assert "zero
 * sandboxes started", "input never released" and "killed on mismatch".
 */
import { randomUUID } from "node:crypto";
import {
  BACKEND_ATTESTABLE_CLASSES,
  isolationClassRank,
  runscFlags,
  type AppliedIsolationKind,
  type AttestationProbe,
  type ExecutionOffer,
  type ExecutionProfileBody,
  type ExecutorBackend,
  type ObservedRuntime,
  type ProbeObserved,
  type RequirableIsolationClass,
} from "@regulait/shared";
import type { BackendDescription, ProbeSet, SandboxBackend, SandboxHandle } from "./backend.js";

export interface FakeBackendOptions {
  backend?: ExecutorBackend;
  runtimeVersion?: string;
  /** default: everything the backend may attest */
  classes?: readonly AppliedIsolationKind[];
  /** the "public literal address" the egress probe reports it tried */
  probeAddress?: string;
}

type Lie<P extends AttestationProbe> = (observed: ProbeObserved<P>) => ProbeObserved<P>;

export interface FakeSandboxRecord {
  id: string;
  kind: "canary" | "placement";
  offerId: string | null;
  cls: AppliedIsolationKind;
  probed: boolean;
  released: boolean;
  killed: boolean;
}

/** the runtime each backend's sandbox observes from inside, at a class */
function runtimeFor(backend: ExecutorBackend, cls: AppliedIsolationKind): ObservedRuntime {
  if (backend === "customer") return "customer";
  if (cls === "microvm") return backend === "openshell" ? "openshell_microvm" : "kata";
  if (cls === "user_space_kernel") return "gvisor";
  return "runc";
}

export class FakeSandboxBackend implements SandboxBackend {
  readonly sandboxes: FakeSandboxRecord[] = [];
  private readonly description: BackendDescription;
  private readonly lies = new Map<AttestationProbe, { mutate: Lie<AttestationProbe>; only: "canary" | "placement" | null }>();
  private readonly omitted = new Set<AttestationProbe>();
  private readonly probeAddress: string;
  /** the image every placement sandbox reports (a test may set it per offer by reading the offer) */
  imageDigestOverride: string | null = null;

  constructor(opts: FakeBackendOptions = {}) {
    const backend = opts.backend ?? "gvisor";
    this.description = { backend, runtimeVersion: opts.runtimeVersion ?? "fake-0.0.0", classes: opts.classes ?? BACKEND_ATTESTABLE_CLASSES[backend] };
    this.probeAddress = opts.probeAddress ?? "203.0.113.9";
  }

  describe(): BackendDescription {
    return this.description;
  }

  /**
   * make one probe lie from now on (returns `this` for chaining); `only`
   * restricts the lie to canary (self-test) or placement sandboxes, the case
   * where an executor's self-test passes but the workload's own sandbox
   * differs
   */
  lie<P extends AttestationProbe>(probe: P, mutate: Lie<P>, only: "canary" | "placement" | null = null): this {
    this.lies.set(probe, { mutate: mutate as unknown as Lie<AttestationProbe>, only });
    return this;
  }
  /** leave one probe out of every report from now on */
  omit(probe: AttestationProbe): this {
    this.omitted.add(probe);
    return this;
  }
  /** back to honest */
  truthful(): this {
    this.lies.clear();
    this.omitted.clear();
    return this;
  }

  /** what an honest sandbox under `profile` at `cls` observes for `probe` */
  honest<P extends AttestationProbe>(probe: P, profile: ExecutionProfileBody, cls: AppliedIsolationKind): ProbeObserved<P> {
    const b = this.description.backend;
    const runtime = runtimeFor(b, cls);
    const microvm = runtime === "kata" || runtime === "openshell_microvm";
    const table: { [K in AttestationProbe]: ProbeObserved<K> } = {
      runtime_identity: { runtime, kernelVersion: microvm ? "6.1.0-guest" : runtime === "gvisor" ? "4.4.0-gvisor" : "6.8.0-host", hypervisor: microvm, guestKernelDistinct: microvm },
      proc_status: { uid: profile.process.uid, capEff: "0000000000000000", noNewPrivs: 1, seccomp: 2 },
      seccomp_enforced: { syscall: "unshare", denied: true },
      root_read_only: { method: "erofs", readOnly: true },
      egress_literal_address: { address: this.probeAddress, connected: false },
      egress_dns: { host: "example.com", resolved: false },
      network_interfaces: profile.network.mode === "none" ? { interfaces: ["lo"], channelInterface: null } : { interfaces: ["lo", "eth0"], channelInterface: "eth0" },
      no_executor_credentials: { scanned: ["env", "args", "fs"], found: 0 },
      visible_limits: { memTotalMiB: profile.resources.memoryMiB, rlimitNproc: profile.process.pids.workloadNproc, rlimitNofile: 1024 },
      host_cgroup_limits: { cpuQuotaMillis: profile.resources.cpuMillis, memoryLimitMiB: profile.resources.memoryMiB, pidsMax: profile.process.pids.hostCgroupPidsMax, throttledPeriods: 0 },
      runtime_config: { backend: b, flags: b === "gvisor" ? runscFlags(profile) : [] },
    };
    return table[probe];
  }

  private probeSet(kind: "canary" | "placement", profile: ExecutionProfileBody, cls: AppliedIsolationKind, probes: readonly AttestationProbe[]): ProbeSet {
    const out: ProbeSet = {};
    for (const probe of probes) {
      if (this.omitted.has(probe)) continue;
      const honest = this.honest(probe, profile, cls);
      const lie = this.lies.get(probe);
      const applies = lie && (lie.only === null || lie.only === kind);
      (out as Record<string, unknown>)[probe] = { observed: applies ? lie.mutate(honest) : honest };
    }
    return out;
  }

  private handle(kind: "canary" | "placement", offer: ExecutionOffer | null, profile: ExecutionProfileBody, cls: AppliedIsolationKind): SandboxHandle {
    const rec: FakeSandboxRecord = { id: randomUUID(), kind, offerId: offer?.id ?? null, cls, probed: false, released: false, killed: false };
    this.sandboxes.push(rec);
    let endedResolve!: (o: "completed" | "failed" | "killed" | "limit_exceeded") => void;
    const ended = new Promise<"completed" | "failed" | "killed" | "limit_exceeded">((r) => (endedResolve = r));
    const self = this;
    return {
      id: rec.id,
      imageDigest: this.imageDigestOverride ?? offer?.imageDigest ?? `sha256:${"f".repeat(64)}`,
      async probe(probes) {
        rec.probed = true;
        return self.probeSet(kind, profile, cls, probes);
      },
      async releaseInput() {
        if (rec.killed) throw new Error("fake backend: input released to a killed sandbox");
        rec.released = true;
        // a fake workload completes as soon as it has its input
        endedResolve("completed");
      },
      async kill() {
        rec.killed = true;
        endedResolve("killed");
      },
      ended,
    };
  }

  async startCanary(profile: ExecutionProfileBody, cls: AppliedIsolationKind): Promise<SandboxHandle> {
    this.assertClass(cls);
    return this.handle("canary", null, profile, cls);
  }

  async start(offer: ExecutionOffer, profile: ExecutionProfileBody, cls: AppliedIsolationKind): Promise<SandboxHandle> {
    this.assertClass(cls);
    return this.handle("placement", offer, profile, cls);
  }

  private assertClass(cls: AppliedIsolationKind) {
    if (!this.description.classes.includes(cls)) throw new Error(`fake backend: cannot start a sandbox at ${cls}`);
  }

  /** the highest class this backend can attest that satisfies `minClass` (null if none) */
  topClassFor(minClass: RequirableIsolationClass): AppliedIsolationKind | null {
    const ranked = this.description.classes.filter((c): c is RequirableIsolationClass => c !== "customer_declared").sort((a, b) => isolationClassRank(b) - isolationClassRank(a));
    return ranked.find((c) => isolationClassRank(c) >= isolationClassRank(minClass)) ?? null;
  }
}
