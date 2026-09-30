/**
 * ADR-0058 — REGULATORY COMPLIANCE PACKS, the pure half.
 *
 *   THIS FILE                                   the pack/control vocabulary, the
 *                                               collector vocabulary, the
 *                                               satisfaction rule, the scorecard
 *                                               arithmetic, the seed packs, and
 *                                               the disclaimer that has to ride
 *                                               on every artifact. No db, no
 *                                               clock, no Fastify.
 *   `apps/gateway/src/compliance-packs.ts`      the evidence QUERIES (the real
 *                                               ledger SELECTs), the pack admin
 *                                               API, the entitlement decision,
 *                                               the report ledger, the audit rows.
 *
 * THE FOUR RULES THIS MODULE EXISTS TO MAKE STRUCTURAL
 * ---------------------------------------------------
 *  1. A PACK IS DATA, NOT CODE. A pack is rows: one `compliance_packs` row plus
 *     N `compliance_pack_controls` rows. `DEFAULT_COMPLIANCE_PACKS` below is a
 *     SEED — the same shape an admin POSTs — not a hard-coded catalogue the
 *     evaluator reads. Delete every pack row and the evaluator evaluates
 *     nothing; POST a framework nobody has ever heard of and it is evaluated on
 *     the next call, with no deploy. What is NOT data is the COLLECTOR
 *     vocabulary: a collector is a named, parameterised query over a ledger
 *     that already exists, and a genuinely new evidence SOURCE still needs
 *     code. That boundary is stated in `COMPLIANCE_PACK_UPDATE_POLICY` rather
 *     than left for a customer to discover.
 *
 *  2. EVIDENCE IS COUNTED, NEVER ASSERTED. `assessPackControl` takes an
 *     evidence COUNT that the gateway got from a SELECT and compares it to the
 *     control's own threshold. There is no admin-settable "satisfied" flag
 *     anywhere in the schema — the only way a control goes green is for rows to
 *     exist in the period, and the only way it goes back to red is for them not
 *     to.
 *
 *  3. AN ORGANISATIONAL CONTROL CAN NEVER GO GREEN BY ITSELF. Training
 *     programmes, governance committees, incident-response runbooks and
 *     post-market monitoring are not observable from a control plane. Those
 *     controls carry `attestationRequired` and resolve to `attestation_required`
 *     or `attested` — NEVER to `satisfied`, and an attestation is stamped with
 *     the human who made it. ADR-0058's "partial coverage is the norm, and the
 *     scorecard must not hide it" is enforced here, in the status function, not
 *     described in a doc.
 *
 *  4. THE ARTIFACT NEVER SAYS "COMPLIANT". `buildPackScorecard` emits counts
 *     and a `statement`; there is no verdict field, no boolean, no percentage
 *     dressed up as a grade. `COMPLIANCE_PACK_DISCLAIMER` rides on every
 *     scorecard object, so a console cannot render the numbers without the
 *     framing. Producing an EU AI Act control-mapping report is not being
 *     compliant with the EU AI Act and is not a certification of anything.
 */
import { z } from "zod";
// batch B1 — a pack's cascade PRESET is validated with the SAME check every
// compliance-profile version body passes: only enforcing profile columns,
// correctly typed, selection (`tag`) refused. One validator, not two.
import { validateRuleVersionBody } from "./config-versions.js";

// ---------------------------------------------------------------------------
// Vocabularies
// ---------------------------------------------------------------------------

/**
 * The frameworks the launch packs cover. This list is a CONVENIENCE for the
 * seed and for the admin console's picker — `compliance_packs.framework` is a
 * free-text column on purpose, because ADR-0058 §5 requires a customer's own
 * internal control framework to be a first-class pack.
 */
export const COMPLIANCE_PACK_FRAMEWORKS = [
  "eu-ai-act",
  "nist-ai-rmf",
  "iso-42001",
  "iso-27001",
  "hipaa",
  "pci-dss",
  "finra",
  "soc-2",
  "custom",
] as const;
export type CompliancePackFramework = (typeof COMPLIANCE_PACK_FRAMEWORKS)[number];

/**
 * THE COLLECTOR VOCABULARY — the honest boundary of "packs are data".
 *
 * Each id names a parameterised query the gateway knows how to run against a
 * ledger that ALREADY EXISTS. A pack picks a collector and supplies params; it
 * cannot invent a new one, and it cannot write SQL. That is deliberate: a pack
 * is untrusted-ish data authored by a compliance analyst, and a pack that could
 * express arbitrary SQL would be an injection primitive dressed as a control
 * mapping.
 *
 * `none` is the collector for an organisational control. It is the only
 * collector that returns no count, and it pairs with `attestationRequired`.
 */
export const EVIDENCE_COLLECTORS = [
  /** rows in `audit_log` in the period, optionally filtered by effect / object
   * type / rule-id prefix — the record-keeping and human-oversight evidence */
  "audit_decisions",
  /** `approvals` rows in the period, optionally filtered by status — the
   * human-in-the-loop evidence */
  "approvals",
  /** approved, unexpired `model_card_approvals` — ADR-0045's risk sign-off */
  "model_cards_approved",
  /** `eval_runs` started in the period — ADR-0044's measured quality evidence */
  "eval_runs",
  /** `guardrail_configs` rows at or above a required mode — ADR-0042 runtime
   * safety controls, evidenced by CONFIGURATION rather than by events */
  "guardrail_configs",
  /** ABAC policies in the active set — ADR-0041 attribute-based access control */
  "abac_policies_active",
  /** `lineage_edges` in the period — ADR-0048 data-provenance evidence */
  "lineage_edges",
  /** `usage_events` in the period carrying a project attribution — pillar 5 */
  "attributed_usage",
  /** `compliance_profiles` whose cascade actually forces a posture (pii mode,
   * retention floor, guardrail floor) — evidence that the §8.3 cascade is
   * configured, not merely available */
  "compliance_profile_cascade",
  /** NOT AUTO-EVIDENCED. Pairs with attestationRequired. */
  "none",
] as const;
export type EvidenceCollectorId = (typeof EVIDENCE_COLLECTORS)[number];

/**
 * The mapping author's DECLARED posture for a control — how far platform
 * configuration can go, independent of whether evidence happens to exist today.
 * ADR-0058 §4's enforced / evidenced / partial / unaddressed model.
 */
export const CONTROL_COVERAGE_CLASSES = ["enforced", "evidenced", "partial", "unaddressed"] as const;
export type ControlCoverageClass = (typeof CONTROL_COVERAGE_CLASSES)[number];

/**
 * The COMPUTED status of a control for one evaluation. Note what is not here:
 * there is no `compliant`, and `attestation_required`/`attested` are separate
 * from `satisfied` so an organisational control can never be counted with the
 * auto-evidenced ones.
 */
export const CONTROL_EVALUATION_STATUSES = [
  "satisfied",
  "unsatisfied",
  "attestation_required",
  "attested",
  "unaddressed",
] as const;
export type ControlEvaluationStatus = (typeof CONTROL_EVALUATION_STATUSES)[number];

export const PACK_STATUSES = ["draft", "active", "retired"] as const;
export type PackStatus = (typeof PACK_STATUSES)[number];

/**
 * GOVERNANCE_LAYER_SPEC §8.3 + ADR-0058's load-bearing honesty clause. This
 * string is a FIELD on every scorecard and every stored pack report, not a
 * footer somebody can strip.
 */
export const COMPLIANCE_PACK_DISCLAIMER =
  "This is a CONTROL-MAPPING REPORT, not a compliance certification. RegulAIt maps a framework's " +
  "controls onto platform configuration and counts the evidence its own ledgers hold. It does not " +
  "certify compliance, does not substitute for an auditor or for legal counsel, and does not shift " +
  "legal responsibility. Controls marked attestation-required cannot be evidenced by any control " +
  "plane and are the customer's own responsibility. The customer and their qualified advisors own " +
  "the final determination.";

/**
 * HOW A PACK IS UPDATED WITHOUT A RELEASE — stated in the code because a
 * customer's first question about "versioned data" is "so how does it change".
 */
export const COMPLIANCE_PACK_UPDATE_POLICY =
  "A pack is rows, not a build artifact. A framework revision is published as a NEW pack row with " +
  "the same `framework` and a higher `version`, its controls posted alongside it, and then " +
  "activated — which retires the previous version in the same transaction. Reports already " +
  "generated keep the pack version that produced them, so a revision never rewrites history. " +
  "Adding a framework nobody shipped (a customer's internal control set) is the same POST with a " +
  "new `framework` string and needs no code change. The ONE thing a pack cannot add by data alone " +
  "is a new evidence SOURCE: collectors are a fixed, parameterised vocabulary over ledgers that " +
  "already exist, so a control needing a ledger RegulAIt does not keep must be marked " +
  "attestation-required rather than silently reported as satisfied.";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** the parameters a collector accepts. Deliberately a closed, scalar-only set —
 * this is data an analyst authors, and it must not be able to express a query. */
export const collectorParamsSchema = z
  .object({
    /** audit_decisions: 'allow' | 'deny' */
    effect: z.enum(["allow", "deny"]).optional(),
    /** audit_decisions: exact object_type match */
    objectType: z.string().min(1).max(64).optional(),
    /** audit_decisions: rule_id prefix match (e.g. 'pii-') */
    ruleIdPrefix: z.string().min(1).max(128).optional(),
    /** approvals: exact status match */
    status: z.enum(["pending", "approved", "denied", "consumed", "superseded"]).optional(),
    /** approvals: exact object_type match */
    approvalObjectType: z.string().min(1).max(64).optional(),
    /** guardrail_configs: which detector must be at or above `minMode` */
    detector: z.enum(["prompt_injection", "jailbreak", "toxicity", "semantic_dlp"]).optional(),
    minMode: z.enum(["log", "warn", "block"]).optional(),
    /** compliance_profile_cascade: the posture the cascade must actually force */
    cascadeAspect: z.enum(["pii_block", "retention", "guardrail_floor", "budget_ceiling"]).optional(),
    /** lineage_edges: exact kind match */
    edgeKind: z.string().min(1).max(64).optional(),
  })
  .strict();
export type CollectorParams = z.infer<typeof collectorParamsSchema>;

export const packControlSchema = z
  .object({
    /** the framework's OWN identifier for the control — 'eu-ai-act:art-12' */
    controlRef: z.string().min(1).max(200),
    title: z.string().min(1).max(400),
    description: z.string().max(4000).nullish(),
    coverage: z.enum(CONTROL_COVERAGE_CLASSES),
    collector: z.enum(EVIDENCE_COLLECTORS),
    collectorParams: collectorParamsSchema.default({}),
    /** how many evidence rows the period must hold for the control to be
     * satisfied. 1 is the honest default: "did this happen at all". */
    minEvidenceCount: z.number().int().min(1).max(1_000_000).default(1),
    /** TRUE = organisational control. Can never be auto-satisfied. */
    attestationRequired: z.boolean().default(false),
    /** what the customer, not RegulAIt, has to do */
    ownerNote: z.string().max(4000).nullish(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.attestationRequired && c.collector !== "none") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "an attestation-required control must use the 'none' collector — pairing it with a real " +
          "collector would let ledger rows quietly satisfy an organisational control",
      });
    }
    if (!c.attestationRequired && c.collector === "none" && c.coverage !== "unaddressed") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "a control with no collector is either attestation-required or explicitly 'unaddressed' — " +
          "there is no third option that silently reports as satisfied",
      });
    }
  });
export type PackControlInput = z.infer<typeof packControlSchema>;

export const createCompliancePackSchema = z
  .object({
    framework: z.string().min(1).max(64),
    version: z.number().int().min(1).max(10_000),
    title: z.string().min(1).max(300),
    description: z.string().max(4000).nullish(),
    /** where this mapping came from — a catalogue revision, a consultancy, a
     * customer's own GRC team. Provenance is what makes staleness legible. */
    provenance: z
      .object({
        source: z.string().min(1).max(300),
        catalogueRevision: z.string().max(200).nullish(),
        reviewedBy: z.string().max(300).nullish(),
        reviewedOn: z.string().max(40).nullish(),
        note: z.string().max(2000).nullish(),
      })
      .strict(),
    /** the §8.3 cascade tag this pack drives. A pack does NOT enforce anything
     * itself: tagging with this drives the EXISTING cascade. Null = the pack is
     * evidence-only. */
    cascadeTag: z.string().min(1).max(120).nullish(),
    /** batch B1 (ADR-0058 §2's preset half) — the compliance-profile STARTING
     * POINT the pack's cascade tag seeds on activation: a partial map of
     * enforcing `compliance_profiles` columns. Activation FIND-OR-CREATES the
     * profile from this and never overwrites an existing one. Null/omitted =
     * the pack ships no starting profile and the admin authors it, exactly as
     * before this batch. Refused without a cascadeTag: a profile preset with
     * no tag to hang it on is a claim about nothing. */
    cascadePreset: z.record(z.unknown()).nullish(),
    controls: z.array(packControlSchema).min(1).max(500),
  })
  .strict()
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    for (const c of p.controls) {
      if (seen.has(c.controlRef)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate controlRef '${c.controlRef}' — a control must appear once per pack version`,
        });
      }
      seen.add(c.controlRef);
    }
    if (p.cascadePreset != null) {
      if (p.cascadeTag == null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cascadePreset"],
          message:
            "a cascadePreset requires a cascadeTag — the preset is the profile the tag seeds, and " +
            "without a tag there is nothing for the §8.3 cascade to key on",
        });
      }
      const rejection = validateRuleVersionBody("compliance_profile", p.cascadePreset);
      if (rejection) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cascadePreset"],
          message: `${rejection.error}: ${rejection.reason}`,
        });
      }
    }
  });
export type CreateCompliancePackInput = z.infer<typeof createCompliancePackSchema>;

export const packAttestationSchema = z
  .object({
    controlRef: z.string().min(1).max(200),
    statement: z.string().min(1).max(4000),
    /** how long this attestation stands. Null = no expiry stated, which the
     * scorecard reports as such rather than treating as permanent. */
    validUntil: z.string().datetime().nullish(),
    evidenceRef: z.string().max(600).nullish(),
  })
  .strict();
export type PackAttestationInput = z.infer<typeof packAttestationSchema>;

export const evaluatePackSchema = z
  .object({
    scopeKind: z.enum(["org", "initiative", "team", "project"]).default("org"),
    scopeId: z.string().uuid().nullish(),
    entitlementScope: z.enum(["org", "team", "project"]).default("org"),
    period: z
      .enum(["current_month", "last_month", "current_quarter", "last_quarter", "last_30_days"])
      .default("current_quarter"),
  })
  .strict();
export type EvaluatePackInput = z.infer<typeof evaluatePackSchema>;

// ---------------------------------------------------------------------------
// The satisfaction rule
// ---------------------------------------------------------------------------

export interface PackControlSpec {
  controlRef: string;
  title: string;
  coverage: ControlCoverageClass;
  collector: EvidenceCollectorId;
  minEvidenceCount: number;
  attestationRequired: boolean;
  ownerNote?: string | null;
}

export interface PackControlAssessment {
  controlRef: string;
  title: string;
  coverage: ControlCoverageClass;
  collector: EvidenceCollectorId;
  status: ControlEvaluationStatus;
  /** null exactly when no collector ran (attestation-required / unaddressed) */
  evidenceCount: number | null;
  minEvidenceCount: number;
  attestationRequired: boolean;
  attestation: { statement: string; attestedBy: string | null; attestedAt: string; validUntil: string | null } | null;
  note: string;
}

/**
 * THE ONE PLACE A CONTROL'S STATUS IS DECIDED.
 *
 * Read the branch order: `attestationRequired` is checked FIRST and returns
 * before any count is consulted, so there is no path — not even a
 * mis-authored pack that set both a collector and the flag — on which an
 * organisational control reaches `satisfied`.
 */
export function assessPackControl(
  control: PackControlSpec,
  evidenceCount: number | null,
  attestation: PackControlAssessment["attestation"],
  now: Date,
): PackControlAssessment {
  const base = {
    controlRef: control.controlRef,
    title: control.title,
    coverage: control.coverage,
    collector: control.collector,
    minEvidenceCount: control.minEvidenceCount,
    attestationRequired: control.attestationRequired,
  };

  if (control.attestationRequired) {
    const live =
      attestation && (!attestation.validUntil || new Date(attestation.validUntil).getTime() > now.getTime())
        ? attestation
        : null;
    return {
      ...base,
      status: live ? "attested" : "attestation_required",
      evidenceCount: null,
      attestation: live,
      note: live
        ? "ATTESTED BY A NAMED HUMAN — this is an organisational control that no control plane can " +
          "observe. The attestation is the customer's own statement, recorded and attributable; it is " +
          "NOT evidence RegulAIt collected and is NOT counted as satisfied."
        : (attestation
            ? "An attestation exists but has EXPIRED — reported as attestation-required again rather " +
              "than left standing. "
            : "") +
          "ATTESTATION REQUIRED — organisational control, not auto-evidenced. RegulAIt reports this " +
          "as outstanding; it never reports it as satisfied.",
    };
  }

  if (control.collector === "none" || control.coverage === "unaddressed") {
    return {
      ...base,
      status: "unaddressed",
      evidenceCount: null,
      attestation: null,
      note:
        "UNADDRESSED — this pack states plainly that platform configuration does not reach this " +
        "control. It is reported so it cannot be mistaken for covered.",
    };
  }

  const n = evidenceCount ?? 0;
  const satisfied = n >= control.minEvidenceCount;
  return {
    ...base,
    status: satisfied ? "satisfied" : "unsatisfied",
    evidenceCount: n,
    attestation: null,
    note: satisfied
      ? `${n} evidence record(s) from the '${control.collector}' collector meet the threshold of ` +
        `${control.minEvidenceCount}. Evidence EXISTS; that is not an assertion that the control is ` +
        `operating effectively — an auditor judges effectiveness, this counts rows.`
      : `${n} evidence record(s) from the '${control.collector}' collector, below the threshold of ` +
        `${control.minEvidenceCount}. Reported as UNSATISFIED, never as a pass.`,
  };
}

// ---------------------------------------------------------------------------
// The scorecard
// ---------------------------------------------------------------------------

export interface PackScorecard {
  framework: string;
  packVersion: number;
  packTitle: string;
  cascadeTag: string | null;
  scope: { kind: string; id: string | null; projectIds: string[] | null };
  period: { period: string; label: string; start: string; end: string };
  generatedAt: string;
  totals: {
    controls: number;
    satisfied: number;
    unsatisfied: number;
    attested: number;
    attestationRequired: number;
    unaddressed: number;
    /** how many controls the pack AUTHOR claims the cascade actively enforces */
    declaredEnforced: number;
  };
  controls: PackControlAssessment[];
  statement: string;
  disclaimer: string;
  updatePolicy: string;
}

/**
 * The scorecard has no verdict, and this function is where that is guaranteed:
 * it returns COUNTS and a sentence that recites them. There is no threshold at
 * which it emits "compliant", because there is no such field to emit into.
 */
export function buildPackScorecard(input: {
  framework: string;
  packVersion: number;
  packTitle: string;
  cascadeTag: string | null;
  scope: PackScorecard["scope"];
  period: PackScorecard["period"];
  generatedAt: string;
  controls: PackControlAssessment[];
}): PackScorecard {
  const n = (s: ControlEvaluationStatus) => input.controls.filter((c) => c.status === s).length;
  const totals = {
    controls: input.controls.length,
    satisfied: n("satisfied"),
    unsatisfied: n("unsatisfied"),
    attested: n("attested"),
    attestationRequired: n("attestation_required"),
    unaddressed: n("unaddressed"),
    declaredEnforced: input.controls.filter((c) => c.coverage === "enforced").length,
  };
  return {
    framework: input.framework,
    packVersion: input.packVersion,
    packTitle: input.packTitle,
    cascadeTag: input.cascadeTag,
    scope: input.scope,
    period: input.period,
    generatedAt: input.generatedAt,
    totals,
    controls: input.controls,
    statement:
      `${totals.satisfied} of ${totals.controls} mapped ${input.framework} controls had evidence in ` +
      `RegulAIt's own ledgers for this period; ${totals.unsatisfied} did not; ` +
      `${totals.attested + totals.attestationRequired} are organisational controls requiring the ` +
      `customer's own attestation (${totals.attested} attested, ${totals.attestationRequired} ` +
      `outstanding); ${totals.unaddressed} are not addressed by platform configuration at all. ` +
      `This is a coverage count against pack version ${input.packVersion}, NOT a compliance verdict.`,
    disclaimer: COMPLIANCE_PACK_DISCLAIMER,
    updatePolicy: COMPLIANCE_PACK_UPDATE_POLICY,
  };
}

// ---------------------------------------------------------------------------
// The seed packs — DATA, shipped as a starting point
// ---------------------------------------------------------------------------

/**
 * The launch packs of ADR-0058, expressed in exactly the shape
 * `POST /v1/compliance/packs` accepts. Nothing in the evaluator reads this
 * constant: `POST /v1/compliance/packs/seed` inserts these as ordinary rows and
 * the evaluator only ever reads rows. Emptying the tables makes the evaluator
 * evaluate nothing, which is the test that proves the claim.
 *
 * These mappings are a WELL-INFORMED STARTING POINT authored against the public
 * framework catalogues, not legal advice and not reviewed by counsel — the
 * `provenance.reviewedBy` field says so on every one of them, deliberately,
 * rather than leaving a customer to assume otherwise.
 */
export const DEFAULT_COMPLIANCE_PACKS: CreateCompliancePackInput[] = [
  {
    framework: "eu-ai-act",
    version: 1,
    title: "EU AI Act — high-risk AI system obligations (control mapping)",
    description:
      "Maps the record-keeping, human-oversight, accuracy/robustness and risk-management obligations " +
      "of the EU AI Act's high-risk regime onto RegulAIt configuration and ledgers. Obligation " +
      "numbering follows the published Act text; the interpretation is RegulAIt's and is contestable.",
    provenance: {
      source: "EU AI Act published text (high-risk obligations)",
      catalogueRevision: "as-published",
      reviewedBy: null,
      reviewedOn: null,
      note: "Authored from the public text. NOT reviewed by counsel — treat as a starting point.",
    },
    cascadeTag: "eu-ai-act-high-risk",
    // batch B1 — the §8.3 starting point this tag seeds on activation. Each
    // value cites the obligation that makes it defensible; like every mapping
    // in this pack it is a STARTING POINT an admin tightens, not legal advice.
    cascadePreset: {
      // Art. 19: automatically generated logs kept at least six months
      auditRetentionDays: 183,
      // Art. 14 human oversight: connector writes default to read-only so a
      // human approval sits in front of state-changing acts
      mcpDefaultMode: "read_only",
      // Art. 15 robustness/cybersecurity names resilience against attempts to
      // alter the system's behaviour — prompt injection is that attack here
      guardrailModes: { prompt_injection: "block" },
    },
    controls: [
      {
        controlRef: "eu-ai-act:art-12-record-keeping",
        title: "Automatic recording of events over the system's lifetime (logging)",
        description:
          "Every governed decision lands an append-only audit_log row; ADR-0060 hash-chains it so " +
          "the record is tamper-evident, not merely present.",
        coverage: "enforced",
        collector: "audit_decisions",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "eu-ai-act:art-14-human-oversight",
        title: "Human oversight — a named person can intervene before an action takes effect",
        description: "Evidenced by approvals decided by a named human in the period.",
        coverage: "enforced",
        collector: "approvals",
        collectorParams: { status: "approved" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "eu-ai-act:art-15-accuracy-robustness",
        title: "Accuracy, robustness and cybersecurity — measured, not asserted",
        description: "Evidenced by eval runs (ADR-0044) executed against the system in the period.",
        coverage: "evidenced",
        collector: "eval_runs",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "eu-ai-act:art-9-risk-management-system",
        title: "A documented risk-management system across the AI system's lifecycle",
        description:
          "RegulAIt holds the model-risk half (ADR-0045 model cards with an unexpired sign-off). " +
          "The surrounding risk-management SYSTEM — its owner, cadence and escalation path — is " +
          "organisational.",
        coverage: "partial",
        collector: "model_cards_approved",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote:
          "Model-risk sign-offs are evidenced here; the documented risk-management system around " +
          "them is the deployer's own and is not observable from this control plane.",
      },
      {
        controlRef: "eu-ai-act:art-72-post-market-monitoring",
        title: "Post-market monitoring plan, proportionate to the risk",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote:
          "A post-market monitoring PLAN is a document the provider authors and executes. No control " +
          "plane can evidence it. Attest, with a reference to the plan.",
      },
      {
        controlRef: "eu-ai-act:art-4-ai-literacy",
        title: "AI literacy — staff operating the system are trained",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote: "Training records live in the customer's HR/LMS system, not here.",
      },
    ],
  },
  {
    framework: "nist-ai-rmf",
    version: 1,
    title: "NIST AI RMF 1.0 — GOVERN / MAP / MEASURE / MANAGE (control mapping)",
    description:
      "Maps the four AI RMF functions onto RegulAIt configuration. ADR-0045's model cards already " +
      "carry NIST subcategory refs; this pack is the report-level counterpart.",
    provenance: {
      source: "NIST AI RMF 1.0",
      catalogueRevision: "1.0",
      reviewedBy: null,
      reviewedOn: null,
      note: "Authored from the published framework. Subcategory selection is RegulAIt's judgement.",
    },
    cascadeTag: null,
    controls: [
      {
        controlRef: "nist-ai-rmf:GOVERN-1.2",
        title: "Accountability structures — access to AI is granted, not assumed",
        coverage: "enforced",
        collector: "abac_policies_active",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "nist-ai-rmf:MAP-4.1",
        title: "AI system provenance and data lineage are recorded",
        coverage: "evidenced",
        collector: "lineage_edges",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "nist-ai-rmf:MEASURE-2.7",
        title: "AI system security and resilience are evaluated",
        coverage: "evidenced",
        collector: "eval_runs",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "nist-ai-rmf:MANAGE-2.2",
        title: "Mechanisms are in place to supersede, disengage or deactivate an AI system",
        coverage: "enforced",
        collector: "audit_decisions",
        collectorParams: { effect: "deny" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote:
          "Evidenced by refusals actually occurring: a deny in the ledger is proof the kill-path " +
          "executes, not merely that it is configured.",
      },
      {
        controlRef: "nist-ai-rmf:GOVERN-4.1",
        title: "Organisational risk culture — policies, training and incident practice",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote: "Organisational. Attest with a reference to the policy set and training records.",
      },
    ],
  },
  {
    framework: "iso-27001",
    version: 1,
    title: "ISO/IEC 27001:2022 — information security controls (partial mapping)",
    description:
      "A scoped mapping of selected Annex A control references to platform evidence. " +
      "This is not a Statement of Applicability, an ISMS assessment, or certification.",
    provenance: {
      source: "ISO/IEC 27001:2022 Annex A reference controls and ISO/IEC 27001 Auditing Practices Group guidance",
      catalogueRevision: "2022 (including awareness of Amendment 1:2024)",
      reviewedBy: null,
      reviewedOn: null,
      note: "Paraphrased control references only; copyrighted control text is not reproduced. " +
        "Applicability and risk treatment require the customer's own assessment and Statement of Applicability.",
    },
    cascadeTag: null,
    controls: [
      {
        controlRef: "iso-27001:A.5.15",
        title: "Access control",
        description: "Active ABAC policies show a platform access-control configuration, not coverage of all organizational access.",
        coverage: "partial",
        collector: "abac_policies_active",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: "Review identity lifecycle, access reviews, and non-platform systems separately.",
      },
      {
        controlRef: "iso-27001:A.8.15",
        title: "Logging",
        description: "Decision audit rows evidence activity mediated by RegulAIt during the selected period.",
        coverage: "partial",
        collector: "audit_decisions",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: "This count does not establish log completeness, retention, review, or coverage outside RegulAIt.",
      },
      {
        controlRef: "iso-27001:A.8.12",
        title: "Data leakage prevention",
        description: "Configured guardrails provide platform-specific DLP posture evidence.",
        coverage: "partial",
        collector: "guardrail_configs",
        collectorParams: { detector: "semantic_dlp", minMode: "block" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: "Configuration is not proof of detection effectiveness or organization-wide DLP.",
      },
      {
        controlRef: "iso-27001:6.1.3",
        title: "Information security risk treatment and applicability",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote: "Customer must provide its risk treatment decisions and Statement of Applicability.",
      },
      {
        controlRef: "iso-27001:9.2",
        title: "Internal audit",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote: "Customer must evidence its independent internal audit program and results.",
      },
    ],
  },
  {
    framework: "iso-42001",
    version: 1,
    title: "ISO/IEC 42001 — AI management system (control mapping)",
    description: "Maps the AIMS clauses that platform configuration can speak to.",
    provenance: {
      source: "ISO/IEC 42001 clause structure",
      catalogueRevision: "2023",
      reviewedBy: null,
      reviewedOn: null,
      note: "Clause text is copyrighted and NOT reproduced here; only clause references are used.",
    },
    cascadeTag: null,
    controls: [
      {
        controlRef: "iso-42001:8.3-ai-system-impact-assessment",
        title: "AI system impact assessment is performed and signed off",
        coverage: "partial",
        collector: "model_cards_approved",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: "The signed-off model card is the platform's half; the wider impact assessment is not.",
      },
      {
        controlRef: "iso-42001:9.1-monitoring-measurement",
        title: "Monitoring, measurement, analysis and evaluation",
        coverage: "evidenced",
        collector: "attributed_usage",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "iso-42001:A.6-ai-system-lifecycle",
        title: "Controls over the AI system lifecycle — changes are governed",
        coverage: "enforced",
        collector: "approvals",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "iso-42001:5.3-roles-responsibilities",
        title: "Organisational roles, responsibilities and authorities are assigned",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote: "Named accountable owners are an organisational artefact.",
      },
    ],
  },
  {
    framework: "hipaa",
    version: 1,
    title: "HIPAA Security Rule — technical safeguards for AI usage (control mapping)",
    description:
      "Answers the Security Rule's technical safeguards FOR AI USAGE SPECIFICALLY — not for the " +
      "underlying EHR. Scope matters: this pack evidences what RegulAIt mediates.",
    provenance: {
      source: "45 CFR §164.312 technical safeguards",
      catalogueRevision: "as-published",
      reviewedBy: null,
      reviewedOn: null,
      note: "Administrative and physical safeguards are out of scope for a control plane.",
    },
    cascadeTag: "hipaa",
    // batch B1 — mirrors the onboarding wizard's HIPAA cascade seed (shared
    // onboarding.ts COMPLIANCE_PACKS): PHI must not leave the boundary in a
    // prompt, and 45 CFR 164.316(b)(2) holds documentation six years.
    cascadePreset: {
      mcpDefaultMode: "read_only",
      auditRetentionDays: 2192,
      piiMode: "block",
      backupRetentionDays: 2192,
      patchCadenceDays: 30,
      guardrailModes: { prompt_injection: "block", semantic_dlp: "block" },
    },
    controls: [
      {
        controlRef: "hipaa:164.312(b)-audit-controls",
        title: "Audit controls — record and examine activity in systems handling ePHI",
        coverage: "enforced",
        collector: "audit_decisions",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "hipaa:164.312(a)(1)-access-control",
        title: "Access control — PII/ePHI handling is enforced, not advisory",
        description:
          "Evidenced by a compliance profile whose cascade actually forces PII mode 'block' — " +
          "configuration evidence, because a period with no PII access is not proof of a control.",
        coverage: "enforced",
        collector: "compliance_profile_cascade",
        collectorParams: { cascadeAspect: "pii_block" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "hipaa:164.312(e)(1)-transmission-security",
        title: "Transmission security — model/connector egress is bounded",
        coverage: "enforced",
        collector: "guardrail_configs",
        collectorParams: { detector: "semantic_dlp", minMode: "warn" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "hipaa:164.308(a)(1)-security-management",
        title: "Security management process — risk analysis and sanction policy",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote: "Administrative safeguard. Attest with a reference to the risk analysis.",
      },
      {
        controlRef: "hipaa:baa",
        title: "Business Associate Agreements are in place with every AI provider used",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote:
          "RegulAIt can enumerate which providers were dispatched to; it cannot know whether a BAA " +
          "exists. Attest per provider.",
      },
    ],
  },
  {
    framework: "pci-dss",
    version: 1,
    title: "PCI DSS v4.0 — AI access to cardholder data (control mapping)",
    description: "Scoped to AI/agent access paths that RegulAIt mediates, not to the CDE as a whole.",
    provenance: {
      source: "PCI DSS v4.0 requirements 7 and 10",
      catalogueRevision: "4.0",
      reviewedBy: null,
      reviewedOn: null,
      note: "A QSA determines CDE scope; this pack does not.",
    },
    cascadeTag: "pci-dss",
    // batch B1 — cardholder data never reaches a model: PII blocked, one year
    // of audit retention (v4 req. 10.5.1), 30-day patch cadence (req. 6.3.3).
    cascadePreset: {
      mcpDefaultMode: "read_only",
      auditRetentionDays: 365,
      piiMode: "block",
      backupRetentionDays: 365,
      patchCadenceDays: 30,
      guardrailModes: { prompt_injection: "block", semantic_dlp: "block" },
    },
    controls: [
      {
        controlRef: "pci-dss:7.2.1-least-privilege",
        title: "Access is assigned by role and need-to-know",
        coverage: "enforced",
        collector: "abac_policies_active",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "pci-dss:10.2.1-audit-log-of-access",
        title: "Every access attempt to cardholder data is logged with its outcome",
        coverage: "enforced",
        collector: "audit_decisions",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "pci-dss:10.2.1.5-denied-access-logged",
        title: "Denied access attempts are logged",
        coverage: "enforced",
        collector: "audit_decisions",
        collectorParams: { effect: "deny" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "pci-dss:12.1-security-policy",
        title: "An information-security policy is established and maintained",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote: "Organisational.",
      },
    ],
  },
  {
    framework: "finra",
    version: 1,
    title: "FINRA supervision and books-and-records for AI-assisted work (control mapping)",
    description:
      "Maps supervisory-system and recordkeeping expectations onto the approvals queue and the " +
      "audit ledger. Retention obligations are asserted by configuration, not by us.",
    provenance: {
      source: "FINRA Rule 3110 (supervision) and SEA Rule 17a-4 (records)",
      catalogueRevision: "as-published",
      reviewedBy: null,
      reviewedOn: null,
      note: "Broker-dealer scope determination is the firm's own.",
    },
    cascadeTag: "finra",
    // batch B1 — deliberately MINIMAL: SEA 17a-4(b) makes a six-year record
    // floor defensible; FINRA is a books-and-records regime, not a PII one, so
    // no piiMode is claimed. Note the loop this closes: this pack's own
    // 17a-4-record-retention control is evidenced by
    // `compliance_profile_cascade` with the retention aspect — activation now
    // seeds the very profile that control looks for, instead of reporting a
    // gap the pack itself could have configured away.
    cascadePreset: {
      mcpDefaultMode: "read_only",
      auditRetentionDays: 2192,
      backupRetentionDays: 2192,
    },
    controls: [
      {
        controlRef: "finra:3110-supervisory-review",
        title: "A supervisory system provides for review of covered activity by a named principal",
        coverage: "enforced",
        collector: "approvals",
        collectorParams: { status: "approved" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "finra:17a-4-record-retention",
        title: "Records are retained for the required period in a non-rewriteable form",
        description:
          "Evidenced by a compliance profile that actually sets an audit-retention floor. ADR-0060's " +
          "hash chain makes the ledger tamper-EVIDENT; WORM storage itself is a deployment property.",
        coverage: "partial",
        collector: "compliance_profile_cascade",
        collectorParams: { cascadeAspect: "retention" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote:
          "Non-rewriteable STORAGE is the deployment's own (ADR-0060 anchors to it). Attest to the " +
          "WORM target separately.",
      },
      {
        controlRef: "finra:3110-written-supervisory-procedures",
        title: "Written supervisory procedures exist and are current",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote: "Organisational document.",
      },
    ],
  },
  {
    framework: "soc-2",
    version: 1,
    title: "SOC 2 — Security (Common Criteria) control mapping",
    description:
      "Maps a Security-category (CC-series) subset of the 2017 Trust Services Criteria onto " +
      "RegulAIt ledgers and configuration. SECURITY CATEGORY ONLY — Availability, Processing " +
      "Integrity, Confidentiality and Privacy are out of this pack's scope and are not silently " +
      "implied. A SOC 2 REPORT is an auditor's opinion on YOUR organisation; this pack collects " +
      "the control-plane evidence an auditor would sample, it does not constitute the report.",
    provenance: {
      source: "AICPA Trust Services Criteria (2017, incl. 2022 points of focus) — Security/CC series",
      catalogueRevision: "TSC 2017 (rev. 2022)",
      reviewedBy: null,
      reviewedOn: null,
      note: "Authored from the public criteria. NOT reviewed by a CPA firm — treat as a starting point.",
    },
    cascadeTag: null,
    controls: [
      {
        controlRef: "soc-2:CC6.1-logical-access",
        title: "Logical access security is implemented over protected assets",
        description:
          "Default-deny operates on every governed call: evidenced by DENY decisions the gateway " +
          "actually issued in the period — access control that refused nothing is asserted, not shown.",
        coverage: "enforced",
        collector: "audit_decisions",
        collectorParams: { effect: "deny" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "soc-2:CC6.2-user-registration",
        title: "Users are registered and authorized before access is provisioned",
        description:
          "User lifecycle actions (creation, initial credentials, deactivation — incl. SCIM " +
          "deprovisioning per ADR-0037) land audit rows with objectType 'user'.",
        coverage: "evidenced",
        collector: "audit_decisions",
        collectorParams: { objectType: "user" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "soc-2:CC6.3-access-modification",
        title: "Access is modified or removed on role change and termination",
        description:
          "The mechanism is evidenced (user-lifecycle audit rows; deactivation is disabled_at, never " +
          "a delete). The CADENCE — access reviews, termination SLAs — is organisational.",
        coverage: "partial",
        collector: "audit_decisions",
        collectorParams: { objectType: "user" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote:
          "Attach your access-review cadence and termination SLA; the control plane cannot observe HR events it is not told about.",
      },
      {
        controlRef: "soc-2:CC6.6-boundary-protection",
        title: "Threats from outside system boundaries are mitigated (egress control)",
        description:
          "ADR-0043/0034's default-deny egress guard: admin-typed outbound destinations are " +
          "allow-listed and every list change is audited (ruleId 'egress-*').",
        coverage: "enforced",
        collector: "audit_decisions",
        collectorParams: { ruleIdPrefix: "egress" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "soc-2:CC6.7-data-movement",
        title: "Movement of information is restricted to authorized users and processes",
        description:
          "The semantic-DLP detector (ADR-0042) at warn-or-stronger inspects governed output paths; " +
          "the §8.4 PII controls ride the same plane.",
        coverage: "evidenced",
        collector: "guardrail_configs",
        collectorParams: { detector: "semantic_dlp", minMode: "warn" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "soc-2:CC7.2-monitoring",
        title: "System components are monitored for anomalies indicative of malicious acts",
        description:
          "Every governed decision is recorded continuously in the hash-chained audit log " +
          "(ADR-0060); the prompt-injection detector at block is the runtime tripwire.",
        coverage: "evidenced",
        collector: "guardrail_configs",
        collectorParams: { detector: "prompt_injection", minMode: "block" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "soc-2:CC7.4-incident-response",
        title: "Security incidents are responded to per a defined incident-response program",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote:
          "An incident-response PROGRAM (roles, runbooks, exercises) is organisational; attest with a reference to it. Audit rows can support a post-incident timeline but do not constitute the program.",
      },
      {
        controlRef: "soc-2:CC8.1-change-management",
        title: "Changes to infrastructure, data and software are authorized before deployment",
        description:
          "Pillar-2 workflow sign-offs: human approvals recorded against workflow instances " +
          "(plan gate per ADR-0079, merge/deploy gates per §2), decided in the period.",
        coverage: "enforced",
        collector: "approvals",
        collectorParams: { status: "approved", approvalObjectType: "workflow" },
        minEvidenceCount: 1,
        attestationRequired: false,
        ownerNote: null,
      },
      {
        controlRef: "soc-2:CC9.2-vendor-risk",
        title: "Vendor and business-partner risks are assessed and managed",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote:
          "RegulAIt has no vendor-risk module (a known gap, L5 in the Credo analysis — deliberately deferred). Attest from your procurement/GRC process.",
      },
      {
        controlRef: "soc-2:CC1.4-competence",
        title: "The entity attracts, develops and retains competent individuals (control environment)",
        coverage: "unaddressed",
        collector: "none",
        collectorParams: {},
        minEvidenceCount: 1,
        attestationRequired: true,
        ownerNote: "Control-environment criteria live in HR and governance documents, not in a control plane.",
      },
    ],
  },
];
