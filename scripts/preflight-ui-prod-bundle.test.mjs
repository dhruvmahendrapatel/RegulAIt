import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEV_ONLY_MARKERS, devMarkersIn, scanAssets } from "./preflight-ui-prod-bundle.mjs";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../apps/web");
const fromWeb = createRequire(path.join(web, "package.json"));
const reactCjs = path.join(path.dirname(fromWeb.resolve("react/package.json")), "cjs");
const reactDomCjs = path.join(path.dirname(fromWeb.resolve("react-dom/package.json")), "cjs");
const routerDist = path.join(
  path.dirname(createRequire(fromWeb.resolve("react-router-dom/package.json")).resolve("react-router/package.json")),
  "dist",
);
const read = (dir, name) => readFileSync(path.join(dir, name), "utf8");
const allIn = (dir, test) =>
  readdirSync(dir)
    .filter(test)
    .map((n) => read(dir, n))
    .join("\n");

describe("preflight-ui-prod-bundle markers", () => {
  const routerMarkers = DEV_ONLY_MARKERS.filter((m) => m.library === "routing library");
  const reactMarkers = DEV_ONLY_MARKERS.filter((m) => m.library === "React");

  it("each React marker is in React's development build and absent from its production build", () => {
    const dev = allIn(reactCjs, (n) => n.endsWith(".development.js")) + allIn(reactDomCjs, (n) => n.endsWith(".development.js"));
    const prod = allIn(reactCjs, (n) => n.endsWith(".production.min.js")) + allIn(reactDomCjs, (n) => n.endsWith(".production.min.js"));
    expect(reactMarkers.length).toBeGreaterThan(0);
    for (const m of reactMarkers) {
      expect(dev, m.text).toContain(m.text);
      expect(prod, m.text).not.toContain(m.text);
    }
  });

  it("the routing library's two builds differ by the dev-warning switch, and each marker sits behind it", () => {
    const dev = allIn(path.join(routerDist, "development"), (n) => n.endsWith(".mjs"));
    const prod = allIn(path.join(routerDist, "production"), (n) => n.endsWith(".mjs"));
    expect(dev).toContain("var ENABLE_DEV_WARNINGS = true;");
    expect(prod).toContain("var ENABLE_DEV_WARNINGS = false;");
    expect(routerMarkers.length).toBeGreaterThan(0);
    for (const m of routerMarkers) {
      // the warning is guarded by `if (ENABLE_DEV_WARNINGS) { warning(…, \`<marker>…`, so minifying the production
      // build drops it; the guard's break proof (a build without the swap) shows it survives in the development one
      const at = dev.indexOf(m.text);
      expect(at, m.text).toBeGreaterThan(-1);
      expect(dev.slice(Math.max(0, at - 200), at)).toContain("if (ENABLE_DEV_WARNINGS)");
    }
  });

  it("the routing library still names only its development build in its exports (else drop the vite.config swap)", () => {
    const pkg = JSON.parse(readFileSync(path.join(routerDist, "../package.json"), "utf8"));
    expect(JSON.stringify(pkg.exports["."])).not.toContain("production");
    expect(JSON.stringify(pkg.exports["./dom"])).not.toContain("production");
  });
});

describe("preflight-ui-prod-bundle scan", () => {
  it("finds a marker in a .js asset and ignores clean files and other extensions", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prod-bundle-"));
    try {
      writeFileSync(path.join(dir, "index-a.js"), 'console.warn("No routes matched location \\"/x\\"")');
      writeFileSync(path.join(dir, "clean-b.js"), "export const a = 1;");
      writeFileSync(path.join(dir, "notes.txt"), "Download the React DevTools");
      expect(scanAssets(dir)).toEqual([{ file: "index-a.js", library: "routing library", text: "No routes matched location" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a clean source has no markers", () => {
    expect(devMarkersIn("function useNavigate(){}")).toEqual([]);
  });
});
