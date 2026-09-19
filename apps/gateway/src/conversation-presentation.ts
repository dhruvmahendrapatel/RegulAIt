/**
 * ADR-0112 — THE CONVERSATION PRESENTATION SCRUB.
 *
 * ADR-0111 proved (its table row 2) that a credential pasted into a chat turn
 * is stored verbatim in `conversation_messages.content` — in the user row AND
 * the assistant row — in `conversations.title` via `autoTitle`, and in
 * `conversations.summary` once compaction runs. It deliberately did not fix it
 * and recorded four options for the owner. **The owner chose (c): store
 * faithfully, scrub the read and export surfaces.**
 *
 * So the stored record stays byte-for-byte what was said. What the product
 * HANDS OUT gets redacted.
 *
 * ==========================================================================
 * THE LINE THAT MUST NOT MOVE: PRESENTATION IS NOT REPLAY
 * ==========================================================================
 * `loadOwnConversationForReplay` (conversations.ts) builds the MODEL-BOUND
 * history for a multi-turn dispatch, and `compaction.ts` summarizes the same
 * rows. Those are not presentation — they are the conversation working. If the
 * scrub were sited on the database READ, the model would receive
 * `[redacted:…]` where the user's own prior message belongs and a multi-turn
 * thread would start answering the wrong question. A scrub-on-DB-read is
 * therefore the WRONG siting, and this file does not do it.
 *
 * The two paths are kept apart by NAME, not by comment:
 *   - `loadOwnConversationForReplay` — faithful, internal, provider-bound.
 *     It never reaches a human eye directly.
 *   - this plugin — everything that leaves an HTTP route toward a human or a
 *     file.
 * A future reader who reaches for "the loader" gets the one whose name says
 * REPLAY, and is told what that means at its definition.
 *
 * ==========================================================================
 * WHY A HOOK ON THE ROUTE SCOPE, NOT A CALL AT EACH ROUTE
 * ==========================================================================
 * ADR-0099 rejected per-call-site scrubbing and ADR-0102 restated why: a
 * convention is only as good as the next author's memory of it. The structural
 * property available here is the same one `createDb` gave the write side —
 * there is exactly ONE place conversation content becomes an HTTP response,
 * namely the encapsulated Fastify scope that `registerConversationRoutes`
 * creates. A `preSerialization` hook on that scope sees every payload of every
 * route registered in it, including the route somebody adds next month without
 * having read this file.
 *
 * TWO HOOKS, because Fastify has two payload shapes:
 *   - `preSerialization` gets the OBJECT a handler returned, before JSON
 *     encoding. Scrubbing string leaves there is exact: the JSON structure is
 *     built afterwards, so a marker can never break the encoding.
 *   - `onSend` gets whatever will actually go on the wire. It is the backstop
 *     for a payload `preSerialization` never sees — a string or Buffer body,
 *     which is what a CSV/NDJSON conversation EXPORT would be. It skips JSON
 *     (already handled above, and re-parsing serialized JSON to scrub it could
 *     only mangle it).
 *
 * ==========================================================================
 * ONE DETECTOR, NOT TWO
 * ==========================================================================
 * The scrub is `scrubAuditText` — ADR-0099's function, reached through
 * ADR-0102's `PROSE_SCRUB` alias, which that ADR pins as identical to it. No
 * new detector exists and none may: the marker a user reads in a presented
 * message must be byte-identical to the one `audit_log.reason` and
 * `trace_spans.input_preview` produced for the same secret in the same turn, or
 * the three records of one event cannot be correlated — which was S5's actual
 * damage.
 *
 * ==========================================================================
 * THE HONEST LIMIT (ADR-0112 states it at length; it belongs here too)
 * ==========================================================================
 * Option (c) protects the API surface, NOT the data at rest. The credential is
 * still in the database, verbatim. A `pg_dump`, a restored backup, a `psql`
 * session, or any module that opens its own `pg.Pool` reads it in the clear.
 * That is the precise difference between (c) and option (b) — scrubbing at
 * write time — and it is not hidden here. And model replay still sends the
 * ORIGINAL text to the provider, by design: a pasted credential does reach the
 * model vendor, and no option short of (b) changes that.
 */
import type { FastifyInstance } from "fastify";
import { PROSE_SCRUB } from "@regulait/db";

/**
 * The presentation scrub, by reference. Same function object as
 * `scrubAuditText`; a test asserts the identity so a fork cannot land quietly.
 */
export const PRESENTATION_SCRUB: (text: string) => string = PROSE_SCRUB;

/**
 * Deep-scrub the string leaves of a response payload.
 *
 * Returns the SAME object when nothing matched — the overwhelmingly common
 * case, and the over-scrub guard expressed in code: an unchanged payload is not
 * rebuilt, so it cannot be accidentally altered. Non-strings (numbers, `Date`,
 * `null`, booleans) pass through untouched; scrubbing is defined over text.
 *
 * `Date` matters: `createdAt`/`updatedAt` are still Date objects at
 * `preSerialization` time and must survive as such, or the serialized shape
 * changes. `instanceof Date` is checked before the generic object walk.
 */
export function scrubPresentedPayload<T>(value: T): T {
  if (typeof value === "string") return PRESENTATION_SCRUB(value) as T;
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || Buffer.isBuffer(value)) return value;

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((v) => {
      const s = scrubPresentedPayload(v);
      if (s !== v) changed = true;
      return s;
    });
    return (changed ? next : value) as T;
  }

  const obj = value as Record<string, unknown>;
  let changed: Record<string, unknown> | undefined;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    const s = scrubPresentedPayload(v);
    if (s === v) continue;
    changed ??= { ...obj };
    changed[key] = s;
  }
  return (changed ?? value) as T;
}

/** JSON is handled at `preSerialization`; re-scrubbing the encoded bytes could
 * only risk mangling them. Anything else — csv, ndjson, plain text — is a
 * human-or-file destination and is exactly what the backstop is for. */
function isJsonContentType(ct: unknown): boolean {
  return typeof ct === "string" && ct.toLowerCase().includes("json");
}

/**
 * Install the presentation scrub on a Fastify scope.
 *
 * Call this at the TOP of an encapsulated scope, before any route is declared
 * on it: every route in the scope is then covered by construction, and a route
 * added later inherits the coverage without its author doing anything.
 */
export function installConversationPresentationScrub(scope: FastifyInstance): void {
  scope.addHook("preSerialization", async (_req, _reply, payload) =>
    scrubPresentedPayload(payload),
  );

  scope.addHook("onSend", async (_req, reply, payload) => {
    if (isJsonContentType(reply.getHeader("content-type"))) return payload;
    if (typeof payload === "string") return PRESENTATION_SCRUB(payload);
    if (Buffer.isBuffer(payload)) {
      const scrubbed = PRESENTATION_SCRUB(payload.toString("utf8"));
      return Buffer.from(scrubbed, "utf8");
    }
    return payload;
  });
}
