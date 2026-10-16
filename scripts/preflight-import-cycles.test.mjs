import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASELINE_FILE, circularEdges, compareBaseline, liveDistModules, parseBaseline, renderBaseline } from "./preflight-import-cycles.mjs";

let pkg;
const put = (rel, text) => {
  const p = join(pkg, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
};

beforeAll(() => {
  pkg = mkdtempSync(join(tmpdir(), "import-cycles-"));
  // a <-> b: a static cycle
  put("dist/a.js", 'import { B } from "./b.js";\nexport const A = 1;\nexport const AB = () => A + B;\n');
  put("dist/b.js", 'import { A } from "./a.js";\nexport const B = 2;\nexport const BA = () => A + B;\n');
  // c -> d static, d -> c only through a lazy import(): not a cycle at init
  put("dist/c.js", 'import { D } from "./d.js";\nexport const C = D;\n');
  put("dist/d.js", 'export const D = 4;\nexport async function lazy() { return (await import("./c.js")).C; }\n');
  // sub/e <-> sub/f across a directory
  put("dist/sub/e.js", 'import { F } from "./f.js";\nexport const E = () => F;\n');
  put("dist/sub/f.js", 'import { E } from "./e.js";\nexport const F = () => E;\n');
  // a test file and a stale output (no source) that both close a loop with a: never counted
  put("dist/a.test.js", 'import { A } from "./a.js";\nexport const T = A;\n');
  put("dist/stale.js", 'import { C } from "./c.js";\nexport const S = C;\n');
  put("dist/c2.js", 'import { S } from "./stale.js";\nexport const C2 = S;\n');
  for (const f of ["a", "b", "c", "d", "sub/e", "sub/f", "a.test", "c2"]) put(`src/${f}.ts`, "// source\n");
});

afterAll(() => rmSync(pkg, { recursive: true, force: true }));

describe("import-cycle pre-flight", () => {
  it("lists only compiled, non-test modules that still have a source", () => {
    expect(liveDistModules(pkg)).toEqual(["dist/a.js", "dist/b.js", "dist/c.js", "dist/c2.js", "dist/d.js", "dist/sub/e.js", "dist/sub/f.js"]);
  });

  it("reports the static cycle edges, sorted, and ignores lazy imports and test files", async () => {
    const edges = await circularEdges(pkg);
    expect([...edges.keys()]).toEqual(["a.js -> b.js", "b.js -> a.js", "sub/e.js -> sub/f.js", "sub/f.js -> sub/e.js"]);
    expect(edges.get("a.js -> b.js")).toContain("a.js");
  });

  it("is a ratchet: new edges and stale baseline entries are both reported", () => {
    expect(compareBaseline(["x -> y", "y -> x"], ["y -> x", "x -> y"])).toEqual({ added: [], stale: [] });
    expect(compareBaseline(["x -> y", "y -> x", "p -> q"], ["x -> y", "y -> x", "m -> n"])).toEqual({ added: ["p -> q"], stale: ["m -> n"] });
  });

  it("renders a sorted baseline that parses back to the same edges", () => {
    const text = renderBaseline(["b -> a", "a -> b"]);
    expect(text.startsWith("# ")).toBe(true);
    expect(parseBaseline(text)).toEqual(["a -> b", "b -> a"]);
  });

  it("the checked-in gateway baseline is sorted and has no duplicates", () => {
    const edges = parseBaseline(readFileSync(BASELINE_FILE, "utf8"));
    expect(edges.length).toBeGreaterThan(0);
    expect(edges).toEqual([...new Set(edges)].sort());
  });
});
