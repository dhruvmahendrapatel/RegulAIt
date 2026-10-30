/**
 * ADR-0216 (P14 + P15) — MODEL-FILE SIGNATURES AND THE SUPPLY-CHAIN BLOCK, the gateway half.
 *
 *   keys        GET  /v1/model-signing-keys                         admin: the trust roots, revoked ones too
 *               POST /v1/model-signing-keys                         admin, `settings_relax` step-up (a new key widens
 *                                                                   what is trusted); audited `model-signing-key-added`
 *               POST /v1/model-signing-keys/:keyId/revoke           admin; a tightening, no step-up; audited
 *   signature   POST /v1/model-artifacts/:artifactId/signature      the uploader or an admin: a bundle verified now
 *               (and the `x-regulait-model-signature` header on the upload itself, verified in the upload's
 *               transaction); every presentation is a row and an audit entry, pass or fail
 *   relaxation  PUT    /v1/model-artifacts/:artifactId/supply-chain-relaxation   admin, `settings_relax` step-up
 *               bound to the artifact, its sha256, the conditions and the expiry; a stated reason; at most 30 days
 *               DELETE /v1/model-artifacts/:artifactId/supply-chain-relaxation   admin; a tightening, no step-up
 *
 * THE BLOCK. A model card that cites a scan of an artifact says the model is built from that file. Every artifact a
 * subject's cards cite is assessed on every dispatch (`supplyChainDispatchGate`, the first rung of the model-risk
 * gate, independent of the MRM toggle) and at sign-off: the newest signature is RE-VERIFIED against the keys in
 * force now (so revoking a key takes effect at once), and a failing condition no unexpired relaxation names refuses
 * 409 `model_supply_chain_blocked`, audited `model-supply-chain-blocked`. The first block for an artifact opens a
 * risk entry in the `supply_chain` category with an owner (the uploader, else the card's author, else the caller);
 * a partial unique index keeps it to one entry per artifact until it is closed.
 *
 * Scanning is NOT gated: the scanner must be able to read an unsigned file, which is what it is for.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  aiRisks,
  and,
  artifactScans,
  auditLog,
  desc,
  eq,
  inArray,
  isNull,
  modelArtifactSignatures,
  modelArtifactSupplyChainRelaxations,
  modelArtifacts,
  modelCardEvidence,
  modelCards,
  modelSigningKeys,
  sql,
  users,
  type Db,
  type ModelArtifactSignatureRow,
  type ModelArtifactSupplyChainRelaxationRow,
} from "@regulait/db";
import {
  MODEL_SIGNATURE_FAILURE_LABELS,
  SUPPLY_CHAIN_CONDITION_LABELS,
  SUPPLY_CHAIN_RELAXATION_MAX_DAYS,
  assessArtifactSupplyChain,
  attachModelSignatureSchema,
  createModelSigningKeySchema,
  relaxModelSupplyChainSchema,
  type ModelSignatureFailure,
  type SupplyChainAssessment,
  type SupplyChainCondition,
} from "@regulait/shared";
import { z } from "zod";
import { parseSigningKey, verifyModelSignature, type SignatureVerdict, type TrustedSigningKey } from "./model-signing.js";
import { requireStepUp } from "./step-up.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Reader = Db | Tx;
type ArtifactRow = typeof modelArtifacts.$inferSelect;
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const DAY_MS = 86_400_000;
/** `RISK_RULE_IDS.registered` in risks.ts (not imported: risks.ts sits above this module) */
const RISK_REGISTERED_RULE_ID = "risk-registered";

/** the upload header that carries a signature bundle (base64 of its JSON) */
export const MODEL_SIGNATURE_HEADER = "x-regulait-model-signature";

// ---------------------------------------------------------------------------
// Trust roots and verification
// ---------------------------------------------------------------------------

export async function loadTrustedKeys(q: Reader): Promise<{ keys: TrustedSigningKey[]; revokedHints: Set<string> }> {
  const rows = await q.select().from(modelSigningKeys);
  return {
    keys: rows.filter((r) => !r.revokedAt).map((r) => ({ id: r.id, keyHint: r.keyHint, publicKeyPem: r.publicKeyPem })),
    revokedHints: new Set(rows.filter((r) => r.revokedAt).map((r) => r.keyHint)),
  };
}

/** decode the upload header: base64 of the bundle's JSON; undefined = no header, null = unreadable */
export function decodeSignatureHeader(value: string | string[] | undefined): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || value.length > 96 * 1024) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Verify a presented bundle and record it, with its audit row, in the caller's transaction. A bundle that does not
 * verify is still recorded (status `failed`, the reason named): the artifact then fails `unsigned`.
 */
export async function recordSignatureTx(
  tx: Tx,
  artifact: ArtifactRow,
  bundle: Record<string, unknown> | null,
  phase: "upload" | "attach",
  userId: string | null,
): Promise<{ row: ModelArtifactSignatureRow; verdict: SignatureVerdict }> {
  const trusted = await loadTrustedKeys(tx);
  const verdict: SignatureVerdict = bundle ? verifyModelSignature(bundle, artifact.sha256, trusted.keys, trusted.revokedHints) : { ok: false, failure: "bundle_malformed", keyHint: null };
  const [row] = await tx
    .insert(modelArtifactSignatures)
    .values({
      artifactId: artifact.id,
      artifactSha256: artifact.sha256,
      bundle: bundle ?? {},
      status: verdict.ok ? "verified" : "failed",
      failure: verdict.ok ? null : verdict.failure,
      signingKeyId: verdict.ok ? verdict.keyId : null,
      keyHint: verdict.keyHint,
      signedName: verdict.ok ? verdict.signedName : null,
      resourceName: verdict.ok ? verdict.resourceName : null,
      phase,
      createdByUserId: userId,
    })
    .returning();
  await tx.insert(auditLog).values({
    userId: userId ?? NO_IDENTITY,
    objectType: "model_artifact",
    objectId: artifact.id,
    detail: {
      phase: "signature",
      presentedAt: phase,
      signatureId: row!.id,
      sha256: artifact.sha256,
      status: row!.status,
      failure: row!.failure,
      signingKeyId: row!.signingKeyId,
      keyHint: row!.keyHint,
      signedName: row!.signedName,
      resourceName: row!.resourceName,
    },
    effect: verdict.ok ? "allow" : "deny",
    ruleId: verdict.ok ? "model-signature-verified" : "model-signature-failed",
    ruleChain: [],
    reason: verdict.ok
      ? `model artifact ${artifact.id}: signature verified against a trusted signing key (it covers sha256 ${artifact.sha256})`
      : `model artifact ${artifact.id}: the presented signature did not verify (${verdict.failure})`,
  });
  return { row: row!, verdict };
}

// ---------------------------------------------------------------------------
// The assessment
// ---------------------------------------------------------------------------

export interface ArtifactSupplyChainState {
  assessment: SupplyChainAssessment;
  signature: {
    status: "verified" | "failed" | "none";
    /** why the signature does not count NOW (re-verified on this read); null when it does */
    failure: ModelSignatureFailure | null;
    failureLabel: string | null;
    keyName: string | null;
    signedName: string | null;
    presentedAt: "upload" | "attach" | null;
    createdAt: Date | null;
  };
  relaxation: ReturnType<typeof relaxationView> | null;
}

function relaxationView(r: ModelArtifactSupplyChainRelaxationRow, now: Date) {
  return {
    id: r.id,
    conditions: r.conditions,
    reason: r.reason,
    expiresAt: r.expiresAt,
    expired: r.expiresAt.getTime() <= now.getTime(),
    createdByUserId: r.createdByUserId,
    createdAt: r.createdAt,
  };
}

/** assess each artifact now: the newest signature re-verified against the keys in force, scans, relaxation */
export async function supplyChainStates(q: Reader, artifacts: readonly ArtifactRow[], now: Date = new Date()): Promise<Map<string, ArtifactSupplyChainState>> {
  const out = new Map<string, ArtifactSupplyChainState>();
  if (artifacts.length === 0) return out;
  const ids = artifacts.map((a) => a.id);
  const [trusted, keyRows, sigs, scans, relaxations] = await Promise.all([
    loadTrustedKeys(q),
    q.select({ id: modelSigningKeys.id, name: modelSigningKeys.name }).from(modelSigningKeys),
    q.select().from(modelArtifactSignatures).where(inArray(modelArtifactSignatures.artifactId, ids)).orderBy(desc(modelArtifactSignatures.createdAt), desc(modelArtifactSignatures.id)),
    q.select({ artifactId: artifactScans.artifactId, sha256: artifactScans.artifactSha256, verdict: artifactScans.verdict }).from(artifactScans).where(inArray(artifactScans.artifactId, ids)),
    q.select().from(modelArtifactSupplyChainRelaxations).where(and(inArray(modelArtifactSupplyChainRelaxations.artifactId, ids), isNull(modelArtifactSupplyChainRelaxations.clearedAt))),
  ]);
  const keyName = new Map(keyRows.map((k) => [k.id, k.name]));
  for (const a of artifacts) {
    const newest = sigs.find((s) => s.artifactId === a.id) ?? null;
    let failure: ModelSignatureFailure | null = null;
    let keyId: string | null = null;
    if (!newest) failure = null;
    else {
      // re-verified on every read: a revoked key, or a row written around the API, does not count
      const now = verifyModelSignature(newest.bundle, a.sha256, trusted.keys, trusted.revokedHints);
      if (now.ok) keyId = now.keyId;
      else failure = now.failure;
    }
    const verified = newest !== null && failure === null;
    // a relaxation counts only for the bytes it was decided on
    const relaxRow = relaxations.find((r) => r.artifactId === a.id && r.artifactSha256 === a.sha256) ?? null;
    const assessment = assessArtifactSupplyChain({
      format: a.format,
      signatureVerified: verified,
      scanVerdicts: scans.filter((s) => s.artifactId === a.id && s.sha256 === a.sha256).map((s) => s.verdict),
      relaxation: relaxRow ? { conditions: relaxRow.conditions, expiresAt: relaxRow.expiresAt } : null,
      now,
    });
    out.set(a.id, {
      assessment,
      signature: {
        status: !newest ? "none" : verified ? "verified" : "failed",
        failure,
        failureLabel: failure ? MODEL_SIGNATURE_FAILURE_LABELS[failure] : null,
        keyName: keyId ? (keyName.get(keyId) ?? null) : null,
        signedName: verified ? newest!.signedName : null,
        presentedAt: newest?.phase ?? null,
        createdAt: newest?.createdAt ?? null,
      },
      relaxation: relaxRow ? relaxationView(relaxRow, now) : null,
    });
  }
  return out;
}

/** the artifacts the given cards cite (through `engine_scan` evidence) */
export async function citedArtifacts(q: Reader, cardIds: readonly string[]): Promise<Array<{ cardId: string; artifact: ArtifactRow }>> {
  if (cardIds.length === 0) return [];
  const rows = await q
    .select({ cardId: modelCardEvidence.cardId, artifact: modelArtifacts })
    .from(modelCardEvidence)
    .innerJoin(artifactScans, eq(artifactScans.id, modelCardEvidence.artifactScanId))
    .innerJoin(modelArtifacts, eq(modelArtifacts.id, artifactScans.artifactId))
    .where(inArray(modelCardEvidence.cardId, [...cardIds]));
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.cardId}:${r.artifact.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface SupplyChainBlock {
  artifactId: string;
  sha256: string;
  filename: string;
  cardId: string;
  conditions: SupplyChainCondition[];
}

/** the cited artifacts that block the given cards now (empty = nothing blocks) */
export async function supplyChainBlocksForCards(q: Reader, cardIds: readonly string[], now: Date = new Date()): Promise<SupplyChainBlock[]> {
  const cited = await citedArtifacts(q, cardIds);
  if (cited.length === 0) return [];
  const unique = [...new Map(cited.map((c) => [c.artifact.id, c.artifact])).values()];
  const states = await supplyChainStates(q, unique, now);
  return cited
    .filter((c) => !states.get(c.artifact.id)!.assessment.passes)
    .map((c) => ({ artifactId: c.artifact.id, sha256: c.artifact.sha256, filename: c.artifact.filename, cardId: c.cardId, conditions: states.get(c.artifact.id)!.assessment.uncovered }));
}

function blockDetail(blocks: readonly SupplyChainBlock[]): string {
  const first = blocks[0]!;
  const what = first.conditions.map((c) => SUPPLY_CHAIN_CONDITION_LABELS[c].toLowerCase()).join("; ");
  const more = blocks.length > 1 ? ` (and ${blocks.length - 1} more)` : "";
  return (
    `this model is built from a file that fails the supply-chain check: ${first.filename} — ${what}${more}. ` +
    "Attach a valid signature or complete a scan, or an admin may relax the check for this file for a stated reason and a limited time"
  );
}

/**
 * Open the supply-chain risk entry for each blocking artifact that has none open, in the caller's transaction, each
 * with its audit row. The owner is the uploader, else the citing card's author, else the caller (when a person).
 */
export async function openSupplyChainRisksTx(tx: Tx, blocks: readonly SupplyChainBlock[], ctx: { userId: string; agentId?: string | null; projectId?: string | null }): Promise<string[]> {
  const opened: string[] = [];
  const byArtifact = new Map(blocks.map((b) => [b.artifactId, b]));
  for (const b of byArtifact.values()) {
    const [owners] = await tx
      .select({ uploader: modelArtifacts.uploadedByUserId, author: modelCards.createdByUserId })
      .from(modelArtifacts)
      .leftJoin(modelCards, eq(modelCards.id, b.cardId))
      .where(eq(modelArtifacts.id, b.artifactId));
    let owner = owners?.uploader ?? owners?.author ?? null;
    if (!owner && ctx.userId !== NO_IDENTITY) {
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.id, ctx.userId));
      owner = u?.id ?? null;
    }
    if (!owner) continue;
    const conditions = b.conditions.map((c) => SUPPLY_CHAIN_CONDITION_LABELS[c]).join("; ");
    const [row] = await tx
      .insert(aiRisks)
      .values({
        title: `Model file ${b.filename} failed the supply-chain check`.slice(0, 300),
        description: `A governed model is built from ${b.filename} (sha256 ${b.sha256}), which fails: ${conditions}. Its use is blocked until the file passes or an admin relaxes the check.`,
        category: "supply_chain",
        ownerUserId: owner,
        likelihood: "medium",
        impact: "high",
        mitigation: "Dispatch and sign-off are blocked while the file fails the check (default deny). Attach a valid signature from a trusted key, complete a scan, or replace the file with a non-executable format.",
        agentId: ctx.agentId ?? null,
        projectId: ctx.projectId ?? null,
        modelArtifactId: b.artifactId,
        status: "open",
      })
      .onConflictDoNothing()
      .returning();
    if (!row) continue;
    opened.push(row.id);
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      objectType: "ai_risk",
      objectId: row.id,
      detail: {
        phase: "registered",
        automatic: true,
        title: row.title,
        category: "supply_chain",
        likelihood: row.likelihood,
        impact: row.impact,
        ownerUserId: owner,
        modelArtifactId: b.artifactId,
        sha256: b.sha256,
        conditions: b.conditions,
        agentId: row.agentId,
        projectId: row.projectId,
      },
      effect: "allow",
      ruleId: RISK_REGISTERED_RULE_ID,
      ruleChain: [],
      reason: `supply-chain risk opened automatically: model file ${b.filename} (${b.artifactId}) blocked a model (${b.conditions.join(", ")})`,
    });
  }
  return opened;
}

/**
 * THE DISPATCH RUNG. Null = proceed. Otherwise the refusal, already audited, with the risk entries opened in the same
 * transaction as the audit row.
 */
export async function supplyChainDispatchGate(
  db: Db,
  ctx: { userId: string; agentId: string; agentName: string; customProviderId: string | null; projectId?: string | null },
  now: Date = new Date(),
): Promise<{ status: number; error: string; detail: string } | null> {
  const cards = await db
    .select({ id: modelCards.id })
    .from(modelCards)
    .where(ctx.customProviderId ? sql`${modelCards.agentId} = ${ctx.agentId} OR ${modelCards.customProviderId} = ${ctx.customProviderId}` : eq(modelCards.agentId, ctx.agentId));
  if (cards.length === 0) return null;
  const blocks = await supplyChainBlocksForCards(db, cards.map((c) => c.id), now);
  if (blocks.length === 0) return null;
  const detail = blockDetail(blocks);
  await db.transaction(async (tx) => {
    const risks = await openSupplyChainRisksTx(tx, blocks, ctx);
    await tx.insert(auditLog).values({
      userId: ctx.userId,
      objectType: "agent",
      objectId: ctx.agentId,
      detail: {
        phase: "dispatch",
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        blocks: blocks.map((b) => ({ artifactId: b.artifactId, sha256: b.sha256, cardId: b.cardId, conditions: b.conditions })),
        risksOpened: risks,
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
      },
      effect: "deny",
      ruleId: "model-supply-chain-blocked",
      ruleChain: [],
      reason: `dispatch to ${ctx.agentName} refused: ${detail}`,
    });
  });
  return { status: 409, error: "model_supply_chain_blocked", detail };
}

/** THE SIGN-OFF RUNG: the same check for one card, audited and opening risks the same way */
export async function supplyChainSignOffGate(db: Db, card: { id: string; agentId: string | null }, userId: string, now: Date = new Date()) {
  const blocks = await supplyChainBlocksForCards(db, [card.id], now);
  if (blocks.length === 0) return null;
  const detail = blockDetail(blocks);
  await db.transaction(async (tx) => {
    const risks = await openSupplyChainRisksTx(tx, blocks, { userId, agentId: card.agentId });
    await tx.insert(auditLog).values({
      userId,
      objectType: "model_card",
      objectId: card.id,
      detail: { phase: "sign_off", blocks: blocks.map((b) => ({ artifactId: b.artifactId, sha256: b.sha256, conditions: b.conditions })), risksOpened: risks },
      effect: "deny",
      ruleId: "model-supply-chain-blocked",
      ruleChain: [],
      reason: `sign-off of model card ${card.id} refused: ${detail}`,
    });
  });
  return { status: 409, error: "model_supply_chain_blocked", detail, blocks };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const keyParam = z.object({ keyId: z.string().uuid() });
const artifactParam = z.object({ artifactId: z.string().uuid() });

function keyView(k: typeof modelSigningKeys.$inferSelect) {
  return { id: k.id, name: k.name, algorithm: k.algorithm, keyHint: k.keyHint, publicKeyPem: k.publicKeyPem, createdAt: k.createdAt, revokedAt: k.revokedAt };
}

/** the step-up a relaxation needs: bound to the artifact's bytes, the conditions and the expiry */
export const supplyChainRelaxStepUp = (artifactId: string, sha256: string, conditions: readonly string[], expiresAt: string) => ({
  kind: "settings_relax" as const,
  facts: { op: "model_supply_chain_relax", artifactId, sha256, conditions: [...conditions].sort(), expiresAt },
});
/** the step-up adding a trust root needs: bound to the key */
export const signingKeyAddStepUp = (keyHint: string) => ({ kind: "settings_relax" as const, facts: { op: "model_signing_key_add", keyHint } });

export function registerModelSupplyChainRoutes(app: FastifyInstance, db: Db): void {
  const actor = (req: FastifyRequest) => req.authCtx?.userId ?? NO_IDENTITY;

  async function loadArtifact(req: FastifyRequest, reply: FastifyReply, admin: boolean): Promise<ArtifactRow | null> {
    const p = artifactParam.safeParse(req.params);
    if (!p.success) {
      await reply.status(404).send({ error: "unknown_artifact" });
      return null;
    }
    const [a] = await db.select().from(modelArtifacts).where(eq(modelArtifacts.id, p.data.artifactId));
    const caller = req.authCtx;
    const mayUse = a && (caller.isAdmin || (!admin && caller.userId !== null && a.uploadedByUserId === caller.userId));
    if (!a || !mayUse) {
      await reply.status(404).send({ error: "unknown_artifact" });
      return null;
    }
    return a;
  }

  // ---- trust roots (admin: the default gate) ----
  app.get("/v1/model-signing-keys", async () => {
    const rows = await db.select().from(modelSigningKeys).orderBy(desc(modelSigningKeys.createdAt)).limit(200);
    return { keys: rows.map(keyView), algorithms: ["ecdsa_p256_sha256"] };
  });

  app.post("/v1/model-signing-keys", async (req, reply) => {
    const b = createModelSigningKeySchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_body", issues: b.error.issues.slice(0, 10) });
    const parsed = parseSigningKey(b.data.publicKeyPem);
    if (!parsed) return reply.status(422).send({ error: "unsupported_key", detail: "paste an ECDSA P-256 public key in PEM form (the signing tool's public key)" });
    const [existing] = await db.select().from(modelSigningKeys).where(eq(modelSigningKeys.keyHint, parsed.keyHint));
    if (existing) return reply.status(409).send({ error: "key_exists", detail: existing.revokedAt ? "this key was revoked; a revoked key is never trusted again" : "this key is already a trusted signing key", key: keyView(existing) });
    const su = await requireStepUp(db, req, reply, signingKeyAddStepUp(parsed.keyHint));
    if (!su.ok) return reply;
    const row = await db.transaction(async (tx) => {
      const [k] = await tx
        .insert(modelSigningKeys)
        .values({ name: b.data.name, algorithm: "ecdsa_p256_sha256", publicKeyPem: parsed.publicKeyPem, keyHint: parsed.keyHint, createdByUserId: req.authCtx.userId ?? null })
        .onConflictDoNothing()
        .returning();
      if (!k) return null;
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "model_signing_key",
        objectId: k.id,
        detail: { name: k.name, algorithm: k.algorithm, keyHint: k.keyHint, relaxation: true, stepUp: su.method },
        effect: "allow",
        ruleId: "model-signing-key-added",
        ruleChain: [],
        reason: `model signing key '${k.name}' (${k.keyHint}) added as a trust root; signatures by it now verify (step-up ${su.method})`,
      });
      return k;
    });
    if (!row) return reply.status(409).send({ error: "key_exists", detail: "this key is already a trusted signing key" });
    return reply.status(201).send({ key: keyView(row) });
  });

  app.post("/v1/model-signing-keys/:keyId/revoke", async (req, reply) => {
    const p = keyParam.safeParse(req.params);
    if (!p.success) return reply.status(404).send({ error: "unknown_key" });
    const row = await db.transaction(async (tx) => {
      const [k] = await tx
        .update(modelSigningKeys)
        .set({ revokedAt: sql`now()`, revokedByUserId: req.authCtx.userId ?? null })
        .where(and(eq(modelSigningKeys.id, p.data.keyId), isNull(modelSigningKeys.revokedAt)))
        .returning();
      if (!k) return null;
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "model_signing_key",
        objectId: k.id,
        detail: { name: k.name, keyHint: k.keyHint, relaxation: false },
        effect: "allow",
        ruleId: "model-signing-key-revoked",
        ruleChain: [],
        reason: `model signing key '${k.name}' (${k.keyHint}) revoked; signatures by it no longer verify`,
      });
      return k;
    });
    if (!row) {
      const [k] = await db.select().from(modelSigningKeys).where(eq(modelSigningKeys.id, p.data.keyId));
      if (!k) return reply.status(404).send({ error: "unknown_key" });
      return reply.send({ key: keyView(k), changed: false });
    }
    return reply.send({ key: keyView(row), changed: true });
  });

  // ---- a signature, attached after the upload (the uploader or an admin) ----
  app.post("/v1/model-artifacts/:artifactId/signature", async (req, reply) => {
    const a = await loadArtifact(req, reply, false);
    if (!a) return reply;
    const b = attachModelSignatureSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_body", issues: b.error.issues.slice(0, 10) });
    const { row } = await db.transaction((tx) => recordSignatureTx(tx, a, b.data.bundle, "attach", req.authCtx.userId ?? null));
    const state = (await supplyChainStates(db, [a])).get(a.id)!;
    return reply.status(row.status === "verified" ? 201 : 422).send({
      signature: { id: row.id, status: row.status, failure: row.failure, failureLabel: row.failure ? MODEL_SIGNATURE_FAILURE_LABELS[row.failure as ModelSignatureFailure] : null },
      supplyChain: state,
      ...(row.status === "failed" ? { error: "signature_not_verified", detail: MODEL_SIGNATURE_FAILURE_LABELS[row.failure as ModelSignatureFailure] } : {}),
    });
  });

  // ---- the relaxation (admin, step-up, reason, expiry) ----
  app.put("/v1/model-artifacts/:artifactId/supply-chain-relaxation", async (req, reply) => {
    const a = await loadArtifact(req, reply, true);
    if (!a) return reply;
    const b = relaxModelSupplyChainSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_body", issues: b.error.issues.slice(0, 10) });
    const now = new Date();
    const max = new Date(now.getTime() + SUPPLY_CHAIN_RELAXATION_MAX_DAYS * DAY_MS);
    const expiresAt = b.data.expiresAt ? new Date(b.data.expiresAt) : max;
    if (expiresAt.getTime() <= now.getTime() + 60_000 || expiresAt.getTime() > max.getTime()) {
      return reply.status(422).send({ error: "invalid_expiry", detail: `a relaxation ends in the future and at most ${SUPPLY_CHAIN_RELAXATION_MAX_DAYS} days from now` });
    }
    const conditions = [...new Set(b.data.conditions)].sort();
    const su = await requireStepUp(db, req, reply, supplyChainRelaxStepUp(a.id, a.sha256, conditions, expiresAt.toISOString()));
    if (!su.ok) return reply;
    const row = await db.transaction(async (tx) => {
      // the artifact's bytes are what the step-up was decided on
      const [still] = await tx.select({ sha256: modelArtifacts.sha256 }).from(modelArtifacts).where(eq(modelArtifacts.id, a.id)).for("update");
      if (!still || still.sha256 !== a.sha256) return null;
      const replaced = await tx
        .update(modelArtifactSupplyChainRelaxations)
        .set({ clearedAt: sql`now()`, clearedByUserId: req.authCtx.userId ?? null })
        .where(and(eq(modelArtifactSupplyChainRelaxations.artifactId, a.id), isNull(modelArtifactSupplyChainRelaxations.clearedAt)))
        .returning({ id: modelArtifactSupplyChainRelaxations.id });
      // the expiry check is the database's: `created_at` is its clock, so the bound is measured there
      const [r] = await tx
        .insert(modelArtifactSupplyChainRelaxations)
        .values({ artifactId: a.id, artifactSha256: a.sha256, conditions, reason: b.data.reason, expiresAt: sql`LEAST(${expiresAt.toISOString()}::timestamptz, now() + make_interval(days => ${SUPPLY_CHAIN_RELAXATION_MAX_DAYS}))`, createdByUserId: req.authCtx.userId ?? null })
        .returning();
      await tx.insert(auditLog).values({
        userId: actor(req),
        objectType: "model_artifact",
        objectId: a.id,
        detail: {
          phase: "supply_chain_relaxed",
          relaxationId: r!.id,
          sha256: a.sha256,
          conditions,
          reason: b.data.reason,
          expiresAt: r!.expiresAt.toISOString(),
          replaced: replaced.map((x) => x.id),
          relaxation: true,
          stepUp: su.method,
        },
        effect: "allow",
        ruleId: "model-supply-chain-relaxed",
        ruleChain: [],
        reason: `supply-chain check relaxed for model artifact ${a.id} (${conditions.join(", ")}) until ${r!.expiresAt.toISOString()}: ${b.data.reason} (step-up ${su.method})`,
      });
      return r!;
    });
    if (!row) return reply.status(409).send({ error: "changed_concurrently", detail: "this artifact changed while your request was being checked, so nothing was written" });
    const state = (await supplyChainStates(db, [a])).get(a.id)!;
    return reply.send({ relaxation: relaxationView(row, new Date()), supplyChain: state });
  });

  app.delete("/v1/model-artifacts/:artifactId/supply-chain-relaxation", async (req, reply) => {
    const a = await loadArtifact(req, reply, true);
    if (!a) return reply;
    const cleared = await db.transaction(async (tx) => {
      const rows = await tx
        .update(modelArtifactSupplyChainRelaxations)
        .set({ clearedAt: sql`now()`, clearedByUserId: req.authCtx.userId ?? null })
        .where(and(eq(modelArtifactSupplyChainRelaxations.artifactId, a.id), isNull(modelArtifactSupplyChainRelaxations.clearedAt)))
        .returning();
      for (const r of rows) {
        await tx.insert(auditLog).values({
          userId: actor(req),
          objectType: "model_artifact",
          objectId: a.id,
          detail: { phase: "supply_chain_relaxation_cleared", relaxationId: r.id, conditions: r.conditions, relaxation: false },
          effect: "allow",
          ruleId: "model-supply-chain-relaxation-cleared",
          ruleChain: [],
          reason: `supply-chain relaxation cleared for model artifact ${a.id}; the check applies in full`,
        });
      }
      return rows.length;
    });
    return reply.send({ cleared: cleared > 0, supplyChain: (await supplyChainStates(db, [a])).get(a.id)! });
  });
}
