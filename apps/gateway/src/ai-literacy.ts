/**
 * ADR-0182 (ADR-0175 batch D4) A14 — AI LITERACY AND ACCEPTABLE-USE ACKNOWLEDGEMENTS. OWNER: A14 (D4).
 *
 * Regulation (EU) 2024/1689, Article 4 as replaced by Regulation (EU) 2026/1744: providers and deployers "take
 * measures to support the development of AI literacy" of the people who operate and use AI systems on their
 * behalf; the Article "does not require providers or deployers to guarantee any specific level of AI literacy of
 * any individual". This module records one such measure. It never claims to measure literacy itself.
 *
 *   DOCUMENTS   versioned AI policies (`acceptable_use`) and trainings (`training`), each a link or an
 *               attachment, with an audience (everyone, teams, roles; SCIM groups arrive through the team and role
 *               mappings) and a validity. A version is a draft until an admin publishes it; publishing the next
 *               version retires the previous one; an admin may retire a key altogether. Every change is audited.
 *   MATERIAL vs EDITORIAL  a new published version needs every person to acknowledge again (no grace period,
 *               owner decision 3). The ONE relief is an admin marking the version editorial, with a reason: that is
 *               audited as a relaxation with `detail.transitions`, and acknowledgements of the version it replaced
 *               keep counting (shared `acceptedVersions`).
 *   ACKNOWLEDGEMENTS  a person acknowledges for themselves only, naming the version and the digest they saw; an
 *               admin may record a completion from an external training system (`training_completed` /
 *               `admin_recorded`) with its evidence reference. Each expires after the document's validity, or the
 *               org's `literacy_default_validity_days` (strict 365).
 *   ENFORCEMENT `literacyPostureFor` fills the kernel's `ExecutionPosture.literacy` slot for `governedEvaluate`.
 *               Under `literacy_gate_mode = enforce` (strict default) a human-originated governed call by a person
 *               who is not current is refused `ai-literacy-not-current` (audited by the caller's decision row; the
 *               reason names the documents). Agents and automations a person runs or owns are evaluated AS that
 *               person, so they inherit that person's status (owner decision 3). Exempt: platform sweeps and
 *               evaluation dispatches (`origin`), the bootstrap identity (it has no user and cannot call tools; a
 *               `bootstrap` session origin is exempt too), and a break-glass SESSION (a listed admin's password
 *               sign-in while SSO is enforced; being listed alone exempts nothing), which is traced on the decision
 *               and so audited. Wired into every governed path: MCP tools (`governedEvaluate`), model dispatch,
 *               connector calls (`literacySlot` / `withLiteracyPosture`). With no applicable
 *               published document nothing changes, so a fresh install works exactly as before.
 *   ABAC        `aiTrainingCurrentFor` is the Cedar v3 principal attribute, built by `assembleAbacRequest` (the one
 *               place enforcement and simulation build the bag).
 *   MONITOR     `literacy_coverage_gap` (low, observe-only): a published document with coverage below 100% of its
 *               audience.
 *   SWEEP       `literacy-expiry-sweep`: one audited notice per acknowledgement entering the 14-day window; the
 *               person sees it in the interstitial and on their Account page.
 *
 * Open source first: considered xAPI (Experience API) statement ingest and SCORM runtimes for training completion;
 * none fits, because regulAIt records acknowledgements and completions and does not deliver training (an xAPI
 * import is a later adapter). Cedar (existing, Apache-2.0) carries the attribute. Dates are native `Date` in UTC.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aiPolicyAcknowledgements,
  aiPolicyDocuments,
  and,
  asc,
  auditLog,
  count,
  desc,
  eq,
  inArray,
  isNull,
  roleAssignments,
  sql,
  teamMembers,
  users,
  type AiPolicyDocumentRow,
  type Db,
  type OrgSettingsRow,
} from "@regulait/db";
import {
  ACCOUNTABILITY_STRICT_DEFAULTS,
  acceptedVersions,
  ackExpiresAt,
  acknowledgeAiPolicySchema,
  aiPolicyContentDigest,
  aiTrainingCurrentOf,
  audienceIncludes,
  coveragePct,
  createAiPolicySchema,
  expiresWithinNotice,
  literacyMissing,
  literacyStatusOf,
  publishAiPolicySchema,
  recordAiPolicyCompletionSchema,
  LITERACY_EXPIRY_NOTICE_DAYS,
  type AccountabilityGateMode,
  type AccountabilityMonitorRuleId,
  type LiteracyAckInput,
  type LiteracyDocumentInput,
  type LiteracyDocumentStanding,
  type MonitorAssuranceInput,
  type MonitorAssuranceSubject,
} from "@regulait/shared";
import {
  LITERACY_BREAK_GLASS_RULE_ID,
  LITERACY_NOT_REQUIRED,
  LITERACY_RULE_ID,
  literacyGate,
  type ExecutionPosture,
  type LiteracyPosture,
} from "@regulait/policy-kernel";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { abacPrincipalFromRequest, type AbacPrincipalContext } from "./abac-principal.js";
import { loadScopeMemberships } from "./entitlements.js";
import { loadOrgSettings } from "./org-settings.js";
import { settingTransitions } from "./setting-transitions.js";

export const LITERACY_EXPIRY_SWEEP_JOB_NAME = "literacy-expiry-sweep";

/** the audit rule ids this module writes (stable; an operator may alert on each) */
export const AI_LITERACY_RULE_IDS = {
  created: "ai-policy-created",
  published: "ai-policy-published",
  retired: "ai-policy-retired",
  acknowledged: "ai-policy-acknowledged",
  acknowledgeRefused: "ai-policy-acknowledge-refused",
  recordRefused: "ai-policy-completion-record-refused",
  recorded: "ai-policy-completion-recorded",
  coverageRead: "ai-policy-coverage-read",
  expiryNotice: "ai-literacy-expiry-notice",
} as const;

/** who originated a governed call, as far as the literacy gate is concerned */
export type GovernedCallOrigin = "human" | "evaluation" | "platform";

const NO_IDENTITY = "00000000-0000-0000-0000-000000000000";

// ---------------------------------------------------------------------------
// Loading: published documents, their editorial chains, acknowledgements
// ---------------------------------------------------------------------------

/** a published document with the versions whose acknowledgements count for it */
interface PublishedChain {
  doc: AiPolicyDocumentRow;
  accepted: number[];
}

async function loadPublishedChains(db: Db): Promise<PublishedChain[]> {
  const published = await db
    .select()
    .from(aiPolicyDocuments)
    .where(eq(aiPolicyDocuments.status, "published"))
    .orderBy(asc(aiPolicyDocuments.key));
  if (published.length === 0) return [];
  const history = await db
    .select({
      key: aiPolicyDocuments.key,
      version: aiPolicyDocuments.version,
      editorial: aiPolicyDocuments.editorial,
      publishedAt: aiPolicyDocuments.publishedAt,
    })
    .from(aiPolicyDocuments)
    .where(inArray(aiPolicyDocuments.key, [...new Set(published.map((d) => d.key))]));
  return published.map((doc) => ({
    doc,
    accepted: acceptedVersions(
      history.filter((h) => h.key === doc.key),
      doc.version,
    ),
  }));
}

/** every acknowledgement the given people hold on the given keys (any version) */
async function loadAcks(
  db: Db,
  userIds: readonly string[] | null,
  keys: readonly string[],
): Promise<Array<LiteracyAckInput & { userId: string; id: string; evidenceRef: string | null }>> {
  if (keys.length === 0 || (userIds !== null && userIds.length === 0)) return [];
  const where = [inArray(aiPolicyDocuments.key, [...keys])];
  if (userIds !== null) where.push(inArray(aiPolicyAcknowledgements.userId, [...userIds]));
  return db
    .select({
      id: aiPolicyAcknowledgements.id,
      userId: aiPolicyAcknowledgements.userId,
      key: aiPolicyDocuments.key,
      version: aiPolicyAcknowledgements.version,
      method: aiPolicyAcknowledgements.method,
      acknowledgedAt: aiPolicyAcknowledgements.acknowledgedAt,
      expiresAt: aiPolicyAcknowledgements.expiresAt,
      evidenceRef: aiPolicyAcknowledgements.evidenceRef,
    })
    .from(aiPolicyAcknowledgements)
    .innerJoin(aiPolicyDocuments, eq(aiPolicyDocuments.id, aiPolicyAcknowledgements.documentId))
    .where(and(...where));
}

const inputOf = (c: PublishedChain): LiteracyDocumentInput => ({
  documentId: c.doc.id,
  key: c.doc.key,
  version: c.doc.version,
  kind: c.doc.kind,
  title: c.doc.title,
  acceptedVersions: c.accepted,
});

/** one applicable document as a person sees it: their standing plus what they need to acknowledge it */
export interface LiteracyDocumentView extends LiteracyDocumentStanding {
  url: string | null;
  attachmentId: string | null;
  contentDigest: string;
  validityDays: number;
  editorial: boolean;
  /** the acknowledgement that counts expires within the notice window (14 days) */
  expiresSoon: boolean;
}

export interface LiteracyStatusView {
  required: boolean;
  current: boolean;
  documents: LiteracyDocumentView[];
}

/**
 * A person's literacy status, from the stored rows (the gateway half of `aiLiteracyCurrent(user)`).
 * Two cheap queries when nothing is published; the memberships and acknowledgements only when something is.
 */
export async function loadLiteracyStatus(
  db: Db,
  userId: string,
  now: Date = new Date(),
  settings?: OrgSettingsRow,
): Promise<LiteracyStatusView> {
  const chains = await loadPublishedChains(db);
  if (chains.length === 0) return { required: false, current: true, documents: [] };
  const memberships = await loadScopeMemberships(db, userId);
  const applicable = chains.filter((c) => audienceIncludes(c.doc.audience, memberships));
  if (applicable.length === 0) return { required: false, current: true, documents: [] };
  const acks = await loadAcks(db, [userId], applicable.map((c) => c.doc.key));
  const status = literacyStatusOf(applicable.map(inputOf), acks, now);
  const org = settings ?? (await loadOrgSettings(db));
  return {
    required: status.required,
    current: status.current,
    documents: status.documents.map((d, i) => {
      const c = applicable[i]!;
      return {
        ...d,
        url: c.doc.url,
        attachmentId: c.doc.attachmentId,
        contentDigest: c.doc.contentDigest,
        validityDays: c.doc.validityDays ?? org.literacyDefaultValidityDays,
        editorial: c.doc.editorial,
        expiresSoon: d.state === "current" && expiresWithinNotice(d.expiresAt, now),
      };
    }),
  };
}

/** `aiLiteracyCurrent(user)`: every applicable published document acknowledged at its current version, unexpired */
export async function aiLiteracyCurrent(db: Db, userId: string, now: Date = new Date()): Promise<boolean> {
  return (await loadLiteracyStatus(db, userId, now)).current;
}

/**
 * The Cedar v3 principal attribute `aiTrainingCurrent`. Called by `assembleAbacRequest`, the one place both the
 * enforcement path and the simulation surface build the principal bag, so a preview asks exactly the question
 * enforcement asks. Not affected by the gate mode or the exemptions: it is a fact, and a policy decides with it.
 */
export async function aiTrainingCurrentFor(db: Db, userId: string, now: Date = new Date()): Promise<boolean> {
  return aiTrainingCurrentOf(await loadLiteracyStatus(db, userId, now));
}

/**
 * Is THIS REQUEST a break-glass session (ADR-0174)? Being listed in `break_glass_user_ids` is a standing status
 * and exempts nothing by itself (main-session decision, ADR-0180 secure by default). A break-glass session is the
 * password sign-in the organisation admits, while SSO is enforced (`local_sign_in = break_glass_only`), only
 * because the person is on that list: the session's server-recorded origin is `password` (ADR-0028; a header API
 * key reports `api_key`, an OIDC/SAML session its own origin), the mode is engaged, and the person is still a
 * listed, active admin. The origin comes from the resolved session row (`abacPrincipalFromRequest`), never from
 * anything the client sends; a call with no request behind it (a worker, a scheduled run) is never break-glass.
 */
async function isBreakGlassSession(
  db: Db,
  org: OrgSettingsRow,
  userId: string,
  principal: AbacPrincipalContext | undefined,
): Promise<boolean> {
  if (principal?.sessionOrigin !== "password" || org.localSignIn !== "break_glass_only") return false;
  if (!(org.breakGlassUserIds ?? []).includes(userId)) return false;
  const [u] = await db
    .select({ isAdmin: users.isAdmin, disabledAt: users.disabledAt })
    .from(users)
    .where(eq(users.id, userId));
  return !!u && u.isAdmin && u.disabledAt === null;
}

/**
 * THE KERNEL'S LITERACY SLOT for one governed call (`governedEvaluate`). `LITERACY_NOT_REQUIRED` unless:
 * the call is human-originated (or a run a person owns, evaluated as that person), at least one document is
 * published, the gate is not `off`, the person is not exempt, and something published applies to them.
 *
 * The fast path is ONE indexed query (is anything published?), so an install with no published document pays
 * nothing more and decides exactly as before.
 */
export async function literacyPostureFor(
  db: Db,
  userId: string,
  opts: { origin?: GovernedCallOrigin | undefined; principal?: AbacPrincipalContext | undefined; now?: Date } = {},
): Promise<LiteracyPosture> {
  // platform sweeps and evaluation dispatches are the product governing itself, not a person's use of AI
  if (opts.origin !== undefined && opts.origin !== "human") return LITERACY_NOT_REQUIRED;
  // the bootstrap identity has no person behind it
  if (opts.principal?.sessionOrigin === "bootstrap") return LITERACY_NOT_REQUIRED;
  const [any] = await db
    .select({ id: aiPolicyDocuments.id })
    .from(aiPolicyDocuments)
    .where(eq(aiPolicyDocuments.status, "published"))
    .limit(1);
  if (!any) return LITERACY_NOT_REQUIRED;
  const org = await loadOrgSettings(db);
  const mode = org.literacyGateMode as AccountabilityGateMode;
  if (mode === "off") return LITERACY_NOT_REQUIRED;
  const status = await loadLiteracyStatus(db, userId, opts.now ?? new Date(), org);
  if (!status.required) return LITERACY_NOT_REQUIRED;
  // A break-glass SESSION gets an operator in during an emergency and is never held behind an acknowledgement.
  // Checked only when the person would otherwise be held, and then RECORDED: the kernel traces the exemption on
  // the decision (`ai-literacy-break-glass-exempt`), which the caller's audit row stores.
  if (!status.current && (await isBreakGlassSession(db, org, userId, opts.principal))) {
    return { required: false, current: true, missing: literacyMissing(status), exemption: "break_glass" };
  }
  return { required: true, current: status.current, missing: literacyMissing(status), mode };
}

/**
 * The literacy slot as a spread (`{ ...postureOf(mode, halt), ...slot }`), for the call sites that build an
 * `ExecutionPosture` inline — often inside a synchronous per-candidate closure, so the slot is resolved ONCE per
 * request, before the closure. `{}` when nothing applies, so the posture is byte-identical to before.
 */
export async function literacySlot(
  db: Db,
  userId: string,
  opts: { origin?: GovernedCallOrigin | undefined; principal?: AbacPrincipalContext | undefined } = {},
): Promise<{ literacy?: LiteracyPosture }> {
  const literacy = await literacyPostureFor(db, userId, opts);
  return literacy.required || literacy.exemption ? { literacy } : {};
}

/**
 * The same slot for any OTHER governed entry point (model dispatch `evaluateAgent`, connector calls
 * `evaluateConnector`): the posture the caller already built, plus the literacy slot when something published
 * applies. Returns the posture unchanged otherwise, so a call site that adopts it decides exactly as before until
 * a document is published. `governedEvaluate` uses it for the MCP tool path.
 */
export async function withLiteracyPosture<P extends ExecutionPosture>(
  db: Db,
  posture: P,
  userId: string,
  opts: { origin?: GovernedCallOrigin | undefined; principal?: AbacPrincipalContext | undefined } = {},
): Promise<P> {
  return { ...posture, ...(await literacySlot(db, userId, opts)) };
}

// ---------------------------------------------------------------------------
// D4A-03: an acknowledgement is a person's own act, made from an interactive session
// ---------------------------------------------------------------------------

/** the refusal code when an acknowledgement does not come from an interactive session (D4A-03) */
export const ACKNOWLEDGEMENT_REQUIRES_SESSION = "acknowledgement_requires_session" as const;

/** how a request authenticated, as the acknowledgement audit records it */
export interface AcknowledgementMethod {
  /** `session` (a browser session cookie), `api-key`, `virtual-key` or `bootstrap` */
  via: string;
  /** the session's server-recorded origin (`password`, `oidc`, `saml`, `api_key` for the login page's
   * "sign in with an API key", `bootstrap`, `unknown`); for a header credential, the credential kind */
  sessionOrigin: string;
}

/**
 * D4A-03: is this request a PERSON at the product, rather than a credential a script holds? The literacy gate
 * refuses API-key traffic of a person who is not current, so the same API key must not be able to clear the gate it
 * is held behind. An acknowledgement (and an admin recording their OWN completion) is therefore accepted only from a
 * browser session (`via === "session"`) belonging to a person, whatever sign-in created it; never from a header
 * API key, a virtual key, the bootstrap identity, or a session whose origin the server did not record.
 */
export function acknowledgementMethodOf(req: FastifyRequest): AcknowledgementMethod & { interactive: boolean } {
  const via = req.authCtx?.via ?? "unknown";
  const sessionOrigin = abacPrincipalFromRequest(req).sessionOrigin ?? "unknown";
  const interactive =
    via === "session" && !!req.authCtx?.userId && sessionOrigin !== "bootstrap" && sessionOrigin !== "unknown";
  return { via, sessionOrigin, interactive };
}

/**
 * D4G-09: a person who STARTS an evaluation or red-team run is using AI through regulAIt, so the run start checks
 * their literacy exactly as a governed call does (`literacyPostureFor`, origin human: gate mode, audience,
 * break-glass session). The dispatches inside the run keep the evaluation exemption (they are the product measuring
 * an agent), and so do platform-scheduled runs, which never come through this check. Every outcome other than "not
 * required" is audited: a refusal (`ai-literacy-not-current`, deny), a warn-mode gap (allow, `detail.mode = warn`)
 * and a break-glass exemption. Returns the 403 to send, or null to go on.
 */
export async function refuseRunStartWithoutLiteracy(
  db: Db,
  req: FastifyRequest,
  run: { kind: "evaluation" | "red-team"; subjectId: string },
): Promise<{ status: 403; body: { error: string; detail: string } } | null> {
  const userId = req.authCtx?.userId;
  if (!userId) return null; // the callers refuse the bootstrap identity themselves
  const literacy = await literacyPostureFor(db, userId, { origin: "human", principal: abacPrincipalFromRequest(req) });
  const label = `Starting this ${run.kind} run`;
  const base = { userId, objectType: "eval_run" as const, objectId: null, ruleChain: [] as string[] };
  const detail = { phase: "run-start", runKind: run.kind, subjectId: run.subjectId, missing: literacy.missing ?? [] };
  if (literacy.exemption === "break_glass") {
    await db.insert(auditLog).values({
      ...base,
      effect: "allow",
      ruleId: LITERACY_BREAK_GLASS_RULE_ID,
      reason: `${label}: allowed through a break-glass session although the person is not current on: ${(literacy.missing ?? []).join("; ")}`,
      detail: { ...detail, exemption: "break_glass" },
    });
    return null;
  }
  if (!literacy.required || literacy.current) return null;
  const refusal = literacyGate({ mode: "normal", literacy }, label);
  if (!refusal) {
    await db.insert(auditLog).values({
      ...base,
      effect: "allow",
      ruleId: LITERACY_RULE_ID,
      reason: `${label}: allowed under literacy_gate_mode = warn although the person is not current on: ${(literacy.missing ?? []).join("; ")}`,
      detail: { ...detail, mode: "warn" },
    });
    return null;
  }
  await db.insert(auditLog).values({ ...base, effect: "deny", ruleId: refusal.ruleId, reason: refusal.reason, detail: { ...detail, mode: "enforce" } });
  return { status: 403, body: { error: refusal.ruleId, detail: refusal.reason } };
}

// ---------------------------------------------------------------------------
// Coverage: the admin report, the monitor and the sweep read the same numbers
// ---------------------------------------------------------------------------

export interface CoveragePerson {
  userId: string;
  displayName: string;
  email: string;
  state: LiteracyDocumentStanding["state"];
  method: LiteracyDocumentStanding["method"];
  acknowledgedVersion: number | null;
  acknowledgedAt: string | null;
  expiresAt: string | null;
  expiresSoon: boolean;
  evidenceRef: string | null;
}

export interface CoverageDocument {
  documentId: string;
  key: string;
  kind: string;
  version: number;
  title: string;
  editorial: boolean;
  publishedAt: string | null;
  audience: number;
  current: number;
  coveragePct: number;
  people: CoveragePerson[];
}

/** coverage of every published document over its audience (active people only) */
export async function computeCoverage(db: Db, now: Date = new Date()): Promise<CoverageDocument[]> {
  const chains = await loadPublishedChains(db);
  if (chains.length === 0) return [];
  const [people, assignments, memberships] = await Promise.all([
    db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(isNull(users.disabledAt))
      .orderBy(asc(users.displayName)),
    db.select({ userId: roleAssignments.userId, roleId: roleAssignments.roleId }).from(roleAssignments),
    db.select({ userId: teamMembers.userId, teamId: teamMembers.teamId }).from(teamMembers),
  ]);
  const rolesOf = new Map<string, string[]>();
  for (const a of assignments) rolesOf.set(a.userId, [...(rolesOf.get(a.userId) ?? []), a.roleId]);
  const teamsOf = new Map<string, string[]>();
  for (const m of memberships) teamsOf.set(m.userId, [...(teamsOf.get(m.userId) ?? []), m.teamId]);
  const acks = await loadAcks(db, null, [...new Set(chains.map((c) => c.doc.key))]);
  const acksOf = new Map<string, typeof acks>();
  for (const a of acks) acksOf.set(a.userId, [...(acksOf.get(a.userId) ?? []), a]);

  return chains.map((c) => {
    const input = inputOf(c);
    const rows: CoveragePerson[] = [];
    for (const p of people) {
      if (!audienceIncludes(c.doc.audience, { teamIds: teamsOf.get(p.id) ?? [], roleIds: rolesOf.get(p.id) ?? [] })) continue;
      const mine = acksOf.get(p.id) ?? [];
      const s = literacyStatusOf([input], mine, now).documents[0]!;
      const counted = mine.find((a) => a.key === c.doc.key && a.version === s.acknowledgedVersion);
      rows.push({
        userId: p.id,
        displayName: p.displayName,
        email: p.email,
        state: s.state,
        method: s.method,
        acknowledgedVersion: s.acknowledgedVersion,
        acknowledgedAt: s.acknowledgedAt,
        expiresAt: s.expiresAt,
        expiresSoon: s.state === "current" && expiresWithinNotice(s.expiresAt, now),
        evidenceRef: counted?.evidenceRef ?? null,
      });
    }
    const current = rows.filter((r) => r.state === "current").length;
    return {
      documentId: c.doc.id,
      key: c.doc.key,
      kind: c.doc.kind,
      version: c.doc.version,
      title: c.doc.title,
      editorial: c.doc.editorial,
      publishedAt: c.doc.publishedAt?.toISOString() ?? null,
      audience: rows.length,
      current,
      coveragePct: coveragePct(current, rows.length),
      people: rows,
    };
  });
}

/** The monitor's loader for `literacy_coverage_gap` (governance-monitor.ts). Low, observe-only: one finding per
 * published document whose coverage is below 100% of its audience. Titles carry the key and counts only — never a
 * person (ADR-0175 D2 rule 12) and never the admin-typed title. */
export async function literacyMonitorInput(
  db: Db,
  now: Date,
): Promise<Partial<Record<AccountabilityMonitorRuleId, MonitorAssuranceInput>>> {
  const coverage = await computeCoverage(db, now);
  const breaches: MonitorAssuranceSubject[] = coverage
    .filter((d) => d.audience > 0 && d.current < d.audience)
    .map((d) => ({
      subjectKey: `ai_policy:${d.key}`,
      title: `AI policy ${d.key} v${d.version}: ${d.current} of ${d.audience} people current (${d.coveragePct}%)`,
      detail: {
        documentId: d.documentId,
        key: d.key,
        version: d.version,
        audience: d.audience,
        current: d.current,
        coveragePct: d.coveragePct,
        missing: d.people.filter((p) => p.state === "missing").length,
        expired: d.people.filter((p) => p.state === "expired").length,
        superseded: d.people.filter((p) => p.state === "superseded").length,
      },
    }));
  return { literacy_coverage_gap: { breaches } };
}

/**
 * `literacy-expiry-sweep`: one audited notice per counted acknowledgement that enters the 14-day window before it
 * expires. Idempotent: the audit log is the marker (one notice per person, document and expiry instant). The
 * person sees the notice in the interstitial and on their Account page; the row is written as the deployment.
 */
export async function runLiteracyExpirySweep(
  db: Db,
  opts: { now?: Date; requestedByUserId?: string | null } = {},
): Promise<{ notified: number; inWindow: number }> {
  const now = opts.now ?? new Date();
  const coverage = await computeCoverage(db, now);
  let notified = 0;
  let inWindow = 0;
  for (const d of coverage) {
    for (const p of d.people) {
      if (!p.expiresSoon || !p.expiresAt) continue;
      inWindow += 1;
      const [already] = await db
        .select({ n: count() })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.ruleId, AI_LITERACY_RULE_IDS.expiryNotice),
            eq(auditLog.objectId, d.documentId),
            sql`${auditLog.detail}->>'userId' = ${p.userId}`,
            sql`${auditLog.detail}->>'expiresAt' = ${p.expiresAt}`,
          ),
        );
      if ((already?.n ?? 0) > 0) continue;
      const daysLeft = Math.ceil((Date.parse(p.expiresAt) - now.getTime()) / 86_400_000);
      await db.insert(auditLog).values({
        userId: NO_IDENTITY,
        objectType: "ai_policy_document",
        objectId: d.documentId,
        effect: "allow",
        ruleId: AI_LITERACY_RULE_IDS.expiryNotice,
        ruleChain: [],
        reason:
          `AI policy ${d.key} v${d.version}: the acknowledgement of a user (id ${p.userId}) expires in ${daysLeft} ` +
          `day(s), on ${p.expiresAt}; they are asked to acknowledge it again`,
        detail: {
          userId: p.userId,
          key: d.key,
          version: d.version,
          expiresAt: p.expiresAt,
          daysLeft,
          noticeDays: LITERACY_EXPIRY_NOTICE_DAYS,
          requestedBy: opts.requestedByUserId ?? null,
        },
      });
      notified += 1;
    }
  }
  return { notified, inWindow };
}

/** The scheduler jobs this slice owns (spread by scheduler-jobs.ts). */
export function literacyJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: LITERACY_EXPIRY_SWEEP_JOB_NAME,
      description:
        `Notify each person whose AI policy or training acknowledgement expires within ${LITERACY_EXPIRY_NOTICE_DAYS} ` +
        "days (one audited notice per acknowledgement, shown on their Account page and in the acknowledgement " +
        "prompt). Enforcement does not depend on it: an expired acknowledgement never counts.",
      adr: "ADR-0182",
      defaultIntervalSeconds: 24 * 3600,
      run: async (ctx) => {
        const out = await runLiteracyExpirySweep(ctx.db, { now: ctx.now, requestedByUserId: ctx.actorUserId });
        return { itemsProcessed: out.notified, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const params = z.object({ policyId: z.string().uuid() });

function docView(d: AiPolicyDocumentRow) {
  return {
    id: d.id,
    key: d.key,
    kind: d.kind,
    version: d.version,
    title: d.title,
    url: d.url,
    attachmentId: d.attachmentId,
    contentDigest: d.contentDigest,
    audience: d.audience,
    validityDays: d.validityDays,
    status: d.status,
    editorial: d.editorial,
    editorialReason: d.editorialReason,
    publishedAt: d.publishedAt?.toISOString() ?? null,
    retiredAt: d.retiredAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  };
}

function refuse(reply: FastifyReply, status: number, error: string, detail: string) {
  return reply.status(status).send({ error, detail });
}

/**
 * Routes (classified in route-classes.ts and openapi-registry.ts, A14 block):
 *   GET  /v1/ai-policies                         user: what applies to the caller (admin: every version)
 *   POST /v1/ai-policies                         admin: a new draft (the next version of `key`)
 *   GET  /v1/ai-policies/coverage                admin (audited read: it includes others' evidence references)
 *   POST /v1/ai-policies/:policyId/publish       admin (editorial needs a reason; audited with transitions)
 *   POST /v1/ai-policies/:policyId/retire        admin (a reason of at least 10 characters; audited, a relaxation
 *                                                when the version was published)
 *   POST /v1/ai-policies/:policyId/acknowledge   user: self only, from an interactive session (D4A-03)
 *   POST /v1/ai-policies/:policyId/records       admin (completion from an external training system)
 *   GET  /v1/me/ai-literacy                      user: self only
 */
export function registerAiLiteracyRoutes(app: FastifyInstance, db: Db): void {
  const actorOf = (req: { authCtx: { userId: string | null } }) => req.authCtx.userId ?? NO_IDENTITY;

  app.get("/v1/ai-policies", async (req) => {
    if (req.authCtx.isAdmin) {
      const rows = await db
        .select()
        .from(aiPolicyDocuments)
        .orderBy(asc(aiPolicyDocuments.key), desc(aiPolicyDocuments.version));
      return { scope: "all", documents: rows.map(docView) };
    }
    const userId = req.authCtx.userId;
    if (!userId) return { scope: "applicable", documents: [] };
    const memberships = await loadScopeMemberships(db, userId);
    const chains = await loadPublishedChains(db);
    return {
      scope: "applicable",
      documents: chains.filter((c) => audienceIncludes(c.doc.audience, memberships)).map((c) => docView(c.doc)),
    };
  });

  app.post("/v1/ai-policies", async (req, reply) => {
    const body = createAiPolicySchema.parse(req.body);
    const prior = await db
      .select({ version: aiPolicyDocuments.version, kind: aiPolicyDocuments.kind })
      .from(aiPolicyDocuments)
      .where(eq(aiPolicyDocuments.key, body.key))
      .orderBy(desc(aiPolicyDocuments.version))
      .limit(1);
    const last = prior[0];
    if (last && last.kind !== body.kind) {
      return refuse(reply, 409, "ai_policy_kind_mismatch", `'${body.key}' is a ${last.kind} document; a new version keeps its kind`);
    }
    const version = (last?.version ?? 0) + 1;
    const url = body.url ?? null;
    const attachmentId = body.attachmentId ?? null;
    const contentDigest = aiPolicyContentDigest({ key: body.key, kind: body.kind, version, title: body.title, url, attachmentId });
    let row: AiPolicyDocumentRow | undefined;
    try {
      row = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Db;
        const [inserted] = await tx
          .insert(aiPolicyDocuments)
          .values({
            key: body.key,
            kind: body.kind,
            version,
            title: body.title,
            url,
            attachmentId,
            contentDigest,
            audience: body.audience,
            validityDays: body.validityDays ?? null,
            createdBy: req.authCtx.userId,
          })
          .returning();
        await tx.insert(auditLog).values({
          userId: actorOf(req),
          objectType: "ai_policy_document",
          objectId: inserted!.id,
          effect: "allow",
          ruleId: AI_LITERACY_RULE_IDS.created,
          ruleChain: [],
          reason: `AI policy ${body.key} v${version} (${body.kind}) created as a draft`,
          detail: { key: body.key, version, kind: body.kind, audience: body.audience, validityDays: body.validityDays ?? null, contentDigest },
        });
        return inserted;
      });
    } catch (err) {
      if (/ai_policy_documents_key_version_uq/.test(`${(err as Error).message} ${String((err as { cause?: Error }).cause?.message ?? "")}`)) {
        return refuse(reply, 409, "ai_policy_version_conflict", `another version of '${body.key}' was created at the same time; retry`);
      }
      throw err;
    }
    return reply.status(201).send({ document: docView(row!) });
  });

  app.post("/v1/ai-policies/:policyId/publish", async (req, reply) => {
    const { policyId } = params.parse(req.params);
    const body = publishAiPolicySchema.parse(req.body ?? {});
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [doc] = await tx.select().from(aiPolicyDocuments).where(eq(aiPolicyDocuments.id, policyId)).for("update");
      if (!doc) return { status: 404, error: "not_found", detail: "no such AI policy version" } as const;
      // every version of the key, locked, so two publishes of one key serialise
      const versions = await tx
        .select()
        .from(aiPolicyDocuments)
        .where(eq(aiPolicyDocuments.key, doc.key))
        .orderBy(desc(aiPolicyDocuments.version))
        .for("update");
      if (doc.status !== "draft") {
        return { status: 409, error: "ai_policy_not_draft", detail: `v${doc.version} of '${doc.key}' is ${doc.status}; only a draft is published` } as const;
      }
      const current = versions.find((v) => v.status === "published") ?? null;
      if (current && current.version > doc.version) {
        return {
          status: 409,
          error: "ai_policy_older_than_published",
          detail: `v${current.version} of '${doc.key}' is published; an older draft (v${doc.version}) cannot replace it`,
        } as const;
      }
      if (body.editorial && !current) {
        return {
          status: 409,
          error: "ai_policy_editorial_needs_published_predecessor",
          detail:
            "an editorial version keeps the acknowledgements of the version it replaces, so it needs a published " +
            `version of '${doc.key}' to replace; publish it as a material version instead`,
        } as const;
      }
      const now = new Date();
      if (current) {
        await tx
          .update(aiPolicyDocuments)
          .set({ status: "retired", retiredAt: now, retiredBy: req.authCtx.userId })
          .where(eq(aiPolicyDocuments.id, current.id));
        await tx.insert(auditLog).values({
          userId: actorOf(req),
          objectType: "ai_policy_document",
          objectId: current.id,
          effect: "allow",
          ruleId: AI_LITERACY_RULE_IDS.retired,
          ruleChain: [],
          reason: `AI policy ${doc.key} v${current.version} retired: replaced by v${doc.version}`,
          detail: {
            key: doc.key,
            version: current.version,
            replacedBy: doc.version,
            transitions: settingTransitions({ status: current.status }, { status: "retired" }),
          },
        });
      }
      const [published] = await tx
        .update(aiPolicyDocuments)
        .set({
          status: "published",
          publishedAt: now,
          publishedBy: req.authCtx.userId,
          editorial: body.editorial,
          editorialReason: body.editorial ? body.editorialReason! : null,
        })
        .where(eq(aiPolicyDocuments.id, doc.id))
        .returning();
      const transitions = settingTransitions(
        { status: doc.status, editorial: doc.editorial, acknowledgements: "required" },
        { status: "published", editorial: body.editorial, acknowledgements: body.editorial ? "kept" : "required" },
      );
      await tx.insert(auditLog).values({
        userId: actorOf(req),
        objectType: "ai_policy_document",
        objectId: doc.id,
        effect: "allow",
        ruleId: AI_LITERACY_RULE_IDS.published,
        ruleChain: [],
        reason: body.editorial
          ? `AI policy ${doc.key} v${doc.version} published as EDITORIAL (RELAXED: acknowledgements of ` +
            `v${current!.version} keep counting): ${body.editorialReason}`
          : `AI policy ${doc.key} v${doc.version} published; everyone it applies to must acknowledge this version` +
            (current ? ` (v${current.version} acknowledgements no longer count)` : ""),
        detail: {
          key: doc.key,
          version: doc.version,
          kind: doc.kind,
          editorial: body.editorial,
          ...(body.editorial ? { editorialReason: body.editorialReason, relaxed: true } : {}),
          replaces: current?.version ?? null,
          contentDigest: doc.contentDigest,
          transitions,
        },
      });
      return { status: 200, document: published! } as const;
    });
    if (outcome.status !== 200) return refuse(reply, outcome.status, outcome.error, outcome.detail);
    return reply.send({ document: docView(outcome.document) });
  });

  app.post("/v1/ai-policies/:policyId/retire", async (req, reply) => {
    const { policyId } = params.parse(req.params);
    // D4G-11: retiring a PUBLISHED version lifts the requirement for its whole audience (the same effect as turning
    // the gate off for them), so it needs a reason and is audited as a relaxation; a draft needs one too.
    const body = z.object({ reason: z.string().trim().min(10).max(2000) }).strict().parse(req.body ?? {});
    const [doc] = await db.select().from(aiPolicyDocuments).where(eq(aiPolicyDocuments.id, policyId));
    if (!doc) return refuse(reply, 404, "not_found", "no such AI policy version");
    if (doc.status === "retired") return reply.send({ document: docView(doc), changed: false });
    const retired = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [row] = await tx
        .update(aiPolicyDocuments)
        .set({ status: "retired", retiredAt: new Date(), retiredBy: req.authCtx.userId })
        .where(and(eq(aiPolicyDocuments.id, doc.id), eq(aiPolicyDocuments.status, doc.status)))
        .returning();
      if (!row) return null;
      await tx.insert(auditLog).values({
        userId: actorOf(req),
        objectType: "ai_policy_document",
        objectId: doc.id,
        effect: "allow",
        ruleId: AI_LITERACY_RULE_IDS.retired,
        ruleChain: [],
        reason:
          `AI policy ${doc.key} v${doc.version} retired from ${doc.status}` +
          (doc.status === "published" ? " (RELAXED: it no longer applies to anyone)" : "") +
          `: ${body.reason}`,
        detail: {
          key: doc.key,
          version: doc.version,
          reason: body.reason,
          ...(doc.status === "published" ? { relaxed: true } : {}),
          transitions: settingTransitions({ status: doc.status }, { status: "retired" }),
        },
      });
      return row;
    });
    if (!retired) return refuse(reply, 409, "ai_policy_changed", "the document changed while it was being retired; reload and retry");
    return reply.send({ document: docView(retired), changed: true });
  });

  app.post("/v1/ai-policies/:policyId/acknowledge", async (req, reply) => {
    const { policyId } = params.parse(req.params);
    const userId = req.authCtx.userId;
    if (!userId) return refuse(reply, 403, "bootstrap_cannot_acknowledge", "the bootstrap identity is not a person and acknowledges nothing");
    // D4A-03: only from an interactive session. The gate holds this person's API-key traffic, so that key must not
    // be able to clear it; refused and audited with the method the request used.
    const method = acknowledgementMethodOf(req);
    if (!method.interactive) {
      await db.insert(auditLog).values({
        userId,
        objectType: "ai_policy_document",
        objectId: policyId,
        effect: "deny",
        ruleId: AI_LITERACY_RULE_IDS.acknowledgeRefused,
        ruleChain: [],
        reason:
          `AI policy acknowledgement refused: it was sent with ${method.via === "session" ? `a session of origin ${method.sessionOrigin}` : `a ${method.via} credential`}, ` +
          "and a person acknowledges only from an interactive session",
        detail: { code: ACKNOWLEDGEMENT_REQUIRES_SESSION, via: method.via, sessionOrigin: method.sessionOrigin },
      });
      return refuse(
        reply,
        403,
        ACKNOWLEDGEMENT_REQUIRES_SESSION,
        "an AI policy is acknowledged by the person, signed in to regulAIt (Account > AI policies), not with an API key or a virtual key",
      );
    }
    // SELF ONLY. The body names no person; one that tries to is refused (and audited) rather than ignored, so an
    // attempt to acknowledge for somebody else is never mistaken for an acknowledgement of one's own.
    const raw = (req.body ?? {}) as Record<string, unknown>;
    if (raw && typeof raw === "object" && "userId" in raw && raw.userId !== userId) {
      await db.insert(auditLog).values({
        userId,
        objectType: "ai_policy_document",
        objectId: policyId,
        effect: "deny",
        ruleId: AI_LITERACY_RULE_IDS.acknowledgeRefused,
        ruleChain: [],
        reason: `AI policy acknowledgement for another user (id ${String(raw.userId).slice(0, 64)}) refused: a person acknowledges only for themselves`,
        detail: { attemptedFor: String(raw.userId).slice(0, 64) },
      });
      return refuse(
        reply,
        403,
        "acknowledge_self_only",
        "a person acknowledges an AI policy only for themselves; an admin records a completion through /records",
      );
    }
    const { userId: _self, ...rest } = raw;
    const body = acknowledgeAiPolicySchema.parse(rest);
    const [doc] = await db.select().from(aiPolicyDocuments).where(eq(aiPolicyDocuments.id, policyId));
    if (!doc) return refuse(reply, 404, "not_found", "no such AI policy version");
    if (doc.status !== "published") {
      return refuse(reply, 409, "ai_policy_not_published", `v${doc.version} of '${doc.key}' is ${doc.status}; only the published version is acknowledged`);
    }
    if (body.version !== doc.version || body.digest !== doc.contentDigest) {
      return refuse(
        reply,
        409,
        "ai_policy_version_mismatch",
        `the published version of '${doc.key}' is v${doc.version}; reload it and acknowledge exactly that text`,
      );
    }
    const memberships = await loadScopeMemberships(db, userId);
    if (!audienceIncludes(doc.audience, memberships)) {
      return refuse(reply, 409, "ai_policy_not_applicable", `'${doc.key}' does not apply to you`);
    }
    const org = await loadOrgSettings(db);
    const validityDays = doc.validityDays ?? org.literacyDefaultValidityDays ?? ACCOUNTABILITY_STRICT_DEFAULTS.literacyDefaultValidityDays;
    const now = new Date();
    const expiresAt = ackExpiresAt(now, validityDays);
    const row = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [before] = await tx
        .select()
        .from(aiPolicyAcknowledgements)
        .where(and(eq(aiPolicyAcknowledgements.userId, userId), eq(aiPolicyAcknowledgements.documentId, doc.id)));
      const values = {
        version: doc.version,
        digest: doc.contentDigest,
        method: "acknowledged" as const,
        recordedBy: null,
        evidenceRef: null,
        acknowledgedAt: now,
        expiresAt,
      };
      const [ack] = await tx
        .insert(aiPolicyAcknowledgements)
        .values({ userId, documentId: doc.id, ...values })
        .onConflictDoUpdate({
          target: [aiPolicyAcknowledgements.userId, aiPolicyAcknowledgements.documentId],
          set: values,
        })
        .returning();
      await tx.insert(auditLog).values({
        userId,
        objectType: "ai_policy_acknowledgement",
        objectId: ack!.id,
        effect: "allow",
        ruleId: AI_LITERACY_RULE_IDS.acknowledged,
        ruleChain: [],
        reason:
          `AI policy ${doc.key} v${doc.version} acknowledged by the user themselves, signed in (session origin ` +
          `${method.sessionOrigin}); valid until ${expiresAt.toISOString()}`,
        detail: {
          documentId: doc.id,
          key: doc.key,
          version: doc.version,
          digest: doc.contentDigest,
          method: "acknowledged",
          via: method.via,
          sessionOrigin: method.sessionOrigin,
          expiresAt: expiresAt.toISOString(),
          renewed: !!before,
          ...(before
            ? {
                transitions: settingTransitions(
                  { method: before.method, expiresAt: before.expiresAt.toISOString() },
                  { method: "acknowledged", expiresAt: expiresAt.toISOString() },
                ),
              }
            : {}),
        },
      });
      return ack!;
    });
    return reply.send({
      acknowledgement: {
        id: row.id,
        documentId: doc.id,
        key: doc.key,
        version: row.version,
        method: row.method,
        acknowledgedAt: row.acknowledgedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      },
      status: await loadLiteracyStatus(db, userId, new Date(), org),
    });
  });

  app.post("/v1/ai-policies/:policyId/records", async (req, reply) => {
    const { policyId } = params.parse(req.params);
    const body = recordAiPolicyCompletionSchema.parse(req.body);
    // D4A-03: an admin recording their OWN completion is the gate's subject clearing it, so it follows the
    // acknowledgement's rule (an interactive session); a completion for someone else is the admin route's purpose.
    const method = acknowledgementMethodOf(req);
    if (body.userId === req.authCtx.userId && !method.interactive) {
      await db.insert(auditLog).values({
        userId: actorOf(req),
        objectType: "ai_policy_document",
        objectId: policyId,
        effect: "deny",
        ruleId: AI_LITERACY_RULE_IDS.recordRefused,
        ruleChain: [],
        reason: `an admin's own AI policy completion refused: it was sent with a ${method.via} credential, and a person records their own only from an interactive session`,
        detail: { code: ACKNOWLEDGEMENT_REQUIRES_SESSION, via: method.via, sessionOrigin: method.sessionOrigin, forUserId: body.userId },
      });
      return refuse(
        reply,
        403,
        ACKNOWLEDGEMENT_REQUIRES_SESSION,
        "your own acknowledgement or completion is recorded signed in to regulAIt, not with an API key",
      );
    }
    const [doc] = await db.select().from(aiPolicyDocuments).where(eq(aiPolicyDocuments.id, policyId));
    if (!doc) return refuse(reply, 404, "not_found", "no such AI policy version");
    if (doc.status !== "published") {
      return refuse(reply, 409, "ai_policy_not_published", `v${doc.version} of '${doc.key}' is ${doc.status}; a completion is recorded against the published version`);
    }
    const [person] = await db
      .select({ id: users.id, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, body.userId));
    if (!person) return refuse(reply, 404, "unknown_user", "no such user");
    const now = new Date();
    const completedAt = body.completedAt ? new Date(body.completedAt) : now;
    if (completedAt.getTime() > now.getTime() + 60_000) {
      return refuse(reply, 422, "completed_at_in_future", "a completion is recorded after it happened");
    }
    const org = await loadOrgSettings(db);
    const validityDays = doc.validityDays ?? org.literacyDefaultValidityDays;
    const expiresAt = ackExpiresAt(completedAt, validityDays);
    if (expiresAt.getTime() <= now.getTime()) {
      return refuse(reply, 422, "completion_already_expired", `a completion on ${completedAt.toISOString()} expired after ${validityDays} days`);
    }
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Db;
      const [before] = await tx
        .select()
        .from(aiPolicyAcknowledgements)
        .where(and(eq(aiPolicyAcknowledgements.userId, body.userId), eq(aiPolicyAcknowledgements.documentId, doc.id)))
        .for("update");
      // never shorten what the person already holds for this version
      if (before && before.expiresAt.getTime() > expiresAt.getTime()) return { newer: before } as const;
      const values = {
        version: doc.version,
        digest: doc.contentDigest,
        method: body.method,
        recordedBy: req.authCtx.userId,
        evidenceRef: body.evidenceRef,
        acknowledgedAt: completedAt,
        expiresAt,
      };
      const [ack] = await tx
        .insert(aiPolicyAcknowledgements)
        .values({ userId: body.userId, documentId: doc.id, ...values })
        .onConflictDoUpdate({
          target: [aiPolicyAcknowledgements.userId, aiPolicyAcknowledgements.documentId],
          set: values,
        })
        .returning();
      await tx.insert(auditLog).values({
        userId: actorOf(req),
        objectType: "ai_policy_acknowledgement",
        objectId: ack!.id,
        effect: "allow",
        ruleId: AI_LITERACY_RULE_IDS.recorded,
        ruleChain: [],
        reason:
          `AI policy ${doc.key} v${doc.version}: ${body.method.replace("_", " ")} recorded by an admin for a user ` +
          `(id ${body.userId}), evidence ${body.evidenceRef}; valid until ${expiresAt.toISOString()}`,
        detail: {
          documentId: doc.id,
          key: doc.key,
          version: doc.version,
          forUserId: body.userId,
          method: body.method,
          via: method.via,
          sessionOrigin: method.sessionOrigin,
          evidenceRef: body.evidenceRef,
          completedAt: completedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          transitions: settingTransitions(
            before ? { method: before.method, expiresAt: before.expiresAt.toISOString() } : {},
            { method: body.method, expiresAt: expiresAt.toISOString() },
          ),
        },
      });
      return { ack: ack! } as const;
    });
    if ("newer" in outcome && outcome.newer) {
      return refuse(
        reply,
        409,
        "existing_acknowledgement_is_newer",
        `the user already holds an acknowledgement of this version valid until ${outcome.newer.expiresAt.toISOString()}`,
      );
    }
    return reply.status(201).send({
      acknowledgement: {
        id: outcome.ack.id,
        documentId: doc.id,
        userId: body.userId,
        version: outcome.ack.version,
        method: outcome.ack.method,
        evidenceRef: outcome.ack.evidenceRef,
        acknowledgedAt: outcome.ack.acknowledgedAt.toISOString(),
        expiresAt: outcome.ack.expiresAt.toISOString(),
      },
    });
  });

  app.get("/v1/ai-policies/coverage", async (req) => {
    const now = new Date();
    const documents = await computeCoverage(db, now);
    // an audited read: the report carries other people's records and admin-typed evidence references
    await db.insert(auditLog).values({
      userId: actorOf(req),
      objectType: "ai_policy_document",
      objectId: null,
      effect: "allow",
      ruleId: AI_LITERACY_RULE_IDS.coverageRead,
      ruleChain: [],
      reason: `AI policy acknowledgement coverage read (${documents.length} published document(s))`,
      detail: { documents: documents.map((d) => ({ key: d.key, version: d.version, audience: d.audience, current: d.current })) },
    });
    return { generatedAt: now.toISOString(), noticeDays: LITERACY_EXPIRY_NOTICE_DAYS, documents };
  });

  app.get("/v1/me/ai-literacy", async (req) => {
    const userId = req.authCtx.userId;
    const org = await loadOrgSettings(db);
    const gateMode = org.literacyGateMode as AccountabilityGateMode;
    if (!userId) {
      return { required: false, current: true, documents: [], gateMode, exempt: "bootstrap", noticeDays: LITERACY_EXPIRY_NOTICE_DAYS };
    }
    const status = await loadLiteracyStatus(db, userId, new Date(), org);
    const exempt = (await isBreakGlassSession(db, org, userId, abacPrincipalFromRequest(req))) ? "break_glass" : null;
    return { ...status, gateMode, exempt, noticeDays: LITERACY_EXPIRY_NOTICE_DAYS };
  });
}
