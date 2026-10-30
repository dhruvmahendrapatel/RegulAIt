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
 *   POST /v1/discovery/sources/:sourceId/enrolment-tokens     admin: issue (capped, 30 days at most; up to 90 only
 *                                                             with a `settings_relax` step-up, ADR-0197 Q13; shown once)
 *   GET  /v1/discovery/sources/:sourceId/enrolment-tokens     admin: list (never the token)
 *   POST /v1/discovery/enrolment-tokens/:tokenId/revoke       admin: no new tickets, no new registrations;
 *                                                             `{revokeDevices: true}` also revokes the devices it
 *                                                             enrolled, in the same transaction (ADR-0197 Q14)
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
  filterParams,
  parseListExport,
  parseListPage,
  runListPage,
  sendListError,
  sendListExport,
  wantsListContract,
  type ListReader,
  type ListSpec,
} from "./list-contract.js";
import { sql as sqlL, type SQL as SQLL } from "@regulait/db";
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
  ENDPOINT_TOKEN_RELAXED_MAX_DAYS,
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
import { requireStepUp, type StepUpCheckArgs } from "./step-up.js";
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
    // ADR-0197 Q13: past ENDPOINT_TOKEN_MAX_DAYS (the default) only with a step-up, never past the relaxed cap
    expiresInDays: z.number().int().min(1).max(ENDPOINT_TOKEN_RELAXED_MAX_DAYS).default(ENDPOINT_TOKEN_MAX_DAYS),
  })
  .strict();

/** ADR-0197 Q14: revoking a token stops new enrolments; revoking the devices it enrolled is a separate, explicit choice */
const revokeTokenSchema = z.object({ revokeDevices: z.boolean().default(false) }).strict();

/**
 * ADR-0197 Q13: an enrolment token that lives longer than 30 days is a relaxation of that one token, bound to
 * everything the token is issued with (so the grant cannot issue a different token).
 */
export const enrolmentTokenLongExpiryStepUp = (input: { sourceId: string; label: string; deviceCap: number; expiresInDays: number }): StepUpCheckArgs => ({
  kind: "settings_relax",
  facts: { op: "endpoint_enrolment_token_long_expiry", sourceId: input.sourceId, label: input.label, deviceCap: input.deviceCap, expiresInDays: input.expiresInDays },
});

// ---- ADR-0219: a source's enrolment tokens and endpoint devices under the shared list contract. A token's secret
// (and its hash) is never in the row, the page or the file; a device's ticket hash never is either.
type TokenListRow = ReturnType<typeof tokenView> & { devicesActive: number };
const TOKEN_ACTIVE_DEVICES = sqlL<number>`(select count(*)::int from ${endpointDevices} where ${endpointDevices.tokenId} = ${endpointEnrolmentTokens.id} and ${endpointDevices.revokedAt} is null)`;
const TOKEN_STATE = sqlL`case when ${endpointEnrolmentTokens.revokedAt} is not null then 3 when ${endpointEnrolmentTokens.expiresAt} <= now() then 2 else 1 end`;
const tokenState = (t: TokenListRow) => (t.revokedAt ? "revoked" : new Date(t.expiresAt).getTime() <= Date.now() ? "expired" : "active");
export const ENROLMENT_TOKENS_LIST: ListSpec<TokenListRow> = {
  id: "enrolment-tokens",
  sorts: {
    label: { expr: sqlL`lower(${endpointEnrolmentTokens.label})` },
    state: { expr: TOKEN_STATE },
    devices: { expr: endpointEnrolmentTokens.devicesEnrolled },
    active: { expr: TOKEN_ACTIVE_DEVICES },
    created: { expr: endpointEnrolmentTokens.createdAt, keysetAt: endpointEnrolmentTokens.createdAt },
    expires: { expr: endpointEnrolmentTokens.expiresAt, keysetAt: endpointEnrolmentTokens.expiresAt },
  },
  columns: {
    label: { label: "Label", value: (r) => r.label },
    state: { label: "State", value: (r) => `${tokenState(r)}${r.expiryRelaxed ? ", expiry relaxed" : ""}` },
    devices: { label: "Devices enrolled", value: (r) => `${r.devicesEnrolled} of ${r.deviceCap}` },
    active: { label: "Devices active", value: (r) => r.devicesActive },
    created: { label: "Created", value: (r) => new Date(r.createdAt) },
    expires: { label: "Expires", value: (r) => new Date(r.expiresAt) },
  },
  filters: [],
  defaultSort: { col: "created", dir: "desc" },
  idCol: endpointEnrolmentTokens.id,
};
type DeviceListRow = {
  id: string;
  tokenId: string | null;
  devicePseudonym: string;
  os: string;
  arch: string;
  agentVersion: string;
  createdAt: string;
  ticketExpiresAt: string;
  identitiesRegistered: number;
  identityCap: number;
  lastReportAt: string | null;
  revokedAt: string | null;
  identities: Array<{ keyProtection: string; status: string } & Record<string, unknown>>;
};
export const ENDPOINT_DEVICES_LIST: ListSpec<DeviceListRow> = {
  id: "endpoint-devices",
  sorts: {
    device: { expr: endpointDevices.devicePseudonym },
    platform: { expr: sqlL`${endpointDevices.os} || '/' || ${endpointDevices.arch}` },
    version: { expr: endpointDevices.agentVersion },
    identities: { expr: endpointDevices.identitiesRegistered },
    last: { expr: endpointDevices.lastReportAt },
    state: { expr: sqlL`(${endpointDevices.revokedAt} is not null)` },
    created: { expr: endpointDevices.createdAt, keysetAt: endpointDevices.createdAt },
  },
  columns: {
    device: { label: "Device", value: (r) => r.devicePseudonym },
    platform: { label: "Platform", value: (r) => `${r.os}/${r.arch}, agent ${r.agentVersion}` },
    version: { label: "Agent version", value: (r) => r.agentVersion },
    identities: { label: "Identities", value: (r) => `${r.identitiesRegistered} of ${r.identityCap}` },
    users: {
      label: "Users (self-reported)",
      value: (r) => (r.identities.length ? r.identities.map((i) => `${String(i.deviceUserPseudonym)} (${i.keyProtection} key)`).join("; ") : "none registered"),
    },
    last: { label: "Last report", value: (r) => (r.lastReportAt ? new Date(r.lastReportAt) : null) },
    state: { label: "State", value: (r) => (r.revokedAt ? "revoked" : "active") },
    created: { label: "Enrolled", value: (r) => new Date(r.createdAt) },
  },
  filters: [],
  defaultSort: { col: "created", dir: "desc" },
  idCol: endpointDevices.id,
};

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
    /** ADR-0197 Q13: true when an admin relaxed the 30-day expiry for this token (step-up, audited) */
    expiryRelaxed: t.expiryRelaxationStepUp !== null,
  };
}

/**
 * Revoke one device in the caller's transaction: the device row, its identities (their keys and live tokens,
 * ADR-0188 decision 12, each audited by S6) and the device audit row. Null when it was already revoked or is gone.
 */
async function revokeDeviceTx(t: Db, deviceId: string, actorId: string, revokedBy: string | null, cause: Record<string, unknown> = {}) {
  const [device] = await t
    .update(endpointDevices)
    .set({ revokedAt: sql`GREATEST(now(), ${endpointDevices.createdAt})`, revokedBy })
    .where(and(eq(endpointDevices.id, deviceId), isNull(endpointDevices.revokedAt)))
    .returning();
  if (!device) return null;
  const links = await t
    .select({ identityId: endpointAgentIdentities.identityId, status: workloadIdentities.status })
    .from(endpointAgentIdentities)
    .innerJoin(workloadIdentities, eq(workloadIdentities.id, endpointAgentIdentities.identityId))
    .where(eq(endpointAgentIdentities.deviceId, deviceId));
  let identitiesRevoked = 0;
  let tokensRevoked = 0;
  for (const l of links) {
    if (l.status === "revoked") continue;
    const r = await revokeWorkloadIdentity(t, l.identityId, actorId);
    identitiesRevoked += 1;
    tokensRevoked += r.tokensRevoked;
  }
  await audit(t, actorId, "discovery_source", device.sourceId, "endpoint-device-revoked", "allow", `endpoint agent device ${device.id} revoked: ${identitiesRevoked} identity(ies) and ${tokensRevoked} token(s) revoked with it; it uploads nothing more (ADR-0195 SD4b)`, {
    deviceId: device.id,
    devicePseudonym: device.devicePseudonym,
    identitiesRevoked,
    tokensRevoked,
    ...cause,
  });
  return { device, identitiesRevoked, tokensRevoked };
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
        // incremented in SQL, so the enrolled <= cap CHECK is a backstop behind the row lock
        const [bumped] = await t
          .update(endpointEnrolmentTokens)
          .set({ devicesEnrolled: sql`${endpointEnrolmentTokens.devicesEnrolled} + 1` })
          .where(eq(endpointEnrolmentTokens.id, token.id))
          .returning({ devicesEnrolled: endpointEnrolmentTokens.devicesEnrolled });
        const enrolled = bumped!.devicesEnrolled;
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
        await t
          .update(endpointDevices)
          .set({ identitiesRegistered: sql`${endpointDevices.identitiesRegistered} + 1` })
          .where(eq(endpointDevices.id, device.id));
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
    if (!b.success) {
      return reply.status(400).send({
        error: "invalid_request",
        detail: `send {label, deviceCap (1 to 100000), expiresInDays (1 to ${ENDPOINT_TOKEN_MAX_DAYS}, default ${ENDPOINT_TOKEN_MAX_DAYS}; up to ${ENDPOINT_TOKEN_RELAXED_MAX_DAYS} asks you to confirm it's you and is audited)}`,
      });
    }
    const source = await agentSource(reply, p.data.sourceId as string, true);
    if (!source) return reply;
    const issuer = identityIssuer();
    if (!issuer) return reply.status(503).send({ error: "issuer_not_configured", detail: "the gateway's public URL is not configured, so agents could not reach it" });
    // ADR-0197 Q13: past 30 days is a relaxation of this token: a fresh step-up bound to what is issued (ADR-0180)
    const relaxed = b.data.expiresInDays > ENDPOINT_TOKEN_MAX_DAYS;
    const su = relaxed ? await requireStepUp(db, req, reply, enrolmentTokenLongExpiryStepUp({ sourceId: source.id, label: b.data.label, deviceCap: b.data.deviceCap, expiresInDays: b.data.expiresInDays })) : null;
    if (su && !su.ok) return reply;
    const secret = ENDPOINT_BULK_TOKEN_PREFIX + randomBytes(32).toString("hex");
    const row = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const tokenId = randomUUID();
      let relaxation: { expiryRelaxedBy: string | null; expiryRelaxationStepUp: string; expiryRelaxationAuditId: string } | null = null;
      if (su?.ok) {
        // the relaxation's audit row is written first, so the token row can name it (0208's CHECK needs it past 30 days)
        const auditId = randomUUID();
        await t.insert(auditLog).values({
          id: auditId,
          userId: actor(req),
          objectType: "discovery_source",
          objectId: source.id,
          detail: { subsystem: "shadow-ai-discovery", slice: "SD4b", tokenId, expiresInDays: b.data.expiresInDays, defaultDays: ENDPOINT_TOKEN_MAX_DAYS, maxDays: ENDPOINT_TOKEN_RELAXED_MAX_DAYS, relaxation: true, stepUp: su.method },
          effect: "allow",
          ruleId: "endpoint-enrolment-token-expiry-relaxed",
          ruleChain: [],
          reason: `endpoint agent enrolment token '${b.data.label}' may live ${b.data.expiresInDays} days instead of at most ${ENDPOINT_TOKEN_MAX_DAYS} (step-up ${su.method}) (ADR-0197 Q13)`,
        });
        relaxation = { expiryRelaxedBy: req.authCtx.userId ?? null, expiryRelaxationStepUp: su.method, expiryRelaxationAuditId: auditId };
      }
      const [inserted] = await t
        .insert(endpointEnrolmentTokens)
        .values({
          id: tokenId,
          sourceId: source.id,
          label: b.data.label,
          tokenHash: hashToken(secret),
          deviceCap: b.data.deviceCap,
          createdBy: req.authCtx.userId ?? null,
          expiresAt: sql`now() + make_interval(days => ${b.data.expiresInDays})`,
          ...(relaxation ?? {}),
        })
        .returning();
      await audit(t, actor(req), "discovery_source", source.id, "endpoint-enrolment-token-issued", "allow", `endpoint agent enrolment token '${inserted!.label}' issued for up to ${inserted!.deviceCap} device(s) until ${inserted!.expiresAt.toISOString()} (ADR-0195 SD4b)`, {
        tokenId: inserted!.id,
        deviceCap: inserted!.deviceCap,
        expiresAt: inserted!.expiresAt.toISOString(),
        expiryRelaxed: relaxation !== null,
      });
      return inserted!;
    });
    // the token is shown once, inside the enrolment file MDM delivers to `/etc/regulait-agent/enrol.json` (root, 0600)
    return reply.status(201).send({
      token: tokenView(row),
      enrolFile: { schema: ENDPOINT_ENROL_FILE_SCHEMA, issuer, token: secret, expiresAt: row.expiresAt.toISOString() },
    });
  });

  const tokensReader: ListReader<TokenListRow> = {
    fetch: async (q) => {
      const rows = await db
        .select({ t: endpointEnrolmentTokens, devicesActive: TOKEN_ACTIVE_DEVICES, _cursorAt: q.cursorAt })
        .from(endpointEnrolmentTokens)
        .where(q.where)
        .orderBy(...q.orderBy)
        .limit(q.limit)
        .offset(q.offset);
      return rows.map((r) => ({ ...tokenView(r.t), devicesActive: Number(r.devicesActive), _cursorAt: r._cursorAt }));
    },
    countable: (where) => db.select({ one: sqlL`1` }).from(endpointEnrolmentTokens).where(where),
    idOf: (r) => r.id,
  };
  const devicesReader: ListReader<DeviceListRow> = {
    fetch: async (q) => {
      const rows = await db
        .select({ d: endpointDevices, _cursorAt: q.cursorAt })
        .from(endpointDevices)
        .where(q.where)
        .orderBy(...q.orderBy)
        .limit(q.limit)
        .offset(q.offset);
      const views = await devicesView(rows.map((r) => r.d));
      return views.map((v, i) => ({ ...v, _cursorAt: rows[i]!._cursorAt }));
    },
    countable: (where) => db.select({ one: sqlL`1` }).from(endpointDevices).where(where),
    idOf: (r) => r.id,
  };
  /** each device with its identities and their key protection and status (never a key or a ticket) */
  const devicesView = async (devices: Array<typeof endpointDevices.$inferSelect>) => {
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
    return devices.map((d) => ({
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
    }));
  };
  /** the source the route names, or the reply already sent (400 or the source's own refusal) */
  const listSource = async (req: FastifyRequest, reply: FastifyReply) => {
    const p = uuidParam("sourceId").safeParse(req.params);
    if (!p.success) {
      void reply.status(400).send({ error: "invalid_request", detail: "sourceId must be a uuid" });
      return null;
    }
    return agentSource(reply, p.data.sourceId as string, false);
  };
  // ADR-0219: with any of sort/dir/cursor/offset/count each list answers the shared list contract; admin only
  app.get("/v1/discovery/sources/:sourceId/enrolment-tokens/export.xlsx", async (req, reply) => {
    try {
      const source = await listSource(req, reply);
      if (!source) return reply;
      const q = req.query as Record<string, unknown>;
      z.object({}).strict().parse(filterParams(q));
      const ex = parseListExport(ENROLMENT_TOKENS_LIST, q);
      await sendListExport(db, req, reply, ENROLMENT_TOKENS_LIST, tokensReader, eq(endpointEnrolmentTokens.sourceId, source.id), ex, { sourceId: source.id });
      return reply;
    } catch (e) {
      return sendListError(reply, e);
    }
  });
  app.get("/v1/discovery/sources/:sourceId/endpoint-devices/export.xlsx", async (req, reply) => {
    try {
      const source = await listSource(req, reply);
      if (!source) return reply;
      const q = req.query as Record<string, unknown>;
      z.object({}).strict().parse(filterParams(q));
      const ex = parseListExport(ENDPOINT_DEVICES_LIST, q);
      await sendListExport(db, req, reply, ENDPOINT_DEVICES_LIST, devicesReader, eq(endpointDevices.sourceId, source.id), ex, { sourceId: source.id });
      return reply;
    } catch (e) {
      return sendListError(reply, e);
    }
  });

  app.get("/v1/discovery/sources/:sourceId/enrolment-tokens", async (req, reply) => {
    const p = uuidParam("sourceId").safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "sourceId must be a uuid" });
    const source = await agentSource(reply, p.data.sourceId as string, false);
    if (!source) return reply;
    if (wantsListContract(req.query)) {
      try {
        const q = req.query as Record<string, unknown>;
        z.object({}).strict().parse(filterParams(q));
        const page = parseListPage(ENROLMENT_TOKENS_LIST, q);
        const where = eq(endpointEnrolmentTokens.sourceId, source.id);
        const [out, [sum]] = await Promise.all([
          runListPage(db, ENROLMENT_TOKENS_LIST, tokensReader, where, page),
          // P3: the state figures across every token of the source, so a preview's heading counts what needs attention
          db
            .select({
              tokens: sqlL<number>`count(*)::int`,
              revoked: sqlL<number>`count(*) filter (where ${endpointEnrolmentTokens.revokedAt} is not null)::int`,
              expired: sqlL<number>`count(*) filter (where ${endpointEnrolmentTokens.revokedAt} is null and ${endpointEnrolmentTokens.expiresAt} <= now())::int`,
            })
            .from(endpointEnrolmentTokens)
            .where(where),
        ]);
        return reply.send({ ...out, summary: { tokens: Number(sum?.tokens ?? 0), expired: Number(sum?.expired ?? 0), revoked: Number(sum?.revoked ?? 0) } });
      } catch (e) {
        return sendListError(reply, e);
      }
    }
    const rows = await db.select().from(endpointEnrolmentTokens).where(eq(endpointEnrolmentTokens.sourceId, source.id)).orderBy(desc(endpointEnrolmentTokens.createdAt)).limit(200);
    // ADR-0197 Q14: how many devices each token enrolled are still unrevoked (what "also revoke its devices" revokes)
    const active = rows.length
      ? await db
          .select({ tokenId: endpointDevices.tokenId, n: sql<number>`count(*)::int` })
          .from(endpointDevices)
          .where(and(inArray(endpointDevices.tokenId, rows.map((r) => r.id)), isNull(endpointDevices.revokedAt)))
          .groupBy(endpointDevices.tokenId)
      : [];
    const activeBy = new Map(active.map((a) => [a.tokenId, Number(a.n)]));
    return reply.send({ tokens: rows.map((r) => ({ ...tokenView(r), devicesActive: activeBy.get(r.id) ?? 0 })) });
  });

  app.post("/v1/discovery/enrolment-tokens/:tokenId/revoke", async (req, reply) => {
    const p = uuidParam("tokenId").safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "tokenId must be a uuid" });
    const b = revokeTokenSchema.safeParse(req.body ?? {});
    if (!b.success) return reply.status(400).send({ error: "invalid_request", detail: "send {revokeDevices?: boolean} (default false: the devices it enrolled keep reporting)" });
    const tokenId = p.data.tokenId as string;
    // ADR-0197 Q14: one transaction. The token, and (only when asked) every device it enrolled that is not revoked yet,
    // with their identities, keys and tokens, commit together with their audit rows, or nothing does.
    const done = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const [row] = await t
        .update(endpointEnrolmentTokens)
        .set({ revokedAt: sql`GREATEST(now(), ${endpointEnrolmentTokens.createdAt})`, revokedBy: req.authCtx.userId ?? null })
        .where(and(eq(endpointEnrolmentTokens.id, tokenId), isNull(endpointEnrolmentTokens.revokedAt)))
        .returning();
      if (!row) return null;
      let devicesRevoked = 0;
      let identitiesRevoked = 0;
      let tokensRevoked = 0;
      if (b.data.revokeDevices) {
        const live = await t
          .select({ id: endpointDevices.id })
          .from(endpointDevices)
          .where(and(eq(endpointDevices.tokenId, row.id), isNull(endpointDevices.revokedAt)))
          .orderBy(asc(endpointDevices.createdAt));
        for (const d of live) {
          const r = await revokeDeviceTx(t, d.id, actor(req), req.authCtx.userId ?? null, { cause: "enrolment_token_revoked", tokenId: row.id });
          if (!r) continue;
          devicesRevoked += 1;
          identitiesRevoked += r.identitiesRevoked;
          tokensRevoked += r.tokensRevoked;
        }
      }
      await audit(
        t,
        actor(req),
        "discovery_source",
        row.sourceId,
        "endpoint-enrolment-token-revoked",
        "allow",
        b.data.revokeDevices
          ? `endpoint agent enrolment token '${row.label}' revoked with the ${devicesRevoked} device(s) it enrolled that were not revoked yet: it redeems no ticket and those devices upload nothing more (ADR-0195 SD4b; ADR-0197 Q14)`
          : `endpoint agent enrolment token '${row.label}' revoked: it redeems no ticket and its tickets register no identity; the devices it enrolled keep reporting (ADR-0195 SD4b; ADR-0197 Q14)`,
        { tokenId: row.id, devicesEnrolled: row.devicesEnrolled, revokeDevices: b.data.revokeDevices, devicesRevoked, identitiesRevoked, tokensRevoked },
      );
      return { row, devicesRevoked, identitiesRevoked, tokensRevoked };
    });
    if (!done) {
      const [exists] = await db.select({ id: endpointEnrolmentTokens.id }).from(endpointEnrolmentTokens).where(eq(endpointEnrolmentTokens.id, tokenId));
      return reply.status(exists ? 409 : 404).send(exists ? { error: "already_revoked", detail: "this enrolment token is already revoked" } : { error: "not_found", detail: "no such enrolment token" });
    }
    return reply.send({ token: tokenView(done.row), devicesRevoked: done.devicesRevoked, identitiesRevoked: done.identitiesRevoked, tokensRevoked: done.tokensRevoked });
  });

  app.get("/v1/discovery/sources/:sourceId/endpoint-devices", async (req, reply) => {
    const p = uuidParam("sourceId").safeParse(req.params);
    if (!p.success) return reply.status(400).send({ error: "invalid_request", detail: "sourceId must be a uuid" });
    const source = await agentSource(reply, p.data.sourceId as string, false);
    if (!source) return reply;
    if (wantsListContract(req.query)) {
      try {
        const q = req.query as Record<string, unknown>;
        z.object({}).strict().parse(filterParams(q));
        const page = parseListPage(ENDPOINT_DEVICES_LIST, q);
        const where = eq(endpointDevices.sourceId, source.id);
        const [out, [sum]] = await Promise.all([
          runListPage(db, ENDPOINT_DEVICES_LIST, devicesReader, where, page),
          // the posture figures across every device of the source, not the page on screen
          db
            .select({
              devices: sqlL<number>`count(*)::int`,
              revoked: sqlL<number>`count(*) filter (where ${endpointDevices.revokedAt} is not null)::int`,
              softwareKeys: sqlL<number>`(select count(*)::int from ${endpointAgentIdentities} join ${workloadIdentities} on ${workloadIdentities.id} = ${endpointAgentIdentities.identityId} join ${endpointDevices} d2 on d2.id = ${endpointAgentIdentities.deviceId} where d2.source_id = ${source.id} and ${endpointAgentIdentities.keyProtection} = 'software' and ${workloadIdentities.status} = 'active')`,
            })
            .from(endpointDevices)
            .where(where),
        ]);
        return reply.send({ ...out, summary: { devices: Number(sum?.devices ?? 0), revoked: Number(sum?.revoked ?? 0), softwareKeys: Number(sum?.softwareKeys ?? 0) } });
      } catch (e) {
        return sendListError(reply, e);
      }
    }
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
    // one transaction: the device, its identities (their keys and live tokens, ADR-0188 decision 12, each audited by
    // S6) and the device audit row commit together, so a crash midway leaves no identity showing as active. The device
    // is refused from the commit on (every agent route and the token endpoint read it).
    const done = await db.transaction(async (tx) => revokeDeviceTx(tx as unknown as Db, deviceId, actor(req), req.authCtx.userId ?? null));
    if (!done) {
      const [exists] = await db.select({ id: endpointDevices.id }).from(endpointDevices).where(eq(endpointDevices.id, deviceId));
      return reply.status(exists ? 409 : 404).send(exists ? { error: "already_revoked", detail: "this device is already revoked" } : { error: "not_found", detail: "no such device" });
    }
    const { device, identitiesRevoked, tokensRevoked } = done;
    return reply.send({ deviceId: device.id, revokedAt: device.revokedAt!.toISOString(), identitiesRevoked, tokensRevoked });
  });
}
