/**
 * ADR-0127 / ROADMAP G9 — telling "was asked" apart from "was done" in the
 * audit ledger.
 *
 * ── THE BUG THIS EXISTS TO FIX ─────────────────────────────────────────────
 * The kernel's rate limits are counted as `count(audit_log)` over rows with
 * `effect = 'allow'` for a user in a window (`governed-evaluate.ts`). Every
 * governed execution writes such a row, which is correct. But so does
 * `POST /v1/evaluate`, which EXECUTES NOTHING — it answers "what would you
 * decide". So a preview silently spent the subject's rate-limit budget on
 * traffic that never ran, and an execution preceded by a preview counted twice.
 *
 * That was tolerable while `/v1/evaluate` was an occasional admin preview; a
 * session log from 2026-07-24 records it as "acceptable for slice". G9 makes it
 * intolerable, because the whole point of a PDP callout is that a proxy asks
 * this question on EVERY request it handles. Left alone, adopting the
 * recommended topology would have made a governance product mis-count its own
 * limits in proportion to how much its customer used it.
 *
 * ── WHY A KEY IN `detail` AND NOT A COLUMN ─────────────────────────────────
 * A new `audit_log.advisory` column would be the obvious shape and it would be
 * the weaker one: `content_hash` is taken over an ENUMERATED field list
 * (`canonicalAuditPayload`), so a new column sits OUTSIDE the hash unless the
 * payload version is bumped and the verifier taught to check both versions.
 * A flag outside the hash is not tamper-evident — someone able to flip it on an
 * executed row would change what the rate limiter counts, invisibly, in the one
 * table this product asks people to trust.
 *
 * `detail` is already inside the hash. Putting the marker there makes it
 * tamper-evident for free, needs no migration, and needs no payload version
 * bump. The scrubber preserves booleans by identity (ADR-0102), so the marker
 * survives the write path unchanged.
 *
 * ── THE DEFAULT IS "EXECUTED", DELIBERATELY ────────────────────────────────
 * A row with no marker counts. Every existing producer therefore keeps its
 * current meaning with no edit, and a future one that forgets this file is
 * counted rather than silently exempted. Getting that backwards would let a new
 * code path quietly stop counting against a limit — failing open, in the
 * direction of not enforcing.
 */

/** the key inside `audit_log.detail` that marks a decision nothing acted on */
export const AUDIT_ADVISORY_KEY = "advisory" as const;

/**
 * Merge the advisory marker into an audit `detail` payload.
 *
 * Takes the caller's detail so the marker cannot be forgotten separately from
 * the rest of the context a decision-only route wants to record.
 */
export function advisoryDetail(detail?: Record<string, unknown> | null): Record<string, unknown> {
  return { ...(detail ?? {}), [AUDIT_ADVISORY_KEY]: true };
}

/** Did this row record a decision that nothing acted on? */
export function isAdvisoryDetail(detail: unknown): boolean {
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) return false;
  return (detail as Record<string, unknown>)[AUDIT_ADVISORY_KEY] === true;
}

/**
 * The SQL predicate that keeps advisory rows OUT of a count, as a string so the
 * one authority on the marker's name also owns the query that reads it.
 *
 * `IS DISTINCT FROM` rather than `<> 'true'` or `NOT (... = 'true')`, and the
 * difference is a bug waiting to happen: `detail` is nullable, `NULL ->> 'k'`
 * is NULL, and under three-valued logic `NOT (NULL = 'true')` is NULL — which
 * filters the row OUT. That would have stopped counting every execution whose
 * detail happened to be NULL, i.e. quietly disabled rate limiting for them.
 */
export const NOT_ADVISORY_SQL = `(detail ->> '${AUDIT_ADVISORY_KEY}') is distinct from 'true'`;

// ---------------------------------------------------------------------------
// ADR-0127 §2 — the authorization callout's wire contract
// ---------------------------------------------------------------------------

/**
 * What a proxy is told. DELIBERATELY NOT the kernel `Decision`.
 *
 * `Decision.reason` and `Decision.ruleChain` carry rule ids, grant ids, role
 * names and approver DISPLAY NAMES AND EMAILS. That is exactly right for an
 * admin looking at a decision in the portal, and wrong to hand a data-plane
 * proxy: whatever the proxy receives it may log, forward to a downstream
 * service, or surface in an error page, none of which this product controls.
 * So the callout answers with a stable code and nothing else, and the full
 * chain stays in the ledger where entitlement to read it is enforced.
 *
 * The codes are a CLOSED SET on purpose. A proxy routes on them, so they are a
 * compatibility surface: adding one is safe, changing what an existing one
 * means is a breaking change to somebody's routing table.
 */
export const AUTHZ_DECISIONS = ["allow", "deny", "approval_required"] as const;
export type AuthzDecision = (typeof AUTHZ_DECISIONS)[number];

/**
 * `require_approval` is the interesting one and it is why this type exists.
 *
 * Envoy's ext_authz has two outcomes — OK and denied — and nothing in this
 * repository had ever had to choose what a pending approval means at a proxy.
 * It is a DENY: the request must not proceed, and failing closed is this
 * product's posture everywhere else. But it is not the same fact as a policy
 * refusal, and collapsing them would destroy the distinction the approvals
 * queue exists to make — "a human can unblock this" versus "never". So it
 * carries its own code, and the adapters map it to 403 with a header naming it,
 * so a caller can tell a recoverable hold from a hard no.
 */
export function isAuthzAllowed(d: AuthzDecision): boolean {
  return d === "allow";
}
