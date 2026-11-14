/**
 * ADR-0261 (backlog P37) — THIRD-PARTY SECURITY TELEMETRY INGEST.
 *
 * A customer who already runs Cisco DefenseClaw points its HTTP JSONL log exporter at
 * `POST /v1/third-party-ingest/defenseclaw/records`. RegulAIt parses the documented export format only; it ships none
 * of DefenseClaw's code. What arrives is ATTRIBUTED THIRD-PARTY EVIDENCE:
 *  - each accepted record is an append-only row (dedup on the exporter's record id), and each batch is one audit-chain
 *    row the records name, marked `attribution: third_party, enforcement: false`;
 *  - a risky `security.finding` / `enforcement.action` record, or an `ai.discovery` record, opens or widens an ADR-0195
 *    shadow-AI finding under the provider `defenseclaw/<connector>`, on the device pseudonym (never the host name),
 *    so it never merges into a finding RegulAIt itself made, and a human disposition is never overwritten;
 *  - nothing here authorises, refuses or rate-limits a governed call. DefenseClaw's `block` is its decision, not ours.
 *
 * Posture (ADR-0180): a source is off until an admin enables it with a step-up, audited. Its credential is one
 * write-only `rgti_` token per source, stored as a hash, shown once, confined to the one ingest route (the route is
 * auth-exempt and authenticates in-route, like the endpoint-agent enrolment routes). The documented exporter cannot
 * sign a body (no HMAC header is documented for `http_jsonl`), so replay protection is the record-id dedup plus a
 * timestamp window on the database clock. Bodies are capped at 1 MiB and 512 records; lines at 64 KiB.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  and,
  auditLog,
  desc,
  eq,
  gt,
  inArray,
  shadowAiFindings,
  shadowAiImports,
  sql,
  thirdPartyIngestRecordFindings,
  thirdPartyIngestRecords,
  thirdPartyIngestSources,
  type Db,
  type ThirdPartyIngestSourceRow,
} from "@regulait/db";
import {
  DEFENSECLAW_INGEST_PATH,
  DEFENSECLAW_OTLP_LOGS_PATH,
  otlpLogsRequestToJsonl,
  DEFENSECLAW_SCHEMA_FAMILY,
  findingEvidenceReason,
  findingFor,
  parseDefenseClawJsonl,
  recordFreshness,
  THIRD_PARTY_INGEST_KINDS,
  THIRD_PARTY_INGEST_MAX_AGE_SECONDS,
  THIRD_PARTY_INGEST_MAX_BODY_BYTES,
  THIRD_PARTY_INGEST_MAX_FUTURE_SECONDS,
  THIRD_PARTY_INGEST_MAX_RECORDS,
  THIRD_PARTY_INGEST_MAX_RECORDS_PER_HOUR,
  THIRD_PARTY_INGEST_TOKEN_PREFIX,
  ThirdPartyBatchRefused,
  type CorrelatedFinding,
  type ParsedThirdPartyRecord,
  type ThirdPartyRejectCode,
} from "@regulait/shared";
import { databaseNow } from "./db-clock.js";
import { derivePseudonym, recordPseudonyms } from "./discovery-worker.js";
import { upsertFindings } from "./shadow-ai.js";
import { decodeOtlpLogsRequest, encodeOtlpLogsResponse, OTLP_CONTENT_TYPES, otlpEncodingOf } from "./third-party-otlp.js";
import { requireStepUp } from "./step-up.js";
import { hashToken } from "./token-hash.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const SOURCES_LISTED = 200;
const RECORDS_LISTED_MAX = 200;
const SUBSYSTEM = "third-party-ingest";

/** the audit rule ids this subsystem writes (kebab-case, ADR-0099) */
export const THIRD_PARTY_INGEST_RULE_IDS = {
  sourceCreated: "third-party-ingest-source-created",
  sourceEnabled: "third-party-ingest-source-enabled",
  sourceDisabled: "third-party-ingest-source-disabled",
  credentialIssued: "third-party-ingest-credential-issued",
  credentialRevoked: "third-party-ingest-credential-revoked",
  batchIngested: "third-party-evidence-ingested",
  batchRefused: "third-party-evidence-refused",
} as const;

/** the content types a JSONL exporter may send (the docs do not state DefenseClaw's; all four are parsed as raw bytes) */
export const THIRD_PARTY_INGEST_CONTENT_TYPES = ["application/x-ndjson", "application/jsonl", "application/json", "text/plain"] as const;

const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function audit(db: Db, actor: string, objectId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>, id?: string) {
  await db.insert(auditLog).values({
    ...(id ? { id } : {}),
    userId: actor,
    objectType: "third_party_ingest_source",
    objectId,
    detail: { subsystem: SUBSYSTEM, adr: "0261", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/** the bearer value when it is `rgti_` + 64 lower-case hex, else null (no regex on caller input) */
function ingestBearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const v = h.slice("Bearer ".length);
  if (v.length !== THIRD_PARTY_INGEST_TOKEN_PREFIX.length + 64 || !v.startsWith(THIRD_PARTY_INGEST_TOKEN_PREFIX)) return null;
  const hex = v.slice(THIRD_PARTY_INGEST_TOKEN_PREFIX.length);
  return [...hex].every((c) => (c >= "0" && c <= "9") || (c >= "a" && c <= "f")) ? v : null;
}

const refuse = (reply: FastifyReply, status: number, error: string, detail?: string) => reply.status(status).send(detail ? { error, detail } : { error });

function sourceView(s: ThirdPartyIngestSourceRow) {
  return {
    id: s.id,
    kind: s.kind,
    name: s.name,
    schemaFamily: s.schemaFamily,
    enabled: s.enabled,
    credential: s.tokenIssuedAt ? { issuedAt: s.tokenIssuedAt.toISOString() } : null,
    ingestPath: DEFENSECLAW_INGEST_PATH,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    /** what every record from this source is: evidence another product reported, never a RegulAIt decision */
    attribution: "third_party" as const,
  };
}

const sourceParam = z.object({ sourceId: z.string().uuid() });
const createBody = z.object({ kind: z.enum(THIRD_PARTY_INGEST_KINDS), name: z.string().trim().min(1).max(120) }).strict();
const enabledBody = z.object({ enabled: z.boolean() }).strict();
const recordsQuery = z.object({ limit: z.coerce.number().int().min(1).max(RECORDS_LISTED_MAX).default(50) }).strict();

export function registerThirdPartyIngestRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined } = {}): void {
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;

  const loadSource = async (reply: FastifyReply, params: unknown): Promise<ThirdPartyIngestSourceRow | null> => {
    const p = sourceParam.safeParse(params);
    if (!p.success) {
      await refuse(reply, 400, "invalid_request", "sourceId must be a uuid");
      return null;
    }
    const [row] = await db.select().from(thirdPartyIngestSources).where(eq(thirdPartyIngestSources.id, p.data.sourceId));
    if (!row) {
      await refuse(reply, 404, "unknown_source");
      return null;
    }
    return row;
  };

  // ---- admin: the source lifecycle (admin-only by default: none of these is in NON_ADMIN_ROUTES) ------------------

  app.get("/v1/third-party-ingest/sources", async () => {
    const rows = await db.select().from(thirdPartyIngestSources).orderBy(thirdPartyIngestSources.createdAt).limit(SOURCES_LISTED);
    return {
      sources: rows.map(sourceView),
      limits: {
        maxBodyBytes: THIRD_PARTY_INGEST_MAX_BODY_BYTES,
        maxRecordsPerRequest: THIRD_PARTY_INGEST_MAX_RECORDS,
        maxRecordsPerHour: THIRD_PARTY_INGEST_MAX_RECORDS_PER_HOUR,
        maxAgeSeconds: THIRD_PARTY_INGEST_MAX_AGE_SECONDS,
        maxFutureSeconds: THIRD_PARTY_INGEST_MAX_FUTURE_SECONDS,
        schemaFamily: DEFENSECLAW_SCHEMA_FAMILY,
      },
    };
  });

  app.post("/v1/third-party-ingest/sources", async (req, reply) => {
    const b = createBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_request", "send {kind: 'defenseclaw', name (1 to 120 characters)}");
    const created = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [dupe] = await t
        .select({ id: thirdPartyIngestSources.id })
        .from(thirdPartyIngestSources)
        .where(sql`lower(${thirdPartyIngestSources.name}) = lower(${b.data.name})`);
      if (dupe) return null;
      const [row] = await t
        .insert(thirdPartyIngestSources)
        .values({ kind: b.data.kind, name: b.data.name, createdBy: req.authCtx.userId ?? null })
        .returning();
      await audit(t, actor(req), row!.id, THIRD_PARTY_INGEST_RULE_IDS.sourceCreated, "allow", `third-party ingest source '${row!.name}' (${row!.kind}) created, off until enabled (ADR-0261)`, {
        kind: row!.kind,
        enabled: false,
      });
      return row!;
    });
    if (!created) return refuse(reply, 409, "source_name_taken");
    return reply.status(201).send({ source: sourceView(created) });
  });

  // on is a relaxation (ADR-0180): a step-up bound to this source, audited; off needs no step-up and is audited too
  app.put("/v1/third-party-ingest/sources/:sourceId/enabled", async (req, reply) => {
    const source = await loadSource(reply, req.params);
    if (!source) return reply;
    const b = enabledBody.safeParse(req.body ?? {});
    if (!b.success) return refuse(reply, 400, "invalid_request", "send {enabled: true | false}");
    if (b.data.enabled === source.enabled) return { source: sourceView(source) };
    let method: string | null = null;
    if (b.data.enabled) {
      const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { thirdPartyIngest: "enable", sourceId: source.id, kind: source.kind } });
      if (!su.ok) return reply;
      method = su.method;
    }
    const saved = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t
        .update(thirdPartyIngestSources)
        .set({ enabled: b.data.enabled, updatedAt: sql`now()` })
        .where(eq(thirdPartyIngestSources.id, source.id))
        .returning();
      await audit(
        t,
        actor(req),
        source.id,
        b.data.enabled ? THIRD_PARTY_INGEST_RULE_IDS.sourceEnabled : THIRD_PARTY_INGEST_RULE_IDS.sourceDisabled,
        b.data.enabled ? "deny" : "allow",
        b.data.enabled
          ? `third-party ingest source '${source.name}' enabled: its records are accepted as third-party evidence (step-up ${method}) (ADR-0261)`
          : `third-party ingest source '${source.name}' disabled: its records are refused (ADR-0261)`,
        { kind: source.kind, from: { enabled: source.enabled }, to: { enabled: b.data.enabled }, relaxation: b.data.enabled, ...(method ? { stepUp: method } : {}) },
      );
      return row!;
    });
    return { source: sourceView(saved) };
  });

  // a new write-only credential replaces any previous one; the secret is shown once and never stored
  app.post("/v1/third-party-ingest/sources/:sourceId/credential", async (req, reply) => {
    const source = await loadSource(reply, req.params);
    if (!source) return reply;
    const su = await requireStepUp(db, req, reply, { kind: "settings_relax", facts: { thirdPartyIngest: "credential", sourceId: source.id } });
    if (!su.ok) return reply;
    const secret = THIRD_PARTY_INGEST_TOKEN_PREFIX + randomBytes(32).toString("hex");
    const saved = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t
        .update(thirdPartyIngestSources)
        .set({ tokenHash: hashToken(secret), tokenIssuedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(thirdPartyIngestSources.id, source.id))
        .returning();
      await audit(t, actor(req), source.id, THIRD_PARTY_INGEST_RULE_IDS.credentialIssued, "allow", `a write-only ingest credential was issued for '${source.name}'${source.tokenHash ? ", replacing the previous one" : ""} (step-up ${su.method}) (ADR-0261)`, {
        replaced: source.tokenHash !== null,
        stepUp: su.method,
      });
      return row!;
    });
    return reply.status(201).send({
      source: sourceView(saved),
      // shown once. Configure it as the exporter's bearer (`bearer_env` or `bearer_credential`), with redaction on
      credential: { token: secret, header: "Authorization: Bearer <token>", path: DEFENSECLAW_INGEST_PATH },
    });
  });

  app.post("/v1/third-party-ingest/sources/:sourceId/credential/revoke", async (req, reply) => {
    const source = await loadSource(reply, req.params);
    if (!source) return reply;
    if (!source.tokenHash) return { source: sourceView(source) };
    const saved = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t
        .update(thirdPartyIngestSources)
        .set({ tokenHash: null, tokenIssuedAt: null, updatedAt: sql`now()` })
        .where(eq(thirdPartyIngestSources.id, source.id))
        .returning();
      await audit(t, actor(req), source.id, THIRD_PARTY_INGEST_RULE_IDS.credentialRevoked, "allow", `the ingest credential for '${source.name}' was revoked (ADR-0261)`, {});
      return row!;
    });
    return { source: sourceView(saved) };
  });

  // the newest evidence a source delivered, each row marked third-party
  app.get("/v1/third-party-ingest/sources/:sourceId/records", async (req, reply) => {
    const source = await loadSource(reply, req.params);
    if (!source) return reply;
    const q = recordsQuery.safeParse(req.query ?? {});
    if (!q.success) return refuse(reply, 400, "invalid_request", `limit is 1 to ${RECORDS_LISTED_MAX}`);
    const rows = await db
      .select()
      .from(thirdPartyIngestRecords)
      .where(eq(thirdPartyIngestRecords.sourceId, source.id))
      .orderBy(desc(thirdPartyIngestRecords.receivedAt), desc(thirdPartyIngestRecords.id))
      .limit(q.data.limit);
    const links = rows.length
      ? await db.select().from(thirdPartyIngestRecordFindings).where(inArray(thirdPartyIngestRecordFindings.recordId, rows.map((r) => r.id)))
      : [];
    return {
      records: rows.map((r) => ({
        id: r.id,
        recordId: r.recordId,
        bucket: r.bucket,
        eventName: r.eventName,
        severity: r.severity,
        /** the third-party product's own action; RegulAIt did not take it */
        reportedAction: r.action,
        connector: r.connector,
        devicePseudonym: r.devicePseudonym,
        attributes: r.attributes,
        observedAt: r.observedAt.toISOString(),
        receivedAt: r.receivedAt.toISOString(),
        recordSha256: r.recordSha256,
        batchSha256: r.batchSha256,
        auditLogId: r.auditLogId,
        findingIds: links.filter((l) => l.recordId === r.id).map((l) => l.findingId),
        attribution: "third_party" as const,
        enforcedByRegulAIt: false as const,
      })),
    };
  });

  // ---- the exporter's route: auth-exempt, authenticated in-route by the source's `rgti_` token -------------------

  app.register(async (scope) => {
    for (const type of [...THIRD_PARTY_INGEST_CONTENT_TYPES, OTLP_CONTENT_TYPES.protobuf]) {
      scope.addContentTypeParser(type, { parseAs: "buffer", bodyLimit: THIRD_PARTY_INGEST_MAX_BODY_BYTES }, (_req, body, done) => done(null, body));
    }
    scope.setErrorHandler((err: { code?: string; statusCode?: number }, _req, reply) => {
      if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") return refuse(reply, 413, "batch_too_large", `at most ${THIRD_PARTY_INGEST_MAX_BODY_BYTES} bytes per request`);
      if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return refuse(reply, 415, "unsupported_media_type", `send ${THIRD_PARTY_INGEST_CONTENT_TYPES.join(", ")}`);
      if (err.code === "FST_ERR_CTP_EMPTY_JSON_BODY") return refuse(reply, 400, "empty_batch");
      throw err;
    });

    // ADR-0302 decision 2: the JSONL route and the OTLP/HTTP logs route share this whole pipeline; only the wire
    // decoding and the success response differ
    const ingest = async (req: FastifyRequest, reply: FastifyReply, wire: "jsonl" | "otlp") => {
      const deny = (objectId: string | null, code: string, detail: Record<string, unknown> = {}) =>
        audit(db, NIL_UUID, objectId, THIRD_PARTY_INGEST_RULE_IDS.batchRefused, "deny", `a third-party evidence batch was refused: ${code} (ADR-0261)`, { code, attribution: "third_party", wire, ...detail });
      // each route takes only its own encodings
      const otlpEncoding = otlpEncodingOf(req.headers["content-type"]);
      if (wire === "otlp" && !otlpEncoding) {
        return refuse(reply, 415, "unsupported_media_type", `send ${OTLP_CONTENT_TYPES.protobuf} or ${OTLP_CONTENT_TYPES.json}`);
      }
      if (wire === "jsonl" && otlpEncoding === "protobuf") {
        return refuse(reply, 415, "unsupported_media_type", `send ${THIRD_PARTY_INGEST_CONTENT_TYPES.join(", ")}; OTLP goes to ${DEFENSECLAW_OTLP_LOGS_PATH}`);
      }

      const bearer = ingestBearer(req);
      if (!bearer) {
        await deny(null, "invalid_token");
        return refuse(reply, 401, "invalid_token");
      }
      const [source] = await db.select().from(thirdPartyIngestSources).where(eq(thirdPartyIngestSources.tokenHash, hashToken(bearer)));
      if (!source) {
        await deny(null, "invalid_token");
        return refuse(reply, 401, "invalid_token");
      }
      if (!source.enabled) {
        await deny(source.id, "source_disabled");
        return refuse(reply, 403, "source_disabled");
      }
      if (source.kind !== "defenseclaw") {
        await deny(source.id, "wrong_source_kind");
        return refuse(reply, 403, "wrong_source_kind");
      }
      if (!opts.dataKey) return refuse(reply, 503, "data_key_unavailable");
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        await deny(source.id, "empty_batch");
        return refuse(reply, 400, "empty_batch");
      }
      const batchSha256 = sha256Hex(body);

      // rate limit: records this source delivered in the last hour, on the database clock
      const [{ recent } = { recent: 0 }] = await db
        .select({ recent: sql<number>`count(*)::int` })
        .from(thirdPartyIngestRecords)
        .where(and(eq(thirdPartyIngestRecords.sourceId, source.id), gt(thirdPartyIngestRecords.receivedAt, sql`now() - interval '1 hour'`)));
      if (recent >= THIRD_PARTY_INGEST_MAX_RECORDS_PER_HOUR) {
        await deny(source.id, "rate_limited", { batchSha256, recentRecords: recent });
        reply.header("retry-after", "300");
        return refuse(reply, 429, "rate_limited", `at most ${THIRD_PARTY_INGEST_MAX_RECORDS_PER_HOUR} records per hour per source`);
      }

      let parsed;
      try {
        parsed =
          wire === "jsonl"
            ? parseDefenseClawJsonl(body, sha256Hex)
            : parseDefenseClawJsonl(otlpLogsRequestToJsonl(decodeOtlpLogsRequest(body, otlpEncoding!)), sha256Hex);
      } catch (e) {
        if (e instanceof ThirdPartyBatchRefused) {
          await deny(source.id, e.code, { batchSha256 });
          return refuse(reply, e.code === "too_many_records" ? 413 : 400, e.code);
        }
        throw e;
      }

      // the replay window, judged by the database clock (M-075)
      const now = await databaseNow(db);
      const rejects: Array<{ line: number; code: ThirdPartyRejectCode | "stale" | "future" }> = [...parsed.rejects];
      const fresh: ParsedThirdPartyRecord[] = [];
      for (const r of parsed.records) {
        const f = recordFreshness(r.observedAt, now);
        if (f === "fresh") fresh.push(r);
        else rejects.push({ line: r.line, code: f });
      }
      rejects.sort((a, b) => a.line - b.line);

      // device pseudonyms (ADR-0195 decision 20): the host name is enveloped, never stored in clear
      const hosts = [...new Set(fresh.map((r) => r.hostName).filter((h): h is string => h !== null))];
      const derived = new Map<string, Awaited<ReturnType<typeof derivePseudonym>>>();
      for (const h of hosts) derived.set(h, await derivePseudonym(db, opts.dataKey, "device", h));

      const auditId = randomUUID();
      const dataKey = opts.dataKey;
      const outcome = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const inserted = fresh.length
          ? await t
              .insert(thirdPartyIngestRecords)
              .values(
                fresh.map((r) => ({
                  sourceId: source.id,
                  recordId: r.recordId,
                  bucket: r.bucket,
                  eventName: r.eventName,
                  severity: r.severity,
                  action: r.action,
                  connector: r.connector,
                  devicePseudonym: r.hostName ? derived.get(r.hostName)!.pseudonym : null,
                  attributes: r.attributes,
                  observedAt: r.observedAt,
                  recordSha256: r.recordSha256,
                  batchSha256,
                  auditLogId: auditId,
                })),
              )
              .onConflictDoNothing({ target: [thirdPartyIngestRecords.sourceId, thirdPartyIngestRecords.recordId] })
              .returning({ id: thirdPartyIngestRecords.id, recordId: thirdPartyIngestRecords.recordId })
          : [];
        const rowIdByRecord = new Map(inserted.map((i) => [i.recordId, i.id]));
        const accepted = fresh.filter((r) => rowIdByRecord.has(r.recordId));

        // findings: one per (device, defenseclaw/<connector>), from newly accepted records only
        const groups = new Map<string, { finding: CorrelatedFinding; records: string[] }>();
        for (const r of accepted) {
          const f = findingFor(r);
          if (!f || !r.hostName) continue;
          const subject = derived.get(r.hostName)!.pseudonym;
          const key = `${subject}\u0000${f.provider}`;
          const at = r.observedAt.toISOString();
          const g = groups.get(key);
          const evidence = { source: "defenseclaw_export" as const, matchedValue: `record ${r.recordId}`.slice(0, 160), reason: findingEvidenceReason(r), observedAt: at };
          if (!g) {
            groups.set(key, {
              finding: {
                subjectKind: "device",
                subject,
                provider: f.provider,
                signalSources: ["defenseclaw_export"],
                signatureKinds: [],
                firstSeenAt: at,
                lastSeenAt: at,
                observationCount: 1,
                severity: f.severity,
                confidence: "low",
                replacementAgentId: null,
                replacementNote: null,
                evidence: [evidence],
              },
              records: [rowIdByRecord.get(r.recordId)!],
            });
            continue;
          }
          const rank = { low: 0, medium: 1, high: 2, critical: 3 } as const;
          g.finding.observationCount += 1;
          if (at < g.finding.firstSeenAt) g.finding.firstSeenAt = at;
          if (at > g.finding.lastSeenAt) g.finding.lastSeenAt = at;
          if (rank[f.severity] > rank[g.finding.severity]) g.finding.severity = f.severity;
          if (g.finding.evidence.length < 5) g.finding.evidence.push(evidence);
          g.records.push(rowIdByRecord.get(r.recordId)!);
        }

        let findings = { created: 0, updated: 0 };
        let importId: string | null = null;
        if (groups.size > 0) {
          const subjects = new Set([...groups.values()].map((g) => g.finding.subject));
          await recordPseudonyms(t, dataKey, [...derived.values()].filter((d) => subjects.has(d.pseudonym)));
          const [imp] = await t
            .insert(shadowAiImports)
            .values({
              kind: "defenseclaw_export",
              mode: "apply",
              status: "applied",
              source: `third_party_ingest:${source.id}`,
              payloadSha256: batchSha256,
              rowCount: accepted.length,
              summary: { attribution: "third_party", product: "defenseclaw", findings: groups.size, auditLogId: auditId },
              ruleId: THIRD_PARTY_INGEST_RULE_IDS.batchIngested,
              reason: "third-party DefenseClaw export batch (attributed evidence, not a RegulAIt decision; ADR-0261)",
              appliedAt: sql`now()`,
            })
            .returning({ id: shadowAiImports.id });
          importId = imp!.id;
          const list = [...groups.values()];
          findings = await upsertFindings(t, list.map((g) => g.finding), importId);
          for (const g of list) {
            const [row] = await t
              .select({ id: shadowAiFindings.id })
              .from(shadowAiFindings)
              .where(
                and(
                  eq(shadowAiFindings.subjectKind, "device"),
                  sql`lower(${shadowAiFindings.subject}) = lower(${g.finding.subject})`,
                  sql`lower(${shadowAiFindings.provider}) = lower(${g.finding.provider})`,
                ),
              );
            if (!row) continue;
            await t
              .insert(thirdPartyIngestRecordFindings)
              .values(g.records.map((recordId) => ({ recordId, findingId: row.id })))
              .onConflictDoNothing();
          }
        }

        const buckets: Record<string, number> = {};
        for (const r of accepted) buckets[r.bucket] = (buckets[r.bucket] ?? 0) + 1;
        const rejectedByCode: Record<string, number> = {};
        for (const r of rejects) rejectedByCode[r.code] = (rejectedByCode[r.code] ?? 0) + 1;
        const duplicates = fresh.length - accepted.length;
        await audit(
          t,
          NIL_UUID,
          source.id,
          THIRD_PARTY_INGEST_RULE_IDS.batchIngested,
          "allow",
          `third-party DefenseClaw evidence received from '${source.name}': ${accepted.length} accepted, ${duplicates} duplicate, ${rejects.length} rejected. Attributed evidence, not a RegulAIt enforcement decision (ADR-0261)`,
          {
            attribution: "third_party",
            product: "defenseclaw",
            schemaFamily: DEFENSECLAW_SCHEMA_FAMILY,
            enforcement: false,
            batchSha256,
            lines: parsed.lines,
            accepted: accepted.length,
            duplicates,
            rejected: rejects.length,
            rejectedByCode,
            buckets,
            findingsCreated: findings.created,
            findingsUpdated: findings.updated,
            importId,
            wire,
          },
          auditId,
        );
        return { accepted: accepted.length, duplicates, findings };
      });

      if (wire === "otlp") {
        // the OTLP contract: an ExportLogsServiceResponse, with partial success naming how many records were rejected
        const res = encodeOtlpLogsResponse(otlpEncoding!, rejects.length, rejects.length ? `rejected records (1-based): ${rejects.slice(0, 20).map((r) => `${r.line}:${r.code}`).join(", ")}` : "");
        return reply.status(200).header("content-type", res.contentType).send(res.body);
      }
      return reply.status(200).send({
        accepted: outcome.accepted,
        duplicates: outcome.duplicates,
        rejected: rejects,
        findingsCreated: outcome.findings.created,
        findingsUpdated: outcome.findings.updated,
        attribution: "third_party",
      });
    };

    scope.post(DEFENSECLAW_INGEST_PATH, (req, reply) => ingest(req, reply, "jsonl"));
    scope.post(DEFENSECLAW_OTLP_LOGS_PATH, (req, reply) => ingest(req, reply, "otlp"));
  });
}
