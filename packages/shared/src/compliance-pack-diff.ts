/**
 * ADR-0087 — THE COMPLIANCE-PACK VERSION DIFF, the pure half.
 *
 * ADR-0058 made a framework revision a NEW versioned row plus an activation.
 * What it did not make is the revision REVIEWABLE: an admin activating v2 had
 * nothing but two JSON blobs and their own diligence. This module computes the
 * structured answer to "what changed between pack vA and pack vB" so the
 * gateway can put it — plus an impact preview against the live ledgers — in
 * front of the admin BEFORE anything activates.
 *
 * WHAT THIS DIFF IS, HONESTLY. It diffs the pack AS AUTHORED: declared
 * coverage classes, collectors, params, thresholds, attestation flags, owner
 * notes. Those are the mapping author's CLAIMS (ADR-0058: "`coverage` is the
 * mapping author's claim, not a verified property"), so this diff compares
 * claims with claims. The measured half — which computed statuses would
 * actually move under the new version — is the gateway's impact preview,
 * which runs the real evaluator over the real ledgers for both versions.
 *
 * DESIGN RULES:
 *  - DETERMINISTIC AND ORDER-INDEPENDENT. Controls are matched by
 *    `controlRef`, never by array position; every output list is sorted by
 *    `controlRef`; field diffs come out in one fixed order; object-valued
 *    fields (collectorParams, provenance) are compared by canonical
 *    key-sorted serialisation, so reordering keys is not a change.
 *  - A `cascadeTag` CHANGE IS FLAGGED DISTINCTLY. The cascade tag is the one
 *    pack field with enforcement REACH: an Initiative carrying it drives the
 *    §8.3 cascade (required stages, data-scope defaults, retention, PII
 *    mode). Retitling a pack changes prose; changing its cascade tag changes
 *    what tagging an Initiative DOES. The diff therefore surfaces it as its
 *    own `cascadeTagChange` object with `consequence: "HIGH"`, in addition to
 *    listing it among the pack-level field changes.
 *  - NO VERDICT. The diff says what changed; it does not say whether the
 *    change is good, safe, or compliant. That judgement stays with the admin
 *    (and their advisors), exactly as ADR-0058 left it.
 */
import { z } from "zod";
import { CONTROL_COVERAGE_CLASSES } from "./compliance-packs.js";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** the control fields the diff inspects, in the ONE order field diffs are
 * emitted — a fixed order is half of determinism */
export const PACK_CONTROL_DIFF_FIELDS = [
  "title",
  "description",
  "coverage",
  "collector",
  "collectorParams",
  "minEvidenceCount",
  "attestationRequired",
  "ownerNote",
] as const;
export type PackControlDiffField = (typeof PACK_CONTROL_DIFF_FIELDS)[number];

/** the pack-level fields the diff inspects (same fixed-order rule) */
export const PACK_LEVEL_DIFF_FIELDS = ["title", "description", "provenance", "cascadeTag"] as const;
export type PackLevelDiffField = (typeof PACK_LEVEL_DIFF_FIELDS)[number];

/** a diffed value is always one of the scalar/object shapes a pack can hold */
const diffValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.record(z.string(), z.unknown()),
  z.null(),
]);
export type PackDiffValue = z.infer<typeof diffValueSchema>;

export const controlFieldChangeSchema = z
  .object({
    field: z.enum(PACK_CONTROL_DIFF_FIELDS),
    from: diffValueSchema,
    to: diffValueSchema,
  })
  .strict();
export type ControlFieldChange = z.infer<typeof controlFieldChangeSchema>;

/** enough of an added/removed control to review it without opening the pack */
export const controlDiffSummarySchema = z
  .object({
    controlRef: z.string(),
    title: z.string(),
    coverage: z.enum(CONTROL_COVERAGE_CLASSES),
    collector: z.string(),
    minEvidenceCount: z.number().int(),
    attestationRequired: z.boolean(),
  })
  .strict();
export type ControlDiffSummary = z.infer<typeof controlDiffSummarySchema>;

export const changedControlSchema = z
  .object({
    controlRef: z.string(),
    /** the `to` side's title — what the control is called after the revision */
    title: z.string(),
    fields: z.array(controlFieldChangeSchema).min(1),
  })
  .strict();
export type ChangedControl = z.infer<typeof changedControlSchema>;

export const packLevelChangeSchema = z
  .object({
    field: z.enum(PACK_LEVEL_DIFF_FIELDS),
    from: diffValueSchema,
    to: diffValueSchema,
  })
  .strict();
export type PackLevelChange = z.infer<typeof packLevelChangeSchema>;

export const compliancePackDiffSchema = z
  .object({
    /** every pack-level field that changed, in PACK_LEVEL_DIFF_FIELDS order —
     * including cascadeTag, which ALSO appears below so it cannot be missed */
    packChanges: z.array(packLevelChangeSchema),
    /**
     * THE HIGH-CONSEQUENCE FLAG. Non-null exactly when the cascade tag
     * differs. The cascade tag is what an Initiative carries for the §8.3
     * cascade to act — required workflow stages, MCP/connector data-scope
     * defaults, audit retention, PII mode all hang off it — so a revision
     * that changes it changes what the pack's classification DOES, not just
     * what the pack says.
     */
    cascadeTagChange: z
      .object({
        from: z.string().nullable(),
        to: z.string().nullable(),
        consequence: z.literal("HIGH"),
        note: z.string(),
      })
      .strict()
      .nullable(),
    controlsAdded: z.array(controlDiffSummarySchema),
    controlsRemoved: z.array(controlDiffSummarySchema),
    controlsChanged: z.array(changedControlSchema),
    summary: z
      .object({
        controlsAdded: z.number().int(),
        controlsRemoved: z.number().int(),
        controlsChanged: z.number().int(),
        controlsUnchanged: z.number().int(),
        packFieldsChanged: z.number().int(),
        cascadeTagChanged: z.boolean(),
      })
      .strict(),
    /** true exactly when NOTHING differs — the honest "this revision changes
     * no mapping" answer, stated rather than left to be inferred from four
     * empty arrays */
    identical: z.boolean(),
  })
  .strict();
export type CompliancePackDiff = z.infer<typeof compliancePackDiffSchema>;

/**
 * What the differ needs to know about one pack version. Both the stored rows
 * (`compliance_packs` + `compliance_pack_controls`) and a
 * `CreateCompliancePackInput` satisfy this shape directly.
 */
export interface PackVersionSnapshot {
  title: string;
  description?: string | null | undefined;
  provenance?: Record<string, unknown> | null | undefined;
  cascadeTag?: string | null | undefined;
  controls: ReadonlyArray<{
    controlRef: string;
    title: string;
    description?: string | null | undefined;
    coverage: (typeof CONTROL_COVERAGE_CLASSES)[number];
    collector: string;
    collectorParams?: Record<string, unknown> | null | undefined;
    minEvidenceCount: number;
    attestationRequired: boolean;
    ownerNote?: string | null | undefined;
  }>;
}

// ---------------------------------------------------------------------------
// Canonical comparison
// ---------------------------------------------------------------------------

/**
 * Canonical, key-sorted serialisation — the equality the diff uses for
 * object-valued fields. `{a:1,b:2}` and `{b:2,a:1}` are the SAME params;
 * a diff that flagged key order would be noise, and noise in a review
 * surface trains the reviewer to stop reading.
 */
function canonical(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, val]) => val !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** nullish prose fields normalise to null so `undefined` vs `null` is not a
 * change; params normalise to {} for the same reason */
const norm = (c: PackVersionSnapshot["controls"][number]) => ({
  title: c.title,
  description: c.description ?? null,
  coverage: c.coverage,
  collector: c.collector,
  collectorParams: c.collectorParams ?? {},
  minEvidenceCount: c.minEvidenceCount,
  attestationRequired: c.attestationRequired,
  ownerNote: c.ownerNote ?? null,
});

const summarise = (c: PackVersionSnapshot["controls"][number]): ControlDiffSummary => ({
  controlRef: c.controlRef,
  title: c.title,
  coverage: c.coverage,
  collector: c.collector,
  minEvidenceCount: c.minEvidenceCount,
  attestationRequired: c.attestationRequired,
});

const byRef = <T extends { controlRef: string }>(a: T, b: T) =>
  a.controlRef < b.controlRef ? -1 : a.controlRef > b.controlRef ? 1 : 0;

// ---------------------------------------------------------------------------
// The differ
// ---------------------------------------------------------------------------

/**
 * Structured diff of two pack versions: controls added / removed / changed
 * (with per-field before/after), pack-level changes, the distinct
 * cascade-tag flag, and summary counts. Deterministic and order-independent
 * — see the module header for the rules.
 */
export function diffCompliancePacks(a: PackVersionSnapshot, b: PackVersionSnapshot): CompliancePackDiff {
  // --- pack level ----------------------------------------------------------
  const packA = {
    title: a.title,
    description: a.description ?? null,
    provenance: a.provenance ?? null,
    cascadeTag: a.cascadeTag ?? null,
  };
  const packB = {
    title: b.title,
    description: b.description ?? null,
    provenance: b.provenance ?? null,
    cascadeTag: b.cascadeTag ?? null,
  };
  const packChanges: PackLevelChange[] = [];
  for (const field of PACK_LEVEL_DIFF_FIELDS) {
    if (!same(packA[field], packB[field])) {
      packChanges.push({ field, from: packA[field], to: packB[field] });
    }
  }

  const cascadeTagChange =
    packA.cascadeTag === packB.cascadeTag
      ? null
      : {
          from: packA.cascadeTag,
          to: packB.cascadeTag,
          consequence: "HIGH" as const,
          note:
            "The cascade tag is the one pack field with enforcement reach: an Initiative carrying it " +
            "drives the §8.3 compliance cascade (required workflow stages, MCP/connector data-scope " +
            "defaults, audit-log retention, PII mode). Changing it changes what tagging an Initiative " +
            "with this pack's classification DOES — review it as a policy change, not a rename.",
        };

  // --- controls, matched by controlRef -------------------------------------
  const mapA = new Map(a.controls.map((c) => [c.controlRef, c]));
  const mapB = new Map(b.controls.map((c) => [c.controlRef, c]));

  const controlsAdded = b.controls
    .filter((c) => !mapA.has(c.controlRef))
    .map(summarise)
    .sort(byRef);
  const controlsRemoved = a.controls
    .filter((c) => !mapB.has(c.controlRef))
    .map(summarise)
    .sort(byRef);

  const controlsChanged: ChangedControl[] = [];
  let unchanged = 0;
  for (const [ref, ca] of mapA) {
    const cb = mapB.get(ref);
    if (!cb) continue;
    const na = norm(ca);
    const nb = norm(cb);
    const fields: ControlFieldChange[] = [];
    for (const field of PACK_CONTROL_DIFF_FIELDS) {
      if (!same(na[field], nb[field])) {
        fields.push({ field, from: na[field], to: nb[field] });
      }
    }
    if (fields.length) controlsChanged.push({ controlRef: ref, title: cb.title, fields });
    else unchanged += 1;
  }
  controlsChanged.sort(byRef);

  const summary = {
    controlsAdded: controlsAdded.length,
    controlsRemoved: controlsRemoved.length,
    controlsChanged: controlsChanged.length,
    controlsUnchanged: unchanged,
    packFieldsChanged: packChanges.length,
    cascadeTagChanged: cascadeTagChange !== null,
  };

  return {
    packChanges,
    cascadeTagChange,
    controlsAdded,
    controlsRemoved,
    controlsChanged,
    summary,
    identical:
      packChanges.length === 0 &&
      controlsAdded.length === 0 &&
      controlsRemoved.length === 0 &&
      controlsChanged.length === 0,
  };
}
