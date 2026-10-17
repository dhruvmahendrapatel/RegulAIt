import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { spaRoutes, routeSlug, PARAM_FIXTURE } from "./ui-spa-routes.mjs";
import { growth, merge, parseBytes, readFindings, sizeLimitLoosened, stale } from "./ui-enterprise-baseline.mjs";
import { compare, cssDeclFindings, currentFindings, readBaseline, scanTs } from "./preflight-ui-tokens.mjs";
import { readPack, renderIndex } from "./ui-screenshot-index.mjs";

const dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ui-enterprise-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("SPA route census (ADR-0196)", () => {
  it("reads absolute and nested admin routes, fills params, drops catch-alls and redirects", () => {
    const src = `
      <Route path="/login" element={<LoginPage />} />
      <Route path="/runs/:runId" element={<RunDetailPage />} />
      <Route path="/admin/*" element={<RequireAdmin><Routes>
        <Route path="users" element={<UsersPage />} />
        <Route path="governance/use-cases" element={<Navigate to="/admin/use-cases" replace />} />
        <Route path="*" element={<Navigate to="/admin/users" replace />} />
      </Routes></RequireAdmin>} />
      <Route path="*" element={<Navigate to="/" replace />} />`;
    expect(spaRoutes(src)).toEqual([
      { path: "/login", url: "/login", public: true },
      { path: "/runs/:runId", url: `/runs/${PARAM_FIXTURE}`, public: true },
      { path: "/admin/users", url: "/admin/users", public: true },
    ]);
  });

  it("reads a path whatever the attribute order or the way it is written", () => {
    const src = `<Routes>
      <Route element={<A />} path="/a" />
      <Route path={"/b"} element={<B />} />
      <Route element={<C />} path={\`/c\`} />
      <Route
        element={<D />}
        path={("/d")}
      />
    </Routes>`;
    expect(spaRoutes(src).map((r) => r.path)).toEqual(["/a", "/b", "/c", "/d"]);
  });

  it("fails loudly on a path it cannot read instead of dropping the route", () => {
    expect(() => spaRoutes("<Route path={base + '/x'} element={<X />} />")).toThrow(/not a literal/);
    expect(() => spaRoutes("<Route {...props} />")).toThrow(/spread/);
  });

  it("marks screens under a signed-in layout, and resolves nested and descendant routes", () => {
    const src = `<Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<Protected />}>
        <Route path="/" element={<Home />} />
        <Route path="/admin/*" element={<RequireAdmin><Routes>
          <Route element={<Users />} path="users" />
        </Routes></RequireAdmin>} />
      </Route>
      <Route path="/docs" element={<Docs />}>
        <Route path="intro" element={<Intro />} />
      </Route>
    </Routes>`;
    expect(spaRoutes(src)).toEqual([
      { path: "/login", url: "/login", public: true },
      { path: "/", url: "/", public: false },
      { path: "/admin/users", url: "/admin/users", public: false },
      { path: "/docs", url: "/docs", public: true },
      { path: "/docs/intro", url: "/docs/intro", public: true },
    ]);
  });

  it("refuses a doubled route and an empty file", () => {
    expect(() => spaRoutes('<Route path="/a" element={<A />} /><Route path="/a" element={<B />} />')).toThrow(/twice/);
    expect(() => spaRoutes("nothing here")).toThrow(/no <Route/);
  });

  it("covers the real App.tsx: the shell, a public screen and the admin area", () => {
    const paths = spaRoutes().map((r) => r.path);
    expect(paths).toEqual(expect.arrayContaining(["/", "/login", "/f/:token", "/admin/users", "/admin/approvals", "/admin/execution"]));
    expect(paths.some((p) => p.includes("*"))).toBe(false);
    // the public screens are opened signed out; everything else needs the session
    expect(spaRoutes().filter((r) => r.public).map((r) => r.path)).toEqual(["/login", "/f/:token"]);
  });

  it("slugs a route for a file name", () => {
    expect(routeSlug("/")).toBe("root");
    expect(routeSlug("/admin/governance/use-cases/:id")).toBe("admin_governance_use_cases_id");
  });
});

describe("browser baselines (ADR-0196)", () => {
  it("merges a run: covered keys replaced or dropped, others kept", () => {
    const before = { "/a|light": { "color-contrast": 3 }, "/b|light": { "target-size": 1 }, "firefox|x": { "focus-stuck": 1 } };
    const run = { "/a|light": { "color-contrast": 2 }, "/b|light": {} };
    expect(merge(before, run)).toEqual({ "/a|light": { "color-contrast": 2 }, "firefox|x": { "focus-stuck": 1 } });
  });

  it("guards growth: a raised count and a new entry are both growth; a shrink is not", () => {
    const before = { k: { a: 2 } };
    expect(growth(before, { k: { a: 3 } })).toEqual(["k: a 2 -> 3"]);
    expect(growth(before, { k: { a: 2, b: 1 }, n: { c: 1 } })).toEqual(["k: b 0 -> 1", "n: c 0 -> 1"]);
    expect(growth(before, { k: { a: 1 } })).toEqual([]);
  });

  it("reports stale entries only for keys the run covered", () => {
    expect(stale({ k: { a: 2 }, other: { b: 1 } }, { k: { a: 1 } })).toEqual(["k: a 1 (baseline 2)"]);
  });

  it("reads the findings directory, a later line for a key winning", () => {
    const d = tmp();
    writeFileSync(join(d, "axe.chromium.0.jsonl"), [
      JSON.stringify({ category: "axe", key: "/a|light", findings: { x: 1 } }),
      JSON.stringify({ category: "axe", key: "/a|light", findings: { x: 2 } }),
      "",
    ].join("\n"));
    expect(readFindings(d)).toEqual({ axe: { "/a|light": { x: 2 } } });
    expect(readFindings(join(d, "missing"))).toEqual({});
  });
});

describe("bundle-size ceilings guard (ADR-0196)", () => {
  const base = [
    { name: "entry JS", path: "dist/assets/index-*.js", gzip: true, limit: "817 kB" },
    { name: "lazy", path: ["dist/a-*.js", "dist/a-*.css"], gzip: true, limit: "79 kB" },
  ];
  const edit = (name, change) => base.map((c) => (c.name === name ? { ...c, ...change } : c));

  it("reads limits the way size-limit does (B, kB, MB in 1000s; KiB in 1024s)", () => {
    expect(parseBytes("817 kB")).toBe(817_000);
    expect(parseBytes("1.02 MB")).toBe(1_020_000);
    expect(parseBytes("10KB")).toBe(10_000);
    expect(parseBytes("1 KiB")).toBe(1024);
    expect(parseBytes("500 B")).toBe(500);
    expect(parseBytes(1234)).toBe(1234);
    expect(parseBytes("1 s")).toBeNull();
  });

  it("fails a raised limit, across units, and not a lowered or equal one", () => {
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "5 MB" }))).toEqual(['"entry JS": limit raised 817 kB -> 5 MB']);
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "817001 B" }))).toEqual(['"entry JS": limit raised 817 kB -> 817001 B']);
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "0.817 MB" }))).toEqual([]);
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "800 kB" }))).toEqual([]);
  });

  it("fails a removed entry; a new entry is allowed", () => {
    expect(sizeLimitLoosened(base, base.slice(1))).toEqual(['"entry JS": entry removed']);
    expect(sizeLimitLoosened(base, [...base, { name: "new", path: "dist/x.js", limit: "1 kB" }])).toEqual([]);
  });

  it("fails a changed path or gzip; a path written as a one-item array is the same path", () => {
    expect(sizeLimitLoosened(base, edit("entry JS", { path: "dist/assets/*.js" }))).toEqual(['"entry JS": path, gzip or another option changed']);
    expect(sizeLimitLoosened(base, edit("lazy", { gzip: false }))).toEqual(['"lazy": path, gzip or another option changed']);
    expect(sizeLimitLoosened(base, edit("entry JS", { path: ["dist/assets/index-*.js"] }))).toEqual([]);
  });

  it("refuses a doubled name and a limit that is not a size", () => {
    expect(() => sizeLimitLoosened(base, [...base, base[0]])).toThrow(/twice/);
    expect(sizeLimitLoosened(base, edit("lazy", { limit: "1 s" }))).toEqual(['"lazy": limit "1 s" is not a size']);
  });
});

describe("design-token ratchet (ADR-0196)", () => {
  it("finds colour literals in strings and literal spacing in inline styles, not tokens or comments", () => {
    const found = scanTs([
      ["a.tsx", [
        'const c = "#1d4ed8";',
        'const d = `rgba(0, 0, 0, 0.4)`;',
        '<div style={{ gap: 12, padding: "8px 4px", margin: "var(--s1)" }}>',
        'const ok = "var(--rg-signal)";',
        "// #ffffff in a comment",
      ].join("\n")],
      ["clean.ts", 'export const x = "var(--s2)";'],
    ]);
    expect(found).toEqual({ "a.tsx": { "ts-color-literal": 2, "ts-spacing-literal": 2 } });
  });

  it("finds hex, named and functional colours and literal spacing in CSS declarations, not tokens or urls", () => {
    expect(cssDeclFindings("color", "#fff")).toEqual({ "color-no-hex": 1 });
    expect(cssDeclFindings("border", "1px solid white")).toEqual({ "color-named": 1 });
    expect(cssDeclFindings("box-shadow", "0 0 2px rgba(0, 0, 0, 0.4), 0 1px hsl(0 0% 0%)")).toEqual({ "function-disallowed-list": 2 });
    expect(cssDeclFindings("padding", "8px var(--s2) 0.5rem")).toEqual({ "declaration-property-unit-disallowed-list": 2 });
    expect(cssDeclFindings("--mon-s1", "#2a78d6")).toEqual({ "color-no-hex": 1 });
    expect(cssDeclFindings("color", "var(--rg-signal)")).toEqual({});
    expect(cssDeclFindings("background", "url(#abc) transparent")).toEqual({});
    expect(cssDeclFindings("width", "12px")).toEqual({});
  });

  it("compares both ways: above the baseline is new, below it is stale", () => {
    const base = { "a.css": { "color-no-hex": 2 }, "b.css": { "color-named": 1 } };
    const cur = { "a.css": { "color-no-hex": 3 }, "c.css": { "color-no-hex": 1 } };
    expect(compare(base, cur)).toEqual({
      over: ["a.css: color-no-hex 3 (baseline 2)", "c.css: color-no-hex 1 (baseline 0)"],
      stale: ["b.css: color-named 0 (baseline 1)"],
    });
  });

  it("the committed baseline matches the source exactly", async () => {
    expect(compare(readBaseline(), await currentFindings())).toEqual({ over: [], stale: [] });
  }, 60_000);
});

describe("screenshot pack index (ADR-0196)", () => {
  it("lists every screen with its shots, escaped, sorted by route", () => {
    const d = tmp();
    for (const [slug, route] of [["b", "/b"], ["a", "/a<x>"]]) {
      mkdirSync(join(d, slug));
      writeFileSync(join(d, slug, "manifest.json"), JSON.stringify({ route, url: route, shots: [`${slug}/desktop-1440-light.jpg`] }));
    }
    const entries = readPack(d);
    expect(entries.map((e) => e.route)).toEqual(["/a<x>", "/b"]);
    const html = renderIndex(entries, "2026-10-17T00:00:00.000Z");
    expect(html).toContain("2 screens, 2 shots");
    expect(html).toContain("/a&lt;x&gt;");
    expect(html).not.toContain("/a<x>");
    expect(html).toContain('href="b/desktop-1440-light.jpg"');
  });
});
