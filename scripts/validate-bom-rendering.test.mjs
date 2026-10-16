// ADR-0189 slice B8: the offline rendering schema check used by docs/ops/BOM_VERIFICATION.md step 5.
// Needs `pnpm -r build` (CI's build-and-test-base job builds before `vitest run --dir scripts`).
// The CycloneDX input is the A02 vector's rendering (the ADR's worked example); the SPDX inputs are the
// product's own renderings, written by scripts/spdx3/render-fixtures.mjs.
import { beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const run = (...args) => spawnSync(process.execPath, [path.join(here, "validate-bom-rendering.mjs"), ...args], { encoding: "utf8" });
const dir = mkdtempSync(path.join(tmpdir(), "b8-render-"));
const cdx = path.join(dir, "ai-bom.cyclonedx-1.7.json");
const spdxDir = path.join(dir, "spdx");

beforeAll(() => {
  const v = JSON.parse(readFileSync(path.join(here, "../packages/shared/test-vectors/decision-bom/b4-vectors.json"), "utf8"));
  const a02 = v.positives.find((x) => x.id === "A02");
  writeFileSync(cdx, a02.bundle.entries.find((e) => e.name.endsWith("/content/ai-bom.cyclonedx-1.7.json")).text);
  const r = spawnSync(process.execPath, [path.join(here, "spdx3/render-fixtures.mjs"), spdxDir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
});

describe("validate-bom-rendering.mjs", { timeout: 60_000 }, () => {
  it("a CycloneDX 1.7 rendering is valid as cyclonedx-1.7 (exit 0)", () => {
    const r = run("--format", "cyclonedx-1.7", cdx);
    expect(r.stdout).toContain("[valid]");
    expect(r.status).toBe(0);
  });

  it("the stated format must match the document: 1.7 stated as cyclonedx-1.6 is refused (exit 1)", () => {
    const r = run("--format", "cyclonedx-1.6", cdx);
    expect(r.stdout).toContain("not a CycloneDX 1.6 document");
    expect(r.status).toBe(1);
  });

  it("a CycloneDX document that breaks the schema is invalid (exit 1)", () => {
    const bad = path.join(dir, "bad.cdx.json");
    writeFileSync(bad, JSON.stringify({ ...JSON.parse(readFileSync(cdx, "utf8")), components: "not-an-array" }));
    const r = run("--format", "cyclonedx-1.7", bad);
    expect(r.stdout).toContain("[invalid]");
    expect(r.status).toBe(1);
  });

  it("the product's SPDX 3.0.1 renderings are valid (exit 0); a CycloneDX file stated as SPDX is not (exit 1)", () => {
    expect(run("--format", "spdx-3.0.1", path.join(spdxDir, "install.spdx.json"), path.join(spdxDir, "use_case.spdx.json")).status).toBe(0);
    expect(run("--format", "spdx-3.0.1", cdx).status).toBe(1);
  });

  it("unreadable JSON is invalid without echoing content (exit 1)", () => {
    const junk = path.join(dir, "junk.json");
    writeFileSync(junk, "CANARY-not-json");
    const r = run("--format", "spdx-3.0.1", junk);
    expect(r.status).toBe(1);
    expect(r.stdout).not.toContain("CANARY");
  });

  it("B8 review L7: a file over the archive cap is refused without being read (exit 1)", () => {
    const big = path.join(dir, "big.json");
    writeFileSync(big, "");
    truncateSync(big, 64 * 1024 * 1024 + 1);
    const r = run("--format", "cyclonedx-1.7", big);
    expect(r.stdout).toContain("not a regular file of at most 67108864 bytes");
    expect(r.status).toBe(1);
  });

  it("usage errors exit 2: no format, an unknown format, no file, a repeated --format", () => {
    expect(run(cdx).status).toBe(2);
    expect(run("--format", "cyclonedx-1.5", cdx).status).toBe(2);
    expect(run("--format", "cyclonedx-1.7").status).toBe(2);
    expect(run("--format", "cyclonedx-1.7", "--format", "cyclonedx-1.7", cdx).status).toBe(2);
  });
});
