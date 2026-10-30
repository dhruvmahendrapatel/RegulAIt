#!/usr/bin/env node
/**
 * THE ROUTE CENSUS — every built capability has UI, or says why not.
 *
 * `preflight-ui-affordances.mjs` asks two narrow questions (can every DELETE be
 * reached from a screen; is there a list with no add). This asks the general
 * one, for EVERY verb: each route the gateway serves is either
 *
 *   (a) called by the web SPA (apps/web/src), matched the same way the
 *       affordance census matches (the shared matcher, `uiCalls`), or
 *   (b) on one of the reasoned lists below:
 *         MACHINE_ONLY     by design no human screen calls it (pattern entries
 *                          per category, each with a reason a reviewer can check)
 *         SUPERSEDED       an older route whose job a newer route the UI DOES
 *                          call now does (the replacement is named and checked)
 *         INDIRECT_UI_CALLS the UI calls it through a path held in state or
 *                          sent by the server, which no static scan can follow
 *                          (the evidence text is named and checked)
 *         KNOWN_UI_GAPS    TEMPORARY: a real capability with no screen yet.
 *                          Printed loudly on every run; the count is pinned and
 *                          may only go DOWN (KNOWN_UI_GAPS_MAX, and a test).
 *   or (c) still a 501 `notBuilt` stub (it does nothing, so it needs no screen).
 *
 * THE ROUTE LIST is `ROUTE_STABILITY` in apps/gateway/src/openapi-registry.ts:
 * one key per registered route, which `openapi.test.ts` already holds equal to
 * the LIVE Fastify inventory in both directions. So constants-based and scoped
 * registrations (`scope.post(OAUTH_TOKEN_PATH, …)`, `${EXECUTOR_CHANNEL_PREFIX}/…`)
 * are covered without re-parsing them here, and this census cannot drift from
 * what the gateway serves without that suite going red first.
 *
 * LISTS CANNOT ROT. An entry that names no route, a pattern that covers a
 * route the UI calls, a superseded route whose replacement the UI does not
 * call, an indirect call whose evidence is gone, or a known gap that now has a
 * screen, each FAILS the run. Deleting the entry is the fix.
 *
 * Exit 0 clean, 1 on a gap or a stale entry, 2 if it could not run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { literalPathsIn, norm, scanNotBuilt, scanWeb, segmentMatch } from "./preflight-ui-affordances.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * MACHINE-ONLY BY DESIGN. Keys are `"VERB /path"` (the registry's spelling),
 * with a one-line reason. A PATTERN (VERB may be `*`; a path ending in `/*`
 * covers everything under that prefix) is used only for a credentialed
 * machine surface, has a literal collection (never `/v1/*`, `/*` or
 * `/v1/:x/*`; see validatePattern), and pins how many routes it covers as
 * `{ reason, matches }`: a new route under the prefix changes the count and
 * fails the run, so it cannot hide there.
 */
export const MACHINE_ONLY = new Map([
  // ---- the SPA shell, health and API docs --------------------------------
  ["GET /", "shell: redirects a browser to the SPA; the SPA is what it serves"],
  ["GET /admin", "shell: legacy admin entry point, redirects into the SPA"],
  ["GET /app", "shell: legacy app entry point, redirects into the SPA"],
  ["GET /ui", "shell: serves the SPA's index.html (the page itself, not a call it makes)"],
  ["GET /ui/*", { reason: "shell: serves the SPA's static assets and deep links", matches: 1 }],
  ["GET /health", "health: the load balancer / container liveness probe"],
  ["GET /v1/openapi.json", "docs: the published OpenAPI document (ADR-0053), read by SDK generators"],
  ["GET /v1/api/versioning", "docs: the published versioning/deprecation policy (ADR-0053), read by API clients"],

  // ---- auth plumbing: browser redirects, IdP callbacks, token endpoints ----
  ["GET /auth/oidc/:providerId/start", "auth plumbing: the OIDC redirect to the IdP (the sign-in page links /login, which leads here)"],
  ["GET /auth/oidc/callback", "auth plumbing: the IdP's redirect back with the authorization code"],
  ["GET /auth/oidc/providers", "auth plumbing: public OIDC discovery; the sign-in page reads /auth/sign-in-options"],
  ["GET /auth/saml/:providerId/start", "auth plumbing: the SAML redirect to the IdP"],
  ["POST /auth/saml/:providerId/acs", "auth plumbing: the IdP's POST-back (assertion consumer service)"],
  ["GET /auth/saml/:providerId/metadata", "auth plumbing: SP metadata the IdP admin downloads (the SSO page shows its URL)"],
  ["GET /auth/saml/providers", "auth plumbing: public SAML discovery; the sign-in page reads /auth/sign-in-options"],
  ["GET /.well-known/oauth-protected-resource", "auth plumbing: RFC 9728 protected-resource metadata, fetched by MCP/OAuth clients"],
  ["GET /.well-known/oauth-protected-resource/mcp/:serverId", "auth plumbing: RFC 9728 metadata for one MCP server, fetched by MCP clients"],
  ["GET /.well-known/jwks.json", "auth plumbing: the issuer's public JWKS, fetched by relying parties"],
  ["GET /federation/.well-known/openid-configuration", "auth plumbing: the cloud federation issuer's OIDC discovery document, fetched by AWS, GCP and Entra"],
  ["GET /federation/.well-known/jwks.json", "auth plumbing: the cloud federation issuer's RS256 JWKS, fetched by AWS, GCP and Entra"],
  ["POST /oauth/token", "auth plumbing: RFC 6749 token endpoint for workload clients"],
  ["POST /oauth/token/revocation", "auth plumbing: RFC 7009 token revocation for workload clients"],
  ["POST /oauth/token/introspection", "auth plumbing: RFC 7662 token introspection for resource servers"],
  ["POST /v1/delegations/proofs", "auth plumbing: an agent proves a delegation chain (ADR-0188); called by agent runtimes"],

  // ---- public verification: keys an outside verifier needs -------------------
  ["GET /v1/exports/signing-key", "public verification: the public key a third party checks a signed export bundle with"],

  // ---- the data plane: what the gateway proxies and governs -------------------
  ["POST /v1/chat/completions", "data plane: OpenAI-compatible proxy (ADR-0020); called by vendor SDKs, governed per call"],
  ["POST /v1/messages", "data plane: Anthropic-compatible proxy (ADR-0024); called by vendor SDKs, governed per call"],
  ["GET /v1/models", "data plane: OpenAI-compatible model list for vendor SDKs"],
  ["POST /mcp/:serverId", "data plane: the governed MCP proxy endpoint MCP clients connect to"],
  ["GET /mcp/:serverId", "protocol plumbing: the Streamable HTTP SSE probe MCP clients send after initialize; answers 405 Allow: POST"],
  ["GET /v1/prompts/resolve", "data plane: runtimes and SDKs resolve a prompt@tag reference at call time"],
  ["POST /v1/connectors/:connectorId/invoke", "data plane: an agent runtime invokes a connector through the governance gate"],
  ["POST /v1/authz/check", "data plane: the policy decision point external enforcement points call (ADR-0053)"],

  // ---- the CI gate ----------------------------------------------------------
  ["POST /v1/gates/deploy", "CI gate: the deploy gate a customer's pipeline calls before it ships"],

  // ---- runner and executor channels (credentialed machines) ----------------
  ["* /v1/engine-runner/*", { reason: "runner channel: only an engine runner credential reaches these (ADR-0187, route-classes.ts; ADR-0188 S7 adds the key rotation route; ADR-0190 I5 adds the three task routes; ENG-IMG removes the runner artifact route)", matches: 9 }],
  ["* /v1/endpoint-agent/*", { reason: "endpoint agent channel: the agent's install step (bulk enrolment token), its registration (device ticket) and its own DPoP-bound self token reach these, never a person (ADR-0195 SD4b)", matches: 5 }],
  ["* /v1/executor-channel/*", { reason: "executor channel: only an enrolled executor reaches these (ADR-0190; I4 adds the two stdio session routes, I5 the two task input routes)", matches: 11 }],

  // ---- inbound callbacks and provisioning -----------------------------------
  ["POST /v1/pm/webhooks/:connectionName", "inbound callback: PM-tool webhooks, signature-verified in route (ADR-0061)"],
  ["POST /v1/chatops/:connectionName/interactions", "inbound callback: Slack/Teams button interactions, signature-verified in route (ADR-0061)"],
  ["POST /v1/chatops/:connectionName/events", "inbound callback: Slack Events API to builder agents (ADR-0173)"],
  ["POST /v1/chatops/:connectionName/messages", "inbound callback: Teams outgoing webhook to builder agents (ADR-0173)"],
  ["POST /v1/chatops/:connectionName/bot", "inbound callback: the Teams Bot Framework endpoint (ADR-0173 batch 2b)"],
  ["* /scim/v2/*", { reason: "inbound provisioning: the IdP's SCIM 2.0 client, with a SCIM bearer token (the SCIM page manages tokens)", matches: 13 }],
]);

/**
 * SUPERSEDED: an older route the UI no longer needs because a newer one it
 * calls does the same job. `replacement` must itself be a route the UI calls.
 * A replacement that returns only the newest N rows (no paging or filters)
 * does NOT supersede a list route: that is a KNOWN_UI_GAP. `job`, when set,
 * names the scheduler job the replacement runs; it must exist in
 * apps/gateway/src/scheduler-jobs.ts.
 */
export const SUPERSEDED = new Map([
  ["GET /v1/reports/definitions", { replacement: "GET /v1/reports/overview", reason: "the overview carries every definition (unpaged, all rows) with its schedules and run count" }],
  ["GET /v1/reports/schedules", { replacement: "GET /v1/reports/overview", reason: "the overview nests every definition's schedules (unpaged, all rows)" }],
  ["GET /v1/spend/monitor-policies", { replacement: "GET /v1/spend/monitor-overview", reason: "the monitor overview carries every policy (unpaged, all rows)" }],
  ["GET /v1/scim/tokens", { replacement: "GET /v1/scim/status", reason: "the SCIM status carries the token list" }],
  ["GET /v1/org/settings/assurance-gate-mode", { replacement: "GET /v1/org/settings", reason: "the settings read carries assuranceGateMode; the page writes it through the dedicated PUT" }],
  ["POST /v1/agents/:agentId/owner", { replacement: "PATCH /v1/agents/:agentId/stewardship", reason: "ADR-0168 stewardship sets the steward (the ADR-0089 owner column) in one audited save" }],
  ["POST /v1/agents/:agentId/lifecycle", { replacement: "PATCH /v1/agents/:agentId/stewardship", reason: "ADR-0168 stewardship sets the lifecycle status in the same save" }],
  ["GET /v1/licenses/:id", { replacement: "GET /v1/licenses", reason: "the history list carries every full license row the detail returns" }],
  // manual "run now" doors for scheduler jobs: the Scheduler page runs the SAME
  // function through POST /v1/scheduler/jobs/:name/run (`job` is checked
  // against scheduler-jobs.ts)
  ["POST /v1/config-versions/observations/prune", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "canary-observation-prune-sweep", reason: "the job runs the same prune function" }],
  ["POST /v1/certification-campaigns/expiry-sweep", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "certification-expiry-sweep", reason: "the job runs the same expiry sweep" }],
  ["POST /v1/redteam/scheduled-sweep", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "redteam-sweep", reason: "the job runs runScheduledRedTeamSweep, as this door does" }],
  ["POST /v1/builder/schedules/sweep", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "builder-agent-schedules", reason: "the job runs runBuilderScheduleSweep, as this door does" }],
  ["POST /v1/governance/recertification/sweep", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "use-case-recertification", reason: "the job runs runUseCaseRecertificationSweep, as this door does" }],
  ["POST /v1/risks/:riskId/accept", { replacement: "POST /v1/risks/:riskId/acceptances", reason: "ADR-0180 §6: /accept is a wrapper over the acceptance write path the panel calls" }],
]);

/**
 * INDIRECT UI CALLS: the SPA calls the route, but through a value no static
 * scan can follow. `evidence` (the call) must still appear in `file`, AND the
 * route's own path must still be written as a literal in `pathIn` (default
 * `file`), so one shared call text cannot keep a removed button's entry alive.
 */
export const INDIRECT_UI_CALLS = new Map([
  ...[
    "POST /v1/infra/findings/:findingId/remediate",
    "POST /v1/infra/certs/:certId/rotate",
    "POST /v1/infra/patches/:patchId/apply",
    "POST /v1/infra/backups/:backupId/restore",
  ].map((r) => [
    r,
    {
      file: "apps/web/src/views/admin/compliance/InfrastructurePage.tsx",
      evidence: "api.post(pr.url",
      reason: "propose(…) keeps the path in state; the confirm dialog posts it",
    },
  ]),
  // ADR-0219: the shared list control downloads the Excel file from the path its page hands it (`exportPath`)
  ...[
    ["GET /v1/runs/export.xlsx", "apps/web/src/views/runs/RunsPage.tsx"],
    ["GET /v1/incidents/export.xlsx", "apps/web/src/views/incidents/IncidentsPage.tsx"],
    ["GET /v1/users/export.xlsx", "apps/web/src/views/admin/identity/UsersPage.tsx"],
  ].map(([r, page]) => [
    r,
    {
      file: "apps/web/src/ui/DataList.tsx",
      evidence: "exportUrl(props.exportPath",
      pathIn: page,
      reason: "the page passes the export path to DataList, whose Download Excel button fetches it",
    },
  ]),
  [
    "GET /v1/decisions/:auditId/bom/bundle",
    {
      file: "apps/web/src/views/admin/governance/bomB4Api.ts",
      evidence: "api.getBlob(view.bundleHref",
      pathIn: "apps/web/src/views/admin/governance/bomModel.ts",
      reason: "the Decision BOM names its bundle href; bomModel.ts checks it equals this route, then the download fetches it",
    },
  ],
]);

/**
 * KNOWN UI GAPS — TEMPORARY. A real capability with no screen yet: listed so
 * CI stays green while the UI work is scheduled, NEVER as an exemption. Each
 * entry says what the route does (so the screen can be designed) and a
 * tracking note. Closing one means building the screen; this run then fails
 * until the entry is deleted, and KNOWN_UI_GAPS_MAX is lowered to match.
 */
export const KNOWN_UI_GAPS = new Map([
  // empty: batch U4 (ui-gaps-details) closed the last 22. A new entry needs a reason and raises nothing:
  // KNOWN_UI_GAPS_MAX stays 0, so build the screen instead.
]);

/**
 * The ratchet. Equal to KNOWN_UI_GAPS.size, always: the run fails when the
 * list is longer (a new gap) AND when it is shorter (lower this to match), so
 * the number only ever goes down. The census test pins an upper bound too, so
 * raising it is a visible two-file diff.
 */
export const KNOWN_UI_GAPS_MAX = 0;

const VERB_KEY = { GET: "get", POST: "post", PUT: "put", PATCH: "patch", DELETE: "del" };

/** `ROUTE_STABILITY`'s keys, as `{ method, path }` (the registry the live-inventory test holds exact) */
export function registryRoutes(registrySrc) {
  const start = registrySrc.indexOf("export const ROUTE_STABILITY");
  if (start === -1) throw new Error("openapi-registry.ts: ROUTE_STABILITY not found");
  const end = registrySrc.indexOf("\n};", start);
  const out = [];
  for (const line of registrySrc.slice(start, end).split("\n")) {
    const m = /^\s{0,8}"(GET|POST|PUT|PATCH|DELETE) (\/[^"\s]{0,300})":/.exec(line);
    if (m) out.push({ method: m[1], path: m[2] });
  }
  return out;
}

/** a list key split into method and path */
const parseKey = (key) => {
  const sp = key.indexOf(" ");
  return { method: key.slice(0, sp), path: key.slice(sp + 1) };
};

/** null when a MACHINE_ONLY key is acceptable, else why not */
export function validatePattern(key) {
  const { method, path: p } = parseKey(key);
  if (method !== "*" && !VERB_KEY[method]) return `unknown verb '${method}'`;
  if (!p.startsWith("/")) return "path must start with /";
  if (p.includes("*") && !p.endsWith("/*")) return "a wildcard may only end the path, as /*";
  if (p.endsWith("/*")) {
    const segs = p.slice(1, -2).split("/").filter(Boolean);
    if (segs.length === 0) return "a blanket /* covers every route";
    if (segs[0] === "v1" && segs.length < 2) return "a blanket /v1/* covers the whole API; name the collection";
    if (segs.slice(0, segs[0] === "v1" ? 2 : 1).some((s) => s.startsWith(":"))) return "a pattern's collection must be literal";
  }
  return null;
}

/** where the scheduler job names a SUPERSEDED `job` must appear live */
const SCHEDULER_JOBS_FILE = "apps/gateway/src/scheduler-jobs.ts";

/**
 * The job names `SCHEDULER_JOB_NAMES` defines in scheduler-jobs.ts: its `key: "name"` entries, read with comments
 * removed. A real match, not a substring search: a name only in a comment, or in a string outside the constant, is
 * not a job. Null when the file or the constant is missing (every superseded `job` is then stale).
 */
export function schedulerJobNames(text) {
  if (typeof text !== "string") return null;
  const block = /export const SCHEDULER_JOB_NAMES = \{([\s\S]*?)\n\} as const;/.exec(text);
  if (!block) return null;
  const body = block[1].replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const names = new Set();
  for (const m of body.matchAll(/^\s*[A-Za-z_$][\w$]*\s*:\s*"([^"\n]+)"\s*,?\s*$/gm)) names.add(m[1]);
  return names;
}

/** is a MACHINE_ONLY key a prefix pattern (rather than one exact route)? */
const isPattern = (key) => key.endsWith("/*");

/** does a list key (exact or pattern) cover the route? */
export function keyCovers(key, route) {
  const { method, path: p } = parseKey(key);
  if (method !== "*" && method !== route.method) return false;
  if (!p.endsWith("/*")) return p === route.path;
  const prefix = p.slice(0, -1); // keeps the trailing slash
  return route.path.startsWith(prefix) && route.path.length > prefix.length;
}

/**
 * Which routes the UI reaches. Segment-wise like the affordance census (`:x`
 * on either side, never in the collection segment), plus one tightening the
 * all-verb census needs: a call reaches only the BEST-FITTING routes (most
 * segments equal). So `/v1/agents/${id}` reaches `/v1/agents/:agentId`, not
 * its literal sibling `/v1/agents/discover`; and `/v1/receipts/status`
 * reaches that route, not `/v1/receipts/:auditId`. Only when nothing fits
 * better does a parameter stand in for a literal (`/v1/users/me/agents`
 * reaching `/v1/users/:userId/agents`, or a helper building a segment from a
 * variable).
 */
export function reachedRoutes(routes, ui) {
  const reached = new Set();
  const byVerb = new Map();
  for (const r of routes) {
    const v = VERB_KEY[r.method];
    if (!byVerb.has(v)) byVerb.set(v, []);
    byVerb.get(v).push({ route: r, n: norm(r.path) });
  }
  for (const [verb, uiPaths] of Object.entries(ui)) {
    const candidates = byVerb.get(verb) ?? [];
    for (const u of uiPaths) {
      const matches = candidates.filter((c) => segmentMatch(c.n, new Set([u])));
      // positions where route and call agree exactly (literal = literal, parameter = parameter)
      const b = u.split("/");
      const score = (c) => c.n.split("/").filter((seg, i) => seg === b[i]).length;
      const best = Math.max(...matches.map(score));
      for (const c of matches) if (score(c) === best) reached.add(`${c.route.method} ${c.route.path}`);
    }
  }
  return reached;
}

/**
 * The census over plain data, so a test can drive it. Returns the counts and
 * every failure as `{ kind, key, detail }`.
 */
export function census({
  routes,
  ui,
  notBuilt = new Set(),
  fileText = () => null,
  machineOnly = MACHINE_ONLY,
  superseded = SUPERSEDED,
  indirect = INDIRECT_UI_CALLS,
  knownGaps = KNOWN_UI_GAPS,
  knownGapsMax = KNOWN_UI_GAPS_MAX,
}) {
  const failures = [];
  const fail = (kind, key, detail) => failures.push({ kind, key, detail });
  const keyOf = (r) => `${r.method} ${r.path}`;
  const all = new Set(routes.map(keyOf));
  const reached = reachedRoutes(routes, ui);
  const isStub = (r) => notBuilt.has(`${r.method} ${norm(r.path)}`);

  for (const key of machineOnly.keys()) {
    const bad = validatePattern(key);
    if (bad) fail("bad-pattern", key, bad);
  }
  const lists = [
    ["superseded", superseded],
    ["indirect", indirect],
    ["known-gap", knownGaps],
  ];
  for (const [name, list] of lists) {
    for (const key of list.keys()) {
      if (!all.has(key)) fail("stale", key, `listed as ${name} but the gateway serves no such route`);
    }
  }
  for (const [key, entry] of machineOnly) {
    const covered = routes.filter((r) => keyCovers(key, r)).length;
    if (covered === 0) fail("stale", key, "machine-only entry covers no route the gateway serves");
    else if (isPattern(key) && entry?.matches !== covered) {
      fail("pattern-count", key, `the pattern covers ${covered} routes but pins ${entry?.matches}: a route was added or removed under it; review it, then update \`matches\``);
    }
  }

  const counts = { total: routes.length, ui: 0, stubs: 0, machineOnly: 0, superseded: 0, indirect: 0, knownGaps: 0, gaps: 0 };
  const byCategory = new Map();
  for (const r of routes) {
    const key = keyOf(r);
    const listedAs = [];
    const machine = [...machineOnly.keys()].filter((k) => keyCovers(k, r));
    if (machine.length > 0) listedAs.push("machine-only");
    for (const [name, list] of lists) if (list.has(key)) listedAs.push(name);
    if (listedAs.length > 1) fail("double-listed", key, `listed as ${listedAs.join(" and ")}; pick one`);

    if (isStub(r)) {
      counts.stubs += 1;
      if (listedAs.length > 0) fail("stale", key, `listed as ${listedAs[0]} but it is a 501 notBuilt stub, which the census already skips`);
      continue;
    }
    if (reached.has(key)) {
      counts.ui += 1;
      if (listedAs.length > 0) {
        const where = machine.length > 0 ? `machine-only (${machine[0]})` : listedAs[0];
        fail("stale", key, `the UI calls it, but it is listed as ${where}; delete or narrow the entry`);
      }
      continue;
    }
    if (machine.length > 0) {
      counts.machineOnly += 1;
      byCategory.set(machine[0], (byCategory.get(machine[0]) ?? 0) + 1);
      continue;
    }
    if (superseded.has(key)) {
      counts.superseded += 1;
      const { replacement, job } = superseded.get(key);
      if (!all.has(replacement)) fail("stale", key, `superseded by ${replacement}, which the gateway does not serve`);
      else if (!reached.has(replacement)) fail("stale", key, `superseded by ${replacement}, which the UI does not call either`);
      if (job !== undefined && !(schedulerJobNames(fileText(SCHEDULER_JOBS_FILE))?.has(job) ?? false)) {
        fail("stale", key, `superseded by scheduler job '${job}', which ${SCHEDULER_JOBS_FILE} no longer names`);
      }
      continue;
    }
    if (indirect.has(key)) {
      counts.indirect += 1;
      const { file, evidence, pathIn = file } = indirect.get(key);
      const text = fileText(file);
      const pathText = fileText(pathIn);
      if (text === null) fail("stale", key, `indirect-call evidence file ${file} does not exist`);
      else if (!text.includes(evidence)) fail("stale", key, `indirect-call evidence '${evidence}' is no longer in ${file}`);
      else if (pathText === null || !segmentMatch(norm(r.path), literalPathsIn(pathText, pathIn))) {
        fail("stale", key, `the route's own path is no longer written in ${pathIn}`);
      }
      continue;
    }
    if (knownGaps.has(key)) {
      counts.knownGaps += 1;
      continue;
    }
    counts.gaps += 1;
    fail("no-ui", key, "no screen calls it and no list explains why");
  }

  if (knownGaps.size > knownGapsMax) {
    fail("gap-ratchet", "KNOWN_UI_GAPS", `${knownGaps.size} entries but KNOWN_UI_GAPS_MAX is ${knownGapsMax}: build the screen instead of listing a new gap`);
  } else if (knownGaps.size < knownGapsMax) {
    fail("gap-ratchet", "KNOWN_UI_GAPS_MAX", `the list has ${knownGaps.size} entries: lower KNOWN_UI_GAPS_MAX (and the test's bound) to ${knownGaps.size}`);
  }
  for (const [key, entry] of knownGaps) {
    if (!entry?.does || !entry?.tracking) fail("bad-entry", key, "a known gap needs `does` and `tracking`");
  }
  for (const [key, entry] of superseded) {
    if (!entry?.replacement || !entry?.reason) fail("bad-entry", key, "a superseded entry needs `replacement` and `reason`");
  }
  for (const [key, entry] of machineOnly) {
    const reason = typeof entry === "string" ? entry : entry?.reason;
    if (typeof reason !== "string" || reason.length < 12) fail("bad-entry", key, "a machine-only entry needs a reason a reviewer can check");
    if (isPattern(key) && !Number.isInteger(entry?.matches)) fail("bad-entry", key, "a pattern entry pins `matches`, the number of routes it covers");
  }
  return { counts, byCategory, failures };
}

function main() {
  const routes = registryRoutes(readFileSync(path.join(root, "apps/gateway/src/openapi-registry.ts"), "utf8"));
  if (routes.length < 100) {
    console.error(`preflight-ui-route-census: read only ${routes.length} routes from openapi-registry.ts — the scan is broken, not the app`);
    return 2;
  }
  const ui = scanWeb(path.join(root, "apps/web/src"));
  const notBuilt = scanNotBuilt(path.join(root, "apps/gateway/src"));
  const fileText = (rel) => {
    try {
      return readFileSync(path.join(root, rel), "utf8");
    } catch {
      return null;
    }
  };
  const { counts, byCategory, failures } = census({ routes, ui, notBuilt, fileText });

  console.log(
    `route census: ${counts.total} routes — ${counts.ui} called by the UI, ${counts.machineOnly} machine-only, ` +
      `${counts.superseded} superseded, ${counts.indirect} indirect, ${counts.stubs} 501 stubs, ` +
      `${counts.knownGaps} KNOWN UI GAPS, ${counts.gaps} unexplained`,
  );
  for (const [k, n] of [...byCategory].sort()) console.log(`  machine-only ${String(n).padStart(3)}  ${k}`);

  if (KNOWN_UI_GAPS.size > 0) {
    console.log("");
    console.log("!!".repeat(36));
    console.log(`!! ${KNOWN_UI_GAPS.size} KNOWN UI GAPS — built capabilities with no screen yet (temporary; the count may only go down)`);
    for (const [key, g] of KNOWN_UI_GAPS) console.log(`!!   ${key.padEnd(44)} ${g.does}  [${g.tracking}]`);
    console.log("!!".repeat(36));
  }

  if (failures.length > 0) {
    console.error("");
    for (const f of failures) console.error(`  ${f.kind.toUpperCase().padEnd(14)} ${f.key} — ${f.detail}`);
    console.error(
      "\nA route nothing on screen calls is a capability a user cannot use. Build the\n" +
        "screen, or, if no human should ever call it, add it to MACHINE_ONLY in\n" +
        "scripts/preflight-ui-route-census.mjs with a reason somebody can check.",
    );
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    process.exit(main());
  } catch (e) {
    console.error("preflight-ui-route-census could not run:", e);
    process.exit(2);
  }
}
