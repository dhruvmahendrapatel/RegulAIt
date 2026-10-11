/**
 * ADR-0081 — the AI risk register (gap L2).
 *
 * The load-bearing property under test: A RISK'S EVIDENCE IS COMPUTED FROM
 * THE REAL LEDGERS AT READ TIME, NEVER HAND-TICKED. The differentiator tests
 * below seed actual ledger rows (audit denials, a red-team run with its ASR
 * statistics, a groundedness eval run, a shadow-AI finding) and watch the
 * evidence move by exactly that delta — and the attestation-only category
 * proves the register says "none — attestation only" instead of inventing a
 * proxy. Non-vacuity was proven the M-002 way during review: constant-ify a
 * resolver branch and the delta assertions here fail; no-op the acceptance
 * audit write and the acceptance-audit assertions fail (documented in
 * ADR-0081).
 *
 * The lifecycle half: status is never PATCHed (refused by name), transitions
 * are audited, and ACCEPTANCE is its own admin-only audited act that freezes
 * the evidence measured at that moment into the audit row.
 *
 * Shares one DB with the other gateway suites (fileParallelism off);
 * everything here is prefixed rk-. Evidence and audit assertions are DELTAS
 * (M-008) — earlier suites legitimately write the same ledgers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aiRisks,
  and,
  auditLog,
  createDb,
  eq,
  evalDatasets,
  evalRuns,
  redteamLibraries,
  redteamRuns,
  runMigrations,
  shadowAiFindings,
  type Db,
} from "@regulait/db";
import { DEFAULT_RISK_LIBRARY } from "@regulait/shared";
import { buildApp } from "./app.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/db/migrations",
);

const BOOT = "rk-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };

let db: Db;
let app: ReturnType<typeof buildApp>;
let omarId: string; // the risk owner (non-admin)
let omarAuth: { authorization: string };
let mallAuth: { authorization: string }; // a stranger (non-admin)

async function makeUser(email: string) {
  const user = await app.inject({
    method: "POST",
    headers: AUTH,
    url: "/v1/users",
    payload: { email, displayName: email.split("@")[0] },
  });
  expect(user.statusCode).toBe(201);
  const key = await app.inject({
    method: "POST",
    headers: AUTH,
    url: `/v1/users/${user.json().id}/keys`,
    payload: { name: "rk-key" },
  });
  return { id: user.json().id as string, auth: { authorization: `Bearer ${key.json().token}` } };
}

async function register(
  extra: Record<string, unknown> = {},
  auth: { authorization: string } = omarAuth,
) {
  const res = await app.inject({
    method: "POST",
    headers: auth,
    url: "/v1/risks",
    payload: {
      title: "rk-risk",
      description: "a named scenario for the register",
      category: "tool_misuse",
      likelihood: "medium",
      impact: "high",
      ...extra,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; status: string; ownerUserId: string };
}

const detailOf = async (id: string, auth = omarAuth) =>
  app.inject({ method: "GET", headers: auth, url: `/v1/risks/${id}` });

interface EvidenceEntryPayload {
  resolver: string;
  kind: string;
  source: string | null;
  queried: string | null;
  measured: Record<string, unknown> | null;
  evidence?: string;
  note?: string;
}

/** one evidence entry from the detail payload, by resolver id */
async function evidenceEntry(riskId: string, resolver: string, auth = omarAuth) {
  const res = await detailOf(riskId, auth);
  expect(res.statusCode).toBe(200);
  const entry = (res.json().evidence.entries as EvidenceEntryPayload[]).find(
    (e) => e.resolver === resolver,
  );
  expect(entry, `resolver ${resolver} missing from evidence`).toBeTruthy();
  return entry!;
}

const auditRows = (riskId: string, ruleId: string) =>
  db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.objectId, riskId), eq(auditLog.ruleId, ruleId)));

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "a".repeat(64) });
  const omar = await makeUser("rk-omar@example.com");
  omarId = omar.id;
  omarAuth = omar.auth;
  mallAuth = (await makeUser("rk-mallory@example.com")).auth;
});

afterAll(async () => {
  await app.close();
  await db.$client.end();
});

describe("the seed library endpoint", () => {
  it("serves the shared library, its fixed evidence mapping, and the disclaimer on its face", async () => {
    const res = await app.inject({ method: "GET", headers: omarAuth, url: "/v1/risks/library" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      library: Array<{ key: string; evidenceResolvers: string[] }>;
      categoryEvidence: Record<string, string[]>;
      disclaimer: string;
    };
    expect(body.library.map((e) => e.key).sort()).toEqual(
      DEFAULT_RISK_LIBRARY.map((e) => e.key).sort(),
    );
    // the control case rides in the library: at least one attestation-only entry
    expect(body.library.some((e) => e.evidenceResolvers.join() === "none")).toBe(true);
    expect(body.categoryEvidence.scope_drift).toEqual(["none"]);
    expect(body.disclaimer).toContain("none — attestation only");
  });
});

describe("registration and ownership", () => {
  it("a non-admin registers a risk they own; the act is audited", async () => {
    const risk = await register({ title: "rk-own" });
    expect(risk.status).toBe("open");
    expect(risk.ownerUserId).toBe(omarId);
    const rows = await auditRows(risk.id, "risk-registered");
    expect(rows.length).toBe(1);
    expect(rows[0]!.effect).toBe("allow");
    expect((rows[0]!.detail as { category: string }).category).toBe("tool_misuse");
  });

  it("a non-admin cannot register a risk owned by someone else; an admin can", async () => {
    const forged = await app.inject({
      method: "POST",
      headers: mallAuth,
      url: "/v1/risks",
      payload: {
        title: "rk-forged-owner",
        description: "d",
        category: "tool_misuse",
        likelihood: "low",
        impact: "low",
        ownerUserId: omarId,
      },
    });
    expect(forged.statusCode).toBe(403);

    const assigned = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/risks",
      payload: {
        title: "rk-admin-assigned",
        description: "d",
        category: "tool_misuse",
        likelihood: "low",
        impact: "low",
        ownerUserId: omarId,
      },
    });
    expect(assigned.statusCode).toBe(201);
    expect(assigned.json().ownerUserId).toBe(omarId);
  });

  it("the bootstrap token must name an owner (no identity of its own)", async () => {
    const res = await app.inject({
      method: "POST",
      headers: AUTH,
      url: "/v1/risks",
      payload: { title: "rk-boot", description: "d", category: "shadow_ai", likelihood: "low", impact: "low" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("owner_required");
  });

  it("unknown scope references refuse with invalid_reference", async () => {
    const res = await app.inject({
      method: "POST",
      headers: omarAuth,
      url: "/v1/risks",
      payload: {
        title: "rk-bad-ref",
        description: "d",
        category: "tool_misuse",
        likelihood: "low",
        impact: "low",
        useCaseId: "00000000-0000-4000-8000-0000000000aa",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_reference", field: "useCaseId" });
  });
});

describe("EVIDENCE IS A QUERY OVER THE REAL LEDGERS (the differentiator)", () => {
  it("pii denial evidence moves by exactly the rows written to the audit ledger — and config vs event evidence are labelled apart", async () => {
    const risk = await register({ title: "rk-pii", category: "data_leakage_pii" });
    const before = await evidenceEntry(risk.id, "pii_denials");
    expect(before.measured).toBeTruthy();
    const baseline = before.measured!.denials;

    // three REAL ledger rows — the exact rows the gateway's PII guard writes
    for (let i = 0; i < 3; i++) {
      await db.insert(auditLog).values({
        userId: omarId,
        objectType: "agent",
        objectId: null,
        detail: { note: "rk-seeded pii block" },
        effect: "deny",
        ruleId: "pii-blocked",
        ruleChain: [],
        reason: "rk-seeded evidence row for the risk register",
      });
    }
    const after = await evidenceEntry(risk.id, "pii_denials");
    expect(after.measured!.denials).toBe((baseline as number) + 3);

    const config = await evidenceEntry(risk.id, "pii_cascade_config");
    expect(config.kind).toBe("configuration");
    expect(after.kind).toBe("measured");
  });

  it("red-team evidence surfaces ADR-0068's ASR verbatim — rate, denominator, and quality label together", async () => {
    const risk = await register({ title: "rk-injection", category: "prompt_injection" });
    const before = await evidenceEntry(risk.id, "redteam_asr");
    const runsBefore = before.measured!.runsInWindow as number;

    // a REAL red-team run row, with the full FK chain the ledger requires
    const [ds] = await db
      .insert(evalDatasets)
      .values({ name: "rk-redteam-ds", version: 1, scorerKind: "contains" })
      .returning();
    const [er] = await db
      .insert(evalRuns)
      .values({
        datasetId: ds!.id,
        datasetVersion: 1,
        agentName: "rk-agent",
        trigger: "manual",
        status: "completed",
      })
      .returning();
    const [lib] = await db
      .insert(redteamLibraries)
      .values({ name: "rk-lib", version: 1 })
      .returning();
    await db.insert(redteamRuns).values({
      libraryId: lib!.id,
      libraryName: "rk-lib",
      libraryVersion: 1,
      evalRunId: er!.id,
      agentName: "rk-agent",
      probes: 10,
      resisted: 7,
      defeated: 3,
      trials: 4,
      asr: 0.25,
      asrLower: 0.12,
      asrUpper: 0.45,
      asrTrials: 40,
      measurementQuality: "measured",
      platformHeld: 2,
    });

    const after = await evidenceEntry(risk.id, "redteam_asr");
    expect(after.measured!.runsInWindow).toBe(runsBefore + 1);
    const latest = after.measured!.latestRun as Record<string, unknown>;
    expect(latest).toMatchObject({
      asr: 0.25,
      asrTrials: 40,
      measurementQuality: "measured",
      platformHeld: 2,
    });
    // the guardrail half is CONFIGURATION evidence beside the measurement
    const guard = await evidenceEntry(risk.id, "guardrail_config");
    expect(guard.kind).toBe("configuration");
    expect(typeof guard.measured!.configsAtBlock).toBe("number");
  });

  it("groundedness evidence counts only groundedness-scored eval runs", async () => {
    const risk = await register({ title: "rk-halluc", category: "hallucination" });
    const before = await evidenceEntry(risk.id, "groundedness_evals");
    const runsBefore = before.measured!.runsInWindow as number;

    const [ds] = await db
      .insert(evalDatasets)
      .values({ name: "rk-grounded-ds", version: 1, scorerKind: "claim_support" })
      .returning();
    await db.insert(evalRuns).values({
      datasetId: ds!.id,
      datasetVersion: 1,
      agentName: "rk-agent",
      trigger: "manual",
      status: "completed",
      cases: 12,
      passedCases: 9,
      passRate: 0.75,
    });

    const after = await evidenceEntry(risk.id, "groundedness_evals");
    expect(after.measured!.runsInWindow).toBe(runsBefore + 1);
    expect(
      after.measured!.latestRun as { passRate: number; scorerKind: string },
    ).toMatchObject({ passRate: 0.75, scorerKind: "claim_support" });
  });

  it("shadow-AI evidence reads the findings ledger", async () => {
    const risk = await register({ title: "rk-shadow", category: "shadow_ai" });
    const before = await evidenceEntry(risk.id, "shadow_findings");
    const openBefore = before.measured!.open as number;

    await db.insert(shadowAiFindings).values({
      subjectKind: "host",
      subject: "rk-laptop-42",
      provider: "rk-unsanctioned-llm",
      signalSources: ["rk-proxy-export"],
      signatureKinds: ["domain"],
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      observationCount: 3,
      severity: "high",
      confidence: "high",
      evidence: [{ note: "rk-redacted lead" }],
    });

    const after = await evidenceEntry(risk.id, "shadow_findings");
    expect(after.measured!.open).toBe(openBefore + 1);
  });

  it("an unmeasured category says so OUTRIGHT: none — attestation only", async () => {
    const risk = await register({ title: "rk-drift", category: "scope_drift" });
    const res = await detailOf(risk.id);
    const entries = res.json().evidence.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBe(1);
    expect(entries[0]).toMatchObject({
      resolver: "none",
      kind: "none",
      evidence: "none — attestation only",
      measured: null,
      source: null,
    });
  });

  it("MEASURED AND DECLARED NEVER BLEND: judgments sit in their own labelled block, and no combined score exists", async () => {
    const risk = await register({ title: "rk-split", category: "data_leakage_pii", likelihood: "high", impact: "low" });
    const res = await detailOf(risk.id);
    const body = res.json();
    expect(body.declared).toMatchObject({ likelihood: "high", impact: "low", status: "open" });
    expect(body.declared.note).toContain("never blended");
    // the human's judgments never leak into the computed side — no evidence
    // field carries them (the disclaimer PROSE may name them; a JSON key of
    // that name would be the leak)
    expect(JSON.stringify(body.evidence)).not.toContain('"likelihood"');
    expect(JSON.stringify(body.evidence)).not.toContain('"impact"');
    // and there is no combined risk score anywhere in the payload
    expect(body).not.toHaveProperty("score");
    expect(body).not.toHaveProperty("riskScore");
    expect(body.evidence.disclaimer).toContain("DECLARED human judgments");
  });
});

describe("status is transitioned or accepted, never patched", () => {
  it("a PATCH naming status/acceptance/category is refused BY NAME, each pointing at the owning endpoint", async () => {
    const risk = await register({ title: "rk-no-patch" });

    const status = await app.inject({
      method: "PATCH",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}`,
      payload: { status: "accepted" },
    });
    expect(status.statusCode).toBe(422);
    expect(status.json().error).toBe("status_is_transitioned_not_patched");
    expect(status.json().detail).toContain("/v1/risks/:riskId/accept");

    const acceptance = await app.inject({
      method: "PATCH",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}`,
      payload: { acceptanceNote: "self-serve" },
    });
    expect(acceptance.statusCode).toBe(422);
    expect(acceptance.json().error).toBe("computed_or_audited_not_patched");

    const category = await app.inject({
      method: "PATCH",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}`,
      payload: { category: "shadow_ai" },
    });
    expect(category.statusCode).toBe(422);
    expect(category.json().error).toBe("category_is_the_evidence_key");

    // control: the row did not move
    const after = await detailOf(risk.id);
    expect(after.json().risk).toMatchObject({ status: "open", category: "tool_misuse" });

    // legitimate edits of DECLARED judgments still work, and are audited
    const edit = await app.inject({
      method: "PATCH",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}`,
      payload: { likelihood: "high", mitigation: "rk-tightened ABAC policy set" },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json()).toMatchObject({ likelihood: "high", status: "open" });
    expect((await auditRows(risk.id, "risk-updated")).length).toBe(1);
  });

  it("transitions move open -> mitigating -> closed, audited with the reason; terminal states do not move again", async () => {
    const risk = await register({ title: "rk-lifecycle" });

    const viaTransition = await app.inject({
      method: "POST",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}/transition`,
      payload: { status: "accepted", reason: "sneaking past the record" },
    });
    expect(viaTransition.statusCode).toBe(422);
    expect(viaTransition.json().error).toBe("acceptance_is_its_own_act");

    const mitigating = await app.inject({
      method: "POST",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}/transition`,
      payload: { status: "mitigating", reason: "rk-guardrail rollout under way" },
    });
    expect(mitigating.statusCode).toBe(200);
    expect(mitigating.json().status).toBe("mitigating");
    const audit = await auditRows(risk.id, "risk-mitigating");
    expect(audit.length).toBe(1);
    expect(audit[0]!.reason).toContain("rk-guardrail rollout under way");

    const closed = await app.inject({
      method: "POST",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}/transition`,
      payload: { status: "closed", reason: "rk-scenario no longer applies" },
    });
    expect(closed.statusCode).toBe(200);

    const again = await app.inject({
      method: "POST",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}/transition`,
      payload: { status: "open", reason: "rk-reopen attempt" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("risk_terminal");

    // a closed risk has nothing left to accept either
    const accept = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/risks/${risk.id}/accept`,
      payload: { note: "rk-too late" },
    });
    expect(accept.statusCode).toBe(409);
  });

  it("a transition without a reason is refused", async () => {
    const risk = await register({ title: "rk-no-reason" });
    const res = await app.inject({
      method: "POST",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}/transition`,
      payload: { status: "mitigating" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("residual-risk acceptance — an audited record, not a control", () => {
  it("acceptance is admin-only, requires a note, freezes the evidence into the audit row, and is terminal", async () => {
    const risk = await register({ title: "rk-accept", category: "data_leakage_pii" });

    // the owner cannot accept on the org's behalf
    const own = await app.inject({
      method: "POST",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}/accept`,
      payload: { note: "trying anyway" },
    });
    expect(own.statusCode).toBe(403);

    // a note is the substance of the record — refusing without one
    const bare = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/risks/${risk.id}/accept`,
      payload: {},
    });
    expect(bare.statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/risks/${risk.id}/accept`,
      payload: { note: "rk-residual leakage risk accepted for Q3 given block-mode cascade" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      status: "accepted",
      acceptanceNote: "rk-residual leakage risk accepted for Q3 given block-mode cascade",
    });
    expect(accepted.json().acceptedAt).toBeTruthy();
    // the evidence at the moment of acceptance rides in the response...
    expect(accepted.json().evidenceAtAcceptance.entries.length).toBeGreaterThan(0);

    // ...and is FROZEN into the audit row, with the note and the declared judgments
    const rows = await auditRows(risk.id, "risk-accepted");
    expect(rows.length).toBe(1);
    const detail = rows[0]!.detail as {
      note: string;
      declared: { likelihood: string; impact: string };
      evidenceAtAcceptance: Array<{ resolver: string }>;
    };
    expect(detail.note).toContain("rk-residual leakage risk accepted");
    expect(detail.declared).toMatchObject({ likelihood: "medium", impact: "high" });
    expect(detail.evidenceAtAcceptance.map((e) => e.resolver).sort()).toEqual(
      ["pii_cascade_config", "pii_denials"],
    );

    // terminal: no second acceptance, no edit, no transition
    const again = await app.inject({
      method: "POST",
      headers: AUTH,
      url: `/v1/risks/${risk.id}/accept`,
      payload: { note: "twice" },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("already_accepted");

    const edit = await app.inject({
      method: "PATCH",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}`,
      payload: { description: "rewrite history" },
    });
    expect(edit.statusCode).toBe(409);
    expect(edit.json().error).toBe("risk_not_editable");

    const move = await app.inject({
      method: "POST",
      headers: omarAuth,
      url: `/v1/risks/${risk.id}/transition`,
      payload: { status: "open", reason: "rk-unaccept attempt" },
    });
    expect(move.statusCode).toBe(409);
  });
});

describe("visibility (owner + admin, per the existing self-scoping patterns)", () => {
  it("a stranger cannot read, list, edit, or transition someone else's risk", async () => {
    const risk = await register({ title: "rk-visibility" });

    expect((await detailOf(risk.id, mallAuth)).statusCode).toBe(403);

    const list = await app.inject({ method: "GET", headers: mallAuth, url: "/v1/risks" });
    expect(list.statusCode).toBe(200);
    expect((list.json().risks as Array<{ id: string }>).find((r) => r.id === risk.id)).toBeUndefined();

    const edit = await app.inject({
      method: "PATCH",
      headers: mallAuth,
      url: `/v1/risks/${risk.id}`,
      payload: { description: "not mine" },
    });
    expect(edit.statusCode).toBe(403);

    const move = await app.inject({
      method: "POST",
      headers: mallAuth,
      url: `/v1/risks/${risk.id}/transition`,
      payload: { status: "mitigating", reason: "not mine either" },
    });
    expect(move.statusCode).toBe(403);

    // admin sees it (fleet view), and the filters narrow honestly
    const adminList = await app.inject({
      method: "GET",
      headers: AUTH,
      url: "/v1/risks?category=tool_misuse&status=open",
    });
    expect(
      (adminList.json().risks as Array<{ id: string }>).find((r) => r.id === risk.id),
    ).toBeTruthy();
  });
});
