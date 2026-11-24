/**
 * ADR-0334: build the unpacked extension into dist/ (the customer's packaging signs it into a CRX for their
 * browser management; nothing here publishes it).
 *
 *   node scripts/build.mjs --gateway-origin https://gateway.example.com [--version 0.1.0]
 *
 * `--gateway-origin` (#1029) pins the one gateway the extension may reach: it becomes a host permission (so the worker
 * calls it without CORS) and a constant in the bundle, and a managed `gatewayUrl` with any other origin is refused.
 * Without it the build reaches no gateway and every governed site stays blocked (the strict default); it says so.
 *
 * Bundles with esbuild (MIT, pinned): the worker as an ES module, the content script and block page as IIFEs, all
 * minified, no source maps (no source maps in production, CLAUDE.md checklist), no network at run time. The manifest
 * and the fail-closed ruleset are generated from the governed site catalogue (src/manifest.ts).
 */
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dist = path.join(root, "dist");
const argv = process.argv.slice(2);
const version = argv.includes("--version") ? argv[argv.indexOf("--version") + 1] : JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!/^[0-9]{1,5}(?:\.[0-9]{1,5}){0,3}$/.test(version ?? "")) throw new Error("--version must be 1 to 4 dot-separated numbers");
const originArg = argv.includes("--gateway-origin") ? argv[argv.indexOf("--gateway-origin") + 1] : null;

rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "rules"), { recursive: true });

// the origin check is the worker's own (src/guards.ts), loaded here so the build and the worker agree
const guardsGen = path.join(dist, ".guards.mjs");
await build({ bundle: true, platform: "node", format: "esm", logLevel: "warning", entryPoints: [path.join(root, "src/guards.ts")], outfile: guardsGen });
const { parseGatewayOrigin } = await import(pathToFileURL(guardsGen).href);
rmSync(guardsGen);
const gatewayOrigin = originArg === null ? null : parseGatewayOrigin(originArg ?? "");

const common = { bundle: true, define: { __REGULAIT_GATEWAY_ORIGIN__: JSON.stringify(gatewayOrigin ?? "") }, minify: true, sourcemap: false, legalComments: "eof", target: "chrome137", platform: "browser", loader: { ".css": "text" }, logLevel: "warning" };
await build({ ...common, entryPoints: [path.join(root, "src/background.ts")], outfile: path.join(dist, "background.js"), format: "esm" });
await build({ ...common, entryPoints: [path.join(root, "src/content.ts")], outfile: path.join(dist, "content.js"), format: "iife" });
await build({ ...common, entryPoints: [path.join(root, "src/block.ts")], outfile: path.join(dist, "block.js"), format: "iife" });

// the manifest, ruleset and managed schema come from the same pure module the tests pin
const gen = path.join(dist, ".gen.mjs");
await build({ ...common, minify: false, platform: "node", format: "esm", entryPoints: [path.join(root, "src/manifest.ts")], outfile: gen });
const m = await import(pathToFileURL(gen).href);
rmSync(gen);
writeFileSync(path.join(dist, "manifest.json"), `${JSON.stringify(m.buildManifest(version, undefined, gatewayOrigin), null, 2)}\n`);
writeFileSync(path.join(dist, "rules/fail_closed.json"), `${JSON.stringify(m.failClosedRules(), null, 2)}\n`);
writeFileSync(path.join(dist, "managed_schema.json"), `${JSON.stringify(m.MANAGED_SCHEMA, null, 2)}\n`);
copyFileSync(path.join(root, "static/block.html"), path.join(dist, "block.html"));
copyFileSync(path.join(root, "static/ui.css"), path.join(dist, "ui.css"));
copyFileSync(path.resolve(root, "../../apps/web/src/theme/tokens.css"), path.join(dist, "tokens.css"));
console.log(`built the browser extension ${version} into ${path.relative(process.cwd(), dist) || "."}`);
if (!gatewayOrigin) console.log("no --gateway-origin: this build reaches no gateway, so every governed site stays blocked");
else console.log(`pinned to the gateway ${gatewayOrigin}`);
