/**
 * ADR-0242 §6.1 — the subject-engine images' runner stage (the two admission-scan images and, ADR-0362, the content
 * extractor's), read as text (no daemon here; M-063/M-065): each image
 * builds this package in a pinned node stage exactly as modelscan's does, ships the pinned node binary with its
 * libraries checked against the runtime base, runs the runner by default, names its engine, and keeps every base
 * pinned by digest. The scanner stages and the smoke scans are the ones ADR-0242 §3 measured (not changed here).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_MANIFEST, isPublicAddress } from "@regulait/shared";
import { isAdmissionScanEngine, SUBJECT_ENGINE_IDS } from "./config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const modelscan = readFileSync(path.join(root, "engines/modelscan/Dockerfile"), "utf8");
const stage = (dockerfile: string, name: string) => {
  const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, "m"));
  const next = dockerfile.slice(start + 1).search(/^FROM /m);
  return dockerfile.slice(start, next < 0 ? undefined : start + 1 + next);
};
const lines = (s: string) => s.split("\n").filter((l) => !l.startsWith("#"));

describe.each(SUBJECT_ENGINE_IDS)("the %s image's runner stage", (engine) => {
  const dockerfile = readFileSync(path.join(root, `engines/${engine}/Dockerfile`), "utf8");

  it("every base is pinned by digest; the shim and node come from the pinned node image modelscan uses", () => {
    const froms = [...dockerfile.matchAll(/^FROM --platform=linux\/amd64 (\S+)/gm)].map((m) => m[1]!);
    expect(froms.length).toBe([...dockerfile.matchAll(/^FROM /gm)].length);
    for (const b of froms) expect(b).toMatch(/^[a-z0-9.\/-]+:[a-z0-9.-]+@sha256:[0-9a-f]{64}$/);
    const nodeBase = /^FROM --platform=linux\/amd64 (\S+) AS shim$/m.exec(modelscan)![1];
    expect(/^FROM --platform=linux\/amd64 (\S+) AS shim$/m.exec(dockerfile)?.[1]).toBe(nodeBase);
    expect(/^FROM --platform=linux\/amd64 (\S+) AS node$/m.exec(dockerfile)?.[1]).toBe(nodeBase);
    expect(/^FROM --platform=linux\/amd64 (\S+) AS runtime$/m.exec(dockerfile)?.[1]).toBe(/^FROM --platform=linux\/amd64 (\S+) AS runtime$/m.exec(modelscan)![1]);
  });

  it("the shim stage is modelscan's, building and deploying this package (reproducibly)", () => {
    const ours = lines(stage(dockerfile, "shim")).join("\n").replaceAll("@regulait/engine-admission-scan", "@regulait/engine-X");
    const theirs = lines(stage(modelscan, "shim")).join("\n").replaceAll("@regulait/engine-modelscan", "@regulait/engine-X");
    expect(ours.trim()).toBe(theirs.trim());
    expect(dockerfile).toContain('pnpm --filter "@regulait/engine-admission-scan..." build');
    expect(dockerfile).toContain("pnpm --filter @regulait/engine-admission-scan deploy --prod --legacy /out");
    expect(dockerfile).toContain("node scripts/engine-images-normalise.mjs modules-yaml /out/node_modules/.modules.yaml");
  });

  it("the runtime ships node with its libraries from this base, the shim at /app, and starts the runner", () => {
    const runtime = stage(dockerfile, "runtime");
    const nodeCopy = runtime.indexOf("COPY --from=node /usr/local/bin/node /usr/local/bin/node");
    const nodeCheck = runtime.indexOf("&& node --version");
    expect(nodeCopy).toBeGreaterThan(0);
    expect(nodeCheck).toBeGreaterThan(nodeCopy);
    expect(runtime.slice(nodeCopy, nodeCheck)).toContain("dpkg-query -W -f='${Package} ${Version}\\n' libstdc++6 libgcc-s1");
    expect(runtime.slice(nodeCopy, nodeCheck)).toContain("ldd /usr/local/bin/node | grep -q 'not found'");
    expect(nodeCheck).toBeLessThan(runtime.indexOf("\nUSER "));
    expect(runtime).toContain("COPY --from=shim /out /app");
    // the manifest's task entry is what the image ships
    const entry = ENGINE_MANIFEST[engine].taskEntry;
    expect(entry.command).toBe("/usr/local/bin/node");
    expect(entry.args).toEqual(["/app/dist/task-main.js", engine]);
    expect(dockerfile.trimEnd().endsWith('CMD ["node", "/app/dist/main.js"]')).toBe(true);
    expect(dockerfile).not.toMatch(/^ENTRYPOINT /m);
    expect(dockerfile).not.toMatch(/docker\.sock|EXPOSE/);
    expect(dockerfile).toMatch(/\nUSER 10001:10001\n/);
    const env = /\nENV ([\s\S]*?)\nUSER/.exec(runtime)![1]!;
    expect(env).toContain(`REGULAIT_ADMISSION_ENGINE=${engine} \\`);
    expect(isPublicAddress(/REGULAIT_EGRESS_PROBE_ADDRESS=(\S+)/.exec(env)?.[1])).toBe(true);
    expect(runtime).toMatch(/mkdir -p \/state \/jobs \/results[\s\S]*chmod 0700 \/state/);
  });

  it.skipIf(!isAdmissionScanEngine(engine))("the scanner's smoke scan still runs offline in the image as built", () => {
    expect(dockerfile).toMatch(new RegExp(`RUN --network=none /opt/${engine}/venv/bin/python -I /opt/${engine}/`));
    expect(dockerfile).toContain(`/opt/${engine}/venv/bin/python -I /opt/${engine}/scan.py /opt/${engine}/fixtures/bad /work/bad.json`);
  });

  it.skipIf(engine !== "contentextract")("ADR-0362: the extractor's closure stage keeps its licence gate and its mandatory unit tests", () => {
    const closure = stage(dockerfile, "closure");
    expect(closure).toContain("--require-hashes --no-deps --only-binary :all: -r requirements.txt");
    // this engine's own copy of the gate (an engine's image inputs never name another engine's directory)
    expect(closure).toContain("COPY engines/contentextract/requirements.txt engines/contentextract/licence-gate.mjs");
    expect(dockerfile).not.toMatch(/COPY engines\/(?!contentextract\/)/);
    expect(closure).toContain("node licence-gate.mjs /opt/contentextract/venv/lib/python3.12/site-packages licence-allow.json --readings licence-readings.json --runtime python=PSF-2.0");
    expect(closure).toContain("REGULAIT_REQUIRE_PDFIUM=1 REGULAIT_REQUIRE_OCR=1 /opt/contentextract/venv/bin/python -I -m unittest discover -s /opt/contentextract");
    // ADR-0362 slice 2: Tesseract at exact versions in the test stage AND the runtime, never unpinned
    const tess = "tesseract-ocr=5.5.0-1 tesseract-ocr-eng=1:4.1.0-2 tesseract-ocr-osd=1:4.1.0-2";
    expect(dockerfile.split(tess).length - 1).toBe(2);
    expect(dockerfile).not.toMatch(/apt-get install[^\n]*\btesseract-ocr(?![-=])/);
    expect(closure).toContain("rm /opt/contentextract/test_extract.py");
    // the runtime ships the closure read-only and no package installer
    const runtime = stage(dockerfile, "runtime");
    expect(runtime).toContain("COPY --from=closure /opt/contentextract /opt/contentextract");
    expect(runtime).toContain("chmod -R a-w /opt/contentextract");
    expect(runtime).toContain("/usr/local/bin/pip3.12");
  });
});
