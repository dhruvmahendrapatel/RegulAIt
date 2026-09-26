/**
 * ADR-0084 — THE AI VENDOR REGISTRY (third-party AI risk), the pure half.
 *
 *   THIS FILE                       the category/status vocabulary, the
 *                                   request schemas, and the disclaimer that
 *                                   must ride on every attested checklist.
 *                                   Pure — no db, no clock.
 *   `apps/gateway/src/vendors.ts`   the registry API, the pillar-2 assessment
 *                                   join, the audited attestation recording,
 *                                   the audit rows.
 *
 * THE ONE PROPERTY THIS MODULE EXISTS TO GUARANTEE: a vendor's answers are
 * ATTESTATIONS, never evidence. Every vendor-supplied pack-control answer is
 * recorded with attribution (who recorded it, when, from which questionnaire
 * version) and rendered under the disclaimer below — and nothing in the
 * compliance-pack scorecard/report machinery ever reads them, because a
 * vendor's "we are certified" blended into our computed evidence would
 * fabricate satisfaction (the exact overclaim ADR-0058 refuses).
 *
 * Note what is conspicuously ABSENT from every schema here: `status`.
 * approved/rejected are reached only through the linked assessment instance's
 * decision on the one approvals queue (the ADR-0080 discipline), and
 * retirement has its own audited endpoint.
 */
import { z } from "zod";

export const AI_VENDOR_STATUSES = [
  "proposed",
  "under_assessment",
  "approved",
  "rejected",
  "retired",
] as const;
export type AiVendorStatus = (typeof AI_VENDOR_STATUSES)[number];

/** what kind of third party this is — honestly small, chosen by how the
 * vendor's AI touches us rather than by a procurement taxonomy */
export const AI_VENDOR_CATEGORIES = [
  /** a model provider our agents call (directly or via a custom endpoint) */
  "model_provider",
  /** a product we use whose features run AI on our data */
  "ai_feature_vendor",
  /** a processor our data reaches (sub-processing, enrichment, hosting) */
  "data_processor",
  /** an integration that moves data between systems with AI in the path */
  "integration",
] as const;
export type AiVendorCategory = (typeof AI_VENDOR_CATEGORIES)[number];

/**
 * The load-bearing honesty clause — a FIELD on every attested checklist and
 * on every attestation write response, never a footer somebody can strip
 * (the ADR-0058 pattern).
 */
export const AI_VENDOR_ATTESTATION_DISCLAIMER =
  "Vendor-attested — not verified by this platform. Every answer here is a claim the vendor " +
  "supplied, recorded by a named user from the assessment questionnaire; none of it is computed " +
  "from this deployment's ledgers, none of it feeds any compliance-pack scorecard or report, " +
  "and an approved assessment records that a human signed off on the vendor's claims — not " +
  "that the claims are true.";

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

export const createVendorSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(4000),
  category: z.enum(AI_VENDOR_CATEGORIES),
  /** admin-registered custom model providers (ADR-0034) this vendor
   * corresponds to — validated server-side */
  linkedCustomProviderIds: z.array(z.string().uuid()).max(20).default([]),
  /** provider keys as they appear on agents.provider — a linkage hint */
  linkedAgentProviders: z.array(z.string().min(1).max(100)).max(20).default([]),
});
export type CreateVendorInput = z.infer<typeof createVendorSchema>;

/** editable while the assessment is in flight; `status` is NOT here on
 * purpose — the gateway refuses a body naming it with a 422 that points at
 * the decide path, rather than silently dropping the key */
export const updateVendorSchema = z.object({
  description: z.string().min(1).max(4000).optional(),
  category: z.enum(AI_VENDOR_CATEGORIES).optional(),
  linkedCustomProviderIds: z.array(z.string().uuid()).max(20).optional(),
  linkedAgentProviders: z.array(z.string().min(1).max(100)).max(20).optional(),
});
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;

export const retireVendorSchema = z.object({
  reason: z.string().min(1).max(2000),
});

/** record ONE vendor-supplied answer against one pack control. The gateway
 * validates the control against the framework's ACTIVE pack (read-only reuse
 * of the ADR-0058 data model) and refuses to record anything before the
 * assessment questionnaire artifact exists — the attribution names the
 * questionnaire version the answer came from. */
export const recordVendorAttestationSchema = z.object({
  framework: z.string().min(1).max(64),
  controlRef: z.string().min(1).max(200),
  /** the vendor's claim, verbatim as supplied */
  statement: z.string().min(1).max(4000),
  /** the vendor's own reference (a report id, a cert number, a URL) */
  evidenceRef: z.string().max(500).optional(),
});
export type RecordVendorAttestationInput = z.infer<typeof recordVendorAttestationSchema>;
