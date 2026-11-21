import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appRoutes, ceilingFor, chunkName, chunkPath, coverageProblems, FIRST_LOAD_NAME, FIRST_PAINT_NAME, firstLoadFiles, firstPaintFiles, SIZE_LIMIT_FILE, totalProblems, withChunkCeilings } from "./ui-chunk-budgets.mjs";

const entry = { name: "entry JS (index)", path: "dist/assets/index-*.js", gzip: true, limit: "139.5 kB" };
const chunk = (n, limit = "10.0 kB") => ({ name: `chunk: ${n}`, path: chunkPath(n), gzip: true, limit });

describe("per-route bundle budgets (ADR-0344)", () => {
  it("reads the chunk name from Vite's <name>-<8-character hash>.js file name", () => {
    expect(chunkName("admin-integrations-B6EzGUPE.js")).toBe("admin-integrations");
    expect(chunkName("admin-overview--ZiBtAj2.js")).toBe("admin-overview"); // a hash may start with "-"
    expect(chunkName("views.module-BjP5uoGu.js")).toBe("views.module");
    expect(chunkName("index.js")).toBeNull();
  });

  it("sets a new ceiling at the gzip size plus 10%, at least 2 kB more, rounded up to 0.1 kB", () => {
    expect(ceilingFor(85_255)).toBe("93.8 kB"); // 10% is more than 2 kB
    expect(ceilingFor(4_666)).toBe("6.7 kB"); // the 2 kB floor
    expect(ceilingFor(20_000)).toBe("22.0 kB"); // both rules give exactly 22 kB
  });

  it("passes when every chunk has exactly one ceiling", () => {
    const files = ["index-AAAAAAAA.js", "admin-integrations-BBBBBBBB.js", "react-CCCCCCCC.js"];
    expect(coverageProblems(files, [entry, chunk("admin-integrations"), chunk("react")])).toEqual([]);
  });

  it("fails for a chunk with no ceiling, so a new lazy route cannot land without one", () => {
    const files = ["index-AAAAAAAA.js", "admin-new-page-BBBBBBBB.js"];
    expect(coverageProblems(files, [entry])).toEqual([
      "admin-new-page-BBBBBBBB.js: no ceiling in apps/web/.size-limit.json; add one with node scripts/ui-chunk-budgets.mjs --write",
    ]);
  });

  it("does not count either total as a chunk's ceiling", () => {
    const firstLoad = { name: FIRST_LOAD_NAME, path: [chunkPath("builder"), chunkPath("index")], gzip: true, limit: "139.5 kB" };
    const firstPaint = { ...firstLoad, name: FIRST_PAINT_NAME, limit: "182 kB" };
    expect(coverageProblems(["index-AAAAAAAA.js", "builder-BBBBBBBB.js"], [entry, firstLoad, firstPaint])).toHaveLength(1);
    expect(coverageProblems(["index-AAAAAAAA.js", "builder-BBBBBBBB.js"], [entry, firstLoad, firstPaint, chunk("builder")])).toEqual([]);
  });

  it("refuses a total over every JS chunk (the all-JS total is gone, ADR-0344 addendum)", () => {
    const allJs = { name: "all JS", path: "dist/assets/*.js", gzip: true, limit: "1170 kB" };
    expect(coverageProblems(["index-AAAAAAAA.js"], [entry, allJs])[0]).toMatch(/"all JS": path "dist\/assets\/\*\.js" is not/);
  });

  it("fails for a ceiling whose chunk the build no longer emits", () => {
    expect(coverageProblems(["index-AAAAAAAA.js"], [entry, chunk("gone")])).toEqual([
      '"chunk: gone": the build emitted no "gone" chunk; drop the ceiling (node scripts/ui-chunk-budgets.mjs --write)',
    ]);
  });

  it("fails for two chunks with one name, which size-limit would add up under one ceiling", () => {
    const problems = coverageProblems(["index-AAAAAAAA.js", "x-BBBBBBBB.js", "x-CCCCCCCC.js"], [entry, chunk("x")]);
    expect(problems[0]).toMatch(/two chunks are named "x"/);
  });

  it("fails for a chunk two ceilings cover, including a longer name a <name>-*.js path also matches", () => {
    const problems = coverageProblems(["index-AAAAAAAA.js", "index-extra-BBBBBBBB.js"], [entry, chunk("index-extra")]);
    expect(problems).toEqual(["index-extra-BBBBBBBB.js: covered by 2 ceilings (entry JS (index), chunk: index-extra); a chunk has exactly one"]);
  });

  it("refuses a chunk ceiling that is not gzip, spells another chunk, or uses another path shape", () => {
    const files = ["index-AAAAAAAA.js", "a-BBBBBBBB.js"];
    expect(coverageProblems(files, [entry, { ...chunk("a"), gzip: false }])).toEqual(['"chunk: a": must measure gzip (`"gzip": true`)']);
    expect(coverageProblems(files, [entry, { ...chunk("a"), path: "dist/assets/a-*.js" }])[0]).toMatch(/its path must be "dist\/assets\/a-\?{8}\.js"/);
    expect(coverageProblems(files, [entry, chunk("a"), { name: "odd", path: "dist/assets/**/a.js", limit: "1 kB" }])[0]).toMatch(/is not dist\/assets/);
  });

  it("writes ceilings for uncovered chunks, drops stale ones, and never changes an existing limit", () => {
    const before = [entry, chunk("kept", "1.0 kB"), chunk("stale")];
    const after = withChunkCeilings(before, { index: 39_000, kept: 50_000, fresh: 4_666 });
    expect(after).toEqual([entry, chunk("fresh", "6.7 kB"), chunk("kept", "1.0 kB")]);
  });

  // a Vite build manifest in miniature: the entry, two first-visit screens, one other route, shared chunks
  const app = `
    const LoginPage = screen(() => import("./screens/auth"), "LoginPage");
    const HomePage = lazy(() => import("./views/home/HomePage"));
    const RunsPage = screen(() => import("./screens/runs"), "RunsPage");
    <Route path="/login" element={<LoginPage />} />
    <Route path="/" element={<HomePage />} />
    <Route path="runs" element={<RunsPage />} />`;
  const manifest = (extra = {}) => ({
    "index.html": { file: "assets/index-AAAAAAAA.js", isEntry: true, imports: ["_react-BBBBBBBB.js"], dynamicImports: ["src/screens/auth.ts", "src/views/home/HomePage.tsx", "src/screens/runs.ts", "_palette-CCCCCCCC.js"], css: ["assets/index-DDDDDDDD.css"] },
    "_react-BBBBBBBB.js": { file: "assets/react-BBBBBBBB.js" },
    "_palette-CCCCCCCC.js": { file: "assets/palette-CCCCCCCC.js", isDynamicEntry: true },
    "src/screens/auth.ts": { file: "assets/auth-EEEEEEEE.js", isDynamicEntry: true, imports: ["index.html", "_kit-FFFFFFFF.js"] },
    "src/views/home/HomePage.tsx": { file: "assets/HomePage-GGGGGGGG.js", isDynamicEntry: true, imports: ["index.html", "_kit-FFFFFFFF.js"] },
    "_kit-FFFFFFFF.js": { file: "assets/kit-FFFFFFFF.js", imports: ["index.html"] },
    "src/screens/runs.ts": { file: "assets/runs-HHHHHHHH.js", isDynamicEntry: true, imports: ["index.html", "_kit-FFFFFFFF.js"] },
    ...extra,
  });
  const total = (name, paths, limit = "139.5 kB") => ({ name, path: paths, gzip: true, limit });

  it("reads first-load JS from Vite's manifest: the entry and its static imports, no dynamic import", () => {
    expect(firstLoadFiles(manifest())).toEqual(["index-AAAAAAAA.js", "react-BBBBBBBB.js"]);
  });

  it("reads which screen each route renders from App.tsx", () => {
    const { modules, elements } = appRoutes(app);
    expect(elements.get("/login")).toBe("LoginPage");
    expect(modules.get("HomePage")).toBe("src/views/home/HomePage");
    expect(modules.get(elements.get("runs"))).toBe("src/screens/runs");
  });

  it("counts in first-paint JS the first-visit screens and every dynamic import but the entry's route table", () => {
    // the other route stays out; the entry's non-route lazy import (palette) counts
    expect(firstPaintFiles(manifest(), app)).toEqual(["HomePage-GGGGGGGG.js", "auth-EEEEEEEE.js", "index-AAAAAAAA.js", "kit-FFFFFFFF.js", "palette-CCCCCCCC.js", "react-BBBBBBBB.js"]);
  });

  it("still counts code moved out of the entry into a new lazy chunk the home screen imports (R3, #1185)", () => {
    const moved = manifest({
      "src/views/home/HomePage.tsx": { file: "assets/HomePage-GGGGGGGG.js", isDynamicEntry: true, imports: ["index.html"], dynamicImports: ["src/views/home/Moved.tsx"] },
      "src/views/home/Moved.tsx": { file: "assets/Moved-JJJJJJJJ.js", isDynamicEntry: true, imports: ["index.html", "_heavy-KKKKKKKK.js"] },
      "_heavy-KKKKKKKK.js": { file: "assets/heavy-KKKKKKKK.js" },
    });
    const files = firstPaintFiles(moved, app);
    expect(files).toEqual(expect.arrayContaining(["Moved-JJJJJJJJ.js", "heavy-KKKKKKKK.js"]));
    // the committed path list from before the move no longer matches, so the gate fails until the total counts them
    const before = total(FIRST_PAINT_NAME, firstPaintFiles(manifest(), app).map((f) => chunkPath(chunkName(f))), "182 kB");
    expect(totalProblems(FIRST_PAINT_NAME, files, [entry, before])[0]).toMatch(/its paths must be exactly the chunks it adds up/);
  });

  it("fails closed when App.tsx renders no lazy screen at a first-visit path, or the manifest lacks a module", () => {
    expect(() => firstPaintFiles(manifest(), app.replace('path="/login"', 'path="/signin"'))).toThrow(/renders no lazily loaded screen at "\/login"/);
    const { ["src/screens/runs.ts"]: _gone, ...noRuns } = manifest();
    expect(() => firstPaintFiles({ ...noRuns, "index.html": { ...noRuns["index.html"], dynamicImports: [] } }, app)).toThrow(/no module for src\/screens\/runs/);
  });

  it("fails unless a total lists exactly the chunks it adds up, and measures gzip", () => {
    const files = firstLoadFiles(manifest());
    const exact = [chunkPath("index"), chunkPath("react")];
    expect(totalProblems(FIRST_LOAD_NAME, files, [entry, total(FIRST_LOAD_NAME, exact)])).toEqual([]);
    expect(totalProblems(FIRST_LOAD_NAME, files, [entry, total(FIRST_LOAD_NAME, [...exact].reverse())])).toEqual([]);
    expect(totalProblems(FIRST_LOAD_NAME, files, [entry, total(FIRST_LOAD_NAME, exact.slice(0, 1))])[0]).toMatch(/must be exactly/);
    expect(totalProblems(FIRST_LOAD_NAME, files, [entry, total(FIRST_LOAD_NAME, [...exact, chunkPath("extra")])])[0]).toMatch(/must be exactly/);
    expect(totalProblems(FIRST_LOAD_NAME, files, [entry, { ...total(FIRST_LOAD_NAME, exact), gzip: false }])).toEqual(['"first-load JS": must measure gzip (`"gzip": true`)']);
    expect(totalProblems(FIRST_PAINT_NAME, files, [entry])[0]).toMatch(/no "first-paint JS" ceiling/);
    expect(totalProblems(FIRST_LOAD_NAME, [], [entry, total(FIRST_LOAD_NAME, exact)])[0]).toMatch(/loads no JS/);
  });

  it("writes each total's path list from the build and keeps its limit", () => {
    const before = [entry, total(FIRST_LOAD_NAME, [chunkPath("index")]), chunk("react")];
    const after = withChunkCeilings(before, { index: 39_000, react: 2_800 }, { [FIRST_LOAD_NAME]: firstLoadFiles(manifest()) });
    expect(after[1]).toEqual(total(FIRST_LOAD_NAME, [chunkPath("index"), chunkPath("react")]));
    expect(after.slice(2)).toEqual([chunk("react")]);
  });

  it("reads the real App.tsx: /login and / each render a lazily loaded screen", () => {
    const { modules, elements } = appRoutes(readFileSync(new URL("../apps/web/src/App.tsx", import.meta.url), "utf8"));
    expect(modules.get(elements.get("/login"))).toBe("src/screens/auth");
    expect(modules.get(elements.get("/"))).toBe("src/views/home/HomePage");
  });

  it("covers every chunk of the committed .size-limit.json with the shape the check reads", () => {
    const entries = JSON.parse(readFileSync(SIZE_LIMIT_FILE, "utf8"));
    const chunks = entries.filter((e) => e.name.startsWith("chunk: "));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c).toEqual({ ...chunk(c.name.slice("chunk: ".length)), limit: c.limit });
    // the entry ceilings stay; the hard first-load total joins them, and no total over every chunk remains
    expect(entries.find((e) => e.name === "entry JS (index)")).toEqual(entry);
    expect(entries.find((e) => e.name === "entry CSS (index)")?.limit).toBe("10.7 kB");
    expect(entries.find((e) => e.name === FIRST_LOAD_NAME)).toMatchObject({ gzip: true, limit: "139.5 kB" });
    expect(entries.find((e) => e.name === FIRST_PAINT_NAME)).toMatchObject({ gzip: true, limit: "182 kB" });
    for (const n of [FIRST_LOAD_NAME, FIRST_PAINT_NAME]) expect(entries.find((e) => e.name === n).path).toContain(chunkPath("index"));
    expect(entries.find((e) => e.name === "all JS")).toBeUndefined();
  });
});
