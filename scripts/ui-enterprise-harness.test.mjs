import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { spaRoutes, routeSlug, PARAM_FIXTURE } from "./ui-spa-routes.mjs";
import { growth, merge, readFindings, stale } from "./ui-enterprise-baseline.mjs";
import { compare, currentFindings, readBaseline, scanTs } from "./preflight-ui-tokens.mjs";
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
      { path: "/login", url: "/login" },
      { path: "/runs/:runId", url: `/runs/${PARAM_FIXTURE}` },
      { path: "/admin/users", url: "/admin/users" },
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
