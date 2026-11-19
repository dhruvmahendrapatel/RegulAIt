/**
 * ADR-0345 (lane E26) slice 2a — the proof runner against a real database.
 *
 *  - a result is evidence: written in the same transaction as its chained audit row, whose detail carries the same
 *    hash; the hash recomputes from the canonical bytes; unsigned without the export key, a verifiable Ed25519
 *    signature with it;
 *  - anything but a pass raises ONE open alert and ONE pending acknowledgement per proof (a repeat failure reuses
 *    both and links the new result); a later pass resolves the alert;
 *  - a gateway probe (no harness yet) and an engine that throws are `not_run`, never a pass;
 *  - the register-hygiene check fails on a live risk past the review window;
 *  - the sweep honours a disabled proof and the interval, and the scheduler registers the job.
 *
 * Engines are injected so the outcome is deterministic; the register check runs for real. The suite resolves the
 * alerts and supersedes the approvals it raised; evidence rows stay, by design.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { generateKeyPairSync, randomBytes, sign as edSign, verify as edVerify } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agentRiskProofFollowups,
  agentRiskProofResults,
  agentRiskProofSettings,
  aiRisks,
  approvals,
  auditLog,
  createDb,
  eq,
  governanceAlerts,
  runMigrations,
  runWithRlsSystem,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { agentRiskProofByKey, agentRiskProofs, sha256Hex, type Measurement } from "@regulait/shared";
import {
  AGENT_RISK_PROOF_ALERT_RULE,
  AGENT_RISK_PROOF_JOB_NAME,
  agentRiskProofEvidence,
  runAgentRiskProof,
  runAgentRiskProofEngine,
  runAgentRiskProofSweep,
  type AgentRiskProofDeps,
} from "./agent-risk-proof-runner.js";
import { schedulerJobRegistry } from "./scheduler-jobs.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
let db: Db;
let adminId: string;
const sys = <T>(fn: () => Promise<T>) => runWithRlsSystem("system_task", "test.adr0345.runner", fn);

const measured = (state: Measurement["state"]): Measurement => ({ value: state === "pass" ? 0 : 50, samples: 40, state, evidence: [] });
const unsigned = () => ({ ok: false as const, ruleId: "export-signing-key-absent" as const, reason: "not configured" });
const okChain = async () =>
  ({
    status: "ok",
    scanned: { rows: 10, bounded: false },
    firstBreak: null,
    anchor: { checked: true, source: "worm_sink", tamperResistant: true, matches: true },
  }) as never;
const deps = (state: Measurement["state"], over: Partial<AgentRiskProofDeps> = {}): AgentRiskProofDeps => ({
  measure: async () => measured(state),
  verifyChain: okChain,
  signingKey: unsigned,
  ...over,
});
const metricProof = () => agentRiskProofs().find((p) => p.proof.engine === "assurance_metric")!;
/** a gateway probe whose harness is not built yet (slice 2c part 2) */
const probeProof = () => agentRiskProofs().find((p) => p.proof.engine === "gateway_probe" && p.proof.probe === "approval_replay")!;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const [a] = await db
    .insert(users)
    .values({ email: `e26-runner-${RUN}@example.test`, displayName: "e26 runner admin", isAdmin: true })
    .returning({ id: users.id });
  adminId = a!.id;
  // the metric engine measures every registered agent; make sure there is one
  await db.execute(sql`insert into agents (name, provider, tier) values (${`e26-runner-agent-${RUN}`}, 'anthropic', 1) on conflict do nothing`);
}, 120_000);

afterAll(async () => {
  await db.update(governanceAlerts).set({ status: "resolved", resolvedAt: new Date() }).where(eq(governanceAlerts.ruleId, AGENT_RISK_PROOF_ALERT_RULE));
  await db.update(approvals).set({ status: "superseded" }).where(eq(approvals.objectType, "agent_risk_proof"));
  await db.delete(agentRiskProofSettings);
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, adminId));
});

describe("ADR-0345 slice 2a: a result is signed, hash-chained evidence", () => {
  it("writes the result and its audit row together; the audit row carries the same hash; unsigned without a key", async () => {
    const rec = (await sys(() => runAgentRiskProof(db, metricProof(), { trigger: "manual", deps: deps("pass") })))!;
    expect(rec.outcome).toBe("pass");
    expect(rec.signed).toBe(false);
    const [row] = await db.select().from(agentRiskProofResults).where(eq(agentRiskProofResults.id, rec.resultId));
    expect(row!.signature).toBeNull();
    expect(row!.signingKeyId).toBeNull();
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.id, row!.auditLogId));
    expect(audit!.objectType).toBe("agent_risk_proof");
    expect((audit!.detail as { contentHash: string }).contentHash).toBe(row!.contentHash);
    expect(audit!.seq).not.toBeNull(); // chained by withAuditChain
    // the hash recomputes from the canonical bytes
    const entry = agentRiskProofByKey(row!.proofKey)!;
    expect(
      sha256Hex(
        agentRiskProofEvidence({
          proofKey: row!.proofKey,
          riskKey: entry.risk.key,
          catalogVersion: row!.catalogVersion,
          trigger: row!.trigger,
          outcome: row!.outcome,
          startedAt: row!.startedAt,
          finishedAt: row!.finishedAt,
          detail: row!.detail as Record<string, unknown>,
        }),
      ),
    ).toBe(row!.contentHash);
  });

  it("with the export key configured, the signature verifies against its public key", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const key = () => ({
      ok: true as const,
      keyId: `e26-test-${RUN}`,
      fingerprint: "sha256:" + "0".repeat(64),
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      sign: (bytes: Buffer) => edSign(null, bytes, privateKey),
    });
    const rec = (await sys(() => runAgentRiskProof(db, metricProof(), { trigger: "manual", deps: deps("pass", { signingKey: key }) })))!;
    const [row] = await db.select().from(agentRiskProofResults).where(eq(agentRiskProofResults.id, rec.resultId));
    expect(row!.signingKeyId).toBe(`e26-test-${RUN}`);
    expect(edVerify(null, Buffer.from(row!.contentHash, "utf8"), publicKey, Buffer.from(row!.signature!, "base64"))).toBe(true);
  });
});

describe("ADR-0345 slice 2a: a failure is raised, not filed", () => {
  it("a failure raises one alert and one pending acknowledgement; a repeat reuses both; a pass resolves the alert", async () => {
    const entry = metricProof();
    const first = (await sys(() => runAgentRiskProof(db, entry, { trigger: "manual", deps: deps("fail") })))!;
    expect(first.outcome).toBe("fail");
    expect(first.alertId).not.toBeNull();
    expect(first.approvalId).not.toBeNull();
    const [alert] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, first.alertId!));
    expect(alert).toMatchObject({ ruleId: AGENT_RISK_PROOF_ALERT_RULE, subjectKey: entry.proof.key, severity: "high", status: "open" });
    const [approval] = await db.select().from(approvals).where(eq(approvals.id, first.approvalId!));
    expect(approval).toMatchObject({ objectType: "agent_risk_proof", stageId: `agent-risk-proof:${entry.proof.key}`, status: "pending" });

    const second = (await sys(() => runAgentRiskProof(db, entry, { trigger: "manual", deps: deps("fail") })))!;
    expect(second.alertId).toBe(first.alertId);
    expect(second.approvalId).toBe(first.approvalId);
    const links = await db.select().from(agentRiskProofFollowups).where(eq(agentRiskProofFollowups.alertId, first.alertId!));
    expect(links.map((l) => l.resultId).sort()).toEqual([first.resultId, second.resultId].sort());

    await sys(() => runAgentRiskProof(db, entry, { trigger: "manual", deps: deps("pass") }));
    const [after] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, first.alertId!));
    expect(after!.status).toBe("resolved");
    // the acknowledgement asked about a failure that no longer holds: it is superseded, not left open (#1039)
    const [ack] = await db.select().from(approvals).where(eq(approvals.id, first.approvalId!));
    expect(ack!.status).toBe("superseded");
  });

  it("the acknowledgement goes to someone other than its requester when the deployment has a second admin (#1039)", async () => {
    const [second] = await db
      .insert(users)
      .values({ email: `e26-runner-2-${RUN}@example.test`, displayName: "e26 second admin", isAdmin: true })
      .returning({ id: users.id });
    try {
      const rec = (await sys(() => runAgentRiskProof(db, probeProof(), { trigger: "manual", deps: deps("pass") })))!;
      const [ack] = await db.select().from(approvals).where(eq(approvals.id, rec.approvalId!));
      expect(ack!.approverUserId).not.toBe(ack!.userId);
    } finally {
      await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, second!.id));
    }
  });

  it("NEGATIVE: insufficient data is not a pass — it raises a medium alert", async () => {
    const rec = (await sys(() => runAgentRiskProof(db, metricProof(), { trigger: "manual", deps: deps("insufficient") })))!;
    expect(rec.outcome).toBe("insufficient");
    const [alert] = await db.select().from(governanceAlerts).where(eq(governanceAlerts.id, rec.alertId!));
    expect(alert!.severity).toBe("medium");
  });
});

describe("ADR-0345 slice 2a: engines", () => {
  it("NEGATIVE: a gateway probe whose harness is not built yet is not_run (never a pass)", async () => {
    const r = await runAgentRiskProofEngine(db, probeProof().proof, new Date(), deps("pass"));
    expect(r).toMatchObject({ outcome: "not_run", detail: { reason: "probe_not_built" } });
  });

  it("NEGATIVE: an engine that throws is not_run, and the row keeps only the error class", async () => {
    const boom = deps("pass", { measure: async () => { throw new TypeError("secret tenant detail"); } });
    const r = await runAgentRiskProofEngine(db, metricProof().proof, new Date(), boom);
    expect(r).toEqual({ outcome: "not_run", detail: { reason: "engine_error", error: "TypeError" } });
  });

  it("the audit-chain check fails on a broken chain and passes an intact one", async () => {
    const chain = agentRiskProofs().find((p) => p.proof.check === "audit_chain_verifies")!.proof;
    const broken = async () =>
      ({ status: "broken", scanned: { rows: 3, bounded: false }, firstBreak: { seq: 2 }, anchor: { checked: false, source: "none", tamperResistant: false, matches: null } }) as never;
    expect((await runAgentRiskProofEngine(db, chain, new Date(), deps("pass", { verifyChain: broken }))).outcome).toBe("fail");
    expect((await runAgentRiskProofEngine(db, chain, new Date(), deps("pass"))).outcome).toBe("pass");
  });

  it("NEGATIVE: an intact chain without a checked, tamper-resistant anchor is insufficient, never a pass (#1039)", async () => {
    const chain = agentRiskProofs().find((p) => p.proof.check === "audit_chain_verifies")!.proof;
    const report = (anchor: object, bounded = false) => async () =>
      ({ status: "ok", scanned: { rows: 10, bounded }, firstBreak: null, anchor }) as never;
    const cases: Array<[object, boolean, string]> = [
      [{ checked: false, source: "none", tamperResistant: false, matches: null }, false, "no_anchor_checked"],
      [{ checked: true, source: "database", tamperResistant: false, matches: true }, false, "anchor_not_tamper_resistant"],
      [{ checked: true, source: "worm_sink", tamperResistant: true, matches: true }, true, "partial_scan"],
    ];
    for (const [anchor, bounded, reason] of cases) {
      const r = await runAgentRiskProofEngine(db, chain, new Date(), deps("pass", { verifyChain: report(anchor, bounded) }));
      expect(r.outcome, reason).toBe("insufficient");
      expect((r.detail as { reason: string }).reason).toBe(reason);
    }
  });

  it("register hygiene fails on a live risk whose last review is past the window", async () => {
    await db.insert(aiRisks).values({
      title: `e26 stale ${RUN}`,
      description: "stale",
      category: "prompt_injection",
      ownerUserId: adminId,
      likelihood: "low",
      impact: "low",
      updatedAt: new Date(Date.now() - 200 * 86_400_000),
    });
    const hygiene = agentRiskProofs().find((p) => p.proof.check === "register_hygiene")!.proof;
    const r = await runAgentRiskProofEngine(db, hygiene, new Date(), deps("pass"));
    expect(r.outcome).toBe("fail");
    expect((r.detail as { failing: number }).failing).toBeGreaterThan(0);
  });
});

describe("ADR-0345 slice 2a: the sweep", () => {
  it("skips a disabled proof, runs the due ones once, and nothing is due straight after", async () => {
    const disabled = probeProof().proof.key;
    await db.insert(agentRiskProofSettings).values({ proofKey: disabled, enabled: false, updatedByUserId: adminId });
    const total = agentRiskProofs().length;
    const first = await sys(() => runAgentRiskProofSweep(db, { deps: deps("pass") }));
    expect(first.skippedDisabled).toBe(1);
    expect(first.ran + first.notDue + first.skippedDisabled).toBe(total);
    const second = await sys(() => runAgentRiskProofSweep(db, { deps: deps("pass") }));
    expect(second.ran).toBe(0);
    expect(second.notDue).toBe(total - 1);
  });

  it("NEGATIVE: one proof that cannot be recorded is audited, and the sweep goes on to the others (#1039)", async () => {
    await db.delete(agentRiskProofSettings);
    const victim = metricProof().proof.key;
    // make every proof due again by pushing the clock past the longest interval
    const later = new Date(Date.now() + 8 * 24 * 3_600_000);
    // the evidence write itself throws (here: signing), after the engine ran
    const throwing = deps("pass", {
      signingKey: () => {
        throw new RangeError("signing failed");
      },
    });
    const out = await sys(() => runAgentRiskProofSweep(db, { now: later, deps: throwing }));
    expect(out.errors).toBeGreaterThan(0);
    expect(out.errors + out.ran + out.notDue + out.duplicates + out.skippedDisabled).toBe(agentRiskProofs().length);
    const failed = await db.execute(
      sql`select count(*)::int as n from audit_log where rule_id = 'agent-risk-proof-run-failed' and detail->>'proofKey' = ${victim}`,
    );
    expect((failed.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it("the scheduler registers the job", () => {
    expect(schedulerJobRegistry().has(AGENT_RISK_PROOF_JOB_NAME)).toBe(true);
  });
});
