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
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExchangeScanExecutor, LocalScanExecutor, scannerTick } from "./exchange.js";
import { cleanPickle, legacyTorchFile, maliciousPickle, nestedZip, objectNpy, safetensorsFile, torchZip, truncatedMaliciousPickle } from "./fixtures.js";
import { scanAndJudge } from "./harness.js";

const BIN = process.env.REGULAIT_MODELSCAN_BIN;
const SETTINGS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../engines/modelscan/modelscan-settings.toml");
const opts = BIN ? { modelscanBin: BIN, settingsFile: SETTINGS, path: path.dirname(BIN) } : {};
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

  it("an object .npy is unknown, never clean: 0.8.8's NumPy scanner fails on the pinned numpy (decision 108)", async () => {
    // modelscan calls np.lib.format._check_version, which numpy 2.x no longer has: every .npy scan is a
    // MODEL_SCAN error. Fail closed: unknown. If this ever reads `unsafe`, the scanner works again.
    const r = await scanAndJudge(objectNpy(maliciousPickle()), local);
    expect(r.judged.verdict).toBe("unknown");
    expect(r.judged.findings.some((f) => f.kind === "scan_error")).toBe(true);
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
