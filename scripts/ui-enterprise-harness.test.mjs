import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { spaRoutes, routeSlug, PARAM_FIXTURE } from "./ui-spa-routes.mjs";
import { CEILING_EXCEPTIONS, ceilingExceptionProblems, growth, merge, parseBytes, readFindings, SIZE_SCRIPT_PIN, sizeLimitBypass, sizeLimitLoosened, stale } from "./ui-enterprise-baseline.mjs";
import { recordMode } from "../apps/web/e2e/enterprise/record-mode.ts";
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
    expect(() => spaRoutes('<Route path="/a" element={<A />} /><Route index element={<X />} />')).toThrow(/index/);
  });

  it("fails a splat route whose screens live in another file, and not one that renders <Routes> inline", () => {
    expect(() => spaRoutes('<Route path="/a" element={<A />} /><Route path="/x/*" element={<XRoutes />} />')).toThrow(/no inline <Routes>/);
    expect(() => spaRoutes('<Route path="/a" element={<A />} /><Route path="/x/*" />')).toThrow(/no inline <Routes>/);
    const inline = '<Route path="/x/*" element={<Guard><Routes><Route path="y" element={<Y />} /></Routes></Guard>} />';
    expect(spaRoutes(inline).map((r) => r.path)).toEqual(["/x/y"]);
    // the top-level catch-all and a splat redirect are not screens and need no <Routes>
    expect(spaRoutes('<Route path="/a" element={<A />} /><Route path="*" element={<Navigate to="/" />} /><Route path="/old/*" element={<Navigate to="/" />} />').map((r) => r.path)).toEqual(["/a"]);
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
    // ADR-0225 (P13 d): the public trust centre and the auditor portal
    expect(spaRoutes().filter((r) => r.public).map((r) => r.path)).toEqual(["/login", "/f/:token", "/trust", "/audit"]);
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

  it("allows a raise only when an exception names that entry, that from and that to", () => {
    const link = "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-1";
    const ex = [{ name: "entry JS", from: "817 kB", to: "818 kB", date: "2026-10-21", decision: link }];
    const adr = `owner decision ${link}: \`entry JS\` goes from \`817 kB\` to \`818 kB\`.`;
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "818 kB" }), ex, adr)).toEqual([]);
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "818000 B" }), ex, adr)).toEqual([]);
    // unreferenced: no exception, a different target, a different entry, or a base that is not `from`
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "818 kB" }))).toEqual(['"entry JS": limit raised 817 kB -> 818 kB']);
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "819 kB" }), ex, adr)).toEqual(['"entry JS": limit raised 817 kB -> 819 kB']);
    expect(sizeLimitLoosened(base, edit("lazy", { limit: "80 kB" }), ex, adr)).toEqual(['"lazy": limit raised 79 kB -> 80 kB']);
    expect(sizeLimitLoosened(edit("entry JS", { limit: "810 kB" }), edit("entry JS", { limit: "818 kB" }), ex, adr)).toEqual(['"entry JS": limit raised 810 kB -> 818 kB']);
    // an exception does not excuse a changed path
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "818 kB", path: "dist/*.js" }), ex, adr)).toEqual(['"entry JS": path, gzip or another option changed']);
    // a matching row the ADR does not record allows nothing: no ADR text, or an ADR that cites the link for another raise
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "818 kB" }), ex)).toEqual(['"entry JS": limit raised 817 kB -> 818 kB']);
    expect(sizeLimitLoosened(base, edit("entry JS", { limit: "818 kB" }), ex, `${link}: \`lazy\` from \`79 kB\` to \`80 kB\``)).toEqual(['"entry JS": limit raised 817 kB -> 818 kB']);
  });

  it("requires every exception to carry a dated owner decision that ADR-0196 records", () => {
    const link = "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-1";
    const ok = { name: "x", from: "1 kB", to: "2 kB", date: "2026-10-21", decision: link };
    const adr = `owner decision ${link}\n- \`x\` goes from \`1 kB\` to \`2 kB\`.`;
    expect(ceilingExceptionProblems([ok], adr)).toEqual([]);
    expect(ceilingExceptionProblems([ok], "no link here\n- `x` goes from `1 kB` to `2 kB`.")).toEqual([expect.stringMatching(/does not record/)]);
    expect(ceilingExceptionProblems([{ ...ok, date: undefined }], adr)[0]).toMatch(/no dated owner decision/);
    expect(ceilingExceptionProblems([{ ...ok, decision: "agreed in chat" }], adr)[0]).toMatch(/must link an owner comment/);
    expect(ceilingExceptionProblems([{ ...ok, decision: "https://example.com/x" }], adr)[0]).toMatch(/must link an owner comment/);
  });

  it("reports a row that cites a recorded link for an entry or value the ADR does not name", () => {
    const link = "https://github.com/dhruvmahendrapatel/RegulAIt/issues/453#issuecomment-1";
    const adr = `owner decision ${link}\n- \`x\` goes from \`1 kB\` to \`2 kB\`, and \`y\` stays at \`5 kB\`.\n\`3 kB\``;
    const row = (over) => ({ name: "x", from: "1 kB", to: "2 kB", date: "2026-10-21", decision: link, ...over });
    const names = /no line of .* names/;
    expect(ceilingExceptionProblems([row({ name: "y" })], adr)).toEqual([expect.stringMatching(names)]);
    expect(ceilingExceptionProblems([row({ to: "3 kB" })], adr)).toEqual([expect.stringMatching(names)]);
    expect(ceilingExceptionProblems([row({ from: "5 kB" })], adr)).toEqual([expect.stringMatching(names)]);
    // the three names must sit on one line, in order: from and to swapped, or split over two lines, do not count
    expect(ceilingExceptionProblems([row({ from: "2 kB", to: "1 kB" })], adr)).toEqual([expect.stringMatching(names)]);
    expect(ceilingExceptionProblems([row()], `${link}\n\`x\` goes from \`1 kB\`\nto \`2 kB\``)).toEqual([expect.stringMatching(names)]);
    // the real decision link, reused for a raise ADR-0196 does not name (review M3: SeriesLineChart 109 -> 110 kB)
    const reuse = { ...CEILING_EXCEPTIONS[0], name: "lazy: SeriesLineChart", from: "109 kB", to: "110 kB" };
    const real = readFileSync(new URL("../internal/decisions/0196-ui-enterprise-harness.md", import.meta.url), "utf8");
    expect(ceilingExceptionProblems([reuse], real)).toEqual([expect.stringMatching(names)]);
  });

  it("records every real exception in ADR-0196", () => {
    const adr = readFileSync(new URL("../internal/decisions/0196-ui-enterprise-harness.md", import.meta.url), "utf8");
    expect(ceilingExceptionProblems(CEILING_EXCEPTIONS, adr)).toEqual([]);
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

  it("matches size-limit's own parseBytes over a value table (drift test against the installed size-limit)", async () => {
    const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
    const bytesJs = join(dirname(webRequire.resolve("size-limit/package.json")), "bytes.js");
    const upstream = await import(pathToFileURL(bytesJs).href);
    const table = ["817 kB", "1.02 MB", "10KB", "10kb", "1 KiB", "2.5 MiB", "500 B", "500", "0 B", "+3 GB", "-1 kB", "1 s", "kB", "1 XB", 1234, 0];
    for (const v of table) expect(parseBytes(v), String(v)).toBe(upstream.parseBytes(v));
  });

  it("refuses ceilings read from anywhere but .size-limit.json: a package.json key, a second file, an unpinned script", () => {
    const pkg = { scripts: { size: SIZE_SCRIPT_PIN } };
    expect(sizeLimitBypass(pkg, [".size-limit.json", "package.json"])).toEqual([]);
    const keyed = sizeLimitBypass({ ...pkg, "size-limit": [{ name: "loose", path: "dist/assets/*.js", limit: "50 MB" }] }, [".size-limit.json"]);
    expect(keyed).toHaveLength(1);
    expect(keyed[0]).toMatch(/"size-limit" key/);
    const files = sizeLimitBypass(pkg, [".size-limit.json", ".size-limit.cjs", ".size-limit.js"]);
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/\.size-limit\.cjs is a second size-limit config/);
    expect(sizeLimitBypass({ scripts: { size: "size-limit" } }, [".size-limit.json"])[0]).toMatch(/must be exactly/);
    expect(sizeLimitBypass({ scripts: { size: "size-limit --config .size-limit.cjs" } }, [".size-limit.json"])[0]).toMatch(/must be exactly/);
    expect(sizeLimitBypass({}, [".size-limit.json"])[0]).toMatch(/must be exactly/);
  });

  it("finds no bypass in the real apps/web", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const web = new URL("../apps/web/", import.meta.url);
    expect(sizeLimitBypass(JSON.parse(readFileSync(new URL("package.json", web), "utf8")), readdirSync(web))).toEqual([]);
  });

  it("refuses a doubled name and a limit that is not a size", () => {
    expect(() => sizeLimitLoosened(base, [...base, base[0]])).toThrow(/twice/);
    expect(sizeLimitLoosened(base, edit("lazy", { limit: "1 s" }))).toEqual(['"lazy": limit "1 s" is not a size']);
  });
});

describe("record mode (ADR-0196)", () => {
  it("is off when unset or 0", () => {
    expect(recordMode({})).toBe(false);
    expect(recordMode({ ENTERPRISE_RECORD: "0", CI: "true" })).toBe(false);
  });

  it("is on locally with 1", () => {
    expect(recordMode({ ENTERPRISE_RECORD: "1" })).toBe(true);
  });

  it("throws in CI with 1", () => {
    expect(() => recordMode({ ENTERPRISE_RECORD: "1", CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch" })).toThrow(/record mode/);
  });

  it("throws in CI with update on a pull request", () => {
    expect(() => recordMode({ ENTERPRISE_RECORD: "update", CI: "true", GITHUB_EVENT_NAME: "pull_request" })).toThrow(/record mode/);
  });

  it("is allowed in CI only as update on a manual run", () => {
    expect(recordMode({ ENTERPRISE_RECORD: "update", CI: "true", GITHUB_EVENT_NAME: "workflow_dispatch" })).toBe(true);
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
