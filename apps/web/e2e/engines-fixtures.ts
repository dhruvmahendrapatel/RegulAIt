/**
 * ADR-0187 (batch 5, AgentCoordination §4.10) — MOCK FIXTURES for the engine
 * routes, for Codex's X26 (Engines page), X27 (run and result views on
 * Red-teaming and Evaluations) and X28 (Model artifacts). Shapes, status codes
 * and error codes mirror apps/gateway/src/engines.ts and engine-runs.ts on
 * `b5-foundation`; `zz-b5-engines.test.ts` pins the real ones. A stateful
 * in-test mock: every call is recorded so a spec can assert what the page sent.
 * Not a spec itself.
 *
 * The states a page must render honestly are all here: an engine not built, an
 * engine whose self-test failed on egress, an enabled one; runs that are
 * queued, awaiting approval, leased, completed (pass and fail), failed with
 * every item unknown, timed out, cancelled, and not run; items that are
 * not_run (egress_denied, cloud_only) and unmapped. None is ever a pass.
 *
 * B5-M (ADR-0187 decisions 104 onward): model artifacts and their scans in every
 * verdict — `clean` (a verified safetensors file, the only admissible one),
 * `no_known_unsafe` (an executable format: never admissible, carries an
 * `executable_format` finding), `unsafe`, `unknown` and `not_run` — with the
 * gateway's chip wording, which never says "safe". The upload mock decides the
 * format from the first bytes as a stand-in for the gateway's detection.
 *
 * Decision 127 (bounded storage): the upload refuses 409 / 413
 * `artifact_quota_exceeded` past the uploader's strict quotas (20 artifacts,
 * 2048 MiB); DELETE answers 409 `artifact_in_use` for an artifact whose scan is
 * cited as model-card evidence (the verified safetensors file here), 403
 * `step_up_required` without `x-regulait-step-up`, and 200 `{deleted}` with it.
 */
import type { Page, Route } from "@playwright/test";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export const ENGINE_AGENT = "99999999-0000-4000-8000-000000000001";
export const ENGINE_JUDGE = "99999999-0000-4000-8000-000000000002";
export const ENGINE_PROJECT = "99999999-0000-4000-8000-000000000003";
export const ENGINE_USER = "99999999-0000-4000-8000-000000000004";
export const RUNNER_PF = "99999999-0000-4000-8000-0000000000a1";
export const RUNNER_GK = "99999999-0000-4000-8000-0000000000a2";
const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const DIGEST_PF = `sha256:${"a".repeat(64)}`;
const DIGEST_GK = `sha256:${"b".repeat(64)}`;

const UNVERIFIED = [
  "image digest and signature (the image is built in the engine's own PR)",
  "air-gapped runtime behaviour",
  "maintainer count",
  "transitive licences inside the image",
  "exit codes and report schema",
];

function engine(over: Json): Json {
  return {
    kind: "redteam",
    licence: "MIT",
    maintainerCount: null,
    lastVerified: "2026-10-08",
    reCheckBy: "2027-01-08",
    enabled: false,
    timeoutSeconds: 1800,
    maxBudgetUsd: 5,
    maxConcurrent: 1,
    selfTest: null,
    selfTestPassedAt: null,
    needsModelAccess: true,
    airGappedReducedSet: [],
    unverified: UNVERIFIED,
    runners: [],
    lastRun: null,
    ...over,
    usageDataPosture: { switches: over.switches ?? {}, unverified: UNVERIFIED, airGappedReducedSet: over.airGappedReducedSet ?? [] },
  };
}

/** GET /v1/engines: promptfoo enabled, garak failed its egress self-test, modelscan not built */
export function enginesList(): Json {
  return {
    taxonomyVersion: 1,
    engines: [
      engine({
        id: "promptfoo",
        displayName: "promptfoo",
        version: "0.123.1",
        imageDigest: DIGEST_PF,
        signature: "unverified",
        enabled: true,
        switches: { PROMPTFOO_DISABLE_TELEMETRY: "1", PROMPTFOO_DISABLE_UPDATE: "1" },
        selfTest: { passed: true, failures: [], runnerId: RUNNER_PF, imageDigest: DIGEST_PF, version: "0.123.1", egress: { host: "example.com", dnsResolved: false, connected: false, address: "93.184.215.14", addressConnected: false }, at: iso(30) },
        selfTestPassedAt: iso(30),
        runners: [{ id: RUNNER_PF, name: "promptfoo-runner-1", reportedDigest: DIGEST_PF, reportedVersion: "0.123.1", selfTestPassed: true, selfTestFailures: [], registeredAt: iso(40), lastSeenAt: iso(1) }],
        lastRun: { id: RUNS.completedFail.id, status: "completed", createdAt: iso(20) },
      }),
      engine({ id: "modelscan", kind: "model_scan", displayName: "modelscan", version: "0.8.8", licence: "Apache-2.0", imageDigest: null, signature: "not_built", needsModelAccess: false, reCheckBy: "2027-02-18", switches: { REGULAIT_MODELSCAN_SCANNER_ISOLATED: "1" }, airGappedReducedSet: [{ key: "format", reason: "unsupported_format" }, { key: "modelscan/scan", reason: "unsupported_format" }] }),
      engine({
        id: "garak",
        displayName: "garak",
        version: "0.17.0",
        licence: "Apache-2.0",
        imageDigest: DIGEST_GK,
        signature: "unverified",
        switches: { HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" },
        selfTest: { passed: false, failures: ["egress_dns_resolved"], runnerId: RUNNER_GK, imageDigest: DIGEST_GK, version: "0.17.0", egress: { host: "example.com", dnsResolved: true, connected: false, address: "93.184.215.14", addressConnected: false }, at: iso(10) },
        runners: [{ id: RUNNER_GK, name: "garak-runner-1", reportedDigest: DIGEST_GK, reportedVersion: "0.17.0", selfTestPassed: false, selfTestFailures: ["egress_dns_resolved"], registeredAt: iso(12), lastSeenAt: iso(11) }],
      }),
    ],
  };
}

function run(id: string, over: Json): Json {
  return {
    id,
    engineId: "promptfoo",
    engineVersion: "0.123.1",
    trigger: "manual",
    runAsUserId: ENGINE_USER,
    projectId: ENGINE_PROJECT,
    targetKind: "agent",
    targetAgentId: ENGINE_AGENT,
    judgeAgentId: ENGINE_JUDGE,
    targetArtifactId: null,
    config: { sets: ["basic"], params: {} },
    configHash: "c".repeat(64),
    agentConfigHash: "d".repeat(64),
    trials: 3,
    budgetUsd: 2,
    costUsd: 0,
    timeoutSeconds: 1800,
    virtualKeyId: null,
    runnerId: null,
    approvalId: null,
    scheduleId: null,
    workflowInstanceId: null,
    workflowStageId: null,
    workflowCheckName: null,
    workflowRound: null,
    createdAt: iso(60),
    queueExpiresAt: iso(-1380),
    leasedAt: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    phase: null,
    progress: null,
    deadlineAt: null,
    cancelRequestedAt: null,
    cancelRequestedByUserId: null,
    finishedAt: null,
    errorCode: null,
    summary: null,
    rawReportSha256: null,
    rawReportBytes: null,
    rawReportExpiresAt: null,
    rawReportStored: false,
    redteamRunId: null,
    evalRunId: null,
    ...over,
  };
}

const summary = (verdict: string, counts: Json, extra: Json = {}) => ({
  verdict,
  counts,
  mappedItems: 2,
  unmappedItems: 1,
  asr: null,
  asrInterval: null,
  asrTrials: 0,
  measurementQuality: "not-run",
  classes: [],
  taxonomyVersion: 1,
  explanation: "",
  cause: "result",
  ...extra,
});

/** one run in every status a page must render */
export const RUNS = {
  queued: run("99999999-1111-4000-8000-000000000001", { status: "queued" }),
  awaitingApproval: run("99999999-1111-4000-8000-000000000002", { status: "awaiting_approval", config: { sets: ["agentic"], params: {} }, approvalId: "99999999-2222-4000-8000-000000000001" }),
  leased: run("99999999-1111-4000-8000-000000000003", { status: "leased", runnerId: RUNNER_PF, leasedAt: iso(5), leaseExpiresAt: iso(-1), heartbeatAt: iso(0), phase: "running", progress: 0.4, deadlineAt: iso(-25), virtualKeyId: "99999999-3333-4000-8000-000000000001" }),
  completedFail: run("99999999-1111-4000-8000-000000000004", {
    status: "completed",
    finishedAt: iso(20),
    costUsd: 0.42,
    redteamRunId: "99999999-4444-4000-8000-000000000001",
    evalRunId: "99999999-5555-4000-8000-000000000001",
    rawReportSha256: "e".repeat(64),
    rawReportBytes: 18432,
    rawReportStored: true,
    summary: summary("fail", { pass: 1, fail: 1, unknown: 0, not_run: 2 }, { asr: 0.1667, asrInterval: { lower: 0.0301, upper: 0.5636 }, asrTrials: 6, measurementQuality: "low-power", explanation: "run completed: 1 pass, 1 fail, 0 unknown, 2 not run; 2 of 5 items map to a measured class (taxonomy v1)" }),
  }),
  completedPass: run("99999999-1111-4000-8000-000000000005", { status: "completed", finishedAt: iso(15), summary: summary("pass", { pass: 2, fail: 0, unknown: 0, not_run: 0 }) }),
  failedUnknown: run("99999999-1111-4000-8000-000000000006", { status: "failed", errorCode: "engine_crashed", finishedAt: iso(14), summary: summary("unknown", { pass: 0, fail: 0, unknown: 2, not_run: 0 }, { explanation: "run failed: 0 pass, 0 fail, 2 unknown, 0 not run" }) }),
  timeout: run("99999999-1111-4000-8000-000000000007", { status: "timeout", errorCode: "deadline_passed", finishedAt: iso(13), summary: summary("unknown", { pass: 0, fail: 0, unknown: 0, not_run: 0 }, { explanation: "no valid result arrived (run timeout); nothing it did counts as clean", cause: "deadline_passed" }) }),
  cancelled: run("99999999-1111-4000-8000-000000000008", { status: "cancelled", errorCode: "cancelled", finishedAt: iso(12), cancelRequestedAt: iso(12), summary: summary("unknown", { pass: 0, fail: 0, unknown: 0, not_run: 0 }, { cause: "cancelled" }) }),
  notRun: run("99999999-1111-4000-8000-000000000009", { status: "not_run", errorCode: "approval_denied", finishedAt: iso(11), summary: { verdict: "not_run", explanation: "approval denied; nothing ran", cause: "approval_denied" } }),
} as const;

/** the items of RUNS.completedFail */
export function itemsOf(runId: string): Json[] {
  if (runId !== RUNS.completedFail.id) return [];
  const base = { sourceSystem: "promptfoo", scorerKind: null, claimedClass: null, severity: "high", attempts: 3, defeated: 0, reason: null, verdictNote: null, notRunReason: null, dispatchAuditIds: [] };
  return [
    { ...base, key: "pi-1", sourceId: "prompt-injection", attackClass: "prompt_injection", claimedVerdict: "pass", verdict: "pass" },
    { ...base, key: "pii-1", sourceId: "pii", attackClass: "pii_leak", defeated: 1, claimedVerdict: "pass", verdict: "fail", verdictNote: "1 of 3 attempts defeated the target" },
    { ...base, key: "misc-1", sourceId: "something-unmapped", attackClass: null, claimedVerdict: "pass", verdict: "pass" },
    { ...base, key: "pi-egress", sourceId: "prompt-injection", attackClass: "prompt_injection", attempts: 0, claimedVerdict: "pass", verdict: "not_run", notRunReason: "egress_denied", verdictNote: "listed as not run (egress_denied)" },
    { ...base, key: "cloud-thing", sourceId: "cloud-thing", attackClass: null, attempts: 0, severity: "low", claimedVerdict: "not_run", verdict: "not_run", notRunReason: "cloud_only", verdictNote: "not run (cloud_only)" },
  ];
}

/** the chip wording the gateway sends (ARTIFACT_SCAN_CHIP); never "safe" */
export const ARTIFACT_CHIP: Record<string, string> = {
  clean: "Non-executable format verified; no finding",
  no_known_unsafe: "No known-unsafe operator found (executable format)",
  unsafe: "Unsafe operator found",
  unknown: "Scan inconclusive",
  not_run: "Not scanned (unsupported format)",
};

function artifact(id: string, format: string, executable: boolean, filename: string, sizeBytes: number): Json {
  return { id, sha256: id.replace(/-/g, "").padEnd(64, "0").slice(0, 64), sizeBytes, format, executable, formatDescription: null, filename, projectId: null, uploadedByUserId: ENGINE_USER, createdAt: iso(90) };
}
function scan(artifactId: string, verdict: string, format: string, findings: Json[]): Json {
  return { id: artifactId.replace(/^99999999-8888/, "99999999-9999"), artifactId, engineRunId: null, sha256: artifactId.replace(/-/g, "").padEnd(64, "0").slice(0, 64), format, verdict, chip: ARTIFACT_CHIP[verdict], admissible: verdict === "clean", findings, scannerVersion: "0.8.8", createdAt: iso(80) };
}

/** B5-M: one artifact per scan verdict (the format decided from the bytes, the name display only) */
export const ARTIFACTS = {
  safetensors: artifact("99999999-8888-4000-8000-000000000001", "safetensors", false, "weights.safetensors", 4096),
  cleanPickle: artifact("99999999-8888-4000-8000-000000000002", "pickle", true, "model.pkl", 2048),
  renamedPickle: artifact("99999999-8888-4000-8000-000000000003", "pickle", true, "model.safetensors", 77),
  truncated: artifact("99999999-8888-4000-8000-000000000004", "pickle", true, "broken.pkl", 40),
  gguf: artifact("99999999-8888-4000-8000-000000000005", "gguf", false, "model.gguf", 8192),
} as const;
/** decision 127: the strict per-uploader quotas the gateway enforces (org settings, larger relaxes) */
export const ARTIFACT_QUOTA = { uploaderCount: 20, uploaderMegabytes: 2048 } as const;
/** decision 127: artifacts a model card cites a scan of (DELETE answers 409 `artifact_in_use`) */
export const ARTIFACTS_IN_USE: Record<string, { citedScans: number; unfinishedRuns: number }> = {
  "99999999-8888-4000-8000-000000000001": { citedScans: 1, unfinishedRuns: 0 },
};
export const ARTIFACT_SCANS: Record<string, Json[]> = {
  [ARTIFACTS.safetensors.id]: [scan(ARTIFACTS.safetensors.id, "clean", "safetensors", [])],
  [ARTIFACTS.cleanPickle.id]: [scan(ARTIFACTS.cleanPickle.id, "no_known_unsafe", "pickle", [{ kind: "executable_format", id: "pickle", severity: "high" }])],
  [ARTIFACTS.renamedPickle.id]: [
    scan(ARTIFACTS.renamedPickle.id, "unsafe", "pickle", [
      { kind: "unsafe_operator", id: "os.system", severity: "critical" },
      { kind: "executable_format", id: "pickle", severity: "high" },
    ]),
  ],
  [ARTIFACTS.truncated.id]: [
    scan(ARTIFACTS.truncated.id, "unknown", "pickle", [
      { kind: "scan_error", id: "PICKLE_GENOPS", severity: "medium" },
      { kind: "executable_format", id: "pickle", severity: "high" },
    ]),
  ],
  [ARTIFACTS.gguf.id]: [scan(ARTIFACTS.gguf.id, "not_run", "gguf", [])],
};

export interface EnginesMockState {
  engines: Json;
  runs: Json[];
  artifacts: Json[];
  calls: Array<{ method: string; path: string; body: Json; headers: Record<string, string> }>;
}

const json = (route: Route, status: number, body?: Json) =>
  route.fulfill({ status, contentType: "application/json", body: body === undefined ? "" : JSON.stringify(body) });

/**
 * Answer the §4.10 routes from in-memory state. A relaxing PATCH (enabling, a
 * longer timeout, a higher ceiling, more concurrency) answers 403
 * `step_up_required` unless the request carries `x-regulait-step-up`, exactly
 * as the gateway does; enabling an engine whose self-test did not pass answers
 * 409 `engine_self_test_required`.
 */
export async function installEnginesMock(page: Page, init: Partial<EnginesMockState> = {}): Promise<EnginesMockState> {
  const state: EnginesMockState = {
    engines: init.engines ?? enginesList(),
    runs: init.runs ?? Object.values(RUNS).map((r) => ({ ...r })),
    artifacts: init.artifacts ?? Object.values(ARTIFACTS).map((a) => ({ ...a })),
    calls: [],
  };
  await page.route(/\/v1\/(engines|engine-runs|engine-runners|engine-schedules|model-artifacts)(\/|\?|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const p = url.pathname;
    const method = req.method();
    const isJson = (req.headers()["content-type"] ?? "").startsWith("application/json");
    const body = isJson && req.postData() ? JSON.parse(req.postData()!) : undefined;
    const headers = req.headers();
    state.calls.push({ method, path: p, body, headers });
    const engineMatch = /^\/v1\/engines\/([a-z]+)(\/.*)?$/.exec(p);
    if (method === "GET" && p === "/v1/engines") return json(route, 200, state.engines);
    if (engineMatch) {
      const e = state.engines.engines.find((x: Json) => x.id === engineMatch[1]);
      if (!e) return json(route, 404, { error: "engine_not_found" });
      const sub = engineMatch[2] ?? "";
      if (method === "GET" && sub === "") return json(route, 200, e);
      if (method === "PATCH" && sub === "") {
        if (body.enabled === true && !e.enabled && !e.selfTest?.passed) {
          return json(route, 409, { error: "engine_self_test_required", detail: `engine ${e.id} cannot be enabled: no passing runner self-test is recorded.` });
        }
        const values: Json = {};
        if (body.enabled === true && !e.enabled) values[`engine.${e.id}.enabled`] = true;
        for (const f of ["timeoutSeconds", "maxBudgetUsd", "maxConcurrent"]) {
          if (body[f] !== undefined && body[f] > e[f]) values[`engine.${e.id}.${f}`] = body[f];
        }
        if (Object.keys(values).length > 0 && !headers["x-regulait-step-up"]) {
          return json(route, 403, { error: "step_up_required", actionKind: "settings_relax", methods: ["passkey", "totp"], action: { kind: "settings_relax", body: { values } } });
        }
        Object.assign(e, body);
        return json(route, 200, e);
      }
      if (method === "POST" && sub === "/self-test") return json(route, 200, e.selfTest ?? { passed: false, failures: ["no_runner"], runnerId: null, imageDigest: null, version: null, egress: null, at: new Date().toISOString() });
      if (method === "POST" && sub === "/enrollment-tokens") {
        return json(route, 201, { id: "99999999-6666-4000-8000-000000000001", engineId: e.id, token: `rgee_${"f".repeat(64)}`, expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() });
      }
    }
    const runnerMatch = /^\/v1\/engine-runners\/([0-9a-f-]+)$/.exec(p);
    if (runnerMatch && method === "DELETE") {
      for (const e of state.engines.engines) e.runners = e.runners.filter((r: Json) => r.id !== runnerMatch[1]);
      return json(route, 200, { id: runnerMatch[1], revokedAt: new Date().toISOString(), endedRuns: 0 });
    }
    if (p === "/v1/engine-runs" && method === "GET") {
      const engineId = url.searchParams.get("engineId");
      const status = url.searchParams.get("status");
      return json(route, 200, { runs: state.runs.filter((r) => (!engineId || r.engineId === engineId) && (!status || r.status === status)) });
    }
    if (p === "/v1/engine-runs" && method === "POST") {
      const sensitive = (body.config?.sets ?? []).some((s: string) => s !== "basic");
      if (sensitive && !body.approverUserId) return json(route, 422, { error: "engine_approver_required", detail: "this run uses an agentic, offensive or unclassified set, so it waits for approval" });
      const r = run(`99999999-7777-4000-8000-${String(state.runs.length).padStart(12, "0")}`, {
        engineId: body.engineId,
        status: sensitive ? "awaiting_approval" : "queued",
        config: body.config,
        projectId: body.projectId ?? null,
        targetAgentId: body.target?.agentId ?? null,
        judgeAgentId: body.target?.judgeAgentId ?? null,
        createdAt: new Date().toISOString(),
      });
      state.runs.unshift(r);
      return json(route, 202, { run: r, approvalId: sensitive ? "99999999-2222-4000-8000-000000000009" : null });
    }
    const runMatch = /^\/v1\/engine-runs\/([0-9a-f-]+)(\/cancel)?$/.exec(p);
    if (runMatch) {
      const r = state.runs.find((x) => x.id === runMatch[1]);
      if (!r) return json(route, 404, { error: "engine_run_not_found" });
      if (method === "GET" && !runMatch[2]) return json(route, 200, { run: r, items: itemsOf(r.id) });
      if (method === "POST" && runMatch[2]) {
        if (["completed", "failed", "timeout", "cancelled", "not_run"].includes(r.status)) return json(route, 409, { error: "engine_run_finished", status: r.status });
        Object.assign(r, { status: "cancelled", errorCode: "cancelled", finishedAt: new Date().toISOString(), cancelRequestedAt: new Date().toISOString() });
        return json(route, 200, { run: r });
      }
    }
    if (p === "/v1/engine-schedules" && method === "GET") return json(route, 200, { schedules: [] });
    if (p === "/v1/model-artifacts" && method === "GET") return json(route, 200, { artifacts: state.artifacts });
    if (p === "/v1/model-artifacts" && method === "POST") {
      if ((headers["content-type"] ?? "") !== "application/octet-stream") return json(route, 415, { error: "artifact_content_type", detail: "send the artifact's bytes as application/octet-stream" });
      const bytes = req.postDataBuffer() ?? new Uint8Array(0);
      const mine = state.artifacts.filter((x) => x.uploadedByUserId === ENGINE_USER);
      const used = mine.reduce((n, x) => n + x.sizeBytes, 0);
      if (mine.length + 1 > ARTIFACT_QUOTA.uploaderCount) {
        return json(route, 409, { error: "artifact_quota_exceeded", scope: "uploader", measure: "count", setting: "modelArtifactUploaderQuotaCount", limit: ARTIFACT_QUOTA.uploaderCount, used: mine.length, detail: `this upload would take your model artifacts past ${ARTIFACT_QUOTA.uploaderCount} stored artifacts (modelArtifactUploaderQuotaCount): delete artifacts no longer needed, or an admin may raise the quota (the change needs a step-up)` });
      }
      if (used + bytes.length > ARTIFACT_QUOTA.uploaderMegabytes * 1024 * 1024) {
        return json(route, 413, { error: "artifact_quota_exceeded", scope: "uploader", measure: "bytes", setting: "modelArtifactUploaderQuotaMegabytes", limit: ARTIFACT_QUOTA.uploaderMegabytes * 1024 * 1024, used, detail: `this upload would take your model artifacts past ${ARTIFACT_QUOTA.uploaderMegabytes} MiB of stored artifacts (modelArtifactUploaderQuotaMegabytes): delete artifacts no longer needed, or an admin may raise the quota (the change needs a step-up)` });
      }
      // a stand-in for the gateway's content detection: never the file name
      const format = bytes.length === 0 ? "empty" : bytes[0] === 0x80 ? "pickle" : bytes[8] === 0x7b ? "safetensors" : "unrecognised";
      const a = artifact(`99999999-8888-4000-8000-${String(state.artifacts.length + 100).padStart(12, "0")}`, format, format !== "safetensors" && format !== "empty", url.searchParams.get("filename") ?? "artifact", bytes.length);
      state.artifacts.unshift(a);
      return json(route, 201, { artifact: a });
    }
    const artifactMatch = /^\/v1\/model-artifacts\/([0-9a-f-]+)$/.exec(p);
    if (artifactMatch && method === "GET") {
      const a = state.artifacts.find((x) => x.id === artifactMatch[1]);
      if (!a) return json(route, 404, { error: "unknown_artifact" });
      return json(route, 200, { artifact: a, scans: ARTIFACT_SCANS[a.id] ?? [] });
    }
    if (artifactMatch && method === "DELETE") {
      const i = state.artifacts.findIndex((x) => x.id === artifactMatch[1]);
      if (i < 0) return json(route, 404, { error: "unknown_artifact" });
      const a = state.artifacts[i];
      const refs = ARTIFACTS_IN_USE[a.id];
      if (refs) {
        return json(route, 409, { error: "artifact_in_use", ...refs, detail: "a scan of this artifact is cited as model-card evidence, or a run on it has not finished: remove the citation or wait for the run, then delete it" });
      }
      if (!headers["x-regulait-step-up"]) {
        const action = { kind: "settings_relax", body: { modelArtifactId: a.id, values: { deleted: true } } };
        return json(route, 403, { error: "step_up_required", actionKind: "settings_relax", methods: ["passkey", "totp"], action });
      }
      state.artifacts.splice(i, 1);
      return json(route, 200, { deleted: { id: a.id, sha256: a.sha256, scansDeleted: (ARTIFACT_SCANS[a.id] ?? []).length, object: "deleted" } });
    }
    return json(route, 404, { error: "not_found" });
  });
  return state;
}
