/**
 * Demo task C11 — `demo:check`: walk every storyline beat (AgentCoordination
 * §1) against a seeded database, through the real API, and say PASS / WARN /
 * FAIL per beat with what to fix.
 *
 *   FAIL  the beat cannot be shown (endpoint errors, required data missing)
 *   WARN  the beat works but will look thin or skips a planned moment
 *   PASS  the beat shows what the script says it shows
 *
 * It is the M4 dry-run tool and the morning-of smoke test. Read-only except
 * for one thing it must do to check the Monitor beat: a monitor evaluation
 * pass (which is itself idempotent and audited). It never decides an approval
 * or proposes a remediation — those are live demo moments.
 *
 * ADR-0181: it holds NO admin-owned API key. Its admin reads use the
 * deployment's bootstrap token (as every prep script already does for user
 * lookups and key issue), and the one beat that needs a person — the intake
 * assistant — runs as Dana, the proposer who uses it in the story, on a
 * one-day key this run revokes before it returns. An admin key minted here
 * would be flagged over-scoped by the very monitor pass this check reports.
 */
import type { FastifyInstance } from "fastify";
import { DEMO_SCRIPT_KEY_TTL_DAYS, DEMO_SECURITY_LEAD, demoKeyExpiresAt, revokeScriptKeys } from "./demo-identity.js";
import { DEMO_SHADOW_DISCOVERY, type DemoIntakeFixtures, type DemoShadowDiscoveryDataset } from "@regulait/shared";
import { DEMO_AUP_KEY, DEMO_INCIDENT_TITLE } from "./demo-intake-seed-lib.js";
import { SHADOW_AI_REMEDIATION_TEMPLATE_NAME } from "./shadow-ai-remediation.js";
import { APPROVER_ADMIN_NOT_INITIATOR } from "./workflow-approvers.js";

export type CheckLevel = "PASS" | "WARN" | "FAIL";
export interface DemoCheck {
  beat: string;
  level: CheckLevel;
  detail: string;
  fix?: string;
}

type Json = Record<string, any>;

/**
 * `live` (ADR-0197 addendum decision 3, owner decision of 2026-10-19): the live database holds real findings only. The
 * seeded-dataset beats are replaced by `checkLiveDiscovery`; every governance beat is unchanged.
 */
export interface DemoCheckOptions {
  bootstrapToken: string;
  fixtures?: DemoIntakeFixtures | null;
  live?: boolean;
}

export async function runDemoCheck(
  app: FastifyInstance,
  opts: DemoCheckOptions,
): Promise<DemoCheck[]> {
  const minted: string[] = [];
  let out: DemoCheck[] | undefined;
  try {
    out = await runDemoCheckRun(app, opts, minted);
    return out;
  } finally {
    const notes = await revokeScriptKeys(app, opts.bootstrapToken, minted);
    for (const n of notes) out?.push({ beat: "0 Personas", level: "WARN", detail: n });
  }
}

async function runDemoCheckRun(
  app: FastifyInstance,
  opts: DemoCheckOptions,
  minted: string[],
): Promise<DemoCheck[]> {
  const out: DemoCheck[] = [];
  const add = (beat: string, level: CheckLevel, detail: string, fix?: string) =>
    out.push({ beat, level, detail, ...(fix ? { fix } : {}) });
  const boot = { authorization: `Bearer ${opts.bootstrapToken}` };
  const call = async (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) => {
    const res = await app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
    let body: Json = {};
    try {
      body = res.json() as Json;
    } catch {
      /* empty */
    }
    return { status: res.statusCode, body };
  };

  // --- personas: the people the script logs in as ------------------------------------------
  const users: Json[] = (await call("GET", "/v1/users", boot)).body.users ?? [];
  const byEmail = (e: string) => users.find((u) => u.email === e);
  const ada = byEmail("admin@regulait.local");
  for (const [email, role] of [
    ["admin@regulait.local", "admin / reviewer (Ada)"],
    ["dana@regulait.local", "proposer (Dana)"],
    ["avery@regulait.local", "approver (Avery)"],
  ] as const) {
    const u = byEmail(email);
    if (!u) add("0 Personas", "FAIL", `${email} missing`, "run `seed` then `demo:intake`");
    else if (u.disabledAt) add("0 Personas", "FAIL", `${email} is deactivated`);
    else add("0 Personas", "PASS", `${role}: ${email}`);
  }
  if (!ada) return out;
  // admin reads: the bootstrap token, so no admin-owned key exists while the
  // monitor pass below counts credentials (see the header)
  const auth = boot;

  // --- 1 Discover: shadow AI ---------------------------------------------------------------
  const shadow = await call("GET", "/v1/shadow-ai/findings", auth);
  const findings: Json[] = shadow.body.findings ?? [];
  if (shadow.status !== 200) add("1 Shadow AI", "FAIL", `findings endpoint ${shadow.status}`);
  else if (opts.live) out.push(...(await checkLiveDiscovery((url) => call("GET", url, auth), findings)));
  else if (findings.length === 0) add("1 Shadow AI", "FAIL", "no shadow-AI findings", "run `demo:intake` (it imports a synthetic export)");
  else add("1 Shadow AI", "PASS", `${findings.length} finding(s) to open the story with`);
  if (shadow.status === 200 && !opts.live) out.push(...(await checkShadowDiscovery((url) => call("GET", url, auth), findings)));

  // --- 1 Intake assistant: the hero's answers must land on HIGH -----------------------------
  if (opts.fixtures) {
    // the proposer runs the intake assistant in the story; it needs a person
    const dana = byEmail("dana@regulait.local");
    const key = dana
      ? await call("POST", `/v1/users/${dana.id}/keys`, boot, { name: "demo-check", expiresAt: demoKeyExpiresAt(DEMO_SCRIPT_KEY_TTL_DAYS) })
      : null;
    if (typeof key?.body.id === "string") minted.push(key.body.id);
    const danaAuth = key ? { authorization: `Bearer ${key.body.token}` } : boot;
    const a = await call("POST", "/v1/use-cases/intake/assist", danaAuth, opts.fixtures.hero.intake);
    if (a.status !== 200) add("1 Intake assistant", "FAIL", `assist ${a.status} ${a.body.error ?? ""}`);
    else {
      const tier = a.body.tier?.value;
      add(
        "1 Intake assistant",
        tier === "high" ? "PASS" : "WARN",
        `hero tier = ${JSON.stringify(tier)}; ${(a.body.frameworks ?? []).length} framework(s), ${(a.body.risks ?? []).length} risk(s) suggested`,
        tier === "high" ? undefined : "the script says HIGH — fix the hero's intake answers (G1)",
      );
    }
  } else {
    add("1 Intake assistant", "WARN", "no fixtures loaded — hero answers not checked");
  }

  // --- 1/2 Register: use cases, 360, agent card ---------------------------------------------
  const ucs: Json[] = (await call("GET", "/v1/use-cases", auth)).body.useCases ?? [];
  const approved = ucs.filter((u) => u.status === "approved");
  const tiers = new Set(ucs.map((u) => u.euAiActTier).filter(Boolean));
  if (approved.length === 0) add("2 Register", "FAIL", "no approved use cases", "run `demo:intake`");
  else add("2 Register", tiers.size >= 3 ? "PASS" : "WARN", `${ucs.length} use cases, ${approved.length} approved, tiers: ${[...tiers].join(", ")}`);
  const showcase = approved.find((u) => u.euAiActTier === "high") ?? approved[0];
  if (showcase) {
    const ov = await call("GET", `/v1/use-cases/${showcase.id}/overview`, auth);
    add("2 Use-case 360", ov.status === 200 ? "PASS" : "FAIL", `overview of "${showcase.name}": ${ov.status}`);
    const agentId = (showcase.intendedAgentIds ?? [])[0];
    if (agentId) {
      const card = await call("GET", `/v1/agents/${agentId}/card`, auth);
      add("2 Agent card", card.status === 200 ? "PASS" : "FAIL", `card for its first agent: ${card.status}`);
    } else add("2 Agent card", "WARN", `"${showcase.name}" names no agents`);
  }

  // --- 2 Risks: inherent → residual with controls --------------------------------------------
  const risks: Json[] = (await call("GET", "/v1/risks", auth)).body.risks ?? [];
  const withResidual = risks.filter((r) => (r.controls ?? []).length > 0 && r.residualLikelihood);
  const placeholder = risks.filter((r) => /^Risk \d+$/.test(String(r.title)));
  if (risks.length === 0) add("2 Risks", "FAIL", "risk register is empty", "run `demo:intake`");
  else
    add(
      "2 Risks",
      withResidual.length && !placeholder.length ? "PASS" : "WARN",
      `${risks.length} risks; ${withResidual.length} with controls + residual; ${placeholder.length} placeholder titles`,
      placeholder.length ? "G1: replace 'Risk N' titles with real ones" : withResidual.length ? undefined : "G1: give mitigated risks controls and a residual",
    );

  // --- 3 Trust dashboard ----------------------------------------------------------------------
  const trust = await call("GET", "/v1/reports/trust", auth);
  if (trust.status !== 200) add("3 Trust dashboard", "FAIL", `trust ${trust.status}`);
  else {
    const dims: Json[] = trust.body.dimensions ?? [];
    const measured = dims.filter((d) => d.measured);
    add(
      "3 Trust dashboard",
      measured.length >= 4 ? "PASS" : "WARN",
      `${measured.length}/6 dimensions measured: ${dims.map((d) => `${d.key} ${d.evidenceCoveragePct ?? "–"}%`).join(", ")}`,
      measured.length >= 4 ? undefined : "activate the demo packs (`demo:setup` installs the licence)",
    );
  }

  // --- 3 Dependency graph: inherited exposure ---------------------------------------------------
  const graph = await call("GET", "/v1/inventory/graph", auth);
  if (graph.status !== 200) add("3 Dependency graph", "FAIL", `graph ${graph.status}`);
  else {
    const inherited = (graph.body.nodes as Json[]).filter(
      (n) => n.type === "use_case" && n.propagatedRisk?.sourceNodeKey && n.propagatedRisk.sourceNodeKey !== n.key,
    );
    add(
      "3 Dependency graph",
      inherited.length ? "PASS" : "WARN",
      inherited.length
        ? `${inherited.length} use case(s) inherit their rating, e.g. "${inherited[0]!.label}" (${inherited[0]!.propagatedRisk.band})`
        : `${graph.body.summary?.nodes} nodes, but no use case inherits a rating from a dependency`,
      inherited.length ? undefined : "G5: a vendor-only high risk on the hero's vendor",
    );
  }

  // --- 3 Monitor + remediation ------------------------------------------------------------------
  const ev = await call("POST", "/v1/governance/monitor/evaluate", auth);
  if (ev.status !== 200) add("3 Monitor", "FAIL", `evaluate ${ev.status}`);
  const alerts: Json[] = (await call("GET", "/v1/governance/alerts", auth)).body.alerts ?? [];
  if (!alerts.length) add("3 Monitor", "WARN", "no active alerts — the Monitor beat has nothing to show");
  else {
    const byRule: Record<string, number> = {};
    for (const a of alerts) byRule[a.ruleId] = (byRule[a.ruleId] ?? 0) + 1;
    add(
      "3 Monitor",
      alerts.length <= 15 ? "PASS" : "WARN",
      `${alerts.length} active: ${Object.entries(byRule).map(([k, n]) => `${k}×${n}`).join(", ")}`,
      alerts.length <= 15 ? undefined : "too many alerts for a clean story — give demo agents owners/model cards (G5)",
    );
    let executable = 0;
    for (const a of alerts.slice(0, 20)) {
      const r = await call("GET", `/v1/governance/alerts/${a.id}/remediation`, auth);
      executable += (r.body.candidates ?? []).filter((c: Json) => c.executable).length;
    }
    add(
      "3 Remediation",
      executable ? "PASS" : "WARN",
      `${executable} executable remediation candidate(s) across active alerts`,
      executable ? undefined : "no alert offers an approvable fix — the Respond beat needs one",
    );
  }

  // --- 3 Continuous trace evaluation ----------------------------------------------------------------
  await call("POST", "/v1/governance/trace-evaluations/run", auth);
  const te = await call("GET", "/v1/governance/trace-evaluations", auth);
  if (te.status !== 200) add("3 Trace evaluation", "FAIL", `trace evaluations ${te.status}`);
  else
    add(
      "3 Trace evaluation",
      te.body.totals?.evaluated ? "PASS" : "WARN",
      `${te.body.totals?.evaluated ?? 0} response(s) evaluated, ${te.body.totals?.flagged ?? 0} flagged, across ${(te.body.agents ?? []).length} agent(s)`,
      te.body.totals?.evaluated ? undefined : "no model traffic yet — run a few mock dispatches before the demo",
    );

  // --- 3 Regulatory intelligence -----------------------------------------------------------------
  const reg = await call("GET", "/v1/regulatory/updates", auth);
  if (reg.status !== 200) add("3 Regulatory", "FAIL", `regulatory ${reg.status}`);
  else
    add(
      "3 Regulatory",
      reg.body.summary?.total ? "PASS" : "WARN",
      reg.body.summary?.total
        ? `${reg.body.summary.total} entries, ${reg.body.summary.withControlGaps} with control gaps`
        : "feed not loaded",
      reg.body.summary?.total ? undefined : "G4 (and the index export)",
    );

  // --- 2 Deploy gate (ADR-0161): a pipeline asks before shipping ----------------------------------
  if (showcase) {
    const g = await call("POST", "/v1/gates/deploy", auth, { useCaseId: showcase.id, environment: "demo-check", ref: "demo-check" });
    if (g.status !== 200) add("2 Deploy gate", "FAIL", `gate ${g.status} ${g.body.error ?? ""}`);
    else {
      const blocks = (g.body.reasons ?? []).filter((r: Json) => r.severity === "block");
      // ADR-0180: the story's showcase is READY apart from its alerts — the seeded
      // red-team runs must satisfy its required AI tests under the strict defaults
      const tests = (g.body.reasons ?? []).filter((r: Json) => String(r.code).startsWith("required_test_"));
      add(
        "2 Deploy gate",
        tests.length ? "WARN" : "PASS",
        `"${showcase.name}": ${g.body.decision}` +
          (blocks.length ? ` — ${blocks.map((r: Json) => r.code).join(", ")}` : "") +
          ` (${(g.body.reasons ?? []).length - blocks.length} warning(s)); assurance ${g.body.assurance?.label ?? "not evaluated"}`,
        tests.length
          ? `required AI tests not satisfied (${tests.map((r: Json) => r.message).join("; ")}) — re-run \`demo:intake\` (it runs the demo assurance suite)`
          : undefined,
      );
    }
  }

  // --- approvals queue (the gate beat) ------------------------------------------------------------
  const inbox = await call("GET", "/v1/approvals?status=pending", auth);
  add("2 Approval gate", inbox.status === 200 ? "PASS" : "FAIL", `approvals queue reachable (${inbox.status})`);

  // --- 3 Accountability (ADR-0182 D4): the records the story points at must be TRUE -------------
  // a closed incident whose every clock is terminal; the acceptable-use document current for the
  // three personas; a decision record for the decided showcase use case. Any part false = FAIL.
  {
    const problems: string[] = [];
    const facts: string[] = [];
    const incidents: Json[] = (await call("GET", "/v1/incidents?status=closed", auth)).body.incidents ?? [];
    const inc = incidents.find((i) => i.title === DEMO_INCIDENT_TITLE);
    if (!inc) problems.push("no closed demo incident");
    else if (!(inc.clocks?.total > 0) || inc.clocks.open !== 0) {
      problems.push(`incident ${inc.ref}: ${inc.clocks?.open ?? "?"} of ${inc.clocks?.total ?? 0} clock(s) not terminal`);
    } else facts.push(`incident ${inc.ref} closed, ${inc.clocks.total} clock(s) terminal`);
    const coverage: Json[] = (await call("GET", "/v1/ai-policies/coverage", auth)).body.documents ?? [];
    const aup = coverage.find((d) => d.key === DEMO_AUP_KEY);
    if (!aup) problems.push("no published acceptable-use document");
    else {
      const notCurrent = ["admin@regulait.local", "dana@regulait.local", "avery@regulait.local"].filter(
        (email) => (aup.people ?? []).find((p: Json) => p.email === email)?.state !== "current",
      );
      if (notCurrent.length) problems.push(`acceptable-use v${aup.version} not current for ${notCurrent.join(", ")}`);
      else facts.push(`acceptable-use v${aup.version} current for the three personas`);
    }
    if (!showcase) problems.push("no decided use case to show a decision record for");
    else {
      const recs: Json[] = (await call("GET", `/v1/use-cases/${showcase.id}/decision-records`, auth)).body.records ?? [];
      if (!recs.some((r) => r.outcome === "approved")) problems.push(`"${showcase.name}" has no approval decision record`);
      else facts.push(`"${showcase.name}" decision record present`);
    }
    if (problems.length) add("3 Accountability", "FAIL", problems.join("; "), "re-run `demo:intake` on this database (it seeds the D4 records)");
    else add("3 Accountability", "PASS", facts.join("; "));
  }

  // --- 3 Evidence (ADR-0116): the closing beat downloads a SIGNED bundle, which needs the
  // deployment's export key — without it the button answers 409 in front of the audience
  const signing = await call("GET", "/v1/exports/signing-key", auth);
  if (signing.status === 200 && signing.body.configured) {
    add("3 Evidence", "PASS", `signed export ready — key '${signing.body.keyId}' (${signing.body.fingerprint})`);
  } else {
    add(
      "3 Evidence",
      "FAIL",
      `no usable export signing key (${signing.body.ruleId ?? signing.body.error ?? signing.status}) — "Download signed bundle" would answer 409`,
      "run `pnpm --filter @regulait/gateway demo:export-key`, set the variables it prints in this terminal, then re-run (and start the gateway from the same terminal)",
    );
  }

  return out;
}

/** the beats `checkShadowDiscovery` reports (pinned PASS by demo-shadow-seed.test.ts on its first-admin-setup database) */
export const SHADOW_DISCOVERY_BEATS = [
  "1 Discovery sources",
  "1 Sightings",
  "1 Data minimisation",
  "1 Federation",
  "1 Endpoint agent",
  "1 Remediation plan",
  "3 Content trust",
] as const;

/** every string value anywhere in a JSON value; with `keys`, every object key too */
function stringValues(v: unknown, out: string[] = [], keys = false): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringValues(x, out, keys);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (keys) out.push(k);
      stringValues(x, out, keys);
    }
  }
  return out;
}

/**
 * The names and values of the dataset that must never be stored: environment-variable names and values, device names
 * and users, and a cloud principal's raw identifier (ADR-0195 decision 20, lane A6). Not a CLI's or an app's own
 * identifier: that is the catalogue value the matcher keeps on purpose.
 */
export function demoShadowNeverStored(data: DemoShadowDiscoveryDataset = DEMO_SHADOW_DISCOVERY): string[] {
  const envLines = data.gitlab.repos.flatMap((r) => r.files.filter((f) => f.path.endsWith(".env.example")).flatMap((f) => f.content.split("\n")));
  const csvRows = data.inventory.csv.split("\n").slice(1).map((l) => l.split(","));
  return [
    ...envLines.flatMap((l) => [l.split("=")[0]!, l.slice(l.indexOf("=") + 1)]),
    ...data.agent.facts.filter((f) => f.kind === "env_name").map((f) => f.identifier),
    data.agent.hostname,
    data.agent.deviceUser,
    ...csvRows.flatMap((c) => [c[0]!, c[3]!]),
    ...data.aws.observations.filter((o) => o.subjectKind === "cloud_principal").map((o) => o.subject),
  ].filter((n, i, all) => n && all.indexOf(n) === i);
}

/**
 * Which never-stored names appear in `payload`: a string value equal to one (whatever its length), or a value or an
 * object key containing one long enough to be unambiguous (8+ characters with a `_` or `-`; a short name like `PORT`
 * would match ordinary words and ordinary keys). A name stored as a key (`{ OPENAI_API_KEY: … }`) is still stored.
 */
export function leakedShadowNames(payload: unknown, names: readonly string[]): string[] {
  const exact = new Set(stringValues(payload));
  const withKeys = stringValues(payload, [], true);
  const long = (n: string) => n.length >= 8 && (n.includes("_") || n.includes("-"));
  return names.filter((n) => exact.has(n) || (long(n) && withKeys.some((v) => v.includes(n))));
}

/**
 * ADR-0197 decision 7: every Shadow-AI screen the story opens with has data, in concrete minimum counts, so a step
 * that silently produced nothing FAILs: each network source's last run succeeded AND matched something; a finding per
 * recorded repository, AWS resource, Azure resource and MDM row, the AWS principal's audit-log finding, and the
 * presence signatures kept in place of names; the enrolled device reporting with agent findings; a federation key; the
 * remediation workflow waiting (`blocked_on_approval`) on the security lead's sign-off — Morgan, the second admin
 * (ADR-0197 addendum), active with MFA enrolled, never the initiator; and a provenance record, trusted, for each read
 * of the policy library. It also checks the data-minimisation rule on what was seeded: no environment-variable name or
 * value, device name, device user or principal of the dataset is in any finding, device row or run the API returns
 * (ADR-0195 decision 20, lane A6).
 */
export async function checkShadowDiscovery(
  get: (url: string) => Promise<{ status: number; body: Json }>,
  findings: Json[],
  data: DemoShadowDiscoveryDataset = DEMO_SHADOW_DISCOVERY,
): Promise<DemoCheck[]> {
  const out: DemoCheck[] = [];
  const add = (beat: string, level: CheckLevel, detail: string, fix?: string) => out.push({ beat, level, detail, ...(fix ? { fix } : {}) });
  const RERUN = "run `demo:prepare` on an empty database (its first step enables the sources during first-admin setup)";

  const sources: Json[] = (await get("/v1/discovery/sources")).body.sources ?? [];
  const named = (n: string) => sources.find((s) => s.name === n);
  const runsOf = new Map<string, Json[]>();
  const problems: string[] = [];
  const facts: string[] = [];
  for (const [label, name, network] of [
    ["GitLab", data.gitlab.name, true],
    ["AWS", data.aws.name, true],
    ["Azure", data.azure.name, true],
    ["MDM import", data.inventory.name, false],
    ["endpoint agent", data.agent.name, false],
  ] as const) {
    const s = named(name);
    if (!s) {
      problems.push(`${label} source missing`);
      continue;
    }
    const runs: Json[] = (await get(`/v1/discovery/runs?sourceId=${s.id}&limit=20`)).body.runs ?? [];
    runsOf.set(s.id, runs);
    const ok = runs.find((r) => r.status === "succeeded");
    if (!s.enabled) problems.push(`${label} source disabled`);
    else if (label === "endpoint agent") facts.push(label);
    else if (!ok) problems.push(`${label} source has no run that succeeded (last: ${runs[0]?.status ?? "never ran"})`);
    else if (network && !(Number(ok.matched) > 0)) problems.push(`${label} source's run succeeded but matched nothing`);
    else facts.push(network ? `${label} (${Number(ok.matched)} matched)` : label);
  }
  if (problems.length) add("1 Discovery sources", "FAIL", problems.join("; "), RERUN);
  else add("1 Discovery sources", "PASS", `${facts.length} demo sources enabled, each scanned: ${facts.join(", ")}`);

  // a finding per item the dataset recorded, per family: nothing folds an empty source into a full one
  const has = (f: Json, kinds: string[]) => (f.signalSources ?? []).some((k: string) => kinds.includes(k));
  const subjectOf = (f: Json) => String(f.subject ?? "").toLowerCase();
  const cloud = findings.filter((f) => has(f, ["cloud_inventory", "cloud_audit_log"]));
  const resourcesFound = (obs: DemoShadowDiscoveryDataset["aws"]["observations"]) =>
    obs.filter((o) => o.subjectKind === "cloud_resource" && cloud.some((f) => subjectOf(f) === o.subject.toLowerCase())).length;
  const want = (o: DemoShadowDiscoveryDataset["aws"]["observations"]) => o.filter((x) => x.subjectKind === "cloud_resource").length;
  const stored = JSON.stringify(findings);
  const families: Array<[string, number, number]> = [
    ["repo", data.gitlab.repos.filter((r) => findings.some((f) => f.subject === `gitlab:${r.fullName}`)).length, data.gitlab.repos.length],
    ["AWS resource", resourcesFound(data.aws.observations), want(data.aws.observations)],
    ["AWS principal", cloud.filter((f) => has(f, ["cloud_audit_log"])).length, data.aws.observations.filter((o) => o.subjectKind === "cloud_principal").length],
    ["Azure resource", resourcesFound(data.azure.observations), want(data.azure.observations)],
    ["endpoint import", findings.filter((f) => has(f, ["endpoint_inventory"])).length, data.inventory.csv.split("\n").length - 1],
    ["presence signature", data.presenceSignatures.filter((id) => stored.includes(id)).length, data.presenceSignatures.length],
  ];
  const short = families.filter(([, n, min]) => n < min);
  const sightings = findings.reduce((m, f) => m + Number(f.observationCount ?? 0), 0);
  if (short.length) {
    const missingSigs = data.presenceSignatures.filter((id) => !stored.includes(id));
    add(
      "1 Sightings",
      "FAIL",
      short.map(([l, n, min]) => `${n}/${min} ${l} finding(s)`).join(", ") + (missingSigs.length ? ` (missing: ${missingSigs.join(", ")})` : ""),
      RERUN,
    );
  } else add("1 Sightings", "PASS", `${families.map(([l, n]) => `${n} ${l}`).join(", ")}; ${sightings} sighting(s)`);

  // names are matched, never stored: none is on a finding, the agent's device rows, or any run of the dataset
  const agent = named(data.agent.name);
  const devicesRes = agent ? await get(`/v1/discovery/sources/${agent.id}/endpoint-devices`) : { status: 0, body: {} as Json };
  const devices: Json[] = devicesRes.body.devices ?? [];
  const leaked = leakedShadowNames({ findings, devices, runs: [...runsOf.values()] }, demoShadowNeverStored(data));
  if (leaked.length) add("1 Data minimisation", "FAIL", `${leaked.length} name(s) or value(s) of the dataset returned in clear by the API`, "a scanner or importer stored a name it must only match: stop and report it");
  else add("1 Data minimisation", "PASS", "no environment-variable name or value, device, device user or cloud principal of the dataset is in a finding, device row or run");

  const fed = await get("/v1/discovery/federation");
  if (fed.status !== 200) add("1 Federation", "FAIL", `federation status ${fed.status}`);
  else {
    const keys: Json[] = fed.body.keys ?? [];
    add(
      "1 Federation",
      keys.length ? "PASS" : "FAIL",
      `${keys.length} signing key(s); federation ${fed.body.enabled ? "on" : "off"}${fed.body.issuer ? ` at ${fed.body.issuer}` : " (no public URL)"}`,
      keys.length ? undefined : RERUN,
    );
  }

  if (agent) {
    const reporting = devices.filter((x) => !x.revokedAt && x.lastReportAt);
    const agentFindings = findings.filter((f) => has(f, ["endpoint_agent"]));
    if (reporting.length && agentFindings.length) add("1 Endpoint agent", "PASS", `${reporting.length} enrolled device(s) reporting, ${agentFindings.length} agent finding(s)`);
    else
      add(
        "1 Endpoint agent",
        "FAIL",
        reporting.length
          ? `${reporting.length} device(s) reporting but 0 agent findings`
          : devices.length
            ? `${devices.length} device(s) enrolled, none has reported`
            : "no enrolled device",
        "the agent needs this deployment's public URL (REGULAIT_PUBLIC_URL) and identity signing key (`identity-key:init`); set them and re-run `demo:prepare` on an empty database",
      );
  }

  const repoFinding = findings.find((f) => f.subjectKind === "repo" && f.subject === `gitlab:${data.remediation.repo}`);
  const usersRes = await get("/v1/users");
  const users: Json[] = usersRes.body.users ?? [];
  const lead = users.find((u) => u.email === DEMO_SECURITY_LEAD.email);
  const LEAD = `${DEMO_SECURITY_LEAD.displayName} (${DEMO_SECURITY_LEAD.role})`;
  if (!repoFinding) add("1 Remediation plan", "FAIL", `no finding for gitlab:${data.remediation.repo}`, RERUN);
  else if (!lead || !lead.isAdmin || lead.disabledAt) {
    add(
      "1 Remediation plan",
      "FAIL",
      `${DEMO_SECURITY_LEAD.email} ${!lead ? "missing" : !lead.isAdmin ? "is not an admin" : "is deactivated"}: the remediation sign-off needs a second admin with MFA`,
      "`seed` creates and enrols her during first-admin setup: run `demo:prepare` on an empty database",
    );
  } else if (lead.totpEnabled !== true) {
    // still a FAIL: she cannot approve until she has a second factor. `demo:set-passwords` clears the seed's TOTP by
    // design (ADR-0181 FX2), so this is the expected state after it, and the fix is hers, not a fresh database
    add(
      "1 Remediation plan",
      "FAIL",
      `${DEMO_SECURITY_LEAD.email} has no TOTP enrolled: the remediation sign-off needs a second admin with MFA`,
      `${DEMO_SECURITY_LEAD.displayName} signs in once and enrols her authenticator when the app asks, before her Approve in /ui/inbox; then re-run \`demo:check\``,
    );
  } else {
    const plan = await get(`/v1/shadow-ai/findings/${repoFinding.id}/remediation-plan`);
    const link = plan.body.currentLink;
    if (plan.status !== 200) add("1 Remediation plan", "FAIL", `remediation plan ${plan.status}`);
    else if (!link || link.replaceable) add("1 Remediation plan", "FAIL", `gitlab:${data.remediation.repo} has no live remediation workflow`, "re-run `demo:shadow`");
    else if (link.status !== "blocked_on_approval") add("1 Remediation plan", "FAIL", `gitlab:${data.remediation.repo} → remediation workflow ${link.status}, not waiting on its sign-off`, "re-run `demo:shadow`");
    else {
      const inst = await get(`/v1/workflows/instances/${link.instanceId}`);
      const approvers = [...new Set(((inst.body.pendingApprovals ?? []) as Json[]).map((a) => String(a.approverUserId)))];
      if (approvers.length !== 1 || approvers[0] !== lead.id) {
        add("1 Remediation plan", "FAIL", `the remediation sign-off waits on ${approvers.length} approver(s), not on ${LEAD} alone`, RERUN);
      } else if (inst.body.instance?.initiatorUserId === lead.id) {
        add("1 Remediation plan", "FAIL", `${LEAD} initiated the remediation she is to sign off`, RERUN);
      } else add("1 Remediation plan", "PASS", `gitlab:${data.remediation.repo} → remediation workflow ${link.status}, waiting on ${LEAD}, admin with MFA`);
    }
  }

  const connectors: Json[] = (await get("/v1/connectors")).body.connectors ?? [];
  const library = connectors.find((c) => c.name === data.contentTrust.connectorName);
  const rec = await get("/v1/content-provenance/records?limit=200");
  if (rec.status !== 200) add("3 Content trust", "FAIL", `provenance records ${rec.status}`);
  else {
    const records: Json[] = rec.body.records ?? [];
    const ours = library ? records.filter((r) => r.sourceId === library.id) : [];
    const trusted = ours.filter((r) => r.trustTier === "trusted").length;
    const tiers = [...new Set(records.map((r) => String(r.trustTier)))].sort();
    const min = data.contentTrust.objects.length;
    const detail = `${records.length} provenance record(s), ${trusted}/${min} trusted read(s) of '${data.contentTrust.connectorName}'; tiers ${tiers.join(", ") || "none"}`;
    const fix = "re-run `demo:shadow` (it reads the trusted policy library as Dana)";
    if (trusted < min) add("3 Content trust", "FAIL", detail, fix);
    else add("3 Content trust", tiers.length > 1 ? "PASS" : "WARN", detail, tiers.length > 1 ? undefined : fix);
  }
  return out;
}

/** the beats `checkLiveDiscovery` reports in place of SHADOW_DISCOVERY_BEATS on the live database */
export const LIVE_DISCOVERY_BEATS = ["1 Fictional dataset", "1 Signature catalogue", "1 Real discovery sources", "1 Remediation routing"] as const;

/**
 * The strings only the fictional dataset carries: its company, its source names and their " (demo dataset)" suffix, and
 * every identifier it records (repositories and commits, the account, tenant, client and subscription ids, resource
 * subjects, the exporter, fleet, device, device user, connector and deploy target). None is a catalogue value, so a
 * real finding never carries one.
 */
export function fictionalDatasetMarkers(data: DemoShadowDiscoveryDataset = DEMO_SHADOW_DISCOVERY): string[] {
  return [
    data.company,
    data.sourceSuffix.trim(),
    data.gitlab.name,
    data.aws.name,
    data.azure.name,
    data.inventory.name,
    data.agent.name,
    data.gitlab.namespace,
    ...data.gitlab.repos.flatMap((r) => [r.fullName, r.commitSha]),
    data.aws.accountId,
    data.aws.roleArn,
    data.azure.tenantId,
    data.azure.clientId,
    data.azure.subscriptionId,
    ...[...data.aws.observations, ...data.azure.observations].map((o) => o.subject),
    data.inventory.exporter,
    data.agent.fleet,
    data.agent.tokenLabel,
    data.agent.hostname,
    data.agent.deviceUser,
    data.contentTrust.connectorName,
    data.remediation.deployTargetName,
  ]
    .map((m) => m.trim())
    .filter((m, i, all) => m && all.indexOf(m) === i);
}

/** the most rows the runs, imports and provenance-record routes return in one answer (they do not page) */
export const LIVE_LIST_CAP = 200;

/** the import sources the demo seeders write (the 10-05 synthetic SaaS export, the dataset's MDM export) */
const SEEDED_IMPORT_SOURCE = /^demo-(intake|shadow)-seed\b/i;

/**
 * ADR-0197 addendum decision 3 (owner, 2026-10-19: option A): the live database holds real findings only. Fails closed:
 * any discovery source, run, finding, import, enrolled device, connector or provenance record of the fictional dataset
 * is a FAIL, never a warning. Then the real side: the signature catalogue is loaded (with it empty, discovery matches
 * nothing); at least one real source is enabled (each is listed with its kind and last run, and a source never run is
 * named, so this can run before the first scan); and the remediation default routes its sign-off to the security lead
 * alone (the only active admin other than Ada, with MFA), checked from the users and the default template because no
 * remediation workflow exists before the live S3 beat.
 */
export async function checkLiveDiscovery(
  get: (url: string) => Promise<{ status: number; body: Json }>,
  findings: Json[],
  data: DemoShadowDiscoveryDataset = DEMO_SHADOW_DISCOVERY,
): Promise<DemoCheck[]> {
  const out: DemoCheck[] = [];
  const add = (beat: string, level: CheckLevel, detail: string, fix?: string) => out.push({ beat, level, detail, ...(fix ? { fix } : {}) });
  const markers = fictionalDatasetMarkers(data).map((m) => m.toLowerCase());
  const fictional = (v: unknown) => {
    const s = JSON.stringify(v ?? null).toLowerCase();
    return markers.some((m) => s.includes(m));
  };

  // --- (a) no trace of the fictional dataset ----------------------------------------------------
  const sourcesRes = await get("/v1/discovery/sources");
  const runsRes = await get(`/v1/discovery/runs?limit=${LIVE_LIST_CAP}`);
  const importsRes = await get("/v1/shadow-ai/imports");
  const connectorsRes = await get("/v1/connectors");
  const recordsRes = await get(`/v1/content-provenance/records?limit=${LIVE_LIST_CAP}`);
  const reads: Array<[string, { status: number; body: Json }]> = [
    ["sources", sourcesRes],
    ["runs", runsRes],
    ["imports", importsRes],
    ["connectors", connectorsRes],
    ["provenance records", recordsRes],
  ];
  const sources: Json[] = sourcesRes.body.sources ?? [];
  const fakeSources = sources.filter(fictional);
  const fakeSourceIds = new Set(fakeSources.map((s) => s.id));
  const fakeRuns = ((runsRes.body.runs ?? []) as Json[]).filter((r) => fakeSourceIds.has(r.sourceId) || fictional(r));
  const fakeFindings = findings.filter(fictional);
  const fakeImports = ((importsRes.body.imports ?? []) as Json[]).filter((i) => SEEDED_IMPORT_SOURCE.test(String(i.source ?? "")) || fictional(i));
  const fakeConnectors = ((connectorsRes.body.connectors ?? []) as Json[]).filter((c) => c.name === data.contentTrust.connectorName);
  const fakeConnectorIds = new Set(fakeConnectors.map((c) => c.id));
  const fakeRecords = ((recordsRes.body.records ?? []) as Json[]).filter((r) => fakeConnectorIds.has(r.sourceId) || fictional(r));
  let fakeDevices = 0;
  for (const s of sources.filter((x) => x.kind === "endpoint_agent" || fakeSourceIds.has(x.id))) {
    const res = await get(`/v1/discovery/sources/${s.id}/endpoint-devices`);
    reads.push([`devices of '${s.name}'`, res]);
    const devices: Json[] = res.body.devices ?? [];
    fakeDevices += fakeSourceIds.has(s.id) ? devices.length : devices.filter(fictional).length;
  }
  const unread = reads.filter(([, r]) => r.status !== 200);
  // the list routes cap their answer (runs and provenance records at the `limit` asked, imports at 200) and do not page:
  // a full page may hide a dataset row past the cap, so absence is not proven
  const capped = (
    [
      ["runs", runsRes.body.runs],
      ["imports", importsRes.body.imports],
      ["provenance records", recordsRes.body.records],
    ] as Array<[string, unknown]>
  ).filter(([, rows]) => Array.isArray(rows) && rows.length >= LIVE_LIST_CAP);
  const traces: Array<[string, number]> = [
    ["source", fakeSources.length],
    ["run", fakeRuns.length],
    ["finding", fakeFindings.length],
    ["import", fakeImports.length],
    ["device", fakeDevices],
    ["connector", fakeConnectors.length],
    ["provenance record", fakeRecords.length],
  ];
  const found = traces.filter(([, n]) => n > 0);
  if (unread.length) add("1 Fictional dataset", "FAIL", `could not read ${unread.map(([l, r]) => `${l} (${r.status})`).join(", ")}: absence not proven`);
  else if (found.length) {
    add(
      "1 Fictional dataset",
      "FAIL",
      `the live database holds the fictional dataset: ${found.map(([l, n]) => `${n} ${l}(s)`).join(", ")}` +
        (fakeSources.length ? ` (e.g. '${fakeSources[0]!.name}')` : ""),
      "the live database holds real findings only (ADR-0197 addendum 3): rebuild it from empty with `demo:prepare --live`; the dataset belongs on the fallback stack",
    );
  } else if (capped.length) add("1 Fictional dataset", "FAIL", `${capped.map(([l]) => `${LIVE_LIST_CAP} or more ${l} (the list cap)`).join(", ")}: absence not proven`);
  else add("1 Fictional dataset", "PASS", `no source, run, finding, import, device, connector or provenance record of the fictional dataset (${markers.length} markers)`);

  // --- the signature catalogue the matcher reads ------------------------------------------------
  const cat = await get("/v1/shadow-ai/catalogue");
  if (cat.status !== 200) add("1 Signature catalogue", "FAIL", `catalogue ${cat.status}`);
  else if (!(Number(cat.body.enabled) > 0)) {
    add("1 Signature catalogue", "FAIL", "the signature catalogue is empty: a real scan would match nothing", "run `demo:prepare --live` (its `demo:intake --live` step loads the shipped catalogues)");
  } else add("1 Signature catalogue", "PASS", `${cat.body.enabled} of ${cat.body.total} signature(s) enabled`);

  // --- (b) the configured real discovery sources -------------------------------------------------
  const real = sources.filter((s) => !fakeSourceIds.has(s.id));
  const enabled = real.filter((s) => s.enabled);
  const neverRun = real.filter((s) => !s.lastRun);
  const listed = real.map((s) => {
    const run = s.lastRun as Json | null | undefined;
    const last = run ? `last run ${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}` : "never run";
    return `${s.kind} '${s.name}' ${s.enabled ? "enabled" : "disabled"}, ${last}`;
  });
  const realFindings = findings.length - fakeFindings.length;
  const note = neverRun.length ? `; note: never run yet: ${neverRun.map((s) => `'${s.name}'`).join(", ")} (Run now before T-24h)` : "";
  if (!enabled.length) {
    add(
      "1 Real discovery sources",
      "FAIL",
      real.length ? `no real discovery source is enabled: ${listed.join("; ")}` : "no real discovery source is configured",
      "add, credential and enable the live sources (DEMO_RUNBOOK §7.2), then re-run `demo:check --live`",
    );
  } else add("1 Real discovery sources", "PASS", `${enabled.length} of ${real.length} real source(s) enabled, ${realFindings} finding(s): ${listed.join("; ")}${note}`);

  // --- the remediation default's sign-off: the security lead alone -------------------------------
  const usersRes = await get("/v1/users");
  const users: Json[] = usersRes.body.users ?? [];
  const ada = users.find((u) => u.email === "admin@regulait.local");
  const lead = users.find((u) => u.email === DEMO_SECURITY_LEAD.email);
  const LEAD = `${DEMO_SECURITY_LEAD.displayName} (${DEMO_SECURITY_LEAD.role})`;
  const otherAdmins = users.filter((u) => u.isAdmin && !u.disabledAt && u.id !== ada?.id);
  const templatesRes = await get("/v1/workflows/templates");
  const templates: Json[] = templatesRes.body.templates ?? [];
  const tpl = templates.find((t) => t.name === SHADOW_AI_REMEDIATION_TEMPLATE_NAME);
  const signoff = ((tpl?.definition?.stages ?? []) as Json[]).find((st) => st.type === "human_approval");
  if (usersRes.status !== 200) {
    add("1 Remediation routing", "FAIL", `users (${usersRes.status}): users unreadable, routing not proven`);
  } else if (templatesRes.status !== 200) {
    add("1 Remediation routing", "FAIL", `templates (${templatesRes.status}): routing not proven`);
  } else if (!ada || !lead || !lead.isAdmin || lead.disabledAt) {
    add(
      "1 Remediation routing",
      "FAIL",
      `${!ada ? "admin@regulait.local" : DEMO_SECURITY_LEAD.email} ${!ada || !lead ? "missing" : !lead.isAdmin ? "is not an admin" : "is deactivated"}: the remediation sign-off needs a second admin with MFA`,
      "`seed` creates and enrols her during first-admin setup: run `demo:prepare --live` on an empty database",
    );
  } else if (otherAdmins.length !== 1 || otherAdmins[0]!.id !== lead.id) {
    add(
      "1 Remediation routing",
      "FAIL",
      `the default sign-off (an admin other than the initiator) would wait on ${otherAdmins.length} admin(s) (${otherAdmins.map((u) => u.email).join(", ") || "none"}), not on ${LEAD} alone`,
      "Ada and Morgan are the only admins on the demo database: deactivate the extra admin(s) after the demo, or rebuild with `demo:prepare --live`",
    );
  } else if (lead.totpEnabled !== true) {
    add(
      "1 Remediation routing",
      "FAIL",
      `${DEMO_SECURITY_LEAD.email} has no TOTP enrolled: the remediation sign-off needs a second admin with MFA`,
      `${DEMO_SECURITY_LEAD.displayName} signs in once and enrols her authenticator when the app asks, before her Approve in /ui/inbox; then re-run \`demo:check --live\``,
    );
  } else if (tpl?.retiredAt) {
    add("1 Remediation routing", "FAIL", `the shipped remediation default '${tpl.name}' is retired: an admin's own assignment decides the sign-off`, "route the change type back to the default, or rebuild with `demo:prepare --live`");
  } else if (tpl && !(signoff?.approvers ?? []).includes(APPROVER_ADMIN_NOT_INITIATOR)) {
    add("1 Remediation routing", "FAIL", `the remediation template '${tpl.name}' has no sign-off by an admin other than the initiator`, "rebuild with `demo:prepare --live`");
  } else {
    add(
      "1 Remediation routing",
      "PASS",
      `the remediation default (${tpl ? "installed" : "installs at the first remediation"}) routes the sign-off to ${LEAD} alone: the only active admin other than Ada, with MFA`,
    );
  }
  return out;
}

export function formatDemoCheck(checks: DemoCheck[]): string {
  const lines = checks.map((c) => `${c.level.padEnd(4)}  ${c.beat.padEnd(20)} ${c.detail}${c.fix ? `\n${" ".repeat(27)}→ ${c.fix}` : ""}`);
  const n = (l: CheckLevel) => checks.filter((c) => c.level === l).length;
  lines.push("", `${n("PASS")} pass, ${n("WARN")} warn, ${n("FAIL")} fail`);
  return lines.join("\n");
}
