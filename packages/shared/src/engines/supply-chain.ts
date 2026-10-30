/**
 * ADR-0216 (P14 + P15) — THE MODEL SUPPLY-CHAIN CHECK, the pure half.
 *
 * A model artifact passes only when all three hold:
 *   signed        its newest signature verifies, in the OpenSSF model-signing format (v1.0 predicate), against a
 *                 trust root an admin configured and has not revoked, and names this artifact's sha256;
 *   scanned       a scan of it completed (a conclusive verdict: `clean`, `no_known_unsafe` or `unsafe`);
 *   safe format   its format, decided from its bytes, can hold no code (the `clean` ceiling) and no scan of it
 *                 found an unsafe operator.
 * A failing condition is covered only by an admin's per-artifact relaxation that names it and has not expired
 * (ADR-0180: a stated reason, a step-up, at most 30 days). Anything not covered blocks every model whose card cites
 * the artifact, at dispatch and at sign-off. The gateway half is `apps/gateway/src/model-supply-chain.ts`.
 */
import { z } from "zod";
import { ARTIFACT_FORMAT_PLANS, type ArtifactFormat } from "./modelscan.js";

export const SUPPLY_CHAIN_CONDITIONS = ["unsigned", "unscanned", "unsafe_format"] as const;
export type SupplyChainCondition = (typeof SUPPLY_CHAIN_CONDITIONS)[number];

/** customer copy for each failing condition */
export const SUPPLY_CHAIN_CONDITION_LABELS: Readonly<Record<SupplyChainCondition, string>> = Object.freeze({
  unsigned: "No valid signature from a trusted key",
  unscanned: "No completed scan",
  unsafe_format: "A format that can run code, or an unsafe finding",
});

/** the most a relaxation may run (ADR-0180; the database CHECK repeats it) */
export const SUPPLY_CHAIN_RELAXATION_MAX_DAYS = 30;

/** why a presented signature did not verify (`model_artifact_signatures.failure`) */
export const MODEL_SIGNATURE_FAILURES = [
  "bundle_malformed",
  "unsupported_bundle",
  "unknown_key",
  "key_revoked",
  "signature_invalid",
  "unsupported_predicate",
  "manifest_inconsistent",
  "digest_mismatch",
] as const;
export type ModelSignatureFailure = (typeof MODEL_SIGNATURE_FAILURES)[number];

export const MODEL_SIGNATURE_FAILURE_LABELS: Readonly<Record<ModelSignatureFailure, string>> = Object.freeze({
  bundle_malformed: "The signature bundle could not be read",
  unsupported_bundle: "Only key-based signatures can be checked here",
  unknown_key: "Signed by a key that is not a trusted signing key",
  key_revoked: "Signed by a signing key that has been revoked",
  signature_invalid: "The signature does not match its contents",
  unsupported_predicate: "Not a model signature in the supported format",
  manifest_inconsistent: "The signed file list does not match its own digest",
  digest_mismatch: "The signature does not cover this file",
});

/** scan verdicts that mean a scan completed */
const CONCLUSIVE_SCAN_VERDICTS: ReadonlySet<string> = new Set(["clean", "no_known_unsafe", "unsafe"]);

export interface SupplyChainInput {
  format: string;
  /** the newest signature re-verified now: true only when it verifies against a live trust root */
  signatureVerified: boolean;
  /** every scan verdict recorded for the artifact */
  scanVerdicts: readonly string[];
  /** the relaxation not cleared, if any */
  relaxation: { conditions: readonly string[]; expiresAt: Date } | null;
  now: Date;
}

export interface SupplyChainAssessment {
  /** conditions that fail, before any relaxation */
  failing: SupplyChainCondition[];
  /** failing conditions no relaxation in force covers: non-empty = blocked */
  uncovered: SupplyChainCondition[];
  passes: boolean;
  /** a relaxation is in force and covers at least one failing condition */
  relaxed: boolean;
  /** a relaxation exists but has expired (it covers nothing) */
  relaxationExpired: boolean;
}

export function assessArtifactSupplyChain(input: SupplyChainInput): SupplyChainAssessment {
  const failing: SupplyChainCondition[] = [];
  if (!input.signatureVerified) failing.push("unsigned");
  if (!input.scanVerdicts.some((v) => CONCLUSIVE_SCAN_VERDICTS.has(v))) failing.push("unscanned");
  const plan = (ARTIFACT_FORMAT_PLANS as Record<string, (typeof ARTIFACT_FORMAT_PLANS)[ArtifactFormat] | undefined>)[input.format];
  if (!plan || plan.executable || plan.ceiling !== "clean" || input.scanVerdicts.includes("unsafe")) failing.push("unsafe_format");
  const inForce = input.relaxation !== null && input.relaxation.expiresAt.getTime() > input.now.getTime();
  const covered = new Set(inForce ? input.relaxation!.conditions : []);
  const uncovered = failing.filter((c) => !covered.has(c));
  return {
    failing,
    uncovered,
    passes: uncovered.length === 0,
    relaxed: inForce && failing.some((c) => covered.has(c)),
    relaxationExpired: input.relaxation !== null && !inForce,
  };
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

/** POST /v1/model-artifacts/:artifactId/signature — a Sigstore bundle (JSON), as the signing tool writes it */
export const attachModelSignatureSchema = z.object({ bundle: z.record(z.string(), z.unknown()) }).strict();

/** POST /v1/model-signing-keys — an ECDSA P-256 public key (SPKI PEM) */
export const createModelSigningKeySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    publicKeyPem: z.string().trim().min(1).max(4096),
  })
  .strict();

/** PUT /v1/model-artifacts/:artifactId/supply-chain-relaxation */
export const relaxModelSupplyChainSchema = z
  .object({
    conditions: z.array(z.enum(SUPPLY_CHAIN_CONDITIONS)).min(1).max(3),
    reason: z.string().trim().min(1).max(1000),
    /** default and maximum: 30 days from now */
    expiresAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
