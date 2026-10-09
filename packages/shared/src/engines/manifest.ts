/**
 * ADR-0187 — THE SHIPPED ENGINE MANIFEST, and the self-test verdict.
 *
 * The manifest is the only source of an engine's version and image digest: an
 * admin cannot point an engine at an arbitrary image. The gateway copies it
 * onto the `engines` rows (`syncEngineManifest`), and a runner is admitted only
 * when the digest it reports equals the manifest's.
 *
 * FOUNDATION STATE (2026-10-08). No engine image is built yet (B5-P, B5-M and
 * B5-G build and sign them from pinned upstream source). Until then every
 * `imageDigest` is null, so no runner can pass the self-test and no engine can
 * be enabled: the secure default holds by construction, not by a flag. The
 * usage-data switches below are the documented ones from the R9 source review
 * (docs/research/R9-engine-reverification.md); G19 (R10) confirms or replaces
 * them per engine, and network denial stays the real control either way.
 */
import { MODELSCAN_ENGINE_VERSION, modelscanReducedSet } from "./modelscan.js";
import { PROMPTFOO_ENGINE_VERSION, PROMPTFOO_USAGE_DATA_ENV, promptfooManifestSets, promptfooReducedSet } from "./promptfoo.js";
import { ENGINE_SELF_TEST_MAX_AGE_SECONDS, type EngineId, type EngineKind, type EngineNotRunReason, type RunnerSelfTest } from "./contract.js";

/** how a named plugin/probe set is classed for the approvals rule (owner decision 4) */
export type EngineSetClass = "standard" | "agentic" | "offensive";

export interface EngineManifestEntry {
  id: EngineId;
  kind: EngineKind;
  displayName: string;
  /** the engine release the image is built from */
  version: string;
  /**
   * PR #205 review round 13 [95]: this manifest entry's generation — a positive integer that MUST be
   * bumped with every change of build (version or digest). Gateway replicas only ever move the engine
   * row forward: a replica whose generation is older than the row's writes nothing and treats the
   * engine as unavailable (ADR-0187 decision 95).
   */
  generation: number;
  /** the signed image's digest, or null until the engine's image is built */
  imageDigest: string | null;
  licence: string;
  /** null until G19 counts them */
  maintainerCount: number | null;
  /** the usage-data and remote-fetch switches: env name -> the value the runner must set */
  usageDataEnv: Readonly<Record<string, string>>;
  /** does a run need a virtual key (model access through the gateway)? */
  needsModelAccess: boolean;
  /** PR #205 review round 6 [73]: must an agent run name a judge agent? (run validation refuses one without) */
  requiresJudge: boolean;
  /**
   * PR #205 review round 9 [79]: does this build keep the runner credential out of the engine
   * process's reach (a distinct OS identity, or a separate container)? false = the engine process
   * runs as the runner's user and could read the credential; enabling then needs an explicit,
   * stepped-up, audited acceptance (ADR-0187 decision 79). No build has it yet (B5-P2 splits it).
   */
  credentialIsolation: boolean;
  /** the named sets this build classes; any set not listed counts as offensive (secure default) */
  sets: Readonly<Record<string, EngineSetClass>>;
  /** what an air-gapped install cannot run, published as data */
  airGappedReducedSet: ReadonlyArray<{ key: string; reason: EngineNotRunReason }>;
  /** ISO date of the last source review, and when it must be re-checked */
  lastVerified: string;
  reCheckBy: string;
  /** what is not verified yet, shown on the Engines page */
  unverified: readonly string[];
}

const UNVERIFIED_COMMON = [
  "image digest and signature (the image is built in the engine's own PR)",
  "air-gapped runtime behaviour",
  "maintainer count",
  "transitive licences inside the image",
  "exit codes and report schema",
] as const;

export const ENGINE_MANIFEST: Readonly<Record<EngineId, EngineManifestEntry>> = Object.freeze({
  promptfoo: {
    id: "promptfoo",
    kind: "redteam",
    displayName: "promptfoo",
    // pinned to the release the vendored OWASP mapping tables come from (ADR-0187: one moves to match the other)
    version: PROMPTFOO_ENGINE_VERSION,
    // round 13 [95]: bump with every build change (version or digest)
    generation: 1,
    // B5-P: the image (engines/promptfoo/Dockerfile) has not been built anywhere that could
    // report a real digest, so this stays null and the engine cannot be enabled (secure default)
    imageDigest: null,
    licence: "MIT",
    maintainerCount: null,
    usageDataEnv: PROMPTFOO_USAGE_DATA_ENV,
    needsModelAccess: true,
    // PR #205 review round 6 [73]: promptfoo grades with a judge behind the gateway (without one it
    // would fall back to a vendor default, which the config refuses)
    requiresJudge: true,
    credentialIsolation: false,
    // every set that runs here, by class; a set not listed is offensive (fail closed)
    sets: promptfooManifestSets(),
    // remote generation is off on every install, not only air-gapped ones: this never runs
    airGappedReducedSet: promptfooReducedSet(),
    lastVerified: "2026-10-08",
    reCheckBy: "2027-01-08",
    unverified: [
      "image digest and signature (the image is not built yet)",
      "maintainer count",
      "transitive licences: 11 npm packages carry permissive licences outside the ADR-0176 list (Artistic-2.0, BlueOak-1.0.0, Python-2.0) and await an owner decision; the base image OS layer is not yet scanned",
      "runtime behaviour inside the built image (egress test, air-gapped run)",
      "the disabled-telemetry path still attempts a request in 0.123.1: the image patches it, and network denial stays the control",
    ],
  },
  modelscan: {
    id: "modelscan",
    kind: "model_scan",
    displayName: "modelscan",
    // B5-M: pinned by hash in engines/modelscan/requirements.txt (image.test.ts keeps them in lockstep)
    version: MODELSCAN_ENGINE_VERSION,
    generation: 1,
    // B5-M: the image (engines/modelscan/Dockerfile) has not been built anywhere that could report a
    // real digest, so this stays null and the engine cannot be enabled (secure default)
    imageDigest: null,
    licence: "Apache-2.0",
    maintainerCount: null,
    // modelscan has no telemetry, update check or download (R10: measured under strace and with no
    // network at all), so it has no switch of its own. The one entry here is the SCANNER container's
    // own egress self-test (network_mode: none), which the runner reports as true only when that
    // report is fresh, names the pinned version and reached nothing (ADR-0187 decision 104;
    // packages/engine-modelscan/src/selftest.ts). Network denial is the control.
    usageDataEnv: { REGULAIT_MODELSCAN_SCANNER_ISOLATED: "1" },
    needsModelAccess: false,
    requiresJudge: false,
    // B5-M: the scanner already runs in its own container with no network and no runner token
    // (ADR-0187 decision 104), but the flag stays false until the built image is verified, so
    // decision 79's gate applies: enabling needs the audited, stepped-up acceptance
    credentialIsolation: false,
    // one set: scan the target artifact. Any other set is unclassified (offensive: approval first).
    sets: { scan: "standard" },
    // planning-time exclusions (decision 61): a format this build has no scanner for
    airGappedReducedSet: modelscanReducedSet(),
    lastVerified: "2026-10-09",
    // maintenance only: the 12-month release rule lapses on 2027-02-18 (R10; ADR-0187 open question 3)
    reCheckBy: "2027-02-18",
    unverified: [
      "image digest and signature (the image is not built yet)",
      "maintainer count (the repository's merge rights could not be read)",
      "transitive licences: numpy's wheel bundles libgfortran (GPL-3.0-or-later WITH GCC-exception-3.1) and libquadmath (LGPL-2.1-or-later) and carries Zlib code; h5py bundles HDF5 (BSD-style, not on the ADR-0176 list); the Python runtime is PSF-2.0. Each is admitted only through engines/modelscan/licence-allow.json, every entry pending an owner decision; the base image OS layer is not yet scanned",
      "advisories of the Python closure (pip-audit or OSV at the first image build)",
      "runtime behaviour inside the built image (egress test, the scanner's no-network container)",
      "what a clean result means: modelscan is a deny-list, so an executable format never passes (pending owner confirmation)",
    ],
  },
  garak: {
    id: "garak",
    kind: "redteam",
    displayName: "garak",
    version: "0.17.0",
    generation: 1,
    imageDigest: null,
    licence: "Apache-2.0",
    maintainerCount: null,
    usageDataEnv: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
    needsModelAccess: true,
    requiresJudge: false,
    credentialIsolation: false,
    sets: {},
    airGappedReducedSet: [],
    lastVerified: "2026-10-08",
    reCheckBy: "2027-01-08",
    unverified: [...UNVERIFIED_COMMON, "whether the offline environment fully localises the Hugging Face loaders"],
  },
});

/** the class of a named set; a set the manifest does not list is `offensive` (fail closed) */
export function engineSetClass(manifest: EngineManifestEntry, set: string): EngineSetClass {
  return Object.prototype.hasOwnProperty.call(manifest.sets, set) ? manifest.sets[set]! : "offensive";
}

/** does this run config use a set that needs approval (agentic, offensive or unclassified)? */
export function engineConfigNeedsApproval(manifest: EngineManifestEntry, sets: readonly string[]): boolean {
  return sets.some((s) => engineSetClass(manifest, s) !== "standard");
}

export type SelfTestFailure =
  | "image_not_built"
  | "digest_mismatch"
  | "version_mismatch"
  | `usage_env_missing:${string}`
  | "egress_dns_resolved"
  | "egress_connected"
  | "egress_address_missing"
  | "egress_address_connected"
  | "stale";

export interface SelfTestVerdict {
  passed: boolean;
  failures: SelfTestFailure[];
}

/**
 * Does a runner's reported self-test admit enabling its engine? Every check
 * must hold: the manifest has a built image and the runner runs exactly it,
 * the version matches, every usage-data switch the manifest names is set, an
 * external host neither resolved nor connected, and the report is fresh. Any
 * failure is named; there is no partial pass.
 */
export function evaluateRunnerSelfTest(
  manifest: EngineManifestEntry,
  report: RunnerSelfTest,
  now: Date,
): SelfTestVerdict {
  const failures: SelfTestFailure[] = [];
  if (manifest.imageDigest === null) failures.push("image_not_built");
  else if (report.imageDigest !== manifest.imageDigest) failures.push("digest_mismatch");
  if (report.engineVersion !== manifest.version) failures.push("version_mismatch");
  for (const name of Object.keys(manifest.usageDataEnv)) {
    if (report.usageDataEnv[name] !== true) failures.push(`usage_env_missing:${name}`);
  }
  if (report.egress.dnsResolved) failures.push("egress_dns_resolved");
  if (report.egress.connected) failures.push("egress_connected");
  // PR #203 review [4]: a blocked resolver must not mask routable egress, so a
  // PUBLIC literal address is always probed too, with no resolver involved
  if (!isPublicAddress(report.egress.address)) failures.push("egress_address_missing");
  else if (report.egress.addressConnected) failures.push("egress_address_connected");
  const at = Date.parse(report.at);
  if (!Number.isFinite(at) || now.getTime() - at > ENGINE_SELF_TEST_MAX_AGE_SECONDS * 1000 || at - now.getTime() > 300_000) {
    failures.push("stale");
  }
  return { passed: failures.length === 0, failures };
}

/**
 * Is `addr` a globally routable literal address (IPv4 dotted quad, or IPv6)?
 * Loopback, private, link-local, shared (CGNAT), multicast, unspecified,
 * benchmarking and documentation ranges are not: a probe to one of them fails
 * on any network and so proves nothing about egress.
 */
export function isPublicAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
  if (v4) {
    const [a, b, c] = v4.slice(1, 4).map(Number) as [number, number, number];
    if (v4.slice(1).some((o) => Number(o) > 255)) return false;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    if (a === 198 && b === 51 && c === 100) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (!/^[0-9a-fA-F:]+$/.test(addr) || !addr.includes(":")) return false;
  const lower = addr.toLowerCase();
  if (lower === "::" || lower === "::1") return false;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  // global unicast is 2000::/3; documentation 2001:db8::/32 is not
  if ((first & 0xe000) !== 0x2000) return false;
  if (lower.startsWith("2001:db8:") || lower.startsWith("2001:0db8:")) return false;
  return true;
}
