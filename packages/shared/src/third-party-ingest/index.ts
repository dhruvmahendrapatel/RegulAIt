/**
 * ADR-0261 (backlog P37): third-party security telemetry ingest. RegulAIt parses a documented export format; it ships
 * none of the sending product's code. What arrives is THIRD-PARTY EVIDENCE: it is never presented as a RegulAIt
 * enforcement decision, and it never authorises or refuses anything.
 *
 * The first (and only) kind is Cisco DefenseClaw's HTTP JSONL log export, schema family v8. Everything here is pure
 * (no I/O), so the adapter's contract is unit-tested against synthetic fixtures written from the public docs.
 */
import { z } from "zod";
import { scrubAuditText } from "../audit-scrub.js";

/** the source kinds a third-party ingest source may be (a DB CHECK holds the same list) */
export const THIRD_PARTY_INGEST_KINDS = ["defenseclaw"] as const;
export type ThirdPartyIngestKind = (typeof THIRD_PARTY_INGEST_KINDS)[number];

/** the evidence kind a finding names when its signal came from a third-party export */
export const THIRD_PARTY_EVIDENCE_KINDS = ["defenseclaw_export"] as const;
export type ThirdPartyEvidenceKind = (typeof THIRD_PARTY_EVIDENCE_KINDS)[number];

/** the pinned export schema family; a record naming any other family is refused, never guessed at */
export const DEFENSECLAW_SCHEMA_FAMILY = "v8" as const;

/** the 14 closed record buckets of schema family v8 (docs: /docs/observability/#buckets) */
export const DEFENSECLAW_BUCKETS = [
  "compliance.activity",
  "security.finding",
  "guardrail.evaluation",
  "enforcement.action",
  "model.io",
  "tool.activity",
  "asset.scan",
  "asset.lifecycle",
  "network.egress",
  "agent.lifecycle",
  "ai.discovery",
  "telemetry.ingest",
  "platform.health",
  "diagnostic",
] as const;
export type DefenseClawBucket = (typeof DEFENSECLAW_BUCKETS)[number];

/** the severities the docs name (route selectors and the alert filter) */
export const DEFENSECLAW_SEVERITIES = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO", "ERROR"] as const;

/** the buckets that may open or widen a shadow-AI finding; every other bucket is evidence only */
export const DEFENSECLAW_FINDING_BUCKETS: ReadonlySet<DefenseClawBucket> = new Set(["security.finding", "enforcement.action", "ai.discovery"]);

// ---- bounds (ADR-0180: strict by default) ------------------------------------------------------------------------

/** one request body. DefenseClaw's default batch is 8 MiB; the customer sets `batch.max_export_batch_bytes` to 1 MiB */
export const THIRD_PARTY_INGEST_MAX_BODY_BYTES = 1024 * 1024;
/** records in one request (DefenseClaw's default `batch.max_export_batch_size` is 512) */
export const THIRD_PARTY_INGEST_MAX_RECORDS = 512;
/** one JSONL line */
export const THIRD_PARTY_INGEST_MAX_LINE_BYTES = 64 * 1024;
/** a record older than this (by the database clock) is refused as stale: the replay window */
export const THIRD_PARTY_INGEST_MAX_AGE_SECONDS = 900;
/** a record stamped further ahead than this is refused (clock skew allowance) */
export const THIRD_PARTY_INGEST_MAX_FUTURE_SECONDS = 300;
/** records one source may deliver per rolling hour; past it the batch is refused with 429 */
export const THIRD_PARTY_INGEST_MAX_RECORDS_PER_HOUR = 100_000;
/** the write-only credential's prefix (`rgti_` + 64 hex) */
export const THIRD_PARTY_INGEST_TOKEN_PREFIX = "rgti_";
/** the receiving path for a DefenseClaw HTTP JSONL exporter */
export const DEFENSECLAW_INGEST_PATH = "/v1/third-party-ingest/defenseclaw/records";

const MAX_REASON_CHARS = 500;
const MAX_RULE_IDS = 32;

// ---- linear token checks (no regex on caller input: M-074) -------------------------------------------------------

function isPrintableToken(v: string, max: number): boolean {
  if (v.length === 0 || v.length > max) return false;
  for (let i = 0; i < v.length; i += 1) {
    const c = v.charCodeAt(i);
    if (c <= 0x20 || c >= 0x7f) return false;
  }
  return true;
}

/** a lower-case identifier: [a-z0-9] then [a-z0-9._:-], at most `max` characters */
function isLowerIdent(v: string, max: number): boolean {
  if (v.length === 0 || v.length > max) return false;
  for (let i = 0; i < v.length; i += 1) {
    const c = v[i]!;
    const alnum = (c >= "a" && c <= "z") || (c >= "0" && c <= "9");
    if (i === 0 ? !alnum : !(alnum || c === "." || c === "_" || c === "-" || c === ":")) return false;
  }
  return true;
}

const token = (max: number) => z.string().refine((v) => isPrintableToken(v, max));
const ident = (max: number) =>
  z
    .string()
    .transform((v) => v.trim().toLowerCase())
    .refine((v) => isLowerIdent(v, max));

/**
 * One record as the docs name its fields. Keys appear flat (`bucket`, `event_name`) or as the OTLP-style dotted
 * attribute names the docs list (`host.name`, `defenseclaw.guardrail.rule_ids`). Unknown keys are dropped, never
 * stored: user identity, paths, prompts and responses do not survive parsing (exports default to `redaction: none`).
 */
const recordSchema = z.object({
  record_id: token(128),
  bucket: z.enum(DEFENSECLAW_BUCKETS),
  timestamp: z.string().min(10).max(40),
  schema_family: z.string().max(16).optional(),
  event_name: ident(96).optional(),
  severity: z.enum(DEFENSECLAW_SEVERITIES).optional(),
  action: ident(32).optional(),
  outcome: ident(32).optional(),
  connector: ident(64).optional(),
  source: ident(64).optional(),
  "host.name": z.string().min(1).max(253).optional(),
  rule_ids: z.array(token(128)).max(MAX_RULE_IDS).optional(),
  "defenseclaw.guardrail.rule_ids": z.array(token(128)).max(MAX_RULE_IDS).optional(),
  "defenseclaw.guardrail.effective_action": ident(32).optional(),
  "defenseclaw.guardrail.would_block": z.boolean().optional(),
  "defenseclaw.guardrail.finding_count": z.number().int().min(0).max(1_000_000).optional(),
  "defenseclaw.guardrail.reason": z.string().max(4096).optional(),
  "defenseclaw.security.severity": z.enum(DEFENSECLAW_SEVERITIES).optional(),
});

export type ThirdPartySeverity = "critical" | "high" | "medium" | "low" | "info" | "error";

/** what is kept of a record: allow-listed, bounded, scrubbed. `hostName` is pseudonymised by the caller, never stored */
export interface ParsedThirdPartyRecord {
  line: number;
  recordId: string;
  bucket: DefenseClawBucket;
  observedAt: Date;
  /** sha256 hex of the exact line bytes as received */
  recordSha256: string;
  eventName: string | null;
  severity: ThirdPartySeverity | null;
  action: string | null;
  connector: string | null;
  hostName: string | null;
  attributes: {
    outcome?: string;
    source?: string;
    ruleIds?: string[];
    wouldBlock?: boolean;
    findingCount?: number;
    /** the guardrail's own reason, credential- and PII-scrubbed, at most 500 characters */
    reason?: string;
  };
}

export type ThirdPartyRejectCode = "line_too_long" | "invalid_json" | "invalid_record" | "unsupported_schema_family" | "invalid_timestamp" | "duplicate_in_batch";

export interface ThirdPartyReject {
  line: number;
  code: ThirdPartyRejectCode;
}

export interface ParsedThirdPartyBatch {
  records: ParsedThirdPartyRecord[];
  rejects: ThirdPartyReject[];
  /** non-empty lines seen */
  lines: number;
}

export class ThirdPartyBatchRefused extends Error {
  constructor(readonly code: "too_many_records" | "empty_batch" | "invalid_encoding") {
    super(code);
  }
}

/** the strict `YYYY-MM-DDTHH:MM:SS[.fraction](Z|±HH:MM)` shape, checked without a regex */
function isIsoInstant(v: string): boolean {
  const digitsAt = (from: number, n: number) => {
    for (let i = from; i < from + n; i += 1) if (!(v[i]! >= "0" && v[i]! <= "9")) return false;
    return true;
  };
  if (v.length < 20) return false;
  if (!digitsAt(0, 4) || v[4] !== "-" || !digitsAt(5, 2) || v[7] !== "-" || !digitsAt(8, 2) || v[10] !== "T") return false;
  if (!digitsAt(11, 2) || v[13] !== ":" || !digitsAt(14, 2) || v[16] !== ":" || !digitsAt(17, 2)) return false;
  let i = 19;
  if (v[i] === ".") {
    i += 1;
    const start = i;
    while (i < v.length && v[i]! >= "0" && v[i]! <= "9") i += 1;
    if (i === start || i - start > 9) return false;
  }
  const zone = v.slice(i);
  if (zone === "Z") return true;
  return zone.length === 6 && (zone[0] === "+" || zone[0] === "-") && digitsAt(i + 1, 2) && zone[3] === ":" && digitsAt(i + 4, 2);
}

/** nanosecond fractions (the docs' own example) are cut to milliseconds before Date parsing */
function parseInstant(v: string): Date | null {
  if (!isIsoInstant(v)) return null;
  const dot = v.indexOf(".");
  let norm = v;
  if (dot === 19) {
    let end = 20;
    while (end < v.length && v[end]! >= "0" && v[end]! <= "9") end += 1;
    norm = v.slice(0, 19) + "." + v.slice(20, end).padEnd(3, "0").slice(0, 3) + v.slice(end);
  }
  const d = new Date(norm);
  return Number.isNaN(d.getTime()) ? null : d;
}

const severityOf = (s: (typeof DEFENSECLAW_SEVERITIES)[number] | undefined): ThirdPartySeverity | null =>
  s ? (s.toLowerCase() as ThirdPartySeverity) : null;

/**
 * Parse one HTTP JSONL body. A body-level problem throws `ThirdPartyBatchRefused`; a bad line is rejected on its own
 * (a 4xx for the whole batch would make the exporter retry the same bad line 24 times). `sha256` is injected so this
 * module stays free of Node built-ins.
 */
export function parseDefenseClawJsonl(body: Uint8Array, sha256: (bytes: Uint8Array) => string): ParsedThirdPartyBatch {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ThirdPartyBatchRefused("invalid_encoding");
  }
  const rawLines = text.split("\n");
  const records: ParsedThirdPartyRecord[] = [];
  const rejects: ThirdPartyReject[] = [];
  const seen = new Set<string>();
  const encoder = new TextEncoder();
  let lines = 0;
  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const raw = rawLines[idx]!.endsWith("\r") ? rawLines[idx]!.slice(0, -1) : rawLines[idx]!;
    if (raw.trim().length === 0) continue;
    lines += 1;
    if (lines > THIRD_PARTY_INGEST_MAX_RECORDS) throw new ThirdPartyBatchRefused("too_many_records");
    const line = idx + 1;
    const bytes = encoder.encode(raw);
    if (bytes.length > THIRD_PARTY_INGEST_MAX_LINE_BYTES) {
      rejects.push({ line, code: "line_too_long" });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      rejects.push({ line, code: "invalid_json" });
      continue;
    }
    const parsed = recordSchema.safeParse(json);
    if (!parsed.success) {
      rejects.push({ line, code: "invalid_record" });
      continue;
    }
    const r = parsed.data;
    if (r.schema_family !== undefined && r.schema_family !== DEFENSECLAW_SCHEMA_FAMILY) {
      rejects.push({ line, code: "unsupported_schema_family" });
      continue;
    }
    const observedAt = parseInstant(r.timestamp);
    if (!observedAt) {
      rejects.push({ line, code: "invalid_timestamp" });
      continue;
    }
    if (seen.has(r.record_id)) {
      rejects.push({ line, code: "duplicate_in_batch" });
      continue;
    }
    seen.add(r.record_id);
    const ruleIds = r.rule_ids ?? r["defenseclaw.guardrail.rule_ids"];
    const reason = r["defenseclaw.guardrail.reason"];
    const attributes: ParsedThirdPartyRecord["attributes"] = {};
    if (r.outcome) attributes.outcome = r.outcome;
    if (r.source) attributes.source = r.source;
    if (ruleIds && ruleIds.length > 0) attributes.ruleIds = [...new Set(ruleIds)];
    if (r["defenseclaw.guardrail.would_block"] !== undefined) attributes.wouldBlock = r["defenseclaw.guardrail.would_block"];
    if (r["defenseclaw.guardrail.finding_count"] !== undefined) attributes.findingCount = r["defenseclaw.guardrail.finding_count"];
    if (reason && reason.trim().length > 0) attributes.reason = scrubAuditText(reason.slice(0, 4096)).slice(0, MAX_REASON_CHARS);
    const host = r["host.name"]?.trim();
    records.push({
      line,
      recordId: r.record_id,
      bucket: r.bucket,
      observedAt,
      recordSha256: sha256(bytes),
      eventName: r.event_name ?? null,
      severity: severityOf(r.severity ?? r["defenseclaw.security.severity"]),
      action: r.action ?? r["defenseclaw.guardrail.effective_action"] ?? null,
      connector: r.connector ?? null,
      hostName: host && host.length > 0 ? host : null,
      attributes,
    });
  }
  if (lines === 0) throw new ThirdPartyBatchRefused("empty_batch");
  return { records, rejects, lines };
}

// ---- ADR-0302 decision 2: OTLP logs intake ----------------------------------------------------------------------

/** the OTLP/HTTP logs path under the DefenseClaw ingest (an exporter's endpoint is `.../defenseclaw/otlp`) */
export const DEFENSECLAW_OTLP_LOGS_PATH = "/v1/third-party-ingest/defenseclaw/otlp/v1/logs";

/** an OTLP `AnyValue` as protobufjs `toObject` (longs as strings) or the OTLP/JSON encoding gives it */
interface OtlpAnyValue {
  stringValue?: unknown;
  boolValue?: unknown;
  intValue?: unknown;
  doubleValue?: unknown;
  arrayValue?: { values?: unknown };
}
interface OtlpKeyValue {
  key?: unknown;
  value?: OtlpAnyValue;
}

const MAX_ATTRIBUTES_PER_RECORD = 64;

/** a scalar only (an array element); nested arrays, kvlists and bytes are dropped without being walked */
function otlpScalar(v: OtlpAnyValue | undefined): string | number | boolean | undefined {
  if (!v || typeof v !== "object") return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.intValue === "string" || typeof v.intValue === "number") {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (typeof v.doubleValue === "number") return v.doubleValue;
  return undefined;
}

/** a scalar, or a flat array of scalars (rule ids); kvlist and bytes values are dropped, never carried */
function otlpValue(v: OtlpAnyValue | undefined): string | number | boolean | Array<string | number | boolean> | undefined {
  if (!v || typeof v !== "object") return undefined;
  if (typeof v.stringValue === "string") return v.stringValue;
  if (typeof v.boolValue === "boolean") return v.boolValue;
  if (typeof v.intValue === "string" || typeof v.intValue === "number") {
    const n = Number(v.intValue);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  if (typeof v.doubleValue === "number") return v.doubleValue;
  const arr = v.arrayValue?.values;
  if (Array.isArray(arr)) {
    const out: Array<string | number | boolean> = [];
    for (const item of arr.slice(0, MAX_RULE_IDS + 1)) {
      const x = otlpScalar(item as OtlpAnyValue);
      if (x !== undefined) out.push(x);
    }
    return out;
  }
  return undefined;
}

function otlpAttributes(list: unknown, into: Record<string, unknown>): void {
  if (!Array.isArray(list)) return;
  for (const kv of list.slice(0, MAX_ATTRIBUTES_PER_RECORD) as OtlpKeyValue[]) {
    if (!kv || typeof kv.key !== "string" || kv.key.length === 0 || kv.key.length > 128) continue;
    if (kv.key in into) continue;
    const v = otlpValue(kv.value);
    if (v !== undefined) into[kv.key] = v;
  }
}

/** nanoseconds since the epoch (a decimal string or number) as an ISO instant with millisecond precision */
function nanosToIso(v: unknown): string | undefined {
  const s = typeof v === "number" ? String(Math.trunc(v)) : typeof v === "string" ? v : "";
  if (s.length === 0 || s.length > 20) return undefined;
  for (const c of s) if (c < "0" || c > "9") return undefined;
  const ms = Number(s.length > 6 ? s.slice(0, s.length - 6) : "0");
  if (!Number.isSafeInteger(ms) || ms <= 0) return undefined;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * ADR-0302 decision 2 — an OTLP `ExportLogsServiceRequest` (already decoded from protobuf or OTLP/JSON) as the JSONL
 * body `parseDefenseClawJsonl` takes: one line per log record, so every check, bound and minimisation of the JSONL
 * path applies unchanged and a reject's `line` is the record's position in the request (1-based).
 *
 * Per record: its attributes as flat or dotted names (the same documented names the JSONL schema accepts; unknown
 * ones are dropped by that schema), then `host.name` from the resource if the record has none, `timestamp` from
 * `timeUnixNano` (else `observedTimeUnixNano`) if absent, and `severity` from `severityText` if absent. The record
 * BODY is never read: it is where a log carries prompts and payloads. The `record_sha256` kept for an OTLP record is
 * over this canonical line, not over wire bytes (protobuf has no per-record byte range worth pinning).
 */
export function otlpLogsRequestToJsonl(request: unknown): Uint8Array {
  const lines: string[] = [];
  const resourceLogs = (request as { resourceLogs?: unknown })?.resourceLogs;
  if (Array.isArray(resourceLogs)) {
    outer: for (const rl of resourceLogs as Array<{ resource?: { attributes?: unknown }; scopeLogs?: unknown }>) {
      const resource: Record<string, unknown> = {};
      otlpAttributes(rl?.resource?.attributes, resource);
      if (!Array.isArray(rl?.scopeLogs)) continue;
      for (const sl of rl.scopeLogs as Array<{ logRecords?: unknown }>) {
        if (!Array.isArray(sl?.logRecords)) continue;
        for (const lr of sl.logRecords as Array<Record<string, unknown>>) {
          const flat: Record<string, unknown> = {};
          otlpAttributes(lr?.attributes, flat);
          if (flat["host.name"] === undefined && typeof resource["host.name"] === "string") flat["host.name"] = resource["host.name"];
          if (flat.timestamp === undefined) {
            const ts = nanosToIso(lr?.timeUnixNano) ?? nanosToIso(lr?.observedTimeUnixNano);
            if (ts) flat.timestamp = ts;
          }
          if (flat.severity === undefined && typeof lr?.severityText === "string") {
            const sev = lr.severityText.trim().toUpperCase();
            if ((DEFENSECLAW_SEVERITIES as readonly string[]).includes(sev)) flat.severity = sev;
          }
          lines.push(JSON.stringify(flat));
          // one past the cap is enough for the parser to refuse the batch as too large
          if (lines.length > THIRD_PARTY_INGEST_MAX_RECORDS) break outer;
        }
      }
    }
  }
  return new TextEncoder().encode(lines.join("\n"));
}

/** the window check, against a clock the caller supplies (the database's: M-075) */
export function recordFreshness(observedAt: Date, now: Date): "fresh" | "stale" | "future" {
  const delta = (now.getTime() - observedAt.getTime()) / 1000;
  if (delta > THIRD_PARTY_INGEST_MAX_AGE_SECONDS) return "stale";
  if (delta < -THIRD_PARTY_INGEST_MAX_FUTURE_SECONDS) return "future";
  return "fresh";
}

export type FindingSeverity = "low" | "medium" | "high" | "critical";

/**
 * Whether a record opens or widens a finding, and how severe. A record needs a host (the device it happened on) and a
 * connector (the AI tool DefenseClaw saw). An `allow` or an INFO record is evidence only: it shows a governed tool, not
 * a risk. The finding's provider is `defenseclaw/<connector>`, so it never merges into a finding RegulAIt itself made.
 */
export function findingFor(r: ParsedThirdPartyRecord): { provider: string; severity: FindingSeverity } | null {
  if (!DEFENSECLAW_FINDING_BUCKETS.has(r.bucket) || !r.hostName || !r.connector) return null;
  if (r.bucket !== "ai.discovery") {
    if (r.action === "allow") return null;
    if (r.severity === null || r.severity === "info" || r.severity === "error") return null;
  }
  const severity: FindingSeverity =
    r.severity === "critical" ? "critical" : r.severity === "high" ? "high" : r.severity === "medium" ? "medium" : "low";
  return { provider: `defenseclaw/${r.connector}`, severity };
}

/** the reason text a finding's evidence entry carries: identifiers only, never record content */
export function findingEvidenceReason(r: ParsedThirdPartyRecord): string {
  const parts = [`third-party DefenseClaw ${r.bucket}`];
  if (r.eventName) parts.push(r.eventName);
  if (r.action) parts.push(`its action: ${r.action}`);
  if (r.attributes.ruleIds?.length) parts.push(`rules ${r.attributes.ruleIds.slice(0, 5).join(", ")}`);
  return `${parts.join("; ")} (not a RegulAIt decision)`.slice(0, 300);
}
