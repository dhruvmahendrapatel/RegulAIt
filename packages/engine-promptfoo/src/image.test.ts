/**
 * ADR-0187 B5-P — the image's inputs, read as text (no daemon; M-063/M-065: a configuration for a
 * target we cannot run here is checked against its constraints before CI ever builds it):
 *   - the Dockerfile's switches equal the manifest's usage-data env, and its version checks and
 *     labels equal the pinned release, which equals the lockfile's promptfoo;
 *   - every stage is the gateway image's digest-pinned base; the runtime runs as a non-root uid,
 *     ships no npm/npx/corepack, sets the egress probe to a public literal address;
 *   - the npm closure passes the licence gate (nothing denied) and the pending list is exactly the
 *     known one; a GPL package or a package with no licence fails it;
 *   - the telemetry patch refuses to run on anything but exactly the expected code.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENGINE_MANIFEST, PROMPTFOO_ENGINE_VERSION, PROMPTFOO_USAGE_DATA_ENV, isPublicAddress } from "@regulait/shared";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const dockerfile = readFileSync(path.join(root, "engines/promptfoo/Dockerfile"), "utf8");
const lock = JSON.parse(readFileSync(path.join(root, "engines/promptfoo/package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string; license?: string; optional?: boolean }>;
};
const gate = (await import(path.join(root, "engines/promptfoo/licence-gate.mjs"))) as {
  licenceInventory: (l: unknown) => { allowed: unknown[]; pending: Array<{ path: string; licence: string }>; denied: Array<{ path: string }> };
  classifyLicence: (s: unknown) => string;
};
const patch = (await import(path.join(root, "engines/promptfoo/patches/telemetry-disabled-sends-nothing.mjs"))) as { patchTelemetry: (dir: string) => string[] };

/** the runtime stage's ENV instruction as name -> value */
function runtimeEnv(): Record<string, string> {
  const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
  const m = /\nENV ([\s\S]*?)\n(?!\s{4})/.exec(runtime);
  expect(m, "runtime ENV").not.toBeNull();
  const out: Record<string, string> = {};
  for (const [, k, v] of m![1]!.matchAll(/([A-Z_]+)=(\S+)/g)) out[k!] = v!;
  return out;
}

describe("the promptfoo image's inputs", () => {
  it("the switches, the version and the base are in lockstep with the manifest and the gateway image", () => {
    const env = runtimeEnv();
    for (const [k, v] of Object.entries(PROMPTFOO_USAGE_DATA_ENV)) expect(env[k], k).toBe(v);
    expect(ENGINE_MANIFEST.promptfoo.version).toBe(PROMPTFOO_ENGINE_VERSION);
    expect(lock.packages["node_modules/promptfoo"]!.version).toBe(PROMPTFOO_ENGINE_VERSION);
    expect(dockerfile).toContain(`if (v !== '${PROMPTFOO_ENGINE_VERSION}')`);
    expect(dockerfile).toContain(`org.regulait.engine-version="${PROMPTFOO_ENGINE_VERSION}"`);
    // PR #205 review [51]: every stage names linux/amd64 (libsql's native x64 binding)
    expect([...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1])).toEqual(["--platform=linux/amd64", "--platform=linux/amd64", "--platform=linux/amd64"]);
    const bases = [...dockerfile.matchAll(/^FROM --platform=linux\/amd64 (\S+)/gm)].map((m) => m[1]);
    const gatewayBase = /^FROM (\S+) AS runtime/m.exec(readFileSync(path.join(root, "Dockerfile"), "utf8"))![1];
    expect(bases).toHaveLength(3);
    for (const b of bases) expect(b).toBe(gatewayBase);
    expect(gatewayBase).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(isPublicAddress(env["REGULAIT_EGRESS_PROBE_ADDRESS"])).toBe(true);
    // PR #205 review [49]: the runner's state dir exists, owned by the runner uid, 0700
    expect(env["REGULAIT_RUNNER_STATE_DIR"]).toBe("/state");
    // B5-P2: and the exchange mount points of both containers, owned by the same uid
    expect(dockerfile).toMatch(/\nRUN mkdir -p \/state \/jobs \/results \/out && chown 10001:10001 \/state \/jobs \/results \/out && chmod 0700 \/state\n/);
    // the default command is the runner; the worker's entrypoint ships beside it (compose names it)
    expect(dockerfile).toMatch(/\nCMD \["node", "\/app\/dist\/main\.js"\]\n?$/);
    expect(dockerfile).toMatch(/\nUSER 10001:10001\n/);
    expect(dockerfile).toMatch(/rm -rf \/usr\/local\/lib\/node_modules\/npm/);
    expect(dockerfile).toMatch(/npm ci --omit=optional --ignore-scripts/);
    expect(dockerfile).toMatch(/node licence-gate\.mjs package-lock\.json/);
    expect(dockerfile).toMatch(/telemetry-patch\.mjs \/opt\/promptfoo\/node_modules\/promptfoo/);
    expect(dockerfile).not.toMatch(/docker\.sock|EXPOSE/);
  });

  it("the npm closure passes the licence gate; the pending list is exactly the known one", () => {
    const inv = gate.licenceInventory(lock);
    expect(inv.denied).toEqual([]);
    expect(new Set(inv.pending.map((p) => p.licence))).toEqual(new Set(["Artistic-2.0", "BlueOak-1.0.0", "Python-2.0"]));
    expect(inv.pending).toHaveLength(12); // 0.125.1: minimatch 11 adds @isaacs/nonrecursive-glob-match (BlueOak-1.0.0)
    // optional dependencies are not installed and so not counted; the native sqlite binding is direct
    expect(lock.packages["node_modules/@libsql/linux-x64-gnu"]!.optional).toBeUndefined();
  });

  it("B5-P2 [177]: the packages with a published advisory and NO patched release are never installed (optional only)", () => {
    // node-forge (GHSA-86w9-cpqp-85rv) is patched since 1.4.1 and the lock resolves 1.4.2, but it and jks-js stay
    // OPTIONAL, so `npm ci --omit=optional` (the Dockerfile) never installs them. If one becomes a required
    // dependency, this fails. Every copy counts, hoisted or nested (any key ending in `node_modules/<name>`), and
    // each name must be present: a renamed or re-nested entry cannot make this pass vacuously.
    const advisoryPath: Array<{ name: string; version?: RegExp }> = [{ name: "jks-js" }, { name: "node-forge" }];
    const notOptional = (packages: typeof lock.packages): string[] => {
      const problems: string[] = [];
      for (const { name, version } of advisoryPath) {
        const keys = Object.keys(packages).filter((k) => k.endsWith(`node_modules/${name}`) && (!version || version.test(packages[k]!.version ?? "")));
        if (keys.length === 0) problems.push(`${name}: not in the lockfile (re-check the advisory path)`);
        for (const k of keys) if (packages[k]!.optional !== true) problems.push(`${k}@${packages[k]!.version}: not optional`);
      }
      return problems;
    };
    expect(notOptional(lock.packages)).toEqual([]);
    // red: dropping the optional flag from an advisory package, or losing it from the lock, is caught
    const forge = Object.keys(lock.packages).find((k) => k.endsWith("node_modules/node-forge"))!;
    const { optional: _flag, ...forgeRequired } = lock.packages[forge]!;
    expect(notOptional({ ...lock.packages, [forge]: forgeRequired })).toEqual([`${forge}@${lock.packages[forge]!.version}: not optional`]);
    const { [forge]: _dropped, ...withoutForge } = lock.packages;
    expect(notOptional(withoutForge)).toEqual(["node-forge: not in the lockfile (re-check the advisory path)"]);
    // the moderate advisory (smol-toml via an optional peer) is gone from the 0.124.1 closure
    expect(lock.packages["node_modules/smol-toml"]).toBeUndefined();
  });

  it("E25 (2026-11-16): the unused optional peers that reached deepmerge and braces resolve to the empty placeholder", () => {
    // deepmerge GHSA-gcqx-w48m-w2h4 (no fixed release) came only through promptfoo's optional peer
    // puppeteer-extra-plugin-stealth, and braces GHSA-vfj7-8cjw-p6xm (no fixed release) only through nunjucks'
    // optional peer chokidar 3. Both peers are overridden to `absent-optional-peer` (no code, never installed), so
    // neither chain is in the lockfile at all (owner decision 2026-11-16: remove, do not extend the acceptance).
    const manifest = JSON.parse(readFileSync(path.join(root, "engines/promptfoo/package.json"), "utf8")) as {
      optionalDependencies?: Record<string, string>;
      overrides: Record<string, unknown>;
    };
    expect(manifest.optionalDependencies).toEqual({
      chokidar: "file:absent-optional-peer",
      "puppeteer-extra-plugin-stealth": "file:absent-optional-peer",
    });
    expect(manifest.overrides["puppeteer-extra-plugin-stealth"]).toBe("$puppeteer-extra-plugin-stealth");
    expect(manifest.overrides["nunjucks"]).toEqual({ chokidar: "$chokidar" });
    const placeholder = JSON.parse(readFileSync(path.join(root, "engines/promptfoo/absent-optional-peer/package.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(placeholder).filter((k) => /dependencies|main|exports|bin|scripts/i.test(k))).toEqual([]);
    const entries = lock.packages as Record<string, { optional?: boolean; link?: boolean; resolved?: string; dependencies?: unknown }>;
    expect(entries["absent-optional-peer"]).toMatchObject({ optional: true });
    expect(entries["absent-optional-peer"]!.dependencies).toBeUndefined();
    for (const peer of ["chokidar", "puppeteer-extra-plugin-stealth"]) {
      expect(entries[`node_modules/${peer}`]).toEqual({ resolved: "absent-optional-peer", link: true });
    }
    const gone = ["deepmerge", "braces", "fill-range", "picomatch", "puppeteer-extra-plugin", "puppeteer-extra-plugin-user-preferences", "puppeteer-extra-plugin-user-data-dir"];
    expect(Object.keys(entries).filter((k) => gone.some((n) => k.endsWith(`node_modules/${n}`)))).toEqual([]);
    // chokidar 3 is gone; promptfoo's own chokidar 5 (no braces dependency) is the only real copy
    expect(Object.keys(entries).filter((k) => k.endsWith("node_modules/chokidar") && entries[k]!.link !== true).map((k) => `${k}@${lock.packages[k]!.version}`)).toEqual([
      "node_modules/promptfoo/node_modules/chokidar@5.0.0",
    ]);
  });

  it("a GPL package, an AGPL alternative-only expression or a missing licence is denied", () => {
    expect(gate.classifyLicence("GPL-3.0-only")).toBe("denied");
    expect(gate.classifyLicence("(AGPL-3.0 OR SSPL-1.0)")).toBe("denied");
    expect(gate.classifyLicence("(MIT OR GPL-2.0)")).toBe("allowed");
    expect(gate.classifyLicence("MIT AND GPL-2.0")).toBe("denied");
    expect(gate.classifyLicence(undefined)).toBe("denied");
    const bad = { packages: { ...lock.packages, "node_modules/copyleft-thing": { version: "1.0.0", license: "LGPL-3.0" }, "node_modules/mystery": { version: "1.0.0" } } };
    expect(gate.licenceInventory(bad).denied.map((d) => d.path)).toEqual(["node_modules/copyleft-thing", "node_modules/mystery"]);
  });

  it("the telemetry patch applies only to exactly the expected code", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pf-patch-"));
    const src = path.join(dir, "dist", "src");
    await mkdir(src, { recursive: true });
    const body = "class Telemetry {\n\trecord(eventName, properties) {\n\t\tif (this.disabled) this.recordTelemetryDisabled();\n\t\telse this.sendEvent(eventName, properties);\n\t}\n\tsendEvent(eventName, properties) {\n\t\tfetchWithProxy(R_ENDPOINT, {});\n\t}\n}\n";
    for (const f of ["telemetry-a.js", "telemetry-b.js", "telemetry-c.js", "telemetry-d.cjs"]) await writeFile(path.join(src, f), body);
    expect(patch.patchTelemetry(dir)).toHaveLength(4);
    expect(await readFile(path.join(src, "telemetry-a.js"), "utf8")).toContain("sendEvent(eventName, properties) {\n\t\tif (this.disabled) return;");
    // twice: refused (already patched); a release that moved the code: refused
    expect(() => patch.patchTelemetry(dir)).toThrow(/already patched/);
    const moved = await mkdtemp(path.join(tmpdir(), "pf-patch-"));
    await mkdir(path.join(moved, "dist", "src"), { recursive: true });
    await writeFile(path.join(moved, "dist", "src", "telemetry-a.js"), body);
    expect(() => patch.patchTelemetry(moved)).toThrow(/expected 4 telemetry copies/);
  });
});
