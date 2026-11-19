/**
 * ADR-0327 addendum — business-authored decision tables at the gateway.
 *
 *  - A decision table is bound to one AI step (agent + span name, the key the rule-step detector uses) and is a list of
 *    rows: a value, or a short list of values, for each input field, and one fixed outcome. It is validated by the zod
 *    schema below and compiled by the kernel's `compileDecisionTable` to the SAME exact-match rule the detector
 *    induces (`InducedRule`), so there is no second engine and nothing is evaluated: no expression language, no code.
 *  - Versions are immutable. Proposing one creates it `pending_review` with an approvals row naming an active
 *    administrator other than the author; it is published only through the one decide path
 *    (`POST /v1/approvals/:id/decide` → `applyDecisionTableDecision`), and only if the version it was proposed against
 *    is still the published one (else it is recorded `stale`). The author never decides their own version.
 *  - Every create, proposal and decision writes an audit row in the same transaction. Admin-only (default gate).
 *  - Publishing changes no routing: the AI still answers the step until the switch (ADR-0327 slice 4) is approved.
 *    Nothing here is an authorisation decision (ADR-0327 §Decision 5).
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  agents,
  and,
  approvals,
  auditLog,
  decisionTables,
  decisionTableVersions,
  desc,
  eq,
  getTableColumns,
  sql,
  users,
  type Db,
  type DecisionTableRow,
  type DecisionTableVersionRow,
  type DecisionTableVersionStatus,
} from "@regulait/db";
import {
  DECISION_TABLE_LIMITS,
  compileDecisionTable,
  renderDecisionTable,
  type DecisionTableBody,
  type InducedRule,
} from "@regulait/optimizer-kernel";
import { DECISION_TABLE_VERSION_MACHINE, canonicalJson } from "@regulait/shared";
import type { ListSpec } from "./list-contract.js";
import { whereFrom } from "./state-transition.js";
import { answerListPage, type ContractList } from "./list-contract-route.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
/** approvals.stage_id of a decision-table review: the prefix plus the version id */
export const DECISION_TABLE_VERSION_PREFIX = "__decision_table__:";
const HISTORY_LIMIT = 20;

export const DECISION_TABLE_AUDIT_RULE_IDS = {
  created: "decision_table_created",
  proposed: "decision_table_version_proposed",
  published: "decision_table_version_published",
  rejected: "decision_table_version_rejected",
  stale: "decision_table_version_stale",
  digestMismatch: "decision_table_version_digest_mismatch",
} as const;

/**
 * What a reviewer approves: sha256 hex over ADR-0060's `canonicalJson` of the version body (key order is not an input,
 * and it survives the jsonb round trip). Stored on the version and as the approval's `arguments_digest`, the consent
 * fingerprint ADR-0104 binds approvals with; publishing recomputes it from the stored body and refuses on a mismatch.
 */
export function decisionTableBodyDigest(body: unknown): string {
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

/**
 * The version lifecycle (owner rule 12) is the shared ADR-0348 machine `DECISION_TABLE_VERSION_MACHINE`; every status
 * change goes through `transitionVersion`, a guarded UPDATE (`whereFrom`) on the event's `from` states. A version is
 * created in the machine's initial state; nothing else ever changes its status.
 */
export const DECISION_TABLE_VERSION_INITIAL = "pending_review" as const satisfies (typeof DECISION_TABLE_VERSION_MACHINE.def.initial)[number];
type VersionEvent = (typeof DECISION_TABLE_VERSION_MACHINE.events)[number];

type Decided = { decidedBy: string; decidedAt: ReturnType<typeof sql> };
async function transitionVersion(db: Db, id: string, event: VersionEvent, extra: Partial<Decided> = {}) {
  const [row] = await db
    .update(decisionTableVersions)
    .set({ ...extra, status: DECISION_TABLE_VERSION_MACHINE.def.transitions[event].to })
    .where(and(eq(decisionTableVersions.id, id), whereFrom(decisionTableVersions.status, DECISION_TABLE_VERSION_MACHINE, event)))
    .returning();
  return row ?? null;
}

// ---- the schema a business user's table is validated by -------------------------------------------------------------

const fieldName = z
  .string()
  .min(1)
  .max(200)
  .refine((k) => k !== "__proto__", "this field name is reserved");
const scalar = z.union([z.string().max(DECISION_TABLE_LIMITS.maxOutputLength), z.number().finite(), z.boolean(), z.null()]);
const condition = z.union([scalar, z.array(scalar).min(1).max(DECISION_TABLE_LIMITS.maxValuesPerCondition)]);
export const decisionTableBodySchema = z
  .object({
    fields: z.array(fieldName).min(1).max(DECISION_TABLE_LIMITS.maxFields),
    rows: z
      .array(
        z
          .object({
            when: z.record(fieldName, condition),
            then: z.string().min(1).max(DECISION_TABLE_LIMITS.maxOutputLength),
          })
          .strict(),
      )
      .min(1)
      .max(DECISION_TABLE_LIMITS.maxRows),
  })
  .strict();

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    agentId: z.string().uuid(),
    stepName: z.string().min(1).max(200),
  })
  .strict();
const proposeBody = z
  .object({
    table: decisionTableBodySchema,
    reviewerUserId: z.string().uuid(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
const idParam = z.object({ id: z.string().uuid() }).strict();
const listFilters = z.object({ agentId: z.string().uuid().optional() }).strict();

/** two tables are the same table when they compile to the same cells, whatever the row and value order */
function canonicalCells(rule: InducedRule): string {
  return JSON.stringify({
    fields: rule.fields,
    cells: rule.cells.map((c) => JSON.stringify([c.key, c.output])).sort(),
  });
}

function versionView(v: DecisionTableVersionRow, withBody: boolean) {
  const body = v.body as DecisionTableBody;
  const compiled = compileDecisionTable(body);
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    lifecycle: DECISION_TABLE_VERSION_MACHINE.describe(v.status),
    baseVersion: v.baseVersion,
    authorUserId: v.authorUserId,
    reason: v.reason,
    approvalId: v.approvalId,
    createdAt: v.createdAt,
    decidedBy: v.decidedBy,
    decidedAt: v.decidedAt,
    ...(withBody
      ? {
          table: body,
          lines: renderDecisionTable(body),
          cells: compiled.ok ? compiled.cells : null,
          /** each covered combination is a test case: these inputs give this outcome, anything else goes to the AI */
          testCases: compiled.ok
            ? compiled.rule.cells.map((c) => ({ input: Object.fromEntries(compiled.rule.fields.map((f, i) => [f, c.key[i]])), expected: c.output }))
            : [],
        }
      : {}),
  };
}

type TableListRow = DecisionTableRow & { agentName: string | null; publishedVersion: number | null; pendingVersion: number | null };
function tableView(r: TableListRow) {
  return {
    id: r.id,
    name: r.name,
    agentId: r.agentId,
    agentName: r.agentName,
    stepName: r.stepName,
    publishedVersion: r.publishedVersion,
    pendingVersion: r.pendingVersion,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  };
}
export type DecisionTableView = ReturnType<typeof tableView>;

const versionIn = (status: DecisionTableVersionStatus) =>
  sql<number | null>`(select v.version from ${decisionTableVersions} v where v.table_id = ${decisionTables.id} and v.status = ${status})`;

/** ADR-0226: the decision-table list under the shared list contract */
export const DECISION_TABLES_LIST: ListSpec<DecisionTableView> = {
  id: "decision-tables",
  sorts: {
    name: { expr: sql`lower(${decisionTables.name})` },
    agent: { expr: sql`lower(${agents.name})` },
    step: { expr: decisionTables.stepName },
    created: { expr: decisionTables.createdAt, keysetAt: decisionTables.createdAt },
  },
  columns: {
    name: { label: "Name", value: (r) => r.name },
    agent: { label: "Agent", value: (r) => r.agentName ?? r.agentId },
    step: { label: "Step", value: (r) => r.stepName },
    published: { label: "Published version", value: (r) => r.publishedVersion },
    pending: { label: "Version in review", value: (r) => r.pendingVersion },
    created: { label: "Created", value: (r) => r.createdAt },
  },
  filters: ["agentId"],
  defaultSort: { col: "name", dir: "asc" },
  idCol: decisionTables.id,
};

async function audit(
  db: Db,
  userId: string | null,
  tableId: string,
  ruleId: string,
  effect: "allow" | "deny" | "require_approval",
  reason: string,
  detail: Record<string, unknown>,
) {
  await db.insert(auditLog).values({
    userId: userId ?? NO_IDENTITY,
    objectType: "decision_table",
    objectId: tableId,
    detail,
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

export function registerDecisionTableRoutes(app: FastifyInstance, db: Db): void {
  const list: ContractList<DecisionTableView, z.infer<typeof listFilters>> = {
    spec: DECISION_TABLES_LIST,
    filters: listFilters,
    reader: {
      fetch: async (q) => {
        const rows = await db
          .select({
            ...getTableColumns(decisionTables),
            agentName: agents.name,
            publishedVersion: versionIn("published"),
            pendingVersion: versionIn("pending_review"),
            _cursorAt: q.cursorAt,
          })
          .from(decisionTables)
          .leftJoin(agents, eq(agents.id, decisionTables.agentId))
          .where(q.where)
          .orderBy(...q.orderBy)
          .limit(q.limit)
          .offset(q.offset);
        return rows.map(({ _cursorAt, ...r }) => ({ ...tableView(r), _cursorAt }));
      },
      countable: (where) => db.select({ one: sql`1` }).from(decisionTables).leftJoin(agents, eq(agents.id, decisionTables.agentId)).where(where),
      idOf: (r) => r.id,
    },
    where: (_req, f) => (f.agentId ? eq(decisionTables.agentId, f.agentId) : undefined),
  };
  app.get("/v1/decision-tables", async (req, reply) => answerListPage(db, req, reply, list));

  app.post("/v1/decision-tables", async (req, reply) => {
    const body = createBody.parse(req.body);
    const actor = req.authCtx.userId ?? null;
    const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, body.agentId));
    if (!agent) return reply.status(404).send({ error: "unknown_agent" });
    const [clash] = await db
      .select({ id: decisionTables.id, name: decisionTables.name, agentId: decisionTables.agentId, stepName: decisionTables.stepName })
      .from(decisionTables)
      .where(
        sql`lower(${decisionTables.name}) = lower(${body.name}) or (${decisionTables.agentId} = ${body.agentId} and ${decisionTables.stepName} = ${body.stepName})`,
      )
      .limit(1);
    if (clash) {
      const sameStep = clash.agentId === body.agentId && clash.stepName === body.stepName;
      return reply.status(409).send({
        error: sameStep ? "decision_table_exists_for_step" : "decision_table_name_taken",
        detail: sameStep ? "this step already has a decision table; propose a new version of it" : "another decision table has this name",
        id: clash.id,
      });
    }
    const row = await db.transaction(async (tx) => {
      const [t] = await tx
        .insert(decisionTables)
        .values({ name: body.name, agentId: body.agentId, stepName: body.stepName, createdBy: actor })
        .returning();
      await audit(tx as unknown as Db, actor, t!.id, DECISION_TABLE_AUDIT_RULE_IDS.created, "allow", "decision table created", {
        name: t!.name,
        agentId: t!.agentId,
        stepName: t!.stepName,
      });
      return t!;
    });
    return reply.status(201).send(tableView({ ...row, agentName: null, publishedVersion: null, pendingVersion: null }));
  });

  app.get("/v1/decision-tables/:id", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const [t] = await db
      .select({ ...getTableColumns(decisionTables), agentName: agents.name })
      .from(decisionTables)
      .leftJoin(agents, eq(agents.id, decisionTables.agentId))
      .where(eq(decisionTables.id, id));
    if (!t) return reply.status(404).send({ error: "unknown_decision_table" });
    const versions = await db
      .select()
      .from(decisionTableVersions)
      .where(eq(decisionTableVersions.tableId, id))
      .orderBy(desc(decisionTableVersions.version))
      .limit(HISTORY_LIMIT);
    // the published and pending versions are read on their own, so a long history never hides them
    const [published] = await db
      .select()
      .from(decisionTableVersions)
      .where(and(eq(decisionTableVersions.tableId, id), eq(decisionTableVersions.status, "published")));
    const [pending] = await db
      .select()
      .from(decisionTableVersions)
      .where(and(eq(decisionTableVersions.tableId, id), eq(decisionTableVersions.status, DECISION_TABLE_VERSION_INITIAL)));
    return {
      ...tableView({ ...t, publishedVersion: published?.version ?? null, pendingVersion: pending?.version ?? null }),
      published: published ? versionView(published, true) : null,
      pending: pending ? versionView(pending, true) : null,
      history: versions.map((v) => versionView(v, false)),
      historyLimit: HISTORY_LIMIT,
    };
  });

  app.post("/v1/decision-tables/:id/versions", async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = proposeBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", issues: parsed.error.issues.slice(0, 50) });
    }
    const body = parsed.data;
    const actor = req.authCtx.userId ?? null;
    const compiled = compileDecisionTable(body.table);
    if (!compiled.ok) return reply.status(422).send({ error: "invalid_decision_table", problems: compiled.problems });
    if (actor !== null && body.reviewerUserId === actor) {
      return reply.status(422).send({ error: "reviewer_is_author", detail: "a decision table is reviewed by someone other than its author" });
    }
    const [reviewer] = await db
      .select({ isAdmin: users.isAdmin, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, body.reviewerUserId));
    if (!reviewer || reviewer.disabledAt !== null || !reviewer.isAdmin) {
      return reply.status(422).send({ error: "reviewer_not_eligible", detail: "the reviewer must be an active administrator" });
    }

    const out = await db.transaction(async (tx) => {
      // one proposer at a time per table: the table row is the lock (the version set may be empty)
      const [t] = await tx.select().from(decisionTables).where(eq(decisionTables.id, id)).for("update");
      if (!t) return { status: 404, body: { error: "unknown_decision_table" } } as const;
      const [pending] = await tx
        .select({ version: decisionTableVersions.version, approvalId: decisionTableVersions.approvalId })
        .from(decisionTableVersions)
        .where(and(eq(decisionTableVersions.tableId, id), eq(decisionTableVersions.status, DECISION_TABLE_VERSION_INITIAL)));
      if (pending) {
        return {
          status: 409,
          body: {
            error: "decision_table_version_pending",
            detail: `version ${pending.version} is waiting for review; decide it before proposing another`,
            approvalId: pending.approvalId,
          },
        } as const;
      }
      const [published] = await tx
        .select()
        .from(decisionTableVersions)
        .where(and(eq(decisionTableVersions.tableId, id), eq(decisionTableVersions.status, "published")));
      if (published) {
        const current = compileDecisionTable(published.body as DecisionTableBody);
        if (current.ok && canonicalCells(current.rule) === canonicalCells(compiled.rule)) {
          return { status: 422, body: { error: "no_change", detail: "the proposed table covers the same inputs with the same outcomes as the published one" } } as const;
        }
      }
      const [{ top } = { top: null }] = await tx
        .select({ top: sql<number | null>`max(${decisionTableVersions.version})` })
        .from(decisionTableVersions)
        .where(eq(decisionTableVersions.tableId, id));
      const version = (top ?? 0) + 1;
      const digest = decisionTableBodyDigest(body.table);
      const [v] = await tx
        .insert(decisionTableVersions)
        .values({
          tableId: id,
          version,
          body: body.table,
          bodySha256: digest,
          baseVersion: published?.version ?? null,
          status: DECISION_TABLE_VERSION_INITIAL,
          authorUserId: actor,
          reason: body.reason,
        })
        .returning();
      const [a] = await tx
        .insert(approvals)
        .values({
          userId: actor ?? body.reviewerUserId,
          objectType: "decision_table",
          stageId: `${DECISION_TABLE_VERSION_PREFIX}${v!.id}`,
          approverUserId: body.reviewerUserId,
          // the consent is for exactly this body (ADR-0104's fingerprint column)
          argumentsDigest: digest,
        })
        .returning({ id: approvals.id });
      await tx.update(decisionTableVersions).set({ approvalId: a!.id }).where(eq(decisionTableVersions.id, v!.id));
      await audit(tx as unknown as Db, actor, id, DECISION_TABLE_AUDIT_RULE_IDS.proposed, "require_approval", body.reason, {
        name: t.name,
        version,
        baseVersion: published?.version ?? null,
        approvalId: a!.id,
        reviewerUserId: body.reviewerUserId,
        rows: compiled.rows,
        cells: compiled.cells,
      });
      return { status: 202, body: { pending: true, approvalId: a!.id, version, rows: compiled.rows, cells: compiled.cells } } as const;
    });
    return reply.status(out.status).send(out.body);
  });
}

// ---- the one decide path's hooks (app.ts) -----------------------------------------------------------------------------

const versionIdOf = (approval: { stageId: string | null }) =>
  approval.stageId?.startsWith(DECISION_TABLE_VERSION_PREFIX) ? approval.stageId.slice(DECISION_TABLE_VERSION_PREFIX.length) : null;

/** separation of duties: the author of a version never decides it, through delegation or admin override */
export async function precheckDecisionTableDecision(
  db: Pick<Db, "select">,
  approval: { stageId: string | null },
  deciderUserId: string,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const versionId = versionIdOf(approval);
  if (!versionId) return null;
  const [v] = await db.select({ authorUserId: decisionTableVersions.authorUserId }).from(decisionTableVersions).where(eq(decisionTableVersions.id, versionId));
  if (v?.authorUserId === deciderUserId) {
    return {
      status: 403,
      body: {
        error: "cannot_approve_own_decision_table",
        detail: "the decider proposed this decision-table version; the named reviewer decides it",
      },
    };
  }
  return null;
}

/**
 * Runs inside the decision's transaction. Approved: the version is published ONLY if the version it was proposed
 * against is still the published one (else `stale`, nothing changes); the previous published version is superseded.
 * Denied: `rejected`, nothing changes. Every outcome is audited.
 */
export async function applyDecisionTableDecision(
  tx: Db,
  approval: { id: string; stageId: string | null; argumentsDigest: string | null },
  decision: "approved" | "denied",
  deciderUserId: string,
): Promise<void> {
  const versionId = versionIdOf(approval);
  if (!versionId) return;
  const [ref] = await tx.select({ tableId: decisionTableVersions.tableId }).from(decisionTableVersions).where(eq(decisionTableVersions.id, versionId));
  if (!ref) return;
  // serialized with proposals on the table row; the version is read again under that lock
  const [table] = await tx.select().from(decisionTables).where(eq(decisionTables.id, ref.tableId)).for("update");
  if (!table) return;
  const [draft] = await tx.select().from(decisionTableVersions).where(eq(decisionTableVersions.id, versionId));
  if (!draft || draft.status !== DECISION_TABLE_VERSION_INITIAL) return;
  const decided: Decided = { decidedBy: deciderUserId, decidedAt: sql`now()` };
  const detail = { name: table.name, version: draft.version, approvalId: approval.id };

  if (decision === "denied") {
    if (await transitionVersion(tx, draft.id, "reject", decided)) {
      await audit(tx, deciderUserId, table.id, DECISION_TABLE_AUDIT_RULE_IDS.rejected, "deny", `version ${draft.version} rejected; the published version stays in force`, detail);
    }
    return;
  }
  const [published] = await tx
    .select()
    .from(decisionTableVersions)
    .where(and(eq(decisionTableVersions.tableId, table.id), eq(decisionTableVersions.status, "published")));
  if ((published?.version ?? null) !== draft.baseVersion) {
    if (await transitionVersion(tx, draft.id, "mark_stale", decided)) {
      await audit(
        tx,
        deciderUserId,
        table.id,
        DECISION_TABLE_AUDIT_RULE_IDS.stale,
        "deny",
        `version ${draft.version} approved but not published: it was proposed against version ${draft.baseVersion ?? "none"}, and version ${published?.version ?? "none"} is published now; propose it again`,
        { ...detail, baseVersion: draft.baseVersion, publishedVersion: published?.version ?? null },
      );
    }
    return;
  }
  // what was approved is what is published: the stored body must still hash to the digest the version and the
  // approval were bound to (the DB trigger freezes the body; this refuses even if that guard were bypassed)
  const now = decisionTableBodyDigest(draft.body);
  if (now !== draft.bodySha256 || approval.argumentsDigest !== draft.bodySha256) {
    if (await transitionVersion(tx, draft.id, "mark_stale", decided)) {
      await audit(
        tx,
        deciderUserId,
        table.id,
        DECISION_TABLE_AUDIT_RULE_IDS.digestMismatch,
        "deny",
        `version ${draft.version} approved but not published: its body no longer matches what was proposed for review; propose it again`,
        { ...detail, proposedSha256: draft.bodySha256, approvalSha256: approval.argumentsDigest, storedSha256: now },
      );
    }
    return;
  }
  // the old pointer moves first: the partial unique index admits one published version per table
  if (published) await transitionVersion(tx, published.id, "supersede");
  if (!(await transitionVersion(tx, draft.id, "publish", decided))) return;
  await audit(
    tx,
    deciderUserId,
    table.id,
    DECISION_TABLE_AUDIT_RULE_IDS.published,
    "allow",
    `version ${draft.version} approved by the named reviewer and published; the AI still answers this step until a switch is approved`,
    { ...detail, from: published?.version ?? null },
  );
}
