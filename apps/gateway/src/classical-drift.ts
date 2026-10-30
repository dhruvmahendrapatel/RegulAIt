/**
 * ADR-0223 (P13b) — drift and explainability for classical (non-LLM) models, on the ADR-0045 model register.
 *
 *   `classical-drift-stats.ts`  the validation and the statistics (pure)
 *   THIS FILE                   persistence, the admin API, the ingestion route, and the governance-monitor input
 *
 * OFF BY DEFAULT (ADR-0180). With no `model_drift_settings` row, or `enabled = false`, no monitor can be created, no
 * summary is accepted and no artefact recorded; reads still work, and the monitor input reports no breach, so any
 * open episode resolves. Turning it on, raising the hourly cap, lowering the minimum sample count, loosening a
 * threshold and deleting recorded evidence are each a `settings_relax` step-up.
 *
 * INGESTION. `POST /v1/model-drift/monitors/:monitorId/reports` is admin-only like every route here (the app's
 * global gate): a pipeline uses an admin's API key, a person uses the page's upload. It is rate-limited twice: the
 * gateway's per-credential limiter, and a per-monitor hourly cap counted in the database under a transaction lock,
 * so parallel replicas share one count. The body is bounded (`INGEST_BODY_LIMIT`) and validated before anything is
 * written. Aggregates only: histograms and category tables, never rows.
 *
 * ALERTS. A `drift` report opens (or refreshes) a `classical_model_drift` episode on the ONE governance-alerts table
 * in the same transaction as the report and its audit row; the ADR-0157 monitor pass reads `modelDriftMonitorInput`
 * and resolves the episode once the latest report is back within thresholds. An `insufficient` report holds it.
 * This is a monitor, not a control: no dispatch decision reads these rows.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  desc,
  eq,
  governanceAlerts,
  lt,
  modelCards,
  modelDriftMonitors,
  modelDriftReports,
  modelDriftSettings,
  modelExplainabilityArtefacts,
  ne,
  sql,
  type Db,
  type ModelDriftMonitorRow,
  type ModelDriftReportRow,
  type ModelDriftSettingsRow,
} from "@regulait/db";
import { requireStepUp } from "./step-up.js";
import { databaseNow } from "./db-clock.js";
import { alertOwnershipAtRaise } from "./alert-ownership.js";
import { notifyGovernanceAlerts } from "./chatops.js";
import {
  STRICT_DRIFT_SETTINGS,
  driftFinding,
  latestReports,
  loadDriftSettings,
  type DriftSettings,
} from "./classical-drift-monitor.js";
import {
  DriftShapeError,
  STRICT_DRIFT_THRESHOLDS,
  computeDrift,
  driftFeatureSetSchema,
  explainabilitySchema,
  featureTexts,
  payloadSha256,
  personalDataCategories,
  referenceSamples,
  type DriftFeature,
  type DriftFeatureResult,
  type DriftThresholds,
} from "./classical-drift-stats.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const SETTINGS_ID = "singleton";
/** the governance monitor's raise rule id (`MONITOR_AUDIT_RULE_IDS.raised`), repeated here as feedback.ts does so
 * this module does not import the monitor */
const ALERT_RAISED_RULE_ID = "governance-alert-raised";
/** 512 KiB: 200 features × 101 edges of numbers fits several times over */
export const INGEST_BODY_LIMIT = 512 * 1024;
/** a summary window may end at most this far in the future (clock skew), on the database clock */
const WINDOW_SKEW_MS = 5 * 60_000;

export const MODEL_DRIFT_AUDIT_RULE_IDS = {
  settings: "model-drift-settings-changed",
  monitorCreated: "model-drift-monitor-created",
  monitorUpdated: "model-drift-monitor-thresholds-changed",
  monitorDeleted: "model-drift-monitor-deleted",
  report: "model-drift-report-recorded",
  artefact: "model-explainability-artefact-recorded",
  artefactDeleted: "model-explainability-artefact-deleted",
} as const;

/** the keys of `next` that loosen `current` past the strict value (a tighter or unchanged value needs no step-up) */
export function relaxedDriftSettings(next: Partial<DriftSettings>, current: DriftSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (next.enabled === true && !current.enabled) out.enabled = true;
  if (next.maxReportsPerHour !== undefined && next.maxReportsPerHour > current.maxReportsPerHour && next.maxReportsPerHour > STRICT_DRIFT_SETTINGS.maxReportsPerHour) {
    out.maxReportsPerHour = next.maxReportsPerHour;
  }
  if (next.minSamples !== undefined && next.minSamples < current.minSamples && next.minSamples < STRICT_DRIFT_SETTINGS.minSamples) {
    out.minSamples = next.minSamples;
  }
  return out;
}

/** a larger threshold alerts later: loosening past both the current and the strict value needs a step-up */
export function relaxedThresholds(next: Partial<DriftThresholds>, current: DriftThresholds): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["psiWarn", "psiAlert", "ksAlert", "jsAlert"] as const) {
    const v = next[k];
    if (v !== undefined && v > current[k] && v > STRICT_DRIFT_THRESHOLDS[k]) out[k] = v;
  }
  return out;
}

const settingsBody = z
  .object({
    enabled: z.boolean().optional(),
    maxReportsPerHour: z.number().int().min(1).max(120).optional(),
    minSamples: z.number().int().min(1).max(1_000_000).optional(),
  })
  .strict();
const thresholdsSchema = z
  .object({
    psiWarn: z.number().positive().max(10).optional(),
    psiAlert: z.number().positive().max(10).optional(),
    ksAlert: z.number().positive().max(1).optional(),
    jsAlert: z.number().positive().max(0.7).optional(),
  })
  .strict();
const createMonitorBody = z
  .object({ name: z.string().trim().min(1).max(120), reference: driftFeatureSetSchema, thresholds: thresholdsSchema.optional() })
  .strict();
const reportBody = z
  .object({
    source: z.enum(["push", "upload"]).default("push"),
    windowStart: z.iso.datetime({ offset: true }),
    windowEnd: z.iso.datetime({ offset: true }),
    features: driftFeatureSetSchema,
  })
  .strict();
const cardParam = z.object({ id: z.string().uuid() });
const monitorParam = z.object({ monitorId: z.string().uuid() });
const artefactParam = z.object({ id: z.string().uuid(), artefactId: z.string().uuid() });
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.iso.datetime({ offset: true }).optional(),
});

const DISABLED = {
  error: "model_drift_disabled",
  detail: "Classical model drift is off. An admin turns it on under Model risk, Drift and explainability; that needs a step-up.",
} as const;

function thresholdsOf(m: ModelDriftMonitorRow): DriftThresholds {
  return { psiWarn: m.psiWarn, psiAlert: m.psiAlert, ksAlert: m.ksAlert, jsAlert: m.jsAlert };
}

function thresholdOrderRefusal(t: DriftThresholds) {
  return t.psiAlert >= t.psiWarn
    ? null
    : { error: "thresholds_invalid", detail: "the PSI alert threshold must be at least the PSI warning threshold" };
}

function personalDataRefusal(texts: string[]) {
  const categories = personalDataCategories(texts);
  return categories.length === 0
    ? null
    : {
        error: "personal_data_refused",
        categories,
        detail: "Send aggregates only: a feature name or category label looks like personal data. Bucket or rename it, then submit again.",
      };
}

/** what a list or detail view returns for a monitor: the reference's shape, never its counts in a list */
function monitorView(m: ModelDriftMonitorRow, latest: ModelDriftReportRow | undefined) {
  const reference = m.reference as DriftFeature[];
  return {
    id: m.id,
    cardId: m.cardId,
    name: m.name,
    thresholds: thresholdsOf(m),
    referenceSha256: m.referenceSha256,
    referenceSamples: m.referenceSamples,
    features: reference.map((f) =>
      f.kind === "numeric" ? { name: f.name, kind: f.kind, bins: f.counts.length } : { name: f.name, kind: f.kind, categories: f.categories.length },
    ),
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    latestReport: latest ? reportView(latest) : null,
  };
}

function reportView(r: ModelDriftReportRow) {
  return {
    id: r.id,
    monitorId: r.monitorId,
    source: r.source,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    sampleCount: r.sampleCount,
    summarySha256: r.summarySha256,
    status: r.status,
    driftedFeatures: r.driftedFeatures,
    results: r.results as DriftFeatureResult[],
    createdAt: r.createdAt,
  };
}

async function stepUp(db: Db, req: FastifyRequest, reply: FastifyReply, facts: Record<string, unknown>): Promise<boolean> {
  return (await requireStepUp(db, req, reply, { kind: "settings_relax", facts })).ok;
}

const isUniqueViolation = (e: unknown, name: string) => {
  const err = e as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } };
  return (err?.code ?? err?.cause?.code) === "23505" && (err?.constraint ?? err?.cause?.constraint) === name;
};

export function registerClassicalDriftRoutes(app: FastifyInstance, db: Db): void {
  app.get("/v1/model-drift/settings", async () => ({
    settings: await loadDriftSettings(db),
    strict: STRICT_DRIFT_SETTINGS,
    strictThresholds: STRICT_DRIFT_THRESHOLDS,
  }));

  app.put("/v1/model-drift/settings", async (req, reply) => {
    const body = settingsBody.parse(req.body);
    const current = await loadDriftSettings(db);
    const relaxed = relaxedDriftSettings(body, current);
    if (Object.keys(relaxed).length > 0 && !(await stepUp(db, req, reply, { modelDrift: "settings", values: relaxed }))) return reply;
    const next: DriftSettings = {
      enabled: body.enabled ?? current.enabled,
      maxReportsPerHour: body.maxReportsPerHour ?? current.maxReportsPerHour,
      minSamples: body.minSamples ?? current.minSamples,
    };
    const userId = req.authCtx.userId ?? null;
    const saved = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(modelDriftSettings)
        .values({ id: SETTINGS_ID, ...next, updatedBy: userId })
        .onConflictDoUpdate({ target: modelDriftSettings.id, set: { ...next, updatedBy: userId, updatedAt: sql`now()` } })
        .returning();
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "org_settings",
        objectId: null,
        detail: { scope: "model_drift", from: { enabled: current.enabled, maxReportsPerHour: current.maxReportsPerHour, minSamples: current.minSamples }, to: next, relaxed: Object.keys(relaxed) },
        effect: Object.keys(relaxed).length > 0 ? "deny" : "allow",
        ruleId: MODEL_DRIFT_AUDIT_RULE_IDS.settings,
        ruleChain: [],
        reason: `classical model drift settings changed${Object.keys(relaxed).length > 0 ? ` (relaxed: ${Object.keys(relaxed).join(", ")})` : ""}`,
      });
      return row as ModelDriftSettingsRow;
    });
    return { settings: { enabled: saved.enabled, maxReportsPerHour: saved.maxReportsPerHour, minSamples: saved.minSamples, updatedAt: saved.updatedAt } };
  });

  /** everything the card's tab shows: settings, monitors with their latest report, explainability artefacts */
  app.get("/v1/mrm/cards/:id/drift", async (req, reply) => {
    const { id } = cardParam.parse(req.params);
    const [card] = await db.select({ id: modelCards.id }).from(modelCards).where(eq(modelCards.id, id));
    if (!card) return reply.status(404).send({ error: "unknown_model_card" });
    const monitors = await db.select().from(modelDriftMonitors).where(eq(modelDriftMonitors.cardId, id)).orderBy(modelDriftMonitors.name);
    const latest = await latestReports(db, monitors.map((m) => m.id));
    const artefacts = await db
      .select()
      .from(modelExplainabilityArtefacts)
      .where(eq(modelExplainabilityArtefacts.cardId, id))
      .orderBy(desc(modelExplainabilityArtefacts.createdAt))
      .limit(50);
    return {
      settings: await loadDriftSettings(db),
      strictThresholds: STRICT_DRIFT_THRESHOLDS,
      monitors: monitors.map((m) => monitorView(m, latest.get(m.id))),
      artefacts: artefacts.map((a) => ({
        id: a.id,
        kind: a.kind,
        method: a.method,
        importances: a.importances,
        featureCount: a.featureCount,
        payloadSha256: a.payloadSha256,
        note: a.note,
        createdAt: a.createdAt,
      })),
    };
  });

  app.post("/v1/mrm/cards/:id/drift-monitors", { bodyLimit: INGEST_BODY_LIMIT }, async (req, reply) => {
    const { id } = cardParam.parse(req.params);
    const body = createMonitorBody.parse(req.body);
    if (!(await loadDriftSettings(db)).enabled) return reply.status(409).send(DISABLED);
    const [card] = await db.select({ id: modelCards.id }).from(modelCards).where(eq(modelCards.id, id));
    if (!card) return reply.status(404).send({ error: "unknown_model_card" });
    const pii = personalDataRefusal([body.name, ...featureTexts(body.reference)]);
    if (pii) return reply.status(422).send(pii);
    const thresholds: DriftThresholds = { ...STRICT_DRIFT_THRESHOLDS, ...body.thresholds };
    const order = thresholdOrderRefusal(thresholds);
    if (order) return reply.status(422).send(order);
    const relaxed = relaxedThresholds(thresholds, STRICT_DRIFT_THRESHOLDS);
    if (Object.keys(relaxed).length > 0 && !(await stepUp(db, req, reply, { modelDriftCardId: id, values: relaxed }))) return reply;
    const sha = payloadSha256(body.reference);
    const userId = req.authCtx.userId ?? null;
    try {
      const row = await db.transaction(async (tx) => {
        const [m] = await tx
          .insert(modelDriftMonitors)
          .values({
            cardId: id,
            name: body.name,
            reference: body.reference,
            referenceSha256: sha,
            featureCount: body.reference.length,
            referenceSamples: referenceSamples(body.reference),
            ...thresholds,
            createdBy: userId,
          })
          .returning();
        await tx.insert(auditLog).values({
          userId: userId ?? NO_IDENTITY,
          objectType: "model_card",
          objectId: id,
          detail: { phase: "drift-monitor", action: "created", monitorId: m!.id, referenceSha256: sha, featureCount: body.reference.length, thresholds, relaxed: Object.keys(relaxed) },
          effect: "allow",
          ruleId: MODEL_DRIFT_AUDIT_RULE_IDS.monitorCreated,
          ruleChain: [],
          reason: `a drift monitor with a reference distribution of ${body.reference.length} feature(s) was registered on this model card`,
        });
        return m!;
      });
      return reply.status(201).send({ monitor: monitorView(row, undefined) });
    } catch (e) {
      if (isUniqueViolation(e, "model_drift_monitors_card_name_uq")) {
        return reply.status(409).send({ error: "monitor_name_taken", detail: "this model card already has a drift monitor with that name" });
      }
      throw e;
    }
  });

  app.patch("/v1/model-drift/monitors/:monitorId", async (req, reply) => {
    const { monitorId } = monitorParam.parse(req.params);
    const body = z.object({ thresholds: thresholdsSchema }).strict().parse(req.body);
    const [m] = await db.select().from(modelDriftMonitors).where(eq(modelDriftMonitors.id, monitorId));
    if (!m) return reply.status(404).send({ error: "unknown_drift_monitor" });
    const current = thresholdsOf(m);
    const next: DriftThresholds = { ...current, ...body.thresholds };
    const order = thresholdOrderRefusal(next);
    if (order) return reply.status(422).send(order);
    const relaxed = relaxedThresholds(next, current);
    if (Object.keys(relaxed).length > 0 && !(await stepUp(db, req, reply, { modelDriftMonitorId: monitorId, values: relaxed }))) return reply;
    const userId = req.authCtx.userId ?? null;
    const row = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(modelDriftMonitors)
        .set({ ...next, updatedAt: sql`now()` })
        .where(eq(modelDriftMonitors.id, monitorId))
        .returning();
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "model_card",
        objectId: m.cardId,
        detail: { phase: "drift-monitor", action: "thresholds-changed", monitorId, from: current, to: next, relaxed: Object.keys(relaxed) },
        effect: Object.keys(relaxed).length > 0 ? "deny" : "allow",
        ruleId: MODEL_DRIFT_AUDIT_RULE_IDS.monitorUpdated,
        ruleChain: [],
        reason: `drift thresholds changed on monitor '${m.name}'${Object.keys(relaxed).length > 0 ? " (relaxed)" : ""}`,
      });
      return updated;
    });
    if (!row) return reply.status(404).send({ error: "unknown_drift_monitor" });
    return { monitor: monitorView(row, (await latestReports(db, [row.id])).get(row.id)) };
  });

  /** removes the monitor and every report recorded against it: evidence removal, so a step-up */
  app.delete("/v1/model-drift/monitors/:monitorId", async (req, reply) => {
    const { monitorId } = monitorParam.parse(req.params);
    const [m] = await db.select().from(modelDriftMonitors).where(eq(modelDriftMonitors.id, monitorId));
    if (!m) return reply.status(404).send({ error: "unknown_drift_monitor" });
    if (!(await stepUp(db, req, reply, { modelDriftMonitorId: monitorId, values: { deleted: true } }))) return reply;
    await db.transaction(async (tx) => {
      const [{ reports } = { reports: 0 }] = await tx
        .select({ reports: sql<number>`count(*)::int` })
        .from(modelDriftReports)
        .where(eq(modelDriftReports.monitorId, monitorId));
      await tx.delete(modelDriftMonitors).where(eq(modelDriftMonitors.id, monitorId));
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "model_card",
        objectId: m.cardId,
        detail: { phase: "drift-monitor", action: "deleted", monitorId, referenceSha256: m.referenceSha256, reportsRemoved: reports },
        effect: "deny",
        ruleId: MODEL_DRIFT_AUDIT_RULE_IDS.monitorDeleted,
        ruleChain: [],
        reason: `drift monitor '${m.name}' and its ${reports} report(s) were deleted`,
      });
    });
    return { deleted: true };
  });

  app.post("/v1/model-drift/monitors/:monitorId/reports", { bodyLimit: INGEST_BODY_LIMIT }, async (req, reply) => {
    const { monitorId } = monitorParam.parse(req.params);
    const body = reportBody.parse(req.body);
    const settings = await loadDriftSettings(db);
    if (!settings.enabled) return reply.status(409).send(DISABLED);
    const [m] = await db
      .select({ monitor: modelDriftMonitors, agentId: modelCards.agentId })
      .from(modelDriftMonitors)
      .innerJoin(modelCards, eq(modelCards.id, modelDriftMonitors.cardId))
      .where(eq(modelDriftMonitors.id, monitorId));
    if (!m) return reply.status(404).send({ error: "unknown_drift_monitor" });
    const windowStart = new Date(body.windowStart);
    const windowEnd = new Date(body.windowEnd);
    if (!(windowEnd > windowStart)) return reply.status(422).send({ error: "window_invalid", detail: "the window must end after it starts" });
    const pii = personalDataRefusal(featureTexts(body.features));
    if (pii) return reply.status(422).send(pii);
    let computed: ReturnType<typeof computeDrift>;
    try {
      computed = computeDrift(m.monitor.reference as DriftFeature[], body.features, thresholdsOf(m.monitor), settings.minSamples);
    } catch (e) {
      if (e instanceof DriftShapeError) return reply.status(422).send({ error: e.code, feature: e.feature, detail: e.message });
      throw e;
    }
    const sha = payloadSha256(body.features);
    const userId = req.authCtx.userId ?? null;
    const card = { id: m.monitor.cardId, agentId: m.agentId };
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // one count per monitor across replicas: the lock serialises concurrent submissions to the same monitor
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"model-drift:" + monitorId}))`);
      const now = await databaseNow(tx);
      if (windowEnd.getTime() > now.getTime() + WINDOW_SKEW_MS) return { refused: "window_future" as const };
      const [{ recent } = { recent: 0 }] = await tx
        .select({ recent: sql<number>`count(*)::int` })
        .from(modelDriftReports)
        .where(and(eq(modelDriftReports.monitorId, monitorId), sql`${modelDriftReports.createdAt} > now() - interval '1 hour'`));
      if (recent >= settings.maxReportsPerHour) return { refused: "rate" as const };
      const [report] = await tx
        .insert(modelDriftReports)
        .values({
          monitorId,
          source: body.source,
          windowStart,
          windowEnd,
          sampleCount: computed.sampleCount,
          summary: body.features,
          summarySha256: sha,
          results: computed.results,
          status: computed.status,
          driftedFeatures: computed.driftedFeatures,
          submittedBy: userId,
        })
        .returning();
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "model_card",
        objectId: card.id,
        detail: {
          phase: "drift-report",
          monitorId,
          reportId: report!.id,
          source: body.source,
          summarySha256: sha,
          referenceSha256: m.monitor.referenceSha256,
          status: computed.status,
          driftedFeatures: computed.driftedFeatures,
          sampleCount: computed.sampleCount,
        },
        effect: computed.status === "drift" ? "deny" : "allow",
        ruleId: MODEL_DRIFT_AUDIT_RULE_IDS.report,
        ruleChain: [],
        reason: `a production summary was checked against drift monitor '${m.monitor.name}': ${computed.status}`,
      });
      let raisedId: string | null = null;
      if (computed.status === "drift") {
        const finding = driftFinding(card, m.monitor, { id: report!.id, driftedFeatures: computed.driftedFeatures, results: computed.results });
        const ownership = await alertOwnershipAtRaise(tx, finding, now);
        const [inserted] = await tx
          .insert(governanceAlerts)
          .values({
            ruleId: finding.ruleId,
            subjectKey: finding.subjectKey,
            severity: finding.severity,
            title: finding.title,
            detail: finding.detail,
            firstDetectedAt: now,
            lastDetectedAt: now,
            ownerUserId: ownership.ownerUserId,
            ownerSource: ownership.ownerSource,
            dueAt: ownership.dueAt,
          })
          .onConflictDoNothing()
          .returning({ id: governanceAlerts.id });
        if (inserted) {
          raisedId = inserted.id;
          await tx.insert(auditLog).values({
            userId: userId ?? NO_IDENTITY,
            objectType: "governance_alert",
            objectId: inserted.id,
            detail: { ruleId: finding.ruleId, subjectKey: finding.subjectKey, severity: finding.severity },
            effect: "allow",
            ruleId: ALERT_RAISED_RULE_ID,
            ruleChain: [],
            reason: `governance alert raised (${finding.severity}): ${finding.title}`,
          });
        } else {
          await tx
            .update(governanceAlerts)
            .set({ lastDetectedAt: now, title: finding.title, detail: finding.detail })
            .where(and(eq(governanceAlerts.ruleId, finding.ruleId), eq(governanceAlerts.subjectKey, finding.subjectKey), ne(governanceAlerts.status, "resolved")));
        }
      }
      return { report: report!, raisedId };
    });
    if ("refused" in outcome) {
      return outcome.refused === "rate"
        ? reply.status(429).send({
            error: "drift_report_rate_limited",
            detail: `this monitor accepts at most ${settings.maxReportsPerHour} summaries an hour; try again later`,
          })
        : reply.status(422).send({ error: "window_future", detail: "the window ends in the future" });
    }
    if (outcome.raisedId) await notifyGovernanceAlerts(db, [outcome.raisedId], userId).catch((err: unknown) => req.log.warn({ err }, "drift alert chat notification failed"));
    return reply.status(201).send({ report: reportView(outcome.report), alertRaised: outcome.raisedId !== null });
  });

  app.get("/v1/model-drift/monitors/:monitorId/reports", async (req, reply) => {
    const { monitorId } = monitorParam.parse(req.params);
    const q = listQuery.parse(req.query);
    const [m] = await db.select({ id: modelDriftMonitors.id }).from(modelDriftMonitors).where(eq(modelDriftMonitors.id, monitorId));
    if (!m) return reply.status(404).send({ error: "unknown_drift_monitor" });
    const rows = await db
      .select()
      .from(modelDriftReports)
      .where(and(eq(modelDriftReports.monitorId, monitorId), q.before ? lt(modelDriftReports.createdAt, new Date(q.before)) : undefined))
      .orderBy(desc(modelDriftReports.createdAt), desc(modelDriftReports.id))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    return {
      reports: page.map(reportView),
      nextBefore: rows.length > q.limit ? page[page.length - 1]!.createdAt.toISOString() : null,
    };
  });

  app.post("/v1/mrm/cards/:id/explainability", { bodyLimit: INGEST_BODY_LIMIT }, async (req, reply) => {
    const { id } = cardParam.parse(req.params);
    const body = explainabilitySchema.parse(req.body);
    if (!(await loadDriftSettings(db)).enabled) return reply.status(409).send(DISABLED);
    const [card] = await db.select({ id: modelCards.id }).from(modelCards).where(eq(modelCards.id, id));
    if (!card) return reply.status(404).send({ error: "unknown_model_card" });
    const pii = personalDataRefusal([body.method, ...body.importances.map((x) => x.feature), ...(body.note ? [body.note] : [])]);
    if (pii) return reply.status(422).send(pii);
    const sha = payloadSha256({ kind: body.kind, method: body.method, importances: body.importances });
    const userId = req.authCtx.userId ?? null;
    const row = await db.transaction(async (tx) => {
      const [a] = await tx
        .insert(modelExplainabilityArtefacts)
        .values({
          cardId: id,
          kind: body.kind,
          method: body.method,
          importances: body.importances,
          featureCount: body.importances.length,
          payloadSha256: sha,
          note: body.note ?? null,
          submittedBy: userId,
        })
        .returning();
      await tx.insert(auditLog).values({
        userId: userId ?? NO_IDENTITY,
        objectType: "model_card",
        objectId: id,
        detail: { phase: "explainability", action: "recorded", artefactId: a!.id, kind: body.kind, payloadSha256: sha, featureCount: body.importances.length },
        effect: "allow",
        ruleId: MODEL_DRIFT_AUDIT_RULE_IDS.artefact,
        ruleChain: [],
        reason: `an explainability artefact (${body.kind === "shap_summary" ? "SHAP summary" : "global feature importance"}) supplied by the customer's pipeline was recorded as evidence on this model card`,
      });
      return a!;
    });
    return reply.status(201).send({ artefact: { id: row.id, kind: row.kind, method: row.method, featureCount: row.featureCount, payloadSha256: row.payloadSha256, createdAt: row.createdAt } });
  });

  app.delete("/v1/mrm/cards/:id/explainability/:artefactId", async (req, reply) => {
    const { id, artefactId } = artefactParam.parse(req.params);
    const [a] = await db
      .select()
      .from(modelExplainabilityArtefacts)
      .where(and(eq(modelExplainabilityArtefacts.id, artefactId), eq(modelExplainabilityArtefacts.cardId, id)));
    if (!a) return reply.status(404).send({ error: "unknown_explainability_artefact" });
    if (!(await stepUp(db, req, reply, { modelExplainabilityArtefactId: artefactId, values: { deleted: true } }))) return reply;
    await db.transaction(async (tx) => {
      await tx.delete(modelExplainabilityArtefacts).where(eq(modelExplainabilityArtefacts.id, artefactId));
      await tx.insert(auditLog).values({
        userId: req.authCtx.userId ?? NO_IDENTITY,
        objectType: "model_card",
        objectId: id,
        detail: { phase: "explainability", action: "deleted", artefactId, payloadSha256: a.payloadSha256 },
        effect: "deny",
        ruleId: MODEL_DRIFT_AUDIT_RULE_IDS.artefactDeleted,
        ruleChain: [],
        reason: "an explainability artefact was removed from this model card",
      });
    });
    return { deleted: true };
  });
}
