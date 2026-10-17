/**
 * ADR-0195 SD4b — THE ENDPOINT AGENT'S GATEWAY SIDE: enrolment, registration,
 * key rotation, config and signed report upload for the RegulAIt endpoint
 * agent (agents/endpoint/, SD4a), the admin routes that issue and revoke
 * enrolment tokens and revoke devices, and the job that commits accepted
 * reports into SD0's findings.
 *
 * STRICT DEFAULT (ADR-0180). Nothing here works until an admin creates an
 * `endpoint_agent` discovery source and enables it, which is SD0's
 * `settings_relax` step-up (audited). A disabled source refuses ticket
 * redemption, registration, config and reports alike.
 *
 *   POST /v1/endpoint-agent/enrolment-tickets   bulk token (`rgea_…`), in-route; one device ticket per device
 *   POST /v1/endpoint-agent/register            device ticket (`rgat_…`), in-route; one identity per device user
 *   POST /v1/endpoint-agent/credentials         the agent's self token; key rotation (ADR-0188 S7 point 4)
 *   GET  /v1/endpoint-agent/config              the agent's self token; 503 until a signed collection pack exists
 *   POST /v1/endpoint-agent/reports             the agent's self token + Content-Digest + report signature
 *
 *   POST /v1/discovery/sources/:sourceId/enrolment-tokens     admin: issue (capped, at most 30 days; shown once)
 *   GET  /v1/discovery/sources/:sourceId/enrolment-tokens     admin: list (never the token)
 *   POST /v1/discovery/enrolment-tokens/:tokenId/revoke       admin: no new tickets, no new registrations
 *   GET  /v1/discovery/sources/:sourceId/endpoint-devices     admin: pseudonymous devices and their identities
 *   POST /v1/discovery/endpoint-devices/:deviceId/revoke      admin: the device's identities and tokens are revoked
 *
 * A REPORT IS ACCEPTED ONLY when: the self token verifies (DPoP-bound, its
 * device not revoked), the body fits the bounds, the `Content-Digest` equals
 * the digest recomputed over the raw body, the report signature verifies under
 * the identity's bound key with that digest and the body's snapshot id, its
 * `jti` has not been seen (replay), it is fresh, the snapshot was collected
 * within a day, and the body's OS and architecture are the device's. A retry of
 * an accepted snapshot (a fresh signature, the same snapshot id) is a 202
 * duplicate. The accepted report keeps only digests, counts, fixed gap codes and
 * the catalogue sightings (`endpoint-agent.ts`); the job below merges them into
 * `shadow_ai_findings` through SD0's fenced path (`applyDiscoveryRunObservations`)
 * as signal source `endpoint_agent`, subject kind `device`, the device user as
 * `actorPseudonym`. Every refusal is a fixed code and is audited with fixed
 * fields only.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  and,
  asc,
  auditLog,
  desc,
  discoveryPseudonyms,
  discoveryRuns,
  discoverySources,
  endpointAgentIdentities,
  endpointAgentReports,
  endpointDevices,
  endpointEnrolmentTokens,
  eq,
  inArray,
  isNull,
  sql,
  workloadCredentials,
  workloadIdentities,
  type Db,
  type DiscoverySourceRow,
} from "@regulait/db";
import { defaultWorkloadIdentifier, EVIDENCE_MAX_ROWS, JWK_THUMBPRINT_URI_PREFIX, type WorkloadPublicJwk } from "@regulait/shared";
import { claimReplay } from "./delegated-token.js";
import { databaseNow } from "./delegation.js";
import { DISCOVERY_SCANNERS, type ScanObservation, type ScannerRegistry } from "./discovery-scanners.js";
import {
  applyDiscoveryRunObservations,
  checkObservations,
  derivePseudonym,
  DISCOVERY_LEASE_SECONDS,
  failRun,
  loadEnabledCatalogue,
  ObservationRefused,
  recordPseudonyms,
} from "./discovery-worker.js";
import {
  CONTENT_DIGEST_HEADER,
  endpointAgentContext,
  ENDPOINT_AGENT_PATHS,
  ENDPOINT_BULK_TOKEN_PREFIX,
  ENDPOINT_CAP_ALERT_FRACTIONS,
  ENDPOINT_ENROL_FILE_SCHEMA,
  ENDPOINT_REPORT_MAX_BYTES,
  ENDPOINT_REPORT_SIGNATURE_HEADER,
  ENDPOINT_REPORT_SIGNATURE_MAX_AGE_SECONDS,
  ENDPOINT_REPORT_SIGNATURE_MAX_FUTURE_SECONDS,
  ENDPOINT_REPORTS_PER_RUN,
  ENDPOINT_TICKET_IDENTITY_CAP,
  ENDPOINT_TICKET_PREFIX,
  ENDPOINT_TICKET_TTL_DAYS,
  ENDPOINT_TOKEN_MAX_DAYS,
  ENDPOINT_TOKEN_MAX_DEVICES,
  isUuidV4,
  reduceReportFacts,
  registerRequestSchema,
  reportFresh,
  reportSchema,
  rotateRequestSchema,
  ticketRequestSchema,
  verifyReportSignature,
  type EndpointAgentContext,
} from "./endpoint-agent.js";
import { keyRegistered, prepareRunnerKey, rotateWorkloadKeyTx, rotationProofValid, runnerKeyThumbprint } from "./engine-runner-keys.js";
import { resolveTrustDomain } from "./in-process-delegation.js";
import { deploymentEnvironment, identityIssuer } from "./oauth/common.js";
import { bindPreparedCredentialTx, IdentityAdminError, revokeWorkloadIdentity } from "./oauth/identity-admin.js";
import type { SchedulerJobDefinition } from "./scheduler.js";
import { hashToken } from "./token-hash.js";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
/** a request body for the two enrolment routes is small */
const ENROL_BODY_LIMIT = 16 * 1024;
export const ENDPOINT_AGENT_INGEST_JOB_NAME = "endpoint-agent-ingest";
const DEVICES_LISTED = 500;

type AuditObject = "discovery_source" | "discovery_run" | "workload_identity";

async function audit(db: Db, actor: string, objectType: AuditObject, objectId: string | null, ruleId: string, effect: "allow" | "deny", reason: string, detail: Record<string, unknown>) {
  await db.insert(auditLog).values({
    userId: actor,
    objectType,
    objectId,
    detail: { subsystem: "shadow-ai-discovery", slice: "SD4b", ...detail },
    effect,
    ruleId,
    ruleChain: [],
    reason,
  });
}

/** the bearer value of an Authorization header when it has `prefix` and 64 hex characters after it, else null */
function bearerWithPrefix(req: FastifyRequest, prefix: string): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
  const v = h.slice("Bearer ".length);
  if (v.length !== prefix.length + 64 || !v.startsWith(prefix)) return null;
  const hex = v.slice(prefix.length);
  return [...hex].every((c) => (c >= "0" && c <= "9") || (c >= "a" && c <= "f")) ? v : null;
}

/** the raw body as JSON, or undefined (an unparseable body is never echoed) */
function jsonOf(body: unknown): unknown {
  if (!Buffer.isBuffer(body) || body.length === 0) return undefined;
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

const refuse = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ error });

// ---------------------------------------------------------------------------
// Committing accepted reports (one discovery run per batch, SD0's fenced path)
// ---------------------------------------------------------------------------

export interface EndpointIngestOutcome {
  runs: number;
  committed: number;
  refused: number;
}

/**
 * Commit pending reports of one source: open a run holding its lease (one live
 * run per source, so two replicas never commit the same report), turn the
 * sightings into SD0 observations, and commit them with the reports' outcome in
 * SD0's fenced transaction. A run SD0's checks refuse marks its reports refused
 * (they are never retried forever).
 */
/** pending reports of live devices of a source: the only ones a run commits (a revoked device's are never merged) */
const committable = (sourceId: string) =>
  and(eq(endpointAgentReports.sourceId, sourceId), eq(endpointAgentReports.status, "pending"), isNull(endpointDevices.revokedAt))!;

export async function commitPendingEndpointReports(db: Db, source: DiscoverySourceRow): Promise<EndpointIngestOutcome> {
  const out: EndpointIngestOutcome = { runs: 0, committed: 0, refused: 0 };
  const [any] = await db
    .select({ id: endpointAgentReports.id })
    .from(endpointAgentReports)
    .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentReports.deviceId))
    .where(committable(source.id))
    .limit(1);
  if (!any) return out;
  const owner = `endpoint-agent-ingest:${randomUUID()}`;
  const [run] = await db
    .insert(discoveryRuns)
    .values({
      sourceId: source.id,
      trigger: "manual",
      requestedBy: null,
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
  if (!run) return out;
  out.runs = 1;
  const pending = await db
    .select({
      id: endpointAgentReports.id,
      collectedAt: endpointAgentReports.collectedAt,
      bodySha256: endpointAgentReports.bodySha256,
      sightings: endpointAgentReports.sightings,
      devicePseudonym: endpointDevices.devicePseudonym,
      userPseudonym: endpointAgentIdentities.deviceUserPseudonym,
    })
    .from(endpointAgentReports)
    .innerJoin(endpointDevices, eq(endpointDevices.id, endpointAgentReports.deviceId))
    .innerJoin(endpointAgentIdentities, eq(endpointAgentIdentities.identityId, endpointAgentReports.identityId))
    .where(committable(source.id))
    .orderBy(asc(endpointAgentReports.receivedAt))
    .limit(ENDPOINT_REPORTS_PER_RUN);
  const ids: string[] = [];
  const scan: ScanObservation[] = [];
  const pseudonyms = new Set<string>();
  const hash = createHash("sha256");
  for (const r of pending) {
    if (scan.length + r.sightings.length > EVIDENCE_MAX_ROWS) break;
    ids.push(r.id);
    hash.update(r.bodySha256);
    pseudonyms.add(r.devicePseudonym);
    pseudonyms.add(r.userPseudonym);
    for (const s of r.sightings) {
      scan.push({
        evidenceKind: "endpoint_agent",
        subjectKind: "device",
        subject: r.devicePseudonym,
        observedAt: r.collectedAt.toISOString(),
        count: s.count,
        artifact: { kind: s.kind as NonNullable<ScanObservation["artifact"]>["kind"], value: s.value },
        ...(s.os ? { os: s.os as NonNullable<ScanObservation["os"]> } : {}),
        ...(s.ecosystem ? { ecosystem: s.ecosystem } : {}),
        actorPseudonym: r.userPseudonym,
      });
    }
  }
  if (ids.length === 0) {
    // another replica's run took them between the check and this run: nothing is left to commit
    await failRun(db, run, owner, "nothing_pending", "no endpoint agent report was pending when the run started");
    return out;
  }
  const digest = hash.digest("hex");
  const markOutcome = async (t: Db, status: "committed" | "refused") => {
    const done = await t
      .update(endpointAgentReports)
      .set({ status, runId: run.id, committedAt: sql`now()` })
      .where(and(inArray(endpointAgentReports.id, ids), eq(endpointAgentReports.status, "pending")))
      .returning({ id: endpointAgentReports.id });
    // the run is the source's only live one, so nothing else can have taken them; fail closed if something did
    if (done.length !== ids.length) throw new Error("an endpoint report changed under its run");
  };
  try {
    const catalogue = await loadEnabledCatalogue(db);
    const checked = checkObservations(source.kind, scan, new Date().toISOString(), catalogue);
    const verdict = await applyDiscoveryRunObservations(db, run, owner, source, checked, digest, catalogue, [], async (t) => {
      await markOutcome(t, "committed");
      // the devices and users of committed evidence were seen now (SD0 retention reads last seen)
      if (pseudonyms.size > 0) await t.update(discoveryPseudonyms).set({ lastSeenAt: sql`now()` }).where(inArray(discoveryPseudonyms.pseudonym, [...pseudonyms]));
    });
    if (verdict === "succeeded") out.committed = ids.length;
    return out;
  } catch (e) {
    if (e instanceof ObservationRefused) {
      const fixed = "an endpoint agent report was refused by the discovery checks; it was not merged";
      await db.transaction(async (tx) => markOutcome(tx as unknown as Db, "refused"));
      await failRun(db, run, owner, "observation_refused", fixed, { reports: ids.length });
      out.refused = ids.length;
      return out;
    }
    await failRun(db, run, owner, "endpoint_agent_ingest_error", "the endpoint report batch failed before it committed; the reports stay pending", { reports: ids.length });
    throw e;
  }
}

/** one pass over every enabled endpoint agent source with pending reports */
export async function runEndpointAgentIngest(db: Db): Promise<EndpointIngestOutcome> {
  const total: EndpointIngestOutcome = { runs: 0, committed: 0, refused: 0 };
  const sources = await db
    .select()
    .from(discoverySources)
    .where(
      and(
        eq(discoverySources.enabled, true),
        eq(discoverySources.kind, "endpoint_agent"),
        sql`EXISTS (SELECT 1 FROM endpoint_agent_reports r JOIN endpoint_devices d ON d.id = r.device_id
                     WHERE r.source_id = ${discoverySources.id} AND r.status = 'pending' AND d.revoked_at IS NULL)`,
      ),
    )
    .limit(20);
  for (const source of sources) {
    const o = await commitPendingEndpointReports(db, source);
    total.runs += o.runs;
    total.committed += o.committed;
    total.refused += o.refused;
  }
  return total;
}

export function endpointAgentJobDefinitions(): SchedulerJobDefinition[] {
  return [
    {
      name: ENDPOINT_AGENT_INGEST_JOB_NAME,
      description:
        "Merge the endpoint agent reports accepted since the last pass into the shadow-AI findings: one discovery run per " +
        "enabled endpoint agent source, committed through SD0's fenced path. With no enabled endpoint agent source it does nothing.",
      adr: "ADR-0195",
      defaultIntervalSeconds: 60,
      run: async (ctx) => {
        const out = await runEndpointAgentIngest(ctx.db);
        return { itemsProcessed: out.committed + out.refused, detail: { ...out } };
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const uuidParam = (name: string) => z.object({ [name]: z.string().uuid() });
const issueTokenSchema = z
  .object({
    label: z.string().trim().min(1).max(100),
    // owner decision: the admin must set the cap; there is no unlimited default
    deviceCap: z.number().int().min(1).max(ENDPOINT_TOKEN_MAX_DEVICES),
    expiresInDays: z.number().int().min(1).max(ENDPOINT_TOKEN_MAX_DAYS).default(ENDPOINT_TOKEN_MAX_DAYS),
  })
  .strict();

function tokenView(t: typeof endpointEnrolmentTokens.$inferSelect) {
  return {
    id: t.id,
    sourceId: t.sourceId,
    label: t.label,
    deviceCap: t.deviceCap,
    devicesEnrolled: t.devicesEnrolled,
    createdAt: t.createdAt.toISOString(),
    expiresAt: t.expiresAt.toISOString(),
    revokedAt: t.revokedAt?.toISOString() ?? null,
  };
}

export function registerEndpointAgentRoutes(app: FastifyInstance, db: Db, opts: { dataKey?: string | undefined; registry?: ScannerRegistry } = {}): void {
  const registry = opts.registry ?? DISCOVERY_SCANNERS;

  // ---- the agent's routes: raw bodies (the report digest covers the exact bytes) -------------------------------
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: ENDPOINT_REPORT_MAX_BYTES }, (_req, body, done) => done(null, body));
    scope.setErrorHandler((err: { code?: string; statusCode?: number }, _req, reply) => {
      if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE") return refuse(reply, 413, "report_too_large");
      if (err.code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || err.code === "FST_ERR_CTP_EMPTY_JSON_BODY") return refuse(reply, 415, "invalid_body");
      throw err;
    });

    const deny = async (actorObject: string | null, ruleId: string, code: string, detail: Record<string, unknown> = {}) =>
      audit(db, NIL_UUID, "discovery_source", actorObject, ruleId, "deny", `an endpoint agent request was refused: ${code} (ADR-0195 SD4b)`, { code, ...detail });

    // -- ticket redemption (the package's install step, once per device) ------------------------------------------
    scope.post(ENDPOINT_AGENT_PATHS.tickets, { bodyLimit: ENROL_BODY_LIMIT }, async (req, reply) => {
      const bulk = bearerWithPrefix(req, ENDPOINT_BULK_TOKEN_PREFIX);
      if (!bulk) {
        await deny(null, "endpoint-enrolment-ticket-refused", "invalid_token");
        return refuse(reply, 401, "invalid_token");
      }
      if (!identityIssuer()) return refuse(reply, 503, "issuer_not_configured");
      if (!opts.dataKey) return refuse(reply, 503, "data_key_unavailable");
      const parsed = ticketRequestSchema.safeParse(jsonOf(req.body));
      const [found] = await db
        .select({ token: endpointEnrolmentTokens, source: discoverySources, live: sql<boolean>`${endpointEnrolmentTokens.expiresAt} > now()` })
        .from(endpointEnrolmentTokens)
        .innerJoin(discoverySources, eq(discoverySources.id, endpointEnrolmentTokens.sourceId))
        .where(eq(endpointEnrolmentTokens.tokenHash, hashToken(bulk)));
      if (!found) {
        await deny(null, "endpoint-enrolment-ticket-refused", "invalid_token");
        return refuse(reply, 401, "invalid_token");
      }
      const { token, source } = found;
      const why = { tokenId: token.id };
      if (token.revokedAt) {
        await deny(source.id, "endpoint-enrolment-ticket-refused", "token_revoked", why);
        return refuse(reply, 403, "token_revoked");
      }
      if (!found.live) {
        await deny(source.id, "endpoint-enrolment-ticket-refused", "token_expired", why);
        return refuse(reply, 410, "token_expired");
      }
      if (!source.enabled || source.kind !== "endpoint_agent") {
        await deny(source.id, "endpoint-enrolment-ticket-refused", "enrolment_disabled", why);
        return refuse(reply, 403, "enrolment_disabled");
      }
      if (!parsed.success) {
        await deny(source.id, "endpoint-enrolment-ticket-refused", "invalid_body", why);
        return refuse(reply, 400, "invalid_body");
      }
      const body = parsed.data;
      const device = await derivePseudonym(db, opts.dataKey, "device", body.hostname);
      const ticket = ENDPOINT_TICKET_PREFIX + randomBytes(32).toString("hex");
      const dataKey = opts.dataKey;
      const outcome = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [locked] = await t
          .select({ row: endpointEnrolmentTokens, live: sql<boolean>`${endpointEnrolmentTokens.expiresAt} > now()` })
          .from(endpointEnrolmentTokens)
          .where(eq(endpointEnrolmentTokens.id, token.id))
          .for("update");
        if (!locked || locked.row.revokedAt) return "token_revoked" as const;
        if (!locked.live) return "token_expired" as const;
        if (locked.row.devicesEnrolled >= locked.row.deviceCap) return "enrolment_cap_reached" as const;
        const enrolled = locked.row.devicesEnrolled + 1;
        await t.update(endpointEnrolmentTokens).set({ devicesEnrolled: enrolled }).where(eq(endpointEnrolmentTokens.id, token.id));
        const [row] = await t
          .insert(endpointDevices)
          .values({
            sourceId: source.id,
            tokenId: token.id,
            devicePseudonym: device.pseudonym,
            os: body.os,
            arch: body.arch,
            agentVersion: body.agentVersion,
            ticketHash: hashToken(ticket),
            ticketExpiresAt: sql`now() + make_interval(days => ${ENDPOINT_TICKET_TTL_DAYS})`,
            identityCap: ENDPOINT_TICKET_IDENTITY_CAP,
          })
          .returning();
        await recordPseudonyms(t, dataKey, [device]);
        await audit(t, NIL_UUID, "discovery_source", source.id, "endpoint-enrolment-ticket-issued", "allow", `an endpoint agent device ticket was issued under enrolment token ${token.id} (ADR-0195 SD4b)`, {
          tokenId: token.id,
          deviceId: row!.id,
          devicePseudonym: device.pseudonym,
          os: body.os,
          arch: body.arch,
          devicesEnrolled: enrolled,
          deviceCap: locked.row.deviceCap,
        });
        // R15 cap alerting: crossing 80 % and reaching 100 % of the cap each write their own row
        for (const f of ENDPOINT_CAP_ALERT_FRACTIONS) {
          const at = Math.ceil(locked.row.deviceCap * f);
          if (enrolled === at) {
            await audit(t, NIL_UUID, "discovery_source", source.id, `endpoint-enrolment-cap-${Math.round(f * 100)}`, "allow", `enrolment token ${token.id} reached ${Math.round(f * 100)} % of its device cap (ADR-0195 SD4b)`, {
              tokenId: token.id,
              devicesEnrolled: enrolled,
              deviceCap: locked.row.deviceCap,
            });
          }
        }
        return row!;
      });
      if (typeof outcome === "string") {
        await deny(source.id, "endpoint-enrolment-ticket-refused", outcome, why);
        return refuse(reply, outcome === "enrolment_cap_reached" ? 409 : outcome === "token_expired" ? 410 : 403, outcome);
      }
      return reply.status(201).send({ ticket, ticketId: outcome.id, expiresAt: outcome.ticketExpiresAt.toISOString(), identityCap: outcome.identityCap });
    });

    // -- registration (first run as each user of the device) ------------------------------------------------------
    scope.post(ENDPOINT_AGENT_PATHS.register, { bodyLimit: ENROL_BODY_LIMIT }, async (req, reply) => {
      const ticket = bearerWithPrefix(req, ENDPOINT_TICKET_PREFIX);
      if (!ticket) {
        await deny(null, "endpoint-agent-registration-refused", "invalid_ticket");
        return refuse(reply, 401, "invalid_ticket");
      }
      if (!identityIssuer()) return refuse(reply, 503, "issuer_not_configured");
      if (!opts.dataKey) return refuse(reply, 503, "data_key_unavailable");
      const [found] = await db
        .select({ device: endpointDevices, token: endpointEnrolmentTokens, source: discoverySources, live: sql<boolean>`${endpointDevices.ticketExpiresAt} > now()` })
        .from(endpointDevices)
        .innerJoin(endpointEnrolmentTokens, eq(endpointEnrolmentTokens.id, endpointDevices.tokenId))
        .innerJoin(discoverySources, eq(discoverySources.id, endpointDevices.sourceId))
        .where(eq(endpointDevices.ticketHash, hashToken(ticket)));
      if (!found) {
        await deny(null, "endpoint-agent-registration-refused", "invalid_ticket");
        return refuse(reply, 401, "invalid_ticket");
      }
      const { device, token, source } = found;
      const why = { deviceId: device.id, tokenId: token.id };
      const refusedWith = async (status: number, code: string) => {
        await deny(source.id, "endpoint-agent-registration-refused", code, why);
        return refuse(reply, status, code);
      };
      if (device.revokedAt) return refusedWith(403, "device_revoked");
      if (token.revokedAt) return refusedWith(403, "token_revoked");
      if (!found.live) return refusedWith(410, "ticket_expired");
      if (!source.enabled || source.kind !== "endpoint_agent") return refusedWith(403, "enrolment_disabled");
      const parsed = registerRequestSchema.safeParse(jsonOf(req.body));
      if (!parsed.success) return refusedWith(400, "invalid_body");
      const body = parsed.data;
      if (body.os !== device.os || body.arch !== device.arch) return refusedWith(409, "device_mismatch");
      const now = await databaseNow(db);
      const prepared = await prepareRunnerKey(body.publicJwk as WorkloadPublicJwk, now);
      if (prepared instanceof IdentityAdminError) return refusedWith(400, "invalid_jwk");
      const jkt = await runnerKeyThumbprint(prepared);
      const clientId = `${JWK_THUMBPRINT_URI_PREFIX}${jkt}`;
      // idempotent: the same key re-registered on its own device answers with the identity it already has
      const existing = await keyRegistered(db, jkt);
      if (existing) {
        const [own] = await db
          .select({ identityId: endpointAgentIdentities.identityId })
          .from(endpointAgentIdentities)
          .where(and(eq(endpointAgentIdentities.identityId, existing.identityId), eq(endpointAgentIdentities.deviceId, device.id)));
        if (!own) return refusedWith(409, "credential_already_registered");
        return reply.status(201).send({ identityId: own.identityId, clientId });
      }
      const user = await derivePseudonym(db, opts.dataKey, "device_user", body.deviceUser);
      const dataKey = opts.dataKey;
      const identityId = randomUUID();
      const outcome = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [locked] = await t.select().from(endpointDevices).where(eq(endpointDevices.id, device.id)).for("update");
        if (!locked || locked.revokedAt) return "device_revoked" as const;
        if (locked.identitiesRegistered >= locked.identityCap) return "ticket_exhausted" as const;
        await t.insert(workloadIdentities).values({
          id: identityId,
          kind: "endpoint_agent",
          identifier: defaultWorkloadIdentifier(resolveTrustDomain(), "endpoint_agent", identityId),
          sponsorUserIds: [token.createdBy ?? NIL_UUID],
          environments: [deploymentEnvironment()],
        });
        await audit(t, NIL_UUID, "workload_identity", identityId, "workload-identity-created", "allow", `an endpoint agent identity was created by its registration on device ${device.id}, with no grants (ADR-0195 SD4b)`, {
          phase: "create",
          kind: "endpoint_agent",
          origin: "endpoint_agent_registration",
          deviceId: device.id,
          grants: "none",
        });
        const bound = await bindPreparedCredentialTx(t, identityId, prepared, NIL_UUID, now);
        if (bound instanceof IdentityAdminError) throw bound;
        await t.insert(endpointAgentIdentities).values({
          identityId,
          deviceId: device.id,
          deviceUserPseudonym: user.pseudonym,
          keyProtection: body.keyProtection,
          keyProvider: body.keyProvider,
          agentVersion: body.agentVersion,
        });
        await t.update(endpointDevices).set({ identitiesRegistered: locked.identitiesRegistered + 1 }).where(eq(endpointDevices.id, device.id));
        await recordPseudonyms(t, dataKey, [user]);
        await audit(t, NIL_UUID, "discovery_source", source.id, "endpoint-agent-registered", "allow", `an endpoint agent registered a ${body.keyProtection} device key under device ticket ${device.id} (ADR-0195 SD4b)`, {
          deviceId: device.id,
          tokenId: token.id,
          identityId,
          deviceUserPseudonym: user.pseudonym,
          keyProtection: body.keyProtection,
          keyProvider: body.keyProvider,
          thumbprint: jkt,
        });
        return "ok" as const;
      }).catch((e: unknown) => {
        // two registrations of one new key race: the loser is refused by S6's one-key-one-identity rule
        if (e instanceof IdentityAdminError && e.code === "credential_already_registered") return "credential_already_registered" as const;
        throw e;
      });
      if (outcome !== "ok") return refusedWith(outcome === "device_revoked" ? 403 : 409, outcome);
      return reply.status(201).send({ identityId, clientId });
    });

    // the device of a token route's caller, or the reply already sent
    const agentOf = async (req: FastifyRequest, reply: FastifyReply): Promise<EndpointAgentContext | null> => {
      const identityId = req.authCtx.workloadIdentityId;
      if (req.authCtx.via !== "endpoint-agent" || !identityId || !req.authCtx.workloadCredentialId) {
        await refuse(reply, 401, "endpoint_agent_token_required");
        return null;
      }
      const c = await endpointAgentContext(db, identityId);
      if (!c.ok) {
        await refuse(reply, 401, "device_revoked");
        return null;
      }
      if (!c.ctx.sourceEnabled) {
        await deny(c.ctx.sourceId, "endpoint-agent-request-refused", "source_disabled", { deviceId: c.ctx.deviceId, identityId });
        await refuse(reply, 403, "source_disabled");
        return null;
      }
      return c.ctx;
    };

    // -- config (the signed collection pack) ----------------------------------------------------------------------
    scope.get(ENDPOINT_AGENT_PATHS.config, async (req, reply) => {
      const agent = await agentOf(req, reply);
      if (!agent) return reply;
      // the collection pack is signed under its own key (ADR-0195 SD4 decisions); that key and the signing stage do
      // not exist yet, and an unsigned pack is never served (the agent refuses one anyway)
      return refuse(reply, 503, "collection_pack_unavailable");
    });

    // -- key rotation (ADR-0188 S7 point 4) -----------------------------------------------------------------------
    scope.post(ENDPOINT_AGENT_PATHS.credentials, { bodyLimit: ENROL_BODY_LIMIT }, async (req, reply) => {
      const agent = await agentOf(req, reply);
      if (!agent) return reply;
      const issuer = identityIssuer();
      if (!issuer) return refuse(reply, 503, "issuer_not_configured");
      const refusedWith = async (status: number, code: string) => {
        await deny(agent.sourceId, "endpoint-agent-key-rotation-refused", code, { deviceId: agent.deviceId, identityId: agent.identityId });
        return refuse(reply, status, code);
      };
      const parsed = rotateRequestSchema.safeParse(jsonOf(req.body));
      if (!parsed.success) return refusedWith(400, "invalid_body");
      const now = await databaseNow(db);
      const prepared = await prepareRunnerKey(parsed.data.publicJwk as WorkloadPublicJwk, now);
      if (prepared instanceof IdentityAdminError) return refusedWith(400, "invalid_jwk");
      const newJkt = await runnerKeyThumbprint(prepared);
      if (!(await rotationProofValid(parsed.data.proof, parsed.data.publicJwk as WorkloadPublicJwk, issuer, now, newJkt, ENDPOINT_AGENT_PATHS.credentials))) {
        return refusedWith(401, "rotation_proof_invalid");
      }
      const out = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const rotated = await rotateWorkloadKeyTx(t, agent.identityId, req.authCtx.workloadCredentialId!, prepared, now);
        if (rotated instanceof IdentityAdminError) return rotated;
        await audit(t, NIL_UUID, "workload_identity", agent.identityId, "endpoint-agent-key-rotated", "allow", `an endpoint agent rotated its device key: the old key mints no new token (ADR-0188 decision 12, ADR-0195 SD4b)`, {
          deviceId: agent.deviceId,
          newCredentialId: rotated.bound.id,
          newThumbprint: newJkt,
          retiredCredentialId: rotated.retired?.id ?? null,
        });
        return rotated;
      });
      if (out instanceof IdentityAdminError) return refusedWith(409, out.code);
      return reply.status(201).send({ identityId: agent.identityId, clientId: `${JWK_THUMBPRINT_URI_PREFIX}${newJkt}` });
    });

    // -- reports --------------------------------------------------------------------------------------------------
    scope.post(ENDPOINT_AGENT_PATHS.reports, async (req, reply) => {
      const agent = await agentOf(req, reply);
      if (!agent) return reply;
      const issuer = identityIssuer();
      if (!issuer) return refuse(reply, 503, "issuer_not_configured");
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const bodySha256 = createHash("sha256").update(raw).digest("hex");
      const refusedWith = async (status: number, code: string) => {
        await deny(agent.sourceId, "endpoint-agent-report-refused", code, { deviceId: agent.deviceId, identityId: agent.identityId, bodySha256 });
        return refuse(reply, status, code);
      };
      const parsed = reportSchema.safeParse(jsonOf(req.body));
      if (!parsed.success || !isUuidV4(parsed.data.snapshotId)) return refusedWith(400, "invalid_body");
      const report = parsed.data;
      if (report.os !== agent.os || report.arch !== agent.arch) return refusedWith(409, "device_mismatch");
      const [cred] = await db
        .select({ publicJwk: workloadCredentials.publicJwk, jwkThumbprint: workloadCredentials.jwkThumbprint })
        .from(workloadCredentials)
        .where(and(eq(workloadCredentials.id, req.authCtx.workloadCredentialId!), eq(workloadCredentials.identityId, agent.identityId)));
      if (!cred?.publicJwk || !cred.jwkThumbprint || (cred.publicJwk as Record<string, string>).kty !== "EC") return refusedWith(401, "invalid_token");
      const now = await databaseNow(db);
      const sig = await verifyReportSignature({
        signature: typeof req.headers[ENDPOINT_REPORT_SIGNATURE_HEADER] === "string" ? (req.headers[ENDPOINT_REPORT_SIGNATURE_HEADER] as string) : undefined,
        contentDigestHeader: typeof req.headers[CONTENT_DIGEST_HEADER] === "string" ? (req.headers[CONTENT_DIGEST_HEADER] as string) : undefined,
        rawBody: raw,
        publicJwk: cred.publicJwk as Record<string, string>,
        thumbprint: cred.jwkThumbprint,
        audience: `${issuer}${ENDPOINT_AGENT_PATHS.reports}`,
        snapshotId: report.snapshotId,
        now,
      });
      if (!sig.ok) return refusedWith(400, sig.code);
      // one use per signature (decision 14's replay store, keyed apart from client assertions by its prefix)
      const expires = new Date((sig.iat + ENDPOINT_REPORT_SIGNATURE_MAX_AGE_SECONDS + ENDPOINT_REPORT_SIGNATURE_MAX_FUTURE_SECONDS) * 1000);
      if (!(await claimReplay(db, "client_assertion", `endpoint-report:${cred.jwkThumbprint}:${sig.jti}`, expires))) return refusedWith(400, "report_replayed");
      if (!reportFresh(report.collectedAt, now)) return refusedWith(422, "report_stale");
      const reduction = reduceReportFacts(report, await loadEnabledCatalogue(db));
      const [row] = await db
        .insert(endpointAgentReports)
        .values({
          identityId: agent.identityId,
          deviceId: agent.deviceId,
          sourceId: agent.sourceId,
          snapshotId: report.snapshotId,
          collectedAt: new Date(report.collectedAt),
          bodySha256,
          factsDigest: report.factsDigest,
          manifestVersion: report.manifestVersion,
          manifestDigest: report.manifestDigest,
          factsReceived: report.facts.length,
          factsEnvRefused: reduction.envRefused,
          factsUnmatched: reduction.unmatched,
          droppedSnapshots: report.droppedSnapshots,
          gaps: report.gaps,
          sightings: reduction.sightings,
        })
        .onConflictDoNothing({ target: [endpointAgentReports.identityId, endpointAgentReports.snapshotId] })
        .returning({ id: endpointAgentReports.id });
      if (!row) return reply.status(202).send({ accepted: true, duplicate: true });
      await db.update(endpointDevices).set({ lastReportAt: sql`now()` }).where(eq(endpointDevices.id, agent.deviceId));
      await db.update(endpointAgentIdentities).set({ lastReportAt: sql`now()` }).where(eq(endpointAgentIdentities.identityId, agent.identityId));
      await audit(db, NIL_UUID, "discovery_source", agent.sourceId, "endpoint-agent-report-accepted", "allow", `an endpoint agent report was accepted: ${report.facts.length} fact(s), ${reduction.sightings.length} catalogue sighting(s) (ADR-0195 SD4b)`, {
        deviceId: agent.deviceId,
        identityId: agent.identityId,
        reportId: row.id,
        facts: report.facts.length,
        sightings: reduction.sightings.length,
        envFactsRefused: reduction.envRefused,
        factsUnmatched: reduction.unmatched,
        droppedSnapshots: report.droppedSnapshots,
        bodySha256,
      });
      // merged now when no other run of the source is live; otherwise the ingest job merges it within a minute
      const [source] = await db.select().from(discoverySources).where(eq(discoverySources.id, agent.sourceId));
      if (source) {
        await commitPendingEndpointReports(db, source).catch((e: unknown) => req.log.warn({ code: (e as { code?: string }).code ?? "ingest_error" }, "endpoint report merge deferred to the ingest job"));
      }
      return reply.status(202).send({ accepted: true, duplicate: false });
    });
  });

  // ---- admin routes (admin-only: none is in NON_ADMIN_ROUTES; every write audited) ------------------------------
  const actor = (req: FastifyRequest) => req.authCtx.userId ?? NIL_UUID;
  const agentSource = async (reply: FastifyReply, sourceId: string, mustBeEnabled: boolean): Promise<DiscoverySourceRow | null> => {
    const [source] = await db.select().from(discoverySources).where(eq(discoverySources.id, sourceId));
    if (!source) {
      await reply.status(404).send({ error: "not_found", detail: "no such discovery source" });
      return null;
    }
    if (source.kind !== "endpoint_agent") {
      await reply.status(409).send({ error: "not_an_agent_source", detail: "enrolment tokens and devices belong to an endpoint agent source" });
      return null;
    }
    if (!registry.has(source.kind)) {
      await reply.status(409).send({ error: "scanner_not_built", detail: "no scanner is built for endpoint_agent" });
      return null;
    }
    if (mustBeEnabled && !source.enabled) {
      await reply.status(409).send({ error: "source_disabled", detail: "enable this source first (that asks you to confirm it's you, and is audited)" });
      return null;
    }
    return source;
  };

  app.post("/v1/discovery/sources/:sourceId/enrolment-tokens", async (req, reply) => {
    const p = uuidParam("sourceId").safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "sourceId must be a uuid" });
    const b = issueTokenSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: "send {label, deviceCap (1 to 100000), expiresInDays (1 to 30, default 30)}" });
    const source = await agentSource(reply, p.data.sourceId as string, true);
    if (!source) return reply;
    const issuer = identityIssuer();
    if (!issuer) return reply.status(503).send({ error: "issuer_not_configured", detail: "the gateway's public URL is not configured, so agents could not reach it" });
    const secret = ENDPOINT_BULK_TOKEN_PREFIX + randomBytes(32).toString("hex");
    const [row] = await db
      .insert(endpointEnrolmentTokens)
      .values({
        sourceId: source.id,
        label: b.data.label,
        tokenHash: hashToken(secret),
        deviceCap: b.data.deviceCap,
        createdBy: req.authCtx.userId ?? null,
        expiresAt: sql`now() + make_interval(days => ${b.data.expiresInDays})`,
      })
      .returning();
    await audit(db, actor(req), "discovery_source", source.id, "endpoint-enrolment-token-issued", "allow", `endpoint agent enrolment token '${row!.label}' issued for up to ${row!.deviceCap} device(s) until ${row!.expiresAt.toISOString()} (ADR-0195 SD4b)`, {
      tokenId: row!.id,
      deviceCap: row!.deviceCap,
      expiresAt: row!.expiresAt.toISOString(),
    });
    // the token is shown once, inside the enrolment file MDM delivers to `/etc/regulait-agent/enrol.json` (root, 0600)
    return reply.status(201).send({
      token: tokenView(row!),
      enrolFile: { schema: ENDPOINT_ENROL_FILE_SCHEMA, issuer, token: secret, expiresAt: row!.expiresAt.toISOString() },
    });
  });

  app.get("/v1/discovery/sources/:sourceId/enrolment-tokens", async (req, reply) => {
    const p = uuidParam("sourceId").safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "sourceId must be a uuid" });
    const source = await agentSource(reply, p.data.sourceId as string, false);
    if (!source) return reply;
    const rows = await db.select().from(endpointEnrolmentTokens).where(eq(endpointEnrolmentTokens.sourceId, source.id)).orderBy(desc(endpointEnrolmentTokens.createdAt)).limit(200);
    return reply.send({ tokens: rows.map(tokenView) });
  });

  app.post("/v1/discovery/enrolment-tokens/:tokenId/revoke", async (req, reply) => {
    const p = uuidParam("tokenId").safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "tokenId must be a uuid" });
    const [row] = await db
      .update(endpointEnrolmentTokens)
      .set({ revokedAt: sql`GREATEST(now(), ${endpointEnrolmentTokens.createdAt})`, revokedBy: req.authCtx.userId ?? null })
      .where(and(eq(endpointEnrolmentTokens.id, p.data.tokenId as string), isNull(endpointEnrolmentTokens.revokedAt)))
      .returning();
    if (!row) {
      const [exists] = await db.select({ id: endpointEnrolmentTokens.id }).from(endpointEnrolmentTokens).where(eq(endpointEnrolmentTokens.id, p.data.tokenId as string));
      return reply.status(exists ? 409 : 404).send(exists ? { error: "already_revoked", detail: "this enrolment token is already revoked" } : { error: "not_found", detail: "no such enrolment token" });
    }
    await audit(db, actor(req), "discovery_source", row.sourceId, "endpoint-enrolment-token-revoked", "allow", `endpoint agent enrolment token '${row.label}' revoked: it redeems no ticket and its tickets register no identity (ADR-0195 SD4b)`, {
      tokenId: row.id,
      devicesEnrolled: row.devicesEnrolled,
    });
    return reply.send({ token: tokenView(row) });
  });

  app.get("/v1/discovery/sources/:sourceId/endpoint-devices", async (req, reply) => {
    const p = uuidParam("sourceId").safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "sourceId must be a uuid" });
    const source = await agentSource(reply, p.data.sourceId as string, false);
    if (!source) return reply;
    const devices = await db.select().from(endpointDevices).where(eq(endpointDevices.sourceId, source.id)).orderBy(desc(endpointDevices.createdAt)).limit(DEVICES_LISTED);
    const ids = devices.map((d) => d.id);
    const identities = ids.length
      ? await db
          .select({ link: endpointAgentIdentities, status: workloadIdentities.status })
          .from(endpointAgentIdentities)
          .innerJoin(workloadIdentities, eq(workloadIdentities.id, endpointAgentIdentities.identityId))
          .where(inArray(endpointAgentIdentities.deviceId, ids))
      : [];
    const byDevice = new Map<string, typeof identities>();
    for (const i of identities) byDevice.set(i.link.deviceId, [...(byDevice.get(i.link.deviceId) ?? []), i]);
    return reply.send({
      devices: devices.map((d) => ({
        id: d.id,
        tokenId: d.tokenId,
        devicePseudonym: d.devicePseudonym,
        os: d.os,
        arch: d.arch,
        agentVersion: d.agentVersion,
        createdAt: d.createdAt.toISOString(),
        ticketExpiresAt: d.ticketExpiresAt.toISOString(),
        identitiesRegistered: d.identitiesRegistered,
        identityCap: d.identityCap,
        lastReportAt: d.lastReportAt?.toISOString() ?? null,
        revokedAt: d.revokedAt?.toISOString() ?? null,
        identities: (byDevice.get(d.id) ?? []).map((i) => ({
          identityId: i.link.identityId,
          deviceUserPseudonym: i.link.deviceUserPseudonym,
          keyProtection: i.link.keyProtection,
          keyProvider: i.link.keyProvider,
          agentVersion: i.link.agentVersion,
          registeredAt: i.link.registeredAt.toISOString(),
          lastReportAt: i.link.lastReportAt?.toISOString() ?? null,
          status: i.status,
        })),
      })),
      // posture: software keys are flagged (owner decision d); a device user's name is self-reported by the device
      summary: {
        devices: devices.length,
        revoked: devices.filter((d) => d.revokedAt).length,
        softwareKeys: identities.filter((i) => i.link.keyProtection === "software" && i.status === "active").length,
      },
    });
  });

  app.post("/v1/discovery/endpoint-devices/:deviceId/revoke", async (req, reply) => {
    const p = uuidParam("deviceId").safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "deviceId must be a uuid" });
    const deviceId = p.data.deviceId as string;
    const [device] = await db
      .update(endpointDevices)
      .set({ revokedAt: sql`GREATEST(now(), ${endpointDevices.createdAt})`, revokedBy: req.authCtx.userId ?? null })
      .where(and(eq(endpointDevices.id, deviceId), isNull(endpointDevices.revokedAt)))
      .returning();
    if (!device) {
      const [exists] = await db.select({ id: endpointDevices.id }).from(endpointDevices).where(eq(endpointDevices.id, deviceId));
      return reply.status(exists ? 409 : 404).send(exists ? { error: "already_revoked", detail: "this device is already revoked" } : { error: "not_found", detail: "no such device" });
    }
    // the device is refused from this moment (every agent route and the token endpoint read it); its identities, their
    // keys and live tokens are then revoked on the record (ADR-0188 decision 12), each audited by S6
    const links = await db
      .select({ identityId: endpointAgentIdentities.identityId, status: workloadIdentities.status })
      .from(endpointAgentIdentities)
      .innerJoin(workloadIdentities, eq(workloadIdentities.id, endpointAgentIdentities.identityId))
      .where(eq(endpointAgentIdentities.deviceId, deviceId));
    let identitiesRevoked = 0;
    let tokensRevoked = 0;
    for (const l of links) {
      if (l.status === "revoked") continue;
      const r = await revokeWorkloadIdentity(db, l.identityId, actor(req));
      identitiesRevoked += 1;
      tokensRevoked += r.tokensRevoked;
    }
    await audit(db, actor(req), "discovery_source", device.sourceId, "endpoint-device-revoked", "allow", `endpoint agent device ${device.id} revoked: ${identitiesRevoked} identity(ies) and ${tokensRevoked} token(s) revoked with it; it uploads nothing more (ADR-0195 SD4b)`, {
      deviceId: device.id,
      devicePseudonym: device.devicePseudonym,
      identitiesRevoked,
      tokensRevoked,
    });
    return reply.send({ deviceId: device.id, revokedAt: device.revokedAt!.toISOString(), identitiesRevoked, tokensRevoked });
  });
}
