import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ceilingFor, chunkName, chunkPath, coverageProblems, FIRST_LOAD_NAME, firstLoadFiles, firstLoadProblems, SIZE_LIMIT_FILE, withChunkCeilings } from "./ui-chunk-budgets.mjs";

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

  it("does not count the first-load total as a chunk's ceiling", () => {
    const firstLoad = { name: FIRST_LOAD_NAME, path: [chunkPath("builder"), chunkPath("index")], gzip: true, limit: "139.5 kB" };
    expect(coverageProblems(["index-AAAAAAAA.js", "builder-BBBBBBBB.js"], [entry, firstLoad])).toHaveLength(1);
    expect(coverageProblems(["index-AAAAAAAA.js", "builder-BBBBBBBB.js"], [entry, firstLoad, chunk("builder")])).toEqual([]);
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

  const html = `<!doctype html><head>
    <script type="module" crossorigin src="/ui/assets/index-Dm8L3QSC.js"></script>
    <link rel="modulepreload" crossorigin href="/ui/assets/react-BQ7o4F5D.js">
    <link rel="modulepreload" crossorigin href="/ui/assets/views.module-C7hCG9NA.js">
    <link rel="stylesheet" crossorigin href="/ui/assets/index-CndKyuc1.css">
    <link rel="icon" href="/ui/assets/brand-favicon-BwQIX84i.svg">
    <script src="/ui/assets/not-a-module-AAAAAAAA.js"></script>
  </head>`;
  const firstLoad = (paths) => ({ name: FIRST_LOAD_NAME, path: paths, gzip: true, limit: "139.5 kB" });

  it("reads the first-load JS from dist/index.html: the module entry and every modulepreload, nothing else", () => {
    expect(firstLoadFiles(html)).toEqual(["index-Dm8L3QSC.js", "react-BQ7o4F5D.js", "views.module-C7hCG9NA.js"]);
    expect(firstLoadFiles("<html></html>")).toEqual([]);
  });

  it("fails unless first-load JS lists exactly what a first visit loads", () => {
    const files = firstLoadFiles(html);
    const exact = [chunkPath("index"), chunkPath("react"), chunkPath("views.module")];
    expect(firstLoadProblems(files, [entry, firstLoad(exact)])).toEqual([]);
    expect(firstLoadProblems(files, [entry, firstLoad([...exact].reverse())])).toEqual([]);
    // a new static import of the entry cannot stay out of the total
    expect(firstLoadProblems(files, [entry, firstLoad(exact.slice(0, 2))])[0]).toMatch(/must be exactly what dist\/index.html loads/);
    expect(firstLoadProblems(files, [entry, firstLoad([...exact, chunkPath("extra")])])[0]).toMatch(/must be exactly/);
    expect(firstLoadProblems(files, [entry, { ...firstLoad(exact), gzip: false }])).toEqual(['"first-load JS": must measure gzip (`"gzip": true`)']);
    expect(firstLoadProblems(files, [entry])[0]).toMatch(/no "first-load JS" ceiling/);
    expect(firstLoadProblems([], [entry, firstLoad(exact)])[0]).toMatch(/loads no JS/);
  });

  it("writes the first-load path list from the build and keeps its limit", () => {
    const before = [entry, firstLoad([chunkPath("index")]), chunk("react"), chunk("views.module")];
    const after = withChunkCeilings(before, { index: 39_000, react: 2_800, "views.module": 39_000 }, firstLoadFiles(html));
    expect(after[1]).toEqual(firstLoad([chunkPath("index"), chunkPath("react"), chunkPath("views.module")]));
    expect(after.slice(2)).toEqual([chunk("react"), chunk("views.module")]);
  });

  it("covers every chunk of the committed .size-limit.json with the shape the check reads", () => {
    const entries = JSON.parse(readFileSync(SIZE_LIMIT_FILE, "utf8"));
    const chunks = entries.filter((e) => e.name.startsWith("chunk: "));
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c).toEqual({ ...chunk(c.name.slice("chunk: ".length)), limit: c.limit });
    // the entry ceilings stay; the hard first-load total joins them, and no total over every chunk remains
    expect(entries.find((e) => e.name === "entry JS (index)")).toEqual(entry);
    expect(entries.find((e) => e.name === "entry CSS (index)")?.limit).toBe("10.7 kB");
    const total = entries.find((e) => e.name === FIRST_LOAD_NAME);
    expect(total).toMatchObject({ gzip: true, limit: "139.5 kB" });
    expect(total.path).toContain(chunkPath("index"));
    expect(entries.find((e) => e.name === "all JS")).toBeUndefined();
  });
});
