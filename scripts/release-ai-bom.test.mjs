// ADR-0189 slice B7: the release-time AI BOM CLI is INERT while the R17 switch
// is off (R28). Needs `pnpm --filter @regulait/shared build` (CI's job builds
// first). The negative control, the step with the switch on, lives in the
// shared suite (`release-ai-bom.test.ts`), because the CLI has no override.
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "release-ai-bom.mjs");
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

describe("release-ai-bom.mjs (ADR-0189 B7)", () => {
  it("reports the switch as off", () => {
    expect(execFileSync(process.execPath, [cli, "switch"], { encoding: "utf8" }).trim()).toBe("released=false");
  });
  it("validates the checked-in inventory", () => {
    const r = run("check-inventory");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/tool\(s\), reviewed/);
  });
  it("identity and build are inert: exit 0, write nothing, even with missing inputs", () => {
    const out = mkdtempSync(path.join(tmpdir(), "b7-release-"));
    for (const cmd of [
      ["identity", "--commit", "a".repeat(40), "--image-digest", `sha256:${"c".repeat(64)}`, "--workspace", "/nonexistent", "--image", "/nonexistent", "--out", path.join(out, "id.json")],
      ["build", "--commit", "a".repeat(40), "--out-dir", path.join(out, "bom")],
    ]) {
      const r = run(...cmd);
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/inert \(ADR-0189 R28\)/);
    }
    expect(readdirSync(out)).toEqual([]);
    expect(existsSync(path.join(out, "bom"))).toBe(false);
  });
  it("refuses an unknown command", () => {
    expect(run("publish").status).toBe(2);
  });
});
