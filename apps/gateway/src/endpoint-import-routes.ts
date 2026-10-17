/**
 * ADR-0195 SD3 — ENDPOINT EVIDENCE IMPORTS INTO SD0. Admin-only (none is in
 * NON_ADMIN_ROUTES), every outcome audited.
 *
 *   POST /v1/discovery/sources/:sourceId/endpoint-imports
 *        an osquery results file (`endpoint_osquery` source) or an MDM/EDR
 *        inventory export (`endpoint_inventory` source). `dry_run` (default)
 *        parses and matches and writes nothing but an audit row; `apply` opens
 *        a discovery run for the source, holds its lease, and commits the
 *        findings with the run through SD0's own fenced path.
 *   POST /v1/discovery/endpoint-signatures/seed
 *        installs SD3's endpoint signature seed into the admin catalogue
 *        (`ai_endpoint_signatures`, SD0's `identifier` match type). Idempotent;
 *        an admin-edited row is never touched.
 *
 * PRIVACY (decision 20). The importer runs with a REQUEST-LOCAL keyed hash, so
 * home paths, SIDs and every name in the file stay inside this request. Only
 * the device and the device user of a sighting that is committed get SD0
 * pseudonyms (`pseudonymise`, display name enveloped under the data key); the
 * user travels as the observation's `actorPseudonym`. The raw file is digested
 * (SHA-256) and discarded (decision 6). Device findings and device pseudonyms
 * fall under SD0's endpoint retention (90 days default).
 *
 * SD0 has no `device` pseudonym kind yet (its kinds are device_user,
 * commit_author, cloud_principal), so device names use `device_user` until
 * SD0 adds one; `DEVICE_PSEUDONYM_KIND` switches automatically when it does.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { aiEndpointSignatures, and, auditLog, discoveryRuns, discoverySources, eq, sql, type Db } from "@regulait/db";
import {
  DISCOVERY_PSEUDONYM_KINDS,
  ENDPOINT_IMPORT_MAX_BYTES,
  EVIDENCE_MAX_ROWS,
  EndpointImportFormatError,
  endpointCatalogueSignatures,
  importEndpointInventory,
  importOsqueryResults,
  isShippedEndpointProvenance,
  reduceEndpointObservations,
  type DiscoveryPseudonymKind,
  type EndpointImportResult,
  type EndpointPseudonymHook,
} from "@regulait/shared";
import { DISCOVERY_SCANNERS, type ScanObservation, type ScannerRegistry } from "./discovery-scanners.js";
import { applyDiscoveryRunObservations, checkObservations, failRun, loadEnabledCatalogue, pseudonymise, DISCOVERY_LEASE_SECONDS } from "./discovery-worker.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const REFUSALS_SHOWN = 200;

/** SD0's device pseudonym kind when it exists, else device_user (see the header) */
export const DEVICE_PSEUDONYM_KIND: DiscoveryPseudonymKind = ((DISCOVERY_PSEUDONYM_KINDS as readonly string[]).includes("device")
  ? "device"
  : "device_user") as DiscoveryPseudonymKind;

const IMPORT_KINDS = ["endpoint_osquery", "endpoint_inventory"] as const;
type ImportKind = (typeof IMPORT_KINDS)[number];
const isImportKind = (k: string): k is ImportKind => (IMPORT_KINDS as readonly string[]).includes(k);

const bodySchema = z
  .object({
    content: z.string().min(1).max(ENDPOINT_IMPORT_MAX_BYTES),
    /** inventory only: csv (default) or json. osquery results are JSON lines or one JSON array, detected. */
    format: z.enum(["csv", "json"]).optional(),
    mode: z.enum(["dry_run", "apply"]).default("dry_run"),
    /** inventory only: the column mapping (see importEndpointInventory) */
    config: z.unknown().optional(),
    /** osquery only: the key the pack has in the customer's osquery config */
    packName: z.string().min(1).max(100).optional(),
    onMalformedRow: z.enum(["refuse_file", "report_and_continue"]).default("refuse_file"),
    /** a filename or a sentence about where the file came from */
    source: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const uuidParam = z.object({ sourceId: z.string().uuid() });

/** a request-local keyed hash that remembers clear values (devices, users, SIDs) for this request only */
function requestLocalHook(): { hook: EndpointPseudonymHook; clearOf: (token: string) => string | undefined } {
  const key = randomBytes(32);
  const clear = new Map<string, string>();
  return {
    hook: ({ kind, value }) => {
      const token = `tmp_${createHmac("sha256", key).update(`${kind}\u0000${value}`).digest("hex").slice(0, 24)}`;
      clear.set(token, value);
      return token;
    },
    clearOf: (token) => clear.get(token),
  };
}

function summarise(result: EndpointImportResult, matched: number, unmatched: number) {
  return {
    rowsParsed: result.rowsParsed,
    observations: result.observations.length,
    refused: result.refusals.length,
    removedRows: result.removedRows,
    rowsWithoutTimestamp: result.rowsWithoutTimestamp,
    devices: result.devices,
    sightingsMatched: matched,
    observationsUnmatched: unmatched,
  };
}

export function registerEndpointImportRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined; registry?: ScannerRegistry } = {}): void {
  const registry = opts.registry ?? DISCOVERY_SCANNERS;
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const audit = (req: FastifyRequest, objectType: "discovery_source" | "discovery_run" | "ai_endpoint_signature", objectId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) =>
    db.insert(auditLog).values({
      userId: actor(req),
      objectType,
      objectId,
      detail: { subsystem: "shadow-ai-discovery", slice: "SD3", ...detail },
      effect,
      ruleId,
      ruleChain: [],
      reason,
    });
  const refuse = (reply: FastifyReply, status: number, error: string, detail: string, extra: Record<string, unknown> = {}) =>
    reply.status(status).send({ error, detail, ...extra });

  app.post("/v1/discovery/sources/:sourceId/endpoint-imports", { bodyLimit: ENDPOINT_IMPORT_MAX_BYTES * 2 + 64 * 1024 }, async (req, reply) => {
    const p = uuidParam.safeParse(req.params);
    if (!p.success) return refuse(reply, 400, "invalid_request", "sourceId must be a uuid");
    const b = bodySchema.safeParse(req.body ?? {});
    if (!b.success) {
      return refuse(reply, 400, "invalid_request", b.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
    }
    const body = b.data;
    const [source] = await db.select().from(discoverySources).where(eq(discoverySources.id, p.data.sourceId));
    if (!source) return refuse(reply, 404, "not_found", "no such discovery source");
    if (!isImportKind(source.kind)) {
      return refuse(reply, 409, "not_an_import_source", `a ${source.kind} source is scanned, not imported; endpoint imports go to an endpoint_osquery or endpoint_inventory source`);
    }
    if (!registry.has(source.kind)) return refuse(reply, 409, "scanner_not_built", `no scanner is built for ${source.kind}`);
    if (!source.enabled) return refuse(reply, 409, "source_disabled", "enable this source before importing into it");

    const local = requestLocalHook();
    let result: EndpointImportResult;
    try {
      result =
        source.kind === "endpoint_osquery"
          ? importOsqueryResults({ content: body.content, pseudonymise: local.hook, ...(body.packName ? { packName: body.packName } : {}) })
          : importEndpointInventory({ content: body.content, format: body.format ?? "csv", config: body.config, pseudonymise: local.hook });
    } catch (e) {
      if (e instanceof EndpointImportFormatError) {
        await audit(req, "discovery_source", source.id, "discovery-endpoint-import-refused", "deny", `endpoint import into '${source.name}' refused: ${e.message.slice(0, 300)}`, {
          sourceId: source.id,
          kind: source.kind,
          reason: "unreadable_file",
        });
        return refuse(reply, 400, e.code, e.message, { importer: e.detail.importer, ...(e.detail.found ? { found: e.detail.found } : {}), ...(e.detail.missing ? { missing: e.detail.missing } : {}) });
      }
      throw e;
    }
    const digest = createHash("sha256").update(body.content, "utf8").digest("hex");

    if (result.refusals.length > 0 && body.onMalformedRow === "refuse_file") {
      await audit(req, "discovery_source", source.id, "discovery-endpoint-import-refused", "deny", `endpoint import into '${source.name}' refused: ${result.refusals.length} of ${result.rowsParsed} row(s) could not be imported`, {
        sourceId: source.id,
        kind: source.kind,
        payloadSha256: digest,
        rowsParsed: result.rowsParsed,
        refused: result.refusals.length,
      });
      return refuse(
        reply,
        422,
        "rows_refused",
        `${result.refusals.length} row(s) could not be imported, so the whole file is refused. Fix them, or send onMalformedRow='report_and_continue' to import the readable rows with every refusal listed.`,
        { refusals: result.refusals.slice(0, REFUSALS_SHOWN), refusalsTotal: result.refusals.length, rowsParsed: result.rowsParsed },
      );
    }

    const catalogue = await loadEnabledCatalogue(db);
    const reduction = reduceEndpointObservations(result, catalogue);
    const summary = summarise(result, reduction.matched.length, reduction.unmatchedCount);
    if (reduction.matched.length + reduction.unmatched.length > EVIDENCE_MAX_ROWS) {
      return refuse(reply, 422, "too_many_sightings", `the file yields ${reduction.matched.length} matched sightings; at most ${EVIDENCE_MAX_ROWS} are applied per import — split the file`, { summary });
    }
    const byArtifact = new Map<string, { provider: string; kind: string; value: string; devices: number; rows: number }>();
    for (const m of reduction.matched) {
      const k = `${m.provider}\u0000${m.kind}\u0000${m.value.toLowerCase()}`;
      const have = byArtifact.get(k) ?? { provider: m.provider, kind: m.kind, value: m.value, devices: 0, rows: 0 };
      have.devices += 1;
      have.rows += m.count;
      byArtifact.set(k, have);
    }
    const view = {
      sourceId: source.id,
      kind: source.kind,
      payloadSha256: digest,
      summary,
      matchedArtifacts: [...byArtifact.values()].slice(0, 500),
      catalogueGaps: reduction.unmatched.map((u) => ({ kind: u.kind, value: u.value })),
      refusals: result.refusals.slice(0, REFUSALS_SHOWN),
      refusalsTotal: result.refusals.length,
    };

    if (body.mode === "dry_run") {
      await audit(req, "discovery_source", source.id, "discovery-endpoint-import-planned", "allow", `endpoint import into '${source.name}' planned (dry run): ${summary.observations} observation(s), ${summary.sightingsMatched} matched sighting(s)`, {
        sourceId: source.id,
        kind: source.kind,
        payloadSha256: digest,
        ...summary,
        ...(body.source ? { fileSource: body.source } : {}),
      });
      return reply.send({ mode: "dry_run", ...view });
    }

    if (!opts.dataKey) return refuse(reply, 409, "data_key_unavailable", "the data key is not configured, so device names cannot be pseudonymised; nothing was imported");
    const owner = `endpoint-import:${randomUUID()}`;
    const [run] = await db
      .insert(discoveryRuns)
      .values({
        sourceId: source.id,
        trigger: "manual",
        requestedBy: actor(req),
        status: "running",
        attempt: 1,
        sourceVersion: source.version,
        kind: source.kind,
        leaseOwner: owner,
        leaseExpiresAt: sql`now() + make_interval(secs => ${DISCOVERY_LEASE_SECONDS})`,
        startedAt: sql`now()`,
      })
      .onConflictDoNothing({ target: discoveryRuns.sourceId, where: sql`status IN ('queued', 'running')` })
      .returning();
    if (!run) return refuse(reply, 409, "run_in_progress", "a run of this source is queued or running; import again when it has finished");

    try {
      const psn = new Map<string, string>();
      const pseudonymOf = async (kind: DiscoveryPseudonymKind, token: string) => {
        const k = `${kind}\u0000${token}`;
        const hit = psn.get(k);
        if (hit) return hit;
        const clear = local.clearOf(token);
        if (!clear) throw new Error("an observation named a device or user the importer did not report");
        const out = await pseudonymise(db, opts.dataKey!, kind, clear);
        psn.set(k, out);
        return out;
      };
      const deviceOf = (token: string) => pseudonymOf(DEVICE_PSEUDONYM_KIND, token);
      const evidenceKind = source.kind;
      const scan: ScanObservation[] = [];
      for (const m of reduction.matched) {
        scan.push({
          evidenceKind,
          subjectKind: "device",
          subject: await deviceOf(m.device),
          ...(m.observedAt ? { observedAt: m.observedAt } : {}),
          count: m.count,
          artifact: { kind: m.kind, value: m.value },
          ...(m.user ? { actorPseudonym: await pseudonymOf("device_user", m.user) } : {}),
        });
      }
      // unmatched sightings go through the same classification, so the run records them as catalogue gaps
      for (const u of reduction.unmatched) {
        scan.push({ evidenceKind, subjectKind: "device", subject: await deviceOf(u.device), artifact: { kind: u.kind, value: u.value } });
      }
      const checked = checkObservations(source.kind, scan, new Date().toISOString());
      const verdict = await applyDiscoveryRunObservations(db, run, owner, source, checked, digest, catalogue);
      if (verdict !== "succeeded") return refuse(reply, 409, "run_lost", "the import's run lost its lease before it committed; nothing was imported", { runId: run.id });
      await audit(req, "discovery_run", run.id, "discovery-endpoint-import-applied", "allow", `endpoint import into '${source.name}' applied: ${summary.sightingsMatched} matched sighting(s) on ${summary.devices} device(s)`, {
        sourceId: source.id,
        kind: source.kind,
        payloadSha256: digest,
        ...summary,
        ...(body.source ? { fileSource: body.source } : {}),
      });
      const [done] = await db.select().from(discoveryRuns).where(eq(discoveryRuns.id, run.id));
      return reply.status(201).send({
        mode: "apply",
        runId: run.id,
        findingsCreated: done?.findingsCreated ?? 0,
        findingsUpdated: done?.findingsUpdated ?? 0,
        ...view,
      });
    } catch (e) {
      await failRun(db, run, owner, "endpoint_import_error", e instanceof Error ? e.message : String(e), { payloadSha256: digest });
      throw e;
    }
  });

  app.post("/v1/discovery/endpoint-signatures/seed", async (req, reply) => {
    let inserted = 0;
    let refreshed = 0;
    let lowConfidence = 0;
    for (const s of endpointCatalogueSignatures()) {
      if (s.confidence === "low") lowConfidence += 1;
      const [existing] = await db
        .select()
        .from(aiEndpointSignatures)
        .where(and(eq(aiEndpointSignatures.kind, s.kind), sql`lower(${aiEndpointSignatures.value}) = lower(${s.value})`));
      if (!existing) {
        await db.insert(aiEndpointSignatures).values({
          provider: s.provider,
          kind: s.kind,
          value: s.value,
          matchType: "identifier",
          provenance: s.provenance,
          enabled: s.enabled,
          updatedByUserId: req.authCtx.userId ?? null,
        });
        inserted += 1;
        continue;
      }
      // an admin's edit (provenance 'admin') is never clobbered
      if (isShippedEndpointProvenance(existing.provenance)) {
        await db
          .update(aiEndpointSignatures)
          .set({ provider: s.provider, matchType: "identifier", provenance: s.provenance, lastUpdatedAt: new Date() })
          .where(eq(aiEndpointSignatures.id, existing.id));
        refreshed += 1;
      }
    }
    await audit(req, "ai_endpoint_signature", null, "discovery-endpoint-signatures-seeded", "allow", `endpoint signature seed installed: ${inserted} added, ${refreshed} refreshed (admin-edited rows untouched)`, {
      inserted,
      refreshed,
    });
    return reply.send({
      inserted,
      refreshed,
      lowConfidenceRows: lowConfidence,
      note:
        "Rows marked low confidence in the seed (the LAN-listener trait rows) are leads, not proof of AI use. " +
        "The catalogue has no confidence column yet, so the mark is not stored on the row.",
    });
  });
}
