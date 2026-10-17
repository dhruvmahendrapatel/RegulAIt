// ADR-0195 SD1 (review of #402): manifest line lookup is one pass, not one pass per dependency.
// Runs in the serialized `timing` project (vitest.config.ts TIMING_FILES).
import { describe, expect, it } from "vitest";
import { readManifest } from "./repo-manifests.js";

describe("repo manifest line lookup", () => {
  it("locates lines in one pass: 9000 dependencies well under a second", () => {
    const n = 9000;
    const deps = Array.from({ length: n }, (_, i) => `"pkg-${i}"`).join(",\n");
    const py = `[project]\nname="x"\ndependencies = [\n${deps}\n]\n`;
    const pkg = JSON.stringify({ dependencies: Object.fromEntries(Array.from({ length: n }, (_, i) => [`pkg-${i}`, "1"])) }, null, 2);
    const t0 = performance.now();
    const a = readManifest("pyproject_toml", py);
    const b = readManifest("package_json", pkg);
    const ms = performance.now() - t0;
    expect(a.dependencies).toHaveLength(n);
    expect(b.dependencies).toHaveLength(n);
    expect(a.dependencies[n - 1]).toEqual({ ecosystem: "pypi", name: `pkg-${n - 1}`, line: n + 3 });
    expect(b.dependencies[0]!.line).toBe(3);
    expect(ms).toBeLessThan(1_000);
  });

});
