import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRows, npmResolvedSet, parseRows, pnpmResolvedSet, run } from "./preflight-third-party-lock.mjs";

const TABLE = (rows) => ["| Component | Version | Licence | Why |", "|---|---|---|---|", ...rows].join("\n");

const LOCK = `lockfileVersion: '9.0'
importers:
  .:
    devDependencies:
      js-yaml:
        specifier: 4.3.2
        version: 4.3.2
  packages/a:
    dependencies:
      zod:
        specifier: 4.6.7
        version: 4.6.7
      '@regulait/b':
        specifier: workspace:*
        version: link:../b
    devDependencies:
      vitest:
        specifier: ^4.1.11
        version: 4.1.12(@types/node@26.6.6)
  packages/b:
    dependencies:
      re2js:
        specifier: 2.8.8
        version: 2.8.8
  packages/engine-x:
    dependencies:
      write-file-atomic:
        specifier: 8.0.0
        version: 8.0.0
snapshots:
  js-yaml@4.3.2:
    dependencies:
      argparse: 2.0.1
  argparse@2.0.1: {}
  zod@4.6.7: {}
  re2js@2.8.8: {}
  vitest@4.1.12(@types/node@26.6.6):
    dependencies:
      tinypool: 2.0.0
  tinypool@2.0.0: {}
  write-file-atomic@8.0.0:
    dependencies:
      signal-exit: 4.1.0
  signal-exit@4.1.0: {}
`;

let dirs = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function repo(files) {
  const root = mkdtempSync(join(tmpdir(), "tp-lock-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("parseRows", () => {
  it("reads the first backticked npm name and the first version, backticked or bare", () => {
    const rows = parseRows(
      TABLE([
        "| `zod` (npm, github.com/colinhacks/zod) | `4.6.7` (exact; bumped from 4.6.5) | MIT | x |",
        "| `js-yaml` | 4.3.2 | MIT | x |",
        "| gitleaks ruleset (`config/gitleaks.toml`) | commit `09242ce` | MIT | x |",
        "| `github.com/go-jose/go-jose/v4` | `v4.1.6` | Apache-2.0 | x |",
        "| `jose` 6.2.17 (npm, through `@regulait/engine-runner`) | as locked (exact) | MIT | x |",
      ]),
    );
    expect(rows.map((r) => [r.name, r.version, r.sayNpm])).toEqual([
      ["zod", "4.6.7", true],
      ["js-yaml", "4.3.2", false],
    ]);
    expect(rows[0].line).toBe(3);
  });

  it("pairs several names with several versions when the counts match", () => {
    const rows = parseRows(TABLE(["| `@azure/msal-node`, `@azure/msal-common` | `7.1.1`, `16.14.1` | MIT | x |"]));
    expect(rows.map((r) => `${r.name}@${r.version}`)).toEqual(["@azure/msal-node@7.1.1", "@azure/msal-common@16.14.1"]);
  });

  it("reads an exemption marker and its reason", () => {
    const [row] = parseRows(TABLE(["| `zod` | `3.0.0` | MIT | x <!-- third-party-lock: exempt vendored copy --> |"]));
    expect(row.exempt).toBe("vendored copy");
  });
});

describe("pnpmResolvedSet", () => {
  it("walks direct, dev and transitive snapshots, strips peer suffixes and follows link: into workspace packages", async () => {
    const yaml = (await import("js-yaml")).default;
    const set = pnpmResolvedSet(yaml.load(LOCK, { schema: yaml.JSON_SCHEMA }), "packages/a");
    expect([...set.keys()].sort()).toEqual(["re2js", "tinypool", "vitest", "zod"]);
    expect([...set.get("vitest")]).toEqual(["4.1.12"]);
  });
});

describe("npmResolvedSet", () => {
  it("collects every installed entry of a package-lock.json, nested ones included", () => {
    const set = npmResolvedSet({
      packages: {
        "": { name: "engine", version: "1.0.0" },
        "node_modules/zod": { version: "4.6.7" },
        "node_modules/a/node_modules/zod": { version: "3.25.0" },
        "node_modules/@scope/pkg": { version: "1.2.3" },
      },
    });
    expect([...set.get("zod")].sort()).toEqual(["3.25.0", "4.6.7"]);
    expect([...set.get("@scope/pkg")]).toEqual(["1.2.3"]);
  });
});

describe("checkRows", () => {
  const set = new Map([["zod", new Set(["4.6.7"])]]);
  it("says what the row has and what the lockfile has", () => {
    const { problems } = checkRows("p/THIRD_PARTY.md", [{ line: 3, name: "zod", version: "4.6.5", sayNpm: true }], set);
    expect(problems).toEqual(["p/THIRD_PARTY.md:3 row zod says 4.6.5, the lockfile has 4.6.7"]);
  });
  it("fails an npm row whose package is not installed, and leaves a non-npm name alone", () => {
    const { problems } = checkRows(
      "f",
      [
        { line: 1, name: "left-pad", version: "1.0.0", sayNpm: true },
        { line: 2, name: "numpy", version: "2.5.3", sayNpm: false },
      ],
      set,
    );
    expect(problems).toEqual(["f:1 row left-pad says 1.0.0, the lockfile has no left-pad"]);
  });
  it("skips an exempt row with a reason and fails one without", () => {
    const r = checkRows(
      "f",
      [
        { line: 1, name: "zod", version: "1.0.0", exempt: "vendored" },
        { line: 2, name: "zod", version: "1.0.0", exempt: null },
      ],
      set,
    );
    expect(r.exemptions).toEqual(["f:1 zod: exempt (vendored)"]);
    expect(r.problems).toEqual(["f:2 row zod carries an exemption marker without a reason"]);
  });
});

describe("run", () => {
  it("passes a repository whose rows match, and maps scripts/ to the root importer", () => {
    const root = repo({
      "pnpm-lock.yaml": LOCK,
      "packages/a/package.json": "{}",
      "packages/a/THIRD_PARTY.md": TABLE(["| `zod` (npm) | `4.6.7` | MIT | x |", "| `re2js` | `2.8.8` | MIT | via b |"]),
      "scripts/THIRD_PARTY.md": TABLE(["| `js-yaml` | 4.3.2 | MIT | x |", "| `argparse` | 2.0.1 | MIT | x |"]),
      "engines/go/THIRD_PARTY.md": TABLE(["| `zod` | `1.0.0` | MIT | not an npm lockfile |"]),
    });
    const r = run(root);
    expect(r.problems).toEqual([]);
    expect(r.checked).toEqual(["packages/a/THIRD_PARTY.md", "scripts/THIRD_PARTY.md"]);
    expect(r.skipped).toEqual(["engines/go/THIRD_PARTY.md"]);
  });

  it("reports a stale row (the Dependabot case) with the file, line and both versions", () => {
    const root = repo({
      "pnpm-lock.yaml": LOCK,
      "packages/a/THIRD_PARTY.md": TABLE(["| `vitest` (npm) | `4.1.11` (exact devDependency) | MIT | x |"]),
    });
    expect(run(root).problems).toEqual(["packages/a/THIRD_PARTY.md:3 row vitest says 4.1.11, the lockfile has 4.1.12"]);
  });

  it("checks an engine image against its own package-lock.json plus its runner shim's importer", () => {
    const root = repo({
      "pnpm-lock.yaml": LOCK,
      "engines/x/package.json": "{}",
      "engines/x/package-lock.json": JSON.stringify({ packages: { "": {}, "node_modules/promptfoo": { version: "0.125.1" } } }),
      "engines/x/THIRD_PARTY.md": TABLE([
        "| `promptfoo` (npm) | `0.125.1` | MIT | x |",
        "| `signal-exit` (npm, through the shim) | `4.1.0` | ISC | x |",
        "| `promptfoo-extra` (npm) | `1.0.0` | MIT | x |",
      ]),
    });
    expect(run(root).problems).toEqual(["engines/x/THIRD_PARTY.md:5 row promptfoo-extra says 1.0.0, the lockfile has no promptfoo-extra"]);
  });
});
