/**
 * ADR-0189 slice B3 — the AI BOM LOADER, the snapshot freeze and the drift
 * route, on a real database through the real migrations (R32: rows shaped by
 * the `packages/db` schema, nulls and column defaults included).
 *
 * The whole file runs on its OWN scratch database (M-040, M-042): the install
 * subject reads every table, and snapshots and their signing key are
 * append-only rows that must not leak into the shared suite database.
 *
 *  - R31: one snapshot of each subject kind (use case, agent, builder agent,
 *    install) builds from real rows and validates against CycloneDX 1.7 and 1.6.
 *  - OWNER DECISION 5, R47, #280: canary strings seeded into every content
 *    column the loader must never read (system prompt, prompt template, skill
 *    body, builder instructions, memory, training payload and location, config
 *    body, eval case input, tool description, credential ciphertext, endpoint
 *    query/fragment/path) never appear in any byte; userinfo refuses.
 *  - R50 + 4237346650: concurrent freezes of one subject serialise on the
 *    session lock and take contiguous versions; NEGATIVE CONTROL: the same
 *    capture under only the transaction-scoped lock inside REPEATABLE READ
 *    loses the race (the stale snapshot is refused by the version guard).
 *  - Signing (OWNER DECISION 2): the stored body is the exact signed bytes; the
 *    signature verifies with the receipt key; no key → 409
 *    `bom_signing_unavailable` and nothing is written.
 *  - R2/R17: POST answers 501 `bom_snapshots_not_released` (and 403/401 for
 *    non-admins); the trigger gate does nothing.
 *  - R8: drift is 409 without a snapshot, then a change list with
 *    `evidence: false`, audited; the list route is audited; both rate-limited.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, verify } from "node:crypto";
import {
  agents,
  aiBomSnapshots,
  aiUseCases,
  and,
  artifactScans,
  auditLog,
  bomRenderings,
  builderAgentMemory,
  builderAgentSkills,
  builderAgents,
  builderSkills,
  configVersions,
  connectorCredentials,
  connectors,
  createDb,
  customModelProviders,
  engineRuns,
  eq,
  evalCases,
  evalDatasets,
  evalRuns,
  identityConnectorGrants,
  identityToolGrants,
  lockAiBomSubject,
  mcpServers,
  mcpTools,
  modelArtifacts,
  modelCardApprovals,
  modelCardEvidence,
  modelCards,
  projects,
  promptCommits,
  prompts,
  promptTags,
  runMigrations,
  sql,
  trainingArtifacts,
  trainingDatasets,
  trainingJobs,
  workloadIdentities,
  type Db,
} from "@regulait/db";
import { AI_BOM_INSTALL_SUBJECT_ID, aiBomNativeBodySchema, validateCycloneDx, warmCycloneDxValidators, type AiBomSubjectKind } from "@regulait/shared";
import { buildApp } from "./app.js";
import { AI_BOM_SNAPSHOTS_RELEASED, AiBomError, aiBomSnapshotTriggerGate, captureAiBomSnapshotInTx, loadAiBomRecords, takeAiBomSnapshot } from "./ai-bom.js";
import { relaxIdentityForTest } from "./testing/identity-posture.js";
import { dropScratchDatabase } from "./testing/scratch-db.js";
import { buildAiBom, validateSpdx } from "@regulait/shared";
import { BOM_SUBJECT_LOCK_NAMESPACE, withAiBomSubjectSessionLock } from "@regulait/db";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, "../../../packages/db/migrations");
const RUN = Math.random().toString(36).slice(2, 8);
const SCRATCH = `b3_ai_bom_${RUN}`;
const BOOT = `b3-boot-${RUN}`;
const AUTH = { authorization: `Bearer ${BOOT}` };
const H = (c: string) => c.repeat(64);
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = "/" + name;
  return u.toString();
};

/** canaries in columns the loader must never read at all (content, credentials, notes) */
const CONTENT_CANARIES = [
  "CANARY_SYSTEM_PROMPT", "CANARY_TEMPLATE", "CANARY_SKILL_BODY", "CANARY_INSTRUCTIONS", "CANARY_MEMORY", "CANARY_PAYLOAD",
  "CANARY_SIGNED_LOCATION", "CANARY_CONFIG_BODY", "CANARY_EVAL_INPUT", "CANARY_TOOL_DESC", "CANARY_CRED", "CANARY_NOTE",
  "CANARY_SCAN_ISSUE", "CANARY_PROVIDER_KEY",
];
/** every canary, including those in endpoint URLs the loader reads and sanitises (R47) */
const CANARIES = [
  "CANARY_SYSTEM_PROMPT", "CANARY_TEMPLATE", "CANARY_SKILL_BODY", "CANARY_INSTRUCTIONS", "CANARY_MEMORY", "CANARY_PAYLOAD",
  "CANARY_SIGNED_LOCATION", "CANARY_CONFIG_BODY", "CANARY_EVAL_INPUT", "CANARY_TOOL_DESC", "CANARY_CRED", "CANARY_QS",
  "CANARY_FRAG", "CANARYPATH", "CANARY_MCP_QS", "CANARYMCP", "CANARY_EXTSIG", "CANARY_NOTE", "CANARY_SCAN_ISSUE", "CANARY_PROVIDER_KEY",
];

let admin: Db;
let db: Db;
let app: ReturnType<typeof buildApp>;
const users = {} as Record<"admin" | "admin2" | "member", { id: string; auth: { authorization: string } }>;
const ids = {} as Record<string, string>;
let keyDir: string;
let publicPem: string;
const savedEnv: Record<string, string | undefined> = {};

const inject = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: unknown) =>
  app.inject({ method, url, headers, ...(payload !== undefined ? { payload: payload as object } : {}) });
const rowsOf = <T>(r: unknown) => (r as { rows: T[] }).rows;

function withKey(on: boolean) {
  for (const k of ["REGULAIT_RECEIPT_SIGNING_KEY", "REGULAIT_RECEIPT_SIGNING_KEY_ID"]) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  if (on) {
    process.env.REGULAIT_RECEIPT_SIGNING_KEY = path.join(keyDir, "receipt.pem");
    process.env.REGULAIT_RECEIPT_SIGNING_KEY_ID = `b3-synthetic-${RUN}`;
  }
}

async function seed(): Promise<void> {
  const owner = users.admin.id;
  const [project] = await db.insert(projects).values({ name: `b3-project-${RUN}` }).returning({ id: projects.id });
  const [cp] = await db.insert(customModelProviders).values({
    name: `b3-inhouse-${RUN}`, wireProtocol: "openai_chat",
    baseUrl: "https://models.internal.test:8443/v1/bot999:CANARYPATH/chat?key=CANARY_QS#CANARY_FRAG",
    keyCiphertext: "CANARY_PROVIDER_KEY", allowPlaintextHttp: false,
  }).returning({ id: customModelProviders.id });
  const [a] = await db.insert(agents).values({ name: `b3-agent-${RUN}`, provider: "provider-a", tier: 1, model: "model-x", systemPrompt: "CANARY_SYSTEM_PROMPT", ownerUserId: owner }).returning({ id: agents.id });
  const [b] = await db.insert(agents).values({ name: `b3-custom-${RUN}`, provider: "custom", tier: 1, customProviderId: cp!.id }).returning({ id: agents.id });
  Object.assign(ids, { project: project!.id, provider: cp!.id, agent: a!.id, agent2: b!.id });
  const [uc] = await db.insert(aiUseCases).values({ name: `b3 claims triage ${RUN}`, description: "d", ownerUserId: owner, businessContext: "b", intendedAgentIds: [a!.id], dataSensitivity: "confidential", complianceTags: ["soc2"] }).returning({ id: aiUseCases.id });
  ids.useCase = uc!.id;
  const [c1] = await db.insert(modelCards).values({ agentId: a!.id, intendedUse: "Claims triage", dataClaims: { trainingData: "supplier says: licensed corpus", license: "Apache-2.0" }, limitations: "Not final", biasFairness: [{ dimension: "age", method: "counterfactual", status: "assessed", note: "CANARY_NOTE", assessedBy: "someone" }], pinnedModelVersion: "2026-06-01", note: "CANARY_NOTE" }).returning({ id: modelCards.id });
  const [c2] = await db.insert(modelCards).values({ agentId: a!.id, intendedUse: "Fraud hints", dataClaims: { license: "proprietary" } }).returning({ id: modelCards.id });
  const [c3] = await db.insert(modelCards).values({ customProviderId: cp!.id, intendedUse: "In-house summaries" }).returning({ id: modelCards.id });
  Object.assign(ids, { card1: c1!.id, card2: c2!.id, card3: c3!.id });
  await db.insert(modelCardApprovals).values({ cardId: c1!.id, status: "approved", approverUserId: owner, decidedAt: new Date(), decisionReason: "CANARY_NOTE" });
  // evaluation: the dataset's cases are hashed, never read out
  const [eds] = await db.insert(evalDatasets).values({ name: `b3-golden-${RUN}`, version: 1, note: "CANARY_NOTE" }).returning({ id: evalDatasets.id });
  await db.insert(evalCases).values({ datasetId: eds!.id, datasetVersion: 1, input: "CANARY_EVAL_INPUT", expected: { contains: "x" } });
  const [run] = await db.insert(evalRuns).values({ datasetId: eds!.id, datasetVersion: 1, agentId: a!.id, agentName: "b3", trigger: "manual" } as never).returning({ id: evalRuns.id });
  await db.insert(modelCardEvidence).values({ cardId: c1!.id, kind: "eval_run", evalRunId: run!.id, note: "CANARY_NOTE" });
  await db.insert(modelCardEvidence).values({ cardId: c1!.id, kind: "external", externalRef: "https://audits.test/report?sig=CANARY_EXTSIG" });
  // weights, a scan by a recorded engine run, and engine_scan evidence (R29)
  const [art] = await db.insert(modelArtifacts).values({ sha256: H("a"), sizeBytes: 4096, format: "safetensors", filename: "w.safetensors", storageKey: `sha256/${H("a")}`, projectId: project!.id }).returning({ id: modelArtifacts.id });
  const [er] = await db.insert(engineRuns).values({ engineId: "modelscan", engineVersion: "0.8.8", status: "queued", trigger: "manual", targetKind: "artifact", targetArtifactId: art!.id, config: { sets: ["scan"], params: {} } as never, configHash: "b3", budgetUsd: 1, timeoutSeconds: 600, queueExpiresAt: new Date(Date.now() + 3_600_000) } as never).returning({ id: engineRuns.id });
  const [scan] = await db.insert(artifactScans).values({ artifactId: art!.id, engineRunId: er!.id, artifactSha256: H("a"), format: "safetensors", verdict: "clean", scannerVersion: "0.8.8", issues: [{ detail: "CANARY_SCAN_ISSUE" }] }).returning({ id: artifactScans.id });
  await db.insert(modelCardEvidence).values({ cardId: c2!.id, kind: "engine_scan", artifactScanId: scan!.id });
  // an orphan artifact with a scan whose engine run is gone (4237376660, R29)
  const [art2] = await db.insert(modelArtifacts).values({ sha256: H("b"), sizeBytes: 1, format: "pickle", filename: "x.pkl", storageKey: `sha256/${H("b")}` }).returning({ id: modelArtifacts.id });
  await db.insert(artifactScans).values({ artifactId: art2!.id, artifactSha256: H("b"), verdict: "unknown", scannerVersion: "0.8.8" });
  Object.assign(ids, { artifact: art!.id, artifact2: art2!.id, scan: scan!.id });
  // training lineage (#280 4237488600)
  const [tds] = await db.insert(trainingDatasets).values({ name: `b3-ft-${RUN}`, version: 1, checksum: `sha256:${H("d")}:3`, rowCount: 3, piiVerdict: "flagged", projectId: project!.id, note: "CANARY_NOTE" }).returning({ id: trainingDatasets.id });
  const [job] = await db.insert(trainingJobs).values({ name: "b3-job", datasetId: tds!.id, datasetVersion: 1, backend: "mock", method: "lora_sft", baseAgentId: a!.id, status: "succeeded" } as never).returning({ id: trainingJobs.id });
  await db.insert(trainingArtifacts).values({ jobId: job!.id, name: "b3-inline", method: "lora_sft", kind: "inline", payload: { weights: "CANARY_PAYLOAD" }, agentId: a!.id, modelCardId: c1!.id });
  const [job2] = await db.insert(trainingJobs).values({ name: "b3-job-2", datasetId: tds!.id, datasetVersion: 1, backend: "mock", method: "lora_sft", status: "succeeded" } as never).returning({ id: trainingJobs.id });
  await db.insert(trainingArtifacts).values({ jobId: job2!.id, name: "b3-remote", method: "lora_sft", kind: "remote", location: "https://bucket.test/x?X-Amz-Signature=CANARY_SIGNED_LOCATION", agentId: a!.id });
  Object.assign(ids, { trainingDataset: tds!.id });
  // a promoted prompt (the tag position; never the template)
  const [p] = await db.insert(prompts).values({ name: `b3-triage-${RUN}`, description: "CANARY_NOTE", ownerUserId: owner }).returning({ id: prompts.id });
  const [commit] = await db.insert(promptCommits).values({ promptId: p!.id, hash: H("1"), template: "CANARY_TEMPLATE", modelConfig: { agentId: a!.id, maxTokens: null }, authorUserId: owner, message: "CANARY_NOTE" }).returning({ id: promptCommits.id });
  await db.insert(promptTags).values({ promptId: p!.id, name: "production", commitId: commit!.id });
  // the active system-prompt config version (digest only, round 8)
  await db.insert(configVersions).values({ artifactType: "agent_system_prompt", artifactId: a!.id, version: 1, body: { systemPrompt: "CANARY_CONFIG_BODY" }, status: "active", label: "CANARY_NOTE" });
  // tools and connectors granted to the agent's workload identity
  const [mcp] = await db.insert(mcpServers).values({ name: `b3-files-${RUN}`, url: "https://mcp.test/bot1:CANARYMCP/api?token=CANARY_MCP_QS", ownerUserId: owner }).returning({ id: mcpServers.id });
  const [tool] = await db.insert(mcpTools).values({ serverId: mcp!.id, name: "read_file", kind: "read", description: "CANARY_TOOL_DESC" }).returning({ id: mcpTools.id });
  const [conn] = await db.insert(connectors).values({ name: `b3-crm-${RUN}`, kind: "crm", baseUrl: "https://crm.test/api?api_key=CANARY_QS" }).returning({ id: connectors.id });
  await db.insert(connectorCredentials).values({ connectorId: conn!.id, tokenCiphertext: "CANARY_CRED" });
  const [wid] = await db.insert(workloadIdentities).values({ kind: "agent", agentId: a!.id, identifier: `spiffe://regulait.test/regulait/agent/${a!.id}`, sponsorUserIds: [owner] }).returning({ id: workloadIdentities.id });
  await db.insert(identityToolGrants).values({ identityId: wid!.id, serverId: mcp!.id, toolName: "read_file" });
  await db.insert(identityConnectorGrants).values({ identityId: wid!.id, connectorId: conn!.id, mode: "read", allowedObjects: [] });
  Object.assign(ids, { mcp: mcp!.id, tool: tool!.id, connector: conn!.id });
  // a builder agent on the agent, with a skill attachment and memory (content never read)
  const [ba] = await db.insert(builderAgents).values({ name: `b3-helper-${RUN}`, ownerUserId: owner, modelAgentId: a!.id, instructions: "CANARY_INSTRUCTIONS", connectionFormat: "shared" }).returning({ id: builderAgents.id });
  const [sk] = await db.insert(builderSkills).values({ name: "summarise", body: "CANARY_SKILL_BODY", ownerUserId: owner }).returning({ id: builderSkills.id });
  await db.insert(builderAgentSkills).values({ agentId: ba!.id, skillId: sk!.id, bodySnapshot: "CANARY_SKILL_BODY", snapshotDigest: H("5"), snapshotName: "summarise" } as never);
  await db.insert(builderAgentMemory).values({ agentId: ba!.id, content: "CANARY_MEMORY" });
  Object.assign(ids, { builder: ba!.id, skill: sk!.id });
}

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH}`));
  db = createDb(urlFor(SCRATCH));
  await runMigrations(db, migrationsFolder);
  await relaxIdentityForTest(db, { mfaRequired: "off" });
  app = buildApp(db, { bootstrapToken: BOOT, dataKey: "b".repeat(64) });
  for (const [k, isAdmin] of [["admin", true], ["admin2", true], ["member", false]] as const) {
    const u = await inject("POST", "/v1/users", AUTH, { email: `b3-${k}-${RUN}@example.com`, displayName: `b3 ${k} ${RUN}`, isAdmin });
    expect(u.statusCode, u.body).toBe(201);
    const id = u.json().id as string;
    const token = (await inject("POST", `/v1/users/${id}/keys`, AUTH, { name: "b3" })).json().token as string;
    users[k] = { id, auth: { authorization: `Bearer ${token}` } };
  }
  keyDir = mkdtempSync(path.join(tmpdir(), "b3-key-"));
  const kp = generateKeyPairSync("ed25519");
  writeFileSync(path.join(keyDir, "receipt.pem"), kp.privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600 });
  publicPem = kp.publicKey.export({ format: "pem", type: "spki" }) as string;
  withKey(false);
  await seed();
  warmCycloneDxValidators();
}, 300_000);

afterAll(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(keyDir, { recursive: true, force: true });
  app.server.closeAllConnections();
  await app.close();
  await (db.$client as { end: () => Promise<void> }).end();
  await dropScratchDatabase(admin, SCRATCH);
  await (admin.$client as { end: () => Promise<void> }).end();
}, 120_000);

const subjectOf = (kind: AiBomSubjectKind) =>
  ({ use_case: ids.useCase!, agent: ids.agent!, builder_agent: ids.builder!, install: AI_BOM_INSTALL_SUBJECT_ID })[kind];
const META = (kind: AiBomSubjectKind) => ({ id: randomUUID(), subjectKind: kind, subjectId: subjectOf(kind), version: 1, supersedes: null, trigger: "on_demand" as const, createdAt: new Date().toISOString() });
async function loadAndBuild(kind: AiBomSubjectKind) {
  const records = await db.transaction((tx) => loadAiBomRecords(tx as unknown as Db, { kind, id: subjectOf(kind) }, { personIdentifiers: "id_only", installId: kind === "install" ? "b3-install" : null }), { isolationLevel: "repeatable read" });
  return { records, build: buildAiBom(records, META(kind), { cyclonedxVersions: ["1.7", "1.6"] }) };
}

describe("R31/R32: the loader on real rows, every subject kind", () => {
  it("builds and validates one snapshot of each kind against CycloneDX 1.7 and 1.6", async () => {
    for (const kind of ["use_case", "agent", "builder_agent", "install"] as const) {
      const { build } = await loadAndBuild(kind);
      for (const r of build.renderings) {
        if (r.format === "spdx-3.0.1") {
          expect(validateSpdx(JSON.parse(r.bytes)).errors, `${kind} spdx`).toEqual([]);
          continue;
        }
        const v = r.format === "cyclonedx-1.7" ? "1.7" : "1.6";
        expect(validateCycloneDx(JSON.parse(r.bytes), v).errors, `${kind} ${v}`).toEqual([]);
      }
      // B5 (R2, R3): SPDX is always attempted; on these real rows (datasets, cards without supplier release facts)
      // the body records not_producible with the missing property names, never a placeholder
      const spdx = build.body.renderings["spdx-3.0.1"];
      expect(spdx, kind).toBeDefined();
      if (spdx!.status === "not_producible") expect(spdx!.missing.length, kind).toBeGreaterThan(0);
      else expect(build.renderings.some((r) => r.format === "spdx-3.0.1"), kind).toBe(true);
      expect(aiBomNativeBodySchema.safeParse(JSON.parse(build.bodyBytes)).success, kind).toBe(true);
    }
  }, 120_000);

  it("OWNER DECISION 5 / R47 / #280: no canary from any content column reaches any byte, in any subject kind", async () => {
    for (const kind of ["use_case", "agent", "builder_agent", "install"] as const) {
      const { records, build } = await loadAndBuild(kind);
      const bytes = [build.bodyBytes, ...build.renderings.map((r) => r.bytes)].join("\n");
      for (const c of CANARIES) expect(bytes.includes(c), `${kind}: ${c}`).toBe(false);
      // the loaded record set itself never holds content: those columns are not even selected
      for (const c of CONTENT_CANARIES) expect(JSON.stringify(records).includes(c), `${kind} records: ${c}`).toBe(false);
    }
  }, 120_000);

  it("negative control for the canary scan: the seeded rows really hold the canaries the loader must skip", async () => {
    const r = await db.execute(sql`select (select system_prompt from agents where id = ${ids.agent}) as sp, (select template from prompt_commits where template = 'CANARY_TEMPLATE' limit 1) as t`);
    expect(rowsOf<{ sp: string; t: string }>(r)[0]).toEqual({ sp: "CANARY_SYSTEM_PROMPT", t: "CANARY_TEMPLATE" });
  });

  it("maps the real rows: one model per card with its pinned version, origin-only endpoints, granted tools, the scan engine", async () => {
    const { build } = await loadAndBuild("use_case");
    const doc = JSON.parse(build.renderings[0]!.bytes);
    const comp = (ref: string) => doc.components.find((c: { "bom-ref": string }) => c["bom-ref"] === ref);
    const deps = (ref: string) => doc.dependencies.find((d: { ref: string }) => d.ref === ref)?.dependsOn ?? [];
    expect(comp(`model:${ids.card1}`).version).toBe("2026-06-01");
    expect(comp(`model:${ids.card2}`).version).toBeUndefined();
    expect(deps(`agent:${ids.agent}`)).toEqual(expect.arrayContaining([`model:${ids.card1}`, `model:${ids.card2}`, `service:mcp:${ids.mcp}:tool:${ids.tool}`, `service:connector:${ids.connector}`]));
    expect(deps(`model:${ids.card2}`)).toContain(`artifact:${ids.artifact}`);
    expect(doc.services.find((s: { "bom-ref": string }) => s["bom-ref"] === `service:mcp:${ids.mcp}`).endpoints).toEqual(["https://mcp.test"]);
    expect(doc.services.find((s: { "bom-ref": string }) => s["bom-ref"] === `service:connector:${ids.connector}`)).toMatchObject({ endpoints: ["https://crm.test"], authenticated: true });
    // R24/R30: `projects` records no classification, so the dataset says so instead of inventing one
    expect(build.gaps).toContainEqual({ ref: `dataset:training:${ids.trainingDataset}:1`, field: "classification", reason: "project_classification_not_recorded" });
    // R12: the scan names the exact engine/version; the engine catalogue's digest is only used for its own version
    expect(doc.components.some((c: { "bom-ref": string }) => c["bom-ref"].startsWith("engine:modelscan/0.8.8/"))).toBe(true);
  }, 60_000);

  it("R47: an endpoint with userinfo refuses the build, naming the service", async () => {
    await db.update(connectors).set({ baseUrl: "https://u:p@crm.test/api" }).where(eq(connectors.id, ids.connector!));
    try {
      await expect(loadAndBuild("use_case")).rejects.toThrow(/userinfo/);
    } finally {
      await db.update(connectors).set({ baseUrl: "https://crm.test/api?api_key=CANARY_QS" }).where(eq(connectors.id, ids.connector!));
    }
  }, 60_000);
});

describe("the freeze (R50, OWNER DECISIONS 2 and 12)", () => {
  it("no signing key: 409 bom_signing_unavailable and nothing is written", async () => {
    withKey(false);
    const before = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from ai_bom_snapshots`))[0]!.n;
    const e = await takeAiBomSnapshot(db, { subject: { kind: "agent", id: ids.agent! }, trigger: "on_demand", actorUserId: users.admin.id }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AiBomError);
    expect(e).toMatchObject({ status: 409, code: "bom_signing_unavailable" });
    expect(rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from ai_bom_snapshots`))[0]!.n).toBe(before);
  });

  it("with the key: the stored body is the signed exact bytes, renderings are stored with their hashes, and the audit row is written", async () => {
    withKey(true);
    try {
      const auditBefore = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from audit_log where rule_id = 'ai-bom-snapshot-taken'`))[0]!.n;
      const t = await takeAiBomSnapshot(db, { subject: { kind: "use_case", id: ids.useCase! }, trigger: "on_demand", actorUserId: users.admin.id });
      const [row] = await db.select().from(aiBomSnapshots).where(eq(aiBomSnapshots.id, t.id));
      expect(row!.body).toBe(t.build.bodyBytes);
      expect(verify(null, Buffer.from(row!.body, "utf8"), createPublicKey(publicPem), Buffer.from(row!.signature, "base64url"))).toBe(true);
      // negative control: one changed byte does not verify
      expect(verify(null, Buffer.from(row!.body.replace("use_case", "use_casf"), "utf8"), createPublicKey(publicPem), Buffer.from(row!.signature, "base64url"))).toBe(false);
      const rends = await db.select().from(bomRenderings).where(eq(bomRenderings.aiBomSnapshotId, t.id));
      expect(rends.map((r) => r.format).sort()).toEqual(["cyclonedx-1.7"]); // strict default: 1.7 only
      const body = JSON.parse(row!.body);
      expect(body.renderings["cyclonedx-1.7"].sha256).toBe(createHash("sha256").update(rends[0]!.bytes).digest("hex"));
      expect(rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from audit_log where rule_id = 'ai-bom-snapshot-taken'`))[0]!.n).toBe(auditBefore + 1);
    } finally {
      withKey(false);
    }
  }, 60_000);

  it("4237346650: a freeze that waits behind another writer of the subject captures AFTER it (fresh snapshot, next version)", async () => {
    withKey(true);
    const other = createDb(urlFor(SCRATCH));
    try {
      const subject = { kind: "agent" as const, id: ids.agent2! };
      // another writer (another replica) holds the subject: it takes the lock FIRST, then captures and commits slowly
      let locked!: () => void;
      const holding = new Promise<void>((r) => { locked = r; });
      const holder = other.transaction(async (tx) => {
        await lockAiBomSubject(tx, subject.kind, subject.id);
        locked();
        const t = await captureAiBomSnapshotInTx(tx as unknown as Db, { subject, trigger: "on_demand", actorUserId: null });
        await new Promise((r) => setTimeout(r, 1_000));
        return t;
      }, { isolationLevel: "repeatable read" });
      await holding;
      const waiter = takeAiBomSnapshot(db, { subject, trigger: "on_demand", actorUserId: users.admin.id });
      const [h, w] = await Promise.all([holder, waiter]);
      expect(w.version).toBe(h.version + 1);
      const [row] = await db.select({ s: aiBomSnapshots.supersedesId }).from(aiBomSnapshots).where(eq(aiBomSnapshots.id, w.id));
      expect(row!.s).toBe(h.id);
      // in-process single-flight: a burst for one subject gets one freeze and fast 409s, never a queue of parked connections
      const burst = await Promise.allSettled([1, 2, 3].map(() => takeAiBomSnapshot(db, { subject, trigger: "on_demand", actorUserId: users.admin.id })));
      expect(burst.filter((r) => r.status === "fulfilled").length).toBe(1);
      for (const r of burst.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect(r.reason).toMatchObject({ status: 409, code: "bom_snapshot_busy" });
      const versions = (await db.select({ v: aiBomSnapshots.version }).from(aiBomSnapshots).where(and(eq(aiBomSnapshots.subjectKind, "agent"), eq(aiBomSnapshots.subjectId, ids.agent2!)))).map((x) => x.v).sort((x, y) => x - y);
      expect(versions).toEqual(versions.map((_, i) => i + 1));
    } finally {
      await (other.$client as { end: () => Promise<void> }).end();
      withKey(false);
    }
  }, 120_000);

  it("NEGATIVE CONTROL: the transaction-scoped lock inside REPEATABLE READ lets a stale capture race, and the database refuses it", async () => {
    withKey(true);
    try {
      const subject = { kind: "builder_agent" as const, id: ids.builder! };
      const xactOnly = () =>
        db.transaction(async (tx) => {
          await lockAiBomSubject(tx, subject.kind, subject.id); // the snapshot is fixed BEFORE this wait
          return captureAiBomSnapshotInTx(tx as unknown as Db, { subject, trigger: "on_demand", actorUserId: null });
        }, { isolationLevel: "repeatable read" });
      const results = await Promise.allSettled([xactOnly(), xactOnly(), xactOnly()]);
      expect(results.filter((r) => r.status === "rejected").length).toBeGreaterThan(0);
      const reasons = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => `${String((r.reason as Error).message)} ${String((r.reason as { cause?: Error }).cause?.message ?? "")}`);
      for (const m of reasons) expect(m).toMatch(/must be \d+ and supersede|duplicate key|could not serialize/);
    } finally {
      withKey(false);
    }
  }, 120_000);

  it("a capture outside REPEATABLE READ is refused", async () => {
    withKey(true);
    try {
      const e = await db.transaction((tx) => captureAiBomSnapshotInTx(tx as unknown as Db, { subject: { kind: "agent", id: ids.agent! }, trigger: "on_demand", actorUserId: null })).catch((x: unknown) => x);
      expect(e).toMatchObject({ code: "ai_bom_capture_isolation" });
    } finally {
      withKey(false);
    }
  });

  it("R2: the trigger gate does nothing while snapshots are not released", async () => {
    expect(AI_BOM_SNAPSHOTS_RELEASED).toBe(false);
    withKey(true);
    try {
      const before = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from ai_bom_snapshots`))[0]!.n;
      const r = await db.transaction((tx) => aiBomSnapshotTriggerGate(tx as unknown as Db, { subject: { kind: "agent", id: ids.agent! }, trigger: "model_card_approval", actorUserId: null }), { isolationLevel: "repeatable read" });
      expect(r).toEqual({ status: "not_released" });
      expect(rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from ai_bom_snapshots`))[0]!.n).toBe(before);
    } finally {
      withKey(false);
    }
  });
});

describe("routes (R2, R8, R17, §7)", () => {
  it("POST snapshots: 501 bom_snapshots_not_released to an admin, even with a key; 403 member; 401 anonymous", async () => {
    withKey(true);
    try {
      const url = `/v1/ai-bom/use_case/${ids.useCase}/snapshots`;
      const r = await inject("POST", url, users.admin.auth, {});
      expect(r.statusCode, r.body).toBe(501);
      expect(r.json().error).toBe("bom_snapshots_not_released");
      expect((await inject("POST", url, users.member.auth, {})).statusCode).toBe(403);
      expect((await inject("POST", url, {}, {})).statusCode).toBe(401);
    } finally {
      withKey(false);
    }
  });

  it("drift: 409 with no snapshot; a change list with evidence:false after one; audited; the list route too", async () => {
    const none = await inject("GET", `/v1/ai-bom/agent/${ids.agent}/drift`, users.admin.auth);
    expect(none.statusCode, none.body).toBe(409);
    expect(none.json().error).toBe("ai_bom_no_snapshot");
    // the use case was frozen above; change a fact and look
    await db.update(modelArtifacts).set({ sha256: H("9"), storageKey: `sha256/${H("9")}` }).where(eq(modelArtifacts.id, ids.artifact!));
    await db.update(modelCards).set({ pinnedModelVersion: "2026-07-01" }).where(eq(modelCards.id, ids.card1!));
    const before = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from audit_log where rule_id = 'ai-bom-drift-viewed'`))[0]!.n;
    const d = await inject("GET", `/v1/ai-bom/use_case/${ids.useCase}/drift`, users.admin.auth);
    expect(d.statusCode, d.body).toBe(200);
    const body = d.json();
    expect(body.evidence).toBe(false);
    expect(body.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: `artifact:${ids.artifact}`, change: "changed_hash" }),
      expect.objectContaining({ ref: `model:${ids.card1}`, change: "changed_version" }),
    ]));
    for (const c of CANARIES) expect(d.body.includes(c), c).toBe(false);
    expect(rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from audit_log where rule_id = 'ai-bom-drift-viewed'`))[0]!.n).toBe(before + 1);
    const list = await inject("GET", `/v1/ai-bom/use_case/${ids.useCase}/snapshots`, users.admin.auth);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toMatchObject({ released: false, snapshots: [expect.objectContaining({ version: 1, formats: ["cyclonedx-1.7"] })] });
    expect((await db.select().from(auditLog).where(eq(auditLog.ruleId, "ai-bom-snapshots-listed"))).length).toBeGreaterThan(0);
    expect((await inject("GET", `/v1/ai-bom/use_case/${ids.useCase}/drift`, users.member.auth)).statusCode).toBe(403);
  }, 60_000);

  it("rejects a malformed subject and an install subject that is not the nil key; 404 for an unknown subject", async () => {
    expect((await inject("GET", `/v1/ai-bom/robot/${ids.agent}/drift`, users.admin.auth)).statusCode).toBe(400);
    expect((await inject("GET", `/v1/ai-bom/install/${ids.agent}/drift`, users.admin.auth)).statusCode).toBe(400);
    const missing = await inject("GET", `/v1/ai-bom/agent/${randomUUID()}/drift`, users.admin.auth);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("ai_bom_subject_not_found");
  });

  it("§7: the per-person export limit holds (429 after the limit), and a lowered limit is restored", async () => {
    await db.execute(sql`update org_settings set bom_export_rate_limit_per_minute = 2`);
    try {
      const url = `/v1/ai-bom/agent/${ids.agent}/snapshots`;
      expect((await inject("GET", url, users.admin2.auth)).statusCode).toBe(200);
      expect((await inject("GET", url, users.admin2.auth)).statusCode).toBe(200);
      const third = await inject("GET", url, users.admin2.auth);
      expect(third.statusCode).toBe(429);
      expect(third.json().error).toBe("rate_limited");
    } finally {
      await db.execute(sql`update org_settings set bom_export_rate_limit_per_minute = 30`);
    }
  });
});

describe("PR #287 MEDIUM: the per-subject lock wait is bounded and single-flight", () => {
  const LOCK_BOUND_MS = 5_000; // the documented bound (BOM_SUBJECT_LOCK_TIMEOUT_MS)
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  it("a waiter behind a holder fails bounded with bom_snapshot_busy, and the small pool still serves an unrelated query", async () => {
    const small = createDb(urlFor(SCRATCH), { max: 2 });
    const holderDb = createDb(urlFor(SCRATCH), { max: 1 });
    const subject = randomUUID();
    const holder = await (holderDb.$client as { connect: () => Promise<{ query: (q: string, p?: unknown[]) => Promise<unknown>; release: () => void }> }).connect();
    await holder.query("select pg_advisory_lock($1::int, hashtext($2))", [BOM_SUBJECT_LOCK_NAMESPACE, `agent:${subject}`]);
    try {
      const waiter = withAiBomSubjectSessionLock(small, "agent", subject, async () => "ran").then(() => "acquired", (e: unknown) => e);
      const other = await small.execute(sql`select 1 as one`);
      expect(rowsOf<{ one: number }>(other)[0]!.one).toBe(1);
      const outcome = await Promise.race([waiter, sleep(LOCK_BOUND_MS + 5_000).then(() => "hung")]);
      expect(outcome, "the waiter must not hang past the bound").not.toBe("hung");
      expect((outcome as { code?: string }).code).toBe("bom_snapshot_busy");
    } finally {
      await holder.query("select pg_advisory_unlock($1::int, hashtext($2))", [BOM_SUBJECT_LOCK_NAMESPACE, `agent:${subject}`]);
      holder.release();
      await sleep(200);
      await (small.$client as { end: () => Promise<void> }).end();
      await (holderDb.$client as { end: () => Promise<void> }).end();
    }
  }, 30_000);

  it("a second in-process request for the same subject is refused at once (single-flight), another subject proceeds", async () => {
    const subject = randomUUID();
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    const first = withAiBomSubjectSessionLock(db, "agent", subject, async () => { await gate; return "first"; });
    await sleep(50);
    const second = await withAiBomSubjectSessionLock(db, "agent", subject, async () => "second").then((v) => v, (e: unknown) => e);
    expect((second as { code?: string }).code).toBe("bom_snapshot_busy");
    expect(await withAiBomSubjectSessionLock(db, "agent", randomUUID(), async () => "other")).toBe("other");
    open();
    expect(await first).toBe("first");
  }, 30_000);
});

describe("PR #287 LOW: atomic audit, no echoed values", () => {
  it("the snapshot and its audit row commit together: a failing audit append leaves no snapshot", async () => {
    withKey(true);
    // scratch database only: a test trigger that refuses this one audit rule
    await db.execute(sql.raw(`CREATE FUNCTION b3_refuse_snapshot_audit() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN IF NEW.rule_id = 'ai-bom-snapshot-taken' THEN RAISE EXCEPTION 'b3 test: audit refused'; END IF; RETURN NEW; END $$`));
    await db.execute(sql.raw(`CREATE TRIGGER b3_refuse_snapshot_audit BEFORE INSERT ON public.audit_log FOR EACH ROW EXECUTE FUNCTION b3_refuse_snapshot_audit()`));
    try {
      const subject = { kind: "use_case" as const, id: ids.useCase! };
      const count = async () => rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from ai_bom_snapshots where subject_id = ${subject.id}`))[0]!.n;
      const before = await count();
      const e = await takeAiBomSnapshot(db, { subject, trigger: "on_demand", actorUserId: users.admin.id }).catch((x: unknown) => x);
      expect(String((e as Error).message) + String((e as { cause?: Error }).cause?.message ?? "")).toMatch(/audit refused/);
      expect(await count()).toBe(before);
    } finally {
      await db.execute(sql.raw(`DROP TRIGGER b3_refuse_snapshot_audit ON public.audit_log`));
      await db.execute(sql.raw(`DROP FUNCTION b3_refuse_snapshot_audit()`));
      withKey(false);
    }
  }, 60_000);

  it("a 422 refusal names the field and rule, never the record value", async () => {
    const [uc] = await db.select({ name: aiUseCases.name }).from(aiUseCases).where(eq(aiUseCases.id, ids.useCase!));
    await db.update(aiUseCases).set({ name: "owner leak.person@example.com" }).where(eq(aiUseCases.id, ids.useCase!));
    try {
      const r = await inject("GET", `/v1/ai-bom/use_case/${ids.useCase}/drift`, users.admin.auth);
      expect(r.statusCode, r.body).toBe(422);
      expect(r.json().error).toBe("ai_bom_build_refused");
      expect(r.body).toMatch(/\$\.[A-Za-z.\[\]0-9]*name/); // the field path
      expect(r.body).not.toContain("leak.person");
    } finally {
      await db.update(aiUseCases).set({ name: uc!.name }).where(eq(aiUseCases.id, ids.useCase!));
    }
  }, 60_000);
});
