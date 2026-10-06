#!/usr/bin/env node
// =============================================================================
// security-runtime-contents.mjs — the runtime image carries no build tool and
// no package manager (ADR-0184).
//
// The first CI Trivy scan of the image (PR #131) found 22 HIGH/CRITICAL Go
// standard-library CVEs compiled into the esbuild binary, a build-time tool
// that the single-stage image shipped in node_modules. The Dockerfile now
// copies a production-only tree into its runtime stage; this check makes that
// a deterministic gate rather than something a scanner happens to notice.
//
// usage: node security-runtime-contents.mjs <app-root> [--system]
//   security.yml pipes it into the image: docker run -i --rm --user root
//   --entrypoint node regulait:scan --input-type=module - /app --system < this file
// exit: 0 clean; 1 a build tool or package manager is present; 2 cannot check
// =============================================================================
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Package directories under node_modules/.pnpm are named `<name>@<version>…`,
// with `/` in a scope written as `+`. These are build/test tooling only.
export const BUILD_TOOL = /^(esbuild|@esbuild\+[^@]+|vite|vitest|@vitest\+[^@]+|typescript|tsx|drizzle-kit|playwright|playwright-core|@playwright\+[^@]+|rollup|@rollup\+[^@]+|@vitejs\+[^@]+)@/;

export function findBuildTools(root, { system = false } = {}) {
  const store = path.join(root, "node_modules", ".pnpm");
  if (!existsSync(store)) return { error: `no ${store}: not an installed workspace` };
  const packages = readdirSync(store).filter((d) => d !== "node_modules" && !d.startsWith("lock"));
  const hits = packages.filter((d) => BUILD_TOOL.test(d));
  // apps/web is served from its built dist; its own dependencies are build-time only
  if (existsSync(path.join(root, "apps", "web", "node_modules"))) hits.push("apps/web/node_modules");
  if (system) {
    for (const p of ["/usr/local/lib/node_modules/npm", "/usr/local/bin/npm", "/usr/local/bin/npx", "/root/.cache/node/corepack"]) {
      if (existsSync(p)) hits.push(p);
    }
  }
  return { hits, count: packages.length };
}

// Run as a CLI from a file (`node scripts/security-runtime-contents.mjs`) or
// piped on stdin (`node --input-type=module - <root>`); not when imported.
const piped = process.argv[1] === "-";
const isMain = piped || (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]));
if (isMain) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith("--"));
  if (!root) {
    console.error("usage: security-runtime-contents.mjs <app-root> [--system]");
    process.exit(2);
  }
  const r = findBuildTools(root, { system: args.includes("--system") });
  if (r.error) {
    console.error(`CHECK ERROR: ${r.error}`);
    process.exit(2);
  }
  if (r.hits.length) {
    console.error(`BUILD TOOLS IN THE RUNTIME IMAGE (${r.hits.length}):\n  ${r.hits.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`runtime contents clean: ${r.count} packages, no build tool or package manager`);
}
