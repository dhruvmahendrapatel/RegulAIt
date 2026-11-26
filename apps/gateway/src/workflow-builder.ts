/**
 * ADR-0341 — the visual pipeline builder's server side: drafts, validation, versions, diff and publish for the
 * EXISTING workflow templates (no second format). Every route is admin-gated by the default route class (none is in
 * NON_ADMIN_ROUTES), and every governance rule runs here, on validate and again on publish; the canvas only shows the
 * answers.
 *
 *   GET    /v1/workflows/builder/templates                              templates, latest version, open draft
 *   POST   /v1/workflows/builder/templates/:templateId/draft            open the draft (live, or `fromVersion`)
 *   GET    /v1/workflows/builder/templates/:templateId/draft            the draft, its validation and diff
 *   PUT    /v1/workflows/builder/templates/:templateId/draft            save {revision, definition}
 *   DELETE /v1/workflows/builder/templates/:templateId/draft            discard
 *   POST   /v1/workflows/builder/validate                               validate a definition, store nothing
 *   POST   /v1/workflows/builder/templates/:templateId/publish          {revision, acceptRelaxations?, reason?, canaryPercent?}, step-up
 *   GET    /v1/workflows/builder/templates/:templateId/versions         history, newest first
 *   GET    /v1/workflows/builder/templates/:templateId/versions/:version one version and its diff against live
 *
 * A publish writes the next append-only `workflow_template_versions` row and replaces `workflow_templates.definition`
 * in one transaction under the template's row lock. In-flight instances keep the definition they snapshotted.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  desc,
  eq,
  inArray,
  lt,
  sql,
  users,
  workflowTemplateDrafts,
  workflowTemplates,
  workflowTemplateVersionFragments,
  workflowTemplateVersions,
  type Db,
  type WorkflowTemplateDraftRow,
  type WorkflowTemplateVersionRow,
} from "@regulait/db";
import { canonicalJson, isIntakeTemplateName, jsonPatch, sha256Hex, type JsonPatchOperation } from "@regulait/shared";
import {
  CANARY_MAX_PERCENT,
  CANARY_MIN_PERCENT,
  builderRuleIssues,
  collapseCalls,
  findRelaxations,
  FRAGMENT_ID_SEPARATOR,
  stageDiff,
  workflowDefinitionSchema,
  type Relaxation,
  type StageDiff,
  type WorkflowDefinition,
} from "@regulait/workflow-kernel";
import { checkWorkflowTemplateReferences } from "./workflows.js";
import { callsOfTemplateVersion, expandDefinitionCalls } from "./workflow-fragments.js";
import { CHANGED_CONCURRENTLY, requireStepUp } from "./step-up.js";
import { CANARY_OPEN_REFUSAL, openCanary, startCanary } from "./workflow-template-versions.js";

/** ADR-0341 §4.9 */
export const BUILDER_MAX_DEFINITION_BYTES = 256 * 1024;
export const BUILDER_MAX_STAGES = 200;

/** audit rule ids, one per audited act */
export const BUILDER_RULE_IDS = {
  draftOpened: "workflow-template-draft-opened",
  draftDiscarded: "workflow-template-draft-discarded",
  baseline: "workflow-template-version-baseline",
  published: "workflow-template-published",
} as const;

/** the step-up op a publish is bound to (kind `settings_relax`, ADR-0341 §4.6) */
export const PUBLISH_STEP_UP_OP = "workflow_template_publish";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

export interface BuilderIssue {
  /** a stable code: a kernel rule (`plan_gate_missing` …), a gateway check (`unknown_review_agent` …), `schema`,
   * `unknown_field`, `too_large` or `too_many_stages` */
  code: string;
  message: string;
  /** the stage the issue is about, when one is */
  stageId: string | null;
  /** the JSON path inside the definition, when the schema reported one */
  path: Array<string | number>;
}

export type BuilderValidation =
  | {
      valid: true;
      issues: [];
      /** the definition as it goes live: every call stage expanded into the pinned sub-process version's stages */
      definition: WorkflowDefinition;
      contentHash: string;
      /** the sub-process versions the call stages pin, recorded with the published version */
      calls: Array<{ callStageId: string; fragmentVersionId: string }>;
    }
  | { valid: false; issues: BuilderIssue[] };

/** an issue on a stage a call expanded into is shown on the call stage itself */
function callStageOf(stageId: string | null, callIds: ReadonlySet<string>): string | null {
  if (!stageId) return stageId;
  const at = stageId.indexOf(FRAGMENT_ID_SEPARATOR);
  const head = at > 0 ? stageId.slice(0, at) : null;
  return head && callIds.has(head) ? head : stageId;
}

/** SHA-256 over ADR-0060's canonical JSON: what a version is identified and a publish step-up is bound by */
export function definitionContentHash(definition: unknown): string {
  return sha256Hex(canonicalJson(definition));
}

function stageIdAt(raw: unknown, path: ReadonlyArray<PropertyKey>): string | null {
  if (path[0] !== "stages" || typeof path[1] !== "number") return null;
  const stages = (raw as { stages?: unknown }).stages;
  if (!Array.isArray(stages)) return null;
  const st = stages[path[1]] as { id?: unknown } | undefined;
  return typeof st?.id === "string" ? st.id : null;
}

/**
 * Everything a publish requires, in one answer: the size bounds, the kernel schema, no field the schema would drop
 * (a stored template must be exactly what the builder showed), the builder rules (forced plan gate, governed deploy
 * tail) and the gateway's reference checks (the create path's own function).
 */
export async function validateBuilderDefinition(db: Db, draft: unknown): Promise<BuilderValidation> {
  const bytes = Buffer.byteLength(JSON.stringify(draft ?? null), "utf8");
  if (bytes > BUILDER_MAX_DEFINITION_BYTES) {
    return { valid: false, issues: [{ code: "too_large", message: `the definition is ${bytes} bytes; the most is ${BUILDER_MAX_DEFINITION_BYTES}`, stageId: null, path: [] }] };
  }
  // the sub-process catalogue: each call stage becomes the stages of the approved version it pins, and every check
  // below runs on the result, so the plan gate and the deploy tail see the pipeline that will actually run
  const expanded = await expandDefinitionCalls(db, draft);
  if (!expanded.ok) return { valid: false, issues: expanded.issues.map((i) => ({ ...i, path: [] })) };
  const raw = expanded.definition;
  const callIds = new Set(expanded.calls.map((c) => c.callStageId));
  const stagesRaw = (raw as { stages?: unknown } | null)?.stages;
  if (Array.isArray(stagesRaw) && stagesRaw.length > BUILDER_MAX_STAGES) {
    return { valid: false, issues: [{ code: "too_many_stages", message: `the definition has ${stagesRaw.length} stages; the most is ${BUILDER_MAX_STAGES}`, stageId: null, path: ["stages"] }] };
  }
  const parsed = workflowDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((i) => ({
        code: "schema",
        message: i.message,
        stageId: callStageOf(stageIdAt(raw, i.path), callIds),
        path: i.path.filter((p): p is string | number => typeof p !== "symbol"),
      })),
    };
  }
  const definition = parsed.data;
  // the schema strips unknown keys and fills defaults: a default is fine (it is shown in the diff), a dropped key is
  // a field the template would silently lose, so it is refused
  const dropped = jsonPatch(raw, definition).filter((op) => op.op === "remove");
  const issues: BuilderIssue[] = dropped.map((op) => {
    const path = op.path
      .split("/")
      .slice(1)
      .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"))
      .map((p) => (/^\d+$/.test(p) ? Number(p) : p));
    return { code: "unknown_field", message: `'${op.path}' is not a field of a workflow template`, stageId: callStageOf(stageIdAt(raw, path), callIds), path };
  });
  for (const r of builderRuleIssues(definition)) issues.push({ code: r.code, message: r.message, stageId: callStageOf(r.stageId, callIds), path: [] });
  if (issues.length === 0) {
    const refused = await checkWorkflowTemplateReferences(db, definition);
    if (refused) {
      const b = refused.body as { error?: string; detail?: string; stageId?: string };
      issues.push({ code: b.error ?? "invalid_reference", message: b.detail ?? b.error ?? "a reference in the definition does not resolve", stageId: callStageOf(b.stageId ?? null, callIds), path: [] });
    }
  }
  if (issues.length > 0) return { valid: false, issues };
  return {
    valid: true,
    issues: [],
    definition,
    contentHash: definitionContentHash(definition),
    calls: expanded.calls.map((c) => ({ callStageId: c.callStageId, fragmentVersionId: c.fragmentVersionId })),
  };
}

/** a definition as the kernel reads it, or null when it no longer parses (shown as a patch only) */
function parseOrNull(raw: unknown): WorkflowDefinition | null {
  const p = workflowDefinitionSchema.safeParse(raw);
  return p.success ? p.data : null;
}

export interface BuilderDiff {
  patch: JsonPatchOperation[];
  stages: StageDiff | null;
  relaxations: Relaxation[];
}

/** what `candidate` changes against the live definition */
export function builderDiff(live: unknown, candidate: unknown): BuilderDiff {
  const liveDef = parseOrNull(live);
  const candDef = parseOrNull(candidate);
  return {
    patch: jsonPatch(live, candidate),
    stages: liveDef && candDef ? stageDiff(liveDef, candDef) : null,
    relaxations: liveDef && candDef ? findRelaxations(liveDef, candDef) : [],
  };
}

const templateParam = z.object({ templateId: z.string().uuid() });
const versionParam = templateParam.extend({ version: z.coerce.number().int().min(1).max(1_000_000) });
const openDraftBody = z.object({ fromVersion: z.number().int().min(1).optional() }).strict();
const saveDraftBody = z.object({ revision: z.number().int().min(1), definition: z.record(z.string(), z.unknown()) }).strict();
const validateBody = z.object({ definition: z.unknown() }).strict();
const publishBody = z
  .object({
    revision: z.number().int().min(1),
    acceptRelaxations: z.boolean().optional(),
    reason: z.string().trim().min(10).max(2000).optional(),
    /** ADR-0340 slice 3: publish as a canary — this share of NEW instances gets the new version, the rest the one it
     * replaces, until the canary is promoted or rolled back */
    canaryPercent: z.number().int().min(CANARY_MIN_PERCENT).max(CANARY_MAX_PERCENT).optional(),
  })
  .strict();
const listQuery = z
  .object({
    limit: z.coerce.number().int().refine((n) => n === 10 || n === 50 || n === 100, "limit is 10, 50 or 100").default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
const versionsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.coerce.number().int().min(2).optional(),
  })
  .strict();

type TemplateRow = typeof workflowTemplates.$inferSelect;
type Refusal = { status: number; body: Record<string, unknown> };

/** the template may be edited in the builder, or the refusal to send */
function editRefusal(t: Pick<TemplateRow, "name" | "retiredAt"> | undefined): Refusal | null {
  if (!t) return { status: 404, body: { error: "unknown_template" } };
  if (t.retiredAt) return { status: 409, body: { error: "template_retired", detail: "a retired template starts no instance and is not edited" } };
  if (isIntakeTemplateName(t.name)) {
    return {
      status: 409,
      body: {
        error: "intake_template_not_editable",
        detail:
          "this template decides who signs off every new use case, so a change to it passes the decision-regression gate; " +
          "create a new variant from the Workflow templates page instead",
      },
    };
  }
  return null;
}

export async function latestVersion(db: Db, templateId: string): Promise<WorkflowTemplateVersionRow | undefined> {
  const [v] = await db
    .select()
    .from(workflowTemplateVersions)
    .where(eq(workflowTemplateVersions.templateId, templateId))
    .orderBy(desc(workflowTemplateVersions.version))
    .limit(1);
  return v;
}

/** the template's latest version; the first time, its live definition is recorded as version 1 (origin baseline).
 * Called under the template's row lock, so two first opens cannot both write version 1. */
export async function ensureBaseline(tx: Db, t: TemplateRow, actorUserId: string | null): Promise<WorkflowTemplateVersionRow> {
  const existing = await latestVersion(tx, t.id);
  if (existing) return existing;
  const [v] = await tx
    .insert(workflowTemplateVersions)
    .values({ templateId: t.id, version: 1, definition: t.definition, contentHash: definitionContentHash(t.definition), origin: "baseline" })
    .returning();
  await tx.insert(auditLog).values({
    userId: actorUserId ?? NO_IDENTITY,
    objectType: "workflow_template",
    objectId: t.id,
    detail: { phase: "version-baseline", name: t.name, version: 1, contentHash: v!.contentHash },
    effect: "allow",
    ruleId: BUILDER_RULE_IDS.baseline,
    ruleChain: [],
    reason: `workflow template '${t.name}': its live definition is recorded as version 1 before its first builder edit`,
  });
  return v!;
}

async function draftView(db: Db, t: TemplateRow, d: WorkflowTemplateDraftRow) {
  const [base] = await db.select().from(workflowTemplateVersions).where(eq(workflowTemplateVersions.id, d.baseVersionId));
  const latest = await latestVersion(db, t.id);
  const validation = await validateBuilderDefinition(db, d.definition);
  return {
    template: { id: t.id, name: t.name },
    draft: {
      id: d.id,
      revision: d.revision,
      definition: d.definition,
      baseVersion: base?.version ?? null,
      createdBy: d.createdBy,
      updatedBy: d.updatedBy,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    },
    liveVersion: latest?.version ?? null,
    /** the template was published from elsewhere since this draft was opened: a publish is refused until it is reopened */
    stale: latest ? latest.id !== d.baseVersionId : false,
    validation: validation.valid
      ? { valid: true, issues: [], contentHash: validation.contentHash }
      : { valid: false, issues: validation.issues, contentHash: null },
    diff: builderDiff(t.definition, validation.valid ? validation.definition : d.definition),
  };
}

async function loadTemplate(db: Db, templateId: string): Promise<TemplateRow | undefined> {
  const [t] = await db.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId));
  return t;
}

async function loadDraft(db: Db, templateId: string): Promise<WorkflowTemplateDraftRow | undefined> {
  const [d] = await db.select().from(workflowTemplateDrafts).where(eq(workflowTemplateDrafts.templateId, templateId));
  return d;
}

function actorOf(req: FastifyRequest): string | null {
  return req.authCtx.userId ?? null;
}

export function registerWorkflowBuilderRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/workflows/builder/templates", async (req) => {
    const q = listQuery.parse(req.query ?? {});
    const rows = await db
      .select({
        id: workflowTemplates.id,
        name: workflowTemplates.name,
        retiredAt: workflowTemplates.retiredAt,
        createdAt: workflowTemplates.createdAt,
        stageCount: sql<number>`coalesce(jsonb_array_length(${workflowTemplates.definition} -> 'stages'), 0)`.mapWith(Number),
      })
      .from(workflowTemplates)
      .orderBy(workflowTemplates.name, workflowTemplates.id)
      .limit(q.limit + 1)
      .offset(q.offset);
    const page = rows.slice(0, q.limit);
    const ids = page.map((r) => r.id);
    const versions = ids.length
      ? await db
          .select({ templateId: workflowTemplateVersions.templateId, version: sql<number>`max(${workflowTemplateVersions.version})`.mapWith(Number) })
          .from(workflowTemplateVersions)
          .where(inArray(workflowTemplateVersions.templateId, ids))
          .groupBy(workflowTemplateVersions.templateId)
      : [];
    const drafts = ids.length
      ? await db
          .select({
            templateId: workflowTemplateDrafts.templateId,
            revision: workflowTemplateDrafts.revision,
            updatedAt: workflowTemplateDrafts.updatedAt,
            updatedByName: users.displayName,
          })
          .from(workflowTemplateDrafts)
          .leftJoin(users, eq(users.id, workflowTemplateDrafts.updatedBy))
          .where(inArray(workflowTemplateDrafts.templateId, ids))
      : [];
    const vBy = new Map(versions.map((v) => [v.templateId, v.version]));
    const dBy = new Map(drafts.map((d) => [d.templateId, d]));
    return {
      items: page.map((r) => {
        const d = dBy.get(r.id);
        return {
          ...r,
          editable: editRefusal(r) === null,
          liveVersion: vBy.get(r.id) ?? null,
          draft: d ? { revision: d.revision, updatedAt: d.updatedAt, updatedByName: d.updatedByName } : null,
        };
      }),
      nextOffset: rows.length > q.limit ? q.offset + q.limit : null,
    };
  });

  app.post("/v1/workflows/builder/templates/:templateId/draft", async (req, reply) => {
    const { templateId } = templateParam.parse(req.params);
    const body = openDraftBody.parse(req.body ?? {});
    const actor = actorOf(req);
    const out = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [t] = await tx.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId)).for("update");
      const refused = editRefusal(t);
      if (refused) return { refused };
      const existing = await loadDraft(tx, templateId);
      if (existing) return { refused: { status: 409, body: { error: "draft_exists", detail: "this template already has an open draft: edit it or discard it", revision: existing.revision } } };
      const latest = await ensureBaseline(tx, t!, actor);
      let source: unknown = t!.definition;
      let sourceVersionId = latest.id;
      if (body.fromVersion !== undefined) {
        const [v] = await tx
          .select()
          .from(workflowTemplateVersions)
          .where(and(eq(workflowTemplateVersions.templateId, templateId), eq(workflowTemplateVersions.version, body.fromVersion)));
        if (!v) return { refused: { status: 404, body: { error: "unknown_version" } } };
        source = v.definition;
        sourceVersionId = v.id;
      }
      // the draft shows what the admin wrote: a sub-process the version expanded is put back as its call stage
      const calls = await callsOfTemplateVersion(tx, sourceVersionId);
      if (calls.length > 0) source = collapseCalls(source as Record<string, unknown>, calls);
      const [d] = await tx
        .insert(workflowTemplateDrafts)
        .values({ templateId, definition: source as Record<string, unknown>, baseVersionId: latest.id, createdBy: actor, updatedBy: actor })
        .returning();
      await tx.insert(auditLog).values({
        userId: actor ?? NO_IDENTITY,
        objectType: "workflow_template",
        objectId: templateId,
        detail: { phase: "draft-opened", name: t!.name, baseVersion: latest.version, ...(body.fromVersion !== undefined ? { fromVersion: body.fromVersion } : {}) },
        effect: "allow",
        ruleId: BUILDER_RULE_IDS.draftOpened,
        ruleChain: [],
        reason: `workflow template '${t!.name}': a builder draft is opened from version ${body.fromVersion ?? latest.version}`,
      });
      return { t: t!, d: d! };
    });
    if ("refused" in out && out.refused) return reply.status(out.refused.status).send(out.refused.body);
    const ok = out as { t: TemplateRow; d: WorkflowTemplateDraftRow };
    return reply.status(201).send(await draftView(db, ok.t, ok.d));
  });

  app.get("/v1/workflows/builder/templates/:templateId/draft", async (req, reply) => {
    const { templateId } = templateParam.parse(req.params);
    const t = await loadTemplate(db, templateId);
    if (!t) return reply.status(404).send({ error: "unknown_template" });
    const d = await loadDraft(db, templateId);
    if (!d) return reply.status(404).send({ error: "no_draft" });
    return draftView(db, t, d);
  });

  app.put("/v1/workflows/builder/templates/:templateId/draft", async (req, reply) => {
    const { templateId } = templateParam.parse(req.params);
    const body = saveDraftBody.parse(req.body);
    const bytes = Buffer.byteLength(JSON.stringify(body.definition), "utf8");
    if (bytes > BUILDER_MAX_DEFINITION_BYTES) {
      return reply.status(413).send({ error: "definition_too_large", detail: `the definition is ${bytes} bytes; the most is ${BUILDER_MAX_DEFINITION_BYTES}` });
    }
    const t = await loadTemplate(db, templateId);
    const refused = editRefusal(t);
    if (refused) return reply.status(refused.status).send(refused.body);
    // compare-and-set on the revision the caller edited: a concurrent save is never overwritten
    const [d] = await db
      .update(workflowTemplateDrafts)
      .set({ definition: body.definition, revision: sql`${workflowTemplateDrafts.revision} + 1`, updatedBy: actorOf(req), updatedAt: sql`now()` })
      .where(and(eq(workflowTemplateDrafts.templateId, templateId), eq(workflowTemplateDrafts.revision, body.revision)))
      .returning();
    if (!d) {
      const current = await loadDraft(db, templateId);
      if (!current) return reply.status(404).send({ error: "no_draft" });
      return reply.status(409).send({ error: "draft_revision_conflict", detail: "the draft changed since you opened it: reload it", revision: current.revision });
    }
    return draftView(db, t!, d);
  });

  app.delete("/v1/workflows/builder/templates/:templateId/draft", async (req, reply) => {
    const { templateId } = templateParam.parse(req.params);
    const t = await loadTemplate(db, templateId);
    if (!t) return reply.status(404).send({ error: "unknown_template" });
    const actor = actorOf(req);
    const gone = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      const [d] = await tx.delete(workflowTemplateDrafts).where(eq(workflowTemplateDrafts.templateId, templateId)).returning();
      if (!d) return false;
      await tx.insert(auditLog).values({
        userId: actor ?? NO_IDENTITY,
        objectType: "workflow_template",
        objectId: templateId,
        detail: { phase: "draft-discarded", name: t.name, revision: d.revision },
        effect: "allow",
        ruleId: BUILDER_RULE_IDS.draftDiscarded,
        ruleChain: [],
        reason: `workflow template '${t.name}': the builder draft is discarded`,
      });
      return true;
    });
    if (!gone) return reply.status(404).send({ error: "no_draft" });
    return reply.status(204).send();
  });

  app.post("/v1/workflows/builder/validate", async (req) => {
    const body = validateBody.parse(req.body ?? {});
    const v = await validateBuilderDefinition(db, body.definition);
    return v.valid ? { valid: true, issues: [], contentHash: v.contentHash, definition: v.definition } : { valid: false, issues: v.issues, contentHash: null };
  });

  app.post("/v1/workflows/builder/templates/:templateId/publish", async (req, reply) => publish(db, req, reply));

  app.get("/v1/workflows/builder/templates/:templateId/versions", async (req, reply) => {
    const { templateId } = templateParam.parse(req.params);
    const q = versionsQuery.parse(req.query ?? {});
    const t = await loadTemplate(db, templateId);
    if (!t) return reply.status(404).send({ error: "unknown_template" });
    const rows = await db
      .select({
        version: workflowTemplateVersions.version,
        contentHash: workflowTemplateVersions.contentHash,
        origin: workflowTemplateVersions.origin,
        publishedBy: workflowTemplateVersions.publishedBy,
        publishedByName: users.displayName,
        publishedAt: workflowTemplateVersions.publishedAt,
        stageCount: sql<number>`coalesce(jsonb_array_length(${workflowTemplateVersions.definition} -> 'stages'), 0)`.mapWith(Number),
      })
      .from(workflowTemplateVersions)
      .leftJoin(users, eq(users.id, workflowTemplateVersions.publishedBy))
      .where(and(eq(workflowTemplateVersions.templateId, templateId), q.before !== undefined ? lt(workflowTemplateVersions.version, q.before) : undefined))
      .orderBy(desc(workflowTemplateVersions.version))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const live = await latestVersion(db, templateId);
    return {
      template: { id: t.id, name: t.name },
      liveVersion: live?.version ?? null,
      items: page.map((r) => ({ ...r, live: r.version === live?.version })),
      nextBefore: rows.length > q.limit ? page[page.length - 1]!.version : null,
    };
  });

  app.get("/v1/workflows/builder/templates/:templateId/versions/:version", async (req, reply) => {
    const { templateId, version } = versionParam.parse(req.params);
    const t = await loadTemplate(db, templateId);
    if (!t) return reply.status(404).send({ error: "unknown_template" });
    const [v] = await db
      .select({ row: workflowTemplateVersions, publishedByName: users.displayName })
      .from(workflowTemplateVersions)
      .leftJoin(users, eq(users.id, workflowTemplateVersions.publishedBy))
      .where(and(eq(workflowTemplateVersions.templateId, templateId), eq(workflowTemplateVersions.version, version)));
    if (!v) return reply.status(404).send({ error: "unknown_version" });
    return {
      template: { id: t.id, name: t.name },
      version: {
        version: v.row.version,
        definition: v.row.definition,
        contentHash: v.row.contentHash,
        origin: v.row.origin,
        publishedBy: v.row.publishedBy,
        publishedByName: v.publishedByName,
        publishedAt: v.row.publishedAt,
      },
      /** what going back to this version would change against the live template */
      diff: builderDiff(t.definition, v.row.definition),
    };
  });
}

async function publish(db: Db, req: FastifyRequest, reply: FastifyReply) {
  const { templateId } = templateParam.parse(req.params);
  const body = publishBody.parse(req.body ?? {});
  const actor = actorOf(req);
  const t = await loadTemplate(db, templateId);
  const refused = editRefusal(t);
  if (refused) return reply.status(refused.status).send(refused.body);
  const d = await loadDraft(db, templateId);
  if (!d) return reply.status(404).send({ error: "no_draft" });
  // ADR-0340 slice 3: the two versions of an open canary cannot move under it
  if (await openCanary(db, templateId)) return reply.status(CANARY_OPEN_REFUSAL.status).send(CANARY_OPEN_REFUSAL.body);
  if (d.revision !== body.revision) {
    return reply.status(409).send({ error: "draft_revision_conflict", detail: "the draft changed since you reviewed it: review it again", revision: d.revision });
  }
  const latest = await latestVersion(db, templateId);
  if (!latest || latest.id !== d.baseVersionId) {
    return reply.status(409).send({
      error: "draft_stale",
      detail: "the template was published from another draft since this one was opened: discard it and open a new draft",
      liveVersion: latest?.version ?? null,
    });
  }
  const v = await validateBuilderDefinition(db, d.definition);
  if (!v.valid) return reply.status(422).send({ error: "draft_invalid", issues: v.issues });
  if (v.contentHash === latest.contentHash) return reply.status(409).send({ error: "no_change", detail: "the draft is the live definition" });
  const diff = builderDiff(t!.definition, v.definition);
  if (diff.relaxations.length > 0 && (body.acceptRelaxations !== true || !body.reason)) {
    return reply.status(409).send({
      error: "relaxation_not_accepted",
      detail: "this publish weakens the template: accept the relaxations and give a reason (at least 10 characters)",
      relaxations: diff.relaxations,
    });
  }
  // ADR-0341 §4.6: a fresh second proof bound to this template, the version it replaces and the exact bytes
  const su = await requireStepUp(db, req, reply, {
    kind: "settings_relax",
    facts: {
      op: PUBLISH_STEP_UP_OP,
      templateId,
      fromVersion: latest.version,
      contentHash: v.contentHash,
      // a canary publish is bound to its share too (only when asked, so a plain publish's proof is unchanged)
      ...(body.canaryPercent !== undefined ? { canaryPercent: body.canaryPercent } : {}),
    },
  });
  if (!su.ok) return reply;
  const out = await db.transaction(async (txRaw) => {
    const tx = txRaw as unknown as Db;
    const [locked] = await tx.select().from(workflowTemplates).where(eq(workflowTemplates.id, templateId)).for("update");
    const nowLatest = locked ? await latestVersion(tx, templateId) : undefined;
    const [nowDraft] = await tx.select().from(workflowTemplateDrafts).where(eq(workflowTemplateDrafts.templateId, templateId)).for("update");
    // fail closed: what the step-up was decided on must still be what is there (ADR-0186 A, Class A)
    if (!locked || locked.retiredAt || nowLatest?.id !== latest.id || !nowDraft || nowDraft.revision !== d.revision) return null;
    if (await openCanary(tx, templateId)) return null;
    const [version] = await tx
      .insert(workflowTemplateVersions)
      .values({ templateId, version: latest.version + 1, definition: v.definition, contentHash: v.contentHash, origin: "builder", publishedBy: actor })
      .returning();
    if (v.calls.length > 0) {
      await tx
        .insert(workflowTemplateVersionFragments)
        .values(v.calls.map((c) => ({ templateVersionId: version!.id, callStageId: c.callStageId, fragmentVersionId: c.fragmentVersionId })));
    }
    await tx.update(workflowTemplates).set({ definition: v.definition }).where(eq(workflowTemplates.id, templateId));
    await tx.delete(workflowTemplateDrafts).where(eq(workflowTemplateDrafts.id, nowDraft.id));
    const canary =
      body.canaryPercent !== undefined
        ? await startCanary(tx, { template: locked, canary: version!, stable: latest, percent: body.canaryPercent, actorUserId: actor })
        : null;
    const retried = v.definition.stages.filter((st) => st.retry);
    await tx.insert(auditLog).values({
      userId: actor ?? NO_IDENTITY,
      objectType: "workflow_template",
      objectId: templateId,
      detail: {
        phase: "published",
        name: locked.name,
        version: version!.version,
        fromVersion: latest.version,
        contentHash: v.contentHash,
        previousContentHash: latest.contentHash,
        stages: diff.stages,
        patchOps: diff.patch.length,
        relaxations: diff.relaxations,
        ...(v.calls.length > 0 ? { fragmentCalls: v.calls } : {}),
        ...(diff.relaxations.length > 0 ? { relaxationReason: body.reason } : {}),
        ...(retried.length > 0 ? { retryStages: retried.map((st) => ({ stageId: st.id, retry: st.retry })) } : {}),
        stepUp: su.method,
        stepUpKind: "settings_relax",
        ...(canary ? { canaryId: canary.id, canaryPercent: canary.percent } : {}),
      },
      effect: "allow",
      ruleId: BUILDER_RULE_IDS.published,
      ruleChain: [],
      reason:
        `workflow template '${locked.name}' version ${version!.version} published from the builder` +
        (diff.relaxations.length > 0 ? ` with ${diff.relaxations.length} accepted relaxation(s): ${body.reason}` : ""),
    });
    return { version: version!, canary };
  });
  if (!out) return reply.status(CHANGED_CONCURRENTLY.status).send(CHANGED_CONCURRENTLY.body);
  return reply.status(201).send({
    template: { id: templateId, name: t!.name },
    version: { version: out.version.version, contentHash: out.version.contentHash, origin: out.version.origin, publishedAt: out.version.publishedAt },
    ...(out.canary ? { canary: { id: out.canary.id, percent: out.canary.percent, stableVersion: latest.version } } : {}),
  });
}
