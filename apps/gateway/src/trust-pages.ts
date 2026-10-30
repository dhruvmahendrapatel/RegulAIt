/**
 * ADR-0225 (P13 d, owner 2026-10-30) — OUTWARD TRUST PAGES: a public trust centre, per-system AI cards, and a named
 * external auditor's read-only portal. Built and shipped OFF (`trust_pages_enabled`, ADR-0180).
 *
 * WHAT CAN LEAVE THE ORGANISATION. Only a `trust_publications` row an admin published, and only its reviewed snapshot
 * (title + content + publication date + a random public slug). The public pages never read the register, the packs
 * or the ledgers: a draft is pre-filled from them (`from-control`, `from-use-case`), edited by an admin, and what the
 * admin published is what is shown. Internal ids, `source_ref`, who published and every other column stay on the
 * admin API. Text that claims a certification or compliance is refused at publish (`claimWordingProblems`).
 *
 * WHO DOES WHAT.
 *  - Admins (the default admin gate): draft, edit a draft, delete a draft, publish and unpublish (each publish and
 *    unpublish needs the `settings_relax` step-up), the trust centre's heading, and auditor grants (creating one and
 *    issuing a sign-in link need the step-up; revoking does not, it only takes access away). Every write is audited
 *    in its own transaction.
 *  - Anyone: `GET /v1/trust-center`, the published public items, cacheable for five minutes. 404 while the setting is
 *    off, so the surface is indistinguishable from one that does not exist.
 *  - A named auditor: redeems a single-use link (at most 72 hours old) for a browser session of at most an hour,
 *    held in an HttpOnly, SameSite=Strict cookie scoped to `/v1/auditor`, then reads the items the grant selected
 *    (default-deny) while they stay published and the grant's window is open. Every view is audited. Nothing is
 *    downloadable: the portal serves the same reviewed text snapshots, never a file or a ledger row.
 *
 * The external-access pattern (hashed single-use link -> short cookie session -> scoped reads) is shared in spirit
 * with the supplier portal (P4); ADR-0225 names consolidating the two as a later step.
 */
import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {} from "@fastify/rate-limit";
import { z } from "zod";
import {
  agents,
  aiUseCases,
  and,
  auditLog,
  auditorGrantItems,
  auditorGrants,
  auditorLinks,
  auditorSessions,
  compliancePackControls,
  compliancePacks,
  count,
  desc,
  eq,
  inArray,
  isNull,
  modelCards,
  ne,
  sql,
  trustCenterProfile,
  trustPublications,
  type AuditorGrantRow,
  type Db,
  type TrustPublicationRow,
} from "@regulait/db";
import {
  AUDITOR_LINK_TOKEN_PREFIX,
  AUDITOR_SESSION_COOKIE,
  AUDITOR_SESSION_MINUTES,
  TRUST_CONTENT_LABELS,
  TRUST_PAGE_DISCLAIMER,
  TRUST_PUBLIC_RATE_LIMITS,
  TRUST_PUBLICATION_KINDS,
  TRUST_PUBLICATION_STATUSES,
  claimWordingProblems,
  contentFieldsFor,
  contentSchemaFor,
  createAuditorGrantSchema,
  draftFromControlSchema,
  draftFromUseCaseSchema,
  newAuditorLinkSchema,
  publishPublicationSchema,
  redeemAuditorLinkSchema,
  trustProfileSchema,
  unpublishPublicationSchema,
  updatePublicationSchema,
  type PublicTrustCenter,
  type TrustPublicationKind,
} from "@regulait/shared";
import { CSRF_HEADER, readCookie, requestIsSecure } from "./auth.js";
import { evaluatePack } from "./compliance-packs.js";
import { loadOrgSettings } from "./org-settings.js";
import { POSTURE_WINDOW_DAYS } from "./posture.js";
import { requireStepUp } from "./step-up.js";
import { hashToken } from "./token-hash.js";

export const TRUST_RULE_IDS = {
  drafted: "trust-publication-drafted",
  edited: "trust-publication-edited",
  deleted: "trust-publication-deleted",
  published: "trust-publication-published",
  unpublished: "trust-publication-unpublished",
  publishRefused: "trust-publication-publish-refused",
  profileUpdated: "trust-center-profile-updated",
  grantCreated: "auditor-grant-created",
  grantRevoked: "auditor-grant-revoked",
  linkIssued: "auditor-link-issued",
  linkRedeemed: "auditor-link-redeemed",
  linkRefused: "auditor-link-refused",
  portalOpened: "auditor-portal-opened",
  itemViewed: "auditor-item-viewed",
  viewRefused: "auditor-item-view-refused",
  signedOut: "auditor-signed-out",
} as const;

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LINK_TOKEN_RE = new RegExp(`^${AUDITOR_LINK_TOKEN_PREFIX}[0-9a-f]{64}$`);
const SESSION_TOKEN_RE = /^rgas_[0-9a-f]{64}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,79}$/;
const LIST_MAX = 500;

type Writer = Pick<Db, "insert">;

async function audit(
  db: Writer,
  row: {
    userId: string | null;
    objectType: "trust_publication" | "trust_center" | "auditor_grant";
    objectId: string | null;
    ruleId: string;
    reason: string;
    effect?: "allow" | "deny";
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: row.userId ?? NO_IDENTITY,
    objectType: row.objectType,
    objectId: row.objectId,
    detail: row.detail ?? {},
    effect: row.effect ?? "allow",
    ruleId: row.ruleId,
    ruleChain: [],
    reason: row.reason,
  });
}

/** a public slug: the title's words, then 6 random hex (never an internal id) */
export function publicSlugFor(title: string): string {
  const words = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return `${words || "item"}-${randomBytes(3).toString("hex")}`;
}

/** a new auditor sign-in link: 256 random bits; only its SHA-256 is stored */
export function generateAuditorLinkToken(): { token: string; tokenHash: string } {
  const token = AUDITOR_LINK_TOKEN_PREFIX + randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

function generateAuditorSessionToken(): { token: string; tokenHash: string } {
  const token = "rgas_" + randomBytes(32).toString("hex");
  return { token, tokenHash: hashToken(token) };
}

type GrantState = "scheduled" | "active" | "expired" | "revoked";
export const grantState = (g: Pick<AuditorGrantRow, "revokedAt" | "startsAt" | "expiresAt">, now: Date): GrantState =>
  g.revokedAt ? "revoked" : g.expiresAt <= now ? "expired" : g.startsAt > now ? "scheduled" : "active";

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

/** every claim word in a publication's title and content, or [] */
function wordingProblems(title: string, content: Record<string, string>): string[] {
  return claimWordingProblems([title, ...Object.values(content)].join("\n"));
}

/** the publication as the admin API returns it */
function adminView(p: TrustPublicationRow) {
  return {
    id: p.id,
    kind: p.kind,
    slug: p.publicSlug,
    sourceRef: p.sourceRef,
    title: p.title,
    content: p.content,
    status: p.status,
    audience: p.audience,
    version: p.version,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    publishedBy: p.publishedBy,
    createdBy: p.createdBy,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** the publication as a public page or the auditor portal receives it: no id, no source, no person */
function publicView(p: TrustPublicationRow) {
  const fields = contentFieldsFor(p.kind as TrustPublicationKind);
  const content: Record<string, string> = {};
  for (const f of fields) content[f] = p.content[f] ?? "";
  return { slug: p.publicSlug, kind: p.kind as TrustPublicationKind, title: p.title, content, publishedAt: p.publishedAt!.toISOString() };
}

// ---------------------------------------------------------------------------
// Drafting from the register and the packs (the admin edits before publishing)
// ---------------------------------------------------------------------------

/** a control's draft text from its definition and the last 30 days of ledger evidence */
export async function draftForControl(
  db: Db,
  packId: string,
  controlRef: string,
  now = new Date(),
): Promise<{ title: string; content: { statement: string; evidenceSummary: string } } | null> {
  const [pack] = await db.select().from(compliancePacks).where(and(eq(compliancePacks.id, packId), eq(compliancePacks.status, "active")));
  if (!pack) return null;
  const [control] = await db
    .select()
    .from(compliancePackControls)
    .where(and(eq(compliancePackControls.packId, packId), eq(compliancePackControls.controlRef, controlRef)));
  if (!control) return null;
  const periodStart = new Date(now.getTime() - POSTURE_WINDOW_DAYS * DAY_MS);
  const card = await evaluatePack(db, {
    pack,
    controls: [control],
    projectIds: null,
    periodStart,
    periodEnd: now,
    period: "custom",
    periodLabel: `last ${POSTURE_WINDOW_DAYS} days`,
    scopeKind: "org",
    scopeId: null,
    now,
  });
  const a = card.controls[0]!;
  const window = `the ${POSTURE_WINDOW_DAYS} days to ${fmtDate(now)}`;
  let evidence: string;
  switch (a.status) {
    case "satisfied":
    case "unsatisfied":
      evidence =
        `${a.evidenceCount ?? 0} evidence record${a.evidenceCount === 1 ? "" : "s"} in ${window}, collected automatically ` +
        `from the organisation's audit ledger. The organisation's own threshold for this control is ${a.minEvidenceCount}.`;
      break;
    case "attested":
      evidence =
        `This control is organisational, so evidence is a person's attestation. An attestation is on record, made on ` +
        `${fmtDate(new Date(a.attestation!.attestedAt))}` +
        (a.attestation!.validUntil ? ` and valid until ${fmtDate(new Date(a.attestation!.validUntil))}.` : ".");
      break;
    case "attestation_required":
      evidence = "This control is organisational, so evidence is a person's attestation. No current attestation is on record.";
      break;
    default:
      evidence = "No automatic evidence collection covers this control, so no evidence is counted for it.";
  }
  return {
    title: `${control.title} (${pack.framework} ${control.controlRef})`.slice(0, 200),
    content: { statement: control.description ?? control.title, evidenceSummary: evidence },
  };
}

/** an AI system card's draft text from the use-case register and its systems' model cards */
export async function draftForUseCase(
  db: Db,
  useCaseId: string,
): Promise<{ title: string; content: Record<"purpose" | "limits" | "oversight" | "dataUse" | "evaluationSummary", string> } | null> {
  const [uc] = await db.select().from(aiUseCases).where(eq(aiUseCases.id, useCaseId));
  if (!uc || uc.status === "retired") return null;
  const agentIds = Array.isArray(uc.intendedAgentIds) ? (uc.intendedAgentIds as string[]) : [];
  const cards = agentIds.length
    ? await db
        .select({ card: modelCards, agentName: agents.name })
        .from(modelCards)
        .innerJoin(agents, eq(agents.id, modelCards.agentId))
        .where(inArray(modelCards.agentId, agentIds))
    : [];

  const purpose = [uc.description.trim(), uc.businessContext.trim() ? `Context: ${uc.businessContext.trim()}` : ""]
    .filter(Boolean)
    .join("\n\n");

  const limitations = cards.filter((c) => c.card.limitations?.trim()).map((c) => `${c.agentName}: ${c.card.limitations!.trim()}`);
  const limits = limitations.length
    ? limitations.join("\n")
    : "No limitations are recorded yet on the model cards of the systems this use case uses.";

  const oversight = [
    uc.approvedAt && uc.approvedUntil
      ? `Approved through the organisation's AI review on ${fmtDate(uc.approvedAt)}; the approval runs until ${fmtDate(uc.approvedUntil)}.`
      : `Not yet approved through the organisation's AI review (current status: ${uc.status.replace(/_/g, " ")}).`,
    uc.euAiActTier ? `Risk tier recorded in the organisation's EU AI Act screening: ${uc.euAiActTier}.` : "",
  ]
    .filter(Boolean)
    .join(" ");

  const claims = cards.flatMap((c) =>
    Object.entries(c.card.dataClaims ?? {})
      .filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
      .map(([k, v]) => `${c.agentName}, as its provider states it — ${k.replace(/_/g, " ")}: ${String(v)}`),
  );
  const dataUse = [`Data sensitivity recorded for this use case: ${uc.dataSensitivity}.`, ...claims].join("\n");

  const assessed = cards.flatMap((c) =>
    (c.card.biasFairness ?? []).map((b) => `${c.agentName} — ${b.dimension} (${b.method}): ${b.status.replace(/_/g, " ")}`),
  );
  const refs = [...new Set(cards.flatMap((c) => c.card.standardRefs ?? []))];
  const evaluationSummary =
    [
      ...assessed,
      refs.length ? `The model cards map their risk positions to: ${refs.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join("\n") || "No evaluation results are recorded yet on the model cards of the systems this use case uses.";

  return { title: uc.name.slice(0, 200), content: { purpose, limits, oversight, dataUse, evaluationSummary } };
}

// ---------------------------------------------------------------------------
// The public rate limit (per address; per grant inside the portal)
// ---------------------------------------------------------------------------

const publicBucket = new WeakMap<FastifyRequest, string>();
type Limiter = (req: FastifyRequest) => Promise<{ isExceeded: boolean; max: number; ttlInSeconds: number; timeWindow: number }>;

function trustLimiter(app: FastifyInstance): (req: FastifyRequest, reply: FastifyReply, bucket: string) => Promise<boolean> {
  let limiter: Limiter | null = null;
  const limits = (key: string) => (key.startsWith("trust:grant:") ? TRUST_PUBLIC_RATE_LIMITS.perGrant : TRUST_PUBLIC_RATE_LIMITS.perAddress);
  return async (req, reply, bucket) => {
    // the operator's REGULAIT_RATE_LIMIT switch turns every HTTP limiter off at once (tests run so)
    if (!app.hasDecorator("createRateLimit")) return false;
    limiter ??= app.createRateLimit({
      keyGenerator: (r: FastifyRequest) => publicBucket.get(r) ?? `trust:addr:${r.ip}`,
      max: (_r: FastifyRequest, k: string) => limits(k).max,
      timeWindow: (_r: FastifyRequest, k: string) => limits(k).windowMs,
      allowList: () => false,
    }) as unknown as Limiter;
    publicBucket.set(req, bucket);
    const v = await limiter(req);
    if (!v.isExceeded) return false;
    await reply
      .status(429)
      .header("retry-after", String(v.ttlInSeconds))
      .send({ error: "rate_limited", detail: "Too many requests. Wait a minute and try again.", retryAfterSeconds: v.ttlInSeconds });
    return true;
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const idParams = z.object({ publicationId: z.string().uuid() });
const grantParams = z.object({ grantId: z.string().uuid() });
const slugParams = z.object({ slug: z.string().max(80) });
const listQuery = z
  .object({ status: z.enum(TRUST_PUBLICATION_STATUSES).optional(), kind: z.enum(TRUST_PUBLICATION_KINDS).optional() })
  .strict();

const DISABLED = {
  error: "trust_pages_disabled",
  detail:
    "Public trust pages and auditor access are off for this organisation. An admin can turn them on (it needs you " +
    "to confirm it's you); until then nothing is published and no auditor can be given access.",
} as const;

const notFoundBody = { error: "not_found" } as const;

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, ADR-0225 block):
 *   GET    /v1/trust/publications                         admin
 *   POST   /v1/trust/publications/from-control            admin (a draft)
 *   POST   /v1/trust/publications/from-use-case           admin (a draft AI system card)
 *   PATCH  /v1/trust/publications/:publicationId          admin (drafts only)
 *   DELETE /v1/trust/publications/:publicationId          admin (drafts only)
 *   POST   /v1/trust/publications/:publicationId/publish  admin + step-up
 *   POST   /v1/trust/publications/:publicationId/unpublish admin + step-up
 *   GET    /v1/trust/sources                              admin (controls and use cases a draft can start from)
 *   GET    /v1/trust/profile                              admin
 *   PUT    /v1/trust/profile                              admin (+ step-up while the pages are on)
 *   GET    /v1/trust/auditor-grants                       admin
 *   POST   /v1/trust/auditor-grants                       admin + step-up (the sign-in link is shown once)
 *   GET    /v1/trust/auditor-grants/:grantId              admin (items and the audited views)
 *   POST   /v1/trust/auditor-grants/:grantId/links        admin + step-up (earlier unused links revoked)
 *   POST   /v1/trust/auditor-grants/:grantId/revoke       admin
 *   GET    /v1/trust-center                               PUBLIC (404 while off)
 *   POST   /v1/auditor/session                            PUBLIC (redeems a link; sets the session cookie)
 *   GET    /v1/auditor/session                            PUBLIC (cookie; the grant's items, audited)
 *   DELETE /v1/auditor/session                            PUBLIC (cookie; signs out)
 *   GET    /v1/auditor/items/:slug                        PUBLIC (cookie; one selected item, audited)
 */
export function registerTrustPagesRoutes(app: FastifyInstance, db: Db): void {
  const limitPublic = trustLimiter(app);

  async function loadPublication(reply: FastifyReply, id: string): Promise<TrustPublicationRow | null> {
    const [p] = await db.select().from(trustPublications).where(eq(trustPublications.id, id));
    if (!p) {
      await reply.status(404).send(notFoundBody);
      return null;
    }
    return p;
  }

  const stale = (reply: FastifyReply, p: TrustPublicationRow) =>
    reply.status(409).send({
      error: "version_conflict",
      detail: "This item changed since you opened it. Reload it and try again.",
      currentVersion: p.version,
    });

  // ---- admin: publications --------------------------------------------------
  app.get("/v1/trust/publications", async (req) => {
    const q = listQuery.parse(req.query);
    const where = and(
      q.status ? eq(trustPublications.status, q.status) : undefined,
      q.kind ? eq(trustPublications.kind, q.kind) : undefined,
    );
    const rows = await db.select().from(trustPublications).where(where).orderBy(desc(trustPublications.updatedAt)).limit(LIST_MAX + 1);
    const settings = await loadOrgSettings(db);
    return { enabled: settings.trustPagesEnabled, items: rows.slice(0, LIST_MAX).map(adminView), truncated: rows.length > LIST_MAX };
  });

  app.get("/v1/trust/sources", async () => {
    const packs = await db.select().from(compliancePacks).where(eq(compliancePacks.status, "active"));
    const controls = packs.length
      ? await db
          .select({
            packId: compliancePackControls.packId,
            controlRef: compliancePackControls.controlRef,
            title: compliancePackControls.title,
          })
          .from(compliancePackControls)
          .where(inArray(compliancePackControls.packId, packs.map((p) => p.id)))
          .limit(2000)
      : [];
    const byPack = new Map(packs.map((p) => [p.id, p]));
    const useCases = await db
      .select({ id: aiUseCases.id, name: aiUseCases.name, status: aiUseCases.status })
      .from(aiUseCases)
      .where(ne(aiUseCases.status, "retired"))
      .orderBy(aiUseCases.name)
      .limit(LIST_MAX);
    return {
      controls: controls.map((c) => ({ ...c, packTitle: byPack.get(c.packId)?.title ?? "", framework: byPack.get(c.packId)?.framework ?? "" })),
      useCases,
    };
  });

  async function insertDraft(req: FastifyRequest, kind: TrustPublicationKind, sourceRef: string, title: string, content: Record<string, string>) {
    return db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [p] = await tx
        .insert(trustPublications)
        .values({ kind, publicSlug: publicSlugFor(title), sourceRef, title, content, createdBy: req.authCtx.userId })
        .returning();
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "trust_publication",
        objectId: p!.id,
        ruleId: TRUST_RULE_IDS.drafted,
        reason: `trust page draft (${kind}) created from ${sourceRef}; nothing is published until an admin publishes it`,
        detail: { kind, sourceRef },
      });
      return p!;
    });
  }

  app.post("/v1/trust/publications/from-control", async (req, reply) => {
    const body = draftFromControlSchema.parse(req.body);
    const draft = await draftForControl(db, body.packId, body.controlRef);
    if (!draft) {
      return reply.status(404).send({ error: "control_not_found", detail: "No control with that reference in an active compliance pack." });
    }
    const p = await insertDraft(req, body.kind, `control:${body.packId}:${body.controlRef}`, draft.title, draft.content);
    return reply.status(201).send(adminView(p));
  });

  app.post("/v1/trust/publications/from-use-case", async (req, reply) => {
    const body = draftFromUseCaseSchema.parse(req.body);
    const draft = await draftForUseCase(db, body.useCaseId);
    if (!draft) {
      return reply.status(404).send({ error: "use_case_not_found", detail: "No use case with that id in the register, or it is retired." });
    }
    const p = await insertDraft(req, "ai_card", `use_case:${body.useCaseId}`, draft.title, draft.content);
    return reply.status(201).send(adminView(p));
  });

  app.patch("/v1/trust/publications/:publicationId", async (req, reply) => {
    const { publicationId } = idParams.parse(req.params);
    const body = updatePublicationSchema.parse(req.body);
    const p = await loadPublication(reply, publicationId);
    if (!p) return reply;
    if (p.status !== "draft") {
      return reply.status(409).send({
        error: "unpublish_first",
        detail: "A published item cannot be edited in place. Unpublish it, edit the draft, then publish it again.",
      });
    }
    let content: Record<string, string> | undefined;
    if (body.content) {
      const parsed = contentSchemaFor(p.kind as TrustPublicationKind).safeParse(body.content);
      if (!parsed.success) {
        return reply.status(400).send({
          error: "content_fields_mismatch",
          detail: `This item takes exactly these fields: ${contentFieldsFor(p.kind as TrustPublicationKind).join(", ")}.`,
        });
      }
      content = parsed.data as Record<string, string>;
    }
    const updated = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [u] = await tx
        .update(trustPublications)
        .set({
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(content ? { content } : {}),
          version: sql`${trustPublications.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(trustPublications.id, p.id),
            eq(trustPublications.version, body.expectedVersion),
            eq(trustPublications.status, "draft"),
          ),
        )
        .returning();
      if (!u) return null;
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "trust_publication",
        objectId: p.id,
        ruleId: TRUST_RULE_IDS.edited,
        reason: `trust page draft edited (version ${u.version})`,
        detail: { version: u.version, fields: [...(body.title !== undefined ? ["title"] : []), ...Object.keys(content ?? {})] },
      });
      return u;
    });
    if (!updated) return stale(reply, p);
    return adminView(updated);
  });

  app.delete("/v1/trust/publications/:publicationId", async (req, reply) => {
    const { publicationId } = idParams.parse(req.params);
    const p = await loadPublication(reply, publicationId);
    if (!p) return reply;
    if (p.status !== "draft") {
      return reply.status(409).send({ error: "unpublish_first", detail: "Unpublish this item before deleting it." });
    }
    const gone = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [d] = await tx
        .delete(trustPublications)
        .where(and(eq(trustPublications.id, p.id), eq(trustPublications.status, "draft")))
        .returning({ id: trustPublications.id });
      if (!d) return false;
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "trust_publication",
        objectId: p.id,
        ruleId: TRUST_RULE_IDS.deleted,
        reason: `trust page draft "${p.title}" deleted`,
        detail: { kind: p.kind, sourceRef: p.sourceRef },
      });
      return true;
    });
    if (!gone) return stale(reply, p);
    return reply.status(204).send();
  });

  app.post("/v1/trust/publications/:publicationId/publish", async (req, reply) => {
    const { publicationId } = idParams.parse(req.params);
    const body = publishPublicationSchema.parse(req.body);
    const p = await loadPublication(reply, publicationId);
    if (!p) return reply;
    const settings = await loadOrgSettings(db);
    if (!settings.trustPagesEnabled) return reply.status(409).send(DISABLED);
    if (p.version !== body.expectedVersion) return stale(reply, p);
    if (p.status === "published") {
      return reply.status(409).send({ error: "already_published", detail: "This item is already published. Unpublish it first to change it." });
    }
    // the content must carry every field of its kind, and say nothing that claims a certification or compliance
    const shape = contentSchemaFor(p.kind as TrustPublicationKind).safeParse(p.content);
    const empty = contentFieldsFor(p.kind as TrustPublicationKind).filter((f) => !(p.content[f] ?? "").trim());
    const claims = wordingProblems(p.title, p.content);
    if (!shape.success || empty.length || claims.length) {
      await audit(db, {
        userId: req.authCtx.userId,
        objectType: "trust_publication",
        objectId: p.id,
        ruleId: TRUST_RULE_IDS.publishRefused,
        effect: "deny",
        reason: claims.length
          ? `trust page publish refused: the text uses claim wording (${claims.join(", ")})`
          : `trust page publish refused: empty fields (${empty.join(", ")})`,
        detail: { claims, empty },
      });
      if (claims.length) {
        return reply.status(422).send({
          error: "claim_wording",
          detail:
            `Trust pages state facts and never claim a certification or compliance. Remove or reword: ${claims.join(", ")}. ` +
            "Describe the control and the evidence on record instead.",
          words: claims,
        });
      }
      return reply.status(422).send({
        error: "incomplete_content",
        detail: `Fill in every field before publishing: ${empty.map((f) => TRUST_CONTENT_LABELS[f]).join(", ")}.`,
        fields: empty,
      });
    }
    const stepUp = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { action: "trust_publish", publicationId: p.id, version: p.version, audience: body.audience },
    });
    if (!stepUp.ok) return reply;
    const now = new Date();
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [u] = await tx
        .update(trustPublications)
        .set({ status: "published", audience: body.audience, publishedAt: now, publishedBy: req.authCtx.userId, updatedAt: now })
        .where(
          and(eq(trustPublications.id, p.id), eq(trustPublications.version, body.expectedVersion), eq(trustPublications.status, "draft")),
        )
        .returning();
      if (!u) return null;
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "trust_publication",
        objectId: p.id,
        ruleId: TRUST_RULE_IDS.published,
        reason:
          body.audience === "public"
            ? `trust page item "${p.title}" published on the public trust centre`
            : `trust page item "${p.title}" published for selected auditors only`,
        detail: { kind: p.kind, audience: body.audience, version: p.version, slug: p.publicSlug, stepUp: stepUp.method },
      });
      return u;
    });
    if (!out) return stale(reply, p);
    return adminView(out);
  });

  app.post("/v1/trust/publications/:publicationId/unpublish", async (req, reply) => {
    const { publicationId } = idParams.parse(req.params);
    const body = unpublishPublicationSchema.parse(req.body);
    const p = await loadPublication(reply, publicationId);
    if (!p) return reply;
    if (p.version !== body.expectedVersion) return stale(reply, p);
    if (p.status !== "published") return reply.status(409).send({ error: "not_published", detail: "This item is not published." });
    const stepUp = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: { action: "trust_unpublish", publicationId: p.id, version: p.version },
    });
    if (!stepUp.ok) return reply;
    const now = new Date();
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // unpublishing makes a new draft version, so a later publish is a fresh decision on what is there now
      const [u] = await tx
        .update(trustPublications)
        .set({ status: "draft", publishedAt: null, publishedBy: null, version: sql`${trustPublications.version} + 1`, updatedAt: now })
        .where(
          and(eq(trustPublications.id, p.id), eq(trustPublications.version, body.expectedVersion), eq(trustPublications.status, "published")),
        )
        .returning();
      if (!u) return null;
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "trust_publication",
        objectId: p.id,
        ruleId: TRUST_RULE_IDS.unpublished,
        reason: `trust page item "${p.title}" unpublished; it is no longer shown publicly or to auditors`,
        detail: { kind: p.kind, audience: p.audience, slug: p.publicSlug, stepUp: stepUp.method },
      });
      return u;
    });
    if (!out) return stale(reply, p);
    return adminView(out);
  });

  // ---- admin: the trust centre's heading -------------------------------------
  app.get("/v1/trust/profile", async () => {
    const [row] = await db.select().from(trustCenterProfile);
    const settings = await loadOrgSettings(db);
    return {
      enabled: settings.trustPagesEnabled,
      profile: row ? { displayName: row.displayName, intro: row.intro, contactEmail: row.contactEmail, updatedAt: row.updatedAt.toISOString() } : null,
    };
  });

  app.put("/v1/trust/profile", async (req, reply) => {
    const body = trustProfileSchema.parse(req.body);
    const claims = claimWordingProblems(`${body.displayName}\n${body.intro}`);
    if (claims.length) {
      return reply.status(422).send({
        error: "claim_wording",
        detail: `Trust pages never claim a certification or compliance. Remove or reword: ${claims.join(", ")}.`,
        words: claims,
      });
    }
    const settings = await loadOrgSettings(db);
    // while the pages are on, the heading is live public text: changing it is a publication
    if (settings.trustPagesEnabled) {
      const stepUp = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { action: "trust_profile", ...body } });
      if (!stepUp.ok) return reply;
    }
    const now = new Date();
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx
        .insert(trustCenterProfile)
        .values({ id: "singleton", ...body, updatedBy: req.authCtx.userId, updatedAt: now })
        .onConflictDoUpdate({ target: trustCenterProfile.id, set: { ...body, updatedBy: req.authCtx.userId, updatedAt: now } });
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "trust_center",
        objectId: null,
        ruleId: TRUST_RULE_IDS.profileUpdated,
        reason: `trust centre heading set to "${body.displayName}"${settings.trustPagesEnabled ? " (live)" : " (the pages are off)"}`,
        detail: { displayName: body.displayName, introChars: body.intro.length, contactEmailSet: body.contactEmail !== null },
      });
    });
    return { profile: { ...body, updatedAt: now.toISOString() } };
  });

  // ---- admin: auditor grants -------------------------------------------------
  async function viewCounts(grantIds: string[]): Promise<Map<string, { views: number; lastViewedAt: string | null }>> {
    if (!grantIds.length) return new Map();
    const rows = await db
      .select({ grantId: auditLog.objectId, views: count(), last: sql<string | null>`max(${auditLog.at})` })
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "auditor_grant"), eq(auditLog.ruleId, TRUST_RULE_IDS.itemViewed), inArray(auditLog.objectId, grantIds)))
      .groupBy(auditLog.objectId);
    return new Map(
      rows.map((r) => [r.grantId!, { views: Number(r.views), lastViewedAt: r.last ? new Date(r.last).toISOString() : null }]),
    );
  }

  const grantView = (g: AuditorGrantRow, now: Date, extra: { items: number; views: number; lastViewedAt: string | null }) => ({
    id: g.id,
    auditorName: g.auditorName,
    auditorEmail: g.auditorEmail,
    auditorOrganisation: g.auditorOrganisation,
    startsAt: g.startsAt.toISOString(),
    expiresAt: g.expiresAt.toISOString(),
    revokedAt: g.revokedAt?.toISOString() ?? null,
    state: grantState(g, now),
    createdBy: g.createdBy,
    createdAt: g.createdAt.toISOString(),
    ...extra,
  });

  app.get("/v1/trust/auditor-grants", async () => {
    const grants = await db.select().from(auditorGrants).orderBy(desc(auditorGrants.createdAt)).limit(LIST_MAX);
    const ids = grants.map((g) => g.id);
    const itemCounts = ids.length
      ? await db
          .select({ grantId: auditorGrantItems.grantId, n: count() })
          .from(auditorGrantItems)
          .where(inArray(auditorGrantItems.grantId, ids))
          .groupBy(auditorGrantItems.grantId)
      : [];
    const items = new Map(itemCounts.map((r) => [r.grantId, Number(r.n)]));
    const views = await viewCounts(ids);
    const now = new Date();
    const settings = await loadOrgSettings(db);
    return {
      enabled: settings.trustPagesEnabled,
      grants: grants.map((g) =>
        grantView(g, now, { items: items.get(g.id) ?? 0, views: views.get(g.id)?.views ?? 0, lastViewedAt: views.get(g.id)?.lastViewedAt ?? null }),
      ),
    };
  });

  app.get("/v1/trust/auditor-grants/:grantId", async (req, reply) => {
    const { grantId } = grantParams.parse(req.params);
    const [g] = await db.select().from(auditorGrants).where(eq(auditorGrants.id, grantId));
    if (!g) return reply.status(404).send(notFoundBody);
    const items = await db
      .select({ id: trustPublications.id, title: trustPublications.title, kind: trustPublications.kind, status: trustPublications.status })
      .from(auditorGrantItems)
      .innerJoin(trustPublications, eq(trustPublications.id, auditorGrantItems.publicationId))
      .where(eq(auditorGrantItems.grantId, grantId));
    const recent = await db
      .select({ at: auditLog.at, ruleId: auditLog.ruleId, reason: auditLog.reason, effect: auditLog.effect })
      .from(auditLog)
      .where(and(eq(auditLog.objectType, "auditor_grant"), eq(auditLog.objectId, grantId)))
      .orderBy(desc(auditLog.seq))
      .limit(100);
    const links = await db
      .select({ id: auditorLinks.id, expiresAt: auditorLinks.expiresAt, usedAt: auditorLinks.usedAt, revokedAt: auditorLinks.revokedAt, createdAt: auditorLinks.createdAt })
      .from(auditorLinks)
      .where(eq(auditorLinks.grantId, grantId))
      .orderBy(desc(auditorLinks.createdAt))
      .limit(20);
    const v = (await viewCounts([grantId])).get(grantId);
    return {
      grant: grantView(g, new Date(), { items: items.length, views: v?.views ?? 0, lastViewedAt: v?.lastViewedAt ?? null }),
      items,
      links: links.map((l) => ({
        id: l.id,
        createdAt: l.createdAt.toISOString(),
        expiresAt: l.expiresAt.toISOString(),
        usedAt: l.usedAt?.toISOString() ?? null,
        revokedAt: l.revokedAt?.toISOString() ?? null,
      })),
      activity: recent.map((r) => ({ at: r.at.toISOString(), ruleId: r.ruleId, reason: r.reason, effect: r.effect })),
    };
  });

  /** inserts a link for the grant (revoking its earlier unused links) and returns the one-time token */
  async function issueLink(tx: Db, grantId: string, ttlHours: number, userId: string | null, now: Date) {
    await tx
      .update(auditorLinks)
      .set({ revokedAt: now })
      .where(and(eq(auditorLinks.grantId, grantId), isNull(auditorLinks.usedAt), isNull(auditorLinks.revokedAt)));
    const { token, tokenHash } = generateAuditorLinkToken();
    const expiresAt = new Date(now.getTime() + ttlHours * HOUR_MS);
    const [l] = await tx.insert(auditorLinks).values({ grantId, tokenHash, expiresAt, createdBy: userId, createdAt: now }).returning();
    return { token, link: l! };
  }

  app.post("/v1/trust/auditor-grants", async (req, reply) => {
    const body = createAuditorGrantSchema.parse(req.body);
    const settings = await loadOrgSettings(db);
    if (!settings.trustPagesEnabled) return reply.status(409).send(DISABLED);
    const now = new Date();
    const startsAt = body.startsAt ? new Date(body.startsAt) : now;
    if (startsAt.getTime() < now.getTime() - 60_000) {
      return reply.status(400).send({ error: "start_in_past", detail: "The access window cannot start in the past." });
    }
    const expiresAt = new Date(startsAt.getTime() + body.days * DAY_MS);
    // default-deny scope: every selected item must exist and be published (either audience)
    const selected = await db
      .select({ id: trustPublications.id, status: trustPublications.status })
      .from(trustPublications)
      .where(inArray(trustPublications.id, body.publicationIds));
    const published = new Set(selected.filter((s) => s.status === "published").map((s) => s.id));
    const notPublished = body.publicationIds.filter((id) => !published.has(id));
    if (notPublished.length) {
      return reply.status(422).send({
        error: "items_not_published",
        detail: "An auditor can only be given published items. Publish these first, or leave them out.",
        publicationIds: notPublished,
      });
    }
    const stepUp = await requireStepUp(db, req, reply, {
      kind: "settings_relax",
      facts: {
        action: "auditor_grant",
        auditorEmail: body.auditorEmail,
        days: body.days,
        publicationIds: [...body.publicationIds].sort(),
      },
    });
    if (!stepUp.ok) return reply;
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [g] = await tx
        .insert(auditorGrants)
        .values({
          auditorName: body.auditorName,
          auditorEmail: body.auditorEmail,
          auditorOrganisation: body.auditorOrganisation,
          startsAt,
          expiresAt,
          createdBy: req.authCtx.userId,
          createdAt: now,
        })
        .returning();
      await tx.insert(auditorGrantItems).values(body.publicationIds.map((publicationId) => ({ grantId: g!.id, publicationId })));
      const issued = await issueLink(tx, g!.id, body.linkTtlHours, req.authCtx.userId, now);
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "auditor_grant",
        objectId: g!.id,
        ruleId: TRUST_RULE_IDS.grantCreated,
        reason:
          `read-only access for auditor ${body.auditorName} <${body.auditorEmail}> to ${body.publicationIds.length} item(s), ` +
          `${fmtDate(startsAt)} to ${fmtDate(expiresAt)}; a sign-in link valid ${body.linkTtlHours} hour(s) was issued`,
        detail: {
          publicationIds: body.publicationIds,
          startsAt: startsAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          linkId: issued.link.id,
          linkExpiresAt: issued.link.expiresAt.toISOString(),
          stepUp: stepUp.method,
        },
      });
      return { grant: g!, ...issued };
    });
    return reply.status(201).send({
      grant: grantView(out.grant, now, { items: body.publicationIds.length, views: 0, lastViewedAt: null }),
      link: { path: `/ui/audit#${out.token}`, expiresAt: out.link.expiresAt.toISOString(), shownOnce: true },
    });
  });

  app.post("/v1/trust/auditor-grants/:grantId/links", async (req, reply) => {
    const { grantId } = grantParams.parse(req.params);
    const body = newAuditorLinkSchema.parse(req.body ?? {});
    const settings = await loadOrgSettings(db);
    if (!settings.trustPagesEnabled) return reply.status(409).send(DISABLED);
    const [g] = await db.select().from(auditorGrants).where(eq(auditorGrants.id, grantId));
    if (!g) return reply.status(404).send(notFoundBody);
    const now = new Date();
    const state = grantState(g, now);
    if (state === "revoked" || state === "expired") {
      return reply.status(409).send({ error: `grant_${state}`, detail: `This access is ${state}. Create a new grant instead.` });
    }
    const stepUp = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { action: "auditor_link", grantId } });
    if (!stepUp.ok) return reply;
    const out = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const issued = await issueLink(tx, grantId, body.linkTtlHours, req.authCtx.userId, now);
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "auditor_grant",
        objectId: grantId,
        ruleId: TRUST_RULE_IDS.linkIssued,
        reason: `new sign-in link for auditor ${g.auditorName}, valid ${body.linkTtlHours} hour(s); earlier unused links revoked`,
        detail: { linkId: issued.link.id, linkExpiresAt: issued.link.expiresAt.toISOString(), stepUp: stepUp.method },
      });
      return issued;
    });
    return reply.status(201).send({ link: { path: `/ui/audit#${out.token}`, expiresAt: out.link.expiresAt.toISOString(), shownOnce: true } });
  });

  app.post("/v1/trust/auditor-grants/:grantId/revoke", async (req, reply) => {
    const { grantId } = grantParams.parse(req.params);
    const [g] = await db.select().from(auditorGrants).where(eq(auditorGrants.id, grantId));
    if (!g) return reply.status(404).send(notFoundBody);
    if (g.revokedAt) return { id: grantId, revokedAt: g.revokedAt.toISOString(), changed: false };
    const now = new Date();
    await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      await tx.update(auditorGrants).set({ revokedAt: now }).where(and(eq(auditorGrants.id, grantId), isNull(auditorGrants.revokedAt)));
      await tx.update(auditorLinks).set({ revokedAt: now }).where(and(eq(auditorLinks.grantId, grantId), isNull(auditorLinks.revokedAt)));
      await tx.update(auditorSessions).set({ revokedAt: now }).where(and(eq(auditorSessions.grantId, grantId), isNull(auditorSessions.revokedAt)));
      await audit(tx, {
        userId: req.authCtx.userId,
        objectType: "auditor_grant",
        objectId: grantId,
        ruleId: TRUST_RULE_IDS.grantRevoked,
        reason: `access for auditor ${g.auditorName} revoked; open sessions and unused links end now`,
        detail: { auditorEmail: g.auditorEmail },
      });
    });
    return { id: grantId, revokedAt: now.toISOString(), changed: true };
  });

  // ---- PUBLIC: the trust centre ------------------------------------------------
  app.get("/v1/trust-center", async (req, reply) => {
    const settings = await loadOrgSettings(db);
    if (!settings.trustPagesEnabled) return reply.status(404).send(notFoundBody);
    if (await limitPublic(req, reply, `trust:addr:${req.ip}`)) return reply;
    const [profile] = await db.select().from(trustCenterProfile);
    const rows = await db
      .select()
      .from(trustPublications)
      .where(and(eq(trustPublications.status, "published"), eq(trustPublications.audience, "public")))
      .orderBy(trustPublications.kind, trustPublications.title)
      .limit(LIST_MAX);
    const body: PublicTrustCenter = {
      displayName: profile?.displayName ?? "Trust centre",
      intro: profile?.intro ?? "",
      contactEmail: profile?.contactEmail ?? null,
      items: rows.map(publicView),
      disclaimer: TRUST_PAGE_DISCLAIMER,
    };
    // the same for every reader and nothing personal, so a shared cache may hold it briefly; an unpublished item
    // leaves the page within five minutes
    return reply.header("cache-control", "public, max-age=300").header("referrer-policy", "no-referrer").send(body);
  });

  // ---- PUBLIC: the auditor portal -----------------------------------------------
  const auditorCookie = (token: string, secure: boolean, maxAgeSeconds: number) =>
    `${AUDITOR_SESSION_COOKIE}=${token}; Path=/v1/auditor; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` + (secure ? "; Secure" : "");
  const clearAuditorCookie = (secure: boolean) =>
    `${AUDITOR_SESSION_COOKIE}=; Path=/v1/auditor; HttpOnly; SameSite=Strict; Max-Age=0` + (secure ? "; Secure" : "");
  const noStore = (reply: FastifyReply) => reply.header("cache-control", "no-store").header("referrer-policy", "no-referrer");
  const SIGNED_OUT = {
    error: "auditor_session_required",
    detail: "Your session has ended. Ask the organisation for a new sign-in link.",
  } as const;

  /** the auditor session a request carries, or null with the reply sent (404 while off, 401 otherwise) */
  async function auditorSession(req: FastifyRequest, reply: FastifyReply) {
    noStore(reply);
    const settings = await loadOrgSettings(db);
    if (!settings.trustPagesEnabled) {
      await reply.status(404).send(notFoundBody);
      return null;
    }
    if (await limitPublic(req, reply, `trust:addr:${req.ip}`)) return null;
    const token = readCookie(req.headers.cookie, AUDITOR_SESSION_COOKIE);
    if (!token || !SESSION_TOKEN_RE.test(token)) {
      await reply.status(401).send(SIGNED_OUT);
      return null;
    }
    const [row] = await db
      .select({ session: auditorSessions, grant: auditorGrants })
      .from(auditorSessions)
      .innerJoin(auditorGrants, eq(auditorGrants.id, auditorSessions.grantId))
      .where(eq(auditorSessions.tokenHash, hashToken(token)));
    const now = new Date();
    if (!row || row.session.revokedAt || row.session.expiresAt <= now || grantState(row.grant, now) !== "active") {
      void reply.header("set-cookie", clearAuditorCookie(requestIsSecure(req)));
      await reply.status(401).send(SIGNED_OUT);
      return null;
    }
    if (await limitPublic(req, reply, `trust:grant:${row.grant.id}`)) return null;
    return row;
  }

  app.post("/v1/auditor/session", { bodyLimit: 4 * 1024 }, async (req, reply) => {
    noStore(reply);
    const settings = await loadOrgSettings(db);
    if (!settings.trustPagesEnabled) return reply.status(404).send(notFoundBody);
    if (await limitPublic(req, reply, `trust:addr:${req.ip}`)) return reply;
    if (req.headers[CSRF_HEADER] !== "1") {
      return reply.status(403).send({ error: "csrf_header_required", detail: `requests must carry ${CSRF_HEADER}: 1` });
    }
    const parsed = redeemAuditorLinkSchema.safeParse(req.body);
    const gone = { error: "link_not_valid", detail: "This sign-in link is not valid, has been used, or has expired. Ask the organisation for a new one." };
    if (!parsed.success || !LINK_TOKEN_RE.test(parsed.data.token)) return reply.status(401).send(gone);
    const now = new Date();
    const [row] = await db
      .select({ link: auditorLinks, grant: auditorGrants })
      .from(auditorLinks)
      .innerJoin(auditorGrants, eq(auditorGrants.id, auditorLinks.grantId))
      .where(eq(auditorLinks.tokenHash, hashToken(parsed.data.token)));
    if (!row) return reply.status(401).send(gone);
    const state = grantState(row.grant, now);
    const linkLive = !row.link.usedAt && !row.link.revokedAt && row.link.expiresAt > now;
    if (!linkLive || state !== "active") {
      await audit(db, {
        userId: null,
        objectType: "auditor_grant",
        objectId: row.grant.id,
        ruleId: TRUST_RULE_IDS.linkRefused,
        effect: "deny",
        reason: `auditor sign-in refused: ${!linkLive ? "the link was used, revoked or expired" : `the access is ${state}`}`,
        detail: { linkId: row.link.id, grantState: state, clientIp: req.ip ?? null },
      });
      return reply.status(401).send(
        state === "scheduled"
          ? { error: "access_not_started", detail: `Your access starts on ${fmtDate(row.grant.startsAt)}. Use a new link from then.` }
          : gone,
      );
    }
    const expiresAt = new Date(Math.min(now.getTime() + AUDITOR_SESSION_MINUTES * 60_000, row.grant.expiresAt.getTime()));
    const session = generateAuditorSessionToken();
    const ok = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      // single use: only the first redemption of a live link wins
      const [spent] = await tx
        .update(auditorLinks)
        .set({ usedAt: now })
        .where(
          and(
            eq(auditorLinks.id, row.link.id),
            isNull(auditorLinks.usedAt),
            isNull(auditorLinks.revokedAt),
            sql`${auditorLinks.expiresAt} > ${now}`,
          ),
        )
        .returning({ id: auditorLinks.id });
      if (!spent) return false;
      await tx.insert(auditorSessions).values({ grantId: row.grant.id, linkId: row.link.id, tokenHash: session.tokenHash, expiresAt, createdAt: now });
      await audit(tx, {
        userId: null,
        objectType: "auditor_grant",
        objectId: row.grant.id,
        ruleId: TRUST_RULE_IDS.linkRedeemed,
        reason: `auditor ${row.grant.auditorName} signed in with a single-use link; the session ends ${expiresAt.toISOString()}`,
        detail: { linkId: row.link.id, sessionExpiresAt: expiresAt.toISOString(), clientIp: req.ip ?? null },
      });
      return true;
    });
    if (!ok) return reply.status(401).send(gone);
    const maxAge = Math.max(1, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
    void reply.header("set-cookie", auditorCookie(session.token, requestIsSecure(req), maxAge));
    return reply.status(201).send({ sessionExpiresAt: expiresAt.toISOString() });
  });

  app.get("/v1/auditor/session", async (req, reply) => {
    const s = await auditorSession(req, reply);
    if (!s) return reply;
    const items = await db
      .select({ slug: trustPublications.publicSlug, kind: trustPublications.kind, title: trustPublications.title, publishedAt: trustPublications.publishedAt })
      .from(auditorGrantItems)
      .innerJoin(trustPublications, eq(trustPublications.id, auditorGrantItems.publicationId))
      .where(and(eq(auditorGrantItems.grantId, s.grant.id), eq(trustPublications.status, "published")))
      .orderBy(trustPublications.kind, trustPublications.title);
    await audit(db, {
      userId: null,
      objectType: "auditor_grant",
      objectId: s.grant.id,
      ruleId: TRUST_RULE_IDS.portalOpened,
      reason: `auditor ${s.grant.auditorName} opened the portal (${items.length} item(s) listed)`,
      detail: { sessionId: s.session.id, items: items.length, clientIp: req.ip ?? null },
    });
    const [profile] = await db.select({ displayName: trustCenterProfile.displayName }).from(trustCenterProfile);
    return {
      organisation: profile?.displayName ?? null,
      auditorName: s.grant.auditorName,
      accessEndsAt: s.grant.expiresAt.toISOString(),
      sessionEndsAt: s.session.expiresAt.toISOString(),
      items: items.map((i) => ({ slug: i.slug, kind: i.kind, title: i.title, publishedAt: i.publishedAt!.toISOString() })),
      disclaimer: TRUST_PAGE_DISCLAIMER,
    };
  });

  app.get("/v1/auditor/items/:slug", async (req, reply) => {
    const s = await auditorSession(req, reply);
    if (!s) return reply;
    const { slug } = slugParams.parse(req.params);
    const [row] = SLUG_RE.test(slug)
      ? await db
          .select({ p: trustPublications })
          .from(auditorGrantItems)
          .innerJoin(trustPublications, eq(trustPublications.id, auditorGrantItems.publicationId))
          .where(
            and(
              eq(auditorGrantItems.grantId, s.grant.id),
              eq(trustPublications.publicSlug, slug),
              eq(trustPublications.status, "published"),
            ),
          )
      : [];
    if (!row) {
      // default-deny: an item outside the grant, unpublished or unknown answers the same 404, and is recorded
      await audit(db, {
        userId: null,
        objectType: "auditor_grant",
        objectId: s.grant.id,
        ruleId: TRUST_RULE_IDS.viewRefused,
        effect: "deny",
        reason: `auditor ${s.grant.auditorName} asked for an item outside the access, or no longer published`,
        detail: { sessionId: s.session.id, slug: slug.slice(0, 80), clientIp: req.ip ?? null },
      });
      return reply.status(404).send(notFoundBody);
    }
    await audit(db, {
      userId: null,
      objectType: "auditor_grant",
      objectId: s.grant.id,
      ruleId: TRUST_RULE_IDS.itemViewed,
      reason: `auditor ${s.grant.auditorName} viewed "${row.p.title}"`,
      detail: { sessionId: s.session.id, publicationId: row.p.id, slug: row.p.publicSlug, clientIp: req.ip ?? null },
    });
    return publicView(row.p);
  });

  app.delete("/v1/auditor/session", async (req, reply) => {
    noStore(reply);
    if (req.headers[CSRF_HEADER] !== "1") {
      return reply.status(403).send({ error: "csrf_header_required", detail: `requests must carry ${CSRF_HEADER}: 1` });
    }
    const token = readCookie(req.headers.cookie, AUDITOR_SESSION_COOKIE);
    if (token && SESSION_TOKEN_RE.test(token)) {
      const now = new Date();
      await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [s] = await tx
          .update(auditorSessions)
          .set({ revokedAt: now })
          .where(and(eq(auditorSessions.tokenHash, hashToken(token)), isNull(auditorSessions.revokedAt)))
          .returning({ id: auditorSessions.id, grantId: auditorSessions.grantId });
        if (s) {
          await audit(tx, {
            userId: null,
            objectType: "auditor_grant",
            objectId: s.grantId,
            ruleId: TRUST_RULE_IDS.signedOut,
            reason: "auditor signed out",
            detail: { sessionId: s.id },
          });
        }
      });
    }
    void reply.header("set-cookie", clearAuditorCookie(requestIsSecure(req)));
    return { ok: true };
  });
}
