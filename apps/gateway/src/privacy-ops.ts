/**
 * ADR-0224 (P13 c) — PRIVACY OPERATIONS.
 *
 * 1. RECORDS OF PROCESSING (`/v1/privacy/processing-records`). Purpose, lawful basis, data categories, retention and
 *    recipients for an AI system, linked to a project, a use case or both. Admin-only (the default gate). A write that
 *    widens what the gateway permits (a new record, an added category, a retired record brought back) needs a
 *    `settings_relax` step-up; narrowing or retiring does not. Each write is audited in its transaction.
 *
 * 2. DATA-SUBJECT REQUESTS (`/v1/privacy/requests`). Access, erasure and objection, with a due date from
 *    `org_settings.dsr_sla_days`. A request stores no personal data: only an HMAC of the normalised identifier
 *    (`subjectDigest`, keyed from the data key) and the admin's own reference. Locating the subject means typing the
 *    identifier again; it is checked against the digest, searched for in the RegulAIt-held stores, and dropped. The
 *    result is per-store counts. Erasure replaces the identifier where the store is ours to edit (conversations,
 *    shared project context), and never edits the tamper-evident audit trail: those rows stay until their retention
 *    rule prunes them, and a tombstone lists the rows the erasure covered. User accounts are reported, not deleted:
 *    deactivating a person is the existing audited user flow.
 *
 * 3. THE PROCESSING LIMIT AT DISPATCH (`privacyDispatchGate`). Behind `org_settings.privacy_ops_enabled` (shipped off).
 *    On the governed dispatch path, after the PII-mode rung: the input is scanned by the same detector, with the same
 *    jurisdiction list, the PII mode uses. Personal data whose category no active record of processing permits for
 *    the dispatch's project (records linked to the project, or to a use case linked to it) is refused 409
 *    `processing_not_permitted`, audited with categories and counts only, before any provider work. An unattributed
 *    dispatch has no record to permit it, so personal data in one is refused (default-deny). An input with no
 *    personal data is untouched. The cascade's PII mode still decides first: `block` refuses before this rung runs.
 *
 * Open source first (ADR-0176): node's HMAC and HKDF, zod, drizzle and the existing step-up and audit helpers. No
 * permissively licensed record-of-processing or DSR library fits a governance gateway's audit and enforcement model
 * (the ones found are standalone SaaS apps or form builders), so the workflow is ours; detection is the existing
 * detector. What is ours is the policy: which categories a project may process, and when a dispatch is refused.
 */
import { createHmac, hkdfSync } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aiUseCases,
  and,
  auditLog,
  conversationMessages,
  conversations,
  dataSubjectRequests,
  dataSubjectTombstones,
  desc,
  eq,
  inArray,
  or,
  processingRecords,
  projectContextItems,
  projects,
  sql,
  users,
  type DataSubjectRequestRow,
  type Db,
  type ProcessingRecordRow,
} from "@regulait/db";
import {
  categoriesNotPermitted,
  closeDsrSchema,
  createDsrSchema,
  createProcessingRecordSchema,
  detectPII,
  dsrDueAt,
  dsrIdentifierProblem,
  dsrOverdue,
  locateDsrSchema,
  normaliseDsrIdentifier,
  PROCESSING_NOT_PERMITTED,
  processingRecordWidens,
  processingRefusalDetail,
  updateProcessingRecordSchema,
  type DsrIdentifierKind,
  type DsrKind,
  type DsrStatus,
  type DsrStore,
  type DsrStoreFinding,
  type DsrView,
  type LawfulBasis,
  type PiiHit,
  type PrivacyDataCategory,
  type ProcessingRecordStatus,
  type ProcessingRecordView,
} from "@regulait/shared";
import { loadOrgSettings, piiInternationalCategories, retentionFloorDays } from "./org-settings.js";
import { checkStepUp } from "./step-up.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";
const idParam = z.object({ id: z.string().uuid() });
/** the most audit row ids one tombstone lists; the count is always exact */
const TOMBSTONE_MAX_IDS = 5_000;
/** the marker an erased identifier is replaced with */
export const ERASED_MARKER = "[erased]";

export const PRIVACY_RULE_IDS = {
  recordCreated: "processing-record-created",
  recordUpdated: "processing-record-updated",
  requestCreated: "data-subject-request-created",
  requestLocated: "data-subject-request-located",
  requestClosed: "data-subject-request-closed",
  requestErased: "data-subject-request-erased",
  dispatchRefused: "processing-not-permitted",
} as const;

// ---------------------------------------------------------------------------
// The subject digest
// ---------------------------------------------------------------------------

/** HMAC key for subject digests, derived from the data key so it is never stored and never shared with another use */
function subjectKey(dataKeyHex: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(dataKeyHex, "hex"), Buffer.alloc(0), "regulait/privacy-subject-digest/v1", 32));
}

export function subjectDigest(dataKeyHex: string, kind: DsrIdentifierKind, identifier: string): string {
  return createHmac("sha256", subjectKey(dataKeyHex)).update(`${kind}\u0000${normaliseDsrIdentifier(kind, identifier)}`).digest("hex");
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function recordView(row: ProcessingRecordRow, names: { project: Map<string, string>; useCase: Map<string, string> }): ProcessingRecordView {
  return {
    id: row.id,
    name: row.name,
    purpose: row.purpose,
    lawfulBasis: row.lawfulBasis as LawfulBasis,
    dataCategories: row.dataCategories as PrivacyDataCategory[],
    retentionDays: row.retentionDays,
    recipients: row.recipients,
    projectId: row.projectId,
    projectName: row.projectId ? (names.project.get(row.projectId) ?? null) : null,
    useCaseId: row.useCaseId,
    useCaseName: row.useCaseId ? (names.useCase.get(row.useCaseId) ?? null) : null,
    status: row.status as ProcessingRecordStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function linkNames(db: Db, rows: ProcessingRecordRow[]) {
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is string => Boolean(x)))];
  const useCaseIds = [...new Set(rows.map((r) => r.useCaseId).filter((x): x is string => Boolean(x)))];
  const [ps, us] = await Promise.all([
    projectIds.length ? db.select({ id: projects.id, name: projects.name }).from(projects).where(inArray(projects.id, projectIds)) : [],
    useCaseIds.length ? db.select({ id: aiUseCases.id, name: aiUseCases.name }).from(aiUseCases).where(inArray(aiUseCases.id, useCaseIds)) : [],
  ]);
  return { project: new Map(ps.map((p) => [p.id, p.name])), useCase: new Map(us.map((u) => [u.id, u.name])) };
}

function requestView(row: DataSubjectRequestRow, now = new Date()): DsrView {
  return {
    id: row.id,
    kind: row.kind as DsrKind,
    identifierKind: row.identifierKind as DsrIdentifierKind,
    reference: row.reference,
    processingRecordId: row.processingRecordId,
    status: row.status as DsrStatus,
    receivedAt: row.receivedAt.toISOString(),
    dueAt: row.dueAt.toISOString(),
    overdue: dsrOverdue({ status: row.status as DsrStatus, dueAt: row.dueAt }, now),
    located: (row.located as DsrStoreFinding[] | null) ?? null,
    locatedAt: row.locatedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    closeNote: row.closeNote,
    createdAt: row.createdAt.toISOString(),
  };
}

/** a fixed sentence for a body that did not parse: the zod issues could echo an identifier back */
const INVALID = (expected: string) => ({ error: "invalid_request", detail: `expected ${expected}` });

// ---------------------------------------------------------------------------
// Locating a subject
// ---------------------------------------------------------------------------

/** `position(needle in haystack) > 0`, case-insensitive: a parameterised substring test with no pattern syntax */
const containsCi = (column: unknown, needle: string) => sql`position(lower(${needle}) in lower(${column})) > 0`;

/** a case-insensitive regex for `needle`, with every metacharacter escaped, for Postgres `regexp_replace` */
const literalRegex = (needle: string) => needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Located {
  findings: DsrStoreFinding[];
  auditIds: string[];
  auditCount: number;
  newestAuditAt: Date | null;
}

const STORE_NOTES: Readonly<Record<DsrStore, string>> = {
  accounts:
    "A sign-in account is not deleted by a request: deactivate the person under Users, which keeps their history and audit trail.",
  conversations: "Erasure replaces the identifier in the matching messages and conversation summaries.",
  project_context: "Erasure replaces the identifier in every revision of the matching shared context items.",
  audit_trail:
    "The audit trail is tamper-evident and is never edited. Matching rows stay until their retention rule prunes them; erasure records a tombstone listing them.",
};

async function locateSubject(db: Db, kind: DsrIdentifierKind, identifier: string): Promise<Located> {
  // the identifier as typed (trimmed) is what appears in free text; the normalised form is what an account holds
  const needle = identifier.trim();
  const normalised = normaliseDsrIdentifier(kind, identifier);
  const [accountRows, messageRows, summaryRows, contextRows, auditCountRows, auditIdRows] = await Promise.all([
    kind === "email" ? db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${normalised}`) : Promise.resolve([]),
    db.select({ n: sql<number>`count(*)::int` }).from(conversationMessages).where(containsCi(conversationMessages.content, needle)),
    db.select({ n: sql<number>`count(*)::int` }).from(conversations).where(and(sql`${conversations.summary} IS NOT NULL`, containsCi(conversations.summary, needle))),
    db.select({ n: sql<number>`count(*)::int` }).from(projectContextItems).where(containsCi(projectContextItems.content, needle)),
    db
      .select({ n: sql<number>`count(*)::int`, newest: sql<Date | null>`max(${auditLog.at})` })
      .from(auditLog)
      .where(or(containsCi(sql`${auditLog.detail}::text`, needle), containsCi(auditLog.reason, needle))),
    db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(or(containsCi(sql`${auditLog.detail}::text`, needle), containsCi(auditLog.reason, needle)))
      .orderBy(desc(auditLog.at))
      .limit(TOMBSTONE_MAX_IDS),
  ]);
  const auditCount = auditCountRows[0]?.n ?? 0;
  const newest = auditCountRows[0]?.newest ?? null;
  return {
    findings: [
      { store: "accounts", matches: accountRows.length, erasure: "retained", note: STORE_NOTES.accounts },
      { store: "conversations", matches: (messageRows[0]?.n ?? 0) + (summaryRows[0]?.n ?? 0), erasure: "erased", note: STORE_NOTES.conversations },
      { store: "project_context", matches: contextRows[0]?.n ?? 0, erasure: "erased", note: STORE_NOTES.project_context },
      { store: "audit_trail", matches: auditCount, erasure: "tombstoned", note: STORE_NOTES.audit_trail },
    ],
    auditIds: auditIdRows.map((r) => r.id),
    auditCount,
    newestAuditAt: newest ? new Date(newest) : null,
  };
}

// ---------------------------------------------------------------------------
// The processing limit at dispatch
// ---------------------------------------------------------------------------

export interface PrivacyGateContext {
  userId: string;
  agentId: string;
  agentName: string;
  projectId: string | null;
  input: string;
}

export type PrivacyGateResult = {
  kind: "refuse";
  status: 409;
  error: typeof PROCESSING_NOT_PERMITTED;
  detail: string;
  auditLogId: string | null;
} | null;

/** the categories the active records of processing for `projectId` permit, and how many records there are */
export async function permittedCategories(db: Db, projectId: string): Promise<{ categories: string[]; recordIds: string[] }> {
  const rows = await db
    .select({ id: processingRecords.id, dataCategories: processingRecords.dataCategories })
    .from(processingRecords)
    .where(
      and(
        eq(processingRecords.status, "active"),
        or(
          eq(processingRecords.projectId, projectId),
          inArray(
            processingRecords.useCaseId,
            db.select({ id: aiUseCases.id }).from(aiUseCases).where(eq(aiUseCases.projectId, projectId)),
          ),
        ),
      ),
    );
  return { categories: [...new Set(rows.flatMap((r) => r.dataCategories))], recordIds: rows.map((r) => r.id) };
}

/**
 * The rung `dispatchAttempt` gains after the PII-mode check: returns null when the dispatch may proceed, or an
 * already-audited refusal. Off (the shipped default) it is one settings read. The audit row carries categories,
 * counts and record ids only, never the input.
 */
export async function privacyDispatchGate(db: Db, ctx: PrivacyGateContext): Promise<PrivacyGateResult> {
  const org = await loadOrgSettings(db);
  if (!org.privacyOpsEnabled) return null;
  const hits: PiiHit[] = detectPII(ctx.input, await piiInternationalCategories(db));
  if (hits.length === 0) return null;
  const permitted = ctx.projectId ? await permittedCategories(db, ctx.projectId) : { categories: [], recordIds: [] };
  const refused = categoriesNotPermitted(hits.map((h) => h.category), permitted.categories);
  if (refused.length === 0) return null;
  const detail = processingRefusalDetail({
    refused,
    projectAttributed: Boolean(ctx.projectId),
    recordCount: permitted.recordIds.length,
  });
  const [row] = await db
    .insert(auditLog)
    .values({
      userId: ctx.userId,
      objectType: "agent",
      objectId: ctx.agentId,
      detail: {
        phase: "privacy",
        agentId: ctx.agentId,
        agentName: ctx.agentName,
        ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
        hits,
        refusedCategories: refused,
        permittedCategories: permitted.categories,
        processingRecordIds: permitted.recordIds,
        receiptClass: "decision",
      },
      effect: "deny",
      ruleId: PRIVACY_RULE_IDS.dispatchRefused,
      ruleChain: [],
      reason: detail,
    })
    .returning({ id: auditLog.id });
  return { kind: "refuse", status: 409, error: PROCESSING_NOT_PERMITTED, detail, auditLogId: row?.id ?? null };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const listQuery = z.object({
  status: z.enum(["active", "retired"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const requestListQuery = z.object({
  status: z.enum(["open", "closed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const recordStepUp = (op: "create" | "update", recordId: string | null, values: { dataCategories: readonly string[]; status: string; projectId: string | null; useCaseId: string | null }) => ({
  kind: "settings_relax" as const,
  facts: { op: `processing_record_${op}`, recordId, values: { processingRecord: values } },
});

async function stepUpOk(db: Db, req: FastifyRequest, reply: FastifyReply, args: ReturnType<typeof recordStepUp>): Promise<boolean> {
  const su = await checkStepUp(db, req, args);
  if (!su.ok) {
    await reply.status(su.status).send(su.body);
    return false;
  }
  return true;
}

export function registerPrivacyOpsRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  // --- records of processing --------------------------------------------------
  app.get("/v1/privacy/processing-records", async (req) => {
    const q = listQuery.parse(req.query);
    const rows = await db
      .select()
      .from(processingRecords)
      .where(q.status ? eq(processingRecords.status, q.status) : undefined)
      .orderBy(desc(processingRecords.updatedAt), desc(processingRecords.id))
      .limit(q.limit + 1)
      .offset(q.offset);
    const page = rows.slice(0, q.limit);
    const names = await linkNames(db, page);
    return { records: page.map((r) => recordView(r, names)), hasMore: rows.length > q.limit };
  });

  app.get("/v1/privacy/processing-records/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(processingRecords).where(eq(processingRecords.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_processing_record" });
    return { record: recordView(row, await linkNames(db, [row])) };
  });

  app.post("/v1/privacy/processing-records", async (req, reply) => {
    const parsed = createProcessingRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message ?? "invalid record" });
    }
    const body = parsed.data;
    const projectId = body.projectId ?? null;
    const useCaseId = body.useCaseId ?? null;
    if (projectId) {
      const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId));
      if (!p) return reply.status(404).send({ error: "unknown_project" });
    }
    if (useCaseId) {
      const [u] = await db.select({ id: aiUseCases.id }).from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
      if (!u) return reply.status(404).send({ error: "unknown_use_case" });
    }
    const dataCategories = [...new Set(body.dataCategories)].sort();
    // a new active record lets personal data through that was refused before: a relaxation
    if (!(await stepUpOk(db, req, reply, recordStepUp("create", null, { dataCategories, status: "active", projectId, useCaseId })))) return reply;
    const userId = req.authCtx.userId ?? NIL_USER;
    const row = await db.transaction(async (t) => {
      const [created] = await t
        .insert(processingRecords)
        .values({
          name: body.name,
          purpose: body.purpose,
          lawfulBasis: body.lawfulBasis,
          dataCategories,
          retentionDays: body.retentionDays,
          recipients: body.recipients,
          projectId,
          useCaseId,
          createdBy: req.authCtx.userId ?? null,
        })
        .returning();
      await t.insert(auditLog).values({
        userId,
        objectType: "processing_record",
        objectId: created!.id,
        detail: {
          phase: "privacy",
          processingRecord: "created",
          lawfulBasis: created!.lawfulBasis,
          dataCategories,
          retentionDays: created!.retentionDays,
          recipientCount: created!.recipients.length,
          projectId,
          useCaseId,
          relaxation: true,
        },
        effect: "allow",
        ruleId: PRIVACY_RULE_IDS.recordCreated,
        ruleChain: [],
        reason: `record of processing '${created!.name}' created (${created!.lawfulBasis}; ${dataCategories.join(", ")})`,
      });
      return created!;
    });
    return reply.status(201).send({ record: recordView(row, await linkNames(db, [row])) });
  });

  app.patch("/v1/privacy/processing-records/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = updateProcessingRecordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_request", detail: parsed.error.issues[0]?.message ?? "invalid change" });
    }
    const body = parsed.data;
    const [before] = await db.select().from(processingRecords).where(eq(processingRecords.id, id));
    if (!before) return reply.status(404).send({ error: "unknown_processing_record" });
    const dataCategories = body.dataCategories ? [...new Set(body.dataCategories)].sort() : before.dataCategories;
    const status = (body.status ?? before.status) as ProcessingRecordStatus;
    const widens = processingRecordWidens(
      { dataCategories: before.dataCategories, status: before.status as ProcessingRecordStatus },
      { dataCategories, status },
    );
    if (widens && !(await stepUpOk(db, req, reply, recordStepUp("update", id, { dataCategories, status, projectId: before.projectId, useCaseId: before.useCaseId })))) return reply;
    const userId = req.authCtx.userId ?? NIL_USER;
    const out = await db.transaction(async (t) => {
      // the row as read, locked: a concurrent edit cannot slip a widening past the step-up decision made above
      const [locked] = await t.select().from(processingRecords).where(eq(processingRecords.id, id)).for("update");
      if (!locked || locked.status !== before.status || JSON.stringify(locked.dataCategories) !== JSON.stringify(before.dataCategories)) {
        return null;
      }
      const [updated] = await t
        .update(processingRecords)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.purpose !== undefined ? { purpose: body.purpose } : {}),
          ...(body.lawfulBasis !== undefined ? { lawfulBasis: body.lawfulBasis } : {}),
          ...(body.retentionDays !== undefined ? { retentionDays: body.retentionDays } : {}),
          ...(body.recipients !== undefined ? { recipients: body.recipients } : {}),
          dataCategories,
          status,
          updatedAt: new Date(),
        })
        .where(eq(processingRecords.id, id))
        .returning();
      if (!updated) return null;
      await t.insert(auditLog).values({
        userId,
        objectType: "processing_record",
        objectId: id,
        detail: {
          phase: "privacy",
          processingRecord: "updated",
          changed: Object.keys(body).sort(),
          before: { dataCategories: before.dataCategories, status: before.status, lawfulBasis: before.lawfulBasis, retentionDays: before.retentionDays },
          after: { dataCategories, status, lawfulBasis: updated.lawfulBasis, retentionDays: updated.retentionDays },
          ...(widens ? { relaxation: true } : {}),
        },
        effect: "allow",
        ruleId: PRIVACY_RULE_IDS.recordUpdated,
        ruleChain: [],
        reason: `record of processing '${updated.name}' updated (${Object.keys(body).sort().join(", ")})`,
      });
      return updated;
    });
    if (!out) return reply.status(409).send({ error: "changed_concurrently", detail: "the record changed since it was read: reload it and try again" });
    return { record: recordView(out, await linkNames(db, [out])) };
  });

  // --- data-subject requests ----------------------------------------------------
  const noKey = (reply: FastifyReply) =>
    reply.status(503).send({ error: "data_key_unavailable", detail: "the data key is not configured, so a subject identifier cannot be digested" });

  app.get("/v1/privacy/requests", async (req) => {
    const q = requestListQuery.parse(req.query);
    const where =
      q.status === "open"
        ? inArray(dataSubjectRequests.status, ["received", "in_progress"])
        : q.status === "closed"
          ? inArray(dataSubjectRequests.status, ["completed", "rejected"])
          : undefined;
    const rows = await db
      .select()
      .from(dataSubjectRequests)
      .where(where)
      .orderBy(dataSubjectRequests.dueAt, dataSubjectRequests.id)
      .limit(q.limit + 1)
      .offset(q.offset);
    const now = new Date();
    return { requests: rows.slice(0, q.limit).map((r) => requestView(r, now)), hasMore: rows.length > q.limit };
  });

  app.get("/v1/privacy/requests/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_request" });
    return { request: requestView(row) };
  });

  app.post("/v1/privacy/requests", async (req, reply) => {
    const parsed = createDsrSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(INVALID("{ kind, identifierKind, identifier, reference?, processingRecordId?, receivedAt? }"));
    }
    const body = parsed.data;
    const problem = dsrIdentifierProblem(body.identifierKind, body.identifier);
    if (problem) return reply.status(400).send({ error: "invalid_identifier", detail: problem });
    if (!opts.dataKey) return noKey(reply);
    if (body.processingRecordId) {
      const [r] = await db.select({ id: processingRecords.id }).from(processingRecords).where(eq(processingRecords.id, body.processingRecordId));
      if (!r) return reply.status(404).send({ error: "unknown_processing_record" });
    }
    const org = await loadOrgSettings(db);
    const receivedAt = body.receivedAt ? new Date(body.receivedAt) : new Date();
    if (receivedAt.getTime() > Date.now() + 60_000) {
      return reply.status(400).send({ error: "invalid_request", detail: "the date received cannot be in the future" });
    }
    const dueAt = dsrDueAt(receivedAt, org.dsrSlaDays);
    const digest = subjectDigest(opts.dataKey, body.identifierKind, body.identifier);
    const userId = req.authCtx.userId ?? NIL_USER;
    const row = await db.transaction(async (t) => {
      const [created] = await t
        .insert(dataSubjectRequests)
        .values({
          kind: body.kind,
          identifierKind: body.identifierKind,
          subjectDigest: digest,
          reference: body.reference ?? null,
          processingRecordId: body.processingRecordId ?? null,
          receivedAt,
          dueAt,
          createdBy: req.authCtx.userId ?? null,
        })
        .returning();
      await t.insert(auditLog).values({
        userId,
        objectType: "data_subject_request",
        objectId: created!.id,
        // no identifier, no digest: the trail says what kind of request and when it is due
        detail: { phase: "privacy", dataSubjectRequest: "created", kind: body.kind, identifierKind: body.identifierKind, dueAt: dueAt.toISOString(), slaDays: org.dsrSlaDays },
        effect: "allow",
        ruleId: PRIVACY_RULE_IDS.requestCreated,
        ruleChain: [],
        reason: `${body.kind} request recorded, due ${dueAt.toISOString().slice(0, 10)}`,
      });
      return created!;
    });
    return reply.status(201).send({ request: requestView(row) });
  });

  /** check the typed identifier against the request; a mismatch is refused without saying anything about the subject */
  async function openRequest(req: FastifyRequest, reply: FastifyReply, identifier: string | undefined) {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select().from(dataSubjectRequests).where(eq(dataSubjectRequests.id, id));
    if (!row) {
      await reply.status(404).send({ error: "unknown_request" });
      return null;
    }
    if (row.status === "completed" || row.status === "rejected") {
      await reply.status(409).send({ error: "request_closed", detail: "this request is closed" });
      return null;
    }
    if (identifier === undefined) return { row, identifier: null };
    if (!opts.dataKey) {
      await noKey(reply);
      return null;
    }
    const kind = row.identifierKind as DsrIdentifierKind;
    if (subjectDigest(opts.dataKey, kind, identifier) !== row.subjectDigest) {
      await reply.status(409).send({ error: "identifier_mismatch", detail: "this identifier is not the one the request was recorded with" });
      return null;
    }
    return { row, identifier };
  }

  app.post("/v1/privacy/requests/:id/locate", async (req, reply) => {
    const parsed = locateDsrSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(INVALID("{ identifier }"));
    const opened = await openRequest(req, reply, parsed.data.identifier);
    if (!opened) return reply;
    const { row } = opened;
    const located = await locateSubject(db, row.identifierKind as DsrIdentifierKind, parsed.data.identifier);
    const userId = req.authCtx.userId ?? NIL_USER;
    const updated = await db.transaction(async (t) => {
      const [u] = await t
        .update(dataSubjectRequests)
        .set({ located: located.findings, locatedAt: new Date(), status: "in_progress" })
        .where(and(eq(dataSubjectRequests.id, row.id), inArray(dataSubjectRequests.status, ["received", "in_progress"])))
        .returning();
      if (!u) return null;
      await t.insert(auditLog).values({
        userId,
        objectType: "data_subject_request",
        objectId: row.id,
        detail: { phase: "privacy", dataSubjectRequest: "located", kind: row.kind, located: located.findings.map((f) => ({ store: f.store, matches: f.matches })) },
        effect: "allow",
        ruleId: PRIVACY_RULE_IDS.requestLocated,
        ruleChain: [],
        reason: `subject located: ${located.findings.map((f) => `${f.store} ${f.matches}`).join(", ")}`,
      });
      return u;
    });
    if (!updated) return reply.status(409).send({ error: "request_closed", detail: "this request is closed" });
    return { request: requestView(updated) };
  });

  const closeBody = closeDsrSchema.and(z.object({ identifier: z.string().trim().min(3).max(320).optional() }));

  app.post("/v1/privacy/requests/:id/close", async (req, reply) => {
    const parsed = closeBody.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(INVALID("{ outcome: 'completed' | 'rejected', note, identifier? }"));
    const body = parsed.data;
    const [peek] = await db
      .select({ kind: dataSubjectRequests.kind })
      .from(dataSubjectRequests)
      .where(eq(dataSubjectRequests.id, idParam.parse(req.params).id));
    const erasing = peek?.kind === "erasure" && body.outcome === "completed";
    if (erasing && !body.identifier) {
      return reply.status(400).send({ error: "identifier_required", detail: "completing an erasure needs the subject's identifier again, to find what to erase" });
    }
    const opened = await openRequest(req, reply, erasing ? body.identifier : undefined);
    if (!opened) return reply;
    const { row } = opened;
    const userId = req.authCtx.userId ?? NIL_USER;
    const located = erasing ? await locateSubject(db, row.identifierKind as DsrIdentifierKind, opened.identifier!) : null;
    const floorDays = erasing ? await retentionFloorDays(db) : null;
    const out = await db.transaction(async (t) => {
      const closedAt = new Date();
      let findings = (row.located as DsrStoreFinding[] | null) ?? null;
      if (located && opened.identifier) {
        const needle = opened.identifier.trim();
        const pattern = literalRegex(needle);
        const msgs = await t
          .update(conversationMessages)
          .set({ content: sql`regexp_replace(${conversationMessages.content}, ${pattern}, ${ERASED_MARKER}, 'gi')` })
          .where(containsCi(conversationMessages.content, needle))
          .returning({ id: conversationMessages.id });
        const sums = await t
          .update(conversations)
          .set({ summary: sql`regexp_replace(${conversations.summary}, ${pattern}, ${ERASED_MARKER}, 'gi')` })
          .where(and(sql`${conversations.summary} IS NOT NULL`, containsCi(conversations.summary, needle)))
          .returning({ id: conversations.id });
        const ctx = await t
          .update(projectContextItems)
          .set({ content: sql`regexp_replace(${projectContextItems.content}, ${pattern}, ${ERASED_MARKER}, 'gi')` })
          .where(containsCi(projectContextItems.content, needle))
          .returning({ id: projectContextItems.id });
        const retainedUntil =
          floorDays != null && located.newestAuditAt ? new Date(located.newestAuditAt.getTime() + floorDays * 86_400_000) : null;
        await t.insert(dataSubjectTombstones).values({
          requestId: row.id,
          store: "audit_trail",
          rowIds: located.auditIds,
          rowCount: located.auditCount,
          retainedUntil,
          reason:
            retainedUntil
              ? `tamper-evident audit rows are kept until their retention rule prunes them (at the earliest ${retainedUntil.toISOString().slice(0, 10)})`
              : "tamper-evident audit rows are kept: no audit retention period is set, so nothing is pruned",
        });
        findings = located.findings.map((f) =>
          f.store === "conversations"
            ? { ...f, matches: msgs.length + sums.length }
            : f.store === "project_context"
              ? { ...f, matches: ctx.length }
              : f,
        );
      }
      const [u] = await t
        .update(dataSubjectRequests)
        .set({
          status: body.outcome,
          closedAt,
          closeNote: body.note,
          ...(findings ? { located: findings } : {}),
          ...(located ? { locatedAt: closedAt } : {}),
        })
        .where(and(eq(dataSubjectRequests.id, row.id), inArray(dataSubjectRequests.status, ["received", "in_progress"])))
        .returning();
      if (!u) {
        // roll the erasure back with the close: nothing is erased for a request that was closed meanwhile
        throw new RequestClosedConcurrently();
      }
      await t.insert(auditLog).values({
        userId,
        objectType: "data_subject_request",
        objectId: row.id,
        detail: {
          phase: "privacy",
          dataSubjectRequest: erasing ? "erased" : "closed",
          kind: row.kind,
          outcome: body.outcome,
          ...(findings ? { located: findings.map((f) => ({ store: f.store, matches: f.matches, erasure: f.erasure })) } : {}),
          overdue: closedAt.getTime() > row.dueAt.getTime(),
        },
        effect: "allow",
        ruleId: erasing ? PRIVACY_RULE_IDS.requestErased : PRIVACY_RULE_IDS.requestClosed,
        ruleChain: [],
        reason: `${row.kind} request ${body.outcome}${erasing ? `: identifier erased where editable, audit trail tombstoned` : ""}`,
      });
      return u;
    }).catch((err: unknown) => {
      if (err instanceof RequestClosedConcurrently) return null;
      throw err;
    });
    if (!out) return reply.status(409).send({ error: "request_closed", detail: "this request is closed" });
    return { request: requestView(out) };
  });

  app.get("/v1/privacy/requests/:id/tombstones", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [row] = await db.select({ id: dataSubjectRequests.id }).from(dataSubjectRequests).where(eq(dataSubjectRequests.id, id));
    if (!row) return reply.status(404).send({ error: "unknown_request" });
    const rows = await db
      .select({
        store: dataSubjectTombstones.store,
        rowCount: dataSubjectTombstones.rowCount,
        retainedUntil: dataSubjectTombstones.retainedUntil,
        reason: dataSubjectTombstones.reason,
        createdAt: dataSubjectTombstones.createdAt,
      })
      .from(dataSubjectTombstones)
      .where(eq(dataSubjectTombstones.requestId, id));
    return {
      tombstones: rows.map((r) => ({
        store: r.store,
        rowCount: r.rowCount,
        retainedUntil: r.retainedUntil?.toISOString() ?? null,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });
}

class RequestClosedConcurrently extends Error {}
