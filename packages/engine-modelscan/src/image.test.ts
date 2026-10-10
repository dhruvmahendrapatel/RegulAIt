/**
 * ADR-0187 B5-M — the image's inputs, read as text (no daemon here; M-063/M-065: a configuration for
 * a target we cannot run is checked against its constraints before CI ever builds it):
 *   - every base is pinned by digest; the Python closure is installed only from our hash-pinned
 *     lockfile; modelscan's pinned version is the manifest's; the patch, the licence gate and the
 *     read-only settings are in the build; the runtime is non-root, ships no pip, sets a public
 *     egress-probe address;
 *   - the licence gate denies what ADR-0176 bars, admits nothing outside its list unless the allow
 *     file names it, and refuses an allow file with any entry that is neither "pending owner decision"
 *     nor a recorded owner acceptance ("accepted by owner <date> (ADR-NNNN decision N)");
 *   - the settings patch refuses to run on anything but exactly the expected code.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_MANIFEST, isPublicAddress, MODELSCAN_ENGINE_VERSION } from "@regulait/shared";
import { MODELSCAN_IMAGE_PATHS } from "./settings.js";
import { SCANNER_ISOLATED_SWITCH } from "./selftest.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "engines/modelscan");
const dockerfile = readFileSync(path.join(dir, "Dockerfile"), "utf8");
const requirements = readFileSync(path.join(dir, "requirements.txt"), "utf8");
const allowFile = JSON.parse(readFileSync(path.join(dir, "licence-allow.json"), "utf8")) as Array<{ subject: string; licence: string; decision: string }>;
type Row = { subject: string; term: string | null; licence: string };
const gate = (await import(path.join(dir, "licence-gate.mjs"))) as {
  inventory: (site: string, runtime?: string[]) => Row[];
  judge: (rows: Row[], allow: unknown) => { allowed: Row[]; pending: Row[]; denied: Row[]; stale: unknown[] };
  allowProblems: (allow: unknown) => string[];
  licenceTerms: (e: unknown) => string[] | null;
};

describe("the modelscan image's inputs", () => {
  it("every base is pinned by digest; the closure comes only from our hash-pinned lockfile", () => {
    const froms = [...dockerfile.matchAll(/^FROM --platform=linux\/amd64 (\S+)/gm)].map((m) => m[1]!);
    expect(froms.length).toBe([...dockerfile.matchAll(/^FROM /gm)].length);
    for (const b of froms) expect(b).toMatch(/^[a-z0-9.\/-]+:[a-z0-9.-]+@sha256:[0-9a-f]{64}$/);
    // the node stage is the gateway image's base
    const gatewayBase = /^FROM (\S+) AS runtime/m.exec(readFileSync(path.join(root, "Dockerfile"), "utf8"))![1];
    expect(froms).toContain(gatewayBase);
    expect(dockerfile).toMatch(/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements\.txt/);
    // every requirement: an exact version and a sha256
    const reqs = [...requirements.matchAll(/^([A-Za-z0-9._-]+)==(\S+) \\\n\s+--hash=sha256:([0-9a-f]{64})$/gm)];
    const lines = requirements.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("--hash"));
    expect(reqs.length).toBe(lines.length);
    expect(reqs.length).toBe(9);
    expect(reqs.find((r) => r[1] === "modelscan")?.[2]).toBe(MODELSCAN_ENGINE_VERSION);
    // R10's independently checked wheel hash
    expect(reqs.find((r) => r[1] === "modelscan")?.[3]).toBe("a1997df2368628daa1b3f394f5660a338b1debc623dec67b38f665ba04ad967e");
    // no TensorFlow (G19 1)
    expect(lines.join("\n")).not.toMatch(/tensorflow/i);
    expect(ENGINE_MANIFEST.modelscan.version).toBe(MODELSCAN_ENGINE_VERSION);
    expect(dockerfile).toContain(`v == '${MODELSCAN_ENGINE_VERSION}'`);
    expect(dockerfile).toContain(`org.regulait.engine-version="${MODELSCAN_ENGINE_VERSION}"`);
  });

  it("the patch, the licence gate and the read-only settings are in the build; the runtime is non-root with no pip", () => {
    expect(dockerfile).toMatch(/format-names-from-settings\.py \/opt\/modelscan\/venv\/lib\/python3\.12\/site-packages\/modelscan\/middlewares\/format_via_extension\.py/);
    expect(dockerfile).toMatch(/node licence-gate\.mjs \/opt\/modelscan\/venv\/lib\/python3\.12\/site-packages licence-allow\.json --runtime python=PSF-2\.0/);
    expect(dockerfile).toMatch(/pip uninstall -y --disable-pip-version-check pip/);
    expect(dockerfile).toMatch(/rm -rf \/usr\/local\/lib\/python3\.12\/site-packages\/pip /);
    expect(dockerfile).toContain(`COPY engines/modelscan/modelscan-settings.toml ${MODELSCAN_IMAGE_PATHS.settingsFile}`);
    expect(dockerfile).toContain(`chmod 0444 ${MODELSCAN_IMAGE_PATHS.settingsFile}`);
    expect(dockerfile).toMatch(/\nUSER 10001:10001\n/);
    // PR #212 review [4235322394]: the runtime stage proves at build time that node runs on its base,
    // with libstdc++ and libgcc from that base's own packages
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    const nodeCopy = runtime.indexOf("COPY --from=node /usr/local/bin/node /usr/local/bin/node");
    const nodeCheck = runtime.indexOf("&& node --version");
    expect(nodeCopy).toBeGreaterThan(0);
    expect(nodeCheck).toBeGreaterThan(nodeCopy);
    expect(runtime.slice(nodeCopy, nodeCheck)).toContain("dpkg-query -W -f='${Package} ${Version}\\n' libstdc++6 libgcc-s1");
    expect(runtime.slice(nodeCopy, nodeCheck)).toContain("ldd /usr/local/bin/node | grep -q 'not found'");
    expect(nodeCheck).toBeLessThan(runtime.indexOf("\nUSER "));
    expect(dockerfile).not.toMatch(/docker\.sock|EXPOSE/);
    const env = /\nENV ([\s\S]*?)\nUSER/.exec(dockerfile.slice(dockerfile.indexOf("AS runtime")))![1]!;
    expect(isPublicAddress(/REGULAIT_EGRESS_PROBE_ADDRESS=(\S+)/.exec(env)?.[1])).toBe(true);
    // the manifest's one usage-data entry is the scanner's isolation, judged by the runner
    expect(Object.keys(ENGINE_MANIFEST.modelscan.usageDataEnv)).toEqual([SCANNER_ISOLATED_SWITCH]);
  });

  it("every allow-file entry is a recorded owner acceptance or pending; the list is exactly the known one", () => {
    expect(gate.allowProblems(allowFile)).toEqual([]);
    // ADR-0187 decision 106 (owner, 2026-10-09): numpy's bundled runtime code accepted; HDF5 and CPython not asked yet
    expect(Object.fromEntries(allowFile.map((e) => [`${e.subject} ${e.licence}`, e.decision]))).toEqual({
      "numpy Zlib": "accepted by owner 2026-10-09 (ADR-0187 decision 106)",
      "numpy.libs/libgfortran GPL-3.0-or-later WITH GCC-exception-3.1": "accepted by owner 2026-10-09 (ADR-0187 decision 106)",
      "numpy.libs/libquadmath LGPL-2.1-or-later": "accepted by owner 2026-10-09 (ADR-0187 decision 106)",
      "h5py.libs/libhdf5 LicenseRef-HDF5": "pending owner decision",
      "h5py.libs/libhdf5_hl LicenseRef-HDF5": "pending owner decision",
      "python PSF-2.0": "pending owner decision",
    });
    expect(allowFile.map((e) => `${e.subject} ${e.licence}`).sort()).toEqual([
      "h5py.libs/libhdf5 LicenseRef-HDF5",
      "h5py.libs/libhdf5_hl LicenseRef-HDF5",
      "numpy Zlib",
      "numpy.libs/libgfortran GPL-3.0-or-later WITH GCC-exception-3.1",
      "numpy.libs/libquadmath LGPL-2.1-or-later",
      "python PSF-2.0",
    ]);
    expect(gate.allowProblems([{ subject: "numpy", licence: "Zlib", decision: "approved", why: "x" }])).toHaveLength(1);
    // an acceptance must name its date and the ADR decision that records it
    expect(gate.allowProblems([{ subject: "numpy", licence: "Zlib", decision: "accepted by owner", why: "x" }])).toHaveLength(1);
    expect(gate.allowProblems([{ subject: "numpy", licence: "Zlib", decision: "accepted by owner 2026-10-09 (ADR-0187 decision 106)", why: "x" }])).toEqual([]);
    expect(gate.allowProblems([{ subject: "numpy", licence: "Zlib", decision: "pending owner decision" }])).toHaveLength(1);
  });

  it("the gate denies the GPL family, unknown libraries and anything off the list the allow file does not name; flags stale entries", async () => {
    const site = await mkdtemp(path.join(tmpdir(), "b5m-site-"));
    const dist = async (name: string, meta: string) => {
      await mkdir(path.join(site, `${name}-1.0.dist-info`));
      await writeFile(path.join(site, `${name}-1.0.dist-info`, "METADATA"), `Metadata-Version: 2.4\nName: ${name}\nVersion: 1.0\n${meta}\n`);
    };
    await dist("good", "License-Expression: MIT");
    await dist("classified", "Classifier: License :: OSI Approved :: Apache Software License");
    await dist("numpy", "License-Expression: BSD-3-Clause AND Zlib");
    await dist("copyleft", "License-Expression: GPL-3.0-only");
    await dist("nolicence", "Summary: nothing said");
    await mkdir(path.join(site, "numpy.libs"));
    await writeFile(path.join(site, "numpy.libs", "libgfortran-abc.so.5"), "");
    await writeFile(path.join(site, "numpy.libs", "libmystery-abc.so.1"), "");
    const rows = gate.inventory(site, ["python=PSF-2.0"]);
    const none = gate.judge(rows, []);
    expect(none.allowed.map((r) => r.subject).sort()).toEqual(["classified", "good", "numpy"]);
    expect(none.denied.map((r) => `${r.subject}:${r.term}`).sort()).toEqual([
      "copyleft:GPL-3.0-only",
      "nolicence:null",
      "numpy.libs/libgfortran:GPL-3.0-or-later WITH GCC-exception-3.1",
      "numpy.libs/libmystery:null",
      "numpy:Zlib",
      "python:PSF-2.0",
    ]);
    const allow = [
      { subject: "numpy", licence: "Zlib", decision: "pending owner decision", why: "x" },
      { subject: "numpy.libs/libgfortran", licence: "GPL-3.0-or-later WITH GCC-exception-3.1", decision: "pending owner decision", why: "x" },
      { subject: "python", licence: "PSF-2.0", decision: "pending owner decision", why: "x" },
      { subject: "gone", licence: "Zlib", decision: "pending owner decision", why: "x" },
    ];
    const some = gate.judge(rows, allow);
    expect(some.pending).toHaveLength(3);
    expect(some.denied.map((r) => r.subject).sort()).toEqual(["copyleft", "nolicence", "numpy.libs/libmystery"]);
    expect(some.stale).toHaveLength(1);
    // an allow entry that is not pending admits nothing
    expect(gate.judge(rows, [{ ...allow[0], decision: "approved" }]).denied.map((r) => r.subject)).toContain("numpy");
  });

  it("ADR-0187 decision 180: the .npy header check is baked read-only where the scanner runs it, on the venv's interpreter", () => {
    expect(MODELSCAN_IMAGE_PATHS.npyHelper).toBe("/opt/modelscan/npy-header.py");
    expect(MODELSCAN_IMAGE_PATHS.python).toBe(`${MODELSCAN_IMAGE_PATHS.venvBin}/python`);
    expect(dockerfile).toContain(`COPY engines/modelscan/npy-header.py ${MODELSCAN_IMAGE_PATHS.npyHelper}`);
    expect(dockerfile).toMatch(new RegExp(`^RUN chmod 0444 \\S+ ${MODELSCAN_IMAGE_PATHS.npyHelper.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} `, "m"));
    // stdlib only: it imports nothing outside the standard library (it runs with -I -S)
    const helper = readFileSync(path.join(dir, "npy-header.py"), "utf8");
    const imports = [...helper.matchAll(/^(?:import|from) (\S+)/gm)].map((m) => m[1]);
    // decisions 219–224 add zipfile and zlib (the .npz check), both the standard library
    expect(imports.sort()).toEqual(["ast", "json", "os", "re", "sys", "zipfile", "zlib"]);
    // no builtin eval, exec or compile (re.compile is a method), no dynamic import
    expect(helper).not.toMatch(/(?<![\w.])(?:eval|exec|compile)\(|__import__|importlib/);
  });

  it.skipIf(spawnSync("python3", ["--version"]).status !== 0)("the settings patch applies only to exactly the expected code", async () => {
    const patch = path.join(dir, "patches/format-names-from-settings.py");
    const src = readFileSync(patch, "utf8");
    const expected = /EXPECTED = '''([\s\S]*?)'''/.exec(src)![1]!;
    const work = await mkdtemp(path.join(tmpdir(), "b5m-patch-"));
    const file = path.join(work, "format_via_extension.py");
    await writeFile(file, `class X:\n    def __call__(self, model, call_next):\n${expected}        call_next(model)\n`);
    const run = () => spawnSync("python3", ["-I", patch, file], { encoding: "utf8" });
    expect(run().status).toBe(0);
    expect(await readFile(file, "utf8")).toContain("RegulAIt patch (ADR-0187 decision 107)");
    expect(run().status).toBe(1); // already patched
    await writeFile(file, "class X:\n    pass\n");
    expect(run().status).toBe(1); // the upstream code moved
  });
});
