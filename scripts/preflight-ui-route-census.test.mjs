import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { globalPathDefs, globalWrappers, parse, uiCalls, wrappers } from "./preflight-ui-affordances.mjs";
import {
  INDIRECT_UI_CALLS,
  KNOWN_UI_GAPS,
  KNOWN_UI_GAPS_MAX,
  MACHINE_ONLY,
  SUPERSEDED,
  census,
  keyCovers,
  reachedRoutes,
  registryRoutes,
  schedulerJobNames,
  validatePattern,
} from "./preflight-ui-route-census.mjs";

/** the calls a set of web files makes, as the census sees them */
const scan = (...sources) => {
  const defs = globalPathDefs(sources);
  const wrap = globalWrappers(sources);
  const out = { get: new Set(), post: new Set(), put: new Set(), patch: new Set(), del: new Set() };
  for (const src of sources) {
    const calls = uiCalls(src, defs, wrap);
    for (const v of Object.keys(out)) for (const p of calls[v]) out[v].add(p);
  }
  return out;
};
const sorted = (s) => [...s].sort();
const route = (key) => ({ method: key.slice(0, key.indexOf(" ")), path: key.slice(key.indexOf(" ") + 1) });
const empty = { machineOnly: new Map(), superseded: new Map(), indirect: new Map(), knownGaps: new Map(), knownGapsMax: 0 };

describe("route census matcher: every shape a call is written in", () => {
  it("a type argument with nested generics, and a client call split across lines", () => {
    const src = [
      "api.get<{ views: Array<{ id: string }>; note: Record<string, unknown> }>(",
      '  "/v1/approvals/views",',
      ");",
      "stepUpApi",
      "  .get<{ status: string }>(`/v1/auth/step-up/${id}`)",
    ].join("\n");
    expect(sorted(scan(src).get)).toEqual(["/v1/approvals/views", "/v1/auth/step-up/:x"]);
  });

  it("a query string built in an expression is not a path segment", () => {
    const src = [
      "api.get(`/v1/lineage/nodes${projectId ? `?projectId=${projectId}` : \"\"}`);",
      "api.get(`/v1/audit/events${qs}`);",
      "api.get(`/v1/x/${id}`);",
    ].join("\n");
    expect(sorted(scan(src).get)).toEqual(["/v1/audit/events", "/v1/lineage/nodes", "/v1/x/:x"]);
  });

  it("a call in a comment, or a path in a request body, is not a call", () => {
    const src = [
      "// api.get(\"/v1/commented-out\")",
      "/** api.del(`/v1/in-a-doc-comment/${id}`) */",
      'api.post("/v1/real", { next: "/v1/in-the-body" });',
    ].join("\n");
    const ui = scan(src);
    expect(sorted(ui.get)).toEqual([]);
    expect(sorted(ui.del)).toEqual([]);
    expect(sorted(ui.post)).toEqual(["/v1/real"]);
  });

  it("a builder defined below its use in the same file (a hoisted function) resolves", () => {
    const src = ["api.get(localPath(id));", "function localPath(id: string) {", "  return `/v1/hoisted/${id}`;", "}"].join("\n");
    expect(sorted(scan(src).get)).toEqual(["/v1/hoisted/:x"]);
  });

  it("the /auth surface is a path the SPA calls too", () => {
    expect(sorted(scan('api.post("/auth/login", body);').post)).toEqual(["/auth/login"]);
  });

  it("resolves path builders: a constant, a function, a builder composing another, and a local", () => {
    const model = [
      'export const REQUIRED_TESTS_PATH = "/v1/governance/review-policy/required-tests";',
      "export function runGraphPath(s: Source): string {",
      "  switch (s.kind) {",
      '    case "a":',
      "      return `/v1/run-graph/orchestration/${s.runId}`;",
      "  }",
      "}",
      "export function subjectPath(s: Subject): string {",
      "  return `/v1/ai-bom/${s.kind}/${s.id}`;",
      "}",
    ].join("\n");
    const view = [
      "api.put(REQUIRED_TESTS_PATH, body);",
      "api.get<Graph>(runGraphPath(props.source));",
      "async function create(subject) {",
      "  const path = `${subjectPath(subject)}/snapshots`;",
      "  return api.post(path, {});",
      "}",
    ].join("\n");
    const ui = scan(model, view);
    expect(sorted(ui.put)).toEqual(["/v1/governance/review-policy/required-tests"]);
    expect(sorted(ui.get)).toEqual(["/v1/run-graph/orchestration/:x"]);
    expect(sorted(ui.post)).toEqual(["/v1/ai-bom/:x/:x/snapshots"]);
  });

  it("a literal passed to a call inside a definition does not make it a builder", () => {
    const src = [
      'const q = useQuery({ queryFn: () => api.get("/v1/things") });',
      "api.post(`/v1/other`, { from: q.data });",
    ].join("\n");
    const ui = scan(src);
    expect(sorted(ui.get)).toEqual(["/v1/things"]);
    expect(sorted(ui.post)).toEqual(["/v1/other"]);
  });

  it("infers a wrapper that forwards its own parameter, with the verb it sends", () => {
    const kit = [
      "export async function downloadCsv(",
      "  path: string,",
      "  filename: string,",
      "): Promise<boolean> {",
      '  const res = await fetch(path, { credentials: "include" });',
      "  return res.ok;",
      "}",
    ].join("\n");
    const page = [
      "async function deleteWithBody(path: string, body: unknown) {",
      '  await fetch(path, { method: "DELETE", body: JSON.stringify(body) });',
      "}",
      "void downloadCsv(`/v1/audit.csv${qs}`, \"audit.csv\");",
      "void deleteWithBody(`/v1/teams/${id}`, { force: true });",
    ].join("\n");
    expect([...wrappers(parse(kit), new Map(), true)]).toEqual([["downloadCsv", new Set(["get:0"])]]);
    const ui = scan(kit, page);
    expect(sorted(ui.get)).toEqual(["/v1/audit.csv"]);
    expect(sorted(ui.del)).toEqual(["/v1/teams/:x"]);
  });

  it("a wrapper is inferred only when the WHOLE first argument is its parameter, and a variable method names no verb", () => {
    const src = [
      "export function Panel(props: { url: string }) { return api.get(props.url); }",
      "export async function request(method: string, path: string) { return fetch(path, { method, credentials: \"include\" }); }",
      'Panel({ url: "/v1/a" }); request("POST", "/v1/b");',
    ].join("\n");
    const ui = scan(src);
    expect(sorted(ui.get)).toEqual([]);
    expect(sorted(ui.post)).toEqual([]);
  });

  it("counts an XMLHttpRequest upload, a link, and a window.open", () => {
    const src = [
      'export const uploadPath = (name: string) => `/v1/model-artifacts?filename=${name}`;',
      "const path = uploadPath(file.name);",
      'xhr.open("POST", path);',
      "<a href={`/v1/reports/runs/${id}/export?format=csv`}>CSV</a>",
      'window.open(`/v1/projects/${id}/costs.csv`, "_blank");',
    ].join("\n");
    const ui = scan(src);
    expect(sorted(ui.post)).toEqual(["/v1/model-artifacts"]);
    expect(sorted(ui.get)).toEqual(["/v1/projects/:x/costs.csv", "/v1/reports/runs/:x/export"]);
  });
});

describe("route census: a call reaches the best-fitting route only", () => {
  const routes = ["GET /v1/agents/:agentId", "GET /v1/agents/discover", "GET /v1/receipts/status", "GET /v1/receipts/:auditId", "GET /v1/users/:userId/agents"].map(route);

  it("a parameter reaches the parameter route, not its literal sibling", () => {
    expect(sorted(reachedRoutes(routes, { get: new Set(["/v1/agents/:x"]) }))).toEqual(["GET /v1/agents/:agentId"]);
  });

  it("a literal reaches the literal route, not the parameter sibling", () => {
    expect(sorted(reachedRoutes(routes, { get: new Set(["/v1/receipts/status"]) }))).toEqual(["GET /v1/receipts/status"]);
  });

  it("a literal still fills a parameter when nothing fits better (`/v1/users/me/agents`)", () => {
    expect(sorted(reachedRoutes(routes, { get: new Set(["/v1/users/me/agents"]) }))).toEqual(["GET /v1/users/:userId/agents"]);
  });

  it("a verb is never another verb's evidence", () => {
    expect(sorted(reachedRoutes(routes, { post: new Set(["/v1/agents/:x"]) }))).toEqual([]);
  });
});

describe("route census: allow-list patterns", () => {
  it("rejects blankets and parameter collections, accepts a named collection", () => {
    expect(validatePattern("* /v1/*")).toMatch(/blanket/);
    expect(validatePattern("GET /*")).toMatch(/blanket/);
    expect(validatePattern("* /v1/:kind/*")).toMatch(/literal/);
    expect(validatePattern("GET /v1/a*")).toMatch(/only end/);
    expect(validatePattern("FETCH /v1/a")).toMatch(/verb/);
    expect(validatePattern("* /v1/engine-runner/*")).toBeNull();
    expect(validatePattern("POST /v1/chatops/:connectionName/*")).toBeNull();
    expect(validatePattern("GET /health")).toBeNull();
  });

  it("a pattern covers what is under its prefix, for its verb; an exact key covers exactly", () => {
    expect(keyCovers("* /v1/engine-runner/*", route("POST /v1/engine-runner/lease"))).toBe(true);
    expect(keyCovers("* /v1/engine-runner/*", route("GET /v1/engine-runners"))).toBe(false);
    expect(keyCovers("GET /ui/*", route("POST /ui/x"))).toBe(false);
    expect(keyCovers("GET /health", route("GET /health"))).toBe(true);
    expect(keyCovers("GET /health", route("GET /health/x"))).toBe(false);
  });

  it("every real MACHINE_ONLY entry is a valid pattern with a reason", () => {
    for (const [key, entry] of MACHINE_ONLY) {
      expect(validatePattern(key), key).toBeNull();
      const reason = typeof entry === "string" ? entry : entry.reason;
      expect(reason.length, key).toBeGreaterThan(12);
      if (key.endsWith("/*")) expect(Number.isInteger(entry.matches), key).toBe(true);
    }
  });

  it("a pattern pins how many routes it covers: a new route under the prefix fails the run", () => {
    const routes = [route("POST /v1/engine-runner/lease"), route("POST /v1/engine-runner/register")];
    const machineOnly = new Map([["* /v1/engine-runner/*", { reason: "runner channel, runner credential only", matches: 2 }]]);
    const ui = { get: new Set(), post: new Set(), put: new Set(), patch: new Set(), del: new Set() };
    expect(census({ routes, ui, ...empty, machineOnly }).failures).toEqual([]);
    const grown = census({ routes: [...routes, route("POST /v1/engine-runner/new-door")], ui, ...empty, machineOnly });
    expect(grown.failures.map((f) => `${f.kind} ${f.key}`)).toEqual(["pattern-count * /v1/engine-runner/*"]);
    const unpinned = census({ routes, ui, ...empty, machineOnly: new Map([["* /v1/engine-runner/*", "runner channel, runner credential only"]]) });
    expect(unpinned.failures.map((f) => f.kind)).toEqual(["pattern-count", "bad-entry"]);
  });
});

describe("route census: the gate", () => {
  const ui = (paths) => ({ get: new Set(), post: new Set(paths), put: new Set(), patch: new Set(), del: new Set() });
  const routes = [route("POST /v1/things"), route("POST /v1/new-capability")];

  it("FAILS on a new route no screen calls, and PASSES once a screen calls it", () => {
    const before = census({ routes, ui: ui(["/v1/things"]), ...empty });
    expect(before.failures).toEqual([{ kind: "no-ui", key: "POST /v1/new-capability", detail: expect.any(String) }]);
    expect(before.counts.gaps).toBe(1);
    const after = census({ routes, ui: ui(["/v1/things", "/v1/new-capability"]), ...empty });
    expect(after.failures).toEqual([]);
    expect(after.counts.ui).toBe(2);
  });

  it("the same new route PASSES when built the way the SPA writes it end to end", () => {
    const page = "export function NewThing() { return <Button onClick={() => api.post(`/v1/new-capability`, {})} />; }";
    expect(census({ routes, ui: { ...scan(page), post: new Set(["/v1/things", ...scan(page).post]) }, ...empty }).failures).toEqual([]);
  });

  it("a machine-only entry, a superseded route, an indirect call or a known gap each explain an uncalled route", () => {
    const r = [route("POST /v1/x/sweep"), route("GET /v1/old"), route("GET /v1/new"), route("POST /v1/held"), route("GET /v1/gap")];
    const out = census({
      routes: r,
      ui: { get: new Set(["/v1/new"]), post: new Set(), put: new Set(), patch: new Set(), del: new Set() },
      fileText: () => 'api.post(pr.url, {}); propose("Hold?", `/v1/held`);',
      machineOnly: new Map([["POST /v1/x/sweep", "cron sweep: run by the scheduler"]]),
      superseded: new Map([["GET /v1/old", { replacement: "GET /v1/new", reason: "the new read" }]]),
      indirect: new Map([["POST /v1/held", { file: "f.tsx", evidence: "api.post(pr.url", reason: "state" }]]),
      knownGaps: new Map([["GET /v1/gap", { does: "a read", tracking: "later" }]]),
      knownGapsMax: 1,
    });
    expect(out.failures).toEqual([]);
    expect(out.counts).toMatchObject({ ui: 1, machineOnly: 1, superseded: 1, indirect: 1, knownGaps: 1, gaps: 0 });
  });
});

describe("route census: lists cannot rot", () => {
  const ui = { get: new Set(["/v1/called"]), post: new Set(), put: new Set(), patch: new Set(), del: new Set() };
  const routes = [route("GET /v1/called"), route("GET /v1/uncalled")];
  const kinds = (out) => out.failures.map((f) => `${f.kind} ${f.key}`).sort();

  it("an entry naming no route is stale, in every list", () => {
    const out = census({
      routes: [route("GET /v1/called")],
      ui,
      machineOnly: new Map([["* /v1/gone/*", { reason: "removed collection, kept by mistake", matches: 0 }]]),
      superseded: new Map([["GET /v1/gone-old", { replacement: "GET /v1/called", reason: "r" }]]),
      indirect: new Map([["POST /v1/gone-held", { file: "f", evidence: "e", reason: "r" }]]),
      knownGaps: new Map([["GET /v1/gone-gap", { does: "d", tracking: "t" }]]),
      knownGapsMax: 1,
    });
    expect(kinds(out)).toEqual(["stale * /v1/gone/*", "stale GET /v1/gone-gap", "stale GET /v1/gone-old", "stale POST /v1/gone-held"]);
  });

  it("a known gap that now has a screen is stale (delete the entry and lower the max)", () => {
    const out = census({ routes, ui, ...empty, knownGaps: new Map([["GET /v1/called", { does: "d", tracking: "t" }], ["GET /v1/uncalled", { does: "d", tracking: "t" }]]), knownGapsMax: 2 });
    expect(kinds(out)).toEqual(["stale GET /v1/called"]);
  });

  it("a machine-only pattern covering a route the UI calls is stale (narrow it)", () => {
    const out = census({ routes, ui, ...empty, machineOnly: new Map([["GET /v1/called", "says machine-only, but a screen calls it"], ["GET /v1/uncalled", "a real machine-only route"]]) });
    expect(kinds(out)).toEqual(["stale GET /v1/called"]);
  });

  it("a superseded route whose replacement the UI does not call is stale", () => {
    const out = census({ routes, ui: { ...ui, get: new Set() }, ...empty, machineOnly: new Map([["GET /v1/called", "machine-only for this test"]]), superseded: new Map([["GET /v1/uncalled", { replacement: "GET /v1/called", reason: "r" }]]) });
    expect(kinds(out)).toEqual(["stale GET /v1/uncalled"]);
  });

  it("an indirect call whose evidence is gone from its file is stale", () => {
    const indirect = new Map([["GET /v1/uncalled", { file: "f.tsx", evidence: "api.get(view.href", reason: "r" }]]);
    expect(kinds(census({ routes, ui, ...empty, indirect, fileText: () => "nothing here" }))).toEqual(["stale GET /v1/uncalled"]);
    expect(kinds(census({ routes, ui, ...empty, indirect, fileText: () => null }))).toEqual(["stale GET /v1/uncalled"]);
    // the shared call text alone does not keep the entry alive: the route's own path must still be written there
    expect(kinds(census({ routes, ui, ...empty, indirect, fileText: () => "x = api.get(view.href, h)" }))).toEqual(["stale GET /v1/uncalled"]);
    expect(kinds(census({ routes, ui, ...empty, indirect, fileText: () => 'x = api.get(view.href, h); const href = "/v1/uncalled";' }))).toEqual([]);
    // `pathIn`: the literal may live in another file (the Decision BOM's model)
    const split = new Map([["GET /v1/uncalled", { file: "a.ts", pathIn: "b.ts", evidence: "api.get(view.href", reason: "r" }]]);
    const files = { "a.ts": "api.get(view.href)", "b.ts": "if (href !== `/v1/uncalled`) fail();" };
    expect(kinds(census({ routes, ui, ...empty, indirect: split, fileText: (f) => files[f] ?? null }))).toEqual([]);
  });

  it("a superseded scheduler door is stale once its job is no longer named in scheduler-jobs.ts", () => {
    const r = [route("POST /v1/x/sweep"), route("POST /v1/scheduler/jobs/:name/run")];
    const u = { get: new Set(), post: new Set(["/v1/scheduler/jobs/:x/run"]), put: new Set(), patch: new Set(), del: new Set() };
    const superseded = new Map([["POST /v1/x/sweep", { replacement: "POST /v1/scheduler/jobs/:name/run", job: "x-sweep", reason: "same function" }]]);
    const jobs = (text) => (f) => (f === "apps/gateway/src/scheduler-jobs.ts" ? text : null);
    const names = (entries) => `export const SCHEDULER_JOB_NAMES = {\n${entries}\n} as const;\n`;
    expect(kinds(census({ routes: r, ui: u, ...empty, superseded, fileText: jobs(names('  xSweep: "x-sweep",')) }))).toEqual([]);
    expect(kinds(census({ routes: r, ui: u, ...empty, superseded, fileText: jobs(names('  ySweep: "y-sweep",')) }))).toEqual(["stale POST /v1/x/sweep"]);
    // a real match: the name in a comment, or in a string outside the constant, is not a job
    expect(kinds(census({ routes: r, ui: u, ...empty, superseded, fileText: jobs(names('  // xSweep: "x-sweep", (removed)\n  ySweep: "y-sweep",')) }))).toEqual(["stale POST /v1/x/sweep"]);
    // a block comment spanning lines hides an entry just as a line comment does
    expect(kinds(census({ routes: r, ui: u, ...empty, superseded, fileText: jobs(names('/*\n  xSweep: "x-sweep",\n*/\n  ySweep: "y-sweep",')) }))).toEqual(["stale POST /v1/x/sweep"]);
    expect(schedulerJobNames(names('/*\n  xSweep: "x-sweep",\n*/\n  ySweep: "y-sweep",'))).toEqual(new Set(["y-sweep"]));
    expect(kinds(census({ routes: r, ui: u, ...empty, superseded, fileText: jobs(`${names('  ySweep: "y-sweep",')}const legacy = "x-sweep";\n`) }))).toEqual(["stale POST /v1/x/sweep"]);
    expect(kinds(census({ routes: r, ui: u, ...empty, superseded, fileText: jobs('xSweep: "x-sweep",') }))).toEqual(["stale POST /v1/x/sweep"]);
  });

  it("schedulerJobNames reads the shipped scheduler-jobs.ts", () => {
    const names = schedulerJobNames(readFileSync(new URL("../apps/gateway/src/scheduler-jobs.ts", import.meta.url), "utf8"));
    expect(names?.has("redteam-sweep")).toBe(true);
    expect(names?.size).toBeGreaterThan(20);
  });

  it("a 501 stub on any list is stale, and a route on two lists is refused", () => {
    const stub = census({ routes, ui, ...empty, notBuilt: new Set(["GET /v1/uncalled"]), knownGaps: new Map([["GET /v1/uncalled", { does: "d", tracking: "t" }]]), knownGapsMax: 1 });
    expect(kinds(stub)).toEqual(["stale GET /v1/uncalled"]);
    const twice = census({ routes, ui, ...empty, machineOnly: new Map([["GET /v1/uncalled", "machine-only for this test"]]), knownGaps: new Map([["GET /v1/uncalled", { does: "d", tracking: "t" }]]), knownGapsMax: 1 });
    expect(kinds(twice)).toContain("double-listed GET /v1/uncalled");
  });
});

describe("route census: KNOWN_UI_GAPS only shrinks", () => {
  const routes = [route("GET /v1/a"), route("GET /v1/b")];
  const ui = { get: new Set(), post: new Set(), put: new Set(), patch: new Set(), del: new Set() };
  const gaps = new Map([["GET /v1/a", { does: "d", tracking: "t" }], ["GET /v1/b", { does: "d", tracking: "t" }]]);
  const ratchet = (out) => out.failures.filter((f) => f.kind === "gap-ratchet");

  it("a gap list longer than the max fails: a new gap is a screen to build, not an entry", () => {
    expect(ratchet(census({ routes, ui, ...empty, knownGaps: gaps, knownGapsMax: 1 }))).toHaveLength(1);
  });

  it("a gap list shorter than the max fails until the max is lowered, so it can never grow back", () => {
    const one = new Map([...gaps].slice(0, 1));
    const out = census({ routes: routes.slice(0, 1), ui, ...empty, knownGaps: one, knownGapsMax: 2 });
    expect(ratchet(out)[0].detail).toMatch(/lower KNOWN_UI_GAPS_MAX/);
    expect(census({ routes: routes.slice(0, 1), ui, ...empty, knownGaps: one, knownGapsMax: 1 }).failures).toEqual([]);
  });

  it("a gap entry needs what it does and a tracking note", () => {
    const out = census({ routes: routes.slice(0, 1), ui, ...empty, knownGaps: new Map([["GET /v1/a", { does: "d" }]]), knownGapsMax: 1 });
    expect(out.failures.map((f) => f.kind)).toEqual(["bad-entry"]);
  });

  // THE PINS. Every list's size is fixed here, so adding an entry anywhere is a
  // deliberate edit to this file too (and both files are CODEOWNERS-reviewed).
  // KNOWN_UI_GAPS_MAX only ever goes DOWN: lower it as gaps close, never raise it.
  it("THE PINNED SIZES: known gaps, machine-only, superseded and indirect entries", () => {
    expect(KNOWN_UI_GAPS_MAX).toBe(0);
    expect(KNOWN_UI_GAPS.size).toBe(KNOWN_UI_GAPS_MAX);
    expect(MACHINE_ONLY.size).toBe(45); // GET /v1/receipts/keys left: the posture page lists the keys to retire them; ADR-0195 SD4b added the endpoint agent channel; SD2b added the federation issuer's discovery document and JWKS; #453 c6508111468 added the MCP Streamable HTTP GET probe (405); ADR-0210 added the OIDC-profile identity assertion issuer's discovery document and JWKS
    expect(SUPERSEDED.size).toBe(14);
    expect(INDIRECT_UI_CALLS.size).toBe(8); // ADR-0226: the three list exports DataList downloads from the path its page passes
    for (const [key, g] of KNOWN_UI_GAPS) {
      expect(g.does, key).toBeTruthy();
      expect(g.tracking, key).toBeTruthy();
    }
  });

  it("the real lists never name one route twice", () => {
    const keys = [...SUPERSEDED.keys(), ...INDIRECT_UI_CALLS.keys(), ...KNOWN_UI_GAPS.keys(), ...MACHINE_ONLY.keys()];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("route census: the route list is the openapi registry", () => {
  it("reads ROUTE_STABILITY's keys and nothing after it", () => {
    const src = [
      "export const ROUTE_STABILITY: Readonly<Record<string, Stability>> = {",
      '  "GET /": "internal",',
      '  // a comment',
      '  "POST /v1/engine-runner/lease": "internal",',
      "};",
      "export const ROUTE_TAGS = {",
      '  "GET /v1/not-a-route": "x",',
      "};",
    ].join("\n");
    expect(registryRoutes(src)).toEqual([
      { method: "GET", path: "/" },
      { method: "POST", path: "/v1/engine-runner/lease" },
    ]);
  });
});
