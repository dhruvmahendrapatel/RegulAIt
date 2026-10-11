/**
 * ADR-0189 (batch 6 item 2) — the Decision BOM and AI BOM routes. Every route
 * §9 names is registered here. Slice B1 made each a 501 stub; slice B3 builds
 * the AI BOM snapshot list and drift routes, and the snapshot freeze behind a
 * code switch. The route list is `BOM_ROUTES` in `@regulait/shared`
 * (`bom/contract.ts`); `zz-adr0189-b1-foundation.test.ts` pins that this file
 * registers exactly that list.
 *
 * The B3 routes are ADMIN-ONLY at the route-class layer. Slice B4's five
 * routes are in `NON_ADMIN_ROUTES` and gated IN THE HANDLER by
 * `bom_export_roles` (§7, §9; `bom-export.ts`): admins, or an explicit auditor
 * grant while an admin has relaxed the setting; 403 `bom_export_forbidden` for
 * anyone else.
 *
 * R17 (the master's ruling on #344): `AI_BOM_SNAPSHOTS_RELEASED` stays false in
 * B4 and is flipped in its own PR right after #344 merges. Until then the
 * snapshot freeze AND the two snapshot DOWNLOAD routes answer 501
 * `bom_snapshots_not_released` (after the role check). The online verifier may
 * still verify a stored snapshot: verifying needs no release.
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
 * Every route is audited (who read, exported or verified what) and rate-limited per person by
 * `bom_export_rate_limit_per_minute` (strict default 30) in the shared counter
 * table, so N replicas do not admit N times the limit.
 *
 * Written out literally (not looped over BOM_ROUTES) so the affordance census
 * (`scripts/preflight-ui-affordances.mjs`) sees every route.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { aiBomSnapshots, and, auditLog, bomRenderings, eq, sql, type Db } from "@regulait/db";
import {
  AI_BOM_DOWNLOAD_FORMATS,
  AI_BOM_INSTALL_SUBJECT_ID,
  AI_BOM_SUBJECT_KINDS,
  aiBomSnapshotFormatQuerySchema,
  aiBomSnapshotParamsSchema,
  AiBomBuildError,
  AiBomRecordError,
  BOM_VERIFY_MAX_BUNDLE_BYTES,
  BOM_VERIFY_MAX_REQUEST_BYTES,
  BomExportRefusal,
  bomVerifyRequestSchema,
  buildAiBomBundle,
  buildDecisionBomBundle,
  decisionBomBundleHref,
  decisionBomParamsSchema,
  decisionBomReadQuerySchema,
  EXPORT_BUNDLE_V3_SCHEMA,
  reportedFinality,
  TrainingChecksumError,
  verifyBomBundle,
  verifyStoredAiBom,
  verifyStoredDecisionBom,
  type AiBomDownloadFormat,
  type AiBomSubjectKind,
  type BomVerifyReport,
} from "@regulait/shared";
import { AI_BOM_SNAPSHOTS_RELEASED, AiBomError, aiBomDrift, listAiBomSnapshots, loadAiBomSettings, takeAiBomSnapshot, type AiBomSubject } from "./ai-bom.js";
import { SharedRateLimitStore } from "./rate-limit-store.js";
import { bomAccessOf, bomBundleEnvelope, bomCapabilitiesOf, onlineBomTrust, sendBomBundle, type BomAccess } from "./bom-export.js";
import { BomRouteError, freezeDecisionBom, listDecisionBomVersions, readDecisionBomVersion, type DecisionBomRow } from "./decision-bom.js";

const rowsOf = <T>(r: unknown): T[] => (r as { rows?: T[] }).rows ?? [];

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

/**
 * R17: the downloads follow `AI_BOM_SNAPSHOTS_RELEASED`. A test may open them for its own app (the switch itself is a
 * code constant and is never changed by a test); production code never calls this.
 */
let downloadsReleasedForTest = false;
export function releaseAiBomDownloadsForTest(on: boolean): void {
  downloadsReleasedForTest = on;
}
const aiBomDownloadsReleased = (): boolean => AI_BOM_SNAPSHOTS_RELEASED || downloadsReleasedForTest;

export function registerBomRoutes(app: FastifyInstance, db: Db): void {
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

  // -------------------------------------------------------------------------
  // slice B4: the Decision BOM and AI BOM reads, bundles and the online verifier
  // -------------------------------------------------------------------------

  /** §7 / §9: the in-handler role check (admins, or an auditor grant while relaxed), then the per-person limit */
  const gate = async (req: FastifyRequest, reply: FastifyReply): Promise<BomAccess | null> => {
    const access = await bomAccessOf(db, req);
    if (!access) {
      await reply.status(403).send({ error: "bom_export_forbidden", detail: "BOM export is limited to admins (and, while bom_export_roles allows it, explicit auditor grants)." });
      return null;
    }
    if (await rateLimited(req, reply)) return null;
    return access;
  };
  const b4Refuse = (reply: FastifyReply, e: unknown) => {
    if (e instanceof BomRouteError) {
      if (e.retryAfterSeconds) reply.header("retry-after", String(e.retryAfterSeconds));
      return reply.status(e.status).send(e.body);
    }
    if (e instanceof BomExportRefusal) return reply.status(422).send({ error: "bom_export_refused", reason: "email_shape", file: e.file, path: e.path.slice(0, 1024) });
    throw e;
  };
  const actorOf = (req: FastifyRequest) => req.authCtx.userId ?? BOOT_USER;
  const dbNow = async () => new Date((rowsOf<{ now: Date | string }>(await db.execute(sql`select now() as "now"`))[0]!).now);
  const reportedOf = (row: DecisionBomRow, now: Date) => {
    const anchor = (JSON.parse(row.body) as { proof: { anchor: { retainUntil: string | null } | null } }).proof.anchor;
    return reportedFinality(row.finality, anchor?.retainUntil ? new Date(anchor.retainUntil) : null, now);
  };
  /** the newest version (assembling and freezing one when the facts support it), or a named frozen version */
  const decisionBomFor = async (auditId: string, version: number | undefined, actor: string | null): Promise<DecisionBomRow> => {
    if (version === undefined) return (await freezeDecisionBom(db, auditId, actor)).row;
    const row = await readDecisionBomVersion(db, auditId, version);
    if (!row) throw new BomRouteError(404, { error: "bom_version_not_found" });
    return row;
  };
  const linkedSnapshotOf = async (row: DecisionBomRow) => {
    if (!row.aiBomSnapshotId) return null;
    const [s] = await db.select().from(aiBomSnapshots).where(eq(aiBomSnapshots.id, row.aiBomSnapshotId));
    return s ? { body: s.body, bodySha256: s.bodySha256, signature: s.signature, keyId: s.keyId } : null;
  };
  const b4Params = <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T | null => {
    const r = schema.safeParse(value);
    return r.success ? r.data : null;
  };

  app.get("/v1/decisions/:auditId/bom", async (req, reply) => {
    // the role check comes first: a refused caller learns nothing, not even whether its input was well formed
    const access = await gate(req, reply);
    if (!access) return reply;
    const params = b4Params(decisionBomParamsSchema, req.params);
    if (!params) return reply.status(400).send({ error: "invalid_audit_id" });
    const query = b4Params(decisionBomReadQuerySchema, req.query);
    if (!query) return reply.status(400).send({ error: "invalid_bom_version" });
    try {
      const row = await decisionBomFor(params.auditId, query.version, req.authCtx.userId ?? null);
      const versions = await listDecisionBomVersions(db, params.auditId);
      const renderings = await db.select({ format: bomRenderings.format }).from(bomRenderings).where(eq(bomRenderings.decisionBomId, row.id));
      await audit(req, "decision-bom-read", "Decision BOM read", params.auditId, { bomId: row.id, version: row.version, finality: row.finality });
      const summary = (v: DecisionBomRow) => ({ id: v.id, version: v.version, supersedes: v.supersedesId, finality: v.finality, bodySha256: v.bodySha256, keyId: v.keyId, createdAt: v.createdAt.toISOString() });
      return {
        auditId: params.auditId,
        bom: { ...summary(row), body: row.body, signature: row.signature, aiBomSnapshotId: row.aiBomSnapshotId, reportedFinality: reportedOf(row, await dbNow()) },
        document: JSON.parse(row.body) as unknown,
        versions: versions.map(summary),
        renderings: renderings.map((r) => r.format),
        bundle: { schema: EXPORT_BUNDLE_V3_SCHEMA, subject: "decision-bom", href: decisionBomBundleHref(params.auditId, row.version) },
        capabilities: bomCapabilitiesOf(access),
      };
    } catch (e) {
      return b4Refuse(reply, e);
    }
  });

  app.get("/v1/decisions/:auditId/bom/bundle", async (req, reply) => {
    if (!(await gate(req, reply))) return reply;
    const params = b4Params(decisionBomParamsSchema, req.params);
    if (!params) return reply.status(400).send({ error: "invalid_audit_id" });
    const query = b4Params(decisionBomReadQuerySchema, req.query);
    if (!query) return reply.status(400).send({ error: "invalid_bom_version" });
    try {
      // R6: building a new bundle needs the export key; checked before anything is frozen
      const env = await bomBundleEnvelope(db, actorOf(req));
      const row = await decisionBomFor(params.auditId, query.version, req.authCtx.userId ?? null);
      const renderings = await db.select({ format: bomRenderings.format, bytes: bomRenderings.bytes }).from(bomRenderings).where(eq(bomRenderings.decisionBomId, row.id));
      const built = buildDecisionBomBundle({ row: { ...row, finality: row.finality }, linkedAiBom: await linkedSnapshotOf(row), renderings }, env);
      await audit(req, "decision-bom-exported", "Decision BOM bundle exported", params.auditId, { bomId: row.id, version: row.version, manifestSha256: built.manifestSha256 });
      return sendBomBundle(reply, built, "decision-bom", env.exportKey);
    } catch (e) {
      return b4Refuse(reply, e);
    }
  });

  /** one snapshot, as a bundle of the native body and one format (or every rendered format) */
  const aiBomBundleRoute = async (req: FastifyRequest, reply: FastifyReply, request: { kind: "format"; format: AiBomDownloadFormat } | { kind: "bundle" }) => {
    // R17: disabled IN CODE until the release switch flips (its own PR, after B4)
    if (!aiBomDownloadsReleased()) {
      return reply.status(501).send({ error: "bom_snapshots_not_released", detail: "AI BOM snapshot downloads are enabled with the AI BOM snapshot release (ADR-0189 R17)." });
    }
    const params = b4Params(aiBomSnapshotParamsSchema, req.params);
    if (!params) return reply.status(400).send({ error: "invalid_bom_snapshot_id" });
    try {
      const [snap] = await db.select().from(aiBomSnapshots).where(eq(aiBomSnapshots.id, params.snapshotId));
      if (!snap) return reply.status(404).send({ error: "ai_bom_snapshot_not_found" });
      const renderings = await db.select({ format: bomRenderings.format, bytes: bomRenderings.bytes }).from(bomRenderings).where(eq(bomRenderings.aiBomSnapshotId, snap.id));
      const commitments = (JSON.parse(snap.body) as { renderings: Record<string, { status?: string }> }).renderings;
      const available = AI_BOM_DOWNLOAD_FORMATS.filter((f) => f === "native" || (commitments[f]?.status === "rendered" && renderings.some((r) => r.format === f)));
      if (request.kind === "format" && !available.includes(request.format)) {
        // R2: a format not rendered for this snapshot is never produced afterwards
        return reply.status(404).send({ error: "format_not_rendered_for_snapshot", formats: available });
      }
      const env = await bomBundleEnvelope(db, actorOf(req));
      const built = buildAiBomBundle({ row: snap, renderings, request }, env);
      await audit(req, "ai-bom-exported", "AI BOM snapshot bundle exported", snap.id, { format: request.kind === "bundle" ? "bundle" : request.format, manifestSha256: built.manifestSha256 });
      return sendBomBundle(reply, built, "ai-bom", env.exportKey);
    } catch (e) {
      return b4Refuse(reply, e);
    }
  };
  app.get("/v1/ai-bom/snapshots/:snapshotId", async (req, reply) => {
    if (!(await gate(req, reply))) return reply;
    const query = b4Params(aiBomSnapshotFormatQuerySchema, req.query);
    if (!query) return reply.status(400).send({ error: "invalid_bom_format" });
    return aiBomBundleRoute(req, reply, { kind: "format", format: query.format });
  });
  app.get("/v1/ai-bom/snapshots/:snapshotId/bundle", async (req, reply) => {
    if (!(await gate(req, reply))) return reply;
    return aiBomBundleRoute(req, reply, { kind: "bundle" });
  });

  // the B4 contract admits an 8 MiB decoded bundle (about 11.2 MiB of base64 in JSON), above Fastify's 1 MiB default:
  // the limit is sized for the largest admitted request, and anything over it is the contract's 413
  app.post(
    "/v1/boms/verify",
    {
      bodyLimit: BOM_VERIFY_MAX_REQUEST_BYTES,
      errorHandler: (err, req, reply) => {
        if ((err as { code?: unknown }).code === "FST_ERR_CTP_BODY_TOO_LARGE") {
          return reply.status(413).send({ error: "bom_bundle_too_large", detail: `a verify request is at most ${BOM_VERIFY_MAX_REQUEST_BYTES} bytes` });
        }
        return app.errorHandler(err, req, reply);
      },
    },
    async (req, reply) => {
      const access = await gate(req, reply);
      if (!access) return reply;
      const parsed = bomVerifyRequestSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: "invalid_bom_verify_request" });
      const body = parsed.data;
      // R6: the server's recorded public keys, its boundary and its TSA trust bundle; no private key is needed
      const trust = await onlineBomTrust(db);
      let report: BomVerifyReport;
      if (body.source === "bundle") {
        const bytes = Buffer.from(body.bundleBase64, "base64");
        if (bytes.length > BOM_VERIFY_MAX_BUNDLE_BYTES) return reply.status(413).send({ error: "bom_bundle_too_large" });
        report = await verifyBomBundle(bytes, trust);
      } else if (body.source === "decision_bom") {
        const row = await readDecisionBomVersion(db, body.auditId, body.version);
        if (!row) return reply.status(404).send({ error: body.version === undefined ? "bom_decision_not_found" : "bom_version_not_found" });
        report = await verifyStoredDecisionBom({ body: row.body, bodySha256: row.bodySha256, signature: row.signature, keyId: row.keyId, linkedAiBom: await linkedSnapshotOf(row) }, trust);
      } else {
        const [snap] = await db.select().from(aiBomSnapshots).where(eq(aiBomSnapshots.id, body.snapshotId));
        if (!snap) return reply.status(404).send({ error: "ai_bom_snapshot_not_found" });
        const renderings = await db.select({ format: bomRenderings.format, bytes: bomRenderings.bytes }).from(bomRenderings).where(eq(bomRenderings.aiBomSnapshotId, snap.id));
        let previous: { id: string } | "pruned" | null = null;
        if (snap.version > 1) {
          const [prev] = await db.select({ id: aiBomSnapshots.id }).from(aiBomSnapshots)
            .where(and(eq(aiBomSnapshots.subjectKind, snap.subjectKind), eq(aiBomSnapshots.subjectId, snap.subjectId), eq(aiBomSnapshots.version, snap.version - 1)));
          previous = prev ? { id: prev.id } : "pruned";
        }
        report = await verifyStoredAiBom({ body: snap.body, bodySha256: snap.bodySha256, signature: snap.signature, keyId: snap.keyId, renderings, previous }, trust);
      }
      const subjectId = report.identity?.subject === "decision-bom" ? report.identity.auditId : report.identity?.subject === "ai-bom" ? report.identity.snapshotId : null;
      await audit(req, "bom-verified", "BOM verified online against the deployment's recorded keys", subjectId, { source: body.source, outcome: report.outcome });
      return { trust: "deployment_registry", source: body.source, ...report, verifiedAt: trust.verificationTime, capabilities: bomCapabilitiesOf(access) };
    },
  );
}
