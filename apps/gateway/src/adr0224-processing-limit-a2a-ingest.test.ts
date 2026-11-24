/**
 * ADR-0224 addendum (2026-11-21) — the records-of-processing limit on the two paths that still skipped it: calls to a
 * remote agent (A2A, ADR-0219) and rows entering a training corpus (`regulait-llm.ts`, ingest and append). Both reach
 * the governed core's one check path (`governedProcessingLimit`).
 *
 * A2A: the remote agent's url is a private address the egress decision refuses, so a call governance ALLOWS ends at
 * `a2a-egress-blocked` and nothing is sent (the marker used by zz-adr0251-a2a-core.test.ts). Ingest: a refusal stores
 * no dataset and no rows.
 *
 * Global state (M-068): org settings are restored in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { a2aAgentGrants, a2aAgents, and, auditLog, eq, orgSettings, ORG_SETTINGS_ID, sql, trainingDatasets, trainingJobs } from "@regulait/db";
import { PRIVACY_OPS_ENABLED_DEFAULT } from "@regulait/shared";
import { builderKit, type BuilderKit, type Person } from "./testing/builder-fixture.js";
import { A2A_RULE_IDS, executeGovernedA2aCall } from "./a2a.js";
import { PRIVACY_RULE_IDS } from "./privacy-ops.js";
import { setOrgSettingsForTest } from "./testing/strict-data-posture.js";

// reserved example values only: the documentation domain and an invalid SSN
const SUBJECT = "Remote.Subject@example.com";
const SSN = "123-45-6789";
const ALLOWED_MARKER = A2A_RULE_IDS.egress;

let k: BuilderKit;
let caller: Person;
let agentId = "";
let restoreOrg: () => Promise<void> = async () => {};

const callA2a = (text: string, projectId: string | null) =>
  executeGovernedA2aCall(k.db, { userId: caller.id, agentId, skillId: null, text, projectId, ceilingAgentIds: null });
const ingest = (name: string, input: string, projectId: string | null) =>
  k.req("POST", "/v1/llm/datasets", k.BOOT, { name, rows: [{ input, output: "ok" }], piiMode: "log", ...(projectId ? { projectId } : {}) });
const datasetsNamed = async (name: string) => k.db.select({ id: trainingDatasets.id }).from(trainingDatasets).where(eq(trainingDatasets.name, name));
const setLimit = (on: boolean) => k.db.update(orgSettings).set({ privacyOpsEnabled: on }).where(eq(orgSettings.id, ORG_SETTINGS_ID));

beforeAll(async () => {
  k = await builderKit("adr0224-a2a-ingest");
  caller = await k.person("caller");
  // the org PII floor at 'log', so personal data reaches the processing limit rather than the PII-mode block;
  // unattributed calls allowed, so the unattributed refusal below is the limit's own
  restoreOrg = await setOrgSettingsForTest(k.db, {
    defaultPiiMode: "log",
    privacyOpsEnabled: false,
    a2aEnabled: true,
    a2aAttributionRequired: false,
    llmTrainingEnabled: true,
  });
  const [agent] = await k.db
    .insert(a2aAgents)
    .values({ name: `adr0224-a2a-${k.RUN}`, url: "http://10.255.255.1:9/a2a", card: { name: "probe", skills: [{ id: "s1" }] }, allowPrivateRanges: false })
    .returning();
  agentId = agent!.id;
  await k.db.insert(a2aAgentGrants).values({ agentId, userId: caller.id, skillId: null });
}, 120_000);

afterAll(async () => {
  await k.db.delete(a2aAgents).where(eq(a2aAgents.id, agentId));
  await restoreOrg();
  await k.close();
});

describe("off (the shipped default): A2A and ingest are not limited", () => {
  it("an A2A call carrying personal data passes governance (ends at egress)", async () => {
    expect(await callA2a(`Reply to ${SUBJECT}`, caller.projectId)).toMatchObject({ kind: "denied", ruleId: ALLOWED_MARKER });
  });

  it("a dataset carrying personal data is stored (flagged by the scan at log)", async () => {
    const name = `adr0224-off-${k.RUN}`;
    const res = await ingest(name, `Reply to ${SUBJECT}`, caller.projectId);
    expect(res.statusCode, res.body).toBe(201);
  });
});

describe("on: the limit runs on A2A calls", () => {
  beforeAll(async () => {
    await k.db.update(orgSettings).set({ privacyOpsEnabled: true }).where(eq(orgSettings.id, ORG_SETTINGS_ID));
  });

  it("personal data with no record of processing is refused 409 before egress, in one audit row without the value", async () => {
    const out = await callA2a(`Reply to ${SUBJECT}`, caller.projectId);
    expect(out).toMatchObject({ kind: "denied", status: 409, error: "processing_not_permitted", ruleId: PRIVACY_RULE_IDS.dispatchRefused });
    expect(JSON.stringify(out)).not.toContain(SUBJECT);
    const rows = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, agentId), eq(auditLog.ruleId, PRIVACY_RULE_IDS.dispatchRefused)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe((out as { auditId: string }).auditId);
    expect(rows[0]!.objectType).toBe("a2a_agent");
    expect((rows[0]!.detail as { callType?: string }).callType).toBe("a2a");
    expect(JSON.stringify(rows[0]!.detail) + rows[0]!.reason).not.toContain(SUBJECT.toLowerCase().split("@")[0]);
  });

  it("an unattributed A2A call carrying personal data is refused (no record can permit it)", async () => {
    const out = await callA2a(`Reply to ${SUBJECT}`, null);
    expect(out).toMatchObject({ kind: "denied", status: 409, error: "processing_not_permitted" });
    expect((out as { reason: string }).reason).toContain("names no project");
  });

  it("a message with no personal data is untouched", async () => {
    expect(await callA2a("Summarise the plan", caller.projectId)).toMatchObject({ ruleId: ALLOWED_MARKER });
  });
});

describe("on: the limit runs on training-corpus ingest and append", () => {
  it("ingest: personal data with no record is refused 409 and nothing is stored", async () => {
    const name = `adr0224-on-${k.RUN}`;
    const res = await ingest(name, `Reply to ${SUBJECT}`, caller.projectId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("processing_not_permitted");
    expect(res.body).not.toContain(SUBJECT);
    expect(await datasetsNamed(name)).toHaveLength(0);
    const rows = await k.db.select().from(auditLog).where(and(eq(auditLog.objectType, "training_dataset"), eq(auditLog.ruleId, PRIVACY_RULE_IDS.dispatchRefused)));
    const mine = rows.filter((r) => (r.detail as { datasetName?: string }).datasetName === name);
    expect(mine).toHaveLength(1);
    expect((mine[0]!.detail as { callType?: string; phase?: string })).toMatchObject({ callType: "training_dataset", phase: "ingest" });
  });

  it("an unattributed ingest carrying personal data is refused", async () => {
    const name = `adr0224-unattr-${k.RUN}`;
    const res = await ingest(name, `Reply to ${SUBJECT}`, null);
    expect(res.statusCode).toBe(409);
    expect(await datasetsNamed(name)).toHaveLength(0);
  });

  it("a record permitting email lets the same email through on both paths, and still refuses a category it does not list", async () => {
    const r = await k.req("POST", "/v1/privacy/processing-records", k.BOOT, {
      name: `adr0224-a2a-ingest-${k.RUN}`,
      purpose: "Support replies drafted by a remote agent and a tuned model",
      lawfulBasis: "contract",
      dataCategories: ["email"],
      retentionDays: 90,
      projectId: caller.projectId,
    });
    expect(r.statusCode, r.body).toBe(201);

    expect(await callA2a(`Reply to ${SUBJECT}`, caller.projectId)).toMatchObject({ ruleId: ALLOWED_MARKER });
    expect(await callA2a(`Reply to ${SUBJECT} about ${SSN}`, caller.projectId)).toMatchObject({ status: 409, error: "processing_not_permitted" });

    const name = `adr0224-permitted-${k.RUN}`;
    const ok = await ingest(name, `Reply to ${SUBJECT}`, caller.projectId);
    expect(ok.statusCode, ok.body).toBe(201);
    const datasetId = ok.json().dataset?.id ?? ok.json().id;
    expect(typeof datasetId).toBe("string");

    // append: the same limit, so a second upload is no way around it
    const appended = await k.req("POST", `/v1/llm/datasets/${datasetId}/rows`, k.BOOT, { rows: [{ input: `Tax id ${SSN}`, output: "ok" }] });
    expect(appended.statusCode).toBe(409);
    expect(appended.json().error).toBe("processing_not_permitted");
    const fine = await k.req("POST", `/v1/llm/datasets/${datasetId}/rows`, k.BOOT, { rows: [{ input: `Write to ${SUBJECT}`, output: "ok" }] });
    expect(fine.statusCode, fine.body).toBeLessThan(300);
  });
});

/**
 * Review #1161 S4 [1]: every path that writes corpus rows or sends a corpus to a trainer goes through the one check
 * (`corpusProcessingRefusal`). Each route gets its own negative assertion (M-035): a new version from supplied rows,
 * a new version copied from a corpus stored while the limit was off, and a training job on such a corpus.
 */
describe("on: the limit runs on every other corpus path (versions and training jobs)", () => {
  let offDatasetId = "";
  let offName = "";
  let baseAgentId = "";

  beforeAll(async () => {
    // a corpus with an SSN (a category no record lists), stored while the limit was off
    await setLimit(false);
    offName = `adr0224-stored-off-${k.RUN}`;
    const res = await k.req("POST", "/v1/llm/datasets", k.BOOT, {
      name: offName,
      rows: [{ input: `Tax id ${SSN}`, output: "ok" }],
      piiMode: "log",
      projectId: caller.projectId,
    });
    expect(res.statusCode, res.body).toBe(201);
    offDatasetId = res.json().dataset?.id ?? res.json().id;
    // a base agent with its default modes (a job is checked against mode 'execute'), granted to the caller
    const agent = await k.req("POST", "/v1/agents", k.BOOT, { name: `adr0224-base-${k.RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" });
    expect(agent.statusCode, agent.body).toBe(201);
    baseAgentId = agent.json().id;
    await k.grantModel(caller.id, baseAgentId);
    await setLimit(true);
  });

  it("versions with supplied rows: refused 409 and no new version is stored", async () => {
    const before = (await datasetsNamed(offName)).length;
    const res = await k.req("POST", `/v1/llm/datasets/${offDatasetId}/versions`, k.BOOT, { rows: [{ input: `Tax id ${SSN}`, output: "ok" }] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("processing_not_permitted");
    expect(res.body).not.toContain(SSN);
    expect(await datasetsNamed(offName)).toHaveLength(before);
    const rows = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, offDatasetId), eq(auditLog.ruleId, PRIVACY_RULE_IDS.dispatchRefused)));
    expect(rows.some((r) => (r.detail as { phase?: string }).phase === "version")).toBe(true);
  });

  it("versions with no body: the copied corpus, stored while the limit was off, is refused 409 and nothing is stored", async () => {
    const before = (await datasetsNamed(offName)).length;
    const res = await k.req("POST", `/v1/llm/datasets/${offDatasetId}/versions`, k.BOOT, {});
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("processing_not_permitted");
    expect(await datasetsNamed(offName)).toHaveLength(before);
  });

  it("a training job on that corpus is refused 409 before any job is created", async () => {
    const res = await k.req("POST", "/v1/llm/jobs", caller.auth, {
      name: `adr0224-job-${k.RUN}`,
      datasetId: offDatasetId,
      backend: "local",
      method: "retrieval_index",
      baseAgentId,
      projectId: caller.projectId,
      hyperparameters: { topK: 3 },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toBe("processing_not_permitted");
    const jobs = await k.db.select({ id: trainingJobs.id }).from(trainingJobs).where(eq(trainingJobs.datasetId, offDatasetId));
    expect(jobs).toHaveLength(0);
    const rows = await k.db.select().from(auditLog).where(and(eq(auditLog.objectId, offDatasetId), eq(auditLog.ruleId, PRIVACY_RULE_IDS.dispatchRefused)));
    expect(rows.some((r) => (r.detail as { phase?: string }).phase === "train")).toBe(true);
  });

  it("with the limit off again, both paths run (the check is the limit, not a new block)", async () => {
    await setLimit(false);
    try {
      const v = await k.req("POST", `/v1/llm/datasets/${offDatasetId}/versions`, k.BOOT, {});
      expect(v.statusCode, v.body).toBe(201);
    } finally {
      await setLimit(true);
    }
  });
});

describe("the shipped default is one constant", () => {
  it("the live column default equals PRIVACY_OPS_ENABLED_DEFAULT (SQL cannot import it)", async () => {
    const res = await k.db.execute(
      sql`SELECT column_default FROM information_schema.columns WHERE table_name = 'org_settings' AND column_name = 'privacy_ops_enabled'`,
    );
    expect((res.rows[0] as { column_default?: string }).column_default).toBe(String(PRIVACY_OPS_ENABLED_DEFAULT));
  });
});
