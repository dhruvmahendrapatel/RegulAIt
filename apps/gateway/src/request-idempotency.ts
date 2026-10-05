/**
 * ADR-0179 / AER-050 — THE `Idempotency-Key` HEADER for the intake's writes.
 *
 * POST /v1/use-cases claims its key in its own table (use-cases.ts, migration
 * 0134). The intake's later writes — a risk (POST /v1/risks) and the
 * questionnaire artifact (POST /v1/workflows/instances/:id/artifacts) — claim
 * theirs in `request_idempotency_keys` (migration 0153) through this module,
 * with the same rules:
 *
 *   - the key is optional; a request without one behaves as before;
 *   - the claim is INSERTED INSIDE the transaction that writes the record, so
 *     the claim and the record commit together or not at all, and a
 *     concurrent duplicate waits on the unique (user, scope, key) index and
 *     then replays instead of writing a second record;
 *   - a retry with the same key gets the original response back (the route
 *     answers 200 with `Idempotent-Replay: true`) for 30 days, the lifetime of
 *     the intake draft that carries the key — rebuilt from the record the
 *     request wrote, since the claim keeps only a reference to it (below);
 *     the `idempotency-key-sweep` scheduler job deletes claims after that;
 *   - keys are per caller and per scope (the route and its target).
 *
 * One rule more than the use-case create: the key is bound to the request it
 * was first used with (`request_digest`). The same key with a different
 * request is refused (422 `idempotency_key_reused`) rather than answered with
 * a record the caller did not ask for.
 *
 * Open source considered: a maintained, MIT-licensed Fastify idempotency
 * plugin with a Postgres adapter. It stores the claim and the cached response through its own
 * connection, outside the route's transaction, so a crash or rollback between
 * the two leaves the key and the record disagreeing. The claim has to commit
 * in the same transaction as the record, which is what ADR-0171 already does
 * for the use-case create; this module is that pattern, shared.
 */
import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { and, eq, inArray, lt, requestIdempotencyKeys, useCaseIdempotencyKeys, type Db } from "@regulait/db";

/** how long a claimed key replays its original response: the intake draft's lifetime (30 days) */
export const IDEMPOTENCY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * ADR-0179 security review, item 3 — WHAT A CLAIM KEEPS. A claim used to keep
 * the whole response, which for a risk or a use case is the record itself
 * (its description, its risk text), copied into a second table for 30 days.
 * A route that wrote one record now keeps only a REFERENCE to it,
 * `{ replayOf: <id> }`, and rebuilds the replay from the record when a retry
 * comes (under the same read rule as the record's own GET). A body that is
 * not a reference is a claim stored before this change, holding the full
 * response, and is replayed verbatim as before.
 */
export const replayReference = (id: string): Record<string, unknown> => ({ replayOf: id });

/** the id a stored body refers to, or null when it is a full (older) response */
export function referencedId(stored: Record<string, unknown>): string | null {
  const keys = Object.keys(stored);
  return keys.length === 1 && keys[0] === "replayOf" && typeof stored.replayOf === "string" ? stored.replayOf : null;
}

export type IdempotencyKeyRead =
  | { ok: true; key: string | null }
  | { ok: false; body: { error: "invalid_idempotency_key"; detail: string } };

/** the request's `Idempotency-Key` header: absent, or one value of 1 to 200 characters */
export function readIdempotencyKey(req: FastifyRequest): IdempotencyKeyRead {
  const raw = req.headers["idempotency-key"];
  if (raw === undefined) return { ok: true, key: null };
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 200) {
    return {
      ok: false,
      body: { error: "invalid_idempotency_key", detail: "Idempotency-Key must be a single value of 1 to 200 characters" },
    };
  }
  return { ok: true, key: raw };
}

/** SHA-256 of the request a key is bound to (the parsed body, so key order is the schema's) */
export const requestDigestOf = (request: unknown): string =>
  createHash("sha256").update(JSON.stringify(request)).digest("hex");

export interface IdempotencyClaim {
  userId: string;
  /** the route and its target, e.g. `risk` or `workflow-artifact:<instanceId>` */
  scope: string;
  key: string;
  requestDigest: string;
}

export type IdempotentOutcome<T> =
  | { kind: "fresh"; body: T }
  | { kind: "replay"; body: Record<string, unknown> }
  | { kind: "conflict"; status: 409 | 422; body: { error: string; detail: string } };

const reused = {
  kind: "conflict" as const,
  status: 422 as const,
  body: {
    error: "idempotency_key_reused",
    detail: "this Idempotency-Key was first used with a different request; use a new key for a new request",
  },
};
const inFlight = {
  kind: "conflict" as const,
  status: 409 as const,
  body: { error: "idempotency_key_in_flight", detail: "a request with this Idempotency-Key has not finished — retry shortly" },
};

const keyWhere = (c: IdempotencyClaim) =>
  and(
    eq(requestIdempotencyKeys.userId, c.userId),
    eq(requestIdempotencyKeys.scope, c.scope),
    eq(requestIdempotencyKeys.key, c.key),
  );

function answerFor(
  hit: { requestDigest: string; response: Record<string, unknown> | null },
  claim: IdempotencyClaim,
): IdempotentOutcome<never> {
  if (hit.requestDigest !== claim.requestDigest) return reused;
  if (!hit.response) return inFlight;
  return { kind: "replay", body: hit.response };
}

/**
 * Read a claimed key without writing anything: the replay (or refusal) a
 * retry gets, or null when the key is unclaimed (or its window has passed).
 * A route checks this BEFORE its own validation, so a retry of a request that
 * already committed is answered even if the state it acted on has moved on.
 */
export async function idempotentReplay(db: Db, claim: IdempotencyClaim): Promise<IdempotentOutcome<never> | null> {
  const [hit] = await db
    .select({
      requestDigest: requestIdempotencyKeys.requestDigest,
      response: requestIdempotencyKeys.response,
      createdAt: requestIdempotencyKeys.createdAt,
    })
    .from(requestIdempotencyKeys)
    .where(keyWhere(claim));
  if (!hit || Date.now() - hit.createdAt.getTime() >= IDEMPOTENCY_WINDOW_MS) return null;
  return answerFor(hit, claim);
}

/**
 * Run `work` in one transaction with the key's claim. `work` writes the
 * record (and its audit row) through `tx` and returns the response body; it
 * throws to refuse, which rolls the claim back with everything else. The body
 * is stored as the JSON the caller receives, so a replay has the same shape —
 * or, with `toStored`, only what the route needs to rebuild it (a
 * `replayReference`); the route then resolves a replayed body itself.
 */
export async function withIdempotencyKey<T extends Record<string, unknown>>(
  db: Db,
  claim: IdempotencyClaim,
  work: (tx: Db) => Promise<T>,
  toStored: (body: T) => Record<string, unknown> = (body) => body,
): Promise<IdempotentOutcome<T>> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Db;
    await tx
      .delete(requestIdempotencyKeys)
      .where(and(keyWhere(claim), lt(requestIdempotencyKeys.createdAt, new Date(Date.now() - IDEMPOTENCY_WINDOW_MS))));
    const claimed = await tx
      .insert(requestIdempotencyKeys)
      .values({ userId: claim.userId, scope: claim.scope, key: claim.key, requestDigest: claim.requestDigest })
      .onConflictDoNothing({
        target: [requestIdempotencyKeys.userId, requestIdempotencyKeys.scope, requestIdempotencyKeys.key],
      })
      .returning({ id: requestIdempotencyKeys.id });
    if (claimed.length === 0) {
      const [hit] = await tx
        .select({ requestDigest: requestIdempotencyKeys.requestDigest, response: requestIdempotencyKeys.response })
        .from(requestIdempotencyKeys)
        .where(keyWhere(claim));
      // unreachable without a row: the conflict that skipped the insert is that row
      return hit ? answerFor(hit, claim) : inFlight;
    }
    const body = await work(tx);
    await tx
      .update(requestIdempotencyKeys)
      .set({ response: JSON.parse(JSON.stringify(toStored(body))) as Record<string, unknown> })
      .where(keyWhere(claim));
    return { kind: "fresh" as const, body };
  });
}

/** at most this many claims per table go in one pass; the rest wait for the next */
export const IDEMPOTENCY_SWEEP_BATCH = 5000;

export interface IdempotencyKeySweepResult {
  cutoff: string;
  /** `request_idempotency_keys` rows deleted (risk and questionnaire-artifact keys) */
  requestKeys: number;
  /** `use_case_idempotency_keys` rows deleted (use-case create keys) */
  useCaseKeys: number;
  /** true when a table had more expired claims than one pass deletes */
  capped: boolean;
}

/**
 * ADR-0179 security review, item 3 — THE 30-DAY SWEEP. A claim past its
 * window never replays again (both readers ignore it, and a new claim under
 * the same key replaces it), but nothing removed it, so both claim tables grew
 * for ever. This deletes every claim older than the window, a bounded batch
 * per table per pass, oldest first (the created_at index serves it). The
 * scheduler job `idempotency-key-sweep` runs it; the scheduler's own run audit
 * records the counts.
 */
export async function runIdempotencyKeySweep(
  db: Db,
  opts: { now?: Date; batch?: number } = {},
): Promise<IdempotencyKeySweepResult> {
  const now = opts.now ?? new Date();
  const batch = Math.max(1, opts.batch ?? IDEMPOTENCY_SWEEP_BATCH);
  const cutoff = new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS);

  const expiredRequest = db
    .select({ id: requestIdempotencyKeys.id })
    .from(requestIdempotencyKeys)
    .where(lt(requestIdempotencyKeys.createdAt, cutoff))
    .orderBy(requestIdempotencyKeys.createdAt)
    .limit(batch);
  const requestKeys = await db
    .delete(requestIdempotencyKeys)
    .where(and(inArray(requestIdempotencyKeys.id, expiredRequest), lt(requestIdempotencyKeys.createdAt, cutoff)))
    .returning({ id: requestIdempotencyKeys.id });

  const expiredUseCase = db
    .select({ id: useCaseIdempotencyKeys.id })
    .from(useCaseIdempotencyKeys)
    .where(lt(useCaseIdempotencyKeys.createdAt, cutoff))
    .orderBy(useCaseIdempotencyKeys.createdAt)
    .limit(batch);
  const useCaseKeys = await db
    .delete(useCaseIdempotencyKeys)
    .where(and(inArray(useCaseIdempotencyKeys.id, expiredUseCase), lt(useCaseIdempotencyKeys.createdAt, cutoff)))
    .returning({ id: useCaseIdempotencyKeys.id });

  return {
    cutoff: cutoff.toISOString(),
    requestKeys: requestKeys.length,
    useCaseKeys: useCaseKeys.length,
    capped: requestKeys.length === batch || useCaseKeys.length === batch,
  };
}
