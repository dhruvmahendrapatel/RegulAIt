/**
 * ADR-0069 — CROSS-VENDOR COST CONSOLIDATION, the gateway half.
 *
 *   `packages/shared/src/cost-import.ts`   the adapter interface + registry,
 *                                          the five adapters, the character-
 *                                          scanned cell parsers, the identity-
 *                                          resolution rules and the
 *                                          consolidation math. Pure.
 *   THIS FILE                              persistence, the ADR-0042 ingest
 *                                          scan, entitlement scoping, the
 *                                          admin API and the audit rows.
 *
 * WHAT THIS ACTUALLY IS — SAY IT BEFORE ANYTHING ELSE
 * ---------------------------------------------------
 * `usage_events` is a METERED ledger: RegulAIt intercepted the call, checked
 * entitlement, dispatched it and priced it from a rate card. Every number in
 * it is reproducible from our own rows.
 *
 * This module handles the opposite kind of number. A customer exports a CSV out
 * of somebody else's console — a seat roster, an invoice line, a cloud CUR —
 * and hands it to us. We did not see those calls. We cannot verify the amounts.
 * The account column may not name a human we know. The seat price may have been
 * typed in by the operator. Everything this file produces is therefore stamped
 * `imported`, kept in its own table under a CHECK constraint, and reported
 * BESIDE metered spend rather than added to it.
 *
 * THE FIVE PROPERTIES THIS FILE EXISTS TO GUARANTEE
 * ------------------------------------------------
 *  1. NO BLENDED TOTAL EXISTS. `consolidate()`'s output type has no field for
 *    metered+imported, and no route here computes one. A consumer that wants a
 *    single number must decide, in the open, which basis it is willing to
 *    assert. `cost-import.test.ts` walks the whole response body asserting no
 *    number anywhere equals the sum.
 *
 *  2. NOTHING IS SILENTLY DROPPED. `rows_parsed = rows_accepted + rows_refused`
 *    is a DB CHECK. Every refused row carries its FILE LINE NUMBER and a
 *    reason. A silently dropped row is a wrong total presented confidently,
 *    which is strictly worse than a refusal.
 *
 *  3. AN UNMATCHED ACCOUNT STAYS VISIBLE. It becomes an `unresolved` line and
 *    surfaces in the consolidated view as an unattributed subject with its own
 *    money. It is never dropped, never spread across the people we DID match,
 *    and never assigned to somebody plausible.
 *
 *  4. IMPORTING IS A PRIVILEGED ACT, AND SO IS READING SOMEBODY ELSE'S SPEND.
 *    Every route here is admin-only through app.ts's default-deny gate except
 *    `GET /v1/users/:userId/cost-consolidated`, which is in NON_ADMIN_ROUTES
 *    and refuses in-handler unless the caller IS that user. Uploading a file
 *    that restates a named colleague's spend is not a convenience feature.
 *
 *  5. A RE-APPLIED FILE IS A REFUSAL, NOT A DOUBLE COUNT. A partial unique
 *    index on `payload_sha256` over live applied batches turns the single
 *    easiest way to corrupt this feature into a 409 with a stated reason. The
 *    honest re-import path is to REVOKE the earlier batch first.
 *
 * PII POSTURE (ADR-0042 / §8.4) — AND THE EXEMPTION, STATED PLAINLY
 * ----------------------------------------------------------------
 * A vendor export is a list of employee email addresses. That is not incidental
 * PII, it is the entire point: the email IS the join key onto a RegulAIt user,
 * and a `block`-mode scan that refused it would make this feature impossible
 * rather than safe. So the ACCOUNT COLUMN is exempt from the PII gate by
 * construction, and that exemption is disclosed here, in the ADR, and in the
 * import response's own `piiPosture` string.
 *
 * Every OTHER free-text field the adapters retain — service, description,
 * cost centre — goes through the SAME `detectPII` + `evaluateGuardrails` path
 * the training-corpus ingest (ADR-0065) and the dispatch path use, at a mode
 * composed MAX with the org/compliance floor, exactly like `effectiveIngestMode`.
 * Counts only, never a matched substring. Unmapped columns are discarded before
 * they reach here, so the scan surface is small on purpose.
 *
 * NO EGRESS. This module makes no outbound request of any kind. It cannot: we
 * hold no vendor billing-API credential, and that is also why there is no
 * scheduled re-import job — see the ADR. It reads a body an admin posted and
 * writes rows.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  and,
  auditLog,
  complianceProfiles,
  costImportBatches,
  costReconciliationRuns,
  desc,
  eq,
  gte,
  importedCostLines,
  inArray,
  initiatives,
  isNotNull,
  isNull,
  lt,
  projects,
  sql,
  usageEvents,
  users,
  vendorAccountAliases,
  vendorDomainRules,
  type Db,
} from "@regulait/db";
import {
  ANY_VENDOR,
  COST_IMPORT_MAX_BYTES,
  CostImportFormatError,
  IMPORTED_BASIS_STATEMENT,
  consolidate,
  costImportRequestSchema,
  describeCostImportAdapters,
  detectPII,
  evaluateGuardrails,
  getCostImportAdapter,
  normalizeAccountKey,
  parseRosterExport,
  renderConsolidatedCsv,
  resolveVendorAccount,
  rosterIngestRequestSchema,
  vendorAliasRequestSchema,
  vendorDomainRuleRequestSchema,
  type AccountResolution,
  type CostImportAdapterInput,
  type GuardrailMode,
  type ImportedInput,
  type MeteredInput,
  type ParsedCostLine,
  type RosterEntry,
  type RosterRowRefusal,
  type VendorAliasRow,
  type VendorDomainRuleRow,
} from "@regulait/shared";
import { effectiveIngestMode } from "./regulait-llm.js";
import { resolveGuardrailPolicy } from "./guardrails.js";
import {
  loadOrgSettings,
  orgDefaultPiiMode,
  piiInternationalCategories,
} from "./org-settings.js";
import { reinstateLinesSupersededBy } from "./cost-reconcile.js";
import { securityHeaders } from "./security-headers.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** stable rule ids — the strings an operator greps the audit log for */
export const COST_IMPORT_RULE_IDS = {
  importPlanned: "cost-import-planned",
  importApplied: "cost-import-applied",
  importRejected: "cost-import-rejected",
  importTooLarge: "cost-import-too-large",
  importDuplicate: "cost-import-duplicate-refused",
  importPiiBlocked: "cost-import-pii-blocked",
  importRevoked: "cost-import-revoked",
  aliasCreated: "cost-import-alias-created",
  aliasDeleted: "cost-import-alias-deleted",
  domainRuleCreated: "cost-import-domain-rule-created",
  domainRuleDeleted: "cost-import-domain-rule-deleted",
  costCenterSet: "cost-import-user-cost-center-set",
  consolidatedRead: "cost-import-consolidated-read",
  rosterPlanned: "cost-import-roster-planned",
  rosterApplied: "cost-import-roster-applied",
  rosterRefused: "cost-import-roster-refused",
} as const;

/** the exemption, in one place so the code, the response and the ADR cannot
 * drift apart */
export const COST_IMPORT_PII_POSTURE =
  "The vendor ACCOUNT column is exempt from the PII gate by construction: the email address IS the identity join " +
  "key, and blocking it would make cross-vendor consolidation impossible rather than safe. It is stored as given, " +
  "so a disputed chargeback can be traced to the exact string the vendor's export carried. Every OTHER retained " +
  "free-text field (service, description, cost centre) is scanned through the same ADR-0042 detectors and §8.4 " +
  "counts-only reporting as the dispatch and training-ingest paths, at a mode composed MAX with the org/compliance " +
  "floor. Unmapped columns are discarded before storage rather than retained.";

/** ADR-0076: the same posture, restated for a roster ingest */
export const ROSTER_PII_POSTURE =
  "A roster IS personal data, and its ACCOUNT and EMAIL columns are identity JOIN KEYS — exempt from the PII gate " +
  "by the same construction COST_IMPORT_PII_POSTURE discloses for the vendor account column: blocking the join key " +
  "would make per-user attribution impossible rather than safe. The ONLY other field a roster retains is the cost " +
  "centre, which is scanned through the same ADR-0042 detectors at a mode composed MAX with the org/compliance " +
  "floor, counts only. Every unmapped column a SCIM export drags along (display names, titles, phone numbers, " +
  "manager chains) is discarded at parse and never reaches storage.";

// ---------------------------------------------------------------------------
// The org-wide PII floor.
//
// An import is not project-scoped — a Copilot invoice belongs to people, not to
// a project — so `projectPiiMode` has nothing to key off. This mirrors what
// `retentionFloor` in org-settings.ts does for `audit_log`, which has the same
// problem for the same reason: take the STRICTEST setting anywhere in the
// deployment. Composing downward would let an unclassified corner of the org
// become the ingest posture for the whole company's invoices.
// ---------------------------------------------------------------------------
export async function orgPiiFloor(db: Db): Promise<GuardrailMode | null> {
  const STRICTNESS: Record<string, number> = { off: 0, log: 1, warn: 2, block: 3 };
  const [profiles, org] = await Promise.all([
    db.select({ piiMode: complianceProfiles.piiMode }).from(complianceProfiles),
    loadOrgSettings(db),
  ]);
  const candidates: GuardrailMode[] = profiles.map((p) => p.piiMode as GuardrailMode);
  const orgMode = orgDefaultPiiMode(org);
  if (orgMode) candidates.push(orgMode);
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (STRICTNESS[b]! > STRICTNESS[a]! ? b : a));
}

interface ScanResult {
  verdict: "clean" | "flagged" | "blocked";
  mode: GuardrailMode;
  findings: { pii: Array<{ category: string; count: number }>; guardrails: Array<{ detector: string; category: string; count: number }> };
  summary: string;
}

/**
 * The ingest scan over arbitrary NON-IDENTITY free text. `scanCostLines`
 * (imports) and the roster ingest both end here, so the two surfaces can
 * never drift apart on posture.
 */
export async function scanFreeTexts(
  db: Db,
  texts: readonly string[],
  requested: GuardrailMode | undefined,
): Promise<ScanResult> {
  const policy = await resolveGuardrailPolicy(db, { projectId: null });
  const floor = await orgPiiFloor(db);
  const mode = effectiveIngestMode(requested, floor);
  // ADR-0117: an imported cost line or roster row is free text that the org
  // has asked to be scanned for PII; it gets the same jurisdiction set a
  // prompt gets, or an identifier could be ingested here that would have been
  // refused on the prompt path.
  const piiIntl = await piiInternationalCategories(db);

  const piiCounts = new Map<string, number>();
  const guardCounts = new Map<string, { detector: string; category: string; count: number }>();
  let hasPii = false;
  let guardrailBlocked = false;

  for (const text of texts) {
    if (text.length === 0) continue;
    for (const hit of detectPII(text, piiIntl)) {
      hasPii = true;
      piiCounts.set(hit.category, (piiCounts.get(hit.category) ?? 0) + hit.count);
    }
    const evaluation = evaluateGuardrails({
      phase: "input",
      text,
      modes: policy.modes,
      terms: {},
      exclude: ["pii"],
    });
    if (evaluation.action === "block") guardrailBlocked = true;
    for (const finding of evaluation.findings) {
      for (const hit of finding.hits) {
        const key = `${finding.detector}:${hit.category}`;
        const prev = guardCounts.get(key);
        guardCounts.set(key, { detector: finding.detector, category: hit.category, count: (prev?.count ?? 0) + hit.count });
      }
    }
  }

  const findings = {
    pii: [...piiCounts.entries()].map(([category, count]) => ({ category, count })),
    guardrails: [...guardCounts.values()],
  };
  if (!hasPii && findings.guardrails.length === 0) {
    return { verdict: "clean", mode, findings, summary: "no PII or guardrail findings outside the identity column" };
  }
  const piiSummary = findings.pii.map((f) => `${f.category}×${f.count}`).join(", ");
  const guardSummary = findings.guardrails.map((f) => `${f.detector}/${f.category}×${f.count}`).join(", ");
  const summary = [piiSummary && `PII: ${piiSummary}`, guardSummary && `content: ${guardSummary}`].filter(Boolean).join("; ");
  const blocked = (hasPii && mode === "block") || guardrailBlocked;
  return { verdict: blocked ? "blocked" : "flagged", mode, findings, summary };
}

/**
 * The ingest scan for a cost import. Runs over the NON-IDENTITY free text only
 * — see `COST_IMPORT_PII_POSTURE` above for why the account column is exempt
 * and why that exemption is disclosed rather than hidden.
 */
export async function scanCostLines(
  db: Db,
  lines: readonly ParsedCostLine[],
  requested: GuardrailMode | undefined,
): Promise<ScanResult> {
  return scanFreeTexts(
    db,
    // DELIBERATELY NOT `accountRef`. See COST_IMPORT_PII_POSTURE.
    lines.map((line) => [line.service, line.description, line.costCenter, line.unit].filter(Boolean).join("\n")),
    requested,
  );
}

// ---------------------------------------------------------------------------
// Identity resolution context, loaded once per import / re-resolution pass
// ---------------------------------------------------------------------------

interface ResolutionContext {
  userIdByEmail: Map<string, string>;
  aliases: VendorAliasRow[];
  domainRules: VendorDomainRuleRow[];
}

async function loadResolutionContext(db: Db): Promise<ResolutionContext> {
  const [userRows, aliasRows, ruleRows] = await Promise.all([
    db.select({ id: users.id, email: users.email }).from(users),
    db.select().from(vendorAccountAliases),
    db.select().from(vendorDomainRules),
  ]);
  return {
    userIdByEmail: new Map(userRows.map((u) => [u.email.trim().toLowerCase(), u.id])),
    aliases: aliasRows.map((a) => ({ id: a.id, vendor: a.vendor, accountKey: a.accountKey, userId: a.userId })),
    domainRules: ruleRows.map((r) => ({
      id: r.id,
      vendor: r.vendor,
      fromDomain: r.fromDomain,
      toDomain: r.toDomain,
      enabled: r.enabled,
    })),
  };
}

const periodQuerySchema = z
  .object({
    from: z.string().min(4).max(40).optional(),
    to: z.string().min(4).max(40).optional(),
    by: z.enum(["user", "cost_center"]).default("user"),
    format: z.enum(["json", "csv"]).optional(),
  })
  .strict();

function resolveWindow(q: { from?: string; to?: string }): { start: Date; end: Date } {
  const end = q.to ? new Date(q.to) : new Date();
  const start = q.from ? new Date(q.from) : new Date(end.getTime() - 30 * 24 * 3600 * 1000);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    throw new CostImportFormatError("`from` must be a valid instant strictly before `to`", { adapter: "consolidated" });
  }
  return { start, end };
}

export function registerCostImportRoutes(app: FastifyInstance, db: Db): void {
  const audit = (
    actorUserId: string | null,
    objectType: "cost_import_batch" | "vendor_account_alias" | "vendor_domain_rule" | "user",
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
      detail: { subsystem: "cross-vendor-cost", ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });

  // =======================================================================
  // THE REGISTRY — a new vendor is a new adapter, not a new code path
  // =======================================================================

  app.get("/v1/cost-imports/adapters", async () => ({
    adapters: describeCostImportAdapters(),
    basisStatement: IMPORTED_BASIS_STATEMENT,
    piiPosture: COST_IMPORT_PII_POSTURE,
    posture:
      "Every adapter here parses a file. NONE of them calls a vendor API: RegulAIt holds no billing-API credential " +
      "for any vendor, so there is nothing to poll and no scheduled re-import. An import is an operator act with a " +
      "file attached, and the consolidated view reports how stale each vendor's data is.",
  }));

  // =======================================================================
  // THE IMPORT — the untrusted path
  // =======================================================================

  // ADR-0167 (SEC-03): see the same note on /v1/shadow-ai/imports — the raw
  // limit must admit the advertised bound or the honest 413 below is
  // unreachable and the caller gets a 500 instead.
  app.post("/v1/cost-imports", { bodyLimit: COST_IMPORT_MAX_BYTES + 64 * 1024 }, async (req, reply) => {
    const raw = req.body;
    const rawJson = JSON.stringify(raw ?? null);

    // WALL 0 — SIZE, on the bytes, before anything is walked or parsed.
    if (rawJson.length > COST_IMPORT_MAX_BYTES) {
      await audit(req.authCtx.userId, "cost_import_batch", null, COST_IMPORT_RULE_IDS.importTooLarge, "deny",
        `cost export of ${rawJson.length} bytes exceeds the ${COST_IMPORT_MAX_BYTES}-byte import bound — chunk the export`,
        { bytes: rawJson.length, limit: COST_IMPORT_MAX_BYTES });
      return reply.status(413).send({
        error: "cost_export_too_large",
        detail: `cost exports are bounded at ${COST_IMPORT_MAX_BYTES} bytes; split the file into chunks`,
      });
    }

    const parsedReq = costImportRequestSchema.safeParse(raw);
    if (!parsedReq.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsedReq.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const body = parsedReq.data;
    const fingerprint = sha256(body.content);

    const adapter = getCostImportAdapter(body.adapter);
    if (!adapter) {
      return reply.status(400).send({
        error: "unknown_adapter",
        detail: `no cost-import adapter named '${body.adapter}'`,
        available: describeCostImportAdapters().map((a) => a.id),
      });
    }
    if (!adapter.formats.includes(body.format)) {
      return reply.status(400).send({
        error: "unsupported_format",
        detail: `adapter '${adapter.id}' does not read ${body.format}; it reads ${adapter.formats.join(", ")}`,
      });
    }

    const recordRefusal = async (ruleId: string, reason: string, summary: Record<string, unknown>) => {
      const [row] = await db
        .insert(costImportBatches)
        .values({
          adapter: adapter.id,
          vendor: adapter.vendor,
          format: body.format,
          mode: body.mode,
          status: "refused",
          source: body.source ?? null,
          payloadSha256: fingerprint,
          rowsParsed: 0,
          rowsAccepted: 0,
          rowsRefused: 0,
          refusals: [],
          summary,
          ruleId,
          reason,
          requestedByUserId: req.authCtx.userId ?? null,
        })
        .returning();
      await audit(req.authCtx.userId, "cost_import_batch", row!.id, ruleId, "deny", reason, {
        adapter: adapter.id,
        payloadSha256: fingerprint,
        ...summary,
      });
      return row!;
    };

    // WALL 1 — THE DOUBLE-COUNT GUARD. Checked before parsing so re-uploading a
    // 20k-row file costs nothing, and enforced by a partial unique index below
    // so a race cannot slip past this read.
    if (body.mode === "apply") {
      const [dup] = await db
        .select({ id: costImportBatches.id, createdAt: costImportBatches.createdAt })
        .from(costImportBatches)
        .where(and(eq(costImportBatches.payloadSha256, fingerprint), eq(costImportBatches.status, "applied")));
      if (dup) {
        const reason =
          `these exact bytes were already applied as batch ${dup.id} on ${dup.createdAt.toISOString()}. ` +
          `Applying them again would double every figure they contributed to. Revoke that batch first ` +
          `(DELETE /v1/cost-imports/${dup.id}) if you are re-importing a correction.`;
        const row = await recordRefusal(COST_IMPORT_RULE_IDS.importDuplicate, reason, { duplicateOf: dup.id });
        return reply.status(409).send({ error: "duplicate_import", importId: row.id, duplicateOf: dup.id, detail: reason });
      }
    }

    // WALL 2 — THE ADAPTER. A whole-file failure ("this is not that vendor's
    // export") is distinguished from per-row failures so an operator is told
    // which mistake they made.
    const input: CostImportAdapterInput = { content: body.content, format: body.format, config: body.config };
    let parsed;
    try {
      parsed = adapter.parse(input);
    } catch (e) {
      if (e instanceof CostImportFormatError) {
        const row = await recordRefusal(COST_IMPORT_RULE_IDS.importRejected, e.message, {
          adapterError: e.code,
          ...e.detail,
        });
        return reply.status(422).send({ error: e.code, importId: row.id, detail: e.message, ...e.detail });
      }
      if (e instanceof z.ZodError) {
        const detail = `adapter '${adapter.id}' rejected its configuration: ${e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
        const row = await recordRefusal(COST_IMPORT_RULE_IDS.importRejected, detail, { adapterError: "invalid_config" });
        return reply.status(422).send({
          error: "invalid_adapter_config",
          importId: row.id,
          detail,
          issues: e.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      throw e;
    }

    // WALL 3 — THE ADR-0042 INGEST SCAN over the NON-IDENTITY free text.
    const scan = await scanCostLines(db, parsed.lines, body.piiMode);
    if (scan.verdict === "blocked") {
      const reason =
        `cost import refused: the non-identity free-text columns carry content the ingest gate blocks at mode ` +
        `'${scan.mode}' (${scan.summary}). Counts only are recorded — no matched text is stored. Re-import with ` +
        `those columns unmapped, or lower the composed ingest mode where policy allows.`;
      const [row] = await db
        .insert(costImportBatches)
        .values({
          adapter: adapter.id,
          vendor: adapter.vendor,
          format: body.format,
          mode: body.mode,
          status: "refused",
          source: body.source ?? null,
          payloadSha256: fingerprint,
          rowsParsed: 0,
          rowsAccepted: 0,
          rowsRefused: 0,
          refusals: [],
          summary: { blockedBy: "ingest-scan" },
          piiMode: scan.mode,
          scanVerdict: scan.verdict,
          scanFindings: scan.findings,
          ruleId: COST_IMPORT_RULE_IDS.importPiiBlocked,
          reason,
          requestedByUserId: req.authCtx.userId ?? null,
        })
        .returning();
      await audit(req.authCtx.userId, "cost_import_batch", row!.id, COST_IMPORT_RULE_IDS.importPiiBlocked, "deny", reason, {
        adapter: adapter.id,
        mode: scan.mode,
        findings: scan.findings,
      });
      return reply.status(422).send({
        error: "ingest_blocked",
        importId: row!.id,
        detail: reason,
        piiMode: scan.mode,
        findings: scan.findings,
        piiPosture: COST_IMPORT_PII_POSTURE,
      });
    }

    // WALL 4 — IDENTITY RESOLUTION. Pure, against rows an admin authored.
    const ctx = await loadResolutionContext(db);
    const resolved = parsed.lines.map((line) => ({
      line,
      resolution: resolveVendorAccount(line.accountRef, line.vendor, ctx),
    }));

    const currencies = [...new Set(parsed.lines.map((l) => l.currency))];
    const totalUsd =
      currencies.length === 1 && currencies[0] === "USD"
        ? Math.round(parsed.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100
        : null;
    const periodStart = parsed.lines.reduce<Date | null>((acc, l) => {
      const d = new Date(l.periodStart);
      return acc === null || d < acc ? d : acc;
    }, null);
    const periodEnd = parsed.lines.reduce<Date | null>((acc, l) => {
      const d = new Date(l.periodEnd);
      return acc === null || d > acc ? d : acc;
    }, null);

    const byMethod = { exact_email: 0, admin_alias: 0, domain_rule: 0, unresolved: 0 };
    for (const r of resolved) byMethod[r.resolution.method] += 1;
    const unattributedAmount =
      Math.round(
        resolved.filter((r) => r.resolution.userId === null).reduce((s, r) => s + r.line.amount, 0) * 100,
      ) / 100;

    const summary = {
      adapter: adapter.id,
      columnsUsed: parsed.columnsUsed,
      currencies,
      resolutionByMethod: byMethod,
      unattributedLines: byMethod.unresolved,
      unattributedAmount,
      vendors: [...new Set(parsed.lines.map((l) => l.vendor))],
      basis: "imported" as const,
    };

    const reason =
      `${body.mode === "apply" ? "applied" : "dry run"}: ${parsed.lines.length} of ${parsed.rowsParsed} row(s) accepted, ` +
      `${parsed.refusals.length} refused; ${byMethod.unresolved} accepted line(s) resolved to no RegulAIt user ` +
      `(${unattributedAmount} unattributed)`;

    const [batch] = await db
      .insert(costImportBatches)
      .values({
        adapter: adapter.id,
        vendor: summary.vendors[0] ?? adapter.vendor,
        format: body.format,
        mode: body.mode,
        status: body.mode === "apply" ? "applied" : "planned",
        source: body.source ?? null,
        payloadSha256: fingerprint,
        rowsParsed: parsed.rowsParsed,
        rowsAccepted: parsed.lines.length,
        rowsRefused: parsed.refusals.length,
        periodStart,
        periodEnd,
        totalUsd,
        refusals: parsed.refusals as unknown as Array<Record<string, unknown>>,
        summary,
        piiMode: scan.mode,
        scanVerdict: scan.verdict,
        scanFindings: scan.findings,
        ruleId: body.mode === "apply" ? COST_IMPORT_RULE_IDS.importApplied : COST_IMPORT_RULE_IDS.importPlanned,
        reason,
        requestedByUserId: req.authCtx.userId ?? null,
        appliedAt: body.mode === "apply" ? new Date() : null,
      })
      .returning();

    if (body.mode === "apply" && resolved.length > 0) {
      const CHUNK = 500;
      const values = resolved.map(({ line, resolution }) => ({
        batchId: batch!.id,
        basis: "imported" as const,
        vendor: line.vendor,
        adapter: adapter.id,
        sourceRow: line.sourceRow,
        accountRef: line.accountRef,
        accountKey: normalizeAccountKey(line.accountRef),
        resolvedUserId: resolution.userId,
        resolutionMethod: resolution.method,
        resolutionDetail: resolution.detail,
        resolutionMappingId: resolution.mappingId,
        resolutionDomainRuleId: resolution.domainRuleId,
        costCenter: line.costCenter,
        periodStart: new Date(line.periodStart),
        periodEnd: new Date(line.periodEnd),
        amount: line.amount,
        currency: line.currency,
        billingKind: line.billingKind,
        service: line.service,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        detail: line.detail,
      }));
      for (let i = 0; i < values.length; i += CHUNK) {
        await db.insert(importedCostLines).values(values.slice(i, i + CHUNK));
      }
    }

    await audit(req.authCtx.userId, "cost_import_batch", batch!.id,
      body.mode === "apply" ? COST_IMPORT_RULE_IDS.importApplied : COST_IMPORT_RULE_IDS.importPlanned,
      "allow", reason, { payloadSha256: fingerprint, ...summary,
        rowsParsed: parsed.rowsParsed, rowsAccepted: parsed.lines.length, rowsRefused: parsed.refusals.length });

    return reply.status(body.mode === "apply" ? 201 : 200).send({
      importId: batch!.id,
      mode: body.mode,
      basis: "imported",
      adapter: adapter.id,
      adapterLimits: adapter.limits,
      rowsParsed: parsed.rowsParsed,
      rowsAccepted: parsed.lines.length,
      rowsRefused: parsed.refusals.length,
      refusals: parsed.refusals.slice(0, 200),
      refusalsTruncated: parsed.refusals.length > 200,
      currencies,
      totalUsd,
      totalUsdNote:
        totalUsd === null
          ? "no single total is given: this file carries more than one currency and RegulAIt performs no FX conversion"
          : null,
      periodStart: periodStart?.toISOString() ?? null,
      periodEnd: periodEnd?.toISOString() ?? null,
      resolution: {
        byMethod,
        unattributedLines: byMethod.unresolved,
        unattributedAmount,
        note:
          "an unresolved line is RETAINED and reported as unattributed spend. It is never dropped, never spread " +
          "across the people who did resolve, and never assigned to a plausible-looking match.",
      },
      ingestScan: { mode: scan.mode, verdict: scan.verdict, findings: scan.findings },
      piiPosture: COST_IMPORT_PII_POSTURE,
      basisStatement: IMPORTED_BASIS_STATEMENT,
    });
  });

  app.get("/v1/cost-imports", async () => {
    const rows = await db.select().from(costImportBatches).orderBy(desc(costImportBatches.createdAt)).limit(200);
    return { imports: rows, basisStatement: IMPORTED_BASIS_STATEMENT };
  });

  app.get("/v1/cost-imports/:importId", async (req, reply) => {
    const { importId } = z.object({ importId: z.string().uuid() }).parse(req.params);
    const [batch] = await db.select().from(costImportBatches).where(eq(costImportBatches.id, importId));
    if (!batch) return reply.status(404).send({ error: "unknown_import" });
    const lines = await db
      .select()
      .from(importedCostLines)
      .where(eq(importedCostLines.batchId, importId))
      .orderBy(importedCostLines.sourceRow)
      .limit(500);
    return { import: batch, lines, linesTruncated: lines.length === 500, basisStatement: IMPORTED_BASIS_STATEMENT };
  });

  /**
   * REVOKE a batch. The correction path: an operator who imported the wrong
   * file, or a corrected re-issue of the same period, revokes and re-imports.
   * The lines go (ON DELETE CASCADE) but the BATCH ROW STAYS, marked `revoked`
   * — "somebody imported and then withdrew July's Copilot invoice" is exactly
   * the kind of thing an auditor asks about later.
   */
  app.delete("/v1/cost-imports/:importId", async (req, reply) => {
    const { importId } = z.object({ importId: z.string().uuid() }).parse(req.params);
    const body = z.object({ reason: z.string().min(1).max(500) }).strict().parse(req.body ?? {});
    const [batch] = await db.select().from(costImportBatches).where(eq(costImportBatches.id, importId));
    if (!batch) return reply.status(404).send({ error: "unknown_import" });
    if (batch.status !== "applied") {
      return reply.status(409).send({
        error: "not_revocable",
        detail: `batch ${importId} is '${batch.status}' — only an applied batch holds lines to withdraw`,
      });
    }
    // ADR-0076: if any of this batch's lines had SUPERSEDED older duplicates,
    // those older lines come back to life BEFORE the deletion — a withdrawn
    // restatement must not silently erase the fact it restated.
    const doomedIds = (
      await db.select({ id: importedCostLines.id }).from(importedCostLines).where(eq(importedCostLines.batchId, importId))
    ).map((r) => r.id);
    const reinstated = await reinstateLinesSupersededBy(db, {
      batchId: importId,
      lineIds: doomedIds,
      actorUserId: req.authCtx.userId ?? null,
      reason: body.reason,
    });
    const removed = await db.delete(importedCostLines).where(eq(importedCostLines.batchId, importId)).returning({ id: importedCostLines.id });
    const [updated] = await db
      .update(costImportBatches)
      .set({ status: "revoked", revokedAt: new Date(), revokedByUserId: req.authCtx.userId ?? null, reason: `revoked: ${body.reason}` })
      .where(eq(costImportBatches.id, importId))
      .returning();
    await audit(req.authCtx.userId, "cost_import_batch", importId, COST_IMPORT_RULE_IDS.importRevoked, "allow",
      `withdrew ${removed.length} imported cost line(s) from batch ${importId}: ${body.reason}` +
        (reinstated > 0 ? ` — ${reinstated} older line(s) this batch had superseded were reinstated` : ""),
      { linesRemoved: removed.length, linesReinstated: reinstated, vendor: batch.vendor, adapter: batch.adapter, payloadSha256: batch.payloadSha256 });
    return { revoked: true, import: updated, linesRemoved: removed.length, linesReinstated: reinstated };
  });

  // =======================================================================
  // IDENTITY RESOLUTION — the admin-authored rules, and correcting them
  // =======================================================================

  /** re-resolve every stored line, after an alias or rule changed. Returns how
   * many rows moved, so a correction reports its own blast radius. */
  const reresolveAll = async (): Promise<{ changed: number; scanned: number }> => {
    const ctx = await loadResolutionContext(db);
    const lines = await db.select().from(importedCostLines);
    let changed = 0;
    for (const line of lines) {
      const next: AccountResolution = resolveVendorAccount(line.accountRef, line.vendor, ctx);
      if (
        next.userId === line.resolvedUserId &&
        next.method === line.resolutionMethod &&
        next.mappingId === line.resolutionMappingId &&
        next.domainRuleId === line.resolutionDomainRuleId
      ) {
        continue;
      }
      await db
        .update(importedCostLines)
        .set({
          resolvedUserId: next.userId,
          resolutionMethod: next.method,
          resolutionDetail: next.detail,
          resolutionMappingId: next.mappingId,
          resolutionDomainRuleId: next.domainRuleId,
        })
        .where(eq(importedCostLines.id, line.id));
      changed += 1;
    }
    return { changed, scanned: lines.length };
  };

  app.get("/v1/cost-imports/mappings", async () => {
    const [aliases, rules] = await Promise.all([
      db.select().from(vendorAccountAliases).orderBy(vendorAccountAliases.accountKey),
      db.select().from(vendorDomainRules).orderBy(vendorDomainRules.fromDomain),
    ]);
    return {
      aliases,
      domainRules: rules,
      posture:
        "Precedence is admin alias -> exact email -> domain rule -> unresolved. An administrator's assertion beats a " +
        "mechanical match, because otherwise a correction would not be a correction. Two domain rules that resolve " +
        "one account to two different people resolve it to NOBODY — ambiguity is never broken by guessing.",
    };
  });

  /**
   * THE ONE ALIAS WRITE PATH (ADR-0076). The single-alias admin route below
   * and the roster ingest both end HERE — a roster is two hundred of the same
   * assertion, not a second mechanism, and having exactly one writer is what
   * keeps that true by construction rather than by review.
   */
  const upsertAliasCore = async (
    actor: string | null,
    input: { vendor: string; accountRef: string; userId: string; reason: string },
  ) => {
    const [user] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, input.userId));
    if (!user) return null;
    const accountKey = normalizeAccountKey(input.accountRef);
    const values = {
      vendor: input.vendor,
      accountKey,
      userId: input.userId,
      reason: input.reason,
      createdByUserId: actor,
    };
    const [existing] = await db
      .select()
      .from(vendorAccountAliases)
      .where(and(eq(vendorAccountAliases.vendor, input.vendor), eq(vendorAccountAliases.accountKey, accountKey)));
    const [row] = existing
      ? await db.update(vendorAccountAliases).set(values).where(eq(vendorAccountAliases.id, existing.id)).returning()
      : await db.insert(vendorAccountAliases).values(values).returning();
    return { row: row!, existing: existing ?? null, user, accountKey };
  };

  /** THE ONE PERSON-LEVEL COST-CENTRE WRITE PATH (ADR-0076) — same argument. */
  const setCostCenterCore = async (userId: string, costCenter: string | null) => {
    const [user] = await db
      .select({ id: users.id, email: users.email, costCenter: users.costCenter })
      .from(users)
      .where(eq(users.id, userId));
    if (!user) return null;
    const [updated] = await db.update(users).set({ costCenter }).where(eq(users.id, userId)).returning({
      id: users.id,
      email: users.email,
      costCenter: users.costCenter,
    });
    return { before: user, after: updated! };
  };

  app.post("/v1/cost-imports/mappings", async (req, reply) => {
    const body = vendorAliasRequestSchema.parse(req.body);
    const upserted = await upsertAliasCore(req.authCtx.userId ?? null, body);
    if (!upserted) return reply.status(400).send({ error: "invalid_reference", detail: "userId names no user" });
    const { row, existing, user, accountKey } = upserted;

    const impact = await reresolveAll();
    await audit(req.authCtx.userId, "vendor_account_alias", row.id, COST_IMPORT_RULE_IDS.aliasCreated, "allow",
      `${existing ? "changed" : "asserted"} that vendor account '${body.accountRef}' (vendor '${body.vendor}') is ${user.email}: ${body.reason}` +
        ` — ${impact.changed} stored line(s) re-attributed`,
      { accountKey, vendor: body.vendor, userId: body.userId, userEmail: user.email, ...impact, previousUserId: existing?.userId ?? null });
    return reply.status(existing ? 200 : 201).send({ alias: row, reresolved: impact });
  });

  app.delete("/v1/cost-imports/mappings/:aliasId", async (req, reply) => {
    const { aliasId } = z.object({ aliasId: z.string().uuid() }).parse(req.params);
    const [row] = await db.delete(vendorAccountAliases).where(eq(vendorAccountAliases.id, aliasId)).returning();
    if (!row) return reply.status(404).send({ error: "unknown_alias" });
    const impact = await reresolveAll();
    await audit(req.authCtx.userId, "vendor_account_alias", aliasId, COST_IMPORT_RULE_IDS.aliasDeleted, "allow",
      `removed the alias mapping '${row.accountKey}' (vendor '${row.vendor}') — ${impact.changed} stored line(s) re-attributed`,
      { accountKey: row.accountKey, vendor: row.vendor, userId: row.userId, ...impact });
    return { deleted: true, id: aliasId, reresolved: impact };
  });

  app.post("/v1/cost-imports/domain-rules", async (req, reply) => {
    const body = vendorDomainRuleRequestSchema.parse(req.body);
    const values = {
      vendor: body.vendor,
      fromDomain: body.fromDomain.trim().toLowerCase(),
      toDomain: body.toDomain.trim().toLowerCase(),
      enabled: body.enabled,
      reason: body.reason,
      createdByUserId: req.authCtx.userId ?? null,
    };
    const [existing] = await db
      .select()
      .from(vendorDomainRules)
      .where(
        and(
          eq(vendorDomainRules.vendor, values.vendor),
          eq(vendorDomainRules.fromDomain, values.fromDomain),
          eq(vendorDomainRules.toDomain, values.toDomain),
        ),
      );
    const [row] = existing
      ? await db.update(vendorDomainRules).set(values).where(eq(vendorDomainRules.id, existing.id)).returning()
      : await db.insert(vendorDomainRules).values(values).returning();
    const impact = await reresolveAll();
    await audit(req.authCtx.userId, "vendor_domain_rule", row!.id, COST_IMPORT_RULE_IDS.domainRuleCreated, "allow",
      `vendor accounts at '${values.fromDomain}' now resolve against '${values.toDomain}' (vendor '${values.vendor}'): ${body.reason}` +
        ` — ${impact.changed} stored line(s) re-attributed`,
      { ...values, ...impact });
    return reply.status(existing ? 200 : 201).send({ domainRule: row, reresolved: impact });
  });

  app.delete("/v1/cost-imports/domain-rules/:ruleId", async (req, reply) => {
    const { ruleId } = z.object({ ruleId: z.string().uuid() }).parse(req.params);
    const [row] = await db.delete(vendorDomainRules).where(eq(vendorDomainRules.id, ruleId)).returning();
    if (!row) return reply.status(404).send({ error: "unknown_domain_rule" });
    const impact = await reresolveAll();
    await audit(req.authCtx.userId, "vendor_domain_rule", ruleId, COST_IMPORT_RULE_IDS.domainRuleDeleted, "allow",
      `removed the domain rule '${row.fromDomain}' -> '${row.toDomain}' — ${impact.changed} stored line(s) re-attributed`,
      { fromDomain: row.fromDomain, toDomain: row.toDomain, vendor: row.vendor, ...impact });
    return { deleted: true, id: ruleId, reresolved: impact };
  });

  /** the PERSON-level chargeback key. `projects.cost_center` covers governed
   * work; a Copilot seat is not a project, so a human needs one too. */
  app.put("/v1/users/:userId/cost-center", async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const body = z.object({ costCenter: z.string().min(1).max(120).nullable() }).strict().parse(req.body);
    const result = await setCostCenterCore(userId, body.costCenter);
    if (!result) return reply.status(404).send({ error: "unknown_user" });
    await audit(req.authCtx.userId, "user", userId, COST_IMPORT_RULE_IDS.costCenterSet, "allow",
      `cost centre for ${result.before.email} changed from '${result.before.costCenter ?? "(none)"}' to '${body.costCenter ?? "(none)"}'`,
      { from: result.before.costCenter, to: body.costCenter });
    return result.after;
  });

  // =======================================================================
  // ADR-0076 — THE ROSTER INGEST. Bulk-assert the mappings the wedge needs,
  // through the SAME write paths the single-row routes use.
  // =======================================================================

  /**
   * POST /v1/cost-imports/roster — consume a SCIM-style user export (JSON) or
   * a CSV roster and turn it into vendor-account aliases + person-level cost
   * centres, via `upsertAliasCore` / `setCostCenterCore` — the exact functions
   * the single-row admin routes call. Never a parallel path.
   *
   * THE REFUSAL RULE: a vendor account that two roster rows map to two
   * DIFFERENT people is refused LOUDLY — every involved row, both emails, no
   * alias written — rather than resolved by order, recency or plausibility.
   * Same for one person given two different cost centres. An email that names
   * no RegulAIt user is refused per-row; a roster never invents a person.
   */
  app.post("/v1/cost-imports/roster", { bodyLimit: COST_IMPORT_MAX_BYTES + 64 * 1024 }, async (req, reply) => {
    const raw = req.body;
    const rawJson = JSON.stringify(raw ?? null);
    if (rawJson.length > COST_IMPORT_MAX_BYTES) {
      await audit(req.authCtx.userId, "user", null, COST_IMPORT_RULE_IDS.rosterRefused, "deny",
        `roster of ${rawJson.length} bytes exceeds the ${COST_IMPORT_MAX_BYTES}-byte bound — chunk the export`,
        { bytes: rawJson.length, limit: COST_IMPORT_MAX_BYTES });
      return reply.status(413).send({
        error: "roster_too_large",
        detail: `rosters are bounded at ${COST_IMPORT_MAX_BYTES} bytes; split the file into chunks`,
      });
    }
    const parsedReq = rosterIngestRequestSchema.safeParse(raw);
    if (!parsedReq.success) {
      return reply.status(400).send({
        error: "invalid_request",
        issues: parsedReq.error.issues.slice(0, 10).map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    const body = parsedReq.data;

    let parsed;
    try {
      parsed = parseRosterExport({ content: body.content, format: body.format, mapping: body.mapping });
    } catch (e) {
      if (e instanceof CostImportFormatError) {
        await audit(req.authCtx.userId, "user", null, COST_IMPORT_RULE_IDS.rosterRefused, "deny",
          `roster refused whole-file: ${e.message}`, { source: body.source ?? null });
        return reply.status(422).send({ error: e.code, detail: e.message });
      }
      throw e;
    }

    // THE ADR-0042 SCAN, over the ONLY non-identity text a roster retains.
    // Account and email columns are join keys — see ROSTER_PII_POSTURE.
    const scan = await scanFreeTexts(
      db,
      parsed.entries.map((e) => e.costCenter).filter((c): c is string => Boolean(c)),
      body.piiMode,
    );
    if (scan.verdict === "blocked") {
      const reason =
        `roster refused: the cost-centre column carries content the ingest gate blocks at mode '${scan.mode}' ` +
        `(${scan.summary}). Counts only are recorded — no matched text is stored.`;
      await audit(req.authCtx.userId, "user", null, COST_IMPORT_RULE_IDS.rosterRefused, "deny", reason, {
        mode: scan.mode,
        findings: scan.findings,
        source: body.source ?? null,
      });
      return reply.status(422).send({
        error: "ingest_blocked",
        detail: reason,
        piiMode: scan.mode,
        findings: scan.findings,
        piiPosture: ROSTER_PII_POSTURE,
      });
    }

    // ---- resolution + the ambiguity walls ---------------------------------
    const ctx = await loadResolutionContext(db);
    const refusals: RosterRowRefusal[] = [...parsed.refusals];
    const resolvedRows: Array<{ entry: RosterEntry; vendor: string; accountKey: string; userId: string; userEmail: string }> = [];
    for (const entry of parsed.entries) {
      const vendor = entry.vendor ?? body.vendor;
      const accountKey = normalizeAccountKey(entry.accountRef);
      const targetEmail = (entry.userEmail ?? entry.accountRef).trim().toLowerCase();
      const userId = ctx.userIdByEmail.get(targetEmail);
      if (!userId) {
        refusals.push({
          row: entry.sourceRow,
          field: entry.userEmail ? "user" : "account",
          reason:
            `'${targetEmail}' names no RegulAIt user — a roster never invents a person. Create the user first, ` +
            `or correct the row.`,
        });
        continue;
      }
      resolvedRows.push({ entry, vendor, accountKey, userId, userEmail: targetEmail });
    }

    // WALL: one vendor account mapped to TWO different people. Refused loudly,
    // every involved row, nothing written for that account.
    const byAccount = new Map<string, typeof resolvedRows>();
    for (const r of resolvedRows) {
      const k = `${r.vendor}\u0000${r.accountKey}`;
      const arr = byAccount.get(k) ?? [];
      arr.push(r);
      byAccount.set(k, arr);
    }
    const survivors: typeof resolvedRows = [];
    for (const rows of byAccount.values()) {
      const distinctUsers = [...new Set(rows.map((r) => r.userId))];
      if (distinctUsers.length > 1) {
        const named = rows.map((r) => `row ${r.entry.sourceRow} -> ${r.userEmail}`).join("; ");
        for (const r of rows) {
          refusals.push({
            row: r.entry.sourceRow,
            field: "account",
            reason:
              `AMBIGUOUS: vendor account '${r.entry.accountRef}' (vendor '${r.vendor}') is mapped to ` +
              `${distinctUsers.length} different people in this roster (${named}). Nothing was written for this ` +
              `account — ambiguity is refused, never resolved by guessing. Fix the roster or assert a single ` +
              `alias explicitly.`,
          });
        }
        continue;
      }
      survivors.push(...rows);
    }

    // WALL: one person given two DIFFERENT cost centres. Same refusal posture.
    const ccByUser = new Map<string, Map<string, number[]>>();
    for (const r of survivors) {
      if (!r.entry.costCenter) continue;
      const m = ccByUser.get(r.userId) ?? new Map<string, number[]>();
      const arr = m.get(r.entry.costCenter) ?? [];
      arr.push(r.entry.sourceRow);
      m.set(r.entry.costCenter, arr);
      ccByUser.set(r.userId, m);
    }
    const ccConflictUsers = new Set<string>();
    for (const [userId, m] of ccByUser.entries()) {
      if (m.size > 1) {
        ccConflictUsers.add(userId);
        const named = [...m.entries()].map(([cc, rowsN]) => `'${cc}' (row ${rowsN.join(", ")})`).join(" vs ");
        for (const rowsN of m.values()) {
          for (const rowN of rowsN) {
            refusals.push({
              row: rowN,
              field: "costCenter",
              reason:
                `AMBIGUOUS: this roster assigns the same person ${named}. No cost centre was written for them — ` +
                `ambiguity is refused, never resolved by guessing.`,
            });
          }
        }
      }
    }
    const accepted = survivors.filter((r) => !(r.entry.costCenter && ccConflictUsers.has(r.userId)));

    // ---- the plan, per unique assertion -----------------------------------
    const aliasByKey = new Map(ctx.aliases.map((a) => [`${a.vendor}\u0000${a.accountKey}`, a]));
    const userById = new Map<string, { email: string }>();
    for (const [email, id] of ctx.userIdByEmail.entries()) userById.set(id, { email });

    interface PlannedAction {
      row: number;
      accountRef: string;
      vendor: string;
      userEmail: string;
      aliasAction: "create" | "update" | "unchanged" | "unnecessary";
      costCenter: string | null;
      costCenterAction: "set" | "unchanged" | "none";
    }
    const seenAccount = new Set<string>();
    const seenCcUser = new Set<string>();
    let duplicateRows = 0;
    const actions: PlannedAction[] = [];
    const currentCcByUserId = new Map(
      (await db.select({ id: users.id, costCenter: users.costCenter }).from(users)).map((u) => [u.id, u.costCenter]),
    );
    for (const r of accepted) {
      const key = `${r.vendor}\u0000${r.accountKey}`;
      const isDupAccount = seenAccount.has(key);
      if (isDupAccount && (!r.entry.costCenter || seenCcUser.has(r.userId))) {
        duplicateRows += 1;
        continue;
      }
      seenAccount.add(key);
      let aliasAction: PlannedAction["aliasAction"];
      const targetUserEmail = userById.get(r.userId)!.email.trim().toLowerCase();
      if (r.accountKey === targetUserEmail) {
        // the account IS the directory address — exact-email resolution
        // already attributes it, and minting an alias would only add noise
        aliasAction = "unnecessary";
      } else {
        const existing = aliasByKey.get(key);
        aliasAction = !existing ? "create" : existing.userId === r.userId ? "unchanged" : "update";
      }
      let costCenterAction: PlannedAction["costCenterAction"] = "none";
      if (r.entry.costCenter && !seenCcUser.has(r.userId)) {
        seenCcUser.add(r.userId);
        costCenterAction = (currentCcByUserId.get(r.userId) ?? null) === r.entry.costCenter ? "unchanged" : "set";
      }
      actions.push({
        row: r.entry.sourceRow,
        accountRef: r.entry.accountRef,
        vendor: r.vendor,
        userEmail: r.userEmail,
        aliasAction,
        costCenter: r.entry.costCenter,
        costCenterAction,
      });
    }

    const counts = {
      aliasesToCreate: actions.filter((a) => a.aliasAction === "create").length,
      aliasesToUpdate: actions.filter((a) => a.aliasAction === "update").length,
      aliasesUnchanged: actions.filter((a) => a.aliasAction === "unchanged").length,
      aliasesUnnecessary: actions.filter((a) => a.aliasAction === "unnecessary").length,
      costCentersToSet: actions.filter((a) => a.costCenterAction === "set").length,
      costCentersUnchanged: actions.filter((a) => a.costCenterAction === "unchanged").length,
    };
    const rowsRefused = refusals.length;
    const rowsAccepted = parsed.rowsParsed - rowsRefused;

    const base = {
      mode: body.mode,
      dialect: parsed.dialect,
      columnsUsed: parsed.columnsUsed,
      rowsParsed: parsed.rowsParsed,
      rowsAccepted,
      rowsRefused,
      duplicateRows,
      refusals: refusals.slice(0, 200),
      refusalsTruncated: refusals.length > 200,
      counts,
      actions: actions.slice(0, 200),
      actionsTruncated: actions.length > 200,
      ingestScan: { mode: scan.mode, verdict: scan.verdict, findings: scan.findings },
      piiPosture: ROSTER_PII_POSTURE,
      posture:
        "A roster row is the same assertion the single-alias route makes, made in bulk through the same write " +
        "path. An account mapped to two people, or a person given two cost centres, is refused LOUDLY with every " +
        "involved row named — never resolved by order, recency or plausibility. An 'unnecessary' alias means the " +
        "account already IS the person's directory address and exact-email resolution covers it.",
    };

    if (body.mode === "dry_run") {
      await audit(req.authCtx.userId, "user", null, COST_IMPORT_RULE_IDS.rosterPlanned, "allow",
        `roster dry run (${parsed.dialect}): ${parsed.rowsParsed} row(s), ${rowsAccepted} accepted, ` +
          `${rowsRefused} refused; would create ${counts.aliasesToCreate} and update ${counts.aliasesToUpdate} ` +
          `alias(es), set ${counts.costCentersToSet} cost centre(s). Nothing was written.`,
        { source: body.source ?? null, vendor: body.vendor, ...counts, rowsParsed: parsed.rowsParsed, rowsRefused });
      return reply.status(200).send({ ...base, applied: false });
    }

    // ---- APPLY, through the existing write paths --------------------------
    let aliasesCreated = 0;
    let aliasesUpdated = 0;
    let costCentersSet = 0;
    for (const a of actions) {
      if (a.aliasAction === "create" || a.aliasAction === "update") {
        const userId = ctx.userIdByEmail.get(a.userEmail)!;
        const upserted = await upsertAliasCore(req.authCtx.userId ?? null, {
          vendor: a.vendor,
          accountRef: a.accountRef,
          userId,
          reason: `roster (${body.source ?? "unnamed"}): ${body.reason}`,
        });
        if (upserted) {
          if (upserted.existing) aliasesUpdated += 1;
          else aliasesCreated += 1;
          await audit(req.authCtx.userId, "vendor_account_alias", upserted.row.id, COST_IMPORT_RULE_IDS.aliasCreated, "allow",
            `${upserted.existing ? "changed" : "asserted"} via roster that vendor account '${a.accountRef}' ` +
              `(vendor '${a.vendor}') is ${upserted.user.email}: ${body.reason} — stored lines re-resolved at the ` +
              `end of the roster pass`,
            {
              accountKey: upserted.accountKey,
              vendor: a.vendor,
              userId,
              userEmail: upserted.user.email,
              origin: "roster",
              source: body.source ?? null,
              previousUserId: upserted.existing?.userId ?? null,
            });
        }
      }
      if (a.costCenterAction === "set") {
        const userId = ctx.userIdByEmail.get(a.userEmail)!;
        const result = await setCostCenterCore(userId, a.costCenter);
        if (result) {
          costCentersSet += 1;
          await audit(req.authCtx.userId, "user", userId, COST_IMPORT_RULE_IDS.costCenterSet, "allow",
            `cost centre for ${result.before.email} changed from '${result.before.costCenter ?? "(none)"}' to ` +
              `'${a.costCenter ?? "(none)"}' via roster`,
            { from: result.before.costCenter, to: a.costCenter, origin: "roster", source: body.source ?? null });
        }
      }
    }
    // ONE re-resolution pass for the whole roster, so the blast radius is
    // reported once rather than N times
    const impact = await reresolveAll();
    await audit(req.authCtx.userId, "user", null, COST_IMPORT_RULE_IDS.rosterApplied, "allow",
      `roster applied (${parsed.dialect}): ${parsed.rowsParsed} row(s), ${rowsAccepted} accepted, ${rowsRefused} ` +
        `refused; ${aliasesCreated} alias(es) created, ${aliasesUpdated} updated, ${costCentersSet} cost ` +
        `centre(s) set — ${impact.changed} stored line(s) re-attributed`,
      {
        source: body.source ?? null,
        vendor: body.vendor,
        aliasesCreated,
        aliasesUpdated,
        costCentersSet,
        rowsParsed: parsed.rowsParsed,
        rowsRefused,
        ...impact,
      });
    return reply.status(201).send({
      ...base,
      applied: true,
      aliasesCreated,
      aliasesUpdated,
      costCentersSet,
      reresolved: impact,
    });
  });

  // =======================================================================
  // THE CONSOLIDATED VIEW — and the total that does not exist
  // =======================================================================

  /**
   * Build both sides for a window. Shared by the org-wide (admin) and the
   * self-scoped (any user) routes so the two can never disagree about what a
   * person's own number is.
   */
  const buildConsolidated = async (
    window: { start: Date; end: Date },
    by: "user" | "cost_center",
    onlyUserId: string | null,
  ) => {
    const meteredRows = await db
      .select({
        userId: usageEvents.userId,
        costUsd: usageEvents.costUsd,
        projectId: usageEvents.projectId,
      })
      .from(usageEvents)
      .where(
        onlyUserId
          ? and(gte(usageEvents.at, window.start), lt(usageEvents.at, window.end), eq(usageEvents.userId, onlyUserId))
          : and(gte(usageEvents.at, window.start), lt(usageEvents.at, window.end)),
      );

    // metered spend's cost centre comes from the EXISTING pillar-5 machinery:
    // the attributed project's own code, falling back to its initiative's.
    const projectIds = [...new Set(meteredRows.map((r) => r.projectId).filter((x): x is string => Boolean(x)))];
    const projectRows = projectIds.length
      ? await db
          .select({ id: projects.id, costCenter: projects.costCenter, initiativeCostCenter: initiatives.costCenter })
          .from(projects)
          .leftJoin(initiatives, eq(projects.initiativeId, initiatives.id))
          .where(inArray(projects.id, projectIds))
      : [];
    const projectCostCenter = new Map(projectRows.map((p) => [p.id, p.costCenter ?? p.initiativeCostCenter ?? null]));

    // LIVE lines only (ADR-0076): a line a reconciliation pass marked as a
    // cross-batch duplicate is EXCLUDED here — and the exclusion is counted
    // and disclosed below, because a number that quietly got smaller is the
    // same disease as a number that quietly doubled.
    const importedRows = await db
      .select()
      .from(importedCostLines)
      .where(
        onlyUserId
          ? and(
              gte(importedCostLines.periodStart, window.start),
              lt(importedCostLines.periodStart, window.end),
              eq(importedCostLines.resolvedUserId, onlyUserId),
              isNull(importedCostLines.supersededAt),
            )
          : and(
              gte(importedCostLines.periodStart, window.start),
              lt(importedCostLines.periodStart, window.end),
              isNull(importedCostLines.supersededAt),
            ),
      );

    const [supersededInWindow] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(importedCostLines)
      .where(
        onlyUserId
          ? and(
              gte(importedCostLines.periodStart, window.start),
              lt(importedCostLines.periodStart, window.end),
              eq(importedCostLines.resolvedUserId, onlyUserId),
              isNotNull(importedCostLines.supersededAt),
            )
          : and(
              gte(importedCostLines.periodStart, window.start),
              lt(importedCostLines.periodStart, window.end),
              isNotNull(importedCostLines.supersededAt),
            ),
      );
    const [lastReconciled] = await db
      .select({ finishedAt: costReconciliationRuns.finishedAt })
      .from(costReconciliationRuns)
      .where(eq(costReconciliationRuns.outcome, "ok"))
      .orderBy(desc(costReconciliationRuns.startedAt))
      .limit(1);

    const userIds = [
      ...new Set([
        ...meteredRows.map((r) => r.userId),
        ...importedRows.map((r) => r.resolvedUserId).filter((x): x is string => Boolean(x)),
      ]),
    ];
    const userRows = userIds.length
      ? await db
          .select({ id: users.id, email: users.email, costCenter: users.costCenter })
          .from(users)
          .where(inArray(users.id, userIds))
      : [];
    const userById = new Map(userRows.map((u) => [u.id, u]));

    const metered: MeteredInput[] = meteredRows.map((r) => ({
      userId: r.userId,
      costCenter: (r.projectId ? projectCostCenter.get(r.projectId) : null) ?? userById.get(r.userId)?.costCenter ?? null,
      costUsd: r.costUsd,
    }));
    const imported: ImportedInput[] = importedRows.map((r) => ({
      userId: r.resolvedUserId,
      // the FILE's assertion wins; the resolved person's own code is the
      // fallback and is read at query time, so correcting a person's cost
      // centre restates history rather than leaving every stored line stale
      costCenter: r.costCenter ?? (r.resolvedUserId ? (userById.get(r.resolvedUserId)?.costCenter ?? null) : null),
      vendor: r.vendor,
      amount: r.amount,
      currency: r.currency,
      billingKind: r.billingKind,
    }));

    const labels = new Map<string, string>(userRows.map((u) => [u.id, u.email]));
    const { subjects, basisStatement } = consolidate({ by, metered, imported, labels });

    // STALENESS, mirroring ADR-0055's coverage scorecard: an operator has to be
    // able to see that nobody has uploaded a Copilot invoice since March, or
    // the imported side quietly becomes a stale number nobody questions.
    const vendorFreshness = await db
      .select({
        vendor: costImportBatches.vendor,
        lastImportedAt: sql<Date>`max(${costImportBatches.createdAt})`,
        batches: sql<number>`count(*)::int`,
      })
      .from(costImportBatches)
      .where(eq(costImportBatches.status, "applied"))
      .groupBy(costImportBatches.vendor);

    return {
      window: { from: window.start.toISOString(), to: window.end.toISOString() },
      groupedBy: by,
      subjects,
      basisStatement,
      // ADR-0076: what the reconciliation excluded from this very response.
      // Disclosed, never silent — the superseded rows still exist and are
      // listed by GET /v1/cost-imports/reconciliation.
      reconciliation: {
        supersededLinesExcluded: supersededInWindow?.n ?? 0,
        lastReconciledAt: lastReconciled?.finishedAt?.toISOString() ?? null,
        note:
          "Cross-batch duplicate lines marked by a reconciliation pass are excluded from the imported side above. " +
          "They are marked, never deleted: each carries the line that replaced it, the run that decided it and a " +
          "stated reason, and the full list is readable at /v1/cost-imports/reconciliation.",
      },
      staleness: {
        vendors: vendorFreshness.map((v) => ({
          vendor: v.vendor,
          lastImportedAt: v.lastImportedAt,
          appliedBatches: v.batches,
          daysSinceLastImport:
            v.lastImportedAt === null
              ? null
              : Math.floor((Date.now() - new Date(v.lastImportedAt).getTime()) / (24 * 3600 * 1000)),
        })),
        note:
          "There is no scheduled re-import: RegulAIt holds no vendor billing-API credential, so there is nothing to " +
          "poll. The imported side of every figure above is exactly as fresh as the last file somebody uploaded.",
      },
      note:
        "There is deliberately no combined figure. `metered` was observed and priced by RegulAIt; `imported` was " +
        "restated from a customer-supplied export. Adding them would present a number nobody can defend.",
    };
  };

  app.get("/v1/cost-consolidated", async (req, reply) => {
    const q = periodQuerySchema.parse(req.query ?? {});
    let window;
    try {
      window = resolveWindow(q);
    } catch (e) {
      return reply.status(400).send({ error: "invalid_window", detail: (e as Error).message });
    }
    const result = await buildConsolidated(window, q.by, null);
    await audit(req.authCtx.userId, "cost_import_batch", null, COST_IMPORT_RULE_IDS.consolidatedRead, "allow",
      `fleet-wide consolidated cost view read for ${result.window.from}..${result.window.to} grouped by ${q.by}`,
      { by: q.by, subjects: result.subjects.length });
    if (q.format === "csv") {
      return reply
        .headers({ ...securityHeaders("text/csv"), "content-type": "text/csv; charset=utf-8" })
        .send(renderConsolidatedCsv(result.subjects));
    }
    return result;
  });

  /**
   * THE SELF-SCOPED TWIN. In NON_ADMIN_ROUTES, and refuses in-handler unless
   * the caller IS this user: cross-user cost visibility is an entitlement
   * question, not a convenience, and a person's imported seat spend is exactly
   * the kind of figure that must not leak sideways.
   */
  app.get("/v1/users/:userId/cost-consolidated", async (req, reply) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const q = periodQuerySchema.parse(req.query ?? {});
    if (!req.authCtx.isAdmin && req.authCtx.userId !== userId) {
      return reply.status(403).send({
        error: "forbidden",
        detail: "you may read only your own consolidated spend; another person's is an admin surface",
      });
    }
    let window;
    try {
      window = resolveWindow(q);
    } catch (e) {
      return reply.status(400).send({ error: "invalid_window", detail: (e as Error).message });
    }
    const result = await buildConsolidated(window, "user", userId);
    if (q.format === "csv") {
      return reply
        .headers({ ...securityHeaders("text/csv"), "content-type": "text/csv; charset=utf-8" })
        .send(renderConsolidatedCsv(result.subjects));
    }
    return result;
  });
}
