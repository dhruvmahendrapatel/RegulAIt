/**
 * ADR-0189 (batch 6 item 2) — the Decision BOM and AI BOM routes. Every route
 * §9 names is registered here. Slice B1 made each a 501 stub; slice B3 builds
 * the AI BOM snapshot list and drift routes, and the snapshot freeze behind a
 * code switch. The route list is `BOM_ROUTES` in `@regulait/shared`
 * (`bom/contract.ts`); `zz-adr0189-b1-foundation.test.ts` pins that this file
 * registers exactly that list.
 *
 * Every route is ADMIN-ONLY at the route-class layer (none is in
 * `NON_ADMIN_ROUTES`). §9 also admits holders of an explicit auditor grant when
 * `bom_export_roles` is relaxed; that in-handler check lands with B4, and only
 * then may a route move to `NON_ADMIN_ROUTES` (strict until then).
 *
 *   POST /v1/ai-bom/:subjectKind/:subjectId/snapshots   freeze and sign (B3; 501 bom_snapshots_not_released until R17)
 *   GET  /v1/ai-bom/:subjectKind/:subjectId/snapshots   the subject's snapshot list (B3; the B6 tab)
 *   GET  /v1/ai-bom/:subjectKind/:subjectId/drift       change list, `evidence: false` (B3, R8)
 *   GET  /v1/ai-bom/snapshots/:snapshotId               signed snapshot, by format, as a bundle (B4, R7)
 *   GET  /v1/ai-bom/snapshots/:snapshotId/bundle        export-bundle/3 (B4)
 *   GET  /v1/decisions/:auditId/bom                     the signed Decision BOM (B4)
 *   GET  /v1/decisions/:auditId/bom/bundle              export-bundle/3 (B4)
 *   POST /v1/boms/verify                                the pure verifier, online (B4, R6)
 *
 * The B3 routes are audited (who read what) and rate-limited per person by
 * `bom_export_rate_limit_per_minute` (strict default 30) in the shared counter
 * table, so N replicas do not admit N times the limit.
 *
 * Written out literally (not looped over BOM_ROUTES) so the affordance census
 * (`scripts/preflight-ui-affordances.mjs`) sees every route.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auditLog, type Db } from "@regulait/db";
import { AI_BOM_INSTALL_SUBJECT_ID, AI_BOM_SUBJECT_KINDS, AiBomBuildError, AiBomRecordError, BOM_NOT_BUILT, TrainingChecksumError, type AiBomSubjectKind } from "@regulait/shared";
import { AI_BOM_SNAPSHOTS_RELEASED, AiBomError, aiBomDrift, listAiBomSnapshots, loadAiBomSettings, takeAiBomSnapshot, type AiBomSubject } from "./ai-bom.js";
import { SharedRateLimitStore } from "./rate-limit-store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BOOT_USER = "00000000-0000-0000-0000-000000000000";

/** the B3 routes' own refusals (B1's `BOM_ERROR_CODES` holds the shared ones) */
export const AI_BOM_ROUTE_ERRORS = ["invalid_ai_bom_subject", "ai_bom_subject_not_found", "ai_bom_no_snapshot", "ai_bom_build_refused", "ai_bom_too_large", "bom_snapshot_busy", "rate_limited"] as const;

function subjectOf(req: FastifyRequest): AiBomSubject | null {
  const p = req.params as { subjectKind?: string; subjectId?: string };
  const kind = p.subjectKind as AiBomSubjectKind;
  const id = String(p.subjectId ?? "").toLowerCase();
  if (!(AI_BOM_SUBJECT_KINDS as readonly string[]).includes(kind) || !UUID.test(id)) return null;
  // R20: the install subject is the nil key, and only that
  if ((kind === "install") !== (id === AI_BOM_INSTALL_SUBJECT_ID)) return null;
  return { kind, id };
}

const installId = (): string | null => {
  const v = process.env.REGULAIT_INSTALL_ID?.trim();
  return v ? v : null;
};

export function registerBomRoutes(app: FastifyInstance, db: Db): void {
  const notBuilt = async (_req: unknown, reply: FastifyReply) => reply.status(501).send(BOM_NOT_BUILT);
  const limiter = new SharedRateLimitStore(db);

  /** per-person export limit (§7); fail-open on a counter outage exactly as the global tier does */
  const rateLimited = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    const max = (await loadAiBomSettings(db)).rateLimitPerMinute;
    const verdict = await new Promise<{ current: number; ttl: number }>((resolve) =>
      limiter.incr(`bom-export:${req.authCtx.userId ?? BOOT_USER}`, (_e, r) => resolve(r ?? { current: 0, ttl: 0 }), 60_000, max),
    );
    if (verdict.current <= max) return false;
    const retry = Math.max(1, Math.ceil(verdict.ttl / 1000));
    await reply.status(429).header("retry-after", String(retry)).send({ error: "rate_limited", detail: `too many BOM requests — limit ${max} per 60s`, retryAfterSeconds: retry });
    return true;
  };

  const audit = (req: FastifyRequest, ruleId: string, reason: string, objectId: string | null, detail: Record<string, unknown>) =>
    db.insert(auditLog).values({ userId: req.authCtx.userId ?? BOOT_USER, objectType: "audit_export", objectId, effect: "allow", ruleId, ruleChain: [], reason, detail });

  const refuse = (reply: FastifyReply, e: unknown) => {
    if (e instanceof AiBomError) return reply.status(e.status).send({ error: e.code, detail: e.message });
    if (e instanceof AiBomBuildError || e instanceof AiBomRecordError || e instanceof TrainingChecksumError) {
      // fail closed and say which field and rule (an email shape, userinfo, an unsafe value); the
      // messages name fields and rules only and never echo a record value (PR #287)
      return reply.status(422).send({ error: "ai_bom_build_refused", detail: e.message });
    }
    throw e;
  };

  app.post("/v1/ai-bom/:subjectKind/:subjectId/snapshots", async (req, reply) => {
    // R2 / R17: disabled IN CODE until every v1 renderer and export-bundle/3 exist (B4 and B5)
    if (!AI_BOM_SNAPSHOTS_RELEASED) return reply.status(501).send({ error: "bom_snapshots_not_released", detail: "AI BOM snapshots are enabled once the SPDX renderer (B5) and export bundles (B4) have shipped." });
    const subject = subjectOf(req);
    if (!subject) return reply.status(400).send({ error: "invalid_ai_bom_subject" });
    if (await rateLimited(req, reply)) return reply;
    try {
      const taken = await takeAiBomSnapshot(db, { subject, trigger: "on_demand", actorUserId: req.authCtx.userId ?? null, installId: installId() });
      return reply.status(201).send({ id: taken.id, version: taken.version, serialNumber: taken.serialNumber, bodySha256: taken.bodySha256 });
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.get("/v1/ai-bom/:subjectKind/:subjectId/snapshots", async (req, reply) => {
    const subject = subjectOf(req);
    if (!subject) return reply.status(400).send({ error: "invalid_ai_bom_subject" });
    if (await rateLimited(req, reply)) return reply;
    const snapshots = await listAiBomSnapshots(db, subject);
    await audit(req, "ai-bom-snapshots-listed", "AI BOM snapshot list read", null, { subjectKind: subject.kind, subjectId: subject.id, rows: snapshots.length });
    return { subject, released: AI_BOM_SNAPSHOTS_RELEASED, snapshots };
  });

  app.get("/v1/ai-bom/:subjectKind/:subjectId/drift", async (req, reply) => {
    const subject = subjectOf(req);
    if (!subject) return reply.status(400).send({ error: "invalid_ai_bom_subject" });
    if (await rateLimited(req, reply)) return reply;
    try {
      const drift = await aiBomDrift(db, subject, installId());
      await audit(req, "ai-bom-drift-viewed", "AI BOM drift viewed", drift.baseline.snapshotId, { subjectKind: subject.kind, subjectId: subject.id, changes: drift.changes.length });
      return drift;
    } catch (e) {
      return refuse(reply, e);
    }
  });

  app.get("/v1/ai-bom/snapshots/:snapshotId", notBuilt);
  app.get("/v1/ai-bom/snapshots/:snapshotId/bundle", notBuilt);
  app.get("/v1/decisions/:auditId/bom", notBuilt);
  app.get("/v1/decisions/:auditId/bom/bundle", notBuilt);
  app.post("/v1/boms/verify", notBuilt);
}
