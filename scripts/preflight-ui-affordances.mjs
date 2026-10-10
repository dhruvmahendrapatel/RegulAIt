#!/usr/bin/env node
/**
 * AFFORDANCE PARITY — every destructive endpoint the gateway serves should be
 * reachable from a screen, or be on this file's list with a reason.
 *
 * WHY THIS EXISTS. An audit found twelve `DELETE` routes that no view could
 * reach. Four were the grant types — so for a per-user access-control product,
 * an admin could hand out access from the UI and only take it back with a
 * database client. Nothing was broken: the endpoints worked, and
 * `GET /v1/users/:id/agents` had been returning `grantId` the whole time. The
 * button was simply never built, and nothing noticed, because "create" and
 * "delete" are written months apart and only one of them has a happy path
 * somebody demos.
 *
 * That is the shape of the complaint that a product "looks vibe-coded": not a
 * bug, but a surface where the easy half shipped and the hard half did not,
 * with no mechanism that would ever say so. This is that mechanism.
 *
 * WHAT IT IS NOT. It does not check that the button WORKS — only that some
 * view calls the route. A control that opens a confirm dialog and deletes
 * nothing passes this and fails its e2e spec, which is the right division of
 * labour: this is a census, not a test.
 *
 * Exit 0 clean, 1 when an endpoint is unreachable and unlisted, 2 if it could
 * not run at all. Any non-zero fails CI.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Endpoints with NO UI affordance, on purpose. Each needs a reason a reader can
 * check — "not needed" is not a reason. Deleting an entry is how you say "this
 * should have a button now"; adding one is a decision, so it should be a diff
 * somebody reviews.
 */
const DELIBERATELY_API_ONLY = new Map([
  // TEMPORARY (M-053): ADR-0187 decision 127 ships the model-artifact delete; no
  // Model artifacts page exists yet. Its button belongs to X28 (reassigned to
  // Claude by the owner on 10-10), and deleting this entry is part of X28's acceptance.
  ["/v1/model-artifacts/:x", "ADR-0187 decision 127: delete a model artifact — the Model artifacts page button is X28; remove this entry when it lands"],
  // TEMPORARY (M-053): ADR-0188 S1 registers revoking a workload credential as
  // a 501 stub; its button belongs to the agent identities page, Codex's X33
  // (slice S6). Deleting this entry is part of X33's acceptance.
  ["/v1/workload-identities/:x/credentials/:x", "ADR-0188 S1: revoke a workload credential — the agent identities page button is X33 (Codex, S6); remove this entry when it lands"],
]);

const walk = (dir, out = []) => {
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (e === "node_modules" || e === "dist" || e === ".git") continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e)) out.push(p);
  }
  return out;
};

/** `/v1/grants/agents/:grantId` and `/v1/grants/agents/${id}` both -> `/v1/grants/agents/:x` */
const norm = (p) =>
  "/" +
  p
    .replace(/\$\{[^}]*\}/g, ":x")
    .replace(/:[A-Za-z0-9_]+/g, ":x")
    .replace(/^\/+|\/+$/g, "");

/**
 * The web app's API client objects, by the identifier a call site uses. A call
 * through any other object is not counted, so a Map's `.get("/v1/…")` or some
 * unrelated `.del` is never mistaken for a button.
 *
 *   api        apps/web/src/api/client.ts, the shared client (most views)
 *   stepUpApi  apps/web/src/stepup/stepUp.ts `api`, imported under this alias:
 *              the step-up client every relaxing or owner-changing write uses
 *   sharedApi  the shared client under the alias stepUp.ts gives it
 *   deps       views/approvals/signedDecision.ts: the approval-decision seam,
 *              whose default is stepUpApi.post (the injection exists for tests)
 *
 * A new client object (or a new alias for one) belongs on this list; the
 * census test pins it. Missing one makes the census OVERSTATE the gap.
 */
export const API_CLIENTS = ["api", "stepUpApi", "sharedApi", "deps"];

/** the method names each verb is written as on those clients */
const VERB_FORMS = { del: ["del", "delete"], get: ["get"], post: ["post"], put: ["put"], patch: ["patch"] };

/** every `/v1` path a web source file calls with `verb` through a known client, normalized */
export function uiCallPaths(src, verb) {
  const forms = VERB_FORMS[verb];
  if (!forms) throw new Error(`uiCallPaths: unknown verb ${verb}`);
  // `(?<![\w$.])` so `myapi.del(` and `foo.api.del(` are not the client
  const call = new RegExp(
    `(?<![\\w$.])(?:${API_CLIENTS.join("|")})\\.(?:${forms.join("|")})(?:WithHeaders)?(?:<[^>]*>)?\\(`,
    "g",
  );
  const out = new Set();
  for (const m of src.matchAll(call)) {
    for (const lit of src.slice(m.index, m.index + 400).matchAll(/[`"'](\/v1\/[^`"']*)[`"']/g)) {
      // a query string is not part of the route
      out.add(norm(lit[1].split("?")[0]));
    }
  }
  return out;
}

function main() {
  const gatewaySrc = path.join(root, "apps/gateway/src");
  const webSrc = path.join(root, "apps/web/src");

  const served = new Set();
  for (const f of walk(gatewaySrc)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/app\.delete\(\s*"([^"]+)"/g)) served.add(norm(m[1]));
  }

  // EVERY SHAPE THE CALL IS ACTUALLY WRITTEN IN, which took four tries.
  //
  //   api.del(`/v1/x/${id}`)                 the easy one
  //   api.del<Thing>(`/v1/x/${id}`)          type parameter before the paren
  //   api.del(cond ? `/v1/a/..` : `/v1/b/..`) path chosen inside the call
  //   api.delWithHeaders(`/v1/x/${id}`, h)   the same DELETE with request headers
  //                                          (the intake draft's owner precondition)
  //   stepUpApi.del(`/v1/x/${id}`, b, h)     a different client object (API_CLIENTS)
  //
  // The first two misses each made this census OVERSTATE the gap, which is the
  // more dangerous direction: a report that cries wolf is switched off, and
  // then it is not a report. So rather than expecting a literal to sit
  // immediately after the paren, take a window after each call site and
  // harvest every /v1 path literal inside it.
  const reached = new Map();
  for (const f of walk(webSrc)) {
    const src = readFileSync(f, "utf8");
    for (const key of uiCallPaths(src, "del")) {
      if (!reached.has(key)) reached.set(key, []);
      reached.get(key).push(path.relative(root, f));
    }
  }

  // A helper may build one segment from a variable the literal shows as a
  // parameter, so compare segment-wise with `:x` as a wildcard on either side.
  const isReached = (route) => {
    if (reached.has(route)) return true;
    const want = route.split("/");
    for (const u of reached.keys()) {
      const got = u.split("/");
      if (got.length !== want.length) continue;
      if (got.every((seg, i) => seg === want[i] || seg === ":x" || want[i] === ":x")) return true;
    }
    return false;
  };

  // ---- the ADD side ------------------------------------------------------
  //
  // "73 POST routes are unreached" is a true number and a useless one: most are
  // ACTIONS (/prune, /sweep, /abort, /remediate), not add buttons, and a census
  // that counts them reads as noise and gets ignored. The precise question is
  // narrower and checkable: IS THERE A COLLECTION THE UI LISTS AND CANNOT ADD
  // TO? That is what "the add button is missing" actually means, and it is
  // three, not seventy-three.
  const posted = new Set();
  for (const f of walk(gatewaySrc)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/app\.post\(\s*"([^"]+)"/g)) posted.add(norm(m[1]));
  }
  const gotten = new Set();
  for (const f of walk(gatewaySrc)) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/app\.get\(\s*"([^"]+)"/g)) gotten.add(norm(m[1]));
  }
  const uiVerb = (verb) => {
    const out = new Set();
    // `postWithHeaders` (idempotent create) is the same verb with headers
    for (const f of walk(webSrc)) for (const p of uiCallPaths(readFileSync(f, "utf8"), verb)) out.add(p);
    return out;
  };
  const uiPost = uiVerb("post");
  const uiGet = uiVerb("get");
  const anyMatch = (route, set) => {
    if (set.has(route)) return true;
    const want = route.split("/");
    for (const u of set) {
      const got = u.split("/");
      if (got.length === want.length && got.every((seg, i) => seg === want[i] || seg === ":x" || want[i] === ":x")) {
        return true;
      }
    }
    return false;
  };
  const addGaps = [...posted]
    .filter((p) => !anyMatch(p, uiPost) && gotten.has(p) && anyMatch(p, uiGet))
    .sort();
  if (served.size === 0) {
    console.error("preflight-ui-affordances: found no DELETE routes — the scan is broken, not the app");
    return 2;
  }

  const orphans = [...served].filter((r) => !isReached(r) && !DELIBERATELY_API_ONLY.has(r)).sort();
  const staleExemptions = [...DELIBERATELY_API_ONLY.keys()].filter((r) => !served.has(r)).sort();

  console.log(
    `affordance parity: ${served.size} DELETE routes, ` +
      `${served.size - orphans.length - DELIBERATELY_API_ONLY.size} reachable, ` +
      `${DELIBERATELY_API_ONLY.size} exempt, ${orphans.length} orphaned`,
  );

  for (const r of staleExemptions) {
    console.error(`  STALE EXEMPTION  ${r} — listed as API-only but the gateway no longer serves it`);
  }
  for (const r of orphans) {
    console.error(`  NO UI AFFORDANCE  ${r}`);
  }
  if (addGaps.length > 0) {
    console.log("");
    console.log(`listed by the UI but not addable from it: ${addGaps.length}`);
    for (const r of addGaps) console.error(`  NO ADD AFFORDANCE  ${r}`);
    console.error(
      "\nEach route above creates something the UI already SHOWS — the list is\n" +
        "there and the way to add to it is not. Build the form, or say here why\n" +
        "the collection is populated some other way.",
    );
  }

  if (orphans.length > 0) {
    console.error(
      "\nEach route above can delete a governed object that no screen can delete.\n" +
        "Add the control (adminKit's <RemoveButton/>), or add the route to\n" +
        "DELIBERATELY_API_ONLY in this file with a reason somebody can check.",
    );
  }
  return orphans.length > 0 || staleExemptions.length > 0 || addGaps.length > 0 ? 1 : 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (e) {
    console.error("preflight-ui-affordances could not run:", e);
    process.exit(2);
  }
}
