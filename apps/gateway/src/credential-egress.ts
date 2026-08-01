/**
 * ADR-0034 amendment (2026-08-01) — THE CREDENTIAL `baseUrl` OVERRIDES, BEHIND
 * THE SAME EGRESS GUARD.
 *
 * WHY THIS EXISTS. ADR-0034 shipped the egress guard and routed the *new*
 * custom-provider dispatch through it, while honestly disclosing that it had
 * NOT covered an equivalent, older primitive:
 *
 *   > the pre-existing `model_credentials.baseUrl` / `user_model_credentials.baseUrl`
 *   > overrides are an equivalent primitive still outside the guard
 *
 * Those columns date to migrations 0016/0017 and are settable through the
 * shipped model-credential endpoints. Until this module existed, an admin —
 * or, on the per-user table, a user managing their own credential — could set
 * the `openai` provider's base URL to
 *
 *   http://169.254.169.254/latest/meta-data/iam/security-credentials/
 *
 * and have this gateway, which runs on EC2, fetch it and hand back the instance
 * role's AWS credentials. Anything else routable from the VPC (Postgres on the
 * compose network included) was one string away. That was a LIVE hole in
 * already-deployed code, not a hypothetical.
 *
 * WHAT THIS ADDS. Nothing new policy-wise — deliberately. There is ONE egress
 * policy in this codebase (`egress_allow_hosts` + `egress-guard.ts`) and this
 * module simply points the credential paths at it, at both moments that matter:
 *
 *   - WRITE TIME, so a bad endpoint is an honest 400 at the moment somebody
 *     types it rather than a surprise on some later user's dispatch;
 *   - EVERY DISPATCH, because a registration-time verdict is not a fact about
 *     the future: DNS can be re-pointed after approval, the allow-list can be
 *     withdrawn, and rows written BEFORE this guard existed are still sitting
 *     in the live database with whatever `baseUrl` they were given.
 *
 * The dispatch-time check is what makes pre-existing rows safe. Nothing is
 * migrated, nulled, or rewritten: an old row keeps its `baseUrl` and is simply
 * REFUSED (403 `egress_blocked`, audited) until an admin allow-lists the host
 * or clears the override. Silently nulling stored operator configuration would
 * be a worse failure mode than refusing it loudly.
 *
 * ONE DELIBERATE DIFFERENCE FROM THE CUSTOM-PROVIDER PATH. A custom provider
 * carries its own `allow_plaintext_http` flag, so plaintext http there needs
 * TWO opt-ins (host entry AND provider row). A credential row has no such
 * column and this change adds no migration, so plaintext http to a credential
 * `baseUrl` is gated by the host entry's `allow_plaintext_http` alone. That is
 * still explicit, per-host, admin-only and audited — one opt-in rather than
 * two, and it is recorded in the ADR amendment rather than left to be
 * discovered.
 */

import type { Db } from "@regulait/db";
import {
  checkEgress,
  createGuardedFetch,
  type EgressAllowEntry,
  type EgressDecision,
  type EgressResolver,
} from "./egress-guard.js";
import { loadEgressAllowList } from "./custom-providers.js";

export interface CredentialEgressDeps {
  resolve?: EgressResolver;
  fetchImpl?: typeof fetch;
}

export interface CredentialEgressCheck {
  decision: EgressDecision;
  /** the allow-list the decision was taken against — handed back so the caller
   * can build the guarded fetch from the SAME snapshot it validated against */
  allowList: EgressAllowEntry[];
}

/**
 * Validate a credential-supplied `baseUrl` against the admin egress allow-list.
 *
 * Callers pass the RAW override only. A null/empty `baseUrl` never reaches
 * here: no override means the adapter uses its vendor default endpoint, which
 * is compiled into `packages/model-provider` and is not attacker-controllable,
 * so there is nothing for an allow-list to decide. Requiring an allow entry for
 * `api.anthropic.com` on a deployment that never overrides anything would be
 * pure ceremony — the guard exists for the destinations a human can type.
 */
export async function checkCredentialBaseUrl(
  db: Db,
  baseUrl: string,
  deps: CredentialEgressDeps = {},
): Promise<CredentialEgressCheck> {
  const allowList = await loadEgressAllowList(db);
  const decision = await checkEgress(baseUrl, {
    allowList,
    // no per-credential plaintext flag exists (see the header note) — the host
    // entry's own allow_plaintext_http is the single opt-in on this path
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
  });
  return { decision, allowList };
}

/**
 * The fetch a credential-overridden dispatch must use. Re-validates on EVERY
 * HTTP request the SDK makes, pins plaintext http to the validated address, and
 * refuses redirects — identical semantics to the custom-provider path, because
 * it is literally the same function.
 */
export function credentialGuardedFetch(
  allowList: EgressAllowEntry[],
  deps: CredentialEgressDeps = {},
): typeof fetch {
  return createGuardedFetch({
    allowList,
    ...(deps.resolve ? { resolve: deps.resolve } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
}
