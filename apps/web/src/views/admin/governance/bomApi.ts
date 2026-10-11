/**
 * ADR-0189 B3 routes, as the gateway serves them (`apps/gateway/src/bom-routes.ts`):
 *
 *   GET  /v1/ai-bom/:kind/:id/snapshots   the subject's snapshot list (admins; audited)
 *   POST /v1/ai-bom/:kind/:id/snapshots   freeze and sign one on demand (admins; audited)
 *   GET  /v1/ai-bom/:kind/:id/drift       live state against the newest snapshot, plus gaps (admins; audited)
 *
 * A snapshot is signed with the receipt key, so with no usable key the freeze
 * is refused (409 `bom_signing_unavailable`, 503 `receipt_signing_key_invalid`)
 * and nothing is stored. Drift's 409 `ai_bom_no_snapshot` still carries the
 * subject's gaps (R25 item 4); `drift` returns them instead of throwing them away.
 */
import { api, ApiError } from "../../../api/client";
import { withStepUp } from "../../../stepup/stepUp";
import { readCreatedSnapshot, readDrift, readGaps, readSnapshotList, subjectPath, type BomDrift, type BomGaps, type BomSubject, type CreatedSnapshot, type SnapshotList } from "./bomModel";

export type DriftResult = { kind: "drift"; drift: BomDrift } | { kind: "no_snapshot"; gaps: BomGaps };

export interface BomMetadataPort {
  list(subject: BomSubject): Promise<SnapshotList>;
  drift(subject: BomSubject): Promise<DriftResult>;
  /** a mutation: wrapped in step-up, so a gateway that asks for one gets it */
  create(subject: BomSubject): Promise<CreatedSnapshot>;
}

export const bomMetadataApi: BomMetadataPort = {
  list: async (subject) => readSnapshotList(await api.get<unknown>(`${subjectPath(subject)}/snapshots`), subject),
  drift: async (subject) => {
    try {
      return { kind: "drift", drift: readDrift(await api.get<unknown>(`${subjectPath(subject)}/drift`), subject) };
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.payload.error === "ai_bom_no_snapshot") return { kind: "no_snapshot", gaps: readGaps(e.payload) };
      throw e;
    }
  },
  create: async (subject) => {
    const path = `${subjectPath(subject)}/snapshots`;
    const res = await withStepUp((headers) => api.postWithHeaders<unknown>(path, {}, headers));
    return readCreatedSnapshot(res.body);
  },
};
