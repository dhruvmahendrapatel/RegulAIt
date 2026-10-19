/**
 * ADR-0197 addendum decision 3 (owner, 2026-10-19: option A) — `demo:check --live` on the live database, which holds
 * real findings only. Driven by stub API answers (no Postgres): a clean live database passes every live beat, each
 * mutation below — one trace of the fictional dataset, or one broken governance precondition — turns its beat to FAIL,
 * and `runDemoCheck` reports the live beats only with `live` and the seeded-dataset beats only without it. The
 * demo.yml `demo-live` job runs `demo:prepare --live` on an empty database and pins the same beats PASS.
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { DEMO_SHADOW_DISCOVERY as D } from "@regulait/shared";
import { checkLiveDiscovery, fictionalDatasetMarkers, LIVE_DISCOVERY_BEATS, runDemoCheck, SHADOW_DISCOVERY_BEATS } from "./demo-check-lib.js";
import { DEMO_SECURITY_LEAD } from "./demo-identity.js";
import { SHADOW_AI_REMEDIATION_TEMPLATE_NAME, shadowAiRemediationDefinition } from "./shadow-ai-remediation.js";

type Json = Record<string, any>;

const ADA = "00000000-0000-4000-8000-0000000000ad";
const MORGAN = "00000000-0000-4000-8000-0000000000a0";
const AVERY = "00000000-0000-4000-8000-0000000000a1";
const DANA = "00000000-0000-4000-8000-0000000000a2";
const REAL_AGENT = "00000000-0000-4000-8000-0000000000e1";
const REAL_GITLAB = "00000000-0000-4000-8000-0000000000e2";

/** what the API answers on a live database prepared with `demo:prepare --live`, one real source enabled */
function world() {
  return {
    sources: [
      { id: REAL_AGENT, name: "Pilot laptops", kind: "endpoint_agent", enabled: true, target: {}, lastRun: null },
      { id: REAL_GITLAB, name: "GitLab demo group", kind: "repo_gitlab", enabled: false, target: { namespace: "real-group" }, lastRun: { status: "failed", errorCode: "credential_missing" } },
    ] as Json[],
    runs: [{ id: "r1", sourceId: REAL_GITLAB, status: "failed", errorCode: "credential_missing" }] as Json[],
    findings: [{ id: "f1", subjectKind: "repo", subject: "gitlab:real-group/chatbot", signalSources: ["repo_scan"] }] as Json[],
    imports: [] as Json[],
    devices: { [REAL_AGENT]: [{ id: "d1", devicePseudonym: "dev:9a1b", lastReportAt: null, revokedAt: null }] } as Record<string, Json[]>,
    connectors: [{ id: "c1", name: "governed-docs" }] as Json[],
    records: [] as Json[],
    catalogue: { total: 40, enabled: 38 } as Json,
    users: [
      { id: ADA, email: "admin@regulait.local", isAdmin: true, totpEnabled: true, disabledAt: null },
      { id: DANA, email: "dana@regulait.local", isAdmin: false, totpEnabled: false, disabledAt: null },
      { id: AVERY, email: "avery@regulait.local", isAdmin: false, totpEnabled: false, disabledAt: null },
      { id: MORGAN, email: DEMO_SECURITY_LEAD.email, isAdmin: true, totpEnabled: true, disabledAt: null },
    ] as Json[],
    templates: [] as Json[],
    failing: new Set<string>(),
  };
}
type World = ReturnType<typeof world>;

function api(w: World) {
  return async (url: string): Promise<{ status: number; body: Json }> => {
    const u = new URL(url, "http://stub");
    if (w.failing.has(u.pathname)) return { status: 500, body: {} };
    const ok = (body: Json) => ({ status: 200, body });
    if (u.pathname === "/v1/discovery/sources") return ok({ sources: w.sources });
    if (u.pathname === "/v1/discovery/runs") return ok({ runs: w.runs });
    const dev = /^\/v1\/discovery\/sources\/([^/]+)\/endpoint-devices$/.exec(u.pathname);
    if (dev) return ok({ devices: w.devices[dev[1]!] ?? [] });
    if (u.pathname === "/v1/shadow-ai/imports") return ok({ imports: w.imports });
    if (u.pathname === "/v1/shadow-ai/findings") return ok({ findings: w.findings });
    if (u.pathname === "/v1/shadow-ai/catalogue") return ok(w.catalogue);
    if (u.pathname === "/v1/connectors") return ok({ connectors: w.connectors });
    if (u.pathname === "/v1/content-provenance/records") return ok({ records: w.records });
    if (u.pathname === "/v1/users") return ok({ users: w.users });
    if (u.pathname === "/v1/workflows/templates") return ok({ templates: w.templates });
    if (u.pathname === "/v1/inventory/graph") return ok({ nodes: [], summary: { nodes: 0 } });
    return null as never;
  };
}

async function live(w: World) {
  const checks = await checkLiveDiscovery(api(w), w.findings, D);
  return Object.fromEntries(checks.map((c) => [c.beat, c]));
}

describe("checkLiveDiscovery: real findings only, fail closed", () => {
  it("a clean live database passes every live beat, and lists each real source with its last run", async () => {
    const got = await live(world());
    for (const beat of LIVE_DISCOVERY_BEATS) expect(got[beat]?.level, beat).toBe("PASS");
    const sources = got["1 Real discovery sources"]!.detail;
    expect(sources).toContain("1 of 2 real source(s) enabled");
    expect(sources).toContain("endpoint_agent 'Pilot laptops' enabled, never run");
    expect(sources).toContain("repo_gitlab 'GitLab demo group' disabled, last run failed (credential_missing)");
    expect(sources).toContain("never run yet: 'Pilot laptops'");
    expect(got["1 Remediation routing"]!.detail).toContain("installs at the first remediation");
  });

  it("passes with the shipped remediation default installed", async () => {
    const w = world();
    w.templates = [{ id: "t1", name: SHADOW_AI_REMEDIATION_TEMPLATE_NAME, definition: shadowAiRemediationDefinition(), retiredAt: null }];
    expect((await live(w))["1 Remediation routing"]!.level).toBe("PASS");
  });

  it("every marker is specific to the fictional dataset: none is a catalogue value or a generic word", () => {
    const markers = fictionalDatasetMarkers(D);
    expect(markers).toContain(D.company);
    expect(markers).toContain("(demo dataset)");
    expect(markers).toContain(D.aws.accountId);
    for (const m of markers) expect(m.length, m).toBeGreaterThanOrEqual(8);
    for (const generic of ["claude", "openai", "com.openai.chat", "OPENAI_API_KEY", "api.openai.com"]) expect(markers).not.toContain(generic);
  });

  const traces: Array<[string, (w: World) => void]> = [
    ["a source named with the dataset suffix", (w) => void w.sources.push({ id: "s-x", name: `Something${D.sourceSuffix}`, kind: "cloud_aws", enabled: false, target: {} })],
    ["a source named after the demo company", (w) => void w.sources.push({ id: "s-y", name: `${D.company.toUpperCase()} scans`, kind: "repo_gitlab", enabled: false, target: {} })],
    ["a source whose target is the dataset's AWS account", (w) => void w.sources.push({ id: "s-z", name: "aws", kind: "cloud_aws", enabled: true, target: { accountId: D.aws.accountId } })],
    ["the dataset's GitLab source, enabled beside a real one", (w) => void w.sources.push({ id: "s-g", name: D.gitlab.name, kind: "repo_gitlab", enabled: true, target: { namespace: D.gitlab.namespace } })],
    ["a run of the dataset's source", (w) => void w.runs.push({ id: "r-x", sourceId: "s-fake", status: "succeeded", rawOutputSha256: "x", note: D.gitlab.namespace })],
    ["a finding for a recorded repository", (w) => void w.findings.push({ id: "f-x", subject: `gitlab:${D.gitlab.repos[0]!.fullName}`, signalSources: ["repo_scan"] })],
    ["a finding for a recorded Azure resource", (w) => void w.findings.push({ id: "f-y", subject: D.azure.observations[0]!.subject, signalSources: ["cloud_inventory"] })],
    ["the 10-05 synthetic SaaS export", (w) => void w.imports.push({ id: "i-x", kind: "saas_export", source: "demo-intake-seed (synthetic SaaS export)" })],
    ["the dataset's MDM import", (w) => void w.imports.push({ id: "i-y", kind: "mdm_export", source: `${D.inventory.exporter}-export.csv` })],
    ["a device on a real source carrying the dataset's hostname", (w) => void (w.devices[REAL_AGENT] = [{ id: "d2", hostname: D.agent.hostname }])],
    ["the trusted policy library connector", (w) => void w.connectors.push({ id: "c-lib", name: D.contentTrust.connectorName })],
    ["a provenance record of a read of the library", (w) => void w.records.push({ id: "p1", sourceId: "c-lib", trustTier: "trusted", objectRef: D.contentTrust.objects[0], connector: D.contentTrust.connectorName })],
  ];
  for (const [what, broken] of traces) {
    it(`${what} → 1 Fictional dataset FAILs`, async () => {
      const w = world();
      broken(w);
      const c = (await live(w))["1 Fictional dataset"]!;
      expect(c.level).toBe("FAIL");
      expect(c.fix).toContain("demo:prepare --live");
    });
  }

  it("a device of the dataset's own source FAILs even with no marker on the device row", async () => {
    const w = world();
    w.sources.push({ id: "s-agent", name: D.agent.name, kind: "endpoint_agent", enabled: true, target: { fleet: D.agent.fleet } });
    w.devices["s-agent"] = [{ id: "d3", devicePseudonym: "dev:0000" }];
    const c = (await live(w))["1 Fictional dataset"]!;
    expect(c.level).toBe("FAIL");
    expect(c.detail).toContain("1 device(s)");
  });

  for (const path of ["/v1/discovery/runs", "/v1/shadow-ai/imports", "/v1/content-provenance/records"]) {
    it(`an unreadable ${path} FAILs: absence is not proven`, async () => {
      const w = world();
      w.failing.add(path);
      const c = (await live(w))["1 Fictional dataset"]!;
      expect(c.level).toBe("FAIL");
      expect(c.detail).toContain("absence not proven");
    });
  }

  it("an empty signature catalogue FAILs: a real scan would match nothing", async () => {
    const w = world();
    w.catalogue = { total: 0, enabled: 0 };
    expect((await live(w))["1 Signature catalogue"]!.level).toBe("FAIL");
  });

  it("no real source configured FAILs", async () => {
    const w = world();
    w.sources = [];
    const c = (await live(w))["1 Real discovery sources"]!;
    expect(c.level).toBe("FAIL");
    expect(c.detail).toBe("no real discovery source is configured");
  });

  it("only disabled real sources FAIL, and only the dataset's sources enabled do not count as real", async () => {
    const w = world();
    w.sources = w.sources.map((s) => ({ ...s, enabled: false }));
    w.sources.push({ id: "s-g", name: D.gitlab.name, kind: "repo_gitlab", enabled: true, target: {} });
    expect((await live(w))["1 Real discovery sources"]!.level).toBe("FAIL");
  });

  const routing: Array<[string, (w: World) => void, string]> = [
    ["the security lead is missing", (w) => void (w.users = w.users.filter((u) => u.id !== MORGAN)), "empty database"],
    ["the security lead is not an admin", (w) => void (w.users = w.users.map((u) => (u.id === MORGAN ? { ...u, isAdmin: false } : u))), "empty database"],
    ["the security lead is deactivated", (w) => void (w.users = w.users.map((u) => (u.id === MORGAN ? { ...u, disabledAt: "2026-10-19T09:00:00Z" } : u))), "empty database"],
    ["a third admin would share the sign-off", (w) => void (w.users = w.users.map((u) => (u.id === AVERY ? { ...u, isAdmin: true } : u))), "extra admin"],
    ["the security lead has no TOTP", (w) => void (w.users = w.users.map((u) => (u.id === MORGAN ? { ...u, totpEnabled: false } : u))), "enrols her authenticator"],
    ["the default template is retired", (w) => void (w.templates = [{ name: SHADOW_AI_REMEDIATION_TEMPLATE_NAME, definition: shadowAiRemediationDefinition(), retiredAt: "2026-10-19T09:00:00Z" }]), "route the change type"],
    [
      "the template's sign-off names a fixed approver",
      (w) =>
        void (w.templates = [
          { name: SHADOW_AI_REMEDIATION_TEMPLATE_NAME, retiredAt: null, definition: { stages: [{ id: "signoff", type: "human_approval", approvers: [AVERY] }] } },
        ]),
      "rebuild",
    ],
  ];
  for (const [what, broken, hint] of routing) {
    it(`${what} → 1 Remediation routing FAILs`, async () => {
      const w = world();
      broken(w);
      const c = (await live(w))["1 Remediation routing"]!;
      expect(c.level).toBe("FAIL");
      expect(c.fix).toContain(hint);
    });
  }
});

/** a stand-in for the app: GETs answer from the world, everything else 200 {} */
function fakeApp(w: World): FastifyInstance {
  const get = api(w);
  return {
    inject: async (o: { method: string; url: string }) => {
      const r = o.method === "GET" ? ((await get(o.url)) ?? { status: 200, body: {} }) : { status: 200, body: {} };
      return { statusCode: r.status, json: () => r.body };
    },
  } as unknown as FastifyInstance;
}

describe("runDemoCheck: the two modes", () => {
  const beats = async (w: World, live: boolean) => new Set((await runDemoCheck(fakeApp(w), { bootstrapToken: "t", fixtures: null, live })).map((c) => c.beat));

  it("--live reports the live beats in place of the seeded-dataset beats", async () => {
    const got = await beats(world(), true);
    for (const b of LIVE_DISCOVERY_BEATS) expect(got.has(b), b).toBe(true);
    for (const b of SHADOW_DISCOVERY_BEATS) expect(got.has(b), b).toBe(false);
    expect(got.has("1 Shadow AI")).toBe(false);
    // the governance beats stay
    for (const b of ["0 Personas", "2 Register", "2 Approval gate", "3 Accountability", "3 Evidence"]) expect(got.has(b), b).toBe(true);
  });

  it("--live before the first scan: zero findings is not a FAIL of its own", async () => {
    const w = world();
    w.findings = [];
    const checks = await runDemoCheck(fakeApp(w), { bootstrapToken: "t", fixtures: null, live: true });
    expect(checks.filter((c) => c.beat.startsWith("1 ") && c.level === "FAIL")).toEqual([]);
  });

  it("without --live the seeded-dataset beats run and the live beats do not", async () => {
    const got = await beats(world(), false);
    // "1 Endpoint agent" is reported only once the dataset's agent source exists
    for (const b of SHADOW_DISCOVERY_BEATS.filter((x) => x !== "1 Endpoint agent")) expect(got.has(b), b).toBe(true);
    for (const b of LIVE_DISCOVERY_BEATS) expect(got.has(b), b).toBe(false);
  });

  it("--live pointed at a fallback database (the dataset's sources) FAILs", async () => {
    const w = world();
    w.sources.push(...(["gitlab", "aws", "azure", "inventory", "agent"] as const).map((k) => ({ id: `s-${k}`, name: D[k].name, kind: "x", enabled: true, target: {} })));
    const checks = await runDemoCheck(fakeApp(w), { bootstrapToken: "t", fixtures: null, live: true });
    expect(checks.find((c) => c.beat === "1 Fictional dataset")?.level).toBe("FAIL");
  });
});
