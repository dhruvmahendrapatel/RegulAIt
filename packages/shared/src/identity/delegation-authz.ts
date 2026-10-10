/**
 * ADR-0188 decision 23 (slice S3) — the BODY a parent agent signs when it
 * authorises one specific child, and its one canonical form.
 *
 * In a cross-process hand-off (agent A → agent B), A signs a delegation
 * authorization (`typ` `regulait-delegation-authz+jwt`) whose `delegation`
 * claim is the RFC 8785 (JCS) canonical string of exactly what is requested:
 * the scope (`authorization_details`), `resource`, `project_id`, `env`,
 * `cap_micros`, `max_depth` and `expires_at`. The token endpoint (S5) rebuilds
 * the same object from the request body, canonicalises it with the same
 * function, and compares the two strings byte for byte before it claims any
 * `jti` or allocates anything (the check itself is `delegation.ts`).
 *
 * Open source first (ADR-0176): canonicalisation is `canonicalize` 5.1.0
 * (Apache-2.0, RFC 8785), already pinned and admitted in this package
 * (`canonicalize-admission.test.ts`). Nothing here is a hand-written JSON
 * canonicaliser.
 */
import canonicalize from "canonicalize";
import { z } from "zod";
import { DELEGATION_DEPTH_CEILING, delegationScopeSchema, ENVIRONMENT_NAME_PATTERN } from "./contract.js";

/** the largest cap a body may name: a safe integer of micro-dollars */
const MAX_MICROS = Number.MAX_SAFE_INTEGER;

/**
 * Exactly what a parent delegates to a child (decision 23). Every member is
 * required (an absent cap is `null`, never omitted), so two bodies that mean
 * the same thing always canonicalise to the same string.
 */
export const delegationBodySchema = z
  .object({
    /** RFC 9396-style scope; strict semantics (decision 27) */
    authorization_details: delegationScopeSchema.min(1),
    /** RFC 8707 resource: the one audience the child's token will carry */
    resource: z.string().url().max(2048),
    /** the project the chain works in; `null` for none (it must equal the parent's) */
    project_id: z.string().uuid().nullable(),
    /** the environment (it must equal the parent's) */
    env: z.string().regex(ENVIRONMENT_NAME_PATTERN),
    /** the child's allocation in integer micro-dollars; `null` = uncapped (allowed only under an uncapped parent) */
    cap_micros: z.number().int().min(0).max(MAX_MICROS).nullable(),
    /** how many further delegations the child may make below itself */
    max_depth: z.number().int().min(0).max(DELEGATION_DEPTH_CEILING),
    /** the child grant's expiry, epoch seconds (never after the parent's) */
    expires_at: z.number().int().positive(),
  })
  .strict();
export type DelegationBody = z.infer<typeof delegationBodySchema>;

/**
 * The RFC 8785 canonical string of a delegation body: the value of the
 * authorization's `delegation` claim, and what the token endpoint compares it
 * with. Throws on a body that is not a valid `DelegationBody`.
 */
export function canonicalDelegationBody(body: DelegationBody): string {
  const parsed = delegationBodySchema.parse(body);
  const out = canonicalize(parsed);
  if (typeof out !== "string") throw new TypeError("canonicalDelegationBody: not serialisable");
  return out;
}
