/**
 * The kinds the one approvals queue holds, for a filter to offer (lane E23, P-01a of ADR-0251's pending list).
 *
 * `GET /v1/approvals?objectType=` is parsed with `APPROVAL_OBJECT_TYPES`, so the server already knows every kind. The
 * SPA used to keep its own copy of the list, and each kind added since it was written (`model_call`, `engine_run`,
 * `decision_table`, ...) was missing from the filter: still queued and decidable, but impossible to narrow to. This
 * read returns the same enum, with its labels, so the filter can never fall behind it again.
 *
 * Bounded by construction: a fixed list taken from the shared enum, the same for every caller (it names kinds, never
 * rows), so it is cacheable and leaks nothing about what is in anyone's queue. It is a reviewer-facing read, like the
 * queue itself (route-classes).
 */
import type { FastifyInstance } from "fastify";
import { APPROVAL_OBJECT_TYPES, APPROVAL_OBJECT_TYPE_LABELS, type ApprovalObjectType } from "@regulait/shared";

export interface ApprovalKind {
  kind: ApprovalObjectType;
  label: string;
}

/** every queue kind, in the shared enum's order, with what it is in plain words */
export const APPROVAL_KINDS: readonly ApprovalKind[] = Object.freeze(
  APPROVAL_OBJECT_TYPES.map((kind) => Object.freeze({ kind, label: APPROVAL_OBJECT_TYPE_LABELS[kind] })),
);

export function registerApprovalKindRoutes(app: FastifyInstance): void {
  app.get("/v1/approvals/kinds", async (_req, reply) => {
    // the same list for everyone and only changes with a release: let the browser keep it for the session
    reply.header("cache-control", "private, max-age=3600");
    return { kinds: APPROVAL_KINDS };
  });
}
