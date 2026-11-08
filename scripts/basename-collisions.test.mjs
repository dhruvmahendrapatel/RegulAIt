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

  it("lets a Go module's go.mod and go.sum stand together, but nothing else with their stem", () => {
    expect(findBasenameCollisions(["agents/endpoint/go.mod", "agents/endpoint/go.sum"])).toEqual([]);
    expect(findBasenameCollisions(["agents/endpoint/go.mod", "agents/endpoint/go.sum", "agents/endpoint/Go.ts"])).toEqual([
      ["agents/endpoint/Go.ts", "agents/endpoint/go.mod", "agents/endpoint/go.sum"],
    ]);
    expect(findBasenameCollisions(["x/go.mod", "x/GO.mod"])).toEqual([["x/GO.mod", "x/go.mod"]]);
  });

  it("lets Composer's and Dart's manifest/lock pairs stand together (ADR-0257), but nothing else with their stem", () => {
    expect(findBasenameCollisions(["c/composer.json", "c/composer.lock", "d/pubspec.yaml", "d/pubspec.lock"])).toEqual([]);
    expect(findBasenameCollisions(["c/composer.json", "c/composer.lock", "c/Composer.php"])).toEqual([
      ["c/Composer.php", "c/composer.json", "c/composer.lock"],
    ]);
    // only the real pairs: a manifest beside the OTHER toolchain's lock is still a collision
    expect(findBasenameCollisions(["x/pubspec.json", "x/pubspec.lock"])).toEqual([["x/pubspec.json", "x/pubspec.lock"]]);
  });
});
