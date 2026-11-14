/**
 * The third-party evidence ingest (DefenseClaw) admin routes' shapes, as apps/gateway/src/third-party-ingest-routes.ts
 * returns them, and the card's pure helpers. Records are evidence another product reported, never a RegulAIt decision.
 */
import { fmtBytes, humanize, plural } from "../../../api/format";

/** a record's event as words: `hook.decision` reads "Hook decision"; without an event name, its bucket */
export const eventLabel = (r: { eventName: string | null; bucket: string }) => humanize((r.eventName ?? r.bucket).replace(/\./g, " "));

export const INGEST_SOURCES_PATH = "/v1/third-party-ingest/sources";

export interface IngestSource {
  id: string;
  kind: "defenseclaw";
  name: string;
  schemaFamily: string;
  enabled: boolean;
  credential: { issuedAt: string } | null;
  ingestPath: string;
  createdAt: string;
  updatedAt: string;
  attribution: "third_party";
}

export interface IngestLimits {
  maxBodyBytes: number;
  maxRecordsPerRequest: number;
  maxRecordsPerHour: number;
  maxAgeSeconds: number;
  maxFutureSeconds: number;
  schemaFamily: string;
}

export interface IngestRecord {
  id: string;
  recordId: string;
  bucket: string;
  eventName: string | null;
  severity: string | null;
  reportedAction: string | null;
  connector: string | null;
  devicePseudonym: string | null;
  observedAt: string;
  receivedAt: string;
  recordSha256: string;
  findingIds: string[];
  attribution: "third_party";
  enforcedByRegulAIt: false;
}

export interface IssuedCredential {
  source: IngestSource;
  credential: { token: string; header: string; path: string };
}

/** a span of seconds in the largest whole unit: "24 hours", "5 minutes", "90 seconds" */
export function spanWords(seconds: number): string {
  if (seconds >= 86_400 && seconds % 86_400 === 0) return plural(seconds / 86_400, "day");
  if (seconds >= 3_600 && seconds % 3_600 === 0) return plural(seconds / 3_600, "hour");
  if (seconds >= 60 && seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

/** the ingest limits as sentences, for the card's info panel */
export function limitLines(l: IngestLimits): string[] {
  return [
    `At most ${fmtBytes(l.maxBodyBytes)} and ${plural(l.maxRecordsPerRequest, "record")} per request.`,
    `At most ${plural(l.maxRecordsPerHour, "record")} per hour from each source.`,
    `A record older than ${spanWords(l.maxAgeSeconds)}, or more than ${spanWords(l.maxFutureSeconds)} in the future, is rejected.`,
  ];
}

/** the setup note shown with a new token */
export const setupNote = (c: IssuedCredential["credential"], maxBodyBytes: number) =>
  `Send it as "${c.header}" to ${c.path}: set it as the exporter's bearer, keep batch.max_export_batch_bytes at ${maxBodyBytes.toLocaleString("en-GB")} or less, and turn redaction on.`;
