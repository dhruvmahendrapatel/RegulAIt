/**
 * ADR-0363 slice 2 — customer-defined classifiers at the gateway.
 *
 *   - `loadPublishedClassifiers` gives `resolveGuardrailPolicy` the compiled published set, so every guardrail site
 *     (model dispatch, MCP, connector, A2A, copilot) runs them through `evaluateGuardrails`: no second pipeline. The
 *     compiled set is cached in-process keyed by the exact list of published version ids, which is read on every call
 *     (one indexed read), so a publish or retire takes effect on the next call on every replica. The cache holds org
 *     configuration only; it never crosses a user or an authorisation decision.
 *   - EDM values are normalised and HMAC-SHA256'd under a random deployment key (enveloped under the data key, the
 *     discovery pseudonym-key pattern) on the write request. Only digests are stored; plaintext is never stored,
 *     logged, audited or returned. Without the data key an EDM classifier fails closed (`unavailable` is a hit).
 *   - A version takes effect only when a named reviewer approves it in the one approvals queue
 *     (`objectType: custom_classifier`, the ADR-0208 pattern): the author never approves their own version, and the
 *     publish happens inside the decision's transaction. Retiring a published classifier removes a control, so it is
 *     a `settings_relax` step-up. Every step is audited. Transitions follow `CLASSIFIER_VERSION_TRANSITIONS`.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  approvals,
  asc,
  auditLog,
  customClassifierEdmDigests,
  customClassifierHashKey,
  customClassifiers,
  customClassifierVersions,
  desc,
  eq,
  inArray,
  sql,
  users,
  type CustomClassifierVersionRow,
  type Db,
} from "@regulait/db";
import {
  CLASSIFIER_KEY_RE,
  CLASSIFIER_MODES,
  classifierDefinitionProblem,
  classifierDefinitionSchema,
  classifierTransitionProblem,
  compileClassifier,
  edmNormalise,
  edmValuesSchema,
  type ClassifierDefinition,
  type ClassifierVersionStatus,
  type CompiledClassifier,
  type GuardrailPhase,
} from "@regulait/shared";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { requireRelaxStepUp } from "./step-up.js";

export const CUSTOM_CLASSIFIER_APPROVAL_TYPE = "custom_classifier" as const;
export const CUSTOM_CLASSIFIER_STAGE_PREFIX = "custom-classifier-version:";

// ---------------------------------------------------------------------------------------------------------------
// The deployment key (registered once by buildApp) and the EDM HMAC
// ---------------------------------------------------------------------------------------------------------------

let deploymentDataKey: string | undefined;
/** buildApp registers the data key once, so the loader can open the EDM key wherever a guardrail policy resolves */
export function registerClassifierDataKey(dataKey: string | undefined): void {
  deploymentDataKey = dataKey;
}

/** the random EDM key, created on first use (one row, enveloped under the data key) */
async function edmKey(db: Db, dataKey: string): Promise<Buffer> {
  const read = async () => (await db.select().from(customClassifierHashKey).where(eq(customClassifierHashKey.id, true)))[0];
  let row = await read();
  if (!row) {
    await db
      .insert(customClassifierHashKey)
      .values({ id: true, keyCiphertext: encryptSecret(dataKey, randomBytes(32).toString("hex")) })
      .onConflictDoNothing();
    row = await read();
  }
  if (!row) throw new Error("the classifier key could not be created");
  return Buffer.from(decryptSecret(dataKey, row.keyCiphertext), "hex");
}

const hmacWith = (key: Buffer) => (normalised: string) => createHmac("sha256", key).update(normalised, "utf8").digest("hex");

// ---------------------------------------------------------------------------------------------------------------
// The loader the guardrail policy calls
// ---------------------------------------------------------------------------------------------------------------

let cache: { fingerprint: string; compiled: CompiledClassifier[] } | null = null;

const phasesOf = (v: Pick<CustomClassifierVersionRow, "scanInput" | "scanOutput">): GuardrailPhase[] => [
  ...(v.scanInput ? (["input"] as const) : []),
  ...(v.scanOutput ? (["output"] as const) : []),
];

/** the compiled published classifiers; [] when there are none (one indexed read) */
export async function loadPublishedClassifiers(db: Db): Promise<readonly CompiledClassifier[]> {
  const live = await db
    .select({ id: customClassifierVersions.id })
    .from(customClassifierVersions)
    .where(eq(customClassifierVersions.status, "published"))
    .orderBy(asc(customClassifierVersions.id));
  if (live.length === 0) return [];
  const fingerprint = `${deploymentDataKey ? "k" : "-"}:${live.map((r) => r.id).join(",")}`;
  if (cache?.fingerprint === fingerprint) return cache.compiled;

  const rows = await db
    .select({ v: customClassifierVersions, key: customClassifiers.key })
    .from(customClassifierVersions)
    .innerJoin(customClassifiers, eq(customClassifiers.id, customClassifierVersions.classifierId))
    .where(inArray(customClassifierVersions.id, live.map((r) => r.id)));
  const edmIds = rows.filter((r) => r.v.kind === "exact_data_match").map((r) => r.v.id);
  const digests = new Map<string, string[]>();
  if (edmIds.length) {
    for (const d of await db.select().from(customClassifierEdmDigests).where(inArray(customClassifierEdmDigests.versionId, edmIds))) {
      digests.set(d.versionId, [...(digests.get(d.versionId) ?? []), d.digest]);
    }
  }
  let hash: ((s: string) => string) | null = null;
  if (edmIds.length && deploymentDataKey) {
    try {
      hash = hmacWith(await edmKey(db, deploymentDataKey));
    } catch {
      hash = null; // fails closed: every EDM scan reports `unavailable`
    }
  }
  const compiled = rows
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((r) => {
      const parsed = classifierDefinitionSchema.safeParse(r.v.definition);
      // a stored definition that no longer parses cannot be run: report it unavailable (fail closed), never skip it
      const definition: ClassifierDefinition = parsed.success ? parsed.data : { kind: "regex", pattern: "(", caseInsensitive: false };
      return compileClassifier(
        { key: r.key, version: r.v.version, mode: r.v.mode, phases: phasesOf(r.v), definition, digests: digests.get(r.v.id) ?? [] },
        hash,
      );
    });
  cache = { fingerprint, compiled };
  return compiled;
}

// ---------------------------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------------------------

const versionBody = z
  .object({
    mode: z.enum(CLASSIFIER_MODES),
    scanInput: z.boolean().default(true),
    scanOutput: z.boolean().default(true),
    definition: classifierDefinitionSchema,
    /** EDM only: the plaintext values, hashed on this request and never stored */
    values: edmValuesSchema.optional(),
  })
  .strict();
const createBody = z
  .object({ key: z.string().regex(CLASSIFIER_KEY_RE), name: z.string().trim().min(1).max(120), version: versionBody })
  .strict();
const submitBody = z.object({ reviewerUserId: z.string().uuid(), reason: z.string().trim().min(1).max(500).optional() }).strict();
const retireBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const testBody = z
  .object({ definition: classifierDefinitionSchema, values: edmValuesSchema.optional(), text: z.string().max(200_000) })
  .strict();
const idParam = z.object({ id: z.string().uuid() });
const versionParam = z.object({ id: z.string().uuid(), version: z.coerce.number().int().min(1) });

type VersionInput = z.infer<typeof versionBody>;

/** a reason the version cannot be saved, or null */
function versionProblem(v: VersionInput): string | null {
  if (!v.scanInput && !v.scanOutput) return "a classifier scans the input, the output or both";
  const def = classifierDefinitionProblem(v.definition);
  if (def) return def;
  if (v.definition.kind === "exact_data_match" && !v.values?.length) return "an exact-data-match version needs its values";
  if (v.definition.kind !== "exact_data_match" && v.values) return "only an exact-data-match version takes values";
  return null;
}

/** the digests of an EDM version's values (normalised, de-duplicated; empty values skipped) */
function edmDigests(values: readonly string[], def: Extract<ClassifierDefinition, { kind: "exact_data_match" }>, hash: (s: string) => string): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const n = edmNormalise(v, def.normalisation);
    if (n) out.add(hash(n));
  }
  return [...out];
}

async function insertVersion(tx: Db, classifierId: string, version: number, v: VersionInput, author: string | null, dataKey: string | undefined) {
  const [row] = await tx
    .insert(customClassifierVersions)
    .values({
      classifierId,
      version,
      kind: v.definition.kind,
      mode: v.mode,
      scanInput: v.scanInput,
      scanOutput: v.scanOutput,
      definition: v.definition as unknown as Record<string, unknown>,
      authorUserId: author,
    })
    .returning();
  let digestCount = 0;
  if (v.definition.kind === "exact_data_match") {
    if (!dataKey) throw new ClassifierWriteError(503, "data_key_unavailable", "the data key is not configured, so exact-data-match values cannot be hashed");
    const digests = edmDigests(v.values ?? [], v.definition, hmacWith(await edmKey(tx, dataKey)));
    for (let i = 0; i < digests.length; i += 1000) {
      await tx.insert(customClassifierEdmDigests).values(digests.slice(i, i + 1000).map((digest) => ({ versionId: row!.id, digest })));
    }
    digestCount = digests.length;
  }
  return { row: row!, digestCount };
}

class ClassifierWriteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}

/** move one version along the declared machine, refusing anything the table does not allow */
async function transition(tx: Db, v: CustomClassifierVersionRow, to: ClassifierVersionStatus, extra: Partial<CustomClassifierVersionRow> = {}) {
  const problem = classifierTransitionProblem(v.status, to);
  if (problem) throw new ClassifierWriteError(409, "classifier_transition_refused", problem);
  await tx
    .update(customClassifierVersions)
    .set({ status: to, statusChangedAt: sql`now()`, ...extra })
    .where(and(eq(customClassifierVersions.id, v.id), eq(customClassifierVersions.status, v.status)));
}

/** the version list an admin sees (no digests, only their count) */
async function listView(db: Db, ids?: string[]) {
  const classifiers = await (ids
    ? db.select().from(customClassifiers).where(inArray(customClassifiers.id, ids))
    : db.select().from(customClassifiers).orderBy(asc(customClassifiers.key)));
  if (classifiers.length === 0) return [];
  const versions = await db
    .select()
    .from(customClassifierVersions)
    .where(inArray(customClassifierVersions.classifierId, classifiers.map((c) => c.id)))
    .orderBy(desc(customClassifierVersions.version));
  const counts = new Map<string, number>();
  const edm = versions.filter((v) => v.kind === "exact_data_match").map((v) => v.id);
  if (edm.length) {
    const rows = await db
      .select({ versionId: customClassifierEdmDigests.versionId, n: sql<number>`count(*)::int` })
      .from(customClassifierEdmDigests)
      .where(inArray(customClassifierEdmDigests.versionId, edm))
      .groupBy(customClassifierEdmDigests.versionId);
    for (const r of rows) counts.set(r.versionId, r.n);
  }
  return classifiers.map((c) => ({
    id: c.id,
    key: c.key,
    name: c.name,
    createdAt: c.createdAt.toISOString(),
    versions: versions
      .filter((v) => v.classifierId === c.id)
      .map((v) => ({
        version: v.version,
        status: v.status,
        kind: v.kind,
        mode: v.mode,
        scanInput: v.scanInput,
        scanOutput: v.scanOutput,
        definition: v.definition,
        ...(v.kind === "exact_data_match" ? { valueCount: counts.get(v.id) ?? 0 } : {}),
        approvalId: v.approvalId,
        authorUserId: v.authorUserId,
        createdAt: v.createdAt.toISOString(),
        statusChangedAt: v.statusChangedAt.toISOString(),
      })),
  }));
}

const actorOf = (req: FastifyRequest) => req.authCtx.userId ?? null;
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/** the audit row of a classifier step: ids, version, kind, mode, counts; never a value, term or pattern */
function audit(tx: Db, userId: string | null, classifierId: string, ruleId: string, effect: "allow" | "deny" | "require_approval", reason: string, detail: Record<string, unknown>) {
  return tx.insert(auditLog).values({
    userId: userId ?? NO_IDENTITY,
    objectType: "custom_classifier",
    objectId: classifierId,
    detail: { classifierId, ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

export const CUSTOM_CLASSIFIERS_PATH = "/v1/classifiers";

/** Admin-only (none is in NON_ADMIN_ROUTES). The UI is a #453 gap. */
export function registerCustomClassifierRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  const fail = (reply: import("fastify").FastifyReply, err: unknown) => {
    if (err instanceof ClassifierWriteError) return reply.status(err.status).send({ error: err.code, detail: err.detail });
    throw err;
  };

  app.get(CUSTOM_CLASSIFIERS_PATH, async () => ({ classifiers: await listView(db) }));

  app.post(CUSTOM_CLASSIFIERS_PATH, async (req, reply) => {
    const body = createBody.parse(req.body ?? {});
    const problem = versionProblem(body.version);
    if (problem) return reply.status(422).send({ error: "invalid_classifier", detail: problem });
    const actor = actorOf(req);
    try {
      const out = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [c] = await t.insert(customClassifiers).values({ key: body.key, name: body.name, createdBy: actor }).onConflictDoNothing().returning();
        if (!c) throw new ClassifierWriteError(409, "classifier_key_taken", `a classifier with key '${body.key}' exists`);
        const v = await insertVersion(t, c.id, 1, body.version, actor, opts.dataKey);
        await audit(t, actor, c.id, "custom-classifier-drafted", "allow", `classifier '${body.key}' version 1 drafted (${body.version.definition.kind}, ${body.version.mode})`, {
          key: body.key,
          version: 1,
          kind: body.version.definition.kind,
          mode: body.version.mode,
          ...(v.digestCount ? { valueCount: v.digestCount } : {}),
        });
        return c.id;
      });
      return reply.status(201).send((await listView(db, [out]))[0]);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${CUSTOM_CLASSIFIERS_PATH}/:id/versions`, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = versionBody.parse(req.body ?? {});
    const problem = versionProblem(body);
    if (problem) return reply.status(422).send({ error: "invalid_classifier", detail: problem });
    const actor = actorOf(req);
    try {
      const version = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [c] = await t.select().from(customClassifiers).where(eq(customClassifiers.id, id)).for("update");
        if (!c) throw new ClassifierWriteError(404, "classifier_not_found", "no such classifier");
        const [last] = await t.select().from(customClassifierVersions).where(eq(customClassifierVersions.classifierId, id)).orderBy(desc(customClassifierVersions.version)).limit(1);
        const next = (last?.version ?? 0) + 1;
        const v = await insertVersion(t, id, next, body, actor, opts.dataKey);
        await audit(t, actor, id, "custom-classifier-drafted", "allow", `classifier '${c.key}' version ${next} drafted (${body.definition.kind}, ${body.mode})`, {
          key: c.key,
          version: next,
          kind: body.definition.kind,
          mode: body.mode,
          ...(v.digestCount ? { valueCount: v.digestCount } : {}),
        });
        return next;
      });
      return reply.status(201).send({ ...(await listView(db, [id]))[0], drafted: version });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${CUSTOM_CLASSIFIERS_PATH}/:id/versions/:version/submit`, async (req, reply) => {
    const { id, version } = versionParam.parse(req.params);
    const body = submitBody.parse(req.body ?? {});
    const actor = actorOf(req);
    if (actor !== null && body.reviewerUserId === actor) {
      return reply.status(422).send({ error: "reviewer_is_author", detail: "a classifier version is reviewed by someone other than its author" });
    }
    const [reviewer] = await db.select({ isAdmin: users.isAdmin, disabledAt: users.disabledAt }).from(users).where(eq(users.id, body.reviewerUserId));
    if (!reviewer || reviewer.disabledAt !== null || !reviewer.isAdmin) {
      return reply.status(422).send({ error: "reviewer_not_eligible", detail: "the reviewer must be an active administrator" });
    }
    try {
      const approvalId = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [c] = await t.select().from(customClassifiers).where(eq(customClassifiers.id, id)).for("update");
        if (!c) throw new ClassifierWriteError(404, "classifier_not_found", "no such classifier");
        const all = await t.select().from(customClassifierVersions).where(eq(customClassifierVersions.classifierId, id));
        const v = all.find((x) => x.version === version);
        if (!v) throw new ClassifierWriteError(404, "classifier_version_not_found", "no such version");
        const pending = all.find((x) => x.status === "pending_approval");
        if (pending) throw new ClassifierWriteError(409, "classifier_version_pending", `version ${pending.version} is waiting for review; decide it first`);
        if (v.authorUserId !== null && v.authorUserId === body.reviewerUserId) {
          throw new ClassifierWriteError(422, "reviewer_is_author", "the reviewer drafted this version");
        }
        const [approval] = await t
          .insert(approvals)
          .values({
            userId: actor ?? body.reviewerUserId,
            objectType: CUSTOM_CLASSIFIER_APPROVAL_TYPE,
            stageId: `${CUSTOM_CLASSIFIER_STAGE_PREFIX}${v.id}`,
            approverUserId: body.reviewerUserId,
          })
          .returning({ id: approvals.id });
        await transition(t, v, "pending_approval", { approvalId: approval!.id });
        await audit(t, actor, id, "custom-classifier-submitted", "require_approval", body.reason ?? `classifier '${c.key}' version ${version} submitted for review`, {
          key: c.key,
          version,
          approvalId: approval!.id,
          reviewerUserId: body.reviewerUserId,
        });
        return approval!.id;
      });
      return reply.status(202).send({ pending: true, approvalId });
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post(`${CUSTOM_CLASSIFIERS_PATH}/:id/retire`, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = retireBody.parse(req.body ?? {});
    const [published] = await db
      .select()
      .from(customClassifierVersions)
      .where(and(eq(customClassifierVersions.classifierId, id), eq(customClassifierVersions.status, "published")));
    if (!published) return reply.status(409).send({ error: "classifier_not_published", detail: "only a published classifier can be retired" });
    // retiring removes a control: a relaxation, bound to the classifier and version
    if (!(await requireRelaxStepUp(db, req, reply, { [`customClassifier.${id}`]: `retire v${published.version}` }))) return reply;
    try {
      await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        await transition(t, published, "retired");
        await audit(t, actorOf(req), id, "custom-classifier-retired", "allow", body.reason, { version: published.version });
      });
      return reply.status(200).send((await listView(db, [id]))[0]);
    } catch (err) {
      return fail(reply, err);
    }
  });

  /** a dry run of an unsaved definition against sample text: counts only, nothing stored, values hashed in memory */
  app.post(`${CUSTOM_CLASSIFIERS_PATH}/test`, async (req, reply) => {
    const body = testBody.parse(req.body ?? {});
    const def = classifierDefinitionProblem(body.definition);
    if (def) return reply.status(422).send({ error: "invalid_classifier", detail: def });
    const key = randomBytes(32);
    const hash = hmacWith(key);
    const digests = body.definition.kind === "exact_data_match" ? edmDigests(body.values ?? [], body.definition, hash) : [];
    const c = compileClassifier({ key: "test", version: 0, mode: "log", phases: ["input"], definition: body.definition, digests }, hash);
    return { count: c.count(body.text) };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The one decide path's hooks (app.ts)
// ---------------------------------------------------------------------------------------------------------------

const versionIdOf = (stageId: string | null) =>
  stageId?.startsWith(CUSTOM_CLASSIFIER_STAGE_PREFIX) ? stageId.slice(CUSTOM_CLASSIFIER_STAGE_PREFIX.length) : null;

/** separation of duties: the author of a classifier version never approves it, through delegation or admin override */
export async function precheckCustomClassifierDecision(
  db: Pick<Db, "select">,
  approval: { stageId: string | null },
  deciderUserId: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const versionId = versionIdOf(approval.stageId);
  if (!versionId) return null;
  const [v] = await db.select({ authorUserId: customClassifierVersions.authorUserId }).from(customClassifierVersions).where(eq(customClassifierVersions.id, versionId));
  if (v?.authorUserId === deciderUserId) {
    return {
      status: 403,
      body: { error: "cannot_approve_own_classifier", detail: "the decider drafted this classifier version; the named reviewer decides it" },
    };
  }
  return null;
}

/**
 * Inside the decision's transaction. Approved: the version is published and the classifier's previous published
 * version superseded; denied: rejected. A version no longer pending (retired meanwhile, decided twice) is recorded
 * stale and nothing changes. Every outcome is audited.
 */
export async function applyCustomClassifierDecision(
  tx: Db,
  approval: { id: string; stageId: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  const versionId = versionIdOf(approval.stageId);
  if (!versionId) return;
  const [v] = await tx.select().from(customClassifierVersions).where(eq(customClassifierVersions.id, versionId)).for("update");
  if (!v) return;
  const [c] = await tx.select().from(customClassifiers).where(eq(customClassifiers.id, v.classifierId));
  const base = { key: c?.key ?? null, version: v.version, approvalId: approval.id, decision };
  if (v.status !== "pending_approval") {
    await audit(tx, deciderUserId, v.classifierId, "custom-classifier-decision-stale", "deny", `version ${v.version} is ${v.status}, not pending; nothing changed`, base);
    return;
  }
  if (decision === "denied") {
    await transition(tx, v, "rejected");
    await audit(tx, deciderUserId, v.classifierId, "custom-classifier-rejected", "deny", `classifier '${c?.key}' version ${v.version} rejected`, base);
    return;
  }
  const [previous] = await tx
    .select()
    .from(customClassifierVersions)
    .where(and(eq(customClassifierVersions.classifierId, v.classifierId), eq(customClassifierVersions.status, "published")))
    .for("update");
  if (previous) await transition(tx, previous, "superseded");
  await transition(tx, v, "published");
  await audit(tx, deciderUserId, v.classifierId, "custom-classifier-published", "allow", `classifier '${c?.key}' version ${v.version} published (${v.kind}, ${v.mode})`, {
    ...base,
    kind: v.kind,
    mode: v.mode,
    supersedes: previous?.version ?? null,
  });
}
