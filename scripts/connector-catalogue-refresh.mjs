#!/usr/bin/env node
/**
 * ADR-0255 (P31) — regenerate `packages/connector-provider/src/pieces-available.ts`, the list of Activepieces
 * community pieces the connector catalogue shows as "available, not enabled".
 *
 * A DEV-TIME tool. Nothing it reads is vendored as code or run: it writes names, versions and upstream paths only, and
 * the product reads the generated file without touching the network, so the catalogue works air-gapped.
 *
 * WHERE EACH ENTRY IS VERIFIED TO COME FROM (#753 review). npm metadata is not enough: the `@activepieces/piece-*`
 * packages carry no `license` and no `repository` field, and some published names have no community source at all
 * (`agent`, `activity`, …) or live under `packages/pieces/core/`. So an entry is kept only when ALL of these hold:
 *   1. npm publishes `@activepieces/piece-<key>` (the version comes from npm);
 *   2. the upstream repository, at the commit recorded in the file, has `packages/pieces/community/<key>/package.json`
 *      and that file's `name` is exactly `@activepieces/piece-<key>`;
 *   3. the name passes the EE guard's own package rule (`allowedActivepiecesPackage`) and the path its EE-path rule
 *      (`isActivepiecesEePath`), imported from `scripts/activepieces-ee-guard.mjs`, never re-implemented here;
 *   4. the key is not a curated piece (the curated keys are read from CURATED_PIECES by the guard's own parser) and
 *      not in EXCLUDED below.
 * The licence follows from the repository's root LICENSE: MIT for everything outside `packages/ee/` and
 * `packages/server/api/src/app/ee`, which `packages/pieces/community/*` is (THIRD_PARTY.md has the reasoning).
 *
 * EXCLUDED pieces are never listed: they take a URL, a query or code from the caller (no fixed request), use a
 * transport the egress-guarded fetch cannot carry, or are parts of the Activepieces platform itself.
 *
 * Usage:
 *   node scripts/connector-catalogue-refresh.mjs [--upstream <activepieces checkout>] [--check]
 *   --upstream  an existing checkout to read package.json files from; without it the script makes a blobless, shallow
 *               clone of github.com/activepieces/activepieces in a temporary directory and checks out only the
 *               community package.json files (data; nothing from the clone is executed).
 *   --check     exit 1 if the file would change (no write).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { allowedActivepiecesPackage, curatedKeys, isActivepiecesEePath } from "./activepieces-ee-guard.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "packages/connector-provider/src/pieces-available.ts");
const PIECES_TS = path.join(root, "packages/connector-provider/src/pieces.ts");
const UPSTREAM = "https://github.com/activepieces/activepieces.git";
const COMMUNITY = "packages/pieces/community";
const PREFIX = "@activepieces/piece-";
const KEY = /^[a-z0-9][a-z0-9-]{0,80}$/;

/** name (without the `@activepieces/piece-` prefix) -> why it is never offered */
export const EXCLUDED = {
  http: "arbitrary_request",
  "http-oauth2": "arbitrary_request",
  graphql: "arbitrary_request",
  "anyhook-graphql": "arbitrary_request",
  webhook: "arbitrary_request",
  smtp: "non_http_transport",
  imap: "non_http_transport",
  sftp: "non_http_transport",
  mysql: "non_http_transport",
  postgres: "non_http_transport",
  mongodb: "non_http_transport",
  "microsoft-sql-server": "non_http_transport",
  "apache-kafka": "non_http_transport",
  rabbitmq: "non_http_transport",
  activepieces: "platform_internal",
  subflows: "platform_internal",
  store: "platform_internal",
  tables: "platform_internal",
  connections: "platform_internal",
  approval: "platform_internal",
  delay: "platform_internal",
  schedule: "platform_internal",
  "manual-task": "platform_internal",
  "manual-trigger": "platform_internal",
  forms: "platform_internal",
  ai: "platform_internal",
};

async function npmVersions() {
  const names = new Map();
  for (let from = 0; from < 5000; from += 250) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(PREFIX)}&size=250&from=${from}`;
    let res = await fetch(url);
    // the search API throttles; back off 2s, 4s, 8s, 16s
    for (let wait = 2000; res.status === 429 && wait <= 16000; wait *= 2) {
      await new Promise((r) => setTimeout(r, wait));
      res = await fetch(url);
    }
    if (!res.ok) throw new Error(`npm search answered ${res.status}`);
    const objects = (await res.json()).objects ?? [];
    for (const o of objects) {
      const { name, version } = o.package ?? {};
      if (typeof name === "string" && name.startsWith(PREFIX) && typeof version === "string") names.set(name, version);
    }
    if (objects.length < 250) break;
  }
  return names;
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();

/** { commit, names: Map<dir, package.json name> } for every directory under packages/pieces/community */
function upstreamCommunity(checkout) {
  let dir = checkout;
  let tmp = null;
  if (!dir) {
    tmp = mkdtempSync(path.join(tmpdir(), "ap-upstream-"));
    dir = path.join(tmp, "repo");
    execFileSync("git", ["clone", "-q", "--filter=blob:none", "--no-checkout", "--depth", "1", UPSTREAM, dir], { stdio: "inherit" });
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "checkout", "-q", "HEAD", "--", `${COMMUNITY}/*/package.json`], { cwd: dir, stdio: "inherit" });
  }
  try {
    const commit = git(dir, "rev-parse", "HEAD");
    const dirs = git(dir, "ls-tree", "-d", "--name-only", "HEAD", `${COMMUNITY}/`).split("\n").filter(Boolean);
    const names = new Map();
    for (const d of dirs) {
      const file = path.join(dir, d, "package.json");
      if (!existsSync(file)) continue;
      const name = JSON.parse(readFileSync(file, "utf8")).name;
      if (typeof name === "string") names.set(path.basename(d), name);
    }
    return { commit, names };
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

/** the rows that pass every check above, and the npm names dropped (with why) */
export function selectRows(npm, upstreamNames, curated) {
  const rows = [];
  const dropped = [];
  for (const [name, version] of npm) {
    const key = name.slice(PREFIX.length);
    const pathIn = `${COMMUNITY}/${key}`;
    if (!KEY.test(key)) dropped.push([key, "bad_key"]);
    else if (!allowedActivepiecesPackage(name) || isActivepiecesEePath(`activepieces/${pathIn}`)) dropped.push([key, "ee"]);
    else if (upstreamNames.get(key) !== name) dropped.push([key, "not_in_community"]);
    else if (key in EXCLUDED) dropped.push([key, "excluded"]);
    else if (curated.has(key)) dropped.push([key, "curated"]);
    else rows.push([key, version, pathIn]);
  }
  rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  dropped.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { rows, dropped };
}

export function render(rows, commit) {
  const body = rows.map(([k, v, p]) => `  [${JSON.stringify(k)}, ${JSON.stringify(v)}, ${JSON.stringify(p)}],`).join("\n");
  return `/**
 * GENERATED by scripts/connector-catalogue-refresh.mjs — do not edit by hand (ADR-0255).
 *
 * Activepieces community pieces the catalogue lists as "available, not enabled": [piece key, npm version, upstream
 * path]. Names, versions and paths only; no piece code is vendored. Every row was checked against the upstream tree at
 * AVAILABLE_PIECES_SOURCE.commit: its path exists under packages/pieces/community/ and its package.json declares
 * exactly @activepieces/piece-<key>. scripts/activepieces-ee-guard.mjs re-checks every row in CI. A piece here has no
 * RegulAIt adapter, so it cannot be enabled until one is written and added to CURATED_PIECES (pieces.ts).
 */
export const AVAILABLE_PIECES_SOURCE = {
  repository: "github.com/activepieces/activepieces",
  commit: ${JSON.stringify(commit)},
  licence: "MIT (repository root LICENSE; packages/ee/ and packages/server/api/src/app/ee excluded, never sourced)",
} as const;

export const AVAILABLE_PIECES: ReadonlyArray<readonly [string, string, string]> = [
${body}
];

/** never offered: they take a URL, query or code from the caller, need a non-HTTP transport, or are platform parts */
export const EXCLUDED_PIECES: Readonly<Record<string, "arbitrary_request" | "non_http_transport" | "platform_internal">> = ${JSON.stringify(EXCLUDED, null, 2)};
`;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--upstream");
  const checkout = at >= 0 ? path.resolve(argv[at + 1] ?? "") : null;
  const curated = new Set(curatedKeys(readFileSync(PIECES_TS, "utf8")));
  if (curated.size === 0) throw new Error("no curated keys parsed from pieces.ts");
  const { commit, names } = upstreamCommunity(checkout);
  const { rows, dropped } = selectRows(await npmVersions(), names, curated);
  const counts = dropped.reduce((m, [, why]) => ((m[why] = (m[why] ?? 0) + 1), m), {});
  console.log(`upstream ${commit}: ${rows.length} rows; dropped ${JSON.stringify(counts)}`);
  for (const [k, why] of dropped.filter(([, w]) => w === "not_in_community" || w === "ee")) console.log(`  dropped ${k}: ${why}`);
  const out = render(rows, commit);
  if (argv.includes("--check")) {
    const same = readFileSync(OUT, "utf8") === out;
    console.log(same ? "pieces-available.ts is current" : "pieces-available.ts would change");
    process.exit(same ? 0 : 1);
  }
  writeFileSync(OUT, out);
  console.log(`wrote ${path.relative(root, OUT)}`);
}
