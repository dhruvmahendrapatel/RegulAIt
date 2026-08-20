/**
 * ADR-0088 — registered external eval scorers, end to end.
 *
 * The pattern is custom-providers.test.ts's: a REAL local HTTP server speaking
 * the real wire contract, the REAL adapter, the REAL egress guard (which
 * blocks loopback until an admin allow-lists 127.0.0.1 with private ranges +
 * plaintext — the exact sequence an operator performs for an on-prem scoring
 * shim), no network, no mocking of the thing under test.
 *
 * What this file makes impossible to fake:
 *
 *  1. AN ADAPTER THAT SCORES WITHOUT CALLING OUT. The fake endpoint decides
 *     the score from the request body (grounded → 1, fabricated → 0), and the
 *     GAP between two cases over the same context is asserted end to end,
 *     along with the exact wire shape the endpoint saw. An always-1.0 stub
 *     fails both.
 *  2. A VENDOR'S SCORE WEARING SOMEBODY ELSE'S NAME. Every row an external
 *     instrument scores must carry `method: "external:<name>"` — on the
 *     result row AND in the groundedness summary, which reports the external
 *     figure under its own label, never averaged into 'model-judged'.
 *  3. THE ADR-0067 REFUSAL EVAPORATING. A named-but-unknown / disabled /
 *     kind-mismatched / egress-refused scorer must 422 BEFORE any row is
 *     written; a MID-RUN failure (non-conforming reply, HTTP 500) must be a
 *     recorded scorer ERROR on the row — never a silent 0 or 1 presented as
 *     the instrument's verdict.
 *  4. A LEXICAL METRIC ROUTING EXTERNALLY. Refused at authoring time, and a
 *     lexical run leaves the fake endpoint's hit counter untouched.
 *  5. THE EGRESS GUARD NOT RUNNING. Default-deny before an allow entry, IMDS
 *     refused even when allow-listed, and the same refusal standing under
 *     REGULAIT_DEPLOY_MODE=air_gapped (ADR-0062: the air-gapped posture is
 *     code-enforced; a typed scorer URL is strictly adjudicated in EVERY
 *     mode, so the strict mode inherits it rather than needing new code).
 *
 * SHARED-STATE DISCIPLINE: every object is `xs-` prefixed; the env var this
 * file touches (REGULAIT_DEPLOY_MODE) is restored in a `finally` in the same
 * test (M-012); row assertions are deltas or scoped to this file's own ids.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  and,
  auditLog,
  createDb,
  desc,
  eq,
  egressAllowHosts,
  evalResults,
  evalRuns,
  externalScorers,
  runMigrations,
  type Db,
} from "@regulait/db";

declare global {
  // eslint-disable-next-line no-var
  var __xsProviderCalls: Array<{ model: string; input: string }>;
}
globalThis.__xsProviderCalls = [];

/** the retrieved corpus the groundedness cases are scored against */
const CONTEXT = [
  "The Helios payment gateway retains cardholder data for 90 days.",
  "Incident INC-4471 remediation was signed off by Priya Raman.",
];
const QUESTION = "<<xs-q>> How long is cardholder data retained, and who signed off INC-4471?";
const GROUNDED = "Cardholder data is retained for 90 days, and Priya Raman signed off the INC-4471 remediation.";
const FABRICATED = "Cardholder data is retained for 400 days, and Marcus Delaney signed off the INC-8892 remediation.";

const CANNED: Array<[string, string]> = [
  ["<<xs-grounded>>", GROUNDED],
  ["<<xs-fabricated>>", FABRICATED],
];

vi.mock("@regulait/model-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@regulait/model-provider")>();
  return {
    ...actual,
    resolveModelProvider: (
      ...args: Parameters<typeof actual.resolveModelProvider>
    ): ReturnType<typeof actual.resolveModelProvider> => {
      const inner = actual.resolveModelProvider(...args);
      const wrapped = Object.create(inner as object) as typeof inner;
      wrapped.dispatch = async (req: Parameters<typeof inner.dispatch>[0]) => {
        const input = req.input ?? "";
        globalThis.__xsProviderCalls.push({ model: req.model, input });
        const hit = CANNED.find(([sentinel]) => input.includes(sentinel));
        if (!hit) return inner.dispatch(req);
        return {
          outputText: hit[1],
          stopReason: "end_turn",
          refusal: false,
          usage: { inputTokens: 20, outputTokens: 30 },
          providerMessageId: "xs-mock-1",
        };
      };
      return wrapped;
    },
  };
});

const { buildApp } = await import("./app.js");
const { runEvalSuite } = await import("./evals.js");
const { callExternalScorer, resolveExternalScorersByName, EXTERNAL_SCORER_TIMEOUT_MS } =
  await import("./external-scorers.js");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "xs-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const DATA_KEY = "f".repeat(64);
const SHIM_KEY = "xs-shim-secret-key";

let db: Db;
let app: ReturnType<typeof buildApp>;
let srv: http.Server;
let port: number;
let graceId: string;
let subjectAgentId: string;

/** every scoring request the fake endpoint saw, so we can assert on the wire */
const hits: Array<{ url: string; auth: string | null; body: Record<string, unknown> }> = [];

/** how the fake endpoint behaves — mutable, so ONE tested-and-enabled scorer
 * can be driven into every failure mode without re-arming the enable gate */
let serverMode: "ok" | "nonconforming" | "outofrange" | "http500" | "hang" = "ok";

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: DATA_KEY });
  // hermetic default-deny: start from the shipped empty allow-list
  await db.delete(egressAllowHosts);

  // A local scoring endpoint speaking OUR contract. It decides the score from
  // the OUTPUT it is sent — a grounded answer scores 1, a fabricated one 0
  // with reasons — so an adapter that fakes the call cannot reproduce the gap.
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (serverMode === "hang") return; // never answer; the timeout test owns this
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      hits.push({
        url: req.url ?? "",
        auth: (req.headers.authorization as string) ?? null,
        body,
      });
      if (serverMode === "http500") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("scoring backend fell over");
        return;
      }
      if (serverMode === "nonconforming") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ verdict: "looks fine to me" }));
        return;
      }
      if (serverMode === "outofrange") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ score: 3 }));
        return;
      }
      const output = String(body.output ?? "");
      const grounded = output.includes("90 days") && output.includes("Priya Raman");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          grounded
            ? { score: 1 }
            : { score: 0, reasons: ["figure '400 days' not supported by context", "signatory not in context"] },
        ),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  port = (srv.address() as { port: number }).port;

  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: "xs-grace@example.com", displayName: "xs grace" },
  });
  graceId = u.json().id;

  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: "xs-subject", provider: "mock", model: "mock-balanced", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15 },
  });
  expect(a.statusCode).toBe(201);
  subjectAgentId = a.json().id;
  await app.inject({
    method: "POST",
    url: "/v1/grants/agents",
    headers: AUTH,
    payload: { userId: graceId, agentId: subjectAgentId },
  });
});

afterAll(async () => {
  srv.closeAllConnections();
  await new Promise<void>((r) => srv.close(() => r()));
  await app.close();
});

const scoreUrl = () => `http://127.0.0.1:${port}/score`;

async function makeDataset(name: string, scorerKind: string, scorerConfig: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/v1/evals/datasets",
    headers: AUTH,
    payload: { name, scorerKind, scorerConfig },
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

async function addCase(datasetId: string, payload: Record<string, unknown>, expectStatus = 201) {
  const res = await app.inject({
    method: "POST",
    url: `/v1/evals/datasets/${datasetId}/cases`,
    headers: AUTH,
    payload,
  });
  expect(res.statusCode).toBe(expectStatus);
  return res;
}

const run = (datasetId: string) =>
  runEvalSuite(db, DATA_KEY, { datasetId, agentId: subjectAgentId, userId: graceId, trigger: "manual" });

// ---------------------------------------------------------------------------
// egress: default-deny, SSRF, air-gapped
// ---------------------------------------------------------------------------

describe("the scorer URL is a typed destination under the full egress guard", () => {
  it("refuses to register a scorer whose host nobody has allow-listed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/external-scorers",
      headers: AUTH,
      payload: { name: "xs-premature", baseUrl: scoreUrl(), scorerKinds: ["groundedness_judge"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    expect(res.json().code).toBe("host_not_allowlisted");
    const [deny] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "external_scorer"), eq(auditLog.ruleId, "egress-blocked")))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(deny?.effect).toBe("deny");
  });

  it("refuses an IMDS baseUrl outright, allow-listed or not", async () => {
    const listed = await app.inject({
      method: "POST",
      url: "/v1/egress-allow-hosts",
      headers: AUTH,
      payload: { host: "169.254.169.254", note: "deliberate SSRF attempt for the test" },
    });
    expect(listed.statusCode).toBe(201);
    const res = await app.inject({
      method: "POST",
      url: "/v1/external-scorers",
      headers: AUTH,
      payload: {
        name: "xs-imds",
        baseUrl: "http://169.254.169.254/latest/meta-data/",
        scorerKinds: ["groundedness_judge"],
        allowPlaintextHttp: true,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("egress_blocked");
    await app.inject({
      method: "DELETE",
      url: `/v1/egress-allow-hosts/${listed.json().id}`,
      headers: AUTH,
    });
  });

  it("REFUSES in air-gapped mode exactly as everywhere else — the posture is inherited, not bolted on", async () => {
    // ADR-0062: air_gapped is the STRICT egress posture, enforced in code. A
    // typed scorer URL never had a compiled-default bypass to close: it is
    // default-deny in EVERY mode, and this test pins that the refusal stands
    // with the air-gapped mode actually set.
    const prior = process.env.REGULAIT_DEPLOY_MODE;
    process.env.REGULAIT_DEPLOY_MODE = "air_gapped";
    try {
      const { resolveDeployMode, modeEgressPosture } = await import("./deploy-posture.js");
      expect(resolveDeployMode()).toBe("air_gapped");
      expect(modeEgressPosture(resolveDeployMode())).toBe("strict");
      const res = await app.inject({
        method: "POST",
        url: "/v1/external-scorers",
        headers: AUTH,
        payload: {
          name: "xs-airgap-saas",
          baseUrl: "https://scoring.fiddler.example/v1/score",
          scorerKinds: ["groundedness_judge"],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("egress_blocked");
      expect(res.json().code).toBe("host_not_allowlisted");
      const rows = await db.select().from(externalScorers).where(eq(externalScorers.name, "xs-airgap-saas"));
      expect(rows).toHaveLength(0);
    } finally {
      // M-012: restore the singleton in the same test
      if (prior === undefined) delete process.env.REGULAIT_DEPLOY_MODE;
      else process.env.REGULAIT_DEPLOY_MODE = prior;
    }
  });
});

// ---------------------------------------------------------------------------
// lifecycle: register → test → enable
// ---------------------------------------------------------------------------

let shimId: string;
const SHIM = "xs-fiddler-shim";

describe("register → test → enable, the custom-provider lifecycle verbatim", () => {
  it("registers DISABLED once 127.0.0.1 is allow-listed, and never returns the key", async () => {
    const allow = await app.inject({
      method: "POST",
      url: "/v1/egress-allow-hosts",
      headers: AUTH,
      payload: {
        host: "127.0.0.1",
        allowPrivateRanges: true,
        allowPlaintextHttp: true,
        note: "xs local scoring shim",
      },
    });
    expect(allow.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: "/v1/external-scorers",
      headers: AUTH,
      payload: {
        name: SHIM,
        baseUrl: scoreUrl(),
        apiKey: SHIM_KEY,
        scorerKinds: ["groundedness_judge", "answer_relevance_judge"],
        allowPlaintextHttp: true,
      },
    });
    expect(res.statusCode).toBe(201);
    shimId = res.json().id;
    expect(res.json().enabled).toBe(false);
    expect(res.json().hasApiKey).toBe(true);
    expect(res.body).not.toContain(SHIM_KEY);
    expect(res.json()).not.toHaveProperty("keyCiphertext");
  });

  it("refuses to enable before a connection test has passed", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/external-scorers/${shimId}/enabled`,
      headers: AUTH,
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("connection_test_required");
  });

  it("the connection test POSTs a real probe and requires a CONFORMING reply", async () => {
    const before = hits.length;
    const res = await app.inject({
      method: "POST",
      url: `/v1/external-scorers/${shimId}/test`,
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(hits.length).toBe(before + 1);
    // the probe rode OUR contract, with the stored secret as a bearer
    const probe = hits[hits.length - 1]!;
    expect(probe.auth).toBe(`Bearer ${SHIM_KEY}`);
    expect(Object.keys(probe.body).sort()).toEqual(["context", "input", "output", "scorerKind"]);

    const enable = await app.inject({
      method: "POST",
      url: `/v1/external-scorers/${shimId}/enabled`,
      headers: AUTH,
      payload: { enabled: true },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().enabled).toBe(true);
  });

  it("a broken endpoint fails the test with a real 502 carrying the reason, and never sets lastTestedAt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/external-scorers",
      headers: AUTH,
      payload: {
        name: "xs-nonconforming",
        baseUrl: scoreUrl(),
        scorerKinds: ["groundedness_judge"],
        allowPlaintextHttp: true,
      },
    });
    expect(res.statusCode).toBe(201);
    serverMode = "nonconforming";
    try {
      const test = await app.inject({
        method: "POST",
        url: `/v1/external-scorers/${res.json().id}/test`,
        headers: AUTH,
        payload: {},
      });
      expect(test.statusCode).toBe(502);
      expect(test.json().error).toBe("connection_test_failed");
      expect(test.json().detail).toMatch(/non-conforming/);
    } finally {
      serverMode = "ok";
    }
    const [row] = await db.select().from(externalScorers).where(eq(externalScorers.name, "xs-nonconforming"));
    expect(row!.lastTestedAt).toBeNull();
    expect(row!.lastTestError).toMatch(/non-conforming/);
  });

  it("the scorers registry lists the instrument WITH the disclosure, where the choice is made", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/evals/scorers", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const ext = res.json().externalScorers;
    expect(ext.disclosure).toMatch(/vendor's opinion/);
    expect(ext.disclosure).toMatch(/does not validate the instrument/);
    const mine = ext.scorers.find((s: { name: string }) => s.name === SHIM);
    expect(mine).toBeTruthy();
    expect(mine.scorerKinds).toEqual(["groundedness_judge", "answer_relevance_judge"]);
    expect(mine.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// scoring end to end — the gap, the wire, the method stamp
// ---------------------------------------------------------------------------

describe("an externally-scored run: real call, real gap, honest provenance", () => {
  it("scores through the endpoint, stamps method external:<name>, and no judge is required", async () => {
    const ds = await makeDataset("xs-external-gap", "groundedness_judge", {
      externalScorer: SHIM,
      threshold: 0.5,
    });
    const grounded = (await addCase(ds, { input: `${QUESTION} <<xs-grounded>>`, context: CONTEXT })).json().id;
    const fabricated = (await addCase(ds, { input: `${QUESTION} <<xs-fabricated>>`, context: CONTEXT })).json().id;

    const before = hits.length;
    // NO judgeAgentId anywhere: were the external path not honored, the
    // ADR-0067 pre-flight would refuse this run with judge_required.
    const outcome = await run(ds);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // the endpoint was REALLY called, once per case, on OUR wire contract
    expect(hits.length).toBe(before + 2);
    const wire = hits.slice(-2);
    for (const h of wire) {
      expect(h.auth).toBe(`Bearer ${SHIM_KEY}`);
      expect(h.body.scorerKind).toBe("groundedness_judge");
      expect(h.body.context).toEqual(CONTEXT);
      // the RAW case input rides the contract, not the context-framed prompt
      expect(String(h.body.input)).toContain("<<xs-q>>");
      expect(String(h.body.input)).not.toContain("CONTEXT:");
    }

    const rows = await db.select().from(evalResults).where(eq(evalResults.runId, outcome.run.id));
    const byCase = new Map(rows.map((r) => [r.caseId, r]));
    const g = byCase.get(grounded)!;
    const f = byCase.get(fabricated)!;
    // THE GAP — an adapter returning a plausible constant cannot produce it
    expect(g.score).toBe(1);
    expect(g.passed).toBe(true);
    expect(f.score).toBe(0);
    expect(f.passed).toBe(false);
    // THE PROVENANCE STAMP, on every row the instrument scored
    expect(g.detail.method).toBe(`external:${SHIM}`);
    expect(f.detail.method).toBe(`external:${SHIM}`);
    expect(f.detail.reasons).toEqual([
      "figure '400 days' not supported by context",
      "signatory not in context",
    ]);
    expect(g.error).toBeNull();
    expect(f.error).toBeNull();

    // the run detail rolls the external figure up under ITS OWN method label
    const detail = await app.inject({ method: "GET", url: `/v1/evals/runs/${outcome.run.id}`, headers: AUTH });
    const summary = detail.json().groundedness;
    expect(summary.metrics).toHaveLength(1);
    expect(summary.metrics[0].metric).toBe("groundedness_judge");
    expect(summary.metrics[0].method).toBe(`external:${SHIM}`);
    expect(summary.metrics[0].cases).toBe(2);
    expect(summary.note).toMatch(/external:<name>/);
  });

  it("a lexical run NEVER touches the endpoint, and a lexical case cannot even author the routing", async () => {
    const refused = await makeDataset("xs-lexical-refused", "claim_support");
    const res = await addCase(
      refused,
      { input: `${QUESTION} <<xs-grounded>>`, context: CONTEXT, scorerConfig: { externalScorer: SHIM } },
      422,
    );
    expect(res.json().error).toBe("unusable_scorer_config");
    expect(res.json().detail).toMatch(/NEVER routes to an external endpoint/);

    const lexical = await makeDataset("xs-lexical-local", "claim_support");
    await addCase(lexical, { input: `${QUESTION} <<xs-grounded>>`, context: CONTEXT });
    const before = hits.length;
    const outcome = await run(lexical);
    expect(outcome.ok).toBe(true);
    expect(hits.length).toBe(before); // not one call left the box
  });
});

// ---------------------------------------------------------------------------
// the ADR-0067 refusal, extended: 422 before rows
// ---------------------------------------------------------------------------

describe("a named-but-unusable instrument refuses the run BEFORE any row is written", () => {
  async function refusedRun(name: string, config: Record<string, unknown>, kind = "groundedness_judge") {
    const ds = await makeDataset(name, kind, config);
    await addCase(ds, {
      input: `${QUESTION} <<xs-grounded>>`,
      context: CONTEXT,
      ...(kind === "llm_as_judge" ? { expected: GROUNDED } : {}),
    });
    const outcome = await run(ds);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.status).toBe(422);
    // NOT ONE ROW: no run, no results — nothing a reader could mistake for a measurement
    const runs = await db.select().from(evalRuns).where(eq(evalRuns.datasetId, ds));
    expect(runs).toHaveLength(0);
    return outcome;
  }

  it("unknown scorer → external_scorer_unknown, with an audited deny", async () => {
    const outcome = await refusedRun("xs-refuse-unknown", { externalScorer: "xs-ghost" });
    expect(outcome.error).toBe("external_scorer_unknown");
    expect(outcome.detail).toMatch(/will NOT fall back/);
    const [deny] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.ruleId, "external_scorer_unknown"))
      .orderBy(desc(auditLog.at))
      .limit(1);
    expect(deny?.effect).toBe("deny");
  });

  it("disabled scorer → external_scorer_disabled", async () => {
    const reg = await app.inject({
      method: "POST",
      url: "/v1/external-scorers",
      headers: AUTH,
      payload: {
        name: "xs-registered-but-disabled",
        baseUrl: scoreUrl(),
        scorerKinds: ["groundedness_judge"],
        allowPlaintextHttp: true,
      },
    });
    expect(reg.statusCode).toBe(201);
    const outcome = await refusedRun("xs-refuse-disabled", { externalScorer: "xs-registered-but-disabled" });
    expect(outcome.error).toBe("external_scorer_disabled");
  });

  it("a kind the instrument never claimed → external_scorer_kind_mismatch", async () => {
    const outcome = await refusedRun("xs-refuse-kind", { externalScorer: SHIM }, "llm_as_judge");
    expect(outcome.error).toBe("external_scorer_kind_mismatch");
    expect(outcome.detail).toMatch(/does not claim to serve 'llm_as_judge'/);
  });

  it("egress-refused at pre-flight → external_scorer_unreachable (the allow-list changed after enable)", async () => {
    const [entry] = await db.select().from(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
    await db.delete(egressAllowHosts).where(eq(egressAllowHosts.host, "127.0.0.1"));
    try {
      const outcome = await refusedRun("xs-refuse-unreachable", { externalScorer: SHIM });
      expect(outcome.error).toBe("external_scorer_unreachable");
      expect(outcome.detail).toMatch(/not in the egress allow-list/);
    } finally {
      await db.insert(egressAllowHosts).values({
        host: entry!.host,
        allowPrivateRanges: entry!.allowPrivateRanges,
        allowPlaintextHttp: entry!.allowPlaintextHttp,
        note: entry!.note,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// mid-run failure: a recorded ERROR, never a fabricated score
// ---------------------------------------------------------------------------

describe("a mid-run failure is the judge_failed idiom — error on the row, no method stamp", () => {
  async function erroredRun(name: string, mode: typeof serverMode, why: RegExp) {
    const ds = await makeDataset(name, "groundedness_judge", { externalScorer: SHIM });
    await addCase(ds, { input: `${QUESTION} <<xs-grounded>>`, context: CONTEXT });
    serverMode = mode;
    let outcome;
    try {
      outcome = await run(ds);
    } finally {
      serverMode = "ok";
    }
    expect(outcome.ok).toBe(true); // the RUN completes; the CASE records its error
    if (!outcome.ok) throw new Error("unreachable");
    const [row] = await db.select().from(evalResults).where(eq(evalResults.runId, outcome.run.id));
    expect(row!.error).toMatch(/^external_scorer_failed: /);
    expect(row!.error).toMatch(why);
    expect(row!.score).toBe(0);
    expect(row!.passed).toBe(false);
    // NO provenance stamp — the instrument did not score this
    expect(row!.detail.method).toBeUndefined();
    expect(row!.detail.failed).toBe(true);
  }

  it("a non-conforming reply (no score) is an error, never a silent pass/fail", async () => {
    await erroredRun("xs-midrun-nonconforming", "nonconforming", /non-conforming.*no numeric `score`/);
  });

  it("an out-of-range score is refused, never clamped into a measurement", async () => {
    await erroredRun("xs-midrun-outofrange", "outofrange", /outside \[0,1\]/);
  });

  it("an upstream 500 is an error carrying the upstream's own words", async () => {
    await erroredRun("xs-midrun-500", "http500", /HTTP 500.*scoring backend fell over/);
  });

  it("a hung endpoint times out on the bounded deadline", async () => {
    expect(EXTERNAL_SCORER_TIMEOUT_MS).toBeLessThanOrEqual(20_000); // the ceiling is real
    const { resolved } = await resolveExternalScorersByName(db, DATA_KEY, [SHIM]);
    const scorer = resolved.get(SHIM)!;
    serverMode = "hang";
    try {
      await expect(
        callExternalScorer(scorer, { input: "q", output: "a", context: [], scorerKind: "groundedness_judge" }, { timeoutMs: 300 }),
      ).rejects.toThrow(/timed out after 300ms/);
    } finally {
      serverMode = "ok";
      srv.closeAllConnections();
    }
  });
});
