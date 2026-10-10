/**
 * ADR-0187 B5-G — the image's inputs, read as text (no daemon here; M-063/M-065: a configuration for a
 * target we cannot run is checked against its constraints before CI ever builds it):
 *   - every base is pinned by digest; the closure is installed only from our hash-pinned lockfiles;
 *     torch is the CPU-only wheel and nothing proprietary or GPU is pinned; garak's pinned version and
 *     hash are the manifest's and R10's;
 *   - the data prune, the probe-metadata check and the licence gate are in the build; every usage-data
 *     switch is in the image's environment; the runtime is non-root, ships no pip, opens no port;
 *   - the licence gate's allow file and readings are well formed, and a reading is honoured only for
 *     its exact version and file hash.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_MANIFEST, GARAK_ENGINE_VERSION, GARAK_UPSTREAM_SOURCE_SHA256, GARAK_USAGE_DATA_ENV, isPublicAddress } from "@regulait/shared";
import { GARAK_IMAGE_PATHS } from "./garak-run.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "engines/garak");
const dockerfile = readFileSync(path.join(dir, "Dockerfile"), "utf8");
const requirements = readFileSync(path.join(dir, "requirements.txt"), "utf8");
const sdists = readFileSync(path.join(dir, "requirements-sdist.txt"), "utf8");
const excluded = readFileSync(path.join(dir, "excluded-data.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const allowFile = JSON.parse(readFileSync(path.join(dir, "licence-allow.json"), "utf8")) as Array<{ subject: string; licence: string; decision: string }>;
const readings = JSON.parse(readFileSync(path.join(dir, "licence-readings.json"), "utf8")) as unknown[];
type Row = { subject: string; term: string | null; licence: string };
const gate = (await import(path.join(dir, "licence-gate.mjs"))) as {
  inventory: (site: string, runtime?: string[], readings?: unknown[]) => Row[] & { staleReadings: unknown[] };
  judge: (rows: Row[], allow: unknown) => { allowed: Row[]; pending: Row[]; denied: Row[]; stale: unknown[] };
  allowProblems: (allow: unknown) => string[];
  readingProblems: (r: unknown) => string[];
};

const pins = (text: string) => [...text.matchAll(/^([A-Za-z0-9._-]+)==(\S+) \\\n\s+--hash=sha256:([0-9a-f]{64})$/gm)];
const entries = (text: string) => text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("--hash"));

describe("the garak image's inputs", () => {
  it("every base is pinned by digest; the closure comes only from our hash-pinned lockfiles; torch is CPU-only", () => {
    const froms = [...dockerfile.matchAll(/^FROM --platform=linux\/amd64 (\S+)/gm)].map((m) => m[1]!);
    expect(froms.length).toBe([...dockerfile.matchAll(/^FROM /gm)].length);
    for (const b of froms) expect(b).toMatch(/^[a-z0-9.\/-]+:[a-z0-9.-]+@sha256:[0-9a-f]{64}$/);
    const gatewayBase = /^FROM (\S+) AS runtime/m.exec(readFileSync(path.join(root, "Dockerfile"), "utf8"))![1];
    expect(froms).toContain(gatewayBase);
    expect(dockerfile).toMatch(/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements\.txt/);
    expect(dockerfile).toMatch(/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --no-build-isolation --no-binary :all: -r requirements-sdist\.txt/);
    expect(dockerfile).toMatch(/pip check/);
    // every wheel: an exact version and ONE sha256; torch: the CPU wheel by URL and hash
    const torch = /^torch @ (https:\/\/download\.pytorch\.org\/whl\/cpu\/torch-2\.14\.1%2Bcpu-cp312-cp312-manylinux_2_28_x86_64\.whl) \\\n\s+--hash=sha256:([0-9a-f]{64})$/m.exec(requirements);
    expect(torch).not.toBeNull();
    expect(pins(requirements).length + 1).toBe(entries(requirements).length);
    expect(entries(requirements).length).toBe(176);
    expect(pins(sdists).map((p) => p[1])).toEqual(["ecoji", "langdetect"]);
    expect(entries(sdists).length).toBe(2);
    expect(pins(requirements).find((r) => r[1] === "garak")?.[2]).toBe(GARAK_ENGINE_VERSION);
    expect(pins(requirements).find((r) => r[1] === "garak")?.[3]).toBe("9a67e6298e4d7025358fecafa9d473c77ff70acdae103aa5251ad60fca3db145");
    // nothing proprietary or GPU-only (R10 consequence 1); setuptools pinned (it builds the two sdists)
    expect(requirements).not.toMatch(/^(nvidia-(?!riva)|cuda|triton)/m);
    expect(pins(requirements).some((r) => r[1] === "setuptools")).toBe(true);
    expect(ENGINE_MANIFEST.garak.version).toBe(GARAK_ENGINE_VERSION);
    expect(dockerfile).toContain(`v == '${GARAK_ENGINE_VERSION}'`);
    expect(dockerfile).toContain(`org.regulait.engine-version="${GARAK_ENGINE_VERSION}"`);
  });

  it("the prune, the metadata check and the licence gate are in the build; the runtime is non-root, offline, with no pip and no port", () => {
    expect(dockerfile).toContain(`prune-data.py /opt/garak/venv/lib/python3.12/site-packages excluded-data.txt ${GARAK_UPSTREAM_SOURCE_SHA256}`);
    expect(dockerfile).toMatch(/node licence-gate\.mjs \/opt\/garak\/venv\/lib\/python3\.12\/site-packages licence-allow\.json --readings licence-readings\.json --runtime python=PSF-2\.0/);
    expect(dockerfile).toMatch(/pip uninstall -y --disable-pip-version-check pip/);
    expect(dockerfile).toMatch(/rm -rf \/usr\/local\/lib\/python3\.12\/site-packages\/pip /);
    expect(dockerfile).toMatch(/\nUSER 10001:10001\n/);
    expect(dockerfile).not.toMatch(/docker\.sock|EXPOSE/);
    expect(dockerfile).toContain("COPY --from=closure /opt/garak /opt/garak");
    expect(dockerfile).toContain(`python -m venv ${GARAK_IMAGE_PATHS.venv} `);
    const env = /\nENV ([\s\S]*?)\nUSER/.exec(dockerfile.slice(dockerfile.indexOf("AS runtime")))![1]!;
    for (const [k, v] of Object.entries(GARAK_USAGE_DATA_ENV)) expect(env, k).toContain(`${k}=${v} `);
    expect(isPublicAddress(/REGULAIT_EGRESS_PROBE_ADDRESS=(\S+)/.exec(env)?.[1])).toBe(true);
    // the copyrighted, personal and unlicensed data G19 named is removed (R10 consequence 10)
    for (const p of ["nyt_cloze.tsv", "potter_cloze.tsv", "guardian_cloze.tsv", "book_cloze.tsv", "propile", "dan", "phrasing", "slurprompts.jsonl", "truefalse_falseclaims.txt"]) expect(excluded, p).toContain(p);
    // and what the admitted probes read stays
    for (const p of ["inthewild_jailbreak_llms.json", "autodan", "donotanswer", "payloads", "xss", "graph_connectivity.json"]) expect(excluded, p).not.toContain(p);
  });

  it("every allow-file entry is a recorded owner acceptance or pending; the readings are well formed", () => {
    expect(gate.allowProblems(allowFile)).toEqual([]);
    expect(gate.readingProblems(readings)).toEqual([]);
    const accepted = allowFile.filter((e) => e.decision !== "pending owner decision").map((e) => e.subject).sort();
    // only decision 106's numpy entries are accepted; nothing is accepted on garak's behalf
    expect(accepted).toEqual(["numpy", "numpy.libs/libgfortran", "numpy.libs/libquadmath"]);
    for (const e of allowFile.filter((x) => x.decision !== "pending owner decision")) expect(e.decision).toBe("accepted by owner 2026-10-09 (ADR-0187 decision 106)");
    // no copyleft beyond what decision 106 accepted
    expect(allowFile.filter((e) => /GPL|AGPL|SSPL|BUSL|EPL/.test(e.licence)).map((e) => e.subject).sort()).toEqual(["numpy.libs/libgfortran", "numpy.libs/libquadmath"]);
  });

  it("a reading is honoured only for its exact version and licence file; a stale reading is reported", async () => {
    const site = await mkdtemp(path.join(tmpdir(), "b5g-site-"));
    const lic = "Redistribution and use in source and binary forms ... Neither the name ...";
    const dist = async (name: string, version: string, meta: string) => {
      const d = path.join(site, `${name}-${version}.dist-info`);
      await mkdir(d);
      await writeFile(path.join(d, "METADATA"), `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\n${meta}\n`);
      await writeFile(path.join(d, "LICENSE"), lic);
    };
    await dist("vague", "1.0", "License: BSD");
    await dist("other", "2.0", "Summary: none");
    await dist("copyleft", "1.0", "License-Expression: GPL-3.0-only");
    const sha = createHash("sha256").update(lic).digest("hex");
    const r = [
      { subject: "vague", version: "1.0", file: "LICENSE", sha256: sha, licence: "BSD-3-Clause", read: "x" },
      // the wrong version: never used
      { subject: "other", version: "1.0", file: "LICENSE", sha256: sha, licence: "MIT", read: "x" },
      // a reading cannot overturn metadata that names a licence the list bars? It is consulted (the metadata does not pass),
      // but only with the exact file hash: this one does not match
      { subject: "copyleft", version: "1.0", file: "LICENSE", sha256: "0".repeat(64), licence: "MIT", read: "x" },
    ];
    const rows = gate.inventory(site, [], r);
    const j = gate.judge(rows, []);
    expect(j.allowed.map((x) => x.subject)).toEqual(["vague"]);
    expect(j.denied.map((x) => `${x.subject}:${x.term}`).sort()).toEqual(["copyleft:GPL-3.0-only", "other:null"]);
    expect((rows.staleReadings as Array<{ subject: string }>).map((x) => x.subject).sort()).toEqual(["copyleft", "other"]);
    // with no readings, the vague metadata is denied
    expect(gate.judge(gate.inventory(site, [], []), []).denied.map((x) => x.subject)).toContain("vague");
  });
});
