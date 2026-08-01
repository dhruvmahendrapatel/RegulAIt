/**
 * ADR-0034 amendment #2 (2026-08-01) — THE CONNECTION `baseUrl` FIELDS, BEHIND
 * THE SAME EGRESS GUARD.
 *
 * WHY THIS EXISTS. ADR-0034 shipped the egress guard for custom LLM providers;
 * its first amendment brought the model-credential `baseUrl` overrides inside
 * it. Both amendments ended with the same honest enumeration of what was still
 * outside, and the top three entries were these:
 *
 *   > `connectors.baseUrl` + `connector_credentials.baseUrl` — EXPOSED. Same
 *   > primitive. The `webhook` kind is worse than a read: it **POSTs the
 *   > payload** to the URL, so it is an exfiltration channel as well as an
 *   > SSRF one. Highest-priority follow-up.
 *   > `git_connections.baseUrl` — EXPOSED. Same shape, same fix would apply.
 *   > `pm_connections.baseUrl` — EXPOSED. `generic_webhook` again POSTs.
 *
 * THE EXFILTRATION POINT IS THE ONE THAT MATTERS. An SSRF hole lets an attacker
 * READ something the gateway can reach. A `webhook`/`generic_webhook` connector
 * hands the attacker the other direction: `POST /v1/connectors/:id/invoke`
 * carries a caller-supplied payload, and the adapter posts that payload,
 * verbatim, to whatever URL the row names. Every governed connector call can
 * carry customer data — that is the entire point of a connector — so an
 * admin-typed `baseUrl` on a webhook connector is a governed, audited,
 * cost-attributed pipe to an attacker's collector. "Only an admin can set it"
 * is not a mitigation; an admin account is what an attacker escalates to.
 *
 * WHAT THIS ADDS. No new policy. There is ONE egress policy in this codebase —
 * the `egress_allow_hosts` table plus `egress-guard.ts` — and this module is
 * the same thin adapter onto it that `credential-egress.ts` is, for a different
 * set of columns. Same allow-list, same per-host `allow_private_ranges` /
 * `allow_plaintext_http` opt-ins, same `createGuardedFetch`, same refusal
 * vocabulary. A second allow-list mechanism would be a second thing to reason
 * about and a second thing to get wrong.
 *
 * WHEN. Both moments, for the reason ADR-0034 already gave and this change does
 * not get to re-litigate:
 *
 *   - WRITE TIME on `POST /v1/connectors`, `POST /v1/connectors/:id/credential`,
 *     `POST /v1/git/connections` and `POST /v1/pm/connections`, so a bad
 *     endpoint is an honest 400 at the moment somebody types it;
 *   - EVERY OUTBOUND CALL, because a registration-time verdict is not a fact
 *     about the future. DNS can be re-pointed after approval, the allow-list
 *     can be withdrawn, and — the part that is not hypothetical — rows written
 *     BEFORE this guard existed are sitting in the live database right now with
 *     whatever `baseUrl` they were given. The call-time check is what makes
 *     those rows safe. They are REFUSED, never rewritten or nulled: silently
 *     editing stored operator configuration is a worse failure mode than
 *     refusing it loudly, and a null would be indistinguishable from "never
 *     had one".
 *
 * NO OVERRIDE MEANS NO CHECK, exactly as on the credential path. A connector /
 * git / PM row with a null `baseUrl` uses its adapter's compiled vendor
 * endpoint (`https://api.github.com`, `https://slack.com/api`, …), which no
 * human can type, so there is nothing for an allow-list to decide and the
 * behaviour of every non-overriding deployment is byte-identical — down to the
 * fetch implementation, which stays the global one.
 *
 * ONE OPT-IN, NOT TWO — same deliberate difference the credential amendment
 * recorded. A custom LLM provider row carries its own `allow_plaintext_http`
 * column, so plaintext http there needs two opt-ins. None of these three tables
 * has such a column and this change adds no migration, so plaintext http to a
 * connection `baseUrl` is gated by the host entry's `allow_plaintext_http`
 * alone: still explicit, still per-host, still admin-only, still audited.
 *
 * THE RESIDUAL, STATED PLAINLY. This module reuses `createGuardedFetch`
 * UNCHANGED. http destinations are pinned to the validated address; https
 * destinations are validated immediately before each request and then resolved
 * a second time by the TLS stack. **The https DNS-rebind TOCTOU is therefore
 * still open on these paths too** — this change implements no `undici.Agent`
 * and closes none of that window. It inherits exactly the same one the
 * custom-provider and credential paths have.
 */

import { auditLog, type Db } from "@regulait/db";
import {
  checkEgress,
  createGuardedFetch,
  type EgressAllowed,
  type EgressAllowEntry,
  type EgressDecision,
  type EgressDenied,
  type EgressResolver,
} from "./egress-guard.js";
import { loadEgressAllowList } from "./custom-providers.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** The three tables this module governs, plus the credential side-table of the
 * first. Used for the audit `objectType` and to make refusal messages name the
 * surface a human has to go and fix. */
export type ConnectionSurface = "connector" | "git_connection" | "pm_connection";

export interface ConnectionEgressDeps {
  resolve?: EgressResolver;
  fetchImpl?: typeof fetch;
}

export interface ConnectionEgressCheck {
  decision: EgressDecision;
  /** the allow-list the decision was taken against — handed back so the caller
   * builds the guarded fetch from the SAME snapshot it validated against */
  allowList: EgressAllowEntry[];
}

/** WHERE a guarded call went — the audit payload, identical in shape to the
 * custom-provider dispatch record so one query answers the question across all
 * four surfaces. */
export interface EgressDestination {
  host: string;
  port: number;
  protocol: string;
  addresses: string[];
}

export function egressDestination(d: EgressAllowed): EgressDestination {
  return { host: d.host, port: d.port, protocol: d.protocol, addresses: d.addresses };
}

/**
 * Thrown by the call-time guard on the git and PM paths, where the refusal has
 * to travel out through an existing `catch` rather than becoming an HTTP reply
 * on the spot. Carries the decision so an HTTP boundary that DOES exist (the
 * two `pm-sync` endpoints) can turn it into a real 403 with the real code.
 */
export class ConnectionEgressBlockedError extends Error {
  constructor(
    readonly surface: ConnectionSurface,
    readonly decision: EgressDenied,
  ) {
    super(`egress blocked (${decision.code}): ${decision.reason}`);
    this.name = "ConnectionEgressBlockedError";
  }
}

/**
 * Validate a connection-supplied `baseUrl` against the admin egress allow-list.
 *
 * Callers pass the RAW override only — a null/empty `baseUrl` must never reach
 * here (see "NO OVERRIDE MEANS NO CHECK" above).
 */
export async function checkConnectionBaseUrl(
  db: Db,
  baseUrl: string,
  deps: ConnectionEgressDeps = {},
): Promise<ConnectionEgressCheck> {
  const allowList = await loadEgressAllowList(db);
  const decision = await checkEgress(baseUrl, {
    allowList,
    // no per-connection plaintext flag exists on any of these tables (see the
    // header note) — the host entry's own allow_plaintext_http is the single
    // opt-in on this path
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  return { decision, allowList };
}

/**
 * The fetch a `baseUrl`-overridden connection must use. Re-validates on EVERY
 * HTTP request the adapter makes, pins plaintext http to the validated address
 * with the original `Host` header, and refuses redirects — identical semantics
 * to the custom-provider and credential paths, because it is literally the same
 * function.
 */
export function connectionGuardedFetch(
  allowList: EgressAllowEntry[],
  deps: ConnectionEgressDeps = {},
): typeof fetch {
  return createGuardedFetch({
    allowList,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export interface EgressAuditArgs {
  userId?: string | null;
  surface: ConnectionSurface;
  objectId?: string | null;
  /** where in the lifecycle this happened — `*_write` or `call` */
  phase: string;
  /** the destination that was typed; kept verbatim so the row is actionable */
  baseUrl: string;
  /** extra context that makes the row mean something to whoever reads it later */
  detail?: Record<string, unknown>;
}

const RULE_ID: Record<ConnectionSurface, { blocked: string; call: string }> = {
  connector: { blocked: "connector-egress-blocked", call: "connector-egress-call" },
  git_connection: { blocked: "git-connection-egress-blocked", call: "git-connection-egress-call" },
  pm_connection: { blocked: "pm-connection-egress-blocked", call: "pm-connection-egress-call" },
};

/**
 * File the refusal. Somebody pointing this gateway at IMDS — or at a collector
 * they control — is precisely the event a governance product must be able to
 * show afterwards, whether or not it succeeded.
 */
export async function auditConnectionEgressDenied(
  db: Db,
  args: EgressAuditArgs & { decision: EgressDenied; reason: string },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    objectType: args.surface,
    objectId: args.objectId ?? null,
    detail: {
      // caller context first: the explicit fields below are the guard's own
      // record and must never be shadowed by a caller's key of the same name
      ...(args.detail ?? {}),
      phase: args.phase,
      baseUrl: args.baseUrl,
      code: args.decision.code,
      ...(args.decision.host ? { host: args.decision.host } : {}),
    },
    effect: "deny",
    ruleId: RULE_ID[args.surface].blocked,
    ruleChain: [],
    reason: args.reason,
  });
}

/**
 * THE DESTINATION-HOST RECORD, written for every guarded outbound call — the
 * same thing ADR-0034 writes for a custom-provider dispatch, and for the same
 * reason: "which third-party endpoint did our connectors/git/PM traffic reach,
 * on whose behalf" has to be answerable after the fact.
 *
 * Written BEFORE the request rather than after it, deliberately: a call that
 * hangs, crashes the process, or fails halfway still leaves the record of where
 * it was going. An after-the-fact-only record would be missing exactly the
 * cases an incident review cares about.
 */
export async function auditConnectionEgressCall(
  db: Db,
  args: EgressAuditArgs & { destination: EgressDestination },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    objectType: args.surface,
    objectId: args.objectId ?? null,
    detail: {
      ...(args.detail ?? {}),
      phase: args.phase,
      baseUrl: args.baseUrl,
      egress: args.destination,
    },
    effect: "allow",
    ruleId: RULE_ID[args.surface].call,
    ruleChain: [],
    reason:
      `${args.surface} egress to ${args.destination.protocol}//` +
      `${args.destination.host}:${args.destination.port}`,
  });
}

/**
 * WRITE TIME, in one call. Returns null when the destination is permitted, or
 * the 400 body when it is not — audited either way, because an attempt to point
 * this gateway somewhere it may not go is the event, not just the success.
 */
export async function refuseConnectionEgressWrite(
  db: Db,
  args: {
    surface: ConnectionSurface;
    baseUrl: string;
    userId?: string | null;
    objectId?: string | null;
    phase: string;
    /** names the field in the message, e.g. "git connection 'origin' baseUrl" */
    label: string;
    detail?: Record<string, unknown>;
    deps?: ConnectionEgressDeps;
  },
): Promise<{ error: "egress_blocked"; code: string; detail: string } | null> {
  const { decision } = await checkConnectionBaseUrl(db, args.baseUrl, args.deps ?? {});
  if (decision.ok) return null;
  const detail =
    `${args.label} refused: ${decision.reason}` +
    ` (an admin adds permitted destinations under Egress Allow Hosts)`;
  await auditConnectionEgressDenied(db, {
    surface: args.surface,
    ...(args.userId !== undefined ? { userId: args.userId } : {}),
    ...(args.objectId !== undefined ? { objectId: args.objectId } : {}),
    phase: args.phase,
    baseUrl: args.baseUrl,
    ...(args.detail ? { detail: args.detail } : {}),
    decision,
    reason: detail,
  });
  return { error: "egress_blocked", code: decision.code, detail };
}

/**
 * The whole call-time sequence in one place, for the paths that just want a
 * guarded fetch or a refusal: check, audit (either way), and either hand back
 * the fetch + destination or throw `ConnectionEgressBlockedError`.
 */
export async function guardConnectionCall(
  db: Db,
  args: {
    surface: ConnectionSurface;
    baseUrl: string;
    userId?: string | null;
    objectId?: string | null;
    /** names the row in the refusal message, e.g. "git connection 'origin'" */
    label: string;
    detail?: Record<string, unknown>;
    deps?: ConnectionEgressDeps;
  },
): Promise<{ fetchImpl: typeof fetch; destination: EgressDestination }> {
  const { decision, allowList } = await checkConnectionBaseUrl(db, args.baseUrl, args.deps ?? {});
  if (!decision.ok) {
    const reason = `${args.label}: ${decision.reason}`;
    await auditConnectionEgressDenied(db, {
      surface: args.surface,
      ...(args.userId !== undefined ? { userId: args.userId } : {}),
      ...(args.objectId !== undefined ? { objectId: args.objectId } : {}),
      phase: "call",
      baseUrl: args.baseUrl,
      ...(args.detail ? { detail: args.detail } : {}),
      decision,
      reason,
    });
    throw new ConnectionEgressBlockedError(args.surface, decision);
  }
  const destination = egressDestination(decision);
  await auditConnectionEgressCall(db, {
    surface: args.surface,
    ...(args.userId !== undefined ? { userId: args.userId } : {}),
    ...(args.objectId !== undefined ? { objectId: args.objectId } : {}),
    phase: "call",
    baseUrl: args.baseUrl,
    ...(args.detail ? { detail: args.detail } : {}),
    destination,
  });
  return {
    fetchImpl: connectionGuardedFetch(allowList, args.deps ?? {}),
    destination,
  };
}
