/**
 * ADR-0055 — SHADOW-AI DISCOVERY, the gateway half.
 *
 *   `packages/shared/src/shadow-ai.ts`  the untrusted-evidence envelope, the
 *                                        catalogue shape + seed, the linear
 *                                        matchers, severity/confidence and the
 *                                        correlation. Pure.
 *   THIS FILE                            persistence, the catalogue admin API,
 *                                        the import route, the inventory, the
 *                                        coverage scorecard and the link to the
 *                                        governed replacement.
 *
 * WHAT THIS DEPLOYMENT ACTUALLY DOES — SAY IT BEFORE ANYTHING ELSE
 * ----------------------------------------------------------------
 * ADR-0055 §2 describes three "collectors". THERE IS NO COLLECTOR IN THIS
 * REPOSITORY AND NONE SHIPS. This control plane does not sit on a customer's
 * network, does not hold their DNS resolver, does not run on their laptops, and
 * has no browser extension. Every route below operates on evidence the CUSTOMER
 * exports and uploads:
 *
 *   egress_log    a forward-proxy / firewall / DNS-resolver / SIEM export
 *   code_scan     the output of a repo scan (their CI today; a RegulAIt scanner
 *                 over `packages/git-provider` is follow-up work)
 *   saas_export   a SaaS admin-console export of installed / OAuth-granted apps
 *   self_reported what a human typed
 *
 * `GET /v1/shadow-ai/findings` returns that limitation IN THE RESPONSE, as the
 * coverage scorecard's `statement`, so the console cannot render a number
 * without rendering the caveat next to it.
 *
 * THE FOUR INVARIANTS
 * -------------------
 *  1. AN IMPORT CANNOT MINT GOVERNANCE. Structurally, not by policy: the only
 *     tables this module writes are `shadow_ai_imports`, `shadow_ai_findings`
 *     and (through the CATALOGUE routes, never the import route)
 *     `ai_endpoint_signatures`. No row schema has a field naming a role, a
 *     grant, an entitlement, an agent to create or an approval to open, and
 *     `screenEvidencePayload` refuses a payload that so much as mentions one —
 *     specifically so the refusal is audited and legible rather than a generic
 *     schema error.
 *
 *  2. THE CATALOGUE IS DATA. Seed, add, edit, delete — all rows, no deploy. The
 *     matcher contains no provider name; empty the table and discovery matches
 *     nothing (proved in the unit suite).
 *
 *  3. THE REPLACEMENT LINK COMES FROM THE CATALOGUE, NEVER THE FILE. A finding
 *     points at the governed agent that would replace the ungoverned usage
 *     because an ADMIN put that pointer on the catalogue row. An uploaded file
 *     has no way to name an agent.
 *
 *  4. REMEDIATION REUSES THE ONE WORKFLOW PATH. This module does NOT
 *     instantiate workflows. `GET …/remediation-plan` composes the ordered
 *     steps ADR-0055 §4 names and hands back the exact request body for the
 *     existing `POST /v1/workflows/instances`; `POST …/remediate` LINKS an
 *     instance that route already created. A second instantiation path would be
 *     a second set of assignment rules, compliance-cascade merges and quorum
 *     checks to keep in step — exactly the drift the ADR's "built on the
 *     existing workflow engine" clause exists to avoid.
 *
 * NO EGRESS. Discovery makes no outbound request of any kind: it reads a body
 * the admin posted and writes rows. There is therefore nothing here for the
 * ADR-0034 guard to guard — and that is a property worth stating, because a
 * discovery engine that phoned home with an inventory of a customer's AI usage
 * would be the worst possible shape for this feature.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  agents,
  aiEndpointSignatures,
  and,
  auditLog,
  customModelProviders,
  desc,
  eq,
  inArray,
  modelCredentials,
  shadowAiFindings,
  shadowAiImports,
  sql,
  userModelCredentials,
  workflowInstances,
  type Db,
} from "@regulait/db";
import {
  DEFAULT_AI_SIGNATURES,
  DiscoveryParseError,
  EVIDENCE_ADAPTER_POSTURE,
  EVIDENCE_MAX_BYTES,
  EVIDENCE_MAX_ROWS,
  EvidenceFormatError,
  SHADOW_AI_CATALOG_V1,
  SHADOW_AI_CATALOG_VERSION,
  SHADOW_AI_DISPOSITIONS,
  SHADOW_DISCOVERY_POSTURE,
  SHADOW_DISCOVERY_SOURCE_KINDS,
  analyzeImport,
  catalogueSignatureSchema,
  classifyDiscoveryContent,
  classifyObservation,
  confidenceFor,
  coverageScorecard,
  describeEvidenceAdapters,
  evidenceImportSchema,
  getEvidenceAdapter,
  normalizeEvidenceHost,
  rawEvidenceImportRequestSchema,
  screenEvidencePayload,
  type AiSignature,
  type CorrelatedFinding,
  type EvidenceImport,
  type EvidenceKind,
  type EvidenceRowRefusal,
  type Observation,
  type ShadowAiSeverity,
} from "@regulait/shared";
import { defaultBaseUrlFor } from "@regulait/model-provider";
import { ENV_FALLBACK_PROVIDERS, platformEnvKey } from "./agents-connectors.js";
import { envFallbackAllowed, loadOrgSettings } from "./org-settings.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/** stable rule ids — the strings an operator greps the audit log for */
export const SHADOW_AI_RULE_IDS = {
  catalogueSeeded: "shadow-ai-catalogue-seeded",
  catalogueUpserted: "shadow-ai-catalogue-upserted",
  catalogueDeleted: "shadow-ai-catalogue-deleted",
  importPlanned: "shadow-ai-import-planned",
  importApplied: "shadow-ai-import-applied",
  importRejected: "shadow-ai-import-rejected",
  importPrivilegeRefused: "shadow-ai-import-privilege-refused",
  importTooLarge: "shadow-ai-import-too-large",
  /** ADR-0071: a raw file the adapter could not read AT ALL (wrong adapter,
   * missing `#Fields:`, unmappable columns) — distinct from a per-row refusal */
  rawUnreadable: "shadow-ai-raw-import-unreadable",
  /** ADR-0071: the file parsed, but line(s) in it did not, and the caller asked
   * for the default posture of refusing the whole file rather than accepting a
   * quietly smaller inventory */
  rawMalformedRows: "shadow-ai-raw-import-malformed-rows",
  findingDisposition: "shadow-ai-finding-disposition",
  findingRemediationLinked: "shadow-ai-finding-remediation-linked",
  /** ADR-0083: a first-party discovery classification that produced nothing to
   * ingest — audited anyway, because "we looked and found no shadow candidate"
   * is itself a governance event an operator will want to point at */
  discoveryClassified: "shadow-ai-discovery-classified",
  /** ADR-0083: the operator's pasted input was unreadable as a whole (a
   * package.json that is not JSON) — refused loudly, nothing written */
  discoveryUnreadable: "shadow-ai-discovery-unreadable",
} as const;

const SEVERITY_RANK: Record<ShadowAiSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const dispositionSchema = z
  .object({
    disposition: z.enum(SHADOW_AI_DISPOSITIONS),
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict()
  .refine((b) => b.disposition === "open" || Boolean(b.reason?.trim()), {
    message:
      "moving a finding off 'open' records a reason — 'sanctioned' and 'false_positive' are judgements a later reviewer has to be able to audit",
  });

const remediateSchema = z.object({ instanceId: z.string().uuid() }).strict();

// --- ADR-0083: first-party discovery -----------------------------------------

const discoveryRequestSchema = z
  .object({
    sourceKind: z.enum(SHADOW_DISCOVERY_SOURCE_KINDS),
    /** the operator's pasted text — a log excerpt or a dependency manifest */
    content: z.string().min(1),
    /** what the input BELONGS to. Required for manifests (it becomes the
     * code_scan `repo` — a finding without one points at nothing); optional
     * for logs, where it becomes the egress rows' sourceIdentity (a coarse,
     * operator-asserted label like "office-dns", never an inference). */
    subject: z.string().min(1).max(200).optional(),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
  })
  .strict();

/** the honest-limits sentence the catalogue route and the SPA print verbatim */
export const SHADOW_DISCOVERY_LIMITS =
  "The compiled catalogue is FROZEN at version " +
  SHADOW_AI_CATALOG_VERSION +
  " and is inherently incomplete and dated: it names the providers its authors knew of on its freeze date, and a " +
  "provider it does not name is invisible to this classifier (the admin catalogue, which is data, needs no release " +
  "to grow). Only generic input shapes are read — DNS/proxy log LINES and package.json / requirements.txt / go.mod " +
  "manifests; for real log grammars with per-row attribution and timestamps use the format adapters. The line " +
  "scanner attributes traffic to nobody and reads no timestamps. A hit proves an artifact MENTIONED a provider, " +
  "never that traffic flowed; encrypted or DNS-over-HTTPS traffic that bypasses the exported log is invisible. " +
  "governed_via_gateway means this deployment is CONFIGURED to reach the host — a log line cannot tell gateway " +
  "traffic from a rogue client's. Nothing runs continuously: every classification is operator-initiated.";

/** the catalogue row shape the matcher wants, read out of the DB row */
function toSignature(r: typeof aiEndpointSignatures.$inferSelect): AiSignature {
  return {
    provider: r.provider,
    kind: r.kind,
    value: r.value,
    matchType: r.matchType,
    minLength: r.minLength,
    replacementAgentId: r.replacementAgentId,
    replacementNote: r.replacementNote,
    provenance: r.provenance,
    lastUpdatedAt: r.lastUpdatedAt,
    enabled: r.enabled,
  };
}

export function registerShadowAiRoutes(app: FastifyInstance, db: Db): void {
  const audit = (
    actorUserId: string | null,
    objectType: "ai_endpoint_signature" | "shadow_ai_import" | "shadow_ai_finding",
    objectId: string | null,
    ruleId: string,
    effect: "allow" | "deny",
    reason: string,
    detail: Record<string, unknown>,
  ) =>
    db.insert(auditLog).values({
      userId: actorUserId ?? NIL_UUID,
      objectType,
      objectId,
      detail: { subsystem: "shadow-ai-discovery", ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });

  const loadCatalogue = async (): Promise<AiSignature[]> =>
    (await db.select().from(aiEndpointSignatures)).map(toSignature);

  /**
   * THE ONE IMPORT PIPELINE (ADR-0055), now with two front doors.
   *
   * Everything from the analysis onward — the pure `analyzeImport`, the
   * `shadow_ai_imports` row, the dry-run/apply split, the audit row and the
   * finding upsert — lives here and NOWHERE ELSE. `POST /v1/shadow-ai/imports`
   * (rows already normalised) and ADR-0071's `POST /v1/shadow-ai/imports/raw`
   * (a raw vendor file put through a format adapter) both end up in this
   * function with an `EvidenceImport` in hand.
   *
   * That is the whole shape of ADR-0071: an adapter LAYER, not a second
   * pipeline. A raw import cannot reach a code path the JSON import does not,
   * cannot skip the escalation screen or the strict row schemas, and cannot
   * write anything the JSON import could not write.
   */
  const processEvidenceImport = async (
    req: FastifyRequest,
    imp: EvidenceImport,
    fingerprint: string,
    extraSummary: Record<string, unknown>,
  ) => {
    const catalogue = await loadCatalogue();
    const analysis = analyzeImport(imp, catalogue);

    const summary = {
      ...extraSummary,
      observed: analysis.observed,
      matched: analysis.matched,
      unmatched: analysis.unmatched,
      dropped: analysis.dropped,
      findings: analysis.findings.map((f) => ({
        subjectKind: f.subjectKind,
        subject: f.subject,
        provider: f.provider,
        severity: f.severity,
        confidence: f.confidence,
      })),
    };

    if (imp.mode === "dry_run") {
      const [row] = await db
        .insert(shadowAiImports)
        .values({
          kind: imp.kind,
          mode: "dry_run",
          status: "planned",
          source: imp.source ?? null,
          payloadSha256: fingerprint,
          rowCount: imp.rows.length,
          summary,
          ruleId: SHADOW_AI_RULE_IDS.importPlanned,
          reason: `dry run: ${analysis.matched} of ${analysis.observed} observation(s) matched the catalogue, producing ${analysis.findings.length} finding(s); nothing was written to the inventory`,
          requestedByUserId: req.authCtx.userId ?? null,
        })
        .returning();
      await audit(req.authCtx.userId, "shadow_ai_import", row!.id, SHADOW_AI_RULE_IDS.importPlanned, "allow",
        row!.reason, { kind: imp.kind, payloadSha256: fingerprint, ...summary });
      return { importId: row!.id, mode: "dry_run" as const, ...analysis };
    }

    // APPLY. The ONLY write an import can make is into shadow_ai_findings.
    const [importRow] = await db
      .insert(shadowAiImports)
      .values({
        kind: imp.kind,
        mode: "apply",
        status: "applied",
        source: imp.source ?? null,
        payloadSha256: fingerprint,
        rowCount: imp.rows.length,
        summary,
        ruleId: SHADOW_AI_RULE_IDS.importApplied,
        reason: `applied: ${analysis.matched} of ${analysis.observed} observation(s) matched, producing ${analysis.findings.length} correlated finding(s)`,
        requestedByUserId: req.authCtx.userId ?? null,
        appliedAt: new Date(),
      })
      .returning();

    const result = await upsertFindings(db, analysis.findings, importRow!.id);
    await audit(req.authCtx.userId, "shadow_ai_import", importRow!.id, SHADOW_AI_RULE_IDS.importApplied, "allow",
      importRow!.reason, { kind: imp.kind, payloadSha256: fingerprint, ...summary, ...result });

    return { importId: importRow!.id, mode: "apply" as const, ...analysis, ...result };
  };

  // =======================================================================
  // THE CATALOGUE — data, not code
  // =======================================================================

  app.get("/v1/shadow-ai/catalogue", async () => {
    const rows = await db.select().from(aiEndpointSignatures).orderBy(aiEndpointSignatures.provider);
    const enabled = rows.filter((r) => r.enabled).length;
    const oldest = rows.reduce<Date | null>(
      (acc, r) => (acc === null || r.lastUpdatedAt < acc ? r.lastUpdatedAt : acc),
      null,
    );
    return {
      signatures: rows,
      total: rows.length,
      enabled,
      /** ADR-0055's staleness disclosure, computed rather than asserted: a
       * catalogue nobody has touched in a year detects last year's providers. */
      oldestEntryAt: oldest,
      posture:
        "The catalogue is DATA. Detection for a new provider — including a private in-house endpoint — is a row here, " +
        "never a release. The matcher holds no provider name: with this table empty, discovery matches nothing. " +
        "A brand-new provider is invisible until its row exists; `provenance` and `lastUpdatedAt` are on every row so " +
        "that lag is legible instead of hidden.",
    };
  });

  app.post("/v1/shadow-ai/catalogue/seed", async (req) => {
    const before = await db.select({ n: sql<number>`count(*)::int` }).from(aiEndpointSignatures);
    let inserted = 0;
    let refreshed = 0;
    for (const s of DEFAULT_AI_SIGNATURES) {
      const [existing] = await db
        .select()
        .from(aiEndpointSignatures)
        .where(and(eq(aiEndpointSignatures.kind, s.kind), sql`lower(${aiEndpointSignatures.value}) = lower(${s.value})`));
      if (!existing) {
        await db.insert(aiEndpointSignatures).values({
          provider: s.provider,
          kind: s.kind,
          value: s.value,
          matchType: s.matchType,
          minLength: s.minLength ?? null,
          provenance: s.provenance,
          enabled: s.enabled,
          updatedByUserId: req.authCtx.userId ?? null,
        });
        inserted += 1;
        continue;
      }
      // AN ADMIN'S EDIT IS NEVER CLOBBERED. Re-seeding refreshes only rows that
      // are still ours: the instant an admin edits a row its provenance becomes
      // 'admin' and the seed leaves it alone forever. Without this a customer's
      // disabled false-positive would come back on the next seed.
      if (existing.provenance === "regulait-seed") {
        await db
          .update(aiEndpointSignatures)
          .set({ provider: s.provider, matchType: s.matchType, minLength: s.minLength ?? null, lastUpdatedAt: new Date() })
          .where(eq(aiEndpointSignatures.id, existing.id));
        refreshed += 1;
      }
    }
    await audit(req.authCtx.userId, "ai_endpoint_signature", null, SHADOW_AI_RULE_IDS.catalogueSeeded, "allow",
      `shipped signature seed installed: ${inserted} added, ${refreshed} refreshed (admin-edited rows untouched)`,
      { inserted, refreshed, before: before[0]?.n ?? 0 });
    return { inserted, refreshed, total: DEFAULT_AI_SIGNATURES.length };
  });

  app.post("/v1/shadow-ai/catalogue", async (req, reply) => {
    const body = catalogueSignatureSchema.parse(req.body);
    if (body.replacementAgentId) {
      const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, body.replacementAgentId));
      if (!agent) return reply.status(400).send({ error: "invalid_reference", detail: "replacementAgentId names no agent" });
    }
    const [existing] = await db
      .select()
      .from(aiEndpointSignatures)
      .where(and(eq(aiEndpointSignatures.kind, body.kind), sql`lower(${aiEndpointSignatures.value}) = lower(${body.value})`));
    const values = {
      provider: body.provider,
      kind: body.kind,
      value: body.value,
      matchType: body.matchType,
      minLength: body.minLength ?? null,
      replacementAgentId: body.replacementAgentId ?? null,
      replacementNote: body.replacementNote ?? null,
      // an admin touching a row TAKES OWNERSHIP of it — see the seed above
      provenance: body.provenance === "admin" ? "admin" : body.provenance,
      enabled: body.enabled,
      lastUpdatedAt: new Date(),
      updatedByUserId: req.authCtx.userId ?? null,
    };
    const [row] = existing
      ? await db.update(aiEndpointSignatures).set(values).where(eq(aiEndpointSignatures.id, existing.id)).returning()
      : await db.insert(aiEndpointSignatures).values(values).returning();
    await audit(req.authCtx.userId, "ai_endpoint_signature", row!.id, SHADOW_AI_RULE_IDS.catalogueUpserted, "allow",
      `${existing ? "updated" : "registered"} ${body.kind} signature '${body.value}' for provider '${body.provider}'`,
      { kind: body.kind, value: body.value, provider: body.provider, enabled: body.enabled });
    return reply.status(existing ? 200 : 201).send(row);
  });

  app.delete("/v1/shadow-ai/catalogue/:signatureId", async (req, reply) => {
    const { signatureId } = z.object({ signatureId: z.string().uuid() }).parse(req.params);
    const [row] = await db.delete(aiEndpointSignatures).where(eq(aiEndpointSignatures.id, signatureId)).returning();
    if (!row) return reply.status(404).send({ error: "unknown_signature" });
    await audit(req.authCtx.userId, "ai_endpoint_signature", signatureId, SHADOW_AI_RULE_IDS.catalogueDeleted, "allow",
      `removed ${row.kind} signature '${row.value}' — this provider is no longer detected`,
      { kind: row.kind, value: row.value, provider: row.provider });
    return { deleted: true, id: signatureId };
  });

  // =======================================================================
  // THE IMPORT — the untrusted path
  // =======================================================================

  app.post("/v1/shadow-ai/imports", async (req, reply) => {
    const raw = req.body;
    const rawJson = JSON.stringify(raw ?? null);

    // WALL 0 — SIZE. Before anything walks or parses the document. A hostile
    // evidence file is cheap to send and expensive to analyze; the bound is
    // checked on the bytes, not on a row count we would have to parse to know.
    if (rawJson.length > EVIDENCE_MAX_BYTES) {
      await audit(req.authCtx.userId, "shadow_ai_import", null, SHADOW_AI_RULE_IDS.importTooLarge, "deny",
        `evidence payload of ${rawJson.length} bytes exceeds the ${EVIDENCE_MAX_BYTES}-byte import bound — chunk the export`,
        { bytes: rawJson.length, limit: EVIDENCE_MAX_BYTES });
      return reply.status(413).send({
        error: "evidence_too_large",
        detail: `evidence payloads are bounded at ${EVIDENCE_MAX_BYTES} bytes; split the export into chunks`,
      });
    }

    const fingerprint = sha256(rawJson);
    const kindGuess = (typeof raw === "object" && raw !== null && typeof (raw as { kind?: unknown }).kind === "string"
      ? (raw as { kind: string }).kind
      : "egress_log") as EvidenceKind;
    const safeKind: EvidenceKind = (["egress_log", "code_scan", "saas_export", "self_reported"] as const).includes(kindGuess)
      ? kindGuess
      : "egress_log";

    const recordRefusal = async (reason: string, summary: Record<string, unknown>, ruleId: string) => {
      const [row] = await db
        .insert(shadowAiImports)
        .values({
          kind: safeKind,
          // a refusal is recorded against the mode it ASKED for, so "somebody
          // tried to apply this" is distinguishable from "somebody previewed it"
          mode: (typeof raw === "object" && raw !== null && (raw as { mode?: unknown }).mode === "apply") ? "apply" : "dry_run",
          status: "refused",
          source: null,
          payloadSha256: fingerprint,
          rowCount: 0,
          summary,
          ruleId,
          reason,
          requestedByUserId: req.authCtx.userId ?? null,
        })
        .returning();
      await audit(req.authCtx.userId, "shadow_ai_import", row!.id, ruleId, "deny", reason, {
        payloadSha256: fingerprint,
        ...summary,
      });
      return row!;
    };

    // WALL 1 — THE ESCALATION SCREEN, on the raw document, before parsing.
    // Its job is not defence (wall 2 is): it is to make the refusal SPECIFIC
    // and AUDITED, so an operator sees "row 3 tried to set isAdmin" rather than
    // a generic schema error. A silent strip would be the worst outcome — the
    // uploader would believe the privilege landed.
    const escalation = screenEvidencePayload(raw);
    if (escalation.length > 0) {
      const reason =
        `evidence import refused: the payload carries governance-shaped field(s) ` +
        `${escalation.slice(0, 5).map((e) => `'${e.path}'`).join(", ")}. An evidence file describes observed usage; ` +
        `it is never an instruction to the platform, and no import can create a user, role, grant, entitlement, agent or approval.`;
      const row = await recordRefusal(reason, { escalation: escalation.slice(0, 20) }, SHADOW_AI_RULE_IDS.importPrivilegeRefused);
      return reply.status(422).send({ error: "privilege_escalation_refused", importId: row.id, findings: escalation.slice(0, 20), detail: reason });
    }

    // WALL 2 — THE STRICT SCHEMAS. Every row shape is `.strict()`, every string
    // bounded, the batch row-bounded. There is no privilege field to parse into
    // even if wall 1 were bypassed.
    const parsed = evidenceImportSchema.safeParse(raw);
    if (!parsed.success) {
      const reason = `evidence import refused: payload failed schema validation (${parsed.error.issues.length} issue(s))`;
      const row = await recordRefusal(
        reason,
        { issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })) },
        SHADOW_AI_RULE_IDS.importRejected,
      );
      return reply.status(422).send({
        error: "invalid_evidence",
        importId: row.id,
        detail: reason,
        issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const imp = parsed.data;

    // WALL 3 — the analysis itself is a PURE function of (rows, catalogue),
    // and it lives in the ONE pipeline both import routes feed. Same call for a
    // dry run and an apply, so the preview cannot disagree with what the apply
    // then does.
    return reply.status(200).send(await processEvidenceImport(req, imp, fingerprint, {}));
  });

  // =======================================================================
  // ADR-0071 — THE FORMAT ADAPTERS: the same untrusted path, one layer lower
  // =======================================================================

  app.get("/v1/shadow-ai/adapters", async () => ({
    adapters: describeEvidenceAdapters(),
    posture: EVIDENCE_ADAPTER_POSTURE,
    pipeline:
      "An adapter turns a raw file into the SAME evidence rows POST /v1/shadow-ai/imports already accepts, and hands " +
      "them to the SAME dry-run/apply pipeline. It is a layer, not a second importer: it cannot reach a code path " +
      "the row-shaped import cannot, cannot skip the escalation screen or the strict row schemas, and cannot write " +
      "anything the row-shaped import could not write.",
  }));

  /**
   * RAW FILE IN, ADR-0055 ROWS OUT.
   *
   * The walls, in order, and why each is where it is:
   *   0. SIZE, on the raw bytes, before anything is scanned.
   *   1. THE ADAPTER, whose whole-file failure ("this is not a W3C log") is
   *      reported once rather than as five thousand identical row errors.
   *   2. MALFORMED ROWS. The DEFAULT refuses the entire file, because the
   *      specific failure this route must not have is a quietly smaller
   *      inventory that looks complete. `report_and_continue` is the opt-in, and
   *      it still returns every refusal with its file line number.
   *   3. THE ESCALATION SCREEN and the STRICT ROW SCHEMAS — ADR-0055's own,
   *      re-run over the adapter's output. They cannot fire on file content,
   *      because an adapter's output vocabulary is fixed by those same schemas;
   *      running them anyway is what makes that a property rather than a claim.
   *   4. THE ONE PIPELINE.
   */
  app.post("/v1/shadow-ai/imports/raw", async (req, reply) => {
    const raw = req.body;

    const parsedReq = rawEvidenceImportRequestSchema.safeParse(raw);
    if (!parsedReq.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsedReq.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const body = parsedReq.data;

    const adapter = getEvidenceAdapter(body.adapter);
    if (!adapter) {
      return reply.status(400).send({
        error: "unknown_adapter",
        detail: `no evidence-format adapter named '${body.adapter}'`,
        available: describeEvidenceAdapters().map((a) => a.id),
      });
    }
    if (!adapter.formats.includes(body.format)) {
      return reply.status(400).send({
        error: "unsupported_format",
        detail: `adapter '${adapter.id}' does not read ${body.format}; it reads ${adapter.formats.join(", ")}`,
      });
    }

    const fingerprint = sha256(body.content);
    // the kind a refusal is RECORDED against before the adapter has run: the
    // only kind this adapter can produce when it produces exactly one, and
    // otherwise the ADR-0055 default. A refusal row must exist even when we
    // never learned what the file was.
    const fallbackKind: EvidenceKind =
      adapter.capabilities.kinds.length === 1 ? adapter.capabilities.kinds[0]! : "egress_log";

    const recordRefusal = async (ruleId: string, reason: string, summary: Record<string, unknown>) => {
      const [row] = await db
        .insert(shadowAiImports)
        .values({
          kind: fallbackKind,
          mode: body.mode,
          status: "refused",
          source: body.source ?? null,
          payloadSha256: fingerprint,
          rowCount: 0,
          summary: { adapter: adapter.id, format: body.format, ...summary },
          ruleId,
          reason,
          requestedByUserId: req.authCtx.userId ?? null,
        })
        .returning();
      await audit(req.authCtx.userId, "shadow_ai_import", row!.id, ruleId, "deny", reason, {
        adapter: adapter.id,
        payloadSha256: fingerprint,
        ...summary,
      });
      return row!;
    };

    // WALL 0 — SIZE, on the raw bytes.
    if (body.content.length > EVIDENCE_MAX_BYTES) {
      const reason =
        `evidence file of ${body.content.length} bytes exceeds the ${EVIDENCE_MAX_BYTES}-byte import bound — chunk the export`;
      const row = await recordRefusal(SHADOW_AI_RULE_IDS.importTooLarge, reason, { bytes: body.content.length });
      return reply.status(413).send({ error: "evidence_too_large", importId: row.id, detail: reason });
    }

    // WALL 1 — THE ADAPTER.
    let parsed;
    try {
      parsed = adapter.parse({ content: body.content, format: body.format, config: body.config });
    } catch (e) {
      if (e instanceof EvidenceFormatError) {
        const row = await recordRefusal(SHADOW_AI_RULE_IDS.rawUnreadable, e.message, {
          adapterError: e.code,
          ...e.detail,
        });
        return reply.status(422).send({ error: e.code, importId: row.id, detail: e.message, ...e.detail });
      }
      if (e instanceof z.ZodError) {
        const detail = `adapter '${adapter.id}' rejected its configuration: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
        const row = await recordRefusal(SHADOW_AI_RULE_IDS.rawUnreadable, detail, { adapterError: "invalid_config" });
        return reply.status(422).send({
          error: "invalid_adapter_config",
          importId: row.id,
          detail,
          issues: e.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      throw e;
    }

    const boundedRefusals = parsed.refusals.slice(0, 50) as unknown as Array<Record<string, unknown>>;
    const parseSummary = {
      adapter: adapter.id,
      format: body.format,
      formatBasis: adapter.formatBasis,
      fieldsUsed: parsed.fieldsUsed,
      rowsParsed: parsed.rowsParsed,
      rowsAccepted: parsed.rows.length,
      rowsRefused: parsed.refusals.length,
      rowsWithoutTimestamp: parsed.rowsWithoutTimestamp,
      refusals: boundedRefusals,
    };

    // WALL 2 — MALFORMED ROWS. Default: refuse the file.
    if (parsed.refusals.length > 0 && body.onMalformedRow === "refuse_file") {
      const first = parsed.refusals[0] as EvidenceRowRefusal;
      const reason =
        `evidence import refused: ${parsed.refusals.length} of ${parsed.rowsParsed} line(s) could not be read, ` +
        `starting at line ${first.row} (${first.reason}). Accepting the remaining ${parsed.rows.length} line(s) would ` +
        `hand you a SMALLER inventory that looks complete, so the whole file is refused. Fix the export, or re-send ` +
        `with onMalformedRow='report_and_continue' to accept the readable lines with every refusal listed.`;
      const row = await recordRefusal(SHADOW_AI_RULE_IDS.rawMalformedRows, reason, parseSummary);
      return reply.status(422).send({
        error: "malformed_rows",
        importId: row.id,
        detail: reason,
        rowsParsed: parsed.rowsParsed,
        rowsAccepted: 0,
        rowsRefused: parsed.refusals.length,
        refusals: parsed.refusals.slice(0, 50),
      });
    }

    if (parsed.rows.length === 0) {
      const reason =
        `evidence import refused: the adapter '${adapter.id}' read ${parsed.rowsParsed} candidate line(s) and produced ` +
        `no usable evidence rows. Nothing was written.`;
      const row = await recordRefusal(SHADOW_AI_RULE_IDS.rawUnreadable, reason, parseSummary);
      return reply.status(422).send({
        error: "no_rows",
        importId: row.id,
        detail: reason,
        rowsParsed: parsed.rowsParsed,
        rowsRefused: parsed.refusals.length,
        refusals: parsed.refusals.slice(0, 50),
      });
    }

    // WALL 3 — ADR-0055's OWN screens, re-run over the adapter's output. These
    // cannot fire on file content (the output vocabulary is fixed by the very
    // schemas below), which is exactly why they are run rather than assumed.
    const imp: EvidenceImport = {
      kind: parsed.kind,
      mode: body.mode,
      ...(body.source ? { source: body.source } : {}),
      rows: parsed.rows,
    } as EvidenceImport;

    const escalation = screenEvidencePayload(imp);
    if (escalation.length > 0) {
      const reason =
        `evidence import refused: the rows adapter '${adapter.id}' produced carry governance-shaped field(s) ` +
        `${escalation.slice(0, 5).map((e) => `'${e.path}'`).join(", ")}. An evidence file describes observed usage; ` +
        `it is never an instruction to the platform.`;
      const row = await recordRefusal(SHADOW_AI_RULE_IDS.importPrivilegeRefused, reason, {
        ...parseSummary,
        escalation: escalation.slice(0, 20),
      });
      return reply.status(422).send({ error: "privilege_escalation_refused", importId: row.id, detail: reason });
    }

    const validated = evidenceImportSchema.safeParse(imp);
    if (!validated.success) {
      const reason =
        `evidence import refused: adapter '${adapter.id}' produced rows that ADR-0055's row schema rejects ` +
        `(${validated.error.issues.length} issue(s)). This is an adapter defect, not a file defect — nothing was written.`;
      const row = await recordRefusal(SHADOW_AI_RULE_IDS.importRejected, reason, {
        ...parseSummary,
        issues: validated.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
      return reply.status(422).send({
        error: "adapter_output_rejected",
        importId: row.id,
        detail: reason,
        issues: validated.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }

    // WALL 4 — THE ONE PIPELINE.
    const result = await processEvidenceImport(req, validated.data, fingerprint, parseSummary);
    return reply.status(200).send({
      ...result,
      adapter: adapter.id,
      kind: parsed.kind,
      rowsParsed: parsed.rowsParsed,
      rowsAccepted: parsed.rows.length,
      rowsRefused: parsed.refusals.length,
      rowsWithoutTimestamp: parsed.rowsWithoutTimestamp,
      refusals: parsed.refusals.slice(0, 50),
      fieldsUsed: parsed.fieldsUsed,
      limits: adapter.limits,
      verification: adapter.verification,
      posture: EVIDENCE_ADAPTER_POSTURE,
    });
  });

  // =======================================================================
  // ADR-0083 — FIRST-PARTY DISCOVERY: a classifier, not a collector
  // =======================================================================

  /**
   * THE HOSTS THIS GATEWAY LEGITIMATELY FRONTS, from live configuration and
   * nothing else: stored platform/user model credentials (their baseUrl
   * override, or the provider's compiled default endpoint), the env-var
   * credential fallback where org settings allow it, and enabled custom
   * providers. Computed at request time — a credential added five minutes ago
   * moves the governed/shadow line five minutes ago.
   *
   * Deliberately NOT included: `egress_allow_hosts`. That table answers "may
   * this deployment reach X" for connectors, git, Slack — an allow-listed
   * host is not a host the gateway FRONTS AI TRAFFIC to, and using it here
   * would launder ordinary egress permissions into "governed AI".
   */
  const loadGovernedHosts = async (): Promise<Map<string, string>> => {
    const governed = new Map<string, string>();
    const put = (rawUrl: string | null | undefined, reason: string) => {
      if (!rawUrl) return;
      const host = normalizeEvidenceHost(rawUrl);
      if (host && !governed.has(host)) governed.set(host, reason);
    };
    for (const row of await db.select().from(modelCredentials)) {
      put(
        row.baseUrl ?? defaultBaseUrlFor(row.provider),
        `this deployment holds a platform model credential for provider '${row.provider}' and dispatches to this host`,
      );
    }
    for (const row of await db
      .select({ provider: userModelCredentials.provider, baseUrl: userModelCredentials.baseUrl })
      .from(userModelCredentials)) {
      put(
        row.baseUrl ?? defaultBaseUrlFor(row.provider),
        `a user's own (BYO) model credential for provider '${row.provider}' dispatches to this host through the gateway`,
      );
    }
    const org = await loadOrgSettings(db);
    for (const provider of ENV_FALLBACK_PROVIDERS) {
      if (!envFallbackAllowed(org, provider)) continue;
      const envKey = platformEnvKey(provider);
      if (!envKey) continue;
      put(
        envKey.baseUrl ?? defaultBaseUrlFor(provider),
        `the '${provider}' platform env-var credential fallback is active on this deployment`,
      );
    }
    for (const row of await db.select().from(customModelProviders)) {
      if (!row.enabled) continue;
      put(row.baseUrl, `enabled custom model provider '${row.name}' — this deployment's own governed endpoint`);
    }
    return governed;
  };

  app.get("/v1/shadow-ai/discovery/catalog", async () => {
    const governed = await loadGovernedHosts();
    return {
      catalogVersion: SHADOW_AI_CATALOG_VERSION,
      total: SHADOW_AI_CATALOG_V1.length,
      endpoints: SHADOW_AI_CATALOG_V1.filter((e) => e.kind === "endpoint").length,
      sdks: SHADOW_AI_CATALOG_V1.filter((e) => e.kind === "sdk").length,
      entries: SHADOW_AI_CATALOG_V1,
      /** what THIS deployment fronts right now — the shadow/governed line */
      governedHosts: [...governed.entries()]
        .map(([host, reason]) => ({ host, reason }))
        .sort((a, b) => a.host.localeCompare(b.host)),
      posture: SHADOW_DISCOVERY_POSTURE,
      limits: SHADOW_DISCOVERY_LIMITS,
    };
  });

  /**
   * CLASSIFY OPERATOR-SUPPLIED TEXT, then (on apply) ingest the SHADOW hits
   * through THE ONE PIPELINE — the same `processEvidenceImport` both existing
   * front doors end in. The walls, in ADR-0071's order:
   *   0. SIZE, on the raw text.
   *   1. THE CLASSIFIER (pure; a whole-file parse failure refuses loudly).
   *   2. THE GOVERNED SCREEN — hits on hosts this gateway fronts are labelled
   *      governed_via_gateway and NEVER forwarded: filing the deployment's own
   *      sanctioned traffic as shadow findings would manufacture findings.
   *   3. THE ONE PIPELINE, over shadow hits only. Findings are still computed
   *      by the ADMIN catalogue there; a compiled hit the admin catalogue does
   *      not know is returned as a GAP with the row that would close it,
   *      never silently promoted into a finding.
   * The pasted content itself is NEVER persisted — only its SHA-256, the
   * bounded classification summary and any evidence rows survive the request.
   */
  app.post("/v1/shadow-ai/discovery", async (req, reply) => {
    const parsedReq = discoveryRequestSchema.safeParse(req.body);
    if (!parsedReq.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsedReq.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const body = parsedReq.data;
    const fingerprint = sha256(body.content);
    const isManifest = body.sourceKind !== "dns_log" && body.sourceKind !== "proxy_log";
    const fallbackKind: EvidenceKind = isManifest ? "code_scan" : "egress_log";

    const recordRefusal = async (ruleId: string, reason: string, summary: Record<string, unknown>) => {
      const [row] = await db
        .insert(shadowAiImports)
        .values({
          kind: fallbackKind,
          mode: body.mode,
          status: "refused",
          source: `first_party_discovery:v${SHADOW_AI_CATALOG_VERSION}:${body.sourceKind}`,
          payloadSha256: fingerprint,
          rowCount: 0,
          summary: { firstPartyDiscovery: true, sourceKind: body.sourceKind, catalogVersion: SHADOW_AI_CATALOG_VERSION, ...summary },
          ruleId,
          reason,
          requestedByUserId: req.authCtx.userId ?? null,
        })
        .returning();
      await audit(req.authCtx.userId, "shadow_ai_import", row!.id, ruleId, "deny", reason, {
        sourceKind: body.sourceKind,
        catalogVersion: SHADOW_AI_CATALOG_VERSION,
        payloadSha256: fingerprint,
        ...summary,
      });
      return row!;
    };

    // WALL 0 — SIZE, on the raw text.
    if (body.content.length > EVIDENCE_MAX_BYTES) {
      const reason = `discovery input of ${body.content.length} bytes exceeds the ${EVIDENCE_MAX_BYTES}-byte bound — chunk the export`;
      const row = await recordRefusal(SHADOW_AI_RULE_IDS.importTooLarge, reason, { bytes: body.content.length });
      return reply.status(413).send({ error: "evidence_too_large", importId: row.id, detail: reason });
    }
    if (isManifest && !body.subject) {
      return reply.status(400).send({
        error: "subject_required",
        detail:
          "a manifest classification needs `subject` — the repo or service the manifest belongs to. It becomes the code_scan finding's repo; a finding without one points at nothing.",
      });
    }

    // WALL 1+2 — THE CLASSIFIER, with the deployment's own governed hosts.
    const governedHosts = await loadGovernedHosts();
    let classification;
    try {
      classification = classifyDiscoveryContent({ sourceKind: body.sourceKind, content: body.content, governedHosts });
    } catch (e) {
      if (e instanceof DiscoveryParseError) {
        const reason = `first-party discovery refused: ${e.message}`;
        const row = await recordRefusal(SHADOW_AI_RULE_IDS.discoveryUnreadable, reason, {});
        return reply.status(422).send({ error: e.code, importId: row.id, detail: e.message });
      }
      throw e;
    }

    const boundedMatches = classification.shadow.slice(0, 50).map((c) => ({
      value: c.value,
      kind: c.kind,
      entryId: c.entryId,
      provider: c.provider,
      occurrences: c.occurrences,
      origins: c.origins,
    }));
    const boundedGoverned = classification.governed.slice(0, 50).map((c) => ({
      value: c.value,
      kind: c.kind,
      entryId: c.entryId,
      provider: c.provider,
      occurrences: c.occurrences,
      governedReason: c.governedReason,
    }));
    const summaryBase = {
      catalogVersion: classification.catalogVersion,
      sourceKind: body.sourceKind,
      ...(body.subject ? { subject: body.subject } : {}),
      linesScanned: classification.linesScanned,
      candidateCount: classification.candidateCount,
      shadowCount: classification.shadow.length,
      governedCount: classification.governed.length,
      unmatchedCount: classification.unmatchedCount,
    };
    const classificationView = {
      ...summaryBase,
      unmatchedOccurrences: classification.unmatchedOccurrences,
      unmatchedSample: classification.unmatchedSample,
    };
    /** what every response says about the upload itself */
    const retention =
      "The pasted content was not stored. Only its SHA-256 fingerprint, this bounded classification summary and any ingested evidence rows persist.";

    if (classification.shadow.length === 0) {
      // NOTHING TO INGEST — a legitimate, auditable outcome, not an error.
      await audit(
        req.authCtx.userId,
        "shadow_ai_import",
        null,
        SHADOW_AI_RULE_IDS.discoveryClassified,
        "allow",
        `first-party discovery classified ${classification.candidateCount} candidate(s): 0 shadow, ` +
          `${classification.governed.length} governed via gateway, ${classification.unmatchedCount} unmatched — nothing to ingest`,
        { payloadSha256: fingerprint, ...summaryBase },
      );
      return reply.status(200).send({
        mode: body.mode,
        classification: classificationView,
        matches: [],
        governed: boundedGoverned,
        deploymentCatalogueGaps: [],
        ingest: null,
        rawContentStored: false,
        retention,
        posture: SHADOW_DISCOVERY_POSTURE,
      });
    }

    // THE GAP REPORT — which compiled hits would the ADMIN catalogue (the only
    // thing that can mint a finding) NOT match. Computed with ADR-0055's own
    // pure classifier so this cannot drift from what the pipeline will do.
    const adminCatalogue = await loadCatalogue();
    const nowIso = new Date().toISOString();
    const deploymentCatalogueGaps = classification.shadow
      .filter((c) => {
        const obs: Observation =
          c.kind === "endpoint"
            ? { subjectKind: "host", subject: "gap-probe", signalSource: "egress_log", observedAt: nowIso, count: 1, host: c.value }
            : { subjectKind: "repo", subject: "gap-probe", signalSource: "code_scan", observedAt: nowIso, count: 1, packageName: c.value };
        return !classifyObservation(obs, adminCatalogue).matched;
      })
      .slice(0, 50)
      .map((c) => ({ value: c.value, kind: c.kind, provider: c.provider, entryId: c.entryId }));

    // WALL 3 — THE ONE PIPELINE, shadow hits only. Rows are aggregated per
    // distinct host/package so the count is bounded in practice by the
    // catalogue; the slice is the hard bound a hostile input cannot exceed.
    const truncated = classification.shadow.length > EVIDENCE_MAX_ROWS;
    const shadowRows = classification.shadow.slice(0, EVIDENCE_MAX_ROWS);
    const source = `first_party_discovery:v${SHADOW_AI_CATALOG_VERSION}:${body.sourceKind}`;
    const imp: EvidenceImport = isManifest
      ? {
          kind: "code_scan",
          mode: body.mode,
          source,
          rows: shadowRows.map((c) => ({ repo: body.subject!, packageName: c.value })),
        }
      : {
          kind: "egress_log",
          mode: body.mode,
          source,
          rows: shadowRows.map((c) => ({
            destinationHost: c.value,
            requestCount: c.occurrences,
            ...(body.subject ? { sourceIdentity: body.subject } : {}),
          })),
        };

    const result = await processEvidenceImport(req, imp, fingerprint, {
      firstPartyDiscovery: {
        ...summaryBase,
        ...(truncated ? { ingestTruncatedTo: EVIDENCE_MAX_ROWS } : {}),
        matches: boundedMatches,
        governed: boundedGoverned,
      },
    });

    return reply.status(200).send({
      mode: body.mode,
      classification: classificationView,
      matches: boundedMatches,
      governed: boundedGoverned,
      deploymentCatalogueGaps,
      gapNote:
        deploymentCatalogueGaps.length > 0
          ? `${deploymentCatalogueGaps.length} compiled-catalogue hit(s) will produce NO finding on this deployment, because its admin signature catalogue has no row for them. Detection is data: add the row via POST /v1/shadow-ai/catalogue to close the gap — the compiled catalogue only suggests, it never mints a finding.`
          : null,
      ...(truncated ? { ingestTruncatedTo: EVIDENCE_MAX_ROWS } : {}),
      ingest: result,
      rawContentStored: false,
      retention,
      posture: SHADOW_DISCOVERY_POSTURE,
    });
  });

  app.get("/v1/shadow-ai/imports", async () => {
    const rows = await db.select().from(shadowAiImports).orderBy(desc(shadowAiImports.createdAt)).limit(200);
    return { imports: rows };
  });

  // =======================================================================
  // THE INVENTORY
  // =======================================================================

  app.get("/v1/shadow-ai/findings", async (req) => {
    const q = z
      .object({
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        disposition: z.enum(SHADOW_AI_DISPOSITIONS).optional(),
      })
      .parse(req.query ?? {});

    const conditions = [
      ...(q.severity ? [eq(shadowAiFindings.severity, q.severity)] : []),
      ...(q.disposition ? [eq(shadowAiFindings.disposition, q.disposition)] : []),
    ];
    const rows = await (conditions.length > 0
      ? db.select().from(shadowAiFindings).where(and(...conditions))
      : db.select().from(shadowAiFindings));

    // resolve the GOVERNED REPLACEMENT — the whole point of a finding being
    // actionable rather than a complaint
    const agentIds = [...new Set(rows.map((r) => r.replacementAgentId).filter((x): x is string => Boolean(x)))];
    const agentRows = agentIds.length > 0
      ? await db.select({ id: agents.id, name: agents.name, provider: agents.provider, enabled: agents.enabled })
          .from(agents).where(inArray(agents.id, agentIds))
      : [];
    const agentById = new Map(agentRows.map((a) => [a.id, a]));

    const importRows = await db
      .select({ kind: shadowAiImports.kind, rowCount: shadowAiImports.rowCount, createdAt: shadowAiImports.createdAt })
      .from(shadowAiImports)
      .where(eq(shadowAiImports.status, "applied"));
    const byKind = new Map<EvidenceKind, { kind: EvidenceKind; imports: number; rows: number; lastImportedAt: string | null }>();
    for (const r of importRows) {
      const cur = byKind.get(r.kind) ?? { kind: r.kind, imports: 0, rows: 0, lastImportedAt: null };
      cur.imports += 1;
      cur.rows += r.rowCount;
      const at = r.createdAt.toISOString();
      if (!cur.lastImportedAt || at > cur.lastImportedAt) cur.lastImportedAt = at;
      byKind.set(r.kind, cur);
    }

    const sorted = [...rows].sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
    );

    return {
      findings: sorted.map((r) => ({
        ...r,
        replacementAgent: r.replacementAgentId ? (agentById.get(r.replacementAgentId) ?? null) : null,
        /** a finding closed as remediated/false-positive that has been OBSERVED
         * AGAIN since the judgement. Surfaced rather than silently re-opened:
         * the judgement was a human act and only a human should undo it. */
        dispositionStale:
          r.disposition !== "open" && r.dispositionAt !== null && r.lastSeenAt > r.dispositionAt,
      })),
      coverage: coverageScorecard([...byKind.values()]),
      posture:
        "Detection is SIGNAL, NOT PROOF OF MISUSE. An SDK dependency is a capability, not a violation; an endpoint " +
        "hit may be a sanctioned integration. Every row is a lead for human triage — hence the disposition states.",
    };
  });

  app.post("/v1/shadow-ai/findings/:findingId/disposition", async (req, reply) => {
    const { findingId } = z.object({ findingId: z.string().uuid() }).parse(req.params);
    const body = dispositionSchema.parse(req.body);
    const [row] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.id, findingId));
    if (!row) return reply.status(404).send({ error: "unknown_finding" });

    const [updated] = await db
      .update(shadowAiFindings)
      .set({
        disposition: body.disposition,
        dispositionReason: body.reason ?? null,
        dispositionByUserId: req.authCtx.userId ?? null,
        // the DB CHECK refuses a non-open disposition with no timestamp, so
        // this is not merely bookkeeping
        dispositionAt: body.disposition === "open" ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shadowAiFindings.id, findingId))
      .returning();

    await audit(req.authCtx.userId, "shadow_ai_finding", findingId, SHADOW_AI_RULE_IDS.findingDisposition, "allow",
      `finding for ${row.provider} on ${row.subject} moved '${row.disposition}' → '${body.disposition}'${body.reason ? `: ${body.reason}` : ""}`,
      { from: row.disposition, to: body.disposition, provider: row.provider, subject: row.subject, severity: row.severity });
    return updated;
  });

  /**
   * The "pull into governance" plan (ADR-0055 §4). It COMPOSES the steps and
   * hands back the exact body for `POST /v1/workflows/instances` — it does not
   * start a workflow, because there is exactly one route that starts workflows
   * and it already carries the assignment rules, the compliance-cascade merge,
   * the retired-template refusal and the project-attribution check.
   */
  app.get("/v1/shadow-ai/findings/:findingId/remediation-plan", async (req, reply) => {
    const { findingId } = z.object({ findingId: z.string().uuid() }).parse(req.params);
    const [row] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.id, findingId));
    if (!row) return reply.status(404).send({ error: "unknown_finding" });
    const [agent] = row.replacementAgentId
      ? await db.select().from(agents).where(eq(agents.id, row.replacementAgentId))
      : [];

    const steps: Array<{ step: string; why: string; blocked?: string }> = [];
    if (row.severity === "critical") {
      steps.push({
        step: "rotate the exposed credential",
        why: "a catalogue-matched key in source is a live credential exposure as well as an ungoverned-usage signal — it is remediated first and independently of the routing work",
      });
    }
    steps.push({
      step: "register the endpoint in the model catalogue",
      why: "ADR-0034: a governed provider entry with an egress allow-list entry is what makes the traffic routable at all",
    });
    steps.push({
      step: agent
        ? `route ${row.subject} through the governed agent '${agent.name}' via the compat surface`
        : `route ${row.subject} through the compat surface (ADR-0020)`,
      why: "the drop-in OpenAI/Anthropic-shaped endpoints mean the application changes a base URL, not its code",
      ...(agent ? {} : { blocked: "no governed replacement is registered for this provider — set replacementAgentId on the catalogue row" }),
    });
    steps.push({
      step: "grant the owner a per-user entitlement for that agent",
      why: "pillar 1: routing traffic at an ungoverned user is not governance — the entitlement is the control",
    });
    steps.push({
      step: "confirm the next call appears in audit_log and usage_events",
      why: "ADR-0055 §4: the loop closes MECHANICALLY on the ledgers, not on an assertion that it was fixed",
    });

    return {
      findingId,
      subject: row.subject,
      provider: row.provider,
      severity: row.severity,
      replacementAgent: agent ? { id: agent.id, name: agent.name, provider: agent.provider, enabled: agent.enabled } : null,
      steps,
      /** post THIS to the existing workflow route — there is no second one */
      workflowRequest: {
        route: "POST /v1/workflows/instances",
        body: {
          change: {
            targetSystem: row.subject,
            changeType: "shadow-ai-remediation",
            repoPath: row.subjectKind === "repo" ? row.subject : undefined,
          },
        },
      },
      note:
        "This module does not start workflows. It composes the plan and hands back the request body for the ONE " +
        "instantiation route, so assignment rules, the compliance cascade and the retired-template refusal all still apply.",
    };
  });

  app.post("/v1/shadow-ai/findings/:findingId/remediate", async (req, reply) => {
    const { findingId } = z.object({ findingId: z.string().uuid() }).parse(req.params);
    const body = remediateSchema.parse(req.body);
    const [row] = await db.select().from(shadowAiFindings).where(eq(shadowAiFindings.id, findingId));
    if (!row) return reply.status(404).send({ error: "unknown_finding" });
    const [instance] = await db
      .select({ id: workflowInstances.id })
      .from(workflowInstances)
      .where(eq(workflowInstances.id, body.instanceId));
    if (!instance) {
      return reply.status(400).send({
        error: "invalid_reference",
        detail: "instanceId names no workflow instance — start one through POST /v1/workflows/instances first",
      });
    }
    const [updated] = await db
      .update(shadowAiFindings)
      .set({
        remediationInstanceId: body.instanceId,
        disposition: "confirmed",
        dispositionReason: `remediation workflow ${body.instanceId} opened`,
        dispositionByUserId: req.authCtx.userId ?? null,
        dispositionAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(shadowAiFindings.id, findingId))
      .returning();
    await audit(req.authCtx.userId, "shadow_ai_finding", findingId, SHADOW_AI_RULE_IDS.findingRemediationLinked, "allow",
      `finding for ${row.provider} on ${row.subject} linked to remediation workflow instance ${body.instanceId}`,
      { instanceId: body.instanceId, provider: row.provider, subject: row.subject });
    return updated;
  });
}

/**
 * CORRELATION ACROSS IMPORTS, not merely within one. The unique index does the
 * enforcing; this does the merging. A second export re-observing the same usage
 * widens `signalSources`, extends the window, adds to the count and RAISES
 * CONFIDENCE — and never creates a second row, which is the whole difference
 * between an inventory and an alert stream.
 *
 * A HUMAN'S DISPOSITION IS NEVER OVERWRITTEN by new evidence. `dispositionStale`
 * on the read surfaces "you called this remediated and we saw it again"; only a
 * person moves it back.
 */
export async function upsertFindings(
  db: Db,
  findings: readonly CorrelatedFinding[],
  importId: string,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const f of findings) {
    const [existing] = await db
      .select()
      .from(shadowAiFindings)
      .where(
        and(
          eq(shadowAiFindings.subjectKind, f.subjectKind),
          sql`lower(${shadowAiFindings.subject}) = lower(${f.subject})`,
          sql`lower(${shadowAiFindings.provider}) = lower(${f.provider})`,
        ),
      );
    if (!existing) {
      await db.insert(shadowAiFindings).values({
        subjectKind: f.subjectKind,
        subject: f.subject,
        provider: f.provider,
        signalSources: f.signalSources,
        signatureKinds: f.signatureKinds,
        firstSeenAt: new Date(f.firstSeenAt),
        lastSeenAt: new Date(f.lastSeenAt),
        observationCount: f.observationCount,
        severity: f.severity,
        confidence: f.confidence,
        replacementAgentId: f.replacementAgentId,
        replacementNote: f.replacementNote,
        evidence: f.evidence,
        lastImportId: importId,
      });
      created += 1;
      continue;
    }
    const sources = [...new Set([...(existing.signalSources ?? []), ...f.signalSources])];
    const kinds = [...new Set([...(existing.signatureKinds ?? []), ...f.signatureKinds])];
    const incomingFirst = new Date(f.firstSeenAt);
    const incomingLast = new Date(f.lastSeenAt);
    await db
      .update(shadowAiFindings)
      .set({
        signalSources: sources,
        signatureKinds: kinds,
        firstSeenAt: incomingFirst < existing.firstSeenAt ? incomingFirst : existing.firstSeenAt,
        lastSeenAt: incomingLast > existing.lastSeenAt ? incomingLast : existing.lastSeenAt,
        observationCount: existing.observationCount + f.observationCount,
        severity: SEVERITY_RANK[f.severity] > SEVERITY_RANK[existing.severity] ? f.severity : existing.severity,
        confidence: confidenceFor(sources.length),
        replacementAgentId: existing.replacementAgentId ?? f.replacementAgentId,
        replacementNote: existing.replacementNote ?? f.replacementNote,
        evidence: [...(existing.evidence ?? []), ...f.evidence].slice(-20),
        lastImportId: importId,
        updatedAt: new Date(),
      })
      .where(eq(shadowAiFindings.id, existing.id));
    updated += 1;
  }
  return { created, updated };
}
