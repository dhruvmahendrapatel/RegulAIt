/**
 * ADR-0187 B5-M — the modelscan engine without the Python engine: format detection from bytes, the
 * mapper's rules, and the RED PROOFS end to end through the real adapter, the shared normaliser and
 * the gateway's verdict function, with modelscan's answers replayed from the reports the pinned
 * 0.8.8 actually wrote for these fixtures (modelscan-real.test.ts runs the engine itself, opt-in).
 * Each guard was shown red by breaking it (ADR-0187 decisions 104 onward).
 */
import { describe, expect, it } from "vitest";
import {
  ARTIFACT_FORMAT_PLANS,
  ARTIFACT_FORMATS,
  deriveArtifactScanVerdict,
  detectArtifactFormat,
  hdf5SuperblockOffsets,
  mapModelscanReport,
  modelscanArtifactName,
  type ArtifactFormat,
} from "@regulait/shared";
import type { ScanExecutor, ScanJob } from "./exchange.js";
import type { ModelscanOutcome } from "./scan.js";
import {
  cleanPickle,
  legacyTorchFile,
  maliciousPickle,
  nestedZip,
  objectNpy,
  protocol0MaliciousPickle,
  safetensorsFile,
  storedZip,
  torchZip,
  truncatedMaliciousPickle,
} from "./fixtures.js";
import { bufferReader, scanAndJudge } from "./harness.js";
import { settingsScanExtension } from "./settings.js";

const detect = async (b: Buffer) => (await detectArtifactFormat(bufferReader(b))).format;

/** a modelscan 0.8.8 report, as the pinned engine writes it */
function report(p: { scanned?: string[]; issues?: Array<{ module: string; operator: string; source: string; severity?: string }>; errors?: Array<{ category: string; source?: string }>; skipped?: number }) {
  return {
    summary: {
      total_issues_by_severity: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: (p.issues ?? []).length },
      total_issues: (p.issues ?? []).length,
      input_path: "x",
      absolute_path: "/x",
      modelscan_version: "0.8.8",
      timestamp: "2026-10-09T15:47:41.677311",
      scanned: (p.scanned ?? []).length ? { total_scanned: p.scanned!.length, scanned_files: p.scanned } : { total_scanned: 0 },
      skipped: { total_skipped: p.skipped ?? 0, skipped_files: Array.from({ length: p.skipped ?? 0 }, () => ({ category: "SCAN_NOT_SUPPORTED", description: "d", source: "artifact.zip" })) },
    },
    issues: (p.issues ?? []).map((i) => ({ description: "Use of unsafe operator", operator: i.operator, module: i.module, source: i.source, scanner: "modelscan.scanners.PickleUnsafeOpScan", severity: i.severity ?? "CRITICAL" })),
    errors: (p.errors ?? []).map((e) => ({ category: e.category, description: "d", ...(e.source ? { source: e.source } : {}) })),
  };
}

/** an executor that answers like modelscan would, from a function of the job */
function replay(answer: (job: ScanJob) => { exitCode: number | null; report?: unknown; timedOut?: boolean }): (root: string) => ScanExecutor & { jobs: ScanJob[] } {
  return () => {
    const jobs: ScanJob[] = [];
    return {
      jobs,
      async stage() {
        const { mkdtemp } = await import("node:fs/promises");
        const { tmpdir } = await import("node:os");
        return mkdtemp(`${tmpdir()}/b5m-stage-`);
      },
      async scan(job: ScanJob): Promise<ModelscanOutcome> {
        jobs.push(job);
        const a = answer(job);
        const bytes = a.report === undefined ? null : Buffer.from(JSON.stringify(a.report));
        return { exitCode: a.exitCode, timedOut: a.timedOut ?? false, cancelled: false, report: bytes, reportSha256: bytes ? "0".repeat(64) : null, reportTooLarge: false };
      },
      async release() {},
      async reconcile() {
        return [];
      },
    };
  };
}

/** an executor answering one fixed outcome (what the pinned 0.8.8 answered for the fixture, measured) */
const answer = (a: { exitCode: number | null; report?: unknown; timedOut?: boolean }) => replay(() => a);
/** for formats and failures where modelscan must never be started */
const NEVER = replay(() => {
  throw new Error("modelscan must not be started");
});

describe("B5-M format detection: from the bytes, never the name", () => {
  it("recognises every fixture by content", async () => {
    expect(await detect(maliciousPickle())).toBe("pickle");
    expect(await detect(cleanPickle())).toBe("pickle");
    expect(await detect(legacyTorchFile())).toBe("pytorch_legacy");
    expect(await detect(torchZip(maliciousPickle()))).toBe("pytorch_zip");
    expect(await detect(nestedZip())).toBe("zip_opaque");
    expect(await detect(storedZip([{ name: "a.pkl", data: maliciousPickle(), encrypted: true }]))).toBe("zip_opaque");
    expect(await detect(storedZip([{ name: "a.npy", data: objectNpy(maliciousPickle()) }]))).toBe("numpy_npz");
    expect(await detect(storedZip([{ name: "readme.txt", data: Buffer.from("x") }]))).toBe("zip");
    expect(await detect(objectNpy(maliciousPickle()))).toBe("numpy");
    expect(await detect(safetensorsFile())).toBe("safetensors");
    expect(await detect(Buffer.from("GGUF\x03\x00\x00\x00rest"))).toBe("gguf");
    expect(await detect(Buffer.from([0x1f, 0x8b, 8, 0, 0, 0]))).toBe("compressed");
    expect(await detect(Buffer.from([0x78, 0x9c, 1, 2]))).toBe("compressed");
    expect(await detect(Buffer.alloc(0))).toBe("empty");
    expect(await detect(protocol0MaliciousPickle())).toBe("unrecognised");
  });

  it("PR #212 review [4235322383]: an HDF5 superblock behind any power-of-two user block is HDF5, up to the file size", async () => {
    const SIG = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
    const at = (offset: number, size = offset + 64) => {
      const b = Buffer.alloc(size, 0x20);
      SIG.copy(b, offset);
      return b;
    };
    for (const offset of [0, 512, 2048, 4096, 65536, 1 << 20, 1 << 22]) expect(await detect(at(offset)), `offset ${offset}`).toBe("keras_h5");
    // not a power of two: not a superblock position
    expect(await detect(at(3000))).not.toBe("keras_h5");
    // the probe's bound is the file size: every power of two whose signature fits, no further
    expect(hdf5SuperblockOffsets(7)).toEqual([]);
    expect(hdf5SuperblockOffsets(4104)).toEqual([0, 512, 1024, 2048, 4096]);
    expect(hdf5SuperblockOffsets(4103)).toEqual([0, 512, 1024, 2048]);
    expect(hdf5SuperblockOffsets(8 * 1024 ** 3).length).toBe(25);
  });

  it("a safetensors header must account for the data exactly", async () => {
    expect(await detect(safetensorsFile(undefined, { trailing: 4 }))).toBe("safetensors_invalid");
    const overlap = safetensorsFile(undefined, { header: { a: { dtype: "F32", shape: [2], data_offsets: [0, 8] }, b: { dtype: "F32", shape: [2], data_offsets: [4, 12] } } });
    expect(await detect(overlap)).toBe("safetensors_invalid");
    const wrongLen = safetensorsFile(undefined, { header: { a: { dtype: "F32", shape: [3], data_offsets: [0, 8] } } });
    expect(await detect(wrongLen)).toBe("safetensors_invalid");
    const extraField = safetensorsFile([["w", "F32", [1]]], { header: { w: { dtype: "F32", shape: [1], data_offsets: [0, 4], code: "x" } } });
    expect(await detect(extraField)).toBe("safetensors_invalid");
    const unknownDtype = safetensorsFile([["w", "F32", [1]]], { header: { w: { dtype: "PICKLE", shape: [1], data_offsets: [0, 4] } } });
    expect(await detect(unknownDtype)).toBe("safetensors_invalid");
  });

  it("PR #212 review [4234946089]: anything not proven safetensors is executable", () => {
    expect(ARTIFACT_FORMATS.filter((f) => !ARTIFACT_FORMAT_PLANS[f].executable)).toEqual(["safetensors"]);
  });

  it("every format has a plan, and every extension a plan hands modelscan is one its settings scan", () => {
    for (const f of ARTIFACT_FORMATS) {
      const plan = ARTIFACT_FORMAT_PLANS[f];
      expect(plan).toBeDefined();
      if (plan.scanAs) expect(settingsScanExtension(plan.scanAs)).toBe(true);
      // only a non-executable format may ever reach clean
      if (plan.ceiling === "clean") expect(plan.executable).toBe(false);
    }
    expect(ARTIFACT_FORMATS.filter((f) => ARTIFACT_FORMAT_PLANS[f].ceiling === "clean")).toEqual(["safetensors"]);
    // the legacy layout is scanned as a pickle STREAM (modelscan's PyTorch scanner reads only its first pickle)
    expect(modelscanArtifactName("pytorch_legacy")).toBe("artifact.pkl");
  });
});

describe("B5-M mapper: the -o report decides, never stdout or the exit code alone", () => {
  const map = (format: ArtifactFormat, exitCode: number | null, r: unknown, timedOut = false) =>
    mapModelscanReport({ format, exitCode, timedOut, report: r === null ? null : Buffer.from(typeof r === "string" ? r : JSON.stringify(r)) });

  it("issues are findings whatever the exit code", () => {
    const body = map("pickle", 2, report({ scanned: ["artifact.pkl"], issues: [{ module: "os", operator: "system", source: "artifact.pkl" }], errors: [{ category: "PICKLE_GENOPS" }] }));
    expect(body.items.filter((i) => i.verdict === "fail" && i.sourceTaxonomy.system === "modelscan-operator")).toHaveLength(1);
    // exit 0 with an issue contradicts the report: the run fails, and the finding is still kept
    const contradicted = map("pickle", 0, report({ scanned: ["artifact.pkl"], issues: [{ module: "os", operator: "system", source: "artifact.pkl" }] }));
    expect(contradicted.status).toBe("failed");
    expect(contradicted.errorCode).toBe("report_inconsistent");
    expect(contradicted.items.some((i) => i.sourceTaxonomy.system === "modelscan-operator" && i.verdict === "fail")).toBe(true);
  });

  it("errors are unknown; nothing scanned is a run-time not-run", () => {
    const err = map("pickle", 3, report({ errors: [{ category: "PICKLE_GENOPS", source: "artifact.pkl" }] }));
    expect(err.items.some((i) => i.verdict === "unknown" && i.sourceTaxonomy.system === "modelscan-error")).toBe(true);
    expect(err.notRun).toContainEqual({ key: "modelscan/scan", reason: "engine_error" });
  });

  it("exit 4, a missing, unparsable or oversized report, or a timeout fail the run", () => {
    expect(map("pickle", 4, report({ scanned: ["artifact.pkl"] })).status).toBe("failed");
    expect(map("pickle", 0, null).errorCode).toBe("report_missing");
    expect(map("pickle", 0, "{not json").errorCode).toBe("report_invalid");
    expect(map("pickle", 0, { summary: {} }).errorCode).toBe("report_invalid");
    expect(map("pickle", null, null, true).errorCode).toBe("engine_timeout");
    expect(mapModelscanReport({ format: "pickle", exitCode: 0, timedOut: false, report: "too_large" }).errorCode).toBe("report_too_large");
  });

  it("PR #212 review [4234946100]: a summary that disagrees with its own lists is report_inconsistent, never clean", () => {
    const lying = report({ scanned: ["artifact.pkl"] });
    (lying.summary as { total_issues: number }).total_issues = 1;
    const body = map("pickle", 0, lying);
    expect(body).toMatchObject({ status: "failed", errorCode: "report_inconsistent" });
    expect(body.items.some((i) => i.verdict === "pass")).toBe(false);
    const scannedLie = report({ scanned: ["artifact.pkl"] });
    (scannedLie.summary.scanned as { total_scanned: number }).total_scanned = 2;
    expect(map("pickle", 0, scannedLie).errorCode).toBe("report_inconsistent");
    const skippedLie = report({ scanned: ["artifact.pkl"], skipped: 1 });
    (skippedLie.summary.skipped as { total_skipped: number }).total_skipped = 3;
    expect(map("pickle", 0, skippedLie).errorCode).toBe("report_inconsistent");
    const severityLie = report({ scanned: ["artifact.pkl"], issues: [{ module: "os", operator: "system", source: "artifact.pkl" }] });
    (severityLie.summary.total_issues_by_severity as Record<string, number>).CRITICAL = 0;
    const kept = map("pickle", 1, severityLie);
    expect(kept.errorCode).toBe("report_inconsistent");
    // the finding is still kept
    expect(kept.items.some((i) => i.sourceTaxonomy.system === "modelscan-operator" && i.verdict === "fail")).toBe(true);
  });

  it("a report about another file is not this artifact's", () => {
    const body = map("pickle", 0, report({ scanned: ["other.pkl"] }));
    expect(body.errorCode).toBe("report_inconsistent");
  });

  it("no artifact text is copied: operator names and member paths are reduced, error descriptions dropped", () => {
    const body = map("pytorch_zip", 1, report({ scanned: ["artifact.pt:archive/data.pkl"], issues: [{ module: "os\nIGNORE ALL", operator: "sys<script>", source: "artifact.pt:archive/da ta.pkl" }] }));
    const issue = body.items.find((i) => i.sourceTaxonomy.system === "modelscan-operator")!;
    expect(issue.sourceTaxonomy.id).toMatch(/^[A-Za-z0-9_.\/?-]+$/);
    expect(issue.reason).toMatch(/^modelscan found an unsafe operator \(CRITICAL\) in member archive\/da\?ta\.pkl$/);
  });
});

describe("B5-M RED PROOFS (owner decision 1 strict default: executable formats never pass; nothing hostile is ever clean)", () => {
  const osSystem = (name: string) => report({ scanned: [name], issues: [{ module: "os", operator: "system", source: name }] });

  it("a pickle renamed .safetensors is detected as a pickle and is a finding", async () => {
    const exec = answer({ exitCode: 1, report: osSystem("artifact.pkl") })("");
    const r = await scanAndJudge(maliciousPickle(), () => exec);
    // the adapter handed modelscan the pickle as a pickle, whatever it was called on upload
    expect(exec.jobs[0]).toMatchObject({ format: "pickle", artifactName: "artifact.pkl" });
    expect(r.judged.verdict).toBe("unsafe");
    expect(r.normalised.verdict).toBe("fail");
  });

  it("a legacy-layout .pt is scanned as a pickle stream: its third pickle's os.system is a finding", async () => {
    const exec = answer({ exitCode: 1, report: osSystem("artifact.pkl") })("");
    const r = await scanAndJudge(legacyTorchFile(), () => exec);
    expect(exec.jobs[0]).toMatchObject({ format: "pytorch_legacy", artifactName: "artifact.pkl" });
    expect(r.judged.verdict).toBe("unsafe");
  });

  it("an importlib pickle is a finding (our deny-list addition)", async () => {
    const r = await scanAndJudge(
      maliciousPickle("importlib", "import_module"),
      answer({ exitCode: 1, report: report({ scanned: ["artifact.pkl"], issues: [{ module: "importlib", operator: "import_module", source: "artifact.pkl" }] }) }),
    );
    expect(r.judged.verdict).toBe("unsafe");
  });

  it("a truncated malicious pickle (only a parse error) is unknown, never clean", async () => {
    const r = await scanAndJudge(truncatedMaliciousPickle(), answer({ exitCode: 3, report: report({ errors: [{ category: "PICKLE_GENOPS", source: "artifact.pkl" }] }) }));
    expect(r.judged.verdict).toBe("unknown");
    expect(r.normalised.verdict).not.toBe("pass");
  });

  it("a nested zip is opaque: unknown, never clean", async () => {
    const r = await scanAndJudge(nestedZip(), answer({ exitCode: 3, report: report({ errors: [{ category: "NESTED_ZIP", source: "artifact.zip:inner.zip" }], skipped: 1 }) }));
    expect(r.stored).toBe("zip_opaque");
    expect(r.judged.verdict).toBe("unknown");
  });

  it("a clean pickle is at best no_known_unsafe, with an executable-format finding; never clean", async () => {
    const r = await scanAndJudge(cleanPickle(), answer({ exitCode: 0, report: report({ scanned: ["artifact.pkl"] }) }));
    expect(r.judged.verdict).toBe("no_known_unsafe");
    expect(r.judged.findings).toContainEqual({ kind: "executable_format", id: "pickle", severity: "high" });
    expect(r.normalised.verdict).toBe("fail");
  });

  it("a protocol-0 pickle with no magic is scanned as a pickle and can never be better than unknown", async () => {
    const r = await scanAndJudge(protocol0MaliciousPickle(), answer({ exitCode: 0, report: report({ scanned: ["artifact.pkl"] }) }));
    expect(r.stored).toBe("unrecognised");
    expect(r.judged.verdict).toBe("unknown");
  });

  it("only a verified safetensors file is clean, and modelscan is never started for it", async () => {
    const r = await scanAndJudge(safetensorsFile(), NEVER);
    expect(r.judged.verdict).toBe("clean");
    expect(r.normalised.verdict).toBe("pass");
    const bad = await scanAndJudge(safetensorsFile(undefined, { trailing: 8 }), NEVER);
    expect(bad.judged.verdict).toBe("unknown");
    // PR #212 review [4234946089]: a safetensors prefix whose header does not verify is NOT proven safe:
    // it carries the executable-format finding, and stays unknown
    expect(bad.stored).toBe("safetensors_invalid");
    expect(bad.judged.findings).toContainEqual({ kind: "executable_format", id: "safetensors_invalid", severity: "high" });
  });

  it("an unsupported format is not run, never clean", async () => {
    const r = await scanAndJudge(Buffer.from("GGUF\x03\x00\x00\x00rest-of-file"), NEVER);
    expect(r.judged.verdict).toBe("not_run");
    expect(r.normalised.verdict).toBe("not_run");
  });

  it("engine error means unknown: exit 4, a missing report, a time-out", async () => {
    for (const a of [{ exitCode: 4, report: report({}) }, { exitCode: 0 }, { exitCode: null, timedOut: true }]) {
      const r = await scanAndJudge(cleanPickle(), answer(a));
      expect(r.envelope.status).toBe("failed");
      expect(r.judged.verdict).toBe("unknown");
    }
  });

  it("an artifact that does not arrive intact is never scanned (sha256 checked)", async () => {
    // same length, one byte different: only the sha256 can tell
    const swapped = Buffer.from(cleanPickle());
    swapped[swapped.length - 2] = swapped[swapped.length - 2]! ^ 0x01;
    const r = await scanAndJudge(cleanPickle(), NEVER, { fetchBytes: swapped });
    expect(r.envelope.errorCode).toBe("artifact_fetch_failed");
    expect(r.judged.verdict).toBe("unknown");
    // and a longer body is cut off and refused
    const longer = await scanAndJudge(cleanPickle(), NEVER, { fetchBytes: Buffer.concat([cleanPickle(), Buffer.from("x")]) });
    expect(longer.envelope.errorCode).toBe("artifact_fetch_failed");
  });

  it("the gateway does not trust a runner's own consistency: a passing scan beside an error item is unknown", () => {
    const judged = deriveArtifactScanVerdict({
      storedFormat: "pickle",
      runStatus: "completed",
      runVerdict: "fail",
      runtimeNotRun: 0,
      items: [
        { key: "format", sourceSystem: "regulait-artifact-format", sourceId: "pickle", verdict: "fail", severity: "high" },
        { key: "modelscan/scan", sourceSystem: "modelscan", sourceId: "scan", verdict: "pass", severity: "low" },
        { key: "modelscan/error/1", sourceSystem: "modelscan-error", sourceId: "PICKLE_GENOPS", verdict: "unknown", severity: "medium" },
      ],
    });
    expect(judged.verdict).toBe("unknown");
    // nor a runner that reports another format than the one the gateway detected at upload
    const relabelled = deriveArtifactScanVerdict({
      storedFormat: "pickle",
      runStatus: "completed",
      runVerdict: "fail",
      runtimeNotRun: 0,
      items: [
        { key: "format", sourceSystem: "regulait-artifact-format", sourceId: "zip", verdict: "fail", severity: "high" },
        { key: "modelscan/scan", sourceSystem: "modelscan", sourceId: "scan", verdict: "pass", severity: "low" },
      ],
    });
    expect(relabelled.verdict).toBe("unknown");
  });
});
