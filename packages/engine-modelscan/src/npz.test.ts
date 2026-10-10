/**
 * ADR-0187 decisions 219–224 (closes open question 15(c)) — `.npz` archives. modelscan 0.8.8's zip
 * path hands every `.npy` member to its NumPy scanner, which fails on numpy 2.x (decision 108), so every
 * `.npz` read `unknown`. The scanner now checks the archive itself, strictly, with Python's `zipfile`
 * (engines/modelscan/npy-header.py `--npz`), runs each member through the `.npy` header check, and hands
 * only object members' pickle payloads to modelscan's PICKLE scanner (one `member-NNNN.pkl` per object
 * member, in one directory). The members combine strongest-not-clean: any unsafe → unsafe; any
 * unknown → unknown; a numeric-only archive is `no_known_unsafe` with the executable-format finding
 * (decision 105 unchanged).
 *
 * The helper runs under `python3 -I -S` (stdlib only, no numpy). modelscan is a fake that answers as
 * the pinned 0.8.8 does for what it is handed (a file, or a directory: names relative to it; measured
 * 2026-10-10: `os.system` in a `.pkl` is a CRITICAL issue, exit 1; a benign `.pkl` exits 0);
 * modelscan-real.test.ts runs the engine itself (opt-in). Synthetic fixtures only, written byte by byte.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ProcessGroupOptions, ProcessGroupResult } from "@regulait/engine-runner";
import { mapModelscanReport, NPY_OBJECT_PAYLOAD_MAX_BYTES, NPZ_MAX_MEMBERS, NPZ_MAX_UNCOMPRESSED_BYTES, type ArtifactFormat } from "@regulait/shared";
import { ExchangeScanExecutor, LocalScanExecutor, scannerTick } from "./exchange.js";
import { cleanPickle, maliciousPickle, npyFile, npyHeader, numericNpy, npzFile, objectNpy, storedZip, zipArchive } from "./fixtures.js";
import { scanAndJudge } from "./harness.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HELPER = path.join(root, "engines/modelscan/npy-header.py");
const PYTHON = spawnSync("python3", ["--version"]).status === 0;
/** the absolute interpreter: the scanner runs the check with an environment built from nothing (no PATH to search) */
const PYTHON_BIN = PYTHON ? spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim() : "python3";

const MiB = 1024 * 1024;
/** a member whose header is refused (an extra key) */
const badHeaderNpy = () => npyFile({ header: "{'descr': '<f8', 'fortran_order': False, 'shape': (3,), 'x': 1, }", payload: Buffer.alloc(24) });

/** run the helper's `--npz` mode on `bytes`; returns its one JSON line, its exit status and the payload files it left */
async function checkNpz(bytes: Buffer, bounds: { payload?: number; uncompressed?: number; members?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "b5m-npz-"));
  try {
    const artifact = path.join(dir, "artifact.zip");
    const out = path.join(dir, "payloads");
    await mkdir(out);
    await writeFile(artifact, bytes);
    const args = [
      "-I",
      "-S",
      HELPER,
      "--npz",
      artifact,
      out,
      String(bounds.payload ?? NPY_OBJECT_PAYLOAD_MAX_BYTES),
      String(bounds.uncompressed ?? NPZ_MAX_UNCOMPRESSED_BYTES),
      String(bounds.members ?? NPZ_MAX_MEMBERS),
    ];
    const r = spawnSync("python3", args, { encoding: "utf8", cwd: dir });
    const files = (await readdir(out)).sort();
    const payloads = new Map<string, Buffer>();
    for (const f of files) payloads.set(f, await readFile(path.join(out, f)));
    return { status: r.status, out: r.status === 0 ? (JSON.parse(r.stdout) as Record<string, unknown>) : null, lines: r.stdout.split("\n").filter(Boolean).length, files, payloads };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const answer = async (b: Buffer, bounds?: Parameters<typeof checkNpz>[1]) => (await checkNpz(b, bounds)).out;
const refused = (problem: string) => ({ kind: "invalid", problem });

describe.skipIf(!PYTHON)("ADR-0187 decisions 219–220: the strict .npz archive check", () => {
  it("a benign numeric .npz, stored or deflated, is every member numeric, and nothing is extracted", async () => {
    for (const method of [0, 8] as const) {
      const r = await checkNpz(npzFile([["arr_0.npy", numericNpy()], ["weights.npy", numericNpy([2, 0], 100)], ["b-1.npy", numericNpy([3, 0])]], method));
      expect([method, r.status, r.lines, r.out, r.files]).toEqual([method, 0, 1, { kind: "npz", members: [{ kind: "numeric" }, { kind: "numeric" }, { kind: "numeric" }] }, []]);
    }
  });

  it("an object member's payload is copied exactly, as member-NNNN.pkl by its position, stored or deflated", async () => {
    for (const method of [0, 8] as const) {
      const r = await checkNpz(npzFile([["a.npy", numericNpy()], ["b.npy", objectNpy(maliciousPickle())]], method));
      expect([method, r.out]).toEqual([method, { kind: "npz", members: [{ kind: "numeric" }, { kind: "object", payloadBytes: maliciousPickle().length }] }]);
      expect(r.files).toEqual(["member-0002.pkl"]);
      expect(r.payloads.get("member-0002.pkl")?.equals(maliciousPickle())).toBe(true);
    }
  });

  it("mixed members: each answered on its own; a refused member leaves no file and does not stop the others", async () => {
    const r = await checkNpz(npzFile([["n.npy", numericNpy()], ["o.npy", objectNpy(maliciousPickle())], ["bad.npy", badHeaderNpy()], ["c.npy", objectNpy(cleanPickle())]]));
    expect(r.out).toEqual({
      kind: "npz",
      members: [{ kind: "numeric" }, { kind: "object", payloadBytes: maliciousPickle().length }, refused("npy_header_keys"), { kind: "object", payloadBytes: cleanPickle().length }],
    });
    expect(r.files).toEqual(["member-0002.pkl", "member-0004.pkl"]);
    expect(r.payloads.get("member-0004.pkl")?.equals(cleanPickle())).toBe(true);
  });

  it("zip bombs: a declared total over the bound is refused before anything is read; a lying size is read with a hard cap", async () => {
    // a real deflate bomb: 64 MiB of zeros in about 64 KiB, against a 16 MiB bound
    const zeros = npyFile({ header: npyHeader("|u1", [64 * MiB]), payload: Buffer.alloc(64 * MiB) });
    const bomb = npzFile([["z.npy", zeros]], 8);
    expect(bomb.length).toBeLessThan(MiB);
    expect(await answer(bomb, { uncompressed: 16 * MiB })).toEqual(refused("npz_too_large"));
    // the same archive under the real bound (2 GiB) is an ordinary numeric archive
    expect(await answer(bomb)).toEqual({ kind: "npz", members: [{ kind: "numeric" }] });
    // a member declaring 3 GiB, under the real bound
    expect(await answer(zipArchive([{ name: "z.npy", data: numericNpy(), method: 8, declaredSize: 3 * 1024 * MiB }]))).toEqual(refused("npz_too_large"));
    // a member declaring a small size whose stream inflates to 64 MiB: zipfile never yields more than the
    // declared size, and the CRC of what was read does not match, so the member is refused
    // (the numeric member is larger than zipfile's 4 KiB read-ahead, so only reading it to its end checks the CRC)
    const small = numericNpy([1, 0], 8192);
    for (const data of [Buffer.concat([small, Buffer.alloc(64 * MiB)]), Buffer.concat([objectNpy(maliciousPickle()), Buffer.alloc(64 * MiB)])]) {
      const declared = data.length - 64 * MiB;
      const r = await checkNpz(zipArchive([{ name: "z.npy", data, method: 8, declaredSize: declared }]));
      expect(r.out).toEqual({ kind: "npz", members: [refused("npz_member_corrupt")] });
      expect(r.files).toEqual([]);
    }
    // too many members
    expect(await answer(npzFile([["a.npy", numericNpy()], ["b.npy", numericNpy()], ["c.npy", numericNpy()]]), { members: 2 })).toEqual(refused("npz_too_many_members"));
    // the object payloads of the whole archive share one bound
    const two = await checkNpz(npzFile([["a.npy", objectNpy(maliciousPickle())], ["b.npy", objectNpy(maliciousPickle())]]), { payload: maliciousPickle().length + 4 });
    expect(two.out).toEqual({ kind: "npz", members: [{ kind: "object", payloadBytes: maliciousPickle().length }, refused("npy_payload_too_large")] });
    expect(two.files).toEqual(["member-0001.pkl"]);
  }, 60_000);

  it("a name with a path separator, a drive colon, a NUL or a traversal is refused", async () => {
    for (const name of ["../a.npy", "a/b.npy", "/a.npy", "a\\b.npy", "C:a.npy", "a\u0000.npy", "..", "../../etc/x.npy", "dir/"]) {
      expect([name, await answer(npzFile([["ok.npy", numericNpy()], [name, numericNpy()]]))]).toEqual([name, refused("npz_member_path")]);
    }
  });

  it("a repeated member name is refused (zipfile keeps one of them; numpy would load the last)", async () => {
    expect(await answer(npzFile([["a.npy", numericNpy()], ["a.npy", objectNpy(maliciousPickle())]]))).toEqual(refused("npz_member_duplicate"));
  });

  it("an encrypted member is refused; one encrypted in its local header only is a central/local disagreement", async () => {
    expect(await answer(zipArchive([{ name: "a.npy", data: numericNpy() }, { name: "b.npy", data: numericNpy(), encrypted: true }]))).toEqual(refused("npz_member_encrypted"));
    expect(await answer(storedZip([{ name: "a.npy", data: objectNpy(maliciousPickle()), encrypted: true }]))).toEqual(refused("npz_member_encrypted"));
    expect(await answer(zipArchive([{ name: "a.npy", data: numericNpy(), localFlags: 0x1 }]))).toEqual(refused("npz_header_mismatch"));
  });

  it("a member that is not a plain .npy name is refused, and a member that is itself an archive is refused", async () => {
    for (const name of ["a.pkl", "a.npy.pkl", "README", "inner.zip", ".npy", ".hidden.npy", "a.NPY", "ä.npy", "a b.npy"]) {
      expect([name, await answer(npzFile([["ok.npy", numericNpy()], [name, numericNpy()]]))]).toEqual([name, refused("npz_member_not_npy")]);
    }
    // a .npy-named member holding a zip (or a gzip stream): nested, refused, the others still answered
    const nested = await checkNpz(npzFile([["inner.npy", storedZip([{ name: "x.npy", data: objectNpy(maliciousPickle()) }])], ["g.npy", Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0])], ["n.npy", numericNpy()]]));
    expect(nested.out).toEqual({ kind: "npz", members: [refused("npz_member_nested"), refused("npz_member_nested"), { kind: "numeric" }] });
    expect(nested.files).toEqual([]);
  });

  it("a truncated archive is refused wherever it is cut; a member whose bytes were altered is refused", async () => {
    const full = npzFile([["a.npy", numericNpy()], ["b.npy", objectNpy(maliciousPickle())]]);
    for (const n of [0, 4, 30, 100, full.length - 60, full.length - 22, full.length - 1]) {
      const r = await checkNpz(full.subarray(0, n));
      expect([n, r.status, r.out?.kind, r.files]).toEqual([n, 0, "invalid", []]);
      expect(["npz_malformed", "npz_layout"]).toContain(r.out?.problem);
    }
    // a member whose CRC does not match its bytes
    const crc = await checkNpz(zipArchive([{ name: "a.npy", data: objectNpy(maliciousPickle()), crc: 0x12345678 }]));
    expect(crc.out).toEqual({ kind: "npz", members: [refused("npz_member_corrupt")] });
    expect(crc.files).toEqual([]);
  });

  it("the layout is strict: no comment, nothing before, between or after the members, no empty archive, stored or deflate only", async () => {
    const members = [{ name: "a.npy", data: numericNpy() }];
    expect(await answer(zipArchive(members, { comment: "hello" }))).toEqual(refused("npz_layout"));
    expect(await answer(zipArchive(members, { prefix: Buffer.from("#!/bin/sh\n") }))).toEqual(refused("npz_layout"));
    expect(await answer(Buffer.concat([zipArchive(members), Buffer.from("trailing")]))).toEqual(refused("npz_layout"));
    expect(await answer(Buffer.from("not a zip at all, and long enough to hold an end record"))).toEqual(refused("npz_malformed"));
    expect(await answer(zipArchive([]))).toEqual(refused("npz_empty"));
    // bzip2 (12): zipfile could read it, numpy never writes it
    const bz = zipArchive(members);
    bz.writeUInt16LE(12, 8);
    bz.writeUInt16LE(12, bz.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 10);
    expect(await answer(bz)).toEqual(refused("npz_compression_unsupported"));
    // a central directory whose size disagrees with the local header's
    const lie = zipArchive(members);
    lie.writeUInt32LE(9999, 22);
    expect(await answer(lie)).toEqual(refused("npz_header_mismatch"));
  });
});

// ---------------------------------------------------------------------------------------------------

/** a modelscan 0.8.8 report as the pinned engine writes it, for any number of files */
function report088(p: { scanned: string[]; issues: string[] }) {
  return {
    summary: {
      total_issues_by_severity: { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: p.issues.length },
      total_issues: p.issues.length,
      input_path: "x",
      absolute_path: "/x",
      modelscan_version: "0.8.8",
      timestamp: "2026-10-10T03:57:34.557884",
      scanned: p.scanned.length ? { total_scanned: p.scanned.length, scanned_files: p.scanned } : { total_scanned: 0 },
      skipped: { total_skipped: 0, skipped_files: [] },
    },
    issues: p.issues.map((source) => ({
      description: "Use of unsafe operator 'system' from module 'os'",
      operator: "system",
      module: "os",
      source,
      scanner: "modelscan.scanners.PickleUnsafeOpScan",
      severity: "CRITICAL",
    })),
    errors: [],
  };
}

/**
 * A fake modelscan that answers as the pinned 0.8.8 does: handed a directory, it scans every file in it
 * and names each relative to the directory (modelscan.py `_generate_results`); records every file.
 */
function modelscan088(calls: Array<{ target: string; name: string; bytes: Buffer }>) {
  return async (_cmd: string, args: readonly string[], _opts: ProcessGroupOptions): Promise<ProcessGroupResult> => {
    const target = args[args.indexOf("-p") + 1]!;
    const out = args[args.indexOf("-o") + 1]!;
    const isDir = (await stat(target)).isDirectory();
    const files = isDir ? (await readdir(target)).sort().map((n) => [n, path.join(target, n)] as const) : [[path.basename(target), target] as const];
    const issues: string[] = [];
    for (const [name, file] of files) {
      const bytes = await readFile(file);
      calls.push({ target: isDir ? "dir" : "file", name, bytes });
      if (bytes.includes(Buffer.from("system"))) issues.push(name);
    }
    await writeFile(out, JSON.stringify(report088({ scanned: files.map(([n]) => n), issues })));
    return { exitCode: issues.length ? 1 : 0, signal: null, killed: false, stdout: "not parsed", stderr: "" };
  };
}

type Calls = Array<{ target: string; name: string; bytes: Buffer }>;
function local(calls: Calls, helper = HELPER) {
  return (dir: string) => new LocalScanExecutor(dir, { run: modelscan088(calls), python: PYTHON_BIN, npyHelper: helper });
}

describe.skipIf(!PYTHON)("ADR-0187 decisions 221–222: .npz through the adapter, the scanner and the gateway's verdict", () => {
  it("a benign numeric .npz is no_known_unsafe with the executable-format finding; modelscan is never started", async () => {
    for (const method of [0, 8] as const) {
      const calls: Calls = [];
      const r = await scanAndJudge(npzFile([["arr_0.npy", numericNpy()], ["arr_1.npy", numericNpy([3, 0], 7)]], method), local(calls));
      expect([method, r.stored, r.envelope.status, r.judged.verdict]).toEqual([method, "numpy_npz", "completed", "no_known_unsafe"]);
      expect(r.judged.findings).toEqual([{ kind: "executable_format", id: "numpy_npz", severity: "high" }]);
      expect(calls).toEqual([]);
    }
  });

  it("an object .npz whose member calls os.system is unsafe; modelscan's pickle scanner gets exactly that payload", async () => {
    for (const method of [0, 8] as const) {
      const calls: Calls = [];
      const r = await scanAndJudge(npzFile([["w.npy", numericNpy()], ["evil.npy", objectNpy(maliciousPickle())]], method), local(calls));
      expect([method, r.stored, r.envelope.status, r.judged.verdict]).toEqual([method, "numpy_npz", "completed", "unsafe"]);
      expect(r.judged.findings).toContainEqual({ kind: "unsafe_operator", id: "os.system", severity: "critical" });
      expect(calls.map((c) => [c.target, c.name])).toEqual([["dir", "member-0002.pkl"]]);
      expect(calls[0]!.bytes.equals(maliciousPickle())).toBe(true);
    }
  });

  it("a benign object .npz is no_known_unsafe", async () => {
    const calls: Calls = [];
    const r = await scanAndJudge(npzFile([["a.npy", objectNpy(cleanPickle())], ["b.npy", numericNpy()]]), local(calls));
    expect(r.judged.verdict).toBe("no_known_unsafe");
    expect(calls.map((c) => c.name)).toEqual(["member-0001.pkl"]);
  });

  it("mixed members combine strongest-not-clean: any unsafe → unsafe; any unknown → unknown", async () => {
    const calls: Calls = [];
    const unsafe = await scanAndJudge(npzFile([["n.npy", numericNpy()], ["bad.npy", badHeaderNpy()], ["o.npy", objectNpy(maliciousPickle())], ["c.npy", objectNpy(cleanPickle())]]), local(calls));
    expect(unsafe.judged.verdict).toBe("unsafe");
    expect(unsafe.judged.findings).toContainEqual({ kind: "unsafe_operator", id: "os.system", severity: "critical" });
    expect(unsafe.judged.findings).toContainEqual({ kind: "scan_error", id: "npy_header_keys", severity: "medium" });
    expect(calls.map((c) => c.name)).toEqual(["member-0003.pkl", "member-0004.pkl"]);
    const unknown = await scanAndJudge(npzFile([["n.npy", numericNpy()], ["bad.npy", badHeaderNpy()], ["c.npy", objectNpy(cleanPickle())]]), local([]));
    expect(unknown.judged.verdict).toBe("unknown");
    expect(unknown.judged.findings).toContainEqual({ kind: "scan_error", id: "npy_header_keys", severity: "medium" });
    // numeric members and one refused member, no object: unknown, modelscan never started
    const noObject: Calls = [];
    const numericBad = await scanAndJudge(npzFile([["n.npy", numericNpy()], ["bad.npy", numericNpy().subarray(0, 100)]]), local(noObject));
    expect(numericBad.judged.verdict).toBe("unknown");
    expect(numericBad.judged.findings).toContainEqual({ kind: "scan_error", id: "npy_truncated", severity: "medium" });
    expect(noObject).toEqual([]);
  });

  it("archive-level refusals read unknown with their problem code, and modelscan is never started", async () => {
    const cases: Array<[Buffer, string]> = [
      [zipArchive([{ name: "z.npy", data: objectNpy(maliciousPickle()), method: 8, declaredSize: 3 * 1024 * MiB }]), "npz_too_large"],
      [npzFile([["ok.npy", numericNpy()], ["../evil.npy", objectNpy(maliciousPickle())]]), "npz_member_path"],
      [npzFile([["a.npy", numericNpy()], ["a.npy", objectNpy(maliciousPickle())]]), "npz_member_duplicate"],
      [zipArchive([{ name: "a.npy", data: objectNpy(maliciousPickle()), localFlags: 0x1 }]), "npz_header_mismatch"],
      [zipArchive([{ name: "a.npy", data: numericNpy() }], { comment: "x" }), "npz_layout"],
    ];
    for (const [bytes, code] of cases) {
      const calls: Calls = [];
      const r = await scanAndJudge(bytes, local(calls));
      expect([code, r.stored, r.envelope.status, r.judged.verdict]).toEqual([code, "numpy_npz", "completed", "unknown"]);
      expect(r.judged.findings).toContainEqual({ kind: "scan_error", id: code, severity: "medium" });
      expect(calls).toEqual([]);
    }
  });

  it("a lying zip bomb member is unknown (npz_member_corrupt), and nothing of it reaches modelscan", async () => {
    const data = Buffer.concat([objectNpy(maliciousPickle()), Buffer.alloc(64 * MiB)]);
    const calls: Calls = [];
    const r = await scanAndJudge(zipArchive([{ name: "z.npy", data, method: 8, declaredSize: data.length - 64 * MiB }]), local(calls));
    expect(r.judged.verdict).toBe("unknown");
    expect(r.judged.findings).toContainEqual({ kind: "scan_error", id: "npz_member_corrupt", severity: "medium" });
    expect(calls).toEqual([]);
  }, 30_000);

  it("encrypted, non-npy and truncated archives never reach the check as .npz (the format is zip_opaque or zip) and are never clean", async () => {
    const cases: Array<[Buffer, string]> = [
      [storedZip([{ name: "a.npy", data: objectNpy(maliciousPickle()), encrypted: true }]), "zip_opaque"],
      [npzFile([["a.npy", numericNpy()], ["b.pkl", cleanPickle()]]), "zip"],
      [npzFile([["a.npy", numericNpy()], ["b.npy", objectNpy(maliciousPickle())]]).subarray(0, 150), "zip_opaque"],
    ];
    for (const [bytes, format] of cases) {
      const r = await scanAndJudge(bytes, local([]));
      expect([format, r.stored]).toEqual([format, format]);
      expect(["unknown", "unsafe"]).toContain(r.judged.verdict);
    }
  });

  it("a check that does not answer properly is npz_check_failed: unknown, and modelscan is never started", async () => {
    const calls: Calls = [];
    const r = await scanAndJudge(npzFile([["a.npy", objectNpy(maliciousPickle())]]), local(calls, path.join(root, "engines/modelscan/no-such-check.py")));
    expect(r.judged.verdict).toBe("unknown");
    expect(r.judged.findings).toContainEqual({ kind: "scan_error", id: "npz_check_failed", severity: "medium" });
    expect(calls).toEqual([]);
  });

  it("the scanner container's answer carries the archive check to the runner (done.json)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "b5m-npzx-"));
    const jobs = path.join(dir, "jobs");
    const results = path.join(dir, "results");
    await mkdir(jobs);
    await mkdir(results);
    const calls: Calls = [];
    const stop = new AbortController();
    const scanner = (async () => {
      while (!stop.signal.aborted) {
        await scannerTick({ jobsRoot: jobs, resultsRoot: results, pollMs: 10, modelscan: { run: modelscan088(calls), python: PYTHON_BIN, npyHelper: HELPER } });
        await new Promise((r) => setTimeout(r, 10));
      }
    })();
    try {
      const exchange = () => new ExchangeScanExecutor(jobs, results, { pollMs: 10 });
      expect((await scanAndJudge(npzFile([["a.npy", numericNpy()], ["b.npy", objectNpy(maliciousPickle())]]), exchange)).judged.verdict).toBe("unsafe");
      expect((await scanAndJudge(npzFile([["a.npy", numericNpy()]], 8), exchange)).judged.verdict).toBe("no_known_unsafe");
      const bad = await scanAndJudge(npzFile([["a.npy", numericNpy()], ["a.npy", numericNpy()]]), exchange);
      expect(bad.judged.verdict).toBe("unknown");
      expect(bad.judged.findings).toContainEqual({ kind: "scan_error", id: "npz_member_duplicate", severity: "medium" });
      expect(calls.map((c) => c.name)).toEqual(["member-0002.pkl"]);
      // nothing of the check is left on the result volume
      expect(existsSync(path.join(results, "npz"))).toBe(false);
    } finally {
      stop.abort();
      await scanner;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ADR-0187 decision 222: the mapper reads the archive check, never a .npz report alone", () => {
  const npz: ArtifactFormat = "numpy_npz";
  const rep = (r: unknown) => Buffer.from(JSON.stringify(r));
  const scanItem = (m: ReturnType<typeof mapModelscanReport>) => m.items.find((i) => i.key === "modelscan/scan")?.verdict;

  it("a .npz scan with no archive check is never better than unknown", () => {
    const m = mapModelscanReport({ format: npz, exitCode: 0, timedOut: false, report: rep(report088({ scanned: ["artifact.zip:a.npy"], issues: [] })) });
    expect([m.status, m.errorCode, scanItem(m)]).toEqual(["failed", "npz_check_missing", "unknown"]);
  });

  it("numeric only: passes only when modelscan was not run", () => {
    const ok = mapModelscanReport({ format: npz, exitCode: null, timedOut: false, report: null, npz: { kind: "npz", members: [{ kind: "numeric" }, { kind: "numeric" }] } });
    expect([ok.status, scanItem(ok)]).toEqual(["completed", "pass"]);
    const odd = mapModelscanReport({ format: npz, exitCode: 0, timedOut: false, report: rep(report088({ scanned: ["member-0001.pkl"], issues: [] })), npz: { kind: "npz", members: [{ kind: "numeric" }] } });
    expect(odd.errorCode).toBe("report_inconsistent");
  });

  it("objects: the report must name exactly the object members' payload files, and every one must be scanned", () => {
    const members = [{ kind: "numeric" as const }, { kind: "object" as const, payloadBytes: 20 }, { kind: "object" as const, payloadBytes: 9 }];
    const ok = mapModelscanReport({ format: npz, exitCode: 0, timedOut: false, report: rep(report088({ scanned: ["member-0002.pkl", "member-0003.pkl"], issues: [] })), npz: { kind: "npz", members } });
    expect([ok.status, scanItem(ok)]).toEqual(["completed", "pass"]);
    const hit = mapModelscanReport({ format: npz, exitCode: 1, timedOut: false, report: rep(report088({ scanned: ["member-0002.pkl", "member-0003.pkl"], issues: ["member-0003.pkl"] })), npz: { kind: "npz", members } });
    expect(hit.items).toContainEqual(expect.objectContaining({ sourceTaxonomy: { system: "modelscan-operator", id: "os.system" }, verdict: "fail" }));
    const foreign = mapModelscanReport({ format: npz, exitCode: 0, timedOut: false, report: rep(report088({ scanned: ["member-0001.pkl", "member-0002.pkl", "member-0003.pkl"], issues: [] })), npz: { kind: "npz", members } });
    expect(foreign.errorCode).toBe("report_inconsistent");
    const partial = mapModelscanReport({ format: npz, exitCode: 0, timedOut: false, report: rep(report088({ scanned: ["member-0002.pkl"], issues: [] })), npz: { kind: "npz", members } });
    expect([partial.status, scanItem(partial)]).toEqual(["completed", "unknown"]);
  });

  it("a refused member is an unknown item beside the others; an archive refusal is unknown with its code", () => {
    const m = mapModelscanReport({
      format: npz,
      exitCode: 0,
      timedOut: false,
      report: rep(report088({ scanned: ["member-0001.pkl"], issues: [] })),
      npz: { kind: "npz", members: [{ kind: "object", payloadBytes: 9 }, { kind: "invalid", problem: "npz_member_nested" }] },
    });
    expect([m.status, scanItem(m)]).toEqual(["completed", "unknown"]);
    expect(m.items).toContainEqual(expect.objectContaining({ key: "npz/member/2", sourceTaxonomy: { system: "modelscan-error", id: "npz_member_nested" }, verdict: "unknown" }));
    const bad = mapModelscanReport({ format: npz, exitCode: null, timedOut: false, report: null, npz: { kind: "invalid", problem: "npz_member_encrypted" } });
    expect([bad.status, scanItem(bad)]).toEqual(["completed", "unknown"]);
    expect(bad.items).toContainEqual(expect.objectContaining({ sourceTaxonomy: { system: "modelscan-error", id: "npz_member_encrypted" } }));
  });

  it("an answer outside the schema (over the payload bound, an unknown code) is never read", () => {
    const over = mapModelscanReport({ format: npz, exitCode: null, timedOut: false, report: null, npz: { kind: "npz", members: [{ kind: "object", payloadBytes: NPY_OBJECT_PAYLOAD_MAX_BYTES + 1 }] } });
    expect(over.errorCode).toBe("npz_check_missing");
    // @ts-expect-error an unknown problem code
    const odd = mapModelscanReport({ format: npz, exitCode: null, timedOut: false, report: null, npz: { kind: "invalid", problem: "npz_fine" } });
    expect(odd.errorCode).toBe("npz_check_missing");
  });
});
