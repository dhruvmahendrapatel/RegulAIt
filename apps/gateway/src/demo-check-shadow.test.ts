/**
 * ADR-0197 decision 7 (review M1, L2) — `checkShadowDiscovery` FAILs when a dataset step silently produced nothing.
 * Driven by stub API answers shaped like a fully seeded database (no Postgres): the full set passes every beat, and
 * each mutation below — one broken step — turns its beat to FAIL. The DB-backed demo-shadow-seed.test.ts pins the
 * same beats PASS on a real seeded database.
 */
import { describe, expect, it } from "vitest";
import { DEMO_SHADOW_DISCOVERY as D } from "@regulait/shared";
import { checkShadowDiscovery, demoShadowNeverStored, leakedShadowNames, SHADOW_DISCOVERY_BEATS } from "./demo-check-lib.js";
import { DEMO_SECURITY_LEAD } from "./demo-identity.js";

type Json = Record<string, any>;

const ADA = "00000000-0000-4000-8000-0000000000ad";
const MORGAN = "00000000-0000-4000-8000-0000000000a0";
const AVERY = "00000000-0000-4000-8000-0000000000a1";
const LIBRARY = "00000000-0000-4000-8000-0000000000c1";
const INSTANCE = "00000000-0000-4000-8000-0000000000f1";
const sourceIds = { gitlab: "s-gitlab", aws: "s-aws", azure: "s-azure", inventory: "s-mdm", agent: "s-agent" } as const;

/** what the API answers on a fully seeded database */
function world() {
  const sources = (Object.keys(sourceIds) as Array<keyof typeof sourceIds>).map((k) => ({ id: sourceIds[k], name: D[k].name, enabled: true }));
  const runs: Record<string, Json[]> = {
    [sourceIds.gitlab]: [{ status: "succeeded", matched: 6 }],
    [sourceIds.aws]: [{ status: "succeeded", matched: 3 }],
    [sourceIds.azure]: [{ status: "succeeded", matched: 2 }],
    [sourceIds.inventory]: [{ status: "succeeded", matched: 3 }],
    [sourceIds.agent]: [],
  };
  const findings: Json[] = [
    ...D.gitlab.repos.map((r, i) => ({ id: `f-repo-${i}`, subjectKind: "repo", subject: `gitlab:${r.fullName}`, signalSources: ["repo_scan"], observationCount: 3, signatures: i === 0 ? ["env.anthropic.api-key"] : [] })),
    ...[...D.aws.observations, ...D.azure.observations]
      .filter((o) => o.subjectKind === "cloud_resource")
      .map((o, i) => ({ id: `f-cloud-${i}`, subjectKind: "cloud_resource", subject: o.subject, signalSources: [o.signalSource], observationCount: 1 })),
    { id: "f-principal", subjectKind: "cloud_principal", subject: "pseud:3f9a", signalSources: ["cloud_audit_log"], observationCount: 412 },
    ...["com.openai.chat", "com.anthropic.claudefordesktop", "com.todesktop.230313mzl4w4u92"].map((v, i) => ({
      id: `f-mdm-${i}`,
      subjectKind: "endpoint_app",
      subject: v,
      signalSources: i === 1 ? ["endpoint_inventory", "endpoint_agent"] : ["endpoint_inventory"],
      observationCount: 1,
    })),
    { id: "f-cli", subjectKind: "endpoint_app", subject: "claude", signalSources: ["endpoint_agent"], signatures: ["cli.anthropic.claude"], observationCount: 1 },
  ];
  return {
    sources,
    runs,
    findings,
    devices: [{ id: "d1", devicePseudonym: "dev:7c1e", userPseudonym: "usr:41aa", lastReportAt: "2026-10-18T10:00:00Z", revokedAt: null }] as Json[],
    keys: [{ kid: "k1", state: "pending" }] as Json[],
    users: [
      { id: ADA, email: "admin@regulait.local", isAdmin: true, totpEnabled: true, disabledAt: null },
      { id: MORGAN, email: DEMO_SECURITY_LEAD.email, isAdmin: true, totpEnabled: true, disabledAt: null },
      { id: AVERY, email: "avery@regulait.local", isAdmin: false, totpEnabled: false, disabledAt: null },
    ] as Json[],
    link: { instanceId: INSTANCE, status: "blocked_on_approval", replaceable: false } as Json,
    instance: { id: INSTANCE, initiatorUserId: ADA } as Json,
    pending: [{ approverUserId: MORGAN }] as Json[],
    connectors: [{ id: LIBRARY, name: D.contentTrust.connectorName }] as Json[],
    records: [
      ...D.contentTrust.objects.map((_, i) => ({ id: `p${i}`, sourceId: LIBRARY, trustTier: "trusted" })),
      { id: "p-other", sourceId: "00000000-0000-4000-8000-0000000000c2", trustTier: "untrusted" },
    ] as Json[],
  };
}
type World = ReturnType<typeof world>;

function api(w: World) {
  return async (url: string): Promise<{ status: number; body: Json }> => {
    const u = new URL(url, "http://stub");
    const ok = (body: Json) => ({ status: 200, body });
    if (u.pathname === "/v1/discovery/sources") return ok({ sources: w.sources });
    if (u.pathname === "/v1/discovery/runs") return ok({ runs: w.runs[u.searchParams.get("sourceId") ?? ""] ?? [] });
    if (/^\/v1\/discovery\/sources\/[^/]+\/endpoint-devices$/.test(u.pathname)) return ok({ devices: w.devices });
    if (u.pathname === "/v1/discovery/federation") return ok({ enabled: false, issuer: null, keys: w.keys });
    if (u.pathname === "/v1/users") return ok({ users: w.users });
    if (/\/remediation-plan$/.test(u.pathname)) return ok({ currentLink: w.link });
    if (u.pathname === `/v1/workflows/instances/${INSTANCE}`) return ok({ instance: w.instance, pendingApprovals: w.pending });
    if (u.pathname === "/v1/connectors") return ok({ connectors: w.connectors });
    if (u.pathname === "/v1/content-provenance/records") return ok({ records: w.records });
    throw new Error(`unexpected GET ${url}`);
  };
}

async function levels(w: World) {
  const checks = await checkShadowDiscovery(api(w), w.findings, D);
  return Object.fromEntries(checks.map((c) => [c.beat, c.level]));
}

describe("checkShadowDiscovery FAILs a step that silently produced nothing", () => {
  it("the fully seeded answers pass every beat", async () => {
    const got = await levels(world());
    for (const beat of SHADOW_DISCOVERY_BEATS) expect(got[beat], beat).toBe("PASS");
  });

  const breaks: Array<[string, (typeof SHADOW_DISCOVERY_BEATS)[number], (w: World) => void]> = [
    ["the Azure run succeeded with 0 matches", "1 Discovery sources", (w) => void (w.runs[sourceIds.azure] = [{ status: "succeeded", matched: 0 }])],
    ["the GitLab run never ran", "1 Discovery sources", (w) => void (w.runs[sourceIds.gitlab] = [])],
    ["an Azure resource has no finding", "1 Sightings", (w) => void (w.findings = w.findings.filter((f) => !String(f.subject).includes("/deployments/")))],
    ["one recorded repository has no finding", "1 Sightings", (w) => void (w.findings = w.findings.filter((f) => f.id !== "f-repo-1"))],
    ["the AWS principal has no audit-log finding", "1 Sightings", (w) => void (w.findings = w.findings.filter((f) => f.id !== "f-principal"))],
    ["an MDM row has no finding", "1 Sightings", (w) => void (w.findings = w.findings.filter((f) => f.id !== "f-mdm-2"))],
    ["the CLI signature hit is missing", "1 Sightings", (w) => void (w.findings = w.findings.filter((f) => f.id !== "f-cli"))],
    ["a device reports with 0 agent findings", "1 Endpoint agent", (w) => void (w.findings = w.findings.map((f) => ({ ...f, signalSources: f.signalSources.filter((k: string) => k !== "endpoint_agent") })))],
    ["no device enrolled", "1 Endpoint agent", (w) => void (w.devices = [])],
    ["no federation key", "1 Federation", (w) => void (w.keys = [])],
    ["the remediation stopped at plan-only", "1 Remediation plan", (w) => void (w.link = { ...w.link, status: "blocked_on_plan" })],
    ["the sign-off waits on Avery", "1 Remediation plan", (w) => void (w.pending = [{ approverUserId: AVERY }])],
    ["the security lead is missing", "1 Remediation plan", (w) => void (w.users = w.users.filter((u) => u.id !== MORGAN))],
    ["the security lead has no MFA", "1 Remediation plan", (w) => void (w.users = w.users.map((u) => (u.id === MORGAN ? { ...u, totpEnabled: false } : u)))],
    ["the security lead initiated it", "1 Remediation plan", (w) => void (w.instance = { ...w.instance, initiatorUserId: MORGAN })],
    ["one library read left no record", "3 Content trust", (w) => void (w.records = w.records.filter((r) => r.id !== "p0"))],
    ["the library reads are untrusted", "3 Content trust", (w) => void (w.records = w.records.map((r) => ({ ...r, trustTier: "untrusted" })))],
    ["a device row carries the hostname", "1 Data minimisation", (w) => void (w.devices = [{ ...w.devices[0], hostname: D.agent.hostname }])],
    ["a run carries an env-variable name", "1 Data minimisation", (w) => void (w.runs[sourceIds.gitlab] = [{ status: "succeeded", matched: 6, note: "PORT" }])],
  ];
  for (const [what, beat, broken] of breaks) {
    it(`${what} → ${beat} FAILs`, async () => {
      const w = world();
      broken(w);
      expect((await levels(w))[beat]).toBe("FAIL");
    });
  }
});

describe("the data-minimisation scan", () => {
  it("covers env names AND values, devices, device users and the raw principal, not catalogue identifiers", () => {
    const names = demoShadowNeverStored(D);
    for (const n of ["ANTHROPIC_API_KEY", "PORT", "8080", "OPENAI_API_KEY", "QUEUE_URL", D.agent.hostname, D.agent.deviceUser, "ACME-LT-0412", "trading-desk-07"]) {
      expect(names, n).toContain(n);
    }
    expect(names.some((n) => n.startsWith("arn:aws:iam::"))).toBe(true);
    // the CLI's executable and an app's bundle id are the catalogue values the matcher keeps on purpose
    expect(names).not.toContain("claude");
    expect(names).not.toContain("com.openai.chat");
  });

  it("matches a short name only as a whole value, a long one anywhere", () => {
    expect(leakedShadowNames({ a: "REPORT ready" }, ["PORT"])).toEqual([]);
    expect(leakedShadowNames({ a: ["PORT"] }, ["PORT"])).toEqual(["PORT"]);
    expect(leakedShadowNames({ a: { b: "set OPENAI_API_KEY here" } }, ["OPENAI_API_KEY"])).toEqual(["OPENAI_API_KEY"]);
    expect(leakedShadowNames({ OPENAI_API_KEY: 1 }, ["OPENAI_API_KEY"])).toEqual([]);
  });
});
