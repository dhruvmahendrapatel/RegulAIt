/**
 * ADR-0187 B5-G — the image's inputs, read as text (no daemon here; M-063/M-065: a configuration for a
 * target we cannot run is checked against its constraints before CI ever builds it):
 *   - every base is pinned by digest; the closure is installed only from our hash-pinned lockfiles;
 *     torch is the CPU-only wheel and nothing proprietary or GPU is pinned; garak's pinned version and
 *     hash are the manifest's and R10's;
 *   - the data prune, the probe-metadata check and the licence gate are in the build; every usage-data
 *     switch is in the image's environment; the runtime is non-root, ships no pip, opens no port;
 *   - the licence gate's allow file and readings are well formed, and a reading is honoured only for
 *     its exact version and file hash;
 *   - (decisions 193-194) every allow-file entry is an owner acceptance; a licence the allow file does not
 *     name is still DENIED; MPL-2.0 is admitted only while every file matches its wheel RECORD hash;
 *   - (decisions 197-200) the admitted data stays, the two word lists the owner kept deleted are still
 *     deleted; the Hub pre-seed is pinned by commit and sha256, proven offline in a `--network=none`
 *     build step, and ships read-only with the data notices.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_MANIFEST, GARAK_ENGINE_VERSION, GARAK_PRESEEDED_HF_ASSETS, GARAK_UPSTREAM_SOURCE_SHA256, GARAK_USAGE_DATA_ENV, isPublicAddress } from "@regulait/shared";
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
const allowFile = JSON.parse(readFileSync(path.join(dir, "licence-allow.json"), "utf8")) as Array<{ subject: string; licence: string; decision: string; condition?: string }>;
const preseed = JSON.parse(readFileSync(path.join(dir, "hf-preseed.json"), "utf8")) as {
  assets: Array<{ kind: string; id: string; revision: string; licence: string; usedBy: string[]; files: Array<{ path: string; sha256: string; size: number }> }>;
};
const notices = readFileSync(path.join(dir, "IMAGE-NOTICES.txt"), "utf8");
const readings = JSON.parse(readFileSync(path.join(dir, "licence-readings.json"), "utf8")) as unknown[];
type Row = { subject: string; term: string | null; licence: string; distInfo?: string; why?: string };
const gate = (await import(path.join(dir, "licence-gate.mjs"))) as {
  inventory: (site: string, runtime?: string[], readings?: unknown[]) => Row[] & { staleReadings: unknown[] };
  judge: (rows: Row[], allow: unknown, condition?: (r: Row, e: { condition?: string }) => string | null) => { allowed: Row[]; pending: Row[]; denied: Row[]; stale: unknown[] };
  recordProblem: (site: string, distInfo: string | undefined) => string | null;
  allowProblems: (allow: unknown) => string[];
  readingProblems: (r: unknown) => string[];
};

const pins = (text: string) => [...text.matchAll(/^([A-Za-z0-9._-]+)==(\S+) \\\n\s+--hash=sha256:([0-9a-f]{64})$/gm)];
const entries = (text: string) => text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("--hash"));

describe("the garak image's inputs", () => {
  it("every base is pinned by digest; the closure comes only from our hash-pinned lockfiles; torch is CPU-only", () => {
    const froms = [...dockerfile.matchAll(/^FROM --platform=linux\/amd64 (\S+)/gm)].map((m) => m[1]!);
    // every other FROM builds on an earlier stage of this file (the pre-seed stage on the closure)
    const stageFroms = [...dockerfile.matchAll(/^FROM (\S+) AS (\S+)$/gm)].filter((m) => !m[1]!.startsWith("--"));
    expect(stageFroms.map((m) => `${m[1]}>${m[2]}`)).toEqual(["closure>preseed"]);
    expect(froms.length + stageFroms.length).toBe([...dockerfile.matchAll(/^FROM /gm)].length);
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
    // and what the admitted probes read stays: since the owner's decisions of 2026-10-10 that includes the
    // Unicode confusables data (badchars) and the CC-BY-4.0 word list (decision 197)
    for (const p of ["inthewild_jailbreak_llms.json", "autodan", "donotanswer", "payloads", "xss", "graph_connectivity.json", "badchars", "ldnoobw-en.txt", "sysprompt_extraction"]) {
      expect(excluded, p).not.toContain(p);
    }
    // the two word lists the owner kept deleted (question 26) are still deleted, and so are the unlicensed slur lists
    for (const p of ["profanity_en.csv", "ofcom-potentially-offensive.txt", "slurprompts.jsonl", "slursreclaimedslurs.txt"]) expect(excluded, p).toContain(p);
    expect(excluded.length).toBe(23);
  });

  it("every allow-file entry is a recorded owner acceptance (decision 106 or the owner's 2026-10-10 question 21); the readings are well formed", () => {
    expect(gate.allowProblems(allowFile)).toEqual([]);
    expect(gate.readingProblems(readings)).toEqual([]);
    expect(allowFile.filter((e) => e.decision === "pending owner decision")).toEqual([]);
    const by106 = allowFile.filter((e) => e.decision === "accepted by owner 2026-10-09 (ADR-0187 decision 106)").map((e) => e.subject).sort();
    expect(by106).toEqual(["numpy", "numpy.libs/libgfortran", "numpy.libs/libquadmath"]);
    const by193 = allowFile.filter((e) => e.decision === "accepted by owner 2026-10-10 (ADR-0187 decision 193)");
    expect(by193.length).toBe(20);
    expect(by106.length + by193.length).toBe(allowFile.length);
    // exactly the licences the owner named (question 21), nothing else
    const named = new Set(["PSF-2.0", "MPL-2.0", "ZPL-2.1", "MIT-0", "CNRI-Python", "MIT-CMU", "FTL", "MIT-Modern-Variant", "IJG AND BSD-3-Clause AND Zlib", "libpng-2.0", "libtiff", "BSL-1.0", "Apache-2.0 WITH LLVM-exception"]);
    for (const e of by193) expect(named.has(e.licence), `${e.subject} ${e.licence}`).toBe(true);
    // MPL-2.0 only while unmodified (decision 194); and the gate refuses an MPL entry without that condition
    for (const e of allowFile.filter((x) => x.licence === "MPL-2.0")) expect(e.condition, e.subject).toBe("unmodified");
    expect(allowFile.filter((e) => e.condition !== undefined).map((e) => e.subject).sort()).toEqual(["certifi", "mikeshardmind-base2048", "orjson", "tqdm"]);
    const noCondition = allowFile.map((e) => (e.licence === "MPL-2.0" ? { ...e, condition: undefined } : e));
    expect(gate.allowProblems(noCondition).filter((p) => /admitted only with condition "unmodified"/.test(p)).length).toBe(4);
    expect(gate.allowProblems([{ ...allowFile[0]!, condition: "patched-ok" }])[0]).toMatch(/unknown condition/);
    // "BSL-1.0" here is Boost's (torch), never the Business Source License ADR-0176 bans
    expect(allowFile.filter((e) => e.licence === "BSL-1.0").map((e) => e.subject)).toEqual(["torch"]);
    // no copyleft beyond what decision 106 accepted
    expect(allowFile.filter((e) => /GPL|AGPL|SSPL|BUSL|EPL/.test(e.licence)).map((e) => e.subject).sort()).toEqual(["numpy.libs/libgfortran", "numpy.libs/libquadmath"]);
  });

  it("the gate stays strict: a licence the allow file does not name is DENIED, even for an admitted subject", async () => {
    const site = await mkdtemp(path.join(tmpdir(), "b5g-strict-"));
    const dist = async (name: string, version: string, expr: string) => {
      const d = path.join(site, `${name}-${version}.dist-info`);
      await mkdir(d);
      await writeFile(path.join(d, "METADATA"), `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\nLicense-Expression: ${expr}\n`);
    };
    await dist("somepkg", "1.0", "EPL-2.0"); // not named anywhere
    await dist("unicodepkg", "1.0", "Unicode-3.0"); // permissive, but not named in the allow file
    await dist("regex", "9.9", "CNRI-Python AND LGPL-3.0-only"); // an admitted subject: its admitted term passes, the other is denied
    await dist("plainmit", "1.0", "MIT"); // control: on the list
    const j = gate.judge(gate.inventory(site), allowFile, () => null);
    expect(j.denied.map((r) => `${r.subject}:${r.term}`).sort()).toEqual(["regex:LGPL-3.0-only", "somepkg:EPL-2.0", "unicodepkg:Unicode-3.0"]);
    expect(j.allowed.map((r) => r.subject)).toEqual(["plainmit"]);
    expect(j.pending.map((r) => `${r.subject}:${r.term}`)).toEqual(["regex:CNRI-Python"]);
  });

  it("MPL-2.0 is admitted only while unmodified: a changed or missing file against the wheel's RECORD denies it", async () => {
    // laid out as a venv: RECORD paths may reach the venv's bin, never outside the venv
    const site = path.join(await mkdtemp(path.join(tmpdir(), "b5g-mpl-")), "venv/lib/python3.12/site-packages");
    const d = path.join(site, "certifi-2026.7.22.dist-info");
    await mkdir(d, { recursive: true });
    await mkdir(path.join(site, "certifi"));
    await writeFile(path.join(d, "METADATA"), "Metadata-Version: 2.4\nName: certifi\nVersion: 2026.7.22\nLicense-Expression: MPL-2.0\n");
    const body = "def where():\n    return 'cacert.pem'\n";
    await writeFile(path.join(site, "certifi", "core.py"), body);
    const b64 = createHash("sha256").update(body).digest("base64url");
    await writeFile(path.join(d, "RECORD"), `certifi/core.py,sha256=${b64},${Buffer.byteLength(body)}\ncertifi-2026.7.22.dist-info/RECORD,,\n`);
    const check = (r: Row, e: { condition?: string }) => (e.condition === "unmodified" ? gate.recordProblem(site, r.distInfo) : "unknown");
    const judgeNow = () => gate.judge(gate.inventory(site), allowFile.filter((e) => e.subject === "certifi"), check);
    expect(judgeNow().pending.map((r) => r.subject)).toEqual(["certifi"]);
    // with no condition checker at all, a conditional entry admits nothing
    expect(gate.judge(gate.inventory(site), allowFile.filter((e) => e.subject === "certifi")).denied.map((r) => r.subject)).toEqual(["certifi"]);
    await appendFile(path.join(site, "certifi", "core.py"), "# patched\n");
    const j = judgeNow();
    expect(j.pending).toEqual([]);
    expect(j.denied[0]!.why).toMatch(/certifi\/core\.py is modified/);
    await writeFile(path.join(d, "RECORD"), `../../../../etc/passwd,sha256=${b64},1\n`);
    expect(judgeNow().denied[0]!.why).toMatch(/escapes the environment/);
  });

  it("the Hub pre-seed: pinned by commit and sha256, licence-clear, fetched once, proven offline, shipped read-only (decisions 198-200)", () => {
    // the shared table and the build's manifest agree, row for row
    expect(preseed.assets.map(({ kind, id, revision, licence, usedBy }) => ({ kind, id, revision, licence, usedBy }))).toEqual(GARAK_PRESEEDED_HF_ASSETS.map((a) => ({ ...a, usedBy: [...a.usedBy] })));
    expect(preseed.assets.filter((a) => a.kind === "model").length).toBe(2);
    expect(preseed.assets.filter((a) => a.kind === "dataset").length).toBe(7);
    let bytes = 0;
    for (const a of preseed.assets) {
      expect(a.revision, a.id).toMatch(/^[0-9a-f]{40}$/);
      expect(["mit", "apache-2.0"], a.id).toContain(a.licence);
      expect(a.files.map((f) => f.path), a.id).toContain("README.md"); // the licence is read from the card at that commit
      for (const f of a.files) {
        expect(f.sha256, `${a.id}/${f.path}`).toMatch(/^[0-9a-f]{64}$/);
        expect(f.path).not.toMatch(/(^\/|\.\.|\.py$)/); // no absolute path, no traversal, no code
        bytes += f.size;
      }
    }
    // the owner's estimate was about 2 GB; the brief's ceiling 2.5 GB (the materialised datasets add ~0.25 GB)
    expect(bytes).toBeLessThan(2.1e9);
    // the build: fetch and materialise, then a step with NO network that loads every asset; the tree is
    // copied alone (not the venv the pre-seed ran in), root-owned and read-only, at the path the worker reads
    expect(dockerfile).toMatch(/preseed-hf\.py fetch hf-preseed\.json \/opt\/garak\/hf/);
    expect(dockerfile).toMatch(/preseed-hf\.py materialise hf-preseed\.json \/opt\/garak\/hf/);
    expect(dockerfile).toMatch(/RUN --network=none [^\n]*HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_DATASETS_OFFLINE=1[^\n]*\\\n\s+\/opt\/garak\/venv\/bin\/python -I preseed-hf\.py verify hf-preseed\.json \/opt\/garak\/hf/);
    expect(dockerfile).toContain(`COPY --from=preseed ${GARAK_IMAGE_PATHS.hfPreseed} ${GARAK_IMAGE_PATHS.hfPreseed}`);
    expect(dockerfile).toMatch(/chmod -R a-w,a\+rX \/opt\/garak\/hf/);
    expect(dockerfile).toContain("COPY engines/garak/IMAGE-NOTICES.txt /opt/garak/NOTICES.txt");
  });

  it("the image notices carry the Unicode and CC-BY-4.0 attributions and the OpenRAIL use restrictions (decision 197)", () => {
    expect(notices).toContain("UNICODE LICENSE V3");
    expect(notices).toContain("this copyright and permission notice appear with all copies");
    expect(notices).toMatch(/ldnoobw-en\.txt[\s\S]*CC-BY-4\.0/);
    expect(notices).toContain("CreativeML Open RAIL++-M");
    expect(notices).toContain("You agree not to use the Model or Derivatives of the Model:");
    expect(notices).toContain("To provide medical advice and medical results interpretation;");
    for (const a of preseed.assets) {
      expect(notices, a.id).toContain(a.id);
      expect(notices, a.id).toContain(a.revision);
    }
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
