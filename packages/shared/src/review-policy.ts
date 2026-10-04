/**
 * ADR-0168 amendment (2026-10-03, afternoon) — THE REVIEW POLICY.
 *
 * An admin names reviewer ROLES (privacy, security, legal, model risk…) with
 * their members, and per EU AI Act tier which roles must sign an intake: each
 * role listed for a tier is ONE required review, decidable by any member of
 * that role and never by the proposer. A tier with no roles — or no policy at
 * all — keeps the intake template's single named approver. The same policy
 * names who may ACCEPT RISK on a sign-off, and may shorten or lengthen the
 * approval lifetime per tier.
 *
 * Shapes only: the gateway validates references (users exist, roles used by a
 * tier have members) and stores the policy.
 */
import { z } from "zod";

/** the tier keys a policy can route on — the four screening outcomes plus
 * `unscreened` (no valid answers block, so no computed tier) */
export const REVIEW_POLICY_TIER_KEYS = ["minimal", "limited", "high", "prohibited", "unscreened"] as const;
export type ReviewPolicyTierKey = (typeof REVIEW_POLICY_TIER_KEYS)[number];

export const REVIEW_ROLE_ID_RE = /^[a-z0-9-]{2,40}$/;

export const reviewPolicyRoleSchema = z
  .object({
    id: z.string().regex(REVIEW_ROLE_ID_RE, "role id must be 2-40 characters of a-z, 0-9 and '-'"),
    name: z.string().trim().min(1).max(80),
    memberUserIds: z.array(z.string().uuid()).max(200).default([]),
  })
  .strict();

export const reviewPolicyTierSchema = z
  .object({
    roleIds: z.array(z.string().min(1).max(40)).max(10).default([]),
    /** overrides the ADR-0168 default approval lifetime for this tier */
    validityMonths: z.number().int().min(1).max(36).optional(),
  })
  .strict();

/** `PUT /v1/governance/review-policy`. `updatedAt`/`updatedByName` are
 * read-only and ignored when echoed back. */
export const reviewPolicyInputSchema = z
  .object({
    roles: z.array(reviewPolicyRoleSchema).max(30).default([]),
    tiers: z
      .object({
        minimal: reviewPolicyTierSchema.optional(),
        limited: reviewPolicyTierSchema.optional(),
        high: reviewPolicyTierSchema.optional(),
        prohibited: reviewPolicyTierSchema.optional(),
        unscreened: reviewPolicyTierSchema.optional(),
      })
      .strict()
      .default({}),
    riskAcceptorUserIds: z.array(z.string().uuid()).max(200).default([]),
    updatedAt: z.unknown().optional(),
    updatedByName: z.unknown().optional(),
  })
  .strict();
export type ReviewPolicyInput = z.infer<typeof reviewPolicyInputSchema>;

/** what `GET /v1/governance/review-policy` returns */
export interface ReviewPolicyView {
  roles: Array<{ id: string; name: string; memberUserIds: string[] }>;
  tiers: Partial<Record<ReviewPolicyTierKey, { roleIds: string[]; validityMonths?: number }>>;
  riskAcceptorUserIds: string[];
  updatedAt: string | null;
  updatedByName: string | null;
}

/** one required review of the CURRENT round, as `GET /v1/use-cases/:id` lists it */
export interface UseCaseReviewView {
  roleId: string;
  roleName: string;
  /** `superseded`: another reviewer's denial or return closed the round first */
  status: "pending" | "approved" | "returned" | "denied" | "superseded";
  deciderName: string | null;
  decidedAt: string | null;
  approvalId: string;
}

/** the optional risk acceptance an approving intake reviewer may record */
export const acceptRisksSchema = z
  .object({
    riskIds: z.array(z.string().uuid()).min(1).max(50),
    rationale: z.string().trim().min(10).max(2000),
  })
  .strict();
export type AcceptRisksInput = z.infer<typeof acceptRisksSchema>;

/** `POST /v1/governance/recertification/sweep` — the optional narrowing is for
 * an operator re-running one record; absent = every approved use case */
export const recertificationSweepSchema = z
  .object({ useCaseIds: z.array(z.string().uuid()).min(1).max(500).optional() })
  .strict();
