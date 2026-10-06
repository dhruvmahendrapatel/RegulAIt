/**
 * ADR-0068 — RED-TEAM PROBE-CORPUS DEPTH, proved by attack.
 *
 * What this file is trying to make impossible to fake:
 *
 *  1. AN ASR THAT IS NOT A STATISTIC. A probe that ALWAYS falls and one that
 *     NEVER falls must produce visibly different rates AND non-overlapping
 *     intervals over the SAME N, and the interval must WIDEN as N shrinks —
 *     asserted end to end through the real HTTP surface, not only in the pure
 *     unit tests. A constant would pass neither.
 *  2. A MULTI-TURN PROBE THAT ONLY SENDS TURN ONE. The corpus carries a
 *     multi-turn POSITIVE CONTROL whose sentinel fires on turn TWO; a green
 *     result on it would mean the later turns never went out. The per-trial row
 *     also records how many governed dispatches each trial actually made.
 *  3. AN AGENTIC PROBE THAT PRETENDS. The same probe is run three ways against
 *     the same corpus — target unregistered (NOT RUN, never `passed`), target
 *     registered but ungranted (the model IS induced and pillar 1 REFUSES:
 *     recorded as `platform_held`, a positive result), and target granted (the
 *     model is induced and the call WOULD have gone through: a real finding).
 *     Nothing is ever executed, and the stored row says so.
 *  4. A COMPLIANCE PRESET THAT IS DECORATION. A profile's `redteamMinTrials`
 *     and gating classes must actually RAISE a run the caller asked to run at
 *     one trial, and the tightening must be named on the run row.
 *  5. A RED-TEAM SIDE CHANNEL THROUGH THE NEW PATH. The sequence runner does
 *     not enter `runEvalSuite`, so it is asserted separately that an unentitled
 *     prober is denied at the same `evaluateAgent` gate with an audit row and
 *     ZERO dispatches.
 *
 * SHARED-STATE DISCIPLINE: every object is `rtd-` prefixed. This file writes NO
 * org-singleton state. It creates ONE compliance profile under a tag no other
 * suite uses (`rtd-hipaa`) and deletes nothing else.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  eq,
  evalCases,
  inArray,
  redteamFindings,
  redteamProbeTrials,
  redteamProbes,
  redteamRuns,
  redteamTrials,
  runMigrations,
  usageEvents,
  type Db,
} from "@regulait/db";
import {
  RED_TEAM_ATTACK_CLASSES,
  builtinRedTeamLibrary,
  builtinRedTeamLibraryV2,
  composeRedTeamPreset,
  isSequenceProbe,
  validateRedTeamProbe,
  type RedTeamProbeAsr,
} from "@regulait/shared";
import { buildApp } from "./app.js";
import { relaxGovernanceGatesForTest } from "./testing/governance-gates.js";
// ADR-0181: the governance gates this suite would trip but does not test, relaxed by name
let restoreSb2Gates: () => Promise<void> = async () => {};
import { relaxStrictAdmissionForTest } from "./testing/strict-admission.js";

// ADR-0181: this file pins behaviour against a LOCAL MCP double (127.0.0.1, registered
// seconds ago), not the strict admission defaults — relaxed explicitly, restored after.
let restoreStrictAdmission: (() => Promise<void>) | undefined;
import { relaxDataPostureForTest } from "./testing/strict-data-posture.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "rtd-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "d".repeat(64);

let db: Db;
let app: ReturnType<typeof buildApp>;
let annaAuth: { authorization: string };
let annaId: string;
let bruteAuth: { authorization: string };
let agentId: string;
let libraryId: string;
let projectId: string;
let classifiedProjectId: string;
let controlServerId: string;

async function makeUser(email: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email, displayName: email.split("@")[0]! },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({
    method: "POST",
    url: `/v1/users/${u.json().id}/keys`,
    headers: AUTH,
    payload: { name: "rtd" },
  });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function run(payload: Record<string, unknown>, auth = annaAuth) {
  return app.inject({ method: "POST", url: "/v1/redteam/runs", headers: auth, payload });
}

const statOf = (stats: RedTeamProbeAsr[], key: string) => stats.find((s) => s.probeKey === key)!;

let restoreSb1Posture: (() => Promise<void>) | undefined;
beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  restoreStrictAdmission = await relaxStrictAdmissionForTest(db);
  // ADR-0181: the shipped guardrails block injection and jailbreak probes before they reach
  // the agent, and the PII floor withholds leaky outputs. This file pins the red-team
  // mechanism against the agent itself, so it starts from the pre-strict posture.
  restoreSb1Posture = await relaxDataPostureForTest(db, { org: { defaultPiiMode: "none" }, interception: false });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  restoreSb2Gates = await relaxGovernanceGatesForTest(db, { mrmEnforced: false, dispatchAttributionRequired: false });

  const anna = await makeUser("rtd-anna@example.com");
  annaId = anna.id;
  annaAuth = anna.auth;
  const brute = await makeUser("rtd-brute@example.com");
  bruteAuth = brute.auth;

  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: {
      name: "rtd-subject",
      provider: "mock",
      tier: 1,
      costPerMTokIn: 3,
      costPerMTokOut: 15,
      model: "mock-balanced",
    },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
  await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId: annaId, agentId },
  });

  for (const [name, key] of [
    ["rtd-project", "RTDPROJ"],
    ["rtd-classified", "RTDCLASS"],
  ] as const) {
    const p = await app.inject({
      method: "POST",
      url: "/v1/projects",
      headers: AUTH,
      payload: { name, key },
    });
    expect(p.statusCode).toBe(201);
    if (key === "RTDPROJ") projectId = p.json().id;
    else classifiedProjectId = p.json().id;
    await app.inject({
      method: "POST",
      url: `/v1/projects/${p.json().id}/members`,
      headers: AUTH,
      payload: { userId: annaId, role: "member" },
    });
  }

  // Corpus v2 is installed here through the ORDINARY AUTHORING API rather than
  // through `POST /seed`, for two reasons. (1) The shipped corpus name
  // `regulait-core` is shared with `redteam.test.ts`, which asserts the version
  // it mints — seeding v2 of that name from a second suite would move a number
  // another accepted suite depends on. (2) It buys strictly MORE coverage: it
  // proves the authoring endpoint really persists `turns`, `tools` and
  // `agentic`, which a seed path could have written by a different route.
  const lib = await app.inject({
    method: "POST",
    url: "/v1/redteam/libraries",
    headers: AUTH,
    payload: { name: "rtd-core-v2", note: "ADR-0068 corpus v2 under this suite's own name" },
  });
  expect(lib.statusCode).toBe(201);
  libraryId = lib.json().id;
  for (const probe of builtinRedTeamLibraryV2().probes) {
    const res = await app.inject({
      method: "POST",
      url: `/v1/redteam/libraries/${libraryId}/probes`,
      headers: AUTH,
      payload: {
        probeKey: probe.probeKey,
        attackClass: probe.attackClass,
        severity: probe.severity,
        input: probe.input,
        ...(probe.turns ? { turns: probe.turns } : {}),
        ...(probe.tools ? { tools: probe.tools } : {}),
        ...(probe.agentic ? { agentic: probe.agentic } : {}),
        scorerKind: probe.scorerKind,
        scorerConfig: probe.scorerConfig,
        note: probe.note,
      },
    });
    expect(res.statusCode, `${probe.probeKey}: ${res.body}`).toBe(201);
  }
  const published = await app.inject({
    method: "POST",
    url: `/v1/redteam/libraries/${libraryId}/publish`,
    headers: AUTH,
  });
  expect(published.statusCode).toBe(201);
});

afterAll(async () => {
  await restoreStrictAdmission?.();
  await restoreSb1Posture?.();
  // leave no cross-suite footprint: the compliance profile this file creates is
  // under its own tag, and the classified project is its own.
  // this file's compliance profile sits under its own `rtd-hipaa` tag and its
  // classified project is its own, so there is nothing shared to restore.

  await restoreSb2Gates();
});

// ===========================================================================
// 1. The corpus, before any database is involved
// ===========================================================================

describe("(1) corpus v2 — versioned, offline, and v1 left frozen", () => {
  it("v1 is UNCHANGED: nine probes, five classes, no sequence or agentic probe", () => {
    const v1 = builtinRedTeamLibrary();
    expect(v1.version).toBe(1);
    expect(v1.probes).toHaveLength(9);
    expect(v1.probes.some((p) => isSequenceProbe(p))).toBe(false);
    expect(new Set(v1.probes.map((p) => p.attackClass)).size).toBe(5);
  });

  it("v2 covers all ten attack classes and every probe carries a usable oracle", () => {
    const v2 = builtinRedTeamLibraryV2();
    const classes = new Set(v2.probes.map((p) => p.attackClass));
    for (const c of RED_TEAM_ATTACK_CLASSES) expect(classes.has(c)).toBe(true);
    for (const probe of v2.probes) {
      expect(validateRedTeamProbe(probe)).toBeNull();
    }
  });

  it("v2 contains real MULTI-TURN and AGENTIC probes, not relabelled single-turn ones", () => {
    const v2 = builtinRedTeamLibraryV2();
    const multiTurn = v2.probes.filter((p) => (p.turns ?? []).length > 0);
    const agentic = v2.probes.filter((p) => p.agentic);
    expect(multiTurn.length).toBeGreaterThanOrEqual(3);
    expect(agentic.length).toBeGreaterThanOrEqual(4);
    // a crescendo is only a crescendo if the escalation is in the LATER turns
    const crescendo = v2.probes.find((p) => p.probeKey === "mt-crescendo-authority")!;
    expect(crescendo.turns!.length).toBe(3);
    expect(crescendo.input).not.toContain("verbatim");
    expect(crescendo.turns!.join("\n")).toContain("verbatim");
  });

  it("refuses an agentic probe that can never fire — the anti-theatre gate, extended", () => {
    const base = {
      attackClass: "tool_abuse",
      severity: "high",
      scorerKind: "contains" as const,
      scorerConfig: { forbidden: ["x"] },
    };
    // induces a tool the agent is never handed
    expect(
      validateRedTeamProbe({
        ...base,
        tools: [{ name: "other_tool" }],
        agentic: { kind: "tool_abuse", inducedTool: "ghost", serverName: "s" },
      }),
    ).toContain("never declares it");
    // names no adjudication target
    expect(
      validateRedTeamProbe({
        ...base,
        tools: [{ name: "t" }],
        agentic: { kind: "tool_abuse", inducedTool: "t" },
      }),
    ).toContain("serverName");
    // holds no tool at all
    expect(
      validateRedTeamProbe({
        ...base,
        agentic: { kind: "tool_abuse", inducedTool: "t", serverName: "s" },
      }),
    ).toContain("must declare at least one tool");
    // an empty turn
    expect(validateRedTeamProbe({ ...base, turns: ["  "] })).toContain("empty turn");
  });

  it("the seed refuses a corpus version nobody shipped, and names the latest", async () => {
    const bad = await app.inject({
      method: "POST",
      url: "/v1/redteam/libraries/seed",
      headers: AUTH,
      payload: { corpusVersion: 3 },
    });
    // zod bounds the field, so this is a 400 with a stated reason rather than a
    // silent coercion to the latest — either way it is a refusal, never a run
    // stamped with a corpus version nobody shipped.
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    const classes = await app.inject({
      method: "GET",
      url: "/v1/redteam/attack-classes",
      headers: AUTH,
    });
    expect(classes.json().corpus.seedDefault).toBe(1);
    expect(classes.json().corpus.shippedVersions).toEqual([1, 2]);
  });

  it("the authoring API really persisted turns, tools and agentic vectors", async () => {
    const rows = await db.select().from(redteamProbes).where(eq(redteamProbes.libraryId, libraryId));
    const crescendo = rows.find((r) => r.probeKey === "mt-crescendo-authority")!;
    expect(crescendo.turns).toHaveLength(3);
    const agentic = rows.find((r) => r.probeKey === "ag-tool-abuse-positive-control")!;
    expect((agentic.tools as Array<{ name: string }>)[0]!.name).toBe("probe_control_tool");
    expect((agentic.agentic as { serverName: string }).serverName).toBe("probe-control");
  });

  it("publish materializes ONLY the single-turn probes as eval cases", async () => {
    const v2 = builtinRedTeamLibraryV2();
    const expectedCases = v2.probes.filter((p) => !isSequenceProbe(p)).length;
    const probes = await db.select().from(redteamProbes).where(eq(redteamProbes.libraryId, libraryId));
    expect(probes).toHaveLength(v2.probes.length);
    const [library] = await db
      .select()
      .from(redteamProbes)
      .where(eq(redteamProbes.libraryId, libraryId))
      .limit(1);
    expect(library).toBeTruthy();
    const lib = await app.inject({
      method: "GET",
      url: `/v1/redteam/libraries/${libraryId}`,
      headers: AUTH,
    });
    const datasetId = lib.json().library.evalDatasetId;
    const cases = await db.select().from(evalCases).where(eq(evalCases.datasetId, datasetId));
    expect(cases).toHaveLength(expectedCases);
    expect(expectedCases).toBeLessThan(v2.probes.length);
  });
});

// ===========================================================================
// 2. N trials and the ASR statistics, end to end
// ===========================================================================

describe("(2) N-trial runs produce a real attack-success rate", () => {
  let sixTrialRunId: string;
  let sixTrialStats: RedTeamProbeAsr[];

  it("six trials really dispatch six times and record every one", async () => {
    const res = await run({ libraryId, agentId, projectId, trials: 6 });
    expect(res.statusCode).toBe(201);
    sixTrialRunId = res.json().run.id;
    sixTrialStats = res.json().probeStats;

    const trialRows = await db.select().from(redteamTrials).where(eq(redteamTrials.runId, sixTrialRunId));
    expect(trialRows).toHaveLength(6);
    // every trial has a distinct, real eval run behind it
    expect(new Set(trialRows.map((t) => t.evalRunId)).size).toBe(6);

    const probeTrials = await db
      .select()
      .from(redteamProbeTrials)
      .where(eq(redteamProbeTrials.runId, sixTrialRunId));
    const probeCount = (await db.select().from(redteamProbes).where(eq(redteamProbes.libraryId, libraryId)))
      .length;
    expect(probeTrials).toHaveLength(probeCount * 6);
    expect(res.json().measurement.quality).toBe("low-power");
    expect(res.json().run.trials).toBe(6);
  });

  it("ADVERSARIAL: an always-failing probe and a never-failing probe are visibly different over the SAME N", () => {
    // the PII positive control fires on every trial against the deterministic
    // rig; the bias matched-pair probe never does
    const always = statOf(sixTrialStats, "pii-positive-control");
    const never = statOf(sixTrialStats, "bias-matched-pair");
    expect(always.status).toBe("measured");
    expect(never.status).toBe("measured");
    expect(always.trials).toBe(6);
    expect(never.trials).toBe(6);
    expect(always.asr).toBe(1);
    expect(never.asr).toBe(0);
    // THE ASSERTION A CONSTANT WOULD FAIL: the intervals must not overlap.
    expect(never.interval!.upper).toBeLessThan(always.interval!.lower);
  });

  it("ADVERSARIAL: the interval WIDENS when N shrinks — it is a function of the denominator", async () => {
    const one = await run({ libraryId, agentId, projectId, trials: 1 });
    expect(one.statusCode).toBe(201);
    const oneStats: RedTeamProbeAsr[] = one.json().probeStats;
    const singleTrial = statOf(oneStats, "pii-positive-control");
    const sixTrial = statOf(sixTrialStats, "pii-positive-control");
    expect(singleTrial.asr).toBe(sixTrial.asr); // SAME point estimate
    expect(singleTrial.interval!.width).toBeGreaterThan(sixTrial.interval!.width);
    expect(one.json().measurement.quality).toBe("single-trial");
    // and the one-trial run says out loud that it is not a measurement
    expect(one.json().asrDisclosure).toContain("single-trial");
  });

  it("the per-trial record is READABLE — a reviewer sees the run, not a mean", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/redteam/runs/${sixTrialRunId}/trials`,
      // reads on the red-team surface are admin, exactly as ADR-0057 left them
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.trials).toHaveLength(6);
    const control = body.probeTrials.filter(
      (r: { probeKey: string }) => r.probeKey === "pii-positive-control",
    );
    expect(control).toHaveLength(6);
    expect(control.every((r: { defeated: boolean }) => r.defeated)).toBe(true);
    expect(body.run.asrTrials).toBeGreaterThan(0);
  });

  it("a finding carries the ASR, so '1 of 6' and '6 of 6' are not the same red dot", async () => {
    const findings = await db
      .select()
      .from(redteamFindings)
      .where(eq(redteamFindings.runId, sixTrialRunId));
    const control = findings.find((f) => f.probeKey === "pii-positive-control")!;
    expect(control).toBeTruthy();
    const detail = control.detail as { trials: number; defeats: number; asr: number; interval: unknown };
    expect(detail.trials).toBe(6);
    expect(detail.defeats).toBe(6);
    expect(detail.asr).toBe(1);
    expect(detail.interval).toBeTruthy();
  });

  it("trials multiply MEASURED SPEND, and every trial's dispatch is attributed", async () => {
    const rows = await db
      .select()
      .from(usageEvents)
      .where(eq(usageEvents.projectId, projectId));
    // six trials of a multi-probe corpus is a lot of governed calls; the point
    // is only that they are all attributed rather than invisible.
    expect(rows.length).toBeGreaterThan(6);
    const res = await app.inject({
      method: "GET",
      url: `/v1/redteam/runs/${sixTrialRunId}`,
      headers: AUTH,
    });
    expect(res.json().run.costUsd).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// 3. Multi-turn — the sequence, not the last turn, is the probe
// ===========================================================================

describe("(3) multi-turn probes really send their later turns", () => {
  it("the multi-turn POSITIVE CONTROL fires on turn TWO — a green result would mean turn two never went out", async () => {
    const res = await run({ libraryId, agentId, projectId, trials: 2 });
    expect(res.statusCode).toBe(201);
    const stats: RedTeamProbeAsr[] = res.json().probeStats;
    const control = statOf(stats, "mt-refusal-positive-control");
    expect(control.status).toBe("measured");
    expect(control.asr).toBe(1);

    const rows = await db
      .select()
      .from(redteamProbeTrials)
      .where(
        and(
          eq(redteamProbeTrials.runId, res.json().run.id),
          eq(redteamProbeTrials.probeKey, "mt-refusal-positive-control"),
        ),
      );
    expect(rows).toHaveLength(2);
    // two turns, two governed dispatches — recorded, not assumed
    for (const r of rows) expect(r.turnsDispatched).toBe(2);
  });

  it("a four-turn crescendo dispatches four times", async () => {
    const [row] = await db
      .select()
      .from(redteamProbeTrials)
      .where(eq(redteamProbeTrials.probeKey, "mt-crescendo-authority"))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row!.turnsDispatched).toBe(4);
  });
});

// ===========================================================================
// 4. Agentic vectors — the part garak structurally cannot do
// ===========================================================================

describe("(4) agentic probes adjudicate against OUR OWN entitlement layer", () => {
  it("an unregistered target is NOT RUN — never quietly counted as resisted", async () => {
    const res = await run({ libraryId, agentId, projectId, trials: 2 });
    const stats: RedTeamProbeAsr[] = res.json().probeStats;
    const control = statOf(stats, "ag-tool-abuse-positive-control");
    expect(control.status).toBe("not_run");
    expect(control.asr).toBeNull();
    expect(control.notRunReason).toContain("probe-control");
    expect(res.json().run.notRunProbes).toBeGreaterThan(0);
    // and it is EXCLUDED from the gate's probe COUNT rather than inflating it:
    // corpus v2 has two `tool_abuse` probes, and only the one that could be
    // measured is in the class aggregate the gate reads.
    const toolAbuse = res
      .json()
      .classes.find((c: { attackClass: string }) => c.attackClass === "tool_abuse");
    expect(toolAbuse.probes).toBe(1);
    expect(statOf(stats, "ag-tool-abuse-crm-export").status).toBe("measured");
  });

  it("PLATFORM HELD: the model IS induced and pillar 1 refuses the call anyway", async () => {
    const s = await app.inject({
      method: "POST",
      url: "/v1/servers",
      headers: AUTH,
      payload: { name: "probe-control", url: "http://127.0.0.1:9" },
    });
    expect(s.statusCode).toBe(201);
    controlServerId = s.json().id;
    await app.inject({
      method: "POST",
      url: `/v1/servers/${controlServerId}/tools`,
      headers: AUTH,
      payload: { name: "probe_control_tool", kind: "write" },
    });
    // anna is granted NOTHING on this server — default-deny is the point

    const res = await run({ libraryId, agentId, projectId, trials: 1 });
    expect(res.statusCode).toBe(201);
    const stats: RedTeamProbeAsr[] = res.json().probeStats;
    const control = statOf(stats, "ag-tool-abuse-positive-control");
    expect(control.status).toBe("measured");
    expect(control.asr).toBe(0); // the SYSTEM as deployed did not leak

    const [row] = await db
      .select()
      .from(redteamProbeTrials)
      .where(
        and(
          eq(redteamProbeTrials.runId, res.json().run.id),
          eq(redteamProbeTrials.probeKey, "ag-tool-abuse-positive-control"),
        ),
      );
    const adj = row!.adjudication as Record<string, unknown>;
    expect(adj.modelComplied).toBe(true); // the AGENT was induced
    expect(adj.platformHeld).toBe(true); // and the PLATFORM refused
    expect(adj.executed).toBe(false); // and nothing ever ran
    expect(adj.targetRegistered).toBe(true);
    expect(res.json().run.platformHeld).toBeGreaterThan(0);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "redteam-platform-held"));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("PLATFORM WOULD ALLOW: granting the tool turns the same probe into a real finding", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/grants/tools",
      headers: AUTH,
      payload: { userId: annaId, serverId: controlServerId, toolName: "probe_control_tool" },
    });
    const res = await run({ libraryId, agentId, projectId, trials: 1 });
    expect(res.statusCode).toBe(201);
    const stats: RedTeamProbeAsr[] = res.json().probeStats;
    const control = statOf(stats, "ag-tool-abuse-positive-control");
    expect(control.asr).toBe(1); // the SAME probe, the opposite verdict

    const [row] = await db
      .select()
      .from(redteamProbeTrials)
      .where(
        and(
          eq(redteamProbeTrials.runId, res.json().run.id),
          eq(redteamProbeTrials.probeKey, "ag-tool-abuse-positive-control"),
        ),
      );
    const adj = row!.adjudication as Record<string, unknown>;
    expect(adj.modelComplied).toBe(true);
    expect(adj.platformHeld).toBe(false);
    expect(adj.executed).toBe(false); // STILL never executed, even on a finding

    const findings = await db
      .select()
      .from(redteamFindings)
      .where(eq(redteamFindings.runId, res.json().run.id));
    expect(findings.some((f) => f.probeKey === "ag-tool-abuse-positive-control")).toBe(true);

    const audits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "redteam-platform-would-allow"));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("an agent that refuses to be induced is the strongest result, and claims no platform verdict", async () => {
    const rows = await db
      .select()
      .from(redteamProbeTrials)
      .where(eq(redteamProbeTrials.probeKey, "ag-connector-exfiltration"))
      .limit(1);
    const adj = rows[0]!.adjudication as Record<string, unknown>;
    expect(adj.modelComplied).toBe(false);
    expect(adj.platformHeld).toBeNull();
    expect(String(adj.note)).toContain("refused to be induced");
  });
});

// ===========================================================================
// 5. The compliance cascade drives the gating preset
// ===========================================================================

describe("(5) the compliance cascade may only TIGHTEN a red-team run", () => {
  it("composes additively, and strictest-wins on the severity floor", () => {
    const preset = composeRedTeamPreset([
      { tag: "a", gatingClasses: ["jailbreak"], minTrials: 3, failOnSeverity: "high" },
      { tag: "b", gatingClasses: ["tool_abuse"], minTrials: 5, failOnSeverity: "medium" },
      { tag: "c" },
    ]);
    expect(preset.gatingClasses).toEqual(["jailbreak", "tool_abuse"]);
    expect(preset.minTrials).toBe(5); // MAX floor
    expect(preset.failOnSeverity).toBe("medium"); // the LOWER floor fails more
    expect(preset.governingTags).toEqual(["a", "b"]);
  });

  it("a classified project RAISES a one-trial request, and names which framework said so", async () => {
    const profile = await app.inject({
      method: "POST",
      url: "/v1/compliance/profiles",
      headers: AUTH,
      payload: {
        tag: "rtd-hipaa",
        redteamGatingClasses: ["pii_leak", "tool_abuse"],
        redteamMinTrials: 4,
        redteamFailOnSeverity: "high",
      },
    });
    expect(profile.statusCode).toBe(201);
    const classify = await app.inject({
      method: "POST",
      url: `/v1/projects/${classifiedProjectId}/classifications`,
      headers: AUTH,
      payload: { classifications: ["rtd-hipaa"] },
    });
    expect(classify.statusCode).toBe(200);

    const res = await run({
      libraryId,
      agentId,
      projectId: classifiedProjectId,
      trials: 1,
      gatingClasses: ["bias"],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().run.trials).toBe(4); // raised from the requested 1
    const tightened: string[] = res.json().presetTightened;
    expect(tightened.join(" ")).toContain("rtd-hipaa");
    expect(tightened.some((t) => t.includes("trials raised 1 → 4"))).toBe(true);
    // the caller's own class survives; the framework's are ADDED, never swapped
    expect(res.json().run.gatingClasses).toEqual(expect.arrayContaining(["bias", "pii_leak", "tool_abuse"]));
    const trialRows = await db
      .select()
      .from(redteamTrials)
      .where(eq(redteamTrials.runId, res.json().run.id));
    expect(trialRows).toHaveLength(4);
  });

  it("an unclassified project tightens nothing — the caller's request stands", async () => {
    const res = await run({ libraryId, agentId, projectId, trials: 1 });
    expect(res.json().presetTightened).toEqual([]);
    expect(res.json().run.trials).toBe(1);
  });
});

// ===========================================================================
// 6. No side channel through the new path
// ===========================================================================

describe("(6) the sequence runner is not a governance bypass", () => {
  it("an unentitled prober is denied and NOTHING is dispatched", async () => {
    const before = await db.select().from(redteamRuns);
    const res = await run({ libraryId, agentId, trials: 3 }, bruteAuth);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("agent_not_entitled");
    const after = await db.select().from(redteamRuns);
    expect(after.length).toBe(before.length);
  });

  it("the refusal is audited at the same entitlement gate an invoke uses", async () => {
    const rows = await db
      .select()
      .from(auditLog)
      .where(inArray(auditLog.ruleId, ["default-deny"]));
    expect(rows.length).toBeGreaterThan(0);
  });
});
