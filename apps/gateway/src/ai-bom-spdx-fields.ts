/**
 * ADR-0189 slice B9 (OWNER DECISION 13, amendment R51): the supplier-declared
 * SPDX 3.0.1 properties of models and datasets, collected so a complete record
 * renders SPDX instead of `not_producible`. Never invented: a property nobody
 * declared stays missing, and R3's fallback applies.
 *
 *   GET  /v1/ai-bom/spdx-fields/:subjectKind/:subjectId                       current values, provenance, history
 *   PUT  /v1/ai-bom/spdx-fields/:subjectKind/:subjectId/:property             declare (or correct) one value
 *   POST /v1/ai-bom/spdx-fields/:subjectKind/:subjectId/:property/withdraw    clear one value
 *
 * `subjectKind` is `model_card`, `training_dataset` or `eval_dataset`; the id is
 * that row's id (a dataset VERSION row).
 *
 * Governed like every admin write (default-deny):
 *  - ADMIN-ONLY at the route-class layer (none is in `NON_ADMIN_ROUTES`), and
 *    re-checked in the handler, so moving a route there by mistake still fails
 *    closed;
 *  - every write inserts the declaration AND its audit row in ONE transaction:
 *    no declaration exists without its audit record, and the reverse;
 *  - the value is validated by `@regulait/shared`'s `normaliseSpdxDeclaration`
 *    (the same rules the AI BOM normaliser re-applies), then by the migration's
 *    CHECKs. A refusal names the property and the rule, never the value;
 *  - the source (`supplier_declared` or `admin_entered`) is REQUIRED: there is
 *    no default, so a value never claims a provenance nobody stated;
 *  - `declared_at` is the database clock (a trigger), never the process clock.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { aiBomSpdxDeclarations, and, auditLog, desc, eq, evalDatasets, inArray, modelCards, sql, trainingDatasets, type Db } from "@regulait/db";
import {
  AI_BOM_SPDX_SOURCES,
  AI_BOM_SPDX_SUBJECT_KINDS,
  AI_BOM_SPDX_SUBJECT_PROPERTIES,
  AiBomSpdxFieldError,
  normaliseSpdxDeclaration,
  type AiBomSpdxProperty,
  type AiBomSpdxSubjectKind,
  type SpdxFieldsRecord,
} from "@regulait/shared";

type Tx = Db;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
/** a history read is bounded (a correction loop cannot make the response unbounded) */
const HISTORY_LIMIT = 200;

/** the parent column of each subject kind */
const PARENT = {
  model_card: aiBomSpdxDeclarations.modelCardId,
  training_dataset: aiBomSpdxDeclarations.trainingDatasetId,
  eval_dataset: aiBomSpdxDeclarations.evalDatasetId,
} as const;
const PARENT_FIELD = { model_card: "modelCardId", training_dataset: "trainingDatasetId", eval_dataset: "evalDatasetId" } as const;
/** the audit object type of each subject kind (the parent's own type) */
const AUDIT_OBJECT = { model_card: "model_card", training_dataset: "training_dataset", eval_dataset: "eval_dataset" } as const;

type Row = typeof aiBomSpdxDeclarations.$inferSelect;

/** a stored row's value in the shared contract's form (UTC whole-second time, origin, text, sorted list) */
function valueOf(r: Row): string | string[] | null {
  if (r.withdrawn) return null;
  if (r.valueTime) return `${r.valueTime.toISOString().slice(0, 19)}Z`;
  if (r.valueList) return [...r.valueList].sort();
  return r.valueText;
}

/**
 * The CURRENT value of every property of the given parents: the newest row
 * (`seq`) per parent and property, withdrawn ones dropped. Read inside the
 * caller's transaction (the AI BOM capture reads it from its snapshot).
 */
export async function currentSpdxDeclarations(tx: Tx, kind: AiBomSpdxSubjectKind, ids: readonly string[]): Promise<Map<string, Map<AiBomSpdxProperty, Row>>> {
  const out = new Map<string, Map<AiBomSpdxProperty, Row>>();
  if (!ids.length) return out;
  const col = PARENT[kind];
  const rows = await tx
    .selectDistinctOn([col, aiBomSpdxDeclarations.property])
    .from(aiBomSpdxDeclarations)
    .where(inArray(col, [...ids]))
    .orderBy(col, aiBomSpdxDeclarations.property, desc(aiBomSpdxDeclarations.seq));
  for (const r of rows) {
    if (r.withdrawn) continue;
    const id = r[PARENT_FIELD[kind]] as string;
    if (!out.has(id)) out.set(id, new Map());
    out.get(id)!.set(r.property as AiBomSpdxProperty, r);
  }
  return out;
}

/** the loader's `spdxFields` records for one parent kind (only parents with at least one current value) */
export async function loadSpdxFieldsRecords(tx: Tx, kind: AiBomSpdxSubjectKind, ids: readonly string[]): Promise<SpdxFieldsRecord[]> {
  const current = await currentSpdxDeclarations(tx, kind, ids);
  const out: SpdxFieldsRecord[] = [];
  for (const [subjectId, props] of current) {
    const v = (p: AiBomSpdxProperty) => {
      const r = props.get(p);
      return r ? valueOf(r) : null;
    };
    out.push({
      subjectKind: kind,
      subjectId,
      releaseTime: v("releaseTime") as string | null,
      downloadLocation: v("downloadLocation") as string | null,
      packageVersion: v("packageVersion") as string | null,
      builtTime: v("builtTime") as string | null,
      originatedBy: v("originatedBy") as string | null,
      datasetType: (v("datasetType") as string[] | null) ?? [],
    });
  }
  return out;
}

async function parentExists(tx: Tx, kind: AiBomSpdxSubjectKind, id: string): Promise<boolean> {
  const table = kind === "model_card" ? modelCards : kind === "training_dataset" ? trainingDatasets : evalDatasets;
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.id, id));
  return !!row;
}

const declareBody = z.object({ value: z.unknown(), source: z.enum(AI_BOM_SPDX_SOURCES) }).strict();
const withdrawBody = z.object({}).strict();

export const AI_BOM_SPDX_ROUTE_ERRORS = ["invalid_spdx_subject", "spdx_subject_not_found", "spdx_property_not_allowed", "invalid_spdx_declaration", "spdx_field_not_declared", "admin_only"] as const;

function subjectOf(req: FastifyRequest): { kind: AiBomSpdxSubjectKind; id: string } | null {
  const p = req.params as { subjectKind?: string; subjectId?: string };
  const id = String(p.subjectId ?? "").toLowerCase();
  if (!(AI_BOM_SPDX_SUBJECT_KINDS as readonly string[]).includes(String(p.subjectKind)) || !UUID.test(id)) return null;
  return { kind: p.subjectKind as AiBomSpdxSubjectKind, id };
}
function propertyOf(kind: AiBomSpdxSubjectKind, req: FastifyRequest): AiBomSpdxProperty | null {
  const p = String((req.params as { property?: string }).property ?? "");
  return (AI_BOM_SPDX_SUBJECT_PROPERTIES[kind] as readonly string[]).includes(p) ? (p as AiBomSpdxProperty) : null;
}
/** the stored columns of one validated value */
function columnsOf(property: AiBomSpdxProperty, value: string | string[]) {
  if (property === "releaseTime" || property === "builtTime") return { valueTime: new Date(value as string), valueText: null, valueList: null };
  if (property === "datasetType") return { valueTime: null, valueText: null, valueList: value as string[] };
  return { valueTime: null, valueText: value as string, valueList: null };
}
const view = (r: Row) => ({
  seq: r.seq,
  property: r.property,
  withdrawn: r.withdrawn,
  value: valueOf(r),
  source: r.source,
  declaredByUserId: r.declaredByUserId,
  declaredAt: r.declaredAt.toISOString(),
});

export function registerAiBomSpdxFieldRoutes(app: FastifyInstance, db: Db): void {
  /** defence in depth: the global admin gate already refused a non-admin; refuse again here */
  const notAdmin = (req: FastifyRequest, reply: FastifyReply) => (req.authCtx.isAdmin ? null : reply.status(403).send({ error: "admin_only" }));

  app.get("/v1/ai-bom/spdx-fields/:subjectKind/:subjectId", async (req, reply) => {
    if (notAdmin(req, reply)) return reply;
    const s = subjectOf(req);
    if (!s) return reply.status(400).send({ error: "invalid_spdx_subject" });
    if (!(await parentExists(db, s.kind, s.id))) return reply.status(404).send({ error: "spdx_subject_not_found" });
    const current = (await currentSpdxDeclarations(db, s.kind, [s.id])).get(s.id) ?? new Map<AiBomSpdxProperty, Row>();
    const history = await db
      .select()
      .from(aiBomSpdxDeclarations)
      .where(eq(PARENT[s.kind], s.id))
      .orderBy(desc(aiBomSpdxDeclarations.seq))
      .limit(HISTORY_LIMIT);
    const declarable = AI_BOM_SPDX_SUBJECT_PROPERTIES[s.kind];
    return {
      subject: s,
      declarable,
      current: declarable.filter((p) => current.has(p)).map((p) => view(current.get(p)!)),
      // R51: what this record still lacks; the SPDX rendering stays not_producible while a mandatory one is missing
      undeclared: declarable.filter((p) => !current.has(p)),
      history: history.map(view),
      historyLimit: HISTORY_LIMIT,
    };
  });

  app.put("/v1/ai-bom/spdx-fields/:subjectKind/:subjectId/:property", async (req, reply) => {
    if (notAdmin(req, reply)) return reply;
    const s = subjectOf(req);
    if (!s) return reply.status(400).send({ error: "invalid_spdx_subject" });
    const property = propertyOf(s.kind, req);
    if (!property) return reply.status(422).send({ error: "spdx_property_not_allowed", detail: `a ${s.kind} declares only ${AI_BOM_SPDX_SUBJECT_PROPERTIES[s.kind].join(", ")}` });
    const body = declareBody.safeParse(req.body ?? {});
    if (!body.success) return reply.status(400).send({ error: "invalid_spdx_declaration", detail: "the body is { value, source } with source supplier_declared or admin_entered" });
    let value: string | string[];
    try {
      value = normaliseSpdxDeclaration(s.kind, property, body.data.value);
    } catch (e) {
      // the property and the rule only, never the value (it may be what a caller should not have sent)
      if (e instanceof AiBomSpdxFieldError) return reply.status(422).send({ error: "invalid_spdx_declaration", rule: e.rule, property: e.property, detail: e.message });
      throw e;
    }
    const actor = req.authCtx.userId ?? NO_IDENTITY;
    const row = await db.transaction(async (tx) => {
      // the parent row is locked so a concurrent delete cannot orphan the audit record of this write
      const table = s.kind === "model_card" ? "model_cards" : s.kind === "training_dataset" ? "training_datasets" : "eval_datasets";
      const locked = await tx.execute(sql`select 1 from ${sql.identifier(table)} where id = ${s.id} for share`);
      if (!(locked as unknown as { rows: unknown[] }).rows.length) return null;
      const [r] = await tx
        .insert(aiBomSpdxDeclarations)
        .values({ [PARENT_FIELD[s.kind]]: s.id, property, withdrawn: false, ...columnsOf(property, value), source: body.data.source, declaredByUserId: actor })
        .returning();
      await tx.insert(auditLog).values({
        userId: actor,
        objectType: AUDIT_OBJECT[s.kind],
        objectId: s.id,
        effect: "allow",
        ruleId: "ai-bom-spdx-field-declared",
        ruleChain: [],
        reason: `SPDX ${property} declared (${body.data.source}) for AI BOM export (ADR-0189 R51)`,
        detail: { phase: "ai_bom_spdx", action: "declared", subjectKind: s.kind, property, source: body.data.source, seq: r!.seq, value: valueOf(r!) },
      });
      return r!;
    });
    if (!row) return reply.status(404).send({ error: "spdx_subject_not_found" });
    return reply.status(200).send({ declaration: view(row) });
  });

  app.post("/v1/ai-bom/spdx-fields/:subjectKind/:subjectId/:property/withdraw", async (req, reply) => {
    if (notAdmin(req, reply)) return reply;
    const s = subjectOf(req);
    if (!s) return reply.status(400).send({ error: "invalid_spdx_subject" });
    const property = propertyOf(s.kind, req);
    if (!property) return reply.status(422).send({ error: "spdx_property_not_allowed", detail: `a ${s.kind} declares only ${AI_BOM_SPDX_SUBJECT_PROPERTIES[s.kind].join(", ")}` });
    if (!withdrawBody.safeParse(req.body ?? {}).success) return reply.status(400).send({ error: "invalid_spdx_declaration", detail: "the body is empty" });
    const actor = req.authCtx.userId ?? NO_IDENTITY;
    const result = await db.transaction(async (tx) => {
      const table = s.kind === "model_card" ? "model_cards" : s.kind === "training_dataset" ? "training_datasets" : "eval_datasets";
      const locked = await tx.execute(sql`select 1 from ${sql.identifier(table)} where id = ${s.id} for update`);
      if (!(locked as unknown as { rows: unknown[] }).rows.length) return "not_found" as const;
      // the parent row lock serialises writers of one subject, so "is there a value" cannot race a declare
      const [latest] = await tx
        .select()
        .from(aiBomSpdxDeclarations)
        .where(and(eq(PARENT[s.kind], s.id), eq(aiBomSpdxDeclarations.property, property)))
        .orderBy(desc(aiBomSpdxDeclarations.seq))
        .limit(1);
      if (!latest || latest.withdrawn) return "not_declared" as const;
      const [r] = await tx
        .insert(aiBomSpdxDeclarations)
        .values({ [PARENT_FIELD[s.kind]]: s.id, property, withdrawn: true, valueTime: null, valueText: null, valueList: null, source: "admin_entered", declaredByUserId: actor })
        .returning();
      await tx.insert(auditLog).values({
        userId: actor,
        objectType: AUDIT_OBJECT[s.kind],
        objectId: s.id,
        effect: "allow",
        ruleId: "ai-bom-spdx-field-withdrawn",
        ruleChain: [],
        reason: `SPDX ${property} withdrawn for AI BOM export (ADR-0189 R51); the SPDX rendering is not_producible until it is declared again`,
        detail: { phase: "ai_bom_spdx", action: "withdrawn", subjectKind: s.kind, property, seq: r!.seq, withdrawnSeq: latest.seq },
      });
      return r!;
    });
    if (result === "not_found") return reply.status(404).send({ error: "spdx_subject_not_found" });
    if (result === "not_declared") return reply.status(409).send({ error: "spdx_field_not_declared" });
    return reply.status(200).send({ declaration: view(result) });
  });
}
