import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collisionKey, findBasenameCollisions, trackedFiles } from "./basename-collisions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("no two tracked files differ only by case or extension (G10-G15-VERIFY)", () => {
  it("the repository has none — a case-insensitive checkout resolves every extensionless import", () => {
    const files = trackedFiles(root);
    // non-vacuity: the listing is the real tree, not an empty string split
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain("apps/web/src/shell/CommandPalette.tsx");
    expect(findBasenameCollisions(files)).toEqual([]);
  });

  it("catches the two collisions that broke the Windows web build, and the renames clear them", () => {
    expect(
      findBasenameCollisions([
        "apps/web/src/shell/CommandPalette.tsx",
        "apps/web/src/shell/commandPalette.ts",
        "apps/web/src/views/admin/integrations/AgentStewardship.tsx",
        "apps/web/src/views/admin/integrations/agentStewardship.ts",
      ]),
    ).toEqual([
      ["apps/web/src/shell/CommandPalette.tsx", "apps/web/src/shell/commandPalette.ts"],
      ["apps/web/src/views/admin/integrations/AgentStewardship.tsx", "apps/web/src/views/admin/integrations/agentStewardship.ts"],
    ]);
    expect(
      findBasenameCollisions([
        "apps/web/src/shell/CommandPalette.tsx",
        "apps/web/src/shell/commandPaletteModel.ts",
        "apps/web/src/shell/commandPaletteModel.test.ts",
        "apps/web/src/shell/commandPalette.module.css",
      ]),
    ).toEqual([]);
  });

  it("strips only the LAST extension, so a component, its CSS module and its test never collide", () => {
    expect(findBasenameCollisions(["a/Foo.tsx", "a/foo.module.css", "a/foo.test.ts", "a/Foo.d.ts"])).toEqual([]);
    expect(findBasenameCollisions(["README.md", "readme.md"])).toEqual([["README.md", "readme.md"]]);
    expect(findBasenameCollisions(["a/Foo.ts", "a/foo"])).toEqual([["a/Foo.ts", "a/foo"]]);
    // dotfiles have no extension: .gitignore and .dockerignore are distinct
    expect(findBasenameCollisions([".gitignore", ".dockerignore", "x/.env", "x/.ENV"])).toEqual([["x/.ENV", "x/.env"]]);
    // same stem, different directories: no collision
    expect(findBasenameCollisions(["a/foo.ts", "b/Foo.tsx"])).toEqual([]);
  });

  it("gives the same answer for Windows-separated paths", () => {
    expect(collisionKey("apps\\web\\src\\shell\\CommandPalette.tsx")).toBe(collisionKey("apps/web/src/shell/commandPalette.ts"));
    expect(findBasenameCollisions(["apps\\web\\Foo.tsx", "apps/web/foo.ts"])).toEqual([["apps/web/foo.ts", "apps\\web\\Foo.tsx"]]);
    expect(findBasenameCollisions(["apps\\web\\Foo.tsx", "apps\\other\\foo.ts"])).toEqual([]);
  });
});
