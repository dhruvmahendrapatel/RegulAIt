/**
 * ADR-0187 decisions 180–184 (closes open question 15(b)) — `.npy` artifacts. modelscan 0.8.8's NumPy
 * scanner fails on numpy 2.x (decision 108), so the scanner checks the header itself, strictly
 * (engines/modelscan/npy-header.py: stdlib `ast`, never eval), and then:
 *   - a plain numeric dtype has no pickle: modelscan is not started; the format's ceiling decides
 *     (`no_known_unsafe`, with the executable-format finding — decision 105 unchanged);
 *   - an object dtype's payload is a pickle stream: exactly those bytes go to modelscan's PICKLE
 *     scanner (as `artifact.pkl`);
 *   - anything malformed, oversized or ambiguous is `unknown` with a problem code; never `clean`.
 *
 * The helper runs under `python3 -I -S` (stdlib only, so no numpy is needed here). modelscan is a fake
 * that answers exactly as the pinned 0.8.8 does for the file it is handed (measured 2026-10-10: a
 * `.npy` is a MODEL_SCAN error, exit 3; `os.system` in a `.pkl` is a CRITICAL issue, exit 1; a benign
 * `.pkl` exits 0); modelscan-real.test.ts runs the engine itself (opt-in).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProcessGroupOptions, ProcessGroupResult } from "@regulait/engine-runner";
import { mapModelscanReport, type ArtifactFormat } from "@regulait/shared";
import { ExchangeScanExecutor, LocalScanExecutor, scannerTick } from "./exchange.js";
import { cleanPickle, maliciousPickle, npyFile, npyHeader, numericNpy, objectNpy } from "./fixtures.js";
import { scanAndJudge } from "./harness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HELPER = path.join(root, "engines/modelscan/npy-header.py");
const PYTHON = spawnSync("python3", ["--version"]).status === 0;
/** the absolute interpreter: the scanner runs the check with an environment built from nothing (no PATH to search) */
const PYTHON_BIN = PYTHON ? spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : "python3";

/** run the helper on `bytes`; returns its one JSON line, its exit status and the payload it copied */
async function check(bytes: Buffer, maxPayload = 1 << 20) {
  const dir = await mkdtemp(path.join(tmpdir(), "b5m-npy-"));
  try {
    const artifact = path.join(dir, "artifact.npy");
    const payload = path.join(dir, "payload.pkl");
    await writeFile(artifact, bytes);
    const r = spawnSync("python3", ["-I", "-S", HELPER, artifact, payload, String(maxPayload)], { encoding: "utf8", cwd: dir });
    return {
      status: r.status,
      out: r.status === 0 ? (JSON.parse(r.stdout) as Record<string, unknown>) : null,
      lines: r.stdout.split("\n").filter(Boolean).length,
      payload: existsSync(payload) ? await readFile(payload) : null,
      marker: existsSync(path.join(dir, "MARK")),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const problem = async (b: Buffer, max?: number) => (await check(b, max)).out;

describe.skipIf(!PYTHON)("ADR-0187 decision 180: the strict .npy header check", () => {
  it("a numeric .npy of version 1.0, 2.0 or 3.0 is numeric, and nothing is copied", async () => {
    for (const v of [[1, 0], [2, 0], [3, 0]] as const) {
      const r = await check(numericNpy(v));
      expect([v, r.status, r.out, r.lines, r.payload]).toEqual([v, 0, { kind: "numeric" }, 1, null]);
    }
    // every numeric dtype numpy's writer emits, and a 0-d and a multi-dimensional shape
    for (const [descr, size] of [["|b1", 1], ["|i1", 1], ["|u1", 1], ["<i8", 8], [">u2", 2], ["<f2", 2], ["<f16", 16], ["<c32", 32]] as const) {
      expect(await problem(npyFile({ header: npyHeader(descr, [2, 3]), payload: Buffer.alloc(6 * size) }))).toEqual({ kind: "numeric" });
    }
    expect(await problem(npyFile({ header: "{'descr': '<f8', 'fortran_order': True, 'shape': (), }", payload: Buffer.alloc(8) }))).toEqual({ kind: "numeric" });
  });

  it("an object .npy of version 1.0, 2.0 or 3.0: exactly the payload bytes are copied, as a pickle", async () => {
    for (const v of [[1, 0], [2, 0], [3, 0]] as const) {
      const r = await check(objectNpy(maliciousPickle(), v));
      expect([v, r.out]).toEqual([v, { kind: "object", payloadBytes: maliciousPickle().length }]);
      expect(r.payload?.equals(maliciousPickle())).toBe(true);
    }
  });

  it("a header that is not a plain literal dict is refused, and nothing in it runs", async () => {
    const mark = "__import__('os').system('touch MARK')";
    for (const header of [
      `{'descr': ${mark}, 'fortran_order': False, 'shape': (3,), }`,
      `{'descr': '<f8', 'fortran_order': False, 'shape': (3,), **{'x': 1}}`,
      "dict(descr='<f8', fortran_order=False, shape=(3,))",
      "{'descr': '<f8', 'fortran_order': False, 'shape': (3,), ",
      `{'descr': ${"(".repeat(3000)}'<f8'${")".repeat(3000)}, 'fortran_order': False, 'shape': (3,), }`,
    ]) {
      const r = await check(npyFile({ header, payload: Buffer.alloc(24) }));
      expect([header.slice(0, 40), r.out?.kind]).toEqual([header.slice(0, 40), "invalid"]);
      expect(["npy_header_not_literal", "npy_header_keys"]).toContain(r.out?.problem);
      expect(r.marker).toBe(false);
    }
    // the header must be what numpy's writer produces: a dict display ended by a newline
    expect(await problem(npyFile({ header: npyHeader("<f8", [3]), payload: Buffer.alloc(24), pad: false }))).toEqual({ kind: "invalid", problem: "npy_header_not_literal" });
  });

  it("an extra, a missing or a repeated key is refused (numpy itself keeps the LAST of a repeated key)", async () => {
    const keys = { kind: "invalid", problem: "npy_header_keys" };
    expect(await problem(npyFile({ header: "{'descr': '<f8', 'fortran_order': False, 'shape': (3,), 'extra': 1, }", payload: Buffer.alloc(24) }))).toEqual(keys);
    expect(await problem(npyFile({ header: "{'descr': '<f8', 'shape': (3,), }", payload: Buffer.alloc(24) }))).toEqual(keys);
    // a numeric-looking first descr and an object last one: ambiguous
    expect(await problem(npyFile({ header: "{'descr': '<f8', 'descr': '|O', 'fortran_order': False, 'shape': (1,), }", payload: maliciousPickle() }))).toEqual(keys);
    expect(await problem(npyFile({ header: "{1: '<f8', 'fortran_order': False, 'shape': (3,), }", payload: Buffer.alloc(24) }))).toEqual(keys);
  });

  it("a header length beyond its bounds is refused", async () => {
    const h = npyHeader("<f8", [3]);
    expect(await problem(npyFile({ header: h, payload: Buffer.alloc(24), headerLength: 0 }))).toEqual({ kind: "invalid", problem: "npy_header_length" });
    // numpy's own default bound is 10000 bytes
    const huge = npyFile({ header: h + " ".repeat(10_100), payload: Buffer.alloc(24), version: [2, 0] });
    expect(await problem(huge)).toEqual({ kind: "invalid", problem: "npy_header_length" });
    // a length that runs past the end of the file
    expect(await problem(npyFile({ header: h, payload: Buffer.alloc(0), headerLength: 9000, version: [2, 0] }))).toEqual({ kind: "invalid", problem: "npy_truncated" });
  });

  it("a truncated file is refused, wherever it is cut", async () => {
    const full = numericNpy([2, 0]);
    for (const n of [0, 5, 8, 10, 40, full.length - 1]) {
      expect([n, await problem(full.subarray(0, n))]).toEqual([n, { kind: "invalid", problem: "npy_truncated" }]);
    }
    // an object array with no payload at all
    expect(await problem(npyFile({ header: npyHeader("|O", [1]), payload: Buffer.alloc(0) }))).toEqual({ kind: "invalid", problem: "npy_truncated" });
  });

  it("only versions 1.0, 2.0 and 3.0, and only the NumPy magic", async () => {
    for (const v of [[4, 0], [1, 1], [0, 0], [2, 1]] as const) {
      expect([v, await problem(numericNpy(v))]).toEqual([v, { kind: "invalid", problem: "npy_version_unsupported" }]);
    }
    const bad = Buffer.from(numericNpy());
    bad[1] = 0x6e; // "nUMPY"
    expect(await problem(bad)).toEqual({ kind: "invalid", problem: "npy_magic_invalid" });
  });

  it("values, dtypes, trailing bytes, the payload bound and the encoding are strict", async () => {
    const value = { kind: "invalid", problem: "npy_header_value" };
    expect(await problem(npyFile({ header: "{'descr': '<f8', 'fortran_order': 0, 'shape': (3,), }", payload: Buffer.alloc(24) }))).toEqual(value);
    expect(await problem(npyFile({ header: "{'descr': '<f8', 'fortran_order': False, 'shape': (-3,), }", payload: Buffer.alloc(0) }))).toEqual(value);
    expect(await problem(npyFile({ header: "{'descr': '<f8', 'fortran_order': False, 'shape': [3], }", payload: Buffer.alloc(24) }))).toEqual(value);
    expect(await problem(npyFile({ header: "{'descr': '<f8', 'fortran_order': False, 'shape': (True,), }", payload: Buffer.alloc(8) }))).toEqual(value);
    const dtype = { kind: "invalid", problem: "npy_dtype_unsupported" };
    // a structured dtype (its fields could hold objects), a string dtype, an object dtype spelled otherwise
    expect(await problem(npyFile({ header: "{'descr': [('a', '|O')], 'fortran_order': False, 'shape': (1,), }", payload: maliciousPickle() }))).toEqual(dtype);
    expect(await problem(npyFile({ header: npyHeader("<U4", [1]), payload: Buffer.alloc(16) }))).toEqual(dtype);
    expect(await problem(npyFile({ header: npyHeader("<O", [1]), payload: maliciousPickle() }))).toEqual(dtype);
    expect(await problem(npyFile({ header: npyHeader("<f8", [3]), payload: Buffer.alloc(25) }))).toEqual({ kind: "invalid", problem: "npy_trailing_bytes" });
    expect(await problem(objectNpy(maliciousPickle()), 8)).toEqual({ kind: "invalid", problem: "npy_payload_too_large" });
    expect(await problem(npyFile({ header: "{'descr': '<f8', 'fortran_order': False, 'shape': (3,), } é", payload: Buffer.alloc(24), version: [3, 0] }))).toEqual({
      kind: "invalid",
      problem: "npy_header_encoding",
    });
  });
});

// ---------------------------------------------------------------------------------------------------

/** a modelscan 0.8.8 report as the pinned engine writes it */
function report088(p: { scanned?: string[]; issue?: string; error?: string; skipped?: string }) {
  return {
    summary: {
      total_issues_by_severity: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: p.issue ? 1 : 0 },
      total_issues: p.issue ? 1 : 0,
      input_path: "x",
      absolute_path: "/x",
      modelscan_version: "0.8.8",
      timestamp: "2026-10-10T03:57:34.557884",
      scanned: p.scanned?.length ? { total_scanned: p.scanned.length, scanned_files: p.scanned } : { total_scanned: 0 },
      skipped: p.skipped
        ? { total_skipped: 1, skipped_files: [{ category: "SCAN_NOT_SUPPORTED", description: "Model Scan did not scan file", source: p.skipped }] }
        : { total_skipped: 0, skipped_files: [] },
    },
    issues: p.issue
      ? [{ description: "Use of unsafe operator 'system' from module 'os'", operator: "system", module: "os", source: p.issue, scanner: "modelscan.scanners.PickleUnsafeOpScan", severity: "CRITICAL" }]
      : [],
    errors: p.error ? [{ category: "MODEL_SCAN", description: "module 'numpy.lib.format' has no attribute '_check_version'", source: p.error }] : [],
  };
}

/** a fake modelscan that answers as the pinned 0.8.8 does for the file it is handed; records each call */
function modelscan088(calls: Array<{ name: string; bytes: Buffer }>) {
  return async (_cmd: string, args: readonly string[], _opts: ProcessGroupOptions): Promise<ProcessGroupResult> => {
    const file = args[args.indexOf("-p") + 1]!;
    const out = args[args.indexOf("-o") + 1]!;
    const name = path.basename(file);
    const bytes = await readFile(file);
    calls.push({ name, bytes });
    let code: number;
    let rep: unknown;
    if (name.endsWith(".npy")) {
      code = 3;
      rep = report088({ error: name, skipped: name });
    } else if (bytes.includes(Buffer.from("system"))) {
      code = 1;
      rep = report088({ scanned: [name], issue: name });
    } else {
      code = 0;
      rep = report088({ scanned: [name] });
    }
    await writeFile(out, JSON.stringify(rep));
    return { exitCode: code, signal: null, killed: false, stdout: "not parsed", stderr: "" };
  };
}

function local(calls: Array<{ name: string; bytes: Buffer }>) {
  return (dir: string) => new LocalScanExecutor(dir, { run: modelscan088(calls), python: PYTHON_BIN, npyHelper: HELPER });
}

describe.skipIf(!PYTHON)("ADR-0187 decision 181: .npy through the adapter, the scanner and the gateway's verdict", () => {
  it("a numeric .npy (1.0, 2.0, 3.0) is no_known_unsafe with the executable-format finding; modelscan is never started", async () => {
    for (const v of [[1, 0], [2, 0], [3, 0]] as const) {
      const calls: Array<{ name: string; bytes: Buffer }> = [];
      const r = await scanAndJudge(numericNpy(v), local(calls));
      expect([v, r.stored, r.envelope.status, r.judged.verdict]).toEqual([v, "numpy", "completed", "no_known_unsafe"]);
      expect(r.judged.findings).toContainEqual({ kind: "executable_format", id: "numpy", severity: "high" });
      expect(calls).toEqual([]);
    }
  });

  it("an object .npy with a benign pickle: modelscan's pickle scanner gets exactly the payload, and the verdict is no_known_unsafe", async () => {
    const calls: Array<{ name: string; bytes: Buffer }> = [];
    const r = await scanAndJudge(objectNpy(cleanPickle(), [2, 0]), local(calls));
    expect(calls.map((c) => c.name)).toEqual(["artifact.pkl"]);
    expect(calls[0]!.bytes.equals(cleanPickle())).toBe(true);
    expect(r.envelope.status).toBe("completed");
    expect(r.judged.verdict).toBe("no_known_unsafe");
  });

  it("an object .npy whose pickle calls os.system is unsafe", async () => {
    for (const v of [[1, 0], [3, 0]] as const) {
      const calls: Array<{ name: string; bytes: Buffer }> = [];
      const r = await scanAndJudge(objectNpy(maliciousPickle(), v), local(calls));
      expect([v, r.judged.verdict]).toEqual([v, "unsafe"]);
      expect(r.judged.findings).toContainEqual({ kind: "unsafe_operator", id: "os.system", severity: "critical" });
      expect(calls[0]!.bytes.equals(maliciousPickle())).toBe(true);
    }
  });

  it("a malformed header is unknown with its problem code, never clean, and modelscan is never started", async () => {
    const cases: Array<[Buffer, string]> = [
      [npyFile({ header: "{'descr': '<f8', 'fortran_order': False, 'shape': (3,), 'x': 1, }", payload: Buffer.alloc(24) }), "npy_header_keys"],
      [npyFile({ header: "{'descr': __import__('os').system('id'), 'fortran_order': False, 'shape': (3,), }", payload: Buffer.alloc(24) }), "npy_header_not_literal"],
      [npyFile({ header: npyHeader("<f8", [3]), payload: Buffer.alloc(24), headerLength: 20_000, version: [2, 0] }), "npy_header_length"],
      [numericNpy().subarray(0, 100), "npy_truncated"],
      [numericNpy([4, 0]), "npy_version_unsupported"],
    ];
    for (const [bytes, code] of cases) {
      const calls: Array<{ name: string; bytes: Buffer }> = [];
      const r = await scanAndJudge(bytes, local(calls));
      expect([code, r.stored, r.judged.verdict]).toEqual([code, "numpy", "unknown"]);
      expect(r.judged.findings).toContainEqual({ kind: "scan_error", id: code, severity: "medium" });
      expect(calls).toEqual([]);
    }
  });

  it("a header check that does not answer properly is npy_check_failed: unknown, and modelscan is never started", async () => {
    const calls: Array<{ name: string; bytes: Buffer }> = [];
    const r = await scanAndJudge(objectNpy(maliciousPickle()), (dir) => new LocalScanExecutor(dir, { run: modelscan088(calls), python: PYTHON_BIN, npyHelper: path.join(root, "engines/modelscan/no-such-check.py") }));
    expect(r.judged.verdict).toBe("unknown");
    expect(r.judged.findings).toContainEqual({ kind: "scan_error", id: "npy_check_failed", severity: "medium" });
    expect(calls).toEqual([]);
  });

  it("the scanner container's answer carries the header check to the runner (done.json)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "b5m-npyx-"));
    const jobs = path.join(dir, "jobs");
    const results = path.join(dir, "results");
    await mkdir(jobs);
    await mkdir(results);
    const calls: Array<{ name: string; bytes: Buffer }> = [];
    const stop = new AbortController();
    const scanner = (async () => {
      while (!stop.signal.aborted) {
        await scannerTick({ jobsRoot: jobs, resultsRoot: results, pollMs: 10, modelscan: { run: modelscan088(calls), python: PYTHON_BIN, npyHelper: HELPER } });
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    try {
      const exchange = () => new ExchangeScanExecutor(jobs, results, { pollMs: 10 });
      expect((await scanAndJudge(objectNpy(maliciousPickle()), exchange)).judged.verdict).toBe("unsafe");
      expect((await scanAndJudge(numericNpy([3, 0]), exchange)).judged.verdict).toBe("no_known_unsafe");
      const bad = await scanAndJudge(numericNpy([1, 1]), exchange);
      expect(bad.judged.verdict).toBe("unknown");
      expect(bad.judged.findings).toContainEqual({ kind: "scan_error", id: "npy_version_unsupported", severity: "medium" });
      expect(calls.map((c) => c.name)).toEqual(["artifact.pkl"]);
    } finally {
      stop.abort();
      await scanner;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ADR-0187 decision 182: the mapper reads the header check, never a .npy report alone", () => {
  const numpy: ArtifactFormat = "numpy";
  const pkl = (r: unknown) => Buffer.from(JSON.stringify(r));

  it("a .npy scan with no header check is never better than unknown", () => {
    const m = mapModelscanReport({ format: numpy, exitCode: 0, timedOut: false, report: pkl(report088({ scanned: ["artifact.npy"] })) });
    expect(m.status).toBe("failed");
    expect(m.errorCode).toBe("npy_check_missing");
    expect(m.items.find((i) => i.key === "modelscan/scan")?.verdict).toBe("unknown");
  });

  it("numeric: passes only when modelscan was not run; a report beside it is inconsistent", () => {
    const ok = mapModelscanReport({ format: numpy, exitCode: null, timedOut: false, report: null, npy: { kind: "numeric" } });
    expect(ok.status).toBe("completed");
    expect(ok.items.find((i) => i.key === "modelscan/scan")?.verdict).toBe("pass");
    const odd = mapModelscanReport({ format: numpy, exitCode: 0, timedOut: false, report: pkl(report088({ scanned: ["artifact.pkl"] })), npy: { kind: "numeric" } });
    expect(odd.errorCode).toBe("report_inconsistent");
  });

  it("object: the report must be about the payload (artifact.pkl), not the .npy", () => {
    const ok = mapModelscanReport({ format: numpy, exitCode: 1, timedOut: false, report: pkl(report088({ scanned: ["artifact.pkl"], issue: "artifact.pkl" })), npy: { kind: "object", payloadBytes: 20 } });
    expect(ok.status).toBe("completed");
    expect(ok.items.some((i) => i.sourceTaxonomy.system === "modelscan-operator" && i.verdict === "fail")).toBe(true);
    const foreign = mapModelscanReport({ format: numpy, exitCode: 0, timedOut: false, report: pkl(report088({ scanned: ["artifact.npy"] })), npy: { kind: "object", payloadBytes: 20 } });
    expect(foreign.errorCode).toBe("report_inconsistent");
  });

  it("invalid: unknown, with the problem code as a scan error; a time-out still wins", () => {
    const bad = mapModelscanReport({ format: numpy, exitCode: null, timedOut: false, report: null, npy: { kind: "invalid", problem: "npy_header_keys" } });
    expect(bad.status).toBe("completed");
    expect(bad.items.find((i) => i.key === "modelscan/scan")?.verdict).toBe("unknown");
    expect(bad.items).toContainEqual(expect.objectContaining({ sourceTaxonomy: { system: "modelscan-error", id: "npy_header_keys" }, verdict: "unknown" }));
    expect(mapModelscanReport({ format: numpy, exitCode: null, timedOut: true, report: null, npy: null }).errorCode).toBe("engine_timeout");
  });

  it("the header check is ignored for every other format", () => {
    const m = mapModelscanReport({ format: "pickle", exitCode: 0, timedOut: false, report: pkl(report088({ scanned: ["artifact.pkl"] })), npy: { kind: "numeric" } });
    expect(m.status).toBe("completed");
  });
});
