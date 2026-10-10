import { withStepUp } from "../../../stepup/stepUp";
import { api } from "../../../api/client";
import { readCreatedSnapshot, readDrift, readSnapshotList, subjectPath, type BomSubject, type SnapshotList, type BomDrift } from "./bomModel";
export interface BomMetadataPort {
  list(subject: BomSubject): Promise<SnapshotList>;
  drift(subject: BomSubject): Promise<BomDrift>;
  create(subject: BomSubject): Promise<void>;
}
/** Only the published B3 envelopes are wired. B4 operations wait for their owner contract. */
export const bomMetadataApi: BomMetadataPort = {
  list: async subject => readSnapshotList(await api.get<unknown>(subjectPath(subject) + "/snapshots"), subject),
  drift: async subject => readDrift(await api.get<unknown>(subjectPath(subject) + "/drift"), subject),
  create: async subject => { const path=subjectPath({...subject}) + "/snapshots"; const result=await withStepUp(headers => api.postWithHeaders<unknown>(path, {}, headers)); readCreatedSnapshot(result.body); },
};
