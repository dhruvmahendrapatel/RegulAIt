/**
 * ADR-0052 — the PURE half of LICENSING & SEAT MANAGEMENT.
 *
 *   THIS FILE                            the license document shape, the
 *                                        validity-window evaluation, the
 *                                        ACTION-CLASS inventory and the
 *                                        split-posture decision, the seat-grant
 *                                        decision, and the tier feature-flag
 *                                        read. Pure — no db, no clock (a `now`
 *                                        is always passed), no crypto, no fs.
 *   `apps/gateway/src/licensing.ts`      the offline Ed25519 verification
 *                                        against a pinned keyring, the db, the
 *                                        API, the enforcement points and the
 *                                        audit rows.
 *
 * THE POSTURE, STATED ONCE, HERE
 *
 *   A license is a COMMERCIAL ceiling on top of the governance ceiling. It can
 *   never GRANT what pillar 1 denies — only cap how many entitled users exist
 *   and which tier features are available (ADR-0052 §2, ADR-0021 "settings only
 *   ever narrow").
 *
 *   On expiry, behaviour splits BY ACTION CLASS rather than by a single switch:
 *
 *     read        always permitted, in every state, including a hard stop.
 *                 A deployment that cannot be read cannot be renewed.
 *     governance  policy evaluation, entitlement checks, approvals, guardrails,
 *                 PII enforcement, AUDIT LOGGING. FAILS OPEN past expiry. This
 *                 is the non-negotiable half: a lapsed invoice must never leave
 *                 AI *less* governed than a paid one, and an audit trail that
 *                 stops recording because of a billing date is a security
 *                 incident caused by an accounting event.
 *     expansion   new seats, newly connected providers/connectors, new agents,
 *                 tier-flag features, any widening of scope. FAILS CLOSED past
 *                 expiry. The footprint freezes and keeps being enforced.
 *
 *   That is "degrade to read-only" in ADR-0041 §8.5's sense — read-only with
 *   respect to GROWTH. It deliberately does not mean "no row is ever written":
 *   the governance layer keeps writing its audit trail, because the alternative
 *   is an outage dressed up as a policy.
 *
 * ABSENCE vs FORGERY — decided deliberately, not defaulted
 *
 *   These are different facts and they get different answers:
 *
 *     ABSENT   (no license installed at all) → the deployment runs UNLICENSED.
 *              Governance is fully operational, every tier feature is CLOSED,
 *              and no seat cap is enforced — because there is no authoritative
 *              number to enforce and inventing one would be a fabricated
 *              policy. Every surface reports `licensed: false`. This is the
 *              stated residual: an operator who never installs a license gets a
 *              fully governed, visibly unlicensed system. Bricking a fresh
 *              install would make the governance layer depend on the commercial
 *              one, which is the exact inversion §5 refuses — and there would be
 *              no way to reach the console to install the license.
 *
 *     FORGED / TAMPERED / WRONG KEY / MALFORMED → REFUSED OUTRIGHT, fail
 *              closed. It is not installed, it does not replace whatever is
 *              already installed, and the refusal is audited. A forged license
 *              that could displace a valid one is the actual attack (expand the
 *              seat cap, unlock a tier, extend an expiry), so "refuse and keep
 *              the previous state" is the only safe answer.
 *
 * WHAT AN OFFLINE LICENSE CANNOT DO — disclosed, not mitigated
 *
 *   It cannot defend against an attacker who owns the control-plane host,
 *   including its clock. That host is the customer's own infrastructure. The
 *   license raises the cost of casual overuse; it is not a DRM fortress, and
 *   pretending otherwise would be the dishonesty ADR-0034 refused.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

export const LICENSE_SCHEMA_ID = "regulait.license/1";

export const LICENSE_DEPLOYMENT_MODES = ["hosted", "byoc", "airgapped"] as const;
export type LicenseDeploymentMode = (typeof LICENSE_DEPLOYMENT_MODES)[number];

/**
 * Tier feature flags. Every one gates a CAPABILITY, never a VENDOR — the
 * standing provider-agnostic principle survives the license: a flag may cap how
 * many model providers or PM adapters a tier connects, never which.
 */
export const LICENSE_FEATURES = [
  "airgapped_mode",
  "sso_saml",
  "scim_provisioning",
  "compliance_packs",
  "advanced_orchestration",
  "custom_model_providers",
] as const;
export type LicenseFeature = (typeof LICENSE_FEATURES)[number];

/** the resolved state of the installed license (or the lack of one) */
export const LICENSE_STATES = ["absent", "not_yet_valid", "valid", "grace", "expired"] as const;
export type LicenseState = (typeof LICENSE_STATES)[number];

/**
 * THE ACTION-CLASS INVENTORY. ADR-0052's "Follow-up" asks for an explicit,
 * reviewed classification before implementation, so it is DATA here rather than
 * scattered `if` statements — a miscategorised path is a real bug, and a list
 * can be reviewed in one screen while scattered conditions cannot.
 */
export const LICENSE_ACTION_CLASSES = ["read", "governance", "expansion"] as const;
export type LicenseActionClass = (typeof LICENSE_ACTION_CLASSES)[number];

export interface ClassifiedAction {
  action: string;
  class: LicenseActionClass;
  why: string;
}

export const LICENSE_ACTION_INVENTORY: ClassifiedAction[] = [
  // --- governance / safety: FAIL OPEN. Never gated by a commercial state. ---
  {
    action: "policy.evaluate",
    class: "governance",
    why: "the gate itself; if it stops, previously-gated agents become UN-gated",
  },
  {
    action: "entitlement.check",
    class: "governance",
    why: "pillar 1's per-user decision — the thing the product exists to do",
  },
  { action: "approval.decide", class: "governance", why: "a pending approval must still be decidable" },
  { action: "guardrail.evaluate", class: "governance", why: "PII/injection enforcement is not a paid feature" },
  { action: "audit.write", class: "governance", why: "an audit trail that stops on a date is a compliance failure" },
  { action: "usage.meter", class: "governance", why: "metering is unconditional (ADR-0024) and feeds the renewal itself" },
  { action: "agent.dispatch", class: "governance", why: "existing committed footprint keeps working, fully governed" },
  { action: "user.deactivate", class: "governance", why: "offboarding must never be blocked by a billing state" },
  // --- expansion: FAIL CLOSED past expiry. Growing the footprint. ---
  { action: "user.provision", class: "expansion", why: "a new entitled user is a new seat" },
  { action: "user.reactivate", class: "expansion", why: "re-consumes a seat, so it is growth" },
  { action: "agent.create", class: "expansion", why: "a newly governed object is a wider footprint" },
  { action: "connector.create", class: "expansion", why: "a new connected system is a wider footprint" },
  { action: "mcp_server.create", class: "expansion", why: "a new tool surface is a wider footprint" },
  { action: "model_provider.connect", class: "expansion", why: "a new provider is a wider footprint" },
  { action: "pm_connection.create", class: "expansion", why: "a new integrated system is a wider footprint" },
  { action: "feature.tier_gated", class: "expansion", why: "tier flags are exactly what is being paid for" },
  // --- read: always permitted, in EVERY state including a hard stop. ---
  { action: "console.read", class: "read", why: "a deployment that cannot be read cannot be renewed" },
  { action: "audit.read", class: "read", why: "evidence retrieval must survive any commercial state" },
  { action: "report.read", class: "read", why: "the record is the customer's, not ours to withhold" },
];

export function classifyAction(action: string): LicenseActionClass {
  return LICENSE_ACTION_INVENTORY.find((a) => a.action === action)?.class ?? "expansion";
}

export const LICENSE_POSTURE_NOTE =
  "On expiry this deployment degrades, it does not stop: the governance/safety/audit layer keeps " +
  "running unchanged (fail OPEN) and commercial EXPANSION is refused (fail CLOSED). A lapsed " +
  "license must never leave AI less governed than a valid one. A missing license is not an error — " +
  "the deployment runs UNLICENSED with every tier feature closed and no seat cap enforced. A " +
  "FORGED or TAMPERED license is refused outright and never displaces the installed one.";

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export const licenseDocumentSchema = z
  .object({
    schema: z.literal(LICENSE_SCHEMA_ID),
    licenseId: z.string().min(1).max(120),
    tenant: z.string().min(1).max(200),
    tier: z.string().min(1).max(60),
    seatCap: z.number().int().min(1).max(1_000_000),
    features: z.array(z.string().min(1).max(60)).max(64).default([]),
    deploymentMode: z.enum(LICENSE_DEPLOYMENT_MODES),
    issuedAt: z.string().datetime(),
    notBefore: z.string().datetime(),
    expiresAt: z.string().datetime(),
    graceDays: z.number().int().min(0).max(365),
    /** OPT-IN, never the default. A customer whose own contract requires the
     * system to stop can ask for it; the default for a governance product must
     * be "stay governed". */
    hardStopOnExpiry: z.boolean().default(false),
  })
  .strict()
  .refine((d) => new Date(d.expiresAt).getTime() > new Date(d.notBefore).getTime(), {
    message: "expiresAt must be after notBefore",
  });
export type LicenseDocument = z.infer<typeof licenseDocumentSchema>;

/**
 * Deterministic bytes for a license body — used when PRODUCING a license (the
 * signing script, the tests) so both sides agree on what was signed.
 *
 * It is deliberately NOT part of the verification path. Verification checks the
 * signature over the EXACT BYTES that were delivered, exactly as
 * `scripts/verify-update-bundle.sh` verifies over the exact manifest bytes:
 * "the authority is the SIGNATURE over the exact bytes, not the parse". A
 * verifier that re-canonicalised before checking would accept a document whose
 * delivered bytes differ from what was signed, which is a whole class of bug
 * that simply does not exist here.
 */
export function canonicalLicenseBytes(doc: LicenseDocument): string {
  const ordered: Record<string, unknown> = {};
  for (const k of Object.keys(doc).sort()) ordered[k] = (doc as Record<string, unknown>)[k];
  if (Array.isArray(ordered.features)) ordered.features = [...(ordered.features as string[])].sort();
  return JSON.stringify(ordered);
}

// ---------------------------------------------------------------------------
// The validity window
// ---------------------------------------------------------------------------

export interface WindowEvaluation {
  state: Exclude<LicenseState, "absent">;
  notBefore: string;
  expiresAt: string;
  graceEndsAt: string;
  /** days until the next state transition; negative once past it */
  daysRemaining: number;
  reason: string;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * The host clock decides. That is an accepted residual, disclosed in the ADR
 * and repeated here: an offline license cannot defend against an attacker who
 * owns the clock of the machine it runs on.
 */
export function evaluateLicenseWindow(doc: LicenseDocument, now: Date): WindowEvaluation {
  const nb = new Date(doc.notBefore).getTime();
  const exp = new Date(doc.expiresAt).getTime();
  const graceEnds = exp + doc.graceDays * DAY_MS;
  const t = now.getTime();
  const base = {
    notBefore: doc.notBefore,
    expiresAt: doc.expiresAt,
    graceEndsAt: new Date(graceEnds).toISOString(),
  };
  if (t < nb) {
    return {
      ...base,
      state: "not_yet_valid",
      daysRemaining: (nb - t) / DAY_MS,
      reason:
        `this license does not take effect until ${doc.notBefore}. Governance runs unchanged; ` +
        "commercial expansion is refused until it starts.",
    };
  }
  if (t < exp) {
    return {
      ...base,
      state: "valid",
      daysRemaining: (exp - t) / DAY_MS,
      reason: `valid until ${doc.expiresAt}`,
    };
  }
  if (t < graceEnds) {
    return {
      ...base,
      state: "grace",
      daysRemaining: (graceEnds - t) / DAY_MS,
      reason:
        `EXPIRED on ${doc.expiresAt}; inside the ${doc.graceDays}-day grace window, which ends ` +
        `${new Date(graceEnds).toISOString()}. Everything still works and the warnings escalate.`,
    };
  }
  return {
    ...base,
    state: "expired",
    daysRemaining: (graceEnds - t) / DAY_MS,
    reason:
      `EXPIRED on ${doc.expiresAt} and the ${doc.graceDays}-day grace window has run out. The ` +
      "deployment stays fully governed and fully audited; it can no longer grow." +
      (doc.hardStopOnExpiry ? " hardStopOnExpiry was opted into: governance actions are refused too." : ""),
  };
}

// ---------------------------------------------------------------------------
// The split-posture decision
// ---------------------------------------------------------------------------

export interface LicenseDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
  state: LicenseState;
  actionClass: LicenseActionClass;
}

export interface LicenseDecisionInput {
  /** null = nothing installed */
  license: LicenseDocument | null;
  state: LicenseState;
  actionClass: LicenseActionClass;
}

/**
 * The ONE place the split posture is decided. Every enforcement point calls
 * this rather than re-deriving the rule, because §Consequences says plainly
 * that a miscategorised path is a real bug — and two copies of a rule are how
 * one of them ends up miscategorised.
 */
export function evaluateLicensedAction(input: LicenseDecisionInput): LicenseDecision {
  const { state, actionClass } = input;
  const base = { state, actionClass };

  // READ is unconditional, in every state, including a hard stop. A deployment
  // that cannot be read cannot be renewed, and the customer's own audit record
  // is not ours to withhold over an invoice.
  if (actionClass === "read") {
    return { ...base, allowed: true, ruleId: "license-read-always-permitted", reason: "reads are never license-gated" };
  }

  if (!input.license) {
    // ABSENCE IS NOT AN ERROR. Governance runs; expansion is not capped because
    // there is no authoritative cap to apply. Tier features are closed
    // elsewhere (`featureEnabled`), which is where absence actually bites.
    return {
      ...base,
      allowed: true,
      ruleId: "license-absent-unlicensed",
      reason:
        "no license is installed: this deployment runs UNLICENSED. Governance is fully operational, " +
        "no seat cap is enforced (there is no authoritative number to enforce), and every tier " +
        "feature is closed. Install a signed license to make seats and tier features real.",
    };
  }

  if (state === "expired") {
    if (actionClass === "governance") {
      if (input.license.hardStopOnExpiry) {
        return {
          ...base,
          allowed: false,
          ruleId: "license-hard-stop",
          reason:
            "this license carries the OPT-IN hardStopOnExpiry flag and its grace window has run out. " +
            "This is not the default and is never applied unless a customer asked for it; reads " +
            "remain permitted so the deployment can be renewed.",
        };
      }
      return {
        ...base,
        allowed: true,
        ruleId: "license-expired-governance-fails-open",
        reason:
          "the license has expired past its grace window. Governance, approvals, guardrails and audit " +
          "logging keep running UNCHANGED — a billing lapse must never become an AI-governance outage.",
      };
    }
    return {
      ...base,
      allowed: false,
      ruleId: "license-expired-no-expansion",
      reason:
        "the license has expired past its grace window, so the deployment is frozen at its current " +
        "committed footprint: no new seats, connectors, agents, providers or tier features. " +
        "Everything already governed stays governed and stays audited.",
    };
  }

  if (state === "not_yet_valid" && actionClass === "expansion") {
    return {
      ...base,
      allowed: false,
      ruleId: "license-not-yet-valid-no-expansion",
      reason: "this license has not taken effect yet, so it grants no expansion headroom",
    };
  }

  if (state === "grace") {
    return {
      ...base,
      allowed: true,
      ruleId: "license-grace-permitted",
      reason:
        "the license has expired but is inside its grace window: everything continues to work and the " +
        "warnings escalate. The grace window exists so a courier delay cannot take a remote site down.",
    };
  }

  return { ...base, allowed: true, ruleId: "license-valid", reason: "the license is valid" };
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

export interface SeatDecision {
  allowed: boolean;
  ruleId: string;
  reason: string;
  activeSeats: number;
  seatCap: number | null;
  remaining: number | null;
}

export const SEAT_DEFINITION_NOTE =
  "A seat is an ACTIVE user — a row in `users` with no `disabled_at`. Deactivate is not delete " +
  "(ADR-0022): a disabled user keeps every FK, audit row and history, cannot authenticate and " +
  "cannot dispatch, and therefore consumes NO seat. There is exactly one implementation of this " +
  "count and ADR-0051's billing consumes the same number.";

/**
 * Seat enforcement is a GROWTH gate, never a SERVICE gate (ADR-0052 §3).
 *
 * Existing seats keep working under every outcome below. Nothing in this
 * function can revoke, disable, or degrade an already-entitled user — going
 * over cap (which happens legitimately when a smaller license is installed onto
 * a larger deployment) refuses the NEXT provisioning and touches nobody.
 */
export function evaluateSeatGrant(input: {
  license: LicenseDocument | null;
  state: LicenseState;
  activeSeats: number;
}): SeatDecision {
  if (!input.license) {
    return {
      allowed: true,
      ruleId: "license-absent-seat-cap-unenforced",
      reason:
        "no license is installed, so there is no authoritative seat cap to enforce. Inventing one " +
        "would be a fabricated policy; the deployment is reported as UNLICENSED instead.",
      activeSeats: input.activeSeats,
      seatCap: null,
      remaining: null,
    };
  }
  const cap = input.license.seatCap;
  const remaining = cap - input.activeSeats;

  // expiry is decided FIRST: past grace, provisioning is expansion and is
  // refused whether or not there is headroom.
  const gate = evaluateLicensedAction({ license: input.license, state: input.state, actionClass: "expansion" });
  if (!gate.allowed) {
    return {
      allowed: false,
      ruleId: gate.ruleId,
      reason: gate.reason,
      activeSeats: input.activeSeats,
      seatCap: cap,
      remaining,
    };
  }

  if (input.activeSeats >= cap) {
    return {
      allowed: false,
      ruleId: "seat_cap_reached",
      reason:
        `this deployment is licensed for ${cap} seat(s) and ${input.activeSeats} are active. ` +
        "Provisioning a new entitled user is refused; every existing user is untouched and stays " +
        "fully governed. Deactivating a user frees their seat (ADR-0022: deactivate is not delete).",
      activeSeats: input.activeSeats,
      seatCap: cap,
      remaining,
    };
  }

  return {
    allowed: true,
    ruleId: "seat-grant-within-cap",
    reason: `${input.activeSeats} of ${cap} seat(s) in use; ${remaining} remaining`,
    activeSeats: input.activeSeats,
    seatCap: cap,
    remaining,
  };
}

// ---------------------------------------------------------------------------
// Tier feature flags
// ---------------------------------------------------------------------------

export interface FeatureDecision {
  enabled: boolean;
  ruleId: string;
  reason: string;
}

/**
 * DEFAULT CLOSED for any flag absent from the license (§4) — an older license
 * simply does not unlock newer paid features rather than failing. Absence of a
 * license closes everything, and expiry closes everything, because a tier flag
 * is exactly what is being paid for.
 */
export function featureEnabled(
  license: LicenseDocument | null,
  feature: string,
  state: LicenseState,
): FeatureDecision {
  if (!license) {
    return {
      enabled: false,
      ruleId: "license-absent-feature-closed",
      reason: `'${feature}' is a tier-gated feature and no license is installed — default CLOSED`,
    };
  }
  const gate = evaluateLicensedAction({ license, state, actionClass: "expansion" });
  if (!gate.allowed) {
    return { enabled: false, ruleId: gate.ruleId, reason: `'${feature}' is tier-gated: ${gate.reason}` };
  }
  if (!license.features.includes(feature)) {
    return {
      enabled: false,
      ruleId: "license-feature-not-granted",
      reason: `'${feature}' is not in this license's feature set (tier '${license.tier}') — default CLOSED`,
    };
  }
  return { enabled: true, ruleId: "license-feature-granted", reason: `'${feature}' is granted by tier '${license.tier}'` };
}

// ---------------------------------------------------------------------------
// Write shapes
// ---------------------------------------------------------------------------

/**
 * The installable artifact. `documentBase64` carries the EXACT bytes that were
 * signed, so nothing between the signer and the verifier can reformat them —
 * a JSON string field would let a proxy, a shell or a text editor change
 * whitespace and silently break a signature that was never actually attacked.
 */
export const installLicenseSchema = z
  .object({
    documentBase64: z.string().min(1).max(64_000),
    signature: z.string().min(1).max(4096),
    signingKeyId: z
      .string()
      .min(1)
      .max(120)
      // the key id names a FILE in the pinned keyring, so its shape is
      // constrained before it is ever used to build a path. This is the same
      // guard scripts/verify-update-bundle.sh applies, for the same reason.
      .regex(/^[A-Za-z0-9._-]+$/, "a signingKeyId may contain only [A-Za-z0-9._-]"),
  })
  .strict();
export type InstallLicense = z.infer<typeof installLicenseSchema>;
