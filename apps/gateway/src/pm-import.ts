/**
 * ADR-0289 — THE PM PROJECT / WORK-ITEM IMPORTER (ADR-0054 §3, "Deviation 3" closed).
 *
 * Maps a customer's existing PM project (one PM connection names one project)
 * onto a RegulAIt Initiative and records LINKAGE to every work item already in
 * it, through the existing ADR-0010 adapter and its governed fetch (egress
 * guard, compiled-default posture). The PM tool stays the source of truth
 * (pillar 8): no title, state or field is copied; only id, url and type.
 *
 * The discipline ADR-0054 asked for:
 *  - DRY RUN BY DEFAULT. `mode` defaults to `dry_run`; nothing is written but
 *    the onboarding_imports record and the audit row.
 *  - APPLY IS WHAT WAS PREVIEWED. `apply` must carry the dry run's
 *    `planSha256`; the plan is recomputed under a per-connection lock and a
 *    different plan is a 409 `plan_changed` carrying the new plan. An admin
 *    never applies a diff they did not see.
 *  - IDEMPOTENT. Re-running reconciles: new items are added, changed url/type
 *    is updated, an item the tool no longer has is marked `missing_since`
 *    (never deleted), and one that re-appears is cleared.
 *  - ALL OR NOTHING. A listing larger than `maxItems`, a malformed item, a
 *    duplicated id, or an adapter without a listing is refused WHOLE, recorded
 *    and audited — a partial listing would mark real items missing.
 *
 * Admin-only (the default gate). The external data is untrusted: every field is
 * bounded and every url must be http(s) (or the mock's own scheme on the mock).
 */

import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  and,
  asc,
  auditLog,
  eq,
  gt,
  initiatives,
  inArray,
  onboardingImports,
  pmConnections,
  pmImportedWorkItems,
  pmProjectInitiatives,
  sql,
  type Db,
} from "@regulait/db";
import { PmProviderError, type WorkItemSummary } from "@regulait/pm-provider";
import { ConnectionEgressBlockedError } from "./connection-egress.js";
import { CompiledDefaultEgressBlockedError } from "./compiled-egress.js";
import { ONBOARDING_RULE_IDS } from "./onboarding.js";
import { providerErrorText, providerFor } from "./pm.js";

export const PM_IMPORT_PAGE_SIZE = 100;
export const PM_IMPORT_DEFAULT_MAX_ITEMS = 1000;
export const PM_IMPORT_HARD_MAX_ITEMS = 10_000;
/** entries per action kept in a plan body (the counts and the fingerprint always cover everything) */
export const PM_IMPORT_PLAN_SAMPLE = 100;
const ITEMS_LIST_DEFAULT = 100;
const ITEMS_LIST_MAX = 500;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export const pmImportSchema = z
  .object({
    connectionName: z.string().min(1).max(200),
    initiative: z.union([
      z.object({ id: z.string().uuid() }).strict(),
      z.object({ name: z.string().trim().min(1).max(200) }).strict(),
    ]),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    planSha256: z
      .string()
      .length(64)
      .regex(/^[0-9a-f]+$/)
      .optional(),
    maxItems: z.number().int().min(1).max(PM_IMPORT_HARD_MAX_ITEMS).default(PM_IMPORT_DEFAULT_MAX_ITEMS),
  })
  .strict();

const itemsQuerySchema = z
  .object({
    connectionName: z.string().min(1).max(200),
    limit: z.coerce.number().int().min(1).max(ITEMS_LIST_MAX).default(ITEMS_LIST_DEFAULT),
    cursor: z.string().uuid().optional(),
  })
  .strict();

/** A provider-reported item that fails the bounds, with the reason (the id is truncated: it is untrusted text). */
export interface InvalidItem {
  id: string;
  reason: string;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Validate one untrusted item. Returns the reason it is refused, or null. */
export function itemProblem(item: WorkItemSummary, provider: string): string | null {
  if (typeof item.id !== "string" || item.id.length < 1 || item.id.length > 256 || CONTROL_CHARS.test(item.id)) {
    return "id must be 1-256 printable characters";
  }
  if (typeof item.type !== "string" || item.type.length < 1 || item.type.length > 128 || CONTROL_CHARS.test(item.type)) {
    return "type must be 1-128 printable characters";
  }
  if (typeof item.url !== "string" || item.url.length < 1 || item.url.length > 2048) return "url must be 1-2048 characters";
  let parsed: URL;
  try {
    parsed = new URL(item.url);
  } catch {
    return "url is not an absolute URL";
  }
  const allowed = provider === "mock" ? ["https:", "http:", "mock-pm:"] : ["https:", "http:"];
  if (!allowed.includes(parsed.protocol)) return `url scheme '${parsed.protocol}' is not allowed`;
  return null;
}

export type InitiativeAction = "create" | "map" | "remap" | "unchanged";

export interface PmImportPlan {
  connection: { id: string; name: string; provider: string; project: string };
  initiative: { action: InitiativeAction; id: string | null; name: string; previousInitiativeId: string | null };
  counts: { listed: number; add: number; update: number; reappeared: number; unchanged: number; missing: number; stillMissing: number };
  add: Array<{ externalId: string; url: string; type: string }>;
  update: Array<{ externalId: string; url: string; type: string }>;
  reappeared: string[];
  missing: string[];
  /** fingerprint of the WHOLE plan (every entry, not the sample); apply must present it */
  planSha256: string;
}

type ExistingRow = { id: string; externalId: string; externalUrl: string; itemType: string; missingSince: Date | null };

/** The pure diff: what an import of `listed` would do to `existing` and the initiative mapping. */
export function planPmImport(args: {
  connection: PmImportPlan["connection"];
  initiative: { id: string | null; name: string };
  currentInitiativeId: string | null;
  listed: WorkItemSummary[];
  existing: ExistingRow[];
}): PmImportPlan {
  const { listed, existing } = args;
  const byExt = new Map(existing.map((r) => [r.externalId, r]));
  const listedIds = new Set(listed.map((i) => i.id));
  const add: PmImportPlan["add"] = [];
  const update: PmImportPlan["update"] = [];
  const reappeared: string[] = [];
  let unchanged = 0;
  for (const item of listed) {
    const row = byExt.get(item.id);
    if (!row) {
      add.push({ externalId: item.id, url: item.url, type: item.type });
      continue;
    }
    const changed = row.externalUrl !== item.url || row.itemType !== item.type;
    if (row.missingSince) reappeared.push(item.id);
    if (changed) update.push({ externalId: item.id, url: item.url, type: item.type });
    if (!changed && !row.missingSince) unchanged += 1;
  }
  const missing: string[] = [];
  let stillMissing = 0;
  for (const row of existing) {
    if (listedIds.has(row.externalId)) continue;
    if (row.missingSince) stillMissing += 1;
    else missing.push(row.externalId);
  }
  const action: InitiativeAction =
    args.initiative.id === null
      ? "create"
      : args.currentInitiativeId === null
        ? "map"
        : args.currentInitiativeId === args.initiative.id
          ? "unchanged"
          : "remap";
  const byId = (a: { externalId: string }, b: { externalId: string }) => a.externalId.localeCompare(b.externalId);
  add.sort(byId);
  update.sort(byId);
  reappeared.sort();
  missing.sort();
  const initiative = { action, id: args.initiative.id, name: args.initiative.name, previousInitiativeId: args.currentInitiativeId };
  const planSha256 = createHash("sha256")
    .update(JSON.stringify({ connectionId: args.connection.id, initiative, add, update, reappeared, missing }))
    .digest("hex");
  return {
    connection: args.connection,
    initiative,
    counts: {
      listed: listed.length,
      add: add.length,
      update: update.length,
      reappeared: reappeared.length,
      unchanged,
      missing: missing.length,
      stillMissing,
    },
    add,
    update,
    reappeared,
    missing,
    planSha256,
  };
}

/** The plan as stored and returned: counts and fingerprint in full, entries sampled. */
function planBody(plan: PmImportPlan) {
  const sample = <T>(xs: T[]) => xs.slice(0, PM_IMPORT_PLAN_SAMPLE);
  return {
    ...plan,
    add: sample(plan.add),
    update: sample(plan.update),
    reappeared: sample(plan.reappeared),
    missing: sample(plan.missing),
    sampled: PM_IMPORT_PLAN_SAMPLE,
  };
}

class ImportRefusal extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    readonly detail: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(detail);
  }
}

/** Page through the project, refusing whole on any listing the importer cannot trust. */
async function listAll(
  provider: Awaited<ReturnType<typeof providerFor>>,
  conn: { provider: string; project: string },
  maxItems: number,
): Promise<WorkItemSummary[]> {
  if (!provider.listWorkItems) {
    throw new ImportRefusal(
      422,
      "pm_import_unsupported_provider",
      `the ${conn.provider} adapter cannot list a project's work items yet, so it cannot be imported`,
    );
  }
  const out: WorkItemSummary[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await provider.listWorkItems(conn.project, { cursor, limit: PM_IMPORT_PAGE_SIZE });
    out.push(...page.items);
    if (out.length > maxItems) {
      throw new ImportRefusal(
        422,
        "pm_import_too_large",
        `the project has more than ${maxItems} work items; raise maxItems (at most ${PM_IMPORT_HARD_MAX_ITEMS}) — a partial import would mark real items missing`,
        { maxItems },
      );
    }
    if (page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor) || page.items.length === 0) {
      throw new ImportRefusal(502, "pm_provider_error", "the PM tool returned a repeating or empty page cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  const invalid: InvalidItem[] = [];
  const seen = new Set<string>();
  for (const item of out) {
    const problem = itemProblem(item, conn.provider) ?? (seen.has(item.id) ? "the id appears twice in the listing" : null);
    if (problem) invalid.push({ id: String(item.id).slice(0, 64), reason: problem });
    seen.add(item.id);
  }
  if (invalid.length > 0) {
    throw new ImportRefusal(
      422,
      "pm_import_invalid_items",
      `the PM tool returned ${invalid.length} work item(s) the importer cannot record; nothing was imported`,
      { invalidItems: invalid.slice(0, 20) },
    );
  }
  return out;
}

export function registerPmImportRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string } = {}): void {
  const audit = (userId: string | null, objectId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    db.insert(auditLog).values({
      userId: userId ?? NIL_UUID,
      objectType: "onboarding_import",
      objectId,
      detail: { phase: "onboarding", kind: "pm_work_items", ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });

  const refuse = async (
    userId: string | null,
    mode: "dry_run" | "apply",
    payload: unknown,
    r: ImportRefusal,
  ) => {
    const [row] = await db
      .insert(onboardingImports)
      .values({
        kind: "pm_work_items",
        mode,
        status: "refused",
        payloadSha256: createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex"),
        rowCount: 0,
        plan: { error: r.error, ...r.extra } as never,
        result: null,
        ruleId: ONBOARDING_RULE_IDS.importRejected,
        reason: `PM import refused: ${r.detail}`,
        requestedByUserId: userId,
      })
      .returning({ id: onboardingImports.id });
    await audit(userId, row!.id, ONBOARDING_RULE_IDS.importRejected, "deny", `PM import refused: ${r.detail}`, { error: r.error, ...r.extra });
    return { error: r.error, detail: r.detail, importId: row!.id, ...r.extra };
  };

  // ---- POST /v1/onboarding/imports/pm ------------------------------------
  app.post("/v1/onboarding/imports/pm", async (req, reply) => {
    const parsed = pmImportSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.status(422).send({ error: "import_validation_failed", ruleId: ONBOARDING_RULE_IDS.importRejected, issues: parsed.error.issues });
    }
    const body = parsed.data;
    const userId = req.authCtx.userId;
    if (body.mode === "apply" && !body.planSha256) {
      return reply.status(422).send({
        error: "plan_required",
        detail: "apply must carry the planSha256 of a dry run, so what is applied is what was previewed",
      });
    }
    if (!opts.dataKey) return reply.status(503).send({ error: "pm_connections_require_data_key" });
    const [conn] = await db.select().from(pmConnections).where(eq(pmConnections.name, body.connectionName));
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });

    // the initiative: by id it must exist; by name it is found or (on apply) created
    let target: { id: string | null; name: string };
    if ("id" in body.initiative) {
      const [ini] = await db.select({ id: initiatives.id, name: initiatives.name }).from(initiatives).where(eq(initiatives.id, body.initiative.id));
      if (!ini) return reply.status(404).send({ error: "unknown_initiative" });
      target = ini;
    } else {
      const [ini] = await db.select({ id: initiatives.id, name: initiatives.name }).from(initiatives).where(eq(initiatives.name, body.initiative.name));
      target = ini ?? { id: null, name: body.initiative.name };
    }

    let listed: WorkItemSummary[];
    try {
      const provider = await providerFor(db, conn, opts.dataKey, { userId, detail: { op: "pm_import", mode: body.mode } });
      listed = await listAll(provider, conn, body.maxItems);
    } catch (err) {
      if (err instanceof ConnectionEgressBlockedError || err instanceof CompiledDefaultEgressBlockedError) {
        return reply.status(403).send({ error: "egress_blocked", code: err.decision.code, detail: err.decision.reason });
      }
      if (err instanceof ImportRefusal) return reply.status(err.status).send(await refuse(userId, body.mode, body, err));
      if (err instanceof PmProviderError) {
        const r = new ImportRefusal(502, "pm_provider_error", `the PM tool failed the listing: ${providerErrorText(err)}`);
        return reply.status(502).send(await refuse(userId, body.mode, body, r));
      }
      throw err;
    }

    const connection = { id: conn.id, name: conn.name, provider: conn.provider, project: conn.project };
    const computePlan = async (tx: Db) => {
      const [mapping] = await tx
        .select({ initiativeId: pmProjectInitiatives.initiativeId })
        .from(pmProjectInitiatives)
        .where(eq(pmProjectInitiatives.connectionId, conn.id));
      const existing = await tx
        .select({
          id: pmImportedWorkItems.id,
          externalId: pmImportedWorkItems.externalId,
          externalUrl: pmImportedWorkItems.externalUrl,
          itemType: pmImportedWorkItems.itemType,
          missingSince: pmImportedWorkItems.missingSince,
        })
        .from(pmImportedWorkItems)
        .where(eq(pmImportedWorkItems.connectionId, conn.id));
      return {
        existing,
        plan: planPmImport({ connection, initiative: target, currentInitiativeId: mapping?.initiativeId ?? null, listed, existing }),
      };
    };

    if (body.mode === "dry_run") {
      const { plan } = await computePlan(db);
      const [row] = await db
        .insert(onboardingImports)
        .values({
          kind: "pm_work_items",
          mode: "dry_run",
          status: "planned",
          payloadSha256: plan.planSha256,
          rowCount: plan.counts.listed,
          plan: planBody(plan) as never,
          result: null,
          ruleId: ONBOARDING_RULE_IDS.importPlanned,
          reason: `PM import dry run for '${conn.name}': ${plan.counts.add} add, ${plan.counts.update} update, ${plan.counts.missing} missing`,
          requestedByUserId: userId,
        })
        .returning({ id: onboardingImports.id });
      await audit(userId, row!.id, ONBOARDING_RULE_IDS.importPlanned, "allow", `PM import previewed for '${conn.name}' (nothing changed)`, {
        connection: conn.name,
        counts: plan.counts,
        planSha256: plan.planSha256,
      });
      return { mode: "dry_run", importId: row!.id, plan: planBody(plan) };
    }

    // ---- apply: recompute under the connection's lock and compare ----------
    const outcome = await db.transaction(async (txRaw) => {
      const tx = txRaw as unknown as Db;
      await tx.execute(sql`select 1 from ${pmConnections} where ${pmConnections.id} = ${conn.id} for update`);
      const { plan, existing } = await computePlan(tx);
      if (plan.planSha256 !== body.planSha256) return { kind: "changed" as const, changed: plan };

      let initiativeId = target.id;
      if (initiativeId === null) {
        const [created] = await tx.insert(initiatives).values({ name: target.name }).onConflictDoNothing().returning({ id: initiatives.id });
        // a concurrent create of the same name: the plan said "create", so the world moved
        if (!created) return { kind: "changed" as const, changed: plan };
        initiativeId = created.id;
      }
      const [importRow] = await tx
        .insert(onboardingImports)
        .values({
          kind: "pm_work_items",
          mode: "apply",
          status: "applied",
          payloadSha256: plan.planSha256,
          rowCount: plan.counts.listed,
          plan: planBody(plan) as never,
          result: { initiativeId, ...plan.counts } as never,
          ruleId: ONBOARDING_RULE_IDS.importApplied,
          reason: `PM import applied for '${conn.name}': ${plan.counts.add} added, ${plan.counts.update} updated, ${plan.counts.missing} marked missing`,
          requestedByUserId: userId,
          appliedAt: sql`now()` as unknown as Date,
        })
        .returning({ id: onboardingImports.id });
      const importId = importRow!.id;

      if (plan.initiative.action !== "unchanged") {
        await tx
          .insert(pmProjectInitiatives)
          .values({ connectionId: conn.id, initiativeId, importId })
          .onConflictDoUpdate({
            target: pmProjectInitiatives.connectionId,
            set: { initiativeId, importId, mappedAt: sql`now()` },
          });
      }
      for (let i = 0; i < plan.add.length; i += 500) {
        await tx.insert(pmImportedWorkItems).values(
          plan.add.slice(i, i + 500).map((a) => ({
            connectionId: conn.id,
            externalId: a.externalId,
            externalUrl: a.url,
            itemType: a.type,
            firstImportId: importId,
            lastImportId: importId,
          })),
        );
      }
      const rowByExt = new Map(existing.map((r) => [r.externalId, r.id]));
      for (const u of plan.update) {
        await tx
          .update(pmImportedWorkItems)
          .set({ externalUrl: u.url, itemType: u.type })
          .where(eq(pmImportedWorkItems.id, rowByExt.get(u.externalId)!));
      }
      // every listed item that already had a row: seen now, and no longer missing (a re-appearance clears it)
      const listedRowIds = listed.map((l) => rowByExt.get(l.id)).filter((x): x is string => !!x);
      for (let i = 0; i < listedRowIds.length; i += 1000) {
        await tx
          .update(pmImportedWorkItems)
          .set({ lastSeenAt: sql`now()`, lastImportId: importId, missingSince: null })
          .where(inArray(pmImportedWorkItems.id, listedRowIds.slice(i, i + 1000)));
      }
      const missingIds = plan.missing.map((m) => rowByExt.get(m)!);
      for (let i = 0; i < missingIds.length; i += 1000) {
        await tx
          .update(pmImportedWorkItems)
          .set({ missingSince: sql`now()`, lastImportId: importId })
          .where(inArray(pmImportedWorkItems.id, missingIds.slice(i, i + 1000)));
      }
      return { kind: "applied" as const, applied: plan, importId, initiativeId };
    });

    if (outcome.kind === "changed") {
      await audit(userId, null, ONBOARDING_RULE_IDS.importRejected, "deny", `PM import for '${conn.name}' not applied: the plan changed since the preview`, {
        connection: conn.name,
        expected: body.planSha256,
        actual: outcome.changed.planSha256,
      });
      return reply.status(409).send({
        error: "plan_changed",
        detail: "the PM project or the imported state changed since the dry run; review the new plan and apply its planSha256",
        plan: planBody(outcome.changed),
      });
    }
    await audit(userId, outcome.importId, ONBOARDING_RULE_IDS.importApplied, "allow", `PM import applied for '${conn.name}'`, {
      connection: conn.name,
      initiativeId: outcome.initiativeId,
      counts: outcome.applied.counts,
      planSha256: outcome.applied.planSha256,
    });
    return { mode: "apply", importId: outcome.importId, initiativeId: outcome.initiativeId, plan: planBody(outcome.applied) };
  });

  // ---- GET /v1/onboarding/imports/pm/items -------------------------------
  // The imported linkage for one connection, keyset-paginated. Titles and states
  // are not here on purpose: they are read through live from the PM tool.
  app.get("/v1/onboarding/imports/pm/items", async (req, reply) => {
    const parsed = itemsQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "validation", issues: parsed.error.issues });
    const q = parsed.data;
    const [conn] = await db
      .select({ id: pmConnections.id, name: pmConnections.name, provider: pmConnections.provider, project: pmConnections.project })
      .from(pmConnections)
      .where(eq(pmConnections.name, q.connectionName));
    if (!conn) return reply.status(404).send({ error: "unknown_connection" });
    const [mapping] = await db
      .select({ id: initiatives.id, name: initiatives.name })
      .from(pmProjectInitiatives)
      .innerJoin(initiatives, eq(initiatives.id, pmProjectInitiatives.initiativeId))
      .where(eq(pmProjectInitiatives.connectionId, conn.id));
    const rows = await db
      .select({
        id: pmImportedWorkItems.id,
        externalId: pmImportedWorkItems.externalId,
        externalUrl: pmImportedWorkItems.externalUrl,
        itemType: pmImportedWorkItems.itemType,
        firstSeenAt: pmImportedWorkItems.firstSeenAt,
        lastSeenAt: pmImportedWorkItems.lastSeenAt,
        missingSince: pmImportedWorkItems.missingSince,
      })
      .from(pmImportedWorkItems)
      .where(and(eq(pmImportedWorkItems.connectionId, conn.id), q.cursor ? gt(pmImportedWorkItems.id, q.cursor) : undefined))
      .orderBy(asc(pmImportedWorkItems.id))
      .limit(q.limit + 1);
    const more = rows.length > q.limit;
    const items = rows.slice(0, q.limit);
    return {
      connection: conn,
      initiative: mapping ?? null,
      items,
      nextCursor: more ? items[items.length - 1]!.id : null,
    };
  });
}
