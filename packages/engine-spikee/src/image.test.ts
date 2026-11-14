/**
 * ADR-0245 — the spikee image's inputs, read as text (as garak's image.test.ts; no daemon needed):
 *   - every base is pinned by digest (garak's bases); the closure is installed only from our hash-pinned lockfile, with
 *     no spikee extra; spikee's pinned version is the manifest's;
 *   - the seed check and prune, the licence gate and an offline (`--network=none`) generation are in the build; every
 *     usage-data switch is in the image's environment; the runtime is non-root, ships no pip, opens no port;
 *   - the licence gate's allow file names only licences the owner accepted for garak, each marked as reused and
 *     waiting for the owner's confirmation; a licence it does not name is still DENIED;
 *   - the excluded paths are the Hub fetch scripts and the workspace LLM judges.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_MANIFEST, isPublicAddress, SPIKEE_ENGINE_VERSION, SPIKEE_LOCAL_SEEDS_SHA256, SPIKEE_SETS, SPIKEE_USAGE_DATA_ENV } from "@regulait/shared";
import { SPIKEE_SEEDS_DIR } from "./config.js";
import { SPIKEE_IMAGE_PATHS } from "./spikee-run.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dir = path.join(root, "engines/spikee");
const dockerfile = readFileSync(path.join(dir, "Dockerfile"), "utf8");
const requirements = readFileSync(path.join(dir, "requirements.txt"), "utf8");
const prune = readFileSync(path.join(dir, "prune-data.py"), "utf8");
const excluded = readFileSync(path.join(dir, "excluded-data.txt"), "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith("#"));
const allowFile = JSON.parse(readFileSync(path.join(dir, "licence-allow.json"), "utf8")) as Array<{ subject: string; licence: string; decision: string; condition?: string }>;
const garakAllow = JSON.parse(readFileSync(path.join(root, "engines/garak/licence-allow.json"), "utf8")) as Array<{ subject: string; licence: string; decision: string }>;
const readings = JSON.parse(readFileSync(path.join(dir, "licence-readings.json"), "utf8")) as unknown[];
type Row = { subject: string; term: string | null; licence: string; distInfo?: string };
const gate = (await import(path.join(dir, "licence-gate.mjs"))) as {
  inventory: (site: string, runtime?: string[], readings?: unknown[]) => Row[];
  judge: (rows: Row[], allow: unknown, condition?: (r: Row, e: { condition?: string }) => string | null) => { allowed: Row[]; pending: Row[]; denied: Row[]; stale: unknown[] };
  allowProblems: (allow: unknown) => string[];
  readingProblems: (r: unknown) => string[];
  decisionValid: (d: unknown) => boolean;
};

const pins = (text: string) => [...text.matchAll(/^([A-Za-z0-9._-]+)==(\S+) \\\n\s+--hash=sha256:([0-9a-f]{64})$/gm)];
const entries = (text: string) => text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("--hash"));

describe("the spikee image's inputs", () => {
  it("every base is pinned by digest (garak's); the closure comes only from our hash-pinned lockfile, with no extra", () => {
    const froms = [...dockerfile.matchAll(/^FROM --platform=linux\/amd64 (\S+)/gm)].map((m) => m[1]!);
    expect(froms.length).toBe([...dockerfile.matchAll(/^FROM /gm)].length);
    for (const b of froms) expect(b).toMatch(/^[a-z0-9.\/-]+:[a-z0-9.-]+@sha256:[0-9a-f]{64}$/);
    const garakFroms = new Set([...readFileSync(path.join(root, "engines/garak/Dockerfile"), "utf8").matchAll(/^FROM --platform=linux\/amd64 (\S+)/gm)].map((m) => m[1]!));
    for (const b of froms) expect(garakFroms.has(b), b).toBe(true);
    expect(dockerfile).toMatch(/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps --only-binary :all: -r requirements\.txt/);
    expect(dockerfile).toMatch(/pip check/);
    // every wheel: an exact version and ONE sha256
    expect(pins(requirements).length).toBe(entries(requirements).length);
    // 70 resolved, less spikee's unused `datasets` and the 18 packages only it needs (fsspec CVE-2026-104851)
    expect(pins(requirements).length).toBe(51);
    const spikee = pins(requirements).find((r) => r[1] === "spikee");
    expect(spikee?.[2]).toBe(SPIKEE_ENGINE_VERSION);
    expect(spikee?.[3]).toBe("3768463052de5d89f94ec4a4c4dd11c492c6e2f7b31e09b45eade9e57ffaa3d6");
    // no extra's providers or local inference: no torch, transformers, boto3, azure, groq, ollama, googletrans, PIL
    expect(requirements).not.toMatch(/^(torch|transformers|boto3|botocore|azure-|groq|ollama|googletrans|pillow|sentencepiece|nvidia-)/im);
    expect(requirements).not.toMatch(/spikee\[/);
    expect(ENGINE_MANIFEST.spikee.version).toBe(SPIKEE_ENGINE_VERSION);
    expect(dockerfile).toContain(`v == '${SPIKEE_ENGINE_VERSION}'`);
    expect(dockerfile).toContain(`org.regulait.engine-version="${SPIKEE_ENGINE_VERSION}"`);
    expect(dockerfile).toContain('org.regulait.engine="spikee"');
  });

  it("the seed check and prune, the licence gate and an offline generation are in the build; the runtime is non-root, offline, with no pip and no port", () => {
    expect(dockerfile).toContain(`prune-data.py /opt/spikee/venv/lib/python3.12/site-packages excluded-data.txt ${SPIKEE_LOCAL_SEEDS_SHA256}`);
    expect(dockerfile).toMatch(/node licence-gate\.mjs \/opt\/spikee\/venv\/lib\/python3\.12\/site-packages licence-allow\.json --readings licence-readings\.json --runtime python=PSF-2\.0/);
    expect(dockerfile).toMatch(/pip uninstall -y --disable-pip-version-check pip/);
    expect(dockerfile).toMatch(/rm -rf \/usr\/local\/lib\/python3\.12\/site-packages\/pip /);
    expect(dockerfile).toMatch(/\nRUN --network=none [^\n]*HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1/);
    expect(dockerfile).toMatch(/\nUSER 10001:10001\n/);
    expect(dockerfile).not.toMatch(/docker\.sock|EXPOSE/);
    expect(dockerfile).toContain(`python -m venv ${SPIKEE_IMAGE_PATHS.venv} `);
    expect(dockerfile).toContain(`/datasets ${SPIKEE_SEEDS_DIR}`);
    expect(SPIKEE_IMAGE_PATHS.seeds).toBe(SPIKEE_SEEDS_DIR);
    const env = /\nENV ([\s\S]*?)\nUSER/.exec(dockerfile.slice(dockerfile.indexOf("AS runtime")))![1]!;
    for (const [k, v] of Object.entries(SPIKEE_USAGE_DATA_ENV)) expect(env, k).toContain(`${k}=${v} `);
    expect(isPublicAddress(/REGULAIT_EGRESS_PROBE_ADDRESS=(\S+)/.exec(env)?.[1])).toBe(true);
    // the seed folders the digest covers are exactly the catalogue's local datasets
    const local = SPIKEE_SETS.filter((e) => e.kind === "dataset" && e.disposition === "local").map((e) => `seeds-${e.name}`).sort();
    const listed = JSON.parse(/LOCAL_SEED_FOLDERS = (\[[^\]]*\])/.exec(prune)![1]!) as string[];
    expect([...listed].sort()).toEqual(local);
  });

  it("fsspec CVE-2026-104851: spikee's unused `datasets` requirement and its closure are not installed, and the build proves it", () => {
    // neither datasets nor what only it pulls in is in the lockfile (datasets 4.8.4 caps fsspec at the vulnerable 2026.2.0)
    const pinned = [...requirements.matchAll(/^([A-Za-z0-9_.-]+)==/gm)].map((m) => m[1]!.toLowerCase());
    for (const gone of ["datasets", "fsspec", "huggingface-hub", "pyarrow", "aiohttp", "multiprocess", "dill", "xxhash"]) expect(pinned, gone).not.toContain(gone);
    // the requirement is dropped from the reviewed METADATA (by sha256) before `pip check`, which still runs strictly
    const install = dockerfile.indexOf("--require-hashes --no-deps --only-binary :all: -r requirements.txt");
    const drop = dockerfile.indexOf("drop-unused-requirement.py /opt/spikee/venv/lib/python3.12/site-packages 9b8d089a59db502eb23055cdf4e1fcb30528ba98802224e3727dcfb50ff1a5fa");
    const check = dockerfile.indexOf("pip check --disable-pip-version-check");
    expect(install).toBeGreaterThan(0);
    expect(drop).toBeGreaterThan(install);
    expect(check).toBeGreaterThan(drop);
    expect(dockerfile).toContain("for m in ('datasets', 'fsspec', 'huggingface_hub', 'pyarrow', 'aiohttp') if u.find_spec(m)");
    const script = readFileSync(path.join(dir, "drop-unused-requirement.py"), "utf8");
    expect(script).toContain('DROP = "Requires-Dist: datasets==4.8.4"');
    expect(script).toContain("if len(hits) != 1:");
    // no admitted seed folder needs it: its only importers are the fetch scripts the prune removes
    for (const f of excluded.filter((e) => e.endsWith("fetch_and_convert_dataset.py"))) expect(f).toMatch(/^workspace\/datasets\/seeds-[a-z0-9-]+\/fetch_and_convert_dataset\.py$/);
  });

  it("the excluded paths are the Hub fetch scripts and the workspace LLM judges, and only cloud-only seed folders lose files", () => {
    const fetch = excluded.filter((p) => p.endsWith("/fetch_and_convert_dataset.py"));
    expect(fetch.length).toBe(5);
    for (const p of fetch) {
      const seed = /^workspace\/datasets\/seeds-([a-z0-9-]+)\//.exec(p)![1]!;
      expect(SPIKEE_SETS.find((e) => e.set === `dataset:${seed}`)?.disposition, seed).toBe("cloud_only");
    }
    expect(excluded.filter((p) => p.startsWith("workspace/judges/llm_judge_")).length).toBe(3);
    expect(excluded.length).toBe(8);
    for (const p of excluded) expect(p).not.toMatch(/(^\/|\.\.)/);
  });

  it("every allow-file entry is a licence the owner accepted for garak, marked reused and waiting for the owner", () => {
    expect(gate.allowProblems(allowFile)).toEqual([]);
    expect(gate.readingProblems(readings)).toEqual([]);
    for (const e of allowFile) {
      const m = /^reused from ADR-0187 decision (\d+) for spikee; owner to confirm \(ADR-0245\)$/.exec(e.decision);
      expect(m, e.subject).not.toBeNull();
      // the same subject and licence carries that recorded acceptance in garak's allow file
      const g = garakAllow.find((x) => x.subject === e.subject && x.licence === e.licence);
      expect(g?.decision, `${e.subject} ${e.licence}`).toMatch(new RegExp(`\\(ADR-0187 decision ${m![1]}\\)$`));
    }
    expect(allowFile.map((e) => e.subject).sort()).toEqual(["certifi", "numpy", "numpy.libs/libgfortran", "numpy.libs/libquadmath", "python", "regex", "tqdm", "typing_extensions"]);
    for (const e of allowFile.filter((x) => x.licence === "MPL-2.0")) expect(e.condition, e.subject).toBe("unmodified");
    // the gate accepts only the exact reuse wording, never a free-form acceptance
    expect(gate.decisionValid("reused from ADR-0187 decision 193 for spikee; owner to confirm (ADR-0245)")).toBe(true);
    expect(gate.decisionValid("reused from garak, fine")).toBe(false);
    expect(gate.decisionValid("accepted by owner 2026-11-07 (ADR-0245 decision 1)")).toBe(true);
  });

  it("the gate stays strict: a licence the allow file does not name is DENIED", async () => {
    const site = await mkdtemp(path.join(tmpdir(), "spikee-strict-"));
    const dist = async (name: string, version: string, expr: string) => {
      const d = path.join(site, `${name}-${version}.dist-info`);
      await mkdir(d);
      await writeFile(path.join(d, "METADATA"), `Metadata-Version: 2.4\nName: ${name}\nVersion: ${version}\nLicense-Expression: ${expr}\n`);
    };
    await dist("somepkg", "1.0", "AGPL-3.0-only");
    await dist("regex", "9.9", "CNRI-Python AND LGPL-3.0-only");
    await dist("plainmit", "1.0", "MIT");
    const j = gate.judge(gate.inventory(site), allowFile, () => null);
    expect(j.denied.map((r) => `${r.subject}:${r.term}`).sort()).toEqual(["regex:LGPL-3.0-only", "somepkg:AGPL-3.0-only"]);
    expect(j.allowed.map((r) => r.subject)).toEqual(["plainmit"]);
  });
});
