/**
 * ADR-0187 B5-M — THE REAL ENGINE, opt-in: the pinned modelscan 0.8.8 (with the image's one patch,
 * engines/modelscan/patches/format-names-from-settings.py) run on the hostile fixtures through the
 * real adapter, our settings file and the gateway's verdict function. Set REGULAIT_MODELSCAN_BIN to
 * a venv's `modelscan` built from engines/modelscan/requirements.txt with the patch applied (the
 * Dockerfile does exactly that); without it the suite is skipped and says so.
 *
 * Measured on 2026-10-09 (Python 3.11 venv, `pip install --require-hashes` of the pinned closure for
 * that interpreter, patch applied): every red proof below holds. Stock 0.8.8 with our settings file
 * fails every one with MODEL_SCAN errors (nothing scanned), which is why the patch exists.
 */
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExchangeScanExecutor, LocalScanExecutor, scannerTick } from "./exchange.js";
import { cleanPickle, legacyTorchFile, maliciousPickle, nestedZip, npzFile, numericNpy, objectNpy, safetensorsFile, torchZip, truncatedMaliciousPickle } from "./fixtures.js";
import { scanAndJudge } from "./harness.js";

const BIN = process.env.REGULAIT_MODELSCAN_BIN;
const SETTINGS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../engines/modelscan/modelscan-settings.toml");
// ADR-0187 decision 180: the scanner's `.npy` header check runs on the same venv's interpreter
const NPY_HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../engines/modelscan/npy-header.py");
const opts = BIN ? { modelscanBin: BIN, settingsFile: SETTINGS, path: path.dirname(BIN), python: path.join(path.dirname(BIN), "python"), npyHelper: NPY_HELPER } : {};
const local = (root: string) => new LocalScanExecutor(root, opts);

describe.skipIf(!BIN)("B5-M real modelscan 0.8.8 (opt-in: REGULAIT_MODELSCAN_BIN)", () => {
  it("red proofs: renamed pickle, legacy .pt, importlib pickle, truncated pickle, nested zip — none is clean", async () => {
    expect((await scanAndJudge(maliciousPickle(), local)).judged.verdict).toBe("unsafe");
    expect((await scanAndJudge(legacyTorchFile(), local)).judged.verdict).toBe("unsafe");
    expect((await scanAndJudge(maliciousPickle("importlib", "import_module"), local)).judged.verdict).toBe("unsafe");
    expect((await scanAndJudge(truncatedMaliciousPickle(), local)).judged.verdict).toBe("unknown");
    expect((await scanAndJudge(nestedZip(), local)).judged.verdict).toBe("unknown");
  }, 120_000);

  it("the deny-list additions G19 measured slipping through are findings now", async () => {
    for (const [m, n] of [
      ["ctypes", "CDLL"],
      ["http.client", "HTTPSConnection"],
      ["marshal", "loads"],
      ["types", "CodeType"],
      ["operator", "methodcaller"],
      ["code", "InteractiveInterpreter"],
    ] as const) {
      const r = await scanAndJudge(maliciousPickle(m, n), local);
      expect([m, n, r.judged.verdict]).toEqual([m, n, "unsafe"]);
    }
  }, 120_000);

  it("zip PyTorch is scanned; a clean pickle is no_known_unsafe; safetensors is clean", async () => {
    expect((await scanAndJudge(torchZip(maliciousPickle()), local)).judged.verdict).toBe("unsafe");
    const clean = await scanAndJudge(cleanPickle(), local);
    expect(clean.judged.verdict).toBe("no_known_unsafe");
    expect(clean.envelope.status).toBe("completed");
    expect((await scanAndJudge(safetensorsFile(), local)).judged.verdict).toBe("clean");
  }, 120_000);

  it("an object .npy whose pickle calls os.system is unsafe; benign and numeric ones are no_known_unsafe (decisions 180–184)", async () => {
    // decision 108: modelscan's own NumPy scanner calls np.lib.format._check_version, which numpy 2.x
    // no longer has, so before decision 180 this read `unknown`. The scanner now checks the header
    // itself and hands the object payload to modelscan's PICKLE scanner; modelscan never sees a .npy.
    for (const v of [[1, 0], [2, 0], [3, 0]] as const) {
      const r = await scanAndJudge(objectNpy(maliciousPickle(), v), local);
      expect([v, r.judged.verdict]).toEqual([v, "unsafe"]);
      expect(r.judged.findings).toContainEqual({ kind: "unsafe_operator", id: "os.system", severity: "critical" });
    }
    expect((await scanAndJudge(objectNpy(cleanPickle()), local)).judged.verdict).toBe("no_known_unsafe");
    expect((await scanAndJudge(numericNpy([3, 0]), local)).judged.verdict).toBe("no_known_unsafe");
    const bad = await scanAndJudge(numericNpy([1, 0]).subarray(0, 70), local);
    expect(bad.judged.verdict).toBe("unknown");
    expect(bad.judged.findings).toContainEqual({ kind: "scan_error", id: "npy_truncated", severity: "medium" });
  }, 120_000);

  it("files numpy itself writes (versions 1.0, 2.0, 3.0; numeric and object) pass the header check", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "b5m-np-"));
    try {
      // the venv's own numpy writes them: the header check must accept exactly what numpy's writer emits
      const script = [
        "import sys, numpy as np, numpy.lib.format as f",
        "d = sys.argv[1]",
        "for v in [(1, 0), (2, 0), (3, 0)]:",
        "    for name, a in [('num', np.arange(6.0).reshape(2, 3)), ('i8', np.arange(5, dtype='<i8')), ('obj', np.array([{'a': 1}, None], dtype=object))]:",
        "        with open(f'{d}/{name}-{v[0]}.npy', 'wb') as fh:",
        "            f.write_array(fh, a, version=v, allow_pickle=True)",
      ].join("\n");
      const made = spawnSync(path.join(path.dirname(BIN!), "python"), ["-I", "-c", script, dir], { encoding: "utf8" });
      expect(made.status).toBe(0);
      for (const v of [1, 2, 3]) {
        for (const name of ["num", "i8", "obj"]) {
          const r = await scanAndJudge(await readFile(path.join(dir, `${name}-${v}.npy`)), local);
          expect([name, v, r.stored, r.envelope.status, r.judged.verdict]).toEqual([name, v, "numpy", "completed", "no_known_unsafe"]);
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("a .npz: an os.system object member is unsafe; numeric and benign ones, and files numpy writes, are no_known_unsafe (decisions 219–224)", async () => {
    // open question 15(c): modelscan's zip path sent each member to its broken NumPy scanner, so every
    // .npz read `unknown`. The scanner now checks the archive and hands only object payloads over.
    for (const method of [0, 8] as const) {
      const evil = await scanAndJudge(npzFile([["w.npy", numericNpy()], ["evil.npy", objectNpy(maliciousPickle())]], method), local);
      expect([method, evil.stored, evil.judged.verdict]).toEqual([method, "numpy_npz", "unsafe"]);
      expect(evil.judged.findings).toContainEqual({ kind: "unsafe_operator", id: "os.system", severity: "critical" });
      expect((await scanAndJudge(npzFile([["a.npy", objectNpy(cleanPickle())], ["b.npy", numericNpy()]], method), local)).judged.verdict).toBe("no_known_unsafe");
    }
    const dup = await scanAndJudge(npzFile([["a.npy", numericNpy()], ["a.npy", objectNpy(maliciousPickle())]]), local);
    expect(dup.judged.verdict).toBe("unknown");
    expect(dup.judged.findings).toContainEqual({ kind: "scan_error", id: "npz_member_duplicate", severity: "medium" });
    const dir = await mkdtemp(path.join(tmpdir(), "b5m-npz-"));
    try {
      // the venv's own numpy writes them (savez and savez_compressed): the check must accept exactly what numpy writes
      const script = [
        "import sys, numpy as np",
        "d = sys.argv[1]",
        "arrays = dict(w=np.arange(6.0).reshape(2, 3), i=np.arange(5, dtype='<i8'))",
        "np.savez(f'{d}/num.npz', **arrays)",
        "np.savez_compressed(f'{d}/numz.npz', **arrays)",
        "np.savez(f'{d}/obj.npz', o=np.array([{'a': 1}, None], dtype=object), w=np.zeros(3))",
        "np.savez_compressed(f'{d}/objz.npz', o=np.array([{'a': 1}, None], dtype=object), w=np.zeros(3))",
        "np.savez(f'{d}/pos.npz', np.zeros(2), np.ones(3))",
      ].join("\n");
      const made = spawnSync(path.join(path.dirname(BIN!), "python"), ["-I", "-c", script, dir], { encoding: "utf8" });
      expect(made.status).toBe(0);
      for (const name of ["num", "numz", "obj", "objz", "pos"]) {
        const r = await scanAndJudge(await readFile(path.join(dir, `${name}.npz`)), local);
        expect([name, r.stored, r.envelope.status, r.judged.verdict]).toEqual([name, "numpy_npz", "completed", "no_known_unsafe"]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("the runner/scanner exchange carries a real scan end to end", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "b5m-x-"));
    const jobs = path.join(root, "jobs");
    const results = path.join(root, "results");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(jobs);
    await mkdir(results);
    const stop = new AbortController();
    const scanner = (async () => {
      while (!stop.signal.aborted) {
        await scannerTick({ jobsRoot: jobs, resultsRoot: results, pollMs: 50, modelscan: opts });
        await new Promise((r) => setTimeout(r, 50));
      }
    })();
    try {
      const r = await scanAndJudge(maliciousPickle(), () => new ExchangeScanExecutor(jobs, results, { pollMs: 50 }));
      expect(r.judged.verdict).toBe("unsafe");
    } finally {
      stop.abort();
      await scanner;
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
