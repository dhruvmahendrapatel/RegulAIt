import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Reuse the repository's extensionless-import guard; walk the filesystem here
// so a newly added file is checked before it is staged in Git (X12).
const { collisionKey } = await import(
  new URL("../../../scripts/basename-collisions.mjs", import.meta.url).href
) as { collisionKey: (file: string) => string };

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : entry.isFile() ? [file] : [];
  });
}

function collisions(directory: string): string[][] {
  const groups = new Map<string, string[]>();
  for (const file of filesUnder(directory)) {
    const relative = path.relative(directory, file).split(path.sep).join("/");
    // Directory casing matters on Windows too, not just the filename stem.
    const key = collisionKey(relative).toLowerCase();
    const group = groups.get(key) ?? [];
    group.push(relative);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.length > 1).map((group) => group.sort());
}

describe("X12: web source filenames resolve on case-insensitive filesystems", () => {
  it("walks the complete source tree, including files not yet tracked by Git", () => {
    const source = fileURLToPath(new URL(".", import.meta.url));
    const files = filesUnder(source);
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain(path.join(source, "views/admin/integrations/AgentStewardship.tsx"));
    expect(collisions(source)).toEqual([]);
  });

  it("detects a planted extensionless-import collision in real files", () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "regulait-x12-"));
    try {
      writeFileSync(path.join(fixture, "AgentStewardship.tsx"), "export {};\n");
      writeFileSync(path.join(fixture, "agentStewardship.ts"), "export {};\n");
      expect(collisions(fixture)).toEqual([["AgentStewardship.tsx", "agentStewardship.ts"]]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
