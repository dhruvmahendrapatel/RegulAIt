/**
 * ADR-0346 — the fairlearn image's inputs, read as text (as spikee's image.test.ts; no daemon needed):
 *   - every base is pinned by digest (spikee's bases); the closure is installed only from our hash-pinned lockfile,
 *     with no extra; fairlearn's pinned version is the manifest's;
 *   - the licence gate and an offline (`--network=none`) metric run are in the build; every usage-data switch is in the
 *     image's environment; the runtime is non-root, ships no pip, opens no port; the metric step is where config.ts
 *     says, read-only;
 *   - the licence gate's allow file names only licences the owner accepted for an earlier engine, each marked as reused
 *     and waiting for the owner's confirmation; a licence it does not name is still DENIED.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_MANIFEST, FAIRLEARN_ENGINE_VERSION, FAIRLEARN_USAGE_DATA_ENV, isPublicAddress } from "@regulait/shared";
import { FAIRLEARN_IMAGE_PATHS, FAIRLEARN_METRICS_BOOT, fairlearnMetricsArgs } from "./config.js";
import { FAIRLEARN_REQUIRED_SWITCHES } from "./main.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "engines/fairlearn");
const dockerfile = readFileSync(path.join(dir, "Dockerfile"), "utf8");
const requirements = readFileSync(path.join(dir, "requirements.txt"), "utf8");
const allowFile = JSON.parse(readFileSync(path.join(dir, "licence-allow.json"), "utf8")) as Array<{ subject: string; licence: string; decision: string; condition?: string }>;
const earlierAllow = ["garak", "modelscan", "spikee"].flatMap(
  (e) => JSON.parse(readFileSync(path.join(root, `engines/${e}/licence-allow.json`), "utf8")) as Array<{ subject: string; licence: string; decision: string }>,
);
const readings = JSON.parse(readFileSync(path.join(dir, "licence-readings.json"), "utf8")) as unknown[];
type Row = { subject: string; term: string | null; licence: string; distInfo?: string };
const gate = (await import(path.join(dir, "licence-gate.mjs"))) as {
  inventory: (site: string, runtime?: string[], readings?: unknown[]) => Row[];
  judge: (rows: Row[], allow: unknown, condition?: (r: Row, e: { condition?: string }) => string | null) => { allowed: Row[]; pending: Row[]; denied: Row[]; stale: unknown[] };
  allowProblems: (allow: unknown) => string[];
  readingProblems: (r: unknown) => string[];
  decisionValid: (d: unknown) => boolean;
  NATIVE_LIBRARIES: Record<string, string>;
};

const pins = (text: string) => [...text.matchAll(/^([A-Za-z0-9._-]+)==(\S+) \\\n\s+--hash=sha256:([0-9a-f]{64})$/gm)];
const entries = (text: string) => text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("--hash"));

describe("the fairlearn image's inputs", () => {
  it("every base is pinned by digest (spikee's); the closure comes only from our hash-pinned lockfile, with no extra", () => {
    const froms = [...dockerfile.matchAll(/^FROM --platform=linux\/amd64 (\S+)/gm)].map((m) => m[1]!);
    expect(froms.length).toBe([...dockerfile.matchAll(/^FROM /gm)].length);
    for (const b of froms) expect(b).toMatch(/^[a-z0-9.\/-]+:[a-z0-9.-]+@sha256:[0-9a-f]{64}$/);
    const spikeeFroms = new Set([...readFileSync(path.join(root, "engines/spikee/Dockerfile"), "utf8").matchAll(/^FROM --platform=linux\/amd64 (\S+)/gm)].map((m) => m[1]!));
    for (const b of froms) expect(spikeeFroms.has(b), b).toBe(true);
    expect(dockerfile).toMatch(/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements\.txt/);
    expect(dockerfile).toMatch(/pip check --disable-pip-version-check/);
    // every wheel: an exact version and ONE sha256
    expect(pins(requirements).length).toBe(entries(requirements).length);
    expect(pins(requirements).map((p) => p[1]).sort()).toEqual(["cloudpickle", "fairlearn", "joblib", "narwhals", "numpy", "pandas", "python-dateutil", "scikit-learn", "scipy", "threadpoolctl", "tzdata"]);
    const fl = pins(requirements).find((r) => r[1] === "fairlearn");
    expect(fl?.[2]).toBe(FAIRLEARN_ENGINE_VERSION);
    expect(requirements).not.toMatch(/fairlearn\[/);
    // no plotting or deep-learning extra
    expect(requirements).not.toMatch(/^(matplotlib|torch|tensorflow|plotly|nvidia-)/im);
    expect(ENGINE_MANIFEST.fairlearn.version).toBe(FAIRLEARN_ENGINE_VERSION);
    expect(dockerfile).toContain(`v == '${FAIRLEARN_ENGINE_VERSION}'`);
    expect(dockerfile).toContain(`org.regulait.engine-version="${FAIRLEARN_ENGINE_VERSION}"`);
    expect(dockerfile).toContain('org.regulait.engine="fairlearn"');
  });

  it("the licence gate and an offline metric run are in the build; the runtime is non-root, offline, with no pip and no port", () => {
    expect(dockerfile).toMatch(/node licence-gate\.mjs \/opt\/fairlearn\/venv\/lib\/python3\.12\/site-packages licence-allow\.json --readings licence-readings\.json --runtime python=PSF-2\.0/);
    expect(dockerfile).toMatch(/pip uninstall -y --disable-pip-version-check pip/);
    expect(dockerfile).toMatch(/rm -rf \/usr\/local\/lib\/python3\.12\/site-packages\/pip /);
    expect(dockerfile).toMatch(/\nUSER 10001:10001\n/);
    expect(dockerfile).not.toMatch(/docker\.sock|EXPOSE/);
    expect(dockerfile).toContain(`python -m venv ${FAIRLEARN_IMAGE_PATHS.venv} `);
    expect(dockerfile).toContain(`install -m 0444 fairlearn_metrics.py ${FAIRLEARN_IMAGE_PATHS.script}`);
    expect(FAIRLEARN_IMAGE_PATHS.python).toBe(`${FAIRLEARN_IMAGE_PATHS.venv}/bin/python`);
    // the offline proof: no network, the metric step exactly as the task starts it, its values asserted
    const proof = /\nRUN --network=none ([\s\S]*?)\n\n/.exec(dockerfile)?.[1] ?? "";
    expect(proof).toContain(`${FAIRLEARN_IMAGE_PATHS.python} ${fairlearnMetricsArgs().slice(0, 3).join(" ")} "${FAIRLEARN_METRICS_BOOT}" rows.json ${FAIRLEARN_IMAGE_PATHS.script}`);
    expect(proof).toContain("env -i PATH=");
    for (const [k, v] of Object.entries(FAIRLEARN_USAGE_DATA_ENV)) expect(proof, k).toContain(`${k}=${v} `);
    expect(proof).toContain("'demographic_parity_difference': 0.5");
    // the runtime environment carries every switch the manifest names (the worker-attested self-test switch is the runner's)
    const env = /\nENV ([\s\S]*?)\nUSER/.exec(dockerfile.slice(dockerfile.indexOf("AS runtime")))![1]!;
    for (const [k, v] of Object.entries(FAIRLEARN_USAGE_DATA_ENV)) expect(env, k).toContain(`${k}=${v} `);
    expect(FAIRLEARN_REQUIRED_SWITCHES.sort()).toEqual([...Object.keys(FAIRLEARN_USAGE_DATA_ENV), "REGULAIT_FAIRLEARN_WORKER_SELFTEST"].sort());
    expect(isPublicAddress(/REGULAIT_EGRESS_PROBE_ADDRESS=(\S+)/.exec(env)?.[1])).toBe(true);
    // the zlib1g fix, the same layer as every engine image's
    expect(dockerfile).toContain("apt-get install -y --only-upgrade --no-install-recommends zlib1g=1:1.3.dfsg+really1.3.1-1+deb13u1");
  });

  it("every allow-file entry is a licence the owner accepted for an earlier engine (marked reused) or for fairlearn itself (pinned)", () => {
    expect(gate.allowProblems(allowFile)).toEqual([]);
    expect(gate.readingProblems(readings)).toEqual([]);
    // ADR-0346 decision 13: libgomp is the owner's narrow ADR-0176 exception, pinned to the one file the wheel ships
    const gomp = allowFile.find((e) => e.subject === "scikit_learn.libs/libgomp") as { decision: string; sha256?: string };
    expect(gomp.decision).toBe("accepted by owner 2026-11-21 (ADR-0346 decision 13)");
    expect(gomp.sha256).toBe("a43904e4fa297301d4640dc1bb3c8a3480b406f99e498eba9b1914b68aab604a");
    for (const e of allowFile.filter((x) => x !== gomp)) {
      const m = /^reused from ADR-0187 decision (\d+) for fairlearn; owner to confirm \(ADR-0346\)$/.exec(e.decision);
      expect(m, e.subject).not.toBeNull();
      // the same licence carries that recorded acceptance in an earlier engine's allow file
      const g = earlierAllow.find((x) => x.licence === e.licence && new RegExp(`ADR-0187 decision ${m![1]}\\)$`).test(x.decision));
      expect(g, `${e.subject} ${e.licence}`).toBeDefined();
    }
    expect(allowFile.map((e) => e.subject).sort()).toEqual(["numpy", "python", "scikit_learn.libs/libgomp", "scipy.libs/libgfortran", "scipy.libs/libquadmath"]);
    expect(gate.decisionValid("reused from ADR-0187 decision 106 for fairlearn; owner to confirm (ADR-0346)")).toBe(true);
    expect(gate.decisionValid("reused from ADR-0187 decision 106 for spikee; owner to confirm (ADR-0245)")).toBe(false);
    expect(gate.decisionValid("reused, fine")).toBe(false);
    // the two native libraries only this closure bundles, as their wheels' licence files name them
    expect(gate.NATIVE_LIBRARIES.libgomp).toBe("GPL-3.0-or-later WITH GCC-exception-3.1");
    expect(gate.NATIVE_LIBRARIES.libscipy_openblas).toBe("BSD-3-Clause");
  });

  it("the gate stays strict: a licence the allow file does not name is DENIED", async () => {
    const site = await mkdtemp(path.join(tmpdir(), "fairlearn-strict-"));
    const dist = async (name: string, version: string, expr: string) => {
      const d = path.join(site, `${name}-${version}.dist-info`);
      await mkdir(d);
      await writeFile(path.join(d, "METADATA"), `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\nLicense-Expression: ${expr}\n`);
    };
    await dist("somepkg", "1.0", "AGPL-3.0-only");
    await dist("plainmit", "1.0", "MIT");
    await mkdir(path.join(site, "other.libs"));
    await writeFile(path.join(site, "other.libs", "libgomp-0.so.1"), "");
    await writeFile(path.join(site, "other.libs", "libmystery-0.so"), "");
    const j = gate.judge(gate.inventory(site), allowFile, () => null);
    // libgomp is admitted only where the allow file names it (scikit_learn.libs), never in another wheel
    expect(j.denied.map((r) => `${r.subject}:${r.term}`).sort()).toEqual(["other.libs/libgomp:GPL-3.0-or-later WITH GCC-exception-3.1", "other.libs/libmystery:null", "somepkg:AGPL-3.0-only"]);
    expect(j.allowed.map((r) => r.subject)).toEqual(["plainmit"]);
  });

  it("ADR-0346 decision 13: the libgomp admission covers only the pinned file, and an accepted GPL exception must pin one", async () => {
    const site = await mkdtemp(path.join(tmpdir(), "fairlearn-pin-"));
    await mkdir(path.join(site, "scikit_learn.libs"));
    // a libgomp that is not the pinned file (a rebuilt or replaced library) is DENIED, with the hashes named
    await writeFile(path.join(site, "scikit_learn.libs", "libgomp-e985bcbb.so.1.0.0"), "not the shipped library");
    const j = gate.judge(gate.inventory(site), allowFile, () => null) as { denied: Array<Row & { why?: string }>; pending: Row[] };
    expect(j.pending).toEqual([]);
    expect(j.denied.map((r) => r.subject)).toEqual(["scikit_learn.libs/libgomp"]);
    expect(j.denied[0]!.why).toMatch(/the admission pins a43904e4fa297301d4640dc1bb3c8a3480b406f99e498eba9b1914b68aab604a$/);
    // the allow file refuses an owner-accepted GPL-family exception without a pin, and a malformed pin
    const unpinned = allowFile.map((e) => (e.subject === "scikit_learn.libs/libgomp" ? { ...e, sha256: undefined } : e));
    expect(gate.allowProblems(unpinned)).toEqual([
      "entry 4 (scikit_learn.libs/libgomp) is an owner-accepted GPL-3.0-or-later WITH GCC-exception-3.1 exception and must pin its file's sha256",
    ]);
    expect(gate.allowProblems(allowFile.map((e) => (e.subject === "scikit_learn.libs/libgomp" ? { ...e, sha256: "abc" } : e)))).toEqual([
      "entry 4 (scikit_learn.libs/libgomp) sha256 is not a sha256",
    ]);
  });
});
