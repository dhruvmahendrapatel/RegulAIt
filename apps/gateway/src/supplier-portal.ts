/**
 * ADR-0221 (PENDING P4) — THE SUPPLIER PORTAL: the first sign-in surface for someone who is not a platform user.
 *
 * ADR-0084 runs a versioned assessment per vendor and records the vendor's answers as attributed attestations, but a
 * platform user had to type in what the supplier sent. Here the supplier answers directly: an admin grants one
 * supplier contact access to ONE vendor's ONE assessment, the supplier signs in through a single-use link, answers the
 * controls of the applied framework (and, optionally, a custom questionnaire), and attaches evidence files. Nothing a
 * supplier submits reaches the vendor's record on its own: a reviewer accepts each answer into the ADR-0084
 * attestations (through the same `recordVendorAttestation` write the platform route uses, so the questionnaire and
 * active-pack rules hold) or rejects it with a reason.
 *
 * THE TRUST BOUNDARY, IN ORDER OF HOW IT IS ENFORCED
 *  1. The whole surface is behind `org_settings.supplier_portal_enabled`, shipped off. Off, every supplier route
 *     answers the SAME 404 as an unknown path and no grant can be made; turning it off also revokes every live link
 *     and session. Turning it on is a relaxation: a `settings_relax` step-up, audited.
 *  2. The supplier routes are auth-exempt for the PLATFORM hooks (a platform session or key is never read on them)
 *     and authenticate here on the supplier's own cookie only. A supplier session can name nothing but its grant:
 *     every query is keyed by the grant's vendor, assessment instance and framework, never by a request field.
 *  3. Links are 256-bit random tokens stored as sha256, spent on first use, at most 72 hours old, revoked with their
 *     grant. Sessions live at most 8 hours (and never past the grant), end after 30 idle minutes, and are revoked
 *     with their grant. Every refusal of a link is the same body and status, whatever the reason.
 *  4. Mutations need the CSRF header on top of a SameSite=Strict cookie scoped to the supplier API path.
 *  5. Address and per-grant rate limits on every supplier route (the gateway-wide limiter still applies).
 *  6. Uploads: one file per answer, at most 2 MiB, type detected from the BYTES against a five-type allow-list and
 *     matched to the file name's extension, then passed to the scan hook; stored as a data-key envelope and
 *     downloaded only by an admin, as an attachment that the browser may not sniff or render.
 *  7. Granting, re-issuing a link and revoking are admin-only with an `identity_manage` step-up. Every write on
 *     either side is audited in the same transaction as the write.
 *
 * WHAT THIS FILE DOES NOT DO: it sends no email (the admin copies the link to the supplier), it has no scanner of
 * its own (the hook is a seam; without one a file is stored as `not_scanned` and labelled so), and it does not
 * compile supplier answers into the questionnaire artifact (the assessor still submits that).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomBytes } from "node:crypto";
import {
  aiVendors,
  and,
  asc,
  auditLog,
  compliancePackControls,
  compliancePacks,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ORG_SETTINGS_ID,
  orgSettings,
  sql,
  supplierAccess,
  supplierInvitations,
  supplierQuestionnaires,
  supplierSessions,
  supplierSubmissions,
  type AiVendorPackAttestation,
  type Db,
  type SupplierAccessRow,
  type SupplierQuestion,
  type SupplierSubmissionRow,
} from "@regulait/db";
import {
  AI_VENDOR_ATTESTATION_DISCLAIMER,
  createSupplierAccessSchema,
  createSupplierQuestionnaireSchema,
  decideSupplierSubmissionSchema,
  publishSupplierQuestionnaireVersionSchema,
  reissueSupplierInvitationSchema,
  revokeSupplierAccessSchema,
  SUPPLIER_API_PREFIX,
  SUPPLIER_FILE_TYPES,
  SUPPLIER_INVITE_TOKEN_PREFIX,
  SUPPLIER_INVITE_TOKEN_RE,
  SUPPLIER_LINK_REFUSAL,
  SUPPLIER_PORTAL_LIMITS as L,
  SUPPLIER_SESSION_COOKIE,
  SUPPLIER_SESSION_REFUSAL,
  SUPPLIER_SESSION_TOKEN_PREFIX,
  SUPPLIER_SESSION_TOKEN_RE,
  supplierPortalSettingsSchema,
  supplierSessionStartSchema,
  supplierSubmissionSchema,
  type SupplierFileType,
} from "@regulait/shared";
import { z } from "zod";
import { CSRF_HEADER, readCookie, requestIsSecure } from "./auth.js";
import { notFoundBody } from "./compat-core.js";
import { loadOrgSettings } from "./org-settings.js";
import { deploymentBaseUrl } from "./public-url.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { requireStepUp } from "./step-up.js";
import { hashToken } from "./token-hash.js";
import { recordVendorAttestation } from "./vendors.js";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

/**
 * The scan hook (ADR-0221 decision 6): given the bytes and the detected type, answer `clean` or `rejected`. None is
 * configured by default; a file is then stored as `not_scanned` and every view says so.
 */
export type SupplierFileScanner = (bytes: Buffer, type: SupplierFileType) => Promise<"clean" | "rejected">;

export interface SupplierPortalOptions {
  dataKey?: string;
  fileScanner?: SupplierFileScanner;
}

// ---------------------------------------------------------------------------------------------------------------
// file checks: the type comes from the bytes, never from the name or a declared type
// ---------------------------------------------------------------------------------------------------------------

const EXTENSIONS: Record<SupplierFileType, readonly string[]> = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "text/plain": ["txt"],
  "text/csv": ["csv"],
};
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

function startsWith(bytes: Buffer, sig: readonly number[]): boolean {
  return bytes.length >= sig.length && sig.every((b, i) => bytes[i] === b);
}

/** strict UTF-8 with no NUL and no control characters but tab, line feed and carriage return */
function isPlainText(bytes: Buffer): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return false;
  }
  return true;
}

/** the allow-listed type of these bytes given the file name, or null */
export function detectSupplierFileType(bytes: Buffer, fileName: string): SupplierFileType | null {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  let type: SupplierFileType | null = null;
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) type = "application/pdf";
  else if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) type = "image/png";
  else if (startsWith(bytes, [0xff, 0xd8, 0xff])) type = "image/jpeg";
  else if (isPlainText(bytes)) type = ext === "csv" ? "text/csv" : "text/plain";
  if (!type || !EXTENSIONS[type].includes(ext)) return null;
  return type;
}

/** a file name safe to put in a quoted Content-Disposition value */
function dispositionName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._ -]/g, "_").slice(0, 120);
  return safe.length > 0 ? safe : "evidence";
}

// ---------------------------------------------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------------------------------------------

type LinkState = "active" | "used" | "expired" | "revoked";
function accessState(a: SupplierAccessRow, now: Date): "active" | "expired" | "revoked" {
  return a.revokedAt ? "revoked" : a.expiresAt.getTime() <= now.getTime() ? "expired" : "active";
}

function submissionView(s: SupplierSubmissionRow) {
  return {
    id: s.id,
    kind: s.kind,
    controlRef: s.controlRef,
    questionnaireId: s.questionnaireId,
    questionId: s.questionId,
    statement: s.statement,
    file: s.fileName
      ? { name: s.fileName, contentType: s.fileContentType, size: s.fileSize, sha256: s.fileSha256, scanStatus: s.scanStatus }
      : null,
    status: s.status,
    decisionReason: s.decisionReason,
    decidedAt: s.decidedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

function newToken(prefix: string): { token: string; tokenHash: string } {
  const token = prefix + randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return (
    `${SUPPLIER_SESSION_COOKIE}=${token}; Path=${SUPPLIER_API_PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` +
    (secure ? "; Secure" : "")
  );
}

/** a rollback that carries the reply the caller sends */
class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly body: Record<string, unknown>,
  ) {
    super(String(body.error));
  }
}

const vendorParam = z.object({ vendorId: z.string().uuid() });
const accessParam = z.object({ vendorId: z.string().uuid(), accessId: z.string().uuid() });
const submissionParam = z.object({ vendorId: z.string().uuid(), submissionId: z.string().uuid() });
const questionnaireParam = z.object({ questionnaireId: z.string().uuid() });
const downloadQuery = z.object({ acknowledgeUnscanned: z.literal("1").optional() });

/** a Postgres unique violation, however the driver wraps it */
function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return (err?.code ?? err?.cause?.code) === "23505";
}

// ---------------------------------------------------------------------------------------------------------------
// rate limits (the feedback-link pattern: @fastify/rate-limit buckets the gateway already registers)
// ---------------------------------------------------------------------------------------------------------------

type Limiter = (req: FastifyRequest) => Promise<{ isExceeded: boolean; max: number; ttlInSeconds: number; timeWindow: number }>;
const supplierBucket = new WeakMap<FastifyRequest, string>();

function supplierLimiter(app: FastifyInstance) {
  let limiter: Limiter | null = null;
  const limits = (key: string) => (key.startsWith("sp:access:") ? L.perAccessSubmissions : L.perAddress);
  return async (req: FastifyRequest, reply: FastifyReply, bucket: string): Promise<boolean> => {
    // REGULAIT_RATE_LIMIT=off turns every HTTP limiter off at once; these buckets follow it
    if (!app.hasDecorator("createRateLimit")) return false;
    limiter ??= app.createRateLimit({
      keyGenerator: (r: FastifyRequest) => supplierBucket.get(r) ?? `sp:addr:${r.ip}`,
      max: (_r: FastifyRequest, k: string) => limits(k).max,
      timeWindow: (_r: FastifyRequest, k: string) => limits(k).windowMs,
      allowList: () => false,
    }) as unknown as Limiter;
    supplierBucket.set(req, bucket);
    const v = await limiter(req);
    if (!v.isExceeded) return false;
    await reply.status(429).header("retry-after", String(v.ttlInSeconds)).send({
      error: "rate_limited",
      detail: `Too many requests. Try again in ${Math.max(1, Math.ceil(v.ttlInSeconds / 60))} minutes.`,
      retryAfterSeconds: v.ttlInSeconds,
    });
    return true;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------------------------

export function registerSupplierPortalRoutes(app: FastifyInstance, db: Db, opts: SupplierPortalOptions = {}): void {
  const limit = supplierLimiter(app);

  async function audit(
    tx: Db,
    row: { userId: string | null; objectType: "supplier_access" | "supplier_submission" | "supplier_questionnaire" | "org_settings"; objectId: string | null; ruleId: string; reason: string; detail: Record<string, unknown>; effect?: "allow" | "deny" },
  ) {
    await tx.insert(auditLog).values({
      userId: row.userId ?? NO_IDENTITY,
      objectType: row.objectType,
      objectId: row.objectId,
      detail: row.detail,
      effect: row.effect ?? "allow",
      ruleId: row.ruleId,
      ruleChain: [],
      reason: row.reason,
    });
  }

  /** the active pack's controls for a framework (empty when none is active) */
  async function activeControls(framework: string) {
    const [pack] = await db
      .select({ id: compliancePacks.id, version: compliancePacks.version })
      .from(compliancePacks)
      .where(and(eq(compliancePacks.framework, framework), eq(compliancePacks.status, "active")));
    if (!pack) return { pack: null, controls: [] as Array<{ controlRef: string; title: string; description: string | null }> };
    const controls = await db
      .select({
        controlRef: compliancePackControls.controlRef,
        title: compliancePackControls.title,
        description: compliancePackControls.description,
      })
      .from(compliancePackControls)
      .where(eq(compliancePackControls.packId, pack.id))
      .orderBy(asc(compliancePackControls.controlRef));
    return { pack, controls };
  }

  // =============================================================================================================
  // ADMIN SIDE — the default admin gate applies (none of these is in NON_ADMIN_ROUTES)
  // =============================================================================================================

  app.get("/v1/supplier-portal/settings", async () => {
    const settings = await loadOrgSettings(db);
    return {
      enabled: settings.supplierPortalEnabled,
      acceptUnscannedFiles: settings.supplierPortalAcceptUnscannedFiles,
      scannerConfigured: Boolean(opts.fileScanner),
    };
  });

  // Turning the portal ON, or accepting unscanned files, is a relaxation (a settings_relax step-up bound to the new
  // values); turning the portal OFF also revokes every live link and session, so a later re-enable does not wake one.
  app.put("/v1/supplier-portal/settings", async (req, reply) => {
    const body = supplierPortalSettingsSchema.parse(req.body);
    const current = await loadOrgSettings(db);
    const next = {
      enabled: body.enabled ?? current.supplierPortalEnabled,
      acceptUnscannedFiles: body.acceptUnscannedFiles ?? current.supplierPortalAcceptUnscannedFiles,
    };
    const changed: string[] = [];
    if (next.enabled !== current.supplierPortalEnabled) changed.push("supplierPortalEnabled");
    if (next.acceptUnscannedFiles !== current.supplierPortalAcceptUnscannedFiles) changed.push("supplierPortalAcceptUnscannedFiles");
    if (changed.length === 0) return { ...next, changed: false };
    const relaxed = [
      ...(next.enabled && !current.supplierPortalEnabled ? ["supplierPortalEnabled"] : []),
      ...(next.acceptUnscannedFiles && !current.supplierPortalAcceptUnscannedFiles ? ["supplierPortalAcceptUnscannedFiles"] : []),
    ];
    if (relaxed.length > 0) {
      const su = await requireStepUp(db, req, reply, {
        kind: "settings_relax",
        facts: { setting: "supplierPortal", relaxed, enabled: next.enabled, acceptUnscannedFiles: next.acceptUnscannedFiles },
      });
      if (!su.ok) return reply;
    }
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx
        .update(orgSettings)
        .set({ supplierPortalEnabled: next.enabled, supplierPortalAcceptUnscannedFiles: next.acceptUnscannedFiles })
        .where(eq(orgSettings.id, ORG_SETTINGS_ID));
      let revokedSessions = 0;
      let revokedLinks = 0;
      if (current.supplierPortalEnabled && !next.enabled) {
        revokedSessions = (
          await tx.update(supplierSessions).set({ revokedAt: sql`now()` }).where(isNull(supplierSessions.revokedAt)).returning({ id: supplierSessions.id })
        ).length;
        revokedLinks = (
          await tx
            .update(supplierInvitations)
            .set({ revokedAt: sql`now()` })
            .where(and(isNull(supplierInvitations.revokedAt), isNull(supplierInvitations.usedAt)))
            .returning({ id: supplierInvitations.id })
        ).length;
      }
      const parts = [
        changed.includes("supplierPortalEnabled")
          ? next.enabled
            ? "supplier portal turned ON: suppliers with a granted access can sign in through a single-use link"
            : `supplier portal turned OFF: ${revokedSessions} live session(s) and ${revokedLinks} unused link(s) revoked`
          : null,
        changed.includes("supplierPortalAcceptUnscannedFiles")
          ? next.acceptUnscannedFiles
            ? "unscanned supplier files ACCEPTED while no scanner is configured"
            : "unscanned supplier files refused again"
          : null,
      ].filter(Boolean);
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "org_settings",
        objectId: null,
        ruleId: "supplier-portal-setting",
        reason: parts.join("; ") + (relaxed.length ? " (relaxation)" : ""),
        detail: {
          phase: "updated",
          fields: changed,
          supplierPortalEnabled: next.enabled,
          supplierPortalAcceptUnscannedFiles: next.acceptUnscannedFiles,
          relaxed,
          revokedSessions,
          revokedLinks,
        },
      });
    });
    return { ...next, changed: true };
  });

  // ---- custom questionnaires: a row is one version; editing publishes the next one ----

  app.get("/v1/supplier-questionnaires", async () => {
    const rows = await db
      .select()
      .from(supplierQuestionnaires)
      .orderBy(asc(supplierQuestionnaires.name), desc(supplierQuestionnaires.version))
      .limit(500);
    return {
      questionnaires: rows.map((q) => ({
        id: q.id,
        name: q.name,
        version: q.version,
        description: q.description,
        questions: q.questions,
        createdAt: q.createdAt.toISOString(),
        retiredAt: q.retiredAt?.toISOString() ?? null,
      })),
    };
  });

  app.post("/v1/supplier-questionnaires", async (req, reply) => {
    const body = createSupplierQuestionnaireSchema.parse(req.body);
    const [existing] = await db
      .select({ id: supplierQuestionnaires.id })
      .from(supplierQuestionnaires)
      .where(eq(supplierQuestionnaires.name, body.name))
      .limit(1);
    if (existing) {
      return reply.status(409).send({
        error: "questionnaire_name_taken",
        detail: "A questionnaire with this name exists. Publish a new version of it instead.",
      });
    }
    const taken = () =>
      reply.status(409).send({
        error: "questionnaire_name_taken",
        detail: "A questionnaire with this name exists. Publish a new version of it instead.",
      });
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [q] = await tx
        .insert(supplierQuestionnaires)
        .values({ name: body.name, version: 1, description: body.description, questions: body.questions as SupplierQuestion[], createdBy: req.authCtx.userId })
        .returning();
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "supplier_questionnaire",
        objectId: q!.id,
        ruleId: "supplier-questionnaire-published",
        reason: `supplier questionnaire '${body.name}' v1 published (${body.questions.length} questions)`,
        detail: { phase: "published", name: body.name, version: 1, questions: body.questions.length },
      });
      return q!;
    }).catch((e: unknown) => {
      // two creates with one name at the same moment: the (name, version) unique constraint decides
      if (isUniqueViolation(e)) return null;
      throw e;
    });
    if (!row) return taken();
    return reply.status(201).send(row);
  });

  app.post("/v1/supplier-questionnaires/:questionnaireId/versions", async (req, reply) => {
    const { questionnaireId } = questionnaireParam.parse(req.params);
    const body = publishSupplierQuestionnaireVersionSchema.parse(req.body);
    const [base] = await db.select().from(supplierQuestionnaires).where(eq(supplierQuestionnaires.id, questionnaireId));
    if (!base) return reply.status(404).send({ error: "not_found" });
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [{ next }] = (await tx
        .select({ next: sql<number>`coalesce(max(${supplierQuestionnaires.version}), 0) + 1` })
        .from(supplierQuestionnaires)
        .where(eq(supplierQuestionnaires.name, base.name))) as [{ next: number }];
      const [q] = await tx
        .insert(supplierQuestionnaires)
        .values({ name: base.name, version: Number(next), description: body.description, questions: body.questions as SupplierQuestion[], createdBy: req.authCtx.userId })
        .returning();
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "supplier_questionnaire",
        objectId: q!.id,
        ruleId: "supplier-questionnaire-published",
        reason: `supplier questionnaire '${base.name}' v${q!.version} published (${body.questions.length} questions)`,
        detail: { phase: "published", name: base.name, version: q!.version, questions: body.questions.length, previousId: base.id },
      });
      return q!;
    });
    return reply.status(201).send(out);
  });

  app.post("/v1/supplier-questionnaires/:questionnaireId/retire", async (req, reply) => {
    const { questionnaireId } = questionnaireParam.parse(req.params);
    const [q] = await db.select().from(supplierQuestionnaires).where(eq(supplierQuestionnaires.id, questionnaireId));
    if (!q) return reply.status(404).send({ error: "not_found" });
    if (q.retiredAt) return reply.send({ id: q.id, retiredAt: q.retiredAt.toISOString(), changed: false });
    const retiredAt = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [u] = await tx
        .update(supplierQuestionnaires)
        .set({ retiredAt: sql`now()` })
        .where(and(eq(supplierQuestionnaires.id, questionnaireId), isNull(supplierQuestionnaires.retiredAt)))
        .returning({ retiredAt: supplierQuestionnaires.retiredAt });
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "supplier_questionnaire",
        objectId: q.id,
        ruleId: "supplier-questionnaire-retired",
        reason: `supplier questionnaire '${q.name}' v${q.version} retired: no new access can use it`,
        detail: { phase: "retired", name: q.name, version: q.version },
      });
      return u?.retiredAt ?? new Date();
    });
    return reply.send({ id: q.id, retiredAt: retiredAt.toISOString(), changed: true });
  });

  // ---- access grants on one vendor ----

  app.get("/v1/vendors/:vendorId/supplier-access", async (req, reply) => {
    const { vendorId } = vendorParam.parse(req.params);
    const [vendor] = await db.select({ id: aiVendors.id }).from(aiVendors).where(eq(aiVendors.id, vendorId));
    if (!vendor) return reply.status(404).send({ error: "not_found" });
    const settings = await loadOrgSettings(db);
    const grants = await db
      .select({ access: supplierAccess, qName: supplierQuestionnaires.name, qVersion: supplierQuestionnaires.version })
      .from(supplierAccess)
      .leftJoin(supplierQuestionnaires, eq(supplierQuestionnaires.id, supplierAccess.questionnaireId))
      .where(eq(supplierAccess.vendorId, vendorId))
      .orderBy(desc(supplierAccess.createdAt))
      .limit(200);
    const ids = grants.map((g) => g.access.id);
    const links = ids.length
      ? await db.select().from(supplierInvitations).where(inArray(supplierInvitations.accessId, ids)).orderBy(desc(supplierInvitations.createdAt))
      : [];
    const live = ids.length
      ? await db
          .select({ accessId: supplierSessions.accessId, n: sql<number>`count(*)::int` })
          .from(supplierSessions)
          .where(and(inArray(supplierSessions.accessId, ids), isNull(supplierSessions.revokedAt), gt(supplierSessions.expiresAt, sql`now()`)))
          .groupBy(supplierSessions.accessId)
      : [];
    const now = new Date();
    return {
      enabled: settings.supplierPortalEnabled,
      access: grants.map(({ access: a, qName, qVersion }) => ({
        id: a.id,
        email: a.supplierEmail,
        framework: a.framework,
        questionnaire: a.questionnaireId ? { id: a.questionnaireId, name: qName, version: qVersion } : null,
        expiresAt: a.expiresAt.toISOString(),
        revokedAt: a.revokedAt?.toISOString() ?? null,
        createdAt: a.createdAt.toISOString(),
        state: accessState(a, now),
        liveSessions: live.find((l) => l.accessId === a.id)?.n ?? 0,
        links: links
          .filter((l) => l.accessId === a.id)
          .map((l) => ({
            id: l.id,
            expiresAt: l.expiresAt.toISOString(),
            usedAt: l.usedAt?.toISOString() ?? null,
            revokedAt: l.revokedAt?.toISOString() ?? null,
            state: (l.revokedAt ? "revoked" : l.usedAt ? "used" : l.expiresAt.getTime() <= now.getTime() ? "expired" : "active") as LinkState,
          })),
      })),
    };
  });

  /** mint a link for a live grant inside `tx`, revoking the grant's earlier unused links */
  async function mintLink(tx: Db, accessId: string, inviteHours: number, userId: string | null) {
    await tx
      .update(supplierInvitations)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(supplierInvitations.accessId, accessId), isNull(supplierInvitations.usedAt), isNull(supplierInvitations.revokedAt)));
    const { token, tokenHash } = newToken(SUPPLIER_INVITE_TOKEN_PREFIX);
    const [inv] = await tx
      .insert(supplierInvitations)
      .values({
        accessId,
        tokenHash,
        // never past the grant itself; database clock
        expiresAt: sql`least(now() + make_interval(hours => ${inviteHours}), (select expires_at from supplier_access where id = ${accessId}))`,
        createdBy: userId,
      })
      .returning();
    return { token, invitation: inv! };
  }

  const linkUrl = (req: FastifyRequest, token: string) => `${deploymentBaseUrl(req)}/ui/supplier#${token}`;

  app.post("/v1/vendors/:vendorId/supplier-access", async (req, reply) => {
    const { vendorId } = vendorParam.parse(req.params);
    const body = createSupplierAccessSchema.parse(req.body);
    const settings = await loadOrgSettings(db);
    if (!settings.supplierPortalEnabled) {
      return reply.status(409).send({
        error: "supplier_portal_disabled",
        detail: "The supplier portal is off. An admin can turn it on in Supplier questionnaires.",
      });
    }
    const [vendor] = await db.select().from(aiVendors).where(eq(aiVendors.id, vendorId));
    if (!vendor) return reply.status(404).send({ error: "not_found" });
    if (vendor.status !== "proposed" && vendor.status !== "under_assessment") {
      return reply.status(409).send({
        error: "assessment_not_open",
        detail: `This vendor is ${vendor.status.replace(/_/g, " ")}, so its assessment no longer takes answers.`,
      });
    }
    if (!vendor.workflowInstanceId) {
      return reply.status(409).send({ error: "no_assessment", detail: "This vendor has no assessment to answer." });
    }
    const { pack, controls } = await activeControls(body.framework);
    if (!pack) {
      return reply.status(409).send({
        error: "no_active_pack_for_framework",
        detail: `No active compliance pack exists for ${body.framework}. Activate one before inviting a supplier.`,
      });
    }
    if (body.questionnaireId) {
      const [q] = await db.select().from(supplierQuestionnaires).where(eq(supplierQuestionnaires.id, body.questionnaireId));
      if (!q || q.retiredAt) {
        return reply.status(409).send({ error: "questionnaire_not_available", detail: "That questionnaire version is retired or does not exist." });
      }
      // a question linked to a control the framework does not have could never be accepted: refuse it here
      const refs = new Set(controls.map((c) => c.controlRef));
      const outside = [...new Set(q.questions.map((x) => x.controlRef).filter((r): r is string => r !== null && !refs.has(r)))];
      if (outside.length > 0) {
        return reply.status(409).send({
          error: "questionnaire_controls_not_in_framework",
          detail: `This questionnaire links questions to controls that ${body.framework} does not have: ${outside.join(", ")}. Publish a version that links them to this framework's controls, or leave them unlinked.`,
          controlRefs: outside,
        });
      }
    }
    const su = await requireStepUp(db, req, reply, {
      kind: "identity_manage",
      facts: {
        op: "supplier_access_grant",
        vendorId,
        email: body.email,
        framework: body.framework,
        questionnaireId: body.questionnaireId,
        accessDays: body.accessDays,
        inviteHours: body.inviteHours,
      },
    });
    if (!su.ok) return reply;
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [a] = await tx
        .insert(supplierAccess)
        .values({
          vendorId,
          workflowInstanceId: vendor.workflowInstanceId!,
          framework: body.framework,
          questionnaireId: body.questionnaireId,
          supplierEmail: body.email,
          expiresAt: sql`now() + make_interval(days => ${body.accessDays})`,
          createdBy: req.authCtx.userId,
        })
        .returning();
      const link = await mintLink(tx, a!.id, body.inviteHours, req.authCtx.userId);
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "supplier_access",
        objectId: a!.id,
        ruleId: "supplier-access-granted",
        reason:
          `supplier ${body.email} granted access to vendor '${vendor.name}' (${body.framework}) for ${body.accessDays} day(s); ` +
          `sign-in link valid ${body.inviteHours} hour(s), single use`,
        detail: {
          phase: "granted",
          vendorId,
          workflowInstanceId: vendor.workflowInstanceId,
          email: body.email,
          framework: body.framework,
          questionnaireId: body.questionnaireId,
          accessDays: body.accessDays,
          invitationId: link.invitation.id,
          stepUp: su.method,
        },
      });
      return { access: a!, link };
    });
    return reply.status(201).send({
      access: { id: out.access.id, email: out.access.supplierEmail, framework: out.access.framework, expiresAt: out.access.expiresAt.toISOString() },
      link: { url: linkUrl(req, out.link.token), expiresAt: out.link.invitation.expiresAt.toISOString() },
      notice: "Copy this link now and send it to the supplier yourself. It is shown once, works once and is not stored.",
    });
  });

  /** the grant named by the URL, live, on this vendor — or null with the reply sent */
  async function liveGrant(reply: FastifyReply, vendorId: string, accessId: string) {
    const [a] = await db
      .select()
      .from(supplierAccess)
      .where(and(eq(supplierAccess.id, accessId), eq(supplierAccess.vendorId, vendorId)));
    if (!a) {
      await reply.status(404).send({ error: "not_found" });
      return null;
    }
    const state = accessState(a, new Date());
    if (state !== "active") {
      await reply.status(409).send({ error: `access_${state}`, detail: `This access is ${state}. Grant a new one instead.` });
      return null;
    }
    return a;
  }

  app.post("/v1/vendors/:vendorId/supplier-access/:accessId/links", async (req, reply) => {
    const { vendorId, accessId } = accessParam.parse(req.params);
    const body = reissueSupplierInvitationSchema.parse(req.body ?? {});
    const settings = await loadOrgSettings(db);
    if (!settings.supplierPortalEnabled) {
      return reply.status(409).send({ error: "supplier_portal_disabled", detail: "The supplier portal is off." });
    }
    const a = await liveGrant(reply, vendorId, accessId);
    if (!a) return reply;
    const su = await requireStepUp(db, req, reply, { kind: "identity_manage", facts: { op: "supplier_link_issue", accessId, inviteHours: body.inviteHours } });
    if (!su.ok) return reply;
    const link = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const l = await mintLink(tx, accessId, body.inviteHours, req.authCtx.userId);
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "supplier_access",
        objectId: accessId,
        ruleId: "supplier-link-issued",
        reason: `new single-use sign-in link issued to ${a.supplierEmail} (earlier unused links revoked)`,
        detail: { phase: "link-issued", vendorId, invitationId: l.invitation.id, inviteHours: body.inviteHours, stepUp: su.method },
      });
      return l;
    });
    return reply.status(201).send({
      link: { url: linkUrl(req, link.token), expiresAt: link.invitation.expiresAt.toISOString() },
      notice: "Copy this link now and send it to the supplier yourself. It is shown once, works once and is not stored.",
    });
  });

  app.post("/v1/vendors/:vendorId/supplier-access/:accessId/revoke", async (req, reply) => {
    const { vendorId, accessId } = accessParam.parse(req.params);
    const body = revokeSupplierAccessSchema.parse(req.body);
    const [a] = await db
      .select()
      .from(supplierAccess)
      .where(and(eq(supplierAccess.id, accessId), eq(supplierAccess.vendorId, vendorId)));
    if (!a) return reply.status(404).send({ error: "not_found" });
    if (a.revokedAt) return reply.send({ id: a.id, revokedAt: a.revokedAt.toISOString(), changed: false });
    const su = await requireStepUp(db, req, reply, { kind: "identity_manage", facts: { op: "supplier_access_revoke", accessId } });
    if (!su.ok) return reply;
    const revokedAt = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [u] = await tx
        .update(supplierAccess)
        .set({ revokedAt: sql`now()`, revokedBy: req.authCtx.userId })
        .where(and(eq(supplierAccess.id, accessId), isNull(supplierAccess.revokedAt)))
        .returning({ revokedAt: supplierAccess.revokedAt });
      const sessions = await tx
        .update(supplierSessions)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(supplierSessions.accessId, accessId), isNull(supplierSessions.revokedAt)))
        .returning({ id: supplierSessions.id });
      await tx
        .update(supplierInvitations)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(supplierInvitations.accessId, accessId), isNull(supplierInvitations.revokedAt), isNull(supplierInvitations.usedAt)));
      // answers still waiting for review come from a grant nobody trusts any more: they are closed, never left to be
      // accepted later (a leaked link is the usual reason to revoke)
      const closed = await tx
        .update(supplierSubmissions)
        .set({ status: "rejected", decidedBy: req.authCtx.userId, decidedAt: sql`now()`, decisionReason: `Access revoked: ${body.reason}` })
        .where(and(eq(supplierSubmissions.accessId, accessId), eq(supplierSubmissions.status, "submitted")))
        .returning({ id: supplierSubmissions.id });
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "supplier_access",
        objectId: accessId,
        ruleId: "supplier-access-revoked",
        reason:
          `supplier access for ${a.supplierEmail} revoked (${sessions.length} live session(s) ended, ` +
          `${closed.length} pending answer(s) rejected): ${body.reason}`,
        detail: { phase: "revoked", vendorId, sessionsEnded: sessions.length, answersRejected: closed.length, reason: body.reason, stepUp: su.method },
      });
      return u?.revokedAt ?? new Date();
    });
    return reply.send({ id: accessId, revokedAt: revokedAt.toISOString(), changed: true });
  });

  // ---- reviewing what suppliers submitted ----

  app.get("/v1/vendors/:vendorId/supplier-submissions", async (req, reply) => {
    const { vendorId } = vendorParam.parse(req.params);
    const [vendor] = await db.select({ id: aiVendors.id }).from(aiVendors).where(eq(aiVendors.id, vendorId));
    if (!vendor) return reply.status(404).send({ error: "not_found" });
    const rows = await db
      .select({ s: supplierSubmissions, access: supplierAccess })
      .from(supplierSubmissions)
      .innerJoin(supplierAccess, eq(supplierAccess.id, supplierSubmissions.accessId))
      .where(eq(supplierSubmissions.vendorId, vendorId))
      .orderBy(desc(supplierSubmissions.createdAt))
      .limit(500);
    const now = new Date();
    return {
      submissions: rows.map(({ s, access }) => ({
        ...submissionView(s),
        accessId: s.accessId,
        accessState: accessState(access, now),
        supplierEmail: access.supplierEmail,
        framework: access.framework,
      })),
      disclaimer: AI_VENDOR_ATTESTATION_DISCLAIMER,
    };
  });

  app.get("/v1/vendors/:vendorId/supplier-submissions/:submissionId/file", async (req, reply) => {
    const { vendorId, submissionId } = submissionParam.parse(req.params);
    const [s] = await db
      .select()
      .from(supplierSubmissions)
      .where(and(eq(supplierSubmissions.id, submissionId), eq(supplierSubmissions.vendorId, vendorId)));
    if (!s || !s.fileCiphertext || !s.fileName) return reply.status(404).send({ error: "not_found" });
    if (!opts.dataKey) {
      return reply.status(503).send({ error: "data_key_unavailable", detail: "The data key is not loaded, so the file cannot be opened." });
    }
    const acknowledged = downloadQuery.parse(req.query).acknowledgeUnscanned === "1";
    if (s.scanStatus !== "clean" && !acknowledged) {
      return reply.status(409).send({
        error: "unscanned_file_acknowledgement_required",
        detail: "This file has not been scanned for malware. Confirm that you will open it with care before downloading it.",
      });
    }
    const bytes = Buffer.from(decryptSecret(opts.dataKey, s.fileCiphertext), "base64");
    // a CSV opened in a spreadsheet application can run formulas a supplier wrote: it is served as plain text
    const csv = s.fileContentType === "text/csv";
    await audit(db, {
      userId: req.authCtx.userId,
      objectType: "supplier_submission",
      objectId: s.id,
      ruleId: "supplier-file-downloaded",
      reason: `supplier evidence file '${dispositionName(s.fileName)}' downloaded (${s.scanStatus === "clean" ? "scanned clean" : "not scanned"})`,
      detail: { phase: "file-downloaded", vendorId, sha256: s.fileSha256, scanStatus: s.scanStatus, acknowledgedUnscanned: acknowledged },
    });
    return reply
      .header("content-type", csv ? "text/plain; charset=utf-8" : (s.fileContentType ?? "application/octet-stream"))
      .header("content-disposition", `attachment; filename="${dispositionName(s.fileName)}${csv ? ".txt" : ""}"`)
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'")
      .header("cache-control", "no-store")
      .send(bytes);
  });

  app.post("/v1/vendors/:vendorId/supplier-submissions/:submissionId/decision", async (req, reply) => {
    const { vendorId, submissionId } = submissionParam.parse(req.params);
    const body = decideSupplierSubmissionSchema.parse(req.body);
    const userId = req.authCtx.userId;
    if (!userId) {
      return reply.status(403).send({
        error: "attribution_requires_identity",
        detail: "a decision on a supplier's answer is attributed to the user who made it — the bootstrap token has no identity",
      });
    }
    try {
      const out = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [s] = await tx
          .select()
          .from(supplierSubmissions)
          .where(and(eq(supplierSubmissions.id, submissionId), eq(supplierSubmissions.vendorId, vendorId)))
          .for("update");
        if (!s) throw new Refusal(404, { error: "not_found" });
        if (s.status !== "submitted") {
          throw new Refusal(409, { error: "already_decided", detail: `This answer was already ${s.status}.` });
        }
        const [vendor] = await tx.select().from(aiVendors).where(eq(aiVendors.id, vendorId)).for("update");
        if (!vendor) throw new Refusal(404, { error: "not_found" });
        if (vendor.status === "retired") {
          throw new Refusal(409, { error: "vendor_retired", detail: "A retired vendor's record is closed." });
        }
        const [a] = await tx.select().from(supplierAccess).where(eq(supplierAccess.id, s.accessId));
        // a revoked grant's answers never become attestations (revoking also rejects them; this holds for any that
        // reached here another way). An EXPIRED grant's answers can still be accepted: expiry is the planned end.
        if (body.decision === "accept" && a!.revokedAt) {
          throw new Refusal(409, {
            error: "access_revoked",
            detail: "This answer came through an access that has since been revoked, so it cannot be accepted.",
          });
        }
        let attestation: AiVendorPackAttestation | null = null;
        if (body.decision === "accept") {
          let controlRef = s.controlRef;
          if (s.kind === "question" && s.questionnaireId) {
            const [q] = await tx.select().from(supplierQuestionnaires).where(eq(supplierQuestionnaires.id, s.questionnaireId));
            controlRef = q?.questions.find((x) => x.id === s.questionId)?.controlRef ?? null;
          }
          if (controlRef) {
            const rec = await recordVendorAttestation(tx, vendor, {
              framework: a!.framework,
              controlRef,
              statement: s.statement,
              evidenceRef: body.evidenceRef ?? (s.fileSha256 ? `supplier file ${dispositionName(s.fileName ?? "")} sha256:${s.fileSha256}` : null),
              userId,
              submittedBySupplier: {
                accessId: s.accessId,
                email: a!.supplierEmail,
                submissionId: s.id,
                submittedAt: s.createdAt.toISOString(),
              },
            });
            if (!rec.ok) throw new Refusal(rec.status, rec.body);
            attestation = rec.attestation;
          }
        }
        const status = body.decision === "accept" ? "accepted" : "rejected";
        await tx
          .update(supplierSubmissions)
          .set({ status, decidedBy: userId, decidedAt: sql`now()`, decisionReason: body.reason ?? null })
          .where(eq(supplierSubmissions.id, s.id));
        await audit(tx, {
          userId,
          objectType: "supplier_submission",
          objectId: s.id,
          ruleId: `supplier-submission-${status}`,
          reason:
            `supplier answer from ${a!.supplierEmail} ${status}` +
            (attestation ? ` and recorded as an attestation for ${attestation.controlRef}` : "") +
            (body.reason ? `: ${body.reason}` : ""),
          detail: { phase: status, vendorId, accessId: s.accessId, controlRef: attestation?.controlRef ?? null, questionId: s.questionId },
        });
        return { status, attestation };
      });
      return reply.send({ id: submissionId, ...out, disclaimer: AI_VENDOR_ATTESTATION_DISCLAIMER });
    } catch (e) {
      if (e instanceof Refusal) return reply.status(e.status).send(e.body);
      throw e;
    }
  });

  // =============================================================================================================
  // SUPPLIER SIDE — auth-exempt for the platform hooks; authenticated here on the supplier cookie only
  // =============================================================================================================

  /** off → the same 404 as an unknown path; then the per-address bucket. null = reply sent */
  async function gate(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const settings = await loadOrgSettings(db);
    if (!settings.supplierPortalEnabled) {
      await reply.status(404).send(notFoundBody(req.method, req.url));
      return false;
    }
    if (await limit(req, reply, `sp:addr:${req.ip}`)) return false;
    return true;
  }

  async function csrf(req: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    if (req.headers[CSRF_HEADER] === "1") return true;
    await reply.status(403).send({ error: "csrf_header_required", detail: `state-changing requests must carry ${CSRF_HEADER}: 1` });
    return false;
  }

  const clearCookie = (req: FastifyRequest) => sessionCookie("", requestIsSecure(req), 0);

  /** the live session and its grant, or null with the uniform refusal sent */
  /** the live session a cookie names, with its grant and vendor, or undefined (database clock throughout) */
  async function liveSession(req: FastifyRequest) {
    const token = readCookie(req.headers.cookie, SUPPLIER_SESSION_COOKIE);
    if (!token || !SUPPLIER_SESSION_TOKEN_RE.test(token)) return undefined;
    const idle = L.sessionIdleMinutes;
    const [row] = await db
      .select({ session: supplierSessions, access: supplierAccess, vendorName: aiVendors.name, vendorStatus: aiVendors.status })
      .from(supplierSessions)
      .innerJoin(supplierAccess, eq(supplierAccess.id, supplierSessions.accessId))
      .innerJoin(aiVendors, eq(aiVendors.id, supplierAccess.vendorId))
      .where(
        and(
          eq(supplierSessions.tokenHash, hashToken(token)),
          isNull(supplierSessions.revokedAt),
          isNull(supplierAccess.revokedAt),
          gt(supplierSessions.expiresAt, sql`now()`),
          gt(supplierAccess.expiresAt, sql`now()`),
          gt(supplierSessions.lastSeenAt, sql`now() - make_interval(mins => ${idle})`),
        ),
      );
    return row && row.vendorStatus !== "retired" ? row : undefined;
  }

  async function supplierSession(req: FastifyRequest, reply: FastifyReply) {
    const row = await liveSession(req);
    if (!row) {
      await reply.status(401).header("set-cookie", clearCookie(req)).send(SUPPLIER_SESSION_REFUSAL);
      return null;
    }
    await db.update(supplierSessions).set({ lastSeenAt: sql`now()` }).where(eq(supplierSessions.id, row.session.id));
    return row;
  }

  app.post(`${SUPPLIER_API_PREFIX}/session`, async (req, reply) => {
    if (!(await gate(req, reply))) return reply;
    if (!(await csrf(req, reply))) return reply;
    const parsed = supplierSessionStartSchema.safeParse(req.body);
    const refuse = () => reply.status(401).send(SUPPLIER_LINK_REFUSAL);
    if (!parsed.success || !SUPPLIER_INVITE_TOKEN_RE.test(parsed.data.token)) return refuse();
    const tokenHash = hashToken(parsed.data.token);
    const { token, tokenHash: sessionHash } = newToken(SUPPLIER_SESSION_TOKEN_PREFIX);
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx
        .select({ inv: supplierInvitations, access: supplierAccess, vendorName: aiVendors.name, vendorStatus: aiVendors.status })
        .from(supplierInvitations)
        .innerJoin(supplierAccess, eq(supplierAccess.id, supplierInvitations.accessId))
        .innerJoin(aiVendors, eq(aiVendors.id, supplierAccess.vendorId))
        .where(eq(supplierInvitations.tokenHash, tokenHash))
        .for("update", { of: supplierInvitations });
      if (!row) return null;
      // spend the link only while every condition holds, on the database clock
      const [spent] = await tx
        .update(supplierInvitations)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(supplierInvitations.id, row.inv.id),
            isNull(supplierInvitations.usedAt),
            isNull(supplierInvitations.revokedAt),
            gt(supplierInvitations.expiresAt, sql`now()`),
            sql`exists (select 1 from supplier_access a where a.id = ${row.access.id} and a.revoked_at is null and a.expires_at > now())`,
          ),
        )
        .returning({ id: supplierInvitations.id });
      if (!spent || row.vendorStatus === "retired") {
        await audit(tx, {
          userId: null,
          objectType: "supplier_access",
          objectId: row.access.id,
          ruleId: "supplier-link-refused",
          effect: "deny",
          reason: "a supplier sign-in link was presented after it was used, revoked or expired",
          detail: { phase: "link-refused", invitationId: row.inv.id, vendorId: row.access.vendorId, actor: "supplier" },
        });
        return { refused: true as const };
      }
      const [session] = await tx
        .insert(supplierSessions)
        .values({
          accessId: row.access.id,
          tokenHash: sessionHash,
          expiresAt: sql`least(now() + make_interval(hours => ${L.sessionAbsoluteHours}), (select expires_at from supplier_access where id = ${row.access.id}))`,
        })
        .returning();
      await audit(tx, {
        userId: null,
        objectType: "supplier_access",
        objectId: row.access.id,
        ruleId: "supplier-session-started",
        reason: `supplier ${row.access.supplierEmail} signed in to the portal for vendor '${row.vendorName}'`,
        detail: { phase: "session-started", invitationId: row.inv.id, sessionId: session!.id, vendorId: row.access.vendorId, actor: "supplier" },
      });
      return { refused: false as const, session: session!, access: row.access, vendorName: row.vendorName };
    });
    if (!out || out.refused) return refuse();
    const maxAge = Math.max(1, Math.floor((out.session.expiresAt.getTime() - Date.now()) / 1000));
    return reply
      .header("set-cookie", sessionCookie(token, requestIsSecure(req), maxAge))
      .header("cache-control", "no-store")
      .send({ vendorName: out.vendorName, framework: out.access.framework, sessionExpiresAt: out.session.expiresAt.toISOString() });
  });

  app.post(`${SUPPLIER_API_PREFIX}/session/end`, async (req, reply) => {
    if (!(await gate(req, reply))) return reply;
    if (!(await csrf(req, reply))) return reply;
    const row = await supplierSession(req, reply);
    if (!row) return reply;
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.update(supplierSessions).set({ revokedAt: sql`now()` }).where(eq(supplierSessions.id, row.session.id));
      await audit(tx, {
        userId: null,
        objectType: "supplier_access",
        objectId: row.access.id,
        ruleId: "supplier-session-ended",
        reason: `supplier ${row.access.supplierEmail} signed out`,
        detail: { phase: "session-ended", sessionId: row.session.id, actor: "supplier" },
      });
    });
    return reply.header("set-cookie", clearCookie(req)).send({ ended: true });
  });

  app.get(`${SUPPLIER_API_PREFIX}/assessment`, async (req, reply) => {
    if (!(await gate(req, reply))) return reply;
    const row = await supplierSession(req, reply);
    if (!row) return reply;
    const { access: a } = row;
    const { controls } = await activeControls(a.framework);
    const [q] = a.questionnaireId
      ? await db.select().from(supplierQuestionnaires).where(eq(supplierQuestionnaires.id, a.questionnaireId))
      : [];
    const mine = await db
      .select()
      .from(supplierSubmissions)
      .where(eq(supplierSubmissions.accessId, a.id))
      .orderBy(desc(supplierSubmissions.createdAt))
      .limit(500);
    return reply.header("cache-control", "no-store").send({
      vendorName: row.vendorName,
      framework: a.framework,
      open: row.vendorStatus === "proposed" || row.vendorStatus === "under_assessment",
      accessExpiresAt: a.expiresAt.toISOString(),
      sessionExpiresAt: row.session.expiresAt.toISOString(),
      controls,
      questionnaire: q ? { name: q.name, version: q.version, description: q.description, questions: q.questions } : null,
      submissions: mine.map(submissionView),
      limits: {
        fileMaxBytes: L.fileMaxBytes,
        statementMax: L.statementMax,
        fileTypes: SUPPLIER_FILE_TYPES,
        filesAccepted: await filesAccepted(),
        fileBytesBudget: L.perAccessFileBytesMax,
      },
    });
  });

  /** files are accepted only with a scanner, or when an admin has relaxed the unscanned-files setting */
  async function filesAccepted(): Promise<boolean> {
    if (!opts.dataKey) return false;
    if (opts.fileScanner) return true;
    return (await loadOrgSettings(db)).supplierPortalAcceptUnscannedFiles;
  }

  // the one route with a large body: refuse before the body is read when the portal is off or the cookie does not
  // name a live session (one indexed lookup), so an anonymous caller cannot make the gateway parse 2.8 MB for nothing
  async function beforeBody(req: FastifyRequest, reply: FastifyReply) {
    const settings = await loadOrgSettings(db);
    if (!settings.supplierPortalEnabled) return reply.status(404).send(notFoundBody(req.method, req.url));
    if (!(await liveSession(req))) {
      return reply.status(401).header("set-cookie", clearCookie(req)).send(SUPPLIER_SESSION_REFUSAL);
    }
  }

  app.post(
    `${SUPPLIER_API_PREFIX}/submissions`,
    { bodyLimit: Math.ceil(L.fileMaxBytes / 3) * 4 + 64 * 1024, onRequest: beforeBody },
    async (req, reply) => {
    if (!(await gate(req, reply))) return reply;
    if (!(await csrf(req, reply))) return reply;
    const row = await supplierSession(req, reply);
    if (!row) return reply;
    const { access: a } = row;
    if (await limit(req, reply, `sp:access:${a.id}`)) return reply;
    if (row.vendorStatus !== "proposed" && row.vendorStatus !== "under_assessment") {
      return reply.status(409).send({ error: "assessment_closed", detail: "This assessment has been decided and no longer takes answers." });
    }
    const body = supplierSubmissionSchema.parse(req.body);
    let questionnaireId: string | null = null;
    let allowFile = true;
    if (body.target.kind === "control") {
      const { controls } = await activeControls(a.framework);
      const target = body.target;
      if (!controls.some((c) => c.controlRef === target.controlRef)) {
        return reply.status(422).send({ error: "unknown_control", detail: "That control is not part of this assessment." });
      }
    } else {
      const target = body.target;
      const [q] = a.questionnaireId
        ? await db.select().from(supplierQuestionnaires).where(eq(supplierQuestionnaires.id, a.questionnaireId))
        : [];
      const question = q?.questions.find((x) => x.id === target.questionId);
      if (!q || !question) {
        return reply.status(422).send({ error: "unknown_question", detail: "That question is not part of this assessment." });
      }
      questionnaireId = q.id;
      allowFile = question.allowFile;
    }
    let file: { name: string; type: SupplierFileType; size: number; sha256: string; ciphertext: string; scan: "not_scanned" | "clean" } | null = null;
    if (body.file) {
      if (!allowFile) return reply.status(422).send({ error: "file_not_allowed", detail: "This question does not take a file." });
      if (!(await filesAccepted())) {
        return reply.status(422).send({
          error: "files_not_accepted",
          detail: "Files cannot be attached to answers here. Submit your answer without one, and send the document to your contact.",
        });
      }
      const b64 = body.file.base64;
      if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
        return reply.status(422).send({ error: "file_unreadable", detail: "The file could not be read. Choose it again." });
      }
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length < 1 || bytes.length > L.fileMaxBytes) {
        return reply.status(422).send({ error: "file_too_large", detail: `A file can be at most ${L.fileMaxBytes / (1024 * 1024)} MB.` });
      }
      const type = detectSupplierFileType(bytes, body.file.name);
      if (!type) {
        return reply.status(422).send({
          error: "file_type_not_allowed",
          detail: "Upload a PDF, PNG, JPEG, plain text or CSV file whose name ends in the matching extension.",
        });
      }
      let scan: "not_scanned" | "clean" = "not_scanned";
      if (opts.fileScanner) {
        const verdict = await opts.fileScanner(bytes, type);
        if (verdict !== "clean") {
          await audit(db, {
            userId: null,
            objectType: "supplier_access",
            objectId: a.id,
            ruleId: "supplier-file-rejected",
            effect: "deny",
            reason: "a supplier upload was refused by the file scanner",
            detail: { phase: "file-rejected", vendorId: a.vendorId, type, size: bytes.length, actor: "supplier" },
          });
          return reply.status(422).send({ error: "file_rejected", detail: "The file did not pass the security scan." });
        }
        scan = "clean";
      }
      file = {
        name: body.file.name,
        type,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ciphertext: encryptSecret(opts.dataKey!, b64),
        scan,
      };
    }
    const sameTarget =
      body.target.kind === "control"
        ? eq(supplierSubmissions.controlRef, body.target.controlRef)
        : and(eq(supplierSubmissions.questionId, body.target.questionId), eq(supplierSubmissions.questionnaireId, questionnaireId!));
    const saved = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // one grant's submissions are serialised here, so the caps below cannot be raced past
      await tx.select({ id: supplierAccess.id }).from(supplierAccess).where(eq(supplierAccess.id, a.id)).for("update");
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(supplierSubmissions)
        .where(eq(supplierSubmissions.accessId, a.id))) as [{ n: number }];
      if (n >= L.perAccessSubmissionsMax) {
        throw new Refusal(409, {
          error: "submission_limit_reached",
          detail: `This access has reached its limit of ${L.perAccessSubmissionsMax} answers. Ask your contact for help.`,
        });
      }
      // a newer answer to the same item replaces the one still waiting for review, and that one's file is dropped
      const withdrawn = await tx
        .update(supplierSubmissions)
        .set({
          status: "withdrawn",
          decidedAt: sql`now()`,
          decisionReason: "Replaced by a newer answer from the supplier",
          fileName: null,
          fileContentType: null,
          fileSize: null,
          fileSha256: null,
          fileCiphertext: null,
          scanStatus: null,
        })
        .where(and(eq(supplierSubmissions.accessId, a.id), eq(supplierSubmissions.status, "submitted"), sameTarget))
        .returning({ id: supplierSubmissions.id });
      if (file) {
        const [{ held }] = (await tx
          .select({ held: sql<number>`coalesce(sum(${supplierSubmissions.fileSize}), 0)::bigint` })
          .from(supplierSubmissions)
          .where(and(eq(supplierSubmissions.accessId, a.id), sql`${supplierSubmissions.fileCiphertext} IS NOT NULL`))) as [{ held: number }];
        if (Number(held) + file.size > L.perAccessFileBytesMax) {
          throw new Refusal(413, {
            error: "file_budget_exceeded",
            detail: `This access can hold at most ${L.perAccessFileBytesMax / (1024 * 1024)} MB of files. Submit your answer without a file, or ask your contact for help.`,
          });
        }
      }
      const [s] = await tx
        .insert(supplierSubmissions)
        .values({
          accessId: a.id,
          vendorId: a.vendorId,
          kind: body.target.kind,
          controlRef: body.target.kind === "control" ? body.target.controlRef : null,
          questionnaireId,
          questionId: body.target.kind === "question" ? body.target.questionId : null,
          statement: body.statement,
          fileName: file?.name ?? null,
          fileContentType: file?.type ?? null,
          fileSize: file?.size ?? null,
          fileSha256: file?.sha256 ?? null,
          fileCiphertext: file?.ciphertext ?? null,
          scanStatus: file?.scan ?? null,
        })
        .returning();
      await audit(tx, {
        userId: null,
        objectType: "supplier_submission",
        objectId: s!.id,
        ruleId: "supplier-submission-received",
        reason: `supplier ${a.supplierEmail} submitted an answer for ${body.target.kind === "control" ? body.target.controlRef : `question ${body.target.questionId}`}${file ? " with a file" : ""}`,
        detail: {
          phase: "submitted",
          vendorId: a.vendorId,
          accessId: a.id,
          kind: body.target.kind,
          replaced: withdrawn.map((w) => w.id),
          file: file ? { type: file.type, size: file.size, sha256: file.sha256, scanStatus: file.scan } : null,
          actor: "supplier",
        },
      });
      return s!;
    }).catch((e: unknown) => {
      if (e instanceof Refusal) return e;
      throw e;
    });
    if (saved instanceof Refusal) return reply.status(saved.status).send(saved.body);
    return reply.status(201).send(submissionView(saved));
    },
  );
}
