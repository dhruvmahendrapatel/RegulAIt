/**
 * ADR-0190 decision 4 — THE EXECUTOR CHANNEL (slice I3): the outbound,
 * authenticated stream an executor holds to the gateway, and the executor's
 * own routes beside it. The executor never listens; everything is its own
 * outbound request.
 *
 * AUTHENTICATION. Every channel request carries one `Executor-Proof` header:
 * a compact JWS (`typ` `regulait-executor-proof+jwt`) signed by the
 * executor's REGISTERED ADR-0188 key (a live `jwk` credential of its
 * `worker_runtime` identity, the same key `private_key_jwt` uses), with
 * `iss` = `sub` = the identity's identifier (the OAuth client_id), `aud` =
 * the gateway issuer, `htm`, `htu` (the route's absolute URL, no query),
 * `iat` (60 s window on the DATABASE clock, at most 5 s ahead, as decision
 * 13's DPoP profile), a one-use `jti` (an atomic `replay_claims` claim,
 * namespace `executor_channel`, decision 14) and `bh` = base64url(SHA-256 of
 * the raw request body) binding the body. It is a private_key_jwt client
 * assertion (RFC 7523) carrying DPoP's request binding (RFC 9449): nothing
 * bearer, nothing reusable, nothing that outlives one request. There is no
 * access token on this channel in I3 because ADR-0188 S5's exchange issues
 * tokens only from a human delegation proof; when S7 gives service workloads
 * a token path, the two files that build and check this proof change
 * (`channel-credential.ts` in the executor, `executor-channel-auth.ts` in the
 * gateway) and the contract here gains a token mode. See the I3 amendment to
 * ADR-0190.
 *
 * THE STREAM. `GET /v1/executor-channel/stream` answers newline-delimited
 * JSON for at most `window` seconds (1–60, default 25): `hello` first, then
 * offers and status changes as they happen, keepalives, and `bye`. The
 * executor reconnects at once. Offers are rows (`execution_offers`), so a
 * placement decided on one gateway replica reaches the executor's stream on
 * another.
 */
import { z } from "zod";
import {
  APPLIED_ISOLATION_KINDS,
  EXECUTOR_BACKENDS,
  EXECUTOR_QUARANTINE_CODES,
  EXECUTOR_STATUSES,
  ISOLABLE_WORKLOAD_KINDS,
  REQUIRABLE_ISOLATION_CLASSES,
  REQUIRED_CLASS_SOURCES,
  executionProfileBodySchema,
  type AppliedIsolationKind,
} from "./contract.js";
import { ISOLATION_ENFORCEMENT_MODES } from "./settings.js";
import { REPORT_FAILURE_CODES, signedExecutorReportSchema } from "./attestation.js";

export const EXECUTOR_CHANNEL_PREFIX = "/v1/executor-channel" as const;

/** the executor's routes: authenticated IN-ROUTE by the proof above, reachable by nothing else */
export const EXECUTOR_CHANNEL_ROUTES = [
  `POST ${EXECUTOR_CHANNEL_PREFIX}/announce`,
  `POST ${EXECUTOR_CHANNEL_PREFIX}/self-test`,
  `GET ${EXECUTOR_CHANNEL_PREFIX}/stream`,
  `POST ${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/accept`,
  `POST ${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/decline`,
  `POST ${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/report`,
  `POST ${EXECUTOR_CHANNEL_PREFIX}/offers/:offerId/end`,
] as const;

export const EXECUTOR_PROOF_HEADER = "executor-proof" as const;
export const EXECUTOR_PROOF_TYP = "regulait-executor-proof+jwt" as const;
/** the proof's `iat` window, as decision 13's DPoP profile */
export const EXECUTOR_PROOF_MAX_AGE_SECONDS = 60;
export const EXECUTOR_PROOF_MAX_FUTURE_SECONDS = 5;
/** how long a used `jti` stays claimed (the window plus skew) */
export const EXECUTOR_PROOF_CLAIM_SECONDS = EXECUTOR_PROOF_MAX_AGE_SECONDS + EXECUTOR_PROOF_MAX_FUTURE_SECONDS + 60;
export const EXECUTOR_PROOF_ALGS = ["EdDSA", "ES256"] as const;

/** the stream window bounds (seconds) */
export const EXECUTOR_STREAM_WINDOW = { min: 1, max: 60, default: 25 } as const;
/** an offer not accepted within this many seconds expires (the placement is refused `no_executor`) */
export const EXECUTION_OFFER_TTL_SECONDS = 30;
/** an accepted offer whose report has not arrived within this many seconds expires the same way */
export const EXECUTION_OFFER_REPORT_TTL_SECONDS = 120;

/** the one signal the executor's state machine acts on (as ADR-0187's `next`) */
export const EXECUTOR_NEXT = ["ok", "quarantined", "revoked", "reannounce_required"] as const;
export type ExecutorNext = (typeof EXECUTOR_NEXT)[number];

// ---------------------------------------------------------------------------
// Offers
// ---------------------------------------------------------------------------

export const EXECUTION_OFFER_STATUSES = [
  "offered",
  "accepted",
  "placed",
  "mismatch",
  "declined",
  "expired",
  "withdrawn",
  "ended",
] as const;
export type ExecutionOfferStatus = (typeof EXECUTION_OFFER_STATUSES)[number];

export const EXECUTION_OFFER_DECLINE_REASONS = ["attestation_stale", "class_below_required", "capacity", "quarantined", "profile_unknown"] as const;
export const EXECUTION_OFFER_END_OUTCOMES = ["completed", "failed", "killed", "limit_exceeded"] as const;

/** an offer as the stream carries it */
export const executionOfferSchema = z
  .object({
    id: z.string().uuid(),
    workloadKind: z.enum(ISOLABLE_WORKLOAD_KINDS),
    requiredClass: z.enum(REQUIRABLE_ISOLATION_CLASSES),
    requiredBy: z.enum(REQUIRED_CLASS_SOURCES),
    enforcement: z.enum(ISOLATION_ENFORCEMENT_MODES),
    profileDigest: z.string().regex(/^[0-9a-f]{64}$/),
    imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    /** ISO time on the database clock */
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ExecutionOffer = z.infer<typeof executionOfferSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** POST /announce: the executor says what it is; the admin's registration (POST /v1/executors) must agree */
export const executorAnnounceSchema = z
  .object({
    backend: z.enum(EXECUTOR_BACKENDS),
    runtimeVersion: z.string().min(1).max(128).regex(/^[A-Za-z0-9._+-]+$/),
    classesDeclared: z.array(z.enum(APPLIED_ISOLATION_KINDS)).min(1).max(APPLIED_ISOLATION_KINDS.length),
  })
  .strict();
export type ExecutorAnnounce = z.infer<typeof executorAnnounceSchema>;

/** POST /self-test: one signed report per (profile, class) tested; at most one per live profile per call */
export const executorSelfTestSchema = z.object({ reports: z.array(signedExecutorReportSchema).min(1).max(64) }).strict();

export const executorDeclineSchema = z.object({ reason: z.enum(EXECUTION_OFFER_DECLINE_REASONS) }).strict();
export const executorPlacementReportSchema = z.object({ report: signedExecutorReportSchema }).strict();
export const executorEndSchema = z.object({ outcome: z.enum(EXECUTION_OFFER_END_OUTCOMES) }).strict();

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/**
 * a live profile as the executor receives it: the BODY travels with the
 * digest (the executor starts sandboxes from the body and refuses one whose
 * digest it does not recompute, fail closed)
 */
const profileRef = z
  .object({
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    name: z.string(),
    version: z.number().int().min(1),
    minClass: z.enum(REQUIRABLE_ISOLATION_CLASSES),
    body: executionProfileBodySchema,
  })
  .strict();
export type ExecutorProfileRef = z.infer<typeof profileRef>;

const executorView = z
  .object({
    executorId: z.string().uuid(),
    name: z.string(),
    backend: z.enum(EXECUTOR_BACKENDS),
    classesDeclared: z.array(z.enum(APPLIED_ISOLATION_KINDS)),
    status: z.enum(EXECUTOR_STATUSES),
    quarantineCode: z.enum(EXECUTOR_QUARANTINE_CODES).nullable(),
  })
  .strict();
export type ExecutorView = z.infer<typeof executorView>;

/** POST /announce → 200 */
export const executorAnnounceResponseSchema = z
  .object({
    executor: executorView,
    /** the live profiles the executor self-tests (every one whose minClass it declares to reach) */
    profiles: z.array(profileRef),
    /** the org's attestation freshness ceiling (minutes) */
    attestationMaxAgeMinutes: z.number().int().min(1),
    next: z.enum(EXECUTOR_NEXT),
  })
  .strict();
export type ExecutorAnnounceResponse = z.infer<typeof executorAnnounceResponseSchema>;

export const executorSelfTestResultSchema = z
  .object({
    profileDigest: z.string(),
    class: z.enum(APPLIED_ISOLATION_KINDS),
    verdict: z.enum(["pass", "fail"]),
    failures: z.array(z.object({ probe: z.string(), code: z.enum(REPORT_FAILURE_CODES) }).strict()),
    /** ISO, database clock; null on a failed verdict */
    expiresAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
/** POST /self-test → 200 */
export const executorSelfTestResponseSchema = z.object({ results: z.array(executorSelfTestResultSchema), next: z.enum(EXECUTOR_NEXT) }).strict();
export type ExecutorSelfTestResponse = z.infer<typeof executorSelfTestResponseSchema>;

/** POST /offers/:id/accept → 200 (the offer is now this executor's to report on) */
export const executorAcceptResponseSchema = z.object({ offer: executionOfferSchema, next: z.enum(EXECUTOR_NEXT) }).strict();
/** POST /offers/:id/report → 200: the gateway verified the report; the workload's input may be released */
export const executorReportResponseSchema = z
  .object({
    release: z.literal(true),
    placementId: z.string().uuid(),
    reportSha256: z.string().regex(/^[0-9a-f]{64}$/),
    next: z.enum(EXECUTOR_NEXT),
  })
  .strict();
export type ExecutorReportResponse = z.infer<typeof executorReportResponseSchema>;

/** every refusal of a channel route (a code, the signal, never secret material) */
export const executorRefusalSchema = z
  .object({
    error: z.string(),
    next: z.enum(EXECUTOR_NEXT).optional(),
    failures: z.array(z.object({ probe: z.string(), code: z.enum(REPORT_FAILURE_CODES) }).strict()).optional(),
    detail: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Stream messages (NDJSON)
// ---------------------------------------------------------------------------

export const executorStreamMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), executor: executorView, profiles: z.array(profileRef), attestationMaxAgeMinutes: z.number().int() }).strict(),
  z.object({ type: z.literal("offer"), offer: executionOfferSchema }).strict(),
  /** the executor's status changed (an admin quarantined, re-enabled or revoked it; a mismatch quarantined it) */
  z.object({ type: z.literal("status"), status: z.enum(EXECUTOR_STATUSES), quarantineCode: z.enum(EXECUTOR_QUARANTINE_CODES).nullable() }).strict(),
  z.object({ type: z.literal("keepalive") }).strict(),
  z.object({ type: z.literal("bye"), reason: z.enum(["window", "revoked", "shutdown"]) }).strict(),
]);
export type ExecutorStreamMessage = z.infer<typeof executorStreamMessageSchema>;

/** the classes an executor may be offered work at, from what it declares (customer planes are mapped by an admin) */
export function offerableClasses(classesDeclared: readonly AppliedIsolationKind[]): AppliedIsolationKind[] {
  return [...classesDeclared];
}
