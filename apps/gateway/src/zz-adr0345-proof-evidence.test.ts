/**
 * ADR-0345 (lane E26) slice 2b, part 1 — proof results read as evidence, against a real database.
 *
 *  - a signed result whose hash, chained audit row and signature hold is `verified`; an unsigned one is `unsigned`
 *    (never shown as signed);
 *  - NEGATIVE: a result whose audit row is gone, whose hash no longer recomputes, whose key this deployment no longer
 *    holds, or whose signature fails is `unverifiable`, and never counts as evidence;
 *  - the `agent_risk_proofs` pack collector counts only passing results with evidence, for proofs whose risk cites
 *    the control, under an org-scoped report only;
 *  - the posture score shows the proofs as inputs to the adversarial objective without changing its score.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { generateKeyPairSync, randomBytes, randomUUID, sign as edSign } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  agentRiskProofResults,
  approvals,
  createDb,
  eq,
  governanceAlerts,
  runMigrations,
  runWithRlsSystem,
  sql,
  users,
  type Db,
} from "@regulait/db";
import { agentRiskProofs, type Measurement } from "@regulait/shared";
import { checkAgentRiskProofEvidence, countsAsEvidence, latestAgentRiskProofs } from "./agent-risk-proof-evidence.js";
import { AGENT_RISK_PROOF_ALERT_RULE, runAgentRiskProof, type AgentRiskProofDeps } from "./agent-risk-proof-runner.js";
import { runCollector } from "./compliance-packs.js";
import { scorePosture, type PostureScoreInput } from "./posture-score.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const RUN = randomBytes(3).toString("hex");
let db: Db;
let adminId: string;
const sys = <T>(fn: () => Promise<T>) => runWithRlsSystem("system_task", "test.adr0345.evidence", fn);

const pair = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const keyOf = (kp: typeof pair, keyId: string) => () => ({
  ok: true as const,
  keyId,
  fingerprint: "sha256:" + "0".repeat(64),
  publicKeyPem: kp.publicKey.export({ type: "spki", format: "pem" }).toString(),
  sign: (bytes: Buffer) => edSign(null, bytes, kp.privateKey),
});
const KEY_ID = `e26-ev-${RUN}`;
const unsigned = () => ({ ok: false as const, ruleId: "export-signing-key-absent" as const, reason: "not configured" });
const runnerDeps = (signingKey: AgentRiskProofDeps["signingKey"]): AgentRiskProofDeps => ({
  measure: async (): Promise<Measurement> => ({ value: 0, samples: 40, state: "pass", evidence: [] }),
  verifyChain: async () => ({}) as never,
  signingKey,
});
const metricEntry = () => agentRiskProofs().find((p) => p.proof.engine === "assurance_metric")!;
const rowOf = async (id: string) => (await db.select().from(agentRiskProofResults).where(eq(agentRiskProofResults.id, id)))[0]!;
const label = async (id: string, signingKey: AgentRiskProofDeps["signingKey"]) =>
  (await checkAgentRiskProofEvidence(db, [await rowOf(id)], { signingKey })).get(id)!;

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  const [a] = await db
    .insert(users)
    .values({ email: `e26-evidence-${RUN}@example.test`, displayName: "e26 evidence admin", isAdmin: true })
    .returning({ id: users.id });
  adminId = a!.id;
  await db.execute(sql`insert into agents (name, provider, tier) values (${`e26-evidence-agent-${RUN}`}, 'anthropic', 1) on conflict do nothing`);
}, 120_000);

afterAll(async () => {
  await db.update(governanceAlerts).set({ status: "resolved", resolvedAt: new Date() }).where(eq(governanceAlerts.ruleId, AGENT_RISK_PROOF_ALERT_RULE));
  await db.update(approvals).set({ status: "superseded" }).where(eq(approvals.objectType, "agent_risk_proof"));
  await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, adminId));
});

describe("ADR-0345 slice 2b: a proof result read as evidence", () => {
  it("a signed result whose hash, chain row and signature hold is verified; an unsigned one is unsigned", async () => {
    const signed = (await sys(() => runAgentRiskProof(db, metricEntry(), { trigger: "manual", deps: runnerDeps(keyOf(pair, KEY_ID)) })))!;
    expect(await label(signed.resultId, keyOf(pair, KEY_ID))).toEqual({ label: "verified", reason: null });
    const plain = (await sys(() => runAgentRiskProof(db, metricEntry(), { trigger: "manual", deps: runnerDeps(unsigned) })))!;
    expect(await label(plain.resultId, unsigned)).toEqual({ label: "unsigned", reason: null });
    expect(countsAsEvidence("pass", { label: "unsigned", reason: null })).toBe(true);
  });

  it("NEGATIVE: a key this deployment no longer holds, or a signature that fails, is unverifiable", async () => {
    const signed = (await sys(() => runAgentRiskProof(db, metricEntry(), { trigger: "manual", deps: runnerDeps(keyOf(pair, KEY_ID)) })))!;
    expect(await label(signed.resultId, unsigned)).toEqual({ label: "unverifiable", reason: "signing_key_unknown" });
    expect(await label(signed.resultId, keyOf(pair, "another-key-id"))).toEqual({ label: "unverifiable", reason: "signing_key_unknown" });
    // same key id, different key: the signature does not verify
    expect(await label(signed.resultId, keyOf(other, KEY_ID))).toEqual({ label: "unverifiable", reason: "bad_signature" });
  });

  it("NEGATIVE: a result whose audit row is gone, or whose hash no longer recomputes, is unverifiable and never evidence", async () => {
    const real = await rowOf((await sys(() => runAgentRiskProof(db, metricEntry(), { trigger: "manual", deps: runnerDeps(unsigned) })))!.resultId);
    // the same evidence pointing at an audit row that does not exist (a pruned chain)
    const [orphan] = await db
      .insert(agentRiskProofResults)
      .values({ ...real, id: undefined as never, auditLogId: randomUUID() })
      .returning({ id: agentRiskProofResults.id });
    expect(await label(orphan!.id, unsigned)).toEqual({ label: "unverifiable", reason: "audit_row_missing" });
    // a hash that is not the hash of these bytes
    const [forged] = await db
      .insert(agentRiskProofResults)
      .values({ ...real, id: undefined as never, auditLogId: randomUUID(), contentHash: "b".repeat(64) })
      .returning({ id: agentRiskProofResults.id });
    expect(await label(forged!.id, unsigned)).toEqual({ label: "unverifiable", reason: "hash_mismatch" });
    expect(countsAsEvidence("pass", { label: "unverifiable", reason: "hash_mismatch" })).toBe(false);
    expect(countsAsEvidence("fail", { label: "verified", reason: null })).toBe(false);
  });

  it("latest results: one entry per catalogue proof, each labelled", async () => {
    const latest = await sys(() => latestAgentRiskProofs(db, { signingKey: unsigned }));
    expect(latest.map((l) => l.proofKey).sort()).toEqual(agentRiskProofs().map((p) => p.proof.key).sort());
    const mine = latest.find((l) => l.proofKey === metricEntry().proof.key)!;
    expect(mine.latest).not.toBeNull();
    expect(["verified", "unsigned", "unverifiable"]).toContain(mine.latest!.evidence.label);
  });
});

describe("ADR-0345 slice 2b: the agent_risk_proofs pack collector", () => {
  const period = () => ({ periodStart: new Date(Date.now() - 86_400_000), periodEnd: new Date(Date.now() + 86_400_000) });

  it("counts passing results with evidence for the cited control, org-scoped only", async () => {
    await sys(() => runAgentRiskProof(db, metricEntry(), { trigger: "manual", deps: runnerDeps(unsigned) }));
    const controlRef = metricEntry().risk.owaspRefs[0]!;
    const org = await sys(() => runCollector(db, "agent_risk_proofs", { ...period(), projectIds: null, memberIds: null, params: {}, controlRef }));
    expect(org).toBeGreaterThan(0);
    // NEGATIVE: a project-scoped report, a control no proof cites, and no control at all count nothing
    expect(await sys(() => runCollector(db, "agent_risk_proofs", { ...period(), projectIds: [randomUUID()], memberIds: null, params: {}, controlRef }))).toBe(0);
    expect(
      await sys(() => runCollector(db, "agent_risk_proofs", { ...period(), projectIds: null, memberIds: null, params: {}, controlRef: "nobody:cites-this" })),
    ).toBe(0);
    expect(await sys(() => runCollector(db, "agent_risk_proofs", { ...period(), projectIds: null, memberIds: null, params: {} }))).toBe(0);
  });
});

describe("ADR-0345 slice 2b: the posture input", () => {
  it("shows the proofs under the adversarial objective without changing its score", () => {
    const base: PostureScoreInput = {
      packs: { active: [] },
      risks: { open: 0, mitigating: 0, accepted: 0, closed: 0, total: 0 },
      redteam: { measured: false, runsInWindow: 0, latest: null },
      evals: { groundedness: { runsInWindow: 0, latest: null } },
      spend: { budgets: [] },
      auditChain: { anchors: 0, sink: null },
      agentOwnership: { total: 0, owned: 0, unowned: 0, orphaned: 0 },
      certificationCampaigns: { expiredIncomplete: 0 },
      sod: { currentViolations: 0 },
    };
    const without = scorePosture(base);
    const withProofs = scorePosture({ ...base, riskProofs: { total: 11, passingWithEvidence: 4, notPassing: 7, unverifiable: 1 } });
    const adv = withProofs.objectives.find((o) => o.id === "adversarial")!;
    expect(adv.inputs).toContainEqual({ label: "Agent-risk proofs passing with evidence (ADR-0345)", value: "4 of 11" });
    expect(adv.inputs).toContainEqual({ label: "Agent-risk proof results whose evidence no longer holds", value: "1" });
    expect(withProofs.objectives.map((o) => o.score)).toEqual(without.objectives.map((o) => o.score));
  });
});
