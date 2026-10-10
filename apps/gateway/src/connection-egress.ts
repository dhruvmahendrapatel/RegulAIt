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
 * ── AMENDED, 2026-08-03 (ADR-0062) ──────────────────────────────────────────
 * The paragraph immediately above is kept verbatim because it is what this
 * module shipped saying, and it remains exactly right AS AN SSRF ARGUMENT — you
 * cannot smuggle `169.254.169.254` into a constant. It was never an egress
 * POLICY, and on an air-gapped deployment the policy is the whole point: a
 * Slack or GitHub connector on its compiled endpoint is an outbound connection
 * carrying customer data, and until ADR-0062 nothing in the application refused
 * it (`docs/deployment/DATA_BOUNDARY.md` §4 recorded this as an open finding).
 *
 * The fix does NOT live in this module, deliberately: this module adapts TYPED
 * destinations onto the allow-list, and a compiled constant is a different
 * question (an admission decision on a vendor, with no DNS and no transport
 * change). It lives in `compiled-egress.ts`, gated by `deploy-posture.ts`, and
 * it decides against the SAME `egress_allow_hosts` table — there is still ONE
 * egress allow-list in this codebase. Under `hosted` (the default) every word
 * above still describes the behaviour exactly.
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
 *
 * ── SUPERSEDED, 2026-08-01 (ADR-0034 amendment #3) ──────────────────────────
 * The paragraph immediately above is kept verbatim because it is what this
 * module shipped saying, and amendments in this repo are appended, not
 * rewritten. It is now OUT OF DATE in one respect: `createGuardedFetch` pins
 * BOTH schemes to the validated addresses via `pinned-fetch.ts`, keeping SNI
 * and certificate verification against the original hostname, so these paths
 * inherit the closed window rather than the open one. Everything else in the
 * paragraph still holds.
 */

import { auditLog, type Db } from "@regulait/db";
import {
  checkEgress,
  createGuardedFetch,
  normalizeHost,
  type EgressAllowed,
  type EgressAllowEntry,
  type EgressDecision,
  type EgressDenied,
  type EgressResolver,
} from "./egress-guard.js";
import { loadEgressAllowList } from "./custom-providers.js";
import {
  auditCompiledDefaultDenied,
  decideCompiledDefault,
  loadCompiledEgressContext,
} from "./compiled-egress.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** The three tables this module governs, plus the credential side-table of the
 * first. Used for the audit `objectType` and to make refusal messages name the
 * surface a human has to go and fix. */
export type ConnectionSurface = "connector" | "git_connection" | "pm_connection";

export interface ConnectionEgressDeps {
  resolve?: EgressResolver;
  fetchImpl?: typeof fetch;
  beforeSend?: () => Promise<void>;
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
 * HTTP request the adapter makes, pins the connection to the validated
 * addresses for BOTH schemes (ADR-0034 amendment #3), and refuses redirects —
 * identical semantics to the custom-provider and credential paths, because it
 * is literally the same function.
 */
export function connectionGuardedFetch(
  allowList: EgressAllowEntry[],
  deps: ConnectionEgressDeps = {},
): typeof fetch {
  return createGuardedFetch({
    allowList,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.beforeSend ? { beforeSend: deps.beforeSend } : {}),
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
      receiptClass: "decision",
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
      receiptClass: "decision",
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
 * ADR-0167 (SEC-01) — the call-time guard for an adapter whose destination is
 * NAMED BY ITS CREDENTIAL.
 *
 * "No override means no check" (the header of this module) is an SSRF
 * argument about hosts nobody can type. Three connector kinds reach a host
 * somebody DID type, through the credential rather than the `baseUrl`: the
 * Entra login host (`loginBaseUrl`) for teams and outlook, and
 * `https://<account>.snowflakecomputing.com` for snowflake. With no `baseUrl`
 * override those adapters were handed the GLOBAL fetch, so an admin-typed
 * credential field reached the network with no allow-list, no private-range
 * or IMDS check, no DNS pin, redirects followed and no audit row — and the
 * non-admin invoke route echoed the upstream body back. ADR-0034 §"only an
 * admin can set it" is explicit that admin-only is not a mitigation here.
 *
 * Two rules, kept separate because they answer different questions:
 *
 *   1. The TYPED host (`typedBaseUrl`) is a typed destination and is
 *      adjudicated exactly like a `baseUrl` override — the allow-list decides,
 *      under every posture, and the decision is audited either way.
 *   2. The vendor's COMPILED hosts the same call will reach (the Bot
 *      Connector service, Graph, the default Entra login host) follow the
 *      deployment posture precisely as `decideCompiledDefault` applies it to
 *      every other compiled default: adjudicated under `strict`, admitted
 *      under `hosted`. Under a permissive posture they are therefore handed
 *      to the guarded fetch as synthetic allow entries — still pinned, still
 *      redirect-refusing, still private-range-blocking; only the "is it
 *      listed" question is answered by the posture rather than the table.
 *
 * The returned fetch re-adjudicates EVERY request URL, so a host this
 * function did not pre-check (the service host after the login host) is
 * refused mid-call, and `egressRefusal` turns that into the same honest 403.
 */
export async function guardCredentialDerivedCall(
  db: Db,
  args: {
    surface: ConnectionSurface;
    kind: string;
    /** the host an admin typed into the credential, or null when the
     * credential names none (teams/outlook with the default login host) */
    typedBaseUrl: string | null;
    /** the vendor's compiled hosts the adapter will also reach */
    compiledBaseUrls: string[];
    userId?: string | null;
    objectId?: string | null;
    label: string;
    detail?: Record<string, unknown>;
    deps?: ConnectionEgressDeps;
  },
): Promise<
  | { ok: true; fetchImpl: typeof fetch; destination: EgressDestination | null }
  | { ok: false; code: string; reason: string }
> {
  // the posture comes from the compiled-default context; the allow-list is
  // loaded HERE regardless of posture (that context reads none under
  // `hosted`, by design), because the typed host below is adjudicated
  // against the table under every posture
  const { posture } = await loadCompiledEgressContext(db);
  const allowList = await loadEgressAllowList(db);
  for (const url of args.compiledBaseUrls) {
    const compiled = decideCompiledDefault({
      posture,
      surface: args.surface,
      kind: args.kind,
      defaultBaseUrl: url,
      allowList,
    });
    if (!compiled.ok) {
      await auditCompiledDefaultDenied(db, {
        ...(args.userId !== undefined ? { userId: args.userId } : {}),
        surface: args.surface,
        ...(args.objectId !== undefined ? { objectId: args.objectId } : {}),
        kind: args.kind,
        decision: compiled,
        posture,
        ...(args.detail ? { detail: args.detail } : {}),
      });
      return { ok: false, code: compiled.code, reason: compiled.reason };
    }
  }
  const listed = new Set(allowList.map((e) => normalizeHost(e.host)));
  const synthetic: EgressAllowEntry[] = [];
  if (posture !== "strict") {
    for (const url of args.compiledBaseUrls) {
      let host: string;
      try {
        host = normalizeHost(new URL(url).hostname);
      } catch {
        continue;
      }
      if (!host || listed.has(host)) continue;
      listed.add(host);
      synthetic.push({ host, allowPrivateRanges: false, allowPlaintextHttp: false });
    }
  }
  const effective = synthetic.length ? [...allowList, ...synthetic] : allowList;

  let destination: EgressDestination | null = null;
  if (args.typedBaseUrl) {
    const decision = await checkEgress(args.typedBaseUrl, {
      allowList: effective,
      ...(args.deps?.resolve ? { resolve: args.deps.resolve } : {}),
    });
    if (!decision.ok) {
      const reason = `${args.label}: ${decision.reason}`;
      await auditConnectionEgressDenied(db, {
        surface: args.surface,
        ...(args.userId !== undefined ? { userId: args.userId } : {}),
        ...(args.objectId !== undefined ? { objectId: args.objectId } : {}),
        phase: "call",
        baseUrl: args.typedBaseUrl,
        ...(args.detail ? { detail: args.detail } : {}),
        decision,
        reason,
      });
      return { ok: false, code: decision.code, reason };
    }
    destination = egressDestination(decision);
    await auditConnectionEgressCall(db, {
      surface: args.surface,
      ...(args.userId !== undefined ? { userId: args.userId } : {}),
      ...(args.objectId !== undefined ? { objectId: args.objectId } : {}),
      phase: "call",
      baseUrl: args.typedBaseUrl,
      ...(args.detail ? { detail: args.detail } : {}),
      destination,
    });
  }
  return { ok: true, fetchImpl: connectionGuardedFetch(effective, args.deps ?? {}), destination };
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
