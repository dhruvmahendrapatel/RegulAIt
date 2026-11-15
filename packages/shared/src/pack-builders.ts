/**
 * The two control builders the authored compliance packs share (ISO ID-only packs, sector packs, privacy packs). One
 * copy, imported by each pack file (#830 review). The output is pinned by each pack's content-hash test, so a change
 * here that altered a published pack would fail those tests.
 *
 * Imports from `compliance-packs.ts` are TYPE-ONLY: that file imports the pack files, which import this one.
 */
import type { CreateCompliancePackInput } from "./compliance-packs.js";

export type PackControl = CreateCompliancePackInput["controls"][number];

/** what an evidenced control declares; `evidence`, when given, becomes its description ("Evidence counted: …") */
export type PackEvidence = Pick<PackControl, "coverage" | "collector"> &
  Partial<Pick<PackControl, "collectorParams">> & { evidence?: string; note: string };

/** a control a collector evidences. Key order is part of the pinned content hash: do not reorder. */
export const evidencedControl = (controlRef: string, title: string, e: PackEvidence): PackControl => ({
  controlRef,
  title,
  ...(e.evidence !== undefined ? { description: `Evidence counted: ${e.evidence}` } : {}),
  coverage: e.coverage,
  collector: e.collector,
  collectorParams: e.collectorParams ?? {},
  minEvidenceCount: 1,
  attestationRequired: false,
  ownerNote: e.note,
});

/** an organisational control: no collector, the organisation attests it. Key order is part of the pinned hash. */
export const attestedControl = (controlRef: string, title: string, coverage: PackControl["coverage"], ownerNote: string): PackControl => ({
  controlRef,
  title,
  coverage,
  collector: "none",
  collectorParams: {},
  minEvidenceCount: 1,
  attestationRequired: true,
  ownerNote,
});
