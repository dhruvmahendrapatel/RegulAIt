/**
 * Lane L7 (P14 + P16) — model-file lineage and lineage as MRM drift.
 *
 *  1. the child's uploader records a quantization from a parent: 201, audited with both sha256s;
 *  2. refusals, each audited: a second derivation for the same child (never edited), a cycle, a parent the caller
 *     cannot see (refused exactly like a missing one), a merge with one parent, a self-parent;
 *  3. GET: parents, ancestors and children, a relative the caller cannot see only as a count; a non-uploader gets 404;
 *  4. P16: a version-changing derivation (quantize, merge, fine-tune) of a file a CERTIFIED card cites is drift —
 *     `computeCardStaleness` counts it as a configuration change; a repackaging is not.
 *
 * Rows are this file's own (prefix `l7l-`), removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  agents,
  and,
  artifactScans,
  auditLog,
  createDb,
  desc,
  eq,
  inArray,
  modelArtifacts,
  modelCardApprovals,
  modelCardEvidence,
  modelCards,
  runMigrations,
  type Db,
} from "@regulait/db";
import { buildApp } from "./app.js";
import { computeCardStaleness } from "./mrm-autofill.js";
import { MODEL_LINEAGE_RULE_IDS } from "./model-lineage-drift.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL must be set for gateway integration tests");
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/db/migrations");

const BOOT = "l7l-bootstrap-token";
const AUTH = { authorization: `Bearer ${BOOT}` };
const RUN = randomUUID().slice(0, 8);
const DAY = 86_400_000;

let db: Db;
let app: ReturnType<typeof buildApp>;
let ownerId: string;
let ownerAuth: { authorization: string };
let otherId: string;
let otherAuth: { authorization: string };
const artifactIds: string[] = [];
let agentId: string;
let cardId: string;

async function makeUser(tag: string) {
  const u = await app.inject({
    method: "POST",
    url: "/v1/users",
    headers: AUTH,
    payload: { email: `l7l-${tag}-${RUN}@example.com`, displayName: `L7 Lineage ${tag}` },
  });
  expect(u.statusCode).toBe(201);
  const k = await app.inject({ method: "POST", url: `/v1/users/${u.json().id}/keys`, headers: AUTH, payload: { name: "l7l" } });
  return { id: u.json().id as string, auth: { authorization: `Bearer ${k.json().token}` } };
}

async function artifact(name: string, uploadedByUserId: string): Promise<string> {
  const sha256 = createHash("sha256").update(`${RUN}-${name}`).digest("hex");
  const [row] = await db
    .insert(modelArtifacts)
    .values({ sha256, sizeBytes: 1024, format: "safetensors", filename: `${name}.safetensors`, storageKey: `sha256/${sha256}`, uploadedByUserId })
    .returning();
  artifactIds.push(row!.id);
  return row!.id;
}

async function record(child: string, body: Record<string, unknown>, headers = ownerAuth) {
  return app.inject({ method: "POST", url: `/v1/model-artifacts/${child}/lineage`, headers, payload: body });
}

beforeAll(async () => {
  db = createDb(DATABASE_URL);
  await runMigrations(db, migrationsFolder);
  app = buildApp(db, { bootstrapToken: BOOT });
  ({ id: ownerId, auth: ownerAuth } = await makeUser("owner"));
  ({ id: otherId, auth: otherAuth } = await makeUser("other"));
  const a = await app.inject({
    method: "POST",
    url: "/v1/agents",
    headers: AUTH,
    payload: { name: `l7l-agent-${RUN}`, provider: "mock", tier: 1, costPerMTokIn: 3, costPerMTokOut: 15, model: "mock-balanced" },
  });
  expect(a.statusCode).toBe(201);
  agentId = a.json().id;
});

afterAll(async () => {
  if (cardId) await db.delete(modelCards).where(eq(modelCards.id, cardId));
  if (artifactIds.length) {
    await db.delete(artifactScans).where(inArray(artifactScans.artifactId, artifactIds));
    await db.delete(modelArtifacts).where(inArray(modelArtifacts.id, artifactIds));
  }
  if (agentId) await db.delete(agents).where(eq(agents.id, agentId));
  await app.close();
});

describe("lane L7 — recording model-file lineage", () => {
  let base: string;
  let quant: string;

  it("the child's uploader records a quantization, audited with both sha256s", async () => {
    base = await artifact("base", ownerId);
    quant = await artifact("quant", ownerId);
    const res = await record(quant, { relation: "quantized", parentArtifactIds: [base], method: "GPTQ 4-bit" });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().parents.map((p: { id: string }) => p.id)).toEqual([base]);
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, MODEL_LINEAGE_RULE_IDS.recorded), eq(auditLog.objectId, quant)))
      .orderBy(desc(auditLog.seq))
      .limit(1);
    const d = row!.detail as Record<string, unknown>;
    expect(d.relation).toBe("quantized");
    expect(d.versionChange).toBe(true);
    expect((d.parentSha256s as string[])[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(d.childSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a second derivation for the same child is refused: lineage is never edited", async () => {
    const other = await artifact("other-parent", ownerId);
    const res = await record(quant, { relation: "repackaged", parentArtifactIds: [other] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("lineage_already_recorded");
  });

  it("a cycle is refused", async () => {
    const res = await record(base, { relation: "fine_tuned", parentArtifactIds: [quant] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("lineage_cycle");
    const [row] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.ruleId, MODEL_LINEAGE_RULE_IDS.refused), eq(auditLog.objectId, base)))
      .limit(1);
    expect(row?.effect).toBe("deny");
  });

  it("a parent the caller cannot see is refused like a missing one", async () => {
    const hidden = await artifact("hidden", otherId);
    const child = await artifact("child-of-hidden", ownerId);
    const res = await record(child, { relation: "converted", parentArtifactIds: [hidden] });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("unknown_parent_artifact");
  });

  it("shape rules: a merge needs two parents, others exactly one, and no self-parent", async () => {
    const c = await artifact("shape-child", ownerId);
    expect((await record(c, { relation: "merged", parentArtifactIds: [base] })).statusCode).toBe(400);
    expect((await record(c, { relation: "quantized", parentArtifactIds: [base, quant] })).statusCode).toBe(400);
    expect((await record(c, { relation: "quantized", parentArtifactIds: [c] })).statusCode).toBe(400);
  });

  it("GET shows parents, ancestors and children; a hidden relative is a count; a non-uploader gets 404", async () => {
    // an admin records a merge whose second parent the owner cannot see
    const hiddenParent = await artifact("hidden-parent", otherId);
    const merged = await artifact("merged", ownerId);
    const m = await record(merged, { relation: "merged", parentArtifactIds: [quant, hiddenParent] }, AUTH);
    expect(m.statusCode, m.body).toBe(201);
    const res = await app.inject({ method: "GET", url: `/v1/model-artifacts/${merged}/lineage`, headers: ownerAuth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.relation).toBe("merged");
    expect(body.parents.map((p: { id: string }) => p.id)).toEqual([quant]);
    expect(body.ancestors.map((p: { id: string }) => p.id).sort()).toEqual([base, quant].sort());
    expect(body.hiddenRelatives).toBe(1);
    expect(JSON.stringify(body)).not.toContain(hiddenParent);
    const up = await app.inject({ method: "GET", url: `/v1/model-artifacts/${quant}/lineage`, headers: ownerAuth });
    expect(up.json().children.map((c: { id: string; relation: string }) => [c.id, c.relation])).toEqual([[merged, "merged"]]);
    expect((await app.inject({ method: "GET", url: `/v1/model-artifacts/${merged}/lineage`, headers: otherAuth })).statusCode).toBe(404);
  });
});

describe("lane L7 — P16: a version-changing derivation of a cited file is MRM drift", () => {
  it("counts as a configuration change since certification; a repackaging does not", async () => {
    const cited = await artifact("cited", ownerId);
    const [scan] = await db
      .insert(artifactScans)
      .values({
        artifactId: cited,
        artifactSha256: createHash("sha256").update(`${RUN}-cited`).digest("hex"),
        format: "safetensors",
        verdict: "clean",
        scannerVersion: "l7-test",
      })
      .returning();
    const [card] = await db.insert(modelCards).values({ agentId, intendedUse: `l7l: ${RUN}` }).returning();
    cardId = card!.id;
    await db.insert(modelCardEvidence).values({ cardId, kind: "engine_scan", artifactScanId: scan!.id });
    const certifiedAt = new Date(Date.now() - DAY);
    await db.insert(modelCardApprovals).values({
      cardId,
      status: "approved",
      approverUserId: ownerId,
      decidedBy: ownerId,
      decidedAt: certifiedAt,
      validUntil: new Date(Date.now() + 90 * DAY),
    });
    const stale = async () => {
      const [c] = await db.select().from(modelCards).where(eq(modelCards.id, cardId));
      const chain = await db.select().from(modelCardApprovals).where(eq(modelCardApprovals.cardId, cardId));
      return computeCardStaleness(db, c!, chain, new Date());
    };
    const before = (await stale()).driftSinceCertification!.configChanges;

    const repack = await artifact("repack", ownerId);
    expect((await record(repack, { relation: "repackaged", parentArtifactIds: [cited] })).statusCode).toBe(201);
    expect((await stale()).driftSinceCertification!.configChanges).toBe(before);

    const q4 = await artifact("q4", ownerId);
    expect((await record(q4, { relation: "quantized", parentArtifactIds: [cited], method: "AWQ 4-bit" })).statusCode).toBe(201);
    const after = await stale();
    expect(after.driftSinceCertification!.configChanges).toBe(before + 1);
    expect(after.drifted).toBe(true);
    expect(after.summary).toMatch(/model or configuration change/);
  });
});
