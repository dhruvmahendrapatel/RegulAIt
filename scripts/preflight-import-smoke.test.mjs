import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENTRY_POINTS, importAlone, smokeAll } from "./preflight-import-smoke.mjs";

let pkg;
const marker = `regulait-import-smoke-probe-${process.pid}`;
const put = (rel, text) => {
  const p = join(pkg, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

beforeAll(() => {
  pkg = mkdtempSync(join(tmpdir(), "import-smoke-"));
  put("dist/ok.js", "export const OK = 1;\n");
  // a cycle whose modules read each other's bindings at init: whichever loads first throws a TDZ ReferenceError
  put("dist/tdz-a.js", 'import { B } from "./tdz-b.js";\nexport const A = 1 + B;\n');
  put("dist/tdz-b.js", 'import { A } from "./tdz-a.js";\nexport const B = 2 + A;\n');
  // writes into "the home directory" and records what it saw: must land in the throwaway sandbox
  put("dist/writes-home.js", `import { homedir } from "node:os";\nimport { writeFileSync } from "node:fs";\nconst leaked = Object.keys(process.env).filter((k) => !["PATH", "HOME", "TMPDIR", "NODE_ENV", "REGULAIT_IMPORT_SMOKE", "REGULAIT_IMPORT_SMOKE_TARGET"].includes(k));\nif (process.argv[1] || leaked.length > 0 || !process.cwd().startsWith(homedir())) throw new Error("not contained: " + leaked.join(","));\nwriteFileSync(homedir() + "/${marker}", "x");\nexport const W = 1;\n`);
  // an entry point by name: never imported, although importing it would throw
  put("dist/main.js", 'throw new Error("main must never be imported by the smoke check");\n');
  for (const f of ["ok", "tdz-a", "tdz-b", "writes-home", "main"]) put(`src/${f}.ts`, "// source\n");
});

afterAll(() => rmSync(pkg, { recursive: true, force: true }));

describe("import smoke pre-flight", () => {
  it("passes a module that loads, and reports a TDZ ReferenceError at init", async () => {
    expect(await importAlone(join(pkg, "dist/ok.js"))).toBeNull();
    const f = await importAlone(join(pkg, "dist/tdz-a.js"));
    expect(f).toMatchObject({ kind: "threw", name: "ReferenceError" });
    expect(f.message).toMatch(/before initialization/);
  });

  it("times out a module that never finishes loading", async () => {
    put("dist/hangs.js", "await new Promise(() => setInterval(() => {}, 1000));\n");
    expect(await importAlone(join(pkg, "dist/hangs.js"), { timeoutMs: 1500 })).toMatchObject({ kind: "timeout" });
  });

  it("contains the child: a sandbox HOME (removed afterwards), a scrubbed environment and no argv[1]", async () => {
    process.env.DATABASE_URL = "postgres://must-not-leak.invalid/x";
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("regulait-import-smoke-")).length;
    expect(await importAlone(join(pkg, "dist/writes-home.js"))).toBeNull();
    expect(existsSync(join(homedir(), marker))).toBe(false);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith("regulait-import-smoke-")).length).toBe(before);
    delete process.env.DATABASE_URL;
  });

  it("fails a module that listens at top level, and denies writes outside the sandbox and child processes", async () => {
    const outside = join(tmpdir(), `${marker}-outside`);
    put("x/listens.js", 'import { createServer } from "node:net";\ncreateServer().listen(0, "127.0.0.1");\nawait new Promise((r) => setTimeout(r, 200));\n');
    put("x/writes-outside.js", `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(outside)}, "x");\n`);
    put("x/spawns.js", 'import { execFileSync } from "node:child_process";\nexecFileSync("true");\n');
    put("x/perm.js", 'if (!process.permission || process.permission.has("child") || process.permission.has("worker") || process.permission.has("fs.write", "/etc/passwd") || !process.permission.has("fs.write", process.cwd())) throw new Error("no permission model");\n');
    expect(await importAlone(join(pkg, "x/listens.js"))).toMatchObject({ kind: "listening" });
    expect(await importAlone(join(pkg, "x/writes-outside.js"))).toMatchObject({ kind: "threw" });
    expect(existsSync(outside)).toBe(false);
    expect(await importAlone(join(pkg, "x/spawns.js"))).toMatchObject({ kind: "threw" });
    expect(await importAlone(join(pkg, "x/perm.js"))).toBeNull();
  });

  it("skips the named entry points and fails on the rest", async () => {
    rmSync(join(pkg, "dist/hangs.js"));
    const r = await smokeAll(pkg, { concurrency: 2, timeoutMs: 10_000 });
    expect(r.skipped).toBe(1);
    expect(r.failures.map((f) => f.module).sort()).toEqual(["tdz-a.js", "tdz-b.js"]);
    expect(r.unknownEntries).toContain("seed.js");
    expect(ENTRY_POINTS.has("main.js")).toBe(true);
  });
});
