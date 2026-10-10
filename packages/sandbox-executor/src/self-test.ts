/**
 * ADR-0190 decision 6 — THE EXECUTOR SELF-TEST: for every live profile the
 * executor can serve, a canary sandbox under that profile at the highest
 * class the backend attests, probed from inside, killed, and reported to the
 * gateway signed. The gateway's verdict (and its expiry) is what the executor
 * remembers as its FRESH ATTESTATION for that profile: an offer is taken only
 * against one of those, never against the executor's own opinion.
 */
import { executionProfileDigest, isolationClassRank, type AppliedIsolationKind, type ExecutorProfileRef, type RequirableIsolationClass, type SignedExecutorReport } from "@regulait/shared";
import type { SandboxBackend } from "./backend.js";
import type { ChannelCredential } from "./channel-credential.js";
import type { ExecutorClient } from "./client.js";
import { buildReport, precheckReport } from "./report.js";

/** what the gateway said about one profile, kept by the executor */
export interface FreshAttestation {
  profileDigest: string;
  cls: AppliedIsolationKind;
  /** the gateway's expiry (database clock, ISO) */
  expiresAt: string;
}

/** the live profiles, by digest, each body re-digested on receipt (a body that does not match its digest is dropped) */
export function indexProfiles(refs: readonly ExecutorProfileRef[], log?: (m: string) => void): Map<string, ExecutorProfileRef> {
  const out = new Map<string, ExecutorProfileRef>();
  for (const r of refs) {
    if (executionProfileDigest(r.body) !== r.digest) {
      log?.(`profile ${r.name} v${r.version}: body does not match its digest; dropped`);
      continue;
    }
    out.set(r.digest, r);
  }
  return out;
}

/** the highest class among `declared` (never customer_declared) that satisfies `minClass`; null if none */
export function topClassFor(declared: readonly AppliedIsolationKind[], minClass: RequirableIsolationClass): AppliedIsolationKind | null {
  // a customer plane attests only its own declaration; whether that satisfies a class is the admin's mapping (OWNER DECISION 6)
  if (declared.includes("customer_declared")) return "customer_declared";
  const ranked = declared.filter((c): c is RequirableIsolationClass => c !== "customer_declared").sort((a, b) => isolationClassRank(b) - isolationClassRank(a));
  return ranked.find((c) => isolationClassRank(c) >= isolationClassRank(minClass)) ?? null;
}

export interface SelfTestInput {
  backend: SandboxBackend;
  credential: ChannelCredential;
  client: ExecutorClient;
  profiles: ReadonlyMap<string, ExecutorProfileRef>;
  /** the classes the gateway registered for this executor (the admin's word, not the backend's) */
  classesDeclared: readonly AppliedIsolationKind[];
  now?: () => Date;
  log?: (m: string) => void;
}

/**
 * Run the self-test for every profile and submit the reports in one call.
 * Returns the attestations the gateway marked `pass`. A profile the executor
 * cannot reach (minClass above what it declares) is skipped, not reported.
 */
export async function runSelfTests(input: SelfTestInput): Promise<{ fresh: FreshAttestation[]; next: Awaited<ReturnType<ExecutorClient["selfTest"]>>["next"] }> {
  const desc = input.backend.describe();
  const reports: SignedExecutorReport[] = [];
  for (const ref of input.profiles.values()) {
    const cls = topClassFor(input.classesDeclared, ref.minClass);
    if (!cls || !desc.classes.includes(cls)) {
      input.log?.(`self-test: ${ref.name} v${ref.version} needs ${ref.minClass}; not declared on this executor, skipped`);
      continue;
    }
    const canary = await input.backend.startCanary(ref.body, cls);
    let probes;
    try {
      probes = await canary.probe(ref.body.attestation.probes);
    } finally {
      await canary.kill();
    }
    const report = buildReport({ kind: "self_test", identifier: input.credential.identifier, backend: desc, profileDigest: ref.digest, cls, probes, ...(input.now ? { now: input.now } : {}) });
    const pre = precheckReport(report, { profile: ref.body, profileDigest: ref.digest, backend: desc.backend, classesDeclared: input.classesDeclared });
    if (pre.verdict === "fail") {
      // reported all the same: the gateway records the failure and withdraws the class until the next pass
      input.log?.(`self-test: ${ref.name} v${ref.version} at ${cls} fails on this host: ${pre.failures.map((f) => `${f.probe}:${f.code}`).join(", ")}`);
    }
    reports.push(await input.credential.signReport(report));
  }
  if (reports.length === 0) return { fresh: [], next: "ok" };
  const answer = await input.client.selfTest(reports);
  const fresh: FreshAttestation[] = [];
  for (const r of answer.results) {
    if (r.verdict === "pass" && r.expiresAt) fresh.push({ profileDigest: r.profileDigest, cls: r.class, expiresAt: r.expiresAt });
    else input.log?.(`self-test: profile ${r.profileDigest.slice(0, 12)} at ${r.class}: ${r.verdict}${r.failures.length ? ` (${r.failures.map((f) => `${f.probe}:${f.code}`).join(", ")})` : ""}`);
  }
  return { fresh, next: answer.next };
}
