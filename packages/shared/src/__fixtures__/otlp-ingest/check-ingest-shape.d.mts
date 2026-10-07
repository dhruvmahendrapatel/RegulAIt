// Types for check-ingest-shape.mjs (ADR-0186 T). Test-only.
export type ExportProfile = "otel_genai" | "openinference";
export type ValueType = "stringValue" | "intValue" | "doubleValue" | "boolValue" | "arrayValue";

export interface KindRules {
  allOf?: string[];
  anyOf?: string[][];
  valueTypes?: Record<string, ValueType>;
  enums?: Record<string, string[]>;
  /** checked only when content capture is on: each group needs one key */
  contentAnyOf?: string[][];
  doc?: string;
}

export interface ProfileRules {
  resourceAttributes?: { keys: string[]; doc?: string };
  everySpan?: { allOf?: string[]; enums?: Record<string, string[]>; doc?: string };
  everySpanOfASession?: { keys: string[]; doc?: string };
  byKind?: Record<string, KindRules>;
}

export interface IngestFixture {
  $comment: string[];
  tool: string;
  verified: boolean;
  transport: { path: string; acceptsContentTypes: string[]; directFromRegulait: boolean; via?: string; doc?: string };
  span: { required: Record<string, string>; doc?: string };
  forbiddenKeySegments?: { segments: string[]; doc?: string };
  profiles: Partial<Record<ExportProfile, ProfileRules>>;
}

export function loadIngestFixture(name: "langfuse" | "phoenix"): IngestFixture;

export function checkIngestShape(
  body: Record<string, unknown>,
  fx: IngestFixture,
  profile: ExportProfile,
  opts: {
    includeContent: boolean;
    /** the trace has a session, so the per-session keys must be on every span */
    sessionTrace: boolean;
    /** the span kinds that must appear; default every kind the fixture has rules for */
    requireKinds?: string[];
  },
): string[];
