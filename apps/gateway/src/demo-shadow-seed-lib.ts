/**
 * ADR-0197 decision 7 — the FALLBACK Shadow-AI discovery dataset, loaded THROUGH THE REAL APIS so a fresh demo
 * database shows the discovery story even when no live scan can run: discovery sources of four families, their
 * sightings as findings, one enrolled endpoint device, one remediation plan waiting on its sign-off, and content
 * provenance records with trust tiers. The data is `DEMO_SHADOW_DISCOVERY` (`@regulait/shared`), fictional throughout.
 *
 * TWO PHASES, because of who may step up (B4S-06, ADR-0181 FX2):
 *  - `seedShadowSetup` runs BEFORE `seed`, in first-admin setup: enabling a source, storing the GitLab source's static
 *    credential and raising a connector's trust tier are each a `settings_relax` step-up, which the bootstrap
 *    credential passes only while no admin can step up. After `seed`, Ada's authenticator secret has been shown once
 *    and is not the tooling's to keep, and an API key never steps up, so these acts happen here, through the real
 *    routes and their real step-up check (audited `stepUp: bootstrap`), exactly like the seed's demo egress entry.
 *    Every source is created disabled and enabled by the enable route; nothing is written around it.
 *  - `seedShadowStory` runs after `demo:intake`, as the personas: the remediation workflow and the provenance reads.
 *    It also repairs, without any step-up, discovery data a first run left incomplete.
 *
 * WHY RECORDED RUNS (the brief's choice, stated). GitLab, AWS and Azure need the network and real accounts, which the
 * fallback must not depend on. Their runs go through SD0's real worker (`runDiscoveryPass`: lease, observation checks,
 * catalogue match, pseudonymisation, fenced commit, audit) with the worker's existing scanner-registry seam:
 *  - GitLab runs the PRODUCTION SD1 scanner (`repoScanner`) over its own `resolveReader` seam, a read-only reader that
 *    serves the recorded repository files, so the findings are what the real analyser makes of them;
 *  - AWS and Azure replay the cloud adapters' recorded observations, mapped by the production `toScanObservation`.
 * Only the demo dataset's own sources are recorded; a run of any other source the pass claims runs its production
 * scanner as the gateway's own worker would. Each recorded run says so in its read outcomes, and its source has the
 * longest schedule (30 days), so the live worker does not re-scan the fake account before the demo. The MDM export
 * goes through SD3's import route and the endpoint device through SD4b's enrolment, registration and signed report:
 * those paths need no network, so nothing about them is recorded.
 *
 * Idempotent by name: a re-run creates nothing that exists. It never throws on one bad item; each failure is in the
 * report with the API's own error. Personas' keys are revoked when the run ends, however it ends.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { and, contentProvenanceRecords, eq, type Db } from "@regulait/db";
import { DISCOVERY_SCHEDULE_MAX_SECONDS, type DemoShadowDiscoveryDataset } from "@regulait/shared";
import type { RepoReader, RepoTree } from "@regulait/git-provider";
import { DISCOVERY_SCANNERS, scannerRegistry, type Scanner, type ScanResult } from "./discovery-scanners.js";
import { repoScanner } from "./discovery-repo-scanner.js";
import { toReadOutcomes, toScanObservation } from "./discovery-cloud-scanners.js";
import { runDiscoveryPass } from "./discovery-worker.js";
import { SHADOW_AI_REMEDIATION_CHANGE_TYPE, SHADOW_AI_REMEDIATION_TEMPLATE_NAME } from "./shadow-ai-remediation.js";
import { contentDigestOf, ENDPOINT_AGENT_PATHS, ENDPOINT_REPORT_SCHEMA } from "./endpoint-agent.js";
import { DEMO_SCRIPT_KEY_TTL_DAYS, DEMO_SECURITY_LEAD, demoKeyExpiresAt, enrolAdminTotp, revokeScriptKeys } from "./demo-identity.js";

type Json = Record<string, any>;
type Headers = Record<string, string>;

export interface ShadowSeedReport {
  created: string[];
  skipped: string[];
  failed: string[];
  notes: string[];
}

export interface ShadowSeedOptions {
  bootstrapToken: string;
  dataKey?: string | undefined;
}

/** what every recorded run says it read, so no screen presents a replay as a live scan */
export const RECORDED_RUN_OUTCOME = Object.freeze({
  read: "recorded scan (demo:prepare fallback dataset)",
  status: "read" as const,
  detail: "replayed from the demo dataset's recorded scan through the real discovery worker; no call reached the provider",
});

/** the lease owner of the passes this seeder runs (shown on its runs' audit rows) */
const PASS_OWNER = "demo-prepare:recorded";

// ---------------------------------------------------------------------------
// the recorded scanners
// ---------------------------------------------------------------------------

/** a read-only reader serving the recorded repositories (the SD1 scanner's `resolveReader` seam) */
export function recordedRepoReader(data: DemoShadowDiscoveryDataset): RepoReader {
  const repo = (name: string) => {
    const r = data.gitlab.repos.find((x) => x.fullName === name);
    if (!r) throw new Error(`the recorded GitLab group has no repository ${name.slice(0, 80)}`);
    return r;
  };
  const tree = (name: string): RepoTree => {
    const r = repo(name);
    return {
      repo: r.fullName,
      ref: "main",
      commitSha: r.commitSha,
      author: { name: r.author, email: null },
      entries: r.files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.content, "utf8") })),
      truncated: false,
    };
  };
  return {
    kind: "gitlab",
    historyEnabled: false,
    listRepos: async () => ({ repos: data.gitlab.repos.map((r) => ({ fullName: r.fullName, defaultBranch: "main", archived: false })), truncated: false }),
    getTree: async (name) => tree(name),
    getTreeAt: async (name) => tree(name),
    readFile: async (name, path) => {
      const f = repo(name).files.find((x) => x.path === path);
      return f ? { status: "ok", content: f.content, size: Buffer.byteLength(f.content, "utf8") } : { status: "not_found" };
    },
    inspectCredential: async () => ({ status: "read_only", scopes: ["read_api", "read_repository"], detail: "recorded group access token (read only)" }),
    listCommits: async () => [],
  };
}

/** the production repo scanner over the recorded reader */
function recordedGitlabScanner(data: DemoShadowDiscoveryDataset): Scanner {
  const real = repoScanner("repo_gitlab", { resolveReader: () => recordedRepoReader(data) });
  return { ...real, run: async (ctx) => withRecordedOutcome(await real.run(ctx)) };
}

/** the cloud adapter's recorded observations, mapped by the production `toScanObservation` */
function recordedCloudScanner(kind: "cloud_aws" | "cloud_azure", rec: DemoShadowDiscoveryDataset["aws"] | DemoShadowDiscoveryDataset["azure"]): Scanner {
  const provider = kind === "cloud_aws" ? "aws" : "azure";
  const container = "accountId" in rec ? rec.accountId : rec.subscriptionId;
  return {
    kind,
    requiresCredential: true,
    run: async (ctx) => {
      ctx.recordRaw(JSON.stringify(rec.observations));
      const now = new Date().toISOString();
      const observations = [];
      for (const o of rec.observations) {
        // a principal's raw identifier is pseudonymised here, as the adapter's hook does; it is never stored
        const subject = o.subjectKind === "cloud_principal" ? await ctx.pseudonymise("cloud_principal", o.subject) : o.subject;
        observations.push(
          toScanObservation({
            provider,
            subjectKind: o.subjectKind,
            subject,
            serviceKey: o.serviceKey,
            signalSource: o.signalSource,
            resourceType: o.resourceType,
            location: o.location,
            container,
            ...(o.callCount !== undefined ? { callCount: o.callCount, lastSeen: now } : {}),
            ...(o.operations ? { operations: o.operations } : {}),
          }),
        );
      }
      const caps = rec.capabilities.map((c) => ({ capability: c.capability, scope: c.scope, status: "read" as const, items: c.items }));
      return withRecordedOutcome({ observations, readOutcomes: toReadOutcomes(caps) });
    },
  };
}

function withRecordedOutcome(r: ScanResult): ScanResult {
  return { ...r, readOutcomes: [{ ...RECORDED_RUN_OUTCOME }, ...(r.readOutcomes ?? [])] };
}

/**
 * The registry the seeder's passes run with: a run of one of the dataset's own network-bound sources (by id) replays
 * its recording, and ANY other source's run is refused, never scanned: the seeder must not reach a real provider for a
 * source that is not its own (ensureRecordedRuns runs no pass while such a source is enabled or has a run waiting, and
 * checks again before every pass; this is the guard behind that check, for a run queued in the moment between).
 */
export function recordedDiscoveryRegistry(data: DemoShadowDiscoveryDataset, recordedSourceIds: ReadonlySet<string>) {
  const recorded: Record<"repo_gitlab" | "cloud_aws" | "cloud_azure", Scanner> = {
    repo_gitlab: recordedGitlabScanner(data),
    cloud_aws: recordedCloudScanner("cloud_aws", data.aws),
    cloud_azure: recordedCloudScanner("cloud_azure", data.azure),
  };
  return scannerRegistry(
    [...DISCOVERY_SCANNERS.values()].map((prod): Scanner => {
      const rec = (recorded as Record<string, Scanner | undefined>)[prod.kind];
      return {
        ...prod,
        run: (ctx) => {
          if (rec && recordedSourceIds.has(ctx.source.id)) return rec.run(ctx);
          throw new Error("not a source of the demo dataset: demo:prepare never scans it (the gateway's own worker does)");
        },
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// the request helper and the report
// ---------------------------------------------------------------------------

function harness(app: FastifyInstance, opts: ShadowSeedOptions) {
  const BOOT: Headers = { authorization: `Bearer ${opts.bootstrapToken}` };
  const report: ShadowSeedReport = { created: [], skipped: [], failed: [], notes: [] };
  async function call(method: string, url: string, payload?: unknown, headers: Headers = BOOT, raw?: string) {
    const res = await app.inject({
      method: method as "GET",
      url,
      headers,
      ...(raw !== undefined ? { payload: raw } : payload !== undefined ? { payload: payload as object } : {}),
    });
    let body: Json = {};
    try {
      body = res.json() as Json;
    } catch {
      /* 204 or not JSON */
    }
    return { status: res.statusCode, body, headers: res.headers as Record<string, unknown> };
  }
  const ok = (s: number) => s >= 200 && s < 300;
  const fail = (what: string, r: { status: number; body: Json }) =>
    report.failed.push(`${what}: ${r.status} ${String(r.body.error ?? "")} ${String(r.body.detail ?? "").slice(0, 160)}`.trim());
  /** a refused step-up after first-admin setup is not a failure of this run: it says where the act belongs */
  const stepUpRefused = (r: { status: number; body: Json }) => r.status === 403 && r.body.error === "step_up_required";
  return { BOOT, report, call, ok, fail, stepUpRefused };
}
type Harness = ReturnType<typeof harness>;

const STEP_UP_NOTE =
  "it needs a step-up, which the bootstrap credential gives only during first-admin setup: run `demo:prepare` on an " +
  "empty database, or do it in the UI as Ada";

// ---------------------------------------------------------------------------
// discovery sources
// ---------------------------------------------------------------------------

interface SourceSpec {
  key: "gitlab" | "aws" | "azure" | "inventory" | "agent";
  name: string;
  kind: "repo_gitlab" | "cloud_aws" | "cloud_azure" | "endpoint_inventory" | "endpoint_agent";
  target: Record<string, string>;
  scope: { orgLevel: boolean; include: string[] };
  credential?: { mode: "federated" | "static"; publicConfig: Record<string, string>; secret?: () => string };
  recorded: boolean;
}

export function demoSourceSpecs(data: DemoShadowDiscoveryDataset): SourceSpec[] {
  return [
    {
      key: "gitlab",
      name: data.gitlab.name,
      kind: "repo_gitlab",
      target: { namespace: data.gitlab.namespace },
      scope: { orgLevel: false, include: data.gitlab.repos.map((r) => r.fullName) },
      // a group access token is a static secret (federated git credentials are not built yet): synthetic, minted per
      // run and never printed; the recorded reader never sends it anywhere
      credential: { mode: "static", publicConfig: {}, secret: () => `demo-recorded-${randomBytes(20).toString("hex")}` },
      recorded: true,
    },
    {
      key: "aws",
      name: data.aws.name,
      kind: "cloud_aws",
      target: { accountId: data.aws.accountId },
      scope: { orgLevel: false, include: [...data.aws.regions] },
      credential: { mode: "federated", publicConfig: { roleArn: data.aws.roleArn } },
      recorded: true,
    },
    {
      key: "azure",
      name: data.azure.name,
      kind: "cloud_azure",
      target: { tenantId: data.azure.tenantId },
      scope: { orgLevel: false, include: [data.azure.subscriptionId] },
      credential: { mode: "federated", publicConfig: { tenantId: data.azure.tenantId, clientId: data.azure.clientId } },
      recorded: true,
    },
    {
      key: "inventory",
      name: data.inventory.name,
      kind: "endpoint_inventory",
      target: { exporter: data.inventory.exporter },
      scope: { orgLevel: true, include: [] },
      recorded: false,
    },
    {
      key: "agent",
      name: data.agent.name,
      kind: "endpoint_agent",
      target: { fleet: data.agent.fleet },
      scope: { orgLevel: true, include: [] },
      recorded: false,
    },
  ];
}

async function listSources(h: Harness): Promise<Json[]> {
  return (await h.call("GET", "/v1/discovery/sources")).body.sources ?? [];
}

/** create (disabled), store the credential, enable through the step-up route: each only if not done yet */
async function ensureSource(h: Harness, spec: SourceSpec, allowStepUps: boolean): Promise<Json | null> {
  let s = (await listSources(h)).find((x) => x.name === spec.name);
  if (!s) {
    const r = await h.call("POST", "/v1/discovery/sources", {
      name: spec.name,
      kind: spec.kind,
      target: spec.target,
      scope: spec.scope,
      // an upload-fed kind has no schedule; a recorded source is never due again before the demo
      ...(spec.recorded ? { scheduleIntervalSeconds: DISCOVERY_SCHEDULE_MAX_SECONDS } : {}),
    });
    if (!h.ok(r.status)) {
      h.fail(`discovery source '${spec.name}'`, r);
      return null;
    }
    s = r.body;
    h.report.created.push(`discovery source '${spec.name}' (${spec.kind}, disabled)`);
  }
  if (spec.credential && !s!.credential) {
    const r = await h.call("PUT", `/v1/discovery/sources/${s!.id}/credential`, {
      mode: spec.credential.mode,
      publicConfig: spec.credential.publicConfig,
      ...(spec.credential.secret ? { secret: spec.credential.secret() } : {}),
      replacesCredentialId: null,
    });
    if (h.ok(r.status)) h.report.created.push(`${spec.credential.mode} credential for '${spec.name}'`);
    else if (h.stepUpRefused(r)) {
      h.report.notes.push(`'${spec.name}': the ${spec.credential.mode} credential was not stored — ${STEP_UP_NOTE}`);
      return s!;
    } else {
      h.fail(`credential for '${spec.name}'`, r);
      return s!;
    }
    s = (await listSources(h)).find((x) => x.id === s!.id) ?? s;
  }
  if (!s!.enabled) {
    if (!allowStepUps) {
      h.report.notes.push(`'${spec.name}' is disabled — enabling ${STEP_UP_NOTE}`);
      return s!;
    }
    const r = await h.call("POST", `/v1/discovery/sources/${s!.id}/enable`, { version: s!.version });
    if (h.ok(r.status)) {
      h.report.created.push(`'${spec.name}' enabled (settings_relax step-up)`);
      s = r.body;
    } else if (h.stepUpRefused(r)) h.report.notes.push(`'${spec.name}' is disabled — enabling ${STEP_UP_NOTE}`);
    else h.fail(`enable '${spec.name}'`, r);
  } else h.report.skipped.push(`discovery source '${spec.name}'`);
  return s!;
}

const lastRuns = async (h: Harness, sourceId: string): Promise<Json[]> =>
  (await h.call("GET", `/v1/discovery/runs?sourceId=${sourceId}&limit=20`)).body.runs ?? [];

/** why a discovery pass must not run now: a source outside the dataset is enabled, or one has a run waiting */
async function foreignDiscoveryActivity(h: Harness, ours: ReadonlySet<string>): Promise<{ error: string; detail: string } | null> {
  const others = (await listSources(h)).filter((s) => !ours.has(s.name));
  const enabled = others.filter((s) => s.enabled);
  if (enabled.length) {
    return {
      error: "other_sources_enabled",
      detail: `${enabled.length} discovery source(s) outside the demo dataset are enabled; the seeder runs no discovery pass beside them (the gateway's worker would scan them)`,
    };
  }
  for (const s of others) {
    const latest = (await lastRuns(h, s.id))[0];
    if (latest && (latest.status === "queued" || latest.status === "running")) {
      return {
        error: "other_source_run_pending",
        detail: `a run of a discovery source outside the demo dataset is ${latest.status}; the seeder runs no discovery pass that could claim it`,
      };
    }
  }
  return null;
}

/** a recorded run for each enabled network source that has none that succeeded */
async function ensureRecordedRuns(h: Harness, db: Db, data: DemoShadowDiscoveryDataset, sources: Map<string, Json>, dataKey: string | undefined) {
  const specs = demoSourceSpecs(data).filter((s) => s.recorded);
  const wanted: Json[] = [];
  for (const spec of specs) {
    const s = sources.get(spec.key);
    if (!s?.enabled) continue;
    const runs = await lastRuns(h, s.id);
    if (runs.some((r) => r.status === "succeeded")) {
      h.report.skipped.push(`recorded run of '${spec.name}'`);
      continue;
    }
    const q = await h.call("POST", `/v1/discovery/sources/${s.id}/runs`, {});
    if (!h.ok(q.status) && q.body.error !== "run_already_queued") {
      h.fail(`queue a run of '${spec.name}'`, q);
      continue;
    }
    wanted.push(s);
  }
  if (wanted.length === 0) return;
  // A pass enqueues every due enabled source and claims queued runs of ANY source, oldest first. So it runs only while
  // the dataset's own sources are the only enabled ones and no other source has a run waiting: anything else is the
  // gateway worker's to scan, not ours. Checked again before every pass, so a source enabled (or a run queued) in
  // between stops the seeder instead of reaching the registry's backstop, which would fail that run.
  const ours = new Set(demoSourceSpecs(data).map((s) => s.name));
  const registry = recordedDiscoveryRegistry(data, new Set(wanted.map((s) => s.id as string)));
  // a pass claims up to five queued runs, oldest first; a few passes are the margin for a run still leased
  for (let pass = 0; pass < 4; pass++) {
    const pending = [];
    for (const s of wanted) {
      const latest = (await lastRuns(h, s.id))[0];
      if (latest && (latest.status === "queued" || latest.status === "running")) pending.push(s);
    }
    if (pending.length === 0) break;
    const foreign = await foreignDiscoveryActivity(h, ours);
    if (foreign) {
      for (const s of wanted) h.fail(`recorded run of '${s.name}'`, { status: 0, body: foreign });
      return;
    }
    await runDiscoveryPass(db, { dataKey, registry, owner: `${PASS_OWNER}:${randomUUID().slice(0, 8)}` });
  }
  for (const s of wanted) {
    const latest = (await lastRuns(h, s.id))[0];
    if (latest?.status === "succeeded") {
      h.report.created.push(`recorded run of '${s.name}': ${latest.matched} matched, ${latest.findingsCreated} finding(s) created`);
    } else {
      // e.g. the live gateway's worker took the run first and scanned the fake account for real (and failed)
      h.fail(`recorded run of '${s.name}'`, { status: 0, body: { error: latest?.status ?? "no_run", detail: latest?.errorCode ?? "" } });
    }
  }
}

/** the MDM export, through SD3's import route, once */
async function ensureInventoryImport(h: Harness, data: DemoShadowDiscoveryDataset, source: Json | undefined) {
  if (!source?.enabled) return;
  if ((await lastRuns(h, source.id)).some((r) => r.status === "succeeded")) {
    h.report.skipped.push(`MDM inventory import into '${source.name}'`);
    return;
  }
  const r = await h.call("POST", `/v1/discovery/sources/${source.id}/endpoint-imports`, {
    content: data.inventory.csv,
    format: "csv",
    mode: "apply",
    source: `${data.inventory.exporter}-export.csv`,
  });
  if (h.ok(r.status)) h.report.created.push(`MDM inventory import: ${r.body.findingsCreated ?? 0} finding(s) created`);
  else h.fail("MDM inventory import", r);
}

// ---------------------------------------------------------------------------
// the endpoint agent: enrolment token → ticket → registration → self token → signed report (SD4b)
// ---------------------------------------------------------------------------

/** the device key a simulated agent holds: P-256, generated for this run, never stored */
class SimulatedAgent {
  private nonce: string | undefined;
  private constructor(
    private readonly key: CryptoKey,
    readonly jwk: { kty: "EC"; crv: "P-256"; x: string; y: string },
    readonly jkt: string,
    private readonly issuer: string,
  ) {}
  static async make(issuer: string): Promise<SimulatedAgent> {
    const { privateKey, publicKey } = await generateKeyPair("ES256");
    const j = (await exportJWK(publicKey)) as { x: string; y: string };
    const jwk = { kty: "EC" as const, crv: "P-256" as const, x: j.x, y: j.y };
    return new SimulatedAgent(privateKey, jwk, await calculateJwkThumbprint(jwk as JWK, "sha256"), issuer);
  }
  get clientId() {
    return `urn:ietf:params:oauth:jwk-thumbprint:sha-256:${this.jkt}`;
  }
  /** a DPoP proof; the gateway's nonce once it has asked for one (RFC 9449 §8) */
  proof(method: string, path: string, ath?: string) {
    const p: Record<string, unknown> = { htm: method, htu: `${this.issuer}${path}`, iat: Math.floor(Date.now() / 1000), jti: randomUUID() };
    if (this.nonce) p.nonce = this.nonce;
    if (ath) p.ath = ath;
    return new SignJWT(p).setProtectedHeader({ alg: "ES256", typ: "dpop+jwt", jwk: this.jwk as JWK }).sign(this.key);
  }
  learnNonce(headers: Record<string, unknown>): boolean {
    const n = headers["dpop-nonce"];
    if (typeof n !== "string" || n === this.nonce) return false;
    this.nonce = n;
    return true;
  }
  clientAssertion() {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: this.jkt })
      .setIssuer(this.clientId)
      .setSubject(this.clientId)
      .setAudience(`${this.issuer}/oauth/token`)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(this.key);
  }
  reportSignature(body: string, snapshotId: string) {
    return new SignJWT({ snapshotId, contentDigest: contentDigestOf(Buffer.from(body)) })
      .setProtectedHeader({ alg: "ES256", typ: "regulait-endpoint-report+jwt", kid: this.jkt })
      .setIssuer(this.clientId)
      .setAudience(`${this.issuer}${ENDPOINT_AGENT_PATHS.reports}`)
      .setIssuedAt(Math.floor(Date.now() / 1000))
      .setJti(randomUUID())
      .sign(this.key);
  }
}

export function demoAgentReport(data: DemoShadowDiscoveryDataset, snapshotId: string): string {
  const facts = data.agent.facts.map((f) => ({ ...f, location: { ...f.location } }));
  return JSON.stringify({
    schema: ENDPOINT_REPORT_SCHEMA,
    snapshotId,
    collectedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    agentVersion: data.agent.agentVersion,
    os: data.agent.os,
    arch: data.agent.arch,
    manifestVersion: "1.0.0",
    manifestDigest: createHash("sha256").update("demo-dataset-manifest").digest("hex"),
    keyProtection: "software",
    droppedSnapshots: 0,
    facts,
    gaps: [],
    factsDigest: createHash("sha256").update(JSON.stringify(facts)).digest("hex"),
  });
}

async function ensureEnrolledDevice(h: Harness, data: DemoShadowDiscoveryDataset, source: Json | undefined) {
  if (!source?.enabled) return;
  const devices: Json[] = (await h.call("GET", `/v1/discovery/sources/${source.id}/endpoint-devices`)).body.devices ?? [];
  if (devices.some((d) => !d.revokedAt && d.lastReportAt)) {
    h.report.skipped.push(`enrolled endpoint device in '${source.name}'`);
    return;
  }
  const tok = await h.call("POST", `/v1/discovery/sources/${source.id}/enrolment-tokens`, { label: data.agent.tokenLabel, deviceCap: 5, expiresInDays: 7 });
  if (tok.status === 503 && tok.body.error === "issuer_not_configured") {
    h.report.notes.push("endpoint agent: no device enrolled — this deployment's public URL (REGULAIT_PUBLIC_URL) is not set, so no agent could reach it");
    return;
  }
  if (!h.ok(tok.status)) return h.fail("endpoint agent enrolment token", tok);
  const issuer = String(tok.body.enrolFile.issuer);
  const bulk = String(tok.body.enrolFile.token);
  h.report.created.push(`endpoint agent enrolment token '${data.agent.tokenLabel}' (5 devices, 7 days)`);

  const ticket = await h.call("POST", ENDPOINT_AGENT_PATHS.tickets, { hostname: data.agent.hostname, os: data.agent.os, arch: data.agent.arch, agentVersion: data.agent.agentVersion }, { authorization: `Bearer ${bulk}` });
  if (!h.ok(ticket.status)) return h.fail("endpoint agent ticket", ticket);
  const agent = await SimulatedAgent.make(issuer);
  const reg = await h.call(
    "POST",
    ENDPOINT_AGENT_PATHS.register,
    {
      publicJwk: agent.jwk,
      // the truth about this key: the seeder holds it in memory, so it is a software key, flagged as one
      keyProtection: "software",
      keyProvider: "file",
      keyFallbackReason: "demo dataset: a simulated device enrolled by demo:prepare",
      agentVersion: data.agent.agentVersion,
      os: data.agent.os,
      arch: data.agent.arch,
      deviceUser: data.agent.deviceUser,
    },
    { authorization: `Bearer ${String(ticket.body.ticket)}` },
  );
  if (!h.ok(reg.status)) return h.fail("endpoint agent registration", reg);
  h.report.created.push("endpoint device registered (software key, flagged)");

  // the self token: private_key_jwt + DPoP, retried once with the nonce the gateway hands back
  let access: string | null = null;
  for (let attempt = 0; attempt < 2 && !access; attempt++) {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: agent.clientId,
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: await agent.clientAssertion(),
      resource: `${issuer}/v1/endpoint-agent`,
    }).toString();
    const r = await h.call("POST", "/oauth/token", undefined, { "content-type": "application/x-www-form-urlencoded", dpop: await agent.proof("POST", "/oauth/token") }, form);
    if (r.status === 200) access = String(r.body.access_token);
    else if (!agent.learnNonce(r.headers)) {
      h.report.notes.push(
        `endpoint agent: the device registered but could not get its token (${r.status} ${String(r.body.error ?? "")}) — ` +
          "the deployment needs its identity signing key (identity-key:init); no report was sent",
      );
      return;
    }
  }
  if (!access) return h.fail("endpoint agent token", { status: 0, body: { error: "nonce_retry_exhausted" } });

  const snapshotId = randomUUID();
  const body = demoAgentReport(data, snapshotId);
  const ath = createHash("sha256").update(access).digest("base64url");
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await h.call(
      "POST",
      ENDPOINT_AGENT_PATHS.reports,
      undefined,
      {
        authorization: `DPoP ${access}`,
        dpop: await agent.proof("POST", ENDPOINT_AGENT_PATHS.reports, ath),
        "content-type": "application/json",
        "content-digest": contentDigestOf(Buffer.from(body)),
        "regulait-report-signature": await agent.reportSignature(body, snapshotId),
      },
      body,
    );
    if (h.ok(r.status)) {
      h.report.created.push(`signed endpoint report accepted (${data.agent.facts.length} facts; env-variable names counted, never stored)`);
      return;
    }
    if (!agent.learnNonce(r.headers)) return h.fail("endpoint agent report", r);
  }
  h.fail("endpoint agent report", { status: 0, body: { error: "nonce_retry_exhausted" } });
}

// ---------------------------------------------------------------------------
// federation and content trust
// ---------------------------------------------------------------------------

/** a pending federation key (free: it turns nothing on). Activating it is the live lane's step-up, not the fallback's */
async function ensureFederationKey(h: Harness) {
  const st = await h.call("GET", "/v1/discovery/federation");
  if (!h.ok(st.status)) return h.fail("federation status", st);
  if ((st.body.keys ?? []).some((k: Json) => k.state !== "revoked")) {
    h.report.skipped.push("federation signing key");
    return;
  }
  const r = await h.call("POST", "/v1/discovery/federation/keys", {});
  if (h.ok(r.status)) h.report.created.push("federation signing key generated (pending: federation stays off until an admin activates it)");
  else h.fail("federation signing key", r);
}

async function ensurePolicyLibrary(h: Harness, data: DemoShadowDiscoveryDataset, allowStepUps: boolean): Promise<string | null> {
  const name = data.contentTrust.connectorName;
  const list: Json[] = (await h.call("GET", "/v1/connectors")).body.connectors ?? [];
  let id = list.find((c) => c.name === name)?.id as string | undefined;
  if (!id) {
    // the keyless mock adapter: it executes and meters with no external system
    const r = await h.call("POST", "/v1/connectors", { name, kind: data.contentTrust.connectorKind, providerKind: "mock", pricePerCallUsd: 0.001 });
    if (!h.ok(r.status)) {
      h.fail(`connector '${name}'`, r);
      return null;
    }
    id = r.body.id as string;
    h.report.created.push(`connector '${name}' (mock adapter)`);
  }
  const trust = await h.call("GET", "/v1/content-trust");
  const tier = (trust.body.sources ?? []).find((s: Json) => s.sourceKind === "connector" && s.sourceId === id)?.tier;
  if (tier === "trusted") h.report.skipped.push(`trust tier of '${name}'`);
  else if (allowStepUps) {
    const r = await h.call("PUT", `/v1/content-trust/sources/connector/${id}`, { tier: "trusted" });
    if (h.ok(r.status)) h.report.created.push(`'${name}' trust tier → trusted (settings_relax step-up)`);
    else if (h.stepUpRefused(r)) h.report.notes.push(`'${name}' stays ${tier ?? "untrusted"} — raising it ${STEP_UP_NOTE}`);
    else h.fail(`trust tier of '${name}'`, r);
  } else h.report.notes.push(`'${name}' stays ${tier ?? "untrusted"} — raising it ${STEP_UP_NOTE}`);
  return id;
}

// ---------------------------------------------------------------------------
// the two phases
// ---------------------------------------------------------------------------

/**
 * The fictional provider the Shadow AI import example names (owner decision on #453): a real vendor never appears in
 * the demo's own sample evidence, and the dry run still shows a match. Created once: a rerun neither rewrites the row
 * (no audit row, no `lastUpdatedAt` bump) nor undoes an admin's edit, as the shipped `/seed` route behaves.
 */
async function ensureExampleSignature(h: Harness, data: DemoShadowDiscoveryDataset) {
  const { provider, host } = data.importExample;
  const label = `catalogue entry '${host}' (${provider}, fictional)`;
  const cat = await h.call("GET", "/v1/shadow-ai/catalogue");
  if (!h.ok(cat.status)) return h.fail("read the signature catalogue", cat);
  const rows: Json[] = cat.body.signatures ?? [];
  if (rows.some((r) => r.kind === "hostname" && String(r.value).toLowerCase() === host.toLowerCase())) {
    h.report.skipped.push(label);
    return;
  }
  const r = await h.call("POST", "/v1/shadow-ai/catalogue", {
    provider,
    kind: "hostname",
    value: host,
    matchType: "exact_host",
    provenance: "demo dataset (fictional provider)",
    note: "Fictional provider for the Shadow AI import example. Not a real vendor.",
  });
  if (h.ok(r.status)) h.report.created.push(label);
  else h.fail("catalogue fictional demo provider", r);
}

async function ensureDiscovery(h: Harness, db: Db, data: DemoShadowDiscoveryDataset, opts: ShadowSeedOptions, allowStepUps: boolean) {
  // the catalogues the matcher reads: the shadow-AI signatures (including the cloud rows) and SD3's endpoint rows
  for (const url of ["/v1/shadow-ai/catalogue/seed", "/v1/discovery/endpoint-signatures/seed"]) {
    const r = await h.call("POST", url, {});
    if (!h.ok(r.status)) h.fail(`catalogue ${url}`, r);
  }
  await ensureExampleSignature(h, data);
  const sources = new Map<string, Json>();
  for (const spec of demoSourceSpecs(data)) {
    const s = await ensureSource(h, spec, allowStepUps);
    if (s) sources.set(spec.key, s);
  }
  await ensureRecordedRuns(h, db, data, sources, opts.dataKey);
  await ensureInventoryImport(h, data, sources.get("inventory"));
  await ensureEnrolledDevice(h, data, sources.get("agent"));
  await ensureFederationKey(h);
}

/** Phase 1, before `seed` (first-admin setup): the stepped-up acts and the discovery data. */
export async function seedShadowSetup(app: FastifyInstance, db: Db, data: DemoShadowDiscoveryDataset, opts: ShadowSeedOptions): Promise<ShadowSeedReport> {
  const h = harness(app, opts);
  await ensureDiscovery(h, db, data, opts, true);
  await ensurePolicyLibrary(h, data, true);
  return h.report;
}

/** Phase 2, after `demo:intake`: repairs, the remediation workflow and the provenance reads, as the personas. */
export async function seedShadowStory(app: FastifyInstance, db: Db, data: DemoShadowDiscoveryDataset, opts: ShadowSeedOptions): Promise<ShadowSeedReport> {
  const h = harness(app, opts);
  const minted: string[] = [];
  try {
    await ensureDiscovery(h, db, data, opts, false);
    const connectorId = await ensurePolicyLibrary(h, data, false);
    const users: Json[] = (await h.call("GET", "/v1/users")).body.users ?? [];
    const persona = async (email: string, displayName: string, isAdmin: boolean): Promise<{ id: string; auth: Headers } | null> => {
      let u = users.find((x) => x.email === email);
      if (!u) {
        const r = await h.call("POST", "/v1/users", { email, displayName, isAdmin });
        if (!h.ok(r.status)) {
          h.fail(`persona ${email}`, r);
          return null;
        }
        u = r.body;
        h.report.created.push(`user ${email}`);
      }
      // ADR-0181 (FX2): an admin's key answers to the MFA requirement (see demo-intake-seed-lib.ts)
      if (isAdmin) {
        const mfa = await enrolAdminTotp(app, opts.bootstrapToken, u!.id as string);
        if (mfa.status === "refused") {
          h.report.failed.push(`cannot give ${email} TOTP: ${mfa.reason}`);
          return null;
        }
        if (mfa.status === "enrolled") {
          h.report.notes.push(`${email} had no TOTP and was enrolled now — one-time password ${mfa.password}, authenticator ${mfa.otpauthUri} (shown ONCE)`);
        }
      }
      const key = await h.call("POST", `/v1/users/${u!.id}/keys`, { name: "demo-shadow-seed", expiresAt: demoKeyExpiresAt(DEMO_SCRIPT_KEY_TTL_DAYS) });
      if (key.status !== 201) {
        h.fail(`key for ${email}`, key);
        return null;
      }
      if (typeof key.body.id === "string") minted.push(key.body.id);
      return { id: u!.id as string, auth: { authorization: `Bearer ${String(key.body.token)}` } };
    };
    const ada = await persona("admin@regulait.local", "Ada Admin", true);
    const dana = await persona("dana@regulait.local", "Dana Developer", false);
    // the remediation sign-off is owed to an admin other than the initiator (ADR-0195 A4, ADR-0197 addendum): Morgan,
    // the second admin, whom `seed` creates and enrols beside Ada during first-admin setup. She needs no key here.
    const morgan = users.find((x) => x.email === DEMO_SECURITY_LEAD.email);
    if (!morgan?.isAdmin || morgan.totpEnabled !== true || morgan.disabledAt) {
      h.fail("remediation approver", {
        status: 0,
        body: {
          error: "security_lead_missing",
          detail: `${DEMO_SECURITY_LEAD.email} must be an active admin with TOTP enrolled — \`seed\` creates her during first-admin setup; run \`demo:prepare\` on an empty database`,
        },
      });
    } else if (ada) await ensureRemediation(h, data, ada);
    if (dana && connectorId) await ensureProvenance(h, db, data, connectorId, dana);
  } finally {
    h.report.notes.push(...(await revokeScriptKeys(app, opts.bootstrapToken, minted)));
  }
  return h.report;
}

// ---------------------------------------------------------------------------
// the remediation workflow (ADR-0195 A4): started from the plan's own body, waiting on Morgan (the second admin)
// ---------------------------------------------------------------------------

async function ensureRemediation(h: Harness, data: DemoShadowDiscoveryDataset, ada: { id: string; auth: Headers }) {
  const rem = data.remediation;
  // the environment is one an admin gave a meaning to: the demo company's staging deploy target (mock)
  const targets: Json[] = (await h.call("GET", "/v1/deploy/targets")).body.targets ?? [];
  if (!targets.some((t) => t.name === rem.deployTargetName)) {
    const r = await h.call("POST", "/v1/deploy/targets", { name: rem.deployTargetName, provider: "mock", mode: "hosted", environment: rem.environment });
    if (!h.ok(r.status)) return h.fail(`deploy target '${rem.deployTargetName}'`, r);
    h.report.created.push(`deploy target '${rem.deployTargetName}' (mock, ${rem.environment})`);
  }

  // The sign-off is the SHIPPED default's (ADR-0197 addendum, decision 1: the Q7 default `admin_not_initiator` stays).
  // The start route installs that default on first use, and its sign-off resolves to every active admin other than the
  // initiator: on the fallback database, Ada initiates and Morgan, the only other admin, is the one approver. demo:check
  // asserts exactly that approver set. The seeder authors no template and no rule; where an admin's own rule for the
  // change type exists, it decides, and the seeder says so.
  const rules: Json[] = (await h.call("GET", "/v1/workflows/assignment-rules")).body.rules ?? [];
  const templates: Json[] = (await h.call("GET", "/v1/workflows/templates")).body.templates ?? [];
  const shipped = templates.find((t) => t.name === SHADOW_AI_REMEDIATION_TEMPLATE_NAME);
  if (rules.some((r) => r.changeType === SHADOW_AI_REMEDIATION_CHANGE_TYPE && r.templateId !== shipped?.id)) {
    h.report.notes.push(`an admin's workflow assignment rule for '${SHADOW_AI_REMEDIATION_CHANGE_TYPE}' decides who signs the remediation off, not the shipped default`);
  }

  const findings: Json[] = (await h.call("GET", "/v1/shadow-ai/findings")).body.findings ?? [];
  const finding = findings.find((f) => f.subjectKind === "repo" && f.subject === `gitlab:${rem.repo}`);
  if (!finding) return h.fail("remediation", { status: 0, body: { error: "no_finding", detail: `no finding for gitlab:${rem.repo} — the GitLab recorded run did not land` } });
  const planUrl = `/v1/shadow-ai/findings/${finding.id}/remediation-plan`;
  const before = await h.call("GET", planUrl, undefined, ada.auth);
  if (!h.ok(before.status)) return h.fail("remediation plan", before);
  if (before.body.currentLink && !before.body.currentLink.replaceable) {
    h.report.skipped.push(`remediation workflow for gitlab:${rem.repo}`);
    return;
  }
  let instanceId = before.body.pendingLink?.instanceId as string | undefined;
  if (!instanceId) {
    const plan = await h.call("GET", `${planUrl}?environment=${encodeURIComponent(rem.environment)}`, undefined, ada.auth);
    if (!h.ok(plan.status)) return h.fail("remediation plan body", plan);
    // the plan's own body, unchanged: the change type picks the workflow (the shipped default on a fresh database)
    const start = await h.call("POST", "/v1/workflows/instances", plan.body.workflowRequest.body, ada.auth);
    if (!h.ok(start.status)) return h.fail("start the remediation workflow", start);
    instanceId = start.body.id as string;
    h.report.created.push(`remediation workflow started from the plan's body (${start.body.status})`);
  }
  // leave plan-only by the explicit advance a person makes, then submit the plan as the stage's artifact
  const view = await h.call("GET", `/v1/workflows/instances/${instanceId}`, undefined, ada.auth);
  const inst = view.body.instance ?? {};
  const stage = inst.definition?.stages?.[inst.state?.currentStageIndex ?? -1];
  if (inst.status === "blocked_on_plan" && stage) {
    const adv = await h.call("POST", `/v1/workflows/instances/${instanceId}/advance`, { stageId: stage.id }, ada.auth);
    if (!h.ok(adv.status)) return h.fail("leave the plan-only stage", adv);
  }
  const after = (await h.call("GET", `/v1/workflows/instances/${instanceId}`, undefined, ada.auth)).body.instance ?? {};
  const now = after.definition?.stages?.[after.state?.currentStageIndex ?? -1];
  if (now?.type === "artifact_generation") {
    const art = await h.call("POST", `/v1/workflows/instances/${instanceId}/artifacts`, { stageId: now.id, content: rem.plan }, ada.auth);
    if (!h.ok(art.status)) return h.fail("remediation plan artifact", art);
    h.report.created.push(`remediation plan submitted; the sign-off waits on ${DEMO_SECURITY_LEAD.displayName}`);
  }
  const link = await h.call("POST", `/v1/shadow-ai/findings/${finding.id}/remediate`, { instanceId }, ada.auth);
  if (h.ok(link.status)) h.report.created.push(`finding gitlab:${rem.repo} linked to its remediation workflow`);
  else if (link.body.error !== "already_linked") h.fail("link the remediation workflow", link);
}

// ---------------------------------------------------------------------------
// content provenance (ADR-0193 I4): two reads of the trusted policy library by Dana
// ---------------------------------------------------------------------------

async function ensureProvenance(h: Harness, db: Db, data: DemoShadowDiscoveryDataset, connectorId: string, dana: { id: string; auth: Headers }) {
  // read by source, not from the records route's newest page, which a busy database can push ours off (a read only)
  const ours = await db
    .select({ id: contentProvenanceRecords.id })
    .from(contentProvenanceRecords)
    .where(and(eq(contentProvenanceRecords.sourceKind, "connector"), eq(contentProvenanceRecords.sourceId, connectorId)))
    .limit(1);
  if (ours.length) {
    h.report.skipped.push(`provenance records of '${data.contentTrust.connectorName}'`);
    return;
  }
  const grant = await h.call("POST", "/v1/grants/connectors", { userId: dana.id, connectorId, mode: "read" });
  if (!h.ok(grant.status) && grant.status !== 409) return h.fail(`Dana's read grant on '${data.contentTrust.connectorName}'`, grant);
  let n = 0;
  for (const object of data.contentTrust.objects) {
    const r = await h.call("POST", `/v1/connectors/${connectorId}/invoke`, { operation: "read", object }, dana.auth);
    if (h.ok(r.status)) n++;
    else h.fail(`read '${object}' from '${data.contentTrust.connectorName}'`, r);
  }
  if (n) h.report.created.push(`${n} provenance-recorded read(s) of '${data.contentTrust.connectorName}' by Dana`);
}
