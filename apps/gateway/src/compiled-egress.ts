/**
 * ADR-0062 — ADJUDICATING THE COMPILED VENDOR DEFAULT.
 *
 * `deploy-posture.ts` decides WHETHER this deployment adjudicates a compiled
 * endpoint. This module decides WHAT the verdict is, and it does so against the
 * SAME `egress_allow_hosts` table every other egress surface uses. ADR-0043
 * fought for "one egress policy, one place to reason about it"; a second
 * allow-list would be a second thing to get wrong, so there is not one.
 *
 * ## What is adjudicated, and what deliberately is not
 *
 * The decision here is an ADMISSION decision on the HOST: is this deployment
 * permitted to reach `api.anthropic.com` / `slack.com` / `gitlab.com` at all.
 * It is not, and does not try to be, the SSRF check — that check exists because
 * a *typed* string can point anywhere, and a compiled constant cannot. So this
 * runs no DNS resolution and installs no guarded fetch:
 *
 *  - **No DNS, no address-range check.** There is no rebind window on a
 *    constant: the string cannot change between the check and the connect, and
 *    the address it resolves to is the vendor's business. Resolving here would
 *    add a network round-trip to every dispatch and, on the very box this
 *    feature is for, that lookup is the one that hangs.
 *  - **No transport change.** Under `permissive` the behaviour is byte-identical
 *    to today, down to the fetch implementation. Under `strict` with the host
 *    allow-listed, it is ALSO byte-identical — the deployment said yes, and a
 *    per-request re-validation of a constant would re-derive the same answer.
 *    The surfaces that carry an admin-typed destination (model-credential
 *    overrides, custom providers, connection `baseUrl`s, MCP servers) keep their
 *    guarded, DNS-pinned fetch exactly as ADR-0034/0043 built it.
 *
 * That is the honest scope: this is a per-deployment *permission* on a vendor,
 * layered on top of an SSRF guard, not a second copy of it.
 *
 * ## The tri-state, and why `undefined` refuses
 *
 * Each provider package exposes what its adapter reaches with no override:
 * a URL, `null` for "makes no network call of its own / cannot exist without an
 * explicit already-guarded baseUrl", or `undefined` for **not statically
 * knowable** (today: a Snowflake connector, whose default is derived from the
 * decrypted credential). Under a strict posture `undefined` is a REFUSAL. "We
 * could not work out where this goes" is not a reason to let it go there, and
 * an operator who needs that connector on an air-gapped box types an explicit
 * `baseUrl` — which is the guarded path anyway.
 */

import { auditLog, type Db } from "@regulait/db";
import { normalizeHost, type EgressAllowEntry } from "./egress-guard.js";
import { loadEgressAllowList } from "./custom-providers.js";
import { loadOrgSettings } from "./org-settings.js";
import {
  resolveDeployMode,
  resolveEgressPosture,
  type DeployMode,
  type EgressPosture,
} from "./deploy-posture.js";

const NIL_USER = "00000000-0000-0000-0000-000000000000";

/** ONE stable ruleId across every surface, so a single audit query answers
 * "what did this box refuse to reach on its compiled default, and when". The
 * surface is in `detail`, not in the rule name. */
export const COMPILED_DEFAULT_RULE_ID = "compiled-default-egress-blocked";

/** the surfaces that can run on a compiled vendor endpoint */
export type CompiledEgressSurface =
  | "model"
  | "connector"
  | "git_connection"
  | "pm_connection"
  // ADR-0065: a REMOTE TRAINING BACKEND. It belongs here for exactly the
  // reason the other four do — with no admin-typed baseUrl it reaches the
  // vendor's compiled default, which the SSRF guard never saw because nobody
  // could type it. On an air-gapped install that destination is the whole
  // question, and shipping a training feature that quietly posted the
  // customer's corpus to a SaaS endpoint would be the worst possible way to
  // discover this surface had been left out.
  | "training_backend";

export type CompiledDefaultDenyCode =
  | "compiled_default_not_allowlisted"
  | "compiled_default_unknown";

export interface CompiledDefaultAllowed {
  ok: true;
  /** the host that was adjudicated, or null when there was nothing to decide */
  host: string | null;
}

export interface CompiledDefaultDenied {
  ok: false;
  code: CompiledDefaultDenyCode;
  reason: string;
  host: string | null;
  baseUrl: string | null;
}

export type CompiledDefaultDecision = CompiledDefaultAllowed | CompiledDefaultDenied;

/** what a surface calls its provider column, for a refusal message a human can act on */
const SURFACE_LABEL: Record<CompiledEgressSurface, string> = {
  model: "model provider",
  connector: "connector",
  git_connection: "git connection",
  pm_connection: "PM connection",
  training_backend: "training backend",
};

/**
 * THE PURE DECISION. No database, no DNS, no clock — the allow-list arrives as
 * data, exactly like `checkEgress`, so the adversarial suite can hammer it with
 * neither.
 */
export function decideCompiledDefault(args: {
  posture: EgressPosture;
  surface: CompiledEgressSurface;
  /** the provider/connector kind, for the message only */
  kind: string;
  /** the tri-state from the provider package's registry */
  defaultBaseUrl: string | null | undefined;
  allowList: EgressAllowEntry[];
}): CompiledDefaultDecision {
  // PERMISSIVE IS A NO-OP, and must stay one. Not "allowed after a check" —
  // not checked at all, so a hosted deployment cannot acquire a new failure
  // mode from a table it never populated.
  if (args.posture !== "strict") return { ok: true, host: null };

  // nothing to adjudicate: the adapter makes no outbound call of its own, or
  // cannot be constructed without an explicit (already guarded) baseUrl
  if (args.defaultBaseUrl === null) return { ok: true, host: null };

  const label = SURFACE_LABEL[args.surface];

  if (args.defaultBaseUrl === undefined) {
    return {
      ok: false,
      code: "compiled_default_unknown",
      host: null,
      baseUrl: null,
      reason:
        `${label} kind '${args.kind}' has no statically knowable default endpoint, and this deployment ` +
        `runs the strict egress posture. Set an explicit baseUrl on the row (it is then adjudicated ` +
        `against the egress allow-list like any other typed destination) — a destination we cannot name ` +
        `is refused rather than assumed safe.`,
    };
  }

  let host: string;
  try {
    host = normalizeHost(new URL(args.defaultBaseUrl).hostname);
  } catch {
    return {
      ok: false,
      code: "compiled_default_unknown",
      host: null,
      baseUrl: args.defaultBaseUrl,
      reason:
        `${label} kind '${args.kind}' has a default endpoint ('${args.defaultBaseUrl}') this gateway ` +
        `cannot parse as an absolute URL, and this deployment runs the strict egress posture. Refused.`,
    };
  }
  if (!host) {
    return {
      ok: false,
      code: "compiled_default_unknown",
      host: null,
      baseUrl: args.defaultBaseUrl,
      reason: `${label} kind '${args.kind}' has a default endpoint with no host. Refused under the strict egress posture.`,
    };
  }

  const entry = args.allowList.find((e) => normalizeHost(e.host) === host);
  if (!entry) {
    return {
      ok: false,
      code: "compiled_default_not_allowlisted",
      host,
      baseUrl: args.defaultBaseUrl,
      reason:
        `${label} kind '${args.kind}' would run on its compiled vendor endpoint ` +
        `'${args.defaultBaseUrl}', and host '${host}' is not in the egress allow-list. ` +
        `This deployment runs the strict egress posture, under which a vendor default is a ` +
        `destination like any other: an admin must add '${host}' under Egress Allow Hosts, or ` +
        `point this at a self-hosted endpoint (a custom model provider, or an explicit baseUrl).`,
    };
  }

  return { ok: true, host };
}

/**
 * File the refusal. A deployment that promised nothing leaves, attempting to
 * reach a vendor, is exactly the event a governance product must be able to
 * show afterwards — whether or not a route existed to carry it.
 */
export async function auditCompiledDefaultDenied(
  db: Db,
  args: {
    userId?: string | null;
    surface: CompiledEgressSurface;
    objectId?: string | null;
    kind: string;
    decision: CompiledDefaultDenied;
    posture: EgressPosture;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(auditLog).values({
    userId: args.userId ?? NIL_USER,
    // the audit vocabulary names the OBJECT, not the surface: a model surface
    // files under 'agent', and ADR-0065's training surface files under
    // 'training_job', so "what happened to this training run" stays one query.
    objectType:
      args.surface === "model"
        ? "agent"
        : args.surface === "training_backend"
          ? "training_job"
          : args.surface,
    objectId: args.objectId ?? null,
    detail: {
      ...(args.detail ?? {}),
      phase: "dispatch",
      surface: args.surface,
      kind: args.kind,
      posture: args.posture,
      code: args.decision.code,
      ...(args.decision.baseUrl ? { compiledBaseUrl: args.decision.baseUrl } : {}),
      ...(args.decision.host ? { host: args.decision.host } : {}),
    },
    effect: "deny",
    ruleId: COMPILED_DEFAULT_RULE_ID,
    ruleChain: [],
    reason: args.decision.reason,
  });
}

/** Thrown on the paths (git/PM) whose refusal has to travel out through an
 * existing `catch` rather than becoming an HTTP reply on the spot. */
export class CompiledDefaultEgressBlockedError extends Error {
  constructor(
    readonly surface: CompiledEgressSurface,
    readonly decision: CompiledDefaultDenied,
  ) {
    super(`egress blocked (${decision.code}): ${decision.reason}`);
    this.name = "CompiledDefaultEgressBlockedError";
  }
}

/**
 * The effective posture + the allow-list snapshot it will be decided against,
 * in one call. Both are read fresh per dispatch, deliberately: the env is the
 * floor and the org row is the tightening, and neither is cached anywhere a
 * stale value could outlive a change.
 */
export async function loadCompiledEgressContext(
  db: Db,
): Promise<{ posture: EgressPosture; mode: DeployMode; allowList: EgressAllowEntry[] }> {
  const mode = resolveDeployMode();
  const org = await loadOrgSettings(db);
  const posture = resolveEgressPosture({ mode, orgPolicy: org.egressCompiledDefaultPolicy });
  // PERMISSIVE READS NOTHING ELSE. Under the default posture this must not add
  // a query to a path that never had one.
  const allowList = posture === "strict" ? await loadEgressAllowList(db) : [];
  return { posture, mode, allowList };
}
