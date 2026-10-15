/**
 * ADR-0190 (batch 6 item 3) I8 — EXECUTION FACTS, on a real database.
 *
 * On a scratch database of its own (it writes audit rows, which can never be deleted), this file proves:
 *  - MIGRATION 0197: its journal entry sorts after 0196 with a later `when` (hand-written, never drizzle-kit
 *    generate); `decision_facts` accepts v1 and v2 facts and refuses any other version; `decision_boms` accepts a
 *    v1 or v2 body and refuses any other; the facts column defaults to v2.
 *  - THE I4/I8 CONTRACT: an `execution_placements` row written in the decision's own transaction, before the
 *    audit row, is captured in that decision's `regulait.decision-facts.v2` (class, the floor that set it, profile
 *    id/name/version/digest, executor and its workload identity, the per-placement report and the passing
 *    executor self-test it relied on). A placement written in another transaction is not (nothing is inferred),
 *    and a failing or later self-test is never the one named.
 *  - With no placement row: a remote MCP call records `external`, a model call `in_gateway`, a stdio call and an
 *    approval record nothing (null).
 *
 * Postgres must already be running (`DATABASE_URL`); this file never starts or stops it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { auditLog, createDb, eq, mcpServers, runMigrations, sql, type Db } from "@regulait/db";
import {
  AI_BOM_INSTALL_SUBJECT_ID,
  bomCanonicalBytes,
  bomDigestOf,
  buildAiBom,
  DECISION_BOM_VERSION,
  DECISION_BOM_VERSION_V2,
  DECISION_FACTS_VERSION,
  DECISION_FACTS_VERSION_V2,
  decisionFactsSchema,
  executionFactsOf,
  executionProfileDigest,
  SHIPPED_EXECUTION_PROFILES,
} from "@regulait/shared";
import { loadAiBomRecords } from "./ai-bom.js";
import { closeAll, dropScratchDatabase } from "./testing/scratch-db.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");
const MIGRATION = "0197_decision_facts_execution";
const PREVIOUS = "0196_";
const RUN = Math.random().toString(36).slice(2, 8);
const SCRATCH = `a190_i8_${process.pid}_${RUN}`;
const RESTRICTED_DIGEST = executionProfileDigest(SHIPPED_EXECUTION_PROFILES.restricted);
const H = (c: string) => c.repeat(64);
const SIG = "A".repeat(86);
const EXECUTOR_URI = `spiffe://i8.example.org/regulait/worker_runtime/executor-${RUN}`;

const rows = <T>(r: unknown) => (r as { rows: T[] }).rows;
const urlFor = (name: string) => {
  const u = new URL(DATABASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
};
function refusalText(e: unknown): string {
  return `${String((e as Error)?.message ?? e)} ${String((e as { cause?: Error })?.cause?.message ?? "")}`;
}
async function expectRefused(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const e = await Promise.resolve(p).then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, `the statement was refused (${pattern})`).not.toBeNull();
  expect(refusalText(e)).toMatch(pattern);
}
class RolledBack extends Error {}
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  await db
    .transaction(async (tx) => {
      await body(tx);
      throw new RolledBack();
    })
    .catch((e: unknown) => {
      if (!(e instanceof RolledBack)) throw e;
    });
}
const inSavepoint = (tx: Tx, stmt: ReturnType<typeof sql>) => tx.transaction((sp) => sp.execute(stmt));

let admin: Db;
let db: Db;
let userId: string;
let stdioId: string;
let remoteId: string;
let executorId: string;
let executorIdentityId: string;
let profile: { id: string; name: string; version: number; digest: string };
let passingAttestation: { id: string; reportSha256: string };

/** a receipt-eligible decision row, as every governed writer appends it (through the one shared writer) */
const decisionValues = (extra: Record<string, unknown>) => ({
  userId, objectType: "mcp_tool" as const, serverId: stdioId, toolName: "run", effect: "allow" as const, ruleId: "i8-probe", ruleChain: [], reason: "i8 probe",
  detail: { receiptClass: "decision" }, ...extra,
});
async function factsOf(auditId: string) {
  const [row] = rows<{ facts_version: string; facts: unknown; facts_hash: string }>(await db.execute(sql`select facts_version, facts, facts_hash from decision_facts where audit_id = ${auditId}`));
  expect(row, `decision ${auditId} has its facts`).toBeDefined();
  const facts = decisionFactsSchema.parse(row!.facts);
  expect(row!.facts_version).toBe(facts.v);
  expect(row!.facts_hash).toBe(bomDigestOf(facts));
  return facts;
}
const placementSql = (auditId: string, o: { outcome?: "placed" | "refused" } = {}) =>
  o.outcome === "refused"
    ? sql`insert into execution_placements (audit_id, workload_kind, required_class, required_by, enforcement, profile_digest, executor_id, applied_class, report_sha256, outcome, refusal_code)
          values (${auditId}, 'mcp_stdio', 'microvm', 'data_sensitivity', 'enforce', ${RESTRICTED_DIGEST}, null, null, null, 'refused', 'no_executor') returning id`
    : sql`insert into execution_placements (audit_id, workload_kind, required_class, required_by, enforcement, profile_digest, executor_id, applied_class, report_sha256, outcome)
          values (${auditId}, 'mcp_stdio', 'user_space_kernel', 'workload_kind', 'enforce', ${RESTRICTED_DIGEST}, ${executorId}, 'user_space_kernel', ${H("b")}, 'placed') returning id`;

beforeAll(async () => {
  admin = createDb(DATABASE_URL);
  await admin.execute(sql.raw(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`));
  await admin.execute(sql.raw(`CREATE DATABASE ${SCRATCH}`));
  db = createDb(urlFor(SCRATCH));
  await runMigrations(db, migrationsFolder);
  userId = rows<{ id: string }>(await db.execute(sql`insert into users (email, display_name) values (${`i8-${RUN}@example.com`}, ${`i8 ${RUN}`}) returning id`))[0]!.id;
  const sName = `i8-stdio-${RUN}`;
  stdioId = (await db.insert(mcpServers).values({ name: sName, url: `stdio:${sName}`, transport: "stdio", stdioCommand: "/opt/mcp/bin/i8", stdioArgs: [], stdioCommandDigest: "0".repeat(64) }).returning())[0]!.id;
  remoteId = (await db.insert(mcpServers).values({ name: `i8-remote-${RUN}`, url: "https://mcp.example.com/i8" }).returning())[0]!.id;
  profile = rows<{ id: string; name: string; version: number; digest: string }>(await db.execute(sql`select id, name, version, digest from execution_profiles where digest = ${RESTRICTED_DIGEST}`))[0]!;
  executorIdentityId = rows<{ id: string }>(
    await db.execute(sql`insert into workload_identities (kind, identifier, sponsor_user_ids) values ('worker_runtime', ${EXECUTOR_URI}, ARRAY[${userId}]::uuid[]) returning id`),
  )[0]!.id;
  executorId = rows<{ id: string }>(
    await db.execute(sql`insert into executors (workload_identity_id, name, backend, runtime_version, classes_declared)
      values (${executorIdentityId}, ${`i8-${RUN}`}, 'gvisor', 'fake-0.0.0', '["hardened_container", "user_space_kernel"]'::jsonb) returning id`),
  )[0]!.id;
  // the self-test the placement relies on: passing, observed before it, fresh at it
  passingAttestation = rows<{ id: string; reportSha256: string }>(
    await db.execute(sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
      values (${executorId}, ${RESTRICTED_DIGEST}, 'user_space_kernel', ${H("c")}, '{}'::jsonb, 'pass', now() - interval '10 minutes', now() + interval '1 hour') returning id, report_sha256 as "reportSha256"`),
  )[0]!;
  // NEGATIVE CONTROLS: a newer FAILING self-test, and an older pass that had expired, are never the one named
  await db.execute(sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
    values (${executorId}, ${RESTRICTED_DIGEST}, 'user_space_kernel', ${H("d")}, '{}'::jsonb, 'fail', now() - interval '1 minute', now() + interval '1 hour')`);
  await db.execute(sql`insert into executor_attestations (executor_id, profile_digest, class, report_sha256, report, verdict, observed_at, expires_at)
    values (${executorId}, ${RESTRICTED_DIGEST}, 'user_space_kernel', ${H("e")}, '{}'::jsonb, 'pass', now() - interval '3 hours', now() - interval '2 hours')`);
}, 120_000);

afterAll(async () => {
  await closeAll([async () => db?.$client.end(), async () => dropScratchDatabase(admin, SCRATCH), async () => admin?.$client.end()]);
});

// ---------------------------------------------------------------------------
describe("ADR-0190 I8 migration 0197", () => {
  it("the journal places 0197 after 0196 with a strictly later `when`, and after every earlier migration (never drizzle-kit generate)", () => {
    const journal = JSON.parse(readFileSync(path.join(migrationsFolder, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; when: number; tag: string }> };
    const mine = journal.entries.find((e) => e.tag === MIGRATION)!;
    expect(mine).toBeDefined();
    const previous = journal.entries.find((e) => e.tag.startsWith(PREVIOUS));
    expect(previous, "0196 is in the journal before 0197").toBeDefined();
    expect(mine.idx).toBe(previous!.idx + 1);
    for (const e of journal.entries.filter((x) => x.idx < mine.idx)) expect(mine.when, e.tag).toBeGreaterThan(e.when);
    for (const e of journal.entries.filter((x) => x.idx > mine.idx)) expect(e.when, e.tag).toBeGreaterThan(mine.when);
  });

  it("decision_facts holds v1 and v2 facts and refuses any other version; the column defaults to v2", async () => {
    const def = rows<{ d: string }>(await db.execute(sql`select column_default as d from information_schema.columns where table_name = 'decision_facts' and column_name = 'facts_version'`))[0]!.d;
    expect(def).toContain(DECISION_FACTS_VERSION_V2);
    await inRolledBackTx(async (tx) => {
      const base = { action: null, policy: null, model: null, actors: null, outcome: { effect: "allow", refusalCode: null, upstreamStatusClass: null }, rows: [] };
      // the marker is append-only, so each case gets a marker that carries its facts' hash from the start
      const exact = async (seq: number, v: string, extra: Record<string, unknown>, version: string | null) => {
        const auditId = randomUUID();
        const facts = { ...base, ...extra, v, auditSeq: seq, auditId };
        const hash = bomDigestOf(facts);
        await tx.execute(sql`insert into decision_capture_status (audit_id, audit_seq, audit_at, status, facts_hash) values (${auditId}, ${seq}, now(), 'captured', ${hash})`);
        return version === null
          ? inSavepoint(tx, sql`insert into decision_facts (audit_id, audit_seq, facts, facts_hash) values (${auditId}, ${seq}, ${JSON.stringify(facts)}::jsonb, ${hash})`)
          : inSavepoint(tx, sql`insert into decision_facts (audit_id, audit_seq, facts_version, facts, facts_hash) values (${auditId}, ${seq}, ${version}, ${JSON.stringify(facts)}::jsonb, ${hash})`);
      };
      await exact(970001, DECISION_FACTS_VERSION_V2, { execution: null }, null); // the default is v2
      await exact(970002, DECISION_FACTS_VERSION, {}, DECISION_FACTS_VERSION); // stored v1 facts stay valid
      await expectRefused(exact(970003, DECISION_FACTS_VERSION, {}, null), /decision_facts_payload_check/); // v1 facts under the v2 default
      await expectRefused(exact(970004, "regulait.decision-facts.v3", { execution: null }, "regulait.decision-facts.v3"), /decision_facts_version_check/);
    });
  });

  it("decision_boms holds a v1 or v2 body and refuses any other version", async () => {
    await inRolledBackTx(async (tx) => {
      const keyId = `i8-${RUN}`;
      const x = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x!;
      await tx.execute(sql`insert into receipt_signing_keys (key_id, public_jwk) values (${keyId}, ${JSON.stringify({ kty: "OKP", crv: "Ed25519", x })}::jsonb)`);
      const auditId = randomUUID();
      await tx.execute(sql`insert into decision_capture_status (audit_id, audit_seq, audit_at, status, facts_hash, expires_at) values (${auditId}, 970010, now(), 'capture_off', null, '2027-10-10T00:00:00Z')`);
      const bom = (v: string, version: number, supersedes: string | null) => {
        const id = randomUUID();
        const body = bomCanonicalBytes({ v, id, auditId, version, finality: "chain_signed", supersedes });
        return { id, stmt: sql`insert into decision_boms (id, audit_id, version, supersedes_id, finality, body, body_sha256, signature, key_id, basis, expires_at)
          values (${id}, ${auditId}, ${version}, ${supersedes}, 'chain_signed', ${body}, encode(sha256(convert_to(${body}, 'UTF8')), 'hex'), ${SIG}, ${keyId}, '{}'::jsonb, '2027-10-10T00:00:00Z')` };
      };
      const v1 = bom(DECISION_BOM_VERSION, 1, null);
      await tx.execute(v1.stmt);
      await expectRefused(inSavepoint(tx, bom("regulait.decision-bom.v3", 2, v1.id).stmt), /decision_boms_body_check/);
      // a v2 body supersedes a frozen v1 one (a new fact on a decision frozen before I8)
      await tx.execute(bom(DECISION_BOM_VERSION_V2, 2, v1.id).stmt);
    });
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 I8: the placement row of the decision's transaction is captured (the I4/I8 contract)", () => {
  it("a placement written in the decision's own transaction, before its audit row, is in its facts", async () => {
    const auditId = randomUUID();
    let placementId = "";
    await db.transaction(async (tx) => {
      placementId = rows<{ id: string }>(await tx.execute(placementSql(auditId)))[0]!.id;
      await tx.insert(auditLog).values(decisionValues({ id: auditId }));
    });
    const facts = await factsOf(auditId);
    expect(facts.v).toBe(DECISION_FACTS_VERSION_V2);
    expect(executionFactsOf(facts)).toEqual({
      workloadKind: "mcp_stdio",
      placement: "placed",
      placementId,
      requiredClass: "user_space_kernel",
      requiredBy: "workload_kind",
      appliedClass: "user_space_kernel",
      refusalCode: null,
      profile: { id: profile.id, name: profile.name, version: profile.version, digest: RESTRICTED_DIGEST },
      executor: { id: executorId, backend: "gvisor", runtimeVersion: "fake-0.0.0", identityId: executorIdentityId, identity: EXECUTOR_URI },
      // the passing self-test that was fresh at the placement; never the newer failure or the expired pass
      attestation: { placementReportSha256: H("b"), executorAttestationId: passingAttestation.id, executorReportSha256: H("c") },
    });
  });

  it("a refusal written in the decision's transaction is captured with its reason and nothing it did not start", async () => {
    const auditId = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute(placementSql(auditId, { outcome: "refused" }));
      await tx.insert(auditLog).values(decisionValues({ id: auditId, effect: "deny" }));
    });
    expect(executionFactsOf(await factsOf(auditId))).toMatchObject({
      placement: "refused", requiredClass: "microvm", requiredBy: "data_sensitivity", refusalCode: "no_executor",
      appliedClass: null, executor: null, attestation: null, profile: { digest: RESTRICTED_DIGEST },
    });
  });

  it("NEGATIVE CONTROL: a placement written after the decision's transaction is not captured; a stdio call records nothing", async () => {
    const auditId = randomUUID();
    await db.insert(auditLog).values(decisionValues({ id: auditId }));
    await db.execute(placementSql(auditId));
    const facts = await factsOf(auditId);
    expect(facts.v).toBe(DECISION_FACTS_VERSION_V2);
    expect(executionFactsOf(facts)).toBeNull();
  });

  it("with no placement row: a remote MCP call ran on the upstream's host, a model call in the gateway, an approval executes nothing", async () => {
    const remote = randomUUID();
    await db.insert(auditLog).values(decisionValues({ id: remote, serverId: remoteId }));
    expect(executionFactsOf(await factsOf(remote))).toMatchObject({ workloadKind: "remote_mcp", placement: "external", appliedClass: "external", profile: null, executor: null });
    const model = randomUUID();
    await db.insert(auditLog).values(decisionValues({ id: model, objectType: "agent", objectId: randomUUID(), serverId: null, toolName: null }));
    expect(executionFactsOf(await factsOf(model))).toMatchObject({ workloadKind: "model_call", placement: "in_gateway", appliedClass: "in_gateway" });
    const approval = randomUUID();
    await db.insert(auditLog).values(decisionValues({ id: approval, objectType: "approval", objectId: randomUUID(), serverId: null, toolName: null }));
    expect(executionFactsOf(await factsOf(approval))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("ADR-0190 I8: the AI BOM loader reads profiles, assignments and executors (decision 9)", () => {
  it("the install snapshot carries the profile, the stdio server's assignment, and only the executor's fresh passing self-test", async () => {
    await db.update(mcpServers).set({ executionProfileId: profile.id }).where(eq(mcpServers.id, stdioId));
    const r = await loadAiBomRecords(db, { kind: "install", id: AI_BOM_INSTALL_SUBJECT_ID }, { personIdentifiers: "id_only", installId: null });
    expect(r.executionProfiles).toContainEqual({ id: profile.id, name: profile.name, version: profile.version, digest: RESTRICTED_DIGEST, minClass: "user_space_kernel", shipped: true, retired: false });
    expect(r.executionAssignments).toContainEqual({ targetKind: "mcp_server", targetId: stdioId, profileId: profile.id });
    const ours = r.executors!.find((e) => e.id === executorId)!;
    expect(ours).toMatchObject({ backend: "gvisor", status: "active", workloadIdentity: EXECUTOR_URI });
    // the newer FAILING self-test and the expired pass are not evidence
    expect(ours.attestations.map((a) => a.reportSha256)).toEqual([H("c")]);
    // the record set builds: the server is attested at L2 for its profile, so it has no isolation gap
    const built = buildAiBom(r, { id: randomUUID(), subjectKind: "install", subjectId: AI_BOM_INSTALL_SUBJECT_ID, version: 1, supersedes: null, trigger: "on_demand", createdAt: new Date().toISOString() }, { cyclonedxVersions: ["1.7"] });
    expect(built.gaps.filter((g) => g.ref === `service:mcp:${stdioId}` && g.field === "isolation")).toEqual([]);
  });
});
